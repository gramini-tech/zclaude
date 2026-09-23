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
import { describeCredential, parseCredential, readCredential } from "../swap/keychain.js";
import { lineageOf, refreshLineage } from "../swap/lineage.js";
import { acquire } from "../swap/locks.js";
import { loadCredential } from "../store.js";
import { fetchQuota } from "../zai.js";
import { fetchUsage, needsRefresh, normaliseUsage } from "./anthropic.js";
import { countdown, resetPhrase, resetTime } from "./when.js";

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

/**
 * A window a reset time is worth showing for. At 4% nobody is waiting for the
 * clock, and a row that repeats "resets in 6d" three times buries the numbers
 * that were the point of it.
 */
const PRESSED = 50;

/**
 * One window, with its percentage in a fixed three columns.
 *
 * The terminal is monospace, so padding is the whole difference between rows
 * that line up and rows that merely follow each other: "5h   3%" over
 * "5h 100%" puts every later column in the same place on every row.
 */
function windowText(label, window) {
  return window ? `${label} ${String(Math.round(window.pct)).padStart(3)}%` : null;
}

/**
 * The clock for whichever window is closest to its ceiling, at the end of the
 * line rather than beside its own percentage.
 *
 * One clock, and always last: a clock in the middle of the row pushed every
 * later column somewhere different on every row, which is exactly what the
 * padding above is there to prevent.
 */
function resetTail(windows, now) {
  const worst = windows.filter(Boolean).toSorted((a, b) => b.pct - a.pct)[0];
  if (!worst || Math.round(worst.pct) < PRESSED) return "";
  const left = countdown(worst.resetsAt, now);
  return left ? `⟳${left}` : "";
}

/** What is left to spend beyond the plan, when that is switched on. */
export function formatCredits(credits) {
  if (!credits) return "";
  if (credits.enabled) {
    if (credits.remaining === null) return "credits on";
    const amount = credits.remaining.toFixed(2);
    return `credits ${credits.currency === "USD" ? `$${amount}` : `${amount} ${credits.currency ?? ""}`.trim()} left`;
  }
  if (credits.spendLimitReached) return "credit limit reached";
  // A deliberate "off" is not news; running out is.
  return credits.reason === "out_of_credits" ? "credits spent" : "";
}

/**
 * States where the answer is not a number but a sign-in.
 *
 * `unauthorized` is a profile with no usable token at all; `dead` is one whose
 * refresh lineage the server has rejected, which no amount of retrying will
 * undo. Both are fixed by the same thing, and neither is fixed by waiting.
 */
const NEEDS_SIGN_IN = new Set(["unauthorized", "dead"]);

/**
 * What to do about a login, when that is what is wrong.
 *
 * One place, because four surfaces show this state — the picker, `profile list
 * --usage`, `doctor` and the editor's hover — and a row that says "login
 * expired" without saying what to do about it is a dead end in all four.
 *
 * Three answers, because the rows are not the same kind of thing. A registered
 * profile is signed in by name. The built-in Z.ai row has a key rather than an
 * account, so it goes through `zclaude login`. And the built-in Claude row is
 * the default installation's own login, which Claude Code owns and asks for
 * itself: there is nothing for zclaude to run, and saying otherwise would send
 * somebody looking for a command that does not exist.
 *
 * @param {object | null} usage
 * @param {string | {id?: string, name?: string, builtin?: boolean}} profile
 * @returns {{command: string | null, why: string, how: string, here: boolean} | null}
 */
export function signInHint(usage, profile) {
  const state = usage?.state;
  if (!state || !NEEDS_SIGN_IN.has(state)) return null;
  const why = STATE_TEXT[state];
  const name = typeof profile === "string" ? profile : (profile?.id ?? profile?.name ?? "");
  const builtin = typeof profile === "object" && profile?.builtin === true;
  if (!builtin) {
    const command = `zclaude profile login ${name}`;
    return { command, why, how: `run \`${command}\``, here: true };
  }
  if (name === "zai") return { command: "zclaude login", why, how: "run `zclaude login`", here: true };
  return { command: null, why, how: "launch it; Claude Code asks for a login itself", here: false };
}

/**
 * Percentages, as a line a list can show, with the reset clock on whichever
 * window is close enough to matter.
 * @param {object | null} usage
 * @param {number} [now]
 */
export function formatUsage(usage, now = Date.now()) {
  if (!usage) return "";
  if (Object.hasOwn(STATE_TEXT, usage.state)) return STATE_TEXT[usage.state];
  const scoped = usage.scoped ?? [];
  const parts = [
    windowText("5h", usage.fiveHour),
    windowText("wk", usage.weekly),
    ...scoped.map((scope) => windowText(scope.name, scope)),
  ].filter(Boolean);
  if (parts.length === 0) return "";
  // Credit only when there is a balance to know about. An account that never
  // turned it on repeating "credits spent" on every row says nothing and costs
  // the width that the numbers need; `profile list --usage` spells it out.
  const credit = usage.credits?.enabled || usage.credits?.spendLimitReached ? formatCredits(usage.credits) : "";
  const tail = [
    resetTail([usage.fiveHour, usage.weekly, ...scoped], now),
    credit,
    usage.state === "stale" ? "(cached)" : "",
  ].filter(Boolean);
  return [parts.join(" · "), ...tail].join("  ");
}

/**
 * Every window with its own reset, for a line with room: `profile show`, the
 * highlighted row's detail, the extension's hover.
 * @param {object | null} usage
 * @param {number} [now]
 * @param {{locale?: string, timeZone?: string}} [options]
 * @returns {Array<{label: string, pct: number, resets: string}>}
 */
export function usageRows(usage, now = Date.now(), options = {}) {
  if (!usage || Object.hasOwn(STATE_TEXT, usage.state)) return [];
  const windows = [
    usage.fiveHour ? { label: "5 hours", window: usage.fiveHour } : null,
    usage.weekly ? { label: "week", window: usage.weekly } : null,
    ...(usage.scoped ?? []).map((scope) => ({ label: `${scope.name} week`, window: scope })),
  ].filter(Boolean);
  return windows.map(({ label, window }) => ({
    label,
    pct: Math.round(window.pct),
    resets: resetPhrase(window.resetsAt, now, options),
  }));
}

function empty(state, detail = null) {
  return { state, fiveHour: null, weekly: null, scoped: [], credits: null, fetchedAt: 0, detail };
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
      .map((limit) => ({ pct: limit.percentage, resetsAt: resetTime(limit.nextResetTime) }))
      .toSorted((a, b) => b.pct - a.pct)[0] ?? null;
  const usage = {
    state: "ok",
    fiveHour: worst("fiveHour"),
    weekly: worst("weekly"),
    scoped: [],
    // A GLM coding plan has no pay-as-you-go tier to report.
    credits: null,
    fetchedAt: now,
    detail: null,
  };
  return usage.fiveHour || usage.weekly ? usage : empty("unknown");
}

// -------------------------------------------------------------- Anthropic

/**
 * Read a profile's credential, refreshing it first when it is about to expire.
 *
 * The refresh goes through the lineage layer rather than straight to the token
 * endpoint, because reading usage is not worth signing somebody out of their
 * editor. If this account also holds the global login, or a session is running
 * on it, another client mints its next token and this one spends what is left
 * of the current one instead.
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

  // `needsRefresh` fires five minutes early, so an access token that is merely
  // due a refresh is usually still good for this one request.
  const expiresAt = Number(blob.claudeAiOauth.expiresAt);
  const usable = Number.isFinite(expiresAt) && expiresAt > now;
  if (!allowRefresh) return usable ? { state: "ok", blob } : { state: "stale-token" };

  const refreshed = await refreshLineage(lineageOf(blob), { env, security, fetchImpl, signal, now });
  if (refreshed.state === "not-ours") {
    log.debug("usage", "left this login alone", { profile: record.name, reason: refreshed.detail });
    return usable ? { state: "ok", blob } : { state: "stale-token", detail: refreshed.detail };
  }
  if (refreshed.state === "dead") return { state: "dead", detail: refreshed.detail };
  if (refreshed.state !== "ok") return { state: "offline", detail: refreshed.detail };
  if (refreshed.failed.length > 0) {
    // The rotated token exists on the server but not in every store that held
    // the old one. Say so loudly: those stores are now a login that will stop
    // working, and pretending otherwise hides it.
    const where = refreshed.failed.map((one) => one.store).join(", ");
    log.error("usage", "refreshed credential could not be stored", { profile: record.name, where });
    return { state: "unknown", detail: `the refreshed token could not be stored for ${where}` };
  }
  log.info("usage", "profile token refreshed", {
    profile: record.name,
    rotated: refreshed.rotated,
    written: refreshed.written,
  });
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
    persist = true,
    settled: collect = null,
  } = options;
  const cache = given ?? (await readCache(env));
  const served = servedFromCache(cache, record.name, { now, ttlMs, force });
  if (served) return served;

  const fetched =
    record.provider === "zai"
      ? await zaiUsage(record, { env, fetchImpl, signal, now })
      : await anthropicUsage(record, { env, fetchImpl, signal, allowRefresh, now, security });
  const result = settle(record.name, fetched, { now, previous: cache.profiles[record.name] });
  collect?.push(result);
  if (persist) await persistSettled([result], { env, now });
  return result.returned;
}

/** Numbers worth keeping when the next lookup fails. */
function hasNumbers(usage) {
  return Boolean(usage && (usage.fiveHour || usage.weekly || usage.scoped?.length));
}

/** The cache's answer, when it has one worth giving. */
function servedFromCache(cache, name, { now, ttlMs, force }) {
  const cached = cache.profiles[name];
  if (!force && cached && now - (cached.fetchedAt ?? 0) < ttlMs) return { ...cached, state: cached.state ?? "ok" };
  const until = backoffFor(cache, name);
  if (until > now) {
    log.debug("usage", "in backoff, serving cache", { profile: name, until });
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
function settle(name, fetched, { now, previous }) {
  const definite = fetched.state === "ok" || DEFINITE.has(fetched.state);
  let entry;
  if (definite) entry = fetched;
  else if (hasNumbers(previous)) entry = { ...previous, state: "stale", detail: fetched.detail ?? null };
  else entry = fetched;
  const backoffUntil = fetched.state === "throttled" ? now + (fetched.retryAfterMs ?? 60_000) : 0;
  if (backoffUntil > 0) entry = { ...entry, backoffUntil };
  return { name, entry, backoffUntil, returned: definite ? fetched : entry };
}

/** Whatever is holding this profile back: its own 429, or a machine-wide one. */
function backoffFor(cache, name) {
  const own = Number(cache.profiles[name]?.backoffUntil) || 0;
  return Math.max(Number(cache.backoffUntil) || 0, own);
}

/**
 * Merge settled results into the cache and write it once.
 *
 * Under a lock, because every caller does read-modify-write on one shared file:
 * the launch menu, the VS Code hover and the auto daemon. Without it, one
 * profile's 429 write landing between another's read and write erases the
 * backoff just recorded, and that backoff is the whole machine's request
 * budget. A write that cannot take the lock is skipped rather than failed: a
 * cache that is not written costs a re-fetch and nothing more.
 */
async function persistSettled(settled, { env, now }) {
  if (settled.length === 0) return;
  let release;
  try {
    release = await acquire(`${usagePath(env)}.lock`, { staleMs: 5000, timeoutMs: 2000 });
  } catch (error) {
    log.debug("usage", "cache lock busy; not writing", { error });
    return;
  }
  try {
    const next = await readCache(env);
    for (const { name, entry } of settled) next.profiles[name] = entry;
    const throttled = settled.filter((one) => one.backoffUntil > now);
    const affected = Object.values(next.profiles).filter((one) => (Number(one.backoffUntil) || 0) > now).length;
    // A 429 now backs off the account that earned it. The machine-wide backoff
    // is kept for the case that says something different: a limit catching two
    // accounts at once is not per-account, so there is nothing to learn by
    // spending requests on the rest. Monotonic, never last-writer-wins, because
    // two processes recording different throttles must not undo each other.
    if (throttled.length > 0 && affected > 1) {
      next.backoffUntil = Math.max(Number(next.backoffUntil) || 0, ...throttled.map((one) => one.backoffUntil));
    }
    await writeCache(next, env);
  } finally {
    await release();
  }
}

/**
 * One window, preferring the fresher percentage and keeping the reset time only
 * the endpoint knows.
 */
function mergeWindow(fresh, kept) {
  if (!fresh) return kept ?? null;
  return { pct: fresh.pct, resetsAt: fresh.resetsAt ?? kept?.resetsAt ?? null };
}

/** The cached entry with the header reading folded in, never replaced by it. */
function mergeObserved(previous, observed, now) {
  return {
    ...previous,
    state: "ok",
    fiveHour: mergeWindow(observed.fiveHour, previous.fiveHour),
    weekly: mergeWindow(observed.weekly, previous.weekly),
    scoped: previous.scoped ?? [],
    credits: previous.credits ?? null,
    fetchedAt: observed.fetchedAt ?? now,
    detail: null,
    source: "headers",
  };
}

/**
 * Fold quota numbers that arrived on a response into the cache.
 *
 * `anthropic-ratelimit-unified-*` come back on every Max response, so a routed
 * session produces a fresh reading of its own account for free, on traffic
 * somebody was sending anyway. That turns the usage endpoint from the only
 * source into the fallback, and the picker, the watcher and the VS Code status
 * bar all read better numbers without a single extra request.
 *
 * It is a merge, never a replacement. The headers carry two windows and a
 * status and nothing else: no scoped per-model limits, no credit balance, no
 * reset time for the weekly window. Overwriting the cached entry with them
 * would erase what only the endpoint knows, so anything absent here keeps
 * whatever was already there.
 *
 * Never throws and never blocks the request it came from.
 *
 * @param {string} profile
 * @param {{fiveHour: {pct: number, resetsAt: string | null} | null, weekly: {pct: number} | null, status?: string | null, fetchedAt?: number}} observed
 * @param {{env?: NodeJS.ProcessEnv, now?: number}} [options]
 */
export async function observeUsage(profile, observed, { env = process.env, now = Date.now() } = {}) {
  if (!profile || !observed || (!observed.fiveHour && !observed.weekly)) return null;
  let release;
  try {
    release = await acquire(`${usagePath(env)}.lock`, { staleMs: 5000, timeoutMs: 2000 });
  } catch (error) {
    // A reading that cannot take the lock is discarded rather than queued. The
    // next response carries another one a few seconds later.
    log.debug("usage", "cache lock busy; not recording an observation", { error });
    return null;
  }
  try {
    const cache = await readCache(env);
    const previous = cache.profiles[profile] ?? {};
    // A cached reading taken *after* this one wins: responses can land out of
    // order, and a stale number overwriting a fresh one is worse than skipping.
    if (Number(previous.fetchedAt) > (observed.fetchedAt ?? now)) return null;
    const merged = mergeObserved(previous, observed, now);
    cache.profiles[profile] = merged;
    await writeCache(cache, env);
    log.debug("usage", "recorded a reading from response headers", {
      profile,
      fiveHour: merged.fiveHour?.pct ?? null,
      weekly: merged.weekly?.pct ?? null,
    });
    return merged;
  } finally {
    await release();
  }
}

/**
 * Usage for several profiles at once, reported as each one lands so a caller
 * can paint a row at a time rather than waiting for the slowest.
 * @param {Array<object>} records
 * @param {{onResult?: (name: string, usage: object) => void, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, signal?: AbortSignal, now?: number, ttlMs?: number, force?: boolean, allowRefresh?: boolean, security?: object}} [options]
 */
export async function usageForAll(records, options = {}) {
  const { onResult, env = process.env, now = Date.now(), ...rest } = options;
  const cache = await readCache(env);
  const results = {};
  const settled = [];
  await Promise.all(
    records.map(async (record) => {
      const usage = await usageFor(record, { ...rest, env, now, cache, persist: false, settled }).catch((error) => {
        log.warn("usage", "usage lookup failed", { profile: record.name, error });
        return empty("unknown", error.message);
      });
      results[record.name] = usage;
      onResult?.(record.name, usage);
    }),
  );
  // One write for the whole fan-out. It used to be one per profile, each doing
  // its own read-modify-write, so whoever finished last quietly reverted what
  // the others had recorded in between.
  await persistSettled(settled, { env, now });
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
