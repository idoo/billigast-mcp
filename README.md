# Billigast

Prisjakt and PriceRunner each know stores the other one doesn't, so this MCP server checks both. When the same product is on both sites you get one row with every Swedish store's price, cheapest first, and Prisjakt's price history underneath.

Read-only. No accounts or API keys.

## Tools

- `search` finds a product on both sites. It won't lump a 128 GB phone in with the 256 GB one, or Pro with Pro Max.
- `compare` takes a key from `search` and lists every store. It tells you how far today's price is from the 90-day low too.

## Deploy

It runs on a Cloudflare Worker, free plan:

```sh
npm ci && npx wrangler deploy
npx wrangler secret put MCP_PATH_TOKEN    # any long random string
```

Paste `https://<your worker>.workers.dev/mcp/<token>` as the URL. Other paths return 404. ChatGPT: Plugins, Add custom MCP server, no auth. claude.ai: Settings, Connectors.

## Caveats

Neither site has a public API. It calls the JSON endpoints their own pages use and skips whatever robots.txt disallows, PriceRunner's price history included, which is why history is Prisjakt only. When one of them changes something, that half breaks until someone fixes it.

Not affiliated with Prisjakt or PriceRunner. [MIT](LICENSE).
