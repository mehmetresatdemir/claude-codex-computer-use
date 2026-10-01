# claude-codex-computer-use

**Drive macOS apps from Claude Code through the Computer Use engine that ships with OpenAI's ChatGPT/Codex desktop app — without spending Codex quota, and with batching that removes the per-click model round trip.**

Türkçe: [README.tr.md](README.tr.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · Architecture notes (Turkish): [docs/codex-computer-use-mimarisi.md](docs/codex-computer-use-mimarisi.md)

> Claude makes every decision. Codex only supplies the "eyes and hands" (screenshot + accessibility tree, click, type, keys). No OpenAI model is called.

---

## What this is

A thin, dependency-free MCP server (`server.mjs`, Node ≥ 22.14) that sits in front of [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) (the bridge that launches the signed Computer Use client) and adds what you need to work fast:

- **`script`** — a persistent JavaScript environment modelled on Codex's own `cua_repl`: loops, regex, conditions, zero model turns per click.
- **`batch`** with text targeting (`find`), `wait_for`, conditionals, macros, dry-run.
- **Diff output by default**: only the lines that changed since the last call.
- App notes, stuck-menu recovery, named service error codes, screenshot downscaling, status/diagnostics.

Same name as the bridge, different project: this repo does not modify the bridge; it wraps it. The wrapper's tool/file name stays `codex-cua-plus`.

## Verified facts (how we know)

- **No Codex quota is consumed.** During live calls the bridge, client and service processes opened zero TCP connections (`lsof -i`, 10 s sampling, repeated across sessions); the client talks to the local service over a Unix socket; binaries contain only telemetry/feature-flag and auth/profile endpoints, no model API. Reproduce with `scripts/net_check.sh`.
- **Why the bridge is needed.** Launching `SkyComputerUseClient` directly fails with `-10000: Sender process is not authenticated` — the service checks the launcher's process ancestry. The bridge starts the client through the signed `codex sandbox` launcher inside ChatGPT.app. `codex sandbox` is only a launcher; it opens no model session.
- **The engine is fast; the loop was slow.** Warm `get_app_state` ≈ 70–120 ms, `list_apps` ≈ 10 ms, keys that don't change the UI ≈ 10 ms. A click costs ≈ 0.7–1.5 s because the service waits for the UI to settle before capturing (its docs: "about 1 second, up to 5 s if the app shows a loading indicator"). That wait is inside the signed service and cannot be tuned; what can be removed is the model round trip per action.

## Head-to-head: the same task on Codex and on this wrapper

Task: in Freeform create a board, insert an image via the Open panel, add a sticky note and a text box and place them by keyboard; in Calculator compute 37×41 and read the result from the accessibility tree; in TextEdit create a plain-text document, write three lines, save it to a path via the Save panel; verify the window title; screenshot the board.

| | Codex desktop app | This wrapper (`script`) |
|---|---|---|
| Tool calls | 25 `js` calls | **1** |
| Model turns to chatgpt.com | 11 | **0** |
| Upload | ≈ 1.1 MB (5 screenshots) | **0 bytes** |
| Wall time | 100 s | **70 s** |
| Result | correct | identical (file on disk, same board layout) |

Script: [`examples/scripts/multi_app_task.js`](examples/scripts/multi_app_task.js). Board: `docs/example-multi-app-task.jpg`.

Codex's own run was decoded from its session log (`~/.codex/sessions/*.jsonl`) and watched with process/network monitors; the architecture notes describe the layers (Swift service, Unix-socket IPC `CodexComputerUseIPC-5`, the `@oai/sky` REPL library, the model's contract: default AX diff, `emit:false`, implicit settle wait, per-app policy and approval, 21 named error codes).

## Tools

All of Codex's tools pass through (`get_app_state`, `click`, `press_key`, `type_text`, `set_value`, `scroll`, `drag`, `select_text`, `perform_secondary_action`, `list_apps`) with these additions on each: `include_screenshot` (default off; downscaled to 1280 px when on), `output: diff|full`, `find`/`role`/`nth` text targeting, `press_key.repeat`.

| Tool | What it does |
|---|---|
| **`script`** | Persistent JS: `const app = await cua.getApp("Freeform"); await app.click({find:"New Board"}); const ax = await app.getAXState(); app.find(ax, "Draw with Pen"); app.lastTextUnder(ax, "Edit field"); await app.nudge("right", 30); await app.menu(["Insert","Choose File"]); await app.openPath("/path/file.png"); await app.waitFor('Window: "Open"')`. Trees stay in variables; the model gets a log and a final diff. |
| **`batch`** | Action list with `find`, `wait_for`, `if_present`/`if_absent`/`optional`, `repeat`, `params`, `save_as`, `dry_run`, `output:"diff"`, auto-recover, screenshot on error, per-step timings. |
| `menu` | Click a menu-bar path; skips intermediate items when the target is already visible. |
| `open_path_in_dialog` | ⌘⇧G in an Open/Save panel → path → Return → waits for selection → confirms (Return, button fallback). |
| `save_macro` / `run_macro` / `list_macros` | Parameterised macros in `~/.codex-cua-plus/macros.json` (`{{param}}`). Examples in `examples/macros/`. |
| `find_elements` | Matching tree lines only. |
| `screenshot` | Region crop + max size, for reading small text. |
| `recover` | Escape → menu Cancel action → title-bar click, each step verified. |
| `status` | Version, ChatGPT.app / app-server / service / client state, ping, macros, notes. |

Error codes from the service are annotated with a name and a hint (`-10012 userStoppedSession`: the user pressed Esc → loops stop; `-10016 userIntervened` → re-read; `-10018 ambiguousApp` → use the bundle id; `-10005` is split into `app-server exited` → ChatGPT.app is launched automatically, and `timeoutReached` → it is not).

App notes (`~/.codex-cua-plus/notes.json` + built-ins for Freeform and TextEdit) are attached once per app. Example built-in: *Freeform ignores synthetic drag; move a selected item with shift+arrow; clicking an image via accessibility opens Quick Look, select by coordinate instead.*

## Install

Requirements: macOS 14.4+, ChatGPT.app with Computer Use installed **and running** (the service hangs off its `codex app-server`), Node ≥ 22.14, Claude Code.

```bash
git clone https://github.com/mehmetresatdemir/claude-codex-computer-use.git
cd claude-codex-computer-use
./scripts/install.sh
```

The script finds Node 22, the signed `codex` launcher and `SkyComputerUseClient` inside ChatGPT.app, registers the wrapper as the user-scoped MCP server `codex-computer-use`, and installs the example macros. Start a new Claude Code session; tools appear as `mcp__codex-computer-use__*`.

Environment: `CUA_PLUS_DEFAULT_OUTPUT` (`diff`), `CUA_PLUS_DEFAULT_SCREENSHOT` (`false`), `CUA_PLUS_SCREENSHOT_MAX_PX` (`1280`), `CUA_PLUS_JPEG_QUALITY` (`70`), `CUA_PLUS_APP_NAME` (`ChatGPT`), `CUA_PLUS_MACRO_DIR`, `CUA_PLUS_DEBUG=1`; the bridge's own variables (`COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS` etc.) pass through.

## Working rules (from the measurements)

1. Put predictable sequences in one `script` or `batch`; keep trees in variables; let the model see a diff at the end.
2. Don't add fixed sleeps after actions — the service already waits. Use `waitFor` for a condition.
3. Prefer keys that don't change the UI (≈10 ms) over clicks (≈1 s) where both work (Return to confirm, shift+arrow to move).
4. If you see `-10012`/`-10016`, stop: the user is at the keyboard.
5. Canvas apps (Freeform) ignore synthetic drag. Draw with the pen tool by clicking points; insert pictures as files; move items with shift+arrow.

## Repository

```
server.mjs                          the wrapper (single file, no dependencies)
scripts/install.sh                  finds paths, registers the MCP server, installs example macros
scripts/bench.py                    latency measurement against the bridge or the wrapper
scripts/net_check.sh                network check during live calls
examples/scripts/multi_app_task.js  Freeform + Calculator + TextEdit in one script call
examples/scripts/freeform_penteract.js  5-cube (80 edges) drawn with the pen tool in one call
examples/macros/*.json              freeform_insert, textedit_write_save
examples/freeform_insert_image.py   end-to-end driver without Claude (Python → wrapper)
docs/codex-computer-use-mimarisi.md architecture analysis of Codex Computer Use (Turkish)
docs/gunluk-2026-10-01.md           day-one log, dead ends included (Turkish)
```

## Credits

Bridge: [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) (MIT). The Computer Use engine belongs to OpenAI's ChatGPT/Codex macOS app; this repo doesn't modify it and doesn't bypass its authentication.

License: MIT.
