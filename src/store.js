// Credential storage. macOS: login Keychain through the `security` CLI, with
// the secret passed over stdin so it never shows up in `ps`. Elsewhere, or when
// the Keychain is unavailable: a 0600 JSON file under ~/.zclaude.

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { flag, zclaudeHome } from "./config.js";
import { registerSecret } from "./http.js";
import { debug, warn } from "./ui/log.js";

const KEYCHAIN_SERVICE = "zclaude";
const KEYCHAIN_NOT_FOUND = 44;

export function storePaths(env = process.env) {
  const home = zclaudeHome(env);
  return {
    home,
    credentialsFile: join(home, "credentials.json"),
    profileFile: join(home, "profile.json"),
    stateFile: join(home, "state.json"),
  };
}

async function ensureHome(env = process.env) {
  const { home } = storePaths(env);
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await chmod(home, 0o700);
  } catch {
    // Windows or unusual filesystems: best effort only.
  }
  return home;
}

// ---------------------------------------------------------------- utilities

/**
 * @param {string[]} args
 * @param {{stdinText?: string}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runSecurity(args, { stdinText } = {}) {
  return new Promise((resolve) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "pipe"] });
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

function keychainQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function keychainAvailable(env = process.env, platform = process.platform) {
  return platform === "darwin" && !flag(env, "ZCLAUDE_NO_KEYCHAIN");
}

async function keychainFind(security = runSecurity) {
  const result = await security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  if (result.code === KEYCHAIN_NOT_FOUND) return null;
  if (result.code !== 0)
    throw new Error(`security find-generic-password failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  const secret = result.stdout.replace(/\r?\n$/u, "");
  return secret || null;
}

async function keychainDeleteAll(security = runSecurity) {
  let removed = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await security(["delete-generic-password", "-s", KEYCHAIN_SERVICE]);
    if (result.code === KEYCHAIN_NOT_FOUND) break;
    if (result.code !== 0)
      throw new Error(`security delete-generic-password failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    removed += 1;
  }
  return removed;
}

async function keychainAdd(account, secret, security = runSecurity) {
  await keychainDeleteAll(security);
  // Interactive mode reads commands from stdin, keeping the secret out of argv.
  const command = `add-generic-password -a ${keychainQuote(account)} -s ${keychainQuote(KEYCHAIN_SERVICE)} -w ${keychainQuote(secret)} -U\n`;
  const result = await security(["-i"], { stdinText: command });
  if (result.code !== 0 || /error|failed/iu.test(result.stderr)) {
    throw new Error(`security add-generic-password failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const stored = Buffer.from(String((await keychainFind(security)) ?? ""));
  const expected = Buffer.from(secret);
  if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) {
    throw new Error("Keychain read-back did not match the stored secret.");
  }
}

// --------------------------------------------------------------- json files

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    warn(`Ignoring unreadable file ${path}: ${error.message}`);
    return null;
  }
}

async function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    await chmod(tmp, mode);
  } catch {
    // best effort on platforms without POSIX modes
  }
  await rename(tmp, path);
}

function readProfile(env = process.env) {
  return readJson(storePaths(env).profileFile);
}

export async function readState(env = process.env) {
  return (await readJson(storePaths(env).stateFile)) ?? {};
}

export async function writeState(patch, env = process.env) {
  await ensureHome(env);
  const current = await readState(env);
  await writeJsonAtomic(storePaths(env).stateFile, { ...current, ...patch });
}

// ------------------------------------------------------------- public API

/**
 * Returns { apiKey, source, email, userId, keyName } or null. `source` is
 * "keychain" or "file".
 */
export async function loadCredential({ env = process.env, platform = process.platform, security = runSecurity } = {}) {
  const profile = (await readProfile(env)) ?? {};
  const meta = { email: profile.email ?? "", userId: profile.userId ?? "", keyName: profile.keyName ?? "" };
  if (keychainAvailable(env, platform)) {
    try {
      const secret = await keychainFind(security);
      if (secret) {
        registerSecret(secret);
        return { apiKey: secret, source: "keychain", ...meta };
      }
    } catch (error) {
      warn(`Keychain lookup failed (${error.message}); falling back to the file store.`);
    }
  }
  const record = await readJson(storePaths(env).credentialsFile);
  const apiKey = typeof record?.apiKey === "string" ? record.apiKey.trim() : "";
  if (!apiKey) return null;
  registerSecret(apiKey);
  return {
    apiKey,
    source: "file",
    email: record.email ?? meta.email,
    userId: record.userId ?? meta.userId,
    keyName: record.keyName ?? meta.keyName,
  };
}

/** Persist a credential. Returns { location } = "keychain" | "file". */
export async function saveCredential(
  { apiKey, email = "", userId = "", keyName = "", source = "oauth" },
  { env = process.env, platform = process.platform, security = runSecurity } = {},
) {
  if (!apiKey) throw new Error("saveCredential: apiKey is required");
  registerSecret(apiKey);
  await ensureHome(env);
  const paths = storePaths(env);
  let location = "file";
  if (keychainAvailable(env, platform)) {
    try {
      await keychainAdd(email || "default", apiKey, security);
      location = "keychain";
      await rm(paths.credentialsFile, { force: true });
    } catch (error) {
      warn(`Could not store the key in the macOS Keychain (${error.message}); using ${paths.credentialsFile} instead.`);
    }
  }
  if (location === "file") {
    await writeJsonAtomic(paths.credentialsFile, {
      version: 1,
      apiKey,
      email,
      userId,
      keyName,
      createdAt: new Date().toISOString(),
    });
  }
  await writeJsonAtomic(
    paths.profileFile,
    {
      version: 1,
      email,
      userId,
      keyName,
      source,
      location,
      createdAt: new Date().toISOString(),
    },
    { mode: 0o600 },
  );
  debug(`Credential saved to ${location}`);
  return { location };
}

/** Remove every stored copy. Returns { removed: [...] }. */
export async function deleteCredential({
  env = process.env,
  platform = process.platform,
  security = runSecurity,
} = {}) {
  const removed = [];
  const paths = storePaths(env);
  if (keychainAvailable(env, platform)) {
    try {
      if ((await keychainDeleteAll(security)) > 0) removed.push("keychain");
    } catch (error) {
      warn(`Keychain cleanup failed: ${error.message}`);
    }
  }
  try {
    await rm(paths.credentialsFile);
    removed.push("file");
  } catch (error) {
    if (error?.code !== "ENOENT") warn(`Could not remove ${paths.credentialsFile}: ${error.message}`);
  }
  await rm(paths.profileFile, { force: true });
  return { removed };
}
