export const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  NO_CLAUDE: 3,
  AUTH: 4,
  KEY_REJECTED: 5,
  NETWORK: 6,
  INTERRUPTED: 130,
});

export class ZclaudeError extends Error {
  constructor(message, { exitCode = EXIT.INTERNAL, hint, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ZclaudeError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export const usageError = (message, hint) => new ZclaudeError(message, { exitCode: EXIT.USAGE, hint });
export const authError = (message, hint, cause) => new ZclaudeError(message, { exitCode: EXIT.AUTH, hint, cause });
export const keyRejectedError = (message, hint) => new ZclaudeError(message, { exitCode: EXIT.KEY_REJECTED, hint });
export const networkError = (message, hint, cause) =>
  new ZclaudeError(message, { exitCode: EXIT.NETWORK, hint, cause });
export const noClaudeError = (message, hint) => new ZclaudeError(message, { exitCode: EXIT.NO_CLAUDE, hint });

export class InterruptedError extends ZclaudeError {
  constructor(message = "Interrupted.") {
    super(message, { exitCode: EXIT.INTERRUPTED });
    this.name = "InterruptedError";
  }
}

/** True for Ctrl-C style aborts from inquirer, AbortSignal, or our own class. */
export function isInterrupt(error) {
  if (!error) return false;
  return Boolean(
    error instanceof InterruptedError ||
    error.name === "ExitPromptError" ||
    (error.name === "AbortError" && error.interrupted),
  );
}
