// Shared plumbing for interactive prompts: one AbortSignal that fires when
// stdin closes (EOF, terminal gone) or the process is asked to stop, and a
// guard that maps inquirer's cancellation errors onto InterruptedError so the
// bin entry exits 130 instead of leaving an unsettled prompt behind.

import { InterruptedError, isInterrupt } from "../errors.js";

const state = { controller: null };

/**
 * Lazily created signal shared by every prompt in this process.
 * @param {{stdin?: NodeJS.ReadStream}} [options]
 */
export function promptSignal({ stdin = process.stdin } = {}) {
  if (state.controller) return state.controller.signal;
  const controller = new AbortController();
  state.controller = controller;
  const stop = (message) => () => {
    if (!controller.signal.aborted) controller.abort(new InterruptedError(message));
  };
  // The terminal may already be gone by the time the first prompt opens
  // (a pty hung up during startup); `end` will never fire again in that case.
  if (stdin.readableEnded || stdin.destroyed || stdin.closed) stop("Input closed.")();
  stdin.once("end", stop("Input closed."));
  stdin.once("close", stop("Input closed."));
  stdin.once("error", stop("Input closed."));
  process.once("SIGHUP", stop("Terminal closed."));
  return controller.signal;
}

/** Reset the shared signal (tests only). */
export function resetPromptSignal() {
  state.controller = null;
}

/** Await an inquirer prompt, turning cancellation into InterruptedError. */
export async function guard(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error?.name === "AbortPromptError" || isInterrupt(error)) throw new InterruptedError("Cancelled.");
    throw error;
  }
}

/** Combine the shared signal with an optional caller signal. */
export function withSignal(extra) {
  const base = promptSignal();
  return extra ? AbortSignal.any([base, extra]) : base;
}
