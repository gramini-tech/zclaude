import assert from "node:assert/strict";
import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildProfileEnv, buildPlainEnv, buildZaiEnv, overridingAuthVars } from "../src/claude.js";
import { zaiConfig } from "../src/config.js";
import { buildSeed, mcpServersWithSecrets, SEED_ALLOWLIST, trustedProjects, writeSeed } from "../src/profiles/seed.js";
import {
  detachedShares,
  filterSettings,
  HISTORY_ITEMS,
  linkShares,
  materialiseSharedSettings,
  SHARED_DIRS,
  SHARED_FILES,
} from "../src/profiles/share.js";
import { tempHome } from "./helpers.js";

describe("child environment", () => {
  it("gives a profile its config directory, canonicalised and unoverridable", () => {
    const env = buildProfileEnv({
      baseEnv: { PATH: "/bin", CLAUDE_CONFIG_DIR: "/somewhere/else" },
      configDir: "/tmp/profiles/work/home/",
      extra: { CLAUDE_CONFIG_DIR: "/hijack", FOO: "1" },
    });
    assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/profiles/work/home");
    assert.equal(env.FOO, "1");
    assert.equal(env.PATH, "/bin");
  });

  it("removes variables that would repoint the credential store", () => {
    const env = buildProfileEnv({
      baseEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/x", ANTHROPIC_CONFIG_DIR: "/y", ANTHROPIC_PROFILE: "z" },
      configDir: "/tmp/p/home",
    });
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(env.ANTHROPIC_CONFIG_DIR, undefined);
    assert.equal(env.ANTHROPIC_PROFILE, undefined);
  });

  it("never sets a config directory for the default profile", () => {
    const env = buildPlainEnv({ baseEnv: { PATH: "/bin" }, extra: { FOO: "1" } });
    assert.equal(Object.hasOwn(env, "CLAUDE_CONFIG_DIR"), false);
  });

  it("adds a config directory to a Z.ai launch only when one is given", () => {
    const models = { primary: "glm-5.3", subagent: "glm-5.3-flash", fast: "glm-5.3-flash" };
    const base = { baseEnv: {}, apiKey: "k", config: zaiConfig({}), models };
    assert.equal(Object.hasOwn(buildZaiEnv(base), "CLAUDE_CONFIG_DIR"), false);
    assert.equal(buildZaiEnv({ ...base, configDir: "/tmp/z/home/" }).CLAUDE_CONFIG_DIR, "/tmp/z/home");
  });

  it("reports variables that would override a subscription login", () => {
    assert.deepEqual(overridingAuthVars({ ANTHROPIC_API_KEY: "sk", PATH: "/bin" }), ["ANTHROPIC_API_KEY"]);
    assert.deepEqual(overridingAuthVars({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assert.deepEqual(overridingAuthVars({ ANTHROPIC_API_KEY: "  " }), []);
    assert.deepEqual(overridingAuthVars({}), []);
  });
});

describe("seeding a profile", () => {
  const source = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.273",
    theme: "light",
    installMethod: "native",
    autoUpdates: true,
    oauthAccount: { emailAddress: "someone@company.com", organizationName: "Acme" },
    userID: "abc123",
    numStartups: 412,
    migrationVersion: 7,
    s1mAccessCache: { allowed: true },
    modelAccessCache: { opus: true },
    overageCreditGrantCache: { credits: 5 },
    githubRepoPaths: ["/work/secret-repo"],
    toolUsage: { Bash: 10 },
    mcpServers: { plain: { command: "x" }, withSecret: { command: "y", env: { API_KEY: "shh" } } },
    projects: {
      "/work/a": { hasTrustDialogAccepted: true, allowedTools: ["Bash(rm:*)"], mcpServers: { local: {} } },
      "/work/b": { hasTrustDialogAccepted: false },
    },
  };

  it("copies preferences and nothing else", () => {
    const seed = buildSeed(source);
    assert.deepEqual(
      Object.keys(seed).toSorted((a, b) => a.localeCompare(b)),
      ["autoUpdates", "hasCompletedOnboarding", "installMethod", "lastOnboardingVersion", "theme"],
    );
    for (const leak of [
      "oauthAccount",
      "userID",
      "numStartups",
      "migrationVersion",
      "s1mAccessCache",
      "modelAccessCache",
      "overageCreditGrantCache",
      "githubRepoPaths",
      "toolUsage",
      "mcpServers",
      "projects",
    ]) {
      assert.equal(Object.hasOwn(seed, leak), false, `${leak} must not be copied`);
    }
  });

  it("always marks onboarding complete, even when the source has not", () => {
    assert.equal(buildSeed({}).hasCompletedOnboarding, true);
    assert.equal(buildSeed({ hasCompletedOnboarding: false }).hasCompletedOnboarding, true);
  });

  it("copies MCP servers only when asked, and names the ones carrying secrets", () => {
    assert.equal(Object.hasOwn(buildSeed(source), "mcpServers"), false);
    const withMcp = buildSeed(source, { mcp: true });
    assert.deepEqual(Object.keys(withMcp.mcpServers), ["plain", "withSecret"]);
    assert.deepEqual(mcpServersWithSecrets(source.mcpServers), ["withSecret"]);
    assert.deepEqual(mcpServersWithSecrets(undefined), []);
  });

  it("copies trust only for already-trusted paths, and only that flag", () => {
    assert.deepEqual(trustedProjects(source), ["/work/a"]);
    const withTrust = buildSeed(source, { trust: true });
    assert.deepEqual(withTrust.projects, { "/work/a": { hasTrustDialogAccepted: true } });
    assert.equal(Object.hasOwn(buildSeed({ projects: {} }, { trust: true }), "projects"), false);
  });

  it("writes the seed 0600 as readable JSON", async () => {
    const home = await tempHome();
    try {
      const dir = join(home.dir, "home");
      const path = await writeSeed(dir, buildSeed(source));
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(JSON.parse(await readFile(path, "utf8")).theme, "light");
    } finally {
      await home.cleanup();
    }
  });

  it("keeps the allowlist small and explicit", () => {
    assert.ok(SEED_ALLOWLIST.length <= 8, "a growing allowlist is how identity leaks in");
  });
});

describe("shared settings filter", () => {
  const settings = {
    model: "opus",
    enabledPlugins: { "acme@1": true },
    permissions: { allow: ["Bash"] },
    env: {
      BASH_DEFAULT_TIMEOUT_MS: "600000",
      CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
      ANTHROPIC_MODEL: "opus",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://proxy.internal",
      CLAUDE_CONFIG_DIR: "/somewhere",
    },
  };

  it("strips credentials and endpoints for every provider", () => {
    const { settings: filtered } = filterSettings(settings, { provider: "anthropic" });
    assert.equal(filtered.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(filtered.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(filtered.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(filtered.env.BASH_DEFAULT_TIMEOUT_MS, "600000", "unrelated settings survive");
    assert.deepEqual(filtered.permissions, settings.permissions);
  });

  it("keeps model preferences for an Anthropic profile", () => {
    const { settings: filtered } = filterSettings(settings, { provider: "anthropic" });
    assert.equal(filtered.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
    assert.equal(filtered.model, "opus");
  });

  it("strips model settings for a Z.ai profile, which would otherwise beat the GLM models", () => {
    const { settings: filtered, removed } = filterSettings(settings, { provider: "zai" });
    assert.equal(filtered.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(filtered.env.ANTHROPIC_MODEL, undefined);
    assert.equal(filtered.model, undefined);
    assert.ok(removed.includes("ANTHROPIC_MODEL"));
    assert.ok(removed.includes("model"));
  });

  it("drops plugin enablement, since plugin installs are per profile", () => {
    const { settings: filtered } = filterSettings(settings, { provider: "anthropic" });
    assert.equal(filtered.enabledPlugins, undefined);
  });

  it("removes an env block that becomes empty, and copes with odd input", () => {
    const { settings: filtered } = filterSettings({ env: { ANTHROPIC_API_KEY: "x" } }, { provider: "anthropic" });
    assert.equal(Object.hasOwn(filtered, "env"), false);
    assert.deepEqual(filterSettings(null, { provider: "zai" }).settings, {});
  });
});

describe("share materialisation", () => {
  let home;
  let defaultDir;
  before(async () => {
    home = await tempHome();
    defaultDir = join(home.dir, ".claude");
    await mkdir(defaultDir, { recursive: true });
  });
  after(() => home.cleanup());

  it("writes a filtered copy and leaves it alone when nothing changed", async () => {
    const profileRootDir = join(home.dir, "profiles", "work");
    assert.equal(await materialiseSharedSettings({ defaultDir, profileRootDir, provider: "zai" }), null);
    await writeFile(join(defaultDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "opus", X: "1" } }));
    const first = await materialiseSharedSettings({ defaultDir, profileRootDir, provider: "zai" });
    assert.equal(JSON.parse(await readFile(first.path, "utf8")).env.ANTHROPIC_MODEL, undefined);
    const before = (await stat(first.path)).mtimeMs;
    const second = await materialiseSharedSettings({ defaultDir, profileRootDir, provider: "zai" });
    assert.equal((await stat(second.path)).mtimeMs, before, "unchanged source must not rewrite the copy");
  });

  it("ignores a settings file that is not valid JSON", async () => {
    const profileRootDir = join(home.dir, "profiles", "broken");
    await writeFile(join(defaultDir, "settings.json"), "{oops");
    assert.equal(await materialiseSharedSettings({ defaultDir, profileRootDir, provider: "anthropic" }), null);
    await writeFile(join(defaultDir, "settings.json"), JSON.stringify({ env: {} }));
  });

  it("links what exists, skips what does not, and refuses to clobber a real file", async () => {
    const configDir = join(home.dir, "profiles", "work", "home");
    await mkdir(join(defaultDir, "skills"), { recursive: true });
    await mkdir(join(defaultDir, "commands"), { recursive: true });
    await mkdir(join(defaultDir, "projects"), { recursive: true });
    await writeFile(join(defaultDir, "CLAUDE.md"), "shared memory\n");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "commands"), "a real file in the way\n");

    const result = await linkShares({ defaultDir, configDir, share: { config: true, history: true } });
    assert.ok(result.linked.includes("skills"));
    assert.ok(result.linked.includes("CLAUDE.md"));
    assert.ok(result.linked.includes("projects"));
    assert.ok(result.occupied.includes("commands"));
    assert.ok(result.absent.includes("themes"));
    assert.equal((await lstat(join(configDir, "skills"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(configDir, "CLAUDE.md"), "utf8"), "shared memory\n");
  });

  it("links only history when config sharing is off", async () => {
    const configDir = join(home.dir, "profiles", "hist", "home");
    const result = await linkShares({ defaultDir, configDir, share: { config: false, history: true } });
    assert.deepEqual(result.linked, ["projects"]);
    assert.ok(result.absent.includes("history.jsonl"));
    for (const dir of SHARED_DIRS) assert.equal(result.linked.includes(dir), false);
  });

  it("spots a share that an atomic write turned back into a real file", async () => {
    const configDir = join(home.dir, "profiles", "detached", "home");
    await mkdir(configDir, { recursive: true });
    await symlink(join(defaultDir, "skills"), join(configDir, "skills"));
    await writeFile(join(configDir, "CLAUDE.md"), "no longer shared\n");
    const detached = await detachedShares({ configDir, share: { config: true, history: false } });
    assert.deepEqual(detached, ["CLAUDE.md"]);
    assert.deepEqual(await detachedShares({ configDir, share: { config: false, history: false } }), []);
    assert.deepEqual(HISTORY_ITEMS, ["projects", "history.jsonl"]);
    // Credentials, .claude.json, plugins and caches are never in either list.
    assert.deepEqual(SHARED_FILES, ["CLAUDE.md"]);
    for (const item of [...SHARED_DIRS, ...SHARED_FILES, ...HISTORY_ITEMS]) {
      assert.doesNotMatch(item, /credential|\.claude\.json|plugins|statsig|sessions/u);
    }
  });
});
