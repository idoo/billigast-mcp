// Second-hand detection and lowest prices for the sources. Second-hand listings are told apart by
// the store's own title or by the store being a second-hand marketplace: used where a site gives no
// condition (PriceRunner's UNKNOWN rows, Prisjakt's price-history items) and over a site's NEW label,
// since stores list "Apple Refurbished iPhone …" as new.

import type { Offer } from "../types.js";

const REFURBISHED_WORDS = /(?<![\p{L}\d])(?:refurb\p{L}*|renewed|förnyad|renoverad|rekond\p{L}*)(?![\p{L}\d])/iu;
const USED_WORDS = /(?<![\p{L}\d])(?:begagnad|begagnade|begagnat|beg\.|used|pre-owned|grade [a-d]\+?|klass [a-d])(?![\p{L}\d])/iu;

const REFURBISHED_STORES = /^(?:back ?market|swappie|refurbed)\b/i;
const USED_STORES = /^(?:blocket|tradera|sellpy|vinted|plick)\b/i;

/** "refurbished" or "used" when the title or store says so, else null (nothing marks it second-hand). */
export function secondhandCondition(title: string | null | undefined, store?: string | null): "used" | "refurbished" | null {
  const shop = store?.trim() ?? "";
  if ((title && REFURBISHED_WORDS.test(title)) || REFURBISHED_STORES.test(shop)) return "refurbished";
  if ((title && USED_WORDS.test(title)) || USED_STORES.test(shop)) return "used";
  return null;
}

/**
 * Lowest new and lowest second-hand price of a site's offers. Sold-out offers (in_stock false) carry
 * stale prices, so they count only when every offer of that kind is sold out, as compare's cheapest does.
 */
export function lowestPrices(offers: Offer[]): { fresh: number | null; secondhand: number | null } {
  const lowest = (secondhand: boolean) => {
    const group = offers.filter((offer) => (offer.condition === "used" || offer.condition === "refurbished") === secondhand);
    const available = group.filter((offer) => offer.in_stock !== false);
    return (available.length ? available : group).reduce<number | null>((low, offer) => (low === null || offer.price < low ? offer.price : low), null);
  };
  return { fresh: lowest(false), secondhand: lowest(true) };
}
