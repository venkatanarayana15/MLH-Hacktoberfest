// RxSafe Lens — deterministic safety layer.
// Gemma INTERPRETS the handwriting (drug name, strength, frequency, duration).
// This file CHECKS the interpretation against the demo formulary and the
// patient context the patient/pharmacist typed in.
//
// It never diagnoses, never says "safe to dispense", and never claims counterfeit
// detection. It raises review flags that a pharmacist must resolve.

const { byName, findLasaPair } = require('./formulary');

const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function runRxRules(extraction, contextText) {
  const findings = [];
  const meds = (extraction && extraction.medications) || [];
  const ctx = normalize(contextText);

  // 1. Every prescribed drug should exist in the demo formulary.
  for (const m of meds) {
    if (!byName(m.drug)) {
      findings.push({
        id: 'not_in_formulary',
        label: `"${m.drug}" is not in the demo formulary`,
        severity: 'high',
        why: 'An unrecognised drug name cannot be checked for strength, class, allergy or look-alike risk. This is exactly where a misreading turns into a dispensing error.',
        action: 'Pharmacist to confirm the drug name on the slip and check it against the dispensing system before issue.'
      });
    }
  }

  // 2. Look-alike / sound-alike pairs inside a single prescription.
  for (let i = 0; i < meds.length; i += 1) {
    for (let j = i + 1; j < meds.length; j += 1) {
      const a = meds[i];
      const b = meds[j];
      const pairs = [
        ...(byName(a.drug) ? findLasaPair(a.drug) : []),
        ...(byName(b.drug) ? findLasaPair(b.drug) : [])
      ];
      const hit = pairs.find(
        (p) => normalize(p.from) === normalize(b.drug) || normalize(p.to) === normalize(a.drug) || normalize(p.to) === normalize(b.drug)
      );
      if (hit) {
        findings.push({
          id: 'lasa_pair',
          label: `Look-alike/sound-alike pair on the same slip: ${a.drug} and ${b.drug}`,
          severity: 'high',
          why: `${hit.to} and ${hit.from} are a documented confusion pair. Dispensing the wrong one is a classic and preventable dispensing error.`,
          action: 'Read both names aloud against the formulary before selecting the pack, and confirm each separately with the patient.'
        });
      }
    }
  }

  // 3. Allergy keyword vs prescribed drug class.
  if (ctx) {
    const saidAllergy = /(allerg|allergic|rash|reaction|anaphyla)/.test(ctx);
    if (saidAllergy) {
      for (const m of meds) {
        const d = byName(m.drug);
        const kws = (d && d.allergy_keywords) || [];
        const matched = kws.find((k) => ctx.includes(normalize(k)));
        if (matched) {
          findings.push({
            id: 'allergy_conflict',
            label: `Patient reports an allergy term ("${matched}") that matches ${m.drug}`,
            severity: 'high',
            why: `${m.drug} is in the same family as "${matched}". The patient context and the prescription point in opposite directions; this cannot be resolved by the software.`,
            action: 'STOP and verify the allergy history with the patient and the prescriber before dispensing. Do not rely on this tool for the decision.'
          });
        }
      }
    }
  }

  // 4. Duplicate therapy: same drug or same class twice on one slip.
  const seen = new Map();
  for (const m of meds) {
    const key = (byName(m.drug) || {}).class || normalize(m.drug);
    if (seen.has(key)) {
      findings.push({
        id: 'duplicate_therapy',
        label: `Two medicines from the same class on one slip (${seen.get(key)} and ${m.drug})`,
        severity: 'high',
        why: 'Duplicate therapy is a classic source of overdose. Check whether it is intentional combination therapy before dispensing.',
        action: 'Confirm with the prescriber whether both were intended, and check the total daily dose of the shared class.'
      });
    } else {
      seen.set(key, m.drug);
    }
  }

  // 5. Existing medicines reported but never named -> interaction cannot be checked.
  const unnamedExisting = /(?:taking|already (?:on|taking)|on a medicine|on some medicine|on medication|blood pressure|bp|diabet|thyroid|cholesterol)/.test(ctx);
  const namedAny = meds.some((m) => normalize(ctx).includes(normalize(m.drug)));
  if (unnamedExisting && !namedAny && /(?:blood pressure|bp|thyroid|cholesterol|diabet)/.test(ctx)) {
    findings.push({
      id: 'existing_med_unnamed',
      label: 'Patient reports an existing condition/medicine without naming the drug',
      severity: 'high',
      why: 'Interactions cannot be checked against a medicine that has no name. The patient said "a medicine for blood pressure" - that is not enough to verify safety.',
      action: 'Ask the patient for the exact name, or for a photo of the strip/box, before completing the safety check.'
    });
  }

  // 6. Strength not among the common strengths for that drug.
  for (const m of meds) {
    const d = byName(m.drug);
    if (d && m.strength && !d.common_strengths.some((s) => normalize(s) === normalize(m.strength))) {
      findings.push({
        id: 'strength_uncommon',
        label: `${m.drug} ${m.strength} is not a common strength in the demo formulary`,
        severity: 'medium',
        why: `The demo formulary lists ${d.common_strengths.join(', ')} for ${m.drug}. An unusual strength may be a misread digit rather than a real preparation.`,
        action: 'Confirm the strength against the pack and the dispensing system.'
      });
    }
  }

  // 7. No dose frequency written.
  for (const m of meds) {
    if (!m.frequency || /^(?:unspecified|unknown|not clear|none)$/i.test(String(m.frequency))) {
      findings.push({
        id: 'frequency_missing',
        label: `No clear dosing frequency for ${m.drug}`,
        severity: 'high',
        why: 'A drug without a frequency is either an incomplete prescription or a handwriting miss. "Take the tablet" with no count is how double-dosing happens.',
        action: 'Ask the prescriber or patient for the number of times per day, and write it on the label.'
      });
    }
  }

  // 8. No duration.
  if (meds.length && meds.every((m) => !m.duration_days && !/day|week|month/i.test(String(m.duration || '')))) {
    findings.push({
      id: 'duration_missing',
      label: 'No treatment duration written on the slip',
      severity: 'medium',
      why: 'Without a duration the patient cannot know when to stop, and the course of the medicine is unbounded.',
      action: 'Confirm the number of days with the prescriber and record it on the label.'
    });
  }

  // 9. No timing relation to food/bedtime.
  const timing = meds.map((m) => String(m.timing || '')).join(' ');
  if (meds.length && !/(food|meal|bed|night|empty stomach|morning|before|after)/i.test(timing)) {
    findings.push({
      id: 'timing_missing',
      label: 'No instruction about food or timing',
      severity: 'low',
      why: 'For several common medicines (biguanides, NSAIDs, statins) timing materially changes absorption and tolerability.',
      action: 'Confirm whether it is before or after food and record it on the label.'
    });
  }

  // 10. Gemma's own confidence on the drug name must clear the review bar.
  for (const m of meds) {
    const conf = typeof m.confidence === 'number' ? m.confidence : null;
    if ((conf !== null && conf < 0.7) || m.ambiguity) {
      findings.push({
        id: 'ambiguous_drug_name',
        label: `"${m.drug}" read at confidence ${conf === null ? 'unknown' : conf}${m.ambiguity ? `, competing reading "${m.ambiguity}"` : ''}`,
        severity: 'high',
        why: 'A drug name is the one field where a misreading changes what the patient swallows. Below 0.7 confidence the reading is not good enough to select a pack from.',
        action: 'Confirm the name with the prescriber or against the patient\'s existing medicines before dispensing.'
      });
    }
  }

  return findings;
}

module.exports = { runRxRules };