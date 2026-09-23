// Which models each provider actually has, asked rather than remembered.
//
// zclaude has carried a hand-copied model table since it was a Z.ai launcher:
// `MODEL_CONTEXT_WINDOWS` in config.js is a transcription of somebody else's
// registry, and it goes stale the day a provider ships. Measured on
// 2026-09-23, `claude-opus-5-5` had been out for two days and appeared in no
// table in this repository. A tool whose job is choosing between models cannot
// be the last thing on the machine to hear about one.
//
// So nothing here is written down. Both providers publish a list and both are
// already reachable with credentials zclaude holds:
//
//   anthropic  GET /v1/models, newest first, with display_name, created_at and
//              max_input_tokens. It accepts the OAuth bearer a subscription
//              login carries, which is what makes this possible at all.
//   zai        the endpoint `checkKey` already calls, which answers with ids
//              and nothing else; the context window has to come from the
//              fallback table for those.
//
// Two rules hold this together. It never mints a token: listing models is not
// worth spending a refresh, and `swap/lineage.js` explains at length why a
// second refresher is how people get signed out. And it never fails a caller:
// an unreachable provider answers from the pinned table with `source` saying
// so, because a route editor that shows nothing is worse than one that shows
// last release's names and admits it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { contextWindowFor, MODEL_CONTEXT_WINDOWS, zaiConfig, zclaudeHome } from "../config.js";
import { request } from "../http.js";
import { log } from "../logger.js";
import { listRegistered } from "../profiles/registry.js";
import { explicitZaiKey, loadCredential } from "../store.js";
import { credentialStores } from "../swap/lineage.js";
import { BETA_HEADER } from "../usage/anthropic.js";

export const PROVIDERS = Object.freeze(["anthropic", "zai"]);
export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
/** Six hours. A provider ships a model a few times a year; this is not a hot path. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
/** The most a provider is asked for. Twelve exist today; this is headroom, not a guess. */
const PAGE_LIMIT = 100;

/**
 * @typedef {object} CatalogueModel
 * @property {string} id
 * @property {string} label how a person reads it
 * @property {number | null} contextWindow input tokens, null when nobody said
 * @property {number | null} maxOutput
 * @property {string | null} releasedAt ISO 8601, or null
 * @property {boolean} fast whether the provider marks this as its small tier
 *
 * @typedef {object} Catalogue
 * @property {string} provider
 * @property {CatalogueModel[]} models newest first
 * @property {"live" | "cached" | "fallback"} source
 * @property {number} fetchedAt
 * @property {string | null} detail why it is not live, when it is not
 */

export function cataloguePath(env = process.env) {
  return join(zclaudeHome(env), "models.json");
}

/**
 * A model id that names the provider's small, cheap tier.
 *
 * Matched on the id and the label rather than kept as a list, for the same
 * reason as everything else here: "flash", "haiku" and "mini" are how vendors
 * have named this tier for years, and a list of ids would need editing on
 * exactly the day this module exists to survive.
 */
export function isFastTier(id, label = "") {
  return /\b(flash|haiku|mini|lite|turbo|small)\b/iu.test(`${id} ${label}`);
}

/**
 * The version numbers in a model id, most significant first.
 *
 * `glm-5.3-flash` gives [5, 3]; `claude-opus-4-5-20251101` gives
 * [4, 5, 20251101]. Read from the id rather than kept in a table, because the
 * whole point here is to understand a name nobody has written down yet.
 */
export function versionKey(id) {
  return String(id ?? "")
    .split(/[^\d]+/u)
    .filter(Boolean)
    .map(Number);
}

function compareVersions(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? -1) - (left[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Newest first, by whatever the provider was willing to say.
 *
 * A release date when there is one. Z.ai publishes none and answers in
 * alphabetical order, which put its oldest model first and would have made
 * `latest` resolve to `glm-4.5`. So the id's own version numbers are the
 * fallback, and a plain id sorts ahead of a suffixed one of the same version so
 * that "latest" means the base model rather than its flash variant.
 */
export function orderModels(models) {
  return models.toSorted((a, b) => {
    const at = (model) => Date.parse(model.releasedAt ?? "") || 0;
    const dates = at(b) - at(a);
    if (dates !== 0) return dates;
    const versions = compareVersions(a.id, b.id);
    if (versions !== 0) return versions;
    return a.id.length - b.id.length || a.id.localeCompare(b.id);
  });
}

// ------------------------------------------------------------------ fallback

/**
 * What to answer with when a provider cannot be reached.
 *
 * Z.ai has a pinned table to fall back to. Anthropic has none, and inventing
 * one here would be the exact habit this module exists to break, so it answers
 * with nothing and says why. A caller showing an empty list with a reason is
 * being honest; a caller showing a model that may not exist is not.
 */
function fallbackFor(provider, detail) {
  const models =
    provider === "zai"
      ? Object.keys(MODEL_CONTEXT_WINDOWS).map((id) => ({
          id,
          label: id,
          contextWindow: contextWindowFor(id),
          maxOutput: null,
          releasedAt: null,
          fast: isFastTier(id),
        }))
      : [];
  return { provider, models: orderModels(models), source: /** @type {const} */ ("fallback"), fetchedAt: 0, detail };
}

// ----------------------------------------------------------------- anthropic

/**
 * An access token to ask with, from whichever signed-in profile has an
 * unexpired one. Read-only, always: this never refreshes.
 *
 * Any account's token answers the same question, so the first usable one wins
 * and a profile whose token has lapsed is skipped rather than renewed.
 */
async function readOnlyToken({ env, security, now }) {
  let stores;
  try {
    stores = await credentialStores({ env, security });
  } catch (error) {
    log.debug("router", "no credential store to list models with", { error });
    return null;
  }
  for (const store of stores) {
    const oauth = store.blob?.claudeAiOauth;
    const expiresAt = Number(oauth?.expiresAt);
    if (typeof oauth?.accessToken === "string" && Number.isFinite(expiresAt) && expiresAt > now) {
      return oauth.accessToken;
    }
  }
  return null;
}

function anthropicModel(entry) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  if (!id) return null;
  const label = typeof entry.display_name === "string" ? entry.display_name : id;
  const number = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  return {
    id,
    label,
    contextWindow: number(entry.max_input_tokens),
    maxOutput: number(entry.max_tokens),
    releasedAt: typeof entry.created_at === "string" ? entry.created_at : null,
    fast: isFastTier(id, label),
  };
}

async function fetchAnthropic({ env, security, fetchImpl, signal, now }) {
  const token = await readOnlyToken({ env, security, now });
  if (!token) return fallbackFor("anthropic", "no signed-in account has an unexpired token");
  let response;
  try {
    response = await request({
      url: `${ANTHROPIC_MODELS_URL}?limit=${PAGE_LIMIT}`,
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": BETA_HEADER,
        "anthropic-version": "2023-06-01",
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl,
      signal,
    });
  } catch (error) {
    return fallbackFor("anthropic", error?.message ?? "the models endpoint could not be reached");
  }
  if (!response.ok) return fallbackFor("anthropic", `HTTP ${response.status}`);
  const rows = Array.isArray(response.json?.data) ? response.json.data : [];
  const models = orderModels(rows.map((row) => anthropicModel(row)).filter(Boolean));
  if (models.length === 0) return fallbackFor("anthropic", "the models endpoint returned nothing usable");
  return { provider: "anthropic", models, source: /** @type {const} */ ("live"), fetchedAt: now, detail: null };
}

// ----------------------------------------------------------------------- zai

/**
 * Z.ai answers with ids and no metadata, so the context window comes from the
 * pinned table. That is a fallback for one field rather than for the list, and
 * the distinction matters: the ids are current even when the windows are not.
 */
async function fetchZai({ env, fetchImpl, signal, now }) {
  // Same precedence as every other Z.ai surface: an environment key outranks a
  // stored one, and a profile's key is the last resort.
  const stored = await loadCredential({ env }).catch(() => null);
  const key = explicitZaiKey(env) || stored?.apiKey || (await firstZaiKey(env));
  if (!key) return fallbackFor("zai", "no Z.ai key is stored");
  const config = zaiConfig(env);
  let response;
  try {
    response = await request({
      url: config.modelsUrl,
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl,
      signal,
    });
  } catch (error) {
    return fallbackFor("zai", error?.message ?? "the models endpoint could not be reached");
  }
  if (!response.ok) return fallbackFor("zai", `HTTP ${response.status}`);
  const rows = Array.isArray(response.json?.data) ? response.json.data : [];
  const models = rows
    .map((row) => (typeof row?.id === "string" ? row.id : ""))
    .filter(Boolean)
    .map((id) => ({
      id,
      label: id,
      contextWindow: contextWindowFor(id),
      maxOutput: null,
      releasedAt: null,
      fast: isFastTier(id),
    }));
  if (models.length === 0) return fallbackFor("zai", "the models endpoint returned nothing usable");
  return {
    provider: "zai",
    models: orderModels(models),
    source: /** @type {const} */ ("live"),
    fetchedAt: now,
    detail: null,
  };
}

/** A key from any Z.ai profile, for a machine where the default slot is empty. */
async function firstZaiKey(env) {
  const records = await listRegistered(env).catch(() => []);
  for (const record of records) {
    if (record.provider !== "zai") continue;
    const stored = await loadCredential({ env, profile: record.name }).catch(() => null);
    if (stored?.apiKey) return stored.apiKey;
  }
  return null;
}

// --------------------------------------------------------------------- cache

async function readCache(env) {
  try {
    const parsed = JSON.parse(await readFile(cataloguePath(env), "utf8"));
    return parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {};
  } catch {
    return {};
  }
}

/**
 * Write the whole file back. A lost write costs one re-fetch, so this reports
 * nothing and never throws; the same bargain `usage/index.js` strikes.
 */
async function writeCache(providers, env) {
  const path = cataloguePath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    log.debug("router", "model cache not written", { error });
  }
}

// -------------------------------------------------------------------- public

/**
 * Every model a provider has, newest first.
 *
 * @param {{provider: string, env?: NodeJS.ProcessEnv, security?: import("../swap/keychain.js").SecurityRunner, fetchImpl?: typeof fetch, signal?: AbortSignal, now?: number, ttlMs?: number, force?: boolean}} options
 * @returns {Promise<Catalogue>}
 */
export async function listModels({
  provider,
  env = process.env,
  security,
  fetchImpl,
  signal,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  force = false,
}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider "${provider}".`);
  const cached = (await readCache(env))[provider];
  if (!force && cached?.source === "live" && now - (cached.fetchedAt ?? 0) < ttlMs) {
    return { ...cached, source: "cached" };
  }
  const fetched =
    provider === "anthropic"
      ? await fetchAnthropic({ env, security, fetchImpl, signal, now })
      : await fetchZai({ env, fetchImpl, signal, now });
  if (fetched.source === "live") {
    await writeCache({ ...(await readCache(env)), [provider]: fetched }, env);
    log.info("router", "model catalogue refreshed", { provider, count: fetched.models.length });
    return fetched;
  }
  // A stale live answer beats the pinned table: the ids were real once, which
  // is more than the table can say, and the reason for the staleness is kept.
  if (cached?.models?.length > 0) return { ...cached, source: "cached", detail: fetched.detail };
  return fetched;
}

/** Every provider at once, for a page that lists them side by side. */
export async function listAllModels(options = {}) {
  const entries = await Promise.all(
    PROVIDERS.map(async (provider) => [provider, await listModels({ ...options, provider })]),
  );
  return Object.fromEntries(entries);
}

/**
 * Turn what the config says into a model the provider actually has.
 *
 * `latest` and `latest:fast` are the point of the whole module: a route written
 * once keeps meaning "the current one" without anybody editing it. An exact id
 * is honoured when the provider still lists it and falls back to the newest
 * when it does not, because a route that stops working the day a model retires
 * is a worse failure than one that quietly moves forward and says it did.
 *
 * @param {string} selector
 * @param {Catalogue} catalogue
 * @returns {{id: string | null, matched: "exact" | "latest" | "latest-fast" | "replaced" | "none", detail: string | null}}
 */
export function resolveModel(selector, catalogue) {
  const models = catalogue?.models ?? [];
  const wanted = String(selector ?? "").trim();
  const newest = (list) => list[0]?.id ?? null;

  if (!wanted || wanted === "latest") {
    const id = newest(models);
    return { id, matched: id ? "latest" : "none", detail: id ? null : "the provider listed no models" };
  }
  if (wanted === "latest:fast") {
    const fast = models.filter((model) => model.fast);
    const id = newest(fast) ?? newest(models);
    if (!id) return { id: null, matched: "none", detail: "the provider listed no models" };
    return fast.length > 0
      ? { id, matched: "latest-fast", detail: null }
      : { id, matched: "latest", detail: "no model is marked as a fast tier; using the newest" };
  }
  if (models.some((model) => model.id === wanted)) return { id: wanted, matched: "exact", detail: null };
  const id = newest(models);
  if (!id)
    return { id: wanted, matched: "none", detail: "the provider list could not be read; using the id as written" };
  return { id, matched: "replaced", detail: `"${wanted}" is no longer listed; using ${id}` };
}

/**
 * The context window for a model, preferring what the provider said.
 *
 * `contextWindowFor` in config.js answers from the pinned table and is kept as
 * the floor. This is the same question asked of the live list first.
 */
export function windowFor(id, catalogue) {
  const found = catalogue?.models?.find((model) => model.id === id);
  return found?.contextWindow ?? contextWindowFor(id);
}
