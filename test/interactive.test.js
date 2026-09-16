// Drives the real binary inside a pseudo-terminal (macOS `script`) so the
// inquirer menu is exercised the way a user sees it: keystrokes, Enter, Ctrl-C.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { createServer } from "node:http";

import { tempHome } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/zclaude.js", import.meta.url));

function hasScript() {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("which", ["script"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run zclaude in a pty. `keys` is a list of [delayMs, text] to type. macOS
 * script(1) rejects sockets on stdin (what Node's "pipe" gives it), so the
 * keystrokes are fed through a bash pipeline instead.
 */
function runInPty({ args, env, keys, log }) {
  const typing = [...keys, [500, ""]]
    .map(([delay, text]) => {
      const octal = [...text].map((ch) => `\\${ch.codePointAt(0).toString(8).padStart(3, "0")}`).join("");
      return `sleep ${(delay / 1000).toFixed(2)}; printf '%b' '${octal}'`;
    })
    .join("; ");
  const quoted = [process.execPath, BIN, ...args].map((part) => `'${part.replaceAll("'", `'"'"'`)}'`).join(" ");
  const command = `( ${typing} ) | script -q '${log}' ${quoted} >/dev/null 2>&1`;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { env, stdio: "ignore", detached: true });
    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 20_000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve(code);
    });
  });
}

const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;?]*[a-zA-Z]`, "gu");
const clean = (text) => text.replaceAll("\r", "").replaceAll(ANSI, "");

describe("interactive (pseudo-terminal)", { skip: !hasScript() && "needs macOS script(1)" }, () => {
  let home;
  let env;
  let capture;
  before(async () => {
    home = await tempHome();
    const bin = join(home.dir, "bin");
    await mkdir(bin, { recursive: true });
    capture = join(home.dir, "ran.txt");
    await writeFile(join(bin, "claude"), `#!/bin/sh\necho "ran $*" > "${capture}"\n`);
    await chmod(join(bin, "claude"), 0o755);
    env = {
      PATH: process.env.PATH,
      HOME: home.dir,
      TERM: "xterm-256color",
      ZCLAUDE_HOME: join(home.dir, ".zclaude"),
      ZCLAUDE_NO_KEYCHAIN: "1",
      ZCLAUDE_CLAUDE_BIN: join(bin, "claude"),
      ZCLAUDE_NO_BANNER: "1",
    };
  });
  after(() => home.cleanup());

  it("shows the menu, Enter picks Claude Code and launches it", async () => {
    const log = join(home.dir, "menu.log");
    const code = await runInPty({ args: ["--", "--from-test"], env, keys: [[1500, "\r"]], log });
    assert.equal(code, 0);
    const out = clean(await readFile(log, "utf8"));
    assert.match(out, /What do you want to launch\?/u);
    assert.match(out, /Claude Code \+ Z\.ai GLM Coding Plan/u);
    assert.equal((await readFile(capture, "utf8")).trim(), "ran --from-test");
  });

  it("login --api-key continues into the wizard and launches claude", async () => {
    const key = "0123456789abcdef0123.ABCDEFGHIJKLMNOPQRSTUV";
    const zai = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url === "/api/coding/paas/v4/models") {
        response.end(JSON.stringify({ object: "list", data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }] }));
        return;
      }
      response.end(JSON.stringify({ code: 200, data: { level: "pro", limits: [] } }));
    });
    await new Promise((resolve) => {
      zai.listen(0, "127.0.0.1", resolve);
    });
    try {
      const log = join(home.dir, "login.log");
      await writeFile(capture, "");
      const keys = [
        [1500, `${key}\r`], // paste the key
        [1500, "\r"], // launch now (default)
        [1200, "\r"], // primary model
        [800, "\r"], // subagent model
        [800, "\r"], // fast model
        [800, "\r"], // save as user default
      ];
      const code = await runInPty({
        args: ["login", "--api-key"],
        env: { ...env, ZCLAUDE_BASE_URL: `http://127.0.0.1:${zai.address().port}` },
        keys,
        log,
      });
      const out = clean(await readFile(log, "utf8"));
      assert.equal(code, 0, out.slice(-600));
      assert.match(out, /Launch Claude Code on Z\.ai now\?/u);
      assert.match(out, /Primary model/u);
      assert.match(out, /Saved to .*settings/u);
      assert.equal((await readFile(capture, "utf8")).trim(), "ran");
      assert.match(await readFile(join(env.ZCLAUDE_HOME, "settings"), "utf8"), /ZCLAUDE_MODEL=glm-5\.3\n/u);
    } finally {
      zai.close();
    }
  });

  it("profile add walks the wizard and registers the profile", async () => {
    const down = `${String.fromCodePoint(27)}[B`;
    const log = join(home.dir, "profile-add.log");
    const code = await runInPty({
      args: ["profile", "add"],
      env,
      keys: [
        [1500, "work\r"], // name
        [1200, "\r"], // provider: an Anthropic account
        [1000, "\r"], // sharing: settings and history
        [1000, `${down}\r`], // sign in: later
      ],
      log,
    });
    const out = clean(await readFile(log, "utf8"));
    assert.equal(code, 0, out.slice(-600));
    assert.match(out, /Name for this profile/u);
    assert.match(out, /What does this profile sign in to\?/u);
    assert.match(out, /What should this profile share/u);
    assert.match(out, /Sign in to "work" now\?/u);
    assert.match(out, /Created profile "work"/u);
    const registry = JSON.parse(await readFile(join(env.ZCLAUDE_HOME, "profiles.json"), "utf8"));
    assert.equal(registry.profiles.work.provider, "anthropic");
    assert.deepEqual(registry.profiles.work.share, { config: true, history: true });
  });

  it("Ctrl-C part way through the wizard creates nothing", async () => {
    const log = join(home.dir, "profile-cancel.log");
    const code = await runInPty({
      args: ["profile", "add"],
      env,
      keys: [
        [1500, "abandoned\r"], // name
        [1200, String.fromCodePoint(3)], // Ctrl-C at the provider question
      ],
      log,
    });
    assert.equal(code, 130, clean(await readFile(log, "utf8")).slice(-400));
    const registry = JSON.parse(await readFile(join(env.ZCLAUDE_HOME, "profiles.json"), "utf8"));
    assert.equal(registry.profiles.abandoned, undefined);
    await assert.rejects(readFile(join(env.ZCLAUDE_HOME, "profiles", "abandoned", "home", ".claude.json")));
  });

  it("Ctrl-C at the remove confirmation keeps the profile", async () => {
    const log = join(home.dir, "profile-remove.log");
    const code = await runInPty({
      args: ["profile", "remove", "work"],
      env,
      keys: [[1500, String.fromCodePoint(3)]],
      log,
    });
    const out = clean(await readFile(log, "utf8"));
    assert.equal(code, 130, out.slice(-400));
    assert.match(out, /Remove profile "work"\?/u);
    assert.match(out, /left alone/u, "the prompt says what survives; it wraps in a narrow terminal");
    const registry = JSON.parse(await readFile(join(env.ZCLAUDE_HOME, "profiles.json"), "utf8"));
    assert.ok(registry.profiles.work, "the profile survives a cancelled removal");
  });

  it("exits 130 on Ctrl-C at the menu", async () => {
    const log = join(home.dir, "ctrlc.log");
    const code = await runInPty({ args: ["--", "--never"], env, keys: [[1500, ""]], log });
    assert.equal(code, 130);
  });
});
