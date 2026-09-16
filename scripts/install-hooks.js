// Points git at .githooks so the pre-commit guard runs for every clone.
// No-op outside a git checkout (npm installs from a tarball or GitHub) and in CI.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.CI || !existsSync(join(root, ".git"))) process.exit(0);
try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
} catch {
  // git missing or not writable: the CI workflow still enforces the same checks
}
