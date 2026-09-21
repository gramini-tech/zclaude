// The `zclaude profile` command group.
//
// Kept out of cli.js because it is a self-contained surface: create, inspect,
// sign in and remove profiles. The Z.ai sign-in flow is injected rather than
// imported, so this module never has to reach back into the launcher.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { buildProfileEnv, overridingAuthVars, requireClaude, runClaude } from "./claude.js";
import { MANAGED_SETTINGS_PATHS } from "./claude-settings.js";
import { CONSOLE_KEYS_URL } from "./config.js";
import { EXIT, InterruptedError, usageError } from "./errors.js";
import { log } from "./logger.js";
import {
  accountState,
  bindingFrom,
  boundElsewhere,
  describeBinding,
  restoreLogin,
  sameBinding,
  snapshotLogin,
} from "./profiles/binding.js";
import { claudeCredentialService } from "./profiles/keychain-name.js";
import { createProfile, defaultConfigDir, deleteProfile, prepareLaunch } from "./profiles/launch.js";
import { canonicalConfigDir, CLAUDE_COMMANDS } from "./profiles/paths.js";
import { accountLabel, authStatus, forgetCredential, probeProfile, readIdentity } from "./profiles/probe.js";
import { getRegistered, listRegistered, patchRegistered, PROVIDERS } from "./profiles/registry.js";
import { mcpServersWithSecrets, readDefaultConfig, trustedProjects } from "./profiles/seed.js";
import { detachedShares } from "./profiles/share.js";
import { deleteCredential, loadCredential } from "./store.js";
import { credentialHealth, formatCredits, formatUsage, signInHint, usageForAll, usageRows } from "./usage/index.js";
import { configFileIn, sameAccountGroups } from "./swap/identity.js";
import { swapStatus } from "./swap/index.js";
import { info, mask, paint, success, warn } from "./ui/log.js";
import { askCopyMcp, askCopyTrust, askProfileName, askProvider, askSharing, askSignIn } from "./ui/profile-wizard.js";
import { confirmChoice } from "./ui/wizard.js";

const SHARE_CHOICES = Object.freeze({
  all: { config: true, history: true },
  both: { config: true, history: true },
  config: { config: true, history: false },
  history: { config: false, history: true },
  none: { config: false, history: false },
});

/** `--share all|config|history|none` as a pair of booleans. */
export function parseShare(value) {
  if (value === undefined) return null;
  const key = String(value).trim().toLowerCase();
  if (!Object.hasOwn(SHARE_CHOICES, key)) {
    throw usageError(`--share does not accept "${value}".`, "Use all, config, history or none.");
  }
  return { ...SHARE_CHOICES[key] };
}

/** @returns {"anthropic" | "zai" | null} */
function parseProvider(value) {
  if (value === undefined) return null;
  const key = String(value).trim().toLowerCase();
  if (key !== "anthropic" && key !== "zai") {
    throw usageError(`--provider does not accept "${value}".`, `Use ${PROVIDERS.join(" or ")}.`);
  }
  return key;
}

export function describeShare(share) {
  const parts = [share?.config ? "config" : null, share?.history ? "history" : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" + ") : "nothing";
}

function providerLabel(provider) {
  return provider === "zai" ? "Z.ai GLM Coding Plan" : "Anthropic account";
}

async function requireProfile(name, env) {
  if (!name) throw usageError("Which profile?", "Run `zclaude profile list` to see the names.");
  const record = await getRegistered(name, env);
  if (record) return record;
  const known = (await listRegistered(env)).map((profile) => profile.name);
  throw usageError(
    `There is no profile named "${name}".`,
    known.length > 0 ? `Known profiles: ${known.join(", ")}.` : "Create one with `zclaude profile add`.",
  );
}

// ------------------------------------------------------------------ sign-in

function authFlags(options) {
  return [
    ...(options.sso ? ["--sso"] : []),
    ...(options.console ? ["--console"] : []),
    ...(options.email ? ["--email", options.email] : []),
  ];
}

/** Every other profile's binding and the login it is holding, for a collision check. */
async function otherAccounts(name, env) {
  const records = (await listRegistered(env)).filter((other) => other.name !== name && other.provider === "anthropic");
  return Promise.all(
    records.map(async (other) => ({
      name: other.name,
      account: other.account ?? null,
      identity: await readIdentity(other.dir),
    })),
  );
}

/** Record which account this profile is for, from the login it now holds. */
async function bindAccount(record, binding, env) {
  await patchRegistered(record.name, { account: { ...binding, boundAt: new Date().toISOString() } }, env);
  log.info("profile", "bound to an account", {
    name: record.name,
    accountUuid: binding.accountUuid,
    organizationUuid: binding.organizationUuid,
  });
}

/**
 * Whether the account a sign-in landed on is the one this profile is for.
 *
 * Three ways it is not, and all three end the same way: the sign-in is undone.
 * The binding names a different account; the account is already another
 * profile's; or nothing identifies the account at all, which means the next
 * comparison cannot be made either.
 */
function judgeSignIn({ record, found, taken, rebind }) {
  const bound = record.account ?? null;
  if (!found) {
    // Nothing identifies the account, so nothing can be said about whether it
    // is the right one. Refusing here would be a dead end over a file the
    // person cannot edit, so the login stands and the profile stays unbound.
    return {
      ok: true,
      why: null,
      fix: null,
      warning: `${configFileIn(record.dir)} names no account, so "${record.name}" cannot be tied to one. Its usage row may describe a different plan than its name does.`,
    };
  }
  if (taken) {
    return {
      ok: false,
      why: `${describeBinding(found)} is already "${taken}"`,
      fix: `Two profiles on one account share one quota and report the same usage. Sign in as the other account, or remove "${taken}" first.`,
      warning: null,
    };
  }
  if (bound && !rebind && !sameBinding(bound, found)) {
    return {
      ok: false,
      why: `"${record.name}" is for ${describeBinding(bound)}, and that sign-in landed on ${describeBinding(found)}`,
      fix: `One address can hold two accounts. Pick the other organisation on the consent screen, or run \`zclaude profile login ${record.name} --rebind\` to move "${record.name}" to this account.`,
      warning: null,
    };
  }
  return { ok: true, why: null, fix: null, warning: null };
}

/**
 * Sign a profile in. Anthropic profiles go through Claude Code's own login
 * with CLAUDE_CONFIG_DIR pointed at the profile, which is what keeps the
 * credential out of the default Keychain item.
 *
 * A profile is an account, so the sign-in is checked against the one it is for
 * and undone when it landed somewhere else. The snapshot comes first: a
 * rollback can only be offered when the login it would restore has actually
 * been read.
 */
async function signIn(record, { options, env, zaiLogin, interactive }) {
  if (record.provider === "zai") {
    if (!interactive) throw usageError("Signing in to Z.ai needs an interactive terminal.");
    await zaiLogin({ env, options, profile: record.name });
    return EXIT.OK;
  }
  const bin = requireClaude({ env });
  const childEnv = buildProfileEnv({ baseEnv: env, configDir: record.dir });
  const inherited = overridingAuthVars(childEnv);
  if (inherited.length > 0)
    warn(`${inherited.join(", ")} is set in this shell and overrides an account login. Unset it before signing in.`);
  if (record.account && !options.rebind) info(`"${record.name}" is for ${describeBinding(record.account)}.`);
  info(`Signing in to "${record.name}". Claude Code will open your browser.`);
  log.info("profile", "anthropic sign-in", { name: record.name, dir: record.dir });

  const snapshot = await snapshotLogin(record, { env });
  const code = await runClaude(bin, ["auth", "login", ...authFlags(options)], childEnv);
  if (code !== 0) {
    warn(`\`claude auth login\` exited with ${code}. Run \`zclaude profile login ${record.name}\` to try again.`);
    return code;
  }

  const probe = await probeProfile(record);
  const found = bindingFrom(probe.identity);
  const taken = boundElsewhere(await otherAccounts(record.name, env), found);
  const verdict = judgeSignIn({ record, found, taken, rebind: Boolean(options.rebind) });
  if (!verdict.ok) return await refuseSignIn(record, { snapshot, env, ...verdict });

  if (verdict.warning) {
    warn(verdict.warning);
    success(`"${record.name}" is signed in${probe.identity?.email ? ` as ${probe.identity.email}` : ""}.`);
    return EXIT.OK;
  }
  if (!sameBinding(record.account ?? null, found)) await bindAccount(record, found, env);
  success(`"${record.name}" is signed in as ${describeBinding(found)}.`);
  return EXIT.OK;
}

/**
 * Undo a sign-in that landed on the wrong account, and say so.
 *
 * Exit code rather than a thrown error: the browser flow succeeded and the
 * message is already the whole story, so a stack-shaped failure on top of it
 * would add nothing.
 */
async function refuseSignIn(record, { snapshot, env, why, fix = null }) {
  const restored = await restoreLogin(record, snapshot, { env });
  warn(`Refused: ${why}.`);
  if (fix) info(`  ${fix}`);
  if (restored) {
    info(
      snapshot.credential || snapshot.identity
        ? `  Nothing was changed; "${record.name}" still holds the login it had.`
        : `  Nothing was changed; "${record.name}" is signed out, as it was.`,
    );
  } else {
    warn(
      `  The previous login could not be put back, so "${record.name}" now holds that account. Run \`zclaude profile login ${record.name}\` again, or \`zclaude profile rebind ${record.name}\` to accept it.`,
    );
  }
  log.warn("profile", "sign-in refused", { name: record.name, why, restored });
  return EXIT.AUTH;
}

// ---------------------------------------------------------------------- add

async function cmdAdd({ args, options, env, interactive, zaiLogin }) {
  const [given] = args;
  if (!interactive && (!given || !options.provider)) {
    throw usageError(
      "Creating a profile without a terminal needs both a name and a provider.",
      "Example: zclaude profile add work --provider anthropic --share all --yes",
    );
  }
  const name = given || (await askProfileName());
  const provider = parseProvider(options.provider) ?? (await askProvider());
  const share = parseShare(options.share) ?? (interactive ? await askSharing() : { config: true, history: true });

  const defaultDir = defaultConfigDir(env);
  const source = await readDefaultConfig(defaultDir);
  const servers = Object.keys(source?.mcpServers ?? {});
  const trusted = trustedProjects(source);
  const mcp =
    interactive && servers.length > 0 ? await askCopyMcp(servers, mcpServersWithSecrets(source?.mcpServers)) : false;
  const trust = interactive && trusted.length > 0 ? await askCopyTrust(trusted.length) : false;

  const { record } = await createProfile({ name, provider, share, mcp, trust, env });
  success(`Created profile "${record.name}" (${providerLabel(record.provider)}).`);
  info(`  config dir   ${record.dir}`);
  info(`  shares       ${describeShare(record.share)}`);
  if (share.history)
    info("  Shared history means /resume and --continue can reach sessions started under another profile.");

  const now = interactive ? await askSignIn(record.name) : false;
  if (!now) {
    info(
      `Sign in later with \`zclaude profile login ${record.name}\`, or just run \`zclaude --profile ${record.name}\`.`,
    );
    return EXIT.OK;
  }
  return signIn(record, { options, env, zaiLogin, interactive });
}

// --------------------------------------------------------------------- list

async function profileRows(env) {
  const records = await listRegistered(env);
  const probes = await Promise.all(records.map((record) => probeProfile(record)));
  return records.map((record, index) => ({ record, probe: probes[index] }));
}

function signedInText(probe) {
  if (probe.signedIn === "unknown") return "unknown (keychain locked?)";
  if (!probe.signedIn) return "signed out";
  return accountLabel(probe.identity) ?? `signed in (${probe.credential})`;
}

/**
 * Which other profiles are signed in to the very same account, by name.
 *
 * Carried on every row because two profiles on one account report one quota,
 * so their numbers match exactly and the rows read as a bug in the numbers
 * rather than as what they are. Every surface that lists profiles can say so.
 * @param {Array<{record: object, probe: object}>} rows
 * @returns {Map<string, string[]>}
 */
function sharedAccounts(rows) {
  const groups = sameAccountGroups(
    rows.map(({ record, probe }) => ({
      name: record.name,
      accountUuid: probe.identity?.accountUuid ?? null,
      organizationUuid: probe.identity?.organizationUuid ?? null,
    })),
  );
  const byName = new Map();
  for (const names of groups) {
    for (const name of names)
      byName.set(
        name,
        names.filter((other) => other !== name),
      );
  }
  return byName;
}

/** One line per profile, for `profile list` and for `zclaude status`. */
export async function profileSummaries(env) {
  const rows = await profileRows(env);
  const shared = sharedAccounts(rows);
  return rows.map(({ record, probe }) => ({
    name: record.name,
    provider: record.provider,
    dir: record.dir,
    share: record.share,
    signedIn: probe.signedIn,
    identity: probe.identity,
    credential: probe.credential,
    account: signedInText(probe),
    sameAccountAs: shared.get(record.name) ?? [],
    binding: bindingSummary(record, probe.identity),
  }));
}

/**
 * Which account this profile is for, and whether it is holding it.
 *
 * On every row because the answer is invisible otherwise: a drifted profile is
 * signed in, reports numbers and looks entirely healthy, and the numbers belong
 * to somebody else's plan.
 */
function bindingSummary(record, identity) {
  const { state, bound, found } = accountState(record, identity);
  return {
    state,
    boundTo: bound ? describeBinding(bound) : null,
    signedInAs: found ? describeBinding(found) : null,
  };
}

/** What the usage layer needs to look each of these profiles up. */
function usageRecordsFor(rows) {
  return rows.map(({ record }) => ({ name: record.name, provider: record.provider, dir: record.dir }));
}

async function cmdList({ env, options }) {
  const rows = await profileRows(env);
  // Usage costs a network call per profile, so it happens only when asked for.
  const usage = options.usage ? await usageForAll(usageRecordsFor(rows), { env, force: Boolean(options.force) }) : null;
  if (options.json) {
    const summaries = await profileSummaries(env);
    const payload = usage ? summaries.map((row) => ({ ...row, usage: usage[row.name] ?? null })) : summaries;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return EXIT.OK;
  }
  if (rows.length === 0) {
    info("No profiles yet. Create one with `zclaude profile add`.");
    info("The built-in `claude` and `zai` entries always work and need no profile.");
    return EXIT.OK;
  }
  // Columns are sized from the content: an account is an email plus its
  // organization, which is how two profiles on one login stay distinguishable,
  // and that is wider than any fixed guess.
  const printed = rows.map(({ record, probe }) => ({ record, account: signedInText(probe) }));
  const width = Math.max(...printed.map(({ record }) => record.name.length), 4);
  const accountWidth = Math.max(...printed.map(({ account }) => account.length), 12);
  const grey = (text) => paint(text, "grey", process.stdout);
  const shared = sharedAccounts(rows);
  const probeOf = new Map(rows.map(({ record, probe }) => [record.name, probe.identity]));
  for (const { record, account } of printed) {
    process.stdout.write(
      `${record.name.padEnd(width)}  ${record.provider.padEnd(9)} ${account.padEnd(accountWidth)}  ${grey(`shares ${describeShare(record.share)}`)}\n`,
    );
    // Two profiles on one account report one quota, so their rows carry the
    // same numbers. Said here, that is a fact; left unsaid it reads as a bug.
    const twin = shared.get(record.name) ?? [];
    if (twin.length > 0) {
      process.stdout.write(
        `${" ".repeat(width + 2)}${grey(`the same account as ${twin.join(", ")}, so both rows report one quota`)}\n`,
      );
    }
    const binding = bindingSummary(record, probeOf.get(record.name));
    if (binding.state === "drifted") {
      process.stdout.write(
        `${" ".repeat(width + 2)}${grey(`signed in to the wrong account: this profile is for ${binding.boundTo}`)}\n`,
      );
    }
    // Lines of their own rather than a wider row: an account plus an
    // organization plus three windows and their reset times does not fit in 80
    // columns, and this is the surface with room to spell them out.
    if (!usage) continue;
    const indent = " ".repeat(width + 2);
    const windows = usageRows(usage[record.name]);
    if (windows.length === 0) {
      const numbers = formatUsage(usage[record.name]);
      if (numbers) process.stdout.write(`${indent}${grey(numbers)}\n`);
      // "login expired" on its own leaves you to go and look up the cure.
      const hint = signInHint(usage[record.name], record.name);
      if (hint) process.stdout.write(`${indent}${grey(`fix it: ${hint.how}`)}\n`);
      continue;
    }
    for (const window of windows) {
      const text = `${window.label.padEnd(12)} ${String(window.pct).padStart(3)}%  ${window.resets}`.trimEnd();
      process.stdout.write(`${indent}${grey(text)}\n`);
    }
    const credits = formatCredits(usage[record.name]?.credits);
    if (credits) process.stdout.write(`${indent}${grey(credits)}\n`);
  }
  return EXIT.OK;
}

// --------------------------------------------------------------------- show

async function cmdShow({ args, env, options }) {
  const record = await requireProfile(args[0], env);
  const probe = await probeProfile(record);
  const detached = await detachedShares({ configDir: record.dir, share: record.share });
  const zai = record.provider === "zai" ? await loadCredential({ env, profile: record.name }) : null;
  const bin = claudeOrNull(env);
  const auth = bin ? await authStatus(record.dir, { bin, env }) : null;
  const payload = {
    name: record.name,
    provider: record.provider,
    dir: record.dir,
    share: record.share,
    createdAt: record.createdAt ?? null,
    credentialService: claudeCredentialService(record.dir),
    credential: probe.credential,
    identity: probe.identity,
    binding: bindingSummary(record, probe.identity),
    detachedShares: detached,
    zaiKey: zai ? { source: zai.source, key: mask(zai.apiKey), email: zai.email || null } : null,
    authStatus: auth,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return EXIT.OK;
  }
  const grey = (text) => paint(text, "grey", process.stdout);
  const label = (text) => grey(text.padEnd(16));
  const lines = [
    `${label("profile")}${record.name}`,
    `${label("provider")}${providerLabel(record.provider)}`,
    `${label("config dir")}${record.dir}`,
    `${label("shares")}${describeShare(record.share)}`,
    `${label("credential")}${probe.credential} ${grey(`(service ${payload.credentialService})`)}`,
    probe.identity?.email
      ? `${label("signed in as")}${probe.identity.email}`
      : `${label("signed in")}${signedInText(probe)}`,
    probe.identity?.organization ? `${label("organization")}${probe.identity.organization}` : null,
    payload.binding.boundTo ? `${label("is for")}${payload.binding.boundTo}` : null,
    payload.binding.state === "drifted"
      ? `${label("")}${grey(`signed in to the wrong account; \`zclaude profile login ${record.name}\` or \`… rebind ${record.name}\``)}`
      : null,
    zai ? `${label("z.ai key")}${zai.source} ${mask(zai.apiKey)}${zai.email ? ` · ${zai.email}` : ""}` : null,
    detached.length > 0
      ? `${label("detached")}${detached.join(", ")} ${grey("(no longer shared; run `zclaude profile doctor --fix`)")}`
      : null,
    auth
      ? `${label("claude auth")}${auth.loggedIn ? `${auth.email ?? "signed in"}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ""}` : "signed out"}`
      : null,
  ];
  process.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
  return EXIT.OK;
}

function claudeOrNull(env) {
  try {
    return requireClaude({ env });
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- login / logout

async function cmdLoginProfile(context) {
  const record = await requireProfile(context.args[0], context.env);
  return signIn(record, context);
}

/**
 * Sign one profile in, by name, from outside this module.
 *
 * The launch picker needs it: a row reading "login expired" should be fixable
 * where you are looking at it, rather than by quitting and remembering a
 * subcommand.
 * @param {string} name
 * @param {{env: NodeJS.ProcessEnv, zaiLogin: Function, interactive: boolean}} context
 */
export async function signInProfile(name, { env, zaiLogin, interactive }) {
  const record = await requireProfile(name, env);
  return signIn(record, { options: {}, env, zaiLogin, interactive });
}

/**
 * Accept the account a profile is holding now as the one it is for.
 *
 * The escape hatch the refusal points at, and the way an older profile that
 * predates bindings acquires one. Deliberate by design: it is the one place
 * that changes what a profile means, so it is a command you type rather than
 * something that happens to you.
 */
async function cmdRebind({ args, env }) {
  const record = await requireProfile(args[0], env);
  if (record.provider !== "anthropic") {
    throw usageError(
      `"${record.name}" is a Z.ai profile. Its login is an endpoint and a key, which name no account to bind to.`,
    );
  }
  const identity = await readIdentity(record.dir);
  const found = bindingFrom(identity);
  if (!found) {
    throw usageError(
      `"${record.name}" is not signed in to an account that names itself, so there is nothing to bind to.`,
      `Run \`zclaude profile login ${record.name}\` first.`,
    );
  }
  if (sameBinding(record.account ?? null, found)) {
    info(`"${record.name}" is already for ${describeBinding(found)}.`);
    return EXIT.OK;
  }
  const taken = boundElsewhere(await otherAccounts(record.name, env), found);
  if (taken) {
    throw usageError(
      `${describeBinding(found)} is already "${taken}".`,
      `Two profiles on one account share one quota and report the same usage. Rebind or remove "${taken}" first.`,
    );
  }
  const was = record.account ? describeBinding(record.account) : null;
  await bindAccount(record, found, env);
  success(`"${record.name}" is now for ${describeBinding(found)}${was ? `, and no longer for ${was}` : ""}.`);
  return EXIT.OK;
}

async function cmdLogoutProfile({ args, env }) {
  const record = await requireProfile(args[0], env);
  if (record.provider === "zai") {
    const { removed } = await deleteCredential({ env, profile: record.name });
    if (removed.length === 0) info(`"${record.name}" had no stored Z.ai key.`);
    else success(`Removed the Z.ai key for "${record.name}" from: ${removed.join(", ")}.`);
    info(`The key still exists on your Z.ai account. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`);
    return EXIT.OK;
  }
  const bin = requireClaude({ env });
  const code = await runClaude(bin, ["auth", "logout"], buildProfileEnv({ baseEnv: env, configDir: record.dir }));
  if (code === 0) success(`"${record.name}" is signed out. Your other profiles and your default login are untouched.`);
  return code;
}

// ------------------------------------------------------------------- remove

async function cmdRemove({ args, options, env, interactive, platform = process.platform }) {
  const record = await requireProfile(args[0], env);
  if (interactive && !options.yes) {
    const choice = await confirmChoice(
      `Remove profile "${record.name}"? Its login, transcripts and settings are deleted. Shared items and ~/.claude are left alone.`,
      [
        { name: "No, keep it", value: "keep" },
        { name: `Yes, remove "${record.name}"`, value: "remove" },
      ],
      "keep",
    );
    if (choice !== "remove") throw new InterruptedError("Nothing was removed.");
  } else if (!interactive && !options.yes) {
    throw usageError("Removing a profile without a terminal needs --yes.");
  }
  if (record.provider === "zai") {
    const { removed } = await deleteCredential({ env, profile: record.name });
    if (removed.length > 0) info(`Removed the Z.ai key from: ${removed.join(", ")}.`);
  } else {
    const forgotten = await forgetCredential(record.dir, { platform });
    if (forgotten) info(`Removed the Claude Code credential item (${claudeCredentialService(record.dir)}).`);
  }
  const { root } = await deleteProfile(record.name, env);
  success(`Removed "${record.name}" and ${root}.`);
  return EXIT.OK;
}

// -------------------------------------------------------------- shell / env

const SHELL_WARNING = [
  "Everything started from this shell inherits the profile, including editors.",
  "Launching `code .` here would move the VS Code extension onto this profile's login.",
].join("\n");

async function cmdShell({ args, env, interactive }) {
  const record = await requireProfile(args[0], env);
  if (!interactive) throw usageError("`zclaude profile shell` needs an interactive terminal.");
  const prepared = await prepareLaunch(record, env);
  reportPreparation(prepared, record);
  const shell = env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  const childEnv = buildProfileEnv({
    baseEnv: env,
    configDir: prepared.configDir,
    extra: { ZCLAUDE_PROFILE: record.name },
  });
  info(`Starting ${shell} pinned to "${record.name}". Type exit to come back.`);
  warn(SHELL_WARNING);
  log.info("profile", "profile shell", { name: record.name, shell });
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [], { stdio: "inherit", env: childEnv });
    child.on("error", (error) => reject(usageError(`Could not start ${shell}: ${error.message}`)));
    child.on("exit", (code) => {
      info(`Left the "${record.name}" shell.`);
      resolve(code ?? EXIT.OK);
    });
  });
}

/**
 * The lines a shell would evaluate. PowerShell is the one that matters: `export`
 * is a syntax error there, so a Windows user would get a broken shell rather
 * than a pinned one.
 * @param {Record<string, string>} values
 */
export function exportLines(values, { platform = process.platform, shell = "" } = {}) {
  const powershell = platform === "win32" && !/(?:bash|zsh|sh|fish)(?:\.exe)?$/iu.test(shell);
  return Object.entries(values).map(([key, value]) =>
    powershell ? `$env:${key} = ${JSON.stringify(value)}` : `export ${key}=${JSON.stringify(value)}`,
  );
}

async function cmdEnv({ args, env, platform = process.platform }) {
  const record = await requireProfile(args[0], env);
  const prepared = await prepareLaunch(record, env);
  reportPreparation(prepared, record);
  process.stderr.write(`# ${SHELL_WARNING.replaceAll("\n", "\n# ")}\n# Prefer: zclaude profile shell ${record.name}\n`);
  const lines = exportLines(
    { CLAUDE_CONFIG_DIR: prepared.configDir, ZCLAUDE_PROFILE: record.name },
    { platform, shell: env.SHELL ?? "" },
  );
  for (const line of lines) process.stdout.write(`${line}\n`);
  return EXIT.OK;
}

// ------------------------------------------------------------------- doctor

async function missing(path) {
  return !(await stat(path)
    .then(() => true)
    .catch(() => false));
}

async function checkProfile(record, env) {
  /** @type {{what: string, fix?: string}[]} */
  const problems = [];
  if (await missing(record.dir)) {
    problems.push({
      what: `${record.dir} is gone`,
      fix: `Recreate it with \`zclaude profile add ${record.name}\` after \`zclaude profile remove ${record.name}\`. An empty directory at the same path would reuse the old credential.`,
    });
    return problems;
  }
  const detached = await detachedShares({ configDir: record.dir, share: record.share });
  if (detached.length > 0) {
    problems.push({
      what: `${record.name}: ${detached.join(", ")} stopped being shared (a write replaced the link)`,
      fix: "Run `zclaude profile doctor --fix` to relink after moving the local copy aside.",
    });
  }
  if (CLAUDE_COMMANDS.includes(record.name)) {
    problems.push({
      what: `${record.name}: shares a name with a claude command, so \`zclaude ${record.name}\` starts the profile`,
      fix: `Use \`zclaude -- ${record.name}\` to reach claude's own command, or rename the profile.`,
    });
  }
  const probe = await probeProfile(record);
  if (probe.credential === "file")
    problems.push({ what: `${record.name}: credentials are in a plaintext file, not the Keychain` });
  else if (probe.credential === "unknown")
    problems.push({ what: `${record.name}: the Keychain could not be read (locked, or running over SSH)` });
  if (record.provider === "zai" && !(await loadCredential({ env, profile: record.name })))
    problems.push({ what: `${record.name}: no Z.ai key stored`, fix: `Run \`zclaude profile login ${record.name}\`.` });
  return problems;
}

async function environmentChecks(env) {
  const pinned = typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim();
  const inherited = overridingAuthVars(env);
  const managed = await Promise.all(
    managedSettingsPaths().map(async (path) =>
      (await missing(path))
        ? null
        : {
            what: `Managed settings are in force (${path})`,
            fix: "These are machine-wide policy and apply to every profile, including personal ones. No profile can opt out.",
          },
    ),
  );
  return [
    pinned
      ? {
          what: `This shell exports CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`,
          fix: "Your default Claude Code login is unreachable from here. Unset it, or use `zclaude profile shell` instead of a pinned shell.",
        }
      : null,
    inherited.length > 0
      ? {
          what: `${inherited.join(", ")} is set in this shell`,
          fix: "Those override an account login for every profile. Unset them unless you meant to use an API key.",
        }
      : null,
    ...managed,
  ].filter(Boolean);
}

/**
 * Until 0.2.23 the built-in Z.ai entry, finding no key of its own, searched the
 * Keychain by service alone and adopted whichever item answered — a profile's.
 * The lookup no longer does that, but a copy it already made stays where it is,
 * quietly showing one plan's quota under two names.
 */
async function checkSharedZaiKey(records, env) {
  const builtin = await loadCredential({ env });
  if (!builtin) return [];
  const zaiProfiles = records.filter((entry) => entry.provider === "zai");
  for (const record of zaiProfiles) {
    const theirs = await loadCredential({ env, profile: record.name });
    if (theirs?.apiKey !== builtin.apiKey) continue;
    return [
      {
        what: `The built-in Z.ai entry holds the same key as the "${record.name}" profile`,
        fix: `Both rows then report one plan's usage. \`zclaude logout\` removes the built-in copy and leaves "${record.name}" alone.`,
      },
    ];
  }
  return [];
}

/**
 * A profile whose account is also the global login, holding a credential the
 * slot has moved past. Claude Code refreshes the slot as it works and the
 * server rotates the refresh token, so the profile's own copy stops working —
 * which looks exactly like an expired login until you know why.
 */
async function checkOvertakenByTheSlot(env) {
  const status = await swapStatus({ env }).catch(() => null);
  if (!status?.owner || !status.credential) return [];
  const record = await getRegistered(status.owner, env);
  if (!record) return [];
  const theirs = await credentialHealth({ provider: "anthropic", dir: record.dir }, { env });
  if (!theirs || !theirs.accessExpired || status.credential.accessExpired) return [];
  return [
    {
      what: `"${status.owner}" holds the global login, and its own stored copy has fallen behind`,
      fix: "Claude Code rotates the token in the slot as it works. `zclaude switch capture` puts the live one back; the renewal job does it on its own schedule.",
    },
  ];
}

/**
 * Two profiles signed in to one account. Legitimate for a moment — the same
 * login registered twice — but they share a quota, so rotation between them
 * moves nothing and their usage rows match to the percentage point. It is
 * nearly always a sign-in that picked the wrong organisation: one address can
 * hold a company seat and a personal subscription, and the consent screen
 * offers both.
 */
async function checkSharedAccounts(env) {
  const rows = await profileRows(env);
  return sameAccountGroups(
    rows.map(({ record, probe }) => ({
      name: record.name,
      accountUuid: probe.identity?.accountUuid ?? null,
      organizationUuid: probe.identity?.organizationUuid ?? null,
    })),
  ).map((names) => ({
    what: `${names.join(" and ")} are signed in to the same account, so they share one quota and report the same usage`,
    fix: `One address can hold two accounts in two organisations. \`zclaude profile login ${names.at(-1)}\` and pick the other organisation, or remove the profile you do not need.`,
  }));
}

/**
 * A profile signed in to an account it is not for.
 *
 * It cannot happen through `zclaude profile login` any more, which undoes such
 * a sign-in. It can still happen from outside: `/logout` inside a session, or
 * a plain `claude` run with that config directory. Everything zclaude says
 * about the profile afterwards — its usage, its plan size, whether rotation
 * should send work to it — describes the wrong account.
 */
async function checkDrift(records) {
  const problems = [];
  for (const record of records) {
    if (record.provider !== "anthropic" || !record.account) continue;
    const { state, bound, found } = accountState(record, await readIdentity(record.dir));
    if (state !== "drifted") continue;
    problems.push({
      what: `${record.name} is for ${describeBinding(bound)} but is signed in as ${describeBinding(found)}`,
      fix: `\`zclaude profile login ${record.name}\` to sign back in as the right one, or \`zclaude profile rebind ${record.name}\` to accept the change.`,
    });
  }
  return problems;
}

async function cmdDoctor({ env, options }) {
  const records = await listRegistered(env);
  /** @type {{what: string, fix?: string}[]} */
  const found = [
    ...(await environmentChecks(env)),
    ...(await checkSharedZaiKey(records, env)),
    ...(await checkSharedAccounts(env)),
    ...(await checkDrift(records)),
    ...(await checkOvertakenByTheSlot(env)),
  ];
  for (const record of records) found.push(...(await checkProfile(record, env)));

  if (options.fix) {
    for (const record of records) {
      const prepared = await prepareLaunch(record, env);
      if (prepared.occupied.length > 0)
        warn(`${record.name}: ${prepared.occupied.join(", ")} hold local copies, so they were left alone.`);
    }
    info("Relinked what could be relinked.");
  }
  if (found.length === 0) {
    success(`Checked ${records.length} profile${records.length === 1 ? "" : "s"}. Nothing looks wrong.`);
    return EXIT.OK;
  }
  for (const problem of found) {
    warn(problem.what);
    if (problem.fix) info(`  ${problem.fix}`);
  }
  log.info("profile", "doctor", { problems: found.map((problem) => problem.what) });
  return EXIT.OK;
}

// ----------------------------------------------------------------- shared

/**
 * Forget every profile's credentials, for `self-uninstall`. The profile
 * directories go with ~/.zclaude; the credential items live outside it, so
 * they have to be removed by name or they linger in the Keychain forever.
 */
export async function forgetAllProfiles(env = process.env, { platform = process.platform } = {}) {
  const records = await listRegistered(env);
  const forgotten = [];
  for (const record of records) {
    if (record.provider === "zai") {
      const { removed } = await deleteCredential({ env, profile: record.name });
      if (removed.length > 0) forgotten.push(`${record.name} (Z.ai key)`);
    } else if (await forgetCredential(record.dir, { platform })) {
      forgotten.push(`${record.name} (${claudeCredentialService(record.dir)})`);
    }
  }
  return { profiles: records.map((record) => record.name), forgotten };
}

/** Machine-wide policy files for this platform. */
function managedSettingsPaths(platform = process.platform) {
  return MANAGED_SETTINGS_PATHS[platform] ?? [];
}

/** Tell the user what a launch had to work around. */
function reportPreparation(prepared, record) {
  if (prepared.recreated)
    warn(
      `${record.name}: its directory was missing and has been recreated. Claude Code keys credentials by that path, so an earlier login for it may still apply; run \`zclaude profile login ${record.name}\` if it is signed out.`,
    );
  if (prepared.occupied.length > 0)
    warn(
      `${record.name}: ${prepared.occupied.join(", ")} exist inside the profile as real files, so they are not shared.`,
    );
  if (prepared.detached.length > 0)
    warn(`${record.name}: ${prepared.detached.join(", ")} stopped being shared. Run \`zclaude profile doctor\`.`);
  if (prepared.removedSettings?.length > 0)
    log.debug("profile", "settings keys filtered out of the shared copy", { removed: prepared.removedSettings });
}

const SUBCOMMANDS = {
  add: cmdAdd,
  list: cmdList,
  ls: cmdList,
  show: cmdShow,
  login: cmdLoginProfile,
  logout: cmdLogoutProfile,
  remove: cmdRemove,
  rm: cmdRemove,
  shell: cmdShell,
  env: cmdEnv,
  doctor: cmdDoctor,
  rebind: cmdRebind,
};

export const PROFILE_SUBCOMMANDS = Object.freeze(Object.keys(SUBCOMMANDS));

/**
 * @param {{options: object, env: NodeJS.ProcessEnv, args?: string[]}} context
 * @param {{zaiLogin: Function, interactive: boolean}} deps
 */
export function cmdProfile(context, { zaiLogin, interactive }) {
  const [sub, ...rest] = context.options.args ?? [];
  if (!sub) throw usageError("`zclaude profile` needs a subcommand.", `One of: ${PROFILE_SUBCOMMANDS.join(", ")}.`);
  const handler = SUBCOMMANDS[sub];
  if (!handler)
    throw usageError(`\`zclaude profile ${sub}\` is not a command.`, `One of: ${PROFILE_SUBCOMMANDS.join(", ")}.`);
  return handler({ ...context, args: rest, interactive, zaiLogin });
}

/**
 * Check which account a profile is about to run as, and say so when it is not
 * the one the profile means.
 *
 * Warned rather than refused. A profile's account can change from outside
 * zclaude — `/logout` in a session, a plain `claude` in that directory — and
 * refusing to start would leave somebody mid-task with no way to run anything
 * while they sorted it out. What is at stake is the reporting, not the session:
 * the usage row, the plan size and every rotation decision would describe the
 * wrong account.
 *
 * A profile with no binding acquires one here. That is the migration path for
 * everything created before bindings existed, and the first launch is the
 * earliest honest moment: it is when the profile is being used as that account.
 */
async function reportAccount(record, env) {
  if (record.provider !== "anthropic") return;
  const { state, bound, found } = accountState(record, await readIdentity(record.dir));
  if (state === "drifted") {
    warn(`"${record.name}" is for ${describeBinding(bound)}, but its login is now ${describeBinding(found)}.`);
    info(`  Usage and rotation for "${record.name}" describe the wrong account.`);
    info(`  \`zclaude profile login ${record.name}\` to sign back in as the right one,`);
    info(`  \`zclaude profile rebind ${record.name}\` to accept the change.`);
    return;
  }
  if (state !== "unbound" || !found) return;
  const taken = boundElsewhere(await otherAccounts(record.name, env), found);
  if (taken) {
    warn(`"${record.name}" and "${taken}" are signed in to the same account, so they share one quota.`);
    info(`  \`zclaude profile login ${record.name}\` and pick the other organisation, or remove one of them.`);
    return;
  }
  await bindAccount(record, found, env);
}

/** Resolve a profile's launch environment. Used by the launcher. */
export async function launchContext(record, env) {
  const prepared = await prepareLaunch(record, env);
  reportPreparation(prepared, record);
  await reportAccount(record, env);
  return { ...prepared, dir: canonicalConfigDir(record.dir) };
}
