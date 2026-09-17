// The usage table, for a terminal that can hold one.
//
// A terminal is monospace, which is the one place where padding means what it
// says: a column of gauges and a column of percentages can be compared down the
// page. The VS Code extension draws the same table in a webview, because its
// list could not.
//
// It degrades by dropping columns rather than wrapping. A wrapped row in a
// live-updating menu is worse than a missing column: the cursor moves by lines,
// so a row that takes two lines puts the highlight in the wrong place.

import { countdown } from "./when.js";

const CELLS = 10;
const FULL = "█";
const EMPTY = "░";
/** A gauge plus " 100%". */
const COLUMN = CELLS + 5;
/** Past this a name is cut: the numbers are what the table is for. */
const MAX_NAME = 20;

const STATE_TEXT = Object.freeze({
  unauthorized: "sign in to see usage",
  dead: "login expired",
  throttled: "rate limited",
  offline: "unavailable",
  unknown: "no usage",
  stale: "",
});

/**
 * A window as a bar.
 * @param {number} pct
 * @param {number} [cells]
 */
function gauge(pct, cells = CELLS) {
  const clamped = Math.min(100, Math.max(0, pct));
  // Anything spent at all shows a cell: an empty bar beside "5%" reads as a
  // rounding bug rather than as a nearly-untouched window.
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * cells));
  return `${FULL.repeat(filled)}${EMPTY.repeat(cells - filled)}`;
}

/** Every window a column is needed for, in the order they first appear. */
function windowNames(rows) {
  const models = [];
  for (const row of rows) {
    const scopes = row.usage?.scoped ?? [];
    for (const scope of scopes) {
      if (!models.includes(scope.name)) models.push(scope.name);
    }
  }
  return [
    { key: "fiveHour", label: "5 hours" },
    { key: "weekly", label: "week" },
    ...models.map((name) => ({ key: name, label: name })),
  ];
}

function windowOf(usage, key) {
  if (key === "fiveHour") return usage?.fiveHour ?? null;
  if (key === "weekly") return usage?.weekly ?? null;
  return (usage?.scoped ?? []).find((scope) => scope.name === key) ?? null;
}

function cell(window) {
  if (!window) return "–".padStart(Math.round(COLUMN / 2)).padEnd(COLUMN);
  return `${gauge(window.pct)}${String(Math.round(window.pct)).padStart(4)}%`;
}

/**
 * Lay the table out, dropping the columns a narrow terminal has no room for.
 *
 * @param {Array<{name: string, usage?: object, busy?: object, loading?: boolean}>} rows
 * @param {{columns?: number, now?: number, nameWidth?: number, maxName?: number}} [options]
 * @returns {{header: string, rows: string[], width: number}}
 */
export function layout(rows, { columns = 80, now = Date.now(), nameWidth, maxName = MAX_NAME } = {}) {
  const names = windowNames(rows);
  // A long name is cut rather than allowed to push every column right. The
  // built-in "Claude Code + Z.ai GLM Coding Plan" is 34 characters on its own,
  // which would leave a narrow terminal no room for the numbers it came for.
  const width = nameWidth ?? Math.min(maxName, Math.max(7, ...rows.map((row) => row.name.length)));
  // What each optional column costs, in the order they are given up: the
  // per-model windows go first, then sessions, then the reset clock. The two
  // windows every plan has are never dropped.
  const fixed = width + 2 + (COLUMN + 2) * 2;
  // Two for the cursor the caller puts in front of every row, one so a full
  // line never touches the right edge.
  const room = columns - 3;
  const keep = { models: names.length - 2, sessions: true, resets: true };
  let needed = fixed + (COLUMN + 2) * keep.models + 9 + 10;
  if (needed > room) {
    needed -= 10;
    keep.sessions = false;
  }
  while (needed > room && keep.models > 0) {
    keep.models -= 1;
    needed -= COLUMN + 2;
  }
  if (needed > room) keep.resets = false;
  const shown = names.slice(0, 2 + keep.models);

  const head = [
    "profile".padEnd(width),
    ...shown.map((window) => window.label.padEnd(COLUMN)),
    ...(keep.resets ? ["resets".padEnd(7)] : []),
    ...(keep.sessions ? ["sessions"] : []),
  ];

  const laid = rows.map((row) => {
    const state = STATE_TEXT[row.usage?.state];
    const windows = shown.map((window) => windowOf(row.usage, window.key));
    const worst = windows.filter(Boolean).toSorted((a, b) => b.pct - a.pct)[0];
    const cells =
      state === undefined || row.usage?.state === "ok" || row.usage?.state === "stale"
        ? windows.map((window) => cell(window))
        : [state.padEnd(COLUMN), ...shown.slice(1).map(() => "".padEnd(COLUMN))];
    return [
      fit(row.name, width),
      ...(row.usage ? cells : blank(shown, row.loading)),
      ...(keep.resets ? [(worst && row.usage ? countdown(worst.resetsAt, now) : "").padEnd(7)] : []),
      ...(keep.sessions ? [describeBusy(row.busy)] : []),
    ];
  });
  const render = (parts) => parts.join("  ").trimEnd();
  return { header: render(head), rows: laid.map((parts) => render(parts)), width };
}

/** A name in its column: padded, or cut with an ellipsis that says it was cut. */
function fit(name, width) {
  return name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width);
}

function blank(shown, loading) {
  return shown.map((_, index) => (index === 0 && loading ? "checking…".padEnd(COLUMN) : "".padEnd(COLUMN)));
}

function describeBusy(counts) {
  if (!counts?.total) return "";
  return `${counts.total} ${counts.working > 0 ? "active" : "open"}`;
}
