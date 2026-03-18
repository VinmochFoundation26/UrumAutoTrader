/**
 * signalScorer.ts — Adaptive Bayesian Signal Scorer
 *
 * An online machine-learning layer that learns WHICH market conditions
 * historically produce winning trades for this strategy, then uses that
 * knowledge to boost (or reduce) the score of future entry candidates.
 *
 * No heavy ML libraries required — pure Bayesian statistics.
 *
 * ── How It Works ──────────────────────────────────────────────────────────────
 *
 * 1. FEATURE EXTRACTION
 *    For each entry candidate, the votes event is bucketed into a discrete
 *    feature key combining four dimensions:
 *      regime    LONG / SHORT / NONE
 *      rsiZone   OS(<35) / MID(35-65) / OB(>65)
 *      stochZone OS(<30) / MID(30-70) / OB(>70)
 *      atrLevel  LOW(<0.002) / MID(0.002–0.004) / HIGH(>0.004)
 *
 *    Example key: "LONG:MID:OS:LOW"
 *
 * 2. BAYESIAN SCORE  (Laplace-smoothed Beta posterior)
 *    P(win | features) = (wins + 1) / (total + 2)
 *    This avoids 0/1 extremes with limited data.
 *
 * 3. CONFIDENCE
 *    confidence = min(total, 20) / 20
 *    → 0% at 0 obs, 50% at 10 obs, 100% at ≥20 obs
 *    Prevents the scorer from dominating before enough data accumulates.
 *
 * 4. AI BONUS TO CANDIDATE SCORE
 *    bonus = (bayesianWinRate - 0.5) × 2 × confidence × WEIGHT
 *    where WEIGHT = 1.5 (half of a typical 5m timeframe base score)
 *    → A confirmed 80% win-rate setup adds +0.9 to score at full confidence
 *    → A confirmed 20% win-rate setup subtracts -0.9
 *    → No effect at 0 observations
 *
 * 5. ONLINE LEARNING
 *    After every trade closes, recordTradeOutcome() is called with the
 *    feature key and whether the trade was a winner. Redis is updated.
 *    The model continuously improves as the bot trades.
 *
 * ── Redis Key Schema ──────────────────────────────────────────────────────────
 *   aiStat:{featureKey}  → JSON { wins: number, total: number }
 *   aiMeta               → JSON { totalTrades, lastUpdated, featureCount }
 *
 * ── No Training Required ──────────────────────────────────────────────────────
 *   The model starts neutral (bonus = 0) and gradually gains confidence
 *   as real trades accumulate. After ~20 trades per setup, it has learned
 *   which conditions consistently win or lose.
 */

import type { Redis } from "ioredis";
import { log } from "../../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SignalFeatures = {
  regime:    "LONG" | "SHORT" | "NONE";
  rsiZone:   "OS" | "MID" | "OB";
  stochZone: "OS" | "MID" | "OB";
  atrLevel:  "LOW" | "MID" | "HIGH";
};

export type AiScoreResult = {
  featureKey:    string;
  bayesianWinRate: number;  // 0–1 (Laplace-smoothed)
  confidence:    number;    // 0–1 (grows with sample count)
  bonus:         number;    // additive score contribution
  wins:          number;
  total:         number;
};

export type FeatureStat = {
  wins:  number;
  total: number;
};

export type ModelStats = {
  featureCount:  number;
  totalTrades:   number;
  topSetups:     Array<{ key: string; winRate: number; total: number; bonus: number }>;
  worstSetups:   Array<{ key: string; winRate: number; total: number; bonus: number }>;
  lastUpdated:   number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const STAT_KEY  = (featureKey: string) => `aiStat:${featureKey}`;
const META_KEY  = "aiMeta";
const AI_WEIGHT = 1.5;   // max absolute bonus (at full confidence, 100%/0% win rate)
const MIN_CONFIDENCE_TOTAL = 20; // observations needed for full confidence

// ── Feature extraction ────────────────────────────────────────────────────────

function rsiZone(rsi: number): SignalFeatures["rsiZone"] {
  if (rsi <= 35) return "OS";
  if (rsi >= 65) return "OB";
  return "MID";
}

function stochZone(stochK: number): SignalFeatures["stochZone"] {
  if (stochK <= 30) return "OS";
  if (stochK >= 70) return "OB";
  return "MID";
}

function atrLevel(atrPct: number): SignalFeatures["atrLevel"] {
  if (atrPct < 0.002) return "LOW";
  if (atrPct > 0.004) return "HIGH";
  return "MID";
}

/**
 * Extract discrete signal features from a VOTES event and ATR%.
 * The votes object shape matches what the live botWorker emits:
 *   { trendRegime, rsiValue, stochK, stochD, longVotes, shortVotes, ... }
 */
export function extractFeatures(
  votes:  Record<string, any>,
  atrPct: number,
): SignalFeatures {
  return {
    regime:    (votes.trendRegime as SignalFeatures["regime"]) ?? "NONE",
    rsiZone:   rsiZone(Number(votes.rsiValue ?? 50)),
    stochZone: stochZone(Number(votes.stochK ?? 50)),
    atrLevel:  atrLevel(atrPct),
  };
}

/**
 * Build the Redis key for a feature + direction combination.
 * Direction is kept separate from features so we can learn
 * long/short win rates independently for the same market conditions.
 */
export function featureKey(features: SignalFeatures, direction: "LONG" | "SHORT"): string {
  return `${direction}:${features.regime}:${features.rsiZone}:${features.stochZone}:${features.atrLevel}`;
}

// ── Bayesian scoring ──────────────────────────────────────────────────────────

/**
 * Get the AI score for a signal.
 * Returns bonus in range [-AI_WEIGHT, +AI_WEIGHT].
 * Returns bonus = 0 when no observations available.
 */
export async function getAiScore(
  redis:     Redis,
  features:  SignalFeatures,
  direction: "LONG" | "SHORT",
): Promise<AiScoreResult> {
  const key = featureKey(features, direction);
  try {
    const raw = await redis.get(STAT_KEY(key));
    if (!raw) {
      return { featureKey: key, bayesianWinRate: 0.5, confidence: 0, bonus: 0, wins: 0, total: 0 };
    }

    const stat: FeatureStat = JSON.parse(raw);
    const { wins, total } = stat;

    // Laplace-smoothed Bayesian win rate
    const bayesianWinRate = (wins + 1) / (total + 2);

    // Confidence grows linearly to 1.0 at MIN_CONFIDENCE_TOTAL observations
    const confidence = Math.min(total, MIN_CONFIDENCE_TOTAL) / MIN_CONFIDENCE_TOTAL;

    // Bonus: positive for high win rate, negative for low win rate
    const bonus = (bayesianWinRate - 0.5) * 2 * confidence * AI_WEIGHT;

    return { featureKey: key, bayesianWinRate, confidence, bonus, wins, total };
  } catch (e: any) {
    log.warn({ err: e?.message, key }, "[signalScorer] getAiScore failed");
    return { featureKey: key, bayesianWinRate: 0.5, confidence: 0, bonus: 0, wins: 0, total: 0 };
  }
}

// ── Online learning ───────────────────────────────────────────────────────────

/**
 * Record the outcome of a closed trade to update the model.
 * Call this after every position close with the feature key stored at entry.
 *
 * @param redis       ioredis client
 * @param key         featureKey string (from featureKey() at entry time)
 * @param won         true if trade was profitable (pnlPct > 0)
 */
export async function recordTradeOutcome(
  redis: Redis,
  key:   string,
  won:   boolean,
): Promise<void> {
  try {
    const statKey = STAT_KEY(key);
    const raw     = await redis.get(statKey);
    const stat: FeatureStat = raw ? JSON.parse(raw) : { wins: 0, total: 0 };

    stat.total += 1;
    if (won) stat.wins += 1;

    await redis.set(statKey, JSON.stringify(stat));

    // Update metadata
    await updateMeta(redis);

    log.debug({ key, won, wins: stat.wins, total: stat.total }, "[signalScorer] outcome recorded");
  } catch (e: any) {
    log.warn({ err: e?.message, key }, "[signalScorer] recordTradeOutcome failed");
  }
}

// ── Model stats (for /ai/model endpoint) ─────────────────────────────────────

export async function getModelStats(redis: Redis): Promise<ModelStats> {
  try {
    // Scan all aiStat:* keys
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, found] = await redis.scan(cursor, "MATCH", "aiStat:*", "COUNT", 100);
      cursor = nextCursor;
      keys.push(...found);
    } while (cursor !== "0");

    const setups: Array<{ key: string; winRate: number; total: number; bonus: number }> = [];

    for (const k of keys) {
      const raw = await redis.get(k);
      if (!raw) continue;
      const stat: FeatureStat = JSON.parse(raw);
      const { wins, total } = stat;
      if (total === 0) continue;

      const bayesianWinRate = (wins + 1) / (total + 2);
      const confidence      = Math.min(total, MIN_CONFIDENCE_TOTAL) / MIN_CONFIDENCE_TOTAL;
      const bonus           = (bayesianWinRate - 0.5) * 2 * confidence * AI_WEIGHT;
      const featureKeyStr   = k.replace("aiStat:", "");

      setups.push({ key: featureKeyStr, winRate: bayesianWinRate, total, bonus });
    }

    // Sort for top/worst
    setups.sort((a, b) => b.bonus - a.bonus);
    const topSetups   = setups.slice(0, 5);
    const worstSetups = [...setups].sort((a, b) => a.bonus - b.bonus).slice(0, 5);

    const totalTrades = setups.reduce((s, x) => s + x.total, 0);

    // Read metadata
    const metaRaw = await redis.get(META_KEY);
    const meta    = metaRaw ? JSON.parse(metaRaw) : { lastUpdated: 0 };

    return {
      featureCount: setups.length,
      totalTrades,
      topSetups,
      worstSetups,
      lastUpdated: meta.lastUpdated ?? 0,
    };
  } catch (e: any) {
    log.warn({ err: e?.message }, "[signalScorer] getModelStats failed");
    return { featureCount: 0, totalTrades: 0, topSetups: [], worstSetups: [], lastUpdated: 0 };
  }
}

async function updateMeta(redis: Redis): Promise<void> {
  try {
    const raw  = await redis.get(META_KEY);
    const meta = raw ? JSON.parse(raw) : { totalTrades: 0, lastUpdated: 0, featureCount: 0 };
    meta.totalTrades  = (meta.totalTrades ?? 0) + 1;
    meta.lastUpdated  = Date.now();
    await redis.set(META_KEY, JSON.stringify(meta));
  } catch { /* non-critical */ }
}
