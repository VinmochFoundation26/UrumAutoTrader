/**
 * tradeCache.ts — Redis-backed persistence for critical bot state
 *
 * Persists:
 *   1. activeTrades   — open position tracking (entry, size, bestPrice, trailing stop)
 *   2. trendRegime    — 1h EMA regime direction per symbol
 *   3. eventHistory   — last 500 bot events (survives restarts)
 *
 * Redis Key Schema:
 *   trade:{userKey}:{symbol}      → JSON(ActiveTrade)         [no TTL, manually deleted on close]
 *   regime:{userKey}:{symbol}     → JSON({dir, updatedAt})    [no TTL]
 *   botEvents                     → Redis LIST, LTRIM 500      [ring buffer]
 *   perf:{userKey}                → Redis LIST, LTRIM 2000     [closed trade history]
 *
 * Cooldown keys (already handled in botWorker via getCooldownUntilMs / setCooldown):
 *   cooldown:{userAddr}:{symbol}  → timestamp string [TTL set by botWorker]
 */

import type { Redis } from "ioredis";
import { log } from "../../logger.js";

// ── Key helpers ──────────────────────────────────────────────────────────────

const TRADE_KEY   = (u: string, s: string) => `trade:${u}:${s}`;
const REGIME_KEY  = (u: string, s: string) => `regime:${u}:${s}`;
const EVENTS_KEY  = "botEvents";
const PERF_KEY    = (u: string) => `perf:${u}`;

const MAX_EVENTS = 500;
const MAX_PERF   = 2_000;

// ── Active trade type (must match botWorker ActiveTrade shape) ────────────────

export type CachedTrade = {
  userKey: string;
  symbol: string;
  timeframe: string;
  isLong: boolean;
  leverage: number;
  entryPriceWad: string;       // bigint serialised as string
  bestPriceWad: string;        // bigint serialised as string — kline-confirmed trailing peak
  pendingBestWad?: string;     // bigint serialised as string — unconfirmed candidate (optional, defaults to bestPriceWad)
  sizeWad: string;             // bigint serialised as string
  openedAtMs: number;
  pending: boolean;
};

export type CachedRegime = {
  dir: "LONG" | "SHORT" | "NONE";
  updatedAt: number;
};

// ── Active Trade CRUD ────────────────────────────────────────────────────────

/**
 * Persist one active trade to Redis.
 * Called every time activeTrades Map is mutated in botWorker.
 */
export async function saveActiveTrade(
  redis: Redis,
  userKey: string,
  symbol: string,
  trade: CachedTrade,
): Promise<void> {
  try {
    await redis.set(TRADE_KEY(userKey, symbol), JSON.stringify(trade));
  } catch (e: any) {
    log.warn({ err: e?.message, symbol }, "[tradeCache] saveActiveTrade failed");
  }
}

/**
 * Remove one trade from Redis when position is closed.
 */
export async function deleteActiveTrade(
  redis: Redis,
  userKey: string,
  symbol: string,
): Promise<void> {
  try {
    await redis.del(TRADE_KEY(userKey, symbol));
  } catch (e: any) {
    log.warn({ err: e?.message, symbol }, "[tradeCache] deleteActiveTrade failed");
  }
}

/**
 * Load all active trades for a user from Redis.
 * Returns a Map<"userKey:symbol", CachedTrade> ready to merge into botWorker Maps.
 */
export async function loadActiveTrades(
  redis: Redis,
  userKey: string,
  symbols: string[],
): Promise<Map<string, CachedTrade>> {
  const result = new Map<string, CachedTrade>();
  try {
    const keys = symbols.map((s) => TRADE_KEY(userKey, s));
    if (!keys.length) return result;

    const values = await redis.mget(...keys);
    for (let i = 0; i < symbols.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      const trade: CachedTrade = JSON.parse(raw);
      const mapKey = `${userKey}:${trade.symbol}`;
      result.set(mapKey, trade);
      log.info({ symbol: trade.symbol, isLong: trade.isLong }, "[tradeCache] restored active trade");
    }

  } catch (e: any) {
    log.warn({ err: e?.message }, "[tradeCache] loadActiveTrades failed");
  }
  return result;
}

// ── Trend Regime CRUD ────────────────────────────────────────────────────────

/**
 * Persist regime direction for a symbol.
 * Called every time trendRegime Map is updated in botWorker.
 */
export async function saveTrendRegime(
  redis: Redis,
  userKey: string,
  symbol: string,
  regime: CachedRegime,
): Promise<void> {
  try {
    await redis.set(REGIME_KEY(userKey, symbol), JSON.stringify(regime));
  } catch (e: any) {
    log.warn({ err: e?.message, symbol }, "[tradeCache] saveTrendRegime failed");
  }
}

/**
 * Load all regime directions for a user's symbols.
 * Returns a Map<"userKey:symbol", CachedRegime>.
 */
export async function loadTrendRegimes(
  redis: Redis,
  userKey: string,
  symbols: string[],
): Promise<Map<string, CachedRegime>> {
  const result = new Map<string, CachedRegime>();
  try {
    const keys = symbols.map((s) => REGIME_KEY(userKey, s));
    if (!keys.length) return result;

    const values = await redis.mget(...keys);
    for (let i = 0; i < symbols.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      const regime: CachedRegime = JSON.parse(raw);
      const mapKey = `${userKey}:${symbols[i]!}`;
      result.set(mapKey, regime);
      log.info({ symbol: symbols[i], dir: regime.dir }, "[tradeCache] restored regime");
    }

  } catch (e: any) {
    log.warn({ err: e?.message }, "[tradeCache] loadTrendRegimes failed");
  }
  return result;
}

// ── Event History ────────────────────────────────────────────────────────────

/**
 * Append one event to the Redis event list (LPUSH + LTRIM to MAX_EVENTS).
 * Newest event is at index 0 (left side of list).
 */
export async function appendEvent(redis: Redis, event: object): Promise<void> {
  try {
    const key = EVENTS_KEY;
    await redis.lpush(key, JSON.stringify(event));
    await redis.ltrim(key, 0, MAX_EVENTS - 1);
  } catch (e: any) {
    log.warn({ err: e?.message }, "[tradeCache] appendEvent failed");
  }
}

/**
 * Load event history from Redis.
 * Returns array ordered oldest→newest (reversed from Redis list order).
 */
export async function loadEventHistory(redis: Redis): Promise<object[]> {
  try {
    const raw = await redis.lrange(EVENTS_KEY, 0, MAX_EVENTS - 1);
    // Redis list is newest-first (LPUSH), reverse so oldest is first in array
    return raw.map((r: string) => JSON.parse(r)).reverse();
  } catch (e: any) {
    log.warn({ err: e?.message }, "[tradeCache] loadEventHistory failed");
    return [];
  }
}

// ── Performance / Closed Trade History ──────────────────────────────────────

/**
 * Append a closed trade record to the performance history.
 * Used by Phase 2 backtesting and win-rate calculations.
 */
export async function appendClosedTrade(
  redis: Redis,
  userKey: string,
  record: {
    symbol:     string;
    isLong:     boolean;
    entryPrice: number;
    exitPrice:  number;
    pnlPct:     number;
    leverage?:  number;
    durationMs: number;
    reason:     string;
    closedAt:   number;
  },
): Promise<void> {
  try {
    const key = PERF_KEY(userKey);
    await redis.lpush(key, JSON.stringify(record));
    await redis.ltrim(key, 0, MAX_PERF - 1);
  } catch (e: any) {
    log.warn({ err: e?.message }, "[tradeCache] appendClosedTrade failed");
  }
}

/**
 * Load closed trade history for performance metrics.
 * Returns array ordered oldest→newest.
 */
export async function loadClosedTrades(
  redis: Redis,
  userKey: string,
  limit = 200,
): Promise<object[]> {
  try {
    const raw = await redis.lrange(PERF_KEY(userKey), 0, limit - 1);
    return raw.map((r: string) => JSON.parse(r)).reverse();
  } catch (e: any) {
    log.warn({ err: e?.message }, "[tradeCache] loadClosedTrades failed");
    return [];
  }
}
