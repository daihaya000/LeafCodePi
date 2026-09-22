#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_ROOT=${XDG_DATA_HOME:-"$HOME/.local/share"}
APPLICATIONS_DIR="$DATA_ROOT/applications"
ICON_DIR="$DATA_ROOT/icons/hicolor/512x512/apps"
DESKTOP_FILE="$APPLICATIONS_DIR/leafcode-pi.desktop"
ICON_SOURCE="$ROOT_DIR/web/public/icon-512.png"
ICON_TARGET="$ICON_DIR/leafcode-pi.png"
LAUNCHER="$ROOT_DIR/scripts/launch-linux.sh"

if [ ! -x "$LAUNCHER" ]; then
  printf '%s\n' "[LeafCodePi] Launcher is not executable: $LAUNCHER" >&2
  exit 1
fi
if [ ! -f "$ICON_SOURCE" ]; then
  printf '%s\n' "[LeafCodePi] Icon not found: $ICON_SOURCE" >&2
  exit 1
fi

mkdir -p "$APPLICATIONS_DIR" "$ICON_DIR"
install -m 0644 "$ICON_SOURCE" "$ICON_TARGET"

# Keep the executable path quoted so spaces in the checkout path are valid in
# the desktop entry. The path is generated from the current checkout, making
# the launcher continue to work even when the repository is outside $HOME.
EXEC_PATH=$(printf '%s' "$LAUNCHER" | sed 's/[\\"]/\\&/g')
WORKING_DIR=$(printf '%s' "$ROOT_DIR" | sed 's/[\\"]/\\&/g')
{
  printf '%s\n' '[Desktop Entry]'
  printf '%s\n' 'Version=1.0'
  printf '%s\n' 'Type=Application'
  printf '%s\n' 'Name=LeafCodePi'
  printf '%s\n' 'Comment=LeafCodePi Pi Coding Agent'
  printf 'Exec="%s"\n' "$EXEC_PATH"
  printf '%s\n' 'Icon=leafcode-pi'
  printf 'Path=%s\n' "$WORKING_DIR"
  printf '%s\n' 'Terminal=false'
  printf '%s\n' 'StartupNotify=false'
  printf '%s\n' 'Categories=Development;'
  printf '%s\n' 'Keywords=Pi;Coding;Agent;'
} > "$DESKTOP_FILE"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$DESKTOP_FILE"
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

printf '%s\n' "[LeafCodePi] Launcher installed: $DESKTOP_FILE"
printf '%s\n' '[LeafCodePi] Open the app list, right-click LeafCodePi, then choose Add to Favorites.'
