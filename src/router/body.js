// What changes in a request body on the way to an upstream, and what does not.
//
// Pure, and it never mutates its input: the retry loop re-derives from the body
// it parsed once, so a transform that edited in place would make the second
// attempt a transform of the first.
//
// The list of things deliberately left alone is as important as the list of
// things changed:
//
//   system        never touched, on any path. The Claude Code prefix is part of
//                 what makes subscription traffic legitimate.
//   max_tokens    never clamped by default. Silently shortening a response is
//                 how a truncated-output bug report arrives three weeks later
//                 with no way to connect it to anything.
//   cache_control never stripped for Anthropic. Worth its own test, because
//                 "same function, strip it everywhere" is exactly the kind of
//                 simplification applied later by somebody in a hurry.

/** Blocks the Messages API allows a cache breakpoint on. */
const CACHEABLE = Object.freeze(["system", "tools", "messages"]);

/**
 * A copy with every `cache_control` removed.
 *
 * Z.ai accepts the field and reports `cache_read: 0` regardless, so leaving it
 * is nearly free. Stripped anyway for three reasons, in increasing weight: the
 * bodies get smaller, since a breakpoint sits on every system block and every
 * tool; a shim that validates the four-breakpoint limit could refuse a body
 * Anthropic accepts; and with the field gone there is no ambiguity in the
 * accounting about whether a zero cache read was a miss or an unsupported
 * feature.
 *
 * Walks only the three places the API allows them. A generic deep walk over a
 * body that can carry tens of megabytes of base64 images is a CPU problem on
 * every request, for an answer three shallow loops already give.
 */
export function stripCacheControl(body) {
  if (!body || typeof body !== "object") return body;
  const without = (entry) => {
    if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "cache_control")) return entry;
    const rest = { ...entry };
    delete rest.cache_control;
    return rest;
  };
  const next = { ...body };
  for (const key of CACHEABLE) {
    if (!Array.isArray(next[key])) continue;
    next[key] = next[key].map((entry) => {
      const cleaned = without(entry);
      if (!Array.isArray(cleaned?.content)) return cleaned;
      return { ...cleaned, content: cleaned.content.map((block) => without(block)) };
    });
  }
  return next;
}

/** A copy with `metadata` removed. */
export function stripMetadata(body) {
  if (!body || typeof body !== "object" || !Object.hasOwn(body, "metadata")) return body;
  const rest = { ...body };
  delete rest.metadata;
  return rest;
}

/**
 * Which model id actually goes on the wire.
 *
 * A Z.ai target must name one, because the shim will not guess. An Anthropic
 * target keeps what was asked for, minus the `[1m]` marker, unless the table
 * deliberately overrides it.
 */
function modelFor(target, { resolvedModel, normalized, current }) {
  const wanted = target?.kind === "zai" ? resolvedModel : (resolvedModel ?? target?.model ?? null);
  const sent = wanted ?? normalized ?? current;
  return typeof sent === "string" && sent ? sent : null;
}

/**
 * The body to send upstream, and a note of what changed.
 *
 * The model is the only field rewritten, because it is the only field in an
 * Anthropic Messages body that names a model. The `[1m]` suffix never leaves
 * here: it is a Claude Code marker rather than an API id, and the header layer
 * turns it into the beta that actually means it.
 *
 * @param {object} body the parsed request
 * @param {{name: string, kind: string, model?: string | null, stripCacheControl?: boolean, stripMetadata?: boolean}} target
 * @param {{resolvedModel?: string | null, normalized?: string}} [options]
 * @returns {{body: object, changes: string[]}}
 */
export function rewriteBody(body, target, { resolvedModel = null, normalized = "" } = {}) {
  const changes = [];
  if (!body || typeof body !== "object") return { body, changes };

  let next = { ...body };

  const sent = modelFor(target, { resolvedModel, normalized, current: next.model });
  if (sent !== null && sent !== next.model) {
    next.model = sent;
    changes.push(`model ${body.model} to ${sent}`);
  }

  const dropCache = target?.stripCacheControl ?? target?.kind === "zai";
  if (dropCache) {
    const cleaned = stripCacheControl(next);
    if (cleaned !== next) {
      next = cleaned;
      changes.push("cache_control removed");
    }
  }

  // `metadata.user_id` is an Anthropic-account-scoped identifier. Forwarding it
  // to a different provider is gratuitous, so it goes by default off-platform.
  const dropMetadata = target?.stripMetadata ?? target?.kind === "zai";
  if (dropMetadata && Object.hasOwn(next, "metadata")) {
    next = stripMetadata(next);
    changes.push("metadata removed");
  }

  return { body: next, changes };
}

/**
 * Serialize, and say how many bytes that is.
 *
 * The length is needed for `content-length`, and computing it from the same
 * string that is sent is the only way the two cannot disagree.
 */
export function serializeBody(body) {
  const text = JSON.stringify(body);
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}
