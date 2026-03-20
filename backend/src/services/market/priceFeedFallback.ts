/**
 * priceFeedFallback.ts — Multi-source price feed redundancy
 *
 * Provides price fallbacks for when the primary Binance WebSocket feed is stale
 * or disconnected.  Sources are tried in order:
 *
 *   1. Binance Futures REST  — same exchange, different mechanism (fast, ~50ms)
 *   2. Bybit Linear REST     — independent exchange (true redundancy, ~80ms)
 *
 * Why no Chainlink on-chain oracle?
 *   Chainlink Arbitrum feeds only cover major assets (ETH, BTC, LINK, USDC).
 *   This bot trades a wide variety of USDT perpetuals (TAO, PEPE, INJ, WIF, etc.)
 *   that have no Chainlink feed.  REST aggregation across two independent exchanges
 *   provides universal coverage with comparable latency.
 *
 * Usage:
 *   // Use in place of getLatestPrice() when WS staleness is a concern:
 *   const price = getLatestPrice(symbol) ?? await getFallbackPrice(symbol);
 *
 * Caching:
 *   Results are cached for CACHE_TTL_MS (800ms) to prevent hammering REST APIs
 *   when the price is polled every 50ms by the fast exit monitor.
 */

import { log } from "../../logger.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS     = 800;    // cache REST result for 800ms
const FETCH_TIMEOUT_MS = 3_000;  // abort REST call after 3s

// ── Types ─────────────────────────────────────────────────────────────────────

type PriceCacheEntry = {
  price:  number;
  ts:     number;
  source: "binance-rest" | "bybit-rest";
};

// ── Cache ─────────────────────────────────────────────────────────────────────

const fallbackCache = new Map<string, PriceCacheEntry>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch with a timeout so a slow exchange doesn't stall the exit monitor. */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Source implementations ────────────────────────────────────────────────────

/**
 * Binance USD-M Futures REST price.
 * Endpoint: GET https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT
 * Returns: { "symbol": "BTCUSDT", "price": "67234.50", "time": 1234567890 }
 */
async function fetchBinanceRestPrice(symbol: string): Promise<number | null> {
  try {
    const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`;
    const res  = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const price = Number(data?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Bybit Linear Perpetual REST price.
 * Endpoint: GET https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT
 * Returns the last traded price for the symbol (Bybit uses same USDT perp symbol names).
 */
async function fetchBybitRestPrice(symbol: string): Promise<number | null> {
  try {
    const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;
    const res  = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await res.json() as any;
    // Bybit v5: { result: { list: [{ symbol, lastPrice, ... }] } }
    const ticker = data?.result?.list?.[0];
    const price  = Number(ticker?.lastPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get a fallback price for the given symbol from alternative REST sources.
 *
 * Call this when `getLatestPrice(symbol)` returns null (WS stale/disconnected).
 * Results are cached for CACHE_TTL_MS to avoid REST hammering during 50ms polls.
 *
 * @returns Price in USD, or null if all sources fail.
 */
export async function getFallbackPrice(symbol: string): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const now = Date.now();

  // ── Cache hit ──────────────────────────────────────────────────────────────
  const cached = fallbackCache.get(sym);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.price;
  }

  // ── Source 1: Binance Futures REST ────────────────────────────────────────
  const binancePrice = await fetchBinanceRestPrice(sym);
  if (binancePrice !== null) {
    fallbackCache.set(sym, { price: binancePrice, ts: now, source: "binance-rest" });
    log.debug({ symbol: sym, price: binancePrice, source: "binance-rest" },
      "[priceFeedFallback] price fetched from Binance REST fallback");
    return binancePrice;
  }

  // ── Source 2: Bybit Linear REST ───────────────────────────────────────────
  const bybitPrice = await fetchBybitRestPrice(sym);
  if (bybitPrice !== null) {
    fallbackCache.set(sym, { price: bybitPrice, ts: now, source: "bybit-rest" });
    log.warn({ symbol: sym, price: bybitPrice, source: "bybit-rest" },
      "[priceFeedFallback] Binance REST failed — price fetched from Bybit fallback");
    return bybitPrice;
  }

  // ── All sources failed ─────────────────────────────────────────────────────
  log.warn({ symbol: sym }, "[priceFeedFallback] all price sources failed");
  return null;
}

/**
 * Clear the fallback price cache for a symbol (or all symbols if omitted).
 * Useful for testing or when the WS reconnects and we want fresh data.
 */
export function clearFallbackCache(symbol?: string): void {
  if (symbol) {
    fallbackCache.delete(symbol.toUpperCase());
  } else {
    fallbackCache.clear();
  }
}

/**
 * Check whether the fallback cache has a fresh entry for the given symbol.
 * Useful to determine whether the WS or a REST source is being used.
 */
export function getFallbackCacheInfo(symbol: string): PriceCacheEntry | null {
  const sym = symbol.toUpperCase();
  const entry = fallbackCache.get(sym);
  if (!entry || Date.now() - entry.ts >= CACHE_TTL_MS) return null;
  return entry;
}
