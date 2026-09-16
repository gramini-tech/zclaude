// Minimal stderr logger. Colors only when writing to a terminal and the user
// has not opted out through NO_COLOR or TERM=dumb.

let verbose = false;

export function setVerbose(value) {
  verbose = Boolean(value);
}

export function isVerbose() {
  return verbose;
}

export function colorEnabled(stream = process.stderr, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream && stream.isTTY);
}

const CODES = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
  grey: "[90m",
  white: "[97m",
};

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
  if (verbose) write("»", "grey", paint(message, "grey"));
};

/** Show only the last four characters of a secret. */
export function mask(secret) {
  const value = String(secret ?? "");
  if (!value) return "(none)";
  if (value.length <= 8) return "****";
  return `****${value.slice(-4)}`;
}
