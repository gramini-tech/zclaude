// The inventory file, the account snapshot, and the read-only `auto` command.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { autoConfigPath, DEFAULT_TIERS, initAutoConfig, loadAutoConfig } from "../src/auto/config.js";
import { duplicates } from "../src/auto/inventory.js";
import { AUTO_SUBCOMMANDS } from "../src/auto-commands.js";
import { tempHome } from "./helpers.js";

const envFor = (home) => ({ HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" });

describe("the inventory file", () => {
  it("needs no file at all", async () => {
    const home = await tempHome();
    try {
      const { config, exists, ok, warnings } = await loadAutoConfig({ env: envFor(home) });
      assert.equal(exists, false);
      assert.equal(ok, true);
      assert.deepEqual(warnings, []);
      assert.deepEqual(config.tiers, DEFAULT_TIERS);
      assert.deepEqual(config.ladder, [95, 100]);
    } finally {
      await home.cleanup();
    }
  });

  it("merges tiers key by key, and replaces the ladder wholesale", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await initAutoConfig({ env });
      await writeFile(autoConfigPath(env), JSON.stringify({ tiers: { default_raven: 7 }, ladder: [90, 97] }));
      const { config } = await loadAutoConfig({ env });
      // Naming one tier must not delete the others.
      assert.equal(config.tiers.default_raven, 7);
      assert.equal(config.tiers.default_claude_max_20x, 20);
      // A ladder merged element by element would be meaningless: its order is
      // its meaning.
      assert.deepEqual(config.ladder, [90, 97]);
    } finally {
      await home.cleanup();
    }
  });

  it("clamps what it cannot accept, and says which key it changed", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await initAutoConfig({ env });
      await writeFile(
        autoConfigPath(env),
        JSON.stringify({ ladder: [150], resetBelow: 999, poll: { floorSeconds: 1 } }),
      );
      const { config, warnings, ok } = await loadAutoConfig({ env });
      assert.equal(ok, false);
      assert.deepEqual(config.ladder, [100]);
      assert.ok(config.resetBelow <= config.ladder[0] - 5);
      // Nobody edits their way into hammering the usage endpoint every second.
      assert.equal(config.poll.floorSeconds, 45);
      assert.ok(warnings.some((line) => line.includes("poll.floorSeconds")));
    } finally {
      await home.cleanup();
    }
  });

  it("names an unknown key rather than swallowing it", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await initAutoConfig({ env });
      await writeFile(autoConfigPath(env), JSON.stringify({ rotateAtPercent: 99 }));
      const { warnings } = await loadAutoConfig({ env });
      // Silently ignoring a typo is how somebody believes they set 99.
      assert.ok(warnings.some((line) => line.includes("rotateAtPercent")));
    } finally {
      await home.cleanup();
    }
  });

  it("falls back to the defaults on a broken file, and never throws", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await initAutoConfig({ env });
      await writeFile(autoConfigPath(env), "{ this is not json");
      const { config, ok, warnings } = await loadAutoConfig({ env });
      assert.equal(ok, false);
      assert.equal(warnings.length, 1);
      // A half-parsed config with a zeroed threshold is worse than none.
      assert.deepEqual(config.ladder, [95, 100]);
    } finally {
      await home.cleanup();
    }
  });

  it("writes the defaults with their explanation, and will not clobber by accident", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      const first = await initAutoConfig({ env });
      assert.equal(first.written, true);
      const written = JSON.parse(await readFile(first.path, "utf8"));
      assert.ok(Array.isArray(written._readme) && written._readme.length > 0, "it explains itself");

      const again = await initAutoConfig({ env });
      assert.equal(again.written, false);
      assert.equal((await initAutoConfig({ env, force: true })).written, true);
    } finally {
      await home.cleanup();
    }
  });
});

describe("spotting one account under two names", () => {
  const account = (name, uuid, org) => ({ name, accountUuid: uuid, organizationUuid: org });

  it("does not confuse a company seat with a personal plan on the same login", () => {
    // Measured on a real machine: these two share an account uuid and differ
    // only by organisation. They are metered entirely apart, so rotating
    // between them is real work — calling them one account would have made the
    // scheduler skip the emptiest option there was.
    const seat = account("hoomanely", "f0f76161", "76fd67fb");
    const personal = account("max", "f0f76161", "af4d7c6a");
    assert.deepEqual(duplicates([seat, personal]), []);
  });

  it("spots the same account registered twice", () => {
    const one = account("work", "aaa", "org");
    const again = account("work-copy", "aaa", "org");
    assert.deepEqual(duplicates([one, again]), [["work", "work-copy"]]);
  });

  it("says nothing about a profile that has never been signed in", () => {
    assert.deepEqual(duplicates([account("a", null, null), account("b", null, null)]), []);
  });
});

describe("the auto command", () => {
  it("offers only what is built", () => {
    assert.deepEqual(AUTO_SUBCOMMANDS, ["status", "config", "run", "off"]);
  });
});
