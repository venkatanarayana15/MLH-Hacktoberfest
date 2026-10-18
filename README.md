# RxSafe Lens 💊

**Gemma 4 reads the handwriting. Deterministic code checks it. The pharmacist decides.**

RxSafe Lens is a prescription-to-dispense safety checker for the pharmacy counter (Indian outpatient context). Upload a handwritten prescription, add the patient's context in their own words, and get a structured **dispensing worksheet** the pharmacist verifies before dispensing — with confidence scores, safety flags, and a verification checklist.

> ⚠️ **Decision-support only.** Not a clinical reference. Not counterfeit detection. RxSafe Lens never says a medicine is safe to dispense — every worksheet ends in pharmacist verification.

## The problem

Handwritten prescriptions are often hard to read, and busy pharmacy staff must reconcile drug name, strength, frequency, patient allergies, and existing medicines under time pressure. A misread drug name — *Metformin* vs *Metoprolol*, two completely different medicines — can cause serious harm. The tool turns that one risky glance at a scrawled slip into a structured, double-check-ready workflow.

## Why this needs multiple input modalities (G3 Multimodal)

```
Handwritten prescription IMAGE
        +
Patient context TEXT (typed or dictated at the counter)
        +
Demo formulary SCHEMA (transparent, auditable reference data)
        ▼
Gemma 4 cross-reasons the three → structured worksheet + safety flags
        ▼
Deterministic code re-checks the read → pharmacist verification checklist
```

Remove any input and the system weakens, measurably:

- **Without the prescription image:** no medication order exists to check.
- **Without patient context:** the sulfa-allergy conflict in Sample 3 is undetectable — the rule engine only compares drug class against what the patient reported.
- **Without the formulary:** strength validation and look-alike/sound-alike pairs (Metformin / Metoprolol / Metronidazole) can't be checked.

## Honest architecture

| Layer | Does | Never does |
|---|---|---|
| **Gemma 4** (via Gemini API) | Reads handwriting; separates what is *written* from what is *interpreted*; assigns confidence to the drug name; names competing look-alike candidates | Invent strengths, frequencies, or durations; give medical advice; say anything is "safe" |
| **Deterministic code** (`lib/rxrules.js`) | Formulary lookup, strength validation, duplicate-therapy detection, allergy keyword matching, missing-frequency/duration/timing checks | Diagnose, approve, interact with a live drug database |
| **Pharmacist** | The decision | — |

A prompt-level **guardrail** plus an output **scrubber** double-block the phrases the prototype must never produce ("safe to dispense", "no risk", "not counterfeit", …). Every response carries the boundary.

## The three demo cases

| Case | Slip | Patient context | What the system shows |
|---|---|---|---|
| **Sample 1 — clear** | Metformin 500 mg, 1-0-1 | "No known allergies." | Clean worksheet; nothing escalated — the correct outcome for a readable slip |
| **Sample 2 — ambiguous handwriting** | drug name smudged between look-alikes | "a medicine for blood pressure" | Confidence **54%**, competing reading *Metformin*; clarification required, no pack selection |
| **Sample 3 — allergy conflict** | Sulfamethoxazole 400 mg | "I am allergic to sulfa drugs…" | STOP-level flag: prescription and patient context point in opposite directions; the software refuses to resolve it |

All three slips are **synthetic images** rendered by `tools/render-samples.html` (headless-Chrome captured). No real patients, prescriptions, or drug records are used.

## Quickstart

```bash
npm install
cp .env.example .env    # add a Gemini API key (aistudio.google.com/apikey)
npm start               # http://localhost:3000
```

No API key? The app runs in **cached demo mode** — the three synthetic slips carry pre-run worksheets (openly labeled as such), so the full demo works offline. Re-generate the sample PNGs with:

```bash
tools/capture-samples.sh   # renders tools/render-samples.html → public/samples/*.png via headless Chrome
```

## The patient flow — photo in, plain-language plan out

The same engine also runs as a **patient-first dashboard** at `/` — four steps, voice everywhere:

1. **Upload** a prescription photo (or dictate the label text instead of typing).
2. **Read & explain** — `gemini-3.5-flash-lite` extracts the document (drug, strength, frequency, duration, follow-up date, per-field confidence); **Gemma 4** turns it into plain words: what each medicine is for, how to take it, what to watch for, what you *already have* vs. what you *need to buy*, and questions worth asking the doctor. A deterministic card set is the floor, so a slow model degrades the wording, never the page.
3. **Discuss** — ask anything about *your own* document. Answers are retrieval-grounded on the uploaded text, cite the excerpt they used, and the **thread is remembered per document** so a follow-up question lands on the same medicine. Voice in (Sarvam Saaras STT) and voice out (Sarvam Bulbul TTS) — voice-to-voice, wherever it helps.
4. **Reminders** — email the report with one tap; schedule a **next-visit reminder** and a **refill reminder** timed to when the course runs low, delivered by mail.

Two-model split on purpose: perception (reading the photo) runs on the fast flash-lite tier; the reasoning model (Gemma 4) does the explaining — reading is not reasoning, and it should not pay for it.

## Deploy on Render

`render.yaml` is included — create a Blueprint on [Render](https://render.com) from this repo, then set `GEMINI_API_KEY` (and optionally `SARVAM_API_KEY`, Cognee vars) in the dashboard. The app reads `PORT` from the environment; data files are ephemeral on the free plan by design (the audit trail re-seeds itself).

## In the UI

- **Permanent light theme** — counter-friendly, printable as-is
- **🎙 Voice dictation of patient context** (Web Speech API) — the *audio* modality: the pharmacist speaks allergies / existing medicines at the counter and they enter the same safety pipeline as typed text
- **Interactive pharmacist sign-off** — the verification checklist is tickable and only locks "verified" when every line is ticked; labeled a local workflow tick, not a clinical approval
- **Severity toasts** (Notyf, MIT) — STOP-level flags red, medium amber, clean read green, plus a distinct alert when the model guardrail fires
- **Session history** — the last 8 worksheets, stored in `localStorage` on the counter machine only
- **Export JSON / copy / print** — each worksheet leaves as structured, machine-readable JSON

## Output contract

Gemma's JSON is schema-validated with **Zod**: a malformed extraction never reaches the UI silently — it carries a `schema_validation_failed` flag and a `schema_valid: false` marker, and the deterministic layer still runs on whatever fields did parse.

## Live mode

With `GEMINI_API_KEY` set, RxSafe Lens reads the actual uploaded image: Gemma first extracts the medications, our code re-runs the deterministic checks **on Gemma's own extraction**, then Gemma reasons once more with those findings in hand. Live failures degrade to the cached worksheet with an explicit note — liveness is never faked.

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/mode` | GET | Live vs cached, discovered Gemma model id |
| `/api/samples` | GET | Synthetic slips + their patient context |
| `/api/analyze-rx` | POST | `{sampleId?, imageBase64?, imageMime?, contextText}` → worksheet + deterministic checks + merged flags |

`/api/analyze-rx` responses are exportable as JSON from the UI and printable as a counter worksheet.

## Limitations

- The formulary is a **small demo dataset**, explicitly labeled "not a clinical reference" — deliberately auditable, not connected to CDSCO or any live database.
- Confidence only guards the drug name (the field a misreading changes what the patient swallows); below 0.7 the reading is routed to human review, never guessed through.
- Duplicate-therapy and interaction checks are heuristic keyword/class matching, not a clinical interaction engine.
- Does not detect counterfeits, expiry, or packaging authenticity — and says so everywhere.

## Open-source credits

| Project | License | Used for |
|---|---|---|
| [Cognee](https://github.com/topoteretes/cognee) | Apache-2.0 | Long-term memory for MediPilot (graph when self-hosted, JSON fallback always) |
| [Notyf](https://github.com/caroso1222/notyf) | MIT | Toast notification sender (vendored, offline-safe) |
| [nodemailer](https://github.com/nodemailer/nodemailer) | MIT | Report + reminder email (real SMTP, else a free Ethereal test inbox, else local Mailpit — no paid mailer anywhere) |
| [Zod](https://github.com/colinhacks/zod) | ISC | Schema validation of Gemma's worksheet JSON |
| [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify) | MIT / Apache-2.0 | Safe markdown rendering of copilot answers (sanitize before innerHTML) |
| [Helmet](https://github.com/helmetjs/helmet) | MIT | Security headers |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | MIT | Per-IP rate limiting on `/api` |
| [compression](https://github.com/expressjs/compression) | MIT | gzip responses |
| [morgan](https://github.com/expressjs/morgan) | MIT | Request logging |
| [nanoid](https://github.com/ai/nanoid) | MIT | Audit request ids |
| [Express](https://github.com/expressjs/express) | MIT | API server |
| [Sarvam AI](https://github.com/sarvamai) (event sponsor) | cloud API | Saaras speech-to-text · Bulbul text-to-speech for MediPilot voice in/out |
| Google Chrome headless | — | Renders the synthetic prescription PNGs (`tools/`) |

## MediPilot — the counter discussion copilot

A **doctor-icon button** (bottom-right) opens a chat drawer where the pharmacist **discusses the worksheet**: type or record a voice question (Sarvam Saaras STT) and MediPilot answers reasoning step-by-step:

- **ReAct loop** — explicit `Thought → Action → Observation` steps, visible in the trace
- **Chain-of-Thought** — every step must state why it acts
- **Few-shot** — a worked example trace anchors the tool protocol
- **RAG** — top-matching notes from the small demo KB (`lib/medikb.js`) are retrieved by the deterministic layer and injected as observations; the answer cites the note ids it used
- **Memory (Cognee)** — every exchange is remembered; before reasoning, related prior counter discussions are recalled and injected as PRIOR MEMORY. With a Cognee server (`COGNEE_BASE_URL`) memory is a knowledge graph (`/api/v1/add` → `/api/v1/cognify` → `/api/v1/search`); without one it persists to `data/medipilot-memory.json`. The drawer badge shows which mode is live.
- **Voice out** — answers spoken via Sarvam Bulbul TTS in English / हिन्दी / தமிழ் / ಕನ್ನಡ

Same boundary as the whole app: informational for the pharmacist, never advice, never a dispensing approval — guardrail-scrubbed text, with a deterministic canned fallback if a model ever drifts.

## Traceability & hardening

- **Audit trail** — every worksheet is logged to `data/audit.json` (hashed worksheet id, mode, readiness, drug names, flag counts) and readable at `GET /api/audit`
- **Security middleware** — Helmet headers, per-IP rate limiting on `/api`, gzip compression, request logging (Morgan)
- **Schema contracts** — Zod validates every Gemma worksheet; malformed output is flagged, never silently rendered
- **Safe markdown** — MediPilot answers render through marked + DOMPurify (sanitize before `innerHTML`)

## License

MIT — see [LICENSE](LICENSE).

---

Built with Gemma 4 via the Gemini API · Hacktoberfest Hack Day Bengaluru 2026 · Track 1 / **G3 Multimodal AI Intelligence**
