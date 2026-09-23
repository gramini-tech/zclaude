// Reading Claude Code's own settings files. Strictly read-only: zclaude never
// writes into them, it only needs to know when a value there would outrank the
// environment it is about to set.
//
// Claude Code applies settings in tiers, each one overriding the one before:
// user, then project, then project-local, then machine-wide managed policy.
// The `env` block of any tier is applied over the process environment
// (measured with claude 2.1.273), so a value there wins over what zclaude
// exports for the session.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { mask } from "./ui/log.js";

/** Machine-wide policy files. An MDM policy applies to every profile. */
export const MANAGED_SETTINGS_PATHS = Object.freeze({
  darwin: ["/Library/Application Support/ClaudeCode/managed-settings.json"],
  linux: ["/etc/claude-code/managed-settings.json"],
  win32: ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"],
});

/** The directory Claude Code would read for the given environment. */
export function claudeConfigDir(env = process.env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return configured || join(env.HOME || homedir(), ".claude");
}

/**
 * Every settings file that applies to a session, lowest precedence first.
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, platform?: NodeJS.Platform}} args
 */
export function claudeSettingsPaths({ env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  return [
    { tier: "user", path: join(claudeConfigDir(env), "settings.json") },
    { tier: "project", path: join(cwd, ".claude", "settings.json") },
    { tier: "local", path: join(cwd, ".claude", "settings.local.json") },
    ...(MANAGED_SETTINGS_PATHS[platform] ?? []).map((path) => ({ tier: "managed", path })),
  ];
}

/** Parse one settings file. A missing or broken file reads as empty. */
async function readSettingsEnv(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const block = parsed?.env && typeof parsed.env === "object" ? parsed.env : {};
    return { path, block, exists: true, model: typeof parsed?.model === "string" ? parsed.model : null };
  } catch (error) {
    return { path, block: {}, exists: false, model: null, error: error?.code === "ENOENT" ? null : error.message };
  }
}

/** Every tier that exists, with its env block. */
export async function claudeSettingsTiers(options = {}) {
  const found = await Promise.all(
    claudeSettingsPaths(options).map(async (entry) => ({ ...entry, ...(await readSettingsEnv(entry.path)) })),
  );
  return found.filter((entry) => entry.exists);
}

/** Variables zclaude sets for a session, which a settings env block could override. */
export const SESSION_KEYS = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CONFIG_DIR",
]);

// Aliases resolve through the ANTHROPIC_DEFAULT_* values zclaude sets, so they
// are not a conflict.
const ALIAS_MODELS = new Set(["opus", "sonnet", "haiku"]);

/**
 * Which keys in one env block would override this session.
 *
 * `outranked` names keys this launch writes into a higher tier of its own, the
 * `--settings` file, which beats every tier read here. Without it, turning the
 * router on would report a conflict on every launch, and the way people make a
 * nagging check stop is to set ZCLAUDE_ALLOW_SETTINGS_OVERRIDE permanently and
 * lose the check that matters. Managed settings are never suppressed: no tier
 * of ours outranks a machine policy.
 *
 * @param {Record<string, unknown>} block
 * @param {Record<string, string>} childEnv
 * @param {{outranked?: Set<string> | null}} [options]
 */
export function conflictsIn(block, childEnv, { outranked = null } = {}) {
  const conflicts = [];
  for (const key of SESSION_KEYS) {
    if (!Object.hasOwn(block, key) || outranked?.has(key)) continue;
    const theirs = String(block[key]);
    if (key === "ANTHROPIC_API_KEY") {
      conflicts.push({ key, theirs: mask(theirs), ours: "(unset)" });
      continue;
    }
    const aliasOk = key === "CLAUDE_CODE_SUBAGENT_MODEL" && ALIAS_MODELS.has(theirs.toLowerCase());
    if (aliasOk || !Object.hasOwn(childEnv, key) || theirs === childEnv[key]) continue;
    const secret = key === "ANTHROPIC_AUTH_TOKEN";
    conflicts.push({ key, theirs: secret ? mask(theirs) : theirs, ours: secret ? mask(childEnv[key]) : childEnv[key] });
  }
  return conflicts;
}

/**
 * Every tier whose env block would override the environment being launched.
 * The child's own environment decides which user-tier file is read, so a
 * profile is checked against its own settings rather than the default ones.
 * @param {{childEnv: Record<string, string>, cwd?: string, platform?: NodeJS.Platform, outranked?: Set<string> | null}} args
 */
export async function settingsConflicts({
  childEnv,
  cwd = process.cwd(),
  platform = process.platform,
  outranked = null,
}) {
  const tiers = await claudeSettingsTiers({ env: childEnv, cwd, platform });
  return tiers
    .map((tier) => ({
      tier: tier.tier,
      path: tier.path,
      conflicts: conflictsIn(tier.block, childEnv, { outranked: tier.tier === "managed" ? null : outranked }),
    }))
    .filter((entry) => entry.conflicts.length > 0);
}

/** One line per conflicting key, named by the file a reader would open. */
export function describeConflicts(found) {
  return found.flatMap((entry) =>
    entry.conflicts.map(
      (conflict) =>
        `  ${conflict.key}: ${basename(entry.path)} has ${conflict.theirs}, this session wants ${conflict.ours}`,
    ),
  );
}
