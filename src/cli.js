// Command-line front end and orchestration.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { openUrl } from "./browser.js";
import { receiveCallback } from "./callback/index.js";
import { buildPlainEnv, buildZaiEnv, claudeVersion, requireClaude, runClaude } from "./claude.js";
import {
  CONSOLE_KEYS_URL,
  describeContextWindow,
  flag,
  isZaiBaseUrl,
  loginTimeoutMs,
  VERSION,
  zaiConfig,
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
import { registerSecret } from "./http.js";
import { buildAuthorizeUrl, exchangeCode, generateState, parseCallback } from "./oauth.js";
import { listProfiles } from "./profiles.js";
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
import { debug, error as logError, info, mask, paint, setVerbose, success, warn } from "./ui/log.js";
import { chooseProfile } from "./ui/menu.js";
import { chooseSaveLocation, confirmChoice, knownModels, promptApiKey, runModelWizard } from "./ui/wizard.js";
import { checkKey, fetchQuota, formatQuota, quotaExhausted } from "./zai.js";

// ------------------------------------------------------------------ parsing

const COMMANDS = new Set(["login", "logout", "status", "models", "help"]);
const VALUE_FLAGS = Object.freeze({
  "--profile": "profile",
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
  zclaude [zclaude options] [claude args...]   pick a profile, then launch claude
  zclaude -- [claude args...]                  pass everything after -- to claude
  zclaude login [--no-browser] [--paste] [--api-key] [--no-store]
  zclaude logout                               forget the stored Z.ai key
  zclaude status [--json]                      show credential, config and model state
  zclaude models                               list models available to your Z.ai key

Options (must come before any claude argument)
  --profile <claude|zai|name>  skip the menu
  --reconfigure                run the model wizard even if config exists (alias --customize)
  --login                      sign in again before launching
  --model <id>                 primary model (Z.ai profile; forwarded to claude otherwise)
  --subagent-model <id>        subagent model (CLAUDE_CODE_SUBAGENT_MODEL)
  --fast-model <id>            haiku-class helper model
  --no-store                   keep the key in memory for this session only
  --no-banner                  skip the splash
  --verbose                    show what zclaude is doing
  -h, --help                   this help (use \`zclaude -- --help\` for claude's)
  -V, --version                zclaude and claude versions

Config files (dotenv, no secrets)
  ./.zclaude/env               project choices, safe to commit
  ~/.zclaude/settings          user defaults
  ~/.zclaude/profiles/*.env    extra menu entries (ZCLAUDE_ZAI=1 routes through Z.ai)

Environment
  ZAI_API_KEY                  use this key, never store it
  ZCLAUDE_PROFILE              default profile (skips the menu)
  ZCLAUDE_HOME                 config dir (default ~/.zclaude)
  ZCLAUDE_CLAUDE_BIN           path to claude
  ZCLAUDE_NO_STORE, ZCLAUDE_NO_KEYCHAIN, ZCLAUDE_NO_NATIVE_CALLBACK, ZCLAUDE_NO_BANNER
  ZCLAUDE_LOGIN_TIMEOUT        seconds to wait for the browser (default 300)
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

async function claudeSettingsConflicts(env = process.env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  const dir = configured || join(env.HOME || homedir(), ".claude");
  const path = join(dir, "settings.json");
  try {
    const settings = JSON.parse(await readFile(path, "utf8"));
    const block = settings?.env && typeof settings.env === "object" ? settings.env : {};
    const found = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"].filter((key) =>
      Object.hasOwn(block, key),
    );
    return found.length > 0 ? { path, keys: found } : null;
  } catch {
    return null;
  }
}

function flagModels(options) {
  return { primary: options.model, subagent: options.subagentModel, fast: options.fastModel };
}

function warnOnCheck(check, { fresh }) {
  if (check.status === "throttled") warn("The key works but the plan quota is currently exhausted.");
  else if (check.status === "inconclusive")
    warn(`Could not ${fresh ? "fully validate the new" : "validate the"} key (HTTP ${check.httpStatus}); continuing.`);
}

async function persist(credential, { store, env }) {
  if (!store) return "memory";
  const { location } = await saveCredential(credential, { env });
  return location;
}

function describeLocation(location) {
  return location === "memory" ? "kept in memory for this session" : `stored in ${location}`;
}

// -------------------------------------------------------------------- oauth

async function oauthLogin({ options, env, config, interactive, store }) {
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
  const location = await persist(credential, { store, env });
  const who = token.email ? ` as ${token.email}` : "";
  success(
    `Signed in${who}. Key "${minted.keyName}" ${minted.created ? "created" : "reused"} and ${describeLocation(location)}.`,
  );
  return { ...credential, location, check };
}

async function manualKeyLogin({ env, config, store }) {
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
  const location = await persist(credential, { store, env });
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

/** Find a credential without touching the network: env, inherited, or stored. */
async function findCandidate(env) {
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
  warn(`The stored Z.ai key was rejected (${detail}). Signing in again.`);
  await deleteCredential({ env: loginContext.env });
  if (!loginContext.interactive)
    throw authError(
      "Stored credential rejected and no terminal available to sign in again.",
      "Run `zclaude login` interactively.",
    );
  return loginWithRetries(loginContext);
}

/**
 * Resolve and validate the Z.ai credential for a launch. Returns
 * { apiKey, source, check } where check may be null when validation could
 * not be performed.
 */
async function resolveCredential({ options, env, config, interactive }) {
  const store = !options.noStore && !flag(env, "ZCLAUDE_NO_STORE");
  const loginContext = { options, env, config, interactive, store };
  if (options.login) {
    if (!interactive) throw usageError("--login needs an interactive terminal.");
    return loginWithRetries(loginContext);
  }
  const candidate = await findCandidate(env);
  if (!candidate) {
    if (!interactive)
      throw authError(
        "No Z.ai credential is available.",
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

async function selectProfile({ options, env, layered, interactive }) {
  const profiles = await listProfiles(env);
  let profileId = options.profile ?? resolveProfileDefault({ env, layered })?.value ?? null;
  if (!profileId) {
    if (!interactive)
      throw usageError(
        "No profile selected and no terminal to ask.",
        "Pass --profile claude or --profile zai (or set ZCLAUDE_PROFILE).",
      );
    const state = await readState(env);
    profileId = await chooseProfile(profiles, { defaultId: state.lastProfile });
    await writeState({ lastProfile: profileId }, env).catch((error) => debug(`state not saved: ${error.message}`));
  }
  const profile = profiles.find((item) => item.id === profileId);
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

  const profile = await selectProfile({ options, env, layered, interactive });
  const extra = { ...extraEnv(layered), ...profile.env };
  if (!profile.zai) {
    const args = options.model ? ["--model", options.model, ...passthrough] : passthrough;
    return runClaude(bin, args, buildPlainEnv({ baseEnv: env, extra }));
  }

  const config = zaiConfig(env);
  const conflict = await claudeSettingsConflicts(env);
  if (conflict)
    warn(
      `${conflict.path} sets ${conflict.keys.join(", ")} in its env block; Claude Code may apply those over this session. Remove them to use zclaude reliably.`,
    );

  const credential = await resolveCredential({ options, env, config, interactive });
  const availableModels = credential.check?.models ?? [];
  const resolved = resolveModels({ flags: flagModels(options), env, layered });
  const models = await maybeRunWizard({ options, env, layered, interactive, models: resolved, availableModels, cwd });
  warnUnknownModels(models, availableModels);

  if (credential.check && credential.check.status !== "rejected") {
    const quota = await fetchQuota(credential.apiKey, config);
    const line = formatQuota(quota);
    if (line) (quotaExhausted(quota) ? warn : info)(line);
  }
  info(`Launching claude on ${models.primary} (subagents: ${models.subagent}, fast: ${models.fast})`);
  const childEnv = buildZaiEnv({ baseEnv: env, apiKey: credential.apiKey, config, models, extra });
  return runClaude(bin, passthrough, childEnv);
}

// ----------------------------------------------------------------- commands

async function cmdLogin({ options, env }) {
  const interactive = isInteractive();
  if (!interactive)
    throw usageError("`zclaude login` needs an interactive terminal.", "For scripts, set ZAI_API_KEY instead.");
  const config = zaiConfig(env);
  const store = !options.noStore && !flag(env, "ZCLAUDE_NO_STORE");
  const context = { options, env, config, interactive, store };
  const result = options.apiKey ? await manualKeyLogin(context) : await loginWithRetries(context);
  const line = formatQuota(await fetchQuota(result.apiKey, config));
  if (line) info(line);
  if (!store) warn("The key was not stored (--no-store). It will be needed again next time.");
  return EXIT.OK;
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
  const [version, inspection, profiles, conflict] = await Promise.all([
    bin ? claudeVersion(bin) : null,
    inspectCredential(credential, config),
    listProfiles(env),
    claudeSettingsConflicts(env),
  ]);
  return {
    zclaude: VERSION,
    claude: { path: bin, version },
    credential,
    ...inspection,
    layered,
    models: resolveModels({ flags: flagModels(options), env, layered }),
    wizardNeeded: wizardNeeded(layered),
    profiles: profiles.map((profile) => profile.id),
    conflict,
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
    claudeSettingsConflict: status.conflict,
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
    status.conflict ? `${label("warning")}${status.conflict.path} sets ${status.conflict.keys.join(", ")}` : null,
  ];
  return `${lines.filter(Boolean).join("\n")}\n`;
}

async function cmdStatus(context) {
  const status = await gatherStatus(context);
  process.stdout.write(context.options.json ? `${JSON.stringify(statusJson(status), null, 2)}\n` : statusText(status));
  return EXIT.OK;
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
  launch: cmdLaunch,
};

export function main(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const parsed = parseArgs(argv);
  setVerbose(Boolean(parsed.options.verbose));
  const handler = COMMAND_HANDLERS[parsed.command] ?? cmdLaunch;
  return handler({ ...parsed, env, cwd });
}
