// Who wants the daemon alive, and what they are allowed to ask of it.
//
// The daemon never runs on its own account. It runs because something holds a
// lease: a console session that asked to be rotated, or a VS Code window with
// the extension. When the last one lapses it exits.
//
// A lease carries both a process and a clock, and needs both. The process check
// catches the ordinary case — the terminal was closed, the editor quit — and
// the clock catches the one it cannot: an extension host that is still running
// but has stopped talking to us, and a pid on a synced home that belongs to
// somebody else's machine entirely.
//
// **A VS Code window watches; it does not rotate.** An open editor is not
// consent to move the global login. If the extension's lease granted rotation,
// an idle window plus a plain `claude` in a terminal would have zclaude moving
// that terminal's account out from under work nobody pointed it at. Watching
// still earns the daemon its keep: it holds the credential capture current and
// serves the editor's panel from a file instead of a fetch.

import { hostname } from "node:os";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { log } from "../logger.js";
import { pidExists, startToken } from "../sessions/liveness.js";
import { autoDir, bootToken } from "./lock.js";

/** Not renewed within this many multiples of its interval and it is dead. */
const STALE_MULTIPLE = 3;
/** How often a holder is expected to say it is still there. */
const RENEW_MS = 60_000;
/** What each kind of holder may ask for. */
const GRANTS = Object.freeze({ session: ["watch", "rotate"], vscode: ["watch"] });

export function leaseDir(env = process.env) {
  return join(autoDir(env), "leases");
}

/**
 * Take or renew a lease. Renewing is the same call: it is idempotent by id, so
 * a holder that renews on a timer needs no separate code path and a lease that
 * was reaped in between simply comes back.
 *
 * @param {{env?: NodeJS.ProcessEnv, kind?: string, id?: string, pid?: number, now?: number, psImpl?: import("./lock.js").PsImpl, platform?: NodeJS.Platform, runImpl?: import("./lock.js").RunImpl}} [options]
 */
export async function holdLease({
  env = process.env,
  kind = "session",
  id = randomUUID(),
  pid = process.pid,
  now = Date.now(),
  psImpl,
  platform,
  runImpl,
} = {}) {
  const dir = leaseDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = {
    id,
    kind,
    grants: GRANTS[kind] ?? ["watch"],
    pid,
    startToken: await startToken(pid, /** @type {any} */ (psImpl ? { psImpl } : {})),
    bootAt: await bootToken({ platform, runImpl }),
    host: hostname(),
    renewedAt: now,
  };
  // tmp+rename, so a reader never catches a half-written lease.
  const path = join(dir, `${id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return record;
}

/** Give one up. Best effort: a lease that outlives its holder expires anyway. */
export async function dropLease(id, env = process.env) {
  await rm(join(leaseDir(env), `${id}.json`), { force: true }).catch(() => {});
}

/**
 * Whether one lease still speaks for a living holder.
 * @param {object} lease
 */
export async function leaseAlive(lease, options = {}) {
  const { now = Date.now(), host = hostname(), boot, kill, psImpl, staleMs, platform, runImpl } = options;
  if (!lease || !Number.isSafeInteger(lease.pid)) return { live: false, reason: "it is not a lease" };
  if (lease.host && lease.host !== host) return { live: false, reason: `it belongs to ${lease.host}` };
  const bootNow = boot === undefined ? await bootToken({ platform, runImpl }) : boot;
  const sameBoot = !lease.bootAt || !bootNow || lease.bootAt === bootNow;
  if (!sameBoot) return { live: false, reason: "it is from a previous boot" };
  // The clock is checked before the process, because it is free and it is the
  // case a pid check cannot see: a holder still running but no longer talking.
  const age = now - (Number(lease.renewedAt) || 0);
  if (age > (staleMs ?? STALE_MULTIPLE * RENEW_MS)) {
    return { live: false, reason: `it has not been renewed for ${Math.round(age / 1000)}s` };
  }
  return holderAlive(lease, { kill, psImpl });
}

/** The process half of the check: is it there, and is it the same one? */
async function holderAlive(lease, { kill, psImpl }) {
  if (!pidExists(lease.pid, /** @type {any} */ (kill ? { kill } : {})))
    return { live: false, reason: `pid ${lease.pid} is gone` };
  if (!lease.startToken) return { live: true, reason: null };
  const token = await startToken(lease.pid, /** @type {any} */ (psImpl ? { psImpl } : {}));
  // A start time is not a secret; this asks whether a pid was reused.
  const same = token === lease.startToken;
  return same
    ? { live: true, reason: null }
    : { live: false, reason: `pid ${lease.pid} belongs to something else now` };
}

/**
 * Every live lease, clearing away the ones that are not.
 *
 * Reaping happens on read, the way `liveSessions` does it, because this is the
 * moment somebody is asking. Nothing else has to run for the directory to stay
 * bounded, and nothing has to have run for the answer to be right.
 *
 * @param {{env?: NodeJS.ProcessEnv, now?: number, reap?: boolean}} [options]
 * @returns {Promise<{leases: object[], reaped: number}>}
 */
export async function liveLeases(options = {}) {
  const { env = process.env, now = Date.now(), reap = true, ...checks } = options;
  const dir = leaseDir(env);
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));
  const given = /** @type {any} */ (checks);
  const boot = given.boot === undefined ? await bootToken(given) : given.boot;
  const leases = [];
  let reaped = 0;
  for (const name of names) {
    const lease = await readFile(join(dir, name), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    const alive = lease ? await leaseAlive(lease, { ...checks, now, boot }) : { live: false, reason: "unreadable" };
    if (alive.live) {
      leases.push(lease);
      continue;
    }
    reaped += 1;
    if (reap) await rm(join(dir, name), { force: true }).catch(() => {});
    log.debug("auto", "lease reaped", { name, reason: alive.reason });
  }
  return { leases, reaped };
}

/** What the live leases add up to: whether to watch, and whether to rotate. */
export function grantsOf(leases) {
  const grants = new Set(leases.flatMap((lease) => lease.grants ?? []));
  return { watch: grants.has("watch") || grants.has("rotate"), rotate: grants.has("rotate") };
}

/**
 * What the daemon should do this tick, given who still wants it.
 *
 * Zero leases does not mean exit at once. Somebody who quits a session and
 * starts another would otherwise pay a full teardown, a lock handover and a
 * burst of Keychain reads every time.
 *
 * @param {{leases: object[], emptySince?: number|null, now?: number, lingerMs?: number}} input
 * @returns {{action: "watch"|"rotate"|"linger"|"exit", emptySince: number|null, reason: string}}
 */
export function decideLifecycle({ leases, emptySince = null, now = Date.now(), lingerMs = 90_000 }) {
  if (leases.length === 0) {
    const since = emptySince ?? now;
    if (now - since >= lingerMs) return { action: "exit", emptySince: since, reason: "nothing wants it any more" };
    return { action: "linger", emptySince: since, reason: "waiting in case another session starts" };
  }
  const { rotate } = grantsOf(leases);
  const kinds = [...new Set(leases.map((lease) => lease.kind))].toSorted((a, b) => a.localeCompare(b));
  return rotate
    ? { action: "rotate", emptySince: null, reason: `${leases.length} lease(s): ${kinds.join(", ")}` }
    : { action: "watch", emptySince: null, reason: "only an editor is watching, which cannot move the login" };
}
