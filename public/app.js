const $ = (id) => document.getElementById(id);
let lastImageDataUrl = null;

async function loadMode() {
  try {
    const m = await (await fetch('/api/mode')).json();
    const b = $('mode-badge');
    b.textContent = m.live ? `LIVE · ${m.model}` : 'CACHED DEMO MODE';
    b.className = 'badge ' + (m.live ? 'live' : 'cached');
  } catch {
    $('mode-badge').textContent = 'offline';
  }
}

async function loadExamples() {
  const exs = await (await fetch('/api/examples')).json();
  const sel = $('example-select');
  for (const ex of exs) {
    const o = document.createElement('option');
    o.value = ex.id;
    o.textContent = `${ex.kind === 'predatory' ? '🚩' : ex.kind === 'fair' ? '✅' : '⚠️'} ${ex.label}`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    const ex = exs.find((e) => e.id === sel.value);
    if (ex) $('message').value = ex.text;
  });
}

$('screenshot').addEventListener('change', (e) => {
  const f = e.target.files[0];
  $('file-name').textContent = f ? `📷 ${f.name}` : 'Attach agreement photo (optional)';
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, flags) {
  let html = escapeHtml(text);
  for (const f of flags || []) {
    if (!f.quoted_evidence) continue;
    const esc = escapeHtml(f.quoted_evidence);
    if (html.includes(esc)) {
      html = html.replace(esc, `<mark class="hl-${f.severity}">${esc}</mark>`);
    }
  }
  return html;
}

const VERDICTS = {
  landlord_heavy: { cls: 'high', label: 'LANDLORD-HEAVY — negotiate before signing' },
  mixed: { cls: 'medium', label: 'MIXED — several clauses need negotiation' },
  tenant_favorable: { cls: 'ok', label: 'TENANT-FAVORABLE — standard protections present' }
};

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function render(data) {
  const r = data.report;
  $('inputs-panel').classList.remove('hidden');
  $('report').classList.remove('hidden');

  $('input-text').innerHTML = highlight(data.sourceText, r.flags);
  if (lastImageDataUrl) {
    $('image-box').classList.remove('hidden');
    $('input-image').src = lastImageDataUrl;
  }
  $('input-rules').innerHTML = (data.rules || [])
    .map(
      (x) =>
        `<li><span class="sev sev-${x.severity}">${x.severity}</span> <strong>${escapeHtml(x.label)}</strong>${x.evidence ? ` — <code>${escapeHtml(x.evidence)}</code>` : ''}</li>`
    )
    .join('') || '<li>No deterministic findings — Gemma judgment only.</li>';

  const v = VERDICTS[r.verdict] || VERDICTS.mixed;
  const modeLabel =
    data.mode === 'live'
      ? 'live Gemma analysis'
      : data.mode === 'cached-fallback'
        ? 'cached analysis (live unavailable)'
        : 'cached analysis (offline demo)';
  $('verdict-banner').className = 'verdict ' + v.cls;
  $('verdict-banner').innerHTML = `<strong>${v.label}</strong><span class="muted">· confidence ${(r.confidence * 100).toFixed(0)}% · ${modeLabel}</span>`;

  $('flags').innerHTML =
    (r.flags || [])
      .map(
        (f) => `
    <div class="flag" data-sev="${f.severity}">
      <div class="flag-head"><span class="sev sev-${f.severity}">${f.severity}</span><strong>${escapeHtml(f.type)}</strong></div>
      ${f.quoted_evidence ? `<blockquote class="quote">“${escapeHtml(f.quoted_evidence)}”</blockquote>` : ''}
      <p>${escapeHtml(f.why_risky || '')}</p>
      ${f.negotiation_tip ? `<p class="tip">💡 ${escapeHtml(f.negotiation_tip)}</p>` : ''}
    </div>`
      )
      .join('') || '<p class="ok-note">No red flags found — the agreement follows standard tenant protections.</p>';

  $('missing').innerHTML =
    (r.missing_protections || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>None — protections are present.</li>';
  $('verify').innerHTML = (r.verification_steps || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  $('summary').textContent = r.plain_summary || '';
  $('confidence-row').innerHTML = `<div class="conf-bar"><div class="conf-fill" style="width:${(r.confidence * 100).toFixed(0)}%"></div></div><span class="muted">Gemma confidence: ${(r.confidence * 100).toFixed(0)}%</span>`;
  $('report').scrollIntoView({ behavior: 'smooth' });
}

$('analyze').addEventListener('click', async () => {
  const text = $('message').value.trim();
  const file = $('screenshot').files[0];
  if (!text && !file) {
    alert('Paste the agreement text or attach a photo first.');
    return;
  }
  const body = { text: text || '(photo only — see screenshot)' };
  if (file) {
    lastImageDataUrl = await fileToDataUrl(file);
    body.imageBase64 = lastImageDataUrl.split(',')[1];
    body.imageMime = file.type;
  }
  if ($('example-select').value) body.exampleId = $('example-select').value;

  const btn = $('analyze');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Analysis failed.');
      return;
    }
    render(data);
  } catch (e) {
    alert('Network error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Forensic Analysis';
  }
});

loadMode();
loadExamples();
