// The listener, and the only file here with a socket or a signal handler.
//
// Loopback only, with no setting that could change it in any phase. A router
// bound to anything else is an open proxy for somebody else's subscription, and
// the convenience of a LAN bind is not worth that sentence appearing in an
// incident report.
//
// Binding to 127.0.0.1 is necessary and not sufficient, because a page in the
// user's own browser can reach it. Two checks close that:
//
//   Host       must parse to a loopback name with our port. A page on evil.com
//              whose DNS answers 127.0.0.1 arrives with `Host: evil.com`, and
//              this is four lines of DNS-rebinding defence.
//   Bearer     compared with timingSafeEqual against a per-run token. Claude
//              Code sends it because zclaude put it in ANTHROPIC_AUTH_TOKEN at
//              launch; a browser has no way to know it.
//
// Cookies are ignored on the proxied paths entirely, which is what stops a
// hostile page spending somebody's quota: the browser has no token, and the
// cookie it might have is not accepted here.
//
// Everything a request does lives in handler.js. This file accepts, checks,
// dispatches, and gets out of the way.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { log } from "../logger.js";
import { registerSecret } from "../redact.js";
import { HOST } from "./config.js";
import { errorBody } from "./hold.js";
import { handleMessages } from "./handler.js";

/** SSE is long-lived; a short keep-alive would cut idle connections needlessly. */
const KEEP_ALIVE_MS = 65_000;
const HEADERS_TIMEOUT_MS = 70_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** A token that means "zclaude launched this", and nothing else. */
export function mintToken() {
  const token = `zcr_${randomBytes(32).toString("base64url")}`;
  registerSecret(token);
  return token;
}

/** Constant-time, and length-safe: a mismatch must not be a length oracle. */
export function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The bearer a request carries, from either header Claude Code might use. */
export function bearerFrom(headers) {
  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const key = headers["x-api-key"];
  return typeof key === "string" ? key.trim() : "";
}

/** Whether the Host header names us, which is the rebinding check. */
export function hostAllowed(host, port) {
  if (typeof host !== "string" || !host) return false;
  const at = host.lastIndexOf(":");
  const name = at > 0 && !host.endsWith("]") ? host.slice(0, at) : host;
  const given = at > 0 && !host.endsWith("]") ? host.slice(at + 1) : "";
  if (!LOOPBACK.has(name)) return false;
  return given === "" || given === String(port);
}

function refuse(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(errorBody(type, message));
}

/**
 * Start listening.
 *
 * @param {{env?: NodeJS.ProcessEnv, port: number, token?: string, deps: object}} args
 * @returns {Promise<{port: number, token: string, close: () => Promise<void>, url: string}>}
 */
export async function startRouter({ env = process.env, port, token = mintToken(), deps }) {
  const started = Date.now();
  let served = 0;
  let lastServedAt = 0;
  // The port actually bound, which is not the one asked for when that was 0.
  // Checking Host against the requested port refused every request in
  // ephemeral-port mode, which is what the tests and `--port 0` use.
  let bound = port;

  const server = createServer((req, res) => {
    // A socket that goes away aborts the upstream, so an escape key closes the
    // generation rather than leaving one running for nobody.
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) gone.abort(new Error("the client went away"));
    });

    handle(req, res, gone).catch((error) => {
      log.error("router", "a request failed outside the handler", { error });
      if (!res.headersSent) refuse(res, 500, "api_error", "the router failed to handle this request");
      else res.end();
    });
  });

  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  // A long generation is a response, not a request. A request timeout would cut
  // an upload on a slow loop, so the body cap is the protection instead.
  server.requestTimeout = 0;
  server.on("connection", (socket) => {
    // SSE under Nagle adds up to 40ms per event, which on a token stream is the
    // difference between reading along and waiting.
    socket.setNoDelay(true);
  });

  async function handle(req, res, gone) {
    const [path] = (req.url ?? "/").split("?", 1);

    if (path === "/__zclaude/healthz") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          port: bound,
          pid: process.pid,
          uptimeMs: Date.now() - started,
          served,
          lastServedAt: lastServedAt || null,
        }),
      );
      return;
    }

    if (!hostAllowed(req.headers.host, bound)) {
      log.warn("router", "a request arrived for a host that is not us", { host: req.headers.host });
      refuse(res, 403, "permission_error", "this router answers on 127.0.0.1 only");
      return;
    }
    if (!tokenMatches(bearerFrom(req.headers), token)) {
      log.warn("router", "unauthenticated caller", { path });
      refuse(res, 401, "authentication_error", "this router only answers zclaude-launched sessions");
      return;
    }

    served += 1;
    lastServedAt = Date.now();
    await handleMessages({ req, res, path, deps: { ...deps, env, clientGone: gone.signal } });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // `exclusive` so two routers cannot quietly share a port and answer half
    // the requests each.
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  bound = typeof address === "object" && address ? address.port : port;
  log.info("router", "listening", { port: bound });

  return {
    port: bound,
    token,
    url: `http://${HOST}:${bound}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
