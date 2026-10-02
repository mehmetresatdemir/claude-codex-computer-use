// App notes: known pitfalls attached once per app (and once per matching window/tree pattern), plus the
// service's own <app_specific_instructions> block shown once per app. Users extend/override via notes.json:
// { "finder": ["..."], "_match": { "open/save panel": { "re": "PathTextField|OKButton", "notes": ["..."] } }, "_screenshot": ["simulator"] }
import { readFileSync } from "node:fs";
import { NOTES_FILE } from "./config.mjs";
import { resultText, extractInstructions } from "./pure.mjs";

export const BUILTIN_NOTES = {
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

export function loadNotesFile() { try { return JSON.parse(readFileSync(NOTES_FILE, "utf8")); } catch { return {}; } }
export function notesFor(app, tree) {
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
export function wantsScreenshotByDefault(app) {
  const appL = String(app || "").toLowerCase();
  return [...(BUILTIN_NOTES._screenshot || []), ...(loadNotesFile()._screenshot || [])].some((k) => appL.includes(String(k).toLowerCase()));
}
const notesShown = new Set();
export function withNotes(result, app, tree) {
  if (!result?.content) return result;
  const groups = notesFor(app, tree ?? resultText(result)).filter((g) => !notesShown.has(g.key));
  if (!groups.length) return result;
  for (const g of groups) notesShown.add(g.key);
  const text = groups.map((g) => `Notes (${g.key.replace(/^app:/, "")}):\n${g.notes.map((x) => `- ${x}`).join("\n")}`).join("\n");
  return { ...result, content: [...result.content, { type: "text", text }] };
}
const instructionsShown = new Set();
export function splitInstructions(result, app) {
  if (!result?.content) return result;
  let instr = null;
  const content = result.content.map((c) => {
    if (c.type !== "text") return c;
    const { tree, instructions } = extractInstructions(c.text);
    if (instructions) instr = instructions;
    return { ...c, text: tree };
  });
  const k = String(app || "").toLowerCase();
  if (instr && !instructionsShown.has(k)) { instructionsShown.add(k); content.push({ type: "text", text: `<app_specific_instructions>\n${instr}\n</app_specific_instructions>` }); }
  return { ...result, content };
}
export const builtinNoteKeys = () => Object.keys(BUILTIN_NOTES).filter((k) => !k.startsWith("_"));
