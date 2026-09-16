#!/usr/bin/env node
// Entry point: runs the CLI and turns errors into exit codes.

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 17)) {
  process.stderr.write(`zclaude needs Node.js 20.17 or newer (found ${process.versions.node}).\n`);
  process.exit(2);
}

const { main } = await import("../src/cli.js");
const { EXIT, isInterrupt, ZclaudeError } = await import("../src/errors.js");
const { error: logError, isVerbose, warn } = await import("../src/ui/log.js");
const { redact } = await import("../src/redact.js");
const { log, logFilePath } = await import("../src/logger.js");

/** @param {any} error */
function handle(error) {
  if (isInterrupt(error)) {
    log.info("cli", "interrupted", { message: error?.message });
    process.stderr.write("\n");
    process.exitCode = EXIT.INTERRUPTED;
    return;
  }
  if (error instanceof ZclaudeError) {
    log.error("cli", "exiting with error", { exitCode: error.exitCode, error, cause: error.cause });
    logError(redact(error.message));
    if (error.hint) warn(redact(error.hint));
    if (isVerbose() && error.stack) process.stderr.write(`${redact(error.stack)}\n`);
    const { cause } = /** @type {{cause?: any}} */ (error);
    if (isVerbose() && cause?.stack) process.stderr.write(`caused by: ${redact(cause.stack)}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  log.error("cli", "unexpected error", { error });
  logError(`Unexpected error: ${redact(error?.message ?? String(error))}`);
  if (isVerbose() && error?.stack) process.stderr.write(`${redact(error.stack)}\n`);
  else warn("Re-run with --verbose for details.");
  process.exitCode = EXIT.INTERNAL;
}

process.on("unhandledRejection", (reason) => {
  handle(reason);
  process.exit(process.exitCode ?? EXIT.INTERNAL);
});

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = Number.isSafeInteger(code) ? code : EXIT.OK;
  log.info("cli", "run finished", { exitCode: process.exitCode });
} catch (error) {
  handle(error);
  if (logFilePath()) warn(`Run log: ${logFilePath()}`);
}
