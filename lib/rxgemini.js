// RxSafe Lens — Gemini API client for prescription images + patient context.
// Native fetch, no SDK. Model auto-discovered via ListModels at startup.
// Output shape is validated with Zod (github.com/colinhacks/zod, ISC) so a
// malfunctioning model can never feed the worksheet UI arbitrary JSON.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const { z } = require('zod');
const { SYSTEM_PROMPT } = require('./rxprompt');
const { DRUGS, DISCLAIMER } = require('./formulary');

// Minimal .env loader so local runs work without an extra dependency.
// Process env always wins over the file, so hosts that inject env vars are unaffected.
try {
  const fs = require('fs');
  const path = require('path');
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m2 = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m2) continue;
      const key = m2[1];
      const val = m2[2].replace(/^["']|["']$/g, '').trim();
      if (val && !process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  console.log(`[rxgemini] .env not loaded (${e.message}); using process env only.`);
}

const apiKey = process.env.GEMINI_API_KEY || null;
let MODEL = process.env.GEMMA_MODEL || null;
let ALL_MODELS = [];
let EXTRACT_POOL = []; // every multimodal generateContent model, for reading tasks

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
    const all = (data.models || [])
      .filter((m) => /gemini|gemma/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    // Two pools on purpose: reasoning (gemma) drives the copilot and the
    // explanations, while the fast multimodal flash-lite tier does the reading.
    // Reading a photo is perception, not reasoning — it does not need the
    // reasoning model, and it should not pay for it.
    ALL_MODELS = all.filter((n) => /gemma/i.test(n));
    EXTRACT_POOL = all;
    if (MODEL && ALL_MODELS.includes(MODEL)) {
      console.log(`[rxgemini] Using pinned reasoning model: ${MODEL}`);
    } else {
      MODEL = ALL_MODELS[0] || null;
      console.log(`[rxgemini] Auto-selected reasoning model: ${MODEL || 'NONE FOUND'}`);
    }
    const extract = EXTRACT_POOL.find((n) => /gemini-3\.5-flash-lite/i.test(n)) || EXTRACT_POOL.find((n) => /flash-lite/i.test(n));
    EXTRACT_MODEL = extract || null;
    console.log(`[rxgemini] Extraction model: ${EXTRACT_MODEL || 'none available'}`);
    console.log(`[rxgemini] Reasoning models: ${ALL_MODELS.join(', ') || 'none'}`);
    return MODEL;
  } catch (e) {
    console.error(`[rxgemini] ListModels error: ${e.message}`);
    return null;
  }
}

// Models often answer with a complete JSON object and then keep talking, or emit
// a second object. Taking `first { .. last }` splices them into invalid JSON, so
// we walk the string properly and return the FIRST structurally complete object.
function firstCompleteJsonObject(t) {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) return t.slice(start, i + 1);
    }
  }
  return null;
}

function parseJson(raw) {
  let t = String(raw).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // 1) First balanced object, string-aware.
  const first = firstCompleteJsonObject(t);
  if (first) {
    try {
      return JSON.parse(first);
    } catch {
      /* fall through to repair */
    }
  }
  // 2) Legacy first-{ .. last-} slice (correct when there is exactly one object).
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = t.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch {
      /* fall through to repair */
    }
  }
  // 3) Gemma intermittently truncates mid-object. Repair by cutting at the last
  //    structurally complete position and closing the open containers.
  const fixed = repairJson(first || t);
  if (fixed) return fixed;
  throw new SyntaxError('no complete JSON object found in model output');
}

function repairJson(t) {
  const stack = [];
  let inStr = false;
  let esc = false;
  let lastSafe = -1;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        lastSafe = i;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      lastSafe = i;
      continue;
    }
    if (/[0-9]/.test(ch) && !/[0-9.]/.test(t[i + 1] || '')) lastSafe = i;
  }
  if (inStr || lastSafe < 0) return null;
  let out = t.slice(0, lastSafe + 1);
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ---- Zod output contract ----------------------------------------------------
//passthrough(): extra model fields are kept, but the fields the UI and the
// deterministic layer actually consume must be the right types.
const MEDICATION = z
  .object({
    drug: z.string(),
    written_as: z.string().nullable().optional(),
    interpreted_as: z.string().nullable().optional(),
    strength: z.string().nullable().optional(),
    form: z.string().nullable().optional(),
    frequency: z.string().nullable().optional(),
    timing: z.string().nullable().optional(),
    duration_days: z.number().int().nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    ambiguity: z.string().nullable().optional(),
    source: z.string().optional()
  })
  .passthrough();

const WORKSHEET = z
  .object({
    readiness: z.enum(['pharmacist_verification_required', 'ambiguous_clarification_required', 'incomplete_information']).optional(),
    read_summary: z.string().optional(),
    extracted_medications: z.array(MEDICATION).optional(),
    safety_flags: z
      .array(
        z
          .object({
            type: z.string(),
            severity: z.enum(['high', 'medium', 'low']),
            message: z.string(),
            action: z.string().optional(),
            why: z.string().optional()
          })
          .passthrough()
      )
      .optional(),
    verification_checklist: z.array(z.string()).optional(),
    patient_context: z.any().optional(),
    disclaimer: z.string().optional()
  })
  .passthrough();

function validateWorksheet(raw) {
  const ws = raw;
  const result = WORKSHEET.safeParse(ws);
  if (!result.success) {
    ws.schema_valid = false;
    ws.safety_flags = [
      ...(Array.isArray(ws.safety_flags) ? ws.safety_flags : []),
      {
        type: 'schema_validation_failed',
        severity: 'medium',
        message:
          'The model output did not match the expected worksheet schema. Deterministic checks can still run, but treat this extraction as less reliable.',
        action: 'Re-read the slip or confirm the extraction against the image before proceeding.'
      }
    ];
  } else {
    ws.schema_valid = true;
  }
  return ws;
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

async function analyzeRx(args) {
  if (!apiKey || !MODEL) throw new Error('NO_MODEL');
  // Live Gemma endpoints are per-model quirky (some reject system_instruction,
  // some 500 without it — verified in probing) and occasionally 503 under
  // demand spikes. callWithFallbacks tries the pinned model first, then the
  // other discovered Gemma models, with and without a system prompt, and
  // remembers (sticky) the combination that worked.
  return callWithFallbacks(async (model, systemMode) => {
    const parts = [];
    if (args.imageBase64) {
      // Image before text: the documented ordering for multimodal Gemma prompts.
      parts.push({ inline_data: { mime_type: args.imageMime || 'image/png', data: args.imageBase64 } });
    }
    parts.push({
      text:
        `PATIENT CONTEXT (typed by the patient or pharmacist at the counter):\n"""\n${args.contextText || '(none provided)'}\n"""\n\n` +
        `DEMO FORMULARY (prototype reference data, not a clinical reference):\n${JSON.stringify(DRUGS)}\n\n` +
        `DETERMINISTIC CHECKS our code already ran on your own extraction (confirm or add to them):\n${JSON.stringify(args.deterministicFindings || [], null, 2)}\n\n` +
        `Read the prescription image and produce the dispensing worksheet JSON now.`
    });
    // Strict JSON first (responseMimeType=application/json): verified on
    // gemma-4-26b-a4b-it to be both cleaner and ~3x faster than prose+JSON.
    // If a model rejects JSON mode with a 4xx, retry the same model once
    // without it before moving to the next combo.
    let text;
    try {
      text = await generateText(parts, SYSTEM_PROMPT, 0.1, model, systemMode, { json: true });
    } catch (e) {
      if (/GEMMA_API_4\d\d/.test(e.message)) {
        text = await generateText(parts, SYSTEM_PROMPT, 0.1, model, systemMode, {});
      } else {
        throw e;
      }
    }
    return scrubWorksheet(validateWorksheet(parseJson(text)));
  });
}

// Generic text-in → text-out call (MediPilot ReAct agent). No scrubbing/
// schema-massaging here; the agent layer owns its own JSON contract.
async function chat({ system, parts, temperature, timeoutMs, maxTokens, deadlineMs }) {
  if (!apiKey || !MODEL) throw new Error('NO_MODEL');
  return callWithFallbacks(
    async (model, systemMode) =>
      generateText(parts.slice(), system, temperature || 0.3, model, systemMode, { timeoutMs, maxTokens }),
    deadlineMs
  );
}

const ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: { answer: { type: 'STRING' } },
  required: ['answer']
};

// A truncated JSON reply is common when a model spends tokens before emitting
// the object. Recover the partial answer instead of throwing it away.
function salvageAnswer(raw) {
  const s = String(raw || '');
  const key = s.indexOf('"answer"');
  if (key < 0) return null;
  const colon = s.indexOf(':', key);
  const open = s.indexOf('"', colon + 1);
  if (colon < 0 || open < 0) return null;
  let out = '';
  for (let i = open + 1; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      out += n === 'n' ? '\n' : n === 't' ? ' ' : n === '"' ? '"' : n === '\\' ? '\\' : '';
      i += 1;
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  const cleaned = out.trim();
  return cleaned.length >= 40 ? cleaned : null;
}

// Generic JSON-mode call with an enforced response schema. Before this existed,
// every structured step relied on prose + parseJson, which is where the
// 40-second reads came from: the model had to generate (and we had to trust) a
// free-form document. A schema makes the shape the API's job.
async function jsonCall({ system, prompt, schema, temperature, timeoutMs, maxTokens, deadlineMs }) {
  if (!apiKey || !MODEL) throw new Error('NO_MODEL');
  if (!schema) throw new Error('SCHEMA_REQUIRED');
  const raw = await callWithFallbacks(
    async (model, systemMode) =>
      generateText([{ text: prompt }], system, temperature === undefined ? 0.3 : temperature, model, systemMode, {
        timeoutMs,
        maxTokens: maxTokens || 900,
        json: true,
        responseSchema: schema
      }),
    deadlineMs || timeoutMs
  );
  let parsed;
  try {
    parsed = parseJson(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`EMPTY_JSON: ${String(raw).slice(0, 200)}`);
  }
  return parsed;
}

// JSON-mode answer for the copilot. Measured on gemma-4-26b-a4b-it: 2.7s with a
// schema vs 6.7s in prose mode, and — the real reason — a schema stops the model
// from echoing the prompt as a bullet outline (its prose mode mirrored the
// instructions back instead of answering).
async function answerJson(args) {
  try {
    const parsed = await jsonCall({ ...args, schema: args.schema || ANSWER_SCHEMA, maxTokens: args.maxTokens || 500 });
    const text = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    if (text) return text;
    throw new Error('EMPTY_ANSWER');
  } catch (e) {
    // A truncated reply is common when a model spends tokens before emitting the
    // object; recover the partial answer instead of losing the turn.
    const m = /EMPTY_JSON: ([\s\S]*)$/.exec(e.message || '');
    const salvaged = m ? salvageAnswer(m[1]) : null;
    if (salvaged) return salvaged;
    throw e;
  }
}

async function callWithFallbacks(run, deadlineMs) {
  const combos = [];
  for (const model of [MODEL, ...ALL_MODELS.filter((n) => n !== MODEL)]) {
    for (const systemMode of ['system', 'inline']) combos.push({ model, systemMode });
  }
  if (STICKY) {
    const i = combos.findIndex((c) => `${c.model}:${c.systemMode}` === STICKY);
    if (i > 0) combos.unshift(...combos.splice(i, 1));
  }
  // A model answering 5xx (or hanging) is broken at the provider, not
  // misconfigured by us: stop burning a round-trip on it for a while. If every
  // model is marked dead, try them anyway rather than failing outright.
  let attempts = combos.filter((c) => (DEAD.get(c.model) || 0) < Date.now());
  if (!attempts.length) attempts = combos;
  // Wall-clock budget for the whole fallback sweep. Without it a provider
  // outage turns one read into ~100s of sequential 5xx round-trips, which is
  // how a pharmacist demo becomes a dead demo. Failing fast with an honest
  // message beats waiting out every combination.
  const deadline = Date.now() + Number(deadlineMs || process.env.GEMMA_TOTAL_MS || 75_000);
  let lastErr = null;
  for (const { model, systemMode } of attempts) {
    if (Date.now() > deadline) {
      console.error('[rxgemini] fallback sweep hit its wall-clock budget; stopping early.');
      break;
    }
    try {
      const out = await run(model, systemMode);
      STICKY = `${model}:${systemMode}`;
      DEAD.delete(model);
      return out;
    } catch (e) {
      lastErr = e;
      // 5xx and timeouts are both provider-side faults: quarantine the model.
      if (/GEMMA_API_5\d\d|GEMMA_TIMEOUT/.test(e.message)) DEAD.set(model, Date.now() + 5 * 60 * 1000);
      console.error(`[rxgemini] ${model} (${systemMode}) failed: ${e.message.slice(0, 140)}`);
    }
  }
  throw lastErr || new Error('NO_MODEL');
}

let STICKY = null;
const DEAD = new Map(); // model -> timestamp until which it is skipped after a 5xx

async function generateText(parts, systemText, temperature, model, systemMode, opts = {}) {
  const generationConfig = { temperature, maxOutputTokens: opts.maxTokens || (opts.json ? 3072 : 2048) };
  if (opts.json) generationConfig.responseMimeType = 'application/json';
  if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema;
  const body = { contents: [{ role: 'user', parts }], generationConfig };
  if (systemMode === 'system') {
    body.system_instruction = { parts: [{ text: systemText }] };
  } else {
    parts[parts.length - 1].text = `${systemText}\n\n---\n\n${parts[parts.length - 1].text}`;
  }
  // Per-call deadline. A hung socket must cost one bounded timeout, not the
  // request's whole budget (and not the pharmacist's whole afternoon).
  const budgetMs = Number(opts.timeoutMs || process.env.GEMMA_CALL_MS || 35_000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('GEMMA_TIMEOUT')), budgetMs);
  let res;
  try {
    res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`GEMMA_TIMEOUT_${budgetMs}: ${model} did not answer within ${Math.round(budgetMs / 1000)}s`);
    throw new Error(`GEMMA_NETWORK: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GEMMA_API_${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Text-level guardrail for MediPilot answers (same banned phrases as the
// worksheet scrubber).
function scrubText(text) {
  let out = String(text ?? '');
  for (const phrase of FORBIDDEN) {
    if (out.toLowerCase().includes(phrase)) {
      out = out.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[removed by RxSafe guardrail]');
    }
  }
  return out;
}

// Reads a medicine strip/box photo — the SECOND image modality. It exists to
// close the "existing medicine, unnamed" gap: the patient says "a medicine for
// blood pressure", the strip photo names it, and the deterministic layer can
// then check against a named drug instead of an unknown.
async function readMedicine(args) {
  if (!apiKey || !MODEL) throw new Error('NO_MODEL');
  const PROMPT =
    'Read the medicine packaging or strip photo. Identify the medicine.\n' +
    'Reply ONLY with JSON of this shape:\n' +
    '{"drug": "generic name (brand in brackets if that is all that is printed)", "strength": "e.g. 5 mg or null", "form": "tablet/capsule/syrup or null", "confidence": 0.0, "ambiguity": "competing reading or null"}\n' +
    'Rules: confidence is YOUR confidence in the drug NAME alone, 0 to 1; use below 0.5 when unreadable or cropped. ' +
    'Never state or imply that a medicine is genuine, counterfeit, expired or substandard — packaging cannot establish any of that. ' +
    'If two readings are plausible, put the other in "ambiguity".';
  const SYS = 'You read medicine packaging for a pharmacy prototype. Output strict JSON only. Never claim a medicine is authentic or counterfeit.';
  return callWithFallbacks(async (model, systemMode) => {
    const parts = [
      { inline_data: { mime_type: args.imageMime || 'image/png', data: args.imageBase64 } },
      { text: `${PROMPT}\n\nRead the photo now.` }
    ];
    let text;
    try {
      text = await generateText(parts, SYS, 0.1, model, systemMode, { json: true });
    } catch (e) {
      if (/GEMMA_API_4\d\d/.test(e.message)) text = await generateText(parts, SYS, 0.1, model, systemMode, {});
      else throw e;
    }
    const j = parseJson(text);
    return {
      drug: scrubText(String(j.drug || '').slice(0, 60)).trim(),
      strength: j.strength ? scrubText(String(j.strength).slice(0, 30)).trim() : null,
      form: j.form ? String(j.form).slice(0, 20) : null,
      confidence: typeof j.confidence === 'number' ? Math.min(1, Math.max(0, j.confidence)) : null,
      ambiguity: j.ambiguity ? scrubText(String(j.ambiguity).slice(0, 60)).trim() : null,
      source: 'medicine_photo',
      model
    };
  });
}

// ---------------------------------------------------------------------------
// Patient pipeline: a fast multimodal model READS the upload, the reasoning
// model EXPLAINS it. Reading is a perception job, not a reasoning job, so the
// flash-lite tier is both the right tool and far cheaper per call.
// ---------------------------------------------------------------------------
let EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'gemini-3.5-flash-lite';

const EXTRACT_PREFERENCE = [/gemini-3\.5-flash-lite/i, /flash-lite/i, /gemini.*flash/i, /gemma/i];

function pickExtractModel() {
  if (EXTRACT_MODEL) {
    // Before the catalogue is discovered, the pools are empty and membership
    // cannot be checked. Trust the verified default name (probed live) but once
    // discovery has run, only return names the API actually listed.
    const poolsEmpty = !EXTRACT_POOL.length && !ALL_MODELS.length;
    if (poolsEmpty || EXTRACT_POOL.includes(EXTRACT_MODEL) || ALL_MODELS.includes(EXTRACT_MODEL)) return EXTRACT_MODEL;
  }
  for (const re of EXTRACT_PREFERENCE) {
    const hit = EXTRACT_POOL.find((n) => re.test(n)) || ALL_MODELS.find((n) => re.test(n));
    if (hit) return hit;
  }
  return MODEL || null;
}

const EXTRACTION_PROMPT =
  'You read medical documents that a patient photographed or downloaded. Transcribe and structure what is actually written.\n' +
  'Return ONLY JSON of exactly this shape:\n' +
  '{"raw_text": "the readable text of the document, line by line, keeping the wording you can actually see", ' +
  '"document_type": "prescription | lab_report | discharge_summary | medicine_strip | other", ' +
  '"prescriber": "doctor or clinic name if printed, else null", ' +
  '"date": "date printed on the document if you can read it, else null", ' +
  '"follow_up_date": "a follow-up or review date printed on the document if present, else null", ' +
  '"medicines": [{"drug": "name as printed", "strength": "e.g. 5 mg or null", "form": "tablet/capsule/syrup/injection or null", ' +
  '"frequency": "e.g. twice daily after food, or exactly as written", "timing": "when in the day, or null", ' +
  '"duration_days": number of days stated or null, "confidence": 0.0, "ambiguity": "a second possible reading or null"}], ' +
  '"notes": "anything else written that matters: test results, advice, warning lines", ' +
  '"follow_up_advice": "any follow-up instruction written on the document, else null"}\n' +
  'Rules:\n' +
  '- Transcribe only what you can actually see. Never complete a name you cannot read — put your uncertainty in "ambiguity" and keep confidence below 0.5.\n' +
  '- "confidence" is YOUR confidence in the medicine name itself, from 0 to 1.\n' +
  '- If the document is a lab report, the values belong in "notes" and "raw_text".\n' +
  '- Never add a diagnosis, never claim a medicine is genuine or counterfeit, never invent a dose that is not written.';

async function extractDocument(args) {
  if (!apiKey) throw new Error('NO_MODEL');
  const model = pickExtractModel();
  if (!model) throw new Error('NO_MODEL');
  const parts = [];
  if (args.imageBase64) parts.push({ inline_data: { mime_type: args.imageMime || 'image/png', data: args.imageBase64 } });
  parts.push({
    text:
      EXTRACTION_PROMPT +
      (args.text ? `\n\nThe uploaded document's own text layer (prefer it when the photo is unclear):\n${args.text}` : '') +
      '\n\nRead it now.'
  });
  const SYS = 'You transcribe medical documents into strict JSON. You never diagnose and never complete unreadable names.';
  let text;
  try {
    text = await generateText(parts, SYS, 0.1, model, 'system', { json: true, timeoutMs: 45_000 });
  } catch (e) {
    if (/GEMMA_API_4\d\d/.test(e.message)) text = await generateText(parts, SYS, 0.1, model, 'inline', { timeoutMs: 45_000 });
    else throw e;
  }
  const j = parseJson(text);
  const meds = Array.isArray(j.medicines) ? j.medicines : [];
  return {
    model,
    raw_text: String(j.raw_text || '').slice(0, 20000),
    document_type: String(j.document_type || 'other').slice(0, 40),
    prescriber: j.prescriber ? scrubText(String(j.prescriber).slice(0, 120)).trim() : null,
    date: j.date ? String(j.date).slice(0, 40) : null,
    follow_up_date: j.follow_up_date ? String(j.follow_up_date).slice(0, 40) : null,
    medicines: meds
      .slice(0, 30)
      .map((m) => ({
        drug: scrubText(String(m.drug || '').slice(0, 80)).trim(),
        strength: m.strength ? scrubText(String(m.strength).slice(0, 30)).trim() : null,
        form: m.form ? String(m.form).slice(0, 30) : null,
        frequency: m.frequency ? scrubText(String(m.frequency).slice(0, 60)).trim() : null,
        timing: m.timing ? String(m.timing).slice(0, 60) : null,
        duration_days: typeof m.duration_days === 'number' ? m.duration_days : null,
        confidence: typeof m.confidence === 'number' ? Math.min(1, Math.max(0, m.confidence)) : null,
        ambiguity: m.ambiguity ? scrubText(String(m.ambiguity).slice(0, 60)).trim() : null
      }))
      .filter((m) => m.drug),
    notes: j.notes ? scrubText(String(j.notes).slice(0, 4000)).trim() : null,
    follow_up_advice: j.follow_up_advice ? scrubText(String(j.follow_up_advice).slice(0, 500)).trim() : null
  };
}

// Explains that extraction back to the patient in everyday language. Hard rule:
// it may only use facts present in the extraction, and it must never tell the
// patient to change treatment.
async function explainForPatient(args) {
  if (!apiKey) throw new Error('NO_MODEL');
  const extraction = args.extraction || {};
  const have = (args.have || []).join(', ') || 'nothing the patient has confirmed';
  const system =
    'You explain a prescription to a patient in plain everyday language. You may only use what is in the extraction you are given. ' +
    'Never add a diagnosis, never invent a dose, never claim a medicine is safe or unsafe, and never tell the patient to change their treatment. ' +
    'If something is missing from the document, say it was not written on the document.';
  const user =
    `EXTRACTION FROM THE PATIENT'S OWN DOCUMENT:\n${JSON.stringify(extraction, null, 2)}\n\n` +
    `MEDICINES THE PATIENT SAYS THEY ALREADY HAVE: ${have}\n\n` +
    'Return ONLY JSON of this shape:\n' +
    '{"plain_summary": "2-4 sentences a patient can read out loud: what the doctor wrote and what it is for", ' +
    '"per_medicine": [{"drug": "name", "what_it_is_for": "general use in everyday words", "how_to_take_it": "plain instructions", ' +
    '"look_out_for": "one or two things to be careful about, or null"}], ' +
    '"already_have": ["names the patient confirmed they have"], "need_to_buy": ["names the patient still needs to get"], ' +
    '"next_visit": "what the document says about a follow-up visit, or null", ' +
    '"questions": ["3-5 short questions this patient should ask the doctor"], ' +
    '"warning_lines": ["anything written on the document that the patient must not miss"]}';

  const parts = [{ text: user }];
  // The reasoning model is deliberately the slow one here: it is the step that
  // turns a read into something a person can act on. Give it room, but not an
  // open-ended budget — if it misses the window the report still renders from
  // the deterministic plain-language cards, so a slow model degrades the
  // wording instead of breaking the page.
  let text;
  try {
    text = await generateText(parts, system, 0.3, MODEL, 'system', { json: true, timeoutMs: 120_000, maxTokens: 2048 });
  } catch (e) {
    if (/GEMMA_API_4\d\d/.test(e.message)) text = await generateText(parts, system, 0.3, MODEL, 'inline', { json: true, timeoutMs: 120_000, maxTokens: 2048 });
    else throw e;
  }
  const j = parseJson(text);
  return {
    model: MODEL,
    plain_summary: scrubText(String(j.plain_summary || '').slice(0, 1200)).trim(),
    per_medicine: (Array.isArray(j.per_medicine) ? j.per_medicine : [])
      .slice(0, 30)
      .map((m) => ({
        drug: scrubText(String(m.drug || '').slice(0, 80)).trim(),
        what_it_is_for: scrubText(String(m.what_it_is_for || '').slice(0, 300)).trim(),
        how_to_take_it: scrubText(String(m.how_to_take_it || '').slice(0, 300)).trim(),
        look_out_for: m.look_out_for ? scrubText(String(m.look_out_for).slice(0, 300)).trim() : null
      }))
      .filter((m) => m.drug),
    already_have: (Array.isArray(j.already_have) ? j.already_have : []).map((x) => scrubText(String(x).slice(0, 80)).trim()).filter(Boolean),
    need_to_buy: (Array.isArray(j.need_to_buy) ? j.need_to_buy : []).map((x) => scrubText(String(x).slice(0, 80)).trim()).filter(Boolean),
    next_visit: j.next_visit ? scrubText(String(j.next_visit).slice(0, 300)).trim() : null,
    questions: (Array.isArray(j.questions) ? j.questions : []).map((x) => scrubText(String(x).slice(0, 200)).trim()).filter(Boolean).slice(0, 6),
    warning_lines: (Array.isArray(j.warning_lines) ? j.warning_lines : []).map((x) => scrubText(String(x).slice(0, 200)).trim()).filter(Boolean).slice(0, 6)
  };
}

const isLive = () => Boolean(apiKey && MODEL);
const currentModel = () => MODEL;
const extractModel = () => pickExtractModel();

module.exports = {
  discoverModel,
  analyzeRx,
  readMedicine,
  chat,
  answerJson,
  jsonCall,
  scrubText,
  isLive,
  currentModel,
  extractDoc,
  extractDocument,
  explainForPatient,
  extractModel
};

// Extract structured text + drugs from an uploaded PDF or image. This endpoint
// exists so the copilot drawer can consume a real prescription document the
// pharmacist photographed or scanned, then discuss it. It is a thin wrapper
// around the same multimodal Gemma call used for reading prescriptions, with a
// prompt tuned to return the plain text plus a short drug list.
async function extractDoc({ fileBase64, fileMime }) {
  if (!apiKey || !MODEL) throw new Error('NO_MODEL');
  const prompt =
    'Extract the text of this prescription or medicine document and list every medicine named, with its strength if shown. Reply with JSON of this shape:\n' +
    '{"plain": "the extracted text, cleaned", "drugs": [{"name": "generic name", "strength": "e.g. 500 mg or null"}]}\n' +
    'Rules: plain may be multi-line and include dosage instructions. drugs lists each distinct medicine. Never state or imply a medicine is genuine, counterfeit, expired or substandard.';
  const sys = 'You extract the text of a prescription or medicine document for a pharmacy prototype. Return strict JSON only.';
  return callWithFallbacks(async (model, systemMode) => {
    const parts = [
      { inline_data: { mime_type: fileMime || 'application/pdf', data: fileBase64 } },
      { text: `${prompt}\n\nExtract now.` }
    ];
    let text;
    try {
      text = await generateText(parts, sys, 0.1, model, systemMode, { json: true });
    } catch (e) {
      if (/GEMMA_API_4\d\d/.test(e.message)) text = await generateText(parts, sys, 0.1, model, systemMode, {});
      else throw e;
    }
    const j = parseJson(text);
    return {
      plain: String(j.plain || '').trim(),
      drugs: Array.isArray(j.drugs)
        ? j.drugs.map((d) => ({ name: String(d.name || '').trim().slice(0, 80), strength: d.strength ? String(d.strength).trim().slice(0, 40) : null }))
        : []
    };
  });
}