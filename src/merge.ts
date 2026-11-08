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
    "bluetooth hogtalare speaker gps band " +
    "oc cpu gpu core ai standard disc chassis echassis chip unified memory storage"
  ).split(" "),
);

/** Words that tell product variants apart: both names must carry the same set. "bundle" also stands for combo, kit-like paket and kraftpaket. */
const VARIANT = new Set(
  "pro max plus ultra mini lite slim digital fe se xl fold flip oled qled usbc lightning anc wifi cellular lte air neo edge bundle creator".split(" "),
);
/** Display-technology words a TV name may add next to its full model code (LG 65" OLED C4 (OLED65C44LA)). */
const DISPLAY_TECH = new Set(["oled", "qled"]);

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
  obsidian: "obsidian", porcelain: "porcelain", hazel: "hazel", rose: "rose", teal: "teal",
  ultramarine: "ultramarine", onyx: "onyx", cobalt: "cobalt", violet: "violet", lavender: "lavender", mint: "mint",
  cream: "cream", sand: "sand", navy: "navy", desert: "desert", natural: "natural", natur: "natural", naturlig: "natural", space: "space", spacegrey: "space",
  spacegray: "space", taupe: "taupe", coral: "coral", jade: "jade", amber: "amber", sage: "sage", mocha: "mocha",
  neon: "neon", marble: "marble", iceblue: "iceblue", sky: "sky", himmelblau: "sky", skyblue: "sky",
};

/** Case materials, compared apart from the colour: "Svart titan" is black + titanium, "Aluminium" alone has no colour. */
const MATERIAL: Record<string, string> = { titanium: "titanium", titan: "titanium", aluminium: "aluminium", aluminum: "aluminium", steel: "steel" };

const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:gb|tb|mb|in|mah|w|hz|mm|cm|l|kg)$/;
const CAPACITY_TOKEN = /^(\d+(?:\.\d+)?)(gb|tb)$/;
const YEAR_TOKEN = /^(?:19|20)\d\d$/;
const CODE_TOKEN = /^[a-z]+\d[a-z0-9]*$/;
/** Accessory-looking category names (Swedish): "Tillbehör för hörlurar", "Skärmskydd", "Datorväskor". */
const ACCESSORY_CATEGORY = /tillbehor|skydd|skal|fodral|vask|kabel|laddare/;
/** Phones: Prisjakt names their RAM and network ("12GB RAM", "5G"), PriceRunner mostly doesn't, so those are compared softly. */
const PHONE_CATEGORY = /mobil|telefon|phone/;
const PHONE_NAME = /\b(?:iphone|pixel \d|galaxy (?:[asmz]\d|z |note)|xperia|oneplus|redmi|fairphone)/;

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
  material: Set<string>;
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
    .replace(/\brymdgra\b/g, " spacegrey ")
    .replace(/\brymdsvart\b/g, " space black ")
    .replace(/\bokentitan\b/g, " desert titanium ")
    .replace(/\bneo\s+qled\b/g, " qled ")
    // Cellular models: Prisjakt says 4G, PriceRunner "GPS + Cellular", tablets "Wi-Fi + Cellular".
    .replace(/\b(?:gps|wi-?fi)\s*(?:\+|plus|och|and|&)?\s*(?:cellular|lte|[45]g)\b/g, " cellular ")
    // A watch's case material is the product, "Case" and the band size are wording (Aluminium Case with Sport Band M/L).
    .replace(/\b(aluminium|aluminum|titanium|titan|steel)\s+case\b/g, " $1 ")
    .replace(/\b(?:s\/m|m\/l)\b/g, " ")
    // Bundles and editions, Swedish to English: Utökad Kraftpaket = Power Bundle, Skaparens Utgåva = Creator Edition.
    .replace(/\b(?:utokad\s+)?kraftpaket\b/g, " power bundle ")
    .replace(/\btillbehorspaket\b/g, " accessory bundle ")
    .replace(/\baccessories\b/g, " accessory ")
    .replace(/\bskaparens\b/g, " creator ")
    .replace(/\b(?:combo|[a-z]*paket)\b/g, " bundle ")
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
    .replace(/([a-z0-9])-(?=[a-z0-9])/g, "$1")
    // A word glued to a short number is the same as spaced: Buds3 = Buds 3, HERO13 = HERO 13 (short codes like V15, M3, DHP485 stay).
    .replace(/\b([a-z]{4,})(\d{1,2})\b/g, "$1 $2");
  return s;
}

/**
 * Whether a listing's name fits the query (folded the same way as for matching): it must contain every
 * model-code or number word of the query, and one of its other words if it has any. PriceRunner answers
 * a query it can't match with unrelated popular products (same brand, other model); this drops them.
 */
export function mentionsQuery(query: string, name: string): boolean {
  const haystack = normalize(name);
  const tokens = haystack.split(/[^a-z0-9.]+/).map((token) => token.replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const words = normalize(query)
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word.length > 1 || /\d/.test(word));
  const codes = words.filter((word) => /\d/.test(word));
  const plain = words.filter((word) => !/\d/.test(word));
  if (!words.length) return false;
  return codes.every((code) => tokens.some((token) => containsCode(token, code))) && (plain.length === 0 || plain.some((word) => haystack.includes(word)));
}

/**
 * Whether a name token contains a query's code or number without running into other digits: "55" is in
 * QE55Q80D and 128gb but not in 155; a long code may carry a regional suffix (OLED65C4 in OLED65C44LA).
 */
function containsCode(token: string, code: string): boolean {
  for (let at = token.indexOf(code); at !== -1; at = token.indexOf(code, at + 1)) {
    // Only digits running into the code's own digits change the number (Q80D sits fine after QE55).
    if (/^\d/.test(code) && /\d/.test(token[at - 1] ?? "")) continue;
    const after = token[at + code.length] ?? "";
    if (/\d$/.test(code) && /\d/.test(after) && (/^[\d.]+$/.test(code) || code.length < 5)) continue;
    return true;
  }
  return false;
}

/** `brand`: the agreed brand's words, dropped from either name even when only one site states the brand. */
function features(hit: ProductHit, brand: Set<string>, phone: boolean): Features {
  const tokens = normalize(hit.name)
    .split(/[^a-z0-9.]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
  const f: Features = {
    hard: new Set(),
    capacity: new Set(),
    soft: { year: new Set(), cores: new Set(), net: new Set(), res: new Set(), code: new Set() },
    variant: new Set(),
    accessory: new Set(),
    colour: new Set(),
    material: new Set(),
    words: new Set(),
  };
  for (const token of tokens) {
    if (/\d/.test(token)) {
      const capacity = CAPACITY_TOKEN.exec(token);
      if (capacity) f.capacity.add(Number(capacity[1]) * (capacity[2] === "tb" ? 1000 : 1));
      else if (YEAR_TOKEN.test(token)) f.soft.year.add(token);
      else if (/^\d+c$/.test(token)) f.soft.cores.add(token);
      // A phone's 4G/5G is often left out on one site; on a watch or tablet it is the cellular model.
      else if (/^[2-5]g$/.test(token)) {
        if (phone) f.soft.net.add(token);
        else if (token !== "2g" && token !== "3g") f.variant.add("cellular");
        else f.hard.add(token);
      }
      else if (/^[248]k$/.test(token)) f.soft.res.add(token);
      else if (!UNIT_TOKEN.test(token) && CODE_TOKEN.test(token) && token.length >= 5) f.soft.code.add(token);
      else f.hard.add(token);
      continue;
    }
    if (brand.has(token) || FILLER.has(token)) continue;
    if (token === "lte") f.variant.add("cellular");
    // Single letters name variants: Xbox Series X vs S.
    else if (VARIANT.has(token) || token.length === 1) f.variant.add(token);
    else if (COLOUR[token]) f.colour.add(COLOUR[token]);
    else if (MATERIAL[token]) f.material.add(MATERIAL[token]);
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

/**
 * Model codes agree when equal or one extends the other by a regional suffix of two or more characters
 * (QE65QN90D, QE65QN90DAT); a one-letter suffix often names another configuration (Makita DHP485Z = body only).
 */
function codesAgree(a: Set<string>, b: Set<string>): boolean {
  const same = (x: string, y: string) => x === y || (x.startsWith(y) && x.length - y.length >= 2) || (y.startsWith(x) && y.length - x.length >= 2);
  return [...a].every((x) => [...b].some((y) => same(x, y))) && [...b].every((y) => [...a].some((x) => same(x, y)));
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
 * Whether two listings (normally one per site) are the same product: "name" when brand, model
 * numbers, capacities, sizes, variant words, colours and materials agree and the remaining words
 * mostly overlap, else null. Errs towards null.
 */
export function matchProducts(a: ProductHit, b: ProductHit): MatchKind {
  if (!brandsAgree(a, b)) return null;
  if (a.category && b.category && ACCESSORY_CATEGORY.test(fold(a.category)) !== ACCESSORY_CATEGORY.test(fold(b.category))) return null;
  if (a.lowest_price && b.lowest_price && Math.max(a.lowest_price, b.lowest_price) / Math.min(a.lowest_price, b.lowest_price) > MAX_PRICE_RATIO) return null;

  const brand = new Set([...brandTokens(a.brand), ...brandTokens(b.brand)]);
  const phone = [a, b].some((hit) => (hit.category !== null && PHONE_CATEGORY.test(fold(hit.category))) || PHONE_NAME.test(fold(hit.name)));
  const fa = features(a, brand, phone);
  const fb = features(b, brand, phone);
  // Premium tiers always have noise cancelling, so one site's "ANC" doesn't split AirPods Pro 3 (AirPods 4 vs AirPods 4 ANC still split).
  const premium = (f: Features) => f.variant.has("pro") || f.variant.has("max");
  if (premium(fa) && premium(fb)) for (const f of [fa, fb]) f.variant.delete("anc");
  // The same full model code on both sides (OLED65C44LA) already fixes size and panel, so a name that also spells
  // them out ("65\" (163 cm) OLED C4") is not a different product.
  const sameCode = fa.soft.code.size > 0 && fb.soft.code.size > 0 && codesAgree(fa.soft.code, fb.soft.code);
  if (sameCode) {
    const codes = [...fa.soft.code, ...fb.soft.code];
    const inCode = (token: string) => codes.some((code) => code.includes(token));
    for (const f of [fa, fb]) {
      for (const token of f.hard) if (inCode(token) || /^\d+(?:\.\d+)?cm$/.test(token)) f.hard.delete(token);
      for (const token of f.variant) if (DISPLAY_TECH.has(token) || inCode(token)) f.variant.delete(token);
    }
  }
  if (!sameSet(fa.hard, fb.hard) || !sameSet(fa.variant, fb.variant) || !sameSet(fa.accessory, fb.accessory)) return null;
  // Storage (the largest capacity) must agree. Memory too, except on phones where only both naming it counts
  // (Prisjakt lists phone RAM, PriceRunner rarely); a laptop named without its RAM could be any configuration.
  if (fa.capacity.size !== 0 || fb.capacity.size !== 0) {
    if (Math.max(...fa.capacity) !== Math.max(...fb.capacity)) return null;
    if ((phone ? fa.capacity.size > 1 && fb.capacity.size > 1 : true) && !sameSet(fa.capacity, fb.capacity)) return null;
  }
  for (const kind of Object.keys(fa.soft) as (keyof Features["soft"])[]) {
    if (!fa.soft[kind].size || !fb.soft[kind].size) continue;
    if (kind === "code" ? !sameCode : !sameSet(fa.soft[kind], fb.soft[kind])) return null;
  }
  if (fa.colour.size && fb.colour.size && !sameSet(fa.colour, fb.colour)) return null;
  if (fa.material.size && fb.material.size && !sameSet(fa.material, fb.material)) return null;
  // The same full model code on both sides settles it whatever the marketing words.
  if (sameCode) return "name";
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
  for (const hit of hits) {
    sources[hit.source] = { id: hit.id, url: hit.url, lowest_price: hit.lowest_price, lowest_price_secondhand: hit.lowest_price_secondhand, offer_count: hit.offer_count };
  }
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
  pairs.sort((x, y) => x.i + x.j - (y.i + y.j) || x.i - y.i);

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

/** Words after the first that only say where a store is registered: "Komplett AB", "Back Market SE". */
const CORPORATE_WORDS = new Set(["ab", "se", "sverige", "sweden"]);

/** The same store under names the prefix rule can't tie: different words on each site. */
const STORE_ALIAS: Record<string, string> = {
  kjellcompany: "kjell",
  kjellochcompany: "kjell",
  goeckerphotovideo: "goecker",
  multitechdata: "multitech",
};

/** Extra words that name a separate shop of the same chain, so a shorter name is not the same store. */
const SEPARATE_SHOP_WORDS = new Set(["outlet", "business", "foretag", "b2b", "marketplace", "begagnat", "refurbished", "refurb", "used", "pro"]);

function storeWords(name: string): string[] {
  return fold(name)
    .trim()
    .replace(/^www\./, "")
    .replace(/\.(?:se|com|nu|eu)\b/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word, i, words) => word && !(CORPORATE_WORDS.has(word) && words.slice(0, i).some(Boolean)));
}

/** Store name both sites agree on: "Komplett.se" / "Komplett AB" / "www.komplett.se" -> "komplett". */
export function storeKey(name: string): string {
  const key = storeWords(name).join("");
  return STORE_ALIAS[key] ?? key;
}

/**
 * Store keys to fold into a shorter one when one site adds words to the name ("Goecker" / "Goecker
 * Photo | Video"). Only across sites (a site listing both names means two shops), only when the pairing
 * is one-to-one and the extra words don't name a separate shop (outlet, business).
 */
function prefixAliases(offers: Offer[]): Map<string, string> {
  const stores = new Map<string, { words: string[]; sources: Set<SourceId> }>();
  for (const offer of offers) {
    const key = storeKey(offer.store);
    if (!key) continue;
    const store = stores.get(key) ?? { words: storeWords(offer.store), sources: new Set<SourceId>() };
    store.sources.add(offer.source);
    stores.set(key, store);
  }
  const longer = new Map<string, string[]>();
  const shorter = new Map<string, string[]>();
  for (const [shortKey, short] of stores) {
    if (short.words[0].length < 3) continue;
    for (const [longKey, long] of stores) {
      if (long.words.length <= short.words.length || !short.words.every((word, i) => long.words[i] === word)) continue;
      if ([...long.sources].some((source) => short.sources.has(source))) continue;
      if (long.words.slice(short.words.length).some((word) => SEPARATE_SHOP_WORDS.has(word))) continue;
      longer.set(shortKey, [...(longer.get(shortKey) ?? []), longKey]);
      shorter.set(longKey, [...(shorter.get(longKey) ?? []), shortKey]);
    }
  }
  const aliases = new Map<string, string>();
  for (const [longKey, shorts] of shorter) {
    if (shorts.length === 1 && longer.get(shorts[0])?.length === 1) aliases.set(longKey, shorts[0]);
  }
  return aliases;
}

const cost = (offer: { total: number | null; price: number }) => offer.total ?? offer.price;

/** Not known to be sold out (in stock or stock unknown). Sold-out rows often carry stale low prices. */
export const isBuyable = (offer: { in_stock: boolean | null }) => offer.in_stock !== false;

/** The offers not known to be sold out, or all of them when every one is. */
function preferBuyable<T extends { in_stock: boolean | null }>(offers: T[]): T[] {
  return offers.some(isBuyable) ? offers.filter(isBuyable) : offers;
}

/**
 * One row per store and condition across sites (condition null counts as new): a store's several
 * rows on one site collapse to its cheapest, the same store on both sites becomes one row. The row's
 * price, shipping, total, stock, title and url all come from one offer, the cheapest by total, so the
 * link sells at the price shown; seen_on carries each site's own price. Rows not known to be sold out
 * win over sold-out ones, and a site's sold-out price stays out of seen_on when the store is buyable.
 * Sorted with sold-out rows last, otherwise cheapest first by total when known, else price, so the
 * first new / used row is the cheapest buyable one when any exists.
 */
export function mergeOffers(offers: Offer[]): MergedOffer[] {
  const aliases = prefixAliases(offers);
  const groups = new Map<string, Offer[]>();
  for (const offer of offers) {
    const own = storeKey(offer.store);
    const store = own ? (aliases.get(own) ?? own) : `${offer.source}:${offer.store_id ?? offer.store}`;
    const key = `${store}|${offer.condition ?? "new"}`;
    const group = groups.get(key);
    if (group) group.push(offer);
    else groups.set(key, [offer]);
  }
  const merged: MergedOffer[] = [];
  for (const group of groups.values()) {
    const pool = preferBuyable(group);
    const best = pool.reduce((a, b) => (cost(b) < cost(a) || (cost(b) === cost(a) && b.price < a.price) ? b : a));
    const seen_on: Partial<Record<SourceId, number>> = {};
    for (const offer of pool) seen_on[offer.source] = Math.min(seen_on[offer.source] ?? Infinity, offer.price);
    merged.push({
      store: best.store,
      price: best.price,
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
  return merged.sort((a, b) => Number(!isBuyable(a)) - Number(!isBuyable(b)) || cost(a) - cost(b) || a.price - b.price);
}

/** Lowest new price of one site's offers, not counting sold-out rows unless all are. */
export function lowestNewPrice(offers: Offer[]): number | null {
  const prices = preferBuyable(offers.filter(isNew)).map((offer) => offer.price);
  return prices.length ? Math.min(...prices) : null;
}

/** Lowest used or refurbished price of one site's offers, not counting sold-out rows unless all are. */
export function lowestSecondhandPrice(offers: Offer[]): number | null {
  const prices = preferBuyable(offers.filter((offer) => !isNew(offer))).map((offer) => offer.price);
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
 * One or two sentences on one site's lowest new price today against that site's own price history,
 * or null without one. `cheaper` is a lower new offer the history doesn't cover (listed only on the
 * other site), mentioned so the comparison stays like with like. Compares whole kronor; the 90-day
 * low leads because old all-time lows can be bogus (e.g. a reused product id). Lows of 0 are ignored.
 */
export function verdict(
  price: number | null,
  history: PriceHistory | null,
  site: string,
  cheaper: { price: number; store: string; site: string } | null = null,
): string | null {
  if (price === null || !history) return null;
  const now = Math.round(price);
  const subject = `${site}'s lowest new price, ${kr(now)} today,`;
  const sentence = ((): string | null => {
    const ever = history.lowest_ever && history.lowest_ever.price > 0 ? history.lowest_ever : null;
    if (ever && now < Math.round(ever.price)) return `${subject} is below the lowest it recorded before (${kr(ever.price)} on ${ever.date}).`;
    if (ever && now === Math.round(ever.price)) return `${subject} matches the lowest it has ever recorded (${ever.date}).`;
    const low = history.lowest_90d !== null && history.lowest_90d > 0 ? history.lowest_90d : null;
    const base = low ?? ever?.price ?? null;
    if (base === null) return null;
    if (low !== null && now <= Math.round(low)) return `${subject} is the lowest in 90 days.`;
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const day = low === null ? ever?.date : history.points.filter((point) => point.date >= since && point.price === low).at(-1)?.date;
    const above = Math.max(1, Math.round(((now - base) / base) * 100));
    return `${subject} is ${above}% above its ${low === null ? "lowest price ever" : "90-day low"} of ${kr(base)}${day ? ` on ${day}` : ""}.`;
  })();
  if (!sentence || !cheaper || Math.round(cheaper.price) >= now) return sentence;
  return `${sentence} ${cheaper.store} sells it for ${kr(cheaper.price)} on ${cheaper.site}, outside ${site}'s history.`;
}
