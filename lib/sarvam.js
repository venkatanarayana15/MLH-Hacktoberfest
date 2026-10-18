// MediPilot voice — Sarvam AI (an MLH event sponsor) REST client.
// STT:  POST https://api.sarvam.ai/speech-to-text      (multipart, saaras)
// TTS:  POST https://api.sarvam.ai/text-to-speech      (JSON, bulbul)
// Auth: api-subscription-key header.
//
// Without SARVAM_API_KEY the copilot stays fully functional in TEXT mode
// (typing) and the UI says so — voice is an enhancement, never a blocker.

const STT_URL = 'https://api.sarvam.ai/speech-to-text';
const TTS_URL = 'https://api.sarvam.ai/text-to-speech';

const key = process.env.SARVAM_API_KEY || null;

const LANGS = [
  { code: 'en-IN', label: 'English', native: 'English' },
  { code: 'hi-IN', label: 'Hindi', native: 'हिन्दी' },
  { code: 'ta-IN', label: 'Tamil', native: 'தமிழ்' },
  { code: 'kn-IN', label: 'Kannada', native: 'ಕನ್ನಡ' }
];

const isLive = () => Boolean(key);

// STT: browser-recorded audio blob (webm/wav/mp3…) → {transcript, language_code}
async function stt(audioBase64, mime, languageCode) {
  if (!key) throw new Error('SARVAM_NOT_CONFIGURED');
  const bytes = Buffer.from(audioBase64.replace(/^data:.*;base64,/, ''), 'base64');
  const form = new FormData();
  const ext = (mime.split('/')[1] || 'webm').split(';')[0];
  form.append('file', new Blob([bytes], { type: mime }), `context.${ext}`);
  form.append('model', 'saaras:v4');
  if (languageCode && languageCode !== 'unknown') form.append('language_code', languageCode);
  const res = await fetch(STT_URL, { method: 'POST', headers: { 'api-subscription-key': key }, body: form });
  if (!res.ok) throw new Error(`SARVAM_STT_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { transcript: String(data.transcript || '').trim(), detected: data.language_code || null };
}

// TTS: answer text → base64 WAV (bulbul, shubh voice by default)
async function tts(text, languageCode) {
  if (!key) throw new Error('SARVAM_NOT_CONFIGURED');
  const body = {
    text: String(text).slice(0, 2400),
    language_code: languageCode || 'en-IN',
    speaker: 'shubh'
  };
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`SARVAM_TTS_${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const audio = (data.audios && data.audios[0]) || null;
  if (!audio) throw new Error('SARVAM_TTS_EMPTY');
  return audio; // base64 WAV
}

module.exports = { LANGS, isLive, stt, tts };
