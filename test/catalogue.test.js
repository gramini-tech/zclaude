// Asking each provider what it has, rather than remembering.
//
// Every fixture here uses invented model ids. That is deliberate: a test that
// asserts a real current model breaks the day the provider ships a new one,
// which is the failure this module exists to prevent and would be an absurd
// way to reintroduce it.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  cataloguePath,
  isFastTier,
  listAllModels,
  listModels,
  orderModels,
  resolveModel,
  versionKey,
  windowFor,
} from "../src/router/catalogue.js";
import { DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { mockFetch, tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;

const credential = (expiresAt = NOW + 3_600_000) =>
  JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-test", refreshToken: "sk-ant-ort-test", expiresAt } });

/** A Keychain holding the global slot's credential, and nothing else. */
function fakeKeychain(secret) {
  return async (args) => {
    if (args[0] !== "find-generic-password") return { code: 0, stdout: "", stderr: "" };
    const wanted = args[args.indexOf("-s") + 1];
    if (secret === null || wanted !== DEFAULT_CREDENTIAL_SERVICE) return { code: 44, stdout: "", stderr: "" };
    return { code: 0, stdout: args.includes("-w") ? `${secret}\n` : "attrs\n", stderr: "" };
  };
}

const ANTHROPIC_BODY = {
  data: [
    { id: "acme-small-2", display_name: "Acme Small 2", created_at: "2026-02-01T00:00:00Z", max_input_tokens: 200_000 },
    { id: "acme-big-3", display_name: "Acme Big 3", created_at: "2026-08-01T00:00:00Z", max_input_tokens: 1_000_000 },
    { id: "acme-big-2", display_name: "Acme Big 2", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 500_000 },
  ],
  has_more: false,
};

async function machine() {
  const home = await tempHome();
  return { home, env: { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" } };
}

describe("the model catalogue", () => {
  it("asks Anthropic with the OAuth bearer and returns newest first", async () => {
    const { home, env } = await machine();
    try {
      const fetchImpl = mockFetch(({ url }) =>
        url.startsWith("https://api.anthropic.com/v1/models") ? Response.json(ANTHROPIC_BODY) : null,
      );
      const result = await listModels({
        provider: "anthropic",
        env,
        security: fakeKeychain(credential()),
        fetchImpl,
        now: NOW,
      });

      assert.equal(result.source, "live");
      assert.deepEqual(
        result.models.map((model) => model.id),
        ["acme-big-3", "acme-small-2", "acme-big-2"],
        "ordered by release date, not by the order the endpoint happened to use",
      );
      assert.equal(result.models[0].contextWindow, 1_000_000, "the provider's own window, not a table");
      assert.equal(result.models[0].label, "Acme Big 3");
      assert.equal(fetchImpl.calls[0].authorization, "Bearer sk-ant-oat-test");
    } finally {
      await home.cleanup();
    }
  });

  it("never mints a token to list models, and says so when none is usable", async () => {
    const { home, env } = await machine();
    try {
      // An expired credential is skipped rather than refreshed. Listing models
      // is not worth spending a rotation; see swap/lineage.js.
      const fetchImpl = mockFetch(() => Response.json(ANTHROPIC_BODY));
      const result = await listModels({
        provider: "anthropic",
        env,
        security: fakeKeychain(credential(NOW - 1000)),
        fetchImpl,
        now: NOW,
      });

      assert.equal(result.source, "fallback");
      assert.match(result.detail, /unexpired token/u);
      assert.deepEqual(result.models, [], "Anthropic has no pinned table, and one must not be invented");
      assert.equal(fetchImpl.calls.length, 0, "nothing was asked, of any endpoint");
    } finally {
      await home.cleanup();
    }
  });

  it("falls back to the pinned table for Z.ai, saying that is what it did", async () => {
    const { home, env } = await machine();
    try {
      const result = await listModels({
        provider: "zai",
        env,
        fetchImpl: mockFetch(() => Response.json({ data: [] })),
        now: NOW,
      });
      assert.equal(result.source, "fallback");
      assert.match(result.detail, /no Z\.ai key/u);
      assert.ok(result.models.length > 0, "Z.ai does have a table to fall back to");
      assert.ok(
        result.models.every((model) => typeof model.contextWindow === "number"),
        "the fallback still knows its windows",
      );
    } finally {
      await home.cleanup();
    }
  });

  it("serves the cache inside the TTL and refetches past it", async () => {
    const { home, env } = await machine();
    try {
      const fetchImpl = mockFetch(() => Response.json(ANTHROPIC_BODY));
      // A month-long token: these clocks advance past the default hour, and an
      // expired one would be skipped for the right reason and fail this for the
      // wrong one.
      const longLived = fakeKeychain(credential(NOW + 30 * 86_400_000));
      const options = { provider: "anthropic", env, security: longLived, fetchImpl };

      await listModels({ ...options, now: NOW });
      assert.equal(fetchImpl.calls.length, 1);

      const cached = await listModels({ ...options, now: NOW + 60_000 });
      assert.equal(cached.source, "cached");
      assert.equal(fetchImpl.calls.length, 1, "inside the TTL nothing is asked again");

      await listModels({ ...options, now: NOW + 7 * 60 * 60 * 1000 });
      assert.equal(fetchImpl.calls.length, 2);

      await listModels({ ...options, now: NOW + 60_000, force: true });
      assert.equal(fetchImpl.calls.length, 3, "a forced refresh is how the page's button works");

      const onDisk = JSON.parse(await readFile(cataloguePath(env), "utf8"));
      assert.equal(onDisk.providers.anthropic.models.length, 3);
      assert.doesNotMatch(JSON.stringify(onDisk), /sk-ant/u, "no token reaches the cache file");
    } finally {
      await home.cleanup();
    }
  });

  it("prefers a stale live answer over the pinned table when the provider goes away", async () => {
    const { home, env } = await machine();
    try {
      const longLived = fakeKeychain(credential(NOW + 30 * 86_400_000));
      const good = mockFetch(() => Response.json(ANTHROPIC_BODY));
      await listModels({ provider: "anthropic", env, security: longLived, fetchImpl: good, now: NOW });

      const dead = mockFetch(() => Response.json({ error: "nope" }, { status: 503 }));
      const result = await listModels({
        provider: "anthropic",
        env,
        security: longLived,
        fetchImpl: dead,
        now: NOW + 7 * 60 * 60 * 1000,
      });
      assert.equal(result.source, "cached");
      assert.equal(result.models.length, 3, "ids that were real once beat a table that never knew them");
      assert.match(result.detail, /503/u, "and the reason it is stale is kept");
    } finally {
      await home.cleanup();
    }
  });

  it("reports every provider at once, for a page that lists them side by side", async () => {
    const { home, env } = await machine();
    try {
      const all = await listAllModels({
        env,
        security: fakeKeychain(null),
        fetchImpl: mockFetch(() => Response.json(ANTHROPIC_BODY)),
        now: NOW,
      });
      assert.deepEqual(
        Object.keys(all).toSorted((a, b) => a.localeCompare(b)),
        ["anthropic", "zai"],
      );
    } finally {
      await home.cleanup();
    }
  });

  it("refuses a provider it does not have", async () => {
    await assert.rejects(listModels({ provider: "openai" }), /Unknown provider/u);
  });
});

describe("resolving what the config asked for", () => {
  const catalogue = {
    provider: "acme",
    source: "live",
    models: [
      { id: "acme-big-3", label: "Acme Big 3", contextWindow: 1_000_000, fast: false },
      { id: "acme-flash-3", label: "Acme Flash 3", contextWindow: 200_000, fast: true },
      { id: "acme-big-2", label: "Acme Big 2", contextWindow: 500_000, fast: false },
    ],
  };

  it("resolves latest to the newest the provider listed", () => {
    assert.deepEqual(resolveModel("latest", catalogue), { id: "acme-big-3", matched: "latest", detail: null });
    assert.equal(resolveModel("", catalogue).id, "acme-big-3", "an empty selector means latest");
  });

  it("resolves latest:fast to the small tier, and to the newest when there is none", () => {
    assert.deepEqual(resolveModel("latest:fast", catalogue), {
      id: "acme-flash-3",
      matched: "latest-fast",
      detail: null,
    });
    const noFast = { ...catalogue, models: catalogue.models.filter((model) => !model.fast) };
    const fallen = resolveModel("latest:fast", noFast);
    assert.equal(fallen.id, "acme-big-3");
    assert.match(fallen.detail, /no model is marked as a fast tier/u);
  });

  it("honours an exact id the provider still lists", () => {
    assert.deepEqual(resolveModel("acme-big-2", catalogue), { id: "acme-big-2", matched: "exact", detail: null });
  });

  it("moves a retired id forward rather than failing on it", () => {
    // The failure this avoids: a route written a year ago 404s, and the reason
    // is a model id nobody remembers pinning.
    const gone = resolveModel("acme-big-1", catalogue);
    assert.equal(gone.id, "acme-big-3");
    assert.equal(gone.matched, "replaced");
    assert.match(gone.detail, /no longer listed/u);
  });

  it("uses the id as written when the provider list could not be read at all", () => {
    const empty = { provider: "acme", source: "fallback", models: [] };
    assert.deepEqual(resolveModel("acme-big-9", empty), {
      id: "acme-big-9",
      matched: "none",
      detail: "the provider list could not be read; using the id as written",
    });
    assert.equal(resolveModel("latest", empty).id, null);
  });

  // Z.ai publishes no release dates and answers alphabetically, which put its
  // oldest model first. Before this, `latest` resolved to glm-4.5.
  it("falls back to the version in the id when a provider gives no dates", () => {
    const undated = {
      provider: "acme",
      source: "live",
      models: ["acme-4.5", "acme-4.5-air", "acme-5", "acme-5-turbo", "acme-5.1", "acme-5.3", "acme-5.3-flash"]
        .map((id) => ({ id, label: id, contextWindow: null, fast: isFastTier(id) }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    };
    const ordered = orderModels(undated.models).map((model) => model.id);
    assert.equal(ordered[0], "acme-5.3", "the newest version, not the first alphabetically");
    assert.equal(ordered[1], "acme-5.3-flash", "and a plain id outranks its variant of the same version");
    assert.equal(ordered.at(-1), "acme-4.5-air");
    assert.equal(resolveModel("latest", { ...undated, models: orderModels(undated.models) }).id, "acme-5.3");
  });

  it("reads the version numbers out of an id", () => {
    assert.deepEqual(versionKey("glm-5.3-flash"), [5, 3]);
    assert.deepEqual(versionKey("claude-opus-4-5-20251101"), [4, 5, 20_251_101]);
    assert.deepEqual(versionKey("no-digits"), []);
  });

  it("knows a small tier from its name, because that is how vendors name them", () => {
    for (const id of ["x-flash", "claude-haiku-9", "gpt-mini", "m-lite", "n-turbo", "q-small"])
      assert.equal(isFastTier(id), true, id);
    for (const id of ["acme-big-3", "claude-opus-9"]) assert.equal(isFastTier(id), false, id);
  });

  it("prefers the provider's context window and falls back to the table", () => {
    assert.equal(windowFor("acme-big-3", catalogue), 1_000_000);
    // Unknown to the catalogue, so config.js answers, which is the floor.
    assert.equal(typeof windowFor("something-else", catalogue), "number");
  });
});

describe("the catalogue on a machine with nothing set up", () => {
  it("answers rather than throwing when there is no config at all", async () => {
    const { home, env } = await machine();
    try {
      await writeFile(cataloguePath(env), "{broken").catch(() => {});
      const result = await listModels({ provider: "zai", env, fetchImpl: mockFetch(() => null), now: NOW });
      assert.equal(result.source, "fallback");
      assert.ok(Array.isArray(result.models));
    } finally {
      await home.cleanup();
    }
  });
});
