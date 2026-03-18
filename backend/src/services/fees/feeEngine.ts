// ── Fee Engine — Platform fee tracking & subscription management ──────────────
//
// Fee structure:
//   5%  deposit fee        (on top of smart-contract fee, tracked for accounting)
//   10% withdrawal fee     (normal)
//   15% emergency fee      (emergency withdrawal)
//   25% net profit share   (deducted at withdrawal time)
//   20 USDC/month          subscription (14-day trial waived)
//
// Redis key schema:
//   accounting:{userId}    → JSON Accounting object
//   subscription:{userId}  → JSON Subscription object
//   fee:log:{userId}       → LIST of JSON FeeTransaction (capped at 500)

import type { Redis } from "ioredis";

// ── Constants ─────────────────────────────────────────────────────────────────

export const FEE = {
  DEPOSIT_BPS:      500,   // 5%
  WITHDRAW_BPS:    1000,   // 10%
  EMERGENCY_BPS:   1500,   // 15%
  PROFIT_SHARE_BPS: 2500,  // 25% of net profit
  SUBSCRIPTION_USDC: 20,   // $20 USDC / month
  TRIAL_DAYS: 14,
  BPS_DENOM: 10_000,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FeeTransaction {
  type: "deposit" | "withdraw" | "emergency" | "profit_share" | "subscription";
  amount: number;      // gross USDC involved
  fee: number;         // platform fee taken (USDC)
  net: number;         // net USDC after fees
  ts: string;          // ISO timestamp
  txHash?: string;
}

export interface Accounting {
  netDeposited: number;    // cumulative deposits after deposit fee
  profitSharePaid: number; // cumulative profit share paid to platform
}

export interface Subscription {
  paidUntil: string | null; // ISO timestamp when current period ends
  totalPaid: number;        // cumulative USDC paid for subscriptions
}

export interface SubscriptionStatus {
  active: boolean;
  status: "trial" | "active" | "expired";
  daysLeft: number;
}

// ── Redis key helpers ─────────────────────────────────────────────────────────

const acctKey = (userId: string) => `accounting:${userId}`;
const subKey  = (userId: string) => `subscription:${userId}`;
const logKey  = (userId: string) => `fee:log:${userId}`;

// ── Internal helpers ──────────────────────────────────────────────────────────

function bps(amount: number, feeBps: number): number {
  return +(amount * feeBps / FEE.BPS_DENOM).toFixed(6);
}

async function getAccounting(redis: Redis, userId: string): Promise<Accounting> {
  const raw = await redis.get(acctKey(userId));
  return raw ? (JSON.parse(raw) as Accounting) : { netDeposited: 0, profitSharePaid: 0 };
}

async function saveAccounting(redis: Redis, userId: string, data: Accounting): Promise<void> {
  await redis.set(acctKey(userId), JSON.stringify(data));
}

async function appendFeeLog(redis: Redis, userId: string, entry: FeeTransaction): Promise<void> {
  await redis.lpush(logKey(userId), JSON.stringify(entry));
  await redis.ltrim(logKey(userId), 0, 499); // keep last 500
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a deposit fee and update net-deposited accounting.
 * The smart contract already deducts depositFeeBps — this tracks the platform's
 * 5% on top for revenue accounting and profit-share baseline.
 */
export async function recordDeposit(
  redis: Redis,
  userId: string,
  grossUsdc: number,
  txHash?: string
): Promise<{ fee: number; net: number }> {
  const fee = bps(grossUsdc, FEE.DEPOSIT_BPS);
  const net = +(grossUsdc - fee).toFixed(6);

  const acct = await getAccounting(redis, userId);
  acct.netDeposited = +(acct.netDeposited + net).toFixed(6);
  await saveAccounting(redis, userId, acct);

  await appendFeeLog(redis, userId, {
    type: "deposit", amount: grossUsdc, fee, net, ts: new Date().toISOString(), txHash,
  });

  return { fee, net };
}

/**
 * Record a withdrawal, calculate profit share, and return the breakdown.
 * profitShare is computed from (vaultBalance - netDeposited) × 25%.
 * netDeposited is scaled down proportionally after withdrawal.
 */
export async function recordWithdrawal(
  redis: Redis,
  userId: string,
  grossUsdc: number,
  vaultBalanceUsdc: number,
  mode: "normal" | "emergency",
  txHash?: string
): Promise<{ withdrawFee: number; profitShare: number; totalFee: number; net: number }> {
  const feeBps      = mode === "emergency" ? FEE.EMERGENCY_BPS : FEE.WITHDRAW_BPS;
  const withdrawFee = bps(grossUsdc, feeBps);

  const acct  = await getAccounting(redis, userId);
  const profit = Math.max(0, vaultBalanceUsdc - acct.netDeposited);
  const profitShare = bps(profit, FEE.PROFIT_SHARE_BPS);
  const totalFee = +(withdrawFee + profitShare).toFixed(6);
  const net      = +Math.max(0, grossUsdc - totalFee).toFixed(6);

  // Update accounting: scale down netDeposited proportionally
  if (vaultBalanceUsdc > 0) {
    const remaining = Math.max(0, vaultBalanceUsdc - grossUsdc);
    const ratio = remaining / vaultBalanceUsdc;
    acct.netDeposited     = +(acct.netDeposited * ratio).toFixed(6);
  } else {
    acct.netDeposited = 0;
  }
  acct.profitSharePaid = +(acct.profitSharePaid + profitShare).toFixed(6);
  await saveAccounting(redis, userId, acct);

  const type = mode === "emergency" ? "emergency" : "withdraw";
  await appendFeeLog(redis, userId, {
    type, amount: grossUsdc, fee: totalFee, net, ts: new Date().toISOString(), txHash,
  });

  return { withdrawFee, profitShare, totalFee, net };
}

/**
 * Check whether a user's subscription (or trial) is currently active.
 */
export async function checkSubscription(
  redis: Redis,
  userId: string,
  trialExpiresAt: string | null
): Promise<SubscriptionStatus> {
  const now = Date.now();

  // Still in trial period
  if (trialExpiresAt) {
    const trialEnd = new Date(trialExpiresAt).getTime();
    if (trialEnd > now) {
      const daysLeft = Math.ceil((trialEnd - now) / 86_400_000);
      return { active: true, status: "trial", daysLeft };
    }
  }

  // Paid subscription
  const sub = await getSubscription(redis, userId);
  if (sub.paidUntil) {
    const paidEnd = new Date(sub.paidUntil).getTime();
    if (paidEnd > now) {
      const daysLeft = Math.ceil((paidEnd - now) / 86_400_000);
      return { active: true, status: "active", daysLeft };
    }
  }

  return { active: false, status: "expired", daysLeft: 0 };
}

/**
 * Get subscription data for a user.
 */
export async function getSubscription(redis: Redis, userId: string): Promise<Subscription> {
  const raw = await redis.get(subKey(userId));
  return raw ? (JSON.parse(raw) as Subscription) : { paidUntil: null, totalPaid: 0 };
}

/**
 * Record a subscription payment and extend paidUntil by 30 days.
 * Stacks on top of the current paidUntil if still active.
 */
export async function recordSubscriptionPayment(
  redis: Redis,
  userId: string,
  amountUsdc: number
): Promise<{ paidUntil: string }> {
  const sub = await getSubscription(redis, userId);

  // Extend from today or from current period end (whichever is later)
  const base = sub.paidUntil && new Date(sub.paidUntil).getTime() > Date.now()
    ? new Date(sub.paidUntil).getTime()
    : Date.now();

  const paidUntil = new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString();
  const updated: Subscription = {
    paidUntil,
    totalPaid: +(sub.totalPaid + amountUsdc).toFixed(2),
  };
  await redis.set(subKey(userId), JSON.stringify(updated));

  await appendFeeLog(redis, userId, {
    type: "subscription",
    amount: amountUsdc,
    fee: 0,
    net: amountUsdc,
    ts: new Date().toISOString(),
  });

  return { paidUntil };
}

/**
 * Get full fee stats for a user (accounting + subscription + recent transactions).
 */
export async function getUserFeeStats(
  redis: Redis,
  userId: string,
  trialExpiresAt: string | null
) {
  const [acct, sub, rawLog, subStatus] = await Promise.all([
    getAccounting(redis, userId),
    getSubscription(redis, userId),
    redis.lrange(logKey(userId), 0, 49),
    checkSubscription(redis, userId, trialExpiresAt),
  ]);

  return {
    accounting:          acct,
    subscription:        { ...sub, ...subStatus },
    recentTransactions:  rawLog.map(e => JSON.parse(e) as FeeTransaction),
    feeRates: {
      depositPct:      FEE.DEPOSIT_BPS / 100,
      withdrawPct:     FEE.WITHDRAW_BPS / 100,
      emergencyPct:    FEE.EMERGENCY_BPS / 100,
      profitSharePct:  FEE.PROFIT_SHARE_BPS / 100,
      subscriptionUSDC: FEE.SUBSCRIPTION_USDC,
      trialDays:       FEE.TRIAL_DAYS,
    },
  };
}
