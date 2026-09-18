// What a message cost, and which class of model spent it.
//
// The usage endpoint knows how much of an account is gone but costs a request
// to ask and answers in whole percentage points. Transcripts know every
// message's token counts, cost nothing, and land within about three seconds of
// the exchange. So the endpoint anchors and this interpolates between anchors.
//
// The weights below are a prior, not a claim. They exist so the estimator has
// somewhere to start; a learned factor per account corrects them within one
// window, and the only thing a bad weight buys is polling more often than
// necessary for that window. What they must not do is be wrong by two orders of
// magnitude, which is what a raw token sum would be: cache reads are around 90%
// of the tokens in a long agentic session and nearly none in a short chat, so a
// single scalar over the raw sum would have to change by that factor whenever
// the shape of the work changed.

/** Strongest first. The order is the whole point: a class can stand in for any below it. */
const CLASSES = /** @type {const} */ (["fable", "opus", "sonnet", "haiku"]);

/**
 * Cost per class, relative to Opus. Only Fable = 2 × Opus is measured; the
 * other two are taken from published pricing and matter only for mixed-class
 * accounting.
 */
export const CLASS_WEIGHT = Object.freeze({ fable: 2, opus: 1, sonnet: 0.2, haiku: 0.04 });

/** Which token kinds count for how much, relative to a fresh input token. */
const TOKEN_WEIGHT = Object.freeze({ input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 });

/**
 * The class a model id belongs to, or null for anything that does not count.
 *
 * Null covers two different things that must both be excluded: `<synthetic>`,
 * which Claude Code writes for messages it generated itself, and every
 * non-Anthropic model. The second matters more than it looks: every profile's
 * `projects` directory is a symlink to the same tree, so a Z.ai session's
 * transcript sits beside the Anthropic ones and the path cannot tell them
 * apart. The model id is the only signal that can.
 *
 * @param {string | null | undefined} model
 * @returns {"fable" | "opus" | "sonnet" | "haiku" | null}
 */
export function classOf(model) {
  if (typeof model !== "string" || !model.startsWith("claude-")) return null;
  const found = CLASSES.find((name) => model.includes(name));
  // An unrecognised `claude-*` is treated as Opus rather than ignored: a new
  // model name appearing should make us cautious, not blind.
  return found ?? "opus";
}

/** Whether one class can do the work of another. */
export function atLeast(have, want) {
  const here = CLASSES.indexOf(have);
  const there = CLASSES.indexOf(want);
  if (here === -1 || there === -1) return false;
  return here <= there;
}

/** The stronger of two classes, either of which may be null. */
export function strongest(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return atLeast(a, b) ? a : b;
}

/**
 * The weighted token count for one message's usage block.
 * @param {{input_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number, output_tokens?: number} | null | undefined} usage
 */
export function tokenCost(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return (
    TOKEN_WEIGHT.input * n(usage.input_tokens) +
    TOKEN_WEIGHT.cacheCreation * n(usage.cache_creation_input_tokens) +
    TOKEN_WEIGHT.cacheRead * n(usage.cache_read_input_tokens) +
    TOKEN_WEIGHT.output * n(usage.output_tokens)
  );
}

/**
 * One transcript line as a cost, or null when it is not one of ours.
 * @param {object} line a parsed `.jsonl` entry
 * @returns {{at: number, class: string, cost: number, tokens: number, sessionId: string | null} | null}
 */
export function costOf(line) {
  if (line?.type !== "assistant") return null;
  const name = classOf(line.message?.model);
  if (!name) return null;
  const tokens = tokenCost(line.message?.usage);
  if (tokens <= 0) return null;
  const at = Date.parse(line.timestamp);
  if (!Number.isFinite(at)) return null;
  return { at, class: name, cost: tokens * CLASS_WEIGHT[name], tokens, sessionId: line.sessionId ?? null };
}

/**
 * The class to keep headroom for: the strongest seen in a trailing window.
 *
 * Not the newest message, which is the obvious rule and the wrong one.
 * `opusplan` downgrades Opus to Sonnet inside one session, many times over, so
 * under a newest-message rule a planning turn reports Sonnet, an account with
 * no Opus left but plenty of Sonnet looks eligible, and the next execution turn
 * is refused. A high-water mark costs up to `windowMs` of spread quality when
 * somebody genuinely steps down, and never costs a refusal.
 *
 * It needs no way to tell subagent traffic apart, which is just as well —
 * `isSidechain` is false on every assistant line this build writes. Subagent
 * and title models are configured at or below the primary one, and a maximum
 * cannot be dragged upwards by something cheaper.
 *
 * @param {Array<{at: number, class: string}>} costs
 * @param {{now?: number, windowMs?: number}} [options]
 * @returns {string | null}
 */
export function classInUse(costs, { now = Date.now(), windowMs = 30 * 60 * 1000 } = {}) {
  let best = null;
  for (const entry of costs) {
    if (now - entry.at > windowMs) continue;
    best = strongest(best, entry.class);
  }
  return best;
}
