# Security

## What this wrapper does and does not do

- It talks to the Computer Use engine of OpenAI's ChatGPT/Codex desktop app only through the official, signed client (`SkyComputerUseClient mcp`), started by the signed `codex sandbox` launcher via the [songkeys/claude-codex-computer-use](https://github.com/songkeys/claude-codex-computer-use) bridge. It does **not** connect to the service's Unix socket itself and does not bypass the service's sender verification (process-ancestry / team-id check).
- No OpenAI model is called. During live use the client/service processes open no TCP connections (`scripts/net_check.sh`). The only network activity in the chain is the engine's own telemetry (Statsig), which belongs to the ChatGPT app.
- The service's own policy stays in force: per-app approval prompts, the always-forbidden app list (password managers, terminals, Codex/ChatGPT itself, SecurityAgent), the browser URL blocklist and the "Esc to cancel" overlay. The wrapper only names the resulting error codes.

## Trust boundary of `script`

`script` runs model-written JavaScript in a `node:vm` context **inside the wrapper process**. `node:vm` is not a security sandbox: the code can reach host functions that were handed in (`sleep`, `setTimeout`, `cua.*`). The only caller is the model acting on the user's request, so this is equivalent to any other tool call, but do not expose this server to untrusted clients.

## Data

- Screenshots and accessibility trees of the controlled app are returned to the MCP client (the model). Screenshots are off by default and downscaled when requested.
- `paste` writes to the system clipboard and restores the previous text content afterwards; non-text clipboard content (images, files) is not restored.
- Macros, notes and config live in `~/.codex-cua-plus/` as plain JSON.

## Reporting

Open a GitHub issue. For anything that affects the ChatGPT/Codex app itself, report it to OpenAI.
