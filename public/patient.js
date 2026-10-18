/** RxSafe Lens — patient dashboard logic.
 *  Flow: upload photo -> read & explain -> discuss (with memory) -> reminders.
 *  Voice everywhere: dictate questions (Sarvam STT), hear answers (Sarvam TTS),
 *  voice-to-voice loop on the discussion. */
(function () {
  const API = '/api/patient';

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ============ state ============ */
  const state = {
    docId: null,
    docName: null,
    extraction: null,
    explanation: null,
    voice: { stt: false, tts: false },
    autoSpeak: true,
    busy: false,
    chatBusy: false,
    explaining: false,
    explainError: null,
    readMs: null,
    explainMs: null,
    recorder: null,
    chunks: [],
    lang: 'en-IN'
  };

  // The language the patient picked travels with the whole voice loop: what the
  // microphone transcribes, what the model answers in, and what is spoken back.
  const LANG_KEY = 'rxsafe_lang';
  const saveLang = () => {
    try { localStorage.setItem(LANG_KEY, state.lang); } catch { /* private mode */ }
  };
  const loadLang = () => {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved && $('#chatLang') && [...$('#chatLang').options].some((o) => o.value === saved)) {
        state.lang = saved;
        $('#chatLang').value = saved;
      }
    } catch { /* private mode */ }
  };

  const saveMemory = () => {
    try {
      localStorage.setItem('rxsafe_patient_memory', JSON.stringify({
        docId: state.docId, docName: state.docName,
        extraction: state.extraction, explanation: state.explanation
      }));
    } catch { /* storage full or blocked — the server still remembers */ }
  };

  const loadMemory = () => {
    try {
      const m = JSON.parse(localStorage.getItem('rxsafe_patient_memory') || 'null');
      if (m && m.docId) {
        state.docId = m.docId; state.docName = m.docName;
        state.extraction = m.extraction; state.explanation = m.explanation;
        return true;
      }
    } catch { /* ignore */ }
    return false;
  };

  /* ============ stage machine ============ */
  const showStage = (n) => {
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.remove('visible');
      p.classList.add('hidden');
    });
    const stage = $(`.stage${n}`);
    if (stage) {
      stage.classList.remove('hidden');
      stage.classList.add('visible');
    }
    document.body.classList.toggle('chat-open', n === 3);
    document.querySelectorAll('.progress .step').forEach((s) => {
      const i = Number(s.dataset.step);
      s.classList.toggle('active', i === n);
      s.classList.toggle('done', i < n);
    });
    document.querySelectorAll('.sb-step').forEach((s) => {
      const i = Number(s.dataset.step);
      s.classList.toggle('active', i === n);
      s.classList.toggle('done', i < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /* ============ tts: text -> voice (Sarvam), browser fallback ============ */
  let lastSpoken = '';
  const speak = async (text, btn) => {
    const clean = String(text || '').replace(/\[[^\]]+\]/g, '').replace(/[*_#`]/g, '').trim();
    if (!clean) return;
    lastSpoken = clean;
    const audio = $('#audioPlayback');
    if (btn) { btn.classList.add('speaking'); btn.textContent = '⏸ playing'; }
    const done = () => { if (btn) { btn.classList.remove('speaking'); btn.textContent = btn.dataset.label; } };

    if (state.voice.tts) {
      try {
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean.slice(0, 1400), languageCode: state.lang })
        });
        if (r.ok) {
          const d = await r.json();
          if (d.audioBase64) {
            audio.src = `data:${d.mime || 'audio/wav'};base64,${d.audioBase64}`;
            audio.onended = done;
            await audio.play().catch(() => {});
            return;
          }
        }
      } catch { /* fall through to browser voice */ }
    }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = state.lang;
      u.onend = done;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } else done();
  };

  const hearButton = (text) => {
    const b = el('button', 'iconbtn hear', 'Hear it');
    b.type = 'button';
    b.dataset.label = 'Hear it';
    b.addEventListener('click', () => speak(text, b));
    return b;
  };

  /* ============ stt: voice -> text. Sarvam first, browser speech as backstop ============ */
  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
    rd.onerror = reject;
    rd.readAsDataURL(blob);
  });

  const dictate = async (btn, statusEl, onText) => {
    if (state.recorder && state.recorder.state === 'recording') {
      state.recorder.stop();
      return;
    }
    statusEl.textContent = 'Listening… speak now, tap again to stop.';
    // Keep the button's SVG intact: swap innerHTML, not textContent.
    const idleHtml = btn.innerHTML;
    btn.classList.add('recording');
    btn.textContent = '⏹';
    const stopUI = () => { btn.classList.remove('recording'); btn.innerHTML = idleHtml; };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { audioBitsPerSecond: 48000 });
      state.recorder = rec;
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        stopUI();
        const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
        statusEl.textContent = 'Transcribing…';
        try {
          const audioBase64 = await blobToBase64(blob);
          const r = await fetch('/api/stt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64, mime: blob.type || 'audio/webm', languageCode: state.lang })
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'transcription failed');
          statusEl.textContent = '';
          onText(d.transcript || '');
        } catch (e) {
          // Browser speech engine as the fallback path when Sarvam can't take it.
          statusEl.textContent = `Could not transcribe (${e.message.slice(0, 60)}). Try typing instead.`;
        }
      };
      rec.start();
    } catch (e) {
      stopUI();
      statusEl.textContent = `Microphone unavailable (${e.message.slice(0, 60)}).`;
    }
  };

  /* ============ upload ============ */
  const fileInput = $('#fileInput');
  $('#selectBtn').addEventListener('click', () => fileInput.click());

  let pendingFile = null;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    pendingFile = f;
    if (f.type.startsWith('image/')) {
      const rd = new FileReader();
      rd.onload = () => { $('#previewImg').src = rd.result; $('#previewCard').classList.remove('hidden'); };
      rd.readAsDataURL(f);
    } else {
      $('#previewCard').classList.remove('hidden');
      $('#previewImg').removeAttribute('src');
      $('#previewImg').alt = 'Text / PDF document';
    }
    $('#readBtn').classList.remove('hidden');
    uploadZoneFix();
  });

  const uploadZoneFix = () => {
    // The zone stays visible but the buttons shrink once a file is attached.
    $('#selectBtn').textContent = 'Choose a different photo';
  };

  $('#cancelUpload').addEventListener('click', () => {
    pendingFile = null;
    fileInput.value = '';
    $('#previewCard').classList.add('hidden');
    $('#readBtn').classList.add('hidden');
    $('#selectBtn').textContent = 'Choose photo';
  });

  // Dictation -> a text document the same pipeline can read.
  $('#micUploadBtn').addEventListener('click', function () {
    dictate(this, $('#micUploadStatus'), (text) => {
      if (!text) return;
      pendingFile = null;
      $('#previewCard').classList.remove('hidden');
      $('#previewImg').removeAttribute('src');
      $('#readBtn').classList.remove('hidden');
      readTextDoc(text);
    });
  });

  const readTextDoc = async (text) => {
    setBusy(true, $('#readStatus'), 'Reading what you said…');
    try {
      const res = await fetch(`${API}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, fileName: 'dictated note' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'read failed');
      onRead(data);
    } catch (e) {
      setBusy(false, $('#readStatus'), `Could not read that: ${e.message}`, true);
    }
  };

  $('#readBtn').addEventListener('click', async () => {
    if (!pendingFile) return;
    const f = pendingFile;
    // The read is its own request now (a few seconds); the plain-word pass is
    // fetched after the report is on screen, so do not promise half a minute.
    setBusy(true, $('#readStatus'), f.type.startsWith('image/')
      ? 'Reading your photo… a few seconds.'
      : 'Reading your document… a few seconds.');
    try {
      const payload = { fileName: f.name };
      if (f.type.startsWith('image/')) {
        payload.fileBase64 = await fileToBase64(f);
        payload.fileMime = f.type;
      } else {
        payload.fileBase64 = await fileToBase64(f);
        payload.fileMime = f.type || 'application/octet-stream';
      }
      const res = await fetch(`${API}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'read failed');
      onRead(data);
    } catch (e) {
      setBusy(false, $('#readStatus'), `Could not read that document: ${e.message}`, true);
    }
  });

  const fileToBase64 = (f) => new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
    rd.onerror = reject;
    rd.readAsDataURL(f);
  });

  const setBusy = (busy, statusEl, msg, isError) => {
    state.busy = busy;
    if (statusEl) {
      statusEl.textContent = msg || '';
      statusEl.classList.toggle('error', !!isError);
    }
    document.querySelectorAll('button.primary').forEach((b) => { b.disabled = busy; });
  };

  const onRead = (data) => {
    setBusy(false, $('#readStatus'), '');
    state.docId = data.doc.id;
    state.docName = data.doc.name;
    state.extraction = data.extraction;
    state.explanation = data.explanation || null;
    state.explainError = null;
    state.readMs = (data.timings && data.timings.extract_ms) || null;
    saveMemory();
    renderReport(data);
    renderChatWelcome(data);
    showStage(2);
    refreshRag();

    // Report the measured read time instead of leaving "it felt slow" open.
    const readS = data.timings && data.timings.extract_ms ? (data.timings.extract_ms / 1000).toFixed(1) : null;
    const meds = (data.extraction && data.extraction.medicines) || [];
    $('#readStatus').textContent = readS
      ? `Read in ${readS}s${meds.length ? '' : ' — no medicine name could be read from this document, so check the photo again'}.`
      : '';

    if (state.explanation) {
      // Tell the patient the read is done, out loud, if they have voice on.
      if (state.autoSpeak && state.explanation.plain_summary) speak(state.explanation.plain_summary);
    } else if (meds.length) {
      requestExplanation();
    }
  };

  // The plain-language pass runs on its own request (and its own budget), so the
  // read appears immediately and the wording lands a few seconds later.
  const requestExplanation = async () => {
    if (!state.docId) return;
    state.explaining = true;
    state.explainError = null;
    renderReport(null);
    try {
      // Hard client-side ceiling. The server already budgets each model tier, but
      // a dropped connection must never leave "Putting this in plain words…" on
      // screen forever with no way out.
      const r = await fetch(`${API}/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: state.docId }),
        signal: AbortSignal.timeout(60_000)
      });
      const d = await r.json();
      if (r.ok && d.explanation) {
        state.explanation = d.explanation;
        state.explainMs = (d.timings && d.timings.total_ms) || null;
        state.explaining = false;
        saveMemory();
        renderReport(null);
        renderChatWelcome(null);
        if (state.autoSpeak && d.explanation.plain_summary) speak(d.explanation.plain_summary);
        return;
      }
      state.explaining = false;
      state.explainError = d.error || 'The plain-word explanation did not finish.';
      renderReport(null);
    } catch (e) {
      state.explaining = false;
      state.explainError = `The plain-word explanation could not be fetched (${String(e.message).slice(0, 60)}).`;
      renderReport(null);
    }
  };

  /* ============ report ============ */
  const renderReport = (data) => {
    const ex = (data && data.extraction) || state.extraction || {};
    const exp = (data && data.explanation) || state.explanation || {};
    const wrap = $('#reportCards');
    wrap.innerHTML = '';

    const head = el('div', 'card card-head');
    const who = el('div', 'card-title-row');
    who.appendChild(el('h3', null, state.docName || 'Your document'));
    if (exp.plain_summary) who.appendChild(hearButton(exp.plain_summary));
    head.appendChild(who);
    if (exp.plain_summary) {
      head.appendChild(el('p', null, exp.plain_summary));
    } else if (state.explaining) {
      head.appendChild(el('p', 'explaining', 'Putting this in plain words… the read below is already done.'));
    } else if (state.explainError) {
      head.appendChild(el('p', 'warn', `The plain-word explanation did not finish. The read below is unaffected — you can still discuss it. (${state.explainError.slice(0, 110)})`));
      const again = el('button', 'ghost tiny', 'Try the plain words again');
      again.type = 'button';
      again.addEventListener('click', () => requestExplanation());
      head.appendChild(again);
    } else {
      head.appendChild(el('p', null, 'Read completed. Ask a question below to go through it together.'));
    }
    const split = el('p', 'card-sub', `Read by ${ex.model || 'vision model'} · explained by ${(exp && exp.model) || 'reasoning model'}` +
      (state.readMs ? ` · read in ${(state.readMs / 1000).toFixed(1)}s` : '') +
      (state.explainMs ? ` · explained in ${(state.explainMs / 1000).toFixed(1)}s` : '') +
      (ex.date ? ` · dated ${ex.date}` : '') + (ex.prescriber ? ` · ${ex.prescriber}` : ''));
    head.appendChild(split);
    wrap.appendChild(head);

    // Medicines with the model's plain-language cards per drug.
    const meds = ex.medicines || [];
    if (meds.length) {
      const card = el('div', 'card');
      card.appendChild(el('h3', null, `Medicines found (${meds.length})`));
      meds.forEach((m) => {
        const row = el('div', 'med-row');
        const top = el('div', 'med-top');
        top.appendChild(el('strong', null, `${m.drug}${m.strength ? ' · ' + m.strength : ''}`));
        if (m.frequency) top.appendChild(el('span', 'chip sm', m.frequency));
        if (typeof m.confidence === 'number') top.appendChild(el('span', 'chip sm conf', `${Math.round(m.confidence * 100)}% sure`));
        row.appendChild(top);
        const pl = (exp.per_medicine || []).find((x) => x.drug && m.drug && x.drug.toLowerCase().includes(m.drug.toLowerCase().slice(0, 6)));
        if (pl) {
          if (pl.what_it_is_for) row.appendChild(el('p', 'plain', `For: ${pl.what_it_is_for}`));
          if (pl.how_to_take_it) row.appendChild(el('p', 'plain', `How: ${pl.how_to_take_it}`));
          if (pl.look_out_for) row.appendChild(el('p', 'plain warn', `Watch for: ${pl.look_out_for}`));
        }
        if (m.ambiguity) row.appendChild(el('p', 'plain warn', `The handwriting could also read as “${m.ambiguity}” — confirm with your pharmacist.`));
        row.appendChild(hearButton([m.drug, m.strength, pl && pl.what_it_is_for, pl && pl.how_to_take_it].filter(Boolean).join('. ')));
        card.appendChild(row);
      });
      wrap.appendChild(card);
    }

    // Already have / need to buy
    if ((exp.already_have || []).length || (exp.need_to_buy || []).length) {
      const card = el('div', 'card');
      card.appendChild(el('h3', null, 'Your medicines shelf'));
      if ((exp.already_have || []).length) {
        card.appendChild(el('p', 'minilabel', 'Already with you'));
        const ul = el('ul', 'list');
        exp.already_have.forEach((x) => ul.appendChild(el('li', null, x)));
        card.appendChild(ul);
      }
      if ((exp.need_to_buy || []).length) {
        card.appendChild(el('p', 'minilabel', 'Need to buy'));
        const ul = el('ul', 'list buy');
        exp.need_to_buy.forEach((x) => ul.appendChild(el('li', null, x)));
        card.appendChild(ul);
      }
      card.appendChild(hearButton(`You already have ${(exp.already_have || []).join(', ') || 'nothing on this list'}. You need to buy ${(exp.need_to_buy || []).join(', ') || 'nothing right now'}.`));
      wrap.appendChild(card);
    }

    if (exp.next_visit) {
      const card = el('div', 'card');
      card.appendChild(el('h3', null, 'Next visit'));
      card.appendChild(el('p', null, exp.next_visit));
      card.appendChild(hearButton(exp.next_visit));
      wrap.appendChild(card);
    }

    // Doctor questions — tap one to ask it in the discussion, or say it.
    const qs = (exp.questions || []).slice(0, 5);
    if (qs.length) {
      const card = el('div', 'card');
      card.appendChild(el('h3', null, 'Worth asking your doctor'));
      const chips = el('div', 'suggest');
      qs.forEach((q, i) => {
        const c = el('button', 'suggest-chip', `🙋 ${q}`);
        c.type = 'button';
        c.addEventListener('click', () => { chatInput.value = q; showStage(3); chatInput.focus(); });
        chips.appendChild(c);
      });
      card.appendChild(chips);
      wrap.appendChild(card);
    }

    if ((exp.warning_lines || []).length) {
      const card = el('div', 'card warn-card');
      card.appendChild(el('h3', null, 'Safety notes'));
      const ul = el('ul', 'list');
      exp.warning_lines.forEach((w) => ul.appendChild(el('li', null, w)));
      card.appendChild(ul);
      wrap.appendChild(card);
    }
  };

  /* ============ sidebar dashboard: navigation + RAG panel ============ */
  const setText = (sel, txt) => { const n = $(sel); if (n) n.textContent = txt; };

  const refreshRag = async (attempt = 0) => {
    try {
      const r = await fetch(`${API}/rag`, { signal: AbortSignal.timeout(10_000) });
      const d = await r.json();
      if (!r.ok) return;
      setText('#sbDocs', d.documents);
      setText('#sbChunks', d.chunks);
      setText('#sbQuestions', d.questions);
      setText('#sbRetrievalMode', `top-${d.top_k} lexical retrieval over your own uploads`);

      const list = $('#sbDocsList');
      list.innerHTML = '';
      if (!d.docs.length) {
        list.innerHTML = '<li class="muted">Upload a prescription to index it.</li>';
      } else {
        d.docs.forEach((doc) => {
          const li = el('li');
          const b = el('button', 'sb-doc');
          b.type = 'button';
          b.appendChild(el('b', null, doc.name));
          const drugs = (doc.drugs || []).map((x) => x.drug || x).filter(Boolean).slice(0, 2).join(', ');
          b.appendChild(el('span', null,
            `${doc.chunks} chunk${doc.chunks === 1 ? '' : 's'} · ${doc.chars} chars · ${drugs || 'no medicine read'}`));
          b.title = 'Open the discussion for this document';
          b.addEventListener('click', () => openDocument(doc.id));
          li.appendChild(b);
          list.appendChild(li);
        });
      }

      const mem = $('#sbMemory');
      mem.innerHTML = '';
      mem.appendChild(el('li', null, d.memory && d.memory.reachable
        ? 'Memory graph connected — earlier questions are recalled before answering.'
        : 'Memory stays on this machine (browser + local server files).'));
      mem.appendChild(el('li', null,
        `${d.documents} document${d.documents === 1 ? '' : 's'} indexed · ${d.chunks} retrievable chunk${d.chunks === 1 ? '' : 's'} · ${d.questions} question${d.questions === 1 ? '' : 's'} answered`));
    } catch { /* the dashboard is best-effort */
      // One silent failure leaves stale counts and a dead document list on
      // screen, which reads as "it didn't work". Retry once before giving up.
      if (attempt < 1) setTimeout(() => refreshRag(attempt + 1), 1200);
    }
  };

  // Show the excerpts the last answer actually used — the visible half of RAG.
  const showRetrieval = (sources) => {
    const list = $('#sbRetrieval');
    if (!list) return;
    list.innerHTML = '';
    if (!sources || !sources.length) {
      list.innerHTML = '<li class="muted">No excerpt matched — the answer said so instead of guessing.</li>';
      return;
    }
    sources.slice(0, 4).forEach((s) => {
      const snippet = String(s.snippet || '').replace(/\s+/g, ' ').trim();
      list.appendChild(el('li', 'sb-snippet', `“${snippet.slice(0, 130)}${snippet.length > 130 ? '…' : ''}”`));
    });
  };

  document.querySelectorAll('.sb-step').forEach((b) => {
    b.addEventListener('click', () => showStage(Number(b.dataset.step)));
  });

  // On narrow screens the sidebar is hidden and the top progress bar is the only
  // navigation — it used to be decorative, so taps on "3. Discuss" did nothing.
  document.querySelectorAll('.progress .step').forEach((s) => {
    s.setAttribute('role', 'button');
    s.setAttribute('tabindex', '0');
    const go = () => showStage(Number(s.dataset.step));
    s.addEventListener('click', go);
    s.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });

  /* ============ discussion (full-screen conversation) ============ */
  const chatWindow = $('#chatWindow');
  const chatMessages = $('#chatMessages');
  const chatEmpty = $('#chatEmpty');
  const chatInput = $('#chatInput');

  const FALLBACK_QUESTIONS = [
    'What do these medicines do?',
    'When should I take each one?',
    'What should I do if I miss a dose?',
    'What should I ask my doctor?'
  ];

  // Model answers may contain light markdown. Render it, but sanitize strictly:
  // the answer is untrusted text from a model.
  const md = (text) => {
    const raw = String(text || '');
    try {
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(raw, { breaks: true }));
      }
    } catch { /* fall through to escaped text */ }
    return raw
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
      .replace(/\n/g, '<br />');
  };

  const scrollChat = () => {
    requestAnimationFrame(() => { chatWindow.scrollTop = chatWindow.scrollHeight; });
  };

  const showEmptyState = (on) => { chatEmpty.style.display = on ? 'flex' : 'none'; };

  const followupChips = (prompts) => {
    const wrap = el('div', 'followups');
    wrap.appendChild(el('span', 'lbl', 'Keep going'));
    prompts.slice(0, 3).forEach((p) => {
      const c = el('button', null, p);
      c.type = 'button';
      c.addEventListener('click', () => {
        chatInput.value = p;
        autoGrow();
        ask();
      });
      wrap.appendChild(c);
    });
    return wrap;
  };

  const addBubble = (role, text, opts = {}) => {
    showEmptyState(false);
    const b = el('div', `chat-msg ${role}`);
    if (role === 'bot') {
      const ava = el('span', 'ava', 'Rx');
      ava.setAttribute('aria-hidden', 'true');
      const body = el('div', 'body');

      const content = el('div', 'md');
      content.innerHTML = md(text);
      body.appendChild(content);

      if (opts.sources && opts.sources.length) {
        const s = el('div', 'sources');
        opts.sources.slice(0, 3).forEach((src) => {
          const snippet = String(src.snippet || '').replace(/\s+/g, ' ').trim();
          const chip = el('span', 'source', `From your document: “${snippet.slice(0, 56)}${snippet.length > 56 ? '…' : ''}”`);
          chip.title = snippet;
          s.appendChild(chip);
        });
        body.appendChild(s);
      }

      const bar = el('div', 'bubble-actions');
      const hb = el('button', 'iconbtn tiny', 'Hear it');
      hb.type = 'button';
      hb.dataset.label = 'Hear it';
      hb.addEventListener('click', () => speak(text, hb));
      bar.appendChild(hb);

      const cb = el('button', 'iconbtn tiny', 'Copy');
      cb.type = 'button';
      cb.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(String(text || ''));
          cb.textContent = 'Copied';
          setTimeout(() => { cb.textContent = 'Copy'; }, 1400);
        } catch {
          cb.textContent = 'Copy blocked';
        }
      });
      bar.appendChild(cb);
      body.appendChild(bar);

      if (opts.followups && opts.followups.length) body.appendChild(followupChips(opts.followups));

      b.appendChild(ava);
      b.appendChild(body);
    } else {
      b.textContent = text;
    }
    chatMessages.appendChild(b);
    scrollChat();
    return b;
  };

  const thinkingBubble = () => {
    showEmptyState(false);
    const b = el('div', 'chat-msg bot thinking');
    const ava = el('span', 'ava', 'Rx');
    ava.setAttribute('aria-hidden', 'true');
    const body = el('div', 'body');
    const dots = el('span', 'dots');
    dots.setAttribute('aria-label', 'Looking at your document');
    dots.innerHTML = '<i></i><i></i><i></i>';
    body.appendChild(dots);
    b.appendChild(ava);
    b.appendChild(body);
    chatMessages.appendChild(b);
    scrollChat();
    return b;
  };

  const renderChatWelcome = (data) => {
    chatMessages.innerHTML = '';
    showEmptyState(true);
    $('#chatDocName').textContent = state.docName || 'your document';

    const exp = (data && data.explanation) || state.explanation || {};
    const intro = chatEmpty.querySelector('p');
    if (intro) {
      intro.textContent = exp.plain_summary
        ? `${exp.plain_summary} Ask me anything about this document — type, or tap the mic and just talk.`
        : 'I answer only from your document — the medicines, the timings and what the doctor wrote. Ask your own question or pick one below.';
    }

    const wrap = $('#chatSuggestions');
    wrap.innerHTML = '';
    const qs = (exp.questions || []).filter(Boolean).slice(0, 4);
    (qs.length ? qs : FALLBACK_QUESTIONS).forEach((q, i) => {
      const card = el('button', 'ce-card');
      card.type = 'button';
      card.appendChild(el('b', null, q));
      card.appendChild(el('span', null, i === 0 && qs.length ? 'From your document' : 'Tap to ask this'));
      card.addEventListener('click', () => {
        chatInput.value = q;
        autoGrow();
        ask();
      });
      wrap.appendChild(card);
    });
  };

  const loadChatFromServer = async () => {
    if (!state.docId) return;
    try {
      const r = await fetch(`${API}/chat/${state.docId}`);
      const d = await r.json();
      const turns = (d.turns || []).slice(-12);
      if (!turns.length) return;
      chatMessages.innerHTML = '';
      showEmptyState(false);
      turns.forEach((t) => addBubble(t.role === 'user' ? 'user' : 'bot', t.text));
    } catch { /* first visit for this doc */ }
  };

  // Clicking a document in the sidebar opens THAT document. Before, the list
  // only jumped to the chat, so with two prescriptions on file the patient
  // asked about one while looking at the other.
  const openDocument = async (id) => {
    if (!id || state.busy) return;
    try {
      const [docRes, exRes] = await Promise.all([
        fetch(`${API}/doc/${id}`, { signal: AbortSignal.timeout(15_000) }),
        fetch(`${API}/explain/${id}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
      ]);
      const docData = await docRes.json();
      if (!docRes.ok || !docData.doc) throw new Error(docData.error || 'document not found');
      const cached = exRes && exRes.ok ? await exRes.json().catch(() => null) : null;
      const doc = docData.doc;
      const meta = doc.meta || {};

      state.docId = doc.id;
      state.docName = doc.name;
      state.extraction = {
        model: meta.model || 'text',
        raw_text: doc.text,
        document_type: doc.kind,
        medicines: doc.drugs || [],
        prescriber: meta.prescriber || null,
        date: meta.date || null,
        follow_up_date: meta.follow_up_date || null
      };
      state.explanation = (cached && cached.explanation) || null;
      state.explaining = false;
      state.explainError = null;
      state.readMs = null;
      state.explainMs = null;
      saveMemory();
      renderReport(null);
      renderChatWelcome(null);
      showStage(3);
      await loadChatFromServer();
      chatInput.focus();
      // A cached explanation is instant; an uncached one is fetched in the
      // background so the document opens immediately either way.
      if (!state.explanation && (state.extraction.medicines || []).length) requestExplanation();
    } catch (e) {
      setText('#sbMode', `Could not open that document (${String(e.message).slice(0, 60)}).`);
    }
  };

  const autoGrow = () => {
    if (!chatInput) return;
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(180, Math.max(24, chatInput.scrollHeight))}px`;
  };

  const ask = async () => {
    const q = chatInput.value.trim();
    if (!q || state.chatBusy) return;
    if (!state.docId) {
      addBubble('bot', 'Upload a prescription first — then I can answer questions about it.');
      return;
    }
    state.chatBusy = true;
    $('#sendChatBtn').disabled = true;
    chatInput.value = '';
    autoGrow();
    addBubble('user', q);
    const thinking = thinkingBubble();
    $('#micChatStatus').textContent = 'Reading your document…';

    try {
      const r = await fetch(`${API}/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId: state.docId, question: q, languageCode: state.lang })
      });
      const d = await r.json();
      thinking.remove();
      if (!r.ok) throw new Error(d.error || 'could not answer');
      const followups = [
        'Explain that in simpler words.',
        'What should I ask my doctor about this?',
        'What should I watch out for after taking it?'
      ];
      addBubble('bot', d.answer, { sources: d.sources, followups });
      showRetrieval(d.sources);
      refreshRag();
      if (state.autoSpeak) speak(d.answer);
      const secs = d.timings && d.timings.total_ms ? (d.timings.total_ms / 1000).toFixed(1) : null;
      $('#micChatStatus').textContent = secs
        ? `Answered in ${secs}s${d.grounded ? ' from your document' : ' — your document did not cover this'}.`
        : '';
    } catch (e) {
      thinking.remove();
      addBubble('bot', `Sorry — I could not answer that just now (${String(e.message).slice(0, 80)}).`);
      $('#micChatStatus').textContent = '';
    } finally {
      state.chatBusy = false;
      $('#sendChatBtn').disabled = false;
      chatInput.focus();
    }
  };

  // Language selector: the server is the source of truth for what Sarvam can
  // actually transcribe and speak, so the options come from /api/patient/config.
  $('#chatLang').addEventListener('change', function () {
    state.lang = this.value;
    saveLang();
    const opt = this.options[this.selectedIndex];
    const pretty = opt ? `${opt.textContent.trim()} — I'll answer and speak in this language` : '';
    $('#micChatStatus').textContent = pretty;
  });

  $('#sendChatBtn').addEventListener('click', ask);
  chatInput.addEventListener('input', autoGrow);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });
  $('#micChatBtn').addEventListener('click', function () {
    dictate(this, $('#micChatStatus'), (text) => {
      if (text) {
        chatInput.value = text;
        autoGrow();
        ask(); // voice -> answer -> voice
      }
    });
  });

  $('#chatBackBtn').addEventListener('click', () => showStage(2));
  $('#openChatBtn').addEventListener('click', () => showStage(3));
  $('#newChatBtn').addEventListener('click', () => {
    state.chatBusy = false;
    renderChatWelcome(null);
    chatInput.value = '';
    autoGrow();
    $('#micChatStatus').textContent = 'New conversation. Earlier questions stay saved with your document.';
    chatInput.focus();
  });

  /* ============ reminders ============ */
  $('#scheduleBtn').addEventListener('click', async () => {
    const email = $('#remEmail').value.trim();
    const visitDate = $('#remVisitDate').value;
    const lead = Number($('#remRefillLead').value);
    const status = $('#remStatus');
    $('#remStatusField').style.display = 'block';
    if (!email) { status.textContent = 'Please enter your email address.'; status.className = 'status error'; return; }
    status.className = 'status';
    status.textContent = 'Scheduling…';
    try {
      const r = await fetch(`${API}/reminders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docId: state.docId,
          email,
          visitAt: visitDate ? new Date(visitDate + 'T09:00:00').toISOString() : null,
          refillInDays: lead
        })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      const lines = (d.created || []).map((c) => c.describe).join(' · ');
      status.textContent = `✅ Scheduled. ${lines}`;
      status.className = 'success';
    } catch (e) {
      status.textContent = `Could not schedule: ${e.message}`;
      status.className = 'status error';
    }
  });

  /* ============ email report ============ */
  $('#emailReportBtn').addEventListener('click', async () => {
    const to = $('#reportEmail').value.trim();
    if (!to) { $('#emailStatus').textContent = 'Enter an email address first.'; return; }
    $('#emailStatus').textContent = 'Sending…';
    try {
      const r = await fetch(`${API}/report/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'failed');
      $('#emailStatus').textContent = `✅ Sent via ${d.transport} to ${to}.`;
    } catch (e) {
      $('#emailStatus').textContent = `Could not send: ${e.message}`;
    }
  });

  /* ============ boot ============ */
  (async () => {
    try {
      const r = await fetch(`${API}/config`);
      const cfg = await r.json();
      state.voice = cfg.voice || { stt: false, tts: false };
      if (Array.isArray(cfg.voice && cfg.voice.languages) && cfg.voice.languages.length) {
        const sel = $('#chatLang');
        sel.innerHTML = '';
        cfg.voice.languages.forEach((l) => {
          const o = document.createElement('option');
          o.value = l.code;
          o.textContent = l.native || l.label || l.code;
          sel.appendChild(o);
        });
      }
      loadLang();
      $('#modeChip').querySelector('.mode-text').textContent =
        cfg.live ? `${cfg.extract_model} reads · ${cfg.explain_model} explains` : 'cached mode';
      if (cfg.extract_model) $('#readModelName').textContent = cfg.extract_model;
      setText('#sbMode', cfg.live
        ? `${cfg.extract_model} reads · ${cfg.explain_model} explains`
        : 'cached mode — no API key');
      const showMic = state.voice.stt;
      $('#micChatBtn').style.display = showMic ? '' : 'none';
      $('#micUploadBtn').style.display = showMic ? '' : 'none';
      if (!showMic) $('#micUploadStatus').textContent = 'Voice input is off in this session.';
    } catch { /* server offline — page still renders */ }

    const restored = loadMemory();
    showStage(1);
    refreshRag();
    if (restored) {
      renderReport(null);
      renderChatWelcome(null);
      await loadChatFromServer();
    }

    // Deep link for a counter tablet / demo: /?chat=1 lands straight in the
    // conversation when a document is already remembered.
    try {
      if (new URLSearchParams(location.search).get('chat') === '1') {
        renderChatWelcome(null);
        showStage(3);
      }
    } catch { /* ignore malformed URLs */ }
  })();

  $('#printReportBtn').addEventListener('click', () => window.print());
})();
