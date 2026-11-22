<p align="right"><b>English</b> | <a href="README.pt-BR.md">Português (BR)</a></p>

# mefcs-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude, Cursor, VS Code Copilot, Gemini CLI, Codex and any other MCP client) control an **M-VAVE Tank-G** guitar pedal (the only supported pedal for now; see [Compatibility](#compatibility)) and pull tones from **TONE3000**.

It talks to the pedal over USB with the same protocol as the official **M-EFCS** app. The protocol is reverse engineered and documented in [docs/PROTOCOL.md](docs/PROTOCOL.md). It uses the USB helper that ships with M-EFCS, so nothing has to be installed on the pedal.

> Unofficial project, not affiliated with M-VAVE / Sinco or TONE3000. Firmware update, repair and factory-restore functions are intentionally **not** implemented.

---

## Contents

1. [Compatibility](#compatibility)
2. [What it can do](#what-it-can-do)
3. [Requirements](#requirements)
4. [Installation](#installation)
5. [Connecting it to an AI client](#connecting-it-to-an-ai-client)
6. [Configuration](#configuration)
7. [TONE3000 setup](#tone3000-setup)
8. [Tool reference](#tool-reference)
9. [Example prompts](#example-prompts)
10. [Safety](#safety)
11. [How it works](#how-it-works)
12. [Troubleshooting](#troubleshooting)
13. [Development](#development)
14. [Publishing](#publishing)
15. [License](#license)

---

## Compatibility

> **Right now this server works only with the M-VAVE Tank-G (v2).** Other M-VAVE pedals are not supported yet.

It was built and tested with:

| | Tested version |
|---|---|
| Pedal | M-VAVE **Tank-G v2** |
| Pedal firmware | **098** (the pedal identifies itself as `TANK-Gv2_098`) |
| M-EFCS app | **3.11.2015** for Windows (`m_efcs.exe`, which provides `mefcs_ks_bridge.exe`) |
| Operating system | Windows 11 Pro (build 26300) |
| Node.js | 20.20.2 |

Other firmware or M-EFCS versions may work, but they have not been tested. A newer M-EFCS can change its USB helper or the pedal protocol. If something breaks on your setup, please [open an issue](https://github.com/cayocan/mefcs-mcp/issues) with your firmware and M-EFCS versions.

**Roadmap:** support for the M-VAVE **Black Box**, the **MK-300** and other M-VAVE pedals is planned. Each pedal needs its own driver, built from captures of its USB traffic, so owners of those pedals who want to help with captures are welcome (see [Development](#development)).

---

## What it can do

**Pedal (Tank-G)**
- Read all 36 presets, or the live values of the active preset.
- Switch presets, toggle bypass.
- Edit any value (amp slot, gain, EQ, volume, gate, MOD / DELAY / REVERB type and knobs, cab slot, LED color) and save it to the pedal. A backup is taken automatically first.
- Tweak the active preset live without saving.
- Export and import `.atkg` preset files, the same format as M-EFCS "Share/Import all presets". Imports are backed up and verified.
- Upload an amp capture (NAM **A2** `.nam`, converted to "A2 Lite (Original)" like M-EFCS does) to amp slot 1-9, or preview it.
- Upload a cab impulse response (`.wav`, any rate/bit depth, resampled to 44.1 kHz) to cab slot 1-8, or preview it.

**TONE3000**
- Search tones (NAM A2 captures by default, or IRs) by text, gear type, make/model, tags or creator.
- See a tone's details and its downloadable models.
- Download `.nam` / `.wav` files.
- Install a TONE3000 model straight onto a pedal slot in one step.
- When keys or a login are missing, the server **opens the right TONE3000 page in your browser** for you.

## Requirements

| | |
|---|---|
| OS | Windows 10/11. The USB helper is a Windows program. |
| Node.js | 20 or newer (`node -v`) |
| M-EFCS | Installed. The server uses its `mefcs_ks_bridge.exe`. |
| Pedal | M-VAVE Tank-G (v2) connected by USB |
| TONE3000 | Free account, only for the TONE3000 tools |

**Important:** only one program can talk to the pedal at a time. **Close M-EFCS** before the AI uses a pedal tool. Ask the AI to run `tankg_disconnect` before opening M-EFCS again.

## Installation

```powershell
# 1. Get the code
git clone https://github.com/cayocan/mefcs-mcp.git
cd mefcs-mcp

# 2. Install dependencies and build
npm install
npm run build

# 3. Optional: run the tests (they compare the output with captured M-EFCS traffic)
npm test
```

The server entry point is `dist/src/server.js`. Once the package is published on npm you can skip the clone and use `npx -y mefcs-mcp` instead (see [Publishing](#publishing)).

Find the full path of `mefcs_ks_bridge.exe` inside your M-EFCS folder (for example `C:\Program Files\M-EFCS\mefcs_ks_bridge.exe`). Standard locations are detected automatically; otherwise set `MEFCS_BRIDGE_PATH`.

## Connecting it to an AI client

MCP is an open standard, so the same server works in every client that supports local (stdio) MCP servers. In each example, replace the paths with yours.

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "mefcs": {
      "command": "node",
      "args": ["C:\\path\\to\\mefcs-mcp\\dist\\src\\server.js"],
      "env": {
        "MEFCS_BRIDGE_PATH": "C:\\Program Files\\M-EFCS\\mefcs_ks_bridge.exe",
        "MEFCS_BACKUP_DIR": "C:\\path\\to\\mefcs-mcp\\backups",
        "TONE3000_DOWNLOAD_DIR": "C:\\path\\to\\mefcs-mcp\\downloads"
      }
    }
  }
}
```

### Claude Code

```powershell
claude mcp add mefcs --scope user `
  -e MEFCS_BRIDGE_PATH="C:\Program Files\M-EFCS\mefcs_ks_bridge.exe" `
  -- node "C:\path\to\mefcs-mcp\dist\src\server.js"
```

### Cursor

`%USERPROFILE%\.cursor\mcp.json` (global) or `.cursor/mcp.json` (project) takes the same `mcpServers` block as Claude Desktop.

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mefcs": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\mefcs-mcp\\dist\\src\\server.js"],
      "env": { "MEFCS_BRIDGE_PATH": "C:\\Program Files\\M-EFCS\\mefcs_ks_bridge.exe" }
    }
  }
}
```

### Windsurf, Cline, Gemini CLI and others

They all accept the same three things: `command` = `node`, `args` = path to `dist/src/server.js`, and `env` = the variables below. The `mcpServers` JSON block from Claude Desktop goes in:
- `~/.codeium/windsurf/mcp_config.json` (Windsurf)
- Cline's MCP settings
- `~/.gemini/settings.json` (Gemini CLI)

### OpenAI Codex CLI

`%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.mefcs]
command = "node"
args = ["C:\\path\\to\\mefcs-mcp\\dist\\src\\server.js"]
env = { MEFCS_BRIDGE_PATH = "C:\\Program Files\\M-EFCS\\mefcs_ks_bridge.exe" }
```

> Clients that only accept **remote** (HTTPS) MCP servers, such as web chat apps, cannot reach a USB pedal directly. The server has to run on the PC that has the pedal. See [Publishing](#publishing).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MEFCS_BRIDGE_PATH` | auto-detected in Program Files / LocalAppData | Full path to `mefcs_ks_bridge.exe` |
| `MEFCS_BACKUP_DIR` | `~/mefcs-mcp-backups` | Automatic preset backups (`TankG_<date>_<reason>.atkg`) |
| `TONE3000_DOWNLOAD_DIR` | `~/mefcs-mcp-downloads` | Downloaded `.nam` / `.wav` files |
| `TONE3000_CLIENT_ID` | (none) | TONE3000 publishable key; can also be saved at runtime |
| `TONE3000_API_KEY` | (none) | TONE3000 secret key `t3k_cs_…`, alternative to the login |
| `TONE3000_TOKEN_FILE` | `~/.mefcs-mcp/tone3000-tokens.json` | Saved TONE3000 session |
| `MEFCS_CONFIG_FILE` | `~/.mefcs-mcp/config.json` | Keys saved with `tone3000_set_credentials` |
| `MEFCS_NO_BROWSER` | (unset) | Set to `1` to never open the browser |

## TONE3000 setup

You only do this once, and you never need to edit config files for it:

1. Ask the AI to search TONE3000 (for example "search TONE3000 for a Fender Twin"). Without keys, the server **opens https://www.tone3000.com/settings in your browser**.
2. Log in there and generate API keys. Give the **publishable key** (client id) to the AI, which saves it with `tone3000_set_credentials`. It is stored in `~/.mefcs-mcp/config.json` on your PC.
3. The server then **opens the TONE3000 approval page** with your code. Click approve, and the AI runs `tone3000_login_finish`.
4. Done. The session is saved and refreshed automatically. From now on, searches and downloads just work.

Prefer not to log in? Put the secret key (`t3k_cs_…`) in `TONE3000_API_KEY` yourself instead. Don't paste secret keys into a chat.

Notes:
- The default rate limit is 100 requests per minute.
- Searches default to NAM **A2** captures, because the Tank-G loads the *lite* part of A2 files. Standard (A1) WaveNet captures cannot be converted.
- TONE3000's API terms ask independent developers to credit TONE3000.

## Tool reference

### Pedal

| Tool | Inputs | What it does |
|---|---|---|
| `tankg_connect` | — | Opens the USB session (M-EFCS must be closed). Other tools connect on demand. |
| `tankg_disconnect` | — | Releases the pedal so M-EFCS can be used. |
| `tankg_status` | — | Active preset (`1A`…`9D`) and bypass state. |
| `tankg_list_presets` | — | All 36 stored presets, decoded. |
| `tankg_get_preset` | `preset?`, `live?` | One stored preset, or the live values of the active one. |
| `tankg_select_preset` | `preset` | Switch preset. |
| `tankg_update_preset` | `preset`, `changes`, `save?` (default true) | Edit and save. Backs up first. Also applied live if the preset is active. |
| `tankg_set_live_values` | `changes` | Change the active preset without saving. |
| `tankg_set_bypass` | `on` | Global bypass. |
| `tankg_export_presets` | `path` | Save all presets to an `.atkg` file. |
| `tankg_import_presets` | `path` | Replace all presets with an `.atkg` file (backup + read-back verification). |
| `tankg_upload_amp_capture` | `namPath`, `slot?` 1-9, `name?` | Convert a NAM A2 capture and store it in an amp slot. Without `slot` it is only previewed. |
| `tankg_upload_cab_ir` | `wavPath`, `slot?` 1-8, `level?` 0-100 | Store a WAV IR in a cab slot (max ~30 ms at 44.1 kHz). Without `slot` it is only previewed. |
| `tankg_read_preset_file` | `path` | Decode an `.atkg` file offline. |
| `tankg_effect_types` | — | Effect type indexes. |

`changes` fields (all optional):

| Field | Range |
|---|---|
| `ampOn` | bool |
| `ampSlot` | 1-9 |
| `gain`, `treble`, `middle`, `bass`, `volume` | 0-100 |
| `gate` | 0-100, 0 = off |
| `mod`, `delay`, `reverb` | `{ on, type 0-2, amount, param2 0-100 }` |
| `cabSlot` | 0-8, 0 = off |
| `color` | `{ r, g, b }` |

Effect types follow the knob zones in the official manual:

| Block | type 0 | type 1 | type 2 | amount | param2 |
|---|---|---|---|---|---|
| MOD | chorus | phaser | tremolo | mix | rate |
| DELAY | analog | tape | dual | mix | time |
| REVERB | room | spring | cloud | decay | mix |

`amount` ranges from 0 to 42 (0 to 40 for type 2).

### TONE3000

| Tool | Inputs | What it does |
|---|---|---|
| `tone3000_auth_status` | — | Shows the auth mode and whether you are logged in. |
| `tone3000_set_credentials` | `clientId?`, `apiKey?` | Saves keys locally and starts the login (opens the approval page). |
| `tone3000_login_start` / `tone3000_login_finish` | — | Device login. Start opens the browser; finish waits up to 60 s for approval. |
| `tone3000_search` | `query?`, `gears?`, `makes?`, `tags?`, `creators?`, `sizes?`, `format?` (`nam`/`ir`), `sort?`, `calibrated?`, `page?`, `pageSize?` | Search tones. |
| `tone3000_get_tone` | `toneId` | Details and downloadable models. |
| `tone3000_download_model` | `modelId`, `dir?` | Download a `.nam` / `.wav`. |
| `tankg_install_tone3000_model` | `modelId`, `slot?`, `name?`, `cabLevel?` | Download and send to an amp slot (`.nam`) or cab slot (`.wav`). |

## Example prompts

- "Which preset is active on my Tank-G, and what does it have?"
- "Turn off the reverb on 5D and lower the gain to 60."
- "Make 1A's chorus subtler without saving, I want to hear it first."
- "Back up all my presets to D:\\Backups\\tankg.atkg."
- "Search TONE3000 for a Vox AC30 capture with lots of downloads and preview the best one."
- "Install the Marshall JCM800 capture you found on amp slot 4 and point preset 3C at it."
- "Find a Celestion V30 4x12 IR on TONE3000 and put it on cab slot 5."

## Safety

- There is no code path to firmware update, repair or factory restore, and every write is checked against an address allow-list (see `assertAllowedWrite`).
- Preset edits and imports back up all 36 presets first. Imports are verified by reading the bank back.
- Values are validated: knobs 0-100 (the range M-EFCS uses), slots 1-9 / 1-8, effect amounts within the type's zone. Untouched legacy values are kept as they are.
- Slot uploads overwrite the slot. Without `slot` they only preview, and nothing is stored.
- The browser is only opened for `https://www.tone3000.com` pages.
- TONE3000 keys and tokens stay on your PC (`~/.mefcs-mcp`).

## How it works

```
AI client ──MCP (stdio)──> mefcs-mcp ──stdin/stdout──> mefcs_ks_bridge.exe ──USB MIDI (SysEx)──> Tank-G
                              └──HTTPS──> TONE3000 API
```

- `src/protocol/bridge.ts`: spawns the M-EFCS helper (`open-raw`) and speaks its text protocol (`send <hex>` → `data <hex>`).
- `src/protocol/framing.ts`: SysEx frames: 8-bit frame → 7-bit LSB-first bitstream, inverted-sum checksum.
- `src/devices/tankg.ts`: memory map (preset bank, live preset, select/bypass/commit, model buffers, slot store) plus the write allow-list.
- `src/devices/tankg-presets.ts`: 21-byte preset record codec (`.atkg` layout).
- `src/codecs/a2lite.ts`: NAM A2 → device amp buffer. It takes the lite submodel, transposes the convolution weights and precomputes the zero-input state.
- `src/codecs/ir.ts`: WAV → device cab buffer (44.1 kHz, int24, max 1358 samples).
- `src/tone3000/client.ts`: TONE3000 API v1 (device login, search, models, download).

## Troubleshooting

| Problem | Fix |
|---|---|
| "M-EFCS is open" | Close M-EFCS; only one program can use the pedal. |
| "mefcs_ks_bridge.exe not found" | Set `MEFCS_BRIDGE_PATH` to the file inside your M-EFCS folder. |
| "No M-VAVE device found" | Check the USB cable/port; make sure the pedal is on. |
| "Timed out waiting for the pedal" | Unplug and replug the pedal, then retry. Make sure nothing else is using it. |
| M-EFCS can't find the pedal after using the AI | Ask the AI to run `tankg_disconnect`, or restart the AI client. |
| "not an A2 (SlimmableContainer) capture" | Pick an A2 capture on TONE3000 (search already filters for them). |
| TONE3000 rate limit | Wait a minute (100 requests/min). |
| A preset change sounds wrong | Restore the latest backup in `MEFCS_BACKUP_DIR` with `tankg_import_presets`. |

## Development

```powershell
npm run build      # TypeScript -> dist/
npm test           # golden tests against captured M-EFCS traffic + TONE3000 client tests
node scripts/smoke-test.mjs out.atkg   # live read-only test on a real pedal (M-EFCS closed)
node scripts/normalize-knobs.mjs --dry-run
node scripts/call-tool.mjs --list                           # list the tools over real MCP (stdio)
node scripts/call-tool.mjs tone3000_search "{\"query\":\"Fender Twin\"}"   # call one tool like an AI client does
```

Two golden tests compare against third-party TONE3000 captures that are not redistributed in this repo. They are skipped automatically when `test/fixtures/mesa.nam` / `ir8.wav` are absent.

To add another M-VAVE device (Black Box, MK-300, …), add a driver under `src/devices/` with that device's memory map and model format. The framing and the bridge are shared. Capture its traffic first (see `docs/PROTOCOL.md`).

## Publishing

The goal is that anyone can run it with `npx -y mefcs-mcp` and find it in MCP directories.

1. **GitHub:** push this repository (for example `github.com/cayocan/mefcs-mcp`) and add a license.
2. **npm:** `npm login`, then `npm publish`. `prepublishOnly` builds and tests first. After this, clients can use:
   ```json
   { "command": "npx", "args": ["-y", "mefcs-mcp"], "env": { "MEFCS_BRIDGE_PATH": "..." } }
   ```
3. **Official MCP Registry:** `package.json` already has `"mcpName": "io.github.cayocan/mefcs-mcp"` and the repository has a `server.json`. Install `mcp-publisher`, then run `mcp-publisher login github` and `mcp-publisher publish`. Keep the versions in `package.json` and `server.json` equal.
4. **Directories (optional):** Smithery, Glama, mcp.so, and the Cursor / VS Code MCP galleries can list it from the npm package or the registry.

Because the pedal is a local USB device, this is a **local (stdio)** server. Remote-only clients would need an HTTP transport running on the PC with the pedal, exposed through a secure tunnel. That is not included yet.

## License

[MIT](LICENSE) © Cayo Aguiar. M-VAVE, Tank-G, M-EFCS and TONE3000 are trademarks of their respective owners.
