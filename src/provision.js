// Turns the short-lived OAuth token into a durable coding-plan API key using
// Z.ai's business API: login, pick the default org/project, find or create a
// key named after this tool, then fetch its secret through the copy endpoint.

import { CONSOLE_KEYS_URL, TIMEOUTS } from "./config.js";
import { authError, EXIT } from "./errors.js";
import { registerSecret, requestEnvelope } from "./http.js";

const DEFAULT_ORG_HINT = "默认机构"; // "default organization" in Z.ai's Chinese UI
const DEFAULT_PROJECT_HINT = "默认项目";

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function idOf(record, ...keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number") return String(value);
    if (str(value)) return str(value);
  }
  return "";
}

function pickDefault(list, nameKey, hint) {
  const records = Array.isArray(list) ? list.filter((item) => item && typeof item === "object") : [];
  if (records.length === 0) return null;
  return (
    records.find((item) => item.isDefault === true)
    ?? records.find((item) => str(item[nameKey]).includes(hint))
    ?? records[0]
  );
}

/** Exported for tests: choose the default organization and project. */
export function pickOrgProject(customer) {
  const org = pickDefault(customer?.organizations, "organizationName", DEFAULT_ORG_HINT);
  if (!org) return null;
  const project = pickDefault(org.projects, "projectName", DEFAULT_PROJECT_HINT);
  const organizationId = idOf(org, "organizationId", "organization_id", "id");
  const projectId = idOf(project, "projectId", "project_id", "id");
  if (!organizationId || !projectId) return null;
  return { organizationId, projectId };
}

function keyList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const field of ["list", "keys", "apiKeys", "records", "data"]) {
      if (Array.isArray(data[field])) return data[field];
    }
  }
  return [];
}

/**
 * Mint (or reuse) the durable key. Returns { apiKey, keyName, created,
 * organizationId, projectId }. apiKey is "<id>.<secret>".
 */
export async function mintApiKey(oauthAccessToken, config, { fetchImpl, signal, onProgress } = {}) {
  const token = str(oauthAccessToken);
  if (!token) throw authError("Cannot provision a key without an OAuth access token.");
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const base = { fetchImpl, signal, timeoutMs: TIMEOUTS.authMs };
  const meta = { exitCode: EXIT.AUTH };

  progress("Signing in to the Z.ai business API");
  const login = await requestEnvelope(
    { ...base, method: "POST", url: config.bizLoginUrl, body: { token } },
    { operation: "Z.ai business login", ...meta },
  );
  const bizToken = str(login?.access_token) || str(login?.accessToken);
  if (!bizToken) throw authError("Z.ai business login returned no access token.");
  registerSecret(bizToken);
  const authed = { ...base, headers: { Authorization: `Bearer ${bizToken}` } };

  progress("Looking up your organization and project");
  const customer = await requestEnvelope(
    { ...authed, url: `${config.apiBase}/api/biz/customer/getCustomerInfo` },
    { operation: "Customer lookup", ...meta },
  );
  const selected = pickOrgProject(customer);
  if (!selected) {
    throw authError(
      "Your Z.ai account has no organization or project to hold an API key.",
      "Sign in at https://z.ai, finish onboarding and make sure a GLM Coding Plan is active, then retry.",
    );
  }
  const keysUrl = `${config.apiBase}/api/biz/v1/organization/${encodeURIComponent(selected.organizationId)}/projects/${encodeURIComponent(selected.projectId)}/api_keys`;

  progress(`Looking for an API key named "${config.keyName}"`);
  const listed = await requestEnvelope({ ...authed, url: keysUrl }, { operation: "API key listing", ...meta });
  let record = keyList(listed).find((item) => item && typeof item === "object" && str(item.name) === config.keyName);
  let created = false;
  if (!record) {
    progress(`Creating API key "${config.keyName}"`);
    try {
      record = await requestEnvelope(
        { ...authed, method: "POST", url: keysUrl, body: { name: config.keyName } },
        { operation: "API key creation", ...meta },
      );
    } catch (error) {
      if (error?.exitCode === EXIT.AUTH && !error.hint) {
        error.hint = `Z.ai refused to create a key. Delete unused keys at ${CONSOLE_KEYS_URL} and retry.`;
      }
      throw error;
    }
    created = true;
  }
  const apiKeyId = str(record?.apiKey) || str(record?.api_key);
  if (!apiKeyId) throw authError("Z.ai returned an API key record without an id.");

  progress("Fetching the key secret");
  const copied = await requestEnvelope(
    { ...authed, url: `${keysUrl}/copy/${encodeURIComponent(apiKeyId)}` },
    { operation: "API key secret copy", ...meta },
  );
  const secret = str(copied?.secretKey) || str(copied?.secret_key);
  if (!secret) throw authError("Z.ai returned no secret for the API key.");
  const apiKey = `${apiKeyId}.${secret}`;
  registerSecret(apiKey);
  return { apiKey, keyName: config.keyName, created, ...selected };
}
