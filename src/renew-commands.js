// `zclaude renew`: the scheduled job that keeps profile logins alive, and the
// commands to install it, inspect it and run it by hand.

import { EXIT, usageError } from "./errors.js";
import { zclaudeHome } from "./config.js";
import { log } from "./logger.js";
import { listRegistered } from "./profiles/registry.js";
import { describeResult, runRenewal } from "./renew/job.js";
import { INTERVAL_SECONDS, install, status, uninstall } from "./renew/schedule.js";
import { readRenewState } from "./renew/state.js";
import { info, paint, success, warn } from "./ui/log.js";
import { join } from "node:path";

const grey = (text) => paint(text, "grey", process.stdout);

/** The command a scheduler should run: this installation, not whatever is on PATH. */
export function selfBinary(env = process.env, argv = process.argv) {
  const fromEnv = typeof env.ZCLAUDE_BIN === "string" && env.ZCLAUDE_BIN.trim() ? env.ZCLAUDE_BIN.trim() : null;
  return fromEnv ?? argv[1] ?? "zclaude";
}

async function cmdRun({ options, env, security, fetchImpl }) {
  const { results, stopped, rotates } = await runRenewal({ env, security, fetchImpl, force: Boolean(options.force) });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results, stopped, rotates }, null, 2)}\n`);
    return EXIT.OK;
  }
  if (results.length === 0) {
    info("No Anthropic profiles to keep alive.");
    return EXIT.OK;
  }
  const width = Math.max(...results.map((entry) => entry.profile.length));
  for (const entry of results) process.stdout.write(`${entry.profile.padEnd(width)}  ${describeResult(entry)}\n`);
  if (stopped) warn(`Stopped early: ${stopped}`);
  return EXIT.OK;
}

async function cmdInstall({ env, options, platform }) {
  const profiles = (await listRegistered(env)).filter((profile) => profile.provider === "anthropic");
  if (profiles.length === 0 && !options.force) {
    info("There are no Anthropic profiles to keep alive yet, so nothing was scheduled.");
    info("Run this again after `zclaude profile add`, or pass --force to schedule it anyway.");
    return EXIT.OK;
  }
  const result = await install({ binary: selfBinary(env), env, platform, logDir: join(zclaudeHome(env), "logs") });
  if (result.installed) {
    success(`Scheduled with ${result.mechanism}${result.path ? ` (${result.path})` : ""}.`);
    info(`It runs every ${INTERVAL_SECONDS / 3600} hours and refreshes only what is about to expire.`);
    return EXIT.OK;
  }
  if (result.mechanism === "schtasks") {
    info("On Windows, schedule it yourself with:");
    process.stdout.write(`${result.command}\n`);
    return EXIT.OK;
  }
  throw usageError(`Could not schedule the renewal with ${result.mechanism}.`, result.detail);
}

async function cmdUninstall({ env, platform }) {
  const result = await uninstall({ env, platform });
  if (result.removed.length === 0) info("Nothing was scheduled.");
  else success(`Removed: ${result.removed.join(", ")}.`);
  return EXIT.OK;
}

async function cmdStatus({ env, options, platform }) {
  const [schedule, state] = await Promise.all([status({ env, platform }), readRenewState(env)]);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ schedule, ...state }, null, 2)}\n`);
    return EXIT.OK;
  }
  const label = (text) => grey(text.padEnd(12));
  const lines = [
    `${label("schedule")}${schedule.installed ? `${schedule.mechanism}${schedule.loaded === false ? " (written, not loaded)" : ""}` : "not scheduled"}`,
    schedule.path ? `${label("")}${schedule.path}` : null,
    `${label("last run")}${state.lastRun ?? "never"}`,
  ];
  const lastResults = Object.entries(state.results ?? {});
  for (const [name, entry] of lastResults) {
    lines.push(`${label(name)}${entry.state} ${grey(entry.at ?? "")}`.trimEnd());
  }
  const quarantined = Object.entries(state.quarantined ?? {});
  for (const [name, entry] of quarantined) {
    lines.push(`${label(name)}needs signing in again ${grey(`since ${entry.at}`)}`);
  }
  if (state.rotates !== null) {
    lines.push(
      `${label("rotation")}${state.rotates ? "your account rotates refresh tokens, so renewing keeps the lineage alive" : "your account keeps the same refresh token across renewals"}`,
    );
  }
  process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
  if (schedule.installed && schedule.binary && !schedule.binary.includes("zclaude")) {
    warn(`The scheduled command is ${schedule.binary}, which does not look like zclaude any more.`);
  }
  return EXIT.OK;
}

const SUBCOMMANDS = { run: cmdRun, install: cmdInstall, uninstall: cmdUninstall, status: cmdStatus };
export const RENEW_SUBCOMMANDS = Object.freeze(Object.keys(SUBCOMMANDS));

/**
 * @param {{options: object, env: NodeJS.ProcessEnv}} context
 * @param {{security?: import("./swap/keychain.js").SecurityRunner, fetchImpl?: typeof fetch, platform?: NodeJS.Platform}} [deps]
 */
export function cmdRenewGroup(context, deps = {}) {
  const [sub = "status", ...rest] = context.options.args ?? [];
  if (!Object.hasOwn(SUBCOMMANDS, sub)) {
    throw usageError(`\`zclaude renew ${sub}\` is not a command.`, `One of: ${RENEW_SUBCOMMANDS.join(", ")}.`);
  }
  log.debug("renew", "command", { sub });
  return SUBCOMMANDS[sub]({ ...context, ...deps, args: rest });
}
