import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  configureLogger,
  formatEntry,
  isLogging,
  listLogs,
  log,
  logFilePath,
  logsDir,
  parseCategories,
  readLog,
} from "../src/logger.js";
import { registerSecret } from "../src/redact.js";
import { tempHome } from "./helpers.js";

describe("run log", () => {
  let home;
  let env;
  before(async () => {
    home = await tempHome();
    env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude") };
  });
  after(async () => {
    configureLogger({ env: {}, disabled: true });
    await home.cleanup();
  });

  it("writes a redacted JSON-lines file with a run header", async () => {
    registerSecret("supersecretvalue123");
    const file = configureLogger({ env, argv: ["--profile", "zai", "supersecretvalue123"] });
    assert.ok(file.startsWith(logsDir(env)));
    assert.equal(logFilePath(), file);
    log.info("auth", "credential resolved", { key: "****abcd", token: "Bearer supersecretvalue123" });
    log.debug("http", "response", { status: 200 });
    log.trace("http", "request", { hidden: true });
    const entries = readLog(file);
    assert.equal(entries[0].msg, "run started");
    assert.equal(entries[0].level, "info");
    assert.deepEqual(entries[0].argv, ["--profile", "zai", "****e123"]);
    assert.equal(entries[1].cat, "auth");
    assert.equal(entries[1].token, "Bearer ****e123");
    assert.equal(entries[2].status, 200);
    assert.equal(entries.length, 3, "trace is below the default debug level");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(file, "utf8"), /supersecretvalue123/u);
  });

  it("honours level and category filters from the environment and options", () => {
    configureLogger({ env: { ...env, ZCLAUDE_LOG_LEVEL: "warn", ZCLAUDE_LOG_CATEGORIES: "-http" } });
    assert.equal(isLogging("info", "cli"), false);
    assert.equal(isLogging("warn", "cli"), true);
    assert.equal(isLogging("error", "http"), false);
    configureLogger({ env, level: "trace", categories: "auth,claude" });
    assert.equal(isLogging("trace", "auth"), true);
    assert.equal(isLogging("error", "console"), false);
    assert.deepEqual(parseCategories(" a, -b ,!c,,"), { include: new Set(["a"]), exclude: new Set(["b", "c"]) });
    assert.deepEqual(parseCategories(""), { include: null, exclude: new Set() });
    configureLogger({ env, categories: "auth,typo" });
    assert.equal(isLogging("info", "auth"), true);
  });

  it("can be turned off through the environment, a flag, or level off", () => {
    assert.equal(configureLogger({ env: { ...env, ZCLAUDE_LOG: "off" } }), null);
    assert.equal(logFilePath(), null);
    assert.equal(isLogging("error", "cli"), false);
    assert.equal(configureLogger({ env, disabled: true }), null);
    assert.equal(configureLogger({ env, level: "off" }), null);
    log.error("cli", "dropped");
  });

  it("uses an explicit file when asked", async () => {
    const custom = join(home.dir, "custom.log");
    assert.equal(configureLogger({ env: { ...env, ZCLAUDE_LOG: custom } }), custom);
    log.warn("cli", "hello");
    assert.equal(readLog(custom).at(-1).msg, "hello");
    const flagged = join(home.dir, "flagged.log");
    assert.equal(configureLogger({ env, file: flagged }), flagged);
  });

  it("prunes old run logs beyond ZCLAUDE_LOG_KEEP", async () => {
    const dir = logsDir(env);
    for (let i = 0; i < 5; i += 1) await writeFile(join(dir, `zclaude-20200101-00000${i}-000-1.log`), "{}\n");
    configureLogger({ env: { ...env, ZCLAUDE_LOG_KEEP: "3" } });
    const names = (await readdir(dir)).filter((name) => name.startsWith("zclaude-"));
    assert.equal(names.length, 3, "two kept files plus the new one");
    assert.ok(names.includes("zclaude-20200101-000004-000-1.log"));
    assert.ok(!names.includes("zclaude-20200101-000000-000-1.log"));
    assert.equal(listLogs(env)[0], logFilePath());
  });

  it("formats entries for humans and tolerates malformed lines", async () => {
    const path = join(home.dir, "mixed.log");
    await writeFile(
      path,
      `${JSON.stringify({ ts: "2026-09-16T10:00:00.123Z", t: 1500, seq: 1, level: "info", cat: "cli", msg: "hi", extra: 1 })}\nnot json\n`,
    );
    const entries = readLog(path);
    assert.equal(formatEntry(entries[0]), '10:00:00.123   +1.500s info  cli       hi {"extra":1}');
    assert.equal(formatEntry(entries[1]), "not json");
  });
});
