// The route table, and reading a request well enough to route it.
//
// All pure. No Keychain, no network, no clock except the one passed in.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { classifyRequest, firstUserText, hasCacheControl, parseBetas, UNKNOWN_CLASS } from "../src/router/classify.js";
import {
  DEFAULT_ROUTER_CONFIG,
  initRouterConfig,
  loadRouterConfig,
  HOST,
  MAX_HOLD_MS,
  ROUTE_CLASSES,
  routerConfigPath,
  TARGET_KINDS,
  writeRouterConfig,
} from "../src/router/config.js";
import { candidatesFor, targetByName, validateRouteTable } from "../src/router/table.js";
import { tempHome } from "./helpers.js";

async function machine() {
  const home = await tempHome();
  return { home, env: { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" } };
}

const TABLE = {
  targets: {
    any: { kind: "anthropic", profile: "auto" },
    work: { kind: "anthropic", profile: "work" },
    glm: { kind: "zai", model: "latest" },
  },
  routes: {
    opus: { to: ["work", "any", "glm"] },
    sonnet: { to: ["glm"] },
    unknown: { to: ["any"] },
  },
};

describe("what the router will and will not accept", () => {
  it("binds to loopback, with no setting that could change it", () => {
    // An exposed router is an open proxy for somebody else's subscription.
    // This is a constant rather than a config key, in every phase.
    assert.equal(HOST, "127.0.0.1");
    assert.equal(DEFAULT_ROUTER_CONFIG.host, undefined, "there is no host key to set");
  });

  it("knows two kinds of target and the five classes a request can be", () => {
    assert.deepEqual([...TARGET_KINDS], ["anthropic", "zai"]);
    assert.deepEqual([...ROUTE_CLASSES], ["fable", "opus", "sonnet", "haiku", "unknown"]);
    assert.ok(ROUTE_CLASSES.includes(UNKNOWN_CLASS), "the class classOf cannot name still has a route");
  });
});

describe("reading a request", () => {
  it("names the class from the model, surviving the 1m marker", () => {
    const one = classifyRequest({ model: "claude-sonnet-5[1m]", stream: true });
    assert.equal(one.klass, "sonnet");
    assert.equal(one.normalized, "claude-sonnet-5", "the marker never reaches an upstream");
    assert.equal(one.oneMillion, true, "but the fact that it was asked for is kept");
    assert.equal(one.stream, true);
  });

  it("treats a model it cannot place as its own class rather than dropping it", () => {
    // Three different things land here and all need somewhere to go: a Z.ai id,
    // the synthetic model Claude Code writes for its own messages, and a body
    // with no model at all.
    for (const model of ["glm-5.3", "<synthetic>", undefined])
      assert.equal(classifyRequest({ model }).klass, "unknown", String(model));
    assert.equal(classifyRequest(null).klass, "unknown", "and so does no body at all");
  });

  it("reads an unrecognised claude model as opus, which is the cautious way round", () => {
    assert.equal(classifyRequest({ model: "claude-something-9" }).klass, "opus");
  });

  it("parses the beta header in both shapes, without duplicates", () => {
    assert.deepEqual(parseBetas("a-1, b-2 ,a-1"), ["a-1", "b-2"]);
    assert.deepEqual(parseBetas(["a-1", "b-2,c-3"]), ["a-1", "b-2", "c-3"]);
    assert.deepEqual(parseBetas(undefined), []);
  });

  it("finds a cache breakpoint wherever the API allows one", () => {
    assert.equal(hasCacheControl({ system: [{ type: "text", cache_control: { type: "ephemeral" } }] }), true);
    assert.equal(hasCacheControl({ tools: [{ name: "x", cache_control: {} }] }), true);
    assert.equal(hasCacheControl({ messages: [{ content: [{ type: "text", cache_control: {} }] }] }), true);
    assert.equal(hasCacheControl({ messages: [{ content: "plain" }] }), false);
    assert.equal(hasCacheControl(null), false);
  });

  it("takes the first user turn as written, in either content shape", () => {
    assert.equal(
      firstUserText([
        { role: "assistant", content: "no" },
        { role: "user", content: "yes" },
      ]),
      "yes",
    );
    assert.equal(firstUserText([{ role: "user", content: [{ type: "image" }, { type: "text", text: "yes" }] }]), "yes");
    assert.equal(firstUserText([]), "");
    assert.equal(firstUserText(null), "");
  });

  it("caps the first turn, because it is a cache key and not a transcript", () => {
    const long = classifyRequest({ messages: [{ role: "user", content: "x".repeat(10_000) }] });
    assert.equal(long.firstUserText.length, 4096);
  });
});

describe("candidates for a class", () => {
  it("returns the targets in the order the table lists them", () => {
    const found = candidatesFor(TABLE, "opus");
    assert.deepEqual(
      found.targets.map((target) => target.name),
      ["work", "any", "glm"],
    );
    assert.equal(found.pinned, false);
    assert.equal(found.targets[2].kind, "zai");
  });

  it("calls a class with one target pinned, because that changes what running out means", () => {
    assert.equal(candidatesFor(TABLE, "sonnet").pinned, true);
  });

  it("falls back to the unknown route for a class the table does not mention", () => {
    const found = candidatesFor(TABLE, "haiku");
    assert.deepEqual(
      found.targets.map((target) => target.name),
      ["any"],
    );
    assert.equal(found.klass, "haiku", "the class is still reported as what was asked for");
  });

  it("drops a target that no longer exists and says which", () => {
    const stale = { ...TABLE, routes: { ...TABLE.routes, opus: { to: ["work", "retired", "any"] } } };
    const found = candidatesFor(stale, "opus");
    assert.deepEqual(
      found.targets.map((target) => target.name),
      ["work", "any"],
      "the rest of the chain still works",
    );
    assert.match(found.detail, /retired no longer exists/u);
  });

  it("answers for a class nobody has heard of", () => {
    assert.deepEqual(candidatesFor(TABLE, "brand-new").klass, "unknown");
  });

  it("finds one target by name, or nothing", () => {
    assert.equal(targetByName(TABLE, "glm").model, "latest");
    assert.equal(targetByName(TABLE, "nope"), null);
  });
});

describe("validating a proposed table", () => {
  const profiles = ["work", "personal"];

  it("accepts a table that names real profiles", () => {
    assert.deepEqual(validateRouteTable(TABLE, { profiles }), { ok: true, errors: [] });
  });

  it("reports every problem at once, not the first", () => {
    const broken = {
      targets: { glm: { kind: "zai" }, odd: { kind: "openai" }, "bad name": { kind: "anthropic", profile: "ghost" } },
      routes: { opus: { to: ["glm", "glm"] }, nonsense: { to: ["glm"] } },
    };
    const { ok, errors } = validateRouteTable(broken, { profiles });
    assert.equal(ok, false);
    const paths = new Set(errors.map((error) => error.path));
    assert.ok(paths.has("targets.glm.model"), "a Z.ai target with no model");
    assert.ok(paths.has("targets.odd.kind"), "an unknown kind");
    assert.ok(paths.has("targets.bad name"), "a name that is not usable");
    assert.ok(paths.has("targets.bad name.profile"), "a profile that does not exist");
    assert.ok(paths.has("routes.opus.to"), "the same target twice");
    assert.ok(paths.has("routes.nonsense"), "a class zclaude does not route");
    assert.ok(paths.has("routes.unknown"), "and no catch-all route");
  });

  it("accepts auto as a profile, because it is a value and not a name", () => {
    const table = { targets: { any: { kind: "anthropic", profile: "auto" } }, routes: { unknown: { to: ["any"] } } };
    assert.equal(validateRouteTable(table, { profiles }).ok, true);
  });

  it("refuses a route pointing at a target that is not there", () => {
    const table = { targets: { any: { kind: "anthropic" } }, routes: { unknown: { to: ["ghost"] } } };
    const { errors } = validateRouteTable(table, { profiles });
    assert.match(errors[0].message, /no target named "ghost"/u);
  });

  it("refuses something that is not a table at all", () => {
    assert.equal(validateRouteTable(null).ok, false);
    assert.equal(validateRouteTable("nope").ok, false);
  });
});

describe("the route table on disk", () => {
  it("is the defaults when there is no file, and that is not a warning", async () => {
    const { home, env } = await machine();
    try {
      const loaded = await loadRouterConfig({ env });
      assert.equal(loaded.exists, false);
      assert.equal(loaded.ok, true);
      assert.deepEqual(loaded.warnings, []);
      assert.equal(loaded.config.enabled, false, "routing is off until somebody turns it on");
      for (const klass of ROUTE_CLASSES) assert.ok(loaded.config.routes[klass], `${klass} has somewhere to go`);
    } finally {
      await home.cleanup();
    }
  });

  it("is the defaults plus a warning when the file is broken, never an error", async () => {
    const { home, env } = await machine();
    try {
      await initRouterConfig({ env });
      await writeFile(routerConfigPath(env), "{not json");
      const loaded = await loadRouterConfig({ env });
      assert.equal(loaded.ok, false);
      assert.match(loaded.warnings[0], /not valid JSON/u);
      assert.equal(loaded.config.port, DEFAULT_ROUTER_CONFIG.port);
    } finally {
      await home.cleanup();
    }
  });

  it("clamps what it is given and names every key it clamped", async () => {
    const { home, env } = await machine();
    try {
      await writeRouterConfig(
        {
          version: 1,
          port: 80,
          hold: { ceilingMs: 3_600_000, pollMs: 1 },
          burst: { maxAttempts: 99 },
          nonsense: true,
        },
        { env },
      );
      const { config, warnings } = await loadRouterConfig({ env });
      assert.equal(config.port, 1024, "a privileged port is not something a config can ask for");
      assert.equal(config.hold.ceilingMs, MAX_HOLD_MS, "past the client's own stream watchdog is not a longer wait");
      assert.equal(config.hold.pollMs, 500);
      assert.equal(config.burst.maxAttempts, 5);
      assert.ok(warnings.some((warning) => warning.startsWith("port was 80")));
      assert.ok(warnings.some((warning) => warning.includes("nonsense is not a setting")));
    } finally {
      await home.cleanup();
    }
  });

  it("merges targets rather than replacing them, and drops one it cannot use", async () => {
    const { home, env } = await machine();
    try {
      await writeRouterConfig(
        { version: 1, targets: { glm: { kind: "zai" }, broken: { kind: "openai" } }, routes: {} },
        { env },
      );
      const { config, warnings } = await loadRouterConfig({ env });
      assert.ok(config.targets.any, "the built-in target survives naming another");
      assert.equal(config.targets.glm.model, "latest", "a Z.ai target with no model means the current one");
      assert.equal(config.targets.broken, undefined);
      assert.ok(warnings.some((warning) => warning.includes('target "broken"')));
    } finally {
      await home.cleanup();
    }
  });

  it("keeps the rest of a chain when one name in it is stale", async () => {
    const { home, env } = await machine();
    try {
      await writeRouterConfig(
        { version: 1, targets: { glm: { kind: "zai", model: "latest" } }, routes: { opus: { to: ["ghost", "glm"] } } },
        { env },
      );
      const { config, warnings } = await loadRouterConfig({ env });
      assert.deepEqual(config.routes.opus.to, ["glm"]);
      assert.ok(warnings.some((warning) => warning.includes('names target "ghost"')));
    } finally {
      await home.cleanup();
    }
  });

  it("refuses to read a mode it cannot honour", async () => {
    const { home, env } = await machine();
    try {
      // Machine-wide routing writes into Claude Code's own settings and is not
      // built. A file claiming that mode must not make the code believe it.
      await writeRouterConfig({ version: 1, mode: "machine", enabled: true }, { env });
      const { config } = await loadRouterConfig({ env });
      assert.equal(config.mode, "session");
    } finally {
      await home.cleanup();
    }
  });

  it("writes the explained defaults once, and leaves an existing file alone", async () => {
    const { home, env } = await machine();
    try {
      const first = await initRouterConfig({ env });
      assert.equal(first.written, true);
      const text = await readFile(routerConfigPath(env), "utf8");
      assert.match(text, /_readme/u);
      assert.doesNotMatch(text, /token|secret/iu, "no secret belongs in a file a page edits");

      const second = await initRouterConfig({ env });
      assert.equal(second.written, false);
      assert.equal(second.reason, "it already exists");

      await writeRouterConfig({ version: 1, port: 40_000 }, { env });
      const kept = await readFile(routerConfigPath(env), "utf8");
      assert.match(kept, /_readme/u, "a write preserves the explanation somebody may have edited");
    } finally {
      await home.cleanup();
    }
  });
});
