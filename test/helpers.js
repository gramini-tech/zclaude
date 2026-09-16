import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function jsonResponse(body, { status = 200 } = {}) {
  return Response.json(body, { status, headers: { "Content-Type": "application/json" } });
}

export function envelope(data) {
  return jsonResponse({ code: 0, msg: "ok", data });
}

export function bizEnvelope(data) {
  return jsonResponse({ code: 200, msg: "Operation successful", success: true, data });
}

/** Build a fetch mock from a routing function; records every call. */
export function mockFetch(route) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers ?? {});
    calls.push({ url: String(url), method, body, authorization: headers.get("authorization") });
    const result = await route({ url: String(url), method, body, headers });
    if (result === undefined || result === null) throw new Error(`unexpected fetch: ${method} ${url}`);
    return result;
  };
  impl.calls = calls;
  return impl;
}

export async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), "zclaude-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function isolatedEnv(home, extra = {}) {
  return { HOME: home, ZCLAUDE_HOME: join(home, ".zclaude"), ZCLAUDE_NO_KEYCHAIN: "1", PATH: "", ...extra };
}
