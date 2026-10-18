// RxSafe Lens — Gemini API client for prescription images + patient context.
// Native fetch, no SDK. Model auto-discovered via ListModels at startup.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const { SYSTEM_PROMPT } = require('./rxprompt');
const { DRUGS, DISCLAIMER } = require('./formulary');

const apiKey = process.env.GEMINI_API_KEY || null;
let MODEL = process.env.GEMMA_MODEL || null;

async function discoverModel() {
  if (!apiKey) {
    console.log('[rxgemini] No GEMINI_API_KEY set - running in CACHED mode (synthetic prescriptions only).');
    return null;
  }
  try {
    const res = await fetch(`${API_BASE}/models?key=${apiKey}`);
    if (!res.ok) {
      console.error(`[rxgemini] ListModels failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const capable = (data.models || []).filter(
      (m) => /gemma/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent')
    );
    const names = capable.map((m) => m.name.replace('models/', ''));
    if (MODEL && names.includes(MODEL)) {
      console.log(`[rxgemini] Using pinned model: ${MODEL}`);
    } else {
      MODEL = names[0] || null;
      console.log(`[rxgemini] Auto-selected model: ${MODEL || 'NONE FOUND'}`);
    }
    if (names.length) console.log(`[rxgemini] Available Gemma models: ${names.join(', ')}`);
    return MODEL;
  } catch (e) {
    console.error(`[rxgemini] ListModels error: ${e.message}`);
    return null;
  }
}

function parseJson(raw) {
  let t = String(raw).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// Belt and braces against the one output a prototype must never produce.
// The prompt forbids it; this removes it if a model ignores the prompt.
const FORBIDDEN = [
  'safe to dispense',
  'safe for dispensing',
  'no interactions',
  'no risk',
  'not counterfeit',
  'genuine medicine',
  'approved for dispensing'
];

function scrubWorksheet(ws) {
  let tripped = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      let out = node;
      for (const phrase of FORBIDDEN) {
        if (out.toLowerCase().includes(phrase)) {
          out = out.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[removed by RxSafe guardrail]');
          tripped.push(phrase);
        }
      }
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  const cleaned = walk(ws || {});
  cleaned.guardrail_tripped = tripped.length ? tripped : undefined;
  cleaned.disclaimer = `${DISCLAIMER} Decision-support only. The pharmacist must verify and approve before dispensing.`;
  return cleaned;
}

async function analyzeRx({ imageBase64, imageMime, contextText, deterministicFindings }) {
  if (!apiKey || !MODEL) throw new Error('NO_MODEL');

  const parts = [];
  if (imageBase64) {
    // Image before text: the documented ordering for multimodal Gemma prompts.
    parts.push({ inline_data: { mime_type: imageMime || 'image/png', data: imageBase64 } });
  }
  parts.push({
    text:
      `PATIENT CONTEXT (typed by the patient or pharmacist at the counter):\n"""\n${contextText || '(none provided)'}\n"""\n\n` +
      `DEMO FORMULARY (prototype reference data, not a clinical reference):\n${JSON.stringify(DRUGS, null, 2)}\n\n` +
      `DETERMINISTIC CHECKS our code already ran on your own extraction (confirm or add to them):\n${JSON.stringify(deterministicFindings || [], null, 2)}\n\n` +
      `Read the prescription image and produce the dispensing worksheet JSON now.`
  });

  const res = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1 }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GEMMA_API_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return scrubWorksheet(parseJson(out));
}

const isLive = () => Boolean(apiKey && MODEL);
const currentModel = () => MODEL;

module.exports = { discoverModel, analyzeRx, isLive, currentModel };