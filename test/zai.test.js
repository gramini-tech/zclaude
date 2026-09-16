import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zaiConfig } from "../src/config.js";
import { EXIT } from "../src/errors.js";
import { checkKey, fetchQuota, formatQuota, quotaExhausted } from "../src/zai.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const config = zaiConfig({});

describe("checkKey", () => {
  it("returns valid with model ids and context windows", async () => {
    const fetchImpl = mockFetch(({ headers }) => {
      assert.equal(headers.get("authorization"), "Bearer k.s");
      return jsonResponse({
        object: "list",
        data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }, "glm-4.7", { id: "glm-5.3" }],
      });
    });
    const result = await checkKey("k.s", config, { fetchImpl });
    assert.equal(result.status, "valid");
    assert.deepEqual(result.models, [
      { id: "glm-5.3", contextWindow: 1_048_576 },
      { id: "glm-5.3-flash", contextWindow: 1_048_576 },
      { id: "glm-4.7", contextWindow: 200_000 },
    ]);
  });
  it("classifies 401/403, 429 and other statuses", async () => {
    for (const [status, expected] of [
      [401, "rejected"],
      [403, "rejected"],
      [429, "throttled"],
      [503, "inconclusive"],
    ]) {
      const fetchImpl = mockFetch(() => jsonResponse({ error: { message: `status ${status}` } }, { status }));
      const result = await checkKey("k", config, { fetchImpl });
      assert.equal(result.status, expected);
      assert.equal(result.httpStatus, status);
      assert.equal(result.detail, `status ${status}`);
    }
  });
  it("throws a network error when unreachable", async () => {
    const fetchImpl = () => {
      throw new Error("boom", { cause: { code: "ENOTFOUND" } });
    };
    await assert.rejects(checkKey("k", config, { fetchImpl }), (error) => {
      assert.equal(error.exitCode, EXIT.NETWORK);
      assert.match(error.message, /Could not reach api\.z\.ai \(ENOTFOUND\)/u);
      return true;
    });
  });
  it("times out", async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    await assert.rejects(checkKey("k", config, { fetchImpl, timeoutMs: 20 }), /timed out/u);
  });
});

describe("quota", () => {
  it("parses limits, sends the key without Bearer, and formats a summary", async () => {
    const fetchImpl = mockFetch(({ headers }) => {
      assert.equal(headers.get("authorization"), "k.s");
      return jsonResponse({
        code: 200,
        data: {
          level: "pro",
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 12.4 },
            { type: "TIME_LIMIT", percentage: 100, nextResetTime: 4_102_444_800_000 },
            { type: "MYSTERY" },
          ],
        },
      });
    });
    const quota = await fetchQuota("k.s", config, { fetchImpl });
    assert.equal(quota.level, "pro");
    assert.equal(quota.limits.length, 3);
    const line = formatQuota(quota);
    assert.match(line, /^Z\.ai GLM Coding Plan \(pro\) · 5h tokens 12% · time 100% \(resets in \d+d\)$/u);
    assert.equal(quotaExhausted(quota), true);
  });
  it("formats the coding-plan credit windows the way Z.ai reports them", () => {
    const soon = Date.now() + 32 * 60_000;
    const line = formatQuota({
      level: "max",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, percentage: 89, nextResetTime: soon },
        { type: "CREDIT_LIMIT", unit: 6, percentage: 17, nextResetTime: Date.now() + 6 * 24 * 3_600_000 },
        { type: "CREDIT_LIMIT", unit: 9, percentage: 5, nextResetTime: null },
      ],
    });
    assert.equal(
      line,
      "Z.ai GLM Coding Plan (max) · 5h credits 89% (resets in 32m) · weekly credits 17% · 9 credits 5%",
    );
  });

  it("returns null on failure and formats nothing", async () => {
    assert.equal(await fetchQuota("k", config, { fetchImpl: async () => new Response("nope", { status: 500 }) }), null);
    assert.equal(
      await fetchQuota("k", config, {
        fetchImpl: async () => {
          throw new Error("down");
        },
      }),
      null,
    );
    assert.equal(formatQuota(null), null);
    assert.equal(formatQuota({ level: "lite", limits: [] }), "Z.ai GLM Coding Plan (lite)");
    assert.equal(quotaExhausted({ limits: [{ percentage: 50 }] }), false);
  });
});
