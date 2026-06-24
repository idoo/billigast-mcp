import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mentionsQuery, mergeHits, SOURCE_IDS } from "./merge.js";
import { pricerunner } from "./sources/pricerunner.js";
import { prisjakt } from "./sources/prisjakt.js";
import type { ProductHit, SearchOptions, SearchResult, Source, SourceFailure, SourceId } from "./types.js";

export const INSTRUCTIONS = `Finds a product cheaper by checking Prisjakt and PriceRunner, Sweden's two price comparison sites, at once. Prices are SEK incl. VAT. Links go to the comparison sites' product pages. Read-only.
search merges both sites' hits into one product when they are the same model (GTIN or model, capacity, size and variant words agree; colours may be merged when one site lists none); sources shows each site's own price and offer count, cheapest the lower one. Variants such as 128 vs 256 GB or Pro vs non-Pro stay separate products.
Keep at most 3 calls in parallel.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const SOURCES: Record<SourceId, Source> = { prisjakt, pricerunner };

function failure(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

function result(run: () => Promise<object>) {
  return run().then(
    (data) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    }),
    failure,
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function search(query: string, opts: SearchOptions, sources: readonly SourceId[]): Promise<SearchResult> {
  if (opts.min_price !== undefined && opts.max_price !== undefined && opts.min_price > opts.max_price) {
    throw new Error("min_price is above max_price.");
  }
  const settled = await Promise.allSettled(sources.map((source) => SOURCES[source].search(query, opts)));
  const lists: Partial<Record<SourceId, ProductHit[]>> = {};
  const errors: SourceFailure[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") lists[sources[i]] = outcome.value.filter((hit) => mentionsQuery(query, hit.name));
    else errors.push({ source: sources[i], message: message(outcome.reason) });
  });
  if (errors.length === sources.length) throw new Error(errors.map((e) => `${SOURCES[e.source].label}: ${e.message}`).join("; "));
  return { query, products: mergeHits(lists).slice(0, opts.limit), errors };
}
export function registerTools(server: McpServer) {
  server.registerTool(
    "search",
    {
      title: "Search Prisjakt and PriceRunner",
      description:
        "Search Prisjakt and PriceRunner at once. Returns products with both sites' listings merged when they are the same model: key, name, brand, category, image, rating, each site's lowest price, offer count and url (sources), how the sites were tied (match: gtin/name, null for one site) and the cheapest site. errors lists a site that failed; the other's results still come back.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Product to look for, e.g. 'airpods pro 2', 'iphone 16 128gb', 'samsung qe55q80d'. Model names and numbers work best."),
        min_price: z.number().min(0).optional().describe("Lowest price, SEK incl. VAT."),
        max_price: z.number().min(0).optional().describe("Highest price, SEK incl. VAT."),
        limit: z.number().int().min(1).max(20).default(8).describe("Products to return, 1-20, default 8."),
        sources: z
          .array(z.enum(["prisjakt", "pricerunner"]))
          .min(1)
          .optional()
          .describe("Sites to search, default both: ['prisjakt'], ['pricerunner'] or both."),
      },
      annotations: { title: "Search Prisjakt and PriceRunner", ...READ_ONLY },
    },
    ({ query, min_price, max_price, limit, sources }) =>
      result(() => search(query, { limit, min_price, max_price }, sources ? SOURCE_IDS.filter((s) => sources.includes(s)) : SOURCE_IDS)),
  );
}
