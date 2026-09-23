// What the router has been doing lately.
//
// Metadata only, and that is a decision rather than an omission: no bodies, no
// prompts, not behind a flag. The most sensitive thing on the machine goes
// through this process, and a rolling buffer of it would be a liability nobody
// asked for. What is kept is the shape of the traffic, which is what somebody
// looking at a routing table actually needs: which class went where, how long
// it took, and how many tokens it cost.
//
// In memory and capped. A database here would be a second thing to migrate, a
// second thing to back up and a second thing to leak, for a view that is only
// interesting for the last few hundred requests.

/** Kept at once. Past this the oldest goes. */
export const DEFAULT_CAP = 500;

/**
 * @typedef {object} Entry
 * @property {number} at
 * @property {string} klass
 * @property {string | null} target
 * @property {string | null} model the id that actually answered
 * @property {number} status
 * @property {number} ms
 * @property {{input: number, output: number, cacheRead: number, cacheCreation: number} | null} usage
 * @property {string | null} error
 */

/** @param {{cap?: number}} [options] */
export function createLedger({ cap = DEFAULT_CAP } = {}) {
  /** @type {Entry[]} */
  const entries = [];
  const listeners = new Set();

  return {
    /** Add one. Never throws: a ledger is an aid, never a gate on a request. */
    record(entry) {
      try {
        const kept = {
          at: entry.at ?? Date.now(),
          klass: entry.klass ?? "unknown",
          target: entry.target ?? null,
          model: entry.model ?? null,
          status: entry.status ?? 0,
          ms: Math.round(entry.ms ?? 0),
          usage: entry.usage ?? null,
          error: entry.error ?? null,
        };
        entries.push(kept);
        while (entries.length > cap) entries.shift();
        for (const listener of listeners) {
          try {
            listener(kept);
          } catch {
            // A page that has gone away must not break the request that was
            // being recorded for it.
          }
        }
      } catch {
        // Nothing here is worth failing a request over.
      }
    },

    /** The most recent first, which is the order anybody reads them in. */
    recent(limit = 50) {
      return entries.slice(-limit).toReversed();
    },

    /**
     * A count per target and per class, for a page that wants a summary rather
     * than a list.
     */
    summary() {
      const byTarget = new Map();
      const byClass = new Map();
      let tokens = 0;
      for (const entry of entries) {
        const target = entry.target ?? "(none)";
        byTarget.set(target, (byTarget.get(target) ?? 0) + 1);
        byClass.set(entry.klass, (byClass.get(entry.klass) ?? 0) + 1);
        tokens += (entry.usage?.input ?? 0) + (entry.usage?.output ?? 0);
      }
      return {
        requests: entries.length,
        tokens,
        byTarget: Object.fromEntries(byTarget),
        byClass: Object.fromEntries(byClass),
      };
    },

    /** Called for every later entry, for the page's live feed. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    size() {
      return entries.length;
    },
  };
}
