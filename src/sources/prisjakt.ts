// Prisjakt (prisjakt.nu). Search: GraphQL searchV3 (the site's relevance ranking and price filter)
// enriched with product(id) per hit for brand, image, rating and GTIN. Product: GraphQL product, the
// offer list (GET /api/offer-list/{id}) and price history (POST /api/price-history).

import type { Offer, ProductDetail, ProductHit, Rating, SearchOptions, Source } from "../types.js";
import { SourceError } from "../types.js";
import { secondhandCondition } from "./condition.js";
import { priceHistory } from "./prisjakt/history.js";
import { SITE, getJson, graphql } from "./prisjakt/http.js";

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

/** One aliased product(id) field per id: products(ids) answers null for the whole list when one id is gone. */
function productsQuery(ids: number[]): string {
  return `query Products { ${ids.map((id, i) => `p${i}: product(id: ${id}) { ${PRODUCT_FIELDS} }`).join(" ")} }`;
}
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

// ---- REST offer list ----

interface Money {
  amount?: number | null;
  currency?: string | null;
}

interface OfferRow {
  shopId?: number;
  clickoutUrl?: string | null;
  price?: Money | null;
  name?: string | null;
  condition?: string | null;
  stockStatus?: string | null;
  shopUserReviews?: { score?: number | null; numberOfReviewsInScore?: number | null } | null;
  shipping?: { cheapest?: { price?: Money | null; deliveryDays?: { min?: number; max?: number } | null } | null } | null;
  shop?: { name?: string | null } | null;
}

const STOCK: Record<string, { in_stock: boolean | null; text: string }> = {
  InStock: { in_stock: true, text: "I lager" },
  LimitedStock: { in_stock: true, text: "Få i lager" },
  OutOfStock: { in_stock: false, text: "Ej i lager" },
  Backorder: { in_stock: false, text: "Restnoterad" },
  Incoming: { in_stock: false, text: "Inkommande" },
  Preorder: { in_stock: false, text: "Förhandsbokning" },
  PreOrder: { in_stock: false, text: "Förhandsbokning" },
  Unknown: { in_stock: null, text: "Okänd lagerstatus" },
};

const CONDITIONS: Record<string, Offer["condition"]> = { New: "new", Used: "used", Refurbished: "refurbished" };

/**
 * The model-code word of a query ("QE55Q80D" in "Samsung QE55Q80D"): letters and digits mixed, at least
 * five characters, not a size like "128GB". searchV3 finds nothing for some brand + model-code queries
 * that the code alone finds.
 */
function modelCode(query: string): string | null {
  const words = query
    .split(/\s+/)
    .filter((word) => word.length >= 5 && /\p{L}/u.test(word) && /\d/.test(word) && !/^\d+(?:[.,]\d+)?(?:gb|tb|mb|mm|cm|hz|mah|w|tum|")$/i.test(word));
  const longest = words.sort((a, b) => b.length - a.length)[0];
  return longest && longest !== query.trim() ? longest : null;
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
    // searchV3 cards and priceSummary keep new and used apart: regular/lowestNewPrice is new only,
    // alternative/lowestUsedPrice the cheapest used or refurbished offer.
    lowest_price: (card ? card.lowestNewPrice : summary?.regular) ?? null,
    lowest_price_secondhand: (card ? card.lowestUsedPrice : summary?.alternative) ?? null,
    offer_count: card?.storeCount ?? summary?.count ?? null,
    rating: rating(product.userReviewSummary?.rating, product.userReviewSummary?.count),
    gtin: gtins(product),
  };
}

function toOffer(row: OfferRow, productUrl: string): Offer | null {
  const price = row.price?.amount;
  if (typeof price !== "number" || row.price?.currency !== "SEK") return null;
  const cheapest = row.shipping?.cheapest;
  const shipping = typeof cheapest?.price?.amount === "number" ? cheapest.price.amount : null;
  const stock = row.stockStatus ? STOCK[row.stockStatus] : undefined;
  const days = cheapest?.deliveryDays;
  const delivery =
    days && typeof days.min === "number" && typeof days.max === "number"
      ? days.min === days.max
        ? `${days.min} dagar`
        : `${days.min}-${days.max} dagar`
      : null;
  const stockText = [stock?.text, delivery].filter(Boolean).join(", ");
  return {
    source: "prisjakt",
    store: row.shop?.name ?? "",
    store_id: row.shopId === undefined ? null : String(row.shopId),
    price,
    shipping,
    total: shipping === null ? null : price + shipping,
    in_stock: stock?.in_stock ?? null,
    stock_text: stockText || null,
    // Used/Refurbished labels stand; a second-hand title ("Apple Refurbished …", "Grade A") beats New.
    condition: (row.condition === "Used" || row.condition === "Refurbished" ? CONDITIONS[row.condition] : null) ??
      secondhandCondition(row.name, row.shop?.name) ??
      ((row.condition && CONDITIONS[row.condition]) || null),
    store_rating: rating(row.shopUserReviews?.score, row.shopUserReviews?.numberOfReviewsInScore),
    title: row.name || null,
    // The site's own shop link (/go-to-shop/...): handed to the user, never fetched here.
    url: absolute(row.clickoutUrl, productUrl),
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
    const find = async (text: string) => {
      const filters: { key: string; value: string }[] = [{ key: "query", value: text }];
      if (opts.min_price !== undefined || opts.max_price !== undefined) {
        filters.push({ key: "price", value: `${Math.floor(opts.min_price ?? 0)}-${Math.ceil(opts.max_price ?? 1_000_000_000)}` });
      }
      const data = await graphql<{ searchV3?: { products?: { items?: Card[] | null } | null } | null }>(SEARCH_QUERY, { filters });
      return data.searchV3?.products?.items ?? [];
    };
    let items = await find(query);
    const code = items.length === 0 ? modelCode(query) : null;
    if (code) items = await find(code);

    // Price filters apply to the new price; a product with only used offers has none to compare.
    const inRange = (price: number | null | undefined) =>
      (opts.min_price === undefined && opts.max_price === undefined) ||
      (typeof price === "number" && (opts.min_price === undefined || price >= opts.min_price) && (opts.max_price === undefined || price <= opts.max_price));
    const cards = items.filter(
      (card): card is Card & { productId: number } => Number.isSafeInteger(card?.productId) && inRange(card.lowestNewPrice),
    );
    if (cards.length === 0) return [];

    // Main products ahead of accessories: the top-ranked hit's category leads, the rest keep their order.
    const mainCategory = cards[0].categoryName;
    const ranked = [...cards.filter((card) => card.categoryName === mainCategory), ...cards.filter((card) => card.categoryName !== mainCategory)].slice(0, opts.limit);

    // A delisted id comes back null; its hit is then built from the search card alone.
    const products = await graphql<Record<string, GqlProduct | null>>(productsQuery(ranked.map((card) => card.productId)), {}, true);
    return ranked.map((card, i) => toHit(products[`p${i}`] ?? { id: card.productId, name: card.name ?? "" }, card));
  },

  async product(id: string): Promise<ProductDetail> {
    const pid = productId(id);
    const [data, rows, history] = await Promise.all([
      graphql<{ product?: GqlProduct | null }>(PRODUCT_QUERY, { id: pid }),
      getJson(`/api/offer-list/${pid}`) as Promise<(OfferRow | null)[]>,
      // History is extra: without it the offers still answer the question. A refused (429) or failed
      // (5xx) request is tried once more, since compare fires several Prisjakt requests back to back.
      priceHistory(pid)
        .catch(async (error: unknown) => {
          const status = error instanceof SourceError ? error.status : undefined;
          if (status !== 429 && !(status !== undefined && status >= 500)) throw error;
          const pause = Promise.withResolvers<void>();
          setTimeout(pause.resolve, 500);
          await pause.promise;
          return priceHistory(pid);
        })
        .catch(() => null),
    ]);
    if (!data.product) throw new SourceError("Not found on Prisjakt", "prisjakt", 404);
    const hit = toHit(data.product);
    const offers = (Array.isArray(rows) ? rows : [])
      .map((row) => (row ? toOffer(row, hit.url) : null))
      .filter((offer): offer is Offer => offer !== null)
      .sort((a, b) => (a.total ?? a.price) - (b.total ?? b.price) || a.price - b.price);
    const stores = new Set(offers.map((offer) => offer.store_id ?? offer.store)).size;
    return { ...hit, offer_count: stores || hit.offer_count, offers, history };
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
