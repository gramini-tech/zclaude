// Reading the usage out of a stream without touching a byte of it.
//
// A Transform that is a passthrough in the strictest sense: every chunk is
// handed on as the exact same Buffer it arrived as, never decoded and
// re-encoded. A re-serialized SSE stream is a class of bug nobody wants to
// debug at two in the morning, so the test asserts the output equals the input
// byte for byte rather than merely parsing the same.
//
// Parsing rides alongside, and is deliberately cheap. A long generation is
// thousands of `content_block_delta` events carrying text we do not care about;
// running `JSON.parse` on each would be real CPU spent on data we discard. So a
// line is only parsed when its first bytes match one of three prefixes, which a
// `startsWith` settles.
//
// What it learns matters for two things: the model that actually answered,
// which is the only honest record of where a turn went, and the token counts,
// which feed the burn estimator. An aborted stream still billed what it
// produced, so the caller records on that path too.

import { Transform } from "node:stream";

/** Past this, stop parsing and keep streaming. A stream is never held up by us. */
const MAX_TAIL_BYTES = 262_144;

const PREFIXES = Object.freeze([
  'data: {"type":"message_start"',
  'data: {"type":"message_delta"',
  'data: {"type":"error"',
]);

/**
 * @typedef {object} StreamResult
 * @property {string | null} model the id the upstream said answered
 * @property {{input: number, output: number, cacheRead: number, cacheCreation: number}} usage
 * @property {boolean} sawError whether an error event arrived mid-stream
 * @property {string | null} errorDetail
 * @property {number} bytes
 * @property {boolean} parsed false when the stream outran the parser
 */

function readUsage(from, into) {
  if (!from || typeof from !== "object") return;
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  if (from.input_tokens !== undefined) into.input = number(from.input_tokens);
  if (from.output_tokens !== undefined) into.output = number(from.output_tokens);
  if (from.cache_read_input_tokens !== undefined) into.cacheRead = number(from.cache_read_input_tokens);
  if (from.cache_creation_input_tokens !== undefined) into.cacheCreation = number(from.cache_creation_input_tokens);
}

/**
 * A tap over an SSE stream.
 * @returns {{stream: Transform, result: () => StreamResult}}
 */
export function createUsageTap() {
  const state = {
    model: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    sawError: false,
    errorDetail: null,
    bytes: 0,
    parsed: true,
  };
  let tail = "";

  const consider = (line) => {
    if (PREFIXES.every((prefix) => !line.startsWith(prefix))) return;
    let event;
    try {
      event = JSON.parse(line.slice("data: ".length));
    } catch {
      // A line that looked like one of ours and was not. Nothing to learn, and
      // certainly nothing worth failing a stream over.
      return;
    }
    if (event?.type === "message_start") {
      // The upstream's own id, which is the truth about where the turn went.
      // It is never rewritten on the way out: classOf() reads it from the
      // transcript, and a Z.ai id must stay a Z.ai id there or the Anthropic
      // burn estimator counts spend that never happened.
      if (typeof event.message?.model === "string") state.model = event.message.model;
      readUsage(event.message?.usage, state.usage);
      return;
    }
    if (event?.type === "message_delta") {
      readUsage(event.usage, state.usage);
      return;
    }
    if (event?.type !== "error") return;
    state.sawError = true;
    state.errorDetail = typeof event.error?.message === "string" ? event.error.message : (event.error?.type ?? null);
  };

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      state.bytes += chunk.length;
      // The identical buffer, never re-encoded. This is the whole contract, and
      // it happens whatever the parser below decides.
      if (!state.parsed) return callback(null, chunk);
      tail += chunk.toString("utf8");
      const lines = tail.split("\n");
      // The last piece may be half a line; keep it for the next chunk.
      tail = lines.pop() ?? "";
      for (const line of lines) consider(line);
      if (tail.length > MAX_TAIL_BYTES) {
        // One enormous line, or a stream that is not SSE at all. Stop parsing;
        // never stop streaming.
        state.parsed = false;
        tail = "";
      }
      return callback(null, chunk);
    },
    flush(callback) {
      if (tail && state.parsed) consider(tail);
      tail = "";
      callback();
    },
  });

  return { stream, result: () => ({ ...state, usage: { ...state.usage } }) };
}

/**
 * The same reading for a response that is not streamed.
 *
 * `/v1/messages` without `stream: true` answers with one JSON object, and
 * `/v1/messages/count_tokens` with another. Both are small, so this parses
 * rather than scans.
 */
export function readWholeUsage(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  readUsage(body?.usage, usage);
  return { model: typeof body?.model === "string" ? body.model : null, usage };
}
