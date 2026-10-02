// node --test test/   (no Computer Use service needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTree, looksLikeTree, treeRootIsMenu, treeDiff, diffText, substitute, findInTree, annotateServiceError, normalizeKey, lastTextUnder, valueOf, extractInstructions, imageDims, parseRegexQuery } from "../lib/pure.mjs";

const TREE = `Window: "Untitled 3", App: Freeform.
0 window Untitled 3
  1 button New Board, ID: nb
  2 menu bar item Insert
  3 button Insert Shape
  4 text field (settable) Value: /Users/red/x, ID: PathTextField
  5 scroll bar
  6 image
  7 image
  8 button (disabled) Insert
  9 group Edit field
    10 text 37×41
    11 text ‎1.517
The focused UI element is 1 button New Board`;

test("parseTree: index, rest, depth", () => {
  const rows = parseTree(TREE);
  assert.equal(rows.length, 12);
  assert.deepEqual({ index: rows[1].index, rest: rows[1].rest, depth: rows[1].depth }, { index: "1", rest: "button New Board, ID: nb", depth: 2 });
});
test("parseTree ignores number-led prose before the root", () => {
  assert.equal(parseTree("Found\n2024 results\n0 window\n  1 text").length, 2);
});
test("looksLikeTree / treeRootIsMenu", () => {
  assert.equal(looksLikeTree(TREE), true);
  assert.equal(looksLikeTree("Action completed. Call get_app_state."), false);
  assert.equal(looksLikeTree("Found\n0 results"), false);
  assert.equal(treeRootIsMenu("0 Insert, Secondary Actions: Cancel, Pick\n  1 menu"), true);
  assert.equal(treeRootIsMenu(TREE), false);
});
test("findInTree: exact > word > substring, role filter, nth over all candidates, disabled last", () => {
  assert.equal(findInTree(TREE, "Insert").hit.index, "2");
  assert.equal(findInTree(TREE, "Insert", { nth: 1 }).hit.index, "3");
  assert.equal(findInTree(TREE, "Insert", { nth: 2 }).hit.index, "8");
  assert.equal(findInTree(TREE, "button New Board, ID: nb").hit.score, 3);
  assert.equal(findInTree(TREE, "Insert", { role: "button" }).hit.index, "3");
  assert.equal(findInTree(TREE, "/image/").hit.index, "6");
  assert.equal(findInTree(TREE, "/image/", { nth: 1 }).hit.index, "7");
  assert.equal(findInTree(TREE, "missing").hit, null);
});
test("findInTree: path-like query is plain text; /re/g keeps matching; invalid flags fall back", () => {
  assert.equal(findInTree(TREE, "/Users/red/x").hit.index, "4");
  assert.equal(findInTree(TREE, "/image/g").candidates.length, 2);
  assert.equal(parseRegexQuery("/abc/im").flags, "im");
  assert.equal(parseRegexQuery("/Users/red/x"), null);
  assert.equal(parseRegexQuery("/a/b"), null);
});
test("findInTree: Turkish İ and diacritics fold", () => {
  assert.equal(findInTree("0 window\n  1 button İleri\n  2 button Şekil", "ileri").hit.index, "1");
  assert.equal(findInTree("0 window\n  1 button İleri\n  2 button Şekil", "sekil").hit.index, "2");
});
test("treeDiff: index-independent, counts duplicates", () => {
  const after = TREE.replace("  7 image\n", "").replace("1 button New Board", "9 button New Board");
  assert.deepEqual(treeDiff(TREE, after), { added: [], removed: ["image"] });
  assert.deepEqual(treeDiff(TREE, TREE + "\n  12 button Done").added, ["12 button Done"]);
});
test("diffText: noise hiding, header, no-change line", () => {
  const after = TREE.replace("  5 scroll bar\n", "");
  const out = diffText(TREE, after);
  assert.match(out, /^Window: "Untitled 3"/);
  assert.match(out, /no change in the tree; 1 noise line/);
  assert.match(diffText(TREE, after, { compact: false }), /- scroll bar/);
});
test("substitute: placeholders, unknown kept, raw type preserved for whole-string placeholder", () => {
  assert.deepEqual(substitute({ a: ["x {{p}}", { b: "{{q}}" }], n: 3 }, { p: "P" }), { a: ["x P", { b: "{{q}}" }], n: 3 });
  assert.equal(typeof substitute("{{t}}", { t: 6000 }), "number");
});
test("annotateServiceError: names the code, sets isError, leaves unknown codes", () => {
  const r = annotateServiceError({ content: [{ type: "text", text: "MCP error: server error -10012: stopped" }] });
  assert.equal(r.isError, true);
  assert.match(r.content.at(-1).text, /^\[userStoppedSession\]/);
  const u = { content: [{ type: "text", text: "server error -10099" }] };
  assert.equal(annotateServiceError(u), u);
});
test("normalizeKey: aliases and case", () => {
  assert.equal(normalizeKey("CMD+c"), "super+c");
  assert.equal(normalizeKey("Shift+Tab"), "shift+Tab");
  assert.equal(normalizeKey("ESC"), "Escape");
  assert.equal(normalizeKey("enter"), "Return");
  assert.equal(normalizeKey("super+shift+g"), "super+shift+g");
  assert.equal(normalizeKey("Page_Up"), "Page_Up");
  assert.equal(normalizeKey("minus"), "minus");
  assert.equal(normalizeKey("-"), "minus");
  assert.equal(normalizeKey("f5"), "F5");
  assert.equal(normalizeKey("opt+Left"), "alt+Left");
});
test("lastTextUnder / valueOf strip bidi marks", () => {
  assert.equal(lastTextUnder(TREE, "Edit field"), "1.517");
  assert.equal(valueOf(TREE, "PathTextField"), "/Users/red/x");
});
test("extractInstructions splits the service block", () => {
  const { tree, instructions } = extractInstructions("<app_specific_instructions>\nUse set_value.\n</app_specific_instructions>\n0 window\n  1 text");
  assert.equal(instructions, "Use set_value.");
  assert.match(tree, /^0 window/);
});
test("imageDims reads PNG and JPEG headers", () => {
  const png = Buffer.alloc(32); png[0] = 0x89; png[1] = 0x50; png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(imageDims(png), { w: 640, h: 480, ext: "png" });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0]);
  assert.deepEqual(imageDims(jpg), { h: 480, w: 640, ext: "jpg" });
});
