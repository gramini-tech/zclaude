// Which account the work should be on, and when it should move.
//
// Everything here is a pure function of a snapshot. Nothing reads a file, takes
// a lock or makes a request, which is what lets the whole policy be driven from
// a synthetic timeline in the tests: the decisions are the thing that has to be
// right, and they are the thing hardest to observe once a daemon is running.
//
// Three rules shape it, and they pull in different directions on purpose:
//
//   - a task never drops to a weaker model, so a Fable session is constrained
//     by Fable's own ceiling and will wait rather than land on Opus
//   - new work starts on the emptiest account, so usage spreads
//   - work in progress stays put until its account is nearly full, so it drains
//     rather than hops
//
// The second and third only look contradictory. They answer different
// questions: where work begins, and when it leaves. Moving at 40% because
// somebody else is emptier buys nothing and risks landing mid-turn.

import { CLASS_WEIGHT } from "./cost.js";
import { marginFor, predict } from "./estimate.js";

/** The two steps. 100 rather than 98 because of the overshoot below. */
export const LADDER = Object.freeze([95, 100]);
/** A window back under this makes its account a candidate again. */
const RESET_BELOW = 50;
/** Do not move *into* an account already this close to the step we would leave it at. */
const ENTRY_HYSTERESIS = 5;
/** Having just arrived, stay a little, unless the provider is about to refuse anyway. */
const DWELL_MS = 120_000;
/** Having just left, do not come back — unless its window genuinely reset. */
const REENTRY_MS = 10 * 60_000;
/** A circuit breaker, not a policy. */
const SWITCH_BUDGET = 6;
const SWITCH_BUDGET_MS = 60 * 60_000;
/** Past this the provider is refusing anyway; stop waiting for a quiet moment. */
const ESCALATE_PCT = 99;

/** States that mean the numbers are not usable for a decision. */
const BROKEN = new Set(["dead", "unauthorized"]);

/**
 * @typedef {object} Account
 * @property {string} name
 * @property {string} [accountUuid]
 * @property {string} [organizationUuid]
 * @property {string} provider
 * @property {number} weight how many Pro plans this seat is worth
 * @property {string} state the usage lookup's own verdict
 * @property {boolean} [registered] whether a switch could target it
 * @property {boolean} [refreshExpired]
 * @property {boolean} [quarantined]
 * @property {object} [windows] {fiveHour, weekly, scoped[]}
 * @property {object} [anchors] per-window estimator anchors
 * @property {number} [ladderStep]
 * @property {number} [sessions]
 * @property {number} [leftAt]
 * @property {number} [enteredAt]
 * @property {boolean} [resetSinceLeaving]
 */

/**
 * The windows that constrain a class.
 *
 * Fable is the only class with a ceiling of its own, and hitting either the
 * 5-hour or the weekly limit blocks every prompt regardless of model — so the
 * constraint is always the worst window, never the model's own.
 *
 * @param {Account} account
 * @param {string} klass
 */
export function bindingWindows(account, klass) {
  const windows = account.windows ?? {};
  const found = [
    { key: "fiveHour", window: windows.fiveHour ?? null },
    { key: "weekly", window: windows.weekly ?? null },
  ];
  const scoped = windows.scoped ?? [];
  for (const scope of scoped) {
    if (String(scope.name).toLowerCase() === klass) found.push({ key: scope.name, window: scope });
  }
  return found.filter((entry) => entry.window);
}

/**
 * How full the tightest binding window is, as a percentage, pessimistically.
 *
 * `critical` severity is floored at 99 whatever number came with it: the
 * provider has already said this window is spent, and the number is a detail.
 *
 * @param {Account} account
 * @param {string} klass
 * @param {{now?: number, cost?: number, predicted?: boolean}} [options]
 * @returns {{pct: number, margin: number, window: string | null, unknown: boolean}}
 */
export function binding(account, klass, { now = Date.now(), cost = 0, predicted = true } = {}) {
  let worst = { pct: 0, margin: 0, window: null, unknown: false };
  const windows = bindingWindows(account, klass);
  if (windows.length === 0) return { ...worst, unknown: true };
  for (const { key, window } of windows) {
    const anchor = predicted ? account.anchors?.[key] : null;
    const guess = anchor ? predict(anchor, { cost, now }) : null;
    const reported = Number(window.pct);
    const floor = window.severity === "critical" ? 99 : 0;
    const pct = Math.max(floor, Number.isFinite(reported) ? reported : 0, guess?.pct ?? 0);
    const margin = anchor ? marginFor(anchor) : 0;
    const unknown = !Number.isFinite(reported) && !guess;
    if (pct + margin > worst.pct + worst.margin) worst = { pct, margin, window: key, unknown };
  }
  return worst;
}

/**
 * Whether this account could take a task of this class right now.
 * @param {Account} account
 * @param {string} klass
 * @param {object} [options]
 * @returns {{ok: boolean, reason: string | null}}
 */
export function eligibility(account, klass, options = {}) {
  const { now = Date.now(), cost = 0, step = null } = options;
  const usable = rotatable(account, options);
  if (!usable.ok) return usable;
  const ceiling = step ?? account.ladderStep ?? LADDER[0];
  const full = binding(account, klass, { now, cost });
  if (full.pct + full.margin >= ceiling) {
    return { ok: false, reason: `its ${full.window ?? "usage"} window is at ${Math.round(full.pct)}%` };
  }
  return { ok: true, reason: null };
}

/**
 * Whether the global login could be moved to this account at all, before any
 * question of how full it is. A Z.ai profile is the interesting case: it is
 * present and healthy and can never be a target, because its login reaches
 * Claude Code through the environment rather than the slot.
 * @param {Account} account
 */
export function rotatable(account, { org = null, allowCrossOrg = false } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (account.provider !== "anthropic") {
    return no("its login is an endpoint and a key, which only reach Claude Code through the environment");
  }
  if (!account.registered) return no("it is not a registered profile, so there is nothing to switch to");
  if (account.refreshExpired) return no("its refresh token has expired; sign it in again");
  if (account.quarantined) return no("its refresh lineage was rejected; sign it in again");
  if (BROKEN.has(account.state)) return no(account.state === "dead" ? "its login expired" : "it is signed out");
  // Rotating between organisations runs one organisation's work on the other's
  // plan. Cheap to prevent, expensive to explain afterwards.
  if (!allowCrossOrg && org && account.organizationUuid && account.organizationUuid !== org) {
    return no("it belongs to a different organisation");
  }
  return { ok: true, reason: null };
}

/**
 * What is left on this account, in cost units of the class being asked for.
 *
 * Percentages cannot be compared across plans: 10% left on a Max 20x seat is
 * sixteen times the work of 10% left on a standard Team seat. Multiplying by
 * the plan's own size is what makes the comparison mean something, and dividing
 * by the class weight puts it in units of the work actually being done.
 *
 * @param {Account} account
 * @param {string} klass
 */
export function capacity(account, klass, { now = Date.now(), cost = 0, step = null } = {}) {
  const ceiling = step ?? account.ladderStep ?? LADDER[0];
  const full = binding(account, klass, { now, cost });
  const remaining = Math.max(0, ceiling - full.pct);
  const weight = CLASS_WEIGHT[klass] ?? 1;
  return (account.weight * remaining) / 100 / weight;
}

/** A 5-hour window that has not been opened yet: the best possible place to start. */
function windowClosed(account) {
  const five = account.windows?.fiveHour;
  if (!five) return true;
  return (Number(five.pct) || 0) === 0 && !five.resetsAt;
}

/** A stable tie-break, so identical inputs always give an identical answer. */
function tiebreak(account) {
  const text = account.accountUuid ?? account.name ?? "";
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.codePointAt(index), 16_777_619) >>> 0;
  }
  return hash;
}

/**
 * Eligible accounts, best first.
 *
 * Starting work prefers an account whose 5-hour window has not been opened at
 * all: opening one costs nothing now and spreads best, whereas entering an
 * account with a window already ticking spends the rest of that window.
 *
 * @param {Account[]} accounts
 * @param {string} klass
 * @param {object} [options]
 * @returns {Array<{account: Account, capacity: number, reason: string | null}>}
 */
export function rank(accounts, klass, options = {}) {
  const { now = Date.now(), costs = new Map(), step = null } = options;
  const costOf = (account) => costs.get(account.name) ?? 0;
  const scored = accounts
    .map((account) => ({
      account,
      eligible: eligibility(account, klass, { ...options, now, cost: costOf(account), step }),
      capacity: capacity(account, klass, { now, cost: costOf(account), step }),
    }))
    .filter((entry) => entry.eligible.ok);
  scored.sort((a, b) => {
    if (b.capacity !== a.capacity) return b.capacity - a.capacity;
    const closed = Number(windowClosed(b.account)) - Number(windowClosed(a.account));
    if (closed !== 0) return closed;
    const weekly = (Number(a.account.windows?.weekly?.pct) || 0) - (Number(b.account.windows?.weekly?.pct) || 0);
    if (weekly !== 0) return weekly;
    const sessions = (a.account.sessions ?? 0) - (b.account.sessions ?? 0);
    if (sessions !== 0) return sessions;
    return tiebreak(a.account) - tiebreak(b.account);
  });
  return scored.map((entry) => ({ account: entry.account, capacity: entry.capacity, reason: null }));
}

/**
 * Whether the whole fleet has climbed past the first rung.
 *
 * The step only rises when *nobody* is left below it. Draining every account to
 * 95 before anyone is pushed to 100 keeps a margin in hand on all of them,
 * which is what absorbs the half-minute of overshoot after each switch.
 */
export function ladderStep(accounts, klass, options = {}) {
  const first = rank(accounts, klass, { ...options, step: LADDER[0] });
  return first.length > 0 ? LADDER[0] : LADDER[1];
}

/** Whether this account may be moved into, over and above being eligible. */
function mayEnter(account, klass, { now, step, cost }) {
  const full = binding(account, klass, { now, cost });
  // The cooldown keeps two accounts from passing work back and forth, and a
  // genuine reset clears it. Being back under `RESET_BELOW` is the evidence:
  // an account we left at 95% cannot be at 40% unless its window turned over,
  // so this needs nothing remembered and cannot be wrong about a reset it
  // happened not to see.
  const returned = account.resetSinceLeaving || full.pct < RESET_BELOW;
  const cooling = !returned && account.leftAt && now - account.leftAt < REENTRY_MS;
  if (cooling) return { ok: false, reason: "it was left too recently" };
  if (full.pct >= step - ENTRY_HYSTERESIS) return { ok: false, reason: "it is already close to the step" };
  return { ok: true, reason: null };
}

/**
 * When every eligible account is spent, the one that comes back soonest.
 *
 * A null `resetsAt` means no window is open rather than a window that never
 * returns, so it is not something to wait for and not something to sort by.
 */
export function parkTarget(accounts, klass, { now = Date.now() } = {}) {
  const waiting = accounts
    .filter((account) => rotatable(account).ok)
    .map((account) => {
      const times = bindingWindows(account, klass)
        .map((entry) => Date.parse(entry.window.resetsAt))
        .filter((at) => Number.isFinite(at) && at > now);
      return { account, at: times.length > 0 ? Math.min(...times) : null };
    })
    .filter((entry) => entry.at !== null);
  if (waiting.length === 0) return null;
  waiting.sort((a, b) => a.at - b.at || tiebreak(a.account) - tiebreak(b.account));
  return waiting[0];
}

/**
 * The whole decision, for one cycle.
 *
 * @param {{accounts: Account[], active: string|null, klass: string, now?: number, costs?: Map<string, number>,
 *          switches?: number[], starting?: boolean, org?: string|null, allowCrossOrg?: boolean,
 *          step?: number|null}} input
 * @returns {{action: string, target: string|null, reason: string, urgent?: boolean, step?: number}}
 */
export function decide({ accounts, active, klass, ...options }) {
  const { now = Date.now(), costs = new Map(), switches = [], starting = false } = options;
  const step = ladderStep(accounts, klass, { ...options, now, costs });
  const ordered = rank(accounts, klass, { ...options, now, costs, step });
  const current = accounts.find((account) => account.name === active) ?? null;

  // Nothing running yet means no continuity to protect and no overshoot to
  // absorb, so this is the one place that simply takes the emptiest.
  if (starting || !current) return begin({ accounts, klass, ordered, now, step });

  // An account that cannot serve at all — its login expired, it was signed out,
  // its lineage was quarantined — has no usable numbers, so the ordinary "how
  // full is it" question does not apply. Leave it now, with no waiting for a
  // quiet moment: the session on it is about to start failing anyway.
  const serving = rotatable(current, options);
  if (!serving.ok) {
    const away = nextTarget(ordered, klass, { now, step, costs, except: current.name });
    const reason = `${current.name} cannot be used: ${serving.reason}`;
    if (away) return { action: "switch", target: away.account.name, reason, urgent: true, step };
    return { action: "hold", target: null, reason: `${reason}, and nowhere else can take the work`, step };
  }

  const cost = costs.get(current.name) ?? 0;
  const full = binding(current, klass, { now, cost });
  const urgent = full.pct >= ESCALATE_PCT || full.window === null;
  if (full.pct + full.margin < step) {
    return { action: "stay", target: current.name, reason: `${Math.round(full.pct)}% of its ${full.window}`, step };
  }

  const held = holdingBack(current, { now, urgent, switches });
  if (held) return { action: held.action, target: current.name, reason: held.reason, step };

  const next = nextTarget(ordered, klass, { now, step, costs, except: current.name });
  if (next) {
    return {
      action: "switch",
      target: next.account.name,
      reason: `${current.name} is at ${Math.round(full.pct)}% of its ${full.window}`,
      urgent,
      step,
    };
  }

  const park = parkTarget(accounts, klass, { now });
  if (park && park.account.name !== current.name) {
    return { action: "park", target: park.account.name, reason: "nowhere with headroom; waiting for a reset", step };
  }
  // Already sitting on whichever window comes back first. Staying is the whole
  // action, and saying so matters: "nowhere left to go" reads like a failure,
  // and this is the policy working.
  if (park) return { action: "hold", target: current.name, reason: "waiting here for the soonest reset", step };
  return { action: "hold", target: current.name, reason: "nowhere left to go", step };
}

/**
 * Whether something other than the numbers says not to move yet.
 *
 * The dwell stops a switch landing two seconds after the last one; the budget
 * is a circuit breaker for a policy that has started oscillating. Neither
 * applies once the provider is refusing anyway, when waiting only wastes what
 * is left of the window.
 */
function holdingBack(current, { now, urgent, switches }) {
  const settling = !urgent && current.enteredAt && now - current.enteredAt < DWELL_MS;
  if (settling) return { action: "stay", reason: "it was only just switched to" };
  const recent = switches.filter((at) => now - at < SWITCH_BUDGET_MS);
  // "hold" rather than "stay": staying is the policy working, holding is the
  // circuit breaker having tripped, and `auto status` should not call them the
  // same thing.
  if (recent.length >= SWITCH_BUDGET) return { action: "hold", reason: "too many switches in the last hour" };
  return null;
}

/** The best ranked account that the anti-thrash rules also allow moving into. */
function nextTarget(ordered, klass, { now, step, costs, except }) {
  for (const candidate of ordered) {
    if (candidate.account.name === except) continue;
    const may = mayEnter(candidate.account, klass, { now, step, cost: costs.get(candidate.account.name) ?? 0 });
    if (may.ok) return candidate;
  }
  return null;
}

/** Where to start, when nothing is running yet. */
function begin({ accounts, klass, ordered, now, step }) {
  const first = ordered[0] ?? null;
  if (first) return { action: "switch", target: first.account.name, reason: "starting on the emptiest account", step };
  // Nothing has room. zclaude still does not refuse: it parks on whatever comes
  // back first and lets the provider be the one to say no.
  const park = parkTarget(accounts, klass, { now });
  if (park) return { action: "park", target: park.account.name, reason: "every account is spent", step };
  return { action: "hold", target: null, reason: "no account can take this work", step };
}
