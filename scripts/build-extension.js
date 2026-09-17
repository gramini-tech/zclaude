// Package extension/ into extension/zclaude.vsix, which is committed.
//
// The vsix is a zip, and a zip carries timestamps, so two builds of identical
// files differ byte for byte. The contract test therefore compares the files
// inside rather than the archive, and `--check` here does the same: it builds
// into a temporary directory and reports whether the committed vsix holds the
// same content.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");
export const VSIX_PATH = join(extensionDir, "zclaude.vsix");

/** vsce, from this repo's node_modules rather than whatever npx resolves. */
function vscePath() {
  return join(root, "node_modules", ".bin", "vsce");
}

async function pack(target) {
  // --no-dependencies: the extension has none, and the flag stops vsce from
  // walking the repo's own node_modules looking for them.
  await run(vscePath(), ["package", "--no-dependencies", "--allow-missing-repository", "--out", target], {
    cwd: extensionDir,
    env: { ...process.env, npm_config_yes: "true" },
  });
}

// The two zip signatures this needs, as the bytes they are rather than as
// numbers: "PK" then a record type.
const CENTRAL_HEADER = "PK\u{1}\u{2}";
const END_OF_CENTRAL_DIRECTORY = "PK\u{5}\u{6}";

const signatureAt = (zip, at) => zip.toString("latin1", at, at + 4);

/**
 * Every file in a vsix, with the CRC-32 and size the archive records for it.
 * A zip's central directory already carries both, so this compares content
 * without decompressing anything and without shelling out to `unzip`, whose
 * argument globbing chokes on `[Content_Types].xml`.
 * @param {string} path
 * @returns {Promise<Record<string, string>>}
 */
export async function vsixContents(path) {
  const zip = await readFile(path);
  const end = findEndOfCentralDirectory(zip);
  if (!end) throw new Error(`${path} is not a zip archive`);
  const entries = {};
  let at = end.offset;
  for (let index = 0; index < end.count; index += 1) {
    if (signatureAt(zip, at) !== CENTRAL_HEADER)
      throw new Error(`${path}: central directory entry ${index} is corrupt`);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    entries[name] = `${crc.toString(16).padStart(8, "0")}:${size}`;
    at += 46 + nameLength + extraLength + commentLength;
  }
  return Object.fromEntries(Object.entries(entries).toSorted(([a], [b]) => a.localeCompare(b)));
}

/** The trailer, searched from the end because it sits behind a free-text comment. */
function findEndOfCentralDirectory(zip) {
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (signatureAt(zip, at) !== END_OF_CENTRAL_DIRECTORY) continue;
    return { count: zip.readUInt16LE(at + 10), offset: zip.readUInt32LE(at + 16) };
  }
  return null;
}

async function main() {
  const check = process.argv.includes("--check");
  if (!check) {
    await pack(VSIX_PATH);
    const manifest = JSON.parse(await readFile(join(extensionDir, "package.json"), "utf8"));
    process.stdout.write(`packaged ${manifest.name} ${manifest.version} -> ${VSIX_PATH}\n`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "zclaude-vsix-"));
  try {
    const fresh = join(dir, "fresh.vsix");
    await pack(fresh);
    const [a, b] = await Promise.all([vsixContents(VSIX_PATH), vsixContents(fresh)]);
    if (JSON.stringify(a) === JSON.stringify(b)) {
      process.stdout.write("the committed vsix matches a fresh build\n");
      return;
    }
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].toSorted((x, y) => x.localeCompare(y));
    const differing = names.filter((name) => a[name] !== b[name]);
    process.stderr.write(
      `extension/zclaude.vsix is out of date. Run \`npm run build:extension\` and commit it.\n` +
        `Differs in: ${differing.join(", ")}\n`,
    );
    process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
