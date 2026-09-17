// How much of an Anthropic account's quota is gone, and the token refresh that
// keeps that question answerable.
//
// The usage endpoint takes the same OAuth access token Claude Code uses and
// answers without touching the account's model quota — it budgets *requests*
// instead, so a 429 here means "you asked too often", not "you are out of
// Claude". That is why every answer is cached and a Retry-After is obeyed.
//
// Windows come back in two shapes. `five_hour` and `seven_day` are the classic
// pair. Per-model weekly limits (Fable is metered separately from the rest)
// arrive in a `limits` array, each entry naming its model, so they are read
// from there rather than guessed.

import { request } from "../http.js";
import { log } from "../logger.js";
import { registerSecret } from "../redact.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client. A refresh grant is bound to the client it
// was issued for, so this is not ours to choose.
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 6000;
/** Refresh a little before expiry: a token that dies mid-request is a failure. */
export const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(String(raw).trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * Ask the usage endpoint. Returns a tagged result rather than throwing, because
 * every caller here shows a row either way.
 * @param {string} accessToken
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<{state: string, data?: object, retryAfterMs?: number, detail?: string}>}
 */
export async function fetchUsage(accessToken, { fetchImpl, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await request({
      url: USAGE_URL,
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": BETA_HEADER },
      timeoutMs,
      fetchImpl,
      signal,
    });
  } catch (error) {
    log.debug("usage", "usage request failed", { error });
    return { state: "offline", detail: error?.message };
  }
  if (response.ok && response.json) return { state: "ok", data: response.json };
  if (response.status === 401 || response.status === 403) return { state: "unauthorized" };
  if (response.status === 429) return { state: "throttled", retryAfterMs: retryAfterMs(response.headers) ?? 60_000 };
  return { state: "error", detail: `HTTP ${response.status}` };
}

function windowFrom(raw) {
  const pct = Number(raw?.utilization);
  if (!Number.isFinite(pct)) return null;
  return { pct, resetsAt: typeof raw?.resets_at === "string" ? raw.resets_at : null };
}

/**
 * The endpoint's answer in the shape both surfaces render.
 * @param {object} data
 */
export function normaliseUsage(data) {
  const fiveHour = windowFrom(data?.five_hour);
  const weekly = windowFrom(data?.seven_day);
  const scoped = [];
  if (Array.isArray(data?.limits)) {
    for (const limit of data.limits) {
      const name = limit?.scope?.model?.display_name;
      const pct = Number(limit?.percent);
      if (typeof name !== "string" || !Number.isFinite(pct)) continue;
      scoped.push({ name, pct, resetsAt: typeof limit.resets_at === "string" ? limit.resets_at : null });
    }
  }
  if (!fiveHour && !weekly && scoped.length === 0) return null;
  return { fiveHour, weekly, scoped };
}

/** Whether this credential needs a refresh before it can be used. */
export function needsRefresh(blob, now = Date.now()) {
  const expiresAt = Number(blob?.claudeAiOauth?.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return now + EXPIRY_BUFFER_MS >= expiresAt;
}

/**
 * Exchange the refresh token for a new access token.
 *
 * The response may carry a *new* refresh token, and the old one stops working
 * the moment it does. The rotated blob is returned whole so the caller can
 * persist it before anything else happens; dropping it here would strand the
 * account. `invalid_grant` is the server saying this lineage is finished, which
 * is permanent and must not be retried.
 *
 * @param {object} blob the parsed credential
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number, now?: number}} [options]
 * @returns {Promise<{state: "ok"|"dead"|"transient", blob?: object, rotated?: boolean, detail?: string}>}
 */
export async function refreshCredential(blob, { fetchImpl, signal, timeoutMs = 10_000, now = Date.now() } = {}) {
  const oauth = blob?.claudeAiOauth;
  const refreshToken = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : "";
  if (!refreshToken) return { state: "dead", detail: "no refresh token stored" };
  registerSecret(refreshToken);

  let response;
  try {
    response = await request({
      method: "POST",
      url: TOKEN_URL,
      body: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID },
      timeoutMs,
      fetchImpl,
      signal,
    });
  } catch (error) {
    log.warn("usage", "token refresh failed", { error });
    return { state: "transient", detail: error?.message };
  }
  if (!response.ok) return refusal(response);
  const payload = response.json ?? {};
  if (typeof payload.access_token !== "string")
    return { state: "transient", detail: "no access token in the response" };
  const rotated = typeof payload.refresh_token === "string" && payload.refresh_token !== refreshToken;
  const next = applyGrant(oauth, payload, { now, rotated });
  log.info("usage", "token refreshed", { rotated, expiresInS: Number(payload.expires_in) || null });
  return { state: "ok", blob: { ...blob, claudeAiOauth: next }, rotated };
}

/**
 * Permanent only when the server names the grant as the problem. Anything
 * ambiguous stays transient: a wrong "dead" verdict retires a live login.
 * @returns {{state: "dead"|"transient", detail: string}}
 */
function refusal(response) {
  const reason = typeof response.json?.error === "string" ? response.json.error : null;
  if (reason === "invalid_grant" && [400, 401, 403].includes(response.status)) {
    return { state: "dead", detail: reason };
  }
  return { state: "transient", detail: reason ?? `HTTP ${response.status}` };
}

function applyGrant(oauth, payload, { now, rotated }) {
  registerSecret(payload.access_token);
  if (rotated) registerSecret(payload.refresh_token);
  const expiresIn = Number(payload.expires_in);
  return {
    ...oauth,
    accessToken: payload.access_token,
    ...(Number.isFinite(expiresIn) && { expiresAt: now + expiresIn * 1000 }),
    ...(rotated && { refreshToken: payload.refresh_token }),
    ...(typeof payload.scope === "string" && { scopes: payload.scope.split(" ") }),
  };
}
