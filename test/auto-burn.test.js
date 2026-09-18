// The local burn signal: what a message cost, whose it was, and reading it back
// off disk without ever counting the same tokens twice.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { attribute, readNew, sample, totalOf, transcriptRoots, warmTranscripts } from "../src/auto/burn.js";
import { atLeast, classInUse, classOf, CLASS_WEIGHT, costOf, strongest, tokenCost } from "../src/auto/cost.js";
import { tempHome } from "./helpers.js";

const NOW = 1_800_000_000_000;
/** Files on disk carry real mtimes, so the warm-file check needs a real clock. */
const REAL = Date.now();

const usage = (over = {}) => ({
  input_tokens: 100,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 50_000,
  output_tokens: 200,
  ...over,
});

const line = (over = {}) => ({
  type: "assistant",
  timestamp: new Date(NOW).toISOString(),
  sessionId: "s1",
  message: { model: "claude-opus-5", usage: usage() },
  ...over,
});

describe("the cost model", () => {
  it("names the class of every model it should, and refuses the rest", () => {
    assert.equal(classOf("claude-fable-5-1"), "fable");
    assert.equal(classOf("claude-opus-5"), "opus");
    assert.equal(classOf("claude-sonnet-5"), "sonnet");
    assert.equal(classOf("claude-haiku-4-5-20251001"), "haiku");
    // Every profile's transcripts land in one shared tree, so a Z.ai session's
    // lines sit beside the Anthropic ones. The model id is the only thing that
    // can keep them out of an Anthropic account's accounting.
    assert.equal(classOf("glm-5.3"), null);
    assert.equal(classOf("<synthetic>"), null);
    assert.equal(classOf(undefined), null);
    // A model nobody has seen before should make us careful, not blind.
    assert.equal(classOf("claude-something-6"), "opus");
  });

  it("orders classes by what can stand in for what", () => {
    assert.ok(atLeast("fable", "opus"), "Fable can do Opus work");
    assert.ok(!atLeast("sonnet", "opus"), "Sonnet cannot do Opus work");
    assert.ok(atLeast("opus", "opus"));
    assert.equal(strongest("sonnet", "fable"), "fable");
    assert.equal(strongest(null, "haiku"), "haiku");
    assert.equal(strongest(null, null), null);
  });

  it("weights cache reads down without dropping them", () => {
    // They are ~80% of the cost even at a tenth, and 90% of the raw tokens.
    // Counting them at full rate makes a long agentic session look two orders
    // of magnitude more expensive than a chat doing the same work.
    assert.equal(tokenCost(usage()), 100 + 1250 + 5000 + 1000);
    assert.equal(tokenCost(null), 0);
    assert.equal(tokenCost({ input_tokens: "nonsense" }), 0);
  });

  it("costs a line by its class, and skips what is not one of ours", () => {
    const opus = costOf(line());
    assert.equal(opus.class, "opus");
    assert.equal(opus.cost, tokenCost(usage()) * CLASS_WEIGHT.opus);

    const fableLine = line({ message: { model: "claude-fable-5-1", usage: usage() } });
    const fable = costOf(fableLine);
    assert.equal(fable.cost, opus.cost * 2, "Fable counts double");

    const zai = line({ message: { model: "glm-5.3", usage: usage() } });
    const noUsage = line({ message: { model: "claude-opus-5", usage: null } });
    for (const skipped of [line({ type: "user" }), zai, noUsage, line({ timestamp: "not a date" })]) {
      assert.equal(costOf(skipped), null);
    }
  });

  it("keeps headroom for the strongest class seen lately, not the newest one", () => {
    // `opusplan` drops to Sonnet for a planning turn and goes back up to Opus
    // to execute. Taking the newest message would make an account with no Opus
    // left look eligible, and the next turn would be refused — the one thing
    // model continuity exists to prevent.
    const costs = [
      { at: NOW - 60_000, class: "opus" },
      { at: NOW - 1000, class: "sonnet" },
    ];
    assert.equal(classInUse(costs, { now: NOW }), "opus");
    // Once the stronger class has genuinely been gone a while, it is released.
    assert.equal(classInUse(costs, { now: NOW + 40 * 60 * 1000 }), null);
    assert.equal(classInUse([], { now: NOW }), null);
  });
});

describe("reading transcripts", () => {
  const entry = (at, model = "claude-opus-5") =>
    `${JSON.stringify(line({ timestamp: new Date(at).toISOString(), message: { model, usage: usage() } }))}\n`;

  it("reads only complete lines and resumes exactly where it stopped", async () => {
    const home = await tempHome();
    try {
      const path = join(home.dir, "t.jsonl");
      const whole = entry(NOW) + entry(NOW + 1000);
      // A line still being written must never be parsed, and the offset must
      // not move past it, or its tokens are lost for good.
      const partial = `${whole}{"type":"assistant","timesta`;
      await writeFile(path, partial);

      const first = await readNew(path, { offset: 0, size: Buffer.byteLength(partial) });
      assert.equal(first.lines.length, 2);
      assert.equal(first.offset, Buffer.byteLength(whole));

      await writeFile(path, whole + entry(NOW + 2000));
      const second = await readNew(path, {
        offset: first.offset,
        size: Buffer.byteLength(whole + entry(NOW + 2000)),
      });
      assert.equal(second.lines.length, 1, "only the line that was finished since");
    } finally {
      await home.cleanup();
    }
  });

  it("picks a truncated file back up instead of re-reading it whole", async () => {
    const home = await tempHome();
    try {
      const path = join(home.dir, "t.jsonl");
      await writeFile(path, entry(NOW));
      const short = await readNew(path, { offset: 10_000, size: Buffer.byteLength(entry(NOW)) });
      assert.equal(short.restarted, true, "`/clear` rewrites the file shorter than our offset");
      assert.equal(short.lines.length, 1, "it is read from the start rather than given up on");
    } finally {
      await home.cleanup();
    }
  });

  it("counts nothing twice when a file is rescanned", async () => {
    const home = await tempHome();
    try {
      const root = join(home.dir, "projects", "-work");
      await mkdir(root, { recursive: true });
      const path = join(root, "a.jsonl");
      await writeFile(path, entry(NOW) + entry(NOW + 1000));
      const roots = [join(home.dir, "projects")];

      // A first pass over a file we have never seen starts at its end: the
      // backlog either predates us or is already counted.
      const cold = await sample({ roots, now: REAL });
      assert.equal(cold.costs.length, 0);

      await writeFile(path, entry(NOW) + entry(NOW + 1000) + entry(NOW + 2000));
      const warm = await sample({ roots, state: cold.state, now: REAL });
      assert.equal(warm.costs.length, 1);

      // Now force the rescan: the offset is thrown away, the whole file is read
      // again, and not one of those tokens may be counted a second time. This
      // is the property the learned factor downstream depends on — it divides
      // by the change in this number.
      const rescanned = await sample({
        roots,
        state: { [path]: { offset: 1_000_000, lastAt: warm.state[path].lastAt } },
        now: REAL,
      });
      assert.equal(rescanned.costs.length, 0, "a rescan must be idempotent");
    } finally {
      await home.cleanup();
    }
  });

  it("ignores transcripts nobody has touched, and finds the ones in use", async () => {
    const home = await tempHome();
    try {
      const root = join(home.dir, "projects");
      await mkdir(join(root, "-a"), { recursive: true });
      await writeFile(join(root, "-a", "live.jsonl"), entry(NOW));
      await writeFile(join(root, "-a", "notes.txt"), "not a transcript");

      const warm = await warmTranscripts([root], { now: REAL });
      assert.deepEqual(
        warm.map((file) => file.path.split("/").at(-1)),
        ["live.jsonl"],
      );
      const cold = await warmTranscripts([root], { now: REAL + 60_000, warmMs: 0 });
      assert.equal(cold.length, 0, "a cold file is skipped");
    } finally {
      await home.cleanup();
    }
  });

  it("scans one shared transcript tree once, however many profiles point at it", async () => {
    const home = await tempHome();
    try {
      // This is the real layout: `share.history` is the default, so every
      // profile's `projects` is a symlink to the same directory.
      const real = join(home.dir, "real");
      await mkdir(join(real, "projects"), { recursive: true });
      const { symlink } = await import("node:fs/promises");
      for (const name of ["one", "two"]) {
        await mkdir(join(home.dir, name), { recursive: true });
        await symlink(join(real, "projects"), join(home.dir, name, "projects"));
      }
      const roots = await transcriptRoots([join(home.dir, "one"), join(home.dir, "two"), join(home.dir, "missing")]);
      assert.equal(roots.length, 1, "the same tree is not scanned once per profile");
    } finally {
      await home.cleanup();
    }
  });
});

describe("attributing cost to an account", () => {
  const costs = [
    { at: NOW + 1000, class: "opus", cost: 100 },
    { at: NOW + 9000, class: "fable", cost: 50 },
    { at: NOW - 5000, class: "opus", cost: 999 },
  ];

  it("credits each cost to whoever held the slot at the time", () => {
    const { byAccount, unattributed } = attribute(costs, [
      { account: "a", from: NOW, to: NOW + 5000 },
      { account: "b", from: NOW + 5000, to: null },
    ]);
    assert.equal(byAccount.get("a").get("opus"), 100);
    assert.equal(byAccount.get("b").get("fable"), 50);
    // Spend from before the slot history begins is never guessed at. A wrong
    // guess corrupts the learned factor; leaving it out shows up as a residual
    // against the next endpoint reading, which is already handled correctly.
    assert.equal(unattributed, 999);
    assert.equal(totalOf(byAccount.get("a")), 100);
    assert.equal(totalOf(undefined), 0);
  });

  it("attributes nothing at all when the slot history is empty", () => {
    const { byAccount, unattributed } = attribute(costs, []);
    assert.equal(byAccount.size, 0);
    assert.equal(unattributed, 1149);
  });
});
