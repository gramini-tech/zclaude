// Being the router: assembling its parts, and saying where it is.
//
// Two ways one runs, and the difference is only who owns the process.
//
//   standalone   `zclaude router serve` holds the terminal, writes a state
//                file so other commands can find it, and is shared by every
//                session that starts afterwards.
//   in-process   `zclaude <profile>` starts one inside the launching zclaude,
//                on an ephemeral port, and closes it when claude exits. It
//                writes no state file, because it is nobody else's to find.
//
// A launch adopts a standalone router when one is answering, so the shared
// ledger and the local page see the traffic. Nothing here starts a background
// process: a router that outlives the command that asked for it needs a
// supervisor to bring it back, and there is no supervisor yet.
//
// The state file holds a bearer token, so it is 0600 and is never printed.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { zaiConfig, zclaudeHome } from "../config.js";
import { log } from "../logger.js";
import { pidExists } from "../sessions/liveness.js";
import { observeUsage } from "../usage/index.js";
import { listModels, resolveModel } from "./catalogue.js";
import { HOST, loadRouterConfig } from "./config.js";
import { createAffinity } from "./affinity.js";
import { createLedger } from "./ledger.js";
import { createSelector } from "./select.js";
import { createTokenCache } from "./credentials.js";
import { createControl } from "./control.js";
import { startRouter } from "./server.js";

const STATE_VERSION = 1;
/** How long a state file is trusted before its port is probed again. */
const PROBE_MS = 1500;

export function routerDir(env = process.env) {
  return join(zclaudeHome(env), "router");
}

export function routerStatePath(env = process.env) {
  return join(routerDir(env), "router.json");
}

export function routerUrl(state) {
  return `http://${HOST}:${state.port}`;
}

/**
 * Where the standalone router is, if there is one.
 *
 * A record whose process is gone is removed rather than returned: a stale file
 * naming a dead pid is how a launch ends up pointing at a closed port.
 * @returns {Promise<{pid: number, port: number, token: string, startedAt: number} | null>}
 */
export async function readRouterState(env = process.env) {
  const path = routerStatePath(env);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") log.debug("router", "router state unreadable", { error });
    return null;
  }
  const shaped =
    parsed?.version === STATE_VERSION && Number.isSafeInteger(parsed.pid) && Number.isSafeInteger(parsed.port);
  // A record from another machine sharing a home directory over NFS names pids
  // that are not ours to interpret.
  if (!shaped || parsed.host !== hostname()) return null;
  if (!pidExists(parsed.pid)) {
    log.debug("router", "clearing state for a router that is gone", { pid: parsed.pid });
    await rm(path, { force: true }).catch(() => {});
    return null;
  }
  return parsed;
}

async function writeRouterState(state, env) {
  const path = routerStatePath(env);
  await mkdir(routerDir(env), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/**
 * Whether something at this port is a router, and which.
 * @returns {Promise<{ok: boolean, port: number, pid: number, uptimeMs: number, served: number} | null>}
 */
export async function probe(url, { fetchImpl = fetch, timeoutMs = PROBE_MS } = {}) {
  try {
    const response = await fetchImpl(`${url}/__zclaude/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = /** @type {any} */ (await response.json());
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

/** Least a percentage must move before it is worth a write. */
const OBSERVE_STEP = 1;
/** And how often it is written when it barely moves at all. */
const OBSERVE_MS = 30_000;

/**
 * `observeUsage`, but not on every single response.
 *
 * These headers arrive on every answer, and an agentic session produces several
 * a second. Writing each one means a lock acquire, a read and a rewrite of
 * `usage.json` per request, against a file the menu, the watcher and the editor
 * extension all share. The numbers move slowly enough that a percentage point
 * or half a minute is plenty of resolution, and skipping the rest costs nothing
 * anybody can see.
 */
export function throttledObserver(impl = observeUsage) {
  /** @type {Map<string, {at: number, fiveHour: number | null, weekly: number | null}>} */
  const last = new Map();
  return (profile, reading, options = {}) => {
    const now = options.now ?? Date.now();
    const seen = last.get(profile);
    const fiveHour = reading?.fiveHour?.pct ?? null;
    const weekly = reading?.weekly?.pct ?? null;
    const moved =
      !seen ||
      Math.abs((fiveHour ?? 0) - (seen.fiveHour ?? 0)) >= OBSERVE_STEP ||
      Math.abs((weekly ?? 0) - (seen.weekly ?? 0)) >= OBSERVE_STEP;
    if (!moved && now - seen.at < OBSERVE_MS) return Promise.resolve(null);
    last.set(profile, { at: now, fiveHour, weekly });
    return impl(profile, reading, options);
  };
}

/**
 * Everything one request needs, built once per router.
 *
 * The account snapshot is refreshed on a timer rather than per request, and
 * the timer is unref'd so it never keeps a process alive on its own.
 */
function buildDeps({ env, config, security, fetchImpl, ledger }) {
  const selector = createSelector({ env, security, fetchImpl });
  const tokens = createTokenCache({ env, security, fetchImpl });
  const affinity = createAffinity({ enabled: config.affinity.enabled, ttlMs: config.affinity.ttlMs });
  const timer = setInterval(() => {
    selector.refresh({ now: Date.now() }).catch((error) => log.debug("router", "snapshot refresh failed", { error }));
  }, 30_000);
  timer.unref?.();

  return {
    deps: {
      config,
      selector,
      tokens,
      affinity,
      ledger,
      fetchImpl,
      // Free telemetry: a routed response carries this account's own quota
      // headers, so the usage endpoint becomes the fallback rather than the
      // only source.
      observeUsage: throttledObserver(),
      catalogue: {
        list: (options) => listModels({ security, fetchImpl, ...options }),
        resolve: resolveModel,
      },
      bases: { anthropicBase: "https://api.anthropic.com", zaiBase: zaiConfig(env).anthropicBase },
    },
    selector,
    stopTimer: () => clearInterval(timer),
  };
}

/**
 * Run a router in this process until it is closed.
 *
 * @param {{env?: NodeJS.ProcessEnv, port?: number, security?: object, fetchImpl?: typeof fetch, shared?: boolean, signals?: boolean}} options
 * @returns {Promise<{url: string, port: number, token: string, close: () => Promise<void>, until: () => Promise<void>, warnings: string[]}>}
 */
export async function serve({ env = process.env, port, security, fetchImpl, shared = true, signals = shared } = {}) {
  const { config, warnings } = await loadRouterConfig({ env });
  const ledger = createLedger();
  const { deps, selector, stopTimer } = buildDeps({ env, config, security, fetchImpl, ledger });
  // One snapshot before the first request, so the first launch of the day does
  // not pay for an inventory inside its own latency budget.
  await selector.refresh({ now: Date.now(), force: true }).catch(() => null);

  const wanted = Number.isSafeInteger(port) ? port : shared ? config.port : 0;
  const control = createControl({ env, config, ledger, selector, security, fetchImpl });
  let server;
  try {
    server = await startRouter({ env, port: wanted, deps: { ...deps, control } });
  } catch (error) {
    stopTimer();
    if (error?.code === "EADDRINUSE") {
      const running = await probe(`http://${HOST}:${wanted}`, { fetchImpl });
      const who = running ? `a zclaude router (pid ${running.pid})` : "something that is not a zclaude router";
      // Never quietly moved. A router on a port nobody was told about looks
      // healthy while answering nothing.
      throw new Error(`port ${wanted} is already held by ${who}.`, { cause: error });
    }
    throw error;
  }
  control.attach({ port: server.port, token: server.token });

  const written = shared
    ? await writeRouterState(
        { pid: process.pid, port: server.port, token: server.token, host: hostname(), startedAt: Date.now() },
        env,
      ).catch((error) => {
        log.warn("router", "router state not written", { error });
        return null;
      })
    : null;

  let closing = null;
  const close = () => {
    closing ??= (async () => {
      stopTimer();
      await server.close();
      if (written) await rm(written, { force: true }).catch(() => {});
      log.info("router", "stopped", { port: server.port });
    })();
    return closing;
  };

  /** @type {Array<() => void>} */
  const removers = [];
  if (signals) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const onSignal = () => {
        // Exit either way: a close that fails still means this router is
        // stopping, and hanging on to the terminal after Ctrl-C is worse than
        // leaving a socket for the kernel to reclaim.
        const leave = () => process.exit(0);
        close().catch(leave).then(leave).catch(leave);
      };
      process.on(signal, onSignal);
      removers.push(() => process.removeListener(signal, onSignal));
    }
  }

  return {
    url: server.url,
    port: server.port,
    token: server.token,
    warnings,
    close: async () => {
      for (const remove of removers) remove();
      await close();
    },
    // Resolves when the server closes, which is what `router serve` awaits.
    until: () =>
      new Promise((resolve) => {
        if (closing) closing.then(resolve).catch(resolve);
        else server.onClose(resolve);
      }),
  };
}

/**
 * A router for one launch: the shared one when it answers, otherwise our own.
 *
 * `close` is a no-op for an adopted router, so a session that did not start it
 * never stops it.
 *
 * @param {{env?: NodeJS.ProcessEnv, security?: object, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{url: string, token: string, adopted: boolean, close: () => Promise<void>} | null>}
 */
export async function ensureRouter({ env = process.env, security, fetchImpl } = {}) {
  const state = await readRouterState(env);
  if (state) {
    const url = routerUrl(state);
    if (await probe(url, { fetchImpl })) {
      log.info("router", "adopted the running router", { port: state.port });
      return { url, token: state.token, adopted: true, close: async () => {} };
    }
    log.warn("router", "the recorded router is not answering; starting one for this session", { port: state.port });
  }
  const own = await serve({ env, security, fetchImpl, shared: false, signals: false });
  return { url: own.url, token: own.token, adopted: false, close: own.close };
}

/**
 * Stop the standalone router.
 *
 * SIGTERM and then a wait, never SIGKILL: a router killed outright leaves live
 * streams truncated in whatever terminal was reading them.
 */
export async function stopRouter({ env = process.env, waitMs = 5000, pollMs = 100 } = {}) {
  const state = await readRouterState(env);
  if (!state) return { stopped: false, pid: null, reason: "nothing is running" };
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") {
      await rm(routerStatePath(env), { force: true }).catch(() => {});
      return { stopped: false, pid: state.pid, reason: "it had already gone" };
    }
    return { stopped: false, pid: state.pid, reason: error.message };
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!pidExists(state.pid)) break;
    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
  const gone = !pidExists(state.pid);
  if (gone) await rm(routerStatePath(env), { force: true }).catch(() => {});
  return { stopped: gone, pid: state.pid, reason: gone ? null : "it did not stop within the grace period" };
}
