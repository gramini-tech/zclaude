// Where Claude Code keeps a profile's credentials.
//
// Read from claude 2.1.273: the service name is "Claude Code" + a build
// suffix + "-credentials", with "-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>"
// appended whenever that variable is set. The check is whether the variable is
// set, not what it holds, so even CLAUDE_CONFIG_DIR=$HOME/.claude is a separate
// login from the default.
//
// This is a hint used for diagnostics and for finding orphaned items. It is
// never the source of truth for whether a profile is signed in, because an
// upstream change would silently invalidate it. probe.js decides that.

import { createHash } from "node:crypto";

import { canonicalConfigDir } from "./paths.js";

export const DEFAULT_CREDENTIAL_SERVICE = "Claude Code-credentials";

/**
 * @param {string | null | undefined} configDir absolute path, or null for the default login
 * @returns {string} the macOS Keychain service name Claude Code would use
 */
export function claudeCredentialService(configDir) {
  if ([null, undefined, ""].includes(configDir)) return DEFAULT_CREDENTIAL_SERVICE;
  const canonical = canonicalConfigDir(configDir);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return `${DEFAULT_CREDENTIAL_SERVICE}-${digest}`;
}

/** Where the credential file lives when no keychain is available. */
export function credentialFilePath(configDir) {
  return `${canonicalConfigDir(configDir)}/.credentials.json`;
}
