// Keeping a conversation on the account that holds its prompt cache.
//
// Anthropic's cache is per account. Moving a conversation to a different one
// rewrites it, and on an agentic turn cache reads are most of the input tokens,
// so a rotation in the middle of a task is expensive in a way that does not
// show up as an error anywhere. claude-rotate has no per-conversation pinning
// and names that as its cost; we can do better because the request body already
// carries enough to identify a conversation.
//
// The key is a hash of three things that are stable within a conversation and
// different between conversations:
//
//   system         Claude Code's prompt, which carries the working directory
//                  and the environment, so it scopes the key to a project
//   tool names     not the schemas, which are large and whose key order could
//                  change; the names scope it to the MCP server set
//   first user turn  scopes it to a conversation within that project
//
// The property that makes this the right key rather than a heuristic: after a
// compaction, `messages[0]` is rewritten, so the key changes and the binding is
// released. Compaction has *already* invalidated the prompt cache, so the key
// stops being valid at exactly the moment the thing it protects stops existing.
// No TTL tuning, no special case.
//
// An env-injected session id would be worse, not better. Claude Code reads
// ANTHROPIC_CUSTOM_HEADERS once at startup, so every conversation in one
// terminal would share a single value: coarser than this and no cheaper.

import { createHash } from "node:crypto";

/** Anthropic's cache lifetime. Past it there is nothing to stay near. */
export const DEFAULT_TTL_MS = 300_000;
/** A long-running router must not grow without bound for abandoned tabs. */
const MAX_ENTRIES = 2000;

/**
 * The conversation this request belongs to.
 *
 * @param {{systemText?: string, toolNames?: string[], firstUserText?: string}} request
 * @returns {string} sixteen hex characters, which is plenty to tell conversations apart
 */
export function conversationKey(request) {
  const parts = [
    "zclaude-router-1",
    typeof request?.systemText === "string" ? request.systemText : "",
    (request?.toolNames ?? []).join(","),
    request?.firstUserText ?? "",
  ];
  return createHash("sha256").update(parts.join("\u{0}")).digest("hex").slice(0, 16);
}

/**
 * A bounded map of conversation to account.
 *
 * @param {{ttlMs?: number, max?: number, enabled?: boolean}} [options]
 */
export function createAffinity({ ttlMs = DEFAULT_TTL_MS, max = MAX_ENTRIES, enabled = true } = {}) {
  /** @type {Map<string, {target: string, at: number}>} */
  const held = new Map();

  const forget = (key) => held.delete(key);

  return {
    /** Which account this conversation was last served by, if it still counts. */
    get(request, now = Date.now()) {
      if (!enabled) return null;
      const key = conversationKey(request);
      const found = held.get(key);
      if (!found) return null;
      if (now - found.at > ttlMs) {
        forget(key);
        return null;
      }
      // Re-inserted so the map's own order is least-recently-used, which is
      // what the eviction below relies on.
      held.delete(key);
      held.set(key, found);
      return found.target;
    },

    /** Remember where this conversation went. */
    bind(request, target, now = Date.now()) {
      if (!enabled || !target) return;
      const key = conversationKey(request);
      held.delete(key);
      held.set(key, { target, at: now });
      while (held.size > max) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
    },

    /** Forget it, which a quota 429 does: that account can no longer serve it. */
    release(request) {
      if (!enabled) return;
      forget(conversationKey(request));
    },

    size() {
      return held.size;
    },
  };
}
