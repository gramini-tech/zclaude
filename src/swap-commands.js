// The `zclaude switch` command group: move the global Claude Code login, see
// what is in the slot, and put back what was there.
//
// This is the one destructive thing zclaude does, so the shape is: say what
// will happen, ask, then do it. `--dry-run` stops after the saying, and
// `--yes` skips the asking for scripts.

import { EXIT, InterruptedError, usageError } from "./errors.js";
import { log } from "./logger.js";
import { accountLabel } from "./profiles/probe.js";
import { listRegistered } from "./profiles/registry.js";
import { captureBack, planSwitch, restore, swapStatus, switchTo } from "./swap/index.js";
import { info, paint, success, warn } from "./ui/log.js";
import { confirmChoice } from "./ui/wizard.js";

const grey = (text) => paint(text, "grey", process.stdout);

function describeAccount(account) {
  // Same rendering as `profile list`, so a personal organisation reads as
  // "personal" here too rather than as its long generated name.
  return accountLabel(account) ?? "unknown";
}

/** `zclaude switch` with no name: who holds the global login. */
async function cmdStatus({ options, env, security }) {
  const status = await swapStatus({ env, security });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return EXIT.OK;
  }
  const label = (text) => grey(text.padEnd(14));
  const lines = [
    `${label("account")}${describeAccount(status.account)}`,
    status.owner ? `${label("profile")}${status.owner}` : `${label("profile")}${grey("not one of your profiles")}`,
    `${label("credential")}${status.credentialPresent ? (status.credential?.subscriptionType ?? "present") : "none"}`,
    status.unreadable ? `${label("keychain")}${status.unreadable}` : null,
    status.active ? `${label("switched")}${status.active}${status.swappedAt ? ` at ${status.swappedAt}` : ""}` : null,
    status.backups.length > 0
      ? `${label("backups")}${status.backups.length}, newest ${status.backups[0].id} (${describeAccount(status.backups[0].account)})`
      : `${label("backups")}none yet`,
  ];
  process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
  return EXIT.OK;
}

/** Move the global login to a profile. */
async function cmdSwitchTo(name, { options, env, interactive, security }) {
  const plan = await planSwitch(name, { env, security });
  if (plan.refusals.length > 0) {
    throw usageError(plan.refusals[0], plan.refusals.slice(1).join(" ") || undefined);
  }
  info(`Switching the global Claude Code login to "${name}" (${describeAccount(plan.target)}).`);
  for (const step of plan.steps) info(`  ${step}`);
  if (plan.current?.account)
    info(
      `  the current login (${describeAccount(plan.current.account)}) can be put back with \`zclaude switch --restore\``,
    );

  if (options.dryRun) {
    info("Nothing was changed (--dry-run).");
    return EXIT.OK;
  }
  if (interactive && !options.yes) {
    const choice = await confirmChoice(
      `This changes which account plain \`claude\` uses everywhere. Switch to "${name}"?`,
      [
        { name: "No, leave it alone", value: "no" },
        { name: `Yes, switch to "${name}"`, value: "yes" },
      ],
      "no",
    );
    if (choice !== "yes") throw new InterruptedError("Nothing was changed.");
  }
  const result = await switchTo(name, { env, security });
  success(`The global login is now ${describeAccount(result.account)} ("${result.profile}").`);
  info("A Claude Code session that is already running keeps its own login for up to about half a minute.");
  if (result.previous) info(`Put ${describeAccount(result.previous)} back with \`zclaude switch --restore\`.`);
  return EXIT.OK;
}

async function cmdRestore({ options, args, env, interactive, security }) {
  const status = await swapStatus({ env, security });
  const [id] = args;
  const target = id ? status.backups.find((entry) => entry.id === id) : status.backups[0];
  if (!target) {
    throw usageError("There is no backup to restore.", "`zclaude switch --status` lists what there is.");
  }
  info(`Restoring ${describeAccount(target.account)}, backed up at ${target.takenAt}.`);
  if (options.dryRun) {
    info("Nothing was changed (--dry-run).");
    return EXIT.OK;
  }
  if (interactive && !options.yes) {
    const choice = await confirmChoice(
      `Put ${describeAccount(target.account)} back as the global login?`,
      [
        { name: "No, leave it alone", value: "no" },
        { name: "Yes, restore it", value: "yes" },
      ],
      "no",
    );
    if (choice !== "yes") throw new InterruptedError("Nothing was changed.");
  }
  const result = await restore({ env, id: target.id, security });
  success(`The global login is ${describeAccount(result.account)} again.`);
  return EXIT.OK;
}

/** Bring a profile's stored copy up to date with the live login. */
async function cmdCapture({ env, security }) {
  const result = await captureBack({ env, security });
  if (result.captured) success(`Stored the live login back into "${result.profile}".`);
  else info(`Nothing to capture: ${result.reason}.`);
  return EXIT.OK;
}

const SUBCOMMANDS = { status: cmdStatus, restore: cmdRestore, capture: cmdCapture };
export const SWITCH_SUBCOMMANDS = Object.freeze(Object.keys(SUBCOMMANDS));

/**
 * `zclaude switch [name|subcommand]`, and the `--switch <name>` flag, which
 * lands here with the name already in `options.switch`.
 * @param {{options: object, env: NodeJS.ProcessEnv}} context
 * @param {{interactive: boolean, security?: import("./swap/keychain.js").SecurityRunner}} deps
 */
export async function cmdSwitchGroup(context, { interactive, security }) {
  const args = context.options.args ?? [];
  const [first, ...rest] = args;
  const sub = first && Object.hasOwn(SUBCOMMANDS, first) ? SUBCOMMANDS[first] : null;
  const named = context.options.switch ?? (sub ? null : first);

  const shared = { ...context, interactive, security };
  if (context.options.restore) return cmdRestore({ ...shared, args });
  if (context.options.status) return cmdStatus(shared);
  if (sub) return sub({ ...shared, args: rest });
  if (named) return cmdSwitchTo(named, shared);

  // No name and no subcommand: say who is in the slot, which is the question
  // someone typing `zclaude switch` on its own is most likely asking.
  const profiles = await listRegistered(context.env);
  log.debug("swap", "switch with no target", { profiles: profiles.map((profile) => profile.name) });
  await cmdStatus(shared);
  if (profiles.length > 0) {
    info(`Switch to one of: ${profiles.map((profile) => profile.name).join(", ")}.`);
  } else {
    warn("There are no profiles to switch to yet. Add one with `zclaude profile add`.");
  }
  return EXIT.OK;
}
