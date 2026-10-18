// MediPilot long-term memory — Cognee (github.com/topoteretes/cognee) Cloud API,
// with an honest local fallback so the counter demo never depends on a live
// memory tenant being reachable.
//
// Follows skills/cognee/SKILL.md exactly:
//   ping    GET  {base}/api/v1/datasets/            (X-Api-Key)  → 200 = good
//   recall  POST {base}/api/v1/recall               {query, session_id[, search_type]}
//   remember POST {base}/api/v1/remember/entry      {entry:{type:"qa",question,answer},
//                                                    dataset_name, session_id}
// One session id per conversation is generated at start-up and reused in every
// call, so the session shows up in the Cognee Cloud dashboard.

const fs = require('fs');
const path = require('path');

const BASE = (process.env.COGNEE_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.COGNEE_API_KEY || null;
const DATASET = process.env.COGNEE_DATASET || 'default_dataset';

// One id for this run of the app (agent name + unix timestamp).
const SESSION_ID = `rxsafe-medipilot-${Math.floor(Date.now() / 1000)}`;

const STORE_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(STORE_DIR, 'medipilot-memory.json');

let pingCache = { at: 0, ok: false, code: null };

function headers(extra) {
  return { 'X-Api-Key': API_KEY || '', ...(extra || {}) };
}

function localRead() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function localWrite(entries) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(entries.slice(0, 200), null, 2));
  } catch (e) {
    console.error('[memory] local write failed:', e.message);
  }
}

// Term-overlap recall over local memories (deterministic, auditable).
function localRecall(query, k = 3) {
  const tokenize = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097f\u0b80-\u0bff\u0c80-\u0cff\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const q = tokenize(query);
  if (!q.length) return [];
  return localRead()
    .map((m) => {
      const hay = tokenize(`${m.question} ${m.answer}`);
      const hit = new Set(q.filter((w) => hay.includes(w)));
      return { ...m, score: hit.size / q.length };
    })
    .filter((m) => m.score > 0.15)
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, k);
}

// Ping Cognee Cloud before any operation (skill requirement).
async function ping() {
  if (!BASE || !API_KEY) return { ok: false, code: null, reason: 'not_configured' };
  if (Date.now() - pingCache.at < 30_000) return pingCache;
  try {
    const res = await fetch(`${BASE}/api/v1/datasets/`, {
      headers: headers(),
      signal: AbortSignal.timeout(8000)
    });
    pingCache = {
      at: Date.now(),
      ok: res.status === 200,
      code: res.status,
      reason: res.status === 200 ? null : res.status === 401 ? 'bad_api_key' : 'tenant_unreachable'
    };
  } catch (e) {
    pingCache = { at: Date.now(), ok: false, code: null, reason: `network_error: ${e.message.slice(0, 60)}` };
  }
  return pingCache;
}

// Session entry: the durable half of memory (converted to long-term memory by
// Cognee after the session).
async function remember({ question, answer, language, sources }) {
  const entry = {
    ts: Date.now(),
    question: String(question || '').slice(0, 500),
    answer: String(answer || '').slice(0, 1200),
    language: language || 'en-IN',
    sources: (sources || []).map((s) => s.id).slice(0, 6)
  };
  const entries = localRead();
  entries.unshift(entry);
  localWrite(entries);

  const p = await ping();
  if (!p.ok) return { stored: true, cognee: false, reason: p.reason || null };

  try {
    const res = await fetch(`${BASE}/api/v1/remember/entry`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        entry: { type: 'qa', question: entry.question, answer: entry.answer },
        dataset_name: DATASET,
        session_id: SESSION_ID
      }),
      // Ingestion on the tenant side can be slow; the caller detaches this.
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
    return { stored: true, cognee: true };
  } catch (e) {
    console.error('[memory] cognee remember failed:', e.message);
    return { stored: true, cognee: false, reason: e.message.slice(0, 80) };
  }
}

async function recall(query, k = 3) {
  const p = await ping();
  if (p.ok) {
    try {
      const res = await fetch(`${BASE}/api/v1/recall`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query, session_id: SESSION_ID, search_type: 'HYBRID_COMPLETION' }),
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : data.results || data.search_results || data.entries || [];
      const hits = rows
        .map((r) => (typeof r === 'string' ? r : r.text || r.content || r.answer || JSON.stringify(r)))
        .filter(Boolean)
        .slice(0, k)
        .map((text) => ({ text }));
      if (hits.length) return { hits, source: 'cognee' };
    } catch (e) {
      console.error('[memory] cognee recall failed:', e.message);
    }
  }
  return {
    hits: localRecall(query, k).map((m) => ({
      text: `Q: ${m.question}\nA: ${m.answer}`,
      ts: m.ts,
      language: m.language
    })),
    source: 'local'
  };
}

async function status() {
  const p = await ping();
  return {
    cognee: {
      configured: Boolean(BASE && API_KEY),
      base: BASE || null,
      reachable: p.ok,
      http_code: p.code,
      reason: p.reason || null,
      dataset: DATASET,
      session_id: SESSION_ID
    },
    local: { entries: localRead().length, file: 'data/medipilot-memory.json' },
    mode: p.ok ? 'cognee+local' : BASE ? `local (cognee: ${p.reason || 'unreachable'})` : 'local'
  };
}

module.exports = { remember, recall, status, ping, SESSION_ID };
