// Version checks and self-update. The version number increases on every
// commit, so "newer than mine" is a plain semver comparison against the
// package.json on GitHub (or the npm registry once published).

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { flag, VERSION, zclaudeHome } from "./config.js";
import { request } from "./http.js";
import { log } from "./logger.js";
import { readState, writeState } from "./store.js";

const REPO = "vipincr/zclaude";
export const GITHUB_SPEC = `github:${REPO}`;
const RAW_PACKAGE_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const INSTALLER_URL = "https://vipincr.github.io/zclaude/install";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Positive when a is newer than b. */
export function compareVersions(a, b) {
  const parse = (value) =>
    String(value ?? "0")
      .split(".")
      .map((part) => Math.trunc(Number(part)) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Fetch the latest published version, or null when unreachable.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 */
export async function fetchLatestVersion({ fetchImpl, timeoutMs = 2500 } = {}) {
  try {
    const response = await request({
      url: RAW_PACKAGE_URL,
      timeoutMs,
      fetchImpl,
      headers: { "Cache-Control": "no-cache" },
    });
    const version = response.json?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+/u.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * At most once a day, look for a newer version. Returns the newer version
 * string or null. Never throws and never blocks longer than the timeout.
 * @param {{env?: NodeJS.ProcessEnv, now?: number, fetchImpl?: typeof fetch, current?: string}} [options]
 */
export async function checkForUpdate({ env = process.env, now = Date.now(), fetchImpl, current = VERSION } = {}) {
  if (flag(env, "ZCLAUDE_NO_UPDATE_CHECK") || env.CI) return null;
  const state = await readState(env);
  const last = Number(state.lastUpdateCheck) || 0;
  let latest = typeof state.latestVersion === "string" ? state.latestVersion : null;
  if (now - last >= CHECK_INTERVAL_MS) {
    latest = await fetchLatestVersion({ fetchImpl });
    log.debug("cli", "update check", { latest, current });
    await writeState({ lastUpdateCheck: now, latestVersion: latest ?? state.latestVersion ?? null }, env).catch(
      () => {},
    );
  }
  return latest && compareVersions(latest, current) > 0 ? latest : null;
}

/**
 * How zclaude got onto this machine, judged by where the running script
 * lives: "installer" (~/.zclaude/app from install.sh), "npm" (global prefix
 * or an npx cache) or "checkout" (a git clone).
 */
export function detectInstallKind({ scriptPath = process.argv[1], env = process.env, home = homedir() } = {}) {
  let real = scriptPath ?? "";
  try {
    real = realpathSync(real);
  } catch {
    // keep the raw path
  }
  const appDir = join(env.ZCLAUDE_INSTALL_DIR || join(zclaudeHome(env), "app"), sep);
  if (real.startsWith(appDir)) return "installer";
  const viaNpm =
    real.includes(`${sep}_npx${sep}`) ||
    real.includes(`${sep}node_modules${sep}zclaude${sep}`) ||
    real.startsWith(join(home, ".npm-global", sep));
  return viaNpm ? "npm" : "checkout";
}

function runShell(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Re-run the install path that matches this installation. */
export function selfUpdate({ env = process.env, kind = detectInstallKind({ env }), npmSpec = GITHUB_SPEC } = {}) {
  log.info("cli", "self-update", { kind, npmSpec });
  if (kind === "installer") {
    return runShell("bash", ["-c", `curl -fsSL "${INSTALLER_URL}" | bash`], { ...env, ZCLAUDE_INSTALL_NO_CLAUDE: "1" });
  }
  if (kind === "npm") {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    return runShell(npm, ["install", "-g", npmSpec], env);
  }
  return null;
}
