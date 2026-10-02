// Configuration: environment variables, optionally defaulted from ~/.codex-cua-plus/config.json
// (keys are the same names as the environment variables; the environment wins).
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.9.0";
export const DATA_DIR = process.env.CUA_PLUS_MACRO_DIR || join(homedir(), ".codex-cua-plus");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const MACRO_FILE = join(DATA_DIR, "macros.json");
export const NOTES_FILE = join(DATA_DIR, "notes.json");
export const SERVICE_SOCKET = join(homedir(), "Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock");

let fileConfig = {};
try { if (existsSync(CONFIG_FILE)) fileConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch (e) { process.stderr.write(`[cua-plus] ${CONFIG_FILE} ignored: ${e.message}\n`); }
const get = (name, fallback) => process.env[name] ?? (fileConfig[name] !== undefined ? String(fileConfig[name]) : fallback);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const OPTIONS = [
  ["CUA_PLUS_NPX", "npx", "npx binary used to start the bridge (Node 22)"],
  ["CUA_PLUS_BRIDGE_CMD", "", "override the bridge command entirely (tests use a mock bridge)"],
  ["CUA_PLUS_BRIDGE_ARGS", "", "arguments for CUA_PLUS_BRIDGE_CMD (JSON array or space-separated)"],
  ["CUA_PLUS_DEFAULT_OUTPUT", "diff", "diff | full — default tree output"],
  ["CUA_PLUS_DEFAULT_SCREENSHOT", "false", "attach screenshots by default"],
  ["CUA_PLUS_SCREENSHOT_MAX_PX", "1280", "longest side of returned screenshots (0 = original)"],
  ["CUA_PLUS_JPEG_QUALITY", "70", "JPEG quality for downscaled screenshots"],
  ["CUA_PLUS_KEY_DELAY_MS", "40", "delay between repeated key presses"],
  ["CUA_PLUS_UPSTREAM_TIMEOUT_MS", "130000", "per-request timeout towards the bridge (service IPC limit is 120 s)"],
  ["CUA_PLUS_APP_NAME", "ChatGPT", "macOS app that hosts the Computer Use service"],
  ["CUA_PLUS_MACRO_DIR", DATA_DIR, "data directory (macros.json, notes.json, config.json)"],
  ["CUA_PLUS_DEBUG", "", "1 = debug lines on stderr"],
  ["COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS", "60000", "bridge: release the client after this idle time"],
  ["COMPUTER_USE_CODEX_LAUNCHER_PATH", "", "bridge: signed codex launcher"],
  ["COMPUTER_USE_CLIENT_PATH", "", "bridge: SkyComputerUseClient binary"],
];

export const config = {
  npx: get("CUA_PLUS_NPX", "npx"),
  bridgeCmd: get("CUA_PLUS_BRIDGE_CMD", ""),
  bridgeArgs: (() => { const raw = get("CUA_PLUS_BRIDGE_ARGS", ""); if (!raw) return null; try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map(String); } catch {} return raw.split(/\s+/).filter(Boolean); })(),
  defaultOutput: get("CUA_PLUS_DEFAULT_OUTPUT", "diff"),
  defaultScreenshot: get("CUA_PLUS_DEFAULT_SCREENSHOT", "false") === "true",
  screenshotMaxPx: num(get("CUA_PLUS_SCREENSHOT_MAX_PX", "1280"), 1280),
  jpegQuality: num(get("CUA_PLUS_JPEG_QUALITY", "70"), 70),
  keyDelayMs: num(get("CUA_PLUS_KEY_DELAY_MS", "40"), 40),
  upstreamTimeoutMs: num(get("CUA_PLUS_UPSTREAM_TIMEOUT_MS", "130000"), 130000),
  appName: get("CUA_PLUS_APP_NAME", "ChatGPT"),
  debug: !!get("CUA_PLUS_DEBUG", ""),
  bridgeIdleMs: get("COMPUTER_USE_BRIDGE_IDLE_TIMEOUT_MS", "60000"),
};
export const debug = (m) => { if (config.debug) process.stderr.write(`[cua-plus] ${m}\n`); };
