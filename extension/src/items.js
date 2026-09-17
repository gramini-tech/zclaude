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

/** "5h 12% · wk 61% · Fable 91%", or why there are no numbers. */
function usageText(usage) {
  if (!usage) return "";
  const states = {
    unauthorized: "sign in to see usage",
    dead: "login expired",
    throttled: "usage rate limited",
    offline: "usage unavailable",
    unknown: "",
  };
  if (Object.hasOwn(states, usage.state)) return states[usage.state];
  const parts = [
    usage.fiveHour ? `5h ${Math.round(usage.fiveHour.pct)}%` : null,
    usage.weekly ? `wk ${Math.round(usage.weekly.pct)}%` : null,
    ...(usage.scoped ?? []).map((scope) => `${scope.name} ${Math.round(scope.pct)}%`),
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return usage.state === "stale" ? `${parts.join(" · ")} (cached)` : parts.join(" · ");
}

/**
 * The picker's contents: every profile, then the things you can do.
 * @param {{profiles?: Array<object>, active?: string | null, usage?: Record<string, object>, loading?: boolean}} args
 */
function quickPickItems({ profiles = [], active = null, usage = {}, loading = false }) {
  const rows = profiles.map((profile) => {
    const current = profile.name === active;
    const numbers = usageText(usage[profile.name]);
    return {
      label: `${current ? "$(check) " : "$(blank) "}${profile.name}`,
      description: accountOf(profile),
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
  const numbers = usageText(usage);
  if (numbers) lines.push("", numbers);
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
  compareVersions,
  isSupported,
  MINIMUM_ZCLAUDE,
  outdatedText,
  quickPickItems,
  statusBarText,
  tooltip,
  usageText,
};
