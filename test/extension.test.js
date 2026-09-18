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
const { hoverPanel } = items;
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

  it("shows the numbers once they have, and nothing that cannot render", () => {
    const [row] = items.quickPickItems({
      profiles: [profile("work")],
      usage: { work: usage(12, 61, [{ name: "Fable", pct: 91 }]) },
    });
    // Numbers only. A gauge drawn in the list's proportional font says nothing
    // about its value, and a clock after each window runs off the end.
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

describe("the bar in the hover", () => {
  // VS Code's hover sanitiser lets a span carry a background-colour and little
  // else, so the bar is two coloured spans filled with figure spaces. It is the
  // only way to draw one in the one anchored surface an extension has.
  it("fills in proportion to the number", () => {
    const cells = (text, colour) => (text.match(new RegExp(`${colour};">(\\u{2007}+)`, "u"))?.[1] ?? "").length;
    assert.equal(cells(items.bar(0), "#6e768166"), 5, "nothing spent is an empty track");
    assert.equal(cells(items.bar(50), "#3fb950"), 3);
    assert.equal(cells(items.bar(100), "#f85149"), 5);
  });

  it("shows a cell for anything spent at all, so 5% is not an empty bar", () => {
    assert.match(items.bar(5), /#3fb950;">\u{2007}<\/span>/u);
    assert.match(items.bar(0.4), /#3fb950;">\u{2007}<\/span>/u);
  });

  it("clamps rather than overflowing on a number outside the range", () => {
    assert.equal([...items.bar(140).matchAll(/\u{2007}/gu)].length, 5);
    assert.equal([...items.bar(-5).matchAll(/\u{2007}/gu)].length, 5);
  });

  it("colours by how close the window is to stopping you", () => {
    assert.equal(items.severity(5), "calm");
    assert.equal(items.severity(60), "warn");
    assert.equal(items.severity(92), "critical");
    assert.match(items.bar(92), /#f85149/u);
    assert.match(items.bar(70), /#d29922/u);
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
    assert.match(row.description, /work@example\.com {3}\$\(circle-filled\) running/u);
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
    assert.match(items.hoverPanel({ status: null, version: "0.2.14" }), /older than/u);
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

  it("names the account and marks which profile holds it", () => {
    const text = items.hoverPanel({
      status: { account: { email: "a@b.com", organization: "Acme" }, owner: "work" },
      profiles: [{ name: "work", provider: "anthropic" }],
      usage: { work: usage(1, 2, [{ name: "Fable", pct: 3 }]) },
      version: "9.9.9",
    });
    assert.match(text, /Signed in as \*\*a@b\.com\*\* · Acme/u);
    assert.match(text, /codicon-check"><\/span>&nbsp;<b>work<\/b>/u);
  });

  it("says so plainly when the credential could not be read", () => {
    const hover = (status) => items.hoverPanel({ status, version: "9.9.9" });
    assert.match(hover({ unreadable: "the Keychain is locked" }), /could not be read: the Keychain/u);
    assert.match(hover(null), /Nobody is signed in/u);
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

  it("keeps the clocks out of the list, where they would be clipped", () => {
    const pressed = {
      state: "ok",
      fiveHour: { pct: 78, resetsAt: at(2 * 3_600_000) },
      weekly: { pct: 4, resetsAt: at(6 * 86_400_000) },
      scoped: [],
    };
    assert.equal(items.usageText(pressed), "5h 78% · wk 4%");
  });

  it("converts to local time, which is the point of converting at all", () => {
    // Asserted through the formatter rather than against a fixed string: the
    // machine's zone is what it renders in, and a test that pinned one would
    // pass only where it was written.
    const expected = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at(3_600_000));
    assert.equal(items.localTime(at(3_600_000), NOW), expected);
    assert.match(items.localTime(at(3 * 86_400_000), NOW), /,/u, "a date further out carries its day");
  });

  it("draws the bar and the clock in the hover, where both fit", () => {
    const text = items.hoverPanel({
      status: null,
      profiles: [{ name: "work", provider: "anthropic" }],
      usage: { work: { state: "ok", fiveHour: { pct: 78, resetsAt: at(2 * 3_600_000) }, weekly: null, scoped: [] } },
      version: "9.9.9",
      now: NOW,
    });
    assert.match(text, /background-color:#d29922;/u, "78% is in the warning band");
    assert.match(text, /&nbsp;78%<br><small>2h<\/small>/u);
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

describe("the hover panel", () => {
  const profiles = [
    { name: "chinese", provider: "zai" },
    { name: "gramini", provider: "anthropic" },
    { name: "max", provider: "anthropic" },
  ];
  const PANEL_NOW = 1_800_000_000_000;
  const window = (pct) => ({ pct, resetsAt: PANEL_NOW + 3_600_000 });
  const usage = {
    chinese: { state: "ok", fiveHour: window(21), weekly: window(72), scoped: [] },
    gramini: { state: "ok", fiveHour: window(66), weekly: window(33), scoped: [{ name: "Fable", ...window(54) }] },
    max: { state: "ok", fiveHour: window(5), weekly: window(3), scoped: [{ name: "Fable", ...window(4) }] },
  };
  const status = { account: { email: "a@b.com", organization: "Acme" }, owner: "gramini" };
  const panel = (extra = {}) =>
    hoverPanel({ status, profiles, usage, busy: {}, version: "9.9.9", now: PANEL_NOW, ...extra });

  it("offers a sign-in on a broken login, ahead of a switch it could not honour", () => {
    // Switching to an account whose token the server has rejected would put a
    // login in the slot that cannot answer. And the row would otherwise read
    // "login expired" with no way out of the editor at all.
    const broken = { ...usage, max: { state: "dead", fiveHour: null, weekly: null, scoped: [] } };
    const text = panel({ usage: broken });
    assert.match(text, /login expired/u);
    assert.match(text, /href="command:zclaude\.signIn\?%5B%22max%22%5D">sign in<\/a>/u);
    assert.doesNotMatch(text, /zclaude\.switchTo\?%5B%22max%22%5D/u, "no switch offered to an account that is out");
  });

  it("still offers a switch to an account whose numbers merely failed to arrive", () => {
    // "offline" is a lookup that did not answer, which a sign-in does not fix.
    const offline = { ...usage, max: { state: "offline", fiveHour: null, weekly: null, scoped: [] } };
    const text = panel({ usage: offline });
    assert.match(text, /zclaude\.switchTo\?%5B%22max%22%5D/u);
    assert.doesNotMatch(text, /zclaude\.signIn/u);
  });

  it("lays the accounts out as a table, which is what a hover can render", () => {
    const text = panel();
    assert.match(text, /<table>/u);
    for (const label of ["5 hours", "week", "Fable"]) assert.match(text, new RegExp(`<th>${label}`, "u"));
  });

  it("gives every window a bar and a reset, and a missing one a dash", () => {
    const text = panel();
    // Two lines in every cell, and exactly two: cells of different heights
    // settle at different baselines, and a hover cell cannot be told how to
    // align. The clock is the second line, in <small>.
    assert.match(text, /&nbsp;66%<br><small>1h<\/small>/u);
    const cells = [...text.matchAll(/<td[^>]*>(.*?)<\/td>/gu)].map((match) => match[1]);
    assert.ok(
      cells.every((cell) => (cell.match(/<br>/gu) ?? []).length === 1),
      "every cell is two lines, or the rows do not line up",
    );
    assert.match(text, /<td>–<br>/u, "chinese has no Fable window");
  });

  it("puts the organisation under the name, which is what tells two apart", () => {
    const text = panel({
      profiles: [
        { name: "work", provider: "anthropic", account: "a@b.com · Acme" },
        { name: "mine", provider: "anthropic", account: "a@b.com · personal" },
      ],
      usage: {},
    });
    assert.match(text, /<b>work<\/b><br><small>Acme<\/small>/u);
    assert.match(text, /<b>mine<\/b><br><small>personal<\/small>/u);
    // The full address is named above the table; repeating it on every row
    // would make the first column wider than the numbers.
    assert.doesNotMatch(text, /<small>a@b\.com · Acme<\/small>/u);
  });

  it("does not let a clock break across lines", () => {
    const text = panel();
    assert.doesNotMatch(text, /<small>\d+[a-z] \d+[a-z]<\/small>/u, "a plain space there would wrap");
  });

  it("offers switch as a command link, on the accounts that can take one", () => {
    const text = panel();
    assert.match(text, /<a href="command:zclaude\.switchTo\?%5B%22max%22%5D">switch<\/a>/u);
    assert.doesNotMatch(text, /switchTo\?%5B%22gramini%22%5D/u, "gramini is already in use");
    assert.doesNotMatch(text, /switchTo\?%5B%22chinese%22%5D/u, "a Z.ai login cannot be switched to");
    assert.match(text, /<td>terminal<br>/u);
  });

  it("marks the account in the global slot", () => {
    assert.match(panel(), /codicon codicon-check"><\/span>&nbsp;<b>gramini<\/b>/u);
  });

  it("counts sessions in their own column", () => {
    assert.match(panel({ busy: { max: { total: 2, working: 1 } } }), /<td>2 active<br>/u);
  });

  it("says why a row has no numbers instead of drawing an empty bar", () => {
    const text = panel({ usage: { ...usage, gramini: { state: "unauthorized" } } });
    assert.match(text, /sign in to see usage/u);
  });

  it("carries the other four commands as links", () => {
    const text = panel();
    for (const command of ["refresh", "add", "remove", "restore"]) {
      assert.match(text, new RegExp(`command:zclaude\\.${command}`, "u"));
    }
  });

  it("drops the table entirely when zclaude is too old to fill it", () => {
    const text = hoverPanel({ status, profiles, usage, version: "0.0.1" });
    assert.doesNotMatch(text, /<table>/u);
    assert.match(text, /older than/u);
  });

  // An account name is an email address and an organisation: somebody else's
  // text, arriving over the network, going into a document.
  it("escapes what it is given rather than trusting it", () => {
    assert.equal(items.escapeHtml('<img src=x onerror="go()">'), "&lt;img src=x onerror=&quot;go()&quot;&gt;");
    const text = panel({ profiles: [{ name: "<script>evil</script>", provider: "anthropic" }], usage: {} });
    assert.doesNotMatch(text, /<script>evil/u);
    assert.match(text, /&lt;script&gt;evil/u);
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
