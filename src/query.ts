// Query clean-up for search: the sites match Swedish/English words only, Prisjakt wants every word of
// the query in a product, and tyre sizes are written "205/55 R16" in the sites' product names.

/** A letter of a script other than Latin (Cyrillic, Greek, CJK, Arabic, …): the sites match Swedish and English words only. */
export const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

export const LANGUAGE_ERROR =
  "Prisjakt and PriceRunner are Swedish: write the query in Swedish or English (стиральная машина → tvättmaskin, наушники → hörlurar), brand and model in Latin letters.";

/** "205/55r16", "205/55-R16", "205/55 r 16" → "205/55 R16", as the sites' product names write it. */
export function normalizeTyreSizes(query: string): string {
  return query.replace(/\b(\d{3})\s*\/\s*(\d{2})\s*-?\s*[rR]\s*(\d{2})\b/g, "$1/$2 R$3");
}

/**
 * Price phrases belong in min_price/max_price: a limit word before a number ("under 1000", "max 2 000 kr")
 * or a 3+ digit amount with a currency ("1500 kr", "1500:-"; "iphone 16 kr" keeps its 16).
 */
const PRICE_LIMIT = /(?<=^|\s)(?:under|över|upp till|max|min|högst|minst|från|below|above|over|up to|less than|more than|from)\s+\d+(?: \d{3})*(?:\s*(?:kr|sek|kronor|:-))?(?=\s|$)/giu;
const PRICE_AMOUNT = /(?<=^|\s)\d{3,}(?: \d{3})*\s*(?:kr|sek|kronor|:-)(?=\s|$)/giu;
/** Sizes such as "60 cm" are rarely in product names, and number words must be in the name to match. */
const DIMENSION = /(?<=^|\s)\d+(?:[.,]\d+)?\s*(?:cm|mm)(?=\s|$)/giu;

/** Multi-word intent phrases, removed before single words. */
const INTENT_PHRASES = ["i lager", "in stock", "black friday", "cyber monday", "second hand", "i sverige", "in sweden", "best price", "lowest price", "lägsta pris", "bästa pris"];

/** Intent and filler words (contract rule 3): shopping intent, price words, condition, time and place fillers. */
const INTENT_WORDS: readonly string[] = [
  "billig", "billiga", "billigt", "billigare", "billigast", "billigaste",
  "cheap", "cheaper", "cheapest",
  "köp", "köpa", "köper", "buy", "buying",
  "pris", "priser", "priset", "prisjämförelse", "jämför", "price", "prices", "pricing", "compare",
  "bästa", "bäst", "best", "top",
  "deal", "deals", "rea", "reat", "erbjudande", "erbjudanden", "kampanj", "rabatt", "sale", "discount", "offer", "offers",
  "begagnad", "begagnade", "begagnat", "beg", "used", "secondhand",
  "ny", "nya", "nytt", "new",
  "kr", "sek", "kronor",
  "nu", "now", "idag", "today", "online", "lager",
];

/**
 * The query without intent/filler words, price phrases and sizes in cm/mm, or null when nothing would
 * change or nothing would remain. Used only to retry a site that found nothing for the query as written.
 */
export function stripIntentWords(query: string): string | null {
  let text = ` ${query.replace(PRICE_LIMIT, " ").replace(PRICE_AMOUNT, " ").replace(DIMENSION, " ")} `;
  for (const phrase of INTENT_PHRASES) text = text.replace(new RegExp(`\\s${phrase}(?=\\s)`, "giu"), " ");
  const kept = text
    .split(/\s+/)
    .filter((word) => word && !INTENT_WORDS.includes(word.toLowerCase().replace(/[!?.,:;]+$/, "")))
    .join(" ");
  return kept && kept !== query.trim().replace(/\s+/g, " ") ? kept : null;
}
