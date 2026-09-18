// The rotation policy, driven from synthetic timelines.
//
// Everything in `src/auto/policy.js` is a pure function of a snapshot, which is
// the whole reason it is shaped that way: these decisions are what the feature
// is, and once a daemon is running they are the hardest thing about it to
// observe. Here they are just return values.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  binding,
  bindingWindows,
  capacity,
  decide,
  eligibility,
  LADDER,
  ladderStep,
  parkTarget,
  rank,
  rotatable,
} from "../src/auto/policy.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const iso = (at) => new Date(at).toISOString();

/** An Anthropic account with everything healthy unless said otherwise. */
function account(name, over = {}) {
  const { fiveHour = 0, weekly = 0, fable = null, resetsAt = NOW + 3 * HOUR, ...rest } = over;
  return {
    name,
    accountUuid: `uuid-${name}`,
    organizationUuid: "org-1",
    provider: "anthropic",
    registered: true,
    state: "ok",
    weight: 5,
    windows: {
      fiveHour: { pct: fiveHour, resetsAt: fiveHour === 0 ? null : resetsAt },
      weekly: { pct: weekly, resetsAt: iso(NOW + 4 * 24 * HOUR) },
      scoped: fable === null ? [] : [{ name: "Fable", pct: fable, resetsAt: iso(NOW + 4 * 24 * HOUR) }],
    },
    ...rest,
  };
}

describe("what constrains a class", () => {
  it("binds Fable on its own ceiling as well as the two everybody has", () => {
    const one = account("a", { fable: 100 });
    assert.deepEqual(
      bindingWindows(one, "fable").map((entry) => entry.key),
      ["fiveHour", "weekly", "Fable"],
    );
    // Hitting the 5-hour or the weekly limit blocks every prompt whatever the
    // model, so Opus binds on two windows and never on Fable's.
    assert.deepEqual(
      bindingWindows(one, "opus").map((entry) => entry.key),
      ["fiveHour", "weekly"],
    );
  });

  it("takes the worst window, and trusts a critical severity over its own number", () => {
    const mixed = account("a", { fiveHour: 10, weekly: 70 });
    assert.equal(binding(mixed, "opus", { now: NOW }).window, "weekly");
    const lying = account("b", { fiveHour: 3 });
    lying.windows.fiveHour.severity = "critical";
    assert.equal(binding(lying, "opus", { now: NOW }).pct, 99, "the provider has already said it is spent");
  });
});

describe("eligibility", () => {
  it("refuses a Z.ai profile as a target while leaving it visible", () => {
    const zai = account("chinese", { provider: "zai" });
    const said = rotatable(zai);
    assert.equal(said.ok, false);
    assert.match(said.reason, /endpoint and a key/u);
  });

  it("refuses a login that is expired, quarantined or signed out", () => {
    assert.equal(rotatable(account("a", { state: "dead" })).ok, false);
    assert.equal(rotatable(account("a", { state: "unauthorized" })).ok, false);
    assert.equal(rotatable(account("a", { refreshExpired: true })).ok, false);
    assert.equal(rotatable(account("a", { quarantined: true })).ok, false);
    assert.equal(rotatable(account("a", { registered: false })).ok, false);
  });

  it("refuses to cross organisations unless told it may", () => {
    const other = account("work", { organizationUuid: "org-2" });
    assert.equal(rotatable(other, { org: "org-1" }).ok, false);
    assert.equal(rotatable(other, { org: "org-1", allowCrossOrg: true }).ok, true);
  });

  it("treats a stale reading as the numbers it has, never as an empty account", () => {
    // The trap this is here for: a fetch fails, the cache keeps serving the last
    // good numbers, and a naive ranking reads a dead account as 0% used and
    // sends every new task to it.
    const stale = account("old", { state: "stale", weekly: 96 });
    assert.equal(eligibility(stale, "opus", { now: NOW }).ok, false);
  });
});

describe("comparing accounts of different sizes", () => {
  it("counts what is left in work, not in percent", () => {
    const big = account("big", { weekly: 90, weight: 20 });
    const small = account("small", { weekly: 10, weight: 1 });
    // 5 points left on a Max 20x seat is a whole Pro plan's weekly allowance,
    // and beats the 85 points left on an actual Pro plan.
    assert.equal(capacity(big, "opus", { now: NOW }), 1);
    assert.equal(capacity(small, "opus", { now: NOW }), 0.85);
  });

  it("counts Fable work as twice as expensive as Opus work", () => {
    const one = account("a", { weekly: 0, fable: 0 });
    assert.equal(capacity(one, "opus", { now: NOW }), capacity(one, "fable", { now: NOW }) * 2);
  });
});

describe("choosing where work goes", () => {
  it("starts new work on the emptiest account", () => {
    const accounts = [account("busy", { weekly: 70 }), account("fresh", { weekly: 3 }), account("mid", { weekly: 40 })];
    const chosen = decide({ accounts, active: null, klass: "opus", now: NOW, starting: true });
    assert.equal(chosen.action, "switch");
    assert.equal(chosen.target, "fresh");
  });

  it("prefers an account whose 5-hour window has not been opened at all", () => {
    // Entering an account with a window already ticking spends the rest of it;
    // opening a fresh one costs nothing now and spreads best.
    const untouched = account("untouched", { weekly: 20, fiveHour: 0 });
    const ticking = account("ticking", { weekly: 20, fiveHour: 0 });
    ticking.windows.fiveHour = { pct: 0, resetsAt: iso(NOW + HOUR) };
    const order = rank([ticking, untouched], "opus", { now: NOW });
    assert.equal(order[0].account.name, "untouched");
  });

  it("stays put while there is room, and moves at the step", () => {
    const here = account("here", { weekly: 50 });
    const there = account("there", { weekly: 5 });
    const staying = decide({ accounts: [here, there], active: "here", klass: "opus", now: NOW });
    assert.equal(staying.action, "stay", "no reason to hop to whoever is momentarily emptier");

    const full = account("here", { weekly: 96 });
    const moving = decide({ accounts: [full, there], active: "here", klass: "opus", now: NOW });
    assert.equal(moving.action, "switch");
    assert.equal(moving.target, "there");
    assert.match(moving.reason, /96% of its weekly/u);
  });

  it("raises the step to 100 only once nobody is left below 95", () => {
    const some = [account("a", { weekly: 96 }), account("b", { weekly: 40 })];
    assert.equal(ladderStep(some, "opus", { now: NOW }), LADDER[0]);
    const all = [account("a", { weekly: 96 }), account("b", { weekly: 97 })];
    assert.equal(ladderStep(all, "opus", { now: NOW }), LADDER[1], "everyone is past the first rung");
  });
});

describe("keeping a task on the model it is using", () => {
  // This is the case that proves the binding table, and it is not hypothetical:
  // `hoomanely` on this machine reads 5h 0%, weekly 55%, Fable 100%.
  const exhausted = account("hoomanely", { weekly: 55, fable: 100 });
  const roomy = account("max", { weekly: 3, fable: 4 });

  it("an Opus task is happy on an account whose Fable is spent", () => {
    assert.equal(eligibility(exhausted, "opus", { now: NOW }).ok, true);
  });

  it("a Fable task is not, and goes elsewhere", () => {
    assert.equal(eligibility(exhausted, "fable", { now: NOW }).ok, false);
    const chosen = decide({ accounts: [exhausted, roomy], active: null, klass: "fable", now: NOW, starting: true });
    assert.equal(chosen.target, "max");
  });

  it("parks rather than quietly dropping a Fable task onto Opus", () => {
    const here = account("a", { weekly: 20, fable: 100 });
    const sooner = account("b", { weekly: 10, fable: 100 });
    sooner.windows.scoped[0].resetsAt = iso(NOW + HOUR);
    const chosen = decide({ accounts: [here, sooner], active: "a", klass: "fable", now: NOW });
    assert.equal(chosen.action, "park");
    assert.equal(chosen.target, "b", "wait where the Fable window comes back first");

    // Both accounts have plenty of Opus left, and using it is the one thing
    // model continuity exists to prevent.
    assert.equal(decide({ accounts: [here, sooner], active: "a", klass: "opus", now: NOW }).action, "stay");
  });

  it("waits where it is when nothing comes back sooner elsewhere", () => {
    const nowhere = [account("a", { weekly: 20, fable: 100 }), account("b", { weekly: 10, fable: 100 })];
    const chosen = decide({ accounts: nowhere, active: "a", klass: "fable", now: NOW });
    assert.equal(chosen.action, "hold");
    assert.match(chosen.reason, /waiting here/u, "and says it is waiting, not that it has given up");
  });

  it("changes its mind when the class does", () => {
    const accounts = [account("a", { weekly: 20, fable: 100 }), account("b", { weekly: 80, fable: 5 })];
    assert.equal(decide({ accounts, active: null, klass: "opus", now: NOW, starting: true }).target, "a");
    assert.equal(decide({ accounts, active: null, klass: "fable", now: NOW, starting: true }).target, "b");
  });
});

describe("when there is nowhere to go", () => {
  it("parks on whichever window comes back first, and moves the moment it does", () => {
    const soon = account("soon", { weekly: 100, fiveHour: 100, resetsAt: iso(NOW + HOUR) });
    const later = account("later", { weekly: 100, fiveHour: 100, resetsAt: iso(NOW + 3 * HOUR) });
    const parked = decide({ accounts: [soon, later], active: "later", klass: "opus", now: NOW });
    assert.equal(parked.action, "park");
    assert.equal(parked.target, "soon");

    const reopened = account("soon", { weekly: 100, fiveHour: 0 });
    reopened.windows.weekly.pct = 10;
    const chosen = decide({ accounts: [reopened, later], active: "later", klass: "opus", now: NOW + HOUR });
    assert.equal(chosen.action, "switch");
    assert.equal(chosen.target, "soon");
  });

  it("never waits on a window that is not open", () => {
    // A null reset means no window is running, not a window that never returns.
    const closed = account("a", { weekly: 100, fiveHour: 0 });
    closed.windows.weekly.resetsAt = null;
    assert.equal(parkTarget([closed], "opus", { now: NOW }), null);
  });
});

describe("not thrashing", () => {
  it("will not go straight back to an account it just left", () => {
    // Left a moment ago and still well used: going back would start the ping
    // pong that opens a fresh 5-hour window on every account for no work done.
    const left = account("left", { weekly: 70, leftAt: NOW - 30_000 });
    const here = account("here", { weekly: 96 });
    const chosen = decide({ accounts: [here, left], active: "here", klass: "opus", now: NOW });
    assert.notEqual(chosen.target, "left");

    // Unless its window genuinely turned over, which is what lets rotation keep
    // going round the accounts indefinitely instead of stopping after one pass.
    // Being back this low is the evidence: an account left at 95% cannot read 5%
    // unless it reset, so nothing has to have been watching at the moment.
    const reset = account("left", { weekly: 5, leftAt: NOW - 30_000 });
    assert.equal(decide({ accounts: [here, reset], active: "here", klass: "opus", now: NOW }).target, "left");
  });

  it("will not move into an account already close to the step it would leave it at", () => {
    const here = account("here", { weekly: 96 });
    const barely = account("barely", { weekly: 93 });
    const chosen = decide({ accounts: [here, barely], active: "here", klass: "opus", now: NOW });
    assert.notEqual(chosen.action, "switch", "a switch that buys two points is not worth its overshoot");
  });

  it("sits still after a burst of switches rather than keeping going", () => {
    const here = account("here", { weekly: 96 });
    const there = account("there", { weekly: 5 });
    const switches = Array.from({ length: 6 }, (_, index) => NOW - index * 60_000);
    const chosen = decide({ accounts: [here, there], active: "here", klass: "opus", now: NOW, switches });
    assert.equal(chosen.action, "hold");
    assert.match(chosen.reason, /too many switches/u);
  });

  it("stays a moment after arriving, unless the provider is already refusing", () => {
    const justArrived = account("here", { weekly: 96, enteredAt: NOW - 10_000 });
    const there = account("there", { weekly: 5 });
    const settling = decide({ accounts: [justArrived, there], active: "here", klass: "opus", now: NOW });
    assert.equal(settling.action, "stay");

    const spent = account("here", { weekly: 99.6, enteredAt: NOW - 10_000 });
    const urgent = decide({ accounts: [spent, there], active: "here", klass: "opus", now: NOW });
    assert.equal(urgent.action, "switch", "waiting past the ceiling only wastes the ceiling");
    assert.equal(urgent.urgent, true);
  });
});

describe("determinism", () => {
  it("orders identical accounts the same way every time", () => {
    const twins = [account("a", { weekly: 10 }), account("b", { weekly: 10 }), account("c", { weekly: 10 })];
    const once = rank(twins, "opus", { now: NOW }).map((entry) => entry.account.name);
    const again = rank(twins.toReversed(), "opus", { now: NOW }).map((entry) => entry.account.name);
    assert.deepEqual(once, again, "tie-break noise must not make the policy flap");
  });
});
