import { useEffect, useRef, useState, useCallback } from "react";
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, BarChart2, Bot,
  ChevronDown, ChevronUp, CheckCircle, Circle, Download, ExternalLink,
  HelpCircle, MessageCircle, Power, PowerOff, RefreshCw,
  Send, Settings, TrendingDown, TrendingUp, Wallet, X, Zap,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface BotState {
  running: boolean;
  startedAt?: number;
  strategy?: string;
  trigger?: { stochOS: number; stochOB: number; stochMid: number; stochDLen: number };
  lastError?: { ts: number; message: string };
}

interface BotConfig {
  userAddress: string;
  symbols: string[];
  strategy: string;
  trigger: { stochOS: number; stochOB: number; stochMid: number; stochDLen: number };
}

interface VaultBalance {
  stable: string;
  stableWad: string;
}

interface WalletData {
  stableToken:  string;
  vaultAddress: string;
  wallet:    { raw: string; formatted: number; decimals: number };
  vault:     { wad: string; formatted: number };
  pending:   { wad: string; formatted: number };
  minDeposit:{ raw: string; formatted: number };
  fees: {
    depositPct:   number;
    withdrawPct:  number;
    emergencyPct: number;
    depositNet:   number;   // % of gross credited after deposit fee
    withdrawNet:  number;   // % of gross received after normal withdrawal fee
    emergencyNet: number;   // % of gross received after emergency fee
  };
}

interface Position {
  isOpen: boolean;
  isLong: boolean;
  sizeX18: string;
  entryPriceX18: string;
  collateralX18: string;
  openedAt: string;
  marketId?: string;
  symbol?: string;
}

interface BotEvent {
  ts: number;
  type: string;
  symbol?: string;
  side?: string;
  decided?: string;
  votes?: { longVotes: number; shortVotes: number; required: number; trendRegime?: string };
  result?: { txHash?: string; paper?: boolean };
  error?: string;
  [k: string]: any;
}

interface BacktestMetrics {
  totalTrades:   number;
  winCount:      number;
  lossCount:     number;
  winRate:       number;
  profitFactor:  number;
  maxDrawdown:   number;
  sharpeRatio:   number;
  avgDurationMs: number;
  totalPnlPct:   number;
  avgPnlPct:     number;
  bestTrade:     number;
  worstTrade:    number;
}

interface ClosedTradeRecord {
  symbol:      string;
  isLong:      boolean;
  entryPrice:  number;
  exitPrice:   number;
  pnlPct:      number;
  leverage:    number;
  durationMs:  number;
  reason:      string;
  closedAt:    number;
}

interface BacktestResult {
  symbol:      string;
  days:        number;
  bars:        number;
  trades:      (ClosedTradeRecord & { entryTs: number; exitTs: number })[];
  metrics:     BacktestMetrics;
  generatedAt: number;
  cached?:     boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_KEY = "at_token"; // sessionStorage key for JWT
const WALLET_LINK_PREFIX = "UrumTrader wallet link";

/** Decode JWT payload without verification (client-side only) */
function decodeJwtPayload(token: string): { role?: string; userId?: string } {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
}

function buildWalletLinkMessage(walletAddress: string, userId: string) {
  return `${WALLET_LINK_PREFIX}
User ID: ${userId}
Wallet: ${walletAddress.toLowerCase()}`;
}

const MARKET_SYMBOLS: Record<string, string> = {
  "0xcd423b16b64109a0492eab881d06ef1d6470d25f8e3d6f04f5acc111f176939c": "BTCUSDT",
  "0xaeb17180ec6df0d643751cbbe82ac67166a910f4092c23f781cd39e46582ec9c": "ETHUSDT",
  "0xae9c0146ab64b81aae7608dc5ffddfa320640d5dece2ab37ecf0809dcc5f0c2a": "TAOUSDT",
  "0x23c6a2c43f92acac35ed89f352fa5f2e30496347aeb1aafb8e0a14766b47dbf1": "RENDERUSDT",
  "0x3db5e9fb22b6f66ce6550ab2b9d3872f875f575780c6abb9c95f9ce03845a83e": "SOLUSDT",
  "0xaeee40e849f19d8b8252d9e750ed2ff6fa233c95aa4a1d3da9858a3b18ade5df": "BNBUSDT",
  "0x71083fc4de82d2f809bbb2c7b8c8b820d59abbbbd74f8a21d418fb9b990e325b": "XRPUSDT",
  "0x214dda553a3e2a23944080bfcad3566db70ebe7a599389f0f9cf73f0cf03e933": "DOGEUSDT",
};

function marketIdToSymbol(id: string): string {
  return MARKET_SYMBOLS[id] ?? id.slice(0, 10) + "…";
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const r = await fetch(`/api${path}`, { ...opts, headers });
  if (r.status === 401) {
    // Token expired or invalid — signal the app to go back to login
    sessionStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new CustomEvent("at:logout"));
  }
  return r.json();
}

// ── Utility ───────────────────────────────────────────────────────────────────

function fmtTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}

function fmtUptime(startedAt?: number) {
  if (!startedAt) return "—";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function priceBigToNum(x18: string) {
  return Number(BigInt(x18)) / 1e18;
}

function calcPnl(pos: Position, currentPrice: number) {
  const entryPrice = priceBigToNum(pos.entryPriceX18);
  const size = priceBigToNum(pos.sizeX18);
  const collateral = priceBigToNum(pos.collateralX18);
  const priceDiff = pos.isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
  const pnlUsdc = (priceDiff / entryPrice) * size;
  const pnlPct = collateral > 0 ? (pnlUsdc / collateral) * 100 : 0;
  return { pnlUsdc, pnlPct, entryPrice, size, collateral };
}

function eventColor(type: string): string {
  if (type === "TRADE_EXECUTED" || type === "POSITION_OPENED") return "var(--green)";
  if (type === "POSITION_RECOVERED") return "var(--blue)";
  if (type === "GHOST_TRADE_CLEARED") return "var(--orange)";
  if (type === "EXIT_SIGNAL") return "var(--blue)";
  if (type === "TRAIL_STATUS") return "var(--orange)";
  if (type === "CIRCUIT_BREAKER_TRIGGERED") return "var(--red)";
  if (type.includes("CLOSED") || type.includes("EXIT")) return "var(--blue)";
  if (type.includes("FAILED") || type.includes("ERROR")) return "var(--red)";
  if (type === "ATR_BLOCKED") return "var(--orange)";
  if (type === "ENTRY_BLOCKED") return "var(--muted)";
  if (type === "VOTES") return "var(--muted)";
  return "var(--text)";
}

function eventIcon(type: string) {
  if (type === "TRADE_EXECUTED" || type === "POSITION_OPENED") return "🟢";
  if (type === "POSITION_RECOVERED") return "🔄";
  if (type === "GHOST_TRADE_CLEARED") return "👻";
  if (type === "EXIT_SIGNAL") return "🔵";
  if (type === "TRAIL_STATUS") return "🟠";
  if (type === "CIRCUIT_BREAKER_TRIGGERED") return "🚨";
  if (type.includes("CLOSED") || type.includes("EXIT")) return "🔵";
  if (type.includes("FAILED") || type.includes("ERROR")) return "🔴";
  if (type === "ATR_BLOCKED") return "🟡";
  if (type === "VOTES") return "🗳";
  return "⚪";
}

// ── Components ────────────────────────────────────────────────────────────────

function StatusPill({ running }: { running: boolean }) {
  return (
    <span className={`pill ${running ? "pill-green" : "pill-red"}`}>
      <Circle size={8} fill="currentColor" />
      {running ? "Running" : "Stopped"}
    </span>
  );
}

function Card({ title, icon, children, className = "" }: {
  title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      <div className="card-header">
        {icon && <span className="card-icon">{icon}</span>}
        <span className="card-title">{title}</span>
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function Spinner() {
  return <span className="spinner" />;
}

// ── Position Card ─────────────────────────────────────────────────────────────

function PositionRow({
  marketId, pos, currentPrice, priceLoading, onClose,
}: {
  marketId: string; pos: Position; currentPrice?: number; priceLoading: boolean;
  onClose: () => void;
}) {
  const symbol      = marketIdToSymbol(marketId);
  const entryPrice  = priceBigToNum(pos.entryPriceX18);
  const collateral  = priceBigToNum(pos.collateralX18);
  const size        = priceBigToNum(pos.sizeX18);

  const [closing, setClosing]   = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);
  const [confirm, setConfirm]   = useState(false);

  const { pnlUsdc, pnlPct } = currentPrice
    ? calcPnl(pos, currentPrice)
    : { pnlUsdc: 0, pnlPct: 0 };
  const pnlPositive = pnlUsdc >= 0;

  // Tier-aware stop-loss: Tier 1 (≤30×) = 1% raw, Tier 2 (≥40×) ≈ 0.5–0.8%
  // Leverage = USD notional / collateral (both in USD, sizeX18 is the notional)
  const approxLeverage  = collateral > 0 ? Math.round(size / collateral) : 10;
  const rawStopPct      = approxLeverage >= 40
    ? Math.min(0.008, Math.max(0.005, 0.30 / approxLeverage))
    : 0.01;  // Tier 1: 1%
  const stopLoss        = pos.isLong ? entryPrice * (1 - rawStopPct) : entryPrice * (1 + rawStopPct);
  const takeProfitStart = pos.isLong ? entryPrice * 1.03 : entryPrice * 0.97; // 3% leveraged min
  const openedAgo       = Math.floor((Date.now() - Number(pos.openedAt) * 1000) / 60000);

  async function handleClose() {
    if (!confirm) { setConfirm(true); return; }   // first click = arm
    setClosing(true); setCloseErr(null); setConfirm(false);
    try {
      const r: any = await apiFetch("/vault/close-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!r.ok) throw new Error(r.error ?? "close failed");
      onClose();  // refresh positions list
    } catch (e: any) {
      setCloseErr(e.message ?? "close failed");
      setClosing(false);
    }
  }

  return (
    <div className="position-row">
      <div className="pos-header">
        <span className="pos-symbol">{symbol}</span>
        <span className={`pos-side ${pos.isLong ? "side-long" : "side-short"}`}>
          {pos.isLong ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {pos.isLong ? "LONG" : "SHORT"}
        </span>
        <span className="pos-age">{openedAgo}m ago</span>

        {/* ── Per-position close button ── */}
        <button
          className={`pos-close-btn ${confirm ? "pos-close-confirm" : ""}`}
          onClick={handleClose}
          disabled={closing}
          title={confirm ? "Click again to confirm close" : "Manually close this position at market price"}
        >
          {closing ? <Spinner /> : confirm ? "⚠ Confirm Close" : <><X size={12} /> Close</>}
        </button>
      </div>

      <div className="pos-grid">
        <div className="pos-stat">
          <span className="stat-label">Entry</span>
          <span className="stat-val">${entryPrice.toFixed(2)}</span>
        </div>
        <div className="pos-stat">
          <span className="stat-label">Current</span>
          <span className="stat-val">
            {priceLoading ? <Spinner /> : currentPrice ? `$${currentPrice.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="pos-stat">
          <span className="stat-label">Size</span>
          <span className="stat-val">${size.toFixed(3)}</span>
        </div>
        <div className="pos-stat">
          <span className="stat-label">Collateral</span>
          <span className="stat-val">${collateral.toFixed(4)}</span>
        </div>
        <div className="pos-stat">
          <span className="stat-label">Stop-Loss</span>
          <span className="stat-val red">${stopLoss.toFixed(2)}</span>
        </div>
        <div className="pos-stat">
          <span className="stat-label">TP Start</span>
          <span className="stat-val green">${takeProfitStart.toFixed(2)}</span>
        </div>
      </div>

      {currentPrice && (
        <div className={`pos-pnl ${pnlPositive ? "pnl-pos" : "pnl-neg"}`}>
          <span>Unrealized PnL</span>
          <span>
            {pnlPositive ? "+" : ""}{pnlUsdc.toFixed(4)} USDC
            &nbsp;({pnlPositive ? "+" : ""}{pnlPct.toFixed(2)}%)
          </span>
        </div>
      )}

      {closeErr && (
        <div className="pos-close-error">⚠ {closeErr}</div>
      )}
    </div>
  );
}

// ── Events Feed ───────────────────────────────────────────────────────────────

function EventRow({ e }: { e: BotEvent }) {
  const [expanded, setExpanded] = useState(false);
  const isVotes = e.type === "VOTES";
  const hasExtra = !isVotes;

  return (
    <div className="event-row" onClick={() => hasExtra && setExpanded(x => !x)}>
      <span className="event-icon">{eventIcon(e.type)}</span>
      <span className="event-time">{fmtTime(e.ts)}</span>
      <span className="event-type" style={{ color: eventColor(e.type) }}>{e.type}</span>
      {e.symbol && <span className="event-sym">{e.symbol}</span>}
      {e.decided && e.decided !== "NONE" && (
        <span className={`event-side ${e.decided === "LONG" ? "side-long" : "side-short"}`}>
          {e.decided}
        </span>
      )}
      {isVotes && e.votes && (
        <span className="event-votes">
          {e.timeframe && (
            <span style={{ opacity: 0.55, fontSize: "0.75em", marginRight: "3px" }}>
              [{e.timeframe}]
            </span>
          )}
          L:{e.votes.longVotes} S:{e.votes.shortVotes} req:{e.votes.required}
          {e.votes.trendRegime && e.votes.trendRegime !== "NONE" && (
            <span className={`event-side ${e.votes.trendRegime === "LONG" ? "side-long" : "side-short"}`}>
              &nbsp;{e.votes.trendRegime}
            </span>
          )}
        </span>
      )}
      {e.type === "ATR_BLOCKED" && e.atrPct != null && (
        <span className="event-votes" style={{ color: "var(--orange)" }}>
          ATR {(e.atrPct * 100).toFixed(3)}%
        </span>
      )}
      {e.type === "TRAIL_STATUS" && (
        <span className="event-votes" style={{ color: "var(--orange)" }}>
          lev {Number(e.currentLevPnlPct ?? 0).toFixed(1)}%
          {" / "}best {Number(e.bestLevPnlPct ?? 0).toFixed(1)}%
          {" / "}floor {e.effectiveStopLevPct == null ? "—" : `${Number(e.effectiveStopLevPct).toFixed(1)}%`}
          {e.miniGateArmed ? " / mini" : ""}
          {e.majorGateLocked ? " / major" : ""}
        </span>
      )}
      {e.result?.txHash && (
        <span className="event-hash">
          <a
            href={`https://arbiscan.io/tx/${e.result.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={ev => ev.stopPropagation()}
          >
            {e.result.txHash.slice(0, 10)}…
          </a>
        </span>
      )}
      {hasExtra && (
        <span className="event-expand">
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      )}
      {expanded && (
        <pre className="event-detail">{JSON.stringify(e, null, 2)}</pre>
      )}
    </div>
  );
}

// ── Config Panel ──────────────────────────────────────────────────────────────

function ConfigPanel({ config, onSave }: {
  config: BotConfig | null;
  onSave: (update: Partial<BotConfig>) => Promise<void>;
}) {
  const [symbols, setSymbols] = useState("");
  const [stochOS, setStochOS] = useState("35");
  const [stochOB, setStochOB] = useState("80");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (config) {
      setSymbols(config.symbols.join(","));
      setStochOS(String(config.trigger?.stochOS ?? 35));
      setStochOB(String(config.trigger?.stochOB ?? 80));
    }
  }, [config]);

  async function handleSave() {
    setSaving(true);
    setMsg("");
    try {
      await onSave({
        symbols: symbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
        trigger: {
          stochOS: Number(stochOS),
          stochOB: Number(stochOB),
          stochMid: config?.trigger?.stochMid ?? 50,
          stochDLen: config?.trigger?.stochDLen ?? 3,
        },
      });
      setMsg("Saved!");
    } catch (e: any) {
      setMsg("Error: " + e.message);
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(""), 3000);
    }
  }

  return (
    <div className="config-grid">
      <label className="cfg-label">
        <span>Symbols (comma-separated)</span>
        <input
          className="cfg-input"
          value={symbols}
          onChange={e => setSymbols(e.target.value)}
          placeholder="ETHUSDT,BTCUSDT"
        />
      </label>
      <label className="cfg-label">
        <span>Stoch Oversold (OS)</span>
        <input
          type="number" min={1} max={49} className="cfg-input"
          value={stochOS} onChange={e => setStochOS(e.target.value)}
        />
      </label>
      <label className="cfg-label">
        <span>Stoch Overbought (OB)</span>
        <input
          type="number" min={51} max={99} className="cfg-input"
          value={stochOB} onChange={e => setStochOB(e.target.value)}
        />
      </label>
      <div className="cfg-actions">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Spinner /> : "Save Config"}
        </button>
        {msg && <span className="cfg-msg">{msg}</span>}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtRelTime(ms: number) {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 1)  return `${days}d ago`;
  if (hrs > 0)   return `${hrs}h ago`;
  if (mins > 0)  return `${mins}m ago`;
  return "just now";
}

function fmtPct(v: number, decimals = 1) {
  return (v * 100).toFixed(decimals) + "%";
}

// ── Export helpers ─────────────────────────────────────────────────────────────

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportTradesToCsv(trades: ClosedTradeRecord[]) {
  const header = [
    "Date/Time", "Symbol", "Direction",
    "Entry Price", "Exit Price",
    "Raw PnL %", "Leveraged PnL %", "Leverage",
    "Duration (ms)", "Duration", "Reason",
  ].join(",");

  const rows = [...trades]
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .map(t => {
      const lev = t.leverage ?? 5;
      return [
        t.closedAt ? new Date(t.closedAt).toISOString() : "",
        t.symbol,
        t.isLong ? "LONG" : "SHORT",
        t.entryPrice.toFixed(6),
        t.exitPrice.toFixed(6),
        (t.pnlPct * 100).toFixed(4),
        (t.pnlPct * lev * 100).toFixed(4),
        lev,
        t.durationMs,
        fmtDuration(t.durationMs),
        t.reason,
      ].join(",");
    });

  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob([header, ...rows].join("\n"), `trades_${stamp}.csv`, "text/csv");
}

function exportTradesToJson(trades: ClosedTradeRecord[], metrics: any) {
  const stamp = new Date().toISOString().slice(0, 10);
  const payload = {
    exportedAt: new Date().toISOString(),
    totalTrades: trades.length,
    metrics,
    trades: [...trades].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
  };
  downloadBlob(JSON.stringify(payload, null, 2), `trades_${stamp}.json`, "application/json");
}

// ── Performance Panel ─────────────────────────────────────────────────────────

interface PerfData {
  count: number;
  trades: ClosedTradeRecord[];
  metrics: BacktestMetrics;
}

function MetricCard({ label, value, color }: { label: string; value: string; color?: "green" | "red" }) {
  return (
    <div className="metric-card">
      <div className="metric-card-label">{label}</div>
      <div className={`metric-card-val ${color ?? ""}`}>{value}</div>
    </div>
  );
}

function PerformancePanel({ data, loading, err, onRefresh }: {
  data: PerfData | null;
  loading: boolean;
  err: string | null;
  onRefresh: () => void;
}) {
  if (loading) return <div className="empty-state"><Spinner /><p>Loading performance data…</p></div>;
  if (err) return (
    <div className="empty-state">
      <AlertTriangle size={28} className="empty-icon" />
      <p>Could not load history</p>
      <span>{err}</span>
      <button className="sym-refresh" style={{ marginTop: 12 }} onClick={onRefresh}><RefreshCw size={12} /> Retry</button>
    </div>
  );
  if (!data || data.count === 0) return (
    <div className="empty-state">
      <BarChart2 size={32} className="empty-icon" />
      <p>No closed trades yet</p>
      <span>Performance metrics will appear once the bot closes its first position. The bot is scanning for entries — trades will appear here automatically.</span>
      <button className="sym-refresh" style={{ marginTop: 12 }} onClick={onRefresh}><RefreshCw size={12} /> Check Now</button>
    </div>
  );

  const { metrics, trades } = data;
  const winPct = fmtPct(metrics.winRate);
  const pfStr  = metrics.profitFactor >= 99 ? "∞" : metrics.profitFactor.toFixed(2);
  const ddStr  = fmtPct(metrics.maxDrawdown);
  const sharpe = metrics.sharpeRatio.toFixed(2);
  const totalP = (metrics.totalPnlPct * 100).toFixed(1) + "%";
  const totalColor = metrics.totalPnlPct >= 0 ? "green" : "red";

  const sortedTrades = [...trades].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

  return (
    <div className="perf-panel">
      {/* Metrics summary row */}
      <div className="metrics-grid">
        <MetricCard label="Total Trades" value={String(metrics.totalTrades)} />
        <MetricCard label="Win Rate" value={winPct} color={metrics.winRate >= 0.5 ? "green" : "red"} />
        <MetricCard label="Profit Factor" value={pfStr} color={metrics.profitFactor >= 1 ? "green" : "red"} />
        <MetricCard label="Max Drawdown" value={ddStr} color={metrics.maxDrawdown < 0.15 ? "green" : "red"} />
        <MetricCard label="Sharpe Ratio" value={sharpe} color={metrics.sharpeRatio >= 1 ? "green" : "red"} />
        <MetricCard label="Total PnL (levered)" value={totalP} color={totalColor} />
        <MetricCard label="Best Trade" value={"+" + fmtPct(metrics.bestTrade)} color="green" />
        <MetricCard label="Worst Trade" value={fmtPct(metrics.worstTrade)} color="red" />
      </div>

      {/* Trade history table toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          {sortedTrades.length} closed trades · newest first
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="sym-refresh" onClick={() => exportTradesToCsv(trades)}
            title="Download CSV — open in Excel, Google Sheets, Numbers">
            <Download size={12} /> CSV
          </button>
          <button className="sym-refresh" onClick={() => exportTradesToJson(trades, metrics)}
            title="Download full JSON with metrics">
            <Download size={12} /> JSON
          </button>
          <button className="sym-refresh" onClick={onRefresh}><RefreshCw size={12} /> Refresh</button>
        </div>
      </div>
      <div className="perf-trade-header perf-trade-header-8col">
        <span>Time</span><span>Symbol</span><span>Side</span><span>Entry</span>
        <span>Exit</span><span>PnL (lev)</span><span>Reason</span><span>Duration</span>
      </div>
      <div className="perf-trades-list">
        {sortedTrades.map((t, i) => {
          const lev = t.leverage ?? 5;
          const levPnl = t.pnlPct * lev;
          const pos = levPnl >= 0;
          return (
            <div className="perf-trade-row perf-trade-row-8col" key={i}>
              <span style={{ color: "var(--muted)", fontSize: 11 }} title={t.closedAt ? new Date(t.closedAt).toLocaleString() : ""}>
                {t.closedAt ? fmtRelTime(t.closedAt) : "—"}
              </span>
              <span style={{ fontWeight: 600 }}>{t.symbol}</span>
              <span className={t.isLong ? "side-chip-long" : "side-chip-short"}>{t.isLong ? "LONG" : "SHORT"}</span>
              <span>{t.entryPrice.toFixed(4)}</span>
              <span>{t.exitPrice.toFixed(4)}</span>
              <span className={pos ? "pnl-pos" : "pnl-neg"}>
                {pos ? "+" : ""}{(levPnl * 100).toFixed(2)}%
              </span>
              <span style={{ color: "var(--muted)", fontSize: 11 }}>{t.reason}</span>
              <span style={{ color: "var(--muted)" }}>{fmtDuration(t.durationMs)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Analytics Panel ───────────────────────────────────────────────────────────
// Advanced portfolio analytics: equity curve, symbol breakdown, PnL histogram,
// streak analysis, and extended risk ratios (Sortino, Calmar, Recovery Factor).

function EquityCurve({ trades }: { trades: ClosedTradeRecord[] }) {
  if (trades.length < 2) return (
    <div className="chart-empty">Not enough trades for equity curve (need ≥ 2)</div>
  );

  const sorted = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

  // Build cumulative levered PnL series
  let cum = 0;
  const points: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  sorted.forEach((t, i) => {
    cum += (t.pnlPct ?? 0) * (t.leverage ?? 10);
    points.push({ x: i + 1, y: cum });
  });

  const W = 560, H = 160, PAD = { t: 12, r: 12, b: 28, l: 52 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;

  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  const rangeY = maxY - minY || 1;
  const maxX   = points.length - 1 || 1;

  const toSvgX = (x: number) => PAD.l + (x / maxX) * iW;
  const toSvgY = (y: number) => PAD.t + iH - ((y - minY) / rangeY) * iH;

  const polyline = points.map(p => `${toSvgX(p.x)},${toSvgY(p.y)}`).join(" ");
  const lastP    = points[points.length - 1]!;
  const lastSvgY = toSvgY(lastP.y);
  const isProfit = lastP.y >= 0;

  // Y-axis ticks (5 levels)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = minY + (rangeY / 4) * i;
    return { y: v, svgY: toSvgY(v) };
  });

  return (
    <div className="chart-container">
      <div className="chart-title">Equity Curve (Levered PnL)</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="equity-svg">
        {/* Zero baseline */}
        {minY < 0 && maxY > 0 && (
          <line
            x1={PAD.l} y1={toSvgY(0)} x2={W - PAD.r} y2={toSvgY(0)}
            stroke="var(--muted)" strokeWidth={1} strokeDasharray="4 3"
          />
        )}
        {/* Y-axis labels */}
        {yTicks.map((t, i) => (
          <text key={i} x={PAD.l - 6} y={t.svgY + 4} textAnchor="end"
            fontSize={9} fill="var(--muted)">
            {t.y >= 0 ? "+" : ""}{(t.y * 100).toFixed(0)}%
          </text>
        ))}
        {/* Grid lines */}
        {yTicks.map((t, i) => (
          <line key={i} x1={PAD.l} y1={t.svgY} x2={W - PAD.r} y2={t.svgY}
            stroke="var(--border)" strokeWidth={0.5} />
        ))}
        {/* Fill area */}
        <polygon
          points={`${toSvgX(0)},${toSvgY(0)} ${polyline} ${toSvgX(maxX)},${toSvgY(0)}`}
          fill={isProfit ? "rgba(52,211,153,0.08)" : "rgba(239,68,68,0.08)"}
        />
        {/* Equity line */}
        <polyline points={polyline} fill="none"
          stroke={isProfit ? "var(--green)" : "var(--red)"} strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round"
        />
        {/* X-axis */}
        <text x={PAD.l} y={H - 6} fontSize={9} fill="var(--muted)">Trade 1</text>
        <text x={W - PAD.r} y={H - 6} fontSize={9} fill="var(--muted)" textAnchor="end">
          Trade {trades.length}
        </text>
        {/* Last value label */}
        <text x={toSvgX(maxX) + 4} y={lastSvgY + 4} fontSize={10}
          fill={isProfit ? "var(--green)" : "var(--red)"} fontWeight="600">
          {lastP.y >= 0 ? "+" : ""}{(lastP.y * 100).toFixed(1)}%
        </text>
      </svg>
    </div>
  );
}

function PnlHistogram({ trades }: { trades: ClosedTradeRecord[] }) {
  if (!trades.length) return null;
  const vals = trades.map(t => (t.pnlPct ?? 0) * (t.leverage ?? 10) * 100);
  const min  = Math.floor(Math.min(...vals));
  const max  = Math.ceil(Math.max(...vals));
  const bucketCount = Math.min(20, Math.max(8, trades.length));
  const step = (max - min) / bucketCount || 1;

  const buckets: { label: string; count: number; isPos: boolean }[] = Array.from({ length: bucketCount }, (_, i) => {
    const lo = min + i * step, hi = lo + step;
    return {
      label: `${lo.toFixed(0)}%`,
      count: vals.filter(v => v >= lo && (i === bucketCount - 1 ? v <= hi : v < hi)).length,
      isPos: lo >= 0,
    };
  });

  const maxCount = Math.max(...buckets.map(b => b.count), 1);
  const W = 560, H = 140, PAD = { t: 10, r: 12, b: 28, l: 32 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;
  const bW  = iW / bucketCount;

  return (
    <div className="chart-container">
      <div className="chart-title">PnL Distribution</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="equity-svg">
        {buckets.map((b, i) => {
          const bH   = (b.count / maxCount) * iH;
          const bX   = PAD.l + i * bW + 1;
          const bY   = PAD.t + iH - bH;
          return (
            <g key={i}>
              <rect x={bX} y={bY} width={Math.max(bW - 2, 1)} height={bH}
                fill={b.isPos ? "rgba(52,211,153,0.55)" : "rgba(239,68,68,0.55)"}
                rx={1}
              />
              {b.count > 0 && bH > 14 && (
                <text x={bX + (bW - 2) / 2} y={bY + 11} textAnchor="middle"
                  fontSize={9} fill="var(--text)">{b.count}</text>
              )}
            </g>
          );
        })}
        {/* X-axis labels (every 4 buckets) */}
        {buckets.map((b, i) => i % 4 === 0 && (
          <text key={i} x={PAD.l + i * bW + bW / 2} y={H - 6}
            textAnchor="middle" fontSize={9} fill="var(--muted)">{b.label}</text>
        ))}
        {/* Zero line */}
        {buckets.some(b => !b.isPos) && buckets.some(b => b.isPos) && (
          <line
            x1={PAD.l + buckets.findIndex(b => b.isPos) * bW}
            y1={PAD.t} x2={PAD.l + buckets.findIndex(b => b.isPos) * bW} y2={PAD.t + iH}
            stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 2"
          />
        )}
      </svg>
    </div>
  );
}

function AnalyticsPanel({ data, loading, err, onRefresh }: {
  data: PerfData | null;
  loading: boolean;
  err: string | null;
  onRefresh: () => void;
}) {
  if (loading) return <div className="empty-state"><Spinner /><p>Loading analytics…</p></div>;
  if (err)     return <div className="empty-state"><AlertTriangle size={24} /><p>{err}</p><button className="sym-refresh" onClick={onRefresh}><RefreshCw size={12} /> Retry</button></div>;
  if (!data || data.count === 0) return (
    <div className="empty-state">
      <BarChart2 size={32} className="empty-icon" />
      <p>No trade data yet</p>
      <span>Analytics will populate once the bot closes positions.</span>
      <button className="sym-refresh" style={{ marginTop: 12 }} onClick={onRefresh}><RefreshCw size={12} /> Check Now</button>
    </div>
  );

  const { metrics, trades } = data;
  const sorted = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

  // ── Extended risk metrics ─────────────────────────────────────────────────
  const levReturns = sorted.map(t => (t.pnlPct ?? 0) * (t.leverage ?? 10));
  const totalReturn = levReturns.reduce((a, b) => a + b, 0);
  const avgReturn   = levReturns.length ? totalReturn / levReturns.length : 0;

  // Sortino — downside deviation (using 0 as target)
  const downside = levReturns.filter(r => r < 0);
  const downsideDev = downside.length
    ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length)
    : 0;
  const sortino = downsideDev > 0 ? avgReturn / downsideDev : 0;

  // Calmar — annualised return / max drawdown (approximate with total/maxDD)
  const calmar = metrics.maxDrawdown > 0 ? totalReturn / metrics.maxDrawdown : 0;

  // Recovery Factor — total profit / max drawdown
  const totalProfit = levReturns.reduce((a, r) => a + Math.max(0, r), 0);
  const recovery    = metrics.maxDrawdown > 0 ? totalProfit / metrics.maxDrawdown : 0;

  // ── Streak analysis ───────────────────────────────────────────────────────
  let curStreak = 0, maxWin = 0, maxLoss = 0, streakType: "W" | "L" | null = null;
  for (const t of sorted) {
    const win = (t.pnlPct ?? 0) >= 0;
    if (streakType === null) { streakType = win ? "W" : "L"; curStreak = 1; }
    else if ((win && streakType === "W") || (!win && streakType === "L")) { curStreak++; }
    else { streakType = win ? "W" : "L"; curStreak = 1; }
    if (streakType === "W") maxWin  = Math.max(maxWin, curStreak);
    else                    maxLoss = Math.max(maxLoss, curStreak);
  }
  const curStreakLabel = curStreak > 0 && streakType
    ? `${curStreak} ${streakType === "W" ? "Wins" : "Losses"}`
    : "—";

  // ── Per-symbol breakdown ──────────────────────────────────────────────────
  const bySymbol = new Map<string, { wins: number; losses: number; totalLev: number; count: number }>();
  for (const t of trades) {
    const sym = t.symbol ?? "?";
    const entry = bySymbol.get(sym) ?? { wins: 0, losses: 0, totalLev: 0, count: 0 };
    const win   = (t.pnlPct ?? 0) >= 0;
    entry.wins    += win ? 1 : 0;
    entry.losses  += win ? 0 : 1;
    entry.totalLev += (t.pnlPct ?? 0) * (t.leverage ?? 10);
    entry.count   += 1;
    bySymbol.set(sym, entry);
  }

  // ── Per-strategy breakdown ────────────────────────────────────────────────
  const byStrategy = new Map<string, { wins: number; losses: number; totalLev: number; count: number }>();
  for (const t of (trades as any[])) {
    const strat = (t as any).strategy ?? "trend_range_fork";
    const entry = byStrategy.get(strat) ?? { wins: 0, losses: 0, totalLev: 0, count: 0 };
    const win   = (t.pnlPct ?? 0) >= 0;
    entry.wins    += win ? 1 : 0;
    entry.losses  += win ? 0 : 1;
    entry.totalLev += (t.pnlPct ?? 0) * (t.leverage ?? 10);
    entry.count   += 1;
    byStrategy.set(strat, entry);
  }

  // ── Avg duration by side ──────────────────────────────────────────────────
  const longTrades  = trades.filter(t => t.isLong);
  const shortTrades = trades.filter(t => !t.isLong);
  const avgDurLong  = longTrades.length  ? longTrades.reduce((a, t) => a + (t.durationMs ?? 0), 0) / longTrades.length : 0;
  const avgDurShort = shortTrades.length ? shortTrades.reduce((a, t) => a + (t.durationMs ?? 0), 0) / shortTrades.length : 0;

  const fmtPctA = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

  return (
    <div className="analytics-panel">
      {/* Equity Curve */}
      <EquityCurve trades={sorted} />

      {/* Risk Metrics */}
      <div className="analytics-section-title">Extended Risk Metrics</div>
      <div className="metrics-grid">
        <MetricCard label="Sortino Ratio"    value={sortino.toFixed(2)}  color={sortino >= 1 ? "green" : "red"} />
        <MetricCard label="Calmar Ratio"     value={calmar.toFixed(2)}   color={calmar >= 1 ? "green" : "red"} />
        <MetricCard label="Recovery Factor"  value={recovery.toFixed(2)} color={recovery >= 1 ? "green" : "red"} />
        <MetricCard label="Avg Trade (lev)"  value={fmtPctA(avgReturn)}  color={avgReturn >= 0 ? "green" : "red"} />
        <MetricCard label="Total Return"     value={fmtPctA(totalReturn)} color={totalReturn >= 0 ? "green" : "red"} />
        <MetricCard label="Avg Win"
          value={fmtPctA(levReturns.filter(r => r >= 0).reduce((a, b) => a + b, 0) / Math.max(metrics.winCount, 1))}
          color="green" />
        <MetricCard label="Avg Loss"
          value={fmtPctA(levReturns.filter(r => r < 0).reduce((a, b) => a + b, 0) / Math.max(metrics.lossCount, 1))}
          color="red" />
        <MetricCard label="Win/Loss Ratio"
          value={(metrics.winCount / Math.max(metrics.lossCount, 1)).toFixed(2)}
          color={metrics.winCount >= metrics.lossCount ? "green" : "red"} />
      </div>

      {/* Streak */}
      <div className="analytics-section-title">Streak Analysis</div>
      <div className="metrics-grid">
        <MetricCard label="Current Streak" value={curStreakLabel}
          color={streakType === "W" ? "green" : streakType === "L" ? "red" : undefined} />
        <MetricCard label="Max Win Streak"  value={`${maxWin} W`}  color="green" />
        <MetricCard label="Max Loss Streak" value={`${maxLoss} L`} color="red" />
        <MetricCard label="LONG Trades"     value={String(longTrades.length)} />
        <MetricCard label="SHORT Trades"    value={String(shortTrades.length)} />
        <MetricCard label="Avg LONG Dur"    value={fmtDuration(avgDurLong)} />
        <MetricCard label="Avg SHORT Dur"   value={fmtDuration(avgDurShort)} />
        <MetricCard label="Avg Duration"    value={fmtDuration(metrics.avgDurationMs)} />
      </div>

      {/* PnL Histogram */}
      <PnlHistogram trades={sorted} />

      {/* Per-Symbol Breakdown */}
      {bySymbol.size > 1 && (
        <>
          <div className="analytics-section-title">Performance by Symbol</div>
          <div className="analytics-table">
            <div className="analytics-table-header">
              <span>Symbol</span><span>Trades</span><span>Win Rate</span><span>Total PnL (lev)</span>
            </div>
            {[...bySymbol.entries()].sort((a, b) => b[1].totalLev - a[1].totalLev).map(([sym, s]) => {
              const wr = s.wins / s.count;
              const lev = s.totalLev;
              return (
                <div className="analytics-table-row" key={sym}>
                  <span style={{ fontWeight: 600 }}>{sym}</span>
                  <span>{s.count}</span>
                  <span className={wr >= 0.5 ? "pnl-pos" : "pnl-neg"}>{(wr * 100).toFixed(0)}%</span>
                  <span className={lev >= 0 ? "pnl-pos" : "pnl-neg"}>{lev >= 0 ? "+" : ""}{(lev * 100).toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Per-Strategy Breakdown */}
      {byStrategy.size > 1 && (
        <>
          <div className="analytics-section-title">Performance by Strategy</div>
          <div className="analytics-table">
            <div className="analytics-table-header">
              <span>Strategy</span><span>Trades</span><span>Win Rate</span><span>Total PnL (lev)</span>
            </div>
            {[...byStrategy.entries()].sort((a, b) => b[1].totalLev - a[1].totalLev).map(([strat, s]) => {
              const wr = s.wins / s.count;
              const lev = s.totalLev;
              return (
                <div className="analytics-table-row" key={strat}>
                  <span style={{ fontWeight: 600 }}>{strat.replace(/_/g, " ")}</span>
                  <span>{s.count}</span>
                  <span className={wr >= 0.5 ? "pnl-pos" : "pnl-neg"}>{(wr * 100).toFixed(0)}%</span>
                  <span className={lev >= 0 ? "pnl-pos" : "pnl-neg"}>{lev >= 0 ? "+" : ""}{(lev * 100).toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button className="sym-refresh" onClick={onRefresh}><RefreshCw size={12} /> Refresh</button>
      </div>
    </div>
  );
}

// ── PerfTabView — toggles Summary ↔ Analytics ────────────────────────────────

function PerfTabView({ data, loading, err, onRefresh }: {
  data: PerfData | null;
  loading: boolean;
  err: string | null;
  onRefresh: () => void;
}) {
  const [view, setView] = useState<"summary" | "analytics">("summary");
  return (
    <div>
      <div className="perf-subtab-nav">
        <button
          className={`perf-subtab-btn ${view === "summary" ? "perf-subtab-active" : ""}`}
          onClick={() => setView("summary")}
        >
          <BarChart2 size={13} /> Summary
        </button>
        <button
          className={`perf-subtab-btn ${view === "analytics" ? "perf-subtab-active" : ""}`}
          onClick={() => setView("analytics")}
        >
          <TrendingUp size={13} /> Analytics
        </button>
      </div>
      {view === "summary"
        ? <PerformancePanel data={data} loading={loading} err={err} onRefresh={onRefresh} />
        : <AnalyticsPanel   data={data} loading={loading} err={err} onRefresh={onRefresh} />
      }
    </div>
  );
}

// ── Backtest Panel ────────────────────────────────────────────────────────────

function BacktestPanel({ defaultSymbols }: { defaultSymbols: string[] }) {
  const [symbol, setSymbol]   = useState(defaultSymbols[0] ?? "BTCUSDT");
  const [days, setDays]       = useState("7");
  const [leverage, setLev]    = useState("5");
  const [result, setResult]   = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  async function runBacktest() {
    setLoading(true);
    setErr(null);
    setResult(null);
    try {
      const r: any = await apiFetch(
        `/backtest/run?symbol=${symbol}&days=${days}&leverage=${leverage}`
      );
      if (r.ok) setResult(r as BacktestResult);
      else setErr(r.error ?? "Backtest failed");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="backtest-panel">
      {/* Form */}
      <div className="backtest-form">
        <div className="bt-field">
          <label>Symbol</label>
          <select className="bt-input" value={symbol} onChange={e => setSymbol(e.target.value)}>
            {(defaultSymbols.length ? defaultSymbols : ["BTCUSDT","ETHUSDT","TAOUSDT","RENDERUSDT"]).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="bt-field">
          <label>Lookback (days)</label>
          <input type="number" min={1} max={30} className="bt-input" value={days} onChange={e => setDays(e.target.value)} />
        </div>
        <div className="bt-field">
          <label>Leverage</label>
          <input type="number" min={1} max={20} className="bt-input" value={leverage} onChange={e => setLev(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={runBacktest} disabled={loading} style={{ alignSelf: "flex-end" }}>
          {loading ? <><Spinner /> Running…</> : "▶ Run Backtest"}
        </button>
      </div>

      {err && (
        <div className="error-banner"><AlertTriangle size={14} /><span>{err}</span></div>
      )}

      {loading && (
        <div className="empty-state"><Spinner /><p>Fetching {days} days of 5m bars for {symbol}…</p><span>This may take up to 15s for the first run.</span></div>
      )}

      {result && !loading && (() => {
        const m = result.metrics;
        const pfStr = m.profitFactor >= 99 ? "∞" : m.profitFactor.toFixed(2);
        return (
          <>
            <div className="bt-result-header">
              <TrendingUp size={14} />
              <span style={{ fontWeight: 600 }}>{result.symbol} — {result.days}d backtest</span>
              <span>{result.bars} bars · {result.trades.length} trades</span>
              {result.cached && <span className="bt-cached-badge">cached</span>}
              <span style={{ color: "var(--muted)" }}>{new Date(result.generatedAt).toLocaleTimeString()}</span>
            </div>

            {/* Metrics grid */}
            <div className="metrics-grid">
              <MetricCard label="Win Rate" value={fmtPct(m.winRate)} color={m.winRate >= 0.5 ? "green" : "red"} />
              <MetricCard label="Profit Factor" value={pfStr} color={m.profitFactor >= 1 ? "green" : "red"} />
              <MetricCard label="Max Drawdown" value={fmtPct(m.maxDrawdown)} color={m.maxDrawdown < 0.15 ? "green" : "red"} />
              <MetricCard label="Sharpe" value={m.sharpeRatio.toFixed(2)} color={m.sharpeRatio >= 1 ? "green" : "red"} />
              <MetricCard label="Total PnL (lev)" value={(m.totalPnlPct >= 0 ? "+" : "") + fmtPct(m.totalPnlPct)} color={m.totalPnlPct >= 0 ? "green" : "red"} />
              <MetricCard label="Avg Trade PnL" value={(m.avgPnlPct >= 0 ? "+" : "") + fmtPct(m.avgPnlPct)} color={m.avgPnlPct >= 0 ? "green" : "red"} />
              <MetricCard label="Best Trade" value={"+" + fmtPct(m.bestTrade)} color="green" />
              <MetricCard label="Worst Trade" value={fmtPct(m.worstTrade)} color="red" />
            </div>

            {/* Trade list */}
            {result.trades.length > 0 && (
              <>
                <div className="bt-trade-header">
                  <span>Side</span><span>Entry</span><span>Exit</span><span>PnL (lev)</span><span>Reason</span><span>Duration</span>
                </div>
                <div className="bt-trades-list">
                  {result.trades.map((t, i) => {
                    const lev = t.leverage ?? Number(leverage);
                    const levPnl = t.pnlPct * lev;
                    const pos = levPnl >= 0;
                    return (
                      <div className="bt-trade-row" key={i}>
                        <span className={t.isLong ? "side-chip-long" : "side-chip-short"}>{t.isLong ? "L" : "S"}</span>
                        <span>{t.entryPrice.toFixed(4)}</span>
                        <span>{t.exitPrice.toFixed(4)}</span>
                        <span className={pos ? "pnl-pos" : "pnl-neg"}>{pos ? "+" : ""}{(levPnl * 100).toFixed(2)}%</span>
                        <span style={{ color: "var(--muted)", fontSize: 11 }}>{t.reason}</span>
                        <span style={{ color: "var(--muted)" }}>{fmtDuration(t.durationMs)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {result.trades.length === 0 && (
              <div className="empty-state">
                <X size={24} className="empty-icon" />
                <p>No trades generated</p>
                <span>Strategy found no signals in this {result.days}-day window. Try more days or adjust stoch params.</span>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

// ── Per-symbol max leverage lookup (mirrors backend SYMBOL_MAX_LEVERAGE) ──────
const SYMBOL_MAX_LEV: Record<string, number> = {
  BTCUSDT:    100,
  ETHUSDT:    100,
  TAOUSDT:     30,
  RENDERUSDT:  30,
  SOLUSDT:     50,
  BNBUSDT:     75,
  XRPUSDT:     50,
  DOGEUSDT:    25,
};

function getMaxLev(symbols: string[]): number {
  if (!symbols.length) return 100;
  return Math.min(...symbols.map(s => SYMBOL_MAX_LEV[s.toUpperCase()] ?? 20));
}

// ── Launch Controls ───────────────────────────────────────────────────────────
// Visible on the dashboard whenever the bot is STOPPED.
// Lets the user dial in leverage and position sizing before pressing Start.

function LaunchControls({
  symbols,
  leverage, setLeverage,
  sizeMode, setSizeMode,
  manualSizePct, setManualSizePct,
  isRunning,
}: {
  symbols:         string[];
  leverage:        number;
  setLeverage:     (v: number) => void;
  sizeMode:        "auto" | "manual";
  setSizeMode:     (v: "auto" | "manual") => void;
  manualSizePct:   number;
  setManualSizePct:(v: number) => void;
  isRunning:       boolean;
}) {
  const maxLev = getMaxLev(symbols);
  const cappedLev = Math.min(leverage, maxLev);

  // Sync if symbols change and current leverage exceeds new cap
  if (cappedLev !== leverage) setLeverage(cappedLev);

  const leverageColor =
    cappedLev <= 10 ? "var(--green)" :
    cappedLev <= 30 ? "var(--orange)" : "var(--red)";

  const leverageLabel =
    cappedLev <= 10 ? "Conservative" :
    cappedLev <= 30 ? "Moderate" :
    cappedLev <= 75 ? "Aggressive" : "Max Risk";

  // ── Tier classification ───────────────────────────────────────────────────
  const isTier2 = cappedLev >= 40;
  const tierLabel    = isTier2 ? "Tier 2" : "Tier 1";
  const tierColor    = isTier2 ? "var(--red)" : "var(--green)";
  // Dynamic stop display
  const tier1Stop    = "1% raw";
  const tier2StopPct = Math.min(0.8, Math.max(0.5, 30 / cappedLev));
  const tier2Stop    = `${tier2StopPct.toFixed(2)}% raw (ATR-scaled)`;
  const stopDisplay  = isTier2 ? tier2Stop : tier1Stop;
  // Max vault risk per bad trade
  const maxVaultRisk = isTier2
    ? `~${(0.005 * cappedLev * 15).toFixed(1)}%`   // 0.5% floor × leverage × 15% collateral
    : "~4.5%";                                       // fixed: 1% × 30× × 15%

  return (
    <div className="launch-controls">

      {/* Header row — title + running badge */}
      <div className="launch-header">
        <span className="launch-title">⚙ Leverage &amp; Sizing</span>
        {isRunning
          ? <span className="launch-running-badge">🟡 Bot running — changes apply on next restart</span>
          : <span className="launch-ready-badge">🟢 Ready to configure — press Start when set</span>
        }
      </div>

      {/* ── Leverage section ── */}
      <div className="launch-section">
        <div className="launch-label">
          <span>Leverage</span>
          <span className="launch-val" style={{ color: leverageColor }}>
            {cappedLev}× <span className="launch-risk">{leverageLabel}</span>
          </span>
        </div>

        {/* Slider + numeric input */}
        <div className="lev-slider-row">
          <span className="lev-mark">1×</span>
          <input
            type="range"
            min={1}
            max={maxLev}
            step={1}
            value={cappedLev}
            className="lev-slider"
            style={{ "--lev-color": leverageColor } as React.CSSProperties}
            onChange={e => setLeverage(Number(e.target.value))}
          />
          <span className="lev-mark">{maxLev}×</span>
          <input
            type="number"
            min={1}
            max={maxLev}
            value={cappedLev}
            className="lev-num-input"
            onChange={e => setLeverage(Math.min(maxLev, Math.max(1, Number(e.target.value))))}
          />
        </div>

        {/* Quick preset buttons */}
        <div className="lev-presets">
          {[5, 10, 20, 50].filter(v => v <= maxLev).map(v => (
            <button
              key={v}
              className={`lev-preset ${cappedLev === v ? "active" : ""}`}
              onClick={() => setLeverage(v)}
            >{v}×</button>
          ))}
          <button
            className={`lev-preset ${cappedLev === maxLev ? "active" : ""}`}
            onClick={() => setLeverage(maxLev)}
          >Max ({maxLev}×)</button>
        </div>

        {/* Per-symbol cap notice */}
        {maxLev < 100 && (
          <div className="lev-cap-note">
            ⚠ Max {maxLev}× for {symbols.filter(s => (SYMBOL_MAX_LEV[s.toUpperCase()] ?? 20) <= maxLev).join(", ")}
            &nbsp;· BTC/ETH support up to 100×
          </div>
        )}
      </div>

      {/* ── Position Sizing section ── */}
      <div className="launch-section">
        <div className="launch-label">
          <span>Position Sizing</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="launch-val" style={{ color: "var(--accent)" }}>
              {sizeMode === "auto" ? "Auto (ATR-scaled)" : `${manualSizePct}% of vault per trade`}
            </span>
            {sizeMode === "auto" && (
              <span className="tier-badge" style={{ background: tierColor }}>
                {tierLabel}
              </span>
            )}
          </span>
        </div>

        <div className="size-toggle-row">
          <button
            className={`size-mode-btn ${sizeMode === "auto" ? "active" : ""}`}
            onClick={() => setSizeMode("auto")}
          >🤖 Auto (recommended)</button>
          <button
            className={`size-mode-btn ${sizeMode === "manual" ? "active" : ""}`}
            onClick={() => setSizeMode("manual")}
          >✋ Manual</button>
        </div>

        {sizeMode === "auto" && !isTier2 && (
          <div className="size-note">
            Allocates <strong>15% of vault</strong> per trade, scaled by ATR volatility
            <strong> (0.5× – 2.0×)</strong> → <strong>7.5%–30%</strong> collateral.
            Stop-loss: <strong>{stopDisplay}</strong> · Max vault risk/trade: <strong>{maxVaultRisk}</strong>.
            Fully automatic — no setup needed.
          </div>
        )}

        {sizeMode === "auto" && isTier2 && (
          <div className="size-note size-note-tier2">
            <strong>⚡ Tier 2 — High Leverage Mode</strong><br />
            Allocates <strong>15% of vault</strong> per trade, ATR-scaled
            <strong> (0.5× – 1.0×)</strong> → <strong>7.5%–15%</strong> collateral.
            Stop-loss: <strong>{stopDisplay}</strong> · Max vault risk/trade: <strong>{maxVaultRisk}</strong>.<br />
            Entry <strong>blocked</strong> during dumps/pumps (ATR &gt; 0.3%). Auto only.
          </div>
        )}

        {sizeMode === "manual" && (
          <>
            <div className="size-manual-row">
              <span className="lev-mark">1%</span>
              <input
                type="range"
                min={1}
                max={50}
                step={1}
                value={manualSizePct}
                className="lev-slider"
                style={{ "--lev-color": "var(--accent)" } as React.CSSProperties}
                onChange={e => setManualSizePct(Number(e.target.value))}
              />
              <span className="lev-mark">50%</span>
              <input
                type="number"
                min={1}
                max={50}
                value={manualSizePct}
                className="lev-num-input"
                onChange={e => setManualSizePct(Math.min(50, Math.max(1, Number(e.target.value))))}
              />
              <span className="size-pct-label">% of vault</span>
            </div>
            <div className="size-note" style={{ marginTop: 8 }}>
              Each trade uses <strong>{manualSizePct}%</strong> of your vault balance × {cappedLev}× leverage.
              ATR volatility scaling is bypassed.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

interface RiskData {
  dailyReturn:    number;
  dailyReturnPct: number;
  circuitBreaker: { triggered: boolean; limit: number; limitPct: number };
  maxDailyLossPct: number;
  date:           string;
}

interface AiModelStats {
  featureCount: number;
  totalTrades:  number;
  topSetups:    Array<{ key: string; winRate: number; total: number; bonus: number }>;
  worstSetups:  Array<{ key: string; winRate: number; total: number; bonus: number }>;
  lastUpdated:  number;
}

// ── Deposit / Withdraw Panel ──────────────────────────────────────────────────
function DepositWithdrawPanel({ walletData, onRefresh }: { walletData: WalletData | null; onRefresh: () => void }) {
  const [mode, setMode]               = useState<"deposit" | "withdraw">("deposit");
  const [withdrawMode, setWithdrawMode] = useState<"normal" | "emergency">("normal");
  const [amount, setAmount]           = useState("");
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState<{ txHash: string; net: number; fee: string } | null>(null);
  const [err, setErr]                 = useState<string | null>(null);
  // Send-to-MetaMask state
  const [sendAddr, setSendAddr]       = useState("");
  const [sendAmt, setSendAmt]         = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendResult, setSendResult]   = useState<string | null>(null);
  const [sendErr, setSendErr]         = useState<string | null>(null);
  const [showSend, setShowSend]       = useState(false);

  const maxDeposit  = walletData?.wallet.formatted    ?? 0;
  const maxWithdraw = walletData?.vault.formatted      ?? 0;
  const minDeposit  = walletData?.minDeposit.formatted ?? 0;
  const pending     = walletData?.pending.formatted    ?? 0;
  const fees        = walletData?.fees;

  function resetFeedback() { setErr(null); setResult(null); }

  // Preview: net amount the user will receive / be credited
  function previewNet(): number | null {
    const amt = parseFloat(amount);
    if (!amt || !fees) return null;
    if (mode === "deposit")
      return +(amt * fees.depositNet / 100).toFixed(2);
    if (withdrawMode === "normal")
      return +(amt * fees.withdrawNet / 100).toFixed(2);
    return +(amt * fees.emergencyNet / 100).toFixed(2);
  }

  async function handleDeposit() {
    const amt = parseFloat(amount);
    if (!amt || amt < minDeposit) { setErr(`Minimum deposit: $${minDeposit} USDC`); return; }
    if (amt > maxDeposit) { setErr(`Insufficient wallet balance ($${maxDeposit.toFixed(2)} available)`); return; }
    setLoading(true); resetFeedback();
    try {
      const r: any = await apiFetch("/vault/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt }),
      });
      if (!r.ok) throw new Error(r.error ?? "Deposit failed");
      setResult({ txHash: r.txHash, net: r.netCredited ?? amt, fee: r.platformFeeUsdc != null ? `$${Number(r.platformFeeUsdc).toFixed(2)}` : (r.platformFee ?? "?") });
      setAmount("");
      onRefresh();
    } catch (e: any) {
      setErr(e?.message ?? "Deposit failed");
    } finally { setLoading(false); }
  }

  async function handleWithdraw(all?: boolean) {
    const grossAmt = all ? maxWithdraw : parseFloat(amount);
    if (!grossAmt || grossAmt <= 0) { setErr("Enter an amount to withdraw"); return; }
    if (grossAmt > maxWithdraw) { setErr(`Insufficient vault balance ($${maxWithdraw.toFixed(2)} available)`); return; }

    const eth = (window as any).ethereum;
    if (!eth) { setErr("No wallet connected — open this page inside MetaMask browser"); return; }

    setLoading(true); resetFeedback();
    try {
      const DECIMALS = walletData?.wallet.decimals ?? 6;
      const feePct   = withdrawMode === "normal" ? (fees?.withdrawPct ?? 10) : (fees?.emergencyPct ?? 15);
      const netAmt   = +(grossAmt * (1 - feePct / 100)).toFixed(6);
      const netRaw    = BigInt(Math.round(netAmt * 10 ** DECIMALS));
      const vaultAddr = walletData!.vaultAddress;

      // ABI-encode: functionSelector(4 bytes) + uint256(32 bytes)
      function encodeCall(selector: string, amount: bigint): string {
        return selector + amount.toString(16).padStart(64, "0");
      }

      // Step 1: User signs the withdrawal initiation via MetaMask
      // initiateWithdrawStable(uint256) selector = 0x754da337
      // emergencyWithdrawStable(uint256) selector = 0x3ccfd60b
      const selector = withdrawMode === "emergency" ? "0x3ccfd60b" : "0x754da337";
      const callAmount = withdrawMode === "emergency" ? netRaw : netRaw; // both use net (fee stays in vault)

      const initTxHash: string = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: (await eth.request({ method: "eth_accounts" }))[0], to: vaultAddr, data: encodeCall(selector, callAmount) }],
      });

      // Wait for MetaMask TX to be mined
      setResult({ txHash: initTxHash, net: 0, fee: "pending…" });
      let mined = false;
      for (let i = 0; i < 60 && !mined; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const receipt: any = await eth.request({ method: "eth_getTransactionReceipt", params: [initTxHash] });
        if (receipt?.status === "0x1") mined = true;
        if (receipt?.status === "0x0") throw new Error("Transaction reverted on-chain");
      }
      if (!mined) throw new Error("Transaction not confirmed after 3 minutes");

      if (withdrawMode === "emergency") {
        // Emergency: user TX is self-contained — just record fees on backend
        const r: any = await apiFetch("/vault/record-emergency-withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grossAmount: grossAmt, txHash: initTxHash }),
        });
        setResult({ txHash: initTxHash, net: +(netAmt * 0.85).toFixed(2), fee: r.fees?.totalFee != null ? `$${Number(r.fees.totalFee).toFixed(2)}` : "?" });
      } else {
        // Normal: backend bot signer calls approveWithdrawStable
        const r: any = await apiFetch("/vault/approve-withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ netAmountRaw: netRaw.toString(), grossAmount: grossAmt, mode: "normal" }),
        });
        if (!r.ok) throw new Error(r.error ?? "Approval failed");
        setResult({ txHash: r.txHash, net: r.netReceived ?? netAmt, fee: r.totalPlatformFee != null ? `$${Number(r.totalPlatformFee).toFixed(2)}` : "?" });
      }

      setAmount("");
      onRefresh();
    } catch (e: any) {
      setErr(e?.message ?? "Withdraw failed");
    } finally { setLoading(false); }
  }

  const net = previewNet();

  async function handleSend() {
    const amt = parseFloat(sendAmt);
    const walletBal = walletData?.wallet.formatted ?? 0;
    if (!sendAddr || !/^0x[0-9a-fA-F]{40}$/.test(sendAddr)) { setSendErr("Enter a valid 0x wallet address"); return; }
    if (!amt || amt <= 0) { setSendErr("Enter an amount"); return; }
    if (amt > walletBal) { setSendErr(`Insufficient wallet balance ($${walletBal.toFixed(2)} USDC available)`); return; }
    setSendLoading(true); setSendErr(null); setSendResult(null);
    try {
      const r: any = await apiFetch("/vault/send-to-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toAddress: sendAddr, amount: amt }),
      });
      if (!r.ok) throw new Error(r.error ?? "Transfer failed");
      setSendResult(r.txHash);
      setSendAmt("");
      onRefresh();
    } catch (e: any) {
      setSendErr(e?.message ?? "Transfer failed");
    } finally { setSendLoading(false); }
  }

  return (
    <div className="dw-panel">
      {/* Balance summary */}
      <div className="dw-balance-row">
        <div className="dw-balance-card">
          <div className="dw-balance-label">Wallet Balance</div>
          <div className="dw-balance-val">
            ${(walletData?.wallet.formatted ?? 0).toFixed(2)}
            <span className="dw-unit"> USDC</span>
          </div>
          <div className="dw-balance-sub">Available to deposit</div>
        </div>
        <div className="dw-balance-arrow">⇄</div>
        <div className="dw-balance-card dw-balance-vault">
          <div className="dw-balance-label">Vault Balance</div>
          <div className="dw-balance-val dw-balance-green">
            ${(walletData?.vault.formatted ?? 0).toFixed(2)}
            <span className="dw-unit"> USDC</span>
          </div>
          <div className="dw-balance-sub">
            Trading capital
            {pending > 0 && <span className="dw-pending-badge"> · ${pending.toFixed(2)} pending</span>}
          </div>
        </div>
        <button className="sym-refresh dw-refresh" onClick={onRefresh} title="Refresh balances">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Send to MetaMask */}
      <div className="dw-send-section">
        <button className="dw-send-toggle" onClick={() => { setShowSend(s => !s); setSendErr(null); setSendResult(null); }}>
          📤 Send Wallet Balance to MetaMask {showSend ? "▲" : "▼"}
        </button>
        {showSend && (
          <div className="dw-send-form">
            <div className="dw-send-hint">Transfers USDC from Bot Wallet → your MetaMask address on Arbitrum One</div>
            <input
              className="dw-send-input"
              placeholder="Destination address (0x...)"
              value={sendAddr}
              onChange={e => { setSendAddr(e.target.value); setSendErr(null); }}
            />
            <div className="dw-send-row">
              <div className="dw-input-wrap" style={{ flex: 1 }}>
                <span className="dw-input-prefix">$</span>
                <input
                  type="number"
                  className="dw-input"
                  placeholder="Amount"
                  value={sendAmt}
                  min={0}
                  step="0.01"
                  onChange={e => { setSendAmt(e.target.value); setSendErr(null); }}
                />
              </div>
              <button className="dw-send-max" onClick={() => setSendAmt(String(walletData?.wallet.formatted ?? ""))}>MAX</button>
            </div>
            <button className="dw-send-btn" onClick={handleSend} disabled={sendLoading}>
              {sendLoading ? "Sending…" : "Send USDC to MetaMask"}
            </button>
            {sendErr    && <div className="dw-error">{sendErr}</div>}
            {sendResult && (
              <div className="dw-success">
                ✅ Sent! TX: <a href={`https://arbiscan.io/tx/${sendResult}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{sendResult.slice(0,18)}…</a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pending withdrawal notice */}
      {pending > 0 && (
        <div className="dw-pending-notice">
          ⏳ <strong>${pending.toFixed(2)} USDC</strong> pending withdrawal in queue
        </div>
      )}

      {/* Deposit / Withdraw toggle */}
      <div className="dw-tab-row">
        <button
          className={`dw-tab-btn ${mode === "deposit" ? "dw-tab-active" : ""}`}
          onClick={() => { setMode("deposit"); setAmount(""); resetFeedback(); }}
        >
          <ArrowDown size={13} /> Deposit
        </button>
        <button
          className={`dw-tab-btn ${mode === "withdraw" ? "dw-tab-active" : ""}`}
          onClick={() => { setMode("withdraw"); setAmount(""); resetFeedback(); }}
        >
          <ArrowUp size={13} /> Withdraw
        </button>
      </div>

      {/* Withdrawal mode: Normal vs Emergency */}
      {mode === "withdraw" && (
        <div className="dw-withdraw-mode-row">
          <button
            className={`dw-mode-btn ${withdrawMode === "normal" ? "dw-mode-active" : ""}`}
            onClick={() => { setWithdrawMode("normal"); resetFeedback(); }}
          >
            Normal <span className="dw-fee-chip">{fees?.withdrawPct ?? "?"}% fee</span>
          </button>
          <button
            className={`dw-mode-btn dw-mode-emergency ${withdrawMode === "emergency" ? "dw-mode-emergency-active" : ""}`}
            onClick={() => { setWithdrawMode("emergency"); resetFeedback(); }}
          >
            🚨 Emergency <span className="dw-fee-chip">{fees?.emergencyPct ?? "?"}% fee</span>
          </button>
        </div>
      )}

      {/* Amount input */}
      <div className="dw-input-row">
        <div className="dw-input-wrap">
          <span className="dw-input-prefix">$</span>
          <input
            type="number"
            className="dw-input"
            placeholder={mode === "deposit" ? `Min $${minDeposit}` : "0.00"}
            value={amount}
            min={0}
            step="0.01"
            onChange={e => { setAmount(e.target.value); resetFeedback(); }}
          />
          <button
            className="dw-max-btn"
            onClick={() => { setAmount(mode === "deposit" ? String(maxDeposit) : String(maxWithdraw)); resetFeedback(); }}
          >MAX</button>
        </div>
        <span className="dw-input-token">USDC</span>
      </div>

      {/* Fee breakdown */}
      {net !== null && amount && (() => {
        const gross   = parseFloat(amount);
        const feeAmt  = +(gross - net).toFixed(2);
        const feePct  = mode === "deposit" ? (fees?.depositPct ?? 0)
          : withdrawMode === "normal" ? (fees?.withdrawPct ?? 0)
          : (fees?.emergencyPct ?? 0);
        return (
          <div className="dw-fee-breakdown">
            <div className="dw-fee-row">
              <span className="dw-fee-label">Gross amount</span>
              <span className="dw-fee-val">${gross.toFixed(2)} USDC</span>
            </div>
            <div className="dw-fee-row dw-fee-row-deduct">
              <span className="dw-fee-label">Platform fee ({feePct}%)</span>
              <span className="dw-fee-val dw-fee-red">−${feeAmt.toFixed(2)} USDC</span>
            </div>
            {mode === "withdraw" && withdrawMode === "normal" && (
              <div className="dw-fee-row">
                <span className="dw-fee-label" style={{ color: "var(--text-secondary)", fontSize: 11 }}>+ 25% profit share on gains (deducted at payout)</span>
                <span className="dw-fee-val" style={{ fontSize: 11, color: "var(--text-secondary)" }}>at close</span>
              </div>
            )}
            <div className="dw-fee-divider" />
            <div className="dw-fee-row dw-fee-row-net">
              <span className="dw-fee-label dw-fee-net-label">
                {mode === "deposit" ? "Net credited to vault" : "Net you receive"}
              </span>
              <span className="dw-fee-val dw-fee-green">${net.toFixed(2)} USDC</span>
            </div>
          </div>
        );
      })()}

      {/* Feedback */}
      {err && <div className="dw-error">⚠ {err}</div>}
      {result && (
        <div className="dw-success">
          ✓ {mode === "deposit" ? "Deposited" : "Withdrawn"} — net:{" "}
          <strong>${result.net.toFixed(2)}</strong> · fee: {result.fee} ·{" "}
          tx: <code className="dw-txhash">{result.txHash.slice(0, 10)}…{result.txHash.slice(-6)}</code>
        </div>
      )}

      {/* Action buttons */}
      {mode === "deposit" ? (
        <button
          className="btn btn-primary dw-action-btn"
          onClick={handleDeposit}
          disabled={loading || !walletData}
        >
          {loading ? "Depositing…" : `Deposit${amount ? ` $${parseFloat(amount).toFixed(2)}` : ""} USDC`}
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={`btn dw-action-btn ${withdrawMode === "emergency" ? "btn-danger" : "btn-primary"}`}
            style={{ flex: 1 }}
            onClick={() => handleWithdraw(false)}
            disabled={loading || !walletData}
          >
            {loading ? "Withdrawing…" : `${withdrawMode === "emergency" ? "🚨 " : ""}Withdraw${amount ? ` $${parseFloat(amount).toFixed(2)}` : ""} USDC`}
          </button>
          <button
            className={`btn dw-action-btn dw-withdraw-all-btn ${withdrawMode === "emergency" ? "dw-withdraw-all-emergency" : ""}`}
            onClick={() => handleWithdraw(true)}
            disabled={loading || !walletData}
          >
            {withdrawMode === "emergency" ? "🚨 All" : "Withdraw All"}
          </button>
        </div>
      )}

      {/* Info footer */}
      <div className="dw-info-footer">
        {mode === "deposit" ? (
          <span>
            Min deposit: <strong>${minDeposit}</strong> USDC · Deposit fee: <strong>{fees?.depositPct ?? "?"}%</strong> · Token: <code>{walletData?.stableToken.slice(0, 8)}…</code>
          </span>
        ) : withdrawMode === "normal" ? (
          <span>
            Normal withdrawal: <strong>{fees?.withdrawPct ?? "?"}%</strong> fee · Bot auto-approves instantly (WITHDRAW_APPROVER_ROLE)
          </span>
        ) : (
          <span style={{ color: "var(--orange)" }}>
            ⚠ Emergency withdrawal bypasses approval — <strong>{fees?.emergencyPct ?? "?"}%</strong> fee applied immediately. Use only when urgent.
          </span>
        )}
      </div>
    </div>
  );
}

// ── Login Page ────────────────────────────────────────────────────────────────

function LoginPage({
  onLogin,
  onRegister,
  onForgot,
}: {
  onLogin: (token: string) => void;
  onRegister: () => void;
  onForgot?: () => void;
}) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [pending,  setPending]  = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setPending(false);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || undefined, password }),
      });
      const data = await r.json();
      if (data.ok && data.token) {
        sessionStorage.setItem(TOKEN_KEY, data.token);
        onLogin(data.token);
      } else if (data.status === "pending_approval") {
        setPending(true);
      } else {
        setError(data.error ?? "Invalid credentials");
      }
    } catch {
      setError("Network error — is the backend running?");
    } finally {
      setLoading(false);
    }
  }

  if (pending) {
    return <PendingApprovalPage onBack={() => setPending(false)} />;
  }

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-logo">
          <Bot size={36} style={{ color: "var(--teal)" }} />
          <h1>UrumTrader</h1>
          <p>Sign in to your trading dashboard</p>
        </div>
        <form onSubmit={handleLogin} className="login-form">
          <input
            type="email"
            className="login-input"
            placeholder="Email address"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            className="login-input"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          {error && <div className="login-error"><AlertTriangle size={13} /> {error}</div>}
          <button type="submit" className="action-btn start-btn login-submit" disabled={loading}>
            {loading ? <RefreshCw size={14} className="spin" /> : <Power size={14} />}
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>
        <p className="login-footer">
          Don't have an account?{" "}
          <button
            onClick={onRegister}
            style={{ background: "none", border: "none", color: "var(--teal)", cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline" }}
          >
            Register
          </button>
          {onForgot && (
            <>
              {" · "}
              <button
                onClick={onForgot}
                style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline" }}
              >
                Forgot password?
              </button>
            </>
          )}
        </p>
        <p className="login-footer" style={{ marginTop: 4 }}>
          UrumTrader v1.0 · Arbitrum One ·{" "}
          <a href="/terms.html" style={{ color: "var(--text-secondary)", textDecoration: "underline" }}>Terms</a>
          {" · "}
          <a href="/privacy.html" style={{ color: "var(--text-secondary)", textDecoration: "underline" }}>Privacy</a>
        </p>
      </div>
    </div>
  );
}

// ── Subscription Banner ───────────────────────────────────────────────────────

interface SubStatus { active: boolean; status: "trial" | "active" | "expired"; daysLeft: number; subscriptionUSDC: number; }

function SubscriptionBanner({ token }: { token: string | null }) {
  const [sub, setSub]             = useState<SubStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [paying, setPaying]       = useState(false);
  const [payDone, setPayDone]     = useState(false);
  const [payErr, setPayErr]       = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    if (!token) return;
    apiFetch("/subscription/status").then((r: any) => {
      if (r.ok !== false) setSub(r as SubStatus);
    }).catch(() => {});
  }, [token]);

  if (!sub || dismissed) return null;

  // Active/trial with plenty of days — hide banner to reduce noise
  if (sub.active && sub.daysLeft > 3 && !payDone) return null;

  const isExpired  = sub.status === "expired";
  const isTrialEnd = sub.status === "trial" && sub.daysLeft <= 3;
  const isSubEnd   = sub.status === "active" && sub.daysLeft <= 3;

  if (!isExpired && !isTrialEnd && !isSubEnd && !payDone) return null;

  const bg     = isExpired ? "rgba(239,68,68,0.1)"  : payDone ? "rgba(0,212,170,0.1)" : "rgba(245,158,11,0.1)";
  const border = isExpired ? "rgba(239,68,68,0.3)"  : payDone ? "rgba(0,212,170,0.3)" : "rgba(245,158,11,0.3)";
  const color  = isExpired ? "#EF4444" : payDone ? "var(--green)" : "#F59E0B";

  const message = payDone
    ? `✓ Subscription renewed! You're active for another 30 days.`
    : isExpired
    ? "⚠ Your subscription has expired. Trading has been paused."
    : `⚠ ${sub.status === "trial" ? "Trial" : "Subscription"} expires in ${sub.daysLeft} day${sub.daysLeft !== 1 ? "s" : ""}.`;

  async function handleRenew() {
    setPaying(true);
    setPayErr(null);
    try {
      const r: any = await apiFetch("/subscription/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: sub!.subscriptionUSDC }),
      });
      if (!r.ok) throw new Error(r.error ?? "Payment failed");
      setPayDone(true);
      setShowConfirm(false);
      // Re-fetch status to update local state
      const fresh: any = await apiFetch("/subscription/status");
      if (fresh.ok !== false) setSub(fresh as SubStatus);
    } catch (e: any) {
      setPayErr(e?.message ?? "Payment failed");
    } finally {
      setPaying(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: bg, border: `1px solid ${border}`, borderRadius: 8, margin: "8px 12px 0", color, fontSize: 13, fontWeight: 500 }}>
        <span style={{ flex: 1 }}>
          {message}
          {!payDone && (
            <> Automated trading requires an active subscription (${sub.subscriptionUSDC} USDC/month).</>
          )}
          {payErr && <span style={{ color: "#EF4444", marginLeft: 8 }}>⚠ {payErr}</span>}
        </span>
        {!payDone && (
          <button
            onClick={() => setShowConfirm(true)}
            disabled={paying}
            style={{ background: isExpired ? "#EF4444" : "#F59E0B", color: "#fff", border: "none", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontWeight: 600, fontSize: 12, whiteSpace: "nowrap", opacity: paying ? 0.6 : 1 }}
          >
            {paying ? "Processing…" : `Renew — $${sub.subscriptionUSDC} USDC`}
          </button>
        )}
        <button onClick={() => setDismissed(true)} style={{ background: "none", border: "none", cursor: "pointer", color, padding: "2px 4px", lineHeight: 1, flexShrink: 0 }}>✕</button>
      </div>

      {/* Confirmation modal */}
      {showConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000, padding: 16 }}>
          <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 12, padding: 28, maxWidth: 400, width: "100%" }}>
            <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Confirm Subscription</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, margin: "0 0 20px", lineHeight: 1.6 }}>
              You are about to subscribe to UrumTrader for <strong style={{ color: "var(--text)" }}>${sub.subscriptionUSDC} USDC / month</strong>.<br /><br />
              This will activate automated trading for <strong style={{ color: "var(--green)" }}>30 days</strong>.
              Payment will be deducted from your vault balance.
            </p>
            {payErr && <div style={{ color: "#EF4444", fontSize: 13, marginBottom: 12 }}>⚠ {payErr}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => { setShowConfirm(false); setPayErr(null); }}
                style={{ flex: 1, padding: "10px", background: "transparent", border: "1px solid #2a2d35", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 14 }}
              >
                Cancel
              </button>
              <button
                onClick={handleRenew}
                disabled={paying}
                style={{ flex: 1, padding: "10px", background: "var(--teal)", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600, opacity: paying ? 0.6 : 1 }}
              >
                {paying ? "Processing…" : `Pay $${sub.subscriptionUSDC} USDC`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Risk Disclaimer Modal ─────────────────────────────────────────────────────

const RISK_KEY = "urum_risk_accepted";

function RiskDisclaimerModal({ onAccept }: { onAccept: () => void }) {
  const [checked, setChecked] = useState(false);

  function handleAccept() {
    localStorage.setItem(RISK_KEY, "1");
    onAccept();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 16 }}>
      <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 14, padding: 28, maxWidth: 480, width: "100%", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <AlertTriangle size={36} style={{ color: "#F59E0B" }} />
          <h2 style={{ margin: "10px 0 4px", color: "var(--text-primary)" }}>Risk Disclosure</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>Please read before proceeding</p>
        </div>

        <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 8, padding: "14px 16px", marginBottom: 16, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.65 }}>
          <strong style={{ color: "var(--text-primary)", display: "block", marginBottom: 8 }}>IMPORTANT RISK WARNING:</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li style={{ marginBottom: 6 }}>Automated cryptocurrency trading involves <strong style={{ color: "#F59E0B" }}>substantial risk of loss</strong>. You could lose all your deposited funds.</li>
            <li style={{ marginBottom: 6 }}>Leveraged trading (2×–5×) amplifies both profits and losses. A small adverse price move can wipe out your entire position.</li>
            <li style={{ marginBottom: 6 }}>Past performance of the bot does NOT guarantee future results. Market conditions can change rapidly.</li>
            <li style={{ marginBottom: 6 }}>UrumTrader is an <strong>automated trading tool</strong>, not financial advice. We are not licensed financial advisors.</li>
            <li>Only deposit funds you can afford to lose entirely. Do not use borrowed money or funds needed for living expenses.</li>
          </ul>
        </div>

        <div style={{ background: "rgba(0,212,170,0.06)", border: "1px solid rgba(0,212,170,0.2)", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 12, color: "var(--text-secondary)" }}>
          <strong style={{ color: "var(--teal)" }}>Fee structure:</strong> Deposit: 5% · Normal withdrawal: 10% · Emergency: 15% · Profit share: 25% · Subscription: $20 USDC/month (14-day trial)
          <br />
          <span style={{ marginTop: 6, display: "inline-block" }}>
            By continuing you agree to our{" "}
            <a href="/terms.html" target="_blank" rel="noreferrer" style={{ color: "var(--teal)" }}>Terms of Service</a>
            {" "}and{" "}
            <a href="/privacy.html" target="_blank" rel="noreferrer" style={{ color: "var(--teal)" }}>Privacy Policy</a>.
          </span>
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: 20 }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
            style={{ marginTop: 2, width: 16, height: 16, cursor: "pointer", accentColor: "var(--teal)" }}
          />
          <span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            I have read and understand the risks. I confirm that I am trading with funds I can afford to lose, and that I understand this is not financial advice.
          </span>
        </label>

        <button
          onClick={handleAccept}
          disabled={!checked}
          style={{
            width: "100%",
            padding: "12px 0",
            borderRadius: 8,
            border: "none",
            cursor: checked ? "pointer" : "not-allowed",
            background: checked ? "var(--teal)" : "#2a2d35",
            color: checked ? "#000" : "#666",
            fontWeight: 700,
            fontSize: 15,
            transition: "all 0.2s",
          }}
        >
          I Understand — Continue to Dashboard
        </button>
      </div>
    </div>
  );
}

// ── Forgot Password Page ──────────────────────────────────────────────────────

function ForgotPasswordPage({ onBack }: { onBack: () => void }) {
  const [step,    setStep]    = useState<"email" | "reset" | "done">("email");
  const [email,   setEmail]   = useState("");
  // Read reset token from URL (e.g. /auth/reset-password?token=...)
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [newPw,   setNewPw]   = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // If we arrived with a reset token in the URL, jump to the reset step
  useEffect(() => {
    if (token) setStep("reset");
  }, []);

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (d.ok) setMessage(d.message);
      else setError(d.error ?? "Request failed");
    } catch { setError("Network error"); }
    finally { setLoading(false); }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (newPw !== confirm) { setError("Passwords do not match"); return; }
    if (newPw.length < 8)  { setError("Password must be at least 8 characters"); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: newPw }),
      });
      const d = await r.json();
      if (d.ok) setStep("done");
      else setError(d.error ?? "Reset failed");
    } catch { setError("Network error"); }
    finally { setLoading(false); }
  }

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-logo">
          <Bot size={36} style={{ color: "var(--teal)" }} />
          <h1>{step === "done" ? "Password Updated!" : "Reset Password"}</h1>
          <p>{step === "email" ? "Enter your email to receive a reset link" : step === "reset" ? "Choose a new password" : "You can now sign in with your new password"}</p>
        </div>

        {step === "done" && (
          <button onClick={onBack} className="action-btn start-btn" style={{ width: "100%", justifyContent: "center" }}>
            Back to Login
          </button>
        )}

        {step === "email" && (
          <form onSubmit={handleForgot} className="login-form">
            <input type="email" className="login-input" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
            {error   && <div className="login-error"><AlertTriangle size={13} /> {error}</div>}
            {message && <div style={{ fontSize: 13, color: "var(--teal)", padding: "8px 12px", background: "rgba(0,212,170,0.08)", borderRadius: 6 }}>{message}</div>}
            <button type="submit" className="action-btn start-btn login-submit" disabled={loading} style={{ justifyContent: "center" }}>
              {loading ? <RefreshCw size={14} className="spin" /> : <Send size={14} />}
              {loading ? "Sending…" : "Send Reset Link"}
            </button>
            <p className="login-footer" style={{ textAlign: "center", marginTop: 12 }}>
              <button type="button" onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", fontSize: 13 }}>← Back to Login</button>
            </p>
          </form>
        )}

        {step === "reset" && (
          <form onSubmit={handleReset} className="login-form">
            <input type="password" className="login-input" placeholder="New password (min 8 chars)" value={newPw} onChange={e => setNewPw(e.target.value)} required autoFocus />
            <input type="password" className="login-input" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
            {error && <div className="login-error"><AlertTriangle size={13} /> {error}</div>}
            <button type="submit" className="action-btn start-btn login-submit" disabled={loading} style={{ justifyContent: "center" }}>
              {loading ? <RefreshCw size={14} className="spin" /> : <CheckCircle size={14} />}
              {loading ? "Updating…" : "Set New Password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Pending Approval Page ─────────────────────────────────────────────────────

function PendingApprovalPage({ onBack }: { onBack?: () => void }) {
  return (
    <div className="login-overlay">
      <div className="login-card" style={{ textAlign: "center" }}>
        <div className="login-logo">
          <Bot size={36} style={{ color: "var(--teal)" }} />
          <h1>Application Under Review</h1>
        </div>
        <p style={{ color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 20 }}>
          Your email has been verified. Our team is reviewing your application.<br />
          You'll receive an email once your account is approved.
        </p>
        <div style={{ padding: "12px 16px", background: "rgba(0,212,170,0.08)", borderRadius: 8, border: "1px solid rgba(0,212,170,0.2)", marginBottom: 20 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--teal)" }}>
            Typical review time: 1–24 hours
          </p>
        </div>
        {onBack && (
          <button onClick={onBack} className="action-btn stop-btn" style={{ width: "100%" }}>
            Back to Login
          </button>
        )}
      </div>
    </div>
  );
}

// ── Register Page ─────────────────────────────────────────────────────────────

function RegisterPage({ onBack, onSuccess }: { onBack: () => void; onSuccess: () => void }) {
  const [email,        setEmail]        = useState("");
  const [password,     setPassword]     = useState("");
  const [confirm,      setConfirm]      = useState("");
  const [wallet,       setWallet]       = useState("");   // from MetaMask extension
  const [manualWallet, setManualWallet] = useState("");   // typed manually (mobile)
  const [showManual,   setShowManual]   = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [done,         setDone]         = useState(false);

  const effectiveWallet = wallet || manualWallet.trim();

  async function connectWallet() {
    const eth = (window as any).ethereum;
    if (!eth) {
      // No extension — show manual input for mobile users
      setShowManual(true);
      return;
    }
    try {
      const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
      if (accounts[0]) setWallet(accounts[0]);
    } catch (e: any) {
      setError(e?.message ?? "Wallet connection failed");
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("Passwords do not match"); return; }
    if (password.length < 8)  { setError("Password must be at least 8 characters"); return; }
    if (manualWallet && !/^0x[0-9a-fA-F]{40}$/.test(manualWallet.trim()))
      { setError("Invalid wallet address — must be 0x followed by 40 hex characters"); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, walletAddress: effectiveWallet }),
      });
      const data = await r.json();
      if (data.ok) { setDone(true); }
      else { setError(data.error ?? "Registration failed"); }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="login-overlay">
        <div className="login-card" style={{ textAlign: "center" }}>
          <div className="login-logo">
            <CheckCircle size={36} style={{ color: "var(--teal)" }} />
            <h1>Check Your Email</h1>
          </div>
          <p style={{ color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 20 }}>
            We sent a verification link to <strong>{email}</strong>.<br />
            Click it to confirm your email and submit your application.
          </p>
          <button onClick={onSuccess} className="action-btn start-btn" style={{ width: "100%" }}>
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-logo">
          <Bot size={36} style={{ color: "var(--teal)" }} />
          <h1>Create Account</h1>
          <p>Join UrumTrader — automated crypto trading</p>
        </div>
        <form onSubmit={handleRegister} className="login-form">
          <input
            type="email"
            className="login-input"
            placeholder="Email address"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
          />
          <input
            type="password"
            className="login-input"
            placeholder="Password (min 8 chars)"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          <input
            type="password"
            className="login-input"
            placeholder="Confirm password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
          />

          {/* Wallet — MetaMask extension or manual entry */}
          {wallet ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "rgba(0,212,170,0.08)", borderRadius: 8, border: "1px solid rgba(0,212,170,0.3)", marginBottom: 4 }}>
              <Wallet size={14} style={{ color: "var(--teal)", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--teal)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis" }}>
                {wallet.slice(0, 8)}…{wallet.slice(-6)}
              </span>
              <CheckCircle size={13} style={{ color: "var(--teal)", marginLeft: "auto" }} />
            </div>
          ) : showManual ? (
            <div>
              <input
                type="text"
                className="login-input"
                placeholder="Wallet address (0x…) — optional"
                value={manualWallet}
                onChange={e => setManualWallet(e.target.value)}
                style={{ fontFamily: "monospace", fontSize: 12 }}
              />
              <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "4px 0 0", lineHeight: 1.4 }}>
                You can also skip this and connect your wallet after logging in.
              </p>
            </div>
          ) : (
            <div>
              <button type="button" onClick={connectWallet} className="action-btn stop-btn" style={{ width: "100%", justifyContent: "center" }}>
                <Wallet size={14} /> Connect MetaMask Wallet
              </button>
              <p style={{ fontSize: 11, color: "var(--text-secondary)", margin: "6px 0 0", textAlign: "center", lineHeight: 1.4 }}>
                On mobile?{" "}
                <button type="button" onClick={() => setShowManual(true)}
                  style={{ background: "none", border: "none", color: "var(--teal)", cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline" }}>
                  Enter address manually
                </button>
                {" "}or skip — you can connect later.
              </p>
            </div>
          )}

          {error && <div className="login-error"><AlertTriangle size={13} /> {error}</div>}

          <button type="submit" className="action-btn start-btn login-submit" disabled={loading}>
            {loading ? <RefreshCw size={14} className="spin" /> : <CheckCircle size={14} />}
            {loading ? "Creating account…" : "Create Account"}
          </button>
        </form>
        <p className="login-footer">
          Already have an account?{" "}
          <button
            onClick={onBack}
            style={{ background: "none", border: "none", color: "var(--teal)", cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline" }}
          >
            Sign In
          </button>
        </p>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  // ── Auth ──
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [userWallet, setUserWallet] = useState<string>("");
  const [authView, setAuthView] = useState<"login" | "register" | "forgot">(() => {
    // If URL has a reset token, go straight to forgot/reset flow
    return new URLSearchParams(window.location.search).get("token") ? "forgot" : "login";
  });
  // ── Risk disclaimer — shown once per browser after first login ──
  const [riskAccepted, setRiskAccepted] = useState<boolean>(() => !!localStorage.getItem(RISK_KEY));

  function handleLogin(t: string) {
    setToken(t);
    // Admin redirect to /admin dashboard
    const { role } = decodeJwtPayload(t);
    if (role === "admin") {
      window.location.href = "/admin";
    }
  }
  function handleLogout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setAuthView("login");
  }

  // Auto-logout when token expires / 401 returned
  useEffect(() => {
    const handler = () => handleLogout();
    window.addEventListener("at:logout", handler);
    return () => window.removeEventListener("at:logout", handler);
  }, []);

  const [botState, setBotState] = useState<BotState | null>(null);
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [balance, setBalance] = useState<VaultBalance | null>(null);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [openCount, setOpenCount] = useState(0);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [priceLoading, setPriceLoading] = useState(false);
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"positions" | "events" | "config" | "performance" | "backtest" | "ai" | "wallet" | "help">("positions");
  const [uptimeStr, setUptimeStr] = useState("—");
  const [riskData, setRiskData] = useState<RiskData | null>(null);
  const [aiStats, setAiStats] = useState<AiModelStats | null>(null);
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  // ── Performance (lifted to app level for polling + badge) ──
  const [perfData, setPerfData]         = useState<PerfData | null>(null);
  const [perfLoading, setPerfLoading]   = useState(false);
  const [perfErr, setPerfErr]           = useState<string | null>(null);
  // ── Support / Help ──
  const [supportStatus, setSupportStatus] = useState<any>(null);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [supportForm, setSupportForm] = useState({ name: "", email: "", category: "general", message: "" });
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const [supportTicketId, setSupportTicketId] = useState<string | null>(null);
  // ── Launch controls: leverage + sizing ──
  const [launchLeverage, setLaunchLeverage] = useState(10);  // 10x default
  const [sizeMode, setSizeMode]             = useState<"auto" | "manual">("auto");
  const [manualSizePct, setManualSizePct]   = useState(10);  // 10% of vault
  const eventsEndRef = useRef<HTMLDivElement>(null);

  // ── Fetch logged-in user's wallet address from profile ──
  useEffect(() => {
    if (!token) return;
    apiFetch("/auth/me").then((r: any) => {
      if (r.ok !== false && r.user?.walletAddress) setUserWallet(r.user.walletAddress);
    }).catch(() => {});
  }, [token]);

  // ── Uptime ticker ──
  useEffect(() => {
    const t = setInterval(() => {
      if (botState?.startedAt) setUptimeStr(fmtUptime(botState.startedAt));
    }, 1000);
    return () => clearInterval(t);
  }, [botState?.startedAt]);

  // ── Poll bot state + config ──
  const fetchState = useCallback(async () => {
    try {
      const r: any = await apiFetch("/bot/state");
      if (r.ok !== false) {
        setBotState(r.state);
        setConfig(r.config);
      }
    } catch { /* offline */ }
  }, []);

  // ── Poll vault balance ──
  const fetchBalance = useCallback(async () => {
    if (!userWallet) return;
    try {
      const r: any = await apiFetch(`/vault/balances?user=${userWallet}`);
      if (r.ok) setBalance(r.balances);
    } catch { }
  }, [userWallet]);

  // ── Poll positions ──
  const fetchPositions = useCallback(async () => {
    if (!userWallet) return;
    try {
      const r: any = await apiFetch(`/vault/position?user=${userWallet}`);
      if (r.ok) {
        setPositions(r.positions ?? {});
        setOpenCount(r.openCount ?? 0);
      }
    } catch { }
  }, [userWallet]);

  // ── Fetch prices for open positions ──
  const fetchPrices = useCallback(async (pos: Record<string, Position>) => {
    const symbols = Object.keys(pos).map(id => marketIdToSymbol(id)).filter(s => !s.includes("…"));
    if (!symbols.length) return;
    setPriceLoading(true);
    try {
      const r: any = await apiFetch(`/market/prices?symbols=${symbols.join(",")}`);
      if (r.ok) {
        const p: Record<string, number> = {};
        for (const [sym, val] of Object.entries(r.prices as Record<string, string>)) {
          p[sym] = parseFloat(val);
        }
        setPrices(p);
      }
    } catch { }
    setPriceLoading(false);
  }, []);

  // ── Wallet + vault balance for deposit/withdraw panel ──
  const fetchWalletBalance = useCallback(async () => {
    if (!userWallet) return;
    try {
      const r: any = await apiFetch(`/vault/wallet-balance?user=${userWallet}`);
      if (r.ok) setWalletData(r as WalletData);
    } catch { }
  }, [userWallet]);

  // ── Phase 3: Risk data (circuit breaker) ──
  const fetchRisk = useCallback(async () => {
    try {
      const r: any = await apiFetch("/bot/risk");
      if (r.ok) setRiskData(r as RiskData);
    } catch { }
  }, []);

  // ── Phase 3: AI model stats ──
  const fetchAiStats = useCallback(async () => {
    try {
      const r: any = await apiFetch("/ai/model");
      if (r.ok) setAiStats(r as AiModelStats);
    } catch { }
  }, []);

  // ── Performance history (polled so badge + positions tab stay current) ──
  const fetchPerformance = useCallback(async () => {
    setPerfLoading(true);
    setPerfErr(null);
    try {
      const r: any = await apiFetch("/bot/performance?limit=200");
      if (r.ok) setPerfData(r as PerfData);
      else setPerfErr(r.error ?? "Failed to load");
    } catch (e: any) {
      setPerfErr(e.message ?? "Network error");
    } finally {
      setPerfLoading(false);
    }
  }, []);

  // ── Support: system status ──
  const fetchSupportStatus = useCallback(async () => {
    try {
      const r: any = await apiFetch("/support/status");
      if (r.ok) setSupportStatus(r);
    } catch { }
  }, []);

  // ── Support: submit ticket ──
  async function submitSupportTicket() {
    setSupportSubmitting(true);
    setSupportTicketId(null);
    try {
      const r: any = await apiFetch("/support/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(supportForm),
      });
      if (r.ok) {
        setSupportTicketId(r.ticketId);
        setSupportForm({ name: "", email: "", category: "general", message: "" });
      } else {
        alert(r.error ?? "Failed to submit ticket");
      }
    } catch {
      alert("Network error — please try again");
    } finally {
      setSupportSubmitting(false);
    }
  }

  // ── Initial load — only when wallet is connected ──
  useEffect(() => {
    if (!userWallet) return; // no wallet → dead dashboard, load nothing
    fetchState();
    fetchBalance();
    fetchPositions();
    fetchRisk();
    fetchAiStats();
    fetchPerformance();
    apiFetch<any>("/bot/history?limit=100").then(r => {
      if (r.ok) setEvents(r.events ?? []);
    }).catch(() => { });
  }, [userWallet, fetchState, fetchBalance, fetchPositions, fetchRisk, fetchAiStats, fetchPerformance]);

  // ── Polling intervals — only when wallet is connected ──
  useEffect(() => {
    if (!userWallet) return;
    const t1 = setInterval(fetchState, 10_000);
    const t2 = setInterval(fetchBalance, 30_000);
    const t3 = setInterval(fetchPositions, 5_000);
    const t4 = setInterval(fetchRisk, 30_000);
    const t5 = setInterval(fetchAiStats, 60_000);
    const t6 = setInterval(fetchPerformance, 60_000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); clearInterval(t5); clearInterval(t6); };
  }, [userWallet, fetchState, fetchBalance, fetchPositions, fetchRisk, fetchAiStats, fetchPerformance]);

  // ── Fetch prices when positions change ──
  useEffect(() => {
    fetchPrices(positions);
    const t = setInterval(() => fetchPrices(positions), 15_000);
    return () => clearInterval(t);
  }, [positions, fetchPrices]);

  // ── SSE event stream ──
  useEffect(() => {
    const es = new EventSource("/api/bot/events");
    es.onmessage = (e) => {
      try {
        const ev: BotEvent = JSON.parse(e.data);
        setEvents(prev => {
          const next = [...prev, ev];
          if (next.length <= 100) return next;
          // Always preserve critical events so they are never scrolled off by VOTES noise.
          const critical = new Set(["TRADE_EXECUTED","BEST_ENTRY","CANDIDATE_FOUND","POSITION_CLOSED","CIRCUIT_BREAKER_TRIGGERED","POSITION_RECOVERED","GHOST_TRADE_CLEARED","EXIT_SIGNAL","MAX_HOLD_EXIT","TRAIL_STATUS"]);
          const routine = next.filter(x => !critical.has(x.type));
          const important = next.filter(x => critical.has(x.type));
          // Keep last 10 critical events + last 90 routine events = 100 total
          const kept = [...important.slice(-10), ...routine.slice(-90)];
          kept.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
          return kept;
        });
      } catch { }
    };
    return () => es.close();
  }, []);

  // ── Auto-scroll events ──
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  // ── Bot controls ──
  async function handleStart() {
    setActionLoading(true);
    try {
      // Push leverage + sizing + strategy params into bot config before starting
      await apiFetch("/me/bot/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DEFAULT_LEVERAGE: launchLeverage,
          MAX_LEVERAGE: launchLeverage,
          MANUAL_SIZE_PCT: sizeMode === "manual" ? manualSizePct / 100 : 0,
          VOTE_REQUIRED: 5,
          MIN_PROFIT_BEFORE_REVERSAL: 0.03,
          EXIT_ON_PROFIT_REVERSAL: 0.03,
          PROFIT_LOCK_GATE: 0.30,
        }),
      });
      const startRes: any = await apiFetch("/me/bot/start", { method: "POST" });
      if (startRes?.ok === false) throw new Error(startRes.error ?? "Failed to start bot");
      await fetchState();
    } catch (e: any) {
      alert(e?.message ?? "Failed to start bot");
    } finally { setActionLoading(false); }
  }

  async function handleStop() {
    setActionLoading(true);
    try {
      const stopRes: any = await apiFetch("/me/bot/stop", { method: "POST" });
      if (stopRes?.ok === false) throw new Error(stopRes.error ?? "Failed to stop bot");
      await fetchState();
    } catch (e: any) {
      alert(e?.message ?? "Failed to stop bot");
    } finally { setActionLoading(false); }
  }

  async function handleSaveConfig(update: Partial<BotConfig>) {
    await apiFetch("/me/bot/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    await fetchState();
  }

  const isRunning = botState?.running ?? false;
  const positionList = Object.entries(positions);
  // Only count REAL on-chain executions (exclude paper/scan-phase POSITION_OPENED)
  const tradeEvents = events.filter(e =>
    (e.type === "TRADE_EXECUTED" && !e.result?.paper) ||
    (e.type === "POSITION_OPENED" && !e.result?.paper) ||
    e.type === "POSITION_CLOSED"
  );

  // Gate: show login/register/forgot page if not authenticated
  if (!token) {
    if (authView === "register") {
      return <RegisterPage onBack={() => setAuthView("login")} onSuccess={() => setAuthView("login")} />;
    }
    if (authView === "forgot") {
      return <ForgotPasswordPage onBack={() => setAuthView("login")} />;
    }
    return <LoginPage onLogin={handleLogin} onRegister={() => setAuthView("register")} onForgot={() => setAuthView("forgot")} />;
  }

  // Risk disclaimer modal — shown once after first login
  if (!riskAccepted) {
    return <RiskDisclaimerModal onAccept={() => setRiskAccepted(true)} />;
  }

  // ── No wallet — show setup screen instead of empty/shared dashboard ──
  if (!userWallet) {
    const hasWeb3  = !!(window as any).ethereum;
    const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
    const siteUrl  = encodeURIComponent(window.location.origin);

    // Deep-link URLs open the site inside the wallet's built-in browser
    const WALLETS = [
      {
        name: "MetaMask",
        icon: "🦊",
        color: "#E2761B",
        deepLink: `https://metamask.app.link/dapp/${window.location.host}`,
        installUrl: "https://metamask.io/download/",
      },
      {
        name: "Trust Wallet",
        icon: "🛡️",
        color: "#3375BB",
        deepLink: `https://link.trustwallet.com/open_url?coin_id=60&url=${siteUrl}`,
        installUrl: "https://trustwallet.com/download",
      },
      {
        name: "Coinbase Wallet",
        icon: "🔵",
        color: "#0052FF",
        deepLink: `https://go.cb-w.com/dapp?cb_url=${siteUrl}`,
        installUrl: "https://www.coinbase.com/wallet/downloads",
      },
    ];

    return (
      <div className="login-overlay">
        <div className="login-card" style={{ textAlign: "center", maxWidth: 420 }}>
          <div className="login-logo">
            <Wallet size={36} style={{ color: "var(--teal)" }} />
            <h1>Connect Web3 Wallet</h1>
            <p>Link your wallet to activate your vault and start trading on Arbitrum.</p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
            {hasWeb3 ? (
              /* ── Wallet injected (desktop extension OR inside wallet browser) ── */
              <button
                className="action-btn start-btn"
                style={{ width: "100%", justifyContent: "center", fontSize: 15, padding: "12px 0" }}
                onClick={async () => {
                  try {
                    const accounts: string[] = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
                    if (!accounts[0]) return;
                    const userId = decodeJwtPayload(token ?? "").userId;
                    if (!userId) throw new Error("Missing session user");
                    const message = buildWalletLinkMessage(accounts[0], userId);
                    const signature: string = await (window as any).ethereum.request({
                      method: "personal_sign",
                      params: [message, accounts[0]],
                    });
                    const r: any = await apiFetch("/auth/wallet", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ walletAddress: accounts[0], message, signature }),
                    });
                    if (r.ok !== false) setUserWallet(accounts[0]);
                    else alert(r.error ?? "Failed to link wallet");
                  } catch (e: any) { alert(e?.message ?? "Connection cancelled"); }
                }}
              >
                <Wallet size={16} /> Connect Wallet
              </button>
            ) : isMobile ? (
              /* ── Mobile: no injection — show deep-link "Open in Wallet" buttons ── */
              <>
                <div style={{ background: "rgba(0,212,170,0.07)", border: "1px solid rgba(0,212,170,0.2)", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "var(--teal)", marginBottom: 4 }}>
                  Tap your wallet below to open this site inside it, then come back here to connect.
                </div>
                {WALLETS.map(w => (
                  <a
                    key={w.name}
                    href={w.deepLink}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", background: "rgba(255,255,255,0.04)", border: `1px solid ${w.color}55`, borderRadius: 10, textDecoration: "none", color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}
                  >
                    <span style={{ fontSize: 24 }}>{w.icon}</span>
                    <span style={{ flex: 1, textAlign: "left" }}>Open in {w.name}</span>
                    <span style={{ fontSize: 18, color: w.color }}>→</span>
                  </a>
                ))}
                <p style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
                  Don't have a wallet yet?{" "}
                  {WALLETS.map((w, i) => (
                    <span key={w.name}>
                      <a href={w.installUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--teal)" }}>{w.name}</a>
                      {i < WALLETS.length - 1 ? " · " : ""}
                    </span>
                  ))}
                </p>
              </>
            ) : (
              /* ── Desktop: no extension installed ── */
              <>
                <p style={{ color: "#ffaa00", fontSize: 13, margin: "0 0 4px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <AlertTriangle size={14} /> No wallet extension detected.
                </p>
                {WALLETS.map(w => (
                  <a
                    key={w.name}
                    href={w.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "rgba(255,255,255,0.04)", border: `1px solid ${w.color}44`, borderRadius: 10, textDecoration: "none", color: "var(--text-primary)", fontSize: 14, fontWeight: 500 }}
                  >
                    <span style={{ fontSize: 22 }}>{w.icon}</span>
                    <span>{w.name}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: w.color }}>Install →</span>
                  </a>
                ))}
                <p style={{ color: "var(--text-secondary)", fontSize: 12, margin: "4px 0 0" }}>
                  After installing, refresh this page to connect.
                </p>
              </>
            )}
            <button onClick={handleLogout} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, marginTop: 4 }}>
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">

      {/* ── Subscription banner (shown when trial/sub is expiring or expired) ── */}
      <SubscriptionBanner token={token} />

      {/* ── Navbar ── */}
      <nav className="navbar">
        <div className="nav-brand">
          <Zap size={20} className="brand-icon" />
          <span className="brand-name">UrumAutoTrader</span>
          <span className="brand-net">Arbitrum One</span>
        </div>
        <div className="nav-center">
          <StatusPill running={isRunning} />
          {isRunning && (
            <span className="nav-uptime">
              <Activity size={13} /> {uptimeStr}
            </span>
          )}
        </div>
        <div className="nav-right">
          <span className="nav-address" title={userWallet}>
            {userWallet ? `${userWallet.slice(0, 6)}…${userWallet.slice(-4)}` : "No wallet"}
          </span>
          {isRunning ? (
            <button className="btn btn-danger" onClick={handleStop} disabled={actionLoading}>
              <PowerOff size={15} />
              {actionLoading ? "…" : "Stop Bot"}
            </button>
          ) : (
            <button className="btn btn-success" onClick={handleStart} disabled={actionLoading}>
              <Power size={15} />
              {actionLoading ? "…" : "Start Bot"}
            </button>
          )}
          <button
            className="btn btn-logout"
            onClick={handleLogout}
            title="Sign out"
            style={{ marginLeft: 4 }}
          >
            <X size={14} /> Logout
          </button>
        </div>
      </nav>

      {/* ── Stats Row ── */}
      <div className="stats-row">
        <div className="stat-card">
          <Wallet size={18} className="stat-card-icon green" />
          <div>
            <div className="stat-card-label">Vault Balance</div>
            <div className="stat-card-val">
              {balance ? `${balance.stable} USDC` : <Spinner />}
            </div>
          </div>
        </div>

        <div className="stat-card">
          <BarChart2 size={18} className="stat-card-icon blue" />
          <div>
            <div className="stat-card-label">Open Positions</div>
            <div className="stat-card-val">{openCount} / 3</div>
          </div>
        </div>

        <div className="stat-card">
          <Bot size={18} className="stat-card-icon purple" />
          <div>
            <div className="stat-card-label">Regime / Entry</div>
            <div className="stat-card-val">1h → 5m</div>
          </div>
        </div>

        <div className="stat-card">
          <Activity size={18} className="stat-card-icon orange" />
          <div>
            <div className="stat-card-label">Trades Today</div>
            <div className="stat-card-val">{tradeEvents.length}</div>
          </div>
        </div>

        <div className="stat-card">
          <Settings size={18} className="stat-card-icon muted" />
          <div>
            <div className="stat-card-label">SL / Votes</div>
            <div className="stat-card-val" style={{ fontSize: 13 }}>
              {launchLeverage >= 40
                ? `${Math.min(0.8, Math.max(0.5, 30 / launchLeverage)).toFixed(2)}%⚡`
                : "1%"
              } / 5
            </div>
          </div>
        </div>

        {/* Leverage stat card — always visible */}
        <div className="stat-card" style={{
          borderColor: launchLeverage <= 10 ? "var(--green)" : launchLeverage <= 30 ? "var(--orange)" : "var(--red)",
        }}>
          <Zap size={18} className={`stat-card-icon ${launchLeverage <= 10 ? "green" : launchLeverage <= 30 ? "orange" : "red"}`} />
          <div>
            <div className="stat-card-label">Leverage</div>
            <div className="stat-card-val" style={{
              color: launchLeverage <= 10 ? "var(--green)" : launchLeverage <= 30 ? "var(--orange)" : "var(--red)",
              fontWeight: 700,
            }}>
              {launchLeverage}×
              <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 5, fontWeight: 400 }}>
                {sizeMode === "manual" ? `${manualSizePct}% manual` : "auto"}
              </span>
            </div>
          </div>
        </div>

        {/* Phase 3: Circuit Breaker card */}
        <div className="stat-card" style={riskData?.circuitBreaker.triggered ? { borderColor: "var(--red)", background: "var(--red-bg)" } : {}}>
          <AlertTriangle size={18} className={`stat-card-icon ${riskData?.circuitBreaker.triggered ? "red" : riskData && riskData.dailyReturn < riskData.circuitBreaker.limit * 0.5 ? "orange" : "green"}`} />
          <div>
            <div className="stat-card-label">Daily PnL</div>
            <div className={`stat-card-val ${riskData?.circuitBreaker.triggered ? "red" : riskData && riskData.dailyReturn < -0.02 ? "red" : "green"}`}>
              {riskData
                ? `${riskData.dailyReturn >= 0 ? "+" : ""}${riskData.dailyReturnPct.toFixed(1)}%`
                : "—"}
              {riskData?.circuitBreaker.triggered && <span style={{ fontSize: 11, marginLeft: 6, background: "var(--red)", color: "#fff", borderRadius: 4, padding: "1px 5px" }}>LIMIT HIT</span>}
            </div>
          </div>
        </div>

        {/* Phase 3: AI model card */}
        <div className="stat-card">
          <Bot size={18} className={`stat-card-icon ${aiStats && aiStats.totalTrades >= 5 ? "green" : "muted"}`} />
          <div>
            <div className="stat-card-label">AI Model</div>
            <div className="stat-card-val" style={{ fontSize: 13 }}>
              {aiStats
                ? aiStats.totalTrades === 0
                  ? <span style={{ color: "var(--muted)" }}>Learning…</span>
                  : <span style={{ color: "var(--accent)" }}>{aiStats.totalTrades} trades · {aiStats.featureCount} setups</span>
                : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* ── ⚠ Open positions but engine stopped — safety warning ── */}
      {!isRunning && openCount > 0 && (
        <div className="error-banner" style={{ background: "rgba(210,153,34,0.12)", borderColor: "var(--orange)", color: "var(--orange)" }}>
          <AlertTriangle size={15} />
          <span>
            <strong>⚠ BOT STOPPED</strong> — {openCount} position{openCount > 1 ? "s" : ""} open with no active stop-loss monitoring.
            Press <strong>Start Bot</strong> to resume protection.
          </span>
          <button
            className="btn btn-success"
            style={{ marginLeft: "auto", fontSize: 11, padding: "3px 10px" }}
            onClick={handleStart}
            disabled={actionLoading}
          >
            {actionLoading ? "…" : "▶ Start Now"}
          </button>
        </div>
      )}

      {/* ── Error banner ── */}
      {botState?.lastError && (
        <div className="error-banner">
          <AlertTriangle size={15} />
          <span>{fmtDate(botState.lastError.ts)}: {botState.lastError.message}</span>
        </div>
      )}

      {/* ── Phase 3: Circuit Breaker banner ── */}
      {riskData?.circuitBreaker.triggered && (
        <div className="error-banner" style={{ background: "var(--red-bg)", borderColor: "var(--red)" }}>
          <AlertTriangle size={15} />
          <span>
            <strong>⚡ CIRCUIT BREAKER:</strong> Daily loss limit reached
            ({riskData.dailyReturnPct.toFixed(1)}% / {riskData.circuitBreaker.limitPct}% max).
            Bot stopped. Resets at UTC midnight.
          </span>
          <button
            className="btn btn-danger"
            style={{ marginLeft: "auto", fontSize: 11, padding: "3px 10px" }}
            onClick={() => apiFetch("/bot/risk/reset", { method: "POST" }).then(fetchRisk)}
          >
            Reset
          </button>
        </div>
      )}

      {/* ── Symbols row ── */}
      {config?.symbols && (
        <div className="symbols-row">
          <span className="sym-label">Watching:</span>
          {config.symbols.map(s => (
            <span key={s} className="sym-chip">{s}</span>
          ))}
          <button className="sym-refresh" onClick={fetchState} title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
      )}

      {/* ── Launch Controls — always visible ── */}
      <LaunchControls
        symbols={config?.symbols ?? []}
        leverage={launchLeverage}
        setLeverage={setLaunchLeverage}
        sizeMode={sizeMode}
        setSizeMode={setSizeMode}
        manualSizePct={manualSizePct}
        setManualSizePct={setManualSizePct}
        isRunning={isRunning}
      />

      {/* ── Tab nav ── */}
      <div className="tab-nav">
        <button
          className={`tab-btn ${activeTab === "positions" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("positions")}
        >
          <BarChart2 size={14} /> Positions {openCount > 0 && <span className="tab-badge">{openCount}</span>}
        </button>
        <button
          className={`tab-btn ${activeTab === "events" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("events")}
        >
          <Activity size={14} /> Live Events {events.length > 0 && <span className="tab-badge">{events.length}</span>}
        </button>
        <button
          className={`tab-btn ${activeTab === "config" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("config")}
        >
          <Settings size={14} /> Config
        </button>
        <button
          className={`tab-btn ${activeTab === "performance" ? "tab-active" : ""}`}
          onClick={() => { setActiveTab("performance"); fetchPerformance(); }}
        >
          <TrendingUp size={14} /> Performance
          {perfData && perfData.count > 0 && <span className="tab-badge">{perfData.count}</span>}
        </button>
        <button
          className={`tab-btn ${activeTab === "backtest" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("backtest")}
        >
          <TrendingDown size={14} /> Backtest
        </button>
        <button
          className={`tab-btn ${activeTab === "ai" ? "tab-active" : ""}`}
          onClick={() => { setActiveTab("ai"); fetchAiStats(); }}
        >
          <Zap size={14} /> AI Model
          {aiStats && aiStats.totalTrades > 0 && <span className="tab-badge">{aiStats.totalTrades}</span>}
        </button>
        <button
          className={`tab-btn ${activeTab === "wallet" ? "tab-active" : ""}`}
          onClick={() => { setActiveTab("wallet"); fetchWalletBalance(); }}
        >
          <Wallet size={14} /> Wallet
        </button>
        <button
          className={`tab-btn ${activeTab === "help" ? "tab-active" : ""}`}
          onClick={() => { setActiveTab("help"); fetchSupportStatus(); }}
        >
          <HelpCircle size={14} /> Help
        </button>
      </div>

      {/* ── Tab content ── */}
      <div className="tab-content">
        {activeTab === "positions" && (
          <div className="positions-panel">
            {positionList.length === 0 ? (
              <div className="empty-state">
                <X size={32} className="empty-icon" />
                <p>No open positions</p>
                <span>Bot is scanning for entry signals…</span>
              </div>
            ) : (
              positionList.map(([marketId, pos]) => {
                const symbol = marketIdToSymbol(marketId);
                const price = prices[symbol];
                return (
                  <PositionRow
                    key={marketId}
                    marketId={marketId}
                    pos={pos}
                    currentPrice={price}
                    priceLoading={priceLoading}
                    onClose={fetchPositions}
                  />
                );
              })
            )}

            {/* ── Recent Closed Trades ── */}
            {perfData && perfData.count > 0 && (() => {
              const recent = [...perfData.trades]
                .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
                .slice(0, 8);
              const wins = recent.filter(t => t.pnlPct >= 0).length;
              const totalLevPnl = recent.reduce((s, t) => s + t.pnlPct * (t.leverage ?? 5), 0);
              return (
                <div className="recent-trades-section">
                  <div className="recent-trades-header">
                    <span><TrendingUp size={13} /> Recent Closed Trades</span>
                    <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{wins}/{recent.length} wins</span>
                      <span className={totalLevPnl >= 0 ? "pnl-pos" : "pnl-neg"} style={{ fontSize: 11 }}>
                        {totalLevPnl >= 0 ? "+" : ""}{(totalLevPnl * 100).toFixed(1)}% total (lev)
                      </span>
                      <button className="sym-refresh" onClick={fetchPerformance}><RefreshCw size={11} /></button>
                    </span>
                  </div>
                  <div className="recent-trades-list">
                    {recent.map((t, i) => {
                      const levPnl = t.pnlPct * (t.leverage ?? 5);
                      const pos = levPnl >= 0;
                      return (
                        <div className="recent-trade-row" key={i}>
                          <span style={{ color: "var(--muted)", fontSize: 11, minWidth: 52 }}>
                            {t.closedAt ? fmtRelTime(t.closedAt) : "—"}
                          </span>
                          <span style={{ fontWeight: 600, minWidth: 90 }}>{t.symbol.replace("USDT","")}</span>
                          <span className={t.isLong ? "side-chip-long" : "side-chip-short"} style={{ fontSize: 10, padding: "1px 5px" }}>
                            {t.isLong ? "L" : "S"}
                          </span>
                          <span style={{ color: "var(--muted)", fontSize: 11, flex: 1 }}>
                            {t.entryPrice.toFixed(3)} → {t.exitPrice.toFixed(3)}
                          </span>
                          <span className={pos ? "pnl-pos" : "pnl-neg"} style={{ fontWeight: 600, fontSize: 12 }}>
                            {pos ? "+" : ""}{(levPnl * 100).toFixed(2)}%
                          </span>
                          <span style={{ color: "var(--muted)", fontSize: 10, minWidth: 40, textAlign: "right" }}>
                            {fmtDuration(t.durationMs)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ textAlign: "right", marginTop: 6 }}>
                    <button className="sym-refresh" onClick={() => setActiveTab("performance")}>
                      <BarChart2 size={11} /> View All {perfData.count} trades →
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {activeTab === "events" && (
          <div className="events-panel">
            <div className="events-toolbar">
              <span className="events-count">{events.length} events</span>
              <button className="sym-refresh" onClick={() =>
                apiFetch<any>("/bot/history?limit=100").then(r => {
                  if (r.ok) setEvents(r.events ?? []);
                })
              }>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            <div className="events-list">
              {events.length === 0 && (
                <div className="empty-state">
                  <Activity size={32} className="empty-icon" />
                  <p>No events yet</p>
                  <span>Events will appear here as the bot scans…</span>
                </div>
              )}
              {events.slice().reverse().map((e, i) => (
                <EventRow key={`${e.ts}-${i}`} e={e} />
              ))}
              <div ref={eventsEndRef} />
            </div>
          </div>
        )}

        {activeTab === "config" && (
          <Card title="Bot Configuration" icon={<Settings size={16} />}>
            <div className="config-section">
              <div className="cfg-readonly-grid">
                <div className="cfg-ro">
                  <span>User Address</span>
                  <code>{config?.userAddress ?? userWallet}</code>
                </div>
                <div className="cfg-ro">
                  <span>Strategy</span>
                  <code>{config?.strategy ?? "trend_range_fork"}</code>
                </div>
                <div className="cfg-ro">
                  <span>Stoch D-Length</span>
                  <code>{config?.trigger?.stochDLen ?? 3}</code>
                </div>
                <div className="cfg-ro">
                  <span>Stoch Mid</span>
                  <code>{config?.trigger?.stochMid ?? 50}</code>
                </div>
              </div>
              <hr className="cfg-divider" />
              <p className="cfg-note">Changes apply on next scan cycle. Stop/restart the bot to pick up symbol changes.</p>
              <ConfigPanel config={config} onSave={handleSaveConfig} />
            </div>
          </Card>
        )}

        {activeTab === "performance" && (
          <Card title="Live Performance" icon={<TrendingUp size={16} />}>
            <PerfTabView
              data={perfData}
              loading={perfLoading}
              err={perfErr}
              onRefresh={fetchPerformance}
            />
          </Card>
        )}

        {activeTab === "backtest" && (
          <Card title="Strategy Backtester" icon={<TrendingDown size={16} />}>
            <BacktestPanel defaultSymbols={config?.symbols ?? ["BTCUSDT","ETHUSDT","TAOUSDT","RENDERUSDT"]} />
          </Card>
        )}

        {activeTab === "ai" && (
          <Card title="AI Signal Scorer" icon={<Zap size={16} />}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Summary */}
              <div className="metrics-grid">
                <MetricCard label="Features Learned" value={String(aiStats?.featureCount ?? 0)} />
                <MetricCard label="Trades Trained" value={String(aiStats?.totalTrades ?? 0)} color={aiStats && aiStats.totalTrades >= 20 ? "green" : undefined} />
                <MetricCard label="Model Status" value={
                  !aiStats || aiStats.totalTrades === 0 ? "Untrained"
                  : aiStats.totalTrades < 10 ? "Warming Up"
                  : aiStats.totalTrades < 20 ? "Learning"
                  : "Active"
                } color={aiStats && aiStats.totalTrades >= 20 ? "green" : undefined} />
                <MetricCard label="Last Updated" value={
                  aiStats?.lastUpdated ? new Date(aiStats.lastUpdated).toLocaleTimeString() : "—"
                } />
              </div>

              {/* How it works explanation */}
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px" }}>
                <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--accent)", fontSize: 13 }}>How the AI Scorer Works</div>
                <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.7 }}>
                  Each trade entry is fingerprinted by <strong style={{ color: "var(--text)" }}>4 market features</strong>:
                  regime (LONG/SHORT/NONE) · RSI zone (OS/MID/OB) · StochRSI zone · ATR level (LOW/MID/HIGH).
                  After every close, the win/loss is recorded for that feature combination.
                  The Bayesian score adds up to <strong style={{ color: "var(--text)" }}>±1.5 points</strong> to the candidate score —
                  boosting historically winning setups and reducing exposure to historically losing ones.
                  Confidence reaches 100% at 20 observations per feature.
                  <strong style={{ color: "var(--green)" }}> No configuration needed — it learns automatically.</strong>
                </div>
              </div>

              {/* Top setups */}
              {aiStats && aiStats.topSetups.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Top Performing Setups</div>
                  {aiStats.topSetups.map((s, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 5, marginBottom: 4, fontSize: 12 }}>
                      <code style={{ color: "var(--accent)", fontSize: 11 }}>{s.key}</code>
                      <span style={{ display: "flex", gap: 12, color: "var(--muted)" }}>
                        <span style={{ color: "var(--green)" }}>{(s.winRate * 100).toFixed(0)}% WR</span>
                        <span>{s.total} trades</span>
                        <span style={{ color: "var(--green)", fontWeight: 600 }}>+{s.bonus.toFixed(2)} score</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Worst setups */}
              {aiStats && aiStats.worstSetups.length > 0 && aiStats.worstSetups.some(s => s.bonus < -0.1) && (
                <div>
                  <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Worst Performing Setups (avoided by AI)</div>
                  {aiStats.worstSetups.filter(s => s.bonus < -0.1).map((s, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "7px 12px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 5, marginBottom: 4, fontSize: 12 }}>
                      <code style={{ color: "var(--muted)", fontSize: 11 }}>{s.key}</code>
                      <span style={{ display: "flex", gap: 12, color: "var(--muted)" }}>
                        <span style={{ color: "var(--red)" }}>{(s.winRate * 100).toFixed(0)}% WR</span>
                        <span>{s.total} trades</span>
                        <span style={{ color: "var(--red)", fontWeight: 600 }}>{s.bonus.toFixed(2)} score</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {(!aiStats || aiStats.totalTrades === 0) && (
                <div className="empty-state">
                  <Zap size={28} className="empty-icon" />
                  <p>Model untrained</p>
                  <span>The AI scorer will begin learning after the first trade closes. It becomes statistically meaningful after ~20 closed trades.</span>
                </div>
              )}

              <div style={{ textAlign: "right" }}>
                <button className="sym-refresh" onClick={fetchAiStats}><RefreshCw size={12} /> Refresh</button>
              </div>
            </div>
          </Card>
        )}

        {activeTab === "wallet" && (
          <Card title="Deposit / Withdraw" icon={<Wallet size={16} />}>
            <DepositWithdrawPanel walletData={walletData} onRefresh={fetchWalletBalance} />
          </Card>
        )}

        {activeTab === "help" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* ── System Status ── */}
            <Card title="System Status" icon={<CheckCircle size={16} />}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                {supportStatus ? (
                  <>
                    <div className={`status-pill ${supportStatus.services?.bot?.running ? "pill-ok" : "pill-warn"}`}>
                      <Circle size={8} /> Bot Engine: {supportStatus.services?.bot?.running ? "Running" : "Stopped"}
                    </div>
                    <div className={`status-pill ${supportStatus.services?.redis?.status === "operational" ? "pill-ok" : "pill-warn"}`}>
                      <Circle size={8} /> Redis: {supportStatus.services?.redis?.status ?? "—"}
                    </div>
                    <div className={`status-pill ${supportStatus.services?.chain?.status === "operational" ? "pill-ok" : "pill-warn"}`}>
                      <Circle size={8} /> Chain: {supportStatus.services?.chain?.status ?? "—"}
                      {supportStatus.services?.chain?.blockNumber ? ` #${supportStatus.services.chain.blockNumber.toLocaleString()}` : ""}
                    </div>
                    <div className="status-pill pill-ok">
                      <Circle size={8} /> Open Positions: {supportStatus.openPositions ?? 0}
                    </div>
                  </>
                ) : (
                  <span style={{ color: "var(--muted)", fontSize: 13 }}>Loading system status…</span>
                )}
              </div>
              <button className="sym-refresh" onClick={fetchSupportStatus}><RefreshCw size={12} /> Refresh Status</button>
            </Card>

            {/* ── Contact Channels ── */}
            <Card title="Contact Support" icon={<MessageCircle size={16} />}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 16 }}>
                <a href="https://t.me/UrumBotSupport" target="_blank" rel="noopener noreferrer" className="contact-channel">
                  <span style={{ fontSize: 22 }}>📨</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Telegram</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>Fastest response · 24/7</div>
                  </div>
                  <ExternalLink size={12} style={{ marginLeft: "auto", color: "var(--muted)" }} />
                </a>
                <a href="mailto:support@urumbot.io" className="contact-channel">
                  <span style={{ fontSize: 22 }}>✉️</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Email</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>support@urumbot.io</div>
                  </div>
                  <ExternalLink size={12} style={{ marginLeft: "auto", color: "var(--muted)" }} />
                </a>
                <a href="https://discord.gg/urumbot" target="_blank" rel="noopener noreferrer" className="contact-channel">
                  <span style={{ fontSize: 22 }}>💬</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Discord</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>Community · Announcements</div>
                  </div>
                  <ExternalLink size={12} style={{ marginLeft: "auto", color: "var(--muted)" }} />
                </a>
              </div>
            </Card>

            {/* ── FAQ ── */}
            <Card title="Frequently Asked Questions" icon={<HelpCircle size={16} />}>
              {[
                {
                  q: "Why isn't the bot opening trades?",
                  a: "Check that the bot engine is running (green status above). The bot requires a minimum vault balance and waits for strong signal alignment (votes ≥ threshold). A cooldown period of 10 minutes applies after each trade to prevent overtrading. Also verify your symbols are configured in Config tab."
                },
                {
                  q: "My stop-loss didn't fire — what happened?",
                  a: "The actual stop-loss threshold comes from the STOP_LOSS_PCT in Config (e.g. 1% = 0.01). If the bot was restarted, check Redis has the correct value via POST /bot/config. The displayed stop price on the dashboard is calculated from the current config value. Contract-level cooldowns may also prevent immediate re-entries."
                },
                {
                  q: "What do the PnL numbers represent?",
                  a: "All PnL figures are unrealized gains/losses in USD based on the current market price vs your entry price, scaled by your position's leverage. A 1% price move at 10× leverage = 10% PnL. Daily PnL is the running total of all closed trade returns for today."
                },
                {
                  q: "How do I add more trading capital?",
                  a: "Use the Wallet tab to deposit USDC directly into the vault. The vault requires an ERC20 approve + deposit transaction. Make sure your wallet has USDC on Arbitrum and ETH for gas. Deposits are credited immediately after on-chain confirmation."
                },
                {
                  q: "Can I run the bot on multiple symbols?",
                  a: "Yes — add multiple symbols (e.g. BTCUSDT,ETHUSDT,SOLUSDT) in the Config tab before starting. Each symbol runs its own independent scan cycle with isolated position tracking. Max leverage varies by symbol."
                },
                {
                  q: "What happens if the bot crashes or restarts?",
                  a: "The bot automatically resumes from Redis state on restart — open positions, trend regimes, and cooldown timers are all preserved. If a position existed on-chain but not in Redis (ghost trade), the bot detects and cleans it up automatically."
                },
              ].map((item, i) => (
                <div key={i} className="faq-item">
                  <button
                    className={`faq-question ${openFaq === i ? "faq-open" : ""}`}
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  >
                    <span>{item.q}</span>
                    {openFaq === i ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {openFaq === i && (
                    <div className="faq-answer">{item.a}</div>
                  )}
                </div>
              ))}
            </Card>

            {/* ── Submit Ticket ── */}
            <Card title="Submit a Support Ticket" icon={<Send size={16} />}>
              {supportTicketId ? (
                <div style={{ textAlign: "center", padding: "24px 0" }}>
                  <CheckCircle size={36} style={{ color: "var(--green)", marginBottom: 10 }} />
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Ticket Submitted!</div>
                  <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
                    Reference: <code style={{ color: "var(--accent)" }}>{supportTicketId}</code>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>We'll respond within 24 hours via your provided email.</div>
                  <button className="sym-refresh" style={{ marginTop: 16 }} onClick={() => setSupportTicketId(null)}>Submit Another</button>
                </div>
              ) : (
                <div className="support-form">
                  <div className="support-form-row">
                    <div className="support-form-field">
                      <label>Your Name</label>
                      <input
                        type="text"
                        placeholder="John Doe"
                        value={supportForm.name}
                        onChange={e => setSupportForm(f => ({ ...f, name: e.target.value }))}
                      />
                    </div>
                    <div className="support-form-field">
                      <label>Email Address</label>
                      <input
                        type="email"
                        placeholder="you@example.com"
                        value={supportForm.email}
                        onChange={e => setSupportForm(f => ({ ...f, email: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="support-form-field">
                    <label>Category</label>
                    <select
                      value={supportForm.category}
                      onChange={e => setSupportForm(f => ({ ...f, category: e.target.value }))}
                    >
                      <option value="general">General Question</option>
                      <option value="trade">Trade Issue</option>
                      <option value="deposit">Deposit / Withdrawal</option>
                      <option value="config">Configuration</option>
                      <option value="bug">Bug Report</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className="support-form-field">
                    <label>Message <span style={{ color: "var(--red)" }}>*</span></label>
                    <textarea
                      rows={4}
                      placeholder="Describe your issue in detail…"
                      value={supportForm.message}
                      onChange={e => setSupportForm(f => ({ ...f, message: e.target.value }))}
                    />
                  </div>
                  <button
                    className="action-btn start-btn"
                    style={{ marginTop: 4 }}
                    disabled={supportSubmitting || supportForm.message.trim().length < 5}
                    onClick={submitSupportTicket}
                  >
                    {supportSubmitting ? "Submitting…" : <><Send size={13} /> Submit Ticket</>}
                  </button>
                </div>
              )}
            </Card>

          </div>
        )}
      </div>

      {/* ── Floating Support Button ── */}
      <button className="support-fab" onClick={() => { setShowSupportModal(true); fetchSupportStatus(); }} title="Get Help">
        <HelpCircle size={22} />
      </button>

      {/* ── Support Modal ── */}
      {showSupportModal && (
        <div className="support-modal-overlay" onClick={() => setShowSupportModal(false)}>
          <div className="support-modal" onClick={e => e.stopPropagation()}>
            <div className="support-modal-header">
              <span><MessageCircle size={16} /> Support &amp; Help</span>
              <button className="modal-close" onClick={() => setShowSupportModal(false)}><X size={16} /></button>
            </div>
            <div className="support-modal-body">
              {/* Mini status */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {supportStatus ? (
                  <>
                    <span className={`status-pill ${supportStatus.services?.bot?.running ? "pill-ok" : "pill-warn"}`}><Circle size={7} /> Bot: {supportStatus.services?.bot?.running ? "Online" : "Offline"}</span>
                    <span className={`status-pill ${supportStatus.services?.redis?.status === "operational" ? "pill-ok" : "pill-warn"}`}><Circle size={7} /> Redis: {supportStatus.services?.redis?.status}</span>
                    <span className={`status-pill ${supportStatus.services?.chain?.status === "operational" ? "pill-ok" : "pill-warn"}`}><Circle size={7} /> Chain: {supportStatus.services?.chain?.status}</span>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>Checking status…</span>
                )}
              </div>

              <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>
                Encountering an issue? Reach out via your preferred channel or open the <strong style={{ color: "var(--text)" }}>Help tab</strong> for full support options.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <a href="https://t.me/UrumBotSupport" target="_blank" rel="noopener noreferrer" className="modal-contact-row">
                  <span>📨</span> <strong>Telegram</strong> <span style={{ color: "var(--muted)", fontSize: 12 }}>— fastest, 24/7</span>
                  <ExternalLink size={11} style={{ marginLeft: "auto" }} />
                </a>
                <a href="mailto:support@urumbot.io" className="modal-contact-row">
                  <span>✉️</span> <strong>Email</strong> <span style={{ color: "var(--muted)", fontSize: 12 }}>— support@urumbot.io</span>
                  <ExternalLink size={11} style={{ marginLeft: "auto" }} />
                </a>
                <a href="https://discord.gg/urumbot" target="_blank" rel="noopener noreferrer" className="modal-contact-row">
                  <span>💬</span> <strong>Discord</strong> <span style={{ color: "var(--muted)", fontSize: 12 }}>— community &amp; announcements</span>
                  <ExternalLink size={11} style={{ marginLeft: "auto" }} />
                </a>
              </div>

              <div style={{ marginTop: 16, textAlign: "center" }}>
                <button className="action-btn start-btn" style={{ width: "100%", justifyContent: "center" }}
                  onClick={() => { setShowSupportModal(false); setActiveTab("help"); fetchSupportStatus(); }}>
                  <HelpCircle size={13} /> Open Full Help &amp; FAQ
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
