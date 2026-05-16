// Shared shapes. Sources (src/sources/*) return ProductHit / ProductDetail.
// All prices are SEK including VAT, as plain numbers.

export type SourceId = "prisjakt";

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
  /** "Prisjakt" */
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
