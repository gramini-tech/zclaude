// Runs the available receivers concurrently and returns the first callback.

import { CALLBACK_SCHEME, flag } from "../config.js";
import { authError, InterruptedError, usageError } from "../errors.js";
import { warn } from "../ui/log.js";
import { createNativeReceiver } from "./darwin.js";
import { promptForCallback } from "./paste.js";

class CallbackTimeout extends Error {
  constructor(timeoutMs) {
    super(`no callback within ${timeoutMs}ms`);
    this.name = "CallbackTimeout";
  }
}

async function setupNative({ wanted, pasteAvailable, createNative, env, platform }) {
  if (!wanted) return null;
  try {
    return await createNative({ scheme: CALLBACK_SCHEME, env, platform });
  } catch (error) {
    warn(`Automatic ${CALLBACK_SCHEME}:// capture is unavailable (${error.message}).`);
    if (!pasteAvailable) throw error;
    warn("You will need to paste the redirect URL instead.");
    return null;
  }
}

function timeoutRacer(timeoutMs) {
  let timer;
  const promise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new CallbackTimeout(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function buildRacers({ native, pasteAvailable, promptPaste, signal, timeout }) {
  const tagged = (promise, from) => promise.then((value) => ({ value, from }));
  return [
    timeout.promise,
    native ? tagged(native.waitForCallback(signal), "native") : null,
    pasteAvailable ? tagged(promptPaste({ signal }), "paste") : null,
  ].filter(Boolean);
}

function translateFailure(error, controller, timeoutMs) {
  if (error instanceof CallbackTimeout) {
    return authError(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser to finish signing in.`,
      "Run `zclaude login` again, or set ZCLAUDE_LOGIN_TIMEOUT to wait longer.",
    );
  }
  if (controller.signal.aborted && controller.signal.reason instanceof InterruptedError)
    return controller.signal.reason;
  return error;
}

/**
 * @typedef {object} ReceiveOptions
 * @property {number} timeoutMs
 * @property {boolean} [allowNative]
 * @property {boolean} [allowPaste]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {boolean} [interactive]
 * @property {(mode: {native: boolean, paste: boolean}) => void | Promise<void>} [onReady]
 * @property {typeof createNativeReceiver} [createNative]
 * @property {typeof promptForCallback} [promptPaste]
 */

/**
 * Resolves with { value, from } where value is the raw pasted or captured text.
 * @param {ReceiveOptions} options
 */
export async function receiveCallback({
  timeoutMs,
  allowNative = true,
  allowPaste = true,
  env = process.env,
  platform = process.platform,
  interactive = Boolean(process.stdin.isTTY),
  onReady = () => {},
  createNative = createNativeReceiver,
  promptPaste = promptForCallback,
}) {
  const pasteAvailable = allowPaste && interactive;
  const native = await setupNative({
    wanted: allowNative && platform === "darwin" && !flag(env, "ZCLAUDE_NO_NATIVE_CALLBACK"),
    pasteAvailable,
    createNative,
    env,
    platform,
  });
  if (!native && !pasteAvailable) {
    throw usageError(
      "No way to receive the authorization code: not running in an interactive terminal.",
      "Run `zclaude login` from a terminal, or set ZAI_API_KEY for non-interactive use.",
    );
  }

  onReady({ native: Boolean(native), paste: pasteAvailable });

  const controller = new AbortController();
  const timeout = timeoutRacer(timeoutMs);
  const racers = buildRacers({ native, pasteAvailable, promptPaste, signal: controller.signal, timeout });

  const onSignal = () => controller.abort(new InterruptedError("Login cancelled."));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await Promise.race(racers);
  } catch (error) {
    throw translateFailure(error, controller, timeoutMs);
  } finally {
    timeout.cancel();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!controller.signal.aborted) controller.abort(new InterruptedError("settled"));
    for (const racer of racers) racer.catch(() => {});
    if (native)
      await native
        .dispose()
        .catch((error) => warn(`Cleanup of the ${CALLBACK_SCHEME}:// handler failed: ${error.message}`));
  }
}
