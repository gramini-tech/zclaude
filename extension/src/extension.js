// A status bar item that switches the Claude Code account.
//
// Everything it knows comes from `zclaude ... --json`, and everything it does
// goes back through zclaude, so the credential handling has exactly one
// implementation and it is not this one.

"use strict";

const vscode = require("vscode");

const { findBinary, run, runJson, version } = require("./cli.js");
const { ACTIONS, hoverPanel, isSupported, outdatedText, quickPickItems, statusBarText } = require("./items.js");

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

/**
 * Update the item's text. It is already on screen by the time this runs, and it
 * stays there whatever happens here.
 *
 * An earlier version called show() only after asking zclaude for its version
 * and its status, and swallowed any error on the way — so a machine where
 * either call failed got no status bar item at all and no way to find out why.
 * A badge that says something is wrong beats one that is not there.
 */
/** A hover that may carry theme icons and command links, which a plain one may not. */
function panel(markdown) {
  const text = new vscode.MarkdownString(markdown);
  text.supportThemeIcons = true;
  // Only for the command: links this extension writes into its own hover.
  text.isTrusted = true;
  return text;
}

async function refreshStatusBar() {
  if (!item) return;
  item.show();
  if (!locate()) {
    item.text = "zc $(warning)";
    item.tooltip = new vscode.MarkdownString(
      ["**zclaude** was not found.", "", "Install it, or set `zclaude.path`.", "", "Click for the settings."].join(
        "\n",
      ),
    );
    return;
  }
  try {
    const installed = await zclaudeVersion();
    if (!isSupported(installed)) {
      item.text = statusBarText(null, installed);
      item.tooltip = panel(hoverPanel({ status: null, version: installed }));
      return;
    }
    const { status, error } = await readStatus();
    if (error) log(`zclaude switch --status: ${error}`);
    item.text = statusBarText(status, installed);
    // The hover carries the whole table, so it needs what the picker needs.
    // All of it is cached by zclaude for a minute, which is why this can run on
    // every window focus without becoming a network call each time.
    const [profiles, usage, busy] = await Promise.all([readProfiles(), readUsage(false), readBusy()]);
    item.tooltip = panel(hoverPanel({ status, profiles, usage, busy, version: installed }));
  } catch (error) {
    // Whatever went wrong, the item stays, saying so.
    log(`could not read the account: ${error.message}`);
    item.text = "zc $(warning)";
    item.tooltip = panel(
      ["**zclaude** could not be asked which account is signed in.", "", "See the zclaude output channel."].join("\n"),
    );
  }
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
    tell(
      `"${name}" is a Z.ai plan. Its login only reaches Claude Code through the environment, so run \`zclaude ${name}\` in a terminal.`,
    );
    return;
  }
  // Window rather than Notification: the switch takes well under a second, and
  // a notification that pops up and vanishes for that is noise. Nothing that
  // waits on a person goes inside — see tell().
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `zclaude: switching to ${name}` },
    () => run(binary, ["switch", name, "--yes"]),
  );
  if (!result.ok) {
    log(result.stderr || result.stdout);
    const choice = await vscode.window.showErrorMessage(`Could not switch to "${name}".`, "Show why");
    if (choice === "Show why") output?.show();
    return;
  }
  await refreshStatusBar();
  tell(`Claude Code is now signed in as "${name}". A session already running keeps its own login briefly.`);
}

async function restore() {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "zclaude: restoring the previous login" },
    () => run(binary, ["switch", "--restore", "--yes"]),
  );
  if (result.ok) {
    await refreshStatusBar();
    tell("The previous Claude Code login is back.");
    return;
  }
  log(result.stderr || result.stdout);
  tell("Nothing to restore, or the restore failed. See the zclaude output.", "error");
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

/**
 * Say something, without waiting to be acknowledged.
 *
 * showInformationMessage resolves when the notification is dismissed, not when
 * it appears. Awaiting one inside withProgress held the progress notification
 * open until the person clicked the message away — reported as a stuck
 * "Switching Claude Code to max" long after the switch had finished.
 */
function tell(message, kind = "info") {
  const show = kind === "error" ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
  Promise.resolve(show(message)).catch(() => {});
}

function log(text) {
  output ??= vscode.window.createOutputChannel("zclaude");
  output.appendLine(text.trimEnd());
}

function activate(context) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "zclaude.pick";
  item.name = "zclaude account";
  item.text = "zc";
  item.tooltip = "zclaude — click to switch the Claude Code account";
  // Visible before anything is asked of the disk or of zclaude. Nothing below
  // this line is allowed to decide whether the item exists.
  item.show();
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
