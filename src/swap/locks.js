// Claude Code's own advisory locks, so a swap never lands in the middle of one
// of its writes.
//
// The protocol is npm `proper-lockfile`, verified against the 2.1.274 bundle
// (`oauth_refresh.lock` appears there) and documented by claude-swap, which
// read it out of 2.1.218:
//
//   - the lock is a DIRECTORY; mkdir's atomicity is the mutex
//   - the credential path takes two, in order: <configDir>/.oauth_refresh.lock
//     then the legacy <configDir>.lock, kept for tools like this one
//   - credential locks are stale after 60s and touched every 5s
//   - the config lock (<config file>.lock) is stale after 10s
//
// The race this closes is real: Claude Code's refresh reads the credential,
// talks to the token endpoint and saves, all under these locks. A swap landing
// inside that window would be overwritten by the refreshed *old* account — and
// the backup taken a moment earlier would hold a refresh token the server has
// already rotated away.
//
// A lock younger than its staleness belongs to a live holder and is never
// stolen: the holder may be stalled on a slow network while still legitimately
// owning it. We wait, then give up and say so.

import { mkdir, rm, stat, utimes } from "node:fs/promises";

import { log } from "../logger.js";

export const CREDENTIAL_STALE_MS = 60_000;
export const CONFIG_STALE_MS = 10_000;
/** Touch faster than Claude Code's 5s so a slow run is never mistaken for dead. */
const TOUCH_MS = 3000;
const DEFAULT_TIMEOUT_MS = 9000;
const RETRY_MS = 250;

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Take one lock directory, waiting for a live holder and taking over a stale
 * one. Returns a release function; call it in a finally.
 * @param {string} dir the lock directory to create
 * @param {{staleMs?: number, timeoutMs?: number, now?: () => number}} [options]
 */
export async function acquire(dir, { staleMs = CONFIG_STALE_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(dir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = await lockAge(dir);
      if (age !== null && age > staleMs) {
        log.warn("swap", "taking over a stale lock", { dir, ageMs: Math.round(age) });
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${dir} is held by another process. Claude Code holds it while it refreshes a token; try again in a moment.`,
          { cause: error },
        );
      }
      await wait(RETRY_MS);
    }
  }
  const timer = setInterval(() => {
    const when = new Date();
    utimes(dir, when, when).catch(() => {});
  }, TOUCH_MS);
  timer.unref?.();
  log.debug("swap", "lock taken", { dir });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    await rm(dir, { recursive: true, force: true }).catch((error) => log.warn("swap", "lock not removed", { error }));
  };
}

async function lockAge(dir) {
  try {
    return Date.now() - (await stat(dir)).mtimeMs;
  } catch {
    // It went away between the failed mkdir and the stat: the next loop wins it.
    return null;
  }
}

/**
 * Take several locks in order and release them in reverse, whatever happens.
 * A failure part way through releases what was taken: a half-held set is how
 * you wedge someone else's refresh.
 * @param {Array<{dir: string, staleMs?: number}>} locks
 * @param {() => Promise<any>} run
 */
export async function withLocks(locks, run, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /** @type {Array<() => Promise<void>>} */
  const releases = [];
  try {
    for (const lock of locks) {
      releases.push(await acquire(lock.dir, { staleMs: lock.staleMs, timeoutMs }));
    }
    return await run();
  } finally {
    for (const release of releases.toReversed()) await release();
  }
}

/**
 * The three locks a swap needs, in the order Claude Code takes them.
 * @param {{configDir: string, configFile: string}} paths
 */
export function swapLocks({ configDir, configFile }) {
  return [
    { dir: `${configDir}/.oauth_refresh.lock`, staleMs: CREDENTIAL_STALE_MS },
    { dir: `${configDir}.lock`, staleMs: CREDENTIAL_STALE_MS },
    { dir: `${configFile}.lock`, staleMs: CONFIG_STALE_MS },
  ];
}
