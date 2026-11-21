// Smoke test: drives the MCP server over stdio like an MCP client would.
// Usage: node scripts/smoke-test.mjs <export-path.atkg>
// Read-only except for preset selection and an unsaved live tweak that is reverted.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exportPath = process.argv[2] ?? "smoke-export.atkg";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/server.js"],
  env: { ...process.env },
});
const client = new Client({ name: "smoke-test", version: "0.1.0" });
await client.connect(transport);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? " (ERROR)" : ""}\n${t.length > 1500 ? t.slice(0, 1500) + " ..." : t}`);
  if (r.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
}

try {
  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));
  await call("tankg_connect");
  const st = await call("tankg_status");
  const presets = await call("tankg_list_presets");
  console.log("presets read:", presets.length, "9C =", JSON.stringify(presets[34]));
  const live = await call("tankg_get_preset", { live: true });
  const original = st.currentPreset;
  await call("tankg_select_preset", { preset: "9D" });
  await call("tankg_status");
  await call("tankg_select_preset", { preset: original ?? "9C" });
  // unsaved live tweak + revert (gain +1, then back)
  const g = live.gain;
  if (g < 100) {
    await call("tankg_set_live_values", { changes: { gain: g + 1 } });
    await call("tankg_get_preset", { live: true });
    await call("tankg_set_live_values", { changes: { gain: g } });
  }
  await call("tankg_select_preset", { preset: original ?? "9C" }); // reload stored values
  await call("tankg_export_presets", { path: exportPath });
  await call("tankg_disconnect");
} finally {
  await client.close();
}
