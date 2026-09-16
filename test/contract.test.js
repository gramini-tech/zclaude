// Guardrails for the pieces that must not drift silently: the Z.ai protocol
// constants, the environment handed to claude, the exit-code table, and the
// documentation of every flag and variable.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildZaiEnv } from "../src/claude.js";
import { HELP } from "../src/cli.js";
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

  it("every ZCLAUDE_* and ZAI_* variable read in src is documented in the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    const sources = ["cli.js", "config.js", "store.js", "settings.js", "callback/index.js", "profiles.js"];
    const names = new Set();
    for (const file of sources) {
      const text = await readFile(join(root, "src", file), "utf8");
      for (const match of text.matchAll(/\b(ZCLAUDE_[A-Z_]+|ZAI_[A-Z_]+)\b/gu)) names.add(match[1]);
    }
    assert.ok(names.size >= 15);
    for (const name of names) assert.ok(readme.includes(name), `${name} missing from README`);
  });
});
