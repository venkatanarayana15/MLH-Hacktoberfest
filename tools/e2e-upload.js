/**
 * E2E upload reproduction: POST a real prescription image to /api/patient/upload
 * and print exactly what comes back — extraction, explanation, timings.
 *
 * Usage: node tools/e2e-upload.js [baseUrl] [imagePath]
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3000';
const IMG = process.argv[3] || path.join(__dirname, '..', 'public', 'samples', 'rx2.png');

(async () => {
  if (!fs.existsSync(IMG)) {
    console.error('image not found:', IMG);
    process.exit(1);
  }
  const fileBase64 = fs.readFileSync(IMG).toString('base64');
  console.log(`-> POST ${BASE}/api/patient/upload (${path.basename(IMG)}, ${(fileBase64.length / 1024).toFixed(0)} KB base64)`);

  const t0 = Date.now();
  let res, body;
  try {
    res = await fetch(`${BASE}/api/patient/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileBase64, fileMime: 'image/png', fileName: path.basename(IMG) })
    });
    body = await res.json();
  } catch (e) {
    console.error(`FAIL after ${Date.now() - t0}ms:`, e.message || e);
    process.exit(2);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`<- HTTP ${res.status} in ${secs}s`);

  if (!res.ok) {
    console.error('ERROR BODY:', JSON.stringify(body, null, 2).slice(0, 1500));
    process.exit(3);
  }

  const ex = body.extraction || {};
  const exp = body.explanation || null;
  console.log('doc        :', body.doc && body.doc.id, '·', body.doc && body.doc.name, '·', body.doc && body.doc.chunks, 'chunk(s)');
  console.log('extract    :', ex.model || '(none)', '· meds:', (ex.medicines || []).length,
    '· confidence:', (ex.medicines || []).map((m) => m.confidence).join(','));
  console.log('explanation:', exp ? `YES (${exp.model || 'model?'}) summary=${JSON.stringify(String(exp.plain_summary || '').slice(0, 90))}`
    : 'NULL — the plain-language step did not produce output');
  if (exp) {
    console.log('  - per_medicine :', (exp.per_medicine || []).length);
    console.log('  - questions    :', (exp.questions || []).length);
    console.log('  - next_visit   :', exp.next_visit ? 'yes' : 'no');
    console.log('  - already/buy  :', (exp.already_have || []).length, '/', (exp.need_to_buy || []).length);
    console.log('  - warnings     :', (exp.warning_lines || []).length);
  }

  const pass = !!(ex.model && (ex.medicines || []).length && exp && exp.plain_summary);
  console.log(pass ? 'PASS: read + explained end to end' : 'PARTIAL: upload answered but explanation missing');
  process.exit(pass ? 0 : 4);
})();
