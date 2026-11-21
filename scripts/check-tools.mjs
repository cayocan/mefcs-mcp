import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "check", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/src/server.js"] }));
const t = await c.listTools(); console.log(t.tools.length, "tools:", t.tools.map(x => x.name).join(", "));
for (const n of ["tone3000_auth_status", "tone3000_search", "tankg_effect_types"]) {
  const r = await c.callTool({ name: n, arguments: n === "tone3000_search" ? { query: "twin" } : {} });
  console.log("##", n, r.isError ? "(error)" : "", r.content[0].text.slice(0, 300));
}
await c.close();
