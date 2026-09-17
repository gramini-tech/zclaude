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
 * A span of time, short enough to sit at the end of a row: "2h 8m", "45m",
 * "6d 4h". Under a minute reads as "now".
 * @param {number} ms
 */
function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < MINUTE) return "now";
  if (ms < HOUR) {
    const minutes = Math.round(ms / MINUTE);
    // 59m30s rounds to 60 minutes, which is an hour and should say so.
    return minutes === 60 ? "1h" : `${minutes}m`;
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);
    // 2h 60m is nobody's idea of two hours.
    return minutes === 0 || minutes === 60 ? `${hours + (minutes === 60 ? 1 : 0)}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms % DAY) / HOUR);
  return hours === 0 || hours === 24 ? `${days + (hours === 24 ? 1 : 0)}d` : `${days}d ${hours}h`;
}

/**
 * How long until then. A time already past has nothing useful to say.
 * @param {number | null} at epoch ms
 * @param {number} [now]
 */
export function countdown(at, now = Date.now()) {
  if (at === null || !Number.isFinite(at)) return "";
  // A reset time already past means the endpoint is describing the window that
  // has just turned over. Counting down to it would read as a countdown to
  // yesterday, so there is nothing useful to say.
  return duration(at - now);
}

/**
 * How long ago something happened: "3m ago", "just now". The mirror of the
 * countdown, sharing its units so the two never disagree on screen.
 * @param {number | null} at epoch ms
 * @param {number} [now]
 */
export function elapsed(at, now = Date.now()) {
  if (!at || !Number.isFinite(at)) return "";
  const since = duration(now - at);
  if (!since) return "";
  return since === "now" ? "just now" : `${since} ago`;
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
