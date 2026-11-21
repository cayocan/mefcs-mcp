/**
 * Tank-G device client: memory map and high-level operations over the M-EFCS bridge.
 *
 * Memory spaces / addresses (body = 00 <space> <offset u32> <count u16> 00 <payload>):
 *   space 0x04 (presets)
 *     0x00000000  preset bank image, 758 bytes (.atkg layout)          read/write
 *     0x10000000  current (live) preset record, 21 bytes                read/write
 *     0x20000000  status, 4 bytes [?, bank, slot (0-3, 0xFF = bypass), ?] read
 *     0xD0000000  1 byte (unknown, reads 01)                             read
 *     0xE0000000+i  select preset i (write 1 byte = 01)
 *     0xE1000000+i  bypass preset i (write 1 byte = 01)
 *     0xF0000000  commit preset memory to flash (write, count 0)
 *   space 0x05 (models)
 *     0x00000000  amp model buffer, 8192 bytes
 *     0x00002000  cab IR buffer, 4096 bytes
 *     0x10000014  import input range [max, min] (2 bytes)
 *     0xA0000000  load buffer into the live chain (1 byte: 01 amp, 02 cab)
 *     0xF0000000 | kind<<8 | slot  store live buffer into slot (1 byte = 00; kind 0 amp, 1 cab)
 *     0xD0000000  device info, 32 bytes ("PMV1" ...)
 *
 * Nothing here can reach firmware update / repair / factory restore: only the addresses above are
 * implemented and every write goes through `assertAllowedWrite`.
 */
import { BridgeSession, listDevices, BridgeDevice } from "../protocol/bridge.js";
import { buildSysex, memoryBody, parseSysex, isAck, DEV_READ, DEV_WRITE, ParsedFrame } from "../protocol/framing.js";
import { encodeA2Lite, AMP_BUFFER_SIZE } from "../codecs/a2lite.js";
import { encodeCab, CAB_BUFFER_SIZE } from "../codecs/ir.js";
import { BANK_SIZE, RECORD_SIZE, PRESET_COUNT, decodeBank, decodeRecord, Preset } from "./tankg-presets.js";

export const SPACE_PRESETS = 0x04;
export const SPACE_MODELS = 0x05;

const ADDR = {
  bank: 0x00000000,
  live: 0x10000000,
  status: 0x20000000,
  select: 0xe0000000,
  bypass: 0xe1000000,
  commit: 0xf0000000,
  ampBuffer: 0x00000000,
  cabBuffer: 0x00002000,
  inputRange: 0x10000014,
  load: 0xa0000000,
  store: 0xf0000000,
  info: 0xd0000000,
} as const;

const IDENTITY_REQUEST = Uint8Array.from([0xf0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7f, 0xf7]);
const UPLOAD_CHUNK = 1015;

function assertAllowedWrite(space: number, offset: number, count: number) {
  const ok =
    (space === SPACE_PRESETS &&
      ((offset >= ADDR.bank && offset + count <= ADDR.bank + BANK_SIZE) ||
        (offset >= ADDR.live && offset + count <= ADDR.live + RECORD_SIZE) ||
        (offset >= ADDR.select && offset < ADDR.select + PRESET_COUNT && count === 1) ||
        (offset >= ADDR.bypass && offset < ADDR.bypass + PRESET_COUNT && count === 1) ||
        (offset === ADDR.commit && count === 0))) ||
    (space === SPACE_MODELS &&
      ((offset >= ADDR.ampBuffer && offset + count <= ADDR.ampBuffer + AMP_BUFFER_SIZE) ||
        (offset >= ADDR.cabBuffer && offset + count <= ADDR.cabBuffer + CAB_BUFFER_SIZE) ||
        (offset === ADDR.inputRange && count === 2) ||
        (offset === ADDR.load && count === 1) ||
        (offset - ADDR.store >= 0 && offset - ADDR.store < 0x200 && count === 1 && (offset & 0xff) < 9)));
  if (!ok) throw new Error(`Blocked write to space ${space} offset 0x${offset.toString(16)} (${count} bytes): not in the allow-list`);
}

export interface DeviceStatus {
  raw: number[];
  bank: number;
  slot: string | null;
  currentPreset: string | null;
  bypass: boolean;
}

export class TankG {
  private session?: BridgeSession;
  private device?: BridgeDevice;
  private waiters: Array<{ match: (f: ParsedFrame) => boolean; resolve: (f: ParsedFrame) => void }> = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly bridgePath: string) {}

  get connected() {
    return !!this.session?.isOpen;
  }

  async connect(): Promise<{ deviceId: string; info: string }> {
    if (this.connected) return { deviceId: this.device!.id, info: "already connected" };
    const devices = await listDevices(this.bridgePath);
    if (!devices.length) throw new Error("No M-VAVE device found by the bridge. Is the pedal connected by USB?");
    this.device = devices[0];
    const s = new BridgeSession(this.bridgePath);
    s.on("sysex", (msg: Uint8Array) => this.onSysex(msg));
    s.on("closed", () => (this.session = undefined));
    await s.open(this.device);
    this.session = s;
    await s.send(IDENTITY_REQUEST);
    await new Promise((r) => setTimeout(r, 100));
    const info = await this.read(SPACE_MODELS, ADDR.info, 32);
    return { deviceId: this.device.id, info: Buffer.from(info.subarray(0, 4)).toString("ascii") };
  }

  async disconnect() {
    await this.session?.close();
    this.session = undefined;
  }

  private onSysex(msg: Uint8Array) {
    const f = parseSysex(msg);
    if (!f) return;
    const i = this.waiters.findIndex((w) => w.match(f));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      w.resolve(f);
    }
  }

  private waitFor(match: (f: ParsedFrame) => boolean, timeoutMs: number): Promise<ParsedFrame> {
    return new Promise((resolve, reject) => {
      const entry = { match, resolve: (f: ParsedFrame) => (clearTimeout(timer), resolve(f)) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        reject(new Error("Timed out waiting for the pedal"));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  /** Serialize device transactions. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireSession(): BridgeSession {
    if (!this.session) throw new Error("Not connected to the pedal (call connect; M-EFCS must be closed)");
    return this.session;
  }

  read(space: number, offset: number, count: number, timeoutMs = 4000): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const s = this.requireSession();
      const reply = this.waitFor(
        (f) => f.dev === DEV_READ && f.space === space && f.offset === offset && (f.payload?.length ?? 0) === count,
        timeoutMs,
      );
      await s.send(buildSysex(DEV_READ, memoryBody(space, offset, count)));
      const f = await reply;
      if (!f.checksumOk) throw new Error("Checksum error in reply from the pedal");
      return Uint8Array.from(f.payload!);
    });
  }

  write(space: number, offset: number, payload: Uint8Array, timeoutMs = 4000): Promise<void> {
    assertAllowedWrite(space, offset, payload.length);
    return this.exclusive(async () => {
      const s = this.requireSession();
      const ack = this.waitFor((f) => f.dev === 0x00, timeoutMs);
      await s.send(buildSysex(DEV_WRITE, memoryBody(space, offset, payload.length, payload)));
      const f = await ack;
      if (!isAck(f)) throw new Error(`Pedal rejected the write (reply ${Buffer.from(f.body).toString("hex")})`);
    });
  }

  // ---------------- presets ----------------

  async status(): Promise<DeviceStatus> {
    const s = await this.read(SPACE_PRESETS, ADDR.status, 4);
    const bypass = s[2] === 0xff;
    const slot = s[2] <= 3 ? "ABCD"[s[2]] : null;
    return {
      raw: [...s],
      bank: s[1] + 1,
      slot,
      currentPreset: slot ? `${s[1] + 1}${slot}` : null,
      bypass,
    };
  }

  readBank(): Promise<Uint8Array> {
    return this.read(SPACE_PRESETS, ADDR.bank, BANK_SIZE, 8000);
  }

  async listPresets(): Promise<Preset[]> {
    return decodeBank(await this.readBank());
  }

  async readLive(): Promise<Preset & { note: string }> {
    const rec = await this.read(SPACE_PRESETS, ADDR.live, RECORD_SIZE);
    const st = await this.status();
    const idx = st.currentPreset ? (st.bank - 1) * 4 + "ABCD".indexOf(st.slot!) : 0;
    return { ...decodeRecord(rec, idx), note: "live (unsaved) values of the active preset" };
  }

  async writeBank(bank: Uint8Array) {
    if (bank.length !== BANK_SIZE || bank[0] !== 0xa5 || bank[1] !== 0x5a) throw new Error("Invalid bank image");
    await this.write(SPACE_PRESETS, ADDR.bank, bank, 10000);
    await this.write(SPACE_PRESETS, ADDR.commit, new Uint8Array(0), 10000);
  }

  /** Write one stored preset record and commit it to flash. */
  async writePreset(index: number, record: Uint8Array) {
    if (record.length !== RECORD_SIZE) throw new Error("Record must be 21 bytes");
    await this.write(SPACE_PRESETS, ADDR.bank + 2 + index * RECORD_SIZE, record);
    await this.write(SPACE_PRESETS, ADDR.commit, new Uint8Array(0), 10000);
  }

  /** Change the live (unsaved) values of the active preset. */
  async writeLive(record: Uint8Array) {
    if (record.length !== RECORD_SIZE) throw new Error("Record must be 21 bytes");
    await this.write(SPACE_PRESETS, ADDR.live, record);
  }

  async selectPreset(index: number) {
    await this.write(SPACE_PRESETS, ADDR.select + index, Uint8Array.of(1));
  }

  async setBypass(on: boolean) {
    const st = await this.status();
    const idx = st.currentPreset ? (st.bank - 1) * 4 + "ABCD".indexOf(st.slot!) : null;
    if (on) {
      if (idx === null) return;
      await this.write(SPACE_PRESETS, ADDR.bypass + idx, Uint8Array.of(1));
    } else {
      // M-EFCS leaves bypass by re-selecting the preset.
      const target = idx ?? (st.raw[1] * 4 + (st.raw[0] & 3));
      await this.write(SPACE_PRESETS, ADDR.select + target, Uint8Array.of(1));
    }
  }

  // ---------------- amp / cab slots ----------------

  private async uploadBuffer(base: number, buf: Uint8Array) {
    for (let off = 0; off < buf.length; off += UPLOAD_CHUNK) {
      await this.write(SPACE_MODELS, base + off, buf.subarray(off, Math.min(off + UPLOAD_CHUNK, buf.length)), 8000);
    }
  }

  /** Upload a NAM A2 capture as "A2 Lite (Original)". slot 1-9 stores it; omit slot to only preview it. */
  async uploadAmpCapture(namPath: string, slot?: number, name?: string) {
    if (slot !== undefined && (!Number.isInteger(slot) || slot < 1 || slot > 9)) throw new Error("Amp slot must be 1-9");
    const enc = encodeA2Lite(namPath, name);
    await this.uploadBuffer(ADDR.ampBuffer, enc.buffer);
    await this.write(SPACE_MODELS, ADDR.load, Uint8Array.of(0x01));
    if (slot !== undefined) await this.write(SPACE_MODELS, ADDR.store + (slot - 1), Uint8Array.of(0x00), 10000);
    return { name: enc.name, weights: enc.weightCount, stored: slot ?? null };
  }

  /** Upload a WAV impulse response. slot 1-8 stores it; omit slot to only preview it. */
  async uploadCabIr(wavPath: string, slot?: number, level = 50) {
    if (slot !== undefined && (!Number.isInteger(slot) || slot < 1 || slot > 8)) throw new Error("Cab slot must be 1-8");
    const enc = encodeCab(wavPath, level);
    await this.uploadBuffer(ADDR.cabBuffer, enc.buffer);
    await this.write(SPACE_MODELS, ADDR.load, Uint8Array.of(0x02));
    if (slot !== undefined) await this.write(SPACE_MODELS, ADDR.store + 0x100 + (slot - 1), Uint8Array.of(0x00), 10000);
    return { samples: enc.samples, truncated: enc.truncated, sourceRate: enc.sourceRate, stored: slot ?? null };
  }
}
