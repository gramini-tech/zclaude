// The table the terminal menu draws, and how it gives way on a narrow one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { layout } from "../src/usage/table.js";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const window = (pct, hours = 3) => ({ pct, resetsAt: NOW + hours * 3_600_000 });
const rows = [
  {
    name: "gramini",
    usage: { state: "ok", fiveHour: window(50), weekly: window(31, 120), scoped: [{ name: "Fable", ...window(92) }] },
    busy: { total: 3, working: 0 },
  },
  {
    name: "hoomanely",
    usage: { state: "ok", fiveHour: window(0), weekly: window(55, 120), scoped: [{ name: "Fable", ...window(100) }] },
  },
  { name: "chinese", usage: { state: "ok", fiveHour: window(16), weekly: window(71, 120), scoped: [] } },
];

const at = (columns) => layout(rows, { columns, now: NOW });

describe("the usage table", () => {
  it("draws a gauge and a percentage per window", () => {
    const table = at(100);
    assert.match(table.rows[0], /█████░░░░░\s+50%/u);
    assert.match(table.rows[1], /░░░░░░░░░░\s+0%/u, "a window with nothing spent is an empty bar");
    assert.match(table.rows[1], /██████████\s+100%/u);
  });

  it("lines every column up, which is the point of a monospace one", () => {
    const table = at(100);
    const first = table.rows.map((row) => row.indexOf("%"));
    assert.equal(new Set(first).size, 1, `the first percentage column drifted: ${JSON.stringify(table.rows)}`);
    const header = table.header.indexOf("5 hours");
    assert.ok(
      table.rows.every((row) => row.slice(header - 1, header).trim() === ""),
      "the gauges start under their own heading",
    );
  });

  it("holds a column open for a window a profile does not have", () => {
    const table = at(100);
    assert.match(table.rows[2], /–/u, "chinese has no Fable window");
    assert.equal(new Set(table.rows.map((row) => row.indexOf("%"))).size, 1);
  });

  it("gives up columns rather than wrapping, widest first", () => {
    // A wrapped row would put the cursor on the wrong line in a live menu.
    const wide = at(100);
    assert.match(wide.header, /sessions/u);
    assert.match(at(80).header, /Fable/u);
    assert.doesNotMatch(at(80).header, /sessions/u);
    assert.doesNotMatch(at(64).header, /Fable/u);
    assert.match(at(64).header, /resets/u);
    for (const columns of [64, 80, 100]) {
      const table = at(columns);
      for (const row of [table.header, ...table.rows]) {
        assert.ok(row.length + 2 <= columns, `a row ran past ${columns} columns: ${row.length + 2}`);
      }
    }
  });

  it("keeps the two windows every plan has, however narrow it gets", () => {
    const table = at(40);
    assert.match(table.header, /5 hours/u);
    assert.match(table.header, /week/u);
  });

  it("shows the reset of whichever window is closest to stopping you", () => {
    const table = at(100);
    // Fable at 92% is the one to watch, and its window is three hours out.
    assert.match(table.rows[0], /92%\s+3h\b/u);
    // chinese has no Fable window, so a dash sits between its numbers and its
    // clock; the clock is still the week's, which is its fullest.
    assert.match(table.rows[2], /5d$/u);
  });

  it("cuts a long name rather than letting it push the numbers off", () => {
    const table = layout([...rows, { name: "Claude Code + Z.ai GLM Coding Plan", usage: rows[0].usage }], {
      columns: 100,
      now: NOW,
    });
    assert.match(table.rows.at(-1), /^Claude Code \+ Z\.ai …/u);
    assert.equal(new Set(table.rows.map((row) => row.indexOf("%"))).size, 1, "the numbers stay where they were");
  });

  it("says a row is still loading rather than drawing a zero", () => {
    const table = layout([{ name: "work", loading: true }], { columns: 100, now: NOW });
    assert.match(table.rows[0], /checking…/u);
    assert.doesNotMatch(table.rows[0], /0%/u);
  });

  it("puts the reason in place of the numbers when there are none", () => {
    const table = layout([{ name: "work", usage: { state: "unauthorized" } }], { columns: 100, now: NOW });
    assert.match(table.rows[0], /sign in to see usage/u);
    assert.doesNotMatch(table.rows[0], /░/u);
  });
});
