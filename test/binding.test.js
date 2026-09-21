// Which account a profile is for, and undoing a sign-in that missed it.
//
// The pair these exist for: one address, two accounts. A company seat and a
// personal subscription share an `accountUuid` and differ only by organisation,
// so every comparison here is on both uuids and never on the email.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  accountState,
  bindingFrom,
  boundElsewhere,
  describeBinding,
  restoreLogin,
  sameBinding,
  snapshotLogin,
} from "../src/profiles/binding.js";
import { tempHome } from "./helpers.js";

const seat = { accountUuid: "acct-1", organizationUuid: "org-acme", email: "me@x.y", organization: "Acme" };
const personal = { ...seat, organizationUuid: "org-personal", organization: "me@x.y's Organization" };

describe("naming an account", () => {
  it("needs both uuids, because one of them cannot tell two plans apart", () => {
    assert.deepEqual(bindingFrom({ ...seat }), seat);
    assert.equal(bindingFrom({ accountUuid: "acct-1", email: "me@x.y" }), null);
    assert.equal(bindingFrom({ organizationUuid: "org-acme" }), null);
    assert.equal(bindingFrom(null), null);
  });

  it("calls a seat and a personal plan on one address two accounts", () => {
    assert.equal(sameBinding(seat, personal), false);
    assert.equal(sameBinding(seat, { ...seat, organization: "renamed since" }), true, "labels are decoration");
    assert.equal(sameBinding(seat, null), false);
  });

  it("reads a personal organisation as personal, and falls back to the uuid", () => {
    assert.equal(describeBinding(seat), "me@x.y · Acme");
    assert.equal(describeBinding(personal), "me@x.y · personal");
    assert.equal(describeBinding({ ...seat, email: null }), "account acct-1");
  });
});

describe("a profile against its binding", () => {
  it("separates never bound, matching, drifted and unknowable", () => {
    assert.equal(accountState({ account: null }, seat).state, "unbound");
    assert.equal(accountState({ account: seat }, seat).state, "matches");
    assert.equal(accountState({ account: seat }, personal).state, "drifted");
    // Signed out, or a config file that says nothing. Never read as drifted:
    // that would send somebody re-signing in over a file they cannot see.
    assert.equal(accountState({ account: seat }, null).state, "unknown");
  });

  it("finds the profile that already means an account, bound or merely signed in", () => {
    const others = [
      { name: "work", account: seat, identity: null },
      { name: "spare", account: null, identity: personal },
    ];
    assert.equal(boundElsewhere(others, seat), "work");
    assert.equal(boundElsewhere(others, personal), "spare", "a signed-in profile owns that account too");
    assert.equal(boundElsewhere(others, { ...seat, organizationUuid: "org-third" }), null);
    assert.equal(boundElsewhere(others, null), null);
  });
});

describe("undoing a sign-in", () => {
  const record = (dir) => ({ name: "work", dir });

  async function profileDir(home, { credentials = null, identity = null } = {}) {
    const dir = join(home.dir, "profile");
    await mkdir(dir, { recursive: true });
    if (credentials) await writeFile(join(dir, ".credentials.json"), credentials);
    if (identity) await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: identity }));
    return dir;
  }

  // On a machine with no Keychain the login is a file, and a file is perfectly
  // restorable. Judging that by whether `security` would answer declined every
  // rollback on Linux, which is where this was caught.
  it("restores a login that lives in a file, where there is no Keychain", async () => {
    const home = await tempHome();
    try {
      const dir = await profileDir(home, { credentials: '{"claudeAiOauth":{"accessToken":"first"}}', identity: seat });
      const snapshot = await snapshotLogin(record(dir), { platform: "linux" });
      assert.equal(snapshot.where, "file");
      assert.equal(snapshot.restorable, true);
      assert.equal(snapshot.hasKeychain, false);

      // What a sign-in onto the wrong account leaves behind.
      await writeFile(join(dir, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"second"}}');
      await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: personal }));

      assert.equal(await restoreLogin(record(dir), snapshot, {}), true);
      assert.match(await readFile(join(dir, ".credentials.json"), "utf8"), /first/u);
      const back = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")).oauthAccount;
      assert.equal(back.organizationUuid, "org-acme");
    } finally {
      await home.cleanup();
    }
  });

  it("removes a credential file that was not there before, so a refusal leaves nothing behind", async () => {
    const home = await tempHome();
    try {
      const dir = await profileDir(home);
      const snapshot = await snapshotLogin(record(dir), { platform: "linux" });
      assert.equal(snapshot.where, "none");
      assert.equal(snapshot.restorable, true, "a profile that was signed out can be put back to signed out");

      await writeFile(join(dir, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"new"}}');
      assert.equal(await restoreLogin(record(dir), snapshot, {}), true);
      await assert.rejects(readFile(join(dir, ".credentials.json"), "utf8"), { code: "ENOENT" });
    } finally {
      await home.cleanup();
    }
  });

  it("promises no rollback when the Keychain would not answer", async () => {
    const home = await tempHome();
    try {
      const dir = await profileDir(home, { identity: seat });
      // A Keychain that refuses looks exactly like an item that is not there,
      // so "unknown" is the one answer that has to decline.
      const refusing = async () => ({ code: 1, stdout: "", stderr: "User interaction is not allowed." });
      const snapshot = await snapshotLogin(record(dir), { platform: "darwin", security: refusing });
      assert.equal(snapshot.restorable, false);
      assert.equal(await restoreLogin(record(dir), snapshot, {}), false, "nothing is half-restored");
    } finally {
      await home.cleanup();
    }
  });
});
