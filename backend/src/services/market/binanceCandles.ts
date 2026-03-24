// src/services/market/binanceCandles.ts
// USDⓈ-M Futures (perp) market data: https://fapi.binance.com
// Klines: GET /fapi/v1/klines
// ExchangeInfo: GET /fapi/v1/exchangeInfo

import { acquireCandleToken } from "./candleRateLimiter.js";

type BinanceKline = [
  number, string, string, string, string, string,
  number, string, number, string, string, string
];

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function isRetryable(err: any) {
  const msg = String(err?.message ?? err);
  return (
    err?.name === "AbortError" ||
    msg.includes("AbortError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("fetch failed")
  );
}

async function fetchWithTimeout(
  url: string,
  opts?: {
    timeoutMs?: number;
    retries?: number;
    backoffBaseMs?: number;
    headers?: Record<string, string>;
    init?: RequestInit;
  }
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const retries = opts?.retries ?? 3;
  const backoffBaseMs = opts?.backoffBaseMs ?? 350;

  // Optional API key header (not required for public endpoints, but future-proof)
  const apiKey = (process.env.BINANCE_API_KEY ?? "").trim();

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(apiKey ? { "X-MBX-APIKEY": apiKey } : {}),
    ...(opts?.headers ?? {}),
    ...(opts?.init?.headers ? (opts.init.headers as Record<string, string>) : {}),
  };

  let lastErr: any = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...(opts?.init ?? {}),
        signal: ac.signal,
        headers,
      });

      // Let callers handle !ok so they can include response body if desired
      return res;
    } catch (e: any) {
      lastErr = e;
      if (attempt === retries || !isRetryable(e)) break;

      // exponential backoff
      await sleep(backoffBaseMs * Math.pow(2, attempt));
    } finally {
      clearTimeout(t);
    }
  }

  throw lastErr;
}

const FAPI_BASE = (process.env.BINANCE_FAPI_BASE ?? "https://fapi.binance.com").replace(/\/+$/, "");

// Simple in-memory cache for exchangeInfo symbols
let cachedSymbols: Set<string> | null = null;
let cachedAt = 0;
const EXCHANGEINFO_TTL_MS = 10 * 60 * 1000;

export async function getUsdmFuturesSymbols(args?: {
  timeoutMs?: number;
  retries?: number;
  force?: boolean;
}): Promise<Set<string>> {
  const timeoutMs = args?.timeoutMs ?? 20_000; // exchangeInfo can be slow
  const retries = args?.retries ?? 4;
  const force = args?.force ?? false;

  const now = Date.now();
  if (!force && cachedSymbols && (now - cachedAt) < EXCHANGEINFO_TTL_MS) {
    return cachedSymbols;
  }

  const url = `${FAPI_BASE}/fapi/v1/exchangeInfo`;

  const res = await fetchWithTimeout(url, {
    timeoutMs,
    retries,
    backoffBaseMs: 400,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 451 = geo-restricted location — skip validation, accept all symbols
    if (res.status === 451) {
      cachedSymbols = new Set(["__GEO_BYPASS__"]);
      cachedAt = now;
      return cachedSymbols;
    }
    throw new Error(`Binance FAPI exchangeInfo HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { symbols?: Array<{ symbol: string; status?: string }> };
  const set = new Set<string>();

  for (const s of data.symbols ?? []) {
    // Keep only actively trading symbols
    if (s?.symbol && (!s.status || s.status === "TRADING")) set.add(s.symbol);
  }

  cachedSymbols = set;
  cachedAt = now;
  return set;
}

export async function assertUsdmSymbol(symbol: string) {
  const set = await getUsdmFuturesSymbols();
  // "__GEO_BYPASS__" sentinel means exchangeInfo is geo-restricted — skip validation
  if (set.has("__GEO_BYPASS__")) return;
  if (!set.has(symbol)) throw new Error(`Symbol not found on USD-M Futures: ${symbol}`);
}

export type BinanceClosesResult =
  | number[]
  | { closes: number[]; closeTimesMs: number[] };

export type BinanceOHLCV = {
  opens:        number[];
  highs:        number[];
  lows:         number[];
  closes:       number[];
  volumes:      number[];
  closeTimesMs: number[];
};

// ── Shared candle cache ────────────────────────────────────────────────────────
//
// With 10+ users scanning BTC/ETH every 10s, each user would independently call
// Binance REST for the same candle data. This cache deduplicates those calls:
// the first request fetches from Binance and caches the result; subsequent
// requests within the same minute window return the cached data instantly.
//
// Key: `${symbol}:${interval}:${limit}:${minuteBucket}`
//   - minuteBucket = floor(now / 60_000): changes once per minute, auto-invalidates
//   - limit is included so different callers don't share mismatched data
// TTL: 65s — 60s minute boundary + 5s grace for slow workers near the edge.
//
// Pruning: stale entries are removed on every write to prevent unbounded growth.

type CandleEntry = { data: BinanceOHLCV; fetchedAt: number };

const _candleCache  = new Map<string, CandleEntry>();
const CANDLE_TTL_MS = 65_000;

function _candleKey(symbol: string, interval: string, limit: number): string {
  const bucket = Math.floor(Date.now() / 60_000);
  return `${symbol}:${interval}:${limit}:${bucket}`;
}

function _getCandle(symbol: string, interval: string, limit: number): BinanceOHLCV | null {
  const entry = _candleCache.get(_candleKey(symbol, interval, limit));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CANDLE_TTL_MS) {
    _candleCache.delete(_candleKey(symbol, interval, limit));
    return null;
  }
  return entry.data;
}

function _setCandle(symbol: string, interval: string, limit: number, data: BinanceOHLCV): void {
  // Prune stale entries before inserting to prevent unbounded growth
  const now = Date.now();
  for (const [k, v] of _candleCache) {
    if (now - v.fetchedAt > CANDLE_TTL_MS) _candleCache.delete(k);
  }
  _candleCache.set(_candleKey(symbol, interval, limit), { data, fetchedAt: now });
}

/** Expose cache stats for health/debug endpoint. */
export function getCandleCacheStats(): { size: number; keys: string[] } {
  return { size: _candleCache.size, keys: Array.from(_candleCache.keys()) };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function fetchBinanceOHLCV(args: {
  symbol:          string;
  interval:        string;
  limit?:          number;
  retries?:        number;
  timeoutMs?:      number;
  validateSymbol?: boolean;
  bypassCache?:    boolean;
}): Promise<BinanceOHLCV> {
  const {
    symbol,
    interval,
    limit         = 300,
    retries       = 3,
    timeoutMs     = 12_000,
    validateSymbol = true,
    bypassCache    = false,
  } = args;

  // ── Shared candle cache hit ──────────────────────────────────────────────
  if (!bypassCache) {
    const cached = _getCandle(symbol, interval, limit);
    if (cached) return cached;
  }

  if (validateSymbol) await assertUsdmSymbol(symbol);

  const url =
    `${FAPI_BASE}/fapi/v1/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&limit=${limit}`;

  // Acquire rate limiter token before real network call
  await acquireCandleToken();
  const res = await fetchWithTimeout(url, { timeoutMs, retries, backoffBaseMs: 250 });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance FAPI klines HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as BinanceKline[];
  if (data.length === 0) throw new Error("No klines returned");

  const opens        = data.map((k) => Number(k[1]));
  const highs        = data.map((k) => Number(k[2]));
  const lows         = data.map((k) => Number(k[3]));
  const closes       = data.map((k) => Number(k[4]));
  const volumes      = data.map((k) => Number(k[5]));
  const closeTimesMs = data.map((k) => Number(k[6]));

  if (closes.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error("Invalid close values from Binance");
  if (volumes.some((x) => !Number.isFinite(x) || x < 0))  throw new Error("Invalid volume values from Binance");

  const result: BinanceOHLCV = { opens, highs, lows, closes, volumes, closeTimesMs };

  // ── Populate cache ───────────────────────────────────────────────────────
  if (!bypassCache) _setCandle(symbol, interval, limit, result);

  return result;
}

export async function fetchBinanceCloses(args: {
  symbol:          string;
  interval:        string;
  limit?:          number;
  retries?:        number;
  timeoutMs?:      number;
  validateSymbol?: boolean;
  withTimestamps?: boolean;
  bypassCache?:    boolean;
}): Promise<BinanceClosesResult> {
  const {
    symbol,
    interval,
    limit          = 300,
    retries        = 3,
    timeoutMs      = 12_000,
    validateSymbol = true,
    withTimestamps = false,
    bypassCache    = false,
  } = args;

  // Delegate to fetchBinanceOHLCV so both functions share the same candle cache.
  // This eliminates the duplicate Binance REST call that previously existed when
  // a single scan tick called both fetchBinanceOHLCV (for OHLCV) and
  // fetchBinanceCloses (for closes-only) on the same symbol+interval.
  const ohlcv = await fetchBinanceOHLCV({
    symbol, interval, limit, retries, timeoutMs, validateSymbol, bypassCache,
  });

  if (!withTimestamps) return ohlcv.closes;
  return { closes: ohlcv.closes, closeTimesMs: ohlcv.closeTimesMs };
}
