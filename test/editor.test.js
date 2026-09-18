// Finding somebody's editor, and running it without handing their environment
// to a shell.

import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { onPath, resolveEditor, runEditor, tokenize } from "../src/editor.js";
import { tempHome } from "./helpers.js";

describe("splitting an editor command", () => {
  it("keeps the arguments people actually set", () => {
    assert.deepEqual(tokenize("code -w"), ["code", "-w"]);
    assert.deepEqual(tokenize("emacsclient -nw"), ["emacsclient", "-nw"]);
    assert.deepEqual(tokenize('"/Applications/My Editor" --wait'), ["/Applications/My Editor", "--wait"]);
    assert.deepEqual(tokenize("  vi   "), ["vi"]);
    assert.deepEqual(tokenize(undefined), []);
  });

  it("never lets the value become a shell command", () => {
    // $EDITOR comes from the environment and can hold a semicolon. Tokenized,
    // that is one absurd argument; handed to `shell: true`, it is a second
    // command running as you.
    assert.deepEqual(tokenize("vi; rm -rf ~"), ["vi;", "rm", "-rf", "~"]);
  });
});

describe("finding it", () => {
  it("prefers what the environment names, in order, and falls back", async () => {
    const home = await tempHome();
    try {
      const bin = join(home.dir, "bin");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(bin, { recursive: true });
      for (const name of ["ed-a", "ed-b", "nano"]) {
        await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n");
        await chmod(join(bin, name), 0o755);
      }
      const env = { PATH: bin };

      assert.equal(resolveEditor({ env: { ...env, EDITOR: "ed-b" } }).source, "EDITOR");
      const both = resolveEditor({ env: { ...env, VISUAL: "ed-a", EDITOR: "ed-b" } });
      assert.equal(both.source, "VISUAL", "VISUAL wins over EDITOR");
      assert.equal(resolveEditor({ env: { ...env, ZCLAUDE_EDITOR: "ed-a" } }).source, "ZCLAUDE_EDITOR");

      // A terminal editor first: a terminal command that pops a window is
      // surprising, and nano or vi exists nearly everywhere.
      const fallback = resolveEditor({ env, platform: "darwin" });
      assert.equal(fallback.source, "fallback");
      assert.match(fallback.argv[0], /nano$/u);

      // One that is set but not installed falls through rather than failing.
      assert.equal(resolveEditor({ env: { ...env, EDITOR: "not-installed" } }).source, "fallback");
      assert.equal(resolveEditor({ env: { PATH: "" }, platform: "darwin" }), null);
    } finally {
      await home.cleanup();
    }
  });

  it("takes an absolute path at its word, and only if it can be run", async () => {
    const home = await tempHome();
    try {
      const path = join(home.dir, "mine");
      await writeFile(path, "#!/bin/sh\nexit 0\n");
      assert.equal(onPath(path, {}), null, "written, but not executable");
      await chmod(path, 0o755);
      assert.equal(onPath(path, {}), path);
      assert.equal(onPath("", {}), null);
    } finally {
      await home.cleanup();
    }
  });
});

describe("running it", () => {
  it("passes the file last and waits for the exit code", async () => {
    const seen = [];
    const spawnImpl = (file, args) => {
      seen.push([file, ...args]);
      const child = {
        on(event, handler) {
          if (event === "exit") setImmediate(() => handler(0));
          return child;
        },
      };
      return child;
    };
    const code = await runEditor(["/bin/ed", "-w"], "/tmp/thing.json", { spawnImpl });
    assert.equal(code, 0);
    assert.deepEqual(seen, [["/bin/ed", "-w", "/tmp/thing.json"]]);
  });

  it("reports a failure to start rather than hanging", async () => {
    const spawnImpl = () => {
      const child = {
        on(event, handler) {
          if (event === "error") setImmediate(() => handler(new Error("ENOENT")));
          return child;
        },
      };
      return child;
    };
    assert.equal(await runEditor(["/nope"], "/tmp/x", { spawnImpl }), 1);
  });
});
