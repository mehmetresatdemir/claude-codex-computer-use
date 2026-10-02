#!/usr/bin/env node
// codex-cua-plus: wrapper MCP server in front of the claude-codex-computer-use bridge.
// Passes the upstream Computer Use tools through and adds: script (persistent JS), batch, text targeting (find),
// wait_for, menu, find_elements, paste, open_path_in_dialog, recover, macros, app notes, diff output, key-name
// normalisation, named service errors, screenshot downscaling and ChatGPT.app auto-launch.
// No dependencies; Node >= 22. Modules: lib/config, lib/upstream, lib/tools, lib/notes, lib/pure (unit-tested).
//
//   node server.mjs            run as an MCP server on stdio
//   node server.mjs doctor     check prerequisites without an MCP client
//   node server.mjs --version | --help
import vm from "node:vm";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, debug, VERSION, DATA_DIR, MACRO_FILE, NOTES_FILE, CONFIG_FILE, SERVICE_SOCKET, OPTIONS } from "./lib/config.mjs";
import { createUpstream, bridgeEnv } from "./lib/upstream.mjs";
import { EXTRA_TOOLS, TARGETABLE, FOCUS_THEN_ACT, decorateUpstreamTools } from "./lib/tools.mjs";
import { withNotes, splitInstructions, wantsScreenshotByDefault, builtinNoteKeys } from "./lib/notes.mjs";
import {
  resultText, isSoftError, parseTree, looksLikeTree, treeRootIsMenu, windowLine, focusLine,
  diffText, substitute, findInTree, lastTextUnder, stripBidi, valueOf, normalizeKey,
  annotateServiceError, STOP_CODES, SERVICE_DOWN, UI_ACTIONS, imageDims,
} from "./lib/pure.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRegExp = (x) => Object.prototype.toString.call(x) === "[object RegExp]"; // works across vm realms
const key = (app) => String(app || "").toLowerCase();
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
function fail(text, extra = {}) { return { content: [{ type: "text", text }], isError: true, ...extra }; }
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

// ---------- CLI ----------
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) { console.log(VERSION); process.exit(0); }
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`codex-cua-plus ${VERSION} — wrapper MCP server for Codex Computer Use (Claude Code)\n\nUsage:\n  node server.mjs            MCP server on stdio (register with scripts/install.sh)\n  node server.mjs doctor     check prerequisites\n  node server.mjs --version\n\nOptions (environment, or ${CONFIG_FILE}):\n` + OPTIONS.map(([k, d, h]) => `  ${k.padEnd(36)} ${h}${d ? ` [${d}]` : ""}`).join("\n"));
  process.exit(0);
}
if (argv[0] === "doctor") { doctor().then((ok) => process.exit(ok ? 0 : 1)); }
else main();

async function doctor() {
  const rows = [];
  const check = (ok, label, hint = "") => { rows.push(`${ok ? "ok  " : "FAIL"} ${label}${!ok && hint ? ` — ${hint}` : ""}`); return ok; };
  let all = true;
  all &= check(process.platform === "darwin", `platform ${process.platform}`, "macOS only");
  const [maj, min] = process.versions.node.split(".").map(Number);
  all &= check(maj > 22 || (maj === 22 && min >= 14), `node ${process.version}`, "Node >= 22.14 is required (the bridge uses it)");
  const app = `/Applications/${config.appName}.app`;
  all &= check(existsSync(app), `${app}`, "install the ChatGPT/Codex desktop app");
  const launcher = process.env.COMPUTER_USE_CODEX_LAUNCHER_PATH || `${app}/Contents/Resources/codex-cli/bin/codex`;
  all &= check(existsSync(launcher), `codex launcher ${launcher}`, "set COMPUTER_USE_CODEX_LAUNCHER_PATH");
  const client = process.env.COMPUTER_USE_CLIENT_PATH || `${process.env.HOME}/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
  all &= check(existsSync(client), `client ${client}`, "install Computer Use from the ChatGPT app settings, or set COMPUTER_USE_CLIENT_PATH");
  const running = (await run("pgrep", ["-f", `${config.appName}.app/Contents/MacOS/${config.appName}`])).code === 0;
  check(running, `${config.appName}.app running`, "the service only runs while the app is open (the wrapper launches it on demand)");
  check(existsSync(SERVICE_SOCKET), `service socket ${SERVICE_SOCKET}`, "appears after the app starts Computer Use");
  const npxOk = (await run(config.npx, ["--version"])).code === 0;
  all &= check(npxOk, `npx (${config.npx})`, "set CUA_PLUS_NPX to the Node 22 npx");
  for (const f of [MACRO_FILE, NOTES_FILE, CONFIG_FILE]) {
    if (!existsSync(f)) { rows.push(`-    ${f} (absent, optional)`); continue; }
    try { JSON.parse(readFileSync(f, "utf8")); check(true, f); } catch (e) { all &= check(false, f, `invalid JSON: ${e.message}`); }
  }
  console.log(`codex-cua-plus ${VERSION} doctor\n` + rows.join("\n"));
  return !!all;
}

function main() {
  // ---------- upstream ----------
  const bridgeCmd = config.bridgeCmd || config.npx;
  const bridgeArgs = config.bridgeCmd ? (config.bridgeArgs || []) : ["-y", "claude-codex-computer-use@latest"];
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const up = createUpstream({
    cmd: bridgeCmd, args: bridgeArgs, env: bridgeEnv(), timeoutMs: config.upstreamTimeoutMs, sendDown: send, debug,
    onExit: (code) => process.exit(code ?? 1), clientInfo: { name: "codex-cua-plus", version: VERSION },
  });
  const shutdown = (why) => { debug(`${why}: stopping the upstream chain`); up.shutdown(); setTimeout(() => process.exit(0), 300); };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig));

  // ---------- screenshots ----------
  function stripScreenshot(result) {
    if (!result?.content) return result;
    const content = result.content.filter((c) => c.type !== "image");
    content.push({ type: "text", text: "(screenshot omitted; pass include_screenshot:true to get it)" });
    return { ...result, content };
  }
  async function shrinkScreenshot(result, maxPx = config.screenshotMaxPx) {
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
      const { code } = await run("sips", ["-Z", String(maxPx), ...(dims.ext === "jpg" ? ["-s", "formatOptions", String(config.jpegQuality)] : []), file]);
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
  const finish = (result, wantShot) => (wantShot ? shrinkScreenshot(result) : stripScreenshot(result));

  // ---------- macros ----------
  let macrosBroken = false;
  function loadMacros() {
    try { macrosBroken = false; return existsSync(MACRO_FILE) ? JSON.parse(readFileSync(MACRO_FILE, "utf8")) : {}; }
    catch (e) { macrosBroken = true; debug(`macros.json unreadable: ${e.message}`); return {}; }
  }
  function saveMacros(m) {
    if (macrosBroken) throw new Error(`${MACRO_FILE} is not valid JSON; fix or remove it before saving macros (refusing to overwrite).`);
    mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(MACRO_FILE, JSON.stringify(m, null, 2));
  }

  // ---------- service / app health ----------
  let launchingApp = null;
  async function ensureCodexAppRunning() {
    if (launchingApp) return launchingApp;
    launchingApp = (async () => {
      debug(`launching ${config.appName}.app (service down)`);
      await run("open", ["-g", "-a", config.appName]);
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if ((await run("pgrep", ["-f", "codex .*app-server"])).code === 0) { await sleep(3000); return true; }
      }
      return false;
    })();
    try { return await launchingApp; } finally { setTimeout(() => { launchingApp = null; }, 10000); }
  }
  const treeCache = new Map(); // last full tree per app (diff base across calls)
  const cacheTree = (app, text) => { if (app && looksLikeTree(text)) treeCache.set(key(app), text); };
  const cachedTree = (app) => (app ? treeCache.get(key(app)) || null : null);
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
      try { return await up.request("tools/call", { name, arguments: args }); }
      catch (e) { return fail(`${e.message}${e.code !== undefined ? ` (code ${e.code})` : ""}`); }
    };
    let r = await attempt();
    if (SERVICE_DOWN.test(resultText(r))) {
      if (await ensureCodexAppRunning()) r = await attempt();
      if (SERVICE_DOWN.test(resultText(r))) r.content.push({ type: "text", text: `Note: the Codex Computer Use service runs only while ${config.appName}.app is open; it could not be launched or the service did not come up.` });
    }
    r = splitInstructions(r, args?.app);
    const t = resultText(r);
    cacheTree(args?.app, t);
    r = annotateServiceError(r);
    for (const [re, hint] of PLAIN_TEXT_ERRORS) if (re.test(t)) { r = { ...r, content: [...r.content, { type: "text", text: hint }] }; break; }
    if (looksLikeTree(t) && treeRootIsMenu(t)) r = { ...r, content: [...r.content, { type: "text", text: "Note: the tree root is an open menu (stuck menu); use recover or perform_secondary_action(0,'Cancel') before other actions." }] };
    return r;
  }
  function renderResult(result, before, output) {
    const after = resultText(result);
    if (output !== "diff" || !before || !looksLikeTree(after)) return result;
    const texts = result.content.filter((c) => c.type === "text");
    const others = result.content.filter((c) => c.type !== "text");
    const extra = texts.slice(1).map((c) => c.text);
    return { ...result, content: [{ type: "text", text: `[diff]\n${diffText(before, after)}` }, ...extra.map((t) => ({ type: "text", text: t })), ...others] };
  }

  // ---------- clipboard paste (the MCP client has no paste tool; Codex's REPL does) ----------
  async function pasteText(app, text, format = "text") {
    const old = await run("pbpaste", []);
    const put = format === "html"
      ? await run("sh", ["-c", "textutil -stdin -format html -convert rtf -stdout | pbcopy -Prefer rtf"], text)
      : await run("pbcopy", [], text);
    if (put.code !== 0) return fail(`clipboard write failed (${put.error || put.code})`);
    const r = await callUpstream("press_key", { app, key: "super+v" });
    if (old.code === 0) await run("pbcopy", [], old.out); // restore the user's clipboard (text content only)
    return r;
  }

  // ---------- tool list ----------
  let toolListCache = null;
  async function listTools() {
    await up.ensureInitialized();
    if (toolListCache) return toolListCache;
    const r = await up.request("tools/list", {});
    toolListCache = { tools: [...decorateUpstreamTools(r.tools), ...EXTRA_TOOLS] };
    return toolListCache;
  }

  // ---------- running actions ----------
  // state.lastTree: the latest tree observed in this call; cleared after every UI action unless the reply carried a fresh tree.
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
    const check = async (label) => { await readTree(app, state); const stuck = treeRootIsMenu(state.lastTree); log.push(`${label}: ${stuck ? "root is still a menu" : "recovered"}`); return !stuck; };
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
    const tree = await currentTree(app, state);
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
    return { ok: false, result: last, error: `wait_for timed out (${timeout_ms} ms): ${rx ? String(rx) : `'${text}'`} ${absent ? "still present" : "did not appear"}` };
  }
  const RETRY_RE = /Re-query the latest state|invalid element ID|element ID is no longer valid|invalid_element_id/i;
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
    if (action.tool === "open_path_in_dialog") { const r = await openPathInDialog(app, args, state); return r.ok ? { result: r.last, note: r.log.join("; ") } : { result: r.last, error: r.log.join("; ") }; }
    if (action.tool === "recover") { const r = await recover(app, state); return r.ok ? { result: state.lastResult, note: r.log.join("; ") } : { result: state.lastResult, error: r.log.join("; ") }; }
    if (action.tool === "paste") {
      const r = await pasteText(app, args.text, args.format);
      state.lastTree = looksLikeTree(resultText(r)) ? resultText(r) : null;
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
          state.lastTree = looksLikeTree(resultText(f)) ? resultText(f) : null;
          if (isSoftError(f)) return { result: f, error: `focus click: ${resultText(f).slice(0, 120)}` };
        }
      } else args.element_index = target.index;
    }
    delete args.find; delete args.role; delete args.nth;
    const n = action.repeat ?? 1;
    let last, retried = false;
    for (let i = 0; i < n; i++) {
      last = await callUpstream(action.tool, args);
      let t = resultText(last);
      if (UI_ACTIONS.has(action.tool)) state.lastTree = null;
      if (RETRY_RE.test(t) && !retried) { // user changed the app or stale index: read again, re-resolve, retry once
        retried = true;
        await readTree(app, state);
        if (action.find) { const tg = await resolveTarget(app, action, state); if (!tg.ok) return { result: state.lastResult, error: tg.error }; if (tg.index !== undefined) args.element_index = tg.index; }
        last = await callUpstream(action.tool, args); t = resultText(last);
        if (UI_ACTIONS.has(action.tool)) state.lastTree = null;
        state.requeried = (state.requeried || 0) + 1;
      }
      if (looksLikeTree(t)) { state.lastTree = t; state.lastResult = last; }
      if (STOP_CODES.test(t)) return { result: last, error: "the user stopped Computer Use or intervened; batch aborted — " + t.slice(0, 160) };
      if (isSoftError(last)) return { result: last, error: t.slice(0, 200) };
      if (n > 1 && i < n - 1) await sleep(config.keyDelayMs);
    }
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
        const r = await runAction(app, a, state);
        if (state.recoverLog?.length) { log.push(...state.recoverLog); state.recoverLog = []; }
        if (r.result) last = r.result;
        const ms = `${Date.now() - ts} ms`;
        if (r.error) { if (a.optional) { log.push(`${label} skipped (optional, ${ms}): ${r.error.slice(0, 120)}`); continue; } log.push(`${label} ERROR (${ms}): ${r.error}`); failed = true; break; }
        log.push(`${label} ok (${ms})${r.note ? ` ${r.note}` : ""}`);
      } catch (e) { if (a.optional) { log.push(`${label} skipped (optional): ${e.message}`); continue; } log.push(`${label} ERROR (${Date.now() - ts} ms): ${e.message}`); failed = true; break; }
    }
    const lastIsFresh = !failed && last && state.lastTree && looksLikeTree(resultText(last)) && resultText(last) === state.lastTree && !isSoftError(last);
    if ((finalState || failed) && app && !lastIsFresh) {
      const st = await callUpstream("get_app_state", { app });
      if (!isSoftError(st) || !last) last = st;
    }
    log.push(`total ${Date.now() - t0} ms${state.requeried ? `, ${state.requeried} re-query` : ""}${lastIsFresh && finalState ? " (final read skipped)" : ""}`);
    return { last, log, before, failed };
  }
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
      state.lastTree = looksLikeTree(t) ? t : (UI_ACTIONS.has(tool) ? null : state.lastTree);
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
      pressKey: (k) => call("press_key", { key: k }),
      keys: async (k, n = 1) => { for (let i = 0; i < n; i++) await call("press_key", { key: k }); return state.lastTree; },
      typeText: (text) => call("type_text", { text }),
      paste: async (text, { format = "text" } = {}) => { const r = await pasteText(appName, text, format); state.lastTree = looksLikeTree(resultText(r)) ? resultText(r) : null; if (isSoftError(r)) throw new Error(resultText(r).slice(0, 300)); state.actions = (state.actions || 0) + 1; return resultText(r); },
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
    api.getState = api.getAXState; api.getScreenshot = api.screenshot; api.performSecondaryAction = api.secondary; api.type = api.typeText; api.press = api.pressKey;
    return api;
  }
  async function runScript(args) {
    const state = { lastTree: null, last: null, apps: new Set(), firstTrees: {}, logs: [], wantShotAtEnd: false, cancelled: false };
    const addLog = (...a) => { if (state.logs.length < 500) state.logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); else if (state.logs.length === 500) state.logs.push("(log truncated at 500 lines)"); };
    if (args.reset || !scriptCtx) scriptCtx = vm.createContext({ console: { log: addLog }, Math, JSON, Array, Object, String, Number, RegExp, Set, Map, Promise, Date, Error, setTimeout, clearTimeout });
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
      const fn = vm.runInContext(`(async () => { ${args.code}\n })`, scriptCtx, { timeout: 5000 });
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { state.cancelled = true; reject(new Error(`script timed out after ${timeoutMs} ms (no further actions are sent)`)); }, timeoutMs); });
      try { await Promise.race([fn(), timeout]); } finally { clearTimeout(timer); } // a timer left running would cancel app objects reused by later calls
    } catch (e) { error = e?.message || String(e); if (/not a function/.test(error)) error += " — call app.help() for the method list"; }
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
    await up.ensureInitialized();
    if (name === "script") return runScript(rawArgs || {});
    const args = { ...(rawArgs || {}) };
    const wantShot = args.include_screenshot ?? (wantsScreenshotByDefault(args.app) || config.defaultScreenshot);
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
      const [app, server, svc, client] = await Promise.all([pg(`${config.appName}.app/Contents/MacOS/${config.appName}`), pg("codex .*app-server"), pg("SkyComputerUseService"), pg("SkyComputerUseClient mcp")]);
      let ping = null, apps = null;
      try { const r = await up.request("tools/call", { name: "list_apps", arguments: {} }); ping = Date.now() - t0; apps = resultText(r).split("\n").filter((l) => /\[(frontmost|running)/.test(l)).length; } catch (e) { ping = `error: ${e.message}`; }
      const macros = Object.keys(loadMacros());
      const lines = [
        `codex-cua-plus ${VERSION} | node ${process.version} | bridge idle ${config.bridgeIdleMs} ms | screenshots default ${config.defaultScreenshot ? "on" : "off"} (${config.screenshotMaxPx} px) | output default ${config.defaultOutput}`,
        `${config.appName}.app: ${app ? "running" : "NOT RUNNING (the service needs it; the wrapper launches it on 'app-server exited')"}`,
        `codex app-server: ${server ? "yes" : "no"} | SkyComputerUseService: ${svc ? "running" : "no"}${existsSync(SERVICE_SOCKET) ? " (socket present)" : " (socket missing)"} | SkyComputerUseClient: ${client ? "running" : "idle/closed (starts on the first call)"}`,
        `list_apps ping: ${typeof ping === "number" ? `${ping} ms` : ping}${apps !== null ? ` (${apps} running apps)` : ""}`,
        `macros (${macros.length}): ${macros.join(", ") || "-"} → ${MACRO_FILE}${macrosBroken ? " (INVALID JSON)" : ""}`,
        `notes: ${builtinNoteKeys().join(", ")} (built-in)${existsSync(NOTES_FILE) ? ` + ${NOTES_FILE}` : ""}${existsSync(CONFIG_FILE) ? ` | config ${CONFIG_FILE}` : ""}`,
        "timing (measured in the service): UI-changing action ≈0.5 s (settle wait), first action after get_app_state ≈0.9 s, observation ≈60 ms, modifier-only keys ≈10 ms",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (name === "paste") {
      const before = cachedTree(args.app);
      const r = await pasteText(args.app, args.text, args.format);
      if (isSoftError(r)) return finish(r, wantShot);
      const st = looksLikeTree(resultText(r)) ? r : await callUpstream("get_app_state", { app: args.app });
      return withNotes(await finish(renderResult(st, before, args.output || config.defaultOutput), wantShot), args.app);
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
        const maxPx = num(args.max_px, config.screenshotMaxPx);
        let out = readFileSync(f);
        let d = imageDims(out) || dims;
        if (maxPx && d && Math.max(d.w, d.h) > maxPx) {
          await run("sips", ["-Z", String(maxPx), ...(d.ext === "jpg" ? ["-s", "formatOptions", String(config.jpegQuality)] : []), f]);
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
      const st = failed ? last : (state.lastTree && looksLikeTree(state.lastTree) ? state.lastResult : await callUpstream("get_app_state", { app: args.app }));
      const out = await finish(st || { content: [] }, wantShot);
      return withNotes({ ...out, isError: failed || undefined, content: [{ type: "text", text: `menu ${path.join(" > ")}:\n${log.join("\n")}` }, ...(out.content || [])] }, args.app, resultText(st));
    }
    if (name === "find_elements") {
      const st = await callUpstream("get_app_state", { app: args.app });
      const t = resultText(st);
      if (isSoftError(st)) return stripScreenshot(st);
      const res = findInTree(t, args.query, { role: args.role, limit: Number(args.limit ?? 20) });
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
    const output = args.output || config.defaultOutput; delete args.output;
    const observe = args.observe !== false; delete args.observe;
    const before = cachedTree(args.app);
    if ((TARGETABLE.has(name) && args.find) || (name === "press_key" && args.repeat)) {
      const action = { tool: name, args: { ...args, find: undefined, role: undefined, nth: undefined, repeat: undefined }, find: args.find, role: args.role, nth: args.nth, repeat: args.repeat };
      const res = await runBatch(args.app, [action], { finalState: observe });
      const out = await finish(renderResult(res.last || { content: [] }, before, output), wantShot);
      return withNotes({ ...out, isError: res.failed || undefined, content: [{ type: "text", text: res.log.join("\n") }, ...(out.content || [])] }, args.app, resultText(res.last));
    }
    delete args.find; delete args.role; delete args.nth; delete args.repeat;
    let r = await callUpstream(name, args);
    if (name === "list_apps") return r;
    if (UI_ACTIONS.has(name) && observe && !isSoftError(r) && !looksLikeTree(resultText(r))) {
      const st = await callUpstream("get_app_state", { app: args.app }); // the reply carried no tree: read it now (≈60 ms)
      if (!isSoftError(st)) r = st;
    }
    return withNotes(await finish(renderResult(r, before, output), wantShot), args.app, resultText(r));
  }

  // ---------- downstream (Claude Code) ----------
  // tools/call requests are serialised: Computer Use drives one screen; parallel calls would interleave actions.
  let chain = Promise.resolve();
  const enqueue = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let m; try { m = JSON.parse(line); } catch { debug(`non-JSON line from client: ${line.slice(0, 120)}`); return; }
    if (up.relayReply(m)) return;
    if (m.id === undefined) { if (m.method && m.method !== "notifications/initialized" && m.method.startsWith("notifications/")) up.send(m); return; }
    try {
      let result;
      switch (m.method) {
        case "initialize": result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "codex-cua-plus", version: VERSION } }; break;
        case "ping": result = {}; break;
        case "tools/list": result = await listTools(); break;
        case "tools/call": {
          if (toolListCache && !toolListCache.tools.some((t) => t.name === m.params?.name)) { send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params?.name}` } }); return; }
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
}
