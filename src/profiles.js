// Launch profiles. Two are built in; users can add ~/.zclaude/profiles/*.env
// files whose KEY=value lines are applied to the child environment. A profile
// with ZCLAUDE_ZAI=1 also goes through the Z.ai credential and model steps.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { flag, zclaudeHome } from "./config.js";
import { foldsCase } from "./profiles/paths.js";
import { accountLabel, readIdentity } from "./profiles/probe.js";
import { listRegistered } from "./profiles/registry.js";
import { parseDotenv } from "./settings.js";
import { warn } from "./ui/log.js";

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {boolean} zai route through the Z.ai credential and model steps
 * @property {Record<string, string>} env extra variables for the child process
 * @property {boolean} builtin
 * @property {string} [path]
 * @property {string} [configDir] CLAUDE_CONFIG_DIR for a named profile
 * @property {"anthropic" | "zai"} [provider]
 * @property {{config: boolean, history: boolean}} [share]
 */

/** @type {readonly Profile[]} */
export const BUILTIN_PROFILES = Object.freeze([
  Object.freeze({
    id: "claude",
    label: "Claude Code",
    description: "Anthropic account, unchanged environment",
    zai: false,
    env: {},
    builtin: true,
  }),
  Object.freeze({
    id: "zai",
    label: "Claude Code + Z.ai GLM Coding Plan",
    description: "GLM models through api.z.ai, key from Keychain or browser sign-in",
    zai: true,
    env: {},
    builtin: true,
  }),
]);

const RESERVED = new Set(BUILTIN_PROFILES.map((profile) => profile.id));

function commentField(text, name) {
  const match = text.match(new RegExp(`^#\\s*${name}\\s*:\\s*(.+)$`, "mu"));
  return match ? match[1].trim() : "";
}

function profilesDir(env = process.env) {
  return join(zclaudeHome(env), "profiles");
}

/**
 * A registered profile as a menu entry. The account is read from the profile's
 * own config file, which is a plain file read: picking from the menu should not
 * wait on the Keychain, and it must never prompt for access.
 */
async function fromRecord(record) {
  const shared = [record.share.config ? "config" : null, record.share.history ? "history" : null].filter(Boolean);
  const provider = record.provider === "zai" ? "Z.ai GLM Coding Plan" : "Anthropic account";
  const identity = record.provider === "zai" ? null : await readIdentity(record.dir);
  const account = accountLabel(identity);
  const who = account ? ` · ${account}` : "";
  return {
    id: record.name,
    label: record.label || record.name,
    description: `${provider}${who}, own login${shared.length > 0 ? `, shares ${shared.join(" and ")}` : ""}`,
    zai: record.provider === "zai",
    env: {},
    builtin: false,
    configDir: record.dir,
    provider: record.provider,
    share: record.share,
  };
}

export async function listProfiles(env = process.env) {
  /** @type {Profile[]} */
  const profiles = [...BUILTIN_PROFILES];
  const registered = await listRegistered(env);
  const names = new Set(registered.map((record) => record.name));
  const menuEntries = await Promise.all(registered.map((record) => fromRecord(record)));
  profiles.push(...menuEntries);
  let entries;
  try {
    entries = await readdir(profilesDir(env), { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") warn(`Could not read ${profilesDir(env)}: ${error.message}`);
    return profiles;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".env"))
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b));
  for (const file of files) {
    const id = basename(file, ".env");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
      warn(`Skipping profile "${file}": names may only contain letters, digits, dots, dashes and underscores.`);
      continue;
    }
    if (RESERVED.has(id)) {
      warn(`Skipping profile "${file}": "${id}" is a built-in profile name.`);
      continue;
    }
    if (names.has(id)) {
      warn(`Skipping profile file "${file}": a registered profile already uses the name "${id}".`);
      continue;
    }
    const path = join(profilesDir(env), file);
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      warn(`Skipping profile "${file}": ${error.message}`);
      continue;
    }
    const { values, warnings } = parseDotenv(text, { file: path });
    for (const message of warnings) warn(message);
    const zai = flag(values, "ZCLAUDE_ZAI");
    const profileEnv = { ...values };
    delete profileEnv.ZCLAUDE_ZAI;
    profiles.push({
      id,
      label: commentField(text, "name") || id,
      description: commentField(text, "description") || (zai ? "custom profile via Z.ai" : "custom profile"),
      zai,
      env: profileEnv,
      builtin: false,
      path,
    });
  }
  return profiles;
}

/**
 * Find a profile by the name someone typed. Case is folded on filesystems that
 * fold it, because that is how the name was stored when the profile was made.
 * @param {Profile[]} profiles
 */
export function findProfile(profiles, id, platform = process.platform) {
  if (!id) return null;
  const exact = profiles.find((profile) => profile.id === id);
  if (exact || !foldsCase(platform)) return exact ?? null;
  const wanted = id.toLowerCase();
  return profiles.find((profile) => profile.id.toLowerCase() === wanted) ?? null;
}

/**
 * `zclaude work` means `zclaude --profile work`. Only an exact name that
 * exists is taken, so claude's own arguments keep passing straight through;
 * profile names cannot be one of claude's commands, so nothing is ambiguous.
 * @param {string[]} args
 * @param {Profile[]} profiles
 */
export function takeProfileArgument(args, profiles, platform = process.platform) {
  const [first, ...rest] = args;
  if (!first || first.startsWith("-")) return { profile: null, args };
  const found = findProfile(profiles, first, platform);
  if (!found) return { profile: null, args };
  // `zclaude work -- --help`: the separator has done its job once the name is
  // taken, and claude would treat it as an argument of its own.
  return { profile: found.id, args: rest[0] === "--" ? rest.slice(1) : rest };
}

export async function getProfile(id, env = process.env) {
  const profiles = await listProfiles(env);
  return findProfile(profiles, id);
}
