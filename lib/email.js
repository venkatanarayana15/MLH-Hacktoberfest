// RxSafe Lens — email delivery (nodemailer, MIT).
//
// Three transports, in order of preference, all free / open source:
//
//  1. Real SMTP        — SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS in .env.
//                        (Anything that speaks SMTP, including a free tier.)
//  2. Ethereal         — nodemailer.createTestAccount() mints a throwaway
//                        inbox over real SMTP with no signup and no paid plan.
//                        Returns a preview URL so the demo can prove delivery.
//  3. Mailpit / Mailhog — a local OSS SMTP catcher on 127.0.0.1:1025, useful
//                        when running fully offline.
//
// Nothing here ever claims a mail was delivered unless a transport accepted it;
// `status()` reports which path is live so the UI can be honest.

const fs = require('fs');
const path = require('path');

// Minimal .env loader (process env still wins).
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, '').trim();
      if (val && !process.env[m[1]]) process.env[m[1]] = val;
    }
  }
} catch {
  /* no .env — fine */
}

let cached = null; // { kind, transporter, from, account }

function nodemailerOrNull() {
  try {
    return require('nodemailer');
  } catch {
    return null;
  }
}

async function build() {
  if (cached) return cached;
  const nm = nodemailerOrNull();
  if (!nm) {
    cached = { kind: 'none', transporter: null, reason: 'nodemailer is not installed — run `npm install nodemailer`' };
    return cached;
  }

  const host = process.env.SMTP_HOST || '';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  if (host && user && pass) {
    cached = {
      kind: 'smtp',
      host,
      transporter: nm.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000
      }),
      from: process.env.SMTP_FROM || `RxSafe Lens <${user}>`
    };
    return cached;
  }

  // Free OSS fallback: an Ethereal test inbox, minted on first use. Real SMTP
  // handshakes, no account to create, no card, and a preview URL to prove it.
  if (process.env.ETHEREAL === '0') {
    cached = { kind: 'mailpit', transporter: nm.createTransport({ host: '127.0.0.1', port: 1025, secure: false, ignoreTLS: true }), from: 'RxSafe Lens <noreply@rxsafe.local>' };
    return cached;
  }
  try {
    const account = await nm.createTestAccount();
    cached = {
      kind: 'ethereal',
      account,
      nm,
      transporter: nm.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: { user: account.user, pass: account.pass }
      }),
      from: `RxSafe Lens <${account.user}>`
    };
    console.log(`[email] Ethereal test inbox ready: ${account.user}`);
  } catch (e) {
    cached = {
      kind: 'mailpit',
      transporter: nm.createTransport({ host: '127.0.0.1', port: 1025, secure: false, ignoreTLS: true }),
      from: 'RxSafe Lens <noreply@rxsafe.local>',
      reason: `Ethereal unavailable (${e.message.slice(0, 80)}) — falling back to a local Mailpit/MailHog catcher on 127.0.0.1:1025`
    };
  }
  return cached;
}

async function send(to, subject, bodyHtml, opts = {}) {
  const cfg = await build();
  if (!cfg.transporter) throw new Error(`EMAIL_NOT_CONFIGURED: ${cfg.reason || 'no transport available'}`);
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) throw new Error('INVALID_EMAIL_ADDRESS');
  const html = String(bodyHtml || '');
  const info = await cfg.transporter.sendMail({
    from: cfg.from,
    to: String(to),
    subject: String(subject || 'RxSafe Lens'),
    text: html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim(),
    html,
    headers: opts.kind ? { 'X-RxSafe-Kind': String(opts.kind) } : undefined
  });
  // nodemailer 10 returns no previewUrl, and Ethereal's hosted web/API is not
  // reachable from every network — so we do not fake a link. We return the real
  // SMTP acceptance facts and the rendered HTML, and the UI shows the exact
  // message that was handed to the mail server.
  return {
    ok: true,
    transport: cfg.kind,
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted : [to],
    html,
    note:
      cfg.kind === 'ethereal'
        ? 'Accepted by a free Ethereal test inbox over real SMTP (no real mailbox involved). The exact message that was sent is shown below.'
        : cfg.kind === 'mailpit'
          ? 'Accepted by a local Mailpit/MailHog catcher — view it at http://127.0.0.1:8025 if Mailpit is running.'
          : 'Delivered over the configured SMTP relay.'
  };
}

async function status() {
  const cfg = await build();
  return {
    configured: Boolean(cfg.transporter),
    transport: cfg.kind,
    from: cfg.from || null,
    reason: cfg.reason || null
  };
}

module.exports = { send, status };