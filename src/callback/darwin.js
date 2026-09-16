// macOS native receiver for the zcode:// OAuth redirect.
//
// Z.ai only allows the zcode:// custom scheme as redirect target. On macOS we
// can own that scheme for the duration of one login: compile a tiny
// background-only AppleScript app whose `open location` handler writes the
// URL to a private file, register it with LaunchServices as the default
// handler, wait for the file, then put the previous handler back and delete
// the app. A recovery journal lets the next run clean up if this one dies
// half-way (power loss, kill -9).

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve as resolvePath, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { zclaudeHome } from "../config.js";
import { InterruptedError, ZclaudeError } from "../errors.js";
import { debug } from "../ui/log.js";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const OSASCRIPT = "/usr/bin/osascript";
const OSACOMPILE = "/usr/bin/osacompile";
const PLUTIL = "/usr/bin/plutil";

export const BUNDLE_PREFIX = "dev.zclaude.oauth-callback.";
export const APP_PREFIX = "zclaude OAuth Callback ";
const JOURNAL_NAME = "oauth-handler-recovery.json";

const currentHandlerJxa = String.raw`
ObjC.import("AppKit");
function run(argv) {
  const url = $.NSURL.URLWithString(argv[0] + "://");
  const appUrl = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url);
  if (!appUrl || appUrl.isNil()) return "";
  const bundle = $.NSBundle.bundleWithURL(appUrl);
  return !bundle || bundle.isNil() ? "" : ObjC.unwrap(bundle.bundleIdentifier);
}
`;

const setHandlerJxa = String.raw`
ObjC.import("CoreServices");
function run(argv) {
  return String(Number($.LSSetDefaultHandlerForURLScheme($(argv[0]), $(argv[1]))));
}
`;

function defaultRunner(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || (error && typeof error.code !== "number" ? error.message : ""),
      });
    });
  });
}

async function checkedRun(runner, command, args, step) {
  const result = await runner(command, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `status ${result.code}`;
    throw new Error(`${step}: ${basename(command)} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function currentHandler(runner, scheme) {
  return checkedRun(
    runner,
    OSASCRIPT,
    ["-l", "JavaScript", "-e", currentHandlerJxa, scheme],
    "reading the current URL handler",
  );
}

async function setHandler(runner, scheme, bundleId, step = "registering the callback handler") {
  const status = await checkedRun(
    runner,
    OSASCRIPT,
    ["-l", "JavaScript", "-e", setHandlerJxa, scheme, bundleId || "none"],
    step,
  );
  if (status !== "0") throw new Error(`${step}: LSSetDefaultHandlerForURLScheme returned ${status}`);
}

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/** AppleScript source lines for the callback app. Exported for tests. */
export function callbackAppleScript(callbackPath, scheme, previousHandler) {
  const restoreCommand = [OSASCRIPT, "-l", "JavaScript", "-e", setHandlerJxa, scheme, previousHandler || "none"]
    .map(shellQuote)
    .join(" ");
  return [
    "on open location theURL",
    `set outputFile to POSIX file ${appleScriptString(callbackPath)}`,
    "try",
    "set fileHandle to open for access outputFile with write permission",
    "set eof fileHandle to 0",
    "write theURL to fileHandle as «class utf8»",
    "close access fileHandle",
    "on error",
    "try",
    "close access outputFile",
    "end try",
    "end try",
    "try",
    `do shell script ${appleScriptString(restoreCommand)}`,
    "end try",
    "quit",
    "end open location",
  ];
}

export function journalPath(env = process.env) {
  return join(zclaudeHome(env), JOURNAL_NAME);
}

function applicationsDir(home) {
  return join(home, "Applications");
}

/** Only trust journal entries that point at things we created. */
export function isManagedJournal(record, home) {
  if (!record || typeof record !== "object") return false;
  const { appPath, bundleId, pid, previousHandler, scheme } = record;
  if (
    typeof appPath !== "string" ||
    typeof bundleId !== "string" ||
    typeof pid !== "number" ||
    typeof previousHandler !== "string" ||
    typeof scheme !== "string"
  )
    return false;
  const root = `${resolvePath(applicationsDir(home))}${sep}`;
  return (
    resolvePath(appPath).startsWith(root) &&
    basename(appPath).startsWith(APP_PREFIX) &&
    bundleId.startsWith(BUNDLE_PREFIX)
  );
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readJournal(path, home) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isManagedJournal(parsed, home) ? parsed : null;
  } catch {
    return null;
  }
}

/** Should a restore put back `previous`, or clear the handler entirely? */
export function restoreTarget(previous) {
  // Our own leftovers, or other tools' temporary handlers (oh-my-pi, zcode-cli)
  // that are gone by now, must not be re-registered.
  const isTemporary =
    !previous || previous.startsWith(BUNDLE_PREFIX) || /^dev\.(omp|zcode\.cli)\.oauth-callback\./u.test(previous);
  return isTemporary ? "none" : previous;
}

async function unregisterApp(runner, appPath) {
  await runner(LSREGISTER, ["-u", appPath]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
}

/**
 * Clean up after a previous login that did not finish. Throws when another
 * zclaude login is still alive and waiting.
 */
export async function recoverStaleHandler({ env = process.env, home = homedir(), runner = defaultRunner } = {}) {
  const path = journalPath(env);
  const record = await readJournal(path, home);
  if (!record) {
    await rm(path, { force: true });
    return;
  }
  if (record.pid !== process.pid && processAlive(record.pid)) {
    throw new ZclaudeError(`Another zclaude login (pid ${record.pid}) is already waiting for the browser.`, {
      hint: "Finish or cancel that login first.",
    });
  }
  debug(`Cleaning up stale OAuth handler ${record.bundleId}`);
  const current = await currentHandler(runner, record.scheme).catch(() => "");
  if (current === record.bundleId) {
    await setHandler(
      runner,
      record.scheme,
      restoreTarget(record.previousHandler),
      "restoring the previous URL handler",
    ).catch(() => {});
  }
  await unregisterApp(runner, record.appPath);
  await rm(record.appPath, { recursive: true, force: true });
  await rm(path, { force: true });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new InterruptedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new InterruptedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create the receiver. Resolves to { waitForCallback(signal), dispose() }.
 * Throws when any setup step fails; the caller then falls back to pasting.
 * @param {{scheme: string, env?: NodeJS.ProcessEnv, home?: string, runner?: typeof defaultRunner, platform?: NodeJS.Platform}} options
 */
export async function createNativeReceiver({
  scheme,
  env = process.env,
  home = homedir(),
  runner = defaultRunner,
  platform = process.platform,
}) {
  if (platform !== "darwin") throw new Error("native scheme capture is only available on macOS");
  if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) throw new Error(`invalid scheme "${scheme}"`);

  await recoverStaleHandler({ env, home, runner });

  const nonce = randomUUID().replaceAll("-", "");
  const bundleId = `${BUNDLE_PREFIX}${nonce}`;
  const appPath = join(applicationsDir(home), `${APP_PREFIX}${nonce.slice(0, 10)}.app`);
  const tempDir = await mkdtemp(join(tmpdir(), "zclaude-oauth-"));
  const callbackFile = join(tempDir, "callback.url");
  const journal = journalPath(env);
  let previousHandler = "";
  let handlerChanged = false;
  let disposed = false;

  const cleanup = async () => {
    const current = await currentHandler(runner, scheme).catch(() => "");
    if (handlerChanged && current === bundleId) {
      await setHandler(runner, scheme, restoreTarget(previousHandler), "restoring the previous URL handler").catch(
        () => {},
      );
    }
    await unregisterApp(runner, appPath);
    await rm(appPath, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
    const record = await readJournal(journal, home);
    if (record?.bundleId === bundleId) await rm(journal, { force: true });
  };

  try {
    previousHandler = await currentHandler(runner, scheme);
    debug(`Current ${scheme}:// handler: ${previousHandler || "(none)"}`);
    await mkdir(applicationsDir(home), { recursive: true });
    await mkdir(zclaudeHome(env), { recursive: true, mode: 0o700 });
    await writeFile(callbackFile, "", { mode: 0o600 });
    await chmod(callbackFile, 0o600);

    const scriptLines = callbackAppleScript(callbackFile, scheme, restoreTarget(previousHandler));
    const compileArgs = ["-o", appPath, ...scriptLines.flatMap((line) => ["-e", line])];
    await checkedRun(runner, OSACOMPILE, compileArgs, "compiling the callback app");
    const plist = join(appPath, "Contents", "Info.plist");
    await checkedRun(
      runner,
      PLUTIL,
      ["-insert", "CFBundleIdentifier", "-string", bundleId, plist],
      "setting CFBundleIdentifier",
    );
    await checkedRun(runner, PLUTIL, ["-insert", "LSUIElement", "-bool", "true", plist], "setting LSUIElement");
    await checkedRun(runner, LSREGISTER, ["-f", appPath], "registering the callback app");

    await writeFile(
      journal,
      `${JSON.stringify({ appPath, bundleId, pid: process.pid, previousHandler, scheme }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await setHandler(runner, scheme, bundleId);
    handlerChanged = true;
    debug(`Registered ${bundleId} as the ${scheme}:// handler`);
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }

  return {
    bundleId,
    appPath,
    async waitForCallback(signal) {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new InterruptedError();
        const text = await readFile(callbackFile, "utf8").catch(() => "");
        if (text.trim()) return text.trim();
        await sleep(250, signal);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await cleanup();
    },
  };
}
