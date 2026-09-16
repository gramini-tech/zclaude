// Creating, preparing and deleting a profile. The point of these tests is the
// boundary: everything a profile does happens inside its own directory, and the
// default Claude Code installation comes out byte for byte identical.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { describeShare, parseShare } from "../src/profile-commands.js";
import { createProfile, defaultConfigDir, deleteProfile, prepareLaunch } from "../src/profiles/launch.js";
import { getRegistered } from "../src/profiles/registry.js";
import { tempHome } from "./helpers.js";

/** Every file under a directory, with a hash, so a test can prove nothing moved. */
async function snapshot(dir) {
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

async function setup() {
  const home = await tempHome();
  const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude") };
  const claudeDir = join(home.dir, ".claude");
  await mkdir(join(claudeDir, "agents"), { recursive: true });
  await mkdir(join(claudeDir, "projects", "repo"), { recursive: true });
  await writeFile(join(claudeDir, "agents", "reviewer.md"), "agent\n");
  await writeFile(join(claudeDir, "history.jsonl"), '{"display":"hi"}\n');
  await writeFile(join(claudeDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "opus" }, theme: "x" }));
  await writeFile(
    join(claudeDir, ".claude.json"),
    JSON.stringify({
      theme: "dark",
      oauthAccount: { emailAddress: "me@x.y" },
      mcpServers: { linear: { command: "npx", env: { LINEAR_KEY: "secret" } } },
      projects: { "/work/repo": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } },
    }),
  );
  return { home, env, claudeDir };
}

describe("profile lifecycle", () => {
  it("creates a profile inside its own root and leaves the default installation untouched", async () => {
    const { home, env, claudeDir } = await setup();
    try {
      const before = await snapshot(claudeDir);
      const { record } = await createProfile({ name: "work", provider: "anthropic", env, platform: "linux" });
      assert.equal(record.dir, join(env.ZCLAUDE_HOME, "profiles", "work", "home"));
      assert.deepEqual(await snapshot(claudeDir), before, "creating a profile writes nothing into ~/.claude");

      const seeded = JSON.parse(await readFile(join(record.dir, ".claude.json"), "utf8"));
      assert.equal(seeded.theme, "dark");
      assert.equal(seeded.oauthAccount, undefined);
      assert.equal(seeded.mcpServers, undefined, "MCP servers carry secrets and are opt-in");
      assert.equal(seeded.projects, undefined, "tool permissions are never inherited");
      assert.equal((await stat(join(record.dir, ".claude.json"))).mode & 0o777, 0o600);

      assert.equal(await readFile(join(record.dir, "agents", "reviewer.md"), "utf8"), "agent\n");
      assert.equal(await readFile(join(record.dir, "history.jsonl"), "utf8"), '{"display":"hi"}\n');
    } finally {
      await home.cleanup();
    }
  });

  it("copies MCP servers and trust only when asked", async () => {
    const { home, env } = await setup();
    try {
      const { record } = await createProfile({
        name: "full",
        provider: "anthropic",
        mcp: true,
        trust: true,
        env,
        platform: "linux",
      });
      const seeded = JSON.parse(await readFile(join(record.dir, ".claude.json"), "utf8"));
      assert.equal(seeded.mcpServers.linear.env.LINEAR_KEY, "secret");
      assert.deepEqual(seeded.projects, { "/work/repo": { hasTrustDialogAccepted: true } });
      assert.equal(seeded.projects["/work/repo"].allowedTools, undefined);
    } finally {
      await home.cleanup();
    }
  });

  it("passes filtered settings to claude and keeps a Z.ai profile's models", async () => {
    const { home, env } = await setup();
    try {
      const { record } = await createProfile({ name: "glm", provider: "zai", env, platform: "linux" });
      const prepared = await prepareLaunch(record, env);
      assert.deepEqual(prepared.claudeArgs[0], "--settings");
      const shared = JSON.parse(await readFile(prepared.claudeArgs[1], "utf8"));
      assert.equal(shared.theme, "x");
      assert.equal(shared.env, undefined, "ANTHROPIC_MODEL would override the GLM models zclaude selects");
      assert.ok(prepared.removedSettings.includes("ANTHROPIC_MODEL"));
      assert.deepEqual(prepared.detached, []);
    } finally {
      await home.cleanup();
    }
  });

  it("shares nothing when asked for nothing", async () => {
    const { home, env } = await setup();
    try {
      const { record } = await createProfile({
        name: "clean",
        provider: "anthropic",
        share: { config: false, history: false },
        env,
        platform: "linux",
      });
      const prepared = await prepareLaunch(record, env);
      assert.deepEqual(prepared.claudeArgs, []);
      assert.deepEqual(await readdir(record.dir), [".claude.json"]);
    } finally {
      await home.cleanup();
    }
  });

  it("reports a share that a write detached", async () => {
    const { home, env } = await setup();
    try {
      const { record } = await createProfile({ name: "work", provider: "anthropic", env, platform: "linux" });
      await rm(join(record.dir, "history.jsonl"));
      await writeFile(join(record.dir, "history.jsonl"), "local\n");
      const prepared = await prepareLaunch(record, env);
      assert.deepEqual(prepared.detached, ["history.jsonl"]);
      assert.ok(prepared.occupied.includes("history.jsonl"), "a real file is never replaced by a link");
      assert.equal(await readFile(join(record.dir, "history.jsonl"), "utf8"), "local\n");
    } finally {
      await home.cleanup();
    }
  });

  it("says so when a launch has to recreate a directory that vanished", async () => {
    const { home, env } = await setup();
    try {
      const { record } = await createProfile({ name: "work", provider: "anthropic", env, platform: "linux" });
      assert.equal((await prepareLaunch(record, env)).recreated, false);
      await rm(record.dir, { recursive: true, force: true });
      const prepared = await prepareLaunch(record, env);
      assert.equal(prepared.recreated, true);
      assert.equal((await stat(prepared.configDir)).isDirectory(), true, "the launch still works");
    } finally {
      await home.cleanup();
    }
  });

  it("deleting a profile removes its directory and registry entry, never what it pointed at", async () => {
    const { home, env, claudeDir } = await setup();
    try {
      const { record } = await createProfile({ name: "work", provider: "anthropic", env, platform: "linux" });
      const before = await snapshot(claudeDir);
      await deleteProfile(record.name, env);
      assert.equal(await getRegistered("work", env), null);
      await assert.rejects(stat(record.dir));
      assert.deepEqual(await snapshot(claudeDir), before, "the shared originals survive");
    } finally {
      await home.cleanup();
    }
  });

  it("refuses a name that would escape the profiles directory", async () => {
    const { home, env } = await setup();
    try {
      await assert.rejects(
        createProfile({ name: "../escape", provider: "anthropic", env, platform: "linux" }),
        /not a valid profile name|reserved/u,
      );
      await assert.rejects(createProfile({ name: "zai", provider: "zai", env, platform: "linux" }), /reserved/u);
    } finally {
      await home.cleanup();
    }
  });

  it("follows CLAUDE_CONFIG_DIR when deciding what to seed from", async () => {
    const { home, env } = await setup();
    try {
      assert.equal(defaultConfigDir(env), join(home.dir, ".claude"));
      assert.equal(defaultConfigDir({ ...env, CLAUDE_CONFIG_DIR: "/custom/dir/" }), "/custom/dir");
    } finally {
      await home.cleanup();
    }
  });
});

describe("sharing options", () => {
  it("accepts the four documented answers and nothing else", () => {
    assert.deepEqual(parseShare("all"), { config: true, history: true });
    assert.deepEqual(parseShare("Config"), { config: true, history: false });
    assert.deepEqual(parseShare(" history "), { config: false, history: true });
    assert.deepEqual(parseShare("none"), { config: false, history: false });
    assert.equal(parseShare(undefined), null, "no flag means ask, not a default");
    assert.throws(() => parseShare("some"), /does not accept/u);
  });

  it("describes what a profile shares in words a list can print", () => {
    assert.equal(describeShare({ config: true, history: true }), "config + history");
    assert.equal(describeShare({ config: false, history: false }), "nothing");
    assert.equal(describeShare(undefined), "nothing");
  });
});
