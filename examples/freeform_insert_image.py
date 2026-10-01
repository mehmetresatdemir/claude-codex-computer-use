#!/usr/bin/env python3
"""Claude olmadan, Python'dan sarmalayıcıyı sürerek Freeform'a bir resim ekler.

Akış: get_app_state → (All Boards ise) panoyu aç → Insert → Choose File → open_path_in_dialog.
Bugünkü ölçümde uçtan uca ~5,6 sn.

  python3 examples/freeform_insert_image.py /tam/yol/resim.png [--board "Untitled 5"]
"""
import argparse, json, os, re, subprocess, sys, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("image"); ap.add_argument("--board", default=None, help="All Boards görünümündeysek açılacak pano adı")
ap.add_argument("--node", default=os.environ.get("NODE_BIN", ""))
a = ap.parse_args()
img = str(Path(a.image).resolve())

node_bin = a.node or str(next(Path.home().glob(".nvm/versions/node/v22*/bin"), "/usr/local/bin"))
app_dir = "/Applications/ChatGPT.app/Contents/Resources"
client = next(Path(app_dir).glob("cua_node/**/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"), None)
env = dict(os.environ, PATH=f"{node_bin}:/usr/bin:/bin", CUA_PLUS_NPX=f"{node_bin}/npx",
           COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS="600000",
           COMPUTER_USE_CODEX_LAUNCHER_PATH=f"{app_dir}/codex-cli/bin/codex", COMPUTER_USE_CLIENT_PATH=str(client or ""))
server = Path(__file__).resolve().parent.parent / "server.mjs"
p = subprocess.Popen([f"{node_bin}/node", str(server)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)

n = [0]
def rpc(method, params):
    n[0] += 1; obj = {"jsonrpc": "2.0", "id": n[0], "method": method, "params": params}
    p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()
    while True:
        m = json.loads(p.stdout.readline())
        if m.get("id") == obj["id"]: return m["result"]
def text(r): return "\n".join(c.get("text", "") for c in r["content"] if c["type"] == "text")
def idx(t, pat):
    m = re.search(pat, t, re.M); return m and m.group(1)
def call(name, **args): return rpc("tools/call", {"name": name, "arguments": {"app": "Freeform", **args}})

rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "example", "version": "1"}})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
T = time.time()
try:
    t = text(call("get_app_state"))
    if "error" in t[:150]: sys.exit(t[:300])
    if a.board:
        b = idx(t, rf"^\s*(\d+) button .*Board: {re.escape(a.board)}")
        if b: t = text(call("click", element_index=b))
    ins = idx(t, r"^\s*(\d+) Insert$") or sys.exit("Insert menüsü bulunamadı; bir pano açık mı?")
    menu = text(call("click", element_index=ins))
    cf = idx(menu, r"^\s*(\d+) Choose File") or sys.exit("Choose File yok (All Boards görünümünde olabilirsin; --board ver)")
    call("click", element_index=cf)
    r = text(call("open_path_in_dialog", path=img))
    ok = Path(img).name in r and "image (selected)" in r
    print(f"{'eklendi' if ok else 'EKLENEMEDİ'} — {(time.time()-T)*1000:.0f} ms")
    if not ok: print(r[:500])
finally:
    p.terminate(); p.wait(timeout=5)
