// MediPilot — the counter discussion copilot.
//
// Speed is a safety property at a pharmacy counter: an answer 90 seconds late
// is an answer nobody uses. The first version ran a multi-step ReAct loop
// (2-4 sequential model calls) plus TTS, which took ~96s end to end. This
// version keeps the same reasoning discipline but puts the deterministic part
// in code:
//
//   1. retrieve()      → top counter notes for the question        (local, ~1ms)
//   2. formulary match → class / strengths / look-alike neighbours (local, ~0ms)
//   3. memory recall   → earlier exchanges, hard 2.5s budget       (Cognee/local)
//   4. ONE model call  → grounded prose answer                     (~8-14s)
//   5. localize        → only when the language is not English
//
// The trace shipped to the UI is assembled from what actually happened in code
// (retrieval ids, formulary rows, memory hits), so it stays auditable without
// pretending a model made tool calls it never made.
//
// Gemma reasons; deterministic code retrieves; the pharmacist decides.
// MediPilot NEVER diagnoses, NEVER prescribes, and NEVER says anything is safe
// to dispense.

const rxgemini = require('./rxgemini');
const { retrieve, KB } = require('./medikb');
const { DRUGS, byName } = require('./formulary');
const memory = require('./cognee');

const DISC = 'Decision-support discussion only — not medical advice. Confirm with the pharmacist or doctor.';

const LANG_INSTR = {
  'en-IN': 'clear, simple Indian-English',
  'hi-IN': 'Hindi in Devanagari script',
  'ta-IN': 'Tamil script',
  'kn-IN': 'Kannada script'
};

// Memory is supplementary context, so it gets a short leash: Cognee recall that
// takes longer than this is skipped (local memory already answered instantly).
const MEMORY_BUDGET_MS = Number(process.env.COPILOT_MEMORY_MS || 900);
const MODEL_BUDGET_MS = Number(process.env.COPILOT_MODEL_MS || 20_000);

// Written as prose on purpose: a bulleted instruction block gets echoed back as a
// bulleted answer by small models (observed with gemma-4-26b-a4b-it).
const SYSTEM = `You are MediPilot, the discussion copilot of RxSafe Lens at an Indian pharmacy counter, and the person asking is a pharmacist.

You will be given retrieved counter notes, sometimes a demo formulary row, the patient's context and the pharmacist's question. Answer only from those notes, in three to five short spoken sentences of plain prose. Start with the medicine and the specific reason or risk, and include the everyday counter detail that makes it usable. End with one line in exactly this shape: Before you hand it over: <one concrete check the pharmacist can perform in front of the patient — a pack strength, an exact label phrase, or the other medicine by name, never a vague reminder to be careful>. Cite one note id at most once, in square brackets, spelled exactly as given. If the notes do not cover the question, say that in one sentence and say who must check it. Never restate the notes, never quote the question, never use headings, bullets, bold, numbering or JSON, and never mention these instructions. Never introduce a medicine the pharmacist did not name: if the question is about a label or a dosing shorthand, answer about the label or the shorthand itself. The final line must be a check the pharmacist can do with the pack or label in hand for the medicine in this conversation.

Never diagnose, never prescribe or change a dose, never recommend one medicine instead of another, and never say a medicine is safe, genuine, counterfeit, expired or risk-free. Allergy conflicts, adverse reactions and drug choice belong to the pharmacist or doctor — say exactly that. Write in English; the app translates afterwards.`;

// ---- Deterministic retrieval helpers ---------------------------------------

function findDrugsInQuestion(question) {
  const text = String(question || '').toLowerCase();
  return DRUGS.filter((d) => {
    const name = d.name.toLowerCase();
    if (text.includes(name)) return true;
    // "metformin vs metoprolol" style questions name both; also allow the
    // first six characters so "sulfamethoxazol" still matches.
    return name.length > 6 && text.includes(name.slice(0, 6));
  }).slice(0, 2);
}

function drugRow(d) {
  return {
    name: d.name,
    class: d.class,
    common_strengths: d.common_strengths,
    use: d.use,
    look_alike_sound_alike: d.look_alike_sound_alike,
    notes: d.notes
  };
}

// A grounded, deterministic answer used only when the model cannot be reached.
function noteFallback(question, hits, drugs) {
  const note = hits[0] && hits[0].doc;
  const drug = drugs[0];
  if (note) {
    return `${drug ? `${drug.name}. ` : ''}${note.text} Before you hand it over: read the note above against the pack in your hand and confirm with the pharmacist — the discussion model did not answer this one.`;
  }
  return 'No counter note matched this question and the discussion model did not answer, so there is nothing here I can stand behind. Check it with the pharmacist or doctor rather than acting on a guess.';
}

// Small models occasionally collapse into repetition ("of-of-of…") or emit
// fragments. That must never reach a pharmacist, so degenerate output is
// detected and answered deterministically instead.
function isDegenerate(text) {
  const s = String(text || '');
  if (!s.trim()) return true;
  if (s.length > 1200) return true;
  if (/(\b[a-z]{1,4}-){6,}/i.test(s)) return true;
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Map();
  for (let i = 0; i + 2 < words.length; i += 1) {
    const key = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    const n = (seen.get(key) || 0) + 1;
    if (n >= 3) return true;
    seen.set(key, n);
  }
  return false;
}

// Light cleanup for model artefacts that read badly at a counter: doubled
// words ("and and"), stray double spaces, and dangling spaces before punctuation.
function tidyAnswer(s) {
  return String(s || '')
    .replace(/\b(\w+)\s+\1\b/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

// ---- Answer finalization (deterministic safety net) ------------------------

const LEAK = /(role\s*:|constraint\s*[0-9]+|you are medipilot|never diagnose|never prescribe|output only\s*(valid\s*)?json|action\s*:\s*answer|user question\s*:|source\s*text|target\s*language|^\s*[*\-•]\s*(?:role|constraint|user question|notes|language|drug names|step|action|thought)\b)/im;

// Markdown emphasis is fine (the chat renders it); only real prompt leakage is not.
function demarkdown(s) {
  return String(s || '').replace(/\*\*|__|`/g, '').replace(/^#{1,6}\s*/gm, '').trim();
}

// An answer that repeats the notes/question means the model echoed the prompt
// instead of answering. Cheap to detect, cheap to repair once.
function looksLikeEcho(text) {
  const t = String(text || '');
  if (/retrieved notes|demo formulary row|user:\s*pharmacist|pharmacist's question|how to answer|boundaries/i.test(t)) return true;
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^([*\-•]|\d+[.)])\s+/.test(l)).length;
  return bullets >= 2 && bullets >= lines.length * 0.5;
}

function isLeaky(answer, expectedLang) {
  const a = demarkdown(answer);
  if (a.trim().startsWith('*') || a.trim().startsWith('-') || a.trim().startsWith('•')) return true;
  return (
    LEAK.test(a.slice(0, 900)) ||
    (expectedLang && expectedLang !== 'en-IN' && !/[\u0590-\u08ff\u0900-\u097f\u0b80-\u0bff\u0c80-\u0cff]/.test(a))
  );
}

function stripMetaLines(s) {
  const lines = String(s || '').split(/\r?\n/);
  const kept = lines.filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (/^\s*[*\-•]\s*(?:role|constraint|user question|notes|language|drug names|step|action|thought|source text|target language)\b/i.test(t)) return false;
    if (/^(?:role|constraint|user question|notes|thought|action|source text|target language)\s*:/i.test(t)) return false;
    return true;
  });
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function stripAllBulletLines(s) {
  const lines = String(s || '').split(/\r?\n/);
  const kept = [];
  const seen = new Set();
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^\s*[*\-•]|^[-–—]/.test(t)) continue;
    const key = t.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(t);
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function localCanned(lang) {
  if (lang === 'hi-IN') return 'काउंटर के नोट्स इस बात की पुष्टि पूरी तरह नहीं करते। कृपया इसे सीधे फार्मासिस्ट या डॉक्टर से पूछें — यह केवल सहायक जानकारी है, चिकित्सकीय सलाह नहीं।';
  if (lang === 'ta-IN') return 'கவுண்டர் குறிப்புகள் இதற்கு உறுதியான உறுதிப்படுத்தலை வழங்கவில்லை. இதை நேரடியாக மருந்தாளர் அல்லது மருத்துவரிடம் உறுதிப்படுத்தவும் — இது ஆலோசனை மட்டுமே, மருத்துவ ஆலோசனை அல்ல.';
  if (lang === 'kn-IN') return 'ಕೌಂಟರ್ ಟಿಪ್ಪಣಿಗಳು ಇದಕ್ಕೆ ಖಚಿತ ದೃಢೀಕರಣ ನೀಡುವುದಿಲ್ಲ. ಇದನ್ನು ನೇರವಾಗಿ ಔಷಧಾಪಣೆಗಾರ ಅಥವಾ ವೈದ್ಯರೊಂದಿಗೆ ದೃಢೀಕರಿಸಿ — ಇದು ಬೆಂಬಲ ಮಾಹಿತಿ ಮಾತ್ರ, ವೈದ್ಯಕೀಯ ಸಲಹೆ ಅಲ್ಲ.';
  return 'The counter notes did not confirm this. Verify it directly with the pharmacist or doctor — decision-support only, not medical advice.';
}

// English answer → language-required final answer. One translation attempt:
// a second round-trip doubles the wait for no extra safety, and an honest
// English answer beats a slow one.
async function produceFinalAnswer(englishAnswer, lang) {
  const base = tidyAnswer(rxgemini.scrubText(stripMetaLines(String(englishAnswer || '')).trim())) || '';
  if (lang === 'en-IN' || !LANG_INSTR[lang]) {
    if (base.length >= 20 && !isLeaky(base, 'en-IN')) return { text: base, lang: 'en-IN' };
    const deBulleted = rxgemini.scrubText(stripAllBulletLines(base));
    if (deBulleted.length >= 20 && !isLeaky(deBulleted, 'en-IN')) return { text: deBulleted, lang: 'en-IN' };
    return { text: localCanned('en-IN'), lang: 'en-IN', canned: true };
  }
  try {
    const translated = await rxgemini.answerJson({
      system: `Translate this pharmacy-counter answer for a pharmacist into ${lang} (${LANG_INSTR[lang]}). Put ONLY the translated answer in the answer field, as 3 to 5 spoken sentences. Keep drug names in Latin script. No bullet points, no notes quotations, no meta commentary.`,
      prompt: `Answer to translate:\n${base.slice(0, 1200)}`,
      temperature: 0.2,
      maxTokens: 600
    });
    const cand = rxgemini.scrubText(stripAllBulletLines(String(translated).trim()));
    if (cand.length >= 20 && !isLeaky(cand, lang)) return { text: cand, lang };
  } catch {
    /* fall through to English */
  }
  if (base.length >= 20 && !LEAK.test(base)) return { text: base, lang: 'en-IN', untranslated: true };
  return { text: localCanned(lang), lang, canned: true };
}

// ---- The single grounded pass ---------------------------------------------

async function run({ question, languageCode, patientContext, summaryRef }) {
  const lang = languageCode || 'en-IN';
  const t0 = Date.now();
  const timings = {};

  // 1 — retrieval (deterministic, local)
  const hits = retrieve(question, 3);
  timings.retrieval_ms = Date.now() - t0;

  // 2 — formulary rows named in the question
  const drugs = findDrugsInQuestion(question);
  const rows = drugs.map(drugRow);

  // Keep the notes relevant to the medicines actually in play. Without this, a
  // question about "1-0-1 on the label" pulls the metformin note and the answer
  // drifts into a drug the pharmacist never mentioned.
  const GENERIC_NOTE_IDS = new Set(['frequency-1-0-1', 'label-verification']);
  const namedLower = drugs.map((d) => d.name.toLowerCase());
  let usableHits = hits;
  if (hits.length > 1) {
    const relevant = hits.filter((h) => {
      const docDrug = h.doc.drug ? String(h.doc.drug).toLowerCase() : null;
      if (!docDrug) return true;
      if (namedLower.length) return namedLower.includes(docDrug);
      return GENERIC_NOTE_IDS.has(h.doc.id);
    });
    if (relevant.length) usableHits = relevant;
  }

  const sources = [];
  const addSource = (s) => {
    if (s && s.id && !sources.some((x) => x.id === s.id)) sources.push(s);
  };
  usableHits.forEach((h) => addSource({ id: h.doc.id, title: h.doc.title }));
  drugs.forEach((d) => addSource({ id: `formulary:${d.name}`, title: `Demo formulary — ${d.name}` }));

  // 3 — memory recall, never allowed to block the answer
  const memStart = Date.now();
  let memRecall = { hits: [], source: 'local' };
  try {
    memRecall = await Promise.race([
      memory.recall(question, 3),
      new Promise((resolve) => setTimeout(() => resolve({ hits: [], source: 'skipped (slow)' }), MEMORY_BUDGET_MS))
    ]);
  } catch (e) {
    console.error('[mediagent memory recall]', e.message);
  }
  timings.memory_ms = Date.now() - memStart;

  // 4 — one model call, grounded in what code already found
  const notesBlock = usableHits.length
    ? usableHits.map((h) => `[${h.doc.id}] ${h.doc.title}\n${h.doc.text}`).join('\n\n')
    : '(no counter note matched this question)';

  const summaryBlock = summaryRef && summaryRef.id
    ? `WORKSHEET ON SCREEN (referenced by the pharmacist — verify numbers against it):\n` +
      `Id: ${summaryRef.id} · read at ${summaryRef.ts || 'unknown'} · mode ${summaryRef.mode || 'unknown'}\n` +
      `Read summary: ${summaryRef.context || ''}\n` +
      `Medicines: ${summaryRef.meds ? summaryRef.meds.map((m) => `${m.drug}${m.strength ? ' ' + m.strength : ''} — ${m.frequency || '?'}${m.timing ? ' · ' + m.timing : ''} — ${m.duration_days || '?'} days`).join(', ') : 'none read'}\n` +
      `Safety flags: ${summaryRef.flags ? summaryRef.flags.map((f) => `[${f.severity}] ${f.type || f.message}`).join('; ') : 'none raised'}`
    : '';

  const memBlock = memRecall.hits.length
    ? `EARLIER COUNTER DISCUSSIONS (may be relevant; verify before relying):\n${memRecall.hits.map((m, i) => `[M${i + 1}] ${String(m.text).slice(0, 300)}`).join('\n')}`
    : '';

  const prompt = [
    patientContext ? `Counter context: ${String(patientContext).slice(0, 700)}` : '',
    summaryBlock,
    `Notes:\n${notesBlock}`,
    rows.length ? `Formulary: ${JSON.stringify(rows)}` : '',
    memBlock,
    `Question: ${question}`
  ].filter(Boolean).join('\n\n');

  let englishAnswer = '';
  let modelFailed = false;
  const modelStart = Date.now();
  try {
    // JSON mode with an {answer} schema: measured ~2.7s vs ~6.7s in prose mode,
    // and it stops the model from mirroring the prompt as a bullet outline.
    try {
      englishAnswer = await rxgemini.answerJson({
        system: SYSTEM,
        prompt,
        temperature: 0.2,
        timeoutMs: MODEL_BUDGET_MS,
        maxTokens: 450,
        deadlineMs: MODEL_BUDGET_MS
      });

      // One tighter retry if the model looped or produced fragments.
      if (isDegenerate(englishAnswer)) {
        console.error('[mediagent] degenerate answer — one short retry');
        timings.retry = 'degenerate';
        englishAnswer = await rxgemini.answerJson({
          system: SYSTEM,
          prompt: `${prompt}\n\nKeep it to four short sentences. Do not repeat any phrase.`,
          temperature: 0.1,
          timeoutMs: MODEL_BUDGET_MS,
          maxTokens: 400,
          deadlineMs: MODEL_BUDGET_MS
        });
      }
    } catch (jsonErr) {
      // A truncated / empty JSON reply is worth one prose retry: the answer
      // itself is short, the schema only helps the model stop echoing.
      console.error('[mediagent] json answer failed, one prose retry:', jsonErr.message.slice(0, 120));
      timings.json_retry = true;
      englishAnswer = await rxgemini.chat({
        system: SYSTEM,
        parts: [{ text: prompt }],
        temperature: 0.2,
        timeoutMs: MODEL_BUDGET_MS,
        maxTokens: 450,
        deadlineMs: MODEL_BUDGET_MS
      });
    }

    // Belt and braces: an echoed, degenerate or empty answer is replaced by a
    // deterministic answer built from the retrieved note, so the pharmacist
    // never sees model debris.
    if (looksLikeEcho(englishAnswer) || isDegenerate(englishAnswer)) {
      console.error('[mediagent] unusable model answer — using the deterministic note answer');
      timings.echoed = true;
      englishAnswer = noteFallback(question, usableHits, drugs);
    }
  } catch (e) {
    modelFailed = true;
    console.error('[mediagent] model call failed:', e.message.slice(0, 160));
    englishAnswer = noteFallback(question, usableHits, drugs);
  }
  timings.model_ms = Date.now() - modelStart;
  if (process.env.MEDIAGENT_DEBUG) console.log('[mediagent raw]', String(englishAnswer).slice(0, 1200));

  // 5 — localize only when asked, and never at the cost of the answer
  const localizeStart = Date.now();
  const final = await produceFinalAnswer(englishAnswer, lang);
  timings.localize_ms = Date.now() - localizeStart;
  timings.total_ms = Date.now() - t0;

  // Trace = what the code actually did, in order. No invented tool calls.
  const trace = [];
  if (memRecall.hits.length) {
    trace.push({
      step: -1,
      thought: `Recalled ${memRecall.hits.length} earlier exchange(s) from ${memRecall.source} memory before answering (${timings.memory_ms} ms).`,
      action: 'memory_recall',
      observation: memRecall.hits.map((m) => String(m.text).slice(0, 120)).join(' | ')
    });
  }
  trace.push({
    step: 0,
    thought: hits.length
      ? `Retrieved ${hits.length} counter note(s) for this question in ${timings.retrieval_ms} ms: ${hits.map((h) => h.doc.id).join(', ')}.`
      : `No counter note matched this question (${timings.retrieval_ms} ms). Nothing to ground a specific claim in.`,
    action: 'search_kb',
    action_input: String(question).slice(0, 120),
    observation: hits.length ? hits.map((h) => `${h.doc.id} — ${h.doc.title}`).join('; ') : 'no match'
  });
  if (rows.length) {
    trace.push({
      step: 1,
      thought: `${rows.map((r) => r.name).join(' and ')} found in the demo formulary — used its class, strengths and look-alike neighbours${rows.some((r) => r.look_alike_sound_alike && r.look_alike_sound_alike.length) ? ` (look-alike: ${rows.flatMap((r) => r.look_alike_sound_alike || []).join(', ')})` : ''}.`,
      action: 'lookup_drug',
      action_input: rows.map((r) => r.name).join(', '),
      observation: rows.map((r) => `${r.name} · ${r.class} · ${(r.common_strengths || []).join('/')}`).join(' | ')
    });
  }
  trace.push({
    step: 2,
    thought: modelFailed
      ? 'The model call failed, so the answer was assembled deterministically from the retrieved note.'
      : `Grounded answer assembled in one pass (${timings.model_ms} ms)${final.lang !== 'en-IN' ? ` and localized to ${final.lang}` : ''}.`,
    action: 'answer',
    observation: ''
  });

  // Memory write stays off the critical path: a slow tenant must never delay
  // the answer the pharmacist is waiting for.
  const write = memory
    .remember({ question, answer: final.text, language: final.lang || lang, sources })
    .catch((e) => {
      console.error('[mediagent memory remember]', e.message);
      return { stored: false, cognee: false, reason: 'error' };
    });
  const quick = await Promise.race([write, new Promise((r) => setTimeout(() => r({ pending: true }), 900))]);

  return {
    answer: final.text,
    answerLang: final.lang,
    canned: Boolean(final.canned || final.untranslated),
    fallback: Boolean(modelFailed),
    trace,
    sources,
    timings,
    memory: {
      used: memRecall.hits.length,
      recallSource: memRecall.source,
      wroteToCognee: quick.cognee === true,
      writeQueued: quick.pending === true,
      reason: quick.reason || null
    }
  };
}

module.exports = { run, KB_COUNT: KB.length, DISC, byName };
