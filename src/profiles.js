// Launch profiles. Two are built in; users can add ~/.zclaude/profiles/*.env
// files whose KEY=value lines are applied to the child environment. A profile
// with ZCLAUDE_ZAI=1 also goes through the Z.ai credential and model steps.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { flag, zclaudeHome } from "./config.js";
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

export async function listProfiles(env = process.env) {
  /** @type {Profile[]} */
  const profiles = [...BUILTIN_PROFILES];
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

export async function getProfile(id, env = process.env) {
  const profiles = await listProfiles(env);
  return profiles.find((profile) => profile.id === id) ?? null;
}
