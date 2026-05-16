// Prisjakt's price history (POST /api/price-history, the product page's chart) → PriceHistory.
// The API returns change points of the lowest new-condition price (shipping excluded), in öre,
// timestamped at local midnight in UTC. We expand them to a daily step series and summarise.

import type { PriceHistory, PricePoint } from "../../types.js";
import { postJson } from "./http.js";

const MAX_POINTS = 60;
const DAY_MS = 86_400_000;

interface HistoryItem {
  date: string;
  price: number;
}

interface HistoryResponse {
  priceHistory?: {
    historyItems?: HistoryItem[];
    newestHistoryItem?: string | null;
  };
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
  const body = (await postJson("/api/price-history", { productId, timeRange: "ALL", shopIds: [], variantIds: [] })) as HistoryResponse;
  const items = body.priceHistory?.historyItems ?? [];
  if (items.length === 0) return null;

  // One change point per local day (the last one that day wins), prices in SEK.
  const changes = new Map<number, number>();
  for (const item of items) {
    if (typeof item.price !== "number" || typeof item.date !== "string") continue;
    changes.set(dayIndex(localDay(item.date)), Math.round(item.price) / 100);
  }
  if (changes.size === 0) return null;
  const days = [...changes.keys()].sort((a, b) => a - b);

  // The last price holds until the series was last refreshed (not beyond today).
  const today = dayIndex(localDay(Date.now()));
  const refreshed = body.priceHistory?.newestHistoryItem;
  const lastDay = Math.max(days[days.length - 1], Math.min(today, refreshed ? dayIndex(localDay(refreshed)) : today));

  let daily: PricePoint[] = [];
  let price = changes.get(days[0])!;
  for (let day = days[0]; day <= lastDay; day++) {
    price = changes.get(day) ?? price;
    daily.push({ date: dayString(day), price });
  }

  const since = (n: number) => {
    const from = dayString(today - n + 1);
    return minOf(daily.filter((point) => point.date >= from))?.price ?? null;
  };

  // Prisjakt sometimes reuses a product id: the PS5 Slim's series starts with years at 219 kr.
  // Drop everything up to the last day priced under 30% of the recent low, if that day is older than 90 days.
  const recent = since(90) ?? daily[daily.length - 1].price;
  const cutoff = dayString(today - 90);
  const lastImplausible = daily.findLastIndex((point) => point.price < recent * 0.3);
  if (lastImplausible >= 0 && daily[lastImplausible].date < cutoff) daily = daily.slice(lastImplausible + 1);
  if (daily.length === 0) return null;

  return {
    source: "prisjakt",
    lowest_30d: since(30),
    lowest_90d: since(90),
    lowest_ever: minOf(daily),
    points: downsample(daily),
  };
}
