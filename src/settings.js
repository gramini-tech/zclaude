// Layered configuration: ./.zclaude/env (project) over ~/.zclaude/settings
// (user) over built-in defaults. Both files use dotenv syntax and never hold
// secrets, so the project file is safe to commit.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_MODELS, zclaudeHome } from "./config.js";
import { log } from "./logger.js";

export const MANAGED_KEYS = Object.freeze({
  primary: "ZCLAUDE_MODEL",
  subagent: "ZCLAUDE_SUBAGENT_MODEL",
  fast: "ZCLAUDE_FAST_MODEL",
  profile: "ZCLAUDE_PROFILE",
});
const MANAGED_SET = new Set(Object.values(MANAGED_KEYS));

const KEY_PATTERN = /^[A-Za-z_]\w*$/u;

export function projectEnvPath(cwd = process.cwd()) {
  return join(cwd, ".zclaude", "env");
}

export function userSettingsPath(env = process.env) {
  return join(zclaudeHome(env), "settings");
}

function stripInlineComment(value) {
  const index = value.search(/\s#/u);
  return index === -1 ? value.trim() : value.slice(0, index).trim();
}

function parseQuoted(rest, quote) {
  let out = "";
  for (let i = 1; i < rest.length; i += 1) {
    const ch = rest[i];
    if (quote === '"' && ch === "\\" && i + 1 < rest.length) {
      const next = rest[i + 1];
      out += next === "n" ? "\n" : next;
      i += 1;
      continue;
    }
    if (ch === quote) {
      const tail = rest.slice(i + 1).trim();
      if (tail && !tail.startsWith("#")) return null;
      return out;
    }
    out += ch;
  }
  return null;
}

/**
 * Parse dotenv text into { values, warnings }. Never throws.
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {{values: Record<string, string>, warnings: string[]}}
 */
export function parseDotenv(text, { file = "(text)" } = {}) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string[]} */
  const warnings = [];
  const lines = String(text ?? "")
    .replace(/^\u{FEFF}/u, "")
    .split(/\r?\n/u);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) {
      warnings.push(`${file}:${index + 1}: expected KEY=value, ignoring "${line.slice(0, 40)}"`);
      continue;
    }
    const key = body.slice(0, eq).trim();
    const rest = body.slice(eq + 1).trim();
    if (!KEY_PATTERN.test(key)) {
      warnings.push(`${file}:${index + 1}: invalid variable name "${key}"`);
      continue;
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const parsed = parseQuoted(rest, rest[0]);
      if (parsed === null) {
        warnings.push(`${file}:${index + 1}: unterminated quote for ${key}`);
        continue;
      }
      values[key] = parsed;
      continue;
    }
    values[key] = stripInlineComment(rest);
  }
  return { values, warnings };
}

export function formatValue(value) {
  const text = String(value ?? "");
  if (text === "" || /[\s#"'\\]/u.test(text)) {
    return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
  }
  return text;
}

/**
 * Return new file text with `updates` applied key-by-key: existing lines for a
 * key are replaced in place (first occurrence kept, duplicates dropped),
 * unrelated lines are preserved, missing keys are appended.
 */
/**
 * @param {string} existingText
 * @param {Record<string, string>} updates
 * @param {{header?: string}} [options]
 */
export function updateDotenv(existingText, updates, { header } = {}) {
  const pending = new Map(Object.entries(updates));
  const output = [];
  const lines = String(existingText ?? "").split(/\r?\n/u);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    const key = eq > 0 && !line.startsWith("#") ? body.slice(0, eq).trim() : null;
    if (key && Object.hasOwn(updates, key)) {
      if (pending.has(key)) {
        output.push(`${key}=${formatValue(updates[key])}`);
        pending.delete(key);
      }
      continue;
    }
    output.push(rawLine);
  }
  if (header && output.length === 0) output.push(...header.split("\n"));
  for (const [key, value] of pending) output.push(`${key}=${formatValue(value)}`);
  return `${output.join("\n")}\n`;
}

async function readSettingsFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      log.debug("config", "settings file absent", { path });
      return { path, exists: false, values: {}, warnings: [] };
    }
    log.warn("config", "settings file unreadable", { path, error });
    return { path, exists: true, values: {}, warnings: [`${path}: ${error.message}`] };
  }
  const parsed = parseDotenv(text, { file: path });
  log.info("config", "settings file read", {
    path,
    keys: Object.keys(parsed.values),
    warnings: parsed.warnings.length,
  });
  return { path, exists: true, ...parsed };
}

const FILE_HEADER = [
  "# managed by zclaude (https://github.com/gramini-tech/zclaude)",
  "# Model choices for Claude Code on the Z.ai GLM Coding Plan.",
  "# Credentials never live here; this file is safe to commit.",
].join("\n");

export async function writeSettingsFile(path, updates) {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = updateDotenv(existing, updates, { header: FILE_HEADER });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, next, { mode: 0o644 });
  try {
    await chmod(tmp, 0o644);
  } catch {
    // best effort
  }
  await rename(tmp, path);
  log.info("config", "settings file written", { path, keys: Object.keys(updates) });
  return path;
}

export async function loadLayeredConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const [project, user] = await Promise.all([
    readSettingsFile(projectEnvPath(cwd)),
    readSettingsFile(userSettingsPath(env)),
  ]);
  return { project, user };
}

function firstDefined(candidates) {
  for (const [source, value] of candidates) {
    if (typeof value === "string" && value.trim()) return { value: value.trim(), source };
  }
  return null;
}

/**
 * Resolve the three model slots. Precedence per slot:
 * flags > process env > project file > user file > defaults.
 */
export function resolveModels({ flags = {}, env = process.env, layered }) {
  const project = layered?.project?.values ?? {};
  const user = layered?.user?.values ?? {};
  const out = { sources: {} };
  for (const slot of ["primary", "subagent", "fast"]) {
    const key = MANAGED_KEYS[slot];
    const found = firstDefined([
      ["flag", flags[slot]],
      ["env", env[key]],
      ["project", project[key]],
      ["user", user[key]],
      ["default", DEFAULT_MODELS[slot]],
    ]);
    out[slot] = found.value;
    out.sources[slot] = found.source;
  }
  return out;
}

/** Did the file explicitly set all three model slots? */
export function fileConfiguresModels(fileRecord) {
  const values = fileRecord?.values ?? {};
  return ["primary", "subagent", "fast"].every(
    (slot) => typeof values[MANAGED_KEYS[slot]] === "string" && values[MANAGED_KEYS[slot]].trim(),
  );
}

/** @param {{env?: NodeJS.ProcessEnv, layered?: any}} [options] */
export function resolveProfileDefault({ env = process.env, layered } = {}) {
  const found = firstDefined([
    ["env", env.ZCLAUDE_PROFILE],
    ["project", layered?.project?.values?.[MANAGED_KEYS.profile]],
    ["user", layered?.user?.values?.[MANAGED_KEYS.profile]],
  ]);
  return found;
}

/** Non-managed KEY=value lines, user file first so the project file wins. */
export function extraEnv(layered) {
  const merged = {};
  const isPassthrough = (entry) => entry[0] !== "ZCLAUDE_ZAI" && !MANAGED_SET.has(entry[0]);
  for (const record of [layered?.user, layered?.project]) {
    Object.assign(merged, Object.fromEntries(Object.entries(record?.values ?? {}).filter(isPassthrough)));
  }
  return merged;
}
