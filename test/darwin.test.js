import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  APP_PREFIX,
  BUNDLE_PREFIX,
  callbackAppleScript,
  createNativeReceiver,
  isManagedJournal,
  journalPath,
  recoverStaleHandler,
  restoreTarget,
} from "../src/callback/darwin.js";
import { tempHome } from "./helpers.js";

describe("callbackAppleScript", () => {
  it("writes the URL to the file, restores the handler and quits", () => {
    const lines = callbackAppleScript("/tmp/x y/callback.url", "zcode", "com.example.previous");
    assert.equal(lines[0], "on open location theURL");
    assert.match(lines[1], /POSIX file "\/tmp\/x y\/callback.url"/u);
    assert.ok(lines.some((line) => line.startsWith("do shell script") && line.includes("com.example.previous")));
    assert.equal(lines.at(-2), "quit");
    assert.equal(lines.at(-1), "end open location");
  });
  it("escapes quotes in paths", () => {
    const lines = callbackAppleScript('/tmp/q"uote/cb', "zcode", "");
    assert.ok(lines[1].includes('\\"'));
    assert.ok(lines.some((line) => line.includes("'none'")));
  });
});

describe("journal and restore rules", () => {
  const home = "/Users/test";
  const good = {
    appPath: `${home}/Applications/${APP_PREFIX}abc.app`,
    bundleId: `${BUNDLE_PREFIX}abc`,
    pid: 1,
    previousHandler: "",
    scheme: "zcode",
  };
  it("accepts only our own app under ~/Applications", () => {
    assert.equal(isManagedJournal(good, home), true);
    assert.equal(isManagedJournal({ ...good, appPath: "/Applications/Safari.app" }, home), false);
    assert.equal(isManagedJournal({ ...good, bundleId: "com.apple.Safari" }, home), false);
    assert.equal(
      isManagedJournal({ ...good, appPath: `${home}/Applications/../Desktop/${APP_PREFIX}x.app` }, home),
      false,
    );
    assert.equal(isManagedJournal(null, home), false);
  });
  it("restores real handlers and clears dangling temporary ones", () => {
    assert.equal(restoreTarget("com.zai.zcode"), "com.zai.zcode");
    assert.equal(restoreTarget(""), "none");
    assert.equal(restoreTarget(`${BUNDLE_PREFIX}old`), "none");
    assert.equal(restoreTarget("dev.omp.oauth-callback.66ce2b2f"), "none");
    assert.equal(restoreTarget("dev.zcode.cli.oauth-callback.x"), "none");
  });
});

describe("recoverStaleHandler", () => {
  it("restores the previous handler and removes leftovers when the owner is dead", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude") };
      const appPath = join(home.dir, "Applications", `${APP_PREFIX}dead.app`);
      await mkdir(appPath, { recursive: true });
      await mkdir(env.ZCLAUDE_HOME, { recursive: true });
      const record = {
        appPath,
        bundleId: `${BUNDLE_PREFIX}dead`,
        pid: 999_999_999,
        previousHandler: "com.zai.zcode",
        scheme: "zcode",
      };
      await writeFile(journalPath(env), JSON.stringify(record));
      const calls = [];
      const runner = async (command, args) => {
        calls.push([command, args]);
        if (args.includes("-l") && args[3].includes("URLForApplicationToOpenURL"))
          return { code: 0, stdout: `${record.bundleId}\n`, stderr: "" };
        return { code: 0, stdout: "0\n", stderr: "" };
      };
      await recoverStaleHandler({ env, home: home.dir, runner });
      const setCall = calls.find(
        ([, args]) =>
          args.includes("LSSetDefaultHandlerForURLScheme") ||
          (args[3] ?? "").includes("LSSetDefaultHandlerForURLScheme"),
      );
      assert.ok(setCall, "handler restored");
      assert.equal(setCall[1].at(-1), "com.zai.zcode");
      assert.ok(calls.some(([command, args]) => command.endsWith("lsregister") && args[0] === "-u"));
      await assert.rejects(readFile(journalPath(env)), /ENOENT/u);
      await assert.rejects(readFile(join(appPath, "Contents")), /ENOENT/u);
    } finally {
      await home.cleanup();
    }
  });
  it("refuses to run while another login is alive", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude") };
      await mkdir(env.ZCLAUDE_HOME, { recursive: true });
      const record = {
        appPath: join(home.dir, "Applications", `${APP_PREFIX}live.app`),
        bundleId: `${BUNDLE_PREFIX}live`,
        pid: process.ppid,
        previousHandler: "",
        scheme: "zcode",
      };
      await writeFile(journalPath(env), JSON.stringify(record));
      await assert.rejects(
        recoverStaleHandler({ env, home: home.dir, runner: async () => ({ code: 0, stdout: "", stderr: "" }) }),
        /already waiting/u,
      );
    } finally {
      await home.cleanup();
    }
  });
  it("ignores journals it does not own", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude") };
      await mkdir(env.ZCLAUDE_HOME, { recursive: true });
      await writeFile(
        journalPath(env),
        JSON.stringify({
          appPath: "/Applications/Safari.app",
          bundleId: "com.apple.Safari",
          pid: 1,
          previousHandler: "",
          scheme: "zcode",
        }),
      );
      let ran = false;
      await recoverStaleHandler({
        env,
        home: home.dir,
        runner: async () => {
          ran = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(ran, false);
      await assert.rejects(readFile(journalPath(env)), /ENOENT/u);
    } finally {
      await home.cleanup();
    }
  });
});

describe("createNativeReceiver", () => {
  it("rejects off macOS and on bad schemes without touching the system", async () => {
    await assert.rejects(createNativeReceiver({ scheme: "zcode", platform: "linux" }), /only available on macOS/u);
    await assert.rejects(
      createNativeReceiver({
        scheme: "Bad Scheme",
        platform: "darwin",
        runner: async () => {
          throw new Error("must not run");
        },
      }),
      /invalid scheme/u,
    );
  });
  it("cleans up when a setup step fails", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude") };
      const calls = [];
      const runner = async (command, args) => {
        calls.push([command, args]);
        if (command.endsWith("osacompile")) return { code: 1, stdout: "", stderr: "syntax error" };
        if ((args[3] ?? "").includes("URLForApplicationToOpenURL"))
          return { code: 0, stdout: "com.zai.zcode\n", stderr: "" };
        return { code: 0, stdout: "0\n", stderr: "" };
      };
      await assert.rejects(
        createNativeReceiver({ scheme: "zcode", platform: "darwin", env, home: home.dir, runner }),
        /compiling the callback app: osacompile failed: syntax error/u,
      );
      assert.ok(
        calls.every(([, args]) => !(args[3] ?? "").includes("LSSetDefaultHandlerForURLScheme")),
        "handler never changed",
      );
      await assert.rejects(readFile(journalPath(env)), /ENOENT/u);
    } finally {
      await home.cleanup();
    }
  });
});
