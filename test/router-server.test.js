// The listener, the conversation key and the ledger, plus one real socket.
//
// Almost everything about the router is tested without a socket, because
// sockets are slow and flaky. One test here uses a real one anyway: chunked
// encoding, header casing, backpressure and abort-on-disconnect only behave
// like themselves over a real connection, and zero of those tests would leave
// the streaming path untested in its actual shape.

import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { describe, it } from "node:test";

import { classifyRequest, systemText } from "../src/router/classify.js";
import { conversationKey, createAffinity, DEFAULT_TTL_MS } from "../src/router/affinity.js";
import { createLedger, DEFAULT_CAP } from "../src/router/ledger.js";
import { DEFAULT_ROUTER_CONFIG } from "../src/router/config.js";
import { bearerFrom, hostAllowed, mintToken, startRouter, tokenMatches } from "../src/router/server.js";
import { sseBody } from "./router-fixtures.js";

const NOW = 1_800_000_000_000;

describe("the local caller check", () => {
  it("accepts only a loopback Host on our port", () => {
    // A page on evil.com whose DNS answers 127.0.0.1 still arrives with
    // `Host: evil.com`, which is what this catches.
    assert.equal(hostAllowed("127.0.0.1:34317", 34_317), true);
    assert.equal(hostAllowed("localhost:34317", 34_317), true);
    assert.equal(hostAllowed("127.0.0.1", 34_317), true, "a default port is still us");
    assert.equal(hostAllowed("evil.com", 34_317), false);
    assert.equal(hostAllowed("evil.com:34317", 34_317), false);
    assert.equal(hostAllowed("127.0.0.1:9999", 34_317), false, "another port is another service");
    assert.equal(hostAllowed(undefined, 34_317), false);
  });

  it("compares tokens in constant time, and never as a length oracle", () => {
    const token = mintToken();
    assert.match(token, /^zcr_/u);
    assert.equal(tokenMatches(token, token), true);
    assert.equal(tokenMatches(`${token}x`, token), false, "a longer guess is refused without comparing");
    assert.equal(tokenMatches("", token), false);
    assert.equal(tokenMatches(null, token), false);
    assert.equal(tokenMatches(token, null), false);
  });

  it("reads the bearer from either header Claude Code might use", () => {
    assert.equal(bearerFrom({ authorization: "Bearer abc" }), "abc");
    assert.equal(bearerFrom({ "x-api-key": "abc" }), "abc");
    assert.equal(bearerFrom({ authorization: "Basic abc" }), "", "only a bearer counts");
    assert.equal(bearerFrom({}), "");
  });
});

describe("the conversation key", () => {
  const request = (over = {}) =>
    classifyRequest({
      model: "claude-opus-5",
      system: [{ type: "text", text: "You are Claude Code. cwd: /work/repo" }],
      tools: [{ name: "Bash" }, { name: "Read" }],
      messages: [{ role: "user", content: "fix the bug" }],
      ...over,
    });

  it("is the same for the same conversation and different for another", () => {
    assert.equal(conversationKey(request()), conversationKey(request()));
    const elsewhere = request({ system: [{ type: "text", text: "You are Claude Code. cwd: /other/repo" }] });
    assert.notEqual(conversationKey(request()), conversationKey(elsewhere), "a different project is a different key");
    const later = request({ messages: [{ role: "user", content: "something else entirely" }] });
    assert.notEqual(conversationKey(request()), conversationKey(later));
  });

  it("changes when a compaction rewrites the first turn", () => {
    // The property that makes this the right key rather than a heuristic: the
    // binding is released at exactly the moment the cache it protects stops
    // existing, with no TTL tuning and no special case.
    const compacted = request({ messages: [{ role: "user", content: "[summary of earlier conversation]" }] });
    assert.notEqual(conversationKey(request()), conversationKey(compacted));
  });

  it("survives a change that does not invalidate the cache", () => {
    const longer = request({
      messages: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "on it" },
        { role: "user", content: "and the tests" },
      ],
    });
    assert.equal(conversationKey(request()), conversationKey(longer), "a later turn is the same conversation");
  });

  it("reads the system prompt in either shape, capped", () => {
    assert.equal(systemText("plain"), "plain");
    assert.equal(systemText([{ text: "a" }, { text: "b" }]), "a\nb");
    assert.equal(systemText(null), "");
    assert.equal(systemText("x".repeat(20_000)).length, 8192);
  });
});

describe("holding a conversation to an account", () => {
  const request = { systemText: "s", toolNames: ["Bash"], firstUserText: "hello" };

  it("remembers and forgets on the clock Anthropic's cache uses", () => {
    const affinity = createAffinity({ ttlMs: DEFAULT_TTL_MS });
    affinity.bind(request, "work", NOW);
    assert.equal(affinity.get(request, NOW + 1000), "work");
    assert.equal(
      affinity.get(request, NOW + DEFAULT_TTL_MS + 1),
      null,
      "past the cache lifetime there is nothing to stay near",
    );
  });

  it("forgets on release, which a quota 429 does", () => {
    const affinity = createAffinity();
    affinity.bind(request, "work", NOW);
    affinity.release(request);
    assert.equal(affinity.get(request, NOW), null);
  });

  it("evicts the least recently used rather than growing for abandoned tabs", () => {
    const affinity = createAffinity({ max: 2 });
    affinity.bind({ ...request, firstUserText: "one" }, "a", NOW);
    affinity.bind({ ...request, firstUserText: "two" }, "b", NOW);
    affinity.get({ ...request, firstUserText: "one" }, NOW);
    affinity.bind({ ...request, firstUserText: "three" }, "c", NOW);
    assert.equal(affinity.size(), 2);
    assert.equal(affinity.get({ ...request, firstUserText: "one" }, NOW), "a", "recently used survives");
    assert.equal(affinity.get({ ...request, firstUserText: "two" }, NOW), null, "the oldest went");
  });

  it("does nothing at all when it is switched off", () => {
    const affinity = createAffinity({ enabled: false });
    affinity.bind(request, "work", NOW);
    assert.equal(affinity.get(request, NOW), null);
    assert.equal(affinity.size(), 0);
  });
});

describe("the request ledger", () => {
  it("keeps metadata and never a body", () => {
    const ledger = createLedger();
    ledger.record({
      at: NOW,
      klass: "opus",
      target: "work",
      model: "m",
      status: 200,
      ms: 1200,
      usage: { input: 5, output: 7 },
    });
    const [entry] = ledger.recent();
    assert.equal(entry.target, "work");
    assert.equal(entry.usage.output, 7);
    assert.equal(JSON.stringify(entry).includes("prompt"), false, "prompts are the most sensitive thing here");
  });

  it("caps itself and reports the newest first", () => {
    const ledger = createLedger({ cap: 3 });
    for (let index = 0; index < 10; index += 1) ledger.record({ at: NOW + index, klass: "opus", status: 200 });
    assert.equal(ledger.size(), 3);
    assert.equal(ledger.recent()[0].at, NOW + 9);
  });

  it("summarises without walking the caller through the list", () => {
    const ledger = createLedger();
    ledger.record({ klass: "opus", target: "work", status: 200, usage: { input: 10, output: 5 } });
    ledger.record({ klass: "sonnet", target: "glm", status: 200, usage: { input: 1, output: 1 } });
    ledger.record({ klass: "opus", target: "work", status: 429 });
    const summary = ledger.summary();
    assert.equal(summary.requests, 3);
    assert.equal(summary.byTarget.work, 2);
    assert.equal(summary.byClass.sonnet, 1);
    assert.equal(summary.tokens, 17);
  });

  it("never lets a listener break the request it was recording", () => {
    const ledger = createLedger();
    ledger.subscribe(() => {
      throw new Error("a page went away mid-write");
    });
    ledger.record({ klass: "opus", status: 200 });
    assert.equal(ledger.size(), 1);
  });

  it("has a cap that is a rolling view rather than a database", () => {
    assert.equal(DEFAULT_CAP, 500);
  });
});

describe("over a real socket", () => {
  /** A real upstream on a real port, so chunking and abort behave like themselves. */
  function startUpstream() {
    const seen = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        // Written in pieces, so the client genuinely sees a stream.
        const parts = sseBody({ model: "upstream-model" }).match(/[\S\s]{1,40}/gu) ?? [];
        let at = 0;
        const timer = setInterval(() => {
          if (at >= parts.length) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(parts[at]);
          at += 1;
        }, 1);
        // On `res`, not `req`: a request's `close` fires as soon as its body
        // has been received, which would clear the timer before a single event
        // was written.
        res.on("close", () => clearInterval(timer));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
    });
  }

  it("streams a request through end to end, and refuses a caller with no token", async () => {
    const upstream = await startUpstream();
    const ledger = createLedger();
    const target = { name: "work", kind: "anthropic", profile: "work", record: { name: "work", dir: "/tmp/work" } };
    const router = await startRouter({
      env: {},
      port: 0,
      deps: {
        config: {
          ...DEFAULT_ROUTER_CONFIG,
          targets: { work: { kind: "anthropic", profile: "work" } },
          routes: { ...DEFAULT_ROUTER_CONFIG.routes, opus: { to: ["work"] } },
          hold: { enabled: false, ceilingMs: 0, pollMs: 1000 },
        },
        selector: {
          choose: async () => ({ target, reason: null, rest: [] }),
          penalise: () => {},
          sittingOut: () => [],
        },
        tokens: {
          tokenFor: async () => ({ state: "ok", value: "upstream-token" }),
          invalidate: () => {},
          size: () => 0,
        },
        catalogue: { list: async () => ({ models: [] }), resolve: () => ({ id: null }) },
        ledger,
        bases: { anthropicBase: upstream.base, zaiBase: upstream.base },
      },
    });

    try {
      const refused = await fetch(`${router.url}/v1/messages`, { method: "POST", body: "{}" });
      assert.equal(refused.status, 401, "a caller with no token is not one of ours");

      const response = await fetch(`${router.url}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${router.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-zclaude-target"), "work");
      assert.equal(response.headers.get("content-encoding"), null, "never a lie about encoding");

      // Read it as a stream, which is the point of the whole exercise.
      const pieces = [];
      for await (const chunk of response.body) pieces.push(Buffer.from(chunk));
      const text = Buffer.concat(pieces).toString("utf8");
      assert.match(text, /message_start/u);
      assert.match(text, /message_stop/u);
      assert.ok(pieces.length > 1, "it arrived in pieces rather than all at once");

      assert.equal(upstream.seen[0].headers.authorization, "Bearer upstream-token", "signed as the account");
      assert.equal(upstream.seen[0].headers["accept-encoding"], "identity");
      assert.equal(upstream.seen[0].headers["x-api-key"], undefined, "which would bill the API instead of the plan");

      const [entry] = ledger.recent();
      assert.equal(entry.model, "upstream-model", "the model the upstream said, never the one we asked for");
      assert.equal(entry.usage.output, 20);

      const health = await fetch(`${router.url}/__zclaude/healthz`).then((one) => one.json());
      assert.equal(health.ok, true);
      assert.equal(health.served, 1, "healthz itself is not counted as served traffic");
    } finally {
      await router.close();
      upstream.server.close();
    }
  });

  it("refuses a request that does not name us as its host", async () => {
    // `fetch` will not send a Host it did not choose, so this goes through the
    // raw client. The check it exercises is the DNS-rebinding one: a page on
    // evil.com whose DNS answers 127.0.0.1 reaches the socket but arrives with
    // its own name in the header.
    const router = await startRouter({
      env: {},
      port: 0,
      deps: {
        config: { ...DEFAULT_ROUTER_CONFIG, hold: { enabled: false, ceilingMs: 0, pollMs: 1000 } },
        selector: { choose: async () => ({ target: null, rest: [] }), penalise: () => {}, sittingOut: () => [] },
        tokens: { tokenFor: async () => ({ state: "ok", value: "t" }), invalidate: () => {}, size: () => 0 },
        catalogue: { list: async () => ({ models: [] }), resolve: () => ({ id: null }) },
        ledger: createLedger(),
        bases: { anthropicBase: "http://127.0.0.1:1", zaiBase: "http://127.0.0.1:1" },
      },
    });
    try {
      const status = await new Promise((resolve, reject) => {
        const client = request(
          {
            host: "127.0.0.1",
            port: router.port,
            method: "POST",
            path: "/v1/messages",
            headers: { host: "evil.com", authorization: `Bearer ${router.token}`, "content-length": "2" },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        client.on("error", reject);
        client.end("{}");
      });
      assert.equal(status, 403);
    } finally {
      await router.close();
    }
  });
});
