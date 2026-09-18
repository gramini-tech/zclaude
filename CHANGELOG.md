# Changelog

## Unreleased

**Auto is a row in the hover's table**, alongside the accounts, saying which one
it would use and why, with a `use` link. It was only in the click list before,
which is the less-visited of the two surfaces and the reason it still looked
absent: the hover is where the accounts are, so that is where a profile you can
pick belongs.

The row asks a different question from the watcher status line below it.
`auto status` says whether to move the session that is running; `auto pick` says
where a new one would begin. The row is about starting, so it shows the second.
When the answer is the account already in use it says so and offers no link, and
a link that changes nothing is worse than no link.


**Auto is a profile you pick**, not a mode you switch on. It is the first row in
the launch menu and an entry in the editor's list, and choosing it is the same
kind of choice as choosing a profile: "whichever account has the most room"
instead of naming one.

The previous shape was a footer toggle in the terminal and nothing at all in the
editor, which is why auto appeared not to work there. That was the wrong read of
what it is. It resolves at launch, says which account it picked and why, and
turns rotation on for that session — picking Auto is saying you do not want to
think about which account this runs on, including later when the one it picked
fills up.

- `zclaude auto pick` prints the answer without launching anything. Both the
  menu and the editor's list go through it, so they cannot disagree.
- Least-used is measured in work rather than percentage: 3% of a Max 20x seat is
  nine times the room left in 55% of a 5x seat.
- It never refuses. With nothing free it still names the account that comes back
  first, and if no account can be read at all it falls back to the global login
  rather than standing between you and Claude Code.


**`a` in the launch menu toggles auto**, and Enter launches the highlighted
profile in that mode. A toggle rather than a row of its own, because auto is a
mode: a row labelled "Auto" meaning "any of the above" is the kind of thing
nobody can explain afterwards.


- **`zclaude auto edit`** opens the inventory in `$VISUAL` or `$EDITOR`, creating
  it first so you never get an empty buffer with no schema in it, and re-reading
  it afterwards so an edit that does not parse is said out loud rather than
  discovered later by a watcher quietly falling back to its defaults. The editor
  value is tokenized rather than handed to a shell: it comes from the
  environment and can contain a semicolon.
- **The status bar marks a rotation while one is happening** and at no other
  time. A watcher that is only watching gets no extra glyph — a permanent one is
  noise, and one that spins for ever is the most irritating thing an extension
  can do.
- **What this is, said plainly**, in the README. Holding several accounts is not
  a ToS violation; zclaude's own process does call the usage endpoint with your
  token, auto mode multiplies how often; and rotating to keep working past a cap
  sits closer to "limit evasion" than switching by hand. That is a judgement you
  are making, which is why nothing rotates without a session that asked for it.


A real rotation, watched end to end: `gramini → max`, waiting ninety seconds for
a quiet moment first, then settling on the new account instead of hopping back.
The slot was put back afterwards with `zclaude switch`.

**The inventory's `ladder` was read, validated, clamped and then ignored.** The
policy used its own constant, so editing the file did nothing — in `auto status`
and, separately, in the watcher, which never loaded the inventory at all and so
disagreed with `auto status` about the same accounts. Both now take the ladder
from the file, and the watcher re-reads it every cycle so an edit applies without
a restart.


`zclaude --auto <profile>` launches a session that has asked to be rotated, and
`zclaude auto run --dry-run` proves the policy on real accounts without moving
anything.

- **The session's lease is the session's process.** It lives exactly as long as
  Claude Code does, so nothing has to remember to clean up: when the session
  ends the pid goes and the lease with it. Auto mode never blocks a launch
  either — a watcher that cannot start is a reason to say so and carry on.
- **`--auto` is a flag, not a subcommand.** After a command group the parser
  rejects any unknown `-` argument, so `zclaude auto --resume <id>` would die on
  the flag somebody starting a long session is most likely to type.
- **The dry run does everything up to the write, and then nothing.** It spends
  no quota and moves no login, and its decisions are recorded as neither a
  success nor a failure, because they did not happen.

Run against real accounts, the watcher repaired a login on its first cycle.
`gramini` had been reading `login expired` for two days: Claude Code had rotated
the token in the slot and the profile's own copy was a generation behind. One
`captureBack` took the live credential back, and the account went from `dead` to
5h 27% / week 50% / Fable 73%. That is the rot the plan put a capture in *every*
cycle for, rather than trusting a six-hourly job that was never installed.


The editor holds a lease, so the watcher stays up while a window is open, and
the hover says what it is doing. A window can only ever ask it to **watch**: an
open editor is not consent to move the global login.

- **One predicate decides what can hold the global login**, shared by the
  hover's action column, the click list and the scheduler. They used to
  disagree: the list offered `switch` on a Z.ai row and three layers below it
  refused. Safe, and still wrong — a list should not offer what it knows will be
  turned down. Such a row now says why before you pick it, and picking it
  explains rather than tries.
- `zclaude auto attach [kind] [id] --pid <n>` holds or renews a lease, and
  `auto detach <id>` gives one up. The pid matters: the lease belongs to the
  process that wants the watcher, not to the short-lived `zclaude` that records
  it, which would otherwise be reaped on the next read.

One guardrail failure found by running it: **an editor attaching started a
watcher that granted rotation.** The daemon always took a `manual` self-lease,
whoever started it, so an open window silently became permission to move the
login — the exact thing the two lease kinds exist to prevent. The self-lease is
now only taken when somebody asked for a watcher by name.


The watcher runs. `zclaude auto run` starts it in the background, `auto off`
stops it, and `auto status` says what it is doing. It still only rotates when
something holds a lease that grants it: an editor window watching is not consent
to move the global login.

```sh
zclaude auto run     # start it; it exits when nothing holds a lease
zclaude auto status  # what it is doing, and what it would do next
zclaude auto off     # stop it, leaving the login where it is
```

- **The cycle is separate from the process that runs it.** Every call that
  touches the world is injected, so the decisions are tested without a timer, a
  signal or a Keychain anywhere near them.
- **Detaching is a safety requirement.** Every output path here writes to
  stderr, which for a launcher is Claude Code's own terminal, so a rotation
  warning would scribble over a full-screen TUI. And a `^C` reaches the whole
  process group: that signal landing between writing a credential and splicing
  an identity would leave the slot holding one account's token under another's
  name, because a signal is not an exception and nothing rolls back.
- **A switch is verified after the fact.** `switchTo` rolls back a failed write
  and swallows a failed rollback, so the slot is re-read afterwards; a mismatch
  stops the watcher and points at `switch --restore` rather than attempting an
  unattended repair on a state nobody understands.

Three bugs a first live run found, none of which the tests could have:

- **`decide` was the one dependency the cycle never awaited.** The live wiring
  imports the policy lazily, so it returns a promise; unawaited, `.action` is
  undefined, every branch falls through, and the watcher reports that it is
  rotating while deciding nothing for ever.
- **The lease died with the launcher.** `auto run` took a lease for the shell
  that started the watcher, and that shell exits immediately, so the watcher
  found nothing wanting it and began counting down. It holds its own now.
- **A leaked file descriptor.** The log handle passed to the detached child was
  never closed, and Node treats a garbage-collected `FileHandle` as an error.


`zclaude auto status` shows which account rotation would use, and why. It reads
only: the decision is built and tested, the daemon that would act on it is not,
and the first line of the output says so.

```
rotating    no — not built yet. This is what it would do.
holding     gramini
leave at    95%

  profile   plan                     tightest       capacity
  gramini   default_claude_max_5x    dead
  hoomanely default_claude_max_5x     55% weekly    2.00 left
  max       default_claude_max_20x     3% weekly    18.40 left

would       switch to max — gramini cannot be used: its login expired
```

- **Capacity, not percentage.** The plan size comes off the credential, so 3% of
  a Max 20x seat reads as nine times the work left in 55% of a 5x seat. An
  unrecognised plan weighs 1, the smallest there is.
- **`--class fable`** asks the same question for a different model class. An
  account with Fable spent and Opus untouched reports no room for one and plenty
  for the other.
- **`zclaude auto config`** reads the inventory at `~/.zclaude/auto.json`, and
  `auto config init` writes the defaults out with a `_readme` explaining each
  key. Unknown keys are named rather than swallowed, clamped values say which
  key changed, and a malformed file is one warning plus the built-in defaults.

Two bugs that only showed up once it ran against real accounts:

- **A dead login was reported as 0% and the answer was "stay".** Nothing checked
  whether the account currently holding the slot could serve at all, so the
  worst possible account looked like the emptiest. It is now left immediately,
  with no wait for a quiet moment, since the session on it is about to fail.
- **Two profiles sharing an account uuid were called the same account.** A
  company seat and a personal subscription on one login share that uuid and
  differ only by organisation, and they are metered entirely apart. The check
  now keys on both, matching what `sameAccount` has always compared.


Moved to the Gramini Labs organisation: `gramini-tech/zclaude`, published at
`gramini-tech.github.io/zclaude`, with the VS Code extension now
`gramini-labs.zclaude`.

**The install URL has changed.** GitHub redirects the git URLs after a transfer
but not the Pages ones, so `https://vipincr.github.io/zclaude/install` stops
answering and an already-installed copy cannot `self-update` its way across —
the old URL is baked into it. Run the new one once on each machine:

```sh
curl -fsSL https://gramini-tech.github.io/zclaude/install | bash
```

`github.com/vipincr/zclaude` and `npx github:vipincr/zclaude` keep working
through GitHub's own redirect.

**The extension id has changed**, so an installed `vipincr.zclaude` is not
replaced by the new one and would sit beside it as a second status bar item.
Remove it first if you have it: `code --uninstall-extension vipincr.zclaude`,
then `zclaude vscode install`.


An expired login is now something you can act on where you find it, rather than
a row that reports a problem and stops.

- **`s` in the launch menu signs the highlighted profile in**, then carries on
  into it. The key appears only on a row that needs it, and the detail line
  under the cursor names the command either way.
- **The editor hover shows `sign in` in place of `switch`** on a row whose
  login has expired, and it opens a terminal with the command typed. Switching
  is deliberately not offered: it would put a login in the global slot that
  cannot answer.
- `profile list --usage` prints the fix under the state.
- The two built-in rows are treated as what they are. `zai` goes through
  `zclaude login`; the plain `Claude Code` row is the default installation's own
  login, which Claude Code asks for itself, so nothing is offered for it.

Underneath, work towards rotating accounts by usage, all of it invisible so far:

- **`captureBack` takes the locks it always needed.** The renewal job called it
  unlocked, so a switch landing between its identity read and its credential
  read could file one account's token under another profile. It now also
  re-reads the identity and refuses if the slot changed hands.
- **The usage cache is written once per lookup round, under a lock.** It was one
  unsynchronised read-modify-write per profile, so the slowest to finish
  reverted the others — including a `Retry-After` another had just recorded.
- **A 429 now holds back the account that earned it**, not the whole machine.
  The machine-wide backoff is kept for a limit that catches two accounts at
  once, which is the case that says it is not per-account.
- **Backups can be pinned and are never pruned.** The ring keeps ten, so
  anything switching on a timer would push the login you started with out of
  reach of `switch --restore`.
- `rateLimitTier` is read off the credential and the plan tier off the identity,
  which is the only machine-readable statement of how large a plan is:
  `subscriptionType` says `team` for a 5x seat and a 20x seat alike.

## 0.2.37

The popup is a hover, because that is the only anchored surface an extension
has. Established rather than assumed: VS Code renders Copilot's version of this
panel with an internal `DomWidget` that extensions cannot reach, and there is no
API to open a hover on command.

- **The status bar hover is the panel now.** A table with a coloured bar per
  window, the percentage, when it comes back, the sessions on each account, and
  `switch` as a link on every row that can take one — plus Refresh, Add, Remove
  and Restore. The bars are two coloured `span`s filled with figure spaces,
  which is what VS Code's hover sanitiser allows; `var(--vscode-…)` colours are
  stripped by it, so the chart colours are written out.
- **Clicking opens a plain list of accounts.** Names and who they are, nothing
  else. That is the one thing a QuickPick is good at, and everything that could
  not render in it has moved to the hover.
- The editor tab is gone. A webview panel could draw the UI but not sit where
  it belonged.
- Fixed: a window 59 minutes from resetting said "60m".
- Every cell in the hover's table is two lines, and exactly two. A hover cell
  cannot be told how to align vertically — no `valign`, and `style` reaches a
  `span` but never a `td` — so cells of different heights settled at different
  baselines and the rows looked broken. The clock sits on the second line in
  `<small>`, with hard spaces so it cannot break in the middle, and the
  organisation fills the second line under each name, which is what tells two
  profiles on one address apart. Bars are five cells.

Extension 0.6.0.

## 0.2.35

Clicking the status bar item opens a panel now, and the terminal menu draws the
same table.

- **A webview panel replaces the QuickPick.** Clicking `zc` used to drop a list
  from the top of the window that could not show what it was there to show: it
  renders in the proportional UI font, gives each row one clipped line and takes
  no styling, so a gauge drawn in it said nothing about its value. The panel has
  a real bar per window, coloured by how close it is to stopping you, the reset
  time beside each one, the sessions on each account, and a Switch button per
  row. Refresh, Add, Remove and Restore are along the bottom.
- **The 5-hour and the week each carry their own reset.** They run out on
  different clocks, so one shared "resets" column could only ever answer half
  the question. A per-model window resets with the week it belongs to, so it
  does not repeat that time.
- **The terminal menu draws the table too.** A terminal is monospace, so the
  columns are simply columns. It gives up columns rather than wrapping when the
  window is narrow, because a wrapped row would put the cursor on the wrong
  line: the session count first, then the per-model windows, then the clocks,
  then the gauges themselves. Below about 45 columns there is no room to draw,
  and the numbers alone are still the answer. A long
  name is cut in the table and spelled out on the detail line under the cursor.
- The hover on the status bar item keeps the same table in a fenced block, for
  a look without a click.

Extension 0.5.0.

## 0.2.33

The VS Code list was, as reported, "a bit haphazardly organized" — and the first
attempt at fixing it was worse, so this is the second.

- **The gauges live in the status bar hover, and they are real gauges.** A
  fenced block renders monospace, so a run of blocks is a bar, a space is a
  space and columns are columns: a row per account, a column per window with its
  percentage, the reset of whichever window is closest to stopping you, and how
  many sessions are on it. Switch and Refresh are links in the same panel.

  ```
     profile    5-hour           week             Fable            resets  sessions
     chinese    ██░░░░░░░░  16%  ███████░░░  71%         –         5d 14h
   › gramini    █████░░░░░  50%  ███░░░░░░░  31%  █████░░░░░  50%  1h 36m  3 open
     hoomanely  ░░░░░░░░░░   0%  ██████░░░░  55%  ██████████ 100%  5d 5h
  ```

- **The list keeps the numbers alone.** It is drawn in the editor's UI font,
  which is proportional and has no styling hook, so nothing there can be lined
  up or drawn: an attempt with heavy and light rules rendered as one unbroken
  line whatever the value, and a reset clock after each window pushed rows off
  the end where they were clipped.
- The terminal menu, which *is* monospace, pads its percentages into real
  columns and puts one reset clock at the end of the row rather than one after
  each window, where it shifted every later column on every row.
- Credit that nobody has stopped being repeated on every row. `credits spent` on
  four rows of an account that never enabled it says nothing and costs the width
  the numbers need; `profile list --usage` still spells it out.

Extension 0.4.0.

## 0.2.28

Two fixes for a status bar item that was installed, active, and useless.

- **The extension could not run zclaude at all when VS Code was started from
  the dock.** zclaude is a Node script beginning `#!/usr/bin/env node`, and a
  GUI-launched editor on macOS has `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which
  has no node on any machine using Homebrew, nvm, volta or fnm. Every call came
  back "env: node: No such file or directory". The extension now runs zclaude
  with the binary's own directory on PATH — npm installs a tool beside the node
  that installed it — plus the usual places a node ends up.
- **The item appeared only after two subprocess calls had succeeded**, and was
  never shown at all if either failed, with the error swallowed. It is now on
  screen synchronously when the extension activates, and stays there saying
  something is wrong rather than vanishing, with the reason in the zclaude
  output channel.

- The status bar item leads with `zc` instead of a generic person icon. It read
  as `$(account) vipinr`, which in a row of other extensions' icons looks like
  somebody's username and says nothing about what put it there.

- **"Switching Claude Code to …" stayed on screen after the switch had
  finished.** The success notification was awaited inside the progress scope,
  and `showInformationMessage` resolves when the notification is *dismissed*,
  not when it appears — so the progress sat there until you clicked the message
  away. Messages now come after the progress closes, and nothing that waits on a
  person happens inside it. The switch itself takes about a fifth of a second,
  so it reports progress in the status bar rather than in a popup.

Extension 0.3.3.

- **A profile whose account also holds the global login went stale on its own.**
  Claude Code refreshes the token in the slot as it works and the server rotates
  the refresh token into the global Keychain item; the profile's own copy is
  then a generation behind and the server rejects it, which reads as "login
  expired" and is nothing of the sort. Found on a live machine, where `gramini`
  held a superseded token while the slot's was good for another eight hours. The
  renewal job now takes the live credential back into the profile that owns the
  account before it judges anything, `profile doctor` reports when that is
  needed, and the capture only ever moves forwards so a profile holding the
  newer token keeps it.

## 0.2.26

Knowing which accounts are already in use.

- `zclaude sessions` lists what is running, on which account, and whether it is
  working or idle. The menu marks a busy profile before you pick it, and
  launching one that is already in use says so and carries on — information
  rather than a gate, since two sessions on one account is a reasonable thing to
  do as long as it is a decision.
- Each launch writes one file under `~/.zclaude/sessions/`, not a shared list:
  two terminals starting at once cannot race for it, and a crash leaves one
  orphan rather than a corrupt file. A session counts as live only when its
  process id exists *and* that process still started when the record says it
  did, because a recycled id would otherwise leave an account looking busy for
  ever. Dead records are cleared away by whatever reads the list next.
- Busy and merely open are different questions. Claude Code appends to its
  transcript as a conversation goes, so the newest transcript under that
  session's own project directory is when the account last did work; five
  minutes of quiet reads as idle.
- Sessions zclaude did not start are counted too. They cannot have a config
  directory of their own, so they are all on the global login and are attributed
  to whichever profile holds it.
- Limits, stated rather than discovered: this is one machine, and tracking never
  gates a launch — a session that cannot be recorded still runs. Turn the whole
  thing off with `ZCLAUDE_NO_SESSIONS=1`.
- The installer copies a local checkout through an archive file instead of
  `tar | tar`. A read that stumbled killed the writer with EPIPE and reported
  only "tar: Write error", which named neither end; it now retries once and, if
  it still fails, says what tar actually said. Twice on CI runners was enough.

## 0.2.25

Usage now says when, not just how much.

- Every window carries its reset time: the rolling 5 hours, the week, and each
  separately metered model week. Shown as a countdown and as a wall-clock time
  in your own zone, converted from the UTC the endpoint answers in. A clock
  appears on a row only when that window is at half its limit or more, because
  one on every window buries the numbers it sits beside.
- Pay-as-you-go credit, which the API calls extra usage, is read and shown:
  what is left when it is switched on, `credits spent` when the account has run
  out, `credit limit reached` when a spend limit stopped it. An account that
  never turned it on says nothing, since that is a choice rather than news.
- `zclaude profile list --usage` spells each window out on its own line with
  the exact local reset time; the menu does the same under the highlighted row,
  and the VS Code hover in its tooltip. The name column in the menu is now
  sized from the numbers actually being shown rather than a fixed reserve, so a
  quiet day gives names their full width.
- No timeago dependency: `Intl.DateTimeFormat` handles the zone and the locale,
  and the countdown is a dozen lines. The VS Code extension ships no
  dependencies at all and would have had to bundle one.
- A reset time already in the past is left off rather than counted down to, and
  a null amount from the endpoint stays null instead of becoming a confident
  zero balance.

## 0.2.23

- **Fixed: the built-in Z.ai entry could adopt a profile's key.** With no key of
  its own it fell back to a lookup that searched the Keychain by service alone,
  and `security` answers that with whichever item carries the service — since
  profiles, somebody else's. The menu then showed one plan's usage twice, under
  the built-in row and under the profile that actually owns the key. The legacy
  lookup now searches only the two account names a pre-profiles key could sit
  under, and `profile doctor` reports a copy an earlier version already made,
  along with the `zclaude logout` that removes it.
- The menu's built-in `Claude Code` row names the account the global login
  currently holds, so a profile for that same account no longer reads as a
  duplicate of it.
- The usage cache no longer outlives the login it belongs to. Old numbers are
  worth keeping when a lookup merely fails, and not when it comes back with a
  definite "signed out" or "login expired" — a cache that kept them would have
  gone on reporting the borrowed plan above long after its key was removed.
  Backoff also stops relabelling a row that has a reason rather than numbers,
  which used to render as a blank line.

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
- Website at https://gramini-tech.github.io/zclaude/ with install tabs, a first-run walkthrough, usage and
  FAQ. Higher-resolution wordmark (half-block pixels, gradient, shadow) shared by the terminal banner,
  the site logo and the favicon.
- `install.sh` for bare machines (downloads Node if needed, installs Claude Code), `self-install`
  and `self-update` commands, daily update notice, patch version bumped on every commit.
- Structured per-run log under `~/.zclaude/logs` with level and category filters, `zclaude log`
  to read it back, secrets redacted.
- Quality gate: strict ESLint, Prettier, knip, TypeScript checkJs, shellcheck, coverage thresholds,
  pre-commit hook, contract and end-to-end test suites.
