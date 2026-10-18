# RxSafe Lens

**Prescription-to-dispense safety checker.** Gemma 4 reads a handwritten prescription image, deterministic code checks what was read against a transparent demo formulary and the patient's stated context, and the pharmacist decides.

Track 1 · **G3 Multimodal AI Intelligence** — Hacktoberfest Hack Day Bengaluru 2026.

---

## The problem

A pharmacist at an outpatient counter must reconcile, under time pressure, four things at once: the drug name that was handwritten, the strength, the frequency, and what the patient tells them about their other medicines and allergies. A misread drug name is not a cosmetic error — it changes what the patient swallows.

Generic chatbots do not help: they give confident advice with no quote from *your* slip, they cannot read the photograph of the slip, and they will happily invent a fact about a drug. Static checklists do not help: knowing "avoid ambiguous names" is useless when you are holding the ambiguous slip.

## What it does

```
handwritten prescription IMAGE  +  patient context TEXT  +  demo formulary JSON
                                    |
                                    v
              Gemma 4 reads the handwriting (name, strength,
              frequency, timing, duration) and reports a
              confidence on the DRUG NAME specifically
                                    |
                                    v
              deterministic code checks that reading against the
              formulary: LASA pairs, allergy-family matches,
              duplicate therapy, unnamed existing medicines,
              confidence bar, missing instructions
                                    |
                                    v
        dispensing worksheet + safety flags + pharmacist checklist
```

**Gemma interprets. Code checks. The pharmacist decides.**

## Why two modalities are both load-bearing

| Remove this | What breaks |
|---|---|
| The prescription image | No medication order exists at all — there is nothing to check |
| The patient context | Age- and history-specific warnings (the sulfa case) become impossible to raise |
| The demo formulary | Strength validation and look-alike/sound-alike comparison have nothing to compare against |

With the image alone you get a transcription. With the context alone you get a conversation. Neither produces a safety flag. The cross-modal conflict in sample 3 — a sulfonamide prescribed to a patient who reports a sulfa allergy — **cannot be detected by either input separately.** That is the point.

## What it will never do

These are enforced in the system prompt *and* scrubbed from the output in `lib/rxgemini.js`:

- never output "safe to dispense" or any approval language
- never claim a medicine is counterfeit, genuine, expired or substandard
- never give medical advice or suggest a dose
- always route low name-confidence to human review instead of guessing
- no real patient data: synthetic slips only

## The three synthetic samples

| Sample | Slip | Patient context | Expected outcome |
|---|---|---|---|
| 1 | Metformin 500 mg, 1-0-1, 30 days (clear) | no known allergies | ready for pharmacist verification, no escalation |
| 2 | "Metoprolol" written loosely, 50 mg | takes a blood-pressure medicine (unnamed) | ambiguous: confidence 0.54, competing reading *Metformin*, high-severity LASA warning |
| 3 | Sulfamethoxazole 400 mg, 7 days | allergic to sulfa drugs + unnamed BP medicine | incomplete context: sulfonamide/allergy-family conflict, high severity |

## Run it

```bash
npm install
cp .env.example .env      # add GEMINI_API_KEY for live reading
npm start                 # http://localhost:3000
```

**Without `GEMINI_API_KEY` the app still runs** and returns the pre-run worksheet for each synthetic slip, labelled honestly as `cached` in the UI. The model id is discovered at startup via `ListModels` and shown in the header, or pin it with `GEMMA_MODEL`.

Sample slips are rendered from `tools/render-samples.html` (Windows handwriting font) into `public/samples/*.png`. The demo uploads those real images.

## Layout

```
server.js              Express API: /api/mode, /api/samples, /api/analyze-rx
lib/formulary.js       small labelled demo formulary (not a clinical reference)
lib/rxrules.js         deterministic checks (10 rules, no speculation)
lib/rxprompt.js        Gemma system prompt + hard prohibitions
lib/rxgemini.js        Gemini client, model discovery, output guardrail scrub
lib/rxsamples.js       three synthetic slips + cached worksheets
public/                UI (dark, print-friendly worksheet, JSON export)
tools/                 handwriting renderer used to produce the sample images
```

## Honest limitations

- The formulary is eight drugs of demo data, not a drug database or a label.
- Interaction checking is limited to what a static demo formulary can express; there is no interaction engine here.
- It reads the slip. It does not dispense, diagnose, or adjudicate authenticity.
- Verified on the Gemini API with Gemma 4 (text + image). Audio is deliberately not claimed: Gemma 4 on the Gemini API does not accept audio input, so we do not pretend otherwise.

MIT licensed. Synthetic data only.