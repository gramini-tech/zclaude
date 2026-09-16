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
import { claudeCredentialService } from "./profiles/keychain-name.js";
import { createProfile, defaultConfigDir, deleteProfile, prepareLaunch } from "./profiles/launch.js";
import { canonicalConfigDir } from "./profiles/paths.js";
import { authStatus, forgetCredential, probeProfile } from "./profiles/probe.js";
import { getRegistered, listRegistered, PROVIDERS } from "./profiles/registry.js";
import { mcpServersWithSecrets, readDefaultConfig, trustedProjects } from "./profiles/seed.js";
import { detachedShares } from "./profiles/share.js";
import { deleteCredential, loadCredential } from "./store.js";
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

/**
 * Sign a profile in. Anthropic profiles go through Claude Code's own login
 * with CLAUDE_CONFIG_DIR pointed at the profile, which is what keeps the
 * credential out of the default Keychain item.
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
  info(`Signing in to "${record.name}". Claude Code will open your browser.`);
  log.info("profile", "anthropic sign-in", { name: record.name, dir: record.dir });
  const code = await runClaude(bin, ["auth", "login", ...authFlags(options)], childEnv);
  if (code !== 0) {
    warn(`\`claude auth login\` exited with ${code}. Run \`zclaude profile login ${record.name}\` to try again.`);
    return code;
  }
  const identity = await probeProfile(record);
  success(
    identity.identity?.email
      ? `"${record.name}" is signed in as ${identity.identity.email}.`
      : `"${record.name}" is signed in.`,
  );
  return EXIT.OK;
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
  return probe.identity?.email || `signed in (${probe.credential})`;
}

/** One line per profile, for `profile list` and for `zclaude status`. */
export async function profileSummaries(env) {
  const rows = await profileRows(env);
  return rows.map(({ record, probe }) => ({
    name: record.name,
    provider: record.provider,
    dir: record.dir,
    share: record.share,
    signedIn: probe.signedIn,
    identity: probe.identity,
    credential: probe.credential,
    account: signedInText(probe),
  }));
}

async function cmdList({ env, options }) {
  const rows = await profileRows(env);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(await profileSummaries(env), null, 2)}\n`);
    return EXIT.OK;
  }
  if (rows.length === 0) {
    info("No profiles yet. Create one with `zclaude profile add`.");
    info("The built-in `claude` and `zai` entries always work and need no profile.");
    return EXIT.OK;
  }
  const width = Math.max(...rows.map(({ record }) => record.name.length), 4);
  const grey = (text) => paint(text, "grey", process.stdout);
  for (const { record, probe } of rows) {
    process.stdout.write(
      `${record.name.padEnd(width)}  ${record.provider.padEnd(9)} ${signedInText(probe).padEnd(30)} ${grey(`shares ${describeShare(record.share)}`)}\n`,
    );
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

async function cmdEnv({ args, env }) {
  const record = await requireProfile(args[0], env);
  const prepared = await prepareLaunch(record, env);
  reportPreparation(prepared, record);
  process.stderr.write(`# ${SHELL_WARNING.replaceAll("\n", "\n# ")}\n# Prefer: zclaude profile shell ${record.name}\n`);
  process.stdout.write(`export CLAUDE_CONFIG_DIR=${JSON.stringify(prepared.configDir)}\n`);
  process.stdout.write(`export ZCLAUDE_PROFILE=${JSON.stringify(record.name)}\n`);
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

async function cmdDoctor({ env, options }) {
  const records = await listRegistered(env);
  /** @type {{what: string, fix?: string}[]} */
  const found = [...(await environmentChecks(env))];
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

/** Resolve a profile's launch environment. Used by the launcher. */
export async function launchContext(record, env) {
  const prepared = await prepareLaunch(record, env);
  reportPreparation(prepared, record);
  return { ...prepared, dir: canonicalConfigDir(record.dir) };
}
