#!/usr/bin/env node
/**
 * mefcs-mcp: MCP server for M-VAVE pedals through the M-EFCS USB bridge (Tank-G driver).
 *
 * Environment:
 *   MEFCS_BRIDGE_PATH  full path to mefcs_ks_bridge.exe (from the M-EFCS install folder)
 *   MEFCS_BACKUP_DIR   folder for automatic preset backups (default: ~/mefcs-mcp-backups)
 *   TONE3000_CLIENT_ID publishable key (OAuth device login) from https://www.tone3000.com/settings
 *   TONE3000_API_KEY   secret key (t3k_cs_...), alternative to the device login
 *   TONE3000_TOKEN_FILE where device-login tokens are stored (default: ~/.mefcs-mcp/tone3000-tokens.json)
 *   TONE3000_DOWNLOAD_DIR where downloaded captures/IRs go (default: ~/mefcs-mcp-downloads)
 *   MEFCS_CONFIG_FILE  saved TONE3000 keys from tone3000_set_credentials (default: ~/.mefcs-mcp/config.json)
 *   MEFCS_NO_BROWSER=1 never open the browser automatically
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { TankG } from "./devices/tankg.js";
import { Tone3000Client, summarizeTone, MissingCredentialsError, LoginRequiredError, TONE3000_SETTINGS_URL } from "./tone3000/client.js";
import { openUrl, isAllowedUrl } from "./util/open-url.js";
import {
  encodeWithChanges,
  decodeBank,
  parsePresetRef,
  presetId,
  EFFECT_TYPE_NAMES,
  PresetChanges,
  RECORD_SIZE,
} from "./devices/tankg-presets.js";

/** Find mefcs_ks_bridge.exe: env var first, then the usual M-EFCS install folders. */
function findBridge(): string {
  if (process.env.MEFCS_BRIDGE_PATH) return process.env.MEFCS_BRIDGE_PATH;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]
    .filter(Boolean) as string[];
  const candidates = roots.flatMap((r) => [join(r, "M-EFCS", "mefcs_ks_bridge.exe"), join(r, "M-EFCS", "M-EFCS", "mefcs_ks_bridge.exe")]);
  return candidates.find((c) => existsSync(c)) ?? candidates[0] ?? "mefcs_ks_bridge.exe";
}
const BRIDGE_PATH = findBridge();
const BACKUP_DIR = process.env.MEFCS_BACKUP_DIR ?? join(homedir(), "mefcs-mcp-backups");

const DOWNLOAD_DIR = process.env.TONE3000_DOWNLOAD_DIR ?? join(homedir(), "mefcs-mcp-downloads");

const tank = new TankG(BRIDGE_PATH);
const t3k = new Tone3000Client({
  clientId: process.env.TONE3000_CLIENT_ID,
  apiKey: process.env.TONE3000_API_KEY,
  tokenFile: process.env.TONE3000_TOKEN_FILE ?? join(homedir(), ".mefcs-mcp", "tone3000-tokens.json"),
  configFile: process.env.MEFCS_CONFIG_FILE ?? join(homedir(), ".mefcs-mcp", "config.json"),
});

/** Start the device login and open the approval page in the browser. */
async function beginTone3000Login() {
  const p = await t3k.startDeviceLogin();
  const url = p.verification_uri_complete ?? p.verification_uri;
  const opened = isAllowedUrl(url) ? openUrl(url) : false;
  return {
    action: "approve-login",
    browserOpened: opened,
    url,
    code: p.user_code,
    expiresInSeconds: p.expires_in,
    next: "Approve the code on the TONE3000 page that just opened, then call tone3000_login_finish.",
  };
}

/**
 * Run a TONE3000 call; when credentials are missing, open the TONE3000 settings page (where the
 * user creates API keys); when a key exists but there is no session, start the device login.
 */
async function withTone3000<T>(fn: () => Promise<T>): Promise<T | object> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MissingCredentialsError) {
      const opened = openUrl(TONE3000_SETTINGS_URL);
      return {
        action: "create-api-key",
        browserOpened: opened,
        url: TONE3000_SETTINGS_URL,
        next: "On the TONE3000 settings page, generate API keys and give the publishable key (client id) to tone3000_set_credentials. Then repeat the request.",
      };
    }
    if (e instanceof LoginRequiredError) return beginTone3000Login();
    throw e;
  }
}

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function mefcsAppRunning(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq m_efcs.exe", "/NH"], { encoding: "utf8", windowsHide: true });
    return /m_efcs\.exe/i.test(out);
  } catch {
    return false;
  }
}

async function ensureConnected() {
  if (tank.connected) return;
  if (!existsSync(BRIDGE_PATH)) throw new Error(`mefcs_ks_bridge.exe not found (looked at ${BRIDGE_PATH}). Install M-EFCS or set MEFCS_BRIDGE_PATH to the file inside the M-EFCS folder.`);
  if (mefcsAppRunning()) throw new Error("M-EFCS is open. Close it first: only one program can talk to the pedal at a time.");
  await tank.connect();
}

async function backupBank(reason: string): Promise<string> {
  const bank = await tank.readBank();
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(BACKUP_DIR, `TankG_${stamp}_${reason}.atkg`);
  writeFileSync(file, bank);
  return file;
}

function wrap<T extends object>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return text(await fn(args));
    } catch (e: any) {
      return { isError: true, content: [{ type: "text" as const, text: `Error: ${e?.message ?? e}` }] };
    }
  };
}

const presetRef = z.union([z.string(), z.number()]).describe('Preset as "1A".."9D" or index 0-35');
const knob = z.number().int().min(0).max(100);
const effect = z
  .object({
    on: z.boolean().optional(),
    type: z.number().int().min(0).max(2).optional().describe("Effect type index 0-2 (see tankg_effect_types)"),
    amount: z.number().int().min(0).max(42).optional().describe("Depth / mix / decay (0-42; max 40 for type 2)"),
    param2: knob.optional().describe("Rate / time / mix, 0-100"),
  })
  .optional();
const changesSchema = {
  ampOn: z.boolean().optional(),
  gate: knob.optional().describe("Noise gate threshold, 0 = off"),
  ampSlot: z.number().int().min(1).max(9).optional(),
  gain: knob.optional(),
  treble: knob.optional(),
  middle: knob.optional(),
  bass: knob.optional(),
  volume: knob.optional(),
  mod: effect,
  delay: effect,
  reverb: effect,
  cabSlot: z.number().int().min(0).max(8).optional().describe("Cab IR slot 1-8, 0 = cab off"),
  color: z.object({ r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255) }).optional(),
};

const server = new McpServer({ name: "mefcs-mcp", version: "0.1.1" });

server.registerTool(
  "tankg_connect",
  { title: "Connect to the Tank-G", description: "Open the USB bridge to the pedal. M-EFCS must be closed.", inputSchema: {} },
  wrap(async () => {
    await ensureConnected();
    return { connected: true, bridge: BRIDGE_PATH, status: await tank.status() };
  }),
);

server.registerTool(
  "tankg_disconnect",
  { title: "Disconnect", description: "Release the pedal so M-EFCS can be opened again.", inputSchema: {} },
  wrap(async () => {
    await tank.disconnect();
    return { connected: false };
  }),
);

server.registerTool(
  "tankg_status",
  { title: "Pedal status", description: "Active preset and bypass state.", inputSchema: {} },
  wrap(async () => {
    await ensureConnected();
    return tank.status();
  }),
);

server.registerTool(
  "tankg_list_presets",
  { title: "List presets", description: "Read all 36 stored presets from the pedal.", inputSchema: {} },
  wrap(async () => {
    await ensureConnected();
    return tank.listPresets();
  }),
);

server.registerTool(
  "tankg_get_preset",
  { title: "Get preset", description: "Read one stored preset, or the live (unsaved) values of the active one.", inputSchema: { preset: presetRef.optional(), live: z.boolean().optional() } },
  wrap(async ({ preset, live }: { preset?: string | number; live?: boolean }) => {
    await ensureConnected();
    if (live || preset === undefined) return tank.readLive();
    return (await tank.listPresets())[parsePresetRef(preset)];
  }),
);

server.registerTool(
  "tankg_select_preset",
  { title: "Select preset", description: "Make a preset active on the pedal.", inputSchema: { preset: presetRef } },
  wrap(async ({ preset }: { preset: string | number }) => {
    await ensureConnected();
    const i = parsePresetRef(preset);
    await tank.selectPreset(i);
    return { selected: presetId(i) };
  }),
);

server.registerTool(
  "tankg_update_preset",
  {
    title: "Update preset",
    description:
      "Change values of a stored preset. With save=true (default) it is written to the pedal's flash (a backup of all presets is taken first). If the preset is active, the change is also applied live.",
    inputSchema: { preset: presetRef, changes: z.object(changesSchema), save: z.boolean().optional() },
  },
  wrap(async ({ preset, changes, save }: { preset: string | number; changes: PresetChanges; save?: boolean }) => {
    await ensureConnected();
    const i = parsePresetRef(preset);
    const current = (await tank.listPresets())[i];
    const { preset: updated, record } = encodeWithChanges(current, changes);
    const st = await tank.status();
    const isActive = st.currentPreset === presetId(i);
    let backup: string | null = null;
    if (save !== false) {
      backup = await backupBank(`before-update-${presetId(i)}`);
      await tank.writePreset(i, record);
    }
    if (isActive) await tank.writeLive(record);
    return { preset: presetId(i), saved: save !== false, appliedLive: isActive, backup, before: current, after: updated };
  }),
);

server.registerTool(
  "tankg_set_live_values",
  { title: "Tweak active preset (unsaved)", description: "Change the active preset's live values without saving.", inputSchema: { changes: z.object(changesSchema) } },
  wrap(async ({ changes }: { changes: PresetChanges }) => {
    await ensureConnected();
    const live = await tank.readLive();
    const { preset: updated, record } = encodeWithChanges(live, changes);
    await tank.writeLive(record);
    return { preset: live.id, saved: false, after: updated };
  }),
);

server.registerTool(
  "tankg_set_bypass",
  { title: "Bypass", description: "Turn global bypass on or off.", inputSchema: { on: z.boolean() } },
  wrap(async ({ on }: { on: boolean }) => {
    await ensureConnected();
    await tank.setBypass(on);
    return tank.status();
  }),
);

server.registerTool(
  "tankg_export_presets",
  { title: "Export presets", description: "Save all 36 presets to an .atkg file (same format as M-EFCS 'Share all presets').", inputSchema: { path: z.string() } },
  wrap(async ({ path }: { path: string }) => {
    await ensureConnected();
    const bank = await tank.readBank();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bank);
    return { path, bytes: bank.length };
  }),
);

server.registerTool(
  "tankg_import_presets",
  { title: "Import presets", description: "Replace all 36 presets with an .atkg file. A backup of the current presets is saved first.", inputSchema: { path: z.string() } },
  wrap(async ({ path }: { path: string }) => {
    await ensureConnected();
    const bank = new Uint8Array(readFileSync(path));
    decodeBank(bank); // validates
    const backup = await backupBank("before-import");
    await tank.writeBank(bank);
    const check = await tank.readBank();
    const verified = Buffer.compare(Buffer.from(check), Buffer.from(bank)) === 0;
    return { imported: path, verified, backup };
  }),
);

server.registerTool(
  "tankg_upload_amp_capture",
  {
    title: "Upload amp capture",
    description:
      "Convert a TONE3000/NAM A2 capture (.nam) to 'A2 Lite (Original)' and send it to the pedal. With slot 1-9 it overwrites that amp slot; without slot it is only previewed (not stored).",
    inputSchema: { namPath: z.string(), slot: z.number().int().min(1).max(9).optional(), name: z.string().max(13).optional() },
  },
  wrap(async ({ namPath, slot, name }: { namPath: string; slot?: number; name?: string }) => {
    await ensureConnected();
    return tank.uploadAmpCapture(namPath, slot, name);
  }),
);

server.registerTool(
  "tankg_upload_cab_ir",
  {
    title: "Upload cab IR",
    description: "Send a WAV impulse response to the pedal (resampled to 44.1 kHz, max ~30 ms). With slot 1-8 it overwrites that cab slot; without slot it is only previewed.",
    inputSchema: { wavPath: z.string(), slot: z.number().int().min(1).max(8).optional(), level: z.number().int().min(0).max(100).optional() },
  },
  wrap(async ({ wavPath, slot, level }: { wavPath: string; slot?: number; level?: number }) => {
    await ensureConnected();
    return tank.uploadCabIr(wavPath, slot, level ?? 50);
  }),
);

server.registerTool(
  "tankg_read_preset_file",
  { title: "Read .atkg file", description: "Decode an .atkg preset file offline (no pedal needed).", inputSchema: { path: z.string() } },
  wrap(async ({ path }: { path: string }) => decodeBank(new Uint8Array(readFileSync(path)))),
);

server.registerTool(
  "tankg_effect_types",
  { title: "Effect types", description: "Effect type indexes and names (0 = first knob zone, 2 = last).", inputSchema: {} },
  wrap(async () => ({
    types: EFFECT_TYPE_NAMES,
    recordSize: RECORD_SIZE,
    note: "Order confirmed by the official Tank-G manual (MOD FX, DLY MIX and RVB DECAY knobs each have 3 zones in this order). amount = mix for MOD/DELAY, decay for REVERB.",
  })),
);

// ---------------- TONE3000 ----------------

server.registerTool(
  "tone3000_auth_status",
  { title: "TONE3000 login status", description: "Show how the MCP authenticates with TONE3000.", inputSchema: {} },
  wrap(async () => ({ mode: t3k.authMode, loggedIn: t3k.loggedIn, downloadDir: DOWNLOAD_DIR, keysPage: TONE3000_SETTINGS_URL })),
);

server.registerTool(
  "tone3000_login_start",
  {
    title: "TONE3000 login (start)",
    description: "Start the TONE3000 device login. Returns a code and a link; the user approves it in the browser, then call tone3000_login_finish. Needs TONE3000_CLIENT_ID.",
    inputSchema: {},
  },
  wrap(async () => withTone3000(() => beginTone3000Login())),
);

server.registerTool(
  "tone3000_login_finish",
  { title: "TONE3000 login (finish)", description: "Wait for the user to approve the device code (up to 60 s per call).", inputSchema: {} },
  wrap(async () => withTone3000(() => t3k.finishDeviceLogin())),
);

server.registerTool(
  "tone3000_set_credentials",
  {
    title: "Save TONE3000 keys",
    description:
      "Save the TONE3000 publishable key (client id, preferred) and/or secret key (t3k_cs_...) on this computer, then start the login. Keys come from https://www.tone3000.com/settings.",
    inputSchema: { clientId: z.string().optional(), apiKey: z.string().optional() },
  },
  wrap(async ({ clientId, apiKey }: { clientId?: string; apiKey?: string }) => {
    if (!clientId && !apiKey) throw new Error("Give clientId (publishable key) or apiKey (secret key)");
    t3k.setCredentials({ clientId, apiKey });
    if (t3k.authMode === "device-flow" && !t3k.loggedIn) return { saved: true, mode: t3k.authMode, ...(await beginTone3000Login()) };
    return { saved: true, mode: t3k.authMode, loggedIn: t3k.loggedIn };
  }),
);

const csv = z.array(z.string()).optional();
server.registerTool(
  "tone3000_search",
  {
    title: "Search TONE3000",
    description:
      "Search TONE3000 tones. Defaults to NAM A2 captures (what the Tank-G can load). Use format='ir' for cab IRs. gears: amp, amp-cab, pedal, outboard, cab, space, experimental.",
    inputSchema: {
      query: z.string().optional(),
      gears: csv,
      makes: csv.describe("Exact make/model names, e.g. 'Fender Twin Reverb'"),
      tags: csv,
      creators: csv,
      sizes: csv.describe("standard, lite, feather, nano, custom"),
      format: z.enum(["nam", "ir"]).optional(),
      sort: z.enum(["best-match", "newest", "oldest", "trending", "downloads-all-time"]).optional(),
      calibrated: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(25).optional(),
    },
  },
  wrap(async (a: any) =>
    withTone3000(async () => {
      const format = a.format ?? "nam";
      const r = await t3k.search({ ...a, format, architecture: format === "nam" ? "2" : undefined });
      return { page: r.page, totalPages: r.total_pages, total: r.total, tones: (r.data ?? []).map(summarizeTone) };
    }),
  ),
);

server.registerTool(
  "tone3000_get_tone",
  { title: "TONE3000 tone details", description: "Tone details plus its downloadable models (A2 NAM models or IRs).", inputSchema: { toneId: z.number().int() } },
  wrap(async ({ toneId }: { toneId: number }) =>
    withTone3000(async () => {
      const tone = await t3k.getTone(toneId);
      const models = await t3k.listModels(toneId);
      return {
        tone: { ...summarizeTone(tone), description: tone.description, license: tone.license },
        models: (models.data ?? []).map((m: any) => ({ id: m.id, name: m.name, size: m.size, architecture: m.architecture_version })),
      };
    }),
  ),
);

server.registerTool(
  "tone3000_download_model",
  { title: "Download from TONE3000", description: "Download one model (.nam) or IR (.wav) by model id.", inputSchema: { modelId: z.number().int(), dir: z.string().optional() } },
  wrap(async ({ modelId, dir }: { modelId: number; dir?: string }) =>
    withTone3000(async () => {
      const r = await t3k.downloadModel(modelId, dir ?? DOWNLOAD_DIR);
      return { path: r.path, name: r.model.name, size: r.model.size, toneId: r.model.tone_id };
    }),
  ),
);

server.registerTool(
  "tankg_install_tone3000_model",
  {
    title: "Install a TONE3000 model on the Tank-G",
    description:
      "Download a TONE3000 model and send it to the pedal: .nam (A2) goes to amp slot 1-9, .wav IR goes to cab slot 1-8. Without slot it is only previewed. Overwrites the slot.",
    inputSchema: { modelId: z.number().int(), slot: z.number().int().min(1).max(9).optional(), name: z.string().max(13).optional(), cabLevel: z.number().int().min(0).max(100).optional() },
  },
  wrap(async ({ modelId, slot, name, cabLevel }: { modelId: number; slot?: number; name?: string; cabLevel?: number }) => {
    if (!t3k.loggedIn) return withTone3000(() => t3k.getModel(modelId));
    const dl = await t3k.downloadModel(modelId, DOWNLOAD_DIR);
    await ensureConnected();
    if (dl.path.toLowerCase().endsWith(".wav")) {
      if (slot !== undefined && slot > 8) throw new Error("Cab slots are 1-8");
      return { downloaded: dl.path, kind: "cab", ...(await tank.uploadCabIr(dl.path, slot, cabLevel ?? 50)) };
    }
    return { downloaded: dl.path, kind: "amp", ...(await tank.uploadAmpCapture(dl.path, slot, name ?? String(dl.model.name ?? "").slice(0, 13))) };
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await tank.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
