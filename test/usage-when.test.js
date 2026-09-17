// Reset times: parsing them from either provider, counting down to them, and
// putting them in the machine's own clock.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countdown, localTime, resetPhrase, resetTime } from "../src/usage/when.js";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const at = (ms) => NOW + ms;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A fixed zone and locale, so these assert the formatting rather than the
// machine that happens to run them.
const FIXED = { locale: "en-GB", timeZone: "Asia/Kolkata" };

describe("reading a reset time", () => {
  it("takes the ISO string Anthropic sends and the number Z.ai sends", () => {
    assert.equal(resetTime("2026-09-17T14:20:00.133466+00:00"), Date.parse("2026-09-17T14:20:00.133466Z"));
    assert.equal(resetTime(1_789_653_113_005), 1_789_653_113_005);
  });

  it("returns null for everything that is not one", () => {
    for (const value of [null, undefined, "", "not a date", NaN, {}]) {
      assert.equal(resetTime(value), null, `${JSON.stringify(value)} is not a reset time`);
    }
  });
});

describe("counting down", () => {
  it("uses the unit that carries information at that distance", () => {
    assert.equal(countdown(at(30_000), NOW), "now");
    assert.equal(countdown(at(45 * MINUTE), NOW), "45m");
    assert.equal(countdown(at(2 * HOUR + 8 * MINUTE), NOW), "2h 8m");
    assert.equal(countdown(at(6 * DAY + 7 * HOUR), NOW), "6d 7h");
  });

  it("never says 2h 60m or 6d 24h", () => {
    assert.equal(countdown(at(2 * HOUR - 30_000), NOW), "2h");
    assert.equal(countdown(at(6 * DAY - 30_000), NOW), "6d");
    assert.equal(countdown(at(3 * HOUR), NOW), "3h");
  });

  it("says nothing about a reset already past", () => {
    assert.equal(countdown(at(-HOUR), NOW), "");
    assert.equal(countdown(null, NOW), "");
  });
});

describe("the local clock", () => {
  it("converts UTC to the reader's zone", () => {
    // 14:20Z is 19:50 in Kolkata, which is the whole point of converting.
    assert.equal(localTime(Date.parse("2026-09-17T14:20:00Z"), NOW, FIXED), "19:50");
  });

  it("adds the day once the reset is not today", () => {
    // 19:00Z on Wednesday is 00:30 on Thursday in Kolkata: the day has to come
    // from the converted time, not from the UTC one.
    assert.equal(localTime(Date.parse("2026-09-23T19:00:00Z"), NOW, FIXED), "Thu 24 Sept, 00:30");
  });

  it("is empty when there is no time to show", () => {
    assert.equal(localTime(null, NOW, FIXED), "");
  });
});

describe("the phrase a line shows", () => {
  it("carries both forms, because one answers 'how long' and the other 'when'", () => {
    assert.equal(resetPhrase(Date.parse("2026-09-17T14:20:00Z"), NOW, FIXED), "resets in 2h 20m (19:50)");
  });

  it("drops the clock for a reset that is upon us, and says nothing for a past one", () => {
    assert.equal(resetPhrase(at(10_000), NOW, FIXED), "resets now");
    assert.equal(resetPhrase(at(-HOUR), NOW, FIXED), "");
  });
});
