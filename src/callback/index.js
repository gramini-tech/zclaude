// Runs the available receivers concurrently and returns the first callback.

import { CALLBACK_SCHEME, flag } from "../config.js";
import { authError, InterruptedError, usageError } from "../errors.js";
import { warn } from "../ui/log.js";
import { createNativeReceiver } from "./darwin.js";
import { promptForCallback } from "./paste.js";

class CallbackTimeout extends Error {}

/**
 * Options: timeoutMs, allowNative, allowPaste, env, platform, onReady(mode).
 * Resolves with the raw pasted or captured text.
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
} = {}) {
  const nativeWanted = allowNative && platform === "darwin" && !flag(env, "ZCLAUDE_NO_NATIVE_CALLBACK");
  const pasteWanted = allowPaste && interactive;

  let native = null;
  if (nativeWanted) {
    try {
      native = await createNative({ scheme: CALLBACK_SCHEME, env, platform });
    } catch (error) {
      warn(`Automatic ${CALLBACK_SCHEME}:// capture is unavailable (${error.message}).`);
      if (!pasteWanted) throw error;
      warn("You will need to paste the redirect URL instead.");
    }
  }
  if (!native && !pasteWanted) {
    throw usageError(
      "No way to receive the authorization code: not running in an interactive terminal.",
      "Run `zclaude login` from a terminal, or set ZAI_API_KEY for non-interactive use.",
    );
  }

  onReady({ native: Boolean(native), paste: pasteWanted });

  const controller = new AbortController();
  const racers = [];
  if (native) racers.push(native.waitForCallback(controller.signal).then((value) => ({ value, from: "native" })));
  if (pasteWanted) racers.push(promptPaste({ signal: controller.signal }).then((value) => ({ value, from: "paste" })));
  let timer;
  racers.push(new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CallbackTimeout()), timeoutMs);
    timer.unref?.();
  }));

  const onSigint = () => controller.abort(new InterruptedError("Login cancelled."));
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);

  try {
    const winner = await Promise.race(racers);
    return winner;
  } catch (error) {
    if (error instanceof CallbackTimeout) {
      throw authError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser to finish signing in.`, "Run `zclaude login` again, or set ZCLAUDE_LOGIN_TIMEOUT to wait longer.");
    }
    if (controller.signal.aborted && controller.signal.reason instanceof InterruptedError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    if (!controller.signal.aborted) controller.abort(new InterruptedError("settled"));
    for (const racer of racers) racer.catch(() => {});
    if (native) await native.dispose().catch((error) => warn(`Cleanup of the ${CALLBACK_SCHEME}:// handler failed: ${error.message}`));
  }
}
