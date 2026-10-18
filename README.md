# ClauseLens 🔍

**Every clause explained. Every red flag, proven with the agreement's own words.**

ClauseLens is a rental-agreement forensics tool for Indian tenants — built for Bengaluru, where the 10-month deposit is an institution and deposit disputes are the #1 rental pain. Upload a photo of your agreement or paste its text, and get an instant forensic breakdown **before you sign**: deposit norms, missing refund timelines, lock-in traps, one-sided entry clauses, blank fields — each flag quoting the exact clause text, explained in plain language, with what to negotiate.

> ⚠️ **Risk signals, not legal advice.** The AI explains; the agreement's own words prove; you decide.

## Why

The information asymmetry is brutal: the owner's format agreement was written to protect the owner, the tenant reads it once under signing pressure, and lawyer review costs ₹2,000–5,000 — so most tenants skip it. ClauseLens flips the asymmetry in 10 seconds, for free.

## How it works

```
Agreement text / photo
        │
        ▼
1. RULES LAYER (deterministic code — finds FACTS)
   Deposit months vs norms · missing refund timelines · blank fields
   entry-without-notice · lock-in without exit · escalation %
   verbal-assurance exclusions · open-ended maintenance · stamp-paper absence
        │
        ▼
2. GEMMA 4 (via Gemini API — does the JUDGMENT)
   Weighs clauses TOGETHER · cites EXACT quoted evidence for every flag
   · severity · negotiation tips · plain-language summary
        │
        ▼
3. FORENSIC REPORT
   Verdict (landlord-heavy / mixed / tenant-favorable) · flags with the
   agreement's own words highlighted · what to negotiate · how to verify
```

**Multimodal (G3):** agreements arrive as photos of stamped pages and WhatsApp PDFs. Gemma reads the screenshot AND the text together — the "Model Inputs" panel shows exactly what the model saw.

**Honest architecture:** the rules layer finds facts; Gemma does the judgment. Every accusation is anchored in a verbatim quote from the document. Prepared agreements ship with cached Gemma analyses so the demo works offline — cached runs are always labeled.

## Quickstart

```bash
npm install
cp .env.example .env        # add your Gemini API key (aistudio.google.com/apikey)
npm start                   # http://localhost:3000
```

No API key? The app runs in **cached demo mode** with three prepared agreements (predatory / fair / subtly-bad) — the full forensic experience, offline.

## What Gemma does — and doesn't do

| Gemma does | Gemma doesn't |
|---|---|
| Weigh clause combinations (deposit + no refund timeline + lock-in = trap pattern) | Find facts (that's the deterministic rules layer) |
| Cite exact evidence for every flag | Invent quotes (prompt-locked to verbatim spans) |
| Explain risk in plain language | Give legal advice ("signals, not legal advice") |
| Suggest negotiation language | Declare anything "illegal" without a stated norm |

## Limitations

- Norms are Karnataka/Bengaluru-focused (Model Tenancy Act 2021, local practice)
- Not legal advice — for disputes, approach the Rent Authority or a lawyer
- Cached analyses are pre-run snapshots, labeled as such in the UI

## License

MIT — see [LICENSE](LICENSE).

---

Built with Gemma 4 via the Gemini API · Hacktoberfest Hack Day Bengaluru 2026 · Track 1 / G3 Multimodal AI Intelligence
