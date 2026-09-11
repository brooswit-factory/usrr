#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
UNIT_SRC="$REPO_ROOT/systemd/usrr.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DIR/usrr.service"
ENTRY_POINT="$REPO_ROOT/src/index.ts"
BUN_PATH="$(command -v bun || true)"
CLI_ENTRY="$REPO_ROOT/src/cli/bin.ts"
CLI_LINK="$HOME/.local/bin/usrr"

[[ -f "$UNIT_SRC" ]] || { echo "error: unit file not found: $UNIT_SRC" >&2; exit 1; }
[[ -f "$ENTRY_POINT" ]] || { echo "error: daemon entrypoint not found: $ENTRY_POINT" >&2; exit 1; }
[[ -f "$CLI_ENTRY" ]] || { echo "error: CLI entrypoint not found: $CLI_ENTRY" >&2; exit 1; }
[[ -n "$BUN_PATH" ]] || { echo "error: bun is not on PATH" >&2; exit 1; }

escape_systemd_arg() { local value=$1; value="${value//\\/\\\\}"; value="${value//\"/\\\"}"; value="${value//%/%%}"; printf '%s' "$value"; }
escape_sed_replacement() { printf '%s' "$1" | sed -e 's/[\&]/\\&/g'; }
BUN_ESCAPED="$(escape_sed_replacement "$(escape_systemd_arg "$BUN_PATH")")"
ROOT_ESCAPED="$(escape_sed_replacement "$(escape_systemd_arg "$REPO_ROOT")")"
RENDERED="$(sed -e "s|@@BUN_PATH@@|$BUN_ESCAPED|g" -e "s|@@REPO_ROOT@@|$ROOT_ESCAPED|g" "$UNIT_SRC")"
if printf '%s' "$RENDERED" | grep -q '@@'; then echo "error: rendered unit contains an unresolved placeholder" >&2; exit 1; fi

if command -v systemd-analyze >/dev/null 2>&1; then
  VERIFY_FILE="$(mktemp "${TMPDIR:-/tmp}/usrr-verify-XXXXXX.service")"
  trap 'rm -f "$VERIFY_FILE"' EXIT
  printf '%s\n' "$RENDERED" > "$VERIFY_FILE"
  systemd-analyze --user verify "$VERIFY_FILE"
fi

mkdir -p "$UNIT_DIR" "$HOME/.local/bin"
printf '%s\n' "$RENDERED" > "$UNIT_DEST"
ln -sfn "$CLI_ENTRY" "$CLI_LINK"
chmod +x "$CLI_ENTRY"
systemctl --user daemon-reload
systemctl --user enable usrr.service
loginctl enable-linger "${USER:-$(id -un)}"
echo "installed and enabled usrr.service; it has not been started"
