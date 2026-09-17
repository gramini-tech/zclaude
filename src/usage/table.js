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
/** The same, plus the reset: "  4d 15h". */
const CLOCK = 8;
/** Just "100%", for a terminal too narrow to draw in. */
const NUMBER = 4;
/** Past this a name is cut: the numbers are what the table is for. */
const MAX_NAME = 20;
/** And never cut below this, or the rows stop being distinguishable. */
const MIN_NAME = 8;

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

/**
 * One window: the gauge, the number, and — for the two windows every plan has —
 * when it comes back.
 *
 * The 5-hour and the week are the two that run out on different clocks, so
 * each carries its own. A per-model window resets with the week it belongs to,
 * so repeating that time beside it would be three columns saying one thing.
 */
function cell(window, { timed = false, bars = true, now = Date.now() } = {}) {
  const width = cellWidth({ timed, bars });
  if (!window) return "–".padStart(Math.round(width / 2)).padEnd(width);
  const pct = `${String(Math.round(window.pct)).padStart(4)}%`;
  const shown = bars ? `${gauge(window.pct)}${pct}` : pct.trimStart().padStart(NUMBER);
  return timed ? `${shown}  ${countdown(window.resetsAt, now).padEnd(CLOCK - 2)}` : shown;
}

function cellWidth({ timed, bars }) {
  return (bars ? COLUMN : NUMBER) + (timed ? CLOCK : 0);
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
  // Two for the cursor the caller puts in front of every row, one so a full
  // line never touches the right edge.
  const room = columns - 3;
  // What gets given up, in order, and only as far as it has to: the sessions
  // count, then the per-model windows, then the two clocks, then the name
  // column shrinks. The 5-hour and the week themselves are never dropped —
  // they are what the table is for.
  const keep = { models: names.length - 2, sessions: true, clocks: true, bars: true, name: width };
  const cost = () =>
    keep.name +
    2 +
    (cellWidth({ timed: keep.clocks, bars: keep.bars }) + 2) * 2 +
    (cellWidth({ timed: false, bars: keep.bars }) + 2) * keep.models +
    (keep.sessions ? 10 : 0);
  if (cost() > room) keep.sessions = false;
  while (cost() > room && keep.models > 0) keep.models -= 1;
  if (cost() > room) keep.clocks = false;
  // Last of all the drawing goes. A terminal this narrow cannot hold a gauge,
  // and the numbers alone are still the answer to the question being asked.
  if (cost() > room) keep.bars = false;
  while (cost() > room && keep.name > MIN_NAME) keep.name -= 1;

  const shown = names.slice(0, 2 + keep.models);
  const timedAt = (index) => keep.clocks && index < 2;

  // A column is as wide as its contents or its heading, whichever needs more:
  // on a narrow terminal "5 hours" is wider than the " 50%" beneath it, and a
  // number that did not sit under its own heading would be worse than useless.
  const columnWidth = (index) =>
    Math.max(cellWidth({ timed: timedAt(index), bars: keep.bars }), shown[index].label.length);
  const head = [
    "profile".padEnd(keep.name),
    ...shown.map((window, index) => window.label.padEnd(columnWidth(index))),
    ...(keep.sessions ? ["sessions"] : []),
  ];

  const laid = rows.map((row) => {
    const state = STATE_TEXT[row.usage?.state];
    const windows = shown.map((window) => windowOf(row.usage, window.key));
    const cells =
      state === undefined || row.usage?.state === "ok" || row.usage?.state === "stale"
        ? windows.map((window, index) =>
            cell(window, { timed: timedAt(index), bars: keep.bars, now }).padEnd(columnWidth(index)),
          )
        : [
            state.padEnd(cellWidth({ timed: timedAt(0), bars: keep.bars })),
            ...shown.slice(1).map((_, index) => "".padEnd(cellWidth({ timed: timedAt(index + 1), bars: keep.bars }))),
          ];
    return [
      fit(row.name, keep.name),
      ...(row.usage
        ? cells
        : blank(shown, row.loading, (index) => cellWidth({ timed: timedAt(index), bars: keep.bars }))),
      ...(keep.sessions ? [describeBusy(row.busy)] : []),
    ];
  });
  const render = (parts) => parts.join("  ").trimEnd();
  return { header: render(head), rows: laid.map((parts) => render(parts)), width: keep.name };
}

/** A name in its column: padded, or cut with an ellipsis that says it was cut. */
function fit(name, width) {
  return name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width);
}

function blank(shown, loading, widthAt) {
  return shown.map((_, index) => {
    const width = widthAt(index);
    return index === 0 && loading ? "checking…".slice(0, width).padEnd(width) : "".padEnd(width);
  });
}

function describeBusy(counts) {
  if (!counts?.total) return "";
  return `${counts.total} ${counts.working > 0 ? "active" : "open"}`;
}
