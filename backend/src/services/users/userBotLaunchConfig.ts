import type { Redis } from "ioredis";
import type { TriggerConfig, StrategyMode } from "../bot/botWorkerInstance.js";

const KEY = (userId: string) => `userBotLaunchConfig:${userId}`;

export interface UserBotLaunchConfig {
  symbols?: string[];
  strategy?: StrategyMode;
  trigger?: TriggerConfig;
  updatedAt?: string;
}

export async function getUserBotLaunchConfig(
  redis: Redis,
  userId: string,
): Promise<UserBotLaunchConfig> {
  try {
    const raw = await redis.get(KEY(userId));
    return raw ? (JSON.parse(raw) as UserBotLaunchConfig) : {};
  } catch {
    return {};
  }
}

export async function patchUserBotLaunchConfig(
  redis: Redis,
  userId: string,
  patch: Partial<UserBotLaunchConfig>,
): Promise<UserBotLaunchConfig> {
  const existing = await getUserBotLaunchConfig(redis, userId);
  const saved: UserBotLaunchConfig = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await redis.set(KEY(userId), JSON.stringify(saved));
  return saved;
}

export function validateUserBotLaunchConfig(raw: any): Partial<UserBotLaunchConfig> {
  const out: Partial<UserBotLaunchConfig> = {};

  if (raw.symbols !== undefined) {
    if (!Array.isArray(raw.symbols)) throw new Error("symbols must be an array");
    const symbols = raw.symbols
      .map((s: unknown) => String(s).trim().toUpperCase())
      .filter((s: string) => /^[A-Z]{2,20}USDT$/.test(s));
    if (!symbols.length) throw new Error("symbols: no valid USDT pairs provided");
    out.symbols = symbols;
  }

  if (raw.strategy !== undefined) {
    const strategy = String(raw.strategy).trim();
    if (!strategy) throw new Error("strategy must be a non-empty string");
    out.strategy = strategy as StrategyMode;
  }

  if (raw.trigger !== undefined) {
    const trigger = raw.trigger;
    if (!trigger || typeof trigger !== "object") throw new Error("trigger must be an object");
    const next: TriggerConfig = {};

    if (trigger.stochOS !== undefined) {
      const v = Number(trigger.stochOS);
      if (!Number.isFinite(v) || v < 1 || v > 49) throw new Error("trigger.stochOS must be 1-49");
      next.stochOS = v;
    }

    if (trigger.stochOB !== undefined) {
      const v = Number(trigger.stochOB);
      if (!Number.isFinite(v) || v < 51 || v > 99) throw new Error("trigger.stochOB must be 51-99");
      next.stochOB = v;
    }

    if (trigger.stochMid !== undefined) {
      const v = Number(trigger.stochMid);
      if (!Number.isFinite(v) || v < 1 || v > 99) throw new Error("trigger.stochMid must be 1-99");
      next.stochMid = v;
    }

    if (trigger.stochDLen !== undefined) {
      const v = Number(trigger.stochDLen);
      if (!Number.isFinite(v) || v < 1 || v > 20) throw new Error("trigger.stochDLen must be 1-20");
      next.stochDLen = Math.floor(v);
    }

    out.trigger = next;
  }

  return out;
}
