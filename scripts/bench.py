#!/usr/bin/env python3
"""Köprüye (veya sarmalayıcıya) doğrudan bağlanıp gecikme ölçer.

Kullanım:
  python3 scripts/bench.py                 # köprü (npx claude-codex-computer-use)
  python3 scripts/bench.py --plus          # sarmalayıcı (server.mjs)
  python3 scripts/bench.py --app Freeform
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--plus", action="store_true", help="sarmalayıcıyı ölç")
ap.add_argument("--app", default="Finder")
ap.add_argument("--node", default=os.environ.get("NODE_BIN", ""), help="node/npx dizini (ör. ~/.nvm/versions/node/v22.20.0/bin)")
a = ap.parse_args()

node_bin = a.node or str(next(Path.home().glob(".nvm/versions/node/v22*/bin"), "/usr/local/bin"))
app_dir = "/Applications/ChatGPT.app/Contents/Resources"
client = next(Path(app_dir).glob("cua_node/**/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"), None)
env = dict(os.environ,
           PATH=f"{node_bin}:/usr/bin:/bin",
           CUA_PLUS_NPX=f"{node_bin}/npx",
           COMPUTER_USE_CODEX_LAUNCHER_PATH=f"{app_dir}/codex-cli/bin/codex",
           COMPUTER_USE_CLIENT_PATH=str(client or ""))
cmd = [f"{node_bin}/node", str(Path(__file__).resolve().parent.parent / "server.mjs")] if a.plus \
      else [f"{node_bin}/npx", "-y", "claude-codex-computer-use@latest"]

p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
n = [0]
def rpc(method, params):
    n[0] += 1
    obj = {"jsonrpc": "2.0", "id": n[0], "method": method, "params": params}
    t = time.time(); p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line: sys.exit("süreç kapandı")
        m = json.loads(line)
        if m.get("id") == obj["id"]:
            if "error" in m: sys.exit(f"hata: {m['error']}")
            return m["result"], (time.time() - t) * 1000

_, ms = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "bench", "version": "1"}})
print(f"initialize            {ms:7.0f} ms")
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
for i in range(3):
    r, ms = rpc("tools/call", {"name": "get_app_state", "arguments": {"app": a.app}})
    c = r["content"]; txt = sum(len(x.get("text", "")) for x in c); img = sum(len(x.get("data", "")) for x in c if x.get("type") == "image")
    print(f"get_app_state #{i+1}      {ms:7.0f} ms   metin {txt} kr, görüntü {img//1024} KB")
r, ms = rpc("tools/call", {"name": "list_apps", "arguments": {}})
print(f"list_apps             {ms:7.0f} ms")
p.terminate()
