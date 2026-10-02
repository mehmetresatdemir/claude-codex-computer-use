#!/usr/bin/env node
// codex-cua-plus: wrapper MCP server in front of the claude-codex-computer-use bridge.
// Passes the upstream tools through and adds: script (persistent JS), batch, text targeting (find), wait_for,
// menu, find_elements, paste, open_path_in_dialog, recover, macros, app notes, diff output, auto-observe after
// actions, key-name normalisation, named service errors, screenshot downscaling and ChatGPT.app auto-launch.
// No dependencies; Node >= 22. Pure helpers live in lib/pure.mjs (unit tests: npm test).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resultText, isSoftError, parseTree, looksLikeTree, treeRootIsMenu, windowLine, focusLine, extractInstructions,
  treeDiff, diffText, substitute, findInTree, lastTextUnder, stripBidi, valueOf, normalizeKey,
  annotateServiceError, STOP_CODES, SERVICE_DOWN, UI_ACTIONS, imageDims,
} from "./lib/pure.mjs";

const MACRO_DIR = process.env.CUA_PLUS_MACRO_DIR || join(homedir(), ".codex-cua-plus");
const MACRO_FILE = join(MACRO_DIR, "macros.json");
const NOTES_FILE = join(MACRO_DIR, "notes.json");

const NPX = process.env.CUA_PLUS_NPX || "npx";
const BRIDGE_ARGS = ["-y", "claude-codex-computer-use@latest"];
const DEFAULT_SCREENSHOT = (process.env.CUA_PLUS_DEFAULT_SCREENSHOT ?? "false") === "true";
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const KEY_DELAY_MS = num(process.env.CUA_PLUS_KEY_DELAY_MS, 40);
const CODEX_APP_NAME = process.env.CUA_PLUS_APP_NAME || "ChatGPT"; // macOS name of the Codex app
const SCREENSHOT_MAX_PX = num(process.env.CUA_PLUS_SCREENSHOT_MAX_PX, 1280); // 0 = no downscale
const JPEG_QUALITY = num(process.env.CUA_PLUS_JPEG_QUALITY, 70);
const DEFAULT_OUTPUT = process.env.CUA_PLUS_DEFAULT_OUTPUT || "diff";
const UPSTREAM_TIMEOUT_MS = num(process.env.CUA_PLUS_UPSTREAM_TIMEOUT_MS, 130000); // service IPC limit is 120 s
const VERSION = "0.8.0";

const debug = (m) => { if (process.env.CUA_PLUS_DEBUG) process.stderr.write(`[cua-plus] ${m}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
const isRegExp = (x) => Object.prototype.toString.call(x) === "[object RegExp]"; // works across vm realms

// ---------- upstream (bridge) ----------
// Spawned in its own process group so that SIGTERM reaches the whole chain (npx → bridge → codex sandbox → client).
// Environment: drop Claude Code / Codex app-tools variables so the client chain does not inherit unrelated pipes.
const upEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|CODEX_APP_TOOLS_|MCP_)/.test(k)));
const up = spawn(NPX, BRIDGE_ARGS, { stdio: ["pipe", "pipe", "inherit"], env: upEnv, detached: true });
up.on("error", (e) => { process.stderr.write(`[cua-plus] cannot start the bridge (${NPX}): ${e.message}\n`); process.exit(1); });
up.stdin.on("error", (e) => debug(`upstream stdin: ${e.message}`));
let nextId = 1;
const pending = new Map(); // our id → {resolve, reject, timer}
const forwarded = new Map(); // id we gave the client → upstream's original id (upstream-initiated requests)
let upstreamInitialized = null;

function upSend(obj) { try { up.stdin.write(JSON.stringify(obj) + "\n"); } catch (e) { debug(`upstream write failed: ${e.message}`); } }
function upRequest(method, params, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`upstream timeout after ${timeoutMs} ms (${method})`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    upSend({ jsonrpc: "2.0", id, method, params });
  });
}
createInterface({ input: up.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { debug(`upstream non-JSON line: ${line.slice(0, 120)}`); return; }
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) { const e = new Error(m.error.message || JSON.stringify(m.error)); e.code = m.error.code; e.data = m.error.data; p.reject(e); }
    else p.resolve(m.result);
    return;
  }
  if (m.method && m.id !== undefined) { // upstream-initiated request (ping, elicitation/create, roots/list…): relay to the client
    if (m.method === "ping") { upSend({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
    const fid = `up-${nextId++}`;
    forwarded.set(fid, m.id);
    send({ ...m, id: fid });
    return;
  }
  if (m.method) send(m); // notification → pass down
});
up.on("exit", (code) => { debug(`upstream exited (${code})`); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("upstream exited")); } pending.clear(); process.exit(code ?? 1); });
function shutdown(sig) {
  debug(`${sig}: stopping the upstream chain`);
  try { process.kill(-up.pid, "SIGTERM"); } catch { try { up.kill("SIGTERM"); } catch {} }
  setTimeout(() => process.exit(0), 300);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig));

async function ensureUpstream() {
  if (!upstreamInitialized) {
    upstreamInitialized = (async () => {
      await upRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-cua-plus", version: VERSION } });
      upSend({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
  }
  return upstreamInitialized;
}

// ---------- result handling ----------
function stripScreenshot(result) {
  if (!result?.content) return result;
  const content = result.content.filter((c) => c.type !== "image");
  content.push({ type: "text", text: "(screenshot omitted; pass include_screenshot:true to get it)" });
  return { ...result, content };
}
function run(cmd, args, input) {
  return new Promise((res) => {
    let c;
    try { c = spawn(cmd, args, { stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "ignore"] }); } catch (e) { return res({ code: -1, out: "", error: e.message }); }
    let out = "";
    c.on("error", (e) => res({ code: -1, out, error: e.message }));
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => res({ code, out }));
    if (input !== undefined) { c.stdin.on("error", () => {}); c.stdin.end(input); }
  });
}
// Downscale the screenshot with macOS `sips` (no dependency). Coordinates stay in the service's resolution.
async function shrinkScreenshot(result, maxPx = SCREENSHOT_MAX_PX) {
  if (!maxPx || !result?.content) return result;
  const idx = result.content.findIndex((c) => c.type === "image");
  if (idx < 0) return result;
  const img = result.content[idx];
  const buf = Buffer.from(img.data, "base64");
  const dims = imageDims(buf);
  if (!dims || Math.max(dims.w, dims.h) <= maxPx) return result;
  const dir = mkdtempSync(join(tmpdir(), "cua-plus-"));
  const file = join(dir, `shot.${dims.ext}`);
  try {
    writeFileSync(file, buf);
    const { code } = await run("sips", ["-Z", String(maxPx), ...(dims.ext === "jpg" ? ["-s", "formatOptions", String(JPEG_QUALITY)] : []), file]);
    if (code !== 0) return result;
    const out = readFileSync(file);
    const nd = imageDims(out) || dims;
    const content = [...result.content];
    content[idx] = { ...img, data: out.toString("base64") };
    content.push({ type: "text", text: `Screenshot downscaled to ${nd.w}×${nd.h} px (original ${dims.w}×${dims.h}). Click coordinates are in the ORIGINAL resolution: multiply image pixels by ${(dims.w / nd.w).toFixed(3)}.` });
    return { ...result, content };
  } catch (e) { debug(`downscale failed: ${e.message}`); return result; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
async function finish(result, wantShot) { return wantShot ? shrinkScreenshot(result) : stripScreenshot(result); }
function fail(text, extra = {}) { return { content: [{ type: "text", text }], isError: true, ...extra }; }

// ---------- app notes ----------
// Known pitfalls, attached once per app (and once per matching window/tree pattern). Users add/override via notes.json:
// { "finder": ["..."], "_match": { "open/save panel": { "re": "PathTextField|OKButton", "notes": ["..."] } }, "_screenshot": ["simulator"] }
const BUILTIN_NOTES = {
  freeform: [
    "Clicking a canvas item (image/layout item) via find sends AXPress → Quick Look opens, the item is not selected. Select by coordinate (click x,y). If Quick Look is open and Escape doesn't close it, click 'close panel button'.",
    "drag and set_value on handles do not move/resize shapes (synthetic drag is ignored). Insert pictures as files (Insert > Choose File → open_path_in_dialog). A selected item moves 10 pt per shift+arrow (app.nudge) and 1 pt per plain arrow; shift+arrow also resizes a selected shape. If the handle lines' 'Value: x:…, y:…' did not change, nothing moved.",
    "Escape inside a board can return to 'All Boards'. The menu bar 'Insert' item is found by exact match; submenu items (Shape > Triangle) appear in the same tree. A stuck menu shows as root '0 Insert, Secondary Actions: Cancel, Pick' → recover / perform_secondary_action(0,'Cancel').",
    "Pen tool (Insert Shape → Draw with Pen → click points → Return → Escape; app.pen(points)): a second click on a point already in the current path selects/closes it, so start a new path at a repeated vertex (share the last vertex). Points need ≥0.6 s spacing; clicks through this engine already take ≈0.5–1 s.",
    "Sticky Note: Insert > Sticky Note then type_text; Text Box: Insert > Text Box then type_text; Escape ends editing. Rename a board: double-click the title (click_count:2) → set_value → Return. perform_secondary_action(idx,'Show format options') opens the colour/format panel.",
  ],
  textedit: [
    "The document body is 'text entry area (settable) First Text View'; type_text find=\"First Text View\" writes there. A new document is RTF: press super+shift+t (Make Plain Text) before writing if you want .txt, otherwise .rtf is appended to the name.",
    "Save: super+s → set_value on 'text field (settable) … ID: saveAsNameTextField' ('Save As:' is a separate label) → super+shift+g → path → Return → Return. After saving the window title becomes the file name and the tree shows 'URL: file://…' (proof of the save). In wait_for use Window: \"name without the closing quote.",
    "If no document is open at launch, the Open panel appears: click 'New Document'.",
  ],
  calculator: [
    "The result is the last text row under the 'Edit field' element; it contains invisible bidi marks (U+200E/F) and the locale's thousands separator. In script read it with app.lastTextUnder(ax, 'Edit field') and verify it changed (waitFor) before trusting it. Send the whole expression with one type_text (e.g. '37*41='); keys sent one by one each pay the ≈0.5 s settle wait. Buttons can also be clicked by index in one script call.",
  ],
  finder: [
    "List view: super+2. New folder with the selection: super+ctrl+n → type the name → Return. Typing a file-name prefix with type_text selects that item; extend with shift+Down (repeat). Move files: super+c on the selection → super+shift+g + path → Return → super+alt+v. Counts are in the 'statusBarText' line. The Go to Folder field rejects paste (clipboard timeout) → use set_value on PathTextField (open_path_in_dialog does this). Coordinate scroll outside the window gives windowNotFoundAtPosition → scroll by element_index.",
  ],
  unity: [
    "Use the app name 'Unity' or the bundle id com.unity3d.UnityEditor5.x; a .app path or 'Unity Hub' times out. Keys are lower-case ('space', 'Escape'). The Game view needs a screenshot; wait for Play mode with wait_for, not sleep.",
  ],
  simulator: [
    "The tree is sparse: use a screenshot + coordinates at every step; 'invalid element ID' is frequent → re-read with output:\"full\".",
  ],
  _match: {
    "open/save panel": { re: "PathTextField|OKButton|open-panel|save-panel", notes: ["In an Open/Save panel: super+shift+g → set_value on the path field (PathTextField) → Return; verify the selection via 'Value: <name>', then Return (faster than clicking the button). The Save name field is saveAsNameTextField. open_path_in_dialog does the whole flow in one step."] },
  },
  _screenshot: ["simulator", "unity"],
};
function loadNotesFile() { try { return JSON.parse(readFileSync(NOTES_FILE, "utf8")); } catch { return {}; } }
function notesFor(app, tree) {
  const user = loadNotesFile();
  const out = [];
  const appL = String(app || "").toLowerCase();
  for (const src of [BUILTIN_NOTES, user]) {
    for (const [k, v] of Object.entries(src)) {
      if (k.startsWith("_") || !Array.isArray(v)) continue;
      if (appL.includes(k.toLowerCase())) out.push({ key: `app:${k}`, notes: v });
    }
    for (const [k, v] of Object.entries(src._match || {})) {
      if (tree && v?.re && new RegExp(v.re, "i").test(tree)) out.push({ key: `match:${k}`, notes: v.notes || [] });
    }
  }
  return out;
}
function wantsScreenshotByDefault(app) {
  const appL = String(app || "").toLowerCase();
  return [...(BUILTIN_NOTES._screenshot || []), ...(loadNotesFile()._screenshot || [])].some((k) => appL.includes(String(k).toLowerCase()));
}
const notesShown = new Set(); // per session: each note group once
function withNotes(result, app, tree) {
  if (!result?.content) return result;
  const groups = notesFor(app, tree ?? resultText(result)).filter((g) => !notesShown.has(g.key));
  if (!groups.length) return result;
  for (const g of groups) notesShown.add(g.key);
  const text = groups.map((g) => `Notes (${g.key.replace(/^app:/, "")}):\n${g.notes.map((x) => `- ${x}`).join("\n")}`).join("\n");
  return { ...result, content: [...result.content, { type: "text", text }] };
}
// Service-provided <app_specific_instructions> (Slack, Notion, Numbers, Spotify, Music, Clock, iPhone Mirroring…): shown once, kept out of the tree/diff.
const instructionsShown = new Set();
function splitInstructions(result, app) {
  if (!result?.content) return result;
  let instr = null;
  const content = result.content.map((c) => {
    if (c.type !== "text") return c;
    const { tree, instructions } = extractInstructions(c.text);
    if (instructions) instr = instructions;
    return { ...c, text: tree };
  });
  const key = String(app || "").toLowerCase();
  if (instr && !instructionsShown.has(key)) { instructionsShown.add(key); content.push({ type: "text", text: `<app_specific_instructions>\n${instr}\n</app_specific_instructions>` }); }
  return { ...result, content };
}

// ---------- macros ----------
let macrosBroken = false;
function loadMacros() {
  try { macrosBroken = false; return existsSync(MACRO_FILE) ? JSON.parse(readFileSync(MACRO_FILE, "utf8")) : {}; }
  catch (e) { macrosBroken = true; debug(`macros.json unreadable: ${e.message}`); return {}; }
}
function saveMacros(m) {
  if (macrosBroken) throw new Error(`${MACRO_FILE} is not valid JSON; fix or remove it before saving macros (refusing to overwrite).`);
  mkdirSync(MACRO_DIR, { recursive: true }); writeFileSync(MACRO_FILE, JSON.stringify(m, null, 2));
}

// ---------- service / app health ----------
let launchingApp = null;
async function ensureCodexAppRunning() {
  if (launchingApp) return launchingApp;
  launchingApp = (async () => {
    debug(`launching ${CODEX_APP_NAME}.app (service down)`);
    await run("open", ["-g", "-a", CODEX_APP_NAME]);
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if ((await run("pgrep", ["-f", "codex .*app-server"])).code === 0) { await sleep(3000); return true; }
    }
    return false;
  })();
  try { return await launchingApp; } finally { setTimeout(() => { launchingApp = null; }, 10000); }
}
// Last full tree per app, for diff output across calls. Marked dirty after every UI action.
const treeCache = new Map();
const key = (app) => String(app || "").toLowerCase();
function cacheTree(app, text) { if (app && looksLikeTree(text)) treeCache.set(key(app), { tree: text, dirty: false }); }
function cachedTree(app) { return app ? treeCache.get(key(app))?.tree || null : null; }
function markDirty(app) { const c = treeCache.get(key(app)); if (c) c.dirty = true; }
const PLAIN_TEXT_ERRORS = [
  [/Computer Use was not approved to use/i, "[notApproved] The user declined the approval prompt for this app; retrying with another name/bundle id does not help. Tell the user."],
  [/The user changed '.*?'\. Re-query/i, "[userChanged] The user changed something in the app; indices are invalid. Read the tree again (done automatically once per action)."],
  [/is an invalid element ID|element ID is no longer valid|invalid_element_id/i, "[invalidElementID] Stale index; read the tree again and re-target (use find, or output:\"full\")."],
  [/Timed out waiting for the application to read the clipboard/i, "[clipboardTimeout] The focused field rejected the paste; use set_value on the field instead."],
  [/is not a valid secondary action for/i, "[invalidSecondaryAction] Use a name listed after 'Secondary Actions:' on that line."],
  [/noWindowsAvailable|No capturable window/i, "[noWindow] The app runs without a window; open one (super+n / open the document) and connect again."],
];
async function callUpstream(name, args) {
  if (name === "press_key" && args?.key !== undefined) args = { ...args, key: normalizeKey(args.key) };
  const attempt = async () => {
    try { return await upRequest("tools/call", { name, arguments: args }); }
    catch (e) { return fail(`${e.message}${e.code !== undefined ? ` (code ${e.code})` : ""}`); }
  };
  let r = await attempt();
  if (SERVICE_DOWN.test(resultText(r))) {
    if (await ensureCodexAppRunning()) r = await attempt();
    if (SERVICE_DOWN.test(resultText(r))) r.content.push({ type: "text", text: `Note: the Codex Computer Use service runs only while ${CODEX_APP_NAME}.app is open; it could not be launched or the service did not come up.` });
  }
  r = splitInstructions(r, args?.app);
  const t = resultText(r);
  if (UI_ACTIONS.has(name)) markDirty(args?.app);
  cacheTree(args?.app, t);
  r = annotateServiceError(r);
  for (const [re, hint] of PLAIN_TEXT_ERRORS) if (re.test(t)) { r = { ...r, content: [...r.content, { type: "text", text: hint }] }; break; }
  if (looksLikeTree(t) && treeRootIsMenu(t)) r = { ...r, content: [...r.content, { type: "text", text: "Note: the tree root is an open menu (stuck menu); use recover or perform_secondary_action(0,'Cancel') before other actions." }] };
  return r;
}
// Our counterpart of Codex's default diff: difference against the previous tree for the app; one line when nothing changed.
function renderResult(result, before, output) {
  const after = resultText(result);
  if (output !== "diff" || !before || !looksLikeTree(after)) return result;
  const texts = result.content.filter((c) => c.type === "text");
  const others = result.content.filter((c) => c.type !== "text");
  const extra = texts.slice(1).map((c) => c.text); // notes etc. added by the wrapper
  return { ...result, content: [{ type: "text", text: `[diff]\n${diffText(before, after)}` }, ...extra.map((t) => ({ type: "text", text: t })), ...others] };
}

// ---------- clipboard paste (the MCP client has no paste tool; Codex's REPL does) ----------
async function pasteText(app, text, format = "text") {
  const old = await run("pbpaste", []);
  let put;
  if (format === "html") put = await run("sh", ["-c", "textutil -stdin -format html -convert rtf -stdout | pbcopy -Prefer rtf"], text);
  else put = await run("pbcopy", [], text);
  if (put.code !== 0) return fail(`clipboard write failed (${put.error || put.code})`);
  const r = await callUpstream("press_key", { app, key: "super+v" });
  if (old.code === 0) await run("pbcopy", [], old.out); // restore the user's clipboard (text content only)
  return r;
}

// ---------- tool definitions ----------
const FIND_DESC = "Target by text instead of element_index: role/title on the tree line (e.g. 'Choose File', 'button New Board'); /regex/ allowed (flags i m s; paths like /Users/x are plain text). Exact match > word match > substring; disabled elements rank last. Resolved against a fresh tree after any action in the same call; if not found, the tree is read again once.";
const ACTION_SCHEMA = {
  type: "object",
  description: "One action. 'tool' is an upstream tool or wait_for/sleep_ms/paste/open_path_in_dialog/recover. Target: args.element_index OR find.",
  properties: {
    tool: { type: "string", enum: ["click", "set_value", "type_text", "press_key", "scroll", "drag", "select_text", "perform_secondary_action", "get_app_state", "wait_for", "sleep_ms", "paste", "open_path_in_dialog", "recover"] },
    args: { type: "object", description: "Upstream arguments (app defaults to batch.app). wait_for: {text|re, timeout_ms=4000, absent=false}. sleep_ms: {ms}. paste: {text, format=text|html}. open_path_in_dialog: {path, confirm=true}. recover: {}." },
    find: { type: "string", description: FIND_DESC },
    role: { type: "string", description: "With find: the line must start with this role word (e.g. 'button', 'menu item', 'text field')." },
    nth: { type: "integer", minimum: 0, description: "If find matches several lines, which one in score order (0 = best)." },
    repeat: { type: "integer", minimum: 1, maximum: 200, description: "Repeat this action N times (e.g. arrow keys)." },
    if_present: { type: "string", description: "Run only if this text is in the current tree (otherwise the step is skipped)." },
    if_absent: { type: "string", description: "Run only if this text is NOT in the current tree." },
    optional: { type: "boolean", description: "On error, skip this step instead of stopping the batch." },
    timeout_ms: { type: "integer", minimum: 1000, description: "Per-step upstream timeout (default 130000)." },
  },
  required: ["tool"],
};
const COMMON_PROPS = (defaultOut) => ({
  include_screenshot: { type: "boolean", description: `Attach a screenshot (default ${DEFAULT_SCREENSHOT}, or true for apps listed under _screenshot in notes). Leave off when the tree is enough; much faster. Downscaled to ${SCREENSHOT_MAX_PX || "full"} px.` },
  output: { type: "string", enum: ["diff", "full"], description: `diff (default ${defaultOut}): only lines changed since the last known tree for this app; full: the whole tree. The first call for an app is always full.` },
});
const EXTRA_TOOLS = [
  {
    name: "batch",
    description: "Run several Computer Use actions in one call; only the final state is returned (diff by default). Actions can be targeted by text with 'find' (resolved against a fresh tree after every action). wait_for waits for panels/windows. On error the batch stops and returns the log so far plus a screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Default target app." },
        actions: { type: "array", items: ACTION_SCHEMA, minItems: 1, description: "Ordered actions." },
        ...COMMON_PROPS("diff"),
        final_state: { type: "boolean", description: "Read the final tree at the end (default true)." },
        compact: { type: "boolean", description: "In diff mode hide noise lines (scroll bars, arrow buttons, handles, untitled image/text) (default true)." },
        dry_run: { type: "boolean", description: "Do nothing; show which index each find target would resolve to in the current tree." },
        params: { type: "object", description: "Fill {{name}} placeholders in the actions with these values (numbers keep their type; with save_as the template is stored raw)." },
        save_as: { type: "string", description: "If the batch succeeds, save the action list as a macro under this name ({{param}} placeholders are extracted automatically)." },
        save_description: { type: "string", description: "Description stored with save_as." },
        screenshot_on_error: { type: "boolean", description: "Attach a downscaled screenshot when a step fails (default true)." },
        auto_recover: { type: "boolean", description: "If the tree root is a stuck menu and find misses there, try to close the menu first (default true)." },
      },
      required: ["actions"],
    },
  },
  {
    name: "script",
    description: `Persistent JavaScript environment modelled on Codex's cua_repl: code runs locally, no model round trip per click (Codex needs ~25 turns and ~75 s of model latency for a task this does in one call). Variables and functions survive between calls. Write the whole plan here: target with find, wait with waitFor, collect intermediate results with log, return only the final diff. Compute geometry in JS first and send the UI only a click list. Actions run serially (Promise.all does not speed them up). API:
  const app = await cua.getApp("Freeform");          // app object (cua.listApps() lists apps); app.help() lists methods
  await app.click(31) / app.click([x,y]) / app.click({find:"Choose File"}, {click_count:2, mouse_button:"right"});
  await app.pressKey("Return"); await app.typeText("..."); await app.paste("multi\\nline", {format:"text"|"html"});
  await app.setValue(idx|{find}, "..."); await app.scroll(idx,"down",1); await app.drag([x1,y1],[x2,y2]); await app.secondary(idx,"Cancel");
  const ax = await app.getAXState();                 // tree text (NOT sent to the model; kept in a variable)
  app.find(ax, "Draw with Pen") → index | null;  app.findAll(ax, /regex/) → [[idx, line]...];  await app.refind(/regex|text/) → index from a fresh tree
  app.value(ax, "Zoom") → "Value: ..." of a line; app.text(ax, /Window: "([^"]+)"/) → first group; app.lastTextUnder(ax, "Edit field") → last text row under a container (Calculator result)
  app.compact(ax, /rows|text field/) → matching lines only; app.tail(ax, 20) → last lines
  await app.waitFor("Window: \\"Open\\"", {timeout:4000, absent:false});  await app.waitFor(/regex/)
  await app.keys("shift+Down", 30); await app.nudge("right", 30);   // repeated keys; move the selected item (apps that ignore drag)
  await app.menu(["Insert","Shape","Triangle"]);     // menu-bar path; skips intermediate items when the target is visible
  await app.openPath("/full/path");                  // ⌘⇧G in an open Open/Save panel, wait for selection, confirm
  await app.pen([[x,y],...]);                        // Freeform: Insert Shape → Draw with Pen → points → Return → Escape
  await app.deselect([x,y]); await app.raise();      // click empty canvas; bring the window to front (secondary action Raise)
  await app.screenshot();                            // attach the final screenshot to the result
  await sleep(ms); log("...")                        // log lines are returned (last 500)
Result: log + diff/full of the final tree (+ screenshot). Errors -10012/-10016 (user stopped/intervened) abort the script.`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript to run (top-level await allowed)." },
        app: { type: "string", description: "App for the final state (automatic when cua.getApp was used)." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 600000, description: "Default 120000. On timeout no further actions are sent; the running code is abandoned." },
        output: { type: "string", enum: ["full", "diff", "none"], description: "Final state: diff (default; against the tree at the first getApp of that app), full or none." },
        include_screenshot: { type: "boolean", description: "Attach a screenshot of the final state." },
        reset: { type: "boolean", description: "Reset the environment (drop previous variables)." },
      },
      required: ["code"],
    },
  },
  {
    name: "paste",
    description: "Paste text into the focused element through the clipboard (⌘V); the previous clipboard text is restored. Use for multi-line or long text (type_text sends it keystroke by keystroke; some fields, e.g. Finder's Go to Folder, reject paste → use set_value). format html converts HTML to rich text.",
    inputSchema: { type: "object", properties: { app: { type: "string", description: "Target app." }, text: { type: "string" }, format: { type: "string", enum: ["text", "html"] }, ...COMMON_PROPS(DEFAULT_OUTPUT) }, required: ["app", "text"] },
  },
  {
    name: "status",
    description: "Health/diagnostics: wrapper version, ChatGPT.app / app-server / service / client state, list_apps ping latency, saved macros and notes files.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description: "Screenshot of the app; optional region=[x0,y0,x1,y1] (coordinates of the service's screenshot, the same ones click x,y uses) crops and zooms to read small text. max_px sets the output size (0 = no downscale).",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", description: "Target app." }, region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x0,y0,x1,y1] crop in screenshot coordinates." }, max_px: { type: "integer", minimum: 0, description: "Longest side of the returned image (0 = original)." } },
      required: ["app"],
    },
  },
  {
    name: "recover",
    description: "Recover from a stuck/open menu: Escape → the menu's Cancel action, checking after each step whether the tree root is still a menu. Returns a log.",
    inputSchema: { type: "object", properties: { app: { type: "string", description: "Target app." }, include_screenshot: { type: "boolean", description: "Attach a screenshot of the final state." } }, required: ["app"] },
  },
  {
    name: "save_macro",
    description: `Save a batch action list under a name (${MACRO_FILE}). {{param}} placeholders in strings are filled by run_macro. Same name overwrites.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Macro name." }, description: { type: "string", description: "What it does." },
        app: { type: "string", description: "Default app (can be overridden in run_macro)." },
        actions: { type: "array", items: ACTION_SCHEMA, minItems: 1, description: "Batch actions." },
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
        name: { type: "string", description: "Macro name." }, params: { type: "object", description: "{{param}} values." },
        app: { type: "string", description: "Override the macro's app." }, ...COMMON_PROPS("diff"), final_state: { type: "boolean", description: "Read the final tree (default true)." },
        compact: { type: "boolean", description: "Hide noise lines in diff (default true)." }, screenshot_on_error: { type: "boolean", description: "Screenshot when a step fails (default true)." },
        auto_recover: { type: "boolean", description: "Close a stuck menu when find misses (default true)." }, dry_run: { type: "boolean", description: "Resolve targets only." },
      },
      required: ["name"],
    },
  },
  { name: "list_macros", description: "List saved macros (name, description, parameters, step count).", inputSchema: { type: "object", properties: {} } },
  {
    name: "menu",
    description: "Click a menu-bar path: path=['Insert','Shape','Triangle']. Each step is found by text in a fresh tree; intermediate items are skipped when the target is already visible.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", description: "Target app." }, path: { type: "array", items: { type: "string" }, minItems: 1, description: "Menu titles from the menu bar down to the item." }, include_screenshot: { type: "boolean", description: "Attach a screenshot of the final state." } },
      required: ["app", "path"],
    },
  },
  {
    name: "find_elements",
    description: "Return only the tree lines matching the query (index + role/title) without the whole tree. Takes a fresh get_app_state.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", description: "Target app." }, query: { type: "string", description: "Substring or /regex/." }, role: { type: "string", description: "Line must start with this role word." }, limit: { type: "integer", minimum: 1, maximum: 50, description: "Max lines (default 20)." } },
      required: ["app", "query"],
    },
  },
  {
    name: "open_path_in_dialog",
    description: "In an open macOS Open/Save panel: ⌘⇧G opens 'Go to Folder', sets the path, Return navigates to the file/folder. With confirm=true waits for the item to be selected, then triggers the panel's default button (Open/Insert/Save) — Return first, button click as fallback.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App that owns the panel." },
        path: { type: "string", description: "Full file or folder path." },
        confirm: { type: "boolean", description: "Press the default button after navigating (default true)." },
        include_screenshot: { type: "boolean", description: "Attach a screenshot of the final state." },
      },
      required: ["app", "path"],
    },
  },
];

const TARGETABLE = new Set(["click", "set_value", "scroll", "select_text", "perform_secondary_action", "type_text"]);
const FOCUS_THEN_ACT = new Set(["type_text"]); // type_text has no element_index: click the target first (skipped when it already has focus)
let toolListCache = null;
async function listTools() {
  await ensureUpstream();
  if (toolListCache) return toolListCache;
  const r = await upRequest("tools/list", {});
  const tools = (r.tools || []).map((t) => {
    const schema = structuredClone(t.inputSchema || { type: "object", properties: {} });
    schema.properties ||= {};
    if (t.name !== "list_apps") {
      Object.assign(schema.properties, COMMON_PROPS(DEFAULT_OUTPUT));
      if (UI_ACTIONS.has(t.name)) schema.properties.observe = { type: "boolean", description: "After the action read the tree again and return the diff (default true, ≈60 ms). false: return only the action result (use for runs of keys)." };
    }
    if (TARGETABLE.has(t.name)) {
      schema.properties.find = { type: "string", description: FIND_DESC };
      schema.properties.role = { type: "string", description: "With find: the line must start with this role word." };
      schema.properties.nth = { type: "integer", minimum: 0, description: "Which match in score order (0 = best)." };
      if (schema.required) schema.required = schema.required.filter((k) => k !== "element_index");
    }
    if (t.name === "press_key") {
      schema.properties.repeat = { type: "integer", minimum: 1, maximum: 200, description: "Press the key N times (e.g. 15× shift+Down)." };
      schema.properties.key.description = `${schema.properties.key.description || ""} Names are X11 keysyms: 'Return', 'Escape', 'BackSpace', 'space', 'Page_Up', 'KP_0', 'super+c', 'shift+Tab'. Aliases cmd/command/win→super, opt→alt, enter, esc, backspace, del, pgup/pgdn and single symbols (- = , .) are translated.`.trim();
    }
    if (t.name === "click") {
      schema.properties.click_count = { ...(schema.properties.click_count || {}), description: "1 (default), 2 = double-click (open/edit), 3 = triple-click (select all text in a field)." };
      schema.properties.mouse_button = { ...(schema.properties.mouse_button || {}), description: "left (default), right (context menu), middle." };
    }
    return { ...t, inputSchema: schema };
  });
  toolListCache = { tools: [...tools, ...EXTRA_TOOLS] };
  return toolListCache;
}

// ---------- running actions ----------
// state.lastTree: the latest tree observed in this call; it is cleared after every UI action so that find/if_present/menu
// always work on a fresh read (≈60 ms) instead of a stale one.
async function readTree(app, state) {
  const st = await callUpstream("get_app_state", { app });
  state.lastTree = resultText(st); state.lastResult = st;
  return st;
}
async function currentTree(app, state) {
  if (state.lastTree && looksLikeTree(state.lastTree)) return state.lastTree;
  await readTree(app, state);
  return state.lastTree || "";
}
async function recover(app, state) {
  const log = [];
  const check = async (label) => {
    await readTree(app, state);
    const stuck = treeRootIsMenu(state.lastTree);
    log.push(`${label}: ${stuck ? "root is still a menu" : "recovered"}`);
    return !stuck;
  };
  if (await check("start")) return { ok: true, log };
  await callUpstream("press_key", { app, key: "Escape" });
  if (await check("Escape")) return { ok: true, log };
  const rows = parseTree(state.lastTree);
  const menuEl = rows.find((r) => /^menu\b/.test(r.rest) && /Cancel/.test(r.rest)) || rows[0];
  if (menuEl) { await callUpstream("perform_secondary_action", { app, element_index: menuEl.index, action: "Cancel" }); if (await check(`Cancel [${menuEl.index}]`)) return { ok: true, log }; }
  return { ok: false, log };
}

async function resolveTarget(app, action, state) {
  if (!action.find) return { ok: true };
  const opts = { role: action.role, nth: action.nth };
  let tree = await currentTree(app, state);
  let res = findInTree(tree, action.find, opts);
  if (!res.hit && state.autoRecover !== false && treeRootIsMenu(tree)) {
    const rec = await recover(app, state);
    state.recoverLog = (state.recoverLog || []).concat(rec.log.map((l) => `recover: ${l}`));
    if (rec.ok) res = findInTree(state.lastTree, action.find, opts);
  }
  if (!res.hit) {
    const cands = res.candidates.map((c) => `  ${c.index} ${c.rest}`).join("\n");
    return { ok: false, error: `'${action.find}' not found in the tree.${cands ? `\nClosest candidates:\n${cands}` : ""}` };
  }
  return { ok: true, index: res.hit.index, line: res.hit.line };
}

async function waitFor(app, { text, re, timeout_ms = 4000, absent = false }, state) {
  const deadline = Date.now() + Number(timeout_ms);
  const rx = re ? (isRegExp(re) ? re : new RegExp(re, "i")) : null;
  let last;
  while (true) {
    last = await readTree(app, state);
    const t = state.lastTree;
    const present = rx ? rx.test(t) : t.toLowerCase().includes(String(text).toLowerCase());
    if (present !== absent) return { ok: true, result: last };
    if (Date.now() >= deadline) break;
    await sleep(150);
  }
  const what = rx ? String(rx) : `'${text}'`;
  return { ok: false, result: last, error: `wait_for timed out (${timeout_ms} ms): ${what} ${absent ? "still present" : "did not appear"}` };
}

async function runAction(defaultApp, action, state) {
  const args = { ...(action.args || {}) };
  if (defaultApp && args.app === undefined) args.app = defaultApp;
  const app = args.app;
  if (state.dryRun && !action.find) return { result: null, note: "(dry-run, no find target)" };
  if (action.tool === "sleep_ms") { const ms = Number(args.ms ?? 300); await sleep(ms); return { result: { content: [{ type: "text", text: `slept ${ms} ms` }] }, note: `${ms} ms` }; }
  if (action.tool === "wait_for") {
    const w = await waitFor(app, args, state);
    return w.ok ? { result: w.result, note: `${args.re ? `/${args.re}/` : `'${args.text}'`} ${args.absent ? "gone" : "appeared"}` } : { result: w.result, error: w.error };
  }
  if (action.tool === "open_path_in_dialog") {
    const r = await openPathInDialog(app, args, state);
    return r.ok ? { result: r.last, note: r.log.join("; ") } : { result: r.last, error: r.log.join("; ") };
  }
  if (action.tool === "recover") {
    const r = await recover(app, state);
    return r.ok ? { result: state.lastResult, note: r.log.join("; ") } : { result: state.lastResult, error: r.log.join("; ") };
  }
  if (action.tool === "paste") {
    const r = await pasteText(app, args.text, args.format);
    state.lastTree = null;
    return isSoftError(r) ? { result: r, error: resultText(r).slice(0, 200) } : { result: r, note: `${String(args.text).length} chars` };
  }
  const target = await resolveTarget(app, action, state);
  if (!target.ok) return { result: null, error: target.error };
  if (state.dryRun) return { result: null, note: target.index !== undefined ? `→ [${target.index}] ${target.line.slice(0, 60)} (dry-run)` : "(dry-run)" };
  if (target.index !== undefined) {
    if (FOCUS_THEN_ACT.has(action.tool)) {
      const focused = focusLine(state.lastTree || "").match(/is (\d+)\b/)?.[1];
      if (focused !== target.index) {
        const f = await callUpstream("click", { app, element_index: target.index });
        state.lastTree = null;
        if (isSoftError(f)) return { result: f, error: `focus click: ${resultText(f).slice(0, 120)}` };
      }
    } else args.element_index = target.index;
  }
  delete args.find; delete args.role; delete args.nth;
  const n = action.repeat ?? 1;
  let last;
  for (let i = 0; i < n; i++) {
    last = await callUpstream(action.tool, args);
    let t = resultText(last);
    if (UI_ACTIONS.has(action.tool)) state.lastTree = null; // the tree is stale now
    // "The user changed <app>. Re-query…" or a stale index: read the state again and retry the action once (re-resolving find).
    if (/Re-query the latest state|invalid element ID|element ID is no longer valid|invalid_element_id/i.test(t) && !state.requeriedThisAction) {
      state.requeriedThisAction = true;
      await readTree(app, state);
      if (action.find) { const tg = await resolveTarget(app, action, state); if (!tg.ok) return { result: state.lastResult, error: tg.error }; if (tg.index !== undefined) args.element_index = tg.index; }
      last = await callUpstream(action.tool, args); t = resultText(last);
      if (UI_ACTIONS.has(action.tool)) state.lastTree = null;
      state.requeried = (state.requeried || 0) + 1;
    }
    if (looksLikeTree(t)) { state.lastTree = t; state.lastResult = last; }
    if (STOP_CODES.test(t)) return { result: last, error: "the user stopped Computer Use or intervened; batch aborted — " + t.slice(0, 160) };
    if (isSoftError(last)) return { result: last, error: t.slice(0, 200) };
    if (n > 1 && i < n - 1) await sleep(KEY_DELAY_MS);
  }
  state.requeriedThisAction = false;
  return { result: last, note: target.line ? `→ [${target.index}] ${target.line.slice(0, 60)}` : undefined };
}

async function runBatch(app, actions, { finalState = true, autoRecover = true, captureBefore = false, dryRun = false } = {}) {
  const state = { lastTree: null, autoRecover, dryRun };
  if (dryRun) { finalState = false; captureBefore = false; if (app) await readTree(app, state); }
  const log = [];
  let last = null, before = cachedTree(app);
  if (captureBefore && app) { await readTree(app, state); before = state.lastTree; }
  const t0 = Date.now();
  let failed = false;
  for (const [i, a] of (actions || []).entries()) {
    const label = `${i + 1}. ${a.tool}${Number(a.repeat) > 1 ? `×${a.repeat}` : ""}${a.find ? ` find="${a.find}"` : ""}`;
    const ts = Date.now();
    try {
      if (a.if_present !== undefined || a.if_absent !== undefined) {
        const tree = (app ? await currentTree(app, state) : "").toLowerCase();
        const skip = (a.if_present !== undefined && !tree.includes(String(a.if_present).toLowerCase())) || (a.if_absent !== undefined && tree.includes(String(a.if_absent).toLowerCase()));
        if (skip) { log.push(`${label} skipped (condition: ${a.if_present !== undefined ? `'${a.if_present}' absent` : `'${a.if_absent}' present`})`); continue; }
      }
      state.requeriedThisAction = false;
      const r = await runAction(app, a, state);
      if (state.recoverLog?.length) { log.push(...state.recoverLog); state.recoverLog = []; }
      if (r.result) last = r.result;
      const ms = `${Date.now() - ts} ms`;
      if (r.error) { if (a.optional) { log.push(`${label} skipped (optional, ${ms}): ${r.error.slice(0, 120)}`); continue; } log.push(`${label} ERROR (${ms}): ${r.error}`); failed = true; break; }
      log.push(`${label} ok (${ms})${r.note ? ` ${r.note}` : ""}`);
    } catch (e) { if (a.optional) { log.push(`${label} skipped (optional): ${e.message}`); continue; } log.push(`${label} ERROR (${Date.now() - ts} ms): ${e.message}`); failed = true; break; }
  }
  // Read the final state unless the last step already returned a fresh tree (observation steps).
  const lastIsFresh = !failed && last && state.lastTree && looksLikeTree(resultText(last)) && resultText(last) === state.lastTree && !isSoftError(last);
  if ((finalState || failed) && app && !lastIsFresh) {
    const st = await callUpstream("get_app_state", { app });
    if (!isSoftError(st) || !last) last = st;
  }
  log.push(`total ${Date.now() - t0} ms${state.requeried ? `, ${state.requeried} re-query` : ""}${lastIsFresh && finalState ? " (final read skipped)" : ""}`);
  return { last, log, before, failed };
}
// Package batch-like results (full / diff).
async function packBatch(title, { last, log, before, failed }, { wantShot, output, compact = true, app, shotOnError = true }) {
  const result = last || { content: [] };
  const shot = wantShot || (failed && shotOnError);
  let out;
  if (output !== "full") {
    const after = resultText(result);
    const img = shot ? (await shrinkScreenshot(result)).content.filter((c) => c.type === "image") : [];
    out = { content: [{ type: "text", text: `${title}:\n${log.join("\n")}\n\n[diff]\n${looksLikeTree(after) ? diffText(before, after, { compact }) : after.slice(0, 1500)}` }, ...img] };
  } else {
    const o = await finish(result, shot);
    out = { ...o, content: [{ type: "text", text: `${title}:\n${log.join("\n")}` }, ...(o.content || [])] };
  }
  if (failed) { out.isError = true; if (shot && !wantShot) out.content.push({ type: "text", text: "(screenshot attached because a step failed)" }); }
  return withNotes(out, app, resultText(result));
}

// In an open Open/Save panel: ⌘⇧G → path → Return → wait for the selection → confirm.
async function openPathInDialog(app, args, state) {
  const log = [];
  await callUpstream("press_key", { app, key: "super+shift+g" });
  const w = await waitFor(app, { text: "PathTextField", timeout_ms: 3000 }, state);
  if (!w.ok) return { ok: false, last: w.result, log: ["the Go to Folder field did not appear; is an Open/Save panel open?"] };
  const field = findInTree(state.lastTree, "/PathTextField/", { role: "text field" }).hit || findInTree(state.lastTree, "/PathTextField/").hit;
  if (!field) return { ok: false, last: w.result, log: ["PathTextField line not found in the tree"] };
  await callUpstream("set_value", { app, element_index: field.index, value: args.path });
  await callUpstream("press_key", { app, key: "Return" });
  const base = String(args.path).replace(/\/+$/, "").split("/").pop();
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await waitFor(app, { text: "PathTextField", timeout_ms: 3000, absent: true }, state);
  const sel = await waitFor(app, { re: `Value: ${esc}(,|$)`, timeout_ms: 3000 }, state);
  const navigated = sel.ok || !/PathTextField/.test(state.lastTree || "");
  log.push(`go-to: ${sel.ok ? `'${base}' selected` : navigated ? `navigated (no item named '${base}' selected; folder?)` : `'${base}' not reached`}`);
  let last = sel.result;
  if (args.confirm !== false && sel.ok) {
    const ok = findInTree(state.lastTree, "/\\bOKButton\\b/").hit || findInTree(state.lastTree, "/^button (Insert|Open|Save|Choose)\\b/").hit;
    if (ok && /\(disabled\)/.test(ok.rest)) log.push(`confirm: [${ok.index}] button disabled`);
    else {
      const panelRe = "PathTextField|OKButton|open-panel|save-panel|button Cancel";
      last = await callUpstream("press_key", { app, key: "Return" });
      let closed = await waitFor(app, { re: panelRe, timeout_ms: 1500, absent: true }, state);
      if (closed.ok) log.push("confirm: Return");
      else if (ok) { last = await callUpstream("click", { app, element_index: ok.index }); closed = await waitFor(app, { re: panelRe, timeout_ms: 3000, absent: true }, state); log.push(`confirm: Return did not close it → click [${ok.index}] ${ok.rest.slice(0, 30)}`); }
      if (!closed.ok) log.push("warning: the panel still seems open");
    }
  }
  if (!(state.lastTree && looksLikeTree(state.lastTree))) await readTree(app, state);
  return { ok: navigated, last: state.lastResult || last, log };
}

// ---------- script environment (cua_repl-like) ----------
// Not a trust boundary: the code runs in this process (node:vm shares host functions). The only caller is the model.
let scriptCtx = null;
function makeApp(appName, state) {
  const call = async (tool, args) => {
    if (state.cancelled) throw new Error("script timed out; no further actions are sent");
    const { __retried, ...rest } = args;
    const r = await callUpstream(tool, { app: appName, ...rest });
    const t = resultText(r);
    state.last = r;
    state.lastTree = looksLikeTree(t) ? t : (UI_ACTIONS.has(tool) ? null : state.lastTree); // action replies usually carry the fresh tree
    if (/Re-query the latest state/i.test(t) && !__retried) { await readTree(appName, state); return call(tool, { ...rest, __retried: true }); }
    if (r.isError || /server error/i.test(t.slice(0, 120))) { const e = new Error(t.slice(0, 300)); e.stop = STOP_CODES.test(t); throw e; }
    state.actions = (state.actions || 0) + 1;
    return t;
  };
  const fresh = async () => (state.lastTree && looksLikeTree(state.lastTree) ? state.lastTree : call("get_app_state", {}));
  const resolve = async (target) => {
    if (target && typeof target === "object" && !Array.isArray(target)) {
      if (target.find !== undefined) {
        const opts = { role: target.role, nth: target.nth };
        let hit = findInTree(await fresh(), target.find, opts).hit;
        if (!hit) hit = findInTree(await call("get_app_state", {}), target.find, opts).hit;
        if (!hit) throw new Error(`'${target.find}' not found in the tree`);
        return { element_index: hit.index };
      }
      if (target.x !== undefined && target.y !== undefined) return { x: target.x, y: target.y };
      throw new Error("target must be an index, [x,y] or {find}");
    }
    if (Array.isArray(target)) return { x: target[0], y: target[1] };
    return { element_index: String(target) };
  };
  const api = {
    name: appName,
    click: async (target, opts = {}) => call("click", { ...(await resolve(target)), ...opts }),
    pressKey: (key) => call("press_key", { key }),
    keys: async (key, n = 1) => { for (let i = 0; i < n; i++) await call("press_key", { key }); return state.lastTree; },
    typeText: (text) => call("type_text", { text }),
    paste: async (text, { format = "text" } = {}) => { const r = await pasteText(appName, text, format); state.lastTree = null; if (isSoftError(r)) throw new Error(resultText(r).slice(0, 300)); state.actions = (state.actions || 0) + 1; return resultText(r); },
    setValue: async (target, value) => call("set_value", { ...(await resolve(target)), value }),
    scroll: async (target, direction, pages = 1) => call("scroll", { ...(await resolve(target)), direction, pages }),
    drag: (a, b) => call("drag", { from_x: a[0], from_y: a[1], to_x: b[0], to_y: b[1] }),
    secondary: async (target, action) => call("perform_secondary_action", { ...(await resolve(target)), action }),
    selectText: async (target, text, extra = {}) => call("select_text", { ...(await resolve(target)), text, ...extra }),
    getAXState: () => call("get_app_state", {}),
    getAXStateAndScreenshot: async () => { state.wantShotAtEnd = true; return call("get_app_state", {}); },
    screenshot: async () => { state.wantShotAtEnd = true; return "(screenshot will be attached to the result)"; },
    find: (tree, query, opts = {}) => { const h = findInTree(tree, query, opts).hit; return h ? Number(h.index) : null; },
    findAll: (tree, query, opts = {}) => findInTree(tree, query, { limit: 50, ...opts }).candidates.map((c) => [Number(c.index), c.rest]),
    refind: async (query, opts = {}) => { const h = findInTree(await call("get_app_state", {}), query, opts).hit; return h ? Number(h.index) : null; },
    waitFor: async (text, { timeout = 4000, absent = false } = {}) => { const w = await waitFor(appName, isRegExp(text) ? { re: text, timeout_ms: timeout, absent } : { text, timeout_ms: timeout, absent }, state); if (!w.ok) throw new Error(w.error); return state.lastTree; },
    nudge: async (direction, n = 1, { shift = true } = {}) => { const k = `${shift ? "shift+" : ""}${{ up: "Up", down: "Down", left: "Left", right: "Right" }[direction] || direction}`; for (let i = 0; i < n; i++) await call("press_key", { key: k }); return state.lastTree; },
    menu: async (path) => {
      const target = path[path.length - 1];
      for (let i = 0; i < path.length; i++) {
        const tree = await fresh();
        const hitT = i > 0 && findInTree(tree, target).hit;
        const q = hitT ? target : path[i];
        const hit = findInTree(tree, q).hit || findInTree(await call("get_app_state", {}), q).hit;
        if (!hit) throw new Error(`menu: '${q}' not found`);
        await call("click", { element_index: hit.index });
        if (hitT || q === target) break;
      }
      return state.lastTree;
    },
    openPath: async (path, { confirm = true } = {}) => { const r = await openPathInDialog(appName, { path, confirm }, state); if (!r.ok) throw new Error(r.log.join("; ")); state.actions = (state.actions || 0) + 4; return state.lastTree; },
    pen: async (points) => {
      const clickFind = async (q) => { for (let k = 0; k < 3; k++) { const idx = findInTree(await call("get_app_state", {}), q).hit?.index; if (idx === undefined) { await sleep(300); continue; } try { await call("click", { element_index: idx }); return; } catch (e) { if (!/invalid|Re-query/i.test(e.message)) throw e; await sleep(300); } } throw new Error(`pen: '${q}' not found`); };
      await clickFind("Insert Shape"); await clickFind("Draw with Pen");
      for (const p of points) await call("click", { x: p[0], y: p[1] });
      await call("press_key", { key: "Return" }); await call("press_key", { key: "Escape" });
      return points.length;
    },
    deselect: (at = [40, 300]) => call("click", { x: at[0], y: at[1] }),
    raise: () => call("perform_secondary_action", { element_index: "0", action: "Raise" }),
    value: (tree, query, opts = {}) => valueOf(tree, query, opts),
    text: (tree, re) => { const m = stripBidi(tree).match(re); return m ? (m[1] ?? m[0]) : null; },
    lastTextUnder: (tree, query) => lastTextUnder(tree, query),
    compact: (tree, re) => String(tree).split("\n").filter((l) => re.test(l)).join("\n"),
    tail: (tree, n = 20) => String(tree).split("\n").slice(-n).join("\n"),
    help: () => "methods: " + Object.keys(api).filter((k) => k !== "name").join(", "),
  };
  // aliases for names the model tends to guess
  api.getState = api.getAXState; api.getScreenshot = api.screenshot; api.performSecondaryAction = api.secondary; api.type = api.typeText; api.press = api.pressKey;
  return api;
}
async function runScript(args) {
  const state = { lastTree: null, last: null, apps: new Set(), firstTrees: {}, logs: [], wantShotAtEnd: false, cancelled: false };
  const addLog = (...a) => { if (state.logs.length < 500) state.logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); else if (state.logs.length === 500) state.logs.push("(log truncated at 500 lines)"); };
  if (args.reset || !scriptCtx) {
    scriptCtx = vm.createContext({ console: { log: addLog }, Math, JSON, Array, Object, String, Number, RegExp, Set, Map, Promise, Date, Error, setTimeout, clearTimeout });
  }
  scriptCtx.cua = {
    getApp: async (name) => { state.apps.add(name); const app = makeApp(name, state); const t = await app.getAXState(); state.firstTrees[key(name)] ??= t; return app; },
    listApps: async () => resultText(await callUpstream("list_apps", {})),
  };
  scriptCtx.sleep = sleep;
  scriptCtx.log = addLog;
  const t0 = Date.now();
  let error = null;
  const timeoutMs = Number(args.timeout_ms ?? 120000);
  try {
    const fn = vm.runInContext(`(async () => { ${args.code}\n })`, scriptCtx, { timeout: 5000 }); // compile only
    await Promise.race([fn(), sleep(timeoutMs).then(() => { state.cancelled = true; throw new Error(`script timed out after ${timeoutMs} ms (no further actions are sent)`); })]);
  } catch (e) { error = e?.message || String(e); if (error && /not a function/.test(error)) error += " — call app.help() for the method list"; }
  const appName = args.app || [...state.apps][0];
  const header = [`script: ${error ? "ERROR: " + error : "ok"} (${Date.now() - t0} ms, ${state.actions || 0} actions)`, ...state.logs.map((l) => `  ${l}`)].join("\n");
  const output = args.output || "diff";
  const wantShot = args.include_screenshot || state.wantShotAtEnd || wantsScreenshotByDefault(appName);
  if (output === "none" || !appName) {
    const shot = wantShot && appName ? (await shrinkScreenshot(await callUpstream("get_app_state", { app: appName }))).content.filter((c) => c.type === "image") : [];
    return { content: [{ type: "text", text: header }, ...shot], isError: !!error || undefined };
  }
  const before = state.firstTrees[key(appName)] || cachedTree(appName);
  const last = await callUpstream("get_app_state", { app: appName });
  const after = resultText(last);
  const body = output === "diff" ? `[diff]\n${looksLikeTree(after) ? diffText(before, after) : after.slice(0, 1500)}` : after;
  const shot = wantShot ? (await shrinkScreenshot(last)).content.filter((c) => c.type !== "text") : [];
  return withNotes({ content: [{ type: "text", text: `${header}\n\n${body}` }, ...shot], isError: !!error || undefined }, appName, after);
}

// ---------- tool calls ----------
async function callTool(name, rawArgs) {
  await ensureUpstream();
  if (name === "script") return runScript(rawArgs || {});
  const args = { ...(rawArgs || {}) };
  const wantShot = args.include_screenshot ?? (wantsScreenshotByDefault(args.app) || DEFAULT_SCREENSHOT);
  delete args.include_screenshot;

  if (name === "batch" || name === "run_macro") {
    let actions = args.actions, app = args.app, title = "batch";
    if (name === "run_macro") {
      const macro = loadMacros()[args.name];
      if (!macro) return fail(`no macro named '${args.name}' (${MACRO_FILE})`);
      const missing = (macro.params || []).filter((k) => (args.params || {})[k] === undefined);
      if (missing.length) return fail(`missing parameters: ${missing.join(", ")}`);
      actions = substitute(macro.actions, args.params || {}); app = args.app || macro.app; title = `run_macro ${args.name}`;
    } else if (args.params) actions = substitute(actions, args.params);
    const res = await runBatch(app, actions, { finalState: args.final_state !== false, autoRecover: args.auto_recover !== false, captureBefore: true, dryRun: !!args.dry_run });
    if (args.dry_run) return { content: [{ type: "text", text: `${title} (dry-run, nothing was done):\n${res.log.join("\n")}` }] };
    if (name === "batch" && args.save_as && !res.failed) {
      const macros = loadMacros();
      macros[args.save_as] = { description: args.save_description || "", app: args.app, params: [...new Set([...JSON.stringify(args.actions).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))], actions: args.actions, saved_at: new Date().toISOString() };
      saveMacros(macros); res.log.push(`macro saved: ${args.save_as}`);
    }
    return packBatch(title, res, { wantShot, output: args.output || "diff", compact: args.compact !== false, app, shotOnError: args.screenshot_on_error !== false });
  }

  if (name === "status") {
    const t0 = Date.now();
    const pg = async (pat) => (await run("pgrep", ["-f", pat])).code === 0;
    const SOCK = join(homedir(), "Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock");
    const sock = existsSync(SOCK);
    const [app, server, svc, client] = await Promise.all([pg(`${CODEX_APP_NAME}.app/Contents/MacOS/${CODEX_APP_NAME}`), pg("codex .*app-server"), pg("SkyComputerUseService"), pg("SkyComputerUseClient mcp")]);
    let ping = null, apps = null;
    try { const r = await upRequest("tools/call", { name: "list_apps", arguments: {} }); ping = Date.now() - t0; apps = resultText(r).split("\n").filter((l) => /\[(frontmost|running)/.test(l)).length; } catch (e) { ping = `error: ${e.message}`; }
    const macros = Object.keys(loadMacros());
    const lines = [
      `codex-cua-plus ${VERSION} | node ${process.version} | bridge idle ${process.env.COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS || "60000"} ms | screenshots default ${DEFAULT_SCREENSHOT ? "on" : "off"} (${SCREENSHOT_MAX_PX} px) | output default ${DEFAULT_OUTPUT}`,
      `${CODEX_APP_NAME}.app: ${app ? "running" : "NOT RUNNING (the service needs it; the wrapper launches it on 'app-server exited')"}`,
      `codex app-server: ${server ? "yes" : "no"} | SkyComputerUseService: ${svc ? "running" : "no"}${sock ? " (socket present)" : " (socket missing)"} | SkyComputerUseClient: ${client ? "running" : "idle/closed (starts on the first call)"}`,
      `list_apps ping: ${typeof ping === "number" ? `${ping} ms` : ping}${apps !== null ? ` (${apps} running apps)` : ""}`,
      `macros (${macros.length}): ${macros.join(", ") || "-"} → ${MACRO_FILE}${macrosBroken ? " (INVALID JSON)" : ""}`,
      `notes: ${Object.keys(BUILTIN_NOTES).filter((k) => !k.startsWith("_")).join(", ")} (built-in)${existsSync(NOTES_FILE) ? ` + ${NOTES_FILE}` : ""}`,
      `timing (measured in the service): UI-changing action ≈0.5 s (settle wait), first action after get_app_state ≈0.9 s, observation ≈60 ms, modifier-only keys ≈10 ms`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "paste") {
    const before = cachedTree(args.app);
    const r = await pasteText(args.app, args.text, args.format);
    if (isSoftError(r)) return finish(r, wantShot);
    const st = await callUpstream("get_app_state", { app: args.app });
    return withNotes(await finish(renderResult(st, before, args.output || DEFAULT_OUTPUT), wantShot), args.app);
  }

  if (name === "screenshot") {
    const st = await callUpstream("get_app_state", { app: args.app });
    const img = (st.content || []).find((c) => c.type === "image");
    if (!img) return fail(`no screenshot in the response.\n${resultText(st).slice(0, 500)}`);
    const buf = Buffer.from(img.data, "base64");
    const dims = imageDims(buf);
    const dir = mkdtempSync(join(tmpdir(), "cua-plus-")); const f = join(dir, `s.${dims?.ext || "jpg"}`);
    try {
      writeFileSync(f, buf);
      const notes = [`Original ${dims?.w ?? "?"}×${dims?.h ?? "?"} px (click coordinates use this resolution).`];
      if (args.region) {
        const [x0, y0, x1, y1] = args.region.map((v) => Math.round(v));
        const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
        const c = await run("sips", ["-c", String(h), String(w), "--cropOffset", String(y0), String(x0), f]);
        if (c.code !== 0) return fail("crop failed (is the region inside the screenshot?)");
        notes.push(`Region [${x0},${y0}]–[${x1},${y1}] cropped: pixel in the crop + (${x0},${y0}) = original coordinate.`);
      }
      const maxPx = num(args.max_px, SCREENSHOT_MAX_PX);
      let out = readFileSync(f);
      let d = imageDims(out) || dims;
      if (maxPx && d && Math.max(d.w, d.h) > maxPx) {
        await run("sips", ["-Z", String(maxPx), ...(d.ext === "jpg" ? ["-s", "formatOptions", String(JPEG_QUALITY)] : []), f]);
        out = readFileSync(f); const nd = imageDims(out) || d;
        notes.push(`Downscaled to ${nd.w}×${nd.h} px; multiplier ${(d.w / nd.w).toFixed(3)}.`); d = nd;
      }
      return { content: [{ type: "text", text: `${windowLine(resultText(st))}\n${notes.join(" ")}` }, { type: "image", data: out.toString("base64"), mimeType: d?.ext === "png" ? "image/png" : "image/jpeg" }] };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  if (name === "recover") {
    const state = { lastTree: null };
    const r = await recover(args.app, state);
    const out = await finish(state.lastResult || { content: [] }, wantShot);
    return { ...out, isError: !r.ok || undefined, content: [{ type: "text", text: `recover ${r.ok ? "succeeded" : "FAILED"}:\n${r.log.join("\n")}` }, ...(out.content || [])] };
  }

  if (name === "save_macro") {
    const macros = loadMacros();
    macros[args.name] = { description: args.description || "", app: args.app, params: args.params || [], actions: args.actions, saved_at: new Date().toISOString() };
    saveMacros(macros);
    return { content: [{ type: "text", text: `macro saved: ${args.name} (${args.actions.length} steps) → ${MACRO_FILE}` }] };
  }
  if (name === "list_macros") {
    const macros = loadMacros();
    const rows = Object.entries(macros).map(([n, m]) => `- ${n}: ${m?.description || "(no description)"} | app=${m?.app || "-"} | params=${(m?.params || []).join(",") || "-"} | ${(m?.actions || []).length} steps`);
    return { content: [{ type: "text", text: rows.length ? rows.join("\n") : `no saved macros (${MACRO_FILE})${macrosBroken ? " — file is not valid JSON" : ""}` }] };
  }

  if (name === "menu") {
    const state = { lastTree: null };
    const log = [];
    let last = null, failed = false;
    const path = args.path;
    const target = path[path.length - 1];
    const click = async (q) => {
      const r = await runAction(args.app, { tool: "click", find: q }, state);
      if (r.result) last = r.result;
      if (r.error) { log.push(`click "${q}" ERROR: ${r.error}`); failed = true; return false; }
      log.push(`click "${q}" ok ${r.note || ""}`); return true;
    };
    for (let i = 0; i < path.length; i++) {
      if (i > 0 && findInTree(await currentTree(args.app, state), target).hit) { if (await click(target)) log.push("(intermediate items skipped: target was visible)"); break; }
      if (!(await click(path[i]))) break;
    }
    const st = failed ? last : await callUpstream("get_app_state", { app: args.app });
    const out = await finish(st || { content: [] }, wantShot);
    return withNotes({ ...out, isError: failed || undefined, content: [{ type: "text", text: `menu ${path.join(" > ")}:\n${log.join("\n")}` }, ...(out.content || [])] }, args.app, resultText(st));
  }

  if (name === "find_elements") {
    const st = await callUpstream("get_app_state", { app: args.app });
    const t = resultText(st);
    if (isSoftError(st)) return stripScreenshot(st);
    const limit = Number(args.limit ?? 20);
    const res = findInTree(t, args.query, { role: args.role, limit });
    const win = t.match(/Window: "([^"]*)"/)?.[1];
    return { content: [{ type: "text", text: `Window: "${win ?? "?"}" — ${res.candidates.length} match(es) for '${args.query}':\n${res.candidates.map((c) => `${c.index} ${c.rest}`).join("\n") || "(none)"}` }] };
  }

  if (name === "open_path_in_dialog") {
    const state = { lastTree: null };
    const r = await openPathInDialog(args.app, args, state);
    const out = await finish(r.last || { content: [] }, wantShot);
    return { ...out, isError: !r.ok || undefined, content: [{ type: "text", text: `open_path_in_dialog:\n${r.log.join("\n")}` }, ...(out.content || [])] };
  }

  // ---- pass-through tools ----
  const output = args.output || DEFAULT_OUTPUT; delete args.output;
  const observe = args.observe !== false; delete args.observe;
  const before = cachedTree(args.app);
  const timeoutMs = args.timeout_ms; delete args.timeout_ms;

  if ((TARGETABLE.has(name) && args.find) || (name === "press_key" && args.repeat)) {
    const action = { tool: name, args: { ...args, find: undefined, role: undefined, nth: undefined, repeat: undefined }, find: args.find, role: args.role, nth: args.nth, repeat: args.repeat, timeout_ms: timeoutMs };
    const res = await runBatch(args.app, [action], { finalState: observe });
    const out = await finish(renderResult(res.last || { content: [] }, before, output), wantShot);
    return withNotes({ ...out, isError: res.failed || undefined, content: [{ type: "text", text: res.log.join("\n") }, ...(out.content || [])] }, args.app, resultText(res.last));
  }
  delete args.find; delete args.role; delete args.nth; delete args.repeat;

  let r = await callUpstream(name, args);
  if (name === "list_apps") return r;
  if (UI_ACTIONS.has(name) && observe && !isSoftError(r) && !looksLikeTree(resultText(r))) {
    // Action replies normally carry the fresh tree; when one doesn't ("Action completed…"), read it now (≈60 ms) so the model gets the diff in the same turn.
    const st = await callUpstream("get_app_state", { app: args.app });
    if (!isSoftError(st)) r = { ...st, content: [...(st.content || [])] };
  }
  return withNotes(await finish(renderResult(r, before, output), wantShot), args.app, resultText(r));
}

// ---------- downstream (Claude Code) ----------
// tools/call requests are serialised: Computer Use drives one screen, and parallel calls would interleave actions.
let chain = Promise.resolve();
function enqueue(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }
createInterface({ input: process.stdin }).on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { debug(`non-JSON line from client: ${line.slice(0, 120)}`); return; }
  if (m.id !== undefined && m.method === undefined && forwarded.has(m.id)) { // reply to an upstream-initiated request
    const origId = forwarded.get(m.id); forwarded.delete(m.id);
    upSend({ ...m, id: origId });
    return;
  }
  if (m.id === undefined) { if (m.method === "notifications/initialized") return; if (m.method?.startsWith("notifications/")) upSend(m); return; }
  try {
    let result;
    switch (m.method) {
      case "initialize": result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-cua-plus", version: VERSION } }; break;
      case "ping": result = {}; break;
      case "tools/list": result = await listTools(); break;
      case "tools/call": {
        const t = listToolNames();
        if (t && !t.has(m.params?.name)) { send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params?.name}` } }); return; }
        result = await enqueue(() => callTool(m.params?.name, m.params?.arguments).catch((e) => fail(`error: ${e.message}`)));
        break;
      }
      default: send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } }); return;
    }
    send({ jsonrpc: "2.0", id: m.id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: e.message } });
  }
}).on("close", () => shutdown("stdin closed"));
function listToolNames() { return toolListCache ? new Set(toolListCache.tools.map((t) => t.name)) : null; }
