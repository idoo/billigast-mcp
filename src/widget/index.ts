import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import html from "./app.html";

// Hosts cache templates by URI: bump the version whenever app.html changes.
export const WIDGET_URI = "ui://billigast/widget-v2.html";

/** Product image hosts the sources return: PriceRunner (owp.klarna.com) and Prisjakt (the other two). */
const IMAGE_ORIGINS = ["https://owp.klarna.com", "https://pricespy-75b8.kxcdn.com", "https://media.pji.nu"];

/** Spread into `_meta` of the search and compare tools. MCP Apps key plus the ChatGPT compatibility aliases. */
export const WIDGET_TOOL_META: Record<string, unknown> = {
  ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": WIDGET_URI,
  "openai/widgetAccessible": true,
};

export function registerWidget(server: McpServer): void {
  server.registerResource(
    "billigast-widget",
    WIDGET_URI,
    {
      title: "Billigast",
      description: "Product search across Prisjakt and PriceRunner, and store price comparisons with price history.",
      mimeType: "text/html;profile=mcp-app",
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: {
            ui: { prefersBorder: true, csp: { resourceDomains: IMAGE_ORIGINS, connectDomains: [] } },
            "openai/widgetPrefersBorder": true,
            "openai/widgetDescription":
              "Shows products found on Prisjakt and PriceRunner with each site's lowest price, and a store-by-store price table with price history for one product.",
            "openai/widgetCSP": { resource_domains: IMAGE_ORIGINS, connect_domains: [] },
          },
        },
      ],
    }),
  );
}
