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
// npm installs from a tarball URL rather than the git spec: a git install
// needs npm to "prepare" the package, and when script running is disabled npm
// leaves a symlink into its cache instead of a real installation.
export const GITHUB_SPEC = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`;
// The contents API answers with the file as it is on the branch right now.
// raw.githubusercontent serves the same file from a cache that holds it for
// several minutes, ignores a no-cache header and is keyed by path, so a query
// string does not get around it: measured on 2026-09-17, raw still said 0.2.12
// while the API already said 0.2.13. Raw stays as a fallback for when the API
// rate limit (60 an hour per address, against a once-a-day check) is hit.
const API_PACKAGE_URL = `https://api.github.com/repos/${REPO}/contents/package.json?ref=main`;
const RAW_PACKAGE_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
export const INSTALLER_URL = "https://vipincr.github.io/zclaude/install";
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
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, now?: number}} [options]
 */
export async function fetchLatestVersion({ fetchImpl, timeoutMs = 2500, now = Date.now() } = {}) {
  const sources = [
    { url: API_PACKAGE_URL, headers: { Accept: "application/vnd.github.raw" } },
    { url: `${RAW_PACKAGE_URL}?t=${now}`, headers: { "Cache-Control": "no-cache" } },
  ];
  for (const source of sources) {
    const version = await versionFrom({ ...source, timeoutMs, fetchImpl });
    if (version) return version;
  }
  return null;
}

async function versionFrom({ url, headers, timeoutMs, fetchImpl }) {
  try {
    const response = await request({ url, headers, timeoutMs, fetchImpl });
    if (!response.ok) return null;
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
  // The check is throttled to once a day: a launch must not wait on the
  // network. A remembered version that is not newer than this one simply
  // yields no notice, which the comparison below already handles.
  let latest = typeof state.latestVersion === "string" ? state.latestVersion : null;
  if (now - last >= CHECK_INTERVAL_MS) {
    latest = await fetchLatestVersion({ fetchImpl, now });
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
  const forced = String(env.ZCLAUDE_INSTALL_KIND ?? "")
    .trim()
    .toLowerCase();
  if (["installer", "npm", "checkout"].includes(forced)) return forced;
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

/** Where npm puts global commands, or null when npm cannot be asked. */
export function npmBinDir(execFileImpl, env = process.env) {
  return new Promise((resolve) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileImpl(
      npm,
      ["prefix", "-g"],
      { env, timeout: 15_000, shell: process.platform === "win32" },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const prefix = String(stdout).trim();
        resolve(prefix ? join(prefix, process.platform === "win32" ? "" : "bin") : null);
      },
    );
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

/** Remove the installation that matches this one. */
export function selfUninstall({ env = process.env, kind = detectInstallKind({ env }), keepConfig = false } = {}) {
  log.info("cli", "self-uninstall", { kind, keepConfig });
  if (kind === "installer") {
    const flags = keepConfig ? " --keep-config" : "";
    return runShell("bash", ["-c", `curl -fsSL "${INSTALLER_URL}" | bash -s -- --uninstall${flags}`], env);
  }
  if (kind === "npm") {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    return runShell(npm, ["uninstall", "-g", "zclaude"], env);
  }
  return null;
}
