export type Side = "LONG" | "SHORT";
export type Candidate = {
  userKey: string;
  symbol: string;
  timeframe: string;
  side: Side;
  required: number;
  longVotes: number;
  shortVotes: number;
  // higher = better
  score: number;
  // debugging / transparency
  reasons: Record<string, any>;
};

const TF_WEIGHT: Record<string, number> = {
  "5m": 1.0,
  "15m": 1.15
};

/**
 * Scoring philosophy:
 * - Prefer higher vote count (5/5 > 4/5).
 * - Prefer larger vote margin (e.g., 5-0 > 4-1).
 * - Slightly prefer 15m over 5m (more stable).
 */
export function scoreCandidate(args: {
  timeframe: string;
  required: number;
  longVotes: number;
  shortVotes: number;
  side: Side;
}) {
  const { timeframe, required, longVotes, shortVotes, side } = args;

  const winning = side === "LONG" ? longVotes : shortVotes;
  const losing = side === "LONG" ? shortVotes : longVotes;
  const margin = winning - losing;

  // base: winning votes, bonus: margin, bonus: exceeds required (e.g. 5/5),
  // TF weight for stability
  const base = winning;
  const marginBonus = margin * 0.35;
  const exceedBonus = Math.max(0, winning - required) * 0.6;

  const w = TF_WEIGHT[timeframe] ?? 1.0;
  return (base + marginBonus + exceedBonus) * w;
}

export function pickBest(cands: Candidate[]): Candidate | null {
  if (!cands.length) return null;
  let best = cands[0]!;
  for (const c of cands) {
    if (c.score > best.score) best = c;
  }
  return best;
}
