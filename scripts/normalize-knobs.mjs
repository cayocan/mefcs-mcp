// Clamp every knob value above 100 to 100 on the pedal (M-EFCS uses 0-100).
// Usage: node scripts/normalize-knobs.mjs [--dry-run]
// Uses the MCP tools: export (read), then import (automatic backup + verify).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dryRun = process.argv.includes("--dry-run");
const KNOB_BYTES = { 4: "gate", 6: "gain", 7: "treble", 8: "middle", 9: "bass", 10: "volume", 12: "mod.rate", 14: "delay.time", 16: "reverb.mix" };

const client = new Client({ name: "normalize-knobs", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/src/server.js"], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(t);
  return JSON.parse(t);
};

try {
  const dir = join(tmpdir(), "mefcs-mcp");
  mkdirSync(dir, { recursive: true });
  const before = join(dir, "normalize-before.atkg");
  const after = join(dir, "normalize-after.atkg");
  await call("tankg_export_presets", { path: before });
  const bank = new Uint8Array(readFileSync(before));
  const changes = [];
  for (let i = 0; i < 36; i++) {
    for (const [off, name] of Object.entries(KNOB_BYTES)) {
      const p = 2 + i * 21 + Number(off);
      if (bank[p] > 100) {
        changes.push(`${Math.floor(i / 4) + 1}${"ABCD"[i % 4]}.${name}: ${bank[p]} -> 100`);
        bank[p] = 100;
      }
    }
  }
  console.log(changes.length ? changes.join("\n") : "Nothing above 100.");
  if (changes.length && !dryRun) {
    writeFileSync(after, bank);
    const r = await call("tankg_import_presets", { path: after });
    console.log(JSON.stringify(r, null, 2));
  }
  await call("tankg_disconnect");
} finally {
  await client.close();
}
