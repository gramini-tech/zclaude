# Changelog

## 0.1.0

First release.

- Profile menu: Claude Code on your Anthropic account, or Claude Code on the Z.ai GLM Coding Plan,
  plus user-defined profiles from `~/.zclaude/profiles/*.env`.
- Z.ai browser sign-in (OAuth authorization code, `zcode://` redirect) with automatic capture on macOS
  and paste fallback elsewhere; mints a durable coding-plan key named `zclaude`.
- Keychain storage on macOS, 0600 file elsewhere; `login`, `logout`, `status`, `models` commands.
- Model wizard fed by the live model list; project `.zclaude/env` over `~/.zclaude/settings`.
- Bash runner for git-clone installs.
- `zclaude login` continues into the model wizard and offers to launch; quota line names the
  5-hour and weekly windows and when a nearly used-up window resets.
- A settings.json env block that would override the session is a prompt (quit to edit, or launch
  anyway), never a silent warning; zclaude never writes Claude Code files.
- Website at https://vipincr.github.io/zclaude/ with install tabs, a first-run walkthrough, usage and
  FAQ. Higher-resolution wordmark (half-block pixels, gradient, shadow) shared by the terminal banner,
  the site logo and the favicon.
- `install.sh` for bare machines (downloads Node if needed, installs Claude Code), `self-install`
  and `self-update` commands, daily update notice, patch version bumped on every commit.
- Structured per-run log under `~/.zclaude/logs` with level and category filters, `zclaude log`
  to read it back, secrets redacted.
- Quality gate: strict ESLint, Prettier, knip, TypeScript checkJs, shellcheck, coverage thresholds,
  pre-commit hook, contract and end-to-end test suites.
