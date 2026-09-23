// Who may mint the next token, and where it lands.
//
// The bug these are here for: zclaude refreshed a profile's copy of a login
// that was also the global one, the server retired the refresh token the VS
// Code extension was still carrying, and Claude Code signed the editor out.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { claudeCredentialService, DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { putRegistered } from "../src/profiles/registry.js";
import {
  busyProfiles,
  credentialStores,
  holdersOf,
  lineageOf,
  refreshLineage,
  refreshRight,
} from "../src/swap/lineage.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;

const credential = (lineage, expiresAt = NOW + 3_600_000) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat-${lineage}`,
      refreshToken: `sk-ant-ort-${lineage}`,
      expiresAt,
      refreshTokenExpiresAt: NOW + 30 * 86_400_000,
      subscriptionType: "max",
    },
  });

/** A Keychain that lives in a Map, plus the failures a real one produces. */
function fakeKeychain(items, { refuseWrite = new Set() } = {}) {
  const runner = async (args, { stdinText } = {}) => {
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "find-generic-password") {
      const found = items.get(at("-s"));
      if (found === undefined) return { code: 44, stdout: "", stderr: "" };
      return { code: 0, stdout: args.includes("-w") ? `${found}\n` : "attrs\n", stderr: "" };
    }
    if (args[0] === "-i") {
      const service = stdinText.match(/-s "([^"]+)"/u)[1];
      if (refuseWrite.has(service)) return { code: 1, stdout: "", stderr: "the keychain is locked" };
      items.set(service, Buffer.from(stdinText.match(/-X ([\da-f]+)/u)[1], "hex").toString("utf8"));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return runner;
}

const grant = (body) => async () => Response.json(body);
const ROTATED = { access_token: "next-access", refresh_token: "sk-ant-ort-next", expires_in: 3600 };

/**
 * A machine with a global slot and however many profiles are asked for, each
 * one holding the lineage it is given. Two profiles can be handed the same
 * lineage, which is exactly what a switch leaves behind.
 */
async function machine({ slot = null, profiles = {}, refuseWrite = new Set() } = {}) {
  const home = await tempHome();
  const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
  const items = new Map(slot ? [[DEFAULT_CREDENTIAL_SERVICE, credential(slot)]] : []);
  const dirs = {};
  for (const [name, lineage] of Object.entries(profiles)) {
    const dir = join(home.dir, ".zclaude", "profiles", name, "home");
    await mkdir(dir, { recursive: true });
    await putRegistered({ name, provider: "anthropic", dir }, env);
    dirs[name] = dir;
    if (lineage) items.set(claudeCredentialService(dir), credential(lineage));
  }
  return { home, env, items, dirs, security: fakeKeychain(items, { refuseWrite }) };
}

/** Pretend a profile has a Claude Code session running, by recording our own pid. */
async function runSessionOn(env, name, { routed = false, id = "live" } = {}) {
  const dir = join(env.ZCLAUDE_HOME, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({ version: 1, id, profile: name, pid: process.pid, startedAt: NOW, routed }),
  );
}

const stored = (items, dir) => JSON.parse(items.get(claudeCredentialService(dir))).claudeAiOauth;

describe("the stores a login lives in", () => {
  it("finds the global slot and every Anthropic profile", async () => {
    const { home, env, security, dirs } = await machine({ slot: "alpha", profiles: { work: "beta", spare: null } });
    try {
      const stores = await credentialStores({ env, security });
      const names = stores.map((store) => store.name).toSorted((a, b) => a.localeCompare(b));
      assert.deepEqual(names, ["spare", "the global login", "work"]);
      assert.equal(stores[0].kind, "slot");
      assert.equal(stores[0].service, DEFAULT_CREDENTIAL_SERVICE);
      const work = stores.find((store) => store.name === "work");
      assert.equal(work.service, claudeCredentialService(dirs.work));
      // A profile with no credential is still a store; it just holds nothing.
      const spare = stores.find((store) => store.name === "spare");
      assert.equal(spare.blob, null);
      assert.equal(spare.lineage, null);
    } finally {
      await home.cleanup();
    }
  });

  it("counts the plaintext fallback as a copy of the same lineage", async () => {
    const { home, env, security, dirs } = await machine({ profiles: { work: null } });
    try {
      await writeFile(join(dirs.work, ".credentials.json"), credential("beta"));
      const stores = await credentialStores({ env, security });
      const work = stores.find((store) => store.name === "work");
      assert.equal(work.lineage, null, "the Keychain item is genuinely absent");
      const beta = JSON.parse(credential("beta"));
      assert.equal(work.fileLineage, lineageOf(beta));
      assert.equal(holdersOf(stores, work.fileLineage).length, 1);
    } finally {
      await home.cleanup();
    }
  });
});

describe("the right to refresh a login", () => {
  const lineageFor = (name) => lineageOf(JSON.parse(credential(name)));

  it("refuses a lineage the global slot holds, however close to expiry it is", async () => {
    // The whole bug: "work" and the global slot are one account after a switch,
    // and the editor extension is reading the slot.
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "alpha" } });
    try {
      const stores = await credentialStores({ env, security });
      const right = refreshRight(lineageFor("alpha"), stores, { busy: new Set() });
      assert.equal(right.allowed, false);
      assert.match(right.reason, /global login/u);
      assert.deepEqual(
        right.holders.map((store) => store.name),
        ["the global login", "work"],
      );
    } finally {
      await home.cleanup();
    }
  });

  it("refuses a lineage a running session is already refreshing", async () => {
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      const stores = await credentialStores({ env, security });
      const right = refreshRight(lineageFor("beta"), stores, { busy: new Set(["work"]) });
      assert.equal(right.allowed, false);
      assert.match(right.reason, /session running/u);
    } finally {
      await home.cleanup();
    }
  });

  it("refuses when it cannot tell what is running, rather than guessing nothing is", async () => {
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      const stores = await credentialStores({ env, security });
      const right = refreshRight(lineageFor("beta"), stores, { busy: null });
      assert.equal(right.allowed, false);
      assert.match(right.reason, /could not be established/u);
    } finally {
      await home.cleanup();
    }
  });

  it("allows a login nothing else is holding", async () => {
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      const stores = await credentialStores({ env, security });
      const right = refreshRight(lineageFor("beta"), stores, { busy: new Set() });
      assert.equal(right.allowed, true);
      assert.deepEqual(
        right.holders.map((store) => store.name),
        ["work"],
      );
    } finally {
      await home.cleanup();
    }
  });

  it("has nothing to say about a credential with no refresh token", () => {
    assert.equal(refreshRight(null, [], { busy: new Set() }).allowed, false);
    assert.equal(refreshRight("nobody-holds-this", [], { busy: new Set() }).allowed, false);
  });
});

describe("refreshing a login", () => {
  const lineageFor = (name) => lineageOf(JSON.parse(credential(name)));

  it("writes the new token into every store that held the old one", async () => {
    // Two profiles on one account is a legitimate shape — the same login
    // registered twice — and the copy left behind is the one that breaks.
    const { home, env, security, items, dirs } = await machine({
      slot: "alpha",
      profiles: { work: "beta", backup: "beta" },
    });
    try {
      const result = await refreshLineage(lineageFor("beta"), { env, security, fetchImpl: grant(ROTATED), now: NOW });
      assert.equal(result.state, "ok");
      assert.equal(result.rotated, true);
      assert.deepEqual(
        result.written.toSorted((a, b) => a.localeCompare(b)),
        ["backup", "work"],
      );
      assert.deepEqual(result.failed, []);
      for (const dir of [dirs.work, dirs.backup]) {
        assert.equal(stored(items, dir).refreshToken, "sk-ant-ort-next");
        assert.equal(stored(items, dir).accessToken, "next-access");
        assert.equal(stored(items, dir).expiresAt, NOW + 3_600_000);
      }
      // The slot is a different account and is not touched.
      assert.equal(JSON.parse(items.get(DEFAULT_CREDENTIAL_SERVICE)).claudeAiOauth.refreshToken, "sk-ant-ort-alpha");
    } finally {
      await home.cleanup();
    }
  });

  it("leaves the global slot's account alone, so the editor keeps its login", async () => {
    const { home, env, security, items, dirs } = await machine({ slot: "alpha", profiles: { work: "alpha" } });
    try {
      const fetchImpl = () => {
        throw new Error("the token endpoint must not be reached");
      };
      const result = await refreshLineage(lineageFor("alpha"), { env, security, fetchImpl, now: NOW });
      assert.equal(result.state, "not-ours");
      assert.match(result.detail, /global login/u);
      assert.deepEqual(result.written, []);
      assert.equal(stored(items, dirs.work).refreshToken, "sk-ant-ort-alpha");
    } finally {
      await home.cleanup();
    }
  });

  it("refreshes a profile whose only session is routed, because that one holds no credential", async () => {
    // A routed session authenticates to the local router with a token zclaude
    // minted and never reads the profile's OAuth credential, so it cannot be
    // the refresher this rule protects. Counting it would leave the account's
    // token to expire while the renewal job politely stood back.
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      await runSessionOn(env, "work", { routed: true });
      assert.deepEqual([...(await busyProfiles({ env, now: NOW }))], [], "a routed session makes nobody busy");
      const result = await refreshLineage(lineageFor("beta"), {
        env,
        security,
        fetchImpl: grant(ROTATED),
        now: NOW,
      });
      assert.equal(result.state, "ok");
    } finally {
      await home.cleanup();
    }
  });

  it("still stands back when a routed session and an ordinary one share a profile", async () => {
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      await runSessionOn(env, "work", { routed: true, id: "routed" });
      await runSessionOn(env, "work", { routed: false, id: "plain" });
      assert.deepEqual([...(await busyProfiles({ env, now: NOW }))], ["work"]);
      const result = await refreshLineage(lineageFor("beta"), {
        env,
        security,
        fetchImpl: grant(ROTATED),
        now: NOW,
      });
      assert.equal(result.state, "not-ours");
    } finally {
      await home.cleanup();
    }
  });

  it("leaves a profile alone while a session is running on it", async () => {
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      await runSessionOn(env, "work");
      assert.deepEqual([...(await busyProfiles({ env, now: NOW }))], ["work"]);
      const result = await refreshLineage(lineageFor("beta"), {
        env,
        security,
        fetchImpl: grant(ROTATED),
        now: NOW,
      });
      assert.equal(result.state, "not-ours");
      assert.match(result.detail, /session running/u);
    } finally {
      await home.cleanup();
    }
  });

  it("updates the plaintext fallback where one already exists, and creates none where there is not", async () => {
    const { home, env, security, dirs } = await machine({ slot: "alpha", profiles: { work: "beta", backup: "beta" } });
    try {
      await writeFile(join(dirs.work, ".credentials.json"), credential("beta"));
      const result = await refreshLineage(lineageFor("beta"), { env, security, fetchImpl: grant(ROTATED), now: NOW });
      assert.equal(result.state, "ok");
      const file = JSON.parse(await readFile(join(dirs.work, ".credentials.json"), "utf8"));
      assert.equal(file.claudeAiOauth.refreshToken, "sk-ant-ort-next");
      await assert.rejects(readFile(join(dirs.backup, ".credentials.json"), "utf8"), { code: "ENOENT" });
    } finally {
      await home.cleanup();
    }
  });

  it("names the store it could not write, because that login is the one that will break", async () => {
    const { home, env, items, dirs } = await machine({ slot: "alpha", profiles: { work: "beta", backup: "beta" } });
    try {
      // The Keychain refuses exactly one item, which is the case that leaves a
      // store holding a token the server has already retired.
      const security = fakeKeychain(items, { refuseWrite: new Set([claudeCredentialService(dirs.backup)]) });
      const result = await refreshLineage(lineageFor("beta"), { env, security, fetchImpl: grant(ROTATED), now: NOW });
      assert.equal(result.state, "ok");
      assert.deepEqual(result.written, ["work"]);
      assert.deepEqual(
        result.failed.map((one) => one.store),
        ["backup"],
      );
      assert.equal(stored(items, dirs.work).refreshToken, "sk-ant-ort-next");
      assert.equal(stored(items, dirs.backup).refreshToken, "sk-ant-ort-beta", "the one that refused is untouched");
    } finally {
      await home.cleanup();
    }
  });

  it("says so when the server retires the lineage", async () => {
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      const fetchImpl = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
      const result = await refreshLineage(lineageFor("beta"), { env, security, fetchImpl, now: NOW });
      assert.equal(result.state, "dead");
      assert.equal(result.detail, "invalid_grant");
      assert.deepEqual(result.written, []);
    } finally {
      await home.cleanup();
    }
  });

  it("keeps a network failure retryable rather than calling the login dead", async () => {
    const { home, env, security } = await machine({ slot: "alpha", profiles: { work: "beta" } });
    try {
      const fetchImpl = async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      };
      const result = await refreshLineage(lineageFor("beta"), { env, security, fetchImpl, now: NOW });
      assert.equal(result.state, "transient");
      assert.deepEqual(result.written, []);
    } finally {
      await home.cleanup();
    }
  });
});
