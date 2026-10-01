#!/usr/bin/env node
// codex-cua-plus: claude-codex-computer-use köprüsünün önünde çalışan sarmalayıcı MCP sunucusu.
// Üst akış araçlarını aynen geçirir; üstüne batch, tekrarlı press_key, open_path_in_dialog
// ve isteğe bağlı ekran görüntüsü kırpma ekler. Bağımlılık yok, yalnızca Node >= 22.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const NPX = process.env.CUA_PLUS_NPX || "npx";
const BRIDGE_ARGS = ["-y", "claude-codex-computer-use@latest"];
const DEFAULT_SCREENSHOT = (process.env.CUA_PLUS_DEFAULT_SCREENSHOT ?? "false") === "true";
const KEY_DELAY_MS = Number(process.env.CUA_PLUS_KEY_DELAY_MS ?? 40);
const CODEX_APP_NAME = process.env.CUA_PLUS_APP_NAME || "ChatGPT"; // Codex uygulamasının macOS adı

const debug = (m) => { if (process.env.CUA_PLUS_DEBUG) process.stderr.write(`[cua-plus] ${m}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- üst akış (köprü) ----------
const up = spawn(NPX, BRIDGE_ARGS, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
let nextId = 1;
const pending = new Map();
let upstreamInitialized = null;

function upSend(obj) { up.stdin.write(JSON.stringify(obj) + "\n"); }
function upRequest(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    upSend({ jsonrpc: "2.0", id, method, params });
  });
}
createInterface({ input: up.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  // Üst akıştan gelen bildirimleri (ör. tools/list_changed) aşağıya geçir.
  if (m.method && m.id === undefined) send(m);
});
up.on("exit", (code) => { debug(`üst akış kapandı (${code})`); process.exit(code ?? 1); });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { debug(`${sig} alındı, üst akış kapatılıyor`); try { up.kill("SIGTERM"); } catch {} setTimeout(() => process.exit(0), 200); });
}

async function ensureUpstream() {
  if (!upstreamInitialized) {
    upstreamInitialized = (async () => {
      await upRequest("initialize", {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "codex-cua-plus", version: "0.1.0" },
      });
      upSend({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
  }
  return upstreamInitialized;
}

// ---------- sonuç işleme ----------
function stripScreenshot(result) {
  if (!result?.content) return result;
  const content = result.content.filter((c) => c.type !== "image");
  content.push({ type: "text", text: "(ekran görüntüsü atlandı; include_screenshot=true ile iste)" });
  return { ...result, content };
}
function resultText(result) {
  return (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
function isSoftError(result) {
  const t = resultText(result);
  return result?.isError || /Re-query the latest state|error/i.test(t.slice(0, 200));
}

// ---------- araç tanımları ----------
const upstreamToolNames = new Set();
const ACTION_SCHEMA = {
  type: "object",
  description: "Üst akış aracının adı ve argümanları (ör. {tool:'click', args:{app:'Freeform', element_index:'31'}})",
  properties: {
    tool: { type: "string", enum: ["click", "set_value", "type_text", "press_key", "scroll", "drag", "select_text", "perform_secondary_action", "get_app_state", "sleep_ms"] },
    args: { type: "object" },
    repeat: { type: "integer", minimum: 1, maximum: 200, description: "Bu eylemi kaç kez tekrarla (ör. ok tuşu)." },
  },
  required: ["tool"],
};
const EXTRA_TOOLS = [
  {
    name: "batch",
    description: "Birden çok Computer Use eylemini sırayla tek çağrıda çalıştırır. Ara durumlar atlanır, yalnızca son durum (ve istenirse ekran görüntüsü) döner. Bir eylem hata verirse durur ve o ana kadarki özeti döndürür. 'app' tüm eylemlere varsayılan olarak uygulanır.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Varsayılan hedef uygulama (eylemde app verilmezse kullanılır)." },
        actions: { type: "array", items: ACTION_SCHEMA, minItems: 1 },
        include_screenshot: { type: "boolean", description: `Son durumda ekran görüntüsü de dönsün mü (varsayılan ${DEFAULT_SCREENSHOT}).` },
        final_state: { type: "boolean", description: "Sonda get_app_state çağır (varsayılan true)." },
      },
      required: ["actions"],
    },
  },
  {
    name: "open_path_in_dialog",
    description: "Açık bir macOS Aç/Kaydet panelinde ⌘⇧G ile 'Go to Folder' açar, verilen yolu yazar ve Return ile o dosyaya/klasöre gider. Ardından confirm=true ise bir Return daha basarak panelin varsayılan düğmesini (Open/Insert/Save) tetikler.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        path: { type: "string", description: "Tam dosya veya klasör yolu." },
        confirm: { type: "boolean", description: "Yola gittikten sonra varsayılan düğmeye bas (varsayılan true)." },
        include_screenshot: { type: "boolean" },
      },
      required: ["app", "path"],
    },
  },
];

async function listTools() {
  await ensureUpstream();
  const r = await upRequest("tools/list", {});
  const tools = (r.tools || []).map((t) => {
    upstreamToolNames.add(t.name);
    const schema = structuredClone(t.inputSchema || { type: "object", properties: {} });
    schema.properties ||= {};
    if (t.name === "get_app_state" || t.name === "click" || t.name === "press_key" || t.name === "set_value" || t.name === "type_text" || t.name === "scroll" || t.name === "drag" || t.name === "select_text" || t.name === "perform_secondary_action") {
      schema.properties.include_screenshot = { type: "boolean", description: `Ekran görüntüsü dönsün mü (varsayılan ${DEFAULT_SCREENSHOT}). Ağaç yeterliyse kapalı bırak; çok daha hızlı.` };
    }
    if (t.name === "press_key") {
      schema.properties.repeat = { type: "integer", minimum: 1, maximum: 200, description: "Tuşu kaç kez bas (ör. 15 kez shift+Down)." };
    }
    return { ...t, inputSchema: schema };
  });
  return { tools: [...tools, ...EXTRA_TOOLS] };
}

// Computer Use servisi ChatGPT.app'in codex app-server'ına bağlı; uygulama kapalıysa -10005 döner.
// Bu durumda uygulamayı arka planda açıp (-g: öne getirmez) bir kez yeniden dene.
const SERVICE_DOWN = /-10005|app-server exited|Sender process is not authenticated/;
let launchingApp = null;
async function ensureCodexAppRunning() {
  if (launchingApp) return launchingApp;
  launchingApp = (async () => {
    debug(`${CODEX_APP_NAME}.app başlatılıyor (servis kapalı)`);
    await new Promise((res) => spawn("open", ["-g", "-a", CODEX_APP_NAME], { stdio: "ignore" }).on("exit", res));
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const ok = await new Promise((res) => {
        const c = spawn("pgrep", ["-f", "codex .*app-server"], { stdio: "ignore" }); c.on("exit", (code) => res(code === 0));
      });
      if (ok) { await sleep(3000); return true; }
    }
    return false;
  })();
  try { return await launchingApp; } finally { setTimeout(() => { launchingApp = null; }, 10000); }
}
async function callUpstream(name, args) {
  const attempt = async () => {
    try { return await upRequest("tools/call", { name, arguments: args }); }
    catch (e) { return { content: [{ type: "text", text: String(e.message) }], isError: true }; }
  };
  let r = await attempt();
  if (SERVICE_DOWN.test(resultText(r))) {
    if (await ensureCodexAppRunning()) r = await attempt();
    if (SERVICE_DOWN.test(resultText(r))) r.content.push({ type: "text", text: "Not: Codex Computer Use servisi ChatGPT.app açıkken çalışır; uygulama başlatılamadı veya servis gelmedi." });
  }
  return r;
}

async function runAction(defaultApp, action) {
  const args = { ...(action.args || {}) };
  if (defaultApp && args.app === undefined) args.app = defaultApp;
  const n = action.repeat ?? 1;
  if (action.tool === "sleep_ms") { await sleep(Number(args.ms ?? 300)); return { content: [{ type: "text", text: `slept ${args.ms ?? 300} ms` }] }; }
  let last;
  for (let i = 0; i < n; i++) {
    last = await callUpstream(action.tool, args);
    if (isSoftError(last)) return last;
    if (n > 1 && i < n - 1) await sleep(KEY_DELAY_MS);
  }
  return last;
}

async function callTool(name, rawArgs) {
  await ensureUpstream();
  const args = { ...(rawArgs || {}) };
  const wantShot = args.include_screenshot ?? DEFAULT_SCREENSHOT;
  delete args.include_screenshot;

  if (name === "batch") {
    const app = args.app;
    const log = [];
    let last;
    for (const [i, a] of (args.actions || []).entries()) {
      try {
        last = await runAction(app, a);
        log.push(`${i + 1}. ${a.tool}${a.repeat > 1 ? `×${a.repeat}` : ""} ok`);
        if (isSoftError(last)) { log.push(`   durdu: ${resultText(last).slice(0, 200)}`); break; }
      } catch (e) {
        log.push(`${i + 1}. ${a.tool} HATA: ${e.message}`); last = { content: [{ type: "text", text: e.message }], isError: true }; break;
      }
    }
    if (args.final_state !== false && app) {
      try { last = await callUpstream("get_app_state", { app }); } catch (e) { log.push(`final get_app_state HATA: ${e.message}`); }
    }
    const out = wantShot ? last : stripScreenshot(last);
    return { ...out, content: [{ type: "text", text: `batch:\n${log.join("\n")}` }, ...(out?.content || [])] };
  }

  if (name === "open_path_in_dialog") {
    const app = args.app;
    await callUpstream("press_key", { app, key: "super+shift+g" });
    await sleep(250);
    // Go To penceresindeki yol alanını ağaçtan bul.
    const st = await callUpstream("get_app_state", { app });
    const m = resultText(st).match(/^\s*(\d+) text field .*PathTextField/m);
    if (!m) return { content: [{ type: "text", text: "Go to Folder alanı bulunamadı; panel açık mı?" }, ...st.content.filter((c) => c.type === "text")], isError: true };
    await callUpstream("set_value", { app, element_index: m[1], value: args.path });
    await sleep(150);
    let last = await callUpstream("press_key", { app, key: "Return" });
    if (args.confirm !== false) { await sleep(300); last = await callUpstream("press_key", { app, key: "Return" }); }
    await sleep(300);
    last = await callUpstream("get_app_state", { app });
    return wantShot ? last : stripScreenshot(last);
  }

  if (name === "press_key" && args.repeat) {
    const r = await runAction(undefined, { tool: "press_key", args: { app: args.app, key: args.key }, repeat: args.repeat });
    return wantShot ? r : stripScreenshot(r);
  }
  delete args.repeat;

  const r = await callUpstream(name, args);
  if (name === "list_apps") return r;
  return wantShot ? r : stripScreenshot(r);
}

// ---------- alt akış (Claude Code) ----------
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
createInterface({ input: process.stdin }).on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "notifications/initialized" || (m.method?.startsWith("notifications/") && m.id === undefined)) return;
  if (m.id === undefined) return;
  try {
    let result;
    switch (m.method) {
      case "initialize":
        result = { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-cua-plus", version: "0.1.0" } };
        break;
      case "ping": result = {}; break;
      case "tools/list": result = await listTools(); break;
      case "tools/call": result = await callTool(m.params?.name, m.params?.arguments); break;
      default: send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } }); return;
    }
    send({ jsonrpc: "2.0", id: m.id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `Hata: ${e.message}` }], isError: true } });
  }
}).on("close", () => { up.kill(); process.exit(0); });
