// The VS Code extension's own logic: turning zclaude's JSON into a list, and
// finding the binary to ask.
//
// extension/src is CommonJS and imports `vscode`, which only exists inside the
// editor. The two modules under test here deliberately do not import it, so
// they load with a plain require. The third, extension.js, is plumbing over
// these and is exercised by hand in VS Code rather than faked here.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { tempHome } from "./helpers.js";

const require = createRequire(import.meta.url);
const items = require("../extension/src/items.js");
const cli = require("../extension/src/cli.js");

const profile = (name, extra = {}) => ({ name, provider: "anthropic", account: `${name}@example.com`, ...extra });
const usage = (fiveHour, weekly, scoped = []) => ({
  state: "ok",
  fiveHour: { pct: fiveHour },
  weekly: { pct: weekly },
  scoped,
});

describe("the picker's contents", () => {
  it("puts a tick on the active profile and the account beside each one", () => {
    const rows = items.quickPickItems({ profiles: [profile("work"), profile("home")], active: "home" });
    assert.match(rows[0].label, /^\$\(blank\) work$/u);
    assert.match(rows[1].label, /^\$\(check\) home$/u);
    assert.equal(rows[1].description, "home@example.com");
    assert.equal(rows[1].picked, true);
    assert.equal(rows[1].switchable, false, "the active one is not worth switching to");
  });

  it("always offers refresh, add, remove and restore, after a separator", () => {
    const rows = items.quickPickItems({ profiles: [profile("work")] });
    const actions = rows.filter((row) => row.action).map((row) => row.action);
    assert.deepEqual(actions, [items.ACTIONS.refresh, items.ACTIONS.add, items.ACTIONS.remove, items.ACTIONS.restore]);
    assert.equal(rows[1].kind, -1, "a separator sits between the profiles and the actions");
  });

  it("offers them even with no profiles at all, so a first one can be added", () => {
    const rows = items.quickPickItems({});
    assert.ok(rows.some((row) => row.action === items.ACTIONS.add));
  });

  it("shows a spinner on a row whose numbers have not arrived", () => {
    const [row] = items.quickPickItems({ profiles: [profile("work")], loading: true });
    assert.match(row.detail, /checking usage/u);
  });

  it("shows the numbers once they have", () => {
    const [row] = items.quickPickItems({
      profiles: [profile("work")],
      usage: { work: usage(12, 61, [{ name: "Fable", pct: 91 }]) },
    });
    assert.equal(row.detail, "5h 12% · wk 61% · Fable 91%");
  });

  it("marks a Z.ai profile as not switchable, because its login is an environment", () => {
    const [row] = items.quickPickItems({ profiles: [profile("chinese", { provider: "zai", account: null })] });
    assert.equal(row.switchable, false);
    assert.equal(row.description, "Z.ai coding plan");
  });

  it("does not repeat zclaude's 'signed out' for a Z.ai profile, which has no Anthropic login", () => {
    const [row] = items.quickPickItems({
      profiles: [profile("chinese", { provider: "zai", account: "signed out" })],
    });
    assert.equal(row.description, "Z.ai coding plan");
  });
});

describe("an account that is already busy", () => {
  it("says how many and whether they are doing anything", () => {
    assert.match(items.busyText({ working: 2, idle: 0, unknown: 0, total: 2 }), /2 running/u);
    assert.match(items.busyText({ working: 1, idle: 0, unknown: 0, total: 1 }), /\brunning\b/u);
    assert.match(items.busyText({ working: 0, idle: 1, unknown: 0, total: 1 }), /\bidle\b/u);
    assert.match(items.busyText({ working: 0, idle: 0, unknown: 3, total: 3 }), /3 open/u);
  });

  it("says nothing about an account nobody is using", () => {
    assert.equal(items.busyText(undefined), "");
    assert.equal(items.busyText({ working: 0, idle: 0, unknown: 0, total: 0 }), "");
  });

  it("puts it beside the account, where the choice is made", () => {
    const [row] = items.quickPickItems({
      profiles: [profile("work")],
      busy: { work: { working: 1, idle: 0, unknown: 0, total: 1 } },
    });
    assert.match(row.description, /work@example\.com {2}· {2}\$\(circle-filled\) running/u);
  });
});

describe("usage as a line", () => {
  it("says why there are no numbers rather than leaving a blank", () => {
    assert.equal(items.usageText({ state: "unauthorized" }), "sign in to see usage");
    assert.equal(items.usageText({ state: "dead" }), "login expired");
    assert.equal(items.usageText({ state: "throttled" }), "usage rate limited");
    assert.equal(items.usageText({ state: "offline" }), "usage unavailable");
  });

  it("marks cached numbers as cached", () => {
    assert.equal(items.usageText({ ...usage(3, 4), state: "stale" }), "5h 3% · wk 4% (cached)");
  });

  it("rounds, because a percentage with decimals reads as noise", () => {
    assert.equal(items.usageText(usage(12.4, 60.6)), "5h 12% · wk 61%");
  });

  it("is empty when there is nothing to say", () => {
    assert.equal(items.usageText(null), "");
    assert.equal(items.usageText({ state: "ok", fiveHour: null, weekly: null, scoped: [] }), "");
  });
});

describe("which zclaude it needs", () => {
  it("compares versions numerically, not as strings", () => {
    assert.equal(items.compareVersions("0.2.10", "0.2.9"), 1, "0.2.10 is newer than 0.2.9");
    assert.equal(items.compareVersions("0.2.18", "0.2.18"), 0);
    assert.equal(items.compareVersions("0.3", "0.2.99"), 1);
    assert.equal(items.compareVersions("1.0.0", "0.9.9"), 1);
  });

  it("accepts the minimum and anything above it", () => {
    assert.equal(items.isSupported(items.MINIMUM_ZCLAUDE), true);
    assert.equal(items.isSupported("9.9.9"), true);
    assert.equal(items.isSupported("0.2.14"), false, "0.2.14 predates `switch`");
    assert.equal(items.isSupported(null), false);
  });

  it("names the version it found, so the message is actionable", () => {
    assert.match(items.outdatedText("0.2.14"), /zclaude 0\.2\.14 is older than 0\.\d+\.\d+/u);
    assert.match(items.outdatedText(null), /needs zclaude 0\.\d+\.\d+ or newer/u);
  });

  it("marks the status bar and the hover rather than showing a wrong account", () => {
    assert.equal(items.statusBarText({ account: { email: "a@b.com" } }, "0.2.14"), "zc $(warning)");
    assert.match(items.tooltip(null, null, "0.2.14"), /older than/u);
    // Without a version the checks stay out of the way, which is what every
    // other caller wants.
    assert.equal(items.statusBarText({ account: { email: "a@b.com" } }), "zc $(account) a");
  });
});

describe("the status bar", () => {
  // Reported: the item read "$(account) vipinr", which in a row of other
  // people's icons looks like somebody's username and says nothing about which
  // extension put it there.
  it("says whose extension it is before it says whose account", () => {
    const text = items.statusBarText({ account: { email: "vipinr@gramini.com" } });
    assert.ok(text.startsWith("zc "), `"${text}" does not identify itself`);
    assert.match(text, /vipinr$/u, "the local part of the address still fits");
  });

  it("falls back to the bare name when nobody is signed in or nothing is known", () => {
    assert.equal(items.statusBarText(null), "zc");
    assert.match(items.statusBarText({ account: null }), /^zc\b/u);
  });

  it("marks a credential it could not read, rather than claiming nobody is signed in", () => {
    assert.equal(items.statusBarText({ unreadable: "the Keychain is locked" }), "zc $(warning)");
  });

  it("puts the account, its organization and the profile in the tooltip", () => {
    const text = items.tooltip(
      { account: { email: "a@b.com", organization: "Acme" }, owner: "work" },
      usage(1, 2, [{ name: "Fable", pct: 3 }]),
    );
    assert.match(text, /a@b\.com · Acme/u);
    assert.match(text, /Profile: `work`/u);
    // The hover has room, so each window is spelled out rather than compressed.
    assert.match(text, /- 5 hours 1%/u);
    assert.match(text, /- week 2%/u);
    assert.match(text, /- Fable week 3%/u);
  });

  it("says so plainly when the credential could not be read", () => {
    assert.match(items.tooltip({ unreadable: "the Keychain is locked" }, null), /could not be read: the Keychain/u);
    assert.match(items.tooltip(null, null), /Nobody is signed in/u);
  });
});

describe("when a window comes back", () => {
  const NOW = Date.parse("2026-09-17T12:00:00Z");
  const at = (ms) => NOW + ms;

  it("counts down in the units that matter at that distance", () => {
    assert.equal(items.countdown(at(30_000), NOW), "now");
    assert.equal(items.countdown(at(45 * 60_000), NOW), "45m");
    assert.equal(items.countdown(at(2 * 3_600_000 + 8 * 60_000), NOW), "2h 8m");
    assert.equal(items.countdown(at(6 * 86_400_000 + 7 * 3_600_000), NOW), "6d 7h");
  });

  it("says nothing about a reset already past, rather than counting down to yesterday", () => {
    assert.equal(items.countdown(at(-60 * 60_000), NOW), "");
    assert.equal(items.countdown(null, NOW), "");
    assert.equal(items.countdown(undefined, NOW), "");
  });

  it("puts the clock on a window near its ceiling and leaves a quiet one alone", () => {
    const pressed = {
      state: "ok",
      fiveHour: { pct: 78, resetsAt: at(2 * 3_600_000) },
      weekly: { pct: 4, resetsAt: at(6 * 86_400_000) },
      scoped: [],
    };
    assert.equal(items.usageText(pressed, NOW), "5h 78% ⟳2h · wk 4%");
  });

  it("converts to local time, which is the point of converting at all", () => {
    // Asserted through the formatter rather than against a fixed string: the
    // machine's zone is what it renders in, and a test that pinned one would
    // pass only where it was written.
    const expected = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at(3_600_000));
    assert.equal(items.localTime(at(3_600_000), NOW), expected);
    assert.match(items.localTime(at(3 * 86_400_000), NOW), /,/u, "a date further out carries its day");
  });

  it("spells every window out for the hover", () => {
    const lines = items.usageLines(
      { state: "ok", fiveHour: { pct: 78, resetsAt: at(2 * 3_600_000) }, weekly: null, scoped: [] },
      NOW,
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^5 hours 78% — resets in 2h \(/u);
  });
});

describe("credits", () => {
  it("shows what is left when the account has them switched on", () => {
    assert.equal(items.creditsText({ enabled: true, remaining: 12.5, currency: "USD" }), "credits $12.50 left");
    assert.equal(items.creditsText({ enabled: true, remaining: 8, currency: "EUR" }), "credits 8.00 EUR left");
    assert.equal(items.creditsText({ enabled: true, remaining: null }), "credits on");
  });

  it("reports running out, and stays quiet about a deliberate off", () => {
    assert.equal(items.creditsText({ enabled: false, reason: "out_of_credits" }), "credits spent");
    assert.equal(items.creditsText({ enabled: false, spendLimitReached: true }), "credit limit reached");
    assert.equal(items.creditsText({ enabled: false, userDisabled: true, reason: null }), "");
    assert.equal(items.creditsText(null), "");
  });
});

describe("finding zclaude", () => {
  it("prefers the setting over everything else", () => {
    const paths = cli.candidatePaths({
      env: { PATH: "/usr/bin", HOME: "/home/x" },
      platform: "linux",
      setting: "/s/z",
    });
    assert.equal(paths[0], "/s/z");
  });

  it("looks where the installers put it, because a dock launch has no shell PATH", () => {
    const paths = cli.candidatePaths({ env: { PATH: "", HOME: "/home/x" }, platform: "darwin" });
    assert.ok(paths.includes("/home/x/.local/bin/zclaude"));
    assert.ok(paths.includes("/home/x/.zclaude/app/zclaude"));
    assert.ok(paths.includes("/opt/homebrew/bin/zclaude"));
  });

  it("asks for the .cmd on Windows and splits PATH on semicolons", () => {
    // path.join uses this machine's separator, so the assertion is about the
    // two PATH entries being separate and about the .cmd, not about slashes.
    const paths = cli.candidatePaths({ env: { PATH: "C:\\a;C:\\b", HOME: "C:\\u" }, platform: "win32" });
    assert.ok(paths[0].startsWith("C:\\a") && paths[0].endsWith("zclaude.cmd"));
    assert.ok(paths[1].startsWith("C:\\b") && paths[1].endsWith("zclaude.cmd"));
  });

  it("returns the first candidate that can actually be run", async () => {
    const home = await tempHome();
    try {
      const bin = join(home.dir, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "zclaude"), "#!/bin/sh\nexit 0\n");
      await chmod(join(bin, "zclaude"), 0o755);
      assert.equal(cli.findBinary({ env: { PATH: bin, HOME: home.dir }, platform: "linux" }), join(bin, "zclaude"));
    } finally {
      await home.cleanup();
    }
  });

  it("returns null rather than a path that is not there", () => {
    // The fixed fallbacks (Homebrew, /usr/local/bin) may genuinely hold a
    // zclaude on the machine running this, so the check is injected.
    const access = () => {
      throw new Error("ENOENT");
    };
    assert.equal(
      cli.findBinary({ env: { PATH: "/nonexistent", HOME: "/nonexistent" }, platform: "linux", access }),
      null,
    );
  });
});

// The bug this guards: an editor launched from the dock on macOS has
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no node on any machine using
// Homebrew, nvm, volta or fnm. zclaude starts `#!/usr/bin/env node`, so every
// call failed with "env: node: No such file or directory" and the status bar
// had nothing to report.
describe("running it where node can be found", () => {
  const dock = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/x" };

  it("puts the binary's own directory first, since npm installs node beside it", () => {
    const path = new Set(cli.pathFor("/opt/homebrew/bin/zclaude", dock, "darwin").split(":"));
    assert.ok(path.has("/opt/homebrew/bin"));
    assert.ok(path.has("/usr/bin"), "the editor's own PATH is kept, not replaced");
  });

  it("adds the places a node ends up on a Mac", () => {
    const path = new Set(cli.pathFor("/somewhere/zclaude", dock, "darwin").split(":"));
    for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/Users/x/.local/bin", "/Users/x/.volta/bin"]) {
      assert.ok(path.has(dir), `${dir} is missing`);
    }
    assert.ok(path.has("/Users/x/.zclaude/node/bin"), "the private node the installer can download");
  });

  it("never repeats a directory already on PATH", () => {
    const path = cli.pathFor("/usr/local/bin/zclaude", { PATH: "/usr/local/bin:/usr/bin", HOME: "/Users/x" }, "darwin");
    const entries = path.split(":");
    assert.equal(new Set(entries).size, entries.length);
  });

  it("leaves Windows alone, where the shebang is not how anything starts", () => {
    assert.equal(cli.pathFor("C:\\bin\\zclaude.cmd", { PATH: "C:\\windows" }, "win32"), "C:\\windows");
  });

  it("hands that PATH to the child", async () => {
    let handed = null;
    const execFileImpl = (bin, args, options, callback) => {
      handed = options.env.PATH;
      callback(null, "", "");
    };
    await cli.run("/opt/homebrew/bin/zclaude", ["--version"], { env: dock, execFileImpl, platform: "darwin" });
    assert.ok(handed.includes("/opt/homebrew/bin"));
  });
});

describe("talking to zclaude", () => {
  const fake = (result) => (bin, args, options, callback) =>
    callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");

  it("asks for JSON and parses it", async () => {
    let asked = null;
    const execFileImpl = (bin, args, options, callback) => {
      asked = args;
      callback(null, '{"owner":"work"}', "");
    };
    const { data, error } = await cli.runJson("/z", ["switch", "--status"], { execFileImpl });
    assert.deepEqual(data, { owner: "work" });
    assert.equal(error, null);
    assert.deepEqual(asked, ["switch", "--status", "--json"]);
  });

  it("reports the reason when zclaude fails, rather than throwing", async () => {
    const execFileImpl = fake({ error: Object.assign(new Error("exit"), { code: 2 }), stderr: "Unknown profile\n" });
    const { data, error } = await cli.runJson("/z", ["switch", "nope"], { execFileImpl });
    assert.equal(data, null);
    assert.equal(error, "Unknown profile");
  });

  it("reports output that is not JSON as such", async () => {
    const execFileImpl = fake({ stdout: "not json at all" });
    const { error } = await cli.runJson("/z", ["profile", "list"], { execFileImpl });
    assert.match(error, /did not answer in JSON/u);
  });

  it("reads the version out of --version, ignoring the claude line under it", async () => {
    const execFileImpl = (bin, args, options, callback) =>
      callback(null, "zclaude 0.2.18 — interactive preloader\nclaude 2.1.274 (Claude Code)\n", "");
    assert.equal(await cli.version("/z", { execFileImpl }), "0.2.18");
  });

  it("returns null when the binary answers with something else entirely", async () => {
    const execFileImpl = (bin, args, options, callback) => callback(null, "command not found", "");
    assert.equal(await cli.version("/z", { execFileImpl }), null);
  });

  it("never rejects on a non-zero exit, so the extension can report it", async () => {
    const execFileImpl = fake({ error: Object.assign(new Error("boom"), { code: 3 }), stderr: "went wrong" });
    const result = await cli.run("/z", ["switch", "x"], { execFileImpl });
    assert.deepEqual(result, { ok: false, code: 3, stdout: "", stderr: "went wrong" });
  });
});
