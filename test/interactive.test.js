// Drives the real binary inside a pseudo-terminal (macOS `script`) so the
// inquirer menu is exercised the way a user sees it: keystrokes, Enter, Ctrl-C.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

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

  it("exits 130 on Ctrl-C at the menu", async () => {
    const log = join(home.dir, "ctrlc.log");
    const code = await runInPty({ args: ["--", "--never"], env, keys: [[1500, ""]], log });
    assert.equal(code, 130);
  });
});
