// The `zclaude renew` command surface. The schedulers and the Keychain are
// faked, so nothing here installs a real timer or reads a real credential.

import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { claudeCredentialService } from "../src/profiles/keychain-name.js";
import { putRegistered } from "../src/profiles/registry.js";
import { cmdRenewGroup } from "../src/renew-commands.js";
import { agentPath } from "../src/renew/schedule.js";
import { tempHome } from "./helpers.js";

const SOON = Date.now() + 60_000;

const credential = (who, expiresAt = SOON) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat-${who}`,
      refreshToken: `sk-ant-ort-${who}`,
      expiresAt,
      refreshTokenExpiresAt: Date.now() + 30 * 86_400_000,
      subscriptionType: "team",
    },
  });

async function capture(run) {
  const chunks = { out: "", err: "" };
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (text) => {
    chunks.out += text;
    return true;
  };
  process.stderr.write = (text) => {
    chunks.err += text;
    return true;
  };
  try {
    const value = await run();
    return { ...chunks, value };
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
}

/** A launchctl that records rather than schedules. */
async function fakeLaunchctl(home) {
  const bin = join(home.dir, "fake-bin");
  const calls = join(home.dir, "launchctl.txt");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "launchctl"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 0\n`);
  await chmod(join(bin, "launchctl"), 0o755);
  return { bin, calls };
}

async function setup({ profiles = {} } = {}) {
  const home = await tempHome();
  const tools = await fakeLaunchctl(home);
  const env = {
    HOME: home.dir,
    ZCLAUDE_HOME: join(home.dir, ".zclaude"),
    USER: "tester",
    NO_COLOR: "1",
    PATH: `${tools.bin}:/usr/bin:/bin`,
    ZCLAUDE_BIN: "/z/zclaude",
  };
  const items = new Map();
  for (const [name, expiresAt] of Object.entries(profiles)) {
    const dir = join(home.dir, ".zclaude", "profiles", name, "home");
    await mkdir(dir, { recursive: true });
    await putRegistered({ name, provider: "anthropic", dir }, env);
    items.set(claudeCredentialService(dir), credential(name, expiresAt));
  }
  const security = async (args, { stdinText } = {}) => {
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === "find-generic-password") {
      const found = items.get(at("-s"));
      return found === undefined ? { code: 44, stdout: "", stderr: "" } : { code: 0, stdout: `${found}\n`, stderr: "" };
    }
    if (args[0] === "-i") {
      // A write that does not store is caught by the read-back, so the fake
      // has to actually store.
      const service = stdinText.match(/-s "([^"]+)"/u)[1];
      items.set(service, Buffer.from(stdinText.match(/-X ([\da-f]+)/u)[1], "hex").toString("utf8"));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { home, env, items, security };
}

const grant = async () => Response.json({ access_token: "new-access", expires_in: 3600 });

describe("zclaude renew", () => {
  const renew = (args, { env, security, options = {}, platform = "darwin" }) =>
    capture(() => cmdRenewGroup({ options: { args, ...options }, env }, { security, fetchImpl: grant, platform }));

  it("reports that nothing is scheduled yet", async () => {
    const { home, env, security } = await setup();
    try {
      const result = await renew(["status"], { env, security });
      assert.match(result.out, /schedule\s+not scheduled/u);
      assert.match(result.out, /last run\s+never/u);
    } finally {
      await home.cleanup();
    }
  });

  it("declines to schedule anything when there is nothing to keep alive", async () => {
    const { home, env, security } = await setup();
    try {
      const result = await renew(["install"], { env, security });
      assert.match(result.err, /no Anthropic profiles to keep alive yet/u);
      assert.match(result.err, /--force to schedule it anyway/u);
    } finally {
      await home.cleanup();
    }
  });

  it("schedules, reports and unschedules", async () => {
    const { home, env, security } = await setup({ profiles: { work: SOON } });
    try {
      const installed = await renew(["install"], { env, security });
      assert.match(installed.err, /Scheduled with launchd/u);
      assert.match(installed.err, /every 6 hours/u);

      const reported = await renew(["status"], { env, security });
      assert.match(reported.out, /schedule\s+launchd/u);
      assert.match(reported.out, new RegExp(agentPath(env).replaceAll(/[/.]/gu, "\\$&"), "u"));

      const removed = await renew(["uninstall"], { env, security });
      assert.match(removed.err, /Removed: .*com\.zclaude\.renew\.plist/u);
      assert.match((await renew(["uninstall"], { env, security })).err, /Nothing was scheduled/u);
    } finally {
      await home.cleanup();
    }
  });

  it("runs, and prints a line for every profile", async () => {
    const { home, env, security } = await setup({ profiles: { soon: SOON, later: Date.now() + 8 * 3_600_000 } });
    try {
      const result = await renew(["run"], { env, security });
      assert.match(result.out, /later\s+still fresh for 8\.0h/u);
      assert.match(result.out, /soon\s+renewed/u);

      const after = await renew(["status"], { env, security });
      assert.match(after.out, /last run\s+20\d\d-/u, "the run is recorded for the next status");
      assert.match(after.out, /rotation\s+your account keeps the same refresh token/u);
    } finally {
      await home.cleanup();
    }
  });

  it("answers in JSON, without carrying a token", async () => {
    const { home, env, security } = await setup({ profiles: { soon: SOON } });
    try {
      const result = await renew(["run"], { env, security, options: { json: true } });
      const payload = JSON.parse(result.out);
      assert.equal(payload.results[0].state_, "renewed");
      assert.doesNotMatch(result.out, /sk-ant/u);
    } finally {
      await home.cleanup();
    }
  });

  it("rejects a subcommand it does not have", async () => {
    const { home, env, security } = await setup();
    try {
      await assert.rejects(renew(["frobnicate"], { env, security }), /is not a command/u);
    } finally {
      await home.cleanup();
    }
  });
});
