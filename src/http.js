// fetch wrapper with timeouts, Z.ai envelope decoding and secret redaction.
// Every error thrown from here names the method, host and status so users can
// tell which hop failed without leaking the credential.

import { networkError, ZclaudeError } from "./errors.js";

const secrets = new Set();

/** Register a value that must never appear in error text. */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}

export function redact(text) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(`****${secret.slice(-4)}`);
  }
  out = out.replaceAll(/(Bearer\s+)[\w.~+/=-]{8,}/giu, "$1****");
  out = out.replaceAll(/\b([A-Za-z0-9]{16,})\.([A-Za-z0-9]{12,})\b/gu, (_, id) => `${id.slice(0, 4)}****`);
  return out;
}

class HttpError extends ZclaudeError {
  constructor({ method, url, status, bodyText, exitCode }) {
    const host = safeHost(url);
    super(`${method} ${host} returned HTTP ${status}${summarize(bodyText)}`, { exitCode });
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.bodyText = bodyText;
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

function summarize(bodyText) {
  const text = redact(String(bodyText ?? "").trim()).replaceAll(/\s+/gu, " ");
  if (!text) return "";
  return `: ${text.slice(0, 200)}`;
}

function classifyNetworkError(error, method, url) {
  const host = safeHost(url);
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return networkError(`${method} ${host} timed out`, "Check your connection and try again.", error);
  }
  const code = error?.cause?.code ?? error?.code;
  const detail = code ? ` (${code})` : "";
  return networkError(
    `Could not reach ${host}${detail}`,
    "Check DNS, proxy or firewall settings. Z.ai must be reachable from this machine.",
    error,
  );
}

/**
 * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {string} url
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body] JSON-encoded unless already a string
 * @property {number} [timeoutMs]
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 */

/**
 * Perform a request and return { status, text, json, ok }. Never throws on a
 * non-2xx status; callers decide what each status means. Throws a network
 * error (exit 6) when the request could not complete at all.
 * @param {RequestOptions} options
 * @returns {Promise<{status: number, text: string, json: any, ok: boolean}>}
 */
export async function request({
  method = "GET",
  url,
  headers = {},
  body,
  timeoutMs = 15_000,
  fetchImpl = fetch,
  signal,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  const onOuterAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const init = { method, headers: { Accept: "application/json", ...headers }, signal: controller.signal };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw classifyNetworkError(controller.signal.reason ?? error, method, url);
    }
    const text = await response.text();
    let json;
    if (text.trim()) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, text, json, ok: response.ok };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function envelopeSucceeded(body) {
  if (!body || typeof body !== "object" || body.success === false) return false;
  const { code } = body;
  if (code === undefined || code === null) return true;
  return [0, 200, "0", "200"].includes(code);
}

/**
 * Perform a request against a Z.ai envelope endpoint ({code, msg, data}) and
 * return `data`. Non-2xx or a failing envelope raises with `exitCode`.
 * @param {RequestOptions} options
 * @param {{operation: string, exitCode: number}} meta
 * @returns {Promise<any>}
 */
export async function requestEnvelope(options, { operation, exitCode }) {
  const { method = "GET", url } = options;
  const response = await request(options);
  if (!response.ok) {
    throw new HttpError({ method, url, status: response.status, bodyText: response.text, exitCode });
  }
  const body = response.json;
  if (!body || typeof body !== "object") {
    throw new ZclaudeError(`${operation}: ${safeHost(url)} returned a non-JSON response`, { exitCode });
  }
  if (!envelopeSucceeded(body)) {
    const msg = typeof body.msg === "string" && body.msg.trim() ? body.msg.trim() : `code ${body.code}`;
    throw new ZclaudeError(`${operation} failed: ${redact(msg)}`, { exitCode });
  }
  return body.data === undefined ? body : body.data;
}
