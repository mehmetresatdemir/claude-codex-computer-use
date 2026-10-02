# Contributing

Requirements: macOS, Node ≥ 22.14, the ChatGPT/Codex desktop app with Computer Use installed (only for live tests).

```bash
git clone https://github.com/mehmetresatdemir/claude-codex-computer-use.git
cd claude-codex-computer-use
npm run check      # syntax check of server.mjs and lib/
npm test           # unit tests (lib/pure.mjs) + integration tests against test/mock-bridge.mjs — no service needed
node server.mjs doctor
```

Layout:

| Path | Role |
|---|---|
| `server.mjs` | MCP server: tool handlers, batch/script runtime, downstream protocol |
| `lib/upstream.mjs` | bridge process, JSON-RPC link, relay of upstream-initiated requests |
| `lib/tools.mjs` | tool schemas and descriptions |
| `lib/notes.mjs` | app notes and `<app_specific_instructions>` handling |
| `lib/pure.mjs` | pure helpers (tree parsing, diff, find, key names, error table) — unit-tested |
| `lib/config.mjs` | environment / `~/.codex-cua-plus/config.json` |
| `test/mock-bridge.mjs` | fake upstream used by the integration tests |
| `docs/` | architecture analysis, research reports, examples |

Guidelines:

- No runtime dependencies. Keep pure logic in `lib/pure.mjs` with a test.
- Runtime messages, tool descriptions and docs are English; `README.tr.md` / `CHANGELOG.tr.md` carry the Turkish versions.
- Measure before claiming speed: `scripts/bench.py` (wrapper latency) and `scripts/service_trace.py` (where the time goes inside the service).
- Never add code that connects to the service socket directly or works around its authentication.
- Add a CHANGELOG entry and bump `VERSION` in `lib/config.mjs` and `package.json` together.
