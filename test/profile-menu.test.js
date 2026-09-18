// The rows of the launch picker. Rendering is pure so the layout, the spinner
// and the "what do I press" line can be checked without a terminal; the pty
// suite covers the keys themselves.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { usageRecords } from "../src/cli.js";
import { DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { renderDetail, renderFooter, renderRow, renderUsageDetail } from "../src/ui/profile-menu.js";
import { signInHint } from "../src/usage/index.js";

const profile = { id: "work", label: "work", description: "me@x.y · Acme", sharing: "shares config and history" };
const row = (overrides = {}) =>
  renderRow({ profile, active: false, usage: undefined, loading: false, width: 9, frame: 0, ...overrides });

describe("a row in the picker", () => {
  it("is a name and a number, because that is the choice", () => {
    assert.equal(
      row({ usage: { state: "ok", fiveHour: { pct: 12 }, weekly: null, scoped: [] } }),
      "  work       5h  12%",
    );
    assert.equal(row(), "  work", "nothing known yet, nothing claimed");
  });

  it("spins only while the numbers are outstanding", () => {
    assert.match(row({ loading: true }), /⠋ usage$/u);
    assert.match(row({ loading: true, frame: 3 }), /⠸ usage$/u);
    assert.doesNotMatch(row({ loading: false }), /usage$/u, "a finished lookup leaves no spinner behind");
  });

  it("replaces the spinner with the numbers, and a failure with its reason", () => {
    const usage = { state: "ok", fiveHour: { pct: 12 }, weekly: { pct: 61 }, scoped: [{ name: "Fable", pct: 91 }] };
    // Percentages in a fixed three columns, so "5h 100%" and "5h   2%" put
    // every later column in the same place on every row.
    assert.match(row({ usage, loading: true }), /5h {2}12% · wk {2}61% · Fable {2}91%$/u);
    assert.match(row({ usage: { state: "dead" } }), /login expired$/u);
    assert.match(row({ usage: { state: "throttled" } }), /rate limited/u);
  });

  it("keeps every row inside the terminal, and cuts a long name rather than the numbers", () => {
    const usage = { state: "ok", fiveHour: { pct: 42 }, weekly: { pct: 55 }, scoped: [{ name: "Fable", pct: 100 }] };
    const long = { id: "zai", label: "Claude Code + Z.ai GLM Coding Plan" };
    const line = renderRow({ profile: long, active: false, usage, loading: false, width: 26, frame: 0, columns: 80 });
    assert.ok(line.length < 80, `row must fit the terminal, got ${line.length}`);
    assert.match(line, /^ {2}Claude Code \+ Z\.ai GLM Co…/u, "the name column holds its width");
    assert.match(line, /5h {2}42% · wk {2}55% · Fable 100%$/u, "the numbers survive");
  });

  it("spells the reset times out on a line of their own", () => {
    const now = Date.parse("2026-09-17T12:00:00Z");
    const usage = {
      state: "ok",
      fiveHour: { pct: 78, resetsAt: now + 2 * 3_600_000 },
      weekly: { pct: 4, resetsAt: now + 6 * 86_400_000 },
      scoped: [],
      credits: { enabled: false, reason: "out_of_credits" },
    };
    const line = renderUsageDetail(usage, now, 200);
    assert.match(line, /5 hours 78% resets in 2h \(/u);
    assert.match(line, /week 4% resets in 6d \(/u);
    assert.match(line, /credits spent/u);
    assert.ok(renderUsageDetail(usage, now, 40).length < 40, "a narrow terminal trims this line too");
  });

  it("has no reset line before the numbers arrive, or when they never will", () => {
    assert.equal(renderUsageDetail(undefined), "");
    assert.equal(renderUsageDetail({ state: "unauthorized" }), "");
  });

  it("tells you how to fix a broken login, on the line under the cursor", () => {
    // A row that says "login expired" and stops there is a dead end: the cure
    // is one command and there is nowhere else in this screen to learn it.
    const hint = signInHint({ state: "dead" }, "gramini");
    assert.equal(hint.command, "zclaude profile login gramini");
    assert.equal(hint.why, "login expired");
    assert.equal(hint.here, true, "the picker can do this one itself");
    const line = renderDetail({ label: "gramini", description: "vipinr@gramini.com" }, 200, { hint });
    assert.match(line, /login expired — press s, or run `zclaude profile login gramini`/u);
  });

  it("knows the built-in rows are not profiles it can sign in by name", () => {
    // `zclaude profile login zai` would fail: the built-in rows are not
    // registered profiles, and offering a command that cannot work is worse
    // than offering nothing.
    const zai = signInHint({ state: "unauthorized" }, { id: "zai", builtin: true });
    assert.equal(zai.command, "zclaude login");
    assert.equal(zai.here, true);

    // The default installation's login belongs to Claude Code, which asks for
    // it the moment you launch. There is nothing for zclaude to run.
    const claude = signInHint({ state: "dead" }, { id: "claude", builtin: true });
    assert.equal(claude.command, null);
    assert.equal(claude.here, false, "so no key is offered for it");
    const line = renderDetail({ label: "Claude Code" }, 200, { hint: claude });
    assert.match(line, /Claude Code asks for a login itself/u);
    assert.doesNotMatch(line, /press s/u);
  });

  it("has no sign-in hint for a login that is fine, or one a sign-in would not fix", () => {
    assert.equal(signInHint({ state: "ok" }, "max"), null);
    // Rate limited and offline are both temporary; signing in again fixes
    // neither, and offering it would send people off on a pointless errand.
    assert.equal(signInHint({ state: "throttled" }, "max"), null);
    assert.equal(signInHint({ state: "offline" }, "max"), null);
    assert.equal(signInHint(null, "max"), null);
  });

  it("offers the sign-in key only on a row that needs it", () => {
    const base = { loading: false, count: 2, total: 2, usageEnabled: true };
    assert.doesNotMatch(renderFooter(base), /sign in/u, "a key that does nothing teaches people to stop reading");
    assert.match(renderFooter({ ...base, canSignIn: true }), /s sign in/u);
  });

  it("marks a busy account before the numbers, because it changes the choice more", () => {
    const busy = { working: 2, idle: 0, unknown: 0, total: 2, newest: 0 };
    const line = row({ usage: { state: "ok", fiveHour: { pct: 12 }, weekly: null, scoped: [] }, busy });
    assert.equal(line, "  work       ● 2 running  5h  12%");
    assert.equal(row({ busy: { working: 0, idle: 1, unknown: 0, total: 1 } }), "  work       ○ idle");
    assert.equal(row({ busy: undefined }), "  work", "an account nobody is using gets no marker");
  });

  it("puts the account and the sharing under the highlighted row", () => {
    assert.equal(renderDetail(profile), "  me@x.y · Acme, shares config and history");
    assert.ok(renderDetail(profile, 24).length < 24, "a narrow terminal trims the detail line too");
    assert.equal(renderDetail({ id: "x", label: "x" }), "", "a profile with nothing to add gets no line");
  });

  it("marks the row under the cursor", () => {
    assert.match(row({ active: true }), /^\S*❯ work/u);
    assert.match(row(), /^ {2}work/u);
  });
});

describe("the line under the list", () => {
  it("counts the answers in while they are arriving", () => {
    assert.match(renderFooter({ loading: true, count: 2, total: 4, usageEnabled: true }), /usage 2\/4/u);
    assert.match(renderFooter({ loading: false, count: 4, total: 4, usageEnabled: true }), /r refresh$/u);
    assert.match(renderFooter({ loading: false, count: 1, total: 4, usageEnabled: true }), /some usage missing/u);
  });

  it("does not offer a refresh key when usage is off", () => {
    const footer = renderFooter({ loading: false, count: 0, total: 3, usageEnabled: false });
    assert.equal(footer, "↑↓ move · enter launch");
  });
});

describe("what the picker asks the usage layer for", () => {
  const env = { HOME: "/home/x", ZCLAUDE_HOME: "/home/x/.zclaude" };

  it("points the built-in entries at the right credentials", () => {
    const records = usageRecords(
      [
        { id: "claude" },
        { id: "zai" },
        { id: "work", provider: "anthropic", configDir: "/home/x/.zclaude/profiles/work/home" },
        { id: "glm", provider: "zai", configDir: "/home/x/.zclaude/profiles/glm/home" },
        { id: "legacy-env-file" },
      ],
      env,
    );
    const byName = Object.fromEntries(records.map((record) => [record.name, record]));

    // The global login's item has no directory hash, so it is named outright.
    assert.equal(byName.claude.credentialService, DEFAULT_CREDENTIAL_SERVICE);
    assert.equal(byName.claude.dir, join("/home/x", ".claude"));
    // The built-in Z.ai entry uses the key in the default slot, not one named "zai".
    assert.equal(byName.zai.zaiProfile, null);
    assert.equal(byName.work.dir, "/home/x/.zclaude/profiles/work/home");
    assert.equal(byName.work.credentialService, undefined, "a profile's service is derived from its directory");
    assert.equal(byName.glm.provider, "zai");
    assert.equal(byName["legacy-env-file"], undefined, "an env-file profile has no login of its own");
  });
});
