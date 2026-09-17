// The usage endpoint and the token refresh behind it. Nothing here touches the
// network or a Keychain: the fetch and the `security` runner are both injected.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  EXPIRY_BUFFER_MS,
  fetchUsage,
  needsRefresh,
  normaliseUsage,
  OAUTH_CLIENT_ID,
  refreshCredential,
  TOKEN_URL,
  USAGE_URL,
} from "../src/usage/anthropic.js";
import { credentialHealth, formatUsage, readCache, usageFor, usageForAll, usagePath } from "../src/usage/index.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;
const credential = (overrides = {}) => ({
  claudeAiOauth: {
    accessToken: "sk-ant-oat-aaaa",
    refreshToken: "sk-ant-ort-bbbb",
    expiresAt: NOW + 3_600_000,
    refreshTokenExpiresAt: NOW + 30 * 86_400_000,
    scopes: ["user:inference"],
    subscriptionType: "max",
    ...overrides,
  },
});

const USAGE_BODY = {
  five_hour: { utilization: 12.4, resets_at: "2026-09-17T18:00:00Z" },
  seven_day: { utilization: 61, resets_at: "2026-09-21T00:00:00Z" },
  limits: [
    { scope: { model: { display_name: "Fable" } }, percent: 91.2, resets_at: "2026-09-21T00:00:00Z" },
    { scope: { model: {} }, percent: 5 },
    { scope: { model: { display_name: "Broken" } }, percent: "nonsense" },
  ],
};

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    return handler({ url: String(url), init });
  };
  impl.calls = calls;
  return impl;
}

describe("reading the usage endpoint", () => {
  it("asks the documented URL with the OAuth beta header", async () => {
    const fetchImpl = fakeFetch(() => Response.json(USAGE_BODY));
    const answer = await fetchUsage("token-123", { fetchImpl });
    assert.equal(answer.state, "ok");
    assert.equal(fetchImpl.calls[0].url, USAGE_URL);
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer token-123");
    assert.equal(fetchImpl.calls[0].init.headers["anthropic-beta"], "oauth-2025-04-20");
  });

  it("separates a dead token, a throttle and a bad day", async () => {
    const status = (code, headers) => fakeFetch(() => new Response("{}", { status: code, headers }));
    assert.equal((await fetchUsage("t", { fetchImpl: status(401) })).state, "unauthorized");
    assert.equal((await fetchUsage("t", { fetchImpl: status(500) })).state, "error");

    // The endpoint budgets requests rather than quota, so a 429 is a polling
    // problem and its Retry-After is the only honest backoff.
    const throttled = await fetchUsage("t", { fetchImpl: status(429, { "retry-after": "120" }) });
    assert.equal(throttled.state, "throttled");
    assert.equal(throttled.retryAfterMs, 120_000);
    assert.equal((await fetchUsage("t", { fetchImpl: status(429) })).retryAfterMs, 60_000);

    const offline = await fetchUsage("t", {
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    assert.equal(offline.state, "offline");
  });

  it("reads the per-model weekly windows out of the limits array", () => {
    const usage = normaliseUsage(USAGE_BODY);
    assert.equal(usage.fiveHour.pct, 12.4);
    assert.equal(usage.fiveHour.resetsAt, "2026-09-17T18:00:00Z");
    assert.equal(usage.weekly.pct, 61);
    assert.deepEqual(
      usage.scoped.map((scope) => [scope.name, scope.pct]),
      [["Fable", 91.2]],
      "an entry without a model name or a numeric percent is not a window",
    );
    assert.equal(normaliseUsage({}), null);
    assert.equal(normaliseUsage({ limits: [] }), null);
  });
});

describe("refreshing a token", () => {
  it("knows when a token is too old to use", () => {
    assert.equal(needsRefresh(credential(), NOW), false);
    assert.equal(needsRefresh(credential({ expiresAt: NOW - 1 }), NOW), true);
    assert.equal(needsRefresh(credential({ expiresAt: NOW + EXPIRY_BUFFER_MS - 1000 }), NOW), true);
    assert.equal(needsRefresh({}, NOW), true, "an unreadable expiry is treated as expired");
  });

  it("posts the grant Claude Code's client is registered for", async () => {
    const fetchImpl = fakeFetch(() => Response.json({ access_token: "new-access", expires_in: 3600 }));
    const result = await refreshCredential(credential(), { fetchImpl, now: NOW });
    assert.equal(result.state, "ok");
    assert.equal(fetchImpl.calls[0].url, TOKEN_URL);
    assert.deepEqual(fetchImpl.calls[0].body, {
      grant_type: "refresh_token",
      refresh_token: "sk-ant-ort-bbbb",
      client_id: OAUTH_CLIENT_ID,
    });
    assert.equal(result.blob.claudeAiOauth.accessToken, "new-access");
    assert.equal(result.blob.claudeAiOauth.expiresAt, NOW + 3_600_000);
    assert.equal(result.rotated, false);
    assert.equal(result.blob.claudeAiOauth.refreshToken, "sk-ant-ort-bbbb", "an unrotated token is kept");
    assert.equal(result.blob.claudeAiOauth.subscriptionType, "max", "the rest of the blob survives");
  });

  it("carries a rotated refresh token through, because the old one is now dead", async () => {
    const fetchImpl = fakeFetch(() =>
      Response.json({ access_token: "new-access", expires_in: 3600, refresh_token: "sk-ant-ort-cccc" }),
    );
    const result = await refreshCredential(credential(), { fetchImpl, now: NOW });
    assert.equal(result.rotated, true);
    assert.equal(result.blob.claudeAiOauth.refreshToken, "sk-ant-ort-cccc");
  });

  it("calls a refused grant dead only when the server says so", async () => {
    const dead = await refreshCredential(credential(), {
      fetchImpl: fakeFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 })),
      now: NOW,
    });
    assert.equal(dead.state, "dead");

    // A 500, a 400 without the marker and an empty body are all ambiguous, and
    // a wrong "dead" verdict retires a login that still works.
    for (const response of [
      Response.json({}, { status: 500 }),
      Response.json({ error: "server_error" }, { status: 400 }),
      new Response("", { status: 503 }),
    ]) {
      const result = await refreshCredential(credential(), { fetchImpl: fakeFetch(() => response), now: NOW });
      assert.equal(result.state, "transient", "ambiguous failures stay retryable");
    }

    const noToken = await refreshCredential(credential({ refreshToken: undefined }), {
      fetchImpl: fakeFetch(() => {}),
    });
    assert.equal(noToken.state, "dead");
  });
});

describe("usage for a profile", () => {
  function keychain(blobByService) {
    return async (args) => {
      const at = (flag) => args[args.indexOf(flag) + 1];
      if (args[0] === "find-generic-password") {
        const found = blobByService.get(at("-s"));
        if (!found) return { code: 44, stdout: "", stderr: "" };
        return { code: 0, stdout: args.includes("-w") ? `${found}\n` : "attrs\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  const record = (dir) => ({ name: "work", provider: "anthropic", dir });

  it("fetches, caches, and serves the cache on the next call", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
      const dir = join(home.dir, "profile");
      const { claudeCredentialService } = await import("../src/profiles/keychain-name.js");
      const blobs = new Map([[claudeCredentialService(dir), JSON.stringify(credential())]]);
      const fetchImpl = fakeFetch(() => Response.json(USAGE_BODY));

      const usage = await usageFor(record(dir), {
        env,
        fetchImpl,
        security: keychain(blobs),
        now: NOW,
      });
      assert.equal(usage.state, "ok");
      assert.equal(usage.weekly.pct, 61);
      assert.equal(fetchImpl.calls.length, 1);

      const cached = await usageFor(record(dir), { env, fetchImpl, security: keychain(blobs), now: NOW + 1000 });
      assert.equal(cached.weekly.pct, 61);
      assert.equal(fetchImpl.calls.length, 1, "inside the TTL nothing is asked again");

      const forced = await usageFor(record(dir), {
        env,
        fetchImpl,
        security: keychain(blobs),
        now: NOW + 1000,
        force: true,
      });
      assert.equal(forced.state, "ok");
      assert.equal(fetchImpl.calls.length, 2, "a forced refresh is how the retry button works");

      const onDisk = JSON.parse(await readFile(usagePath(env), "utf8"));
      assert.equal(onDisk.profiles.work.weekly.pct, 61);
      assert.doesNotMatch(JSON.stringify(onDisk), /sk-ant/u, "no token reaches the cache file");
    } finally {
      await home.cleanup();
    }
  });

  it("keeps the last good numbers when a fetch fails, and backs off on a throttle", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
      const dir = join(home.dir, "profile");
      const { claudeCredentialService } = await import("../src/profiles/keychain-name.js");
      const blobs = new Map([[claudeCredentialService(dir), JSON.stringify(credential())]]);

      await usageFor(record(dir), {
        env,
        fetchImpl: fakeFetch(() => Response.json(USAGE_BODY)),
        security: keychain(blobs),
        now: NOW,
      });
      const throttled = await usageFor(record(dir), {
        env,
        fetchImpl: fakeFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "300" } })),
        security: keychain(blobs),
        now: NOW + 120_000,
        force: true,
      });
      assert.equal(throttled.state, "stale");
      assert.equal(throttled.weekly.pct, 61, "the numbers we had are better than none");

      const cache = await readCache(env);
      assert.equal(cache.backoffUntil, NOW + 120_000 + 300_000);
      const duringBackoff = await usageFor(record(dir), {
        env,
        fetchImpl: fakeFetch(() => {
          throw new Error("must not be called during backoff");
        }),
        security: keychain(blobs),
        now: NOW + 130_000,
        force: true,
      });
      assert.equal(duringBackoff.state, "stale");
    } finally {
      await home.cleanup();
    }
  });

  it("keeps the reason a lookup failed instead of blanking the row next time", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
      const options = {
        env,
        security: keychain(new Map()),
        fetchImpl: fakeFetch(() => Response.json(USAGE_BODY)),
        force: true,
      };
      const first = await usageFor(record(join(home.dir, "none")), { ...options, now: NOW });
      assert.equal(first.state, "unauthorized");
      // Second time round there is a cached entry, but it carries no numbers,
      // so "stale" would leave the row saying nothing at all.
      const second = await usageFor(record(join(home.dir, "none")), { ...options, now: NOW + 120_000 });
      assert.equal(second.state, "unauthorized");
      assert.equal(formatUsage(second), "sign in to see usage");
    } finally {
      await home.cleanup();
    }
  });

  it("reports a profile that has no credential rather than guessing", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
      const usage = await usageFor(record(join(home.dir, "empty")), {
        env,
        fetchImpl: fakeFetch(() => Response.json(USAGE_BODY)),
        security: keychain(new Map()),
        now: NOW,
      });
      assert.equal(usage.state, "unauthorized");
      assert.equal(formatUsage(usage), "sign in to see usage");
    } finally {
      await home.cleanup();
    }
  });

  it("reports every profile as it lands, so a list can fill in row by row", async () => {
    const home = await tempHome();
    try {
      const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
      const seen = [];
      const results = await usageForAll(
        [
          { name: "a", provider: "anthropic", dir: join(home.dir, "a") },
          { name: "b", provider: "anthropic", dir: join(home.dir, "b") },
        ],
        {
          env,
          now: NOW,
          security: keychain(new Map()),
          fetchImpl: fakeFetch(() => Response.json(USAGE_BODY)),
          onResult: (name, usage) => {
            seen.push([name, usage.state]);
          },
        },
      );
      assert.equal(seen.length, 2);
      assert.deepEqual(
        Object.keys(results).toSorted((x, y) => x.localeCompare(y)),
        ["a", "b"],
      );
    } finally {
      await home.cleanup();
    }
  });
});

describe("the health of a stored credential", () => {
  it("reports expiry without the secret, and nothing for a Z.ai profile", async () => {
    const { claudeCredentialService } = await import("../src/profiles/keychain-name.js");
    const dir = "/tmp/profile-health";
    const blobs = new Map([[claudeCredentialService(dir), JSON.stringify(credential())]]);
    const security = async (args) => {
      const found = blobs.get(args[args.indexOf("-s") + 1]);
      return found ? { code: 0, stdout: `${found}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "" };
    };
    const health = await credentialHealth(
      { name: "work", provider: "anthropic", dir },
      { env: { USER: "tester" }, now: NOW, security },
    );
    assert.equal(health.subscriptionType, "max");
    assert.equal(health.hasRefreshToken, true);
    assert.equal(health.accessExpired, false);
    assert.doesNotMatch(JSON.stringify(health), /sk-ant/u);
    assert.equal(await credentialHealth({ name: "glm", provider: "zai" }, {}), null);
  });
});

describe("showing usage", () => {
  it("puts the three windows on one line", () => {
    assert.equal(
      formatUsage({
        state: "ok",
        fiveHour: { pct: 12.4 },
        weekly: { pct: 61 },
        scoped: [{ name: "Fable", pct: 91.2 }],
      }),
      "5h 12% · wk 61% · Fable 91%",
    );
    assert.equal(formatUsage({ state: "stale", fiveHour: { pct: 3 }, weekly: null, scoped: [] }), "5h 3% (cached)");
    assert.equal(formatUsage({ state: "dead" }), "login expired");
    assert.equal(formatUsage({ state: "throttled" }), "usage rate limited, try again shortly");
    assert.equal(formatUsage({ state: "offline" }), "usage unavailable");
    assert.equal(formatUsage(null), "");
    assert.equal(formatUsage({ state: "ok", fiveHour: null, weekly: null, scoped: [] }), "");
  });
});
