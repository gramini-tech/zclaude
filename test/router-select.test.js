// Which account answers, and which are sitting out.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { putRegistered } from "../src/profiles/registry.js";
import { createSelector, SNAPSHOT_MS } from "../src/router/select.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;

/** An inventory account, in the shape `rank` expects. */
const account = (name, { fiveHour = 10, weekly = 10, weight = 5, state = "ok" } = {}) => ({
  name,
  provider: "anthropic",
  registered: true,
  accountUuid: `uuid-${name}`,
  organizationUuid: "org-1",
  weight,
  tier: "default_claude_max_5x",
  refreshExpired: false,
  quarantined: false,
  state,
  sessions: 0,
  windows: { fiveHour: { pct: fiveHour, resetsAt: null }, weekly: { pct: weekly, resetsAt: null }, scoped: [] },
});

async function machine(names) {
  const home = await tempHome();
  const env = { HOME: home.dir, ZCLAUDE_HOME: join(home.dir, ".zclaude"), USER: "tester" };
  for (const name of names) {
    const dir = join(home.dir, ".zclaude", "profiles", name, "home");
    await mkdir(dir, { recursive: true });
    await putRegistered({ name, provider: "anthropic", dir }, env);
  }
  return { home, env };
}

/** An inventory that answers with whatever the test wants, and never reads a Keychain. */
const inventoryOf = (accounts) => async () => ({ accounts, active: null, slot: {}, sessions: new Map() });

describe("how often the account snapshot is taken", () => {
  it("refreshes on its own clock rather than per request", async () => {
    // inventory() reads the registry, every Keychain item, the renewal state
    // and the usage cache. Doing that per request would be several `security`
    // subprocesses before a single byte moved.
    const { home, env } = await machine([]);
    try {
      assert.equal(SNAPSHOT_MS, 30_000);
      let taken = 0;
      const selector = createSelector({
        env,
        inventoryImpl: async () => {
          taken += 1;
          return { accounts: [] };
        },
      });
      await selector.refresh({ now: NOW });
      await selector.refresh({ now: NOW + SNAPSHOT_MS - 1 });
      assert.equal(taken, 1, "inside the interval the last snapshot stands");
      await selector.refresh({ now: NOW + SNAPSHOT_MS + 1 });
      assert.equal(taken, 2);
      await selector.refresh({ now: NOW + SNAPSHOT_MS + 2, force: true });
      assert.equal(taken, 3, "and a forced refresh is what a quota 429 triggers");
    } finally {
      await home.cleanup();
    }
  });

  it("takes one snapshot for concurrent refreshes", async () => {
    const { home, env } = await machine([]);
    try {
      let taken = 0;
      const selector = createSelector({
        env,
        inventoryImpl: async () => {
          taken += 1;
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
          return { accounts: [] };
        },
      });
      await Promise.all(Array.from({ length: 5 }, () => selector.refresh({ now: NOW, force: true })));
      assert.equal(taken, 1);
    } finally {
      await home.cleanup();
    }
  });
});

describe("choosing where a request goes", () => {
  it("takes the first target in the chain that can serve it", async () => {
    const { home, env } = await machine(["work", "spare"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const chosen = await selector.choose({
        candidates: [
          { name: "work", kind: "anthropic", profile: "work" },
          { name: "spare", kind: "anthropic", profile: "spare" },
        ],
        klass: "opus",
        now: NOW,
      });
      assert.equal(chosen.target.profile, "work");
      assert.equal(chosen.rest.length, 1, "and the rest is the order to fall back through");
      assert.equal(chosen.rest[0].profile, "spare");
    } finally {
      await home.cleanup();
    }
  });

  it("skips a target naming a profile that no longer exists", async () => {
    const { home, env } = await machine(["spare"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const chosen = await selector.choose({
        candidates: [
          { name: "gone", kind: "anthropic", profile: "removed" },
          { name: "spare", kind: "anthropic", profile: "spare" },
        ],
        klass: "opus",
        now: NOW,
      });
      assert.equal(chosen.target.profile, "spare", "the rest of the chain still works");
    } finally {
      await home.cleanup();
    }
  });

  it("serves a Z.ai target without needing any account snapshot", async () => {
    const { home, env } = await machine([]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const chosen = await selector.choose({
        candidates: [{ name: "glm", kind: "zai", model: "latest" }],
        klass: "sonnet",
        now: NOW,
      });
      assert.equal(chosen.target.kind, "zai");
      assert.equal(chosen.target.record, null, "a key is not a profile");
    } finally {
      await home.cleanup();
    }
  });

  it("says the chain is exhausted rather than inventing somewhere to go", async () => {
    const { home, env } = await machine([]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const chosen = await selector.choose({
        candidates: [{ name: "gone", kind: "anthropic", profile: "removed" }],
        klass: "opus",
        now: NOW,
      });
      assert.equal(chosen.target, null);
      assert.match(chosen.reason, /nothing in this class's chain/u);
    } finally {
      await home.cleanup();
    }
  });

  it("skips an account the caller has already tried", async () => {
    const { home, env } = await machine(["work", "spare"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const chosen = await selector.choose({
        candidates: [
          { name: "work", kind: "anthropic", profile: "work" },
          { name: "spare", kind: "anthropic", profile: "spare" },
        ],
        klass: "opus",
        now: NOW,
        excluded: new Set(["work"]),
      });
      assert.equal(chosen.target.profile, "spare");
    } finally {
      await home.cleanup();
    }
  });
});

describe("accounts sitting out", () => {
  it("skips a penalised account until its window is back", async () => {
    const { home, env } = await machine(["work", "spare"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const candidates = [
        { name: "work", kind: "anthropic", profile: "work" },
        { name: "spare", kind: "anthropic", profile: "spare" },
      ];
      selector.penalise("work", { untilMs: 1_800_000, why: "quota exhausted", now: NOW });

      const during = await selector.choose({ candidates, klass: "opus", now: NOW + 1000 });
      assert.equal(during.target.profile, "spare");

      // A penalty is a time-boxed skip in memory, never a change to the
      // registry: an account that hit its window at noon is fine again at five.
      const after = await selector.choose({ candidates, klass: "opus", now: NOW + 1_800_001 });
      assert.equal(after.target.profile, "work");
    } finally {
      await home.cleanup();
    }
  });

  it("reports what is sitting out and why, and forgets it once it is over", async () => {
    const { home, env } = await machine(["work"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      selector.penalise("work", { untilMs: 60_000, why: "quota exhausted", now: NOW });
      const held = selector.sittingOut(NOW + 1000);
      assert.equal(held.length, 1);
      assert.equal(held[0].name, "work");
      assert.equal(held[0].why, "quota exhausted");
      assert.deepEqual(selector.sittingOut(NOW + 61_000), []);
    } finally {
      await home.cleanup();
    }
  });

  it("ignores a penalty with no name", async () => {
    const { home, env } = await machine([]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      selector.penalise(null, { untilMs: 1000, why: "nothing", now: NOW });
      assert.deepEqual(selector.sittingOut(NOW), []);
    } finally {
      await home.cleanup();
    }
  });
});

describe("keeping a conversation where its cache is", () => {
  it("moves the preferred account to the front without overriding the chain", async () => {
    const { home, env } = await machine(["work", "spare"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const candidates = [
        { name: "work", kind: "anthropic", profile: "work" },
        { name: "spare", kind: "anthropic", profile: "spare" },
      ];
      const chosen = await selector.choose({ candidates, klass: "opus", now: NOW, prefer: "spare" });
      assert.equal(chosen.target.profile, "spare");
      assert.match(chosen.reason, /already holds this conversation/u);
      assert.equal(chosen.rest[0].profile, "work", "the rest of the chain is intact behind it");
    } finally {
      await home.cleanup();
    }
  });

  it("never resurrects an account that is sitting out", async () => {
    const { home, env } = await machine(["work", "spare"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      selector.penalise("spare", { untilMs: 60_000, why: "quota exhausted", now: NOW });
      const chosen = await selector.choose({
        candidates: [
          { name: "work", kind: "anthropic", profile: "work" },
          { name: "spare", kind: "anthropic", profile: "spare" },
        ],
        klass: "opus",
        now: NOW,
        prefer: "spare",
      });
      assert.equal(chosen.target.profile, "work", "affinity is advisory, and a spent account is not a candidate");
    } finally {
      await home.cleanup();
    }
  });

  it("ignores a preference for an account that is not in the chain", async () => {
    const { home, env } = await machine(["work"]);
    try {
      const selector = createSelector({ env, intervalMs: 60_000 });
      const chosen = await selector.choose({
        candidates: [{ name: "work", kind: "anthropic", profile: "work" }],
        klass: "opus",
        now: NOW,
        prefer: "somewhere-else",
      });
      assert.equal(chosen.target.profile, "work");
      assert.match(chosen.reason, /first in the chain/u);
    } finally {
      await home.cleanup();
    }
  });
});

describe("ranking for an auto target", () => {
  it("orders by capacity, so the emptiest plan answers first", async () => {
    const { home, env } = await machine(["small", "big"]);
    try {
      // 3% of a 20x seat is far more room than 55% of a 5x one, which is what
      // capacity measures and a raw percentage would get backwards.
      const selector = createSelector({
        env,
        intervalMs: 60_000,
        inventoryImpl: inventoryOf([
          account("small", { fiveHour: 55, weight: 5 }),
          account("big", { fiveHour: 3, weight: 20 }),
        ]),
      });
      await selector.refresh({ now: NOW, force: true });
      const chosen = await selector.choose({
        candidates: [{ name: "any", kind: "anthropic", profile: "auto" }],
        klass: "opus",
        now: NOW,
      });
      assert.equal(chosen.target.profile, "big", "the larger plan with room, not the emptier percentage");
      assert.equal(chosen.rest[0].profile, "small", "and the other is still behind it");
    } finally {
      await home.cleanup();
    }
  });

  it("does not offer a Z.ai target that has already refused this request", async () => {
    // Found live: `expand` honoured `excluded` for Anthropic profiles but not
    // for Z.ai ones, so a chain whose first target was Z.ai kept returning that
    // same target. A class whose Z.ai key is missing exhausted against one
    // target instead of falling through to the account behind it.
    const { home, env } = await machine(["work"]);
    try {
      const selector = createSelector({ env, intervalMs: 0, inventoryImpl: async () => ({ accounts: [] }) });
      await selector.refresh({ now: NOW, force: true });
      const candidates = [
        { name: "glm", kind: "zai", model: "latest" },
        { name: "work", kind: "anthropic", profile: "work" },
      ];
      const first = await selector.choose({ candidates, klass: "sonnet", now: NOW });
      assert.equal(first.target.name, "glm");
      const next = await selector.choose({ candidates, klass: "sonnet", now: NOW, excluded: new Set(["glm"]) });
      assert.equal(next.target.name, "work", "the chain must move past a target that already refused");
      const nothing = await selector.choose({
        candidates,
        klass: "sonnet",
        now: NOW,
        excluded: new Set(["glm", "work"]),
      });
      assert.equal(nothing.target, null);
    } finally {
      await home.cleanup();
    }
  });

  it("keeps serving from the last snapshot when a refresh fails", async () => {
    // A snapshot that cannot be taken is not a reason to refuse traffic, and a
    // pinned target does not need one at all.
    const { home, env } = await machine(["work"]);
    try {
      const selector = createSelector({
        env,
        intervalMs: 0,
        inventoryImpl: async () => {
          throw new Error("the keychain would not answer");
        },
      });
      const taken = await selector.refresh({ now: NOW, force: true });
      assert.ok(Array.isArray(taken.accounts), "a failed inventory still answers with a shape");
      const chosen = await selector.choose({
        candidates: [{ name: "work", kind: "anthropic", profile: "work" }],
        klass: "opus",
        now: NOW,
      });
      assert.equal(chosen.target.profile, "work");
    } finally {
      await home.cleanup();
    }
  });
});
