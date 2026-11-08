// Stateless MCP server (Streamable HTTP, JSON responses) for Prisjakt and PriceRunner price comparison.
// The endpoint lives at /mcp/<MCP_PATH_TOKEN>: ChatGPT's custom MCP connector offers only OAuth or no auth,
// so the unguessable path is the access control; everything else is a cheap 404.

import { handleMcp } from "./mcp.js";

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
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const allowed = (await env.IP_LIMITER.limit({ key: ip })).success && (await env.LIMITER.limit({ key: "mcp" })).success;
    if (!allowed) return rpcError(429, "Too many requests; retry in a minute.");
    // One rate-limit slot per request, so a JSON-RPC batch would run many tool calls for the price of one.
    // Protocol 2025-06-18 dropped batching and no client this serves sends them.
    const body = await request.clone().text();
    if (body.trimStart().startsWith("[")) return rpcError(400, "JSON-RPC batches aren't supported.");

    return handleMcp(request);
  },
} satisfies ExportedHandler<Env>;

function rpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}
