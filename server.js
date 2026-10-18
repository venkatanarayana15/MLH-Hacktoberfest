// RxSafe Lens server — Express API + static UI.
// Modes: LIVE (Gemma via Gemini API reading the prescription image) and
// CACHED (three synthetic slips with pre-run worksheets, offline-safe).
//
// It also reads an existing-medicine photo (the second image modality) and
// stamps every worksheet with a short content-integrity hash.
//
// RxSafe Lens does not dispense, diagnose, or detect counterfeits. It produces a
// worksheet a pharmacist must verify. Every response carries that boundary.

const express = require('express');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const { nanoid } = require('nanoid');
const crypto = require('crypto');

// Tiny zero-dependency .env loader, so `npm start` works as documented.
// Real environment variables always win over file values.
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
      }
    }
  } catch {
    /* no .env file — cached mode or externally-provided env */
  }
})();

const rxgemini = require('./lib/rxgemini');
const { runRxRules, clampThreshold } = require('./lib/rxrules');
const { SAMPLES, getSample, STRIPS, getStrip } = require('./lib/rxsamples');
const { DISCLAIMER } = require('./lib/formulary');
const mediagent = require('./lib/mediagent');
const sarvam = require('./lib/sarvam');
const cognee = require('./lib/cognee');
const mailer = require('./lib/email');

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false })); // demo UI needs inline styles from vendor libs
app.use(morgan('tiny'));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Protect the AI endpoints from accidental request storms (each live call costs
// quota and tens of seconds). Generous for a counter demo, strict enough to
// stop a runaway client.
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — wait a minute and try again.' }
  })
);

// Local audit trail of every worksheet (id, mode, readiness, flag counts).
// Prototype-grade file storage; a production build would use a real DB.
const AUDIT_DIR = path.join(__dirname, 'data');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.json');

function readAudit() {
  try {
    const arr = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAudit(entry) {
  try {
    const list = readAudit();
    list.unshift(entry);
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(list.slice(0, 100), null, 2));
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
}

const GUARDRAIL = 'Decision-support only. Not a clinical reference and not counterfeit detection. The pharmacist must verify and approve before dispensing.';

// Every worksheet gets a short content hash over what was actually shown: the
// read medications, the flags, the review bar and the photographed existing
// medicines. Same content -> same id; any change -> a new id. It is a
// traceability aid a pharmacy could log — not a signature or a legal record.
function integrityOf(ws, opts) {
  const canon = JSON.stringify({
    prescription_id: ws.prescription_id || null,
    readiness: ws.readiness || null,
    meds: (ws.extracted_medications || []).map((m) => [m.drug, m.strength, m.frequency, m.confidence]),
    flags: (ws.safety_flags || []).map((f) => [f.type, f.severity]),
    threshold: clampThreshold(opts.threshold),
    existing: (opts.existingMeds || []).map((e) => e.drug)
  });
  return {
    hash: `RXS-${crypto.createHash('sha256').update(canon).digest('hex').slice(0, 8).toUpperCase()}`,
    generated_at: new Date().toISOString(),
    algorithm: 'sha256 over canonical worksheet JSON'
  };
}

app.get('/api/mode', (req, res) => {
  res.json({ live: rxgemini.isLive(), model: rxgemini.isLive() ? rxgemini.currentModel() : null, disclaimer: GUARDRAIL });
});

app.get('/api/samples', (req, res) => {
  res.json(
    SAMPLES.map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      contextText: s.contextText,
      imageUrl: `/samples/${s.id}.png`,
      handwriting: s.handwriting_lines
    }))
  );
});

app.get('/api/strips', (_req, res) => {
  res.json(STRIPS.map((s) => ({ id: s.id, label: s.label, imageUrl: s.imageUrl })));
});

// ---- Existing-medicine photo (the second image modality) -------------------
// The patient says "a medicine for blood pressure". This endpoint reads the
// strip/box photo and names the drug, which is what lets the deterministic
// layer check against a named existing medicine instead of an unknown.

app.post('/api/read-medicine', async (req, res) => {
  const { imageBase64, imageMime, stripId } = req.body || {};
  if (!imageBase64 && !stripId) {
    return res.status(400).json({ error: 'Attach a medicine photo or use the demo strip.' });
  }
  if (rxgemini.isLive() && imageBase64) {
    try {
      const read = await rxgemini.readMedicine({ imageBase64, imageMime });
      return res.json({ mode: 'live', read, disclaimer: GUARDRAIL });
    } catch (e) {
      console.error('[read-medicine] live failed:', e.message);
      const strip = getStrip(stripId);
      if (strip) {
        return res.json({
          mode: 'cached-fallback',
          read: strip.read,
          note: `Live strip read unavailable (${e.message.slice(0, 80)}). Showing the demo strip's prepared reading.`,
          disclaimer: GUARDRAIL
        });
      }
      return res.status(502).json({ error: `Reading the medicine photo failed: ${e.message}` });
    }
  }
  const strip = getStrip(stripId);
  if (strip) {
    return res.json({ mode: 'cached', read: strip.read, note: 'Prepared reading for the bundled demo strip.', disclaimer: GUARDRAIL });
  }
  return res.status(503).json({ error: 'Reading an uploaded photo needs GEMINI_API_KEY. Use the demo strip instead.' });
});

// ---- Document extraction (PDF / image) for the copilot drawer ---------------

app.post('/api/extract-doc', async (req, res) => {
  const { fileBase64, fileMime } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: 'Attach a document or image first.' });
  if (!rxgemini.isLive()) {
    return res.status(501).json({ error: 'Document extraction needs GEMINI_API_KEY. Try a different question instead — text mode still works fully.' });
  }
  try {
    const text = await rxgemini.extractDoc({ fileBase64, fileMime });
    return res.json({ ok: true, plain: text.plain || '', drugs: text.drugs || [], disclaimer: GUARDRAIL });
  } catch (e) {
    console.error('[extract-doc]', e.message);
    return res.status(502).json({ error: `Extracting the document failed: ${e.message.slice(0, 160)}` });
  }
});

// ---- Audit trail (local append-only worksheet log) -------------------------

app.get('/api/audit', (_req, res) => {
  res.json({ entries: readAudit().slice(0, 20), storage: 'data/audit.json (local prototype trail)' });
});

app.post('/api/stt', async (req, res) => {
  const { audioBase64, mime, languageCode } = req.body || {};
  if (!audioBase64) return res.status(400).json({ error: 'No audio received.' });
  if (!sarvam.isLive()) {
    return res.status(501).json({ error: 'Voice input needs SARVAM_API_KEY in .env. Type the question instead — text mode works fully.' });
  }
  try {
    const out = await sarvam.stt(audioBase64, mime || 'audio/webm', languageCode);
    res.json(out);
  } catch (e) {
    console.error('[stt]', e.message);
    res.status(502).json({ error: `Voice transcription failed: ${e.message.slice(0, 140)}` });
  }
});

const PORT = process.env.PORT || 3000;

// ---- Follow-up scheduler + reminder email ----------------------------------
// `schedule.emitReminders` is called from a tiny interval timer in server.js so
// the prototype can prove the flow end-to-end without any job queue. In a real
// deployment this would be a persistent job store + cron / queue consumer.
const schedule = require('./lib/schedule');

// Every worksheet also becomes a persisted summary the copilot can discuss.
const SUMMARY_DIR = path.join(__dirname, 'data');
const SUMMARY_FILE = path.join(SUMMARY_DIR, 'summaries.json');

function readSummaries() {
  try {
    const arr = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeSummaries(list) {
  try {
    fs.mkdirSync(SUMMARY_DIR, { recursive: true });
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(list.slice(0, 200), null, 2));
  } catch (e) {
    console.error('[summaries] write failed:', e.message);
  }
}

let lastBornTs = 0;

function maybeEmitReminders() {
  const now = Date.now();
  if (now - lastBornTs < 10_000) return;
  lastBornTs = now;
  try {
    schedule.emitReminders();
  } catch (e) {
    console.error('[schedule] reminder tick failed:', e.message);
  }
}

setInterval(maybeEmitReminders, 30_000);

app.post('/api/analyze-rx', async (req, res) => {
  const { sampleId, imageBase64, imageMime, contextText, threshold, existingMeds, email } = req.body || {};
  const ctx = String(contextText || '').trim();
  const opts = {
    threshold: typeof threshold === 'number' ? threshold : undefined,
    existingMeds: Array.isArray(existingMeds) ? existingMeds : [],
    email: String(email || '').trim()
  };
  if (!sampleId && !imageBase64) {
    return res.status(400).json({ error: 'Upload a prescription image or pick one of the synthetic samples.' });
  }
  const sample = getSample(sampleId);
  const effectiveCtx = ctx || (sample ? sample.contextText : '');

  const buildResponse = (mode, worksheet, extraction, note, emailSent) => {
    const meds =
      (worksheet && (worksheet.extracted_medications || worksheet.medications)) ||
      (extraction && (extraction.extracted_medications || extraction.medications)) ||
      [];
    const deterministic = runRxRules({ medications: meds }, effectiveCtx, opts);
    const namedExisting = (opts.existingMeds || []).some((e) => e && e.drug);
    const modelFlagsRaw = (worksheet && worksheet.safety_flags) || [];
    const modelFlags =
      namedExisting && mode !== 'live'
        ? modelFlagsRaw.filter((f) => f.type !== 'existing_medicine_unnamed')
        : modelFlagsRaw;
    const merged = [
      ...deterministic.map((d) => ({
        type: d.id,
        severity: d.severity,
        message: d.label,
        why: d.why,
        action: d.action,
        source: 'deterministic_check'
      })),
      ...modelFlags.map((f) => ({ ...f, source: f.source || 'gemma_reading' }))
    ];
    const core = { ...worksheet, safety_flags: merged, disclaimer: GUARDRAIL };
    const integrity = integrityOf(core, opts);
    const worksheetId = integrity.hash;

    writeAudit({
      request_id: nanoid(8),
      worksheet_id: worksheetId,
      ts: new Date().toISOString(),
      mode,
      sample_id: sampleId || null,
      readiness: core.readiness || null,
      meds: meds.map((m) => m.drug).filter(Boolean).slice(0, 6),
      flags_total: merged.length,
      flags_high: merged.filter((f) => f.severity === 'high').length,
      schema_valid: core.schema_valid === undefined ? null : core.schema_valid,
      emailDest: opts.email || null
    });

    // Persist a compact summary the copilot can discuss later.
    const summary = {
      id: worksheetId,
      ts: new Date().toISOString(),
      mode,
      sampleId: sampleId || null,
      email: opts.email || null,
      context: effectiveCtx,
      meds: meds.map((m) => ({ drug: m.drug, strength: m.strength, frequency: m.frequency, timing: m.timing, duration_days: m.duration_days, confidence: m.confidence })),
      flags: merged.map((f) => ({ type: f.type, severity: f.severity, message: f.message })),
      readiness: core.readiness
    };
    const list = readSummaries();
    list.unshift(summary);
    writeSummaries(list);

    // Schedule a follow-up reminder from the worksheet so the pharmacist can
    // ask the patient to come back and pick up / refill when the course runs low.
    if (opts.email && meds.length) {
      // queueReminder is synchronous and returns the stored reminder (or null)
      // — it is NOT a promise, so it must never be `.catch`-ed.
      try {
        schedule.queueReminder({
          worksheetId,
          email: opts.email,
          meds,
          kind: 'refill',
          leadDays: 3,
          ts: new Date().toISOString(),
          note: 'Scheduled when the worksheet was generated.'
        });
      } catch (e) {
        console.error('[schedule] queue failed:', e.message);
      }
    }

    return {
      mode,
      sampleId: sampleId || null,
      worksheet_id: worksheetId,
      contextText: effectiveCtx,
      existingMeds: opts.existingMeds,
      review_threshold: clampThreshold(opts.threshold),
      extraction: extraction || { extracted_medications: meds },
      deterministic,
      worksheet: core,
      integrity,
      formularyDisclaimer: DISCLAIMER,
      note: note || null,
      emailSent: emailSent || false
    };
  };

  if (rxgemini.isLive() && imageBase64) {
    // Wall-clock budget for a live read. Two passes, each already bounded by
    // the per-call timeout; this is the outer belt so the UI gets a definite
    // answer instead of an open-ended spinner.
    const LIVE_BUDGET_MS = Number(process.env.ANALYZE_BUDGET_MS || 90_000);
    const liveRead = (async () => {
      const worksheet = await rxgemini.analyzeRx({
        imageBase64,
        imageMime,
        contextText: effectiveCtx,
        deterministicFindings: []
      });
      const meds = (worksheet.extracted_medications || []).map((m) => ({
        drug: m.drug,
        strength: m.strength,
        frequency: m.frequency,
        timing: m.timing,
        duration_days: m.duration_days,
        confidence: m.confidence,
        ambiguity: m.ambiguity
      }));
      const det = runRxRules({ medications: meds }, effectiveCtx, opts);
      const second = await rxgemini.analyzeRx({ imageBase64, imageMime, contextText: effectiveCtx, deterministicFindings: det });
      return buildResponse('live', second, { extracted_medications: meds }, null, false);
    })();
    const budget = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Live reading exceeded ${Math.round(LIVE_BUDGET_MS / 1000)}s budget.`)), LIVE_BUDGET_MS)
    );
    try {
      const result = await Promise.race([liveRead, budget]);
      return res.json(result);
    } catch (e) {
      console.error('[analyze-rx] live failed:', e.message);
      if (sample) {
        return res.json(
          buildResponse(
            'cached-fallback',
            sample.worksheet,
            sample.extraction,
            `Live reading unavailable (${e.message.slice(0, 80)}). Showing the pre-run worksheet for this synthetic slip.`,
            false
          )
        );
      }
      return res.status(502).json({ error: `Live reading failed: ${e.message}` });
    }
  }

  if (sample) {
    return res.json(
      buildResponse('cached', sample.worksheet, sample.extraction,
        rxgemini.isLive()
          ? 'No image uploaded, so the pre-run worksheet for this synthetic slip is shown.'
          : 'Pre-run worksheet from a synthetic slip (no GEMINI_API_KEY configured).',
        false
      )
    );
  }

  return res.status(503).json({ error: 'No API key configured and no synthetic sample selected. Pick a sample or add GEMINI_API_KEY.' });
});

// ---- Send the worksheet as a reminder / copy email ------------------------
app.post('/api/email', async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to) return res.status(400).json({ error: 'An email address is required.' });
  let emailStatus;
  try {
    emailStatus = await mailer.status();
  } catch (e) {
    emailStatus = { configured: false, reason: e.message };
  }
  if (!emailStatus.configured) {
    return res.status(503).json({
      error: `Email is not configured yet: ${emailStatus.reason || 'no transport available'}`,
      hint: 'Run `npm install nodemailer` and/or set SMTP_HOST / SMTP_USER / SMTP_PASS in .env.'
    });
  }
  try {
    const sent = await mailer.send(to, subject || 'RxSafe Lens — dispensing worksheet', body || '');
    return res.json({ ok: true, transport: sent.transport, previewUrl: sent.previewUrl, note: sent.note });
  } catch (e) {
    console.error('[email]', e.message);
    return res.status(502).json({ error: `Sending the email failed: ${e.message.slice(0, 160)}` });
  }
});

app.get('/api/schedule', (_req, res) => {
  res.json({
    reminders: schedule.listReminders(),
    notes: [
      'This is a local prototype store — reminders persist in memory only while the server is running.',
      'Configure SMTP_HOST / SMTP_USER / SMTP_PASS in .env for reminder emails to leave this machine.'
    ]
  });
});

// ---- Follow-up scheduler: patient visit + refill reminder -----------------
// The worksheet panel sends what the pharmacist agreed with the patient: the
// review date, how many days before running out to nudge, and an email. Both
// become explicit reminders with a human-readable description, so the UI never
// has to guess what was scheduled.
app.post('/api/schedule', async (req, res) => {
  const { worksheetId, email, meds, visitDate, refillDaysBefore, note } = req.body || {};
  const to = String(email || '').trim();
  if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return res.status(400).json({ error: 'That email address does not look valid — check it, or leave it blank for an in-app reminder.' });
  }
  const list = Array.isArray(meds) ? meds.filter((m) => m && m.drug) : [];
  const lead = Number.isFinite(Number(refillDaysBefore)) ? Math.max(0, Math.min(30, Number(refillDaysBefore))) : 3;
  const created = [];
  try {
    if (visitDate) {
      const visit = schedule.queueReminder({
        worksheetId,
        email: to || null,
        meds: list,
        kind: 'doctor_visit',
        dueAt: `${String(visitDate).slice(0, 10)}T09:00:00`,
        label: 'Pharmacist follow-up',
        note: String(note || '').slice(0, 300)
      });
      if (visit) created.push(visit);
    }
    if (list.length) {
      const refill = schedule.queueReminder({
        worksheetId,
        email: to || null,
        meds: list,
        kind: 'refill',
        leadDays: lead,
        note: String(note || '').slice(0, 300)
      });
      if (refill) created.push(refill);
    }
  } catch (e) {
    console.error('[schedule] create failed:', e.message);
    return res.status(500).json({ error: `Could not schedule the reminder: ${e.message.slice(0, 140)}` });
  }
  if (!created.length) {
    return res.status(400).json({ error: 'Nothing to schedule — read a prescription first (and pick a revisit date or a refill lead time).' });
  }
  let emailStatus = { configured: false, transport: 'none' };
  try {
    emailStatus = await mailer.status();
  } catch {
    /* status is best-effort */
  }
  return res.json({
    ok: true,
    reminders: created.map((r) => ({
      id: r.id,
      kind: r.kind,
      at: new Date(r.at).toISOString(),
      inDays: schedule.daysUntil(r.at),
      email: r.email,
      description: schedule.describe(r)
    })),
    email: { configured: Boolean(emailStatus.configured), transport: emailStatus.transport, reason: emailStatus.reason || null },
    disclaimer: GUARDRAIL
  });
});

app.delete('/api/schedule/:id', (req, res) => {
  const removed = schedule.cancelReminder(req.params.id);
  if (!removed) return res.status(404).json({ error: 'No such reminder.' });
  res.json({ ok: true });
});

app.post('/api/schedule/tick', async (_req, res) => {
  try {
    res.json({ results: await schedule.emitReminders() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- MediPilot: the counter discussion copilot (G3: audio + text) ---------

const COPILOT_GUARD = 'MediPilot is a discussion aid for the pharmacist. No diagnosis, no prescribing, no dispensing approval. Confirm with the pharmacist or doctor.';

app.get('/api/copilot/languages', async (_req, res) => {
  let mem = { mode: 'local', cognee: { configured: false, reachable: false }, local: { entries: 0 } };
  try {
    mem = await cognee.status();
  } catch (e) {
    console.error('[memory status]', e.message);
  }
  res.json({ languages: sarvam.LANGS, voice: sarvam.isLive(), kb_docs: mediagent.KB_COUNT, summaries: readSummaries().length, memory: mem });
});

app.get('/api/memory', async (_req, res) => {
  try {
    res.json(await cognee.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/summaries', (_req, res) => {
  res.json({ summaries: readSummaries() });
});

app.post('/api/copilot', async (req, res) => {
  const { question, languageCode, patientContext, speak, summaryRef } = req.body || {};
  const q = String(question || '').trim();
  if (!q) return res.status(400).json({ error: 'Ask a question (typed or dictated).' });
  try {
    const out = await mediagent.run({
      question: q,
      languageCode: languageCode || 'en-IN',
      patientContext,
      summaryRef
    });
    let audioBase64 = null;
    if (speak && sarvam.isLive()) {
      try {
        audioBase64 = await sarvam.tts(out.answer, languageCode || 'en-IN');
      } catch (e) {
        console.error('[copilot tts]', e.message);
      }
    }
    res.json({ ...out, audioBase64, languageCode: languageCode || 'en-IN', disclaimer: `${mediagent.DISC} ${COPILOT_GUARD}` });
  } catch (e) {
    console.error('[copilot]', e.message);
    res.status(502).json({ error: `MediPilot could not answer: ${e.message.slice(0, 140)}` });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text, languageCode } = req.body || {};
  if (!text) return res.status(400).json({ error: 'No text to speak.' });
  if (!sarvam.isLive()) return res.status(501).json({ error: 'Voice output needs SARVAM_API_KEY in .env.' });
  try {
    res.json({ audioBase64: await sarvam.tts(text, languageCode) });
  } catch (e) {
    console.error('[tts]', e.message);
    res.status(502).json({ error: `Speech generation failed: ${e.message.slice(0, 140)}` });
  }
});

// ===========================================================================
// Patient side: upload a document/photo -> read it -> explain it -> discuss it
// -> email the report -> schedule follow-ups. Voice in, voice out throughout.
// ===========================================================================
const ragstore = require('./lib/ragstore');
const reportLib = require('./lib/report');

const REPORTS_DIR = path.join(__dirname, 'data', 'reports');

function readReports() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, 'index.json'), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeReport(rec) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const list = readReports().filter((r) => r.id !== rec.id);
  list.unshift(rec);
  fs.writeFileSync(path.join(REPORTS_DIR, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  fs.writeFileSync(path.join(REPORTS_DIR, 'index.json'), JSON.stringify(list.slice(0, 40), null, 2));
}

// Which model reads uploads vs which model explains them.
app.get('/api/patient/config', async (_req, res) => {
  const mail = await mailer.status().catch(() => ({ configured: false, transport: 'none' }));
  res.json({
    extract_model: rxgemini.isLive() ? rxgemini.extractModel() : null,
    explain_model: rxgemini.isLive() ? rxgemini.currentModel() : null,
    live: rxgemini.isLive(),
    voice: { stt: sarvam.isLive(), tts: sarvam.isLive(), languages: sarvam.LANGS },
    mail,
    documents: ragstore.listDocs().length,
    reminders: schedule.listReminders().length,
    disclaimer: GUARDRAIL
  });
});

// 1) Upload -> read the document with the extraction model, store it, index it.
app.post('/api/patient/upload', async (req, res) => {
  const { fileBase64, fileMime, fileName, text, have = [], wantExplanation = false } = req.body || {};
  if (!fileBase64 && !text) return res.status(400).json({ error: 'Attach a photo, PDF, or paste the text of your document.' });

  // Timings are returned to the UI so "it feels slow" can always be answered
  // with a number instead of a shrug.
  const t0 = Date.now();
  const timings = {};
  let extraction;
  if (text && !fileBase64) {
    extraction = { model: 'text', raw_text: String(text).slice(0, 20000), document_type: 'text', medicines: [], notes: null };
    timings.extract_ms = 0;
  } else {
    const t = Date.now();
    try {
      extraction = await rxgemini.extractDocument({ imageBase64: fileBase64, imageMime: fileMime, text });
    } catch (e) {
      console.error('[patient/upload] read failed:', e.message);
      return res.status(502).json({ error: `Could not read that document: ${e.message.slice(0, 160)}` });
    }
    timings.extract_ms = Date.now() - t;
  }

  const doc = ragstore.saveDoc({
    name: fileName || 'uploaded document',
    kind: extraction.document_type || 'document',
    mime: fileMime || 'text/plain',
    text: extraction.raw_text || text || '',
    drugs: extraction.medicines || [],
    imageBase64: fileBase64 || null,
    extraction: {
      rawText: extraction.raw_text,
      medicines: extraction.medicines,
      notes: extraction.notes,
      prescriber: extraction.prescriber,
      date: extraction.date,
      followUpDate: extraction.follow_up_date,
      followUpAdvice: extraction.follow_up_advice
    },
    meta: { model: extraction.model, prescriber: extraction.prescriber, date: extraction.date, follow_up_date: extraction.follow_up_date }
  });

  // The plain-language pass is deliberately NOT part of this request unless the
  // caller asks: waiting for it is what made an upload feel like 45 seconds.
  // The UI renders the read immediately and fetches /api/patient/explain next.
  let explanation = null;
  let explainError = null;
  if (wantExplanation === true && rxgemini.isLive() && extraction.medicines && extraction.medicines.length) {
    const t = Date.now();
    try {
      explanation = await rxgemini.explainForPatient({ extraction, have });
    } catch (e) {
      // The read still stands: the report renders from what was read, and the
      // UI says plainly that the plain-word pass did not finish.
      console.error('[patient/upload] explain failed:', e.message);
      explainError = e.message.slice(0, 120);
    }
    timings.explain_ms = Date.now() - t;
  }
  timings.total_ms = Date.now() - t0;

  res.json({
    doc: { id: doc.id, name: doc.name, kind: doc.kind, chars: doc.chars, chunks: doc.chunks.length },
    extraction,
    explanation,
    explain_error: explainError,
    timings,
    model_split: { read_by: extraction.model, explained_by: explanation ? explanation.model : null },
    next: { explain: `/api/patient/explain` }
  });
});

// Plain-language pass, on its own request so the read is never held hostage by
// it. Cached per document: re-opening a document must not pay for it twice.
const EXPLAIN_FILE = path.join(__dirname, "data", "explanations.json");

function readExplanations() {
  try {
    const j = JSON.parse(fs.readFileSync(EXPLAIN_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeExplanation(docId, payload) {
  try {
    const all = readExplanations();
    all[docId] = payload;
    const ids = Object.keys(all).slice(-60);
    const trimmed = {};
    ids.forEach((id) => { trimmed[id] = all[id]; });
    fs.mkdirSync(path.dirname(EXPLAIN_FILE), { recursive: true });
    fs.writeFileSync(EXPLAIN_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.error('[explain] cache write failed:', e.message);
  }
}

app.get('/api/patient/explain/:docId', (req, res) => {
  const cached = readExplanations()[req.params.docId] || null;
  res.json({ explanation: cached, cached: Boolean(cached) });
});

app.post('/api/patient/explain', async (req, res) => {
  const { docId, have = [], refresh = false } = req.body || {};
  const doc = docId ? ragstore.getDoc(docId) : null;
  if (!doc) return res.status(404).json({ error: 'Upload a document first.' });
  if (!refresh) {
    const cached = readExplanations()[docId];
    if (cached) return res.json({ explanation: cached, cached: true, timings: { total_ms: 0 } });
  }
  if (!rxgemini.isLive()) {
    return res.status(503).json({ error: 'Plain-language explanation needs an API key. The read itself is below.' });
  }
  const extraction = {
    raw_text: doc.text,
    document_type: doc.kind,
    prescriber: doc.meta && doc.meta.prescriber,
    date: doc.meta && doc.meta.date,
    follow_up_date: doc.meta && doc.meta.follow_up_date,
    medicines: doc.drugs || []
  };
  const t = Date.now();
  try {
    const explanation = await rxgemini.explainForPatient({ extraction, have });
    writeExplanation(docId, explanation);
    return res.json({ explanation, cached: false, timings: { total_ms: Date.now() - t } });
  } catch (e) {
    console.error('[patient/explain]', e.message);
    return res.status(502).json({
      error: `The plain-word explanation did not finish (${e.message.slice(0, 120)}). The read below is unaffected.`,
      timings: { total_ms: Date.now() - t }
    });
  }
});

app.get('/api/patient/docs', (_req, res) => {
  res.json({ docs: ragstore.listDocs() });
});

// What the retrieval layer actually holds, for the dashboard's RAG panel.
app.get('/api/patient/rag', async (_req, res) => {
  const docs = ragstore.listDocs();
  let turns = 0;
  for (const d of docs) turns += readChat(d.id).filter((t) => t.role === 'user').length;
  let memory = { configured: false, reachable: false, mode: 'local' };
  try {
    const st = await cognee.status();
    memory = { configured: st.cognee.configured, reachable: st.cognee.reachable, mode: st.mode };
  } catch { /* memory is optional */ }
  res.json({
    documents: docs.length,
    chunks: docs.reduce((n, d) => n + (d.chunks || 0), 0),
    questions: turns,
    top_k: ragstore.TOP_K,
    docs: docs.slice(0, 4).map((d) => ({
      id: d.id,
      name: d.name,
      chunks: d.chunks,
      chars: d.chars,
      drugs: d.drugs,
      uploaded_at: d.uploaded_at
    })),
    memory,
    retrieval: 'lexical top-k over your uploaded document (no external vector DB)',
    disclaimer: GUARDRAIL
  });
});

app.get('/api/patient/doc/:id', (req, res) => {
  const doc = ragstore.getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.json({ doc: { id: doc.id, name: doc.name, kind: doc.kind, chars: doc.chars, text: doc.text, drugs: doc.drugs, meta: doc.meta } });
});

app.delete('/api/patient/doc/:id', (req, res) => {
  res.json({ deleted: ragstore.deleteDoc(req.params.id) });
});

// 2) Build the plain-language report from an upload (+ optional "what I already have").
app.post('/api/patient/report', async (req, res) => {
  const { docId, have = [], notes = '' } = req.body || {};
  const doc = docId ? ragstore.getDoc(docId) : null;
  if (!doc && !notes) return res.status(400).json({ error: 'Upload a document first, or add a note.' });

  const extraction = {
    raw_text: doc ? doc.text : '',
    medicines: doc ? doc.drugs : [],
    prescriber: doc && doc.meta ? doc.meta.prescriber : null,
    date: doc && doc.meta ? doc.meta.date : null,
    follow_up_date: doc && doc.meta ? doc.meta.follow_up_date : null
  };

  let explanation = null;
  if (rxgemini.isLive() && extraction.medicines.length) {
    try {
      explanation = await rxgemini.explainForPatient({ extraction, have });
    } catch (e) {
      console.error('[patient/report] explain failed:', e.message);
    }
  }

  const report = reportLib.buildReport({
    docId: doc ? doc.id : 'adhoc',
    doc: doc ? { id: doc.id, name: doc.name, kind: doc.kind, chars: doc.chars, uploaded_at: doc.meta && doc.meta.uploaded_at } : null,
    meds: extraction.medicines,
    notes: notes || (explanation ? explanation.plain_summary : ''),
    source: 'patient_upload'
  });

  // Splice the model's plain-language cards in, keeping our deterministic cards
  // as the floor so a model hiccup can never empty the report.
  if (explanation) {
    report.plain_summary = explanation.plain_summary;
    report.need_to_buy = explanation.need_to_buy;
    report.already_have = explanation.already_have;
    report.next_visit = explanation.next_visit;
    report.questions_for_doctor = explanation.questions && explanation.questions.length ? explanation.questions : report.questions_for_doctor;
    report.warning_lines = explanation.warning_lines;
    for (const card of report.medicines) {
      const m = explanation.per_medicine.find((x) => x.drug && card.name.toLowerCase().includes(x.drug.toLowerCase()));
      if (m) {
        if (m.what_it_is_for) card.cards.push({ label: 'In plain words', value: m.what_it_is_for, tone: 'info' });
        if (m.how_to_take_it) card.cards.push({ label: 'How to take it', value: m.how_to_take_it, tone: 'ok' });
        if (m.look_out_for) card.cards.push({ label: 'Be careful', value: m.look_out_for, tone: 'warn' });
      }
    }
  }

  const rec = {
    id: report.id,
    ts: report.generated_at,
    doc_id: doc ? doc.id : null,
    doc_name: doc ? doc.name : 'note',
    email: null,
    transport: null,
    reminders: [],
    report
  };
  writeReport(rec);

  res.json({
    report,
    html: reportLib.reportToHtml(report),
    text: reportLib.reportToText(report),
    have,
    explained_by: explanation ? explanation.model : null
  });
});

// 3) Email the report. Free/open transports only: real SMTP, else an auto
//    Ethereal test inbox, else a local Mailpit/MailHog catcher.
app.post('/api/patient/report/email', async (req, res) => {
  const { reportId, to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Enter the email address to send the report to.' });
  const list = readReports();
  const rec = reportId ? list.find((r) => r.id === reportId) : list[0];
  if (!rec) return res.status(404).json({ error: 'Generate a report first.' });

  const html = reportLib.reportToHtml(rec.report);
  try {
    const sent = await mailer.send(to, `Your medicines report — ${rec.doc_name}`, html, { kind: 'report' });
    rec.email = to;
    rec.transport = sent.transport;
    writeReport(rec);
    return res.json({ ok: true, ...sent });
  } catch (e) {
    console.error('[patient/report/email]', e.message);
    return res.status(502).json({ error: `Could not send the report: ${e.message.slice(0, 160)}` });
  }
});

// 4) Discuss the upload. Retrieval runs over the patient's own document first,
//    then the demo formulary; the model must cite what it used. The thread is
//    remembered per document so later answers build on earlier questions.
const CHATS_DIR = path.join(__dirname, 'data', 'chats');

function chatFile(docId) {
  return path.join(CHATS_DIR, `${String(docId || 'adhoc').replace(/[^\w-]/g, '_')}.json`);
}

function readChat(docId) {
  try {
    const arr = JSON.parse(fs.readFileSync(chatFile(docId), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function appendChat(docId, turn) {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  const list = readChat(docId);
  list.push({ ts: new Date().toISOString(), ...turn });
  fs.writeFileSync(chatFile(docId), JSON.stringify(list.slice(-60), null, 2));
}

// Reasoning models like to narrate their own instructions back ("* User
// Question: … * Constraint Checklist & Confidence Score: …"). A patient must
// never see that working-out. Keep only the plain prose segments of the reply.
function stripScaffold(a) {
  const t = String(a || '').trim();
  const bad = /^(user question|question:|the user|context|constraint checklist|constraints?|confidence score|chain of thought|scratchpad|analysis|my task|task|final answer is|answer only from|reasoning)/i;
  const segs = t
    .split(/\n+|(?=\*\s)|(?=(?:User Question|Context|Constraint Checklist|Confidence Score|Final Answer|Answer only)\s*:?)/gi)
    .map((s) => s.replace(/^[\s*\-•\d.]+/, '').trim())
    .filter(Boolean);
  if (!segs.length) return t;
  const good = segs.filter((s) => !bad.test(s) && s.length > 15);
  if (good.length && good.length < segs.length) {
    return good.join(' ').replace(/\s{2,}/g, ' ').trim();
  }
  return t;
}

app.get('/api/patient/chat/:docId', (req, res) => {
  res.json({ turns: readChat(req.params.docId) });
});

app.post('/api/patient/discuss', async (req, res) => {
  const { docId, question, speak = false, languageCode = 'en-IN' } = req.body || {};
  const q = String(question || '').trim();
  if (!q) return res.status(400).json({ error: 'Ask a question about your document.' });

  const doc = docId ? ragstore.getDoc(docId) : null;
  const hits = ragstore.retrieve(q, docId ? [docId] : null, 5);
  const context = hits
    .map((h) => `[${h.id}] ${h.text}`)
    .join('\n\n')
    .slice(0, 12000);

  // What was said before about this document — so "and what about the side
  // effects?" lands on the same medicine the patient was just asking about.
  const priorTurns = readChat(docId).slice(-6);
  const history = priorTurns.length
    ? priorTurns.map((t) => `${t.role === 'user' ? 'Patient' : 'You'}: ${String(t.text).slice(0, 600)}`).join('\n')
    : '';

  const system =
    'You help a patient understand their own medical documents. Answer only from the excerpts and conversation you are given. ' +
    'If the answer is not in the excerpts, say plainly that the document does not say. ' +
    'OUTPUT FORMAT: reply with only the answer itself, as 2-4 short sentences of plain, warm language. ' +
    'No preamble, no headings, no bullet lists, no restating the question, no labels, no excerpt ids, ' +
    'and never show your reasoning or instructions — the patient sees exactly what you write. ' +
    'Never diagnose, never change treatment, never claim a medicine is safe or unsafe, never comment on authenticity or counterfeit.';

  const user =
    (history ? `EARLIER IN THIS CONVERSATION:\n${history}\n\n` : '') +
    (context
      ? `EXCERPTS FROM THE PATIENT'S DOCUMENT:\n${context}\n\nQUESTION: ${q}`
      : `The patient's document had no text we could match against.\nQUESTION: ${q}`);

  const t0 = Date.now();
  const timings = { retrieval_ms: 0 };
  let answer;

  // The patient chose a language in the composer: the written answer and the
  // spoken one must be in the same language, otherwise the voice loop reads a
  // translation the patient never asked for.
  const LANG_NAME = { 'en-IN': 'English', 'hi-IN': 'Hindi (Devanagari script)', 'ta-IN': 'Tamil', 'kn-IN': 'Kannada' };
  const langName = LANG_NAME[languageCode];
  const replySystem = langName && languageCode !== 'en-IN'
    ? `${system} Write your whole answer in ${langName}, using that script.`
    : system;

  // JSON mode with an {answer} schema: measurably faster than prose on this
  // model, and it stops the reply from echoing the prompt as an outline.
  // A refused connection (GEMMA_NETWORK) fails in milliseconds, so retrying it
  // once costs the patient nothing; a timeout already used its whole budget.
  // Two tiers inside one call: the reasoning model gets a short per-attempt
  // budget, then the fast reader tier answers the same grounded prompt with the
  // same schema. Measured: one slow reasoning reply used to hold the chat for a
  // full 20s; a per-attempt cap plus a fast second tier keeps a reply inside
  // ~10-12s worst case and ~4s when the reasoning model is healthy. If the
  // reasoning model is already quarantined, the fast tier goes first.
  const fastModel = rxgemini.extractModel();
  const perAttemptMs = Number(process.env.DISCUSS_ATTEMPT_MS || 10_000);
  const modelOrder = rxgemini.isQuarantined(rxgemini.currentModel()) && fastModel
    ? [fastModel, rxgemini.currentModel()]
    : [rxgemini.currentModel(), ...(fastModel && fastModel !== rxgemini.currentModel() ? [fastModel] : [])];

  const askModel = async (attempt) => {
    try {
      return await rxgemini.answerJson({
        system: replySystem,
        prompt: user,
        temperature: 0.2,
        timeoutMs: perAttemptMs,
        maxTokens: 500,
        deadlineMs: perAttemptMs * modelOrder.length + 2_000,
        models: modelOrder
      });
    } catch (e) {
      const transient = /GEMMA_NETWORK|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|429|503/i.test(String(e.message));
      if (transient && attempt < 1) {
        console.warn(`[patient/discuss] transient model failure (${e.message}); retrying once`);
        await new Promise((r) => setTimeout(r, 700));
        return askModel(attempt + 1);
      }
      throw e;
    }
  };

  try {
    const out = await askModel(0);
    timings.model_ms = Date.now() - t0;
    answer = stripScaffold(rxgemini.scrubText(out))
      // The model is told to quote excerpt ids so grounding stays verifiable,
      // but the ids belong in `sources` — not in the sentence a patient reads.
      .replace(/\s*\[[A-Za-z0-9][A-Za-z0-9._-]*#\d+\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  } catch (e) {
    console.error('[patient/discuss]', e.message);
    const first = hits[0];
    answer = first
      ? `Your document says: “${String(first.text).slice(0, 260)}”. I could not reach the explanation model just now, so please read that line against your prescription, or ask your pharmacist.`
      : `I could not reach the language model right now, and your document had no line I could quote. Your document is still saved — try again in a moment.`;
  }

  // A reasoning model asked to answer plainly still sometimes narrates its own
  // instructions back. stripScaffold above already removed those segments.
  appendChat(docId, { role: 'user', text: q });
  appendChat(docId, { role: 'assistant', text: answer, grounded: hits.length > 0 });

  let audioBase64 = null;
  if (speak && sarvam.isLive()) {
    try {
      audioBase64 = await sarvam.tts(answer.replace(/\[[^\]]+\]/g, ''), languageCode);
    } catch (e) {
      console.error('[patient/discuss tts]', e.message);
    }
  }

  timings.total_ms = Date.now() - t0;

  res.json({
    answer,
    grounded: hits.length > 0,
    sources: hits.map((h) => ({ id: h.id, snippet: String(h.text).slice(0, 260), doc: h.docName })),
    audioBase64,
    timings,
    disclaimer: GUARDRAIL
  });
});

// 5) Follow-ups: a visit reminder and a refill reminder, queued for email.
app.post('/api/patient/reminders', async (req, res) => {
  const { docId, email, visitAt, refillInDays = 3, label = '', note = '', meds = [] } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Enter an email address for reminders.' });
  const doc = docId ? ragstore.getDoc(docId) : null;
  const docMeds = Array.isArray(meds) && meds.length ? meds : doc ? doc.drugs : [];

  const created = [];
  if (visitAt) {
    const r = schedule.queueReminder({
      worksheetId: doc ? doc.id : null,
      email,
      kind: 'doctor_visit',
      dueAt: visitAt,
      label: label || (doc ? doc.name : 'Follow-up visit'),
      note
    });
    if (r) created.push(r);
  }
  if (Array.isArray(refillInDays) ? refillInDays : Number(refillInDays) > 0) {
    const days = Number(refillInDays) || 0;
    const r = schedule.queueReminder({
      worksheetId: doc ? doc.id : null,
      email,
      kind: 'refill',
      dueAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      meds: docMeds,
      note
    });
    if (r) created.push(r);
  }
  if (!created.length) return res.status(400).json({ error: 'Choose a visit date or a refill lead time.' });

  const mail = await mailer.status().catch(() => ({ transport: 'none' }));
  res.json({
    reminders: schedule.listReminders(),
    created: created.map((r) => ({ id: r.id, kind: r.kind, at: r.at, describe: schedule.describe(r) })),
    mail
  });
});

app.get('/api/patient/reminders', (_req, res) => {
  res.json({ reminders: schedule.listReminders() });
});

app.post('/api/patient/reminders/:id/cancel', (req, res) => {
  res.json({ cancelled: schedule.cancelReminder(req.params.id) });
});

const schedTimer = schedule.startRecurring();
if (schedTimer && typeof schedTimer.on === 'function') {
  schedTimer.on('error', (e) => console.error('[schedule] recurring tick failed:', e.message));
}

// Discover the model catalogue once at boot so the two-model split is real:
// the fast multimodal flash-lite tier reads documents, the reasoning model
// explains them to the patient. Without this the pools stay empty and every
// caller silently falls back to a single model.
rxgemini
  .discoverModel()
  .then((m) => console.log(`[boot] reason=${m || 'none'} · read=${rxgemini.extractModel() || 'none'}`))
  .catch((e) => console.error('[boot] model discovery failed:', e.message));

app.listen(PORT, () => console.log(`[rxsafe] listening on http://localhost:${PORT}`));

