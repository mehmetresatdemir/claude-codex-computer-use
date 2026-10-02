# Research reports (2026-10-02)

Five parallel read-only investigations of Codex Computer Use, written in Turkish by research agents and kept here as source material. Nothing in the Codex installation was modified; the authentication path was not touched.

| File | Scope | Key outcome |
|---|---|---|
| `01-sky-repl-library.md` | `@oai/sky` 0.7.5 JS library: App/Tab API, native pipe framing, policy/elicitation flow, 21 error codes, env variables, telemetry, the 20 rules given to the model | Diff, settle wait and element ids live in the Swift service; JS only passes `disableDiff`. |
| `02-codex-session-patterns.md` | 59 Codex sessions, 3 627 `cua_repl` calls decoded: call structure, screenshot ratio, error recovery, verification, per-app tricks, timings | Typical call = 1 action + 1 observation; keysym mistakes cost turns; no app-specific instructions were ever delivered for Freeform/Calculator/TextEdit/Finder. |
| `03-service-and-client-binaries.md` | Service/client binaries: AX serialisation fields, action JSON, keysym table, settle mechanism, full error table, 5 MCP servers in one binary (Computer Use, Messages, Computer History, Record & Replay, Calendar), IPC catalogue, approval store, forbidden apps | `paste` exists in IPC but not in the MCP client; approvals persist in `…/Application Support/Software/ComputerUseAppApprovals.json`. |
| `04-wrapper-code-review-0.7.2.md` | Review of our wrapper at 0.7.2: 15 prioritised findings, unit-test draft | Fixed in 0.8.0 (see CHANGELOG). |
| `05-host-layer.md` | ChatGPT.app → `codex app-server` → `node_repl`/plugins process tree, `codex sandbox` launcher and seatbelt profile, sender verification by team id, bundled plugins and SKILL.md summaries, config.toml, logs | Why the signed launcher chain is accepted; what the MCP route cannot reach (streaming capture, FrontmostWindow). |

Measurements that fed the wrapper are summarised in `../codex-computer-use-mimarisi.md` §6–7 and in the README.
