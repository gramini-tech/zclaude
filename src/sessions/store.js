// What is running, and on whose account.
//
// One file per session under ~/.zclaude/sessions, not one shared list. Two
// terminals starting at the same moment would race for a shared file and one
// would lose; a crash mid-write would corrupt it for everyone. A file per
// session makes a start an atomic create, an exit an unlink, and the worst
// outcome of a kill -9 a single orphan that the next reader clears up.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { zclaudeHome } from "../config.js";
import { log } from "../logger.js";

const RECORD_VERSION = 1;

export function sessionsDir(env = process.env) {
  return join(zclaudeHome(env), "sessions");
}

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} profile the profile id this session runs as
 * @property {string} account what to show for it, captured at launch
 * @property {number} pid
 * @property {string} [startToken] the child's own start time, against PID reuse
 * @property {string} configDir
 * @property {string} cwd
 * @property {string} host
 * @property {number} startedAt
 * @property {boolean} [auto] this session asked to be rotated between accounts
 * @property {boolean} [routed] this session talks to the local router, so it
 *   holds no OAuth credential of its own and is not a refresher
 */

// Extra keys are added to version 1 rather than bumping it. `readSessions`
// discards any record whose version it does not recognise, so an older zclaude
// on the same machine would stop reaping new records and leave orphans that
// make every account look permanently busy.

/**
 * Write the record for a session that is starting.
 * @param {Omit<SessionRecord, "id" | "host" | "startedAt">} fields
 * @param {{env?: NodeJS.ProcessEnv, now?: number, id?: string}} [options]
 * @returns {Promise<SessionRecord | null>} null when it could not be recorded
 */
export async function recordSession(fields, { env = process.env, now = Date.now(), id = randomUUID() } = {}) {
  const record = { version: RECORD_VERSION, id, host: hostname(), startedAt: now, ...fields };
  try {
    const dir = sessionsDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return record;
  } catch (error) {
    // Tracking is an aid, never a gate: a session that cannot be recorded still
    // runs, it just does not show up in the list.
    log.warn("sessions", "session not recorded", { error });
    return null;
  }
}

/**
 * Forget a session. Called when the child exits, and again by the reaper for
 * anything that never got the chance.
 * @param {string} id
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 */
export async function forgetSession(id, { env = process.env } = {}) {
  await rm(join(sessionsDir(env), `${id}.json`), { force: true }).catch((error) =>
    log.debug("sessions", "session file not removed", { id, error }),
  );
}

/**
 * Every recorded session, whether or not it is still running.
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<SessionRecord[]>}
 */
export async function readSessions({ env = process.env } = {}) {
  const dir = sessionsDir(env);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") log.debug("sessions", "sessions directory unreadable", { error });
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
          return parsed?.version === RECORD_VERSION && typeof parsed.id === "string" ? parsed : null;
        } catch (error) {
          // A half-written file from a machine that lost power. It names no
          // session that is still running, so it goes.
          log.debug("sessions", "unreadable session file removed", { name, error });
          await rm(join(dir, name), { force: true }).catch(() => {});
          return null;
        }
      }),
  );
  // Oldest first, and by id when two started in the same millisecond, so the
  // order does not depend on whatever readdir happened to return.
  return records.filter(Boolean).toSorted((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}
