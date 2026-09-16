#!/usr/bin/env bash
# zclaude installer for a fresh machine (macOS or Linux, x64 or arm64).
#
#   curl -fsSL https://vipincr.github.io/zclaude/install | bash
#
# What it does, in order:
#   1. Uses the Node.js already on the machine when it is 20.17 or newer. Only
#      when Node is missing or too old does it download an official build into
#      ~/.zclaude/node (verified against nodejs.org's SHASUMS256). A system Node
#      is never replaced or upgraded.
#   2. Downloads zclaude into ~/.zclaude/app and installs its runtime
#      dependency (@inquirer/prompts). Re-running the installer updates it.
#   3. Links ~/.local/bin/zclaude and adds ~/.local/bin to your shell PATH.
#   4. Installs Claude Code with Anthropic's installer if `claude` is missing.
#
# Knobs (environment variables):
#   ZCLAUDE_INSTALL_REF        git ref to install (default: main)
#   ZCLAUDE_INSTALL_SOURCE     local checkout dir or .tgz instead of GitHub (offline installs)
#   ZCLAUDE_INSTALL_DIR        where zclaude lives (default: ~/.zclaude/app)
#   ZCLAUDE_BIN_DIR            where the zclaude command is linked (default: the first
#                              writable directory already on PATH, else ~/.local/bin)
#   ZCLAUDE_NODE_VERSION       Node major to download when needed (default: 22)
#   ZCLAUDE_INSTALL_FORCE_NODE set to 1 to download a private Node even if one is installed
#   ZCLAUDE_INSTALL_NO_CLAUDE  set to 1 to skip installing Claude Code
#   ZCLAUDE_INSTALL_NO_RC      set to 1 to leave shell rc files alone
#   ZCLAUDE_NO_KEYCHAIN        set to 1 to leave the macOS Keychain item alone
#
#   install.sh --uninstall     removes everything: the app, the private Node, the
#                              command, ~/.zclaude (settings, logs and profiles),
#                              the Keychain items (the Z.ai keys and each
#                              profile's Claude Code login) and the PATH line
#                              this script added.
#                              Add --keep-config to keep ~/.zclaude.
set -euo pipefail

REPO="vipincr/zclaude"
REF="${ZCLAUDE_INSTALL_REF:-main}"
ZCLAUDE_HOME="${ZCLAUDE_HOME:-$HOME/.zclaude}"
APP_DIR="${ZCLAUDE_INSTALL_DIR:-$ZCLAUDE_HOME/app}"
NODE_DIR="$ZCLAUDE_HOME/node"
BIN_DIR="${ZCLAUDE_BIN_DIR:-}"
NODE_MAJOR="${ZCLAUDE_NODE_VERSION:-22}"
SOURCE="${ZCLAUDE_INSTALL_SOURCE:-}"
MIN_MAJOR=20
MIN_MINOR=17

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_RESET=""
fi
info() { printf '%s·%s %s\n' "$C_INFO" "$C_RESET" "$*" >&2; }
ok() { printf '%s✓%s %s\n' "$C_OK" "$C_RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die() { printf '%s✗%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed."; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/zclaude-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# ----------------------------------------------------------------- platform
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  *) die "Unsupported OS: $(uname -s). zclaude runs on macOS and Linux (use npm on Windows)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) die "Unsupported CPU architecture: $(uname -m)." ;;
esac

path_has() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

# Link into a directory that is already on PATH when there is a sensible one,
# so the command works in the shell that ran the installer without any PATH
# edit. Falls back to ~/.local/bin, which is then added to the shell profile.
choose_bin_dir() {
  local candidate
  # Only ever inside the home directory: an installer piped from curl should
  # not write into /usr/local or a Homebrew prefix.
  for candidate in "$HOME/.local/bin" "$HOME/bin"; do
    path_has "$candidate" || continue
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
    if [ ! -d "$candidate" ] && [ -w "$HOME" ]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "$HOME/.local/bin"
}

if [ -z "$BIN_DIR" ]; then BIN_DIR="$(choose_bin_dir)"; fi

# ---------------------------------------------------------------- uninstall
remove_links() {
  local candidate target
  for candidate in "$BIN_DIR" "$HOME/.local/bin" "$HOME/bin"; do
    [ -L "$candidate/zclaude" ] || continue
    target="$(readlink "$candidate/zclaude")"
    case "$target" in
      *"/.zclaude/app/zclaude" | "$APP_DIR"*) rm -f "$candidate/zclaude" && info "Removed $candidate/zclaude" ;;
      *) : ;;
    esac
  done
}

remove_path_lines() {
  local rc
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    grep -Fq "# added by the zclaude installer" "$rc" || continue
    # grep exits 1 when nothing is left, which is a valid result here.
    grep -Fv "# added by the zclaude installer" "$rc" >"$rc.zclaude-tmp" || true
    if [ -f "$rc.zclaude-tmp" ]; then
      mv "$rc.zclaude-tmp" "$rc"
      info "Removed the PATH line from $rc"
    fi
  done
}

remove_keychain() {
  [ "$PLATFORM" = "darwin" ] || return 0
  [ -n "${ZCLAUDE_NO_KEYCHAIN:-}" ] && return 0
  command -v security >/dev/null 2>&1 || return 0
  local removed=0
  while security delete-generic-password -s zclaude >/dev/null 2>&1; do
    removed=$((removed + 1))
    [ "$removed" -gt 10 ] && break
  done
  [ "$removed" -gt 0 ] && info "Removed the zclaude item from your Keychain"
  return 0
}

# Claude Code keeps each profile's login in its own Keychain item, keyed by
# that profile's config directory. Those items sit outside ~/.zclaude, so they
# have to be removed by name or they outlive the uninstall. The service names
# are recorded in the registry when the profile is created.
remove_profile_credentials() {
  [ "$PLATFORM" = "darwin" ] || return 0
  if [ -n "${ZCLAUDE_NO_KEYCHAIN:-}" ]; then return 0; fi
  command -v security >/dev/null 2>&1 || return 0
  local registry="$ZCLAUDE_HOME/profiles.json"
  [ -f "$registry" ] || return 0
  local services removed=0 service
  services="$(grep -o '"credentialService": *"[^"]*"' "$registry" | sed 's/.*: *"//; s/"$//' || true)"
  [ -n "$services" ] || return 0
  while IFS= read -r service; do
    [ -n "$service" ] || continue
    if security delete-generic-password -s "$service" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done <<<"$services"
  if [ "$removed" -gt 0 ]; then
    info "Signed $removed profile(s) out of Claude Code"
  fi
  return 0
}

if [ "${1:-}" = "--uninstall" ]; then
  KEEP_CONFIG=""
  [ "${2:-}" = "--keep-config" ] && KEEP_CONFIG=1
  info "Removing zclaude from this machine"
  rm -rf "$APP_DIR" "$NODE_DIR"
  remove_links
  remove_path_lines
  remove_keychain
  if [ -n "$KEEP_CONFIG" ]; then
    info "Kept $ZCLAUDE_HOME (settings, logs and profiles)."
  else
    remove_profile_credentials
    rm -rf "$ZCLAUDE_HOME"
    info "Removed $ZCLAUDE_HOME (settings, logs, profiles, any credential file)."
  fi
  ok "zclaude is gone from this machine."
  info "The API key still exists on your Z.ai account. Revoke it at https://z.ai/manage-apikey/apikey-list if you no longer need it."
  exit 0
fi
if [ -n "${1:-}" ]; then die "Unknown argument: $1 (only --uninstall [--keep-config] is supported)"; fi

# --------------------------------------------------------------------- node
version_ok() {
  local raw major minor
  raw="$("$1" --version 2>/dev/null || true)"
  raw="${raw#v}"
  major="${raw%%.*}"
  minor="${raw#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [[ "$minor" =~ ^[0-9]+$ ]] || minor=0
  [ "$major" -gt "$MIN_MAJOR" ] && return 0
  [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]
}

find_node() {
  local candidate
  for candidate in "$NODE_DIR/bin/node" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && version_ok "$candidate" && { echo "$candidate"; return 0; }
  done
  return 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else die "Neither shasum nor sha256sum is available to verify downloads."; fi
}

install_node() {
  need curl
  need tar
  local existing
  existing="$(command -v node 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    info "Found Node.js $("$existing" --version 2>/dev/null) at $existing, but zclaude needs $MIN_MAJOR.$MIN_MINOR+; leaving it untouched and adding a private Node $NODE_MAJOR for zclaude"
  else
    info "Node.js is not installed; downloading a private Node $NODE_MAJOR build for zclaude from nodejs.org"
  fi
  local sums entry file sha url
  sums="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt")" || die "Could not fetch the Node.js release list."
  entry="$(printf '%s\n' "$sums" | grep -E "node-v[0-9.]+-${PLATFORM}-${ARCH}\.tar\.gz$" | head -n 1)"
  [ -n "$entry" ] || die "No Node $NODE_MAJOR build for ${PLATFORM}-${ARCH} on nodejs.org."
  sha="${entry%% *}"
  file="${entry##* }"
  url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${file}"
  info "Fetching $file"
  curl -fL --progress-bar -o "$WORK/$file" "$url" || die "Download failed: $url"
  [ "$(sha256_of "$WORK/$file")" = "$sha" ] || die "Checksum mismatch for $file; refusing to install."
  rm -rf "$NODE_DIR.tmp"
  mkdir -p "$NODE_DIR.tmp"
  tar -xzf "$WORK/$file" -C "$NODE_DIR.tmp" --strip-components=1
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.tmp" "$NODE_DIR"
  ok "Node.js $("$NODE_DIR/bin/node" --version) installed in $NODE_DIR (private to zclaude; your PATH is not changed for it)"
  echo "$NODE_DIR/bin/node"
}

NODE_BIN="$(find_node || true)"
if [ -n "${ZCLAUDE_INSTALL_FORCE_NODE:-}" ] && [ ! -x "$NODE_DIR/bin/node" ]; then NODE_BIN=""; fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(install_node | tail -n 1)"
else
  ok "Using Node.js $("$NODE_BIN" --version) at $NODE_BIN"
fi
NODE_BIN_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
NPM_BIN="$NODE_BIN_DIR/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm 2>/dev/null || true)"
[ -n "$NPM_BIN" ] || die "npm was not found next to $NODE_BIN."

# ------------------------------------------------------------------ zclaude
STAGE="$WORK/app"
mkdir -p "$STAGE"
if [ -n "$SOURCE" ]; then
  if [ -d "$SOURCE" ]; then
    info "Installing zclaude from local directory $SOURCE"
    tar -C "$SOURCE" --exclude=node_modules --exclude=.git -cf - . | tar -C "$STAGE" -xf -
  elif [ -f "$SOURCE" ]; then
    info "Installing zclaude from local archive $SOURCE"
    tar -xzf "$SOURCE" -C "$STAGE" --strip-components=1
  else
    die "ZCLAUDE_INSTALL_SOURCE=$SOURCE is neither a directory nor a file."
  fi
else
  need curl
  need tar
  info "Downloading zclaude ($REF) from github.com/$REPO"
  curl -fsSL -o "$WORK/zclaude.tar.gz" "https://codeload.github.com/$REPO/tar.gz/$REF" || die "Could not download zclaude ($REF)."
  tar -xzf "$WORK/zclaude.tar.gz" -C "$STAGE" --strip-components=1
fi
if [ ! -f "$STAGE/package.json" ] || [ ! -f "$STAGE/bin/zclaude.js" ]; then
  die "The downloaded archive does not look like zclaude."
fi

info "Installing zclaude's runtime dependency"
(cd "$STAGE" && PATH="$NODE_BIN_DIR:$PATH" "$NPM_BIN" install --omit=dev --ignore-scripts --no-fund --no-audit --no-update-notifier --loglevel=error) || die "npm install failed."

mkdir -p "$(dirname "$APP_DIR")"
rm -rf "$APP_DIR.tmp"
mv "$STAGE" "$APP_DIR.tmp"
rm -rf "$APP_DIR"
mv "$APP_DIR.tmp" "$APP_DIR"
chmod +x "$APP_DIR/zclaude" "$APP_DIR/bin/zclaude.js"
VERSION="$(PATH="$NODE_BIN_DIR:$PATH" "$NODE_BIN" -p 'require(process.argv[1] + "/package.json").version' "$APP_DIR")"
ok "zclaude $VERSION installed in $APP_DIR"

mkdir -p "$BIN_DIR"
ln -sfn "$APP_DIR/zclaude" "$BIN_DIR/zclaude"
ok "Linked $BIN_DIR/zclaude"

# --------------------------------------------------------------------- path
if ! path_has "$BIN_DIR"; then
  if [ -n "${ZCLAUDE_INSTALL_NO_RC:-}" ]; then
    warn "$BIN_DIR is not on your PATH. Add it yourself: export PATH=\"$BIN_DIR:\$PATH\""
  else
    case "$(basename "${SHELL:-sh}")" in
      zsh) RC="$HOME/.zshrc" ;;
      bash) if [ "$PLATFORM" = "darwin" ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
      fish) RC="" ;;
      *) RC="$HOME/.profile" ;;
    esac
    LINE="export PATH=\"$BIN_DIR:\$PATH\" # added by the zclaude installer"
    if [ -n "$RC" ]; then
      if ! grep -Fqs "# added by the zclaude installer" "$RC"; then
        printf '\n%s\n' "$LINE" >>"$RC"
        ok "Added $BIN_DIR to PATH in $RC (open a new terminal, or run: source $RC)"
      fi
    else
      warn "Add $BIN_DIR to your PATH (fish): fish_add_path $BIN_DIR"
    fi
  fi
fi

# --------------------------------------------------------------- claude code
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  ok "Claude Code found: $(command -v claude || echo "$HOME/.local/bin/claude")"
elif [ -n "${ZCLAUDE_INSTALL_NO_CLAUDE:-}" ]; then
  warn "Skipping Claude Code (ZCLAUDE_INSTALL_NO_CLAUDE is set). zclaude needs it: https://claude.ai/install.sh"
else
  need curl
  info "Claude Code not found; running Anthropic's installer (https://claude.ai/install.sh)"
  curl -fsSL https://claude.ai/install.sh | bash || warn "Claude Code's installer did not finish. Install it later with: curl -fsSL https://claude.ai/install.sh | bash"
fi

# ------------------------------------------------------------------- verify
if ! "$BIN_DIR/zclaude" --version >/dev/null 2>&1; then
  die "zclaude was installed but '$BIN_DIR/zclaude --version' failed. Run it with --verbose to see why."
fi
if path_has "$BIN_DIR"; then
  ok "Ready. Run: zclaude"
else
  ok "Ready. Run it now with $BIN_DIR/zclaude, or open a new terminal and type zclaude."
fi
