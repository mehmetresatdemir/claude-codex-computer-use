// Integration tests: server.mjs against test/mock-bridge.mjs over stdio (no Computer Use service needed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let proc, rl, nextId = 1;
const waiters = new Map();
const relayed = [];
const dataDir = mkdtempSync(join(tmpdir(), "cua-plus-test-"));

before(async () => {
  proc = spawn(process.execPath, [join(here, "..", "server.mjs")], {
    env: { ...process.env, CUA_PLUS_BRIDGE_CMD: process.execPath, CUA_PLUS_BRIDGE_ARGS: JSON.stringify([join(here, "mock-bridge.mjs")]), CUA_PLUS_MACRO_DIR: dataDir, CUA_PLUS_SCREENSHOT_MAX_PX: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method && m.id !== undefined) { relayed.push(m); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { action: "accept", content: {} } }) + "\n"); return; }
    if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});
after(() => { proc.kill("SIGTERM"); rmSync(dataDir, { recursive: true, force: true }); });

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => { waiters.set(id, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
}
const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const mockCalls = async () => JSON.parse((await call("mock_calls")).content[0].text);

test("tools/list: upstream tools decorated + wrapper tools", async () => {
  const { result } = await rpc("tools/list", {});
  const names = result.tools.map((t) => t.name);
  for (const n of ["get_app_state", "click", "batch", "script", "paste", "status", "find_elements", "open_path_in_dialog"]) assert.ok(names.includes(n), n);
  const click = result.tools.find((t) => t.name === "click");
  assert.ok(click.inputSchema.properties.find && click.inputSchema.properties.observe && click.inputSchema.properties.output);
  const pk = result.tools.find((t) => t.name === "press_key");
  assert.ok(pk.inputSchema.properties.repeat && /keysym/.test(pk.inputSchema.properties.key.description));
});

test("first get_app_state is full, second is a diff; screenshot stripped by default", async () => {
  const a = await call("get_app_state", { app: "Demo" });
  assert.match(text(a), /0 window Demo/);
  assert.ok(!a.content.some((c) => c.type === "image"));
  assert.match(text(a), /screenshot omitted/);
  const b = await call("get_app_state", { app: "Demo" });
  assert.match(text(b), /^\[diff\]/);
  assert.match(text(b), /no change in the tree/);
  const c = await call("get_app_state", { app: "Demo", output: "full", include_screenshot: true });
  assert.ok(c.content.some((x) => x.type === "image"));
});

test("find targeting resolves the index and returns a diff of the change", async () => {
  const r = await call("click", { app: "Demo", find: "New Board", role: "button" });
  assert.match(text(r), /→ \[1\] 1 button New Board/);
  assert.match(text(r), /\+ 1 button New Board, ID: nb, Value: 1/);
  const calls = await mockCalls();
  assert.equal(calls.at(-2).args.element_index, "1"); // at(-1) is the mock_calls call itself
});

test("key names are normalised before reaching the bridge", async () => {
  await call("press_key", { app: "Demo", key: "CMD+c" });
  await call("press_key", { app: "Demo", key: "esc" });
  const keys = (await mockCalls()).filter((c) => c.name === "press_key").map((c) => c.args.key);
  assert.deepEqual(keys.slice(-2), ["super+c", "Escape"]);
});

test("batch: fresh tree after an action, if_present, wait_for re, stuck-menu recover, final diff", async () => {
  const r = await call("batch", {
    app: "Demo",
    actions: [
      { tool: "click", find: "Insert" },                                   // opens the stuck menu (root becomes a menu)
      { tool: "click", find: "Shape", role: "menu item" },                  // resolved against the fresh menu tree; reply carries no tree
      { tool: "wait_for", args: { re: "layout item Shape 1" } },
      { tool: "click", find: "nonexistent", optional: true },
      { tool: "set_value", find: "PathTextField", args: { value: "/tmp/x" }, if_present: "PathTextField" },
      { tool: "click", find: "whatever", if_absent: "PathTextField" },
    ],
  });
  const t = text(r);
  assert.ok(!r.isError, t);
  assert.match(t, /1\. click find="Insert" ok/);
  assert.match(t, /2\. click find="Shape" ok .*→ \[3\] 3 menu item Shape/);
  assert.match(t, /3\. wait_for ok/);
  assert.match(t, /4\. click find="nonexistent" skipped \(optional/);
  assert.match(t, /5\. set_value find="PathTextField" ok/);
  assert.match(t, /6\. click find="whatever" skipped \(condition: 'PathTextField' present\)/);
  assert.match(t, /\[diff\]/);
  assert.match(t, /\+ 5 layout item Shape 1/);
});

test("stale index triggers one automatic retry with a re-resolved target", async () => {
  await call("get_app_state", { app: "Demo", output: "full" });
  const r = await call("click", { app: "Demo", element_index: 99 });
  assert.match(text(r), /invalidElementID/);
});

test("macros: save with {{param}} (numbers keep their type), run, list", async () => {
  const save = await call("save_macro", { name: "m1", app: "Demo", actions: [{ tool: "set_value", find: "PathTextField", args: { value: "{{path}}" } }, { tool: "wait_for", args: { text: "Value: {{path}}", timeout_ms: "{{t}}" } }], params: ["path", "t"] });
  assert.match(text(save), /macro saved: m1/);
  const run = await call("run_macro", { name: "m1", params: { path: "/Users/demo", t: 1500 } });
  assert.ok(!run.isError, text(run));
  assert.match(text(run), /2\. wait_for ok/);
  const list = await call("list_macros");
  assert.match(text(list), /- m1: .*params=path,t \| 2 steps/);
  const missing = await call("run_macro", { name: "m1", params: { path: "x" } });
  assert.equal(missing.isError, true);
});

test("script: persistent env, find/waitFor/regex across realms, timeout cancels further actions", async () => {
  const r = await call("script", { code: "const app = await cua.getApp('Demo'); globalThis.n = (globalThis.n || 0) + 1; const ax = await app.getAXState(); log('idx', app.find(ax, 'Insert Shape')); await app.click({find:'New Board'}); await app.waitFor(/Value: \\d+/); log(app.help().slice(0, 8));", output: "none" });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /idx 3/);
  assert.match(text(r), /methods:/);
  const r2 = await call("script", { code: "log('n =', globalThis.n);", output: "none" });
  assert.match(text(r2), /n = 1/);
  const before = (await mockCalls()).length;
  const r3 = await call("script", { code: "const app = await cua.getApp('Demo'); while (true) { await app.pressKey('a'); await sleep(50); }", timeout_ms: 1000, output: "none" });
  assert.match(text(r3), /timed out/);
  await new Promise((res) => setTimeout(res, 400));
  const after = (await mockCalls()).length;
  const after2 = (await mockCalls()).length;
  assert.equal(after2 - after, 1, "no further actions after the timeout (only our mock_calls call)");
  assert.ok(after - before < 40);
});

test("upstream-initiated requests are relayed to the client and answered", async () => {
  const r = await call("mock_elicit", { app: "Demo" });
  assert.match(text(r), /elicitation answered: .*accept/);
  assert.equal(relayed.at(-1).method, "elicitation/create");
});

test("unknown tool → JSON-RPC error; find_elements with a path-like query does not throw", async () => {
  const bad = await rpc("tools/call", { name: "nope", arguments: {} });
  assert.equal(bad.error?.code, -32602);
  const fe = await call("find_elements", { app: "Demo", query: "/Users/x/y" });
  assert.match(text(fe), /0 match/);
});

test("status reports version and socket state without crashing on a mock", async () => {
  const s = await call("status");
  assert.match(text(s), /codex-cua-plus \d+\.\d+\.\d+/);
  assert.match(text(s), /list_apps ping: \d+ ms \(2 running apps\)/);
});

test("app objects reused in a later call are not cancelled by the previous call's timeout timer", async () => {
  const r1 = await call("script", { code: "globalThis.keep = await cua.getApp('Demo');", timeout_ms: 1000, output: "none" });
  assert.ok(!r1.isError, text(r1));
  await new Promise((res) => setTimeout(res, 1200)); // the old timer would have fired by now
  const r2 = await call("script", { code: "await keep.pressKey('a'); log('ok');", output: "none" });
  assert.ok(!r2.isError, text(r2));
  assert.match(text(r2), /ok/);
});
