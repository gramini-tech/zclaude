// What a new profile starts with.
//
// Claude Code's own config file has around ninety top-level keys and gains more
// each release, so this copies from an allowlist rather than filtering a
// denylist. Anything identity-bearing, any entitlement cache and the projects
// map with its tool permissions stay behind: a personal profile must not
// inherit a company's model access or approved tools.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalConfigDir } from "./paths.js";

/** Preferences worth carrying over. Everything else is earned by logging in. */
export const SEED_ALLOWLIST = Object.freeze([
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "theme",
  "installMethod",
  "autoUpdates",
  "autoUpdatesProtectedForNative",
]);

/** MCP servers whose definition carries values in `env`, which are usually secrets. */
export function mcpServersWithSecrets(servers) {
  return Object.entries(servers ?? {})
    .filter(([, value]) => value && typeof value === "object" && Object.keys(value.env ?? {}).length > 0)
    .map(([name]) => name);
}

/** Paths the source config already trusts, so trust is copied and never invented. */
export function trustedProjects(source) {
  return Object.entries(source?.projects ?? {})
    .filter(([, value]) => value && typeof value === "object" && value.hasTrustDialogAccepted === true)
    .map(([path]) => path);
}

/**
 * @param {object} source the default installation's parsed config, or {}
 * @param {{mcp?: boolean, trust?: boolean}} [options]
 */
export function buildSeed(source = {}, { mcp = false, trust = false } = {}) {
  const seed = { hasCompletedOnboarding: true };
  for (const key of SEED_ALLOWLIST) {
    if (source?.[key] !== undefined) seed[key] = source[key];
  }
  seed.hasCompletedOnboarding = true;
  if (mcp && source?.mcpServers && typeof source.mcpServers === "object") {
    seed.mcpServers = structuredClone(source.mcpServers);
  }
  if (trust) {
    const paths = trustedProjects(source);
    const trusted = paths.map((path) => [path, { hasTrustDialogAccepted: true }]);
    if (trusted.length > 0) seed.projects = Object.fromEntries(trusted);
  }
  return seed;
}

/** Read the default installation's config file, for seeding a new profile. */
export async function readDefaultConfig(defaultDir) {
  const path = join(canonicalConfigDir(defaultDir), ".claude.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/** Write the seed into a profile's config directory, replacing nothing else. */
export async function writeSeed(configDir, seed) {
  const path = join(canonicalConfigDir(configDir), ".claude.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  return path;
}
