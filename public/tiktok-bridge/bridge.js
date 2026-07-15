/**
 * TipKub × TikFinity Bridge — bridge.js
 * เชื่อม TikFinity DAPI (ws://127.0.0.1:21213) → POST /api/tiktok/gift
 * C1: in-memory only, C2: no PII log, C4: "โดยประมาณ" label อยู่ใน index.html
 * C5: ไม่ log TikFinity evidence, C6: relay disclaimer อยู่ใน index.html
 */

const DAPI_URL = 'ws://127.0.0.1:21213/?service=tipkub&version=1';
const GIFT_ENDPOINT = '/api/tiktok/gift';

let ws = null;
let reconnectDelay = 2000;
let giftCount = 0;
let totalCoins = 0;
let csrfToken = null;

// ── UI helpers ──────────────────────────────────────────────────
function setDot(id, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'dot ' + cls;
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function addLog(text, cls = '') {
  const log = document.getElementById('log');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = 'entry ' + cls;
  entry.textContent = '[' + new Date().toLocaleTimeString('th') + '] ' + text;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  // C2: cap log at 50 entries
  while (log.children.length > 50) log.removeChild(log.firstChild);
}
function updateCounter() {
  setText('counter', `ส่ง gift: ${giftCount} ครั้ง | coins รวม: ${totalCoins}`);
}

// ── CSRF token ──────────────────────────────────────────────────
async function fetchCsrf() {
  try {
    const r = await fetch('/api/csrf-token', { credentials: 'include' });
    if (!r.ok) throw new Error('csrf ' + r.status);
    const d = await r.json();
    csrfToken = d.csrfToken || d.token;
  } catch (e) {
    addLog('CSRF fetch ล้มเหลว: ' + e.message, 'err');
  }
}

// ── Gift relay ──────────────────────────────────────────────────
function extractCoins(msg) {
  // Defensive multi-format parser — field names unknown until live R&D-1 runs
  // Format A: { event:'gift', data:{ diamondCount, repeatCount, repeatEnd } }
  // Format B: { type:'gift', diamondCount, repeatCount, repeatEnd }
  // Format C: { event:'GIFT', gift:{ ... } }
  const isGiftEvent =
    msg.event === 'gift' || msg.event === 'GIFT' ||
    msg.type === 'gift' || msg.type === 'GIFT';
  if (!isGiftEvent) return null;

  // Format A
  if (msg.data && typeof msg.data.diamondCount === 'number') {
    const { diamondCount, repeatCount, repeatEnd } = msg.data;
    if (repeatEnd === false) return null; // กำลัง combo อยู่ รอ repeatEnd
    return diamondCount * (repeatCount || 1);
  }
  // Format B
  if (typeof msg.diamondCount === 'number') {
    if (msg.repeatEnd === false) return null;
    return msg.diamondCount * (msg.repeatCount || 1);
  }
  // Format C
  if (msg.gift && typeof msg.gift.diamondCount === 'number') {
    if (msg.gift.repeatEnd === false) return null;
    return msg.gift.diamondCount * (msg.gift.repeatCount || 1);
  }
  return null;
}

async function relayGift(coins) {
  if (!csrfToken) await fetchCsrf();
  try {
    const r = await fetch(GIFT_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken || '',
      },
      body: JSON.stringify({ coins }),
    });
    const d = await r.json();
    if (!r.ok || !d.success) {
      if (r.status === 403) {
        csrfToken = null; // refresh next call
        addLog('CSRF หมดอายุ — จะ refresh อัตโนมัติ', 'warn');
      } else {
        addLog('relay ล้มเหลว: ' + (d.error || r.status), 'err');
      }
      return;
    }
    giftCount++;
    totalCoins += coins;
    updateCounter();
    addLog(`gift ${coins} coins → timer ✓`, 'ok');
    setText('lblServer', `ส่งล่าสุด: ${coins} coins`);
    setDot('dotServer', 'green');
  } catch (e) {
    addLog('relay error: ' + e.message, 'err');
  }
}

// ── WebSocket connection ─────────────────────────────────────────
function connect() {
  setDot('dotDapi', 'amber');
  setText('lblDapi', 'กำลังเชื่อมต่อ TikFinity…');

  ws = new WebSocket(DAPI_URL);

  ws.addEventListener('open', () => {
    setDot('dotDapi', 'green');
    setText('lblDapi', 'เชื่อมต่อ TikFinity แล้ว');
    addLog('DAPI connected', 'ok');
    reconnectDelay = 2000;
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const coins = extractCoins(msg);
    if (coins !== null && coins > 0) relayGift(coins);
  });

  ws.addEventListener('close', (ev) => {
    setDot('dotDapi', 'red');
    setText('lblDapi', `ขาดการเชื่อมต่อ (${ev.code}) — reconnect ใน ${reconnectDelay / 1000}s`);
    addLog(`DAPI closed code ${ev.code}`, 'warn');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.addEventListener('error', () => {
    // error fires before close — log once in close handler
    setText('lblDapi', 'เชื่อมต่อไม่ได้ — TikFinity เปิดอยู่หรือไม่?');
  });
}

// ── Init ─────────────────────────────────────────────────────────
fetchCsrf().then(connect);
updateCounter();
