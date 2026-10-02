// Tool definitions (schemas + descriptions) for the wrapper's own tools and the decoration of upstream tools.
import { config, MACRO_FILE } from "./config.mjs";
import { UI_ACTIONS } from "./pure.mjs";

export const FIND_DESC = "Target by text instead of element_index: role/title on the tree line (e.g. 'Choose File', 'button New Board'); /regex/ allowed (flags i m s; paths like /Users/x are plain text). Exact match > word match > substring; disabled elements rank last. Resolved against a fresh tree after any action in the same call; if not found, the tree is read again once.";
export const TARGETABLE = new Set(["click", "set_value", "scroll", "select_text", "perform_secondary_action", "type_text"]);
export const FOCUS_THEN_ACT = new Set(["type_text"]); // no element_index upstream: click the target first (skipped when it already has focus)

export const ACTION_SCHEMA = {
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
  },
  required: ["tool"],
};
export const COMMON_PROPS = (defaultOut) => ({
  include_screenshot: { type: "boolean", description: `Attach a screenshot (default ${config.defaultScreenshot}, or true for apps listed under _screenshot in notes). Leave off when the tree is enough; much faster. Downscaled to ${config.screenshotMaxPx || "full"} px.` },
  output: { type: "string", enum: ["diff", "full"], description: `diff (default ${defaultOut}): only lines changed since the last known tree for this app; full: the whole tree. The first call for an app is always full.` },
});

export const EXTRA_TOOLS = [
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
    inputSchema: { type: "object", properties: { app: { type: "string", description: "Target app." }, text: { type: "string", description: "Text to paste." }, format: { type: "string", enum: ["text", "html"], description: "text (default) or html → rich text." }, ...COMMON_PROPS(config.defaultOutput) }, required: ["app", "text"] },
  },
  {
    name: "status",
    description: "Health/diagnostics: wrapper version, ChatGPT.app / app-server / service socket / client state, list_apps ping latency, saved macros and notes files.",
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

/** Add the wrapper's extra parameters to the upstream tool schemas. */
export function decorateUpstreamTools(tools) {
  return (tools || []).map((t) => {
    const schema = structuredClone(t.inputSchema || { type: "object", properties: {} });
    schema.properties ||= {};
    if (t.name !== "list_apps") {
      Object.assign(schema.properties, COMMON_PROPS(config.defaultOutput));
      if (UI_ACTIONS.has(t.name)) schema.properties.observe = { type: "boolean", description: "After the action read the tree again and return the diff when the reply carries none (default true, ≈60 ms). false: return only the action result." };
    }
    if (TARGETABLE.has(t.name)) {
      schema.properties.find = { type: "string", description: FIND_DESC };
      schema.properties.role = { type: "string", description: "With find: the line must start with this role word." };
      schema.properties.nth = { type: "integer", minimum: 0, description: "Which match in score order (0 = best)." };
      if (schema.required) schema.required = schema.required.filter((k) => k !== "element_index");
    }
    if (t.name === "press_key") {
      schema.properties.repeat = { type: "integer", minimum: 1, maximum: 200, description: "Press the key N times (e.g. 15× shift+Down)." };
      if (schema.properties.key) schema.properties.key = { ...schema.properties.key, description: `${schema.properties.key.description || ""} Names are X11 keysyms: 'Return', 'Escape', 'BackSpace', 'space', 'Page_Up', 'KP_0', 'super+c', 'shift+Tab'. Aliases cmd/command/win→super, opt→alt, enter, esc, backspace, del, pgup/pgdn and single symbols (- = , .) are translated.`.trim() };
    }
    if (t.name === "click") {
      schema.properties.click_count = { ...(schema.properties.click_count || {}), description: "1 (default), 2 = double-click (open/edit), 3 = triple-click (select all text in a field)." };
      schema.properties.mouse_button = { ...(schema.properties.mouse_button || {}), description: "left (default), right (context menu), middle." };
    }
    return { ...t, inputSchema: schema };
  });
}
