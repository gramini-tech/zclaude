// Knowing which accounts are busy.
//
// The processes are fakes: a test that started real `claude` sessions to prove
// it can see them would be testing the machine it runs on.

import assert from "node:assert/strict";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { activityState, IDLE_AFTER_MS, lastActivity, projectSlug } from "../src/sessions/activity.js";
import { claudeProcesses, pidExists, startToken, stillRunning } from "../src/sessions/liveness.js";
import { busyMarker, byProfile, liveSessions, untrackedSessions } from "../src/sessions/index.js";
import { forgetSession, readSessions, recordSession, sessionsDir } from "../src/sessions/store.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;

function env(home) {
  return { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude") };
}

const fields = (overrides = {}) => ({
  profile: "work",
  account: "me@x.y",
  pid: 4321,
  startToken: "Thu Sep 17 10:00:00 2026",
  configDir: "/x/work",
  cwd: "/repo",
  ...overrides,
});

describe("the session record", () => {
  it("writes one file per session, so two launches cannot race", async () => {
    const home = await tempHome();
    try {
      const options = { env: env(home), now: NOW };
      const first = await recordSession(fields(), options);
      const second = await recordSession(fields({ pid: 4322 }), { ...options, now: NOW + 1 });
      assert.notEqual(first.id, second.id);
      const dir = sessionsDir(env(home));
      assert.equal((await readdir(dir)).length, 2);
      assert.deepEqual(
        (await readSessions({ env: env(home) })).map((record) => record.pid),
        [4321, 4322],
        "oldest first",
      );
    } finally {
      await home.cleanup();
    }
  });

  it("forgets one without disturbing the others", async () => {
    const home = await tempHome();
    try {
      const options = { env: env(home), now: NOW };
      const first = await recordSession(fields(), options);
      await recordSession(fields({ pid: 4322 }), options);
      await forgetSession(first.id, { env: env(home) });
      assert.deepEqual(
        (await readSessions({ env: env(home) })).map((record) => record.pid),
        [4322],
      );
      await forgetSession("never-existed", { env: env(home) });
    } finally {
      await home.cleanup();
    }
  });

  it("throws away a file it cannot parse rather than failing the command", async () => {
    const home = await tempHome();
    try {
      const dir = sessionsDir(env(home));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "torn.json"), "{ half written");
      assert.deepEqual(await readSessions({ env: env(home) }), []);
      assert.deepEqual(await readdir(dir), [], "the unreadable file is gone, not left to fail again");
    } finally {
      await home.cleanup();
    }
  });

  it("reports nothing rather than failing when there is no directory yet", async () => {
    const home = await tempHome();
    try {
      assert.deepEqual(await readSessions({ env: env(home) }), []);
    } finally {
      await home.cleanup();
    }
  });
});

describe("is it still running", () => {
  it("knows this process is", () => {
    assert.equal(pidExists(process.pid), true);
    assert.equal(pidExists(0), false);
    assert.equal(pidExists(-1), false);
    assert.equal(pidExists(NaN), false);
  });

  // The case the whole design turns on: pids are recycled, and a record from
  // last week that names a live pid must not claim an account is busy.
  it("refuses a recycled pid whose process started at a different time", async () => {
    const kill = () => true;
    const psImpl = async () => "Thu Sep 17 14:00:00 2026\n";
    const record = { pid: 4321, startToken: "Thu Sep 10 09:00:00 2026" };
    assert.equal(await stillRunning(record, { kill, psImpl }), false);
    assert.equal(await stillRunning({ ...record, startToken: "Thu Sep 17 14:00:00 2026" }, { kill, psImpl }), true);
  });

  it("trusts the pid alone for a record written before tokens existed", async () => {
    const kill = () => true;
    const psImpl = async () => "";
    assert.equal(await stillRunning({ pid: 4321 }, { kill, psImpl }), true);
  });

  it("says no when the pid is gone, without asking ps at all", async () => {
    let asked = false;
    const kill = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const psImpl = async () => {
      asked = true;
      return "";
    };
    assert.equal(await stillRunning({ pid: 4321, startToken: "x" }, { kill, psImpl }), false);
    assert.equal(asked, false);
  });

  it("reads a start time for a real process", async () => {
    assert.match(await startToken(process.pid), /\d{4}/u);
    assert.equal(await startToken(0), null);
  });
});

describe("which processes are sessions", () => {
  const ps = (text) => async () => text;

  it("finds the CLI and ignores the desktop app, which is not a session", async () => {
    const found = await claudeProcesses({
      psImpl: ps(
        [
          "  101 claude --resume abc",
          "  102 /Applications/Claude.app/Contents/MacOS/Claude",
          "  103 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu",
          "  104 /Users/x/.vscode/extensions/anthropic.claude-code/resources/native-binary/claude --output-format stream-json",
        ].join("\n"),
      ),
    });
    assert.deepEqual(
      found.map((entry) => entry.pid),
      [101, 104],
    );
  });

  it("ignores the helpers that run for ever without spending anything", async () => {
    const found = await claudeProcesses({
      psImpl: ps(["  201 /Users/x/.local/bin/claude --chrome-native-host", "  202 claude mcp serve"].join("\n")),
    });
    assert.deepEqual(found, []);
  });

  it("survives a ps that fails entirely", async () => {
    assert.deepEqual(await claudeProcesses({ psImpl: async () => "" }), []);
  });
});

describe("working or resting", () => {
  it("turns a working directory into the name Claude Code files it under", () => {
    assert.equal(projectSlug("/Users/vipinr/work/vipinr/zclaude"), "-Users-vipinr-work-vipinr-zclaude");
    assert.equal(projectSlug(""), "");
  });

  it("reads the transcript's mtime, which is when the account last did anything", async () => {
    const home = await tempHome();
    try {
      const dir = join(home.dir, "config", "projects", projectSlug("/repo"));
      await mkdir(dir, { recursive: true });
      const transcript = join(dir, "session.jsonl");
      await writeFile(transcript, "{}\n");
      const when = new Date(NOW);
      await utimes(transcript, when, when);
      const at = await lastActivity({ configDir: join(home.dir, "config"), cwd: "/repo" });
      assert.equal(Math.round(at), NOW);
    } finally {
      await home.cleanup();
    }
  });

  it("falls back to the other projects when the session's own is not there", async () => {
    const home = await tempHome();
    try {
      const dir = join(home.dir, "config", "projects", "-somewhere-else");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "session.jsonl"), "{}\n");
      const when = new Date(NOW);
      await utimes(join(dir, "session.jsonl"), when, when);
      const at = await lastActivity({ configDir: join(home.dir, "config"), cwd: "/repo" });
      assert.equal(Math.round(at), NOW, "a session that changed directory is still a session");
    } finally {
      await home.cleanup();
    }
  });

  it("reports nothing when there is no transcript to read", async () => {
    const home = await tempHome();
    try {
      assert.equal(await lastActivity({ configDir: join(home.dir, "nope"), cwd: "/repo" }), 0);
    } finally {
      await home.cleanup();
    }
  });

  it("calls a quiet session idle and a busy one working", () => {
    assert.equal(activityState(NOW - 1000, NOW - 100_000, NOW), "working");
    assert.equal(activityState(NOW - IDLE_AFTER_MS - 1000, NOW - 100_000, NOW), "idle");
    // No transcript at all: judged on when it started, so a session opened
    // seconds ago is not called idle before it has had a chance to do anything.
    assert.equal(activityState(0, NOW - 1000, NOW), "working");
    assert.equal(activityState(0, NOW - IDLE_AFTER_MS - 1000, NOW), "idle");
  });
});

describe("what is live", () => {
  it("clears away the records whose processes are gone", async () => {
    const home = await tempHome();
    try {
      const options = { env: env(home), now: NOW };
      await recordSession(fields({ pid: process.pid, startToken: await startToken(process.pid) }), options);
      await recordSession(fields({ pid: 999_999, profile: "ghost" }), options);
      const live = await liveSessions({ env: env(home), now: NOW });
      assert.deepEqual(
        live.map((session) => session.profile),
        ["work"],
      );
      const left = await readdir(sessionsDir(env(home)));
      assert.equal(left.length, 1, "the dead record is reaped as it is noticed");
    } finally {
      await home.cleanup();
    }
  });

  it("leaves the records alone when asked not to reap", async () => {
    const home = await tempHome();
    try {
      await recordSession(fields({ pid: 999_999 }), { env: env(home), now: NOW });
      await liveSessions({ env: env(home), now: NOW, reap: false });
      const kept = await readdir(sessionsDir(env(home)));
      assert.equal(kept.length, 1);
    } finally {
      await home.cleanup();
    }
  });

  it("puts everything it did not start on the account holding the global login", async () => {
    const ours = [{ pid: process.pid }];
    const others = await untrackedSessions({ ours, owner: "gramini", account: "me@x.y" });
    assert.ok(others.every((session) => session.profile === "gramini"));
    assert.ok(others.every((session) => session.tracked === false && session.state === "unknown"));
    assert.ok(
      others.every((session) => session.pid !== process.pid),
      "our own process is not somebody else's session",
    );
  });
});

describe("what a row says about it", () => {
  const counts = (overrides) => ({ working: 0, idle: 0, unknown: 0, total: 0, newest: 0, ...overrides });

  it("counts by profile, keeping the states apart", () => {
    const grouped = byProfile([
      { profile: "work", state: "working", lastActiveAt: NOW, startedAt: 0 },
      { profile: "work", state: "idle", lastActiveAt: NOW - 100, startedAt: 0 },
      { profile: "home", state: "unknown", lastActiveAt: 0, startedAt: NOW },
      { profile: null, state: "working", lastActiveAt: 0, startedAt: 0 },
    ]);
    assert.deepEqual(grouped.get("work"), { working: 1, idle: 1, unknown: 0, total: 2, newest: NOW });
    assert.equal(grouped.get("home").unknown, 1);
    assert.equal(grouped.has(null), false, "a session with no profile belongs to no row");
  });

  it("says nothing at all about an account nobody is using", () => {
    assert.equal(busyMarker(undefined), "");
    assert.equal(busyMarker(counts()), "");
  });

  it("distinguishes busy from merely open", () => {
    assert.equal(busyMarker(counts({ working: 1, total: 1 })), "● running");
    assert.equal(busyMarker(counts({ working: 1, idle: 1, total: 2 })), "● 2 running");
    assert.equal(busyMarker(counts({ idle: 1, total: 1 })), "○ idle");
    assert.equal(busyMarker(counts({ idle: 2, total: 2 })), "○ 2 idle");
    assert.equal(busyMarker(counts({ unknown: 1, total: 1 })), "○ open");
  });
});
