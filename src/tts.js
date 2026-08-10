// src/tts.js — TTS mode adapters (server-side only, keys never reach client)
// Voice lists = versioned config — update when a provider changes its lineup.
const https = require('https');
const crypto = require('crypto');

const MODES = {
  // Microsoft voices (เปรมวดี/นิวัฒน์ via speech.platform.bing.com) kept in the catalog on purpose —
  // live-verified the endpoint currently returns 403 (bot-detection tightened beyond the static
  // TrustedClientToken this adapter uses), so the voice picker is hidden in free mode for now
  // (public/dashboard/dashboard.js applyTtsMode()) rather than removing the option outright.
  // edgeTts() below is fully hardened (SSRF/SSML/timeout/size-cap/binaryType) — re-enable by unhiding
  // the picker once a workaround (Sec-MS-GEC token, or the official Azure Speech SDK free tier) lands.
  // See SECURITY_AUDIT_2026-08-10.md § codex R2 gate.
  free: { label: 'เสียงฟรี', needsKey: false, voices: [
    { id: '', label: 'Google Translate (เสียงระบบ)' },
    { id: 'th-TH-PremwadeeNeural', label: 'เปรมวดี (Microsoft)' },
    { id: 'th-TH-NiwatNeural', label: 'นิวัฒน์ (Microsoft)' }
  ]},
  'google-cloud': { label: 'Google Cloud', needsKey: true, voices: [
    { id: 'th-TH-Standard-A', label: 'Standard A (ผู้หญิง)', freeTier: 'ฟรี 4M ตัวอักษร/เดือน' },
    { id: 'th-TH-Neural2-C', label: 'Neural2 C (ผู้หญิง)', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Kore', label: 'Chirp3 HD Kore', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Zephyr', label: 'Chirp3 HD Zephyr', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Puck', label: 'Chirp3 HD Puck', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Charon', label: 'Chirp3 HD Charon', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Fenrir', label: 'Chirp3 HD Fenrir', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Leda', label: 'Chirp3 HD Leda', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Orus', label: 'Chirp3 HD Orus', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Aoede', label: 'Chirp3 HD Aoede', freeTier: 'ฟรี 1M ตัวอักษร/เดือน' }
  ]},
  vertex: { label: 'Vertex (Gemini)', needsKey: true, voices: [
    { id: 'Kore', label: 'โคเร (มั่นคง)' }, { id: 'Aoede', label: 'อาเอเด (ร่าเริง)' },
    { id: 'Leda', label: 'เลดา (สดใส)' }, { id: 'Zephyr', label: 'เซเฟอร์ (แจ่มใส)' },
    { id: 'Puck', label: 'พัค (คึกคัก)' }, { id: 'Charon', label: 'คารอน (ให้ข้อมูล)' },
    { id: 'Fenrir', label: 'เฟนเรียร์ (ตื่นเต้นง่าย)' }, { id: 'Orus', label: 'โอรัส (มั่นคง)' }
  ]}
};

const FREE_TIERS = {
  free: 'Google Translate ฟรีไม่จำกัด · Microsoft ขึ้นอยู่กับเบราว์เซอร์ผู้ชม (ไม่รับประกันว่าจะมีเสียงเสมอ)',
  'google-cloud': 'Standard 4M / Neural2 1M / Chirp3 1M ตัวอักษร/เดือน',
  vertex: 'จำกัดมาก: 3 RPM / 15 RPD (flash-preview-tts) — ไม่เหมาะ alert จริง'
};

const DAILY_CHAR_CAP = 100000;   // per streamer per day, all paid modes
const MAX_TEXT_LEN = 500;        // server-side cap regardless of client-sent length
const OUTBOUND_TIMEOUT_MS = 10000;

// per-streamer usage (in-memory, resets on UTC-date rollover — single VPS process)
const usage = new Map(); // streamerId -> { date: 'YYYY-MM-DD', chars: n }
function _usage(streamerId) {
  const today = new Date().toISOString().slice(0, 10);
  const u = usage.get(streamerId);
  if (!u || u.date !== today) {
    const fresh = { date: today, chars: 0 };
    usage.set(streamerId, fresh);
    return fresh;
  }
  return u;
}
function getDailyChars(streamerId) { return _usage(streamerId).chars; }
function addDailyChars(streamerId, n) { _usage(streamerId).chars += n; }

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function pcmToWav(pcmBase64, sampleRate = 24000) {
  const pcm = Buffer.from(pcmBase64, 'base64');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Google Translate TTS proxy — same request shape as the legacy /api/tts handler
// it replaces (server.js:4019-4038), just buffered instead of piped.
function googleFree(text, lang) {
  return new Promise((resolve, reject) => {
    const encodedText = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodedText}`;
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36' } };
    const req = https.get(url, options, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GOOGLE_FREE_HTTP_${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ contentType: 'audio/mpeg', audio: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(OUTBOUND_TIMEOUT_MS, () => req.destroy(new Error('GOOGLE_FREE_TIMEOUT')));
  });
}

// Edge TTS (ฟรี Microsoft เปรมวดี/นิวัฒน์) — unofficial WebSocket service (speech.platform.bing.com).
// Max buffered audio capped at 5MB to bound memory; every reject path closes the socket + clears the timer.
const EDGE_MAX_BYTES = 5 * 1024 * 1024;
async function edgeTts(text, voice) {
  const { randomUUID } = require('crypto');
  const connId = randomUUID().replace(/-/g, '');
  const ws = new WebSocket(
    `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connId}`
  );
  // Node's global WebSocket defaults binaryType to 'blob' (WHATWG default) — the message handler below
  // expects ArrayBuffer, so without this every binary frame is silently dropped and audio comes back empty
  // (codex R2 review)
  ws.binaryType = 'arraybuffer';
  const chunks = [];
  let totalBytes = 0;
  const audio = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('EDGE_TIMEOUT')), OUTBOUND_TIMEOUT_MS);
    ws.onopen = () => {
      const ts = new Date().toISOString();
      ws.send(`Path: speech.config\r\nX-RequestId: ${connId}\r\nX-Timestamp: ${ts}\r\nContent-Type: application/json\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      ws.send(`Path: ssml\r\nX-RequestId: ${connId}\r\nX-Timestamp: ${ts}\r\nContent-Type: application/ssml+xml\r\n\r\n` +
        `<speak version='1.0' xml:lang='th-TH'><voice name='${escapeXml(voice)}'>${escapeXml(text)}</voice></speak>`);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('turn.end')) finish(null, Buffer.concat(chunks));
      } else if (ev.data instanceof ArrayBuffer) {
        const buf = Buffer.from(ev.data);
        const idx = buf.indexOf(Buffer.from('\r\n\r\n'));
        if (idx !== -1) {
          totalBytes += buf.length - (idx + 4);
          if (totalBytes > EDGE_MAX_BYTES) return finish(new Error('EDGE_TOO_LARGE'));
          chunks.push(buf.subarray(idx + 4));
        }
      }
    };
    ws.onerror = () => finish(new Error('EDGE_CONN_FAILED'));
    ws.onclose = () => finish(new Error('EDGE_CONN_CLOSED'));
  });
  if (!audio.length) throw new Error('EDGE_NO_AUDIO');
  return { contentType: 'audio/mpeg', audio };
}

async function googleCloud(text, voice, apiKey) {
  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: (voice || 'th-TH').split('-').slice(0, 2).join('-'), name: voice },
      audioConfig: { audioEncoding: 'MP3' }
    }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
  });
  if (res.status === 403) throw new Error('GOOGLE_KEY_INVALID');
  if (res.status === 429) throw new Error('GOOGLE_QUOTA_EXCEEDED');
  if (!res.ok) throw new Error(`GOOGLE_HTTP_${res.status}`);
  const data = await res.json();
  if (!data?.audioContent) throw new Error('GOOGLE_NO_AUDIO');
  return { contentType: 'audio/mpeg', audio: Buffer.from(data.audioContent, 'base64') };
}

// Vertex mode — real Vertex AI (aiplatform.googleapis.com), service-account/IAM auth (R5).
// I5 curl-verified 2026-08-10 against the user's real vertex-express service account:
// POST .../publishers/google/models/gemini-2.5-flash-preview-tts:generateContent, location=global,
// generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName + responseModalities:['AUDIO']
// → 200 with candidates[0].content.parts[0].inlineData = { mimeType: 'audio/L16;codec=pcm;rate=24000', data }.
// Voice ids are bare names (Kore, Aoede, ...) — no th-TH- prefix (that was the old Cloud TTS path).
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const vertexTokenCache = new Map(); // client_email -> { token, expiresAt }
async function getVertexAccessToken(sa) {
  const cached = vertexTokenCache.get(sa.client_email);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('GEMINI_KEY_INVALID'); // bad/revoked/malformed service account
  const data = await res.json();
  vertexTokenCache.set(sa.client_email, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

async function vertexGemini(text, voice, serviceAccount) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key || !serviceAccount?.project_id) {
    throw new Error('GEMINI_KEY_INVALID');
  }
  let accessToken;
  try {
    accessToken = await getVertexAccessToken(serviceAccount);
  } catch {
    throw new Error('GEMINI_KEY_INVALID');
  }

  const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/locations/global/publishers/google/models/gemini-2.5-flash-preview-tts:generateContent`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
    });
    if (res.status === 401 || res.status === 403) throw new Error('GEMINI_KEY_INVALID');
    if (res.status === 429) throw new Error('GEMINI_QUOTA_EXCEEDED');
    if (res.status === 500 && attempt < 2) { await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`GEMINI_HTTP_${res.status}`);
    const data = await res.json();
    const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) throw new Error('GEMINI_NO_AUDIO');
    const rateMatch = /rate=(\d+)/.exec(inlineData.mimeType || '');
    return { contentType: 'audio/wav', audio: pcmToWav(inlineData.data, rateMatch ? Number(rateMatch[1]) : 24000) };
  }
  throw new Error('GEMINI_HTTP_500');
}

async function synthesizeTTS({ mode, voice, text, lang, keys }) {
  switch (mode) {
    case 'google-cloud': return googleCloud(text, voice, keys.google);
    case 'vertex': return vertexGemini(text, voice, keys.geminiServiceAccount);
    case 'free':
    default:
      // free mode: voice ว่าง = Google Translate; voice = Microsoft → Edge TTS
      if (voice && voice.startsWith('th-TH-')) return edgeTts(text, voice);
      return googleFree(text, (lang || 'th').split('-')[0] || 'th');
  }
}

module.exports = {
  MODES, FREE_TIERS, DAILY_CHAR_CAP, MAX_TEXT_LEN, OUTBOUND_TIMEOUT_MS,
  synthesizeTTS, getDailyChars, addDailyChars,
  escapeXml, pcmToWav
};
