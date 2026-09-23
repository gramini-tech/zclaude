// `zclaude router`: the route table, and the process that serves it.
//
// Session mode only, deliberately. A machine-wide router writes into Claude
// Code's own user settings file so that every client on the machine reaches it,
// which makes a local process a hard dependency of every Claude Code there is.
// Nothing in this repository has that property today, and a router that is down
// does not read as down: it reads as a connection refused inside somebody
// else's editor. That mode is designed and not built, and this file refuses to
// pretend otherwise.
//
// What session mode buys, with today's blast radius: `zclaude <profile>` routes
// its own requests by class, so Sonnet work can go to a GLM model while Opus
// work rotates across Anthropic accounts, inside one Claude Code session.

import { execFile } from "node:child_process";

import { listAllModels, resolveModel } from "./router/catalogue.js";
import {
  ROUTE_CLASSES,
  initRouterConfig,
  loadRouterConfig,
  routerConfigPath,
  writeRouterConfig,
} from "./router/config.js";
import { probe, readRouterState, routerUrl, serve, stopRouter } from "./router/service.js";
import { candidatesFor, validateRouteTable } from "./router/table.js";
import { EXIT, usageError } from "./errors.js";
import { log } from "./logger.js";
import { listRegistered } from "./profiles/registry.js";
import { info, paint, success, warn } from "./ui/log.js";

const grey = (text) => paint(text, "grey", process.stdout);
const label = (text) => grey(text.padEnd(10));

/** How a target reads in a chain, short enough to fit several on a line. */
function describeTarget(target) {
  if (target.kind === "zai") return `zai:${target.model}`;
  return target.profile === "auto" ? "auto" : target.profile;
}

/** Ask a running router for what it has been doing. Null when there is none. */
async function askRouter(env, path, { fetchImpl = fetch } = {}) {
  const state = await readRouterState(env);
  if (!state) return null;
  try {
    const response = await fetchImpl(`${routerUrl(state)}${path}`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(3000),
    });
    return { state, body: response.ok ? /** @type {any} */ (await response.json()) : null };
  } catch {
    return { state, body: null };
  }
}

// ------------------------------------------------------------------- status

async function cmdStatus({ env, options }) {
  const [{ config, path, exists, warnings }, state] = await Promise.all([
    loadRouterConfig({ env }),
    readRouterState(env),
  ]);
  const health = state ? await probe(routerUrl(state)) : null;

  const table = Object.fromEntries(
    ROUTE_CLASSES.map((klass) => {
      const { targets, pinned, detail } = candidatesFor(config, klass);
      return [klass, { to: targets.map((one) => describeTarget(one)), pinned, detail }];
    }),
  );

  if (options.json) {
    const running = state ? { pid: state.pid, port: state.port, live: Boolean(health), health } : null;
    process.stdout.write(
      `${JSON.stringify({ mode: config.mode, enabled: config.enabled, config: { path, exists, warnings }, running, targets: config.targets, routes: table }, null, 2)}\n`,
    );
    return EXIT.OK;
  }

  process.stdout.write(`${label("mode")}${config.mode} ${grey("(machine-wide interception is not built)")}\n`);
  if (state && health) {
    process.stdout.write(
      `${label("serving")}${routerUrl(state)} ${grey(`pid ${state.pid}, ${health.served} served`)}\n`,
    );
  } else if (state) {
    process.stdout.write(`${label("serving")}${grey(`recorded at ${routerUrl(state)}, but it is not answering`)}\n`);
  } else {
    process.stdout.write(`${label("serving")}${grey("nothing shared is running")}\n`);
    info("`zclaude router serve` starts one; a launch without it routes inside its own zclaude.");
  }
  process.stdout.write(`${label("table")}${path}${exists ? "" : grey("  (defaults; not written yet)")}\n`);
  for (const warning of warnings) warn(warning);

  const width = Math.max(...ROUTE_CLASSES.map((klass) => klass.length));
  for (const klass of ROUTE_CLASSES) {
    const entry = table[klass];
    const chain = entry.to.join(grey(" then ")) || grey("nowhere");
    process.stdout.write(`  ${klass.padEnd(width)}  ${chain}${entry.pinned ? grey("  (pinned)") : ""}\n`);
    if (entry.detail) warn(`  ${klass}: ${entry.detail}`);
  }
  return EXIT.OK;
}

// -------------------------------------------------------------------- route

async function cmdRoute({ env, args, options }) {
  const [klass, ...names] = args;
  if (!klass) {
    throw usageError("Which class of model?", `zclaude router route sonnet glm   (of: ${ROUTE_CLASSES.join(", ")})`);
  }
  if (!ROUTE_CLASSES.includes(klass)) {
    throw usageError(`"${klass}" is not a class zclaude routes.`, `One of: ${ROUTE_CLASSES.join(", ")}.`);
  }
  const { config } = await loadRouterConfig({ env });
  if (names.length === 0) {
    const { targets } = candidatesFor(config, klass);
    const chain = targets.map((one) => describeTarget(one)).join(grey(" then "));
    process.stdout.write(`${klass} ${grey("→")} ${chain || grey("nowhere")}\n`);
    return EXIT.OK;
  }

  const next = { ...config, routes: { ...config.routes, [klass]: { to: names } } };
  const profiles = (await listRegistered(env)).filter((one) => one.provider === "anthropic").map((one) => one.name);
  const { ok, errors } = validateRouteTable(next, { profiles });
  if (!ok) {
    for (const problem of errors) warn(`${problem.path}: ${problem.message}`);
    // Nothing is applied on a partial failure. A half-written table routes
    // some classes and strands others, which is harder to diagnose than a
    // refusal.
    throw usageError("The route table was not changed.");
  }
  await writeRouterConfig(next, { env });
  success(`${klass} now goes to ${names.join(", then ")}.`);
  if (names.length === 1) {
    info(`That pins ${klass}: when ${names[0]} is spent, those requests wait and then fail rather than move.`);
  }
  if (options.json) process.stdout.write(`${JSON.stringify({ klass, to: names }, null, 2)}\n`);
  return EXIT.OK;
}

// ------------------------------------------------------------------- models

async function cmdModels({ env, options, security, fetchImpl }) {
  const all = await listAllModels({ env, security, fetchImpl, force: Boolean(options.force) });
  const { config } = await loadRouterConfig({ env });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return EXIT.OK;
  }
  for (const [provider, catalogue] of Object.entries(all)) {
    const note = catalogue.detail ? `${catalogue.source}: ${catalogue.detail}` : catalogue.source;
    process.stdout.write(`${provider} ${grey(`(${note}, ${catalogue.models.length} models)`)}\n`);
    for (const model of catalogue.models.slice(0, 8)) {
      process.stdout.write(`  ${model.id}${model.fast ? grey("  fast") : ""}\n`);
    }
  }
  // What each selector resolves to today, which is the question somebody
  // editing a route table actually has.
  const zaiTargets = Object.entries(config.targets).filter(([, target]) => target.kind === "zai");
  if (zaiTargets.length > 0) process.stdout.write(`\n${grey("targets resolve to")}\n`);
  for (const [name, target] of zaiTargets) {
    const { id, detail } = resolveModel(target.model, all.zai);
    process.stdout.write(`  ${name.padEnd(12)} ${target.model.padEnd(14)} ${grey("→")} ${id ?? grey("nothing")}\n`);
    if (detail) warn(`  ${detail}`);
  }
  return EXIT.OK;
}

// -------------------------------------------------------------- the process

async function cmdServe({ env, options, security, fetchImpl }) {
  const started = await serve({
    env,
    security,
    fetchImpl,
    port: options.port === undefined ? undefined : Number(options.port),
  });
  for (const warning of started.warnings) warn(warning);
  success(`Routing on ${started.url}.`);
  info("Launches from other terminals will use this one; `zclaude router open` shows the page.");
  info("Stop it with Ctrl-C, or `zclaude router stop` from anywhere.");
  await started.until();
  return EXIT.OK;
}

async function cmdStop({ env }) {
  const stopped = await stopRouter({ env });
  if (stopped.stopped) success(`Stopped the router (pid ${stopped.pid}).`);
  else info(`Nothing stopped: ${stopped.reason}.`);
  return EXIT.OK;
}

async function cmdLog({ env, options }) {
  const wanted = Number(options.number) > 0 ? Number(options.number) : 50;
  const answer = await askRouter(env, `/__zclaude/api/log?n=${wanted}`);
  if (!answer) {
    info("No shared router is running, so there is nothing recorded.");
    info("A router started by a launch keeps its log in that process only.");
    return EXIT.OK;
  }
  if (!answer.body) throw usageError("The router is recorded but did not answer.", "Try `zclaude router status`.");
  const entries = answer.body.entries ?? [];
  if (options.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return EXIT.OK;
  }
  if (entries.length === 0) {
    info("The router has not served anything yet.");
    return EXIT.OK;
  }
  for (const entry of entries) {
    const when = new Date(entry.at).toTimeString().slice(0, 8);
    // Cache reads are most of an agentic turn's input tokens, so leaving them
    // out makes a 24k-token turn read as two.
    const cached = entry.usage?.cacheRead ? ` +${entry.usage.cacheRead}c` : "";
    const tokens = entry.usage ? `${entry.usage.input ?? 0}in/${entry.usage.output ?? 0}out${cached}` : grey("—");
    const where =
      entry.via && entry.via !== entry.target ? `${entry.target}${grey("→")}${entry.via}` : (entry.target ?? "—");
    process.stdout.write(
      `${grey(when)}  ${String(entry.status).padEnd(4)} ${entry.klass.padEnd(7)} ${where.padEnd(18)} ${String(entry.model ?? "").padEnd(28)} ${String(entry.ms).padStart(6)}ms  ${tokens}\n`,
    );
    if (entry.error) warn(`  ${entry.error}`);
  }
  return EXIT.OK;
}

async function cmdOpen({ env, options }) {
  const answer = await askRouter(env, "/__zclaude/healthz");
  if (!answer) {
    throw usageError("No shared router is running.", "Start one with `zclaude router serve`.");
  }
  const response = await fetch(`${routerUrl(answer.state)}/__zclaude/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${answer.state.token}` },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!response?.ok) throw usageError("The router would not issue a link.", "Try `zclaude router status`.");
  const { url, expiresInMs } = await response.json();

  // The link carries a single-use ticket rather than the router's token, so
  // nothing long-lived lands in browser history.
  info(`${url}  ${grey(`(single use, ${Math.round(expiresInMs / 1000)}s)`)}`);
  if (options.print) return EXIT.OK;
  await new Promise((resolve) => {
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => resolve());
  });
  return EXIT.OK;
}

// ------------------------------------------------------------------ on / off

/**
 * Turn routing on for launches from this machine.
 *
 * `--session-only` is accepted and is the only mode there is, so a script
 * written today keeps working when a machine-wide mode exists and stops meaning
 * something different the day it arrives.
 */
async function cmdOn({ env, options }) {
  if (options.machineWide) {
    throw usageError(
      "Machine-wide routing is not built.",
      "It writes into Claude Code's own user settings, which makes this process a dependency of every Claude Code on the machine. `zclaude router on` turns on session routing instead.",
    );
  }
  const { config } = await loadRouterConfig({ env });
  const profiles = (await listRegistered(env)).filter((one) => one.provider === "anthropic").map((one) => one.name);
  const { ok, errors } = validateRouteTable(config, { profiles });
  if (!ok) {
    // Refused rather than turned on with a broken table: the failure would
    // otherwise appear inside somebody's next session as a 503.
    for (const problem of errors) warn(`${problem.path}: ${problem.message}`);
    throw usageError("The route table has problems, so routing was not turned on.", `Edit ${routerConfigPath(env)}.`);
  }
  await writeRouterConfig({ ...config, enabled: true }, { env });
  success("Routing is on for sessions started by zclaude.");
  info("Plain `claude`, other terminals and the editor extension are untouched.");
  info("`zclaude router serve` runs one router for every session; without it each launch runs its own.");
  return EXIT.OK;
}

async function cmdOff({ env }) {
  const { config } = await loadRouterConfig({ env });
  await writeRouterConfig({ ...config, enabled: false }, { env });
  success("Routing is off. New launches go straight to their provider.");
  const state = await readRouterState(env);
  if (state) info("A router is still serving; `zclaude router stop` ends it. Sessions already running keep using it.");
  return EXIT.OK;
}

// -------------------------------------------------------------------- config

async function cmdConfig({ env, args, options }) {
  const [action = "show"] = args;
  if (action === "path") {
    process.stdout.write(`${routerConfigPath(env)}\n`);
    return EXIT.OK;
  }
  if (action === "init") {
    const written = await initRouterConfig({ env, force: Boolean(options.force) });
    if (written.written) success(`Wrote ${written.path}.`);
    else info(`${written.path} was left alone: ${written.reason}.`);
    return EXIT.OK;
  }
  if (action !== "show")
    throw usageError(`\`zclaude router config ${action}\` is not a command.`, "One of: show, init, path.");
  const loaded = await loadRouterConfig({ env });
  process.stdout.write(`${JSON.stringify(options.json ? loaded : loaded.config, null, 2)}\n`);
  return EXIT.OK;
}

const SUBCOMMANDS = {
  status: cmdStatus,
  on: cmdOn,
  off: cmdOff,
  routes: cmdStatus,
  route: cmdRoute,
  models: cmdModels,
  serve: cmdServe,
  stop: cmdStop,
  log: cmdLog,
  open: cmdOpen,
  config: cmdConfig,
};
export const ROUTER_SUBCOMMANDS = Object.freeze(Object.keys(SUBCOMMANDS));

/**
 * @param {{options: object, env: NodeJS.ProcessEnv}} context
 * @param {{security?: object, fetchImpl?: typeof fetch}} [deps]
 */
export function cmdRouterGroup(context, deps = {}) {
  const [sub = "status", ...rest] = context.options.args ?? [];
  if (!Object.hasOwn(SUBCOMMANDS, sub)) {
    throw usageError(`\`zclaude router ${sub}\` is not a command.`, `One of: ${ROUTER_SUBCOMMANDS.join(", ")}.`);
  }
  log.debug("router", "command", { sub });
  return SUBCOMMANDS[sub]({ ...context, ...deps, args: rest });
}
