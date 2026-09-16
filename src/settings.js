// Layered configuration: ./.zclaude/env (project) over ~/.zclaude/settings
// (user) over built-in defaults. Both files use dotenv syntax and never hold
// secrets, so the project file is safe to commit.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_MODELS, zclaudeHome } from "./config.js";

export const MANAGED_KEYS = Object.freeze({
  primary: "ZCLAUDE_MODEL",
  subagent: "ZCLAUDE_SUBAGENT_MODEL",
  fast: "ZCLAUDE_FAST_MODEL",
  profile: "ZCLAUDE_PROFILE",
});
const MANAGED_SET = new Set(Object.values(MANAGED_KEYS));

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

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

/** Parse dotenv text into { values, warnings }. Never throws. */
export function parseDotenv(text, { file = "(text)" } = {}) {
  const values = {};
  const warnings = [];
  const lines = String(text ?? "").replace(/^\uFEFF/u, "").split(/\r?\n/u);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) {
      warnings.push(`${file}:${index + 1}: expected KEY=value, ignoring "${line.slice(0, 40)}"`);
      return;
    }
    const key = body.slice(0, eq).trim();
    const rest = body.slice(eq + 1).trim();
    if (!KEY_PATTERN.test(key)) {
      warnings.push(`${file}:${index + 1}: invalid variable name "${key}"`);
      return;
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const parsed = parseQuoted(rest, rest[0]);
      if (parsed === null) {
        warnings.push(`${file}:${index + 1}: unterminated quote for ${key}`);
        return;
      }
      values[key] = parsed;
      return;
    }
    values[key] = stripInlineComment(rest);
  });
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
export function updateDotenv(existingText, updates, { header } = {}) {
  const pending = new Map(Object.entries(updates));
  const output = [];
  const lines = String(existingText ?? "").split(/\r?\n/u);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    const key = eq > 0 && !line.startsWith("#") ? body.slice(0, eq).trim() : null;
    if (key && key in updates) {
      if (pending.has(key)) {
        output.push(`${key}=${formatValue(updates[key])}`);
        pending.delete(key);
      }
      continue;
    }
    output.push(rawLine);
  }
  if (output.length === 0 && header) output.push(...header.split("\n"));
  for (const [key, value] of pending) output.push(`${key}=${formatValue(value)}`);
  return `${output.join("\n")}\n`;
}

export async function readSettingsFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { path, exists: false, values: {}, warnings: [] };
    return { path, exists: true, values: {}, warnings: [`${path}: ${error.message}`] };
  }
  return { path, exists: true, ...parseDotenv(text, { file: path }) };
}

export const FILE_HEADER = [
  "# managed by zclaude (https://github.com/vipincr/zclaude)",
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
  return ["primary", "subagent", "fast"].every((slot) => typeof values[MANAGED_KEYS[slot]] === "string" && values[MANAGED_KEYS[slot]].trim());
}

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
  for (const record of [layered?.user, layered?.project]) {
    for (const [key, value] of Object.entries(record?.values ?? {})) {
      if (MANAGED_SET.has(key) || key === "ZCLAUDE_ZAI") continue;
      merged[key] = value;
    }
  }
  return merged;
}
