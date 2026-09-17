#!/bin/sh
# Publish extension/zclaude.vsix to the VS Code Marketplace and Open VSX.
#
# Dormant on purpose: it needs tokens this repo does not have. Until then the
# vsix is committed and the installer installs it from disk, which is the whole
# distribution story.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
vsix="$root/extension/zclaude.vsix"

[ -f "$vsix" ] || {
  echo "No $vsix. Run \`npm run build:extension\` first." >&2
  exit 1
}

published=0

if [ -n "${VSCE_PAT:-}" ]; then
  echo "Publishing to the VS Code Marketplace"
  "$root/node_modules/.bin/vsce" publish --no-dependencies --packagePath "$vsix"
  published=1
else
  echo "VSCE_PAT is not set; skipping the VS Code Marketplace." >&2
fi

if [ -n "${OVSX_PAT:-}" ]; then
  echo "Publishing to Open VSX"
  npx --yes ovsx publish "$vsix" --pat "$OVSX_PAT"
  published=1
else
  echo "OVSX_PAT is not set; skipping Open VSX." >&2
fi

[ "$published" -eq 1 ] || {
  echo "Nothing was published. Set VSCE_PAT and/or OVSX_PAT." >&2
  exit 1
}
