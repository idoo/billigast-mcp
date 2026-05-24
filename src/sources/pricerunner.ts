// PriceRunner (pricerunner.se) source. Uses the JSON endpoints PriceRunner's own frontend calls:
// search-edge-rest search/v5 and search/category/v4 for listings, product-detail-edge-rest
// initial + offers for one product. Price history is never fetched (robots.txt disallows it).

import type { Offer, ProductDetail, ProductHit, Rating, SearchOptions, Source } from "../types.js";
import { SourceError } from "../types.js";
import {
  type ApiCategoryList,
  type ApiImage,
  type ApiListProduct,
  type ApiMerchant,
  type ApiOffer,
  type ApiOffers,
  type ApiProductInitial,
  type ApiSearch,
  type Money,
  getJson,
  IMAGE_HOST,
  SITE,
} from "./pricerunner/api.js";

const COUNTRY = "SE";
/** category/v4 page size the site itself uses. */
const CATEGORY_PAGE = 48;
/** Shipping above this is a placeholder PriceRunner sends for stores it can't price (seen: 99013032). */
const MAX_SANE_SHIPPING = 100_000;
/**
 * The site's default offer list: Swedish stores, every stock status except OUT_OF_STOCK (sold-out rows
 * carry stale prices). Every availability is kept: TEMPORARILY_UNAVAILABLE offers are listed on the site too.
 */
const OFFER_FILTERS =
  "af_ORIGIN=NATIONAL&af_STOCK_STATUS=IN_STOCK,BACKORDER,PREORDER,SPECIAL_ORDER,COLLECT_IN_STORE,UNKNOWN" +
  "&sortByPreset=PRICE_WITH_SHIPPING&languageCode=sv";

const PRODUCT_PATH = /^\/pl\/(\d+)-(\d+)(?:\/|$)/;

function money(value: Money | null | undefined): number | null {
  if (!value || value.currency !== "SEK") return null;
  const amount = Number(value.amount);
  return Number.isFinite(amount) ? amount : null;
}

function imageUrl(image: ApiImage | null | undefined): string | null {
  if (image?.url) return image.url.startsWith("//") ? `https:${image.url}` : image.url;
  const match = image?.path?.match(/^\/product\/(.+)$/);
  return match ? `${IMAGE_HOST}/product/256x256/${match[1]}` : null;
}

function rating(score: number | string | null | undefined, count: number | null | undefined): Rating | null {
  const value = Number(score);
  if (!count || !Number.isFinite(value) || value <= 0) return null;
  return { score: value, count, scale: 5 };
}

/** Bare product id from "3208342676" or "94-3208342676". */
function productId(id: string): string {
  const match = id.trim().match(/^(?:\d+-)?(\d+)$/);
  if (!match) throw new SourceError(`Not a PriceRunner product id: ${id}`, "pricerunner", 400);
  return match[1];
}

function toHit(product: ApiListProduct, categoryName: string | null): ProductHit {
  return {
    source: "pricerunner",
    id: product.id,
    name: product.name,
    brand: product.brand?.name || null,
    category: product.category?.name ?? categoryName,
    image: imageUrl(product.image),
    url: SITE + product.url,
    lowest_price: money(product.lowestPrice),
    offer_count: product.previewMerchants?.count ?? null,
    rating: rating(product.rating?.averageRating, product.rating?.numberOfRatings),
    gtin: [],
  };
}

function inRange(price: number | null, opts: SearchOptions): boolean {
  if (opts.min_price === undefined && opts.max_price === undefined) return true;
  if (price === null) return false;
  return (opts.min_price === undefined || price >= opts.min_price) && (opts.max_price === undefined || price <= opts.max_price);
}

async function search(query: string, opts: SearchOptions): Promise<ProductHit[]> {
  const q = encodeURIComponent(query.trim());
  // search/v5 ignores sort/size/filter params and ranks by text match, so accessories often beat the
  // product itself. Its category facet names the best category; category/v4 in that category with the
  // query returns 48 matches, price-filterable. Merge both and order by PriceRunner's popularity rank.
  const found = await getJson<ApiSearch>(`/se/api/search-edge-rest/public/search/v5/${COUNTRY}?q=${q}`);
  if (!found) return [];
  const hits = new Map<string, { hit: ProductHit; rank: number }>();
  const add = (product: ApiListProduct, categoryName: string | null) => {
    if (hits.has(product.id)) return;
    const hit = toHit(product, categoryName);
    if (inRange(hit.lowest_price, opts)) hits.set(product.id, { hit, rank: product.rank?.rank ?? Number.POSITIVE_INFINITY });
  };

  const categoryId = found.categories[0]?.id.replace(/^cl/, "");
  if (categoryId && /^\d+$/.test(categoryId)) {
    let path = `/se/api/search-edge-rest/public/search/category/v4/${COUNTRY}/${categoryId}?size=${CATEGORY_PAGE}&q=${q}`;
    if (opts.min_price !== undefined || opts.max_price !== undefined) {
      // af_PRICE=<from>_<to>, either side may be empty; the server rounds, so inRange() re-checks.
      path += `&af_PRICE=${opts.min_price !== undefined ? Math.floor(opts.min_price) : ""}_${opts.max_price !== undefined ? Math.ceil(opts.max_price) : ""}`;
    }
    const listed = await getJson<ApiCategoryList>(path);
    for (const product of listed?.products ?? []) add(product, listed?.category?.name ?? found.categories[0].name);
  }
  for (const product of found.products) add(product, null);

  return [...hits.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, opts.limit)
    .map((entry) => entry.hit);
}

const STOCK_TEXT: Record<string, string> = {
  IN_STOCK: "I lager",
  OUT_OF_STOCK: "Ej i lager",
  BACKORDER: "Restnoterad",
  PREORDER: "Förhandsbokning",
  SPECIAL_ORDER: "Beställningsvara",
  COLLECT_IN_STORE: "Hämtas i butik",
};

function stockText(offer: ApiOffer): string | null {
  const parts: string[] = [];
  const status = offer.stockStatus ? STOCK_TEXT[offer.stockStatus] : undefined;
  if (status) parts.push(status);
  const min = offer.deliveryTime?.minDays;
  const max = offer.deliveryTime?.maxDays ?? min;
  if (min != null && max != null) {
    const days = min === max ? `${min}` : `${min}–${max}`;
    parts.push(`leverans ${days} ${max === 1 ? "dag" : "dagar"}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function inStock(status: string | null): boolean | null {
  if (status === "IN_STOCK") return true;
  if (status === "OUT_OF_STOCK" || status === "BACKORDER" || status === "PREORDER" || status === "SPECIAL_ORDER") return false;
  return null;
}

/** `unlabeled`: condition of offers without an itemCondition label (NEW and UNKNOWN offers both lack one). */
function toOffer(offer: ApiOffer, merchant: ApiMerchant | undefined, unlabeled: Offer["condition"], productUrl: string): Offer | null {
  const price = money(offer.price);
  if (price === null) return null;
  const rawShipping = money(offer.shippingCost);
  const shipping = rawShipping !== null && rawShipping < MAX_SANE_SHIPPING ? rawShipping : null;
  const label = offer.labels?.attributeLabels.find((l) => l.filterId === "af_ITEM_CONDITION")?.value;
  const condition = label === "NEW" ? "new" : label === "USED" ? "used" : label === "REFURBISHED" ? "refurbished" : unlabeled;
  return {
    source: "pricerunner",
    store: merchant?.name || `Butik ${offer.merchantId}`,
    store_id: offer.merchantId,
    price,
    shipping,
    total: shipping === null ? null : Math.round((price + shipping) * 100) / 100,
    in_stock: inStock(offer.stockStatus),
    stock_text: stockText(offer),
    condition,
    store_rating: rating(merchant?.rating?.average, merchant?.rating?.count),
    title: offer.name || null,
    // Only AVAILABLE offers get a shop link on the site; TEMPORARILY_UNAVAILABLE, UNAVAILABLE (store not
    // cooperating with PriceRunner) and the rest show "Ingen direktlänk till produkten".
    url: offer.availability === "AVAILABLE" && offer.url ? offer.url : productUrl,
  };
}

async function product(id: string): Promise<ProductDetail> {
  const bare = productId(id);
  // The category segment of the initial endpoint is ignored by the server (any number answers the same).
  const category = id.includes("-") ? id.split("-")[0] : "0";
  const offersPath = `/se/api/product-detail-edge-rest/public/product-detail/v0/offers/${COUNTRY}/${bare}?${OFFER_FILTERS}&af_ITEM_CONDITION=`;
  // New offers carry no condition label and neither do UNKNOWN ones, so new offers come in their own request.
  const [initial, fresh, other] = await Promise.all([
    getJson<ApiProductInitial>(`/se/api/product-detail-edge-rest/public/product-detail/v0/initial/${COUNTRY}/${category}/${bare}?languageCode=sv`),
    getJson<ApiOffers>(offersPath + "NEW"),
    getJson<ApiOffers>(offersPath + "USED,REFURBISHED,UNKNOWN"),
  ]);
  if (!initial?.product) throw new SourceError(`PriceRunner has no product ${bare}`, "pricerunner", 404);

  const url = SITE + initial.product.path;
  const listed = (response: ApiOffers | null, unlabeled: Offer["condition"]) =>
    (response?.offers ?? [])
      .map((offer) => toOffer(offer, response?.merchants[offer.merchantId], unlabeled, url))
      .filter((offer): offer is Offer => offer !== null);
  const list = [...listed(fresh, "new"), ...listed(other, null)].sort(
    (a, b) => (a.total ?? a.price) - (b.total ?? b.price) || a.price - b.price,
  );
  // Lowest price means the cheapest new (or unknown-condition) offer, as in search results and on
  // Prisjakt; only when every offer is used/refurbished does it fall back to the cheapest of those.
  const newOffers = list.filter((offer) => offer.condition === "new" || offer.condition === null);

  const stores = new Set(list.map((offer) => offer.store_id));
  return {
    source: "pricerunner",
    id: initial.product.id,
    name: initial.product.name,
    brand: initial.brand?.name || null,
    category: initial.category?.name ?? null,
    image: imageUrl(fresh?.images[0] ?? other?.images[0]),
    url,
    lowest_price: (newOffers.length ? newOffers : list).reduce<number | null>((low, offer) => (low === null || offer.price < low ? offer.price : low), null),
    offer_count: stores.size,
    rating: rating(initial.reviewSummary?.average, initial.reviewSummary?.count),
    gtin: [],
    offers: list,
    history: null,
  };
}

function parseUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^(?:www\.|m\.)?pricerunner\.se$/i.test(parsed.hostname)) return null;
  return parsed.pathname.match(PRODUCT_PATH)?.[2] ?? null;
}

export const pricerunner: Source = {
  id: "pricerunner",
  label: "PriceRunner",
  search,
  product,
  parseUrl,
};
