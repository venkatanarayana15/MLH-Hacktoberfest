// ClauseLens — Gemini API client for Gemma models.
// Native fetch, no SDK. Model auto-discovered via ListModels at startup
// (this log is the Milestone 0 evidence trail).

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const { SYSTEM_PROMPT } = require('./prompt');

const apiKey = process.env.GEMINI_API_KEY || null;
let MODEL = process.env.GEMMA_MODEL || null;

async function discoverModel() {
  if (!apiKey) {
    console.log('[gemma] No GEMINI_API_KEY set — running in CACHED mode (prepared agreements only).');
    return null;
  }
  try {
    const res = await fetch(`${API_BASE}/models?key=${apiKey}`);
    if (!res.ok) {
      console.error(`[gemma] ListModels failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const capable = (data.models || []).filter(
      (m) => /gemma/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent')
    );
    const names = capable.map((m) => m.name.replace('models/', ''));
    if (MODEL && names.includes(MODEL)) {
      console.log(`[gemma] Using pinned model: ${MODEL}`);
    } else {
      MODEL = names[0] || null;
      console.log(`[gemma] Auto-selected model: ${MODEL || 'NONE FOUND'}`);
    }
    if (names.length) console.log(`[gemma] Available Gemma models: ${names.join(', ')}`);
    return MODEL;
  } catch (e) {
    console.error('[gemma] ListModels error:', e.message);
    return null;
  }
}

function parseReport(raw) {
  let t = String(raw).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function analyze({ text, imageBase64, imageMime, rulesFindings }) {
  if (!apiKey || !MODEL) throw new Error('NO_MODEL');
  const parts = [];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: imageMime || 'image/png', data: imageBase64 } });
  }
  parts.push({
    text:
      `AGREEMENT UNDER ANALYSIS:\n"""\n${text}\n"""\n\n` +
      `RULES ENGINE FINDINGS (objective facts):\n${JSON.stringify(rulesFindings, null, 2)}\n\n` +
      `Produce the forensic JSON now.`,
  });
  const res = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GEMMA_API_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return parseReport(out);
}

function isLive() {
  return Boolean(apiKey && MODEL);
}

function currentModel() {
  return MODEL;
}

module.exports = { discoverModel, analyze, isLive, currentModel };
