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

LOG_ROOT=${XDG_STATE_HOME:-"$HOME/.local/state"}
LOG_DIR="$LOG_ROOT/leafcode-pi"
mkdir -p "$LOG_DIR"

# A .desktop launcher must survive the short-lived launcher process. Detach
# stdout/stderr as well so GNOME/Nautilus cannot close the host on exit.
nohup setsid "$ROOT_DIR/start.sh" "$@" \
  >> "$LOG_DIR/launcher.log" 2>&1 </dev/null &
