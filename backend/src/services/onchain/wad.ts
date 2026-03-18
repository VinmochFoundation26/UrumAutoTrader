import { parseUnits, formatUnits } from "ethers";

export const WAD = 10n ** 18n;
export type Wad = bigint;

export function toWad(v: number | string | bigint): Wad {
  if (typeof v === "bigint") return v;
  return parseUnits(String(v), 18);
}

export function fromWad(w: Wad, displayDecimals = 6): string {
  return Number(formatUnits(w, 18)).toFixed(displayDecimals);
}

export function wadToScaled(wad: Wad, targetDecimals: number): bigint {
  const scale = 10n ** BigInt(targetDecimals);
  return (wad * scale) / WAD;
}

export function scaledToWad(scaled: bigint, targetDecimals: number): Wad {
  const scale = 10n ** BigInt(targetDecimals);
  return (scaled * WAD) / scale;
}

export function mulWad(a: Wad, b: Wad): Wad {
  return (a * b) / WAD;
}

export function divWad(a: Wad, b: Wad): Wad {
  if (b === 0n) throw new Error("divWad: division by zero");
  return (a * WAD) / b;
}
