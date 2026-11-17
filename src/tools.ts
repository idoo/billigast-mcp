import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isNew, lowestNewPrice, lowestSecondhandPrice, matchProducts, mentionsQuery, mergedProduct, mergeHits, mergeOffers, parseKey, SOURCE_IDS, verdict } from "./merge.js";
import { findByGtin, listingsByGtin, pricerunner } from "./sources/pricerunner.js";
import { prisjakt } from "./sources/prisjakt.js";
import { pickForName } from "./pick.js";
import { LANGUAGE_ERROR, NON_LATIN_LETTER, normalizeTyreSizes, stripIntentWords } from "./query.js";
import type { CompareResult, MatchKind, MergedOffer, ProductDetail, ProductHit, SearchOptions, SearchResult, Source, SourceFailure, SourceId } from "./types.js";
import { WIDGET_TOOL_META } from "./widget/index.js";

export const INSTRUCTIONS = `Finds a product cheaper by checking Prisjakt and PriceRunner, Sweden's two price comparison sites, at once. Flow: search → compare with a product's key for every store's price; compare also takes a Prisjakt/PriceRunner product URL or a plain product name directly (a name must carry the product's model numbers, else compare reports not found rather than guess). Prices are SEK incl. VAT; shipping only where the site reports it. The same store listed on both sites is merged into one row. Prisjakt adds price history. Links go via the comparison sites. Read-only.
search merges both sites' hits into one product when they are the same product: tied by EAN/GTIN when Prisjakt lists one and PriceRunner knows it, else by model words (model, capacity, size and variant words agree; colours may be merged when one site lists none); match says which (gtin, name, or null for one site). PriceRunner lists each colour as its own product while Prisjakt lists the model once: a row carries PriceRunner's cheapest colour, or the colour named in the query, so name the colour when the user wants one. sources shows each site's lowest new price, lowest used/refurbished price and offer count, cheapest the lower new price. Used and refurbished prices never count as a lowest or cheapest price. Variants such as 128 vs 256 GB or Pro vs non-Pro stay separate products.
compare returns new offers only unless include_used (cheapest_secondhand is reported regardless), sold-out offers last; each row's price, shipping, total and url belong to one offer, seen_on shows each site's price. cheapest and cheapest_secondhand skip sold-out offers (their prices are often stale) unless nothing else is listed, cheapest_in_stock is reported in stock. Also Prisjakt's price history and a verdict comparing Prisjakt's lowest new price with it, noting a cheaper offer listed only on PriceRunner. A key or URL from one site gets its counterpart on the other looked up by EAN/GTIN, else by name; errors lists a site that failed while the other still answered, or a key whose two listings don't look like the same product (match is then null).
Query rules for search (and plain names given to compare): Swedish or English only, category words from other languages translated into Swedish (робот-пылесос → robotdammsugare, стиральная машина → tvättmaskin); brand + model + the spec that matters (128gb, 55 tum, 205/55 r16), colours in Swedish; no intent words (billigast, cheapest, köpa, pris, bästa, deal, rea, begagnad, ny); price limits in min_price/max_price, never in the query; one product or category per query.
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

const EMPTY_HINT =
  "Nothing found. Search again with Swedish product words (robotdammsugare, tvättmaskin, hörlurar), brand + model (roborock s8, bosch serie 6) or fewer words; put price limits in min_price/max_price, not in the query.";

/** Prisjakt-only rows of a search page whose GTINs are looked up on PriceRunner: 3 × 4 = 12 PriceRunner requests at most. */
const MAX_GTIN_BRIDGES = 3;
/** Prisjakt hits per compare checked by GTIN after failing the name match: each costs 3 PriceRunner requests. */
const MAX_GTIN_CHECKS = 2;

/**
 * Each site gets the query (tyre sizes spaced as the sites write them) and keeps the hits that mention it.
 * A site with no such hit is asked once more without intent words and price phrases ("cheapest", "pris",
 * "under 1000"): Prisjakt finds nothing unless every word is in a product.
 */
async function search(input: string, opts: SearchOptions, sources: readonly SourceId[]): Promise<SearchResult> {
  if (opts.min_price !== undefined && opts.max_price !== undefined && opts.min_price > opts.max_price) {
    throw new Error("min_price is above max_price.");
  }
  if (NON_LATIN_LETTER.test(input)) throw new Error(LANGUAGE_ERROR);
  const query = normalizeTyreSizes(input);
  const reduced = stripIntentWords(query);
  let reducedFound = false;
  const find = async (source: SourceId) => {
    const fitting = async (text: string) => (await SOURCES[source].search(text, opts)).filter((hit) => mentionsQuery(text, hit.name, hit.category));
    const hits = await fitting(query);
    if (hits.length || !reduced) return hits;
    const retried = await fitting(reduced);
    if (retried.length) reducedFound = true;
    return retried;
  };
  const settled = await Promise.allSettled(sources.map(find));
  const lists: Partial<Record<SourceId, ProductHit[]>> = {};
  const errors: SourceFailure[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") lists[sources[i]] = outcome.value;
    else errors.push({ source: sources[i], message: message(outcome.reason) });
  });
  if (errors.length === sources.length) throw new Error(errors.map((e) => `${SOURCES[e.source].label}: ${e.message}`).join("; "));
  const used = reducedFound ? reduced : query;
  let products = mergeHits(lists, { query: used ?? query });
  // GTIN bridge: a Prisjakt row the names didn't tie may still be on PriceRunner under one of its EANs.
  // Only when both sites answered, so sources: ["prisjakt"] makes no PriceRunner request.
  if (lists.prisjakt && lists.pricerunner) {
    const known = lists.pricerunner;
    const bridged = products
      .slice(0, opts.limit)
      .filter((row) => row.sources.prisjakt && !row.sources.pricerunner && row.gtin.length)
      .slice(0, MAX_GTIN_BRIDGES);
    const hits = await Promise.all(bridged.map((row) => findByGtin(row.gtin, opts).catch(() => null)));
    const ties: { prisjakt: string; pricerunner: string }[] = [];
    hits.forEach((hit, i) => {
      const listing = bridged[i].sources.prisjakt;
      // Two rows reaching the same PriceRunner listing: the first (higher-ranked) one keeps it.
      if (!hit || !listing || ties.some((tie) => tie.pricerunner === hit.id)) return;
      if (!known.some((existing) => existing.id === hit.id)) known.push(hit);
      ties.push({ prisjakt: listing.id, pricerunner: hit.id });
    });
    if (ties.length) products = mergeHits(lists, { query: used ?? query, ties });
  }
  const found: SearchResult = { query: input, products: products.slice(0, opts.limit), errors };
  if (used && used !== input) found.used_query = used;
  if (found.products.length === 0 && errors.length === 0) found.hint = EMPTY_HINT;
  return found;
}

interface CompareArgs {
  product: string;
  in_stock_only: boolean;
  include_used: boolean;
  limit: number;
}

/** Site ids for a compare argument: a key, a product page URL or a product name (searched, then pickForName). */
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
  // Five rows hold the plain model in every fixture query checked (at most row 3); a longer page only adds
  // PriceRunner requests and lets accessories that fold more listings move up.
  const found = await search(text, { limit: 5 }, SOURCE_IDS);
  errors.push(...found.errors);
  // search keeps only listings carrying every model code and number of the name (mentionsQuery), so a
  // name like "samsung qe55q80d" finds that TV or nothing, never some other Samsung; pickForName then
  // prefers the plain model the name states over a variant ranked above it.
  const picked = pickForName(text, found.products);
  if (!picked) {
    throw new Error(`Nothing on Prisjakt or PriceRunner matches "${text}" with all its model numbers. Check the model code, try fewer or different words, or search first.`);
  }
  return { ids: parseKey(picked.key) ?? {}, match: picked.match };
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

/**
 * The full name, then the name cut before "med"/"with"/" - "/",", then the cut name up to its last word with
 * a digit (Garmin Forerunner 265 Black/Powder Gray → Garmin Forerunner 265: colour words split PriceRunner's
 * listings), then its first five words.
 */
function counterpartQueries(name: string): string[] {
  const cut = name.split(/\s+(?:med|with|inkl\.?|för|for)\s+|\s+[-–]\s+|,/i)[0].trim();
  const words = cut.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  const model = words.slice(0, words.findLastIndex((word) => /\d/.test(word)) + 1).join(" ");
  return [...new Set([name, cut, model, words.slice(0, 5).join(" ")])].filter((query) => query.length >= 3);
}

async function compare(args: CompareArgs): Promise<CompareResult> {
  const errors: SourceFailure[] = [];
  const { ids, match: resolved } = await resolve(args.product, errors);
  const details = await fetchDetails(ids, errors);
  const found = SOURCE_IDS.filter((source) => details[source]);
  if (found.length === 0) throw new Error(errors.map((e) => `${SOURCES[e.source].label}: ${e.message}`).join("; "));

  let match = resolved;
  // One site known: look the product up on the other, first by GTIN (a Prisjakt listing's EANs lead to the
  // PriceRunner listing), else by name, taking the best hit that is the same product.
  // PriceRunner's search wants close wording, so a long Prisjakt name ("... med MagSafe laddningsfodral USB-C")
  // finds nothing; shorter forms of the name are tried next.
  const other = SOURCE_IDS.find((source) => !ids[source] && !errors.some((e) => e.source === source));
  if (found.length === 1 && other) {
    const base = details[found[0]] as ProductDetail;
    try {
      if (other === "pricerunner" && base.gtin.length) {
        // A failed GTIN lookup only means the name lookup below gets its turn.
        const hit = await findByGtin(base.gtin).catch(() => null);
        if (hit) {
          Object.assign(details, await fetchDetails({ pricerunner: hit.id }, errors));
          if (details.pricerunner) match = "gtin";
        }
      }
      if (!details[other]) {
        let gtinChecks = 0;
        lookup: for (const query of counterpartQueries(base.name)) {
          for (const hit of await SOURCES[other].search(query, { limit: 5 })) {
            let kind = matchProducts(base, hit);
            // A Prisjakt hit whose name doesn't match may still carry the PriceRunner listing's EAN.
            if (!kind && other === "prisjakt" && hit.gtin.length && gtinChecks < MAX_GTIN_CHECKS) {
              gtinChecks++;
              if ((await listingsByGtin(hit.gtin)).some((listing) => listing.id === base.id)) kind = "gtin";
            }
            if (!kind) continue;
            Object.assign(details, await fetchDetails({ [other]: hit.id }, errors));
            if (details[other]) match = kind;
            break lookup;
          }
        }
      }
    } catch (error) {
      errors.push({ source: other, message: message(error) });
    }
  }

  const listed = SOURCE_IDS.map((source) => details[source]).filter((detail): detail is ProductDetail => detail !== undefined);
  if (listed.length > 1 && !match) {
    match = matchProducts(listed[0], listed[1]);
    if (!match) {
      errors.push({
        source: listed[1].source,
        message: `"${listed[1].name}" doesn't look like the same product as ${SOURCES[listed[0].source].label}'s "${listed[0].name}"; both sites' offers are listed together anyway.`,
      });
    }
  }
  const product = mergedProduct(listed, match);
  // A site's listing price can be a used or refurbished one when it has no new offers; the offers tell them apart.
  for (const detail of listed) {
    const listing = product.sources[detail.source];
    if (!listing) continue;
    listing.lowest_price = lowestNewPrice(detail.offers);
    listing.lowest_price_secondhand = lowestSecondhandPrice(detail.offers);
  }

  const all = mergeOffers(listed.flatMap((detail) => detail.offers));
  const fresh = all.filter(isNew);
  // mergeOffers puts sold-out rows last, so the first new / used row is the cheapest one not known to
  // be sold out, falling back to a sold-out one only when nothing else is listed.
  const cheapest = fresh[0] ?? null;
  const cheapest_in_stock = fresh.find((offer) => offer.in_stock === true) ?? null;
  const cheapest_secondhand = all.find((offer) => !isNew(offer)) ?? null;
  const siteOf = (offer: MergedOffer) =>
    (Object.entries(offer.seen_on) as [SourceId, number][]).find(([, price]) => price === offer.price)?.[0] ?? (Object.keys(offer.seen_on)[0] as SourceId);
  product.cheapest = cheapest ? { price: cheapest.price, source: siteOf(cheapest) } : null;

  const offers: MergedOffer[] = all
    .filter((offer) => args.include_used || isNew(offer))
    .filter((offer) => !args.in_stock_only || offer.in_stock === true)
    .slice(0, args.limit);
  const history = details.prisjakt?.history ?? details.pricerunner?.history ?? null;
  // The history follows one site's lowest new price, so the verdict takes that site's price; a cheaper
  // offer seen only on the other site is named instead of being measured against a history it isn't in.
  const site = history ? SOURCES[history.source].label : "";
  const cheaper = history && cheapest && cheapest.seen_on[history.source] !== cheapest.price ? { price: cheapest.price, store: cheapest.store, site: SOURCES[siteOf(cheapest)].label } : null;
  return {
    product,
    offers,
    cheapest,
    cheapest_in_stock,
    cheapest_secondhand,
    history,
    verdict: verdict(history ? (product.sources[history.source]?.lowest_price ?? null) : null, history, site, cheaper),
    errors,
  };
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "search",
    {
      title: "Search Prisjakt and PriceRunner",
      description:
        "Use this when the user wants to know where a product is cheapest in Sweden, to compare store prices, or what something costs in Swedish shops (Elgiganten, Power, NetOnNet, Webhallen, Inet, Komplett, CDON and others, via Prisjakt and PriceRunner). Not for second-hand classified ads (Blocket, Tradera) or prices outside Sweden. Returns products, both sites' listings merged when they are the same product (by EAN/GTIN when Prisjakt lists one and PriceRunner knows it, else by model words): key (pass to compare), name, brand, category, image, rating, per site the lowest new and used/refurbished price, offer count and url (sources), match (gtin, name; null for one site) and cheapest (lowest new price; used never counts). used_query shows the words searched when they differ from query; hint says what to try when nothing is found; errors lists a site that failed while the other answered.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            "Product or category in Swedish or English, e.g. 'robotdammsugare roborock', 'tvättmaskin bosch', 'iphone 16 128gb', 'dubbdäck 205/55 r16'. Translate category words from other languages into Swedish (наушники → hörlurar). Brand + model + the spec that matters (128gb, 55 tum, 205/55 r16); colours in Swedish (svart, vit). No intent words: billig/billigast/cheapest, köpa/buy, pris/price, bästa/best, deal/rea, begagnad/used, ny/new. Price limits go in min_price/max_price, not here. One product or category per query.",
          ),
        min_price: z.number().min(0).optional().describe("Lowest price, SEK incl. VAT, e.g. 500 for 'över 500 kr'."),
        max_price: z.number().min(0).optional().describe("Highest price, SEK incl. VAT, e.g. 1000 for 'under 1000 kr'."),
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
        "Use this when the user wants every store's price for one product, whether a price is good or a deal right now (Black Friday, rea), or its price history and lowest price in the last 30/90 days. Not for finding products: search first unless the name carries model numbers. Offers from Prisjakt and PriceRunner, cheapest first by total (price + shipping) when shipping is known, sold-out last; a store on both sites is one row (price, shipping, total, stock and url from one offer; seen_on has each site's price). Also cheapest (new), cheapest_secondhand and cheapest_in_stock, skipping sold-out offers unless nothing else is listed; Prisjakt's price history (lowest new price per day, 30/90-day and all-time lows) and a verdict on the current price against it, naming a cheaper offer listed only on PriceRunner. A site without the product's key is looked up by EAN/GTIN, else by name; match is gtin, name or null.",
      inputSchema: {
        product: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe(
            "A key from search ('prisjakt:123+pricerunner:456'), a Prisjakt or PriceRunner product page URL, or a plain product name with its model numbers, e.g. 'airpods pro 3', 'samsung qe55q80d'. Names follow search's query rules: Swedish or English, brand and model in Latin letters, no intent words (billigast, pris, köpa). The top search result carrying the model numbers is used, preferring one without variant words the name lacks (Ultra, Pro, Max) and the regional model code most stores sell; none = not found.",
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
