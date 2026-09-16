import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { InterruptedError } from "../src/errors.js";
import { guard, promptSignal, resetPromptSignal, withSignal } from "../src/ui/prompt.js";

class NamedError extends Error {
  constructor(name) {
    super(name);
    this.name = name;
  }
}
const named = (name) => new NamedError(name);

describe("prompt plumbing", () => {
  it("aborts the shared signal when stdin ends, with an InterruptedError reason", () => {
    resetPromptSignal();
    const stdin = new EventEmitter();
    const signal = promptSignal({ stdin });
    assert.equal(signal.aborted, false);
    assert.equal(promptSignal({ stdin }), signal, "same signal on repeat calls");
    stdin.emit("end");
    assert.equal(signal.aborted, true);
    assert.ok(signal.reason instanceof InterruptedError);
    stdin.emit("close");
    assert.ok(signal.reason instanceof InterruptedError, "second event does not replace the reason");
    resetPromptSignal();
  });

  it("combines the shared signal with a caller signal", () => {
    resetPromptSignal();
    const stdin = new EventEmitter();
    promptSignal({ stdin });
    const extra = new AbortController();
    const combined = withSignal(extra.signal);
    assert.equal(combined.aborted, false);
    extra.abort(new Error("caller"));
    assert.equal(combined.aborted, true);
    assert.equal(withSignal(), promptSignal({ stdin }));
    resetPromptSignal();
  });

  it("guard maps inquirer cancellations to InterruptedError and passes other errors through", async () => {
    const cancelled = named("ExitPromptError");
    await assert.rejects(guard(Promise.reject(cancelled)), InterruptedError);
    const aborted = named("AbortPromptError");
    await assert.rejects(guard(Promise.reject(aborted)), InterruptedError);
    const typeError = Promise.reject(new TypeError("boom"));
    await assert.rejects(guard(typeError), TypeError);
    assert.equal(await guard(Promise.resolve("ok")), "ok");
  });
});
