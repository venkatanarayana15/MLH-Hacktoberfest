# QA packet — 2026-10-18 · RxSafe Lens SaaS redesign (porcelain + indigo)

## Scope
Full visual-system rebuild while keeping every app.js hook intact:
- **Layout**: sidebar workspace shell (gradient brand mark, mode card, step nav, legal footer) + sticky blurred topbar (breadcrumb + local-first note) + amber guardrail strip + 4 KPI tiles with gradient rails.
- **Palette**: cool porcelain canvas `#f5f6fb`, indigo/violet brand gradient, ink `#101329`, muted `#5d6478`; severities moved off green/teal collision: high=rose, medium=amber, low=cyan, ok=emerald.
- **Components**: 2-column auto-fill sample cards with tape thumbnails + check badge; dashed upload dropzone; tinted focus rings; gradient CTAs with shadow; document-grade meds table (porcelain head, zebra, conf bars); flags as tinted rails with solid severity chips; checklist rows with `:has(:checked)` verified state; dashed sign-off → emerald OK; det-checks as porcelain chips; history cards; empty-state card.
- **MediPilot**: gradient header drawer, white-on-gradient memory chip, info strips, chat bubbles (user gradient / assistant card), markdown styles, reasoning-trace timeline with node dots, custom select chevrons, send CTA.
- **Misc**: pulse ring on FAB, `prefers-reduced-motion` respected, print sheet kept, smooth scrollbars, `:focus-visible` rings, aria-live status, inline-SVG favicon.

## Evidence
| File | Verdict | Impact sentence |
|---|---|---|
| desktop-full.png | pass | App presents as a product, not a demo. |
| desktop-worksheet.png | pass | Readability → flags → checklist hierarchy reads in one glance. |
| desktop-signoff.png | pass | Ticks + sign-off are unambiguous, no layout shift. |
| desktop-copilot.png | pass | Copilot is discoverable, trustworthy, clearly branded. |
| desktop-copilot-answer.png | pass | In-browser ask completed: answer + source + trace + memory + TTS/Copy actions. |
| mobile-390-full.png | pass | Everything reachable; sidebar collapses to top strip. |

## Console / network
Desktop & mobile after favicon fix: 0 errors, 0 warnings; all API GETs and statics 200.

## Copilot timing
API probe: 200 in 31.2s (speak:false), 3 ReAct steps, KB source cited, 3 memory reads.
Client now aborts at 90s and shows an honest timeout message instead of hanging forever.
In-browser ask verified end-to-end: answer + cited source ("Demo formulary — Metoprolol") + ReAct trace + memory recall + "▶ Hear it" TTS button rendered; status "Answer ready — grounded in the cited notes."

## Fixed in-run
favicon 404 → SVG data URI; history ellipsis; Notyf palette; 90s copilot budget.

## Not verified (honest gaps)
- Live Gemma photo-read flourish (upload flow) not re-captured this run; previously proven (strip1 AMLODIPINE 5 mg, 100% conf) — remaining gap if photo uploads are added later.
