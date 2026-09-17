// What the renewal job did last time, and which profiles it has given up on.
//
// A profile whose refresh lineage the server has declared dead must not be
// retried on a timer: the answer will not change, and hammering an auth
// endpoint on a schedule is how a tool gets an account flagged. It is recorded
// with a fingerprint of the token that died, so signing that profile in again
// clears the quarantine by itself.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { zclaudeHome } from "../config.js";

function renewStatePath(env = process.env) {
  return join(zclaudeHome(env), "renew.json");
}

/** A stable, non-reversible mark for a token, so state carries no secret. */
export function tokenFingerprint(token) {
  if (typeof token !== "string" || !token) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export async function readRenewState(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(renewStatePath(env), "utf8"));
    return {
      lastRun: parsed?.lastRun ?? null,
      results: parsed?.results && typeof parsed.results === "object" ? parsed.results : {},
      quarantined: parsed?.quarantined && typeof parsed.quarantined === "object" ? parsed.quarantined : {},
      rotates: typeof parsed?.rotates === "boolean" ? parsed.rotates : null,
    };
  } catch {
    return { lastRun: null, results: {}, quarantined: {}, rotates: null };
  }
}

export async function writeRenewState(state, env = process.env) {
  const path = renewStatePath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
  return state;
}

/**
 * Whether this profile is currently quarantined for the token it holds now.
 * A different token means a new sign-in, so the quarantine no longer applies.
 */
export function isQuarantined(state, name, fingerprint) {
  const entry = state.quarantined?.[name];
  if (!entry) return false;
  return entry.fingerprint === fingerprint;
}

/** Forget a profile entirely: it was deleted, or it was signed in again. */
export function withoutProfile(state, name) {
  const results = { ...state.results };
  const quarantined = { ...state.quarantined };
  delete results[name];
  delete quarantined[name];
  return { ...state, results, quarantined };
}
