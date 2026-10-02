#!/usr/bin/env node
// A fake upstream bridge for integration tests: speaks MCP over stdio like SkyComputerUseClient and keeps a tiny
// in-memory "app" whose tree changes with actions. Started by server.mjs when CUA_PLUS_BRIDGE_CMD points here.
import { createInterface } from "node:readline";

const apps = {
  demo: {
    window: "Demo",
    items: ["button New Board, ID: nb", "menu bar item Insert", "button Insert Shape", "text field (settable) Value: , ID: PathTextField"],
    focus: 1,
    counter: 0,
  },
};
const calls = []; // every tools/call, for assertions via the "mock_calls" tool
const tree = (a) => {
  const rows = [`0 window ${a.window}`, ...a.items.map((it, i) => `  ${i + 1} ${it}`)];
  return `Computer Use state\n<app_state>\nWindow: "${a.window}", App: Demo.\n${rows.join("\n")}\nThe focused UI element is ${a.focus} ${a.items[a.focus - 1] || ""}\n</app_state>`;
};
const state = (a, withTree = true) => ({ content: [{ type: "text", text: withTree ? tree(a) : "Action completed. Call `get_app_state` to fetch the updated UI state." }, ...(withTree ? [{ type: "image", data: PNG_1x1, mimeType: "image/png" }] : [])] });
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const err = (code, msg) => ({ content: [{ type: "text", text: `MCP error -32603: Computer Use server error ${code}: ${msg}` }], isError: true });

const TOOLS = [
  { name: "list_apps", inputSchema: { type: "object", properties: {} } },
  { name: "get_app_state", inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
  { name: "click", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "integer" }, x: { type: "number" }, y: { type: "number" }, click_count: { type: "integer" }, mouse_button: { type: "string", enum: ["left", "right", "middle"] } }, required: ["app"] } },
  { name: "press_key", inputSchema: { type: "object", properties: { app: { type: "string" }, key: { type: "string" } }, required: ["app", "key"] } },
  { name: "type_text", inputSchema: { type: "object", properties: { app: { type: "string" }, text: { type: "string" } }, required: ["app", "text"] } },
  { name: "set_value", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "integer" }, value: { type: "string" } }, required: ["app", "element_index", "value"] } },
  { name: "scroll", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "integer" }, direction: { type: "string" }, pages: { type: "number" } }, required: ["app", "element_index", "direction"] } },
  { name: "drag", inputSchema: { type: "object", properties: { app: { type: "string" }, from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } }, required: ["app"] } },
  { name: "select_text", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "integer" }, text: { type: "string" } }, required: ["app", "element_index", "text"] } },
  { name: "perform_secondary_action", inputSchema: { type: "object", properties: { app: { type: "string" }, element_index: { type: "integer" }, action: { type: "string" } }, required: ["app", "element_index", "action"] } },
  { name: "mock_calls", inputSchema: { type: "object", properties: {} } },
  { name: "mock_elicit", inputSchema: { type: "object", properties: {} } },
];

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let nextId = 1000;
const pendingElicit = new Map();
function callTool(name, a = {}) {
  calls.push({ name, args: a });
  if (name === "mock_calls") return { content: [{ type: "text", text: JSON.stringify(calls) }] };
  if (name === "list_apps") return { content: [{ type: "text", text: "- Demo [frontmost] (com.example.demo)\n- Other [running] (com.example.other)" }] };
  const app = apps[String(a.app || "").toLowerCase()];
  if (!app) return err(-10007, `Running application not found: ${a.app}`);
  if (name === "get_app_state") return state(app);
  if (name === "mock_elicit") {
    // simulate an upstream-initiated request that must be relayed to the client and answered
    const id = nextId++;
    return new Promise((resolve) => {
      pendingElicit.set(id, resolve);
      out({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message: "approve?", requestedSchema: { type: "object", properties: {} } } });
    });
  }
  if (name === "click") {
    if (a.element_index !== undefined && !app.items[Number(a.element_index) - 1]) return err(-10005, `${a.element_index} is an invalid element ID`);
    const idx = Number(a.element_index);
    if (idx === 2) { app.items = ["Insert, Secondary Actions: Cancel, Pick", "menu", "menu item Shape", "menu item Sticky Note"]; app.window = "Demo"; app.focus = 1; app.menu = true; return state(app); }
    if (app.menu && idx === 3) { app.items = ["button New Board, ID: nb", "menu bar item Insert", "button Insert Shape", "text field (settable) Value: , ID: PathTextField", "layout item Shape 1"]; app.menu = false; return state(app, false); }
    if (idx === 1) { app.counter++; app.items[0] = `button New Board, ID: nb, Value: ${app.counter}`; return state(app); }
    app.focus = idx || app.focus;
    return state(app);
  }
  if (name === "perform_secondary_action" && a.action === "Cancel" && app.menu) { app.items = ["button New Board, ID: nb", "menu bar item Insert", "button Insert Shape", "text field (settable) Value: , ID: PathTextField"]; app.menu = false; return state(app); }
  if (name === "press_key") {
    if (a.key === "Escape" && app.menu) { app.items = ["button New Board, ID: nb", "menu bar item Insert", "button Insert Shape", "text field (settable) Value: , ID: PathTextField"]; app.menu = false; }
    if (!/^[A-Za-z_0-9+]+$/.test(a.key)) return err(-10005, `keyNotFound(\"${a.key}\")`);
    return state(app);
  }
  if (name === "type_text") { const i = app.focus - 1; if (/text field/.test(app.items[i] || "")) app.items[i] = app.items[i].replace(/Value: [^,]*/, `Value: ${a.text}`); return state(app); }
  if (name === "set_value") { const i = Number(a.element_index) - 1; if (app.items[i]) app.items[i] = app.items[i].replace(/Value: [^,]*/, `Value: ${a.value}`); return state(app, false); }
  return state(app, false);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined && pendingElicit.has(m.id)) { // reply to our elicitation
    pendingElicit.get(m.id)({ content: [{ type: "text", text: `elicitation answered: ${JSON.stringify(m.result ?? m.error)}` }] }); pendingElicit.delete(m.id); return;
  }
  if (m.id === undefined) return;
  if (m.method === "initialize") return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-bridge", version: "0" } } });
  if (m.method === "tools/list") return out({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  if (m.method === "tools/call") { const r = await callTool(m.params?.name, m.params?.arguments); return out({ jsonrpc: "2.0", id: m.id, result: r }); }
  if (m.method === "ping") return out({ jsonrpc: "2.0", id: m.id, result: {} });
  out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
}).on("close", () => process.exit(0));
