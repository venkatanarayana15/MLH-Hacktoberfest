// RxSafe Lens — follow-up reminder scheduler (prototype, in-memory).
//
// Two reminder kinds the patient actually needs:
//   refill       — "your course runs low in N days; buy before you run out"
//   doctor_visit — "your follow-up visit with Dr X is on <date>"
//
// A tick fires every REMINDER_TICK_MS and delivers anything that is due via
// lib/email. In-memory on purpose: a real deployment would put these rows in a
// database and hand them to a queue consumer (BullMQ / SQS / cron). Nothing here
// pretends to be durable — the prototype is explicit about that in the UI.

const REMINDER_TICK_MS = Number(process.env.REMINDER_TICK_MS || 30_000);
const MAX_REMINDERS = 200;

const reminders = [];
let timer = null;
const sending = new Set();

// A course of N days runs out on day N. We nudge the patient while there is
// still stock left to buy, and ask for a few days' slack so a pharmacy trip is
// actually possible before the last tablet.
const DEFAULT_REFILL_LEAD_DAYS = 3;

function iso(ts) {
  return new Date(ts).toISOString();
}

function queueReminder({ worksheetId, email, meds, ts, kind = 'refill', leadDays = DEFAULT_REFILL_LEAD_DAYS, dueAt = null, note = '', label = '' }) {
  if (!email) return null;

  let at;
  let resolvedKind = kind;
  let payloadMeds = [];

  if (kind === 'doctor_visit') {
    at = dueAt ? new Date(dueAt).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(at)) return null;
  } else {
    const list = Array.isArray(meds) ? meds.filter((m) => m && m.drug) : [];
    if (!list.length && !dueAt) return null;
    payloadMeds = list.map((m) => ({
      drug: m.drug,
      strength: m.strength,
      frequency: m.frequency,
      timing: m.timing,
      duration_days: typeof m.duration_days === 'number' ? m.duration_days : null
    }));
    if (dueAt) {
      at = new Date(dueAt).getTime();
      if (!Number.isFinite(at)) return null;
    } else {
      // Shortest course runs out first; nudge when that many days remain.
      const shortestDays = Math.min(30, ...payloadMeds.map((m) => (typeof m.duration_days === 'number' ? m.duration_days : 30)));
      const runOutIn = Math.max(0, shortestDays - leadDays) * 24 * 60 * 60 * 1000;
      at = Date.now() + runOutIn;
      resolvedKind = 'refill';
    }
  }

  const reminder = {
    id: `r-${kind}-${worksheetId || 'ad-hoc'}-${Date.now().toString(36)}`,
    kind: resolvedKind,
    worksheetId: worksheetId || null,
    email,
    meds: payloadMeds,
    note: String(note || '').slice(0, 400),
    label: String(label || '').slice(0, 120),
    at,
    born: ts || iso(Date.now()),
    fired: false,
    lastError: null
  };
  reminders.push(reminder);
  reminders.sort((a, b) => a.at - b.at);
  if (reminders.length > MAX_REMINDERS) reminders.splice(0, reminders.length - MAX_REMINDERS);
  return reminder;
}

function listReminders() {
  return reminders.map((r) => ({
    id: r.id,
    kind: r.kind,
    worksheetId: r.worksheetId,
    email: r.email,
    label: r.label,
    note: r.note,
    meds: r.meds,
    at: iso(r.at),
    born: r.born,
    fired: r.fired,
    lastError: r.lastError
  }));
}

function cancelReminder(id) {
  const i = reminders.findIndex((r) => r.id === id);
  if (i < 0) return false;
  reminders.splice(i, 1);
  return true;
}

function daysUntil(at) {
  return Math.max(0, Math.round((at - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Human-readable line for the reminder email and the UI list.
function describe(r) {
  if (r.kind === 'doctor_visit') {
    const when = new Date(r.at).toLocaleString();
    return `Follow-up visit reminder${r.label ? ` — ${r.label}` : ''} on ${when}.${r.note ? ` ${r.note}` : ''}`;
  }
  const names = r.meds.map((m) => `${m.drug}${m.strength ? ` ${m.strength}` : ''}`).join(', ');
  return `Refill reminder: your course (${names || 'your medicines'}) runs low in about ${daysUntil(r.at)} day(s). Buy before you run out.${r.note ? ` ${r.note}` : ''}`;
}

let emailHelper = null;
function getMailer() {
  if (emailHelper) return emailHelper;
  try {
    emailHelper = require('./email');
  } catch (e) {
    console.error('[schedule] email helper unavailable:', e.message);
    emailHelper = { send: async () => { throw new Error('EMAIL_UNAVAILABLE'); }, status: () => ({ configured: false, reason: 'EMAIL_UNAVAILABLE' }) };
  }
  return emailHelper;
}

async function sendReminderEmail(r) {
  const mailer = getMailer();
  const subject =
    r.kind === 'doctor_visit'
      ? 'RxSafe Lens — your follow-up visit is coming up'
      : 'RxSafe Lens — time to refill your medicines';
  const text = describe(r);
  const html =
    `<div style="font-family:Segoe UI,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#101329">` +
    `<h2 style="font-size:17px;margin:0 0 8px">${escapeHtml(subject)}</h2>` +
    `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(text)}</p>` +
    (r.meds.length
      ? `<table style="font-size:13px;border-collapse:collapse;width:100%"><thead><tr>` +
        `<th style="text-align:left;border-bottom:1px solid #e8eaf4;padding:6px 8px">Medicine</th>` +
        `<th style="text-align:left;border-bottom:1px solid #e8eaf4;padding:6px 8px">How often</th>` +
        `<th style="text-align:left;border-bottom:1px solid #e8eaf4;padding:6px 8px">Days</th></tr></thead><tbody>` +
        r.meds
          .map(
            (m) =>
              `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f3fa">${escapeHtml(m.drug || '')}${m.strength ? ` ${escapeHtml(m.strength)}` : ''}</td>` +
              `<td style="padding:6px 8px;border-bottom:1px solid #f1f3fa">${escapeHtml([m.frequency, m.timing].filter(Boolean).join(' · ') || '—')}</td>` +
              `<td style="padding:6px 8px;border-bottom:1px solid #f1f3fa">${m.duration_days ?? '—'}</td></tr>`
          )
          .join('') +
        `</tbody></table>`
      : '') +
    `<p style="font-size:11.5px;color:#5d6478;margin-top:16px">This is a reminder from your RxSafe Lens session. Decision-support only — this is not a clinical reference, not counterfeit detection. Confirm with your doctor or pharmacist before changing anything.</p>` +
    `</div>`;

  await mailer.send(r.email, subject, html, { kind: r.kind });
}

async function emitReminders(now = Date.now()) {
  const due = reminders.filter((r) => !r.fired && r.at <= now);
  const results = [];
  for (const r of due) {
    if (sending.has(r.id)) continue;
    sending.add(r.id);
    try {
      r.fired = true;
      await sendReminderEmail(r);
      r.lastError = null;
      results.push({ id: r.id, delivered: true });
    } catch (e) {
      // Delivery is best-effort: an SMTP outage must not lose the reminder, so
      // it stays unfired and we try again on the next tick.
      r.fired = false;
      r.lastError = e.message;
      console.error('[schedule] reminder delivery failed for', r.id, e.message);
      results.push({ id: r.id, delivered: false, error: e.message });
    } finally {
      sending.delete(r.id);
    }
  }
  return results;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function startRecurring() {
  if (timer) return timer;
  timer = setInterval(() => {
    emitReminders().catch((e) => console.error('[schedule] tick failed:', e.message));
  }, REMINDER_TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stopRecurring() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { queueReminder, listReminders, cancelReminder, emitReminders, startRecurring, stopRecurring, describe, daysUntil, REMINDER_TICK_MS };