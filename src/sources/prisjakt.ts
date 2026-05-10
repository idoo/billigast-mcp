// Prisjakt (prisjakt.nu). Search: GraphQL searchV3 (the site's relevance ranking and price filter)
// enriched with products(ids) for brand, image, rating and GTIN. Product: GraphQL product.

import type { ProductHit, Rating, SearchOptions, Source } from "../types.js";
import { SourceError } from "../types.js";
import { SITE, graphql } from "./prisjakt/http.js";

// ---- GraphQL ----

const PRODUCT_FIELDS = `
  id name pathName
  brand { name }
  category { name }
  media { first(width: _280) }
  priceSummary { regular alternative count }
  userReviewSummary { rating count }
  variants { gtin14 }`;

const SEARCH_QUERY = `query Search($filters: [SearchFilter!]!) {
  searchV3 { products(page: 0, sortType: score, order: desc, filters: $filters, searchType: normal) {
    items { ... on ProductCard { productId name categoryName storeCount lowestNewPrice lowestUsedPrice } }
  } }
}`;

const PRODUCTS_QUERY = `query Products($ids: [Int!]!) { products(ids: $ids) { ${PRODUCT_FIELDS} } }`;
const PRODUCT_QUERY = `query Product($id: Int!) { product(id: $id) { ${PRODUCT_FIELDS} } }`;

interface Card {
  productId?: number;
  name?: string;
  categoryName?: string | null;
  storeCount?: number | null;
  lowestNewPrice?: number | null;
  lowestUsedPrice?: number | null;
}

interface GqlProduct {
  id: number;
  name: string;
  pathName?: string | null;
  brand?: { name?: string | null } | null;
  category?: { name?: string | null } | null;
  media?: { first?: string | null } | null;
  priceSummary?: { regular?: number | null; alternative?: number | null; count?: number | null } | null;
  userReviewSummary?: { rating?: number | null; count?: number | null } | null;
  variants?: { gtin14?: string | null }[] | null;
}

function rating(score: number | null | undefined, count: number | null | undefined): Rating | null {
  if (typeof score !== "number" || !count || count <= 0) return null;
  return { score: Math.round(score * 100) / 100, count, scale: 5 };
}

/** GTIN-14 as Prisjakt stores it → digits-only GTIN-13 (8/12-digit codes left-padded). */
function gtins(product: GqlProduct): string[] {
  const out = new Set<string>();
  for (const variant of product.variants ?? []) {
    const digits = variant.gtin14?.replace(/\D/g, "");
    if (!digits || /^0+$/.test(digits)) continue;
    if (digits.length === 14 && digits.startsWith("0")) out.add(digits.slice(1));
    else if (digits.length < 13) out.add(digits.padStart(13, "0"));
    else out.add(digits);
  }
  return [...out];
}

function absolute(path: string | null | undefined, fallback: string): string {
  if (!path) return fallback;
  return new URL(path, SITE).toString();
}

function toHit(product: GqlProduct, card?: Card): ProductHit {
  const summary = product.priceSummary;
  return {
    source: "prisjakt",
    id: String(product.id),
    name: product.name ?? card?.name ?? "",
    brand: product.brand?.name || null,
    category: product.category?.name ?? card?.categoryName ?? null,
    image: product.media?.first || null,
    url: absolute(product.pathName, `${SITE}/produkt.php?p=${product.id}`),
    lowest_price: card ? (card.lowestNewPrice ?? card.lowestUsedPrice ?? null) : (summary?.regular ?? summary?.alternative ?? null),
    offer_count: card?.storeCount ?? summary?.count ?? null,
    rating: rating(product.userReviewSummary?.rating, product.userReviewSummary?.count),
    gtin: gtins(product),
  };
}

function productId(id: string): number {
  const n = Number(id);
  if (!/^\d+$/.test(id.trim()) || !Number.isSafeInteger(n) || n <= 0) throw new SourceError(`Not a Prisjakt product id: ${id}`, "prisjakt", 400);
  return n;
}

export const prisjakt: Source = {
  id: "prisjakt",
  label: "Prisjakt",

  async search(query: string, opts: SearchOptions): Promise<ProductHit[]> {
    const filters: { key: string; value: string }[] = [{ key: "query", value: query }];
    if (opts.min_price !== undefined || opts.max_price !== undefined) {
      filters.push({ key: "price", value: `${Math.floor(opts.min_price ?? 0)}-${Math.ceil(opts.max_price ?? 1_000_000_000)}` });
    }
    const data = await graphql<{ searchV3: { products: { items: Card[] } } }>(SEARCH_QUERY, { filters });
    const inRange = (price: number | null | undefined) =>
      typeof price !== "number" || ((opts.min_price === undefined || price >= opts.min_price) && (opts.max_price === undefined || price <= opts.max_price));
    const cards = data.searchV3.products.items.filter(
      (card): card is Card & { productId: number } => typeof card.productId === "number" && inRange(card.lowestNewPrice ?? card.lowestUsedPrice),
    );
    if (cards.length === 0) return [];

    // Main products ahead of accessories: the top-ranked hit's category leads, the rest keep their order.
    const mainCategory = cards[0].categoryName;
    const ranked = [...cards.filter((card) => card.categoryName === mainCategory), ...cards.filter((card) => card.categoryName !== mainCategory)].slice(0, opts.limit);

    const { products } = await graphql<{ products: (GqlProduct | null)[] }>(PRODUCTS_QUERY, { ids: ranked.map((card) => card.productId) });
    const byId = new Map(products.filter((p): p is GqlProduct => p !== null).map((p) => [p.id, p]));
    return ranked.map((card) => toHit(byId.get(card.productId) ?? { id: card.productId, name: card.name ?? "" }, card));
  },

  async product(id: string): Promise<ProductHit> {
    const data = await graphql<{ product: GqlProduct | null }>(PRODUCT_QUERY, { id: productId(id) });
    if (!data.product) throw new SourceError("Not found on Prisjakt", "prisjakt", 404);
    return toHit(data.product);
  },

  parseUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (!/(^|\.)prisjakt\.nu$/i.test(parsed.hostname)) return null;
    // /produkt.php?p=123 and /product.php?p=123 (extra variant params like &a-116257=White are fine).
    if (/^\/(produkt|product)\.php$/i.test(parsed.pathname)) {
      const p = parsed.searchParams.get("p");
      return p && /^\d+$/.test(p) ? p : null;
    }
    // /produkt/123 and /produkt/<slug>-123 redirect to produkt.php?p=123.
    const path = /^\/(?:produkt|product)\/(?:[^/]*-)?(\d+)\/?$/i.exec(parsed.pathname);
    return path ? path[1] : null;
  },
};
