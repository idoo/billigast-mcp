# Billigast

Prisjakt and PriceRunner each know stores the other one doesn't, so this MCP server checks both. When the same product is on both sites you get one row with every Swedish store's price, cheapest first, and Prisjakt's price history underneath.

Read-only. No accounts or API keys.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-black)](https://modelcontextprotocol.io)

## Tools

- `search` finds a product on both sites. It won't lump a 128 GB phone in with the 256 GB one, or Pro with Pro Max.
- `compare` takes a search key, a Prisjakt or PriceRunner link or just a name, and lists every store. It tells you how far today's price is from the 90-day low too.

In ChatGPT both show a small card view.

## Local

Claude Desktop: grab the `.mcpb` from [Releases](https://github.com/idoo/billigast-mcp/releases) and double-click it.

Anything else can run it in Docker:

```sh
claude mcp add billigast -- docker run -i --rm ghcr.io/idoo/billigast-mcp
```

No Docker? Node 20 or newer works too:

```sh
npm ci && npm run build:stdio
node dist/billigast-mcp.js
```

## ChatGPT, claude.ai

ChatGPT and claude.ai won't talk to your laptop. I host mine on a Cloudflare Worker, free plan:

```sh
npm ci && npx wrangler deploy
npx wrangler secret put MCP_PATH_TOKEN    # any long random string
```

Paste `https://<your worker>.workers.dev/mcp/<token>` as the URL. Other paths return 404. ChatGPT: Plugins, Add custom MCP server, no auth. claude.ai: Settings, Connectors.

## Caveats

Neither site has a public API. It calls the JSON endpoints their own pages use and skips whatever robots.txt disallows, PriceRunner's price history included, which is why history is Prisjakt only. When one of them changes something, that half breaks until someone fixes it.

Not affiliated with Prisjakt or PriceRunner. [MIT](LICENSE).
