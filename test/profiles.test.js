import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BUILTIN_PROFILES, findProfile, getProfile, listProfiles, takeProfileArgument } from "../src/profiles.js";
import { isolatedEnv, tempHome } from "./helpers.js";

describe("profiles", () => {
  let home;
  let env;
  before(async () => {
    home = await tempHome();
    env = isolatedEnv(home.dir);
    const dir = join(env.ZCLAUDE_HOME, "profiles");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "work.env"),
      "# name: Work MCP\n# description: adds MCP env\nMY_MCP_TOKEN=abc\nZCLAUDE_ZAI=1\n",
    );
    await writeFile(join(dir, "plain.env"), "FOO=bar\n");
    await writeFile(join(dir, "zai.env"), "FOO=reserved\n");
    await writeFile(join(dir, "bad name.env"), "FOO=x\n");
    await writeFile(join(dir, "notes.txt"), "ignored\n");
  });
  after(() => home.cleanup());

  it("lists built-ins first, then valid user profiles", async () => {
    const profiles = await listProfiles(env);
    assert.deepEqual(
      profiles.slice(0, 2).map((p) => p.id),
      BUILTIN_PROFILES.map((p) => p.id),
    );
    assert.deepEqual(
      profiles.slice(2).map((p) => p.id),
      ["plain", "work"],
    );
    const work = profiles.find((p) => p.id === "work");
    assert.equal(work.label, "Work MCP");
    assert.equal(work.description, "adds MCP env");
    assert.equal(work.zai, true);
    assert.deepEqual(work.env, { MY_MCP_TOKEN: "abc" });
    const plain = profiles.find((p) => p.id === "plain");
    assert.equal(plain.zai, false);
    assert.equal(plain.label, "plain");
  });
  it("returns built-ins when the directory is missing", async () => {
    const profiles = await listProfiles(isolatedEnv(join(home.dir, "nothing")));
    assert.equal(profiles.length, 2);
    assert.equal(profiles[1].zai, true);
  });
  it("getProfile finds by id", async () => {
    assert.equal((await getProfile("zai", env)).builtin, true);
    assert.equal(await getProfile("missing", env), null);
  });
});

describe("naming a profile as the first argument", () => {
  const profiles = [{ id: "claude" }, { id: "zai" }, { id: "work" }, { id: "glm-2" }];

  it("takes a name that exists and hands the rest to claude", () => {
    assert.deepEqual(takeProfileArgument(["work", "-p", "hi"], profiles, "linux"), {
      profile: "work",
      args: ["-p", "hi"],
    });
    assert.deepEqual(takeProfileArgument(["zai"], profiles, "linux"), { profile: "zai", args: [] });
    assert.deepEqual(
      takeProfileArgument(["glm-2", "--", "--help"], profiles, "linux"),
      { profile: "glm-2", args: ["--help"] },
      "the separator has done its job once the name is taken",
    );
  });

  it("leaves claude's own arguments alone", () => {
    for (const args of [["mcp", "list"], ["-p", "hi"], ["--continue"], ["auth", "status"], []]) {
      assert.deepEqual(takeProfileArgument(args, profiles, "linux"), { profile: null, args });
    }
  });

  it("folds case only where the filesystem does", () => {
    assert.equal(takeProfileArgument(["Work"], profiles, "darwin").profile, "work");
    assert.equal(takeProfileArgument(["Work"], profiles, "linux").profile, null);
    assert.equal(findProfile(profiles, "WORK", "win32")?.id, "work");
    assert.equal(findProfile(profiles, "missing", "darwin"), null);
    assert.equal(findProfile(profiles, "", "darwin"), null);
  });
});
