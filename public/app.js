// RxSafe Lens UI — talks to /api/mode, /api/samples and /api/analyze-rx.
// Renders the dispensing worksheet exactly as the API produces it: nothing here
// computes safety findings in the browser, so the demo shows what the backend
// (Gemma + deterministic rules) actually returned.

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { sampleId: null, image: null };

async function loadMode() {
  try {
    const m = await (await fetch('/api/mode')).json();
    const pill = $('modePill');
    pill.className = `pill ${m.live ? 'live' : 'cached'}`;
    pill.textContent = m.live ? 'LIVE · Gemma reading' : 'CACHED · synthetic slips only';
    $('modelName').textContent =
      m.live ? `model: ${m.model}` : 'no GEMINI_API_KEY — cached worksheets only';
  } catch {
    $('modePill').textContent = 'offline';
  }
}

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
        <div class="sctx">Patient context: ${escapeHtml(s.contextText)}</div>
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
  $('status').textContent = `Sample selected: ${s.label}. Add or edit the patient context, then analyze.`;
}

$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.image = f; // stored as File; converted on analyze
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

const READYNESS = {
  pharmacist_verification_required: {
    cls: 'low',
    label: 'READABLE SLIP — pharmacist verification required'
  },
  ambiguous_clarification_required: {
    cls: 'medium',
    label: 'AMBIGUOUS READING — clarification required before dispensing'
  },
  incomplete_information: {
    cls: 'high',
    label: 'INCOMPLETE INFORMATION — do not dispense until resolved'
  }
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
    $('meds').innerHTML = '<p class="empty">No medications were extracted — treat the read as failed and require a re-check.</p>';
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
        <th>Written on the slip</th><th>Interpreted read</th><th>Strength</th>
        <th>Frequency</th><th>Timing</th><th>Days</th><th>Name confidence</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderFlags(flags) {
  if (!flags || !flags.length) {
    $('flags').innerHTML =
      '<p class="empty">No safety flags raised. Escalating when there is nothing to escalate would be crying wolf.</p>';
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

let lastResponse = null;

function render(data) {
  lastResponse = data;
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
  renderFlags(ws.safety_flags || data.extracted_flags || []);

  $('checklist').innerHTML = (ws.verification_checklist || [])
    .map((x) => `<li>${escapeHtml(x)}</li>`)
    .join('');

  const det = data.deterministic || [];
  $('detChecks').innerHTML = det.length
    ? det.map((d) => `<li><strong>[${escapeHtml(d.severity)}]</strong> ${escapeHtml(d.label)}</li>`).join('')
    : '<li>None — the code layer found nothing to add to Gemma’s read.</li>';

  $('disclaimer').textContent =
    ws.disclaimer || 'Decision-support only. The pharmacist must verify and approve before dispensing.';

  $('worksheet').scrollIntoView({ behavior: 'smooth' });
}

$('analyzeBtn').addEventListener('click', async () => {
  const ctx = $('contextText').value.trim();
  const body = { contextText: ctx, sampleId: state.sampleId };
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
  btn.disabled = true;
  btn.textContent = 'Reading the slip…';
  $('status').textContent = 'Gemma reads the image → our code checks the read → worksheet assembled.';
  try {
    const res = await fetch('/api/analyze-rx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      $('status').textContent = data.error || 'Analysis failed.';
      return;
    }
    $('status').textContent = `Worksheet ready (${data.mode === 'live' ? 'live Gemma read' : 'cached worksheet'}).`;
    render(data);
  } catch (e) {
    $('status').textContent = 'Network error: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze prescription';
  }
});

$('exportBtn').addEventListener('click', () => {
  if (!lastResponse) return;
  const blob = new Blob([JSON.stringify(lastResponse, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rxsafe-worksheet-${lastResponse.sampleId || 'upload'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('printBtn').addEventListener('click', () => window.print());

loadMode();
loadSamples();
