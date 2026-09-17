// The `zclaude vscode` command group: put the status bar item into the editors
// on this machine, take it out again, or say where it stands.
//
// The installer does the same thing during `install.sh`, which covers the curl
// path. This covers the npm path, which never runs that script, and it is how
// you add the extension to an editor installed after zclaude was.

import { EXIT, usageError } from "./errors.js";
import { info, success, warn } from "./ui/log.js";
import {
  EXTENSION_ID,
  findEditors,
  installEverywhere,
  installedVersion,
  packagedVersion,
  uninstallEverywhere,
  vsixPath,
} from "./vscode/index.js";

export const VSCODE_SUBCOMMANDS = Object.freeze(["install", "uninstall", "status"]);

const RELOAD = "Reload the editor window to pick it up (Command Palette → Developer: Reload Window).";

function noEditors() {
  warn("No VS Code-shaped editor was found on this machine.");
  info("Looked for code, code-insiders, cursor, windsurf and codium on PATH and in the usual install locations.");
  return EXIT.OK;
}

async function cmdInstall({ env, platform, options }) {
  const results = await installEverywhere({ env, platform });
  const version = await packagedVersion();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload(results, version), null, 2)}\n`);
    return results.length > 0 && results.every((result) => !result.ok) ? EXIT.INTERNAL : EXIT.OK;
  }
  if (results.length === 0) return noEditors();
  const named = version ? `zclaude ${version}` : "the zclaude extension";
  for (const result of results) {
    if (result.ok) success(`Installed ${named} into ${result.editor.label}.`);
    else warn(`Could not install into ${result.editor.label}: ${result.detail || "the editor reported no reason"}`);
  }
  if (results.every((result) => !result.ok)) return EXIT.INTERNAL;
  info(RELOAD);
  return EXIT.OK;
}

function payload(results, version) {
  return {
    extension: EXTENSION_ID,
    version,
    editors: results.map((result) => ({ id: result.editor.id, ok: result.ok, detail: result.detail ?? null })),
  };
}

async function cmdUninstall({ env, platform }) {
  const results = await uninstallEverywhere({ env, platform });
  if (results.length === 0) return noEditors();
  for (const result of results) {
    if (result.ok && result.removed) success(`Removed ${EXTENSION_ID} from ${result.editor.label}.`);
    else if (result.ok) info(`${result.editor.label} did not have it.`);
    else warn(`Could not remove it from ${result.editor.label}: ${result.detail || "no reason given"}`);
  }
  return EXIT.OK;
}

async function cmdStatus({ env, platform, options }) {
  const editors = await findEditors({ env, platform });
  const version = await packagedVersion();
  const states = await Promise.all(editors.map((editor) => installedVersion(editor, { env })));
  const rows = editors.map((editor, index) => ({ editor, ...states[index] }));
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          extension: EXTENSION_ID,
          packaged: version,
          vsix: vsixPath(),
          editors: rows.map(({ editor, ...state }) => ({ id: editor.id, bin: editor.bin, ...state })),
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }
  if (rows.length === 0) return noEditors();
  info(`Packaged extension: ${EXTENSION_ID} ${version ?? "unknown"} (${vsixPath()})`);
  for (const row of rows) {
    if (row.state === "installed")
      info(
        `  ${row.editor.label.padEnd(18)} ${row.version ?? "installed"}${
          version && row.version && row.version !== version ? "  (older than the packaged one)" : ""
        }`,
      );
    else if (row.state === "absent") info(`  ${row.editor.label.padEnd(18)} not installed`);
    else warn(`  ${row.editor.label.padEnd(18)} could not be asked: ${row.detail}`);
  }
  const stale = rows.some((row) => row.state === "installed" && version && row.version && row.version !== version);
  const missing = rows.some((row) => row.state === "absent");
  if (stale || missing) info("Run `zclaude vscode install` to bring them up to date.");
  return EXIT.OK;
}

/**
 * @param {{options: object, env: NodeJS.ProcessEnv}} context
 * @param {{platform?: string}} [deps]
 */
export function cmdVscodeGroup({ options, env }, { platform = process.platform } = {}) {
  const [sub] = options.args ?? [];
  if (!sub) throw usageError("`zclaude vscode` needs a subcommand.", `One of: ${VSCODE_SUBCOMMANDS.join(", ")}.`);
  const context = { env, platform, options };
  if (sub === "install") return cmdInstall(context);
  if (sub === "uninstall") return cmdUninstall(context);
  if (sub === "status") return cmdStatus(context);
  throw usageError(`\`zclaude vscode ${sub}\` is not a command.`, `One of: ${VSCODE_SUBCOMMANDS.join(", ")}.`);
}
