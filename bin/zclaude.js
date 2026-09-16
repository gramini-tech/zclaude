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
const { redact } = await import("../src/http.js");

function handle(error) {
  if (isInterrupt(error)) {
    process.stderr.write("\n");
    process.exitCode = EXIT.INTERRUPTED;
    return;
  }
  if (error instanceof ZclaudeError) {
    logError(redact(error.message));
    if (error.hint) warn(redact(error.hint));
    if (isVerbose() && error.stack) process.stderr.write(`${redact(error.stack)}\n`);
    if (isVerbose() && error.cause?.stack) process.stderr.write(`caused by: ${redact(error.cause.stack)}\n`);
    process.exitCode = error.exitCode;
    return;
  }
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
} catch (error) {
  handle(error);
}
