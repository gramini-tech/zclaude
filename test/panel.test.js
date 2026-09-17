// The webview the status bar item opens.
//
// The document is built by a pure function, so this asserts what is in it
// without a browser: the gauges, the columns, the buttons, and that nothing an
// account is named reaches the DOM unescaped.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { escapeHtml, panelHtml, severity } = require("../extension/src/panel.js");

const NOW = Date.parse("2026-09-17T12:00:00Z");
const window = (pct, hours = 3) => ({ pct, resetsAt: NOW + hours * 3_600_000 });
const profiles = [
  { name: "gramini", provider: "anthropic", account: "a@gramini.com · Acme" },
  { name: "max", provider: "anthropic", account: "a@x.com · personal" },
  { name: "chinese", provider: "zai", account: null },
];
const usage = {
  gramini: { state: "ok", fiveHour: window(50), weekly: window(31, 120), scoped: [{ name: "Fable", ...window(92) }] },
  max: { state: "ok", fiveHour: window(5), weekly: window(3, 120), scoped: [{ name: "Fable", ...window(4) }] },
  chinese: { state: "ok", fiveHour: window(16), weekly: window(71, 120), scoped: [] },
};

const html = (extra = {}) =>
  panelHtml({
    status: { account: { email: "a@x.com", organization: "personal" }, owner: "max" },
    profiles,
    usage,
    busy: { max: { total: 3, working: 0 } },
    nonce: "n0nce",
    cspSource: "vscode-webview://x",
    now: NOW,
    ...extra,
  });

describe("the account panel", () => {
  it("draws a gauge whose width is the percentage", () => {
    const text = html();
    assert.match(text, /style="width:50%"/u);
    assert.match(text, /style="width:92%"/u);
    assert.match(text, /<span class="pct">50%<\/span>/u);
  });

  it("colours a window by how close it is to stopping you", () => {
    assert.equal(severity(5), "calm");
    assert.equal(severity(60), "warn");
    assert.equal(severity(92), "critical");
    assert.match(html(), /class="usage critical"/u);
  });

  it("gives every window a column, and the ones a profile lacks a dash", () => {
    const text = html();
    for (const label of ["5 hours", "week", "Fable", "sessions"]) {
      assert.match(text, new RegExp(`<th scope="col">${label}</th>`, "u"));
    }
    assert.match(text, /<td class="usage empty">–<\/td>/u, "the Z.ai row has no Fable window");
  });

  it("offers Switch on the accounts that can take it, and not on the others", () => {
    const text = html();
    assert.match(text, /data-switch="gramini"/u);
    assert.doesNotMatch(text, /data-switch="max"/u, "the account in use is already there");
    assert.doesNotMatch(text, /data-switch="chinese"/u, "a Z.ai login cannot be switched to");
    assert.match(text, /terminal only/u);
  });

  it("carries the four actions the footer offers", () => {
    const text = html();
    for (const action of ["refresh", "add", "remove", "restore"]) {
      assert.match(text, new RegExp(`data-action="${action}"`, "u"));
    }
  });

  it("says when a row has no numbers instead of drawing an empty gauge", () => {
    const text = html({ usage: { ...usage, gramini: { state: "unauthorized" } } });
    assert.match(text, /sign in to see usage/u);
  });

  it("shows the reset beside the window it belongs to", () => {
    const text = html();
    assert.match(text, /<span class="resets" title="[^"]+">3h<\/span>/u);
    assert.match(text, /5d<\/span>/u);
  });

  it("counts sessions, and says whether any are working", () => {
    assert.match(html(), /<td class="sessions ">3 open<\/td>/u);
    assert.match(html({ busy: { max: { total: 2, working: 1 } } }), /<td class="sessions busy">2 active<\/td>/u);
  });

  it("locks the document down: no remote anything, and scripts only by nonce", () => {
    const text = html();
    assert.match(text, /default-src 'none'/u);
    assert.match(text, /script-src 'nonce-n0nce'/u);
    assert.doesNotMatch(text, /unsafe-inline/u);
  });

  // An account name comes from an email address and an organisation, which are
  // somebody else's text arriving over the network.
  it("escapes what it is given rather than trusting it", () => {
    assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    const text = html({
      profiles: [{ name: "<script>evil</script>", provider: "anthropic", account: "a@b.c" }],
      usage: {},
    });
    assert.doesNotMatch(text, /<script>evil/u);
    assert.match(text, /&lt;script&gt;evil/u);
  });

  it("says so plainly when there is nothing to show", () => {
    const text = html({ profiles: [], usage: {} });
    assert.match(text, /No profiles yet/u);
    assert.doesNotMatch(text, /<table>/u);
  });

  it("says it is still checking while the numbers are on their way", () => {
    assert.match(html({ usage: {}, loading: true }), /checking usage/u);
  });
});
