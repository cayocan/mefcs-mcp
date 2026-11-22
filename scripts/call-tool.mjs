#!/usr/bin/env node
/**
 * Call one tool of the local mefcs-mcp server over real MCP (stdio), the same way an AI client does.
 *
 *   node scripts/call-tool.mjs <tool-name> ['{"json":"arguments"}']
 *   node scripts/call-tool.mjs --list
 *
 * Environment variables are passed through to the server (MEFCS_BRIDGE_PATH, TONE3000_*, ...).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [tool, rawArgs] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node scripts/call-tool.mjs <tool-name> ['{json args}'] | --list");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "src", "server.js")],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "mefcs-call-tool", version: "0.1.0" });
await client.connect(transport);

try {
  if (tool === "--list") {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}\n    ${(t.description ?? "").split("\n")[0]}`);
  } else {
    const args = rawArgs ? JSON.parse(rawArgs) : {};
    const res = await client.callTool({ name: tool, arguments: args });
    for (const c of res.content ?? []) console.log(c.type === "text" ? c.text : JSON.stringify(c));
    if (res.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
