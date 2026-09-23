// The route table: which account or provider answers each class of model.
//
// Plain JSON at ~/.zclaude/router.json, read with `JSON.parse` and nothing
// else, on the same contract as auto.json: a missing file is normal, a
// malformed one is a warning and the built-in defaults, never an error. A
// half-parsed config that routes somewhere surprising is worse than no config.
//
// Two levels, because the same account appears in several classes. Targets are
// named once and classes reference them by name, so pinning a class is a
// one-word edit and a page can render a dropdown over a fixed set. A class's
// list is both its fallback chain and its retry order, which is one concept
// rather than two.
//
// Routes reference targets only, never other routes. `"to": ["sonnet"]` as
// shorthand would be convenient and would introduce cycles, which means a cycle
// detector, which means a class of bug for a feature nobody asked for.
//
// No model version is written down here. A Z.ai target says `latest` or
// `latest:fast` and catalogue.js resolves it against what the provider
// currently publishes, so a table written today still means "the current model"
// next year.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { zclaudeHome } from "../config.js";
import { log } from "../logger.js";

/** The classes a request can be, matching `classOf` plus the one it cannot name. */
export const ROUTE_CLASSES = Object.freeze(["fable", "opus", "sonnet", "haiku", "unknown"]);
export const TARGET_KINDS = Object.freeze(["anthropic", "zai"]);
/** Loopback only. There is no setting for this and there will not be one. */
export const HOST = "127.0.0.1";

export const DEFAULT_ROUTER_CONFIG = Object.freeze({
  _readme: Object.freeze([
    "zclaude router — which account or provider answers each class of model.",
    "",
    "targets: somewhere a request can go, named once and referenced by the",
    '  routes below. `profile: "auto"` means whichever Anthropic account has',
    "  the most room; a profile name pins it to that one. A zai target needs a",
    "  model: `latest` and `latest:fast` are resolved against what Z.ai",
    "  currently publishes, so this file does not go stale when they ship.",
    "",
    "routes: one entry per class of model Claude Code asks for. `to` is an",
    "  ordered list of target names: the first that can take the request wins,",
    "  and the rest are the order it falls back through. A list of one pins the",
    "  class — a pinned class that is spent waits and then fails rather than",
    "  quietly answering from somewhere else, which is the point of pinning.",
    "",
    "hold: what to do when nothing in the chain can take the request. The",
    "  ceiling is capped in code at 240s, comfortably inside Claude Code's own",
    "  300s stream watchdog; a longer wait would be aborted by the client.",
  ]),
  version: 1,
  enabled: false,
  mode: "session",
  port: 34_317,
  targets: Object.freeze({
    any: Object.freeze({ kind: "anthropic", profile: "auto" }),
  }),
  routes: Object.freeze({
    fable: Object.freeze({ to: ["any"] }),
    opus: Object.freeze({ to: ["any"] }),
    sonnet: Object.freeze({ to: ["any"] }),
    haiku: Object.freeze({ to: ["any"] }),
    unknown: Object.freeze({ to: ["any"] }),
  }),
  affinity: Object.freeze({ enabled: true, ttlMs: 300_000 }),
  hold: Object.freeze({ enabled: true, ceilingMs: 240_000, pollMs: 5000 }),
  limits: Object.freeze({ bodyBytes: 67_108_864, upstreamTimeoutMs: 600_000 }),
  burst: Object.freeze({ maxAttempts: 2, maxWaitMs: 10_000, quotaThresholdMs: 60_000 }),
});

/**
 * The hold ceiling is clamped here rather than left to the file.
 *
 * Claude Code aborts a silent stream after 300s on a gateway connection. A hold
 * past that is not a longer wait, it is a request the client has already given
 * up on, so no edit to this file can ask for one.
 */
export const MAX_HOLD_MS = 240_000;

export function routerConfigPath(env = process.env) {
  return join(zclaudeHome(env), "router.json");
}

/** A number inside its bounds, or the default, with a warning naming the key. */
function bounded(value, { min, max, fallback, key, warnings }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  if (clamped !== number) warnings.push(`${key} was ${number}; using ${clamped}.`);
  return clamped;
}

function readTargets(raw, warnings) {
  const targets = {};
  const given = Object.entries(raw ?? {});
  for (const [name, entry] of given) {
    if (name.startsWith("_")) continue;
    const kind = TARGET_KINDS.includes(entry?.kind) ? entry.kind : null;
    if (!kind) {
      warnings.push(`target "${name}" has no usable kind, so it was dropped.`);
      continue;
    }
    if (kind === "zai") {
      // A model is required because Z.ai will not guess one, but it is a
      // selector rather than an id: "latest" is the whole point of this file.
      const model = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : "latest";
      targets[name] = { kind, zaiProfile: typeof entry.zaiProfile === "string" ? entry.zaiProfile : null, model };
      continue;
    }
    const profile = typeof entry.profile === "string" && entry.profile.trim() ? entry.profile.trim() : "auto";
    targets[name] = {
      kind,
      profile,
      // Optional, and off by default: rewriting one Anthropic model to another
      // is a separate wish from routing, and doing it silently would be a
      // surprise every time somebody read a transcript.
      model: typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : null,
    };
  }
  return targets;
}

function readRoutes(raw, targets, warnings) {
  const routes = {};
  for (const klass of ROUTE_CLASSES) {
    const given = raw?.[klass]?.to;
    const listed = Array.isArray(given) ? given.filter((name) => typeof name === "string") : null;
    if (!listed) continue;
    const kept = listed.filter((name) => {
      if (Object.hasOwn(targets, name)) return true;
      // Named rather than swallowed. A route pointing at a target that was
      // renamed should say so, or the class silently falls through to nothing.
      warnings.push(`route "${klass}" names target "${name}", which does not exist.`);
      return false;
    });
    if (kept.length > 0) routes[klass] = { to: kept };
    else warnings.push(`route "${klass}" has no usable target left, so the default is used.`);
  }
  const keys = Object.keys(raw ?? {});
  for (const key of keys) {
    if (!key.startsWith("_") && !ROUTE_CLASSES.includes(key)) {
      warnings.push(`"${key}" is not a class of model zclaude routes, so it was ignored.`);
    }
  }
  return routes;
}

const KNOWN_KEYS = new Set([
  "_readme",
  "version",
  "enabled",
  "mode",
  "port",
  "targets",
  "routes",
  "affinity",
  "hold",
  "limits",
  "burst",
]);

/**
 * Read the route table, falling back to the defaults for anything missing.
 *
 * Never throws and never blocks a launch.
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{config: object, path: string, exists: boolean, ok: boolean, warnings: string[]}>}
 */
export async function loadRouterConfig({ env = process.env } = {}) {
  const path = routerConfigPath(env);
  const warnings = [];
  let raw;
  let exists = false;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
    exists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      warnings.push(`${path} is not valid JSON, so the built-in defaults are in use: ${error.message}`);
      log.warn("router", "route table unreadable", { error });
      exists = true;
    }
    return { config: { ...DEFAULT_ROUTER_CONFIG }, path, exists, ok: !exists, warnings };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${path} is not an object, so the built-in defaults are in use.`);
    return { config: { ...DEFAULT_ROUTER_CONFIG }, path, exists, ok: false, warnings };
  }

  const targets = { ...DEFAULT_ROUTER_CONFIG.targets, ...readTargets(raw.targets, warnings) };
  const routes = { ...DEFAULT_ROUTER_CONFIG.routes, ...readRoutes(raw.routes, targets, warnings) };

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${key} is not a setting the router knows, so it was ignored.`);
  }

  const config = {
    ...DEFAULT_ROUTER_CONFIG,
    targets,
    routes,
    enabled: raw.enabled === true,
    // Only ever "session" for now. A machine-wide mode writes into Claude
    // Code's own settings and is not built; reading one here would let a file
    // claim a state the code cannot honour.
    mode: "session",
    port: bounded(raw.port, { min: 1024, max: 65_535, fallback: DEFAULT_ROUTER_CONFIG.port, key: "port", warnings }),
    ...readNumbers(raw, warnings),
  };
  return { config, path, exists, ok: warnings.length === 0, warnings };
}

/** The clamped numeric blocks, split out to keep the reader above readable. */
function readNumbers(raw, warnings) {
  return {
    affinity: {
      enabled: raw.affinity?.enabled !== false,
      ttlMs: bounded(raw.affinity?.ttlMs, {
        min: 0,
        max: 3_600_000,
        fallback: DEFAULT_ROUTER_CONFIG.affinity.ttlMs,
        key: "affinity.ttlMs",
        warnings,
      }),
    },
    hold: {
      enabled: raw.hold?.enabled !== false,
      ceilingMs: bounded(raw.hold?.ceilingMs, {
        min: 0,
        max: MAX_HOLD_MS,
        fallback: DEFAULT_ROUTER_CONFIG.hold.ceilingMs,
        key: "hold.ceilingMs",
        warnings,
      }),
      pollMs: bounded(raw.hold?.pollMs, {
        min: 500,
        max: 60_000,
        fallback: DEFAULT_ROUTER_CONFIG.hold.pollMs,
        key: "hold.pollMs",
        warnings,
      }),
    },
    limits: {
      bodyBytes: bounded(raw.limits?.bodyBytes, {
        min: 1_048_576,
        max: 536_870_912,
        fallback: DEFAULT_ROUTER_CONFIG.limits.bodyBytes,
        key: "limits.bodyBytes",
        warnings,
      }),
      upstreamTimeoutMs: bounded(raw.limits?.upstreamTimeoutMs, {
        min: 10_000,
        max: 3_600_000,
        fallback: DEFAULT_ROUTER_CONFIG.limits.upstreamTimeoutMs,
        key: "limits.upstreamTimeoutMs",
        warnings,
      }),
    },
    burst: {
      maxAttempts: bounded(raw.burst?.maxAttempts, {
        min: 0,
        max: 5,
        fallback: DEFAULT_ROUTER_CONFIG.burst.maxAttempts,
        key: "burst.maxAttempts",
        warnings,
      }),
      maxWaitMs: bounded(raw.burst?.maxWaitMs, {
        min: 0,
        max: 60_000,
        fallback: DEFAULT_ROUTER_CONFIG.burst.maxWaitMs,
        key: "burst.maxWaitMs",
        warnings,
      }),
      quotaThresholdMs: bounded(raw.burst?.quotaThresholdMs, {
        min: 1000,
        max: 600_000,
        fallback: DEFAULT_ROUTER_CONFIG.burst.quotaThresholdMs,
        key: "burst.quotaThresholdMs",
        warnings,
      }),
    },
  };
}

/**
 * Write the table back. Used by `zclaude router route` and by the local page.
 *
 * Temp file then rename, 0600, so a crash leaves either the old table or the
 * new one. This file is the user's to edit by hand, so `_readme` is preserved
 * rather than regenerated.
 * @param {object} config
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 */
export async function writeRouterConfig(config, { env = process.env } = {}) {
  const path = routerConfigPath(env);
  const { _readme, ...rest } = config;
  const body = { _readme: _readme ?? DEFAULT_ROUTER_CONFIG._readme, ...rest };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  log.info("router", "route table written", { path });
  return path;
}

/**
 * Write the fully explained defaults, for somebody who wants to edit them.
 * @param {{env?: NodeJS.ProcessEnv, force?: boolean}} [options]
 */
export async function initRouterConfig({ env = process.env, force = false } = {}) {
  const path = routerConfigPath(env);
  if (!force) {
    try {
      await readFile(path, "utf8");
      return { written: false, path, reason: "it already exists" };
    } catch {
      // Not there, which is the case this is for.
    }
  }
  await writeRouterConfig({ ...DEFAULT_ROUTER_CONFIG }, { env });
  return { written: true, path, reason: null };
}
