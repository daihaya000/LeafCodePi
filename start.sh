#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'LeafCodePi requires Node.js 22.19 or newer.' >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error("LeafCodePi requires Node.js 22.19 or newer."); process.exit(1); }'

if [ ! -d web/node_modules/next ]; then
  npm --prefix web install
fi
if [ ! -d host/node_modules/systray2 ]; then
  npm --prefix host install
fi

: "${LEAFCODE_PI_MODE:=prod}"
export LEAFCODE_PI_MODE
exec npm run host -- "$@"
