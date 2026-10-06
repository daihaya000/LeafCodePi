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
LOG_FILE="$LOG_DIR/launcher.log"
mkdir -p "$LOG_DIR"
# Every launch (and every Host restart) appends here, and nothing else trims it: it grew without
# bound (12+ MiB of Next build output). Keep one previous generation, like host.log does.
LOG_MAX_BYTES=${LEAFCODE_PI_LAUNCHER_LOG_MAX_BYTES:-8388608}
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(wc -c < "$LOG_FILE" | tr -d '[:space:]')
  if [ "${LOG_SIZE:-0}" -gt "$LOG_MAX_BYTES" ] 2>/dev/null; then
    mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || :
  fi
fi
# The launcher log mirrors host.log (0600): Host output can include local URLs and paths.
( umask 077 && : >> "$LOG_FILE" )
chmod 600 "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || :
LOG_OFFSET=$(wc -c < "$LOG_FILE" | tr -d '[:space:]')
printf '\n[%s] Starting LeafCodePi\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" >> "$LOG_FILE"

# Keep the host detached from the desktop launcher. A separate terminal tails
# only this launch's output, so closing the log window does not stop the host.
nohup setsid "$ROOT_DIR/start.sh" "$@" \
  >> "$LOG_FILE" 2>&1 </dev/null &

show_startup_logs() {
  offset=$1
  tail_command='exec tail -c "+$1" -F "$2"'

  if command -v x-terminal-emulator >/dev/null 2>&1; then
    nohup x-terminal-emulator -e sh -c "$tail_command" sh "$offset" "$LOG_FILE" \
      >/dev/null 2>&1 </dev/null &
  elif command -v gnome-terminal >/dev/null 2>&1; then
    nohup gnome-terminal --title='LeafCodePi Startup Logs' -- sh -c "$tail_command" sh "$offset" "$LOG_FILE" \
      >/dev/null 2>&1 </dev/null &
  elif command -v konsole >/dev/null 2>&1; then
    nohup konsole --title 'LeafCodePi Startup Logs' -e sh -c "$tail_command" sh "$offset" "$LOG_FILE" \
      >/dev/null 2>&1 </dev/null &
  elif command -v xfce4-terminal >/dev/null 2>&1; then
    nohup xfce4-terminal --title='LeafCodePi Startup Logs' --execute sh -c "$tail_command" sh "$offset" "$LOG_FILE" \
      >/dev/null 2>&1 </dev/null &
  elif command -v xterm >/dev/null 2>&1; then
    nohup xterm -T 'LeafCodePi Startup Logs' -e sh -c "$tail_command" sh "$offset" "$LOG_FILE" \
      >/dev/null 2>&1 </dev/null &
  else
    printf '[LeafCodePi] No supported terminal emulator found; logs: %s\n' "$LOG_FILE" >&2
  fi
}

show_startup_logs "$((LOG_OFFSET + 1))"
