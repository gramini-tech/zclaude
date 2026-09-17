# zclaude

Run several Claude Code accounts at once, one per terminal. `zclaude` launches
[Claude Code](https://claude.com/claude-code) with a profile you pick: a work account, a personal
account, or a [Z.ai GLM Coding Plan](https://z.ai/subscribe). Everything it configures travels in the
environment of that one `claude` process, so the accounts never collide and your normal setup stays
where it is.

<p align="center">
  <img src="site/logo.svg" alt="zclaude" width="560">
</p>

<p align="center"><a href="https://vipincr.github.io/zclaude/">vipincr.github.io/zclaude</a></p>

## The problem

Claude Code keeps one login per machine. Sign in with a second account and the first one is signed
out, including in the VS Code extension. If you have a work account and a personal one, or two
clients, you end up logging in and out all day.

Z.ai has the mirror-image problem. Every published recipe for running GLM models in Claude Code puts
the API key in plaintext in `~/.claude/settings.json` or a shell rc file, and then Claude Code is
stuck on Z.ai until you edit it back.

zclaude solves both with **profiles**. Each profile has its own credentials and its own Claude Code
configuration directory, scoped to the terminal you start it from. Three terminals can hold three
different accounts at the same time, and the login you already had keeps working everywhere else.

What a profile really holds is a billing context. A company seat and a personal Max subscription on
the same email address are two accounts with separate usage, so each gets its own profile, and
`profile list` prints the organization next to the address to keep them apart.

## Install

Pick one. All of them end with a `zclaude` command on your PATH.

**New machine, nothing installed** (macOS or Linux, x64 or arm64; needs only `curl` and `tar`):

```sh
curl -fsSL https://vipincr.github.io/zclaude/install | bash
```

The installer uses the Node.js already on your machine when it is 20.17 or newer. Only when Node is
missing or older does it download an official build into `~/.zclaude/node` for zclaude alone
(checksum-verified against nodejs.org); a system Node is never replaced or upgraded. It then puts
zclaude in `~/.zclaude/app`, links `~/.local/bin/zclaude`, adds `~/.local/bin` to your shell PATH,
and runs Anthropic's Claude Code installer if `claude` is missing. Re-running it updates zclaude in
place; `curl -fsSL https://vipincr.github.io/zclaude/install | bash -s -- --uninstall` removes
everything: the app, the private Node, the command, the PATH line it added, `~/.zclaude`, the
stored Z.ai keys and the Claude Code login of each profile. Add `--keep-config` to keep `~/.zclaude`. Knobs: `ZCLAUDE_INSTALL_REF` (git ref,
default `main`), `ZCLAUDE_INSTALL_DIR`, `ZCLAUDE_BIN_DIR`, `ZCLAUDE_NODE_VERSION` (default 22),
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

The `zclaude` bash runner finds a suitable Node (PATH, `~/.zclaude/node`, nvm, volta, fnm, Homebrew)
and executes `bin/zclaude.js`.

### Updating

The version number goes up with every commit, so every push is a new version. Once a day an
interactive launch checks GitHub (2.5 s timeout, `ZCLAUDE_NO_UPDATE_CHECK=1` disables it) and prints
a one-line notice when a newer version exists.

```sh
zclaude self-update                        # re-runs whichever install path put zclaude here
zclaude self-update --force                # install anyway, when the check says you are current
npx github:vipincr/zclaude self-update     # the same, without a global install
zclaude self-uninstall                     # remove zclaude, its profiles, their logins, settings and logs
zclaude self-uninstall --keep-config       # keep ~/.zclaude
```

`self-update` re-runs the curl installer for installer-based setups, `npm install -g` for npm-based
ones, and tells you to `git pull` in a checkout. It reads the version back from what it installed and
reports that, rather than asking you to go and check.

The check reads `package.json` from the default branch through GitHub's contents API, which answers
with the file as it is now. `raw.githubusercontent.com`, the obvious place to read it from, serves a
copy that can be several minutes old, so it is only the fallback for when the API's rate limit is
reached. If a check still says you are current when you know better, `--force` installs anyway.

## Quick start

```sh
zclaude                                    # menu of everything you have set up
zclaude profile add work                   # a second account, with its own login
zclaude work                               # this terminal runs on that account
```

That is the whole idea. `zclaude` on its own shows a menu; naming a profile skips it. Anything else
you type is passed to `claude`, so `zclaude mcp list` and `zclaude -p "hi"` still work, and profile
names can never be one of claude's own commands.

## Profiles

A profile is a name plus four things:

| Field          | What it means                                                                          |
| -------------- | -------------------------------------------------------------------------------------- |
| **provider**   | `anthropic` (a Claude subscription or Console billing) or `zai` (a GLM Coding Plan)    |
| **directory**  | its own Claude Code config directory, under `~/.zclaude/profiles/<name>/home`          |
| **sharing**    | what it borrows from your main setup: settings, history, both (the default) or nothing |
| **credential** | its own login. Anthropic logins live in Claude Code's own store, Z.ai keys in yours    |

Two profiles are always there and need no setup:

- **`claude`** is your existing login, launched with nothing changed. zclaude never sets a config
  directory for it, because Claude Code treats the _presence_ of `CLAUDE_CONFIG_DIR` as a different
  account, even when it points at `~/.claude`.
- **`zai`** is a single GLM Coding Plan, the original behaviour of this tool.

### Adding one

```sh
zclaude profile add                # asks for everything
zclaude profile add work --provider anthropic --share all
zclaude profile add glm --provider zai --share config
```

The wizard asks for the name, the provider, what to share, whether to copy your MCP servers (it names
the ones whose definitions carry secrets), whether to carry over the folders you already trust, and
whether to sign in now. Nothing is copied that you did not agree to.

Signing in to an Anthropic profile runs Claude Code's own browser login with the profile's directory
in place, which is what keeps the credential out of your default account's Keychain item. Pass
`--sso`, `--console` or `--email you@example.com` and they go straight through to `claude auth login`.

### Using one

```sh
zclaude work                               # one launch
zclaude work -p "review this diff"         # everything after the name goes to claude
zclaude --profile work                     # the explicit form, for scripts and aliases
zclaude profile shell work                 # a subshell where plain `claude` is that account
ZCLAUDE_PROFILE=work zclaude               # same thing through the environment
```

The first word is treated as a profile only when a profile by that name exists. Anything else is
claude's: `zclaude mcp list` reaches claude's MCP command, and since profile names cannot be one of
claude's commands, the two can never collide. A name that matches nothing brings up the menu, with
your arguments still passed through.

`zclaude profile shell` is the honest way to pin a terminal: it starts your shell with the profile in
place and tells you when you leave. `zclaude profile env work` prints the same variables for scripts,
with a warning, because everything you start from that shell inherits them. Launching `code .` from a
pinned shell would move the VS Code extension onto that profile. On Windows the lines come out in
PowerShell syntax unless `SHELL` names a POSIX shell.

Two terminals can run the same profile, exactly as two terminals can run one login today. They share
the profile's transcripts and interface state, so the last one to write a preference wins.

### Managing them

```sh
zclaude profile list                       # names, accounts, what each one shares
zclaude profile show work                  # directory, credential item, identity, shares
zclaude profile login work                 # sign in (or sign in again)
zclaude profile logout work                # sign out of that profile only
zclaude profile remove work --yes          # delete the profile, its login and its directory
zclaude profile doctor                     # check every profile and this shell
```

`profile list` reads identity from each profile's own config file and asks the Keychain whether an
item exists, without ever reading the secret. A locked Keychain reports `unknown` rather than
pretending you are signed out.

```
gramini    anthropic vipinr@gramini.com · Hoomanely Inc    shares config + history
hoomanely  anthropic vipinr@hoomanely.com · Hoomanely Inc  shares config + history
max        anthropic vipinr@hoomanely.com · personal       shares config + history
chinese    zai       signed out                            shares config + history
```

The last two Anthropic rows are one login and two accounts: a team seat billed to the company, and a
personal subscription billed to the individual. They have separate usage, so they get separate
profiles, and the organization is what tells them apart at a glance. A personal organization, which
Claude names after the account that owns it, is shown as `personal`.

## Passing arguments to Claude Code

zclaude is a launcher, so most of what you type is not for it. The rule is positional:

```
zclaude [its own options] [profile] [everything else goes to claude]
```

Naming a profile ends zclaude's own options. After that word, every argument is claude's, including
the ones zclaude also defines:

```sh
zclaude work --resume 1b4f0e9a-…          # claude gets --resume <id>
zclaude work -c                            # claude gets --continue
zclaude work --verbose -p "explain this"   # --verbose is claude's here
zclaude --verbose work -p "explain this"   # --verbose is zclaude's here
```

Without a profile name, `--` does the same job, and you need it for anything zclaude would otherwise
claim:

```sh
zclaude -- --resume 1b4f0e9a-…             # menu first, then claude with --resume
zclaude -- --help                          # claude's help; zclaude --help is zclaude's
zclaude -- --version                       # claude's version; zclaude -V is zclaude's
zclaude work -- --verbose                  # the separator after a name is allowed and dropped
```

Bare words that are not profiles are claude's too, so its subcommands work unchanged:
`zclaude mcp list`, `zclaude auth status`, `zclaude doctor`. Profile names cannot be one of claude's
command names, so there is nothing to disambiguate.

### The handful of flags zclaude takes first

These matter only when they come **before** a profile name or without one:

| Flag                                 | zclaude's meaning                                | How to reach claude's           |
| ------------------------------------ | ------------------------------------------------ | ------------------------------- |
| `--model <id>`                       | the primary model for a Z.ai profile             | after the profile name, or `--` |
| `--verbose`                          | show what zclaude is doing                       | after the profile name, or `--` |
| `--json`                             | machine-readable output for `status` and friends | after the profile name, or `--` |
| `-h`, `--help`                       | zclaude's help                                   | `zclaude -- --help`             |
| `-V`, `--version`                    | zclaude's and claude's versions                  | `zclaude -- --version`          |
| `--profile`, `--share`, `--provider` | zclaude's own, no claude equivalent              | n/a                             |

`--settings` is claude's alone. A profile that shares config already passes one, pointing at the
filtered copy; claude reads the last `--settings` on the command line, so a file of your own comes
after and wins.

### Resuming a session

Session ids come from claude (`claude --resume` with no value lists them, and `--bg` prints the id of
a background session). They are per config directory, so they follow the profile:

```sh
zclaude work --resume 1b4f0e9a-…           # resume in the work profile
zclaude work -c                            # most recent session in this directory
zclaude work --resume 1b4f0e9a-… --fork-session
```

With **shared history**, `projects/` is shared, so a session started under any profile that shares it
can be resumed from another, and `--continue` picks the most recent session in the directory whoever
wrote it. With `--share config` or `--share none`, a profile sees only its own sessions and an id
from elsewhere will not be found. `zclaude profile list` shows which profiles share history.

## Multiple Claude accounts

This is the case zclaude was extended for. Say you have a company account, a client account and a
personal one:

```sh
zclaude profile add company --provider anthropic --share all
zclaude profile add client  --provider anthropic --share config
zclaude profile add personal --provider anthropic --share none
```

One of these can be the same email as another. What makes them separate accounts is the
organization: a seat on a company plan and a personal subscription are billed and metered apart, and
Claude Code treats them as different logins. Give each one a profile.

Then, in three terminals:

```sh
zclaude company        # terminal 1
zclaude client         # terminal 2
zclaude personal       # terminal 3
```

All three run at once. Your original login is untouched, so a fourth terminal running plain `claude`,
and the VS Code extension, stay on the account they were on. Each profile keeps its own transcripts,
permissions, trust decisions and MCP servers.

Claude Code keys its credential store by the config directory: the Keychain item is
`Claude Code-credentials` for the default login and `Claude Code-credentials-<8 hex>` for a profile,
where the suffix is a hash of the directory path. `zclaude profile show <name>` prints the exact item
name, which is what you would look for in Keychain Access.

## Switching the global login

Profiles cover the terminals you start with zclaude. They do nothing for plain `claude`, for the VS
Code extension, or for anything else that shells out to Claude Code: those use the machine's one
global login. `switch` moves that login to a profile's account, in place.

```sh
zclaude switch work              # the global login is now work's account
zclaude switch --status          # who holds it, and what is backed up
zclaude switch --restore         # put the previous one back
zclaude switch work --dry-run    # say what would change, change nothing
zclaude --switch work            # the same as the first line
```

Your projects, history, sessions and MCP logins stay exactly where they are: an account is two
things, and only those two move. The credential in the Keychain item Claude Code reads, and the
`oauthAccount` block of `~/.claude.json`. Everything else in that file — the trust decisions, the
tool permissions, your MCP servers, the machine id — is read, kept and written back untouched.

What happens on a switch, in order:

1. The locks Claude Code uses for its own token refresh are taken first, so a swap cannot land in
   the middle of one.
2. The login being replaced is **captured back** into the profile it belongs to. Claude Code
   refreshes tokens as it works and the server rotates the refresh token when it does, so the live
   copy can be a generation ahead of the profile's own. Without this step a round trip would strand
   that account.
3. It is backed up and the backup is read back. A backup that cannot be verified stops the switch
   before anything is overwritten.
4. The new credential is written, then the identity. A failure at either step puts back what was
   there.

`zclaude switch --status` shows the account in the slot, which profile it belongs to, and the
backups it can restore (the last ten are kept). Two things it will refuse: a profile with no stored
login or a dead refresh token, and a Z.ai profile — a GLM plan is an endpoint plus a key, which
reach Claude Code through the environment rather than through its credential store, so the answer
there stays `zclaude <profile>`.

A Claude Code session that is already running keeps the credential it read at startup; on macOS that
cache lasts about half a minute, so a switch reaches a live session shortly rather than instantly.

## Keeping tokens alive

A profile you launch often looks after itself: Claude Code refreshes its token as it works. A profile
you have not opened for weeks does not. Its access token lapses in hours, and the refresh token
behind it carries an expiry about a month out, so a personal account you use twice a term can quietly
go dead between uses.

```sh
zclaude renew install      # schedule it
zclaude renew status       # is it scheduled, and what did it do last time
zclaude renew run          # do it now; this is what the scheduler calls
zclaude renew uninstall    # remove the schedule
```

The job runs every six hours and refreshes **only** what is inside two hours of expiring, so a
profile you use is left alone entirely. Where it lives depends on the system: a LaunchAgent at
`~/Library/LaunchAgents/com.zclaude.renew.plist` on macOS, a systemd user timer under
`~/.config/systemd/user/` on Linux, and a marked `crontab` line where systemd is not in charge. On
Windows it prints the `schtasks` command rather than running it.

Because it runs unattended it is deliberately timid. It works one profile at a time; the first
refresh token the server rejects ends the run and that profile is quarantined rather than retried on
a timer, until you sign it in again; it never touches the global login, which belongs to Claude Code
and to `zclaude switch`; and a Keychain that will not answer stops the run with a message instead of
being asked again every six hours. `zclaude renew status` shows the last run, anything quarantined,
and whether your account rotates refresh tokens — which decides whether renewing extends the lineage
or merely keeps the access token fresh.

Removing the last Anthropic profile removes the schedule with it, and every uninstall path
(`zclaude self-uninstall`, `install.sh --uninstall`) takes the plist, timer or crontab line away.
`--keep-config` keeps the profiles, so it keeps the schedule.

## Z.ai GLM Coding Plan

The `zai` profile signs in through Z.ai's own browser flow, mints a coding-plan key on your account,
stores it in the macOS Keychain (or a 0600 file elsewhere) and starts Claude Code on GLM models.

```sh
zclaude --profile zai            # or pick it from the menu
zclaude login                    # sign in now, then pick models and launch
zclaude login --api-key          # paste a key from the Z.ai console instead
zclaude login --no-browser       # print the URL instead of opening a browser
zclaude login --paste            # always paste the redirect URL back
zclaude models                   # what your plan can use
zclaude --reconfigure            # re-run the model wizard
zclaude logout                   # forget the stored key
```

On the first Z.ai launch:

1. Choosing Z.ai with no stored key opens `chat.z.ai` in your browser. Approve the request.
2. On macOS the redirect is captured automatically (the browser asks once whether to open "zclaude
   OAuth Callback"). On Linux and Windows, paste the `zcode://...` URL the browser lands on.
3. zclaude exchanges the code, mints a key named `zclaude` on your account, checks it against the
   models endpoint and stores it.
4. The model wizard asks for a primary model, a subagent model and a fast helper model, listing what
   your plan can actually use, and offers to save the answer per project or as your user default.
5. `claude` starts on GLM. Quit it and you are back to a clean shell.

**More than one Z.ai account** works the same way as Claude accounts: `zclaude profile add glm-work
--provider zai` gives that plan its own key, stored under its own Keychain account, with its own
quota reported at launch. `ZAI_API_KEY` in your shell applies to the built-in `zai` profile only; a
named profile always uses its own stored key, because an environment variable cannot say which
profile it belongs to.

### What gets set in the child process

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

A named profile also gets `CLAUDE_CONFIG_DIR`, set last so nothing in your config files can redirect
it. `ANTHROPIC_API_KEY` is removed from the Z.ai child environment to avoid Claude Code's
auth-conflict prompt. `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `ANTHROPIC_CONFIG_DIR` and
`ANTHROPIC_PROFILE` are removed from every child environment, because each of them would quietly
repoint a profile's credentials. Models with a 1M context (`glm-5.3`, `glm-5.3-flash`, `glm-5.2`) get
the `[1m]` suffix Claude Code expects.

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` inherited from your shell
override an account login. zclaude reports them and carries on, because you may have set them
deliberately. It never sets `CLAUDE_CODE_OAUTH_TOKEN` itself: Claude Code deletes the default
Keychain item when that variable is present
([claude-code#37512](https://github.com/anthropics/claude-code/issues/37512)).

## Sharing, and what profiles do not isolate

A new profile shares your settings and history by default, so it is usable straight away. Pick
something else with `--share config`, `--share history` or `--share none`, or in the wizard.

**Shared settings** symlink the directories Claude Code reads rather than owns (`agents`, `commands`,
`skills`, `rules`, `output-styles`, `workflows`, `themes`) plus `CLAUDE.md`, and pass a filtered copy
of your `settings.json` with `--settings`, which is a read-only tier. The copy is not a symlink
because Claude Code rewrites `settings.json` with a temp file and a rename, which would silently
replace a link. The filter drops authentication keys always, and for a Z.ai profile it also drops the
model keys and `model`, because a settings `env` block outranks the process environment and would
otherwise override the GLM models you selected.

**Shared history** symlinks `projects/` and `history.jsonl`, so `/resume` and prompt history span
profiles. That cuts both ways: `claude --continue` picks the most recent session in the directory
whoever wrote it, and project memory is loaded automatically, so a work transcript can be continued
from a personal profile. Use `--share config` if that is not what you want.

**Never shared:** credentials, `.claude.json`, installed plugins, caches, sessions and telemetry.

A new profile is seeded from a short allowlist of your `.claude.json`: onboarding state, theme,
install method and update preferences. Identity, entitlement caches, the projects map with its tool
permissions, and usage statistics are never copied. MCP servers and trusted folders are copied only
if you say yes.

Not isolated, and worth knowing:

- **Managed settings** from an MDM policy (`/Library/Application Support/ClaudeCode/`,
  `/etc/claude-code/`) are machine-wide. They apply to every profile, including a personal one, and
  no profile can opt out. `zclaude profile doctor` reports them.
- **`~/.claude/.device-keys.json`** is written by Claude Code in your home directory whatever the
  config directory says. zclaude writes no files under `~/.claude`, and a contract test plus an
  end-to-end hash check enforce that, but this one file is Claude Code's own and it will appear.
- **Your Z.ai API key** is an account-level object. Two profiles pointed at the same Z.ai account
  share that account's quota.
- **Anything you chose to share**, obviously. `zclaude profile list` always shows the choice.

## Command reference

```
zclaude                                    menu of every profile, then launch
zclaude <profile> [claude args...]         launch that profile, pass the rest to claude
zclaude <profile> --resume <session-id>    resume one of that profile's sessions
zclaude -p "explain this repo"             menu, then launch claude with those arguments
zclaude --profile <name>                   the same as naming the profile first
zclaude -- [claude args...]                everything after -- is claude's
zclaude -- --help                          claude's own help
zclaude profile add [name]                 create a profile (wizard)
zclaude profile list                       every profile, with its account and sharing
zclaude profile show <name>                everything about one profile
zclaude profile login <name>               sign in to that profile
zclaude profile logout <name>              sign out of that profile
zclaude profile shell <name>               a subshell pinned to that profile
zclaude profile env <name>                 print the exports, with a warning
zclaude profile remove <name>              delete it, its login and its directory
zclaude profile doctor                     check every profile and this shell
zclaude switch <profile>                   move the global claude login to that profile
zclaude switch --status [--json]           which account plain claude uses right now
zclaude switch --restore                   put the previous global login back
zclaude switch capture                     store the live login back into its profile
zclaude renew status [--json]              is the renewal job scheduled, and what did it do
zclaude renew install                      schedule the renewal
zclaude renew uninstall                    remove the schedule
zclaude renew run                          renew now; this is what the scheduler calls
zclaude login                              sign in to Z.ai now, then offer to launch
zclaude logout                             forget the stored Z.ai key
zclaude status                             what would happen on the next launch
zclaude models                             models your Z.ai plan can use
zclaude log                                the latest run log
zclaude self-install | self-update | self-uninstall
```

All zclaude options go before any argument meant for `claude`.

| Option                                  | Effect                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `--profile <name>`                      | the same as naming the profile first; useful in scripts and aliases      |
| `--provider <anthropic\|zai>`           | `profile add`: what the profile signs in to                              |
| `--share <all\|config\|history\|none>`  | `profile add`: what it borrows from your main setup                      |
| `--sso`, `--console`, `--email <addr>`  | passed to `claude auth login` for an Anthropic profile                   |
| `--yes`                                 | `profile remove`: do not ask                                             |
| `--fix`                                 | `profile doctor`: relink what it can                                     |
| `--force`                               | `self-update`: install even when the check says you are current          |
| `--switch <name>`                       | the same as `zclaude switch <name>`                                      |
| `--dry-run`                             | `switch`: say what would change, change nothing                          |
| `--status`                              | `switch`: report the account in the global slot                          |
| `--restore`                             | `switch`: put the previous global login back                             |
| `--usage`                               | `profile list`: fetch how much of each plan is used                      |
| `--no-usage`                            | menu: skip the usage lookup and its network calls                        |
| `--reconfigure`, `--customize`          | run the model wizard even when config exists                             |
| `--login`                               | sign in to Z.ai again before launching                                   |
| `--model <id>`                          | primary model for a Z.ai profile; forwarded to `claude` otherwise        |
| `--subagent-model <id>`                 | subagent model (`CLAUDE_CODE_SUBAGENT_MODEL`)                            |
| `--fast-model <id>`                     | haiku-class helper model                                                 |
| `--no-store`                            | keep the key in memory for this session only                             |
| `--no-browser`, `--paste`               | login: print the URL instead of opening a browser; always paste the code |
| `--api-key`                             | login: paste a key from the Z.ai console instead of the browser flow     |
| `--json`                                | `status`, `profile list`, `profile show`, `log`: machine-readable output |
| `--no-banner`                           | skip the splash                                                          |
| `--verbose`                             | show each step (use `zclaude -- --verbose` to pass it to `claude`)       |
| `--quiet`                               | terminal shows only warnings and errors                                  |
| `--log-level`, `--log-file`, `--no-log` | run-log controls, see "Run logs" below                                   |
| `--keep-config`                         | `self-uninstall`: keep `~/.zclaude`                                      |
| `--path`                                | `zclaude log`: print only the log file path                              |
| `--help`, `--version`                   | zclaude help and versions (`zclaude -- --help` for claude's own)         |

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

A `ZCLAUDE_PROFILE` naming a profile you do not have falls back to the menu with a warning, since the
project file is committed and your teammates have their own profiles.

The model wizard runs when there is no user settings file (and the project file does not already pin
all three models), or whenever you pass `--reconfigure`.

Profiles themselves live in `~/.zclaude/profiles.json`, with each profile's directory recorded at
creation so that changing `ZCLAUDE_HOME` later cannot move it and orphan its credentials.

### Environment-only profiles

Beyond named profiles, a `~/.zclaude/profiles/<name>.env` file adds a menu entry whose `KEY=value`
lines are applied to the child environment. These have no directory and no login of their own. Add
`ZCLAUDE_ZAI=1` to route one through the Z.ai credential and model steps.

```sh
# name: Work MCP servers
# description: Z.ai plus the team MCP token
ZCLAUDE_ZAI=1
MY_TEAM_MCP_TOKEN=...
```

### Environment variables

| Variable                                                                                                                                             | Effect                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ZAI_API_KEY`                                                                                                                                        | use this key for the built-in Z.ai profile, never store it                                                        |
| `ZCLAUDE_PROFILE`                                                                                                                                    | default profile, skips the menu                                                                                   |
| `CLAUDE_CONFIG_DIR`                                                                                                                                  | never set by zclaude for the default profile; an inherited value is reported, because it hides your default login |
| `ZCLAUDE_HOME`                                                                                                                                       | config directory (default `~/.zclaude`)                                                                           |
| `ZCLAUDE_CLAUDE_BIN`                                                                                                                                 | path to `claude`                                                                                                  |
| `ZCLAUDE_NO_STORE=1`                                                                                                                                 | never persist the key                                                                                             |
| `ZCLAUDE_NO_KEYCHAIN=1`                                                                                                                              | use the file store even on macOS                                                                                  |
| `ZCLAUDE_NO_NATIVE_CALLBACK=1`                                                                                                                       | always paste the redirect URL                                                                                     |
| `ZCLAUDE_NO_BANNER=1`                                                                                                                                | skip the splash                                                                                                   |
| `ZCLAUDE_NO_USAGE=1`                                                                                                                                 | never look up plan usage for the menu                                                                             |
| `ZCLAUDE_ALLOW_SETTINGS_OVERRIDE=1`                                                                                                                  | launch even when a settings `env` block overrides this session                                                    |
| `ZCLAUDE_NO_UPDATE_CHECK=1`                                                                                                                          | skip the daily check for a newer version                                                                          |
| `ZCLAUDE_INSTALL_KIND`                                                                                                                               | force how `self-update` and `self-uninstall` work: `installer`, `npm` or `checkout`                               |
| `ZCLAUDE_LOGIN_TIMEOUT`                                                                                                                              | seconds to wait for the browser (default 300)                                                                     |
| `ZCLAUDE_KEY_NAME`                                                                                                                                   | name of the key minted on your Z.ai account (default `zclaude`)                                                   |
| `ZCLAUDE_BASE_URL`                                                                                                                                   | API base (default `https://api.z.ai`)                                                                             |
| `ZAI_OAUTH_CLIENT_ID`, `ZAI_OAUTH_AUTHORIZE_URL`, `ZAI_OAUTH_TOKEN_URL`, `ZAI_OAUTH_REDIRECT_URI`, `ZAI_BIZ_LOGIN_URL`, `ZCLAUDE_ANTHROPIC_BASE_URL` | endpoint overrides if Z.ai changes its allowlist or paths                                                         |

## Settings that would override a session

Claude Code applies the `env` block of its settings files **over** the process environment (measured
with claude 2.1.273), and it reads four tiers: your user settings, `./.claude/settings.json`,
`./.claude/settings.local.json`, and machine-wide managed policy. If any of them sets a variable
zclaude is about to set to a different value, the session would silently run with the file's value.
zclaude stops and asks whether to quit and edit the file or launch anyway. It never edits the file.
Non-interactive runs exit with code 2; `ZCLAUDE_ALLOW_SETTINGS_OVERRIDE=1` launches anyway. Identical
values and the `opus`, `sonnet` and `haiku` aliases are not conflicts.

## Run logs (post-mortem)

Every invocation writes a structured JSON-lines log to
`~/.zclaude/logs/zclaude-<date>-<time>-<pid>.log` (the 30 newest are kept). It records the run header
(version, Node, arguments, which relevant variables were set), every settings file read, the profile
and models chosen, the credential source and its validation result, each HTTP call with status and
timing, the browser callback mode, the exact `claude` spawn with its environment variable names, and
claude's exit code. Secrets are redacted before anything is written; a key only ever appears as
`****xxxx`.

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

When a run fails, the error line on the terminal is followed by the path of that run's log.

## Troubleshooting

| Symptom                                               | What is going on                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A profile says "signed out" right after you signed in | The sign-in ran with a different config directory. `zclaude profile show <name>` prints the directory and the credential item; run `zclaude profile login <name>` again. |
| Plain `claude` in a new terminal is signed out        | Your shell exports `CLAUDE_CONFIG_DIR`, probably from `profile env`. `zclaude status` reports it. Unset it, and prefer `zclaude profile shell`.                          |
| The VS Code extension changed accounts                | Something launched the editor from a pinned shell. Start the editor from a clean terminal; the extension uses the default login.                                         |
| "unknown (keychain locked?)" in `profile list`        | The Keychain could not be queried, which happens over SSH and on a locked screen. It is not a claim that you are signed out.                                             |
| A profile keeps asking to trust a folder              | Trust is per config directory. Answer once per profile, or copy your trusted folders when creating it.                                                                   |
| Shared agents or commands stopped updating            | A write turned the symlink into a real file. `zclaude profile doctor` names it; move the local copy aside and run `zclaude profile doctor --fix`.                        |
| A Z.ai profile ignores your models                    | A settings `env` block is overriding them. zclaude refuses to launch quietly in that case and names the file and the keys.                                               |
| `zclaude` exits 2 complaining about a settings file   | Same cause. Edit that `env` block, or set `ZCLAUDE_ALLOW_SETTINGS_OVERRIDE=1`.                                                                                           |
| An enterprise policy blocks a personal profile        | Managed settings are machine-wide and no profile escapes them. `zclaude profile doctor` reports which file applies.                                                      |

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

Non-interactive use (CI, scripts) never prompts: pass `--profile`, provide `ZAI_API_KEY` or a key
stored by an earlier interactive `zclaude login`, and models come from config or defaults.
`zclaude profile add` needs `--provider` and a name when there is no terminal, and
`zclaude profile remove` needs `--yes`.

## Security and privacy

- Everything zclaude tells Claude Code travels in the environment of the one `claude` process it
  spawns, plus the profile's own directory. It never edits `~/.claude/settings.json` or your
  project's `.claude/` files, and it writes nothing under `~/.claude`. It reads them, to seed a
  profile you asked for and to detect an `env` block that would override the session.
- **`switch` is the exception, and it is the whole exception.** When you name a profile to switch to,
  zclaude replaces the credential in Claude Code's Keychain item and the `oauthAccount` block of
  `~/.claude.json` — those two things and nothing else. Both are backed up and verified first, and
  `zclaude switch --restore` puts them back. A contract test names the single source file allowed to
  write there, and `test/swap.test.js` proves a switch changes no other key of that file and no file
  under `~/.claude`. While it works it also creates and removes Claude Code's own lock directories
  (`~/.claude/.oauth_refresh.lock`, `~/.claude.lock`, `~/.claude.json.lock`), because taking those
  locks is the protocol that stops a swap landing inside a token refresh.
- Z.ai keys: macOS Keychain, service `zclaude`, one item per profile, written over stdin to the
  `security` tool so the secret never appears in a process listing. Elsewhere a 0600 file under the
  profile's directory.
- Anthropic logins are stored by Claude Code itself, keyed by the config directory. zclaude reads one
  only to move it where you asked, or to ask a plan how much quota is left; `profile list` only asks
  whether an item exists. Every write is read back before it is called done.
- The `zclaude` key on your Z.ai account is durable. `zclaude logout` and `zclaude profile logout`
  remove the local copy; revoke the key itself at https://z.ai/manage-apikey/apikey-list.
- Uninstalling signs every profile out: each profile's Claude Code credential item sits outside
  `~/.zclaude`, so it is removed by name. `--keep-config` keeps the profiles, and therefore their
  logins.
- The key travels only to `api.z.ai`, `zcode.z.ai` and `chat.z.ai`. No telemetry.
- Secrets are masked in every log line and error message.

## How the Z.ai sign-in works

Z.ai does not document a CLI login. Its ZCode desktop app uses a standard OAuth authorization-code
flow against `chat.z.ai` with a public client id, and the same flow is used by zcode-cli, oh-my-pi and
CLIProxyAPI. zclaude does the same:

1. `GET https://chat.z.ai/api/oauth/authorize` with `redirect_uri=zcode://zai-auth/callback` and a
   random state.
2. Z.ai only allows that custom scheme as redirect target. On macOS, zclaude compiles a tiny
   background AppleScript app, registers it as the temporary `zcode://` handler, and restores the
   previous handler when done (a recovery journal cleans up if the process dies). Elsewhere you paste
   the URL.
3. `POST https://zcode.z.ai/api/v1/oauth/token` exchanges the code for a short-lived token.
4. Z.ai's business API turns that into a durable coding-plan key: login, default org and project,
   find-or-create a key named `zclaude`, copy its secret.
5. The key is checked against `GET https://api.z.ai/api/coding/paas/v4/models`, which also yields the
   model list for the wizard.

## Development

```sh
npm test               # node:test unit, contract and end-to-end suites
npm run lint           # eslint (recommended + unicorn + n + promise + security + sonarjs), prettier, knip, tsc --checkJs, shellcheck
npm run test:coverage  # same tests with coverage thresholds (80% lines, 75% branches and functions)
npm run check          # everything CI runs, plus npm pack --dry-run
```

The lint toolchain needs Node 22 or newer (the runtime itself works on 20.17+). `npm install` points
git at `.githooks`, so the pre-commit hook runs `npm run lint` and the coverage-gated tests before
every commit (`ZCLAUDE_SKIP_HOOKS=1` bypasses it).

Guardrails worth knowing about before changing anything: `test/contract.test.js` pins the Z.ai
endpoints, the child environment, the exit codes, the credential-key derivation and the documentation
of every flag, subcommand and variable, and it names the one source file allowed to write a Claude
Code path (`src/swap/identity.js`) — every other file that tried would fail the build;
`test/swap.test.js` earns that permission by proving a switch changes one key of the config file and
nothing else; `test/profile-launch.test.js` hashes `~/.claude` before and after creating and deleting
a profile; `test/e2e.test.js` runs the real binary against a fake Z.ai server and a fake `claude`;
`test/interactive.test.js` drives the menu inside a real pseudo-terminal on macOS.

Publishing to npm: `npm publish --access public` from a clean checkout.

## License

MIT
