// Which headers reach an upstream, and which reach the client.
//
// A deny-list, never an allow-list. Claude Code adds headers as it gains
// features, and an allow-list silently drops the next one: the failure would be
// a feature that quietly stops working with no error anywhere. So the rule is
// to strip a known-bad set, rewrite a known set, and forward everything else
// exactly as it arrived.
//
// Two things are forwarded verbatim that a tidier proxy would replace. The
// user-agent and the `x-stainless-*` block are the client's own identity and
// its retry bookkeeping; subscription endpoints look at them, and substituting
// `zclaude/0.2` for `claude-cli/2.1.x` is a risk taken for no benefit.
//
// `x-api-key` is stripped on every path. Its presence tells Anthropic to bill
// the API rather than the plan, so a leftover is a silent billing bug rather
// than an error anybody would see.

import { BETA_HEADER } from "../usage/anthropic.js";

/** Connection-level headers that never survive a hop, in either direction. */
export const HOP_BY_HOP = Object.freeze([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** The beta that marks OAuth traffic. Without it a subscription token is refused. */
export const OAUTH_BETA = BETA_HEADER;
/** What Anthropic calls the 1M-context beta, which is what `[1m]` actually means. */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const DEFAULT_VERSION = "2023-06-01";

/** Headers we always replace or drop, whatever the client sent. */
const REWRITTEN = new Set([
  "authorization",
  "x-api-key",
  "anthropic-beta",
  "anthropic-version",
  "accept-encoding",
  "content-length",
  "content-type",
]);

/** Ours, and never leaving this machine. */
const PRIVATE_PREFIX = "x-zclaude-";

function entriesOf(incoming) {
  if (!incoming) return [];
  if (typeof incoming.entries === "function") return [...incoming.entries()];
  return Object.entries(incoming);
}

/**
 * The headers to send upstream.
 *
 * @param {{incoming?: object, target: {kind: string}, token: string, betas?: string[], oneMillion?: boolean, bodyBytes: number, allowBetas?: string[] | "passthrough" | "none"}} args
 * @returns {Record<string, string>}
 */
export function upstreamHeaders({
  incoming,
  target,
  token,
  betas = [],
  oneMillion = false,
  bodyBytes,
  allowBetas = target?.kind === "zai" ? "none" : "passthrough",
}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of entriesOf(incoming)) {
    const key = String(name).toLowerCase();
    if (HOP_BY_HOP.includes(key) || REWRITTEN.has(key) || key.startsWith(PRIVATE_PREFIX)) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  out.authorization = `Bearer ${token}`;
  out["anthropic-version"] = DEFAULT_VERSION;
  out["content-type"] = "application/json";
  // The body was rewritten, so the client's length is wrong and a stale one
  // truncates the request.
  out["content-length"] = String(bodyBytes);
  // Identity upstream, so nothing has to be decompressed and re-framed on a
  // streaming path. A decompression mismatch is the classic silent corruption
  // in a proxy like this.
  out["accept-encoding"] = "identity";

  const wanted = betasFor({ target, betas, oneMillion, allowBetas });
  if (wanted.length > 0) out["anthropic-beta"] = wanted.join(",");
  return out;
}

/**
 * Which beta values to forward.
 *
 * Anthropic gets the client's list plus the two we know it needs. Z.ai gets
 * none by default: unknown values may be rejected, and `oauth-2025-04-20` in
 * particular announces an Anthropic OAuth client to a third party for nothing.
 * A target can name an explicit list when somebody discovers one that helps.
 */
export function betasFor({
  target,
  betas = [],
  oneMillion = false,
  allowBetas = /** @type {string[] | "passthrough" | "none"} */ ("passthrough"),
}) {
  if (Array.isArray(allowBetas)) return [...new Set(betas.filter((beta) => allowBetas.includes(beta)))];
  if (allowBetas === "none") return [];
  const wanted = new Set(betas);
  if (target?.kind === "anthropic") {
    // A subscription token is refused without this, so it is added rather than
    // relied on: the client sends it today and may not tomorrow.
    wanted.add(OAUTH_BETA);
    if (oneMillion) wanted.add(CONTEXT_1M_BETA);
  }
  return [...wanted];
}

/** Headers to drop on the way back, whatever the upstream said. */
const DOWNSTREAM_DROPPED = new Set([
  ...HOP_BY_HOP,
  // We asked for identity. If a shim compressed anyway, fetch has already
  // decoded it, so passing this on would be a lie that breaks the client.
  "content-encoding",
  // Set by Node from the stream itself; a stale one truncates the response.
  "content-length",
]);

/**
 * The headers to send back to Claude Code.
 *
 * `retry-after` and the `anthropic-ratelimit-*` block are forwarded rather than
 * swallowed: Claude Code's own backoff reads the first, and forwarding the rest
 * means its status display describes the account that actually answered.
 *
 * The four `x-zclaude-*` headers cost nothing, since an unknown header is
 * ignored, and are the difference between "the router did something odd" and a
 * one-line `curl -D-` answer.
 *
 * @param {object} upstream the upstream response headers
 * @param {{target: string, klass: string, model: string, attempt: number}} about
 */
export function downstreamHeaders(upstream, { target, klass, model, attempt }) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of entriesOf(upstream)) {
    const key = String(name).toLowerCase();
    if (DOWNSTREAM_DROPPED.has(key)) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  out["x-zclaude-target"] = target;
  out["x-zclaude-class"] = klass;
  out["x-zclaude-model"] = model;
  out["x-zclaude-attempt"] = String(attempt);
  return out;
}
