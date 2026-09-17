// A small store so a list can render before its numbers exist.
//
// Fetching usage for four accounts means four HTTP round trips, and a picker
// that waits for the slowest of them feels broken. The store hands out what it
// knows immediately, fetches in the background, and tells subscribers as each
// answer lands.

import { log } from "../logger.js";
import { usageForAll } from "./index.js";

/**
 * @param {Array<{name: string, provider: string, dir?: string}>} records
 * @param {object} [options] passed through to usageForAll
 */
export function createUsageStore(records, options = {}) {
  /** @type {Map<string, object>} */
  const state = new Map();
  const listeners = new Set();
  let pending = 0;
  let lastError = null;

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log.debug("usage", "subscriber threw", { error });
      }
    }
  };

  return {
    /** What is known about one profile right now, or undefined. */
    get: (name) => state.get(name),
    /** True while a fetch is in flight, which is what a spinner should follow. */
    get loading() {
      return pending > 0;
    },
    get error() {
      return lastError;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Fetch every record. `force` skips the cache, which is what a refresh key
     * or a refresh button is for: it is also the retry after a failure.
     */
    async load({ force = false } = {}) {
      pending += 1;
      lastError = null;
      emit();
      try {
        await usageForAll(records, {
          ...options,
          force,
          onResult: (name, usage) => {
            state.set(name, usage);
            emit();
          },
        });
      } catch (error) {
        lastError = error;
        log.warn("usage", "usage load failed", { error });
      } finally {
        pending -= 1;
        emit();
      }
    },
  };
}
