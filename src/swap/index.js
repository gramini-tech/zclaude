// Moving the global Claude Code login from one account to another.
//
// Two things make an account: the credential in the Keychain item Claude Code
// reads, and the `oauthAccount` block in its config file. `claude auth status`
// takes `loggedIn` and the plan from the first and the email and organisation
// from the second, so both have to move together or the session is signed in as
// one account and labelled as another.
//
// The order is deliberate and the whole safety story:
//
//   1. take the locks Claude Code takes, so no refresh is mid-flight
//   2. read what is in the slot and work out whose it is
//   3. capture it back into that profile — a token Claude Code rotated while
//      the profile was active only exists here, and losing it would strand the
//      account
//   4. back it up, and verify the backup can be read
//   5. write the new credential, then splice the new identity
//   6. on any failure, put back what was there
//
// Sessions already running keep the credential they read at startup; on macOS
// Claude Code caches it for about half a minute, so a switch reaches a live
// session shortly rather than instantly.

import { readFile } from "node:fs/promises";

import { log } from "../logger.js";
import { claudeCredentialService, DEFAULT_CREDENTIAL_SERVICE } from "../profiles/keychain-name.js";
import { getRegistered, listRegistered } from "../profiles/registry.js";
import { listBackups, loadBackup, readSwapState, takeBackup, writeSwapState } from "./backup.js";
import {
  configFileIn,
  configFilePath,
  describeIdentity,
  readConfig,
  readIdentityBlock,
  sameAccount,
  writeIdentityBlock,
} from "./identity.js";
import { describeCredential, parseCredential, readCredential, writeCredential } from "./keychain.js";
import { swapLocks, withLocks } from "./locks.js";

/** Everything a swap needs to know about where things live. */
function places(env) {
  const configFile = configFilePath(env);
  const configDir = configFile.replace(/\.json$/u, "");
  return { configFile, configDir, service: DEFAULT_CREDENTIAL_SERVICE };
}

/**
 * Who is in the global slot, without changing anything.
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner}} [options]
 */
export async function swapStatus({ env = process.env, security } = {}) {
  const { configFile, service } = places(env);
  const state = await readSwapState(env);
  const identity = await readIdentityBlock(configFile);
  const account = describeIdentity(identity);
  let credential = null;
  let unreadable = null;
  try {
    credential = parseCredential(await readCredential({ service, env, security }));
  } catch (error) {
    unreadable = error.message;
  }
  const profiles = await listRegistered(env);
  const owner = await findOwner(identity, profiles);
  return {
    account,
    credential: credential ? describeCredential(credential) : null,
    credentialPresent: Boolean(credential),
    unreadable,
    owner: owner?.name ?? null,
    active: state.active ?? null,
    swappedAt: state.swappedAt ?? null,
    backups: await listBackups(env),
  };
}

/**
 * Which profile the account in the slot belongs to, by identity first and by
 * credential second. Identity is cheap and exact; the credential comparison
 * catches a profile whose config file has not caught up.
 */
async function findOwner(identity, profiles) {
  if (!identity) return null;
  for (const profile of profiles) {
    if (profile.provider !== "anthropic") continue;
    const theirs = await readIdentityBlock(configFileIn(profile.dir));
    if (theirs && sameAccount(identity, theirs)) return profile;
  }
  return null;
}

/**
 * Put the live credential back into the profile it belongs to.
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner}} [options]
 *
 * Claude Code refreshes the token in the slot as it works, and the server
 * rotates the refresh token when it does. The profile's own copy is then a
 * generation behind, and using it later would fail. This is the step that keeps
 * a round trip lossless.
 */
export async function captureBack({ env = process.env, security } = {}) {
  const { service, configFile } = places(env);
  const identity = await readIdentityBlock(configFile);
  const profiles = await listRegistered(env);
  const owner = await findOwner(identity, profiles);
  if (!owner) return { captured: false, reason: "the account in the slot does not belong to a profile" };
  const live = await readCredential({ service, env, security });
  if (!live) return { captured: false, reason: "there is no credential in the slot" };
  const target = claudeCredentialService(owner.dir);
  const stored = await readCredential({ service: target, env, security }).catch(() => null);
  if (stored === live) return { captured: false, reason: "already in step", profile: owner.name };
  await writeCredential({ service: target, secret: live, env, security });
  await writeIdentityBlock(configFileIn(owner.dir), identity);
  log.info("swap", "captured the live credential back", { profile: owner.name });
  return { captured: true, profile: owner.name };
}

/**
 * What a switch would do, without doing it.
 * @param {string} name
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner}} [options]
 */
export async function planSwitch(name, { env = process.env, security } = {}) {
  const record = await getRegistered(name, env);
  const steps = [];
  const refusals = [];
  if (!record) {
    refusals.push(`There is no profile named "${name}".`);
    return { record: null, steps, refusals };
  }
  if (record.provider !== "anthropic") {
    refusals.push(
      `"${name}" is a Z.ai profile. Its login is an endpoint and a key, which only reach Claude Code through the environment, so run \`zclaude ${name}\` instead.`,
    );
    return { record, steps, refusals };
  }
  const { service, configFile } = places(env);
  const targetService = claudeCredentialService(record.dir);
  const target = parseCredential(await readCredential({ service: targetService, env, security }).catch(() => null));
  if (!target) refusals.push(`"${name}" has no stored login. Run \`zclaude profile login ${name}\` first.`);
  else {
    const health = describeCredential(target);
    if (health.refreshExpired) refusals.push(`"${name}" has an expired refresh token. Sign it in again first.`);
    if (health.accessExpired) steps.push("its access token has expired; Claude Code will refresh it on first use");
  }
  const current = await swapStatus({ env, security });
  if (current.unreadable) refusals.push(`The current login could not be read: ${current.unreadable}`);
  const config = await readConfig(configFile);
  if (config.config === null && !config.missing)
    refusals.push(`${configFile} is not valid JSON; fix it before switching.`);

  if (current.credentialPresent) {
    steps.push(
      current.owner
        ? `capture the current login back into "${current.owner}"`
        : "back up the current login (it does not match any profile)",
    );
  }
  steps.push(`write ${name}'s credential into ${service}`, `set oauthAccount in ${configFile} to ${name}'s account`);
  return {
    record,
    steps,
    refusals,
    current,
    target: describeIdentity(await readIdentityBlock(configFileIn(record.dir))),
  };
}

/**
 * Move the global login to a profile.
 * @param {string} name
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner, platform?: NodeJS.Platform}} [options]
 */
export async function switchTo(name, { env = process.env, security, platform = process.platform } = {}) {
  const plan = await planSwitch(name, { env, security });
  if (plan.refusals.length > 0) throw new Error(plan.refusals[0]);
  const { record } = plan;
  const { service, configFile, configDir } = places(env);

  return withLocks(swapLocks({ configDir, configFile }), async () => {
    const before = await readCredential({ service, env, security });
    const beforeIdentity = await readIdentityBlock(configFile);
    const beforeConfig = before === null ? null : await readFile(configFile, "utf8").catch(() => null);

    if (before) {
      await captureBack({ env, security }).catch((error) =>
        log.warn("swap", "capture-back failed; continuing to the backup", { error }),
      );
      await takeBackup(
        {
          credential: before,
          identity: beforeIdentity,
          account: describeIdentity(beforeIdentity),
          config: beforeConfig,
        },
        { env, platform, security },
      );
    }

    const targetService = claudeCredentialService(record.dir);
    const targetCredential = await readCredential({ service: targetService, env, security });
    const targetIdentity = await readIdentityBlock(configFileIn(record.dir));

    try {
      await writeCredential({ service, secret: targetCredential, env, security });
      await writeIdentityBlock(configFile, targetIdentity);
    } catch (error) {
      await rollback({ service, configFile, before, beforeIdentity, env, security });
      throw error;
    }

    await writeSwapState(
      { active: record.name, swappedAt: new Date().toISOString(), previous: describeIdentity(beforeIdentity) },
      env,
    );
    log.info("swap", "global login switched", { profile: record.name });
    return {
      profile: record.name,
      account: describeIdentity(targetIdentity),
      previous: describeIdentity(beforeIdentity),
    };
  });
}

async function rollback({ service, configFile, before, beforeIdentity, env, security }) {
  if (!before) return;
  log.warn("swap", "rolling back", { service });
  await writeCredential({ service, secret: before, env, security }).catch((error) =>
    log.error("swap", "rollback of the credential failed", { error }),
  );
  await writeIdentityBlock(configFile, beforeIdentity).catch((error) =>
    log.error("swap", "rollback of the identity failed", { error }),
  );
}

/**
 * Put back what was in the slot before the last switch.
 * @param {{env?: NodeJS.ProcessEnv, security?: import("./keychain.js").SecurityRunner, id?: string}} [options]
 */
export async function restore({ env = process.env, security, id } = {}) {
  const backups = await listBackups(env);
  const chosen = id ? backups.find((entry) => entry.id === id) : backups[0];
  if (!chosen) throw new Error("There is no backup to restore. `zclaude switch --status` lists what there is.");
  const loaded = await loadBackup(chosen.id, { env, security });
  if (!loaded) throw new Error(`Backup ${chosen.id} could not be read; its credential may have been removed.`);
  const { service, configFile, configDir } = places(env);

  return withLocks(swapLocks({ configDir, configFile }), async () => {
    await captureBack({ env, security }).catch(() => {});
    await writeCredential({ service, secret: loaded.credential, env, security });
    await writeIdentityBlock(configFile, loaded.identity);
    await writeSwapState({ active: null, restoredAt: new Date().toISOString(), from: chosen.id }, env);
    log.info("swap", "global login restored", { id: chosen.id, account: chosen.account?.email ?? null });
    return { id: chosen.id, account: describeIdentity(loaded.identity) };
  });
}
