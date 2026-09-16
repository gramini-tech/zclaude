// Creating a profile and getting it ready to launch.
//
// Everything that touches the filesystem for a named profile lives here, so
// cli.js stays a thin layer of prompts and reporting, and so the arguments
// passed through to claude are built away from the flag table.

import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { log } from "../logger.js";
import { claudeCredentialService } from "./keychain-name.js";
import { canonicalConfigDir, profileConfigDir, profileRoot, validateProfileName } from "./paths.js";
import { buildSeed, readDefaultConfig, writeSeed } from "./seed.js";
import { detachedShares, linkShares, materialiseSharedSettings } from "./share.js";
import { listRegistered, putRegistered, removeRegistered } from "./registry.js";

/** Claude Code's own configuration directory, which profiles borrow from. */
export function defaultConfigDir(env = process.env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return canonicalConfigDir(configured || join(env.HOME || homedir(), ".claude"));
}

/**
 * Create a profile: directory, seed, shares, registry entry. Returns the
 * record plus what was shared and which MCP servers carry secrets.
 * @param {{name: string, provider: "anthropic" | "zai", share?: {config?: boolean, history?: boolean}, mcp?: boolean, trust?: boolean, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform}} args
 */
export async function createProfile({
  name,
  provider,
  share = { config: true, history: true },
  mcp = false,
  trust = false,
  env = process.env,
  platform = process.platform,
}) {
  const taken = (await listRegistered(env)).map((profile) => profile.name);
  const validated = validateProfileName(name, { platform, taken });
  const configDir = profileConfigDir(validated, env);
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const defaultDir = defaultConfigDir(env);
  const source = await readDefaultConfig(defaultDir);
  await writeSeed(configDir, buildSeed(source, { mcp, trust }));
  const linked = await linkShares({ defaultDir, configDir, share });

  const record = await putRegistered(
    { name: validated, provider, share, dir: configDir, credentialService: claudeCredentialService(configDir) },
    env,
  );
  log.info("profile", "profile created", { name: validated, provider, share, linked: linked.linked });
  return { record, linked, seededFrom: defaultDir };
}

/**
 * Delete a profile's directory and registry entry. The shares inside it are
 * symlinks, so removing the directory never reaches what they point at.
 */
export async function deleteProfile(name, env = process.env) {
  const root = profileRoot(name, env);
  await rm(root, { recursive: true, force: true });
  const removed = await removeRegistered(name, env);
  log.info("profile", "profile deleted", { name, root, removed });
  return { root, removed };
}

/**
 * Bring a profile's directory up to date and return what claude needs.
 * @returns {Promise<{configDir: string, claudeArgs: string[], occupied: string[], detached: string[], removedSettings: string[]}>}
 */
export async function prepareLaunch(record, env = process.env) {
  const configDir = canonicalConfigDir(record.dir);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const defaultDir = defaultConfigDir(env);
  const share = record.share ?? { config: true, history: true };
  const result = { configDir, claudeArgs: [], occupied: [], detached: [], removedSettings: [] };

  if (share.config || share.history) {
    const linked = await linkShares({ defaultDir, configDir, share });
    result.occupied = linked.occupied;
  }
  if (share.config) {
    const shared = await materialiseSharedSettings({
      defaultDir,
      profileRootDir: dirname(configDir),
      provider: record.provider,
    });
    if (shared) {
      // Built here rather than in cli.js: this is claude's flag, not zclaude's.
      result.claudeArgs.push("--settings", shared.path);
      result.removedSettings = shared.removed;
    }
  }
  result.detached = await detachedShares({ configDir, share });
  log.debug("profile", "launch prepared", {
    name: record.name,
    configDir,
    shared: share,
    detached: result.detached,
  });
  return result;
}
