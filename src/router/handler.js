// One request, end to end.
//
// Orchestration only: no `fs`, no `node:http`, no `fetch`. Everything that
// touches the world arrives in `deps`, which is what lets the whole lifecycle
// be tested against a fake request and a collecting response with no sockets.
//
// The shape of the file is the design. There is exactly one `res.writeHead`,
// in `commit`, and it is the moment after which nothing can be retried: the
// account is chosen, the bytes are the upstream's, and a failure from there on
// is a truncated stream rather than a failover. Every decision therefore
// happens above it. If a second `writeHead` ever appears here, mid-stream
// failover has been introduced by accident and the failure mode is duplicated
// or contradictory output in somebody's terminal.
//
// The request body is held in memory until that moment for the same reason. It
// is not held for the rewrite, which could be done once; it is held because a
// 401 or a quota 429 from the first account has to be replayable against the
// second, and Node hands you a request body exactly once.

import { log } from "../logger.js";
import { rewriteBody, serializeBody } from "./body.js";
import { classifyRequest } from "./classify.js";
import { errorBody, holdFor } from "./hold.js";
import { downstreamHeaders, upstreamHeaders } from "./headers.js";
import { classifyFailure, readQuotaHeaders } from "./retry.js";
import { createUsageTap, readWholeUsage } from "./sse.js";
import { candidatesFor } from "./table.js";
import { forward, urlFor } from "./upstream.js";

/** Past this, a request is refused rather than buffered. */
export const DEFAULT_BODY_CAP = 67_108_864;
/** How many targets are tried before giving up on a request. */
const MAX_TARGETS = 4;

/**
 * Read the whole body, refusing one that will not fit.
 *
 * @returns {Promise<{buffer: Buffer | null, tooLarge: boolean}>}
 */
export async function readBody(req, cap = DEFAULT_BODY_CAP) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) return { buffer: null, tooLarge: true };
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), tooLarge: false };
}

/** An Anthropic-shaped error, which is the only shape the client knows. */
function fail(res, { status, type, message, extra = {} }) {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(errorBody(type, message));
}

/**
 * One attempt against one target, up to but not including any commitment.
 *
 * Everything this returns is a decision, never a side effect on the response.
 * Keeping it that way is what lets the caller hold the single `writeHead`.
 */
async function attemptOnce({ target, request, parsed, buffer, req, path, deps, sameTargetAttempts }) {
  const { now } = deps;
  const token = await deps.tokens.tokenFor(target, { now: now(), signal: deps.clientGone });
  if (token.state !== "ok") {
    return {
      action: "next",
      upstream: { status: 0, headers: new Headers() },
      decision: {
        action: "next-target",
        penalise: false,
        penaltyMs: null,
        waitMs: 0,
        why: token.detail ?? token.state,
      },
    };
  }

  const resolved = target.kind === "zai" ? await resolveModel(target, deps, request) : null;
  const { body: next } = parsed
    ? rewriteBody(parsed, target, { resolvedModel: resolved, normalized: request.normalized })
    : { body: null };
  const sending = next ? serializeBody(next) : { text: buffer.toString("utf8"), bytes: buffer.length };

  const upstream = await forward({
    url: urlFor(target, path, deps.bases),
    method: req.method ?? "POST",
    headers: upstreamHeaders({
      incoming: req.headers,
      target,
      token: token.value,
      betas: request.betas,
      oneMillion: request.oneMillion,
      bodyBytes: sending.bytes,
      allowBetas: target.betas,
    }),
    body: sending.text,
    signal: deps.clientGone,
    timeoutMs: deps.config.limits.upstreamTimeoutMs,
    fetchImpl: deps.fetchImpl,
  });

  if (deps.clientGone?.aborted) return { action: "aborted", upstream, decision: null, resolved };

  // Free telemetry: these arrive on every subscription response, so the usage
  // endpoint becomes a fallback rather than the only source.
  const quota = readQuotaHeaders(upstream.headers, now());
  if (quota && target.record?.name) {
    deps.observeUsage?.(target.record.name, quota, { env: deps.env, now: now() })?.catch?.(() => {});
  }

  const decision = classifyFailure({
    status: upstream.status,
    headers: upstream.headers,
    bodyText: upstream.text ?? "",
    error: upstream.error,
    sameTargetAttempts,
    burst: deps.config.burst,
    now: now(),
  });
  const action = decision.action === "serve" || decision.action === "surface" ? decision.action : "next";
  return { action, upstream, decision, resolved };
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Work through the chain until something answers or nothing is left.
 *
 * Returns what to do, never doing it: the caller owns the response.
 */
async function runAttempts({ first, request, parsed, buffer, req, path, deps, pick }) {
  const excluded = new Set();
  let target = first;
  let index = 0;
  let sameTargetAttempts = 0;

  while (target && index < MAX_TARGETS) {
    const answer = await attemptOnce({ target, request, parsed, buffer, req, path, deps, sameTargetAttempts });
    if (answer.action !== "next") return { ...answer, target, attemptIndex: index };

    const { decision } = answer;
    if (decision.penalise) {
      deps.selector.penalise(target.record?.name ?? target.name, {
        untilMs: decision.penaltyMs,
        why: decision.why,
        now: deps.now(),
      });
      deps.affinity?.release(request);
    }
    if (decision.action === "retry-same") {
      sameTargetAttempts += 1;
      if (decision.waitMs > 0) await (deps.waitImpl ?? sleep)(decision.waitMs);
      // A 401 means the token died between being read and being used, which is
      // expected here: re-read it rather than blaming the account.
      if (answer.upstream.status === 401 || answer.upstream.status === 403) deps.tokens.invalidate(target);
      continue;
    }

    excluded.add(target.record?.name ?? target.name);
    index += 1;
    sameTargetAttempts = 0;
    ({ target } = await pick(excluded));
  }
  return { action: "exhausted", target: null, attemptIndex: index };
}

/**
 * The `/v1/messages` lifecycle.
 *
 * @param {{req: object, res: object, path: string, deps: object}} input
 */
export async function handleMessages({ req, res, path, deps: given }) {
  // Normalised once, here, so every function below reads the same clock. A
  // default applied locally and not written back left `deps.now` undefined in
  // the helpers, which is the kind of bug that only shows up over a socket.
  const deps = { ...given, now: given.now ?? Date.now };
  const { config, selector, ledger, now } = deps;
  const startedAt = now();

  const { buffer, tooLarge } = await readBody(req, config.limits.bodyBytes);
  if (tooLarge) {
    const message = `the request body is larger than ${config.limits.bodyBytes} bytes`;
    fail(res, { status: 413, type: "invalid_request_error", message });
    return;
  }

  // A body that will not parse is forwarded as it arrived rather than refused.
  // A router that rejects what the upstream would have accepted is worse than
  // no router.
  let parsed = null;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    log.debug("router", "body did not parse; forwarding it unchanged", { bytes: buffer.length });
  }

  const request = classifyRequest(parsed, { betas: req.headers["anthropic-beta"] });
  const { targets: candidates } = candidatesFor(config, request.klass);
  const preferred = deps.affinity?.get(request) ?? null;
  const pick = (excluded = new Set()) =>
    selector.choose({ candidates, klass: request.klass, now: now(), excluded, prefer: preferred });

  let first = (await pick()).target;
  if (!first) {
    // Nothing in the chain can take it. Wait for something to come back, then
    // fail with a real status code rather than a stream nobody asked for.
    const held = await holdFor({
      tryChoose: () => pick(),
      ceilingMs: config.hold.enabled ? config.hold.ceilingMs : 0,
      pollMs: config.hold.pollMs,
      now,
      waitImpl: deps.waitImpl,
      signal: deps.clientGone,
    });
    if (held.outcome === "aborted") return;
    if (held.outcome !== "served") {
      ledger?.record({ at: startedAt, klass: request.klass, target: null, status: 429, ms: now() - startedAt });
      fail(res, {
        status: 429,
        type: "rate_limit_error",
        message: "every account for this class of model is spent",
        extra: { "retry-after": String(Math.ceil((held.retryAfterMs ?? 60_000) / 1000)) },
      });
      return;
    }
    first = held.target;
  }

  const outcome = await runAttempts({ first, request, parsed, buffer, req, path, deps, pick });
  if (outcome.action === "aborted") return;
  if (outcome.action === "exhausted") {
    ledger?.record({ at: startedAt, klass: request.klass, target: null, status: 503, ms: now() - startedAt });
    fail(res, {
      status: 503,
      type: "api_error",
      message: "every account for this class of model refused the request",
    });
    return;
  }
  await commit({
    res,
    answer: outcome,
    target: outcome.target,
    request,
    deps,
    startedAt,
    attemptIndex: outcome.attemptIndex,
  });
}

/** Resolve a Z.ai target's selector against what the provider currently has. */
async function resolveModel(target, deps, request) {
  try {
    const list = await deps.catalogue.list({ provider: "zai", env: deps.env, now: deps.now() });
    const { id, detail } = deps.catalogue.resolve(target.model, list);
    if (detail) log.info("router", "model selector resolved with a note", { selector: target.model, detail });
    return id;
  } catch (error) {
    log.warn("router", "model catalogue unavailable; using the selector as written", { error });
    return typeof target.model === "string" && target.model.startsWith("latest") ? request.normalized : target.model;
  }
}

/**
 * The one place a response is committed.
 *
 * After `writeHead` the account is fixed and nothing can be retried, which is
 * why every decision is above this line. Keep it that way.
 */
async function commit({ res, answer, target, request, deps, startedAt, attemptIndex }) {
  const { upstream } = answer;
  const { now = Date.now, ledger } = deps;
  const headers = downstreamHeaders(upstream.headers, {
    target: target.name,
    klass: request.klass,
    model: answer.resolved ?? request.normalized,
    attempt: attemptIndex + 1,
  });

  // ---- the point of no return ----
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    const text = upstream.text ?? "";
    res.end(text);
    const read = readWholeUsage(text);
    ledger?.record({
      at: startedAt,
      klass: request.klass,
      target: target.name,
      model: read?.model ?? answer.resolved ?? request.normalized,
      status: upstream.status,
      ms: now() - startedAt,
      usage: read?.usage,
    });
    return;
  }

  const tap = createUsageTap();
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  try {
    await pipeline(Readable.fromWeb(upstream.body), tap.stream, res);
  } catch (error) {
    // A failure after the first byte is a truncated stream, never a failover.
    log.warn("router", "stream failed after it was committed", { target: target.name, error });
  } finally {
    const seen = tap.result();
    // An aborted stream still billed what it produced, so this runs on that
    // path too. Skipping it is how an account drifts out of step with reality
    // after somebody hits escape ten times.
    ledger?.record({
      at: startedAt,
      klass: request.klass,
      target: target.name,
      model: seen.model ?? answer.resolved ?? request.normalized,
      status: upstream.status,
      ms: now() - startedAt,
      usage: seen.usage,
      bytes: seen.bytes,
      error: seen.sawError ? seen.errorDetail : null,
    });
  }
}
