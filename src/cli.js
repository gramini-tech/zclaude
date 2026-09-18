// Command-line front end and orchestration.

import { execFile, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { openUrl } from "./browser.js";
import { receiveCallback } from "./callback/index.js";
import {
  buildPlainEnv,
  buildProfileEnv,
  buildZaiEnv,
  claudeVersion,
  overridingAuthVars,
  requireClaude,
  runClaude,
} from "./claude.js";
import { claudeSettingsTiers, describeConflicts, SESSION_KEYS, settingsConflicts } from "./claude-settings.js";
import {
  CONSOLE_KEYS_URL,
  describeContextWindow,
  flag,
  isZaiBaseUrl,
  loginTimeoutMs,
  VERSION,
  zaiConfig,
  zclaudeHome,
} from "./config.js";
import {
  authError,
  EXIT,
  InterruptedError,
  isInterrupt,
  keyRejectedError,
  usageError,
  ZclaudeError,
} from "./errors.js";
import { registerSecret } from "./redact.js";
import { buildAuthorizeUrl, exchangeCode, generateState, parseCallback } from "./oauth.js";
import { configureLogger, formatEntry, listLogs, log, logFilePath, readLog } from "./logger.js";
import {
  cmdProfile,
  describeShare,
  forgetAllProfiles,
  launchContext,
  profileSummaries,
  signInProfile,
} from "./profile-commands.js";
import { cmdRenewGroup } from "./renew-commands.js";
import { uninstall as unschedule } from "./renew/schedule.js";
import {
  findEditors,
  installedVersion as editorExtensionVersion,
  packagedVersion,
  uninstallEverywhere as uninstallExtension,
} from "./vscode/index.js";
import { cmdSwitchGroup } from "./swap-commands.js";
import { cmdVscodeGroup } from "./vscode-commands.js";
import { clearBackups } from "./swap/backup.js";
import { findProfile, listProfiles, takeProfileArgument } from "./profiles.js";
import { DEFAULT_CREDENTIAL_SERVICE } from "./profiles/keychain-name.js";
import { defaultConfigDir } from "./profiles/launch.js";
import { byProfile, liveSessions } from "./sessions/index.js";
import { cmdSessions, collectSessions } from "./session-commands.js";
import { getRegistered } from "./profiles/registry.js";
import { mintApiKey } from "./provision.js";
import {
  extraEnv,
  fileConfiguresModels,
  loadLayeredConfig,
  MANAGED_KEYS,
  projectEnvPath,
  resolveModels,
  resolveProfileDefault,
  userSettingsPath,
  writeSettingsFile,
} from "./settings.js";
import { deleteCredential, loadCredential, readState, saveCredential, storePaths, writeState } from "./store.js";
import { printBanner } from "./ui/banner.js";
import { debug, error as logError, info, mask, paint, setQuiet, setVerbose, success, warn } from "./ui/log.js";
import { chooseProfile } from "./ui/menu.js";
import { chooseProfileWithUsage } from "./ui/profile-menu.js";
import { createUsageStore } from "./usage/store.js";
import { chooseSaveLocation, confirmChoice, knownModels, promptApiKey, runModelWizard } from "./ui/wizard.js";
import {
  checkForUpdate,
  compareVersions,
  detectInstallKind,
  fetchLatestVersion,
  GITHUB_SPEC,
  INSTALLER_URL,
  npmBinDir,
  selfUninstall,
  selfUpdate,
} from "./update.js";
import { checkKey, fetchQuota, formatQuota, quotaExhausted } from "./zai.js";

// ------------------------------------------------------------------ parsing

export const COMMAND_NAMES = Object.freeze([
  "profile",
  "switch",
  "renew",
  "vscode",
  "sessions",
  "login",
  "logout",
  "status",
  "models",
  "log",
  "self-install",
  "self-update",
  "self-uninstall",
  "help",
]);
const COMMANDS = new Set(COMMAND_NAMES);
// Commands that take their own subcommand and names, collected into options.args.
const COMMAND_GROUPS = new Set(["profile", "switch", "renew", "vscode"]);
const VALUE_FLAGS = Object.freeze({
  "--profile": "profile",
  "--switch": "switch",
  "--provider": "provider",
  "--share": "share",
  "--email": "email",
  "--log-level": "logLevel",
  "--log-file": "logFile",
  "--model": "model",
  "--subagent-model": "subagentModel",
  "--fast-model": "fastModel",
});
const BOOL_FLAGS = Object.freeze({
  "--no-banner": "noBanner",
  "--reconfigure": "reconfigure",
  "--customize": "reconfigure",
  "--login": "login",
  "--no-store": "noStore",
  "--no-browser": "noBrowser",
  "--paste": "paste",
  "--api-key": "apiKey",
  "--verbose": "verbose",
  "--json": "json",
  "--quiet": "quiet",
  "--no-log": "noLog",
  "--keep-config": "keepConfig",
  "--path": "pathOnly",
  "--yes": "yes",
  "--fix": "fix",
  "--dry-run": "dryRun",
  "--restore": "restore",
  "--status": "status",
  "--force": "force",
  "--usage": "usage",
  "--no-usage": "noUsage",
  "--sso": "sso",
  "--console": "useConsole",
});

/** Parse `--flag value` or `--flag=value`; returns { key, value, consumed }. */
function takeValueFlag(argv, index) {
  const arg = argv[index];
  const eq = arg.indexOf("=");
  const name = eq === -1 ? arg : arg.slice(0, eq);
  if (!Object.hasOwn(VALUE_FLAGS, name)) return null;
  const inline = eq !== -1;
  const value = inline ? arg.slice(eq + 1) : argv[index + 1];
  const missing = value === undefined || value === "" || (!inline && value.startsWith("-"));
  if (missing) throw usageError(`${name} needs a value.`, `Example: zclaude ${name} glm-5.3`);
  return { key: VALUE_FLAGS[name], value, consumed: inline ? 1 : 2 };
}

export function parseArgs(argv) {
  const options = {};
  let command = null;
  let passthrough = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    const valueFlag = arg.startsWith("--") ? takeValueFlag(argv, i) : null;
    if (valueFlag) {
      options[valueFlag.key] = valueFlag.value;
      i += valueFlag.consumed;
      continue;
    }
    if (Object.hasOwn(BOOL_FLAGS, arg)) {
      options[BOOL_FLAGS[arg]] = true;
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") return { command: "help", options, passthrough };
    if (arg === "-V" || arg === "--version") return { command: "version", options, passthrough };
    if (!command && !arg.startsWith("-") && COMMANDS.has(arg)) {
      command = arg;
      i += 1;
      continue;
    }
    if (command && COMMAND_GROUPS.has(command) && !arg.startsWith("-")) {
      options.args = [...(options.args ?? []), arg];
      i += 1;
      continue;
    }
    if (command)
      throw usageError(
        `Unknown argument for \`zclaude ${command}\`: ${arg}`,
        "Run `zclaude --help` for the list of options.",
      );
    passthrough = argv.slice(i);
    break;
  }
  return { command: command ?? "launch", options, passthrough };
}

export const HELP = `zclaude ${VERSION} — interactive preloader for Claude Code

Usage
  zclaude                                      pick a profile from the menu, then launch claude
  zclaude <profile> [claude args...]           launch that profile straight away
  zclaude <profile> --resume <session-id>      resume one of that profile's sessions
  zclaude [zclaude options] [claude args...]   pick a profile, then launch claude with them
  zclaude --profile <name> [claude args...]    the same as naming it first
  zclaude -- [claude args...]                  pass everything after -- to claude
  zclaude profile <subcommand>                 manage profiles (see below)
  zclaude switch <profile>                     move the global claude login to that profile
  zclaude switch --status [--json]             which account plain claude uses right now
  zclaude switch --restore                     put the previous global login back
  zclaude switch capture                       store the live login back into its profile
  zclaude --switch <profile>                   the same as "zclaude switch <profile>"
  zclaude renew status [--json]                is the token-renewal job scheduled, and what did it do
  zclaude renew install                        schedule it
  zclaude renew uninstall                      remove the schedule
  zclaude renew run                            renew now; this is what the scheduler calls
  zclaude vscode install                       put the status bar item into the editors found here
  zclaude vscode uninstall                     take it out again
  zclaude vscode status [--json]               which editors have it, and at which version
  zclaude sessions [--json]                    what is running now, and on which account
  zclaude login [--no-browser] [--paste] [--api-key] [--no-store]
  zclaude logout                               forget the stored Z.ai key
  zclaude status [--json]                      show credential, config and model state
  zclaude models                               list models available to your Z.ai key
  zclaude log [--json] [--path]                show the latest run log (post-mortem)
  zclaude self-install                         install zclaude globally with npm (e.g. from npx)
  zclaude self-update [--force]                update the same way it was installed (--force skips the check)
  zclaude self-uninstall [--keep-config]       remove zclaude, its settings, logs and the stored key

Profiles (one Claude or Z.ai account each, scoped to the terminal that started it)
  zclaude profile add [name] [--provider anthropic|zai] [--share all|config|history|none]
  zclaude profile list [--json] [--usage]      names, accounts, sharing, and how much quota is left
  zclaude profile show <name> [--json]         everything about one profile
  zclaude profile login <name>                 sign in to that profile only
  zclaude profile logout <name>                sign out of that profile only
  zclaude profile shell <name>                 a subshell pinned to the profile
  zclaude profile env <name>                   print exports for advanced use
  zclaude profile remove <name> [--yes]        delete the profile, its login and its directory
  zclaude profile doctor [--fix]               check every profile and this shell

Arguments
  A profile name, or --, ends zclaude's options: everything after it is claude's, including
  flags zclaude also defines. "zclaude work --verbose" passes --verbose to claude;
  "zclaude --verbose work" keeps it. Bare words that are not profiles are claude's too, so
  "zclaude mcp list" and "zclaude auth status" reach claude unchanged.

Options (must come before any claude argument or profile name)
  --profile <claude|zai|name>  skip the menu
  --reconfigure                run the model wizard even if config exists (alias --customize)
  --login                      sign in again before launching
  --model <id>                 primary model (Z.ai profile; forwarded to claude otherwise)
  --subagent-model <id>        subagent model (CLAUDE_CODE_SUBAGENT_MODEL)
  --fast-model <id>            haiku-class helper model
  --share <what>               profile add: all (default), config, history or none
  --provider <name>            profile add: anthropic or zai
  --sso, --console, --email    passed to \`claude auth login\` for an Anthropic profile
  --yes                        profile remove: do not ask
  --fix                        profile doctor: relink what it can
  --force                      self-update: install anyway; profile list --usage: skip the cache
  --usage                      profile list: fetch how much of each plan is used
  --no-usage                   menu: skip the usage lookup and its network calls
  --dry-run                    switch: say what would change, change nothing
  --status                     switch: report the account in the global slot
  --restore                    switch: put the previous global login back
  --no-store                   keep the key in memory for this session only
  --no-banner                  skip the splash
  --verbose                    show what zclaude is doing
  --quiet                      only warnings and errors on the terminal
  --log-level <level>          run-log detail: error, warn, info, debug (default), trace, off
  --log-file <path>            write the run log there instead of ~/.zclaude/logs
  --no-log                     no run log for this invocation
  -h, --help                   this help (use \`zclaude -- --help\` for claude's)
  -V, --version                zclaude and claude versions

Config files (dotenv, no secrets)
  ./.zclaude/env               project choices, safe to commit
  ~/.zclaude/settings          user defaults
  ~/.zclaude/profiles/*.env    extra menu entries (ZCLAUDE_ZAI=1 routes through Z.ai)
  ~/.zclaude/profiles.json     the profiles you added, and where each one lives

Environment
  ZAI_API_KEY                  use this key, never store it
  ZCLAUDE_PROFILE              default profile (skips the menu)
  CLAUDE_CONFIG_DIR            never set by zclaude for the default profile; a value inherited
                               from your shell hides your default login and is reported
  ZCLAUDE_HOME                 config dir (default ~/.zclaude)
  ZCLAUDE_CLAUDE_BIN           path to claude
  ZCLAUDE_NO_STORE, ZCLAUDE_NO_KEYCHAIN, ZCLAUDE_NO_NATIVE_CALLBACK, ZCLAUDE_NO_BANNER
  ZCLAUDE_NO_USAGE             never look up plan usage for the menu
  ZCLAUDE_LOGIN_TIMEOUT        seconds to wait for the browser (default 300)
  ZCLAUDE_LOG_LEVEL            run-log level; ZCLAUDE_LOG_CATEGORIES filters (e.g. "auth,http" or "-console")
  ZCLAUDE_LOG=off|<path>       disable the run log or pick its file; ZCLAUDE_LOG_DIR, ZCLAUDE_LOG_KEEP (default 30)
`;

// ------------------------------------------------------------------ helpers

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function reportWarnings(layered) {
  for (const record of [layered.project, layered.user]) {
    for (const message of record.warnings) warn(message);
  }
}

function explicitKey(env) {
  return typeof env.ZAI_API_KEY === "string" && env.ZAI_API_KEY.trim() ? env.ZAI_API_KEY.trim() : "";
}

function httpDetail(check) {
  return `HTTP ${check.httpStatus}${check.detail ? `: ${check.detail}` : ""}`;
}

/**
 * Ask what to do when a settings file would override this session. Claude Code
 * applies its settings `env` block over the process environment, so a value
 * there silently wins; that is a decision for the user, never a warning zclaude
 * shrugs off, and zclaude never edits those files itself.
 */
async function resolveSettingsConflict({ env, childEnv, cwd, interactive }) {
  const found = await settingsConflicts({ childEnv, cwd });
  if (found.length === 0) return;
  log.warn("config", "settings env block overrides the session", found);
  const files = found.map((entry) => `${entry.path} (${entry.tier})`).join(", ");
  const explanation = `${files} ${found.length === 1 ? "has an env block" : "have env blocks"} that Claude Code applies over the environment zclaude sets:\n${describeConflicts(found).join("\n")}`;
  if (flag(env, "ZCLAUDE_ALLOW_SETTINGS_OVERRIDE")) {
    warn(`${explanation}\nContinuing because ZCLAUDE_ALLOW_SETTINGS_OVERRIDE is set.`);
    return;
  }
  const managed = found.filter((entry) => entry.tier === "managed");
  if (managed.length > 0)
    warn(
      "Managed settings come from a machine-wide policy. No profile can opt out of them; ask whoever set the policy.",
    );
  if (!interactive) {
    throw usageError(
      `${explanation}\nThe session would not run the way zclaude configured it.`,
      "Edit that env block, or set ZCLAUDE_ALLOW_SETTINGS_OVERRIDE=1 to launch anyway. zclaude never edits Claude Code's files.",
    );
  }
  process.stderr.write(`${explanation}\n`);
  const choice = await confirmChoice(
    "Claude Code will apply those settings values. What do you want to do?",
    [
      { name: "Quit so I can edit the settings file", value: "quit" },
      { name: "Launch anyway with the settings values in effect", value: "continue" },
    ],
    "quit",
  );
  log.info("config", "settings conflict decision", { choice });
  if (choice !== "quit") return;
  const keys = found.flatMap((entry) => entry.conflicts.map((conflict) => conflict.key));
  info(`Remove or adjust ${[...new Set(keys)].join(", ")} in ${files}, then run zclaude again.`);
  throw new InterruptedError("Stopped to let you edit the settings file.");
}

function flagModels(options) {
  return { primary: options.model, subagent: options.subagentModel, fast: options.fastModel };
}

function warnOnCheck(check, { fresh }) {
  if (check.status === "throttled") warn("The key works but the plan quota is currently exhausted.");
  else if (check.status === "inconclusive")
    warn(`Could not ${fresh ? "fully validate the new" : "validate the"} key (HTTP ${check.httpStatus}); continuing.`);
}

async function persist(credential, { store, env, profile = null }) {
  if (!store) return "memory";
  const { location } = await saveCredential(credential, { env, profile });
  return location;
}

function describeLocation(location) {
  return location === "memory" ? "kept in memory for this session" : `stored in ${location}`;
}

// -------------------------------------------------------------------- oauth

async function oauthLogin({ options, env, config, interactive, store, profile = null }) {
  const state = generateState();
  const url = buildAuthorizeUrl(state, config);
  info("Sign in to Z.ai in your browser to authorize zclaude.");
  process.stderr.write(`\n  ${url}\n\n`);

  const received = await receiveCallback({
    timeoutMs: loginTimeoutMs(env),
    allowNative: !options.paste,
    allowPaste: true,
    env,
    interactive,
    onReady: async ({ native }) => {
      if (native) info("Waiting for the browser to hand the authorization back (or paste the zcode:// URL below).");
      else info("After approving, the browser will try to open a zcode:// URL. Copy that URL and paste it below.");
      if (options.noBrowser) return;
      const result = await openUrl(url, { env });
      if (!result.opened)
        warn(`Could not open a browser automatically (${result.reason}). Open the URL above by hand.`);
    },
  });
  debug(`Authorization received via ${received.from}`);
  const { code } = parseCallback(received.value, state);

  info("Exchanging the authorization code");
  const token = await exchangeCode({ code, state }, config);
  registerSecret(token.accessToken);
  const minted = await mintApiKey(token.accessToken, config, { onProgress: (step) => debug(step) });
  const check = await checkKey(minted.apiKey, config);
  if (check.status === "rejected") {
    throw authError(
      `Z.ai issued a key, but the coding-plan API rejected it (${httpDetail(check)}).`,
      "Make sure a GLM Coding Plan subscription is active on this account at https://z.ai, then run `zclaude login` again.",
    );
  }
  warnOnCheck(check, { fresh: true });

  const credential = {
    apiKey: minted.apiKey,
    email: token.email,
    userId: token.userId,
    keyName: minted.keyName,
    source: "oauth",
  };
  const location = await persist(credential, { store, env, profile });
  const who = token.email ? ` as ${token.email}` : "";
  success(
    `Signed in${who}. Key "${minted.keyName}" ${minted.created ? "created" : "reused"} and ${describeLocation(location)}.`,
  );
  return { ...credential, location, check };
}

async function manualKeyLogin({ env, config, store, profile = null }) {
  const apiKey = await promptApiKey();
  registerSecret(apiKey);
  const check = await checkKey(apiKey, config);
  if (check.status === "rejected") {
    throw keyRejectedError(
      `Z.ai rejected that key (${httpDetail(check)}).`,
      `Copy a coding-plan key from ${CONSOLE_KEYS_URL} and try again.`,
    );
  }
  warnOnCheck(check, { fresh: true });
  const credential = { apiKey, email: "", userId: "", keyName: "", source: "manual" };
  const location = await persist(credential, { store, env, profile });
  success(`Key ${mask(apiKey)} ${describeLocation(location)}.`);
  return { ...credential, location, check };
}

const MAX_LOGIN_ATTEMPTS = 3;

async function loginWithRetries(context) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await oauthLogin(context);
    } catch (error) {
      const retryable = error instanceof ZclaudeError && error.exitCode === EXIT.AUTH && !isInterrupt(error);
      if (!retryable || !context.interactive) throw error;
      logError(error.message);
      if (error.hint) warn(error.hint);
      if (attempt >= MAX_LOGIN_ATTEMPTS) throw error;
      const next = await confirmChoice(
        "Sign-in did not complete. What next?",
        [
          { name: "Try the browser sign-in again", value: "retry" },
          { name: "Paste a Z.ai API key instead", value: "apikey" },
          { name: "Quit", value: "quit" },
        ],
        "retry",
      );
      if (next === "quit") throw new InterruptedError("Login cancelled.");
      if (next === "apikey") return manualKeyLogin(context);
    }
  }
}

// --------------------------------------------------------------- credential

/**
 * Find a credential without touching the network: env, inherited, or stored.
 * A named profile only ever uses its own stored key, because ZAI_API_KEY in
 * the shell cannot say which profile it belongs to.
 */
async function findCandidate(env, profile = null) {
  if (profile) {
    const own = await loadCredential({ env, profile });
    if (own) debug(`Loaded the key for profile "${profile}" from ${own.source}`);
    else if (explicitKey(env)) warn(`ZAI_API_KEY is ignored for profile "${profile}"; it has its own stored key.`);
    return own;
  }
  const explicit = explicitKey(env);
  if (explicit) {
    debug("Using ZAI_API_KEY from the environment");
    return { apiKey: explicit, source: "env" };
  }
  const inherited = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN.trim() : "";
  if (inherited && isZaiBaseUrl(env.ANTHROPIC_BASE_URL)) {
    info("Using ANTHROPIC_AUTH_TOKEN already present in the environment.");
    return { apiKey: inherited, source: "inherited" };
  }
  if (inherited) warn("ANTHROPIC_AUTH_TOKEN is set for a non-Z.ai endpoint; it will be replaced for this session.");
  const stored = await loadCredential({ env });
  if (stored) debug(`Loaded credential from ${stored.source}`);
  return stored;
}

async function handleRejected(candidate, check, loginContext) {
  const detail = httpDetail(check);
  if (candidate.source === "env")
    throw keyRejectedError(`Z.ai rejected ZAI_API_KEY (${detail}).`, `Check the key at ${CONSOLE_KEYS_URL}.`);
  if (candidate.source === "inherited") {
    throw keyRejectedError(
      `Z.ai rejected the ANTHROPIC_AUTH_TOKEN from your environment (${detail}).`,
      "Unset it or replace it with a valid coding-plan key.",
    );
  }
  const profile = loginContext.profile ?? null;
  warn(`The stored Z.ai key ${profile ? `for "${profile}" ` : ""}was rejected (${detail}). Signing in again.`);
  await deleteCredential({ env: loginContext.env, profile });
  if (!loginContext.interactive)
    throw authError(
      `Stored credential${profile ? ` for "${profile}"` : ""} rejected and no terminal available to sign in again.`,
      `Run \`${profile ? `zclaude profile login ${profile}` : "zclaude login"}\` interactively.`,
    );
  return loginWithRetries(loginContext);
}

/**
 * Resolve and validate the Z.ai credential for a launch. Returns
 * { apiKey, source, check } where check may be null when validation could
 * not be performed.
 */
async function resolveCredential({ options, env, config, interactive, profile = null }) {
  const store = !options.noStore && !flag(env, "ZCLAUDE_NO_STORE");
  const loginContext = { options, env, config, interactive, store, profile };
  if (options.login) {
    if (!interactive) throw usageError("--login needs an interactive terminal.");
    return loginWithRetries(loginContext);
  }
  const candidate = await findCandidate(env, profile);
  if (!candidate) {
    if (!interactive)
      throw authError(
        profile ? `Profile "${profile}" has no Z.ai key stored.` : "No Z.ai credential is available.",
        "Run `zclaude login` from an interactive terminal first, or set ZAI_API_KEY.",
      );
    return loginWithRetries(loginContext);
  }
  registerSecret(candidate.apiKey);

  let check;
  try {
    check = await checkKey(candidate.apiKey, config);
  } catch (error) {
    if (error?.exitCode !== EXIT.NETWORK) throw error;
    warn(`${error.message}. Skipping key validation; claude will report API errors itself.`);
    return { ...candidate, check: null };
  }
  if (check.status === "rejected") return handleRejected(candidate, check, loginContext);
  if (check.status === "throttled")
    warn("Your Z.ai plan quota is exhausted right now; claude will get rate-limit errors until it resets.");
  else if (check.status === "inconclusive")
    warn(`Could not validate the key (HTTP ${check.httpStatus}); continuing anyway.`);
  return { ...candidate, check };
}

// ------------------------------------------------------------------- wizard

function wizardNeeded(layered, options = {}) {
  const projectConfigured = layered.project.exists && fileConfiguresModels(layered.project);
  return Boolean(options.reconfigure) || (!layered.user.exists && !projectConfigured);
}

async function maybeRunWizard({ options, env, layered, interactive, models, availableModels, cwd }) {
  if (!wizardNeeded(layered, options)) return models;
  if (!interactive) {
    debug("Model wizard skipped: not an interactive terminal");
    return models;
  }
  if (availableModels.length === 0) warn("Could not fetch the model list from Z.ai; showing known models instead.");
  const chosen = await runModelWizard({
    models: availableModels.length > 0 ? availableModels : knownModels(),
    current: models,
  });
  const flags = flagModels(options);
  const final = { sources: {} };
  for (const slot of ["primary", "subagent", "fast"]) {
    const fromFlag = flags[slot];
    final[slot] = fromFlag ?? chosen[slot];
    final.sources[slot] = fromFlag ? "flag" : "wizard";
  }
  log.info("config", "wizard choices", chosen);
  const where = await chooseSaveLocation({
    projectPath: projectEnvPath(cwd),
    userPath: userSettingsPath(env),
    userExists: layered.user.exists,
  });
  const updates = {
    [MANAGED_KEYS.primary]: chosen.primary,
    [MANAGED_KEYS.subagent]: chosen.subagent,
    [MANAGED_KEYS.fast]: chosen.fast,
  };
  if (where === "project") success(`Saved to ${await writeSettingsFile(projectEnvPath(cwd), updates)}`);
  else if (where === "user") success(`Saved to ${await writeSettingsFile(userSettingsPath(env), updates)}`);
  else info("Using these models for this session only.");
  return final;
}

function warnUnknownModels(models, availableModels) {
  if (availableModels.length === 0) return;
  const ids = new Set(availableModels.map((model) => model.id.toLowerCase()));
  for (const slot of ["primary", "subagent", "fast"]) {
    const id = String(models[slot])
      .replace(/\[1m\]$/iu, "")
      .toLowerCase();
    if (!ids.has(id))
      warn(
        `Model "${models[slot]}" (${slot}) is not in the list Z.ai returned for your plan. Run \`zclaude --reconfigure\` to pick another.`,
      );
  }
}

// ------------------------------------------------------------------- launch

/**
 * What the usage layer needs to look a profile up. The two built-ins are
 * special: `claude` is whatever is in the global slot, whose Keychain item
 * carries no directory hash, and `zai` is the Z.ai key kept in the default slot
 * rather than under a profile name. An env-file profile has no login of its
 * own, so it has no usage either.
 */
export function usageRecords(profiles, env = process.env) {
  return profiles
    .map((profile) => {
      if (profile.id === "claude")
        return {
          name: "claude",
          provider: "anthropic",
          dir: defaultConfigDir(env),
          credentialService: DEFAULT_CREDENTIAL_SERVICE,
        };
      if (profile.id === "zai") return { name: "zai", provider: "zai", zaiProfile: null };
      if (profile.configDir)
        return { name: profile.id, provider: profile.provider ?? "anthropic", dir: profile.configDir };
      return null;
    })
    .filter(Boolean);
}

/** Usage costs network calls, so it stays out of scripts and out of the way. */
function usageWanted({ options, env, interactive }) {
  return interactive && !options.noUsage && !flag(env, "ZCLAUDE_NO_USAGE");
}

const PROFILE_SOURCES = Object.freeze({
  env: "ZCLAUDE_PROFILE in this shell",
  project: "the project's .zclaude/env",
  user: "your ~/.zclaude/settings",
});

/**
 * The picker, and the one thing it can do besides pick.
 *
 * A row whose login has expired offers `s`, and taking it signs that profile in
 * and then carries on into it: signing in is why the row was chosen, so making
 * it a separate errand would defeat offering it. A sign-in that fails has
 * already said so and said how to retry, and the launch goes ahead anyway —
 * Claude Code prompts for a login of its own, which is no worse than before.
 */
async function askWhichProfile({ profiles, store, usageEnabled, busy, state, env, interactive }) {
  const picked = store
    ? await chooseProfileWithUsage(profiles, { defaultId: state.lastProfile, store, usageEnabled, busy })
    : { id: await chooseProfile(profiles, { defaultId: state.lastProfile }), action: "launch" };
  if (picked.action !== "signIn") return picked.id;
  // The built-in Z.ai row is a key rather than an account, so it has its own
  // flow and no profile to name.
  const signIn =
    picked.id === "zai"
      ? zaiLoginFor({ env, options: {}, profile: null })
      : signInProfile(picked.id, { env, zaiLogin: zaiLoginFor, interactive });
  await signIn.catch((error) => warn(`Signing in to "${picked.id}" failed: ${error.message}`));
  store?.load({ force: true }).catch((error) => debug(`usage not reloaded: ${error.message}`));
  return picked.id;
}

async function selectProfile({ options, env, layered, interactive, profiles }) {
  const known = (id) => Boolean(findProfile(profiles, id));
  const configured = resolveProfileDefault({ env, layered });
  let via = options.profile ? "flag" : (configured?.source ?? "menu");
  let profileId = options.profile ?? configured?.value ?? null;

  // A profile named by a config file may simply not exist on this machine:
  // .zclaude/env is committed, and a teammate has their own profiles. That is
  // a reason to ask rather than to fail; a wrong --profile is still an error.
  if (profileId && via !== "flag" && !known(profileId)) {
    warn(
      `${PROFILE_SOURCES[via] ?? "Your configuration"} names the profile "${profileId}", which does not exist here.`,
    );
    log.warn("profile", "configured profile is unknown", { id: profileId, via, available: profiles.map((p) => p.id) });
    profileId = null;
    via = "menu";
  }
  if (!profileId) {
    if (!interactive)
      throw usageError(
        "No profile selected and no terminal to ask.",
        "Pass --profile claude or --profile zai (or set ZCLAUDE_PROFILE).",
      );
    const state = await readState(env);
    const usageEnabled = usageWanted({ options, env, interactive });
    // The fetch starts before the prompt and is never awaited: the list has to
    // be on screen and usable while the numbers are still arriving.
    const store = usageEnabled ? createUsageStore(usageRecords(profiles, env), { env }) : null;
    store?.load().catch((error) => debug(`usage not loaded: ${error.message}`));
    // Which accounts are already busy. Local, quick, and worth having before
    // the list is on screen rather than after the choice is made.
    const busy = flag(env, "ZCLAUDE_NO_SESSIONS")
      ? new Map()
      : await collectSessions({ env })
          .then(byProfile)
          .catch((error) => {
            debug(`sessions not read: ${error.message}`);
            return new Map();
          });
    profileId = await askWhichProfile({ profiles, store, usageEnabled, busy, state, env, interactive });
    await writeState({ lastProfile: profileId }, env).catch((error) => debug(`state not saved: ${error.message}`));
  }
  const profile = findProfile(profiles, profileId);
  log.info("profile", "profile selected", {
    id: profileId,
    known: Boolean(profile),
    via,
    available: profiles.map((item) => item.id),
  });
  if (!profile)
    throw usageError(`Unknown profile "${profileId}".`, `Available: ${profiles.map((item) => item.id).join(", ")}`);
  debug(`Profile: ${profile.id}`);
  return profile;
}

async function cmdLaunch({ options, passthrough, env, cwd }) {
  const bin = requireClaude({ env });
  const interactive = isInteractive();
  const layered = await loadLayeredConfig({ cwd, env });
  reportWarnings(layered);
  if (interactive && !options.noBanner && !flag(env, "ZCLAUDE_NO_BANNER")) printBanner({ env });

  if (interactive) {
    const newer = await checkForUpdate({ env });
    if (newer) info(`zclaude ${newer} is available (you have ${VERSION}). Update with: zclaude self-update`);
  }
  // `zclaude work` is `zclaude --profile work`; anything that is not a profile
  // name is left alone and reaches claude as before.
  const profiles = await listProfiles(env);
  const shortcut = options.profile ? { profile: null, args: passthrough } : takeProfileArgument(passthrough, profiles);
  const claudeInput = shortcut.args;
  if (shortcut.profile) log.info("profile", "profile named as the first argument", { id: shortcut.profile });
  const profile = await selectProfile({
    options: shortcut.profile ? { ...options, profile: shortcut.profile } : options,
    env,
    layered,
    interactive,
    profiles,
  });
  const extra = { ...extraEnv(layered), ...profile.env };
  // A named profile brings its own config directory and shared settings file;
  // the built-in profiles bring neither, and must not, because setting
  // CLAUDE_CONFIG_DIR at all moves Claude Code off the default login.
  const record = profile.configDir ? await getRegistered(profile.id, env) : null;
  const prepared = record ? await launchContext(record, env) : null;
  const claudeArgs = prepared?.claudeArgs ?? [];
  const session = describeSession({ profile, prepared, env, cwd });

  if (!profile.zai) {
    const args = [...claudeArgs, ...(options.model ? ["--model", options.model] : []), ...claudeInput];
    const childEnv = prepared
      ? buildProfileEnv({ baseEnv: env, configDir: prepared.configDir, extra })
      : buildPlainEnv({ baseEnv: env, extra });
    if (prepared) await resolveSettingsConflict({ env, childEnv, cwd, interactive });
    reportInheritedAuth(childEnv, profile);
    await warnIfBusy(session, env, interactive);
    return runClaude(bin, args, childEnv, { session, trackerEnv: env });
  }

  const config = zaiConfig(env);
  const credential = await resolveCredential({ options, env, config, interactive, profile: record?.name ?? null });
  return launchZai({
    bin,
    session,
    options,
    passthrough: claudeInput,
    env,
    cwd,
    layered,
    interactive,
    config,
    credential,
    extra,
    prepared,
  });
}

/**
 * An API key inherited from the shell replaces an account login. It is
 * reported rather than stripped: someone may have set it deliberately.
 */
function reportInheritedAuth(childEnv, profile) {
  const inherited = overridingAuthVars(childEnv);
  if (inherited.length === 0) return;
  warn(
    `${inherited.join(", ")} is set in this shell, so claude will use it instead of the ${profile.id} account login.`,
  );
  log.warn("profile", "inherited auth variables", { profile: profile.id, keys: inherited });
}

/** Pick models (wizard when needed), report quota, and hand off to claude. */
async function launchZai({
  bin,
  session,
  options,
  passthrough,
  env,
  cwd,
  layered,
  interactive,
  config,
  credential,
  extra,
  prepared = null,
}) {
  const availableModels = credential.check?.models ?? [];
  log.info("auth", "credential resolved", {
    source: credential.source,
    key: mask(credential.apiKey),
    check: credential.check ? { status: credential.check.status, httpStatus: credential.check.httpStatus } : null,
    models: availableModels.map((model) => model.id),
  });
  const resolved = resolveModels({ flags: flagModels(options), env, layered });
  const models = await maybeRunWizard({ options, env, layered, interactive, models: resolved, availableModels, cwd });
  warnUnknownModels(models, availableModels);
  log.info("config", "models resolved", {
    primary: models.primary,
    subagent: models.subagent,
    fast: models.fast,
    sources: models.sources,
  });

  if (credential.check && credential.check.status !== "rejected") {
    const quota = await fetchQuota(credential.apiKey, config);
    const line = formatQuota(quota);
    if (line) (quotaExhausted(quota) ? warn : info)(line);
  }
  const childEnv = buildZaiEnv({
    baseEnv: env,
    apiKey: credential.apiKey,
    config,
    models,
    extra,
    configDir: prepared?.configDir ?? null,
  });
  await resolveSettingsConflict({ env, childEnv, cwd, interactive });
  info(`Launching claude on ${models.primary} (subagents: ${models.subagent}, fast: ${models.fast})`);
  await warnIfBusy(session, env, interactive);
  return runClaude(bin, [...(prepared?.claudeArgs ?? []), ...passthrough], childEnv, { session, trackerEnv: env });
}

/**
 * What the session list will show for this run. The built-in profile has no
 * directory of its own, so it is recorded against the default one — which is
 * exactly the account it spends.
 */
function describeSession({ profile, prepared, env, cwd }) {
  return {
    profile: profile.id,
    account: profile.description ?? null,
    configDir: prepared?.configDir ?? defaultConfigDir(env),
    cwd,
  };
}

/**
 * Say so when this account is already busy. Informative, never a gate: two
 * sessions on one account is a legitimate thing to do, and the reason to
 * mention it is that the second one shares the first one's five-hour window.
 */
async function warnIfBusy(session, env, interactive) {
  if (!interactive || flag(env, "ZCLAUDE_NO_SESSIONS")) return;
  try {
    const sessions = await liveSessions({ env });
    const mine = sessions.filter((entry) => entry.profile === session.profile);
    if (mine.length === 0) return;
    const working = mine.filter((entry) => entry.state === "working").length;
    const count = `${mine.length} session${mine.length === 1 ? "" : "s"}`;
    const detail = working > 0 ? `${working} of them active` : "all idle";
    (working > 0 ? warn : info)(`"${session.profile}" already has ${count} running (${detail}).`);
    info("  They share one account's limits. `zclaude sessions` shows what is where.");
  } catch (error) {
    debug(`sessions not checked: ${error.message}`);
  }
}

// ----------------------------------------------------------------- commands

async function cmdLogin({ options, passthrough, env, cwd }) {
  const interactive = isInteractive();
  if (!interactive)
    throw usageError("`zclaude login` needs an interactive terminal.", "For scripts, set ZAI_API_KEY instead.");
  const config = zaiConfig(env);
  const store = !options.noStore && !flag(env, "ZCLAUDE_NO_STORE");
  const context = { options, env, config, interactive, store };
  const credential = options.apiKey ? await manualKeyLogin(context) : await loginWithRetries(context);
  if (!store) warn("The key was not stored (--no-store). It will be needed again next time.");

  // Signing in is usually the first step of a session: continue into the
  // model wizard and offer to start claude right away.
  const bin = optionalClaude(env);
  if (!bin) {
    warn("Claude Code is not installed yet, so there is nothing to launch. The key is stored for later.");
    return EXIT.OK;
  }
  const layered = await loadLayeredConfig({ cwd, env });
  reportWarnings(layered);
  const next = await confirmChoice(
    "Signed in. Launch Claude Code on Z.ai now?",
    [
      { name: "Yes, pick models and launch", value: "launch" },
      { name: "Not now", value: "done" },
    ],
    "launch",
  );
  log.info("cli", "post-login choice", { next });
  if (next !== "launch") {
    info("Run `zclaude` whenever you are ready; the key is stored.");
    return EXIT.OK;
  }
  return launchZai({
    bin,
    // The built-in Z.ai profile, since that is what `zclaude login` signs in to.
    session: describeSession({ profile: { id: "zai" }, prepared: null, env, cwd }),
    options,
    passthrough,
    env,
    cwd,
    layered,
    interactive,
    config,
    credential,
    extra: extraEnv(layered),
  });
}

/**
 * The Z.ai sign-in, as the profile commands need it: same flow, but the key is
 * stored under the profile rather than the single default slot.
 */
function zaiLoginFor({ env, options, profile = null }) {
  const config = zaiConfig(env);
  const store = !options.noStore && !flag(env, "ZCLAUDE_NO_STORE");
  const context = { options, env, config, interactive: isInteractive(), store, profile };
  return options.apiKey ? manualKeyLogin(context) : loginWithRetries(context);
}

function cmdSwitchGroup_(context) {
  return cmdSwitchGroup(context, { interactive: isInteractive() });
}

function cmdProfileGroup(context) {
  return cmdProfile(context, { zaiLogin: zaiLoginFor, interactive: isInteractive() });
}

async function cmdLogout({ env }) {
  const { removed } = await deleteCredential({ env });
  if (removed.length === 0) info("No stored Z.ai credential found.");
  else success(`Removed the stored credential from: ${removed.join(", ")}.`);
  info(
    `The API key itself still exists on your Z.ai account. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`,
  );
  return EXIT.OK;
}

function storedOrExplicit(env) {
  const explicit = explicitKey(env);
  return explicit ? Promise.resolve({ apiKey: explicit, source: "env" }) : loadCredential({ env });
}

function optionalClaude(env) {
  try {
    return requireClaude({ env });
  } catch {
    return null;
  }
}

async function cmdModels({ env }) {
  const config = zaiConfig(env);
  const stored = await storedOrExplicit(env);
  if (!stored) throw authError("No Z.ai credential available.", "Run `zclaude login` first.");
  const check = await checkKey(stored.apiKey, config);
  if (check.status === "rejected")
    throw keyRejectedError(
      `Z.ai rejected the ${stored.source} key (HTTP ${check.httpStatus}).`,
      "Run `zclaude login` to sign in again.",
    );
  if (check.status !== "valid")
    throw new ZclaudeError(`Could not list models (${httpDetail(check)}).`, { exitCode: EXIT.NETWORK });
  for (const model of check.models) process.stdout.write(`${model.id.padEnd(20)} ${describeContextWindow(model.id)}\n`);
  return EXIT.OK;
}

async function inspectCredential(credential, config) {
  if (!credential) return { check: null, quota: null, checkError: null };
  registerSecret(credential.apiKey);
  try {
    const check = await checkKey(credential.apiKey, config);
    const quota = check.status === "rejected" ? null : await fetchQuota(credential.apiKey, config);
    return { check, quota, checkError: null };
  } catch (error) {
    return { check: null, quota: null, checkError: error.message };
  }
}

async function gatherStatus({ options, env, cwd }) {
  const config = zaiConfig(env);
  const layered = await loadLayeredConfig({ cwd, env });
  const bin = optionalClaude(env);
  const credential = await storedOrExplicit(env);
  const [version, inspection, profiles, named, tiers] = await Promise.all([
    bin ? claudeVersion(bin) : null,
    inspectCredential(credential, config),
    listProfiles(env),
    profileSummaries(env),
    claudeSettingsTiers({ env, cwd }),
  ]);
  const overriding = tiers
    .map((tier) => ({
      tier: tier.tier,
      path: tier.path,
      keys: SESSION_KEYS.filter((key) => Object.hasOwn(tier.block, key)),
    }))
    .filter((entry) => entry.keys.length > 0);
  const inheritedConfigDir =
    typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR.trim() : null;
  return {
    zclaude: VERSION,
    claude: { path: bin, version },
    credential,
    ...inspection,
    layered,
    models: resolveModels({ flags: flagModels(options), env, layered }),
    wizardNeeded: wizardNeeded(layered),
    profiles: profiles.map((profile) => profile.id),
    named,
    conflicts: overriding,
    inheritedConfigDir,
    storeHome: storePaths(env).home,
  };
}

function statusJson(status) {
  const { credential, check, checkError } = status;
  return {
    zclaude: status.zclaude,
    claude: status.claude,
    credential: credential
      ? {
          source: credential.source,
          key: mask(credential.apiKey),
          email: credential.email || null,
          keyName: credential.keyName || null,
          status: check?.status ?? (checkError ? "unchecked" : null),
          httpStatus: check?.httpStatus ?? null,
          error: checkError,
        }
      : null,
    quota: status.quota,
    config: {
      project: {
        path: status.layered.project.path,
        exists: status.layered.project.exists,
        values: status.layered.project.values,
      },
      user: { path: status.layered.user.path, exists: status.layered.user.exists, values: status.layered.user.values },
      store: status.storeHome,
    },
    models: status.models,
    wizardNeeded: status.wizardNeeded,
    profiles: status.profiles,
    namedProfiles: status.named,
    inheritedConfigDir: status.inheritedConfigDir,
    claudeSettingsConflicts: status.conflicts,
  };
}

function statusText(status) {
  const grey = (text) => paint(text, "grey", process.stdout);
  const label = (text) => grey(text.padEnd(12));
  const { credential, check, checkError, quota, layered, models, claude } = status;
  const describeFile = (record) =>
    record.exists ? `${record.path} (${Object.keys(record.values).length} keys)` : `${record.path} (missing)`;
  const modelLine = (slot, name) =>
    `${label(name)}${slot.padEnd(9)}${models[slot].padEnd(18)} ${grey(`(${models.sources[slot]})`)}`;
  const credentialLines = credential
    ? [
        `${label("credential")}${credential.source} ${mask(credential.apiKey)}${credential.email ? ` · ${credential.email}` : ""}`,
        check ? `${label("")}${check.status}${check.httpStatus ? ` (HTTP ${check.httpStatus})` : ""}` : null,
        checkError ? `${label("")}not validated: ${checkError}` : null,
        formatQuota(quota) ? `${label("")}${formatQuota(quota)}` : null,
      ]
    : [`${label("credential")}none (run \`zclaude login\`)`];
  const lines = [
    `${label("zclaude")}${status.zclaude}`,
    `${label("claude")}${claude.path ? `${claude.path}${claude.version ? ` (${claude.version})` : ""}` : "not found"}`,
    ...credentialLines,
    `${label("config")}project ${describeFile(layered.project)}`,
    `${label("")}user    ${describeFile(layered.user)}`,
    modelLine("primary", "models"),
    modelLine("subagent", ""),
    modelLine("fast", ""),
    `${label("wizard")}${status.wizardNeeded ? "will run on the next Z.ai launch (no saved config)" : "not needed (use --reconfigure to change models)"}`,
    `${label("profiles")}${status.profiles.join(", ")}`,
    ...status.named.map(
      (profile) =>
        `${label("")}${profile.name} ${grey(`${profile.provider} · ${profile.account} · shares ${describeShare(profile.share)}`)}`,
    ),
    `${label("log")}${logFilePath() ?? "disabled"}`,
    status.inheritedConfigDir
      ? `${label("config dir")}${status.inheritedConfigDir} ${grey("(inherited from this shell: your default Claude Code login is not visible here)")}`
      : null,
    ...status.conflicts.map(
      (entry) =>
        `${label("settings")}${entry.path} (${entry.tier}) env block sets ${entry.keys.join(", ")} ${grey("(applied over this session's environment)")}`,
    ),
  ];
  return `${lines.filter(Boolean).join("\n")}\n`;
}

async function cmdStatus(context) {
  const status = await gatherStatus(context);
  process.stdout.write(context.options.json ? `${JSON.stringify(statusJson(status), null, 2)}\n` : statusText(status));
  return EXIT.OK;
}

function runNpm(args, env) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, { stdio: "inherit", env, shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function npmOutput(args, env) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve) => {
    execFile(
      npm,
      args,
      { env, timeout: 15_000, windowsHide: true, shell: process.platform === "win32" },
      (error, stdout) => {
        resolve(error ? null : String(stdout).trim());
      },
    );
  });
}

/**
 * Install zclaude globally with npm, so `npx github:vipincr/zclaude self-install`
 * leaves a plain `zclaude` command behind. Uses the npm registry when this
 * package is published there, GitHub otherwise.
 */
async function cmdSelfInstall({ env }) {
  const spec = await npmSpec(env);
  info(`Installing ${spec} globally with npm`);
  log.info("cli", "self-install", { spec });
  let code;
  try {
    code = await runNpm(["install", "-g", spec], env);
  } catch (error) {
    throw usageError(
      `Could not run npm (${error.message}).`,
      "Install Node.js 20.17+ first, or use the curl installer from the README.",
    );
  }
  if (code !== 0) {
    throw new ZclaudeError(`npm install -g exited with ${code}.`, {
      exitCode: EXIT.INTERNAL,
      hint: "If this was a permissions error, point npm at a user prefix: npm config set prefix ~/.npm-global (and add ~/.npm-global/bin to PATH).",
    });
  }
  const verified = await verifyGlobalInstall(env);
  log.info("cli", "self-install verified", verified);
  if (!verified.ok)
    throw new ZclaudeError("The global install did not produce a working command.", {
      exitCode: EXIT.INTERNAL,
      hint: verified.note,
    });
  success(verified.note);
  return EXIT.OK;
}

/**
 * Remove this installation, whichever way it was installed, along with the
 * stored key and (unless --keep-config) everything under ~/.zclaude.
 */
/**
 * The parts of an installation that do not live under ~/.zclaude: Keychain
 * items, a scheduled job, and the editor extension. Removing the directory
 * would leave every one of them behind.
 */
async function removeEverythingOutsideTheHome(env) {
  const cleared = await clearBackups({ env });
  if (cleared > 0) info(`Removed ${cleared} saved copy of a previous global login.`);
  const unscheduled = await unschedule({ env });
  if (unscheduled.removed.length > 0) info(`Removed the renewal schedule: ${unscheduled.removed.join(", ")}.`);
  const editors = await uninstallExtension({ env }).catch(() => []);
  for (const result of editors) {
    if (result.removed) info(`Removed the status bar item from ${result.editor.label}.`);
  }
}

async function cmdSelfUninstall({ options, env }) {
  const kind = detectInstallKind({ env });
  const keepConfig = Boolean(options.keepConfig);

  const { removed } = await deleteCredential({ env });
  if (removed.length > 0) info(`Removed the stored Z.ai key from: ${removed.join(", ")}.`);
  const profiles = await forgetAllProfiles(env);
  if (profiles.forgotten.length > 0) info(`Signed out of: ${profiles.forgotten.join(", ")}.`);
  if (!keepConfig && profiles.profiles.length > 0)
    info(`Removing ${profiles.profiles.length} profile director${profiles.profiles.length === 1 ? "y" : "ies"}.`);
  if (!keepConfig) await removeEverythingOutsideTheHome(env);

  if (kind === "checkout") {
    info("This is a git checkout: delete the clone and any symlink you made to it.");
  } else {
    info(`Removing the ${kind === "npm" ? "npm" : "script"} installation of zclaude`);
    const code = await selfUninstall({ env, kind, keepConfig });
    if (code !== 0) throw new ZclaudeError(`The uninstall exited with ${code}.`, { exitCode: EXIT.INTERNAL });
    if (kind === "npm") {
      const binDir = await npmBinDir(execFile, env);
      if (binDir) await rm(join(binDir, "zclaude"), { force: true }).catch(() => {});
    }
  }

  const home = zclaudeHome(env);
  if (keepConfig) {
    info(`Kept ${home} (settings, logs).`);
  } else {
    // Stop writing the run log before its directory disappears.
    configureLogger({ env, disabled: true });
    await rm(home, { recursive: true, force: true }).catch((error) =>
      warn(`Could not remove ${home}: ${error.message}`),
    );
    info(`Removed ${home}.`);
  }
  success("zclaude is gone from this machine.");
  info(`The API key still exists on your Z.ai account. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`);
  return EXIT.OK;
}

async function npmSpec(env) {
  const published = await npmOutput(["view", "zclaude", "version"], env);
  return published && /^\d+\.\d+\.\d+/u.test(published) ? "zclaude@latest" : GITHUB_SPEC;
}

function withoutTrailingSlash(path) {
  let out = String(path);
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function onPath(dir, env) {
  const entries = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => withoutTrailingSlash(entry));
  return entries.includes(withoutTrailingSlash(dir));
}

/**
 * Confirm the command npm just installed is really there and runnable, then
 * say exactly what to do next. A global install that leaves a dangling link
 * (npm does this for git specs it cannot prepare) is reported as a failure.
 */
async function verifyGlobalInstall(env) {
  const binDir = await npmBinDir(execFile, env);
  if (!binDir) return { ok: true, note: "Run `zclaude` from any directory." };
  const command = join(binDir, process.platform === "win32" ? "zclaude.cmd" : "zclaude");
  const version = await new Promise((resolve) => {
    execFile(command, ["--version"], { env, timeout: 20_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim().split("\n", 1)[0]);
    });
  });
  if (!version) {
    return {
      ok: false,
      note: `npm reported success but ${command} does not run. Install with the script instead:\n  curl -fsSL ${INSTALLER_URL} | bash`,
    };
  }
  if (!onPath(binDir, env)) {
    return {
      ok: true,
      note: `${version} installed. Add npm's bin directory to your PATH to use it:\n  export PATH="${binDir}:$PATH"`,
    };
  }
  return { ok: true, note: `${version} installed. Run \`zclaude\` from any directory.` };
}

/** Update in place, using whichever install path put zclaude here. */
async function cmdSelfUpdate({ options, env }) {
  const latest = await fetchLatestVersion();
  if (!latest) warn("Could not reach GitHub to look up the newest version; trying the update anyway.");
  else if (compareVersions(latest, VERSION) <= 0 && !options.force) {
    success(`zclaude ${VERSION} is already the newest version.`);
    info("If you know a newer one was just pushed, `zclaude self-update --force` installs it anyway.");
    return EXIT.OK;
  } else if (latest) info(`Updating zclaude ${VERSION} -> ${latest}${options.force ? " (forced)" : ""}`);
  const kind = detectInstallKind({ env });
  const code = await selfUpdate({ env, kind, npmSpec: await npmSpec(env) });
  if (code === null) {
    info("This is a git checkout: run `git pull && npm install` to update it.");
    return EXIT.OK;
  }
  if (code !== 0) throw new ZclaudeError(`The ${kind} update exited with ${code}.`, { exitCode: EXIT.INTERNAL });
  const installed = await installedVersion({ env, kind });
  if (!installed) {
    success("Updated. Run `zclaude --version` in a new terminal to confirm.");
    return EXIT.OK;
  }
  if (installed === VERSION) {
    warn(
      `The update finished but ${installed} is still what is installed. Open a new terminal, or run \`zclaude self-update --force\`.`,
    );
    return EXIT.OK;
  }
  success(`Updated to ${installed}. Open a new terminal to use it.`);
  await mentionStaleExtension(env);
  return EXIT.OK;
}

/**
 * An update replaces the packaged vsix; the copy inside the editor stays where
 * it is. Saying so costs one line and saves a confusing afternoon.
 */
async function mentionStaleExtension(env) {
  try {
    const packaged = await packagedVersion();
    if (!packaged) return;
    const editors = await findEditors({ env });
    const states = await Promise.all(editors.map((editor) => editorExtensionVersion(editor, { env })));
    const stale = states.some((state) => state.state === "installed" && state.version !== packaged);
    if (stale)
      info(`The VS Code status bar item is older than ${packaged}. Update it with \`zclaude vscode install\`.`);
  } catch (error) {
    debug(`extension version not checked: ${error.message}`);
  }
}

/**
 * The version sitting on disk after an update, read from the package it just
 * installed. Reporting what actually landed beats telling someone to go and
 * check for themselves.
 */
async function installedVersion({ env, kind }) {
  const binDir = kind === "npm" ? await npmBinDir(execFile, env) : null;
  const roots = [
    kind === "installer" ? env.ZCLAUDE_INSTALL_DIR || join(zclaudeHome(env), "app") : null,
    binDir ? join(dirname(binDir), "lib", "node_modules", "zclaude") : null,
    binDir ? join(binDir, "..", "lib", "node_modules", "zclaude") : null,
  ].filter(Boolean);
  for (const root of roots) {
    try {
      const raw = await readFile(join(root, "package.json"), "utf8");
      const version = JSON.parse(raw)?.version;
      if (typeof version === "string") return version;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Show the latest run log so a failed run can be examined after the fact. */
function cmdLog({ options, env }) {
  const [latest] = listLogs(env);
  if (!latest) {
    process.stderr.write(`No run logs yet (looked in ${logsDirFor(env)}).\n`);
    return EXIT.USAGE;
  }
  if (options.pathOnly) {
    process.stdout.write(`${latest}\n`);
    return EXIT.OK;
  }
  const entries = readLog(latest);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return EXIT.OK;
  }
  process.stdout.write(`${paint(latest, "grey", process.stdout)}\n`);
  for (const entry of entries) process.stdout.write(`${formatEntry(entry)}\n`);
  return EXIT.OK;
}

function logsDirFor(env) {
  return dirname(listLogs(env)[0] ?? join(zclaudeHome(env), "logs", "x"));
}

async function cmdVersion({ env }) {
  const bin = optionalClaude(env);
  const claude = bin ? ((await claudeVersion(bin)) ?? bin) : "not found";
  process.stdout.write(`zclaude ${VERSION}\nclaude ${claude}\n`);
  return EXIT.OK;
}

// --------------------------------------------------------------------- main

const COMMAND_HANDLERS = {
  help: () => {
    process.stdout.write(HELP);
    return EXIT.OK;
  },
  version: cmdVersion,
  login: cmdLogin,
  logout: cmdLogout,
  status: cmdStatus,
  models: cmdModels,
  log: cmdLog,
  "self-install": cmdSelfInstall,
  "self-update": cmdSelfUpdate,
  "self-uninstall": cmdSelfUninstall,
  profile: cmdProfileGroup,
  switch: cmdSwitchGroup_,
  renew: cmdRenewGroup,
  vscode: cmdVscodeGroup,
  sessions: cmdSessions,
  launch: cmdLaunch,
};

export function main(argv, { env = process.env, cwd = process.cwd() } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    configureLogger({ env, argv });
    log.error("cli", "argument parsing failed", { error });
    throw error;
  }
  if (parsed.command !== "log") {
    configureLogger({
      env,
      argv,
      level: parsed.options.logLevel,
      file: parsed.options.logFile,
      disabled: Boolean(parsed.options.noLog),
    });
  }
  setVerbose(Boolean(parsed.options.verbose));
  setQuiet(Boolean(parsed.options.quiet));
  log.info("cli", "command", { command: parsed.command, options: parsed.options, passthrough: parsed.passthrough });
  const handler = COMMAND_HANDLERS[parsed.command] ?? cmdLaunch;
  return handler({ ...parsed, env, cwd });
}
