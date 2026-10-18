// RxSafe Lens — DEMO FORMULARY.
// Prototype reference data only. NOT a clinical reference, NOT a substitute for
// any drug database, label, or pharmacist's professional judgement.
// Deliberately small and fully visible so the deterministic checks are auditable.

const DISCLAIMER = 'Demo formulary for prototype only; not a clinical reference.';

const DRUGS = [
  {
    name: 'Metformin',
    common_strengths: ['500 mg', '850 mg', '1000 mg'],
    class: 'biguanide',
    use: 'type 2 diabetes',
    look_alike_sound_alike: ['Metoprolol', 'Metronidazole'],
    notes: 'Commonly taken after food to reduce stomach upset.',
    max_daily_dose_hint: 'commonly up to 2000 mg/day; higher only under supervision'
  },
  {
    name: 'Metoprolol',
    common_strengths: ['25 mg', '50 mg', '100 mg'],
    class: 'beta blocker',
    use: 'hypertension, angina, arrhythmia',
    look_alike_sound_alike: ['Metformin', 'Metronidazole'],
    notes: 'Not to be stopped abruptly.',
    max_daily_dose_hint: 'commonly up to 200 mg/day'
  },
  {
    name: 'Metronidazole',
    common_strengths: ['200 mg', '400 mg', '500 mg'],
    class: 'nitroimidazole',
    use: 'anaerobic bacterial and protozoal infections',
    look_alike_sound_alike: ['Metformin', 'Metoprolol'],
    notes: 'Often causes metallic taste; avoid alcohol.',
    max_daily_dose_hint: 'commonly up to 1200 mg/day oral'
  },
  {
    name: 'Amoxicillin',
    common_strengths: ['250 mg', '500 mg', '625 mg'],
    class: 'penicillin antibiotic',
    use: 'bacterial infections',
    look_alike_sound_alike: ['Amoxycillin (same drug, alternate spelling)'],
    allergy_keywords: ['penicillin', 'amoxicillin', 'amoxycillin'],
    notes: 'Penicillin family.',
    max_daily_dose_hint: 'commonly up to 1500 mg/day'
  },
  {
    name: 'Azithromycin',
    common_strengths: ['250 mg', '500 mg'],
    class: 'macrolide antibiotic',
    use: 'bacterial respiratory and skin infections',
    look_alike_sound_alike: ['Amoxicillin', 'Azathioprine'],
    allergy_keywords: ['macrolide', 'azithromycin'],
    notes: 'Macrolide family.',
    max_daily_dose_hint: 'commonly up to 500 mg/day'
  },
  {
    name: 'Sulfamethoxazole',
    common_strengths: ['400 mg', '800 mg'],
    class: 'sulfonamide antibiotic',
    use: 'urinary tract and other bacterial infections',
    look_alike_sound_alike: ['Sumatriptan'],
    allergy_keywords: ['sulfa', 'sulfonamide', 'sulfamethoxazole', 'co-trimoxazole', 'co-trimoxazole'],
    notes: 'Sulfonamide family - the classic allergy cross-reactivity question.',
    max_daily_dose_hint: 'commonly up to 1600 mg/day (with trimethoprim)'
  },
  {
    name: 'Amlodipine',
    common_strengths: ['2.5 mg', '5 mg', '10 mg'],
    class: 'calcium channel blocker',
    use: 'hypertension',
    look_alike_sound_alike: ['Amlodipine (brand: Norvasc)'],
    notes: 'Common antihypertensive.',
    max_daily_dose_hint: 'commonly up to 10 mg/day'
  },
  {
    name: 'Losartan',
    common_strengths: ['25 mg', '50 mg', '100 mg'],
    class: 'angiotensin receptor blocker',
    use: 'hypertension',
    look_alike_sound_alike: ['Lansoprazole'],
    notes: 'Common antihypertensive.',
    max_daily_dose_hint: 'commonly up to 100 mg/day'
  },
  {
    name: 'Omeprazole',
    common_strengths: ['10 mg', '20 mg', '40 mg'],
    class: 'proton pump inhibitor',
    use: 'acid reflux, gastric ulcer',
    look_alike_sound_alike: ['Omeprazole (brand: Prilosec)'],
    notes: 'Usually taken before breakfast.',
    max_daily_dose_hint: 'commonly up to 40 mg/day'
  },
  {
    name: 'Atorvastatin',
    common_strengths: ['10 mg', '20 mg', '40 mg'],
    class: 'statin',
    use: 'high cholesterol',
    look_alike_sound_alike: ['Atorvastatin (brand: Lipitor)'],
    notes: 'Often taken at night.',
    max_daily_dose_hint: 'commonly up to 80 mg/day'
  }
];

const byName = (n) =>
  DRUGS.find((d) => d.name.toLowerCase() === String(n || '').trim().toLowerCase()) || null;

const findLasaPair = (name) => {
  const d = byName(name);
  if (!d) return null;
  return (d.look_alike_sound_alike || []).map((other) => ({ from: d.name, to: other })).filter(
    (p) => !/same drug/i.test(p.to)
  );
};

module.exports = { DRUGS, DISCLAIMER, byName, findLasaPair };