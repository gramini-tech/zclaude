// Claude Code's own credential item, handled in the exact shapes Claude Code
// uses itself. Read from the 2.1.274 bundle:
//
//   read    security find-generic-password -a <user> -w -s <service>
//   write   add-generic-password -U -a <user> -s <service> -X <hex>   (over `security -i`)
//   delete  security delete-generic-password -a <user> -s <service>
//
// Three details are not cosmetic. The account is the OS username, not the
// signed-in email, so an item written under any other account name is invisible
// to Claude Code. The value is hex (`-X`), which is how a JSON blob with quotes
// survives the line-oriented `security -i` protocol. And that protocol reads
// stdin with a 4096-byte buffer, so a command past the limit is truncated
// mid-argument and silently leaves the previous item in place; past it we pass
// the hex in argv instead, which is worse for privacy than stdin and far better
// than a corrupted credential.
//
// The binary is pinned to /usr/bin/security rather than resolved through PATH:
// this reads secrets, and an attacker-controlled `security` earlier on PATH
// must not be able to intercept them. Pinning also keeps macOS quiet — Keychain
// access is bound to the reading executable, and Claude Code created these
// items with this same binary, so no prompt appears.

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";

import { log } from "../logger.js";
import { registerSecret } from "../redact.js";

export const SECURITY_BIN = "/usr/bin/security";
/** `security -i` reads stdin with a 4096-byte fgets buffer; leave headroom. */
export const STDIN_LINE_LIMIT = 4096 - 64;
const NOT_FOUND = 44;
const TIMEOUT_MS = 5000;
const USERNAME_PATTERN = /^[\w.-]+$/u;

/**
 * The `security` runner, injectable so tests never touch a real Keychain.
 * @typedef {(args: string[], options?: {stdinText?: string}) => Promise<{code: number, stdout: string, stderr: string}>} SecurityRunner
 */

/**
 * The account name Claude Code keys its item under: $USER, then the OS user,
 * then a fixed fallback. A divergent value would address a different item.
 */
export function credentialAccount(env = process.env, userInfo = null) {
  const candidates = [env.USER, env.LOGNAME, userInfo?.username];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && USERNAME_PATTERN.test(candidate)) return candidate;
  }
  return "claude-code-user";
}

/**
 * @param {string[]} args
 * @param {{stdinText?: string}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runSecurity(args, { stdinText } = {}) {
  return new Promise((resolve) => {
    const child = spawn(SECURITY_BIN, args, { stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdinText !== undefined) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The secret for a service, or null when the item does not exist.
 *
 * A failure that is not "not found" throws rather than reading as absent: a
 * locked or refusing Keychain looks exactly like a missing item, and treating
 * the two alike is how a tool decides someone is signed out and overwrites
 * their login.
 * @param {{service: string, env?: NodeJS.ProcessEnv, security?: typeof runSecurity}} args
 */
export async function readCredential({ service, env = process.env, security = runSecurity }) {
  const account = credentialAccount(env);
  const result = await security(["find-generic-password", "-a", account, "-w", "-s", service]);
  if (result.code === NOT_FOUND) return null;
  if (result.code !== 0) {
    throw new Error(`Could not read the ${service} item: ${result.stderr.trim() || `security exited ${result.code}`}`);
  }
  const secret = result.stdout.replace(/\r?\n$/u, "");
  if (!secret) return null;
  registerSecret(secret);
  return secret;
}

/** Whether an item exists, without decrypting it. Never prompts. */
export async function credentialExists({ service, env = process.env, security = runSecurity }) {
  const result = await security(["find-generic-password", "-a", credentialAccount(env), "-s", service]);
  return result.code === 0;
}

/**
 * Write a secret and read it back before reporting success. The read-back is
 * the whole point: `security -i` can truncate a long line and report nothing,
 * and this is a credential, so "probably written" is not good enough.
 */
export async function writeCredential({ service, secret, env = process.env, security = runSecurity }) {
  if (!secret) throw new Error("writeCredential: a secret is required");
  registerSecret(secret);
  const account = credentialAccount(env);
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const command = `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hex}\n`;
  const viaStdin = Buffer.byteLength(command, "utf8") <= STDIN_LINE_LIMIT;
  const result = viaStdin
    ? await security(["-i"], { stdinText: command })
    : await security(["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex]);
  if (result.code !== 0) {
    throw new Error(`Could not write the ${service} item: ${result.stderr.trim() || `security exited ${result.code}`}`);
  }
  const stored = Buffer.from((await readCredential({ service, env, security })) ?? "");
  const expected = Buffer.from(secret);
  if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) {
    throw new Error(`The ${service} item did not read back as written; nothing was changed elsewhere.`);
  }
  log.info("swap", "credential written", { service, viaStdin, bytes: expected.length });
  return { service, viaStdin };
}

/** Remove an item. A missing item is success. */
export async function removeCredential({ service, env = process.env, security = runSecurity }) {
  const result = await security(["delete-generic-password", "-a", credentialAccount(env), "-s", service]);
  if (result.code === 0 || result.code === NOT_FOUND) return result.code === 0;
  throw new Error(`Could not remove the ${service} item: ${result.stderr.trim() || `security exited ${result.code}`}`);
}

/**
 * Parse a credential blob. Returns null for anything that is not the shape
 * Claude Code writes, so a torn read is never mistaken for a valid login.
 * @param {string | null} text
 */
export function parseCredential(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || typeof oauth.accessToken !== "string") return null;
  return parsed;
}

/** Milliseconds until the access token expires; negative once it has. */
export function expiresIn(blob, now = Date.now()) {
  const at = Number(blob?.claudeAiOauth?.expiresAt);
  return Number.isFinite(at) ? at - now : NaN;
}

/** Milliseconds until the refresh token expires; NaN when the blob omits it. */
function refreshExpiresIn(blob, now = Date.now()) {
  const at = Number(blob?.claudeAiOauth?.refreshTokenExpiresAt);
  return Number.isFinite(at) ? at - now : NaN;
}

/** A description of a credential that carries no secret. */
export function describeCredential(blob, now = Date.now()) {
  const oauth = blob?.claudeAiOauth ?? {};
  const access = expiresIn(blob, now);
  const refresh = refreshExpiresIn(blob, now);
  return {
    subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    // How large this plan's allowance is, as Anthropic names it:
    // "default_claude_max_5x", "default_claude_max_20x", and so on. It is the
    // only machine-readable statement of plan size on the credential —
    // `subscriptionType` says "team" for a 5x seat and a 20x seat alike — so
    // anything comparing accounts of different sizes has to read this.
    rateLimitTier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
    hasRefreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken.length > 0,
    accessExpiresInMs: Number.isNaN(access) ? null : access,
    refreshExpiresInMs: Number.isNaN(refresh) ? null : refresh,
    accessExpired: Number.isNaN(access) ? null : access <= 0,
    refreshExpired: Number.isNaN(refresh) ? null : refresh <= 0,
  };
}
