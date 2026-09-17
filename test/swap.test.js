// Moving the global login. The assertions that matter are about what does NOT
// change: the boundary test in contract.test.js lets exactly one file write
// Claude Code's config, and these are the tests that earn that permission.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { claudeCredentialService, DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { putRegistered } from "../src/profiles/registry.js";
import { backupId, clearBackups, listBackups } from "../src/swap/backup.js";
import { captureBack, planSwitch, restore, switchTo, swapStatus } from "../src/swap/index.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;

const credential = (who, overrides = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat-${who}`,
      refreshToken: `sk-ant-ort-${who}`,
      expiresAt: NOW + 3_600_000,
      refreshTokenExpiresAt: NOW + 30 * 86_400_000,
      scopes: ["user:inference"],
      subscriptionType: "team",
      ...overrides,
    },
  });

const identity = (who, org = "Acme") => ({
  accountUuid: `uuid-${who}`,
  emailAddress: `${who}@example.com`,
  organizationUuid: `org-${org}`,
  organizationName: org,
  seatTier: "team_tier_1",
});

/** A `security` that keeps items in a Map; never touches a real Keychain. */
function fakeKeychain(items = new Map()) {
  const runner = async (args, { stdinText } = {}) => {
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "find-generic-password") {
      const found = items.get(at("-s"));
      if (found === undefined) return { code: 44, stdout: "", stderr: "" };
      return { code: 0, stdout: args.includes("-w") ? `${found}\n` : "attrs\n", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      const had = items.delete(at("-s"));
      return { code: had ? 0 : 44, stdout: "", stderr: "" };
    }
    if (args[0] === "-i") {
      const service = stdinText.match(/-s "([^"]+)"/u)[1];
      items.set(service, Buffer.from(stdinText.match(/-X ([\da-f]+)/u)[1], "hex").toString("utf8"));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "add-generic-password") {
      items.set(at("-s"), Buffer.from(at("-X"), "hex").toString("utf8"));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  runner.items = items;
  return runner;
}

/** A machine with a global login and one profile signed in as someone else. */
async function setup({ globalWho = "alice", profileWho = "bob" } = {}) {
  const home = await tempHome();
  const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
  const profileDir = join(home.dir, ".zclaude", "profiles", "work", "home");
  await mkdir(join(home.dir, ".claude"), { recursive: true });
  await mkdir(profileDir, { recursive: true });

  // The real file has around ninety keys; these stand in for all of them.
  const globalConfig = {
    numStartups: 41,
    userID: "user-alice",
    machineID: "machine-1",
    projects: { "/work/repo": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } },
    mcpServers: { linear: { command: "npx" } },
    oauthAccount: identity(globalWho),
    tipsHistory: { tip: 3 },
  };
  await writeFile(join(home.dir, ".claude.json"), JSON.stringify(globalConfig, null, 2));
  await writeFile(join(profileDir, ".claude.json"), JSON.stringify({ oauthAccount: identity(profileWho) }, null, 2));

  const security = fakeKeychain(
    new Map([
      [DEFAULT_CREDENTIAL_SERVICE, credential(globalWho)],
      [claudeCredentialService(profileDir), credential(profileWho)],
    ]),
  );
  await putRegistered({ name: "work", provider: "anthropic", dir: profileDir }, env);
  return { home, env, security, profileDir, globalConfig };
}

const configOf = async (home) => JSON.parse(await readFile(join(home.dir, ".claude.json"), "utf8"));

async function hashes(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const out = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    out[path.slice(dir.length + 1)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return out;
}

describe("switching the global login", () => {
  it("moves the credential and the identity, and changes nothing else in the config", async () => {
    const { home, env, security, globalConfig } = await setup();
    try {
      const before = await hashes(join(home.dir, ".claude"));
      const result = await switchTo("work", { env, security, platform: "linux" });
      assert.equal(result.account.email, "bob@example.com");
      assert.equal(result.previous.email, "alice@example.com");

      assert.equal(security.items.get(DEFAULT_CREDENTIAL_SERVICE), credential("bob"), "the slot holds bob's token");

      const after = await configOf(home);
      assert.equal(after.oauthAccount.emailAddress, "bob@example.com");
      const alphabetical = (x, y) => x.localeCompare(y);
      for (const [key, value] of Object.entries(globalConfig)) {
        if (key === "oauthAccount") continue;
        assert.deepEqual(after[key], value, `${key} must survive a switch untouched`);
      }
      assert.deepEqual(
        Object.keys(after).toSorted(alphabetical),
        Object.keys(globalConfig).toSorted(alphabetical),
        "no key is added or lost",
      );
      assert.deepEqual(await hashes(join(home.dir, ".claude")), before, "nothing inside ~/.claude is touched");
    } finally {
      await home.cleanup();
    }
  });

  it("captures the live token back into the profile it belongs to before moving on", async () => {
    const { home, env, security, profileDir } = await setup({ globalWho: "bob", profileWho: "bob" });
    try {
      // Claude Code refreshed the token while the profile was the global login,
      // so the slot is a generation ahead of the profile's own copy.
      const rotated = credential("bob", { refreshToken: "sk-ant-ort-rotated" });
      security.items.set(DEFAULT_CREDENTIAL_SERVICE, rotated);
      const result = await captureBack({ env, security });
      assert.deepEqual(result, { captured: true, profile: "work" });
      assert.equal(security.items.get(claudeCredentialService(profileDir)), rotated, "the rotation is not lost");
      assert.deepEqual(await captureBack({ env, security }), {
        captured: false,
        reason: "already in step",
        profile: "work",
      });
    } finally {
      await home.cleanup();
    }
  });

  // The capture runs unattended from the renewal job now, so it has to be safe
  // in the other direction too: a profile refreshed more recently than the slot
  // must not have its working token replaced by the slot's older one.
  it("refuses to capture a token older than the profile's own", async () => {
    const { home, env, security, profileDir } = await setup({ globalWho: "bob", profileWho: "bob" });
    try {
      const fresher = credential("bob", { refreshToken: "sk-ant-ort-fresher", expiresAt: NOW + 7_200_000 });
      security.items.set(claudeCredentialService(profileDir), fresher);
      const result = await captureBack({ env, security });
      assert.deepEqual(result, {
        captured: false,
        reason: "the profile's own copy is the newer one",
        profile: "work",
      });
      assert.equal(security.items.get(claudeCredentialService(profileDir)), fresher, "the newer token survives");
    } finally {
      await home.cleanup();
    }
  });

  it("backs the previous login up, verifiably, and restores it exactly", async () => {
    const { home, env, security, globalConfig } = await setup();
    try {
      await switchTo("work", { env, security, platform: "linux" });
      const [backup] = await listBackups(env);
      assert.equal(backup.account.email, "alice@example.com");
      assert.equal(backup.location, "file", "no Keychain on this platform, so a 0600 file");
      const stored = join(env.ZCLAUDE_HOME, "swap", "backups", backup.id, "credential.json");
      assert.equal((await stat(stored)).mode & 0o777, 0o600);

      const restored = await restore({ env, security });
      assert.equal(restored.account.email, "alice@example.com");
      assert.equal(security.items.get(DEFAULT_CREDENTIAL_SERVICE), credential("alice"));
      assert.deepEqual(await configOf(home), globalConfig, "a round trip leaves the config byte for byte");
    } finally {
      await home.cleanup();
    }
  });

  it("says what it would do without doing any of it", async () => {
    const { home, env, security } = await setup();
    try {
      const plan = await planSwitch("work", { env, security });
      assert.deepEqual(plan.refusals, []);
      assert.match(plan.steps.join("\n"), /back up the current login/u);
      assert.match(plan.steps.join("\n"), /write work's credential into Claude Code-credentials/u);
      assert.equal(plan.target.email, "bob@example.com");
      assert.equal(security.items.get(DEFAULT_CREDENTIAL_SERVICE), credential("alice"), "a plan changes nothing");
      assert.equal((await configOf(home)).oauthAccount.emailAddress, "alice@example.com");
    } finally {
      await home.cleanup();
    }
  });

  it("refuses rather than guessing", async () => {
    const { home, env, security, profileDir } = await setup();
    try {
      assert.match((await planSwitch("nope", { env, security })).refusals[0], /no profile named "nope"/u);

      await putRegistered({ name: "glm", provider: "zai", dir: join(home.dir, "glm") }, env);
      assert.match((await planSwitch("glm", { env, security })).refusals[0], /Z\.ai profile/u);

      security.items.delete(claudeCredentialService(profileDir));
      assert.match((await planSwitch("work", { env, security })).refusals[0], /has no stored login/u);
      await assert.rejects(switchTo("work", { env, security, platform: "linux" }), /has no stored login/u);
    } finally {
      await home.cleanup();
    }
  });

  it("refuses when the config file cannot be parsed, rather than replacing it", async () => {
    const { home, env, security } = await setup();
    try {
      await writeFile(join(home.dir, ".claude.json"), "{ torn");
      const plan = await planSwitch("work", { env, security });
      assert.match(plan.refusals.join(" "), /not valid JSON/u);
      await assert.rejects(switchTo("work", { env, security, platform: "linux" }), /not valid JSON/u);
      assert.equal(await readFile(join(home.dir, ".claude.json"), "utf8"), "{ torn", "the file is left alone");
    } finally {
      await home.cleanup();
    }
  });

  it("keeps the last ten logins and can forget them all", async () => {
    const { home, env, security } = await setup();
    try {
      await switchTo("work", { env, security, platform: "linux" });
      assert.equal((await listBackups(env)).length, 1);
      assert.match(backupId(new Date("2026-09-17T12:34:56.789Z")), /^2026-09-17T12-34-56-789Z$/u);

      const cleared = await clearBackups({ env, security });
      assert.equal(cleared, 1);
      assert.deepEqual(await listBackups(env), [], "uninstall must not leave a credential behind");
    } finally {
      await home.cleanup();
    }
  });

  it("reports who is in the slot and whose profile that is", async () => {
    const { home, env, security } = await setup({ globalWho: "bob", profileWho: "bob" });
    try {
      const status = await swapStatus({ env, security });
      assert.equal(status.account.email, "bob@example.com");
      assert.equal(status.owner, "work", "the account in the slot is recognised as a profile's");
      assert.equal(status.credentialPresent, true);
      assert.equal(status.credential.subscriptionType, "team");
      assert.equal(status.active, null, "zclaude has not put anything there yet");
    } finally {
      await home.cleanup();
    }
  });

  it("reports a Keychain that will not answer, instead of calling it signed out", async () => {
    const { home, env } = await setup();
    try {
      const refusing = async () => ({ code: 51, stdout: "", stderr: "User interaction is not allowed." });
      const status = await swapStatus({ env, security: refusing });
      assert.match(status.unreadable, /User interaction/u);
      assert.equal(status.credentialPresent, false);
      const plan = await planSwitch("work", { env, security: refusing });
      assert.match(plan.refusals.join(" "), /could not be read/u);
    } finally {
      await home.cleanup();
    }
  });

  it("puts the previous login back when the identity write fails", async () => {
    const { home, env, security, globalConfig } = await setup();
    try {
      // The config file becomes unwritable after the plan is made: the
      // credential lands, the identity cannot, and the pair must not be left
      // disagreeing.
      const configPath = join(home.dir, ".claude.json");
      await rm(configPath);
      await mkdir(configPath); // a directory where the file should be
      await assert.rejects(switchTo("work", { env, security, platform: "linux" }));
      assert.equal(security.items.get(DEFAULT_CREDENTIAL_SERVICE), credential("alice"), "the slot is put back");
      await rm(configPath, { recursive: true });
      await writeFile(configPath, JSON.stringify(globalConfig, null, 2));
    } finally {
      await home.cleanup();
    }
  });
});
