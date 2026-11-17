import { extraVariants } from "./merge.js";
import type { MergedProduct } from "./types.js";

/** A listing this few stores sell may be an import or a regional model code. */
const FEW_STORES = 3;
/** A sibling replaces it only when at least this many stores sell the sibling, and this many times more. */
const MANY_STORES = 6;
const MANY_TIMES = 3;
/** A model code: letters and digits together, long enough that "s25" or "v15" is not one. */
const CODE = /^(?=.*\p{L})(?=.*\d)[\p{L}\d]{5,}$/u;

/** Lowercased words without accents; "+" stays part of a word, so "S25+" is not "S25". */
const words = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}+]+/u)
    .filter(Boolean);

/** Stores selling the product: the larger of the two sites' counts, since mostly the same stores are on both. */
function stores(product: MergedProduct): number | null {
  const counts = Object.values(product.sources).flatMap((listing) => (listing.offer_count === null ? [] : [listing.offer_count]));
  return counts.length ? Math.max(...counts) : null;
}

/**
 * The product a plain name given to compare means, among search's merged rows (site order).
 *
 * Site order is the base: both sites rank by what people look at, which puts a console above the
 * accessories and games that carry its name and that more stores sell, so store counts never reorder
 * unrelated rows. Three corrections:
 * - Both sites rank the best-selling model of a line first, often a variant ("Galaxy S25" → S25 Ultra,
 *   "iPhone 16 Pro" → 16 Pro Max). A row with variant words the name lacks (extraVariants) loses to the
 *   first row without any, whatever their positions: the name states the model, the rank only its
 *   popularity. That row must be in the same category as the top row, since the plain row under
 *   "Roborock S8 MaxV Ultra" can be dust bags that list S8 among the models they fit.
 * - A variant glued to the model number is one word ("Pixel 9a", "iPhone 16e", "Galaxy S25+"), which
 *   extraVariants doesn't split. A row carrying a number of the name only as the start of a longer word
 *   loses to the first row of the same category carrying it as a word of its own; with no such row the
 *   pick stays.
 * - Both sites list each regional model code as its own product ("LG OLED55C5" → OLED55C5PUA, the US
 *   model two stores import, above the Nordic OLED55C54LA). When the chosen row extends a model code of
 *   the name and at most FEW_STORES stores sell it, the row extending the same code that the most stores
 *   sell takes its place, if that is at least MANY_STORES and MANY_TIMES as many: 2 against 3 stores says
 *   nothing, 2 against 20 says which code is sold here. Limited to rows extending the name's own code and
 *   in the same category, so it cannot move the pick to another product.
 */
export function pickForName(query: string, products: MergedProduct[]): MergedProduct | undefined {
  const top = products[0];
  if (!top) return undefined;
  const plain = products.find(
    (product) => extraVariants(query, product.name, product.brand).length === 0 && (product === top || product.category === top.category),
  );
  const pool = plain ? products.filter((product) => extraVariants(query, product.name, product.brand).length === 0) : products;
  const numbers = words(query).filter((word) => /\d/.test(word) && !CODE.test(word));
  const exact = (product: MergedProduct) => {
    const named = words(product.name);
    return numbers.every((number) => named.includes(number));
  };
  const glued = (product: MergedProduct) => {
    const named = words(product.name);
    return numbers.some((number) => !named.includes(number) && named.some((word) => word.startsWith(number)));
  };
  const chosen = plain ?? top;
  const first = glued(chosen) ? (pool.find((product) => product.category === chosen.category && exact(product)) ?? chosen) : chosen;

  const sold = stores(first);
  const codes = words(query).filter((word) => CODE.test(word));
  if (sold === null || sold > FEW_STORES || codes.length === 0) return first;
  /** The name's model codes that a longer word of the listing's name starts with. */
  const extended = (product: MergedProduct) => {
    const named = words(product.name);
    return codes.filter((code) => named.some((word) => word.length > code.length && word.startsWith(code)));
  };
  const own = extended(first);
  if (own.length === 0) return first;

  let best = first;
  let bestSold = sold;
  for (const product of pool) {
    const count = stores(product);
    if (count === null || count <= bestSold || product.category !== first.category) continue;
    if (!own.every((code) => extended(product).includes(code))) continue;
    best = product;
    bestSold = count;
  }
  return bestSold >= MANY_STORES && bestSold >= sold * MANY_TIMES ? best : first;
}
