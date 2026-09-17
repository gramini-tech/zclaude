// The `zclaude profile` command group, called in process so the error and
// cancellation paths are exercised as well as the happy ones. Terminal output
// is captured rather than printed, and the Z.ai sign-in is injected.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { cmdProfile, exportLines, forgetAllProfiles } from "../src/profile-commands.js";
import { getRegistered, listRegistered } from "../src/profiles/registry.js";
import { loadCredential, saveCredential } from "../src/store.js";
import { tempHome } from "./helpers.js";

/** Run a command with the terminal captured. Returns { out, err, value }. */
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
    const value = await run();
    return { ...chunks, value };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
}

/** Fails the assertion if the command succeeds; returns the error otherwise. */
async function rejects(run) {
  try {
    await capture(run);
  } catch (error) {
    return error;
  }
  throw new Error("expected the command to fail");
}

describe("profile commands", () => {
  let home;
  let env;
  let claudeCalls;
  const zaiCalls = [];
  const zaiLogin = async (context) => {
    zaiCalls.push(context);
    return { apiKey: "0123456789abcdef0123.ABCDEFGHIJKLMNOPQRSTUV", location: "memory" };
  };

  /** @param {string[]} args @param {object} [options] */
  const profile = (args, { interactive = false, ...options } = {}) =>
    capture(() => cmdProfile({ options: { args, ...options }, env, cwd: home.dir }, { zaiLogin, interactive }));

  beforeEach(async () => {
    home = await tempHome();
    claudeCalls = join(home.dir, "claude-calls.txt");
    const bin = join(home.dir, "claude");
    // Stands in for claude: records how it was called, and on a successful
    // `auth login` leaves behind what a real sign-in would leave in the
    // profile's directory.
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "fake-claude 9.9.9"; exit 0; fi',
        `echo "$* | $CLAUDE_CONFIG_DIR" >> "${claudeCalls}"`,
        'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
        '  if [ -n "$ZC_LOGIN_FAILS" ]; then exit 4; fi',
        '  ORG="${ZC_ORG:-Acme}"',
        '  if [ "$ORG" = "personal" ]; then ORG="me@x.y\'s Organization"; fi',
        `  printf '{"oauthAccount":{"emailAddress":"me@x.y","organizationName":"%s"}}' "$ORG" > "$CLAUDE_CONFIG_DIR/.claude.json"`,
        `  printf '{"token":"t"}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`,
        "fi",
        'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
        `  printf '{"loggedIn":true,"email":"me@x.y","subscriptionType":"max"}'`,
        "fi",
        "exit 0",
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    env = {
      HOME: home.dir,
      PATH: "",
      ZCLAUDE_HOME: join(home.dir, ".zclaude"),
      ZCLAUDE_NO_KEYCHAIN: "1",
      ZCLAUDE_CLAUDE_BIN: bin,
      NO_COLOR: "1",
    };
    await mkdir(join(home.dir, ".claude", "agents"), { recursive: true });
    await writeFile(join(home.dir, ".claude", "agents", "reviewer.md"), "agent\n");
    await writeFile(join(home.dir, ".claude", "history.jsonl"), "{}\n");
    zaiCalls.length = 0;
  });
  afterEach(() => home.cleanup());

  const addWork = () => profile(["add", "work"], { provider: "anthropic", share: "all" });

  it("insists on a subcommand it knows", async () => {
    assert.match((await rejects(() => profile([]))).message, /needs a subcommand/u);
    const unknown = await rejects(() => profile(["frobnicate"]));
    assert.match(unknown.message, /is not a command/u);
    assert.match(unknown.hint, /doctor/u, "the hint lists what is available");
  });

  it("says which profiles exist when the name is wrong, and how to make one when none do", async () => {
    const empty = await rejects(() => profile(["show", "nope"]));
    assert.match(empty.hint, /Create one with/u);
    await addWork();
    const wrong = await rejects(() => profile(["show", "nope"]));
    assert.match(wrong.message, /There is no profile named "nope"/u);
    assert.match(wrong.hint, /work/u);
    for (const command of ["login", "logout", "remove", "env", "shell"]) {
      assert.match((await rejects(() => profile([command, "nope"]))).message, /no profile named/u);
    }
    assert.match((await rejects(() => profile(["show"]))).message, /Which profile\?/u);
  });

  it("will not guess a profile's provider without a terminal", async () => {
    assert.match((await rejects(() => profile(["add"]))).message, /needs both a name and a provider/u);
    assert.match((await rejects(() => profile(["add", "work"]))).message, /needs both a name and a provider/u);
    assert.deepEqual(await listRegistered(env), [], "a refused creation leaves nothing behind");
  });

  it("creates a profile, lists it and shows the detail", async () => {
    const created = await addWork();
    assert.match(created.err, /Created profile "work"/u);
    assert.match(created.err, /Sign in later with `zclaude profile login work`/u);

    const listed = await profile(["list"], { json: true });
    const [record] = JSON.parse(listed.out);
    assert.equal(record.name, "work");
    assert.equal(record.provider, "anthropic");
    assert.equal(record.signedIn, false);
    assert.deepEqual(record.share, { config: true, history: true });

    const text = await profile(["list"]);
    assert.match(text.out, /work\s+anthropic\s+signed out\s+shares config \+ history/u);

    const shown = await profile(["show", "work"], { json: true });
    const detail = JSON.parse(shown.out);
    assert.match(detail.credentialService, /^Claude Code-credentials-[\da-f]{8}$/u);
    assert.equal(detail.zaiKey, null, "an Anthropic profile has no Z.ai key");
    assert.deepEqual(detail.detachedShares, []);

    const readable = await profile(["show", "work"]);
    assert.match(readable.out, /config dir\s+\S+profiles\/work\/home/u);
    assert.match(readable.out, /credential\s+none/u);
  });

  it("reports an empty list as an invitation rather than an error", async () => {
    const empty = await profile(["list"]);
    assert.match(empty.err, /No profiles yet/u);
    assert.equal(JSON.parse((await profile(["list"], { json: true })).out).length, 0);
  });

  it("refuses a duplicate name and a reserved one", async () => {
    await addWork();
    assert.match((await rejects(() => addWork())).message, /A profile named "work" already exists/u);
    assert.match((await rejects(() => profile(["add", "zai"], { provider: "zai" }))).message, /"zai" is reserved/u);
    assert.match(
      (await rejects(() => profile(["add", "work"], { provider: "martian" }))).message,
      /--provider does not accept/u,
    );
    assert.match(
      (await rejects(() => profile(["add", "other"], { provider: "zai", share: "some" }))).message,
      /--share does not accept/u,
    );
    assert.equal((await listRegistered(env)).length, 1);
  });

  it("signs an Anthropic profile in through claude itself, scoped to its directory", async () => {
    await addWork();
    const result = await profile(["login", "work"], { sso: true, email: "me@x.y" });
    assert.equal(result.value, 0);
    const record = await getRegistered("work", env);
    const [call] = (await readFile(claudeCalls, "utf8")).trim().split("\n", 1);
    assert.equal(call, `auth login --sso --email me@x.y | ${record.dir}`);
  });

  it("reports a sign-in that claude refused, with its exit code", async () => {
    await addWork();
    env.ZC_LOGIN_FAILS = "1";
    const result = await profile(["login", "work"]);
    assert.equal(result.value, 4);
    assert.match(result.err, /exited with 4/u);
    assert.match(result.err, /zclaude profile login work/u, "it says how to try again");
    assert.equal(JSON.parse((await profile(["list"], { json: true })).out)[0].signedIn, false);
  });

  it("shows the account after a sign-in, from the profile's own files and from claude", async () => {
    await addWork();
    const signedIn = await profile(["login", "work"]);
    assert.match(signedIn.err, /"work" is signed in as me@x\.y/u);

    const listed = JSON.parse((await profile(["list"], { json: true })).out)[0];
    assert.equal(listed.signedIn, true);
    assert.equal(listed.identity.email, "me@x.y");

    assert.equal(listed.account, "me@x.y · Acme", "the organization is part of the account, not a detail");

    const shown = await profile(["show", "work"]);
    assert.match(shown.out, /signed in as\s+me@x\.y/u);
    assert.match(shown.out, /organization\s+Acme/u);
    assert.match(shown.out, /claude auth\s+me@x\.y \(max\)/u);

    const doctor = await profile(["doctor"]);
    assert.match(doctor.err, /credentials are in a plaintext file/u);
  });

  // Two profiles can hold one login and still be two accounts to bill: a
  // company seat and a personal subscription on the same email.
  it("tells two profiles on the same login apart by their organization", async () => {
    await addWork();
    await profile(["add", "personal"], { provider: "anthropic", share: "none" });
    await profile(["login", "work"]);
    env.ZC_ORG = "personal";
    await profile(["login", "personal"]);

    const rows = JSON.parse((await profile(["list"], { json: true })).out);
    const accounts = Object.fromEntries(rows.map((row) => [row.name, row.account]));
    assert.equal(accounts.work, "me@x.y · Acme");
    assert.equal(accounts.personal, "me@x.y · personal", "a personal organization reads as personal");
    assert.notEqual(accounts.work, accounts.personal);

    const printed = await profile(["list"]);
    assert.match(printed.out, /work\s+anthropic me@x\.y · Acme\s+shares/u);
    assert.match(printed.out, /personal\s+anthropic me@x\.y · personal\s+shares/u);
  });

  it("starts a subshell with the profile pinned and says when you leave it", async () => {
    await addWork();
    const shellCalls = join(home.dir, "shell-calls.txt");
    const fakeShell = join(home.dir, "shell.sh");
    await writeFile(
      fakeShell,
      ["#!/bin/sh", `echo "$CLAUDE_CONFIG_DIR/$ZCLAUDE_PROFILE" > "${shellCalls}"`].join("\n"),
    );
    await chmod(fakeShell, 0o755);
    env.SHELL = fakeShell;
    const result = await profile(["shell", "work"], { interactive: true });
    assert.equal(result.value, 0);
    const record = await getRegistered("work", env);
    assert.equal((await readFile(shellCalls, "utf8")).trim(), `${record.dir}/work`);
    assert.match(result.err, /Launching `code \.` here would move the VS Code extension/u);
    assert.match(result.err, /Left the "work" shell/u);
  });

  it("signs a Z.ai profile in through the browser flow, under its own name", async () => {
    await profile(["add", "glm"], { provider: "zai", share: "none" });
    const result = await profile(["login", "glm"], { interactive: true });
    assert.equal(result.value, 0);
    assert.deepEqual(
      zaiCalls.map((call) => call.profile),
      ["glm"],
    );
    assert.match((await rejects(() => profile(["login", "glm"]))).message, /needs an interactive terminal/u);
  });

  it("logs a Z.ai profile out and says when there was nothing to remove", async () => {
    await profile(["add", "glm"], { provider: "zai" });
    const result = await profile(["logout", "glm"]);
    assert.equal(result.value, 0);
    assert.match(result.err, /"glm" had no stored Z\.ai key/u);
    assert.match(result.err, /revoke it at/iu, "the key on the Z.ai account outlives the local copy");
  });

  it("logs an Anthropic profile out through claude, leaving the others alone", async () => {
    await addWork();
    const result = await profile(["logout", "work"]);
    assert.equal(result.value, 0);
    const record = await getRegistered("work", env);
    assert.equal((await readFile(claudeCalls, "utf8")).trim(), `auth logout | ${record.dir}`);
    assert.match(result.err, /your default login are untouched/u);
  });

  it("needs --yes to remove a profile without a terminal, then removes everything", async () => {
    await addWork();
    assert.match((await rejects(() => profile(["remove", "work"]))).message, /needs --yes/u);
    assert.ok(await getRegistered("work", env), "the refusal changed nothing");

    const record = await getRegistered("work", env);
    const removed = await profile(["remove", "work"], { yes: true });
    assert.equal(removed.value, 0);
    assert.equal(await getRegistered("work", env), null);
    await assert.rejects(stat(record.dir));
    assert.equal(await readFile(join(home.dir, ".claude", "agents", "reviewer.md"), "utf8"), "agent\n");
  });

  it("prints exports with the warning on stderr, and refuses a subshell without a terminal", async () => {
    await addWork();
    const printed = await profile(["env", "work"]);
    assert.match(printed.out, /^export CLAUDE_CONFIG_DIR="[^"]+profiles\/work\/home"$/mu);
    assert.match(printed.out, /^export ZCLAUDE_PROFILE="work"$/mu);
    assert.match(printed.err, /# .*inherits the profile, including editors/u);
    assert.doesNotMatch(printed.out, /#/u, "only the exports go to stdout, so eval is safe");
    assert.match((await rejects(() => profile(["shell", "work"]))).message, /needs an interactive terminal/u);
  });

  it("writes the lines the shell in front of the user can actually evaluate", () => {
    const values = { CLAUDE_CONFIG_DIR: "/p/home", ZCLAUDE_PROFILE: "work" };
    assert.deepEqual(exportLines(values, { platform: "darwin", shell: "/bin/zsh" }), [
      'export CLAUDE_CONFIG_DIR="/p/home"',
      'export ZCLAUDE_PROFILE="work"',
    ]);
    assert.deepEqual(exportLines(values, { platform: "win32", shell: "" }), [
      '$env:CLAUDE_CONFIG_DIR = "/p/home"',
      '$env:ZCLAUDE_PROFILE = "work"',
    ]);
    assert.deepEqual(
      exportLines({ ZCLAUDE_PROFILE: "work" }, { platform: "win32", shell: "C:\\Program Files\\Git\\bin\\bash.exe" }),
      ['export ZCLAUDE_PROFILE="work"'],
      "a POSIX shell on Windows still wants export",
    );
  });

  it("doctor is quiet when everything is in order", async () => {
    await addWork();
    const result = await profile(["doctor"]);
    assert.equal(result.value, 0);
    assert.match(result.err, /Checked 1 profile\. Nothing looks wrong\./u);
  });

  it("doctor reports a pinned shell, inherited credentials and a Z.ai profile with no key", async () => {
    await profile(["add", "glm"], { provider: "zai" });
    env.CLAUDE_CONFIG_DIR = "/somewhere/else";
    env.ANTHROPIC_API_KEY = "sk-ant-inherited";
    const result = await profile(["doctor"]);
    assert.match(result.err, /This shell exports CLAUDE_CONFIG_DIR=\/somewhere\/else/u);
    assert.match(result.err, /default Claude Code login is unreachable/u);
    assert.match(result.err, /ANTHROPIC_API_KEY is set in this shell/u);
    assert.match(result.err, /glm: no Z\.ai key stored/u);
  });

  // The built-in entry used to adopt a profile's Z.ai key, which showed one
  // plan's usage under two names. The lookup no longer does that; a copy it
  // already made is what this reports.
  it("doctor spots the built-in Z.ai entry holding a profile's key", async () => {
    await profile(["add", "glm"], { provider: "zai" });
    const key = "0123456789abcdef0123.ABCDEFGHIJKLMNOPQRSTUV";
    await saveCredential({ apiKey: key, email: "me@x.y" }, { env, profile: "glm" });
    const quiet = await profile(["doctor"]);
    assert.doesNotMatch(quiet.err, /same key/u, "a profile with its own key is nobody's business");

    await saveCredential({ apiKey: key, email: "me@x.y" }, { env });
    const result = await profile(["doctor"]);
    assert.match(result.err, /built-in Z\.ai entry holds the same key as the "glm" profile/u);
    assert.match(result.err, /`zclaude logout` removes the built-in copy and leaves "glm" alone/u);
  });

  it("doctor says nothing when the built-in key is a different plan", async () => {
    await profile(["add", "glm"], { provider: "zai" });
    await saveCredential(
      { apiKey: "0123456789abcdef0123.ABCDEFGHIJKLMNOPQRSTUV", email: "one@x.y" },
      { env, profile: "glm" },
    );
    await saveCredential({ apiKey: "fedcba9876543210fedc.VUTSRQPONMLKJIHGFEDCBA", email: "two@x.y" }, { env });
    const result = await profile(["doctor"]);
    assert.doesNotMatch(result.err, /same key/u);
  });

  it("doctor reports a deleted directory without trying to repair it", async () => {
    await addWork();
    const record = await getRegistered("work", env);
    await rm(record.dir, { recursive: true, force: true });
    const result = await profile(["doctor"]);
    assert.match(result.err, /is gone/u);
    assert.match(result.err, /An empty directory at the same path would reuse the old credential/u);
    assert.ok(await getRegistered("work", env), "the profile is reported, never silently dropped");
  });

  it("doctor spots a detached share, and --fix relinks it once the local copy is gone", async () => {
    await addWork();
    const record = await getRegistered("work", env);
    const shared = join(record.dir, "history.jsonl");
    await rm(shared);
    await writeFile(shared, "local copy\n");

    const found = await profile(["doctor"]);
    assert.match(found.err, /history\.jsonl stopped being shared/u);
    const blocked = await profile(["doctor"], { fix: true });
    assert.match(blocked.err, /history\.jsonl hold local copies/u);
    assert.equal(await readFile(shared, "utf8"), "local copy\n", "--fix never destroys the local copy");

    await rm(shared);
    const fixed = await profile(["doctor"], { fix: true });
    assert.match(fixed.err, /Relinked/u);
    assert.equal((await stat(shared)).isFile(), true);
    assert.match((await profile(["doctor"])).err, /Nothing looks wrong/u);
  });

  // What `zclaude self-uninstall` calls: the profile directories go with
  // ~/.zclaude, but the credentials live outside it.
  it("forgets every profile's credentials when zclaude is being removed", async () => {
    await addWork();
    await profile(["add", "glm"], { provider: "zai" });
    await saveCredential(
      { apiKey: "0123456789abcdef0123.ABCDEFGHIJKLMNOPQRSTUV", email: "z@x.y" },
      { env, platform: "linux", profile: "glm" },
    );
    assert.ok(await loadCredential({ env, platform: "linux", profile: "glm" }));

    const result = await forgetAllProfiles(env, { platform: "linux" });
    assert.deepEqual(result.profiles, ["glm", "work"]);
    assert.deepEqual(result.forgotten, ["glm (Z.ai key)"]);
    assert.equal(await loadCredential({ env, platform: "linux", profile: "glm" }), null);
  });

  it("warns when a launch has to recreate a directory that was deleted", async () => {
    await addWork();
    const record = await getRegistered("work", env);
    await rm(record.dir, { recursive: true, force: true });
    const result = await profile(["env", "work"]);
    assert.match(result.err, /its directory was missing and has been recreated/u);
    assert.match(result.err, /an earlier login for it may still apply/u);
  });

  it("treats a corrupt registry as no profiles rather than failing the command", async () => {
    await addWork();
    await writeFile(join(env.ZCLAUDE_HOME, "profiles.json"), "{not json");
    const result = await profile(["list"]);
    assert.match(result.err, /is not valid JSON/u);
    assert.match(result.err, /No profiles yet/u);
  });

  it("creates a usable profile on a machine with no Claude Code setup at all", async () => {
    await rm(join(home.dir, ".claude"), { recursive: true, force: true });
    const created = await profile(["add", "fresh"], { provider: "anthropic", share: "all" });
    assert.match(created.err, /Created profile "fresh"/u);
    assert.doesNotMatch(created.err, /error|failed/iu, "nothing to share is not a problem");
    const record = await getRegistered("fresh", env);
    const seeded = JSON.parse(await readFile(join(record.dir, ".claude.json"), "utf8"));
    assert.equal(seeded.hasCompletedOnboarding, true);
  });

  it("leaves an existing file in place rather than turning it into a share", async () => {
    await addWork();
    const record = await getRegistered("work", env);
    await rm(join(record.dir, "agents"), { recursive: true, force: true });
    await mkdir(join(record.dir, "agents"), { recursive: true });
    await writeFile(join(record.dir, "agents", "own.md"), "mine\n");
    const result = await profile(["show", "work"], { json: true });
    assert.deepEqual(JSON.parse(result.out).detachedShares, ["agents"]);
    assert.equal(await readFile(join(record.dir, "agents", "own.md"), "utf8"), "mine\n");
  });

  it("keeps a share pointing at the original when the link is already correct", async () => {
    await addWork();
    const record = await getRegistered("work", env);
    await writeFile(join(home.dir, ".claude", "agents", "second.md"), "later\n");
    await profile(["doctor"], { fix: true });
    assert.equal(await readFile(join(record.dir, "agents", "second.md"), "utf8"), "later\n");
  });

  it("replaces a share that points somewhere else", async () => {
    await addWork();
    const record = await getRegistered("work", env);
    const link = join(record.dir, "agents");
    await rm(link);
    await symlink(join(home.dir, "elsewhere"), link);
    await profile(["doctor"], { fix: true });
    assert.equal(await readFile(join(link, "reviewer.md"), "utf8"), "agent\n");
  });
});
