// The `/__zclaude/*` surface: what the local page and the CLI talk to.
//
// This path is partitioned from `/v1/*` on purpose, and the partition is the
// security decision in this file rather than a tidiness one.
//
//   /v1/*          bearer only, cookies ignored entirely. A page in the user's
//                  browser has no way to learn the bearer, so it cannot make
//                  the browser spend somebody's quota.
//   /__zclaude/*   a cookie (the page) or the bearer (the CLI), never the
//                  Claude Code token by itself for a write.
//
// The page never sees the bearer. `zclaude router open` mints a single-use
// ticket, valid for sixty seconds, and the browser exchanges it for an
// HttpOnly, SameSite=Strict cookie on the first load. So the long-lived token
// never lands in browser history, in a bookmark, or in page JavaScript.
//
// There are no CORS headers here and there never will be. Every write also
// needs an Origin that is us, a JSON content type, and a CSRF header matching
// the cookie, which is three independent reasons a cross-site form post fails.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../logger.js";
import { listAllModels } from "./catalogue.js";
import { HOST, ROUTE_CLASSES, loadRouterConfig, writeRouterConfig } from "./config.js";
import { listRegistered } from "../profiles/registry.js";
import { validateRouteTable } from "./table.js";

/** A ticket is for the moment between `router open` and the browser opening. */
const TICKET_MS = 60_000;
/** A page session. Short, because reopening it is one command. */
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE = "zclaude_router_ui";
const CSRF_COOKIE = "zclaude_router_csrf";

const here = dirname(fileURLToPath(import.meta.url));
// An explicit map, never a path join from the URL. A join is how a proxy ends
// up serving `../../.ssh/id_rsa` to whoever asks nicely.
const ASSETS = Object.freeze({
  "/__zclaude/ui": { file: "app.html", type: "text/html; charset=utf-8" },
  "/__zclaude/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/__zclaude/ui/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
});

// No inline script, no remote anything. The page is hand-written and already
// satisfies this, so it costs nothing and closes an injection route.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The cookies on a request, as a map. Nothing here needs a library. */
export function parseCookies(header) {
  const out = new Map();
  const parts = String(header ?? "").split(";");
  for (const raw of parts) {
    const part = raw.trim();
    const at = part.indexOf("=");
    // `at < 1` rather than `=== -1`: a leading "=" is a value with no name,
    // and an empty name would shadow a real cookie in the map.
    if (at < 1) continue;
    out.set(part.slice(0, at), decodeURIComponent(part.slice(at + 1)));
  }
  return out;
}

function send(res, status, body, extra = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  res.end(text);
}

/**
 * @param {{env?: NodeJS.ProcessEnv, config: object, ledger: object, selector: object, security?: object, fetchImpl?: typeof fetch}} input
 */
export function createControl({ env = process.env, config, ledger, selector, security, fetchImpl }) {
  /** @type {Map<string, number>} ticket to its expiry */
  const tickets = new Map();
  /** @type {Map<string, {csrf: string, until: number}>} */
  const sessions = new Map();
  let port = 0;
  let token = "";
  let live = config;

  const sweep = (now) => {
    for (const [id, until] of tickets) if (until <= now) tickets.delete(id);
    for (const [id, one] of sessions) if (one.until <= now) sessions.delete(id);
  };

  /** Who is asking: the CLI with its bearer, the page with its cookie, nobody. */
  function principal(req) {
    const authorization = req.headers.authorization ?? "";
    if (authorization.startsWith("Bearer ") && equal(authorization.slice(7).trim(), token)) {
      return { kind: "cli", csrf: null };
    }
    const id = parseCookies(req.headers.cookie).get(COOKIE);
    const session = id ? sessions.get(id) : null;
    if (session && session.until > Date.now()) return { kind: "ui", csrf: session.csrf };
    return null;
  }

  /**
   * Whether a write is allowed to proceed, beyond merely being authenticated.
   *
   * Three checks rather than one because each fails a different attack, and
   * any one of them alone has a known bypass.
   */
  function writeAllowed(req, who) {
    if (who.kind === "cli") return { ok: true };
    const { origin } = req.headers;
    if (origin && origin !== `http://${HOST}:${port}`) return { ok: false, why: "that origin is not this router" };
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
      return { ok: false, why: "a JSON content type is required" };
    }
    if (!equal(String(req.headers["x-zclaude-csrf"] ?? ""), who.csrf ?? "")) {
      return { ok: false, why: "the CSRF header did not match this session" };
    }
    return { ok: true };
  }

  async function readJson(req, cap = 1_048_576) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > cap) throw new Error("that is more configuration than the router will accept");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async function serveAsset(res, path) {
    const asset = ASSETS[path];
    if (!asset) {
      send(res, 404, { error: "no such page" });
      return;
    }
    try {
      const body = await readFile(join(here, "ui", asset.file), "utf8");
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(body);
    } catch (error) {
      log.warn("router", "a page asset is missing", { path, error });
      send(res, 500, { error: "the local page is not installed" });
    }
  }

  /** Exchange a ticket for a cookie, then send the browser to a clean URL. */
  function redeem(res, ticket) {
    const now = Date.now();
    sweep(now);
    if (!ticket || !tickets.delete(ticket)) {
      send(res, 403, { error: "that link has been used or has expired" });
      return;
    }
    const id = randomBytes(24).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    sessions.set(id, { csrf, until: now + SESSION_MS });
    const age = Math.floor(SESSION_MS / 1000);
    res.writeHead(303, {
      location: "/__zclaude/ui",
      // Two cookies, and the split is the double-submit pattern. The session
      // id is HttpOnly so no script can read it; the CSRF value is readable so
      // the page can echo it in a header, which a cross-site request cannot do
      // because it cannot read the cookie. Path is scoped to the control plane,
      // so neither is ever sent on a proxied request by accident.
      "set-cookie": [
        `${COOKIE}=${id}; Path=/__zclaude/; HttpOnly; SameSite=Strict; Max-Age=${age}`,
        `${CSRF_COOKIE}=${csrf}; Path=/__zclaude/; SameSite=Strict; Max-Age=${age}`,
      ],
      "cache-control": "no-store",
    });
    res.end();
  }

  async function state() {
    const loaded = await loadRouterConfig({ env });
    live = loaded.config;
    const snapshot = selector.snapshot();
    return {
      router: { port, mode: live.mode, enabled: live.enabled, pid: process.pid },
      config: { path: loaded.path, exists: loaded.exists, warnings: loaded.warnings },
      classes: ROUTE_CLASSES,
      targets: live.targets,
      routes: live.routes,
      accounts: snapshot.accounts.map((account) => ({
        name: account.name,
        label: account.label ?? account.name,
        state: account.state ?? null,
        usage: account.usage ?? null,
      })),
      sittingOut: selector.sittingOut(Date.now()),
      summary: ledger.summary(),
    };
  }

  async function applyRoutes(body) {
    const loaded = await loadRouterConfig({ env });
    const next = {
      ...loaded.config,
      targets: body.targets ?? loaded.config.targets,
      routes: body.routes ?? loaded.config.routes,
    };
    const profiles = (await listRegistered(env)).filter((one) => one.provider === "anthropic").map((one) => one.name);
    const check = validateRouteTable(next, { profiles });
    if (!check.ok) return { ok: false, errors: check.errors };
    await writeRouterConfig(next, { env });
    // The live config object is replaced rather than mutated, so a request
    // already in flight keeps the table it started with.
    live = next;
    Object.assign(config, next);
    log.info("router", "route table changed from the local page", { classes: Object.keys(next.routes) });
    return { ok: true, config: next };
  }

  /** The live feed the page's log pane reads. */
  function events(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    res.write(`: connected\n\n`);
    const unsubscribe = ledger.subscribe((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });
    const beat = setInterval(() => res.write(`: ping\n\n`), 20_000);
    beat.unref?.();
    res.on("close", () => {
      clearInterval(beat);
      unsubscribe();
    });
  }

  const routes = {
    "GET /__zclaude/api/state": async (req, res) => send(res, 200, await state()),
    "GET /__zclaude/api/log": (req, res, url) => {
      const asked = Number(url.searchParams.get("n")) || 50;
      send(res, 200, { entries: ledger.recent(Math.min(500, asked)) });
    },
    "GET /__zclaude/api/models": async (req, res, url) =>
      send(res, 200, await listAllModels({ env, security, fetchImpl, force: url.searchParams.get("force") === "1" })),
    "GET /__zclaude/api/events": events,
  };

  /** A one-shot link for the browser. Only the CLI, holding the bearer, can ask. */
  function mintTicket() {
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, Date.now() + TICKET_MS);
    return { ticket, url: `http://${HOST}:${port}/__zclaude/ui?ticket=${ticket}`, expiresInMs: TICKET_MS };
  }

  return {
    mintTicket,

    /** Told the bound port and token once the listener exists. */
    attach(bound) {
      ({ port, token } = bound);
    },

    /**
     * Handle one control-plane request. Returns false when the path is not ours.
     */
    async handle(req, res, path, url) {
      if (!path.startsWith("/__zclaude/")) return false;
      const method = req.method ?? "GET";

      // The only unauthenticated door, and it consumes a ticket to open.
      if (method === "GET" && path === "/__zclaude/ui" && url.searchParams.has("ticket")) {
        redeem(res, url.searchParams.get("ticket"));
        return true;
      }

      const who = principal(req);
      if (!who) {
        send(res, 401, { error: "open this page with `zclaude router open`" });
        return true;
      }

      if (method === "POST" && path === "/__zclaude/ticket") {
        if (who.kind !== "cli") send(res, 403, { error: "only the command line can mint a link" });
        else send(res, 200, mintTicket());
        return true;
      }
      if (method === "GET" && Object.hasOwn(ASSETS, path)) {
        await serveAsset(res, path);
        return true;
      }
      if (method === "PUT" && path === "/__zclaude/api/routes") {
        const allowed = writeAllowed(req, who);
        if (!allowed.ok) {
          send(res, 403, { error: allowed.why });
          return true;
        }
        try {
          const applied = await applyRoutes(await readJson(req));
          send(res, applied.ok ? 200 : 422, applied);
        } catch (error) {
          send(res, 400, { error: error.message });
        }
        return true;
      }

      const handler = routes[`${method} ${path}`];
      if (!handler) {
        send(res, 404, { error: "no such endpoint" });
        return true;
      }
      await handler(req, res, url);
      return true;
    },
  };
}
