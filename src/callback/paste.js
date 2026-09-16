// Fallback receiver: the user pastes the redirect URL (or bare code) into the
// terminal. Works on every platform and stays active alongside the native
// receiver on macOS.

import { input } from "@inquirer/prompts";

import { InterruptedError } from "../errors.js";
import { guard, withSignal } from "../ui/prompt.js";

/**
 * @param {{signal?: AbortSignal, message?: string}} [options]
 * @returns {Promise<string>}
 */
export async function promptForCallback({ signal, message } = {}) {
  try {
    return await guard(
      input(
        {
          message: message ?? "Paste the zcode://... URL from the browser (or just the code):",
          validate: (value) => (String(value).trim() ? true : "Paste the redirect URL or the authorization code."),
        },
        { signal: withSignal(signal), clearPromptOnDone: false },
      ),
    );
  } catch (error) {
    // A race settled by another receiver aborts this prompt through `signal`;
    // surface that reason rather than a generic cancellation.
    if (error instanceof InterruptedError && signal?.aborted) throw signal.reason ?? error;
    throw error;
  }
}
