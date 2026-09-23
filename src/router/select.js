// Which account answers this request.
//
// The route table says where a class *may* go; this says which of those places
// can take it now. Two things keep it cheap and one keeps it correct.
//
// Cheap: the account snapshot comes from a timer, not from the request path.
// `inventory()` reads the registry, every Keychain item, the renewal state and
// the usage cache; doing that per request would be several `security`
// subprocesses and possibly a network call before a single byte moves. Ranking
// against a snapshot is microseconds.
//
// Correct: this ranks with `rank()` and never with `decide()`. `decide()`
// carries dwell, a re-entry cooldown and a switch budget, which are anti-thrash
// rules for moving the global Keychain slot. That is an expensive, racy
// operation and deserves them. A router has no slot to move and can serve two
// accounts in the same millisecond, so importing those rules would make it
// refuse a perfectly good account on the grounds that it was left too recently.
//
// A penalty is a time-boxed skip held in memory. It is never a change to the
// registry: an account that hit its window at noon is fine again at five, and
// writing that down would outlive the fact.

import { log } from "../logger.js";
import { rank, rotatable } from "../auto/policy.js";
import { inventory } from "../auto/inventory.js";
import { getRegistered } from "../profiles/registry.js";

/** How often the snapshot is refreshed when nothing forces it. */
export const SNAPSHOT_MS = 30_000;

/**
 * @typedef {object} Choice
 * @property {object | null} target the resolved target, with its record attached
 * @property {string | null} reason why this one, or why none
 * @property {object[]} rest the order to fall back through
 */

/**
 * @param {{env?: NodeJS.ProcessEnv, security?: object, fetchImpl?: typeof fetch, intervalMs?: number, inventoryImpl?: typeof inventory}} [deps]
 */
export function createSelector({
  env = process.env,
  security,
  fetchImpl,
  intervalMs = SNAPSHOT_MS,
  inventoryImpl = inventory,
} = {}) {
  /** @type {{accounts: object[], at: number}} */
  let snapshot = { accounts: [], at: 0 };
  /** @type {Map<string, {until: number, why: string}>} */
  const penalties = new Map();
  /** @type {Promise<void> | null} */
  let refreshing = null;

  async function refresh({ now = Date.now(), force = false } = {}) {
    if (!force && now - snapshot.at < intervalMs) return snapshot;
    if (refreshing) {
      await refreshing;
      return snapshot;
    }
    refreshing = (async () => {
      try {
        const taken = await inventoryImpl({ env, security, fetchImpl, now, force });
        snapshot = { accounts: taken.accounts ?? [], at: now };
      } catch (error) {
        // A snapshot that cannot be taken is not a reason to refuse traffic.
        // The last one stands, and a pinned target does not need one at all.
        log.warn("router", "account snapshot failed; keeping the last one", { error });
        snapshot = { ...snapshot, at: now };
      } finally {
        refreshing = null;
      }
    })();
    await refreshing;
    return snapshot;
  }

  /** Whether this account is sitting out, and until when. */
  function penalised(name, now) {
    const held = penalties.get(name);
    if (!held) return null;
    if (held.until <= now) {
      penalties.delete(name);
      return null;
    }
    return held;
  }

  /**
   * Expand one table entry into the concrete targets it stands for.
   *
   * `profile: "auto"` becomes every eligible account in capacity order, which
   * is why a chain of `["work", "any"]` reads as "work first, then whoever has
   * room" without any extra concept.
   */
  async function expand(entry, { klass, now, excluded }) {
    if (entry.kind === "zai") {
      return penalised(entry.name, now) ? [] : [{ ...entry, record: null }];
    }
    if (entry.profile !== "auto") {
      const record = await getRegistered(entry.profile, env).catch(() => null);
      if (!record) {
        // Named rather than skipped in silence: a route pointing at a profile
        // that was removed should say so, once, rather than look like an empty
        // fleet.
        log.warn("router", "a route names a profile that is not registered", { target: entry.name });
        return [];
      }
      if (penalised(entry.profile, now) || excluded.has(entry.profile)) return [];
      return [{ ...entry, record }];
    }
    const ranked = rank(snapshot.accounts, klass, { now });
    const out = [];
    for (const { account } of ranked) {
      const skip = penalised(account.name, now) || excluded.has(account.name) || !rotatable(account).ok;
      if (skip) continue;
      const record = await getRegistered(account.name, env).catch(() => null);
      if (record) out.push({ ...entry, profile: account.name, record });
    }
    return out;
  }

  return {
    refresh,
    snapshot: () => ({ ...snapshot, accounts: [...snapshot.accounts] }),

    /**
     * The ordered list of places this request could go, best first.
     *
     * An empty list means the class is exhausted, which is what the hold is
     * for. The affinity binding, when there is one, is moved to the front
     * rather than forced: it never overrides a pin and never resurrects an
     * account that is sitting out.
     *
     * @param {{candidates: object[], klass: string, now?: number, excluded?: Set<string>, prefer?: string | null}} input
     * @returns {Promise<Choice>}
     */
    async choose({ candidates, klass, now = Date.now(), excluded = new Set(), prefer = null }) {
      const resolved = [];
      for (const entry of candidates) resolved.push(...(await expand(entry, { klass, now, excluded })));
      if (resolved.length === 0) {
        return { target: null, reason: "nothing in this class's chain can take the request", rest: [] };
      }
      const preferredAt = prefer ? resolved.findIndex((one) => (one.record?.name ?? one.name) === prefer) : -1;
      if (preferredAt > 0) {
        // Keeping a conversation on the account that holds its prompt cache is
        // worth more than a slightly emptier account, so affinity wins ties and
        // near-ties by being moved rather than by being scored.
        const [bound] = resolved.splice(preferredAt, 1);
        resolved.unshift(bound);
      }
      const [best, ...rest] = resolved;
      return {
        target: best,
        reason: preferredAt > 0 ? "it already holds this conversation's cache" : "first in the chain that can take it",
        rest,
      };
    },

    /** Sit an account out for a while, with the reason kept for the status page. */
    penalise(name, { untilMs, why, now = Date.now() }) {
      if (!name) return;
      penalties.set(name, { until: now + Math.max(0, untilMs ?? 0), why });
      log.info("router", "account sitting out", { name, forMs: untilMs, why });
    },

    /** What is sitting out and why, for `router status` and the page. */
    sittingOut(now = Date.now()) {
      const out = [];
      for (const [name] of penalties) {
        const held = penalised(name, now);
        if (held) out.push({ name, until: held.until, why: held.why });
      }
      return out;
    },
  };
}
