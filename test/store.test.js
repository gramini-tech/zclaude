import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

import {
  deleteCredential,
  keychainAvailable,
  loadCredential,
  readState,
  saveCredential,
  storePaths,
  writeState,
} from "../src/store.js";
import { isolatedEnv, tempHome } from "./helpers.js";

describe("file store", () => {
  let home;
  let env;
  before(async () => {
    home = await tempHome();
    env = isolatedEnv(home.dir);
  });
  after(() => home.cleanup());

  it("keychainAvailable is false off macOS or when disabled", () => {
    assert.equal(keychainAvailable({}, "linux"), false);
    assert.equal(keychainAvailable({ ZCLAUDE_NO_KEYCHAIN: "1" }, "darwin"), false);
    assert.equal(keychainAvailable({}, "darwin"), true);
  });

  it("saves 0600, loads, and deletes", async () => {
    assert.equal(await loadCredential({ env, platform: "linux" }), null);
    const { location } = await saveCredential(
      { apiKey: "abcdefghijklmnop.secretsecretsecret", email: "a@b.c", keyName: "zclaude" },
      { env, platform: "linux" },
    );
    assert.equal(location, "file");
    const paths = storePaths(env);
    assert.equal((await stat(paths.credentialsFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.home)).mode & 0o777, 0o700);
    const loaded = await loadCredential({ env, platform: "linux" });
    assert.equal(loaded.apiKey, "abcdefghijklmnop.secretsecretsecret");
    assert.equal(loaded.source, "file");
    assert.equal(loaded.email, "a@b.c");
    const profile = JSON.parse(await readFile(paths.profileFile, "utf8"));
    assert.equal(profile.location, "file");
    assert.equal(profile.email, "a@b.c");
    assert.equal("apiKey" in profile, false);
    const { removed } = await deleteCredential({ env, platform: "linux" });
    assert.deepEqual(removed, ["file"]);
    assert.equal(await loadCredential({ env, platform: "linux" }), null);
    assert.deepEqual((await deleteCredential({ env, platform: "linux" })).removed, []);
  });

  it("treats a corrupt credentials file as absent", async () => {
    await writeFile(storePaths(env).credentialsFile, "{not json");
    assert.equal(await loadCredential({ env, platform: "linux" }), null);
    await deleteCredential({ env, platform: "linux" });
  });

  it("state survives round trips", async () => {
    await writeState({ lastProfile: "zai" }, env);
    await writeState({ other: 1 }, env);
    assert.deepEqual(await readState(env), { lastProfile: "zai", other: 1 });
  });
});

describe("keychain wrapper", () => {
  function fakeSecurity(store) {
    return async (args, { stdinText } = {}) => {
      if (args[0] === "find-generic-password")
        return store.secret
          ? { code: 0, stdout: `${store.secret}\n`, stderr: "" }
          : { code: 44, stdout: "", stderr: "not found" };
      if (args[0] === "delete-generic-password") {
        if (!store.secret) return { code: 44, stdout: "", stderr: "" };
        store.secret = null;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "-i") {
        const match = stdinText.match(/-w "([^"]+)"/u);
        store.secret = match[1];
        store.command = stdinText;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
  }

  it("stores through stdin, reads back and deletes", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: `${home.dir}/.zclaude` };
      const store = { secret: null };
      const security = fakeSecurity(store);
      const { location } = await saveCredential(
        { apiKey: "abcdefghijklmnop.secretsecretsecret", email: "me@x.y" },
        { env, platform: "darwin", security },
      );
      assert.equal(location, "keychain");
      assert.match(
        store.command,
        /add-generic-password -a "me@x.y" -s "zclaude" -w "abcdefghijklmnop.secretsecretsecret" -U/u,
      );
      const loaded = await loadCredential({ env, platform: "darwin", security });
      assert.equal(loaded.source, "keychain");
      assert.equal(loaded.email, "me@x.y");
      const { removed } = await deleteCredential({ env, platform: "darwin", security });
      assert.deepEqual(removed, ["keychain"]);
      assert.equal(await loadCredential({ env, platform: "darwin", security }), null);
    } finally {
      await home.cleanup();
    }
  });

  it("falls back to the file when the keychain fails", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: `${home.dir}/.zclaude` };
      const security = async () => ({ code: 1, stdout: "", stderr: "User interaction is not allowed." });
      const { location } = await saveCredential(
        { apiKey: "abcdefghijklmnop.secretsecretsecret" },
        { env, platform: "darwin", security },
      );
      assert.equal(location, "file");
      const loaded = await loadCredential({ env, platform: "darwin", security });
      assert.equal(loaded.source, "file");
    } finally {
      await home.cleanup();
    }
  });
});
