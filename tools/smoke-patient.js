// End-to-end smoke test of the patient pipeline against a running server.
// Upload a real prescription image -> extracted by flash-lite -> explained by
// gemma -> report built -> report emailed -> reminders queued -> discussion
// grounded in the uploaded document.
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3311';
const IMG = process.env.IMG || path.join(__dirname, '..', 'public', 'samples', 'rx2.png');

function toBase64(file) {
  return fs.readFileSync(file).toString('base64');
}

const j = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  const t = await r.text();
  let b;
  try { b = JSON.parse(t); } catch { b = { raw: t.slice(0, 200) }; }
  return { status: r.status, body: b };
};

(async () => {
  console.log('--- config ---');
  const cfg = await j('/api/patient/config');
  console.log(cfg.status, JSON.stringify(cfg.body).slice(0, 260));

  console.log('\n--- upload (extract with flash-lite, explain with gemma) ---');
  const up = await j('/api/patient/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileBase64: toBase64(IMG), fileMime: 'image/png', fileName: 'rx2.png', have: ['Amlodipine 5 mg'] })
  });
  console.log(up.status, 'read_by=', up.body.model_split && up.body.model_split.read_by, 'explained_by=', up.body.model_split && up.body.model_split.explained_by);
  console.log('medicines:', JSON.stringify((up.body.extraction || {}).medicines || []).slice(0, 300));
  console.log('summary  :', String((up.body.explanation || {}).plain_summary || '').slice(0, 220));
  console.log('to buy   :', JSON.stringify((up.body.explanation || {}).need_to_buy || []));

  const docId = up.body.doc && up.body.doc.id;
  console.log('\n--- report ---');
  const rep = await j('/api/patient/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId, have: ['Amlodipine 5 mg'] })
  });
  console.log(rep.status, 'reportId=', rep.body.report && rep.body.report.id, '| medicines=', rep.body.report && rep.body.report.medicine_count, '| questions=', rep.body.report && (rep.body.report.questions_for_doctor || []).length);
  console.log('text preview:', String(rep.body.text || '').split('\n').slice(0, 8).join(' | '));

  console.log('\n--- email report ---');
  const mail = await j('/api/patient/report/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportId: rep.body.report.id, to: 'patient@example.com' })
  });
  console.log(mail.status, 'transport=', mail.body.transport, '| messageId=', mail.body.messageId);
  console.log('note:', String(mail.body.note || mail.body.error || '').slice(0, 160));

  console.log('\n--- discuss (grounded RAG) ---');
  const dis = await j('/api/patient/discuss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId, question: 'What did the doctor write and when should I take this medicine?' })
  });
  console.log(dis.status, 'grounded=', dis.body.grounded, '| sources=', (dis.body.sources || []).length);
  console.log('answer:', String(dis.body.answer || '').slice(0, 260).replace(/\s+/g, ' '));

  console.log('\n--- reminders ---');
  const rem = await j('/api/patient/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId, email: 'patient@example.com', visitAt: new Date(Date.now() + 7 * 864e5).toISOString(), refillInDays: 3 })
  });
  console.log(rem.status, JSON.stringify((rem.body.created || []).map((r) => r.kind + '@' + r.at)).slice(0, 200));
  console.log('describe:', (rem.body.created || [])[0] ? rem.body.created[0].describe.slice(0, 140) : 'none');
})().catch((e) => console.log('FATAL', e.message));