# zclaude

Interactive preloader for [Claude Code](https://claude.com/claude-code). Type `zclaude`, pick whether
this session runs on your Anthropic account or on your [Z.ai GLM Coding Plan](https://z.ai/subscribe),
and it hands off to `claude` with the right environment injected into that one child process.

```
                    ████                              ██
                      ██                              ██
████████    ██████    ██      ██████  ██    ██    ██████    ████
      ██  ██          ██          ██  ██    ██  ██    ██  ██    ██
    ██    ██          ██      ██████  ██    ██  ██    ██  ████████
  ██      ██          ██    ██    ██  ██    ██  ██    ██  ██
████████    ██████  ██████    ██████    ██████    ██████    ██████
```

Why it exists: every published recipe for GLM in Claude Code writes the API key in plaintext into
`~/.claude/settings.json` or a shell rc file, and then Claude Code is stuck on Z.ai until you edit it
back. zclaude keeps the key in the macOS Keychain (or a 0600 file elsewhere), obtains it through Z.ai's
own browser sign-in instead of copy-pasting from the console, and lets you choose per launch.

## Install

Pick one. All three end with a `zclaude` command on your PATH.

**New machine, nothing installed** (macOS or Linux, x64 or arm64; needs only `curl` and `tar`):

```sh
curl -fsSL https://vipincr.github.io/zclaude/install | bash
```

The installer uses the Node.js already on your machine when it is 20.17 or newer. Only when Node is
missing or older does it download an official build into `~/.zclaude/node` for zclaude alone
(checksum-verified against nodejs.org); a system Node is never replaced or upgraded. It then puts zclaude in `~/.zclaude/app`, links `~/.local/bin/zclaude`,
adds `~/.local/bin` to your shell PATH, and runs Anthropic's Claude Code installer if `claude` is
missing. Re-running it updates zclaude in place; `install.sh --uninstall` removes it and leaves your
settings, logs and stored key alone. Knobs: `ZCLAUDE_INSTALL_REF` (git ref, default `main`),
`ZCLAUDE_INSTALL_DIR`, `ZCLAUDE_BIN_DIR`, `ZCLAUDE_NODE_VERSION` (default 22),
`ZCLAUDE_INSTALL_FORCE_NODE=1` (private Node even if one exists), `ZCLAUDE_INSTALL_NO_CLAUDE=1`,
`ZCLAUDE_INSTALL_NO_RC=1` (do not touch rc files), `ZCLAUDE_INSTALL_SOURCE` (a local checkout or
`.tgz` for offline installs).

**Node.js already installed:**

```sh
npx github:vipincr/zclaude                 # run it once, nothing kept
npx github:vipincr/zclaude self-install    # install globally through npm, then just type zclaude
npm install -g github:vipincr/zclaude      # the same, directly
npm install -g zclaude                     # once published to the npm registry
```

**From a clone:**

```sh
git clone https://github.com/vipincr/zclaude.git && cd zclaude && npm install
ln -s "$PWD/zclaude" ~/.local/bin/zclaude
```

The `zclaude` bash runner finds a suitable Node (PATH, `~/.zclaude/node`, nvm, volta, fnm, Homebrew) and
executes `bin/zclaude.js`.

### Updating

The version number goes up with every commit, so every push is a new version. Once a day an interactive
launch checks GitHub (2.5 s timeout, `ZCLAUDE_NO_UPDATE_CHECK=1` disables it) and prints a one-line
notice when a newer version exists. To update:

```sh
zclaude self-update                        # re-runs whichever install path put zclaude here
npx github:vipincr/zclaude self-update     # the same, without a global install
```

`self-update` re-runs the curl installer for installer-based setups, `npm install -g` for npm-based ones,
and tells you to `git pull` in a checkout. `npx github:vipincr/zclaude` on its own always resolves the
current `main`.

## Use

```
zclaude                         menu, then launch
zclaude -p "explain this repo"  menu, then launch claude with those arguments
zclaude --profile zai           skip the menu
zclaude -- --help               claude's own help
zclaude login                   sign in to Z.ai now (browser), then offer to pick models and launch
zclaude login --api-key         paste a key from the Z.ai console instead
zclaude logout                  forget the stored key
zclaude status                  what would happen on the next launch
zclaude models                  models your plan can use
zclaude --reconfigure           re-run the model wizard
```

### Options

All zclaude options go before any argument meant for `claude`.

| Option                                  | Effect                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `--profile <claude\|zai\|name>`         | skip the menu                                                            |
| `--reconfigure`, `--customize`          | run the model wizard even when config exists                             |
| `--login`                               | sign in to Z.ai again before launching                                   |
| `--model <id>`                          | primary model for the Z.ai profile; forwarded to `claude` otherwise      |
| `--subagent-model <id>`                 | subagent model (`CLAUDE_CODE_SUBAGENT_MODEL`)                            |
| `--fast-model <id>`                     | haiku-class helper model                                                 |
| `--no-store`                            | keep the key in memory for this session only                             |
| `--no-browser`, `--paste`               | login: print the URL instead of opening a browser; always paste the code |
| `--api-key`                             | login: paste a key from the Z.ai console instead of the browser flow     |
| `--json`                                | status: machine-readable output                                          |
| `--no-banner`                           | skip the splash                                                          |
| `--verbose`                             | show each step (use `zclaude -- --verbose` to pass it to `claude`)       |
| `--quiet`                               | terminal shows only warnings and errors                                  |
| `--log-level`, `--log-file`, `--no-log` | run-log controls, see "Run logs" below                                   |
| `--path`                                | `zclaude log`: print only the log file path                              |
| `--help`, `--version`                   | zclaude help and versions (`zclaude -- --help` for claude's own)         |

### First Z.ai launch

1. The menu offers **Claude Code** and **Claude Code + Z.ai GLM Coding Plan**.
2. Choosing Z.ai with no stored key opens `chat.z.ai` in your browser. Approve the request.
3. On macOS the redirect is captured automatically (the browser asks once whether to open
   "zclaude OAuth Callback"). On Linux and Windows, paste the `zcode://...` URL the browser lands on.
4. zclaude exchanges the code, mints a coding-plan API key named `zclaude` on your account, checks it
   against the models endpoint and stores it in the Keychain.
5. The model wizard asks for a primary model, a subagent model and a fast helper model, listing what
   your plan can actually use, and offers to save the answer per project or as your user default.
6. `claude` starts with the GLM models. Quit it and you are back to a clean shell; nothing about
   Z.ai leaks into your other Claude Code sessions.

`zclaude login` on its own does the same sign-in, then asks whether to pick models and launch right away.
Later launches skip straight from the menu to `claude`.

## Run logs (post-mortem)

Every invocation writes a structured JSON-lines log to `~/.zclaude/logs/zclaude-<date>-<time>-<pid>.log`
(the 30 newest are kept). It records the run header (version, Node, arguments, which relevant variables
were set), every settings file read, the profile and models chosen, the credential source and its
validation result, each HTTP call with status and timing, the browser callback mode, the exact `claude`
spawn with its environment variable names, and claude's exit code. Secrets are redacted before anything
is written; the key only ever appears as `****xxxx`.

```
zclaude log            # latest run, one line per entry
zclaude log --json     # the same as JSON
zclaude log --path     # just the file path
zclaude status         # also shows the current run's log file
```

Levels are `error`, `warn`, `info`, `debug` (default) and `trace` (adds request headers and bodies).
Categories are `cli`, `config`, `profile`, `auth`, `callback`, `provision`, `store`, `zai`, `http`,
`claude` and `console` (everything printed to the terminal).

| Control                                           | Effect                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `--log-level <level>`, `ZCLAUDE_LOG_LEVEL`        | detail written to the file; `off` disables it                         |
| `ZCLAUDE_LOG_CATEGORIES`                          | `auth,http` keeps only those; `-console,-http` drops those; forms mix |
| `--log-file <path>`, `ZCLAUDE_LOG=<path>`         | write this run's log to a specific file                               |
| `--no-log`, `ZCLAUDE_NO_LOG=1`, `ZCLAUDE_LOG=off` | no run log at all                                                     |
| `ZCLAUDE_LOG_DIR`                                 | directory for run logs (default `~/.zclaude/logs`)                    |
| `ZCLAUDE_LOG_KEEP`                                | how many run logs to keep (default 30)                                |
| `ZCLAUDE_ALLOW_SETTINGS_OVERRIDE=1`               | launch even when settings.json's env block overrides this session     |
| `ZCLAUDE_NO_UPDATE_CHECK=1`                       | skip the daily check for a newer version                              |
| `--quiet`                                         | terminal shows only warnings and errors (the file is unaffected)      |

When a run fails, the error line on the terminal is followed by the path of that run's log.

## What gets set in the child process

| Variable                                                       | Value                               |
| -------------------------------------------------------------- | ----------------------------------- |
| `ANTHROPIC_AUTH_TOKEN`                                         | the stored key                      |
| `ANTHROPIC_BASE_URL`                                           | `https://api.z.ai/api/anthropic`    |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`              | primary model                       |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` | subagent model                      |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`                                | fast model                          |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW`                              | context window of the primary model |
| `API_TIMEOUT_MS`                                               | `3000000`                           |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`                     | `1`                                 |

`ANTHROPIC_API_KEY` is removed from the child environment to avoid Claude Code's auth-conflict prompt.
Models with a 1M context (`glm-5.3`, `glm-5.3-flash`, `glm-5.2`) get the `[1m]` suffix Claude Code
expects. Both the alias variables and the direct ones are set so a `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`
in your own `settings.json` still resolves to the chosen GLM model.

Claude Code applies the `env` block of its own `settings.json` **over** the process environment (measured
with claude 2.1.273). If that block sets one of the variables above to a different value, the session would
silently run with the file's value, so zclaude stops and asks whether to quit and edit the file yourself or
launch anyway. It never edits the file. Non-interactive runs exit with code 2 in that case;
`ZCLAUDE_ALLOW_SETTINGS_OVERRIDE=1` launches anyway. Identical values and the `opus`, `sonnet` and `haiku`
aliases are not conflicts.

## Configuration

Two dotenv files, no secrets in either:

```
./.zclaude/env          project choices, safe to commit
~/.zclaude/settings     user defaults
```

```sh
ZCLAUDE_MODEL=glm-5.3
ZCLAUDE_SUBAGENT_MODEL=glm-5.3-flash
ZCLAUDE_FAST_MODEL=glm-5.3-flash
ZCLAUDE_PROFILE=zai          # optional: skip the menu for this project
```

Precedence per value: command-line flag, then process environment, then project file, then user file,
then the built-in default. Any other `KEY=value` lines in these files are passed through to `claude`.

The wizard runs when there is no user settings file (and the project file does not already pin all three
models), or whenever you pass `--reconfigure`.

### Extra profiles

Drop `~/.zclaude/profiles/<name>.env` files to add menu entries. Their `KEY=value` lines are applied to
the child environment. Add `ZCLAUDE_ZAI=1` to route the profile through the Z.ai credential and model
steps as well.

```sh
# name: Work MCP servers
# description: Z.ai plus the team MCP token
ZCLAUDE_ZAI=1
MY_TEAM_MCP_TOKEN=...
```

### Environment variables

| Variable                                                                                                                                             | Effect                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ZAI_API_KEY`                                                                                                                                        | use this key for the Z.ai profile, never store it, fail loudly if rejected |
| `ZCLAUDE_PROFILE`                                                                                                                                    | default profile, skips the menu                                            |
| `ZCLAUDE_HOME`                                                                                                                                       | config directory (default `~/.zclaude`)                                    |
| `ZCLAUDE_CLAUDE_BIN`                                                                                                                                 | path to `claude`                                                           |
| `ZCLAUDE_NO_STORE=1`                                                                                                                                 | never persist the key                                                      |
| `ZCLAUDE_NO_KEYCHAIN=1`                                                                                                                              | use the file store even on macOS                                           |
| `ZCLAUDE_NO_NATIVE_CALLBACK=1`                                                                                                                       | always paste the redirect URL                                              |
| `ZCLAUDE_NO_BANNER=1`                                                                                                                                | skip the splash                                                            |
| `ZCLAUDE_LOGIN_TIMEOUT`                                                                                                                              | seconds to wait for the browser (default 300)                              |
| `ZCLAUDE_KEY_NAME`                                                                                                                                   | name of the key minted on your Z.ai account (default `zclaude`)            |
| `ZCLAUDE_BASE_URL`                                                                                                                                   | API base (default `https://api.z.ai`)                                      |
| `ZAI_OAUTH_CLIENT_ID`, `ZAI_OAUTH_AUTHORIZE_URL`, `ZAI_OAUTH_TOKEN_URL`, `ZAI_OAUTH_REDIRECT_URI`, `ZAI_BIZ_LOGIN_URL`, `ZCLAUDE_ANTHROPIC_BASE_URL` | endpoint overrides if Z.ai changes its allowlist or paths                  |

## Exit codes

| Code     | Meaning                                                                             |
| -------- | ----------------------------------------------------------------------------------- |
| claude's | `claude` ran; its exit code is passed through (128+n for signals)                   |
| 1        | unexpected error (re-run with `--verbose`)                                          |
| 2        | usage error, or no terminal where one is needed                                     |
| 3        | `claude` not installed                                                              |
| 4        | Z.ai sign-in or key provisioning failed                                             |
| 5        | a key you supplied (`ZAI_API_KEY` or inherited `ANTHROPIC_AUTH_TOKEN`) was rejected |
| 6        | Z.ai unreachable                                                                    |
| 130      | interrupted                                                                         |

Non-interactive use (CI, scripts) never prompts: pass `--profile`, provide `ZAI_API_KEY` or a key stored by
an earlier interactive `zclaude login`, and models come from config or defaults.

## How the sign-in works

Z.ai does not document a CLI login. Its ZCode desktop app uses a standard OAuth authorization-code flow
against `chat.z.ai` with a public client id, and the same flow is used by zcode-cli, oh-my-pi and
CLIProxyAPI. zclaude does the same:

1. `GET https://chat.z.ai/api/oauth/authorize` with `redirect_uri=zcode://zai-auth/callback` and a random state.
2. Z.ai only allows that custom scheme as redirect target. On macOS, zclaude compiles a tiny background
   AppleScript app, registers it as the temporary `zcode://` handler, and restores the previous handler
   when done (a recovery journal cleans up if the process dies). Elsewhere you paste the URL.
3. `POST https://zcode.z.ai/api/v1/oauth/token` exchanges the code for a short-lived token.
4. Z.ai's business API turns that into a durable coding-plan key: login, default org and project,
   find-or-create a key named `zclaude`, copy its secret.
5. The key is checked against `GET https://api.z.ai/api/coding/paas/v4/models`, which also yields the
   model list for the wizard.

## What zclaude never touches

Everything zclaude tells Claude Code travels in the environment of the one `claude` process it spawns.
It never edits `~/.claude/settings.json`, `~/.claude.json`, project `.claude/` settings or any other
Claude Code file. The only interaction with those files is a read of `settings.json` to detect an `env`
block that would override the session (see above). Quit `claude` and your Claude Code setup is exactly as before.
A contract test scans the source for writes near Claude paths, and an end-to-end test hashes fake
config files before and after a run.

## Security notes

- The key travels only to `api.z.ai`, `zcode.z.ai` and `chat.z.ai`. No telemetry.
- macOS: Keychain item with service `zclaude`, written over stdin to the `security` tool so the secret
  never appears in a process listing. Elsewhere: `~/.zclaude/credentials.json`, mode 0600.
- The `zclaude` key on your Z.ai account is durable. `zclaude logout` removes the local copy only;
  revoke it at https://z.ai/manage-apikey/apikey-list.
- Secrets are masked in every log line and error message.

## Development

```sh
npm test               # node:test unit, contract and end-to-end suites
npm run lint           # eslint (recommended + unicorn + n + promise + security + sonarjs), prettier, knip, tsc --checkJs, shellcheck
npm run test:coverage  # same tests with coverage thresholds (80% lines, 75% branches and functions)
npm run check          # everything CI runs, plus npm pack --dry-run
```

The lint toolchain needs Node 22 or newer (the runtime itself works on 20.17+). `npm install` points git at `.githooks`, so the pre-commit hook runs `npm run lint` and the coverage-gated
tests before every commit (`ZCLAUDE_SKIP_HOOKS=1` bypasses it). Three suites protect the core against
regressions: `test/contract.test.js` pins the Z.ai endpoints, the child environment, the exit codes and
the documentation of every flag and variable; `test/e2e.test.js` runs the real binary against a fake Z.ai
server and a fake `claude`; `test/interactive.test.js` drives the menu inside a real pseudo-terminal on
macOS.

Publishing to npm: `npm publish --access public` from a clean checkout.

## License

MIT
