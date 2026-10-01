#!/usr/bin/env node
// codex-cua-plus: claude-codex-computer-use köprüsünün önünde çalışan sarmalayıcı MCP sunucusu.
// Üst akış araçlarını aynen geçirir; üstüne batch, metinle hedefleme (find), wait_for, menu,
// find_elements, tekrarlı press_key, open_path_in_dialog, isteğe bağlı/küçültülmüş ekran görüntüsü
// ve ChatGPT.app'i otomatik açma ekler. Bağımlılık yok, yalnızca Node >= 22.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const MACRO_DIR = process.env.CUA_PLUS_MACRO_DIR || join(homedir(), ".codex-cua-plus");
const MACRO_FILE = join(MACRO_DIR, "macros.json");

const NPX = process.env.CUA_PLUS_NPX || "npx";
const BRIDGE_ARGS = ["-y", "claude-codex-computer-use@latest"];
const DEFAULT_SCREENSHOT = (process.env.CUA_PLUS_DEFAULT_SCREENSHOT ?? "false") === "true";
const KEY_DELAY_MS = Number(process.env.CUA_PLUS_KEY_DELAY_MS ?? 40);
const CODEX_APP_NAME = process.env.CUA_PLUS_APP_NAME || "ChatGPT"; // Codex uygulamasının macOS adı
const SCREENSHOT_MAX_PX = Number(process.env.CUA_PLUS_SCREENSHOT_MAX_PX ?? 1280); // 0 = küçültme
const VERSION = "0.7.0";

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
// Ağacın kökü bir menü mü? (menü çubuğu öğesi açık: "0 Insert, Secondary Actions: Cancel, Pick" + "1 menu")
function treeRootIsMenu(text) { return /^\s*0 [^\n]*Secondary Actions: Cancel, Pick/m.test(text || "") || /^\s*0 [^\n]*\n\s*1 menu\b/m.test(text || ""); }
function windowLine(text) { return (text || "").match(/^Window: .*$/m)?.[0] || ""; }
// İki ağaç arasındaki satır farkı (indeksler değişebileceği için indeks hariç karşılaştırılır).
function treeDiff(before, after) {
  const norm = (t) => parseTree(t || "").map((r) => r.rest);
  const a = norm(before), b = norm(after);
  const countA = new Map(), countB = new Map();
  for (const x of a) countA.set(x, (countA.get(x) || 0) + 1);
  for (const x of b) countB.set(x, (countB.get(x) || 0) + 1);
  const removed = [], added = [];
  for (const [x, n] of countA) { const d = n - (countB.get(x) || 0); for (let i = 0; i < d; i++) removed.push(x); }
  for (const r of parseTree(after || "")) { const d = (countB.get(r.rest) || 0) - (countA.get(r.rest) || 0); if (d > 0) { added.push(`${r.index} ${r.rest}`); countB.set(r.rest, (countB.get(r.rest) || 0) - 1); } }
  return { added, removed };
}
// Diff'te gürültü sayılan satırlar: kaydırma çubukları, ok/sayfa düğmeleri, ayırıcılar, başlıksız image/text/cell/container.
const NOISE_RE = /^(scroll bar\b|value indicator\b|increment (arrow|page) button|decrement (arrow|page) button|splitter\b|image$|text$|cell$|container$|section\b|collection$|group$|split group\b|scroll area\b|toolbar$|menu bar$|handle Description:|ruler( marker)?\b)/;
function diffText(before, after, { compact = true } = {}) {
  let { added, removed } = treeDiff(before, after);
  let hidden = 0;
  if (compact) {
    const keep = (l) => !NOISE_RE.test(l.replace(/^\d+ /, ""));
    const a2 = added.filter(keep), r2 = removed.filter(keep);
    hidden = (added.length - a2.length) + (removed.length - r2.length);
    added = a2; removed = r2;
  }
  const focus = (after || "").match(/^The focused UI element is .*$/m)?.[0] || "";
  return [windowLine(after), `+${added.length} satır, -${removed.length} satır${hidden ? ` (${hidden} gürültü satırı gizlendi; compact:false ile göster)` : ""}`,
    ...added.slice(0, 60).map((l) => `+ ${l}`), ...removed.slice(0, 30).map((l) => `- ${l}`),
    added.length > 60 || removed.length > 30 ? "(kısaltıldı; tam ağaç için output:\"full\")" : "", focus].filter(Boolean).join("\n");
}

// ---------- uygulama notları ----------
// Bilinen tuzaklar; sonuçlara "Notlar" olarak iliştirilir. Kullanıcı ~/.codex-cua-plus/notes.json ile ekler/ezer.
const NOTES_FILE = join(MACRO_DIR, "notes.json");
const BUILTIN_NOTES = {
  "freeform": [
    "Tuval öğesine (image/layout item) find ile tıklamak AXPress gönderir → Quick Look açılır, öğe seçilmez. Seçmek için koordinatla tıkla (click x,y).",
    "drag ve tutamaçlara set_value şekilleri taşımaz/boyutlandırmaz (sentetik sürükleme yoksayılır). Resimleri dosya olarak ekle (Insert > Choose File).",
    "Pano içinde Escape 'All Boards' görünümüne döndürebilir. Menü çubuğu 'Insert' öğesi tam eşleşmeyle bulunur; alt menü öğeleri (Shape > Triangle) aynı ağaçta görünür.",
    "Quick Look açıksa Escape kapatmayabilir; 'close panel button' öğesine tıkla.",
    "Öğe taşıma: drag çalışmaz ama seçili öğe klavyeyle taşınır — press_key 'shift+Right'/'shift+Down' repeat ile (10 pt/adım; Codex 30×shift+Right kullandı). Sticky Note: Insert > Sticky Note sonra type_text; Text Box: Insert > Text Box sonra type_text; Escape düzenlemeyi bitirir.",
  ],
  "textedit": [
    "Belge gövdesi 'text entry area (settable) First Text View'; type_text find=\"First Text View\" ile yaz. Yeni belge RTF'tir: .txt istersen yazmadan önce super+shift+t (Make Plain Text), yoksa ada .rtf eklenir.",
    "Save panelinde ad alanı 'text field (settable) … ID: saveAsNameTextField'; 'Save As:' ayrı bir etiket. Klasöre super+shift+g ile git. Kaydedince pencere başlığı dosya adı olur; wait_for'da kapanış tırnağı kullanma (Window: \"ad).",
    "Açılışta belge yoksa Open paneli gelir: 'New Document' düğmesine tıkla.",
  ],
};
function notesFor(app) {
  if (!app) return [];
  let user = {}; try { user = JSON.parse(readFileSync(NOTES_FILE, "utf8")); } catch {}
  const key = Object.keys({ ...BUILTIN_NOTES, ...user }).find((k) => String(app).toLowerCase().includes(k.toLowerCase()));
  if (!key) return [];
  return [...(BUILTIN_NOTES[key] || []), ...((user[key] || []))];
}
const notesShown = new Set(); // aynı oturumda aynı uygulama için notları bir kez göster
function withNotes(result, app) {
  const n = notesFor(app);
  if (!n.length || notesShown.has(app) || !result?.content) return result;
  notesShown.add(app);
  return { ...result, content: [...result.content, { type: "text", text: `Notlar (${app}):\n${n.map((x) => `- ${x}`).join("\n")}` }] };
}

// ---------- makrolar ----------
function loadMacros() { try { return JSON.parse(readFileSync(MACRO_FILE, "utf8")); } catch { return {}; } }
function saveMacros(m) { mkdirSync(MACRO_DIR, { recursive: true }); writeFileSync(MACRO_FILE, JSON.stringify(m, null, 2)); }
function substitute(value, params) {
  if (typeof value === "string") return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{{${k}}}`));
  if (Array.isArray(value)) return value.map((v) => substitute(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, params)]));
  return value;
}
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

// ---------- servis hata kodları (Codex'in IPC kodları; anlamlı mesaj + ne yapmalı) ----------
const SERVICE_ERRORS = {
  "-10000": ["senderProcessNotAuthenticated", "İstemci imzalı başlatıcı olmadan açılmış; köprü/sarmalayıcı üzerinden kaydet."],
  "-10005": ["unknownError / app-server exited", "ChatGPT.app veya codex app-server kapalı; sarmalayıcı uygulamayı açmayı dener."],
  "-10006": ["appNotAllowed", "Uygulama kuruluş politikasıyla engelli; başka uygulama seç."],
  "-10007": ["runningApplicationNotFound", "Uygulama bulunamadı; list_apps ile adı/bundle id'yi doğrula."],
  "-10008": ["accessibilityError", "Erişilebilirlik ağacı okunamadı; pencereyi öne getir veya koordinatla devam et."],
  "-10009": ["permissionsNotGranted", "macOS Erişilebilirlik/Ekran Kaydı izni yok; Sistem Ayarları > Gizlilik'ten ver."],
  "-10010": ["invalidApp", "Geçersiz uygulama tanımı."],
  "-10011": ["noActiveSession", "Oturum yok; get_app_state ile yeniden başlat."],
  "-10012": ["userStoppedSession", "Kullanıcı Esc ile Computer Use'u durdurdu; döngüyü bitir, kullanıcı isteyince devam et."],
  "-10013": ["incompatibleClientVersion", "İstemci/servis sürümleri uyumsuz; ChatGPT.app'i güncelle."],
  "-10014": ["permissionsPending", "İzin isteği bekliyor; kullanıcı onaylasın."],
  "-10015": ["blockedURL", "URL engelli."],
  "-10016": ["userIntervened", "Kullanıcı araya girdi (fare/klavye); durumu yeniden oku, sonra devam et."],
  "-10018": ["ambiguousApp", "Birden çok uygulama eşleşti; bundle id kullan (list_apps)."],
  "-10020": ["screenLocked", "Ekran kilitli; kilidi aç."],
};
function annotateServiceError(result) {
  const t = resultText(result);
  const m = t.match(/server error (-\d{5})/);
  if (!m || !SERVICE_ERRORS[m[1]]) return result;
  const [name, hint] = SERVICE_ERRORS[m[1]];
  return { ...result, isError: true, content: [...(result.content || []), { type: "text", text: `[${name}] ${hint}` }] };
}
const STOP_CODES = /server error -1001[26]\b/; // kullanıcı durdurdu / araya girdi → döngüleri kes

// ---------- servis/uygulama sağlığı ----------
// -10005 "unknownError" genel koddur: yalnızca app-server kapalıyken uygulamayı aç; "timeoutReached" gibi alt türlerde açma.
const SERVICE_DOWN = /app-server exited|Sender process is not authenticated|-10005(?!: ?timeout)/;
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
// Uygulama başına son tam ağaç: find çözümü ve diff çıktısı için (çağrılar arasında kalıcı).
const treeCache = new Map();
function cacheTree(app, result) { const t = resultText(result); if (app && looksLikeTree(t)) treeCache.set(String(app).toLowerCase(), t); }
function cachedTree(app) { return app ? treeCache.get(String(app).toLowerCase()) || null : null; }
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
  cacheTree(args?.app, r);
  return annotateServiceError(r);
}
// Codex'in varsayılan diff davranışının bizim karşılığı: önceki önbellek ağacına göre fark; değişiklik yoksa tek satır.
const DEFAULT_OUTPUT = process.env.CUA_PLUS_DEFAULT_OUTPUT || "diff";
function renderResult(result, before, output) {
  const after = resultText(result);
  if (output !== "diff" || !before || !looksLikeTree(after)) return result;
  const texts = result.content.filter((c) => c.type === "text");
  const others = result.content.filter((c) => c.type !== "text");
  const extra = texts.slice(1).map((c) => c.text); // sarmalayıcının eklediği notlar vb.
  const { added, removed } = treeDiff(before, after);
  const focus = after.match(/^The focused UI element is .*$/m)?.[0] || "";
  let body;
  if (!added.length && !removed.length) body = `${windowLine(after)}\n(ağaçta değişiklik yok; tam ağaç için output:"full")\n${focus}`;
  else body = diffText(before, after);
  return { ...result, content: [{ type: "text", text: `[diff]\n${body}` }, ...extra.map((t) => ({ type: "text", text: t })), ...others] };
}

// ---------- araç tanımları ----------
const FIND_DESC = "Target by text instead of element_index: role/title on the tree line (e.g. 'Choose File', 'button New Board'); /regex/ allowed. Exact match > word match > substring. Resolved against the last known tree; if not found, a fresh get_app_state is taken and tried once more.";
const ACTION_SCHEMA = {
  type: "object",
  description: "One action. 'tool' is an upstream tool or wait_for/sleep_ms/open_path_in_dialog/recover. Target: args.element_index OR find.",
  properties: {
    tool: { type: "string", enum: ["click", "set_value", "type_text", "press_key", "scroll", "drag", "select_text", "perform_secondary_action", "get_app_state", "wait_for", "sleep_ms", "open_path_in_dialog", "recover"] },
    args: { type: "object", description: "Upstream arguments (app defaults to batch.app). wait_for: {text, timeout_ms=4000, absent=false}. sleep_ms: {ms}. open_path_in_dialog: {path, confirm=true}. recover: {}." },
    find: { type: "string", description: FIND_DESC },
    role: { type: "string", description: "With find: the line must start with this role (e.g. 'button', 'menu item', 'text field')." },
    nth: { type: "integer", minimum: 0, description: "If find matches several lines, which one (0 = first)." },
    repeat: { type: "integer", minimum: 1, maximum: 200, description: "Repeat this action N times (e.g. arrow keys)." },
    if_present: { type: "string", description: "Run only if this text is in the last tree (otherwise the step is skipped)." },
    if_absent: { type: "string", description: "Run only if this text is NOT in the last tree." },
    optional: { type: "boolean", description: "On error, skip this step instead of stopping the batch." },
  },
  required: ["tool"],
};
const EXTRA_TOOLS = [
  {
    name: "batch",
    description: "Run several Computer Use actions in one call; only the final state is returned. Actions can be targeted by text with 'find' (indices are resolved from the fresh tree at each step). wait_for waits for panels/windows. On error the batch stops and returns the log so far.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Default target app." },
        actions: { type: "array", items: ACTION_SCHEMA, minItems: 1 },
        include_screenshot: { type: "boolean", description: `Attach a screenshot of the final state (default ${DEFAULT_SCREENSHOT}).` },
        final_state: { type: "boolean", description: "Call get_app_state at the end (default true)." },
        output: { type: "string", enum: ["full", "diff"], description: "full: the whole final tree (default). diff: window line + lines added/removed since the batch started; much smaller." },
        compact: { type: "boolean", description: "In diff mode hide noise lines (scroll bars, arrow buttons, handles, untitled image/text) (default true)." },
        dry_run: { type: "boolean", description: "Do nothing; show which index each find target would resolve to in the current tree." },
        params: { type: "object", description: "Fill {{name}} placeholders in the actions with these values (with save_as the template is stored raw)." },
        save_as: { type: "string", description: "If the batch succeeds, save the action list as a macro under this name ({{param}} placeholders are extracted automatically)." },
        save_description: { type: "string" },
        screenshot_on_error: { type: "boolean", description: "Attach a downscaled screenshot when a step fails (default true)." },
        auto_recover: { type: "boolean", description: "If the tree root is a stuck menu and find misses there, try to close the menu first (default true)." },
      },
      required: ["actions"],
    },
  },
  {
    name: "script",
    description: `Persistent JavaScript environment modelled on Codex's cua_repl: code runs locally, no model round trip per click. Variables and functions survive between calls. API:
  const app = await cua.getApp("Freeform");          // app object (cua.listApps() lists apps)
  await app.click(31) / app.click([x,y]) / app.click({find:"Choose File"});
  await app.pressKey("Return"); await app.typeText("..."); await app.setValue(idx|{find}, "..."); await app.scroll(idx,"down",1); await app.drag([x1,y1],[x2,y2]); await app.secondary(idx,"Cancel");
  const ax = await app.getAXState();                 // tree text (NOT sent to the model; kept in a variable)
  app.find(ax, "Draw with Pen") → index | null;  app.findAll(ax, /regex/) → [[idx, line]...]
  app.value(ax, "Zoom") → "Value: ..." of a line; app.text(ax, /Window: "([^"]+)"/) → first group; app.lastTextUnder(ax, "Edit field") → last text row under a container (e.g. Calculator result)
  await app.waitFor("Window: \\"Open\\"", {timeout:4000, absent:false});
  await app.nudge("right", 30);                      // move the selected item with shift+arrow (apps that ignore drag)
  await app.menu(["Insert","Shape","Triangle"]);     // menu-bar path; skips intermediate items when the target is visible
  await app.openPath("/full/path");                  // ⌘⇧G in an open Open/Save panel, wait for selection, confirm
  await sleep(ms); log("...")                        // log lines are returned
Result: log + (final_state) diff/full of the final tree + optional screenshot. Example (polyline with the pen tool): for (const p of pts) await app.click(p); await app.pressKey("Return"); await app.pressKey("Escape");`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript to run (top-level await allowed)." },
        app: { type: "string", description: "App for final_state (automatic when cua.getApp was used)." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 600000, description: "Default 120000." },
        output: { type: "string", enum: ["full", "diff", "none"], description: "Final state: diff (default), full or none." },
        include_screenshot: { type: "boolean" },
        reset: { type: "boolean", description: "Reset the environment (drop previous variables)." },
      },
      required: ["code"],
    },
  },
  {
    name: "status",
    description: "Health/diagnostics: wrapper version, ChatGPT.app / app-server / service / client state, list_apps ping latency, saved macros and notes files.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description: "Screenshot of the app; optional region=[x0,y0,x1,y1] (original coordinates) crops and zooms to read small text. max_px sets the output size (0 = no downscale). Complements coordinate clicks when the tree is not enough.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }, max_px: { type: "integer", minimum: 0 } },
      required: ["app"],
    },
  },
  {
    name: "recover",
    description: "Recover from a stuck/open menu: Escape → the menu's Cancel action → coordinate click on the title bar; after each step checks whether the tree root is still a menu. Returns a log.",
    inputSchema: { type: "object", properties: { app: { type: "string" }, include_screenshot: { type: "boolean" } }, required: ["app"] },
  },
  {
    name: "save_macro",
    description: `Save a batch action list under a name (${MACRO_FILE}). {{param}} placeholders in strings are filled by run_macro. Same name overwrites.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }, description: { type: "string" },
        app: { type: "string", description: "Default app (can be overridden in run_macro)." },
        actions: { type: "array", items: ACTION_SCHEMA, minItems: 1 },
        params: { type: "array", items: { type: "string" }, description: "Expected parameter names (documentation)." },
      },
      required: ["name", "actions"],
    },
  },
  {
    name: "run_macro",
    description: "Run a saved macro with parameters (like batch; only the final state is returned).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" }, params: { type: "object", description: "{{param}} values." },
        app: { type: "string" }, include_screenshot: { type: "boolean" }, output: { type: "string", enum: ["full", "diff"] }, final_state: { type: "boolean" },
        compact: { type: "boolean" }, screenshot_on_error: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_macros",
    description: "List saved macros (name, description, parameters, step count).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "menu",
    description: "Click a menu-bar path: path=['Insert','Shape','Triangle']. Each step is found by text in the fresh tree. Optional screenshot at the end.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, path: { type: "array", items: { type: "string" }, minItems: 1 }, include_screenshot: { type: "boolean" } },
      required: ["app", "path"],
    },
  },
  {
    name: "find_elements",
    description: "Return only the tree lines matching the query (index + role/title) without the whole tree. Takes a fresh get_app_state.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, query: { type: "string", description: "Substring or /regex/." }, role: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      required: ["app", "query"],
    },
  },
  {
    name: "open_path_in_dialog",
    description: "In an open macOS Open/Save panel: ⌘⇧G opens 'Go to Folder', types the path, Return navigates to the file/folder. With confirm=true waits for the item to be selected, then triggers the panel's default button (Open/Insert/Save) — Return first, button click as fallback.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        path: { type: "string", description: "Full file or folder path." },
        confirm: { type: "boolean", description: "Press the default button after navigating (default true)." },
        include_screenshot: { type: "boolean" },
      },
      required: ["app", "path"],
    },
  },
];

const TARGETABLE = new Set(["click", "set_value", "scroll", "select_text", "perform_secondary_action", "type_text"]);
// type_text'te find: önce öğeye tıklayıp odaklanır, sonra yazar (element_index parametresi yok).
const FOCUS_THEN_ACT = new Set(["type_text"]);
async function listTools() {
  await ensureUpstream();
  const r = await upRequest("tools/list", {});
  const tools = (r.tools || []).map((t) => {
    const schema = structuredClone(t.inputSchema || { type: "object", properties: {} });
    schema.properties ||= {};
    if (t.name !== "list_apps") {
      schema.properties.include_screenshot = { type: "boolean", description: `Return a screenshot (default ${DEFAULT_SCREENSHOT}). Leave off when the tree is enough; much faster. When on, it is downscaled to ${SCREENSHOT_MAX_PX || "full"} px.` };
      schema.properties.output = { type: "string", enum: ["diff", "full"], description: `diff (default ${DEFAULT_OUTPUT}): only lines changed since the last known tree for this app; full: the whole tree. The first call always returns full.` };
    }
    if (TARGETABLE.has(t.name)) {
      schema.properties.find = { type: "string", description: FIND_DESC };
      schema.properties.role = { type: "string", description: "With find: the line must start with this role." };
      schema.properties.nth = { type: "integer", minimum: 0 };
      if (schema.required) schema.required = schema.required.filter((k) => k !== "element_index");
    }
    if (t.name === "press_key") {
      schema.properties.repeat = { type: "integer", minimum: 1, maximum: 200, description: "Press the key N times (e.g. 15× shift+Down)." };
    }
    return { ...t, inputSchema: schema };
  });
  return { tools: [...tools, ...EXTRA_TOOLS] };
}

// ---------- eylem çalıştırma ----------
// lastTree: aynı çağrı içinde son görülen ağaç metni (find için). Her üst akış yanıtı ağaç içeriyorsa güncellenir.
// Takılı menüden kurtarma: her adımdan sonra kök hâlâ menü mü diye bakar.
async function recover(app, state) {
  const log = [];
  const check = async (label) => {
    const st = await callUpstream("get_app_state", { app });
    state.lastTree = resultText(st); state.lastResult = st;
    const stuck = treeRootIsMenu(state.lastTree);
    log.push(`${label}: ${stuck ? "kök hâlâ menü" : "kurtarıldı"}`);
    return !stuck;
  };
  if (await check("başlangıç")) return { ok: true, log };
  await callUpstream("press_key", { app, key: "Escape" });
  if (await check("Escape")) return { ok: true, log };
  const menuEl = parseTree(state.lastTree).find((r) => /^menu\b/.test(r.rest) && /Cancel/.test(r.rest)) || parseTree(state.lastTree)[0];
  if (menuEl) { await callUpstream("perform_secondary_action", { app, element_index: menuEl.index, action: "Cancel" }); if (await check(`Cancel [${menuEl.index}]`)) return { ok: true, log }; }
  // Son çare: pencere başlık çubuğunun ortasına tıkla (ekran görüntüsü boyutundan).
  const img = (state.lastResult?.content || []).find((c) => c.type === "image");
  if (img) {
    const dir = mkdtempSync(join(tmpdir(), "cua-plus-")); const f = join(dir, "s.jpg");
    try { writeFileSync(f, Buffer.from(img.data, "base64")); const sz = await imageSize(f); if (sz) { await callUpstream("click", { app, x: Math.round(sz.w / 2), y: 12 }); if (await check(`başlık çubuğu tıklaması (${Math.round(sz.w / 2)},12)`)) return { ok: true, log }; } }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return { ok: false, log };
}

async function resolveTarget(app, action, state) {
  if (!action.find) return { ok: true };
  let tree = state.lastTree && looksLikeTree(state.lastTree) ? state.lastTree : cachedTree(app);
  let res = tree ? findInTree(tree, action.find, { role: action.role, nth: action.nth }) : { hit: null, candidates: [] };
  if (!res.hit) {
    const st = await callUpstream("get_app_state", { app });
    state.lastTree = resultText(st);
    res = findInTree(state.lastTree, action.find, { role: action.role, nth: action.nth });
  }
  if (!res.hit && state.autoRecover !== false && treeRootIsMenu(state.lastTree)) {
    const rec = await recover(app, state);
    state.recoverLog = (state.recoverLog || []).concat(rec.log.map((l) => `recover: ${l}`));
    if (rec.ok) res = findInTree(state.lastTree, action.find, { role: action.role, nth: action.nth });
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
    const t = resultText(last); state.lastTree = t; state.lastResultObj = last;
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
  if (state.dryRun && !action.find) return { result: null, note: "(dry-run, hedef find değil)" };
  if (action.tool === "sleep_ms") { await sleep(Number(args.ms ?? 300)); return { result: { content: [{ type: "text", text: `slept ${args.ms ?? 300} ms` }] }, note: `${args.ms ?? 300} ms` }; }
  if (action.tool === "wait_for") {
    const w = await waitFor(app, args, state);
    return w.ok ? { result: w.result, note: `'${args.text}' ${args.absent ? "gitti" : "göründü"}` } : { result: w.result, error: w.error };
  }
  if (action.tool === "open_path_in_dialog") {
    const r = await openPathInDialog(app, args, state);
    return r.ok ? { result: r.last, note: r.log.join("; ") } : { result: r.last, error: r.log.join("; ") };
  }
  if (action.tool === "recover") {
    const r = await recover(app, state);
    return r.ok ? { result: state.lastResult, note: r.log.join("; ") } : { result: state.lastResult, error: r.log.join("; ") };
  }
  const target = await resolveTarget(app, action, state);
  if (!target.ok) return { result: null, error: target.error };
  if (state.dryRun) return { result: null, note: target.index !== undefined ? `→ [${target.index}] ${target.line.slice(0, 60)} (dry-run)` : "(dry-run)" };
  if (target.index !== undefined) {
    if (FOCUS_THEN_ACT.has(action.tool)) {
      const f = await callUpstream("click", { app, element_index: target.index });
      if (isSoftError(f)) return { result: f, error: `odaklama tıklaması: ${resultText(f).slice(0, 120)}` };
    } else args.element_index = target.index;
  }
  delete args.find; delete args.role; delete args.nth;
  const n = action.repeat ?? 1;
  let last;
  for (let i = 0; i < n; i++) {
    last = await callUpstream(action.tool, args);
    let t = resultText(last);
    // "The user changed <app>. Re-query…": durumu yeniden okuyup eylemi bir kez tekrarla (find varsa indeksi yeniden çöz).
    if (/Re-query the latest state/i.test(t)) {
      const st = await callUpstream("get_app_state", { app }); state.lastTree = resultText(st);
      if (action.find) { const tg = await resolveTarget(app, action, state); if (!tg.ok) return { result: st, error: tg.error }; if (tg.index !== undefined) args.element_index = tg.index; }
      last = await callUpstream(action.tool, args); t = resultText(last);
      state.requeried = (state.requeried || 0) + 1;
    }
    if (looksLikeTree(t)) state.lastTree = t;
    if (STOP_CODES.test(t)) return { result: last, error: "kullanıcı Computer Use'u durdurdu/araya girdi; batch kesildi — " + t.slice(0, 160) };
    if (isSoftError(last)) return { result: last, error: t.slice(0, 200) };
    if (n > 1 && i < n - 1) await sleep(KEY_DELAY_MS);
  }
  return { result: last, note: target.line ? `→ [${target.index}] ${target.line.slice(0, 60)}` : undefined };
}

async function runBatch(app, actions, { finalState = true, autoRecover = true, captureBefore = false, dryRun = false } = {}) {
  const state = { lastTree: null, autoRecover, dryRun };
  if (dryRun) { finalState = false; captureBefore = false; const st = await callUpstream("get_app_state", { app }); state.lastTree = resultText(st); }
  const log = [];
  let last = null, before = null;
  if (captureBefore && app) { const st = await callUpstream("get_app_state", { app }); before = resultText(st); state.lastTree = before; }
  const t0 = Date.now();
  let failed = false;
  for (const [i, a] of (actions || []).entries()) {
    const label = `${i + 1}. ${a.tool}${a.repeat > 1 ? `×${a.repeat}` : ""}${a.find ? ` find="${a.find}"` : ""}`;
    const ts = Date.now();
    try {
      // Koşul: if_present / if_absent son ağaca bakar (yoksa taze okur).
      if (a.if_present !== undefined || a.if_absent !== undefined) {
        if (!(state.lastTree && looksLikeTree(state.lastTree)) && app) { const st = await callUpstream("get_app_state", { app }); state.lastTree = resultText(st); }
        const tree = (state.lastTree || "").toLowerCase();
        const skip = (a.if_present !== undefined && !tree.includes(String(a.if_present).toLowerCase())) || (a.if_absent !== undefined && tree.includes(String(a.if_absent).toLowerCase()));
        if (skip) { log.push(`${label} atlandı (koşul: ${a.if_present !== undefined ? `'${a.if_present}' yok` : `'${a.if_absent}' var`})`); continue; }
      }
      const r = await runAction(app, a, state);
      if (state.recoverLog?.length) { log.push(...state.recoverLog); state.recoverLog = []; }
      if (r.result) last = r.result;
      const ms = `${Date.now() - ts} ms`;
      if (r.error) { if (a.optional) { log.push(`${label} atlandı (optional, ${ms}): ${r.error.slice(0, 120)}`); continue; } log.push(`${label} HATA (${ms}): ${r.error}`); failed = true; break; }
      log.push(`${label} ok (${ms})${r.note ? ` ${r.note}` : ""}`);
    } catch (e) { if (a.optional) { log.push(`${label} atlandı (optional): ${e.message}`); continue; } log.push(`${label} HATA (${Date.now() - ts} ms): ${e.message}`); failed = true; break; }
  }
  // Son eylem zaten tam ağaç döndürdüyse (click/press_key/wait_for sonucu) ekstra okuma yapma (~120 ms).
  const lastIsFresh = !failed && last && looksLikeTree(resultText(last)) && !isSoftError(last);
  if (finalState && app && !lastIsFresh) {
    const st = await callUpstream("get_app_state", { app });
    if (!isSoftError(st) || !last) last = st;
  }
  log.push(`toplam ${Date.now() - t0} ms${state.requeried ? `, ${state.requeried} re-query` : ""}${lastIsFresh && finalState ? " (son okuma atlandı)" : ""}`);
  return { last, log, before, failed };
}
// batch benzeri sonuçları ortak biçimde paketle (full / diff).
async function packBatch(title, { last, log, before, failed }, { wantShot, output, compact = true, app, shotOnError = true }) {
  const result = last || { content: [] };
  const shot = wantShot || (failed && shotOnError); // hata olduysa teşhis için görüntüyü ekle
  let out;
  if (output === "diff") {
    const after = resultText(result);
    const img = shot ? (await shrinkScreenshot(result)).content.filter((c) => c.type !== "text") : [];
    out = { content: [{ type: "text", text: `${title}:\n${log.join("\n")}\n\n[diff]\n${looksLikeTree(after) ? diffText(before, after, { compact }) : after.slice(0, 1500)}` }, ...img] };
  } else {
    const o = await finish(result, shot);
    out = { ...o, content: [{ type: "text", text: `${title}:\n${log.join("\n")}` }, ...(o.content || [])] };
  }
  if (failed) { out.isError = true; if (shotOnError && !wantShot) out.content.push({ type: "text", text: "(hata nedeniyle ekran görüntüsü eklendi)" }); }
  return withNotes(out, app);
}

// Aç/Kaydet panelinde ⌘⇧G ile yola gider, dosya seçimini bekler, OK düğmesini ağaçtan tıklar.
async function openPathInDialog(app, args, state) {
  const log = [];
  await callUpstream("press_key", { app, key: "super+shift+g" });
  const w = await waitFor(app, { text: "PathTextField", timeout_ms: 3000 }, state);
  if (!w.ok) return { ok: false, last: w.result, log: ["Go to Folder alanı açılmadı; bir Aç/Kaydet paneli açık mı?"] };
  const m = state.lastTree.match(/^\s*(\d+) text field .*PathTextField/m);
  await callUpstream("set_value", { app, element_index: m[1], value: args.path });
  await sleep(60);
  await callUpstream("press_key", { app, key: "Return" });
  const base = String(args.path).replace(/\/+$/, "").split("/").pop();
  await waitFor(app, { text: "PathTextField", timeout_ms: 3000, absent: true }, state);
  const sel = await waitFor(app, { text: `Value: ${base}`, timeout_ms: 3000 }, state);
  log.push(`go-to: ${sel.ok ? `'${base}' listede` : `'${base}' listede görünmedi`}`);
  let last = sel.result;
  if (args.confirm !== false && sel.ok) {
    // Seçim doğrulandı; Return (~0,5 s) tıklamadan (~1 s) hızlı. Panel kapanmazsa OK düğmesine tıkla.
    const ok = findInTree(state.lastTree, "/\\bOKButton\\b/", {}).hit || findInTree(state.lastTree, "/^button (Insert|Open|Save|Choose)\\b/", {}).hit;
    if (ok && /\(disabled\)/.test(ok.rest)) { log.push(`confirm: [${ok.index}] düğme pasif`); }
    else {
      last = await callUpstream("press_key", { app, key: "Return" });
      let closed = await waitFor(app, { text: "open-panel", timeout_ms: 1500, absent: true }, state);
      if (closed.ok) log.push("confirm: Return");
      else if (ok) { last = await callUpstream("click", { app, element_index: ok.index }); closed = await waitFor(app, { text: "open-panel", timeout_ms: 3000, absent: true }, state); log.push(`confirm: Return kapatmadı → click [${ok.index}] ${ok.rest.slice(0, 30)}`); }
      if (!closed.ok) log.push("uyarı: panel hâlâ açık görünüyor");
    }
  }
  if (!(state.lastTree && looksLikeTree(state.lastTree))) { last = await callUpstream("get_app_state", { app }); state.lastTree = resultText(last); }
  else last = state.lastResultObj || last;
  return { ok: sel.ok, last, log };
}

// ---------- script ortamı (cua_repl benzeri) ----------
let scriptCtx = null;
function makeApp(appName, state) {
  const call = async (tool, args) => {
    const r = await callUpstream(tool, { app: appName, ...args });
    const t = resultText(r);
    if (looksLikeTree(t)) state.lastTree = t;
    state.last = r;
    if (/Re-query the latest state/i.test(t)) { const st = await callUpstream("get_app_state", { app: appName }); state.lastTree = resultText(st); return call(tool, args); }
    if (r.isError || /server error/i.test(t.slice(0, 120))) { const e = new Error(t.slice(0, 300)); e.stop = STOP_CODES.test(t); throw e; }
    state.actions = (state.actions || 0) + 1;
    return t;
  };
  const resolve = async (target) => {
    if (target && typeof target === "object" && !Array.isArray(target) && target.find) {
      let tree = state.lastTree || cachedTree(appName); let hit = tree && findInTree(tree, target.find, { role: target.role, nth: target.nth }).hit;
      if (!hit) { tree = await call("get_app_state", {}); hit = findInTree(tree, target.find, { role: target.role, nth: target.nth }).hit; }
      if (!hit) throw new Error(`'${target.find}' ağaçta bulunamadı`);
      return { element_index: hit.index };
    }
    if (Array.isArray(target)) return { x: target[0], y: target[1] };
    return { element_index: String(target) };
  };
  return {
    name: appName,
    click: async (target, opts = {}) => call("click", { ...(await resolve(target)), ...opts }),
    pressKey: (key) => call("press_key", { key }),
    typeText: (text) => call("type_text", { text }),
    setValue: async (target, value) => call("set_value", { ...(await resolve(target)), value }),
    scroll: async (target, direction, pages = 1) => call("scroll", { ...(await resolve(target)), direction, pages }),
    drag: (a, b) => call("drag", { from_x: a[0], from_y: a[1], to_x: b[0], to_y: b[1] }),
    secondary: async (target, action) => call("perform_secondary_action", { ...(await resolve(target)), action }),
    selectText: async (target, text, extra = {}) => call("select_text", { ...(await resolve(target)), text, ...extra }),
    getAXState: () => call("get_app_state", {}),
    getAXStateAndScreenshot: async () => { await call("get_app_state", {}); state.wantShotAtEnd = true; return state.lastTree; },
    find: (tree, query, opts = {}) => { const h = findInTree(tree, query, opts).hit; return h ? Number(h.index) : null; },
    findAll: (tree, query, opts = {}) => findInTree(tree, query, opts).candidates.map((c) => [Number(c.index), c.rest]),
    waitFor: async (text, { timeout = 4000, absent = false } = {}) => { const w = await waitFor(appName, { text, timeout_ms: timeout, absent }, state); if (!w.ok) throw new Error(w.error); return state.lastTree; },
    // --- bileşik yardımcılar (Codex görev gözlemlerinden) ---
    // Seçili öğeyi klavyeyle taşı: Freeform gibi drag'i yoksayan uygulamalarda shift+ok 10 pt/adım.
    nudge: async (direction, n = 1, { shift = true } = {}) => { const key = `${shift ? "shift+" : ""}${{ up: "Up", down: "Down", left: "Left", right: "Right" }[direction] || direction}`; for (let i = 0; i < n; i++) await call("press_key", { key }); return state.lastTree; },
    // Menü çubuğu yolu: hedef görünürse ara adımları atla.
    menu: async (path) => { const target = path[path.length - 1]; for (let i = 0; i < path.length; i++) { const tree = state.lastTree || cachedTree(appName) || (await call("get_app_state", {})); const hitT = i > 0 && findInTree(tree, target).hit; const q = hitT ? target : path[i]; const hit = findInTree(tree, q).hit || findInTree(await call("get_app_state", {}), q).hit; if (!hit) throw new Error(`menu: '${q}' bulunamadı`); await call("click", { element_index: hit.index }); if (hitT || q === target) break; } return state.lastTree; },
    // Açık Aç/Kaydet panelinde yola git ve onayla.
    openPath: async (path, { confirm = true } = {}) => { const r = await openPathInDialog(appName, { path, confirm }, state); if (!r.ok) throw new Error(r.log.join("; ")); state.actions = (state.actions || 0) + 4; return state.lastTree; },
    // Ağaç satırından "Value: ..." ya da başlığı oku (Calculator sonucu, alan değeri vb.).
    value: (tree, query, opts = {}) => { const h = findInTree(tree, query, opts).hit; if (!h) return null; const rest = h.rest.replace(/[‎‏‪-‮]/g, ""); const m = rest.match(/Value: (.*?)(?:, (?:ID|Secondary Actions|Help|Description):|$)/); return (m ? m[1] : rest.replace(/^\w[\w ]*? /, "")).trim(); },
    // Ağaçta regex ile metin yakala (ilk grup); görünmez yön işaretleri temizlenir.
    text: (tree, re) => { const m = tree.replace(/[‎‏‪-‮]/g, "").match(re); return m ? (m[1] ?? m[0]) : null; },
    // Bir kapsayıcının (ör. "Last Expression") altındaki son metin satırını oku — Calculator sonucu gibi.
    lastTextUnder: (tree, query) => { const clean = tree.replace(/[‎‏‪-‮]/g, ""); const rows = parseTree(clean); const i = rows.findIndex((r) => findInTree(`${r.index} ${r.rest}`, query).hit); if (i < 0) return null; const base = (clean.split("\n").find((l) => l.trim().startsWith(rows[i].index + " ")) || "").search(/\S/); let last = null; for (const l of clean.split("\n").slice(clean.split("\n").findIndex((l) => l.trim().startsWith(rows[i].index + " ")) + 1)) { const ind = l.search(/\S/); if (ind <= base) break; const m = l.match(/^\s*\d+ text (.+)$/); if (m) last = m[1].trim(); } return last; },
  };
}
async function runScript(args) {
  const state = { lastTree: null, last: null, apps: new Set(), logs: [], wantShotAtEnd: false };
  if (args.reset || !scriptCtx) {
    scriptCtx = vm.createContext({ console: { log: (...a) => state.logs.push(a.map(String).join(" ")) }, Math, JSON, Array, Object, String, Number, RegExp, Set, Map, Promise, Date, Error, setTimeout, clearTimeout });
  }
  // her çağrıda taze bağlar: state değişir
  scriptCtx.cua = {
    getApp: async (name) => { state.apps.add(name); const app = makeApp(name, state); state.lastTree = await app.getAXState(); if (!state.firstTree) state.firstTree = state.lastTree; return app; },
    listApps: async () => resultText(await callUpstream("list_apps", {})),
  };
  scriptCtx.sleep = sleep;
  scriptCtx.log = (...a) => state.logs.push(a.map(String).join(" "));
  scriptCtx.__state = state;
  const t0 = Date.now();
  let error = null;
  try {
    const fn = vm.runInContext(`(async () => { ${args.code}\n })`, scriptCtx, { timeout: 5000 }); // derleme
    await Promise.race([fn(), sleep(args.timeout_ms ?? 120000).then(() => { throw new Error(`script zaman aşımı (${args.timeout_ms ?? 120000} ms)`); })]);
  } catch (e) { error = e?.message || String(e); }
  const appName = args.app || [...state.apps][0];
  const header = [`script: ${error ? "HATA: " + error : "ok"} (${Date.now() - t0} ms, ${state.actions || 0} eylem)`, ...state.logs.map((l) => `  ${l}`)].join("\n");
  const output = args.output || "diff";
  const wantShot = args.include_screenshot || state.wantShotAtEnd;
  if (output === "none" || !appName) return { content: [{ type: "text", text: header }], isError: !!error || undefined };
  const before = state.lastTree; // kod başında alınan ağaç
  const last = await callUpstream("get_app_state", { app: appName });
  const after = resultText(last);
  let body;
  if (output === "diff") body = `[diff]\n${looksLikeTree(after) ? diffText(state.firstTree || before, after) : after.slice(0, 1500)}`;
  else body = after;
  const shot = wantShot ? (await shrinkScreenshot(last)).content.filter((c) => c.type !== "text") : [];
  return withNotes({ content: [{ type: "text", text: `${header}\n\n${body}` }, ...shot], isError: !!error || undefined }, appName);
}

// ---------- araç çağrısı ----------
async function callTool(name, rawArgs) {
  if (name === "script") { await ensureUpstream(); return runScript(rawArgs || {}); }
  await ensureUpstream();
  const args = { ...(rawArgs || {}) };
  const wantShot = args.include_screenshot ?? DEFAULT_SCREENSHOT;
  delete args.include_screenshot;

  if (name === "batch") {
    // params: {{ad}} yer tutucuları çalıştırmadan önce doldurulur; save_as şablonu ham (yer tutuculu) kaydeder.
    const actions = args.params ? substitute(args.actions, args.params) : args.actions;
    const res = await runBatch(args.app, actions, { finalState: args.final_state !== false, autoRecover: args.auto_recover !== false, captureBefore: args.output === "diff", dryRun: !!args.dry_run });
    if (args.dry_run) return { content: [{ type: "text", text: `batch (dry-run, hiçbir eylem yapılmadı):\n${res.log.join("\n")}` }] };
    if (args.save_as && !res.failed) {
      const macros = loadMacros();
      macros[args.save_as] = { description: args.save_description || "", app: args.app, params: [...new Set([...JSON.stringify(args.actions).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))], actions: args.actions, saved_at: new Date().toISOString() };
      saveMacros(macros); res.log.push(`makro kaydedildi: ${args.save_as}`);
    }
    return packBatch("batch", res, { wantShot, output: args.output, compact: args.compact !== false, app: args.app, shotOnError: args.screenshot_on_error !== false });
  }

  if (name === "status") {
    const t0 = Date.now();
    const pg = async (pat) => (await run("pgrep", ["-f", pat])).code === 0;
    const [app, server, svc, client] = await Promise.all([pg(`${CODEX_APP_NAME}.app/Contents/MacOS/${CODEX_APP_NAME}`), pg("codex .*app-server"), pg("SkyComputerUseService"), pg("SkyComputerUseClient mcp")]);
    let ping = null, apps = null;
    try { const r = await upRequest("tools/call", { name: "list_apps", arguments: {} }); ping = Date.now() - t0; apps = (resultText(r).match(/\[frontmost|\[running/g) || []).length; } catch (e) { ping = `hata: ${e.message}`; }
    const macros = Object.keys(loadMacros());
    const lines = [
      `codex-cua-plus ${VERSION} | node ${process.version} | idle ${process.env.COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS || "60000"} ms | görüntü varsayılan ${DEFAULT_SCREENSHOT ? "açık" : "kapalı"} (${SCREENSHOT_MAX_PX} px)`,
      `${CODEX_APP_NAME}.app: ${app ? "açık" : "KAPALI (servis çalışmaz; sarmalayıcı -10005'te açmayı dener)"}`,
      `codex app-server: ${server ? "var" : "yok"} | SkyComputerUseService: ${svc ? "çalışıyor" : "yok"} | SkyComputerUseClient: ${client ? "çalışıyor" : "boşta/kapalı (ilk çağrıda açılır)"}`,
      `list_apps ping: ${typeof ping === "number" ? `${ping} ms` : ping}${apps !== null ? ` (${apps} çalışan uygulama)` : ""}`,
      `makrolar (${macros.length}): ${macros.join(", ") || "-"} → ${MACRO_FILE}`,
      `notlar: ${Object.keys(BUILTIN_NOTES).join(", ")} (yerleşik)${existsSync(NOTES_FILE) ? ` + ${NOTES_FILE}` : ""}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "screenshot") {
    const st = await callUpstream("get_app_state", { app: args.app });
    const img = (st.content || []).find((c) => c.type === "image");
    if (!img) return { content: [{ type: "text", text: "Görüntü alınamadı." }, ...st.content.filter((c) => c.type === "text")], isError: true };
    const buf = Buffer.from(img.data, "base64");
    const dir = mkdtempSync(join(tmpdir(), "cua-plus-")); const f = join(dir, "s.jpg");
    try {
      writeFileSync(f, buf);
      const size = await imageSize(f);
      const notes = [`Orijinal ${size?.w}×${size?.h} px (koordinatlar bu çözünürlükte).`];
      if (args.region) {
        const [x0, y0, x1, y1] = args.region.map((v) => Math.round(v));
        const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
        const c = await run("sips", ["-c", String(h), String(w), "--cropOffset", String(y0), String(x0), f]);
        if (c.code !== 0) return { content: [{ type: "text", text: "Kırpma başarısız (region ekran içinde mi?)." }], isError: true };
        notes.push(`Bölge [${x0},${y0}]–[${x1},${y1}] kırpıldı; bölgedeki piksel + (${x0},${y0}) = orijinal koordinat.`);
      }
      const maxPx = Number(args.max_px ?? SCREENSHOT_MAX_PX);
      if (maxPx) { const sz = await imageSize(f); if (sz && Math.max(sz.w, sz.h) > maxPx) { await run("sips", ["-Z", String(maxPx), "-s", "formatOptions", String(process.env.CUA_PLUS_JPEG_QUALITY ?? 70), f]); const ns = await imageSize(f); notes.push(`${ns?.w}×${ns?.h} px'e küçültüldü; çarpan ${(sz.w / ns.w).toFixed(3)}.`); } }
      return { content: [{ type: "text", text: `${windowLine(resultText(st))}\n${notes.join(" ")}` }, { type: "image", data: readFileSync(f).toString("base64"), mimeType: "image/jpeg" }] };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  if (name === "recover") {
    const state = { lastTree: null };
    const r = await recover(args.app, state);
    const out = await finish(state.lastResult || { content: [] }, wantShot);
    return { ...out, content: [{ type: "text", text: `recover ${r.ok ? "başarılı" : "BAŞARISIZ"}:\n${r.log.join("\n")}` }, ...(out.content || [])] };
  }

  if (name === "save_macro") {
    const macros = loadMacros();
    macros[args.name] = { description: args.description || "", app: args.app, params: args.params || [], actions: args.actions, saved_at: new Date().toISOString() };
    saveMacros(macros);
    return { content: [{ type: "text", text: `Makro kaydedildi: ${args.name} (${args.actions.length} adım) → ${MACRO_FILE}` }] };
  }
  if (name === "list_macros") {
    const macros = loadMacros();
    const rows = Object.entries(macros).map(([n, m]) => `- ${n}: ${m.description || "(açıklama yok)"} | app=${m.app || "-"} | params=${(m.params || []).join(",") || "-"} | ${m.actions.length} adım`);
    return { content: [{ type: "text", text: rows.length ? rows.join("\n") : `Kayıtlı makro yok (${MACRO_FILE}).` }] };
  }
  if (name === "run_macro") {
    const macro = loadMacros()[args.name];
    if (!macro) return { content: [{ type: "text", text: `Makro yok: ${args.name}` }], isError: true };
    const params = args.params || {};
    const missing = (macro.params || []).filter((k) => params[k] === undefined);
    if (missing.length) return { content: [{ type: "text", text: `Eksik parametre: ${missing.join(", ")}` }], isError: true };
    const actions = substitute(macro.actions, params);
    const app = args.app || macro.app;
    const res = await runBatch(app, actions, { finalState: args.final_state !== false, captureBefore: args.output === "diff" });
    return packBatch(`run_macro ${args.name}`, res, { wantShot, output: args.output, compact: args.compact !== false, app, shotOnError: args.screenshot_on_error !== false });
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
    const state = { lastTree: null };
    const r = await openPathInDialog(args.app, args, state);
    const out = await finish(r.last || { content: [] }, wantShot);
    return { ...out, isError: !r.ok || undefined, content: [{ type: "text", text: `open_path_in_dialog:\n${r.log.join("\n")}` }, ...(out.content || [])] };
  }

  const output = args.output || DEFAULT_OUTPUT; delete args.output;
  const before = cachedTree(args.app);

  if (TARGETABLE.has(name) && args.find) {
    const { last, log } = await runBatch(args.app, [{ tool: name, args: { ...args, find: undefined, role: undefined, nth: undefined }, find: args.find, role: args.role, nth: args.nth }], { finalState: false });
    const out = await finish(renderResult(last || { content: [] }, before, output), wantShot);
    return withNotes({ ...out, content: [{ type: "text", text: log.join("\n") }, ...(out.content || [])] }, args.app);
  }
  delete args.find; delete args.role; delete args.nth;

  if (name === "press_key" && args.repeat) {
    const { last, log } = await runBatch(args.app, [{ tool: "press_key", args: { app: args.app, key: args.key }, repeat: args.repeat }], { finalState: false });
    const out = await finish(renderResult(last || { content: [] }, before, output), wantShot);
    return withNotes({ ...out, content: [{ type: "text", text: log.join("\n") }, ...(out.content || [])] }, args.app);
  }
  delete args.repeat;

  const r = await callUpstream(name, args);
  if (name === "list_apps") return r;
  return withNotes(await finish(renderResult(r, before, output), wantShot), args.app);
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
