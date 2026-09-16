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
import { authError, EXIT, InterruptedError, isInterrupt, keyRejectedError, usageError, ZclaudeError } from "./errors.js";
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
const VALUE_FLAGS = {
  "--profile": "profile",
  "--model": "model",
  "--subagent-model": "subagentModel",
  "--fast-model": "fastModel",
};
const BOOL_FLAGS = {
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
};

export function parseArgs(argv) {
  const options = {};
  let command = null;
  let passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name in VALUE_FLAGS) {
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("-"))) {
        throw usageError(`${name} needs a value.`, `Example: zclaude ${name} glm-5.3`);
      }
      options[VALUE_FLAGS[name]] = value;
      continue;
    }
    if (arg in BOOL_FLAGS) {
      options[BOOL_FLAGS[arg]] = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      command = "help";
      break;
    }
    if (arg === "-V" || arg === "--version") {
      command = "version";
      break;
    }
    if (!command && !arg.startsWith("-") && COMMANDS.has(arg)) {
      command = arg;
      continue;
    }
    if (command) throw usageError(`Unknown argument for \`zclaude ${command}\`: ${arg}`, "Run `zclaude --help` for the list of options.");
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

async function claudeSettingsConflicts(env = process.env) {
  const dir = typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim()
    ? env.CLAUDE_CONFIG_DIR.trim()
    : join(env.HOME || homedir(), ".claude");
  const path = join(dir, "settings.json");
  try {
    const settings = JSON.parse(await readFile(path, "utf8"));
    const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
    const found = keys.filter((key) => settings?.env && typeof settings.env === "object" && key in settings.env);
    return found.length ? { path, keys: found } : null;
  } catch {
    return null;
  }
}

function flagModels(options) {
  return { primary: options.model, subagent: options.subagentModel, fast: options.fastModel };
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
      if (!options.noBrowser) {
        const result = await openUrl(url, { env });
        if (!result.opened) warn(`Could not open a browser automatically (${result.reason}). Open the URL above by hand.`);
      }
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
      `Z.ai issued a key, but the coding-plan API rejected it (HTTP ${check.httpStatus}${check.detail ? `: ${check.detail}` : ""}).`,
      "Make sure a GLM Coding Plan subscription is active on this account at https://z.ai, then run `zclaude login` again.",
    );
  }
  if (check.status === "throttled") warn("The key works but the plan quota is currently exhausted.");
  if (check.status === "inconclusive") warn(`Could not fully validate the new key (HTTP ${check.httpStatus}); continuing.`);

  const credential = { apiKey: minted.apiKey, email: token.email, userId: token.userId, keyName: minted.keyName, source: "oauth" };
  let location = "memory";
  if (store) ({ location } = await saveCredential(credential, { env }));
  success(`Signed in${token.email ? ` as ${token.email}` : ""}. Key "${minted.keyName}" ${minted.created ? "created" : "reused"} and ${location === "memory" ? "kept in memory for this session" : `stored in ${location}`}.`);
  return { ...credential, location, check };
}

async function loginWithRetries(context) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await oauthLogin(context);
    } catch (error) {
      if (isInterrupt(error) || !(error instanceof ZclaudeError) || error.exitCode !== EXIT.AUTH || !context.interactive) throw error;
      logError(error.message);
      if (error.hint) warn(error.hint);
      if (attempt >= 3) throw error;
      const next = await confirmChoice("Sign-in did not complete. What next?", [
        { name: "Try the browser sign-in again", value: "retry" },
        { name: "Paste a Z.ai API key instead", value: "apikey" },
        { name: "Quit", value: "quit" },
      ], "retry");
      if (next === "quit") throw new InterruptedError("Login cancelled.");
      if (next === "apikey") return manualKeyLogin(context);
    }
  }
}

async function manualKeyLogin({ env, config, store }) {
  const apiKey = await promptApiKey();
  registerSecret(apiKey);
  const check = await checkKey(apiKey, config);
  if (check.status === "rejected") {
    throw keyRejectedError(`Z.ai rejected that key (HTTP ${check.httpStatus}${check.detail ? `: ${check.detail}` : ""}).`, `Copy a coding-plan key from ${CONSOLE_KEYS_URL} and try again.`);
  }
  if (check.status === "throttled") warn("The key works but the plan quota is currently exhausted.");
  if (check.status === "inconclusive") warn(`Could not fully validate the key (HTTP ${check.httpStatus}); storing it anyway.`);
  const credential = { apiKey, email: "", userId: "", keyName: "", source: "manual" };
  let location = "memory";
  if (store) ({ location } = await saveCredential(credential, { env }));
  success(`Key ${mask(apiKey)} ${location === "memory" ? "kept in memory for this session" : `stored in ${location}`}.`);
  return { ...credential, location, check };
}

// --------------------------------------------------------------- credential

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

  const inheritedToken = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN.trim() : "";
  let candidate = null;
  if (typeof env.ZAI_API_KEY === "string" && env.ZAI_API_KEY.trim()) {
    candidate = { apiKey: env.ZAI_API_KEY.trim(), source: "env" };
    debug("Using ZAI_API_KEY from the environment");
  } else if (inheritedToken && isZaiBaseUrl(env.ANTHROPIC_BASE_URL)) {
    candidate = { apiKey: inheritedToken, source: "inherited" };
    info("Using ANTHROPIC_AUTH_TOKEN already present in the environment.");
  } else {
    if (inheritedToken) warn("ANTHROPIC_AUTH_TOKEN is set for a non-Z.ai endpoint; it will be replaced for this session.");
    const stored = await loadCredential({ env });
    if (stored) {
      candidate = { ...stored };
      debug(`Loaded credential from ${stored.source}`);
    }
  }

  if (!candidate) {
    if (!interactive) {
      throw authError("No Z.ai credential is available.", "Run `zclaude login` from an interactive terminal first, or set ZAI_API_KEY.");
    }
    return loginWithRetries(loginContext);
  }
  registerSecret(candidate.apiKey);

  let check;
  try {
    check = await checkKey(candidate.apiKey, config);
  } catch (error) {
    if (error?.exitCode === EXIT.NETWORK) {
      warn(`${error.message}. Skipping key validation; claude will report API errors itself.`);
      return { ...candidate, check: null };
    }
    throw error;
  }
  if (check.status === "rejected") {
    const detail = `HTTP ${check.httpStatus}${check.detail ? `: ${check.detail}` : ""}`;
    if (candidate.source === "env") throw keyRejectedError(`Z.ai rejected ZAI_API_KEY (${detail}).`, `Check the key at ${CONSOLE_KEYS_URL}.`);
    if (candidate.source === "inherited") throw keyRejectedError(`Z.ai rejected the ANTHROPIC_AUTH_TOKEN from your environment (${detail}).`, "Unset it or replace it with a valid coding-plan key.");
    warn(`The stored Z.ai key was rejected (${detail}). Signing in again.`);
    await deleteCredential({ env });
    if (!interactive) throw authError("Stored credential rejected and no terminal available to sign in again.", "Run `zclaude login` interactively.");
    return loginWithRetries(loginContext);
  }
  if (check.status === "throttled") warn("Your Z.ai plan quota is exhausted right now; claude will get rate-limit errors until it resets.");
  if (check.status === "inconclusive") warn(`Could not validate the key (HTTP ${check.httpStatus}); continuing anyway.`);
  return { ...candidate, check };
}

// ------------------------------------------------------------------- wizard

async function maybeRunWizard({ options, env, layered, interactive, models, availableModels, cwd }) {
  const projectConfigured = layered.project.exists && fileConfiguresModels(layered.project);
  const needed = Boolean(options.reconfigure) || (!layered.user.exists && !projectConfigured);
  if (!needed) return models;
  if (!interactive) {
    debug("Model wizard skipped: not an interactive terminal");
    return models;
  }
  if (!availableModels.length) warn("Could not fetch the model list from Z.ai; showing known models instead.");
  const chosen = await runModelWizard({ models: availableModels.length ? availableModels : knownModels(), current: models });
  const flags = flagModels(options);
  const final = {
    primary: flags.primary ?? chosen.primary,
    subagent: flags.subagent ?? chosen.subagent,
    fast: flags.fast ?? chosen.fast,
    sources: { primary: flags.primary ? "flag" : "wizard", subagent: flags.subagent ? "flag" : "wizard", fast: flags.fast ? "flag" : "wizard" },
  };
  const where = await chooseSaveLocation({ projectPath: projectEnvPath(cwd), userPath: userSettingsPath(env), userExists: layered.user.exists });
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
  if (!availableModels.length) return;
  const ids = new Set(availableModels.map((model) => model.id.toLowerCase()));
  for (const slot of ["primary", "subagent", "fast"]) {
    const id = String(models[slot]).replace(/\[1m\]$/iu, "").toLowerCase();
    if (!ids.has(id)) warn(`Model "${models[slot]}" (${slot}) is not in the list Z.ai returned for your plan. Run \`zclaude --reconfigure\` to pick another.`);
  }
}

// ------------------------------------------------------------------- launch

async function cmdLaunch({ options, passthrough, env, cwd }) {
  const bin = requireClaude({ env });
  const interactive = isInteractive();
  const layered = await loadLayeredConfig({ cwd, env });
  reportWarnings(layered);

  if (interactive && !options.noBanner && !flag(env, "ZCLAUDE_NO_BANNER")) printBanner({ env });

  const profiles = await listProfiles(env);
  let profileId = options.profile ?? resolveProfileDefault({ env, layered })?.value ?? null;
  if (!profileId) {
    if (!interactive) throw usageError("No profile selected and no terminal to ask.", "Pass --profile claude or --profile zai (or set ZCLAUDE_PROFILE).");
    const state = await readState(env);
    profileId = await chooseProfile(profiles, { defaultId: state.lastProfile });
    await writeState({ lastProfile: profileId }, env).catch((error) => debug(`state not saved: ${error.message}`));
  }
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw usageError(`Unknown profile "${profileId}".`, `Available: ${profiles.map((item) => item.id).join(", ")}`);
  debug(`Profile: ${profile.id}`);

  const extra = { ...extraEnv(layered), ...profile.env };

  if (!profile.zai) {
    const args = options.model ? ["--model", options.model, ...passthrough] : passthrough;
    return runClaude(bin, args, buildPlainEnv({ baseEnv: env, extra }));
  }

  const config = zaiConfig(env);
  const conflict = await claudeSettingsConflicts(env);
  if (conflict) warn(`${conflict.path} sets ${conflict.keys.join(", ")} in its env block; Claude Code may apply those over this session. Remove them to use zclaude reliably.`);

  const credential = await resolveCredential({ options, env, config, interactive });
  const availableModels = credential.check?.models ?? [];
  let models = resolveModels({ flags: flagModels(options), env, layered });
  models = await maybeRunWizard({ options, env, layered, interactive, models, availableModels, cwd });
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
  if (!interactive) throw usageError("`zclaude login` needs an interactive terminal.", "For scripts, set ZAI_API_KEY instead.");
  const config = zaiConfig(env);
  const store = !options.noStore && !flag(env, "ZCLAUDE_NO_STORE");
  const context = { options, env, config, interactive, store };
  const result = options.apiKey ? await manualKeyLogin(context) : await loginWithRetries(context);
  const quota = await fetchQuota(result.apiKey, config);
  const line = formatQuota(quota);
  if (line) info(line);
  if (!store) warn("The key was not stored (--no-store). It will be needed again next time.");
  return EXIT.OK;
}

async function cmdLogout({ env }) {
  const { removed } = await deleteCredential({ env });
  if (removed.length === 0) info("No stored Z.ai credential found.");
  else success(`Removed the stored credential from: ${removed.join(", ")}.`);
  info(`The API key itself still exists on your Z.ai account. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`);
  return EXIT.OK;
}

async function cmdModels({ env }) {
  const config = zaiConfig(env);
  const stored = (typeof env.ZAI_API_KEY === "string" && env.ZAI_API_KEY.trim())
    ? { apiKey: env.ZAI_API_KEY.trim(), source: "env" }
    : await loadCredential({ env });
  if (!stored) throw authError("No Z.ai credential available.", "Run `zclaude login` first.");
  const check = await checkKey(stored.apiKey, config);
  if (check.status === "rejected") throw keyRejectedError(`Z.ai rejected the ${stored.source} key (HTTP ${check.httpStatus}).`, "Run `zclaude login` to sign in again.");
  if (check.status !== "valid") throw new ZclaudeError(`Could not list models (HTTP ${check.httpStatus}${check.detail ? `: ${check.detail}` : ""}).`, { exitCode: EXIT.NETWORK });
  for (const model of check.models) process.stdout.write(`${model.id.padEnd(20)} ${describeContextWindow(model.id)}\n`);
  return EXIT.OK;
}

async function cmdStatus({ options, env, cwd }) {
  const config = zaiConfig(env);
  const layered = await loadLayeredConfig({ cwd, env });
  const bin = (() => {
    try {
      return requireClaude({ env });
    } catch {
      return null;
    }
  })();
  const version = bin ? await claudeVersion(bin) : null;
  const explicit = typeof env.ZAI_API_KEY === "string" && env.ZAI_API_KEY.trim();
  const credential = explicit ? { apiKey: env.ZAI_API_KEY.trim(), source: "env" } : await loadCredential({ env });
  let check = null;
  let quota = null;
  let checkError = null;
  if (credential) {
    registerSecret(credential.apiKey);
    try {
      check = await checkKey(credential.apiKey, config);
      if (check.status !== "rejected") quota = await fetchQuota(credential.apiKey, config);
    } catch (error) {
      checkError = error.message;
    }
  }
  const models = resolveModels({ flags: flagModels(options), env, layered });
  const projectConfigured = layered.project.exists && fileConfiguresModels(layered.project);
  const wizardNeeded = !layered.user.exists && !projectConfigured;
  const profiles = await listProfiles(env);
  const conflict = await claudeSettingsConflicts(env);

  const report = {
    zclaude: VERSION,
    claude: { path: bin, version },
    credential: credential
      ? { source: credential.source, key: mask(credential.apiKey), email: credential.email || null, keyName: credential.keyName || null, status: check?.status ?? (checkError ? "unchecked" : null), httpStatus: check?.httpStatus ?? null, error: checkError }
      : null,
    quota,
    config: {
      project: { path: layered.project.path, exists: layered.project.exists, values: layered.project.values },
      user: { path: layered.user.path, exists: layered.user.exists, values: layered.user.values },
      store: storePaths(env).home,
    },
    models,
    wizardNeeded,
    profiles: profiles.map((profile) => profile.id),
    claudeSettingsConflict: conflict,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT.OK;
  }

  const out = [];
  const label = (text) => paint(text.padEnd(12), "grey", process.stdout);
  out.push(`${label("zclaude")}${VERSION}`);
  out.push(`${label("claude")}${bin ? `${bin}${version ? ` (${version})` : ""}` : "not found"}`);
  if (!credential) out.push(`${label("credential")}none (run \`zclaude login\`)`);
  else {
    out.push(`${label("credential")}${credential.source} ${mask(credential.apiKey)}${credential.email ? ` · ${credential.email}` : ""}`);
    if (check) out.push(`${label("")}${check.status}${check.httpStatus ? ` (HTTP ${check.httpStatus})` : ""}`);
    if (checkError) out.push(`${label("")}not validated: ${checkError}`);
    const line = formatQuota(quota);
    if (line) out.push(`${label("")}${line}`);
  }
  const describeFile = (record) => (record.exists ? `${record.path} (${Object.keys(record.values).length} keys)` : `${record.path} (missing)`);
  out.push(`${label("config")}project ${describeFile(layered.project)}`);
  out.push(`${label("")}user    ${describeFile(layered.user)}`);
  out.push(`${label("models")}primary  ${models.primary.padEnd(18)} ${paint(`(${models.sources.primary})`, "grey", process.stdout)}`);
  out.push(`${label("")}subagent ${models.subagent.padEnd(18)} ${paint(`(${models.sources.subagent})`, "grey", process.stdout)}`);
  out.push(`${label("")}fast     ${models.fast.padEnd(18)} ${paint(`(${models.sources.fast})`, "grey", process.stdout)}`);
  out.push(`${label("wizard")}${wizardNeeded ? "will run on the next Z.ai launch (no saved config)" : "not needed (use --reconfigure to change models)"}`);
  out.push(`${label("profiles")}${profiles.map((profile) => profile.id).join(", ")}`);
  if (conflict) out.push(`${label("warning")}${conflict.path} sets ${conflict.keys.join(", ")}`);
  process.stdout.write(`${out.join("\n")}\n`);
  return EXIT.OK;
}

async function cmdVersion({ env }) {
  let claude = "not found";
  try {
    const bin = requireClaude({ env });
    claude = (await claudeVersion(bin)) ?? bin;
  } catch {
    // reported as not found
  }
  process.stdout.write(`zclaude ${VERSION}\nclaude ${claude}\n`);
  return EXIT.OK;
}

// --------------------------------------------------------------------- main

export async function main(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const parsed = parseArgs(argv);
  setVerbose(Boolean(parsed.options.verbose));
  const context = { ...parsed, env, cwd };
  switch (parsed.command) {
    case "help":
      process.stdout.write(HELP);
      return EXIT.OK;
    case "version":
      return cmdVersion(context);
    case "login":
      return cmdLogin(context);
    case "logout":
      return cmdLogout(context);
    case "status":
      return cmdStatus(context);
    case "models":
      return cmdModels(context);
    default:
      return cmdLaunch(context);
  }
}
