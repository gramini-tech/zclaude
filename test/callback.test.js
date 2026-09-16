import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { receiveCallback } from "../src/callback/index.js";
import { EXIT, InterruptedError } from "../src/errors.js";

function neverSettles(signal) {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function fakeNative({ value, fail } = {}) {
  const events = [];
  const createNative = async ({ scheme }) => {
    events.push(`create:${scheme}`);
    if (fail) throw new Error(fail);
    return {
      waitForCallback: (signal) => {
        events.push("wait");
        return value === undefined ? neverSettles(signal) : Promise.resolve(value);
      },
      dispose: async () => {
        events.push("dispose");
      },
    };
  };
  return { createNative, events };
}

describe("receiveCallback", () => {
  it("returns the native capture and disposes the receiver", async () => {
    const native = fakeNative({ value: "zcode://zai-auth/callback?code=abc" });
    const promptPaste = ({ signal }) => neverSettles(signal);
    const result = await receiveCallback({
      timeoutMs: 5000,
      platform: "darwin",
      env: {},
      interactive: true,
      createNative: native.createNative,
      promptPaste,
    });
    assert.deepEqual(result, { value: "zcode://zai-auth/callback?code=abc", from: "native" });
    assert.deepEqual(native.events, ["create:zcode", "wait", "dispose"]);
  });

  it("lets a pasted value win while native capture is still waiting", async () => {
    const native = fakeNative();
    const result = await receiveCallback({
      timeoutMs: 5000,
      platform: "darwin",
      env: {},
      interactive: true,
      createNative: native.createNative,
      promptPaste: async () => "pasted-code",
    });
    assert.deepEqual(result, { value: "pasted-code", from: "paste" });
    assert.ok(native.events.includes("dispose"));
  });

  it("falls back to paste when native setup fails, and reports readiness", async () => {
    const native = fakeNative({ fail: "osacompile missing" });
    let ready;
    const result = await receiveCallback({
      timeoutMs: 5000,
      platform: "darwin",
      env: {},
      interactive: true,
      createNative: native.createNative,
      promptPaste: async () => "code-from-paste",
      onReady: (mode) => {
        ready = mode;
      },
    });
    assert.equal(result.from, "paste");
    assert.deepEqual(ready, { native: false, paste: true });
  });

  it("skips native capture off macOS and when disabled", async () => {
    const native = fakeNative({ value: "unused" });
    await receiveCallback({
      timeoutMs: 5000,
      platform: "linux",
      env: {},
      interactive: true,
      createNative: native.createNative,
      promptPaste: async () => "x",
    });
    await receiveCallback({
      timeoutMs: 5000,
      platform: "darwin",
      env: { ZCLAUDE_NO_NATIVE_CALLBACK: "1" },
      interactive: true,
      createNative: native.createNative,
      promptPaste: async () => "x",
    });
    assert.deepEqual(native.events, []);
  });

  it("fails with a usage error when nothing can receive the code", async () => {
    await assert.rejects(
      receiveCallback({ timeoutMs: 5000, platform: "linux", env: {}, interactive: false }),
      (error) => {
        assert.equal(error.exitCode, EXIT.USAGE);
        return true;
      },
    );
    const native = fakeNative({ fail: "nope" });
    await assert.rejects(
      receiveCallback({
        timeoutMs: 5000,
        platform: "darwin",
        env: {},
        interactive: false,
        createNative: native.createNative,
      }),
      /nope/u,
    );
  });

  it("times out with an auth error and cleans up", async () => {
    const native = fakeNative();
    await assert.rejects(
      receiveCallback({
        timeoutMs: 30,
        platform: "darwin",
        env: {},
        interactive: true,
        createNative: native.createNative,
        promptPaste: ({ signal }) => neverSettles(signal),
      }),
      (error) => {
        assert.equal(error.exitCode, EXIT.AUTH);
        assert.match(error.message, /Timed out/u);
        return true;
      },
    );
    assert.ok(native.events.includes("dispose"));
  });

  it("turns an interrupt from a receiver into the interrupted exit code", async () => {
    await assert.rejects(
      receiveCallback({
        timeoutMs: 5000,
        platform: "linux",
        env: {},
        interactive: true,
        promptPaste: async () => {
          throw new InterruptedError("Login cancelled.");
        },
      }),
      (error) => {
        assert.equal(error.exitCode, EXIT.INTERRUPTED);
        return true;
      },
    );
  });
});
