/**
 * Tank-G preset bank codec (.atkg files and the device's preset memory share this layout).
 *
 *   A5 5A, then 36 records of 21 bytes (banks 1-9, slots A-D)
 *   [0] amp on   [1] mod on   [2] delay on   [3] reverb on
 *   [4] gate threshold (0 = off)
 *   [5] amp slot (0-8 => 1-9)
 *   [6..10] gain, treble, middle, bass, volume
 *   [11] mod type+depth   [12] mod rate
 *   [13] delay type+mix   [14] delay time
 *   [15] reverb type+decay [16] reverb mix
 *   [17] cab slot (0 = off, 1-8)
 *   [18..20] LED color R, G, B
 *
 * Effect "type+amount" bytes: type base 0 / 43 / 87, amount = value - base (knob zones; gaps between zones turn the block off on the hardware).
 * Knob values are 0-100 in M-EFCS (it clamps anything above 100 when you edit a value).
 */

export const BANK_SIZE = 758;
export const RECORD_SIZE = 21;
export const PRESET_COUNT = 36;
export const TYPE_BASES = [0, 43, 87] as const;

/** Type names in byte order (confirmed by the official Tank-G manual: 3 zones per knob in this order). */
export const EFFECT_TYPE_NAMES = {
  mod: ["chorus", "phaser", "tremolo"],
  delay: ["analog", "tape", "dual"],
  reverb: ["room", "spring", "cloud"],
} as const;

export type EffectKind = keyof typeof EFFECT_TYPE_NAMES;

export interface EffectBlock {
  on: boolean;
  type: number; // 0..2
  typeName: string;
  amount: number; // MOD: mix, DELAY: mix, REVERB: decay
  param2: number; // rate / time / mix
}

export interface Preset {
  index: number; // 0..35
  id: string; // "1A".."9D"
  ampOn: boolean;
  gate: number;
  ampSlot: number; // 1..9
  gain: number;
  treble: number;
  middle: number;
  bass: number;
  volume: number;
  mod: EffectBlock;
  delay: EffectBlock;
  reverb: EffectBlock;
  cabSlot: number; // 0 = off
  color: { r: number; g: number; b: number };
}

export function presetId(index: number): string {
  return `${Math.floor(index / 4) + 1}${"ABCD"[index % 4]}`;
}

export function parsePresetRef(ref: string | number): number {
  if (typeof ref === "number") {
    if (!Number.isInteger(ref) || ref < 0 || ref >= PRESET_COUNT) throw new Error("Preset index must be 0-35");
    return ref;
  }
  const m = ref.trim().toUpperCase().match(/^([1-9])\s*([ABCD])$/);
  if (!m) throw new Error(`Invalid preset "${ref}" (use 1A..9D)`);
  return (Number(m[1]) - 1) * 4 + "ABCD".indexOf(m[2]);
}

function splitEffect(kind: EffectKind, on: number, v: number, p2: number): EffectBlock {
  const type = v >= TYPE_BASES[2] ? 2 : v >= TYPE_BASES[1] ? 1 : 0;
  return { on: on !== 0, type, typeName: EFFECT_TYPE_NAMES[kind][type], amount: v - TYPE_BASES[type], param2: p2 };
}

export function decodeRecord(rec: Uint8Array, index: number): Preset {
  return {
    index,
    id: presetId(index),
    ampOn: rec[0] !== 0,
    gate: rec[4],
    ampSlot: rec[5] + 1,
    gain: rec[6],
    treble: rec[7],
    middle: rec[8],
    bass: rec[9],
    volume: rec[10],
    mod: splitEffect("mod", rec[1], rec[11], rec[12]),
    delay: splitEffect("delay", rec[2], rec[13], rec[14]),
    reverb: splitEffect("reverb", rec[3], rec[15], rec[16]),
    cabSlot: rec[17],
    color: { r: rec[18], g: rec[19], b: rec[20] },
  };
}

const maxAmount = (type: number) => (type === 2 ? 127 - TYPE_BASES[2] : TYPE_BASES[type + 1] - TYPE_BASES[type] - 1);

export function encodeRecord(p: Omit<Preset, "index" | "id">): Uint8Array {
  const r = new Uint8Array(RECORD_SIZE);
  const knob = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error(`${name} must be an integer 0-100 (got ${v})`);
    return v;
  };
  const fx = (name: string, e: EffectBlock) => {
    if (![0, 1, 2].includes(e.type)) throw new Error(`${name}.type must be 0, 1 or 2`);
    if (!Number.isInteger(e.amount) || e.amount < 0 || e.amount > maxAmount(e.type))
      throw new Error(`${name}.amount must be 0-${maxAmount(e.type)} for type ${e.type}`);
    return TYPE_BASES[e.type] + e.amount;
  };
  r[0] = p.ampOn ? 1 : 0;
  r[1] = p.mod.on ? 1 : 0;
  r[2] = p.delay.on ? 1 : 0;
  r[3] = p.reverb.on ? 1 : 0;
  r[4] = knob("gate", p.gate);
  if (!Number.isInteger(p.ampSlot) || p.ampSlot < 1 || p.ampSlot > 9) throw new Error("ampSlot must be 1-9");
  r[5] = p.ampSlot - 1;
  r[6] = knob("gain", p.gain);
  r[7] = knob("treble", p.treble);
  r[8] = knob("middle", p.middle);
  r[9] = knob("bass", p.bass);
  r[10] = knob("volume", p.volume);
  r[11] = fx("mod", p.mod);
  r[12] = knob("mod.param2", p.mod.param2);
  r[13] = fx("delay", p.delay);
  r[14] = knob("delay.param2", p.delay.param2);
  r[15] = fx("reverb", p.reverb);
  r[16] = knob("reverb.param2", p.reverb.param2);
  if (!Number.isInteger(p.cabSlot) || p.cabSlot < 0 || p.cabSlot > 8) throw new Error("cabSlot must be 0-8 (0 = off)");
  r[17] = p.cabSlot;
  for (const [i, c] of [p.color.r, p.color.g, p.color.b].entries()) {
    if (!Number.isInteger(c) || c < 0 || c > 255) throw new Error("color components must be 0-255");
    r[18 + i] = c;
  }
  return r;
}

/** Relaxed encoder used when re-writing records read from the device (keeps out-of-range legacy values). */
export function encodeRecordRaw(p: Preset): Uint8Array {
  const r = new Uint8Array(RECORD_SIZE);
  r.set([p.ampOn ? 1 : 0, p.mod.on ? 1 : 0, p.delay.on ? 1 : 0, p.reverb.on ? 1 : 0, p.gate, p.ampSlot - 1,
    p.gain, p.treble, p.middle, p.bass, p.volume,
    TYPE_BASES[p.mod.type] + p.mod.amount, p.mod.param2,
    TYPE_BASES[p.delay.type] + p.delay.amount, p.delay.param2,
    TYPE_BASES[p.reverb.type] + p.reverb.amount, p.reverb.param2,
    p.cabSlot, p.color.r, p.color.g, p.color.b]);
  return r;
}

export function decodeBank(bank: Uint8Array): Preset[] {
  if (bank.length < BANK_SIZE || bank[0] !== 0xa5 || bank[1] !== 0x5a) throw new Error("Invalid Tank-G preset bank (expected A5 5A + 36x21 bytes)");
  const out: Preset[] = [];
  for (let i = 0; i < PRESET_COUNT; i++) out.push(decodeRecord(bank.subarray(2 + i * RECORD_SIZE, 2 + (i + 1) * RECORD_SIZE), i));
  return out;
}

export interface PresetChanges {
  ampOn?: boolean;
  gate?: number;
  ampSlot?: number;
  gain?: number;
  treble?: number;
  middle?: number;
  bass?: number;
  volume?: number;
  mod?: Partial<Pick<EffectBlock, "on" | "type" | "amount" | "param2">>;
  delay?: Partial<Pick<EffectBlock, "on" | "type" | "amount" | "param2">>;
  reverb?: Partial<Pick<EffectBlock, "on" | "type" | "amount" | "param2">>;
  cabSlot?: number;
  color?: { r: number; g: number; b: number };
}

/**
 * Encode after applying changes: values that were changed must be valid (0-100 knobs, slot ranges,
 * effect amount within its type), untouched legacy values (e.g. a stored volume of 114) are kept as-is.
 */
export function encodeWithChanges(p: Preset, c: PresetChanges): { preset: Preset; record: Uint8Array } {
  const merged = applyChanges(p, c);
  const knobs = ["gate", "gain", "treble", "middle", "bass", "volume"] as const;
  for (const k of knobs) {
    const v = c[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 100)) throw new Error(`${k} must be an integer 0-100`);
  }
  if (c.ampSlot !== undefined && (!Number.isInteger(c.ampSlot) || c.ampSlot < 1 || c.ampSlot > 9)) throw new Error("ampSlot must be 1-9");
  if (c.cabSlot !== undefined && (!Number.isInteger(c.cabSlot) || c.cabSlot < 0 || c.cabSlot > 8)) throw new Error("cabSlot must be 0-8");
  for (const k of ["mod", "delay", "reverb"] as const) {
    const e = c[k];
    if (!e) continue;
    const m = merged[k];
    if (![0, 1, 2].includes(m.type)) throw new Error(`${k}.type must be 0-2`);
    if ((e.amount !== undefined || e.type !== undefined) && (m.amount < 0 || m.amount > maxAmount(m.type)))
      throw new Error(`${k}.amount must be 0-${maxAmount(m.type)} for type ${m.type}`);
    if (e.param2 !== undefined && (e.param2 < 0 || e.param2 > 100)) throw new Error(`${k}.param2 must be 0-100`);
  }
  return { preset: merged, record: encodeRecordRaw(merged) };
}

export function applyChanges(p: Preset, c: PresetChanges): Preset {
  const merged: Preset = JSON.parse(JSON.stringify(p));
  for (const k of ["ampOn", "gate", "ampSlot", "gain", "treble", "middle", "bass", "volume", "cabSlot"] as const) {
    if (c[k] !== undefined) (merged as any)[k] = c[k];
  }
  for (const k of ["mod", "delay", "reverb"] as const) {
    if (c[k]) Object.assign(merged[k], c[k]);
    merged[k].typeName = EFFECT_TYPE_NAMES[k][merged[k].type] ?? "unknown";
  }
  if (c.color) merged.color = { ...c.color };
  return merged;
}
