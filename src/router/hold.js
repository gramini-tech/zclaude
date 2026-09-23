// Waiting for an account to come back, rather than failing at 2am.
//
// When every target in a class's chain is spent, there are three honest things
// to do and this picks between two of them. It can fail immediately with the
// upstream's own 429, which is what a proxy without this file does. Or it can
// keep the request open until a window resets, which is what lets an unattended
// run finish on its own.
//
// It cannot do both at once, and that is worth stating because the obvious
// design tries to. "Hold with SSE keep-alives, then return a 429" is
// impossible: a keep-alive comment requires the response to have started, and
// once a 200 is on the wire there is no 429 left to send, only an in-stream
// error event that Claude Code handles less well than a real status code.
//
// So the default is a silent hold. Nothing is written, the chain is re-checked
// every few seconds, and on expiry a genuine 429 goes back with a computed
// retry-after for Claude Code's own backoff to use. The ceiling is 240s, which
// sits inside the 300s byte-level watchdog Claude Code runs on a gateway
// connection and its five-minute body idle timeout. A longer wait is not a
// longer wait; it is a request the client has already abandoned.
//
// Polling rather than sleeping until one reset time, because more than one
// thing can end a hold: a window resets, a burst clears, or another terminal's
// request finishes and frees an account that was merely busy.

import { log } from "../logger.js";

/** Never longer than this, whatever the config says. See config.js. */
export const CEILING_MS = 240_000;

const wait = (ms, waitImpl) =>
  waitImpl
    ? waitImpl(ms)
    : new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

/**
 * @typedef {object} HoldResult
 * @property {"served" | "gave-up" | "aborted"} outcome
 * @property {object | null} target what became available, when one did
 * @property {number} waitedMs
 * @property {number} attempts
 * @property {number | null} retryAfterMs what to tell the client, on giving up
 */

/**
 * Wait for something in the chain to become available.
 *
 * @param {{tryChoose: () => Promise<{target: object|null}>, ceilingMs?: number, pollMs?: number, now?: () => number, waitImpl?: (ms: number) => Promise<void>, signal?: AbortSignal, soonestResetMs?: number | null}} args
 * @returns {Promise<HoldResult>}
 */
export async function holdFor({
  tryChoose,
  ceilingMs = CEILING_MS,
  pollMs = 5000,
  now = Date.now,
  waitImpl,
  signal,
  soonestResetMs = null,
}) {
  const started = now();
  const ceiling = Math.max(0, Math.min(ceilingMs, CEILING_MS));
  let attempts = 0;

  const giveUp = () => ({
    outcome: /** @type {const} */ ("gave-up"),
    target: null,
    waitedMs: now() - started,
    attempts,
    // What the client is told to wait. The soonest reset is the honest number
    // when we have one; otherwise a minute, which is short enough to retry and
    // long enough not to hammer.
    retryAfterMs: soonestResetMs ?? 60_000,
  });

  if (ceiling === 0) return giveUp();

  for (;;) {
    if (signal?.aborted) {
      return { outcome: "aborted", target: null, waitedMs: now() - started, attempts, retryAfterMs: null };
    }
    const elapsed = now() - started;
    if (elapsed >= ceiling) {
      log.info("router", "gave up holding", { waitedMs: elapsed, attempts });
      return giveUp();
    }
    // Never sleep past the ceiling: a poll that overshoots turns a 240s hold
    // into a 245s one, which is the side of the watchdog we must not be on.
    await wait(Math.min(pollMs, ceiling - elapsed), waitImpl);
    attempts += 1;
    if (signal?.aborted) {
      return { outcome: "aborted", target: null, waitedMs: now() - started, attempts, retryAfterMs: null };
    }
    const chosen = await tryChoose();
    if (chosen?.target) {
      log.info("router", "a target came back", { waitedMs: now() - started, attempts });
      return { outcome: "served", target: chosen.target, waitedMs: now() - started, attempts, retryAfterMs: null };
    }
  }
}

/**
 * The Anthropic error envelope, which is what Claude Code knows how to read.
 *
 * Returned rather than thrown: the client gets a shape it recognises whatever
 * went wrong on this side, and its own retry logic does the right thing with a
 * real 429 and a real retry-after.
 */
export function errorBody(type, message) {
  return JSON.stringify({ type: "error", error: { type, message } });
}
