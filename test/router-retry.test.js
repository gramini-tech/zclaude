// The failure taxonomy, one row per decision.
//
// This file is the taxonomy. Every branch of `classifyFailure` has a case here
// with the reason it exists, because the cost of getting one wrong is paid at
// three in the morning by somebody whose account went quiet.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyFailure,
  classifyThrottle,
  QUOTA_HEADERS,
  readQuotaHeaders,
  retryAfterMs,
} from "../src/router/retry.js";

const NOW = 1_800_000_000_000;
const BURST = { maxAttempts: 2, maxWaitMs: 10_000, quotaThresholdMs: 60_000 };

const headers = (entries = {}) => new Headers(entries);
const RESET_SECONDS = Math.floor(NOW / 1000) + 1800;
const quota = (extra = {}) => {
  const base = { [QUOTA_HEADERS.fiveHour]: "100", [QUOTA_HEADERS.status]: "rejected" };
  return headers({ ...base, [QUOTA_HEADERS.reset]: String(RESET_SECONDS), ...extra });
};

describe("retry-after in every shape it arrives in", () => {
  it("reads seconds, an HTTP date, and nothing at all", () => {
    assert.equal(retryAfterMs(headers({ "retry-after": "2" }), NOW), 2000);
    assert.equal(retryAfterMs(headers({ "retry-after": "0" }), NOW), 0);
    const soon = new Date(NOW + 5000).toUTCString();
    assert.equal(retryAfterMs(headers({ "retry-after": soon }), NOW), 5000);
    assert.equal(retryAfterMs(headers({}), NOW), null);
    assert.equal(retryAfterMs(headers({ "retry-after": "soon" }), NOW), null);
  });

  it("never reports a negative wait for a date already past", () => {
    const past = new Date(NOW - 5000).toUTCString();
    assert.equal(retryAfterMs(headers({ "retry-after": past }), NOW), 0);
  });
});

describe("telling the two kinds of 429 apart", () => {
  // The distinction that earns its keep. Rotating on a burst throws away a warm
  // prompt cache, most of an agentic turn's input tokens, to dodge a short wait.
  it("calls it quota when the provider says the window is rejected", () => {
    assert.equal(classifyThrottle(quota(), "", { now: NOW }).kind, "quota");
  });

  it("calls it quota when a window reads full, even without a status", () => {
    const spent = headers({ [QUOTA_HEADERS.fiveHour]: "100" });
    assert.equal(classifyThrottle(spent, "", { now: NOW }).kind, "quota");
    const weekly = headers({ [QUOTA_HEADERS.weekly]: "100" });
    assert.equal(classifyThrottle(weekly, "", { now: NOW }).kind, "quota");
  });

  it("calls a long retry-after quota, because that is a window resetting", () => {
    const long = headers({ "retry-after": "1800" });
    assert.equal(classifyThrottle(long, "", { quotaThresholdMs: 60_000, now: NOW }).kind, "quota");
  });

  it("calls a short retry-after burst, and keeps the same account", () => {
    const short = headers({ "retry-after": "2", [QUOTA_HEADERS.fiveHour]: "31" });
    assert.equal(classifyThrottle(short, "", { quotaThresholdMs: 60_000, now: NOW }).kind, "burst");
  });

  it("reads a body that names a limit, for an upstream with no headers", () => {
    assert.equal(classifyThrottle(headers({}), "you have hit your usage limit", { now: NOW }).kind, "quota");
  });

  it("guesses burst when nothing said which, and marks the guess", () => {
    const blind = classifyThrottle(headers({}), "", { now: NOW });
    assert.equal(blind.kind, "burst");
    assert.equal(blind.guessed, true, "pacing once costs a second; rotating costs a cache");
  });
});

describe("what to do with an upstream response", () => {
  const decide = (input) => classifyFailure({ burst: BURST, now: NOW, ...input });

  it("serves a 2xx", () => {
    assert.equal(decide({ status: 200 }).action, "serve");
    assert.equal(decide({ status: 204 }).action, "serve");
  });

  it("re-reads the token once on a 401, then gives up on the account", () => {
    // Expected rather than exceptional: the router spends the last minutes of a
    // token it is not allowed to refresh, so a 401 mid-flight is normal.
    const first = decide({ status: 401, sameTargetAttempts: 0 });
    assert.equal(first.action, "retry-same");
    assert.equal(first.penalise, false, "one refusal is not an account being broken");

    const second = decide({ status: 401, sameTargetAttempts: 1 });
    assert.equal(second.action, "next-target");
    assert.equal(second.penalise, true);
    assert.equal(second.penaltyMs, 10 * 60_000, "soft, and never permanent");
  });

  it("rotates on a quota 429 and sits the account out until its window resets", () => {
    const spent = decide({ status: 429, headers: quota() });
    assert.equal(spent.action, "next-target");
    assert.equal(spent.penalise, true);
    assert.equal(spent.penaltyMs, 1_800_000, "taken from the provider's own reset, not a guess");
    assert.match(spent.why, /quota exhausted/u);
  });

  it("paces a burst 429 on the same account, and never rotates for one", () => {
    const paced = decide({ status: 429, headers: headers({ "retry-after": "2" }), sameTargetAttempts: 0 });
    assert.equal(paced.action, "retry-same");
    assert.equal(paced.waitMs, 2000);
    assert.equal(paced.penalise, false);
  });

  it("caps how long a burst can make us wait", () => {
    const capped = decide({
      status: 429,
      headers: headers({ "retry-after": "45", [QUOTA_HEADERS.fiveHour]: "20" }),
      sameTargetAttempts: 0,
    });
    // 45s reads as quota against the default threshold, so this asserts the cap
    // with a threshold that keeps it a burst.
    const stillBurst = classifyFailure({
      status: 429,
      headers: headers({ "retry-after": "45", [QUOTA_HEADERS.fiveHour]: "20" }),
      sameTargetAttempts: 0,
      burst: { ...BURST, quotaThresholdMs: 60_000, maxWaitMs: 10_000 },
      now: NOW,
    });
    assert.equal(capped.action, "retry-same");
    assert.equal(stillBurst.waitMs, 10_000, "never longer than the cap, whatever the header asked for");
  });

  it("stops pacing after the configured attempts and treats it as spent", () => {
    const done = decide({ status: 429, headers: headers({ "retry-after": "2" }), sameTargetAttempts: 2 });
    assert.equal(done.action, "next-target");
    assert.equal(done.penalise, true);
    assert.match(done.why, /still throttled after pacing/u);
  });

  it("retries a 5xx once on the same account, then moves on", () => {
    for (const status of [500, 502, 503, 504, 529]) {
      assert.equal(decide({ status, sameTargetAttempts: 0 }).action, "retry-same", String(status));
      const second = decide({ status, sameTargetAttempts: 1 });
      assert.equal(second.action, "next-target", String(status));
      assert.equal(second.penalise, false, "a 529 is the provider's weather, not the account's");
    }
  });

  it("retries a network failure once, then moves on", () => {
    const error = new Error("ECONNRESET");
    assert.equal(decide({ status: 0, error, sameTargetAttempts: 0 }).action, "retry-same");
    assert.equal(decide({ status: 0, error, sameTargetAttempts: 1 }).action, "next-target");
  });

  it("gives a plain 4xx straight back, because it belongs to the client", () => {
    // A malformed body or an unknown model is not fixed by asking another
    // account; retrying would turn one clear error into three confusing ones.
    for (const status of [400, 404, 413, 422]) {
      const surfaced = decide({ status });
      assert.equal(surfaced.action, "surface", String(status));
      assert.equal(surfaced.penalise, false);
    }
  });
});

describe("the quota headers as free telemetry", () => {
  it("reads the windows and the reset into the shape the usage cache uses", () => {
    const read = readQuotaHeaders(quota({ [QUOTA_HEADERS.weekly]: "62" }), NOW);
    assert.equal(read.fiveHour.pct, 100);
    assert.equal(read.weekly.pct, 62);
    assert.equal(read.fiveHour.resetsAt, new Date(RESET_SECONDS * 1000).toISOString());
    assert.equal(read.status, "rejected");
  });

  it("says nothing when the provider said nothing", () => {
    // A non-subscription upstream sends none of these, and inventing a zero
    // would tell the picker an account is empty when it is unknown.
    assert.equal(readQuotaHeaders(headers({}), NOW), null);
    assert.equal(readQuotaHeaders(headers({ "retry-after": "2" }), NOW), null);
  });

  it("reports one window when only one was sent", () => {
    const partial = readQuotaHeaders(headers({ [QUOTA_HEADERS.fiveHour]: "12" }), NOW);
    assert.equal(partial.fiveHour.pct, 12);
    assert.equal(partial.weekly, null);
    assert.equal(partial.fiveHour.resetsAt, null);
  });
});
