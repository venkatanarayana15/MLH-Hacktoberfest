// RxSafe Lens — patient side of the product.
//
//   1. RAG knowledge store: the patient uploads a prescription photo, a
//      discharge summary, a lab report or a medicine strip. We OCR/extract it
//      with Gemma (or accept text/PDF), chunk it, and index it so answers can
//      quote the actual uploaded lines.
//   2. Grounded questions: every answer is retrieved from the patient's own
//      uploads first (TF-IDF over chunks), then from the demo formulary/KB, and
//      the model is required to cite the chunk ids it used.
//   3. Plain-language report: the upload becomes a readable summary — what each
//      medicine is for, how to take it, what the doctor wrote, what to ask.
//   4. Delivery: the report goes to the patient's email (nodemailer).
//   5. Follow-ups: a refill reminder when the course runs low and a visit
//      reminder for the follow-up date.
//
// Everything is patient-facing language, not pharmacist shorthand, and every
// generated line keeps the guardrail: this is not a clinical reference and the
// doctor or pharmacist decides.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const DOCS_FILE = path.join(DOCS_DIR, 'index.json');

const MAX_DOC_CHARS = 60_000;
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 120;
const TOP_K = 5;

function ensureDirs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

function readIndex() {
  try {
    const arr = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  ensureDirs();
  fs.writeFileSync(DOCS_FILE, JSON.stringify(list.slice(0, 60), null, 2));
}

// ---------------- chunking ---------------------------------------------------
function chunkText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = [];
  if (!clean) return chunks;
  // Prefer paragraph/sentence boundaries so a citation points at something a
  // human can find again on the page.
  const paragraphs = clean.split(/\n{2,}/).flatMap((p) => {
    if (p.length <= CHUNK_CHARS) return [p];
    const out = [];
    let buf = '';
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if ((buf + ' ' + sentence).trim().length > CHUNK_CHARS && buf) {
        out.push(buf.trim());
        buf = sentence;
      } else {
        buf = (buf ? buf + ' ' : '') + sentence;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  });
  for (const p of paragraphs) {
    if (chunks.length && p.length < 120) {
      chunks[chunks.length - 1] += ' ' + p;
      continue;
    }
    if (p.length <= CHUNK_CHARS + CHUNK_OVERLAP) {
      chunks.push(p.trim());
    } else {
      for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        chunks.push(p.slice(i, i + CHUNK_CHARS).trim());
      }
    }
  }
  return chunks.filter(Boolean);
}

// ---------------- TF-IDF retrieval ------------------------------------------
const STOP = new Set(
  ('a an and are as at be but by for from has have how i if in into is it its of on or that the this to was what when where which who will with you your do does did can could should would about after before again all also any because been being here more most no not only other some such than then these they those through very we us am'.split(
    ' '
  ))
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s./-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function scoreChunks(question, chunks) {
  const qTokens = tokenize(question);
  if (!qTokens.length) return [];
  const qSet = new Set(qTokens);
  const df = new Map();
  for (const c of chunks) {
    const seen = new Set(tokenize(c.text));
    for (const t of seen) if (qSet.has(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = chunks.length || 1;
  const scored = chunks.map((c) => {
    const tokens = tokenize(c.text);
    if (!tokens.length) return { ...c, score: 0 };
    let score = 0;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of qSet) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + n / (1 + (df.get(t) || 0)));
      score += (f / tokens.length) * idf * (t.length > 4 ? 1.25 : 1);
    }
    // A drug name or number in the question is a strong signal.
    if (/\d/.test(question) && /\d/.test(c.text)) score += 0.15;
    return { ...c, score };
  });
  return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
}

function retrieve(question, docIds = null, topK = TOP_K) {
  const docs = readIndex().filter((d) => !docIds || docIds.includes(d.id));
  const all = [];
  for (const doc of docs) {
    for (const c of doc.chunks) all.push({ ...c, docId: doc.id, docName: doc.name, docKind: doc.kind });
  }
  const hits = scoreChunks(question, all).slice(0, topK);
  if (hits.length) return hits;
  // The question can share no terms with the text ("when should I take this?"
  // vs "Tab Metoprolol 1-0-1 after food"). When the patient is asking about
  // their own document, the document itself is the context — serve its chunks
  // so the model reads the answer out of them instead of claiming nothing
  // matched. No keyword overlap is not the same as no answer.
  if (docIds && docIds.length && all.length) {
    return all.slice(0, topK).map((c) => ({ ...c, score: 0, fallback: true }));
  }
  return [];
}

// ---------------- document storage ------------------------------------------
// A structured extraction always yields retrievable text, even when the model's
// raw_text is empty (a bad photo, a pure-regex model, a truncated response).
// Without this the document would have zero chunks and every question about it
// would answer "the document does not say" — technically true, useless in
// practice.
function textFromExtraction({ rawText, medicines = [], notes, prescriber, date, followUpDate, followUpAdvice }) {
  const parts = [];
  const head = [];
  if (rawText && rawText.trim()) head.push(rawText.trim());
  if (prescriber) head.push(`Prescriber / clinic: ${prescriber}`);
  if (date) head.push(`Date on document: ${date}`);
  if (followUpDate) head.push(`Follow-up date on document: ${followUpDate}`);
  if (head.length) parts.push(head.join('\n'));
  if (Array.isArray(medicines) && medicines.length) {
    parts.push(
      'Medicines written on this document:\n' +
        medicines
          .map((m) =>
            `- ${m.drug}${m.strength ? ` ${m.strength}` : ''}${m.form ? ` (${m.form})` : ''}` +
            `${m.frequency ? ` — ${m.frequency}` : ''}${m.timing ? `, ${m.timing}` : ''}` +
            `${typeof m.duration_days === 'number' ? `, ${m.duration_days} days` : ''}` +
            `${typeof m.confidence === 'number' ? ` [read confidence ${(m.confidence * 100).toFixed(0)}%]` : ''}` +
            `${m.ambiguity ? ` (possible other reading: ${m.ambiguity})` : ''}`
          )
          .join('\n')
    );
  }
  if (notes) parts.push(`Notes on the document: ${notes}`);
  if (followUpAdvice) parts.push(`Follow-up instruction written on the document: ${followUpAdvice}`);
  return parts.join('\n\n').slice(0, MAX_DOC_CHARS);
}

function saveDoc({ name, kind, mime, text, drugs = [], imageBase64 = null, meta = {}, extraction = null }) {
  ensureDirs();
  const id = `doc-${crypto.createHash('sha1').update(`${name}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 8)}`;
  // Prefer the transcription + structured fields combined: the raw line is
  // what the paper says, the structured block adds the words a question is
  // actually likely to use ("tablet", "after food", "30 days").
  const fromExtraction = extraction ? textFromExtraction(extraction) : '';
  const clean = (fromExtraction.trim() || String(text || '').trim()).slice(0, MAX_DOC_CHARS);
  const chunks = chunkText(clean).map((t, i) => ({ id: `${id}#${i + 1}`, text: t }));
  const doc = {
    id,
    name: String(name || 'upload').slice(0, 120),
    kind: kind || 'document',
    mime: mime || null,
    chars: clean.length,
    chunks,
    drugs: Array.isArray(drugs) ? drugs.slice(0, 30) : [],
    imageBase64: imageBase64 ? String(imageBase64).slice(0, 400_000) : null,
    meta: { ...meta, uploaded_at: new Date().toISOString() },
    text: clean // kept for the reader view and re-chunking
  };
  const list = readIndex();
  list.unshift(doc);
  writeIndex(list);
  if (doc.imageBase64) {
    fs.writeFileSync(path.join(DOCS_DIR, `${id}.image`), Buffer.from(doc.imageBase64, 'base64'));
  }
  return doc;
}

function getDoc(id) {
  return readIndex().find((d) => d.id === id) || null;
}

function listDocs() {
  return readIndex().map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    mime: d.mime,
    chars: d.chars,
    chunks: d.chunks.length,
    drugs: d.drugs,
    uploaded_at: d.meta.uploaded_at
  }));
}

function deleteDoc(id) {
  const list = readIndex();
  const i = list.findIndex((d) => d.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  writeIndex(list);
  try {
    fs.unlinkSync(path.join(DOCS_DIR, `${id}.image`));
  } catch {
    /* no stored image */
  }
  return true;
}

module.exports = { saveDoc, getDoc, listDocs, deleteDoc, retrieve, chunkText, tokenize, textFromExtraction, TOP_K, MAX_DOC_CHARS };