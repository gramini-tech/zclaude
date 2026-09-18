// The singleton lock and the leases that keep a daemon alive.
//
// Everything here is about what happens when nobody gets to clean up. SIGKILL
// runs no handler and a power cut runs nothing, so the artefacts have to
// identify themselves as dead rather than be tidied away by the process that
// left them.

import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  autoDir,
  bootToken,
  claimDaemonLock,
  lockDir,
  ownerAlive,
  readDaemonOwner,
  sweepDead,
} from "../src/auto/lock.js";
import {
  decideLifecycle,
  dropLease,
  grantsOf,
  holdLease,
  leaseAlive,
  leaseDir,
  liveLeases,
} from "../src/auto/lease.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;
const envFor = (home) => ({ HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" });
const HERE = hostname();

/** A `ps` that reports one start time for everything, as a live process would. */
const psSaying = (token) => async () => `${token}\n`;
const psNothing = async () => "";
const alive = () => true;
const dead = () => {
  throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
};

describe("knowing when this machine booted", () => {
  it("reads the boot time on macOS, and reports honestly when it cannot", async () => {
    const darwin = await bootToken({
      platform: "darwin",
      runImpl: async () => "{ sec = 1789461341, usec = 227633 } Tue Sep 15 14:05:41 2026\n",
    });
    assert.equal(darwin, "1789461341");
    // A made-up value would make every artefact look like it came from this
    // boot, which is the exact opposite of what the field is for.
    assert.equal(await bootToken({ platform: "win32" }), null);
    assert.equal(await bootToken({ platform: "darwin", runImpl: async () => "" }), null);
  });
});

describe("the daemon lock", () => {
  it("is taken once, and the second claimant is told who has it", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      const deps = { env, now: NOW, platform: "darwin", runImpl: async () => "{ sec = 1 }", psImpl: psSaying("T1") };
      const first = await claimDaemonLock({ ...deps, kill: alive });
      assert.equal(first.claimed, true);

      const second = await claimDaemonLock({ ...deps, kill: alive });
      assert.equal(second.claimed, false, "two daemons rotating one login is the failure this prevents");
      assert.equal(second.owner.pid, process.pid);
      assert.match(second.reason, /already running/u);

      await first.release();
      assert.equal((await claimDaemonLock({ ...deps, kill: alive })).claimed, true, "released, so free again");
    } finally {
      await home.cleanup();
    }
  });

  it("takes over a lock whose owner was killed", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await mkdir(lockDir(env), { recursive: true });
      await writeFile(
        join(lockDir(env), "owner.json"),
        JSON.stringify({ pid: 999_998, startToken: "T1", bootAt: "1", host: HERE }),
      );
      // SIGKILL leaves the lock exactly like this. Nothing cleaned it up,
      // nothing needs to have.
      const claim = await claimDaemonLock({
        env,
        now: NOW,
        platform: "darwin",
        runImpl: async () => "{ sec = 1 }",
        psImpl: psNothing,
        kill: dead,
      });
      assert.equal(claim.claimed, true);
      assert.equal((await readDaemonOwner(env)).pid, process.pid);
      // Stolen by rename, so two simultaneous stealers cannot both win.
      const left = (await readdir(autoDir(env))).filter((name) => name.includes(".dead."));
      assert.equal(left.length, 1);
      assert.equal(await sweepDead(env), 1, "and the leftovers are cleared on demand");
    } finally {
      await home.cleanup();
    }
  });

  it("calls a lock from before the last boot dead without asking ps at all", async () => {
    // The whole answer to "the host crashes": after a reboot nothing written
    // before it can look alive, even if a pid happens to match.
    const owner = { pid: process.pid, startToken: "T1", bootAt: "1111", host: HERE };
    const verdict = await ownerAlive(owner, {
      boot: "2222",
      kill: () => {
        throw new Error("ps must not be consulted");
      },
    });
    assert.equal(verdict.live, false);
    assert.match(verdict.reason, /previous boot/u);
  });

  it("refuses to start when another machine is watching the same home directory", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      await mkdir(lockDir(env), { recursive: true });
      // ~/.zclaude can be synced. Without the host check, that machine's pids
      // "exist" here and this daemon would rotate the login while it works.
      await writeFile(
        join(lockDir(env), "owner.json"),
        JSON.stringify({ pid: 4242, startToken: "T1", bootAt: "1", host: "someone-elses-mac" }),
      );
      const claim = await claimDaemonLock({
        env,
        now: NOW,
        platform: "darwin",
        runImpl: async () => "{ sec = 1 }",
        psImpl: psNothing,
        kill: dead,
      });
      assert.equal(claim.claimed, false);
      assert.match(claim.reason, /another machine \(someone-elses-mac\)/u);
    } finally {
      await home.cleanup();
    }
  });

  it("treats two unknown boot times as no evidence either way", async () => {
    // A mismatch proves something; two nulls only mean we could not read it,
    // which is a reason to fall through to the pid checks rather than to
    // declare a live daemon dead.
    const owner = { pid: process.pid, startToken: "T1", bootAt: null, host: HERE };
    assert.equal((await ownerAlive(owner, { boot: null, kill: alive, psImpl: psSaying("T1") })).live, true);
  });
});

describe("leases", () => {
  const deps = { platform: "darwin", runImpl: async () => "{ sec = 1 }", psImpl: psSaying("T1") };

  it("a session lease may rotate; an editor lease may only watch", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      const session = await holdLease({ env, kind: "session", now: NOW, ...deps });
      const editor = await holdLease({ env, kind: "vscode", now: NOW, ...deps });
      assert.deepEqual(session.grants, ["watch", "rotate"]);
      assert.deepEqual(editor.grants, ["watch"]);
      // An open editor window is not consent to move the global login.
      assert.deepEqual(grantsOf([editor]), { watch: true, rotate: false });
      assert.deepEqual(grantsOf([editor, session]), { watch: true, rotate: true });
      assert.deepEqual(grantsOf([]), { watch: false, rotate: false });
    } finally {
      await home.cleanup();
    }
  });

  it("expires on the clock even while its process is alive", async () => {
    // The case a pid check cannot see: an extension host still running but no
    // longer talking to us.
    const lease = { id: "a", pid: process.pid, startToken: "T1", bootAt: "1", host: HERE, renewedAt: NOW };
    const fresh = await leaseAlive(lease, { now: NOW + 30_000, boot: "1", kill: alive, psImpl: psSaying("T1") });
    assert.equal(fresh.live, true);
    const stale = await leaseAlive(lease, { now: NOW + 600_000, boot: "1", kill: alive, psImpl: psSaying("T1") });
    assert.equal(stale.live, false);
    assert.match(stale.reason, /not been renewed/u);
  });

  it("renewing is the same call, so a holder needs no second code path", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      const first = await holdLease({ env, kind: "vscode", now: NOW, ...deps });
      const again = await holdLease({ env, kind: "vscode", id: first.id, now: NOW + 60_000, ...deps });
      assert.equal(again.id, first.id);
      assert.equal(again.renewedAt, NOW + 60_000);
      assert.equal((await readdir(leaseDir(env))).length, 1, "renewing does not pile up files");
    } finally {
      await home.cleanup();
    }
  });

  it("reaps the dead as it reads, so nothing has to have run for the answer to be right", async () => {
    const home = await tempHome();
    try {
      const env = envFor(home);
      const mine = await holdLease({ env, kind: "session", now: NOW, ...deps });
      await mkdir(leaseDir(env), { recursive: true });
      await writeFile(
        join(leaseDir(env), "ghost.json"),
        JSON.stringify({
          id: "ghost",
          kind: "vscode",
          pid: 999_997,
          startToken: "gone",
          bootAt: "1",
          host: HERE,
          renewedAt: NOW,
        }),
      );
      await writeFile(join(leaseDir(env), "rubbish.json"), "not json at all");

      const { leases, reaped } = await liveLeases({ env, now: NOW, boot: "1", kill: alive, psImpl: psSaying("T1") });
      assert.deepEqual(
        leases.map((lease) => lease.id),
        [mine.id],
      );
      assert.equal(reaped, 2);
      assert.equal((await readdir(leaseDir(env))).length, 1, "the directory cannot grow without bound");

      await dropLease(mine.id, env);
      assert.deepEqual((await liveLeases({ env, now: NOW, boot: "1" })).leases, []);
    } finally {
      await home.cleanup();
    }
  });
});

describe("what the daemon does each tick", () => {
  const lease = (kind) => ({ id: kind, kind, grants: kind === "session" ? ["watch", "rotate"] : ["watch"] });

  it("rotates for a session, and only watches for an editor", () => {
    assert.equal(decideLifecycle({ leases: [lease("session")], now: NOW }).action, "rotate");
    const watching = decideLifecycle({ leases: [lease("vscode")], now: NOW });
    assert.equal(watching.action, "watch");
    assert.match(watching.reason, /cannot move the login/u);
  });

  it("lingers before exiting, so quitting and relaunching costs nothing", () => {
    const first = decideLifecycle({ leases: [], now: NOW });
    assert.equal(first.action, "linger");
    assert.equal(first.emptySince, NOW);
    // A session that comes back inside the linger keeps the same daemon.
    assert.equal(decideLifecycle({ leases: [lease("session")], emptySince: NOW, now: NOW + 1000 }).action, "rotate");
    assert.equal(decideLifecycle({ leases: [], emptySince: NOW, now: NOW + 91_000 }).action, "exit");
  });
});
