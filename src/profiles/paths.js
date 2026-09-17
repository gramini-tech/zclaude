// Names and paths for named profiles.
//
// Claude Code hashes the raw CLAUDE_CONFIG_DIR string to key its credential
// store, so "/x/home" and "/x/home/" are two different logins. Every path that
// reaches the child, the registry, the status output and the shell helpers goes
// through canonicalConfigDir() so they cannot drift apart.

import { isAbsolute, join, normalize, resolve, sep } from "node:path";

import { zclaudeHome } from "../config.js";
import { usageError } from "../errors.js";

/**
 * Claude Code's own commands. `zclaude <name>` starts a profile, so a profile
 * called "mcp" would shadow `zclaude mcp list`. Reserving these keeps the one
 * word in front of zclaude unambiguous.
 */
export const CLAUDE_COMMANDS = Object.freeze([
  "agents",
  "attach",
  "auth",
  "auto-mode",
  "config",
  "doctor",
  "fix",
  "gateway",
  "import",
  "install",
  "logs",
  "mcp",
  "migrate-installer",
  "plugin",
  "plugins",
  "project",
  "respawn",
  "resume",
  "review",
  "rm",
  "serve",
  "sessions",
  "setup-token",
  "stop",
  "ultrareview",
  "update",
  "upgrade",
  "worktree",
]);

/** Ids that belong to the built-in profiles or would read as a keyword. */
export const RESERVED_NAMES = Object.freeze([
  "claude",
  "zai",
  "default",
  "none",
  "all",
  "list",
  "add",
  ...CLAUDE_COMMANDS,
]);

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_NAME_LENGTH = 64;

/** Filesystems that fold case, where "Work" and "work" are one directory. */
export function foldsCase(platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}

/**
 * Validate a profile name and return the form used on disk. Names land in a
 * filesystem path and in shell output, so the rules are deliberately narrow.
 * @param {string} raw
 * @param {{platform?: NodeJS.Platform, taken?: Iterable<string>}} [options]
 */
export function validateProfileName(raw, { platform = process.platform, taken = [] } = {}) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw usageError("A profile name is required.", "Example: zclaude profile add work");
  const name = foldsCase(platform) ? trimmed.toLowerCase() : trimmed;
  if (name.length > MAX_NAME_LENGTH) throw usageError(`Profile names are at most ${MAX_NAME_LENGTH} characters.`);
  if (name !== name.normalize("NFC") || !/^[ -~]+$/u.test(name)) {
    throw usageError(
      `"${trimmed}" contains characters that cannot be used in a profile name.`,
      "Use letters, digits, dots, dashes and underscores.",
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw usageError(
      `"${trimmed}" is not a valid profile name.`,
      "Start with a letter or digit, then letters, digits, dots, dashes or underscores.",
    );
  }
  if (RESERVED_NAMES.includes(name)) {
    throw usageError(`"${name}" is reserved.`, `Reserved names: ${RESERVED_NAMES.join(", ")}.`);
  }
  const fold = foldsCase(platform);
  const collision = [...taken].find((existing) => (fold ? existing.toLowerCase() : existing) === name);
  if (collision) throw usageError(`A profile named "${collision}" already exists.`);
  return name;
}

/**
 * Absolute, NFC-normalised, no trailing separator. Pure string work so it can
 * be pinned by tests without touching the filesystem.
 * @param {string} path
 */
export function canonicalConfigDir(path) {
  const raw = String(path ?? "");
  if (!raw.trim()) throw usageError("A config directory path is required.");
  let out = normalize(isAbsolute(raw) ? raw : resolve(raw)).normalize("NFC");
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return out;
}

export function profilesRoot(env = process.env) {
  return canonicalConfigDir(join(zclaudeHome(env), "profiles"));
}

/** The directory holding one profile's metadata and its config home. */
export function profileRoot(name, env = process.env) {
  const raw = String(name ?? "");
  if (raw === "." || raw === ".." || !raw.trim() || raw.includes("/") || raw.includes("\\")) {
    throw usageError(`"${raw}" is not a usable profile name.`, "Names may not contain path separators.");
  }
  const root = profilesRoot(env);
  const expected = join(root, name);
  const dir = canonicalConfigDir(expected);
  if (dir !== expected || !dir.startsWith(root + sep)) {
    throw usageError(`"${name}" would place the profile outside ${root}.`);
  }
  return dir;
}

/** What is passed to Claude Code as CLAUDE_CONFIG_DIR. */
export function profileConfigDir(name, env = process.env) {
  return join(profileRoot(name, env), "home");
}

export function profileMetaPath(name, env = process.env) {
  return join(profileRoot(name, env), "profile.json");
}
