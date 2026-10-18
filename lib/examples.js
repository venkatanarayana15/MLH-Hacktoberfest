// ClauseLens prepared agreements — 3 teaching examples with cached Gemma reports.
// These make the demo Wi-Fi-proof: the forensic reports were pre-run with Gemma
// and are served verbatim in offline mode. Cached runs are always labeled honestly.

const EXAMPLES = [
  {
    id: 'ex1',
    label: 'The Predatory Agreement (Whitefield)',
    kind: 'predatory',
    text: `RENTAL AGREEMENT

This Rental Agreement is made on ____ day of October 2026 between Mr. Ramesh Gowda (hereinafter "the Owner") and Ms. Divya Nair (hereinafter "the Tenant") for the premises at Flat 302, Green Meadows Apartments, Whitefield, Bengaluru.

1. TERM: The tenancy shall be for a period of 11 months commencing from the date of this agreement.

2. RENT: The Tenant shall pay a monthly rent of Rs 28,000.

3. SECURITY DEPOSIT: The Tenant shall pay a security deposit of Rs 2,80,000 equivalent to ten months rent. The deposit shall be refunded after deduction of damages at the time of vacating.

4. LOCK-IN: The Tenant shall not vacate the premises during the first 11 months of the tenancy under any circumstances.

5. RENT ESCALATION: The rent shall be increased by 15% upon renewal.

6. ENTRY: The Owner or his representatives may enter the premises at any time for inspection.

7. NOTICE: The Tenant shall give two months written notice before vacating. The Owner may terminate the tenancy with one month written notice.

8. MAINTENANCE: All maintenance charges as per actuals shall be borne by the Tenant.

9. VERBAL ASSURANCES: Any verbal assurances given by the Owner shall not form part of this agreement.

10. PAINTING: The Tenant shall repaint the premises at his own cost before vacating, or pay painting charges as decided by the Owner.

Signed: ____________ (Owner)        ____________ (Tenant)`
  },
  {
    id: 'ex2',
    label: 'The Fair Agreement (HSR Layout)',
    kind: 'fair',
    text: `RENTAL AGREEMENT

This agreement is made on 5th October 2026 between Mr. Suresh Kumar ("Owner") and Mr. Arjun Mehta ("Tenant") for Flat 104, Lake View Residency, HSR Layout, Bengaluru, executed on Karnataka e-stamp paper of Rs 200.

1. TERM: 11 months from 1st November 2026.

2. RENT: Rs 25,000 per month, payable by the 5th of each month.

3. DEPOSIT: Rs 75,000 (three months rent), refundable within 30 days of vacating, after itemized deductions supported by bills.

4. NOTICE: Either party may terminate this agreement with one month written notice.

5. ESCALATION: Rent increase of 5% on renewal, by mutual consent.

6. ENTRY: The Owner may inspect the premises with 24 hours prior notice, not more than twice a month, in the Tenant's presence.

7. MAINTENANCE: Society maintenance of Rs 2,000 per month is included in the rent. Repairs due to normal wear and tear shall be borne by the Owner; damages caused by the Tenant at actuals with receipts.

8. PAINTING: Not applicable for tenancies under 24 months.

Both parties hold a scanned copy of this e-stamp agreement.`
  },
  {
    id: 'ex3',
    label: 'The Subtly Bad Agreement (Koramangala)',
    kind: 'subtle',
    text: `RENTAL AGREEMENT

Made on 10th October 2026 between Mrs. Lakshmi Devi ("Owner") and Mr. Karthik Rao ("Tenant") for Flat 201, Sunrise Enclave, Koramangala, Bengaluru.

1. TERM: 11 months from 1st November 2026.

2. RENT: Rs 32,000 per month.

3. DEPOSIT: Rs 3,20,000 equivalent to ten months rent, refundable within 60 days of vacating after deductions.

4. NOTICE: One month written notice by either party.

5. ENTRY: The Owner may inspect the premises once a month with prior intimation.

6. REPAIRS: Interior repairs, plumbing and electrical shall be borne by the Tenant.

7. RENEWAL: Rent enhancement as mutually agreed at renewal.

8. The Owner is not responsible for any facilities mentioned in the listing advertisement; only the clauses herein apply.

Note: This is a standard format agreement used by the Owner for all properties.`
  }
];

const CACHED = {
  ex1: {
    sourceText: EXAMPLES[0].text,
    report: {
      verdict: 'landlord_heavy',
      confidence: 0.92,
      flags: [
        {
          type: 'Deposit: 10 months with no refund timeline',
          severity: 'high',
          quoted_evidence: 'The Tenant shall pay a security deposit of Rs 2,80,000 equivalent to ten months rent. The deposit shall be refunded after deduction of damages at the time of vacating.',
          why_risky: 'Ten months (Rs 2,80,000) is Bengaluru-typical but above the Model Tenancy Act 2021 recommendation of 2-3 months - and "refunded after deduction of damages" has no timeline and no itemization. The owner controls when, and how much, you get back.',
          negotiation_tip: 'Negotiate 2-3 months; at minimum insert "refunded within 30 days with itemized deductions supported by bills".'
        },
        {
          type: 'Blank date field',
          severity: 'high',
          quoted_evidence: 'This Rental Agreement is made on ____ day of October 2026',
          why_risky: 'Blank fields can be filled in after you sign. What gets written later binds you.',
          negotiation_tip: 'Fill every blank by hand and initial each page before signing.'
        },
        {
          type: 'Lock-in with no exit clause',
          severity: 'high',
          quoted_evidence: 'The Tenant shall not vacate the premises during the first 11 months of the tenancy under any circumstances.',
          why_risky: '"Under any circumstances" means you owe 11 months of rent even if you must leave - job transfer, emergency, anything. No exit clause exists anywhere in this agreement.',
          negotiation_tip: 'Add: "Tenant may terminate early with one month notice, forfeiting one month deposit."'
        },
        {
          type: 'Owner entry at any time',
          severity: 'high',
          quoted_evidence: 'The Owner or his representatives may enter the premises at any time for inspection.',
          why_risky: 'This removes your right to quiet enjoyment. Standard is 24 hours notice, in your presence, at most twice a month.',
          negotiation_tip: 'Replace with the 24-hour-notice formulation.'
        },
        {
          type: 'Asymmetric notice period',
          severity: 'medium',
          quoted_evidence: 'The Tenant shall give two months written notice before vacating. The Owner may terminate the tenancy with one month written notice.',
          why_risky: 'You need two months to leave; the owner needs only one to remove you. One-sided terms like this rarely survive negotiation - most tenants just never notice them.',
          negotiation_tip: 'Make it symmetric: one month written notice by either party.'
        },
        {
          type: '15% rent escalation',
          severity: 'medium',
          quoted_evidence: 'The rent shall be increased by 15% upon renewal.',
          why_risky: 'Double-digit escalation compounds fast; Bengaluru renewals commonly run 5-10%.',
          negotiation_tip: 'Negotiate 5-8% fixed, or "by mutual consent" with a stated cap.'
        },
        {
          type: 'Open-ended maintenance',
          severity: 'medium',
          quoted_evidence: 'All maintenance charges as per actuals shall be borne by the Tenant.',
          why_risky: '"As per actuals" is a blank cheque - unbudgetable and undisputable later.',
          negotiation_tip: 'Cap it: fixed monthly maintenance included in rent; damages at actuals with receipts.'
        },
        {
          type: 'Verbal assurances voided',
          severity: 'medium',
          quoted_evidence: 'Any verbal assurances given by the Owner shall not form part of this agreement.',
          why_risky: 'Every promise made during the visit - painting, repairs, fixtures - is now void. If it matters, it must be written.',
          negotiation_tip: 'Move all verbal promises into numbered clauses before signing.'
        },
        {
          type: 'Open-ended painting charges',
          severity: 'medium',
          quoted_evidence: 'or pay painting charges as decided by the Owner',
          why_risky: '"As decided by the Owner" is another blank cheque on top of a full repaint at your cost.',
          negotiation_tip: 'Replace with a fixed amount or "normal wear and tear excepted".'
        }
      ],
      missing_protections: [
        'Deposit refund timeline (30 days) with itemized deductions',
        'Early-exit clause despite the 11-month lock-in',
        '24-hour notice + presence requirement for owner entry',
        'Symmetric notice period',
        'Stamp paper / e-stamp execution clause',
        'Caps on maintenance and painting charges'
      ],
      plain_summary: 'This agreement is heavily one-sided: the maximum-at-risk combination of a 10-month deposit with no refund timeline, an 11-month lock-in with no exit, entry at any time, and every open-ended cost (maintenance, painting, escalation) pointed at you. The verbal-assurances clause also voids anything promised during the visit. Negotiate the deposit terms, the exit clause, and the entry clause before signing - those three are where real money is lost.',
      verification_steps: [
        'Verify ownership: ask for the khata or latest tax receipt in the owner\'s name',
        'Execute on Karnataka e-stamp paper (Kaveri Online), typically Rs 100-200 for 11 months',
        'Register the agreement if the term exceeds 11 months',
        'For disputes: Karnataka Rent Authority; keep every payment receipt'
      ]
    }
  },
  ex2: {
    sourceText: EXAMPLES[1].text,
    report: {
      verdict: 'tenant_favorable',
      confidence: 0.88,
      flags: [],
      missing_protections: [
        'Registration clause (optional for 11-month terms, but worth adding for extra evidentiary weight)'
      ],
      plain_summary: 'This agreement follows standard tenant protections: a 3-month deposit with a 30-day itemized refund, symmetric one-month notice, 24-hour-notice entry in your presence, capped escalation by mutual consent, and a clear wear-and-tear repair split. Executed on e-stamp paper. Nothing here needs renegotiation - this is what a fair Bengaluru agreement looks like.',
      verification_steps: [
        'Verify the e-stamp certificate number on Kaveri Online (kaverionline.karnataka.gov.in)',
        'Confirm ownership via khata or latest tax receipt',
        'Keep the scanned copy both parties hold'
      ]
    }
  },
  ex3: {
    sourceText: EXAMPLES[2].text,
    report: {
      verdict: 'mixed',
      confidence: 0.82,
      flags: [
        {
          type: 'All plumbing and electrical repairs on the tenant',
          severity: 'high',
          quoted_evidence: 'Interior repairs, plumbing and electrical shall be borne by the Tenant.',
          why_risky: 'Plumbing and electrical systems are the property\'s core infrastructure. Making the tenant bear them - with no wear-and-tear split and no receipts requirement - hands the owner a blank cheque for the building\'s aging systems.',
          negotiation_tip: 'Split it: "Repairs due to normal wear and tear (including plumbing and electrical) by the Owner; damages caused by the Tenant at actuals with receipts."'
        },
        {
          type: 'Deposit: 10 months, 60-day refund, no itemization',
          severity: 'medium',
          quoted_evidence: 'Rs 3,20,000 equivalent to ten months rent, refundable within 60 days of vacating after deductions.',
          why_risky: 'Ten months is Bengaluru-typical but above the Model Tenancy Act recommendation. A 60-day refund (double the 30-day norm) with unitemized "deductions" delays your money and hides how it was spent.',
          negotiation_tip: 'Ask for 30-day refund with itemized deductions supported by bills.'
        },
        {
          type: 'Advertisement promises disclaimed',
          severity: 'medium',
          quoted_evidence: 'The Owner is not responsible for any facilities mentioned in the listing advertisement; only the clauses herein apply.',
          why_risky: 'This clause lets the owner walk back anything the listing promised - the gym, the parking, the power backup. You sign based on the ad, then live by this clause.',
          negotiation_tip: 'List the advertised facilities you are paying for as numbered clauses in the agreement.'
        },
        {
          type: 'Undefined rent escalation',
          severity: 'low',
          quoted_evidence: 'Rent enhancement as mutually agreed at renewal.',
          why_risky: '"As mutually agreed" with no cap means zero leverage at renewal - the owner names a number and your alternative is moving out.',
          negotiation_tip: 'Cap it now: "increase not exceeding 5-8% per annum".'
        },
        {
          type: 'Vague entry terms',
          severity: 'low',
          quoted_evidence: 'The Owner may inspect the premises once a month with prior intimation.',
          why_risky: '"Prior intimation" is undefined - is that 24 hours or a knock on the door? Standard is 24 hours notice in your presence.',
          negotiation_tip: 'Specify: "with 24 hours prior notice, in the Tenant\'s presence".'
        }
      ],
      missing_protections: [
        'Itemized deduction requirement for the deposit refund',
        'Wear-and-tear repair split (owner bears normal wear)',
        '30-day refund timeline norm',
        'Stamp paper / e-stamp execution clause',
        'Painting clause (silent here - clarify before signing)'
      ],
      plain_summary: 'This one looks standard at first glance - and that is the point. The deposit is Bengaluru-typical but the refund takes 60 days with no itemization, ALL plumbing and electrical repairs are on you, and the advertisement disclaimer lets the owner walk back anything the listing promised. Nothing here is illegal; all of it is negotiable - before you sign.',
      verification_steps: [
        'Insist on e-stamp paper execution (none is mentioned)',
        'Verify ownership via khata or tax receipt',
        'Get the advertised facilities written into the agreement',
        'For disputes: Karnataka Rent Authority'
      ]
    }
  }
};

function getCachedReport(id) {
  return CACHED[id] || null;
}

module.exports = { EXAMPLES, getCachedReport };
