// `zclaude sessions`: what is running, on which account, and whether it is
// doing anything.
//
// The point is not bookkeeping. Two terminals on one account share its
// five-hour window, so before starting a third it is worth knowing that two are
// already there and one of them has been asleep since lunch.

import { EXIT } from "./errors.js";
import { accountLabel } from "./profiles/probe.js";
import { byProfile, liveSessions, untrackedSessions } from "./sessions/index.js";
import { swapStatus } from "./swap/index.js";
import { elapsed } from "./usage/when.js";
import { info, paint } from "./ui/log.js";

const STATE_TEXT = Object.freeze({
  working: "active",
  idle: "idle",
  unknown: "not tracked (outside zclaude)",
});

/**
 * Everything running, ours and otherwise.
 * @param {{env?: NodeJS.ProcessEnv, now?: number, security?: object, psImpl?: (args: string[]) => Promise<string>}} [options]
 */
export async function collectSessions({ env = process.env, now = Date.now(), security, psImpl } = {}) {
  const ours = await liveSessions({ env, now });
  // Anything zclaude did not start is on the global login, so who holds that
  // decides which account those sessions are spending.
  const status = await swapStatus({ env, security }).catch(() => null);
  const others = await untrackedSessions({
    ours,
    owner: status?.owner ?? null,
    account: accountLabel(status?.account) ?? null,
    psImpl,
  });
  return [...ours, ...others];
}

/**
 * @param {{options: object, env: NodeJS.ProcessEnv}} context
 * @param {{now?: number, security?: object, psImpl?: (args: string[]) => Promise<string>}} [deps]
 */
export async function cmdSessions({ options, env }, { now = Date.now(), security, psImpl } = {}) {
  const sessions = await collectSessions({ env, now, security, psImpl });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ sessions, byProfile: [...byProfile(sessions)] }, null, 2)}\n`);
    return EXIT.OK;
  }
  if (sessions.length === 0) {
    info("Nothing is running.");
    info("Sessions started by zclaude are tracked here; this machine only.");
    return EXIT.OK;
  }
  const grey = (text) => paint(text, "grey", process.stdout);
  const width = Math.max(...sessions.map((session) => (session.profile ?? "unknown").length), 7);
  for (const session of sessions) {
    const name = (session.profile ?? "unknown").padEnd(width);
    const state = STATE_TEXT[session.state] ?? session.state;
    const last = session.tracked ? elapsed(session.lastActiveAt || session.startedAt, now) : "";
    const where = session.cwd ? grey(` ${session.cwd}`) : "";
    // A routed session is not spending the account its profile names, so the
    // profile column alone would mislead anybody reading this to decide where
    // to start the next one.
    const via = session.routed ? grey(" routed") : "";
    process.stdout.write(
      `${name}  ${state.padEnd(22)} ${grey(`pid ${String(session.pid).padEnd(7)}`)}${last ? grey(last.padEnd(10)) : " ".repeat(10)}${via}${where}\n`,
    );
  }
  const counts = byProfile(sessions);
  const crowded = [...counts].filter(([, entry]) => entry.total > 1);
  if (crowded.length > 0) {
    info("");
    for (const [profile, entry] of crowded) {
      info(`"${profile}" is running ${entry.total} sessions, which share one account's limits.`);
    }
  }
  if (sessions.some((session) => session.routed)) {
    info("");
    info("A routed session picks its account per request, so its profile name is where it started, not where it is.");
    info("`zclaude router log` says where each request actually went.");
  }
  return EXIT.OK;
}
