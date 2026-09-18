// The picker shown when zclaude is run with no profile named.
//
// It is a custom prompt rather than a plain select because the rows carry
// usage, and usage arrives over the network one account at a time. The list
// paints immediately from what is already known, a spinner runs while answers
// are outstanding, each row fills in as it lands, and `r` asks again — which is
// also how you retry after the endpoint has had a bad minute.

import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isNumberKey,
  isUpKey,
  useEffect,
  useKeypress,
  useState,
} from "@inquirer/core";

import { busyMarker } from "../sessions/index.js";
import { formatCredits, formatUsage, signInHint, usageRows } from "../usage/index.js";
import { layout } from "../usage/table.js";
import { paint } from "./log.js";
import { guard, withSignal } from "./prompt.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const noop = () => {};

/**
 * One row: the marker, the name, and the usage.
 *
 * A row is a name and a number, because that is the choice being made. Which
 * account and what it shares belong to the highlighted row only, on the detail
 * line below the list — the same shape `select` uses, and the only way an email
 * plus three percentages fit an 80-column terminal without wrapping.
 * @param {{profile: object, active: boolean, usage: object | undefined, loading: boolean, width: number, frame: number, columns?: number, now?: number, busy?: object}} args
 */
export function renderRow({ profile, active, usage, loading, width, frame, columns = 80, now = Date.now(), busy }) {
  const marker = active ? "❯" : " ";
  // The names form a column, so a long one is cut rather than allowed to shove
  // every other row's numbers out of line.
  const name = (profile.label.length > width ? `${profile.label.slice(0, width - 1)}…` : profile.label).padEnd(width);
  const numbers = formatUsage(usage, now);
  // The marker goes first: "this account is already busy" changes the choice
  // more than any percentage does.
  const busyText = busyMarker(busy);
  const trailing = [busyText, numbers || (loading ? `${SPINNER[frame % SPINNER.length]} usage` : "")]
    .filter(Boolean)
    .join("  ");
  const line = `${marker} ${name}  ${trailing}`.trimEnd().slice(0, columns - 1);
  return active ? paint(line, "cyan", process.stderr) : line;
}

/**
 * What the highlighted row is: the account, and what it borrows.
 *
 * The name comes back here when the table had to cut it, which is the only
 * place it can: the column is sized for the numbers.
 */
export function renderDetail(profile, columns = 80, { cut = false, hint = null } = {}) {
  const parts = [cut ? profile?.label : null, profile?.description, profile?.sharing].filter(Boolean);
  // A row that says "login expired" and nothing else is a dead end. The fix is
  // one command, and this is the line with room for it.
  if (hint) parts.push(`${hint.why} — ${hint.here ? `press s, or ${hint.how}` : hint.how}`);
  if (parts.length === 0) return "";
  const line = `  ${parts.join(", ")}`;
  return line.length < columns ? line : `${line.slice(0, columns - 2)}…`;
}

/**
 * When the highlighted profile's windows come back, on their own line.
 *
 * The rows carry a clock only for a window that is close to its ceiling, which
 * keeps them inside 80 columns. This is where the rest of the picture goes: the
 * local time each window resets, and what is left of any pay-as-you-go credit.
 */
export function renderUsageDetail(usage, now = Date.now(), columns = 80) {
  const rows = usageRows(usage, now);
  const credits = formatCredits(usage?.credits);
  const parts = [...rows.map((row) => `${row.label} ${row.pct}%${row.resets ? ` ${row.resets}` : ""}`), credits];
  const line = `  ${parts.filter(Boolean).join(" · ")}`;
  if (line.trim().length === 0) return "";
  return line.length < columns ? line : `${line.slice(0, columns - 2)}…`;
}

/** The lines under the list: what is happening and which keys do what. */
export function renderFooter({ loading, count, total, usageEnabled, canSignIn = false }) {
  if (!usageEnabled) return "↑↓ move · enter launch";
  // The key only appears on a row that needs it. A key listed on every row that
  // does nothing on most of them teaches people to stop reading the footer.
  const signIn = canSignIn ? " · s sign in" : "";
  if (loading) return `↑↓ move · enter launch · r refresh${signIn}   (usage ${count}/${total})`;
  return count === total
    ? `↑↓ move · enter launch · r refresh${signIn}`
    : `↑↓ move · enter launch · r refresh${signIn} (some usage missing)`;
}

/**
 * @typedef {object} MenuProfile
 * @property {string} id
 * @property {string} label
 * @property {string} [description]
 */

const menuPrompt = createPrompt((config, done) => {
  const { profiles, store, usageEnabled, busy } = config;
  const [cursor, setCursor] = useState(
    Math.max(
      0,
      profiles.findIndex((item) => item.id === config.defaultId),
    ),
  );
  const [, setTick] = useState(0);
  const [frame, setFrame] = useState(0);
  const [done_, setDone] = useState(false);

  useEffect(() => {
    const unsubscribe = store ? store.subscribe(() => setTick((value) => value + 1)) : noop;
    return unsubscribe;
  }, [store]);

  // One timer per frame while anything is outstanding: the spinner is the only
  // reason this prompt ever redraws on its own.
  useEffect(() => {
    if (done_ || !store?.loading) return noop;
    const timer = setTimeout(() => setFrame((value) => value + 1), 90);
    return () => clearTimeout(timer);
  }, [frame, done_, store?.loading]);

  const hintFor = (index) => signInHint(store?.get(profiles[index]?.id), profiles[index]);

  useKeypress((key) => {
    if (isEnterKey(key)) {
      setDone(true);
      done({ id: profiles[cursor].id, action: "launch" });
      return;
    }
    // Only on a row whose login is actually broken, so `s` never surprises
    // anyone by starting a browser flow they did not ask for.
    if (key.name === "s" && hintFor(cursor)?.here) {
      setDone(true);
      done({ id: profiles[cursor].id, action: "signIn" });
      return;
    }
    if (isUpKey(key)) setCursor((cursor - 1 + profiles.length) % profiles.length);
    else if (isDownKey(key)) setCursor((cursor + 1) % profiles.length);
    else if (usageEnabled && key.name === "r") store?.load({ force: true });
    else if (isNumberKey(key)) {
      const index = Number(key.name) - 1;
      if (index >= 0 && index < profiles.length) setCursor(index);
    }
  });

  const now = Date.now();
  const columns = process.stderr.columns || 80;
  // The same table the editor's panel draws. A terminal is monospace, so the
  // columns are simply columns; `layout` gives up the ones a narrow window has
  // no room for rather than letting a row wrap, because a wrapped row would put
  // the cursor on the wrong line.
  const table = layout(
    profiles.map((profile) => ({
      name: profile.label,
      usage: store?.get(profile.id),
      busy: busy?.get(profile.id),
      loading: Boolean(store?.loading),
    })),
    { columns, now },
  );
  const known = profiles.filter((profile) => store?.get(profile.id)).length;
  const rows = table.rows.map((line, index) => {
    const marked = `${index === cursor ? "❯" : " "} ${line}`;
    return index === cursor ? paint(marked, "cyan", process.stderr) : marked;
  });
  const header = paint("?", "cyan", process.stderr);
  if (done_) return `${header} What do you want to launch? ${paint(profiles[cursor].label, "cyan", process.stderr)}`;
  const columnNames = paint(`  ${table.header}`, "grey", process.stderr);
  const hint = hintFor(cursor);
  const detail = paint(
    renderDetail(profiles[cursor], columns, { cut: profiles[cursor].label.length > table.width, hint }),
    "grey",
    process.stderr,
  );
  const footer = paint(
    renderFooter({
      loading: Boolean(store?.loading),
      count: known,
      total: profiles.length,
      usageEnabled,
      canSignIn: Boolean(hint?.here),
    }),
    "grey",
    process.stderr,
  );
  return [`${header} What do you want to launch?`, columnNames, ...rows, detail, footer].filter(Boolean).join("\n");
});

/**
 * @param {MenuProfile[]} profiles
 * @param {{defaultId?: string, store?: object, usageEnabled?: boolean, busy?: Map<string, object>}} [options]
 * @returns {Promise<{id: string, action: "launch" | "signIn"}>} what to do, and to which profile
 */
export function chooseProfileWithUsage(profiles, { defaultId, store, usageEnabled = true, busy } = {}) {
  return guard(menuPrompt({ profiles, defaultId, store, usageEnabled, busy }, { signal: withSignal() }));
}
