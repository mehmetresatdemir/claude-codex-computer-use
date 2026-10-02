// Pure helpers for codex-cua-plus: no I/O, no process spawning. Unit-tested in test/pure.test.mjs.

// ---------- result text ----------
export function resultText(result) {
  return (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
export function isSoftError(result) {
  const t = resultText(result);
  return !!result?.isError || /Re-query the latest state|server error/i.test(t.slice(0, 300));
}

// ---------- accessibility tree ----------
// Line format: "<indent><index> <role and title...>". Score: exact 3, word 2, substring 1.
const treeMemo = { text: null, rows: null };
export function parseTree(text) {
  if (treeMemo.text === text) return treeMemo.rows;
  const rows = [];
  let seenRoot = false;
  for (const line of (text || "").split("\n")) {
    const m = line.match(/^(\s*)(\d+) (.*)$/);
    if (!m) continue;
    if (!seenRoot) { if (m[2] !== "0") continue; seenRoot = true; } // rows start at the root line "0 ..."
    rows.push({ index: m[2], rest: m[3], line: line.trim(), depth: m[1].length });
  }
  treeMemo.text = text; treeMemo.rows = rows;
  return rows;
}
export function looksLikeTree(text) { return /^\s*0 (window|application|menu|sheet|dialog|standard window|drawer|popover|\w)/m.test(text || "") && /^\s*1 /m.test(text || ""); }
// Is the tree root an open menu? ("0 Insert, Secondary Actions: Cancel, Pick" + "1 menu")
export function treeRootIsMenu(text) { return /^\s*0 [^\n]*Secondary Actions: Cancel, Pick/m.test(text || "") || /^\s*0 [^\n]*\n\s*1 menu\b/m.test(text || ""); }
export function windowLine(text) { return (text || "").match(/^Window: .*$/m)?.[0] || ""; }
export function focusLine(text) { return (text || "").match(/^The focused UI element is .*$/m)?.[0] || ""; }

// Service-provided app guidance (<app_specific_instructions>…</app_specific_instructions>): split it from the tree.
export function extractInstructions(text) {
  const m = (text || "").match(/<app_specific_instructions>([\s\S]*?)<\/app_specific_instructions>\s*/);
  if (!m) return { tree: text, instructions: null };
  return { tree: text.replace(m[0], ""), instructions: m[1].trim() };
}

// Line diff between two trees (indices may shift, so they are ignored).
export function treeDiff(before, after) {
  const norm = (t) => parseTree(t || "").map((r) => r.rest);
  const a = norm(before), b = norm(after);
  const countA = new Map(), countB = new Map();
  for (const x of a) countA.set(x, (countA.get(x) || 0) + 1);
  for (const x of b) countB.set(x, (countB.get(x) || 0) + 1);
  const removed = [], added = [];
  for (const [x, n] of countA) { const d = n - (countB.get(x) || 0); for (let i = 0; i < d; i++) removed.push(x); }
  const left = new Map(countB);
  for (const r of parseTree(after || "")) { const d = (left.get(r.rest) || 0) - (countA.get(r.rest) || 0); if (d > 0) { added.push(`${r.index} ${r.rest}`); left.set(r.rest, left.get(r.rest) - 1); } }
  return { added, removed };
}
// Noise lines hidden in compact diffs: scroll bars, arrow/page buttons, splitters, untitled image/text/cell/container.
export const NOISE_RE = /^(scroll bar\b|value indicator\b|increment (arrow|page) button|decrement (arrow|page) button|splitter\b|image$|text$|cell$|container$|section\b|collection$|group$|split group\b|scroll area\b|toolbar$|menu bar$|handle Description:|ruler( marker)?\b)/;
export function diffText(before, after, { compact = true, maxAdded = 60, maxRemoved = 30 } = {}) {
  let { added, removed } = treeDiff(before, after);
  let hidden = 0;
  if (compact) {
    const keep = (l) => !NOISE_RE.test(l.replace(/^\d+ /, ""));
    const a2 = added.filter(keep), r2 = removed.filter(keep);
    hidden = (added.length - a2.length) + (removed.length - r2.length);
    added = a2; removed = r2;
  }
  if (!added.length && !removed.length) {
    return [windowLine(after), `(no change in the tree${hidden ? `; ${hidden} noise line(s) hidden` : ""}; use output:"full" for the whole tree)`, focusLine(after)].filter(Boolean).join("\n");
  }
  return [windowLine(after), `+${added.length} line(s), -${removed.length} line(s)${hidden ? ` (${hidden} noise line(s) hidden; compact:false shows them)` : ""}`,
    ...added.slice(0, maxAdded).map((l) => `+ ${l}`), ...removed.slice(0, maxRemoved).map((l) => `- ${l}`),
    added.length > maxAdded || removed.length > maxRemoved ? "(truncated; use output:\"full\" for the whole tree)" : "", focusLine(after)].filter(Boolean).join("\n");
}

// ---------- macros ----------
// {{name}} placeholders. A string that is exactly one placeholder keeps the raw type (numbers stay numbers).
export function substitute(value, params) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*(\w+)\s*\}\}$/);
    if (whole && params[whole[1]] !== undefined) return params[whole[1]];
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{{${k}}}`));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, params)]));
  return value;
}

// ---------- text search in the tree ----------
// Case/diacritic folding: "İnsert" and "insert" match; "Ş" and "s" match.
export const fold = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
// "/body/flags" → RegExp (g and y dropped; invalid flags → treated as plain text, so paths like /Users/x work).
export function parseRegexQuery(q) {
  const m = String(q).match(/^\/(.+)\/([a-z]*)$/s);
  if (!m || /[^gimsuy]/.test(m[2])) return null; // "/Users/red/x" is a path, not a regex with flag x
  const flags = [...new Set(m[2].replace(/[gy]/g, "").split(""))].filter((f) => "imsu".includes(f));
  if (!flags.includes("i")) flags.push("i");
  try { return new RegExp(m[1], flags.join("")); } catch { return null; }
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function findInTree(text, query, { role, nth = 0, limit = 8 } = {}) {
  const q = String(query);
  const re = parseRegexQuery(q);
  const ql = fold(q);
  const wordRe = new RegExp(`(^|\\s|:)${escapeRe(ql)}(,|$)`);
  const roleRe = role ? new RegExp(`^${escapeRe(fold(role))}\\b`) : null;
  const scored = [];
  for (const r of parseTree(text)) {
    const rl = fold(r.rest);
    if (roleRe && !roleRe.test(rl)) continue;
    let score = 0;
    if (re) { if (re.test(r.rest)) score = 2; }
    else if (rl === ql) score = 3;
    else if (wordRe.test(rl)) score = 2;
    else if (rl.includes(ql)) score = 1;
    if (!score) continue;
    if (/\(disabled\)/.test(r.rest)) score /= 4; // enabled elements first, whatever the match quality
    scored.push({ ...r, score });
  }
  scored.sort((a, b) => b.score - a.score); // stable: tree order within a score
  return { hit: scored[nth] || null, candidates: scored.slice(0, limit) };
}
// Last "text" row nested under the row matching `query` (e.g. Calculator's result under "Edit field").
export function lastTextUnder(tree, query) {
  const clean = stripBidi(tree);
  const rows = parseTree(clean);
  const i = rows.findIndex((r) => findInTree(`0 root\n ${r.index} ${r.rest}`, query).hit);
  if (i < 0) return null;
  let last = null;
  for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) {
    const m = rows[j].rest.match(/^text (.+)$/);
    if (m) last = m[1].trim();
  }
  return last;
}
export const stripBidi = (s) => String(s).replace(/[‎‏‪-‮⁦-⁩]/g, "");
export function valueOf(tree, query, opts = {}) {
  const h = findInTree(tree, query, opts).hit;
  if (!h) return null;
  const rest = stripBidi(h.rest);
  const m = rest.match(/Value: (.*?)(?:, (?:ID|Secondary Actions|Help|Description):|$)/);
  return (m ? m[1] : rest.replace(/^\w[\w ]*? /, "")).trim();
}

// ---------- key names ----------
// The service uses X11 keysym names ("Return", "BackSpace", "Page_Up", "KP_0", "super+c"). Common aliases are mapped here;
// unknown names come back from the service as keyNotFound.
export const KEY_ALIASES = {
  cmd: "super", command: "super", win: "super", meta: "super", opt: "alt", option: "alt", control: "ctrl",
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", backspace: "BackSpace", del: "Delete", delete: "Delete",
  tab: "Tab", space: "space", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End",
  pgup: "Page_Up", pageup: "Page_Up", pgdn: "Page_Down", pagedown: "Page_Down", ins: "Insert", insert: "Insert",
  "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", ";": "semicolon", "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "\\": "backslash", "`": "grave",
};
export function normalizeKey(key) {
  return String(key).split("+").map((part) => {
    const p = part.trim();
    if (!p) return p;
    if (/^f\d{1,2}$/i.test(p)) return p.toUpperCase();
    if (/^kp_/i.test(p)) return "KP_" + p.slice(3);
    const a = KEY_ALIASES[p.toLowerCase()];
    if (a) return a;
    if (["ctrl", "shift", "super", "alt"].includes(p.toLowerCase())) return p.toLowerCase();
    return p; // keysym names are case-sensitive (Return, Page_Up, minus); leave unknown names alone
  }).join("+");
}

// ---------- service error codes (Codex IPC; name + what to do) ----------
export const SERVICE_ERRORS = {
  "-10000": ["senderProcessNotAuthenticated", "The client was launched without the signed launcher; register through the bridge/wrapper (install.sh). Launching ChatGPT.app does not fix this."],
  "-10001": ["couldNotGetRequestData", "Malformed IPC request; retry once, then report the wrapper version."],
  "-10002": ["couldNotGetRequestTypeName", "Malformed IPC request; retry once."],
  "-10003": ["couldNotResolveRequestType", "Client/service protocol mismatch; relaunch ChatGPT.app so the client is updated."],
  "-10004": ["unhandledEvent", "Unknown IPC event; relaunch ChatGPT.app."],
  "-10005": ["unknownError", "Generic code, see the subtype: 'app-server exited' → ChatGPT.app is closed (auto-launched); 'deadline exceeded'/'timeoutReached' → tree too large or app slow, use coordinates or a smaller target; 'invalid_element_id' → stale index, re-read the tree and retry; 'not a valid secondary action' → use a name from the line's Secondary Actions."],
  "-10006": ["appNotAllowed", "The app is blocked by policy/configuration (password managers, terminals, Codex itself are always forbidden); pick another app."],
  "-10007": ["runningApplicationNotFound", "App not found; check the name/bundle id with list_apps."],
  "-10008": ["accessibilityError", "No capturable window or the accessibility tree could not be read; bring a window to the front or continue with coordinates."],
  "-10009": ["permissionsNotGranted", "macOS Accessibility/Screen Recording permission missing; grant it in System Settings > Privacy & Security."],
  "-10010": ["invalidApp", "Invalid app identifier."],
  "-10011": ["noActiveSession", "No session; call get_app_state first."],
  "-10012": ["userStoppedSession", "The user pressed Esc to stop Computer Use; end the loop and continue only when asked."],
  "-10013": ["incompatibleClientVersion", "Client/service version mismatch; relaunch ChatGPT.app."],
  "-10014": ["permissionsPending", "The permission prompt is open; wait for the user, then call again."],
  "-10015": ["blockedURL", "Computer Use is not allowed on the current browser URL; stop and tell the user (claude-in-chrome is the alternative)."],
  "-10016": ["userIntervened", "The user touched the mouse/keyboard; re-read the state before continuing."],
  "-10017": ["couldNotGetSenderPID", "Launcher problem; register through the bridge."],
  "-10018": ["ambiguousApp", "Several apps match; use the bundle id from list_apps."],
  "-10019": ["couldNotGetBootstrapPort", "Launcher problem; register through the bridge."],
  "-10020": ["screenLocked", "The Mac is locked (or physical input paused the automatic unlock); unlock it."],
};
export function annotateServiceError(result) {
  const t = resultText(result);
  const m = t.match(/server error (-\d{5})/);
  if (!m || !SERVICE_ERRORS[m[1]]) return result;
  const [name, hint] = SERVICE_ERRORS[m[1]];
  return { ...result, isError: true, content: [...(result.content || []), { type: "text", text: `[${name}] ${hint}` }] };
}
export const STOP_CODES = /server error -1001[26]\b/; // user stopped / intervened → stop loops
export const SERVICE_DOWN = /app-server exited/; // only this subtype means ChatGPT.app is not running
export const UI_ACTIONS = new Set(["click", "press_key", "type_text", "set_value", "scroll", "drag", "select_text", "perform_secondary_action", "paste"]);

// ---------- image headers (no sips needed) ----------
export function imageDims(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: "png" };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), ext: "jpg" };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
