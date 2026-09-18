// One cycle of the daemon, with everything that touches the world injected.
//
// This is where the decisions from `policy.js` meet the machine. It is kept
// separate from the process that runs it — the timers, the signals, the
// detaching — because a file of `setInterval` and `process.on` is the hardest
// thing in this repository to test, and the part that actually decides whether
// somebody's login moves should not live inside it.
//
// The order within a cycle is deliberate, and each step is a guard against
// something that has already gone wrong on a real machine:
//
//   1. reap leases, and stop if nobody wants us. Checked on its own short
//      clock, because a daemon whose last session ended should not keep the
//      right to move the login for another poll interval.
//   2. confirm the lock is still ours. Cheap, and the only defence against a
//      second daemon that started under a different ZCLAUDE_HOME.
//   3. capture the live credential back. This is the rot that stranded an
//      account on this machine while a six-hourly job that was never installed
//      was supposed to be handling it.
//   4. read usage, and decide.
//   5. wait for a quiet moment, then switch, then verify it actually moved.
//
// Nothing here switches unless a session lease granted rotation. An editor
// window alone means watch: read, record, and touch nothing.

import { log } from "../logger.js";
import { decideLifecycle, grantsOf, liveLeases } from "./lease.js";
import { ownerAlive, readDaemonOwner } from "./lock.js";
import { counted, withDecision } from "./state.js";

/** A transcript untouched for this long means nothing is mid-answer. */
const QUIET_MS = 6000;
/** But a session that never goes quiet is one long turn; do not wait for ever. */
export const QUIET_DEADLINE_MS = 90_000;

/**
 * Is anything writing to a transcript right now?
 *
 * Measured against a live session, the transcript's mtime moves within about
 * three seconds of an exchange, so six is comfortably "between turns" without
 * being so long that a busy session never qualifies.
 */
export function isQuiet(newestMtimeMs, { now = Date.now(), quietMs = QUIET_MS } = {}) {
  if (!newestMtimeMs) return true;
  return now - newestMtimeMs >= quietMs;
}

/**
 * Whether to act now, wait for quiet, or stop waiting and act anyway.
 *
 * Past the escalation point the provider is already refusing, so waiting for a
 * tidy moment only wastes what is left of the window.
 */
export function switchTiming({ urgent, quiet, waitingSince, now = Date.now(), deadlineMs = QUIET_DEADLINE_MS }) {
  if (urgent) return { act: true, reason: "the account is spent; waiting would only waste the rest" };
  if (quiet) return { act: true, reason: "nothing is mid-answer" };
  if (waitingSince && now - waitingSince >= deadlineMs) {
    return { act: true, reason: "waited long enough for a quiet moment" };
  }
  return { act: false, reason: "something is mid-answer" };
}

/**
 * One pass. Returns the next state and what it did; performs no timing of its
 * own and schedules nothing.
 *
 * @param {{state: object, deps: object, env?: NodeJS.ProcessEnv, now?: number}} input
 * @returns {Promise<{state: object, action: string, detail: string, exit: boolean}>}
 */
export async function runOnce({ state, deps, env = process.env, now = Date.now() }) {
  const next = { ...counted(state, "cycles"), heartbeatAt: now };

  const { leases } = await deps.leases({ env, now });
  const lifecycle = decideLifecycle({ leases, emptySince: state.emptySince ?? null, now });
  next.emptySince = lifecycle.emptySince;
  if (lifecycle.action === "exit" || lifecycle.action === "linger") {
    return {
      state: { ...next, mode: lifecycle.action, reason: lifecycle.reason, active: state.active },
      action: lifecycle.action,
      detail: lifecycle.reason,
      exit: lifecycle.action === "exit",
    };
  }

  const owner = await deps.owner(env);
  const mine = await deps.ownerAlive(owner);
  if (!mine.ours) {
    // Somebody else holds it, or we lost it. Either way this process has no
    // business moving a login any more.
    return {
      state: { ...next, mode: "stopping", reason: mine.reason },
      action: "stand-down",
      detail: mine.reason,
      exit: true,
    };
  }

  const captured = await deps.captureBack({ env }).catch((error) => ({ captured: false, reason: error.message }));
  if (captured.captured) {
    log.info("auto", "captured the live login back", { profile: captured.profile });
    Object.assign(next, counted(next, "captures"));
  }

  const snapshot = await deps.inventory({ env, now });
  Object.assign(next, counted(next, "polls"));
  next.active = snapshot.active;
  next.accounts = Object.fromEntries(
    snapshot.accounts.map((account) => [account.name, { state: account.state, tier: account.tier }]),
  );

  const { rotate } = grantsOf(leases);
  if (!rotate) {
    return {
      state: { ...next, mode: "watching", reason: lifecycle.reason },
      action: "watch",
      detail: lifecycle.reason,
      exit: false,
    };
  }

  const klass = (await deps.classInUse({ env, now })) ?? "opus";
  next.klass = klass;
  // Awaited, because the live wiring imports the policy lazily and hands back a
  // promise. Without this the choice is a pending promise whose `.action` is
  // undefined, so every comparison falls through and the watcher runs for ever
  // deciding nothing — which is exactly what a first live run did.
  const choice = await deps.decide({ accounts: snapshot.accounts, active: snapshot.active, klass, now });
  if (choice.action !== "switch") {
    return {
      state: { ...next, mode: "rotating", reason: choice.reason },
      action: choice.action,
      detail: choice.reason,
      exit: false,
    };
  }

  const quiet = isQuiet(await deps.newestActivity({ env }), { now });
  const timing = switchTiming({ urgent: choice.urgent, quiet, waitingSince: state.waitingSince ?? null, now });
  if (!timing.act) {
    return {
      state: { ...next, mode: "draining", reason: timing.reason, waitingSince: state.waitingSince ?? now },
      action: "wait",
      detail: `${choice.reason}; ${timing.reason}`,
      exit: false,
    };
  }
  next.waitingSince = null;

  return performSwitch({ next, choice, timing, deps, env, now, klass });
}

/**
 * Move the login, then check that it really moved.
 *
 * `switchTo` rolls back on a failed write and swallows a failed rollback, which
 * can leave the right credential under the wrong name. Verifying afterwards is
 * the only way to notice, and noticing is the whole response: an automatic
 * repair here would be a second unattended write on top of a state we already
 * do not understand.
 */
async function performSwitch({ next, choice, timing, deps, env, now, klass }) {
  const record = { at: now, from: next.active, to: choice.target, klass, reason: choice.reason, why: timing.reason };
  try {
    await deps.switchTo(choice.target, { env });
  } catch (error) {
    log.warn("auto", "switch refused", { target: choice.target, error });
    return {
      state: withDecision(
        { ...counted(next, "refusals"), mode: "rotating", reason: error.message },
        {
          ...record,
          ok: false,
          detail: error.message,
        },
      ),
      action: "refused",
      detail: error.message,
      exit: false,
    };
  }
  const after = await deps.swapStatus({ env }).catch(() => ({ owner: null }));
  if (after.owner !== choice.target) {
    const detail = `the slot holds ${after.owner ?? "nobody zclaude knows"} after switching to ${choice.target}`;
    log.error("auto", "slot inconsistent after a switch", { detail });
    return {
      state: withDecision(
        { ...next, mode: "wedged", reason: `${detail}. Run \`zclaude switch --restore\`.` },
        {
          ...record,
          ok: false,
          detail,
        },
      ),
      action: "wedged",
      detail,
      exit: true,
    };
  }
  log.info("auto", "global login rotated", { to: choice.target, reason: choice.reason });
  return {
    state: withDecision(
      { ...counted(next, "switches"), mode: "rotating", reason: choice.reason, active: choice.target },
      {
        ...record,
        ok: true,
        detail: null,
      },
    ),
    action: "switched",
    detail: `${next.active ?? "nobody"} → ${choice.target}`,
    exit: false,
  };
}

/**
 * The default deps: the real thing, wired up. Tests pass their own.
 *
 * @param {{security?: object, fetchImpl?: typeof fetch, configDirs?: (env: NodeJS.ProcessEnv) => Promise<string[]>}} [options]
 *
 * The transcript read carries its own byte offsets across cycles in a closure,
 * which is what makes the second pass cheap and what makes the duplicate guard
 * mean anything: without somewhere to remember where it stopped, every cycle
 * would re-read from the same place.
 */
export function liveDeps({ security, fetchImpl, configDirs = () => Promise.resolve([]) } = {}) {
  /** @type {Record<string, {offset: number, lastAt: number}>} */
  let offsets = {};
  let seen = [];

  const readTranscripts = async (env, now) => {
    const { sample, transcriptRoots } = await import("./burn.js");
    const roots = await transcriptRoots(await configDirs(env));
    const pass = await sample({ roots, state: offsets, now });
    offsets = pass.state;
    // A trailing window, so a class that has genuinely been abandoned drops out.
    seen = [...seen, ...pass.costs].filter((cost) => now - cost.at < 60 * 60_000);
    return { roots, costs: seen };
  };

  return {
    leases: (options) => liveLeases(options),
    owner: (env) => readDaemonOwner(env),
    ownerAlive: async (owner) => {
      const alive = await ownerAlive(owner);
      const ours = alive.live && owner?.pid === process.pid;
      return { ours, reason: ours ? null : (alive.reason ?? "another process holds the daemon lock") };
    },
    captureBack: async ({ env }) => (await import("../swap/index.js")).captureBack({ env, security }),
    swapStatus: async ({ env }) => (await import("../swap/index.js")).swapStatus({ env, security }),
    switchTo: async (name, { env }) =>
      (await import("../swap/index.js")).switchTo(name, { env, security, backup: false, by: "auto" }),
    inventory: async ({ env, now }) => (await import("./inventory.js")).inventory({ env, security, fetchImpl, now }),
    decide: async (input) => (await import("./policy.js")).decide(input),
    classInUse: async ({ env, now }) => {
      const { costs } = await readTranscripts(env, now);
      return (await import("./cost.js")).classInUse(costs, { now });
    },
    newestActivity: async ({ env, now = Date.now() }) => {
      const { warmTranscripts, transcriptRoots } = await import("./burn.js");
      const roots = await transcriptRoots(await configDirs(env));
      const files = await warmTranscripts(roots, { now });
      return files[0]?.mtimeMs ?? 0;
    },
  };
}
