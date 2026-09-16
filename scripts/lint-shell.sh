#!/bin/sh
# Lints the bash runner and hook with ShellCheck. Enforced when the binary exists
# (CI installs it); skipped with a notice otherwise so local runs still work.
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck zclaude .githooks/pre-commit scripts/lint-shell.sh
else
  if [ -n "${CI:-}" ]; then echo "shellcheck is required in CI" >&2; exit 1; fi
  echo "shellcheck not installed; skipping shell lint (brew install shellcheck)" >&2
fi
