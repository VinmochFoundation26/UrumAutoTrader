/**
 * botWorkerInstance.ts — Per-User Isolated Bot Worker
 *
 * Each user who starts the bot gets their own BotWorkerInstance. The instance
 * owns its own setInterval timers (10s scan + 50ms exit monitor) and its own
 * circuit-breaker state, completely isolating users from each other.
 *
 * The underlying botWorker module (trend_range_fork) is already safe for
 * concurrent users because all Maps use `${userKey}:${symbol}` composite keys.
 * The only isolation needed is at the timer level — which this class provides.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   const instance = new BotWorkerInstance(userKey, symbols, trigger, deps);
 *   await instance.start();
 *   instance.stop();
 *   instance.getStatus();
 */

import fs from "node:fs";
import path from "node:path";

import {
  evaluateUserSymbol as evalTrendRangeFork,
  registerTradeAfterExecution,
  restoreState,
  fastExitCheck,
} from "../../botWorker.trend_range_fork.js";
import { getLatestPrice } from "../market/priceStream.js";
import { makeEngineDeps } from "./deps.js";
import type { EngineDeps } from "./deps.js";
import {
  getVaultContract,
  getVaultReadContract,
  getFallbackProvider,
  getVaultAddress,
  VAULT_ABI,
} from "../onchain/contractInstance.js";
import { Contract, keccak256, toUtf8Bytes } from "ethers";
import { log } from "../../logger.js";
import { checkCircuitBreaker } from "./drawdownGuard.js";
import { extractFeatures, getAiScore } from "../ai/signalScorer.js";
import { reconcilePendingTxs } from "../onchain/txTracker.js";
import { getUsdmFuturesSymbols } from "../market/binanceCandles.js";

// ── Shared types ──────────────────────────────────────────────────────────────

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
  atrPct?: number;
  votes: {
    longVotes: number;
    shortVotes: number;
    required: number;
    [k: string]: any;
  };
};

type EntryCandidate = {
  userKey: string;
  symbol: string;
  timeframe: string;
  side: "LONG" | "SHORT";
  score: number;
  aiBonus: number;
  execArgs: any;
  votes: VotesEvent["votes"];
};

type BotConfig = {
  TIMEFRAMES: string[];
  DEFAULT_LEVERAGE?: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const TF_WEIGHT: Record<string, number> = {
  "5m": 1.0,
  "15m": 1.15,
  "1h": 1.25,
  "4h": 1.35,
};

const MAX_CONCURRENT_TRADES = 3;

// ── Helpers (mirrors runner.ts private helpers) ───────────────────────────────

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

function scoreCandidate(v: VotesEvent, side: "LONG" | "SHORT"): number {
  const winning  = side === "LONG" ? v.votes.longVotes  : v.votes.shortVotes;
  const losing   = side === "LONG" ? v.votes.shortVotes : v.votes.longVotes;
  const margin   = winning - losing;
  const required = v.votes.required;

  const base        = winning;
  const marginBonus = margin * 0.35;
  const exceedBonus = Math.max(0, winning - required) * 0.6;
  const w           = TF_WEIGHT[v.timeframe] ?? 1.0;

  return (base + marginBonus + exceedBonus) * w;
}

async function getOpenCount(userKey: string): Promise<number> {
  try {
    const vault = getVaultReadContract();
    const count = await (vault as any).openCount(userKey);
    return Number(count);
  } catch (primaryErr: any) {
    const fallback = getFallbackProvider();
    if (!fallback) throw primaryErr;
    log.warn({ err: primaryErr?.message }, "[botWorkerInstance] primary RPC openCount failed — using fallback");
    const c = new Contract(getVaultAddress(), VAULT_ABI, fallback);
    return Number(await (c as any).openCount(userKey));
  }
}

async function recoverOpenPositions(
  userKey:  string,
  symbols:  string[],
  leverage: number,
  deps:     any,
): Promise<void> {
  try {
    const vault   = getVaultContract();
    const markets: string[] = await (vault as any).getOpenMarkets(userKey);
    if (!markets.length) return;

    const idToSymbol = new Map<string, string>();
    for (const sym of symbols) idToSymbol.set(keccak256(toUtf8Bytes(sym)), sym);

    for (const marketId of markets) {
      const sym = idToSymbol.get(marketId);
      if (!sym) continue;

      const pos = await (vault as any).positionOf(userKey, marketId);
      if (!pos.isOpen) continue;

      const entryPriceWad = BigInt(pos.entryPriceX18.toString());
      const sizeWad       = BigInt(pos.sizeX18.toString());

      registerTradeAfterExecution({
        userKey,
        symbol:       sym,
        timeframe:    "5m",
        isLong:       pos.isLong,
        leverage,
        sizeWad,
        entryPriceWad,
        openedAtMs:   Number(pos.openedAt) * 1000,
        redis:        deps.redis,
      });

      deps.emit({
        ts: Date.now(), type: "POSITION_RECOVERED",
        userKey, symbol: sym, isLong: pos.isLong,
        entryPrice: Number(entryPriceWad) / 1e18,
        size:       Number(sizeWad)       / 1e18,
      });
    }
  } catch (e: any) {
    deps.emit({ ts: Date.now(), type: "RECOVERY_FAILED", userKey, error: e?.message ?? String(e) });
  }
}

// ── BotWorkerInstance ─────────────────────────────────────────────────────────

export class BotWorkerInstance {
  // ── Instance state ──────────────────────────────────────────────────────────
  private timer:                   NodeJS.Timeout | null = null;
  private exitMonitorTimer:        NodeJS.Timeout | null = null;
  private lastCircuitBreakerDate = "";
  private startedAt              = 0;
  private validSymbols:            string[]              = [];
  private dropped:                 string[]              = [];

  // ── Constructor params ──────────────────────────────────────────────────────
  readonly userKey:  string;
  private symbols:   string[];
  private trigger:   TriggerConfig;
  private deps:      EngineDeps;

  constructor(userKey: string, symbols: string[], trigger: TriggerConfig, deps: EngineDeps) {
    this.userKey  = userKey;
    this.symbols  = symbols;
    this.trigger  = trigger;
    this.deps     = deps;
  }

  // ── start() ─────────────────────────────────────────────────────────────────

  async start(): Promise<{
    ok: boolean;
    running: boolean;
    symbols?:  string[];
    dropped?:  string[];
    error?:    string;
  }> {
    if (this.timer) {
      return { ok: true, running: true, symbols: this.validSymbols, dropped: this.dropped };
    }

    const cfg      = loadConfig();
    const strategy = "trend_range_fork" as const;
    const trigger  = this.trigger;
    const deps     = this.deps;
    const userKey  = this.userKey;

    // Attach strategy / trigger so botWorker can read them via deps
    (deps as any).strategy = strategy;
    (deps as any).trigger  = trigger;

    // ── Symbol validation ────────────────────────────────────────────────────
    const requested = this.symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    let valid   = requested;
    let dropped: string[] = [];

    try {
      const allowed = await getUsdmFuturesSymbols();
      valid   = requested.filter(s => allowed.has(s));
      dropped = requested.filter(s => !allowed.has(s));

      if (dropped.length) {
        deps.emit({ ts: Date.now(), type: "SYMBOLS_DROPPED", userKey, dropped });
      }
      if (!valid.length) {
        return { ok: false, running: false, error: "No valid USD-M futures symbols after validation" };
      }
    } catch (e: any) {
      deps.emit({
        ts: Date.now(), type: "SYMBOL_VALIDATION_SKIPPED", userKey,
        reason: "exchangeInfo fetch failed; using requested symbols as-is",
        error: e?.message ?? String(e),
      });
    }

    this.validSymbols = valid;
    this.dropped      = dropped;

    // ── TX reconciliation (Phase 1) ──────────────────────────────────────────
    if (deps.redis) {
      try {
        const { getProvider } = await import("../onchain/contractInstance.js");
        await reconcilePendingTxs(deps.redis, getProvider());
      } catch (e: any) {
        log.warn({ err: e?.message, userKey }, "[botWorkerInstance] txTracker reconciliation failed (non-fatal)");
      }
    }

    // ── State restore from Redis ─────────────────────────────────────────────
    log.info({ userKey, symbols: valid }, "[botWorkerInstance] restoring state from Redis");
    await restoreState(deps.redis, userKey, valid);

    // ── On-chain position recovery ───────────────────────────────────────────
    log.info({ userKey }, "[botWorkerInstance] recovering on-chain positions");
    await recoverOpenPositions(userKey, valid, cfg.DEFAULT_LEVERAGE ?? 10, deps);

    this.startedAt = Date.now();

    // ── 10-second scan timer ─────────────────────────────────────────────────
    this.timer = setInterval(async () => {

      // ── Circuit breaker ────────────────────────────────────────────────────
      if (deps.redis) {
        try {
          const maxLoss = Math.abs(Number(process.env.MAX_DAILY_LOSS_PCT ?? "0.10"));
          const cb      = await checkCircuitBreaker(deps.redis, userKey, maxLoss);
          if (cb.triggered) {
            if (this.lastCircuitBreakerDate !== cb.date) {
              this.lastCircuitBreakerDate = cb.date;
              deps.emit({
                ts: Date.now(), type: "CIRCUIT_BREAKER_TRIGGERED",
                userKey, dailyReturn: cb.dailyReturn, limit: cb.limit, date: cb.date,
                reason: `Daily levered loss ${(cb.dailyReturn * 100).toFixed(1)}% exceeded limit ${(cb.limit * 100).toFixed(1)}%`,
              });
            }
            return; // skip tick — engine stays alive, auto-resumes at UTC midnight
          }
        } catch (e: any) {
          log.warn({ err: e?.message, userKey }, "[botWorkerInstance] circuit breaker check failed (non-fatal)");
        }
      }

      // ── Open position count ────────────────────────────────────────────────
      let openCount  = 0;
      let atCapacity = false;
      try {
        openCount  = await getOpenCount(userKey);
        atCapacity = openCount >= MAX_CONCURRENT_TRADES;
        if (atCapacity) {
          deps.emit({
            ts: Date.now(), type: "ENTRY_BLOCKED", userKey, openCount,
            reason: `max concurrent positions reached (${openCount}/${MAX_CONCURRENT_TRADES}); new entries blocked`,
          });
        }
      } catch (e: any) {
        deps.emit({
          ts: Date.now(), type: "POSITION_CHECK_FAILED",
          userKey, error: e?.message ?? String(e),
        });
        return;
      }

      // ── SCAN PHASE — collect candidates, no execution ─────────────────────
      const lastVotesByKey = new Map<string, VotesEvent>();
      const candidates: EntryCandidate[] = [];

      const scanDeps = {
        ...deps,
        strategy,
        trigger,

        emit: (e: Record<string, any>) => {
          deps.emit(e);
          if (e?.type === "VOTES" && e?.symbol && e?.timeframe) {
            lastVotesByKey.set(`${e.symbol}:${e.timeframe}`, e as VotesEvent);
          }
        },

        // Intercept executeTrade during scan — store candidate, don't send tx
        executeTrade: async (execArgs: any) => {
          const symbol    = String(execArgs?.symbol    ?? "");
          const timeframe = String(execArgs?.timeframe ?? "");
          const v         = lastVotesByKey.get(`${symbol}:${timeframe}`);

          if (!v || (v.decided !== "LONG" && v.decided !== "SHORT")) {
            return { paper: true, reason: "no votes captured for scoring" };
          }

          const side   = v.decided;
          const base   = scoreCandidate(v, side);

          // AI bonus (Phase 3)
          let aiBonus = 0;
          if (deps.redis) {
            try {
              const features = extractFeatures(v.votes, v.atrPct ?? 0);
              const ai       = await getAiScore(deps.redis, features, side);
              aiBonus        = ai.bonus;
              log.debug(
                { userKey, symbol, side, aiKey: ai.featureKey,
                  winRate: ai.bayesianWinRate.toFixed(2),
                  confidence: ai.confidence.toFixed(2),
                  bonus: ai.bonus.toFixed(3) },
                "[botWorkerInstance] AI score",
              );
            } catch { /* non-blocking */ }
          }

          const score = base + aiBonus;
          candidates.push({ userKey, symbol, timeframe, side, score, aiBonus, execArgs, votes: v.votes });

          deps.emit({
            ts: Date.now(), type: "CANDIDATE_FOUND",
            userKey, symbol, timeframe, side, score, aiBonus, votes: v.votes, strategy,
          });

          return { paper: true, intercepted: true };
        },
      };

      // Scan all symbols — regime TFs first (1h), then entry TF (5m)
      const ENTRY_TF  = "5m";
      const regimeTfs = cfg.TIMEFRAMES.filter((tf: string) => tf !== ENTRY_TF);
      const hasEntry  = cfg.TIMEFRAMES.includes(ENTRY_TF);

      const scanOne = async (tf: string, sym: string) => {
        try {
          await evalTrendRangeFork(scanDeps as any, { userKey, symbol: sym, timeframe: tf });
        } catch (e: any) {
          deps.emit({
            ts: Date.now(), type: "SCAN_ERROR",
            userKey, symbol: sym, timeframe: tf,
            error: e?.message ?? String(e),
            stack: e?.stack  ?? null,
            strategy,
          });
        }
      };

      for (const sym of valid) {
        for (const tf of regimeTfs) await scanOne(tf, sym);
        if (hasEntry) await scanOne(ENTRY_TF, sym);
      }

      if (!candidates.length) return;

      // ── PICK BEST ─────────────────────────────────────────────────────────
      let best = candidates[0]!;
      for (const c of candidates) if (c.score > best.score) best = c;

      deps.emit({
        ts: Date.now(), type: "BEST_ENTRY",
        userKey: best.userKey, symbol: best.symbol,
        timeframe: best.timeframe, side: best.side,
        score: best.score, aiBonus: best.aiBonus,
        votes: best.votes, strategy,
      });

      if (atCapacity) return;

      // ── EXECUTE BEST ──────────────────────────────────────────────────────
      try {
        const result     = await deps.executeTrade(best.execArgs);
        const hasTxHash  = !!(result as any)?.txHash;

        if (!hasTxHash && !(result as any)?.paper) {
          log.warn(
            { userKey, symbol: best.symbol, result },
            "[botWorkerInstance] executeTrade returned no txHash — trade NOT registered (possible silent revert)",
          );
        }

        if (hasTxHash && !(result as any)?.paper) {
          registerTradeAfterExecution({
            userKey:       best.userKey,
            symbol:        best.symbol,
            timeframe:     best.timeframe,
            isLong:        best.side === "LONG",
            leverage:      best.execArgs?.leverage      ?? 5,
            sizeWad:       best.execArgs?.sizeWad       ?? 0n,
            entryPriceWad: best.execArgs?.entryPriceWad ?? 0n,
            redis:         deps.redis,
          });
        }

        deps.emit({
          ts: Date.now(), type: "TRADE_EXECUTED",
          userKey: best.userKey, symbol: best.symbol,
          timeframe: best.timeframe, side: best.side,
          score: best.score, votes: best.votes, strategy, result,
        });
      } catch (e: any) {
        deps.emit({
          ts: Date.now(), type: "BEST_ENTRY_EXEC_FAILED",
          userKey: best.userKey, symbol: best.symbol,
          timeframe: best.timeframe,
          error: e?.message ?? String(e), strategy,
        });
      }

    }, 10_000);

    // ── 50ms exit monitor ────────────────────────────────────────────────────
    // Checks active trades at high frequency using live WebSocket prices.
    this.exitMonitorTimer = setInterval(async () => {
      for (const sym of valid) {
        const price = getLatestPrice(sym);
        if (price == null) continue;
        try {
          await fastExitCheck(userKey, sym, price, deps);
        } catch {
          // Suppress — 10s scanner is the fallback
        }
      }
    }, 50);

    log.info({ userKey, symbols: valid, dropped }, "[botWorkerInstance] worker started");
    return { ok: true, running: true, symbols: valid, dropped };
  }

  // ── stop() ──────────────────────────────────────────────────────────────────

  stop(): { ok: boolean; running: boolean } {
    if (this.timer)            { clearInterval(this.timer);            this.timer            = null; }
    if (this.exitMonitorTimer) { clearInterval(this.exitMonitorTimer); this.exitMonitorTimer = null; }
    log.info({ userKey: this.userKey }, "[botWorkerInstance] worker stopped");
    return { ok: true, running: false };
  }

  // ── status ──────────────────────────────────────────────────────────────────

  isRunning(): boolean {
    return this.timer !== null;
  }

  getStatus() {
    return {
      userKey:    this.userKey,
      running:    this.isRunning(),
      startedAt:  this.startedAt,
      uptimeMs:   this.startedAt ? Date.now() - this.startedAt : 0,
      symbols:    this.validSymbols,
      dropped:    this.dropped,
    };
  }
}
