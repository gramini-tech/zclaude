import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VERSION } from "../src/config.js";
import {
  bannerRows,
  bannerWidth,
  colorMode,
  coloredRows,
  MIN_COLUMNS,
  renderBanner,
  rgbTo256,
} from "../src/ui/banner.js";
import { GLYPH_HEIGHT, GLYPHS, layout, pixelColor, WORDMARK } from "../src/ui/font.js";

const ESC = String.fromCodePoint(27);

describe("pixel font", () => {
  it("every glyph is GLYPH_HEIGHT rows of equal width made of # and .", () => {
    for (const [letter, rows] of Object.entries(GLYPHS)) {
      assert.equal(rows.length, GLYPH_HEIGHT, `${letter} height`);
      const width = rows[0].length;
      for (const row of rows) {
        assert.equal(row.length, width, `${letter} row width`);
        assert.match(row, /^[#.]+$/u, `${letter} row characters`);
      }
    }
  });

  it("lays out the wordmark with a one-pixel shadow down and right", () => {
    const flat = layout(WORDMARK, { shadow: false });
    const shaded = layout(WORDMARK, { shadow: true });
    assert.equal(shaded.width, flat.width + 1);
    assert.equal(shaded.height, flat.height + 1);
    for (let y = 0; y < flat.height; y += 1) {
      for (let x = 0; x < flat.width; x += 1) {
        if (flat.grid[y][x] > 0) assert.equal(shaded.grid[y][x], flat.grid[y][x], "letters unchanged");
      }
    }
    assert.ok(shaded.grid.flat().includes(-1), "has shadow pixels");
    assert.throws(() => layout([{ text: "q", group: 1 }]), /No glyph/u);
  });

  it("interpolates gradient colors across each word", () => {
    const { spans } = layout(WORDMARK);
    const [start, end] = spans[2];
    assert.deepEqual(pixelColor(2, start, spans), [255, 184, 108]);
    assert.deepEqual(pixelColor(2, end - 1, spans), [236, 102, 84]);
    assert.equal(pixelColor(0, 3, spans), null);
  });
});

describe("banner", () => {
  it("plain rows are 6 half-block rows that fit 70 columns", () => {
    const rows = bannerRows();
    assert.equal(rows.length, GLYPH_HEIGHT / 2);
    for (const row of rows) assert.match(row, /^[▀▄█ ]+$/u);
    assert.ok(bannerWidth() <= 70, `width ${bannerWidth()}`);
  });

  it("renders without escape codes when color is off", () => {
    const out = renderBanner({ columns: 120, mode: "none" });
    assert.ok(out.includes(`v${VERSION}`));
    assert.equal(out.includes(ESC), false);
  });

  it("uses 24-bit or 256-color codes with a shadow row when color is on", () => {
    const truecolor = renderBanner({ columns: 120, mode: "truecolor" });
    assert.ok(truecolor.includes(`${ESC}[38;2;`));
    assert.ok(truecolor.includes(`${ESC}[48;2;`), "shadow behind letters uses a background color");
    const palette = renderBanner({ columns: 120, mode: "256" });
    assert.ok(palette.includes(`${ESC}[38;5;`));
    assert.equal(palette.includes("38;2;"), false);
    assert.equal(coloredRows("truecolor").length, Math.ceil((GLYPH_HEIGHT + 1) / 2));
  });

  it("falls back to a one-liner on narrow terminals", () => {
    assert.equal(
      renderBanner({ columns: MIN_COLUMNS - 1, mode: "none" }),
      `zclaude  v${VERSION} · Claude Code preloader · Z.ai GLM Coding Plan\n`,
    );
    assert.ok(renderBanner({ columns: MIN_COLUMNS - 1, mode: "256" }).includes(`${ESC}[38;5;`));
    assert.ok(renderBanner({ columns: MIN_COLUMNS, mode: "none" }).split("\n").length > 6);
  });

  it("picks the color mode from the terminal", () => {
    const tty = { isTTY: true };
    assert.equal(colorMode(tty, { COLORTERM: "truecolor" }), "truecolor");
    assert.equal(colorMode(tty, { TERM: "xterm-256color" }), "256");
    assert.equal(colorMode(tty, { NO_COLOR: "1", COLORTERM: "truecolor" }), "none");
    assert.equal(colorMode({ isTTY: false }, {}), "none");
  });

  it("maps RGB to the xterm-256 palette", () => {
    assert.equal(rgbTo256([0, 0, 0]), 16);
    assert.equal(rgbTo256([255, 255, 255]), 231);
    assert.equal(rgbTo256([255, 0, 0]), 196);
    assert.equal(rgbTo256([128, 128, 128]), 244);
  });
});
