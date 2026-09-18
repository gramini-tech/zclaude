// What the daemon is doing, for anything that wants to look.
//
// One writer, many readers: the daemon owns this file, and the CLI and the
// editor only read it. So it is written tmp+rename, which makes a torn read
// impossible, and it carries profile names and nothing else — no addresses, no
// organisation names, no tokens — so `auto status --json` is safe to paste into
// an issue by construction rather than by remembering to redact.
//
// The file cannot know it is stale. A machine that slept has an hours-old
// heartbeat and a perfectly healthy daemon, so liveness is added by the reader
// from the lock's own four fields and the heartbeat is only ever displayed.
// Every heartbeat design that forgets this ends up killing live daemons.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../logger.js";
import { autoDir } from "./lock.js";

const STATE_VERSION = 1;
/** Enough history to see a pattern, not enough to become a log. */
const KEEP_DECISIONS = 20;

export function autoStatePath(env = process.env) {
  return join(autoDir(env), "state.json");
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    mode: "starting",
    reason: null,
    startedAt: 0,
    heartbeatAt: 0,
    active: null,
    klass: null,
    decisions: [],
    counters: { cycles: 0, polls: 0, switches: 0, refusals: 0, captures: 0 },
    accounts: {},
  };
}

/** Never throws. A missing or damaged file reads as "no daemon has run". */
export async function readAutoState(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(autoStatePath(env), "utf8"));
    if (parsed?.version !== STATE_VERSION) return emptyState();
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

export async function writeAutoState(state, env = process.env) {
  const path = autoStatePath(env);
  await mkdir(autoDir(env), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  return state;
}

/**
 * Record one decision, newest first.
 *
 * Every entry carries the numbers it was made on, because the thing that will
 * actually make this debuggable at three in the morning is being able to read
 * back why it moved, not that it moved.
 */
export function withDecision(state, decision) {
  const decisions = [decision, ...state.decisions].slice(0, KEEP_DECISIONS);
  return { ...state, decisions };
}

/** Bump one counter without the caller having to know the shape. */
export function counted(state, name, by = 1) {
  return { ...state, counters: { ...state.counters, [name]: (state.counters[name] ?? 0) + by } };
}

/**
 * The state plus what only a reader can know.
 *
 * `live` comes from the lock, never from the heartbeat: the heartbeat says when
 * the daemon last got a turn, which after a laptop sleeps is hours ago and
 * means nothing at all about whether it is running.
 *
 * @param {{env?: NodeJS.ProcessEnv, now?: number, staleAfterMs?: number}} [options]
 */
export async function describeAutoState({ env = process.env, now = Date.now(), staleAfterMs = 120_000 } = {}) {
  const state = await readAutoState(env);
  const age = state.heartbeatAt > 0 ? now - state.heartbeatAt : null;
  return { ...state, ageMs: age, stalled: age !== null && age > staleAfterMs };
}

/** Everything the daemon owns, gone. Used by `auto off` and by uninstall. */
export async function forgetAutoState(env = process.env) {
  const { rm } = await import("node:fs/promises");
  await rm(autoDir(env), { recursive: true, force: true }).catch((error) =>
    log.warn("auto", "auto directory not removed", { error }),
  );
}
