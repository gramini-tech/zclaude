// When a session last did any work.
//
// A terminal sitting open all afternoon costs an account nothing; one answering
// questions costs it a lot. Telling them apart needs a signal from Claude Code
// itself, and the honest one is its transcript: it appends to
// `<configDir>/projects/<slug>/<session>.jsonl` as the conversation goes, so
// that file's mtime is the last time the account actually did something.
//
// Measured against a live session: the transcript's mtime moved within three
// seconds of the exchange. Nothing else available from outside the process
// comes close — cpu time is noise, and the usage endpoint answers per account
// rather than per session and costs a request to ask.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../logger.js";

/** A session quiet for longer than this is resting rather than working. */
export const IDLE_AFTER_MS = 5 * 60 * 1000;

/**
 * Claude Code's directory name for a working directory: every character that
 * is not a letter or a digit becomes a dash. Derived from the directories on
 * this machine (`/Users/vipinr/work/vipinr/zclaude` →
 * `-Users-vipinr-work-vipinr-zclaude`), so a miss is possible and is treated as
 * one rather than trusted.
 * @param {string} cwd
 */
export function projectSlug(cwd) {
  return String(cwd ?? "").replaceAll(/[^a-zA-Z0-9]/gu, "-");
}

async function newestIn(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const times = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        try {
          return (await stat(join(dir, name))).mtimeMs;
        } catch {
          return 0;
        }
      }),
  );
  return times.length === 0 ? 0 : Math.max(...times);
}

/**
 * The last time this session's account wrote a transcript, as epoch ms, or 0.
 *
 * The session's own working directory is looked at first, which is one small
 * directory rather than the whole tree. Only when that name does not exist —
 * a slug rule that has moved on, or a session that changed directory — does it
 * fall back to scanning every project, and that is capped.
 *
 * @param {{configDir: string, cwd: string}} record
 * @param {{maxProjects?: number}} [options]
 */
export async function lastActivity(record, { maxProjects = 40 } = {}) {
  const projects = join(record?.configDir ?? "", "projects");
  const own = await newestIn(join(projects, projectSlug(record?.cwd)));
  if (own > 0) return own;
  let names;
  try {
    names = await readdir(projects);
  } catch (error) {
    log.debug("sessions", "no projects directory", { error });
    return 0;
  }
  const times = await Promise.all(names.slice(0, maxProjects).map((name) => newestIn(join(projects, name))));
  return times.length === 0 ? 0 : Math.max(...times);
}

/**
 * What to call a live session, given when it last wrote anything.
 * @param {number} lastActiveAt epoch ms, 0 when unknown
 * @param {number} startedAt epoch ms
 * @param {number} [now]
 * @returns {"working" | "idle"}
 */
export function activityState(lastActiveAt, startedAt, now = Date.now()) {
  const at = lastActiveAt > 0 ? lastActiveAt : startedAt;
  return now - at < IDLE_AFTER_MS ? "working" : "idle";
}
