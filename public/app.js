// RxSafe Lens UI — sidebar dashboard + MediPilot doctor-FAB chat drawer.
// Talks to /api/mode, /api/samples, /api/analyze-rx, /api/copilot,
// /api/copilot/languages, /api/stt, /api/tts. Nothing safety-critical is
// computed here: the UI renders what the backend (Gemma + deterministic rules)
// returned, and stays honest about cached vs live.

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Severity toasts — Notyf (MIT), vendored locally so they work offline.
const notyf = new Notyf({
  duration: 4500,
  ripple: false,
  dismissible: true,
  position: { x: 'right', y: 'top' },
  types: [
    { type: 'success', background: '#059669', icon: false },  // emerald
    { type: 'warning', background: '#d97706', icon: false },  // amber
    { type: 'error', background: '#e11d48', icon: false }     // rose
  ]
});

const state = { sampleId: null, image: null, lastResponse: null, existingMeds: [], email: '' };

// ---------------- Existing-medicine chips (the second modality) ---------------
// A named existing medicine is what turns "a medicine for blood pressure"
// into something the code layer can actually check against. Chips render
// exactly what the backend read — the UI never edits a drug name itself.
function renderMedChips() {
  const wrap = $('medChips');
  if (!state.existingMeds.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = state.existingMeds
    .map((m, i) => {
      const conf = typeof m.confidence === 'number' ? ` · ${(m.confidence * 100).toFixed(0)}%` : '';
      const amb = m.ambiguity ? ` <span class="chipamb">competing: ${escapeHtml(m.ambiguity)}</span>` : '';
      return `<button class="chip" data-i="${i}" title="Remove">
        <span class="chipname">${escapeHtml(m.drug || 'unknown')}</span>
        ${m.strength ? `<span class="chipmeta">${escapeHtml(m.strength)}</span>` : ''}
        <span class="chipconf">${conf}</span>${amb}
        <span class="chipx" aria-hidden="true">✕</span>
      </button>`;
    })
    .join('');
  wrap.querySelectorAll('.chip').forEach((el) =>
    el.addEventListener('click', () => {
      state.existingMeds.splice(Number(el.dataset.i), 1);
      renderMedChips();
      $('medStatus').textContent = 'Removed from the check set. Re-analyze to refresh the worksheet.';
    })
  );
}

async function readMedicinePhoto(base64, mime, label) {
  const btn = $('stripBtn');
  btn.disabled = true;
  $('medStatus').textContent = `Reading ${label} with Gemma — this is a real model call…`;
  try {
    const res = await fetch('/api/read-medicine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64, imageMime: mime })
    });
    const data = await res.json();
    if (!res.ok) {
      $('medStatus').textContent = data.error || 'Could not read that photo.';
      notyf.error('Medicine photo read failed — type the name into the context instead.');
      return;
    }
    const r = data.read || {};
    if (r.drug) {
      state.existingMeds.push({
        drug: r.drug,
        strength: r.strength,
        form: r.form,
        confidence: r.confidence,
        ambiguity: r.ambiguity,
        source: r.source || 'medicine_photo'
      });
      renderMedChips();
      const tag = data.mode === 'live' ? 'live Gemma read' : data.mode === 'cached-fallback' ? 'prepared read (live unavailable)' : 'prepared read';
      $('medStatus').textContent = `Read: ${r.drug}${r.strength ? ` ${r.strength}` : ''} — ${tag}. Analyze to check the slip against it.`;
      if (data.mode === 'live') notyf.success(`Medicine read live: ${r.drug}${r.strength ? ` ${r.strength}` : ''}`);
      else notyf.warning('Medicine read used the prepared fallback — verify by eye.');
    } else {
      $('medStatus').textContent = 'No drug name could be read from that photo.';
      notyf.warning('No drug name read — ask the patient for the name or a clearer photo.');
    }
  } catch (e) {
    $('medStatus').textContent = 'Network error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function useDemoStrip() {
  try {
    const res = await fetch('/samples/strip1.png');
    const blob = await res.blob();
    const base64 = await new Promise((ok, bad) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result).split(',')[1]);
      fr.onerror = bad;
      fr.readAsDataURL(blob);
    });
    await readMedicinePhoto(base64, blob.type || 'image/png', 'the demo strip');
  } catch (e) {
    $('medStatus').textContent = 'Could not load the demo strip: ' + e.message;
  }
}

$('stripBtn').addEventListener('click', useDemoStrip);
$('medFileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const base64 = await dataUrlOf(f);
  await readMedicinePhoto(base64.split(',')[1], f.type, f.name);
});
$('emailInput').addEventListener('input', (e) => { state.email = e.target.value.trim(); });

// ---------------- Markdown (marked + DOMPurify, vendored) -------------------
// Model answers may contain light markdown; render it but sanitize strictly so
// untrusted model output can never inject script into the counter UI.
function renderMarkdownSafe(text) {
  const raw = String(text || '');
  try {
    if (window.marked && window.DOMPurify) {
      return window.DOMPurify.sanitize(window.marked.parse(raw, { breaks: true }));
    }
  } catch {
    /* fall through to escaped text */
  }
  return escapeHtml(raw).replace(/\n/g, '<br />');
}

// ---------------- Mode pill + KPIs ------------------------------------------
async function loadMode() {
  try {
    const m = await (await fetch('/api/mode')).json();
    const pill = $('modePill');
    pill.className = `pill ${m.live ? 'live' : 'cached'}`;
    pill.textContent = m.live ? 'LIVE · Gemma reading' : 'CACHED · synthetic slips';
    $('modelName').textContent = m.live ? `model: ${m.model}` : 'no GEMINI_API_KEY — cached worksheets';
  } catch {
    $('modePill').textContent = 'offline';
  }
}

function updateKpiFlags(count) {
  $('kpiFlags').textContent = String(count ?? 0);
}

// ---------------- Synthetic samples -----------------------------------------
async function loadSamples() {
  let samples = [];
  try {
    samples = await (await fetch('/api/samples')).json();
  } catch {
    return;
  }
  const wrap = $('samples');
  wrap.innerHTML = '';
  for (const s of samples) {
    const card = document.createElement('div');
    card.className = 'sample';
    card.dataset.id = s.id;
    card.innerHTML = `
      <img src="${escapeHtml(s.imageUrl)}" alt="${escapeHtml(s.label)}" />
      <div>
        <div class="sname">${escapeHtml(s.label)}</div>
        <div class="sctx">Context: ${escapeHtml(s.contextText)}</div>
      </div>`;
    card.addEventListener('click', () => selectSample(s, card));
    wrap.appendChild(card);
  }
}

function selectSample(s, card) {
  state.sampleId = s.id;
  state.image = null;
  $('fileInput').value = '';
  document.querySelectorAll('.sample').forEach((el) => el.classList.remove('sel'));
  card.classList.add('sel');
  $('contextText').value = s.contextText;
  $('status').textContent = `Sample selected: ${s.label}. Edit the patient context, then analyze.`;
}

$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.image = f;
  state.sampleId = null;
  document.querySelectorAll('.sample').forEach((el) => el.classList.remove('sel'));
  $('status').textContent = `Photo attached: ${f.name}. This will be read LIVE by Gemma.`;
});

function dataUrlOf(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ---------------- Worksheet rendering ---------------------------------------
const READYNESS = {
  pharmacist_verification_required: { cls: 'low', label: 'READABLE SLIP — pharmacist verification required' },
  ambiguous_clarification_required: { cls: 'medium', label: 'AMBIGUOUS READING — clarification required before dispensing' },
  incomplete_information: { cls: 'high', label: 'INCOMPLETE INFORMATION — do not dispense until resolved' }
};

function confCell(m) {
  const c = typeof m.confidence === 'number' ? m.confidence : null;
  if (c === null) return '<span class="muted">unknown</span>';
  const color = c >= 0.9 ? 'var(--ok)' : c >= 0.7 ? 'var(--medium)' : 'var(--high)';
  return `<div class="conf"><div class="bar"><span style="width:${(c * 100).toFixed(0)}%;background:${color}"></span></div><span>${(c * 100).toFixed(0)}%</span></div>
    ${m.ambiguity ? `<div class="amb">competing: “${escapeHtml(m.ambiguity)}”</div>` : ''}`;
}

function renderMeds(meds) {
  if (!meds || !meds.length) {
    $('meds').innerHTML = '<p class="empty">No medications were extracted — treat the read as failed and re-check.</p>';
    return;
  }
  const rows = meds
    .map(
      (m) => `<tr>
        <td class="written">${escapeHtml(m.written_as || '—')}</td>
        <td>${escapeHtml(m.interpreted_as || (m.drug ? `${m.drug} (drawing)` : '—'))}</td>
        <td>${escapeHtml(m.strength || '—')}</td>
        <td>${escapeHtml(m.frequency || '—')}</td>
        <td>${escapeHtml(m.timing || '—')}</td>
        <td>${m.duration_days != null ? escapeHtml(String(m.duration_days)) : '—'}</td>
        <td>${confCell(m)}</td>
      </tr>`
    )
    .join('');
  $('meds').innerHTML = `
    <table class="meds">
      <thead><tr>
        <th>Written</th><th>Interpreted</th><th>Strength</th>
        <th>Frequency</th><th>Timing</th><th>Days</th><th>Confidence</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderFlags(flags) {
  if (!flags || !flags.length) {
    $('flags').innerHTML = '<p class="empty">No safety flags raised. Escalating when there is nothing to escalate would be crying wolf.</p>';
    return;
  }
  $('flags').innerHTML = flags
    .map(
      (f) => `<div class="flag ${escapeHtml(f.severity)}">
        <div class="fhead">
          <span class="sev ${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
          <strong>${escapeHtml(f.type || f.message)}</strong>
          ${f.source ? `<span class="src">${escapeHtml(f.source)}</span>` : ''}
        </div>
        <p class="fmsg">${escapeHtml(f.message || '')}</p>
        ${f.why ? `<p class="fwhy">${escapeHtml(f.why)}</p>` : ''}
        ${f.action ? `<p class="fact">→ ${escapeHtml(f.action)}</p>` : ''}
      </div>`
    )
    .join('');
}

function render(data) {
  state.lastResponse = data;
  const ws = data.worksheet || {};
  const meds = ws.extracted_medications || (data.extraction && data.extraction.extracted_medications) || [];

  $('emptyState').classList.add('hidden');
  $('worksheet').classList.remove('hidden');

  const r = READYNESS[ws.readiness] || READYNESS.incomplete_information;
  $('readiness').className = `readiness ${r.cls}`;
  $('readiness').textContent = r.label;
  $('readSummary').textContent = ws.read_summary || '';

  if (data.note) {
    $('note').classList.remove('hidden');
    $('note').textContent = data.note;
  } else {
    $('note').classList.add('hidden');
  }

  renderMeds(meds);
  renderFlags(ws.safety_flags || []);

  $('checklist').innerHTML = (ws.verification_checklist || [])
    .map((x) => `<li><label><input type="checkbox" /> <span>${escapeHtml(x)}</span></label></li>`)
    .join('');

  const det = data.deterministic || [];
  $('detChecks').innerHTML = det.length
    ? det.map((d) => `<li><strong>[${escapeHtml(d.severity)}]</strong> ${escapeHtml(d.label)}</li>`).join('')
    : '<li>None — the code layer found nothing to add.</li>';

  updateSignoff();

  $('disclaimer').textContent = ws.disclaimer || 'Decision-support only. The pharmacist must verify and approve before dispensing.';

  const flags = ws.safety_flags || [];
  updateKpiFlags(flags.length);

  // Toolbar: what exactly am I looking at, and how bad is it.
  $('hashChip').textContent = data.integrity?.hash || data.worksheet_id || 'RXS-········';
  const modeMap = {
    live: ['live read', 'live'],
    'cached-fallback': ['live unavailable · pre-run', 'warn'],
    cached: ['pre-run worksheet', 'cached']
  };
  const [modeLabel, modeCls] = modeMap[data.mode] || [data.mode || '—', 'cached'];
  const modeChip = $('modeChip');
  modeChip.textContent = modeLabel;
  modeChip.className = `wschip mode-${modeCls}`;
  const counts = { high: 0, medium: 0, low: 0 };
  flags.forEach((f) => { if (counts[f.severity] != null) counts[f.severity] += 1; });
  $('statChips').innerHTML = [
    flags.length ? `<span class="statchip high">${counts.high} high</span>` : '',
    counts.medium ? `<span class="statchip medium">${counts.medium} medium</span>` : '',
    counts.low ? `<span class="statchip low">${counts.low} low</span>` : '',
    `<span class="statchip neutral">${(ws.extracted_medications || meds).length} meds</span>`
  ].filter(Boolean).join('');

  $('worksheet').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if ((ws.guardrail_tripped || []).length) {
    notyf.error('Model guardrail triggered — unsafe phrasing removed from the worksheet.');
  } else if (flags.some((f) => f.severity === 'high')) {
    notyf.error('STOP-level safety flag — pharmacist review required.');
  } else if (flags.some((f) => f.severity === 'medium')) {
    notyf.warning('Medium-severity flag — confirm the marked fields.');
  } else {
    notyf.success('Worksheet ready — pharmacist verification required.');
  }
}

// ---------------- Sign-off ---------------------------------------------------
function updateSignoff() {
  const boxes = [...$('checklist').querySelectorAll('input[type="checkbox"]')];
  const el = $('signoff');
  if (!boxes.length) {
    el.classList.add('hidden');
    return;
  }
  const done = boxes.filter((b) => b.checked).length;
  const ts = new Date().toLocaleTimeString();
  if (done === boxes.length) {
    el.className = 'signoff ok';
    el.hidden = false;
    el.textContent = `✔ Pharmacist verification complete at ${ts} — worksheet cleared to hand to the counter. This is a local workflow tick; it is not a clinical approval by software.`;
  } else {
    el.className = 'signoff';
    el.hidden = false;
    el.textContent = `${done}/${boxes.length} checklist items verified — sign-off unlocks when every item is ticked.`;
  }
}
$('checklist').addEventListener('change', updateSignoff);

// ---------------- Analyze ----------------------------------------------------
$('analyzeBtn').addEventListener('click', async () => {
  const ctx = $('contextText').value.trim();
  const body = { contextText: ctx, sampleId: state.sampleId, existingMeds: state.existingMeds, email: state.email };
  if (state.image instanceof File) {
    const dataUrl = await dataUrlOf(state.image);
    body.imageBase64 = dataUrl.split(',')[1];
    body.imageMime = state.image.type;
  }
  if (!state.sampleId && !state.image) {
    $('status').textContent = 'Pick a synthetic sample or upload a prescription photo first.';
    return;
  }

  const btn = $('analyzeBtn');
  const live = Boolean(state.image instanceof File);
  btn.disabled = true;
  btn.textContent = live ? 'Reading the slip…' : 'Building worksheet…';
  $('status').textContent = live
    ? 'Gemma reads the image → our code checks the read → worksheet assembled. A live read can take up to 90s.'
    : 'Our code checks the prepared extraction → worksheet assembled.';
  showSkeleton(live);
  try {
    const res = await fetch('/api/analyze-rx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      hideSkeleton();
      $('status').textContent = data.error || 'Analysis failed.';
      showRetry();
      return;
    }
    hideSkeleton();
    clearRetry();
    const modeWord = { live: 'live Gemma read', 'cached-fallback': 'live unavailable — pre-run worksheet', cached: 'cached worksheet' }[data.mode] || data.mode;
    $('status').textContent = `Worksheet ready (${modeWord}).`;
    render(data);
    saveHistory(data);
    loadTraceability();
  } catch (e) {
    hideSkeleton();
    $('status').textContent = 'Network error: ' + e.message;
    showRetry();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze prescription';
  }
});

// ---------------- Loading skeleton + retry ----------------------------------
function showSkeleton(on) {
  $('skeleton').classList.toggle('hidden', !on);
  if (on) {
    $('emptyState').classList.add('hidden');
    $('worksheet').classList.add('hidden');
  }
}
function hideSkeleton() { $('skeleton').classList.add('hidden'); }

function showRetry() {
  if ($('retryBtn')) return;
  const b = document.createElement('button');
  b.id = 'retryBtn';
  b.className = 'ghost retry';
  b.type = 'button';
  b.textContent = 'Try again';
  b.addEventListener('click', () => { clearRetry(); $('analyzeBtn').click(); });
  $('status').parentNode.insertBefore(b, $('status').nextSibling);
}
function clearRetry() { const b = $('retryBtn'); if (b) b.remove(); }

// ---------------- Export / copy / print -------------------------------------
$('exportBtn').addEventListener('click', () => {
  if (!state.lastResponse) return;
  const blob = new Blob([JSON.stringify(state.lastResponse, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rxsafe-worksheet-${state.lastResponse.sampleId || 'upload'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('copyBtn').addEventListener('click', async () => {
  if (!state.lastResponse) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.lastResponse, null, 2));
    $('copyBtn').textContent = 'Copied ✓';
    setTimeout(() => ($('copyBtn').textContent = 'Copy'), 1400);
  } catch {
    $('copyBtn').textContent = 'Copy blocked';
  }
});

$('printBtn').addEventListener('click', () => window.print());

// ---------------- Session history -------------------------------------------
const HKEY = 'rxsafe-history';
const HISTORY_EMPTY = '<p class="hint">Sessions you analyze will appear here for quick recall. Nothing leaves this machine.</p>';

function saveHistory(data) {
  try {
    const list = JSON.parse(localStorage.getItem(HKEY) || '[]');
    list.unshift({
      ts: Date.now(),
      readiness: (data.worksheet && data.worksheet.readiness) || null,
      summary: (data.worksheet && data.worksheet.read_summary) || '',
      data
    });
    localStorage.setItem(HKEY, JSON.stringify(list.slice(0, 8)));
    renderHistory();
  } catch {
    /* best-effort */
  }
}

function renderHistory() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(HKEY) || '[]');
  } catch {
    list = [];
  }
  $('kpiSlips').textContent = String(list.length);
  if (!list.length) {
    $('historyList').innerHTML = HISTORY_EMPTY;
    return;
  }
  $('historyList').innerHTML = list
    .map(
      (h, i) => `<button class="ghost histItem" data-i="${i}">
        <div class="hts">${new Date(h.ts).toLocaleTimeString()} · ${escapeHtml(h.readiness || 'unknown readiness')}</div>
        ${escapeHtml((h.summary || '').slice(0, 88))}${(h.summary || '').length > 88 ? '…' : ''}
      </button>`
    )
    .join('');
}

$('historyList').addEventListener('click', (e) => {
  const btn = e.target.closest('.histItem');
  if (!btn) return;
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(HKEY) || '[]');
  } catch {
    list = [];
  }
  const h = list[Number(btn.dataset.i)];
  if (h && h.data) {
    render(h.data);
    $('status').textContent = 'Restored from history (stored locally in this browser).';
  }
});

// ---------------- Handoff: worksheet → MediPilot ----------------------------
// One click carries the exact facts of what is on screen into the copilot so
// the pharmacist doesn't retype the slip. No safety logic here — the question
// quotes the rendered worksheet verbatim.
$('askPilotBtn').addEventListener('click', () => {
  if (!state.lastResponse) {
    notyf.warning('Analyze a slip first — MediPilot works from the worksheet on screen.');
    return;
  }
  const ws = state.lastResponse.worksheet || {};
  const meds = ws.extracted_medications || [];
  const names = meds.map((m) => `${m.drug || '?'}${m.strength ? ` ${m.strength}` : ''}`).join(', ') || 'nothing legible';
  const nHigh = (ws.safety_flags || []).filter((f) => f.severity === 'high').length;
  const q = `The worksheet on my screen read: ${names}. It raised ${nHigh} high-severity flag${nHigh === 1 ? '' : 's'}. In counter language, what must I verify before I hand this over, and what exactly should I say to the patient standing in front of me?`;
  openCopilot();
  $('copilotQ').value = q;
  $('copilotStatus').textContent = 'Prefilled from the worksheet on screen — edit, then Send.';
});

// ---------------- Traceability: audit trail + queued reminders ---------------
async function loadTraceability() {
  try {
    const audit = await (await fetch('/api/audit')).json();
    const entries = (audit.entries || []).slice(0, 4);
    $('auditList').innerHTML = entries.length
      ? entries
          .map(
            (a) => `<div class="auditrow">
              <span class="mono aid">${escapeHtml(a.worksheet_id || '')}</span>
              <span class="asev">${a.flags_total || 0} flags${a.flags_high ? ` · ${a.flags_high} high` : ''}</span>
              <span class="atime">${escapeHtml(new Date(a.ts).toLocaleTimeString())}</span>
            </div>`
          )
          .join('')
      : '<p class="hint">Worksheet entries appear here after each analysis.</p>';
  } catch {
    /* audit is best-effort */
  }
  try {
    const sched = await (await fetch('/api/schedule')).json();
    const rem = (sched.reminders || []).slice(0, 4);
    $('reminderList').innerHTML = rem.length
      ? `<div class="rhead">Scheduled follow-ups (local prototype store)</div>` +
        rem
          .map((r) => {
            const kind = r.kind === 'doctor_visit' ? 'Visit' : 'Refill';
            const when = new Date(r.at);
            const days = Math.max(0, Math.round((when - Date.now()) / 86400000));
            const dest = r.email ? r.email : 'in-app only';
            return `<div class="auditrow remrow">
              <span class="aid remkind ${r.kind === 'doctor_visit' ? 'visit' : 'refill'}">${kind}</span>
              <span class="asev">${escapeHtml(when.toLocaleDateString())} · in ${days} day${days === 1 ? '' : 's'}</span>
              <span class="atime">${escapeHtml(dest)}</span>
            </div>`;
          })
          .join('')
      : '';
  } catch {
    /* schedule is best-effort */
  }
}

// ---------------- Sidebar navigation ----------------------------------------
const navLinks = [...document.querySelectorAll('.navlink[data-sec]')];
navLinks.forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const sec = document.getElementById(a.dataset.sec);
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    navLinks.forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
  });
});

// ---------------- Patient-context dictation (browser STT) -------------------
function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $('micBtn').disabled = true;
    $('micStatus').textContent = 'Dictation needs Chrome or Edge — type the context instead.';
    return;
  }
  let rec = null;
  let listening = false;
  $('micBtn').addEventListener('click', () => {
    if (listening) {
      rec.stop();
      return;
    }
    rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    let final = '';
    let base = $('contextText').value.trim();
    rec.onstart = () => {
      listening = true;
      $('micBtn').classList.add('listening');
      $('micBtn').textContent = '⏺ Listening… (click to stop)';
      $('micStatus').textContent = 'Speak the patient context: allergies, other medicines, age.';
    };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = 0; i < e.results.length; i += 1) {
        const r = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += ` ${r}`;
        else interim += r;
      }
      $('contextText').value = [base, final, interim].map((s) => s.trim()).filter(Boolean).join(' ');
    };
    rec.onerror = (e) => {
      $('micStatus').textContent =
        e.error === 'not-allowed' ? 'Microphone permission denied — type instead.' : `Dictation error (${e.error}) — type instead.`;
    };
    rec.onend = () => {
      listening = false;
      $('micBtn').classList.remove('listening');
      $('micBtn').textContent = '🎙 Dictate instead';
      base = $('contextText').value.trim();
    };
    try {
      rec.start();
    } catch {
      $('micStatus').textContent = 'Could not start the microphone — type instead.';
    }
  });
}

// ---------------- MediPilot: doctor FAB + drawer -----------------------------
function setupCopilot() {
  const drawer = $('copilotDrawer');
  const fab = $('medipilotFab');
  const log = $('copilotMessages');
  let recorder = null;
  let chunks = [];
  let recording = false;
  let voiceEnabled = false;

  const scroller = $('chatScroll');
  const qEl = $('copilotQ');

  const open = () => {
    drawer.classList.remove('hidden');
    window.openCopilot = open;
    document.body.classList.add('chat-open');
    fab.querySelector('.fab-badge').classList.add('hidden');
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
      if (!qEl.disabled) qEl.focus();
    });
  };
  const close = () => {
    drawer.classList.add('hidden');
    document.body.classList.remove('chat-open');
  };

  fab.addEventListener('click', () => (drawer.classList.contains('hidden') ? open() : close()));
  $('copilotClose').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.classList.contains('hidden')) close();
  });
  $('navMedipilot').addEventListener('click', (e) => {
    e.preventDefault();
    open();
  });
  window.openCopilot = open;

  // The chat scrolls as one column, like a conversation, not a message box.
  function scrollToEnd() {
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function hideWelcome() {
    const w = $('copilotWelcome');
    if (w && !w.classList.contains('hidden')) w.classList.add('hidden');
  }

  // Composer helpers: grow with the text, send on Enter, newline on Shift+Enter.
  function autoGrow() {
    if (!qEl) return;
    qEl.style.height = 'auto';
    qEl.style.height = `${Math.min(200, Math.max(24, qEl.scrollHeight))}px`;
  }

  function askQuestion(text) {
    qEl.value = String(text || '');
    autoGrow();
    $('copilotAsk').click();
  }

  qEl.addEventListener('input', autoGrow);
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!$('copilotAsk').disabled) $('copilotAsk').click();
    }
  });

  [...document.querySelectorAll('#copilotWelcomeCards .cw-card')].forEach((card) => {
    card.addEventListener('click', () => askQuestion(card.dataset.q));
  });

  $('copilotNewChat').addEventListener('click', () => {
    [...log.querySelectorAll('.bubble, .chips')].forEach((n) => n.remove());
    const w = $('copilotWelcome');
    if (w) {
      w.classList.remove('hidden');
      log.appendChild(w);
    }
    qEl.value = '';
    autoGrow();
    $('copilotStatus').textContent = 'New discussion. Earlier exchanges stay in memory, so context is not lost.';
    qEl.focus();
    scrollToEnd();
  });

  // One message unit, ChatGPT-style: assistant = avatar + prose, user = bubble.
  function bubble(role, innerHtml, extraClass) {
    hideWelcome();
    const el = document.createElement('div');
    const [kind, ...mods] = String(role).split(' ');
    el.className = `bubble ${kind}${mods.map((m) => ' ' + m).join('')}${extraClass ? ' ' + extraClass : ''}`;
    el.innerHTML = kind === 'assistant'
      ? `<span class="ava" aria-hidden="true">Rx</span><div class="body">${innerHtml}</div>`
      : `<div class="body">${innerHtml}</div>`;
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  function setMemoryBadge(mem) {
    const el = $('copilotMemoryBadge');
    if (!mem) return;
    const count = (mem.local && mem.local.entries) || 0;
    const cogneeUp = mem.cognee && mem.cognee.reachable;
    el.textContent = `memory: ${cogneeUp ? 'cognee' : 'local'} · ${count}`;
    el.className = `memchip${cogneeUp ? ' on' : ''}`;
    el.title = cogneeUp
      ? 'Cognee memory graph is connected; every exchange is remembered'
      : 'Local memory (data/medipilot-memory.json) — set COGNEE_BASE_URL to use Cognee';
  }

  $('copilotPreset').addEventListener('change', (e) => {
    if (e.target.value) $('copilotQ').value = e.target.value;
  });

  // --- voice question: MediaRecorder → Sarvam Saaras ---
  $('copilotMic').addEventListener('click', async () => {
    if (recording) {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      $('copilotStatus').textContent = 'Voice questions need a modern browser — type instead.';
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        recording = false;
        $('copilotMic').classList.remove('listening');
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 1200) {
          $('copilotStatus').textContent = 'Recording too short — try again.';
          return;
        }
        $('copilotStatus').textContent = 'Transcribing with Sarvam Saaras…';
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let b64 = '';
        for (let i = 0; i < bytes.length; i += 1) b64 += String.fromCharCode(bytes[i]);
        try {
          const res = await fetch('/api/stt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: btoa(b64), mime: blob.type, languageCode: $('copilotLang').value })
          });
          const data = await res.json();
          if (!res.ok) {
            $('copilotStatus').textContent = data.error || 'Transcription failed.';
            return;
          }
          $('copilotQ').value = data.transcript;
          $('copilotStatus').textContent = 'Transcribed. Press Send.';
        } catch (e) {
          $('copilotStatus').textContent = 'Transcription error: ' + e.message;
        }
      };
      recorder.start();
      recording = true;
      $('copilotMic').classList.add('listening');
      $('copilotStatus').textContent = 'Recording… click 🎙 again to stop.';
    } catch (e) {
      $('copilotStatus').textContent = 'Microphone unavailable (' + e.message + ') — type instead.';
    }
  });

  // --- ask ---
  $('copilotAsk').addEventListener('click', async () => {
    const q = $('copilotQ').value.trim();
    if (!q) {
      $('copilotStatus').textContent = 'Type or record a question first.';
      return;
    }
    const lang = $('copilotLang').value;
    bubble('user', escapeHtml(q));
    $('copilotQ').value = '';
    $('copilotStatus').textContent = 'ReAct loop running…';
    const typing = bubble('assistant typing', '<span class="typing-dots" aria-label="Reasoning"><i></i><i></i><i></i></span>');
    $('copilotQ').disabled = true;
    $('copilotPreset').disabled = true;
    $('copilotLang').disabled = true;
    $('copilotMic').disabled = true;
    const btn = $('copilotAsk');
    btn.disabled = true;
    $('copilotStatus').textContent = 'ReAct loop running…';

    // 90s budget: the live ReAct loop (Gemini + RAG + memory + TTS) can be slow,
    // but an eternity at the counter is worse than a retry. Abort → honest message.
    const ctrl = new AbortController();
    const budget = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // speak:false keeps speech synthesis off the critical path — the
        // “Hear it” button calls /api/tts only when the pharmacist asks.
        body: JSON.stringify({ question: q, languageCode: lang, patientContext: $('contextText').value.trim(), speak: false }),
        signal: ctrl.signal
      });
      const data = await res.json();
      if (!res.ok) {
        typing.remove();
        bubble('assistant', `<p>⚠ ${escapeHtml(data.error || 'MediPilot failed.')}</p>`);
        return;
      }
      const traceHtml = (data.trace || [])
        .map(
          (t) => `<div class="tracestep">
            <span class="sev low">${t.step < 0 ? 'memory' : 'step ' + (t.step + 1)} · ${escapeHtml(t.action || 'answer')}</span>
            <p class="tthought">💭 ${escapeHtml(t.thought || '')}</p>
            ${t.observation ? `<p class="tobs">👁 ${escapeHtml(String(t.observation).slice(0, 260))}</p>` : ''}
          </div>`
        )
        .join('');
      const sourcesHtml = (data.sources || [])
        .map((s) => `<span class="src">📚 ${escapeHtml(s.title)}</span>`)
        .join('') || '<span class="src">no KB notes cited</span>';
      const mem = data.memory || {};
      const writeNote = mem.wroteToCognee
        ? ' · written to Cognee'
        : mem.writeQueued
          ? ' · Cognee write queued'
          : '';
      const memLine = mem.used
        ? `🧠 recalled ${mem.used} prior exchange${mem.used === 1 ? '' : 's'} from ${escapeHtml(mem.recallSource || 'local')} memory${writeNote}`
        : `🧠 no prior memory matched this question${writeNote}`;

      const steps = (data.trace || []).length;
      typing.className = 'bubble assistant';
      typing.innerHTML = `
        <span class="ava" aria-hidden="true">Rx</span>
        <div class="body">
          <div class="md">${renderMarkdownSafe(data.answer || '')}</div>
          <div class="sources">${sourcesHtml}</div>
          ${traceHtml ? `<details class="reasoning">
            <summary>Reasoning · ${steps} step${steps === 1 ? '' : 's'} (ReAct)</summary>
            <div class="trace">${traceHtml}</div>
          </details>` : ''}
          <p class="memline">${memLine}</p>
          <div class="bubble-actions">
            <button class="ghost playbtn" type="button">▶ Hear it</button>
            <button class="ghost copybtn" type="button">Copy</button>
            <button class="ghost againbtn" type="button">Ask a follow-up</button>
          </div>
        </div>
      `;
      typing.querySelector('.playbtn').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (typing._audio) {
          new Audio(typing._audio).play();
          return;
        }
        btn.disabled = true;
        btn.textContent = '▶ Loading…';
        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: data.answer || '', languageCode: data.answerLang || lang })
          });
          const ttsData = await res.json();
          if (!res.ok || !ttsData.audioBase64) {
            $('copilotStatus').textContent = ttsData.error || 'Speech is unavailable — add SARVAM_API_KEY to .env.';
            btn.textContent = '▶ Hear it';
            return;
          }
          typing._audio = `data:audio/wav;base64,${ttsData.audioBase64}`;
          new Audio(typing._audio).play();
          btn.textContent = '▶ Play again';
        } catch (e) {
          $('copilotStatus').textContent = 'Speech error: ' + e.message;
          btn.textContent = '▶ Hear it';
        } finally {
          btn.disabled = false;
        }
      });
      typing.querySelector('.copybtn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(data.answer || '');
          $('copilotStatus').textContent = 'Answer copied.';
        } catch {
          $('copilotStatus').textContent = 'Clipboard blocked.';
        }
      });
      typing.querySelector('.againbtn').addEventListener('click', () => $('copilotQ').focus());
      scrollToEnd();

      // Refresh status last, after the chat log is painted.
      const secs = data.timings && data.timings.total_ms ? (data.timings.total_ms / 1000).toFixed(1) : null;
      const took = secs ? ` in ${secs}s` : '';
      $('copilotStatus').textContent = data.answerLang && data.answerLang !== lang
        ? `Answered in ${data.answerLang}${took} (translation unavailable for ${lang}).`
        : data.canned
          ? `Answer from the safety fallback${took} — verify with the pharmacist.`
          : data.fallback
            ? `Model unavailable${took} — answered from the retrieved note only.`
            : `Answer ready${took} — grounded in the cited notes.`;
      if (data.memory && data.memory.wroteToCognee) notyf.success('Exchange remembered in Cognee.');
      fetch('/api/memory').then((r) => r.json()).then(setMemoryBadge).catch(() => {});

      // Suggested follow-ups so the pharmacist can keep the discussion moving
      // without retyping. Only show when we have sources to stay grounded.
      attachFollowUpChips(log, data.sources || [], lang);
      attachSuggestedQuestionChips(log);

      $('copilotQ').disabled = false;
      $('copilotPreset').disabled = false;
      $('copilotLang').disabled = false;
      $('copilotMic').disabled = !voiceEnabled;
      $('copilotQ').focus();
    } catch (e) {
      typing.remove();
      if (e.name === 'AbortError') {
        bubble('assistant', '<p>⚠ MediPilot hit its 90-second budget on the live model — try a shorter question, or ask again (memory is already saved).</p>');
        $('copilotStatus').textContent = 'Timed out after 90s — nothing was lost.';
      } else {
        bubble('assistant', `<p>⚠ Network error: ${escapeHtml(e.message)}</p>`);
        $('copilotStatus').textContent = '';
      }
    } finally {
      clearTimeout(budget);
      btn.disabled = false;
    }
  });

  // ---- Quick follow-up chips based on the sources the answer cited ----------
  const FOLLOW_UP_TEMPLATES = [
    (src) => (src && src.title
      ? `What should I double-check from "${String(src.title).slice(0, 60)}" before dispensing?`
      : 'What should I double-check before dispensing?'),
    () => 'Explain that again in plainer counter language.',
    () => 'What must I verify with the pharmacist before I hand this out?',
    () => 'What would make this unsafe at the counter?'
  ];

  function attachFollowUpChips(logAnchor, sources, lang) {
    const wrap = document.createElement('div');
    wrap.className = 'chips followups';
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = 'Keep going';
    wrap.appendChild(label);
    // Prompts are plain text: the previous version sent the chip's HTML into
    // the question, so <strong> tags reached the model.
    const prompts = FOLLOW_UP_TEMPLATES.map((fn) => fn(sources[0] || {}));
    for (const prompt of prompts.slice(0, 3)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = prompt;
      chip.addEventListener('click', () => askQuestion(prompt));
      wrap.appendChild(chip);
    }
    logAnchor.appendChild(wrap);
    scrollToEnd();
  }

  function attachSuggestedQuestionChips(logAnchor) {
    const presets = [
      'A slip reads Met-?-ol 50 mg and the patient also takes a blood-pressure tablet — how do I settle metformin vs metoprolol before I pick the pack?',
      'She reports a sulfa allergy and the slip has sulfamethoxazole 400 mg twice daily — what must I verify, and with whom?',
      'The label says 1-0-1 after food for 30 days — how do I explain that around a working day?'
    ];
    const wrap = document.createElement('div');
    wrap.className = 'chips chips--subtle';
    wrap.innerHTML = '<span class="chip-label">Or pick a quick question:</span>';
    for (const p of presets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip--subtle';
      chip.textContent = p;
      chip.title = 'Ask MediPilot this question';
      chip.addEventListener('click', () => askQuestion(p));
      wrap.appendChild(chip);
    }
    logAnchor.appendChild(wrap);
  }


  // --- config: languages, voice, memory, KPIs, summaries ---
  fetch('/api/copilot/languages')
    .then((r) => r.json())
    .then((cfg) => {
      $('copilotLang').innerHTML = cfg.languages
        .map((l) => `<option value="${l.code}">${escapeHtml(l.label)}</option>`)
        .join('');
      voiceEnabled = Boolean(cfg.voice);
      $('kpiKb').textContent = String(cfg.kb_docs ?? '–');
      $('kpiVoice').textContent = voiceEnabled ? 'on' : 'text only';
      $('copilotSubtitle').textContent = voiceEnabled
        ? 'voice + text via Sarvam · grounded in the demo KB'
        : 'text mode · add SARVAM_API_KEY for voice';
      $('copilotMic').title = voiceEnabled
        ? 'Record a question (Sarvam Saaras)'
        : 'Voice input needs SARVAM_API_KEY in .env — typing works fully';
      if (!voiceEnabled) $('copilotMic').disabled = true;
      setMemoryBadge(cfg.memory);

      // Seed the suggested preset with the latest worksheet summary so the copilot
      // can answer questions about the most recent read even before the pharmacist
      // types anything.
      if (cfg.summaries && cfg.summaries > 0) {
        fetch('/api/summaries')
          .then((s) => s.json())
          .then(({ summaries }) => {
            if (summaries && summaries.length) {
              const latest = summaries[0];
              const gist = [
                `Last read: ${latest.meds.map((m) => `${m.drug}${m.strength ? ' ' + m.strength : ''} — ${m.frequency || '?'} ${m.timing ? '· ' + m.timing : ''}`).join(', ')}`,
                `Readiness: ${latest.readiness || 'unknown'}`,
                latest.context ? `Context: ${latest.context}` : ''
              ].filter(Boolean).join(' — ');
              $('copilotPreset').selectedIndex = 0;
              $('copilotQ').placeholder = 'Ask about the last read, or type a new question…';
            }
          })
          .catch(() => {});
      }
    })
    .catch(() => {});

  // ---- Upload: extract text/drugs from a PDF or image inside the drawer ----
  const copilotFileInput = $('copilotFileInput');
  const copilotDrop = $('copilotDrop');
  const copilotUploadMeta = $('copilotUploadMeta');
  const copilotUploadName = $('copilotUploadName');
  const copilotUploadBits = $('copilotUploadBits');
  const copilotExtractBtn = $('copilotExtractBtn');
  const copilotUploadClear = $('copilotUploadClear');
  let copilotUploadedFile = null;

  function resetUploadUI() {
    copilotUploadedFile = null;
    copilotFileInput.value = '';
    copilotUploadMeta.classList.add('hidden');
    copilotDrop.classList.remove('selected');
  }

  function showUploadMeta(file) {
    copilotUploadName.textContent = file.name;
    copilotUploadBits.textContent = prettySize(file.size);
    copilotUploadMeta.classList.remove('hidden');
    copilotDrop.classList.add('selected');
  }

  function prettySize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  copilotFileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return resetUploadUI();
    copilotUploadedFile = f;
    showUploadMeta(f);
    $('copilotStatus').textContent = `Attached: ${f.name}. Press Extract to read it with Gemma.`;
  });

  copilotDrop.addEventListener('click', () => copilotFileInput.click());

  copilotUploadClear.addEventListener('click', () => {
    resetUploadUI();
    $('copilotStatus').textContent = '';
  });

  copilotExtractBtn.addEventListener('click', async () => {
    const f = copilotUploadedFile;
    if (!f) {
      $('copilotStatus').textContent = 'Attach a document first.';
      return;
    }
    copilotExtractBtn.disabled = true;
    $('copilotStatus').textContent = 'Extracting text from the document…';
    try {
      const dataUrl = await dataUrlOf(f);
      const mime = f.type || 'application/pdf';
      const body = { fileBase64: dataUrl.split(',')[1], fileMime: mime };
      const res = await fetch('/api/extract-doc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        $('copilotStatus').textContent = data.error || 'Extraction failed.';
        return;
      }
      // The extracted document becomes a visible attachment card in the chat,
      // so the discussion is about something the pharmacist can see on screen.
      const drugList = (data.drugs || []).map((d) => `${d.name}${d.strength ? ' ' + d.strength : ''}`).join(', ');
      const card = bubble(
        'user',
        `<div class="attach-card">
          <div class="ac-head">📄 ${escapeHtml(f.name)} <span class="ac-bits">${prettySize(f.size)}</span></div>
          <div class="ac-drugs">${drugList ? 'Medicines found: ' + escapeHtml(drugList) : 'No medicine names were read from this document.'}</div>
          <pre class="ac-text">${escapeHtml((data.plain || 'No readable text found.').slice(0, 700))}</pre>
        </div>`
      );
      card.dataset.kind = 'attachment';
      const gist = [
        data.plain ? data.plain.slice(0, 1400) : '',
        drugList ? `Drugs extracted: ${drugList}` : ''
      ].filter(Boolean).join('\n\n');
      askQuestion(`Read this prescription and list the medicines, strengths, frequency and duration in plain counter language. Then say what must be verified. Here is the extracted text:\n\n${gist}`);
      $('copilotStatus').textContent = 'Document extracted — discussing it now.';
      copilotExtractBtn.textContent = 'Done ✓';
      setTimeout(() => { copilotExtractBtn.textContent = 'Extract'; }, 1400);
    } catch (e) {
      $('copilotStatus').textContent = 'Extraction error: ' + e.message;
    } finally {
      copilotExtractBtn.disabled = false;
    }
  });

  // ---- Follow-up scheduler + email from the worksheet panel ---
  $('fuScheduleBtn').addEventListener('click', async () => {
    if (!state.lastResponse) {
      $('fuStatus').textContent = 'Analyze a prescription first so there is a worksheet to schedule from.';
      return;
    }
    const ws = state.lastResponse.worksheet || {};
    const meds = (ws.extracted_medications || []).filter((m) => m.drug);
    if (!meds.length) {
      $('fuStatus').textContent = 'No medicines were read — nothing to schedule a refill reminder for.';
      return;
    }
    const visitDate = $('fuVisitDate').value || '';
    const refillWhen = parseInt($('fuRefillWhen').value, 10) || 0;
    const email = $('fuEmail').value.trim();
    $('fuStatus').textContent = 'Scheduling the follow-up reminders…';
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          worksheetId: state.lastResponse.worksheet_id,
          email,
          meds,
          visitDate,
          refillDaysBefore: refillWhen
        })
      });
      const data = await res.json();
      if (!res.ok) {
        $('fuStatus').textContent = data.error || 'Could not persist the reminder.';
        return;
      }
      const lines = data.reminders.map((r) => {
        const when = new Date(r.at).toLocaleDateString();
        const kind = r.kind === 'doctor_visit' ? 'Visit' : 'Refill';
        return `${kind} ${when} (in ${r.inDays} day${r.inDays === 1 ? '' : 's'})${r.email ? ` → ${r.email}` : ' · in-app only'}`;
      });
      $('fuStatus').textContent = `${lines.join(' · ')} · ${data.email.configured ? `email ready via ${data.email.transport}` : 'no email transport yet — add SMTP_HOST / SMTP_USER / SMTP_PASS (or run npm install nodemailer) for delivery'}.`;
      notyf.success('Follow-up reminder scheduled.');
      loadTraceability();
    } catch (e) {
      $('fuStatus').textContent = 'Error scheduling reminder: ' + e.message;
    }
  });

  $('fuEmailBtn').addEventListener('click', async () => {
    if (!state.lastResponse) {
      $('fuStatus').textContent = 'Analyze a prescription first.';
      return;
    }
    const email = $('fuEmail').value.trim();
    if (!email) {
      $('fuStatus').textContent = 'Enter an email address first.';
      return;
    }
    $('fuStatus').textContent = 'Building the worksheet email…';
    try {
      const ws = state.lastResponse.worksheet || {};
      const meds = (ws.extracted_medications || []).filter((m) => m.drug);
      const subject = `RxSafe Lens — dispensing worksheet ${state.lastResponse.worksheet_id || ''}`;
      const body = [
        `Worksheet ID: ${state.lastResponse.worksheet_id || '—'}`,
        `Read mode: ${state.lastResponse.mode || '—'}`,
        `${ws.read_summary || ''}`,
        '',
        'Medicines read:',
        ...meds.map((m) => `  - ${m.drug}${m.strength ? ' ' + m.strength : ''} — ${m.frequency || '?'}${m.timing ? ' · ' + m.timing : ''}${m.duration_days ? ' · ' + m.duration_days + ' days' : ''}`),
        '',
        'Safety flags:',
        ...(ws.safety_flags || []).map((f) => `  [${f.severity}] ${f.type || f.message}`),
        '',
        'Deterministic checks:',
        ...(state.lastResponse.deterministic || []).map((d) => `  [${d.severity}] ${d.label}`),
        '',
        (ws.disclaimer || 'Decision-support only. The pharmacist must verify and approve before dispensing.')
      ].filter(Boolean).join('\n');
      const res = await fetch('/api/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: email, subject, body }) });
      const data = await res.json();
      if (!res.ok) {
        $('fuStatus').textContent = data.error || 'Could not email the worksheet.';
        return;
      }
      $('fuStatus').textContent = data.previewUrl
        ? `Worksheet emailed to ${email} via ${data.transport} — open the preview: ${data.previewUrl}`
        : `Worksheet emailed to ${email}${data.transport ? ` via ${data.transport}` : ''}.`;
      notyf.success('Worksheet emailed.');
    } catch (e) {
      $('fuStatus').textContent = 'Error emailing worksheet: ' + e.message;
    }
  });

  // Wire the follow-up fields from the current worksheet when a new one renders.
  // The <select> only accepts the exact option values — a value like "4" was
  // silently reset to "" before, so pick the closest real option instead.
  const REFILL_OPTIONS = [0, 1, 2, 3, 5, 7];

  function seedFollowUpFromWorksheet(data) {
    const ws = (data && (data.worksheet || {})) || {};
    const meds = (ws.extracted_medications || []).filter((m) => m.drug && typeof m.duration_days === 'number');
    if (meds.length) {
      const earliest = Math.min(...meds.map((m) => m.duration_days));
      const visit = new Date(Date.now() + Math.max(1, earliest) * 24 * 60 * 60 * 1000);
      $('fuVisitDate').value = visit.toISOString().slice(0, 10);
      const wanted = Math.min(7, Math.max(0, Math.round(earliest * 0.4)));
      const closest = REFILL_OPTIONS.reduce((a, b) => (Math.abs(b - wanted) < Math.abs(a - wanted) ? b : a), 0);
      $('fuRefillWhen').value = String(closest);
    } else {
      $('fuVisitDate').value = '';
      $('fuRefillWhen').value = '0';
    }
    if (state.email && !$('fuEmail').value) $('fuEmail').value = state.email;
  }

  const origRender = render;
  render = function (data) {
    origRender.call(this, data);
    seedFollowUpFromWorksheet(data);
  };
}

// ---------------- Boot -------------------------------------------------------
loadMode();
loadSamples();
renderHistory();
loadTraceability();
setupVoice();
setupCopilot();

// Deep link: /?chat=1 opens MediPilot straight away (useful on a counter tablet
// and for screenshotting the conversation UI).
try {
  if (new URLSearchParams(window.location.search).get('chat') === '1' && window.openCopilot) {
    window.openCopilot();
  }
} catch {
  /* ignore malformed URLs */
}
