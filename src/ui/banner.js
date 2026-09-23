// Wordmark shown on interactive launches. Drawn from the pixel font in
// font.js with half-block characters (two square pixels per terminal cell),
// a left-to-right gradient per word and a one-pixel drop shadow. Falls back
// to 256 colors, then to plain glyphs without shadow when color is off.

import { VERSION } from "../config.js";
import { layout, PALETTE, pixelColor, WORDMARK } from "./font.js";
import { colorEnabled, paint } from "./log.js";

const UPPER = "▀";
const LOWER = "▄";
const FULL = "█";
const RESET = "\u{1B}[0m";

/**
 * @param {{isTTY?: boolean}} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"none" | "256" | "truecolor"}
 */
export function colorMode(stream = process.stdout, env = process.env) {
  if (!colorEnabled(stream, env)) return "none";
  const colorterm = String(env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit" || env.FORCE_COLOR === "3") return "truecolor";
  return "256";
}

/** Nearest xterm-256 palette index for an RGB triple. */
export function rgbTo256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const level = (value) => Math.round((value / 255) * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

function sgr(rgb, layer, mode) {
  const code = layer === "fg" ? 38 : 48;
  if (mode === "truecolor") return `\u{1B}[${code};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  return `\u{1B}[${code};5;${rgbTo256(rgb)}m`;
}

function same(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** One terminal cell from its top and bottom pixel colors. */
function cell(top, bottom, mode) {
  if (!top && !bottom) return " ";
  if (top && !bottom) return `${sgr(top, "fg", mode)}${UPPER}${RESET}`;
  if (!top) return `${sgr(bottom, "fg", mode)}${LOWER}${RESET}`;
  if (same(top, bottom)) return `${sgr(top, "fg", mode)}${FULL}${RESET}`;
  return `${sgr(top, "fg", mode)}${sgr(bottom, "bg", mode)}${UPPER}${RESET}`;
}

/** Plain rows (no color, no shadow). Exported for tests. */
export function bannerRows() {
  const { grid, width, height } = layout(WORDMARK, { shadow: false });
  const rows = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      const top = grid[y][x] > 0;
      const bottom = y + 1 < height && grid[y + 1][x] > 0;
      if (top && bottom) line += FULL;
      else if (top) line += UPPER;
      else line += bottom ? LOWER : " ";
    }
    rows.push(line);
  }
  return rows;
}

/** Colored rows with gradient and shadow. */
export function coloredRows(mode) {
  const { grid, width, height, spans } = layout(WORDMARK, { shadow: true });
  const rows = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      const top = pixelColor(grid[y][x], x, spans);
      const bottom = y + 1 < height ? pixelColor(grid[y + 1][x], x, spans) : null;
      line += cell(top, bottom, mode);
    }
    rows.push(line.trimEnd());
  }
  return rows;
}

export function bannerWidth() {
  return layout(WORDMARK, { shadow: true }).width;
}

export const MIN_COLUMNS = bannerWidth() + 2;

/**
 * @param {{columns?: number, mode?: "none" | "256" | "truecolor"}} [options]
 */
export function renderBanner({ columns = 80, mode = "none" } = {}) {
  const colored = mode !== "none";
  const tint = (text) => (colored ? paint(text, "grey", { isTTY: true }, { FORCE_COLOR: "1" }) : text);
  const tagline = `v${VERSION} · several accounts, one session across them · Anthropic + Z.ai`;
  if (columns < MIN_COLUMNS) {
    if (!colored) return `zclaude  ${tagline}\n`;
    const z = `${sgr(PALETTE.z[0], "fg", mode)}z${RESET}`;
    const claude = `${sgr(PALETTE.claude[1], "fg", mode)}claude${RESET}`;
    return `${z}${claude}  ${tint(tagline)}\n`;
  }
  const rows = colored ? coloredRows(mode) : bannerRows().map((row) => row.trimEnd());
  return `\n${rows.join("\n")}\n\n${tint(tagline)}\n\n`;
}

export function printBanner({ stream = process.stdout, env = process.env } = {}) {
  if (!stream.isTTY) return;
  stream.write(renderBanner({ columns: stream.columns || 80, mode: colorMode(stream, env) }));
}
