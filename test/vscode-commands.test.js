// The `zclaude vscode` command surface, against fake editors on a scratch PATH.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { tempHome } from "./helpers.js";
import { cmdVscodeGroup } from "../src/vscode-commands.js";

/**
 * A `code` that records what it was asked and answers from a script. It has to
 * be a real executable: the command group finds editors on PATH by looking at
 * the filesystem, exactly as it would on a real machine.
 */
async function fakeEditors(home, names, { listing = "" } = {}) {
  const bin = join(home.dir, "editors");
  const calls = join(home.dir, "calls.txt");
  await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh
echo "${name} $*" >> "${calls}"
case "$1" in
  --list-extensions) printf '%b' '${listing}' ;;
esac
exit 0
`,
    );
    await chmod(join(bin, name), 0o755);
  }
  return { bin, calls: () => readFile(calls, "utf8").catch(() => "") };
}

async function capture(run) {
  const chunks = { out: "", err: "" };
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (text) => {
    chunks.out += text;
    return true;
  };
  process.stderr.write = (text) => {
    chunks.err += text;
    return true;
  };
  try {
    const value = await run();
    return { ...chunks, value };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
}

const vscode = (args, { env, options = {} }) =>
  capture(() => cmdVscodeGroup({ options: { args, ...options }, env }, { platform: "linux" }));

describe("zclaude vscode", () => {
  it("installs into every editor it finds, and says to reload", async () => {
    const home = await tempHome();
    try {
      const editors = await fakeEditors(home, ["code", "cursor"]);
      const env = { PATH: editors.bin, HOME: home.dir, NO_COLOR: "1" };
      const result = await vscode(["install"], { env });
      assert.match(result.err, /Installed zclaude \d+\.\d+\.\d+ into VS Code\./u);
      assert.match(result.err, /into Cursor\./u);
      assert.match(result.err, /Reload the editor window/u);
      const calls = await editors.calls();
      assert.match(calls, /code --install-extension .*zclaude\.vsix --force/u);
      assert.match(calls, /cursor --install-extension/u);
    } finally {
      await home.cleanup();
    }
  });

  it("says so plainly when there is no editor at all", async () => {
    const home = await tempHome();
    try {
      const env = { PATH: join(home.dir, "empty"), HOME: home.dir, NO_COLOR: "1" };
      const result = await vscode(["install"], { env });
      assert.match(result.err, /No VS Code-shaped editor was found/u);
      assert.match(result.err, /code, code-insiders, cursor, windsurf and codium/u);
    } finally {
      await home.cleanup();
    }
  });

  it("reports which editors have it, and at which version", async () => {
    const home = await tempHome();
    try {
      const editors = await fakeEditors(home, ["code"], {
        listing: "gramini-labs.zclaude@0.0.1\\nvscodevim.vim@1.0.0\\n",
      });
      const env = { PATH: editors.bin, HOME: home.dir, NO_COLOR: "1" };
      const result = await vscode(["status"], { env });
      assert.match(result.err, /VS Code\s+0\.0\.1\s+\(older than the packaged one\)/u);
      assert.match(result.err, /zclaude vscode install/u);
    } finally {
      await home.cleanup();
    }
  });

  it("answers status in JSON, with the path to the packaged vsix", async () => {
    const home = await tempHome();
    try {
      const editors = await fakeEditors(home, ["code"]);
      const env = { PATH: editors.bin, HOME: home.dir, NO_COLOR: "1" };
      const result = await vscode(["status"], { env, options: { json: true } });
      const payload = JSON.parse(result.out);
      assert.equal(payload.extension, "gramini-labs.zclaude");
      assert.match(payload.vsix, /zclaude\.vsix$/u);
      assert.deepEqual(payload.editors[0].id, "code");
      assert.equal(payload.editors[0].state, "absent");
    } finally {
      await home.cleanup();
    }
  });

  it("removes it by identifier", async () => {
    const home = await tempHome();
    try {
      const editors = await fakeEditors(home, ["code"]);
      const env = { PATH: editors.bin, HOME: home.dir, NO_COLOR: "1" };
      const result = await vscode(["uninstall"], { env });
      assert.match(result.err, /Removed gramini-labs\.zclaude from VS Code/u);
      assert.match(await editors.calls(), /code --uninstall-extension gramini-labs\.zclaude/u);
    } finally {
      await home.cleanup();
    }
  });

  it("needs a subcommand, and rejects one it does not have", async () => {
    const home = await tempHome();
    try {
      const env = { PATH: "", HOME: home.dir, NO_COLOR: "1" };
      await assert.rejects(vscode([], { env }), /needs a subcommand/u);
      await assert.rejects(vscode(["frobnicate"], { env }), /is not a command/u);
    } finally {
      await home.cleanup();
    }
  });
});
