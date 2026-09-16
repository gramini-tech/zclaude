import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  claudeConfigDir,
  claudeSettingsPaths,
  conflictsIn,
  describeConflicts,
  settingsConflicts,
} from "../src/claude-settings.js";
import { tempHome } from "./helpers.js";

describe("claude settings tiers", () => {
  it("reads the child's config directory, not the parent's", () => {
    assert.equal(claudeConfigDir({ HOME: "/home/x" }), "/home/x/.claude");
    assert.equal(claudeConfigDir({ HOME: "/home/x", CLAUDE_CONFIG_DIR: "/p/home" }), "/p/home");
  });

  it("orders user, project, local and managed", () => {
    const paths = claudeSettingsPaths({ env: { HOME: "/home/x" }, cwd: "/work/repo", platform: "darwin" });
    assert.deepEqual(
      paths.map((entry) => entry.tier),
      ["user", "project", "local", "managed"],
    );
    assert.equal(paths[1].path, "/work/repo/.claude/settings.json");
    assert.equal(paths[2].path, "/work/repo/.claude/settings.local.json");
  });

  it("finds conflicts in every tier and names the file a reader would open", async () => {
    const home = await tempHome();
    try {
      const configDir = join(home.dir, "profile-home");
      const cwd = join(home.dir, "repo");
      await mkdir(configDir, { recursive: true });
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(configDir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://elsewhere.example" } }),
      );
      await writeFile(
        join(cwd, ".claude", "settings.local.json"),
        JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-opus-4" } }),
      );
      const childEnv = {
        HOME: home.dir,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_MODEL: "glm-5.3",
      };
      const found = await settingsConflicts({ childEnv, cwd, platform: "linux" });
      assert.deepEqual(
        found.map((entry) => entry.tier),
        ["user", "local"],
      );
      const lines = describeConflicts(found);
      assert.match(lines[0], /ANTHROPIC_BASE_URL: settings\.json has https:\/\/elsewhere\.example/u);
      assert.match(lines[1], /ANTHROPIC_MODEL: settings\.local\.json has claude-opus-4/u);
    } finally {
      await home.cleanup();
    }
  });

  it("treats model aliases and identical values as agreement, and a bare API key as a conflict", () => {
    const childEnv = { CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.3-flash", ANTHROPIC_MODEL: "glm-5.3" };
    assert.deepEqual(conflictsIn({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" }, childEnv), []);
    assert.deepEqual(conflictsIn({ ANTHROPIC_MODEL: "glm-5.3" }, childEnv), []);
    assert.deepEqual(conflictsIn({ ANTHROPIC_MODEL: "opus" }, childEnv), [
      { key: "ANTHROPIC_MODEL", theirs: "opus", ours: "glm-5.3" },
    ]);
    const [apiKey] = conflictsIn({ ANTHROPIC_API_KEY: "sk-ant-123456789" }, childEnv);
    assert.equal(apiKey.key, "ANTHROPIC_API_KEY");
    assert.doesNotMatch(apiKey.theirs, /123456789/u, "a key in someone's settings is never echoed in full");
  });

  it("flags a settings file that would move a profile's config directory", () => {
    const found = conflictsIn({ CLAUDE_CONFIG_DIR: "/elsewhere" }, { CLAUDE_CONFIG_DIR: "/p/home" });
    assert.deepEqual(found, [{ key: "CLAUDE_CONFIG_DIR", theirs: "/elsewhere", ours: "/p/home" }]);
  });
});
