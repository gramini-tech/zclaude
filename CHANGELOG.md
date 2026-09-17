# Changelog

## 0.2.18

Switching the global login, and three things that make that useful.

- `zclaude switch <profile>` moves the login that plain `claude`, your editor's Claude Code
  extension and every other tool that shells out to Claude Code uses. Two things move and nothing
  else: the credential in Claude Code's Keychain item and the `oauthAccount` block of
  `~/.claude.json`. Both are backed up and read back before anything is overwritten, the login being
  replaced is captured back into the profile that owns it so a token Claude Code rotated is not
  stranded, and Claude Code's own refresh locks are held throughout. `switch --status`,
  `switch --restore`, `switch capture` and `switch <name> --dry-run` round it out; `--switch <name>`
  is the flag spelling.
- Plan usage where the decision is made. The menu you get from bare `zclaude` now shows each
  account's 5-hour, weekly and per-model percentages, fetched in the background behind a spinner and
  filled in per row as they land, with `r` to re-fetch. `zclaude profile list --usage` prints the
  same numbers, and `--force` skips the cache. One cache and one `Retry-After` backoff are shared
  across every surface, so the CLI and the extension cannot saturate the endpoint between them.
- `zclaude renew install` schedules a job — a LaunchAgent, a systemd user timer or a crontab line —
  that refreshes only the profiles within two hours of expiring. It works one at a time, never
  touches the global login, and quarantines a profile at the first refresh token the server rejects
  rather than retrying it every six hours. Deleting the last Anthropic profile removes the schedule,
  and so does every uninstall path.
- A VS Code extension: `zc` in the status bar with the signed-in account, and one click for the list
  of profiles with their usage, plus add, remove, restore and refresh. It works in VS Code,
  Insiders, Cursor, Windsurf and VSCodium, and holds no credential logic — it asks `zclaude` for
  `--json` and renders the answer. `zclaude vscode install|uninstall|status` manages it, the
  installer offers it when it finds an editor (`ZCLAUDE_INSTALL_NO_VSIX=1` to skip), and the
  packaged vsix is committed and ships in the npm package rather than coming from the Marketplace.
- The "zclaude never writes under `~/.claude`" claim is now the precise one everywhere it appeared:
  never, except the switch you ask for by name. The contract test that enforced it names the single
  file allowed to write there instead, and `test/swap.test.js` proves a switch changes no other key
  of `~/.claude.json` and no file under `~/.claude`.

## 0.2.10

- `zclaude <profile>` starts a profile: `zclaude work -p "..."` is `zclaude --profile work -p "..."`.
  The first word is taken as a profile only when one by that name exists, so claude's own arguments
  still pass through, and a name that matches nothing brings up the menu with the arguments intact.
  Claude Code's command names are reserved, so a profile can never shadow `zclaude mcp list`.
- The menu and `profile list` show which account each profile is signed in as, including the
  organization. Two profiles can hold one login and still be two accounts to bill, which is what a
  company seat and a personal subscription on the same address are; a personal organization reads as
  `personal`. The identity comes from each profile's own config file, so picking from the menu never
  waits on the Keychain.
- `zclaude profile env` prints PowerShell syntax on Windows, and the installer's uninstall signs
  every profile out of Claude Code.
- Documented how arguments reach Claude Code: a profile name, like `--`, ends zclaude's own options,
  so `zclaude work --resume <session-id>` and `zclaude work --verbose` are claude's while
  `zclaude --verbose work` is zclaude's. Session ids belong to a config directory and follow the
  profile, and a profile that shares config already passes `--settings`, which a file of your own
  overrides because claude reads the last one.

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
- Uninstalling signs every profile out of Claude Code. Each profile's credential item lives outside
  `~/.zclaude`, so both `zclaude self-uninstall` and `install.sh --uninstall` remove it by name;
  `--keep-config` keeps the profiles and their logins.
- A profile named by a committed `.zclaude/env` that does not exist on this machine falls back to the
  menu with a warning. A wrong `--profile` is still an error. A launch that has to recreate a missing
  profile directory says so, because the credential item is keyed by that path.
- Guardrails: the profile command group is covered in process for its error and cancellation paths,
  the pseudo-terminal suite drives the add wizard, a Ctrl-C part way through it, a cancelled removal
  and both answers to the settings-conflict prompt, and the documentation contract now fails if the
  README or the website shows a command that does not exist.

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
