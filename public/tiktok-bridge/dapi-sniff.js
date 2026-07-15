/**
 * R&D-1: TikFinity DAPI Schema Sniffer
 * รัน: node public/tiktok-bridge/dapi-sniff.js
 * ต้องเปิด TikFinity + OBS TikFinity widget ค้างไว้ก่อน
 */
const WebSocket = require('ws');

const WS_URL = 'ws://127.0.0.1:21213/?service=tipkub-sniff&version=1';
let msgCount = 0;

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('[sniff] Connected to TikFinity DAPI at', WS_URL);
  console.log('[sniff] Waiting for events... Send a gift on TikTok Live to capture schema.');
});

ws.on('message', (raw) => {
  msgCount++;
  try {
    const msg = JSON.parse(raw.toString());
    console.log(`\n[msg #${msgCount}]`, JSON.stringify(msg, null, 2));
    if (msg.event === 'gift' || msg.type === 'gift' || msg.type === 'GIFT') {
      console.log('\n=== GIFT EVENT DETECTED ===');
      console.log('Keys at top level:', Object.keys(msg));
      if (msg.data) console.log('Keys in .data:', Object.keys(msg.data));
    }
  } catch {
    console.log(`[msg #${msgCount}] raw:`, raw.toString().slice(0, 200));
  }
});

ws.on('close', (code) => console.log('[sniff] Disconnected, code:', code));
ws.on('error', (e) => console.error('[sniff] Error:', e.message, '— Is TikFinity running?'));

process.on('SIGINT', () => { ws.close(); process.exit(0); });
