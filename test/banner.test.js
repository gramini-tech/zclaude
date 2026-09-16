import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bannerRows, bannerWidth, MIN_COLUMNS, renderBanner } from "../src/ui/banner.js";
import { VERSION } from "../src/config.js";

describe("banner", () => {
  it("has seven rows of equal width built only from block glyphs and spaces", () => {
    const rows = bannerRows();
    assert.equal(rows.length, 7);
    for (const row of rows) {
      assert.equal(row.length, bannerWidth());
      assert.match(row, /^[█ ]+$/u);
    }
    assert.ok(bannerWidth() <= 70, `width ${bannerWidth()} keeps the splash under 70 columns`);
  });
  it("renders colourless text with the version tagline", () => {
    const out = renderBanner({ columns: 120, color: false });
    assert.ok(out.includes(`v${VERSION}`));
    assert.equal(out.includes("\u{1B}["), false);
    assert.equal(out.split("\n").length, 7 + 4);
  });
  it("adds colour when asked", () => {
    assert.ok(renderBanner({ columns: 120, color: true }).includes("\u{1B}[90m"));
  });
  it("falls back to a one-liner on narrow terminals", () => {
    const narrow = renderBanner({ columns: MIN_COLUMNS - 1, color: false });
    assert.equal(narrow.split("\n").length, 2);
    assert.match(narrow, /^zclaude {2}v/u);
    assert.equal(renderBanner({ columns: MIN_COLUMNS, color: false }).split("\n").length, 11);
  });
});
