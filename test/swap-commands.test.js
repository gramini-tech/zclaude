// The `zclaude switch` command surface, in process. The Keychain runner is
// injected, so these tests never touch a real credential store.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { claudeCredentialService, DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { putRegistered } from "../src/profiles/registry.js";
import { cmdSwitchGroup } from "../src/swap-commands.js";
import { tempHome } from "./helpers.js";

// Fixed timestamps: a credential built twice has to compare equal, which is
// how these tests tell "unchanged" from "rewritten with the same content".
const HORIZON = 4_000_000_000_000;
const credential = (who) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat-${who}`,
      refreshToken: `sk-ant-ort-${who}`,
      expiresAt: HORIZON,
      refreshTokenExpiresAt: HORIZON,
      subscriptionType: "team",
    },
  });

const identity = (who, org) => ({
  accountUuid: `uuid-${who}`,
  emailAddress: `${who}@example.com`,
  organizationUuid: `org-${org}`,
  organizationName: org,
});

function fakeKeychain(items) {
  return async (args, { stdinText } = {}) => {
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "find-generic-password") {
      const found = items.get(at("-s"));
      if (found === undefined) return { code: 44, stdout: "", stderr: "" };
      return { code: 0, stdout: args.includes("-w") ? `${found}\n` : "attrs\n", stderr: "" };
    }
    if (args[0] === "-i") {
      items.set(
        stdinText.match(/-s "([^"]+)"/u)[1],
        Buffer.from(stdinText.match(/-X ([\da-f]+)/u)[1], "hex").toString(),
      );
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function capture(run) {
  const chunks = { out: "", err: "" };
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (text) => {
    chunks.out += text;
    return true;
  };
  process.stderr.write = (text) => {
    chunks.err += text;
    return true;
  };
  try {
    // Await first: an object spread is evaluated left to right, so `...chunks`
    // in the same literal would copy the buffers while they are still empty.
    const value = await run();
    return { ...chunks, value };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
}

const rejects = async (run) => {
  try {
    await capture(run);
  } catch (error) {
    return error;
  }
  throw new Error("expected the command to fail");
};

describe("zclaude switch", () => {
  let home;
  let env;
  let items;
  let profileDir;

  const swap = (args, options = {}) =>
    capture(() =>
      cmdSwitchGroup({ options: { args, ...options }, env }, { interactive: false, security: fakeKeychain(items) }),
    );

  beforeEach(async () => {
    home = await tempHome();
    env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester", NO_COLOR: "1" };
    profileDir = join(home.dir, ".zclaude", "profiles", "work", "home");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(home.dir, ".claude.json"),
      JSON.stringify({ oauthAccount: identity("alice", "Acme"), keep: 1 }),
    );
    await writeFile(join(profileDir, ".claude.json"), JSON.stringify({ oauthAccount: identity("bob", "Bees") }));
    items = new Map([
      [DEFAULT_CREDENTIAL_SERVICE, credential("alice")],
      [claudeCredentialService(profileDir), credential("bob")],
    ]);
    await putRegistered({ name: "work", provider: "anthropic", dir: profileDir }, env);
  });
  afterEach(() => home.cleanup());

  it("reports who holds the global login", async () => {
    const result = await swap(["status"]);
    assert.match(result.out, /account\s+alice@example\.com · Acme/u);
    assert.match(result.out, /credential\s+team/u);
    assert.match(result.out, /backups\s+none yet/u);
  });

  it("answers in JSON for anything that has to parse it", async () => {
    const result = await swap(["status"], { json: true });
    const status = JSON.parse(result.out);
    assert.equal(status.account.email, "alice@example.com");
    assert.equal(status.credentialPresent, true);
    assert.doesNotMatch(result.out, /sk-ant/u, "status never carries a token");
  });

  it("with no target, says who is in the slot and what could replace them", async () => {
    const result = await swap([]);
    assert.match(result.out, /alice@example\.com/u);
    assert.match(result.err, /Switch to one of: work/u);
  });

  it("--dry-run lists the steps and changes nothing", async () => {
    const result = await swap(["work"], { dryRun: true });
    assert.match(result.err, /Switching the global Claude Code login to "work" \(bob@example\.com · Bees\)/u);
    assert.match(result.err, /back up the current login|capture the current login/u);
    assert.match(result.err, /Nothing was changed \(--dry-run\)/u);
    assert.equal(items.get(DEFAULT_CREDENTIAL_SERVICE), credential("alice"));
  });

  it("switches, then restores, and says how to undo each", async () => {
    const switched = await swap(["work"], { yes: true });
    assert.match(switched.err, /The global login is now bob@example\.com · Bees \("work"\)/u);
    assert.match(switched.err, /keeps its own login for up to about half a minute/u);
    assert.match(switched.err, /Put alice@example\.com · Acme back with `zclaude switch --restore`/u);
    assert.equal(items.get(DEFAULT_CREDENTIAL_SERVICE), credential("bob"));
    const config = JSON.parse(await readFile(join(home.dir, ".claude.json"), "utf8"));
    assert.equal(config.keep, 1, "the rest of the file stays");

    const restored = await swap([], { restore: true, yes: true });
    assert.match(restored.err, /The global login is alice@example\.com · Acme again/u);
    assert.equal(items.get(DEFAULT_CREDENTIAL_SERVICE), credential("alice"));
  });

  it("refuses with a reason rather than a stack trace", async () => {
    assert.match((await rejects(() => swap(["nope"]))).message, /no profile named "nope"/u);
    await putRegistered({ name: "glm", provider: "zai", dir: join(home.dir, "glm") }, env);
    assert.match((await rejects(() => swap(["glm"]))).message, /Z\.ai profile/u);
    assert.match((await rejects(() => swap([], { restore: true }))).message, /no backup to restore/u);
  });

  it("captures the live login back into its profile on request", async () => {
    // The slot holds the profile's account, with a token Claude Code rotated.
    await writeFile(join(home.dir, ".claude.json"), JSON.stringify({ oauthAccount: identity("bob", "Bees") }));
    items.set(DEFAULT_CREDENTIAL_SERVICE, credential("bob-rotated"));
    const result = await swap(["capture"]);
    assert.match(result.err, /Stored the live login back into "work"/u);
    assert.equal(items.get(claudeCredentialService(profileDir)), credential("bob-rotated"));

    const again = await swap(["capture"]);
    assert.match(again.err, /Nothing to capture: already in step/u);
  });
});
