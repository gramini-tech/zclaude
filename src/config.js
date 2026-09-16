// Central constants and defaults. Every endpoint can be overridden through the
// environment so users are not stuck waiting for a release if Z.ai changes
// something on their side.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
export const VERSION = require("../package.json").version;

const DEFAULTS = {
  clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  redirectUri: "zcode://zai-auth/callback",
  apiBase: "https://api.z.ai",
  keyName: "zclaude",
};

export const CONSOLE_KEYS_URL = "https://z.ai/manage-apikey/apikey-list";
export const CALLBACK_SCHEME = "zcode";

// Model context windows, copied from Z.ai's own @z_ai/coding-helper
// model-registry. The models endpoint does not report them.
export const MODEL_CONTEXT_WINDOWS = {
  "glm-5.3-flash": 1_048_576,
  "glm-5.3": 1_048_576,
  "glm-5.2": 1_048_576,
  "glm-5.1": 200_000,
  "glm-5": 200_000,
  "glm-5-turbo": 204_800,
  "glm-4.7": 200_000,
  "glm-4.5-air": 128_000,
};
const FALLBACK_CONTEXT_WINDOW = 200_000;

export const DEFAULT_MODELS = Object.freeze({
  primary: "glm-5.3",
  subagent: "glm-5.3-flash",
  fast: "glm-5.3-flash",
});

export const TIMEOUTS = Object.freeze({
  validateMs: 8000,
  quotaMs: 3000,
  authMs: 15_000,
  loginDefaultSec: 300,
});

function pick(env, name, fallback) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Resolve endpoint configuration for a given environment. */
export function zaiConfig(env = process.env) {
  let apiBase = pick(env, "ZCLAUDE_BASE_URL", DEFAULTS.apiBase);
  while (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1);
  return {
    clientId: pick(env, "ZAI_OAUTH_CLIENT_ID", DEFAULTS.clientId),
    authorizeUrl: pick(env, "ZAI_OAUTH_AUTHORIZE_URL", DEFAULTS.authorizeUrl),
    tokenUrl: pick(env, "ZAI_OAUTH_TOKEN_URL", DEFAULTS.tokenUrl),
    redirectUri: pick(env, "ZAI_OAUTH_REDIRECT_URI", DEFAULTS.redirectUri),
    apiBase,
    bizLoginUrl: pick(env, "ZAI_BIZ_LOGIN_URL", `${apiBase}/api/auth/z/login`),
    anthropicBase: pick(env, "ZCLAUDE_ANTHROPIC_BASE_URL", `${apiBase}/api/anthropic`),
    modelsUrl: `${apiBase}/api/coding/paas/v4/models`,
    quotaUrl: `${apiBase}/api/monitor/usage/quota/limit`,
    keyName: pick(env, "ZCLAUDE_KEY_NAME", DEFAULTS.keyName),
  };
}

export function isZaiBaseUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const host = new URL(url).hostname;
    return host === "api.z.ai" || host === "open.bigmodel.cn";
  } catch {
    return false;
  }
}

export function zclaudeHome(env = process.env) {
  const configured = pick(env, "ZCLAUDE_HOME", "");
  if (configured) return configured;
  const home = pick(env, "HOME", "") || pick(env, "USERPROFILE", "") || homedir();
  return join(home, ".zclaude");
}

export function loginTimeoutMs(env = process.env) {
  const raw = Number(pick(env, "ZCLAUDE_LOGIN_TIMEOUT", ""));
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : TIMEOUTS.loginDefaultSec;
  return seconds * 1000;
}

export function flag(env, name) {
  const value = env[name];
  return typeof value === "string" && /^(1|true|yes|on)$/iu.test(value.trim());
}

/** Strip a Claude Code [1m] suffix and lowercase for lookup. */
function normalizeModelId(model) {
  return String(model ?? "")
    .trim()
    .replace(/\[1m\]$/iu, "")
    .toLowerCase();
}

export function contextWindowFor(model) {
  const key = normalizeModelId(model);
  if (!key) return FALLBACK_CONTEXT_WINDOW;
  return MODEL_CONTEXT_WINDOWS[key] ?? FALLBACK_CONTEXT_WINDOW;
}

/** Claude Code enables its 1M-context path only for ids ending in [1m]. */
export function formatModelForClaude(model) {
  const id = String(model ?? "").trim();
  if (!id || /\[1m\]$/iu.test(id)) return id;
  return contextWindowFor(id) >= 1_000_000 ? `${id}[1m]` : id;
}

export function describeContextWindow(model) {
  const size = contextWindowFor(model);
  if (size >= 1_000_000) return "1M context";
  return `${Math.round(size / 1000)}K context`;
}
