import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  // Accounts matter now: one item per profile under the single zclaude service.
  function fakeSecurity(store) {
    const accountOf = (args) => {
      const index = args.indexOf("-a");
      return index === -1 ? null : args[index + 1];
    };
    const pick = (account) => {
      if (account !== null) return store.has(account) ? account : null;
      const [first] = store.keys();
      return first ?? null;
    };
    return async (args, { stdinText } = {}) => {
      if (args[0] === "find-generic-password") {
        const key = pick(accountOf(args));
        return key === null
          ? { code: 44, stdout: "", stderr: "not found" }
          : { code: 0, stdout: `${store.get(key)}\n`, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        const key = pick(accountOf(args));
        if (key === null) return { code: 44, stdout: "", stderr: "" };
        store.delete(key);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "-i") {
        const account = stdinText.match(/-a "([^"]+)"/u)[1];
        store.set(account, stdinText.match(/-w "([^"]+)"/u)[1]);
        store.commands = [...(store.commands ?? []), stdinText];
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
  }

  it("stores through stdin, reads back and deletes", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: `${home.dir}/.zclaude` };
      const store = new Map();
      const security = fakeSecurity(store);
      const { location } = await saveCredential(
        { apiKey: "abcdefghijklmnop.secretsecretsecret", email: "me@x.y" },
        { env, platform: "darwin", security },
      );
      assert.equal(location, "keychain");
      assert.match(
        store.commands.at(-1),
        /add-generic-password -a "zai:default" -s "zclaude" -w "abcdefghijklmnop.secretsecretsecret" -U/u,
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

  it("keeps one key per profile and leaves the others alone", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: `${home.dir}/.zclaude` };
      const store = new Map();
      const security = fakeSecurity(store);
      const options = { env, platform: "darwin", security };
      await saveCredential({ apiKey: "aaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaa", email: "one@x.y" }, options);
      await saveCredential(
        { apiKey: "bbbbbbbbbbbbbbbb.bbbbbbbbbbbbbbbb", email: "two@x.y" },
        { ...options, profile: "work" },
      );
      assert.deepEqual(
        store
          .keys()
          .toArray()
          .toSorted((a, b) => a.localeCompare(b)),
        ["zai:default", "zai:work"],
      );
      assert.equal((await loadCredential(options)).email, "one@x.y");
      assert.equal((await loadCredential({ ...options, profile: "work" })).email, "two@x.y");

      await deleteCredential({ ...options, profile: "work" });
      assert.deepEqual(store.keys().toArray(), ["zai:default"]);
      assert.equal(await loadCredential({ ...options, profile: "work" }), null);
      assert.equal((await loadCredential(options)).email, "one@x.y");
    } finally {
      await home.cleanup();
    }
  });

  it("moves a key stored before profiles existed onto the default account", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: `${home.dir}/.zclaude` };
      const store = new Map([["me@x.y", "cccccccccccccccc.cccccccccccccccc"]]);
      const security = fakeSecurity(store);
      await mkdir(`${home.dir}/.zclaude`, { recursive: true });
      await writeFile(`${home.dir}/.zclaude/profile.json`, JSON.stringify({ email: "me@x.y" }));
      const loaded = await loadCredential({ env, platform: "darwin", security });
      assert.equal(loaded.apiKey, "cccccccccccccccc.cccccccccccccccc");
      assert.deepEqual(store.keys().toArray(), ["zai:default"]);
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
