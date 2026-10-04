// Shared shapes. Sources (src/sources/*) return ProductHit / ProductDetail; tools (src/tools.ts)
// merge them into SearchResult / CompareResult, which are also the widget's structuredContent.
// All prices are SEK including VAT, as plain numbers.

export type SourceId = "prisjakt" | "pricerunner";

export interface Rating {
  score: number;
  count: number;
  scale: 5;
}

export interface ProductHit {
  source: SourceId;
  /** The site's own product id. */
  id: string;
  name: string;
  brand: string | null;
  /** The site's category name, Swedish. */
  category: string | null;
  /** Absolute https URL of a small or medium product image. */
  image: string | null;
  /** Absolute URL of the product page on the comparison site. */
  url: string;
  /** Lowest current price as the site lists it. */
  lowest_price: number | null;
  /** Number of stores with an offer. */
  offer_count: number | null;
  /** User reviews of the product, when listed. */
  rating: Rating | null;
  /** EAN/GTIN codes when the site exposes them, else []. */
  gtin: string[];
}

export interface Offer {
  source: SourceId;
  /** Store display name as the site shows it. */
  store: string;
  store_id: string | null;
  /** Item price. */
  price: number;
  /** Shipping cost when the site reports it. */
  shipping: number | null;
  /** price + shipping when shipping is known, else null. */
  total: number | null;
  in_stock: boolean | null;
  /** The site's stock/delivery text, e.g. "I lager", "1-3 dagar". */
  stock_text: string | null;
  condition: "new" | "used" | "refurbished" | null;
  store_rating: Rating | null;
  /** The store's own listing title when the site shows it (variant details). */
  title: string | null;
  /** Link for the user to click: the site's own shop link if given, else the product page. The server never fetches it. */
  url: string;
}

export interface PricePoint {
  /** YYYY-MM-DD */
  date: string;
  price: number;
}

export interface PriceHistory {
  source: SourceId;
  lowest_30d: number | null;
  lowest_90d: number | null;
  lowest_ever: PricePoint | null;
  /** Daily lowest price, oldest first, at most 60 points (downsampled). */
  points: PricePoint[];
}

export interface ProductDetail extends ProductHit {
  /** Current offers, cheapest first. */
  offers: Offer[];
  /** null when the site has none or doesn't allow fetching it. */
  history: PriceHistory | null;
}

export interface SearchOptions {
  /** 1-20 */
  limit: number;
  min_price?: number;
  max_price?: number;
}

export interface Source {
  id: SourceId;
  /** "Prisjakt" / "PriceRunner" */
  label: string;
  search(query: string, opts: SearchOptions): Promise<ProductHit[]>;
  product(id: string): Promise<ProductDetail>;
  /** Product id from a product page URL on this site, else null. */
  parseUrl(url: string): string | null;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly source: SourceId,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

// ---- Tool results (structuredContent; the widget renders these) ----

export interface SourceListing {
  id: string;
  url: string;
  lowest_price: number | null;
  offer_count: number | null;
}

export type MatchKind = "gtin" | "name" | null;

export interface MergedProduct {
  /** Pass to compare: "prisjakt:123", "pricerunner:456" or "prisjakt:123+pricerunner:456". */
  key: string;
  name: string;
  brand: string | null;
  category: string | null;
  image: string | null;
  rating: Rating | null;
  gtin: string[];
  sources: Partial<Record<SourceId, SourceListing>>;
  /** How the two sites' listings were tied together; null when only one site has it. */
  match: MatchKind;
  cheapest: { price: number; source: SourceId } | null;
}

export interface SourceFailure {
  source: SourceId;
  message: string;
}

export interface SearchResult {
  query: string;
  products: MergedProduct[];
  /** Sites that failed; results from the others are still returned. */
  errors: SourceFailure[];
}

export interface MergedOffer {
  store: string;
  /** Lowest price among the sites listing this store. */
  price: number;
  shipping: number | null;
  total: number | null;
  in_stock: boolean | null;
  stock_text: string | null;
  condition: "new" | "used" | "refurbished" | null;
  store_rating: Rating | null;
  title: string | null;
  url: string;
  /** Sites that list this store's offer, with the price each shows. */
  seen_on: Partial<Record<SourceId, number>>;
}

export interface CompareResult {
  product: MergedProduct;
  /** One row per store and condition, cheapest first (by total when known, else price), sold-out rows last. New only unless include_used. */
  offers: MergedOffer[];
  /** Cheapest new offer (condition "new" or unknown), skipping sold-out rows unless nothing else is listed. */
  cheapest: MergedOffer | null;
  cheapest_in_stock: MergedOffer | null;
  /** Cheapest used or refurbished offer, reported even when include_used is false. */
  cheapest_secondhand: MergedOffer | null;
  history: PriceHistory | null;
  /** One sentence on where today's lowest price sits against the history, when there is one. */
  verdict: string | null;
  errors: SourceFailure[];
}
