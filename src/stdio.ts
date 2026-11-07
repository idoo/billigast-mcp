// Local stdio entry for Claude Desktop, Claude Code, Cursor and Docker. Bundled by
// `npm run build:stdio` to dist/billigast-mcp.js. Stdout carries only MCP protocol messages.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";

await createServer().connect(new StdioServerTransport());
