import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  extraEnv,
  fileConfiguresModels,
  formatValue,
  loadLayeredConfig,
  parseDotenv,
  resolveModels,
  resolveProfileDefault,
  updateDotenv,
  writeSettingsFile,
} from "../src/settings.js";
import { isolatedEnv, tempHome } from "./helpers.js";

describe("parseDotenv", () => {
  it("handles comments, export, quotes and inline comments", () => {
    const { values, warnings } = parseDotenv([
      "# comment",
      "",
      "export A=1",
      "B = two words # trailing",
      'C="quoted # not a comment"',
      "D='single \"inner\"'",
      'E="line\\nbreak"',
      "F=",
    ].join("\n"));
    assert.deepEqual(values, { A: "1", B: "two words", C: "quoted # not a comment", D: 'single "inner"', E: "line\nbreak", F: "" });
    assert.deepEqual(warnings, []);
  });
  it("warns on malformed lines without throwing", () => {
    const { values, warnings } = parseDotenv("GOOD=1\nnot a pair\n1BAD=x\nQ=\"unterminated\n", { file: "f" });
    assert.deepEqual(values, { GOOD: "1" });
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /^f:2: expected KEY=value/u);
    assert.match(warnings[1], /^f:3: invalid variable name/u);
    assert.match(warnings[2], /^f:4: unterminated quote/u);
  });
});

describe("updateDotenv", () => {
  it("replaces in place, keeps unrelated lines, appends missing keys, drops duplicates", () => {
    const before = "# keep me\nZCLAUDE_MODEL=old\nOTHER=x\nZCLAUDE_MODEL=dup\n";
    const after = updateDotenv(before, { ZCLAUDE_MODEL: "glm-5.3", ZCLAUDE_FAST_MODEL: "glm-5.3-flash" });
    assert.equal(after, "# keep me\nZCLAUDE_MODEL=glm-5.3\nOTHER=x\nZCLAUDE_FAST_MODEL=glm-5.3-flash\n");
  });
  it("adds the header only to a new file and quotes awkward values", () => {
    assert.equal(updateDotenv("", { A: "has space" }, { header: "# h" }), '# h\nA="has space"\n');
    assert.equal(formatValue("plain"), "plain");
    assert.equal(formatValue('q"uote'), '"q\\"uote"');
  });
});

describe("resolveModels", () => {
  const layered = {
    project: { values: { ZCLAUDE_MODEL: "proj-primary" } },
    user: { values: { ZCLAUDE_MODEL: "user-primary", ZCLAUDE_SUBAGENT_MODEL: "user-sub" } },
  };
  it("applies flag > env > project > user > default per slot", () => {
    const result = resolveModels({ flags: { fast: "flag-fast" }, env: { ZCLAUDE_SUBAGENT_MODEL: "env-sub" }, layered });
    assert.deepEqual(result, {
      primary: "proj-primary",
      subagent: "env-sub",
      fast: "flag-fast",
      sources: { primary: "project", subagent: "env", fast: "flag" },
    });
  });
  it("falls back to defaults", () => {
    const result = resolveModels({ env: {}, layered: { project: { values: {} }, user: { values: {} } } });
    assert.deepEqual([result.primary, result.subagent, result.fast], ["glm-5.3", "glm-5.3-flash", "glm-5.3-flash"]);
    assert.equal(result.sources.primary, "default");
  });
  it("fileConfiguresModels needs all three slots", () => {
    assert.equal(fileConfiguresModels({ values: { ZCLAUDE_MODEL: "a", ZCLAUDE_SUBAGENT_MODEL: "b", ZCLAUDE_FAST_MODEL: "c" } }), true);
    assert.equal(fileConfiguresModels({ values: { ZCLAUDE_MODEL: "a" } }), false);
  });
  it("extraEnv passes through unmanaged keys, project over user", () => {
    assert.deepEqual(extraEnv({
      user: { values: { FOO: "u", BAR: "u", ZCLAUDE_MODEL: "x" } },
      project: { values: { FOO: "p", ZCLAUDE_ZAI: "1", ZCLAUDE_PROFILE: "zai" } },
    }), { FOO: "p", BAR: "u" });
  });
  it("resolveProfileDefault prefers env, then project, then user", () => {
    assert.deepEqual(resolveProfileDefault({ env: { ZCLAUDE_PROFILE: "e" }, layered: { project: { values: { ZCLAUDE_PROFILE: "p" } } } }), { value: "e", source: "env" });
    assert.deepEqual(resolveProfileDefault({ env: {}, layered: { project: { values: {} }, user: { values: { ZCLAUDE_PROFILE: "u" } } } }), { value: "u", source: "user" });
    assert.equal(resolveProfileDefault({ env: {}, layered: { project: { values: {} }, user: { values: {} } } }), null);
  });
});

describe("files", () => {
  let home;
  before(async () => { home = await tempHome(); });
  after(() => home.cleanup());

  it("writes atomically with the header and reads back layered", async () => {
    const env = isolatedEnv(home.dir);
    const cwd = join(home.dir, "proj");
    const userPath = await writeSettingsFile(join(env.ZCLAUDE_HOME, "settings"), { ZCLAUDE_MODEL: "glm-5.3" });
    const text = await readFile(userPath, "utf8");
    assert.match(text, /^# managed by zclaude/u);
    assert.match(text, /ZCLAUDE_MODEL=glm-5.3\n$/u);
    const mode = (await stat(userPath)).mode & 0o777;
    assert.equal(mode, 0o644);
    await writeSettingsFile(join(cwd, ".zclaude", "env"), { ZCLAUDE_FAST_MODEL: "glm-5.3-flash" });
    const layered = await loadLayeredConfig({ cwd, env });
    assert.equal(layered.user.exists, true);
    assert.equal(layered.project.exists, true);
    assert.deepEqual(layered.project.values, { ZCLAUDE_FAST_MODEL: "glm-5.3-flash" });
    const models = resolveModels({ env: {}, layered });
    assert.equal(models.sources.primary, "user");
    assert.equal(models.sources.fast, "project");
  });
  it("reports a missing file without warnings", async () => {
    const layered = await loadLayeredConfig({ cwd: join(home.dir, "nowhere"), env: isolatedEnv(join(home.dir, "empty")) });
    assert.equal(layered.project.exists, false);
    assert.deepEqual(layered.project.warnings, []);
  });
});
