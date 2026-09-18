// End-to-end: run the real bin/zclaude.js as a child process (non-TTY) against
// a fake Z.ai server and a fake claude, and check what claude receives.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { tempHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/zclaude.js", import.meta.url));
const GOOD_KEY = "0123456789abcdef0123.ABCDEFGHIJKLMNOPQRSTUV";

function startFakeZai() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization ?? null });
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/api/coding/paas/v4/models") {
      if (request.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(401, { error: { message: "bad key" } });
      return send(200, { object: "list", data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }, { id: "glm-5.2" }] });
    }
    if (request.url === "/api/monitor/usage/quota/limit") {
      return send(200, { code: 200, data: { level: "pro", limits: [{ type: "TOKENS_LIMIT", percentage: 42 }] } });
    }
    return send(404, { code: 404, msg: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

/**
 * The contents of ~/.claude that zclaude is responsible for. Claude Code
 * writes .device-keys.json in the home directory whatever CLAUDE_CONFIG_DIR
 * says, so it is excluded by name rather than by weakening the comparison.
 */
function listing(entries) {
  return entries.filter((name) => name !== ".device-keys.json").toSorted((x, y) => x.localeCompare(y));
}

function run(args, env, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

describe("end to end", () => {
  let home;
  let zai;
  let fakeClaude;
  let captureFile;
  let env;

  before(async () => {
    home = await tempHome();
    zai = await startFakeZai();
    const binDir = join(home.dir, "bin");
    await mkdir(binDir, { recursive: true });
    fakeClaude = join(binDir, "claude");
    captureFile = join(home.dir, "capture.json");
    await writeFile(
      fakeClaude,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "fake-claude 9.9.9"; exit 0; fi',
        // The real claude writes this file in the home directory whatever
        // CLAUDE_CONFIG_DIR says, so the fake one does too: the boundary
        // assertions have to hold against what actually happens.
        'mkdir -p "$HOME/.claude" && printf "{}" > "$HOME/.claude/.device-keys.json"',
        `node -e 'require("fs").writeFileSync(process.env.ZC_CAPTURE, JSON.stringify({ argv: process.argv.slice(1), env: process.env }))' -- "$@"`,
        'exit "${ZC_EXIT:-0}"',
      ].join("\n"),
    );
    await chmod(fakeClaude, 0o755);
    env = {
      PATH: process.env.PATH,
      HOME: home.dir,
      ZCLAUDE_HOME: join(home.dir, ".zclaude"),
      ZCLAUDE_NO_KEYCHAIN: "1",
      ZCLAUDE_CLAUDE_BIN: fakeClaude,
      ZCLAUDE_BASE_URL: zai.base,
      ZC_CAPTURE: captureFile,
      NO_COLOR: "1",
    };
  });
  after(async () => {
    zai.server.close();
    await home.cleanup();
  });

  const capture = async () => JSON.parse(await readFile(captureFile, "utf8"));

  it("launches claude on Z.ai with the documented environment and passes arguments through", async () => {
    const result = await run(["--profile", "zai", "-p", "hello world"], {
      ...env,
      ZAI_API_KEY: GOOD_KEY,
      ANTHROPIC_API_KEY: "sk-ant-should-vanish",
    });
    assert.equal(result.code, 0, result.stderr);
    const got = await capture();
    assert.deepEqual(got.argv, ["-p", "hello world"]);
    assert.equal(got.env.ANTHROPIC_AUTH_TOKEN, GOOD_KEY);
    assert.equal(got.env.ANTHROPIC_BASE_URL, `${zai.base}/api/anthropic`);
    assert.equal(got.env.ANTHROPIC_MODEL, "glm-5.3[1m]");
    assert.equal(got.env.CLAUDE_CODE_SUBAGENT_MODEL, "glm-5.3-flash[1m]");
    assert.equal(got.env.ANTHROPIC_API_KEY, undefined);
    assert.match(result.stderr, /Z\.ai GLM Coding Plan \(pro\) .* tokens 42%/u);
    assert.match(result.stderr, /Launching claude on glm-5\.3/u);
    assert.doesNotMatch(result.stderr, new RegExp(GOOD_KEY, "u"), "key never printed");
  });

  it("writes a redacted run log that a post-mortem can read back", async () => {
    const result = await run(["--profile", "zai", "-p", "logged"], {
      ...env,
      ZAI_API_KEY: GOOD_KEY,
      ZCLAUDE_LOG_LEVEL: "trace",
    });
    assert.equal(result.code, 0, result.stderr);
    const shown = await run(["log"], env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /run started/u);
    assert.match(shown.stdout, /credential resolved.*"source":"env"/u);
    assert.match(shown.stdout, /spawning claude/u);
    assert.match(shown.stdout, /claude exited.*"code":0/u);
    assert.match(shown.stdout, /http +response.*"status":200/u);
    assert.doesNotMatch(shown.stdout, new RegExp(GOOD_KEY, "u"), "key never logged");
    const json = await run(["log", "--json"], env);
    const entries = JSON.parse(json.stdout);
    assert.equal(entries[0].msg, "run started");
    assert.deepEqual(entries[0].argv, ["--profile", "zai", "-p", "logged"]);
    assert.ok(
      entries.some((entry) => entry.cat === "http" && entry.msg === "request"),
      "trace level captured requests",
    );
    const pathOnly = await run(["log", "--path"], env);
    assert.match(pathOnly.stdout.trim(), /zclaude-\d{8}-\d{6}-\d{3}-\d+\.log$/u);
    const failed = await run(["--profile", "zai"], { ...env, ZAI_API_KEY: "0123456789abcdef0123.badbadbadbadbadbad" });
    assert.match(failed.stderr, /Run log: .*zclaude-.*\.log/u);
    const quiet = await run(["--profile", "zai", "--quiet"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.equal(quiet.code, 0);
    assert.doesNotMatch(quiet.stderr, /Launching claude/u);
    const none = await run(["--profile", "zai", "--no-log"], {
      ...env,
      ZAI_API_KEY: GOOD_KEY,
      ZCLAUDE_LOG_DIR: join(home.dir, "nologs"),
    });
    assert.equal(none.code, 0);
    assert.equal((await run(["log"], { ...env, ZCLAUDE_LOG_DIR: join(home.dir, "nologs") })).code, 2);
  });

  it("never modifies Claude Code's own config files; everything reaches claude through the environment", async () => {
    const claudeDir = join(home.dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const settings = join(claudeDir, "settings.json");
    const legacy = join(home.dir, ".claude.json");
    const settingsText = JSON.stringify(
      { model: "opus", env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", ANTHROPIC_BASE_URL: "https://elsewhere.example" } },
      null,
      2,
    );
    const legacyText = JSON.stringify({ hasCompletedOnboarding: true, mcpServers: {} });
    await writeFile(settings, settingsText);
    await writeFile(legacy, legacyText);
    const before = listing(await readdir(claudeDir));
    const refused = await run(["--profile", "zai", "-p", "untouched"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.equal(refused.code, 2, "a conflicting env block stops a non-interactive launch");
    assert.match(refused.stderr, /ANTHROPIC_BASE_URL: settings\.json has https:\/\/elsewhere\.example/u);
    assert.match(refused.stderr, /never edits Claude Code's files/u);
    assert.doesNotMatch(refused.stderr, /CLAUDE_CODE_SUBAGENT_MODEL/u, "the sonnet alias is not a conflict");
    const result = await run(["--profile", "zai", "-p", "untouched"], {
      ...env,
      ZAI_API_KEY: GOOD_KEY,
      ZCLAUDE_ALLOW_SETTINGS_OVERRIDE: "1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Continuing because ZCLAUDE_ALLOW_SETTINGS_OVERRIDE/u);
    assert.equal(await readFile(settings, "utf8"), settingsText);
    assert.equal(await readFile(legacy, "utf8"), legacyText);
    assert.deepEqual(listing(await readdir(claudeDir)), before);
    const got = await capture();
    assert.equal(got.env.ANTHROPIC_BASE_URL, `${zai.base}/api/anthropic`, "override travels in the environment");
    await writeFile(
      settings,
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: `${zai.base}/api/anthropic`, CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      }),
    );
    const matching = await run(["--profile", "zai", "-p", "same"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.equal(matching.code, 0, "identical values and aliases are not conflicts");
    await rm(claudeDir, { recursive: true, force: true });
    await rm(legacy, { force: true });
  });

  it("propagates claude's exit code", async () => {
    const result = await run(["--profile", "zai"], { ...env, ZAI_API_KEY: GOOD_KEY, ZC_EXIT: "7" });
    assert.equal(result.code, 7);
  });

  it("launches the plain profile untouched and forwards --model", async () => {
    const result = await run(["--profile", "claude", "--model", "opus", "-p", "x"], {
      ...env,
      ANTHROPIC_API_KEY: "keep",
    });
    assert.equal(result.code, 0, result.stderr);
    const got = await capture();
    assert.deepEqual(got.argv, ["--model", "opus", "-p", "x"]);
    assert.equal(got.env.CLAUDE_CONFIG_DIR, undefined, "the default profile must never set a config directory");
    assert.equal(got.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(got.env.ANTHROPIC_API_KEY, "keep");
    assert.ok(zai.requests.some((r) => r.url.includes("models")));
  });

  it("uses project config over user config and forwards passthrough env lines", async () => {
    const cwd = join(home.dir, "project");
    await mkdir(join(cwd, ".zclaude"), { recursive: true });
    await writeFile(
      join(cwd, ".zclaude", "env"),
      "ZCLAUDE_MODEL=glm-5.2\nZCLAUDE_PROFILE=zai\nMY_EXTRA=from-project\n",
    );
    await mkdir(env.ZCLAUDE_HOME, { recursive: true });
    await writeFile(
      join(env.ZCLAUDE_HOME, "settings"),
      "ZCLAUDE_MODEL=glm-5.3\nZCLAUDE_FAST_MODEL=glm-5.3-flash\nMY_EXTRA=from-user\nONLY_USER=1\n",
    );
    const result = await run([], { ...env, ZAI_API_KEY: GOOD_KEY }, { cwd });
    assert.equal(result.code, 0, result.stderr);
    const got = await capture();
    assert.equal(got.env.ANTHROPIC_MODEL, "glm-5.2[1m]");
    assert.equal(got.env.MY_EXTRA, "from-project");
    assert.equal(got.env.ONLY_USER, "1");
  });

  it("a profile named by a committed config file that does not exist here asks instead of failing", async () => {
    const cwd = join(home.dir, "teammate");
    await mkdir(join(cwd, ".zclaude"), { recursive: true });
    await writeFile(join(cwd, ".zclaude", "env"), "ZCLAUDE_PROFILE=their-profile\n");
    const result = await run([], env, { cwd });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /names the profile "their-profile", which does not exist here/u);
    assert.match(result.stderr, /No profile selected and no terminal to ask/u, "with a terminal this is the menu");
    const flag = await run(["--profile", "their-profile"], env, { cwd });
    assert.match(flag.stderr, /Unknown profile "their-profile"/u, "an explicit flag is still an error");
  });

  it("exits 5 when ZAI_API_KEY is rejected and never launches claude", async () => {
    await writeFile(captureFile, "{}");
    const result = await run(["--profile", "zai"], { ...env, ZAI_API_KEY: "0123456789abcdef0123.badbadbadbadbadbad" });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /rejected ZAI_API_KEY \(HTTP 401: bad key\)/u);
    assert.equal(await readFile(captureFile, "utf8"), "{}");
  });

  it("warns but still launches when Z.ai is unreachable", async () => {
    const result = await run(["--profile", "zai"], {
      ...env,
      ZAI_API_KEY: GOOD_KEY,
      ZCLAUDE_BASE_URL: "http://127.0.0.1:1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Could not reach 127\.0\.0\.1:1/u);
    assert.match(result.stderr, /Skipping key validation/u);
  });

  it("exits 4 without a credential in a non-interactive session", async () => {
    const result = await run(["--profile", "zai"], env);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /No Z\.ai credential is available/u);
  });

  it("exits 2 for an unknown profile and 3 when claude is missing", async () => {
    assert.equal((await run(["--profile", "nope"], env)).code, 2);
    const missing = await run(["--profile", "zai"], { ...env, ZCLAUDE_CLAUDE_BIN: "/nonexistent/claude" });
    assert.equal(missing.code, 3);
    assert.match(missing.stderr, /claude\.ai\/install\.sh/u);
  });

  it("routes a custom ZCLAUDE_ZAI=1 profile through Z.ai with its env", async () => {
    const dir = join(env.ZCLAUDE_HOME, "profiles");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "team.env"), "# name: Team\nZCLAUDE_ZAI=1\nTEAM_TOKEN=abc\n");
    const result = await run(["--profile", "team"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.equal(result.code, 0, result.stderr);
    const got = await capture();
    assert.equal(got.env.TEAM_TOKEN, "abc");
    assert.equal(got.env.ANTHROPIC_AUTH_TOKEN, GOOD_KEY);
  });

  it("a named profile launches claude in its own config directory and leaves ~/.claude alone", async () => {
    const claudeDir = join(home.dir, ".claude");
    await mkdir(join(claudeDir, "agents"), { recursive: true });
    await writeFile(join(claudeDir, "agents", "reviewer.md"), "shared agent\n");
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-secret" } }));
    await writeFile(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ theme: "dark", oauthAccount: { emailAddress: "me@x.y" } }),
    );
    const before = listing(await readdir(claudeDir));

    const added = await run(["profile", "add", "work", "--provider", "anthropic", "--yes"], env);
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stderr, /Created profile "work"/u);

    const listed = await run(["profile", "list", "--json"], env);
    const [record] = JSON.parse(listed.stdout);
    assert.equal(record.name, "work");
    assert.equal(record.provider, "anthropic");
    assert.deepEqual(record.share, { config: true, history: true });
    assert.equal(record.signedIn, false, "a fresh profile is signed out, whatever the default login says");

    const launched = await run(["--profile", "work", "-p", "hi"], env);
    assert.equal(launched.code, 0, launched.stderr);
    const got = await capture();
    assert.equal(got.env.CLAUDE_CONFIG_DIR, join(env.ZCLAUDE_HOME, "profiles", "work", "home"));
    assert.equal(got.argv[0], "--settings", "shared settings arrive as a read-only tier");
    const shared = JSON.parse(await readFile(got.argv[1], "utf8"));
    assert.equal(shared.env, undefined, "the shared copy never carries authentication keys");
    assert.deepEqual(got.argv.slice(2), ["-p", "hi"]);

    const seeded = JSON.parse(await readFile(join(got.env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8"));
    assert.equal(seeded.theme, "dark");
    assert.equal(seeded.oauthAccount, undefined, "identity is never copied into a profile");
    assert.equal(
      await readFile(join(got.env.CLAUDE_CONFIG_DIR, "agents", "reviewer.md"), "utf8"),
      "shared agent\n",
      "shared directories are reachable from inside the profile",
    );

    const shown = await run(["profile", "show", "work", "--json"], env);
    const detail = JSON.parse(shown.stdout);
    assert.match(detail.credentialService, /^Claude Code-credentials-[\da-f]{8}$/u);

    const status = await run(["status", "--json"], env);
    const report = JSON.parse(status.stdout);
    assert.deepEqual(
      report.namedProfiles.map((profile) => profile.name),
      ["work"],
    );
    assert.equal(report.inheritedConfigDir, null);
    const statusText = await run(["status"], env);
    assert.match(statusText.stdout, /profiles\s+claude, zai, work/u);
    assert.match(statusText.stdout, /work anthropic · signed out · shares config \+ history/u);
    const pinned = await run(["status"], { ...env, CLAUDE_CONFIG_DIR: "/pinned/elsewhere" });
    assert.match(pinned.stdout, /config dir\s+\/pinned\/elsewhere .*inherited from this shell/u);

    const removed = await run(["profile", "remove", "work", "--yes"], env);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(JSON.parse((await run(["profile", "list", "--json"], env)).stdout).length, 0);
    assert.deepEqual(
      listing(await readdir(claudeDir)),
      before,
      "removing a profile leaves the default installation untouched",
    );
    assert.ok(
      (await readdir(claudeDir)).includes(".device-keys.json"),
      "claude writes its device key in the home directory whatever config directory it is given, which is why the assertions above exclude it and the README says so",
    );
    assert.equal(await readFile(join(claudeDir, "agents", "reviewer.md"), "utf8"), "shared agent\n");
    await rm(claudeDir, { recursive: true, force: true });
  });

  it("names a profile as the first argument, and leaves claude's own arguments alone", async () => {
    await run(["profile", "add", "work", "--provider", "anthropic", "--share", "none", "--yes"], env);
    const named = await run(["work", "-p", "hi"], env);
    assert.equal(named.code, 0, named.stderr);
    const got = await capture();
    assert.equal(got.env.CLAUDE_CONFIG_DIR, join(env.ZCLAUDE_HOME, "profiles", "work", "home"));
    assert.deepEqual(got.argv, ["-p", "hi"], "only the profile name is consumed");

    const builtin = await run(["claude", "-p", "plain"], env);
    assert.equal(builtin.code, 0, builtin.stderr);
    assert.equal((await capture()).env.CLAUDE_CONFIG_DIR, undefined, "the built-in name still means the default");

    // `mcp` is one of claude's commands, so it must reach claude untouched.
    // Without a terminal there is no menu, which is what exit 2 says here.
    const passthrough = await run(["mcp", "list"], env);
    assert.equal(passthrough.code, 2);
    assert.match(passthrough.stderr, /No profile selected and no terminal to ask/u);
    const explicit = await run(["--profile", "claude", "mcp", "list"], env);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.deepEqual((await capture()).argv, ["mcp", "list"]);

    assert.match(
      (await run(["profile", "add", "mcp", "--provider", "anthropic", "--yes"], env)).stderr,
      /"mcp" is reserved/u,
      "a profile can never shadow one of claude's commands",
    );
    assert.equal((await run(["profile", "remove", "work", "--yes"], env)).code, 0);
  });

  it("hands claude its own arguments, including the ones zclaude would otherwise claim", async () => {
    await run(["profile", "add", "args", "--provider", "anthropic", "--share", "none", "--yes"], env);

    const resumed = await run(["args", "--resume", "1b4f0e9a-session", "--fork-session"], env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual((await capture()).argv, ["--resume", "1b4f0e9a-session", "--fork-session"]);

    // The profile name ends zclaude's options: --verbose after it is claude's,
    // and --verbose before it is zclaude's.
    const afterward = await run(["args", "--verbose", "-p", "hi"], env);
    assert.equal(afterward.code, 0, afterward.stderr);
    assert.deepEqual((await capture()).argv, ["--verbose", "-p", "hi"]);

    const beforehand = await run(["--verbose", "args", "-p", "hi"], env);
    assert.equal(beforehand.code, 0, beforehand.stderr);
    assert.deepEqual((await capture()).argv, ["-p", "hi"]);
    assert.match(beforehand.stderr, /Profile: args/u, "zclaude took that one for itself");

    // --settings is claude's flag and repeatable; ours goes first so a shared
    // profile's copy is the one yours overrides. There has to be something to
    // share for that to happen at all.
    await mkdir(join(home.dir, ".claude"), { recursive: true });
    await writeFile(join(home.dir, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    const shared = await run(["profile", "add", "sharing", "--provider", "anthropic", "--yes"], env);
    assert.equal(shared.code, 0, shared.stderr);
    const own = await run(["sharing", "--settings", "/tmp/mine.json", "-p", "hi"], env);
    assert.equal(own.code, 0, own.stderr);
    const { argv } = await capture();
    assert.equal(argv[0], "--settings");
    assert.match(argv[1], /shared-settings\.json$/u);
    assert.deepEqual(argv.slice(2), ["--settings", "/tmp/mine.json", "-p", "hi"]);

    for (const name of ["args", "sharing"]) await run(["profile", "remove", name, "--yes"], env);
    await rm(join(home.dir, ".claude"), { recursive: true, force: true });
  });

  it("a Z.ai profile keeps its own key and ignores ZAI_API_KEY from the shell", async () => {
    const added = await run(["profile", "add", "glm", "--provider", "zai", "--share", "none", "--yes"], env);
    assert.equal(added.code, 0, added.stderr);
    const result = await run(["--profile", "glm", "-p", "x"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.equal(result.code, 4);
    assert.match(result.stderr, /ZAI_API_KEY is ignored for profile "glm"/u);
    assert.match(result.stderr, /Profile "glm" has no Z\.ai key stored/u);
    const doctor = await run(["profile", "doctor"], env);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stderr, /glm: no Z\.ai key stored/u);
    assert.equal((await run(["profile", "remove", "glm", "--yes"], env)).code, 0);
  });

  it("a Z.ai profile launches on its own key, its own directory and the shared settings", async () => {
    await run(["profile", "add", "glm", "--provider", "zai", "--share", "none", "--yes"], env);
    const root = join(env.ZCLAUDE_HOME, "profiles", "glm");
    // What an interactive `zclaude profile login glm` would leave behind on a
    // machine without a Keychain.
    await writeFile(
      join(root, "zai-credentials.json"),
      JSON.stringify({ version: 1, apiKey: GOOD_KEY, email: "glm@x.y", keyName: "zclaude" }),
      { mode: 0o600 },
    );
    await writeFile(join(root, "zai-profile.json"), JSON.stringify({ version: 1, email: "glm@x.y" }), { mode: 0o600 });

    const result = await run(["--profile", "glm", "-p", "hi"], { ...env, ZAI_API_KEY: "" });
    assert.equal(result.code, 0, result.stderr);
    const got = await capture();
    assert.equal(got.env.ANTHROPIC_AUTH_TOKEN, GOOD_KEY, "the profile's own key, not the shell's");
    assert.equal(got.env.ANTHROPIC_BASE_URL, `${zai.base}/api/anthropic`);
    assert.equal(got.env.CLAUDE_CONFIG_DIR, join(root, "home"));
    assert.equal(got.env.ANTHROPIC_MODEL, "glm-5.3[1m]");
    assert.deepEqual(got.argv, ["-p", "hi"], "sharing nothing means no --settings");
    assert.match(result.stderr, /Launching claude on glm-5\.3/u);

    const shown = JSON.parse((await run(["profile", "show", "glm", "--json"], env)).stdout);
    assert.equal(shown.zaiKey.source, "file");
    assert.equal(shown.zaiKey.email, "glm@x.y");
    assert.doesNotMatch(JSON.stringify(shown), new RegExp(GOOD_KEY, "u"), "the key is masked everywhere");

    const loggedOut = await run(["profile", "logout", "glm"], env);
    assert.match(loggedOut.stderr, /Removed the Z\.ai key for "glm"/u);
    assert.equal((await run(["--profile", "glm"], env)).code, 4, "no key, no launch");
    assert.equal((await run(["profile", "remove", "glm", "--yes"], env)).code, 0);
  });

  it("forgets a profile's stored key when Z.ai rejects it, and says a sign-in is needed", async () => {
    await run(["profile", "add", "stale", "--provider", "zai", "--share", "none", "--yes"], env);
    const credentials = join(env.ZCLAUDE_HOME, "profiles", "stale", "zai-credentials.json");
    await writeFile(
      credentials,
      JSON.stringify({ version: 1, apiKey: "0123456789abcdef0123.badbadbadbadbadbad", email: "old@x.y" }),
      { mode: 0o600 },
    );
    await writeFile(captureFile, "{}");
    const result = await run(["--profile", "stale", "-p", "x"], env);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /The stored Z\.ai key for "stale" was rejected \(HTTP 401/u);
    assert.match(result.stderr, /Run `zclaude profile login stale` interactively/u, "the hint names the profile");
    await assert.rejects(readFile(credentials), /ENOENT/u, "a rejected key is not kept");
    assert.equal(await readFile(captureFile, "utf8"), "{}", "claude never started");
    assert.equal((await run(["profile", "remove", "stale", "--yes"], env)).code, 0);
  });

  it("status --json, models and logout work non-interactively", async () => {
    const status = await run(["status", "--json"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.equal(status.code, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.credential.source, "env");
    assert.equal(report.credential.status, "valid");
    assert.equal(report.credential.key, "****STUV");
    assert.equal(report.quota.level, "pro");
    assert.equal(report.claude.version, "fake-claude 9.9.9");
    assert.deepEqual(report.profiles.slice(0, 2), ["claude", "zai"]);

    const models = await run(["models"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.equal(models.code, 0, models.stderr);
    assert.match(models.stdout, /^glm-5\.3\s+1M context$/mu);

    const text = await run(["status"], { ...env, ZAI_API_KEY: GOOD_KEY });
    assert.match(text.stdout, /credential {2}env \*{4}STUV/u);

    const logout = await run(["logout"], env);
    assert.equal(logout.code, 0);
    assert.match(logout.stderr, /No stored Z\.ai credential/u);
    const noKey = await run(["models"], env);
    assert.equal(noKey.code, 4);
  });

  it("self-install installs globally and verifies the command really runs", async () => {
    const fakeBin = join(home.dir, "npm-good");
    const prefixBin = join(fakeBin, "prefix", "bin");
    await mkdir(prefixBin, { recursive: true });
    const npmCapture = join(home.dir, "npm-args.txt");
    // A stand-in npm: "view" fails (not published), "prefix" reports our
    // scratch prefix, and "install" drops a working command into it.
    await writeFile(
      join(fakeBin, "npm"),
      [
        "#!/bin/sh",
        'if [ "$1" = "view" ]; then exit 1; fi',
        `if [ "$1" = "prefix" ]; then echo "${join(fakeBin, "prefix")}"; exit 0; fi`,
        `echo "$*" >> "${npmCapture}"`,
        `printf '#!/bin/sh\\necho "zclaude 9.9.9"\\n' > "${join(prefixBin, "zclaude")}"`,
        `chmod +x "${join(prefixBin, "zclaude")}"`,
        "exit 0",
      ].join("\n"),
    );
    await chmod(join(fakeBin, "npm"), 0o755);
    const result = await run(["self-install"], { ...env, PATH: `${fakeBin}:${prefixBin}:${process.env.PATH}` });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      (await readFile(npmCapture, "utf8")).trim(),
      "install -g https://codeload.github.com/gramini-tech/zclaude/tar.gz/refs/heads/main",
      "installs from the tarball, not the git spec npm cannot prepare",
    );
    assert.match(result.stderr, /zclaude 9\.9\.9 installed/u);
    assert.match(result.stderr, /Run `zclaude` from any directory/u);
  });

  it("prints help and versions", async () => {
    const help = await run(["--help"], env);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^zclaude \d+\.\d+\.\d+/u);
    const version = await run(["--version"], env);
    assert.match(version.stdout, /claude fake-claude 9\.9\.9/u);
  });
});
