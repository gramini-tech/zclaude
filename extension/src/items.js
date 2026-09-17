// Turning zclaude's JSON into what the status bar, its hover and the list show.
//
// Pure: no VS Code, no child processes. The extension is mostly this plus
// plumbing, so this is where the tests are.
//
// One constraint shapes all of it. The list and the status bar are drawn in the
// editor's UI font, which is proportional and offers no styling hook, so
// nothing there can be lined up or drawn as a gauge: blocks are proportional
// too, and rules render as one unbroken line whatever their value. Inside a
// fenced block in the hover the font is fixed. So the numbers go in the list,
// and the picture goes in the hover.

"use strict";

/** The first zclaude that has `switch`, `--json` status and usage. */
const MINIMUM_ZCLAUDE = "0.2.18";

const ACTIONS = Object.freeze({
  refresh: "zclaude.action.refresh",
  add: "zclaude.action.add",
  remove: "zclaude.action.remove",
  restore: "zclaude.action.restore",
});

/**
 * -1, 0 or 1, comparing dotted versions numerically. "0.2.9" is older than
 * "0.2.10", which a string comparison gets backwards.
 */
function compareVersions(a, b) {
  const parts = (text) =>
    String(text ?? "")
      .split(".")
      .map((part) => Number(part) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** Does this zclaude have what the extension needs? */
function isSupported(version) {
  return Boolean(version) && compareVersions(version, MINIMUM_ZCLAUDE) >= 0;
}

/** What to say about a zclaude that predates this extension. */
function outdatedText(version) {
  return version
    ? `zclaude ${version} is older than ${MINIMUM_ZCLAUDE}, which is what this needs to switch accounts.`
    : `This needs zclaude ${MINIMUM_ZCLAUDE} or newer.`;
}

/**
 * The account line for a profile, as `zclaude profile list --json` gives it.
 * A Z.ai profile has no Anthropic login, so zclaude reports it as signed out;
 * saying that here would be wrong, since its key is somewhere else entirely.
 */
function accountOf(profile) {
  if (profile.provider === "zai") return "Z.ai coding plan";
  if (profile.account) return profile.account;
  if (profile.identity?.email) return profile.identity.email;
  return "signed out";
}

const STATES = {
  unauthorized: "sign in to see usage",
  dead: "login expired",
  throttled: "usage rate limited",
  offline: "usage unavailable",
  unknown: "",
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long until a window resets: "2h 8m", "45m", "6d 4h". This mirrors
 * src/usage/when.js rather than importing it — the extension is a separate
 * CommonJS bundle with no build step, so it cannot reach into the CLI's ESM.
 * @param {number | null} at epoch milliseconds, as zclaude's JSON carries it
 */
function countdown(at, now = Date.now()) {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const left = at - now;
  if (left < 0) return "";
  if (left < MINUTE) return "now";
  if (left < HOUR) return `${Math.round(left / MINUTE)}m`;
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.round((left % HOUR) / MINUTE);
    return minutes === 0 || minutes === 60 ? `${hours + (minutes === 60 ? 1 : 0)}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(left / DAY);
  const hours = Math.round((left % DAY) / HOUR);
  return hours === 0 || hours === 24 ? `${days + (hours === 24 ? 1 : 0)}d` : `${days}d ${hours}h`;
}

/** The reset as a local wall-clock time, in this machine's zone and locale. */
function localTime(at, now = Date.now()) {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
  const day = new Intl.DateTimeFormat("en-CA", { dateStyle: "short" });
  if (day.format(at) === day.format(now)) return time;
  const date = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(at);
  return `${date}, ${time}`;
}

/**
 * Whether this account already has something running. Mirrors busyMarker in
 * src/sessions/index.js, using the counts zclaude sends in its JSON.
 */
function busyText(counts) {
  if (!counts || !counts.total) return "";
  if (counts.working > 0)
    return counts.total > 1 ? `$(circle-filled) ${counts.total} running` : "$(circle-filled) running";
  if (counts.unknown > 0) return counts.total > 1 ? `$(circle-outline) ${counts.total} open` : "$(circle-outline) open";
  return counts.total > 1 ? `$(circle-outline) ${counts.total} idle` : "$(circle-outline) idle";
}

/** What is left to spend beyond the plan, when the account has that switched on. */
function creditsText(credits) {
  if (!credits) return "";
  if (credits.enabled) {
    if (credits.remaining === null || credits.remaining === undefined) return "credits on";
    const amount = credits.remaining.toFixed(2);
    return `credits ${credits.currency === "USD" ? `$${amount}` : `${amount} ${credits.currency ?? ""}`.trim()} left`;
  }
  if (credits.spendLimitReached) return "credit limit reached";
  return credits.reason === "out_of_credits" ? "credits spent" : "";
}

/**
 * A window in the list: the number, and nothing else.
 *
 * The list gives each row one short line in a proportional font. Anything more
 * there either says nothing, like a gauge that cannot render, or runs off the
 * end and is clipped, like a clock after every window. Both belong in the
 * hover, which is wide, fixed-width and can hold them.
 */
function windowText(label, window) {
  return window ? `${label} ${Math.round(window.pct)}%` : null;
}

/** "5h 12% · wk 61% · Fable 91%", or why there are no numbers. */
function usageText(usage) {
  if (!usage) return "";
  if (Object.hasOwn(STATES, usage.state)) return STATES[usage.state];
  const parts = [
    windowText("5h", usage.fiveHour),
    windowText("wk", usage.weekly),
    ...(usage.scoped ?? []).map((scope) => windowText(scope.name, scope)),
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return usage.state === "stale" ? `${parts.join(" · ")} (cached)` : parts.join(" · ");
}

const CELLS = 10;
const FULL = "█";
const EMPTY = "░";
/** A gauge cell plus " 100%": the width every window column is laid out to. */
const COLUMN = CELLS + 5;

/**
 * A window as a bar — for the fenced block in the hover, and nowhere else.
 *
 * Blocks are a gauge only where the font is fixed. In the list they are
 * proportional and say nothing about their value; an earlier attempt used
 * heavy and light rules there, and they rendered as one unbroken line whatever
 * the number, which is worse than showing no gauge at all.
 */
function gauge(pct, cells = CELLS) {
  const clamped = Math.min(100, Math.max(0, pct));
  // Anything spent at all shows a cell: an empty bar beside "5%" reads as a
  // rounding bug rather than as a nearly-untouched window.
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * cells));
  return `${FULL.repeat(filled)}${EMPTY.repeat(cells - filled)}`;
}

/** Every window a column is needed for, in the order they first appear. */
function windowNames(profiles, usage) {
  const models = [];
  for (const profile of profiles) {
    const scopes = usage[profile.name]?.scoped ?? [];
    for (const scope of scopes) {
      if (!models.includes(scope.name)) models.push(scope.name);
    }
  }
  return ["5-hour", "week", ...models];
}

function windowOf(own, name) {
  if (name === "5-hour") return own?.fiveHour ?? null;
  if (name === "week") return own?.weekly ?? null;
  return (own?.scoped ?? []).find((scope) => scope.name === name) ?? null;
}

/** The gauge and the number for one cell, or a dash holding the column open. */
function cell(window) {
  if (!window) return "–".padStart(Math.round(COLUMN / 2)).padEnd(COLUMN);
  return `${gauge(window.pct)}${String(Math.round(window.pct)).padStart(4)}%`;
}

/**
 * The table: a row per profile, a column per window, and the reset time of
 * whichever window is closest to stopping you.
 * @param {{profiles: Array<object>, usage: Record<string, object>, busy: Record<string, object>, active: string | null, now?: number}} args
 */
function usageTable({ profiles, usage = {}, busy = {}, active = null, now = Date.now() }) {
  if (profiles.length === 0) return "";
  const names = windowNames(profiles, usage);
  const rows = profiles.map((profile) => {
    const own = usage[profile.name];
    const stopped = Object.hasOwn(STATES, own?.state) ? STATES[own.state] || "no usage" : "";
    const windows = names.map((name) => windowOf(own, name));
    const worst = windows.filter(Boolean).toSorted((a, b) => b.pct - a.pct)[0];
    const counts = busy[profile.name];
    const cells = stopped ? [stopped, ...names.slice(1).map(() => "")] : windows.map((window) => cell(window));
    return [
      profile.name === active ? "›" : " ",
      profile.name,
      ...cells,
      stopped ? "" : countdown(worst?.resetsAt, now),
      counts?.total ? `${counts.total} ${counts.working > 0 ? "active" : "open"}` : "",
    ];
  });
  const head = ["", "profile", ...names.map((name) => name.padEnd(COLUMN)), "resets", "sessions"];
  const widths = head.map((_, column) => Math.max(head[column].length, ...rows.map((row) => row[column].length)));
  const lay = (row) => row.map((text, column) => text.padEnd(widths[column])).join("  ");
  return [lay(head), ...rows.map((row) => lay(row))].map((line) => line.trimEnd()).join("\n");
}

/**
 * The hover panel: every account, its windows and its sessions, laid out.
 *
 * The fenced block is the whole trick. The rest of a hover is rendered in the
 * UI font, which lines nothing up; inside a fence it is monospace, so a space
 * is a space, columns are columns and a run of blocks is a gauge.
 */
function hoverPanel({ status, profiles = [], usage = {}, busy = {}, version, now = Date.now() }) {
  const lines = ["**zclaude** — the Claude Code account every terminal and this editor use", ""];
  if (version !== undefined && !isSupported(version)) {
    lines.push(outdatedText(version), "", "[Update zclaude](command:zclaude.pick)");
    return lines.join("\n");
  }
  if (status?.account?.email) {
    const org = status.account.organization ? ` · ${status.account.organization}` : "";
    lines.push(`Signed in as **${status.account.email}**${org}`);
  } else if (status?.unreadable) {
    lines.push(`The credential could not be read: ${status.unreadable}`);
  } else {
    lines.push("Nobody is signed in.");
  }
  const table = usageTable({ profiles, usage, busy, active: status?.owner ?? null, now });
  if (table) lines.push("", "```", table, "```");
  const credit = profiles.map((profile) => creditsText(usage[profile.name]?.credits)).find(Boolean);
  if (credit) lines.push("", credit);
  lines.push("", "[Switch account](command:zclaude.pick) · [Refresh usage](command:zclaude.refresh)");
  return lines.join("\n");
}

/**
 * The status bar: whose account this is, behind the name of the thing showing
 * it. The name comes first because a status bar is a row of other people's
 * icons, and a generic person glyph with an address beside it identifies
 * nothing.
 */
function statusBarText(status, version) {
  if (version !== undefined && !isSupported(version)) return "zc $(warning)";
  if (!status) return "zc";
  if (status.unreadable) return "zc $(warning)";
  const email = status.account?.email;
  if (!email) return "zc $(circle-slash)";
  return `zc $(account) ${email.split("@", 1)[0]}`;
}

/**
 * The picker's contents: every profile, then the things you can do.
 * @param {{profiles?: Array<object>, active?: string | null, usage?: Record<string, object>, loading?: boolean, busy?: Record<string, object>}} args
 */
function quickPickItems({ profiles = [], active = null, usage = {}, loading = false, busy = {} }) {
  const rows = profiles.map((profile) => {
    const current = profile.name === active;
    const numbers = usageText(usage[profile.name]);
    const running = busyText(busy[profile.name]);
    return {
      label: `${current ? "$(check) " : "$(blank) "}${profile.name}`,
      description: [accountOf(profile), running].filter(Boolean).join(" ".repeat(3)),
      detail: numbers || (loading ? "$(sync~spin) checking usage…" : ""),
      profile: profile.name,
      picked: current,
      switchable: profile.provider !== "zai" && !current,
    };
  });
  return [
    ...rows,
    { label: "", kind: -1 },
    { label: "$(sync) Refresh usage", action: ACTIONS.refresh },
    { label: "$(add) Add a profile…", action: ACTIONS.add, detail: "opens a terminal: signing in needs one" },
    { label: "$(trash) Remove a profile…", action: ACTIONS.remove },
    { label: "$(history) Restore the previous login", action: ACTIONS.restore },
  ];
}

module.exports = {
  ACTIONS,
  accountOf,
  busyText,
  compareVersions,
  countdown,
  creditsText,
  gauge,
  hoverPanel,
  isSupported,
  localTime,
  MINIMUM_ZCLAUDE,
  outdatedText,
  quickPickItems,
  statusBarText,
  usageTable,
  usageText,
};
