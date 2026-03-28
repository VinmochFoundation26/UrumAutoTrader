/**
 * botWorker.breakout.ts — Donchian Channel Breakout Strategy
 *
 * Entry logic:
 *   - Price breaks above N-period Donchian high (20 bars) → LONG
 *   - Price breaks below N-period Donchian low  (20 bars) → SHORT
 *   - Volume confirmation: latest bar > 1.5× 20-period average
 *   - ATR expansion: current ATR > 1.2× ATR 5 bars ago (momentum building)
 *   - ADX > 20 (trend is forming or established)
 *   - Breakout distance > 0.3% from channel boundary (avoid false breakouts)
 *
 * Exit logic:
 *   - Wide trailing stop: 2% raw (keeps position through normal retracements)
 *   - Staircase: arms at 1% raw, major gate at 5% raw (lock 3%)
 *   - Max hold: 48 hours
 */

import { toWad, divWad, mulWad, type Wad } from "./services/onchain/wad.js";
import { fetchBinanceOHLCV }               from "./services/market/binanceCandles.js";
import { log }                             from "./logger.js";
import {
  saveActiveTrade,
  deleteActiveTrade,
  appendClosedTrade,
  type CachedTrade,
} from "./services/cache/tradeCache.js";
import { recordDailyReturn } from "./services/bot/drawdownGuard.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type UserKey = string;

export type EngineDeps = {
  redis?: any;
  getVaultBalanceWad: (args: { userKey: UserKey; symbol: string; isLong: boolean }) => Promise<Wad>;
  executeTrade: (args: { userKey: UserKey; symbol: string; timeframe: string; isLong: boolean; leverage: number; sizeWad: Wad; entryPriceWad: Wad }) => Promise<any>;
  closePosition: (args: { userKey: UserKey; symbol: string; timeframe: string; exitPriceWad: Wad }) => Promise<any>;
  emit?: (event: Record<string, any>) => void;
  strategy?: string;
  trigger?: Record<string, any>;
};

// ── Config ────────────────────────────────────────────────────────────────────

export type BreakoutConfig = {
  STOP_LOSS_PCT:           number;  // 0.02 = 2% raw (wide for breakouts)
  STAIRCASE_ARM_PCT:       number;  // 0.01 = 1% raw — trail arms here
  STAIRCASE_STEP_PCT:      number;  // 0.01 = 1% raw — give-back per step
  MAJOR_GATE_PCT:          number;  // 0.05 = 5% raw — lock floor permanently
  MAJOR_GATE_FLOOR_PCT:    number;  // 0.03 = 3% raw — floor when major gate hit
  DEFAULT_LEVERAGE:        number;  // 8
  MAX_LEVERAGE:            number;  // 25
  COOLDOWN_SECONDS:        number;  // 1800 = 30 minutes
  MAX_HOLD_SECONDS:        number;  // 172800 = 48 hours
  DONCHIAN_PERIOD:         number;  // 20
  VOLUME_MULT:             number;  // 1.5
  ATR_PERIOD:              number;  // 14
  ATR_EXPANSION_MULT:      number;  // 1.2
  ATR_EXPANSION_LOOKBACK:  number;  // 5 bars back
  ADX_MIN:                 number;  // 20
  MIN_BREAKOUT_PCT:        number;  // 0.003 = 0.3%
  MANUAL_SIZE_PCT:         number;  // 0 = auto
};

const DEFAULT_CFG: BreakoutConfig = {
  STOP_LOSS_PCT:           0.02,
  STAIRCASE_ARM_PCT:       0.01,
  STAIRCASE_STEP_PCT:      0.01,
  MAJOR_GATE_PCT:          0.05,
  MAJOR_GATE_FLOOR_PCT:    0.03,
  DEFAULT_LEVERAGE:        8,
  MAX_LEVERAGE:            25,
  COOLDOWN_SECONDS:        1800,
  MAX_HOLD_SECONDS:        172800,
  DONCHIAN_PERIOD:         20,
  VOLUME_MULT:             1.5,
  ATR_PERIOD:              14,
  ATR_EXPANSION_MULT:      1.2,
  ATR_EXPANSION_LOOKBACK:  5,
  ADX_MIN:                 20,
  MIN_BREAKOUT_PCT:        0.003,
  MANUAL_SIZE_PCT:         0,
};

// ── In-module state ───────────────────────────────────────────────────────────

type ActiveTrade = {
  userKey:         string;
  symbol:          string;
  timeframe:       string;
  isLong:          boolean;
  leverage:        number;
  entryPriceWad:   Wad;
  bestPriceWad:    Wad;
  pendingBestWad:  Wad;
  sizeWad:         Wad;
  openedAtMs:      number;
  majorGateHit:    boolean;
  closing:         boolean;
};

const activeTrades = new Map<string, ActiveTrade>();
const lastActionAt = new Map<string, number>();
const lastCandleAt = new Map<string, number>();

function posKey(userKey: string, symbol: string) { return `${userKey}:${symbol}`; }
function candleKey(userKey: string, symbol: string, tf: string) { return `${userKey}:${symbol}:${tf}`; }

function emit(deps: EngineDeps, e: Record<string, any>) {
  deps.emit?.({ ts: Date.now(), strategy: "breakout", ...e });
}

// ── Indicators ────────────────────────────────────────────────────────────────

function donchian(highs: number[], lows: number[], period = 20): { channelHigh: number; channelLow: number } | null {
  if (highs.length < period + 1) return null;
  // Use prior period (exclude last bar) to detect fresh breakout on current bar
  const prevHighs = highs.slice(-period - 1, -1);
  const prevLows  = lows.slice(-period - 1, -1);
  return {
    channelHigh: Math.max(...prevHighs),
    channelLow:  Math.min(...prevLows),
  };
}

function atrClose(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += Math.abs(closes[i]! - closes[i - 1]!);
  return sum / period;
}

function volumeSpike(vols: number[], period = 20, mult = 1.5): boolean {
  if (vols.length < period + 1) return true;
  const avg = vols.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  return vols[vols.length - 1]! >= avg * mult;
}

function adx(
  highs: number[], lows: number[], closes: number[], period = 14,
): { adx: number } | null {
  const n = highs.length;
  if (n < period * 2 + 2) return null;
  const tr: number[] = [], pdm: number[] = [], mdm: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = highs[i]!, l = lows[i]!, pc = closes[i - 1]!;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = highs[i]! - highs[i - 1]!, dn = lows[i - 1]! - lows[i]!;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdm.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdm.slice(0, period).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  for (let i = period; i < tr.length; i++) {
    sTR  = sTR  - sTR  / period + tr[i]!;
    sPDM = sPDM - sPDM / period + pdm[i]!;
    sMDM = sMDM - sMDM / period + mdm[i]!;
    if (sTR === 0) continue;
    const pDI = (sPDM / sTR) * 100, mDI = (sMDM / sTR) * 100;
    const s = pDI + mDI;
    dx.push(s === 0 ? 0 : (Math.abs(pDI - mDI) / s) * 100);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]!) / period;
  return { adx: adxVal };
}

// ── Exit logic (staircase) ────────────────────────────────────────────────────

function movePct(t: ActiveTrade, priceWad: Wad): number {
  return t.isLong
    ? Number(divWad(priceWad - t.entryPriceWad, t.entryPriceWad))
    : Number(divWad(t.entryPriceWad - priceWad, t.entryPriceWad));
}

function updateBest(t: ActiveTrade, priceWad: Wad): void {
  if (t.isLong) {
    if (t.pendingBestWad > t.bestPriceWad && priceWad >= t.pendingBestWad)
      t.bestPriceWad = t.pendingBestWad;
    if (priceWad > t.pendingBestWad) t.pendingBestWad = priceWad;
  } else {
    if (t.pendingBestWad < t.bestPriceWad && priceWad <= t.pendingBestWad)
      t.bestPriceWad = t.pendingBestWad;
    if (priceWad < t.pendingBestWad) t.pendingBestWad = priceWad;
  }
}

function shouldExit(t: ActiveTrade, priceWad: Wad, cfg: BreakoutConfig, advanceBest = true): boolean {
  const rawMove = movePct(t, priceWad);

  // Hard stop
  if (rawMove <= -cfg.STOP_LOSS_PCT) return true;

  // Max hold
  if (Date.now() - t.openedAtMs > cfg.MAX_HOLD_SECONDS * 1000) return true;

  if (advanceBest) updateBest(t, priceWad);

  const bestRaw = t.isLong
    ? Number(divWad(t.bestPriceWad - t.entryPriceWad, t.entryPriceWad))
    : Number(divWad(t.entryPriceWad - t.bestPriceWad, t.entryPriceWad));

  // Major gate check — lock floor permanently
  if (bestRaw >= cfg.MAJOR_GATE_PCT) t.majorGateHit = true;

  if (rawMove < cfg.STAIRCASE_ARM_PCT) return false;

  // Staircase floor
  const stepFloor = Math.max(cfg.STAIRCASE_ARM_PCT, bestRaw - cfg.STAIRCASE_STEP_PCT);
  const floor     = t.majorGateHit
    ? Math.max(stepFloor, cfg.MAJOR_GATE_FLOOR_PCT)
    : stepFloor;

  return rawMove < floor;
}

// ── Restore / register ────────────────────────────────────────────────────────

export async function restoreState(redis: any, userKey: string, symbols: string[]): Promise<void> {
  const { loadActiveTrades } = await import("./services/cache/tradeCache.js");
  const cached = await loadActiveTrades(redis, userKey, symbols);
  for (const [key, ct] of cached) {
    if (!activeTrades.has(key)) {
      activeTrades.set(key, {
        userKey:        ct.userKey,
        symbol:         ct.symbol,
        timeframe:      ct.timeframe,
        isLong:         ct.isLong,
        leverage:       ct.leverage,
        entryPriceWad:  BigInt(ct.entryPriceWad),
        bestPriceWad:   BigInt(ct.bestPriceWad),
        pendingBestWad: ct.pendingBestWad ? BigInt(ct.pendingBestWad) : BigInt(ct.bestPriceWad),
        sizeWad:        BigInt(ct.sizeWad),
        openedAtMs:     ct.openedAtMs ?? Date.now(),
        majorGateHit:   false,
        closing:        false,
      });
      log.info({ symbol: ct.symbol }, "[breakout] trade restored from Redis");
    }
  }
}

export function registerTradeAfterExecution(args: {
  userKey:       string;
  symbol:        string;
  timeframe:     string;
  isLong:        boolean;
  leverage:      number;
  sizeWad:       bigint;
  entryPriceWad: bigint;
  openedAtMs?:   number;
  redis?:        any;
}) {
  const pk = posKey(args.userKey, args.symbol);
  if (activeTrades.has(pk)) return;

  const trade: ActiveTrade = {
    userKey:        args.userKey,
    symbol:         args.symbol,
    timeframe:      args.timeframe,
    isLong:         args.isLong,
    leverage:       args.leverage,
    entryPriceWad:  args.entryPriceWad,
    bestPriceWad:   args.entryPriceWad,
    pendingBestWad: args.entryPriceWad,
    sizeWad:        args.sizeWad,
    openedAtMs:     args.openedAtMs ?? Date.now(),
    majorGateHit:   false,
    closing:        false,
  };
  activeTrades.set(pk, trade);
  lastActionAt.set(pk, Date.now());

  if (args.redis) {
    const cached: CachedTrade = {
      userKey: trade.userKey, symbol: trade.symbol, timeframe: trade.timeframe,
      isLong: trade.isLong, leverage: trade.leverage,
      entryPriceWad:  trade.entryPriceWad.toString(),
      bestPriceWad:   trade.bestPriceWad.toString(),
      pendingBestWad: trade.pendingBestWad.toString(),
      sizeWad:        trade.sizeWad.toString(),
      openedAtMs:     trade.openedAtMs,
      pending: false,
    };
    saveActiveTrade(args.redis, args.userKey, args.symbol, cached).catch(() => {});
  }
  log.info({ symbol: args.symbol, isLong: args.isLong }, "[breakout] trade registered");
}

// ── Fast exit monitor ─────────────────────────────────────────────────────────

export async function fastExitCheck(
  userKey:   string,
  symbol:    string,
  livePrice: number,
  deps: Pick<EngineDeps, "closePosition" | "emit" | "redis">,
): Promise<void> {
  const pk    = posKey(userKey, symbol);
  const trade = activeTrades.get(pk);
  if (!trade || trade.closing) return;

  const cfg      = DEFAULT_CFG;
  const priceWad = toWad(livePrice);
  const rawMove  = movePct(trade, priceWad);

  let shouldClose = false, reason = "";
  if (rawMove <= -cfg.STOP_LOSS_PCT) { shouldClose = true; reason = "STOP_LOSS"; }
  else if (Date.now() - trade.openedAtMs > cfg.MAX_HOLD_SECONDS * 1000) { shouldClose = true; reason = "MAX_HOLD"; }
  else if (rawMove >= cfg.STAIRCASE_ARM_PCT) {
    const bestRaw = trade.isLong
      ? Number(divWad(trade.bestPriceWad - trade.entryPriceWad, trade.entryPriceWad))
      : Number(divWad(trade.entryPriceWad - trade.bestPriceWad, trade.entryPriceWad));
    const floor = trade.majorGateHit
      ? Math.max(cfg.STAIRCASE_ARM_PCT, Math.max(bestRaw - cfg.STAIRCASE_STEP_PCT, cfg.MAJOR_GATE_FLOOR_PCT))
      : Math.max(cfg.STAIRCASE_ARM_PCT, bestRaw - cfg.STAIRCASE_STEP_PCT);
    if (rawMove < floor) { shouldClose = true; reason = "STAIRCASE"; }
  }

  if (!shouldClose) return;

  trade.closing = true;
  try {
    await deps.closePosition({ userKey, symbol, timeframe: trade.timeframe, exitPriceWad: priceWad });
    activeTrades.delete(pk);
    if (deps.redis) await deleteActiveTrade(deps.redis, userKey, symbol);
    const pnlLev   = rawMove * trade.leverage;
    const closedAt = Date.now();
    if (deps.redis) await recordDailyReturn(deps.redis, userKey, pnlLev).catch(() => {});
    if (deps.redis) await appendClosedTrade(deps.redis, userKey, {
      symbol,
      isLong:     trade.isLong,
      entryPrice: Number(trade.entryPriceWad) / 1e18,
      exitPrice:  livePrice,
      pnlPct:     rawMove,
      leverage:   trade.leverage,
      durationMs: closedAt - trade.openedAtMs,
      reason,
      closedAt,
      timeframe:  trade.timeframe,
      strategy:   "breakout",
      openedAtMs: trade.openedAtMs,
    }).catch(() => {});
    deps.emit?.({ ts: Date.now(), type: "FAST_EXIT", strategy: "breakout", userKey, symbol, reason, pnlLev, livePrice });
    log.info({ symbol, reason, pnlLev }, "[breakout] fast exit");
  } catch (e: any) {
    trade.closing = false;
    deps.emit?.({ ts: Date.now(), type: "FAST_EXIT_ERROR", strategy: "breakout", userKey, symbol, error: e?.message });
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

export async function evaluateUserSymbol(
  deps: EngineDeps & { redis?: any },
  args: { userKey: UserKey; symbol: string; timeframe: string; requestedLeverage?: number },
) {
  const { userKey, symbol, timeframe } = args;
  const cfg = DEFAULT_CFG;
  const pk  = posKey(userKey, symbol);
  const ck  = candleKey(userKey, symbol, timeframe);

  // ── Open trade exit check ─────────────────────────────────────────────────
  const trade = activeTrades.get(pk);
  if (trade && !trade.closing) {
    let ohlcv;
    try { ohlcv = await fetchBinanceOHLCV({ symbol, interval: timeframe, limit: 80 }); } catch { return; }
    const closes  = ohlcv.closes;
    const price   = closes[closes.length - 1]!;
    const priceWad = toWad(price);
    if (shouldExit(trade, priceWad, cfg)) {
      trade.closing = true;
      try {
        await deps.closePosition({ userKey, symbol, timeframe: trade.timeframe, exitPriceWad: priceWad });
        activeTrades.delete(pk);
        if (deps.redis) await deleteActiveTrade(deps.redis, userKey, symbol);
        const rawMove  = movePct(trade, priceWad);
        const pnlLev   = rawMove * trade.leverage;
        const closedAt = Date.now();
        const reason   = rawMove <= -cfg.STOP_LOSS_PCT ? "STOP_LOSS"
                       : closedAt - trade.openedAtMs > cfg.MAX_HOLD_SECONDS * 1000 ? "MAX_HOLD"
                       : "STAIRCASE";
        if (deps.redis) await recordDailyReturn(deps.redis, userKey, pnlLev).catch(() => {});
        if (deps.redis) await appendClosedTrade(deps.redis, userKey, {
          symbol,
          isLong:     trade.isLong,
          entryPrice: Number(trade.entryPriceWad) / 1e18,
          exitPrice:  price,
          pnlPct:     rawMove,
          leverage:   trade.leverage,
          durationMs: closedAt - trade.openedAtMs,
          reason,
          closedAt,
          timeframe:  trade.timeframe,
          strategy:   "breakout",
          openedAtMs: trade.openedAtMs,
        }).catch(() => {});
        emit(deps, { type: "TRADE_CLOSED", userKey, symbol, reason, pnlLev });
        lastActionAt.set(pk, Date.now());
      } catch (e: any) {
        trade.closing = false;
        emit(deps, { type: "CLOSE_FAILED", userKey, symbol, error: e?.message });
      }
    }
    return;
  }

  // ── Cooldown ──────────────────────────────────────────────────────────────
  const lastAct = lastActionAt.get(pk) ?? 0;
  if (Date.now() - lastAct < cfg.COOLDOWN_SECONDS * 1000) return;

  // ── Fetch OHLCV ───────────────────────────────────────────────────────────
  let ohlcv;
  try {
    ohlcv = await fetchBinanceOHLCV({ symbol, interval: timeframe, limit: 120 });
  } catch (e: any) {
    emit(deps, { type: "FETCH_ERROR", userKey, symbol, timeframe, error: e?.message });
    return;
  }

  const { highs, lows, closes, volumes, closeTimesMs } = ohlcv;

  const latestCloseMs = closeTimesMs[closeTimesMs.length - 1] ?? 0;
  if (lastCandleAt.get(ck) === latestCloseMs) return;
  lastCandleAt.set(ck, latestCloseMs);

  if (closes.length < 60) return;

  // ── Compute signals ────────────────────────────────────────────────────────
  const dc      = donchian(highs, lows, cfg.DONCHIAN_PERIOD);
  const atrNow  = atrClose(closes, cfg.ATR_PERIOD);
  const atrPrev = atrClose(closes.slice(0, -cfg.ATR_EXPANSION_LOOKBACK), cfg.ATR_PERIOD);
  const adxData = adx(highs, lows, closes, 14);
  const volOk   = volumeSpike(volumes, 20, cfg.VOLUME_MULT);
  const price   = closes[closes.length - 1]!;

  if (!dc || atrNow == null) return;

  const atrExpanding = atrPrev == null || atrNow >= atrPrev * cfg.ATR_EXPANSION_MULT;
  const trendForming = adxData == null || adxData.adx >= cfg.ADX_MIN;

  const breakoutUp   = price > dc.channelHigh && (price - dc.channelHigh) / dc.channelHigh >= cfg.MIN_BREAKOUT_PCT;
  const breakoutDown = price < dc.channelLow  && (dc.channelLow - price)  / dc.channelLow  >= cfg.MIN_BREAKOUT_PCT;

  let isLong: boolean | null = null;
  let reason = "";

  if (volOk && atrExpanding && trendForming) {
    if (breakoutUp) {
      isLong = true;
      reason = `breakout above Donchian high ${dc.channelHigh.toFixed(4)}, price=${price.toFixed(4)}, ATR expanding, ADX=${adxData?.adx.toFixed(1) ?? "N/A"}`;
    } else if (breakoutDown) {
      isLong = false;
      reason = `breakout below Donchian low ${dc.channelLow.toFixed(4)}, price=${price.toFixed(4)}, ATR expanding, ADX=${adxData?.adx.toFixed(1) ?? "N/A"}`;
    }
  }

  const longVotes  = breakoutUp   ? 1 : 0;
  const shortVotes = breakoutDown ? 1 : 0;

  emit(deps, {
    type: "VOTES", userKey, symbol, timeframe, strategy: "breakout",
    decided: isLong === null ? "NONE" : isLong ? "LONG" : "SHORT",
    atrPct: atrNow / price,
    votes: {
      longVotes, shortVotes, required: 1, reason,
      donchianHigh: dc.channelHigh, donchianLow: dc.channelLow,
      adx: adxData?.adx,
    },
  });

  if (isLong === null) return;

  // ── Size ──────────────────────────────────────────────────────────────────
  const leverage = Math.min(cfg.DEFAULT_LEVERAGE, cfg.MAX_LEVERAGE);
  const priceWad = toWad(price);
  let sizeWad: Wad;
  try {
    const balWad  = await deps.getVaultBalanceWad({ userKey, symbol, isLong });
    const sizePct = cfg.MANUAL_SIZE_PCT > 0 ? cfg.MANUAL_SIZE_PCT : 0.15;
    sizeWad = (balWad * BigInt(Math.round(sizePct * 10000))) / 10000n;
    if (sizeWad === 0n) { emit(deps, { type: "ENTRY_SKIPPED", userKey, symbol, reason: "zero balance" }); return; }
  } catch (e: any) {
    emit(deps, { type: "ENTRY_SKIPPED", userKey, symbol, reason: `balance fetch error: ${e?.message}` });
    return;
  }

  emit(deps, { type: "ENTRY_SIGNAL", userKey, symbol, timeframe, isLong, leverage, reason, strategy: "breakout" });

  // ── Execute ────────────────────────────────────────────────────────────────
  try {
    const result = await deps.executeTrade({ userKey, symbol, timeframe, isLong, leverage, sizeWad, entryPriceWad: priceWad });
    if ((result as any)?.txHash) {
      registerTradeAfterExecution({ userKey, symbol, timeframe, isLong, leverage, sizeWad, entryPriceWad: priceWad, redis: deps.redis });
      lastActionAt.set(pk, Date.now());
      emit(deps, { type: "TRADE_EXECUTED", userKey, symbol, timeframe, isLong, leverage, strategy: "breakout", result });
    }
  } catch (e: any) {
    emit(deps, { type: "TRADE_FAILED", userKey, symbol, error: e?.message, strategy: "breakout" });
  }
}
