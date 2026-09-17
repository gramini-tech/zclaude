// The rows of the launch picker. Rendering is pure so the layout, the spinner
// and the "what do I press" line can be checked without a terminal; the pty
// suite covers the keys themselves.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { usageRecords } from "../src/cli.js";
import { DEFAULT_CREDENTIAL_SERVICE } from "../src/profiles/keychain-name.js";
import { renderDetail, renderFooter, renderRow, renderUsageDetail } from "../src/ui/profile-menu.js";

const profile = { id: "work", label: "work", description: "me@x.y · Acme", sharing: "shares config and history" };
const row = (overrides = {}) =>
  renderRow({ profile, active: false, usage: undefined, loading: false, width: 9, frame: 0, ...overrides });

describe("a row in the picker", () => {
  it("is a name and a number, because that is the choice", () => {
    assert.equal(
      row({ usage: { state: "ok", fiveHour: { pct: 12 }, weekly: null, scoped: [] } }),
      "  work       5h 12%",
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
    assert.match(row({ usage, loading: true }), /5h 12% · wk 61% · Fable 91%$/u);
    assert.match(row({ usage: { state: "dead" } }), /login expired$/u);
    assert.match(row({ usage: { state: "throttled" } }), /rate limited/u);
  });

  it("keeps every row inside the terminal, and cuts a long name rather than the numbers", () => {
    const usage = { state: "ok", fiveHour: { pct: 42 }, weekly: { pct: 55 }, scoped: [{ name: "Fable", pct: 100 }] };
    const long = { id: "zai", label: "Claude Code + Z.ai GLM Coding Plan" };
    const line = renderRow({ profile: long, active: false, usage, loading: false, width: 26, frame: 0, columns: 80 });
    assert.ok(line.length < 80, `row must fit the terminal, got ${line.length}`);
    assert.match(line, /^ {2}Claude Code \+ Z\.ai GLM Co…/u, "the name column holds its width");
    assert.match(line, /5h 42% · wk 55% · Fable 100%$/u, "the numbers survive");
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
