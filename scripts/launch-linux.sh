#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# GUI-launched .desktop files may not inherit the shell's PATH (for example,
# a user-local Node.js installation under ~/.local/bin).
export PATH="$HOME/.local/bin:$PATH"

# A desktop launcher is explicitly graphical, even when the shell that
# created it previously used the headless mode for server-side work.
unset LEAFCODE_PI_HEADLESS
export LEAFCODE_PI_TRAY=1

exec "$ROOT_DIR/start.sh" "$@"
