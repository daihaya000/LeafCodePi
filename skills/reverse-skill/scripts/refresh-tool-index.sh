#!/usr/bin/env bash
# refresh-tool-index.sh — Detect installed tools and regenerate tool-index.md/json
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/bootstrap-manifest.json"
INDEX_MD="$SCRIPT_DIR/../references/tool-index.md"
INDEX_JSON="$SCRIPT_DIR/../references/tool-index.json"

TOOLS="jadx apktool frida adb r2 rabin2 rasm2 radiff2 gdb pwntools ropgadget nmap nuclei sqlmap ffuf hashcat binwalk yara trivy syft garak python3"
EXTRA_PATHS="/usr/local/bin /opt/homebrew/bin ~/.local/bin ~/scoop/shims"

found_path() {
  command -v "$1" 2>/dev/null && return 0
  for p in $EXTRA_PATHS; do
    [ -x "$p/$1" ] && echo "$p/$1" && return 0
  done
  return 1
}

{
  echo "# Tool Index (auto-generated)"
  echo ""
  echo "> Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "> Do not edit manually — run scripts/refresh-tool-index.sh to regenerate."
  echo ""
  echo "| Tool | Available | Path |"
  echo "|------|-----------|------|"
  for t in $TOOLS; do
    if p=$(found_path "$t"); then
      echo "| $t | yes | $p |"
    else
      echo "| $t | no | — |"
    fi
  done
} > "$INDEX_MD"

{
  echo "{"
  echo "  \"generated\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\","
  echo "  \"tools\": {"
  first=1
  for t in $TOOLS; do
    [ $first -eq 0 ] && echo ","
    first=0
    if p=$(found_path "$t" 2>/dev/null); then
      printf "    \"%s\": {\"available\": true, \"path\": \"%s\"}" "$t" "$p"
    else
      printf "    \"%s\": {\"available\": false, \"path\": null}" "$t"
    fi
  done
  echo ""
  echo "  }"
  echo "}"
} > "$INDEX_JSON"

echo "[OK] tool-index regenerated: $INDEX_MD"