# Configuration

All options are environment variables. The same names can be put in `~/.codex-cua-plus/config.json` (the environment wins):

```json
{ "CUA_PLUS_DEFAULT_OUTPUT": "diff", "CUA_PLUS_SCREENSHOT_MAX_PX": 1280, "COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS": 600000 }
```

| Variable | Default | Meaning |
|---|---|---|
| `CUA_PLUS_NPX` | `npx` | npx used to start the bridge (must be Node ≥ 22.14). `scripts/install.sh` sets it. |
| `CUA_PLUS_BRIDGE_CMD` / `CUA_PLUS_BRIDGE_ARGS` | – | Replace the bridge command (the tests point this at `test/mock-bridge.mjs`). Args: JSON array or space-separated. |
| `CUA_PLUS_DEFAULT_OUTPUT` | `diff` | `diff` returns only changed tree lines after the first call for an app; `full` returns the whole tree. |
| `CUA_PLUS_DEFAULT_SCREENSHOT` | `false` | Attach screenshots unless a call says otherwise. Apps listed under `_screenshot` in notes get one anyway. |
| `CUA_PLUS_SCREENSHOT_MAX_PX` | `1280` | Longest side of returned screenshots (`0` = original). Click coordinates stay in the original resolution. |
| `CUA_PLUS_JPEG_QUALITY` | `70` | Quality for downscaled JPEGs. |
| `CUA_PLUS_KEY_DELAY_MS` | `40` | Pause between repeated key presses (`press_key.repeat`). |
| `CUA_PLUS_UPSTREAM_TIMEOUT_MS` | `130000` | Timeout per request towards the bridge (the service's own IPC limit is 120 s). |
| `CUA_PLUS_APP_NAME` | `ChatGPT` | Name of the app that hosts the service; launched with `open -g -a` when the service reports `app-server exited`. |
| `CUA_PLUS_MACRO_DIR` | `~/.codex-cua-plus` | Data directory: `macros.json`, `notes.json`, `config.json`. |
| `CUA_PLUS_DEBUG` | – | `1` prints debug lines on stderr. |
| `COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS` | `60000` | Bridge: release the signed client after this idle time (the wrapper registration uses 600000). |
| `COMPUTER_USE_CODEX_LAUNCHER_PATH` | auto | Bridge: the signed `codex` launcher inside ChatGPT.app. |
| `COMPUTER_USE_CLIENT_PATH` | auto | Bridge: `SkyComputerUseClient` binary. |

`node server.mjs --help` prints the same list; `node server.mjs doctor` checks paths, Node version, the app, the service socket and the JSON files.

## notes.json

```json
{
  "numbers": ["One click selects a cell, three clicks replace its content; enter a row with tab-separated values in one type_text."],
  "_match": { "print panel": { "re": "PrintPanel|button Print", "notes": ["Return triggers Print."] } },
  "_screenshot": ["simulator", "unity", "mygame"]
}
```

Keys are matched case-insensitively against the app name (`"numbers"` matches `Numbers`); `_match` entries trigger on the tree text; `_screenshot` apps get a screenshot by default. Each note group is shown once per session.
