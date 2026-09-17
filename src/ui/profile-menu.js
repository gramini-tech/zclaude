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

import { formatUsage } from "../usage/index.js";
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
 * @param {{profile: object, active: boolean, usage: object | undefined, loading: boolean, width: number, frame: number, columns?: number}} args
 */
export function renderRow({ profile, active, usage, loading, width, frame, columns = 80 }) {
  const marker = active ? "❯" : " ";
  // The names form a column, so a long one is cut rather than allowed to shove
  // every other row's numbers out of line.
  const name = (profile.label.length > width ? `${profile.label.slice(0, width - 1)}…` : profile.label).padEnd(width);
  const numbers = formatUsage(usage);
  const trailing = numbers || (loading ? `${SPINNER[frame % SPINNER.length]} usage` : "");
  const line = `${marker} ${name}  ${trailing}`.trimEnd().slice(0, columns - 1);
  return active ? paint(line, "cyan", process.stderr) : line;
}

/** What the highlighted row is: the account, and what it borrows. */
export function renderDetail(profile, columns = 80) {
  const parts = [profile?.description, profile?.sharing].filter(Boolean);
  if (parts.length === 0) return "";
  const line = `  ${parts.join(", ")}`;
  return line.length < columns ? line : `${line.slice(0, columns - 2)}…`;
}

/** The lines under the list: what is happening and which keys do what. */
export function renderFooter({ loading, count, total, usageEnabled }) {
  if (!usageEnabled) return "↑↓ move · enter launch";
  if (loading) return `↑↓ move · enter launch · r refresh   (usage ${count}/${total})`;
  return count === total
    ? "↑↓ move · enter launch · r refresh"
    : `↑↓ move · enter launch · r refresh (some usage missing)`;
}

/**
 * @typedef {object} MenuProfile
 * @property {string} id
 * @property {string} label
 * @property {string} [description]
 */

const menuPrompt = createPrompt((config, done) => {
  const { profiles, store, usageEnabled } = config;
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

  useKeypress((key) => {
    if (isEnterKey(key)) {
      setDone(true);
      done(profiles[cursor].id);
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

  const columns = process.stderr.columns || 80;
  // Names get whatever the numbers do not need (three windows run to about 30
  // characters), so a name is only ever cut on a genuinely narrow terminal.
  const longest = Math.max(...profiles.map((profile) => profile.label.length));
  const width = Math.min(longest, Math.max(12, columns - 36));
  const known = profiles.filter((profile) => store?.get(profile.id)).length;
  const rows = profiles.map((profile, index) =>
    renderRow({
      profile,
      active: index === cursor,
      usage: store?.get(profile.id),
      loading: Boolean(store?.loading),
      width,
      frame,
      columns,
    }),
  );
  const header = paint("?", "cyan", process.stderr);
  if (done_) return `${header} What do you want to launch? ${paint(profiles[cursor].label, "cyan", process.stderr)}`;
  const detail = paint(renderDetail(profiles[cursor], columns), "grey", process.stderr);
  const footer = paint(
    renderFooter({ loading: Boolean(store?.loading), count: known, total: profiles.length, usageEnabled }),
    "grey",
    process.stderr,
  );
  return [`${header} What do you want to launch?`, ...rows, detail, footer].filter(Boolean).join("\n");
});

/**
 * @param {MenuProfile[]} profiles
 * @param {{defaultId?: string, store?: object, usageEnabled?: boolean}} [options]
 * @returns {Promise<string>} the chosen profile id
 */
export function chooseProfileWithUsage(profiles, { defaultId, store, usageEnabled = true } = {}) {
  return guard(menuPrompt({ profiles, defaultId, store, usageEnabled }, { signal: withSignal() }));
}
