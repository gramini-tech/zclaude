// Every account rotation could use, with everything a decision needs about it.
//
// The policy is a pure function of a snapshot; this is where the snapshot comes
// from. Five sources, none of which knows about the others: the registry says
// which profiles exist, the usage cache says how full each one is, the identity
// block says which account and which organisation, the credential says how
// large the plan is, and the session records say who is already working on it.
//
// Two things are deliberate. Accounts are keyed by `accountUuid`, not by
// profile name, because the same account can appear twice — once as a
// registered profile and once as the global slot — and two names for one
// account would make a no-op switch look like progress. And a reading that
// failed is never read as an empty account: the cache keeps serving its last
// good numbers, and a naive ranking would send every new task to a login that
// has actually expired.

import { byProfile, liveSessions } from "../sessions/index.js";
import { listRegistered } from "../profiles/registry.js";
import { claudeCredentialService } from "../profiles/keychain-name.js";
import { isQuarantined, readRenewState, tokenFingerprint } from "../renew/state.js";
import { configFileIn, describeIdentity, readIdentityBlock } from "../swap/identity.js";
import { describeCredential, parseCredential, readCredential } from "../swap/keychain.js";
import { swapStatus } from "../swap/index.js";
import { usageForAll } from "../usage/index.js";
import { DEFAULT_TIERS } from "./config.js";

/** An unknown plan weighs 1: the smallest there is, so a guess is only ever cautious. */
function weightOf(tiers, credential, identity) {
  for (const name of [credential?.rateLimitTier, identity?.tier]) {
    const weight = typeof name === "string" ? tiers[name] : undefined;
    if (weight !== undefined) return { weight, tier: name, known: true };
  }
  // `subscriptionType` cannot tell a 5x seat from a 20x one, so it is a floor.
  const fallback = { pro: 1, max: 5, team: 1.25, enterprise: 1.25 }[credential?.subscriptionType];
  return { weight: fallback ?? 1, tier: credential?.rateLimitTier ?? identity?.tier ?? null, known: false };
}

async function describeProfile(record, { env, security, renewState }) {
  const identity = describeIdentity(await readIdentityBlock(configFileIn(record.dir)));
  if (record.provider !== "anthropic") return { identity, credential: null, quarantined: false };
  const service = claudeCredentialService(record.dir);
  const blob = parseCredential(await readCredential({ service, env, security }).catch(() => null));
  const credential = blob ? describeCredential(blob) : null;
  const fingerprint = tokenFingerprint(blob?.claudeAiOauth?.refreshToken);
  return { identity, credential, quarantined: isQuarantined(renewState, record.name, fingerprint) };
}

/**
 * The whole picture, ready for `decide`.
 *
 * @param {{env?: NodeJS.ProcessEnv, security?: object, fetchImpl?: typeof fetch, now?: number, tiers?: object, force?: boolean}} [options]
 * @returns {Promise<{accounts: object[], active: string | null, slot: object, sessions: Map<string, object>}>}
 */
export async function inventory({
  env = process.env,
  security,
  fetchImpl,
  now = Date.now(),
  tiers = DEFAULT_TIERS,
  force = false,
} = {}) {
  const [records, renewState, slot] = await Promise.all([
    listRegistered(env),
    readRenewState(env),
    swapStatus({ env, security }).catch(() => ({ owner: null, account: null, unreadable: "could not be read" })),
  ]);

  const described = await Promise.all(
    records.map(async (record) => ({ record, ...(await describeProfile(record, { env, security, renewState })) })),
  );

  const usage = await usageForAll(
    described.map(({ record }) => ({ name: record.name, provider: record.provider, dir: record.dir })),
    { env, fetchImpl, now, security, force },
  );

  const sessions = await liveSessions({ env, now })
    .then(byProfile)
    .catch(() => new Map());

  const accounts = described.map((one) => accountFrom(one, { tiers, usage, sessions }));

  return { accounts, active: slot.owner ?? null, slot, sessions };
}

/** The four identity fields, or nulls for a profile never signed in. */
function whoIs(identity) {
  return {
    accountUuid: identity?.accountUuid ?? null,
    organizationUuid: identity?.organizationUuid ?? null,
    email: identity?.email ?? null,
    organization: identity?.organization ?? null,
  };
}

function accountFrom({ record, identity, credential, quarantined }, { tiers, usage, sessions }) {
  const own = usage[record.name] ?? null;
  const { weight, tier, known } = weightOf(tiers, credential, identity);
  return {
    name: record.name,
    provider: record.provider,
    ...whoIs(identity),
    weight,
    tier,
    tierKnown: known,
    registered: true,
    refreshExpired: credential?.refreshExpired === true,
    quarantined,
    state: own?.state ?? "unknown",
    windows: own ? { fiveHour: own.fiveHour, weekly: own.weekly, scoped: own.scoped ?? [] } : null,
    credits: own?.credits ?? null,
    sessions: sessions.get(record.name)?.total ?? 0,
    detail: own?.detail ?? null,
  };
}

/**
 * Accounts that are the same account under two names.
 *
 * Two team seats in one organisation are genuinely different accounts and are
 * legitimately rotatable; one account registered twice is not, and switching
 * between its two names would look like progress and move nothing.
 * @param {object[]} accounts
 */
export function duplicates(accounts) {
  const seen = new Map();
  for (const account of accounts) {
    // Both uuids, which is what `sameAccount` compares and what the "one email,
    // two plans" case requires: a company seat and a personal subscription share
    // an account uuid and are metered entirely apart, so they are two accounts
    // and rotating between them is real work, not a no-op.
    if (!account.accountUuid || !account.organizationUuid) continue;
    const key = `${account.accountUuid}/${account.organizationUuid}`;
    const names = seen.get(key) ?? [];
    names.push(account.name);
    seen.set(key, names);
  }
  return [...seen.values()].filter((names) => names.length > 1);
}
