// HTTP access to pricerunner.se's own JSON endpoints (the ones its web frontend calls), plus the
// response shapes this server reads. Never call /gotostore/ or any pricehistory path (robots.txt).

import { SourceError } from "../../types.js";

export const SITE = "https://www.pricerunner.se";
/** PriceRunner's image CDN; product image paths are /product/<id>/<slug>.jpg and need a size segment. */
export const IMAGE_HOST = "https://owp.klarna.com";

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  "accept-language": "sv-SE,sv;q=0.9",
  accept: "application/json",
};

/** GET a /se/api/... path. Returns null on 204/404 (PriceRunner answers 204 for an unknown product id). */
export async function getJson<T>(path: string): Promise<T | null> {
  const label = path.split("?")[0];
  let response: Response;
  try {
    response = await fetch(SITE + path, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new SourceError(`PriceRunner did not answer: ${error instanceof Error ? error.message : String(error)}`, "pricerunner");
  }
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new SourceError(`PriceRunner answered HTTP ${response.status} for ${label}`, "pricerunner", response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new SourceError(`PriceRunner returned invalid JSON for ${label}`, "pricerunner", response.status);
  }
}

export interface Money {
  amount: string;
  currency: string;
}

export interface ApiImage {
  id: string | null;
  path: string | null;
  url: string | null;
}

/** A product in search/v5 and search/category/v4 listings. */
export interface ApiListProduct {
  id: string;
  name: string;
  /** /pl/<categoryId>-<productId>/<Category>/<slug>-priser */
  url: string;
  image: ApiImage | null;
  lowestPrice: Money | null;
  /** search/v5 only; category/v4 lists one category, named in the response. */
  category?: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  rating: { numberOfRatings: number; averageRating: string } | null;
  /** Popularity rank across PriceRunner; lower is more popular. */
  rank: { rank: number } | null;
  previewMerchants: { count: number } | null;
}

export interface ApiSearch {
  products: ApiListProduct[];
  /** Facet of matching categories, most relevant first; ids look like "cl94". */
  categories: { id: string; name: string }[];
}

export interface ApiCategoryList {
  products: ApiListProduct[];
  category: { id: string; name: string } | null;
}

export interface ApiProductInitial {
  product: { id: string; name: string; path: string } | null;
  brand: { name: string } | null;
  category: { id: string; name: string } | null;
  reviewSummary: { average: number; count: number } | null;
}

export type StockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "BACKORDER" | "PREORDER" | "SPECIAL_ORDER" | "COLLECT_IN_STORE" | "UNKNOWN";

export interface ApiOffer {
  id: string;
  /** clk.klarna.com/se/gotostore/... click link; handed to the user, never fetched. */
  url: string | null;
  /** The store's own listing title. */
  name: string | null;
  stockStatus: StockStatus | string | null;
  /** AVAILABLE, UNAVAILABLE (store doesn't cooperate with PriceRunner), TEMPORARILY_UNAVAILABLE, UNAVAILABLE_ON_REQUEST, ... */
  availability: string | null;
  deliveryTime: { minDays: number | null; maxDays: number | null } | null;
  shippingCost: Money | null;
  price: Money | null;
  merchantId: string;
  labels: { attributeLabels: { filterId: string; value: string }[] } | null;
}

export interface ApiMerchant {
  id: string;
  name: string;
  rating: { count: number; average: string } | null;
}

export interface ApiOffers {
  offers: ApiOffer[];
  merchants: Record<string, ApiMerchant>;
  images: ApiImage[];
  filters: { id: string; filterOptions: { id: string; count: number }[] }[];
}
