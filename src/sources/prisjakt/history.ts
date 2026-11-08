// Prisjakt's price history (POST /api/price-history, the product page's chart) → PriceHistory.
// The API returns change points of the lowest price (shipping excluded), in öre, timestamped at
// local midnight in UTC. It mixes in graded used and refurbished offers, which are dropped here so the
// series is the lowest new-condition price. We expand it to a daily step series and summarise.

import type { PriceHistory, PricePoint } from "../../types.js";
import { secondhandCondition } from "../condition.js";
import { postJson } from "./http.js";

const MAX_POINTS = 60;
const DAY_MS = 86_400_000;
/** Change points a year or more apart with a 3x price jump between them belong to an older product that had the same id. */
const REUSE_GAP_DAYS = 365;
const REUSE_PRICE_RATIO = 3;

interface HistoryItem {
  date?: string;
  price?: number;
  /** The store's listing title, e.g. "... 128GB | Rosa | Grade A+". */
  name?: string | null;
  shopName?: string | null;
}

interface HistoryResponse {
  priceHistory?: {
    historyItems?: (HistoryItem | null)[] | null;
    newestHistoryItem?: string | null;
  } | null;
}

const stockholmDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD in Swedish local time. */
function localDay(instant: string | number): string {
  return stockholmDate.format(new Date(instant));
}

function dayIndex(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

function dayString(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

function minOf(points: PricePoint[]): PricePoint | null {
  let best: PricePoint | null = null;
  for (const point of points) if (!best || point.price < best.price) best = point;
  return best;
}

/** Lowest point of each of at most MAX_POINTS - 1 equal buckets (dips survive), then the latest day (current price). */
function downsample(daily: PricePoint[]): PricePoint[] {
  if (daily.length <= MAX_POINTS) return daily;
  const body = daily.slice(0, -1);
  const buckets = MAX_POINTS - 1;
  const out: PricePoint[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const low = minOf(body.slice(Math.floor((bucket * body.length) / buckets), Math.floor(((bucket + 1) * body.length) / buckets)));
    if (low) out.push(low);
  }
  out.push(daily[daily.length - 1]);
  return out;
}

export async function priceHistory(productId: number): Promise<PriceHistory | null> {
  const body = (await postJson("/api/price-history", { productId, timeRange: "ALL", shopIds: [], variantIds: [] })) as HistoryResponse | null;
  const items = body?.priceHistory?.historyItems;
  if (!Array.isArray(items) || items.length === 0) return null;

  // One change point per local day (the last one that day wins), prices in SEK. A second-hand item
  // is skipped: the new price before it is the best known new price until the next change point.
  const changes = new Map<number, number>();
  for (const item of items) {
    if (typeof item?.price !== "number" || typeof item.date !== "string" || Number.isNaN(Date.parse(item.date))) continue;
    if (secondhandCondition(item.name, item.shopName)) continue;
    changes.set(dayIndex(localDay(item.date)), Math.round(item.price) / 100);
  }
  if (changes.size === 0) return null;
  let days = [...changes.keys()].sort((a, b) => a - b);

  // A one-day price more than 50% below the days around it is a listing error (a CDON row at a third
  // of the price for one day), not a price anyone could buy at.
  const glitches = days.filter((day, i) => {
    if (i === 0 || i === days.length - 1 || days[i + 1] !== day + 1) return false;
    const price = changes.get(day)!;
    return price < changes.get(days[i - 1])! * 0.5 && price < changes.get(days[i + 1])! * 0.5;
  });
  for (const day of glitches) changes.delete(day);
  days = days.filter((day) => changes.has(day));

  // Prisjakt sometimes reuses a product id: the PS5 Slim's series has 219 kr from 2015, then nothing
  // until 2023 at 10 706 kr. Keep only what follows the last such break. Rising prices alone (RAM
  // tripled in a year) are real history and stay.
  const reuse = days.findLastIndex((day, i) => {
    if (i === 0 || day - days[i - 1] < REUSE_GAP_DAYS) return false;
    const before = changes.get(days[i - 1])!;
    const after = changes.get(day)!;
    return Math.max(before, after) >= REUSE_PRICE_RATIO * Math.min(before, after);
  });
  if (reuse > 0) days = days.slice(reuse);

  // The last price holds until the series was last refreshed (not beyond today).
  const today = dayIndex(localDay(Date.now()));
  const refreshed = body?.priceHistory?.newestHistoryItem;
  const lastDay = Math.max(days[days.length - 1], Math.min(today, refreshed ? dayIndex(localDay(refreshed)) : today));

  const daily: PricePoint[] = [];
  let price = changes.get(days[0])!;
  for (let day = days[0]; day <= lastDay; day++) {
    price = changes.get(day) ?? price;
    daily.push({ date: dayString(day), price });
  }

  const since = (n: number) => {
    const from = dayString(today - n + 1);
    return minOf(daily.filter((point) => point.date >= from))?.price ?? null;
  };

  return {
    source: "prisjakt",
    lowest_30d: since(30),
    lowest_90d: since(90),
    lowest_ever: minOf(daily),
    points: downsample(daily),
  };
}
