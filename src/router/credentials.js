// A bearer token for one target, per request, without becoming a second
// refresher.
//
// `swap/lineage.js` holds the invariant this file is built around: an Anthropic
// login has room for exactly one refresher, because the server rotates the
// refresh token on every use and retires the old one at once. The router is not
// that refresher for anything Claude Code is still holding. What it does
// instead is spend the token that exists, and `needsRefresh` fires five minutes
// early, so there is always a little left.
//
// Two consequences follow, and both look like bugs until you know why:
//
//   - A 401 from an upstream is expected rather than exceptional. The retry
//     layer re-reads the store once and tries again before blaming the account.
//   - `refreshLineage` answering "not-ours" is the normal case for the global
//     slot and for any profile with a live session, not a failure.
//
// Two caching rules keep it honest. Nothing is read from the Keychain twice for
// concurrent requests, because `security` is a subprocess that can take tens of
// milliseconds and can prompt; and nothing is cached past ten minutes even when
// the token says otherwise, so a rotation performed by Claude Code itself is
// picked up without anybody watching the Keychain for it.

import { log } from "../logger.js";
import { claudeCredentialService } from "../profiles/keychain-name.js";
import { registerSecret } from "../redact.js";
import { parseCredential, readCredential } from "../swap/keychain.js";
import { lineageOf, refreshLineage } from "../swap/lineage.js";
import { explicitZaiKey, loadCredential } from "../store.js";
import { needsRefresh } from "../usage/anthropic.js";

/** However long a token claims, it is re-read at least this often. */
export const MAX_CACHE_MS = 10 * 60_000;
/** A store that answered "signed out" is not asked again immediately. */
const NEGATIVE_MS = 30_000;
/** A Keychain that refused is retried sooner: it is a state that clears. */
const REFUSED_MS = 15_000;

/**
 * @typedef {object} TokenAnswer
 * @property {"ok" | "unauthorized" | "dead" | "stale-token" | "offline" | "unknown"} state
 * @property {string} [value]
 * @property {number} [expiresAt]
 * @property {string | null} [detail]
 */

/**
 * A token source for one router process.
 *
 * @param {{env?: NodeJS.ProcessEnv, security?: import("../swap/keychain.js").SecurityRunner, fetchImpl?: typeof fetch}} [deps]
 */
export function createTokenCache({ env = process.env, security, fetchImpl } = {}) {
  /** @type {Map<string, {answer: TokenAnswer, until: number}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<TokenAnswer>>} */
  const inFlight = new Map();

  const keyFor = (target) =>
    target.kind === "zai" ? `zai:${target.zaiProfile ?? "default"}` : `anthropic:${target.profile}`;

  function remember(key, answer, now) {
    const ttl =
      {
        ok: Math.max(0, Math.min(MAX_CACHE_MS, (answer.expiresAt ?? now) - now)),
        unauthorized: NEGATIVE_MS,
        dead: NEGATIVE_MS,
        unknown: REFUSED_MS,
      }[answer.state] ?? 0;
    if (ttl > 0) cache.set(key, { answer, until: now + ttl });
    return answer;
  }

  /**
   * The Z.ai key for a target. Precedence matches every other Z.ai surface:
   * the environment outranks a stored key.
   */
  async function zaiToken(target) {
    const explicit = explicitZaiKey(env);
    if (explicit) return { state: /** @type {const} */ ("ok"), value: explicit, expiresAt: Infinity, detail: null };
    const stored = await loadCredential({ env, profile: target.zaiProfile ?? null }).catch(() => null);
    if (!stored?.apiKey) {
      return { state: /** @type {const} */ ("unauthorized"), detail: "no Z.ai key is stored for this target" };
    }
    registerSecret(stored.apiKey);
    return { state: /** @type {const} */ ("ok"), value: stored.apiKey, expiresAt: Infinity, detail: null };
  }

  /**
   * The access token for an Anthropic profile.
   *
   * This is `freshCredential` from `usage/index.js`, deliberately. Two surfaces
   * asking the same question differently is how one of them ends up minting a
   * token the other is still holding.
   */
  async function anthropicToken(target, { now, signal }) {
    const { record } = target;
    if (!record)
      return { state: /** @type {const} */ ("unauthorized"), detail: `no profile named "${target.profile}"` };
    const service = record.credentialService ?? claudeCredentialService(record.dir);
    let raw;
    try {
      raw = await readCredential({ service, env, security });
    } catch (error) {
      // A Keychain that refuses looks exactly like an item that is not there,
      // and calling it "signed out" sends somebody re-authenticating an account
      // that is fine.
      return { state: /** @type {const} */ ("unknown"), detail: `the keychain would not answer: ${error.message}` };
    }
    const blob = parseCredential(raw);
    if (!blob) return { state: /** @type {const} */ ("unauthorized"), detail: "this profile is signed out" };

    const expiresAt = Number(blob.claudeAiOauth.expiresAt);
    const usable = Number.isFinite(expiresAt) && expiresAt > now;
    if (!needsRefresh(blob, now)) {
      registerSecret(blob.claudeAiOauth.accessToken);
      return { state: /** @type {const} */ ("ok"), value: blob.claudeAiOauth.accessToken, expiresAt, detail: null };
    }

    const refreshed = await refreshLineage(lineageOf(blob), { env, security, fetchImpl, signal, now });
    if (refreshed.state === "not-ours") {
      // The normal case, not a failure: the global slot and any profile with a
      // live session belong to Claude Code, which refreshes them on its own
      // clock. Spend what is left rather than racing it.
      log.debug("router", "left this login to its owner", { profile: target.profile, reason: refreshed.detail });
      if (!usable) return { state: /** @type {const} */ ("stale-token"), detail: refreshed.detail };
      registerSecret(blob.claudeAiOauth.accessToken);
      return { state: /** @type {const} */ ("ok"), value: blob.claudeAiOauth.accessToken, expiresAt, detail: null };
    }
    if (refreshed.state === "dead") return { state: /** @type {const} */ ("dead"), detail: refreshed.detail };
    if (refreshed.state !== "ok") return { state: /** @type {const} */ ("offline"), detail: refreshed.detail };
    if (refreshed.failed.length > 0) {
      // The new token exists on the server but not in every store that held the
      // old one. Using it would leave those stores holding something spent.
      const where = refreshed.failed.map((one) => one.store).join(", ");
      log.error("router", "refreshed token could not be stored", { profile: target.profile, where });
      return { state: /** @type {const} */ ("unknown"), detail: `the new token could not be stored for ${where}` };
    }
    const next = refreshed.blob.claudeAiOauth;
    registerSecret(next.accessToken);
    return {
      state: /** @type {const} */ ("ok"),
      value: next.accessToken,
      expiresAt: Number(next.expiresAt),
      detail: null,
    };
  }

  return {
    /**
     * A token for this target, from memory when it is still good.
     * @param {{kind: string, profile?: string, zaiProfile?: string | null, record?: object}} target
     * @param {{now?: number, signal?: AbortSignal, force?: boolean}} [options]
     * @returns {Promise<TokenAnswer>}
     */
    tokenFor(target, { now = Date.now(), signal, force = false } = {}) {
      const key = keyFor(target);
      const held = cache.get(key);
      if (!force && held && held.until > now) return Promise.resolve(held.answer);
      if (force) cache.delete(key);

      // One acquisition per profile at a time. Ten concurrent requests to one
      // account must do one Keychain read and at most one refresh; this is the
      // single-refresher rule at the process level, and `withCredentialsLock`
      // inside `refreshLineage` is the same rule at the machine level.
      const running = inFlight.get(key);
      if (running) return running;
      // Returned rather than awaited: this function hands back the one promise
      // every concurrent caller shares, which is the whole point of the mutex.
      const work = (target.kind === "zai" ? zaiToken(target) : anthropicToken(target, { now, signal }))
        .then((answer) => remember(key, answer, now))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, work);
      return work;
    },

    /** Forget one target, after an upstream refused its token. */
    invalidate(target) {
      cache.delete(keyFor(target));
    },

    /** For tests and for a status endpoint: how many are held, never which. */
    size() {
      return cache.size;
    },
  };
}
