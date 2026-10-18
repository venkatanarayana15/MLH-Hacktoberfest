// ClauseLens server — Express API + static UI.
// Modes: LIVE (Gemma via Gemini API) and CACHED (prepared agreements, offline-safe).

const express = require('express');
const path = require('path');
const gemma = require('./lib/gemma');
const { runRules } = require('./lib/rules');
const { EXAMPLES, getCachedReport } = require('./lib/examples');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

app.get('/api/mode', (req, res) => {
  res.json({ live: gemma.isLive(), model: gemma.isLive() ? gemma.currentModel() : null });
});

app.get('/api/examples', (req, res) => {
  res.json(EXAMPLES.map(({ id, label, kind, text }) => ({ id, label, kind, text })));
});

app.post('/api/analyze', async (req, res) => {
  const { text, imageBase64, imageMime, exampleId } = req.body || {};
  const inputText = String(text || '').trim();
  if (!inputText && !imageBase64 && !exampleId) {
    return res.status(400).json({ error: 'Provide agreement text or a screenshot.' });
  }

  const matchId = exampleId || (EXAMPLES.find((e) => norm(e.text) === norm(inputText)) || {}).id || null;

  const serveCached = (id, fallbackNote) => {
    const cached = getCachedReport(id);
    if (!cached) return false;
    const rules = runRules(cached.sourceText);
    res.json({
      mode: fallbackNote ? 'cached-fallback' : 'cached',
      exampleId: id,
      sourceText: cached.sourceText,
      rules,
      report: cached.report,
      note: fallbackNote || 'Analysis from a pre-run Gemma session (offline demo mode).'
    });
    return true;
  };

  try {
    if (gemma.isLive()) {
      const rules = runRules(inputText);
      try {
        const report = await gemma.analyze({ text: inputText, imageBase64, imageMime, rulesFindings: rules });
        return res.json({ mode: 'live', sourceText: inputText, rules, report });
      } catch (e) {
        console.error('[analyze] live failed:', e.message);
        if (matchId && serveCached(matchId, `Live analysis unavailable (${e.message.slice(0, 80)}). Showing cached analysis for this prepared agreement.`)) return;
        return res.status(502).json({ error: `Live analysis failed: ${e.message}` });
      }
    }
    if (matchId && serveCached(matchId)) return;
    return res.status(503).json({ error: 'No API key configured and no cached match for this input. Try a prepared agreement.' });
  } catch (e) {
    console.error('[analyze]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
gemma.discoverModel().then(() => {
  app.listen(PORT, () => console.log(`[clauselens] listening on http://localhost:${PORT}`));
});
