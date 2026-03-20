// ── Per-User Trading Config ────────────────────────────────────────────────────
// Allows admin to configure per-user overrides for:
//   • symbols    — which markets this user's bot scans
//   • maxLeverage — cap on leverage regardless of global config
//   • maxConcurrentTrades — how many open positions at once
//   • riskPct    — % of vault allocated per trade
//
// Redis key: userTradingConfig:{userId}
//
// Falls back to global bot.config.json values when a field is absent.
// ─────────────────────────────────────────────────────────────────────────────

import type { Redis } from "ioredis";

const KEY = (userId: string) => `userTradingConfig:${userId}`;

export interface UserTradingConfig {
  symbols?:             string[];   // e.g. ["BTCUSDT","ETHUSDT"] — overrides global SYMBOLS
  maxLeverage?:         number;     // hard cap on leverage (e.g. 5)
  maxConcurrentTrades?: number;     // max open positions at once (e.g. 2)
  riskPct?:             number;     // fraction of vault per trade (0.10 = 10%)
  updatedAt?:           string;     // ISO timestamp
}

/** Load per-user trading config. Returns {} if none set. */
export async function getUserTradingConfig(
  redis: Redis,
  userId: string,
): Promise<UserTradingConfig> {
  try {
    const raw = await redis.get(KEY(userId));
    return raw ? (JSON.parse(raw) as UserTradingConfig) : {};
  } catch {
    return {};
  }
}

/** Save (full replace) per-user trading config. */
export async function setUserTradingConfig(
  redis: Redis,
  userId: string,
  config: UserTradingConfig,
): Promise<UserTradingConfig> {
  const saved: UserTradingConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
  };
  await redis.set(KEY(userId), JSON.stringify(saved));
  return saved;
}

/** Merge partial fields into existing config. */
export async function patchUserTradingConfig(
  redis: Redis,
  userId: string,
  patch: Partial<UserTradingConfig>,
): Promise<UserTradingConfig> {
  const existing = await getUserTradingConfig(redis, userId);
  return setUserTradingConfig(redis, userId, { ...existing, ...patch });
}

/** Delete per-user config (falls back to global defaults). */
export async function deleteUserTradingConfig(
  redis: Redis,
  userId: string,
): Promise<void> {
  await redis.del(KEY(userId));
}

/** Validate and sanitise an incoming config payload. Throws on bad input. */
export function validateUserTradingConfig(raw: any): UserTradingConfig {
  const out: UserTradingConfig = {};

  if (raw.symbols !== undefined) {
    if (!Array.isArray(raw.symbols)) throw new Error("symbols must be an array");
    out.symbols = (raw.symbols as any[])
      .map((s: any) => String(s).trim().toUpperCase())
      .filter((s) => /^[A-Z]{2,20}USDT$/.test(s));
    if (!out.symbols.length) throw new Error("symbols: no valid USDT pairs provided");
  }

  if (raw.maxLeverage !== undefined) {
    const v = Number(raw.maxLeverage);
    if (!isFinite(v) || v < 1 || v > 100) throw new Error("maxLeverage must be 1–100");
    out.maxLeverage = Math.floor(v);
  }

  if (raw.maxConcurrentTrades !== undefined) {
    const v = Number(raw.maxConcurrentTrades);
    if (!isFinite(v) || v < 1 || v > 10) throw new Error("maxConcurrentTrades must be 1–10");
    out.maxConcurrentTrades = Math.floor(v);
  }

  if (raw.riskPct !== undefined) {
    const v = Number(raw.riskPct);
    if (!isFinite(v) || v <= 0 || v > 1) throw new Error("riskPct must be 0–1 (e.g. 0.15 = 15%)");
    out.riskPct = v;
  }

  return out;
}
