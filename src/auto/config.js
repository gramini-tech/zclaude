// The inventory: what each plan is worth, and when work should move.
//
// Plain JSON, hand-editable, optional. It is read with `JSON.parse` and
// nothing else — no comment stripping, no new dependency, no parser of our own
// to get subtly wrong on a file that must never be able to block a launch. The
// explanations live in `_readme` and in `_comment` keys beside anything
// surprising, which is the one thing JSON gives you for free.
//
// A missing file is normal. A malformed one is a warning and the built-in
// defaults, never an error: a half-parsed config with a zeroed threshold is
// more dangerous than no config at all.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { zclaudeHome } from "../config.js";
import { log } from "../logger.js";

/**
 * Plan sizes relative to Claude Pro, keyed by the tier the credential reports.
 * Published multipliers; the learned burn rate corrects them per account once
 * there is anything to learn from.
 */
export const DEFAULT_TIERS = Object.freeze({
  default_claude_pro: 1,
  default_claude_max_5x: 5,
  default_claude_max_20x: 20,
  default_team: 1.25,
  default_team_premium: 6.25,
});

const DEFAULT_AUTO_CONFIG = Object.freeze({
  _readme: Object.freeze([
    "zclaude auto — what each plan is worth, and when work should move off it.",
    "",
    "Every key is optional. Delete one and zclaude uses its own default, so",
    "deleting this whole file changes nothing. No secrets belong here; it is",
    "safe to commit.",
    "",
    "tiers: how large a plan is, relative to Claude Pro = 1. The key is the",
    "  tier the credential itself reports, which zclaude reads for you — run",
    "  `zclaude auto status` to see what each of your accounts says. A tier",
    "  that is not listed weighs 1, the smallest plan there is, because",
    "  over-estimating a seat sends long work to a small account.",
    "",
    "ladder: the percentages work leaves an account at. Every account is",
    "  drained to the first before any is pushed to the second, so there is",
    "  headroom in hand everywhere; the gap absorbs the half-minute during",
    "  which a switched-away account keeps being spent.",
    "",
    "resetBelow: a window back under this can only have turned over, which is",
    "  what lets an account be used again without waiting out its cooldown.",
  ]),
  tiers: DEFAULT_TIERS,
  ladder: Object.freeze([95, 100]),
  resetBelow: 50,
  poll: Object.freeze({
    _comment: "Seconds. The floor is enforced in code as well, so no edit here can make zclaude greedy.",
    baseSeconds: 300,
    floorSeconds: 45,
    coldMaxSeconds: 1800,
  }),
  allowCrossOrg: false,
});

export function autoConfigPath(env = process.env) {
  return join(zclaudeHome(env), "auto.json");
}

/** A number inside its bounds, or the default, with a warning naming the key. */
function bounded(value, { min, max, fallback, key, warnings }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  if (clamped !== number) warnings.push(`${key} was ${number}; using ${clamped}.`);
  return clamped;
}

/**
 * Read the inventory, falling back to the defaults for anything missing.
 *
 * Never throws and never blocks anything. Maps merge key by key so naming one
 * tier does not delete the others; lists are replaced wholesale, because the
 * order of a ladder is its meaning and merging it element by element would be
 * nonsense.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{config: object, path: string, exists: boolean, ok: boolean, warnings: string[]}>}
 */
export async function loadAutoConfig({ env = process.env } = {}) {
  const path = autoConfigPath(env);
  const warnings = [];
  let raw;
  let exists = false;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
    exists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      warnings.push(`${path} is not valid JSON, so the built-in defaults are in use: ${error.message}`);
      log.warn("auto", "inventory unreadable", { error });
      exists = true;
    }
    return { config: { ...DEFAULT_AUTO_CONFIG }, path, exists, ok: !exists, warnings };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${path} is not an object, so the built-in defaults are in use.`);
    return { config: { ...DEFAULT_AUTO_CONFIG }, path, exists, ok: false, warnings };
  }

  const tiers = { ...DEFAULT_TIERS };
  const given = Object.entries(raw.tiers ?? {});
  for (const [name, value] of given) {
    if (name.startsWith("_")) continue;
    tiers[name] = bounded(value, { min: 0.1, max: 1000, fallback: 1, key: `tiers.${name}`, warnings });
  }

  const ladder = Array.isArray(raw.ladder)
    ? raw.ladder
        .map((step, index) => bounded(step, { min: 50, max: 100, fallback: 95, key: `ladder[${index}]`, warnings }))
        .toSorted((a, b) => a - b)
    : [...DEFAULT_AUTO_CONFIG.ladder];
  if (ladder.length === 0) {
    warnings.push("ladder was empty; using the default.");
    ladder.push(...DEFAULT_AUTO_CONFIG.ladder);
  }

  const resetBelow = bounded(raw.resetBelow, {
    min: 0,
    max: ladder[0] - 5,
    fallback: DEFAULT_AUTO_CONFIG.resetBelow,
    key: "resetBelow",
    warnings,
  });

  const poll = { ...DEFAULT_AUTO_CONFIG.poll };
  for (const key of ["baseSeconds", "floorSeconds", "coldMaxSeconds"]) {
    if (raw.poll?.[key] === undefined) continue;
    // The floor is deliberately not configurable below itself: nobody should be
    // able to edit their way into hammering the usage endpoint every second.
    const min = key === "floorSeconds" ? DEFAULT_AUTO_CONFIG.poll.floorSeconds : 1;
    poll[key] = bounded(raw.poll[key], { min, max: 86_400, fallback: poll[key], key: `poll.${key}`, warnings });
  }

  const known = new Set(["_readme", "tiers", "ladder", "resetBelow", "poll", "allowCrossOrg"]);
  for (const key of Object.keys(raw)) {
    // Named rather than swallowed: silently ignoring a typo is how somebody
    // believes they set 99 and gets 95.
    if (!known.has(key)) warnings.push(`${key} is not a setting zclaude knows, so it was ignored.`);
  }

  return {
    config: { ...DEFAULT_AUTO_CONFIG, tiers, ladder, resetBelow, poll, allowCrossOrg: raw.allowCrossOrg === true },
    path,
    exists,
    ok: warnings.length === 0,
    warnings,
  };
}

/**
 * Write the fully explained defaults, for someone who wants to edit them.
 * @param {{env?: NodeJS.ProcessEnv, force?: boolean}} [options]
 */
export async function initAutoConfig({ env = process.env, force = false } = {}) {
  const path = autoConfigPath(env);
  if (!force) {
    try {
      await readFile(path, "utf8");
      return { written: false, path, reason: "it already exists" };
    } catch {
      // Not there, which is the case this is for.
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(DEFAULT_AUTO_CONFIG, null, 2)}\n`, { mode: 0o644 });
  return { written: true, path, reason: null };
}
