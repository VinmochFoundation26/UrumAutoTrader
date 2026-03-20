// ── UrumTrader Landing Page ────────────────────────────────────────────────────
import { useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, BarChart2, Bot,
  CheckCircle, Shield, TrendingUp, Zap, DollarSign, Lock, Clock,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function NavBar() {
  return (
    <nav style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
      background: "rgba(13,17,23,0.85)", backdropFilter: "blur(12px)",
      borderBottom: "1px solid #21262d",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 24px", height: 60,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Zap size={20} style={{ color: "#00D4AA" }} />
        <span style={{ fontWeight: 700, fontSize: 18, color: "#f0f6fc" }}>UrumTrader</span>
        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: "rgba(0,212,170,0.1)", color: "#00D4AA", border: "1px solid rgba(0,212,170,0.25)", marginLeft: 4 }}>Arbitrum</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <a href="/terms.html" style={{ color: "#8b949e", fontSize: 13, textDecoration: "none" }}>Terms</a>
        <a href="/privacy.html" style={{ color: "#8b949e", fontSize: 13, textDecoration: "none" }}>Privacy</a>
        <a href="/" style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "#00D4AA", color: "#000", fontWeight: 700,
          fontSize: 13, padding: "8px 16px", borderRadius: 8,
          textDecoration: "none",
        }}>
          Launch App <ArrowRight size={13} />
        </a>
      </div>
    </nav>
  );
}

function Section({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ maxWidth: 1100, margin: "0 auto", padding: "0 24px", ...style }}>
      {children}
    </section>
  );
}

function Badge({ label, color = "#00D4AA" }: { label: string; color?: string }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 12px", borderRadius: 999, background: `${color}18`, color, border: `1px solid ${color}30`, display: "inline-block", marginBottom: 16 }}>
      {label}
    </span>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 12, padding: "24px 20px" }}>
      <div style={{ marginBottom: 14, color: "#00D4AA" }}>{icon}</div>
      <h3 style={{ fontSize: 16, fontWeight: 600, color: "#f0f6fc", marginBottom: 8 }}>{title}</h3>
      <p style={{ fontSize: 14, color: "#8b949e", lineHeight: 1.65 }}>{desc}</p>
    </div>
  );
}

function StatCard({ value, label, color = "#00D4AA" }: { value: string; label: string; color?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "28px 20px", background: "#161b22", border: "1px solid #21262d", borderRadius: 12 }}>
      <div style={{ fontSize: 36, fontWeight: 800, color, marginBottom: 8 }}>{value}</div>
      <div style={{ fontSize: 13, color: "#8b949e" }}>{label}</div>
    </div>
  );
}

function FeeRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: "1px solid #21262d" }}>
      <div>
        <div style={{ fontSize: 14, color: "#c9d1d9" }}>{label}</div>
        {note && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{note}</div>}
      </div>
      <span style={{ fontSize: 16, fontWeight: 700, color: "#f0f6fc" }}>{value}</span>
    </div>
  );
}

// ── Register Interest Modal ───────────────────────────────────────────────────

function RegisterModal({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 16 }}>
      <div style={{ background: "#161b22", border: "1px solid #21262d", borderRadius: 14, padding: 32, maxWidth: 420, width: "100%", textAlign: "center" }}>
        <Zap size={32} style={{ color: "#00D4AA", marginBottom: 16 }} />
        <h2 style={{ color: "#f0f6fc", marginBottom: 8 }}>Ready to start?</h2>
        <p style={{ color: "#8b949e", fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
          UrumTrader is invite-only. Create your account and our team will review your application within 24 hours.
        </p>
        <a
          href="/"
          style={{ display: "block", background: "#00D4AA", color: "#000", fontWeight: 700, fontSize: 15, padding: "13px 0", borderRadius: 10, textDecoration: "none", marginBottom: 12 }}
        >
          Create Account
        </a>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 13 }}
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}

// ── Main Landing Page ─────────────────────────────────────────────────────────

export default function LandingApp() {
  const [showModal, setShowModal] = useState(false);

  return (
    <div style={{ background: "#0d1117", minHeight: "100vh", color: "#c9d1d9", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <NavBar />

      {showModal && <RegisterModal onClose={() => setShowModal(false)} />}

      {/* ── Hero ── */}
      <div style={{ paddingTop: 120, paddingBottom: 100, textAlign: "center", position: "relative", overflow: "hidden" }}>
        {/* Glow */}
        <div style={{ position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)", width: 600, height: 300, background: "radial-gradient(ellipse, rgba(0,212,170,0.12) 0%, transparent 70%)", pointerEvents: "none" }} />
        <Section>
          <Badge label="✦ Now live on Arbitrum One" />
          <h1 style={{ fontSize: "clamp(36px, 6vw, 64px)", fontWeight: 800, color: "#f0f6fc", lineHeight: 1.15, marginBottom: 20, letterSpacing: "-0.02em" }}>
            Automated crypto trading,<br />
            <span style={{ color: "#00D4AA" }}>institutional grade.</span>
          </h1>
          <p style={{ fontSize: "clamp(16px, 2vw, 20px)", color: "#8b949e", maxWidth: 600, margin: "0 auto 40px", lineHeight: 1.7 }}>
            UrumTrader runs a multi-timeframe trend-following bot on Arbitrum perpetual futures. Set it up once — it trades 24/7 with built-in risk controls.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => setShowModal(true)}
              style={{ display: "flex", alignItems: "center", gap: 8, background: "#00D4AA", color: "#000", fontWeight: 700, fontSize: 16, padding: "14px 28px", borderRadius: 10, border: "none", cursor: "pointer" }}
            >
              Get Started Free <ArrowRight size={16} />
            </button>
            <a href="/" style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", color: "#f0f6fc", fontWeight: 600, fontSize: 16, padding: "14px 28px", borderRadius: 10, border: "1px solid #21262d", textDecoration: "none" }}>
              Sign In <ArrowRight size={16} />
            </a>
          </div>
          <p style={{ marginTop: 16, fontSize: 13, color: "#6b7280" }}>14-day free trial · No credit card required · Invite-only</p>
        </Section>
      </div>

      {/* ── Stats ── */}
      <Section style={{ paddingBottom: 80 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
          <StatCard value="8"    label="Trading pairs"          color="#00D4AA" />
          <StatCard value="24/7" label="Always on"              color="#60A5FA" />
          <StatCard value="5×"   label="Max leverage"           color="#A78BFA" />
          <StatCard value="-10%" label="Daily loss circuit breaker" color="#F59E0B" />
          <StatCard value="14d"  label="Free trial"             color="#00D4AA" />
        </div>
      </Section>

      {/* ── How it Works ── */}
      <div style={{ background: "#161b22", borderTop: "1px solid #21262d", borderBottom: "1px solid #21262d", padding: "80px 0" }}>
        <Section>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <Badge label="How It Works" />
            <h2 style={{ fontSize: 32, fontWeight: 700, color: "#f0f6fc" }}>Three steps to automated trading</h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 24 }}>
            {[
              { step: "01", title: "Deposit USDC", desc: "Connect your Arbitrum wallet and deposit USDC into your personal on-chain vault. You retain custody through the smart contract.", icon: <DollarSign size={28} /> },
              { step: "02", title: "Bot trades for you", desc: "Our multi-timeframe algorithm scans 4h, 1h, and 5m charts, enters high-conviction trades with strict ATR-based risk sizing.", icon: <Bot size={28} /> },
              { step: "03", title: "Withdraw anytime", desc: "Normal or emergency withdrawal at any time. Fees are deducted transparently. Your funds remain on-chain throughout.", icon: <TrendingUp size={28} /> },
            ].map(s => (
              <div key={s.step} style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 12, padding: 28 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#00D4AA", letterSpacing: "0.08em" }}>{s.step}</span>
                  <span style={{ color: "#00D4AA" }}>{s.icon}</span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 600, color: "#f0f6fc", marginBottom: 8 }}>{s.title}</h3>
                <p style={{ fontSize: 14, color: "#8b949e", lineHeight: 1.65 }}>{s.desc}</p>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* ── Features ── */}
      <Section style={{ padding: "80px 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <Badge label="Features" />
          <h2 style={{ fontSize: 32, fontWeight: 700, color: "#f0f6fc" }}>Built for reliability</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
          <FeatureCard icon={<BarChart2 size={24} />} title="Multi-timeframe analysis" desc="4h macro regime, 1h trend, 5m entry. Shorts are blocked when the 4h regime is bullish — the leading cause of losses." />
          <FeatureCard icon={<Shield size={24} />} title="7 entry guards" desc="ATR volatility filter, stochastic oversold/overbought, trend regime, S/R structure votes, slippage guard, and circuit breaker." />
          <FeatureCard icon={<Activity size={24} />} title="Live position monitoring" desc="50ms exit monitor watches every position. Trailing stop-loss, take-profit, and max-hold exit all work in real time." />
          <FeatureCard icon={<Zap size={24} />} title="TX acceleration" desc="Stuck transactions auto-replace with 15% gas bump after 20 seconds. Dual price feed (Binance + Bybit) for resilience." />
          <FeatureCard icon={<Lock size={24} />} title="On-chain custody" desc="Funds are held in your own vault smart contract on Arbitrum One. We operate the bot — you keep custody." />
          <FeatureCard icon={<Clock size={24} />} title="Daily circuit breaker" desc="If the bot loses more than 10% in a single day, it automatically stops trading until midnight UTC." />
        </div>
      </Section>

      {/* ── Fee Table ── */}
      <div style={{ background: "#161b22", borderTop: "1px solid #21262d", borderBottom: "1px solid #21262d", padding: "80px 0" }}>
        <Section>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <Badge label="Transparent Fees" />
            <h2 style={{ fontSize: 32, fontWeight: 700, color: "#f0f6fc" }}>Simple, aligned pricing</h2>
            <p style={{ color: "#8b949e", marginTop: 12, fontSize: 15 }}>We only make money when you make money — 25% profit share keeps us aligned.</p>
          </div>
          <div style={{ maxWidth: 520, margin: "0 auto", background: "#0d1117", border: "1px solid #21262d", borderRadius: 14, padding: "0 28px 8px" }}>
            <FeeRow label="Monthly subscription" value="$20 USDC/mo" note="14-day free trial included" />
            <FeeRow label="Deposit fee" value="5%" note="Deducted at time of deposit" />
            <FeeRow label="Normal withdrawal" value="10%" note="Standard queue, instant bot approval" />
            <FeeRow label="Emergency withdrawal" value="15%" note="Bypasses queue — immediate" />
            <FeeRow label="Profit share" value="25%" note="Only on realised profits at withdrawal" />
          </div>
        </Section>
      </div>

      {/* ── Risk Warning ── */}
      <Section style={{ padding: "60px 24px" }}>
        <div style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 12, padding: "24px 28px", display: "flex", gap: 16, alignItems: "flex-start" }}>
          <AlertTriangle size={20} style={{ color: "#F59E0B", flexShrink: 0, marginTop: 2 }} />
          <div>
            <p style={{ fontSize: 14, color: "#d1a843", fontWeight: 600, marginBottom: 6 }}>Risk Warning</p>
            <p style={{ fontSize: 13, color: "#8b949e", lineHeight: 1.65 }}>
              Automated cryptocurrency trading involves substantial risk of loss. Past performance does not guarantee future results. Leveraged positions amplify both gains and losses. Only deposit funds you can afford to lose entirely. UrumTrader is a tool, not financial advice. By using the platform you accept our <a href="/terms.html" style={{ color: "#00D4AA" }}>Terms of Service</a> and <a href="/privacy.html" style={{ color: "#00D4AA" }}>Privacy Policy</a>.
            </p>
          </div>
        </div>
      </Section>

      {/* ── CTA ── */}
      <div style={{ textAlign: "center", padding: "60px 24px 100px" }}>
        <CheckCircle size={40} style={{ color: "#00D4AA", marginBottom: 20 }} />
        <h2 style={{ fontSize: 32, fontWeight: 700, color: "#f0f6fc", marginBottom: 12 }}>Ready to automate your trading?</h2>
        <p style={{ color: "#8b949e", fontSize: 16, marginBottom: 32 }}>Join UrumTrader — invite-only, 14-day free trial, no credit card required.</p>
        <button
          onClick={() => setShowModal(true)}
          style={{ background: "#00D4AA", color: "#000", fontWeight: 700, fontSize: 16, padding: "14px 32px", borderRadius: 10, border: "none", cursor: "pointer" }}
        >
          Apply for Access
        </button>
      </div>

      {/* ── Footer ── */}
      <footer style={{ borderTop: "1px solid #21262d", padding: "28px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Zap size={16} style={{ color: "#00D4AA" }} />
          <span style={{ fontWeight: 700, color: "#f0f6fc" }}>UrumTrader</span>
          <span style={{ color: "#6b7280", fontSize: 13 }}>· Arbitrum One · v1.0</span>
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          <a href="/terms.html"   style={{ color: "#6b7280", fontSize: 13, textDecoration: "none" }}>Terms of Service</a>
          <a href="/privacy.html" style={{ color: "#6b7280", fontSize: 13, textDecoration: "none" }}>Privacy Policy</a>
          <a href="/"             style={{ color: "#6b7280", fontSize: 13, textDecoration: "none" }}>Launch App</a>
        </div>
      </footer>
    </div>
  );
}
