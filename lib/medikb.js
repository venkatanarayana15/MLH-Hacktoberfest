// MediPilot — DEMO knowledge corpus for RAG retrieval.
// Prototype reference material only: NOT a clinical reference, NOT a drug
// label, NOT a substitute for the pharmacist's professional judgement. Same
// boundary as the rest of RxSafe Lens. Deliberately small and hand-auditable.

const KB = [
  {
    id: 'metformin-food',
    title: 'Metformin: take with food',
    drug: 'Metformin',
    text:
      'Metformin is commonly taken with or immediately after food. Taking it on an empty stomach increases stomach upset and nausea. For twice-daily schedules (1-0-1), the tablets are usually taken after breakfast and after dinner.'
  },
  {
    id: 'metformin-missed-dose',
    title: 'Metformin: missed dose handling',
    drug: 'Metformin',
    text:
      'If a metformin dose is missed and the next dose is due soon, the general practice is to skip the missed tablet and continue the schedule. Doubling up is avoided. The pharmacist explains this; the software only rehearses the wording.'
  },
  {
    id: 'metoprolol-abrupt-stop',
    title: 'Metoprolol: do not stop abruptly',
    drug: 'Metoprolol',
    text:
      'Beta blockers like metoprolol are generally not stopped suddenly; abrupt withdrawal can worsen the condition the tablet controls. Tapering is prescriber-directed. A patient who stopped taking it and feels palpitations should be guided back to the prescriber.'
  },
  {
    id: 'sulfa-allergy',
    title: 'Sulfa allergy and sulfonamide antibiotics',
    drug: 'Sulfamethoxazole',
    text:
      'A reported sulfa allergy against a prescribed sulfonamide antibiotic (e.g. sulfamethoxazole) is a STOP situation for this tool: the software cannot verify the allergy history or its severity. Cross-reactivity questions are settled with the patient and the prescriber, never from a screen.'
  },
  {
    id: 'lasa-met',
    title: 'Look-alike / sound-alike: Metformin vs Metoprolol',
    drug: 'Metformin',
    text:
      'Metformin (biguanide, type 2 diabetes) and metoprolol (beta blocker, hypertension/angina) are a classic look-alike/sound-alike confusion pair at Indian counters. One treats blood sugar, the other blood pressure — they are not interchangeable. A low-confidence read between these two must be resolved before pack selection.'
  },
  {
    id: 'frequency-1-0-1',
    title: 'Reading the 1-0-1 shorthand',
    drug: null,
    text:
      'The shorthand 1-0-1 means one dose in the morning, none in the afternoon, one at night (twice daily). 1-1-1 is three times daily. Morning-afternoon-night is the standard Indian prescription convention and what the label repeats.'
  },
  {
    id: 'interaction-bp-diabetes',
    title: 'Blood-pressure medicine plus diabetes medicine',
    drug: null,
    text:
      'Patients often take both an antihypertensive and an antidiabetic. No interaction is assumed or asserted here: the tool never claims combinations are safe. It checks that both drugs are named, and if one is unnamed it asks the patient for the exact name or a photo of the strip.'
  },
  {
    id: 'label-verification',
    title: 'Label verification before handover',
    drug: null,
    text:
      'Before handover the pharmacist reads the label back: drug name, strength, how many times a day, before/after food, duration. This is the manual double-check the software\u2019s worksheet supports — it never replaces it.'
  }
];

// Very small, transparent retriever: term-overlap scoring (bag of words +
// drug-name boost). Auditable by design — a judge can read it in 30 seconds.
const tokenize = (s) =>
  String(s || '')
    .toLowerCase()
    // Keep dosing shorthand intact: "1-0-1" / "1 - 0 - 1" must survive as a term,
    // otherwise "explain 1-0-1" retrieves nothing about the shorthand itself.
    .replace(/(\d)\s*-\s*(\d)\s*-\s*(\d)/g, '$1$2$3')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[0-9]+$/.test(w));

// Shorthand/label questions should surface the shorthand and label notes first,
// not whichever drug happened to share a word with the question.
const PHRASE_BOOSTS = [
  { test: /(^|\s)\d-\d-\d(\s|$)|1\s*-\s*0\s*-\s*1|\b1-0-1\b|twice daily|after food|before food/i, ids: ['frequency-1-0-1', 'label-verification'], boost: 0.5 },
  { test: /read (it |the label |that )?back|read aloud|label|hand(ing)? over|explain/i, ids: ['label-verification'], boost: 0.3 },
  { test: /allerg/i, ids: ['sulfa-allergy'], boost: 0.4 },
  { test: /missed|skip(ped)?|forgot/i, ids: ['metformin-missed-dose'], boost: 0.45 },
  { test: /stop(ped)?|abrupt|withdraw/i, ids: ['metoprolol-abrupt-stop'], boost: 0.45 },
  { test: /met-\?|illegible|look.?alike|sound.?alike|confus/i, ids: ['lasa-met'], boost: 0.4 }
];

function retrieve(query, k = 3) {
  const raw = String(query || '');
  const q = tokenize(raw);
  if (!q.length) return [];
  const scored = KB.map((d) => {
    const hay = tokenize(`${d.title} ${d.drug || ''} ${d.text}`);
    const hit = new Set(q.filter((w) => hay.includes(w)));
    let score = hit.size / q.length;
    if (d.drug && q.includes(d.drug.toLowerCase())) score += 0.35;
    for (const b of PHRASE_BOOSTS) {
      if (b.ids.includes(d.id) && b.test.test(raw)) score += b.boost;
    }
    return { doc: d, score };
  })
    .filter((r) => r.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

module.exports = { KB, retrieve };
