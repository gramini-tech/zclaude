// Runs install.sh against this checkout (no network for zclaude itself; npm
// still fetches @inquirer/prompts) into a scratch HOME and checks the result.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readlink, stat, writeFile } from "node:fs/promises";
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
      ZCLAUDE_NO_KEYCHAIN: "1",
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

  it("survives repeated install and uninstall cycles", async () => {
    const link = join(home.dir, ".local", "bin", "zclaude");
    const app = join(home.dir, ".zclaude", "app");
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const installed = await sh([join(root, "install.sh")], env);
      assert.equal(installed.code, 0, `cycle ${cycle} install: ${installed.stderr}`);
      assert.ok((await stat(link)).isFile() || (await stat(link)).isSymbolicLink());
      const removed = await sh([join(root, "install.sh"), "--uninstall"], env);
      assert.equal(removed.code, 0, `cycle ${cycle} uninstall: ${removed.stderr}`);
      await assert.rejects(stat(app), /ENOENT/u, `cycle ${cycle} left the app directory`);
      await assert.rejects(readlink(link), /ENOENT/u, `cycle ${cycle} left a dangling command`);
    }
    await sh([join(root, "install.sh")], env);
  });

  it("links into a directory already on PATH so the command works at once", async () => {
    const binDir = join(home.dir, ".local", "bin");
    const onPath = await sh([join(root, "install.sh")], { ...env, PATH: `${binDir}:${process.env.PATH}` });
    assert.equal(onPath.code, 0, onPath.stderr);
    assert.match(onPath.stderr, /Ready\. Run: zclaude/u);
    assert.equal(await readlink(join(binDir, "zclaude")), join(home.dir, ".zclaude", "app", "zclaude"));
  });

  it("rejects unknown arguments and uninstalls cleanly", async () => {
    const bad = await sh([join(root, "install.sh"), "--bogus"], env);
    assert.equal(bad.code, 1);
    const gone = await sh([join(root, "install.sh"), "--uninstall"], env);
    assert.equal(gone.code, 0, gone.stderr);
    await assert.rejects(stat(join(home.dir, ".zclaude", "app")), /ENOENT/u);
    await assert.rejects(stat(join(home.dir, ".local", "bin", "zclaude")), /ENOENT/u);
    await assert.rejects(stat(join(home.dir, ".zclaude")), /ENOENT/u, "settings and logs are purged by default");
    assert.match(gone.stderr, /gone from this machine/u);
  });

  it("keeps settings with --keep-config", async () => {
    await sh([join(root, "install.sh")], env);
    const settings = join(home.dir, ".zclaude", "settings");
    await writeFile(settings, "ZCLAUDE_MODEL=glm-5.3\n");
    const kept = await sh([join(root, "install.sh"), "--uninstall", "--keep-config"], env);
    assert.equal(kept.code, 0, kept.stderr);
    assert.equal(await readFile(settings, "utf8"), "ZCLAUDE_MODEL=glm-5.3\n");
    await assert.rejects(stat(join(home.dir, ".zclaude", "app")), /ENOENT/u);
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
