// One request, end to end, against a fake upstream and no sockets.
//
// The assertion that matters most in this file is `writeHeadCalls() === 1`.
// That is the moment after which the account is fixed and nothing can be
// retried, so every decision has to happen above it. A second call would mean
// mid-stream failover had been introduced by accident, and the failure mode is
// duplicated or contradictory output in somebody's terminal.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_ROUTER_CONFIG } from "../src/router/config.js";
import { DEFAULT_BODY_CAP, handleMessages, readBody } from "../src/router/handler.js";
import { QUOTA_HEADERS } from "../src/router/retry.js";
import { collectingResponse, fakeRequest, fakeUpstream, sseBody, streamingResponse } from "./router-fixtures.js";

const NOW = 1_800_000_000_000;
const ANTHROPIC = "https://api.anthropic.com";
const ZAI = "https://api.z.ai/api/anthropic";

const config = (over = {}) => ({
  ...DEFAULT_ROUTER_CONFIG,
  targets: {
    work: { kind: "anthropic", profile: "work" },
    spare: { kind: "anthropic", profile: "spare" },
    glm: { kind: "zai", model: "latest" },
  },
  routes: {
    ...DEFAULT_ROUTER_CONFIG.routes,
    opus: { to: ["work", "spare"] },
    sonnet: { to: ["glm"] },
    // A model nobody anticipated still needs somewhere to go. In a real table
    // loadRouterConfig merges the built-in `any` target so this cannot be
    // empty; here the targets are replaced wholesale, so it is named.
    unknown: { to: ["work"] },
  },
  hold: { enabled: false, ceilingMs: 0, pollMs: 5000 },
  ...over,
});

/** A selector over a fixed set of targets, with the penalties it really keeps. */
function selectorOver(names) {
  const penalties = new Map();
  return {
    penalised: penalties,
    async choose({ candidates, excluded = new Set(), prefer = null }) {
      const usable = candidates.filter(
        (one) => names.includes(one.name) && !excluded.has(one.name) && !penalties.has(one.name),
      );
      const withRecords = usable.map((one) => ({
        ...one,
        record: one.kind === "zai" ? null : { name: one.profile, provider: "anthropic", dir: `/tmp/${one.profile}` },
      }));
      const at = prefer ? withRecords.findIndex((one) => one.name === prefer) : -1;
      if (at > 0) withRecords.unshift(...withRecords.splice(at, 1));
      const [best, ...rest] = withRecords;
      return { target: best ?? null, reason: null, rest };
    },
    penalise(name, { why }) {
      penalties.set(name, why);
    },
    sittingOut: () => [],
  };
}

/** Everything the handler needs, with each dependency a fake. */
function depsWith({ fetchImpl, over = {}, tokenState = "ok", targets = ["work", "spare", "glm"] } = {}) {
  const recorded = [];
  const invalidated = [];
  return {
    config: config(over.config),
    selector: over.selector ?? selectorOver(targets),
    tokens: over.tokens ?? {
      tokenFor: async (target) => ({
        state: tokenState,
        value: target.kind === "zai" ? "zai-key" : `oat-${target.profile}`,
        detail: tokenState === "ok" ? null : "this profile is signed out",
      }),
      invalidate: (target) => {
        invalidated.push(target.name);
      },
      size: () => 0,
    },
    catalogue: over.catalogue ?? {
      list: async () => ({ provider: "zai", models: [{ id: "glm-current", fast: false }], source: "live" }),
      resolve: (selector, list) => ({ id: list.models[0].id, matched: "latest", detail: null }),
    },
    ledger: {
      record: (entry) => {
        recorded.push(entry);
      },
    },
    affinity: over.affinity,
    bases: { anthropicBase: ANTHROPIC, zaiBase: ZAI },
    env: {},
    now: over.now ?? (() => NOW),
    waitImpl: async () => {},
    fetchImpl,
    recorded,
    invalidated,
  };
}

const opusBody = JSON.stringify({ model: "claude-opus-5", stream: true, messages: [{ role: "user", content: "hi" }] });

describe("reading the body", () => {
  it("holds the whole body, because a retry has to be replayable", async () => {
    // Not held for the rewrite, which could be done once. Held because a 401 or
    // a quota 429 from the first account has to be sent again to the second,
    // and Node hands you a request body exactly once.
    const req = fakeRequest({ body: opusBody });
    const read = await readBody(req, DEFAULT_BODY_CAP);
    assert.equal(read.tooLarge, false);
    assert.equal(read.buffer.toString("utf8"), opusBody);
  });

  it("refuses rather than growing without bound", async () => {
    const read = await readBody(fakeRequest({ body: "x".repeat(100) }), 10);
    assert.equal(read.tooLarge, true);
    assert.equal(read.buffer, null, "and nothing is kept");
  });

  it("has a cap large enough for a real agentic body", () => {
    // A 200k-token context serializes to about a megabyte; with image blocks it
    // reaches tens. The cap exists for the 40MB paste, not the normal case.
    assert.equal(DEFAULT_BODY_CAP, 64 * 1024 * 1024);
  });
});

describe("a request that simply works", () => {
  it("streams it through and commits exactly once", async () => {
    const fetchImpl = fakeUpstream([
      { when: ANTHROPIC, reply: () => streamingResponse(sseBody({ model: "claude-opus-5" })) },
    ]);
    const deps = depsWith({ fetchImpl });
    const out = collectingResponse();
    await handleMessages({
      req: fakeRequest({ body: opusBody, headers: { "anthropic-beta": "some-beta" } }),
      res: out.res,
      path: "/v1/messages",
      deps,
    });

    assert.equal(out.writeHeadCalls(), 1, "one commitment, which is what makes failover impossible after it");
    assert.equal(out.status(), 200);
    assert.match(out.text(), /message_start/u, "and the stream arrived");
    assert.equal(fetchImpl.calls[0].authorization, "Bearer oat-work", "signed as the first account in the chain");
    assert.equal(out.headers()["x-zclaude-target"], "work");
    assert.equal(deps.recorded[0].usage.output, 20, "the usage was read out of the stream");
  });

  it("rewrites the model for a Z.ai route and sends its key", async () => {
    const fetchImpl = fakeUpstream([{ when: ZAI, reply: () => streamingResponse(sseBody({ model: "glm-current" })) }]);
    const deps = depsWith({ fetchImpl });
    const out = collectingResponse();
    await handleMessages({
      req: fakeRequest({ body: JSON.stringify({ model: "claude-sonnet-5[1m]", stream: true }) }),
      res: out.res,
      path: "/v1/messages",
      deps,
    });

    assert.equal(out.status(), 200);
    assert.equal(fetchImpl.calls[0].json.model, "glm-current", "the selector resolved against the live catalogue");
    assert.equal(fetchImpl.calls[0].authorization, "Bearer zai-key");
    assert.equal(fetchImpl.calls[0].headers.get("anthropic-beta"), null, "and Z.ai gets no betas");
    assert.doesNotMatch(fetchImpl.calls[0].body, /\[1m\]/u, "the marker never leaves the router");
  });
});

describe("a 429, and which kind it was", () => {
  it("paces a burst on the same account rather than rotating", async () => {
    // Rotating here would throw away a warm prompt cache to dodge a two-second
    // wait, which is the most expensive mistake this layer can make.
    const fetchImpl = fakeUpstream([
      {
        when: ANTHROPIC,
        times: 1,
        reply: () => new Response("busy", { status: 429, headers: { "retry-after": "2" } }),
      },
      { when: ANTHROPIC, reply: () => streamingResponse(sseBody()) },
    ]);
    const deps = depsWith({ fetchImpl });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });

    assert.equal(out.status(), 200);
    assert.equal(fetchImpl.calls.length, 2);
    assert.ok(
      fetchImpl.calls.every((call) => call.authorization === "Bearer oat-work"),
      "both attempts went to the same account",
    );
    assert.equal(deps.selector.penalised.size, 0, "and nothing was taken out of rotation");
  });

  it("rotates on a quota 429 and sits the account out", async () => {
    const fetchImpl = fakeUpstream([
      {
        when: ANTHROPIC,
        times: 1,
        reply: () =>
          new Response("spent", {
            status: 429,
            headers: {
              [QUOTA_HEADERS.status]: "rejected",
              [QUOTA_HEADERS.fiveHour]: "100",
              [QUOTA_HEADERS.reset]: String(Math.floor(NOW / 1000) + 1800),
            },
          }),
      },
      { when: ANTHROPIC, reply: () => streamingResponse(sseBody()) },
    ]);
    const deps = depsWith({ fetchImpl });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });

    assert.equal(out.status(), 200);
    assert.equal(fetchImpl.calls[1].authorization, "Bearer oat-spare", "the next account in the chain answered");
    assert.equal(out.headers()["x-zclaude-target"], "spare");
    assert.ok(deps.selector.penalised.has("work"));
  });
});

describe("a token that died between being read and being used", () => {
  it("re-reads once, then moves on", async () => {
    // Expected rather than exceptional: the router spends the last minutes of a
    // token it is not allowed to refresh.
    const fetchImpl = fakeUpstream([
      { when: ANTHROPIC, times: 2, reply: () => new Response("no", { status: 401 }) },
      { when: ANTHROPIC, reply: () => streamingResponse(sseBody()) },
    ]);
    const deps = depsWith({ fetchImpl });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });

    assert.equal(out.status(), 200);
    assert.deepEqual(deps.invalidated, ["work"], "the token was re-read before the account was blamed");
    assert.equal(fetchImpl.calls[2].authorization, "Bearer oat-spare");
  });
});

describe("errors that belong to the client", () => {
  it("hands a 400 straight back rather than trying it elsewhere", async () => {
    // Retrying a malformed body on three accounts turns one clear error into
    // three confusing ones.
    const fetchImpl = fakeUpstream([
      { when: ANTHROPIC, reply: () => Response.json({ error: "bad" }, { status: 400 }) },
    ]);
    const deps = depsWith({ fetchImpl });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });

    assert.equal(out.status(), 400);
    assert.equal(fetchImpl.calls.length, 1, "asked once, and only once");
    assert.equal(out.writeHeadCalls(), 1);
  });

  it("refuses a body larger than the cap", async () => {
    const deps = depsWith({
      fetchImpl: fakeUpstream([]),
      over: { config: { limits: { bodyBytes: 32, upstreamTimeoutMs: 1000 } } },
    });
    const out = collectingResponse();
    await handleMessages({
      req: fakeRequest({ body: "x".repeat(4096) }),
      res: out.res,
      path: "/v1/messages",
      deps,
    });
    assert.equal(out.status(), 413);
    assert.equal(out.json().error.type, "invalid_request_error");
  });

  it("forwards a body it cannot parse rather than refusing it", async () => {
    // A router that rejects what the upstream would have accepted is worse than
    // no router.
    const fetchImpl = fakeUpstream([{ when: ANTHROPIC, reply: () => streamingResponse(sseBody()) }]);
    const deps = depsWith({ fetchImpl });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: "{not json" }), res: out.res, path: "/v1/messages", deps });

    assert.equal(out.status(), 200);
    assert.equal(fetchImpl.calls[0].body, "{not json", "byte for byte as it arrived");
  });
});

describe("when nothing can take it", () => {
  it("fails with a real 429 and a retry-after, not a stream", async () => {
    const deps = depsWith({ fetchImpl: fakeUpstream([]), targets: [] });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });

    assert.equal(out.status(), 429);
    assert.ok(out.headers()["retry-after"], "so Claude Code's own backoff has something to read");
    assert.equal(out.json().error.type, "rate_limit_error");
    assert.equal(out.writeHeadCalls(), 1);
  });

  it("waits when holding is on, and serves what comes back", async () => {
    let released = false;
    const selector = selectorOver(["work"]);
    const real = selector.choose.bind(selector);
    selector.choose = async (input) => (released ? real(input) : { target: null, reason: "spent", rest: [] });
    const fetchImpl = fakeUpstream([{ when: ANTHROPIC, reply: () => streamingResponse(sseBody()) }]);
    const deps = depsWith({
      fetchImpl,
      over: { selector, config: { hold: { enabled: true, ceilingMs: 60_000, pollMs: 5000 } } },
    });
    deps.waitImpl = async () => {
      released = true;
    };
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });

    assert.equal(out.status(), 200, "the request waited rather than failing at 2am");
    assert.equal(out.writeHeadCalls(), 1);
  });

  it("reports a profile that is signed out rather than retrying it", async () => {
    const deps = depsWith({ fetchImpl: fakeUpstream([]), tokenState: "unauthorized" });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });
    assert.equal(out.status(), 503);
    assert.equal(out.json().error.type, "api_error");
  });
});

describe("keeping a conversation where its cache is", () => {
  it("asks the selector for the bound account, and releases it when it is spent", async () => {
    const seen = [];
    const selector = selectorOver(["work", "spare"]);
    const real = selector.choose.bind(selector);
    selector.choose = async (input) => {
      seen.push(input.prefer);
      return real(input);
    };
    const released = [];
    const fetchImpl = fakeUpstream([
      {
        when: ANTHROPIC,
        times: 1,
        reply: () => new Response("spent", { status: 429, headers: { [QUOTA_HEADERS.status]: "rejected" } }),
      },
      { when: ANTHROPIC, reply: () => streamingResponse(sseBody()) },
    ]);
    const deps = depsWith({
      fetchImpl,
      over: {
        selector,
        affinity: {
          get: () => "spare",
          release: (request) => {
            released.push(request.klass);
          },
          bind: () => {},
        },
      },
    });
    const out = collectingResponse();
    await handleMessages({ req: fakeRequest({ body: opusBody }), res: out.res, path: "/v1/messages", deps });

    assert.equal(seen[0], "spare", "the bound account is offered first");
    assert.deepEqual(released, ["opus"], "and released once its window is gone");
    assert.equal(out.status(), 200);
  });
});
