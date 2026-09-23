// `zclaude router` from the outside: what it prints, what it writes, and what
// it refuses.
//
// Everything runs against a temporary ZCLAUDE_HOME, so no test here can reach
// a real route table, a real profile or a real Keychain.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { ROUTER_SUBCOMMANDS, cmdRouterGroup } from "../src/router-commands.js";
import { DEFAULT_ROUTER_CONFIG, ROUTE_CLASSES, loadRouterConfig, routerConfigPath } from "../src/router/config.js";
import { putRegistered, removeRegistered } from "../src/profiles/registry.js";

const home = await mkdtemp(join(tmpdir(), "zclaude-router-cli-"));
const env = { ...process.env, ZCLAUDE_HOME: home, HOME: home, ZCLAUDE_NO_KEYCHAIN: "1", NO_COLOR: "1" };

after(async () => {
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(routerConfigPath(env), { force: true });
});

/** Run one subcommand and collect everything it printed. */
async function run(args, options = {}) {
  const written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const code = await cmdRouterGroup({ options: { args, ...options }, env });
    return { code, out: written.join("") };
  } finally {
    process.stdout.write = original;
  }
}

describe("zclaude router status", () => {
  it("is the default subcommand and reports session mode with no router running", async () => {
    const { out } = await run([]);
    assert.match(out, /session/u);
    assert.match(out, /nothing shared is running/u);
    for (const klass of ROUTE_CLASSES) assert.match(out, new RegExp(klass, "u"));
  });

  it("reports the defaults as defaults when nothing has been written", async () => {
    const { out } = await run(["status"], { json: true });
    const body = JSON.parse(out);
    assert.equal(body.mode, "session");
    assert.equal(body.config.exists, false);
    assert.equal(body.running, null);
    assert.deepEqual(body.routes.unknown.to, ["auto"]);
    assert.equal(body.routes.unknown.pinned, true);
  });

  it("never reports a mode the code cannot honour, even when the file claims one", async () => {
    await writeFile(routerConfigPath(env), JSON.stringify({ version: 1, mode: "machine-wide" }), "utf8");
    const { out } = await run(["status"], { json: true });
    assert.equal(JSON.parse(out).mode, "session");
  });
});

describe("zclaude router route", () => {
  it("prints a class's chain when given no targets", async () => {
    const { out } = await run(["route", "sonnet"]);
    assert.match(out, /sonnet/u);
    assert.match(out, /auto/u);
  });

  it("refuses a class it does not route, and changes nothing", async () => {
    await assert.rejects(run(["route", "gpt", "any"]), /is not a class zclaude routes/u);
    assert.equal((await loadRouterConfig({ env })).exists, false);
  });

  it("refuses when no class is named", async () => {
    await assert.rejects(run(["route"]), /Which class of model/u);
  });

  it("refuses a target that does not exist, and writes nothing", async () => {
    await assert.rejects(run(["route", "sonnet", "glm"]), /route table was not changed/u);
    assert.equal((await loadRouterConfig({ env })).exists, false);
  });

  it("writes a chain, and the file keeps its explanation", async () => {
    await run(["config", "init"]);
    const { code } = await run(["route", "haiku", "any"]);
    assert.equal(code, 0);
    const written = JSON.parse(await readFile(routerConfigPath(env), "utf8"));
    assert.deepEqual(written.routes.haiku.to, ["any"]);
    // `_readme` is what makes this file editable by hand, so a write must not
    // quietly drop it.
    assert.ok(Array.isArray(written._readme));
    assert.deepEqual(written.routes.sonnet.to, DEFAULT_ROUTER_CONFIG.routes.sonnet.to);
  });
});

describe("zclaude router on and off", () => {
  it("turns routing on, and off again", async () => {
    await run(["config", "init"]);
    await run(["on"]);
    assert.equal((await loadRouterConfig({ env })).config.enabled, true);
    await run(["off"]);
    assert.equal((await loadRouterConfig({ env })).config.enabled, false);
  });

  it("refuses machine-wide, and says why rather than pretending", async () => {
    await assert.rejects(run(["on"], { machineWide: true }), /not built/u);
    assert.equal((await loadRouterConfig({ env })).config.enabled, false);
  });

  it("refuses to turn on over a table naming a profile that is gone", async () => {
    // The loader drops a route whose *target* vanished, with a warning, so it
    // never reaches here. A target naming a profile that was removed does
    // reach here, and turning routing on over it would surface as a 503 inside
    // somebody's next session instead of as a message now.
    await putRegistered({ name: "kept", provider: "anthropic", dir: join(home, "kept") }, env);
    await writeFile(
      routerConfigPath(env),
      JSON.stringify({
        version: 1,
        targets: { any: { kind: "anthropic", profile: "auto" }, gone: { kind: "anthropic", profile: "removed" } },
        routes: { sonnet: { to: ["gone"] }, unknown: { to: ["any"] } },
      }),
      "utf8",
    );
    await assert.rejects(run(["on"]), /route table has problems/u);
    assert.equal((await loadRouterConfig({ env })).config.enabled, false);
    await removeRegistered("kept", env);
  });

  it("accepts --session-only, which is the only mode there is", async () => {
    await run(["config", "init"]);
    const { code } = await run(["on"], { sessionOnly: true });
    assert.equal(code, 0);
    assert.equal((await loadRouterConfig({ env })).config.enabled, true);
    await run(["off"]);
  });
});

describe("zclaude router config", () => {
  it("prints the path", async () => {
    const { out } = await run(["config", "path"]);
    assert.equal(out.trim(), routerConfigPath(env));
  });

  it("writes the defaults once, and leaves an existing file alone", async () => {
    const first = await run(["config", "init"]);
    assert.equal(first.code, 0);
    await run(["route", "opus", "any"]);
    await run(["config", "init"]);
    const kept = JSON.parse(await readFile(routerConfigPath(env), "utf8"));
    assert.deepEqual(kept.routes.opus.to, ["any"]);
  });

  it("refuses an action it does not have", async () => {
    await assert.rejects(run(["config", "reticulate"]), /is not a command/u);
  });
});

describe("zclaude router log", () => {
  it("says so plainly when no shared router is running", async () => {
    const { out } = await run(["log"]);
    assert.equal(out, "");
  });
});

describe("the group itself", () => {
  it("refuses a subcommand it does not have, and names the ones it does", async () => {
    await assert.rejects(run(["teleport"]), /is not a command/u);
  });

  it("exports exactly the subcommands the help and README document", () => {
    const sorted = [...ROUTER_SUBCOMMANDS].toSorted((a, b) => a.localeCompare(b));
    assert.deepEqual(sorted, [
      "config",
      "log",
      "models",
      "off",
      "on",
      "open",
      "route",
      "routes",
      "serve",
      "status",
      "stop",
    ]);
  });
});
