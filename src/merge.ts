// Cross-site merging: ties a Prisjakt listing to its PriceRunner counterpart (matchProducts), merges
// search lists (mergeHits) and store offers (mergeOffers), and builds the keys compare takes.

import type { MatchKind, MergedOffer, MergedProduct, Offer, PriceHistory, ProductHit, SourceId, SourceListing } from "./types.js";

export const SOURCE_IDS: readonly SourceId[] = ["prisjakt", "pricerunner"];

// ---- Name analysis ----

/** Words that carry no identity: connectors, product-type nouns, marketing filler. */
const FILLER = new Set(
  (
    "with med och and for till the of a an en ett i in inkl incl new ny nya " +
    "generation gen edition utgava version model modell series serie " +
    "tradlosa tradlos tradlost wireless horlurar headphones earphones earbuds inear overear onear aroundear around ear " +
    "smartphone mobiltelefon telefon mobil phone tv smart led uhd hd ssd ram dual sim esim " +
    "sladdlos cordless skaftdammsugare dammsugare stickvacuum vacuum konsol console spelkonsol laptop notebook barbar dator " +
    "bluetooth hogtalare speaker " +
    "oc cpu gpu core ai standard disc chassis echassis chip unified memory storage"
  ).split(" "),
);

/** Words that tell product variants apart: both names must carry the same set. */
const VARIANT = new Set(
  "pro max plus ultra mini lite slim digital fe se xl fold flip oled qled usbc lightning anc wifi cellular lte air neo edge bundle".split(" "),
);

/** Accessory stems, matched inside compound words too (silikonfodral, ersättningskuddar). */
const ACCESSORY_STEMS = [
  "fodral", "etui", "skal", "kudd", "skydd", "laddare", "charger", "kabel", "cable", "adapter", "stativ", "hallare",
  "holder", "propp", "batteri", "battery", "filter", "ersattning", "utbytes", "replacement", "protector", "earpad",
  "cushion", "headband", "sleeve", "strap", "armband", "vaska", "remote", "fjarrkontroll", "grepp", "grip", "mount",
  "hook", "karbinhake", "drive", "dock",
];
const ACCESSORY_WORDS = new Set(["case", "cases", "cover", "glas", "glass", "tips", "stand", "bag", "kit", "lock", "horlur", "vanster", "hoger", "left", "right", "charm"]);

/** Colours, Swedish folded to English, so "Vit" and "White" agree. */
const COLOUR: Record<string, string> = {
  svart: "black", vit: "white", gra: "grey", gray: "grey", rod: "red", bla: "blue", gron: "green", rosa: "pink",
  lila: "purple", gul: "yellow", guld: "gold", brun: "brown", silver: "silver", black: "black", white: "white",
  grey: "grey", red: "red", blue: "blue", green: "green", pink: "pink", purple: "purple", yellow: "yellow", gold: "gold",
  brown: "brown", orange: "orange", beige: "beige", midnight: "midnight", starlight: "starlight", graphite: "graphite",
  titanium: "titanium", obsidian: "obsidian", porcelain: "porcelain", hazel: "hazel", rose: "rose", teal: "teal",
  ultramarine: "ultramarine", onyx: "onyx", cobalt: "cobalt", violet: "violet", lavender: "lavender", mint: "mint",
  cream: "cream", sand: "sand", navy: "navy", desert: "desert", natural: "natural", space: "space", spacegrey: "space",
  spacegray: "space", taupe: "taupe", coral: "coral", jade: "jade", amber: "amber", sage: "sage", mocha: "mocha",
  neon: "neon", marble: "marble", iceblue: "iceblue", sky: "sky", himmelblau: "sky", skyblue: "sky",
};

const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:gb|tb|mb|in|mah|w|hz|mm|cm|l|kg)$/;
const CAPACITY_TOKEN = /^(\d+(?:\.\d+)?)(gb|tb)$/;
const YEAR_TOKEN = /^(?:19|20)\d\d$/;
const CODE_TOKEN = /^[a-z]+\d[a-z0-9]*$/;
/** Accessory-looking category names (Swedish): "Tillbehör för hörlurar", "Skärmskydd", "Datorväskor". */
const ACCESSORY_CATEGORY = /tillbehor|skydd|skal|fodral|vask|kabel|laddare/;

interface Features {
  /** Digit-bearing tokens that must agree exactly: model numbers, sizes, generations. */
  hard: Set<string>;
  /** Storage and memory in GB ("8GB RAM 128GB" -> 8, 128). */
  capacity: Set<number>;
  /** Digit-bearing tokens compared only when both names have one of the kind (one site often leaves them out). */
  soft: Record<"year" | "cores" | "net" | "res" | "code", Set<string>>;
  variant: Set<string>;
  accessory: Set<string>;
  colour: Set<string>;
  words: Set<string>;
}

function fold(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ø/g, "o").replace(/æ/g, "ae");
}

function brandTokens(brand: string | null): string[] {
  return brand ? fold(brand).split(/[^a-z0-9]+/).filter(Boolean) : [];
}

function normalize(name: string): string {
  let s = ` ${fold(name)} `;
  s = s.replace(/(\d),(\d)/g, "$1.$2");
  // A store's bundled charging case is part of the product ("med MagSafe laddningsfodral", "with MagSafe Charging Case").
  if (/\b(?:med|with)\b.*(?:laddnings(?:fodral|etui)|charging case)/.test(s)) s = s.replace(/laddnings(?:fodral|etui)|charging case/g, " ");
  s = s
    .replace(/\bultra hd\b/g, " uhd ")
    .replace(/\be[\s-]*chassis\b/g, " echassis ")
    .replace(/\b(?:aktiv brusreducering|brusreducerande|active noise cancell?ation|noise cancell?ing)\b/g, " anc ")
    .replace(/\busb[\s-]*(?:typ(?:e)?[\s-]*)?c\b/g, " usbc ")
    .replace(/\bplay\s*station\s*(\d)\b/g, " ps$1 ")
    .replace(/\bps\s+(\d)\b/g, " ps$1 ")
    .replace(/\bspace\s+(gr[ae]y)\b/g, " spacegrey ")
    .replace(/([a-z0-9])\+/g, "$1 plus ")
    // Sizes to whole inches as bare numbers: sites write 13.6", 13-inch, 13.6 and 13 for the same MacBook and
    // 55" or 55 for a TV. Same for a bare two-digit decimal not followed by a unit (15.3 M4).
    .replace(/(\d+(?:\.\d+)?)\s*-?\s*(?:"|''|”|″|tum(?:s)?\b|inch(?:es)?\b|in\b)/g, (_, size: string) => ` ${Math.floor(Number(size))} `)
    .replace(/\b(\d{2})\.\d\b(?!\s*(?:gb|tb|ghz|mhz|hz|mm|cm|kg|w|mah|l)\b)/g, " $1 ")
    // Core counts: "10-core CPU" and "10C" agree.
    .replace(/\b(\d+)\s*-?\s*cores?\b/g, " $1c ")
    // Generations: 2nd generation, 2. gen, 4:e generationen, (2nd Gen), gen 2.
    .replace(/\b(\d+)\s*(?:st|nd|rd|th|:a|:e|\.)?\s*(?:gen\.?|generation(?:en)?)(?=\W)/g, " $1 ")
    .replace(/\bgen(?:eration)?\.?\s*(\d+)\b/g, " $1 ")
    // Capacities and units glued to the number: 128 GB -> 128gb.
    .replace(/\b(\d+(?:\.\d+)?)\s+(gb|tb|mb|mah|w|hz|mm|cm|kg)\b/g, " $1$2 ")
    // Hyphenated model codes and words: WH-1000XM5, Wi-Fi, in-ear.
    .replace(/([a-z0-9])-(?=[a-z0-9])/g, "$1");
  return s;
}

/**
 * Whether a listing's name contains any word of the query (folded the same way as for matching).
 * PriceRunner answers a query it can't match with unrelated popular products; this drops them.
 */
export function mentionsQuery(query: string, name: string): boolean {
  const haystack = normalize(name).replace(/[^a-z0-9.]+/g, " ");
  return normalize(query)
    .split(/[^a-z0-9.]+/)
    .filter((word) => word.length > 1 || /\d/.test(word))
    .some((word) => haystack.includes(word));
}

function features(hit: ProductHit): Features {
  const tokens = normalize(hit.name)
    .split(/[^a-z0-9.]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  const brand = new Set(brandTokens(hit.brand));
  const f: Features = {
    hard: new Set(),
    capacity: new Set(),
    soft: { year: new Set(), cores: new Set(), net: new Set(), res: new Set(), code: new Set() },
    variant: new Set(),
    accessory: new Set(),
    colour: new Set(),
    words: new Set(),
  };
  for (const token of tokens) {
    if (/\d/.test(token)) {
      const capacity = CAPACITY_TOKEN.exec(token);
      if (capacity) f.capacity.add(Number(capacity[1]) * (capacity[2] === "tb" ? 1000 : 1));
      else if (YEAR_TOKEN.test(token)) f.soft.year.add(token);
      else if (/^\d+c$/.test(token)) f.soft.cores.add(token);
      else if (/^[2-5]g$/.test(token)) f.soft.net.add(token);
      else if (/^[248]k$/.test(token)) f.soft.res.add(token);
      else if (!UNIT_TOKEN.test(token) && CODE_TOKEN.test(token) && token.length >= 5) f.soft.code.add(token);
      else f.hard.add(token);
      continue;
    }
    if (brand.has(token) || FILLER.has(token)) continue;
    // Single letters name variants: Xbox Series X vs S.
    if (VARIANT.has(token) || token.length === 1) f.variant.add(token);
    else if (COLOUR[token]) f.colour.add(COLOUR[token]);
    else if (ACCESSORY_WORDS.has(token)) f.accessory.add(token);
    else {
      const stem = ACCESSORY_STEMS.find((s) => token.includes(s));
      if (stem) f.accessory.add(stem);
      else f.words.add(token);
    }
  }
  return f;
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

function brandsAgree(a: ProductHit, b: ProductHit): boolean {
  const [ba, bb] = [brandTokens(a.brand), brandTokens(b.brand)];
  if (ba.length && bb.length) return ba[0] === bb[0];
  // One site knows the brand: the other's name must start with it ("Eazy Case for Apple ..." is not Apple's).
  const known = ba.length ? ba : bb;
  if (!known.length) return true;
  const other = ba.length ? b : a;
  return fold(other.name).split(/[^a-z0-9]+/).filter(Boolean)[0] === known[0];
}

const MIN_WORD_OVERLAP = 0.75;
/** Lowest listed prices further apart than this are not the same product (the floor allows a used offer vs new). */
const MAX_PRICE_RATIO = 4;

/**
 * Whether two listings (normally one per site) are the same product: "gtin" when their GTINs
 * intersect, "name" when brand, model numbers, capacities, sizes, variant words and colours agree
 * and the remaining words mostly overlap, else null. Errs towards null.
 */
export function matchProducts(a: ProductHit, b: ProductHit): MatchKind {
  if (a.gtin.length && b.gtin.some((code) => a.gtin.includes(code))) return "gtin";
  if (!brandsAgree(a, b)) return null;
  if (a.category && b.category && ACCESSORY_CATEGORY.test(fold(a.category)) !== ACCESSORY_CATEGORY.test(fold(b.category))) return null;
  if (a.lowest_price && b.lowest_price && Math.max(a.lowest_price, b.lowest_price) / Math.min(a.lowest_price, b.lowest_price) > MAX_PRICE_RATIO) return null;

  const fa = features(a);
  const fb = features(b);
  // Premium tiers always have noise cancelling, so one site's "ANC" doesn't split AirPods Pro 3 (AirPods 4 vs AirPods 4 ANC still split).
  const premium = (f: Features) => f.variant.has("pro") || f.variant.has("max");
  if (premium(fa) && premium(fb)) for (const f of [fa, fb]) f.variant.delete("anc");
  if (!sameSet(fa.hard, fb.hard) || !sameSet(fa.variant, fb.variant) || !sameSet(fa.accessory, fb.accessory)) return null;
  // Storage (the largest capacity) must agree; memory only when both name it (Prisjakt lists phone RAM, PriceRunner rarely).
  if (fa.capacity.size !== 0 || fb.capacity.size !== 0) {
    if (Math.max(...fa.capacity) !== Math.max(...fb.capacity)) return null;
    if (fa.capacity.size > 1 && fb.capacity.size > 1 && !sameSet(fa.capacity, fb.capacity)) return null;
  }
  for (const kind of Object.keys(fa.soft) as (keyof Features["soft"])[]) {
    if (fa.soft[kind].size && fb.soft[kind].size && !sameSet(fa.soft[kind], fb.soft[kind])) return null;
  }
  if (fa.colour.size && fb.colour.size && !sameSet(fa.colour, fb.colour)) return null;
  // The same full model code on both sides (OLED55C51LA) settles it whatever the marketing words.
  if (fa.soft.code.size && sameSet(fa.soft.code, fb.soft.code)) return "name";
  // Something concrete must tie them: a shared model number/capacity, or identical wording.
  const shared = fa.capacity.size > 0 || [...fa.hard, ...fa.soft.code].some((t) => fb.hard.has(t) || fb.soft.code.has(t));
  const overlap = jaccard(fa.words, fb.words);
  if (!shared && (overlap < 1 || fa.words.size === 0)) return null;
  return overlap >= MIN_WORD_OVERLAP ? "name" : null;
}

// ---- Keys ----

/** "prisjakt:123+pricerunner:456" from site ids (Prisjakt first). */
export function keyOf(ids: Partial<Record<SourceId, string>>): string {
  return SOURCE_IDS.filter((source) => ids[source]).map((source) => `${source}:${ids[source]}`).join("+");
}

const KEY_PART = /^(prisjakt|pricerunner):(\d+(?:-\d+)?)$/;

/** Site ids from a key, or null when the string is not a key. */
export function parseKey(key: string): Partial<Record<SourceId, string>> | null {
  const ids: Partial<Record<SourceId, string>> = {};
  for (const part of key.trim().split("+")) {
    const match = KEY_PART.exec(part.trim());
    if (!match || ids[match[1] as SourceId]) return null;
    ids[match[1] as SourceId] = match[2];
  }
  return Object.keys(ids).length ? ids : null;
}

// ---- Products ----

/** One MergedProduct from one listing per site; the first given leads for name, image and category. */
export function mergedProduct(hits: ProductHit[], match: MatchKind): MergedProduct {
  const [lead] = hits;
  const pick = <T>(get: (hit: ProductHit) => T | null): T | null => hits.map(get).find((value) => value !== null) ?? null;
  const priced = hits.filter((hit) => hit.lowest_price !== null);
  const cheapest = priced.length ? priced.reduce((best, hit) => ((hit.lowest_price as number) < (best.lowest_price as number) ? hit : best)) : null;
  const sources: Partial<Record<SourceId, SourceListing>> = {};
  for (const hit of hits) sources[hit.source] = { id: hit.id, url: hit.url, lowest_price: hit.lowest_price, offer_count: hit.offer_count };
  return {
    key: keyOf(Object.fromEntries(hits.map((hit) => [hit.source, hit.id]))),
    name: lead.name,
    brand: pick((hit) => hit.brand),
    category: pick((hit) => hit.category),
    image: pick((hit) => hit.image),
    rating: hits.map((hit) => hit.rating).reduce((best, r) => (r && (!best || r.count > best.count) ? r : best), null as ProductHit["rating"]),
    gtin: [...new Set(hits.flatMap((hit) => hit.gtin))],
    sources,
    match: hits.length > 1 ? match : null,
    cheapest: cheapest ? { price: cheapest.lowest_price as number, source: cheapest.source } : null,
  };
}

/**
 * Merges each site's search hits into one list: listings matchProducts ties together become one
 * product. Ordered by best position in either list; at equal position a two-site product goes first.
 */
export function mergeHits(lists: Partial<Record<SourceId, ProductHit[]>>): MergedProduct[] {
  const pj = lists.prisjakt ?? [];
  const pr = lists.pricerunner ?? [];
  const pairs: { i: number; j: number; kind: Exclude<MatchKind, null> }[] = [];
  pj.forEach((a, i) =>
    pr.forEach((b, j) => {
      const kind = matchProducts(a, b);
      if (kind) pairs.push({ i, j, kind });
    }),
  );
  pairs.sort((x, y) => Number(y.kind === "gtin") - Number(x.kind === "gtin") || x.i + x.j - (y.i + y.j) || x.i - y.i);

  const pairOfPj = new Map<number, { j: number; kind: Exclude<MatchKind, null> }>();
  const usedPr = new Set<number>();
  for (const { i, j, kind } of pairs) {
    if (pairOfPj.has(i) || usedPr.has(j)) continue;
    pairOfPj.set(i, { j, kind });
    usedPr.add(j);
  }

  const rows: { rank: number; both: boolean; order: number; product: MergedProduct }[] = [];
  pj.forEach((a, i) => {
    const pair = pairOfPj.get(i);
    // Prisjakt names a model once for all colours; PriceRunner often lists each colour.
    const hits = pair ? [a, pr[pair.j]] : [a];
    rows.push({ rank: pair ? Math.min(i, pair.j) : i, both: !!pair, order: rows.length, product: mergedProduct(hits, pair?.kind ?? null) });
  });
  pr.forEach((b, j) => {
    if (!usedPr.has(j)) rows.push({ rank: j, both: false, order: rows.length, product: mergedProduct([b], null) });
  });
  return rows.sort((x, y) => x.rank - y.rank || Number(y.both) - Number(x.both) || x.order - y.order).map((row) => row.product);
}

// ---- Offers ----

/** Store name both sites agree on: "Komplett.se" / "Komplett AB" / "www.komplett.se" -> "komplett". */
export function storeKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^www\./, "")
    .replace(/\.(?:se|com|nu)\b/g, "")
    .replace(/\s+(?:ab|sverige)\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const cost = (offer: { total: number | null; price: number }) => offer.total ?? offer.price;

/**
 * One row per store and condition across sites (condition null counts as new): a store's several
 * rows on one site collapse to its cheapest, the same store on both sites becomes one row with the
 * lower price and both prices in seen_on. Sorted cheapest first by total when known, else price.
 */
export function mergeOffers(offers: Offer[]): MergedOffer[] {
  const groups = new Map<string, Offer[]>();
  for (const offer of offers) {
    const store = storeKey(offer.store) || `${offer.source}:${offer.store_id ?? offer.store}`;
    const key = `${store}|${offer.condition ?? "new"}`;
    const group = groups.get(key);
    if (group) group.push(offer);
    else groups.set(key, [offer]);
  }
  const merged: MergedOffer[] = [];
  for (const group of groups.values()) {
    const best = group.reduce((a, b) => (cost(b) < cost(a) || (cost(b) === cost(a) && b.price < a.price) ? b : a));
    const seen_on: Partial<Record<SourceId, number>> = {};
    for (const source of new Set(group.map((offer) => offer.source))) {
      seen_on[source] = Math.min(...group.filter((offer) => offer.source === source).map((offer) => offer.price));
    }
    merged.push({
      store: best.store,
      price: Math.min(...group.map((offer) => offer.price)),
      shipping: best.shipping,
      total: best.total,
      in_stock: best.in_stock,
      stock_text: best.stock_text,
      condition: best.condition,
      store_rating: best.store_rating ?? group.find((offer) => offer.store_rating)?.store_rating ?? null,
      title: best.title,
      url: best.url,
      seen_on,
    });
  }
  return merged.sort((a, b) => cost(a) - cost(b) || a.price - b.price);
}

/** Lowest new price of one site's offers. */
export function lowestNewPrice(offers: Offer[]): number | null {
  const prices = offers.filter(isNew).map((offer) => offer.price);
  return prices.length ? Math.min(...prices) : null;
}

export const isNew = (offer: { condition: Offer["condition"] }) => offer.condition === "new" || offer.condition === null;

// ---- Verdict ----

function kr(amount: number): string {
  return `${Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ")} kr`;
}

/**
 * One sentence on today's lowest new price against the price history, or null without one.
 * Compares whole kronor; the 90-day low leads because old all-time lows can be bogus (e.g. a reused product id).
 */
export function verdict(price: number | null, history: PriceHistory | null): string | null {
  if (price === null || !history) return null;
  const now = Math.round(price);
  const ever = history.lowest_ever;
  if (ever && now < Math.round(ever.price)) return `${kr(now)} today is below the lowest price recorded before (${kr(ever.price)} on ${ever.date}).`;
  if (ever && now === Math.round(ever.price)) return `${kr(now)} today matches the lowest price ever recorded (${ever.date}).`;
  const low = history.lowest_90d ?? null;
  const base = low ?? ever?.price ?? null;
  if (base === null) return null;
  if (low !== null && now <= Math.round(low)) return `${kr(now)} today is the lowest in 90 days.`;
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const day = low === null ? ever?.date : history.points.filter((point) => point.date >= since && point.price === low).at(-1)?.date;
  const above = Math.max(1, Math.round(((now - base) / base) * 100));
  return `${kr(now)} today is ${above}% above the ${low === null ? "lowest price ever" : "90-day low"} of ${kr(base)}${day ? ` on ${day}` : ""}.`;
}
