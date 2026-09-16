// Runs install.sh against this checkout (no network for zclaude itself; npm
// still fetches @inquirer/prompts) into a scratch HOME and checks the result.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { tempHome } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const skip = process.platform === "win32" ? "bash installer is not for Windows" : false;

function sh(args, env) {
  return new Promise((resolve) => {
    execFile("bash", args, { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

describe("install.sh", { skip }, () => {
  let home;
  let env;
  before(async () => {
    home = await tempHome();
    env = {
      PATH: process.env.PATH,
      HOME: home.dir,
      ZCLAUDE_INSTALL_SOURCE: root,
      ZCLAUDE_INSTALL_NO_CLAUDE: "1",
      ZCLAUDE_INSTALL_NO_RC: "1",
      NO_COLOR: "1",
    };
  });
  after(() => home.cleanup());

  it("installs from a local source, links the command, and is re-runnable", async () => {
    const first = await sh([join(root, "install.sh")], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stderr, /zclaude \d+\.\d+\.\d+ installed in .*\.zclaude\/app/u);
    assert.match(first.stderr, /Skipping Claude Code|Claude Code found/u);
    const link = join(home.dir, ".local", "bin", "zclaude");
    assert.equal(await readlink(link), join(home.dir, ".zclaude", "app", "zclaude"));
    assert.ok((await stat(join(home.dir, ".zclaude", "app", "node_modules", "@inquirer"))).isDirectory());
    const version = await new Promise((resolve) => {
      execFile(
        link,
        ["--version"],
        { env: { ...env, ZCLAUDE_CLAUDE_BIN: "/nonexistent" }, encoding: "utf8" },
        (error, stdout) => resolve(error ? `error ${error.code}` : stdout),
      );
    });
    assert.match(version, /^zclaude \d+\.\d+\.\d+/u);
    const again = await sh([join(root, "install.sh")], env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stderr, /installed in/u);
  });

  it("rejects unknown arguments and uninstalls cleanly", async () => {
    const bad = await sh([join(root, "install.sh"), "--bogus"], env);
    assert.equal(bad.code, 1);
    const gone = await sh([join(root, "install.sh"), "--uninstall"], env);
    assert.equal(gone.code, 0, gone.stderr);
    await assert.rejects(stat(join(home.dir, ".zclaude", "app")), /ENOENT/u);
    await assert.rejects(stat(join(home.dir, ".local", "bin", "zclaude")), /ENOENT/u);
    assert.match(gone.stderr, /Kept .*\.zclaude/u);
  });

  it("warns instead of editing rc files when told to, and appends once otherwise", async () => {
    const rc = join(home.dir, ".zshrc");
    await sh([join(root, "install.sh")], {
      ...env,
      ZCLAUDE_INSTALL_NO_RC: "",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    });
    const text = await readFile(rc, "utf8");
    assert.match(text, /export PATH=".*\.local\/bin:\$PATH" # added by the zclaude installer/u);
    await sh([join(root, "install.sh")], {
      ...env,
      ZCLAUDE_INSTALL_NO_RC: "",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    });
    assert.equal((await readFile(rc, "utf8")).split("zclaude installer").length, 2, "added only once");
  });
});
