import fs from "node:fs";
import path from "node:path";

// Fork worker (single brain)
import {
  evaluateUserSymbol as evalTrendRangeFork,
  registerTradeAfterExecution,
  restoreState,
  fastExitCheck,
} from "../../botWorker.trend_range_fork.js";
import { getLatestPrice } from "../market/priceStream.js";
import { getFallbackPrice } from "../market/priceFeedFallback.js";
import { makeEngineDeps } from "./deps.js";
import { getUsdmFuturesSymbols } from "../market/binanceCandles.js";
import { getVaultContract, getVaultReadContract, getFallbackProvider } from "../onchain/contractInstance.js";
import { Contract } from "ethers";
import { keccak256, toUtf8Bytes } from "ethers";
import { log } from "../../logger.js";

// ── Phase 3 imports ───────────────────────────────────────────────────────────
import { checkCircuitBreaker } from "./drawdownGuard.js";
import { extractFeatures, getAiScore } from "../ai/signalScorer.js";

// ── Phase 1 (Execution Hardening) ─────────────────────────────────────────────
import { reconcilePendingTxs } from "../onchain/txTracker.js";

// ── Per-user trading config ────────────────────────────────────────────────────
import { getUserTradingConfig } from "../users/userTradingConfig.js";

type BotConfig = {
  TIMEFRAMES: string[];
  DEFAULT_LEVERAGE?: number;
};

function loadConfig(): BotConfig {
  const p = path.resolve(process.cwd(), "../bot.config.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  const cfg: any = (raw as any)?.default ?? raw;

  let tfs: any = cfg?.TIMEFRAMES;
  if (Array.isArray(tfs)) {
    // ok
  } else if (typeof tfs === "string") {
    tfs = tfs.split(",").map((s: string) => s.trim()).filter(Boolean);
  } else {
    tfs = ["1h", "5m"];
  }

  return { ...cfg, TIMEFRAMES: tfs } as BotConfig;
}

export type TriggerConfig = {
  stochOS?: number;
  stochOB?: number;
  stochMid?: number;
  stochDLen?: number;
};

type VotesEvent = {
  ts: number;
  type: "VOTES";
  userKey: string;
  symbol: string;
  timeframe: string;
  decided: "LONG" | "SHORT" | "NONE";
  atrPct?: number;        // Phase 3: ATR% at time of vote (for AI feature extraction)
  votes: {
    longVotes: number;
    shortVotes: number;
    required: number;
    [k: string]: any;    // includes rsiValue, stochK, stochD, trendRegime, mode
  };
};

type EntryCandidate = {
  userKey: string;
  symbol: string;
  timeframe: string;
  side: "LONG" | "SHORT";
  score: number;
  aiBonus: number;        // Phase 3: AI Bayesian bonus (can be negative)
  execArgs: any;
  votes: VotesEvent["votes"];
};

const TF_WEIGHT: Record<string, number> = {
  "5m": 1.0,
  "15m": 1.15,
  "1h": 1.25,
  "4h": 1.35,
};

function scoreCandidate(v: VotesEvent, side: "LONG" | "SHORT") {
  const winning = side === "LONG" ? v.votes.longVotes : v.votes.shortVotes;
  const losing = side === "LONG" ? v.votes.shortVotes : v.votes.longVotes;
  const margin = winning - losing;
  const required = v.votes.required;

  const base = winning;
  const marginBonus = margin * 0.35;
  const exceedBonus = Math.max(0, winning - required) * 0.6;
  const w = TF_WEIGHT[v.timeframe] ?? 1.0;

  return (base + marginBonus + exceedBonus) * w;
}

const MAX_CONCURRENT_TRADES = 3; // VaultV2 supports up to 3 concurrent positions

// On bot startup: read open positions from chain and register them in activeTrades
// so the exit logic (stop-loss / profit-reversal) picks them up without needing a restart.
async function recoverOpenPositions(
  userKey: string,
  symbols: string[],
  leverage: number,
  deps: any
) {
  try {
    const vault = getVaultContract();
    const markets: string[] = await (vault as any).getOpenMarkets(userKey);
    if (!markets.length) return;

    // Build reverse map: marketId → symbol from the configured symbol list
    const idToSymbol = new Map<string, string>();
    for (const sym of symbols) {
      idToSymbol.set(keccak256(toUtf8Bytes(sym)), sym);
    }

    for (const marketId of markets) {
      const sym = idToSymbol.get(marketId);
      if (!sym) continue; // unknown market — skip

      const pos = await (vault as any).positionOf(userKey, marketId);
      if (!pos.isOpen) continue;

      const entryPriceWad = BigInt(pos.entryPriceX18.toString());
      const sizeWad = BigInt(pos.sizeX18.toString());

      registerTradeAfterExecution({
        userKey,
        symbol: sym,
        timeframe: "5m",
        isLong: pos.isLong,
        leverage,
        sizeWad,
        entryPriceWad,
        openedAtMs: Number(pos.openedAt) * 1000,  // on-chain timestamp → ms
        redis: deps.redis,   // persist to Redis so next restart skips chain read
      });

      deps.emit({
        ts: Date.now(),
        type: "POSITION_RECOVERED",
        userKey,
        symbol: sym,
        isLong: pos.isLong,
        entryPrice: Number(entryPriceWad) / 1e18,
        size: Number(sizeWad) / 1e18,
      });
    }
  } catch (e: any) {
    deps.emit({
      ts: Date.now(),
      type: "RECOVERY_FAILED",
      error: e?.message ?? String(e),
    });
  }
}

async function getOpenCount(userKey: string): Promise<number> {
  // Try the primary read provider first, fall back to the secondary if it times out.
  // The public arb1.arbitrum.io RPC occasionally routes to a dead internal node,
  // causing ~5s timeouts that kill the entire scan tick. The Ankr fallback is more
  // stable for read calls.
  try {
    const vault = getVaultReadContract();
    const count = await (vault as any).openCount(userKey);
    return Number(count);
  } catch (primaryErr: any) {
    const fallbackProvider = getFallbackProvider();
    if (!fallbackProvider) throw primaryErr; // no fallback configured — rethrow
    log.warn({ err: primaryErr?.message }, "[runner] primary RPC failed for openCount — trying fallback");
    const { getVaultAddress, VAULT_ABI } = await import("../onchain/contractInstance.js");
    const fallbackContract = new Contract(getVaultAddress(), VAULT_ABI, fallbackProvider);
    const count = await (fallbackContract as any).openCount(userKey);
    return Number(count);
  }
}

async function isAtMaxCapacity(userKey: string): Promise<boolean> {
  const count = await getOpenCount(userKey);
  return count >= MAX_CONCURRENT_TRADES;
}

let timer: NodeJS.Timeout | null = null;
let exitMonitorTimer: NodeJS.Timeout | null = null;
let lastCircuitBreakerDate = ""; // tracks which UTC date we last emitted CIRCUIT_BREAKER_TRIGGERED
let lastRun:
  | {
      userKey: string;
      symbols: string[];
      trigger?: TriggerConfig;
      strategy: "trend_range_fork";
    }
  | null = null;

/**
 * Engine start (owned by index.ts)
 */
export async function startEngine(args: {
  userKey: string;
  symbols: string[];
  trigger?: TriggerConfig;
}) {
  if (timer) return { ok: true, running: true, ...(lastRun ?? {}) };

  const cfg = loadConfig();
  const deps = makeEngineDeps();

  const strategy = "trend_range_fork" as const;
  const trigger: TriggerConfig = args.trigger ?? {};

  // Attach trigger config to deps so the fork worker can read it
  (deps as any).strategy = strategy;
  (deps as any).trigger = trigger;

  // Fork-only evaluator
  const evaluateUserSymbol = evalTrendRangeFork;

  // ── Per-user trading config overrides ─────────────────────────────────────
  // Admin can set per-user overrides for symbols, maxLeverage, maxConcurrentTrades,
  // and riskPct via the admin API (GET/PATCH/DELETE /admin/users/:id/trading-config).
  // These override the global bot.config.json values for this user only.
  let userMaxConcurrent = MAX_CONCURRENT_TRADES;
  let userMaxLeverage   = cfg.DEFAULT_LEVERAGE ?? 10;
  let effectiveSymbols  = args.symbols;

  if (deps.redis) {
    try {
      const userCfg = await getUserTradingConfig(deps.redis, args.userKey);
      if (userCfg.maxConcurrentTrades) userMaxConcurrent = userCfg.maxConcurrentTrades;
      if (userCfg.maxLeverage)         userMaxLeverage   = userCfg.maxLeverage;
      if (userCfg.symbols?.length)     effectiveSymbols  = userCfg.symbols;
      if (Object.keys(userCfg).length > 0) {
        log.info(
          { userKey: args.userKey, userCfg },
          "[runner] per-user trading config applied"
        );
      }
    } catch (e: any) {
      log.warn({ err: e?.message }, "[runner] failed to load per-user trading config (non-fatal)");
    }
  }

  // ---- Symbol normalization ----
  const requested = (effectiveSymbols ?? [])
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean);

  // ---- Validate against USD-M Futures exchangeInfo (non-fatal) ----
  let valid = requested;
  let dropped: string[] = [];

  try {
    const allowed = await getUsdmFuturesSymbols(); // cached inside binanceCandles.ts
    valid = requested.filter((s) => allowed.has(s));
    dropped = requested.filter((s) => !allowed.has(s));

    if (dropped.length) {
      deps.emit({
        ts: Date.now(),
        type: "SYMBOLS_DROPPED",
        dropped,
      });
    }

    if (!valid.length) {
      deps.emit({
        ts: Date.now(),
        type: "NO_VALID_SYMBOLS",
        requested,
      });
      return {
        ok: false,
        running: false,
        error: "No valid USD-M futures symbols after validation",
        dropped,
      };
    }
  } catch (e: any) {
    // If Binance exchangeInfo fails, do NOT kill the bot — run with requested symbols.
    deps.emit({
      ts: Date.now(),
      type: "SYMBOL_VALIDATION_SKIPPED",
      reason: "exchangeInfo fetch failed; using requested symbols as-is",
      error: e?.message ?? String(e),
    });
  }

  // ── Phase 1 (Execution Hardening): TX Reconciliation ──────────────────────
  // On restart, check any transactions that were in-flight when the bot last
  // crashed. Clears Redis pendingTx keys for confirmed/reverted txs.
  // Runs before restoreState so we never register a ghost from a reverted tx.
  if (deps.redis) {
    try {
      const { getProvider } = await import("../onchain/contractInstance.js");
      await reconcilePendingTxs(deps.redis, getProvider());
    } catch (e: any) {
      log.warn({ err: e?.message }, "[runner] txTracker reconciliation failed (non-fatal)");
    }
  }

  // ── Phase 1: Restore from Redis (fastest — no network calls) ──────────────
  // Restores activeTrades + trendRegime from Redis, preserving trailing stop
  // peaks (bestPriceWad) that would otherwise be lost on crash/restart.
  log.info({ userKey: args.userKey, symbols: valid }, "[runner] restoring state from Redis");
  await restoreState(deps.redis, args.userKey, valid);

  // ── Phase 2: On-chain recovery (fallback for first boot / Redis miss) ─────
  // Only registers positions NOT already in activeTrades from Redis.
  // This handles the cold-start case where Redis has no data yet.
  log.info("[runner] recovering positions from on-chain");
  await recoverOpenPositions(args.userKey, valid, userMaxLeverage, deps);

  lastRun = {
    userKey: args.userKey,
    symbols: valid,
    trigger,
    strategy,
  };

  timer = setInterval(async () => {
    const userKey = args.userKey;

    // ── Phase 3: Drawdown circuit breaker ──────────────────────────────────
    // Check BEFORE any scanning. If daily loss exceeds the limit, skip this
    // scan tick entirely but KEEP the timer alive.
    //
    // WHY NOT stopEngine(): Stopping the timer means the engine is dead until
    // a manual restart or container restart. The daily return Redis key has a
    // TTL that expires at UTC midnight — when it expires, getDailyReturn() returns
    // 0 and scanning auto-resumes on the very next tick. Keeping the timer alive
    // gives us automatic zero-touch recovery at the start of each UTC day.
    //
    // Spam prevention: the CIRCUIT_BREAKER_TRIGGERED event is emitted only once
    // per UTC date (tracked by lastCircuitBreakerDate) rather than every tick.
    if (deps.redis) {
      try {
        const maxLoss = Math.abs(Number(process.env.MAX_DAILY_LOSS_PCT ?? "0.10"));
        const cb = await checkCircuitBreaker(deps.redis, userKey, maxLoss);
        if (cb.triggered) {
          if (lastCircuitBreakerDate !== cb.date) {
            lastCircuitBreakerDate = cb.date;
            deps.emit({
              ts: Date.now(),
              type: "CIRCUIT_BREAKER_TRIGGERED",
              userKey,
              dailyReturn:  cb.dailyReturn,
              limit:        cb.limit,
              date:         cb.date,
              reason: `Daily levered loss ${(cb.dailyReturn * 100).toFixed(1)}% exceeded limit ${(cb.limit * 100).toFixed(1)}%`,
            });
          }
          return; // skip scan tick — engine stays alive, auto-resumes at UTC midnight
        }
      } catch (e: any) {
        log.warn({ err: e?.message }, "[runner] circuit breaker check failed (non-fatal)");
      }
    }

      // VaultV2: block new entries only when all 3 slots are full
      let openCount = 0;
      let atCapacity = false;

try {
  openCount = await getOpenCount(userKey);
  atCapacity = openCount >= userMaxConcurrent;

  if (atCapacity) {
    deps.emit({
      ts: Date.now(),
      type: "ENTRY_BLOCKED",
      userKey,
      openCount,
      reason: `max concurrent positions reached (${openCount}/${userMaxConcurrent}); new entries blocked`,
    });
    // DO NOT return; we still scan regime/entry TFs (exits + regime tracking)
  }
} catch (e: any) {
  deps.emit({
    ts: Date.now(),
    type: "POSITION_CHECK_FAILED",
    userKey,
    error: e?.message ?? String(e),
  });
  return; // safest: stop this tick
}


    // ---------- SCAN PHASE (collect candidates, no execution) ----------
    const lastVotesByKey = new Map<string, VotesEvent>();
    const candidates: EntryCandidate[] = [];

    const scanDeps = {
      ...deps,
      strategy,
      trigger,

      emit: (e: Record<string, any>) => {
        deps.emit(e);

        // Capture most recent VOTES per (symbol,timeframe)
        if (e?.type === "VOTES" && e?.symbol && e?.timeframe) {
          const k = `${e.symbol}:${e.timeframe}`;
          lastVotesByKey.set(k, e as VotesEvent);
        }
      },

      // Intercept executeTrade during scan; DO NOT send tx; store candidate instead
      executeTrade: async (execArgs: any) => {
        const symbol = String(execArgs?.symbol ?? "");
        const timeframe = String(execArgs?.timeframe ?? "");
        const k = `${symbol}:${timeframe}`;
        const v = lastVotesByKey.get(k);

        if (!v || (v.decided !== "LONG" && v.decided !== "SHORT")) {
          return { paper: true, reason: "no votes captured for scoring" };
        }

        const side  = v.decided;
        const base  = scoreCandidate(v, side);

        // ── Phase 3: AI bonus ─────────────────────────────────────────────
        // Extract signal features from the votes event and look up the
        // Bayesian win-rate for this feature combination in Redis.
        // bonus ∈ [-1.5, +1.5] scaled by confidence (0 until ≥20 obs).
        let aiBonus = 0;
        if (deps.redis) {
          try {
            const features = extractFeatures(v.votes, v.atrPct ?? 0);
            const ai = await getAiScore(deps.redis, features, side);
            aiBonus = ai.bonus;
            log.debug(
              { symbol, side, aiKey: ai.featureKey, winRate: ai.bayesianWinRate.toFixed(2),
                confidence: ai.confidence.toFixed(2), bonus: ai.bonus.toFixed(3) },
              "[runner] AI score"
            );
          } catch { /* non-blocking */ }
        }

        const score = base + aiBonus;

        candidates.push({
          userKey,
          symbol,
          timeframe,
          side,
          score,
          aiBonus,
          execArgs,
          votes: v.votes,
        });

        deps.emit({
          ts: Date.now(),
          type: "CANDIDATE_FOUND",
          userKey,
          symbol,
          timeframe,
          side,
          score,
          aiBonus,
          votes: v.votes,
          strategy,
        });

        return { paper: true, intercepted: true };
      },
    };
  
      // Scan all symbols/timeframes (regime TFs first to update direction, then 5m entry/exit)
      // The ENTRY_TF ("5m") is always the trading timeframe.
      // Everything else in TIMEFRAMES is treated as a regime timeframe (e.g. "1h").
      const ENTRY_TF = "5m";
      const regimeTfs = cfg.TIMEFRAMES.filter((tf: string) => tf !== ENTRY_TF);
      const hasEntry = cfg.TIMEFRAMES.includes(ENTRY_TF);

      // helper so we keep one try/catch format
      const scanOne = async (tf: string, sym: string) => {
        try {
          await evaluateUserSymbol(scanDeps as any, {
            userKey,
            symbol: sym,
            timeframe: tf,
          });
        } catch (e: any) {
          deps.emit({
            ts: Date.now(),
            type: "SCAN_ERROR",
            userKey,
            symbol: sym,
            timeframe: tf,
            error: e?.message ?? String(e),
            stack: e?.stack ?? null,
            strategy,
          });
        }
      };

      for (const sym of valid) {
        // 1) Regime timeframes first (e.g. 1h) — sets direction for entry filter
        for (const tf of regimeTfs) await scanOne(tf, sym);

        // 2) Entry/exit timeframe last (5m)
        if (hasEntry) await scanOne(ENTRY_TF, sym);
      }
    if (!candidates.length) return;

    // ---------- PICK BEST ----------
    let best = candidates[0]!;
    for (const c of candidates) {
      if (c.score > best.score) best = c;
    }

    deps.emit({
      ts: Date.now(),
      type: "BEST_ENTRY",
      userKey: best.userKey,
      symbol: best.symbol,
      timeframe: best.timeframe,
      side: best.side,
      score: best.score,
      aiBonus: best.aiBonus,
      votes: best.votes,
      strategy,
    });

    // ---------- EXECUTE PHASE ----------
    // We execute the best candidate DIRECTLY using its saved args instead of
    // re-calling evaluateUserSymbol. Re-evaluation fails because the scan phase
    // already mutated the shared stoch state (prevK/prevD), causing crossUp/leftOS
    // to evaluate as impossible (K==K), so triggerOk is always false on the second pass.
    if (atCapacity) {
      return { paper: true, reason: `max capacity (${openCount}/${userMaxConcurrent}); entry disabled` };
    }

    // ── Slippage guard ───────────────────────────────────────────────────────
    // The scan runs every 10 seconds.  By the time the best candidate is
    // selected and we reach this point, the market may have moved.  If the
    // live WebSocket price has deviated more than SLIPPAGE_TOL (0.3%) from
    // the price that triggered the signal, the entry would be at a stale
    // price — we abort instead of chasing.
    //
    // 0.3% is chosen because:
    //   • A 10-second scan lag on a typical altcoin = ~0.05–0.15% drift
    //   • 0.3% allows for normal noise while blocking a genuine gap/spike
    //   • At 10× leverage 0.3% slippage = 3% leveraged PnL degradation —
    //     enough to materially shift the trade's expected value negative
    const SLIPPAGE_TOL = 0.003; // 0.3%
    // Use WS price; fall back to REST if WS is stale (Binance Futures → Bybit)
    const liveNow  = getLatestPrice(best.symbol) ?? await getFallbackPrice(best.symbol).catch(() => null);
    const scanPrice = Number(best.execArgs?.entryPriceWad ?? 0n) / 1e18;
    if (liveNow != null && scanPrice > 0) {
      const slippage = Math.abs(liveNow - scanPrice) / scanPrice;
      if (slippage > SLIPPAGE_TOL) {
        deps.emit({
          ts: Date.now(),
          type: "ENTRY_BLOCKED",
          userKey: best.userKey,
          symbol: best.symbol,
          timeframe: best.timeframe,
          reason: `slippage ${(slippage * 100).toFixed(3)}% > ${(SLIPPAGE_TOL * 100).toFixed(1)}% tolerance (scan=${scanPrice.toFixed(4)} live=${liveNow.toFixed(4)})`,
        });
        log.warn(
          { symbol: best.symbol, scanPrice, liveNow, slippagePct: (slippage * 100).toFixed(3) },
          "[runner] entry blocked — price slipped beyond tolerance since scan"
        );
        return;
      }
    }

    try {
      const result = await deps.executeTrade(best.execArgs);

      // Register the trade in botWorker's activeTrades so the exit logic
      // (stop-loss / profit-reversal) runs correctly on subsequent ticks.
      // Only register if we have a real on-chain txHash — guards against reverted txs
      // that slipped through waitWithFallback without throwing (silent status=0 failure).
      const hasTxHash = !!(result as any)?.txHash;
      if (!hasTxHash && !(result as any)?.paper) {
        log.warn({ symbol: best.symbol, result }, "[runner] executeTrade returned no txHash — trade NOT registered (on-chain tx may have reverted silently)");
      }
      if (hasTxHash && !(result as any)?.paper) {
        registerTradeAfterExecution({
          userKey: best.userKey,
          symbol: best.symbol,
          timeframe: best.timeframe,
          isLong: best.side === "LONG",
          leverage: best.execArgs?.leverage ?? 5,
          sizeWad: best.execArgs?.sizeWad ?? 0n,
          entryPriceWad: best.execArgs?.entryPriceWad ?? 0n,
          redis: deps.redis,   // ← inject Redis so the trade is immediately persisted
        });
      }

      deps.emit({
        ts: Date.now(),
        type: "TRADE_EXECUTED",
        userKey: best.userKey,
        symbol: best.symbol,
        timeframe: best.timeframe,
        side: best.side,
        score: best.score,
        votes: best.votes,
        strategy,
        result,
      });
    } catch (e: any) {
      deps.emit({
        ts: Date.now(),
        type: "BEST_ENTRY_EXEC_FAILED",
        userKey: best.userKey,
        symbol: best.symbol,
        timeframe: best.timeframe,
        error: e?.message ?? String(e),
        strategy,
      });
    }
  }, 10_000);

  // ── Fast-path exit monitor ───────────────────────────────────────────────────
  // Checks active trades every 50ms using live WebSocket prices (getLatestPrice).
  // Reduced from 500ms → 50ms now that the price stream uses @bookTicker (real-time,
  // 10–50 updates/s). The old 500ms interval allowed ETH to fall $8 in a single
  // polling gap, causing exits ~$8 below the 5% trailing-stop floor. At 50ms, the
  // price can only move ~$0.40–$1 between checks — exit slippage is negligible.
  const fastDeps = deps; // same deps object — shares redis, closePosition, emit
  exitMonitorTimer = setInterval(async () => {
    for (const sym of valid) {
      // Primary: Binance WebSocket cache (updated ~10–50×/s per symbol)
      // Fallback: REST price from Binance Futures or Bybit if WS is stale/disconnected.
      // The fallback is cached 800ms internally so REST is called at most ~1×/s per symbol
      // even though this interval fires every 50ms.
      let price = getLatestPrice(sym);
      if (price == null) {
        price = await getFallbackPrice(sym).catch(() => null);
      }
      if (price == null) continue;
      try {
        await fastExitCheck(args.userKey, sym, price, fastDeps);
      } catch {
        // Suppress errors — main 10s scanner is the fallback for any failure
      }
    }
  }, 50);

  return {
    ok: true,
    running: true,
    userKey: args.userKey,
    symbols: valid,
    dropped,
    strategy,
    trigger,
  };
}

/**
 * Engine stop (owned by index.ts)
 */
export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
  if (exitMonitorTimer) clearInterval(exitMonitorTimer);
  exitMonitorTimer = null;
  return { ok: true, running: false };
}

// Backward compatibility (optional): keep old names if other code still imports them
export const startBot = startEngine;
export const stopBot = stopEngine;

