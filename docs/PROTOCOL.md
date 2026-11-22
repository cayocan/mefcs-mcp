# M-EFCS ↔ Tank-G protocol (reverse engineered)

Captured on 2026-11-21 from M-EFCS 3.11.2015 (Windows) and a Tank-G v2 running firmware 098 (identity string `TANK-Gv2_098`). The captures came from a logging proxy placed in front of `mefcs_ks_bridge.exe` (source in `re/bridge-proxy/` of the working folder).

## 1. Bridge (`mefcs_ks_bridge.exe`)

M-EFCS (Flutter) does not open USB itself. It spawns the bundled Kernel Streaming MIDI helper and talks to it over stdio:

| Command | Output |
|---|---|
| `mefcs_ks_bridge.exe list` | `device <id> <in> <out>` … `done` |
| `mefcs_ks_bridge.exe open-raw <id> <in> <out>` | `ready` |
| stdin `send <seq> <hex sysex>` | `sent <seq>` |
| (device traffic) | `data <hex>` (one SysEx can span several lines) |
| stdin `quit` | exits |

- The helper polls stdin with `PeekNamedPipe` and then calls `ReadFile`. A client that writes to a normal pipe works; a .NET proxy has to read its own stdin the same way.
- Only one process can open the device, so M-EFCS has to be closed while the MCP is connected.

## 2. SysEx framing

Every message except the raw identity request (`F0 00 32 45 00 00 00 40 7F F7`) is an **8-bit frame packed into a 7-bit, LSB-first bitstream**. The stream starts right after `F0` and ends before `F7`:

```
frame = 00 59 <dev> <len u16 LE> <body> <ck>
dev   = 0x23 read / read reply, 0x22 write, 0x00 ACK
len   = body.length - 1
ck    = (~sum(body)) & 0xFF
body  = 00 <space> <offset u32 LE> <count u16 LE> 00 <payload>
ACK   = 00 59 00 01 00 | 00 00 | FF
```

## 3. Memory map

### Space 0x04 — presets

| Offset | Size | Meaning |
|---|---|---|
| `0x00000000` | 758 | Preset bank image, identical to an `.atkg` file (`A5 5A` + 36 × 21 bytes) |
| `0x10000000` | 21 | Live record of the active preset (edits made in the app land here) |
| `0x20000000` | 4 | Status `[?, bank-1, slot 0-3 (0xFF = bypass), ?]`; M-EFCS polls it every second |
| `0xD0000000` | 1 | Unknown (reads `01`) |
| `0xE0000000 + i` | 1 | Write `01` to select preset *i* (0-35); also used to leave bypass |
| `0xE1000000 + i` | 1 | Write `01` to bypass |
| `0xF0000000` | 0 | Commit preset memory to flash |

"Save" in M-EFCS writes the 21-byte record at `2 + 21·i`, commits, and then re-selects the preset. "Import all presets" writes the whole 758-byte bank, commits, and writes the live record.

### Record layout (21 bytes)

`[0]` amp on, `[1]` mod on, `[2]` delay on, `[3]` reverb on, `[4]` gate threshold (0 = off), `[5]` amp slot 0-8, `[6..10]` gain/treble/middle/bass/volume, `[11]` mod type+depth, `[12]` mod rate, `[13]` delay type+mix, `[14]` delay time, `[15]` reverb type+decay, `[16]` reverb mix, `[17]` cab slot (0 = off), `[18..20]` LED RGB.

- Knobs are **0-100** in M-EFCS: editing a knob clamps a stored 114 to 100.
- For effect type+amount bytes, the type base is 0/43/87. The order comes from the official manual, where each knob has three zones: MOD FX is chorus/phaser/tremolo (amount = mix), DLY MIX is analog/tape/dual (amount = mix), and RVB DECAY is room/spring/cloud (amount = decay). On the hardware, the gaps between zones turn the block off.

### Space 0x05 — models

| Offset | Size | Meaning |
|---|---|---|
| `0x00000000` | 8192 | Amp model buffer (sent as 8 × 1015 + 72) |
| `0x00002000` | 4096 | Cab IR buffer (sent as 4 × 1015 + 36) |
| `0x10000014` | 2 | Import input range `[max, min]` (live) |
| `0xA0000000` | 1 | Load buffer into the live chain: `01` amp, `02` cab (M-EFCS "preview") |
| `0xF0000000 + kind·0x100 + slot` | 1 | Store live buffer to slot (kind 0 amp / 1 cab, slot 0-based), payload `00` |
| `0xD0000000` | 32 | Device info (`PMV1` …) |

## 4. Amp model buffer ("A2 Lite (Original)")

| Offset | Content |
|---|---|
| 0 | `NAM\0` |
| 4 | Name, 13 ASCII bytes + NUL |
| 18 | `64 64 3C 1E` (100, 100, input max 60, input min 30) |
| 24 | 9 float32: `150,-20,20, 425,-15,15, 1800,-10,10` (constant) |
| 60 | Weights of the **lite** submodel of the A2 `SlimmableContainer` (1871 floats for the current A2 lite layout). Convolution kernels are transposed `[out][in][k] → [k][in][out]`; biases and scalars are copied as they are. |
| after weights | `825.0821533` (constant), 3 zeros, the zero-input steady-state residual of layers 0..L-2 (C floats each), then the zero-input sum of activations feeding the head (B floats) |

The encoder reproduces 10 of the 11 upload messages byte for byte. The 11th differs only in the last bits of the steady-state floats, because M-EFCS computes them in float32.

`Documents\M-EFCS\namCache\<sha256(.nam)>.bin` (`AM5`, 7868 bytes) holds the "NAM optimized" model fetched from M-VAVE's server. It is not what A2 Lite (Original) sends.

## 5. Cab buffer

| Offset | Content |
|---|---|
| 0 | `CAB\0` + 14 zero bytes |
| 18 | `01`, cab level (default 50) |
| 20 | Mono int24 LE samples **resampled to 44.1 kHz**, max 1358 samples (~30.8 ms), zero padded |

## 6. Open items

- Read slots back, if the device allows it.
- Preset names do not exist on the Tank-G; slots show numbers.
- TONE3000 search and download (M-EFCS uses OAuth and stores the token in `flutter_secure_storage`).
- Other M-VAVE devices (MK300 and others) share the framing, but use other memory maps and model formats (AM3/AM4).
