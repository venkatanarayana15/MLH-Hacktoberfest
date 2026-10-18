// RxSafe Lens — patient-facing report builder.
//
// Takes what the model read out of the patient's own upload (drugs, doses,
// timings, whatever the doctor wrote) and turns it into something a non-clinician
// can actually use: what each medicine is likely for, how to take it, what the
// document said, what to double-check, and what to ask the doctor.
//
// Rules this file enforces:
//   - We never invent a dose or a diagnosis. Anything unknown stays "not stated
//     on the document".
//   - "What it may be for" comes from the demo formulary (a prototype lookup),
//     and is labelled as a general reference, not a diagnosis.
//   - Every report carries the guardrail footer.
//   - The same content is used for the on-screen report and the emailed one, so
//     the patient gets exactly what was shown in the app.

const { DRUGS } = require('./formulary');

const PATIENT_GUARD =
  'This report was prepared from a document you uploaded, using an AI reading of that document. It is a summary to help you have a better conversation with your doctor or pharmacist — it is not a diagnosis, not a prescription, and not a substitute for professional advice. If anything here does not match what your doctor told you, your doctor is right.';

// Generic, patient-level phrasing for common drug classes. Deliberately
// conservative: it says what the medicine is generally used for, never what the
// patient has.
const CLASS_NOTES = [
  { re: /amlodipine|losartan|atenolol|metoprolol|ramipril|telmisartan|valsartan|enalapril/i, use: 'blood pressure', tip: 'Take at the same time each day. Get up slowly the first few days — it can make you light-headed.' },
  { re: /metformin/i, use: 'blood sugar', tip: 'Usually taken with or straight after food. Expect some stomach upset in the first couple of weeks.' },
  { re: /atorvastatin|rosuvastatin|simvastatin/i, use: 'cholesterol', tip: 'Take in the evening. Tell your doctor if you get unusual muscle aches.' },
  { re: /metformin|glimepiride|insulin|glipizide|sitagliptin/i, use: 'blood sugar', tip: 'Watch for shakiness, sweating or sudden hunger — that is low blood sugar; take sugar and tell your doctor.' },
  { re: /amoxicillin|azithromycin|cefuroxime|ciprofloxacin|sulfamethoxazole|trimethoprim|doxycycline/i, use: 'an infection', tip: 'Finish the full course even if you feel better. Tell your doctor straight away if you get a rash, swelling or trouble breathing.' },
  { re: /cetirizine|loratadine|montelukast/i, use: 'allergy or asthma symptoms', tip: 'Can make you drowsy — avoid driving until you know how it affects you.' },
  { re: /omeprazole|pantoprazole|ranitidine/i, use: 'stomach acid', tip: 'Take before breakfast for best effect.' },
  { re: /paracetamol|acetaminophen|ibuprofen|naproxen|diclofenac/i, use: 'pain or fever', tip: 'Check with a pharmacist before taking painkillers regularly, and never double up on paracetamol.' },
  { re: /salbutamol|albuterol|budesonide|montelukast/i, use: 'breathing / asthma', tip: 'Keep your reliever inhaler with you. If you need it more often than usual, see your doctor.' },
  { re: /sertraline|fluoxetine|escitalopram|amitriptyline|olanzapine/i, use: 'mood, anxiety or sleep', tip: 'Takes a few weeks to feel the full effect. Do not stop suddenly without asking your doctor.' },
  { re: /levothyroxine|thyroxine/i, use: 'thyroid', tip: 'Take on an empty stomach at the same time daily — food and calcium reduce absorption.' },
  { re: /prednisolone|methylprednisolone|dexamethasone/i, use: 'inflammation', tip: 'Never stop steroid tablets suddenly — always finish the prescribed course.' },
  { re: /ondansetron|domperidone/i, use: 'nausea', tip: 'Can help with sickness caused by other medicines.' },
  { re: /pantoprazole|rabeprazole|lansoprazole/i, use: 'stomach acid', tip: 'Best taken 30–60 minutes before your first meal of the day.' },
  { re: /ferrous|folic|calcium|vitamin d/i, use: 'a vitamin or mineral', tip: 'These can block other medicines — ask your pharmacist for a safe time to take them.' },
  { re: /clopidogrel|aspirin|warfarin|apixaban|rivaroxaban/i, use: 'blood thinner', tip: 'Bleeding is easier with these. Tell every doctor and dentist before a procedure.' }
];

function classNoteFor(name) {
  return CLASS_NOTES.find((c) => c.re.test(String(name || ''))) || null;
}

function formularyEntryFor(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  for (const [k, v] of Object.entries(DRUGS || {})) {
    const kk = String(k).toLowerCase();
    if (kk === key || kk.includes(key) || key.includes(kk)) return v;
  }
  return null;
}

// ---------- plain-language sections ----------
function medicineCard(med) {
  const name = String(med.drug || med.name || 'Unknown medicine');
  const cls = classNoteFor(name);
  const fb = formularyEntryFor(name);
  const parts = [];

  const how = [];
  if (med.strength) how.push(`${med.strength} strength`);
  if (med.frequency) how.push(`taken ${String(med.frequency).toLowerCase()}`);
  if (med.timing) how.push(String(med.timing).toLowerCase());
  const course = typeof med.duration_days === 'number' ? `${med.duration_days} days` : null;
  parts.push({
    label: 'How to take it',
    value: how.length ? `${how.join(', ')}${course ? `, for ${course}` : ''}.` : 'The document did not state how often to take it — ask your doctor or pharmacist.',
    tone: how.length ? 'ok' : 'warn'
  });

  parts.push({
    label: 'What it is usually used for',
    value: cls ? cls.use : fb && fb.use ? fb.use : 'Not stated on the document and not in our reference list — ask your doctor or pharmacist what it is for.',
    tone: cls || fb ? 'ok' : 'warn'
  });

  if (cls && cls.tip) parts.push({ label: 'Good to know', value: cls.tip, tone: 'info' });

  const warn = [];
  if (typeof med.confidence === 'number' && med.confidence < 0.7) {
    warn.push('We were not fully confident reading the name of this medicine from the photo — double-check the spelling against the box.');
  }
  if (med.ambiguity) warn.push(`There was a second possible reading of this name ("${med.ambiguity}"). Confirm which one it is.`);
  if (warn.length) parts.push({ label: 'Check this', value: warn.join(' '), tone: 'warn' });

  return { name, strength: med.strength || null, cards: parts };
}

function buildQuestions(meds, doc) {
  const qs = [];
  if (meds.length) qs.push('How long should I take each of these, and what exactly should I do if I miss a dose?');
  if (meds.some((m) => classNoteFor(m.drug))) qs.push('Are any of these interacting with each other, or with anything I already take?');
  if (meds.some((m) => /tablet|capsule|syrup|inhaler/i.test(String(m.form || '')))) qs.push('Are these meant to be taken with food, and does it matter which time of day?');
  qs.push('Is there anything on this list I should stop taking, or anything I should avoid (food, alcohol, other medicines)?');
  if (doc && doc.name) qs.push(`What should I do about the results/notes in "${doc.name}"?`);
  return qs.slice(0, 5);
}

// ---------- report object + renderers ----------
function buildReport({ docId, doc, meds, notes = '', flags = [], source = 'upload' }) {
  const safeMeds = (Array.isArray(meds) ? meds : []).filter((m) => m && (m.drug || m.name));
  const cards = safeMeds.map(medicineCard);
  const warnings = (Array.isArray(flags) ? flags : [])
    .filter((f) => f.severity === 'high' || f.severity === 'medium')
    .map((f) => ({ severity: f.severity, text: f.message || f.action || f.type }));

  return {
    id: `RPT-${docId || 'adhoc'}`,
    generated_at: new Date().toISOString(),
    source,
    doc: doc ? { id: doc.id, name: doc.name, kind: doc.kind, chars: doc.chars, uploaded_at: doc.meta && doc.meta.uploaded_at } : null,
    title: 'Your medicines — what this document says',
    medicine_count: cards.length,
    medicines: cards,
    raw_notes: String(notes || '').trim().slice(0, 4000),
    warnings,
    questions_for_doctor: buildQuestions(safeMeds, doc),
    guardrail: PATIENT_GUARD
  };
}

function reportToText(r) {
  const lines = [];
  lines.push(r.title);
  lines.push('='.repeat(r.title.length));
  lines.push('');
  if (r.doc) lines.push(`From: ${r.doc.name} (uploaded ${new Date(r.doc.uploaded_at || Date.now()).toLocaleString()})`);
  lines.push(`Prepared: ${new Date(r.generated_at).toLocaleString()}`);
  lines.push('');
  if (r.medicines.length) {
    lines.push(`MEDICINES FOUND (${r.medicines.length})`);
    for (const m of r.medicines) {
      lines.push(`- ${m.name}${m.strength ? ` · ${m.strength}` : ''}`);
      for (const c of m.cards) lines.push(`    ${c.label}: ${c.value}`);
    }
  } else {
    lines.push('MEDICINES FOUND: none we could read confidently from this document.');
  }
  if (r.raw_notes) {
    lines.push('');
    lines.push('NOTES FROM THE DOCUMENT');
    lines.push(r.raw_notes);
  }
  if (r.warnings.length) {
    lines.push('');
    lines.push('PLEASE CHECK');
    for (const w of r.warnings) lines.push(`- [${w.severity}] ${w.text}`);
  }
  lines.push('');
  lines.push('QUESTIONS TO ASK YOUR DOCTOR');
  for (const q of r.questions_for_doctor) lines.push(`- ${q}`);
  lines.push('');
  lines.push('-'.repeat(60));
  lines.push(r.guardrail);
  return lines.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function reportToHtml(r) {
  const med = (m) => `
    <div class="rmed">
      <h3>${esc(m.name)}${m.strength ? ` <span class="rstr">${esc(m.strength)}</span>` : ''}</h3>
      ${m.cards.map((c) => `<div class="rcard ${esc(c.tone)}"><span class="rl">${esc(c.label)}</span><span class="rv">${esc(c.value)}</span></div>`).join('')}
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI',system-ui,sans-serif;color:#101329;background:#f5f6fb;margin:0;padding:24px}
    .wrap{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e8eaf4;border-radius:16px;padding:28px}
    h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#5d6478;margin:22px 0 10px}
    .meta{font-size:12px;color:#888da3;margin-bottom:6px}
    .rmed{border:1px solid #e8eaf4;border-radius:12px;padding:14px;margin-bottom:12px}
    .rmed h3{margin:0 0 10px;font-size:15px}.rstr{color:#5d6478;font-weight:600;font-size:13px}
    .rcard{display:flex;gap:10px;font-size:13px;line-height:1.55;padding:5px 0;border-top:1px solid #f1f3fa}
    .rl{flex:0 0 130px;color:#5d6478;font-weight:600;font-size:12px}.rv{flex:1}
    .rcard.warn .rv{color:#8a4b06}.rcard.ok .rv{color:#101329}
    ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.7}
    .guard{margin-top:24px;padding-top:14px;border-top:1px dashed #d9dcec;font-size:11.5px;color:#5d6478;line-height:1.6}
  </style></head><body><div class="wrap">
    <h1>${esc(r.title)}</h1>
    <div class="meta">${r.doc ? `From ${esc(r.doc.name)} · ` : ''}prepared ${esc(new Date(r.generated_at).toLocaleString())}</div>
    <h2>Medicines found (${r.medicines.length})</h2>
    ${r.medicines.length ? r.medicines.map(med).join('') : '<p style="font-size:13.5px;color:#8a4b06">We could not read any medicine confidently from this document. Please ask your doctor or pharmacist to go through it with you.</p>'}
    ${r.raw_notes ? `<h2>Notes from the document</h2><p style="font-size:13.5px;line-height:1.6;white-space:pre-wrap">${esc(r.raw_notes)}</p>` : ''}
    ${r.warnings.length ? `<h2>Please check</h2><ul>${r.warnings.map((w) => `<li><strong>${esc(w.severity.toUpperCase())}:</strong> ${esc(w.text)}</li>`).join('')}</ul>` : ''}
    <h2>Questions to ask your doctor</h2><ul>${r.questions_for_doctor.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
    <div class="guard">${esc(r.guardrail)}</div>
  </div></body></html>`;
}

module.exports = { buildReport, reportToText, reportToHtml, PATIENT_GUARD, classNoteFor };