// One daemon per machine, and artefacts that identify themselves as dead.
//
// The hard part of a singleton is not taking the lock. It is what happens when
// the holder never gets to let go: SIGKILL runs no handler, and a power cut
// runs nothing at all. A design that depends on the dying process cleaning up
// leaves a stale lock and a feature that never starts again.
//
// So nothing here trusts a cleanup that may not have happened. Liveness is
// re-derived from four fields every time anything reads the lock, and a lock
// whose owner is gone reads as dead to the next claimant, to `auto status` and
// to the editor alike:
//
//   host        ~/.zclaude can be synced. Without this, machine A's pids
//               "exist" on machine B and B would rotate the login while A works.
//   bootAt      everything written before a crash-reboot is unconditionally
//               dead, with no ps call and no staleness guess. This is the whole
//               answer to "the host crashes".
//   pid         necessary, and nowhere near sufficient on its own.
//   startToken  process ids are recycled; the start time says it is the same
//               process we recorded. Reused from the session tracker, which has
//               the same problem for the same reason.
//
// Stealing a dead lock is a rename, never a remove. `rename` is atomic, so of
// two simultaneous stealers exactly one wins and the loser gets ENOENT and
// retries. `swap/locks.js` steals with rm and loops, which lets a third stealer
// delete a lock somebody just created — harmless there, where a loser only
// waits, and not harmless here, where the cost is two processes rotating one
// login.

import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { VERSION, zclaudeHome } from "../config.js";
import { log } from "../logger.js";
import { pidExists, startToken } from "../sessions/liveness.js";

/**
 * The three things these modules shell out for, injected so tests never do.
 * @typedef {(file: string, args: string[], options?: {timeoutMs?: number}) => Promise<string>} RunImpl
 * @typedef {(args: string[], options?: {timeoutMs?: number}) => Promise<string>} PsImpl
 * @typedef {(pid: number, signal?: string | number) => boolean} KillImpl
 */

/** Where the daemon keeps everything it owns. */
export function autoDir(env = process.env) {
  return join(zclaudeHome(env), "auto");
}

export function lockDir(env = process.env) {
  return join(autoDir(env), "daemon.lock");
}

function run(file, args, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout) => resolve(error ? "" : String(stdout ?? "")));
  });
}

/**
 * When this machine last booted, as a string that changes across a reboot.
 *
 * Null when it cannot be read, which is honest rather than convenient: a made-up
 * value would make every artefact look like it came from this boot, which is the
 * opposite of what this field is for. A null simply falls back to the pid and
 * start-time checks, which are what we had before.
 *
 * @param {{platform?: NodeJS.Platform, runImpl?: RunImpl}} [options]
 * @returns {Promise<string | null>}
 */
export async function bootToken({ platform = process.platform, runImpl = /** @type {RunImpl} */ (run) } = {}) {
  if (platform === "darwin") {
    // `{ sec = 1789461341, usec = 227633 } Tue Sep 15 14:05:41 2026`
    const out = await runImpl("sysctl", ["-n", "kern.boottime"]);
    const seconds = out.match(/sec\s*=\s*(\d+)/u)?.[1];
    return seconds ?? null;
  }
  if (platform === "linux") {
    const stat = await readFile("/proc/stat", "utf8").catch(() => "");
    return stat.match(/^btime\s+(\d+)$/mu)?.[1] ?? null;
  }
  return null;
}

/** This process, as a claim anybody else can check. */
/**
 * @param {{now?: number, platform?: NodeJS.Platform, runImpl?: RunImpl, psImpl?: PsImpl}} [options]
 */
async function selfOwner({ now = Date.now(), platform, runImpl, psImpl } = {}) {
  return {
    pid: process.pid,
    startToken: await startToken(process.pid, /** @type {any} */ (psImpl ? { psImpl } : {})),
    bootAt: await bootToken({ platform, runImpl }),
    host: hostname(),
    startedAt: now,
    zclaude: VERSION,
  };
}

export async function readDaemonOwner(env = process.env) {
  try {
    const path = join(lockDir(env), "owner.json");
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether a recorded owner is a process that is really still there.
 *
 * All four have to agree. Any one of them failing means the lock is free, and
 * the reason is carried so `auto status` can say "from a previous boot" rather
 * than the unhelpful "not running".
 *
 * @param {object | null} owner
 * @param {{host?: string, boot?: string | null, kill?: KillImpl, psImpl?: PsImpl, platform?: NodeJS.Platform, runImpl?: RunImpl}} [options]
 * @returns {Promise<{live: boolean, reason: string | null}>}
 */
export async function ownerAlive(owner, { host = hostname(), boot, kill, psImpl, platform, runImpl } = {}) {
  if (!owner || !Number.isSafeInteger(owner.pid)) return { live: false, reason: "there is no owner recorded" };
  if (owner.host && owner.host !== host) return { live: false, reason: `it belongs to ${owner.host}` };
  // Read the same way the owner recorded it. Reading it any other way makes a
  // live lock look like it came from a previous boot, which would have this
  // steal its own lock and produce exactly the two daemons it exists to stop.
  const bootNow = boot === undefined ? await bootToken({ platform, runImpl }) : boot;
  // Only a mismatch proves anything. Two nulls mean we could not read the boot
  // time here or there, which is a reason to fall through to the pid checks
  // rather than to declare a live daemon dead.
  const sameBoot = !owner.bootAt || !bootNow || owner.bootAt === bootNow;
  if (!sameBoot) {
    return { live: false, reason: "it is from a previous boot" };
  }
  if (!pidExists(owner.pid, /** @type {any} */ (kill ? { kill } : {})))
    return { live: false, reason: `pid ${owner.pid} is gone` };

  // time is not a secret; this compares whether a pid was reused.
  const sameProcess =
    !owner.startToken ||
    (await startToken(owner.pid, /** @type {any} */ (psImpl ? { psImpl } : {}))) === owner.startToken;
  if (!sameProcess) return { live: false, reason: `pid ${owner.pid} belongs to something else now` };
  return { live: true, reason: null };
}

/**
 * Become the daemon, or report who already is.
 *
 * @param {{env?: NodeJS.ProcessEnv, now?: number, attempts?: number, platform?: NodeJS.Platform, runImpl?: RunImpl, psImpl?: PsImpl, kill?: KillImpl}} [options]
 * @returns {Promise<{claimed: boolean, owner: object|null, reason: string|null, release?: () => Promise<void>}>}
 */
export async function claimDaemonLock(options = {}) {
  const { env = process.env, attempts = 2 } = options;
  const dir = lockDir(env);
  const mine = await selfOwner(/** @type {any} */ (options));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(dir, { recursive: false });
    } catch (error) {
      if (error?.code === "ENOENT") {
        await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
        continue;
      }
      if (error?.code !== "EEXIST") throw error;
      const held = await readDaemonOwner(env);
      const alive = await ownerAlive(held, /** @type {any} */ (options));
      if (alive.live) return { claimed: false, owner: held, reason: "another daemon is already running" };
      if (held?.host && held.host !== mine.host) {
        // Not ours to steal. Two machines rotating one login is the failure
        // this whole file exists to prevent, so refuse rather than guess.
        return { claimed: false, owner: held, reason: `another machine (${held.host}) is watching this home` };
      }
      log.info("auto", "taking over a dead daemon lock", { reason: alive.reason });
      await rename(dir, `${dir}.dead.${process.pid}.${attempt}`).catch(() => {});
      continue;
    }
    await writeFile(join(dir, "owner.json"), `${JSON.stringify(mine, null, 2)}\n`, { mode: 0o600 });
    return { claimed: true, owner: mine, reason: null, release: () => releaseLock(env) };
  }
  return { claimed: false, owner: await readDaemonOwner(env), reason: "the lock kept changing hands" };
}

async function releaseLock(env) {
  await rm(lockDir(env), { recursive: true, force: true }).catch((error) =>
    log.warn("auto", "daemon lock not removed", { error }),
  );
}

/**
 * Clear away the `.dead.*` directories stealing leaves behind.
 *
 * Nothing depends on this having run — a stale artefact is already harmless,
 * because liveness is derived rather than trusted. It is only so the directory
 * cannot grow without bound however many crashes it takes to get there.
 */
export async function sweepDead(env = process.env) {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(autoDir(env)).catch(() => []);
  const dead = names.filter((name) => name.startsWith("daemon.lock.dead."));
  for (const name of dead) await rm(join(autoDir(env), name), { recursive: true, force: true }).catch(() => {});
  return dead.length;
}
