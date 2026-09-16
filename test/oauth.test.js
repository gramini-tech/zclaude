import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zaiConfig } from "../src/config.js";
import { EXIT } from "../src/errors.js";
import { buildAuthorizeUrl, exchangeCode, generateState, parseCallback } from "../src/oauth.js";
import { envelope, jsonResponse, mockFetch } from "./helpers.js";

const config = zaiConfig({});
const STATE = "a".repeat(64);

describe("authorize url", () => {
  it("matches the ZCode desktop request shape with no PKCE", () => {
    const url = new URL(buildAuthorizeUrl(STATE, config));
    assert.equal(`${url.origin}${url.pathname}`, "https://chat.z.ai/api/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "client_P8X5CMWmlaRO9gyO-KSqtg");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("redirect_uri"), "zcode://zai-auth/callback");
    assert.equal(url.searchParams.get("state"), STATE);
    assert.equal(url.searchParams.get("code_challenge"), null);
  });

  it("honours endpoint overrides from the environment", () => {
    const custom = zaiConfig({ ZAI_OAUTH_REDIRECT_URI: "http://127.0.0.1:9/cb", ZAI_OAUTH_CLIENT_ID: "x" });
    const url = new URL(buildAuthorizeUrl(STATE, custom));
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:9/cb");
    assert.equal(url.searchParams.get("client_id"), "x");
  });

  it("generates 64 hex chars of state", () => {
    assert.match(generateState(), /^[0-9a-f]{64}$/u);
    assert.notEqual(generateState(), generateState());
  });
});

describe("parseCallback", () => {
  it("accepts the full zcode:// redirect", () => {
    assert.deepEqual(parseCallback(`zcode://zai-auth/callback?code=abc&state=${STATE}`, STATE), {
      code: "abc",
      state: STATE,
    });
  });
  it("accepts an https URL with the same params", () => {
    assert.deepEqual(parseCallback(`https://example.com/cb?state=${STATE}&code=xyz`, STATE), {
      code: "xyz",
      state: STATE,
    });
  });
  it("accepts a bare code, code#state and code=…&state=… text", () => {
    assert.deepEqual(parseCallback("  bare-code  ", STATE), { code: "bare-code", state: STATE });
    assert.deepEqual(parseCallback(`qrs#${STATE}`, STATE), { code: "qrs", state: STATE });
    assert.deepEqual(parseCallback(`code=q&state=${STATE}`, STATE), { code: "q", state: STATE });
  });
  it("rejects a state mismatch, empty input, wrong scheme target and error params", () => {
    assert.throws(() => parseCallback("zcode://zai-auth/callback?code=abc&state=evil", STATE), /state mismatch/u);
    assert.throws(() => parseCallback(`qrs#${"b".repeat(64)}`, STATE), /state mismatch/u);
    assert.throws(() => parseCallback("", STATE), /No authorization code/u);
    assert.throws(() => parseCallback("zcode://other/callback?code=abc", STATE), /not the Z.ai/u);
    assert.throws(
      () => parseCallback("zcode://zai-auth/callback?error=access_denied&error_description=User+denied", STATE),
      /User denied/u,
    );
    assert.throws(
      () => parseCallback("zcode://zai-auth/callback?state=x", STATE),
      /does not contain an authorization code/u,
    );
  });
  it("every failure carries the auth exit code", () => {
    try {
      parseCallback("", STATE);
      assert.fail("expected throw");
    } catch (error) {
      assert.equal(error.exitCode, EXIT.AUTH);
    }
  });
});

describe("exchangeCode", () => {
  it("posts the ZCode body and extracts token, email and user id", async () => {
    const fetchImpl = mockFetch(({ url }) =>
      url === config.tokenUrl
        ? envelope({ token: "jwt", zai: { access_token: "short-lived" }, user: { email: "Me@Example.com", id: "u-1" } })
        : undefined,
    );
    const result = await exchangeCode({ code: "abc", state: STATE }, config, { fetchImpl });
    assert.deepEqual(result, { accessToken: "short-lived", email: "me@example.com", userId: "u-1" });
    assert.deepEqual(fetchImpl.calls[0].body, {
      provider: "zai",
      code: "abc",
      redirect_uri: config.redirectUri,
      state: STATE,
    });
    assert.equal(fetchImpl.calls[0].method, "POST");
  });
  it("turns an envelope failure into an auth error with a retry hint", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ code: 400, msg: "invalid code" }));
    await assert.rejects(exchangeCode({ code: "bad", state: STATE }, config, { fetchImpl }), (error) => {
      assert.equal(error.exitCode, EXIT.AUTH);
      assert.match(error.message, /invalid code/u);
      assert.match(error.hint, /single-use/u);
      return true;
    });
  });
  it("fails when no access token is present", async () => {
    const fetchImpl = mockFetch(() => envelope({ user: {} }));
    await assert.rejects(exchangeCode({ code: "x", state: STATE }, config, { fetchImpl }), /no access token/u);
  });
  it("reports HTTP failures with host and status", async () => {
    const fetchImpl = mockFetch(() => new Response("gateway down", { status: 502 }));
    await assert.rejects(
      exchangeCode({ code: "x", state: STATE }, config, { fetchImpl }),
      /POST zcode\.z\.ai returned HTTP 502/u,
    );
  });
});
