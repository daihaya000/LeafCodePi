#!/usr/bin/env bash
# bootstrap-reverse.sh — On-demand toolchain installer for reverse-skill
# Usage: bash scripts/bootstrap.sh [capability_id ...]
# If no args, installs all auto_install=true capabilities.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/bootstrap-manifest.json"
OS="$(uname -s)"

detect_os() {
  case "$OS" in
    Linux*) echo "linux" ;;
    Darwin*) echo "macos" ;;
    MING*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

PLATFORM="$(detect_os)"
INSTALLED=()
FAILED=()

install_cap() {
  local id="$1"
  local cmd
  # Parse manifest with python (available on most systems) or jq
  if command -v jq >/dev/null 2>&1; then
    cmd=$(jq -r --arg id "$id" --arg os "$PLATFORM" \
      '.capabilities[] | select(.id==$id) | .commands[$os] // .commands["all"] // empty' "$MANIFEST")
  elif command -v python3 >/dev/null 2>&1; then
    cmd=$(python3 -c "
import json,sys
m=json.load(open('$MANIFEST'))
for c in m['capabilities']:
    if c['id']=='$id':
        cmds=c['commands']
        print(cmds.get('$PLATFORM',cmds.get('all','')))
        break
")
  else
    echo "[ERR] Need jq or python3 to parse manifest" >&2
    return 1
  fi

  if [ -z "$cmd" ]; then
    echo "[SKIP] $id: no install command for $PLATFORM"
    return 0
  fi

  echo "[INSTALL] $id ($PLATFORM): $cmd"
  if bash -c "$cmd"; then
    INSTALLED+=("$id")
    echo "[OK] $id installed"
  else
    FAILED+=("$id")
    echo "[FAIL] $id — see manual steps in manifest" >&2
  fi
}

# Resolve capability IDs
if [ $# -gt 0 ]; then
  IDS=("$@")
else
  if command -v jq >/dev/null 2>&1; then
    mapfile -t IDS < <(jq -r '.capabilities[] | select(.auto_install==true) | .id' "$MANIFEST")
  elif command -v python3 >/dev/null 2>&1; then
    mapfile -t IDS < <(python3 -c "
import json
m=json.load(open('$MANIFEST'))
for c in m['capabilities']:
    if c.get('auto_install'): print(c['id'])
")
  else
    echo "[ERR] Need jq or python3" >&2; exit 1
  fi
fi

echo "=== reverse-skill bootstrap ($PLATFORM) ==="
echo "Targets: ${IDS[*]}"

for id in "${IDS[@]}"; do
  install_cap "$id"
done

echo ""
echo "=== Summary ==="
echo "Installed: ${#INSTALLED[@]} -> ${INSTALLED[*]:-none}"
echo "Failed:    ${#FAILED[@]} -> ${FAILED[*]:-none}"
echo ""
echo "Next: run scripts/refresh-tool-index.sh to regenerate tool-index.md"