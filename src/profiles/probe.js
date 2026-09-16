// Is a profile signed in, and as whom?
//
// Three signals, cheapest first:
//   1. identity from the profile's Claude config file, written on login
//   2. credential presence, from the Keychain item (attributes only, never the
//      secret) or the fallback file
//   3. `claude auth status --json`, only when the caller asks for it
//
// A probe that cannot tell reports "unknown". It never reports "signed out" on
// a failure, because a locked Keychain looks exactly like a missing item.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../logger.js";
import { claudeCredentialService, credentialFilePath } from "./keychain-name.js";
import { canonicalConfigDir } from "./paths.js";

const KEYCHAIN_NOT_FOUND = 44;

function runSecurity(args) {
  return new Promise((resolve) => {
    execFile("security", args, { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/** Identity Claude Code recorded for this config directory, or null. */
export async function readIdentity(configDir) {
  try {
    const raw = await readFile(join(canonicalConfigDir(configDir), ".claude.json"), "utf8");
    const account = JSON.parse(raw)?.oauthAccount;
    if (!account || typeof account !== "object") return null;
    return {
      email: typeof account.emailAddress === "string" ? account.emailAddress : null,
      organization: typeof account.organizationName === "string" ? account.organizationName : null,
      seat: typeof account.seatTier === "string" ? account.seatTier : null,
    };
  } catch {
    return null;
  }
}

/**
 * Where this profile's credential lives: "keychain", "file", "none" or
 * "unknown". A plaintext file is worth surfacing, so it is reported distinctly.
 */
export async function credentialLocation(configDir, { platform = process.platform, security = runSecurity } = {}) {
  const file = credentialFilePath(configDir);
  const onDisk = await stat(file)
    .then(() => true)
    .catch(() => false);
  if (platform !== "darwin") return onDisk ? "file" : "none";
  const service = claudeCredentialService(configDir);
  const result = await security(["find-generic-password", "-s", service]);
  if (result.code === 0) return "keychain";
  if (onDisk) return "file";
  if (result.code === KEYCHAIN_NOT_FOUND) return "none";
  return "unknown";
}

/**
 * @param {{name?: string, dir: string}} profile
 * @returns {Promise<{signedIn: boolean | "unknown", identity: object | null, credential: string, service: string}>}
 */
export async function probeProfile(profile, options = {}) {
  const dir = canonicalConfigDir(profile.dir);
  const [identity, credential] = await Promise.all([readIdentity(dir), credentialLocation(dir, options)]);
  /** @type {boolean | "unknown"} */
  const signedIn = credential === "unknown" ? "unknown" : credential !== "none";
  const result = { signedIn, identity, credential, service: claudeCredentialService(dir) };
  log.debug("profile", "probe", { name: profile.name, ...result });
  return result;
}

/**
 * Remove the Keychain item Claude Code created for a config directory. Used
 * when a profile is deleted, so its login does not outlive it. Returns whether
 * anything was removed; a missing item is not an error.
 */
export async function forgetCredential(configDir, { platform = process.platform, security = runSecurity } = {}) {
  if (platform !== "darwin") return false;
  const service = claudeCredentialService(configDir);
  let removed = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await security(["delete-generic-password", "-s", service]);
    if (result.code !== 0) break;
    removed = true;
  }
  log.info("profile", "credential item removed", { service, removed });
  return removed;
}

/**
 * Authoritative but slower: ask Claude Code itself. Used by `profile show`,
 * never on the launch path.
 * @param {string} configDir
 * @param {{bin: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, execFileImpl?: Function}} options
 */
export function authStatus(configDir, { bin, env = process.env, timeoutMs = 20_000, execFileImpl = execFile }) {
  return new Promise((resolve) => {
    execFileImpl(
      bin,
      ["auth", "status", "--json"],
      { env: { ...env, CLAUDE_CONFIG_DIR: canonicalConfigDir(configDir) }, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          resolve(null);
        }
      },
    );
  });
}
