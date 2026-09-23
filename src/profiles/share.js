// What a profile borrows from the default Claude Code setup.
//
// Config sharing is deliberately split in two. Directories of read-mostly
// inputs are symlinked, because writes land on files inside them and the link
// survives. settings.json is not symlinked: Claude Code rewrites it with a
// temp file and a rename, which replaces a symlink with a regular file and
// silently ends the sharing. Instead a filtered copy is written into the
// profile and passed with --settings, a read-only tier that outranks user
// settings.
//
// The filter matters. A settings `env` block outranks the process environment,
// so a shared block carrying model or authentication keys would override the
// models zclaude selects for a Z.ai profile and the login of an Anthropic one.

import { lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalConfigDir } from "./paths.js";

/** Directories that are inputs to Claude Code rather than state it owns. */
export const SHARED_DIRS = Object.freeze([
  "agents",
  "commands",
  "skills",
  "rules",
  "output-styles",
  "workflows",
  "themes",
]);

/** Single files worth sharing. Claude Code appends to these rather than replacing them. */
export const SHARED_FILES = Object.freeze(["CLAUDE.md"]);

/** Session transcripts and prompt history, shared only when asked. */
export const HISTORY_ITEMS = Object.freeze(["projects", "history.jsonl"]);

/** Keys that would hand a profile someone else's credentials or endpoint. */
const AUTH_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]);

/** Keys that would override the models a Z.ai profile is configured to use. */
const MODEL_ENV_KEYS = Object.freeze([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "API_TIMEOUT_MS",
]);

/**
 * A copy of the user's settings that is safe to layer onto a profile.
 *
 * Strip, then inject. Stripping alone removes these keys from *this tier*,
 * which leaves the user's own settings file still supplying them, and that tier
 * outranks the child environment. So a Z.ai profile launched on a machine whose
 * user settings name a different endpoint would quietly use that endpoint.
 * Writing the profile's own values into the tier that wins settles it by
 * construction, rather than by anybody reasoning about precedence at the call
 * site.
 *
 * @param {object} settings the default installation's parsed settings
 * @param {{provider: "anthropic" | "zai", inject?: Record<string, string> | null}} args
 */
export function filterSettings(settings, { provider, inject = null }) {
  const source = settings && typeof settings === "object" ? structuredClone(settings) : {};
  const drop = provider === "zai" ? [...AUTH_ENV_KEYS, ...MODEL_ENV_KEYS] : AUTH_ENV_KEYS;
  const out = { ...source };
  // Plugin installs are per profile, so an enablement list would name plugins
  // this profile has not installed.
  delete out.enabledPlugins;
  if (provider === "zai") delete out.model;
  const given = inject && typeof inject === "object" ? inject : {};
  if (out.env && typeof out.env === "object") {
    const env = { ...out.env };
    for (const key of drop) delete env[key];
    Object.assign(env, given);
    if (Object.keys(env).length > 0) out.env = env;
    else delete out.env;
  } else if (Object.keys(given).length > 0) {
    out.env = { ...given };
  }
  return { settings: out, removed: dropped(source, drop, provider), injected: Object.keys(given) };
}

function dropped(source, keys, provider) {
  const removed = keys.filter((key) => source?.env && Object.hasOwn(source.env, key));
  if (provider === "zai" && source?.model !== undefined) removed.push("model");
  if (source?.enabledPlugins !== undefined) removed.push("enabledPlugins");
  return removed;
}

function sharedSettingsPath(profileRootDir) {
  return join(profileRootDir, "shared-settings.json");
}

/**
 * Refresh the filtered copy when the source changes. Returns the path to pass
 * as --settings, or null when there is nothing to share.
 */
export async function materialiseSharedSettings({ defaultDir, profileRootDir, provider, inject = null }) {
  let raw;
  try {
    raw = await readFile(join(canonicalConfigDir(defaultDir), "settings.json"), "utf8");
  } catch {
    // No user settings to share. There may still be values to inject, and this
    // tier is the only one that reliably outranks them.
    if (!inject || Object.keys(inject).length === 0) return null;
    raw = "{}";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const { settings, removed } = filterSettings(parsed, { provider, inject });
  const path = sharedSettingsPath(profileRootDir);
  const next = `${JSON.stringify(settings, null, 2)}\n`;
  const current = await readFile(path, "utf8").catch(() => null);
  if (current !== next) {
    await mkdir(profileRootDir, { recursive: true, mode: 0o700 });
    await writeFile(path, next, { mode: 0o600 });
  }
  return { path, removed };
}

async function linkOne(source, target) {
  const exists = await stat(source)
    .then(() => true)
    .catch(() => false);
  if (!exists) return "absent";
  const current = await lstat(target).catch(() => null);
  if (current?.isSymbolicLink()) {
    const points = await readlink(target).catch(() => null);
    if (points === source) return "linked";
    await rm(target, { force: true });
  } else if (current) {
    return "occupied";
  }
  await symlink(source, target);
  return "linked";
}

/**
 * Point a profile at the shared inputs it was configured for.
 * @param {{defaultDir: string, configDir: string, share: {config?: boolean, history?: boolean}}} args
 */
export async function linkShares({ defaultDir, configDir, share }) {
  const from = canonicalConfigDir(defaultDir);
  const to = canonicalConfigDir(configDir);
  await mkdir(to, { recursive: true, mode: 0o700 });
  const wanted = [...(share.config ? [...SHARED_DIRS, ...SHARED_FILES] : []), ...(share.history ? HISTORY_ITEMS : [])];
  const result = { linked: [], absent: [], occupied: [] };
  for (const item of wanted) {
    const outcome = await linkOne(join(from, item), join(to, item));
    result[outcome].push(item);
  }
  return result;
}

/**
 * Report shares that are no longer links, which is how an atomic write ends
 * sharing without any error.
 */
export async function detachedShares({ configDir, share }) {
  const to = canonicalConfigDir(configDir);
  const wanted = [...(share.config ? [...SHARED_DIRS, ...SHARED_FILES] : []), ...(share.history ? HISTORY_ITEMS : [])];
  const detached = [];
  for (const item of wanted) {
    const entry = await lstat(join(to, item)).catch(() => null);
    if (entry && !entry.isSymbolicLink()) detached.push(item);
  }
  return detached;
}
