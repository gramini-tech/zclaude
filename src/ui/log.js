// Minimal stderr logger. Colors only when writing to a terminal and the user
// has not opted out through NO_COLOR or TERM=dumb.

const state = { verbose: false };

export function setVerbose(value) {
  state.verbose = Boolean(value);
}

export function isVerbose() {
  return state.verbose;
}

/** @typedef {{isTTY?: boolean, columns?: number}} StreamLike */

/** @param {StreamLike} [stream] @param {NodeJS.ProcessEnv} [env] */
export function colorEnabled(stream = process.stderr, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream && stream.isTTY);
}

const CODES = {
  reset: "\u{1B}[0m",
  bold: "\u{1B}[1m",
  dim: "\u{1B}[2m",
  red: "\u{1B}[31m",
  green: "\u{1B}[32m",
  yellow: "\u{1B}[33m",
  cyan: "\u{1B}[36m",
  grey: "\u{1B}[90m",
  white: "\u{1B}[97m",
};

/**
 * @param {string} text
 * @param {keyof typeof CODES} style
 * @param {StreamLike} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function paint(text, style, stream = process.stderr, env = process.env) {
  if (!colorEnabled(stream, env)) return text;
  const code = CODES[style];
  return code ? `${code}${text}${CODES.reset}` : text;
}

function write(prefix, style, message) {
  const line = prefix ? `${paint(prefix, style)} ${message}` : message;
  process.stderr.write(`${line}\n`);
}

export const info = (message) => write("·", "cyan", message);
export const success = (message) => write("✓", "green", message);
export const warn = (message) => write("!", "yellow", message);
export const error = (message) => write("✗", "red", message);
export const debug = (message) => {
  if (state.verbose) write("»", "grey", paint(message, "grey"));
};

/** Show only the last four characters of a secret. */
export function mask(secret) {
  const value = String(secret ?? "");
  if (!value) return "(none)";
  if (value.length <= 8) return "****";
  return `****${value.slice(-4)}`;
}
