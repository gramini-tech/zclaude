// Who is using which account right now.
//
// The question the launcher wants answered is "would starting this profile be
// the second thing on that account", and the answer has three parts:
//
//   1. Sessions zclaude started. Recorded at launch, removed at exit, verified
//      against the process that claims to be them.
//   2. Sessions it did not. A plain `claude`, or the editor's extension. Their
//      config directory cannot be read from outside the process on macOS, but
//      they cannot have one — anything zclaude did not start is on the global
//      login, so it counts against whichever profile owns that.
//   3. How long each has been quiet, so an open-but-idle terminal is not
//      mistaken for one burning through the window.
//
// Honest limit: this is one machine. A session on your laptop is invisible to
// your desktop, and both spend the same account.

import { activityState, lastActivity } from "./activity.js";
import { claudeProcesses, stillRunning } from "./liveness.js";
import { forgetSession, readSessions } from "./store.js";

/**
 * @typedef {object} LiveSession
 * @property {string} id
 * @property {string} profile
 * @property {string} account
 * @property {number} pid
 * @property {string} cwd
 * @property {number} startedAt
 * @property {number} lastActiveAt 0 when nothing could be read
 * @property {"working" | "idle" | "unknown"} state
 * @property {boolean} tracked false for one zclaude did not start
 * @property {string | null} host the machine that started it
 * @property {boolean} auto whether it asked to be rotated between accounts
 * @property {boolean} [routed] whether it reaches Anthropic through the local router
 */

/**
 * Every session still running, with the dead records cleared away.
 *
 * Reaping happens here rather than in a sweeper because this is the moment
 * somebody is asking: a record whose process is gone is removed as it is
 * noticed, so the directory cannot grow without bound however many terminals
 * were closed with the window button.
 *
 * @param {{env?: NodeJS.ProcessEnv, now?: number, reap?: boolean}} [options]
 * @returns {Promise<LiveSession[]>}
 */
export async function liveSessions({ env = process.env, now = Date.now(), reap = true } = {}) {
  const records = await readSessions({ env });
  const checked = await Promise.all(records.map(async (record) => ({ record, alive: await stillRunning(record) })));
  const live = [];
  for (const { record, alive } of checked) {
    if (!alive) {
      if (reap) await forgetSession(record.id, { env });
      continue;
    }
    live.push(record);
  }
  const withActivity = await Promise.all(
    live.map(async (record) => {
      const lastActiveAt = await lastActivity(record);
      return {
        id: record.id,
        profile: record.profile,
        account: record.account ?? null,
        pid: record.pid,
        cwd: record.cwd,
        startedAt: record.startedAt,
        host: record.host ?? null,
        auto: record.auto === true,
        lastActiveAt,
        state: activityState(lastActiveAt, record.startedAt, now),
        tracked: true,
      };
    }),
  );
  return withActivity;
}

/**
 * Sessions zclaude did not start, which are all on the global login.
 * @param {{ours: LiveSession[], owner?: string | null, account?: string | null, psImpl?: (args: string[]) => Promise<string>}} args
 * @returns {Promise<LiveSession[]>}
 */
export async function untrackedSessions({ ours, owner = null, account = null, psImpl }) {
  const mine = new Set([process.pid, ...ours.map((session) => session.pid)]);
  const processes = await claudeProcesses(psImpl ? { psImpl } : {});
  return processes
    .filter((entry) => !mine.has(entry.pid))
    .map((entry) => ({
      id: `pid:${entry.pid}`,
      profile: owner,
      account,
      pid: entry.pid,
      cwd: null,
      // Nothing outside the process says when it last did anything, and its
      // transcript cannot be told from any other session's on the same login.
      startedAt: 0,
      host: null,
      // Never. A session zclaude did not start never asked to be rotated, and
      // this is the marker anything deciding whether it may move the global
      // login reads.
      auto: false,
      lastActiveAt: 0,
      state: "unknown",
      tracked: false,
    }));
}

/**
 * Sessions grouped by the profile they run as, for a list that has a row per
 * profile rather than a row per session.
 * @param {LiveSession[]} sessions
 * @returns {Map<string, {working: number, idle: number, unknown: number, total: number, newest: number}>}
 */
export function byProfile(sessions) {
  const counts = new Map();
  for (const session of sessions) {
    if (!session.profile) continue;
    const entry = counts.get(session.profile) ?? { working: 0, idle: 0, unknown: 0, total: 0, newest: 0 };
    entry[session.state] += 1;
    entry.total += 1;
    entry.newest = Math.max(entry.newest, session.lastActiveAt || session.startedAt);
    counts.set(session.profile, entry);
  }
  return counts;
}

/**
 * The one-word marker a menu row can carry: whether this account is busy, and
 * how busy. Nothing at all when it is free, because a marker on every row
 * carries no information.
 * @param {{working: number, idle: number, unknown: number, total: number} | undefined} counts
 */
export function busyMarker(counts) {
  if (!counts || counts.total === 0) return "";
  if (counts.working > 0) return counts.total > 1 ? `● ${counts.total} running` : "● running";
  if (counts.unknown > 0) return counts.total > 1 ? `○ ${counts.total} open` : "○ open";
  return counts.total > 1 ? `○ ${counts.total} idle` : "○ idle";
}
