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
let reconnectTimer = null;
let failStreak = 0;            // นับความล้มเหลวติดกัน — ใช้ยุบ log ไม่ให้ท่วม
let stalledHandshake = false;  // รอบนี้ตายเพราะ handshake ค้าง ไม่ใช่ connection refused
let giftCount = 0;
let totalCoins = 0;
let csrfToken = null;

const HANDSHAKE_TIMEOUT_MS = 8000;
const RECONNECT_CAP_MS = 10000;

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
// repeatEnd มีความหมายเฉพาะของขวัญ streakable (giftType === 1) เท่านั้น
// ของขวัญแพง (99/100+ coins) เป็น non-streakable → ส่ง event เดียว repeatEnd = false/0
// และไม่มี event ปิดท้ายตามมา ถ้า drop ตาม repeatEnd อย่างเดียว = coins หายถาวร
// giftType ไม่ถูกส่งมา → เดาว่า streakable (พฤติกรรมเดิม) กัน double-count ระหว่าง combo
function isComboPending(g) {
  if (g.repeatEnd) return false;
  return g.giftType === undefined || g.giftType === 1;
}

function extractCoins(msg) {
  // Defensive multi-format parser — field names unknown until live R&D-1 runs
  // Format A: { event:'gift', data:{ diamondCount, repeatCount, repeatEnd, giftType } }
  // Format B: { type:'gift', diamondCount, repeatCount, repeatEnd, giftType }
  // Format C: { event:'GIFT', gift:{ ... } }
  const isGiftEvent =
    msg.event === 'gift' || msg.event === 'GIFT' ||
    msg.type === 'gift' || msg.type === 'GIFT';
  if (!isGiftEvent) return null;

  // Format A
  if (msg.data && typeof msg.data.diamondCount === 'number') {
    if (isComboPending(msg.data)) return null;
    return msg.data.diamondCount * (msg.data.repeatCount || 1);
  }
  // Format B
  if (typeof msg.diamondCount === 'number') {
    if (isComboPending(msg)) return null;
    return msg.diamondCount * (msg.repeatCount || 1);
  }
  // Format C
  if (msg.gift && typeof msg.gift.diamondCount === 'number') {
    if (isComboPending(msg.gift)) return null;
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
  clearTimeout(reconnectTimer);
  setDot('dotDapi', 'amber');
  setText('lblDapi', 'กำลังเชื่อมต่อ TikFinity…');

  ws = new WebSocket(DAPI_URL);
  const sock = ws;

  // WebSocket ไม่มี timeout ในตัว — ถ้าปลายทางถูก throttle (เช่น TikFinity
  // ถูกย่อหน้าต่าง) TCP ติดแต่ handshake ไม่จบ → ค้าง CONNECTING ถาวร
  // ไม่มี event ใดยิงเลย ต้องปิดเองเพื่อให้ close handler พา reconnect ต่อ
  const handshakeTimer = setTimeout(() => {
    if (sock.readyState === WebSocket.CONNECTING) {
      stalledHandshake = true;   // ให้ close handler เป็นคน log ที่เดียว
      try { sock.close(); } catch { /* ปิดไม่ได้ = ปิดไปแล้ว */ }
    }
  }, HANDSHAKE_TIMEOUT_MS);

  sock.addEventListener('open', () => {
    clearTimeout(handshakeTimer);
    setDot('dotDapi', 'green');
    setText('lblDapi', 'เชื่อมต่อ TikFinity แล้ว');
    addLog('DAPI connected', 'ok');
    reconnectDelay = 2000;
    failStreak = 0;
    stalledHandshake = false;
  });

  sock.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const coins = extractCoins(msg);
    if (coins !== null && coins > 0) relayGift(coins);
  });

  sock.addEventListener('close', (ev) => {
    clearTimeout(handshakeTimer);
    if (sock !== ws) return;     // socket เก่าปิดช้า — อย่านัด reconnect ซ้อน
    setDot('dotDapi', 'red');
    // label = สถานะสด อัปเดตทุกครั้งเสมอ
    setText('lblDapi', `ขาดการเชื่อมต่อ (${ev.code}) — reconnect ใน ${reconnectDelay / 1000}s`);

    // log = ประวัติ ยุบไม่ให้ท่วม (log เก็บแค่ 50 บรรทัด): ครั้งแรก + ทุกครั้งที่ 6
    failStreak++;
    if (failStreak === 1 || failStreak % 6 === 0) {
      const why = stalledHandshake
        ? 'handshake ค้าง (TikFinity ถูกย่อหน้าต่างอยู่หรือเปล่า?)'
        : `code ${ev.code}`;
      addLog(failStreak === 1
        ? `DAPI หลุด — ${why}`
        : `ยังเชื่อมต่อไม่ได้ — ${why} (ลองแล้ว ${failStreak} ครั้ง)`, 'warn');
    }
    stalledHandshake = false;

    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP_MS);
  });

  sock.addEventListener('error', () => {
    // error fires before close — log once in close handler
    setText('lblDapi', 'เชื่อมต่อไม่ได้ — TikFinity เปิดอยู่หรือไม่?');
  });
}

// Chrome throttle timer ในแท็บพื้นหลัง (และ freeze แท็บทิ้งหลัง ~5 นาที)
// พอผู้ใช้กลับมาดูหน้านี้ ให้ล้าง backoff แล้วต่อทันที ไม่ต้องรอคิวเก่า
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  reconnectDelay = 2000;
  connect();
});

// ── Heartbeat → dashboard badge ──────────────────────────────────
// ping ทุก 10s บอก server ว่า bridge เปิดอยู่ + DAPI เชื่อมหรือยัง (in-memory, ไม่เก็บ)
async function sendHeartbeat() {
  const dapi = (ws && ws.readyState === WebSocket.OPEN) ? 1 : 0;
  if (!csrfToken) await fetchCsrf();
  try {
    // dapi ผ่าน query, ไม่มี body → เลี่ยง "stream is not readable" ตอน fetch โดน abort ระหว่าง reload
    const r = await fetch('/api/tiktok/heartbeat?dapi=' + dapi, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken || '' },
    });
    if (r.status === 403) csrfToken = null; // refresh รอบหน้า
  } catch { /* heartbeat หายรอบเดียวไม่เป็นไร */ }
}

// ── Init ─────────────────────────────────────────────────────────
const FIRST_RUN_KEY = 'tipkub_bridge_firstrun_ack';

function startBridge() {
  fetchCsrf().then(connect);
  updateCounter();
  sendHeartbeat();
  setInterval(sendHeartbeat, 10000);
}

if (localStorage.getItem(FIRST_RUN_KEY) === '1') {
  startBridge();
} else {
  const overlay = document.getElementById('firstRunOverlay');
  const okBtn = document.getElementById('btnFirstRunOk');
  if (overlay) overlay.classList.add('show');
  if (okBtn) okBtn.addEventListener('click', () => {
    localStorage.setItem(FIRST_RUN_KEY, '1');
    if (overlay) overlay.classList.remove('show');
    startBridge();
  }, { once: true });
}
