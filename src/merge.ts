// Cross-site merging: ties a Prisjakt listing to its PriceRunner counterpart (by GTIN ties the caller found, else
// matchProducts), merges search lists (mergeHits) and store offers (mergeOffers), and builds the keys compare takes.

import type { MatchKind, MergedOffer, MergedProduct, Offer, PriceHistory, ProductHit, SourceId, SourceListing } from "./types.js";

export const SOURCE_IDS: readonly SourceId[] = ["prisjakt", "pricerunner"];

// ---- Name analysis ----

/** Words that carry no identity: connectors, product-type nouns, marketing filler. */
const FILLER = new Set(
  (
    "with med och and for till the of a an en ett i in inkl incl new ny nya " +
    "generation gen edition utgava version model modell series serie " +
    // "earbuds" is not here: Bose names two products QuietComfort Ultra and QuietComfort Ultra Earbuds.
    "tradlosa tradlos tradlost wireless horlurar headphones earphones inear overear onear aroundear around ear " +
    "smartphone mobiltelefon telefon mobil phone tv smart led uhd hd ssd ram dual sim esim " +
    "sladdlos cordless skaftdammsugare dammsugare stickvacuum vacuum konsol console spelkonsol laptop notebook barbar dator " +
    "bluetooth hogtalare speaker gps band mouse mus " +
    "oc cpu gpu core ai standard disc chassis echassis chip unified memory storage"
  ).split(" "),
);

/** Words that tell product variants apart: both names must carry the same set. "bundle" also stands for combo, kit-like paket and kraftpaket. */
const VARIANT = new Set(
  "pro max plus ultra mini lite slim digital fe se xl fold flip oled qled usbc lightning anc wifi cellular lte air neo edge bundle creator btedition".split(" "),
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
  neon: "neon", marble: "marble", sky: "sky", himmelblau: "sky", skyblue: "sky", whitestone: "white",
};

/**
 * Shade words that belong to the colour after them: "Jet Black" is black, "Tidal Blue" is blue. A closed list:
 * "Warm White" / "Cool White" are different bulbs and "X1 Carbon" is a model, so those words stay out.
 */
const COLOUR_MODIFIER = new Set(
  "jet icy ice soft deep dark light pale matte mist misty cloud ink powder tidal smoky cosmic storm pearl snow phantom mystic sunset pastel".split(" "),
);

/**
 * Words that can stand next to a colour but name another product, so they are never taken as part of a colour
 * name: Hue "White Ambiance" and "White and Color" are other bulbs than "White", "Warm White" another than "Cool
 * White", and an Apple Watch "Sport Loop" another band than "Sport Band".
 */
const NOT_SHADE = new Set("ambiance ambience color colour farg warm cool daylight loop solo milanese ii iii iv".split(" "));

/**
 * A colour written as one word with what precedes it: a shade (jetblack = black), another colour (blueblack =
 * blue + black) or a variant word PriceRunner glues on (Ultrasvart = Ultra, black). Only those three kinds of
 * prefix: paperwhite, evergreen and bluetooth are not colours.
 */
function gluedColour(token: string): { variant: string | null; colours: string[] } | null {
  for (const [word, colour] of Object.entries(COLOUR)) {
    if (token.length === word.length || !token.endsWith(word)) continue;
    const lead = token.slice(0, -word.length);
    if (COLOUR_MODIFIER.has(lead)) return { variant: null, colours: [colour] };
    if (COLOUR[lead]) return { variant: null, colours: [COLOUR[lead], colour] };
    if (VARIANT.has(lead)) return { variant: lead, colours: [colour] };
  }
  return null;
}

/** Case materials, compared apart from the colour: "Svart titan" is black + titanium, "Aluminium" alone has no colour. */
const MATERIAL: Record<string, string> = { titanium: "titanium", titan: "titanium", aluminium: "aluminium", aluminum: "aluminium", steel: "steel" };

const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:gb|tb|mb|in|mah|w|hz|mm|cm|l|kg)$/;
const CAPACITY_TOKEN = /^(\d+(?:\.\d+)?)(gb|tb)$/;
const YEAR_TOKEN = /^(?:19|20)\d\d$/;
const CODE_TOKEN = /^[a-z]+\d[a-z0-9]*$/;
/** De'Longhi-style codes: ECAM22.112, ECAM22.112.B. Counted as a code only with four or more digits (USB3.2, HDMI2.1 are not). */
const DOTTED_CODE_TOKEN = /^[a-z]+\d[a-z0-9]*(?:\.[a-z0-9]+)+$/;
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
  soft: Record<"year" | "cores" | "net" | "res" | "code" | "series", Set<string>>;
  variant: Set<string>;
  accessory: Set<string>;
  colour: Set<string>;
  material: Set<string>;
  words: Set<string>;
  /** Words of `words` that may belong to a marketing colour name ("Silver Shadow"), see the end of features(). */
  shade: Set<string>;
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
    .replace(/\bair\s+fryer\b/g, " airfryer ")
    // Logitech's "Bluetooth Edition" (MX Master 3S, MX Keys) ships without the USB receiver: another product than the
    // plain model. Plain "Bluetooth" stays filler (speakers, headphones).
    .replace(/\bbluetooth\s+edition\b/g, " btedition ")
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
    // A model word and its dotted number written apart are one code: ECAM 21.117.B = ECAM21.117.B.
    .replace(/\b([a-z]{2,5})\s+(\d{2,3}\.\d{2,3})(?!\d)/g, (whole: string, word: string, number: string) =>
      FILLER.has(word) || VARIANT.has(word) || COLOUR[word] ? whole : `${word}${number}`,
    )
    // A word glued to a short number is the same as spaced: Buds3 = Buds 3, HERO13 = HERO 13 (short codes like V15, M3, DHP485
    // and dotted codes like ECAM22.112 stay).
    .replace(/\b([a-z]{4,})(\d{1,2})\b(?!\.\d)/g, "$1 $2");
  return s;
}

/**
 * Whether a listing fits the query (folded the same way as for matching): its name must contain every
 * model-code or number word of the query, and its name or category one of the query's other words if it
 * has any. PriceRunner answers a query it can't match with unrelated popular products (same brand, other
 * model); this drops them. The category counts because names rarely state it: "kaffemaskin" finds
 * "De'Longhi Magnifica S" in Kaffemaskiner.
 */
export function mentionsQuery(query: string, name: string, category: string | null = null): boolean {
  const haystack = normalize(name);
  const tokens = haystack.split(/[^a-z0-9.]+/).map((token) => token.replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const words = normalize(query)
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word.length > 1 || /\d/.test(word));
  const codes = words.filter((word) => /\d/.test(word));
  const plain = words.filter((word) => !/\d/.test(word));
  if (!words.length) return false;
  const described = category ? `${haystack} ${normalize(category)}` : haystack;
  return codes.every((code) => tokens.some((token) => containsCode(token, code))) && (plain.length === 0 || plain.some((word) => described.includes(word)));
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
function features(name: string, brand: Set<string>, phone: boolean): Features {
  const text = normalize(name)
    // A product-line number, as one token: "3000 Series", "5000-serien", Bosch/Siemens "Serie 6". Done here, not in
    // normalize, so a query's "3000" still finds it. English "Series 10" (Apple Watch) is the model and stays as is.
    .replace(/\b(\d{3,4})[\s-]*serie(?:s|n)?\b/g, " $1series ")
    .replace(/\bserie\s+(\d)\b/g, " $1series ");
  const tokens: string[] = [];
  /** What separates each token from the one before it: a space, " - ", "/". */
  const gaps: string[] = [];
  let end = 0;
  for (const match of text.matchAll(/[a-z0-9.]+/g)) {
    const token = match[0].replace(/^\.+|\.+$/g, "");
    if (!token) continue;
    gaps.push(text.slice(end, match.index));
    end = match.index + match[0].length;
    tokens.push(token);
  }
  /** Per token: a colour word (shade words leading a colour included), an unclassified word, or anything else. */
  const kinds: ("colour" | "word" | "other")[] = tokens.map(() => "other");
  const f: Features = {
    hard: new Set(),
    capacity: new Set(),
    soft: { year: new Set(), cores: new Set(), net: new Set(), res: new Set(), code: new Set(), series: new Set() },
    variant: new Set(),
    accessory: new Set(),
    colour: new Set(),
    material: new Set(),
    words: new Set(),
    shade: new Set(),
  };
  for (const [at, token] of tokens.entries()) {
    if (/\d/.test(token)) {
      const capacity = CAPACITY_TOKEN.exec(token);
      if (capacity) f.capacity.add(Number(capacity[1]) * (capacity[2] === "tb" ? 1000 : 1));
      else if (/^\d+series$/.test(token)) f.soft.series.add(token);
      else if (YEAR_TOKEN.test(token)) f.soft.year.add(token);
      else if (/^\d+c$/.test(token)) f.soft.cores.add(token);
      // A phone's 4G/5G is often left out on one site; on a watch or tablet it is the cellular model.
      else if (/^[2-5]g$/.test(token)) {
        if (phone) f.soft.net.add(token);
        else if (token !== "2g" && token !== "3g") f.variant.add("cellular");
        else f.hard.add(token);
      }
      else if (/^[248]k$/.test(token)) f.soft.res.add(token);
      else if (!UNIT_TOKEN.test(token) && (CODE_TOKEN.test(token) ? token.length >= 5 : DOTTED_CODE_TOKEN.test(token) && token.replace(/\D/g, "").length >= 4)) f.soft.code.add(token);
      else f.hard.add(token);
      continue;
    }
    if (brand.has(token) || FILLER.has(token)) continue;
    if (COLOUR_MODIFIER.has(token)) {
      const next = tokens.slice(at + 1).find((later) => !COLOUR_MODIFIER.has(later));
      if (next && (COLOUR[next] || gluedColour(next))) {
        kinds[at] = "colour";
        continue;
      }
    }
    const glued = COLOUR[token] ? null : gluedColour(token);
    if (token === "lte") f.variant.add("cellular");
    // Single letters name variants: Xbox Series X vs S.
    else if (VARIANT.has(token) || token.length === 1) f.variant.add(token);
    else if (COLOUR[token]) {
      f.colour.add(COLOUR[token]);
      kinds[at] = "colour";
    }
    else if (glued) {
      if (glued.variant) f.variant.add(glued.variant);
      for (const colour of glued.colours) f.colour.add(colour);
      kinds[at] = "colour";
    }
    else if (MATERIAL[token]) f.material.add(MATERIAL[token]);
    else if (ACCESSORY_WORDS.has(token)) f.accessory.add(token);
    else {
      const stem = ACCESSORY_STEMS.find((s) => token.includes(s));
      if (stem) f.accessory.add(stem);
      else {
        f.words.add(token);
        kinds[at] = "word";
      }
    }
  }
  // PriceRunner names a colour the way the maker markets it: "Silver Shadow", "Black Eclipse", "Whitestone/Tidal
  // Blue", "Aqua/Black". Unknown words right after a colour word (up to two) or joined to one by "/" are kept as
  // possible parts of the colour name; matchNames ignores them when the other name lacks them. A word before a
  // colour is not: it names the product as often as the shade ("Earbuds White Smoke", "Era 100 SL Svart", "Tray
  // Black", "Tomorrowland Black Edition"). A digit, filler, variant, accessory or material word ends the run.
  const touching = (at: number) => kinds[at] === "word" && !NOT_SHADE.has(tokens[at]);
  for (const [at, kind] of kinds.entries()) {
    if (kind !== "colour") continue;
    if (at > 0 && touching(at - 1) && /^\s*\/\s*$/.test(gaps[at])) f.shade.add(tokens[at - 1]);
    for (let next = at + 1; next <= at + 2 && touching(next); next++) {
      if (gaps[next].includes("/")) {
        if (next === at + 1) f.shade.add(tokens[next]);
        break;
      }
      if (!/^\s*$/.test(gaps[next])) break;
      f.shade.add(tokens[next]);
    }
  }
  return f;
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Model codes agree when equal or one extends the other by a regional suffix of two to six characters
 * (QE65QN90D, QE65QN90DAT; ECAM22.112, ECAM22.112.B). A one-letter suffix often names another configuration
 * (Makita DHP485Z = body only), a longer one is a second product's code glued on (the washer + dryer bundle
 * WGK264ZLSN-WQK2420LSN).
 */
function codesAgree(a: Set<string>, b: Set<string>): boolean {
  const suffix = (long: string, short: string) => long.startsWith(short) && long.length - short.length >= 2 && long.length - short.length <= 6;
  const same = (x: string, y: string) => x === y || suffix(x, y) || suffix(y, x);
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
  // Stated on both sites: the first word (Sony PlayStation = Sony) or the whole brand spelt together (De'Longhi = DeLonghi).
  if (ba.length && bb.length) return ba[0] === bb[0] || ba.join("") === bb.join("");
  // One site knows the brand: the other's name must start with it ("Eazy Case for Apple ..." is not Apple's).
  const known = ba.length ? ba : bb;
  if (!known.length) return true;
  const other = ba.length ? b : a;
  return fold(other.name).split(/[^a-z0-9]+/).filter(Boolean)[0] === known[0];
}

const MIN_WORD_OVERLAP = 0.75;
/** Lowest new prices further apart than this are not the same product, even under one model code (a site may list a single dear store). */
const MAX_PRICE_RATIO = 4;
/**
 * The limit when no full model code ties the names. Of 70 priced two-site rows over 48 searches 67 were within
 * 2x; the two code-less rows above it paired different products (a mouse with its Bluetooth edition, two
 * capsule machines of one line).
 */
const MAX_UNCODED_PRICE_RATIO = 2;

/**
 * Whether two listings (normally one per site) are the same product: "name" when brand, model
 * numbers, capacities, sizes, variant words, colours and materials agree and the remaining words
 * mostly overlap, else null. Errs towards null. ("gtin" is never returned here: that tie comes from
 * the caller, see MergeOptions.ties.)
 */
export function matchProducts(a: ProductHit, b: ProductHit): MatchKind {
  return matchNames(a, b, false);
}

/**
 * Variant words (Ultra, Pro, Plus, FE, a single letter...) in a listing's name that the query doesn't have.
 * A plain name given to compare ("Galaxy S25 256GB") must not settle on the S25 Ultra while a plain S25 is listed.
 */
export function extraVariants(query: string, name: string, brand: string | null = null): string[] {
  const stated = new Set(brandTokens(brand));
  const phone = PHONE_NAME.test(fold(name));
  const asked = features(query, stated, phone).variant;
  const found = features(name, stated, phone).variant;
  // Premium tiers always have noise cancelling (as in matchNames), so "ANC" on a Pro or Max is nothing extra.
  if (found.has("pro") || found.has("max")) found.delete("anc");
  return [...found].filter((word) => !asked.has(word));
}

/** matchProducts; with `anyColour` the colours are not compared, which ties one site's colour listings of a product together. */
function matchNames(a: ProductHit, b: ProductHit, anyColour: boolean): MatchKind {
  if (!brandsAgree(a, b)) return null;
  if (a.category && b.category && ACCESSORY_CATEGORY.test(fold(a.category)) !== ACCESSORY_CATEGORY.test(fold(b.category))) return null;
  const priceRatio = a.lowest_price && b.lowest_price ? Math.max(a.lowest_price, b.lowest_price) / Math.min(a.lowest_price, b.lowest_price) : 1;
  if (priceRatio > MAX_PRICE_RATIO) return null;

  // Both spellings of each brand, so "DeLonghi" drops from one name and "De" "Longhi" from the other.
  const brand = new Set([a.brand, b.brand].flatMap((stated) => [...brandTokens(stated), brandTokens(stated).join("")]));
  const phone = [a, b].some((hit) => (hit.category !== null && PHONE_CATEGORY.test(fold(hit.category))) || PHONE_NAME.test(fold(hit.name)));
  const fa = features(a.name, brand, phone);
  const fb = features(b.name, brand, phone);
  // Premium tiers always have noise cancelling, so one site's "ANC" doesn't split AirPods Pro 3 (AirPods 4 vs AirPods 4 ANC still split).
  const premium = (f: Features) => f.variant.has("pro") || f.variant.has("max");
  if (premium(fa) && premium(fb)) for (const f of [fa, fb]) f.variant.delete("anc");
  // The same full model code on both sides (OLED65C44LA) already fixes size and panel, so a name that also spells
  // them out ("65\" (163 cm) OLED C4") is not a different product.
  const sameCode = fa.soft.code.size > 0 && fb.soft.code.size > 0 && codesAgree(fa.soft.code, fb.soft.code);
  if (!sameCode && priceRatio > MAX_UNCODED_PRICE_RATIO) return null;
  if (sameCode) {
    const codes = [...fa.soft.code, ...fb.soft.code];
    const inCode = (token: string) => codes.some((code) => code.includes(token));
    for (const f of [fa, fb]) {
      for (const token of f.hard) if (inCode(token) || /^\d+(?:\.\d+)?cm$/.test(token)) f.hard.delete(token);
      for (const token of f.variant) if (DISPLAY_TECH.has(token) || inCode(token)) f.variant.delete(token);
    }
  }
  // One site writes Bosch's "Serie 6" in English, "Series 6", which reads as a bare number (Apple Watch Series 10 has to).
  for (const [f, other] of [[fa, fb], [fb, fa]]) {
    if (f.soft.series.size) continue;
    for (const token of f.hard) if (other.soft.series.has(`${token}series`)) f.hard.delete(token);
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
  if (!anyColour && fa.colour.size && fb.colour.size && !sameSet(fa.colour, fb.colour)) return null;
  if (fa.material.size && fb.material.size && !sameSet(fa.material, fb.material)) return null;
  // The same full model code on both sides settles it whatever the marketing words.
  if (sameCode) return "name";
  // Something concrete must tie them: a shared model number/capacity, or identical wording.
  const shared = fa.capacity.size > 0 || [...fa.hard, ...fa.soft.code].some((t) => fb.hard.has(t) || fb.soft.code.has(t));
  // A word that only one name has and that touches its colour is part of the colour name (Galaxy S25 "Silver Shadow").
  const [wa, wb] = [[fa, fb], [fb, fa]].map(([f, other]) => new Set([...f.words].filter((word) => !f.shade.has(word) || other.words.has(word))));
  const overlap = jaccard(wa, wb);
  if (!shared && (overlap < 1 || wa.size === 0)) return null;
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

export interface MergeOptions {
  /** The query searched for: when it names a colour, a PriceRunner listing in that colour is preferred as the counterpart. */
  query?: string;
  /** Listings known to be the same product by GTIN, as each site's ProductHit.id. They pair before name matching and get match "gtin". */
  ties?: { prisjakt: string; pricerunner: string }[];
}

/**
 * Merges each site's search hits into one list. A Prisjakt listing pairs with one PriceRunner listing:
 * first the GTIN ties in `options.ties` (match "gtin"), then what matchProducts ties among the rest
 * (match "name"). PriceRunner's other colours of a paired product fold into the pair instead of
 * getting rows: Prisjakt's listing covers every colour, so the fair PriceRunner side is its cheapest
 * colour (or the colour the query names), and four colour rows of one phone push other models off an
 * 8-row page. Ordered by best position in either list, counting folded listings; at equal position a
 * two-site product goes first.
 */
export function mergeHits(lists: Partial<Record<SourceId, ProductHit[]>>, options: MergeOptions = {}): MergedProduct[] {
  const pj = lists.prisjakt ?? [];
  const pr = lists.pricerunner ?? [];
  const pairOfPj = new Map<number, { j: number; kind: Exclude<MatchKind, null> }>();
  const usedPr = new Set<number>();
  for (const tie of options.ties ?? []) {
    const i = pj.findIndex((hit) => hit.id === tie.prisjakt);
    const j = pr.findIndex((hit) => hit.id === tie.pricerunner);
    if (i === -1 || j === -1 || pairOfPj.has(i) || usedPr.has(j)) continue;
    pairOfPj.set(i, { j, kind: "gtin" });
    usedPr.add(j);
  }

  const pairs: { i: number; j: number; kind: Exclude<MatchKind, null> }[] = [];
  pj.forEach((a, i) => {
    if (pairOfPj.has(i)) return;
    pr.forEach((b, j) => {
      if (usedPr.has(j)) return;
      const kind = matchProducts(a, b);
      if (kind) pairs.push({ i, j, kind });
    });
  });
  pairs.sort((x, y) => x.i + x.j - (y.i + y.j) || x.i - y.i);
  for (const { i, j, kind } of pairs) {
    if (pairOfPj.has(i) || usedPr.has(j)) continue;
    pairOfPj.set(i, { j, kind });
    usedPr.add(j);
  }

  // PriceRunner lists each colour of a model, Prisjakt names it once: a left-over PriceRunner listing that matches
  // the Prisjakt side, or is the paired PriceRunner listing in another colour, joins that pair's group. The second
  // way also needs the Prisjakt side to agree apart from colour: a PriceRunner name without the model code
  // ("De'Longhi Magnifica Evo") would otherwise gather every coded model of the line (ECAM290.61.B, ECAM290.81.TB).
  const group = new Map([...pairOfPj].map(([i, { j }]) => [i, [j]]));
  pr.forEach((b, k) => {
    if (usedPr.has(k)) return;
    const owner = [...pairOfPj].find(([i, { j }]) => matchProducts(pj[i], b) || (matchNames(pr[j], b, true) && matchNames(pj[i], b, true)));
    if (!owner) return;
    group.get(owner[0])?.push(k);
    usedPr.add(k);
  });

  const wanted = options.query ? features(options.query, new Set(), false).colour : new Set<string>();
  const rows: { rank: number; both: boolean; order: number; product: MergedProduct }[] = [];
  pj.forEach((a, i) => {
    const pair = pairOfPj.get(i);
    if (!pair) {
      rows.push({ rank: i, both: false, order: rows.length, product: mergedProduct([a], null) });
      return;
    }
    const members = group.get(i) ?? [pair.j];
    // The colour the query asks for when PriceRunner lists it, else the cheapest colour (the first paired on equal or unknown price).
    const inColour = members.filter((k) => [...features(pr[k].name, new Set(), false).colour].some((colour) => wanted.has(colour)));
    const pool = inColour.length ? inColour : members;
    const counterpart = pool.reduce((best, k) => {
      const [price, bestPrice] = [pr[k].lowest_price, pr[best].lowest_price];
      return price !== null && (bestPrice === null || price < bestPrice) ? k : best;
    });
    rows.push({ rank: Math.min(i, ...members), both: true, order: rows.length, product: mergedProduct([a, pr[counterpart]], pair.kind) });
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
