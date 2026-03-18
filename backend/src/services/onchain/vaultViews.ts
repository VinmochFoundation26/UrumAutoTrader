import { getVaultContract } from "./contractInstance.js";
import { getUserBalancesWad } from "./vaultAdapter.js";
import { fromWad } from "./wad.js";

const STABLE_DECIMALS = Number(process.env.STABLE_DECIMALS ?? "6");

export async function getVaultBalances(user: string) {
  const vault = getVaultContract();
  // V2 is USDC-only — getUserBalancesWad returns { stableWad } (no ethWad).
  const { stableWad } = await getUserBalancesWad(vault, user, STABLE_DECIMALS);
  return {
    user,
    stableWad: stableWad.toString(),
    stable: fromWad(stableWad, 2),
    stableDecimals: STABLE_DECIMALS
  };
}
