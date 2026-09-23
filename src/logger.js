// Structured run log for post-mortems. One JSON-lines file per run under
// ~/.zclaude/logs (oldest pruned), every line redacted before it is written.
//
// Levels: error < warn < info < debug < trace. Categories tag the subsystem
// (cli, config, profile, auth, callback, provision, store, zai, http, claude,
// console). Both are filterable through the environment or CLI flags; see
// configureLogger().

import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { flag, VERSION, zclaudeHome } from "./config.js";
import { redact } from "./redact.js";

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });
const CATEGORIES = Object.freeze([
  "cli",
  "config",
  "profile",
  "auth",
  "callback",
  "provision",
  "store",
  "zai",
  "swap",
  "usage",
  "renew",
  "http",
  "claude",
  "console",
  // Categories the source already logs to. Without them here a filter naming
  // one returns nothing, which is how `ZCLAUDE_LOG_CATEGORIES=auto` read as an
  // empty log rather than as a typo.
  "auto",
  "sessions",
  "vscode",
  "router",
]);
const DEFAULT_KEEP = 30;
const DEFAULT_LEVEL = "debug";

const state = {
  enabled: false,
  level: LEVELS[DEFAULT_LEVEL],
  include: null,
  exclude: new Set(),
  file: null,
  started: Date.now(),
  failed: false,
  seq: 0,
};

function parseLevel(value, fallback) {
  const name = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["off", "none", "silent"].includes(name)) return -1;
  return Object.hasOwn(LEVELS, name) ? LEVELS[name] : fallback;
}

/** "auth,http" includes only those; "-http,-console" excludes. Mixed forms combine. */
export function parseCategories(value) {
  const include = new Set();
  const exclude = new Set();
  const tokens = String(value ?? "").split(",");
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    if (token.startsWith("-") || token.startsWith("!")) exclude.add(token.slice(1));
    else include.add(token);
  }
  return { include: include.size > 0 ? include : null, exclude };
}

export function logsDir(env = process.env) {
  const custom = typeof env.ZCLAUDE_LOG_DIR === "string" ? env.ZCLAUDE_LOG_DIR.trim() : "";
  return custom || join(zclaudeHome(env), "logs");
}

function stamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function isRunLogName(name) {
  if (!name.startsWith("zclaude-") || !name.endsWith(".log")) return false;
  const parts = name.slice(8, -4).split("-");
  return parts.length >= 3 && parts.length <= 4 && parts.every((part) => /^\d+$/u.test(part));
}

/** Newest first. */
export function listLogs(env = process.env) {
  try {
    return readdirSync(logsDir(env))
      .filter(isRunLogName)
      .toSorted((a, b) => b.localeCompare(a))
      .map((name) => join(logsDir(env), name));
  } catch {
    return [];
  }
}

function prune(env, keep) {
  const stale = listLogs(env).slice(Math.max(keep - 1, 0));
  for (const path of stale) {
    try {
      unlinkSync(path);
    } catch {
      // another process may have removed it
    }
  }
}

function sanitize(value, depth = 0) {
  if (value instanceof Error) {
    const { name, message, stack, code, exitCode } = /** @type {Error & {code?: unknown, exitCode?: unknown}} */ (
      value
    );
    return { name, message, stack, code, exitCode };
  }
  if (Array.isArray(value)) return depth > 3 ? "[array]" : value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 3) return "[object]";
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1);
    return out;
  }
  return value;
}

function applyFilters({ env, level, categories }) {
  const filters = parseCategories(categories ?? env.ZCLAUDE_LOG_CATEGORIES);
  const unknown = [...(filters.include ?? []), ...filters.exclude].filter((name) => !CATEGORIES.includes(name));
  if (unknown.length > 0) {
    process.stderr.write(
      `zclaude: unknown log categories ignored: ${unknown.join(", ")} (known: ${CATEGORIES.join(", ")})\n`,
    );
  }
  state.level = parseLevel(level ?? env.ZCLAUDE_LOG_LEVEL, LEVELS[DEFAULT_LEVEL]);
  state.include = filters.include;
  state.exclude = filters.exclude;
  state.started = Date.now();
  state.failed = false;
  state.seq = 0;
}

/** Pick the file for this run; creates the directory and prunes old runs. */
function openRunFile({ env, file, envTarget }) {
  const explicit = file || (envTarget.toLowerCase() === "off" ? "" : envTarget);
  if (explicit) return explicit;
  const keep = Number(env.ZCLAUDE_LOG_KEEP) > 0 ? Math.floor(Number(env.ZCLAUDE_LOG_KEEP)) : DEFAULT_KEEP;
  mkdirSync(logsDir(env), { recursive: true, mode: 0o700 });
  prune(env, keep);
  return join(logsDir(env), `zclaude-${stamp(new Date())}-${process.pid}.log`);
}

/**
 * Configure the run log. Precedence: explicit options > environment > defaults.
 * @param {{env?: NodeJS.ProcessEnv, level?: string, file?: string, disabled?: boolean, categories?: string, argv?: string[]}} [options]
 */
export function configureLogger({ env = process.env, level, file, disabled, categories, argv } = {}) {
  const envTarget = typeof env.ZCLAUDE_LOG === "string" ? env.ZCLAUDE_LOG.trim() : "";
  const off = disabled || flag(env, "ZCLAUDE_NO_LOG") || envTarget.toLowerCase() === "off";
  applyFilters({ env, level, categories });
  if (off || state.level < 0) {
    state.enabled = false;
    state.file = null;
    return null;
  }
  try {
    state.file = openRunFile({ env, file, envTarget });
    state.enabled = true;
  } catch (error) {
    state.enabled = false;
    state.file = null;
    state.failed = true;
    process.stderr.write(`zclaude: run log disabled (${error.message})\n`);
    return null;
  }
  emit("info", "cli", "run started", {
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    argv: argv ?? process.argv.slice(2),
    cwd: process.cwd(),
    tty: {
      stdin: Boolean(process.stdin.isTTY),
      stdout: Boolean(process.stdout.isTTY),
      columns: process.stdout.columns ?? null,
    },
    envSet: Object.keys(env)
      .filter((key) => /^(ZCLAUDE_|ZAI_|ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|NO_COLOR|CI$)/u.test(key))
      .toSorted((a, b) => a.localeCompare(b)),
    logLevel: Object.keys(LEVELS).find((name) => LEVELS[name] === state.level) ?? "debug",
    categories: { include: state.include ? [...state.include] : null, exclude: [...state.exclude] },
  });
  return state.file;
}

export function logFilePath() {
  return state.enabled ? state.file : null;
}

export function isLogging(level = "trace", category = "cli") {
  if (!state.enabled || LEVELS[level] > state.level || state.exclude.has(category)) return false;
  return !state.include || state.include.has(category);
}

function emit(level, category, message, fields) {
  if (!isLogging(level, category)) return;
  state.seq += 1;
  const entry = {
    ts: new Date().toISOString(),
    t: Date.now() - state.started,
    seq: state.seq,
    level,
    cat: category,
    msg: String(message),
    ...(fields && sanitize(fields)),
  };
  try {
    appendFileSync(state.file, `${redact(JSON.stringify(entry))}\n`, { mode: 0o600 });
  } catch (error) {
    state.enabled = false;
    if (!state.failed) {
      state.failed = true;
      process.stderr.write(`zclaude: run log disabled (${error.message})\n`);
    }
  }
}

export const log = Object.freeze({
  error: (category, message, fields) => emit("error", category, message, fields),
  warn: (category, message, fields) => emit("warn", category, message, fields),
  info: (category, message, fields) => emit("info", category, message, fields),
  debug: (category, message, fields) => emit("debug", category, message, fields),
  trace: (category, message, fields) => emit("trace", category, message, fields),
});

/** Parse a log file into entries; malformed lines become {raw}. */
export function readLog(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

/** One human-readable line per entry. */
export function formatEntry(entry) {
  if (entry.raw !== undefined) return entry.raw;
  const { ts, t, level, cat, msg, ...rest } = entry;
  delete rest.seq;
  const clock = typeof ts === "string" ? ts.slice(11, 23) : "";
  const offset = typeof t === "number" ? `+${(t / 1000).toFixed(3)}s` : "";
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
  return `${clock} ${offset.padStart(9)} ${String(level).padEnd(5)} ${String(cat).padEnd(9)} ${msg}${extra}`.trimEnd();
}
