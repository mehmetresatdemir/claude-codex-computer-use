#!/usr/bin/env node
// codex-cua-plus: claude-codex-computer-use köprüsünün önünde çalışan sarmalayıcı MCP sunucusu.
// Üst akış araçlarını aynen geçirir; üstüne batch, metinle hedefleme (find), wait_for, menu,
// find_elements, tekrarlı press_key, open_path_in_dialog, isteğe bağlı/küçültülmüş ekran görüntüsü
// ve ChatGPT.app'i otomatik açma ekler. Bağımlılık yok, yalnızca Node >= 22.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NPX = process.env.CUA_PLUS_NPX || "npx";
const BRIDGE_ARGS = ["-y", "claude-codex-computer-use@latest"];
const DEFAULT_SCREENSHOT = (process.env.CUA_PLUS_DEFAULT_SCREENSHOT ?? "false") === "true";
const KEY_DELAY_MS = Number(process.env.CUA_PLUS_KEY_DELAY_MS ?? 40);
const CODEX_APP_NAME = process.env.CUA_PLUS_APP_NAME || "ChatGPT"; // Codex uygulamasının macOS adı
const SCREENSHOT_MAX_PX = Number(process.env.CUA_PLUS_SCREENSHOT_MAX_PX ?? 1280); // 0 = küçültme
const VERSION = "0.2.0";

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
  if (m.method && m.id === undefined) send(m); // üst akış bildirimlerini aşağı geçir
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
        clientInfo: { name: "codex-cua-plus", version: VERSION },
      });
      upSend({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
  }
  return upstreamInitialized;
}

// ---------- sonuç işleme ----------
function resultText(result) {
  return (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
function isSoftError(result) {
  const t = resultText(result);
  return result?.isError || /Re-query the latest state|server error/i.test(t.slice(0, 200));
}
function stripScreenshot(result) {
  if (!result?.content) return result;
  const content = result.content.filter((c) => c.type !== "image");
  content.push({ type: "text", text: "(ekran görüntüsü atlandı; include_screenshot=true ile iste)" });
  return { ...result, content };
}
function run(cmd, args) {
  return new Promise((res) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("exit", (code) => res({ code, out }));
  });
}
async function imageSize(file) {
  const { code, out } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  if (code !== 0) return null;
  const w = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]), h = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return w && h ? { w, h } : null;
}
// Ekran görüntüsünü macOS `sips` ile küçült (PNG/JPEG, bağımlılık gerektirmez). Koordinatlar orijinalde kalır.
async function shrinkScreenshot(result) {
  if (!SCREENSHOT_MAX_PX || !result?.content) return result;
  const idx = result.content.findIndex((c) => c.type === "image");
  if (idx < 0) return result;
  const img = result.content[idx];
  const buf = Buffer.from(img.data, "base64");
  const ext = /jpe?g/i.test(img.mimeType || "") || (buf[0] === 0xff && buf[1] === 0xd8) ? "jpg" : "png";
  const dir = mkdtempSync(join(tmpdir(), "cua-plus-"));
  const file = join(dir, `shot.${ext}`);
  try {
    writeFileSync(file, buf);
    const size = await imageSize(file);
    if (!size || Math.max(size.w, size.h) <= SCREENSHOT_MAX_PX) return result;
    const sipsArgs = ["-Z", String(SCREENSHOT_MAX_PX), ...(ext === "jpg" ? ["-s", "formatOptions", String(process.env.CUA_PLUS_JPEG_QUALITY ?? 70)] : []), file];
    const { code } = await run("sips", sipsArgs);
    if (code !== 0) return result;
    const out = readFileSync(file);
    const ns = (await imageSize(file)) || size;
    const content = [...result.content];
    content[idx] = { ...img, data: out.toString("base64") };
    content.push({ type: "text", text: `Ekran görüntüsü ${ns.w}×${ns.h} px'e küçültüldü (orijinal ${size.w}×${size.h}). Koordinatlar ORİJİNAL çözünürlüktedir: görüntüdeki pikseli ${(size.w / ns.w).toFixed(3)} ile çarp.` });
    return { ...result, content };
  } catch (e) { debug(`küçültme başarısız: ${e.message}`); return result; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
async function finish(result, wantShot) {
  return wantShot ? shrinkScreenshot(result) : stripScreenshot(result);
}

// ---------- erişilebilirlik ağacında arama ----------
// Satır biçimi: "<girinti><index> <rol ve başlık...>". Puan: tam eşleşme 3, başlık/sözcük eşleşmesi 2, alt dize 1.
function parseTree(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+) (.*)$/);
    if (m) rows.push({ index: m[1], rest: m[2], line: line.trim() });
  }
  return rows;
}
function looksLikeTree(text) { return /^\s*0 /m.test(text); }
function findInTree(text, query, { role, nth = 0 } = {}) {
  const q = String(query);
  const isRe = q.length > 2 && q.startsWith("/") && q.lastIndexOf("/") > 0;
  const re = isRe ? new RegExp(q.slice(1, q.lastIndexOf("/")), q.slice(q.lastIndexOf("/") + 1) + (q.endsWith("i") ? "" : "i")) : null;
  const ql = q.toLowerCase();
  const scored = [];
  for (const r of parseTree(text)) {
    if (role && !r.rest.toLowerCase().startsWith(role.toLowerCase())) continue;
    const rl = r.rest.toLowerCase();
    let score = 0;
    if (re) { if (re.test(r.rest)) score = 2; }
    else if (rl === ql) score = 3;
    else if (new RegExp(`(^|\\s|:)${ql.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(,|$)`).test(rl)) score = 2;
    else if (rl.includes(ql)) score = 1;
    if (score) scored.push({ ...r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((s) => s.score === scored[0]?.score);
  return { hit: best[nth] || null, candidates: scored.slice(0, 8) };
}

// ---------- servis/uygulama sağlığı ----------
const SERVICE_DOWN = /-10005|app-server exited|Sender process is not authenticated/;
let launchingApp = null;
async function ensureCodexAppRunning() {
  if (launchingApp) return launchingApp;
  launchingApp = (async () => {
    debug(`${CODEX_APP_NAME}.app başlatılıyor (servis kapalı)`);
    await new Promise((res) => spawn("open", ["-g", "-a", CODEX_APP_NAME], { stdio: "ignore" }).on("exit", res));
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const ok = await new Promise((res) => spawn("pgrep", ["-f", "codex .*app-server"], { stdio: "ignore" }).on("exit", (code) => res(code === 0)));
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
    if (SERVICE_DOWN.test(resultText(r))) r.content.push({ type: "text", text: `Not: Codex Computer Use servisi ${CODEX_APP_NAME}.app açıkken çalışır; uygulama başlatılamadı veya servis gelmedi.` });
  }
  return r;
}

// ---------- araç tanımları ----------
const FIND_DESC = "element_index yerine metinle hedefle: ağaç satırındaki rol/başlık (ör. 'Choose File', 'button New Board'). /regex/ de olur. Tam eşleşme > sözcük eşleşmesi > alt dize. Son bilinen ağaçta aranır; bulunamazsa taze get_app_state alınıp bir kez daha denenir.";
const ACTION_SCHEMA = {
  type: "object",
  description: "Tek eylem. 'tool' üst akış aracı ya da wait_for/sleep_ms. Hedef: args.element_index VEYA find.",
  properties: {
    tool: { type: "string", enum: ["click", "set_value", "type_text", "press_key", "scroll", "drag", "select_text", "perform_secondary_action", "get_app_state", "wait_for", "sleep_ms"] },
    args: { type: "object", description: "Üst akış argümanları (app verilmezse batch.app kullanılır). wait_for: {text, timeout_ms=4000, absent=false}. sleep_ms: {ms}." },
    find: { type: "string", description: FIND_DESC },
    role: { type: "string", description: "find ile birlikte: satır bu rolle başlamalı (ör. 'button', 'menu item', 'text field')." },
    nth: { type: "integer", minimum: 0, description: "find birden çok eşleşirse kaçıncısı (0 = ilk)." },
    repeat: { type: "integer", minimum: 1, maximum: 200, description: "Bu eylemi kaç kez tekrarla (ör. ok tuşu)." },
  },
  required: ["tool"],
};
const EXTRA_TOOLS = [
  {
    name: "batch",
    description: "Birden çok Computer Use eylemini sırayla tek çağrıda çalıştırır; yalnızca son durum döner. Eylemler indeks bilmeden 'find' ile metinle hedeflenebilir (indeksler her adımda yeni ağaçtan çözülür). wait_for ile panel/pencere beklenir. Bir eylem hata verirse durur, o ana kadarki günlük döner.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Varsayılan hedef uygulama." },
        actions: { type: "array", items: ACTION_SCHEMA, minItems: 1 },
        include_screenshot: { type: "boolean", description: `Son durumda ekran görüntüsü (varsayılan ${DEFAULT_SCREENSHOT}).` },
        final_state: { type: "boolean", description: "Sonda get_app_state çağır (varsayılan true)." },
      },
      required: ["actions"],
    },
  },
  {
    name: "menu",
    description: "Menü çubuğundan bir yol tıklar: path=['Insert','Shape','Triangle']. Her adımda yeni ağaçta metinle arar. Sonda isteğe bağlı ekran görüntüsü.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, path: { type: "array", items: { type: "string" }, minItems: 1 }, include_screenshot: { type: "boolean" } },
      required: ["app", "path"],
    },
  },
  {
    name: "find_elements",
    description: "Ağacın tamamını döndürmeden, sorguyla eşleşen satırları (indeks + rol/başlık) döndürür. Taze get_app_state alır.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, query: { type: "string", description: "Alt dize veya /regex/." }, role: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["app", "query"],
    },
  },
  {
    name: "open_path_in_dialog",
    description: "Açık bir macOS Aç/Kaydet panelinde ⌘⇧G ile 'Go to Folder' açar, verilen yolu yazar ve Return ile o dosyaya/klasöre gider. confirm=true ise bir Return daha basarak panelin varsayılan düğmesini (Open/Insert/Save) tetikler.",
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

const TARGETABLE = new Set(["click", "set_value", "scroll", "select_text", "perform_secondary_action"]);
async function listTools() {
  await ensureUpstream();
  const r = await upRequest("tools/list", {});
  const tools = (r.tools || []).map((t) => {
    const schema = structuredClone(t.inputSchema || { type: "object", properties: {} });
    schema.properties ||= {};
    if (t.name !== "list_apps") {
      schema.properties.include_screenshot = { type: "boolean", description: `Ekran görüntüsü dönsün mü (varsayılan ${DEFAULT_SCREENSHOT}). Ağaç yeterliyse kapalı bırak; çok daha hızlı. Açıksa ${SCREENSHOT_MAX_PX || "tam"} px'e küçültülür.` };
    }
    if (TARGETABLE.has(t.name)) {
      schema.properties.find = { type: "string", description: FIND_DESC };
      schema.properties.role = { type: "string", description: "find ile: satır bu rolle başlamalı." };
      schema.properties.nth = { type: "integer", minimum: 0 };
      if (schema.required) schema.required = schema.required.filter((k) => k !== "element_index");
    }
    if (t.name === "press_key") {
      schema.properties.repeat = { type: "integer", minimum: 1, maximum: 200, description: "Tuşu kaç kez bas (ör. 15 kez shift+Down)." };
    }
    return { ...t, inputSchema: schema };
  });
  return { tools: [...tools, ...EXTRA_TOOLS] };
}

// ---------- eylem çalıştırma ----------
// lastTree: aynı çağrı içinde son görülen ağaç metni (find için). Her üst akış yanıtı ağaç içeriyorsa güncellenir.
async function resolveTarget(app, action, state) {
  if (!action.find) return { ok: true };
  let tree = state.lastTree && looksLikeTree(state.lastTree) ? state.lastTree : null;
  let res = tree ? findInTree(tree, action.find, { role: action.role, nth: action.nth }) : { hit: null, candidates: [] };
  if (!res.hit) {
    const st = await callUpstream("get_app_state", { app });
    state.lastTree = resultText(st);
    res = findInTree(state.lastTree, action.find, { role: action.role, nth: action.nth });
  }
  if (!res.hit) {
    const cands = res.candidates.map((c) => `  ${c.index} ${c.rest}`).join("\n");
    return { ok: false, error: `'${action.find}' ağaçta bulunamadı.${cands ? `\nYakın adaylar:\n${cands}` : ""}` };
  }
  return { ok: true, index: res.hit.index, line: res.hit.line };
}

async function waitFor(app, { text, timeout_ms = 4000, absent = false }, state) {
  const deadline = Date.now() + timeout_ms;
  let last;
  while (Date.now() < deadline) {
    last = await callUpstream("get_app_state", { app });
    const t = resultText(last); state.lastTree = t;
    const present = t.toLowerCase().includes(String(text).toLowerCase());
    if (present !== absent) return { ok: true, result: last };
    await sleep(150);
  }
  return { ok: false, result: last, error: `wait_for zaman aşımı (${timeout_ms} ms): '${text}' ${absent ? "hâlâ görünüyor" : "görünmedi"}` };
}

async function runAction(defaultApp, action, state) {
  const args = { ...(action.args || {}) };
  if (defaultApp && args.app === undefined) args.app = defaultApp;
  const app = args.app;
  if (action.tool === "sleep_ms") { await sleep(Number(args.ms ?? 300)); return { result: { content: [{ type: "text", text: `slept ${args.ms ?? 300} ms` }] }, note: `${args.ms ?? 300} ms` }; }
  if (action.tool === "wait_for") {
    const w = await waitFor(app, args, state);
    return w.ok ? { result: w.result, note: `'${args.text}' ${args.absent ? "gitti" : "göründü"}` } : { result: w.result, error: w.error };
  }
  const target = await resolveTarget(app, action, state);
  if (!target.ok) return { result: null, error: target.error };
  if (target.index !== undefined) args.element_index = target.index;
  delete args.find; delete args.role; delete args.nth;
  const n = action.repeat ?? 1;
  let last;
  for (let i = 0; i < n; i++) {
    last = await callUpstream(action.tool, args);
    const t = resultText(last);
    if (looksLikeTree(t)) state.lastTree = t;
    if (isSoftError(last)) return { result: last, error: t.slice(0, 200) };
    if (n > 1 && i < n - 1) await sleep(KEY_DELAY_MS);
  }
  return { result: last, note: target.line ? `→ [${target.index}] ${target.line.slice(0, 60)}` : undefined };
}

async function runBatch(app, actions, { finalState = true } = {}) {
  const state = { lastTree: null };
  const log = [];
  let last = null;
  for (const [i, a] of (actions || []).entries()) {
    const label = `${i + 1}. ${a.tool}${a.repeat > 1 ? `×${a.repeat}` : ""}${a.find ? ` find="${a.find}"` : ""}`;
    try {
      const r = await runAction(app, a, state);
      if (r.result) last = r.result;
      if (r.error) { log.push(`${label} HATA: ${r.error}`); break; }
      log.push(`${label} ok${r.note ? ` ${r.note}` : ""}`);
    } catch (e) { log.push(`${label} HATA: ${e.message}`); break; }
  }
  if (finalState && app) {
    const st = await callUpstream("get_app_state", { app });
    if (!isSoftError(st) || !last) last = st;
  }
  return { last, log };
}

// ---------- araç çağrısı ----------
async function callTool(name, rawArgs) {
  await ensureUpstream();
  const args = { ...(rawArgs || {}) };
  const wantShot = args.include_screenshot ?? DEFAULT_SCREENSHOT;
  delete args.include_screenshot;

  if (name === "batch") {
    const { last, log } = await runBatch(args.app, args.actions, { finalState: args.final_state !== false });
    const out = await finish(last || { content: [] }, wantShot);
    return { ...out, content: [{ type: "text", text: `batch:\n${log.join("\n")}` }, ...(out.content || [])] };
  }

  if (name === "menu") {
    // Codex'in menü ağacı iç içe alt menüleri tek seferde verir; hedef görünür olur olmaz doğrudan tıkla,
    // ara öğeleri yalnızca hedef henüz görünmüyorsa aç.
    const state = { lastTree: null };
    const log = [];
    let last = null;
    const path = args.path;
    const target = path[path.length - 1];
    const click = async (q) => {
      const r = await runAction(args.app, { tool: "click", find: q }, state);
      if (r.result) last = r.result;
      if (r.error) { log.push(`click "${q}" HATA: ${r.error}`); return false; }
      log.push(`click "${q}" ok ${r.note || ""}`); return true;
    };
    for (let i = 0; i < path.length; i++) {
      if (i > 0 && state.lastTree && findInTree(state.lastTree, target).hit) { if (!(await click(target))) break; log.push(`(ara adımlar atlandı: hedef görünürdü)`); break; }
      if (!(await click(path[i]))) break;
    }
    const out = await finish(last || { content: [] }, wantShot);
    return { ...out, content: [{ type: "text", text: `menu ${path.join(" > ")}:\n${log.join("\n")}` }, ...(out.content || [])] };
  }

  if (name === "find_elements") {
    const st = await callUpstream("get_app_state", { app: args.app });
    const t = resultText(st);
    if (isSoftError(st)) return st;
    const res = findInTree(t, args.query, { role: args.role });
    const rows = res.candidates.slice(0, args.limit ?? 20);
    const win = t.match(/Window: "([^"]*)"/)?.[1];
    return { content: [{ type: "text", text: `Window: "${win ?? "?"}" — '${args.query}' için ${rows.length} eşleşme:\n${rows.map((c) => `${c.index} ${c.rest}`).join("\n") || "(yok)"}` }] };
  }

  if (name === "open_path_in_dialog") {
    const app = args.app;
    const state = { lastTree: null };
    await callUpstream("press_key", { app, key: "super+shift+g" });
    const w = await waitFor(app, { text: "PathTextField", timeout_ms: 3000 }, state);
    if (!w.ok) return { content: [{ type: "text", text: "Go to Folder alanı açılmadı; bir Aç/Kaydet paneli açık mı?" }], isError: true };
    const m = state.lastTree.match(/^\s*(\d+) text field .*PathTextField/m);
    await callUpstream("set_value", { app, element_index: m[1], value: args.path });
    await sleep(150);
    await callUpstream("press_key", { app, key: "Return" });
    // Yola gidildi mi: Go To sheet kapanmalı ve dosya adı listede seçili görünmeli.
    const base = args.path.replace(/\/+$/, "").split("/").pop();
    await waitFor(app, { text: "PathTextField", timeout_ms: 3000, absent: true }, state);
    const sel = await waitFor(app, { text: `Value: ${base}`, timeout_ms: 3000 }, state);
    const log = [`go-to: ${sel.ok ? `'${base}' listede` : `'${base}' listede görünmedi`}`];
    let last = sel.result;
    if (args.confirm !== false && sel.ok) {
      // Panelin varsayılan düğmesi (Insert/Open/Save, ID: OKButton) — kör Return yerine ağaçtan bul.
      const ok = findInTree(state.lastTree, "/\\bOKButton\\b/", {}).hit || findInTree(state.lastTree, "/^button (Insert|Open|Save|Choose)\\b/", {}).hit;
      if (ok && !/\(disabled\)/.test(ok.rest)) {
        last = await callUpstream("click", { app, element_index: ok.index });
        log.push(`confirm: [${ok.index}] ${ok.rest.slice(0, 40)}`);
        await waitFor(app, { text: "open-panel", timeout_ms: 3000, absent: true }, state);
      } else {
        last = await callUpstream("press_key", { app, key: "Return" });
        log.push("confirm: Return (düğme bulunamadı)");
      }
      await sleep(300);
    }
    last = await callUpstream("get_app_state", { app });
    const out = await finish(last, wantShot);
    return { ...out, content: [{ type: "text", text: `open_path_in_dialog:\n${log.join("\n")}` }, ...(out.content || [])] };
  }

  if (TARGETABLE.has(name) && args.find) {
    const { last, log } = await runBatch(args.app, [{ tool: name, args: { ...args, find: undefined, role: undefined, nth: undefined }, find: args.find, role: args.role, nth: args.nth }], { finalState: false });
    const out = await finish(last || { content: [] }, wantShot);
    return { ...out, content: [{ type: "text", text: log.join("\n") }, ...(out.content || [])] };
  }
  delete args.find; delete args.role; delete args.nth;

  if (name === "press_key" && args.repeat) {
    const { last, log } = await runBatch(args.app, [{ tool: "press_key", args: { app: args.app, key: args.key }, repeat: args.repeat }], { finalState: false });
    const out = await finish(last || { content: [] }, wantShot);
    return { ...out, content: [{ type: "text", text: log.join("\n") }, ...(out.content || [])] };
  }
  delete args.repeat;

  const r = await callUpstream(name, args);
  if (name === "list_apps") return r;
  return finish(r, wantShot);
}

// ---------- alt akış (Claude Code) ----------
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
createInterface({ input: process.stdin }).on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // bildirimler
  try {
    let result;
    switch (m.method) {
      case "initialize":
        result = { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-cua-plus", version: VERSION } };
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
