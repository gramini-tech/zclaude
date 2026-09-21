// Who may mint the next token for a login, and where that token has to land.
//
// One Anthropic account's login is a *lineage*: an access token, and the
// refresh token that mints the next pair. Anthropic rotates the refresh token
// on every use and retires the old one immediately, so a lineage has room for
// exactly one refresher. zclaude copies credentials between stores — the global
// Keychain item Claude Code reads, each profile's own item, and the plaintext
// file Claude Code falls back to — which puts one lineage in two places
// routinely, and either copy refreshing kills the other. What the loser sees is
// `invalid_grant`, and what Claude Code does about it is sign out.
//
// That is not a race a lock can close. Claude Code's VS Code extension keeps
// the credential it read in memory and refreshes on its own clock without
// taking any lock at all (anthropics/claude-code#61923, closed as not planned),
// so a lock only makes zclaude and the `claude` CLI agree while the editor is
// still holding a refresh token zclaude has already spent. Two rules replace
// it:
//
//   1. zclaude refreshes a lineage only when nothing else can be holding it.
//      The global slot belongs to Claude Code — the CLI, the editor extension
//      and the desktop app all read it — and so does any profile with a live
//      session. Both are read-only here, however close to expiry they are.
//   2. When zclaude does refresh, the new credential goes into every store that
//      held the old one, in one pass, before anything else runs. A store left
//      behind is holding a token the server has already retired, and nothing
//      later can tell that from a login that was never signed in.
//
// The plaintext file is included because Claude Code reads both stores and
// prefers whichever is unexpired (anthropics/claude-code#98334 has the read
// order): updating the Keychain alone lets a stale file win. It is only ever
// written when it already exists — creating one would put on disk a secret the
// Keychain was keeping off it.

import { chmod, readFile, rename, writeFile } from "node:fs/promises";

import { log } from "../logger.js";
import { claudeCredentialService, credentialFilePath, DEFAULT_CREDENTIAL_SERVICE } from "../profiles/keychain-name.js";
import { defaultConfigDir } from "../profiles/launch.js";
import { listRegistered } from "../profiles/registry.js";
import { tokenFingerprint } from "../renew/state.js";
import { byProfile, liveSessions } from "../sessions/index.js";
import { refreshCredential } from "../usage/anthropic.js";
import { parseCredential, readCredential, writeCredential } from "./keychain.js";
import { withCredentialsLock } from "./locks.js";

/**
 * @typedef {object} Store
 * @property {"slot" | "profile"} kind
 * @property {string} name the profile's name, or "the global login"
 * @property {string} service the Keychain service holding it
 * @property {string} file the plaintext fallback beside its config directory
 * @property {object | null} blob the parsed credential, or null
 * @property {string | null} lineage fingerprint of the Keychain copy's refresh token
 * @property {string | null} fileLineage the same for the plaintext copy
 * @property {string | null} unreadable why the Keychain would not answer
 */

/** A lineage is named by its refresh token, which is what the server rotates. */
export function lineageOf(blob) {
  return tokenFingerprint(blob?.claudeAiOauth?.refreshToken);
}

async function readStore(store, { env, security }) {
  let raw = null;
  let unreadable = null;
  try {
    raw = await readCredential({ service: store.service, env, security });
  } catch (error) {
    // A Keychain that refuses looks exactly like a store that holds nothing,
    // and reading it as empty is how this decides nobody else has the lineage.
    unreadable = error.message;
  }
  const fileBlob = parseCredential(await readFile(store.file, "utf8").catch(() => null));
  const blob = parseCredential(raw);
  return { ...store, blob, unreadable, lineage: lineageOf(blob), fileLineage: lineageOf(fileBlob) };
}

/**
 * Every store that could hold an Anthropic credential: the global slot, and one
 * per registered Anthropic profile.
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner, records?: object[] | null}} [options]
 * @returns {Promise<Store[]>}
 */
export async function credentialStores({ env = process.env, security, records = null } = {}) {
  const registered = records ?? (await listRegistered(env));
  const places = [
    {
      kind: "slot",
      name: "the global login",
      service: DEFAULT_CREDENTIAL_SERVICE,
      file: credentialFilePath(defaultConfigDir(env)),
    },
    ...registered
      .filter((record) => record.provider === "anthropic")
      .map((record) => ({
        kind: "profile",
        name: record.name,
        service: claudeCredentialService(record.dir),
        file: credentialFilePath(record.dir),
      })),
  ];
  return Promise.all(places.map((place) => readStore(place, { env, security })));
}

/** Every store holding one lineage, in either of its two copies. */
export function holdersOf(stores, lineage) {
  if (!lineage) return [];
  return stores.filter((store) => store.lineage === lineage || store.fileLineage === lineage);
}

/**
 * Profiles with a Claude Code session running right now, or null when that
 * could not be established.
 *
 * Null is not "none". Not knowing which profiles are live is the one reading
 * that must never let a refresh go ahead underneath one, so callers treat it as
 * "every profile is busy" rather than as an empty set.
 * @param {{env?: NodeJS.ProcessEnv, now?: number}} [options]
 * @returns {Promise<Set<string> | null>}
 */
export async function busyProfiles({ env = process.env, now = Date.now() } = {}) {
  try {
    return new Set(byProfile(await liveSessions({ env, now, reap: false })).keys());
  } catch (error) {
    log.debug("swap", "live sessions could not be read", { error });
    return null;
  }
}

/**
 * Whether zclaude may mint the next token in this lineage, and who holds it.
 * @param {string | null} lineage
 * @param {Store[]} stores
 * @param {{busy?: Set<string> | null}} [options]
 * @returns {{allowed: boolean, reason: string, holders: Store[]}}
 */
export function refreshRight(lineage, stores, { busy = null } = {}) {
  if (!lineage) return { allowed: false, reason: "there is no refresh token to spend", holders: [] };
  const holders = holdersOf(stores, lineage);
  if (holders.length === 0) return { allowed: false, reason: "no store holds this login", holders };

  if (holders.some((store) => store.kind === "slot")) {
    return {
      allowed: false,
      reason:
        "this account holds the global login, which Claude Code and the editor extension refresh on their own clock",
      holders,
    };
  }
  if (busy === null) {
    return { allowed: false, reason: "which profiles have a session running could not be established", holders };
  }
  const live = holders.find((store) => store.kind === "profile" && busy.has(store.name));
  if (live) {
    return {
      allowed: false,
      reason: `"${live.name}" has a session running, which refreshes this login itself`,
      holders,
    };
  }
  return {
    allowed: true,
    reason:
      holders.length > 1 ? `${holders.length} stores hold it, and all of them are written` : "nothing else holds it",
    holders,
  };
}

/** Write the plaintext fallback, atomically and only where one already is. */
async function writeCredentialFile(path, secret) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${secret}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

/**
 * @typedef {object} RefreshOutcome
 * @property {"ok" | "dead" | "transient" | "not-ours"} state
 * @property {object} [blob]
 * @property {boolean} [rotated]
 * @property {string} [detail]
 * @property {string[]} written the stores now holding the new token
 * @property {Array<{store: string, detail: string}>} failed the stores left behind
 */

/**
 * Refresh once, then put the result in every store that held the old lineage.
 *
 * The fan-out is not best-effort. The moment the server answers, every copy of
 * the old refresh token is dead, so a store that cannot be written is a login
 * that will stop working, and it is named rather than logged and forgotten.
 */
/** @returns {Promise<RefreshOutcome>} */
async function refreshAndFanOut(holders, lineage, { env, security, fetchImpl, signal, now }) {
  const source = holders.find((store) => store.blob);
  if (!source) {
    return { state: "dead", detail: "no store holds this login any more", written: [], failed: [] };
  }

  const refreshed = await refreshCredential(source.blob, { fetchImpl, signal, now });
  if (refreshed.state !== "ok") return { ...refreshed, written: [], failed: [] };

  const secret = JSON.stringify(refreshed.blob);
  /** @type {string[]} */
  const written = [];
  /** @type {Array<{store: string, detail: string}>} */
  const failed = [];
  for (const store of holders) {
    try {
      if (store.lineage === lineage) await writeCredential({ service: store.service, secret, env, security });
      if (store.fileLineage === lineage) await writeCredentialFile(store.file, secret);
      written.push(store.name);
    } catch (error) {
      failed.push({ store: store.name, detail: error.message });
      log.error("swap", "a store was left holding a spent token", { store: store.name, error });
    }
  }
  log.info("swap", "lineage refreshed", { rotated: refreshed.rotated, written, failed: failed.length });
  return { ...refreshed, written, failed };
}

/**
 * The one way anything in zclaude mints a token: decide whether the lineage is
 * ours to refresh, refresh it once, and write it everywhere it lives.
 *
 * `locked` is for a caller already inside the credentials lock; taking a lock
 * you hold spins until the timeout and then reports itself as somebody else's.
 *
 * @param {string | null} lineage
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner, fetchImpl?: typeof fetch, signal?: AbortSignal, now?: number, locked?: boolean, records?: object[] | null}} [options]
 * @returns {Promise<RefreshOutcome>}
 */
export function refreshLineage(
  lineage,
  { env = process.env, security, fetchImpl, signal, now = Date.now(), locked = false, records = null } = {},
) {
  /** @returns {Promise<RefreshOutcome>} */
  const run = async () => {
    // Read inside the lock, not before it: the decision about who owns this
    // lineage is only worth anything if nothing can move it in between.
    const stores = await credentialStores({ env, security, records });
    const busy = await busyProfiles({ env, now });
    const right = refreshRight(lineage, stores, { busy });
    if (!right.allowed) {
      log.debug("swap", "not ours to refresh", { reason: right.reason });
      return { state: "not-ours", detail: right.reason, written: [], failed: [] };
    }
    return refreshAndFanOut(right.holders, lineage, { env, security, fetchImpl, signal, now });
  };
  return locked ? run() : withCredentialsLock(run, { env });
}
