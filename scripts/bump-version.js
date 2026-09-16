// Bumps the patch version in package.json and package-lock.json and stages
// them. Runs from the pre-commit hook so every commit (and therefore every
// push) carries a new version; npm, npx and `zclaude self-update` compare
// versions to decide whether to fetch. Skip with ZCLAUDE_SKIP_BUMP=1, e.g.
// right after a manual minor or major bump.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(version).trim());
  if (!match) throw new Error(`Cannot bump non-semver version "${version}"`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function rewrite(path, version) {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text);
  data.version = version;
  if (data.packages?.[""]) data.packages[""].version = version;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.ZCLAUDE_SKIP_BUMP) process.exit(0);
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const current = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" });
  if (staged.split("\n").includes("package.json")) {
    const stagedVersion = JSON.parse(
      execFileSync("git", ["show", ":package.json"], { cwd: root, encoding: "utf8" }),
    ).version;
    const committed = (() => {
      try {
        return JSON.parse(execFileSync("git", ["show", "HEAD:package.json"], { cwd: root, encoding: "utf8" })).version;
      } catch {
        return null;
      }
    })();
    if (stagedVersion !== committed) {
      process.stdout.write(`version already changed to ${stagedVersion} in this commit; not bumping\n`);
      process.exit(0);
    }
  }
  const next = bumpPatch(current);
  rewrite(packagePath, next);
  try {
    rewrite(lockPath, next);
  } catch {
    // no lockfile
  }
  execFileSync("git", ["add", "package.json", "package-lock.json"], { cwd: root, stdio: "ignore" });
  process.stdout.write(`version ${current} -> ${next}\n`);
}
