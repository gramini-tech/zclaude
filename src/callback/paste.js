// Fallback receiver: the user pastes the redirect URL (or bare code) into the
// terminal. Works on every platform and stays active alongside the native
// receiver on macOS.

import { input } from "@inquirer/prompts";

import { InterruptedError, isInterrupt } from "../errors.js";

export async function promptForCallback({ signal, message } = {}) {
  try {
    return await input(
      {
        message: message ?? "Paste the zcode://... URL from the browser (or just the code):",
        validate: (value) => (String(value).trim() ? true : "Paste the redirect URL or the authorization code."),
      },
      { signal, clearPromptOnDone: false },
    );
  } catch (error) {
    if (error?.name === "AbortPromptError") throw signal?.reason ?? new InterruptedError();
    if (isInterrupt(error)) throw new InterruptedError("Login cancelled.");
    throw error;
  }
}
