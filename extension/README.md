# zclaude for VS Code

A `zc` item in the status bar showing which Claude Code account is signed in, and one click to
change it.

## What it does

Clicking the status bar item opens a list of every profile `zclaude` knows about, with the account
each one holds and how much of its plan is left: the rolling 5-hour window, the week, and the
separately metered weekly window for each model. Picking one moves the global Claude Code login to
that profile, which is what the Claude Code extension, the `claude` command and anything else that
shells out to Claude Code will use from then on.

The list also carries:

- **Refresh usage** — fetches past the cache. This is the retry when the usage API errored, and what
  you want if the list has been open a while.
- **Add a profile…** — opens a terminal running `zclaude profile add`, because signing in needs a
  browser and a terminal.
- **Remove a profile…** — deletes a profile, its login and its directory, behind a confirmation.
- **Restore the previous login** — undoes the last switch.

## What it needs

[zclaude](https://github.com/vipincr/zclaude) on the machine:

```sh
npm install -g zclaude
# or
curl -fsSL https://raw.githubusercontent.com/vipincr/zclaude/main/install.sh | bash
```

The extension shells out to it and renders its `--json` output. It holds no credential logic of its
own: every Keychain read, every backup and every write to `~/.claude.json` happens in zclaude, which
is also where the tests for that live.

If VS Code was started from the dock on macOS its `PATH` is not your shell's, so the extension also
looks in `~/.local/bin`, `~/bin`, `~/.zclaude/app`, the npm global bin and Homebrew. When it still
cannot find zclaude, set `zclaude.path`.

## Settings

| Setting             | Default | What it does                                                                               |
| ------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `zclaude.path`      | `""`    | Where the `zclaude` command is. Empty means search `PATH` and the usual install locations. |
| `zclaude.showUsage` | `true`  | Fetch each account's usage for the list. Off makes the list instant and offline.           |

## Notes

- A Claude Code session that is already running keeps its credential for up to about 30 seconds on
  macOS, so a switch shows up in the next request rather than the current one.
- Z.ai profiles cannot be switched globally: their login is an endpoint plus a key, which only reaches
  Claude Code through the environment. Run `zclaude <name>` in a terminal for those.
- Installing or updating the extension needs a window reload; VS Code offers it.

## Licence

MIT. Part of [zclaude](https://github.com/vipincr/zclaude).
