import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HELP, parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  const cases = [
    [[], { command: "launch", options: {}, passthrough: [] }],
    [["--profile", "zai", "-p", "hi"], { command: "launch", options: { profile: "zai" }, passthrough: ["-p", "hi"] }],
    [
      ["--profile=claude", "--no-banner"],
      { command: "launch", options: { profile: "claude", noBanner: true }, passthrough: [] },
    ],
    [["--", "--help"], { command: "launch", options: {}, passthrough: ["--help"] }],
    [
      ["--model", "glm-5.3", "--", "-p", "x"],
      { command: "launch", options: { model: "glm-5.3" }, passthrough: ["-p", "x"] },
    ],
    [["auth", "status"], { command: "launch", options: {}, passthrough: ["auth", "status"] }],
    [
      ["mcp", "list", "--profile", "zai"],
      { command: "launch", options: {}, passthrough: ["mcp", "list", "--profile", "zai"] },
    ],
    [["-p", "hi", "--verbose"], { command: "launch", options: {}, passthrough: ["-p", "hi", "--verbose"] }],
    [
      ["login", "--api-key", "--no-store"],
      { command: "login", options: { apiKey: true, noStore: true }, passthrough: [] },
    ],
    [["status", "--json"], { command: "status", options: { json: true }, passthrough: [] }],
    [["logout"], { command: "logout", options: {}, passthrough: [] }],
    [["models"], { command: "models", options: {}, passthrough: [] }],
    [["--help"], { command: "help", options: {}, passthrough: [] }],
    [["-V"], { command: "version", options: {}, passthrough: [] }],
    [["--customize", "--login"], { command: "launch", options: { reconfigure: true, login: true }, passthrough: [] }],
    [
      ["--verbose", "--subagent-model=glm-5", "--fast-model", "f"],
      { command: "launch", options: { verbose: true, subagentModel: "glm-5", fastModel: "f" }, passthrough: [] },
    ],
    [
      ["profile", "add", "work", "--provider", "anthropic", "--share=none"],
      {
        command: "profile",
        options: { args: ["add", "work"], provider: "anthropic", share: "none" },
        passthrough: [],
      },
    ],
    [["profile", "list", "--json"], { command: "profile", options: { args: ["list"], json: true }, passthrough: [] }],
    [
      ["profile", "remove", "work", "--yes"],
      { command: "profile", options: { args: ["remove", "work"], yes: true }, passthrough: [] },
    ],
  ];
  for (const [argv, expected] of cases) {
    it(`parses ${JSON.stringify(argv)}`, () => {
      assert.deepEqual(parseArgs(argv), expected);
    });
  }
  it("rejects a value flag without a value", () => {
    assert.throws(() => parseArgs(["--profile"]), /needs a value/u);
    assert.throws(() => parseArgs(["--model", "--verbose"]), /needs a value/u);
  });
  it("rejects unknown arguments after a subcommand", () => {
    assert.throws(() => parseArgs(["login", "--bogus"]), /Unknown argument/u);
    assert.throws(() => parseArgs(["status", "extra"]), /Unknown argument/u);
    assert.throws(() => parseArgs(["profile", "--bogus"]), /Unknown argument/u);
  });
  it("collects positionals only for command groups", () => {
    assert.deepEqual(parseArgs(["profile", "show", "work"]).options.args, ["show", "work"]);
    assert.equal(parseArgs(["status", "--json"]).options.args, undefined);
  });
  it("help mentions the passthrough separator", () => {
    assert.match(HELP, /zclaude -- --help/u);
  });
});
