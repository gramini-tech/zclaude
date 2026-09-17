// The extension's activation path, against a hand-written `vscode`.
//
// This is a smoke test with teeth: it drives the real extension.js through
// activation, opens the picker, chooses a profile and checks that the command
// it ran is the one zclaude implements. What it cannot check is how VS Code
// itself renders any of it.

import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);

/** Let the extension's pending promises run. */
const settle = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Just enough VS Code, recording what the extension did with it. */
function stubVscode() {
  const recorded = { messages: [], terminals: [], commands: new Map(), pickers: [], progress: [] };
  const disposable = () => ({ dispose() {} });
  const statusBar = { text: "", tooltip: null, command: null, shown: false, show() {}, hide() {}, dispose() {} };
  statusBar.show = () => {
    statusBar.shown = true;
  };
  statusBar.hide = () => {
    statusBar.shown = false;
  };

  function createQuickPick() {
    const picker = {
      title: "",
      placeholder: "",
      busy: false,
      items: [],
      selectedItems: [],
      shown: false,
      snapshots: [],
      onDidAccept(handler) {
        picker.accept = handler;
      },
      onDidHide(handler) {
        picker.hide = handler;
      },
      show() {
        picker.shown = true;
      },
      dispose() {},
    };
    // Remember every list the extension set, so the test can assert that the
    // rows appeared before the usage did.
    Object.defineProperty(picker, "items", {
      get: () => picker.current ?? [],
      set: (value) => {
        picker.current = value;
        picker.snapshots.push({ busy: picker.busy, rows: value.length });
      },
    });
    recorded.pickers.push(picker);
    return picker;
  }

  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    MarkdownString: class {
      constructor(value) {
        this.value = value;
      }
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => (key === "path" ? "/fake/zclaude" : fallback) }),
    },
    window: {
      statusBar,
      createStatusBarItem: () => statusBar,
      createQuickPick,
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createTerminal: (name) => {
        const terminal = {
          name,
          sent: [],
          show() {},
          sendText(text) {
            terminal.sent.push(text);
          },
        };
        recorded.terminals.push(terminal);
        return terminal;
      },
      showInformationMessage: async (text) => {
        recorded.messages.push(text);
      },
      showWarningMessage: async (text) => {
        recorded.messages.push(text);
      },
      showErrorMessage: async (text) => {
        recorded.messages.push(text);
      },
      showQuickPick: async (choices) => choices[0],
      withProgress: async (options, task) => {
        recorded.progress.push({ options, open: true });
        const entry = recorded.progress.at(-1);
        try {
          return await task();
        } finally {
          entry.open = false;
        }
      },
      onDidChangeWindowState: () => disposable(),
    },
    commands: {
      registerCommand: (name, handler) => {
        recorded.commands.set(name, handler);
        return disposable();
      },
      executeCommand: async () => {},
    },
  };
  return { vscode, recorded };
}

/**
 * Load extension.js with `vscode` and `zclaude` both faked. Everything is
 * loaded fresh each time: the module keeps per-window state.
 */
function loadExtension(answers) {
  const { vscode, recorded } = stubVscode();
  const cliPath = require.resolve("../extension/src/cli.js");
  const extensionPath = require.resolve("../extension/src/extension.js");
  // eslint-disable-next-line security/detect-non-literal-require -- a path this file resolved
  const cli = require(cliPath);
  const ran = [];
  const fake = {
    ...cli,
    findBinary: () => (answers.binary === null ? null : "/fake/zclaude"),
    version: async () => answers.version ?? "9.9.9",
    run: async (binary, args) => {
      ran.push(args);
      return answers.run?.(args) ?? { ok: true, code: 0, stdout: "", stderr: "" };
    },
    runJson: async (binary, args) => ({ data: answers.json?.(args) ?? null, error: null }),
  };

  const original = Module._load;
  Module._load = (request, parent, isMain) => {
    if (request === "vscode") return vscode;
    if (request === "./cli.js" && parent?.filename === extensionPath) return fake;
    return original(request, parent, isMain);
  };
  try {
    delete require.cache[extensionPath];
    // eslint-disable-next-line security/detect-non-literal-require -- see above
    return { extension: require(extensionPath), vscode, recorded, ran };
  } finally {
    Module._load = original;
    delete require.cache[extensionPath];
  }
}

const PROFILES = [
  { name: "work", provider: "anthropic", account: "a@work.com" },
  { name: "home", provider: "anthropic", account: "a@home.com" },
  { name: "chinese", provider: "zai", account: null },
];

const answers = (extra = {}) => ({
  json: (args) => {
    if (args[0] === "switch") return { owner: "work", account: { email: "a@work.com" } };
    if (args[0] === "profile" && args.includes("--usage"))
      return PROFILES.map((profile) => ({ ...profile, usage: { state: "ok", fiveHour: { pct: 5 }, weekly: null } }));
    if (args[0] === "profile") return PROFILES;
    return null;
  },
  ...extra,
});

/** Open the picker, pick the row matching `choose`, and wait for the work. */
async function pickAndChoose(loaded, choose) {
  const opening = loaded.recorded.commands.get("zclaude.pick")();
  await settle();
  await settle();
  const [picker] = loaded.recorded.pickers;
  const row = picker.current.find(choose);
  assert.ok(row, "no such row in the picker");
  picker.selectedItems = [row];
  picker.accept();
  await opening;
  return picker;
}

describe("the extension in a window", () => {
  it("puts the signed-in account in the status bar on activation", async () => {
    const loaded = loadExtension(answers());
    const subscriptions = [];
    loaded.extension.activate({ subscriptions });
    await settle();
    assert.match(loaded.vscode.window.statusBar.text, /^zc /u);
    assert.equal(loaded.vscode.window.statusBar.command, "zclaude.pick");
    assert.ok(loaded.vscode.window.statusBar.shown);
    assert.equal(subscriptions.length, 4, "the item, two commands and the focus listener");
    loaded.extension.deactivate();
  });

  it("registers both commands under the names the manifest declares", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    const manifest = require("../extension/package.json");
    for (const command of manifest.contributes.commands) {
      assert.ok(loaded.recorded.commands.has(command.command), `${command.command} was never registered`);
    }
  });

  it("shows the list before the usage arrives, then fills it in", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    const picker = await pickAndChoose(loaded, (row) => row.profile === "home");
    assert.ok(picker.shown, "the picker was never shown");
    assert.ok(picker.snapshots.length >= 2, "the list was set once and never updated");
    assert.equal(picker.snapshots[0].busy, true, "it should say it is working while usage loads");
    assert.equal(picker.snapshots.at(-1).busy, false);
  });

  it("switches to the profile that was picked, without asking again", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.profile === "home");
    assert.deepEqual(loaded.ran, [["switch", "home", "--yes"]]);
    assert.match(loaded.recorded.messages.at(-1), /signed in as "home"/u);
  });

  // The bug this replaces: the success notification was awaited inside
  // withProgress, and showInformationMessage resolves when the notification is
  // dismissed — so "Switching Claude Code to max" stayed on screen until the
  // person clicked the message away, long after the switch had finished.
  it("closes the progress before it says anything, not after", async () => {
    const loaded = loadExtension(answers());
    // A notification nobody ever dismisses, which is the pathological case: the
    // old code awaited this inside withProgress and never came back.
    loaded.vscode.window.showInformationMessage = (text) => {
      loaded.recorded.messages.push(text);
      return new Promise(() => {});
    };
    loaded.extension.activate({ subscriptions: [] });
    // Bounded, so a regression fails here rather than hanging the run.
    const done = await Promise.race([
      pickAndChoose(loaded, (row) => row.profile === "home").then(() => "finished"),
      new Promise((resolve) => {
        setTimeout(() => resolve("still waiting"), 500).unref?.();
      }),
    ]);
    assert.equal(done, "finished", "the switch is still waiting for somebody to dismiss a notification");
    const progress = loaded.recorded.progress.at(-1);
    assert.ok(progress, "the switch reported no progress at all");
    assert.equal(progress.open, false, "the progress is still up while a message waits to be dismissed");
    assert.match(loaded.recorded.messages.at(-1), /signed in as "home"/u);
  });

  it("reports progress where a sub-second job belongs, not in a popup", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.profile === "home");
    const { options } = loaded.recorded.progress.at(-1);
    assert.equal(options.location, loaded.vscode.ProgressLocation.Window);
    assert.match(options.title, /switching to home/u);
  });

  it("does nothing when the profile picked is the one already signed in", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.profile === "work");
    assert.deepEqual(loaded.ran, []);
  });

  it("refuses to switch a Z.ai profile, and says where to run it instead", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.profile === "chinese");
    assert.deepEqual(loaded.ran, []);
    assert.match(loaded.recorded.messages.at(-1), /run `zclaude chinese` in a terminal/u);
  });

  it("opens a terminal to add a profile, because signing in needs one", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.label.includes("Add a profile"));
    assert.deepEqual(loaded.recorded.terminals[0].sent, ["/fake/zclaude profile add"]);
    assert.deepEqual(loaded.ran, [], "nothing was run behind the terminal");
  });

  it("restores the previous login on request", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.label.includes("Restore"));
    assert.deepEqual(loaded.ran[0], ["switch", "--restore", "--yes"]);
  });

  it("removes a profile only after the confirmation is accepted", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    // showWarningMessage returns undefined in the stub, which is the modal
    // being dismissed.
    await pickAndChoose(loaded, (row) => row.label.includes("Remove a profile"));
    assert.deepEqual(loaded.ran, [], "a dismissed confirmation must not delete anything");
  });

  it("reports a failed switch instead of claiming it worked", async () => {
    const loaded = loadExtension(
      answers({ run: () => ({ ok: false, code: 1, stdout: "", stderr: "the Keychain is locked" }) }),
    );
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.profile === "home");
    assert.match(loaded.recorded.messages.at(-1), /Could not switch to "home"/u);
    assert.doesNotMatch(loaded.recorded.messages.join("\n"), /signed in as/u);
  });

  it("removes a profile once the confirmation is accepted", async () => {
    const loaded = loadExtension(answers());
    // The modal's own button, which the stub otherwise dismisses.
    loaded.vscode.window.showWarningMessage = async (text, options, action) => action;
    loaded.extension.activate({ subscriptions: [] });
    await pickAndChoose(loaded, (row) => row.label.includes("Remove a profile"));
    assert.deepEqual(loaded.ran, [["profile", "remove", "work", "--yes"]]);
  });

  it("offers the settings when it cannot find zclaude at all", async () => {
    const loaded = loadExtension({ ...answers(), binary: null });
    loaded.extension.activate({ subscriptions: [] });
    await loaded.recorded.commands.get("zclaude.pick")();
    assert.equal(loaded.recorded.pickers.length, 0, "an empty picker helps nobody");
    assert.match(loaded.recorded.messages.at(-1), /zclaude was not found/u);
  });

  it("marks the status bar and offers the update when zclaude is too old", async () => {
    const loaded = loadExtension({ ...answers(), version: "0.2.14" });
    loaded.extension.activate({ subscriptions: [] });
    await settle();
    assert.equal(loaded.vscode.window.statusBar.text, "zc $(warning)");
    await loaded.recorded.commands.get("zclaude.pick")();
    assert.equal(loaded.recorded.pickers.length, 0, "an old zclaude answers every call with nothing");
    assert.match(loaded.recorded.messages.at(-1), /zclaude 0\.2\.14 is older than/u);
  });

  it("runs self-update in a terminal when that offer is accepted", async () => {
    const loaded = loadExtension({ ...answers(), version: "0.2.14" });
    loaded.vscode.window.showWarningMessage = async (text, action) => action;
    loaded.extension.activate({ subscriptions: [] });
    await settle();
    await loaded.recorded.commands.get("zclaude.pick")();
    assert.deepEqual(loaded.recorded.terminals[0].sent, ["/fake/zclaude self-update"]);
  });

  // The bug this replaces: the item was shown only after two subprocess calls
  // and never on an error path, so a machine where either failed got no status
  // bar item at all and nothing to click to find out why.
  it("is on screen before it has asked zclaude anything", () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    assert.equal(loaded.vscode.window.statusBar.shown, true, "shown synchronously, not after the first await");
    assert.equal(loaded.vscode.window.statusBar.text, "zc");
  });

  it("stays on screen, saying so, when zclaude cannot be found", async () => {
    const loaded = loadExtension({ ...answers(), binary: null });
    loaded.extension.activate({ subscriptions: [] });
    await settle();
    assert.equal(loaded.vscode.window.statusBar.shown, true, "a missing item leaves nothing to diagnose");
    assert.match(loaded.vscode.window.statusBar.text, /warning/u);
    assert.match(loaded.vscode.window.statusBar.tooltip.value, /was not found/u);
  });

  it("stays on screen when asking zclaude fails outright", async () => {
    const loaded = loadExtension({
      ...answers(),
      json: () => {
        throw new Error("the Keychain said no");
      },
    });
    loaded.extension.activate({ subscriptions: [] });
    await settle();
    await settle();
    assert.equal(loaded.vscode.window.statusBar.shown, true);
    assert.match(loaded.vscode.window.statusBar.text, /warning/u);
  });
});
