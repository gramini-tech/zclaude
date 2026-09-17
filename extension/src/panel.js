// The panel that opens when you click the status bar item.
//
// A QuickPick was the obvious thing and the wrong thing: it drops from the top
// of the window, renders in the editor's proportional UI font, gives each row
// one clipped line and offers no styling at all, so a gauge drawn in it says
// nothing about its value. A webview is the only surface an extension has where
// a bar can be a bar and a column can be a column.
//
// This file builds the document and nothing else: no VS Code, no processes, so
// the layout is testable. The extension hands it data and handles the messages
// the buttons post back.

"use strict";

const { accountOf, countdown, creditsText, localTime } = require("./items.js");

/** Where a window stops being comfortable, and where it stops being fine. */
const WARN = 60;
const CRITICAL = 85;

function severity(pct) {
  if (pct >= CRITICAL) return "critical";
  if (pct >= WARN) return "warn";
  return "calm";
}

/** Text that came from an account or an endpoint never reaches the DOM raw. */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STATES = {
  unauthorized: "sign in to see usage",
  dead: "login expired",
  throttled: "usage rate limited",
  offline: "usage unavailable",
  unknown: "no usage",
};

/** Every window a column is needed for, in the order they first appear. */
function windowNames(profiles, usage) {
  const models = [];
  for (const profile of profiles) {
    const scopes = usage[profile.name]?.scoped ?? [];
    for (const scope of scopes) {
      if (!models.includes(scope.name)) models.push(scope.name);
    }
  }
  return [
    { key: "fiveHour", label: "5 hours" },
    { key: "weekly", label: "week" },
    ...models.map((name) => ({ key: `model:${name}`, label: name })),
  ];
}

function windowOf(own, key) {
  if (key === "fiveHour") return own?.fiveHour ?? null;
  if (key === "weekly") return own?.weekly ?? null;
  const name = key.slice("model:".length);
  return (own?.scoped ?? []).find((scope) => scope.name === name) ?? null;
}

/** One gauge: a filled track, the number, and when it comes back. */
function cell(window, now) {
  if (!window) return '<td class="usage empty">–</td>';
  const pct = Math.round(window.pct);
  const left = countdown(window.resetsAt, now);
  const clock = left
    ? `<span class="resets" title="${escapeHtml(localTime(window.resetsAt, now))}">${left}</span>`
    : "";
  return [
    `<td class="usage ${severity(pct)}">`,
    '<div class="row">',
    `<div class="track"><div class="fill" style="width:${Math.min(100, Math.max(0, pct))}%"></div></div>`,
    `<span class="pct">${pct}%</span>`,
    "</div>",
    clock,
    "</td>",
  ].join("");
}

function sessionCell(counts) {
  if (!counts?.total) return '<td class="sessions empty">–</td>';
  const what = counts.working > 0 ? "active" : "open";
  return `<td class="sessions ${counts.working > 0 ? "busy" : ""}">${counts.total} ${what}</td>`;
}

function profileRow({ profile, usage, busy, active, windows, now }) {
  const own = usage[profile.name];
  const stopped = own && Object.hasOwn(STATES, own.state) ? STATES[own.state] : "";
  const current = profile.name === active;
  const cells = stopped
    ? `<td class="stopped" colspan="${windows.length}">${escapeHtml(stopped)}</td>`
    : windows.map((window) => cell(windowOf(own, window.key), now)).join("");
  const action =
    profile.provider === "zai"
      ? '<span class="note" title="A Z.ai login only reaches Claude Code through the environment">terminal only</span>'
      : current
        ? '<span class="note">in use</span>'
        : `<button class="switch" data-switch="${escapeHtml(profile.name)}">Switch</button>`;
  return [
    `<tr class="${current ? "current" : ""}">`,
    `<th scope="row"><span class="name">${escapeHtml(profile.name)}</span>`,
    `<span class="account">${escapeHtml(accountOf(profile))}</span></th>`,
    cells,
    sessionCell(busy[profile.name]),
    `<td class="act">${action}</td>`,
    "</tr>",
  ].join("");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 18px 20px 24px;
  }
  h1 { font-size: 1.1em; font-weight: 600; margin: 0 0 2px; }
  .who { color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
  .who strong { color: var(--vscode-foreground); font-weight: 600; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 10px 14px 10px 0; vertical-align: middle; }
  thead th {
    font-weight: 500;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
    padding-bottom: 6px;
  }
  tbody tr { border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.18)); }
  tbody tr.current { background: var(--vscode-list-inactiveSelectionBackground); }
  th[scope="row"] { min-width: 180px; }
  .name { display: block; font-weight: 600; }
  .account { display: block; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .usage { min-width: 132px; }
  .usage .row { display: flex; align-items: center; gap: 8px; }
  .track {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--vscode-progressBar-background, rgba(128,128,128,0.25));
    opacity: 0.35;
    overflow: hidden;
  }
  .fill { height: 100%; border-radius: 3px; background: currentColor; }
  .pct { font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; }
  .calm { color: var(--vscode-charts-green, #3fb950); }
  .warn { color: var(--vscode-charts-yellow, #d29922); }
  .critical { color: var(--vscode-charts-red, #f85149); }
  .resets {
    display: block;
    margin-top: 3px;
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
  }
  .empty, .note { color: var(--vscode-descriptionForeground); }
  .stopped { color: var(--vscode-descriptionForeground); font-style: italic; }
  .sessions { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .sessions.busy { color: var(--vscode-charts-blue, #4da0ff); }
  .act { text-align: right; width: 1%; white-space: nowrap; }
  button {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    padding: 4px 12px;
    border-radius: 3px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.quiet {
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
  }
  button.quiet:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.15)); }
  footer { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 20px; }
  footer .spacer { flex: 1; }
  .credit { color: var(--vscode-descriptionForeground); margin-top: 14px; }
  .empty-state { color: var(--vscode-descriptionForeground); margin: 24px 0; }
`;

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.switch) vscode.postMessage({ type: "switch", name: button.dataset.switch });
    else if (button.dataset.action) vscode.postMessage({ type: button.dataset.action });
  });
`;

/**
 * The whole document.
 * @param {{status: object | null, profiles: Array<object>, usage: Record<string, object>, busy: Record<string, object>, nonce: string, cspSource: string, now?: number, loading?: boolean}} args
 */
function panelHtml({ status, profiles = [], usage = {}, busy = {}, nonce, cspSource, now = Date.now(), loading }) {
  const windows = windowNames(profiles, usage);
  const active = status?.owner ?? null;
  const signedIn = status?.account?.email
    ? `Signed in as <strong>${escapeHtml(status.account.email)}</strong>${
        status.account.organization ? ` · ${escapeHtml(status.account.organization)}` : ""
      }`
    : status?.unreadable
      ? `The credential could not be read: ${escapeHtml(status.unreadable)}`
      : "Nobody is signed in.";
  const head = [
    '<th scope="col">profile</th>',
    ...windows.map((window) => `<th scope="col">${escapeHtml(window.label)}</th>`),
    '<th scope="col">sessions</th>',
    '<th scope="col"></th>',
  ].join("");
  const body = profiles.map((profile) => profileRow({ profile, usage, busy, active, windows, now })).join("");
  const credit = profiles.map((profile) => creditsText(usage[profile.name]?.credits)).find(Boolean);
  const table =
    profiles.length > 0
      ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      : '<p class="empty-state">No profiles yet. Add one to get started.</p>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<title>Claude Code account</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<h1>Claude Code account</h1>
<p class="who">${signedIn}${loading ? ' · <span class="note">checking usage…</span>' : ""}</p>
${table}
${credit ? `<p class="credit">${escapeHtml(credit)}</p>` : ""}
<footer>
  <button class="quiet" data-action="refresh">Refresh usage</button>
  <button class="quiet" data-action="add">Add a profile…</button>
  <button class="quiet" data-action="remove">Remove a profile…</button>
  <span class="spacer"></span>
  <button class="quiet" data-action="restore">Restore the previous login</button>
</footer>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { escapeHtml, panelHtml, severity };
