// What to do about an upstream that did not simply answer.
//
// A pure function of a status, some headers and a body, because this is the
// part most worth testing and least worth reasoning about at three in the
// morning. Every branch is a row in the table in test/router-retry.test.js.
//
// The distinction that earns its keep is between two kinds of 429. A *quota*
// 429 means this account's window is spent, and the answer is another account.
// A *burst* 429 means too many requests in a minute, and the answer is to wait
// a moment on the same account: rotating there throws away a warm prompt cache,
// which on an agentic turn is most of the input tokens, to dodge a two-second
// pause. claude-rotate found this the expensive way and it is the single most
// valuable thing to copy from prior art.
//
// One rule constrains everything: none of this can run once a byte has reached
// the client. Failover mid-stream is impossible, so every decision here is made
// before the response is committed, and the caller enforces that by calling
// `res.writeHead` in exactly one place.

/**
 * Anthropic's undocumented quota headers, present on subscription traffic.
 * Read rather than relied on: everything here works without them, and works
 * better with them.
 */
export const QUOTA_HEADERS = Object.freeze({
  fiveHour: "anthropic-ratelimit-unified-5h-utilization",
  weekly: "anthropic-ratelimit-unified-7d-utilization",
  reset: "anthropic-ratelimit-unified-5h-reset",
  status: "anthropic-ratelimit-unified-status",
});

/** Statuses worth one retry against the same account before moving on. */
const TRANSIENT = new Set([500, 502, 503, 504, 529]);

const header = (headers, name) => headers?.get?.(name) ?? null;

/** `retry-after` in milliseconds: seconds, or an HTTP date. */
export function retryAfterMs(headers, now = Date.now()) {
  const raw = header(headers, "retry-after");
  if (!raw) return null;
  const seconds = Number(String(raw).trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * A numeric header, or null when it was not sent.
 *
 * `Number(null)` is 0, which would turn "the provider said nothing" into a
 * confident "nothing is used": every 429 would then read as a burst and every
 * account would look empty. Only an actual numeric header counts as a number.
 * `usage/index.js` carries the same note for the same reason.
 */
function numeric(headers, name) {
  const raw = header(headers, name);
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The utilization the headers report, as a percentage, or null. */
function utilization(headers, which) {
  return numeric(headers, QUOTA_HEADERS[which]);
}

/** The reset header as epoch seconds, or null when it was not sent. */
function resetSeconds(headers) {
  const value = numeric(headers, QUOTA_HEADERS.reset);
  return value !== null && value > 0 ? value : null;
}

/**
 * Is this 429 the window being spent, or merely too many requests at once?
 *
 * Four signals, strongest first. The last is a guess and is marked as one: with
 * no headers and no retry-after there is nothing to go on, and the safer guess
 * is burst, because pacing once costs a second and rotating costs a cache.
 */
export function classifyThrottle(headers, bodyText, { quotaThresholdMs = 60_000, now = Date.now() } = {}) {
  const status = header(headers, QUOTA_HEADERS.status);
  if (typeof status === "string" && /reject|exhaust|exceed/iu.test(status)) return { kind: "quota", why: status };
  const fiveHour = utilization(headers, "fiveHour");
  const weekly = utilization(headers, "weekly");
  if (fiveHour !== null && fiveHour >= 100) return { kind: "quota", why: "the five-hour window is spent" };
  if (weekly !== null && weekly >= 100) return { kind: "quota", why: "the weekly window is spent" };
  // A long retry-after is a window reset, not a pause between requests.
  const wait = retryAfterMs(headers, now);
  if (wait !== null && wait > quotaThresholdMs)
    return { kind: "quota", why: `retry-after is ${Math.round(wait / 1000)}s` };
  if (/usage limit|quota|resets at/iu.test(String(bodyText ?? "")))
    return { kind: "quota", why: "the body names a limit" };
  if (wait !== null) return { kind: "burst", why: `retry-after is ${Math.round(wait / 1000)}s` };
  // Utilization well under the ceiling with a 429 is the shape of a burst.
  if (fiveHour !== null && fiveHour < 95) return { kind: "burst", why: "the window still has room" };
  return { kind: "burst", why: "nothing said which, and pacing is the cheaper guess", guessed: true };
}

/**
 * @typedef {object} Decision
 * @property {"serve" | "retry-same" | "next-target" | "surface"} action
 * @property {number} waitMs how long to wait before the retry, when retrying
 * @property {boolean} penalise whether to take this account out of rotation
 * @property {number | null} penaltyMs for how long
 * @property {string} why one line, for the log and for the client
 */

/**
 * What to do with an upstream response, before any of it reaches the client.
 *
 * @param {{status: number, headers?: Headers, bodyText?: string, error?: Error, attempt?: number, sameTargetAttempts?: number, burst?: {maxAttempts: number, maxWaitMs: number, quotaThresholdMs: number}, now?: number}} input
 * @returns {Decision}
 */
export function classifyFailure({
  status,
  headers,
  bodyText,
  error,
  sameTargetAttempts = 0,
  burst = { maxAttempts: 2, maxWaitMs: 10_000, quotaThresholdMs: 60_000 },
  now = Date.now(),
}) {
  /** @type {(action: Decision["action"], extra?: Partial<Decision>) => Decision} */
  const decide = (action, extra = {}) => ({ action, waitMs: 0, penalise: false, penaltyMs: null, why: "", ...extra });

  // Could not reach the upstream at all. One retry against the same target
  // covers a reset connection; past that it is somebody else's turn.
  if (error) {
    return sameTargetAttempts < 1
      ? decide("retry-same", { waitMs: 250, why: `could not be reached (${error.message})` })
      : decide("next-target", { why: `could not be reached (${error.message})` });
  }

  if (status >= 200 && status < 300) return decide("serve", { why: "answered" });

  // The token died between being read and being used, which is expected rather
  // than exceptional: the router spends the last minutes of a token it is not
  // allowed to refresh. Re-read and try once; a second refusal is the account's.
  if (status === 401 || status === 403) {
    return sameTargetAttempts < 1
      ? decide("retry-same", { why: "the upstream refused the token; re-reading it once" })
      : decide("next-target", {
          penalise: true,
          penaltyMs: 10 * 60_000,
          why: "the upstream refused the token twice",
        });
  }

  if (status === 429) {
    const throttle = classifyThrottle(headers, bodyText, { quotaThresholdMs: burst.quotaThresholdMs, now });
    if (throttle.kind === "quota") {
      const reset = resetSeconds(headers);
      const until = reset === null ? retryAfterMs(headers, now) : Math.max(0, reset * 1000 - now);
      return decide("next-target", {
        penalise: true,
        penaltyMs: until ?? 5 * 60_000,
        why: `quota exhausted: ${throttle.why}`,
      });
    }
    if (sameTargetAttempts < burst.maxAttempts) {
      const wait = Math.min(retryAfterMs(headers, now) ?? 1000, burst.maxWaitMs);
      return decide("retry-same", { waitMs: wait, why: `paced: ${throttle.why}` });
    }
    // Paced as long as we said we would and it is still refusing, so treat the
    // account as spent after all rather than pacing forever.
    return decide("next-target", { penalise: true, penaltyMs: 60_000, why: "still throttled after pacing" });
  }

  if (TRANSIENT.has(status)) {
    return sameTargetAttempts < 1
      ? decide("retry-same", { waitMs: 250 + Math.round(Math.random() * 500), why: `upstream returned ${status}` })
      : decide("next-target", { why: `upstream returned ${status}` });
  }

  // A 4xx that is not about us — a malformed body, an unknown model — belongs
  // to the client. Retrying it elsewhere would turn one clear error into three.
  return decide("surface", { why: `upstream returned ${status}` });
}

/**
 * The quota headers as the usage cache understands them.
 *
 * Free telemetry: these arrive on every subscription response, so the usage
 * endpoint becomes a fallback rather than the only source. Returns null when
 * the provider said nothing, which is what a non-subscription upstream does.
 */
export function readQuotaHeaders(headers, now = Date.now()) {
  const fiveHour = utilization(headers, "fiveHour");
  const weekly = utilization(headers, "weekly");
  if (fiveHour === null && weekly === null) return null;
  const reset = resetSeconds(headers);
  const resetsAt = reset === null ? null : new Date(reset * 1000).toISOString();
  return {
    fiveHour: fiveHour === null ? null : { pct: fiveHour, resetsAt },
    weekly: weekly === null ? null : { pct: weekly, resetsAt: null },
    status: header(headers, QUOTA_HEADERS.status),
    fetchedAt: now,
  };
}
