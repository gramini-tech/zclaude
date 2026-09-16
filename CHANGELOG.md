# Changelog

## 0.2.0

Profiles: several Claude Code accounts on one machine, each scoped to the terminal it runs in.

- `zclaude profile add|list|show|login|logout|shell|env|remove|doctor`. A profile is a name, a
  provider (`anthropic` or `zai`), its own config directory under `~/.zclaude/profiles/<name>/home`,
  and its own credentials. `--profile <name>` launches one; the menu lists them alongside the
  built-in `claude` and `zai` entries.
- The default profile never sets `CLAUDE_CONFIG_DIR`, so your existing login and the VS Code
  extension are untouched. An inherited value is reported by `status` and `profile doctor` instead of
  being overwritten.
- Sharing, chosen per profile and defaulting to both: settings (agents, commands, skills, rules,
  output styles, workflows, themes and `CLAUDE.md` as symlinks, plus a filtered `settings.json`
  passed with `--settings`) and history (`projects/`, `history.jsonl`). The filter drops
  authentication keys always, and the model keys for a Z.ai profile, so a shared `env` block cannot
  override the GLM models zclaude selects.
- New profiles are seeded from an allowlist of `.claude.json`; identity, entitlement caches, the
  projects map and tool permissions are never copied. MCP servers and trusted folders are opt-in, and
  servers carrying secrets are named before the question is asked.
- Z.ai keys are per profile, one Keychain item each, with the existing single key migrated on first
  run. `ZAI_API_KEY` applies to the built-in `zai` profile only.
- Settings-conflict detection now reads all four tiers Claude Code applies: user, project,
  project-local and machine-wide managed policy.
- `self-uninstall` signs every profile out and names the Keychain items it removes.
- README and website rewritten around profiles, including what profiles do not isolate: managed
  policy, `~/.claude/.device-keys.json`, and anything you chose to share.

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
