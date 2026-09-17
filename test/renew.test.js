// The unattended renewal. It runs on a timer with nobody watching, so the
// tests are mostly about restraint: what it declines to do, and where it stops.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { claudeCredentialService, DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { putRegistered } from "../src/profiles/registry.js";
import { describeResult, HORIZON_MS, runRenewal } from "../src/renew/job.js";
import { readRenewState, tokenFingerprint } from "../src/renew/state.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;

const credential = (who, expiresAt) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat-${who}`,
      refreshToken: `sk-ant-ort-${who}`,
      expiresAt,
      refreshTokenExpiresAt: NOW + 30 * 86_400_000,
      subscriptionType: "team",
    },
  });

function fakeKeychain(items) {
  const runner = async (args, { stdinText } = {}) => {
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "find-generic-password") {
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
  runner.items = items;
  return runner;
}

/** Where a profile's credential lives, for a test that wants to peek. */
function serviceFor(home, name) {
  return claudeCredentialService(join(home.dir, ".zclaude", "profiles", name, "home"));
}

async function setup(profiles) {
  const home = await tempHome();
  const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
  const items = new Map([[DEFAULT_CREDENTIAL_SERVICE, credential("global", NOW - 1000)]]);
  for (const [name, expiresAt] of Object.entries(profiles)) {
    const dir = join(home.dir, ".zclaude", "profiles", name, "home");
    await mkdir(dir, { recursive: true });
    await putRegistered({ name, provider: "anthropic", dir }, env);
    if (expiresAt !== null) items.set(claudeCredentialService(dir), credential(name, expiresAt));
  }
  return { home, env, security: fakeKeychain(items), items };
}

const DEFAULT_GRANT = { access_token: "new-access", expires_in: 3600 };
const grant = (body) => async () => Response.json(body ?? DEFAULT_GRANT);

describe("the renewal run", () => {
  it("leaves a token that is still good alone", async () => {
    const { home, env, security, items } = await setup({ fresh: NOW + 6 * 3_600_000 });
    try {
      const before = items.get(serviceFor(home, "fresh"));
      const { results } = await runRenewal({
        env,
        security,
        now: NOW,
        fetchImpl: () => {
          throw new Error("a fresh profile must not be refreshed");
        },
      });
      assert.deepEqual(
        results.map((entry) => entry.state_),
        ["fresh"],
      );
      assert.match(describeResult(results[0]), /still fresh for 6\.0h/u);
      assert.equal(items.get(serviceFor(home, "fresh")), before);
    } finally {
      await home.cleanup();
    }
  });

  it("refreshes what is about to expire, and stores the rotation", async () => {
    const { home, env, security, items } = await setup({ soon: NOW + HORIZON_MS - 60_000 });
    try {
      const { results, rotates } = await runRenewal({
        env,
        security,
        now: NOW,
        fetchImpl: grant({ access_token: "new-access", expires_in: 3600, refresh_token: "sk-ant-ort-rotated" }),
      });
      assert.equal(results[0].state_, "renewed");
      assert.equal(results[0].rotated, true);
      assert.equal(rotates, true, "the run records that this account rotates, which status reports");
      const stored = JSON.parse(items.get(serviceFor(home, "soon")));
      assert.equal(
        stored.claudeAiOauth.refreshToken,
        "sk-ant-ort-rotated",
        "a rotation that is not stored is a lockout",
      );
      assert.equal(stored.claudeAiOauth.accessToken, "new-access");
      assert.equal(stored.claudeAiOauth.subscriptionType, "team", "the rest of the blob survives");
    } finally {
      await home.cleanup();
    }
  });

  it("never touches the global slot", async () => {
    const { home, env, security, items } = await setup({ soon: NOW - 1000 });
    try {
      const before = items.get(DEFAULT_CREDENTIAL_SERVICE);
      await runRenewal({ env, security, now: NOW, fetchImpl: grant() });
      assert.equal(items.get(DEFAULT_CREDENTIAL_SERVICE), before, "whoever is signed in globally is not ours to renew");
    } finally {
      await home.cleanup();
    }
  });

  it("stops at the first dead lineage instead of marching through the rest", async () => {
    const { home, env, security } = await setup({ a: NOW - 1000, b: NOW - 1000 });
    try {
      let calls = 0;
      const { results, stopped } = await runRenewal({
        env,
        security,
        now: NOW,
        fetchImpl: async () => {
          calls += 1;
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        },
      });
      assert.equal(calls, 1, "one refusal is enough to know the rest can wait");
      assert.equal(results.at(-1).state_, "dead");
      assert.match(stopped, /needs signing in again/u);

      const state = await readRenewState(env);
      assert.equal(state.quarantined.a.fingerprint, tokenFingerprint("sk-ant-ort-a"));
      assert.doesNotMatch(JSON.stringify(state), /sk-ant/u, "the state file carries a fingerprint, not a token");
    } finally {
      await home.cleanup();
    }
  });

  it("does not retry a quarantined profile, until it is signed in again", async () => {
    const { home, env, security, items } = await setup({ a: NOW - 1000 });
    try {
      const dead = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
      await runRenewal({ env, security, now: NOW, fetchImpl: dead });

      let calls = 0;
      const second = await runRenewal({
        env,
        security,
        now: NOW + 86_400_000,
        fetchImpl: async () => {
          calls += 1;
          return dead();
        },
      });
      assert.equal(second.results[0].state_, "quarantined");
      assert.equal(calls, 0, "an auth endpoint is not somewhere to knock on a timer");

      // A new sign-in replaces the token, and with it the fingerprint.
      items.set(serviceFor(home, "a"), credential("a-signed-in-again", NOW - 1000));
      const third = await runRenewal({ env, security, now: NOW + 172_800_000, fetchImpl: grant() });
      assert.equal(third.results[0].state_, "renewed");
      assert.equal((await readRenewState(env)).quarantined.a, undefined);
    } finally {
      await home.cleanup();
    }
  });

  it("stops when the Keychain will not answer, rather than looping on it", async () => {
    const { home, env } = await setup({ a: NOW - 1000, b: NOW - 1000 });
    try {
      const refusing = async () => ({ code: 51, stdout: "", stderr: "User interaction is not allowed." });
      const { results, stopped } = await runRenewal({ env, security: refusing, now: NOW, fetchImpl: grant() });
      assert.equal(results.length, 1);
      assert.equal(results[0].state_, "keychain-unreadable");
      assert.match(stopped, /User interaction/u);
    } finally {
      await home.cleanup();
    }
  });

  it("says so when a profile has no login at all", async () => {
    const { home, env, security } = await setup({ empty: null });
    try {
      const { results } = await runRenewal({ env, security, now: NOW, fetchImpl: grant() });
      assert.equal(results[0].state_, "no-login");
      assert.equal(describeResult(results[0]), "no login stored");
    } finally {
      await home.cleanup();
    }
  });

  it("keeps a network failure retryable", async () => {
    const { home, env, security } = await setup({ a: NOW - 1000 });
    try {
      const { results, stopped } = await runRenewal({
        env,
        security,
        now: NOW,
        fetchImpl: async () => Response.json({}, { status: 503 }),
      });
      assert.equal(results[0].state_, "unreachable");
      assert.equal(stopped, null, "a bad minute is not a reason to stop the run");
      assert.equal((await readRenewState(env)).quarantined.a, undefined, "and not a reason to give up on the profile");
    } finally {
      await home.cleanup();
    }
  });

  it("ignores Z.ai profiles, whose keys do not expire", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
      const dir = join(home.dir, ".zclaude", "profiles", "glm", "home");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".claude.json"), "{}");
      await putRegistered({ name: "glm", provider: "zai", dir }, env);
      const { results } = await runRenewal({ env, security: fakeKeychain(new Map()), now: NOW });
      assert.deepEqual(results, []);
    } finally {
      await home.cleanup();
    }
  });
});
