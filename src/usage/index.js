// One shape for "how much quota is left", whichever provider a profile uses,
// with a cache in front of it.
//
// The cache is not a nicety. The Anthropic usage endpoint budgets requests and
// answers 429 when a caller is greedy, and this data now has two consumers —
// the terminal picker and the VS Code status bar — which would otherwise
// compete for one budget. They share this file, so they share the backoff.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { zaiConfig, zclaudeHome } from "../config.js";
import { log } from "../logger.js";
import { claudeCredentialService } from "../profiles/keychain-name.js";
import { describeCredential, parseCredential, readCredential, writeCredential } from "../swap/keychain.js";
import { loadCredential } from "../store.js";
import { fetchQuota } from "../zai.js";
import { fetchUsage, needsRefresh, normaliseUsage, refreshCredential } from "./anthropic.js";

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 60_000;
/** Z.ai reports window units as numbers; 3 is the rolling 5 hours, 6 the week. */
const QUOTA_WINDOWS = { 5: "fiveHour", 3: "fiveHour", 6: "weekly" };

export function usagePath(env = process.env) {
  return join(zclaudeHome(env), "usage.json");
}

/** @returns {Promise<{version: number, profiles: Record<string, object>, backoffUntil: number}>} */
export async function readCache(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(usagePath(env), "utf8"));
    if (parsed?.version !== CACHE_VERSION) return { version: CACHE_VERSION, profiles: {}, backoffUntil: 0 };
    return {
      version: CACHE_VERSION,
      profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
      backoffUntil: Number(parsed.backoffUntil) || 0,
    };
  } catch {
    return { version: CACHE_VERSION, profiles: {}, backoffUntil: 0 };
  }
}

async function writeCache(cache, env = process.env) {
  const path = usagePath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify({ ...cache, version: CACHE_VERSION }, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, path);
  } catch (error) {
    // A cache that cannot be written costs a re-fetch, nothing more.
    log.debug("usage", "cache not written", { error });
  }
}

const STATE_TEXT = Object.freeze({
  unauthorized: "sign in to see usage",
  dead: "login expired",
  throttled: "usage rate limited, try again shortly",
  offline: "usage unavailable",
  unknown: "",
});

/** Percentages, as a line a list can show. */
export function formatUsage(usage) {
  if (!usage) return "";
  if (Object.hasOwn(STATE_TEXT, usage.state)) return STATE_TEXT[usage.state];
  const scoped = usage.scoped ?? [];
  const parts = [
    usage.fiveHour ? `5h ${Math.round(usage.fiveHour.pct)}%` : null,
    usage.weekly ? `wk ${Math.round(usage.weekly.pct)}%` : null,
    ...scoped.map((scope) => `${scope.name} ${Math.round(scope.pct)}%`),
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return usage.state === "stale" ? `${parts.join(" · ")} (cached)` : parts.join(" · ");
}

function empty(state, detail = null) {
  return { state, fiveHour: null, weekly: null, scoped: [], fetchedAt: 0, detail };
}

// ------------------------------------------------------------------- Z.ai

async function zaiUsage(record, { env, fetchImpl, signal, now }) {
  // The built-in Z.ai profile keeps its key in the default slot, so the record
  // says which one to read rather than assuming the profile's own name.
  const stored = await loadCredential({
    env,
    profile: record.zaiProfile === undefined ? record.name : record.zaiProfile,
  });
  if (!stored) return empty("unauthorized");
  const quota = await fetchQuota(stored.apiKey, zaiConfig(env), { fetchImpl, signal });
  if (!quota) return empty("offline");
  // Z.ai reports several limit types per window; the one nearest its ceiling is
  // what will stop you first, so that is the number worth showing.
  const worst = (slot) =>
    quota.limits
      .filter((limit) => QUOTA_WINDOWS[limit.unit] === slot && limit.percentage !== null)
      .map((limit) => ({ pct: limit.percentage, resetsAt: limit.nextResetTime ?? null }))
      .toSorted((a, b) => b.pct - a.pct)[0] ?? null;
  const usage = {
    state: "ok",
    fiveHour: worst("fiveHour"),
    weekly: worst("weekly"),
    scoped: [],
    fetchedAt: now,
    detail: null,
  };
  return usage.fiveHour || usage.weekly ? usage : empty("unknown");
}

// -------------------------------------------------------------- Anthropic

/**
 * Read a profile's credential, refreshing it first when it is about to expire.
 * A rotated credential is written back before it is used: the previous refresh
 * token stops working the moment the server rotates it, so a rotation that is
 * fetched and not persisted logs the profile out.
 */
async function freshCredential(record, { env, fetchImpl, signal, allowRefresh, now, security }) {
  // The global login's item carries no directory hash, so a record may name the
  // service outright instead of deriving it.
  const service = record.credentialService ?? claudeCredentialService(record.dir);
  let raw;
  try {
    raw = await readCredential({ service, env, security });
  } catch (error) {
    return { state: "unknown", detail: error.message };
  }
  const blob = parseCredential(raw);
  if (!blob) return { state: "unauthorized" };
  if (!needsRefresh(blob, now)) return { state: "ok", blob };
  if (!allowRefresh) return { state: "stale-token" };

  const refreshed = await refreshCredential(blob, { fetchImpl, signal, now });
  if (refreshed.state === "dead") return { state: "dead", detail: refreshed.detail };
  if (refreshed.state !== "ok") return { state: "offline", detail: refreshed.detail };
  try {
    await writeCredential({ service, secret: JSON.stringify(refreshed.blob), env, security });
  } catch (error) {
    // The rotated token exists on the server but not on disk. Say so loudly:
    // the profile may need a sign-in, and pretending otherwise hides it.
    log.error("usage", "refreshed credential could not be stored", { profile: record.name, error });
    return { state: "unknown", detail: `refreshed token could not be stored: ${error.message}` };
  }
  log.info("usage", "profile token refreshed", { profile: record.name, rotated: refreshed.rotated });
  return { state: "ok", blob: refreshed.blob };
}

async function anthropicUsage(record, options) {
  const credential = await freshCredential(record, options);
  if (credential.state !== "ok") return empty(credential.state, credential.detail ?? null);
  const answer = await fetchUsage(credential.blob.claudeAiOauth.accessToken, options);
  if (answer.state !== "ok") {
    // The endpoint's own Retry-After is the only honest backoff; losing it here
    // would make every throttle look like the default minute.
    const failed = empty(answer.state, answer.detail ?? null);
    return answer.retryAfterMs ? { ...failed, retryAfterMs: answer.retryAfterMs } : failed;
  }
  const normalised = normaliseUsage(answer.data);
  if (!normalised) return empty("unknown");
  return { state: "ok", ...normalised, fetchedAt: options.now, detail: null };
}

// ------------------------------------------------------------------ public

/**
 * @typedef {object} UsageRecord
 * @property {string} name
 * @property {string} provider "anthropic" or "zai"
 * @property {string} [dir] the profile's config directory, for an Anthropic login
 * @property {string} [credentialService] overrides the service derived from `dir`
 * @property {string | null} [zaiProfile] which stored Z.ai key to read
 */

/**
 * Usage for one profile, from the cache when it is fresh enough.
 * @param {UsageRecord} record
 */
export async function usageFor(record, options = {}) {
  const {
    env = process.env,
    fetchImpl,
    signal,
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    force = false,
    allowRefresh = true,
    security,
    cache: given = null,
  } = options;
  const cache = given ?? (await readCache(env));
  const served = servedFromCache(cache, record.name, { now, ttlMs, force });
  if (served) return served;

  const fetched =
    record.provider === "zai"
      ? await zaiUsage(record, { env, fetchImpl, signal, now })
      : await anthropicUsage(record, { env, fetchImpl, signal, allowRefresh, now, security });
  return recordResult(record.name, fetched, { env, now, previous: cache.profiles[record.name] });
}

/** Numbers worth keeping when the next lookup fails. */
function hasNumbers(usage) {
  return Boolean(usage && (usage.fiveHour || usage.weekly || usage.scoped?.length));
}

/** The cache's answer, when it has one worth giving. */
function servedFromCache(cache, name, { now, ttlMs, force }) {
  const cached = cache.profiles[name];
  if (!force && cached && now - (cached.fetchedAt ?? 0) < ttlMs) return { ...cached, state: cached.state ?? "ok" };
  if (cache.backoffUntil > now) {
    log.debug("usage", "in backoff, serving cache", { profile: name, until: cache.backoffUntil });
    if (!cached) return empty("throttled");
    // "stale" means "these numbers are old". An entry with no numbers has a
    // reason instead, and relabelling it would render as an empty row.
    return hasNumbers(cached) ? { ...cached, state: "stale" } : cached;
  }
  return null;
}

/**
 * States that settle the question rather than failing to answer it. A profile
 * that is signed out has no usage, and last week's numbers are not a better
 * answer than saying so — they are a wrong one that never expires, because the
 * cache would keep serving them past every later lookup.
 */
const DEFINITE = new Set(["unauthorized", "dead"]);

/**
 * Store what came back. Old numbers beat no numbers when the lookup merely
 * failed, so a timeout or a 429 keeps the last good ones and says they are
 * stale. A previous entry that had no numbers either is not worth keeping:
 * marking *that* stale would replace a row that said "sign in to see usage"
 * with a blank one.
 */
async function recordResult(name, fetched, { env, now, previous }) {
  const next = await readCache(env);
  if (fetched.state === "ok" || DEFINITE.has(fetched.state)) next.profiles[name] = fetched;
  else if (hasNumbers(previous)) next.profiles[name] = { ...previous, state: "stale", detail: fetched.detail ?? null };
  else next.profiles[name] = fetched;
  if (fetched.state === "throttled") next.backoffUntil = now + (fetched.retryAfterMs ?? 60_000);
  await writeCache(next, env);
  return fetched.state === "ok" || DEFINITE.has(fetched.state) ? fetched : (next.profiles[name] ?? fetched);
}

/**
 * Usage for several profiles at once, reported as each one lands so a caller
 * can paint a row at a time rather than waiting for the slowest.
 * @param {Array<object>} records
 * @param {{onResult?: (name: string, usage: object) => void, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, signal?: AbortSignal, now?: number, ttlMs?: number, force?: boolean, allowRefresh?: boolean}} [options]
 */
export async function usageForAll(records, options = {}) {
  const { onResult, env = process.env, ...rest } = options;
  const cache = await readCache(env);
  const results = {};
  await Promise.all(
    records.map(async (record) => {
      const usage = await usageFor(record, { ...rest, env, cache }).catch((error) => {
        log.warn("usage", "usage lookup failed", { profile: record.name, error });
        return empty("unknown", error.message);
      });
      results[record.name] = usage;
      onResult?.(record.name, usage);
    }),
  );
  return results;
}

/**
 * What a profile's stored credential looks like, without reading its secret twice.
 * @param {{provider: string, dir?: string, credentialService?: string}} record
 * @param {{env?: NodeJS.ProcessEnv, now?: number, security?: import("../swap/keychain.js").SecurityRunner}} [options]
 */
export async function credentialHealth(record, { env = process.env, now = Date.now(), security } = {}) {
  if (record.provider === "zai") return null;
  try {
    const service = record.credentialService ?? claudeCredentialService(record.dir);
    const blob = parseCredential(await readCredential({ service, env, security }));
    return blob ? describeCredential(blob, now) : null;
  } catch {
    return null;
  }
}
