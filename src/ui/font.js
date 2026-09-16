// Pixel font for the zclaude wordmark. Pure data and pure functions with no
// imports, so the terminal banner (src/ui/banner.js), the website logo and the
// favicon (scripts/render-logo.js, site/) all draw from this one bitmap.
//
// Every glyph is 12 pixels tall: rows 0-3 hold ascenders, rows 4-11 the
// x-height. In a terminal each cell shows two stacked half-block pixels, so a
// pixel is roughly square and the wordmark is 6 text rows plus a shadow row.

export const GLYPH_HEIGHT = 12;

export const GLYPHS = Object.freeze({
  z: [
    "........",
    "........",
    "........",
    "........",
    "########",
    "########",
    ".....###",
    "....###.",
    "..###...",
    ".###....",
    "########",
    "########",
  ],
  c: [
    "........",
    "........",
    "........",
    "........",
    "..######",
    ".#######",
    "###.....",
    "##......",
    "##......",
    "###.....",
    ".#######",
    "..######",
  ],
  l: ["###..", "###..", ".##..", ".##..", ".##..", ".##..", ".##..", ".##..", ".##..", ".##..", ".####", "..###"],
  a: [
    "........",
    "........",
    "........",
    "........",
    ".######.",
    "########",
    "##....##",
    "##....##",
    "##....##",
    "###..###",
    "########",
    ".####.##",
  ],
  u: [
    "........",
    "........",
    "........",
    "........",
    "##....##",
    "##....##",
    "##....##",
    "##....##",
    "##....##",
    "###..###",
    "########",
    ".####.##",
  ],
  d: [
    "......##",
    "......##",
    "......##",
    "......##",
    ".#######",
    "########",
    "##....##",
    "##....##",
    "##....##",
    "###..###",
    "########",
    ".####.##",
  ],
  e: [
    "........",
    "........",
    "........",
    "........",
    "..####..",
    ".######.",
    "##....##",
    "########",
    "########",
    "##......",
    ".#######",
    "..######",
  ],
});

/** Color groups: the "z" and the "claude" halves get their own gradients. */
export const GROUPS = Object.freeze({ z: 1, claude: 2 });

export const PALETTE = Object.freeze({
  z: [
    [94, 196, 255],
    [124, 138, 255],
  ],
  claude: [
    [255, 184, 108],
    [236, 102, 84],
  ],
  shadow: [74, 74, 86],
});

const LETTER_GAP = 2;
const WORD_GAP = 3;

/**
 * Lay out a word into a grid of pixels. Cells hold 0 (empty), a group id for
 * letter pixels, or -1 for shadow pixels when `shadow` is set.
 * @param {ReadonlyArray<{text: string, group: number}>} parts
 * @param {{shadow?: boolean}} [options]
 * @returns {{grid: number[][], width: number, height: number, spans: Record<number, [number, number]>}}
 */
export function layout(parts, { shadow = true } = {}) {
  const columns = [];
  /** @type {Record<number, [number, number]>} */
  const spans = {};
  for (const [partIndex, part] of parts.entries()) {
    if (partIndex > 0) columns.push(...Array.from({ length: WORD_GAP }, () => null));
    const start = columns.length;
    for (const [letterIndex, letter] of [...part.text].entries()) {
      const glyph = GLYPHS[letter];
      if (!glyph) throw new Error(`No glyph for "${letter}"`);
      if (letterIndex > 0) columns.push(...Array.from({ length: LETTER_GAP }, () => null));
      for (let x = 0; x < glyph[0].length; x += 1) {
        columns.push(glyph.map((row) => (row[x] === "#" ? part.group : 0)));
      }
    }
    spans[part.group] = [start, columns.length];
  }
  const extra = shadow ? 1 : 0;
  const width = columns.length + extra;
  const height = GLYPH_HEIGHT + extra;
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  for (const [x, column] of columns.entries()) {
    if (!column) continue;
    for (const [y, value] of column.entries()) {
      if (value) grid[y][x] = value;
    }
  }
  if (shadow) addShadow(grid, width, height);
  return { grid, width, height, spans };
}

/** Mark empty pixels one step down and right of a letter pixel as shadow (-1). */
function addShadow(grid, width, height) {
  for (let y = height - 1; y >= 1; y -= 1) {
    for (let x = width - 1; x >= 1; x -= 1) {
      if (grid[y][x] === 0 && grid[y - 1][x - 1] > 0) grid[y][x] = -1;
    }
  }
}

/** The standard wordmark parts. */
export const WORDMARK = Object.freeze([
  { text: "z", group: GROUPS.z },
  { text: "claude", group: GROUPS.claude },
]);

/** Linear interpolation between two RGB triples. */
function mix(from, to, t) {
  const clamped = Math.min(1, Math.max(0, t));
  return from.map((channel, i) => Math.round(channel + (to[i] - channel) * clamped));
}

/** RGB for a pixel value at column x, or null when empty. */
export function pixelColor(value, x, spans, palette = PALETTE) {
  if (value === 0) return null;
  if (value === -1) return palette.shadow;
  const key = value === GROUPS.z ? "z" : "claude";
  const [start, end] = spans[value];
  const t = end - start > 1 ? (x - start) / (end - start - 1) : 0;
  return mix(palette[key][0], palette[key][1], t);
}
