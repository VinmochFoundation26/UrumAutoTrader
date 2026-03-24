/**
 * Token-bucket rate limiter for Binance FAPI klines calls.
 * Shared singleton across all BotWorkerInstance workers in the same process.
 *
 * Binance FAPI limit: 2400 weight/min. Each klines call = 1 weight.
 * We cap at 1200/min (50% safety margin) = 20 tokens/second.
 */

const BUCKET_CAPACITY = 1200;
const REFILL_RATE     = 20;    // tokens per second

let tokens      = BUCKET_CAPACITY;
let lastRefillMs = Date.now();

function refill(): void {
  const now     = Date.now();
  const elapsed = (now - lastRefillMs) / 1000;
  tokens        = Math.min(BUCKET_CAPACITY, tokens + elapsed * REFILL_RATE);
  lastRefillMs  = now;
}

export async function acquireCandleToken(cost = 1): Promise<void> {
  refill();
  if (tokens >= cost) {
    tokens -= cost;
    return;
  }
  const waitMs = Math.ceil(((cost - tokens) / REFILL_RATE) * 1000);
  await new Promise<void>(resolve => setTimeout(resolve, waitMs));
  refill();
  tokens -= cost;
}

export function getCandleRateLimiterStats(): { tokens: number; capacity: number } {
  refill();
  return { tokens: Math.floor(tokens), capacity: BUCKET_CAPACITY };
}
