/**
 * NAM (.nam, A2 SlimmableContainer) -> Tank-G "A2 Lite (Original)" amp model buffer.
 *
 * Reverse engineered from M-EFCS v98 uploads (see docs/PROTOCOL.md). The device receives the
 * weights of the *lite* WaveNet submodel unchanged except for convolution transposition, plus a
 * precomputed zero-input steady state used to prime the dilated convolution buffers.
 */
import { readFileSync } from "node:fs";

export const AMP_BUFFER_SIZE = 8192;
const AMP_PAYLOAD_SIZE = 8120;
/** Constant written by M-EFCS after the weights (same for every model and input range). */
const TAIL_CONSTANT = 825.0821533203125;
/** Constant EQ definition block written by M-EFCS (freq, min dB, max dB) x3. */
const EQ_DEFINITION = [150, -20, 20, 425, -15, 15, 1800, -10, 10];

interface WaveNetLayerConfig {
  input_size: number;
  condition_size: number;
  channels: number;
  bottleneck?: number;
  kernel_sizes?: number[];
  kernel_size?: number;
  dilations: number[];
  head: { out_channels: number; kernel_size: number; bias: boolean } | null;
  head1x1?: { active: boolean };
  layer1x1?: { active: boolean };
  gating_mode?: string[] | string | boolean;
}

interface WaveNetModel {
  architecture: string;
  config: { layers: WaveNetLayerConfig[]; head?: unknown };
  weights: number[];
  metadata?: Record<string, unknown>;
}

export interface A2LiteResult {
  buffer: Uint8Array;
  name: string;
  weightCount: number;
}

function pickLiteSubmodel(json: any): WaveNetModel {
  if (json.architecture === "SlimmableContainer") {
    const subs = [...json.config.submodels].sort((a: any, b: any) => a.max_value - b.max_value);
    return subs[0].model as WaveNetModel;
  }
  throw new Error(
    "This .nam file is not an A2 (SlimmableContainer) capture. The Tank-G 'A2 Lite (Original)' import needs an A2 model; standard WaveNet captures are not supported yet.",
  );
}

export function encodeA2Lite(namPath: string, displayName?: string): A2LiteResult {
  const json = JSON.parse(readFileSync(namPath, "utf8"));
  const model = pickLiteSubmodel(json);
  if (model.architecture !== "WaveNet") throw new Error(`Unsupported lite architecture: ${model.architecture}`);
  const layers = model.config.layers;
  if (layers.length !== 1) throw new Error(`Expected 1 layer array, got ${layers.length}`);
  const la = layers[0];
  const C = la.channels;
  const B = la.bottleneck ?? la.channels;
  const ks = la.kernel_sizes ?? la.dilations.map(() => la.kernel_size ?? 3);
  if (la.head1x1?.active) throw new Error("head1x1 is active; this layout is not supported by the encoder");
  if (la.layer1x1 && la.layer1x1.active === false) throw new Error("layer1x1 is inactive; unsupported layout");
  const gating = Array.isArray(la.gating_mode) ? la.gating_mode : [];
  if (gating.some((g) => g && g !== "none")) throw new Error("Gated layers are not supported by the encoder");
  if (!la.head) throw new Error("Model has no head; unsupported layout");
  const hk = la.head.kernel_size;

  const w = model.weights;
  let p = 0;
  const take = (n: number) => {
    const r = w.slice(p, p + n);
    if (r.length !== n) throw new Error("Weight list is shorter than the layout requires");
    p += n;
    return r;
  };

  const rechannel = take(C * la.input_size);
  type Layer = { conv: number[]; convBias: number[]; mixin: number[]; l1: number[]; l1Bias: number[]; k: number };
  const parsed: Layer[] = [];
  for (const k of ks) {
    parsed.push({
      conv: take(B * C * k), // [out=B][in=C][k]
      convBias: take(B),
      mixin: take(B * la.condition_size),
      l1: take(C * B), // [out=C][in=B]
      l1Bias: take(C),
      k,
    });
  }
  const head = take(B * hk); // [out=1][in=B][k]
  const headBias = take(1);
  const headScale = take(1);
  if (p !== w.length) throw new Error(`Unexpected weight count: consumed ${p} of ${w.length}`);

  // --- reorder weights for the device ---
  const out: number[] = [...rechannel];
  for (const L of parsed) {
    for (let k = 0; k < L.k; k++)
      for (let c = 0; c < C; c++) for (let o = 0; o < B; o++) out.push(L.conv[o * C * L.k + c * L.k + k]);
    out.push(...L.convBias, ...L.mixin);
    for (let b = 0; b < B; b++) for (let c = 0; c < C; c++) out.push(L.l1[c * B + b]);
    out.push(...L.l1Bias);
  }
  for (let k = 0; k < hk; k++) for (let b = 0; b < B; b++) out.push(head[b * hk + k]);
  out.push(...headBias, ...headScale);

  // --- zero-input steady state (residual stream after each layer, plus head accumulator) ---
  let x = new Array<number>(C).fill(0);
  const residuals: number[][] = [];
  const headAcc = new Array<number>(B).fill(0);
  for (const L of parsed) {
    const a: number[] = [];
    for (let o = 0; o < B; o++) {
      let s = L.convBias[o];
      for (let c = 0; c < C; c++) {
        let wsum = 0;
        for (let k = 0; k < L.k; k++) wsum += L.conv[o * C * L.k + c * L.k + k];
        s += wsum * x[c];
      }
      a.push(s > 0 ? s : 0.01 * s); // LeakyReLU(0.01)
    }
    const nx = x.slice();
    for (let c = 0; c < C; c++) {
      let s = L.l1Bias[c];
      for (let b = 0; b < B; b++) s += L.l1[c * B + b] * a[b];
      nx[c] = x[c] + s;
    }
    x = nx;
    residuals.push(x.slice());
    for (let b = 0; b < B; b++) headAcc[b] += a[b];
  }
  const tail = [TAIL_CONSTANT, 0, 0, 0, ...residuals.slice(0, -1).flat(), ...headAcc];

  // --- assemble ---
  const name = (displayName ?? (json.metadata?.name as string) ?? "NAM").replace(/[^\x20-\x7e]/g, "?");
  const buf = new Uint8Array(AMP_BUFFER_SIZE);
  const dv = new DataView(buf.buffer);
  buf.set([0x4e, 0x41, 0x4d, 0x00], 0); // "NAM\0"
  const nameBytes = Buffer.from(name.slice(0, 13), "ascii");
  buf.set(nameBytes, 4); // 13 bytes + NUL at 17
  buf.set([100, 100, 60, 30], 18); // output 100, 100, input max 60, input min 30 (M-EFCS defaults)
  EQ_DEFINITION.forEach((v, i) => dv.setFloat32(24 + 4 * i, v, true));
  const floats = [...out, ...tail];
  if (60 + 4 * floats.length > AMP_PAYLOAD_SIZE)
    throw new Error(`Model too large for the Tank-G amp buffer (${floats.length} floats)`);
  floats.forEach((v, i) => dv.setFloat32(60 + 4 * i, v, true));
  return { buffer: buf, name: name.slice(0, 13), weightCount: w.length };
}
