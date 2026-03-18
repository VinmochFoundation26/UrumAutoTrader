import { Contract, JsonRpcProvider, Wallet, isAddress } from "ethers";
import { log } from "../../logger.js";

/**
 * Helpers
 */
function normalizeEnvUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();

  // If someone pasted a Markdown link like:
  // [http://127.0.0.1:8545](http://127.0.0.1:8545)
  // extract the actual URL inside (...) or [...]
  const mdMatch = v.match(/^\[(https?:\/\/[^\]]+)\]\((https?:\/\/[^)]+)\)$/);
  if (mdMatch) return mdMatch[2].trim();

  // If wrapped in quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).trim();
  }

  return v;
}

function requireEnv(name: string, value?: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Env
 */
const RPC_URL         = normalizeEnvUrl(process.env.RPC_URL);
// PRIVATE_RPC_URL: optional MEV-protected endpoint for write transactions.
// If unset, falls back to RPC_URL (same provider for reads + writes).
// Recommended: use Flashbots Protect (https://rpc.flashbots.net/fast) on mainnet,
// or a private mempool RPC (Alchemy, Bloxroute) on Arbitrum.
const PRIVATE_RPC_URL  = normalizeEnvUrl(process.env.PRIVATE_RPC_URL) ?? RPC_URL;
// FALLBACK_RPC_URL: secondary provider used when RPC_URL is unreachable.
// Prevents "connection refused" errors from one backend node taking down the bot.
const FALLBACK_RPC_URL = normalizeEnvUrl(process.env.FALLBACK_RPC_URL);
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY;
const VAULT_ADDRESS   = process.env.VAULT_ADDRESS;
const CHAIN_ID        = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined;

export const VAULT_ABI = [
  // ── read ──────────────────────────────────────────────────────────────────
  "function stable() view returns (address)",
  "function stableDecimals() view returns (uint8)",
  "function stableScaleUp() view returns (uint256)",
  "function minStableDeposit() view returns (uint256)",
  "function stableBalanceX18(address user) view returns (uint256)",
  "function pendingStableWithdrawalX18(address user) view returns (uint256)",
  "function reservedStableX18(address user) view returns (uint256)",
  "function cooldownSeconds() view returns (uint256)",
  "function cooldownRemaining(address user) view returns (uint256)",
  "function lastClosedAt(address user) view returns (uint256)",
  "function positionOf(address user, bytes32 marketId) view returns (tuple(bool isOpen, bool isLong, uint256 sizeX18, uint256 entryPriceX18, uint256 collateralX18, uint256 openedAt))",
  "function getOpenMarkets(address user) view returns (bytes32[])",
  "function openCount(address user) view returns (uint8)",
  "function isMarketEnabled(bytes32 marketId) view returns (bool)",
  "function depositFeeBps() view returns (uint256)",
  "function withdrawFeeBps() view returns (uint256)",
  "function emergencyFeeBps() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function paused() view returns (bool)",
  "function BOT_ROLE() view returns (bytes32)",
  "function WITHDRAW_APPROVER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function MAX_OPEN_POSITIONS() view returns (uint8)",
  "function BPS_DENOM() view returns (uint256)",
  // ── write ─────────────────────────────────────────────────────────────────
  "function executeTrade(address user, bytes32 marketId, bool isLong, uint256 sizeX18, uint256 entryPriceX18, uint256 collateralRaw)",
  "function closePosition(address user, bytes32 marketId, uint256 exitPriceX18)",
  "function depositStable(uint256 amountRaw)",
  // Withdrawal: two-step normal flow (bot has WITHDRAW_APPROVER_ROLE)
  "function initiateWithdrawStable(uint256 amountRaw)",
  "function approveWithdrawStable(address user, uint256 amountGrossRaw)",
  // Withdrawal: emergency bypass (higher fee, no approval needed)
  "function emergencyWithdrawStable(uint256 amountGrossRaw)",
  // ── events ────────────────────────────────────────────────────────────────
  "event TradeExecuted(address indexed user, bytes32 indexed marketId, bool isLong, uint256 sizeX18, uint256 entryPriceX18, uint256 timestamp, address indexed executor)",
  "event PositionClosed(address indexed user, bytes32 indexed marketId, uint256 exitPriceX18, int256 pnlX18, uint256 timestamp, address indexed executor)",
];

/** Minimal ERC-20 ABI — used for stable token approve/balanceOf. */
export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

let _provider:         JsonRpcProvider | null = null;  // READ provider (fast, public)
let _writeProvider:    JsonRpcProvider | null = null;  // WRITE provider (MEV-protected)
let _fallbackProvider: JsonRpcProvider | null = null;  // FALLBACK provider (secondary RPC)
let _signer:           Wallet | null = null;
let _vaultRead:        Contract | null = null;
let _vaultWrite:       Contract | null = null;

/**
 * Read-only JSON-RPC provider.
 * Used for all read calls (getOpenMarkets, positionOf, stableBalanceX18, etc.)
 * Points to RPC_URL — typically a fast public or premium endpoint.
 */
export function getProvider(): JsonRpcProvider {
  if (_provider) return _provider;
  const url = requireEnv("RPC_URL", RPC_URL);
  _provider = new JsonRpcProvider(url);
  return _provider;
}

/**
 * Write-optimised JSON-RPC provider.
 * Used exclusively for sending transactions (executeTrade, closePosition).
 * Points to PRIVATE_RPC_URL if set — typically a MEV-protected private mempool:
 *   - Flashbots Protect:  https://rpc.flashbots.net/fast
 *   - Arbitrum Flashbots: https://arb-mainnet.flashbots.net
 *   - Alchemy Private:    your Alchemy RPC (has private tx routing)
 * Falls back to RPC_URL if PRIVATE_RPC_URL is not configured.
 */
export function getWriteProvider(): JsonRpcProvider {
  if (_writeProvider) return _writeProvider;
  const url = requireEnv("RPC_URL", PRIVATE_RPC_URL ?? RPC_URL);
  _writeProvider = new JsonRpcProvider(url);
  const usingPrivate = PRIVATE_RPC_URL && PRIVATE_RPC_URL !== RPC_URL;
  log.info({ rpc: url.replace(/\/[a-zA-Z0-9_-]{20,}$/, "/***"), mevProtected: usingPrivate },
    "[onchain] write provider initialized");
  return _writeProvider;
}

/**
 * Fallback read-only provider — used when the primary RPC is unreachable.
 * Returns null if FALLBACK_RPC_URL is not configured.
 */
export function getFallbackProvider(): JsonRpcProvider | null {
  if (!FALLBACK_RPC_URL) return null;
  if (_fallbackProvider) return _fallbackProvider;
  _fallbackProvider = new JsonRpcProvider(FALLBACK_RPC_URL);
  log.info({ rpc: FALLBACK_RPC_URL.replace(/\/[a-zA-Z0-9_-]{20,}$/, "/***") },
    "[onchain] fallback provider initialized");
  return _fallbackProvider;
}

export function getSigner(): Wallet {
  if (_signer) return _signer;
  const pk  = requireEnv("BOT_PRIVATE_KEY", BOT_PRIVATE_KEY);
  // Signer uses the WRITE provider — all transactions go through MEV-protected RPC
  _signer = new Wallet(pk, getWriteProvider());
  return _signer;
}

export function getVaultAddress(): string {
  const addr = requireEnv("VAULT_ADDRESS", VAULT_ADDRESS);
  if (!isAddress(addr)) throw new Error(`VAULT_ADDRESS invalid: ${addr}`);
  return addr;
}

/**
 * Read-only contract: safe for GET routes (doesn't require bot key).
 */
export function getVaultReadContract(): Contract {
  if (_vaultRead) return _vaultRead;
  _vaultRead = new Contract(getVaultAddress(), VAULT_ABI, getProvider());
  return _vaultRead;
}

/**
 * Write-enabled contract: used for executeTrade/closePosition/admin actions.
 */
export function getVaultWriteContract(): Contract {
  if (_vaultWrite) return _vaultWrite;
  _vaultWrite = new Contract(getVaultAddress(), VAULT_ABI, getSigner());
  return _vaultWrite;
}

/**
 * Backwards-compatible name: your code currently uses getVaultContract()
 * Keep it returning the write contract (signer) like before.
 */
export function getVaultContract(): Contract {
  return getVaultWriteContract();
}

export async function assertOnchainReady() {
  const provider = getProvider();
  const signer = getSigner();
  const vaultRead = getVaultReadContract();

  const net = await provider.getNetwork();
  if (CHAIN_ID !== undefined && Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`CHAIN_ID mismatch: expected ${CHAIN_ID}, got ${net.chainId.toString()}`);
  }

  const vaultAddr = getVaultAddress();
  const code = await provider.getCode(vaultAddr);
  if (!code || code === "0x") throw new Error("No contract code at VAULT_ADDRESS (got 0x)");

  const minStable = await vaultRead.minStableDeposit();
  const cooldown = await vaultRead.cooldownSeconds();

  const mevProtected = !!(PRIVATE_RPC_URL && PRIVATE_RPC_URL !== RPC_URL);
  log.info({
    chainId: net.chainId.toString(),
    signer: signer.address,
    vault: vaultAddr,
    minStableDeposit: minStable.toString(),
    cooldownSeconds: cooldown.toString(),
    mevProtected,
    writeRpc: mevProtected ? "PRIVATE_RPC_URL" : "RPC_URL (no MEV protection)",
  }, "[onchain] ready");
}
