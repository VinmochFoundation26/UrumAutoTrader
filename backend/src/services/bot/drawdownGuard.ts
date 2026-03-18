/**
 * drawdownGuard.ts — Daily Drawdown Circuit Breaker
 *
 * Tracks the running sum of levered PnL% for the current UTC day.
 * When total daily loss exceeds the configured threshold, the circuit
 * breaker fires: the engine is stopped and a CIRCUIT_BREAKER_TRIGGERED
 * event is emitted, preventing further capital at risk.
 *
 * Redis key schema:
 *   dailyReturn:{userKey}:{YYYYMMDD}  → FLOAT (sum of levered PnL%)
 *
 * TTL is set to seconds-until-next-UTC-midnight on first write, so keys
 * auto-expire and the circuit resets every day without a cron job.
 *
 * Terminology:
 *   leveredReturn  = unleveredPnlPct * leverage  (e.g. 0.03 * 5 = 0.15 = 15%)
 *   dailyReturn    = sum of all leveredReturns for today (can be negative)
 *   circuitBreaker = triggered when dailyReturn < -maxDailyLoss
 *
 * Example:
 *   MAX_DAILY_LOSS_PCT = 0.10 (10% of daily starting collateral)
 *   Two trades lose 7% and 5% levered → dailyReturn = -0.12 → TRIGGERED
 */

import type { Redis } from "ioredis";
import { log } from "../../logger.js";

// ── Key helpers ───────────────────────────────────────────────────────────────

function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function secondsUntilNextMidnightUTC(): number {
  const now = Date.now();
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0); // next UTC midnight
  return Math.max(60, Math.floor((tomorrow.getTime() - now) / 1000));
}

const DAILY_KEY = (userKey: string, date: string) =>
  `dailyReturn:${userKey.toLowerCase()}:${date}`;

// ── Public API ─────────────────────────────────────────────────────────────────

export type CircuitBreakerStatus = {
  triggered:    boolean;
  dailyReturn:  number;    // current sum of levered returns (negative = loss)
  limit:        number;    // threshold (e.g. -0.10 = -10%)
  date:         string;    // YYYYMMDD UTC
};

/**
 * Record one trade's levered return for today.
 * Call this after every position close.
 *
 * @param redis        ioredis client
 * @param userKey      user address
 * @param leveredReturn  pnlPct * leverage  (e.g. -0.15 for a -15% levered loss)
 */
export async function recordDailyReturn(
  redis:         Redis,
  userKey:       string,
  leveredReturn: number,
): Promise<void> {
  try {
    const date = todayUTC();
    const key  = DAILY_KEY(userKey, date);

    // INCRBYFLOAT creates the key on first use (starts from 0)
    await redis.incrbyfloat(key, leveredReturn);

    // Set TTL only if key is new (TTL = -1 means no expiry set yet)
    const ttl = await redis.ttl(key);
    if (ttl < 0) {
      await redis.expire(key, secondsUntilNextMidnightUTC());
    }

    log.debug({ userKey, date, leveredReturn: leveredReturn.toFixed(4) }, "[drawdown] daily return updated");
  } catch (e: any) {
    log.warn({ err: e?.message }, "[drawdown] recordDailyReturn failed");
  }
}

/**
 * Get today's running levered return for a user.
 * Returns 0 if no trades have been recorded today.
 */
export async function getDailyReturn(redis: Redis, userKey: string): Promise<number> {
  try {
    const key = DAILY_KEY(userKey, todayUTC());
    const v   = await redis.get(key);
    return v != null ? Number(v) : 0;
  } catch (e: any) {
    log.warn({ err: e?.message }, "[drawdown] getDailyReturn failed");
    return 0;
  }
}

/**
 * Check whether the daily drawdown circuit breaker should fire.
 * Returns triggered=true when daily levered loss exceeds maxDailyLoss.
 *
 * @param redis        ioredis client
 * @param userKey      user address
 * @param maxDailyLoss threshold as positive fraction (e.g. 0.10 = -10% triggers)
 */
// Dedup: log the CIRCUIT BREAKER warn only once per UTC date per process
let _lastLoggedCBDate = "";

export async function checkCircuitBreaker(
  redis:        Redis,
  userKey:      string,
  maxDailyLoss: number,
): Promise<CircuitBreakerStatus> {
  const dailyReturn = await getDailyReturn(redis, userKey);
  const limit       = -Math.abs(maxDailyLoss);    // always negative (loss threshold)
  const triggered   = dailyReturn <= limit;
  const date        = todayUTC();

  // Log only once per UTC date to avoid spamming every scan tick (every 10s)
  if (triggered && _lastLoggedCBDate !== date) {
    _lastLoggedCBDate = date;
    log.warn(
      { userKey, dailyReturn: dailyReturn.toFixed(4), limit: limit.toFixed(4), date },
      "[drawdown] CIRCUIT BREAKER TRIGGERED — new entries paused until UTC midnight"
    );
  }

  return { triggered, dailyReturn, limit, date };
}

/**
 * Manually reset the circuit breaker for today (admin use only).
 * Deletes the daily PnL accumulator key so the day restarts at 0.
 */
export async function resetCircuitBreaker(redis: Redis, userKey: string): Promise<void> {
  try {
    await redis.del(DAILY_KEY(userKey, todayUTC()));
    log.info({ userKey }, "[drawdown] circuit breaker manually reset");
  } catch (e: any) {
    log.warn({ err: e?.message }, "[drawdown] resetCircuitBreaker failed");
  }
}
