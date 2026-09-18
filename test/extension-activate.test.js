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
  const recorded = { messages: [], terminals: [], commands: new Map(), picks: [], progress: [] };
  const disposable = () => ({ dispose() {} });
  const statusBar = { text: "", tooltip: null, command: null, shown: false, show() {}, hide() {}, dispose() {} };
  statusBar.show = () => {
    statusBar.shown = true;
  };
  statusBar.hide = () => {
    statusBar.shown = false;
  };

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
      showQuickPick: async (choices, options) => {
        recorded.picks.push({ choices, options });
        const { answer } = recorded;
        recorded.answer = null;
        return answer ? answer(choices) : choices[0];
      },
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
  // Recorded separately: `run` is for things that change something, `runJson`
  // for things that only ask, and a test usually cares which it was.
  const asked = [];
  const fake = {
    ...cli,
    findBinary: () => (answers.binary === null ? null : "/fake/zclaude"),
    version: async () => answers.version ?? "9.9.9",
    run: async (binary, args) => {
      ran.push(args);
      return answers.run?.(args) ?? { ok: true, code: 0, stdout: "", stderr: "" };
    },
    runJson: async (binary, args) => {
      asked.push(args);
      // Mirrors the real one: a command that failed with nothing on stdout is
      // an error rather than a null answer, which is the difference between
      // "no account has room" and "your zclaude is too old".
      const failed = answers.run?.(args);
      if (failed && !failed.ok && !failed.stdout) return { data: null, error: failed.stderr };
      return { data: answers.json?.(args) ?? null, error: null };
    },
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
    return { extension: require(extensionPath), vscode, recorded, ran, asked };
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
    if (args[0] === "auto" && args[1] === "attach") return { id: "lease-1", kind: "vscode", grants: ["watch"] };
    if (args[0] === "auto" && args[1] === "pick")
      return { profile: "home", reason: "starting on the emptiest account" };
    if (args[0] === "auto") return { running: false, decision: { action: "switch", target: "home" } };
    return null;
  },
  ...extra,
});

/** Click the status bar item, choosing the entry `choose` matches. */
async function click(loaded, choose = (items) => items[0]) {
  loaded.recorded.answer = choose;
  await loaded.recorded.commands.get("zclaude.pick")();
  return loaded.recorded.picks.at(-1);
}

/** The hover the status bar item is carrying right now. */
function hover(loaded) {
  return loaded.vscode.window.statusBar.tooltip?.value ?? "";
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
    assert.equal(subscriptions.length, 10, "the item, eight commands and the focus listener");
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

  it("carries the whole picture in the hover, not in the list", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await settle();
    await settle();
    assert.match(hover(loaded), /<table>/u, "the hover holds the table");
    assert.match(hover(loaded), /background-color:/u, "and the bars are drawn in it");
    const picked = await click(loaded, (items) => items.find((item) => item.name === "home"));
    // The list is names and accounts. Usage in it either cannot render or is
    // clipped, which is what the hover exists to avoid. The one detail a row
    // may carry is why it cannot be picked, and that is not usage.
    const details = picked.choices.filter((item) => item.name && item.detail).map((item) => item.detail);
    assert.ok(
      details.every((detail) => detail.startsWith("$(circle-slash)")),
      `no account row carries usage of its own, only refusals: ${details.join(" | ")}`,
    );
  });

  it("switches to the profile that was picked, without asking again", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await click(loaded, (items) => items.find((item) => item.name === "home"));
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
      click(loaded, (items) => items.find((item) => item.name === "home")).then(() => "finished"),
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
    await click(loaded, (items) => items.find((item) => item.name === "home"));
    const { options } = loaded.recorded.progress.at(-1);
    assert.equal(options.location, loaded.vscode.ProgressLocation.Window);
    assert.match(options.title, /switching to home/u);
  });

  it("does nothing when the profile picked is the one already signed in", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await click(loaded, (items) => items.find((item) => item.name === "work"));
    assert.deepEqual(loaded.ran, []);
  });

  it("holds a lease for its own process, and gives it up on the way out", async () => {
    // The lease belongs to the extension host, not to the short-lived zclaude
    // that records it — without the pid it would be reaped on the next read.
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await settle();
    await settle();
    const attach = loaded.asked.find((args) => args[0] === "auto" && args[1] === "attach");
    assert.ok(attach, `no attach among ${JSON.stringify(loaded.asked)}`);
    assert.equal(attach[2], "vscode", "a window may only ask it to watch");
    assert.equal(attach.at(-2), "--pid");
    assert.equal(attach.at(-1), String(process.pid));

    loaded.extension.deactivate();
    await settle();
    assert.ok(
      loaded.ran.some((args) => args[1] === "detach"),
      "dropped politely, though the lease would expire on its own anyway",
    );
  });

  it("offers Auto as a row, and picking it switches to the account with the most room", async () => {
    // The same choice as picking a profile, said differently: "whichever has
    // the most room" instead of naming one. A setting somewhere else would have
    // made it a mode, which is the shape this used to have and the reason
    // nothing in the editor did anything.
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    const picked = await click(loaded, (items) => items.find((item) => item.action === "auto"));
    const row = picked.choices.find((item) => item.action === "auto");
    assert.match(row.label, /Auto/u);
    assert.match(row.description, /would use home/u, "it says which account before you pick it");
    assert.deepEqual(loaded.ran, [["switch", "home", "--yes"]]);
  });

  it("says what zclaude actually said when Auto cannot choose", async () => {
    // The failure that sent me looking: an installed zclaude too old to have
    // `auto pick` answered with an error, and the extension reported "no
    // account could be chosen" — blaming the accounts for a version mismatch.
    const loaded = loadExtension(
      answers({
        json: (args) => {
          if (args[0] === "switch") return { owner: "work" };
          if (args[0] === "profile") return PROFILES;
          return null; // as an older zclaude answers a command it does not have
        },
        run: (args) =>
          args[1] === "pick"
            ? { ok: false, code: 2, stdout: "", stderr: "`zclaude auto pick` is not a command." }
            : { ok: true, code: 0, stdout: "", stderr: "" },
      }),
    );
    loaded.extension.activate({ subscriptions: [] });
    await loaded.recorded.commands.get("zclaude.auto")();
    assert.match(loaded.recorded.messages.at(-1), /is not a command/u);
    assert.ok(
      loaded.ran.every((args) => args[0] !== "switch"),
      "and nothing is switched on the strength of a failed lookup",
    );
  });

  it("marks a Z.ai row as unpickable before it is picked, and refuses it if it is", async () => {
    // It used to accept the pick and explain afterwards, with three layers
    // below the list refusing the same thing again. Safe, and still wrong: a
    // list should not offer what it knows will be turned down.
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    const picked = await click(loaded, (items) => items.find((item) => item.name === "chinese"));
    const row = picked.choices.find((item) => item.name === "chinese");
    assert.match(row.detail, /endpoint and a key/u, "the row says why before you pick it");
    assert.deepEqual(loaded.ran, [], "and picking it runs nothing");
    assert.match(loaded.recorded.messages.at(-1), /cannot hold the global login/u);
  });

  it("opens a terminal to add a profile, because signing in needs one", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await click(loaded, (items) => items.find((item) => item.action === "add"));
    assert.deepEqual(loaded.recorded.terminals[0].sent, ["/fake/zclaude profile add"]);
    assert.deepEqual(loaded.ran, [], "nothing was run behind the terminal");
  });

  it("restores the previous login on request", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    await click(loaded, (items) => items.find((item) => item.action === "restore"));
    assert.deepEqual(loaded.ran[0], ["switch", "--restore", "--yes"]);
  });

  it("removes a profile only after the confirmation is accepted", async () => {
    const loaded = loadExtension(answers());
    loaded.extension.activate({ subscriptions: [] });
    // showWarningMessage returns undefined in the stub, which is the modal
    // being dismissed.
    await click(loaded, (items) => items.find((item) => item.action === "remove"));
    assert.deepEqual(loaded.ran, [], "a dismissed confirmation must not delete anything");
  });

  it("reports a failed switch instead of claiming it worked", async () => {
    const loaded = loadExtension(
      // Only the switch fails; the reads that build the list still answer.
      answers({
        run: (args) =>
          args[0] === "switch"
            ? { ok: false, code: 1, stdout: "", stderr: "the Keychain is locked" }
            : { ok: true, code: 0, stdout: "", stderr: "" },
      }),
    );
    loaded.extension.activate({ subscriptions: [] });
    await click(loaded, (items) => items.find((item) => item.name === "home"));
    assert.match(loaded.recorded.messages.at(-1), /Could not switch to "home"/u);
    assert.doesNotMatch(loaded.recorded.messages.join("\n"), /signed in as/u);
  });

  it("removes a profile once the confirmation is accepted", async () => {
    const loaded = loadExtension(answers());
    // The modal's own button, which the stub otherwise dismisses.
    loaded.vscode.window.showWarningMessage = async (text, options, action) => action;
    loaded.extension.activate({ subscriptions: [] });
    await click(loaded, (items) => items.find((item) => item.action === "remove"));
    assert.deepEqual(loaded.ran, [["profile", "remove", "work", "--yes"]]);
  });

  it("offers the settings when it cannot find zclaude at all", async () => {
    const loaded = loadExtension({ ...answers(), binary: null });
    loaded.extension.activate({ subscriptions: [] });
    await loaded.recorded.commands.get("zclaude.pick")();
    assert.equal(loaded.recorded.picks.length, 0, "an empty list helps nobody");
    assert.match(loaded.recorded.messages.at(-1), /zclaude was not found/u);
  });

  it("marks the status bar and offers the update when zclaude is too old", async () => {
    const loaded = loadExtension({ ...answers(), version: "0.2.14" });
    loaded.extension.activate({ subscriptions: [] });
    await settle();
    assert.equal(loaded.vscode.window.statusBar.text, "zc $(warning)");
    await loaded.recorded.commands.get("zclaude.pick")();
    assert.equal(loaded.recorded.picks.length, 0, "an old zclaude answers every call with nothing");
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
