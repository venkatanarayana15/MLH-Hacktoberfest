// RxSafe Lens — three SYNTHETIC prescription samples with cached worksheets.
// Nothing here is a real patient, a real prescription, or a real drug record.
// The handwriting lines are rendered to images by tools/render-samples.html and
// captured as PNGs; those PNGs are what the demo uploads, so Gemma does the
// reading for real.

const SAMPLES = [
  {
    id: 'rx1',
    label: 'Sample 1 — Clear handwriting',
    kind: 'clear',
    contextText: 'No known allergies.',
    handwriting_lines: [
      'Dr. A. Rao  -  OPD, City Clinic',
      'Date: 18/10/2026',
      'Name: R. Kumar   Age: 34',
      'Rx:',
      'Tab Metformin 500 mg',
      '1 - 0 - 1  after food',
      '30 days',
      'Dr. A. Rao'
    ],
    extraction: {
      prescription_id: 'RX-DEMO-001',
      extracted_medications: [
        {
          written_as: 'Tab Metformin 500 mg',
          drug: 'Metformin',
          interpreted_as: 'Metformin 500 mg tablet, twice daily, after food, 30 days',
          strength: '500 mg',
          form: 'tablet',
          frequency: '1-0-1 (twice daily)',
          timing: 'after food',
          duration_days: 30,
          confidence: 0.96,
          ambiguity: null,
          source: 'prescription_image'
        }
      ]
    },
    worksheet: {
      prescription_id: 'RX-DEMO-001',
      readiness: 'pharmacist_verification_required',
      read_summary:
        'The slip reads: Metformin 500 mg tablets, one twice a day after food, for 30 days.',
      patient_context: {
        reported_allergies: [],
        existing_medications: [],
        unresolved_items: [],
        source: 'patient_text'
      },
      safety_flags: [
        {
          type: 'pharmacist_approval_required',
          severity: 'low',
          message:
            'Nothing on this slip was illegible and no allergy term was matched. This is the clean case: the tool found nothing to escalate, which is the correct outcome for a readable prescription.',
          action: 'Pharmacist verifies the name, strength and frequency against the pack, then approves.'
        }
      ],
      verification_checklist: [
        'Confirm patient name and age against the slip',
        'Confirm allergy history verbally',
        'Confirm no other regular medicines',
        'Verify 500 mg strength and 1-0-1 frequency against the pack',
        'Label: 1 tablet after food, twice daily, for 30 days',
        'Pharmacist approves before dispensing'
      ]
    }
  },
  {
    id: 'rx2',
    label: 'Sample 2 — Ambiguous handwriting (look-alike pair)',
    kind: 'ambiguous',
    contextText: 'I already take a medicine for blood pressure. No known allergies.',
    handwriting_lines: [
      'Dr. S. Iyer  -  OPD, City Clinic',
      'Date: 18/10/2026',
      'Name: P. Nair   Age: 29',
      'Rx:',
      'Tab Met[oprol]ol 50 mg',
      '1 - 0 - 1  after food',
      '30 days',
      'Dr. S. Iyer'
    ],
    extraction: {
      prescription_id: 'RX-DEMO-002',
      extracted_medications: [
        {
          written_as: 'Tab Met-?-ol 50 mg',
          drug: 'Metoprolol',
          interpreted_as: 'Metoprolol 50 mg tablet, twice daily, after food, 30 days',
          strength: '50 mg',
          form: 'tablet',
          frequency: '1-0-1 (twice daily)',
          timing: 'after food',
          duration_days: 30,
          confidence: 0.54,
          ambiguity: 'Metformin',
          source: 'prescription_image'
        }
      ]
    },
    worksheet: {
      prescription_id: 'RX-DEMO-002',
      readiness: 'ambiguous_clarification_required',
      read_summary:
        'The slip appears to read Metoprolol 50 mg twice daily after food for 30 days, but the drug name is not legible enough to commit to. Metformin is the competing reading.',
      patient_context: {
        reported_allergies: [],
        existing_medications: ['an unnamed medicine for blood pressure'],
        unresolved_items: [
          'The existing blood-pressure medicine was never named, so no interaction check is possible',
          'The patient says "for blood pressure", which fits Metoprolol and does not fit Metformin, but the patient is not the prescriber'
        ],
        source: 'patient_text'
      },
      safety_flags: [
        {
          type: 'ambiguous_drug_name',
          severity: 'high',
          message:
            'The drug name reads at confidence 0.54. Metoprolol (beta blocker) and Metformin (biguanide) are a look-alike/sound-alike pair: one treats blood pressure, the other treats diabetes. The two are not interchangeable in any way that matters clinically.',
          action:
            'Do not select a pack on this reading. Ask the prescriber to confirm the drug name, or check the patient\'s existing medicines for a clue, then re-read the slip against the confirmed name.'
        },
        {
          type: 'existing_medicine_unnamed',
          severity: 'high',
          message:
            'The patient reports a blood-pressure medicine but did not name it. Interaction checking is impossible against an unnamed drug.',
          action: 'Ask the patient for the exact name or a photo of the strip before completing the check.'
        }
      ],
      verification_checklist: [
        'Ask the prescriber to confirm the drug name in writing',
        'Confirm the existing blood-pressure medicine by name',
        'Confirm allergy history verbally',
        'Verify strength and frequency only after the name is confirmed',
        'Pharmacist approves before dispensing'
      ]
    }
  },
  {
    id: 'rx3',
    label: 'Sample 3 — Incomplete context (allergy conflict)',
    kind: 'incomplete',
    contextText: 'I am allergic to sulfa drugs. I also take a medicine for blood pressure.',
    handwriting_lines: [
      'Dr. M. Nair  -  OPD, City Clinic',
      'Date: 18/10/2026',
      'Name: S. Gupta   Age: 47',
      'Rx:',
      'Tab Sulfamethoxazole 400 mg',
      '1 - 0 - 1  after food',
      '7 days',
      'Dr. M. Nair'
    ],
    extraction: {
      prescription_id: 'RX-DEMO-003',
      extracted_medications: [
        {
          written_as: 'Tab Sulfamethoxazole 400 mg',
          drug: 'Sulfamethoxazole',
          interpreted_as: 'Sulfamethoxazole 400 mg tablet, twice daily, after food, 7 days',
          strength: '400 mg',
          form: 'tablet',
          frequency: '1-0-1 (twice daily)',
          timing: 'after food',
          duration_days: 7,
          confidence: 0.93,
          ambiguity: null,
          source: 'prescription_image'
        }
      ]
    },
    worksheet: {
      prescription_id: 'RX-DEMO-003',
      readiness: 'incomplete_information',
      read_summary:
        'The slip reads: Sulfamethoxazole 400 mg tablets, one twice a day after food, for 7 days.',
      patient_context: {
        reported_allergies: ['sulfa drugs (patient-reported, unverified)'],
        existing_medications: ['an unnamed medicine for blood pressure'],
        unresolved_items: [
          'Which specific blood-pressure medicine is the patient taking?',
          'Is the reported sulfa allergy a confirmed drug allergy or a reaction to another sulfonamide?'
        ],
        source: 'patient_text'
      },
      safety_flags: [
        {
          type: 'allergy_family_match',
          severity: 'high',
          message:
            'The prescription is for a sulfonamide antibiotic and the patient reports a sulfa allergy. The prescription text and the patient context point in opposite directions. RxSafe Lens does not decide this, and neither should a model.',
          action:
            'Stop. Verify the allergy history with the patient and the prescriber before dispensing. A photo of the strip or a pharmacy-system history may resolve it; do not resolve it from this screen.'
        },
        {
          type: 'existing_medicine_unnamed',
          severity: 'high',
          message: 'The existing blood-pressure medicine was never named, so no interaction check is possible.',
          action: 'Ask the patient for the exact name or a photo of the strip.'
        }
      ],
      verification_checklist: [
        'Verify the sulfa allergy with the patient and the prescriber',
        'Confirm the existing blood-pressure medicine by name',
        'Confirm allergy history against the pharmacy record, not only the patient',
        'Verify strength and frequency against the pack',
        'Label: duration and frequency recorded on the pack',
        'Pharmacist approves before dispensing'
      ]
    }
  }
];

const getSample = (id) => SAMPLES.find((s) => s.id === id) || null;

module.exports = { SAMPLES, getSample };