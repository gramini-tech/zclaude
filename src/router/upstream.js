// The forward itself: one request out, one response back, nothing buffered.
//
// `src/http.js` cannot do this. It ends with `await response.text()`, which is
// right for a usage lookup and fatal for a generation: it would hold the whole
// answer before the first token reached the terminal. So this is a separate,
// smaller path that hands back the response with its body still a stream.
//
// Two details are not cosmetic. The abort signal is wired to the client going
// away, so a user pressing escape closes the upstream socket rather than
// leaving a generation running that nobody will read. And a JSON reply is
// peeked rather than streamed, because Z.ai's shim answers some failures with
// HTTP 200 and an error envelope, and that has to be classified before anything
// is committed to the client.

import { log } from "../logger.js";

/**
 * @typedef {object} Upstream
 * @property {number} status
 * @property {Headers} headers
 * @property {ReadableStream | null} body still a stream, when it is one
 * @property {string | null} text the whole body, for a small JSON reply
 * @property {object | null} json parsed, when it parsed
 * @property {Error | null} error set when the request could not be made at all
 */

/** Whether this reply is worth reading whole before deciding anything. */
function isJson(headers) {
  const type = headers.get("content-type") ?? "";
  return type.includes("json");
}

/**
 * Send one request and hand back what came without consuming the body.
 *
 * @param {{url: string, method?: string, headers: Record<string, string>, body?: string | null, signal?: AbortSignal, timeoutMs?: number, fetchImpl?: typeof fetch}} args
 * @returns {Promise<Upstream>}
 */
export async function forward({
  url,
  method = "POST",
  headers,
  body = null,
  signal,
  timeoutMs = 600_000,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("the upstream took too long")), timeoutMs);
  timer.unref?.();
  // The client going away aborts the upstream, so an escape key closes the
  // socket rather than leaving a generation running for nobody.
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    const at = new URL(url);
    log.debug("router", "upstream answered", { host: at.host, path: at.pathname, status: response.status });

    if (!isJson(response.headers)) {
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        text: null,
        json: null,
        error: null,
      };
    }
    // A JSON reply is small, and a Z.ai envelope error arrives inside a 200.
    // Reading it here is what lets the decision happen before any commitment.
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Content-type said JSON and it was not. The text still goes back.
    }
    return {
      status: response.status,
      headers: response.headers,
      body: null,
      text,
      json,
      error: null,
    };
  } catch (error) {
    // An abort the caller asked for is not a failure of the upstream.
    const reason = signal?.aborted ? (signal.reason ?? error) : error;
    return { status: 0, headers: new Headers(), body: null, text: null, json: null, error: reason };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Where a target's requests go.
 *
 * The path is carried through untouched, so an endpoint Claude Code learns next
 * year reaches the same place without anything here being updated.
 */
export function urlFor(target, path, { anthropicBase = "https://api.anthropic.com", zaiBase }) {
  const base = target.kind === "zai" ? zaiBase : anthropicBase;
  // Trimmed in a loop rather than with `/\/+$/`, whose backtracking is
  // super-linear on a pathological input. A base URL is short, but a regex on
  // attacker-adjacent input is not worth the argument.
  let trimmed = String(base);
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return `${trimmed}${path}`;
}
