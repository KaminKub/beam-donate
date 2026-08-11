// src/tts.js — TTS mode adapters (server-side only, keys never reach client)
// Voice lists = versioned config — update when a provider changes its lineup.
const https = require('https');

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
    { id: 'th-TH-Standard-A', label: 'Standard A (ผู้หญิง)', freeTier: 'ฟรี 4M อักษร/เดือน' },
    { id: 'th-TH-Neural2-C', label: 'Neural2 C (ผู้หญิง)', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Kore', label: 'Chirp3 HD Kore', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Zephyr', label: 'Chirp3 HD Zephyr', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Puck', label: 'Chirp3 HD Puck', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Charon', label: 'Chirp3 HD Charon', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Fenrir', label: 'Chirp3 HD Fenrir', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Leda', label: 'Chirp3 HD Leda', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Orus', label: 'Chirp3 HD Orus', freeTier: 'ฟรี 1M อักษร/เดือน' },
    { id: 'th-TH-Chirp3-HD-Aoede', label: 'Chirp3 HD Aoede', freeTier: 'ฟรี 1M อักษร/เดือน' }
  ]},
  vertex: { label: 'Vertex (Gemini)', needsKey: true, voices: [
    { id: 'Kore', label: 'Kore (มั่นคง)' }, { id: 'Aoede', label: 'Aoede (ร่าเริง)' },
    { id: 'Leda', label: 'Leda (สดใส)' }, { id: 'Zephyr', label: 'Zephyr (แจ่มใส)' },
    { id: 'Puck', label: 'Puck (คึกคัก)' }, { id: 'Charon', label: 'Charon (ให้ข้อมูล)' },
    { id: 'Fenrir', label: 'Fenrir (ตื่นเต้นง่าย)' }, { id: 'Orus', label: 'Orus (มั่นคง)' }
  ]}
};

const FREE_TIERS = {
  free: 'Google Translate ฟรีไม่จำกัด · Microsoft ขึ้นอยู่กับเบราว์เซอร์ผู้ชม (ไม่รับประกันว่าจะมีเสียงเสมอ)',
  'google-cloud': 'Standard 4M / Neural2 1M / Chirp3 1M ตัวอักษร/เดือน (เกินแล้ว: $4 / $16 / $30 ต่อ 1M ตัวอักษร)',
  vertex: '<span class="status-dot error"></span> ระวัง: ไม่มีโควต้าฟรี — คิดเงินทุกครั้ง (Pay-As-You-Go) ~$10/1M output tokens (แพงกว่า TTS ปกติ) โปรดใช้อย่างระมัดระวัง'
};

const DAILY_CHAR_CAP = 100000;   // per streamer per day, all paid modes
const DAILY_REQUEST_CAP = 10;    // per streamer per day, vertex only (R14)
const MAX_TEXT_LEN = 500;        // server-side cap regardless of client-sent length
const OUTBOUND_TIMEOUT_MS = 10000;

// per-streamer usage (in-memory, resets on UTC-date rollover — single VPS process)
const usage = new Map(); // streamerId -> { date: 'YYYY-MM-DD', chars: n, requests: n }
function _usage(streamerId) {
  const today = new Date().toISOString().slice(0, 10);
  const u = usage.get(streamerId);
  if (!u || u.date !== today) {
    const fresh = { date: today, chars: 0, requests: 0 };
    usage.set(streamerId, fresh);
    return fresh;
  }
  return u;
}
function getDailyChars(streamerId) { return _usage(streamerId).chars; }
function addDailyChars(streamerId, n) { _usage(streamerId).chars += n; }

// R14 quota-guard consume helper — synchronous check+reserve (no await between check and mutate,
// so two concurrent requests can't both pass the check before either reserves). Only call when the
// streamer's tts_quota_guard_enabled is on; mode must already be a paid mode (caller gates on that).
// Vertex checks both chars and requests before mutating either, to avoid a partial reservation
// (chars incremented but then rejected on requests).
function tryConsumeFreeQuota(streamerId, mode, charCount) {
  const u = _usage(streamerId);
  if (u.chars + charCount > DAILY_CHAR_CAP) return { allowed: false, reason: 'chars' };
  if (mode === 'vertex' && u.requests >= DAILY_REQUEST_CAP) return { allowed: false, reason: 'requests' };
  u.chars += charCount;
  if (mode === 'vertex') u.requests += 1;
  return { allowed: true };
}

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

// Vertex mode — Vertex AI in Express Mode (aiplatform.googleapis.com), plain API key auth
// (?key=, no service account/OAuth). Curl-verified 2026-08-11 against the user's real Express
// Mode key: bare URL (no project/location) always 404s when the key is valid — Google auto-routes
// the key to its project + default region, then can't find the model there (it only lives in
// `global`) — but the 404 message leaks "projects/{number}/locations/{region}/..." so the project
// id can be parsed out of it (deterministic across calls). A truly invalid key 401s instead
// (UNAUTHENTICATED), so the two cases are unambiguous. Once the project id is known, calling the
// same model with an explicit projects/{id}/locations/global/... path returns 200 with real audio —
// same request/response shape as the old service-account path (I5): generationConfig.speechConfig.
// voiceConfig.prebuiltVoiceConfig.voiceName + responseModalities:['AUDIO'] →
// candidates[0].content.parts[0].inlineData = { mimeType: 'audio/L16;codec=pcm;rate=24000', data }.
// Voice ids are bare names (Kore, Aoede, ...) — no th-TH- prefix (that was the old Cloud TTS path).
const VERTEX_MODEL = 'gemini-2.5-flash-preview-tts';
const vertexProjectCache = new Map(); // apiKey -> projectId (no TTL — a project stays bound to its key)

async function resolveVertexProjectId(apiKey) {
  if (vertexProjectCache.has(apiKey)) return vertexProjectCache.get(apiKey);
  const probeUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${VERTEX_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(probeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: '.' }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }
    }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
  });
  if (res.status === 401) throw new Error('GEMINI_KEY_INVALID');
  const data = await res.json().catch(() => null);
  const match = /projects\/(\d+)\//.exec(data?.error?.message || '');
  if (!match) throw new Error('GEMINI_KEY_INVALID'); // unexpected shape — fail safe, don't guess
  vertexProjectCache.set(apiKey, match[1]);
  return match[1];
}

async function vertexGemini(text, voice, apiKey) {
  if (!apiKey) throw new Error('GEMINI_KEY_INVALID');
  const projectId = await resolveVertexProjectId(apiKey);
  const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${VERTEX_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
  });
  if (res.status === 401) throw new Error('GEMINI_KEY_INVALID');
  if (res.status === 403) {
    // Never curl-verified against a key with Vertex AI API disabled (no such key on hand) — parse
    // defensively to answer the original R6 ask, fall back to a generic invalid-key error otherwise.
    const body = await res.json().catch(() => null);
    const msg = body?.error?.message || '';
    if (/has not been used|is disabled|not enabled/i.test(msg)) throw new Error('GEMINI_API_NOT_ENABLED');
    throw new Error('GEMINI_KEY_INVALID');
  }
  if (res.status === 429) throw new Error('GEMINI_QUOTA_EXCEEDED');
  // codex rescue round 2 (2026-08-11): a live donation alert can't afford 3 attempts × 10s each
  // (up to ~51.5s worst case with the uncached-project probe) — a transient 500 now falls straight
  // through to the free-voice fallback instead of retrying, keeping the whole request bounded well
  // under the client's 30s abort deadline (overlay.js prepareSpeech()).
  if (!res.ok) throw new Error(`GEMINI_HTTP_${res.status}`);
  const data = await res.json();
  const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) throw new Error('GEMINI_NO_AUDIO');
  const rateMatch = /rate=(\d+)/.exec(inlineData.mimeType || '');
  return { contentType: 'audio/wav', audio: pcmToWav(inlineData.data, rateMatch ? Number(rateMatch[1]) : 24000) };
}

async function synthesizeTTS({ mode, voice, text, lang, keys }) {
  switch (mode) {
    case 'google-cloud': return googleCloud(text, voice, keys.google);
    case 'vertex': return vertexGemini(text, voice, keys.gemini);
    case 'free':
    default:
      // free mode: voice ว่าง = Google Translate; voice = Microsoft → Edge TTS
      if (voice && voice.startsWith('th-TH-')) return edgeTts(text, voice);
      return googleFree(text, (lang || 'th').split('-')[0] || 'th');
  }
}

module.exports = {
  MODES, FREE_TIERS, DAILY_CHAR_CAP, DAILY_REQUEST_CAP, MAX_TEXT_LEN, OUTBOUND_TIMEOUT_MS,
  synthesizeTTS, getDailyChars, addDailyChars, tryConsumeFreeQuota,
  escapeXml, pcmToWav, resolveVertexProjectId
};
