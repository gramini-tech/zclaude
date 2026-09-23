// Waiting for an account to come back, with an injected clock.
//
// The clock is injected because these are the two behaviours most worth testing
// and the two that would otherwise make the suite take four minutes. It also
// lets the test assert the *sequence* of attempts, which a real timer never
// could.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CEILING_MS, errorBody, holdFor } from "../src/router/hold.js";

/** A clock that only moves when the code under test waits. */
function fakeClock(start = 1_800_000_000_000) {
  let at = start;
  const waits = [];
  return {
    now: () => at,
    waits,
    waitImpl: async (ms) => {
      waits.push(ms);
      at += ms;
    },
  };
}

describe("holding for an account", () => {
  it("returns the moment something becomes available", async () => {
    const clock = fakeClock();
    let calls = 0;
    const held = await holdFor({
      tryChoose: async () => {
        calls += 1;
        return { target: calls >= 3 ? { name: "work" } : null };
      },
      ceilingMs: 240_000,
      pollMs: 5000,
      ...clock,
    });
    assert.equal(held.outcome, "served");
    assert.equal(held.target.name, "work");
    assert.equal(held.attempts, 3);
    assert.equal(held.waitedMs, 15_000, "three polls at five seconds");
  });

  it("gives up at the ceiling with a real retry-after", async () => {
    // Not an SSE error event: a keep-alive comment would require the response
    // to have started, and after a 200 there is no 429 left to send.
    const clock = fakeClock();
    const held = await holdFor({
      tryChoose: async () => ({ target: null }),
      ceilingMs: 60_000,
      pollMs: 5000,
      soonestResetMs: 900_000,
      ...clock,
    });
    assert.equal(held.outcome, "gave-up");
    assert.equal(held.waitedMs, 60_000);
    assert.equal(held.retryAfterMs, 900_000, "the soonest reset, when we know it");
    assert.equal(clock.waits.length, 12);
  });

  it("never sleeps past the ceiling", async () => {
    // A poll that overshoots turns a 240s hold into a 245s one, which is the
    // wrong side of Claude Code's 300s stream watchdog.
    const clock = fakeClock();
    const held = await holdFor({
      tryChoose: async () => ({ target: null }),
      ceilingMs: 7000,
      pollMs: 5000,
      ...clock,
    });
    assert.deepEqual(clock.waits, [5000, 2000]);
    assert.equal(held.waitedMs, 7000);
  });

  it("is clamped to the ceiling the client can actually wait for", async () => {
    const clock = fakeClock();
    const held = await holdFor({
      tryChoose: async () => ({ target: null }),
      ceilingMs: 3_600_000,
      pollMs: 60_000,
      ...clock,
    });
    assert.equal(held.waitedMs, CEILING_MS, "no config can ask for longer than the client will wait");
  });

  it("gives up at once when holding is switched off", async () => {
    const clock = fakeClock();
    let calls = 0;
    const held = await holdFor({
      tryChoose: async () => {
        calls += 1;
        return { target: null };
      },
      ceilingMs: 0,
      ...clock,
    });
    assert.equal(held.outcome, "gave-up");
    assert.equal(held.attempts, 0);
    assert.equal(calls, 0, "nothing is even asked");
    assert.equal(held.retryAfterMs, 60_000, "and a sensible default is offered");
  });

  it("stops when the client goes away", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const held = await holdFor({
      tryChoose: async () => {
        controller.abort();
        return { target: null };
      },
      ceilingMs: 240_000,
      pollMs: 5000,
      signal: controller.signal,
      ...clock,
    });
    assert.equal(held.outcome, "aborted");
    assert.equal(held.retryAfterMs, null, "there is nobody left to tell");
  });

  it("does not start at all when the client has already gone", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const held = await holdFor({
      tryChoose: async () => {
        calls += 1;
        return { target: null };
      },
      ceilingMs: 240_000,
      signal: controller.signal,
      ...clock,
    });
    assert.equal(held.outcome, "aborted");
    assert.equal(calls, 0);
  });
});

describe("the error the client gets", () => {
  it("is the envelope Claude Code knows how to read", () => {
    const body = JSON.parse(errorBody("rate_limit_error", "every account is spent"));
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "rate_limit_error");
    assert.equal(body.error.message, "every account is spent");
  });
});
