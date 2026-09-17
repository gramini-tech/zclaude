// When a window resets, said two ways: how long from now, and the wall-clock
// time here.
//
// The API answers in UTC ("2026-09-17T14:20:00.133466+00:00"). Nobody plans
// their afternoon in UTC, so both forms are rendered in the machine's own time
// zone through Intl, which already knows the zone and the locale. That is also
// why there is no timeago dependency: Intl.DateTimeFormat and
// Intl.RelativeTimeFormat ship with Node and with every browser the VS Code
// extension runs in, and a dependency here would have to be bundled into the
// vsix as well.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A reset time from either provider as epoch milliseconds, or null.
 * Anthropic sends an ISO string; Z.ai sends a number. Callers should not have
 * to know which one they are holding.
 * @param {string | number | null | undefined} value
 */
export function resetTime(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * How long until then, short enough to sit at the end of a row: "2h 8m",
 * "45m", "6d 4h". Past, or under a minute, reads as "now" — a window that has
 * just reset is at zero anyway.
 * @param {number | null} at epoch ms
 * @param {number} [now]
 */
export function countdown(at, now = Date.now()) {
  if (at === null || !Number.isFinite(at)) return "";
  const left = at - now;
  // A reset time already past means the endpoint is describing the window that
  // has just turned over. Counting down to it would read as a countdown to
  // yesterday, so there is nothing useful to say.
  if (left < 0) return "";
  if (left < MINUTE) return "now";
  if (left < HOUR) return `${Math.round(left / MINUTE)}m`;
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.round((left % HOUR) / MINUTE);
    // 2h 60m is nobody's idea of two hours.
    return minutes === 0 || minutes === 60 ? `${hours + (minutes === 60 ? 1 : 0)}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(left / DAY);
  const hours = Math.round((left % DAY) / HOUR);
  return hours === 0 || hours === 24 ? `${days + (hours === 24 ? 1 : 0)}d` : `${days}d ${hours}h`;
}

/**
 * The same moment as a local wall-clock time: "19:50" today, "Wed 24 Sep,
 * 06:30" further out. The zone and the 12- or 24-hour clock come from the
 * machine, which is the point of converting at all.
 * @param {number | null} at epoch ms
 * @param {number} [now]
 * @param {{locale?: string, timeZone?: string}} [options] for tests
 */
export function localTime(at, now = Date.now(), { locale, timeZone } = {}) {
  if (at === null || !Number.isFinite(at)) return "";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(at);
  const sameDay = new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone });
  if (sameDay.format(at) === sameDay.format(now)) return time;
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(
    at,
  );
  return `${day}, ${time}`;
}

/**
 * Both forms together, for a line with room: "in 2h 8m (19:50)".
 * @param {number | null} at epoch ms
 * @param {number} [now]
 * @param {{locale?: string, timeZone?: string}} [options]
 */
export function resetPhrase(at, now = Date.now(), options = {}) {
  const left = countdown(at, now);
  if (!left) return "";
  const clock = localTime(at, now, options);
  return left === "now" ? "resets now" : `resets in ${left}${clock ? ` (${clock})` : ""}`;
}
