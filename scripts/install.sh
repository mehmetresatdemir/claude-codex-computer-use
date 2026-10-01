#!/usr/bin/env bash
# codex-cua-plus kurulumu: yolları bulur ve Claude Code'a kullanıcı geneli MCP kaydı yapar.
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
  echo "Node >= 22.14 bulunamadı. nvm ile kur:  nvm install 22" >&2; exit 1
fi
echo "Node: $NODE_BIN ($("$NODE_BIN/node" -v))"

# --- ChatGPT.app içindeki imzalı başlatıcı ve istemci ---
APP="${CUA_PLUS_APP_PATH:-/Applications/ChatGPT.app}"
[ -d "$APP" ] || { echo "ChatGPT.app bulunamadı: $APP (CUA_PLUS_APP_PATH ile belirt)" >&2; exit 1; }
LAUNCHER="$APP/Contents/Resources/codex-cli/bin/codex"
CLIENT="$(find "$APP/Contents/Resources" -maxdepth 9 -type f -name SkyComputerUseClient -path '*MacOS*' 2>/dev/null | head -1)"
[ -x "$LAUNCHER" ] || { echo "İmzalı codex bulunamadı: $LAUNCHER" >&2; exit 1; }
[ -n "$CLIENT" ] || { echo "SkyComputerUseClient bulunamadı (Codex'te Computer Use kurulu mu?)" >&2; exit 1; }
echo "codex:  $LAUNCHER"
echo "client: $CLIENT"

# --- MCP kaydı ---
command -v claude >/dev/null || { echo "claude CLI bulunamadı" >&2; exit 1; }
claude mcp remove codex-computer-use -s user >/dev/null 2>&1 || true
claude mcp add codex-computer-use -s user \
  -e "PATH=$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  -e "CUA_PLUS_NPX=$NODE_BIN/npx" \
  -e "COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS=${IDLE_MS:-600000}" \
  -e "COMPUTER_USE_CODEX_LAUNCHER_PATH=$LAUNCHER" \
  -e "COMPUTER_USE_CLIENT_PATH=$CLIENT" \
  -- "$NODE_BIN/node" "$SERVER"

echo
claude mcp get codex-computer-use
echo
echo "Tamam. Araçların görünmesi için yeni bir Claude Code oturumu aç. ChatGPT.app'in açık olduğundan emin ol."
