import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { bumpPatch } from "../scripts/bump-version.js";
import { readState } from "../src/store.js";
import { checkForUpdate, compareVersions, detectInstallKind, fetchLatestVersion } from "../src/update.js";
import { isolatedEnv, jsonResponse, mockFetch, tempHome } from "./helpers.js";

describe("versions", () => {
  it("compares semver numerically", () => {
    assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
    assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
    assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
    assert.ok(compareVersions("0.1", "0.1.1") < 0);
    assert.ok(compareVersions(undefined, "0.0.1") < 0);
  });
  it("bumps the patch component only", () => {
    assert.equal(bumpPatch("0.1.9"), "0.1.10");
    assert.equal(bumpPatch("2.0.0"), "2.0.1");
    assert.throws(() => bumpPatch("1.2"), /non-semver/u);
  });
  it("reads the latest version from GitHub and tolerates failures", async () => {
    assert.equal(await fetchLatestVersion({ fetchImpl: mockFetch(() => jsonResponse({ version: "0.2.5" })) }), "0.2.5");
    assert.equal(await fetchLatestVersion({ fetchImpl: mockFetch(() => jsonResponse({ nope: 1 })) }), null);
    assert.equal(
      await fetchLatestVersion({
        fetchImpl: () => {
          throw new Error("offline");
        },
      }),
      null,
    );
  });
});

describe("install kind", () => {
  const home = "/Users/someone";
  const env = { HOME: home };
  it("recognises the curl installer, npm and a checkout", () => {
    assert.equal(detectInstallKind({ scriptPath: `${home}/.zclaude/app/bin/zclaude.js`, env, home }), "installer");
    assert.equal(
      detectInstallKind({ scriptPath: `${home}/.npm/_npx/abc123/node_modules/zclaude/bin/zclaude.js`, env, home }),
      "npm",
    );
    assert.equal(
      detectInstallKind({ scriptPath: "/opt/homebrew/lib/node_modules/zclaude/bin/zclaude.js", env, home }),
      "npm",
    );
    assert.equal(
      detectInstallKind({ scriptPath: `${home}/.npm-global/lib/node_modules/zclaude/bin/zclaude.js`, env, home }),
      "npm",
    );
    assert.equal(detectInstallKind({ scriptPath: `${home}/work/zclaude/bin/zclaude.js`, env, home }), "checkout");
    assert.equal(
      detectInstallKind({
        scriptPath: "/custom/app/bin/zclaude.js",
        env: { ...env, ZCLAUDE_INSTALL_DIR: "/custom/app" },
        home,
      }),
      "installer",
    );
  });
});

describe("update check", () => {
  let home;
  let env;
  before(async () => {
    home = await tempHome();
    env = isolatedEnv(home.dir);
  });
  after(() => home.cleanup());

  it("fetches at most once a day and reports only newer versions", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ version: "9.9.9" }));
    const day = 24 * 60 * 60 * 1000;
    const start = 10 * day;
    assert.equal(await checkForUpdate({ env, now: start, fetchImpl, current: "0.1.0" }), "9.9.9");
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(await checkForUpdate({ env, now: start + day / 2, fetchImpl, current: "0.1.0" }), "9.9.9", "cached");
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(await checkForUpdate({ env, now: start + day / 2, fetchImpl, current: "9.9.9" }), null, "not newer");
    assert.equal(await checkForUpdate({ env, now: start + day + 1, fetchImpl, current: "0.1.0" }), "9.9.9");
    assert.equal(fetchImpl.calls.length, 2);
    const state = await readState(env);
    assert.equal(state.latestVersion, "9.9.9");
  });
  it("is silent when disabled, in CI, or offline", async () => {
    const boom = () => {
      throw new Error("offline");
    };
    assert.equal(await checkForUpdate({ env: { ...env, ZCLAUDE_NO_UPDATE_CHECK: "1" }, fetchImpl: boom }), null);
    assert.equal(await checkForUpdate({ env: { ...env, CI: "1" }, fetchImpl: boom }), null);
    const fresh = isolatedEnv(join(home.dir, "fresh"));
    assert.equal(await checkForUpdate({ env: fresh, now: Date.now(), fetchImpl: boom, current: "0.1.0" }), null);
  });
});
