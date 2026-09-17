// What the global login was before a swap, kept so it can be put back.
//
// The order matters more than the contents: a backup is taken and *verified*
// before anything is overwritten, and a swap that cannot prove its backup
// refuses to proceed. Losing the credential that was in the slot would mean a
// sign-in the user did not ask for, on an account they might not have to hand.
//
// The credential goes into zclaude's own Keychain item rather than a file, so a
// token never lands on disk in the clear. Off macOS, or when the Keychain
// refuses, it falls back to a 0600 file — the same trade the Z.ai store makes.

import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { zclaudeHome } from "../config.js";
import { log } from "../logger.js";
import { registerSecret } from "../redact.js";
import { keychainAvailable } from "../store.js";
import { readCredential, removeCredential, writeCredential } from "./keychain.js";

const BACKUP_SERVICE = "zclaude-swap-backup";
/** Enough history to undo a mistake, not enough to become an archive. */
const KEEP = 10;

function swapRoot(env = process.env) {
  return join(zclaudeHome(env), "swap");
}

function statePath(env = process.env) {
  return join(swapRoot(env), "state.json");
}

function backupDir(id, env = process.env) {
  return join(swapRoot(env), "backups", id);
}

/** An id that sorts by time and is safe in a path and a Keychain account. */
export function backupId(now = new Date()) {
  return now.toISOString().replaceAll(/[.:]/gu, "-");
}

async function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Store one credential and prove it can be read back.
 *
 * The read-back is the point of the whole module: a backup nobody has verified
 * is a promise, and this one is about to be relied on.
 */
async function storeSecret(id, secret, { env, platform = process.platform, security }) {
  registerSecret(secret);
  const service = `${BACKUP_SERVICE}-${id}`;
  if (keychainAvailable(env, platform)) {
    try {
      await writeCredential({ service, secret, env, security });
      return { location: "keychain", service };
    } catch (error) {
      log.warn("swap", "backup keychain write failed, falling back to a file", { error });
    }
  }
  const file = join(backupDir(id, env), "credential.json");
  await writeFile(file, secret, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  const readBack = Buffer.from(await readFile(file, "utf8"));
  const expected = Buffer.from(secret);
  if (readBack.length !== expected.length || !timingSafeEqual(readBack, expected)) {
    throw new Error("The backup file did not read back as written; nothing was changed.");
  }
  return { location: "file", file };
}

function loadSecret(entry, { env, security }) {
  if (entry.location === "keychain") return readCredential({ service: entry.service, env, security });
  return readFile(join(backupDir(entry.id, env), "credential.json"), "utf8").catch(() => null);
}

/**
 * Capture what is in the global slot right now.
 * @param {{credential: string, identity: object | null, account: object | null, config: string | null}} what
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, security?: import("./keychain.js").SecurityRunner, now?: Date}} [options]
 * @returns {Promise<object>} the backup entry
 */
export async function takeBackup(what, { env = process.env, platform = process.platform, security, now } = {}) {
  const id = backupId(now);
  const dir = backupDir(id, env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stored = await storeSecret(id, what.credential, { env, platform, security });
  await writeJson(join(dir, "identity.json"), what.identity ?? null);
  // The whole config file as it was, so even a bad splice is recoverable.
  if (what.config !== null && what.config !== undefined) {
    await writeFile(join(dir, "config-before.json"), what.config, { mode: 0o600 });
  }
  const entry = {
    id,
    takenAt: new Date().toISOString(),
    account: what.account ?? null,
    location: stored.location,
    service: stored.service ?? null,
  };
  await writeJson(join(dir, "backup.json"), entry);

  // Verify by the same route a restore would take, before the caller writes
  // anything: a backup that cannot be read is not a backup.
  const readBack = Buffer.from((await loadSecret(entry, { env, security })) ?? "");
  const original = Buffer.from(what.credential);
  if (readBack.length !== original.length || !timingSafeEqual(readBack, original)) {
    throw new Error("The backup could not be read back. Nothing has been changed; the login in place is untouched.");
  }
  log.info("swap", "backup taken", { id, location: entry.location, account: entry.account?.email ?? null });
  await prune(env);
  return entry;
}

/** Every backup, newest first. */
export async function listBackups(env = process.env) {
  const dir = join(swapRoot(env), "backups");
  const names = await readdir(dir).catch(() => []);
  const entries = await Promise.all(names.map((name) => readJson(join(dir, name, "backup.json"))));
  return entries.filter(Boolean).toSorted((a, b) => b.id.localeCompare(a.id));
}

/**
 * The credential and identity from a backup, or null when it is unreadable.
 * @param {string} id
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner}} [options]
 */
export async function loadBackup(id, { env = process.env, security } = {}) {
  const entry = await readJson(join(backupDir(id, env), "backup.json"));
  if (!entry) return null;
  const credential = await loadSecret(entry, { env, security });
  if (!credential) return null;
  registerSecret(credential);
  const identity = await readJson(join(backupDir(id, env), "identity.json"));
  return { entry, credential, identity };
}

async function prune(env) {
  const all = await listBackups(env);
  for (const entry of all.slice(KEEP)) {
    await rm(backupDir(entry.id, env), { recursive: true, force: true }).catch(() => {});
    if (entry.location === "keychain" && entry.service) {
      await removeCredential({ service: entry.service, env }).catch(() => {});
    }
  }
}

/**
 * Forget every backup: used by uninstall, and by a user who wants them gone.
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner}} [options]
 */
export async function clearBackups({ env = process.env, security } = {}) {
  const all = await listBackups(env);
  for (const entry of all) {
    if (entry.location === "keychain" && entry.service) {
      await removeCredential({ service: entry.service, env, security }).catch(() => {});
    }
  }
  await rm(join(swapRoot(env), "backups"), { recursive: true, force: true }).catch(() => {});
  return all.length;
}

/** What is in the slot, as zclaude last saw it. */
export async function readSwapState(env = process.env) {
  return (await readJson(statePath(env))) ?? { active: null, history: [] };
}

export async function writeSwapState(patch, env = process.env) {
  const current = await readSwapState(env);
  const next = { ...current, ...patch };
  await mkdir(swapRoot(env), { recursive: true, mode: 0o700 });
  await writeJson(statePath(env), next);
  return next;
}
