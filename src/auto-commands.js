// `zclaude auto`: rotating the global login by usage.
//
// Reading only, for now. It shows every account the way the scheduler sees it
// and says what it would do, and it switches nothing — the daemon that acts on
// this is not built yet, and `auto status` says so rather than implying
// otherwise. A rotation scheduler is exactly the kind of thing that has to earn
// trust before it is allowed to move anything, and this is where that happens.
//
// Not to be confused with `zclaude auto-mode`, which is one of Claude Code's
// own commands and is forwarded to it untouched.

import { EXIT, usageError } from "./errors.js";
import { log } from "./logger.js";
import { autoConfigPath, initAutoConfig, loadAutoConfig } from "./auto/config.js";

import { duplicates, inventory } from "./auto/inventory.js";
import { dropLease, grantsOf, holdLease, liveLeases } from "./auto/lease.js";
import { ownerAlive, readDaemonOwner } from "./auto/lock.js";
import { runDaemon, startDaemon, stopDaemon } from "./auto/daemon.js";
import { autoStatePath, describeAutoState, forgetAutoState } from "./auto/state.js";
import { binding, capacity, decide, eligibility, ladderStep, rank, rotatable } from "./auto/policy.js";
import { countdown } from "./usage/when.js";
import { info, paint, success, warn } from "./ui/log.js";

const grey = (text) => paint(text, "grey", process.stdout);
const label = (text) => grey(text.padEnd(12));

/** What class to reason about when nothing is running to read one from. */
const DEFAULT_CLASS = "opus";

async function snapshot({ env, security, fetchImpl, now, options }) {
  const { config, path, exists, warnings } = await loadAutoConfig({ env });
  const { accounts, active, slot } = await inventory({
    env,
    security,
    fetchImpl,
    now,
    tiers: config.tiers,
    force: Boolean(options?.force),
  });
  const klass = options?.class ?? DEFAULT_CLASS;
  const daemon = await describeDaemon({ env, now });
  return { config, path, exists, warnings, accounts, active, slot, klass, daemon };
}

/**
 * Whether a daemon holds the lock, and what the live leases let it do.
 *
 * Liveness is re-derived rather than trusted, so a lock left behind by a
 * SIGKILL or a power cut reads as what it is instead of as a running daemon.
 */
async function describeDaemon({ env, now }) {
  const owner = await readDaemonOwner(env);
  const alive = owner ? await ownerAlive(owner) : { live: false, reason: null };
  const { leases } = await liveLeases({ env, now });
  const recorded = await describeAutoState({ env, now });
  return { owner, ...alive, leases, grants: grantsOf(leases), recorded, statePath: autoStatePath(env) };
}

/** One line per account: who it is, how full, and whether it could take work. */
const PLAN_WIDTH = 24;
const TIGHTEST_WIDTH = 14;
const CAPACITY_WIDTH = 11;

/** Padded to a width, or cut with an ellipsis that says it was cut. */
function fit(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function planText(account) {
  if (!account.tier) return "unknown plan";
  return account.tierKnown ? account.tier : `${account.tier} (unknown)`;
}

/**
 * The tightest binding window, or why there is no number.
 *
 * A login that expired must never render as "0%" — the cache serves its last
 * good numbers when a lookup fails, and a row reading zero is exactly how a
 * naive scheduler decides an exhausted account is the emptiest one.
 */
function tightestText(account, { klass, now }) {
  if (!account.windows || account.state === "dead" || account.state === "unauthorized") {
    return account.state === "ok" ? "no usage" : account.state;
  }
  const full = binding(account, klass, { now });
  return `${String(Math.round(full.pct)).padStart(3)}% ${full.window ?? ""}`.trimEnd();
}

function accountLine(account, { klass, now, step, width }) {
  const usable = rotatable(account);
  const left = usable.ok ? `${capacity(account, klass, { now, step }).toFixed(2)} left` : "";
  const why = usable.ok ? eligibility(account, klass, { now, step }).reason : usable.reason;
  return [
    `  ${account.name.padEnd(width)}`,
    grey(fit(planText(account), PLAN_WIDTH)),
    fit(tightestText(account, { klass, now }), TIGHTEST_WIDTH),
    grey(fit(left, CAPACITY_WIDTH)),
    why ? grey(why) : "",
  ]
    .join(" ")
    .trimEnd();
}

async function cmdStatus(context) {
  const { options, env, security, fetchImpl, now = Date.now() } = context;
  const state = await snapshot({ env, security, fetchImpl, now, options });
  const { accounts, active, klass, config } = state;
  const shared = { now, allowCrossOrg: config.allowCrossOrg, ladder: config.ladder };
  const step = ladderStep(accounts, klass, shared);
  const order = rank(accounts, klass, { ...shared, step });
  const choice = decide({ accounts, active, klass, ...shared, step });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          running: state.daemon.live,
          rotating: state.daemon.live && state.daemon.grants.rotate,
          daemon: { owner: state.daemon.owner, reason: state.daemon.reason, leases: state.daemon.leases },
          class: klass,
          active,
          ladderStep: step,
          decision: choice,
          order: order.map((entry) => ({ profile: entry.account.name, capacity: entry.capacity })),
          accounts,
          config: { path: state.path, exists: state.exists, warnings: state.warnings },
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  for (const warning of state.warnings) warn(warning);
  for (const names of duplicates(accounts)) {
    warn(`${names.join(" and ")} are the same account, so switching between them would move nothing.`);
  }
  if (accounts.length === 0) {
    info("No profiles yet, so there is nothing to rotate between. Start with `zclaude profile add`.");
    return EXIT.OK;
  }

  const width = Math.max(...accounts.map((account) => account.name.length), 7);
  const lines = [
    `${label("rotating")}${rotatingText(state.daemon)}`,
    `${label("model")}${klass}${options.class ? "" : grey("  (the default; pass --class to ask about another)")}`,
    `${label("holding")}${active ?? grey("nobody zclaude knows about")}`,
    `${label("leave at")}${step}%${grey(step === config.ladder[0] ? "  (everyone still has room)" : "  (everyone has passed the first rung)")}`,
    "",
    grey(
      `  ${"profile".padEnd(width)} ${"plan".padEnd(PLAN_WIDTH)} ${"tightest".padEnd(TIGHTEST_WIDTH)} ${"capacity".padEnd(CAPACITY_WIDTH)} why not`,
    ),
    ...accounts.map((account) => accountLine(account, { klass, now, step, width })),
    "",
    `${label("would")}${describeDecision(choice, now, accounts)}`,
    `${label("inventory")}${state.exists ? state.path : grey(`${state.path} (not created; defaults in use)`)}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.OK;
}

/**
 * The first line, and the one that has to be honest: a rotation daemon nobody
 * asked for, quietly doing nothing, is worse than one that is plainly absent.
 */
function rotatingText(daemon) {
  if (!daemon.live) {
    const stale = daemon.owner ? grey(`  (a lock is left over: ${daemon.reason})`) : "";
    return `no — nothing is watching. This is what it would do.${stale}  ${grey("Start it with `zclaude auto run`.")}${stale}`;
  }
  const holders = daemon.leases.map((lease) => lease.kind).join(", ");
  // Heartbeat age is shown and never used to decide liveness: a machine that
  // slept has an hours-old heartbeat and a perfectly healthy daemon.
  const age = daemon.recorded.ageMs === null ? "" : grey(`  (checked ${Math.round(daemon.recorded.ageMs / 1000)}s ago`);
  const stalled = daemon.recorded.stalled ? grey(", which is longer ago than expected)") : age ? grey(")") : "";
  return daemon.grants.rotate
    ? `yes — pid ${daemon.owner.pid}, held by ${holders}${age}${stalled}`
    : `watching only — pid ${daemon.owner.pid}, held by ${holders}, which cannot move the login${age}${stalled}`;
}

function describeDecision(choice, now, accounts) {
  const target = accounts.find((account) => account.name === choice.target);
  switch (choice.action) {
    case "switch": {
      return `switch to ${choice.target} — ${choice.reason}`;
    }
    case "stay": {
      return `stay on ${choice.target} — ${choice.reason}`;
    }
    case "park": {
      const resets = target?.windows?.weekly?.resetsAt ?? target?.windows?.fiveHour?.resetsAt;
      const when = resets ? ` (in ${countdown(resets, now)})` : "";
      return `wait on ${choice.target}${when} — ${choice.reason}`;
    }
    default: {
      return `nothing — ${choice.reason}`;
    }
  }
}

async function cmdConfig(context) {
  const { options, env, args } = context;
  const [what = "show"] = args;
  if (what === "path") {
    process.stdout.write(`${autoConfigPath(env)}\n`);
    return EXIT.OK;
  }
  if (what === "init") {
    const result = await initAutoConfig({ env, force: Boolean(options.force) });
    if (result.written) success(`Wrote the defaults to ${result.path}. Every key is optional; delete any to undo it.`);
    else info(`${result.path} was left alone because ${result.reason}. Pass --force to overwrite it.`);
    return EXIT.OK;
  }
  if (what !== "show") {
    throw usageError(`\`zclaude auto config ${what}\` is not a command.`, "One of: show, path, init.");
  }
  const { config, path, exists, warnings } = await loadAutoConfig({ env });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ path, exists, warnings, config }, null, 2)}\n`);
    return EXIT.OK;
  }
  for (const warning of warnings) warn(warning);
  info(exists ? `From ${path}:` : `${path} does not exist, so these are the built-in defaults:`);
  // The explanation is in the file itself; printing it back would bury the
  // handful of numbers somebody ran this to see.
  const settings = Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith("_")));
  process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
  return EXIT.OK;
}

/**
 * Run the watcher. `--daemon` means "this process is it"; without it the
 * watcher is started detached and this returns immediately.
 */
async function cmdRun(context) {
  const { options, env, interactive } = context;
  if (options.dryRun && !options.daemon) {
    // In the foreground on purpose: a dry run is something you sit and read.
    info("Deciding out loud, switching nothing. Ctrl-C stops it.");
    await runDaemon({
      env,
      selfLease: true,
      dryRun: true,
      onTick: (tick) => {
        info(`${tick.action}: ${tick.detail ?? ""}`.trimEnd());
      },
    });
    return EXIT.OK;
  }
  if (!options.daemon) {
    const { started, pid } = await startDaemon({ env, selfLease: true });
    if (!started) throw usageError("The watcher could not be started.");
    success(`Watching in the background (pid ${pid}).`);
    info("`zclaude auto off` stops it. `zclaude auto status` says what it is doing.");
    return EXIT.OK;
  }
  if (interactive) info("Running the watcher here. Ctrl-C stops it.");
  const result = await runDaemon({
    env,
    selfLease: Boolean(options.selfLease),
    dryRun: Boolean(options.dryRun),
    onTick: options.dryRun
      ? (tick) => {
          info(`${tick.action}: ${tick.detail ?? ""}`.trimEnd());
        }
      : undefined,
  });
  if (!result.ran) {
    info(`Not started: ${result.reason}`);
    return EXIT.OK;
  }
  return EXIT.OK;
}

/** Stop the watcher and clear what it owns. The slot stays where it is. */
async function cmdOff(context) {
  const { env } = context;
  const stopped = await stopDaemon({ env });
  if (stopped.stopped) success(`Asked the watcher (pid ${stopped.pid}) to stop.`);
  else info(`Nothing to stop: ${stopped.reason}.`);
  await forgetAutoState(env);
  info("The global login is wherever it was; `zclaude switch --status` says who holds it.");
  return EXIT.OK;
}

/**
 * Take or renew a lease, for a holder that is not a zclaude session.
 *
 * The editor calls this on activation and on its own timer. It is idempotent by
 * id, so renewing is the same call and a lease reaped in between simply comes
 * back — which is why the extension needs no second code path and no state of
 * its own beyond the id it was given.
 */
async function cmdAttach(context) {
  const { options, env, args } = context;
  const [kind = "vscode", id] = args;
  // Whose lease this is. The caller is a short-lived `zclaude` process that
  // exits the moment it has printed the id, so without this the lease belongs
  // to something already gone and is reaped on the very next read. The editor
  // passes its extension host's pid.
  const pid = Number(options.pid) || process.ppid || process.pid;
  const lease = await holdLease({ env, kind, id, pid });
  if (!options.daemon) await startDaemon({ env }).catch(() => ({ started: false }));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ id: lease.id, kind: lease.kind, grants: lease.grants }, null, 2)}\n`);
    return EXIT.OK;
  }
  info(`Holding a ${lease.kind} lease (${lease.id.slice(0, 8)}) for pid ${pid}.`);
  return EXIT.OK;
}

/** Give one up. Best effort on both sides: an unheld lease expires anyway. */
async function cmdDetach(context) {
  const { env, args, options } = context;
  const [id] = args;
  if (!id) throw usageError("Which lease?", "`zclaude auto attach` prints the id it took.");
  await dropLease(id, env);
  if (options.json) process.stdout.write(`${JSON.stringify({ dropped: id }, null, 2)}\n`);
  else info(`Dropped ${id.slice(0, 8)}.`);
  return EXIT.OK;
}

/**
 * Open the inventory in whatever editor this shell is set up for.
 *
 * The file is created first if it is missing, because an empty buffer with no
 * schema in it is a worse experience than no command at all. Afterwards it is
 * re-read: an edit that does not parse is said out loud rather than discovered
 * three hours later by a watcher quietly falling back to its defaults.
 */
async function cmdEdit(context) {
  const { env, interactive } = context;
  const { resolveEditor, runEditor } = await import("./editor.js");
  const path = autoConfigPath(env);
  await initAutoConfig({ env });
  if (!interactive) {
    info(`The inventory is at ${path}.`);
    return EXIT.OK;
  }
  const editor = resolveEditor({ env });
  if (!editor) {
    throw usageError("No editor could be found.", `Set $EDITOR, or open ${path} yourself.`);
  }
  await runEditor(editor.argv, path, { env });
  const { ok, warnings } = await loadAutoConfig({ env });
  for (const warning of warnings) warn(warning);
  if (ok) success("Saved.");
  else info("The parts zclaude could not read are using its built-in defaults.");
  return EXIT.OK;
}

/**
 * Which account auto would start work on, and why.
 *
 * The meta profile resolves through here. "Least used" is the whole rule, and
 * it is measured in work rather than percentage: 3% of a Max 20x seat is nine
 * times the room left in 55% of a 5x seat, so a ranking by percentage would
 * send new work to the smaller account roughly whenever the plans differ.
 *
 * It never refuses. When nothing has room it still names the account that comes
 * back first, because the refusal belongs to the provider rather than to a
 * launcher standing between you and your own account.
 *
 * @param {{env?: NodeJS.ProcessEnv, security?: object, fetchImpl?: typeof fetch, now?: number, klass?: string}} [options]
 */
export async function pickAccount(options = {}) {
  const { env = process.env, security, fetchImpl, now = Date.now(), klass } = options;
  const { config } = await loadAutoConfig({ env });
  const { accounts, active } = await inventory({ env, security, fetchImpl, now, tiers: config.tiers });
  const wanted = klass ?? DEFAULT_CLASS;
  const choice = decide({
    accounts,
    active,
    klass: wanted,
    now,
    starting: true,
    ladder: config.ladder,
    allowCrossOrg: config.allowCrossOrg,
  });
  const target = accounts.find((account) => account.name === choice.target) ?? null;
  return { profile: choice.target, reason: choice.reason, action: choice.action, klass: wanted, account: target };
}

async function cmdPick(context) {
  const { options, env, security, fetchImpl, now = Date.now() } = context;
  const picked = await pickAccount({ env, security, fetchImpl, now, klass: options.class });
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ profile: picked.profile, reason: picked.reason, action: picked.action }, null, 2)}\n`,
    );
    return EXIT.OK;
  }
  if (!picked.profile) {
    info(`Nothing can take the work: ${picked.reason}.`);
    return EXIT.OK;
  }
  info(`${picked.profile} — ${picked.reason}.`);
  return EXIT.OK;
}

const SUBCOMMANDS = {
  status: cmdStatus,
  pick: cmdPick,
  edit: cmdEdit,
  config: cmdConfig,
  run: cmdRun,
  off: cmdOff,
  attach: cmdAttach,
  detach: cmdDetach,
};
export const AUTO_SUBCOMMANDS = Object.freeze(Object.keys(SUBCOMMANDS));

/**
 * @param {{options: object, env: NodeJS.ProcessEnv}} context
 * @param {{security?: object, fetchImpl?: typeof fetch, now?: number}} [deps]
 */
export function cmdAutoGroup(context, deps = {}) {
  const [sub = "status", ...rest] = context.options.args ?? [];
  if (!Object.hasOwn(SUBCOMMANDS, sub)) {
    throw usageError(`\`zclaude auto ${sub}\` is not a command.`, `One of: ${AUTO_SUBCOMMANDS.join(", ")}.`);
  }
  log.debug("auto", "command", { sub });
  return SUBCOMMANDS[sub]({ ...context, ...deps, args: rest });
}
