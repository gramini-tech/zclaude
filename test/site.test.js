// Guards for the GitHub Pages site: generated art stays in sync with the font,
// install commands match the README, and every local link resolves.

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { faviconSvg, logoSvg } from "../scripts/render-logo.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");

describe("site", () => {
  it("committed logo and favicon match the pixel font (npm run render:logo)", async () => {
    assert.equal(await read("site/logo.svg"), logoSvg());
    assert.equal(await read("site/favicon.svg"), faviconSvg());
  });

  it("offers the same install commands as the README", async () => {
    const [html, readme] = await Promise.all([read("index.html"), read("README.md")]);
    const commands = [
      "curl -fsSL https://gramini-tech.github.io/zclaude/install | bash",
      "npx github:gramini-tech/zclaude self-install",
      "npm install -g github:gramini-tech/zclaude",
    ];
    for (const command of commands) {
      assert.ok(html.includes(command), `index.html is missing: ${command}`);
      assert.ok(readme.includes(command), `README.md is missing: ${command}`);
    }
  });

  it("every local href and src resolves to a file", async () => {
    const html = await read("index.html");
    const refs = Array.from(html.matchAll(/(?:href|src)="([^"#:]+)"/gu), (match) => match[1]);
    assert.ok(refs.length >= 4);
    for (const ref of refs) await access(join(root, ref));
  });

  it("has a FAQ and every in-page anchor points at an element", async () => {
    const html = await read("index.html");
    assert.ok((html.match(/<details>/gu) ?? []).length >= 8, "at least eight FAQ entries");
    const ids = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/gu), (match) => match[1]));
    for (const [, anchor] of html.matchAll(/href="#([^"]+)"/gu)) assert.ok(ids.has(anchor), `#${anchor} has no target`);
  });

  it("documents the uninstall command the installer actually supports", async () => {
    const [html, installer] = await Promise.all([read("index.html"), read("install.sh")]);
    assert.ok(installer.includes('"${1:-}" = "--uninstall"'));
    assert.ok(html.includes("bash -s -- --uninstall"));
  });
});
