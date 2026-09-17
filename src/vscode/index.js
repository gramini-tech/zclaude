// Installing the zclaude status bar item into whichever VS Code-shaped editor
// is on this machine.
//
// "VS Code" here means anything that speaks the `code` CLI: VS Code itself,
// Insiders, Cursor, Windsurf and VSCodium all take `--install-extension` with a
// path to a vsix. They are separate installs with separate extension
// directories, so each one is asked and installed separately.
//
// Nothing here reads a credential or writes to ~/.claude. The extension it
// installs shells back out to this binary for all of that.

import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../logger.js";

/** publisher.name from extension/package.json: what `code` calls it. */
export const EXTENSION_ID = "vipincr.zclaude";

const here = dirname(fileURLToPath(import.meta.url));

/** The packaged extension, which ships inside the npm tarball and the git checkout. */
export function vsixPath() {
  return join(here, "..", "..", "extension", "zclaude.vsix");
}

/** The version in the vsix's manifest, read from the source of truth beside it. */
export async function packagedVersion() {
  try {
    const manifest = JSON.parse(await readFile(join(here, "..", "..", "extension", "package.json"), "utf8"));
    return String(manifest.version);
  } catch {
    return null;
  }
}

/**
 * The editors worth looking for, each with the command it installs as. The
 * order is the order they are reported in, which puts plain VS Code first.
 */
export const EDITORS = Object.freeze([
  { id: "code", label: "VS Code", app: "Visual Studio Code" },
  { id: "code-insiders", label: "VS Code Insiders", app: "Visual Studio Code - Insiders" },
  { id: "cursor", label: "Cursor", app: "Cursor" },
  { id: "windsurf", label: "Windsurf", app: "Windsurf" },
  { id: "codium", label: "VSCodium", app: "VSCodium" },
]);

function home(env) {
  return env.HOME || env.USERPROFILE || homedir();
}

/**
 * Where an editor's CLI lives when it is not on PATH. A GUI install does not
 * put `code` on PATH until you run "Shell Command: Install 'code' command", so
 * the app bundle is the honest second place to look.
 * @param {{id: string, app: string}} editor
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform
 */
export function editorPaths(editor, env, platform) {
  const dir = home(env);
  if (platform === "darwin") {
    return [
      `/Applications/${editor.app}.app/Contents/Resources/app/bin/${editor.id}`,
      join(dir, "Applications", `${editor.app}.app`, "Contents", "Resources", "app", "bin", editor.id),
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(dir, "AppData", "Local");
    const programs = env.ProgramFiles || "C:\\Program Files";
    return [
      join(local, "Programs", editor.app, "bin", `${editor.id}.cmd`),
      join(programs, editor.app, "bin", `${editor.id}.cmd`),
    ];
  }
  return [
    `/usr/share/${editor.id}/bin/${editor.id}`,
    `/usr/bin/${editor.id}`,
    `/snap/bin/${editor.id}`,
    `/var/lib/flatpak/exports/bin/com.visualstudio.${editor.id}`,
    join(dir, ".local", "share", "flatpak", "exports", "bin", `com.visualstudio.${editor.id}`),
    join(dir, ".local", "bin", editor.id),
  ];
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH first, then the standard install locations. */
async function locate(editor, { env, platform }) {
  const exe = platform === "win32" ? `${editor.id}.cmd` : editor.id;
  const separator = platform === "win32" ? ";" : ":";
  const onPath = String(env.PATH || "")
    .split(separator)
    .filter(Boolean)
    .map((part) => join(part, exe));
  for (const candidate of [...onPath, ...editorPaths(editor, env, platform)]) {
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/**
 * Every editor found on this machine.
 * @param {{env?: NodeJS.ProcessEnv, platform?: string}} [options]
 * @returns {Promise<Array<{id: string, label: string, bin: string}>>}
 */
export async function findEditors({ env = process.env, platform = process.platform } = {}) {
  const found = await Promise.all(
    EDITORS.map(async (editor) => {
      const bin = await locate(editor, { env, platform });
      return bin ? { id: editor.id, label: editor.label, bin } : null;
    }),
  );
  return found.filter(Boolean);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
 */
function run(command, args, { env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Is it installed there, and at which version?
 * @param {{bin: string}} editor
 * @param {{env?: NodeJS.ProcessEnv, runImpl?: typeof run}} [options]
 */
export async function installedVersion(editor, { env = process.env, runImpl = run } = {}) {
  const result = await runImpl(editor.bin, ["--list-extensions", "--show-versions"], { env });
  if (!result.ok) return { state: "unknown", detail: (result.stderr || result.stdout).trim() || `exit ${result.code}` };
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.toLowerCase().startsWith(`${EXTENSION_ID.toLowerCase()}@`));
  return line ? { state: "installed", version: line.slice(line.indexOf("@") + 1).trim() ?? null } : { state: "absent" };
}

async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install (or reinstall) the packaged vsix.
 * @param {{bin: string, label: string}} editor
 * @param {{vsix?: string, env?: NodeJS.ProcessEnv, runImpl?: typeof run}} [options]
 */
export async function installInto(editor, { vsix = vsixPath(), env = process.env, runImpl = run } = {}) {
  if (!(await readable(vsix))) return { ok: false, detail: `the packaged extension is missing (${vsix})` };
  // --force replaces the same version, which is what an update needs: the
  // extension's version only moves when the extension itself changes.
  const result = await runImpl(editor.bin, ["--install-extension", vsix, "--force"], { env });
  if (!result.ok) log.warn("vscode", "install failed", { editor: editor.label, code: result.code });
  return { ok: result.ok, detail: (result.stderr || result.stdout).trim() };
}

/**
 * @param {{bin: string, label: string}} editor
 * @param {{env?: NodeJS.ProcessEnv, runImpl?: typeof run}} [options]
 */
export async function uninstallFrom(editor, { env = process.env, runImpl = run } = {}) {
  const result = await runImpl(editor.bin, ["--uninstall-extension", EXTENSION_ID], { env });
  // An editor that never had it says so on stderr and exits non-zero. That is
  // not a failure of an uninstall, so it is reported as "was not installed".
  const text = `${result.stdout}${result.stderr}`.toLowerCase();
  if (!result.ok && text.includes("not installed")) return { ok: true, removed: false };
  return { ok: result.ok, removed: result.ok, detail: (result.stderr || result.stdout).trim() };
}

/**
 * Install into every editor found, or report that there are none.
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, vsix?: string, runImpl?: typeof run}} [options]
 */
export async function installEverywhere(options = {}) {
  const editors = await findEditors(options);
  const results = [];
  for (const editor of editors) {
    const result = await installInto(editor, options);
    results.push({ editor, ...result });
  }
  return results;
}

/** Remove it from every editor found. Used by every uninstall path. */
export async function uninstallEverywhere(options = {}) {
  const editors = await findEditors(options);
  const results = [];
  for (const editor of editors) {
    const result = await uninstallFrom(editor, options);
    results.push({ editor, ...result });
  }
  return results;
}
