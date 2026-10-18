// RxSafe Lens server — Express API + static UI.
// Modes: LIVE (Gemma via Gemini API reading the prescription image) and
// CACHED (three synthetic slips with pre-run worksheets, offline-safe).
//
// RxSafe Lens does not dispense, diagnose, or detect counterfeits. It produces a
// worksheet a pharmacist must verify. Every response carries that boundary.

const express = require('express');
const path = require('path');
const rxgemini = require('./lib/rxgemini');
const { runRxRules } = require('./lib/rxrules');
const { SAMPLES, getSample } = require('./lib/rxsamples');
const { DISCLAIMER } = require('./lib/formulary');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GUARDRAIL = 'Decision-support only. Not a clinical reference and not counterfeit detection. The pharmacist must verify and approve before dispensing.';

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

app.post('/api/analyze-rx', async (req, res) => {
  const { sampleId, imageBase64, imageMime, contextText } = req.body || {};
  const ctx = String(contextText || '').trim();
  if (!sampleId && !imageBase64) {
    return res.status(400).json({ error: 'Upload a prescription image or pick one of the synthetic samples.' });
  }
  const sample = getSample(sampleId);
  const effectiveCtx = ctx || (sample ? sample.contextText : '');

  // Deterministic checks run on whatever extraction we have. In live mode we call
  // Gemma first and then re-run them on its own extraction, so the code layer
  // always checks the interpretation that will actually be shown.
  const buildResponse = (mode, worksheet, extraction, note) => {
    const meds = (worksheet && (worksheet.extracted_medications || (worksheet.medications || []))) || [];
    const deterministic = runRxRules({ medications: meds }, effectiveCtx);
    const modelFlags = (worksheet && worksheet.safety_flags) || [];
    const seen = new Set(deterministic.map((d) => `${d.id}`));
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
    return {
      mode,
      sampleId: sampleId || null,
      contextText: effectiveCtx,
      extraction: extraction || { extracted_medications: meds },
      deterministic,
      worksheet: { ...worksheet, safety_flags: merged, disclaimer: GUARDRAIL },
      formularyDisclaimer: DISCLAIMER,
      note: note || null
    };
  };

  if (rxgemini.isLive() && imageBase64) {
    try {
      // First pass with no extraction yet, so the model reads from the image.
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
      const det = runRxRules({ medications: meds }, effectiveCtx);
      const second = await rxgemini.analyzeRx({ imageBase64, imageMime, contextText: effectiveCtx, deterministicFindings: det });
      return res.json(buildResponse('live', second, { extracted_medications: meds }, null));
    } catch (e) {
      console.error('[analyze-rx] live failed:', e.message);
      if (sample) {
        return res.json(
          buildResponse(
            'cached-fallback',
            sample.worksheet,
            sample.extraction,
            `Live reading unavailable (${e.message.slice(0, 80)}). Showing the pre-run worksheet for this synthetic slip.`
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
          : 'Pre-run worksheet from a synthetic slip (no GEMINI_API_KEY configured).')
    );
  }

  return res.status(503).json({ error: 'No API key configured and no synthetic sample selected. Pick a sample or add GEMINI_API_KEY.' });
});

const PORT = process.env.PORT || 3000;
rxgemini.discoverModel().then(() => {
  app.listen(PORT, () => console.log(`[rxsafe] listening on http://localhost:${PORT}`));
});