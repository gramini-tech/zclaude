// Finding, configuring and running the claude binary.

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { contextWindowFor, formatModelForClaude } from "./config.js";
import { EXIT, noClaudeError, ZclaudeError } from "./errors.js";

export const INSTALL_HINT = [
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
    const path = isAbsolute(override) ? override : resolve(override);
    return isExecutableFile(path) ? path : null;
  }
  const names = candidateNames(platform);
  const pathEntries = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
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
      resolve(String(stdout).trim().split(/\r?\n/u)[0] || null);
    });
  });
}

/**
 * Build the child environment for the Z.ai profile. `extra` are KEY=value
 * pairs from config/profile files; the Z.ai essentials are applied last so
 * they always win.
 */
export function buildZaiEnv({ baseEnv = process.env, apiKey, config, models, extra = {} }) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
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
  return env;
}

export function buildPlainEnv({ baseEnv = process.env, extra = {} }) {
  const env = { ...baseEnv };
  for (const [key, value] of Object.entries(extra)) env[key] = String(value);
  return env;
}

/** Signal name -> conventional exit code (128 + number). */
export function exitCodeForSignal(signal) {
  const number = osConstants.signals[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

/**
 * Run claude with inherited stdio and resolve with its exit code. The parent
 * ignores SIGINT/SIGTERM while the child runs: the terminal delivers those to
 * the whole foreground process group, so claude handles them itself.
 */
export function runClaude(bin, args, env, { platform = process.platform } = {}) {
  return new Promise((resolvePromise, reject) => {
    const useShell = platform === "win32" && /\.(cmd|bat)$/iu.test(bin);
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
    child.on("error", (error) => {
      restore();
      if (error?.code === "ENOENT") {
        reject(noClaudeError(`claude disappeared from ${bin} before it could start.`, INSTALL_HINT));
        return;
      }
      reject(new ZclaudeError(`Could not start claude: ${error.message}`, { exitCode: EXIT.NO_CLAUDE, cause: error }));
    });
    child.on("exit", (code, signal) => {
      restore();
      resolvePromise(code ?? exitCodeForSignal(signal));
    });
  });
}
