// The list of named profiles, stored in ~/.zclaude/profiles.json.
//
// Directories are recorded at creation rather than recomputed, so changing
// ZCLAUDE_HOME later cannot silently move a profile and orphan its credentials.
// A damaged file is reported and treated as empty; it never stops a launch.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { zclaudeHome } from "../config.js";
import { log } from "../logger.js";
import { warn } from "../ui/log.js";
import { canonicalConfigDir, profileConfigDir } from "./paths.js";

const REGISTRY_VERSION = 1;
export const PROVIDERS = Object.freeze(["anthropic", "zai"]);

export function registryPath(env = process.env) {
  return join(zclaudeHome(env), "profiles.json");
}

/**
 * @typedef {object} ProfileRecord
 * @property {string} name
 * @property {"anthropic" | "zai"} provider
 * @property {string} dir canonical CLAUDE_CONFIG_DIR for this profile
 * @property {{config: boolean, history: boolean}} share
 * @property {string} [credentialService] derived at creation, for diagnostics
 * @property {string} [createdAt]
 * @property {string} [label]
 */

function sanitize(entry, name) {
  if (!entry || typeof entry !== "object") return null;
  const provider = PROVIDERS.includes(entry.provider) ? entry.provider : "anthropic";
  const dir = typeof entry.dir === "string" && entry.dir.trim() ? canonicalConfigDir(entry.dir) : null;
  if (!dir) return null;
  const share = entry.share && typeof entry.share === "object" ? entry.share : {};
  return {
    name,
    provider,
    dir,
    share: { config: share.config !== false, history: share.history !== false },
    credentialService: typeof entry.credentialService === "string" ? entry.credentialService : undefined,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : undefined,
    label: typeof entry.label === "string" ? entry.label : undefined,
  };
}

/** Never throws: a broken registry is reported and read as empty. */
export async function readRegistry(env = process.env) {
  const path = registryPath(env);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") warn(`Could not read ${path}: ${error.message}`);
    return { version: REGISTRY_VERSION, profiles: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(`${path} is not valid JSON (${error.message}); treating it as empty.`);
    log.warn("profile", "registry unreadable", { path, error });
    return { version: REGISTRY_VERSION, profiles: {} };
  }
  const profiles = {};
  const entries = Object.entries(parsed?.profiles ?? {});
  for (const [name, entry] of entries) {
    const record = sanitize(entry, name);
    if (record) profiles[name] = record;
    else warn(`Ignoring malformed profile "${name}" in ${path}.`);
  }
  return { version: REGISTRY_VERSION, profiles };
}

async function writeRegistry(registry, env = process.env) {
  const path = registryPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...registry, version: REGISTRY_VERSION }, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  return path;
}

/** @returns {Promise<ProfileRecord[]>} sorted by name */
export async function listRegistered(env = process.env) {
  const { profiles } = await readRegistry(env);
  return Object.values(profiles).toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function getRegistered(name, env = process.env) {
  const { profiles } = await readRegistry(env);
  return profiles[name] ?? null;
}

/**
 * Add or replace a profile. The directory defaults to the standard layout but
 * is stored explicitly so it stays put.
 * @param {{name: string, provider: string, share?: {config?: boolean, history?: boolean}, dir?: string, credentialService?: string, label?: string}} entry
 */
export async function putRegistered(entry, env = process.env) {
  const registry = await readRegistry(env);
  const dir = canonicalConfigDir(entry.dir ?? profileConfigDir(entry.name, env));
  const record = {
    name: entry.name,
    provider: PROVIDERS.includes(entry.provider) ? entry.provider : "anthropic",
    dir,
    share: { config: entry.share?.config !== false, history: entry.share?.history !== false },
    credentialService: entry.credentialService,
    createdAt: registry.profiles[entry.name]?.createdAt ?? new Date().toISOString(),
    label: entry.label,
  };
  registry.profiles[entry.name] = record;
  await writeRegistry(registry, env);
  log.info("profile", "profile registered", { name: record.name, provider: record.provider, share: record.share });
  return record;
}

export async function patchRegistered(name, patch, env = process.env) {
  const registry = await readRegistry(env);
  const current = registry.profiles[name];
  if (!current) return null;
  const next = { ...current, ...patch, share: { ...current.share, ...patch.share } };
  registry.profiles[name] = next;
  await writeRegistry(registry, env);
  return next;
}

export async function removeRegistered(name, env = process.env) {
  const registry = await readRegistry(env);
  if (!Object.hasOwn(registry.profiles, name)) return false;
  delete registry.profiles[name];
  await writeRegistry(registry, env);
  log.info("profile", "profile unregistered", { name });
  return true;
}
