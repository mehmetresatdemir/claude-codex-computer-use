// The upstream bridge process (claude-codex-computer-use → codex sandbox → SkyComputerUseClient mcp) and its JSON-RPC link.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * @param {object} o
 * @param {string} o.cmd            command to spawn
 * @param {string[]} o.args
 * @param {object} o.env
 * @param {number} o.timeoutMs      per-request timeout
 * @param {(msg:object)=>void} o.sendDown   forward a message to the MCP client (notifications, relayed requests)
 * @param {(line:string)=>void} o.debug
 * @param {(code:number|null)=>void} o.onExit
 */
export function createUpstream({ cmd, args, env, timeoutMs, sendDown, debug, onExit, clientInfo }) {
  // Own process group so a single kill reaches the whole chain (npx → bridge → launcher → client).
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], env, detached: true });
  child.on("error", (e) => { process.stderr.write(`[cua-plus] cannot start the bridge (${cmd}): ${e.message}\n`); onExit(1); });
  child.stdin.on("error", (e) => debug(`upstream stdin: ${e.message}`));
  let nextId = 1;
  const pending = new Map(); // id → {resolve, reject, timer}
  const relayed = new Map(); // id given to the client → upstream's original id
  let initialized = null;

  function send(obj) { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch (e) { debug(`upstream write failed: ${e.message}`); } }
  function request(method, params, ms = timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`upstream timeout after ${ms} ms (${method})`)); }, ms);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { debug(`upstream non-JSON line: ${line.slice(0, 120)}`); return; }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) { const e = new Error(m.error.message || JSON.stringify(m.error)); e.code = m.error.code; e.data = m.error.data; p.reject(e); }
      else p.resolve(m.result);
      return;
    }
    if (m.method && m.id !== undefined) { // upstream-initiated request (elicitation/create, roots/list, ping): relay to the client
      if (m.method === "ping") { send({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
      const rid = `up-${nextId++}`;
      relayed.set(rid, m.id);
      sendDown({ ...m, id: rid });
      return;
    }
    if (m.method) sendDown(m); // notification
  });
  child.on("exit", (code) => {
    debug(`upstream exited (${code})`);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("upstream exited")); }
    pending.clear();
    onExit(code);
  });

  return {
    child,
    request,
    send,
    /** Reply from the client to a relayed request → back to the bridge. Returns true when handled. */
    relayReply(msg) {
      if (msg.id === undefined || msg.method !== undefined || !relayed.has(msg.id)) return false;
      const orig = relayed.get(msg.id); relayed.delete(msg.id);
      send({ ...msg, id: orig });
      return true;
    },
    ensureInitialized() {
      if (!initialized) {
        initialized = (async () => {
          await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo });
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
        })();
      }
      return initialized;
    },
    shutdown() {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
    },
  };
}

/** Environment for the bridge: drop Claude Code / Codex app-tools variables so the client chain does not inherit unrelated pipes. */
export function bridgeEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDE_|CODEX_APP_TOOLS_|MCP_)/.test(k)));
}
