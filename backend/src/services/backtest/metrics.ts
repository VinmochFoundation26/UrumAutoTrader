/**
 * metrics.ts — Hedge-fund grade performance metrics
 *
 * Computes from an array of closed trade records:
 *   - Win rate (% winning trades)
 *   - Profit factor (gross win / gross loss, leveraged)
 *   - Max drawdown (worst peak-to-trough on equity curve)
 *   - Sharpe ratio (annualized, per-trade returns)
 *   - Average trade duration
 *   - Total and average PnL%
 *
 * All PnL percentages are stored unlevered (e.g. 0.03 = 3% move).
 * Leverage is applied here when computing equity curve and Sharpe.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClosedTradeRecord = {
  symbol:      string;
  isLong:      boolean;
  entryPrice:  number;
  exitPrice:   number;
  pnlPct:      number;   // unlevered decimal (e.g. 0.03 = +3%, -0.03 = -3%)
  leverage:    number;
  durationMs:  number;
  reason:      string;   // "STOP_LOSS" | "PROFIT_REVERSAL" | "END_OF_DATA"
  closedAt:    number;   // epoch ms
};

export type BacktestMetrics = {
  totalTrades:   number;
  winCount:      number;
  lossCount:     number;
  winRate:       number;    // 0–1
  profitFactor:  number;    // grossWin / grossLoss (leveraged); Infinity if no losses
  maxDrawdown:   number;    // 0–1 worst peak-to-trough on equity curve
  sharpeRatio:   number;    // annualized (per-trade, leveraged)
  avgDurationMs: number;    // mean trade hold time in ms
  totalPnlPct:   number;    // sum of all levered PnL% (equity return from $1)
  avgPnlPct:     number;    // mean levered PnL% per trade
  bestTrade:     number;    // best single trade levered PnL%
  worstTrade:    number;    // worst single trade levered PnL%
};

// ── Public entry-point ────────────────────────────────────────────────────────

/**
 * Compute all metrics from an array of closed trade records.
 * Leverage from each record is applied individually (supports mixed leverage).
 */
export function computeMetrics(trades: ClosedTradeRecord[]): BacktestMetrics {
  if (!trades.length) return emptyMetrics();

  const n = trades.length;

  // Levered PnL per trade (the "return" experienced by the account on that trade's collateral)
  const leveredReturns = trades.map(t => t.pnlPct * t.leverage);

  const wins   = leveredReturns.filter(r => r > 0);
  const losses = leveredReturns.filter(r => r <= 0);

  const winCount  = wins.length;
  const lossCount = losses.length;
  const winRate   = winCount / n;

  const grossWin  = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss === 0 ? 99 : Math.min(grossWin / grossLoss, 99);

  const avgDurationMs = trades.reduce((s, t) => s + t.durationMs, 0) / n;
  const totalPnlPct   = leveredReturns.reduce((s, r) => s + r, 0);
  const avgPnlPct     = totalPnlPct / n;
  const bestTrade     = Math.max(...leveredReturns);
  const worstTrade    = Math.min(...leveredReturns);

  // Equity curve starting at 1.0 (each trade multiplies by 1 + leveredReturn)
  const equityCurve: number[] = [1.0];
  for (const r of leveredReturns) {
    equityCurve.push(equityCurve[equityCurve.length - 1]! * (1 + r));
  }

  const maxDrawdown = calcMaxDrawdown(equityCurve);
  const sharpeRatio = calcSharpe(leveredReturns);

  return {
    totalTrades: n,
    winCount,
    lossCount,
    winRate,
    profitFactor,
    maxDrawdown,
    sharpeRatio,
    avgDurationMs,
    totalPnlPct,
    avgPnlPct,
    bestTrade,
    worstTrade,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Maximum peak-to-trough drawdown on an equity curve.
 * Returns a value in [0, 1] where 1 = 100% total loss.
 */
export function calcMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  let peak  = equityCurve[0]!;
  let maxDD = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * Annualized Sharpe ratio from an array of per-trade returns.
 * Assumes approximately 6 trades per day across all watched symbols
 * (conservative estimate for 4-symbol scan every 10s on 5m candles).
 * riskFreeRate is annual (e.g. 0.05 for 5% risk-free).
 */
export function calcSharpe(returns: number[], riskFreeRate = 0): number {
  if (returns.length < 2) return 0;
  const n    = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;

  // Annualize: assume ~6 closed trades per day → 2190 per year
  const tradesPerYear = 6 * 365;
  const rfPerTrade    = riskFreeRate / tradesPerYear;
  const annualized    = ((mean - rfPerTrade) / stdDev) * Math.sqrt(tradesPerYear);
  return Number.isFinite(annualized) ? +annualized.toFixed(4) : 0;
}

function emptyMetrics(): BacktestMetrics {
  return {
    totalTrades: 0, winCount: 0, lossCount: 0,
    winRate: 0, profitFactor: 0, maxDrawdown: 0,
    sharpeRatio: 0, avgDurationMs: 0, totalPnlPct: 0,
    avgPnlPct: 0, bestTrade: 0, worstTrade: 0,
  };
}
