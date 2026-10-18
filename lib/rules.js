// ClauseLens rules layer — deterministic code that finds FACTS, not judgments.
// Every finding is objective: a pattern matched, an absence detected.
// Gemma weighs these facts together; this layer never speculates.

const RULES = [
  {
    id: 'deposit_far_above_norm',
    label: 'Deposit far above even Bengaluru norm (>10 months)',
    severity: 'high',
    patterns: [/\bdeposit\b[^.;]{0,90}?\b(?:eleven|twelve|1[1-9]|[2-9][0-9])\s*months?\b/i],
    why: 'Bengaluru practice runs 2-10 months and the Model Tenancy Act 2021 recommends 2-3. Above 10 months is far outside every norm - and it inflates the money at risk in a dispute.',
    tip: 'Negotiate down to 2-3 months. If the owner insists, demand itemized deductions and a written refund timeline in exchange.'
  },
  {
    id: 'deposit_above_mta',
    label: 'Deposit above Model Tenancy Act recommendation (4-10 months)',
    severity: 'medium',
    patterns: [/\bdeposit\b[^.;]{0,90}?\b(?:four|five|six|seven|eight|nine|ten|[4-9]|10)\s*months?\b/i],
    why: 'Bengaluru-typical, but above the Model Tenancy Act 2021 recommendation of 2-3 months for residential tenancies. Common - yet negotiable.',
    tip: 'Ask for 2-3 months. Cite the Model Tenancy Act 2021 in your negotiation.'
  },
  {
    id: 'no_refund_timeline',
    label: 'Deposit refund has no timeline or itemization',
    severity: 'high',
    detector: (text) => {
      const sentences = String(text).split(/[.;\n]/);
      const s = sentences.find((x) => /deposit/i.test(x) && /(?:refund|return|repaid)/i.test(x));
      return Boolean(s) && !/\b\d+\s*(?:days?|weeks?)\b/i.test(s);
    },
    why: '"Refunded after deduction of damages" with no timeline and no itemization is the #1 cause of deposit disputes. The owner controls when - and how much - you get back.',
    tip: 'Insert: "Deposit shall be refunded within 30 days of vacating, with itemized deductions supported by bills."'
  },
  {
    id: 'blank_fields',
    label: 'Blank fields in the agreement',
    severity: 'high',
    patterns: [/_{3,}/, /\b(?:Rs\.?|₹)\s*_{2,}/, /\b_{2,}\s*(?:day|date|month|year)\b/i],
    why: 'Blank dates, amounts, or names can be filled in after you sign. What gets written later binds you.',
    tip: 'Fill every field by hand before signing and initial each page.'
  },
  {
    id: 'entry_without_notice',
    label: 'Owner entry without prior notice',
    severity: 'high',
    patterns: [/(?:enter|access|inspect)[^.;]{0,80}?(?:at\s*any\s*time|without\s*(?:prior\s*)?notice|anytime)/i],
    why: 'Entry "at any time" removes your right to quiet enjoyment. Standard practice is 24 hours notice, in your presence, a reasonable number of times per month.',
    tip: 'Replace with: "Owner may inspect with 24 hours prior notice, in the Tenant\'s presence, not more than twice a month."'
  },
  {
    id: 'lock_in_no_exit',
    label: 'Lock-in period with no exit clause',
    severity: 'high',
    detector: (text) => {
      const hasLockIn = /lock[- ]?in/i.test(text);
      const hasExit = /(?:exit|early\s*termination|break\s*(?:the\s*)?(?:lock|clause)|terminate\s*early)/i.test(text);
      return hasLockIn && !hasExit;
    },
    why: 'A lock-in with no exit clause means you pay rent for the full period even if you must leave - job transfer, emergency, anything.',
    tip: 'Add an exit clause: "Tenant may terminate early with one month notice, forfeiting one month deposit (not the full lock-in rent)."'
  },
  {
    id: 'rent_escalation_high',
    label: 'Aggressive rent escalation on renewal',
    severity: 'medium',
    patterns: [/(?:increase|escalation|enhancement)[^.;]{0,80}?(\d{1,2})\s*%/i],
    check: (m) => parseInt(m[1], 10) > 10,
    why: 'Double-digit annual escalation compounds fast. Bengaluru renewals commonly run 5-10%.',
    tip: 'Negotiate 5-8% fixed, or "by mutual consent" with a cap stated in the agreement.'
  },
  {
    id: 'verbal_assurances_excluded',
    label: 'Verbal assurances explicitly excluded',
    severity: 'medium',
    patterns: [/(?:verbal|oral|spoken)[^.;]{0,60}(?:assur|promis|agree)[^.;]{0,80}(?:not|shall\s*not|no)[^.;]{0,30}(?:part|binding|effect)/i],
    why: 'This clause voids every promise made during the visit - "painting will be done", "water problem will be fixed". If it matters, it must be written.',
    tip: 'Move every verbal promise into the agreement as numbered clauses before signing.'
  },
  {
    id: 'maintenance_open_ended',
    label: 'Open-ended maintenance liability',
    severity: 'medium',
    patterns: [/maintenance[^.;]{0,80}(?:as\s*per\s*actuals|as\s*applicable|decided\s*by\s*(?:the\s*)?owner|borne\s*by\s*the\s*tenant)/i],
    why: '"As per actuals" or "as decided by Owner" is a blank cheque - you cannot budget it and cannot dispute it later.',
    tip: 'Cap it: "Maintenance Rs X/month included in rent; repairs due to normal wear and tear by Owner, damages by Tenant at actuals with receipts."'
  },
  {
    id: 'no_stamp_mention',
    label: 'No stamp paper / e-stamp mentioned',
    severity: 'info',
    detector: (text) => !/stamp|notar|registration/i.test(text),
    why: 'Karnataka rental agreements are executed on stamp paper (typically Rs 100-200 e-stamp for 11 months). No stamp means weaker evidentiary value in a dispute.',
    tip: 'Insist on e-stamp paper (Kaveri Online) and keep a scanned copy; register the agreement if the term exceeds 11 months.'
  }
];

function runRules(text) {
  const findings = [];
  for (const rule of RULES) {
    if (rule.detector) {
      if (rule.detector(text)) {
        findings.push({ id: rule.id, label: rule.label, severity: rule.severity, why: rule.why, tip: rule.tip, evidence: null });
      }
      continue;
    }
    for (const pattern of rule.patterns) {
      const m = String(text).match(pattern);
      if (m && (!rule.check || rule.check(m))) {
        findings.push({ id: rule.id, label: rule.label, severity: rule.severity, why: rule.why, tip: rule.tip, evidence: m[0] });
        break;
      }
    }
  }
  return findings;
}

module.exports = { runRules, RULES };
