// What changes on the way to an upstream, what changes on the way back, and
// what must not change at all.

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, it } from "node:test";

import { rewriteBody, serializeBody, stripCacheControl, stripMetadata } from "../src/router/body.js";
import {
  betasFor,
  CONTEXT_1M_BETA,
  downstreamHeaders,
  HOP_BY_HOP,
  OAUTH_BETA,
  upstreamHeaders,
} from "../src/router/headers.js";
import { createUsageTap, readWholeUsage } from "../src/router/sse.js";

const ANTHROPIC = { name: "work", kind: "anthropic" };
const ZAI = { name: "glm", kind: "zai", model: "latest" };

const CLIENT_HEADERS = {
  authorization: "Bearer local-router-token",
  "x-api-key": "sk-ant-api-should-not-survive",
  "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
  "anthropic-version": "2023-06-01",
  "accept-encoding": "gzip, br",
  "content-length": "12",
  "user-agent": "claude-cli/2.1.280 (external, cli)",
  "x-app": "cli",
  "x-stainless-retry-count": "0",
  "x-stainless-lang": "js",
  connection: "keep-alive",
  host: "127.0.0.1:34317",
  "x-zclaude-launch": "some-session-id",
  accept: "application/json",
};

describe("headers going upstream", () => {
  it("replaces the local token with the account's, and never leaks an api key", () => {
    const out = upstreamHeaders({
      incoming: CLIENT_HEADERS,
      target: ANTHROPIC,
      token: "sk-ant-oat-real",
      bodyBytes: 99,
    });
    assert.equal(out.authorization, "Bearer sk-ant-oat-real");
    // Its presence bills the API rather than the plan, so a leftover is a
    // silent billing bug rather than an error anybody would see.
    assert.equal(out["x-api-key"], undefined);
  });

  it("forwards the client's own identity verbatim", () => {
    // Subscription endpoints look at these. Substituting ours is a risk taken
    // for no benefit.
    const out = upstreamHeaders({ incoming: CLIENT_HEADERS, target: ANTHROPIC, token: "t", bodyBytes: 1 });
    assert.equal(out["user-agent"], "claude-cli/2.1.280 (external, cli)");
    assert.equal(out["x-app"], "cli");
    assert.equal(out["x-stainless-retry-count"], "0");
    assert.equal(out["x-stainless-lang"], "js");
    assert.equal(out.accept, "application/json");
  });

  it("drops hop-by-hop headers and anything of ours", () => {
    const out = upstreamHeaders({ incoming: CLIENT_HEADERS, target: ANTHROPIC, token: "t", bodyBytes: 1 });
    for (const name of HOP_BY_HOP) assert.equal(out[name], undefined, name);
    assert.equal(out["x-zclaude-launch"], undefined, "ours never leaves the machine");
  });

  it("recomputes the length and forces identity encoding", () => {
    const out = upstreamHeaders({ incoming: CLIENT_HEADERS, target: ANTHROPIC, token: "t", bodyBytes: 4096 });
    assert.equal(out["content-length"], "4096", "the body was rewritten; a stale length truncates the request");
    assert.equal(out["accept-encoding"], "identity");
    assert.equal(out["content-type"], "application/json");
  });

  it("keeps the client's betas for Anthropic and adds the one OAuth needs", () => {
    const out = upstreamHeaders({
      incoming: CLIENT_HEADERS,
      target: ANTHROPIC,
      token: "t",
      betas: ["fine-grained-tool-streaming-2025-05-14"],
      bodyBytes: 1,
    });
    const sent = new Set(out["anthropic-beta"].split(","));
    assert.ok(sent.has("fine-grained-tool-streaming-2025-05-14"), "the client's feature still works");
    assert.ok(sent.has(OAUTH_BETA), "a subscription token is refused without it");
  });

  it("turns the 1m marker into the beta that actually means it", () => {
    const out = upstreamHeaders({ target: ANTHROPIC, token: "t", betas: [], oneMillion: true, bodyBytes: 1 });
    assert.ok(out["anthropic-beta"].split(",").includes(CONTEXT_1M_BETA));
  });

  it("sends Z.ai no betas at all by default", () => {
    // Unknown values may be rejected, and the OAuth marker announces an
    // Anthropic client to a third party for nothing.
    const out = upstreamHeaders({
      incoming: CLIENT_HEADERS,
      target: ZAI,
      token: "zai-key",
      betas: ["fine-grained-tool-streaming-2025-05-14"],
      oneMillion: true,
      bodyBytes: 1,
    });
    assert.equal(out["anthropic-beta"], undefined);
    assert.equal(out.authorization, "Bearer zai-key");
    assert.equal(out["anthropic-version"], "2023-06-01", "but the shim does expect a version");
  });

  it("lets a target name the betas it wants back", () => {
    const allowed = betasFor({
      target: ZAI,
      betas: ["wanted-1", "unwanted-2"],
      allowBetas: ["wanted-1", "never-sent"],
    });
    assert.deepEqual(allowed, ["wanted-1"], "only what the client sent and the target allows");
  });

  it("works with no incoming headers at all", () => {
    const out = upstreamHeaders({ target: ANTHROPIC, token: "t", bodyBytes: 0 });
    assert.equal(out.authorization, "Bearer t");
    assert.equal(out["content-length"], "0");
  });
});

describe("headers coming back", () => {
  const upstream = new Headers({
    "content-type": "text/event-stream",
    "content-encoding": "gzip",
    "content-length": "999",
    "transfer-encoding": "chunked",
    "retry-after": "12",
    "anthropic-ratelimit-unified-5h-utilization": "41",
    "request-id": "req_abc",
  });

  it("drops the framing headers Node sets for itself", () => {
    const out = downstreamHeaders(upstream, { target: "work", klass: "opus", model: "m", attempt: 1 });
    // We asked for identity; if a shim compressed anyway fetch already decoded
    // it, so passing this on would be a lie that breaks the client's parser.
    assert.equal(out["content-encoding"], undefined);
    assert.equal(out["content-length"], undefined);
    assert.equal(out["transfer-encoding"], undefined);
  });

  it("forwards what the client's own retry and status display read", () => {
    const out = downstreamHeaders(upstream, { target: "work", klass: "opus", model: "m", attempt: 1 });
    assert.equal(out["retry-after"], "12");
    assert.equal(out["anthropic-ratelimit-unified-5h-utilization"], "41");
    assert.equal(out["request-id"], "req_abc");
    assert.equal(out["content-type"], "text/event-stream");
  });

  it("says where the request went, so a curl answers the question", () => {
    const out = downstreamHeaders(upstream, { target: "glm", klass: "sonnet", model: "glm-x", attempt: 2 });
    assert.equal(out["x-zclaude-target"], "glm");
    assert.equal(out["x-zclaude-class"], "sonnet");
    assert.equal(out["x-zclaude-model"], "glm-x");
    assert.equal(out["x-zclaude-attempt"], "2");
  });
});

describe("the request body", () => {
  const body = () => ({
    model: "claude-sonnet-5[1m]",
    metadata: { user_id: "u-1" },
    system: [{ type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Bash", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    max_tokens: 8192,
  });

  it("never mutates what it was given, because the retry re-derives from it", () => {
    const original = body();
    rewriteBody(original, ZAI, { resolvedModel: "glm-x", normalized: "claude-sonnet-5" });
    assert.equal(original.model, "claude-sonnet-5[1m]");
    assert.ok(original.system[0].cache_control, "the caller's copy is untouched");
  });

  it("sends a Z.ai target its resolved model, with no 1m marker anywhere", () => {
    const { body: out, changes } = rewriteBody(body(), ZAI, {
      resolvedModel: "glm-x",
      normalized: "claude-sonnet-5",
    });
    assert.equal(out.model, "glm-x");
    assert.doesNotMatch(JSON.stringify(out), /\[1m\]/u, "the marker is a Claude Code marker, not an API id");
    assert.ok(changes.some((change) => change.includes("model")));
  });

  it("strips cache_control and metadata for Z.ai", () => {
    const { body: out } = rewriteBody(body(), ZAI, { resolvedModel: "glm-x" });
    assert.doesNotMatch(JSON.stringify(out), /cache_control/u);
    assert.equal(out.metadata, undefined, "an account-scoped id does not belong at another provider");
  });

  it("keeps cache_control for Anthropic, which is the whole point of it", () => {
    // "Same function, strip it everywhere" is exactly the simplification
    // somebody applies later, so this is asserted rather than assumed.
    const { body: out } = rewriteBody(body(), ANTHROPIC, { normalized: "claude-sonnet-5" });
    assert.ok(out.system[0].cache_control, "system");
    assert.ok(out.tools[0].cache_control, "tools");
    assert.ok(out.messages[0].content[0].cache_control, "message content");
    assert.ok(out.metadata, "and the metadata belongs to this account");
  });

  it("drops the 1m marker for Anthropic too, keeping the model otherwise", () => {
    const { body: out } = rewriteBody(body(), ANTHROPIC, { normalized: "claude-sonnet-5" });
    assert.equal(out.model, "claude-sonnet-5");
  });

  it("leaves max_tokens and system alone, always", () => {
    for (const target of [ANTHROPIC, ZAI]) {
      const { body: out } = rewriteBody(body(), target, { resolvedModel: "x", normalized: "y" });
      assert.equal(out.max_tokens, 8192, `${target.kind}: shortening a response silently is a bug report later`);
      assert.equal(out.system[0].text, "You are Claude Code", `${target.kind}: the prefix is load-bearing`);
    }
  });

  it("honours an explicit override on a target", () => {
    const stripping = { name: "x", kind: "anthropic", stripCacheControl: true, stripMetadata: true };
    const { body: out } = rewriteBody(body(), stripping, { normalized: "claude-sonnet-5" });
    assert.doesNotMatch(JSON.stringify(out), /cache_control/u);
    assert.equal(out.metadata, undefined);
  });

  it("copes with a body that is not the shape it expects", () => {
    assert.deepEqual(rewriteBody(null, ZAI).body, null);
    assert.deepEqual(rewriteBody("nope", ZAI).body, "nope");
    assert.deepEqual(stripCacheControl(null), null);
    assert.deepEqual(stripMetadata(null), null);
    const { body: bare } = rewriteBody({ model: "m" }, ZAI, { resolvedModel: "glm" });
    assert.equal(bare.model, "glm");
  });

  it("measures the bytes from the same string it sends", () => {
    const { text, bytes } = serializeBody({ model: "m", note: "é" });
    assert.equal(bytes, Buffer.byteLength(text, "utf8"));
    assert.ok(bytes > text.length - 1, "a multi-byte character is counted in bytes, not characters");
  });
});

describe("tapping a stream", () => {
  const event = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
  const STREAM = [
    event("message_start", {
      message: { model: "claude-opus-5", usage: { input_tokens: 11, cache_read_input_tokens: 9000 } },
    }),
    ...Array.from({ length: 50 }, (_, index) => event("content_block_delta", { delta: { text: `tok${index} ` } })),
    event("message_delta", { usage: { output_tokens: 77 } }),
    event("message_stop", {}),
  ];

  async function run(chunks) {
    const tap = createUsageTap();
    const out = [];
    await pipeline(Readable.from(chunks), tap.stream, async (source) => {
      for await (const chunk of source) out.push(Buffer.from(chunk));
    });
    return { out: Buffer.concat(out), result: tap.result() };
  }

  it("passes the bytes through unchanged", async () => {
    const input = STREAM.map((text) => Buffer.from(text));
    const { out } = await run(input);
    assert.ok(out.equals(Buffer.concat(input)), "byte for byte, never decoded and re-encoded");
  });

  it("reads the model and the token counts without touching the stream", async () => {
    const { result } = await run(STREAM.map((text) => Buffer.from(text)));
    assert.equal(result.model, "claude-opus-5");
    assert.deepEqual(result.usage, { input: 11, output: 77, cacheRead: 9000, cacheCreation: 0 });
    assert.equal(result.sawError, false);
    assert.equal(result.parsed, true);
  });

  it("reads events split across chunk boundaries", async () => {
    // A real socket does not deliver whole events, so this splits mid-JSON.
    const whole = STREAM.join("");
    const chunks = [];
    for (let at = 0; at < whole.length; at += 7) chunks.push(Buffer.from(whole.slice(at, at + 7)));
    const { out, result } = await run(chunks);
    assert.equal(result.model, "claude-opus-5");
    assert.equal(result.usage.output, 77);
    assert.equal(out.toString(), whole);
  });

  it("notices an error event mid-stream, which cannot be recovered from", async () => {
    const withError = [STREAM[0], event("error", { error: { type: "overloaded_error", message: "too busy" } })];
    const { result } = await run(withError.map((text) => Buffer.from(text)));
    assert.equal(result.sawError, true);
    assert.equal(result.errorDetail, "too busy");
  });

  it("keeps streaming when it can no longer parse", async () => {
    // One enormous line, or a body that is not SSE at all. Never hold up a
    // stream for the sake of accounting.
    const huge = Buffer.from(`data: ${"x".repeat(300_000)}`);
    const { out, result } = await run([huge]);
    assert.equal(result.parsed, false);
    assert.ok(out.equals(huge), "the bytes still arrived");
  });

  it("ignores a line that looks like ours and is not", async () => {
    const broken = Buffer.from('data: {"type":"message_start" this is not json\n\n');
    const { out, result } = await run([broken]);
    assert.equal(result.model, null, "nothing learned, and nothing thrown");
    assert.ok(out.equals(broken));
  });

  it("reads a whole non-streamed reply too", () => {
    const read = readWholeUsage(JSON.stringify({ model: "glm-x", usage: { input_tokens: 5, output_tokens: 6 } }));
    assert.equal(read.model, "glm-x");
    assert.equal(read.usage.input, 5);
    assert.equal(read.usage.output, 6);
    assert.equal(readWholeUsage("not json"), null);
  });
});
