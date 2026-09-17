// A status bar item that switches the Claude Code account.
//
// Everything it knows comes from `zclaude ... --json`, and everything it does
// goes back through zclaude, so the credential handling has exactly one
// implementation and it is not this one.

"use strict";

const vscode = require("vscode");

const { findBinary, run, runJson, version } = require("./cli.js");
const { ACTIONS, isSupported, outdatedText, quickPickItems, statusBarText, tooltip } = require("./items.js");

let item;
let binary = null;
let found = null;
let output;

function settings() {
  return vscode.workspace.getConfiguration("zclaude");
}

function locate() {
  const next = findBinary({ setting: settings().get("path", "") });
  if (next !== binary) found = null; // a different binary is a different version
  binary = next;
  return binary;
}

/**
 * Which zclaude this is, asked once per binary. An install that predates the
 * switch answers every --json call with nothing, which would otherwise show as
 * an empty list and no reason for it.
 */
async function zclaudeVersion() {
  if (!binary) return null;
  found ??= (await version(binary)) ?? "unknown";
  return found === "unknown" ? null : found;
}

/** Offer the update rather than just refusing. */
async function reportTooOld(installed) {
  const choice = await vscode.window.showWarningMessage(outdatedText(installed), "Update zclaude");
  if (choice !== "Update zclaude") return;
  const terminal = vscode.window.createTerminal("zclaude self-update");
  terminal.show();
  terminal.sendText(`${binary} self-update`);
}

async function readStatus() {
  if (!binary) return { status: null, error: "zclaude was not found" };
  const { data, error } = await runJson(binary, ["switch", "--status"]);
  return { status: data, error };
}

async function readProfiles() {
  if (!binary) return [];
  const { data } = await runJson(binary, ["profile", "list"]);
  return Array.isArray(data) ? data : [];
}

/** Which accounts already have something running, counted by profile. */
async function readBusy() {
  if (!binary) return {};
  const { data } = await runJson(binary, ["sessions"]);
  return Array.isArray(data?.byProfile) ? Object.fromEntries(data.byProfile) : {};
}

async function readUsage(force) {
  if (!binary || !settings().get("showUsage", true)) return {};
  const { data } = await runJson(binary, ["profile", "list", "--usage", ...(force ? ["--force"] : [])]);
  if (!Array.isArray(data)) return {};
  return Object.fromEntries(data.filter((entry) => entry.usage).map((entry) => [entry.name, entry.usage]));
}

async function refreshStatusBar() {
  if (!item) return;
  if (!locate()) {
    item.hide();
    return;
  }
  const installed = await zclaudeVersion();
  const { status } = isSupported(installed) ? await readStatus() : { status: null };
  item.text = statusBarText(status, installed);
  item.tooltip = new vscode.MarkdownString(tooltip(status, null, installed));
  item.show();
}

/** The list. It opens immediately and fills in usage as answers arrive. */
async function pick(force = false) {
  if (!locate()) {
    const choice = await vscode.window.showWarningMessage(
      "zclaude was not found. Install it, or set zclaude.path.",
      "Open settings",
    );
    if (choice === "Open settings") await vscode.commands.executeCommand("workbench.action.openSettings", "zclaude");
    return;
  }
  const installed = await zclaudeVersion();
  if (!isSupported(installed)) {
    await reportTooOld(installed);
    return;
  }
  const picker = vscode.window.createQuickPick();
  picker.title = "Claude Code account";
  picker.placeholder = "Pick the account every terminal and the extension will use";
  picker.busy = true;
  picker.items = quickPickItems({ loading: true });
  picker.show();

  const [{ status }, profiles, busy] = await Promise.all([readStatus(), readProfiles(), readBusy()]);
  const active = status?.owner ?? null;
  picker.items = quickPickItems({ profiles, active, usage: {}, loading: true, busy });

  // Usage is a network call per account, so the list is usable before it lands.
  const usage = await readUsage(force);
  picker.busy = false;
  picker.items = quickPickItems({ profiles, active, usage, loading: false, busy });

  const chosen = await new Promise((resolve) => {
    picker.onDidAccept(() => resolve(picker.selectedItems[0]));
    picker.onDidHide(() => resolve(null));
  });
  picker.dispose();
  if (!chosen) return;
  await act(chosen, { profiles, active });
}

function act(chosen, { profiles, active }) {
  if (chosen.action === ACTIONS.refresh) return pick(true);
  if (chosen.action === ACTIONS.add) return addProfile();
  if (chosen.action === ACTIONS.remove) return removeProfile(profiles);
  if (chosen.action === ACTIONS.restore) return restore();
  if (!chosen.profile || chosen.profile === active) return Promise.resolve();
  return switchTo(chosen.profile, profiles);
}

async function switchTo(name, profiles) {
  const profile = profiles.find((entry) => entry.name === name);
  if (profile?.provider === "zai") {
    await vscode.window.showInformationMessage(
      `"${name}" is a Z.ai plan. Its login only reaches Claude Code through the environment, so run \`zclaude ${name}\` in a terminal.`,
    );
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Switching Claude Code to "${name}"` },
    async () => {
      const result = await run(binary, ["switch", name, "--yes"]);
      if (!result.ok) {
        log(result.stderr || result.stdout);
        await vscode.window
          .showErrorMessage(`Could not switch to "${name}". See the zclaude output for why.`, "Show")
          .then((choice) => (choice === "Show" ? output?.show() : undefined));
        return;
      }
      await refreshStatusBar();
      await vscode.window.showInformationMessage(
        `Claude Code is now signed in as "${name}". A session already running keeps its own login briefly.`,
      );
    },
  );
}

async function restore() {
  const result = await run(binary, ["switch", "--restore", "--yes"]);
  if (result.ok) {
    await refreshStatusBar();
    await vscode.window.showInformationMessage("The previous Claude Code login is back.");
    return;
  }
  log(result.stderr || result.stdout);
  await vscode.window.showErrorMessage("Nothing to restore, or the restore failed. See the zclaude output.");
}

/** Signing in needs a browser and a terminal, so this opens one. */
function addProfile() {
  const terminal = vscode.window.createTerminal("zclaude profile add");
  terminal.show();
  terminal.sendText(`${binary} profile add`);
  return Promise.resolve();
}

async function removeProfile(profiles) {
  const names = profiles.map((profile) => profile.name);
  if (names.length === 0) return;
  const name = await vscode.window.showQuickPick(names, { placeHolder: "Remove which profile?" });
  if (!name) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove "${name}"? Its login, transcripts and settings are deleted. Shared items are left alone.`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") return;
  const result = await run(binary, ["profile", "remove", name, "--yes"]);
  if (!result.ok) log(result.stderr || result.stdout);
  await refreshStatusBar();
}

function log(text) {
  output ??= vscode.window.createOutputChannel("zclaude");
  output.appendLine(text.trimEnd());
}

function activate(context) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "zclaude.pick";
  item.text = "$(account) zc";
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand("zclaude.pick", () => pick(false)),
    vscode.commands.registerCommand("zclaude.refresh", () => pick(true)),
    vscode.window.onDidChangeWindowState((state) => (state.focused ? refreshStatusBar() : undefined)),
  );
  refreshStatusBar().catch(() => {});
}

function deactivate() {
  item?.dispose();
  output?.dispose();
}

module.exports = { activate, deactivate };
