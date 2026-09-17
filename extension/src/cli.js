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
const { dirname, join } = require("node:path");

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

/**
 * The PATH to run zclaude with.
 *
 * zclaude is a Node script starting `#!/usr/bin/env node`, so running it needs
 * node on PATH — and an editor launched from the dock on macOS has
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which has no node on any machine using
 * Homebrew, nvm, volta or fnm. Every call then fails with
 * "env: node: No such file or directory" and the item can say nothing useful.
 *
 * The binary's own directory goes first: a tool installed by npm sits beside
 * the node that installed it. Then the usual places a node ends up.
 */
function pathFor(binary, env, platform) {
  if (platform === "win32") return env.PATH;
  const home = env.HOME || homedir();
  const extra = [
    binary ? dirname(binary) : null,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".zclaude", "node", "bin"),
  ].filter(Boolean);
  const current = String(env.PATH || "")
    .split(":")
    .filter(Boolean);
  return [...new Set([...current, ...extra])].join(":");
}

/** Run zclaude and return its output; never throws for a non-zero exit. */
function run(
  binary,
  args,
  { env = process.env, timeoutMs = TIMEOUT_MS, execFileImpl = execFile, platform = process.platform } = {},
) {
  const childEnv = { ...env, PATH: pathFor(binary, env, platform) };
  return new Promise((resolve) => {
    execFileImpl(binary, args, { env: childEnv, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
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

/** The zclaude version, from its own `--version`, or null. */
async function version(binary, options = {}) {
  const result = await run(binary, ["--version"], options);
  return result.stdout.match(/zclaude (\d+\.\d+\.\d+)/u)?.[1] ?? null;
}

module.exports = { candidatePaths, findBinary, pathFor, run, runJson, version };
