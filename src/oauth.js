// Z.ai authorization-code flow (no PKCE), mirroring what the ZCode desktop app
// sends. Z.ai's server allowlists only the zcode:// custom-scheme redirect for
// this client, so the code comes back through a temporary scheme handler on
// macOS or through a pasted URL everywhere else.

import { randomBytes, timingSafeEqual } from "node:crypto";

import { CALLBACK_SCHEME, TIMEOUTS } from "./config.js";
import { authError, EXIT } from "./errors.js";
import { requestEnvelope } from "./http.js";
import { log } from "./logger.js";

export function generateState() {
  return randomBytes(32).toString("hex");
}

export function buildAuthorizeUrl(state, config) {
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    state,
  }).toString();
  return url.href;
}

function statesMatch(actual, expected) {
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Strip control characters so a hostile error_description cannot mangle the terminal. */
function cleanMessage(value) {
  let out = "";
  for (const ch of String(value).slice(0, 300)) {
    const code = ch.codePointAt(0);
    const isControl = code < 32 || (code >= 127 && code <= 159); // C0, DEL and C1 ranges
    out += isControl ? " " : ch;
  }
  return out;
}

function fromParams(params, expectedState, source) {
  const failure = params.get("error_description") || params.get("error");
  if (failure) {
    throw authError(
      `Z.ai authorization failed: ${cleanMessage(failure)}`,
      "Start the login again and approve the request in the browser.",
    );
  }
  const code = (params.get("code") || params.get("authCode") || "").trim();
  const state = (params.get("state") || "").trim();
  if (!code) throw authError(`The pasted ${source} does not contain an authorization code.`);
  return { code, state };
}

/**
 * Accepts the full zcode:// callback URL, any URL carrying code/state query
 * params, a "code#state" pair, a "code=…&state=…" fragment, or a bare code.
 * The state, when present, must match the one we generated.
 */
export function parseCallback(input, expectedState) {
  const raw = String(input ?? "").trim();
  if (!raw) throw authError("No authorization code was provided.");

  let code;
  let state;
  if (raw.includes("://")) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw authError(
        "The pasted callback is not a valid URL.",
        "Paste the full zcode://zai-auth/callback?code=... URL or just the code.",
      );
    }
    if (url.protocol === `${CALLBACK_SCHEME}:`) {
      const path = `/${url.pathname.split("/").filter(Boolean).join("/")}`;
      if (path !== "/callback" || url.hostname !== "zai-auth") {
        throw authError("The pasted URL is not the Z.ai zcode://zai-auth/callback redirect.");
      }
    }
    let params = url.searchParams;
    if (!params.has("code") && !params.has("error") && url.hash.length > 1) {
      params = new URLSearchParams(url.hash.slice(1));
    }
    ({ code, state } = fromParams(params, expectedState, "URL"));
  } else if (raw.includes("=")) {
    ({ code, state } = fromParams(new URLSearchParams(raw), expectedState, "text"));
  } else if (raw.includes("#")) {
    const index = raw.indexOf("#");
    code = raw.slice(0, index).trim();
    state = raw.slice(index + 1).trim();
  } else {
    code = raw;
    state = "";
  }

  if (!code) throw authError("No authorization code found in the pasted text.");
  if (state && !statesMatch(state, expectedState)) {
    throw authError(
      "OAuth state mismatch: the callback belongs to a different login attempt.",
      "Start `zclaude login` again and use the URL from that browser window.",
    );
  }
  return { code, state: state || expectedState };
}

function str(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Exchange the code for the short-lived Z.ai OAuth access token.
 * @param {{code: string, state: string}} grant
 * @param {{tokenUrl: string, redirectUri: string}} config
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 */
export async function exchangeCode({ code, state }, config, { fetchImpl, signal } = {}) {
  let data;
  try {
    data = await requestEnvelope(
      {
        method: "POST",
        url: config.tokenUrl,
        body: { provider: "zai", code, redirect_uri: config.redirectUri, state },
        timeoutMs: TIMEOUTS.authMs,
        fetchImpl,
        signal,
      },
      { operation: "Token exchange", exitCode: EXIT.AUTH },
    );
  } catch (error) {
    if (error?.exitCode === EXIT.AUTH && !error.hint) {
      error.hint = "Authorization codes are single-use and expire quickly. Run `zclaude login` again.";
    }
    throw error;
  }
  const record = data && typeof data === "object" ? data : {};
  const zai = record.zai && typeof record.zai === "object" ? record.zai : {};
  const accessToken =
    str(zai.access_token) || str(zai.accessToken) || str(record.access_token) || str(record.accessToken);
  if (!accessToken) throw authError("Token exchange succeeded but the response carried no access token.");
  const user = record.user && typeof record.user === "object" ? record.user : {};
  log.info("auth", "token exchanged", { email: str(user.email).toLowerCase() || null, userId: str(user.id) || null });
  return {
    accessToken,
    email: str(user.email).toLowerCase(),
    userId: str(user.id) || str(user.userId) || str(user.user_id),
  };
}
