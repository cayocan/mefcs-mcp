/**
 * WAV impulse response -> Tank-G cab buffer.
 *
 * Layout (4096 bytes): "CAB\0", 14 zero bytes, 0x01, cab level, then mono int24 LE samples at
 * 44.1 kHz (up to 1358 samples, ~30.8 ms), zero padded.
 */
import { readFileSync } from "node:fs";

export const CAB_BUFFER_SIZE = 4096;
const SAMPLE_OFFSET = 20;
const MAX_SAMPLES = Math.floor((CAB_BUFFER_SIZE - SAMPLE_OFFSET) / 3);
const TARGET_RATE = 44100;

export interface WavData {
  sampleRate: number;
  channels: number;
  samples: Float64Array; // first channel, -1..1
}

export function readWav(path: string): WavData {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let pos = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === "fmt ") {
      let format = b.readUInt16LE(start);
      if (format === 0xfffe) format = b.readUInt16LE(start + 24); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { format, channels: b.readUInt16LE(start + 2), rate: b.readUInt32LE(start + 4), bits: b.readUInt16LE(start + 14) };
    } else if (id === "data") data = b.subarray(start, start + size);
    pos = start + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV is missing fmt or data chunk");
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = i * bytes * fmt.channels;
    let v: number;
    if (fmt.format === 3 && fmt.bits === 32) v = data.readFloatLE(o);
    else if (fmt.format === 3 && fmt.bits === 64) v = data.readDoubleLE(o);
    else if (fmt.bits === 16) v = data.readInt16LE(o) / 32768;
    else if (fmt.bits === 24) v = data.readIntLE(o, 3) / 8388608;
    else if (fmt.bits === 32) v = data.readInt32LE(o) / 2147483648;
    else if (fmt.bits === 8) v = (data.readUInt8(o) - 128) / 128;
    else throw new Error(`Unsupported WAV format (${fmt.format}, ${fmt.bits} bit)`);
    out[i] = v;
  }
  return { sampleRate: fmt.rate, channels: fmt.channels, samples: out };
}

/** Windowed-sinc resampler (Blackman window, 32 zero crossings). Good enough for short IRs. */
export function resample(x: Float64Array, from: number, to: number): Float64Array {
  if (from === to) return x;
  const ratio = to / from;
  const n = Math.round(x.length * ratio);
  const out = new Float64Array(n);
  const cutoff = Math.min(1, ratio); // low-pass when downsampling
  const zc = 32;
  const half = Math.ceil(zc / cutoff);
  for (let i = 0; i < n; i++) {
    const t = i / ratio;
    const c = Math.floor(t);
    let s = 0;
    for (let j = c - half + 1; j <= c + half; j++) {
      if (j < 0 || j >= x.length) continue;
      const d = t - j;
      const arg = d * cutoff;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      const wpos = (d + half) / (2 * half);
      const win = wpos <= 0 || wpos >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
      s += x[j] * sinc * win * cutoff;
    }
    out[i] = s;
  }
  return out;
}

export interface CabResult {
  buffer: Uint8Array;
  samples: number;
  truncated: boolean;
  sourceRate: number;
}

export function encodeCab(wavPath: string, level = 50): CabResult {
  if (!Number.isInteger(level) || level < 0 || level > 100) throw new Error("Cab level must be an integer 0-100");
  const wav = readWav(wavPath);
  let x = resample(wav.samples, wav.sampleRate, TARGET_RATE);
  let truncated = false;
  if (x.length > MAX_SAMPLES) {
    truncated = true;
    x = x.slice(0, MAX_SAMPLES);
    const fade = Math.min(64, MAX_SAMPLES);
    for (let i = 0; i < fade; i++) x[MAX_SAMPLES - fade + i] *= 1 - (i + 1) / fade;
  }
  const buf = new Uint8Array(CAB_BUFFER_SIZE);
  buf.set([0x43, 0x41, 0x42, 0x00], 0); // "CAB\0"
  buf[18] = 0x01;
  buf[19] = level;
  const view = Buffer.from(buf.buffer);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-8388608, Math.min(8388607, Math.round(x[i] * 8388608)));
    view.writeIntLE(v, SAMPLE_OFFSET + 3 * i, 3);
  }
  return { buffer: buf, samples: x.length, truncated, sourceRate: wav.sampleRate };
}
