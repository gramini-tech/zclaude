// Block-letter wordmark shown on interactive launches. Hand-embedded pixel
// font (no figlet dependency); each pixel renders as two full-block cells so
// the letters keep roughly square proportions in a terminal.

import { VERSION } from "../config.js";
import { colorEnabled, paint } from "./log.js";

const PIXEL = "██";
const GAP = "  ";

const FONT = {
  z: ["....", "....", "####", "...#", "..#.", ".#..", "####"],
  c: ["....", "....", ".###", "#...", "#...", "#...", ".###"],
  l: ["##.", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
  a: ["....", "....", ".###", "...#", ".###", "#..#", ".###"],
  u: ["....", "....", "#..#", "#..#", "#..#", "#..#", ".###"],
  d: ["...#", "...#", ".###", "#..#", "#..#", "#..#", ".###"],
  e: ["....", "....", ".##.", "#..#", "####", "#...", ".###"],
};

const ROWS = 7;

function renderWord(word) {
  const rows = [];
  for (let row = 0; row < ROWS; row += 1) {
    rows.push([...word].map((letter) => FONT[letter][row].replaceAll("#", PIXEL).replaceAll(".", "  ")).join(GAP));
  }
  return rows;
}

/** Plain rows (no color) for the two halves. Exported for tests. */
export function bannerRows() {
  const left = renderWord("z");
  const right = renderWord("claude");
  return left.map((row, index) => `${row}${GAP}${right[index]}`);
}

export function bannerWidth() {
  return Math.max(...bannerRows().map((row) => row.length));
}

export const MIN_COLUMNS = bannerWidth() + 2;

export function renderBanner({ columns = 80, color = true } = {}) {
  const tint = (text, style) => (color ? paint(text, style, { isTTY: true }, { FORCE_COLOR: "1" }) : text);
  const tagline = `v${VERSION} · Claude Code preloader · Z.ai GLM Coding Plan`;
  if (columns < MIN_COLUMNS) {
    return `${tint("z", "grey")}${tint("claude", "white")}  ${tint(tagline, "grey")}\n`;
  }
  const left = renderWord("z");
  const right = renderWord("claude");
  const lines = left.map((row, index) => `${tint(row, "grey")}${GAP}${tint(right[index], "white")}`.replace(/\s+$/u, ""));
  return `${lines.join("\n")}\n\n${tint(tagline, "grey")}\n\n`;
}

export function printBanner({ stream = process.stdout, env = process.env } = {}) {
  if (!stream.isTTY) return;
  stream.write(renderBanner({ columns: stream.columns ?? 80, color: colorEnabled(stream, env) }));
}
