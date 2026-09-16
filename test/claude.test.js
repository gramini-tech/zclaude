import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildPlainEnv, buildZaiEnv, exitCodeForSignal, findClaude, runClaude } from "../src/claude.js";
import { zaiConfig } from "../src/config.js";
import { tempHome } from "./helpers.js";

describe("buildZaiEnv", () => {
  const config = zaiConfig({});
  const models = { primary: "glm-5.3", subagent: "glm-5.3-flash", fast: "glm-4.7" };
  it("sets the Z.ai variables, strips ANTHROPIC_API_KEY and applies [1m] where known", () => {
    const env = buildZaiEnv({
      baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant", KEEP: "1" },
      apiKey: "id.secret",
      config,
      models,
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.KEEP, "1");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "id.secret");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(env.ANTHROPIC_MODEL, "glm-5.3[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.3-flash[1m]");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "glm-5.3-flash[1m]");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-4.7");
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1048576");
    assert.equal(env.API_TIMEOUT_MS, "3000000");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  });
  it("lets extra env override defaults but never the credential or models", () => {
    const env = buildZaiEnv({
      baseEnv: {},
      apiKey: "k",
      config,
      models,
      extra: { API_TIMEOUT_MS: "5", ANTHROPIC_AUTH_TOKEN: "hijack", ANTHROPIC_MODEL: "nope", FOO: 1 },
    });
    assert.equal(env.API_TIMEOUT_MS, "5");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "k");
    assert.equal(env.ANTHROPIC_MODEL, "glm-5.3[1m]");
    assert.equal(env.FOO, "1");
  });
  it("keeps an explicit [1m] suffix and unknown ids untouched", () => {
    const env = buildZaiEnv({
      baseEnv: {},
      apiKey: "k",
      config,
      models: { primary: "custom-x[1m]", subagent: "mystery", fast: "mystery" },
    });
    assert.equal(env.ANTHROPIC_MODEL, "custom-x[1m]");
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "mystery");
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  });
  it("buildPlainEnv only layers extra values", () => {
    assert.deepEqual(buildPlainEnv({ baseEnv: { A: "1" }, extra: { B: 2 } }), { A: "1", B: "2" });
  });
});

describe("findClaude and runClaude", () => {
  let home;
  let fakeBin;
  let log;
  before(async () => {
    home = await tempHome();
    const dir = join(home.dir, "bin");
    await mkdir(dir, { recursive: true });
    fakeBin = join(dir, "claude");
    // runClaude inherits stdio, and under the test runner that is the runner's
    // own stream: a child writing to stdout there corrupts its protocol (Node
    // 20 reports "Unable to deserialize cloned data"). So the child records
    // what it saw in a file, which is what the assertions read anyway.
    log = join(home.dir, "ran.txt");
    await writeFile(
      fakeBin,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo fake 1.0; exit 0; fi',
        `printf '%s' "$ZC_TEST_VAR" > "${log}"`,
        'exit "${1:-0}"',
      ].join("\n"),
    );
    await chmod(fakeBin, 0o755);
  });
  after(() => home.cleanup());

  it("finds claude on PATH, honours the override, returns null otherwise", () => {
    assert.equal(
      findClaude({ env: { PATH: `/nonexistent:${join(home.dir, "bin")}` }, platform: "linux", home: home.dir }),
      fakeBin,
    );
    assert.equal(
      findClaude({ env: { PATH: "", ZCLAUDE_CLAUDE_BIN: fakeBin }, platform: "linux", home: "/nowhere" }),
      fakeBin,
    );
    assert.equal(
      findClaude({ env: { PATH: "", ZCLAUDE_CLAUDE_BIN: "/missing/claude" }, platform: "linux", home: "/nowhere" }),
      null,
    );
    assert.equal(findClaude({ env: { PATH: "/nonexistent" }, platform: "linux", home: "/nowhere" }), null);
  });
  it("falls back to ~/.local/bin", async () => {
    const local = join(home.dir, ".local", "bin");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "claude"), "#!/bin/sh\n");
    await chmod(join(local, "claude"), 0o755);
    assert.equal(findClaude({ env: { PATH: "" }, platform: "linux", home: home.dir }), join(local, "claude"));
  });
  it("propagates the child's exit code and environment", async () => {
    assert.equal(
      await runClaude(fakeBin, ["7"], { PATH: "/usr/bin:/bin", ZC_TEST_VAR: "x" }, { platform: "linux" }),
      7,
    );
    assert.equal(await readFile(log, "utf8"), "x", "the environment reached the child");
    assert.equal(await runClaude(fakeBin, [], { PATH: "/usr/bin:/bin" }, { platform: "linux" }), 0);
    assert.equal(await readFile(log, "utf8"), "", "and nothing of ours leaks into it");
  });
  it("maps signals to 128+n", () => {
    assert.equal(exitCodeForSignal("SIGINT"), 130);
    assert.equal(exitCodeForSignal("SIGTERM"), 143);
    assert.equal(exitCodeForSignal("SIGNOPE"), 1);
  });
});
