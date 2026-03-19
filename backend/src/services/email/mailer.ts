// ── Mailer — Resend HTTP API (no npm package, uses built-in fetch) ─────────────
// Env vars required:
//   RESEND_API_KEY  — from resend.com dashboard (re_xxxxxxx)
//   ADMIN_EMAIL     — admin notification recipient
//   APP_URL         — e.g. https://urumtrader.com
//
// From address: "UrumTrader <onboarding@resend.dev>" (works without domain verification)
// For custom from address (e.g. noreply@urumtrader.com): verify domain at resend.com

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL ?? "";
const APP_URL       = (process.env.APP_URL ?? "https://urumtrader.com").replace(/\/$/, "");

// Resend's default test address works without domain verification
// Switch to your own domain once DNS is verified in Resend dashboard
const FROM_ADDRESS  = process.env.RESEND_FROM ?? "UrumTrader <onboarding@resend.dev>";

async function send(opts: { to: string; subject: string; html: string }): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn("[mailer] RESEND_API_KEY not set — skipping email:", opts.subject);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:    FROM_ADDRESS,
      to:      [opts.to],
      subject: opts.subject,
      html:    opts.html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Email send failed (${res.status}): ${body}`);
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = `${APP_URL}/auth/verify-email?token=${token}`;
  await send({
    to,
    subject: "Verify your UrumTrader email address",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#00D4AA">Welcome to UrumTrader</h2>
        <p>Thanks for registering. Click the button below to verify your email address and submit your application for review.</p>
        <a href="${link}" style="display:inline-block;padding:12px 24px;background:#00D4AA;color:#000;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0">
          Verify Email Address
        </a>
        <p style="color:#888;font-size:12px">Link expires in 24 hours. If you didn't create an account, ignore this email.</p>
        <p style="color:#888;font-size:12px">Or copy this link: ${link}</p>
      </div>
    `,
  });
}

export async function sendApprovalEmail(to: string, _vaultAddress?: string): Promise<void> {
  await send({
    to,
    subject: "Your UrumTrader account has been approved!",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#00D4AA">You're approved!</h2>
        <p>Your UrumTrader account has been reviewed and approved. You can now log in and start trading.</p>
        <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#00D4AA;color:#000;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0">
          Go to Dashboard
        </a>
        <p style="color:#888;font-size:12px">Once logged in, connect your MetaMask wallet, deposit USDC into your vault, and the bot will start trading automatically.</p>
      </div>
    `,
  });
}

export async function sendRejectionEmail(to: string): Promise<void> {
  await send({
    to,
    subject: "Update on your UrumTrader application",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#333">Application update</h2>
        <p>Thank you for your interest in UrumTrader. After reviewing your application, we're unable to approve your account at this time.</p>
        <p>If you believe this is an error or would like more information, please contact us at <a href="mailto:support@urumtrader.com">support@urumtrader.com</a>.</p>
      </div>
    `,
  });
}

export async function sendAdminNewUserAlert(newUserEmail: string): Promise<void> {
  if (!ADMIN_EMAIL) return;
  await send({
    to: ADMIN_EMAIL,
    subject: `New user registration: ${newUserEmail}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#00D4AA">New registration pending approval</h2>
        <p>A new user has verified their email and is awaiting approval:</p>
        <p><strong>Email:</strong> ${newUserEmail}</p>
        <a href="${APP_URL}/admin" style="display:inline-block;padding:12px 24px;background:#00D4AA;color:#000;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0">
          Review in Admin Dashboard
        </a>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${APP_URL}/auth/reset-password?token=${token}`;
  await send({
    to,
    subject: "Reset your UrumTrader password",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#00D4AA">Password Reset</h2>
        <p>We received a request to reset your password. Click the button below to proceed.</p>
        <a href="${link}" style="display:inline-block;padding:12px 24px;background:#00D4AA;color:#000;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0">
          Reset Password
        </a>
        <p style="color:#888;font-size:12px">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
        <p style="color:#888;font-size:12px">Or copy this link: ${link}</p>
      </div>
    `,
  });
}
