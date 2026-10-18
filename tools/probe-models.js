// One-off probe: which extraction/explanation models does this key actually have?
const fs = require('fs');
const path = require('path');
const env = {};
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
const key = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!key) { console.log('NO KEY'); process.exit(0); }
fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`)
  .then((r) => r.json())
  .then((d) => {
    const names = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    console.log('total models:', names.length);
    console.log('FLASH-LITE :', names.filter((n) => /flash.?lite/i.test(n)).join(', ') || 'NONE');
    console.log('FLASH      :', names.filter((n) => /flash/i.test(n) && !/lite/i.test(n)).slice(0, 10).join(', ') || 'NONE');
    console.log('GEMMA      :', names.filter((n) => /gemma/i.test(n)).join(', ') || 'NONE');
    console.log('ALL        :', names.join(' | '));
  })
  .catch((e) => console.log('ERR', e.message));