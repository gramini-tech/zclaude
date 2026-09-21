// A profile is an account, and an address is not an account.
//
// One email can hold two of them. A company seat and a personal subscription
// share an address and an `accountUuid`, sit in different organisations, and
// are metered entirely apart. Claude Code's consent screen offers both, one
// click apart, and picking the wrong one leaves a profile signed in to an
// account it was never meant to be. Nothing about that is visible afterwards:
// the address matches, the organisation name is the only thing that differs,
// and the usage numbers are simply the other plan's. On this machine it turned
// two profiles into two names for one quota, and the only symptom was two rows
// of identical percentages.
//
// So a profile records which account it is for, by both uuids, the first time
// it is signed in. After that the binding is the profile's identity and a
// sign-in that lands somewhere else is undone rather than accepted. The
// alternative is a tool whose whole promise — this name is this plan — holds
// only until somebody misreads a browser dialog.
//
// Rolling back is honest only when the old login can actually be put back, so
// the snapshot is taken first and its success is checked before the rollback is
// promised. A Keychain that will not answer means no rollback, and that is said
// out loud rather than papered over.

import { readFile, rm, writeFile } from "node:fs/promises";

import { log } from "../logger.js";
import { readCredential, removeCredential, writeCredential } from "../swap/keychain.js";
import { configFileIn, readIdentityBlock, writeIdentityBlock } from "../swap/identity.js";
import { claudeCredentialService, credentialFilePath } from "./keychain-name.js";
import { accountLabel } from "./probe.js";

/**
 * @typedef {object} Binding
 * @property {string} accountUuid
 * @property {string} organizationUuid
 * @property {string | null} email
 * @property {string | null} organization
 * @property {string} [boundAt]
 */

/**
 * The binding an identity block implies, or null when it cannot name an
 * account. Both uuids are required: one of them alone is the case this exists
 * to catch, because two accounts on one address share the account uuid and
 * differ only by organisation.
 * @param {{accountUuid?: string | null, organizationUuid?: string | null, email?: string | null, organization?: string | null} | null} identity
 * @returns {Binding | null}
 */
export function bindingFrom(identity) {
  const accountUuid = typeof identity?.accountUuid === "string" ? identity.accountUuid : "";
  const organizationUuid = typeof identity?.organizationUuid === "string" ? identity.organizationUuid : "";
  if (!accountUuid || !organizationUuid) return null;
  return {
    accountUuid,
    organizationUuid,
    email: identity?.email ?? null,
    organization: identity?.organization ?? null,
  };
}

/** Whether two bindings name one account. Uuids only; the labels are decoration. */
export function sameBinding(a, b) {
  if (!a || !b) return false;
  return a.accountUuid === b.accountUuid && a.organizationUuid === b.organizationUuid;
}

/** A binding as a person reads it, falling back to the uuid when it has no labels. */
export function describeBinding(binding) {
  if (!binding) return "an account it has not been signed in to yet";
  return accountLabel(binding) ?? `account ${binding.accountUuid.slice(0, 8)}`;
}

/**
 * How a profile's stored login stands against its binding.
 *
 * "unknown" is never read as "drifted". A profile that is signed out, or whose
 * config file cannot be parsed, has nothing to compare, and calling that a
 * mismatch would send somebody re-signing in to fix a file they cannot see.
 * @param {{account?: Binding | null}} record
 * @param {object | null} identity the profile's live identity block
 * @returns {{state: "unbound" | "matches" | "drifted" | "unknown", bound: Binding | null, found: Binding | null}}
 */
export function accountState(record, identity) {
  const bound = record?.account ?? null;
  const found = bindingFrom(identity);
  if (!bound) return { state: "unbound", bound: null, found };
  if (!found) return { state: "unknown", bound, found: null };
  return { state: sameBinding(bound, found) ? "matches" : "drifted", bound, found };
}

/**
 * The other profile that already means this account, by its binding or by the
 * login it is holding right now. Both count: a profile signed in but never
 * bound is still that account's, and letting a second profile take it is how
 * one quota ends up reported under two names.
 * @param {Array<{name: string, account?: Binding | null, identity?: object | null}>} others
 * @param {Binding | null} binding
 * @returns {string | null}
 */
export function boundElsewhere(others, binding) {
  if (!binding) return null;
  for (const other of others) {
    if (sameBinding(other.account ?? null, binding) || sameBinding(bindingFrom(other.identity ?? null), binding)) {
      return other.name;
    }
  }
  return null;
}

/**
 * Everything needed to put a profile's login back exactly as it was.
 *
 * `restorable` is the whole point of the shape. A snapshot that could not read
 * the Keychain cannot undo anything, and a rollback that silently does half the
 * job is worse than one that was never offered.
 * @param {{name: string, dir: string}} record
 * @param {{env?: NodeJS.ProcessEnv, security?: import("../swap/keychain.js").SecurityRunner}} [options]
 */
export async function snapshotLogin(record, { env = process.env, security } = {}) {
  const service = claudeCredentialService(record.dir);
  const file = credentialFilePath(record.dir);
  let credential = null;
  let restorable = true;
  try {
    credential = await readCredential({ service, env, security });
  } catch (error) {
    log.debug("profile", "no rollback available for this sign-in", { name: record.name, error });
    restorable = false;
  }
  return {
    service,
    file,
    credential,
    // Claude Code writes the plaintext fallback where there is no Keychain, so
    // a snapshot that ignored it would restore nothing on Linux.
    fileText: await readFile(file, "utf8").catch(() => null),
    identity: await readIdentityBlock(configFileIn(record.dir)),
    restorable,
  };
}

/**
 * Put back what the snapshot holds. Returns whether every part of it landed;
 * a partial restore is reported rather than counted as success.
 * @param {{dir: string}} record
 * @param {Awaited<ReturnType<typeof snapshotLogin>> | null} snapshot
 * @param {{env?: NodeJS.ProcessEnv, security?: import("../swap/keychain.js").SecurityRunner}} [options]
 */
export async function restoreLogin(record, snapshot, { env = process.env, security } = {}) {
  if (!snapshot?.restorable) return false;
  const { service, file } = snapshot;
  let ok = true;
  try {
    if (snapshot.credential) await writeCredential({ service, secret: snapshot.credential, env, security });
    else await removeCredential({ service, env, security });
  } catch (error) {
    log.error("profile", "the previous credential could not be put back", { error });
    ok = false;
  }
  try {
    if (snapshot.fileText === null) await rm(file, { force: true });
    else await writeFile(file, snapshot.fileText, { mode: 0o600 });
  } catch (error) {
    log.error("profile", "the previous credential file could not be put back", { error });
    ok = false;
  }
  try {
    await writeIdentityBlock(configFileIn(record.dir), snapshot.identity);
  } catch (error) {
    log.error("profile", "the previous identity could not be put back", { error });
    ok = false;
  }
  return ok;
}
