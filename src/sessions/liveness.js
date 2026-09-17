// Is that session still running, and is it still the same one?
//
// A PID alone is not an answer. Process ids are recycled, and a record written
// three days ago can name a pid that now belongs to somebody's text editor.
// Every record therefore carries the child's own start time, and a session
// counts as alive only when the pid exists *and* still started when we say it
// did. Without that, a stale record would quietly claim an account is busy and
// the whole feature would be worse than not having it.

import { execFile } from "node:child_process";

import { log } from "../logger.js";

/** `ps` for one pid, or for everything, without a shell in the way. */
function ps(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile("ps", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : String(stdout ?? ""));
    });
  });
}

/**
 * A stable-enough identity for a running process: when it started, as `ps`
 * reports it. Seconds resolution is plenty — a recycled pid that started in the
 * same second as the one we recorded is not a case worth engineering for.
 * @param {number} pid
 * @param {{psImpl?: typeof ps}} [options]
 * @returns {Promise<string | null>}
 */
export async function startToken(pid, { psImpl = ps } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const out = await psImpl(["-o", "lstart=", "-p", String(pid)]);
  const line = out.split("\n", 1)[0]?.trim();
  return line || null;
}

/** Does this pid exist at all? Cheap, and answers before `ps` is asked. */
export function pidExists(pid, { kill = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which for our own
    // sessions cannot happen, but "it exists" is still the honest reading.
    return error?.code === "EPERM";
  }
}

/**
 * Whether a recorded session is the process it claims to be.
 * @param {{pid: number, startToken?: string}} record
 * @param {{kill?: typeof process.kill, psImpl?: typeof ps}} [options]
 * @returns {Promise<boolean>}
 */
export async function stillRunning(record, options = {}) {
  if (!pidExists(record?.pid, options)) return false;
  // An older record without a token is trusted on the pid alone rather than
  // discarded: it was written by a version that did not capture one.
  if (!record.startToken) return true;
  const token = await startToken(record.pid, options);
  // Not a secret comparison: this is a timestamp printed by `ps`.
  return token !== null && token === record.startToken;
}

/** The claude CLI, as opposed to the desktop app or a helper that never ends. */
const CLAUDE_CLI = /(^|\/)claude(\.js)?(\s|$)/u;
const NOT_A_SESSION = ["--chrome-native-host", "mcp serve", "--version", "auth "];

/**
 * Every claude CLI process running for this user, as {pid, command}. Used to
 * notice the sessions zclaude did not start: a plain `claude` in another
 * terminal, or the editor's extension. Those all use the *global* login, which
 * is what makes them attributable at all — their config directory is not
 * readable from outside the process on macOS, but they cannot have one.
 * @param {{psImpl?: (args: string[]) => Promise<string>}} [options]
 */
export async function claudeProcesses({ psImpl = ps } = {}) {
  const out = await psImpl(["-axo", "pid=,command="]);
  const found = [];
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d{1,10}) (.*)$/u);
    if (!match) continue;
    const [, pid, command] = match;
    const isSession =
      !command.includes("Claude.app") &&
      CLAUDE_CLI.test(command) &&
      NOT_A_SESSION.every((marker) => !command.includes(marker));
    if (!isSession) continue;
    found.push({ pid: Number(pid), command });
  }
  log.debug("sessions", "claude processes seen", { count: found.length });
  return found;
}
