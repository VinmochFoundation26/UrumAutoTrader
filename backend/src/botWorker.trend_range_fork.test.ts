import test from "node:test";
import assert from "node:assert/strict";

import { toWad } from "./services/onchain/wad.js";
import {
  DEFAULT_CFG,
  evaluateActiveTradeExit,
  maybeAdvanceLiveProfitPeak,
} from "./botWorker.trend_range_fork.js";

function makeTrade(overrides: Partial<{
  isLong: boolean;
  leverage: number;
  entryPriceWad: bigint;
  bestPriceWad: bigint;
  pendingBestWad: bigint;
  pendingBestSeenAtMs: number;
  openedAtMs: number;
}> = {}) {
  const entryPriceWad = overrides.entryPriceWad ?? toWad(100);
  return {
    userKey: "0xuser",
    symbol: "BTCUSDT",
    timeframe: "5m",
    isLong: overrides.isLong ?? true,
    leverage: overrides.leverage ?? 10,
    entryPriceWad,
    bestPriceWad: overrides.bestPriceWad ?? entryPriceWad,
    pendingBestWad: overrides.pendingBestWad ?? entryPriceWad,
    pendingBestSeenAtMs: overrides.pendingBestSeenAtMs ?? Date.now(),
    sizeWad: toWad(1),
    openedAtMs: overrides.openedAtMs ?? Date.now(),
    pending: false,
    closing: false,
  };
}

test("mini gate arms from live peak and exits in profit on reversal", () => {
  const trade = makeTrade();
  maybeAdvanceLiveProfitPeak(trade as any, toWad(100.3), DEFAULT_CFG); // +0.3% raw = +3% lev at 10x

  const result = evaluateActiveTradeExit(trade as any, toWad(100.15), DEFAULT_CFG);
  assert.equal(result.shouldExit, true);
  assert.equal(result.reason, "PROFIT_REVERSAL_MINI_GATE");
});

test("live peak tracking keeps best price aligned with favorable current price before mini gate", () => {
  const trade = makeTrade();

  maybeAdvanceLiveProfitPeak(trade as any, toWad(100.08), DEFAULT_CFG); // +0.08% raw = +0.8% lev at 10x
  assert.equal(trade.bestPriceWad, toWad(100.08));

  maybeAdvanceLiveProfitPeak(trade as any, toWad(100.15), DEFAULT_CFG); // +0.15% raw = +1.5% lev at 10x
  assert.equal(trade.bestPriceWad, toWad(100.15));
});

test("staircase locks one step below a 9% leveraged peak", () => {
  const trade = makeTrade({ bestPriceWad: toWad(100.9) }); // +0.9% raw = +9% lev at 10x

  const hold = evaluateActiveTradeExit(trade as any, toWad(100.7), DEFAULT_CFG);
  assert.equal(hold.shouldExit, false);

  const close = evaluateActiveTradeExit(trade as any, toWad(100.6), DEFAULT_CFG);
  assert.equal(close.shouldExit, true);
  assert.equal(close.reason, "PROFIT_REVERSAL_MINI_GATE");
});

test("major gate keeps profit lock once 30% leveraged has been reached", () => {
  const trade = makeTrade({ bestPriceWad: toWad(103) }); // +3% raw = +30% lev at 10x

  const result = evaluateActiveTradeExit(trade as any, toWad(102), DEFAULT_CFG);
  assert.equal(result.shouldExit, true);
  assert.equal(result.reason, "PROFIT_REVERSAL_MAJOR_GATE");
});

test("hard stop still triggers at the 1% raw loss gate", () => {
  const trade = makeTrade();

  const result = evaluateActiveTradeExit(trade as any, toWad(99), DEFAULT_CFG);
  assert.equal(result.shouldExit, true);
  assert.equal(result.reason, "STOP_LOSS");
});
