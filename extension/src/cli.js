// Finding zclaude and talking to it.
//
// The extension knows nothing about credentials, Keychains or config files. It
// shells out to zclaude, asks for `--json`, and renders what comes back. That
// keeps exactly one implementation of the risky parts, and it means this file
// can be tested without VS Code.

"use strict";

const { execFile } = require("node:child_process");
const { accessSync, constants } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const TIMEOUT_MS = 20_000;

function isExecutable(path, access = accessSync) {
  try {
    access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where zclaude might be. A setting wins; then PATH; then the places the
 * installer and npm put it. VS Code's PATH on macOS is whatever launched it,
 * which for a dock launch is not the shell's, so the fallbacks matter.
 */
function candidatePaths({ env = process.env, platform = process.platform, setting = "" } = {}) {
  const home = env.HOME || homedir();
  const exe = platform === "win32" ? "zclaude.cmd" : "zclaude";
  const fromPath = String(env.PATH || "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  return [
    setting.trim(),
    ...fromPath,
    join(home, ".local", "bin", exe),
    join(home, "bin", exe),
    join(home, ".zclaude", "app", "zclaude"),
    join(home, ".npm-global", "bin", exe),
    "/opt/homebrew/bin/zclaude",
    "/usr/local/bin/zclaude",
  ].filter(Boolean);
}

/** The first candidate that exists and can be run, or null. */
function findBinary(options = {}) {
  const access = options.access ?? accessSync;
  for (const candidate of candidatePaths(options)) {
    if (isExecutable(candidate, access)) return candidate;
  }
  return null;
}

/** Run zclaude and return its output; never throws for a non-zero exit. */
function run(binary, args, { env = process.env, timeoutMs = TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl(binary, args, { env, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Run a command that answers in JSON. Returns null when it did not. */
async function runJson(binary, args, options = {}) {
  const result = await run(binary, [...args, "--json"], options);
  if (!result.ok && !result.stdout.trim()) return { data: null, error: result.stderr.trim() || `exit ${result.code}` };
  try {
    return { data: JSON.parse(result.stdout), error: null };
  } catch {
    return { data: null, error: result.stderr.trim() || "zclaude did not answer in JSON" };
  }
}

module.exports = { candidatePaths, findBinary, run, runJson };
