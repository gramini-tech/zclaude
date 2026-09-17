// Asking the OS to run the renewal, and taking that back. The three mechanisms
// are faked on PATH, because the assertions are about what we write and what we
// remove — an uninstall that leaves a timer behind is the failure that matters.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  agentPath,
  cronLine,
  INTERVAL_SECONDS,
  install,
  LABEL,
  plistFor,
  status,
  timerPaths,
  uninstall,
  unitsFor,
} from "../src/renew/schedule.js";
import { tempHome } from "./helpers.js";

/** A directory of fake tools that log their arguments and can be made to fail. */
async function fakeTools(home, { present = ["launchctl", "systemctl", "crontab"], crontab = "" } = {}) {
  const bin = join(home.dir, "fake-bin");
  const calls = join(home.dir, "calls.txt");
  const cronFile = join(home.dir, "crontab.txt");
  await mkdir(bin, { recursive: true });
  await writeFile(cronFile, crontab);
  const scripts = {
    launchctl: `#!/bin/sh\necho "launchctl $*" >> "${calls}"\nexit 0\n`,
    systemctl: `#!/bin/sh\necho "systemctl $*" >> "${calls}"\nexit 0\n`,
    // Stands in for the user's crontab: -l prints it, - replaces it from stdin.
    // PATH holds only these fakes, so the script cannot rely on finding `cat`.
    crontab: `#!/bin/sh\nPATH=/usr/bin:/bin\necho "crontab $*" >> "${calls}"\nif [ "$1" = "-l" ]; then cat "${cronFile}"; exit 0; fi\nif [ "$1" = "-" ]; then cat > "${cronFile}"; fi\nexit 0\n`,
  };
  for (const name of present) {
    await writeFile(join(bin, name), scripts[name]);
    await chmod(join(bin, name), 0o755);
  }
  return {
    bin,
    read: () => readFile(calls, "utf8").catch(() => ""),
    cron: () => readFile(cronFile, "utf8").catch(() => ""),
    // Only the fakes: a PATH with /usr/bin on it would find the real systemctl
    // on a Linux runner, and the "systemd is not in charge" cases would then
    // take the systemd branch and pass for the wrong reason.
    env: { HOME: home.dir, PATH: bin },
  };
}

describe("what gets written", () => {
  it("writes a plist launchd will accept, pointing at this installation", () => {
    const plist = plistFor("/home/x/.zclaude/app/zclaude", { logDir: "/home/x/.zclaude/logs" });
    assert.match(plist, /<key>Label<\/key><string>com\.zclaude\.renew<\/string>/u);
    assert.match(
      plist,
      /<string>\/home\/x\/\.zclaude\/app\/zclaude<\/string>\s*<string>renew<\/string>\s*<string>run<\/string>/u,
    );
    assert.match(plist, new RegExp(`<key>StartInterval</key><integer>${INTERVAL_SECONDS}</integer>`, "u"));
    // Not at load: an install should not trigger a token refresh on the spot.
    assert.match(plist, /<key>RunAtLoad<\/key><false\/>/u);
    assert.match(plist, /renew\.log/u);
  });

  it("writes a systemd timer that catches up after a machine was asleep", () => {
    const units = unitsFor("/home/x/.local/bin/zclaude");
    assert.match(units.service, /ExecStart=\/home\/x\/\.local\/bin\/zclaude renew run/u);
    assert.match(units.timer, new RegExp(`OnUnitActiveSec=${INTERVAL_SECONDS}s`, "u"));
    assert.match(units.timer, /Persistent=true/u);
  });

  it("writes a crontab line that can be found again by name", () => {
    const line = cronLine("/usr/local/bin/zclaude");
    assert.match(line, /^0 \*\/6 \* \* \* \/usr\/local\/bin\/zclaude renew run/u);
    assert.match(line, /# zclaude renew$/u, "the marker is how uninstall removes exactly this line");
  });
});

describe("installing and removing the schedule", () => {
  it("loads a launch agent on macOS and removes it again", async () => {
    const home = await tempHome();
    try {
      const tools = await fakeTools(home);
      const result = await install({ binary: "/z/zclaude", env: tools.env, platform: "darwin" });
      assert.equal(result.installed, true);
      assert.equal(result.mechanism, "launchd");
      assert.equal(result.path, agentPath(tools.env));
      const calls = await tools.read();
      assert.match(calls, /launchctl bootout gui\/\d+\/com\.zclaude\.renew/u, "an old job is booted out first");
      assert.match(calls, /launchctl bootstrap gui\/\d+ .*com\.zclaude\.renew\.plist/u);
      assert.match(await readFile(agentPath(tools.env), "utf8"), /<string>\/z\/zclaude<\/string>/u);

      const reported = await status({ env: tools.env, platform: "darwin" });
      assert.equal(reported.installed, true);
      assert.equal(reported.binary, "/z/zclaude");

      const removed = await uninstall({ env: tools.env, platform: "darwin" });
      assert.deepEqual(removed.removed, [agentPath(tools.env)]);
      await assert.rejects(readFile(agentPath(tools.env), "utf8"), /ENOENT/u);
      assert.equal((await status({ env: tools.env, platform: "darwin" })).installed, false);
    } finally {
      await home.cleanup();
    }
  });

  it("is idempotent: installing twice leaves one job", async () => {
    const home = await tempHome();
    try {
      const tools = await fakeTools(home);
      await install({ binary: "/z/zclaude", env: tools.env, platform: "darwin" });
      await install({ binary: "/z/zclaude", env: tools.env, platform: "darwin" });
      const plist = await readFile(agentPath(tools.env), "utf8");
      assert.equal(plist.split(LABEL).length - 1, 1, "one label, one job");
    } finally {
      await home.cleanup();
    }
  });

  it("enables a systemd user timer on Linux and disables it again", async () => {
    const home = await tempHome();
    try {
      const tools = await fakeTools(home);
      const paths = timerPaths(tools.env);
      const result = await install({ binary: "/z/zclaude", env: tools.env, platform: "linux" });
      assert.equal(result.mechanism, "systemd");
      assert.match(await tools.read(), /systemctl --user enable --now zclaude-renew\.timer/u);
      assert.match(await readFile(paths.service, "utf8"), /ExecStart=\/z\/zclaude renew run/u);

      const removed = await uninstall({ env: tools.env, platform: "linux" });
      assert.deepEqual(removed.removed, [paths.timer]);
      assert.match(await tools.read(), /systemctl --user disable --now zclaude-renew\.timer/u);
    } finally {
      await home.cleanup();
    }
  });

  it("falls back to crontab where systemd is not in charge, and keeps other lines", async () => {
    const home = await tempHome();
    try {
      const tools = await fakeTools(home, { present: ["crontab"], crontab: "0 9 * * * backup.sh\n" });
      const result = await install({ binary: "/z/zclaude", env: tools.env, platform: "linux" });
      assert.equal(result.mechanism, "cron");
      const cron = await tools.cron();
      assert.match(cron, /backup\.sh/u, "someone else's job is not collateral");
      assert.match(cron, /zclaude renew run.*# zclaude renew/u);

      await uninstall({ env: tools.env, platform: "linux" });
      const after = await tools.cron();
      assert.match(after, /backup\.sh/u);
      assert.doesNotMatch(after, /zclaude renew/u);
    } finally {
      await home.cleanup();
    }
  });

  it("replaces its own crontab line rather than stacking them", async () => {
    const home = await tempHome();
    try {
      const tools = await fakeTools(home, { present: ["crontab"] });
      await install({ binary: "/z/old", env: tools.env, platform: "linux" });
      await install({ binary: "/z/new", env: tools.env, platform: "linux" });
      const cron = await tools.cron();
      assert.equal(cron.split("# zclaude renew").length - 1, 1);
      assert.match(cron, /\/z\/new/u);
    } finally {
      await home.cleanup();
    }
  });

  it("prints the command on Windows instead of scheduling anything", async () => {
    const home = await tempHome();
    try {
      const tools = await fakeTools(home);
      const result = await install({ binary: "C:/zclaude.cmd", env: tools.env, platform: "win32" });
      assert.equal(result.installed, false);
      assert.match(result.command, /schtasks \/create/u);
      assert.equal(await tools.read(), "", "nothing was run");
      assert.deepEqual((await uninstall({ env: tools.env, platform: "win32" })).removed, []);
    } finally {
      await home.cleanup();
    }
  });

  it("removing what was never installed is not an error", async () => {
    const home = await tempHome();
    try {
      const tools = await fakeTools(home);
      for (const platform of ["darwin", "linux"]) {
        assert.deepEqual((await uninstall({ env: tools.env, platform })).removed, []);
      }
    } finally {
      await home.cleanup();
    }
  });
});
