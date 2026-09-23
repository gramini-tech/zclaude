// Guardrails for the pieces that must not drift silently: the Z.ai protocol
// constants, the environment handed to claude, the exit-code table, and the
// documentation of every flag and variable.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildPlainEnv, buildProfileEnv, buildZaiEnv } from "../src/claude.js";
import { COMMAND_NAMES, HELP } from "../src/cli.js";
import { PROFILE_SUBCOMMANDS } from "../src/profile-commands.js";
import { AUTO_SUBCOMMANDS } from "../src/auto-commands.js";
import { RENEW_SUBCOMMANDS, selfBinary } from "../src/renew-commands.js";
import { ROUTER_SUBCOMMANDS } from "../src/router-commands.js";
import { SWITCH_SUBCOMMANDS } from "../src/swap-commands.js";
import { VSCODE_SUBCOMMANDS } from "../src/vscode-commands.js";
import { EDITORS, EXTENSION_ID, packagedVersion, vsixPath } from "../src/vscode/index.js";
import { vsixContents } from "../scripts/build-extension.js";
import { CLAUDE_COMMANDS } from "../src/profiles/paths.js";
import { CALLBACK_SCHEME, CONSOLE_KEYS_URL, DEFAULT_MODELS, MODEL_CONTEXT_WINDOWS, zaiConfig } from "../src/config.js";
import { ANTHROPIC_MODELS_URL, DEFAULT_TTL_MS as CATALOGUE_TTL_MS, PROVIDERS } from "../src/router/catalogue.js";
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

  it("pins where each provider's model list is asked for", () => {
    // The list itself is never pinned, on purpose: see src/router/catalogue.js.
    // Where it is asked for is protocol, and protocol must not drift silently.
    assert.equal(ANTHROPIC_MODELS_URL, "https://api.anthropic.com/v1/models");
    assert.deepEqual([...PROVIDERS], ["anthropic", "zai"]);
    assert.equal(CATALOGUE_TTL_MS, 6 * 60 * 60 * 1000);
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

// The files allowed to write Claude Code's own state, and the exact line each
// one may name a Claude path on. This list is the whole permission: everything
// else under src/ may only read. `switch` is the reason it is not empty — it
// moves the login the user asked it to move — and the behavioural proof that it
// touches nothing else lives in test/swap.test.js, which hashes ~/.claude and
// deep-compares every other key of the config file.
const WRITE_ALLOWED = new Map([
  // The basename it writes, and the comment lines that explain which file that
  // is. Code that named any other Claude path would not match.
  ["swap/identity.js", /^(const CONFIG_BASENAME = "\.claude\.json";| \* .*~\/\.claude\.json[^"]*)$/u],
]);

describe("claude config boundary", () => {
  it("names every file allowed to write Claude Code's own state", () => {
    assert.deepEqual(
      // [...map.keys()] rather than .keys().toArray(): Iterator helpers are
      // Node 22, and the test matrix still covers Node 20.
      [...WRITE_ALLOWED.keys()],
      ["swap/identity.js"],
      "adding a writer here is a deliberate act; say why in the commit and prove it in test/swap.test.js",
    );
  });

  it("source never writes to Claude Code's own files, apart from the swap; the rest are reads", async () => {
    const dir = join(root, "src");
    const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".js"));
    const writers =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|truncate|copyFile|mkdir|mkdirSync)\s*\(/u;
    const allowedMentions = new Map([
      ...WRITE_ALLOWED,
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
      if (writers.test(line) && !WRITE_ALLOWED.has(file))
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

  it("every switch subcommand is listed in --help and the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const sub of SWITCH_SUBCOMMANDS) {
      // Two spellings by design: `switch --status` reads better as a flag,
      // `switch capture` as a verb. Either one counts as documented.
      const shown = (text) => text.includes(`switch ${sub}`) || text.includes(`switch --${sub}`);
      assert.ok(shown(HELP), `switch ${sub} missing from --help`);
      assert.ok(shown(readme), `switch ${sub} missing from README`);
    }
  });

  it("every renew subcommand is listed in --help and the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const sub of RENEW_SUBCOMMANDS) {
      assert.ok(HELP.includes(`renew ${sub}`), `renew ${sub} missing from --help`);
      assert.ok(readme.includes(`renew ${sub}`), `renew ${sub} missing from README`);
    }
  });

  it("every auto subcommand is listed in --help and the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const sub of AUTO_SUBCOMMANDS) {
      assert.ok(HELP.includes(`auto ${sub}`), `auto ${sub} missing from --help`);
      assert.ok(readme.includes(`auto ${sub}`), `auto ${sub} missing from README`);
    }
  });

  it("every router subcommand is listed in --help and the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const sub of ROUTER_SUBCOMMANDS) {
      // `routes` is the same command as `status` under a name that reads
      // better in a sentence, so either spelling counts as documented.
      const shown = (text) => text.includes(`router ${sub}`) || (sub === "routes" && text.includes("router status"));
      assert.ok(shown(HELP), `router ${sub} missing from --help`);
      assert.ok(shown(readme), `router ${sub} missing from README`);
    }
  });

  it("schedules this installation rather than whatever is on PATH", () => {
    // A scheduled job outlives the shell that created it, so "zclaude" alone
    // would break the moment PATH differs — which is exactly what happens
    // inside launchd.
    assert.equal(selfBinary({ ZCLAUDE_BIN: "/opt/zclaude" }, []), "/opt/zclaude");
    assert.equal(
      selfBinary({}, ["node", "/home/x/.zclaude/app/bin/zclaude.js"]),
      "/home/x/.zclaude/app/bin/zclaude.js",
    );
    assert.equal(selfBinary({}, []), "zclaude");
  });

  // The vsix is a build artefact that is committed, so it can silently fall
  // behind its sources. These two tests are what notices.
  it("the committed vsix carries the manifest's version and identifier", async () => {
    const manifest = JSON.parse(await readFile(join(root, "extension", "package.json"), "utf8"));
    assert.equal(`${manifest.publisher}.${manifest.name}`, EXTENSION_ID);
    assert.equal(await packagedVersion(), manifest.version);
    const files = await vsixContents(vsixPath());
    assert.ok(files["extension/package.json"], "the vsix has no manifest");
  });

  it("the committed vsix holds exactly the extension's sources, byte for byte", async () => {
    const files = await vsixContents(vsixPath());
    // vsce renames these two; everything else keeps its path.
    const packagedAs = { "README.md": "extension/readme.md", "LICENSE": "extension/LICENSE.txt" };
    const sources = [
      "package.json",
      "README.md",
      "LICENSE",
      ...(await readdir(join(root, "extension", "src"))).map((name) => join("src", name)),
    ];
    for (const source of sources) {
      const path = packagedAs[source] ?? `extension/${source.split(sep).join("/")}`;
      assert.ok(files[path], `${source} is not in the vsix — run \`npm run build:extension\``);
      const bytes = await readFile(join(root, "extension", source));
      assert.equal(
        files[path],
        `${crc32(bytes).toString(16).padStart(8, "0")}:${bytes.length}`,
        `${source} changed since the vsix was built — run \`npm run build:extension\``,
      );
    }
  });

  // The installer removes the extension without running zclaude, because the
  // app directory may already be gone, so it carries its own copy of the list.
  it("the installer looks for the same editors the CLI does", async () => {
    const installer = await readFile(join(root, "install.sh"), "utf8");
    const listed = installer.match(/for id in ([a-z -]+); do/u)?.[1]?.split(" ");
    assert.deepEqual(
      listed,
      EDITORS.map((editor) => editor.id),
    );
    for (const editor of EDITORS) assert.ok(installer.includes(editor.app), `${editor.app} missing from install.sh`);
    assert.ok(installer.includes(`--uninstall-extension ${EXTENSION_ID}`));
  });

  it("every vscode subcommand is listed in --help and the README", async () => {
    const readme = await readFile(join(root, "README.md"), "utf8");
    for (const sub of VSCODE_SUBCOMMANDS) {
      assert.ok(HELP.includes(`vscode ${sub}`), `vscode ${sub} missing from --help`);
      assert.ok(readme.includes(`vscode ${sub}`), `vscode ${sub} missing from README`);
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

  // The other direction: the docs must not invent a command. Only text the
  // reader would copy is checked, with trailing comments cut off and the
  // aligned description columns of the command reference (two spaces or more)
  // left alone, so prose like "zclaude never edits" is not read as a command.
  it("every command the README and the website show is one the CLI accepts", async () => {
    const [readme, html] = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "index.html"), "utf8"),
    ]);
    const spans = [
      ...Array.from(readme.matchAll(/```[a-z]*\n([\s\S]*?)```/gu), (match) => match[1]),
      ...Array.from(readme.matchAll(/`([^`\n]+)`/gu), (match) => match[1]),
      ...Array.from(html.matchAll(/<(?:code|pre)[^>]*>([\s\S]*?)<\/(?:code|pre)>/gu), (match) => match[1]),
    ];
    const lines = spans.flatMap((span) => span.split("\n")).map((line) => line.split("#", 1)[0]);
    // The docs also show profile names, because `zclaude work` is how you
    // start one, and claude's own commands, because those pass through. A
    // word that is none of the three is an invented command and fails.
    const examples = ["work", "company", "client", "personal", "glm", "glm-work", "glm2"];
    const known = new Set([...COMMAND_NAMES, ...PROFILE_SUBCOMMANDS, ...CLAUDE_COMMANDS, ...examples]);
    let checked = 0;
    for (const line of lines) {
      for (const [, sub] of line.matchAll(/\bzclaude profile (?! )([a-z][a-z-]+)/gu)) {
        checked += 1;
        assert.ok(PROFILE_SUBCOMMANDS.includes(sub), `\`zclaude profile ${sub}\` is documented but not implemented`);
      }
      for (const [, word] of line.matchAll(/\bzclaude (?! )(?!profile\b)([a-z][a-z-]+)/gu)) {
        checked += 1;
        assert.ok(known.has(word), `\`zclaude ${word}\` is documented but not implemented`);
      }
    }
    assert.ok(checked >= 30, `expected the docs to show commands, found ${checked}`);
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

  // A routed launch adds four variables and no more. This pins the set because
  // each one has a consequence: ANTHROPIC_API_KEY instead of AUTH_TOKEN would
  // bill the API rather than the plan, and a fifth added quietly here is a
  // change to what Claude Code does that nobody reviewed.
  it("a routed launch adds exactly the four documented variables", () => {
    const routed = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:34317",
      ANTHROPIC_AUTH_TOKEN: "zcr_x",
      ZCLAUDE_ROUTER: "34317",
      ENABLE_TOOL_SEARCH: "true",
    };
    const plain = buildProfileEnv({ baseEnv: { HOME: "/home/x" }, configDir: "/p/home" });
    const env = buildProfileEnv({ baseEnv: { HOME: "/home/x" }, configDir: "/p/home", extra: routed });
    const added = Object.keys(env).filter((key) => !Object.hasOwn(plain, key));
    const byName = (a, b) => a.localeCompare(b);
    assert.deepEqual(added.toSorted(byName), Object.keys(routed).toSorted(byName));
    assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false, "an API key bills the API, not the plan");
    assert.match(env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:/u, "the router is loopback only");
  });
});
