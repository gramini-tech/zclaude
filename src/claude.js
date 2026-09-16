// Finding, configuring and running the claude binary.

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";

import { contextWindowFor, formatModelForClaude } from "./config.js";
import { canonicalConfigDir } from "./profiles/paths.js";
import { EXIT, noClaudeError, ZclaudeError } from "./errors.js";
import { log } from "./logger.js";

const INSTALL_HINT = [
  "Install Claude Code first:",
  "  curl -fsSL https://claude.ai/install.sh | bash",
  "  or: npm install -g @anthropic-ai/claude-code",
  "If it is installed somewhere unusual, set ZCLAUDE_CLAUDE_BIN=/path/to/claude.",
].join("\n");

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(platform) {
  return platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
}

/** Absolute path to claude, or null. */
export function findClaude({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const override = typeof env.ZCLAUDE_CLAUDE_BIN === "string" ? env.ZCLAUDE_CLAUDE_BIN.trim() : "";
  if (override) {
    const path = isAbsolute(override) ? override : resolvePath(override);
    return isExecutableFile(path) ? path : null;
  }
  const names = candidateNames(platform);
  const pathEntries = String(env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  const fallbackDirs = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".claude", "local", "node_modules", ".bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of [...pathEntries, ...fallbackDirs]) {
    for (const name of names) {
      const path = join(dir, name);
      if (isExecutableFile(path)) return path;
    }
  }
  return null;
}

export function requireClaude(options) {
  const path = findClaude(options);
  if (!path) throw noClaudeError("The `claude` command was not found on this machine.", INSTALL_HINT);
  return path;
}

export function claudeVersion(bin, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(String(stdout).trim().split(/\r?\n/u, 1)[0] || null);
    });
  });
}

// Variables that would quietly repoint or override a profile's login. They are
// removed from every child environment zclaude builds.
const HIJACK_KEYS = Object.freeze(["CLAUDE_SECURESTORAGE_CONFIG_DIR", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_PROFILE"]);

// Variables the user may have set deliberately. These override a subscription
// login, so they are reported to the caller and decided there, never dropped in
// silence. CLAUDE_CODE_OAUTH_TOKEN is listed because Claude Code deletes the
// default keychain entry when it is set (anthropics/claude-code#37512).
const OVERRIDING_AUTH_KEYS = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);

/** Which overriding variables are present in an environment. */
export function overridingAuthVars(env) {
  return OVERRIDING_AUTH_KEYS.filter((key) => typeof env[key] === "string" && env[key].trim() !== "");
}

/**
 * Child environment for a named profile: the same environment plus its config
 * directory. CLAUDE_CONFIG_DIR is applied last so a profile's own env lines
 * cannot point it somewhere else.
 * @param {{baseEnv?: NodeJS.ProcessEnv, configDir: string, extra?: Record<string, string>}} args
 */
export function buildProfileEnv({ baseEnv = process.env, configDir, extra = {} }) {
  const env = { ...baseEnv };
  for (const [key, value] of Object.entries(extra)) env[key] = String(value);
  for (const key of HIJACK_KEYS) delete env[key];
  env.CLAUDE_CONFIG_DIR = canonicalConfigDir(configDir);
  return env;
}

/**
 * Build the child environment for the Z.ai profile. `extra` are KEY=value
 * pairs from config/profile files; the Z.ai essentials are applied last so
 * they always win.
 */
export function buildZaiEnv({ baseEnv = process.env, apiKey, config, models, extra = {}, configDir = null }) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  for (const key of HIJACK_KEYS) delete env[key];
  env.API_TIMEOUT_MS = "3000000";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  for (const [key, value] of Object.entries(extra)) env[key] = String(value);
  const primary = formatModelForClaude(models.primary);
  const subagent = formatModelForClaude(models.subagent);
  const fast = formatModelForClaude(models.fast);
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  env.ANTHROPIC_BASE_URL = config.anthropicBase;
  env.ANTHROPIC_MODEL = primary;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = primary;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = subagent;
  env.CLAUDE_CODE_SUBAGENT_MODEL = subagent;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast;
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindowFor(models.primary));
  if (configDir) env.CLAUDE_CONFIG_DIR = canonicalConfigDir(configDir);
  return env;
}

/**
 * The default profile: the environment as it is, plus any profile env lines.
 * It must never set CLAUDE_CONFIG_DIR, because setting that variable at all
 * moves Claude Code off the default login, even when set to ~/.claude.
 */
export function buildPlainEnv({ baseEnv = process.env, extra = {} }) {
  const env = { ...baseEnv };
  for (const [key, value] of Object.entries(extra)) env[key] = String(value);
  return env;
}

/** Signal name -> conventional exit code (128 + number). */
export function exitCodeForSignal(signal) {
  const number = osConstants.signals[signal];
  return Number.isSafeInteger(number) ? 128 + number : 1;
}

/**
 * Run claude with inherited stdio and resolve with its exit code. The parent
 * ignores SIGINT/SIGTERM while the child runs: the terminal delivers those to
 * the whole foreground process group, so claude handles them itself.
 */
export function runClaude(bin, args, env, { platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    const useShell = platform === "win32" && /\.(cmd|bat)$/iu.test(bin);
    const startedAt = Date.now();
    log.info("claude", "spawning claude", {
      bin,
      args,
      shell: useShell,
      env: Object.keys(env)
        .filter((key) => /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|API_TIMEOUT_MS)/u.test(key))
        .toSorted((a, b) => a.localeCompare(b))
        .map((key) => (key === "ANTHROPIC_AUTH_TOKEN" ? `${key}=<redacted>` : `${key}=${env[key]}`)),
    });
    let child;
    try {
      child = spawn(bin, args, { stdio: "inherit", env, shell: useShell, windowsHide: false });
    } catch (error) {
      reject(new ZclaudeError(`Could not start claude: ${error.message}`, { exitCode: EXIT.NO_CLAUDE, cause: error }));
      return;
    }
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const restore = () => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
    };
    child.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      restore();
      log.error("claude", "claude failed to start", { bin, error });
      if (error?.code === "ENOENT") {
        reject(noClaudeError(`claude disappeared from ${bin} before it could start.`, INSTALL_HINT));
        return;
      }
      reject(new ZclaudeError(`Could not start claude: ${error.message}`, { exitCode: EXIT.NO_CLAUDE, cause: error }));
    });
    child.on("exit", (code, signal) => {
      restore();
      log.info("claude", "claude exited", { code, signal, ms: Date.now() - startedAt });
      resolve(code ?? exitCodeForSignal(signal));
    });
  });
}
