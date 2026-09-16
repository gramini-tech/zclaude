import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXIT } from "../src/errors.js";
import { request, requestEnvelope } from "../src/http.js";
import { redact, registerSecret } from "../src/redact.js";
import { jsonResponse, mockFetch } from "./helpers.js";

describe("redact", () => {
  it("masks registered secrets, bearer tokens and id.secret shapes", () => {
    registerSecret("supersecretvalue123");
    assert.equal(redact("token supersecretvalue123 here"), "token ****e123 here");
    assert.equal(redact("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer ****");
    assert.equal(redact("key 0123456789abcdef0123.ABCDEFGHIJKLMNOP done"), "key 0123**** done");
    assert.equal(redact("short.x"), "short.x");
  });
});

describe("requestEnvelope", () => {
  const url = "https://api.z.ai/x";
  it("accepts code 0, 200, '0', missing code, and success:true", async () => {
    for (const body of [
      { code: 0, data: 1 },
      { code: 200, data: 1 },
      { code: "0", data: 1 },
      { data: 1 },
      { success: true, data: 1 },
    ]) {
      assert.equal(
        await requestEnvelope(
          { url, fetchImpl: mockFetch(() => jsonResponse(body)) },
          { operation: "op", exitCode: EXIT.AUTH },
        ),
        1,
      );
    }
  });
  it("returns the body when data is absent", async () => {
    assert.deepEqual(
      await requestEnvelope(
        { url, fetchImpl: mockFetch(() => jsonResponse({ code: 0, value: 2 })) },
        { operation: "op", exitCode: 1 },
      ),
      { code: 0, value: 2 },
    );
  });
  it("rejects failing envelopes, success:false, non-JSON and HTTP errors with the given exit code", async () => {
    const cases = [
      [jsonResponse({ code: 401, msg: "bad token" }), /op failed: bad token/u],
      [jsonResponse({ code: 200, success: false, msg: "nope" }), /op failed: nope/u],
      [jsonResponse({ code: 7 }), /op failed: code 7/u],
      [new Response("<html>", { status: 200 }), /non-JSON response/u],
      [new Response("Service Unavailable", { status: 503 }), /GET api\.z\.ai returned HTTP 503: Service Unavailable/u],
    ];
    for (const [response, pattern] of cases) {
      await assert.rejects(
        requestEnvelope({ url, fetchImpl: mockFetch(() => response) }, { operation: "op", exitCode: EXIT.AUTH }),
        (error) => {
          assert.match(error.message, pattern);
          assert.equal(error.exitCode, EXIT.AUTH);
          return true;
        },
      );
    }
  });
  it("serialises JSON bodies with the content type", async () => {
    const fetchImpl = mockFetch(({ headers, body }) => {
      assert.equal(headers.get("content-type"), "application/json");
      assert.deepEqual(body, { a: 1 });
      return jsonResponse({ code: 0, data: "ok" });
    });
    assert.equal(
      await requestEnvelope({ url, method: "POST", body: { a: 1 }, fetchImpl }, { operation: "op", exitCode: 1 }),
      "ok",
    );
  });
  it("request never throws on status codes", async () => {
    const result = await request({ url, fetchImpl: mockFetch(() => new Response("nope", { status: 418 })) });
    assert.deepEqual([result.status, result.ok, result.text, result.json], [418, false, "nope", undefined]);
  });
});
