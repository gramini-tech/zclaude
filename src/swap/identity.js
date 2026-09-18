// The `oauthAccount` block of Claude Code's config file, and nothing else in it.
//
// That file is the one place zclaude writes inside Claude Code's own state, and
// it is not a small file: about 90 keys and 90 KB on a working machine, holding
// every project's trust and tool permissions, the MCP servers, the machine id
// and a pile of caches. Claude Code reads the account identity from it and
// trusts it — a token refresh merges profile fields but never rewrites the
// email, the account uuid or the organisation — so a swap that moves the
// credential without moving this block leaves the wrong name on screen.
//
// The rule that follows is absolute: read, replace exactly one key, write back.
// claude-swap shipped the other version once, replacing the file with a slot's
// snapshot, and it took `projects`, `mcpServers` and `userID` with it.

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "../logger.js";

const CONFIG_BASENAME = ".claude.json";

/**
 * Claude Code's global config file. It lives beside the config directory, not
 * inside it: `~/.claude.json` for the default login.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function configFilePath(env = process.env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return join(configured || env.HOME || homedir(), CONFIG_BASENAME);
}

/**
 * The config file inside a given config directory, for a profile rather than
 * the default login. The basename lives here so no other module has to name it.
 * @param {string} dir
 */
export function configFileIn(dir) {
  return join(dir, CONFIG_BASENAME);
}

/**
 * Read the whole config. Returns null when it cannot be parsed, so a caller can
 * refuse rather than write over something it does not understand.
 * @param {string} path
 */
export async function readConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true, config: null, text: null };
    throw error;
  }
  try {
    return { missing: false, config: JSON.parse(text), text };
  } catch {
    return { missing: false, config: null, text };
  }
}

/** The account Claude Code believes it is signed in as, or null. */
export async function readIdentityBlock(path) {
  const { config } = await readConfig(path);
  const account = config?.oauthAccount;
  return account && typeof account === "object" ? account : null;
}

/** A description of an identity block that a list can print. */
export function describeIdentity(account) {
  if (!account) return null;
  return {
    email: typeof account.emailAddress === "string" ? account.emailAddress : null,
    organization: typeof account.organizationName === "string" ? account.organizationName : null,
    organizationUuid: typeof account.organizationUuid === "string" ? account.organizationUuid : null,
    accountUuid: typeof account.accountUuid === "string" ? account.accountUuid : null,
    seat: typeof account.seatTier === "string" ? account.seatTier : null,
    // The same plan size as the credential's `rateLimitTier`, cached here when
    // the profile was last used. `organizationRateLimitTier` is an opaque name
    // ("default_raven" on this machine) that maps to nothing published, so it
    // is carried for diagnosis and never used to size anything.
    tier: typeof account.userRateLimitTier === "string" ? account.userRateLimitTier : null,
    organizationTier: typeof account.organizationRateLimitTier === "string" ? account.organizationRateLimitTier : null,
  };
}

/** Whether two identity blocks name the same account in the same organisation. */
export function sameAccount(a, b) {
  const left = describeIdentity(a);
  const right = describeIdentity(b);
  if (!left || !right) return false;
  return left.accountUuid === right.accountUuid && left.organizationUuid === right.organizationUuid;
}

/**
 * Replace the identity block, leaving every other key exactly as it was.
 *
 * Written to a temp file and renamed, so a crash leaves either the old file or
 * the new one. The caller holds the config lock while this runs.
 * @param {string} path
 * @param {object | null} account the block to install, or null to remove it
 */
export async function writeIdentityBlock(path, account) {
  const { config, missing, text } = await readConfig(path);
  if (config === null && !missing) {
    throw new Error(`${path} is not valid JSON. Nothing was changed; move it aside and sign in again to rebuild it.`);
  }
  const before = config ?? {};
  const next = { ...before };
  if (account) next.oauthAccount = account;
  else delete next.oauthAccount;
  const tmp = `${path}.zclaude-${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  log.info("swap", "identity block written", {
    path,
    keysBefore: Object.keys(before).length,
    keysAfter: Object.keys(next).length,
    hadText: Boolean(text),
    email: describeIdentity(account)?.email ?? null,
  });
  return { keys: Object.keys(next).length };
}
