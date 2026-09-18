// Turning "how much has been spent locally" into "how full is this account".
//
// Two signals with two jobs. The endpoint is the only thing that knows the real
// percentage, and it costs a request and answers in whole points. The
// transcripts know every token the moment it is spent and cost nothing. So the
// endpoint anchors, and the local cost counter interpolates between anchors:
//
//   predicted = anchor.pct + factor × (cost − anchor.cost) + shadow × elapsed
//
// The prediction only ever rises. Nothing but a confirmed reset brings it down,
// because an estimate that can drift downwards would eventually say an
// exhausted account has room.
//
// Nothing here decides anything on its own. A ladder crossing is acted on from
// an endpoint reading, or from a prediction that has crossed *including* its
// own error margin. The margin is measured rather than assumed: it is twice the
// recent disagreement between what this predicted and what the endpoint then
// said, so a model that turns out to be poor widens its own guard band.

/** %-per-cost-unit is clamped to this band around its starting guess. */
const FACTOR_SPREAD = 8;
/** How fast the learned factor moves toward a new sample. */
const FACTOR_RATE = 0.3;

/**
 * The endpoint reports whole percentage points in practice (`6`, `55`, `76`,
 * `100` on this machine), so a one-point step is ±50% quantisation error.
 * Three points caps it near ±17%, which is the smallest step worth learning
 * from.
 */
export const MIN_STEP_PCT = 3;
/** And below this the denominator is small enough to make the division noise. */
export const MIN_STEP_COST = 200_000;

/** Never narrower than this, never wider, in percentage points. */
export const MARGIN_MIN = 2;
export const MARGIN_MAX = 15;
/** Each poll we could not make widens it, up to here. */
const MARGIN_PER_MISS = 5;
const MARGIN_CAP = 25;

/** Plan sizes, relative to Pro, as Anthropic names the tiers. */
const TIER_WEIGHT = Object.freeze({
  default_claude_pro: 1,
  default_claude_max_5x: 5,
  default_claude_max_20x: 20,
  default_team: 1.25,
  default_team_premium: 6.25,
});

/**
 * How large a plan is, from whatever the credential and identity could tell us.
 *
 * An unknown tier weighs 1, the smallest plan there is. The asymmetry is on
 * purpose: over-estimating a seat routes long work onto a small account and
 * costs a second rotation, while under-estimating only costs spread quality.
 *
 * @param {{rateLimitTier?: string | null, tier?: string | null, subscriptionType?: string | null}} what
 * @returns {{weight: number, tier: string | null, known: boolean}}
 */
export function planWeight(what = {}) {
  for (const name of [what.rateLimitTier, what.tier]) {
    const weight = typeof name === "string" ? TIER_WEIGHT[name] : undefined;
    if (weight !== undefined) return { weight, tier: name, known: true };
  }
  // `subscriptionType` is "team" for a 5x seat and a 20x seat alike, so it can
  // only ever be a floor, never an answer.
  const fallback = { pro: 1, max: 5, team: 1.25, enterprise: 1.25 }[what.subscriptionType];
  return { weight: fallback ?? 1, tier: what.rateLimitTier ?? what.tier ?? null, known: false };
}

/**
 * A fresh anchor for a window, from an endpoint reading.
 * @param {{pct: number, at: number, cost: number, factor?: number}} what
 */
export function anchorAt({ pct, at, cost, factor = null }) {
  return { pct: clampPct(pct), at, cost, factor, shadow: 0, error: 0, misses: 0 };
}

const clampPct = (value) => Math.min(100, Math.max(0, Number(value) || 0));

/**
 * Where this window probably is now.
 *
 * @param {object} anchor
 * @param {{cost: number, now: number}} since
 * @returns {{pct: number, margin: number, confident: boolean}}
 */
export function predict(anchor, { cost, now }) {
  if (!anchor) return { pct: 0, margin: MARGIN_MAX, confident: false };
  const spent = Math.max(0, cost - anchor.cost);
  const elapsed = Math.max(0, now - anchor.at);
  const local = anchor.factor === null ? 0 : anchor.factor * spent;
  const unseen = (anchor.shadow ?? 0) * elapsed;
  const pct = Math.min(100, Math.max(anchor.pct, anchor.pct + local + unseen));
  return { pct, margin: marginFor(anchor), confident: anchor.factor !== null };
}

/** How far out this prediction has been lately, plus a penalty per missed poll. */
export function marginFor(anchor) {
  const measured = 2 * (anchor?.error ?? 0);
  const penalty = MARGIN_PER_MISS * (anchor?.misses ?? 0);
  const base = anchor?.factor === null ? MARGIN_MAX : Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, measured));
  return Math.min(MARGIN_CAP, base + penalty);
}

/**
 * Fold a new endpoint reading in. The endpoint always wins.
 *
 * Three things come out of the disagreement between what we predicted and what
 * came back. A persistent *over*-read means we are missing spend — another
 * machine, a plain `claude`, claude.ai — and it is learned as a shadow rate
 * rather than logged and ignored, because it is the only way an account whose
 * usage moves without us stays predictable. A persistent under-read shrinks the
 * factor through the usual averaging. And the size of the disagreement, either
 * way, is what sets the margin every decision is then made with.
 *
 * @param {object} anchor the previous anchor, or null
 * @param {{pct: number, at: number, cost: number, reset?: boolean, priorFactor?: number}} reading
 */
export function observe(anchor, { pct, at, cost, reset = false, priorFactor = null }) {
  const seen = clampPct(pct);
  if (!anchor || reset) return anchorAt({ pct: seen, at, cost, factor: anchor?.factor ?? priorFactor });

  const predicted = predict(anchor, { cost, now: at });
  const residual = seen - predicted.pct;
  const stepPct = seen - anchor.pct;
  const stepCost = cost - anchor.cost;
  const elapsed = Math.max(1, at - anchor.at);

  let { factor } = anchor;
  if (stepPct >= MIN_STEP_PCT && stepCost >= MIN_STEP_COST) {
    const sample = stepPct / stepCost;
    const base = anchor.factor ?? priorFactor ?? sample;
    factor = anchor.factor === null ? sample : anchor.factor + FACTOR_RATE * (sample - anchor.factor);
    factor = Math.min(base * FACTOR_SPREAD, Math.max(base / FACTOR_SPREAD, factor));
  }

  // Only an over-read feeds the shadow rate. An under-read is the factor being
  // too large, which the averaging above already handles; treating it as
  // negative shadow would let the prediction fall on its own.
  const shadowSample = Math.max(0, residual) / elapsed;
  const shadow = (anchor.shadow ?? 0) + FACTOR_RATE * (shadowSample - (anchor.shadow ?? 0));
  const error = (anchor.error ?? 0) + FACTOR_RATE * (Math.abs(residual) - (anchor.error ?? 0));

  return { pct: seen, at, cost, factor, shadow, error, misses: 0 };
}

/** A poll that could not be made. The prediction stands; its guard band widens. */
export function missed(anchor) {
  if (!anchor) return anchor;
  return { ...anchor, misses: (anchor.misses ?? 0) + 1 };
}

/**
 * Whether the meter has stopped describing this account.
 *
 * A factor learned from the wrong transcripts is worse than no factor at all,
 * because it drives decisions confidently in the wrong direction. Past this
 * much disagreement the honest move is to stop predicting and go back to
 * asking.
 */
export function untrusted(anchor, { limit = 10 } = {}) {
  return Boolean(anchor && anchor.factor !== null && (anchor.error ?? 0) > limit);
}
