import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isNew, lowestNewPrice, matchProducts, mentionsQuery, mergedProduct, mergeHits, mergeOffers, parseKey, SOURCE_IDS, verdict } from "./merge.js";
import { pricerunner } from "./sources/pricerunner.js";
import { prisjakt } from "./sources/prisjakt.js";
import type { CompareResult, MatchKind, MergedOffer, ProductDetail, ProductHit, SearchOptions, SearchResult, Source, SourceFailure, SourceId } from "./types.js";
import { WIDGET_TOOL_META } from "./widget/index.js";

export const INSTRUCTIONS = `Finds a product cheaper by checking Prisjakt and PriceRunner, Sweden's two price comparison sites, at once. Flow: search → compare with a product's key for every store's price; compare also takes a Prisjakt/PriceRunner product URL or a plain product name directly. Prices are SEK incl. VAT; shipping only where the site reports it. The same store listed on both sites is merged into one row. Prisjakt adds price history. Links go via the comparison sites. Read-only.
search merges both sites' hits into one product when they are the same model (GTIN or model, capacity, size and variant words agree; colours may be merged when one site lists none); sources shows each site's own price and offer count, cheapest the lower one. Variants such as 128 vs 256 GB or Pro vs non-Pro stay separate products.
compare returns new offers only unless include_used (cheapest_secondhand is reported regardless), cheapest_in_stock is reported in stock. Also the price history and a verdict against the 90-day and all-time lows. A key or URL from one site gets its counterpart on the other looked up by name; errors lists a site that failed while the other still answered.
Always give the user each offer's url. Keep at most 3 calls in parallel.`;

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

interface CompareArgs {
  product: string;
  in_stock_only: boolean;
  include_used: boolean;
  limit: number;
}

/** Site ids for a compare argument: a key, a product page URL or a product name (searched, first result). */
async function resolve(product: string, errors: SourceFailure[]): Promise<{ ids: Partial<Record<SourceId, string>>; match: MatchKind }> {
  const ids = parseKey(product);
  if (ids) return { ids, match: null };
  const text = product.trim();
  if (/^https?:\/\//i.test(text) || /(?:prisjakt\.nu|pricerunner\.se)\//i.test(text)) {
    const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    for (const source of SOURCE_IDS) {
      const id = SOURCES[source].parseUrl(url);
      if (id) return { ids: { [source]: id }, match: null };
    }
    throw new Error(`Not a Prisjakt or PriceRunner product page URL: ${text}. Use a link to one product (prisjakt.nu/produkt.php?p=… or pricerunner.se/pl/…), a key from search, or the product's name.`);
  }
  const found = await search(text, { limit: 5 }, SOURCE_IDS);
  errors.push(...found.errors);
  const first = found.products[0];
  if (!first) throw new Error(`Nothing on Prisjakt or PriceRunner matches "${text}". Try fewer or different words, or search first.`);
  const fromKey = parseKey(first.key) ?? {};
  return { ids: fromKey, match: first.match };
}

async function fetchDetails(ids: Partial<Record<SourceId, string>>, errors: SourceFailure[]): Promise<Partial<Record<SourceId, ProductDetail>>> {
  const wanted = SOURCE_IDS.filter((source) => ids[source]);
  const settled = await Promise.allSettled(wanted.map((source) => SOURCES[source].product(ids[source] as string)));
  const details: Partial<Record<SourceId, ProductDetail>> = {};
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") details[wanted[i]] = outcome.value;
    else errors.push({ source: wanted[i], message: message(outcome.reason) });
  });
  return details;
}

async function compare(args: CompareArgs): Promise<CompareResult> {
  const errors: SourceFailure[] = [];
  const { ids, match: resolved } = await resolve(args.product, errors);
  const details = await fetchDetails(ids, errors);
  const found = SOURCE_IDS.filter((source) => details[source]);
  if (found.length === 0) throw new Error(errors.map((e) => `${SOURCES[e.source].label}: ${e.message}`).join("; "));

  let match = resolved;
  // One site known: look the product up on the other by name and take its best hit that is the same product.
  const other = SOURCE_IDS.find((source) => !ids[source] && !errors.some((e) => e.source === source));
  if (found.length === 1 && other) {
    const base = details[found[0]] as ProductDetail;
    try {
      for (const hit of await SOURCES[other].search(base.name, { limit: 5 })) {
        const kind = matchProducts(base, hit);
        if (!kind) continue;
        Object.assign(details, await fetchDetails({ [other]: hit.id }, errors));
        if (details[other]) match = kind;
        break;
      }
    } catch (error) {
      errors.push({ source: other, message: message(error) });
    }
  }

  const listed = SOURCE_IDS.map((source) => details[source]).filter((detail): detail is ProductDetail => detail !== undefined);
  if (listed.length > 1 && !match) match = matchProducts(listed[0], listed[1]) ?? "name";
  const product = mergedProduct(listed, match);
  for (const detail of listed) {
    const lowest = lowestNewPrice(detail.offers);
    const listing = product.sources[detail.source];
    if (listing && lowest !== null) listing.lowest_price = lowest;
  }

  const all = mergeOffers(listed.flatMap((detail) => detail.offers));
  const fresh = all.filter(isNew);
  const cheapest = fresh[0] ?? null;
  const cheapest_in_stock = fresh.find((offer) => offer.in_stock === true) ?? null;
  const cheapest_secondhand = all.find((offer) => !isNew(offer)) ?? null;
  if (cheapest) {
    const [source, price] = (Object.entries(cheapest.seen_on) as [SourceId, number][]).reduce((a, b) => (b[1] < a[1] ? b : a));
    product.cheapest = { price, source };
  }

  const offers: MergedOffer[] = all
    .filter((offer) => args.include_used || isNew(offer))
    .filter((offer) => !args.in_stock_only || offer.in_stock === true)
    .slice(0, args.limit);
  const history = details.prisjakt?.history ?? details.pricerunner?.history ?? null;
  return {
    product,
    offers,
    cheapest,
    cheapest_in_stock,
    cheapest_secondhand,
    history,
    verdict: verdict(cheapest?.price ?? null, history),
    errors,
  };
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "search",
    {
      title: "Search Prisjakt and PriceRunner",
      description:
        "Search Prisjakt and PriceRunner at once. Returns products with both sites' listings merged when they are the same model: key (pass to compare), name, brand, category, image, rating, each site's lowest price, offer count and url (sources), how the sites were tied (match: gtin/name, null for one site) and the cheapest site. errors lists a site that failed; the other's results still come back.",
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
      _meta: WIDGET_TOOL_META,
    },
    ({ query, min_price, max_price, limit, sources }) =>
      result(() => search(query, { limit, min_price, max_price }, sources ? SOURCE_IDS.filter((s) => sources.includes(s)) : SOURCE_IDS)),
  );

  server.registerTool(
    "compare",
    {
      title: "Compare store prices",
      description:
        "Every store's price for one product across Prisjakt and PriceRunner, cheapest first by total (price + shipping) when shipping is known, else price. The same store on both sites is one row with both prices in seen_on. Also cheapest (new), cheapest_secondhand (used/refurbished), cheapest_in_stock (new, reported in stock), Prisjakt's price history (lowest new price per day; 30/90-day and all-time lows) and a verdict on the cheapest price. With only one site known the other is looked up by name; not found = one site only.",
      inputSchema: {
        product: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe(
            "A key from search ('prisjakt:123+pricerunner:456'), a Prisjakt or PriceRunner product page URL, or a plain product name (the first search result is used).",
          ),
        in_stock_only: z.boolean().default(false).describe("List only offers the site reports in stock. Default false."),
        include_used: z
          .boolean()
          .default(false)
          .describe("Also list used and refurbished offers. Default false: new only (unknown condition counts as new). cheapest_secondhand is reported either way."),
        limit: z.number().int().min(1).max(50).default(20).describe("Offers to list, 1-50, default 20."),
      },
      annotations: { title: "Compare store prices", ...READ_ONLY },
      _meta: WIDGET_TOOL_META,
    },
    (args) => result(() => compare(args)),
  );
}
