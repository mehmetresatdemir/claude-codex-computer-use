#!/usr/bin/env bash
# codex-cua-plus installer: finds Node 22+, the signed codex launcher and the Computer Use client inside the
# ChatGPT/Codex app, registers the wrapper as the user-scoped MCP server "codex-computer-use" in Claude Code,
# installs the example macros and runs the doctor.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$HERE/server.mjs"

# --- Node >= 22.14 ---
NODE_BIN=""
for d in "$HOME"/.nvm/versions/node/v22*/bin "$HOME"/.nvm/versions/node/v2[3-9]*/bin /opt/homebrew/bin /usr/local/bin; do
  if [ -x "$d/node" ]; then
    v="$("$d/node" -v | sed 's/^v//')"; maj="${v%%.*}"
    if [ "$maj" -ge 22 ]; then NODE_BIN="$d"; fi
  fi
done
if [ -z "$NODE_BIN" ]; then
  echo "Node >= 22.14 not found. Install it with nvm:  nvm install 22" >&2; exit 1
fi
echo "node:   $NODE_BIN ($("$NODE_BIN/node" -v))"

# --- signed launcher and client inside the app ---
APP="${CUA_PLUS_APP_PATH:-/Applications/ChatGPT.app}"
[ -d "$APP" ] || { echo "App not found: $APP (set CUA_PLUS_APP_PATH)" >&2; exit 1; }
LAUNCHER="$APP/Contents/Resources/codex-cli/bin/codex"
CLIENT="$(find "$APP/Contents/Resources" -maxdepth 9 -type f -name SkyComputerUseClient -path '*MacOS*' 2>/dev/null | head -1)"
[ -x "$LAUNCHER" ] || { echo "Signed codex launcher not found: $LAUNCHER" >&2; exit 1; }
[ -n "$CLIENT" ] || { echo "SkyComputerUseClient not found (is Computer Use installed in the app?)" >&2; exit 1; }
echo "codex:  $LAUNCHER"
echo "client: $CLIENT"

# --- MCP registration ---
command -v claude >/dev/null || { echo "claude CLI not found" >&2; exit 1; }
claude mcp remove codex-computer-use -s user >/dev/null 2>&1 || true
claude mcp add codex-computer-use -s user \
  -e "PATH=$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  -e "CUA_PLUS_NPX=$NODE_BIN/npx" \
  -e "COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS=${IDLE_MS:-600000}" \
  -e "COMPUTER_USE_CODEX_LAUNCHER_PATH=$LAUNCHER" \
  -e "COMPUTER_USE_CLIENT_PATH=$CLIENT" \
  -- "$NODE_BIN/node" "$SERVER"

# --- example macros ---
MACRO_DIR="${CUA_PLUS_MACRO_DIR:-$HOME/.codex-cua-plus}"; mkdir -p "$MACRO_DIR"
python3 - "$HERE/examples/macros" "$MACRO_DIR/macros.json" <<'EOF'
import json, sys, os, glob, datetime
src, dst = sys.argv[1], sys.argv[2]
m = json.load(open(dst)) if os.path.exists(dst) else {}
for f in glob.glob(os.path.join(src, "*.json")):
    d = json.load(open(f)); name = d.pop("name")
    if name not in m: d["saved_at"] = datetime.datetime.now().isoformat(); m[name] = d; print("macro added:", name)
json.dump(m, open(dst, "w"), indent=2, ensure_ascii=False)
EOF

echo
claude mcp get codex-computer-use
echo
echo "Doctor:"
COMPUTER_USE_CODEX_LAUNCHER_PATH="$LAUNCHER" COMPUTER_USE_CLIENT_PATH="$CLIENT" CUA_PLUS_NPX="$NODE_BIN/npx" "$NODE_BIN/node" "$SERVER" doctor || true
echo
echo "Done. Start a new Claude Code session; the tools appear as mcp__codex-computer-use__*. Keep the ChatGPT app running."
