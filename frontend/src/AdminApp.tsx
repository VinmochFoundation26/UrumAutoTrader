// ── UrumTrader Admin Dashboard ────────────────────────────────────────────────
import { useEffect, useState, useCallback } from "react";
import {
  Activity, AlertTriangle, Bot, CheckCircle, Circle,
  Power, RefreshCw, Settings, Trash2, User, Users,
  Wallet, X, Zap, MessageCircle, Shield, DollarSign, CreditCard, Sliders,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type UserStatus = "pending_email" | "pending_approval" | "active" | "suspended";
type UserRole   = "admin" | "support" | "user";

interface AppUser {
  id:             string;
  email:          string;
  walletAddress:  string;
  vaultAddress:   string;
  role:           UserRole;
  status:         UserStatus;
  trialExpiresAt: string | null;
  createdAt:      string;
  approvedAt:     string | null;
}

interface AdminStats {
  totalUsers:      number;
  active:          number;
  pendingApproval: number;
  pendingEmail:    number;
  suspended:       number;
  uptime:          number;
  botRunning:      boolean;
}

interface SupportTicket {
  id:        string;
  name:      string;
  email:     string;
  category:  string;
  message:   string;
  createdAt: number;
}

interface UserFeeStats {
  accounting: { netDeposited: number; profitSharePaid: number };
  subscription: { paidUntil: string | null; totalPaid: number; active: boolean; status: "trial" | "active" | "expired"; daysLeft: number };
  recentTransactions: { type: string; amount: number; fee: number; net: number; ts: string }[];
  feeRates: { depositPct: number; withdrawPct: number; emergencyPct: number; profitSharePct: number; subscriptionUSDC: number; trialDays: number };
}

interface UserTradingConfig {
  symbols?:             string[];
  maxLeverage?:         number;
  maxConcurrentTrades?: number;
  riskPct?:             number;
  updatedAt?:           string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_KEY = "at_token";

function decodeJwtPayload(token: string): { role?: string; userId?: string } {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
}

// ── API helper ────────────────────────────────────────────────────────────────

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const r = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  if (r.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.reload();
  }
  return r.json() as Promise<T>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtUptime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function SubBadge({ status, daysLeft }: { status: "trial" | "active" | "expired"; daysLeft: number }) {
  const cfg = {
    trial:   { color: "#60A5FA", label: `Trial (${daysLeft}d)` },
    active:  { color: "#00D4AA", label: `Active (${daysLeft}d)` },
    expired: { color: "#EF4444", label: "Expired" },
  };
  const { color, label } = cfg[status];
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 999, background: `${color}22`, color, border: `1px solid ${color}44` }}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: UserStatus }) {
  const cfg: Record<UserStatus, { color: string; label: string }> = {
    active:           { color: "#00D4AA", label: "Active" },
    pending_approval: { color: "#F59E0B", label: "Pending" },
    pending_email:    { color: "#6B7280", label: "Unverified" },
    suspended:        { color: "#EF4444", label: "Suspended" },
  };
  const { color, label } = cfg[status] ?? { color: "#888", label: status };
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: `${color}22`, color, border: `1px solid ${color}44` }}>
      {label}
    </span>
  );
}

// ── Trading Config Editor ─────────────────────────────────────────────────────

const KNOWN_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","LINKUSDT"];

function TradingConfigEditor({ user, onClose, onSaved }: {
  user: AppUser;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [cfg,     setCfg]     = useState<UserTradingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  // Form state
  const [symbols,     setSymbols]     = useState<string[]>([]);
  const [maxLev,      setMaxLev]      = useState<string>("");
  const [maxConc,     setMaxConc]     = useState<string>("");
  const [riskPct,     setRiskPct]     = useState<string>("");

  useEffect(() => {
    api<any>(`/admin/users/${user.id}/trading-config`).then(r => {
      const c: UserTradingConfig = r.config ?? {};
      setCfg(c);
      setSymbols(c.symbols ?? []);
      setMaxLev(c.maxLeverage != null ? String(c.maxLeverage) : "");
      setMaxConc(c.maxConcurrentTrades != null ? String(c.maxConcurrentTrades) : "");
      setRiskPct(c.riskPct != null ? String(+(c.riskPct * 100).toFixed(1)) : "");
    }).catch(() => setErr("Failed to load config"))
    .finally(() => setLoading(false));
  }, [user.id]);

  function toggleSymbol(sym: string) {
    setSymbols(prev => prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym]);
  }

  async function handleSave() {
    setSaving(true); setErr(null);
    const patch: UserTradingConfig = {};
    if (symbols.length > 0) patch.symbols = symbols;
    if (maxLev)  patch.maxLeverage         = Number(maxLev);
    if (maxConc) patch.maxConcurrentTrades = Number(maxConc);
    if (riskPct) patch.riskPct             = Number(riskPct) / 100;
    try {
      const r = await api<any>(`/admin/users/${user.id}/trading-config`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(r.error ?? "Save failed");
      onSaved(`Trading config saved for ${user.email}`);
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? "Save failed");
    } finally { setSaving(false); }
  }

  async function handleReset() {
    if (!confirm("Reset to global defaults? This removes all per-user overrides.")) return;
    setSaving(true);
    try {
      const r = await api<any>(`/admin/users/${user.id}/trading-config`, { method: "DELETE" });
      if (!r.ok) throw new Error(r.error ?? "Reset failed");
      onSaved(`Trading config reset for ${user.email}`);
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? "Reset failed");
    } finally { setSaving(false); }
  }

  const row = (label: string, input: React.ReactNode, hint?: string) => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>{label}</label>
      {input}
      {hint && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{hint}</div>}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 16 }}>
      <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 14, padding: 28, width: 480, maxWidth: "100%", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, color: "var(--teal)" }}>Trading Config</h3>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>{user.email}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer" }}><X size={18} /></button>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 30, color: "var(--text-secondary)" }}><RefreshCw size={20} className="spin" /></div>
        ) : (
          <>
            {cfg?.updatedAt && (
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 16 }}>
                Last updated: {fmtDate(cfg.updatedAt)} — empty fields inherit global defaults
              </div>
            )}

            {row("Symbols (leave none selected = use global defaults)",
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {KNOWN_SYMBOLS.map(sym => (
                  <button
                    key={sym}
                    onClick={() => toggleSymbol(sym)}
                    style={{
                      padding: "5px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontWeight: 500,
                      background: symbols.includes(sym) ? "rgba(0,212,170,0.15)" : "var(--surface)",
                      color:      symbols.includes(sym) ? "var(--teal)" : "var(--text-secondary)",
                      border: `1px solid ${symbols.includes(sym) ? "var(--teal)" : "var(--border)"}`,
                    }}
                  >{sym.replace("USDT","")}</button>
                ))}
              </div>
            )}

            {row("Max Leverage",
              <input
                type="number" min={1} max={20} step={1}
                placeholder="e.g. 5 (global default applies if blank)"
                value={maxLev}
                onChange={e => setMaxLev(e.target.value)}
                style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text)", fontSize: 14 }}
              />,
              "Hard cap — user cannot exceed this leverage regardless of global config"
            )}

            {row("Max Concurrent Trades",
              <input
                type="number" min={1} max={10} step={1}
                placeholder="e.g. 2 (global default applies if blank)"
                value={maxConc}
                onChange={e => setMaxConc(e.target.value)}
                style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text)", fontSize: 14 }}
              />,
              "Maximum simultaneous open positions for this user"
            )}

            {row("Risk Per Trade (%)",
              <input
                type="number" min={1} max={100} step={0.5}
                placeholder="e.g. 10 = 10% of vault per trade"
                value={riskPct}
                onChange={e => setRiskPct(e.target.value)}
                style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text)", fontSize: 14 }}
              />,
              "Percentage of vault balance allocated per trade"
            )}

            {err && <div style={{ color: "#EF4444", fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                onClick={handleReset}
                disabled={saving}
                style={{ padding: "9px 14px", background: "transparent", border: "1px solid #EF444444", borderRadius: 8, color: "#EF4444", cursor: "pointer", fontSize: 13 }}
              >
                Reset to Defaults
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={onClose} style={{ padding: "9px 14px", background: "transparent", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 13 }}>
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ padding: "9px 18px", background: "var(--teal)", border: "none", borderRadius: 8, color: "#000", cursor: "pointer", fontSize: 13, fontWeight: 700, opacity: saving ? 0.6 : 1 }}
              >
                {saving ? "Saving…" : "Save Config"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Grant Subscription Modal ──────────────────────────────────────────────────

function GrantSubModal({ user, onClose, onGranted }: {
  user: AppUser;
  onClose: () => void;
  onGranted: (msg: string) => void;
}) {
  const [amount,  setAmount]  = useState("20");
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  async function handleGrant() {
    setLoading(true); setErr(null);
    try {
      // POST /subscription/pay on behalf of user using admin endpoint
      const r = await api<any>(`/admin/users/${user.id}/grant-subscription`, {
        method: "POST",
        body: JSON.stringify({ amount: Number(amount) }),
      });
      if (!r.ok) throw new Error(r.error ?? "Grant failed");
      onGranted(`Subscription granted for ${user.email} until ${r.paidUntil?.slice(0,10)}`);
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? "Grant failed");
    } finally { setLoading(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 16 }}>
      <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 12, padding: 28, width: 380, maxWidth: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: "var(--teal)" }}>Grant Subscription</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer" }}><X size={18} /></button>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
          Manually grant a 30-day subscription period to <strong style={{ color: "var(--text)" }}>{user.email}</strong>.<br />
          Use this for refunds, compensation, or manual payments received off-platform.
        </p>
        <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>Amount (USDC)</label>
        <input
          type="number" min={0} step={1}
          value={amount}
          onChange={e => setAmount(e.target.value)}
          style={{ width: "100%", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text)", fontSize: 14, marginBottom: 16, boxSizing: "border-box" }}
        />
        {err && <div style={{ color: "#EF4444", fontSize: 13, marginBottom: 12 }}>⚠ {err}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 10, background: "transparent", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer" }}>Cancel</button>
          <button
            onClick={handleGrant}
            disabled={loading}
            style={{ flex: 1, padding: 10, background: "var(--teal)", border: "none", borderRadius: 8, color: "#000", cursor: "pointer", fontWeight: 700, opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Granting…" : "Grant 30 Days"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Admin Login ───────────────────────────────────────────────────────────────

function AdminLoginPage({ onLogin }: { onLogin: (t: string) => void }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json();
      if (d.ok && d.token) {
        const { role } = decodeJwtPayload(d.token);
        if (role !== "admin" && role !== "support") {
          setError("Access denied — admin credentials required");
          return;
        }
        sessionStorage.setItem(TOKEN_KEY, d.token);
        onLogin(d.token);
      } else {
        setError(d.error ?? "Invalid credentials");
      }
    } catch { setError("Network error"); }
    finally { setLoading(false); }
  }

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-logo">
          <Shield size={36} style={{ color: "var(--teal)" }} />
          <h1>Admin Portal</h1>
          <p>UrumTrader administration</p>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <input className="login-input" type="email" placeholder="Admin email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
          <input className="login-input" type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
          {error && <div className="login-error"><AlertTriangle size={13} /> {error}</div>}
          <button type="submit" className="action-btn start-btn login-submit" disabled={loading}>
            {loading ? <RefreshCw size={14} className="spin" /> : <Power size={14} />}
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>
        <p className="login-footer"><a href="/" style={{ color: "var(--text-secondary)", textDecoration: "none" }}>← Back to dashboard</a></p>
      </div>
    </div>
  );
}

// ── Approve Modal ─────────────────────────────────────────────────────────────

function ApproveModal({ user, onApprove, onClose }: { user: AppUser; onApprove: () => void; onClose: () => void }) {
  const [loading, setLoading] = useState(false);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
      <div style={{ background: "#1a1d23", border: "1px solid #2a2d35", borderRadius: 12, padding: 28, width: 400, maxWidth: "90vw" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: "var(--teal)" }}>Approve User</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer" }}><X size={18} /></button>
        </div>
        <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 20 }}>
          Approve <strong style={{ color: "var(--text-primary)" }}>{user.email}</strong>?<br /><br />
          They will receive an approval email and can log in, connect their wallet, deposit funds and start trading.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="action-btn stop-btn" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>Cancel</button>
          <button
            className="action-btn start-btn"
            style={{ flex: 1, justifyContent: "center" }}
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              await onApprove();
              setLoading(false);
            }}
          >
            {loading ? <RefreshCw size={13} className="spin" /> : <CheckCircle size={13} />}
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Admin App ─────────────────────────────────────────────────────────────

export default function AdminApp() {
  const [token,    setToken]    = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [tab,      setTab]      = useState<"approvals" | "users" | "tickets" | "stats" | "fees" | "config">("approvals");
  const [users,    setUsers]    = useState<AppUser[]>([]);
  const [stats,    setStats]    = useState<AdminStats | null>(null);
  const [tickets,  setTickets]  = useState<SupportTicket[]>([]);
  const [feeStats, setFeeStats] = useState<Record<string, UserFeeStats>>({});
  const [loading,  setLoading]  = useState(false);
  const [msg,      setMsg]      = useState<string | null>(null);
  const [approveTarget,  setApproveTarget]  = useState<AppUser | null>(null);
  const [configTarget,   setConfigTarget]   = useState<AppUser | null>(null);
  const [grantSubTarget, setGrantSubTarget] = useState<AppUser | null>(null);

  // Check token is admin role
  useEffect(() => {
    if (token) {
      const { role } = decodeJwtPayload(token);
      if (role !== "admin" && role !== "support") {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }
    }
  }, [token]);

  const fetchAll = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [usersRes, statsRes, ticketsRes] = await Promise.all([
        api<any>("/admin/users"),
        api<any>("/admin/stats"),
        api<any>("/admin/support-tickets?limit=50"),
      ]);
      if (usersRes.ok) setUsers(usersRes.users ?? []);
      if (statsRes.ok) setStats(statsRes);
      if (ticketsRes.ok) setTickets(ticketsRes.tickets ?? []);
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Fetch fee stats for all users when fees tab is opened
  const fetchFeeStats = useCallback(async (userList: AppUser[]) => {
    const results: Record<string, UserFeeStats> = {};
    await Promise.all(
      userList.map(async u => {
        try {
          const r = await api<any>(`/admin/users/${u.id}/fees`);
          if (r.ok) results[u.id] = r;
        } catch { /* skip */ }
      })
    );
    setFeeStats(results);
  }, []);

  useEffect(() => {
    if (tab === "fees" && users.length > 0) fetchFeeStats(users);
  }, [tab, users, fetchFeeStats]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function flash(message: string) {
    setMsg(message);
    setTimeout(() => setMsg(null), 3500);
  }

  async function approveUser(userId: string) {
    const r = await api<any>(`/admin/users/${userId}/approve`, { method: "POST" });
    if (r.ok) { flash("User approved — email sent"); fetchAll(); }
    else flash(`Error: ${r.error}`);
    setApproveTarget(null);
  }

  async function rejectUser(userId: string) {
    if (!confirm("Reject this user? They'll receive a rejection email.")) return;
    const r = await api<any>(`/admin/users/${userId}/reject`, { method: "POST" });
    if (r.ok) { flash("User rejected"); fetchAll(); }
    else flash(`Error: ${r.error}`);
  }

  async function suspendUser(userId: string) {
    if (!confirm("Suspend this user? Their session will be revoked.")) return;
    const r = await api<any>(`/admin/users/${userId}/suspend`, { method: "POST" });
    if (r.ok) { flash("User suspended"); fetchAll(); }
    else flash(`Error: ${r.error}`);
  }

  async function deleteUser(userId: string) {
    if (!confirm("Permanently delete this user? This cannot be undone.")) return;
    const r = await api<any>(`/admin/users/${userId}`, { method: "DELETE" });
    if (r.ok) { flash("User deleted"); fetchAll(); }
    else flash(`Error: ${r.error}`);
  }

  if (!token) return <AdminLoginPage onLogin={t => setToken(t)} />;

  const pendingUsers = users.filter(u => u.status === "pending_approval");

  return (
    <div className="app">
      {/* ── Navbar ── */}
      <nav className="navbar">
        <div className="nav-brand">
          <Zap size={20} className="brand-icon" />
          <span className="brand-name">UrumTrader</span>
          <span className="brand-net" style={{ background: "rgba(245,158,11,0.15)", color: "#F59E0B" }}>Admin</span>
        </div>
        <div className="nav-right">
          {loading && <RefreshCw size={14} className="spin" style={{ color: "var(--teal)" }} />}
          <button onClick={fetchAll} className="icon-btn" title="Refresh"><RefreshCw size={16} /></button>
          <a href="/" className="icon-btn" title="Dashboard"><Activity size={16} /></a>
          <button
            onClick={() => { sessionStorage.removeItem(TOKEN_KEY); setToken(null); }}
            className="icon-btn" title="Logout"
          ><Power size={16} /></button>
        </div>
      </nav>

      {/* ── Toast ── */}
      {msg && (
        <div style={{ position: "fixed", top: 70, right: 20, background: "#00D4AA22", border: "1px solid #00D4AA66", borderRadius: 8, padding: "10px 16px", color: "var(--teal)", fontSize: 14, zIndex: 9999 }}>
          <CheckCircle size={13} style={{ marginRight: 6, verticalAlign: "middle" }} />{msg}
        </div>
      )}

      {approveTarget && (
        <ApproveModal
          user={approveTarget}
          onApprove={() => approveUser(approveTarget.id)}
          onClose={() => setApproveTarget(null)}
        />
      )}

      {configTarget && (
        <TradingConfigEditor
          user={configTarget}
          onClose={() => setConfigTarget(null)}
          onSaved={m => { flash(m); fetchAll(); }}
        />
      )}

      {grantSubTarget && (
        <GrantSubModal
          user={grantSubTarget}
          onClose={() => setGrantSubTarget(null)}
          onGranted={m => { flash(m); fetchAll(); }}
        />
      )}

      <main className="dashboard-layout" style={{ padding: "80px 20px 20px" }}>
        {/* ── Stats strip ── */}
        {stats && (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
            {[
              { label: "Total Users", value: stats.totalUsers,      icon: <Users size={16} /> },
              { label: "Active",      value: stats.active,          icon: <CheckCircle size={16} style={{ color: "#00D4AA" }} /> },
              { label: "Pending",     value: stats.pendingApproval, icon: <Circle size={16} style={{ color: "#F59E0B" }} /> },
              { label: "Suspended",   value: stats.suspended,       icon: <X size={16} style={{ color: "#EF4444" }} /> },
              { label: "Bot",         value: stats.botRunning ? "Running" : "Stopped", icon: <Bot size={16} style={{ color: stats.botRunning ? "#00D4AA" : "#EF4444" }} /> },
              { label: "Uptime",      value: fmtUptime(stats.uptime), icon: <Activity size={16} /> },
            ].map(s => (
              <div key={s.label} style={{ flex: "1 1 130px", background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 12, marginBottom: 6 }}>
                  {s.icon} {s.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Tab bar ── */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "var(--card-bg)", borderRadius: 10, padding: 4, border: "1px solid var(--border)", width: "fit-content", flexWrap: "wrap" }}>
          {([
            { key: "approvals", label: `Approvals${pendingUsers.length ? ` (${pendingUsers.length})` : ""}`, icon: <CheckCircle size={14} /> },
            { key: "users",     label: "All Users",   icon: <Users size={14} /> },
            { key: "config",    label: "Trading Config", icon: <Sliders size={14} /> },
            { key: "tickets",   label: `Tickets${tickets.length ? ` (${tickets.length})` : ""}`, icon: <MessageCircle size={14} /> },
            { key: "fees",      label: "Fees & Subs", icon: <DollarSign size={14} /> },
            { key: "stats",     label: "Bot Stats",   icon: <Settings size={14} /> },
          ] as const).map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
                background: tab === t.key ? "var(--teal)" : "transparent",
                color: tab === t.key ? "#000" : "var(--text-secondary)",
                border: "none", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 500,
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* ── PENDING APPROVALS ── */}
        {tab === "approvals" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: "var(--text-primary)" }}>
              Pending Approvals {pendingUsers.length > 0 && <span style={{ background: "#F59E0B22", color: "#F59E0B", borderRadius: 999, padding: "2px 8px", fontSize: 12 }}>{pendingUsers.length}</span>}
            </h2>
            {pendingUsers.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}>
                <CheckCircle size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
                <p>No pending approvals</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {pendingUsers.map(u => (
                  <div key={u.id} style={{ background: "var(--card-bg)", border: "1px solid #F59E0B44", borderRadius: 12, padding: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                      <div>
                        <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
                          <User size={14} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--teal)" }} />{u.email}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
                          <Wallet size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                          {u.walletAddress || "No wallet connected"}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          Registered: {fmtDate(u.createdAt)}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => rejectUser(u.id)}
                          className="action-btn stop-btn"
                          style={{ padding: "8px 14px", fontSize: 13 }}
                        ><X size={13} /> Reject</button>
                        <button
                          onClick={() => setApproveTarget(u)}
                          className="action-btn start-btn"
                          style={{ padding: "8px 14px", fontSize: 13 }}
                        ><CheckCircle size={13} /> Approve</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── ALL USERS ── */}
        {tab === "users" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: "var(--text-primary)" }}>All Users ({users.length})</h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>
                    {["Email", "Wallet", "Vault", "Status", "Role", "Joined", "Actions"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} style={{ borderBottom: "1px solid var(--border)", color: "var(--text-primary)" }}>
                      <td style={{ padding: "10px 12px" }}>{u.email}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 11 }}>
                        {u.walletAddress ? `${u.walletAddress.slice(0,6)}…${u.walletAddress.slice(-4)}` : "—"}
                      </td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 11 }}>
                        {u.vaultAddress ? `${u.vaultAddress.slice(0,6)}…${u.vaultAddress.slice(-4)}` : "—"}
                      </td>
                      <td style={{ padding: "10px 12px" }}><StatusBadge status={u.status} /></td>
                      <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontSize: 12 }}>{u.role}</td>
                      <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontSize: 11 }}>{fmtDate(u.createdAt)}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          {u.status === "pending_approval" && (
                            <button onClick={() => setApproveTarget(u)} className="icon-btn" title="Approve" style={{ color: "#00D4AA" }}><CheckCircle size={14} /></button>
                          )}
                          {u.status === "active" && (
                            <button onClick={() => suspendUser(u.id)} className="icon-btn" title="Suspend" style={{ color: "#F59E0B" }}><X size={14} /></button>
                          )}
                          {u.status === "suspended" && (
                            <button onClick={() => setApproveTarget(u)} className="icon-btn" title="Re-approve" style={{ color: "#00D4AA" }}><CheckCircle size={14} /></button>
                          )}
                          <button onClick={() => setConfigTarget(u)} className="icon-btn" title="Edit trading config" style={{ color: "#818CF8" }}><Sliders size={14} /></button>
                          <button onClick={() => deleteUser(u.id)} className="icon-btn" title="Delete" style={{ color: "#EF4444" }}><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}>No users yet</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── TRADING CONFIG ── */}
        {tab === "config" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: "var(--text-primary)" }}>Per-User Trading Config</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
              Override symbols, leverage, concurrent trades, and risk % per user. Blank fields inherit global <code>bot.config.json</code> values.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {users.filter(u => u.status === "active" || u.status === "suspended").map(u => (
                <div key={u.id} style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                      <User size={13} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--teal)" }} />{u.email}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      <StatusBadge status={u.status} />
                      <span style={{ marginLeft: 8 }}>Wallet: {u.walletAddress ? `${u.walletAddress.slice(0,8)}…` : "none"}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => setGrantSubTarget(u)}
                      style={{ padding: "7px 12px", background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.3)", borderRadius: 7, color: "var(--teal)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}
                    >
                      <CreditCard size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />Grant Sub
                    </button>
                    <button
                      onClick={() => setConfigTarget(u)}
                      style={{ padding: "7px 12px", background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 7, color: "#818CF8", cursor: "pointer", fontSize: 12, fontWeight: 500 }}
                    >
                      <Sliders size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />Edit Config
                    </button>
                  </div>
                </div>
              ))}
              {users.filter(u => u.status === "active" || u.status === "suspended").length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}>
                  <Sliders size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
                  <p>No active users yet</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SUPPORT TICKETS ── */}
        {tab === "tickets" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, color: "var(--text-primary)" }}>Support Tickets ({tickets.length})</h2>
            {tickets.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}>
                <MessageCircle size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
                <p>No support tickets</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {tickets.map((t, i) => (
                  <div key={t.id ?? i} style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 10, padding: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                      <div>
                        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{t.name}</span>
                        <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: 8 }}>{t.email}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "rgba(0,212,170,0.1)", color: "var(--teal)", border: "1px solid rgba(0,212,170,0.2)" }}>
                          {t.category}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                          {new Date(t.createdAt).toLocaleString()}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t.id}</span>
                      </div>
                    </div>
                    <p style={{ color: "var(--text-primary)", fontSize: 14, lineHeight: 1.6, margin: 0 }}>{t.message}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── FEES & SUBSCRIPTIONS ── */}
        {tab === "fees" && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 20, color: "var(--text-primary)" }}>Fees & Subscriptions</h2>

            {/* Fee rates reference */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
              {[
                { label: "Deposit Fee",    value: "5%",       color: "#60A5FA" },
                { label: "Withdrawal Fee", value: "10%",      color: "#F59E0B" },
                { label: "Emergency Fee",  value: "15%",      color: "#EF4444" },
                { label: "Profit Share",   value: "25%",      color: "#A78BFA" },
                { label: "Subscription",   value: "20 USDC/mo", color: "#00D4AA" },
                { label: "Trial Period",   value: "14 days",  color: "#6B7280" },
              ].map(f => (
                <div key={f.label} style={{ background: "var(--card-bg)", border: `1px solid ${f.color}33`, borderRadius: 10, padding: "12px 16px", minWidth: 120 }}>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>{f.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: f.color }}>{f.value}</div>
                </div>
              ))}
            </div>

            {/* Per-user breakdown */}
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "var(--text-secondary)" }}>Per-User Revenue</h3>
            {users.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "var(--text-secondary)" }}><p>No users yet</p></div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {users.map(u => {
                  const fs = feeStats[u.id];
                  const sub = fs?.subscription;
                  return (
                    <div key={u.id} style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: fs ? 16 : 0 }}>
                        <div>
                          <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                            <User size={13} style={{ verticalAlign: "middle", marginRight: 6, color: "var(--teal)" }} />{u.email}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{u.role} · <StatusBadge status={u.status} /></div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {sub && <SubBadge status={sub.status} daysLeft={sub.daysLeft} />}
                          <button
                            onClick={() => setGrantSubTarget(u)}
                            style={{ padding: "4px 10px", background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.3)", borderRadius: 6, color: "var(--teal)", cursor: "pointer", fontSize: 11 }}
                          >+ Grant Sub</button>
                        </div>
                      </div>
                      {fs ? (
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                          {[
                            { label: "Net Deposited",   value: `${fs.accounting.netDeposited.toFixed(2)} USDC`,   icon: <Wallet size={13} />,      color: "#60A5FA" },
                            { label: "Profit Share Paid", value: `${fs.accounting.profitSharePaid.toFixed(2)} USDC`, icon: <DollarSign size={13} />, color: "#A78BFA" },
                            { label: "Sub Paid Total",  value: `${sub?.totalPaid?.toFixed(2) ?? "0.00"} USDC`,     icon: <CreditCard size={13} />,  color: "#00D4AA" },
                            { label: "Sub Expires",     value: sub?.paidUntil ? fmtDate(sub.paidUntil) : (sub?.status === "trial" ? `Trial: ${sub.daysLeft}d left` : "Expired"), icon: <Activity size={13} />, color: sub?.active ? "#00D4AA" : "#EF4444" },
                          ].map(s => (
                            <div key={s.label} style={{ flex: "1 1 140px", background: "#0d1117", borderRadius: 8, padding: "10px 14px", border: "1px solid #1e2330" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>
                                <span style={{ color: s.color }}>{s.icon}</span>{s.label}
                              </div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: s.color }}>{s.value}</div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", fontStyle: "italic" }}>No fee activity yet</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── BOT STATS ── */}
        {tab === "stats" && stats && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 20, color: "var(--text-primary)" }}>Platform Health</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
              {[
                { label: "Bot Status",    value: stats.botRunning ? "Running" : "Stopped", color: stats.botRunning ? "#00D4AA" : "#EF4444", icon: <Bot size={20} /> },
                { label: "Server Uptime", value: fmtUptime(stats.uptime),                  color: "#00D4AA",          icon: <Activity size={20} /> },
                { label: "Active Users",  value: String(stats.active),                      color: "#00D4AA",          icon: <Users size={20} /> },
                { label: "Pending Review",value: String(stats.pendingApproval),             color: "#F59E0B",          icon: <Circle size={20} /> },
                { label: "Suspended",     value: String(stats.suspended),                   color: stats.suspended > 0 ? "#EF4444" : "#00D4AA", icon: <Shield size={20} /> },
                { label: "Total Users",   value: String(stats.totalUsers),                  color: "var(--teal)",      icon: <Users size={20} /> },
              ].map(s => (
                <div key={s.label} style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
                  <div style={{ color: "var(--text-secondary)", fontSize: 12, display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ color: s.color }}>{s.icon}</span>
                    {s.label}
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
