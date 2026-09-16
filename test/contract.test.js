// Guardrails for the pieces that must not drift silently: the Z.ai protocol
// constants, the environment handed to claude, the exit-code table, and the
// documentation of every flag and variable.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildPlainEnv, buildProfileEnv, buildZaiEnv } from "../src/claude.js";
import { HELP } from "../src/cli.js";
import { PROFILE_SUBCOMMANDS } from "../src/profile-commands.js";
import { CALLBACK_SCHEME, CONSOLE_KEYS_URL, DEFAULT_MODELS, MODEL_CONTEXT_WINDOWS, zaiConfig } from "../src/config.js";
import { EXIT } from "../src/errors.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("protocol contract", () => {
  it("pins the Z.ai endpoints and the ZCode client id", () => {
    assert.deepEqual(zaiConfig({}), {
      clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
      authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
      tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
      redirectUri: "zcode://zai-auth/callback",
      apiBase: "https://api.z.ai",
      bizLoginUrl: "https://api.z.ai/api/auth/z/login",
      anthropicBase: "https://api.z.ai/api/anthropic",
      modelsUrl: "https://api.z.ai/api/coding/paas/v4/models",
      quotaUrl: "https://api.z.ai/api/monitor/usage/quota/limit",
      keyName: "zclaude",
    });
    assert.equal(CALLBACK_SCHEME, "zcode");
    assert.equal(CONSOLE_KEYS_URL, "https://z.ai/manage-apikey/apikey-list");
  });

  it("pins the default models and known context windows", () => {
    assert.deepEqual(DEFAULT_MODELS, { primary: "glm-5.3", subagent: "glm-5.3-flash", fast: "glm-5.3-flash" });
    for (const id of Object.values(DEFAULT_MODELS))
      assert.ok(Object.hasOwn(MODEL_CONTEXT_WINDOWS, id), `${id} has a known context window`);
  });

  it("pins the exit-code table", () => {
    assert.deepEqual(EXIT, {
      OK: 0,
      INTERNAL: 1,
      USAGE: 2,
      NO_CLAUDE: 3,
      AUTH: 4,
      KEY_REJECTED: 5,
      NETWORK: 6,
      INTERRUPTED: 130,
    });
  });

  it("hands claude exactly the documented variables", () => {
    const env = buildZaiEnv({
      baseEnv: {},
      apiKey: "k",
      config: zaiConfig({}),
      models: DEFAULT_MODELS,
    });
    assert.deepEqual(
      Object.keys(env).toSorted((a, b) => a.localeCompare(b)),
      [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_MODEL",
        "API_TIMEOUT_MS",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ],
    );
  });
});

describe("installer contract", () => {
  it("declares no npm lifecycle scripts that run on install", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    // npm runs these when the package is installed. With one present, a
    // `github:` install needs a "prepare" step; when npm refuses to run
    // scripts it links its cache clone instead, leaving a dangling command.
    for (const name of ["preinstall", "install", "postinstall", "prepare", "prepack", "prepublish"]) {
      assert.equal(pkg.scripts[name], undefined, `package.json must not define a "${name}" script`);
    }
  });

  it("the short-URL copy (install) matches install.sh byte for byte", async () => {
    const [long, short] = await Promise.all([
      readFile(join(root, "install.sh"), "utf8"),
      readFile(join(root, "install"), "utf8"),
    ]);
    assert.equal(short, long, "run: cp install.sh install");
  });
});

describe("claude config boundary", () => {
  it("source never writes to Claude Code's own files; the only .claude references are reads", async () => {
    const dir = join(root, "src");
    const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".js"));
    const writers =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|truncate|copyFile|mkdir|mkdirSync)\s*\(/u;
    const allowedMentions = new Map([
      ["claude.js", /join\(home, "\.claude", "local"/u],
      // Reading Claude Code's settings tiers, never writing them.
      [
        "claude-settings.js",
        /join\((env\.HOME \|\| homedir\(\), "\.claude"\)|cwd, "\.claude", "settings(\.local)?\.json"\))/u,
      ],
      ["profiles/launch.js", /join\(env\.HOME \|\| homedir\(\), "\.claude"\)/u],
      // Profiles read the default installation's config file to seed a new
      // profile, and write only the copy inside that profile's own directory.
      // profile-share.test.js proves the write side stays inside the profile.
      ["profiles/seed.js", /join\(canonicalConfigDir\((defaultDir|configDir)\), "\.claude\.json"\)/u],
      ["profiles/probe.js", /join\(canonicalConfigDir\(configDir\), "\.claude\.json"\)/u],
    ]);
    const checkLine = (file, index, line) => {
      const where = `${file}:${index + 1}`;
      if (writers.test(line))
        assert.doesNotMatch(line, /\.claude(?!\/env)\b|claude\.json/u, `${where} writes near a Claude path`);
      const mentionsClaudePath = /"\.claude"|\.claude\.json|\.claude\//u.test(line) && !line.includes(".zclaude");
      if (!mentionsClaudePath) return;
      const allowed = allowedMentions.get(file);
      assert.ok(
        allowed && allowed.test(line),
        `${where} mentions a Claude config path outside the read-only allowlist`,
      );
    };
    for (const file of files) {
      const lines = (await readFile(join(dir, file), "utf8")).split("\n");
      for (const [index, line] of lines.entries()) checkLine(file, index, line);
    }
  });
});

describe("documentation contract", () => {
  it("every flag parsed by the CLI is described in --help and the README", async () => {
    const cli = await readFile(join(root, "src", "cli.js"), "utf8");
    const readme = await readFile(join(root, "README.md"), "utf8");
    const flags = new Set(cli.match(/"--[a-z-]+"/gu).map((flag) => flag.slice(1, -1)));
    assert.ok(flags.size >= 12);
    for (const flag of flags) {
      assert.ok(HELP.includes(flag), `${flag} missing from --help`);
      assert.ok(readme.includes(flag), `${flag} missing from README`);
    }
  });

  it("every profile subcommand is listed in --help and the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const sub of PROFILE_SUBCOMMANDS) {
      if (sub === "ls" || sub === "rm") continue; // aliases of list and remove
      assert.ok(HELP.includes(`profile ${sub}`), `profile ${sub} missing from --help`);
      assert.ok(readme.includes(`profile ${sub}`), `profile ${sub} missing from README`);
    }
  });

  it("every ZCLAUDE_* and ZAI_* variable read anywhere in src is documented in the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const dir = join(root, "src");
    const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".js"));
    const names = new Set();
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      for (const match of text.matchAll(/\b(ZCLAUDE_[A-Z_]+|ZAI_[A-Z_]+)\b/gu)) names.add(match[1]);
    }
    assert.ok(names.size >= 15);
    for (const name of names) assert.ok(readme.includes(name), `${name} missing from README`);
  });
});

describe("profile isolation contract", () => {
  // Setting CLAUDE_CODE_OAUTH_TOKEN makes Claude Code delete the default
  // Keychain item when it exits (anthropics/claude-code#37512), which would
  // sign the user out of the account zclaude never touched.
  it("never assigns CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const dir = join(root, "src");
    const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".js"));
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      assert.doesNotMatch(
        text,
        /CLAUDE_CODE_OAUTH_TOKEN"?\]?\s*[=:]\s*[^=]/u,
        `${file} assigns CLAUDE_CODE_OAUTH_TOKEN`,
      );
    }
  });

  // The test Claude Code applies is whether the variable is set, not what it
  // holds: CLAUDE_CONFIG_DIR=~/.claude is a different credential item and
  // reads as signed out.
  it("the default profile is launched without a config directory", () => {
    const plain = buildPlainEnv({ baseEnv: { HOME: "/home/x", PATH: "/bin" }, extra: { A: "1" } });
    assert.equal(Object.hasOwn(plain, "CLAUDE_CONFIG_DIR"), false);
    const inherited = buildPlainEnv({ baseEnv: { CLAUDE_CONFIG_DIR: "/somewhere" } });
    assert.equal(inherited.CLAUDE_CONFIG_DIR, "/somewhere", "an inherited value is reported, never rewritten");
  });

  it("a profile environment pins the config directory last and drops the hijacking variables", () => {
    const env = buildProfileEnv({
      baseEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/x", ANTHROPIC_PROFILE: "other", CLAUDE_CONFIG_DIR: "/old" },
      configDir: "/p/home/",
      extra: { CLAUDE_CONFIG_DIR: "/hijack" },
    });
    assert.equal(env.CLAUDE_CONFIG_DIR, "/p/home");
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(env.ANTHROPIC_PROFILE, undefined);
  });
});
