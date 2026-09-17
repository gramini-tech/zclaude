// Turning zclaude's JSON into what the status bar and the list show.
//
// Pure: no VS Code, no child processes. The extension is mostly this plus
// plumbing, so this is where the tests are.

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

/** A window a reset time is worth showing for; at 4% nobody is watching it. */
const PRESSED = 50;

function windowText(label, window, now) {
  if (!window) return null;
  const pct = Math.round(window.pct);
  const left = pct >= PRESSED ? countdown(window.resetsAt, now) : "";
  return left ? `${label} ${pct}% ⟳${left}` : `${label} ${pct}%`;
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

/** "5h 12% · wk 61% ⟳2d · Fable 91% ⟳2d", or why there are no numbers. */
function usageText(usage, now = Date.now()) {
  if (!usage) return "";
  if (Object.hasOwn(STATES, usage.state)) return STATES[usage.state];
  const parts = [
    windowText("5h", usage.fiveHour, now),
    windowText("wk", usage.weekly, now),
    ...(usage.scoped ?? []).map((scope) => windowText(scope.name, scope, now)),
    creditsText(usage.credits) || null,
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return usage.state === "stale" ? `${parts.join(" · ")} (cached)` : parts.join(" · ");
}

/** Every window with its own reset time spelled out, for the hover. */
function usageLines(usage, now = Date.now()) {
  if (!usage || Object.hasOwn(STATES, usage.state)) return [];
  const windows = [
    usage.fiveHour ? ["5 hours", usage.fiveHour] : null,
    usage.weekly ? ["week", usage.weekly] : null,
    ...(usage.scoped ?? []).map((scope) => [`${scope.name} week`, scope]),
  ].filter(Boolean);
  return windows.map(([label, window]) => {
    const left = countdown(window.resetsAt, now);
    const clock = localTime(window.resetsAt, now);
    const when = left === "now" ? "resets now" : left ? `resets in ${left} (${clock})` : "";
    return `${label} ${Math.round(window.pct)}%${when ? ` — ${when}` : ""}`;
  });
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
      description: [accountOf(profile), running].filter(Boolean).join("  ·  "),
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

/** The status bar: who is signed in, short enough to sit next to the branch. */
function statusBarText(status, version) {
  if (version !== undefined && !isSupported(version)) return "$(account) zc $(warning)";
  if (!status) return "$(account) zc";
  if (status.unreadable) return "$(account) zc ?";
  const email = status.account?.email;
  if (!email) return "$(account) zc";
  return `$(account) ${email.split("@", 1)[0]}`;
}

/** The hover: the full account, what it is, and its usage. */
function tooltip(status, usage, version) {
  const lines = ["**zclaude** — the Claude Code account every terminal and the extension use"];
  if (version !== undefined && !isSupported(version)) {
    lines.push("", outdatedText(version), "", "Click for how to update.");
    return lines.join("\n");
  }
  if (status?.account?.email) {
    const org = status.account.organization ? ` · ${status.account.organization}` : "";
    lines.push("", `Signed in as \`${status.account.email}${org}\``);
  } else if (status?.unreadable) {
    lines.push("", `The credential could not be read: ${status.unreadable}`);
  } else {
    lines.push("", "Nobody is signed in.");
  }
  if (status?.owner) lines.push(`Profile: \`${status.owner}\``);
  const spelled = usageLines(usage);
  if (spelled.length > 0) lines.push("", ...spelled.map((line) => `- ${line}`));
  else {
    const numbers = usageText(usage);
    if (numbers) lines.push("", numbers);
  }
  const credits = creditsText(usage?.credits);
  if (credits && spelled.length > 0) lines.push(`- ${credits}`);
  lines.push("", "Click to switch account.");
  return lines.join("\n");
}

/** What to say about a zclaude that predates this extension. */
function outdatedText(version) {
  return version
    ? `zclaude ${version} is older than ${MINIMUM_ZCLAUDE}, which is what this needs to switch accounts.`
    : `This needs zclaude ${MINIMUM_ZCLAUDE} or newer.`;
}

module.exports = {
  ACTIONS,
  accountOf,
  busyText,
  countdown,
  creditsText,
  localTime,
  usageLines,
  compareVersions,
  isSupported,
  MINIMUM_ZCLAUDE,
  outdatedText,
  quickPickItems,
  statusBarText,
  tooltip,
  usageText,
};
