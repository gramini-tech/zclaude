// Finding VS Code-shaped editors and putting the extension into them.
//
// The editors are fakes on a scratch PATH and the `code` CLI is a stub
// function, so nothing here touches a real editor's extension directory.

import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { tempHome } from "./helpers.js";
import {
  editorPaths,
  EXTENSION_ID,
  findEditors,
  installEverywhere,
  installInto,
  installedVersion,
  packagedVersion,
  uninstallEverywhere,
  uninstallFrom,
  vsixPath,
} from "../src/vscode/index.js";

async function fakeEditors(home, names) {
  const bin = join(home.dir, "editors");
  await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

/** A `code` CLI that answers and records. */
function fakeCode(answers = {}) {
  const calls = [];
  const runImpl = async (bin, args) => {
    calls.push({ bin, args });
    const key = args[0];
    return answers[key] ?? { ok: true, code: 0, stdout: "", stderr: "" };
  };
  runImpl.calls = calls;
  return runImpl;
}

describe("finding editors", () => {
  it("finds every one of them on PATH, in the order they are declared", async () => {
    const home = await tempHome();
    try {
      const bin = await fakeEditors(home, ["cursor", "code", "codium"]);
      const editors = await findEditors({ env: { PATH: bin, HOME: home.dir }, platform: "linux" });
      assert.deepEqual(
        editors.map((editor) => editor.id),
        ["code", "cursor", "codium"],
      );
      assert.equal(editors[0].bin, join(bin, "code"));
      assert.equal(editors[0].label, "VS Code");
    } finally {
      await home.cleanup();
    }
  });

  it("finds one that is not on PATH, because a GUI install is not", async () => {
    const home = await tempHome();
    try {
      const app = join(home.dir, "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin");
      await mkdir(app, { recursive: true });
      await writeFile(join(app, "code"), "#!/bin/sh\nexit 0\n");
      await chmod(join(app, "code"), 0o755);
      const editors = await findEditors({ env: { PATH: "/nonexistent", HOME: home.dir }, platform: "darwin" });
      // A machine running this may have VS Code in /Applications, which is
      // checked first; either way the point is that PATH was not what found it.
      const found = editors.find((editor) => editor.id === "code");
      assert.ok(found, "the app bundle was not found");
      assert.match(found.bin, /Contents\/Resources\/app\/bin\/code$/u);
    } finally {
      await home.cleanup();
    }
  });

  it("finds nothing when there is nothing, rather than guessing", async () => {
    const home = await tempHome();
    try {
      assert.deepEqual(await findEditors({ env: { PATH: "", HOME: home.dir }, platform: "linux" }), []);
    } finally {
      await home.cleanup();
    }
  });

  it("looks in the platform's own places", () => {
    const editor = { id: "code", app: "Visual Studio Code" };
    const mac = editorPaths(editor, { HOME: "/Users/x" }, "darwin");
    assert.ok(mac.some((path) => path.startsWith("/Applications/Visual Studio Code.app")));
    const windows = editorPaths(editor, { HOME: "C:\\Users\\x", LOCALAPPDATA: "C:\\local" }, "win32");
    assert.ok(windows.every((path) => path.endsWith("code.cmd")));
    const linux = editorPaths(editor, { HOME: "/home/x" }, "linux");
    assert.ok(linux.includes("/snap/bin/code"));
  });
});

describe("installing the extension", () => {
  const editor = { id: "code", label: "VS Code", bin: "/fake/code" };

  it("installs the packaged vsix with --force, so an update replaces it", async () => {
    const runImpl = fakeCode();
    const result = await installInto(editor, { runImpl });
    assert.ok(result.ok);
    assert.deepEqual(runImpl.calls[0].args, ["--install-extension", vsixPath(), "--force"]);
  });

  it("refuses when the vsix is missing instead of calling the editor", async () => {
    const runImpl = fakeCode();
    const result = await installInto(editor, { runImpl, vsix: "/nope/zclaude.vsix" });
    assert.equal(result.ok, false);
    assert.match(result.detail, /packaged extension is missing/u);
    assert.equal(runImpl.calls.length, 0);
  });

  it("reports what the editor said when it fails", async () => {
    const runImpl = fakeCode({
      "--install-extension": { ok: false, code: 1, stdout: "", stderr: "Unable to install extension" },
    });
    const result = await installInto(editor, { runImpl });
    assert.equal(result.ok, false);
    assert.match(result.detail, /Unable to install/u);
  });

  it("reads the installed version out of --list-extensions", async () => {
    const runImpl = fakeCode({
      "--list-extensions": {
        ok: true,
        code: 0,
        stdout: `anthropic.claude-code@1.0.0\n${EXTENSION_ID}@0.1.0\nvscodevim.vim@1.2.3\n`,
        stderr: "",
      },
    });
    assert.deepEqual(await installedVersion(editor, { runImpl }), { state: "installed", version: "0.1.0" });
  });

  it("says absent when the editor lists other extensions", async () => {
    const runImpl = fakeCode({
      "--list-extensions": { ok: true, code: 0, stdout: "vscodevim.vim@1.2.3\n", stderr: "" },
    });
    assert.deepEqual(await installedVersion(editor, { runImpl }), { state: "absent" });
  });

  it("says unknown, with the reason, when the editor cannot be asked", async () => {
    const runImpl = fakeCode({
      "--list-extensions": { ok: false, code: 127, stdout: "", stderr: "command not found" },
    });
    const state = await installedVersion(editor, { runImpl });
    assert.equal(state.state, "unknown");
    assert.match(state.detail, /command not found/u);
  });

  it("treats 'was not installed' as a successful uninstall", async () => {
    const runImpl = fakeCode({
      "--uninstall-extension": {
        ok: false,
        code: 1,
        stdout: "",
        stderr: `Extension '${EXTENSION_ID}' is not installed.`,
      },
    });
    assert.deepEqual(await uninstallFrom(editor, { runImpl }), { ok: true, removed: false });
  });

  it("removes it by identifier, not by path", async () => {
    const runImpl = fakeCode();
    const result = await uninstallFrom(editor, { runImpl });
    assert.deepEqual(result.ok && runImpl.calls[0].args, ["--uninstall-extension", EXTENSION_ID]);
    assert.equal(result.removed, true);
  });

  it("walks every editor found, and reports each one", async () => {
    const home = await tempHome();
    try {
      const bin = await fakeEditors(home, ["code", "windsurf"]);
      const runImpl = fakeCode();
      const env = { PATH: bin, HOME: home.dir };
      const installed = await installEverywhere({ env, platform: "linux", runImpl });
      assert.deepEqual(
        installed.map((result) => [result.editor.id, result.ok]),
        [
          ["code", true],
          ["windsurf", true],
        ],
      );
      const removed = await uninstallEverywhere({ env, platform: "linux", runImpl });
      assert.equal(removed.length, 2);
      assert.ok(removed.every((result) => result.removed));
    } finally {
      await home.cleanup();
    }
  });
});

describe("the packaged extension", () => {
  it("carries the version the manifest says", async () => {
    assert.match(await packagedVersion(), /^\d+\.\d+\.\d+$/u);
  });

  it("is where the installer looks for it", () => {
    assert.match(vsixPath(), /extension[/\\]zclaude\.vsix$/u);
  });
});
