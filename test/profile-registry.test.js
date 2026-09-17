import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  getRegistered,
  listRegistered,
  patchRegistered,
  putRegistered,
  readRegistry,
  registryPath,
  removeRegistered,
} from "../src/profiles/registry.js";
import { accountLabel, credentialLocation, probeProfile, readIdentity } from "../src/profiles/probe.js";
import { isolatedEnv, tempHome } from "./helpers.js";

describe("profile registry", () => {
  let home;
  let env;
  before(async () => {
    home = await tempHome();
    env = isolatedEnv(home.dir);
  });
  after(() => home.cleanup());

  it("starts empty and round-trips a profile", async () => {
    assert.deepEqual(await listRegistered(env), []);
    const record = await putRegistered({ name: "work", provider: "anthropic", credentialService: "svc" }, env);
    assert.equal(record.dir, join(env.ZCLAUDE_HOME, "profiles", "work", "home"));
    assert.deepEqual(record.share, { config: true, history: true });
    assert.equal(record.provider, "anthropic");
    assert.ok(record.createdAt);
    assert.deepEqual(await getRegistered("work", env), record);
    assert.equal((await stat(registryPath(env))).mode & 0o777, 0o600);
  });

  it("keeps the directory that was recorded even if ZCLAUDE_HOME moves", async () => {
    const moved = { ...env, ZCLAUDE_HOME: join(home.dir, "elsewhere") };
    await writeFile(
      registryPath(moved),
      JSON.stringify({
        version: 1,
        profiles: { pinned: { name: "pinned", provider: "zai", dir: "/tmp/pinned/home" } },
      }),
    ).catch(async () => {
      await mkdir(moved.ZCLAUDE_HOME, { recursive: true });
      await writeFile(
        registryPath(moved),
        JSON.stringify({
          version: 1,
          profiles: { pinned: { name: "pinned", provider: "zai", dir: "/tmp/pinned/home" } },
        }),
      );
    });
    const record = await getRegistered("pinned", moved);
    assert.equal(record.dir, "/tmp/pinned/home", "the stored path wins over the computed one");
    assert.equal(record.provider, "zai");
  });

  it("defaults sharing to on and honours an explicit choice", async () => {
    const off = await putRegistered(
      { name: "private", provider: "anthropic", share: { config: true, history: false } },
      env,
    );
    assert.deepEqual(off.share, { config: true, history: false });
    const patched = await patchRegistered("private", { share: { config: false } }, env);
    assert.deepEqual(patched.share, { config: false, history: false });
    assert.equal(await patchRegistered("missing", { share: {} }, env), null);
  });

  it("sorts by name, removes, and reports removal of an unknown profile", async () => {
    await putRegistered({ name: "alpha", provider: "anthropic" }, env);
    assert.deepEqual(
      (await listRegistered(env)).map((profile) => profile.name),
      ["alpha", "private", "work"],
    );
    assert.equal(await removeRegistered("alpha", env), true);
    assert.equal(await removeRegistered("alpha", env), false);
  });

  it("treats a corrupt registry as empty instead of failing a launch", async () => {
    const broken = isolatedEnv(join(home.dir, "broken"));
    await mkdir(broken.ZCLAUDE_HOME, { recursive: true });
    await writeFile(registryPath(broken), "{not json");
    assert.deepEqual(await readRegistry(broken), { version: 1, profiles: {} });
    await writeFile(registryPath(broken), JSON.stringify({ profiles: { bad: { provider: "anthropic" } } }));
    assert.deepEqual(await listRegistered(broken), [], "an entry with no directory is dropped");
  });

  it("writes JSON a human can read", async () => {
    const text = await readFile(registryPath(env), "utf8");
    assert.match(text, /^\{\n {2}"profiles"|^\{\n {2}"version"/u);
    assert.ok(text.endsWith("\n"));
  });
});

describe("profile probe", () => {
  let home;
  before(async () => {
    home = await tempHome();
  });
  after(() => home.cleanup());

  const fakeSecurity = (code) => async () => ({ code, stdout: "", stderr: "" });

  it("reads the identity Claude Code recorded, and tolerates a missing file", async () => {
    const dir = join(home.dir, "profile-home");
    await mkdir(dir, { recursive: true });
    assert.equal(await readIdentity(dir), null);
    await writeFile(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "a@b.c", organizationName: "Acme", seatTier: "team_tier_1" } }),
    );
    assert.deepEqual(await readIdentity(dir), { email: "a@b.c", organization: "Acme", seat: "team_tier_1" });
    await writeFile(join(dir, ".claude.json"), "{broken");
    assert.equal(await readIdentity(dir), null);
  });

  it("finds the credential in the keychain, in a file, or not at all", async () => {
    const dir = join(home.dir, "cred-home");
    await mkdir(dir, { recursive: true });
    assert.equal(await credentialLocation(dir, { platform: "darwin", security: fakeSecurity(0) }), "keychain");
    assert.equal(await credentialLocation(dir, { platform: "darwin", security: fakeSecurity(44) }), "none");
    assert.equal(await credentialLocation(dir, { platform: "linux", security: fakeSecurity(44) }), "none");
    await writeFile(join(dir, ".credentials.json"), "{}");
    assert.equal(await credentialLocation(dir, { platform: "linux", security: fakeSecurity(44) }), "file");
    assert.equal(
      await credentialLocation(dir, { platform: "darwin", security: fakeSecurity(44) }),
      "file",
      "macOS falls back to a plaintext file when the keychain has nothing",
    );
  });

  it("reports unknown rather than signed out when the keychain cannot be read", async () => {
    const dir = join(home.dir, "locked-home");
    await mkdir(dir, { recursive: true });
    const probe = await probeProfile({ name: "x", dir }, { platform: "darwin", security: fakeSecurity(51) });
    assert.equal(probe.credential, "unknown");
    assert.equal(probe.signedIn, "unknown");
    assert.match(probe.service, /^Claude Code-credentials-[0-9a-f]{8}$/u);
  });

  it("reports signed in when a credential exists", async () => {
    const dir = join(home.dir, "signedin-home");
    await mkdir(dir, { recursive: true });
    const probe = await probeProfile({ name: "y", dir }, { platform: "darwin", security: fakeSecurity(0) });
    assert.equal(probe.signedIn, true);
  });
});

describe("how an account reads in a list", () => {
  it("keeps the organization, because that is what separates two profiles on one login", () => {
    assert.equal(
      accountLabel({ email: "me@company.com", organization: "Hoomanely Inc" }),
      "me@company.com · Hoomanely Inc",
    );
    // A company seat and a personal subscription on the same email are billed
    // separately, so the two rows have to differ.
    assert.equal(
      accountLabel({ email: "me@company.com", organization: "me@company.com's Organization" }),
      "me@company.com · personal",
    );
    assert.notEqual(
      accountLabel({ email: "me@company.com", organization: "Hoomanely Inc" }),
      accountLabel({ email: "me@company.com", organization: "me@company.com's Organization" }),
    );
  });

  it("falls back to the email, and to nothing when there is no identity", () => {
    assert.equal(accountLabel({ email: "me@x.y" }), "me@x.y");
    assert.equal(accountLabel({ email: "me@x.y", organization: null }), "me@x.y");
    assert.equal(accountLabel(null), null);
    assert.equal(accountLabel({}), null);
  });
});
