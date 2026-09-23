// Getting a token for a request without becoming a second refresher.
//
// The rules under test come from swap/lineage.js: a login has room for exactly
// one refresher, the router is not it for anything Claude Code holds, and
// spending the last minutes of a token is the correct behaviour rather than a
// workaround.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { claudeCredentialService, DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { putRegistered } from "../src/profiles/registry.js";
import { createTokenCache, MAX_CACHE_MS } from "../src/router/credentials.js";
import { TOKEN_URL } from "../src/usage/anthropic.js";
import { mockFetch, tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const credential = (who, expiresAt) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat-${who}`,
      refreshToken: `sk-ant-ort-${who}`,
      expiresAt,
      refreshTokenExpiresAt: NOW + 30 * 86_400_000,
      subscriptionType: "max",
    },
  });

/** A Keychain in a Map, which counts its reads and can refuse. */
function fakeKeychain(items, { refuse = false } = {}) {
  const reads = [];
  const runner = async (args, { stdinText } = {}) => {
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "find-generic-password") {
      reads.push(at("-s"));
      if (refuse) return { code: 1, stdout: "", stderr: "User interaction is not allowed." };
      const found = items.get(at("-s"));
      if (found === undefined) return { code: 44, stdout: "", stderr: "" };
      return { code: 0, stdout: args.includes("-w") ? `${found}\n` : "attrs\n", stderr: "" };
    }
    if (args[0] === "-i") {
      const service = stdinText.match(/-s "([^"]+)"/u)[1];
      items.set(service, Buffer.from(stdinText.match(/-X ([\da-f]+)/u)[1], "hex").toString("utf8"));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  runner.reads = reads;
  return runner;
}

/** A machine with one Anthropic profile, and optionally the same account in the slot. */
async function machine({ expiresAt = NOW + HOUR, alsoInSlot = false, lineage = "work" } = {}) {
  const home = await tempHome();
  const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
  const dir = join(home.dir, ".zclaude", "profiles", "work", "home");
  await mkdir(dir, { recursive: true });
  await putRegistered({ name: "work", provider: "anthropic", dir }, env);
  // The same account in the global slot is what makes refreshRight refuse, and
  // that refusal is the case most of these tests are about.
  const slot = alsoInSlot ? [[DEFAULT_CREDENTIAL_SERVICE, credential(lineage, expiresAt)]] : [];
  const items = new Map([[claudeCredentialService(dir), credential(lineage, expiresAt)], ...slot]);
  const record = { name: "work", provider: "anthropic", dir };
  return { home, env, items, dir, target: { kind: "anthropic", profile: "work", record } };
}

describe("a token for an Anthropic target", () => {
  it("uses a token that is not due a refresh, and asks the endpoint nothing", async () => {
    const { home, env, items, target } = await machine();
    try {
      const security = fakeKeychain(items);
      const fetchImpl = mockFetch(() => null);
      const cache = createTokenCache({ env, security, fetchImpl });
      const answer = await cache.tokenFor(target, { now: NOW });
      assert.equal(answer.state, "ok");
      assert.equal(answer.value, "sk-ant-oat-work");
      assert.equal(fetchImpl.calls.length, 0);
    } finally {
      await home.cleanup();
    }
  });

  // The subtlest rule in the design, and the one most likely to be simplified
  // away later: when the lineage belongs to somebody else, spend what is left
  // rather than minting.
  it("spends the last minutes of a token it is not allowed to refresh", async () => {
    // The same account is in the global slot, so refreshRight refuses. The
    // token is two minutes from expiry, which is inside the five-minute buffer
    // that makes needsRefresh fire but still perfectly usable.
    const { home, env, items, target } = await machine({ expiresAt: NOW + 120_000, alsoInSlot: true });
    try {
      const security = fakeKeychain(items);
      const fetchImpl = mockFetch(() => null);
      const cache = createTokenCache({ env, security, fetchImpl });
      const answer = await cache.tokenFor(target, { now: NOW });

      assert.equal(answer.state, "ok");
      assert.equal(answer.value, "sk-ant-oat-work", "the current token, not a new one");
      assert.equal(
        fetchImpl.calls.filter((call) => call.url === TOKEN_URL).length,
        0,
        "and nothing was minted, because this lineage is Claude Code's",
      );
    } finally {
      await home.cleanup();
    }
  });

  it("says the numbers are pending when the shared token has actually lapsed", async () => {
    const { home, env, items, target } = await machine({ expiresAt: NOW - 1000, alsoInSlot: true });
    try {
      const cache = createTokenCache({ env, security: fakeKeychain(items), fetchImpl: mockFetch(() => null) });
      const answer = await cache.tokenFor(target, { now: NOW });
      assert.equal(answer.state, "stale-token");
      assert.match(answer.detail, /global login/u);
    } finally {
      await home.cleanup();
    }
  });

  it("refreshes a login nothing else is holding, and uses the new token", async () => {
    const { home, env, items, target } = await machine({ expiresAt: NOW + 60_000 });
    try {
      const fetchImpl = mockFetch(({ url }) =>
        url === TOKEN_URL
          ? Response.json({ access_token: "sk-ant-oat-fresh", refresh_token: "sk-ant-ort-next", expires_in: 3600 })
          : null,
      );
      const cache = createTokenCache({ env, security: fakeKeychain(items), fetchImpl });
      const answer = await cache.tokenFor(target, { now: NOW });
      assert.equal(answer.state, "ok");
      assert.equal(answer.value, "sk-ant-oat-fresh");
      assert.equal(fetchImpl.calls.filter((call) => call.url === TOKEN_URL).length, 1);
    } finally {
      await home.cleanup();
    }
  });

  it("reports a signed-out profile without calling it broken", async () => {
    const { home, env, target } = await machine();
    try {
      const cache = createTokenCache({ env, security: fakeKeychain(new Map()), fetchImpl: mockFetch(() => null) });
      const answer = await cache.tokenFor(target, { now: NOW });
      assert.equal(answer.state, "unauthorized");
      assert.match(answer.detail, /signed out/u);
    } finally {
      await home.cleanup();
    }
  });

  it("says keychain, not signed out, when the keychain refuses", async () => {
    // Confusing the two is how somebody re-authenticates three accounts that
    // were all fine.
    const { home, env, items, target } = await machine();
    try {
      const security = fakeKeychain(items, { refuse: true });
      const cache = createTokenCache({ env, security, fetchImpl: mockFetch(() => null) });
      const answer = await cache.tokenFor(target, { now: NOW });
      assert.equal(answer.state, "unknown");
      assert.match(answer.detail, /keychain would not answer/u);
      assert.doesNotMatch(answer.detail, /signed out/u);
    } finally {
      await home.cleanup();
    }
  });

  it("reports a dead lineage as dead, which no amount of retrying undoes", async () => {
    const { home, env, items, target } = await machine({ expiresAt: NOW + 60_000 });
    try {
      const fetchImpl = mockFetch(({ url }) =>
        url === TOKEN_URL ? Response.json({ error: "invalid_grant" }, { status: 400 }) : null,
      );
      const cache = createTokenCache({ env, security: fakeKeychain(items), fetchImpl });
      assert.equal((await cache.tokenFor(target, { now: NOW })).state, "dead");
    } finally {
      await home.cleanup();
    }
  });

  it("names a route pointing at a profile that is gone", async () => {
    const { home, env, items } = await machine();
    try {
      const cache = createTokenCache({ env, security: fakeKeychain(items), fetchImpl: mockFetch(() => null) });
      const answer = await cache.tokenFor({ kind: "anthropic", profile: "ghost", record: null }, { now: NOW });
      assert.equal(answer.state, "unauthorized");
      assert.match(answer.detail, /no profile named "ghost"/u);
    } finally {
      await home.cleanup();
    }
  });
});

describe("how often the keychain is asked", () => {
  it("reads once for concurrent requests to the same account", async () => {
    // `security` is a subprocess that can take tens of milliseconds and can
    // prompt. Ten requests must not mean ten of those, and must not mean two
    // refreshes racing each other.
    const { home, env, items, target } = await machine();
    try {
      const security = fakeKeychain(items);
      const cache = createTokenCache({ env, security, fetchImpl: mockFetch(() => null) });
      const answers = await Promise.all(Array.from({ length: 10 }, () => cache.tokenFor(target, { now: NOW })));
      assert.ok(answers.every((answer) => answer.state === "ok"));
      assert.equal(security.reads.length, 1, "one read for ten requests");
    } finally {
      await home.cleanup();
    }
  });

  it("re-reads at least every ten minutes, whatever the token claims", async () => {
    // A rotation performed by Claude Code itself has to be picked up without
    // anybody watching the Keychain for it.
    const { home, env, items, target } = await machine({ expiresAt: NOW + 8 * HOUR });
    try {
      const security = fakeKeychain(items);
      const cache = createTokenCache({ env, security, fetchImpl: mockFetch(() => null) });
      await cache.tokenFor(target, { now: NOW });
      await cache.tokenFor(target, { now: NOW + MAX_CACHE_MS - 1000 });
      assert.equal(security.reads.length, 1, "inside the ceiling, memory answers");
      await cache.tokenFor(target, { now: NOW + MAX_CACHE_MS + 1000 });
      assert.equal(security.reads.length, 2, "past it, the store is asked again");
    } finally {
      await home.cleanup();
    }
  });

  it("re-reads on demand, which is what a 401 triggers", async () => {
    const { home, env, items, target } = await machine();
    try {
      const security = fakeKeychain(items);
      const cache = createTokenCache({ env, security, fetchImpl: mockFetch(() => null) });
      await cache.tokenFor(target, { now: NOW });
      cache.invalidate(target);
      await cache.tokenFor(target, { now: NOW });
      assert.equal(security.reads.length, 2);
      assert.equal(cache.size(), 1);
    } finally {
      await home.cleanup();
    }
  });

  it("does not hammer the keychain for an account it just found signed out", async () => {
    const { home, env, target } = await machine();
    try {
      const security = fakeKeychain(new Map());
      const cache = createTokenCache({ env, security, fetchImpl: mockFetch(() => null) });
      await cache.tokenFor(target, { now: NOW });
      await cache.tokenFor(target, { now: NOW + 1000 });
      assert.equal(security.reads.length, 1, "a negative answer is cached briefly too");
    } finally {
      await home.cleanup();
    }
  });
});

describe("a token for a Z.ai target", () => {
  it("prefers a key from the environment, as every other Z.ai surface does", async () => {
    const home = await tempHome();
    try {
      const env = {
        HOME: home.dir,
        ZCLAUDE_HOME: join(home.dir, ".zclaude"),
        USER: "tester",
        ZAI_API_KEY: "from-the-environment",
      };
      const cache = createTokenCache({ env, fetchImpl: mockFetch(() => null) });
      const answer = await cache.tokenFor({ kind: "zai", zaiProfile: null }, { now: NOW });
      assert.equal(answer.state, "ok");
      assert.equal(answer.value, "from-the-environment");
    } finally {
      await home.cleanup();
    }
  });

  it("reads a stored key, and says so when there is none", async () => {
    const home = await tempHome();
    try {
      const env = {
        HOME: home.dir,
        ZCLAUDE_HOME: join(home.dir, ".zclaude"),
        USER: "tester",
        ZCLAUDE_NO_KEYCHAIN: "1",
      };
      const cache = createTokenCache({ env, fetchImpl: mockFetch(() => null) });
      const missing = await cache.tokenFor({ kind: "zai", zaiProfile: null }, { now: NOW });
      assert.equal(missing.state, "unauthorized");
      assert.match(missing.detail, /no Z\.ai key/u);

      const dir = join(home.dir, ".zclaude");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "credentials.json"),
        JSON.stringify({ version: 1, apiKey: "0123456789abcdef0123.ABCDEFGHIJKLMNOPQRSTUV" }),
      );
      const fresh = createTokenCache({ env, fetchImpl: mockFetch(() => null) });
      const found = await fresh.tokenFor({ kind: "zai", zaiProfile: null }, { now: NOW });
      assert.equal(found.state, "ok");
      assert.match(found.value, /^0123456789/u);
    } finally {
      await home.cleanup();
    }
  });
});
