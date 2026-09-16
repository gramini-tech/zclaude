// Renders the website logo and favicon from the same pixel font the terminal
// banner uses. Run `npm run render:logo` after changing src/ui/font.js; a
// contract test fails when the committed SVGs are stale.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GLYPHS, GROUPS, layout, PALETTE, WORDMARK } from "../src/ui/font.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const UNIT = 10;
/** @param {ReadonlyArray<number>} rgb */
const hex = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/** Merge horizontal runs of equal pixel values into rects. */
function runs(grid) {
  const out = [];
  for (const [y, row] of grid.entries()) {
    let x = 0;
    while (x < row.length) {
      const value = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === value) end += 1;
      if (value !== 0) out.push({ x, y, length: end - x, value });
      x = end;
    }
  }
  return out;
}

function rects(grid, fillFor) {
  return runs(grid)
    .map(
      ({ x, y, length, value }) =>
        `<rect x="${x * UNIT}" y="${y * UNIT}" width="${length * UNIT}" height="${UNIT}" fill="${fillFor(value)}"/>`,
    )
    .join("");
}

/**
 * @param {string} id
 * @param {ReadonlyArray<number>} span start and end column
 * @param {ReadonlyArray<ReadonlyArray<number>>} colors from and to RGB
 */
function gradient(id, span, colors) {
  const [start, end] = span;
  const [from, to] = colors;
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${start * UNIT}" y1="0" x2="${end * UNIT}" y2="0"><stop offset="0" stop-color="${hex(from)}"/><stop offset="1" stop-color="${hex(to)}"/></linearGradient>`;
}

export function logoSvg() {
  const { grid, width, height, spans } = layout(WORDMARK, { shadow: true });
  const fill = (value) => {
    if (value === -1) return "#6b6b78";
    return value === GROUPS.z ? "url(#zclaude-z)" : "url(#zclaude-claude)";
  };
  const shadowGrid = grid.map((row) => row.map((value) => (value === -1 ? -1 : 0)));
  const letterGrid = grid.map((row) => row.map((value) => Math.max(value, 0)));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * UNIT} ${height * UNIT}" width="${width * UNIT}" height="${height * UNIT}" role="img" aria-label="zclaude" shape-rendering="crispEdges">`,
    "<title>zclaude</title>",
    `<defs>${gradient("zclaude-z", spans[GROUPS.z], PALETTE.z)}${gradient("zclaude-claude", spans[GROUPS.claude], PALETTE.claude)}</defs>`,
    `<g opacity="0.45">${rects(shadowGrid, fill)}</g>`,
    `<g>${rects(letterGrid, fill)}</g>`,
    "</svg>",
    "",
  ].join("\n");
}

export function faviconSvg() {
  const glyph = GLYPHS.z.slice(4);
  const size = 12;
  const offset = 2;
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  for (const [y, row] of glyph.entries()) {
    for (const [x, pixel] of [...row].entries()) {
      if (pixel === "#") grid[y + offset][x + offset] = 1;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size * UNIT} ${size * UNIT}" shape-rendering="crispEdges">`,
    `<defs>${gradient("zclaude-fav", [offset, offset + glyph[0].length], PALETTE.z)}</defs>`,
    `<rect width="${size * UNIT}" height="${size * UNIT}" rx="${2 * UNIT}" fill="#16151c"/>`,
    rects(grid, () => "url(#zclaude-fav)"),
    "</svg>",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(root, "site", "logo.svg"), logoSvg());
  writeFileSync(join(root, "site", "favicon.svg"), faviconSvg());
  process.stdout.write("wrote site/logo.svg and site/favicon.svg\n");
}
