// Reading what the accounts have actually spent, from the transcripts.
//
// Every assistant line carries its own token counts, so the burn rate is
// measurable locally, for free, within about three seconds of an exchange. The
// difficulty is not reading it but knowing whose it is.
//
// A transcript's path says nothing about the account that wrote it. Sharing
// history is the default, so every profile's `projects` directory is a symlink
// to the default installation's, all of them append into one tree, and a Z.ai
// session's file sits in it beside the Anthropic ones. Attribution therefore
// works the other way round:
// each line is credited to whichever account held the global slot at that
// line's own timestamp, and anything older than the first slot entry we know
// about is discarded rather than guessed at. Model ids that are not `claude-*`
// are dropped before any of that, which is what keeps Z.ai traffic out of
// Anthropic accounting.
//
// Files reach 137 MB on this machine, so reading is by byte offset and a rescan
// has to be idempotent: the calibration downstream divides by the change in
// this number, and counting one line twice is worse than missing it.

import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { log } from "../logger.js";
import { costOf } from "./cost.js";

/** Never read more than this from one file in a cycle, or this in total. */
const FILE_CAP = 4 * 1024 * 1024;
const CYCLE_CAP = 16 * 1024 * 1024;
/** A transcript nobody has touched in this long cannot be telling us anything new. */
const WARM_MS = 30 * 60 * 1000;
/** After a truncation, pick the tail back up rather than re-reading gigabytes. */
const RESCAN_BYTES = 2 * 1024 * 1024;

/**
 * The distinct transcript trees behind a set of config directories.
 *
 * Deduplicated by real path, because the profiles almost always share one and
 * scanning it once per profile would multiply every read by the number of
 * accounts.
 * @param {string[]} configDirs
 * @returns {Promise<string[]>}
 */
export async function transcriptRoots(configDirs) {
  const seen = new Set();
  for (const dir of configDirs) {
    if (!dir) continue;
    try {
      seen.add(await realpath(join(dir, "projects")));
    } catch {
      // A profile that has never been launched has no transcripts yet.
    }
  }
  return [...seen];
}

/**
 * Every transcript worth looking at, newest activity first.
 * @param {string[]} roots
 * @param {{now?: number, warmMs?: number}} [options]
 * @returns {Promise<Array<{path: string, size: number, mtimeMs: number}>>}
 */
export async function warmTranscripts(roots, { now = Date.now(), warmMs = WARM_MS } = {}) {
  const perRoot = await Promise.all(roots.map((root) => warmUnder(root, { now, warmMs })));
  return perRoot.flat().toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

async function warmUnder(root, { now, warmMs }) {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = projects.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  const perDir = await Promise.all(dirs.map((dir) => warmIn(dir, { now, warmMs })));
  return perDir.flat();
}

async function warmIn(dir, { now, warmMs }) {
  const names = await readdir(dir).catch(() => []);
  const found = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path).catch(() => null);
        if (!info || now - info.mtimeMs > warmMs) return null;
        return { path, size: info.size, mtimeMs: info.mtimeMs };
      }),
  );
  return found.filter(Boolean);
}

/**
 * Read whatever is new in one file, from `offset` to the last complete line.
 *
 * Partial lines are never parsed and the offset never advances past one, so the
 * remainder is picked up whole on the next pass. A file shorter than the offset
 * was truncated or rotated — `/clear` does this — and is picked up from near its
 * new end instead of from the beginning.
 *
 * @param {string} path
 * @param {{offset?: number, size: number, cap?: number}} where
 * @returns {Promise<{lines: object[], offset: number, restarted: boolean}>}
 */
export async function readNew(path, { offset = 0, size, cap = FILE_CAP }) {
  let from = offset;
  let restarted = false;
  if (size < from) {
    from = Math.max(0, size - RESCAN_BYTES);
    restarted = true;
  }
  if (size <= from) return { lines: [], offset: from, restarted };
  const length = Math.min(size - from, cap);
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return { lines: [], offset: from, restarted };
  let text;
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    text = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
  const end = text.lastIndexOf("\n");
  if (end === -1) return { lines: [], offset: from, restarted };
  const whole = text.slice(0, end);
  // A restart lands mid-line, so the first fragment is dropped on purpose.
  const parts = restarted && from > 0 ? whole.split("\n").slice(1) : whole.split("\n");
  const lines = parts.map(parseLine).filter(Boolean);
  return { lines, offset: from + Buffer.byteLength(whole, "utf8") + 1, restarted };
}

function parseLine(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A line written while we were reading it. The next pass sees it whole.
    return null;
  }
}

/**
 * One pass over every warm transcript, returning only what is new.
 *
 * @param {{roots: string[], state?: Record<string, {offset: number, lastAt: number}>, now?: number, cycleCap?: number}} input
 * @returns {Promise<{costs: Array<object>, state: Record<string, {offset: number, lastAt: number}>}>}
 */
export async function sample({ roots, state = {}, now = Date.now(), cycleCap = CYCLE_CAP }) {
  const files = await warmTranscripts(roots, { now });
  /** @type {Record<string, {offset: number, lastAt: number}>} */
  const next = {};
  const costs = [];
  let budget = cycleCap;
  for (const file of files) {
    const seen = state[file.path];
    // A file we have never read starts at its end. Everything before this
    // moment either predates the daemon or is already counted, and reading a
    // 137 MB backlog to conclude that would cost seconds for nothing.
    const offset = seen ? seen.offset : file.size;
    if (budget <= 0) {
      next[file.path] = seen ?? { offset, lastAt: 0 };
      continue;
    }
    const read = await readNew(file.path, { offset, size: file.size, cap: Math.min(FILE_CAP, budget) });
    budget -= Math.max(0, read.offset - offset);
    // The last timestamp counted survives a restart. That is the case it exists
    // for: a truncated file is re-read from near its start, so without it every
    // line still in the file is counted a second time.
    const taken = collect(read.lines, seen?.lastAt ?? 0, file.path);
    costs.push(...taken.costs);
    next[file.path] = { offset: read.offset, lastAt: taken.lastAt };
  }
  if (budget <= 0) log.debug("auto", "transcript read hit its cycle cap", { files: files.length });
  return { costs, state: next };
}

/**
 * The costs in these lines that we have not already counted.
 *
 * The timestamp guard is what makes a rescan idempotent. Without it a truncated
 * file, or an offset reset, counts the same tokens twice, and the factor
 * learned downstream is wrong until the next endpoint reading re-anchors it.
 */
function collect(lines, since, path) {
  const costs = [];
  let lastAt = since;
  for (const line of lines) {
    const cost = costOf(line);
    if (!cost || cost.at <= lastAt) continue;
    costs.push({ ...cost, path });
    lastAt = cost.at;
  }
  return { costs, lastAt };
}

/**
 * Credit each cost to whoever held the global slot when it was spent.
 *
 * @param {Array<{at: number, class: string, cost: number}>} costs
 * @param {Array<{account: string, from: number, to?: number | null}>} slotHistory
 * @returns {{byAccount: Map<string, Map<string, number>>, unattributed: number}}
 */
export function attribute(costs, slotHistory = []) {
  const byAccount = new Map();
  let unattributed = 0;
  const held = slotHistory.toSorted((a, b) => a.from - b.from);
  for (const cost of costs) {
    const owner = held.findLast(
      (entry) => entry.from <= cost.at && (entry.to === null || entry.to === undefined || cost.at < entry.to),
    );
    if (!owner) {
      // Spend we cannot place: from before the daemon started, or from a
      // session on another machine. It is never guessed at — a wrong guess
      // corrupts the learned factor, and the endpoint's own residual already
      // accounts for it correctly.
      unattributed += cost.cost;
      continue;
    }
    const classes = byAccount.get(owner.account) ?? new Map();
    classes.set(cost.class, (classes.get(cost.class) ?? 0) + cost.cost);
    byAccount.set(owner.account, classes);
  }
  return { byAccount, unattributed };
}

/** The total across every class, for one account's entry from `attribute`. */
export function totalOf(classes) {
  const costs = classes ? [...classes.values()] : [];
  return costs.reduce((total, cost) => total + cost, 0);
}
