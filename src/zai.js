// Key validation, model listing and quota lookup against the coding-plan API.

import { contextWindowFor, TIMEOUTS } from "./config.js";
import { request } from "./http.js";

function modelIds(json) {
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const ids = [];
  for (const item of list) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id === "string" && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
  }
  return ids;
}

function describeModels(ids) {
  return ids.map((id) => ({ id, contextWindow: contextWindowFor(id) }));
}

/** @typedef {{fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number}} FetchOptions */

/**
 * Check a key against the models endpoint (the same call Z.ai's own helper
 * uses). Returns { status, httpStatus, models, detail } where status is one of
 * valid | rejected | throttled | inconclusive. Throws only on network failure.
 * @param {string} apiKey
 * @param {{modelsUrl: string}} config
 * @param {FetchOptions} [options]
 */
export async function checkKey(apiKey, config, { fetchImpl, signal, timeoutMs = TIMEOUTS.validateMs } = {}) {
  const response = await request({
    url: config.modelsUrl,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs,
    fetchImpl,
    signal,
  });
  const detail =
    typeof response.json?.error?.message === "string"
      ? response.json.error.message
      : typeof response.json?.msg === "string"
        ? response.json.msg
        : "";
  if (response.status === 401 || response.status === 403) {
    return { status: "rejected", httpStatus: response.status, models: [], detail };
  }
  if (response.status === 429) {
    return { status: "throttled", httpStatus: response.status, models: [], detail };
  }
  if (response.ok) {
    return { status: "valid", httpStatus: response.status, models: describeModels(modelIds(response.json)), detail };
  }
  return {
    status: "inconclusive",
    httpStatus: response.status,
    models: [],
    detail: detail || response.text.slice(0, 200),
  };
}

/**
 * Best-effort quota lookup. Returns null on any failure.
 * @param {string} apiKey
 * @param {{quotaUrl: string}} config
 * @param {FetchOptions} [options]
 */
export async function fetchQuota(apiKey, config, { fetchImpl, signal } = {}) {
  try {
    const response = await request({
      url: config.quotaUrl,
      headers: { Authorization: apiKey, "Accept-Language": "en-US,en" },
      timeoutMs: TIMEOUTS.quotaMs,
      fetchImpl,
      signal,
    });
    if (!response.ok || !response.json) return null;
    const data = response.json.data && typeof response.json.data === "object" ? response.json.data : response.json;
    const limits = Array.isArray(data.limits) ? data.limits : [];
    return {
      level: typeof data.level === "string" ? data.level : "",
      limits: limits
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          type: typeof item.type === "string" ? item.type : "",
          unit: item.unit,
          percentage: Number.isFinite(Number(item.percentage)) ? Number(item.percentage) : null,
          nextResetTime: item.nextResetTime ?? item.next_reset_time ?? null,
        })),
    };
  } catch {
    return null;
  }
}

const LIMIT_LABELS = {
  TOKENS_LIMIT: "tokens",
  TIME_LIMIT: "time",
  CREDIT_LIMIT: "credits",
};

function resetHint(value) {
  if ([null, undefined, ""].includes(value)) return "";
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return ` (resets ${date.toLocaleString()})`;
}

/** One-line human summary, or null when there is nothing to say. */
export function formatQuota(quota) {
  if (!quota) return null;
  const parts = quota.limits
    .filter((limit) => limit.percentage !== null)
    .map((limit) => {
      const label = LIMIT_LABELS[limit.type] ?? (limit.type || "quota").toLowerCase();
      const unit = limit.unit !== undefined && limit.unit !== null && limit.unit !== "" ? ` ${limit.unit}` : "";
      const exhausted = limit.percentage >= 100 ? resetHint(limit.nextResetTime) : "";
      return `${label}${unit} ${Math.round(limit.percentage)}%${exhausted}`;
    });
  const plan = quota.level ? ` (${quota.level})` : "";
  if (parts.length === 0) return `Z.ai GLM Coding Plan${plan}`;
  return `Z.ai GLM Coding Plan${plan} · ${parts.join(" · ")}`;
}

export function quotaExhausted(quota) {
  return Boolean(quota?.limits?.some((limit) => limit.percentage !== null && limit.percentage >= 100));
}
