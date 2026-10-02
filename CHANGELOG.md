# Changelog

## 0.9.0 — 2026-10-02

Engineering release: structure, tests, diagnostics, documentation.

- **Modules**: `server.mjs` now only holds the tool handlers and the protocol loop; `lib/upstream.mjs` (bridge process, JSON-RPC link, relay of upstream-initiated requests), `lib/tools.mjs` (schemas), `lib/notes.mjs` (app notes), `lib/config.mjs` (options), `lib/pure.mjs` (pure helpers).
- **Tests**: `npm test` runs 14 unit tests and 11 integration tests against `test/mock-bridge.mjs`, a fake Computer Use client with an in-memory app (stuck menu, stale index, elicitation relay, script timeout, macros). No service needed; CI runs them on macOS with Node 22 and 24 (`.github/workflows/ci.yml`).
- **CLI**: `node server.mjs doctor` checks platform, Node version, the ChatGPT app, launcher and client paths, the service socket, npx and the JSON data files; `--version`, `--help` (lists every option).
- **Config file**: `~/.codex-cua-plus/config.json` with the same keys as the environment variables (`docs/CONFIGURATION.md`).
- **Docs**: generated tool reference `docs/TOOLS.md` (`scripts/gen-tool-docs.mjs`, from the schemas + a snapshot of the client's tool list in `docs/upstream-tools.json`), `SECURITY.md` (what the wrapper touches, the `script` trust boundary), `CONTRIBUTING.md`, `.editorconfig`, npm metadata.
- `install.sh` in English, runs `doctor` at the end.

## 0.8.0 — 2026-10-02

Five parallel research passes (JS library, 59 Codex sessions, service/client binaries, our own code, host layer; reports in `docs/research/`) and a code review of 0.7.2 drove this release.

- **Correctness**: after every UI action the tree is re-read before the next `find`/`if_present`/`menu` step (the action reply's own tree is reused when present, so no extra round trip); invalid-index or "user changed" replies retry once with a re-resolved target. `findInTree`: path-like queries (`/Users/x`) are plain text, `/re/g` no longer skips matches, Turkish İ/diacritics fold, `nth` walks all candidates in score order, disabled elements rank last, `role` matches a word. `substitute` keeps numeric types (wait_for timeouts work in macros). `script`: timeout sets a cancel flag (no further actions are sent), RegExp from the script realm is recognised, diff base is per app, log capped at 500 lines, unknown-method errors point to `app.help()`.
- **Protocol/process**: upstream-initiated requests (`elicitation/create`, `roots/list`) are relayed to the client and answered back; `ping` answered; 130 s upstream timeout; error codes preserved; `tools/call` serialised; bridge spawned in its own process group and killed as a group; `error` handlers on the child; Claude/Codex pipe variables filtered from the child environment; `-10000` no longer launches ChatGPT.app.
- **New**: `paste` tool and `app.paste(text, {format:"text"|"html"})` through the clipboard (the MCP client lacks Codex's IPC `paste`); key-name normalisation (`cmd/command/win→super`, `opt→alt`, `esc`, `enter`, `backspace`, `pgup`, symbols) with the X11 keysym rule in the schema; `observe:false` on action tools; `click_count`/`mouse_button` documented; full service error table -10000…-10020 plus plain-text replies (`not approved`, `user changed`, clipboard timeout, invalid secondary action, no window); stuck-menu note on every result; `_match` notes triggered by tree content (Open/Save panels) and `_screenshot` per-app default screenshots (Simulator, Unity); Finder, Unity, Simulator notes; script helpers `pen`, `refind`, `keys`, `deselect`, `raise`, `compact`, `tail`, `screenshot`, `help` and aliases (`getState`, `type`, `press`, `performSecondaryAction`); `wait_for` accepts `re`.
- **Code**: pure helpers moved to `lib/pure.mjs`; `npm test` runs 14 unit tests without the service; image size read from PNG/JPEG headers (two `sips` calls fewer); `tools/list` cached; all runtime messages in English; macros file never overwritten when it is invalid JSON.
- Example fix: `examples/scripts/multi_app_task.js` now sends `37*41=` in one `type_text` and waits for the result row to change (the earlier run had read the expression instead of the result).

## 0.7.2 — 2026-10-02

Second pass over Codex Computer Use, this time inside the service itself (binary, Statsig store, live `log stream`). Findings are in `docs/codex-computer-use-mimarisi.md` §6.

- **`scripts/service_trace.py`**: turns a `log stream` capture of `SkyComputerUseService` into a per-request table of settle wait / screenshot capture / tree serialization. Measured: UI-changing action ≈ 0.42 s settle + 25 ms capture + 10 ms tree (≈ 0.45–0.56 s), first action after `get_app_state` ≈ 0.9 s, modifier-only key or no-op scroll 1–3 ms with no capture, plain observation ≈ 60 ms. Every action is preceded by a ~0 ms policy request.
- Decoded the service's Statsig config (`ui_settle_poll_interval_milliseconds = 50`, JPEG 0.8 at point resolution, `ax_prefetch_enabled = false`, browser URL domain list), the feature keys it consults (`feature/axTreeDiffing`, `…RemovedElementIDRanges`, `feature/skyshotClassifier`, `feature/computerUseCursor`), the full IPC request catalogue (Computer Use, Messages, Skysight, EventStream/Record & Replay, audio) and the bundled app-instruction catalogue (Slack, Notion, Spotify, iPhone Mirroring, Apple Music, Numbers, Clock). The MCP client delivers those once per bundle id; our notes fill the apps it doesn't cover.
- Built-in notes: Calculator (result lives under "Edit field" with invisible bidi marks; read with `app.lastTextUnder`), Open/Save panels (⌘⇧G path field, `saveAsNameTextField`).
- Working rule confirmed by the numbers: send text with one `type_text` (one settle per call, not per character); don't sleep after actions; observation is cheap, actions are not.

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
