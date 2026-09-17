// Keeping each profile's login alive.
//
// A profile you have not launched for a while goes stale twice over: its access
// token lasts hours, and the refresh token behind it carries an expiry about a
// month out. This run refreshes the first before it lapses, which is also what
// keeps the refresh lineage moving.
//
// It runs unattended, so it is deliberately timid:
//
//   - it refreshes only what is about to expire. A profile you use is refreshed
//     by Claude Code itself and this does nothing to it.
//   - it works one profile at a time, and the first dead refresh lineage ends
//     the run rather than marching through the rest.
//   - it never touches the global slot. Whatever is signed in there belongs to
//     Claude Code, and to `zclaude switch`.
//   - a Keychain that will not answer stops the run with a message instead of
//     being retried in a loop.

import { log } from "../logger.js";
import { claudeCredentialService } from "../profiles/keychain-name.js";
import { listRegistered } from "../profiles/registry.js";
import { parseCredential, readCredential, writeCredential } from "../swap/keychain.js";
import { refreshCredential } from "../usage/anthropic.js";
import { isQuarantined, readRenewState, tokenFingerprint, withoutProfile, writeRenewState } from "./state.js";

/** Refresh anything expiring inside this window; leave the rest alone. */
export const HORIZON_MS = 2 * 60 * 60 * 1000;

/**
 * Run one pass.
 * @param {{env?: NodeJS.ProcessEnv, security?: import("../swap/keychain.js").SecurityRunner, fetchImpl?: typeof fetch, now?: number, horizonMs?: number, force?: boolean}} [options]
 */
export async function runRenewal({
  env = process.env,
  security,
  fetchImpl,
  now = Date.now(),
  horizonMs = HORIZON_MS,
  force = false,
} = {}) {
  const profiles = (await listRegistered(env)).filter((profile) => profile.provider === "anthropic");
  let state = await readRenewState(env);
  const results = [];
  let stopped = null;

  for (const profile of profiles) {
    const outcome = await renewOne(profile, { env, security, fetchImpl, now, horizonMs, force, state });
    results.push({ profile: profile.name, ...outcome });
    state = outcome.state ?? state;
    if (outcome.stop) {
      stopped = outcome.reason;
      break;
    }
  }

  const finished = {
    ...state,
    lastRun: new Date(now).toISOString(),
    results: Object.fromEntries(
      results.map((entry) => [entry.profile, { state: entry.state_, at: new Date(now).toISOString() }]),
    ),
  };
  const rotated = results.some((entry) => entry.rotated);
  if (rotated) finished.rotates = true;
  else if (results.some((entry) => entry.state_ === "renewed")) finished.rotates ??= false;
  await writeRenewState(finished, env);
  log.info("renew", "run finished", { checked: results.length, stopped });
  return { results, stopped, rotates: finished.rotates };
}

async function renewOne(profile, { env, security, fetchImpl, now, horizonMs, force, state }) {
  const service = claudeCredentialService(profile.dir);
  let raw;
  try {
    raw = await readCredential({ service, env, security });
  } catch (error) {
    // The Keychain refused: locked, or running somewhere it cannot prompt.
    // Nothing else in this run will fare better, so stop and say so once.
    return { state_: "keychain-unreadable", detail: error.message, stop: true, reason: error.message };
  }
  const blob = parseCredential(raw);
  if (!blob) return { state_: "no-login" };

  const fingerprint = tokenFingerprint(blob.claudeAiOauth.refreshToken);
  if (!force && isQuarantined(state, profile.name, fingerprint)) return { state_: "quarantined" };

  const expiresAt = Number(blob.claudeAiOauth.expiresAt);
  if (!force && Number.isFinite(expiresAt) && expiresAt - now > horizonMs) {
    return { state_: "fresh", expiresInMs: expiresAt - now };
  }

  const refreshed = await refreshCredential(blob, { fetchImpl, now });
  if (refreshed.state === "dead") {
    const quarantined = {
      ...state.quarantined,
      [profile.name]: { fingerprint, at: new Date(now).toISOString(), detail: refreshed.detail ?? null },
    };
    log.warn("renew", "refresh lineage is dead", { profile: profile.name, detail: refreshed.detail });
    return {
      state_: "dead",
      detail: refreshed.detail,
      state: { ...state, quarantined },
      stop: true,
      reason: `"${profile.name}" needs signing in again (${refreshed.detail ?? "the refresh token was rejected"})`,
    };
  }
  if (refreshed.state !== "ok") return { state_: "unreachable", detail: refreshed.detail };

  try {
    await writeCredential({ service, secret: JSON.stringify(refreshed.blob), env, security });
  } catch (error) {
    // The new token exists on the server but not on disk. Say it loudly: the
    // profile may need signing in again, and a quiet failure hides that.
    log.error("renew", "refreshed token could not be stored", { profile: profile.name, error });
    return { state_: "not-stored", detail: error.message, stop: true, reason: error.message };
  }
  log.info("renew", "profile renewed", { profile: profile.name, rotated: refreshed.rotated });
  // A fresh sign-in clears an old quarantine for the same profile.
  return { state_: "renewed", rotated: refreshed.rotated, state: withoutProfile(state, profile.name) };
}

/** One line per profile, for `zclaude renew status` and the run's own output. */
export function describeResult(entry) {
  switch (entry.state_) {
    case "fresh": {
      return `still fresh for ${(entry.expiresInMs / 3_600_000).toFixed(1)}h`;
    }
    case "renewed": {
      return entry.rotated ? "renewed (the refresh token rotated)" : "renewed";
    }
    case "no-login": {
      return "no login stored";
    }
    case "quarantined": {
      return "needs signing in again; not retried";
    }
    case "dead": {
      return `the refresh token was rejected (${entry.detail ?? "invalid_grant"})`;
    }
    case "unreachable": {
      return `could not be reached (${entry.detail ?? "network"})`;
    }
    case "keychain-unreadable": {
      return `the Keychain would not answer (${entry.detail})`;
    }
    case "not-stored": {
      return `the new token could not be stored (${entry.detail})`;
    }
    default: {
      return entry.state_;
    }
  }
}
