/**
 * Golden tests: compare what this package generates with SysEx captured from M-EFCS 3.11.2015.
 * Run: npm run build && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSysex, memoryBody, parseSysex, DEV_READ, DEV_WRITE, fromHex, toHex } from "../src/protocol/framing.js";
import { encodeA2Lite } from "../src/codecs/a2lite.js";
import { encodeCab } from "../src/codecs/ir.js";
import { decodeBank, encodeRecordRaw, encodeRecord, encodeWithChanges } from "../src/devices/tankg-presets.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => join(here, "..", "..", "test", "fixtures", f);
// Third-party captures (TONE3000 models/IRs and the uploads derived from them) are not redistributed
// in the public repo. Tests that need them are skipped when the files are missing.
const missing = (...files: string[]) => {
  const absent = files.filter((f) => !existsSync(fx(f)));
  return absent.length ? `local-only fixture missing: ${absent.join(", ")}` : false;
};

function sentMessages(log: string, from = "", to = "99"): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const line of readFileSync(fx(log), "ascii").split(/\r?\n/)) {
    const m = line.match(/^(\S+) > send \d+ ([0-9a-f]+)\\n/);
    if (m && m[1] >= from && m[1] < to) out.push(fromHex(m[2]));
  }
  return out;
}

test("framing round-trips every message M-EFCS sent", () => {
  for (const log of ["upload-session.log", "preset-session.log"].filter((f) => existsSync(fx(f)))) {
    for (const msg of sentMessages(log)) {
      const f = parseSysex(msg);
      if (!f) continue; // raw identity request
      assert.ok(f.checksumOk);
      assert.equal(toHex(buildSysex(f.dev, f.body)), toHex(msg));
    }
  }
});

test("memory request bodies match captured preset traffic", () => {
  const sent = sentMessages("preset-session.log").map(toHex);
  // read live preset (21 bytes at 0x10000000)
  assert.ok(sent.includes(toHex(buildSysex(DEV_READ, memoryBody(0x04, 0x10000000, 21)))));
  // select preset 9D (index 35) and 9C (34)
  assert.ok(sent.includes(toHex(buildSysex(DEV_WRITE, memoryBody(0x04, 0xe0000000 + 35, 1, Uint8Array.of(1))))));
  assert.ok(sent.includes(toHex(buildSysex(DEV_WRITE, memoryBody(0x04, 0xe0000000 + 34, 1, Uint8Array.of(1))))));
  // commit
  assert.ok(sent.includes(toHex(buildSysex(DEV_WRITE, memoryBody(0x04, 0xf0000000, 0)))));
  // full bank read
  assert.ok(sent.includes(toHex(buildSysex(DEV_READ, memoryBody(0x04, 0, 758)))));
});

test("A2 Lite encoder matches the M-EFCS upload of the Mesa capture", { skip: missing("mesa.nam", "upload-session.log") }, () => {
  const sent = sentMessages("upload-session.log", "12:12:20", "12:12:21").filter((m) => m.length !== 20);
  const enc = encodeA2Lite(fx("mesa.nam"), "2. MESA DUAL RECTIFIER 2025 _ RHYTHM #2").buffer;
  const mine: Uint8Array[] = [];
  for (let off = 0; off < 8192; off += 1015)
    mine.push(buildSysex(DEV_WRITE, memoryBody(0x05, off, Math.min(1015, 8192 - off), enc.subarray(off, Math.min(off + 1015, 8192)))));
  mine.push(buildSysex(DEV_WRITE, memoryBody(0x05, 0xa0000000, 1, Uint8Array.of(1))));
  mine.push(buildSysex(DEV_WRITE, memoryBody(0x05, 0xf0000000 + 6, 1, Uint8Array.of(0))));
  assert.equal(mine.length, sent.length);
  let identical = 0;
  for (let i = 0; i < sent.length; i++) if (toHex(sent[i]) === toHex(mine[i])) identical++;
  // Chunk 8 differs only in the last bits of the float32 steady-state values (M-EFCS computes in float32).
  assert.ok(identical >= sent.length - 1, `only ${identical}/${sent.length} identical`);
  // Compare the whole reassembled buffers as float32 from offset 60.
  const blob = new Uint8Array(8192);
  for (const m of sent.slice(0, 9)) {
    const f = parseSysex(m)!;
    blob.set(f.payload!, f.offset!);
  }
  const fa = new Float32Array(blob.buffer.slice(60, 8120));
  const fb = new Float32Array(enc.buffer.slice(60, 8120));
  for (let i = 0; i < fa.length; i++) {
    if (fa[i] === fb[i]) continue;
    const rel = Math.abs(fa[i] - fb[i]) / Math.max(1e-6, Math.abs(fa[i]));
    assert.ok(rel < 1e-3, `float ${i}: ${fa[i]} vs ${fb[i]}`);
  }
});

test("cab encoder matches the M-EFCS IR upload (header exact, samples within 0.5%)", { skip: missing("ir8.wav", "ir8_upload.bin") }, () => {
  const ref = new Uint8Array(readFileSync(fx("ir8_upload.bin")));
  const enc = encodeCab(fx("ir8.wav"), 50).buffer;
  assert.equal(toHex(enc.subarray(0, 20)), toHex(ref.subarray(0, 20)));
  const read = (b: Uint8Array, i: number) => Buffer.from(b).readIntLE(20 + 3 * i, 3) / 8388608;
  let maxDiff = 0;
  for (let i = 0; i < 675; i++) maxDiff = Math.max(maxDiff, Math.abs(read(enc, i) - read(ref, i)));
  assert.ok(maxDiff < 0.005, `max sample diff ${maxDiff}`);
});

test("preset bank decode/encode round-trips the final preset list", () => {
  const bank = new Uint8Array(readFileSync(fx("final.atkg")));
  const presets = decodeBank(bank);
  assert.equal(presets.length, 36);
  for (const p of presets) assert.equal(toHex(encodeRecordRaw(p)), toHex(bank.subarray(2 + p.index * 21, 2 + (p.index + 1) * 21)));
  assert.equal(presets[34].id, "9C");
  assert.throws(() => encodeRecord({ ...presets[0], volume: 127 }));
  // Changing gain keeps a legacy volume of 114 untouched; changing volume above 100 is rejected.
  const p9c = presets[34];
  const r = encodeWithChanges(p9c, { gain: p9c.gain + 1 }).record;
  assert.equal(r[6], p9c.gain + 1);
  assert.equal(r[10], 114);
  assert.throws(() => encodeWithChanges(p9c, { volume: 101 }));
});
