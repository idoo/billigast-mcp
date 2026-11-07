// Prints the tools of a stdio MCP server as JSON [{name, description}], read from the running
// server so packaging never drifts from src/tools.ts.
// Usage: node scripts/list-tools.mjs <command> [args...]   (e.g. node dist/billigast-mcp.js)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/list-tools.mjs <command> [args...]");
  process.exit(2);
}
const client = new Client({ name: "list-tools", version: "0" });
await client.connect(new StdioClientTransport({ command, args }));
const { tools } = await client.listTools();
await client.close();
if (tools.length === 0) {
  console.error("list-tools: server listed no tools");
  process.exit(1);
}
console.log(JSON.stringify(tools.map(({ name, description }) => ({ name, description: description ?? "" })), null, 2));
