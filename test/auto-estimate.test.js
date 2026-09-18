// The estimator: anchoring on the endpoint, interpolating on local cost, and
// being honest about how wrong it might be.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  anchorAt,
  MARGIN_MAX,
  MARGIN_MIN,
  marginFor,
  MIN_STEP_COST,
  MIN_STEP_PCT,
  missed,
  observe,
  planWeight,
  predict,
  untrusted,
} from "../src/auto/estimate.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

describe("plan size", () => {
  it("reads the tier Anthropic names, from the credential or the identity", () => {
    assert.deepEqual(planWeight({ rateLimitTier: "default_claude_max_20x" }), {
      weight: 20,
      tier: "default_claude_max_20x",
      known: true,
    });
    assert.equal(planWeight({ tier: "default_claude_max_5x" }).weight, 5);
  });

  it("treats an unknown plan as the smallest there is", () => {
    // Over-estimating a seat routes long work onto a small account and costs a
    // second rotation. Under-estimating only costs spread quality.
    const unknown = planWeight({ rateLimitTier: "default_raven" });
    assert.equal(unknown.weight, 1);
    assert.equal(unknown.known, false);
    assert.equal(planWeight({}).weight, 1);
  });

  it("falls back to the subscription type, which cannot tell 5x from 20x", () => {
    const team = planWeight({ subscriptionType: "team" });
    assert.equal(team.weight, 1.25);
    assert.equal(team.known, false, "a floor, never an answer");
  });
});

describe("predicting how full a window is", () => {
  it("has no opinion before it has learned anything, and says so", () => {
    const anchor = anchorAt({ pct: 10, at: NOW, cost: 0 });
    const guess = predict(anchor, { cost: 5_000_000, now: NOW + 10 * MINUTE });
    assert.equal(guess.pct, 10, "with no factor there is nothing to add");
    assert.equal(guess.confident, false);
    assert.equal(guess.margin, MARGIN_MAX, "and the guard band is as wide as it goes");
  });

  it("interpolates on local cost once it has a factor", () => {
    const anchor = { ...anchorAt({ pct: 20, at: NOW, cost: 0 }), factor: 1e-6 };
    assert.equal(predict(anchor, { cost: 10_000_000, now: NOW }).pct, 30);
  });

  it("never goes down, and never past 100", () => {
    const anchor = { ...anchorAt({ pct: 40, at: NOW, cost: 1_000_000 }), factor: 1e-6 };
    // A cost counter that went backwards is a bug somewhere; an estimate that
    // followed it down would eventually report room on a spent account.
    assert.equal(predict(anchor, { cost: 0, now: NOW }).pct, 40);
    assert.equal(predict(anchor, { cost: 900_000_000, now: NOW }).pct, 100);
  });
});

describe("folding in what the endpoint says", () => {
  it("learns the factor from a step large enough to mean something", () => {
    const anchor = anchorAt({ pct: 10, at: NOW, cost: 0 });
    const next = observe(anchor, { pct: 20, at: NOW + MINUTE, cost: 10_000_000 });
    assert.equal(next.pct, 20, "the endpoint always wins");
    assert.equal(next.factor, 1e-6);
  });

  it("refuses a step too small to divide by", () => {
    // The endpoint reports whole points, so a one-point step carries ±50%
    // quantisation error and a factor learned from it would be noise.
    const anchor = anchorAt({ pct: 10, at: NOW, cost: 0 });
    const tiny = observe(anchor, { pct: 10 + MIN_STEP_PCT - 1, at: NOW + MINUTE, cost: 10_000_000 });
    assert.equal(tiny.factor, null);
    const cheap = observe(anchor, { pct: 50, at: NOW + MINUTE, cost: MIN_STEP_COST - 1 });
    assert.equal(cheap.factor, null, "and neither is a large jump on almost no tokens");
  });

  it("learns a shadow rate for spend it cannot see", () => {
    // A plain `claude`, the desktop app, another machine, claude.ai. We will
    // never attribute it; the point is to stop being surprised by it.
    let anchor = { ...anchorAt({ pct: 0, at: NOW, cost: 0 }), factor: 1e-6 };
    anchor = observe(anchor, { pct: 30, at: NOW + 10 * MINUTE, cost: 0 });
    assert.ok(anchor.shadow > 0, "usage moved with no local tokens at all");
    const ahead = predict(anchor, { cost: 0, now: anchor.at + 10 * MINUTE });
    assert.ok(ahead.pct > anchor.pct, "so the next ten quiet minutes are expected to cost something");
  });

  it("widens its own margin when it has been wrong, and again for a poll it missed", () => {
    let anchor = { ...anchorAt({ pct: 0, at: NOW, cost: 0 }), factor: 1e-6 };
    const tight = marginFor(anchor);
    assert.equal(tight, MARGIN_MIN);
    anchor = observe(anchor, { pct: 40, at: NOW + MINUTE, cost: 1_000_000 });
    assert.ok(marginFor(anchor) > tight, "a bad prediction buys a wider guard band");
    const blind = missed(missed(anchor));
    assert.ok(marginFor(blind) > marginFor(anchor), "so does going two polls without an answer");
    assert.equal(missed(null), null);
  });

  it("resets the anchor on a window reset, keeping what it learned", () => {
    const anchor = { ...anchorAt({ pct: 96, at: NOW, cost: 5_000_000 }), factor: 3e-6 };
    const fresh = observe(anchor, { pct: 0, at: NOW + 60 * MINUTE, cost: 9_000_000, reset: true });
    assert.equal(fresh.pct, 0);
    assert.equal(fresh.cost, 9_000_000, "the counter is re-anchored, not rewound");
    assert.equal(fresh.factor, 3e-6, "a reset is not a reason to forget the burn rate");
  });

  it("declares itself untrusted rather than driving decisions off a broken meter", () => {
    const wrong = { ...anchorAt({ pct: 0, at: NOW, cost: 0 }), factor: 1e-6, error: 25 };
    assert.equal(untrusted(wrong), true);
    assert.equal(untrusted({ ...wrong, error: 1 }), false);
    assert.equal(untrusted(null), false);
  });
});
