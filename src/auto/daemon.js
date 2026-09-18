// The process around the cycle: timers, signals, and detaching.
//
// Everything that decides anything lives in `loop.js`. This file is the shell,
// and it is deliberately the only one under src/auto that contains a
// `setInterval` or a `process.on`, because a file of those is the hardest thing
// here to test and the last place a rotation decision should hide.
//
// Detaching is a safety requirement rather than a convenience. Every output
// path in zclaude writes to stderr, and the launcher's stderr is Claude Code's
// own terminal, so a warning from a rotation would scribble over a full-screen
// TUI. Worse, a `^C` reaches the whole foreground process group: with the loop
// in the launcher, that signal could land between writing a credential and
// splicing an identity, and a signal is not an exception — nothing rolls back,
// and the slot is left holding one account's token under another's name.

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { log } from "../logger.js";
import { dropLease, holdLease } from "./lease.js";
import { claimDaemonLock, sweepDead } from "./lock.js";
import { liveDeps, runOnce } from "./loop.js";
import { counted, readAutoState, writeAutoState } from "./state.js";

/** The lifecycle clock, deliberately shorter than any poll interval. */
const TICK_MS = 10_000;
/** A log that grows without bound is its own outage. */
const LOG_CAP = 1024 * 1024;

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * This installation's entry script, resolved from this file rather than argv.
 *
 * `argv[1]` under the `zclaude` shell wrapper is the wrapper, and re-running it
 * re-runs its Node search — a `find` across nvm, volta and fnm directories, a
 * hundred processes to start a watcher.
 */
export function selfScript(env = process.env) {
  const override = typeof env.ZCLAUDE_BIN === "string" && env.ZCLAUDE_BIN.trim() ? env.ZCLAUDE_BIN.trim() : null;
  return override ?? fileURLToPath(new URL("../../bin/zclaude.js", import.meta.url));
}

/**
 * Start the watcher as a detached child, and do not wait for it.
 *
 * `cwd` is the zclaude home rather than the caller's directory, because a
 * detached process holding a cwd keeps a deleted worktree pinned and dies when
 * somebody removes the branch directory underneath it.
 *
 * @param {{env?: NodeJS.ProcessEnv, spawnImpl?: typeof spawn, logPath?: string}} [options]
 */
export async function startDaemon({ env = process.env, spawnImpl = spawn, logPath } = {}) {
  const { zclaudeHome } = await import("../config.js");
  const home = zclaudeHome(env);
  const path = logPath ?? `${home}/logs/auto.log`;
  // A real file rather than "ignore": a detached process that dies from an
  // uncaught exception with nowhere to print is the worst thing here to debug.
  /** @type {number | "ignore"} */
  let fd = "ignore";
  /** @type {import("node:fs/promises").FileHandle | null} */
  let handle = null;
  try {
    const { mkdir, stat } = await import("node:fs/promises");
    await mkdir(`${home}/logs`, { recursive: true, mode: 0o700 });
    const size = await stat(path)
      .then((info) => info.size)
      .catch(() => 0);
    handle = await open(path, size > LOG_CAP ? "w" : "a", 0o600);
    ({ fd } = handle);
  } catch (error) {
    log.debug("auto", "daemon log not opened", { error });
  }
  const child = spawnImpl(process.execPath, [selfScript(env), "auto", "run", "--daemon"], {
    detached: true,
    stdio: /** @type {any} */ (["ignore", fd, fd]),
    cwd: home,
    env: { ...env, ZCLAUDE_AUTO_DAEMON: "1" },
  });
  child.unref?.();
  // The child has its own copy of the descriptor by now. Ours has to go, or it
  // is closed by the garbage collector, which Node treats as an error.
  await handle?.close().catch(() => {});
  return { started: true, pid: child.pid ?? null };
}

/**
 * Run the watcher in this process until nothing wants it.
 *
 * @param {{env?: NodeJS.ProcessEnv, deps?: object, tickMs?: number, maxTicks?: number, now?: () => number, onTick?: Function, selfLease?: boolean}} [options]
 */
export async function runDaemon({
  env = process.env,
  deps = liveDeps({ configDirs: /** @type {any} */ ((forEnv) => configDirsFor(forEnv)) }),
  tickMs = TICK_MS,
  maxTicks = Infinity,
  now = Date.now,
  onTick,
  selfLease = false,
} = {}) {
  const claim = await claimDaemonLock({ env, now: now() });
  if (!claim.claimed) {
    log.info("auto", "not starting", { reason: claim.reason });
    return { ran: false, reason: claim.reason, ticks: 0 };
  }
  await sweepDead(env);
  // A lease for the watcher itself, when one was asked for directly. Without it
  // the first tick finds nothing wanting it and starts counting down to exit —
  // the lease the launcher took belongs to the launcher, which has gone.
  const own = selfLease ? await holdLease({ env, kind: "manual", pid: process.pid, now: now() }) : null;

  const asked = { toStop: false };
  const stop = () => {
    asked.toStop = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  let state = { ...(await readAutoState(env)), mode: "starting", startedAt: now() };
  let ticks = 0;
  try {
    while (!asked.toStop && ticks < maxTicks) {
      if (own) await holdLease({ env, kind: "manual", id: own.id, pid: process.pid, now: now() });
      const result = await oneTick({ state, deps, env, now });
      ({ state } = result);
      await writeAutoState(state, env);
      await onTick?.(result);
      ticks += 1;
      if (result.exit) break;
      if (!asked.toStop && ticks < maxTicks) await wait(tickMs);
    }
  } finally {
    // Released here, and correct even if this never runs: the lock carries
    // proof of its owner, so one left behind reads as dead to whoever looks.
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await writeAutoState({ ...state, mode: "stopped" }, env).catch(() => {});
    if (own) await dropLease(own.id, env);
    await claim.release?.();
  }
  return { ran: true, reason: null, ticks };
}

/** A cycle that reports its own failure rather than ending the watch. */
async function oneTick({ state, deps, env, now }) {
  try {
    return await runOnce({ state, deps, env, now: now() });
  } catch (error) {
    log.error("auto", "cycle failed", { error });
    return { state: counted(state, "errors"), action: "error", detail: error.message, exit: false };
  }
}

/** Every config directory whose transcripts might be ours to read. */
async function configDirsFor(env) {
  const [{ listRegistered }, { defaultConfigDir }] = await Promise.all([
    import("../profiles/registry.js"),
    import("../profiles/launch.js"),
  ]);
  const profiles = await listRegistered(env).catch(() => []);
  return [defaultConfigDir(env), ...profiles.map((profile) => profile.dir)];
}

/**
 * Ask a running daemon to stop, and say whether one was there.
 *
 * SIGTERM rather than SIGKILL, so it can finish the cycle it is in: killing it
 * mid-switch is exactly how the slot ends up inconsistent.
 */
export async function stopDaemon({ env = process.env, kill = process.kill } = {}) {
  const { ownerAlive, readDaemonOwner } = await import("./lock.js");
  const owner = await readDaemonOwner(env);
  const alive = owner ? await ownerAlive(owner) : { live: false, reason: "nothing is running" };
  if (!alive.live) return { stopped: false, reason: alive.reason ?? "nothing is running", pid: owner?.pid ?? null };
  try {
    kill(owner.pid, "SIGTERM");
  } catch (error) {
    return { stopped: false, reason: error.message, pid: owner.pid };
  }
  return { stopped: true, reason: null, pid: owner.pid };
}
