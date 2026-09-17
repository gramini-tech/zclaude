// `zclaude sessions`, with the process table and the global login both faked.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { cmdSessions } from "../src/session-commands.js";
import { recordSession } from "../src/sessions/store.js";
import { startToken } from "../src/sessions/liveness.js";
import { tempHome } from "./helpers.js";

const NOW = Date.now();

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

/** A Keychain that holds nothing, so the global slot reads as empty. */
const security = async () => ({ code: 44, stdout: "", stderr: "" });

/** An empty process table, so the machine running the test is not part of it. */
const psImpl = async () => "";

const sessions = (env, options = {}) => capture(() => cmdSessions({ options, env }, { now: NOW, security, psImpl }));

function envFor(home) {
  return { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), NO_COLOR: "1", USER: "tester" };
}

describe("zclaude sessions", () => {
  it("says so plainly when nothing is running", async () => {
    const home = await tempHome();
    try {
      const result = await sessions(envFor(home));
      assert.match(result.err, /Nothing is running/u);
      assert.match(result.err, /this machine only/u, "the limit is stated rather than left to be discovered");
    } finally {
      await home.cleanup();
    }
  });

  it("lists a live session with its profile, pid and how long it has been quiet", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await recordSession(
        {
          profile: "work",
          account: "me@x.y",
          pid: process.pid,
          startToken: await startToken(process.pid),
          configDir: join(home.dir, "config"),
          cwd: "/repo",
        },
        { env, now: NOW - 30 * 60_000 },
      );
      const result = await sessions(env);
      assert.match(result.out, /^work\s+idle\s+pid \d+\s+30m ago\s+\/repo/mu);
    } finally {
      await home.cleanup();
    }
  });

  it("warns when one account is carrying several sessions", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      const token = await startToken(process.pid);
      for (const cwd of ["/one", "/two"]) {
        await recordSession(
          { profile: "work", account: "me@x.y", pid: process.pid, startToken: token, configDir: "/x", cwd },
          { env, now: NOW },
        );
      }
      const result = await sessions(env);
      assert.match(result.err, /"work" is running 2 sessions, which share one account's limits/u);
    } finally {
      await home.cleanup();
    }
  });

  it("answers in JSON, counted by profile", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await recordSession(
        {
          profile: "work",
          account: "me@x.y",
          pid: process.pid,
          startToken: await startToken(process.pid),
          configDir: "/x",
          cwd: "/repo",
        },
        { env, now: NOW },
      );
      const result = await sessions(env, { json: true });
      const payload = JSON.parse(result.out);
      const ours = payload.sessions.find((session) => session.tracked);
      assert.equal(ours.profile, "work");
      assert.equal(ours.state, "working");
      assert.ok(payload.byProfile.some(([name]) => name === "work"));
    } finally {
      await home.cleanup();
    }
  });
});
