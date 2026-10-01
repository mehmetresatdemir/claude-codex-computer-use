# Changelog

## 0.7.1 — 2026-10-02

- **6-cube (hexeract) drawn in Freeform**: 64 vertices, 192 edges, 12-gon Petrie projection, one `script` call, 22 pen paths, 353 actions, 309 s (`examples/scripts/freeform_hexeract.js`, `docs/example-hexeract.jpg`). Lesson that went into the Freeform notes: the pen tool treats a second click on a point already in the current path as selecting/closing, so an Euler circuit must be split into vertex-unique trails (share the last vertex between trails).
- `-10005` is no longer treated as "service down" by itself (subtypes: `app-server exited` → launch; `timeoutReached`, `invalidElementID` → don't); the hint names each subtype.
- `script` with `output:"none"` now still attaches the screenshot when `include_screenshot` is set.

## 0.7.0 — 2026-10-02

Learned from decoding Codex's own Computer Use (session logs, `@oai/sky` sources, live traffic) and from running the same multi-app task on both sides.

- **Diff output by default on every tool** (`output: "diff" | "full"`, env `CUA_PLUS_DEFAULT_OUTPUT`): the wrapper keeps the last full tree per app and returns only changed lines (index-independent, noise filtered); "no change" is a single line. The first call for an app is always full. This is our counterpart of Codex's server-side diff, which the MCP path does not expose.
- **Per-app tree cache** across calls: `find` resolves against the cached tree without an extra read.
- **`script` helpers** (from the task observations): `app.nudge(dir, n)` (move the selected item with shift+arrow — Freeform ignores drag but accepts this), `app.menu([...])`, `app.openPath(path)`, `app.value(ax, q)`, `app.text(ax, /re/)`, `app.lastTextUnder(ax, "Edit field")` (e.g. Calculator result; strips invisible bidi marks), `cua.listApps()`, action counter.
- **Same complex task, both sides**: Freeform (new board, insert image via Open panel, sticky note, text box, keyboard placement) → Calculator (37×41) → TextEdit (plain text, 3 lines, Save panel to a path). Codex: 25 `js` calls, 11 model turns, 100 s. Ours: **1 `script` call, 0 model turns, 70 s**, identical result on disk and on the board. Example: `examples/scripts/multi_app_task.js`, result `docs/example-multi-app-task.jpg`.
- Tool descriptions are now in English; README is English (`README.tr.md` keeps the Turkish version).

## 0.6.1 — 2026-10-02

- Freeform notes learned from Codex's task run: selected items move with `shift+arrow` (instead of drag); Sticky Note / Text Box then `type_text`; Escape ends editing.

## 0.6.0 — 2026-10-02

- **`script` tool** — persistent JavaScript environment (`node:vm`) modelled on Codex's `cua_repl`: `cua.getApp`, `app.click(idx | [x,y] | {find})`, `pressKey`, `typeText`, `setValue`, `scroll`, `drag`, `secondary`, `getAXState()` (never sent to the model), `find/findAll`, `waitFor`, `sleep`, `log`. Loops run locally; no model turn per click. Result: log + final-tree diff (+ screenshot).
- **Codex's drawing recipe decoded** from its session logs: drag and HTML/SVG paste fail in Freeform; the working path is *Insert Shape → Draw with Pen → click points → Return → Escape*; 32 vertices by bit mask, Gray-code main path (31 edges), greedy remaining paths. `examples/scripts/freeform_penteract.js` reproduces it in one `script` call (17 paths, 80 edges).
- **Architecture analysis**: `docs/codex-computer-use-mimarisi.md` (Turkish) — service/IPC/client layers, the model's contract (diff, emit, implicit wait, policy/approval), error codes, our design decisions.
- **Service error codes** mapped (`SERVICE_ERRORS`): −10000…−10020 with a name and what to do; `userStoppedSession`/`userIntervened` (−10012/−10016) stop batch and script loops. `-10005` is split: `app-server exited` → launch ChatGPT.app; `timeoutReached` (e.g. Safari's huge tree) → don't.

## 0.5.0 — 2026-10-02

- `type_text` + `find`; `screenshot` (region, max_px); `batch.dry_run`; `batch.params` + `save_as`; `status`; conditional actions `if_present` / `if_absent` / `optional`; TextEdit example macro; `install.sh` installs example macros.

## 0.4.x — 2026-10-02

- Compact diff, per-step timings, screenshot on error, app notes; latency measurements (click ≈ 0.7–1.5 s is the service's post-action settle wait; keys ≈ 10 ms); `open_path_in_dialog` confirms with Return; redundant final reads skipped.

## 0.3.0 — 2026-10-02

- `output: "diff"` for batch/run_macro; macros (`save_macro` / `run_macro` / `list_macros`); `recover` + `auto_recover`; automatic re-query on "The user changed <app>".

## 0.2.0 — 2026-10-02

- `find` text targeting, `wait_for`, `menu`, `find_elements`, screenshot downscaling, robust `open_path_in_dialog`.

## 0.1.0 — 2026-10-01

- First version: `batch`, `press_key.repeat`, `open_path_in_dialog`, optional screenshots, 10-minute idle, auto-launch ChatGPT.app on `-10005`, clean shutdown.
