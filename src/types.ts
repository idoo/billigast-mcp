// Shared shapes. Sources (src/sources/*) return ProductHit.
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
  product(id: string): Promise<ProductHit>;
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
