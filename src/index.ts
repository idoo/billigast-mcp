// Stateless MCP server (Streamable HTTP, JSON responses) for Prisjakt and PriceRunner price comparison.
// The endpoint lives at /mcp/<MCP_PATH_TOKEN>: ChatGPT's custom MCP connector offers only OAuth or no auth,
// so the unguessable path is the access control; everything else is a cheap 404.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { INSTRUCTIONS, registerTools } from "./tools.js";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!env.MCP_PATH_TOKEN || pathname !== `/mcp/${env.MCP_PATH_TOKEN}`) {
      return new Response("Not found", { status: 404 });
    }
    // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (!(await env.LIMITER.limit({ key: "mcp" })).success) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Too many requests; retry in a minute." }, id: null },
        { status: 429 },
      );
    }

    const server = new McpServer(
      { name: "billigast", title: "Billigast", version: "0.1.0" },
      { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
    );
    registerTools(server);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<Env>;
