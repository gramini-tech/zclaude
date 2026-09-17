// Claude Code's advisory locks. The reason these exist: its token refresh
// reads, calls the network and saves under these locks, so a swap that ignored
// them could be overwritten by the old account's refreshed token — with the
// backup already holding a refresh token the server had rotated away.

import assert from "node:assert/strict";
import { mkdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquire, CONFIG_STALE_MS, CREDENTIAL_STALE_MS, swapLocks, withLocks } from "../src/swap/locks.js";
import { tempHome } from "./helpers.js";

const exists = (path) =>
  stat(path)
    .then(() => true)
    .catch(() => false);

describe("one lock", () => {
  it("is a directory, and release removes it", async () => {
    const home = await tempHome();
    try {
      const dir = join(home.dir, "a.lock");
      const release = await acquire(dir);
      assert.equal((await stat(dir)).isDirectory(), true, "mkdir's atomicity is the mutex");
      await release();
      assert.equal(await exists(dir), false);
      await release(); // releasing twice is not an error
    } finally {
      await home.cleanup();
    }
  });

  it("waits for a live holder and then says who to blame", async () => {
    const home = await tempHome();
    try {
      const dir = join(home.dir, "held.lock");
      await mkdir(dir);
      const started = Date.now();
      await assert.rejects(acquire(dir, { staleMs: CREDENTIAL_STALE_MS, timeoutMs: 600 }), /held by another process/u);
      assert.ok(Date.now() - started >= 500, "it waits rather than failing at once");
      assert.equal(await exists(dir), true, "a live holder's lock is never stolen");
    } finally {
      await home.cleanup();
    }
  });

  it("takes over a lock whose holder is long gone", async () => {
    const home = await tempHome();
    try {
      const dir = join(home.dir, "stale.lock");
      await mkdir(dir);
      const old = new Date(Date.now() - CONFIG_STALE_MS - 5000);
      await utimes(dir, old, old);
      const release = await acquire(dir, { staleMs: CONFIG_STALE_MS, timeoutMs: 500 });
      assert.ok((await stat(dir)).mtimeMs > old.getTime(), "the lock is now ours");
      await release();
    } finally {
      await home.cleanup();
    }
  });

  it("holds a credential lock for a minute before calling it dead, not ten seconds", () => {
    // A holder stalled on a slow token endpoint still owns its lock. Claude
    // Code's own numbers: 60s for the credential locks, 10s for the config.
    assert.equal(CREDENTIAL_STALE_MS, 60_000);
    assert.equal(CONFIG_STALE_MS, 10_000);
  });
});

describe("the set a swap takes", () => {
  it("is the refresh lock, the legacy lock and the config lock, in that order", () => {
    const locks = swapLocks({ configDir: "/home/x/.claude", configFile: "/home/x/.claude.json" });
    assert.deepEqual(
      locks.map((lock) => lock.dir),
      ["/home/x/.claude/.oauth_refresh.lock", "/home/x/.claude.lock", "/home/x/.claude.json.lock"],
    );
    assert.deepEqual(
      locks.map((lock) => lock.staleMs),
      [CREDENTIAL_STALE_MS, CREDENTIAL_STALE_MS, CONFIG_STALE_MS],
    );
  });

  it("holds them all during the work and releases every one afterwards", async () => {
    const home = await tempHome();
    try {
      const locks = [{ dir: join(home.dir, "one.lock") }, { dir: join(home.dir, "two.lock") }];
      let seen = [];
      await withLocks(locks, async () => {
        seen = await Promise.all(locks.map((lock) => exists(lock.dir)));
      });
      assert.deepEqual(seen, [true, true]);
      assert.deepEqual(await Promise.all(locks.map((lock) => exists(lock.dir))), [false, false]);
    } finally {
      await home.cleanup();
    }
  });

  it("lets go of what it took when the work throws", async () => {
    const home = await tempHome();
    try {
      const locks = [{ dir: join(home.dir, "one.lock") }, { dir: join(home.dir, "two.lock") }];
      await assert.rejects(
        withLocks(locks, async () => {
          throw new Error("the swap failed");
        }),
        /the swap failed/u,
      );
      assert.deepEqual(await Promise.all(locks.map((lock) => exists(lock.dir))), [false, false]);
    } finally {
      await home.cleanup();
    }
  });

  it("lets go of the first when the second cannot be taken", async () => {
    const home = await tempHome();
    try {
      const first = join(home.dir, "first.lock");
      const second = join(home.dir, "second.lock");
      await mkdir(second); // already held by someone else
      let ran = false;
      await assert.rejects(
        withLocks(
          [{ dir: first }, { dir: second }],
          async () => {
            ran = true;
          },
          { timeoutMs: 400 },
        ),
        /held by another process/u,
      );
      assert.equal(ran, false, "the work never starts with a half-held set");
      assert.equal(await exists(first), false, "and the first lock does not linger");
    } finally {
      await home.cleanup();
    }
  });
});
