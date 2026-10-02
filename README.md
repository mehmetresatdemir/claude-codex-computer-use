# claude-codex-computer-use

[![CI](https://github.com/mehmetresatdemir/claude-codex-computer-use/actions/workflows/ci.yml/badge.svg)](https://github.com/mehmetresatdemir/claude-codex-computer-use/actions/workflows/ci.yml)
[![Node ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-brightgreen)](package.json)
[![macOS](https://img.shields.io/badge/platform-macOS%2014.4%2B-lightgrey)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.9.0-informational)](CHANGELOG.md)

**Drive macOS apps from Claude Code through the Computer Use engine that ships with OpenAI's ChatGPT/Codex desktop app — without spending Codex quota, and without a model round trip per click.**

> Claude makes every decision. The engine only supplies the "eyes and hands" (accessibility tree, screenshot, click, type, keys). No OpenAI model is called.

Türkçe: [README.tr.md](README.tr.md) · [Changelog](CHANGELOG.md) · [Tool reference](docs/TOOLS.md) · [Configuration](docs/CONFIGURATION.md) · [Architecture analysis](docs/codex-computer-use-mimarisi.md) (Turkish) · [Research reports](docs/research/) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

---

## Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Tools](#tools)
- [Working rules](#working-rules-from-the-measurements)
- [Verified facts](#verified-facts-how-we-know)
- [Head-to-head with Codex](#head-to-head-the-same-task-on-codex-and-on-this-wrapper)
- [Testing](#testing)
- [Repository](#repository)

## What it is

A dependency-free MCP server (Node ≥ 22.14) that sits in front of [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) — the bridge that launches the signed Computer Use client — and adds what you need to work fast and safely:

- **`script`** — a persistent JavaScript environment modelled on Codex's own `cua_repl`: loops, regex, conditions, zero model turns per click.
- **`batch`** — action lists with text targeting (`find`), `wait_for`, conditionals, macros, dry-run.
- **Diff output by default** — only the lines that changed since the last call; action replies reuse the tree they already carry.
- **`paste`**, key-name normalisation, named service errors (all 21 codes), app notes, stuck-menu recovery, screenshot downscaling, `doctor` diagnostics.

Same name as the bridge, different project: this repo wraps the bridge and does not modify it or the engine.

## Quick start

Requirements: macOS 14.4+, the ChatGPT/Codex desktop app with Computer Use installed and **running** (the service lives under its `codex app-server`), Node ≥ 22.14, Claude Code.

```bash
git clone https://github.com/mehmetresatdemir/claude-codex-computer-use.git
cd claude-codex-computer-use
./scripts/install.sh        # finds paths, registers the MCP server "codex-computer-use", installs example macros, runs doctor
```

Start a new Claude Code session. The tools appear as `mcp__codex-computer-use__*`. Try:

```text
Use the Computer Use `script` tool: open Calculator, type 37*41=, read the result with lastTextUnder.
```

Check the installation any time:

```bash
node server.mjs doctor
```

## How it works

```
Claude Code ──MCP (stdio)──▶ codex-cua-plus (this repo)
                                │  batch · script · find · diff · notes · macros · paste · key names · error names
                                ▼
                     claude-codex-computer-use bridge (npx)
                                │  starts the signed client through `codex sandbox`
                                ▼
                     SkyComputerUseClient mcp ──Unix socket──▶ SkyComputerUseService (Swift, inside the ChatGPT app)
                                                                  accessibility tree · ScreenCaptureKit · CGEvent/AX
                                                                  per-app approval · "Esc to cancel" · settle wait
```

The service verifies the launcher's process ancestry; that is why the bridge is needed and why this wrapper never talks to the socket itself. Everything the service does — approvals, the forbidden-app list, the browser URL policy, the settle wait after each action — stays in force. Details: [architecture analysis](docs/codex-computer-use-mimarisi.md) and the five [research reports](docs/research/).

## Tools

All of the client's tools pass through (`get_app_state`, `click`, `press_key`, `type_text`, `set_value`, `scroll`, `drag`, `select_text`, `perform_secondary_action`, `list_apps`) with these additions on each: `include_screenshot` (off by default, downscaled when on), `output: diff|full`, `observe`, `find`/`role`/`nth` text targeting, `press_key.repeat`, key-name normalisation (`cmd+c` → `super+c`, `esc` → `Escape`; the service wants X11 keysyms).

| Tool | What it does |
|---|---|
| **`script`** | Persistent JS: `const app = await cua.getApp("Freeform"); await app.click({find:"New Board"}); const ax = await app.getAXState(); app.find(ax, "Draw with Pen"); app.lastTextUnder(ax, "Edit field"); await app.waitFor(/Window: "Open"/); await app.pen(points); await app.paste(text)`. Trees stay in variables; the model gets a log and a final diff. |
| **`batch`** | Action list with `find`, `wait_for` (text or `re`), `if_present`/`if_absent`/`optional`, `repeat`, `params`, `save_as`, `dry_run`, auto-recover, screenshot on error, per-step timings. |
| **`paste`** | Clipboard paste (⌘V, clipboard restored); `format:"html"` pastes rich text. The client has no paste tool; Codex's REPL does. |
| `menu` | Click a menu-bar path; skips intermediate items when the target is visible. |
| `open_path_in_dialog` | ⌘⇧G in an Open/Save panel → path → Return → waits for the selection → confirms. |
| `save_macro` / `run_macro` / `list_macros` | Parameterised macros in `~/.codex-cua-plus/macros.json` (`{{param}}`, numbers keep their type). |
| `find_elements` | Matching tree lines only. |
| `screenshot` | Region crop + max size, for reading small text. |
| `recover` | Escape → the menu's Cancel action, each step verified. |
| `status` | Version, app / app-server / service socket / client state, ping, macros, notes, measured timings. |

Full parameter reference: [docs/TOOLS.md](docs/TOOLS.md). Options: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Every service error code (-10000…-10020) and the plain-text replies (`not approved`, `user changed`, clipboard timeout, invalid secondary action, no window) come back with a name and what to do. App notes (built-ins for Freeform, TextEdit, Calculator, Finder, Unity, Simulator; `_match` notes for Open/Save panels; `_screenshot` apps) are attached once per session; extend them in `notes.json`.

## Working rules (from the measurements)

1. Put predictable sequences in one `script` or `batch`; keep trees in variables; let the model see a diff at the end.
2. Don't sleep after actions — the service already waits (≈0.42 s + 50 ms polling). Use `waitFor` for a condition.
3. Send text with one `type_text` or `paste` (one settle wait per call, not per key). Prefer keys that don't change the UI (≈10 ms) over clicks (≈0.5 s) where both work.
4. If you see `-10012`/`-10016`, stop: the user is at the keyboard.
5. Canvas apps (Freeform) ignore synthetic drag: draw with the pen tool (`app.pen`), insert pictures as files, move items with shift+arrow (`app.nudge`).

## Verified facts (how we know)

- **No Codex quota is consumed.** During live calls the bridge, client and service processes opened zero TCP connections (`scripts/net_check.sh`); the client talks to the local service over a Unix socket; the binaries contain telemetry and auth endpoints only, no model API.
- **Why the bridge is needed.** Launching `SkyComputerUseClient` directly fails with `-10000: Sender process is not authenticated`; the service checks the launcher's process ancestry (team id / signing id). The bridge starts the client through the signed `codex sandbox` launcher, which only executes a program and opens no model session.
- **Where the time goes** (measured inside the service with `log stream`, `scripts/service_trace.py`): every action is two IPC requests, a ~0 ms policy check and the action itself. A UI-changing action costs ≈ 0.42 s settle wait (polled at 50 ms, Statsig `ui_settle_poll_interval_milliseconds`) + ≈ 25 ms capture + ≈ 10 ms tree ≈ 0.45–0.56 s; the first action after `get_app_state` ≈ 0.9 s; modifier-only keys and no-op scrolls 1–3 ms with no capture; a plain observation ≈ 60 ms. The wait lives inside the signed service and cannot be tuned; what can be removed is the model round trip per action.

## Head-to-head: the same task on Codex and on this wrapper

Task: in Freeform create a board, insert an image via the Open panel, add a sticky note and a text box and place them by keyboard; in Calculator compute 37×41 and read the result from the accessibility tree; in TextEdit create a plain-text document, write three lines, save it to a path via the Save panel; verify the window title; screenshot the board.

| | Codex desktop app | This wrapper (`script`) |
|---|---|---|
| Tool calls | 25 `js` calls | **1** |
| Model turns to chatgpt.com | 11 | **0** |
| Upload | ≈ 1.1 MB (5 screenshots) | **0 bytes** |
| Wall time | 100 s | **70 s** |
| Result | correct | identical (file on disk, same board layout) |

Script: [`examples/scripts/multi_app_task.js`](examples/scripts/multi_app_task.js). Other examples: the 5-cube and 6-cube drawn with the pen tool in one call (`examples/scripts/freeform_penteract.js`, `freeform_hexeract.js`).

## Testing

```bash
npm run check   # syntax
npm test        # 14 unit tests (lib/pure.mjs) + 11 integration tests against test/mock-bridge.mjs — no service needed
```

The mock bridge is a fake Computer Use client with an in-memory app: it exercises find targeting after actions, stuck-menu recovery, stale-index retry, macros, the script timeout, relayed elicitation requests and key normalisation. CI runs the suite on macOS with Node 22 and 24.

## Repository

```
server.mjs                  MCP server: tool handlers, batch/script runtime, protocol loop, CLI (doctor, --help)
lib/upstream.mjs            bridge process, JSON-RPC link, relay of upstream-initiated requests
lib/tools.mjs               tool schemas and descriptions
lib/notes.mjs               app notes, <app_specific_instructions>
lib/pure.mjs                pure helpers (tree parsing, diff, find, key names, error table)
lib/config.mjs              options (environment / config.json)
test/                       unit + integration tests, mock bridge
scripts/install.sh          registration for Claude Code
scripts/service_trace.py    per-request settle/capture/tree timings from a `log stream` capture
scripts/bench.py            wrapper/bridge latency; scripts/net_check.sh: network check during live calls
scripts/gen-tool-docs.mjs   regenerates docs/TOOLS.md
examples/                   scripts and macros (multi-app task, 5-cube, 6-cube, insert image, write & save)
docs/                       architecture analysis, research reports, configuration, tool reference, day log
```

## Credits

Bridge: [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) (MIT). The Computer Use engine belongs to OpenAI's ChatGPT/Codex macOS app; this repo doesn't modify it and doesn't bypass its authentication.

License: MIT.
