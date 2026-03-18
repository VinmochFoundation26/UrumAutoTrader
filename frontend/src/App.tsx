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
  stableToken: string;
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

const USER = import.meta.env.VITE_USER_ADDRESS ?? "0x5520C8A946e948C4f5d55e7e2FdEa7Bd5b25db85";
const TOKEN_KEY = "at_token"; // sessionStorage key for JWT

/** Decode JWT payload without verification (client-side only) */
function decodeJwtPayload(token: string): { role?: string; userId?: string } {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
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
  if (type.includes("CLOSED") || type.includes("EXIT")) return "var(--blue)";
  if (type.includes("FAILED") || type.includes("ERROR")) return "var(--red)";
  if (type === "ATR_BLOCKED") return "var(--orange)";
  if (type === "ENTRY_BLOCKED") return "var(--muted)";
  if (type === "VOTES") return "var(--muted)";
  return "var(--text)";
}

function eventIcon(type: string) {
  if (type === "TRADE_EXECUTED" || type === "POSITION_OPENED") return "🟢";
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
    if (!all) {
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) { setErr("Enter an amount to withdraw"); return; }
      if (amt > maxWithdraw) { setErr(`Insufficient vault balance ($${maxWithdraw.toFixed(2)} available)`); return; }
    }
    setLoading(true); resetFeedback();
    try {
      const body = all
        ? { all: true, emergency: withdrawMode === "emergency" }
        : { amount: parseFloat(amount), emergency: withdrawMode === "emergency" };
      const r: any = await apiFetch("/vault/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(r.error ?? "Withdraw failed");
      setResult({ txHash: r.txHash, net: r.netReceived ?? 0, fee: r.totalPlatformFee != null ? `$${Number(r.totalPlatformFee).toFixed(2)}` : "?" });
      setAmount("");
      onRefresh();
    } catch (e: any) {
      setErr(e?.message ?? "Withdraw failed");
    } finally { setLoading(false); }
  }

  const feeLabel = mode === "deposit"
    ? `${fees?.depositPct ?? "?"}% deposit fee`
    : withdrawMode === "normal"
      ? `${fees?.withdrawPct ?? "?"}% normal withdrawal fee`
      : `${fees?.emergencyPct ?? "?"}% emergency fee (immediate, no approval wait)`;

  const net = previewNet();

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

      {/* Net preview */}
      {net !== null && amount && (
        <div className="dw-net-preview">
          {mode === "deposit" ? "Credited to vault:" : "You receive:"}{" "}
          <strong style={{ color: "var(--green)" }}>${net.toFixed(2)} USDC</strong>
          <span className="dw-net-fee"> · {feeLabel}</span>
        </div>
      )}

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
}: {
  onLogin: (token: string) => void;
  onRegister: () => void;
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
        </p>
        <p className="login-footer" style={{ marginTop: 4 }}>UrumTrader v1.0 · Arbitrum One</p>
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
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [wallet,   setWallet]   = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [done,     setDone]     = useState(false);

  async function connectWallet() {
    const eth = (window as any).ethereum;
    if (!eth) { setError("MetaMask not found. Please install it first."); return; }
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
    if (!wallet)               { setError("Please connect your MetaMask wallet"); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, walletAddress: wallet }),
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

          {/* MetaMask wallet connect */}
          {wallet ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "rgba(0,212,170,0.08)", borderRadius: 8, border: "1px solid rgba(0,212,170,0.3)", marginBottom: 4 }}>
              <Wallet size={14} style={{ color: "var(--teal)", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--teal)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis" }}>
                {wallet.slice(0, 8)}…{wallet.slice(-6)}
              </span>
              <CheckCircle size={13} style={{ color: "var(--teal)", marginLeft: "auto" }} />
            </div>
          ) : (
            <button type="button" onClick={connectWallet} className="action-btn stop-btn" style={{ width: "100%", justifyContent: "center" }}>
              <Wallet size={14} /> Connect MetaMask Wallet
            </button>
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
  const [authView, setAuthView] = useState<"login" | "register">("login");

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
    try {
      const r: any = await apiFetch(`/vault/balances?user=${USER}`);
      if (r.ok) setBalance(r.balances);
    } catch { }
  }, []);

  // ── Poll positions ──
  const fetchPositions = useCallback(async () => {
    try {
      const r: any = await apiFetch(`/vault/position?user=${USER}`);
      if (r.ok) {
        setPositions(r.positions ?? {});
        setOpenCount(r.openCount ?? 0);
      }
    } catch { }
  }, []);

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
    try {
      const r: any = await apiFetch(`/vault/wallet-balance?user=${USER}`);
      if (r.ok) setWalletData(r as WalletData);
    } catch { }
  }, []);

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

  // ── Initial load ──
  useEffect(() => {
    fetchState();
    fetchBalance();
    fetchPositions();
    fetchRisk();
    fetchAiStats();
    fetchPerformance();  // load trade history immediately on app open

    // Load history once
    apiFetch<any>("/bot/history?limit=100").then(r => {
      if (r.ok) setEvents(r.events ?? []);
    }).catch(() => { });
  }, [fetchState, fetchBalance, fetchPositions, fetchRisk, fetchAiStats, fetchPerformance]);

  // ── Polling intervals ──
  useEffect(() => {
    const t1 = setInterval(fetchState, 10_000);
    const t2 = setInterval(fetchBalance, 30_000);
    const t3 = setInterval(fetchPositions, 15_000);
    const t4 = setInterval(fetchRisk, 30_000);      // circuit breaker status every 30s
    const t5 = setInterval(fetchAiStats, 60_000);   // AI model stats every 60s
    const t6 = setInterval(fetchPerformance, 60_000); // trade history every 60s
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); clearInterval(t5); clearInterval(t6); };
  }, [fetchState, fetchBalance, fetchPositions, fetchRisk, fetchAiStats, fetchPerformance]);

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
          return next.length > 100 ? next.slice(-100) : next;
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
      // Push leverage + sizing into bot config before starting
      await apiFetch("/bot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          DEFAULT_LEVERAGE: launchLeverage,
          MAX_LEVERAGE: launchLeverage,
          MANUAL_SIZE_PCT: sizeMode === "manual" ? manualSizePct / 100 : 0,
        }),
      });
      await apiFetch("/bot/start");
      await fetchState();
    } finally { setActionLoading(false); }
  }

  async function handleStop() {
    setActionLoading(true);
    try {
      await apiFetch("/bot/stop");
      await fetchState();
    } finally { setActionLoading(false); }
  }

  async function handleSaveConfig(update: Partial<BotConfig>) {
    await apiFetch("/bot/set", {
      method: "POST",
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

  // Gate: show login/register page if not authenticated
  if (!token) {
    if (authView === "register") {
      return <RegisterPage onBack={() => setAuthView("login")} onSuccess={() => setAuthView("login")} />;
    }
    return <LoginPage onLogin={handleLogin} onRegister={() => setAuthView("register")} />;
  }

  return (
    <div className="app">
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
          <span className="nav-address" title={USER}>
            {USER.slice(0, 6)}…{USER.slice(-4)}
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
                  <code>{config?.userAddress ?? USER}</code>
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
            <PerformancePanel
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
