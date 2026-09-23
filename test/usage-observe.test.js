// Folding the quota headers that arrive on a routed response into the cache.
//
// These headers come back on every Max response, so a routed session produces a
// fresh reading of its own account for free. The rule this pins is that it is a
// merge: the headers know two percentages and nothing else, and overwriting the
// cached entry with them would erase the scoped limits, the credit balance and
// the weekly reset time that only the usage endpoint reports.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { observeUsage, readCache, usagePath } from "../src/usage/index.js";
import { readQuotaHeaders } from "../src/router/retry.js";

const home = await mkdtemp(join(tmpdir(), "zclaude-observe-"));
const env = { ...process.env, ZCLAUDE_HOME: home, HOME: home };
const NOW = 1_700_000_000_000;

after(async () => {
  await rm(home, { recursive: true, force: true });
});

const write = async (profiles) => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  await writeFile(usagePath(env), JSON.stringify({ version: 1, profiles, backoffUntil: 0 }), "utf8");
};

describe("observeUsage", () => {
  it("does nothing without a profile or without numbers", async () => {
    assert.equal(await observeUsage("", { fiveHour: { pct: 5 } }, { env, now: NOW }), null);
    assert.equal(await observeUsage("work", null, { env, now: NOW }), null);
    assert.equal(await observeUsage("work", { fiveHour: null, weekly: null }, { env, now: NOW }), null);
  });

  it("writes a reading for a profile the cache has never seen", async () => {
    await write({});
    const merged = await observeUsage(
      "work",
      { fiveHour: { pct: 41, resetsAt: "2026-01-01T00:00:00.000Z" }, weekly: { pct: 12 }, fetchedAt: NOW },
      { env, now: NOW },
    );
    assert.equal(merged.fiveHour.pct, 41);
    assert.equal(merged.weekly.pct, 12);
    assert.equal(merged.source, "headers");
    const onDisk = await readCache(env);
    assert.equal(onDisk.profiles.work.fiveHour.pct, 41);
  });

  it("keeps what only the endpoint knows, rather than replacing the entry", async () => {
    await write({
      work: {
        state: "ok",
        fiveHour: { pct: 10, resetsAt: "2026-01-01T00:00:00.000Z" },
        weekly: { pct: 4, resetsAt: "2026-01-07T00:00:00.000Z" },
        scoped: [{ name: "Opus", pct: 80 }],
        credits: { amount: 500, currency: "USD" },
        fetchedAt: NOW - 60_000,
      },
    });
    const merged = await observeUsage(
      "work",
      { fiveHour: { pct: 55, resetsAt: null }, weekly: { pct: 9 }, fetchedAt: NOW },
      { env, now: NOW },
    );
    assert.equal(merged.fiveHour.pct, 55, "the fresher percentage wins");
    assert.equal(merged.fiveHour.resetsAt, "2026-01-01T00:00:00.000Z", "a reset time the headers omit is kept");
    assert.equal(merged.weekly.pct, 9);
    assert.equal(merged.weekly.resetsAt, "2026-01-07T00:00:00.000Z", "the weekly header carries no reset time");
    assert.deepEqual(merged.scoped, [{ name: "Opus", pct: 80 }], "scoped limits are endpoint-only");
    assert.deepEqual(merged.credits, { amount: 500, currency: "USD" });
  });

  it("does not let a late response overwrite a fresher reading", async () => {
    await write({ work: { state: "ok", fiveHour: { pct: 70 }, fetchedAt: NOW } });
    const skipped = await observeUsage("work", { fiveHour: { pct: 3 }, fetchedAt: NOW - 30_000 }, { env, now: NOW });
    assert.equal(skipped, null);
    assert.equal((await readCache(env)).profiles.work.fiveHour.pct, 70);
  });

  it("takes exactly what the router reads off a real response", async () => {
    // The shapes on both sides of this are the point: `readQuotaHeaders` is the
    // producer and this is the consumer, and they are in different modules.
    await write({});
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.62",
      "anthropic-ratelimit-unified-7d-utilization": "0.18",
      "anthropic-ratelimit-unified-5h-reset": "1800000000",
      "anthropic-ratelimit-unified-status": "allowed",
    });
    const observed = readQuotaHeaders(headers, NOW);
    assert.ok(observed, "the router reads something from these headers");
    const merged = await observeUsage("work", observed, { env, now: NOW });
    assert.ok(merged.fiveHour.pct > 0);
    assert.ok(merged.weekly.pct > 0);
    assert.match(await readFile(usagePath(env), "utf8"), /"source": "headers"/u);
  });
});
