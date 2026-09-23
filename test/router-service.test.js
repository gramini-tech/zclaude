// The router as a process: finding it, adopting it, stopping it, and the
// control plane's two auth schemes.
//
// Everything here runs against a real loopback listener on an ephemeral port,
// because the questions being asked are about sockets, cookies and pids, and a
// fake would answer a different question.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { parseCookies } from "../src/router/control.js";
import {
  ensureRouter,
  throttledObserver,
  probe,
  readRouterState,
  routerDir,
  routerStatePath,
  routerUrl,
  serve,
  stopRouter,
} from "../src/router/service.js";
import { writeRouterConfig } from "../src/router/config.js";

const home = await mkdtemp(join(tmpdir(), "zclaude-router-service-"));
const env = { ...process.env, ZCLAUDE_HOME: home, HOME: home, ZCLAUDE_NO_KEYCHAIN: "1" };
await mkdir(routerDir(env), { recursive: true });

after(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A router on an ephemeral port with no shared state file. */
async function ephemeral(overrides = {}) {
  return serve({ env, port: 0, shared: false, signals: false, ...overrides });
}

describe("readRouterState", () => {
  it("is null when nothing was written", async () => {
    assert.equal(await readRouterState(env), null);
  });

  it("clears a record whose process is gone", async () => {
    const path = routerStatePath(env);
    // A pid that cannot exist: the kernel's maximum is far below this.
    await writeFile(
      path,
      JSON.stringify({ version: 1, pid: 2_147_483_647, port: 1234, token: "x", host: hostname() }),
      "utf8",
    );
    assert.equal(await readRouterState(env), null);
    await assert.rejects(readFile(path, "utf8"), /ENOENT/u);
  });

  it("ignores a record another machine wrote", async () => {
    await writeFile(
      routerStatePath(env),
      JSON.stringify({ version: 1, pid: process.pid, port: 1234, token: "x", host: "some-other-box" }),
      "utf8",
    );
    assert.equal(await readRouterState(env), null);
  });
});

describe("a shared router", () => {
  it("records where it is, answers a probe, and clears the record when it stops", async () => {
    const running = await serve({ env, port: 0, signals: false });
    try {
      const state = await readRouterState(env);
      assert.equal(state.port, running.port);
      assert.equal(state.pid, process.pid);
      const health = await probe(routerUrl(state));
      assert.equal(health.ok, true);
      assert.equal(health.port, running.port);
    } finally {
      await running.close();
    }
    assert.equal(await readRouterState(env), null);
  });

  it("reports nothing to stop when nothing is running", async () => {
    const stopped = await stopRouter({ env });
    assert.equal(stopped.stopped, false);
    assert.match(stopped.reason, /nothing is running/u);
  });

  it("refuses a port that something else already holds, rather than moving", async () => {
    const first = await serve({ env, port: 0, signals: false });
    try {
      await assert.rejects(
        serve({ env, port: first.port, shared: false, signals: false }),
        /already held by a zclaude router/u,
      );
    } finally {
      await first.close();
    }
  });
});

describe("ensureRouter", () => {
  it("adopts the shared router, and closing the adoption leaves it running", async () => {
    const shared = await serve({ env, port: 0, signals: false });
    try {
      const taken = await ensureRouter({ env });
      assert.equal(taken.adopted, true);
      assert.equal(taken.url, shared.url);
      assert.equal(taken.token, shared.token);
      // A session that did not start it must not be able to stop it.
      await taken.close();
      assert.ok(await probe(shared.url), "the adopted router is still answering");
    } finally {
      await shared.close();
    }
  });

  it("starts its own when nothing is running, on a port of its own", async () => {
    const own = await ensureRouter({ env });
    try {
      assert.equal(own.adopted, false);
      assert.ok(await probe(own.url));
      // Its own means its own: no state file was written for anybody to find.
      assert.equal(await readRouterState(env), null);
    } finally {
      await own.close();
    }
    assert.equal(await probe(own.url), null, "a router a launch started closes with it");
  });

  it("starts its own when the recorded router has gone without clearing up", async () => {
    // A `kill -9` leaves the file behind naming a port nothing is listening on.
    await writeFile(
      routerStatePath(env),
      JSON.stringify({ version: 1, pid: process.pid, port: 1, token: "stale", host: hostname() }),
      "utf8",
    );
    const own = await ensureRouter({ env });
    try {
      assert.equal(own.adopted, false);
      assert.notEqual(own.token, "stale");
      assert.ok(await probe(own.url));
    } finally {
      await own.close();
      await rm(routerStatePath(env), { force: true });
    }
  });
});

describe("the control plane", () => {
  let router;

  before(async () => {
    router = await ephemeral();
  });
  after(async () => {
    await router?.close();
  });

  const get = (path, headers = {}) => fetch(`${router.url}${path}`, { headers, redirect: "manual" });

  it("answers healthz without any credential, because that is what a probe is", async () => {
    const response = await get("/__zclaude/healthz");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });

  it("refuses a control request with no bearer and no cookie", async () => {
    const response = await get("/__zclaude/api/state");
    assert.equal(response.status, 401);
  });

  it("answers the CLI's bearer", async () => {
    const response = await get("/__zclaude/api/state", { authorization: `Bearer ${router.token}` });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.router.port, router.port);
    assert.ok(Array.isArray(body.classes));
  });

  it("refuses a Host header that is not us, which is the rebinding defence", async () => {
    // `fetch` drops a forbidden Host header, so this goes over a raw socket.
    const { request } = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const client = request(
        { host: "127.0.0.1", port: router.port, path: "/__zclaude/api/state", headers: { host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      client.on("error", reject);
      client.end();
    });
    assert.equal(status, 403);
  });

  it("only mints a ticket for the bearer, and the ticket works exactly once", async () => {
    const refused = await fetch(`${router.url}/__zclaude/ticket`, { method: "POST" });
    assert.equal(refused.status, 401);

    const minted = await fetch(`${router.url}/__zclaude/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${router.token}` },
    });
    const { ticket, url } = await minted.json();
    assert.match(url, /\/__zclaude\/ui\?ticket=/u);

    const first = await get(`/__zclaude/ui?ticket=${ticket}`);
    assert.equal(first.status, 303);
    const cookies = first.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.some((one) => one.includes("HttpOnly")));
    // The CSRF half must be readable, or the page cannot echo it in a header.
    assert.ok(cookies.some((one) => one.startsWith("zclaude_router_csrf=") && !one.includes("HttpOnly")));

    const second = await get(`/__zclaude/ui?ticket=${ticket}`);
    assert.equal(second.status, 403);
  });

  it("serves the page to a redeemed cookie and refuses a write without the CSRF header", async () => {
    const minted = await fetch(`${router.url}/__zclaude/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${router.token}` },
    });
    const { ticket } = await minted.json();
    const exchange = await get(`/__zclaude/ui?ticket=${ticket}`);
    const jar = exchange.headers
      .getSetCookie()
      .map((one) => one.split(";", 1)[0])
      .join("; ");
    const csrf = parseCookies(jar).get("zclaude_router_csrf");
    assert.ok(csrf);

    const page = await get("/__zclaude/ui", { cookie: jar });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/u);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/u);

    const body = JSON.stringify({ routes: { unknown: { to: ["any"] } } });
    const noHeader = await fetch(`${router.url}/__zclaude/api/routes`, {
      method: "PUT",
      headers: { cookie: jar, "content-type": "application/json" },
      body,
    });
    assert.equal(noHeader.status, 403);

    const wrongOrigin = await fetch(`${router.url}/__zclaude/api/routes`, {
      method: "PUT",
      headers: { cookie: jar, "content-type": "application/json", "x-zclaude-csrf": csrf, origin: "https://evil.test" },
      body,
    });
    assert.equal(wrongOrigin.status, 403);

    const accepted = await fetch(`${router.url}/__zclaude/api/routes`, {
      method: "PUT",
      headers: { cookie: jar, "content-type": "application/json", "x-zclaude-csrf": csrf, origin: router.url },
      body,
    });
    assert.equal(accepted.status, 200);
  });

  const readTable = async () => JSON.parse(await readFile(join(home, "router.json"), "utf8"));

  it("applies nothing when a proposed table names a target that does not exist", async () => {
    const untouched = await readTable();
    const response = await fetch(`${router.url}/__zclaude/api/routes`, {
      method: "PUT",
      headers: { authorization: `Bearer ${router.token}`, "content-type": "application/json" },
      body: JSON.stringify({ routes: { sonnet: { to: ["nowhere"] } } }),
    });
    assert.equal(response.status, 422);
    const answer = await response.json();
    assert.equal(answer.ok, false);
    assert.match(answer.errors[0].message, /there is no target named "nowhere"/u);
    assert.deepEqual(await readTable(), untouched);
  });

  it("serves the asset map and nothing outside it", async () => {
    const good = await get("/__zclaude/ui/app.css", { authorization: `Bearer ${router.token}` });
    assert.equal(good.status, 200);
    // The map is the allowlist. A name that is a real file in that directory
    // but is not in the map is still a 404, which is what makes a path join
    // impossible to reintroduce by accident.
    for (const path of ["/__zclaude/ui/app.html", "/__zclaude/ui/nope.js", "/__zclaude/api/nothing"]) {
      const response = await get(path, { authorization: `Bearer ${router.token}` });
      assert.equal(response.status, 404, path);
    }
  });

  it("names the route table it read, so the page can say which file to edit", async () => {
    await writeRouterConfig(
      {
        version: 1,
        enabled: false,
        mode: "session",
        port: 34_317,
        targets: { any: { kind: "anthropic", profile: "auto" } },
        routes: { unknown: { to: ["any"] } },
      },
      { env },
    );
    const response = await get("/__zclaude/api/state", { authorization: `Bearer ${router.token}` });
    const body = await response.json();
    assert.equal(body.config.path, join(home, "router.json"));
  });
});

describe("throttledObserver", () => {
  // These headers arrive on every answer, and an agentic session produces
  // several a second. Writing each one is a lock acquire and a rewrite of a
  // file the menu, the watcher and the editor extension all share.
  const reading = (fiveHour, weekly = 0) => ({ fiveHour: { pct: fiveHour }, weekly: { pct: weekly } });

  it("writes the first reading it sees", async () => {
    const seen = [];
    const observe = throttledObserver(async (profile, one) => {
      seen.push([profile, one.fiveHour.pct]);
    });
    await observe("work", reading(10), { now: 0 });
    assert.deepEqual(seen, [["work", 10]]);
  });

  it("skips a reading that has barely moved and is barely older", async () => {
    const seen = [];
    const observe = throttledObserver(async (profile, one) => {
      seen.push(one.fiveHour.pct);
    });
    await observe("work", reading(10), { now: 0 });
    await observe("work", reading(10.4), { now: 1000 });
    await observe("work", reading(10.9), { now: 5000 });
    assert.deepEqual(seen, [10], "three responses, one write");
  });

  it("writes when a percentage actually moves", async () => {
    const seen = [];
    const observe = throttledObserver(async (profile, one) => {
      seen.push(one.fiveHour.pct);
    });
    await observe("work", reading(10), { now: 0 });
    await observe("work", reading(12), { now: 500 });
    assert.deepEqual(seen, [10, 12]);
  });

  it("writes eventually even when nothing moves, so a reading is never stale for long", async () => {
    const seen = [];
    const observe = throttledObserver(async (profile, one) => {
      seen.push(one.fiveHour.pct);
    });
    await observe("work", reading(10), { now: 0 });
    await observe("work", reading(10), { now: 40_000 });
    assert.equal(seen.length, 2);
  });

  it("keeps one account's traffic from silencing another's", async () => {
    const seen = [];
    const observe = throttledObserver(async (profile) => {
      seen.push(profile);
    });
    await observe("work", reading(10), { now: 0 });
    await observe("spare", reading(10), { now: 10 });
    assert.deepEqual(seen, ["work", "spare"]);
  });
});

describe("parseCookies", () => {
  it("reads a pair, ignores junk, and decodes a value", () => {
    const found = parseCookies("a=1; b=%2Fx; broken; =empty");
    assert.equal(found.get("a"), "1");
    assert.equal(found.get("b"), "/x");
    assert.equal(found.size, 2);
  });

  it("is empty for nothing at all", () => {
    assert.equal(parseCookies(undefined).size, 0);
  });
});
