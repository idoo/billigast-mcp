// PriceRunner (pricerunner.se) source. Uses the JSON endpoints PriceRunner's own frontend calls:
// search-edge-rest search/v5 and search/category/v4 for listings (plus each hit's offer list for a
// new-only price), product-detail-edge-rest initial + offers for one product. Price history is never
// fetched (robots.txt disallows it).

import type { Offer, ProductDetail, ProductHit, Rating, SearchOptions, Source } from "../types.js";
import { SourceError } from "../types.js";
import { lowestPrices, secondhandCondition } from "./condition.js";
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
/** Most offer lists fetched for one search, to keep a search within a few dozen requests. */
const MAX_PRICED_HITS = 20;

/** /pl/ is the price list; /pi/ (product info) and /pr/ (reviews) are tabs of the same product. */
const PRODUCT_PATH = /^\/p[lir]\/(\d+)-(\d+)(?:\/|$)/;

function offersPath(id: string, conditions: string): string {
  return `/se/api/product-detail-edge-rest/public/product-detail/v0/offers/${COUNTRY}/${id}?${OFFER_FILTERS}&af_ITEM_CONDITION=${conditions}`;
}

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

interface ConditionPrices {
  fresh: number | null;
  secondhand: number | null;
}

function toHit(product: ApiListProduct, categoryName: string | null, prices: ConditionPrices): ProductHit {
  return {
    source: "pricerunner",
    id: product.id,
    name: product.name,
    brand: product.brand?.name || null,
    category: product.category?.name ?? categoryName,
    image: imageUrl(product.image),
    url: SITE + product.url,
    lowest_price: prices.fresh,
    lowest_price_secondhand: prices.secondhand,
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

/**
 * Listing prices can't tell new from second-hand: lowestPrice includes UNKNOWN-condition offers (a
 * Blocket ad, "BEGAGNAD" rows) and is then labelled NEW. So each hit's NEW offer list is fetched: its
 * offers give the new price (titles checked, sold-out rows only as a last resort), and its
 * af_ITEM_CONDITION facet the lowest USED/REFURBISHED price (it covers every condition whatever is
 * selected). UNKNOWN offers count as neither: they would need their own request.
 */
async function conditionPrices(product: ApiListProduct): Promise<ConditionPrices> {
  const listed = money(product.lowestPrice);
  const listedSecondhand = product.condition === "USED" || product.condition === "REFURBISHED" ? listed : null;
  const response = await getJson<ApiOffers>(offersPath(productId(product.id), "NEW")).catch(() => null);
  const options = response?.filters?.find((filter) => filter.id === "af_ITEM_CONDITION")?.filterOptions;
  // Without the offer list the site can't tell, so no new price rather than a possibly second-hand one.
  if (!response || !options) return { fresh: null, secondhand: listedSecondhand };
  const offers = (response.offers ?? [])
    .map((offer) => toOffer(offer, response.merchants?.[offer.merchantId], "new", SITE + product.url))
    .filter((offer): offer is Offer => offer !== null);
  const fromOffers = lowestPrices(offers);
  const secondhand = [fromOffers.secondhand, ...options.filter((option) => option.id === "USED" || option.id === "REFURBISHED").map((option) => money(option.lowestPrice))]
    .filter((price): price is number => price !== null);
  return { fresh: fromOffers.fresh, secondhand: secondhand.length ? Math.min(...secondhand) : null };
}

async function search(query: string, opts: SearchOptions): Promise<ProductHit[]> {
  const q = encodeURIComponent(query.trim());
  const found = await getJson<ApiSearch>(`/se/api/search-edge-rest/public/search/v5/${COUNTRY}?q=${q}`);
  // SEMANTIC means no product matched the words; v5 then answers with unrelated popular products.
  if (!found || found.source === "SEMANTIC") return [];
  // A listing price is at most the new price (it may be a cheaper second-hand one), so it can rule out
  // products above max_price but not below min_price; min_price is checked on the new price below.
  const underMax = (product: ApiListProduct) => {
    const price = money(product.lowestPrice);
    return opts.max_price === undefined || (price !== null && price <= opts.max_price);
  };
  const candidates: { product: ApiListProduct; categoryName: string | null }[] = [];
  const seen = new Set<string>();
  const add = (product: ApiListProduct, categoryName: string | null) => {
    if (typeof product?.id !== "string" || seen.has(product.id) || !underMax(product)) return;
    seen.add(product.id);
    candidates.push({ product, categoryName });
  };

  // search/v5 ignores sort/size/filter params and ranks by text match, so accessories often beat the
  // product itself. Its category facet names the best category; category/v4 in that category with the
  // query returns 48 matches, price-filterable. Merge both and order by PriceRunner's popularity rank.
  // Without a category facet (fuzzy matches) v5's own order is the relevance order: popularity rank
  // would put any best-seller ahead of the product asked for.
  const topCategory = found.categories?.[0];
  const categoryId = topCategory?.id?.replace(/^cl/, "");
  if (categoryId && /^\d+$/.test(categoryId)) {
    let path = `/se/api/search-edge-rest/public/search/category/v4/${COUNTRY}/${categoryId}?size=${CATEGORY_PAGE}&q=${q}`;
    // af_PRICE=_<to> (the server rounds, so underMax() re-checks); no lower bound, see underMax().
    if (opts.max_price !== undefined) path += `&af_PRICE=_${Math.ceil(opts.max_price)}`;
    const listed = await getJson<ApiCategoryList>(path);
    for (const product of listed?.products ?? []) add(product, listed?.category?.name ?? topCategory?.name ?? null);
    for (const product of found.products ?? []) add(product, null);
    const rank = (product: ApiListProduct) => product.rank?.rank ?? Number.POSITIVE_INFINITY;
    candidates.sort((a, b) => rank(a.product) - rank(b.product));
  } else {
    for (const product of found.products ?? []) add(product, null);
  }

  // min_price can drop priced hits, so price a few more to still fill the page.
  const priced = candidates.slice(0, Math.min(MAX_PRICED_HITS, opts.min_price === undefined ? opts.limit : opts.limit * 2));
  const prices = await Promise.all(priced.map((entry) => conditionPrices(entry.product)));
  return priced
    .map((entry, i) => toHit(entry.product, entry.categoryName, prices[i]))
    .filter((hit) => inRange(hit.lowest_price, opts))
    .slice(0, opts.limit);
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

/**
 * `unlabeled`: condition of offers without an itemCondition label (NEW and UNKNOWN offers both lack one).
 * A second-hand title or marketplace store overrides NEW and unlabeled: stores list "Apple Refurbished
 * iPhone 15" as NEW, and UNKNOWN rows include Blocket ads.
 */
function toOffer(offer: ApiOffer, merchant: ApiMerchant | undefined, unlabeled: Offer["condition"], productUrl: string): Offer | null {
  const price = money(offer.price);
  if (price === null) return null;
  const rawShipping = money(offer.shippingCost);
  const shipping = rawShipping !== null && rawShipping < MAX_SANE_SHIPPING ? rawShipping : null;
  const label = offer.labels?.attributeLabels?.find((l) => l.filterId === "af_ITEM_CONDITION")?.value;
  const condition =
    label === "USED"
      ? "used"
      : label === "REFURBISHED"
        ? "refurbished"
        : secondhandCondition(offer.name, merchant?.name) ?? (label === "NEW" ? "new" : unlabeled);
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
  // New offers carry no condition label and neither do UNKNOWN ones, so new offers come in their own request.
  const [initial, fresh, other] = await Promise.all([
    getJson<ApiProductInitial>(`/se/api/product-detail-edge-rest/public/product-detail/v0/initial/${COUNTRY}/${category}/${bare}?languageCode=sv`),
    getJson<ApiOffers>(offersPath(bare, "NEW")),
    getJson<ApiOffers>(offersPath(bare, "USED,REFURBISHED,UNKNOWN")),
  ]);
  if (!initial?.product) throw new SourceError(`PriceRunner has no product ${bare}`, "pricerunner", 404);

  const url = SITE + initial.product.path;
  const listed = (response: ApiOffers | null, unlabeled: Offer["condition"]) =>
    (response?.offers ?? [])
      .map((offer) => toOffer(offer, response?.merchants?.[offer.merchantId], unlabeled, url))
      .filter((offer): offer is Offer => offer !== null);
  const list = [...listed(fresh, "new"), ...listed(other, null)].sort(
    (a, b) => (a.total ?? a.price) - (b.total ?? b.price) || a.price - b.price,
  );
  const { fresh: lowestNew, secondhand: lowestSecondhand } = lowestPrices(list);

  const stores = new Set(list.map((offer) => offer.store_id));
  return {
    source: "pricerunner",
    id: initial.product.id,
    name: initial.product.name,
    brand: initial.brand?.name || null,
    category: initial.category?.name ?? null,
    image: imageUrl(fresh?.images?.[0] ?? other?.images?.[0]),
    url,
    lowest_price: lowestNew,
    lowest_price_secondhand: lowestSecondhand,
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
