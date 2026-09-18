// Opening a file in whatever editor somebody uses.
//
// The first code here to do it, and deliberately small. The value may carry
// arguments (`EDITOR="code -w"`, `"emacsclient -nw"`), so it is tokenized
// rather than handed to a shell: it comes from the environment, it can contain
// a semicolon, and `shell: true` on an environment-supplied string is how a
// convenience becomes a way to run arbitrary commands.
//
// Terminal editors are preferred in the fallback chain because a terminal
// command that pops a window is surprising, and `nano` or `vi` exists on every
// macOS and nearly every Linux.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

function runnable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** An executable by name, on PATH, or an absolute one somebody named outright. */
export function onPath(name, env = process.env) {
  if (!name) return null;
  if (isAbsolute(name) || name.includes("/")) return runnable(name) ? name : null;
  const dirs = String(env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    const path = join(dir, name);
    if (runnable(path)) return path;
  }
  return null;
}

/** `open -t` returns the moment it has handed the file over, which is useless here. */
const FALLBACKS = Object.freeze({
  darwin: [["nano"], ["vi"], ["open", "-t", "-W"]],
  win32: [["notepad"]],
  other: [["nano"], ["vi"]],
});

/**
 * Split a command line on unquoted whitespace, honouring simple quoting.
 *
 * Enough for `code -w` and `"/Applications/My Editor" --wait`, and no more:
 * anything richer belongs in a script the variable points at.
 * @param {string} text
 */
export function tokenize(text) {
  const parts = [];
  let current = "";
  let quote = null;
  const characters = [...String(text ?? "")];
  for (const character of characters) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) {
      if (current) parts.push(current);
      current = "";
    } else current += character;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Which editor to use, and where it came from.
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, lookup?: Function}} [options]
 * @returns {{argv: string[], source: string} | null}
 */
export function resolveEditor({ env = process.env, platform = process.platform, lookup = onPath } = {}) {
  for (const name of ["ZCLAUDE_EDITOR", "VISUAL", "EDITOR"]) {
    const parts = tokenize(env[name]);
    if (parts.length === 0) continue;
    const found = lookup(parts[0], env);
    if (found) return { argv: [found, ...parts.slice(1)], source: name };
  }
  const fallbacks = FALLBACKS[platform] ?? FALLBACKS.other;
  for (const candidate of fallbacks) {
    const found = lookup(candidate[0], env);
    if (found) return { argv: [found, ...candidate.slice(1)], source: "fallback" };
  }
  return null;
}

/**
 * Run it on a file and wait. The parent ignores interrupts while it runs, so a
 * `^C` meant for the editor does not also kill zclaude out from under it.
 * @param {string[]} argv
 * @param {string} path
 */
export function runEditor(argv, path, { env = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const ignore = () => {};
    process.on("SIGINT", ignore);
    const child = spawnImpl(argv[0], [...argv.slice(1), path], { stdio: "inherit", env });
    const done = (code) => {
      process.off("SIGINT", ignore);
      resolve(code ?? 0);
    };
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code));
  });
}
