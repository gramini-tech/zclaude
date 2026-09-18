// One cycle of the daemon, driven through fakes.
//
// Every call that touches the world is injected, so these are the real
// decisions — which account, whether to wait, what to do when the switch is
// refused — without a process, a timer or a Keychain anywhere near them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isQuiet, QUIET_DEADLINE_MS, runOnce, switchTiming } from "../src/auto/loop.js";
import { emptyState } from "../src/auto/state.js";

const NOW = 1_800_000_000_000;

const lease = (kind) => ({ id: kind, kind, grants: kind === "session" ? ["watch", "rotate"] : ["watch"] });

const account = (name, over = {}) => ({
  name,
  provider: "anthropic",
  registered: true,
  state: "ok",
  weight: 5,
  windows: {
    fiveHour: { pct: over.fiveHour ?? 0, resetsAt: null },
    weekly: { pct: over.weekly ?? 10, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() },
    scoped: [],
  },
  ...over,
});

/** Deps that do nothing and record everything. */
function fakes(over = {}) {
  const calls = { switched: [], captured: 0 };
  const deps = {
    leases: async () => ({ leases: [lease("session")] }),
    owner: async () => ({ pid: process.pid }),
    ownerAlive: async () => ({ ours: true, reason: null }),
    captureBack: async () => {
      calls.captured += 1;
      return { captured: false };
    },
    inventory: async () => ({ accounts: [account("here", { weekly: 10 })], active: "here" }),
    decide: () => ({ action: "stay", target: "here", reason: "plenty left" }),
    classInUse: async () => "opus",
    newestActivity: async () => NOW - 60_000,
    switchTo: async (name) => {
      calls.switched.push(name);
    },
    swapStatus: async () => ({ owner: calls.switched.at(-1) ?? "here" }),
    ...over,
  };
  return { deps, calls };
}

const cycle = (over, state = emptyState()) => {
  const { deps, calls } = fakes(over);
  return runOnce({ state, deps, env: {}, now: NOW }).then((result) => ({ ...result, calls }));
};

describe("quiet moments", () => {
  it("counts a transcript untouched for a few seconds as between turns", () => {
    // Measured against a live session: the mtime moves within about three
    // seconds of an exchange, so six is between turns without being so long
    // that a busy session never qualifies.
    assert.equal(isQuiet(NOW - 10_000, { now: NOW }), true);
    assert.equal(isQuiet(NOW - 1000, { now: NOW }), false);
    assert.equal(isQuiet(0, { now: NOW }), true, "nothing has ever written, so nothing is mid-answer");
  });

  it("stops waiting once the account is spent", () => {
    // Past the ceiling the provider is already refusing, so waiting for a tidy
    // moment only wastes the rest of the window.
    assert.equal(switchTiming({ urgent: true, quiet: false, waitingSince: NOW, now: NOW }).act, true);
    assert.equal(switchTiming({ urgent: false, quiet: false, waitingSince: NOW, now: NOW }).act, false);
    // And a session that never goes quiet is one long turn, not a reason to
    // wait for ever.
    const late = switchTiming({ urgent: false, quiet: false, waitingSince: NOW, now: NOW + QUIET_DEADLINE_MS });
    assert.equal(late.act, true);
    assert.match(late.reason, /waited long enough/u);
  });
});

describe("one cycle", () => {
  it("captures the live login back before it judges anything", async () => {
    // The rot that stranded an account on a real machine, while a six-hourly
    // job that was never installed was supposed to be handling it.
    const { calls } = await cycle();
    assert.equal(calls.captured, 1);
  });

  it("only watches when an editor is the only thing holding it", async () => {
    const result = await cycle({
      leases: async () => ({ leases: [lease("vscode")] }),
      decide: () => ({ action: "switch", target: "elsewhere", reason: "would have moved" }),
    });
    assert.equal(result.action, "watch");
    // An open editor window is not consent to move the global login.
    assert.deepEqual(result.calls.switched, []);
  });

  it("switches when the policy says so, and records what it did", async () => {
    const result = await cycle({
      inventory: async () => ({ accounts: [account("here", { weekly: 96 }), account("there")], active: "here" }),
      decide: () => ({ action: "switch", target: "there", reason: "here is at 96% of its weekly" }),
    });
    assert.equal(result.action, "switched");
    assert.deepEqual(result.calls.switched, ["there"]);
    assert.equal(result.state.active, "there");
    assert.equal(result.state.counters.switches, 1);
    const [decision] = result.state.decisions;
    assert.equal(decision.ok, true);
    assert.equal(decision.to, "there");
    // The numbers it acted on, so the reason survives to be read back later.
    assert.match(decision.reason, /96%/u);
  });

  it("switches when the policy is asynchronous, which the real wiring is", async () => {
    // Found on a first live run: the live deps import the policy lazily, so
    // `decide` hands back a promise. Unawaited, its `.action` is undefined,
    // every branch falls through, and the watcher runs for ever deciding
    // nothing while reporting that it is rotating.
    const result = await cycle({
      inventory: async () => ({ accounts: [account("here", { weekly: 96 }), account("there")], active: "here" }),
      decide: async () => ({ action: "switch", target: "there", reason: "here is full" }),
    });
    assert.equal(result.action, "switched");
    assert.deepEqual(result.calls.switched, ["there"]);
  });

  it("waits for a quiet moment rather than landing mid-answer", async () => {
    const result = await cycle({
      newestActivity: async () => NOW - 1000,
      decide: () => ({ action: "switch", target: "there", reason: "full" }),
    });
    assert.equal(result.action, "wait");
    assert.deepEqual(result.calls.switched, []);
    assert.equal(result.state.waitingSince, NOW, "and remembers when it started waiting");
  });

  it("goes anyway when the account is already spent", async () => {
    const result = await cycle({
      newestActivity: async () => NOW - 1000,
      decide: () => ({ action: "switch", target: "there", reason: "spent", urgent: true }),
    });
    assert.equal(result.action, "switched");
  });

  it("keeps the slot and counts the refusal when a switch throws", async () => {
    const result = await cycle({
      decide: () => ({ action: "switch", target: "there", reason: "full" }),
      switchTo: async () => {
        throw new Error('"there" has no stored login.');
      },
    });
    assert.equal(result.action, "refused");
    assert.equal(result.exit, false, "one refusal is not a reason to stop watching");
    assert.equal(result.state.counters.refusals, 1);
    assert.equal(result.state.decisions[0].ok, false);
  });

  it("stops entirely when the slot does not hold what it just wrote", async () => {
    // `switchTo` rolls back on a failed write and swallows a failed rollback,
    // which can leave the right credential under the wrong name. An automatic
    // repair would be a second unattended write on a state we do not
    // understand, so it stops and says which command to run.
    const result = await cycle({
      decide: () => ({ action: "switch", target: "there", reason: "full" }),
      swapStatus: async () => ({ owner: "somebody-else" }),
    });
    assert.equal(result.action, "wedged");
    assert.equal(result.exit, true);
    assert.match(result.state.reason, /switch --restore/u);
  });

  it("stands down when the lock is no longer ours", async () => {
    // The only defence against a second daemon started under a different
    // ZCLAUDE_HOME, which the lock file alone cannot see.
    const result = await cycle({ ownerAlive: async () => ({ ours: false, reason: "another process holds it" }) });
    assert.equal(result.action, "stand-down");
    assert.equal(result.exit, true);
    assert.equal(result.calls.captured, 0, "and touches nothing on the way out");
  });

  it("lingers with no leases, then exits", async () => {
    const empty = { leases: async () => ({ leases: [] }) };
    const first = await cycle(empty);
    assert.equal(first.action, "linger");
    assert.equal(first.exit, false);

    const { deps } = fakes(empty);
    const later = await runOnce({ state: { ...emptyState(), emptySince: NOW }, deps, env: {}, now: NOW + 120_000 });
    assert.equal(later.action, "exit");
    assert.equal(later.exit, true);
  });
});
