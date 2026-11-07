// Platform-neutral MCP server shared by the Cloudflare Worker (src/index.ts) and the local stdio
// entry (src/stdio.ts). Over HTTP it is stateless: a fresh server and transport per request, JSON responses, no sessions. Access control and rate
// limiting are the caller's job.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { version } from "../package.json";
import { INSTRUCTIONS, registerTools } from "./tools.js";
import { registerWidget } from "./widget/index.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "billigast", title: "Billigast", version },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  registerTools(server);
  registerWidget(server);
  return server;
}

export async function handleMcp(request: Request): Promise<Response> {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
