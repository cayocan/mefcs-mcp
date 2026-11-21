/**
 * SysEx framing used by M-VAVE / Sinco devices talking to M-EFCS.
 *
 * Every device message (except the raw identity request/reply) is an 8-bit frame
 * packed into a 7-bit, LSB-first bitstream that starts right after 0xF0:
 *
 *   frame = 00 59 <dev> <len u16 LE> <body ...> <checksum>
 *   len   = body.length - 1
 *   ck    = (~sum(body)) & 0xFF
 *
 * dev = 0x23 for reads (and read replies), 0x22 for writes, 0x00 for ACKs.
 * body = 00 <space> <offset u32 LE> <count u16 LE> 00 <payload ...>
 */

export const DEV_READ = 0x23;
export const DEV_WRITE = 0x22;
export const DEV_ACK = 0x00;

/** Unpack 7-bit MIDI bytes into 8-bit bytes (LSB-first bitstream). */
export function unpack7(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of data) {
    acc |= (b & 0x7f) << bits;
    bits += 7;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Pack 8-bit bytes into 7-bit MIDI bytes (LSB-first bitstream). */
export function pack7(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of data) {
    acc |= b << bits;
    bits += 8;
    while (bits >= 7) {
      out.push(acc & 0x7f);
      acc >>>= 7;
      bits -= 7;
    }
  }
  if (bits > 0) out.push(acc & 0x7f);
  return Uint8Array.from(out);
}

export function checksum(body: Uint8Array): number {
  let sum = 0;
  for (const b of body) sum += b;
  return ~sum & 0xff;
}

/** Build the body of a memory request: 00 <space> <offset> <count> 00 <payload>. */
export function memoryBody(space: number, offset: number, count: number, payload?: Uint8Array): Uint8Array {
  const p = payload ?? new Uint8Array(0);
  const body = new Uint8Array(9 + p.length);
  body[0] = 0x00;
  body[1] = space & 0xff;
  new DataView(body.buffer).setUint32(2, offset >>> 0, true);
  new DataView(body.buffer).setUint16(6, count & 0xffff, true);
  body[8] = 0x00;
  body.set(p, 9);
  return body;
}

/** Wrap a body into a complete SysEx message (F0 ... F7). */
export function buildSysex(dev: number, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + body.length + 1);
  frame[0] = 0x00;
  frame[1] = 0x59;
  frame[2] = dev;
  frame[3] = (body.length - 1) & 0xff;
  frame[4] = ((body.length - 1) >> 8) & 0xff;
  frame.set(body, 5);
  frame[frame.length - 1] = checksum(body);
  const packed = pack7(frame);
  const msg = new Uint8Array(packed.length + 2);
  msg[0] = 0xf0;
  msg.set(packed, 1);
  msg[msg.length - 1] = 0xf7;
  return msg;
}

export interface ParsedFrame {
  dev: number;
  body: Uint8Array;
  checksumOk: boolean;
  /** Present when the body has the memory layout. */
  space?: number;
  offset?: number;
  count?: number;
  payload?: Uint8Array;
}

/** Parse a SysEx message produced by the device (or by M-EFCS). Returns null for non-framed messages. */
export function parseSysex(msg: Uint8Array): ParsedFrame | null {
  if (msg.length < 4 || msg[0] !== 0xf0 || msg[msg.length - 1] !== 0xf7) return null;
  // Raw identity messages (F0 00 32 45 ...) are not bit-packed frames.
  if (msg[1] === 0x00 && msg[2] === 0x32 && msg[3] === 0x45) return null;
  const frame = unpack7(msg.subarray(1, msg.length - 1));
  if (frame.length < 7 || frame[0] !== 0x00 || frame[1] !== 0x59) return null;
  const len = frame[3] | (frame[4] << 8);
  const body = frame.subarray(5, 5 + len + 1);
  const ck = frame[5 + len + 1];
  const parsed: ParsedFrame = { dev: frame[2], body, checksumOk: ck === checksum(body) };
  if (body.length >= 9) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    parsed.space = body[1];
    parsed.offset = dv.getUint32(2, true);
    parsed.count = dv.getUint16(6, true);
    parsed.payload = body.subarray(9, 9 + (parsed.count ?? 0));
  }
  return parsed;
}

export function isAck(f: ParsedFrame): boolean {
  return f.dev === DEV_ACK && f.body.length >= 2 && f.body[1] === 0x00;
}

export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
