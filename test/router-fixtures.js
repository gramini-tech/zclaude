// Fakes for the request lifecycle, so the handler can be tested with no
// sockets. `handler.js` never imports node:http, which is what makes this work.

import { Readable } from "node:stream";

/** A readable request with the two properties the handler reads. */
export function fakeRequest({ method = "POST", url = "/v1/messages", headers = {}, body = "" } = {}) {
  const stream = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  return Object.assign(stream, { method, url, headers });
}

/**
 * A response that collects rather than writes, and counts its commitments.
 *
 * `writeHeadCalls` is the one that matters: the handler must call it exactly
 * once, because that is the moment after which no failover is possible.
 */
export function collectingResponse() {
  const chunks = [];
  let status = null;
  let headers = null;
  let writeHeadCalls = 0;
  let ended = false;
  const listeners = new Map();

  const res = {
    writableEnded: false,
    writeHead(code, given) {
      writeHeadCalls += 1;
      status = code;
      headers = given ?? {};
      return res;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      ended = true;
      res.writableEnded = true;
      const onFinish = listeners.get("finish") ?? [];
      for (const fn of onFinish) fn();
      return res;
    },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return res;
    },
    once(event, fn) {
      return res.on(event, fn);
    },
    emit(event) {
      const fns = listeners.get(event) ?? [];
      for (const fn of fns) fn();
    },
    removeListener() {
      return res;
    },
    destroy() {
      ended = true;
      res.writableEnded = true;
      return res;
    },
  };

  return {
    res,
    status: () => status,
    headers: () => headers,
    writeHeadCalls: () => writeHeadCalls,
    chunks: () => chunks,
    text: () => Buffer.concat(chunks).toString("utf8"),
    json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
    ended: () => ended,
  };
}

/** One SSE event, in the shape the Messages API sends. */
export const sseEvent = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

/** A short but complete generation. */
export function sseBody({ model = "test-model", input = 10, output = 20 } = {}) {
  return [
    sseEvent("message_start", { message: { model, usage: { input_tokens: input } } }),
    sseEvent("content_block_delta", { delta: { text: "hello" } }),
    sseEvent("message_delta", { usage: { output_tokens: output } }),
    sseEvent("message_stop"),
  ].join("");
}

/** A Response whose body is a stream, as a real streaming reply is. */
export function streamingResponse(text, { status = 200, headers = {} } = {}) {
  // `Response` gives the body back as a stream, so there is no need to build a
  // ReadableStream by hand for a fixture, and no need to reach for a global the
  // project's Node floor does not consider stable.
  return new Response(text, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

/**
 * A fetch that answers from a list of rules and records every call.
 *
 * Each rule is `{when, reply}`: `when` is matched against the url, and `reply`
 * is a Response or a function returning one. A rule with `times` is used that
 * many times and then falls through to the next, which is how a "fails once
 * then works" case is written. The field is `reply` rather than `then` because
 * an object carrying `then` can be mistaken for a promise by anything that
 * awaits it.
 */
export function fakeUpstream(rules) {
  const calls = [];
  const used = new Map();
  const impl = async (url, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers,
      authorization: headers.get("authorization"),
      body: typeof init.body === "string" ? init.body : null,
      json: (() => {
        try {
          return JSON.parse(init.body);
        } catch {
          return null;
        }
      })(),
      signal: init.signal,
    });
    for (const [index, rule] of rules.entries()) {
      if (rule.when && !String(url).includes(rule.when)) continue;
      const spent = used.get(index) ?? 0;
      if (rule.times !== undefined && spent >= rule.times) continue;
      used.set(index, spent + 1);
      return typeof rule.reply === "function" ? rule.reply(calls.at(-1)) : rule.reply;
    }
    throw new Error(`no rule matched ${url}`);
  };
  impl.calls = calls;
  return impl;
}
