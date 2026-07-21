// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  // Exit so PM2/process manager can restart in a clean state.
  // Continuing after an uncaught exception leaves the process in an undefined state.
  process.exit(1);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const beam = require('./beam');
const https = require('https');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const promptparse = require('promptparse');
const session = require('express-session');
const TursoStore = require('./sessionStore');
const passport = require('passport');
const _rateLimit = require('express-rate-limit');
// wrap once: fallback keyGenerator prevents ERR_ERL_UNDEFINED_IP_ADDRESS when
// req.ip is undefined (connection destroyed prematurely — mobile/CGNAT drops).
// Use express-rate-limit's built-in ipKeyGenerator so IPv6 addresses are
// normalized to /56 subnets and validation is satisfied.
const rateLimit = (opts) => _rateLimit({
  keyGenerator: (req) => _rateLimit.ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  ...opts,
});
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const TwitchStrategy = require('passport-twitch-new').Strategy;
const OAuth2Strategy = require('passport-oauth2').Strategy;
const { determinePrimaryAuth } = require('./auth-helpers');


const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ========== Cloudflare R2 (S3-compatible) ==========
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const UPLOAD_ALLOWED_TYPES = {
  avatar:  ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/webm'],
  profile: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/webm'],
  header:  ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/webm'],
  pagebg:  ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/webm'],
  sound:   ['audio/mpeg', 'audio/ogg', 'audio/mp3'],
  video:   ['video/mp4', 'video/webm'],
  tierAlert: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/webm']
};
const UPLOAD_EXT_MAP = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm'
};
const UPLOAD_FOLDER_MAP = {
  avatar: 'avatars', profile: 'profiles', header: 'headers', pagebg: 'pagebg',
  sound: 'sounds', video: 'videos', tierAlert: 'tier-alert'
};

async function uploadBufferToR2(buffer, key, contentType) {
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

// § 2.6 TIER_DONATE_BLUEPRINT.md — แปลง public R2 URL → key แล้วลบ (donor-temp audio cleanup)
async function deleteFromR2ByUrl(url) {
  const r2Base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (!r2Base || !url || !url.startsWith(r2Base + '/')) return;
  const key = url.slice(r2Base.length + 1).split('?')[0];
  await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
}

// § 2.7 TIER_DONATE_BLUEPRINT.md — wrap db cleanup: donor-temp tier audio ต้องลบจาก R2 ก่อนแถวถูก expire/hard-delete
async function cleanupExpiredTransactionsWithR2() {
  const urls = await db.getExpiringTierAudioUrls();
  for (const url of urls) deleteFromR2ByUrl(url).catch(err => console.error('[tier-audio-cleanup]', censor(err.message)));
  return db.cleanupExpiredTransactions();
}
async function hardDeleteExpiredTransactionsWithR2() {
  const urls = await db.getHardDeletableTierAudioUrls();
  for (const url of urls) deleteFromR2ByUrl(url).catch(err => console.error('[tier-audio-cleanup]', censor(err.message)));
  return db.hardDeleteExpiredTransactions();
}


async function listAllR2Objects() {
  const objects = [];
  let continuationToken;
  do {
    const res = await s3Client.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents ?? []) {
      objects.push({ key: obj.Key, lastModified: obj.LastModified });
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  return objects;
}

// Setup SQLite Database (Turso Cloud)
const db = require('./database');
const { encrypt, decrypt, censor } = require('./encryption');
const multer = require('multer');
const ALLOWED_SLIP_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_SLIP_MIMES.has(file.mimetype)) {
      return cb(new Error('Only image files are accepted (JPEG, PNG, GIF, WEBP)'));
    }
    cb(null, true);
  }
});
db.initDB().catch(err => console.error('❌ Database connection failed:', err));

// อ้างอิงระยะเวลาที่ hardDeleteOldTransactions() เก็บข้อมูลไว้จริง (default 3 เดือน ~90 วัน)
// cron /api/cron/cleanup-quarterly อาจถูกเรียกด้วย months ต่างจากนี้ในอนาคต (ไม่ใช่ hard guarantee)
// ถ้านโยบายเก็บข้อมูลเปลี่ยน แก้เลขนี้ที่เดียว — sync กับ max="" ใน index.html ด้วย
const LEADERBOARD_MAX_LOOKBACK_DAYS = 90;

// ค่าตั้งค่าเริ่มต้นของ Overlay
const defaultSettings = {
  duration: 8, // seconds
  soundEnabled: true,
  soundChoice: 'chime', // chime, retro, modern, bell, none
  soundVolume: 0.5,
  ttsEnabled: true,
  ttsVolume: 0.8,
  ttsRate: 1.3,
  ttsLanguage: 'th-TH',

  profanityFilterEnabled: true,
  profanityWords: 'ควย, เย็ด, สัส, เหี้ย, หี, แตด, ล่อ, ดอกทอง, ส้นตีน, อีดอก, อีเหี้ย, พ่อง, แม่มึง, กู, มึง',
  profanityReplaceStyle: 'asterisks', // asterisks, polite, block
  messageTemplate: '{ผู้โดเนท} ได้บริจาค {จำนวนเงิน} {สกุลเงิน}🎉',
  template_line1: '{ผู้โดเนท} ได้บริจาค🎉',
  template_line2: '{จำนวนเงิน} {สกุลเงิน}',
  showDonorMessage: true,
  minAmount: 1, // Minimum amount to trigger alert
  theme: 'text-only', // glassmorphism, cyberpunk, minimal, custom, text-only
  animation: 'slide-down', // slide-down, slide-up, fade, zoom
  fontFamily: 'Noto Sans Thai',
  primaryColor: '#667eea',
  secondaryColor: '#764ba2',
  backgroundColor: 'rgba(15, 15, 25, 0.88)',
  textColor: '#ffffff',
  borderColor: 'rgba(255, 255, 255, 0.05)',
  theme_colors: '{"glassmorphism":{"donor":"#fde047","amount":"#4ade80","border":"#667eea","bg":"rgba(15,15,25,0.123)","text":"#ffffff","suffix":"#f59e0b"},"cyberpunk":{"donor":"#ff007f","amount":"#00f3ff","border":"#ff007f","text":"#00f3ff","suffix":"#ff007f"},"custom":{"donor":"#fde047","amount":"#667eea","border":"rgba(255,255,255,0.25)","bg":"rgba(15,15,25,0.88)","text":"#ffffff","suffix":"#f59e0b"},"text-only":{"donor":"#fde047","amount":"#4ade80","text":"#ffffff","suffix":"#f59e0b"},"minimal":{"donor":"#fde047","amount":"#667eea","border":"rgba(255,255,255,0.15)","text":"#ffffff","suffix":"#f59e0b"}}',
  alert_font_sizes: '{"header":36,"donor_hl":40,"message":28,"amount":36,"amount_hl":72,"suffix":72}',
  alert_outline: '{"header_amount":2,"message":1}',
  particleCount: 15,
  fontSize: 48,
  customImageMode: 'emoji',
  customImageValue: '💝',
  customSoundUrl: '',
  ttsReadDonor: true,
  ttsPrefixEnabled: true,
  amountSuffix: 'บาท',
  goal_enabled: false,
  goal_amount: 5000,
  goal_current: 0,
  goal_label: 'ค่ากาแฟ',
  goal_bar_color: '#4ade80',
  goal_show_on_donate: true,
  goal_end_date: '',
  goal_bar_text: '{เปอร์เซนต์}',
  goal_subtitle1: '',
  goal_subtitle2: '',
  goal_anim_sound: true,
  goal_anim_enabled: true,
  goal_anim_sound_volume: 1,
  goal_bar_position: 'top',
  goal_bar_width: '600',
  goal_bar_layout: 'horizontal',
  goal_bar_thickness: '45',
  goal_bar_width_auto: 0,
  goal_pointer_enabled: 0,
  goal_pointer_side: 'right',
  goal_pointer_content: 'both',
  // Timer widget — keys must exist here or SEC-004 filter in getSettings() strips them
  timer_settings: '',
  timer_remaining_seconds: 600,
  timer_running: 0,
  timer_last_update: '',
  timer_cap_current: 0,
  // Leader Board / Recent Donate widgets — keys must exist here or SEC-004 filter in getSettings() strips them
  // Default values: widgets disabled on first setup, user can turn on in dashboard (updated 2026-07-18)
  leaderboard_settings: JSON.stringify({
    enabled: 0, max_entries: 5,
    title: '🏆 อันดับผู้โดเนท', currency: 'บาท',
    row_template_left: '  {ผู้โดเนท}  |  {จำนวนครั้ง}  ครั้ง ',
    row_template_right: '{จำนวนเงิน}   {สกุลเงิน}',
    period_mode: 'all', period_custom_days: 90,
    shine_enabled: 1, animation_enabled: 1, show_medal: 1,
    bg_enabled: 0, bg_color: '#000000', bg_opacity: 20,
    border_enabled: 0, border_color: '#a855f7', border_opacity: 80,
    row_bg_enabled: 1, row_border_enabled: 1,
    row_bg_color: '#ffffff', row_bg_opacity: 6,
    row_border_color: '#ffffff',
    font_size_title: 28, font_size_row: 26, font_size_medal: 28,
    outline_width: 2, outline_color: '#000000',
    color_rank: '#ffbb00', color_donor: '#fbff24', color_amount: '#18cc00',
    color_currency: '#ff0000', color_count: '#ffffff', color_text: '#ffffff',
    width: 720
  }),
  recentdonate_settings: JSON.stringify({
    enabled: 0, max_entries: 5,
    title: '🕐 โดเนทล่าสุด', currency: 'บาท',
    row_template_left: '{ผู้โดเนท} ',
    row_template_right: '{จำนวนเงิน} {สกุลเงิน} ',
    show_time: 1, animation_enabled: 1,
    bg_enabled: 0, bg_color: '#000000', bg_opacity: 60,
    border_enabled: 0, border_color: '#06b6d4', border_opacity: 100,
    row_bg_enabled: 1, row_bg_color: '#050505', row_bg_opacity: 5,
    row_border_enabled: 1, row_border_color: '#4dffb2',
    font_size_title: 28, font_size_row: 26, font_size_time: 14,
    outline_width: 2, outline_color: '#000000',
    color_donor: '#ffffff', color_amount: '#14ff6a',
    color_currency: '#ffffff', color_message: '#a6a6a6', color_text: '#ffffff',
    width: 720
  }),
  goal_text_settings: JSON.stringify({
    color_label: '#ffffff', color_bar: '#ffffff',
    color_sub1: '#ffffff', color_sub2: '#ffffff',
    font_size_label: 30, font_size_bar: 25,
    font_size_sub1: 20, font_size_sub2: 20,
    outline_width: 2,
    outline_color: '#000000'
  }),
  // Tier Donate — keys must exist here or SEC-004 filter in getSettings() strips them
  tier_donate_settings: JSON.stringify({
    enabled: false,
    tiers: [
      { level: 1, min_amount: 50, active: true, name: '', allow_image_choice: true, allow_sound_choice: false, allow_own_upload: false, allow_own_record: false, allow_youtube_clip: false },
      { level: 2, min_amount: 200, active: false, name: '', allow_image_choice: true, allow_sound_choice: true, allow_own_upload: false, allow_own_record: false, allow_youtube_clip: false },
      { level: 3, min_amount: 500, active: false, name: '', allow_image_choice: true, allow_sound_choice: true, allow_own_upload: true, allow_own_record: true, allow_youtube_clip: false }
    ],
    alert_images: []
  }),
  sound_library: JSON.stringify([])
};

// ========== SSE Alert System ==========
const MAX_SSE_CLIENTS = 500;
const SSE_CLIENT_TTL = 5 * 60 * 1000;
let sseClients = [];
const tokenCache = new Map(); // token → { username, cachedAt }
const TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 min
const disconnectTimers = new Map(); // username → setTimeout (5s grace before logging disconnect)
const slipHashCache = new Map(); // username → Set of base64 hashes (5 min TTL against slip re-submit)

// Bugfix Part 2: mark a slip hash "used" only on terminal SlipOK outcomes — never on
// temporary failures (network error, SLIP_DELAY) — so donors can retry the same image.
function markSlipHashUsed(username, hash) {
  if (!slipHashCache.has(username)) slipHashCache.set(username, new Set());
  slipHashCache.get(username).add(hash);
  setTimeout(() => {
    const set = slipHashCache.get(username);
    if (set) set.delete(hash);
  }, 60 * 1000);
}
const TERMINAL_SLIP_CODES = new Set(['SLIP_DUPLICATE', 'AMOUNT_MISMATCH', 'WRONG_RECEIVER', 'SLIP_INVALID']);

setInterval(() => {
  const now = Date.now();
  const before = sseClients.length;
  sseClients = sseClients.filter(c => (now - c.lastActivity) < SSE_CLIENT_TTL);
  if (before !== sseClients.length) {
    console.log(`🧹 SSE cleanup: removed ${before - sseClients.length} stale clients, ${sseClients.length} remaining`);
  }
}, 60000);

const DONATE_TEMPLATE = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '../public/donate-template/index.html'), 'utf8');
  } catch (err) {
    console.error('❌ Failed to load donate template:', err.message);
    return null;
  }
})();

// ========== Anti-Bot: Honeypot + Timestamp Token ==========
const MIN_SUBMIT_TIME = 2000;     // Minimum 2 seconds for human
const TOKEN_EXPIRY = 3600000;     // Token expires in 1 hour (page refresh)
const HONEYPOT_FIELD = 'contact_email';

function getPageTokenSecret() {
  // Use MASTER_ENCRYPTION_KEY for signing anti-bot tokens.
  // Rationale (per AGENTS.md): SESSION_SECRET may change with .env quoting fixes,
  // which would invalidate all existing tokens cached on donate pages.
  // MASTER_ENCRYPTION_KEY is stable across restarts and quoting fixes.
  // Note: This is a deliberate exception to key-separation — the anti-bot token
  // only protects against bot form submission, not high-value secrets, so the
  // risk of dual-use is acceptable. Do NOT extend this pattern to other HMAC uses.
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  if (masterKey) return masterKey;
  // Fallback only during dev/misconfiguration
  return process.env.SESSION_SECRET;
}

function generatePageToken() {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(4).toString('hex');
  const secret = getPageTokenSecret();
  const hmac = crypto.createHmac('sha256', secret)
    .update(`${timestamp}:${nonce}`)
    .digest('hex')
    .substring(0, 16);
  return `${timestamp}:${nonce}:${hmac}`;
}

function verifyPageToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [ts, nonce, sig] = parts;
  const timestamp = parseInt(ts, 10);
  if (isNaN(timestamp)) return false;
  const secret = getPageTokenSecret();
  const hmac = crypto.createHmac('sha256', secret)
    .update(`${timestamp}:${nonce}`)
    .digest('hex')
    .substring(0, 16);
  if (sig !== hmac) return false;
  const elapsed = Date.now() - timestamp;
  return elapsed >= MIN_SUBMIT_TIME && elapsed <= TOKEN_EXPIRY;
}

function blockBot(req, res) {
  // Fail silently — return same error structure so bots can't distinguish
  res.status(403).json({ error: 'FORBIDDEN', message: 'Request rejected' });
}

function checkAntiBot(req, res) {
  // Honeypot check
  const honeypot = req.body?.[HONEYPOT_FIELD] ?? req.body?.get?.(HONEYPOT_FIELD);
  if (honeypot !== undefined && honeypot !== null && honeypot !== '') {
    return false;
  }
  // Timestamp token check
  const token = req.body?.page_token;
  if (!token || !verifyPageToken(token)) {
    return false;
  }
  return true;
}
// ========== End Anti-Bot ==========

// ── Broadcast matrix ──────────────────────────────────────────────────
// broadcastAlert()       → real clients (overlay, goal-bar, dona-monitor)
//                          MUST exclude ALL demo-* sources
// broadcastGoalUpdate()  → real goal-bar clients
//                          MUST exclude ALL demo-* sources
// broadcastDemoAlert()   → demo-overlay + demo-goal-bar only
// broadcastDemoGoalBar() → demo-goal-bar only
// broadcastTimerUpdate()   → real timer clients; also mirrors to demo-timer when username===DEMO_STREAMER_USERNAME
// broadcastDemoTimerUpdate() → demo-timer only
// broadcastLeaderboardUpdate()   → real leader-board clients; excludes ALL demo-* sources
// broadcastRecentDonateUpdate()  → real recent-donate clients; excludes ALL demo-* sources
// When adding a new SSE source: update ALL functions above.
// ──────────────────────────────────────────────────────────────────────
function broadcastAlert(username, alertData) {
  let payload = alertData;
  if (alertData.type === 'donation') {
    const overlayOnline = sseClients.some(c => c.username === username && c.source === 'overlay');
    payload = { ...alertData, overlayOnline };
  }
  const data = JSON.stringify(payload);
  if (process.env.NODE_ENV !== 'production') console.log(`📢 [Broadcast] Sending to ${username}:`, alertData.type);

  sseClients = sseClients.filter(client => {
    // Never send real broadcasts to any demo client (demo-overlay, demo-goal-bar, demo-timer)
    const isDemo = ALLOWED_DEMO_SOURCES.has(client.source);
    if (client.username === username && !isDemo) {
      try {
        client.res.write(`data: ${data}\n\n`);
        client.lastActivity = Date.now();
        return true;
      } catch (err) {
        console.error(`❌ [Broadcast] Failed to write to client ${username}:`, err.message);
        return false; // Remove dead client
      }
    }
    return true;
  });
}

// Demo-only broadcast: sends to ALL demo clients (overlay + goal-bar), never touches real clients
function broadcastDemoAlert(username, alertData) {
  let payload = alertData;
  if (alertData.type === 'donation') {
    const overlayOnline = sseClients.some(c => c.username === username && c.source === 'demo-overlay');
    payload = { ...alertData, overlayOnline };
  }
  const data = JSON.stringify(payload);
  const allowedSources = new Set(['demo-overlay', 'demo-goal-bar']);
  sseClients = sseClients.filter(client => {
    if (client.username === username && allowedSources.has(client.source)) {
      try {
        client.res.write(`data: ${data}\n\n`);
        client.lastActivity = Date.now();
        return true;
      } catch (err) {
        return false;
      }
    }
    return true;
  });
}

// Demo goal bar broadcast: sends ONLY to demo-goal-bar clients
function broadcastDemoGoalBar(username, goalData) {
  const data = JSON.stringify(goalData);
  sseClients = sseClients.filter(client => {
    if (client.username === username && client.source === 'demo-goal-bar') {
      try {
        client.res.write(`data: ${data}\n\n`);
        client.lastActivity = Date.now();
        return true;
      } catch (err) {
        return false;
      }
    }
    return true;
  });
}

async function broadcastGoalUpdate(username, streamer) {
  if (!streamer.goal_enabled) return;
  let lastDonor = '';
  let lastAmount = 0;
  try {
    const recent = await db.getRecentDonations(username, 1);
    if (recent && recent[0]) {
      lastDonor = recent[0].donor || '';
      lastAmount = recent[0].amount || 0;
    }
  } catch (err) {
    console.error(`[BroadcastGoal] getRecentDonations failed for ${username}:`, err.message);
  }
  const payload = JSON.stringify({
    type: 'goal_update',
    current: streamer.goal_current,
    amount: streamer.goal_amount,
    label: streamer.goal_label,
    barColor: streamer.goal_bar_color,
    barText: streamer.goal_bar_text,
    subtitle1: streamer.goal_subtitle1,
    subtitle2: streamer.goal_subtitle2,
    endDate: streamer.goal_end_date,
    last_donor: lastDonor,
    last_amount: lastAmount
  });
  sseClients
    .filter(c => c.username === username && !ALLOWED_DEMO_SOURCES.has(c.source))
    .forEach(c => {
      try {
        c.res.write(`data: ${payload}\n\n`);
        c.lastActivity = Date.now();
      } catch (err) {
        console.error(`❌ [BroadcastGoal] Failed to write to client ${username}:`, err.message);
      }
    });
}

// [Requirement #8] period_mode → periodDays date filter — shared by Leader Board + Recent Donate
function resolvePeriodDays(settings) {
  const mode = settings?.period_mode || 'all';
  if (mode === 'weekly') return 7;
  if (mode === 'monthly') return 30;
  if (mode === 'custom') {
    const d = parseInt(settings?.period_custom_days, 10);
    return Math.min(LEADERBOARD_MAX_LOOKBACK_DAYS, Math.max(1, Number.isFinite(d) ? d : 30));
  }
  return null;
}

// [Requirement #9] 'all' อ่านจาก leaderboard_alltime (aggregate, ถาวร) — weekly/monthly/custom
// ยังอ่านจาก transactions (raw, มี paidAt ให้ filter ตามวัน — aggregate table ไม่มี per-period breakdown)
async function resolveLeaderboardEntries(username, limit = 5) {
  const s = await db.getSettings(username, defaultSettings);
  let lb = {};
  try { lb = JSON.parse(s.leaderboard_settings || '{}'); } catch {}
  const me = parseInt(lb.max_entries, 10);
  const effectiveLimit = (Number.isInteger(me) && me >= 1 && me <= 10) ? me : limit;
  const mode = lb.period_mode || 'all';
  if (mode === 'all') return db.getLeaderboardAlltime(username, effectiveLimit);
  const periodDays = resolvePeriodDays(lb);
  return db.getLeaderboard(username, effectiveLimit, periodDays);
}

// [Requirement #8] Recent Donate mirrors Leader Board's period_mode filter — no all-time aggregate needed, 'all' = no date filter
async function resolveRecentDonateEntries(username, limit = 5) {
  const s = await db.getSettings(username, defaultSettings);
  let rd = {};
  try { rd = JSON.parse(s.recentdonate_settings || '{}'); } catch {}
  const me = parseInt(rd.max_entries, 10);
  const effectiveLimit = (Number.isInteger(me) && me >= 1 && me <= 10) ? me : limit;
  const periodDays = resolvePeriodDays(rd);
  return db.getRecentDonations(username, effectiveLimit, periodDays);
}

// broadcastLeaderboardUpdate() → real leader-board clients only (mirrors broadcastGoalUpdate's demo exclusion)
async function broadcastLeaderboardUpdate(username) {
  const clients = sseClients.filter(c => c.username === username && c.source === 'leader-board');
  if (!clients.length) return;
  const entries = await resolveLeaderboardEntries(username, 5);
  const payload = JSON.stringify({
    type: 'leaderboard_update',
    entries: entries.map((e, i) => ({ rank: i + 1, donor: e.donor, total_amount: e.total_amount, donation_count: e.donation_count }))
  });
  sseClients = sseClients.filter(client => {
    if (client.username === username && client.source === 'leader-board') {
      try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
      catch { return false; }
    }
    return true;
  });
}

// broadcastRecentDonateUpdate() → real recent-donate clients only
async function broadcastRecentDonateUpdate(username) {
  const clients = sseClients.filter(c => c.username === username && c.source === 'recent-donate');
  if (!clients.length) return;
  const entries = await resolveRecentDonateEntries(username, 5);
  const payload = JSON.stringify({
    type: 'recentdonate_update',
    entries: entries.map(e => ({ donor: e.donor, amount: e.amount, message: e.message, paidAt: e.paidAt, payment_method: e.payment_method }))
  });
  sseClients = sseClients.filter(client => {
    if (client.username === username && client.source === 'recent-donate') {
      try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
      catch { return false; }
    }
    return true;
  });
}

// Timer config lives as a JSON string in streamer.timer_settings — parse once.
function getTimerConfig(streamer) {
  try { return JSON.parse(streamer.timer_settings || '{}'); }
  catch { return {}; }
}

// Donor-supplied timer choice — trust boundary: whitelist only
function sanitizeTimerAction(v) {
  return ['add', 'sub', 'none'].includes(v) ? v : null;
}
// Sign for a 'choice' rule based on donor pick. 'none'/null → 0 (no change).
function choiceSign(donorAction) {
  if (donorAction === 'add') return 1;
  if (donorAction === 'sub') return -1;
  return 0;
}

// broadcastTimerUpdate() → real timer clients; also mirrors to demo-timer when username===DEMO_STREAMER_USERNAME
function broadcastTimerUpdate(username, streamer, delta = 0, immediate = false) {
  const t = getTimerConfig(streamer);
  if (!t.enabled) return;
  const overlayOnline = sseClients.some(c => c.username === username && c.source === 'overlay');
  const goalBarOnline = sseClients.some(c => c.username === username && c.source === 'goal-bar');
  const timerData = {
    type: 'timer_update',
    remaining: streamer.timer_remaining_seconds,
    lastUpdate: streamer.timer_last_update,
    running: !!streamer.timer_running,
    capType: t.cap_type,
    capValue: t.cap_value,
    capCurrent: streamer.timer_cap_current,
    delta,
    overlayOnline,
    goalBarOnline,
    immediate,
  };
  const payload = JSON.stringify(timerData);
  sseClients = sseClients.filter(client => {
    const isDemo = ALLOWED_DEMO_SOURCES.has(client.source);
    if (client.username === username && !isDemo) {
      try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
      catch { return false; }
    }
    return true;
  });
  if (username === DEMO_STREAMER_USERNAME) broadcastDemoTimerUpdate(username, timerData);
}

// broadcastDemoTimerUpdate() → demo-timer clients ONLY
function broadcastDemoTimerUpdate(username, timerData) {
  const payload = JSON.stringify(timerData);
  sseClients = sseClients.filter(client => {
    if (client.username === username && client.source === 'demo-timer') {
      try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
      catch { return false; }
    }
    return true;
  });
}

// broadcastWidgetStatus() → dona-monitor clients (donate page) — fires on overlay/timer connect+disconnect
function broadcastWidgetStatus(username) {
  if (!username) return;
  const overlayActive = sseClients.some(c => c.username === username && c.authMethod === 'token' && c.source === 'overlay');
  const timerActive   = sseClients.some(c => c.username === username && c.authMethod === 'token' && c.source === 'timer');
  const payload = JSON.stringify({ type: 'widget_status', overlayActive, timerActive });
  sseClients = sseClients.filter(client => {
    if (client.username === username && client.source === 'dona-monitor') {
      try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
      catch { return false; }
    }
    return true;
  });
}

// broadcastDonateStatus() → donate-status SSE clients waiting for a specific refId to confirm
function broadcastDonateStatus(refId, payload) {
  if (!refId) return;
  const data = JSON.stringify({ type: 'donate_status', ...payload });
  sseClients = sseClients.filter(client => {
    if (client.source === 'donate-status' && client.ref === refId) {
      try { client.res.write(`data: ${data}\n\n`); client.lastActivity = Date.now(); return true; }
      catch { return false; }
    }
    return true;
  });
}

// broadcastTimerCap() → dona-monitor clients (donate page) — fires when timer_cap_current changes
function broadcastTimerCap(username, t, capCurrent) {
  if (!username) return;
  const payload = JSON.stringify({ type: 'timer_cap', capType: t.cap_type || null, capValue: t.cap_value || 0, capCurrent: capCurrent || 0 });
  sseClients = sseClients.filter(client => {
    if (client.username === username && client.source === 'dona-monitor') {
      try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
      catch { return false; }
    }
    return true;
  });
}

// Compute seconds to add/subtract for a donation, per the timer config rules.
// Pure: enabled/running gating + money-cap accumulation live in applyTimerOnDonation.
function calculateTimeDelta(amount, streamer, donorAction, currency = 'thb') {
  const t = getTimerConfig(streamer);
  const rules = (Array.isArray(t.rules) ? t.rules : [])
    .filter(r => (r.currency || 'thb') === currency);
  const mode = t.mode;

  if (mode === 'multiplier') {
    // Tier-pick: ใช้กฏเดียวที่ base_amount สูงสุดที่ amount ถึง (ไม่ sum ข้ามกฏ กันกฏฐานต่ำ เช่น 20฿ หักล้างกฏฐานสูง)
    const qualifying = rules.filter(r => r.base_amount > 0 && amount >= r.base_amount);
    if (qualifying.length === 0) return 0;
    const tier = qualifying.reduce((a, b) => b.base_amount > a.base_amount ? b : a);
    const sign = tier.action === 'choice' ? choiceSign(donorAction) : (tier.action === 'sub' ? -1 : 1);
    if (sign === 0) return 0;
    const mult = Math.floor(amount / tier.base_amount);
    return sign * mult * (tier.time_seconds || 0);
  }

  if (mode === 'threshold') {
    const sorted = [...rules].sort((a, b) => b.amount - a.amount);
    const tier = sorted.find(r => amount >= r.amount);
    if (!tier) return 0;
    if (tier.action === 'choice') return choiceSign(donorAction) * tier.time_seconds;
    return tier.action === 'sub' ? -tier.time_seconds : tier.time_seconds;
  }

  if (mode === 'fixed') {
    const match = rules.find(r => Math.abs(r.amount - amount) < 0.01);
    if (!match) return 0;
    if (match.action === 'choice') return choiceSign(donorAction) * match.time_seconds;
    return match.action === 'sub' ? -match.time_seconds : match.time_seconds;
  }

  return 0;
}

// Single donation side-effect for the timer — called at all 5 donation-confirm sites.
async function applyTimerOnDonation(streamer, amount, timerAction, currency = 'thb') {
  try {
    const t = getTimerConfig(streamer);
    if (!t.enabled) return;
    // Gate หน้าโดเนทอาจ stale (แท็บมือถือ frozen / widget-status SSE ตาย) แล้วส่ง timerAction=null
    // ทั้งที่ timer เปิดอยู่ → default 'add' ให้ตรงกับ default ฝั่ง frontend (timerChoice='add')
    // donor ที่เลือก "ไม่ปรับเวลา" ส่ง 'none' มาชัดเจน → ยังเป็น 0 เหมือนเดิม
    if (timerAction == null) timerAction = 'add';
    let delta = calculateTimeDelta(amount, streamer, timerAction, currency);
    if (delta === 0 && amount > 0 && process.env.NODE_ENV !== 'production') {
      console.log(`⏱️ Timer no-op: amount=${amount} currency=${currency} action=${timerAction} mode=${t.mode} (no matching rule or choice=none)`);
    }
    // Money cap: track total donation amount (บาท) — cap_value <= 0 = ไม่จำกัด (F1)
    // Gift เหรียญไม่มี rate แปลง → ไม่สะสมใน money cap (ใช้ time cap แทนถ้าต้องการคุม gift)
    if (currency === 'thb' && t.cap_type === 'money' && (t.cap_value || 0) > 0) {
      const room = (t.cap_value || 0) - (streamer.timer_cap_current || 0);
      if (room <= 0) return;
      // B4: นับเวลาเฉพาะยอดส่วนที่ยังอยู่ในลิมิต — mirror กับ preview หน้าโดเนท (getChoiceEffect)
      if (amount > room) delta = calculateTimeDelta(room, streamer, timerAction);
      await db.addTimerCap(streamer.id, amount, t.cap_value || 0);
      streamer.timer_cap_current = Math.min((streamer.timer_cap_current || 0) + amount, t.cap_value || 0); // sync ก่อน broadcast (F3)
      broadcastTimerCap(streamer.username, t, streamer.timer_cap_current);
    }

    // Time cap: track total time added (วินาที) — cap_value <= 0 = ไม่จำกัด (F1)
    if (t.cap_type === 'time' && (t.cap_value || 0) > 0) {
      const capValue = t.cap_value || 0;
      const capCurrent = streamer.timer_cap_current || 0;
      if (delta > 0) {
        const room = capValue - capCurrent;
        if (room <= 0) return;                        // cap เต็ม → ไม่ปรับเวลา
        const effectiveDelta = Math.min(delta, room);  // clamp ส่วนเกิน
        await db.addTimerCap(streamer.id, effectiveDelta, capValue);
        streamer.timer_cap_current = Math.min(capCurrent + effectiveDelta, capValue); // sync ก่อน broadcast (F3)
        broadcastTimerCap(streamer.username, t, streamer.timer_cap_current);
        const updated = await db.updateTimerState(streamer, effectiveDelta);
        broadcastTimerUpdate(streamer.username, { ...streamer, ...updated }, updated ? updated.applied_delta : effectiveDelta);
        return;
      }
      // delta < 0 (subtraction): ปรับเวลาก่อน แล้วคืน room ตามที่ลดได้จริง — ข้าม delta=0 (F5)
      // ลบตอนเวลาเหลือ 0 → applied=0 → ไม่คืน room + ไม่มี phantom animation
      if (delta < 0) {
        const updated = await db.updateTimerState(streamer, delta);
        const applied = updated ? updated.applied_delta : delta;
        if (applied < 0) {
          await db.addTimerCap(streamer.id, applied, capValue);
          streamer.timer_cap_current = Math.max(0, capCurrent + applied); // sync ก่อน broadcast (F3)
          broadcastTimerCap(streamer.username, t, streamer.timer_cap_current);
        }
        broadcastTimerUpdate(streamer.username, { ...streamer, ...updated }, applied);
        return;
      }
    }

    if (delta === 0) return;
    const updated = await db.updateTimerState(streamer, delta);
    broadcastTimerUpdate(streamer.username, { ...streamer, ...updated }, updated ? updated.applied_delta : delta);
  } catch (e) {
    console.error('Timer donation update failed:', e.message);
  }
}

// Single donation confirm entry point — every confirm path (webhook, slip, manual, charge) must call this.
// Atomic pending->successful transition guards against cross-path double-confirm (QA Q1 2026-07-13):
// confirmTransactionPaid updates only WHERE status='pending' (or inserts a new row) and reports rowsAffected.
// If another path already confirmed this tx, rowsAffected===0 → skip goal/alert/timer so nothing double-fires.
async function confirmDonationSideEffects(txId, { amount, rawWebhook, extraTx = {}, extraAlert = {} } = {}) {
  const confirmResult = await db.confirmTransactionPaid({
    id: txId,
    paidAt: new Date().toISOString(),
    ...(amount != null ? { amount } : {}),
    ...(rawWebhook ? { raw_webhook: rawWebhook } : {}),
    ...extraTx
  });
  const affected = confirmResult ? (confirmResult.rowsAffected ?? 0) : 0;
  const tx = (await db.getTransactionById(txId)) || {};
  if (!affected) return tx; // already confirmed by another path — no double side-effects
  const finalAmount = amount ?? tx.amount ?? 0;
  broadcastAlert(tx.streamer_username, {
    type: 'donation',
    donor: tx.donor || 'Anonymous',
    amount: finalAmount,
    message: tx.message || '',
    timestamp: new Date().toISOString(),
    ...(tx.tier_level ? { tierLevel: tx.tier_level } : {}),
    ...(tx.tier_image_url ? { tierImageUrl: tx.tier_image_url } : {}),
    ...(tx.tier_sound_url ? { tierSoundUrl: tx.tier_sound_url } : {}),
    ...(tx.tier_sound_youtube_id ? {
      tierYoutubeId: tx.tier_sound_youtube_id,
      tierYoutubeStart: tx.tier_sound_youtube_start,
      tierYoutubeEnd: tx.tier_sound_youtube_end
    } : {}),
    ...extraAlert
  });
  // § 2.6 TIER_DONATE_BLUEPRINT.md — ลบ donor-temp audio หลังใช้ครั้งเดียว (fire-and-forget, ห้าม block alert)
  // ต้องหน่วงลบ: overlay เพิ่งได้ SSE แล้วค่อย fetch ไฟล์จาก R2 — ลบทันทีทำให้ alert จริงไม่มีเสียง (404)
  if (tx.tier_sound_is_temp === 1 && tx.tier_sound_url) {
    const url = tx.tier_sound_url;
    setTimeout(() => {
      deleteFromR2ByUrl(url).catch(err => console.error('[tier-audio-cleanup]', censor(err.message)));
    }, 10 * 60 * 1000);
  }
  if (tx.streamer_username && finalAmount > 0) {
    try {
      const streamer = await db.getStreamer(tx.streamer_username);
      if (streamer && streamer.goal_enabled) {
        const updated = await db.updateGoalCurrent(streamer.id, finalAmount);
        await broadcastGoalUpdate(streamer.username, { ...streamer, ...updated });
      }
      if (streamer) await applyTimerOnDonation(streamer, finalAmount, sanitizeTimerAction(tx.timer_action));
      if (tx.donor && tx.donor !== 'Anonymous') {
        await db.upsertLeaderboard(tx.streamer_username, tx.donor, finalAmount)
          .catch(e => console.error('Leaderboard upsert failed:', e.message));
      }
      await broadcastLeaderboardUpdate(tx.streamer_username);
      await broadcastRecentDonateUpdate(tx.streamer_username);
    } catch (e) {
      console.error('Confirm side-effects failed:', e.message);
    }
  }
  return tx;
}

async function logTransaction(data) {
  try {
    return await db.saveTransaction(data);
  } catch (err) {
    console.error('❌ Error logging transaction to SQLite/Turso:', err.message);
    return null;
  }
}

// Middleware
const ALLOWED_ORIGINS = [
  'https://tipkub.me',
  'https://www.tipkub.me',
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : [])
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

let helmet;
try { helmet = require('helmet'); } catch (e) {}
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: {
      // Allow inline styles/scripts (dashboard uses inline), own origin + https for assets,
      // SSE + API calls to self, Google Fonts/TTS, Twitch/Streamlabs OAuth redirects.
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://static.cloudflareinsights.com', 'https://www.youtube.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
        connectSrc: ["'self'", 'https://www.myinstants.com', 'https://*.r2.cloudflarestorage.com', 'https://cdn.jsdelivr.net', 'https://cloudflareinsights.com', 'ws://127.0.0.1:21213', 'ws://localhost:21213'],
        workerSrc: ["'self'", 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'https://translate.google.com', 'https://www.myinstants.com', 'data:', process.env.R2_PUBLIC_URL || 'https://pub-db8500a3bce347deb31e3ac1eb556de8.r2.dev'],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://streamlabs.com', 'https://id.twitch.tv'],
        // ponytail: helmet merges its own defaults (which include upgrade-insecure-requests) on top
        // of these directives unless explicitly overridden. On a plain-http dev server this forces
        // every subresource (including same-origin iframe.src) to https, which doesn't exist here —
        // breaks every widget preview iframe. Only enforce it where https actually exists.
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    // Same reasoning as above — HSTS on dev http would also force-upgrade subresource requests.
    hsts: process.env.NODE_ENV === 'production'
  }));
  app.use(helmet.frameguard({ action: 'sameorigin' }));
} else {
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
}

// § 6 TIER_DONATE_BLUEPRINT.md — เปิด getUserMedia (mic recording) เฉพาะ same-origin เท่านั้น
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  next();
});

if (!process.env.SESSION_SECRET) {
  console.error('❌ CRITICAL ERROR: SESSION_SECRET is not defined in the environment!');
  process.exit(1);
}

const REQUIRED_ENV_VARS = [
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_CALLBACK_URL',
  'STREAMLABS_CLIENT_ID',
  'STREAMLABS_CLIENT_SECRET',
  'STREAMLABS_CALLBACK_URL',
  'MASTER_ENCRYPTION_KEY',
  'ENCRYPTION_SALT',
];

const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ CRITICAL ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

if (!process.env.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET === 'your_webhook_secret') {
  console.warn('⚠️ WARNING: WEBHOOK_SECRET is not set or is using default value. Webhook verification will fail.');
}

app.use(session({
  store: new TursoStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'sessionId',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

console.log(`🚀 Server started in ${process.env.NODE_ENV || 'development'} mode`);


app.use(passport.initialize());
app.use(passport.session());

// SECURITY: Block direct access to /dashboard and /admin via express.static, but allow static assets
app.use((req, res, next) => {
  // Exclude /demo/* from auth guard — demo dashboard is intentionally public
  if (req.path.startsWith('/demo/')) return next();
  if (req.path.startsWith('/dashboard') || req.path.match(/\/\w+\/dashboard/)) {
    if (!req.isAuthenticated() && !req.path.match(/\.(css|js|jpg|jpeg|png|gif|svg|woff|woff2|ttf|otf)$/)) {
      return res.redirect('/login');
    }
  }
  if (req.path.startsWith('/admin')) {
    const isAsset = /\.(css|js|jpg|jpeg|png|gif|svg|woff|woff2|ttf|otf)$/.test(req.path);
    if (!isAsset) {
      if (!req.isAuthenticated()) return res.redirect('/login');
      // /admin เป๊ะๆ ปล่อยผ่านให้ route (~line 1452) ทำ redirect non-admin → dashboard ตัวเองตามเดิม
      if (req.path !== '/admin' && req.path !== '/admin/' &&
          (!ADMIN_TWITCH_ID || String(req.user.twitch_id) !== ADMIN_TWITCH_ID)) {
        return res.redirect('/forbidden?reason=admin');
      }
    }
  }
  next();
});

// Passport Twitch Strategy Configuration
passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    callbackURL: process.env.TWITCH_CALLBACK_URL,
    scope: 'user:read:email'
  },
  (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
  }
));

// Passport Streamlabs Strategy Configuration
passport.use(new OAuth2Strategy({
    authorizationURL: 'https://streamlabs.com/api/v2.0/authorize',
    tokenURL: 'https://streamlabs.com/api/v2.0/token',
    clientID: process.env.STREAMLABS_CLIENT_ID,
    clientSecret: process.env.STREAMLABS_CLIENT_SECRET,
    callbackURL: process.env.STREAMLABS_CALLBACK_URL,
    scope: process.env.STREAMLABS_SCOPE || '',
  },
  async (accessToken, refreshToken, params, profile, done) => {
    try {
      // Streamlabs doesn't provide a full profile in the callback. 
      // We need to fetch user info using the accessToken.
      const response = await axios.get('https://streamlabs.com/api/v2.0/user', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const userData = response.data;
      const streamlabsProfile = {
        streamlabs_id: userData.id,
        username: userData.username,
        profile_image: userData.profile_image,
        _json: userData
      };
      return done(null, streamlabsProfile);
    } catch (err) {
      console.error('Error fetching Streamlabs user info:', err.message);
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => {
  done(null, user);
});
 
passport.deserializeUser(async (obj, done) => {
  try {
    let streamer = null;
    if (typeof obj === 'object') {
      // Explicit priority: twitch_id → streamlabs_id → Passport profile fallback
      // NEVER use getStreamerById(streamlabs_id) — it calls getStreamerByTwitchId first (collision bug)
      if (obj.twitch_id) {
        streamer = await db.getStreamerByTwitchId(String(obj.twitch_id));
      }
      if (!streamer && obj.streamlabs_id) {
        streamer = await db.getStreamerByStreamlabsId(String(obj.streamlabs_id));
      }
      if (!streamer) {
        // Passport profile case: obj.id is platform ID string, not DB auto-increment
        streamer = await db.getStreamerById(obj.id);
      }
      if (streamer) {
        if (Number(streamer.is_active) === 0) return done(null, false);  // banned → Passport treats as logged out
        obj.username = streamer.username;
        obj.twitch_id = streamer.twitch_id;
        obj.streamlabs_id = streamer.streamlabs_id;
      }
    } else {
      streamer = await db.getStreamerById(obj);
      if (streamer) {
        if (Number(streamer.is_active) === 0) return done(null, false);  // banned
        return done(null, streamer);
      }
    }
    done(null, obj);
  } catch (err) {
    console.error('DeserializeUser Error:', err);
    done(err);
  }
});

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function maskIp(ip) {
  if (!ip) return '';
  return ip.includes(':')
    ? ip.split(':').slice(0, 2).join(':') + '::x'
    : ip.split('.').slice(0, 2).join('.') + '.x.x';
}

// ========== Helper Functions ==========

// Resolves a streamer record for req.user regardless of auth method (Twitch or Streamlabs).
// Never use getStreamerByTwitchId(req.user.twitch_id || req.user.id) directly — req.user.id
// is the numeric DB PK which will not match the twitch_id column for Streamlabs-only users.
async function getStreamerForUser(user) {
  if (!user) return null;
  let s = null;
  if (user.twitch_id) s = await db.getStreamerByTwitchId(String(user.twitch_id));
  if (!s && user.streamlabs_id) s = await db.getStreamerByStreamlabsId(String(user.streamlabs_id));
  if (!s && user.username) s = await db.getStreamer(user.username);
  return s;
}

async function getActualUsername(user) {
  if (!user) return null;
  try {
    let streamer = null;
    if (user.twitch_id) streamer = await db.getStreamerByTwitchId(String(user.twitch_id));
    if (!streamer && user.streamlabs_id) streamer = await db.getStreamerByStreamlabsId(String(user.streamlabs_id));
    if (!streamer && user.username) streamer = await db.getStreamer(user.username);
    if (streamer) return streamer.username;
  } catch (err) {
    console.error('Error resolving actual username:', err);
  }
  return (user.username || user.nickname || user.display_name || (user._json && user._json.display_name) || 'Unknown').toLowerCase();
}

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// ========== Rate Limiters ==========
// Defined here (before routes) to avoid temporal dead zone errors.
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: 'การเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false,
});

const createChargeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'กรุณารอสักครู่ก่อนสร้างรายการใหม่' },
  standardHeaders: true,
  legacyHeaders: false,
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many webhook requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const presignLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'อัปโหลดถี่เกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false,
});

const slipokQuotaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`Rate limit hit on /api/payment/slipok-quota — IP: ${req.ip}`);
    res.status(429).json({ error: 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่' });
  }
});

const goalPublicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false
});

// § 2.3 TIER_DONATE_BLUEPRINT.md
const tierSettingsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false
});

// § 2.4 TIER_DONATE_BLUEPRINT.md — เข้มกว่า slip upload (1MB vs 5MB, 5/min/IP)
const donorAudioUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'อัปโหลดบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false
});

const widgetStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'เชื่อมต่อบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false
});

const demoRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('⏱️ Demo rate limit hit IP:', req.ip);
    res.status(429).json({ error: 'Too many requests' });
  }
});

// Strict limiter for demo alert — prevents spamming KaminKub's live overlay
const demoAlertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('⏱️ Demo alert rate limit hit IP:', req.ip);
    res.status(429).json({ error: 'ส่ง Alert บ่อยเกินไป กรุณารอสักครู่' });
  }
});

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'ส่ง feedback ได้สูงสุด 5 ครั้ง/ชั่วโมง' },
  standardHeaders: true,
  legacyHeaders: false,
});

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'ส่งรายงานได้สูงสุด 3 ครั้ง/ชั่วโมง' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminMonitorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const tiktokGiftLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'ส่ง gift บ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Polling limiter สำหรับ bridge heartbeat + dashboard status poll (แยกจาก gift ตาม CLAUDE.md)
// bridge ping 6/min + dashboard poll 6/min → max 30 เผื่อ refresh มือ
const tiktokStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// In-memory bridge liveness — C1 aligned (in-memory only, ไม่แตะ DB, ไม่มี PII)
// username(lowercase) → { at: lastSeenMs, dapi: bool }  ; VPS restart = หาย, heartbeat ถัดไปเติมใหม่
const bridgeHeartbeats = new Map();
const BRIDGE_STALE_MS = 25000; // 2.5× heartbeat interval — กัน network blip

// Redirect authenticated users to their dashboard (used on landing/login/register pages).
// Avoids the redundant "click login again" flow when a session cookie is still valid.
async function redirectIfAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    try {
      const actualUsername = await getActualUsername(req.user);
      if (actualUsername) {
        // Verify the user actually exists in DB (session may be stale after account deletion)
        const streamer = await db.getStreamer(actualUsername);
        if (streamer) {
          return res.redirect(`/${actualUsername.toLowerCase()}/dashboard`);
        }
      }
    } catch (err) {
      console.error('redirectIfAuthenticated error:', err.message);
    }
  }
  next();
}

// -----------------------------------------------------------------
// [DEMO DASHBOARD] - Public read-only preview (no auth required)
// -----------------------------------------------------------------

function applyDemoMask(row) {
  // Allowlist: new schema columns are safe-by-default (not exposed unless explicitly added here)
  const ALLOWED_DEMO_FIELDS = new Set([
    // Overlay alert settings
    'duration', 'particleCount', 'fontSize',
    'soundEnabled', 'soundChoice', 'soundVolume', 'alert_sound_url', 'customSoundUrl',
    'ttsEnabled', 'ttsVolume', 'ttsRate', 'ttsLanguage', 'ttsVoice',
    'ttsReadDonor', 'ttsPrefixEnabled',
    'showDonorMessage',
    'messageTemplate', 'template_line1', 'template_line2', 'amountSuffix', 'minAmount',
    'profanityFilterEnabled', 'profanityWords', 'profanityReplaceStyle',
    'theme', 'fontFamily', 'animation',
    'primaryColor', 'secondaryColor', 'textColor', 'backgroundColor', 'borderColor',
    'theme_colors', 'alert_font_sizes', 'alert_outline',
    'customImageMode', 'customImageValue',
    // Page customization
    'page_title', 'page_subtitle', 'thank_you_header', 'thank_you_subtitle',
    'profile_image_source', 'profile_image_value', 'profile_glow_color',
    'header_bg_url', 'page_bg_url', 'header_bg_y', 'header_bg_zoom',
    // Social links (public info)
    'social_twitch', 'social_youtube', 'social_tiktok',
    'social_facebook', 'social_x', 'social_discord', 'social_instagram',
    // Payment method status indicators (no credentials)
    'payment_method', 'promptpay_enabled', 'promptpay_type',
    'tfp_connected', 'tfp_last_check',
    'slipok_connected', 'slipok_last_check', 'slipok_quota_total',
    'truemoney_enabled', 'truemoney_slipok_connected',
    'truemoney_slipok_last_check', 'truemoney_slipok_quota_total',
    'bank_enabled', 'bank_name',
    // Goal bar
    'goal_enabled', 'goal_amount', 'goal_current', 'goal_label', 'goal_bar_color',
    'goal_show_on_donate', 'goal_end_date', 'goal_bar_text',
    'goal_subtitle1', 'goal_subtitle2', 'goal_anim_sound', 'goal_anim_enabled', 'goal_anim_sound_volume', 'goal_bar_position', 'goal_bar_width', 'goal_bar_layout', 'goal_bar_thickness', 'goal_bar_width_auto',
    'goal_pointer_enabled', 'goal_pointer_side', 'goal_pointer_content',
    // Streamlabs display name (not tokens)
    'streamlabs_username',
    // Timer state + config (no secrets)
    'timer_settings', 'timer_remaining_seconds', 'timer_running', 'timer_cap_current', 'timer_last_update',
    // Badges (public earned list, no credentials)
    'badges', 'badge_display',
    // Leaderboard + Recent Donate widget configs (no secrets)
    'leaderboard_settings', 'recentdonate_settings', 'goal_text_settings',
    // TrueMoney Webhook status indicators (no credentials)
    'truemoney_webhook_enabled', 'truemoney_webhook_methods',
    'truemoney_webhook_kyc_confirmed', 'truemoney_webhook_expiry',
    // Account profile (public info, no secrets)
    'tos_accepted_at',
  ]);
  const masked = {};
  for (const k of ALLOWED_DEMO_FIELDS) {
    if (k in row) masked[k] = row[k];
  }
  masked._isDemo = true;
  masked.username = 'KaminKub';
  return masked;
}

app.get('/demo/dashboard', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/dashboard/index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const injected = html.replace(
    '<head>',
    '<head>\n<meta name="robots" content="noindex,nofollow">\n<script>window.DEMO_MODE=true;window.DEMO_STREAMER="KaminKub";</script>'
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

const DEMO_STREAMER_USERNAME = 'kaminkub';
const ADMIN_TWITCH_ID = process.env.ADMIN_TWITCH_ID || '';

app.get('/api/demo/settings', demoRateLimiter, async (req, res) => {
  try {
    const row = await db.getStreamer(DEMO_STREAMER_USERNAME);
    if (!row) return res.status(503).json({ error: 'Demo data unavailable' });
    const masked = applyDemoMask(row);
    // Computed fields (mirrors /api/payment/settings)
    masked.truemoney_webhook_secret_set = !!row.truemoney_webhook_secret_encrypted;
    masked.truemoney_webhook_tx_month = await db.countMonthlyWebhookTx(DEMO_STREAMER_USERNAME);
    // Computed account fields (mirrors /api/user/me — no secrets)
    masked.memberSince = row.tos_accepted_at || null;
    masked.profileImage = row.profile_image_value || '/avatar.jpg';
    masked.profileGlowColor = row.profile_glow_color || '#005704';
    masked.twitchConnected = !!row.twitch_id;
    masked.streamlabsConnected = !!row.streamlabs_id;
    masked.authProvider = determinePrimaryAuth(row);
    res.json(masked);
  } catch (e) {
    console.error('💥 Demo settings error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Return static mock transactions — never expose real donor data in demo
const DEMO_MOCK_TRANSACTIONS = [
  { id: 'demo-001', donor: 'นักผจญภัย123', amount: 500,  message: 'สู้ๆ นะครับ!',        status: 'successful', payment_method: 'promptpay', createdAt: new Date(Date.now() - 5 * 60000).toISOString() },
  { id: 'demo-002', donor: 'ขอบคุณมาก',   amount: 100,  message: '',                     status: 'successful', payment_method: 'promptpay', createdAt: new Date(Date.now() - 15 * 60000).toISOString() },
  { id: 'demo-003', donor: 'สมชาย',        amount: 1000, message: 'เก่งมากเลยครับ 🔥',   status: 'successful', payment_method: 'truemoney', createdAt: new Date(Date.now() - 30 * 60000).toISOString() },
  { id: 'demo-004', donor: 'Anonymous',     amount: 50,   message: 'ขอให้สนุกกับการสตรีม', status: 'successful', payment_method: 'promptpay', createdAt: new Date(Date.now() - 60 * 60000).toISOString() },
  { id: 'demo-005', donor: 'แฟนคลับ',      amount: 200,  message: '',                     status: 'pending',    payment_method: 'promptpay', createdAt: new Date(Date.now() - 90 * 60000).toISOString() },
];

app.get('/api/demo/transactions', demoRateLimiter, (req, res) => {
  res.json(DEMO_MOCK_TRANSACTIONS);
});

// Derived mock data for demo leader-board / recent-donate widgets — same source, never real donor data
const DEMO_MOCK_LEADERBOARD = (() => {
  const successful = DEMO_MOCK_TRANSACTIONS.filter(t => t.status === 'successful' && t.donor !== 'Anonymous');
  return [...successful]
    .sort((a, b) => b.amount - a.amount)
    .map((t, i) => ({ rank: i + 1, donor: t.donor, total_amount: t.amount, donation_count: 1 }));
})();
const DEMO_MOCK_RECENTDONATE = DEMO_MOCK_TRANSACTIONS
  .filter(t => t.status === 'successful')
  .map(t => ({ donor: t.donor, amount: t.amount, message: t.message, paidAt: t.createdAt, payment_method: t.payment_method }));

app.post('/api/demo/alerts/test', demoRateLimiter, demoAlertLimiter, (req, res) => {
  const { donor, amount, message } = req.body || {};
  const alertData = {
    type: 'donation',
    donor:   String(donor  || 'ผู้เยี่ยมชม Demo').slice(0, 50),
    amount:  Math.min(Math.max(Number(amount) || 100, 1), 5000),
    message: String(message || '').slice(0, 100),
    timestamp: new Date().toISOString()
  };
  // Use demo-only broadcast — must NOT reach real overlay
  broadcastDemoAlert(DEMO_STREAMER_USERNAME, alertData);
  res.json({ success: true, alert: alertData });
});

app.post('/api/demo/alerts/test-clear-sticky', demoRateLimiter, demoAlertLimiter, (req, res) => {
  broadcastDemoAlert(DEMO_STREAMER_USERNAME, { type: 'clear_sticky_alert' });
  res.json({ success: true });
});

app.get('/demo/dona-monitor', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/dashboard/dona-monitor.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const injected = html.replace(
    '<head>',
    '<head>\n<meta name="robots" content="noindex,nofollow">\n<script>window.DEMO_MODE=true;window.DEMO_STREAMER="kaminkub";</script>'
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

app.get('/api/demo/overlay/settings', demoRateLimiter, async (req, res) => {
  try {
    const row = await db.getStreamer(DEMO_STREAMER_USERNAME);
    if (!row) return res.status(503).json({ error: 'Demo data unavailable' });
    const masked = applyDemoMask(row);
    const recent = DEMO_MOCK_RECENTDONATE[0];
    masked.goal_last_donor = (recent && recent.donor) || '';
    masked.goal_last_amount = (recent && recent.amount) || 0;
    res.json(masked);
  } catch (e) {
    console.error('💥 Demo overlay settings error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

const MAX_DEMO_SSE_CLIENTS = 50;
const MAX_DEMO_SSE_PER_IP = 3;

const ALLOWED_DEMO_SOURCES = new Set(['demo-overlay', 'demo-goal-bar', 'demo-timer', 'demo-leader-board', 'demo-recent-donate']);

app.get('/api/demo/alerts/stream', demoRateLimiter, (req, res) => {
  const clientSource = ALLOWED_DEMO_SOURCES.has(req.query.source) ? req.query.source : 'demo-overlay';
  const demoClients = sseClients.filter(c => ALLOWED_DEMO_SOURCES.has(c.source));
  if (demoClients.length >= MAX_DEMO_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Too many demo connections' });
  }
  const clientIp = req.ip;
  const ipCount = demoClients.filter(c => c.ip === clientIp).length;
  if (ipCount >= MAX_DEMO_SSE_PER_IP) {
    return res.status(429).json({ error: 'Too many connections from your IP' });
  }
  const now = Date.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Demo connected' })}\n\n`);
  if (clientSource === 'demo-leader-board') {
    res.write(`data: ${JSON.stringify({ type: 'leaderboard_update', entries: DEMO_MOCK_LEADERBOARD })}\n\n`);
  }
  if (clientSource === 'demo-recent-donate') {
    res.write(`data: ${JSON.stringify({ type: 'recentdonate_update', entries: DEMO_MOCK_RECENTDONATE })}\n\n`);
  }
  const clientObj = { res, validated: false, username: DEMO_STREAMER_USERNAME, authMethod: 'demo', lastActivity: now, source: clientSource, ip: clientIp };
  sseClients.push(clientObj);
  req.on('close', () => {
    const idx = sseClients.indexOf(clientObj);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

app.get('/demo/overlay', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/overlay/index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const injected = html.replace('<head>', '<head>\n<meta name="robots" content="noindex,nofollow">\n<script>window.DEMO_MODE=true;window.DEMO_STREAMER="kaminkub";</script>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

app.get('/demo/goal-bar', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/goal-bar/index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const injected = html.replace('<head>', '<head>\n<meta name="robots" content="noindex,nofollow">\n<script>window.DEMO_MODE=true;window.DEMO_STREAMER="kaminkub";</script>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

// Demo goal bar test — broadcasts goal_update to demo-goal-bar SSE clients
const demoGoalLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.post('/api/demo/goal/test', demoRateLimiter, demoGoalLimiter, (req, res) => {
  const { current, amount, label, barColor, barText, subtitle1, subtitle2 } = req.body || {};
  const recent = DEMO_MOCK_RECENTDONATE[0] || {};
  const goalData = {
    type: 'goal_update',
    current: Math.max(0, Math.min(parseFloat(current) || 0, 99999)),
    amount:  Math.max(1, Math.min(parseFloat(amount)  || 5000, 9999999)),
    label:   String(label   || 'ค่ากาแฟ').slice(0, 60),
    barColor: String(barColor || '#4ade80').slice(0, 20),
    barText:  String(barText  || '{เปอร์เซนต์}').slice(0, 60),
    subtitle1: String(subtitle1 ?? '').slice(0, 80),
    subtitle2: String(subtitle2 || '').slice(0, 80),
    endDate: null,
    last_donor: recent.donor || '',
    last_amount: recent.amount || 0
  };
  broadcastDemoGoalBar(DEMO_STREAMER_USERNAME, goalData);
  res.json({ success: true });
});

app.get('/demo/timer', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/timer/index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const injected = html.replace('<head>', '<head>\n<meta name="robots" content="noindex,nofollow">\n<script>window.DEMO_MODE=true;window.DEMO_STREAMER="kaminkub";</script>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

// Demo timer test — broadcasts timer_update to demo-timer SSE clients
const demoTimerLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.post('/api/demo/timer/test', demoRateLimiter, demoTimerLimiter, (req, res) => {
  const { remaining, running } = req.body || {};
  const data = {
    type: 'timer_update',
    remaining: Math.max(0, Math.min(parseInt(remaining) || 600, 86400)),
    running: running !== false,
    lastUpdate: new Date().toISOString()
  };
  broadcastDemoTimerUpdate(DEMO_STREAMER_USERNAME, data);
  res.json({ success: true });
});

app.get('/demo/leader-board', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/leader-board/index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const injected = html.replace('<head>', '<head>\n<meta name="robots" content="noindex,nofollow">\n<script>window.DEMO_MODE=true;window.DEMO_STREAMER="kaminkub";</script>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

app.get('/demo/recent-donate', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/recent-donate/index.html');
  const html = fs.readFileSync(filePath, 'utf8');
  const injected = html.replace('<head>', '<head>\n<meta name="robots" content="noindex,nofollow">\n<script>window.DEMO_MODE=true;window.DEMO_STREAMER="kaminkub";</script>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(injected);
});

// -----------------------------------------------------------------
// [FIXED ROUTES] - Define these BEFORE dynamic routes and static serving
// -----------------------------------------------------------------

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  // Home/landing page always renders — no auto-redirect.
  // Only the login/register buttons redirect authenticated users to their dashboard.
  res.sendFile(path.join(__dirname, '../public/pages/index.html'));
});

app.get('/login', redirectIfAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/auth/login.html'));
});

app.get('/register', redirectIfAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/auth/register.html'));
});

app.get('/register/setup', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../public/pages/auth/register-setup.html'));
});

app.get('/api/register/pending', (req, res) => {
  console.log('📋 [Register Pending] Session pendingUser:', req.session.pendingUser ? JSON.stringify({ hasTwitchId: !!req.session.pendingUser.twitchId, hasStreamlabsId: !!req.session.pendingUser.streamlabsId, platform: req.session.pendingUser.streamlabsPlatform || 'unknown', hasName: !!req.session.pendingUser.streamlabsName, hasProfileImage: !!req.session.pendingUser.profileImage }) : '(none)');
  if (!req.session.pendingUser) return res.status(401).json({ error: 'Unauthorized' });
  res.json(req.session.pendingUser);
});

app.post('/api/register/complete', sameOriginCheck, async (req, res) => {
  console.log('🛡️ [Register Complete] Request received');
  
  if (!req.session.pendingUser) {
    console.error('❌ [Register Complete] Session missing pendingUser');
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  
  const { username, tos_accepted } = req.body;
  if (!tos_accepted) {
    return res.status(400).json({ error: 'ต้องยอมรับข้อกำหนดการใช้บริการก่อนสมัคร' });
  }
  console.log(`📝 [Register Complete] Attempting to register username: ${username}`);
  
  if (!username) {
    console.error('❌ [Register Complete] No username provided in body');
    return res.status(400).json({ error: 'Username is required' });
  }
  
  const normalizedUsername = username.toLowerCase().trim();
  if (!normalizedUsername || normalizedUsername.length < 3) {
    console.error(`❌ [Register Complete] Invalid username length: ${normalizedUsername}`);
    return res.status(400).json({ error: 'Username must be at least 3 characters long' });
  }
  if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
    console.error(`❌ [Register Complete] Invalid username characters: ${normalizedUsername}`);
    return res.status(400).json({ error: 'Username must be 3–30 characters: a-z, 0-9, underscore only' });
  }
  if (RESERVED_WORDS.includes(normalizedUsername)) {
    console.error(`❌ [Register Complete] Reserved username attempted: ${normalizedUsername}`);
    return res.status(400).json({ error: 'Username นี้ถูกสงวนไว้ กรุณาเลือกชื่ออื่น' });
  }

  try {
    console.log(`🔎 [Register Complete] Checking if ${normalizedUsername} exists...`);
    const existingUser = await db.getStreamer(normalizedUsername);
    if (existingUser) {
      console.error(`❌ [Register Complete] Username ${normalizedUsername} already exists`);
      return res.status(400).json({ error: 'This username is already taken' });
    }
  
    const pending = req.session.pendingUser;
    console.log(`💾 [Register Complete] Saving user...`, { hasTwitchId: !!pending.twitchId, hasStreamlabsId: !!pending.streamlabsId, platform: pending.streamlabsPlatform || 'unknown', username: normalizedUsername, hasProfileImage: !!pending.profileImage });

    // Upload Twitch avatar to R2 on first registration (Approach 2: cache to R2)
    let avatarUrl = pending.profileImage || null;
    const avatarUploadId = pending.twitchId || pending.streamlabsId || null;
    if (avatarUrl && avatarUrl.startsWith('http') && avatarUploadId) {
      let r2Url = null;
      try {
        const resp = await axios.get(avatarUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const ct = resp.headers['content-type'] || 'image/jpeg';
        const ext = ct.includes('webp') ? 'webp' : ct.includes('png') ? 'png' : 'jpg';
        r2Url = await uploadBufferToR2(Buffer.from(resp.data), `avatars/twitch_${avatarUploadId}.${ext}`, ct);
      } catch (err) { console.error('❌ R2 avatar upload failed:', err.message); }
      if (r2Url) {
        avatarUrl = r2Url;
        console.log(`📸 [Register Complete] Avatar cached to R2: ${r2Url}`);
      }
    }

    const newUser = await db.saveStreamer({
      twitch_id: pending.twitchId || (pending.streamlabsPlatform === 'twitch' ? pending.streamlabsId : null),
      streamlabs_id: pending.streamlabsId || null,
      streamlabs_username: pending.streamlabsUsername || null,
      streamlabs_access_token: pending.streamlabs_access_token || null,
      streamlabs_refresh_token: pending.streamlabs_refresh_token || null,
      username: normalizedUsername,
      overlay_token: crypto.randomBytes(16).toString('hex'),
      is_active: 1,
      profile_image_value: avatarUrl,
      profile_image_source: avatarUrl ? (pending.streamlabsPlatform || (pending.streamlabsId ? 'streamlabs' : 'twitch')) : null,
      tos_accepted_at: new Date().toISOString(),
      primary_auth_provider: pending.streamlabsId ? 'streamlabs' : 'twitch'
    });
    
    console.log(`✅ [Register Complete] User created successfully: ${newUser.username} (ID: ${newUser.id})`);
    
    // Clear pending session and properly log user in via Passport
    delete req.session.pendingUser;
    
    req.login(newUser, (err) => {
      if (err) {
        console.error('❌ [Register Complete] Passport login error:', err);
        return res.status(500).json({ error: 'Failed to establish session' });
      }
      console.log(`🚀 [Register Complete] Session established for ${normalizedUsername}. Sending success response.`);
      db.logIpEvent('register', req.ip, normalizedUsername).catch(() => {});
      res.json({ success: true, username: normalizedUsername });
    });
  } catch (err) {
    console.error('💥 [Register Complete] CRITICAL ERROR during registration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/auth/twitch', authLimiter, (req, res, next) => {
  if (req.isAuthenticated() && req.user && req.user.username) {
    req.session.linkAccountUsername = req.user.username;
  }
  req.session.save((err) => {
    if (err) console.error('Session save error before Twitch OAuth:', err);
    passport.authenticate('twitch')(req, res, next);
  });
});

app.get('/auth/streamlabs', authLimiter, (req, res) => {
  const clientId = process.env.STREAMLABS_CLIENT_ID;
  const callbackUrl = process.env.STREAMLABS_CALLBACK_URL;
  const scope = process.env.STREAMLABS_SCOPE || '';
  const responseType = process.env.STREAMLABS_RESPONSE_TYPE || 'code';

  if (!clientId || !callbackUrl) {
    console.error('❌ Streamlabs OAuth configuration missing in .env');
    return res.status(500).send('Server Configuration Error: Missing Streamlabs Credentials');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.slOauthMode = req.query.mode === 'popup' ? 'popup' : 'full';

  let authUrl = `https://streamlabs.com/api/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${encodeURIComponent(scope).replace(/%20/g, '+')}&response_type=${responseType}&state=${state}`;

  console.log(`🚀 Redirecting to Streamlabs OAuth (state=${state.substring(0, 8)}..., mode=${req.session.slOauthMode})`);
  req.session.save((err) => {
    if (err) console.error('❌ Session save error before Streamlabs redirect:', err);
    res.redirect(authUrl);
  });
});

app.get('/auth/register/twitch', (req, res) => {
  if (req.session.pendingUser && req.session.pendingUser.twitchId) {
    return res.redirect('/register/setup');
  }
  res.redirect('/auth/twitch');
});

app.get('/auth/register/streamlabs', (req, res) => {
  if (req.session.pendingUser && req.session.pendingUser.streamlabsId) {
    return res.redirect('/register/setup');
  }
  res.redirect('/auth/streamlabs');
});



app.get('/auth/twitch/callback',
  // Capture linkAccountUsername BEFORE Passport regenerates the session (req.logIn → req.session.regenerate())
  (req, res, next) => {
    if (req.session && req.session.linkAccountUsername) {
      req._linkAccountUsername = req.session.linkAccountUsername;
    }
    next();
  },
  passport.authenticate('twitch', { failureRedirect: '/login-failed' }),
  async (req, res) => {
    const user = req.user;
    const twitchId = user.twitch_id || user.id;
    const twitchName = await getActualUsername(user);
  
    try {
      // === CONNECT INTENT — check BEFORE any ID lookup to prevent collision hijack ===
      if (req._linkAccountUsername) {
        const linkUsername = req._linkAccountUsername;
        delete req._linkAccountUsername;
        const linkUser = await db.getStreamer(linkUsername);
        if (linkUser) {
          const twitchOwner = await db.getStreamerByTwitchId(twitchId);
          if (twitchOwner && twitchOwner.id !== linkUser.id) {
            console.warn(`⚠️ [Twitch Link] Collision: hasTwitchId=true, linkUser=${linkUser.username}, conflict=true`);
            // Restore original session (passport.authenticate already swapped session to Twitch user)
            return req.login(linkUser, (loginErr) => {
              if (loginErr) console.error('❌ [Twitch Link] Session restore error:', loginErr);
              req.session.save(() => res.redirect(`/${linkUser.username}/dashboard?twitch_conflict=1`));
            });
          }
          console.log(`🔗 [Twitch Link] Linking Twitch platform to account: ${linkUser.username}`);
          await db.saveStreamer({ ...linkUser, twitch_id: twitchId });
          const updatedUser = await db.getStreamer(linkUser.username);
          return req.login(updatedUser, (loginErr) => {
            if (loginErr) console.error('❌ [Twitch Link] Session refresh error:', loginErr);
            req.session.save(() => res.redirect(`/${linkUser.username.toLowerCase()}/dashboard?twitch_linked=1`));
          });
        }
      }

      // === LOGIN FLOW ===
      // 1. Try finding by Twitch ID first
      let existingUser = await db.getStreamerByTwitchId(twitchId);

      // 2. If not found by ID, try finding by Username (existing accounts without twitch_id stored)
      if (!existingUser) {
        existingUser = await db.getStreamer(twitchName);
        if (existingUser) {
          console.log(`🔗 Linking existing account for ${twitchName}`);
          await db.saveStreamer({ ...existingUser, twitch_id: twitchId });
        }
      }

      if (existingUser) {
        if (Number(existingUser.is_active) === 0) {
          return res.redirect('/banned');
        }
        req.session.save((err) => {
          if (err) console.error('❌ Session save error during login:', err);
          return res.redirect(`/${existingUser.username.toLowerCase()}/dashboard`);
        });
      } else {
        req.session.pendingUser = {
          twitchId: twitchId,
          twitchName: twitchName,
          profileImage: user.profile_image_url || '/avatar.jpg'
        };
        req.session.save((err) => {
          if (err) console.error('❌ Session save error during registration:', err);
          return res.redirect('/register/setup');
        });
      }
    } catch (err) {
      console.error('Callback error:', err);
      res.redirect('/login-failed');
    }
  }
);

function extractPlatformFromStreamlabs(userData) {
  const PLATFORM_KEYS = ['twitch', 'youtube', 'tiktok', 'facebook', 'streamlabs'];

  // Format A: flat platform sub-objects (includes streamlabs key itself)
  const sl = userData.streamlabs;
  for (const key of PLATFORM_KEYS) {
    const p = userData[key];
    if (p && p.id) {
      return {
        platformId: String(p.id),
        platformType: key,
        platformName: p.display_name || p.name || p.username || p.title || null,
        platformImage: p.profile_image_url || p.thumbnail_url || p.icon_url || p.avatar || p.thumbnail || p.picture || p.logo || p.profile_picture || p.image
          || (sl && (sl.thumbnail || sl.profile_image_url || sl.avatar || sl.picture || sl.logo))
          || userData.profile_image
          || null
      };
    }
  }

  // Format B: nested `platforms` object
  if (userData.platforms && typeof userData.platforms === 'object') {
    for (const key of PLATFORM_KEYS) {
      const p = userData.platforms[key];
      if (p && p.id) {
        return {
          platformId: String(p.id),
          platformType: key,
          platformName: p.display_name || p.name || p.username || null,
          platformImage: p.profile_image_url || p.thumbnail_url || p.icon_url || p.avatar || p.thumbnail || p.picture || p.logo || null
        };
      }
    }
  }

  // Format C fallback: top-level or streamlabs sub-object
  return {
    platformId: (sl && sl.id) ? String(sl.id) : (userData.id ? String(userData.id) : null),
    platformType: 'streamlabs',
    platformName: (sl && (sl.display_name || sl.username)) || userData.username || null,
    platformImage: (sl && (sl.thumbnail || sl.profile_image_url || sl.avatar || sl.picture || sl.logo)) || userData.profile_image || null
  };
}

app.get('/auth/streamlabs/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  console.log('📥 [Streamlabs] Callback received — code:', code ? `${code.substring(0, 8)}...` : '(none)', 'state:', state ? `${state.substring(0, 8)}...` : '(none)', 'error:', error || '(none)');

  if (error) {
    console.error(`❌ Streamlabs returned error: ${error} - ${error_description || 'no description'}`);
    delete req.session.oauthState;
    return res.redirect('/login-failed');
  }

  if (!code) {
    console.error('❌ Streamlabs callback missing code');
    return res.redirect('/login-failed');
  }

  if (!state || !req.session.oauthState) {
    console.error('❌ Streamlabs CSRF state missing');
    delete req.session.oauthState;
    return res.redirect('/login-failed');
  }
  if (state !== req.session.oauthState) {
    console.error(`❌ Streamlabs CSRF state mismatch: session=${req.session.oauthState.substring(0,8)}... query=${state.substring(0,8)}...`);
    delete req.session.oauthState;
    return res.redirect('/login-failed');
  }

  delete req.session.oauthState;

  try {
    // 1. Exchange code for access_token (v1.0 uses form-encoded body)

    const payload = new URLSearchParams();
    payload.append('grant_type', 'authorization_code');
    payload.append('client_id', process.env.STREAMLABS_CLIENT_ID);
    payload.append('client_secret', process.env.STREAMLABS_CLIENT_SECRET);
    payload.append('redirect_uri', process.env.STREAMLABS_CALLBACK_URL);
    payload.append('code', code);

    const response = await axios.post('https://streamlabs.com/api/v2.0/token', payload.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const accessToken = response.data.access_token;
    const refreshToken = response.data.refresh_token;
    if (!accessToken) {
      console.error('❌ [Streamlabs] Token response missing access_token. Available keys:', Object.keys(response.data).join(', '));
      throw new Error('No access token received from Streamlabs');
    }

    console.log('✅ [Streamlabs] Token obtained successfully');

    // 2. Get user profile info using access_token
    const userResponse = await axios.get('https://streamlabs.com/api/v2.0/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const userData = userResponse.data;

    const platform = extractPlatformFromStreamlabs(userData);

    if (!platform.platformId) {
      console.error('❌ [Streamlabs] No platform ID. userData keys:', Object.keys(userData).join(', '));
      throw new Error('No identifiable platform ID from Streamlabs profile');
    }

    const streamlabsId = platform.platformId;
    const streamlabsPlatform = platform.platformType;
    const streamlabsName = platform.platformName || userData.username;
    const profileImage = platform.platformImage || userData.profile_image || '/avatar.jpg';

    // 3. DB Logic: Upsert / Linking
    
    // Check if there's an existing authenticated session (e.g. logged in via Twitch)
    if (req.isAuthenticated()) {
      const u = req.user;
      let existingUser = null;
      if (u.twitch_id) existingUser = await db.getStreamerByTwitchId(String(u.twitch_id));
      if (!existingUser && u.streamlabs_id) existingUser = await db.getStreamerByStreamlabsId(String(u.streamlabs_id));
      if (!existingUser && u.username) existingUser = await db.getStreamer(u.username);

      if (existingUser) {
        const slOwner = await db.getStreamerByStreamlabsId(streamlabsId);
        if (slOwner && slOwner.id !== existingUser.id) {
          console.warn(`⚠️ [Streamlabs] Collision: hasStreamlabsId=true, existingUser=${existingUser.username}, conflict=true`);
          const isPopup = req.session.slOauthMode === 'popup';
          delete req.session.slOauthMode;
          if (isPopup) {
            return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
              try{var bc=new BroadcastChannel('sl_oauth');bc.postMessage({type:'sl_conflict',success:false});bc.close();}catch(e){}
              window.close();
            </script></body></html>`);
          }
          return res.redirect(`/${existingUser.username.toLowerCase()}/dashboard?sl_conflict=1`);
        }
        // Symmetric guard: writing twitch_id must not collide with another row's twitch_id.
        // Prevents saveStreamer's getStreamerByTwitchId-first lookup from UPDATE-ing the wrong row.
        if (!existingUser.twitch_id && streamlabsPlatform === 'twitch') {
          const twOwner = await db.getStreamerByTwitchId(streamlabsId);
          if (twOwner && twOwner.id !== existingUser.id) {
            console.warn(`⚠️ [Streamlabs] twitch_id collision on link: existingUser=${existingUser.username}, conflict=true`);
            const isPopup = req.session.slOauthMode === 'popup';
            delete req.session.slOauthMode;
            if (isPopup) {
              return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
                try{var bc=new BroadcastChannel('sl_oauth');bc.postMessage({type:'sl_conflict',success:false});bc.close();}catch(e){}
                window.close();
              </script></body></html>`);
            }
            return res.redirect(`/${existingUser.username.toLowerCase()}/dashboard?sl_conflict=1`);
          }
        }
        console.log(`🔗 [Streamlabs] Linking platform=${streamlabsPlatform} to user ${existingUser.username}`);
        const linkedUser = await db.saveStreamer({
          ...existingUser,
          twitch_id: existingUser.twitch_id || (streamlabsPlatform === 'twitch' ? streamlabsId : null),
          streamlabs_id: streamlabsId,
          streamlabs_username: streamlabsName,
          streamlabs_access_token: accessToken,
          streamlabs_refresh_token: refreshToken
        });
        const isPopup = req.session.slOauthMode === 'popup';
        delete req.session.slOauthMode;
        req.login(linkedUser, (loginErr) => {
          if (loginErr) console.error('❌ [Streamlabs] Session refresh error after link:', loginErr);
          req.session.save(() => {
            if (isPopup) {
              return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
                try{var bc=new BroadcastChannel('sl_oauth');bc.postMessage({type:'sl_linked',success:true});bc.close();}catch(e){}
                window.close();
              </script></body></html>`);
            }
            const dest = `/${existingUser.username.toLowerCase()}/dashboard`;
            res.redirect(dest);
          });
        });
        return;
      }
    }

    // Check if user exists — try platform-native ID first
    let existingUser = null;
    if (streamlabsPlatform === 'twitch') {
      existingUser = await db.getStreamerByStreamlabsId(streamlabsId);
      if (!existingUser) {
        existingUser = await db.getStreamerByTwitchId(streamlabsId);
      }
    } else {
      existingUser = await db.getStreamerByStreamlabsId(streamlabsId);
    }

    if (existingUser) {
      console.log(`✅ [Streamlabs] Returning user ${existingUser.username}. Updating tokens...`);
      await db.saveStreamer({
        ...existingUser,
        streamlabs_access_token: accessToken,
        streamlabs_refresh_token: refreshToken,
        ...((!existingUser.profile_image_value || existingUser.profile_image_value === '/avatar.jpg') && profileImage && profileImage !== '/avatar.jpg'
          ? { profile_image_value: profileImage, profile_image_source: streamlabsPlatform }
          : {}
        )
      });

      // Re-cache avatar to R2 if still pointing to external CDN (fire-and-forget — never blocks OAuth)
      // Guard: never touch a user's custom-uploaded image or an already-cached R2 image.
      const imageToCache = profileImage || existingUser.profile_image_value;
      const r2Base = process.env.R2_PUBLIC_URL || '';
      const existingVal = existingUser.profile_image_value || '';
      const isCustomOrCached = existingUser.profile_image_source === 'custom' || (r2Base && existingVal.startsWith(r2Base));
      if (!isCustomOrCached && r2Base && imageToCache && imageToCache.startsWith('http') && !imageToCache.startsWith(r2Base)) {
        const stableId = existingUser.twitch_id || existingUser.streamlabs_id || existingUser.id;
        (async () => {
          try {
            const resp = await axios.get(imageToCache, { responseType: 'arraybuffer', timeout: 10000 });
            const ct = resp.headers['content-type'] || 'image/jpeg';
            const ext = ct.includes('webp') ? 'webp' : ct.includes('png') ? 'png' : 'jpg';
            const r2Url = await uploadBufferToR2(Buffer.from(resp.data), `avatars/twitch_${stableId}.${ext}`, ct);
            if (r2Url) {
              await db.saveStreamer({ ...existingUser, profile_image_value: r2Url, profile_image_source: streamlabsPlatform });
              console.log(`📸 [Streamlabs] Avatar re-cached to R2 for ${existingUser.username}: ${r2Url}`);
            }
          } catch (err) { console.error('❌ [Streamlabs] R2 avatar re-cache failed:', err.message); }
        })();
      }

      // Create a session for this user
      if (Number(existingUser.is_active) === 0) {
        return res.redirect('/banned');
      }
      req.login(existingUser, (err) => {
        if (err) {
          console.error('❌ [Streamlabs] Login error:', err);
          return res.redirect('/login-failed');
        }
        req.session.save(() => {
          console.log('✅ [Streamlabs] Session saved, redirecting to dashboard');
          return res.redirect(`/${existingUser.username.toLowerCase()}/dashboard`);
        });
      });
    } else {
      // 4. New User Flow: Store in session and send to registration setup
      console.log(`🆕 [Streamlabs] New user via ${streamlabsPlatform}. Storing in session...`);
       req.session.pendingUser = {
         streamlabsId: streamlabsId,
         streamlabsPlatform: streamlabsPlatform,
         streamlabsUsername: streamlabsName,
         streamlabsName: streamlabsName,
         profileImage: profileImage,
         streamlabs_access_token: accessToken,
         streamlabs_refresh_token: refreshToken
       };
      
      req.session.save((err) => {
        if (err) {
          console.error('❌ [Streamlabs] Session save error:', err);
          return res.redirect('/login-failed');
        }
        console.log('✅ [Streamlabs] Session saved, redirecting to /register');
        return res.redirect('/register/setup');
      });
    }

  } catch (err) {
    console.error('💥 [Streamlabs] Callback Error:', err.message);
    if (err.stack) console.error('💥 [Streamlabs] Error type:', err.code || err.constructor.name);
    if (err.response) {
      console.error('💥 [Streamlabs] Response status:', err.response.status);
      // Do NOT log err.response.data — it may contain access_token or other secrets.
    }
    res.redirect('/login-failed');
  }
});

app.get('/login-failed', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/auth/login-failed.html'));
});

app.get('/thank-you', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/donate-template/thank-you.html'));
});

app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/privacy.html'));
});

app.get('/terms-of-services.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/terms-of-services.html'));
});

app.get('/goal-bar', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/goal-bar/index.html'));
});

app.get('/timer', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/timer/index.html'));
});

app.get('/leader-board', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/leader-board/index.html'));
});

app.get('/recent-donate', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/recent-donate/index.html'));
});

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay/index.html'));
});

app.get('/alert-test', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/alert-test.html'));
});

app.get('/forbidden', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/auth/forbidden.html'));
});

app.get('/banned', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pages/auth/banned.html'));
});

app.get('/admin', adminMonitorLimiter, async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/login');
  if (ADMIN_TWITCH_ID && String(req.user.twitch_id) === ADMIN_TWITCH_ID) {
    return res.sendFile(path.join(__dirname, '../public/admin/index.html'));
  }
  try {
    const streamer = await getStreamerForUser(req.user);
    if (streamer) return res.redirect(`/${streamer.username.toLowerCase()}/dashboard`);
  } catch (err) {
    console.error('Admin route error:', err);
  }
  res.redirect('/login');
});

app.get('/admin/overlays', adminMonitorLimiter, ensureAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/overlays.html'));
});

app.get('/admin/users', adminMonitorLimiter, ensureAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/users.html'));
});

app.get('/admin/stats', adminMonitorLimiter, ensureAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/stats.html'));
});

app.get('/admin/security', adminMonitorLimiter, ensureAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/security.html'));
});

app.get('/api/admin/active-overlays', adminMonitorLimiter, ensureAdmin, (req, res) => {
  const now = Date.now();
  const byUsername = {};
  for (const c of sseClients) {
    const isOverlay = c.source === 'overlay'  && c.authMethod === 'token';
    const isGoalBar = c.source === 'goal-bar' && c.authMethod === 'token';
    const isTimer   = c.source === 'timer'    && c.authMethod === 'token';
    if (!isOverlay && !isGoalBar && !isTimer) continue;
    if (!byUsername[c.username]) {
      byUsername[c.username] = { username: c.username, overlayConns: 0, goalBarConns: 0, timerConns: 0, lastActivity: 0 };
    }
    if (isOverlay) byUsername[c.username].overlayConns++;
    if (isGoalBar) byUsername[c.username].goalBarConns++;
    if (isTimer)   byUsername[c.username].timerConns++;
    if (c.lastActivity > byUsername[c.username].lastActivity) {
      byUsername[c.username].lastActivity = c.lastActivity;
    }
  }
  const active = Object.values(byUsername)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map(u => ({
      username:    u.username,
      connections: u.overlayConns,
      hasGoalBar:  u.goalBarConns > 0,
      hasTimer:    u.timerConns > 0,
      lastSeenSec: Math.round((now - u.lastActivity) / 1000),
    }));
  const activeCount  = active.filter(u => u.connections > 0).length;
  const goalBarCount = active.filter(u => u.hasGoalBar).length;
  const timerCount   = active.filter(u => u.hasTimer).length;
  res.json({ activeCount, goalBarCount, timerCount, sseTotal: sseClients.length, active, ts: now });
});

app.get('/api/admin/stats', adminMonitorLimiter, ensureAdmin, async (req, res) => {
  try {
    const [userStats, txStats] = await Promise.all([
      db.getAdminUserStats(),
      db.getAdminTxStats(),
    ]);
    const sseTotal     = sseClients.length;
    const overlayCount = sseClients.filter(c => c.source === 'overlay'  && c.authMethod === 'token').length;
    const goalBarCount = sseClients.filter(c => c.source === 'goal-bar' && c.authMethod === 'token').length;
    const timerCount   = sseClients.filter(c => c.source === 'timer'    && c.authMethod === 'token').length;
    res.json({ users: userStats, transactions: txStats, sse: { total: sseTotal, overlays: overlayCount, goalBars: goalBarCount, timers: timerCount } });
  } catch (err) {
    res.status(500).json({ error: 'Stats query failed' });
  }
});

app.get('/api/admin/users', adminMonitorLimiter, ensureAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const q = (req.query.q || '').trim().toLowerCase();
    const filter = req.query.filter || 'all';
    const sort = (req.query.sort || 'registered').trim().toLowerCase();
    const order = (req.query.order || 'desc').trim().toLowerCase();
    const users = await db.getAdminUsers({ page, q, filter, sort, order });
    users.users = users.users.map(u => ({
      ...u,
      hasBetaBadge: !!db.parseBadges(u.badges).beta_tester
    }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Users query failed' });
  }
});

app.get('/api/admin/ip-events', adminMonitorLimiter, ensureAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    const type = req.query.type || 'all';
    const events = await db.getAdminIpEvents({ limit, type });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'IP events query failed' });
  }
});

// POST /api/admin/badges — manual badge assign/revoke (admin only)
app.post('/api/admin/badges', adminMonitorLimiter, ensureAdmin, csrfProtection, async (req, res) => {
  try {
    const { username, badge, action } = req.body; // action: 'assign' | 'revoke'
    const ALLOWED_MANUAL_BADGES = ['beta_tester'];
    if (!username || !badge || !ALLOWED_MANUAL_BADGES.includes(badge)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'User not found' });

    const badges = db.parseBadges(streamer.badges);
    if (action === 'assign') {
      badges[badge] = true;
    } else if (action === 'revoke') {
      delete badges[badge];
    } else {
      return res.status(400).json({ error: 'Invalid action. Use "assign" or "revoke".' });
    }

    await db.saveStreamer({ ...streamer, badges: JSON.stringify(badges) });
    console.log(`🛡️ Admin: ${action}ed badge '${badge}' for ${username}`);
    res.json({ success: true, badges });
  } catch (err) {
    console.error('Admin badge assign error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve minified dashboard assets when a built .min sibling exists (prod, `npm run build`).
// Dev has no .min files → falls through to source, so live edits still show up on refresh.
const MIN_MAP = {};
for (const p of ['/dashboard/dashboard.js', '/dashboard/admin.css']) {
  const minPath = p.replace(/\.(js|css)$/, '.min.$1');
  if (fs.existsSync(path.join(__dirname, '../public', minPath))) MIN_MAP[p] = minPath;
}
app.use((req, res, next) => {
  const min = MIN_MAP[req.path];
  if (min) req.url = min + req.url.slice(req.path.length); // keep original ?v= query
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// API: สร้าง Donation (Payment Link)
app.post('/api/create-charge', createChargeLimiter, async (req, res) => {
  try {
    const { amount, name, message, username, timerAction, tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
    if (!username) return res.status(400).json({ error: 'ไม่ระบุชื่อผู้รับบริจาค' });

    const streamer = await db.getDecryptedStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้รับบริจาคในระบบ' });
    if (Number(streamer.is_active) === 0) return res.status(404).json({ error: 'ไม่พบผู้รับบริจาคในระบบ' });

    const tierAssignment = computeTierAssignment(streamer, amount, { tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const redirectUrl = `${protocol}://${host}/thank-you?username=${username}`;
    
    const charge = await beam.createPaymentLink({
      merchantId: streamer.beam_merchant_id,
      apiKey: streamer.beam_api_key,
      amount: Math.round(amount * 100),
      currency: 'THB',
      description: message || `Donation from ${name || 'Anonymous'}`,
      referenceId: `donate-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      redirectUrl: redirectUrl
    });
    await logTransaction({
      id: charge.paymentLinkId || charge.id,
      amount: amount,
      donor: name || 'Anonymous',
      message: message,
      status: 'pending',
      paymentUrl: charge.url,
      raw_response: charge,
      streamer_username: username,
      timer_action: sanitizeTimerAction(timerAction),
      ...tierAssignment
    });
    res.json({ success: true, paymentUrl: charge.url });
  } catch (error) {
    console.error('❌ Create payment link failed!', error.message);
    res.status(500).json({ error: 'ไม่สามารถสร้างรายการบริจาคได้' });
  }
});

app.get('/api/charge/:id', async (req, res) => {
  try {
    const tx = await db.getTransactionById(req.params.id);
    if (!tx || !tx.streamer_username) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลธุรกรรม หรือไม่ทราบผู้รับ' });
    }

    const streamer = await db.getDecryptedStreamer(tx.streamer_username);
    if (!streamer) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลผู้รับบริจาค' });
    }

    const charge = await beam.getCharge(streamer.beam_merchant_id, streamer.beam_api_key, req.params.id);
    res.json({ id: charge.id, status: charge.status, amount: charge.amount / 100, paid: charge.status === 'successful' });
  } catch (error) {
    res.status(500).json({ error: 'ไม่สามารถเช็คสถานะได้' });
  }
});

app.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    const signature = req.headers['x-beam-signature'];
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('❌ CRITICAL ERROR: WEBHOOK_SECRET is not configured');
      return res.status(500).json({ error: 'Internal Server Error: Webhook secret not configured' });
    }
    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' });
    }
    const secretBuffer = Buffer.from(webhookSecret, 'base64');
    const hmac = crypto.createHmac('sha256', secretBuffer);
    const digest = hmac.update(req.rawBody).digest('base64');
    if (signature !== digest) return res.status(401).json({ error: 'Invalid signature' });
    const event = req.body;
    const eventType = req.headers['x-beam-event'] || event.type;
    if (eventType === 'charge.completed' || eventType === 'charge.succeeded' || event.status === 'SUCCEEDED') {
      const charge = event;
      const amount = charge.amount ? (charge.amount / 100) : 0;
      const chargeId = charge.chargeId || charge.id;
      const paymentLinkId = charge.sourceId;
      let tx = null;
      if (paymentLinkId) tx = await db.getTransactionById(paymentLinkId);
      if (!tx && chargeId) tx = await db.getTransactionById(chargeId);
      const targetId = tx ? tx.id : (paymentLinkId || chargeId);
      await confirmDonationSideEffects(targetId, { amount: amount || (tx ? tx.amount : 0), rawWebhook: event });
    }
    res.json({ received: true });
  } catch (error) {
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

const RESERVED_WORDS = [
  'login', 'auth', 'api', 'overlay', 'alert-test', 'thank-you', 'register',
  'admin', 'demo', 'health', 'goal-bar', 'timer', 'leader-board', 'recent-donate', 'webhook', 'login-failed', 'forbidden',
  'privacy', 'terms-of-services', 'mobile-slip',
];

async function validateUsername(req, res, next) {
  const { username } = req.params;
  if (RESERVED_WORDS.includes(req.path.split('/')[1])) return next();
  try {
    const user = await db.getStreamer(username);
    if (user && Number(user.is_active) === 0) {
      return res.status(404).sendFile(path.join(__dirname, '../public/pages/not-found.html'));
    }
    if (user) {
      req.streamer = user;
      next();
    } else {
      res.status(404).sendFile(path.join(__dirname, '../public/pages/not-found.html'));
    }
  } catch (err) {
    res.status(500).send('เกิดข้อผิดพลาดในการตรวจสอบผู้ใช้งาน');
  }
}

async function ensureUserOwner(req, res, next) {
  if (req.isAuthenticated()) {
    const { username } = req.params;
    try {
      const streamer = await getStreamerForUser(req.user);
      if (streamer && streamer.username.toLowerCase() === username.toLowerCase()) {
        return next();
      }
    } catch (err) {
      console.error('Ownership check error:', err);
    }
    return res.redirect('/forbidden?reason=owner');
  }
  res.redirect('/login');
}

function ensureAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  if (!ADMIN_TWITCH_ID || String(req.user.twitch_id) !== ADMIN_TWITCH_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

app.get('/api/alerts/stream', async (req, res) => {
  const token = req.query.token;
  const source = req.query.source || 'unknown';
  let authenticatedUser = null;
  let authMethod = null;

  if (token) {
    // Check memory cache first (avoids DB latency from remote Turso)
    const cached = tokenCache.get(token);
    if (cached && (Date.now() - cached.cachedAt) < TOKEN_CACHE_TTL) {
      authenticatedUser = cached.username;
      authMethod = 'token';
    } else {
      try {
        const streamer = await db.getStreamerByToken(token);
        if (streamer && Number(streamer.is_active) === 0) {
          // ponytail: accept TTL delay for cached tokens — banned user blocked on next cache miss (Known Limitation §0.2)
          console.warn(`⚠️ SSE: token rejected (banned) for prefix: ${token.substring(0, 8)}...`);
        } else if (streamer) {
          authenticatedUser = streamer.username;
          authMethod = 'token';
          // Cache for future lookups
          tokenCache.set(token, { username: streamer.username, cachedAt: Date.now() });
        } else {
          console.warn(`⚠️ SSE: token lookup returned null for prefix: ${token.substring(0, 8)}...`);
        }
      } catch (err) {
        console.error('❌ SSE: token lookup error:', err.message);
      }
    }
  }
  
  // Fallback to session auth only if token auth completely failed
  if (!authenticatedUser && req.isAuthenticated()) {
    authenticatedUser = await getActualUsername(req.user);
    authMethod = 'session';
  }

  if (sseClients.length >= MAX_SSE_CLIENTS) {
    res.status(503).json({ error: 'Too many concurrent overlay connections' });
    return;
  }

  const isValidToken = authMethod === 'token';
  const now = Date.now();
  
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: `Overlay connected as ${authenticatedUser || 'Unknown'}` })}\n\n`);
  
  const clientObj = { res, validated: isValidToken, username: authenticatedUser, authMethod: authMethod, lastActivity: now, source };
  sseClients.push(clientObj);

  // Push current snapshot immediately — leaderboard/recent-donate aren't stored settings, they're live queries
  if (authenticatedUser && source === 'leader-board') {
    resolveLeaderboardEntries(authenticatedUser, 5).then(entries => {
      try { res.write(`data: ${JSON.stringify({ type: 'leaderboard_update', entries: entries.map((e, i) => ({ rank: i + 1, donor: e.donor, total_amount: e.total_amount, donation_count: e.donation_count })) })}\n\n`); } catch {}
    }).catch(() => {});
  }
  if (authenticatedUser && source === 'recent-donate') {
    resolveRecentDonateEntries(authenticatedUser, 5).then(entries => {
      try { res.write(`data: ${JSON.stringify({ type: 'recentdonate_update', entries: entries.map(e => ({ donor: e.donor, amount: e.amount, message: e.message, paidAt: e.paidAt, payment_method: e.payment_method })) })}\n\n`); } catch {}
    }).catch(() => {});
  }

  // Notify donate-monitor clients of widget state change (overlay/timer only — dona-monitor itself excluded)
  if (isValidToken && authenticatedUser && (source === 'overlay' || source === 'timer')) {
    broadcastWidgetStatus(authenticatedUser);
  }
  
  // Clear any pending disconnect log for this user (quick reconnect < 5s)
  const wasReconnecting = disconnectTimers.has(authenticatedUser);
  const pendingTimer = disconnectTimers.get(authenticatedUser);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    disconnectTimers.delete(authenticatedUser);
  }
  // Log only first connection — suppress refresh/reconnect noise
  if (!wasReconnecting) {
    console.log(`✅ SSE client connected: ${authenticatedUser || 'anonymous'} (auth: ${authMethod})`);
  }
   
  const keepAlive = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
      clientObj.lastActivity = Date.now();
    } catch (e) { /* connection lost */ }
  }, 30000);
   
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(client => client.res !== res);

    // Notify donate-monitor clients of widget state change (overlay/timer only)
    if (isValidToken && authenticatedUser && (source === 'overlay' || source === 'timer')) {
      broadcastWidgetStatus(authenticatedUser);
    }

    const stillConnected = sseClients.some(c => c.username === authenticatedUser);
    if (!stillConnected && authenticatedUser) {
      // Wait 5s before logging — skip if reconnects quickly
      const timer = setTimeout(() => {
        disconnectTimers.delete(authenticatedUser);
        console.log(`🔌 SSE client disconnected: ${authenticatedUser}`);
      }, 5000);
      disconnectTimers.set(authenticatedUser, timer);
    }
  });
});

app.get('/api/overlay/status', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    
    const isActive = sseClients.some(client => client.username === actualUsername && client.authMethod === 'token' && client.source === 'overlay');
    res.json({ active: isActive });
  } catch (err) {
    console.error('Get overlay status error:', err);
    res.status(500).json({ error: 'ไม่สามารถตรวจสอบสถานะได้' });
  }
});

// Public overlay status (for donate page — no login required)
app.get('/api/overlay/status/:username', async (req, res) => {
  try {
    const { username } = req.params;
    if (!username) return res.status(400).json({ active: false, error: 'missing username' });
    const isActive = sseClients.some(client =>
      client.username === username.toLowerCase() && client.authMethod === 'token' && client.source === 'overlay'
    );
    res.json({ active: isActive });
  } catch (err) {
    res.status(500).json({ active: false, error: 'server error' });
  }
});

// Public widget status SSE (donate page) — pushes overlayActive + timerActive in real-time
app.get('/api/widget/status/stream', widgetStatusLimiter, async (req, res) => {
  const username = (req.query.username || '').toLowerCase();
  if (!username) return res.status(400).json({ error: 'missing username' });
  if (sseClients.length >= MAX_SSE_CLIENTS) return res.status(503).json({ error: 'Too many concurrent connections' });

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
  const clientObj = { res, validated: false, username, authMethod: 'public', lastActivity: Date.now(), source: 'dona-monitor' };
  sseClients.push(clientObj);

  // Send current state immediately
  broadcastWidgetStatus(username);

  const keepAlive = setInterval(() => {
    try { res.write(`: keep-alive\n\n`); clientObj.lastActivity = Date.now(); }
    catch { /* connection lost */ }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(client => client.res !== res);
  });
});

// CSV formula-injection guard — donor/message are donor-controlled free text; Excel/Sheets
// treats a leading =+-@ (or tab/CR) as a formula. Prefix with ' to force text interpretation.
function csvSafeField(value) {
  const s = String(value ?? '');
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return guarded.replace(/"/g, '""');
}

app.get('/api/transactions/:username/download', ensureAuthenticated, async (req, res) => {
  try {
    const { username } = req.params;
    const actualUsername = await getActualUsername(req.user);

    if (actualUsername !== username.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden: คุณไม่มีสิทธิ์เข้าถึงข้อมูลของผู้อื่น' });
    }

    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'กรุณาระบุวันที่เริ่มต้นและสิ้นสุด (from, to)' });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
    }

    const toDateEnd = new Date(toDate);
    toDateEnd.setHours(23, 59, 59, 999);

    const txs = await db.getTransactionsByDateRange(username, fromDate.toISOString(), toDateEnd.toISOString());

    const BOM = '\uFEFF';
    const headers = ['วัน-เวลา', 'Reference ID', 'ผู้บริจาค', 'จำนวนเงิน (บาท)', 'ข้อความ', 'สถานะ', 'วิธีชำระเงิน'];
    const rows = txs.map(t => [
      t.createdAt ? new Date(t.createdAt).toLocaleString('th-TH') : '-',
      t.id || '-',
      csvSafeField(t.donor || 'Anonymous'),
      Number(t.amount) || 0,
      csvSafeField(t.message || ''),
      t.status || '-',
      t.payment_method || '-'
    ]);

    const csvLines = [headers.join(',')];
    rows.forEach(row => {
      csvLines.push(row.map(cell => `"${cell}"`).join(','));
    });

    const csvContent = BOM + csvLines.join('\n');
    const filename = `tipkub-donations-${username}-${fromDate.toISOString().slice(0, 10)}-${toDate.toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Download transactions error:', err);
    res.status(500).json({ error: 'ไม่สามารถดาวน์โหลดข้อมูลได้' });
  }
});

app.get('/api/leaderboard-alltime/:username', ensureAuthenticated, async (req, res) => {
  const { username } = req.params;
  const actualUsername = await getActualUsername(req.user);
  if (actualUsername !== username.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: คุณไม่มีสิทธิ์เข้าถึงข้อมูลของผู้อื่น' });
  }
  try {
    const rows = await db.getLeaderboardAlltime(actualUsername, 500);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

app.get('/api/transactions/:username', ensureAuthenticated, async (req, res) => {
  const { username } = req.params;
  const actualUsername = await getActualUsername(req.user);
  
  if (actualUsername !== username.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: คุณไม่มีสิทธิ์เข้าถึงข้อมูลของผู้อื่น' });
  }
  
  try {
    await cleanupExpiredTransactionsWithR2();
    const txs = await db.getTransactions(username);
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

function checkCronAuth(req, res, next) {
  const token = req.query.token || (req.body && req.body.token);
  if (token && process.env.CRON_SECRET) {
    const a = Buffer.from(token);
    const b = Buffer.from(process.env.CRON_SECRET);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
}

app.post('/api/cron/cleanup-expired', checkCronAuth, async (req, res) => {
  try {
    const expiredCount = await cleanupExpiredTransactionsWithR2();
    const deletedCount = await hardDeleteExpiredTransactionsWithR2();
    const ipDeleted = await db.cleanupOldIpEvents(90);

    const today = new Date().toISOString().slice(0, 10);
    const webhookStreamers = await db.getStreamersWithWebhookEnabled();
    let webhookDisabledCount = 0;
    for (const s of webhookStreamers) {
      if (s.truemoney_webhook_expiry && s.truemoney_webhook_expiry < today) {
        await db.saveStreamer({
          twitch_id: s.twitch_id || null,
          streamlabs_id: s.streamlabs_id || null,
          username: s.username,
          truemoney_webhook_enabled: 0
        });
        webhookDisabledCount++;
      }
    }
    const processedDeleted = await db.cleanupProcessedWebhooks(90);

    res.json({
      success: true,
      expired: expiredCount,
      deleted: deletedCount,
      ip_events_deleted: ipDeleted,
      webhook_disabled: webhookDisabledCount,
      processed_webhooks_deleted: processedDeleted
    });
  } catch (err) {
    console.error('Cron cleanup-expired error:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

app.post('/api/cron/cleanup-quarterly', checkCronAuth, async (req, res) => {
  try {
    const months = parseInt(req.body?.months, 10) || 6;
    const count = await db.hardDeleteOldTransactions(months);
    res.json({ success: true, deleted: count, months });
  } catch (err) {
    console.error('Cron cleanup-quarterly error:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

app.post('/api/cron/cleanup-r2-orphans', checkCronAuth, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === 'true';
    const GRACE_MS = 60 * 60 * 1000;
    const r2PublicUrl = process.env.R2_PUBLIC_URL;

    if (!r2PublicUrl || !process.env.R2_BUCKET_NAME) {
      return res.status(500).json({ error: 'R2 not configured' });
    }

    const [allObjects, dbRefs] = await Promise.all([
      listAllR2Objects(),
      db.getAllR2Refs(r2PublicUrl),
    ]);

    const now = Date.now();
    const orphans = [];
    const skipped = [];

    for (const obj of allObjects) {
      if (now - new Date(obj.lastModified).getTime() < GRACE_MS) { skipped.push(obj.key); continue; }
      const fullUrl = `${r2PublicUrl}/${obj.key}`;
      if (dbRefs.has(fullUrl)) continue;
      orphans.push(obj.key);
    }

    let deleted = 0;
    if (!dryRun) {
      for (const key of orphans) {
        try {
          await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
          deleted++;
        } catch (err) {
          console.error('[R2 cleanup] delete failed:', key, err.message);
        }
      }
    }

    const referenced = allObjects
      .filter(o => !skipped.includes(o.key) && !orphans.includes(o.key))
      .map(o => o.key);
    console.log(`[R2 cleanup] scanned=${allObjects.length} orphans=${orphans.length} deleted=${deleted} dryRun=${dryRun}`);
    res.json({ scanned: allObjects.length, orphans: orphans.length, deleted, skipped: skipped.length, dryRun,
      ...(req.query.verbose === 'true' && { orphanKeys: orphans, skippedKeys: skipped, referencedKeys: referenced }) });
  } catch (err) {
    console.error('Cron cleanup-r2-orphans error:', err);
    res.status(500).json({ error: 'R2 cleanup failed' });
  }
});

app.post('/api/transactions/:id/status', ensureAuthenticated, csrfProtection, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['pending', 'successful', 'failed'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });

  try {
    const tx = await db.getTransactionById(id);
    if (!tx) return res.status(404).json({ error: 'ไม่พบธุรกรรม' });

    // Authorization check: Ensure the authenticated user is the owner of this transaction
    const actualUsername = await getActualUsername(req.user);
    if (actualUsername !== tx.streamer_username) {
      return res.status(403).json({ error: 'Forbidden: คุณไม่มีสิทธิ์จัดการธุรกรรมนี้' });
    }

    let updatedTx;
    if (status === 'successful') {
      updatedTx = await confirmDonationSideEffects(id, { amount: tx.amount, extraAlert: { isManualTrigger: true } });
    } else {
      updatedTx = await db.saveTransaction({ ...tx, id, status });
    }
    res.json({ success: true, transaction: updatedTx });
  } catch (err) {
    console.error('Error updating transaction status:', err);
    res.status(500).json({ error: 'ไม่สามารถอัปเดตสถานะได้' });
  }
});

app.get('/api/user/me', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    const streamer = await db.getStreamer(actualUsername);
    if (!streamer) return res.status(404).json({ error: 'User not found in database' });

    const profileImage = await db.resolveProfileImage(streamer);

    // Auto-assign membership badges + dev badge (identity check เดียวกับ ensureAdmin)
    let updatedBadges = db.computeMemberBadges(streamer);
    const isAdmin = ADMIN_TWITCH_ID && String(req.user.twitch_id) === ADMIN_TWITCH_ID;
    {
      const b = db.parseBadges(updatedBadges);
      if (isAdmin && !b.dev) { b.dev = true; updatedBadges = JSON.stringify(b); }
      if (!isAdmin && b.dev) { delete b.dev; updatedBadges = JSON.stringify(b); } // revoke stale dev
    }
    if (updatedBadges !== (streamer.badges || '{}')) {
      await db.saveStreamer({ ...streamer, badges: updatedBadges });
      streamer.badges = updatedBadges;
    }

    const badges = db.parseBadges(streamer.badges);
    const memberSince = streamer.tos_accepted_at || null;

    res.json({
      username: streamer.username,
      twitchId: streamer.twitch_id,
      streamlabsId: streamer.streamlabs_id,
      authProvider: determinePrimaryAuth(streamer),
      email: req.user.email || 'Not provided',
      slipok_connected: !!streamer.slipok_connected,
      truemoney_slipok_connected: !!streamer.truemoney_slipok_connected,
      slipokApiConfigured: !!(streamer.slipok_api || streamer.truemoney_slipok_api),
      profileImage,
      profileGlowColor: streamer.profile_glow_color || '#005704',
      badges,
      memberSince,
      badgeDisplay: db.resolveBadgeDisplay(streamer)
    });
  } catch (err) {
    console.error('Get user info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const disconnectConnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('⚠️ [Disconnect] Rate limit hit IP:', req.ip);
    res.status(429).json({ error: 'Too many disconnect attempts', code: 'RATE_LIMITED' });
  }
});

app.post('/api/connections/disconnect', ensureAuthenticated, csrfProtection, disconnectConnLimiter, async (req, res) => {
  try {
    const { platform } = req.body;
    if (!platform || !['twitch', 'streamlabs'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform. Use "twitch" or "streamlabs".' });
    }

    const actualUsername = await getActualUsername(req.user);
    const streamer = await db.getStreamer(actualUsername);
    if (!streamer) return res.status(404).json({ error: 'User not found' });

    const primaryAuth = determinePrimaryAuth(streamer);
    if (primaryAuth === platform) {
      return res.status(403).json({
        error: 'ไม่สามารถยกเลิกการเชื่อมต่อบัญชีหลักได้',
        code: 'PRIMARY_ACCOUNT'
      });
    }

    if (streamer.twitch_id && streamer.streamlabs_id && streamer.twitch_id === streamer.streamlabs_id) {
      return res.status(403).json({
        error: 'ไม่สามารถยกเลิกการเชื่อมต่อได้ เนื่องจาก Twitch และ Streamlabs ใช้บัญชีเดียวกัน',
        code: 'SAME_ACCOUNT_LINKED'
      });
    }

    const currentId = platform === 'twitch' ? streamer.twitch_id : streamer.streamlabs_id;
    if (!currentId) {
      return res.status(400).json({ error: `ไม่ได้เชื่อมต่อ ${platform} อยู่แล้ว`, code: 'NOT_CONNECTED' });
    }

    await db.disconnectPlatform(streamer.id, platform);

    console.log(`🔌 [Disconnect] User ${actualUsername} disconnected ${platform}`);

    res.json({ success: true, platform, message: `ยกเลิกการเชื่อมต่อ ${platform} สำเร็จ` });
  } catch (err) {
    console.error('❌ [Disconnect] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', sameOriginCheck, (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Failed to log out' });
    }
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destroy error:', err);
        return res.status(500).json({ error: 'Failed to destroy session' });
      }
      res.clearCookie('sessionId');
      res.json({ success: true });
    });
  });
});

app.delete('/api/user/delete', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    // Verify ownership one last time
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'User not found' });
    
    console.log(`🗑️ [User Delete] Deleting user: ${streamer.username} (ID: ${streamer.id})`);
    
    // Delete from streamers table
    await db.deleteStreamer(streamer.id);
    
    // Destroy session
    req.logout((err) => {
      if (err) console.error('Logout error during deletion:', err);
      req.session.destroy((sErr) => {
        if (sErr) console.error('Session destroy error during deletion:', sErr);
        res.clearCookie('sessionId');
        res.json({ success: true, message: 'Account deleted successfully' });
      });
    });
  } catch (err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/overlay/settings', async (req, res) => {
  try {
    let username = null;
  
    if (req.isAuthenticated()) {

      username = await getActualUsername(req.user);
    } else {
      const token = req.query.token;
      if (token) {
        const streamer = await db.getStreamerByToken(token);
        if (streamer && Number(streamer.is_active) !== 0) {
          username = streamer.username;
        }
      }
    }
 
    if (!username) {
      return res.status(401).json({ error: 'Unauthorized: Please log in or provide a valid token' });
    }
 
    const settings = await db.getSettings(username, defaultSettings);
    try {
      const recent = await db.getRecentDonations(username, 1);
      settings.goal_last_donor = (recent && recent[0] && recent[0].donor) || '';
      settings.goal_last_amount = (recent && recent[0] && recent[0].amount) || 0;
    } catch (e) {
      console.error('[OverlaySettings] getRecentDonations failed:', e.message);
      settings.goal_last_donor = '';
      settings.goal_last_amount = 0;
    }
    res.json(settings);
  } catch (err) {
    console.error('Get settings error:', err);
    
    if (err.message && (err.message.includes('502') || err.message.includes('SERVER_ERROR'))) {
      return res.status(502).json({ 
        error: 'ระบบฐานข้อมูลขัดข้องชั่วคราว', 
        details: 'เซิร์ฟเวอร์ไม่ตอบสนอง กรุณาลองใหม่อีกครั้ง' 
      });
    }
    
    res.status(500).json({ error: 'ไม่สามารถดึงการตั้งค่าได้' });
  }
});

function filterAllowedFields(body, allowedFields) {
  const safe = {};
  for (const key of allowedFields) {
    if (body[key] !== undefined) safe[key] = body[key];
  }
  return safe;
}

const OVERLAY_ALLOWED_FIELDS = [
  'theme', 'animation', 'fontFamily', 'duration', 'particleCount', 'fontSize',
  'primaryColor', 'secondaryColor', 'textColor', 'backgroundColor', 'borderColor',
  'theme_colors', 'alert_font_sizes', 'alert_outline',
  'soundEnabled', 'soundChoice', 'soundVolume', 'customSoundUrl',
  'ttsEnabled', 'ttsReadDonor', 'ttsPrefixEnabled', 'ttsLanguage', 'ttsVolume', 'ttsRate',
  'messageTemplate', 'template_line1', 'template_line2', 'amountSuffix', 'showDonorMessage', 'minAmount',
  'profanityFilterEnabled', 'profanityWords', 'profanityReplaceStyle',
  'customImageMode', 'customImageValue',
  'goal_enabled', 'goal_amount', 'goal_current',
  'goal_label', 'goal_bar_color', 'goal_show_on_donate',
  'goal_end_date', 'goal_bar_text', 'goal_subtitle1', 'goal_subtitle2',
  'goal_anim_sound', 'goal_anim_enabled', 'goal_anim_sound_volume', 'goal_bar_position', 'goal_bar_width', 'goal_bar_layout', 'goal_bar_thickness', 'goal_bar_width_auto',
  'goal_pointer_enabled', 'goal_pointer_side', 'goal_pointer_content',
  'timer_settings', 'leaderboard_settings', 'recentdonate_settings', 'goal_text_settings',
  'tier_donate_settings', 'sound_library'
];

const PAGE_ALLOWED_FIELDS = [
  'page_title', 'page_subtitle', 'thank_you_header', 'thank_you_subtitle',
  'profile_image_value', 'profile_image_source', 'profile_glow_color',
  'social_twitch', 'social_youtube', 'social_tiktok', 'social_facebook',
  'social_x', 'social_discord', 'social_instagram',
  'header_bg_url', 'page_bg_url', 'header_bg_y', 'header_bg_zoom'
];

app.post('/api/overlay/settings', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);

    const safeBody = filterAllowedFields(req.body, OVERLAY_ALLOWED_FIELDS);

    // SEC-002: Reject non-audio or non-http(s) customSoundUrl to prevent stored XSS
    if (safeBody.customSoundUrl !== undefined) {
      const audioCheck = validateAudioUrl(safeBody.customSoundUrl);
      if (!audioCheck.valid) {
        return res.status(400).json({ error: audioCheck.message });
      }
    }

    let capResetStreamerId = null; // F2: PK ของ streamer ถ้า cap_type เปลี่ยน → reset counter หลัง save

    // Timer config: must be a JSON object; validate embedded sound URL (SEC-002 precedent).
    if (safeBody.timer_settings !== undefined) {
      let t;
      try { t = JSON.parse(safeBody.timer_settings); } catch { t = null; }
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        return res.status(400).json({ error: 'timer_settings ไม่ถูกต้อง' });
      }
      if (t.sound_url) {
        const check = validateAudioUrl(t.sound_url);
        if (!check.valid) return res.status(400).json({ error: check.message });
      }
      // max rules limit (I3)
      if (Array.isArray(t.rules) && t.rules.length > 10) {
        return res.status(400).json({ error: 'กฏ Timer สูงสุด 10 กฏ' });
      }
      // sound_volume range (P5-A)
      if (t.sound_volume !== undefined) {
        const vol = parseFloat(t.sound_volume);
        if (isNaN(vol) || vol < 0 || vol > 1) {
          return res.status(400).json({ error: 'sound_volume ต้องอยู่ระหว่าง 0-1' });
        }
      }
      // outline_color hex validation (I10)
      if (t.outline_color !== undefined && !/^#([A-Fa-f0-9]{3}){1,2}$/.test(t.outline_color)) {
        return res.status(400).json({ error: 'outline_color ต้องเป็น hex color' });
      }
      // emoji length cap (R9)
      if (t.timeout_effect_emoji !== undefined && String(t.timeout_effect_emoji).length > 16) {
        return res.status(400).json({ error: 'emoji ยาวเกินไป' });
      }
      safeBody.timer_settings = JSON.stringify(t); // re-serialize to strip anything odd

      // F2: cap_type เปลี่ยน → counter เดิมหน่วยผิด (บาท↔วินาที) ต้อง reset
      const prevStreamer = await getStreamerForUser(req.user);
      if (prevStreamer && (getTimerConfig(prevStreamer).cap_type || '') !== (t.cap_type || '')) {
        capResetStreamerId = prevStreamer.id;
      }
    }

    // Alert overlay JSON fields validation
    const colorRegex = /^#([A-Fa-f0-9]{3}){1,2}$|^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0?\.\d+|1(\.0)?)\s*\)$/;

    // Leader Board / Recent Donate config: must be a JSON object (mirrors timer_settings pattern)
    for (const key of ['leaderboard_settings', 'recentdonate_settings']) {
      if (safeBody[key] !== undefined) {
        let parsed;
        try { parsed = JSON.parse(safeBody[key]); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return res.status(400).json({ error: `${key} ไม่ถูกต้อง` });
        }
        // max_entries: 1-10
        if (parsed.max_entries !== undefined) {
          const n = parseInt(parsed.max_entries, 10);
          if (!Number.isInteger(n) || n < 1 || n > 10) {
            return res.status(400).json({ error: `${key}.max_entries ต้องอยู่ระหว่าง 1-10` });
          }
        }
        // title: max 40 chars
        if (parsed.title !== undefined && String(parsed.title).length > 40) {
          return res.status(400).json({ error: `${key}.title ยาวเกินไป (สูงสุด 40 ตัวอักษร)` });
        }
        // row_template_left / row_template_right: max 80 chars + ห้าม < > (SEC: template ถูกยัดเข้า innerHTML ฝั่ง widget, block self-XSS)
        for (const f of ['row_template_left', 'row_template_right']) {
          if (parsed[f] === undefined) continue;
          const s = String(parsed[f]);
          if (s.length > 80) {
            return res.status(400).json({ error: `${key}.${f} ยาวเกินไป (สูงสุด 80 ตัวอักษร)` });
          }
          if (/[<>]/.test(s)) {
            return res.status(400).json({ error: `${key}.${f} ห้ามมีอักขระ < หรือ >` });
          }
        }
        // width: explicit px 300-1920, or auto (omit/undefined)
        if (parsed.width !== undefined) {
          const w = parseInt(parsed.width, 10);
          if (!Number.isInteger(w) || w < 300 || w > 1920) {
            return res.status(400).json({ error: `${key}.width ต้องอยู่ระหว่าง 300-1920` });
          }
        }
        // bg_opacity / border_opacity / row_bg_opacity: 0-100
        for (const f of ['bg_opacity', 'border_opacity', 'row_bg_opacity']) {
          if (parsed[f] !== undefined) {
            const v = parseInt(parsed[f], 10);
            if (!Number.isInteger(v) || v < 0 || v > 100) {
              return res.status(400).json({ error: `${key}.${f} ต้องอยู่ระหว่าง 0-100` });
            }
          }
        }
        // outline_width: 0-5
        if (parsed.outline_width !== undefined) {
          const v = parseInt(parsed.outline_width, 10);
          if (!Number.isInteger(v) || v < 0 || v > 5) {
            return res.status(400).json({ error: `${key}.outline_width ต้องอยู่ระหว่าง 0-5` });
          }
        }
        // font_size_*: 12-72
        for (const f of ['font_size_title', 'font_size_row', 'font_size_medal', 'font_size_time']) {
          if (parsed[f] !== undefined) {
            const v = parseInt(parsed[f], 10);
            if (!Number.isInteger(v) || v < 12 || v > 72) {
              return res.status(400).json({ error: `${key}.${f} ต้องอยู่ระหว่าง 12-72` });
            }
          }
        }
        // color fields: must match color regex
        const colorFields = ['bg_color', 'border_color', 'outline_color', 'row_bg_color', 'row_border_color',
          'color_rank', 'color_donor', 'color_amount', 'color_currency', 'color_count',
          'color_message', 'color_text'];
        for (const f of colorFields) {
          if (parsed[f] !== undefined && !colorRegex.test(String(parsed[f]))) {
            return res.status(400).json({ error: `${key}.${f} รูปแบบสีไม่ถูกต้อง` });
          }
        }
        // [Requirement #8] period_mode / period_custom_days — Leader Board + Recent Donate ใช้ pattern เดียวกัน
        if (parsed.period_mode !== undefined && !['all', 'weekly', 'monthly', 'custom'].includes(parsed.period_mode)) {
          return res.status(400).json({ error: `${key}.period_mode ไม่ถูกต้อง` });
        }
        if (parsed.period_custom_days !== undefined) {
          const d = parseInt(parsed.period_custom_days, 10);
          if (!Number.isInteger(d) || d < 1 || d > LEADERBOARD_MAX_LOOKBACK_DAYS) {
            return res.status(400).json({ error: `${key}.period_custom_days ต้องอยู่ระหว่าง 1-${LEADERBOARD_MAX_LOOKBACK_DAYS}` });
          }
        }
        safeBody[key] = JSON.stringify(parsed);
      }
    }

    const jsonValidators = {
      theme_colors: (val) => {
        if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
        for (const theme of Object.values(val)) {
          if (!theme || typeof theme !== 'object') return false;
          for (const v of Object.values(theme)) {
            if (typeof v !== 'string' || !colorRegex.test(v)) return false;
          }
        }
        return true;
      },
      alert_font_sizes: (val) => {
        if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
        const allowedKeys = new Set(['header', 'donor_hl', 'message', 'amount', 'amount_hl', 'suffix']);
        for (const k of Object.keys(val)) if (!allowedKeys.has(k)) return false;
        for (const v of Object.values(val)) {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 12 || n > 192) return false;
        }
        return true;
      },
      alert_outline: (val) => {
        if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
        for (const v of Object.values(val)) {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0 || n > 5) return false;
        }
        return true;
      }
    };
    for (const [key, validator] of Object.entries(jsonValidators)) {
      if (safeBody[key] !== undefined) {
        let parsed;
        try { parsed = JSON.parse(safeBody[key]); } catch { parsed = null; }
        if (!parsed || !validator(parsed)) {
          return res.status(400).json({ error: `${key} ไม่ถูกต้อง` });
        }
        safeBody[key] = JSON.stringify(parsed);
      }
    }

    // § 2.1 TIER_DONATE_BLUEPRINT.md — tier_donate_settings/sound_library ต้องรู้ streamer.id ก่อน validate ownership ของ URL
    if (safeBody.tier_donate_settings !== undefined || safeBody.sound_library !== undefined) {
      const tierStreamer = await getStreamerForUser(req.user);
      if (!tierStreamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

      if (safeBody.tier_donate_settings !== undefined) {
        let parsed;
        try { parsed = JSON.parse(safeBody.tier_donate_settings); } catch { parsed = null; }
        const check = validateTierDonateSettings(parsed, tierStreamer.id);
        if (!check.valid) return res.status(400).json({ error: check.message });
        safeBody.tier_donate_settings = JSON.stringify(parsed);
      }

      if (safeBody.sound_library !== undefined) {
        let parsed;
        try { parsed = JSON.parse(safeBody.sound_library); } catch { parsed = null; }
        const check = validateSoundLibrary(parsed, tierStreamer.id);
        if (!check.valid) return res.status(400).json({ error: check.message });
        safeBody.sound_library = JSON.stringify(parsed);
      }
    }

    const updatedStreamer = await db.saveStreamer({
      twitch_id: req.user.twitch_id || null,
      streamlabs_id: req.user.streamlabs_id || null,
      username: actualUsername,
      ...safeBody
    });

    if (capResetStreamerId) {
      await db.setTimerControl(capResetStreamerId, 'reset-cap');
      updatedStreamer.timer_cap_current = 0; // response + broadcast สะท้อนค่าจริง
      broadcastTimerCap(actualUsername, getTimerConfig(updatedStreamer), 0);
    }

    broadcastAlert(actualUsername, { type: 'settings_update', settings: updatedStreamer });
    res.json({ success: true, settings: updatedStreamer });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าได้' });
  }
});

// POST /api/account/username — เปลี่ยน username (rename)
// ⚠️ BREAKING: path-based URLs ทุกเส้นที่ผูก username (/:username, /:username/overlay ฯลฯ) จะเปลี่ยนทันที
// Frontend redirect ไป /:newUsername/dashboard หลังสำเร็จเพื่อหลีกเลี่ยง ownership check fail
app.post('/api/account/username', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const { username } = req.body;
    if (typeof username !== 'string') {
      return res.status(400).json({ error: 'กรุณากรอก Username ใหม่' });
    }

    const normalizedUsername = username.toLowerCase().trim();
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้' });

    // no-op shortcut: เหมือนเดิม lowercase-compare เพื่อกัน query ซ้ำเปล่าๆ
    if (normalizedUsername === streamer.username.toLowerCase()) {
      return res.json({ success: true, username: streamer.username, redirectTo: `/${streamer.username}/dashboard`, noop: true });
    }

    if (normalizedUsername.length < 3) {
      return res.status(400).json({ error: 'Username ต้องมีอย่างน้อย 3 ตัวอักษร' });
    }
    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
      return res.status(400).json({ error: 'Username ต้องมี 3-30 ตัวอักษร: a-z, 0-9, underscore เท่านั้น' });
    }
    if (RESERVED_WORDS.includes(normalizedUsername)) {
      return res.status(400).json({ error: 'Username นี้ถูกสงวนไว้ กรุณาเลือกชื่ออื่น' });
    }

    // collision check (ตัดตัวเองออกด้วย id — กัน false-positive ถ้า username เดิมยังตรงกัน)
    const existing = await db.getStreamer(normalizedUsername);
    if (existing && existing.id !== streamer.id) {
      return res.status(400).json({ error: 'Username นี้มีคนใช้แล้ว กรุณาเลือกชื่ออื่น' });
    }

    await db.renameStreamerUsername(streamer.id, streamer.username, normalizedUsername);
    console.log(`✏️ [Username Rename] ${streamer.username} → ${normalizedUsername} (id: ${streamer.id})`);

    res.json({
      success: true,
      username: normalizedUsername,
      redirectTo: `/${normalizedUsername}/dashboard`
    });
  } catch (err) {
    console.error('Username rename error:', err);
    res.status(500).json({ error: 'ไม่สามารถเปลี่ยน Username ได้ กรุณาลองใหม่' });
  }
});

app.post('/api/goal/adjust', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const { delta } = req.body;
    if (typeof delta !== 'number') return res.status(400).json({ error: 'invalid delta' });
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'streamer not found' });
    const updated = await db.updateGoalCurrent(streamer.id, delta);
    const actualUsername = await getActualUsername(req.user);
    await broadcastGoalUpdate(actualUsername, { ...streamer, goal_current: updated.goal_current });
    res.json({ success: true, current: updated.goal_current });
  } catch (error) {
    console.error('Goal adjust error:', error);
    res.status(500).json({ error: 'ไม่สามารถปรับยอดได้' });
  }
});

// [UI Fix] Test button ต้องยัดข้อมูลสุ่ม (donor/amount) เข้า SSE จริง — เดิมเรียก broadcast*Update()
// ซึ่ง query แต่ข้อมูลจริงจาก DB เฉยๆ ไม่แตะ donor/amount ที่ส่งมา → ถ้าไม่มีโดเนทจริง overlay ไม่เห็นอะไรเลย
app.post('/api/widget/leaderboard/test', ensureAuthenticated, csrfProtection, async (req, res) => {
  const { donor, amount } = req.body;
  if (!donor || !amount) return res.status(400).json({ error: 'Missing donor/amount' });
  const username = await getActualUsername(req.user);
  const clients = sseClients.filter(c => c.username === username && c.source === 'leader-board');
  if (clients.length) {
    const rest = await resolveLeaderboardEntries(username, 4);
    const entries = [{ donor: String(donor).slice(0, 60), total_amount: Number(amount) || 0, donation_count: 1 }, ...rest]
      .map((e, i) => ({ rank: i + 1, donor: e.donor, total_amount: e.total_amount, donation_count: e.donation_count }));
    const payload = JSON.stringify({ type: 'leaderboard_update', entries });
    sseClients = sseClients.filter(client => {
      if (client.username === username && client.source === 'leader-board') {
        try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
        catch { return false; }
      }
      return true;
    });
  }
  res.json({ success: true });
});

app.post('/api/widget/recentdonate/test', ensureAuthenticated, csrfProtection, async (req, res) => {
  const { donor, amount } = req.body;
  if (!donor || !amount) return res.status(400).json({ error: 'Missing donor/amount' });
  const username = await getActualUsername(req.user);
  const clients = sseClients.filter(c => c.username === username && c.source === 'recent-donate');
  if (clients.length) {
    const rest = await resolveRecentDonateEntries(username, 4);
    const entries = [{ donor: String(donor).slice(0, 60), amount: Number(amount) || 0, message: 'ทดสอบระบบ', paidAt: new Date().toISOString(), payment_method: 'test' }, ...rest]
      .map(e => ({ donor: e.donor, amount: e.amount, message: e.message, paidAt: e.paidAt, payment_method: e.payment_method }));
    const payload = JSON.stringify({ type: 'recentdonate_update', entries });
    sseClients = sseClients.filter(client => {
      if (client.username === username && client.source === 'recent-donate') {
        try { client.res.write(`data: ${payload}\n\n`); client.lastActivity = Date.now(); return true; }
        catch { return false; }
      }
      return true;
    });
  }
  res.json({ success: true });
});

// POST /api/badges/display — user เลือก badge ที่จะโชว์บนหน้าโดเนท
app.post('/api/badges/display', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้' });

    let { display } = req.body; // array of badge keys
    if (!Array.isArray(display)) return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' });

    const earned = db.parseBadges(streamer.badges);
    const ALL_KEYS = ['dev', 'beta_tester', 'member_1m', 'member_3m', 'member_6m', 'member_1y', 'member_2y'];
    // sanitize: เฉพาะ key ที่รู้จัก + ได้จริง
    display = [...new Set(display)].filter(k => ALL_KEYS.includes(k) && earned[k]);

    await db.saveStreamer({ ...streamer, badge_display: JSON.stringify(display) });
    // resolve กลับ (clamp membership เหลือ 1) เพื่อคืน state จริงหลัง save
    const resolved = db.resolveBadgeDisplay({ ...streamer, badge_display: JSON.stringify(display) });
    res.json({ success: true, badgeDisplay: resolved });
  } catch (err) {
    console.error('Badge display save error:', err);
    res.status(500).json({ error: 'บันทึกไม่สำเร็จ กรุณาลองใหม่' });
  }
});

app.post('/api/goal/reset', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'streamer not found' });
    const updated = await db.resetGoalCurrent(streamer.id);
    const actualUsername = await getActualUsername(req.user);
    await broadcastGoalUpdate(actualUsername, { ...streamer, goal_current: 0 });
    res.json({ success: true });
  } catch (error) {
    console.error('Goal reset error:', error);
    res.status(500).json({ error: 'ไม่สามารถรีเซ็ตได้' });
  }
});

app.post('/api/timer/control', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const { action, delta } = req.body;
    if (!['start', 'stop', 'reset', 'reset-cap', 'add', 'sub'].includes(action)) {
      return res.status(400).json({ error: 'invalid action' });
    }
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'streamer not found' });
    const deltaSec = Math.max(1, Math.min(parseInt(delta) || 0, 86400));
    const updated = await db.setTimerControl(streamer.id, action, deltaSec);
    const actualUsername = await getActualUsername(req.user);
    // ใช้ delta ที่ apply จริงหลัง clamp 0 — sub 300 ตอนเหลือ 30 ต้อง broadcast -30 ไม่ใช่ -300
    const broadcastDelta = (action === 'add' || action === 'sub') ? (updated ? updated.applied_delta : 0) : 0;
    broadcastTimerUpdate(actualUsername, { ...streamer, ...updated }, broadcastDelta, true);
    if (action === 'reset-cap') broadcastTimerCap(actualUsername, getTimerConfig(streamer), 0);
    res.json({ success: true, ...updated });
  } catch (error) {
    console.error('Timer control error:', error);
    res.status(500).json({ error: 'ไม่สามารถควบคุม Timer ได้' });
  }
});

app.post('/api/tiktok/gift', ensureAuthenticated, csrfProtection, tiktokGiftLimiter, async (req, res) => {
  try {
    const coins = Number(req.body.coins);
    if (!Number.isFinite(coins) || coins <= 0 || coins > 1_000_000) {
      return res.status(400).json({ error: 'coins ไม่ถูกต้อง' });
    }
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบ streamer' });
    const t = getTimerConfig(streamer);
    if (!t.enabled) return res.json({ success: true, skipped: 'timer_disabled' });
    if (!t.tiktokEnabled) return res.json({ success: true, skipped: 'tiktok_disabled' });
    await applyTimerOnDonation(streamer, coins, 'add', 'coin');
    return res.json({ success: true, coins });
  } catch (e) {
    console.error('Gift relay failed:', e.message);
    return res.status(500).json({ error: 'ปรับ timer ไม่สำเร็จ' });
  }
});

// Bridge heartbeat — bridge page ping ทุก ~10s ขณะเปิด (dapi = TikFinity ws เชื่อมอยู่ไหม)
// dapi ส่งผ่าน query (ไม่มี body) — กัน "stream is not readable" ตอน fetch ถูก abort ระหว่าง page reload
app.post('/api/tiktok/heartbeat', ensureAuthenticated, csrfProtection, tiktokStatusLimiter, async (req, res) => {
  try {
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบ streamer' });
    bridgeHeartbeats.set(streamer.username.toLowerCase(), { at: Date.now(), dapi: req.query.dapi === '1' });
    return res.json({ success: true });
  } catch (e) {
    console.error('Heartbeat failed:', e.message);
    return res.status(500).json({ error: 'heartbeat ไม่สำเร็จ' });
  }
});

// Dashboard poll — สถานะ Bridge จริง: notopen / open-no-dapi / ready
app.get('/api/tiktok/status', ensureAuthenticated, tiktokStatusLimiter, async (req, res) => {
  try {
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบ streamer' });
    const hb = bridgeHeartbeats.get(streamer.username.toLowerCase());
    const fresh = hb && (Date.now() - hb.at) < BRIDGE_STALE_MS;
    const state = !fresh ? 'notopen' : (hb.dapi ? 'ready' : 'open');
    return res.json({ success: true, state });
  } catch (e) {
    console.error('Status check failed:', e.message);
    return res.status(500).json({ error: 'ตรวจสถานะไม่สำเร็จ' });
  }
});

app.post('/api/feedback', csrfProtection, feedbackLimiter, ensureAuthenticated, async (req, res) => {
  const { type, message } = req.body;

  if (!type || !message || typeof message !== 'string') {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  }
  if (message.trim().length < 10) {
    return res.status(400).json({ error: 'รายละเอียดต้องมีอย่างน้อย 10 ตัวอักษร' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'รายละเอียดยาวเกิน 2000 ตัวอักษร' });
  }

  const allowedTypes = ['idea', 'bug', 'ux', 'question'];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'ประเภทไม่ถูกต้อง' });
  }

  const typeLabel = { idea: '💡 ไอเดียใหม่', bug: '🐛 แจ้งบัค', ux: '🎨 UI/UX', question: '❓ คำถาม' };
  const typeColor = { idea: 0xfb923c, bug: 0xef4444, ux: 0xc084fc, question: 0x38bdf8 };
  const username = req.user?.display_name || req.user?.username || 'ไม่ระบุ';

  const webhookPayload = {
    embeds: [{
      title: `${typeLabel[type]} จาก ${username}`,
      description: message.trim(),
      color: typeColor[type],
      fields: [
        { name: 'ประเภท', value: typeLabel[type], inline: true },
        { name: 'User', value: username, inline: true },
        { name: 'วันที่', value: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }), inline: true },
      ],
      footer: { text: 'TipKub Feedback System' },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const webhookUrl = `${process.env.DISCORD_WEBHOOK_URL}?thread_id=${process.env.DISCORD_FEEDBACK_THREAD_ID}`;
    await axios.post(webhookUrl, webhookPayload, { timeout: 5000 });
    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback] Discord webhook error:', err.message);
    res.status(502).json({ error: 'ส่ง feedback ไม่สำเร็จ กรุณาลองใหม่ภายหลัง' });
  }
});

app.post('/api/report-donate-page', sameOriginCheck, reportLimiter, async (req, res) => {
  const { reportType, message, donatePageUrl, streamerUsername } = req.body;

  const allowedTypes = ['inappropriate', 'scam', 'page_issue', 'other'];
  if (!reportType || !allowedTypes.includes(reportType)) {
    return res.status(400).json({ error: 'ประเภทการรายงานไม่ถูกต้อง' });
  }
  if (message && (typeof message !== 'string' || message.length > 500)) {
    return res.status(400).json({ error: 'คำอธิบายยาวเกิน 500 ตัวอักษร' });
  }

  const typeLabel = {
    inappropriate: '🚫 เนื้อหาไม่เหมาะสม',
    scam: '⚠️ ต้องสงสัยว่าเป็นการหลอกลวง',
    page_issue: '🔧 ปัญหาเกี่ยวกับหน้าโดเนท',
    other: '💬 อื่นๆ',
  };

  const safeUrl = typeof donatePageUrl === 'string' ? donatePageUrl.slice(0, 200) : 'ไม่ระบุ';
  const safeUser = typeof streamerUsername === 'string' && streamerUsername.trim()
    ? streamerUsername.slice(0, 50) : 'ไม่ระบุ';

  const webhookPayload = {
    embeds: [{
      title: `🚩 รายงานปัญหา — ${typeLabel[reportType]}`,
      description: message?.trim() || '_(ไม่มีคำอธิบายเพิ่มเติม)_',
      color: 0xef4444,
      fields: [
        { name: 'ประเภท', value: typeLabel[reportType], inline: true },
        { name: 'Streamer', value: safeUser, inline: true },
        { name: 'หน้าโดเนท', value: safeUrl, inline: false },
        { name: 'วันที่', value: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }), inline: true },
      ],
      footer: { text: 'TipKub Report System' },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const webhookUrl = `${process.env.DISCORD_WEBHOOK_URL}?thread_id=${process.env.DISCORD_REPORT_THREAD_ID}`;
    await axios.post(webhookUrl, webhookPayload, { timeout: 5000 });
    res.json({ ok: true });
  } catch (err) {
    console.error('[report] Discord webhook error:', err.message);
    res.status(502).json({ error: 'ส่งรายงานไม่สำเร็จ กรุณาลองใหม่ภายหลัง' });
  }
});

app.get('/api/page/:username/goal', goalPublicLimiter, async (req, res) => {
  try {
    const streamer = await db.getStreamer(req.params.username);
    if (!streamer) return res.json({ enabled: false });
    res.json({
      enabled: !!streamer.goal_enabled,
      current: streamer.goal_current,
      amount: streamer.goal_amount,
      label: streamer.goal_label,
      barColor: streamer.goal_bar_color,
      showOnDonate: !!streamer.goal_show_on_donate,
      barText: streamer.goal_bar_text,
      subtitle1: streamer.goal_subtitle1,
      subtitle2: streamer.goal_subtitle2,
      endDate: streamer.goal_end_date
    });
  } catch (err) {
    console.error('Goal state error:', err.message);
    res.json({ enabled: false });
  }
});

// § 2.3 TIER_DONATE_BLUEPRINT.md
app.get('/api/page/:username/tier-settings', tierSettingsLimiter, async (req, res) => {
  try {
    const streamer = await db.getStreamer(req.params.username);
    if (!streamer) return res.json({ enabled: false });
    let tierSettings = null;
    try { tierSettings = JSON.parse(streamer.tier_donate_settings || 'null'); } catch {}
    tierSettings = normalizeTierDonateSettings(tierSettings);
    if (!tierSettings || !tierSettings.enabled) return res.json({ enabled: false });
    let soundLibrary = [];
    try { soundLibrary = JSON.parse(streamer.sound_library || '[]'); } catch {}
    res.json({
      enabled: true,
      tiers: tierSettings.tiers || [],
      alert_images: tierSettings.alert_images || [],
      sound_library: soundLibrary
    });
  } catch (err) {
    console.error('Tier settings state error:', err.message);
    res.json({ enabled: false });
  }
});

// § 2.4 TIER_DONATE_BLUEPRINT.md — donor own-audio upload (upload หรือ MediaRecorder blob)
// ⚠️ ห้ามเรียก validateAudioUrl() ที่นี่ — ฟังก์ชันนั้น reject .webm โดยตั้งใจสำหรับ arbitrary streamer-typed URL field คนละ trust boundary (§7 pitfall #1)
const ALLOWED_TIER_AUDIO_MIMES = { 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/mp4': 'm4a' };
const tierAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TIER_AUDIO_MIMES[file.mimetype]) {
      return cb(new Error('รองรับเฉพาะไฟล์เสียง mp3, ogg, wav, webm'));
    }
    cb(null, true);
  }
});

app.post('/api/donate/upload-tier-audio', sameOriginCheck, donorAudioUploadLimiter, tierAudioUpload.single('audio'), async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'ไม่พบ username' });
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์เสียง' });

    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

    let tierSettings = null;
    try { tierSettings = JSON.parse(streamer.tier_donate_settings || 'null'); } catch {}
    tierSettings = normalizeTierDonateSettings(tierSettings);
    if (!tierSettings || !tierSettings.enabled || !Array.isArray(tierSettings.tiers)) {
      return res.status(403).json({ error: 'ผู้ใช้นี้ไม่เปิดใช้งานอัพโหลด/อัดเสียงเอง' });
    }
    const mode = req.body?.mode === 'record' ? 'record' : 'upload';
    const hasAllowedTier = tierSettings.tiers.some(t => {
      if (t.active === false) return false;
      return mode === 'record' ? t.allow_own_record === true : t.allow_own_upload === true;
    });
    if (!hasAllowedTier) {
      return res.status(403).json({ error: 'ผู้ใช้นี้ไม่เปิดใช้งานอัพโหลด/อัดเสียงเอง' });
    }

    const ext = ALLOWED_TIER_AUDIO_MIMES[req.file.mimetype];
    // SEC: แยก subfolder ตาม mode — ผูก origin ของไฟล์ (record/upload) เข้ากับ path
    // กัน donor อัดที่ Tier สูงแล้วส่งเป็น upload ที่ Tier ต่ำ (หรือกลับกัน) — computeTierAssignment เช็ค folder ตรง mode
    const key = `donor-temp/${mode}/${streamer.id}-${crypto.randomUUID()}.${ext}`;
    const url = await uploadBufferToR2(req.file.buffer, key, req.file.mimetype);
    res.json({ success: true, url });
  } catch (err) {
    console.error('Tier audio upload error:', censor(err.message));
    res.status(500).json({ error: 'อัปโหลดเสียงไม่สำเร็จ' });
  }
});

app.get('/api/page/:username/settings', async (req, res) => {
  try {
    const { username } = req.params;
    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้งานรายนี้ในระบบ' });

    const profileImg = await db.resolveProfileImage(streamer);

    res.json({
      username: streamer.username,
      profileImage: profileImg,
      profileImageSource: streamer.profile_image_source || 'twitch',
      profileImageValue: streamer.profile_image_value || '',
      profileGlowColor: streamer.profile_glow_color || '#005704',
      pageTitle: streamer.page_title || `เลี้ยงกาแฟ ${streamer.username}`,
      pageSubtitle: streamer.page_subtitle || 'ทุกการสนับสนุนคือกำลังใจที่มีค่าสำหรับผม✨',
      thankYouHeader: streamer.thank_you_header || 'ขอบคุณสำหรับการสนับสนุน!',
      thankYouSubtitle: streamer.thank_you_subtitle || 'การสนับสนุนของคุณช่วยให้เราพัฒนาคอนเทนต์ต่อไปได้',
      minAmount: streamer.minAmount != null ? streamer.minAmount : 1,
      headerBgUrl: streamer.header_bg_url || '',
      pageBgUrl: streamer.page_bg_url || '',
      headerBgY: streamer.header_bg_y != null ? streamer.header_bg_y : 50,
      headerBgZoom: streamer.header_bg_zoom != null ? streamer.header_bg_zoom : 100,
      customImageMode: streamer.customImageMode || 'emoji',
      customImageValue: streamer.customImageValue || '',
      timer: (() => {
        const t = getTimerConfig(streamer);
        if (!t.enabled) return { enabled: false };
        // Gate: แสดง choice เฉพาะเมื่อมี SSE timer client (source='timer', token-auth) ต่อค้าง
        const timerActive = sseClients.some(c =>
          c.username === username.toLowerCase() &&
          c.authMethod === 'token' &&
          c.source === 'timer'
        );
        return {
          enabled: true,
          timerActive,                              // ← ใหม่ (TIMER_CHOICE_GATE A1)
          mode: t.mode || 'multiplier',
          // whitelist-map: ส่งเฉพาะ field ที่หน้าโดเนทต้องใช้ — กัน field หลุดเกิน
          // donor จ่ายบาทเท่านั้น — กฏเหรียญ (currency='coin') ไม่โชว์หน้าโดเนท
          rules: (Array.isArray(t.rules) ? t.rules : [])
            .filter(r => (r.currency || 'thb') === 'thb')
            .map(r => ({
              amount: r.amount, base_amount: r.base_amount,
              time_seconds: r.time_seconds, action: r.action,
            })),
          allowPassthrough: t.allow_passthrough !== 0 && t.allow_passthrough !== false, // default เปิด
          // B3: cap fields — public by design (แสดงบน overlay อยู่แล้ว) ให้ donor เห็นเวลาที่ได้จริง
          capType: t.cap_type || null,
          capValue: t.cap_value || 0,
          capCurrent: streamer.timer_cap_current || 0,
        };
      })(),
      socials: {
        twitch: streamer.social_twitch,
        youtube: streamer.social_youtube,
        tiktok: streamer.social_tiktok,
        facebook: streamer.social_facebook,
        x: streamer.social_x,
        discord: streamer.social_discord,
        instagram: streamer.social_instagram,
      },
      badges: db.resolveBadgeDisplay(streamer),  // array key ที่ user เลือกโชว์เท่านั้น (ปิดหมด → [])
      // Default alert sound — ให้ donor ทดสอบฟัง "เสียงเริ่มต้น" ของ streamer ได้ (overlay เล่น client-side อยู่แล้ว ไม่ใช่ secret)
      soundEnabled: Number(streamer.soundEnabled) !== 0,
      soundChoice: streamer.soundChoice || 'none',
      customSoundUrl: streamer.customSoundUrl || '',
      soundVolume: streamer.soundVolume != null ? streamer.soundVolume : 0.5
    });
  } catch (err) {
    console.error('Get page settings error:', err);
    
    // Handle Libsql / Turso 502 or connection errors specifically
    if (err.message && (err.message.includes('502') || err.message.includes('SERVER_ERROR'))) {
      return res.status(502).json({ 
        error: 'ระบบฐานข้อมูลขัดข้องชั่วคราว (Bad Gateway)', 
        details: 'เซิร์ฟเวอร์ Turso ไม่ตอบสนอง กรุณารอซักครู่แล้วรีเฟรชหน้าเว็บอีกครั้ง' 
      });
    }
    
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลการตั้งค่าหน้าเว็บได้' });
  }
});

const SOCIAL_LINK_FIELDS = new Set(['social_twitch', 'social_youtube', 'social_tiktok', 'social_facebook', 'social_x', 'social_discord', 'social_instagram', 'header_bg_url', 'page_bg_url']);

function validateSocialUrl(url) {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// SEC-002: Validate sound alert URL — must be http(s) and end with an audio extension
function validateAudioUrl(url) {
  if (!url) return { valid: true };
  url = url.trim();
  if (url.length > 2048) return { valid: false, message: 'URL ยาวเกินไป' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, message: 'ลิงก์ URL ไม่ถูกต้อง' };
    }
    const p = parsed.pathname.toLowerCase();
    if (!p.endsWith('.mp3') && !p.endsWith('.ogg') && !p.endsWith('.wav')) {
      return { valid: false, message: 'ลิงก์ปลายทางต้องเป็นไฟล์ .mp3, .ogg หรือ .wav เท่านั้น' };
    }
    return { valid: true };
  } catch {
    return { valid: false, message: 'รูปแบบลิงก์ URL ไม่ถูกต้อง' };
  }
}

// § 10.15 TIER_DONATE_BLUEPRINT.md — host-check จริงสำหรับ MyInstants URL ที่ donor เลือก
function isMyinstantsUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'https:' && p.hostname === 'www.myinstants.com';
  } catch {
    return false;
  }
}

// ownership check เดียวกับ /api/upload/delete-file — url ต้องขึ้นต้นด้วย R2 public URL + folder/{streamerId}-
function isOwnedR2Url(url, folder, streamerId) {
  if (!url || typeof url !== 'string') return false;
  const r2Base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (!r2Base || !url.startsWith(r2Base + '/')) return false;
  const key = url.slice(r2Base.length + 1).split('?')[0];
  return !key.includes('..') && !key.includes('//') && key.startsWith(`${folder}/${streamerId}-`);
}

// § 2.1 TIER_DONATE_BLUEPRINT.md — validate tier_donate_settings JSON blob
function validateTierDonateSettings(obj, streamerId) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { valid: false, message: 'tier_donate_settings ไม่ถูกต้อง' };
  if (!Array.isArray(obj.tiers) || obj.tiers.length === 0 || obj.tiers.length > 3) {
    return { valid: false, message: 'tiers ต้องมี 1-3 รายการ' };
  }
  if (!obj.tiers.some(t => t.level === 1)) {
    return { valid: false, message: 'ต้องมี Tier 1 เสมอ' };
  }
  let prevMin = -Infinity;
  for (const t of obj.tiers.slice().sort((a, b) => a.level - b.level)) {
    if (![1, 2, 3].includes(t.level)) return { valid: false, message: 'tier level ไม่ถูกต้อง' };
    const minAmount = Number(t.min_amount);
    if (!Number.isFinite(minAmount) || minAmount < 1) return { valid: false, message: `Tier ${t.level}: min_amount ต้องมากกว่า 0` };
    if (typeof t.name !== 'string' || t.name.length > 20) return { valid: false, message: `Tier ${t.level}: ชื่อต้องไม่เกิน 20 ตัวอักษร` };
    if (t.active !== false) {
      if (minAmount <= prevMin) return { valid: false, message: 'min_amount ต้องเรียงจากน้อยไปมาก' };
      prevMin = minAmount;
    }
    if (typeof t.allow_image_choice !== 'boolean') return { valid: false, message: `Tier ${t.level}: allow_image_choice ไม่ถูกต้อง` };
    if (typeof t.allow_sound_choice !== 'boolean') return { valid: false, message: `Tier ${t.level}: allow_sound_choice ไม่ถูกต้อง` };
    if (typeof t.allow_own_upload !== 'boolean') return { valid: false, message: `Tier ${t.level}: allow_own_upload ไม่ถูกต้อง` };
    if (typeof t.allow_own_record !== 'boolean') return { valid: false, message: `Tier ${t.level}: allow_own_record ไม่ถูกต้อง` };
    if (typeof t.allow_youtube_clip !== 'boolean') return { valid: false, message: `Tier ${t.level}: allow_youtube_clip ไม่ถูกต้อง` };
  }
  if (obj.alert_images !== undefined) {
    if (!Array.isArray(obj.alert_images) || obj.alert_images.length > 3) {
      return { valid: false, message: 'alert_images สูงสุด 3 รายการ' };
    }
    for (const img of obj.alert_images) {
      if (!img || !['image', 'video'].includes(img.type)) return { valid: false, message: 'alert_images.type ไม่ถูกต้อง' };
      if (!isOwnedR2Url(img.url, 'tier-alert', streamerId)) return { valid: false, message: 'alert_images.url ไม่ถูกต้อง' };
    }
  }
  return { valid: true };
}

// § 10.5 TIER_DONATE_BLUEPRINT.md — backward-compat shim: old tiers saved with allow_own_audio
// expand into the new split flags allow_own_upload / allow_own_record on read.
function normalizeTierDonateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  if (Array.isArray(settings.tiers)) {
    settings.tiers.forEach(t => {
      if (t.allow_own_upload === undefined) t.allow_own_upload = t.allow_own_audio ?? false;
      if (t.allow_own_record === undefined) t.allow_own_record = t.allow_own_audio ?? false;
    });
  }
  return settings;
}

// § 2.1 TIER_DONATE_BLUEPRINT.md — validate sound_library JSON array (cap 5, ownership + audio-type check)
function validateSoundLibrary(arr, streamerId) {
  if (!Array.isArray(arr) || arr.length > 5) return { valid: false, message: 'sound_library สูงสุด 5 รายการ' };
  for (const s of arr) {
    if (!s || typeof s.label !== 'string' || !s.label.trim()) return { valid: false, message: 'sound_library ต้องมี label' };
    const audioCheck = validateAudioUrl(s.url);
    if (!audioCheck.valid) return audioCheck;
    if (!isOwnedR2Url(s.url, 'sounds', streamerId)) return { valid: false, message: 'sound_library.url ไม่ถูกต้อง' };
  }
  return { valid: true };
}

// § 2.5 TIER_DONATE_BLUEPRINT.md — server คำนวณ tier_level เองเสมอ ห้าม trust client (§7 pitfall #2)
// tierImageUrl/tierSoundUrl ผิด/ปลอม → ละเว้นเงียบๆ (เซ็ต null) ไม่ error ทั้งการโดเนท (§7 pitfall #3)
function computeTierAssignment(streamer, amount, body) {
  const result = { tier_level: null, tier_image_url: null, tier_sound_url: null, tier_sound_is_temp: 0,
    tier_sound_youtube_id: null, tier_sound_youtube_start: null, tier_sound_youtube_end: null };
  let tierSettings = null;
  try { tierSettings = JSON.parse(streamer.tier_donate_settings || 'null'); } catch {}
  tierSettings = normalizeTierDonateSettings(tierSettings);
  if (!tierSettings || !tierSettings.enabled || !Array.isArray(tierSettings.tiers)) return result;

  const unlocked = tierSettings.tiers
    .filter(t => t.active !== false && Number(amount) >= Number(t.min_amount))
    .sort((a, b) => b.level - a.level)[0];
  if (!unlocked) return result;
  result.tier_level = unlocked.level;

  const { tierImageUrl, tierSoundUrl, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd } = body || {};
  const tierSoundIsTemp = body?.tierSoundIsTemp === true || body?.tierSoundIsTemp === 'true' || body?.tierSoundIsTemp === 1 || body?.tierSoundIsTemp === '1';
  if (tierImageUrl && unlocked.allow_image_choice) {
    const images = Array.isArray(tierSettings.alert_images) ? tierSettings.alert_images : [];
    if (images.some(img => img.url === tierImageUrl)) result.tier_image_url = tierImageUrl;
  }
  if (tierSoundUrl) {
    const ownMode = tierSoundMode === 'record' ? 'record' : 'upload';
    if (tierSoundIsTemp && (ownMode === 'record' ? unlocked.allow_own_record : unlocked.allow_own_upload)) {
      // SEC: folder ต้องตรง mode — ไฟล์ที่อัด (donor-temp/record/) ใช้เป็น upload ไม่ได้ และกลับกัน
      if (isOwnedR2Url(tierSoundUrl, `donor-temp/${ownMode}`, streamer.id)) {
        result.tier_sound_url = tierSoundUrl;
        result.tier_sound_is_temp = 1;
      }
    } else if (!tierSoundIsTemp) {
      let soundLibrary = [];
      try { soundLibrary = JSON.parse(streamer.sound_library || '[]'); } catch {}
      if (unlocked.allow_sound_choice && soundLibrary.some(s => s.url === tierSoundUrl)) {
        result.tier_sound_url = tierSoundUrl;
      } else if (unlocked.allow_own_upload && isMyinstantsUrl(tierSoundUrl)) {
        // catalog ใช้สิทธิ์เดียวกับ "อัพโหลดเสียงเอง" ไม่ใช่ allow_sound_choice — ตั้งใจแยกจาก library
        result.tier_sound_url = tierSoundUrl;
        result.tier_sound_is_temp = 0;
      }
    }
  }
  if (tierYoutubeId && unlocked.allow_youtube_clip === true) {
    const validId = /^[a-zA-Z0-9_-]{11}$/.test(tierYoutubeId);
    const s = Number(tierYoutubeStart), e = Number(tierYoutubeEnd);
    const validRange = Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s && (e - s) <= 10;
    if (validId && validRange) {
      result.tier_sound_youtube_id = tierYoutubeId;
      result.tier_sound_youtube_start = s;
      result.tier_sound_youtube_end = e;
    }
  }
  return result;
}

app.post('/api/page/settings', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);

    const safeBody = filterAllowedFields(req.body, PAGE_ALLOWED_FIELDS);

    // SEC-001: Reject javascript: and other non-http(s) social URLs to prevent stored XSS
    for (const field of SOCIAL_LINK_FIELDS) {
      if (safeBody[field] && !validateSocialUrl(safeBody[field])) {
        return res.status(400).json({ error: `Invalid URL in ${field}: only http/https allowed` });
      }
    }

    const updatedStreamer = await db.saveStreamer({
      twitch_id: req.user.twitch_id || null,
      streamlabs_id: req.user.streamlabs_id || null,
      username: actualUsername,
      ...safeBody
    });

    res.json({ success: true, settings: updatedStreamer });
  } catch (error) {
    console.error('Save page settings error:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าหน้าเว็บได้' });
  }
});

// SEC-008: TTS rate limiter — unauthenticated endpoint needs protection against abuse
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many TTS requests'
});

// SEC-008: Allowlist of valid BCP-47 language codes for Google TTS
const ALLOWED_TTS_LANGS = new Set([
  'th', 'en', 'ja', 'ko', 'zh-TW', 'zh', 'vi', 'id', 'ms', 'fr', 'de', 'es', 'ru', 'ar'
]);

app.get('/api/tts', ttsLimiter, (req, res) => {
  try {
    const text = req.query.text;
    const lang = req.query.lang || 'th';
    if (!text) return res.status(400).send('Text is required');
    if (!ALLOWED_TTS_LANGS.has(lang)) return res.status(400).send('Invalid language');
    const encodedText = encodeURIComponent(text);
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodedText}`;
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36' } };
    https.get(googleTtsUrl, options, (googleRes) => {
      if (googleRes.statusCode !== 200) return res.status(googleRes.statusCode).send('Error from cloud');
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000' });
      googleRes.pipe(res);
    }).on('error', (e) => {
      res.status(500).send('Proxy connection failed');
    });
  } catch (error) {
    res.status(500).send('Internal server error');
  }
});

app.post('/api/alerts/test', ensureAuthenticated, csrfProtection, async (req, res) => {
  const { donor, amount, message } = req.body;
  
  try {
    const actualUsername = await getActualUsername(req.user);
 
    const alertData = {
      type: 'donation',
      donor: donor || 'ผู้ทดสอบ',
      amount: amount || 100,
      message: message || '',
      timestamp: new Date().toISOString()
    };
    const tierLevel = req.body?.tierLevel;
    if ([1, 2, 3].includes(Number(tierLevel))) {
      alertData.tierLevel = Number(tierLevel);
    }
    if (req.body?.sticky === true || req.body?.sticky === 'true') {
      alertData.sticky = true;
    }

    broadcastAlert(actualUsername, alertData);
    res.json({ success: true, alert: alertData });
  } catch (err) {
    console.error('Test alert error:', err);
    res.status(500).json({ error: 'ไม่สามารถส่ง Alert ทดสอบได้' });
  }
});

app.post('/api/alerts/test-clear-sticky', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    broadcastAlert(actualUsername, { type: 'clear_sticky_alert' });
    res.json({ success: true });
  } catch (err) {
    console.error('Clear sticky alert error:', err);
    res.status(500).json({ error: 'ไม่สามารถปิด Preview ได้' });
  }
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  // For API/JSON requests, return 401 JSON instead of redirecting to /login.
  // Browser navigations (non-XHR) still get the redirect for a friendly login page.
  const isApiRequest = req.xhr
    || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html'))
    || req.path.startsWith('/api/');
  if (isApiRequest) {
    return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
  }
  res.redirect('/login');
}

// CSRF protection (synchronizer token pattern, session-stored)
function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}
function csrfProtection(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  const token = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'CSRF token invalid', code: 'CSRF_INVALID' });
  }
  next();
}

// Same-origin check — lightweight CSRF defense for endpoints that cannot use
// the synchronizer-token pattern (e.g. before the user is authenticated).
// Rejects cross-site POST/PUT/DELETE unless the Origin/Referer matches.
function sameOriginCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return res.status(403).json({ error: 'Missing Origin header', code: 'CSRF_INVALID' });
  let allowed = ALLOWED_ORIGINS;
  try {
    const parsed = new URL(origin);
    const originHost = `${parsed.protocol}//${parsed.host}`;
    if (allowed.includes(originHost)) return next();
  } catch (e) {}
  return res.status(403).json({ error: 'Cross-site requests not allowed', code: 'CSRF_INVALID' });
}

app.get('/api/csrf-token', ensureAuthenticated, (req, res) => {
  res.json({ csrfToken: getCsrfToken(req) });
});

app.get('/api/overlay/token', ensureAuthenticated, async (req, res) => {
  try {
    const streamer = await getStreamerForUser(req.user);
    if (streamer && streamer.overlay_token) {
      res.json({ token: streamer.overlay_token });
    } else {
      res.status(404).json({ error: 'Token not found for this user' });
    }
  } catch (err) {
    console.error('Get token error:', err);
    if (err.message && (err.message.includes('502') || err.message.includes('SERVER_ERROR'))) {
      return res.status(502).json({ error: 'ระบบฐานข้อมูลขัดข้องชั่วคราว' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== MyInstants Sound Search Proxy ==========
const myinstantsLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10,
  message: { error: 'ค้นหาบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false,
});

const myinstantsCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const myinstantsPages = [
  { id: 'th', name: 'Thailand', url: 'https://www.myinstants.com/en/index/th/' },
  { id: 'global', name: 'Global', url: 'https://www.myinstants.com/' },
  { id: 'us', name: 'United States', url: 'https://www.myinstants.com/en/index/us/' },
  { id: 'jp', name: 'Japan', url: 'https://www.myinstants.com/en/index/jp/' },
  { id: 'de', name: 'Germany', url: 'https://www.myinstants.com/en/index/de/' },
  { id: 'br', name: 'Brazil', url: 'https://www.myinstants.com/en/index/br/' },
  { id: 'fr', name: 'France', url: 'https://www.myinstants.com/en/index/fr/' },
  { id: 'uk', name: 'United Kingdom', url: 'https://www.myinstants.com/en/index/gb/' },
];

async function scrapeMyInstants(url) {
  const cached = myinstantsCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.results;
  }

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 7000,
      validateStatus: (status) => status < 500,
    });

    if (response.status !== 200) {
      console.error(`MyInstants returned status ${response.status} for ${url}`);
      return [];
    }

    const html = response.data;
    if (!html || typeof html !== 'string' || html.length < 500) {
      console.error(`MyInstants returned empty/invalid HTML (${html ? html.length : 0} bytes) for ${url}`);
      return [];
    }

    const results = [];

    // Method 1: original regex (matching entire instant block)
    const instantBlockRegex = /<div class="instant">[\s\S]*?<button class="small-button" onclick="play\('([^']+)'[^"]*"[^>]*title="Play\s*(?:&quot;)?([^"&]*?)(?:&quot;)?\s*sound"[\s\S]*?<a href="[^"]*" class="instant-link[^"]*">([^<]+)<\/a>/g;
    let match;
    while ((match = instantBlockRegex.exec(html)) !== null) {
      const mp3Path = match[1];
      const mp3Url = mp3Path.startsWith('http') ? mp3Path : `https://www.myinstants.com${mp3Path}`;
      const slug = mp3Path.replace('/media/sounds/', '').replace('.mp3', '');
      const name = match[3].trim() || match[2].trim() || slug.replace(/[-_]/g, ' ');
      if (mp3Url && name) {
        results.push({ id: slug, name, slug, mp3Url });
      }
    }

    // Method 2: fallback — extract mp3 paths and names separately
    if (results.length === 0) {
      console.log('MyInstants: primary regex failed, trying fallback extraction for', url);

      const mp3Matches = [...html.matchAll(/play\('(\/media\/sounds\/[^']+\.mp3)'/g)];
      const nameMatches = [...html.matchAll(/<a[^>]*class="instant-link"[^>]*>([^<]+)<\/a>/g)];

      if (mp3Matches.length > 0 && nameMatches.length > 0) {
        const count = Math.min(mp3Matches.length, nameMatches.length);
        for (let i = 0; i < count; i++) {
          const mp3Path = mp3Matches[i][1];
          const mp3Url = `https://www.myinstants.com${mp3Path}`;
          const slug = mp3Path.replace('/media/sounds/', '').replace('.mp3', '');
          const name = nameMatches[i][1].trim();
          if (mp3Url && name) {
            results.push({ id: slug, name, slug, mp3Url });
          }
        }
      }
    }

    // Method 3: ultra-simple — just grab any mp3 links
    if (results.length === 0) {
      const simpleMp3 = [...html.matchAll(/\/media\/sounds\/([\w-]+)\.mp3/g)];
      for (const m of simpleMp3) {
        const slug = m[1];
        results.push({
          id: slug,
          name: slug.replace(/[-_]/g, ' '),
          slug,
          mp3Url: `https://www.myinstants.com/media/sounds/${slug}.mp3`
        });
      }
    }

    if (results.length === 0) {
      const preview = html.substring(0, 300).replace(/\s+/g, ' ');
      console.error('MyInstants: ALL extraction methods failed. HTML preview:', preview);
      console.error('MyInstants: HTML contains "instant" class:', html.includes('class="instant"'));
      console.error('MyInstants: HTML contains "play(":', html.includes("play('"));
    }

    myinstantsCache.set(url, { results, timestamp: Date.now() });
    return results;
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      console.error('MyInstants request timed out (7s):', url);
      throw new Error('MyInstants server not responding in time');
    }
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      console.error('MyInstants DNS resolution failed:', url);
      throw new Error('Cannot reach MyInstants server');
    }
    console.error('MyInstants fetch error:', err.message, err.code);
    throw err;
  }
}

app.get('/api/myinstants/proxy', ensureAuthenticated, myinstantsLimiter, async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'Missing url parameter' });

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(rawUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid url' });
    }

    if (!targetUrl.startsWith('https://www.myinstants.com/')) {
      return res.status(400).json({ error: 'Only myinstants.com URLs allowed' });
    }

    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'th-TH,en-US;q=0.9,en;q=0.8',
      },
      timeout: 7000,
      responseType: 'text',
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(response.data);
  } catch (err) {
    console.error('MyInstants proxy error:', err.message);
    res.status(502).json({ error: 'Cannot fetch page from myinstants.com' });
  }
});

async function handleMyinstantsSearch(req, res) {
  try {
    const query = (req.query.q || '').trim();
    const pageId = req.query.page || 'th';
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 10;

    let targetUrl;
    let pageName;

    if (query) {
      targetUrl = `https://www.myinstants.com/search/?name=${encodeURIComponent(query)}`;
      pageName = `Search: ${query}`;
    } else {
      const page = myinstantsPages.find(p => p.id === pageId);
      if (!page) {
        return res.status(400).json({ error: 'Invalid page ID' });
      }
      targetUrl = page.url;
      pageName = page.name;
    }

    const allResults = await scrapeMyInstants(targetUrl);
    const paginatedResults = allResults.slice(offset, offset + limit);

    const responseData = {
      results: paginatedResults,
      total: allResults.length,
      hasMore: offset + limit < allResults.length,
      pageName: pageName,
      currentPageId: query ? 'search' : pageId,
    };

    if (allResults.length === 0) {
      responseData.fallbackProxyUrl = `/api/myinstants/proxy?url=${encodeURIComponent(targetUrl)}`;
      responseData.fallbackDirectUrl = targetUrl;
    }

    res.json(responseData);
  } catch (err) {
    console.error('MyInstants search error:', err.message);
    res.status(500).json({ error: 'ไม่สามารถค้นหาเสียงได้' });
  }
}

// § 10.15 TIER_DONATE_BLUEPRINT.md — public read-only MyInstants variants for donor catalog
const publicMyinstantsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'ค้นหาบ่อยเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/myinstants/search', ensureAuthenticated, myinstantsLimiter, handleMyinstantsSearch);
app.get('/api/public/myinstants/search', publicMyinstantsLimiter, handleMyinstantsSearch);

app.get('/api/myinstants/pages', ensureAuthenticated, (req, res) => {
  res.json({ pages: myinstantsPages });
});

app.get('/api/public/myinstants/pages', publicMyinstantsLimiter, (req, res) => {
  res.json({ pages: myinstantsPages });
});

// -----------------------------------------------------------------
// [DYNAMIC ROUTES] - These must be defined LAST
// -----------------------------------------------------------------

app.get('/:username', validateUsername, (req, res) => {
  try {
    if (!DONATE_TEMPLATE) {
      return res.status(500).send('เกิดข้อผิดพลาดในการโหลดหน้าเว็บ');
    }
    const streamer = req.streamer;
    if (!streamer) return res.status(404).send('ไม่พบผู้ใช้งานรายนี้ในระบบ');
    let htmlContent = DONATE_TEMPLATE;

    const ogTitle = `TipKub | ${streamer.page_title || streamer.username}`;
    const ogDescription = streamer.page_subtitle || 'สนับสนุนสตรีมเมอร์ที่คุณรักผ่าน TipKub';
    const ogImage = streamer.profile_image_value
      ? (streamer.profile_image_value.startsWith('http') ? streamer.profile_image_value : `https://tipkub.me${streamer.profile_image_value.replace(/^\/{1,2}/, '/')}`)
      : 'https://tipkub.me/avatar.jpg';
    const ogUrl = `https://tipkub.me/${streamer.username}`;
 
    htmlContent = htmlContent
      .replace(/{{username}}/g, escapeHTML(streamer.username))
      .replace(/{{og_title}}/g, escapeHTML(ogTitle))
      .replace(/{{og_description}}/g, escapeHTML(ogDescription))
      .replace(/{{og_image}}/g, escapeHTML(ogImage))
      .replace(/{{og_url}}/g, escapeHTML(ogUrl))
      .replace(/{{page_token}}/g, generatePageToken());
 
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(htmlContent);
  } catch (err) {
    console.error('Error serving dynamic donation page:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดหน้าเว็บ');
  }
});

app.get('/:username/dashboard', ensureUserOwner, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

app.get('/:username/dona-monitor', ensureUserOwner, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/dona-monitor.html'));
});

app.get('/:username/overlay', validateUsername, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay/index.html'));
});

app.get('/:username/thank-you', validateUsername, (req, res) => {
  res.redirect(`/thank-you?username=${encodeURIComponent(req.streamer.username)}`);
});

// Vercel serverless requires exporting the app
module.exports = app;

// ========== PromptPay Payment Endpoints ==========

/**
 * Helper: Decrypt sensitive streamer fields for API response
 */
function decryptPaymentFields(streamer) {
  if (!streamer) return null;
  const result = { ...streamer };
  try {
    if (result.promptpay_phone && result.promptpay_phone.includes(':')) {
      result.promptpay_phone = decrypt(result.promptpay_phone);
    }
    if (result.tfp_api_key && result.tfp_api_key.includes(':')) {
      result.tfp_api_key = decrypt(result.tfp_api_key);
    }
    if (result.tfp_api_secret && result.tfp_api_secret.includes(':')) {
      result.tfp_api_secret = decrypt(result.tfp_api_secret);
    }
    if (result.promptpay_value_encrypted && result.promptpay_value_encrypted.includes(':')) {
      result.promptpay_value = decrypt(result.promptpay_value_encrypted);
    }
    if (result.slipok_api_encrypted && result.slipok_api_encrypted.includes(':')) {
      result.slipok_api = decrypt(result.slipok_api_encrypted);
    }
    if (result.slipok_api_key_encrypted && result.slipok_api_key_encrypted.includes(':')) {
      result.slipok_api_key = decrypt(result.slipok_api_key_encrypted);
    }
    if (result.truemoney_phone_encrypted && result.truemoney_phone_encrypted.includes(':')) {
      result.truemoney_phone = decrypt(result.truemoney_phone_encrypted);
    }
    if (result.truemoney_slipok_api_encrypted && result.truemoney_slipok_api_encrypted.includes(':')) {
      result.truemoney_slipok_api = decrypt(result.truemoney_slipok_api_encrypted);
    }
    if (result.truemoney_slipok_api_key_encrypted && result.truemoney_slipok_api_key_encrypted.includes(':')) {
      result.truemoney_slipok_api_key = decrypt(result.truemoney_slipok_api_key_encrypted);
    }
    if (result.truemoney_webhook_secret_encrypted && result.truemoney_webhook_secret_encrypted.includes(':')) {
      result.truemoney_webhook_secret = decrypt(result.truemoney_webhook_secret_encrypted);
    }
    if (result.truemoney_promptpay_id_encrypted && result.truemoney_promptpay_id_encrypted.includes(':')) {
      result.truemoney_promptpay_id = decrypt(result.truemoney_promptpay_id_encrypted);
    }
    if (result.bank_account_number_encrypted && result.bank_account_number_encrypted.includes(':')) {
      result.bank_account_number = decrypt(result.bank_account_number_encrypted);
    }
    if (result.bank_account_name && result.bank_account_name.includes(':')) {
      result.bank_account_name = decrypt(result.bank_account_name);
    }
  } catch (e) {
    console.warn('Failed to decrypt payment fields:', e.message);
  }
  return result;
}

// GET /api/payment/settings - Load payment settings
app.get('/api/payment/settings', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    const streamer = await db.getStreamer(actualUsername);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้' });

    const decrypted = decryptPaymentFields(streamer);
    res.json({
      payment_method: decrypted.payment_method || 'ffp',
      promptpay_phone: decrypted.promptpay_phone || '',
      promptpay_name: decrypted.promptpay_name || '',
      promptpay_enabled: decrypted.promptpay_enabled || 0,
      // Censor secrets — frontend detects '*' to avoid overwriting on save.
      tfp_api_key: censor(decrypted.tfp_api_key || ''),
      tfp_api_secret: censor(decrypted.tfp_api_secret || ''),
      tfp_connected: decrypted.tfp_connected || 0,
      tfp_last_check: decrypted.tfp_last_check || '',
      promptpay_type: decrypted.promptpay_type || 'phone',
      promptpay_value: censor(decrypted.promptpay_value || '', 3, 2),
      slipok_api: censor(decrypted.slipok_api || decrypted.truemoney_slipok_api || '', 8, 4),
      slipok_api_key: censor(decrypted.slipok_api_key || decrypted.truemoney_slipok_api_key || ''),
      slipok_connected: decrypted.slipok_connected || decrypted.truemoney_slipok_connected || 0,
      slipok_last_check: decrypted.slipok_last_check || '',
      truemoney_enabled: decrypted.truemoney_enabled || 0,
      truemoney_phone: censor(decrypted.truemoney_phone || '', 3, 2),
      truemoney_slipok_api: censor(decrypted.truemoney_slipok_api || '', 8, 4),
      truemoney_slipok_api_key: censor(decrypted.truemoney_slipok_api_key || ''),
      truemoney_slipok_connected: decrypted.truemoney_slipok_connected || 0,
      truemoney_slipok_last_check: decrypted.truemoney_slipok_last_check || '',
      truemoney_webhook_enabled: decrypted.truemoney_webhook_enabled || 0,
      truemoney_webhook_secret_set: !!streamer.truemoney_webhook_secret_encrypted,
      truemoney_webhook_methods: decrypted.truemoney_webhook_methods || 'P2P',
      truemoney_webhook_expiry: decrypted.truemoney_webhook_expiry || '',
      truemoney_webhook_kyc_confirmed: decrypted.truemoney_webhook_kyc_confirmed || 0,
      truemoney_promptpay_id: censor(decrypted.truemoney_promptpay_id || '', 3, 2),
      truemoney_webhook_tx_month: await db.countMonthlyWebhookTx(actualUsername),
      bank_enabled: decrypted.bank_enabled || 0,
      bank_name: decrypted.bank_name || '',
      bank_account_number: censor(decrypted.bank_account_number || '', 3, 2),
      bank_account_name: censor(decrypted.bank_account_name || '', 1, 1),
      // Boolean gate flags (Part 3) — not secrets, safe to send uncensored
      promptpay_account_verified: streamer.promptpay_account_verified || 0,
      bank_account_verified: streamer.bank_account_verified || 0,
      truemoney_account_verified: streamer.truemoney_account_verified || 0,
      // Timestamps (Part 4) — not secrets, safe to send uncensored
      promptpay_account_verified_at: streamer.promptpay_account_verified_at || null,
      bank_account_verified_at: streamer.bank_account_verified_at || null,
      truemoney_account_verified_at: streamer.truemoney_account_verified_at || null
    });
  } catch (err) {
    console.error('Get payment settings error:', err);
    if (err.message && (err.message.includes('502') || err.message.includes('SERVER_ERROR'))) {
      return res.status(502).json({ error: 'ระบบฐานข้อมูลขัดข้องชั่วคราว' });
    }
    res.status(500).json({ error: 'ไม่สามารถดึงการตั้งค่าการรับเงินได้' });
  }
});

// POST /api/payment/settings - Save payment settings
app.post('/api/payment/settings', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    const streamer = await db.getStreamer(actualUsername);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้' });

    // Reset-on-account-change: a previous slip-verified receiver stops proving anything once
    // the account value itself changes. Compare against the decrypted value, and skip censored
    // placeholders ('*') — those mean "unchanged", not "new value". Computed BEFORE the guard
    // block below so the guard sees the post-reset state, not the stale pre-reset DB value
    // (a same-request account-change + re-enable must still be blocked).
    const decrypted = decryptPaymentFields(streamer);
    const changedTo = (field, incoming) => !!incoming && !String(incoming).includes('*') && incoming !== (decrypted[field] || '');

    const resetFlags = {};
    if (changedTo('promptpay_value', req.body.promptpay_value)) resetFlags.promptpay_account_verified = 0;
    if (changedTo('bank_account_number', req.body.bank_account_number)) resetFlags.bank_account_verified = 0;
    if (changedTo('truemoney_phone', req.body.truemoney_phone)) resetFlags.truemoney_account_verified = 0;

    const updatedStreamer = await db.saveStreamer({
      twitch_id: req.user.twitch_id || null,
      streamlabs_id: req.user.streamlabs_id || null,
      username: actualUsername,
      payment_method: req.body.payment_method,
      promptpay_phone: req.body.promptpay_phone,
      promptpay_name: req.body.promptpay_name,
      promptpay_enabled: req.body.promptpay_enabled ? 1 : 0,
      promptpay_type: req.body.promptpay_type || 'phone',
      promptpay_value: req.body.promptpay_value || '',
      slipok_api: req.body.slipok_api || '',
      slipok_api_key: req.body.slipok_api_key || '',
      truemoney_enabled: req.body.truemoney_enabled ? 1 : 0,
      truemoney_phone: req.body.truemoney_phone || '',
      truemoney_slipok_api: req.body.truemoney_slipok_api || '',
      truemoney_slipok_api_key: req.body.truemoney_slipok_api_key || '',
      bank_enabled: req.body.bank_enabled ? 1 : 0,
      bank_name: req.body.bank_name || '',
      bank_account_number: req.body.bank_account_number || '',
      bank_account_name: req.body.bank_account_name || '',
      ...resetFlags
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Save payment settings error:', err);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าการรับเงินได้' });
  }
});

// SEC-003: Allowlist-based SSRF protection for SlipOK API URLs
function validateSlipOkUrl(url) {
  if (!url) throw new Error('SlipOK API URL is required');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('SlipOK API URL is not a valid URL'); }
  if (parsed.protocol !== 'https:') throw new Error('SlipOK API URL must use HTTPS');
  const allowed = ['api.slipok.com'];
  if (!allowed.includes(parsed.hostname)) {
    throw new Error(`SlipOK API hostname not allowed: ${parsed.hostname}`);
  }
}

// SlipOK error code → Thai user-facing message
const SLIPOK_ERROR_MAP = {
  1000: 'กรุณาใส่ข้อมูล QR Code ให้ครบ',
  1001: 'ไม่พบข้อมูลสาขา กรุณาตรวจสอบไอดีสาขา',
  1002: 'Authorization Header ไม่ถูกต้อง กรุณาตรวจสอบ API Key',
  1003: 'Package ของคุณหมดอายุแล้ว กรุณาต่ออายุแพ็กเกจใน Chat Line SlipOK',
  1004: 'Package ของคุณใช้เกินโควต้า กรุณาต่อสมาชิกแพ็กเกจใน Chat Line SlipOK',
  1005: 'ไฟล์ไม่ใช่ไฟล์ภาพ กรุณาอัพโหลดไฟล์เฉพาะนามสกุลที่กำหนด',
  1006: 'รูปภาพไม่ถูกต้อง หรือไฟล์เสีย',
  1007: 'รูปภาพไม่มี QR Code',
  1008: 'QR ดังกล่าวไม่ใช่ QR สำหรับการตรวจสอบการชำระเงิน',
  1009: 'ข้อมูลธนาคารขัดข้องชั่วคราว กรุณาลองใหม่ใน 15 นาที',
  1010: 'สลิปจากธนาคารนี้อยู่ระหว่างตรวจสอบ กรุณารอสักครู่',
  1011: 'QR Code หมดอายุ หรือไม่มีรายการอยู่จริง',
  1012: 'สลิปซ้ำ — สลิปนี้เคยถูกใช้งานแล้ว',
  1013: 'ยอดที่ส่งมาไม่ตรงกับยอดสลิป',
  1014: 'บัญชีผู้รับไม่ตรงกับบัญชีหลักของร้าน',
  1015: 'ไม่พบข้อมูล Package กรุณาตรวจสอบสิทธิ์แพ็กเกจ'
};

// Shared SlipOK slip-verification call — used by /api/verify-slip (donation flow).
// Normalizes both the success and failure shapes so callers don't duplicate SlipOK's
// error-code mapping.
async function callSlipOkVerify(branchUrl, apiKey, base64Image, amount) {
  try {
    const response = await axios.post(branchUrl, {
      files: base64Image,
      amount,
      log: true
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-authorization': apiKey
      },
      timeout: 30000
    });

    const slipData = response.data;
    const d = slipData?.data;
    if (slipData && slipData.success && d) {
      return { success: true, data: d, amount: d.amount || 0 };
    }

    const slipCode = slipData?.code;
    const mappedCode = slipCode === 1009 ? 'BANK_UNAVAILABLE' :
                       slipCode === 1010 ? 'SLIP_DELAY' :
                       slipCode === 1012 ? 'SLIP_DUPLICATE' :
                       slipCode === 1013 ? 'AMOUNT_MISMATCH' :
                       slipCode === 1014 ? 'WRONG_RECEIVER' :
                       'SLIP_INVALID';
    return { success: false, errorCode: mappedCode, error: slipData?.message || slipData?.error || 'สลิปไม่ถูกต้อง', delayMinutes: slipData?.delay || null };
  } catch (slipErr) {
    console.error('SlipOK verification error: code=' + (slipErr.response?.data?.code || slipErr.code || 'UNKNOWN'));
    if (slipErr.response) {
      const body = slipErr.response.data;
      const slipCode = body?.code;
      const mappedCode = slipCode === 1009 ? 'BANK_UNAVAILABLE' :
                         slipCode === 1010 ? 'SLIP_DELAY' :
                         slipCode === 1012 ? 'SLIP_DUPLICATE' :
                         slipCode === 1013 ? 'AMOUNT_MISMATCH' :
                         slipCode === 1014 ? 'WRONG_RECEIVER' :
                         'SLIPOK_ERROR';
      return { success: false, errorCode: mappedCode, error: body?.message || body?.error || 'SlipOK API error', delayMinutes: body?.delay || null };
    }
    return { success: false, errorCode: 'CONNECTION_FAILED', error: 'ไม่สามารถเชื่อมต่อ SlipOK ได้' };
  }
}

// POST /api/payment/test-tfp - Test TFP API connection
app.post('/api/payment/test-slipok', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const { slipok_api, slipok_api_key, method, promptpay_type, promptpay_value, truemoney_phone } = req.body;
    if (!slipok_api || !slipok_api_key) {
      return res.status(400).json({ error: 'กรุณากรอก API และ API Key' });
    }

    const isTruemoney = method === 'truemoney';
    const actualUsername = await getActualUsername(req.user);
    const twitchId = req.user.twitch_id || req.user.id;

    let realApi = slipok_api;
    let realApiKey = slipok_api_key;
    let realPromptpayValue = promptpay_value || '';
    let realTruemoneyPhone = truemoney_phone || '';
    let realPromptpayType = promptpay_type || 'phone';

    if (slipok_api.includes('*') || slipok_api_key.includes('*')) {
      const streamerForDecrypt = await db.getStreamer(actualUsername);
      if (streamerForDecrypt) {
        const decrypted = decryptPaymentFields(streamerForDecrypt);
        if (isTruemoney) {
          if (slipok_api.includes('*')) realApi = decrypted.truemoney_slipok_api || '';
          if (slipok_api_key.includes('*')) realApiKey = decrypted.truemoney_slipok_api_key || '';
          if (truemoney_phone && truemoney_phone.includes('*')) realTruemoneyPhone = decrypted.truemoney_phone || '';
        } else {
          if (slipok_api.includes('*')) realApi = decrypted.slipok_api || decrypted.truemoney_slipok_api || '';
          if (slipok_api_key.includes('*')) realApiKey = decrypted.slipok_api_key || decrypted.truemoney_slipok_api_key || '';
          if (promptpay_value && promptpay_value.includes('*')) realPromptpayValue = decrypted.promptpay_value || '';
        }
      }
    }

    if (!realApi || !realApiKey) {
      return res.status(400).json({ error: 'ไม่พบข้อมูล API ในระบบ กรุณากรอกใหม่' });
    }

    try { validateSlipOkUrl(realApi); } catch (e) {
      return res.status(400).json({ error: `SlipOK URL ไม่ถูกต้อง: ${e.message}` });
    }

    const branchUrl = realApi.endsWith('/quota') ? realApi.replace(/\/quota$/, '') : realApi;
    const quotaUrl = `${branchUrl}/quota`;

    const response = await axios.get(quotaUrl, {
      headers: {
        'x-authorization': realApiKey
      },
      timeout: 10000
    });

    const streamer = await db.getStreamer(actualUsername);

    function inferBasePlan(quota) {
      const plans = [100, 500, 1000, 2000, 5000, 10000];
      for (const plan of plans) {
        if (quota <= plan) return plan;
      }
      return Math.max(100, quota);
    }

    // Successful API test = streamer's own confirmation the receiver is bound in SlipOK
    // (SlipOK has no "list bound accounts" API to check this automatically) — trust it and
    // mark all 3 methods verified immediately. Only reset-on-account-change (payment/settings)
    // clears this; re-running the test here is how the streamer re-proves it after that.
    const now = new Date().toISOString();
    const verifiedFlags = {
      promptpay_account_verified: 1, promptpay_account_verified_at: now,
      bank_account_verified: 1, bank_account_verified_at: now,
      truemoney_account_verified: 1, truemoney_account_verified_at: now
    };

    if (isTruemoney) {
      const currentQuota = response.data?.data?.quota || 0;
      const existingTotal = streamer?.truemoney_slipok_quota_total || 0;
      const candidate = inferBasePlan(currentQuota);
      const newSnapshot = (!existingTotal || candidate > existingTotal) ? candidate : existingTotal;
      await db.saveStreamer({
        twitch_id: req.user.twitch_id || null,
        streamlabs_id: req.user.streamlabs_id || null,
        username: actualUsername,
        truemoney_slipok_connected: 1,
        truemoney_slipok_last_check: now,
        truemoney_phone: realTruemoneyPhone,
        truemoney_slipok_api: realApi,
        truemoney_slipok_api_key: realApiKey,
        truemoney_slipok_quota_total: newSnapshot,
        ...verifiedFlags
      });
    } else {
      const currentQuota = response.data?.data?.quota || 0;
      const existingTotal = streamer?.slipok_quota_total || 0;
      const candidate = inferBasePlan(currentQuota);
      const newSnapshot = (!existingTotal || candidate > existingTotal) ? candidate : existingTotal;
      await db.saveStreamer({
        twitch_id: req.user.twitch_id || null,
        streamlabs_id: req.user.streamlabs_id || null,
        username: actualUsername,
        slipok_connected: 1,
        slipok_last_check: now,
        promptpay_type: realPromptpayType,
        promptpay_value: realPromptpayValue,
        slipok_api: realApi,
        slipok_api_key: realApiKey,
        slipok_quota_total: newSnapshot,
        truemoney_slipok_connected: 1,
        truemoney_slipok_last_check: now,
        truemoney_slipok_api: realApi,
        truemoney_slipok_api_key: realApiKey,
        ...verifiedFlags
      });
    }

    res.json({ success: true, message: 'เชื่อมต่อ SlipOK สำเร็จ', quota: response.data?.data?.quota });
  } catch (err) {
    const slipCode = err.response?.data?.code;
    console.error('Test SlipOK error: code=' + (slipCode || err.response?.status || err.code || 'UNKNOWN'));
    const actualUsername = await getActualUsername(req.user);
    const isTruemoney = req.body.method === 'truemoney';
    try {
      const _ids = { twitch_id: req.user.twitch_id || null, streamlabs_id: req.user.streamlabs_id || null, username: actualUsername };
      if (isTruemoney) {
        await db.saveStreamer({ ..._ids, truemoney_slipok_connected: 0, truemoney_slipok_last_check: new Date().toISOString() });
      } else {
        await db.saveStreamer({ ..._ids, slipok_connected: 0, slipok_last_check: new Date().toISOString(), truemoney_slipok_connected: 0, truemoney_slipok_last_check: new Date().toISOString() });
      }
    } catch (ignore) {}

    const slipMsg = SLIPOK_ERROR_MAP[slipCode] || null;
    const errorMsg = slipMsg
      ? slipMsg
      : err.response
        ? (err.response.status === 401 || err.response.status === 403
            ? 'SlipOK API key ไม่ถูกต้องหรือไม่ได้รับอนุญาต'
            : err.response.status === 429
              ? 'SlipOK API ถูกใช้งานเกินโควต้า กรุณาตรวจสอบแพ็คเกจของคุณ'
              : `SlipOK ตอบกลับ HTTP ${err.response.status}`)
        : err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND'
          ? 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ SlipOK ได้'
          : err.code === 'ETIMEDOUT'
            ? 'หมดเวลาเชื่อมต่อกับ SlipOK'
            : `เกิดข้อผิดพลาด: ${err.message}`;

    res.status(502).json({ success: false, error: errorMsg, errorCode: slipCode || null });
  }
});

// GET /api/payment/slipok-quota — fetch live quota from SlipOK (read-only, no CSRF needed)
app.get('/api/payment/slipok-quota', ensureAuthenticated, slipokQuotaLimiter, async (req, res) => {
  try {
    const { method } = req.query;
    const actualUsername = await getActualUsername(req.user);
    const streamer = await db.getStreamer(actualUsername);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

    const decrypted = decryptPaymentFields(streamer);
    const isTruemoney = method === 'truemoney';
    const realApi = isTruemoney
      ? decrypted.truemoney_slipok_api
      : decrypted.slipok_api;
    const realApiKey = isTruemoney
      ? decrypted.truemoney_slipok_api_key
      : decrypted.slipok_api_key;

    if (!realApi || !realApiKey) {
      return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า SlipOK API' });
    }

    try { validateSlipOkUrl(realApi); } catch (e) {
      return res.status(400).json({ error: `SlipOK URL ไม่ถูกต้อง: ${e.message}` });
    }

    const branchUrl = realApi.endsWith('/quota')
      ? realApi.replace(/\/quota$/, '')
      : realApi;
    const quotaUrl = `${branchUrl}/quota`;

    const response = await axios.get(quotaUrl, {
      headers: { 'x-authorization': realApiKey },
      timeout: 10000
    });

    const q = response.data?.data || {};
    const quotaValue = q.quota || 0;

    function inferBasePlan(quota) {
      const plans = [100, 500, 1000, 2000, 5000, 10000];
      for (const plan of plans) {
        if (quota <= plan) return plan;
      }
      return Math.max(100, quota);
    }

    const _ids = { twitch_id: req.user.twitch_id || null, streamlabs_id: req.user.streamlabs_id || null, username: streamer.username };
    if (isTruemoney) {
      const existingTotal = streamer.truemoney_slipok_quota_total || 0;
      if (!existingTotal) {
        const inferred = inferBasePlan(quotaValue);
        try { await db.saveStreamer({ ..._ids, truemoney_slipok_quota_total: inferred }); } catch (e) {}
      }
    } else {
      const existingTotal = streamer.slipok_quota_total || 0;
      if (!existingTotal) {
        const inferred = inferBasePlan(quotaValue);
        try { await db.saveStreamer({ ..._ids, slipok_quota_total: inferred }); } catch (e) {}
      }
    }

    res.json({
      success: true,
      data: {
        quota: q.quota ?? null,
        overQuota: q.overQuota ?? 0,
        specialQuota: q.specialQuota ?? 0,
        endDate: q.endDate ?? null,
        method: isTruemoney ? 'truemoney' : 'promptpay',
        snapshotTotal: isTruemoney
          ? (inferBasePlan(quotaValue) || streamer.truemoney_slipok_quota_total)
          : (inferBasePlan(quotaValue) || streamer.slipok_quota_total)
      }
    });
  } catch (err) {
    const slipCode = err.response?.data?.code;
    console.error('SlipOK quota fetch error: code=' + (slipCode || err.response?.status || 'NO_RESPONSE'));

    // Auto-disconnect on quota fetch failure
    const actualUsername = await getActualUsername(req.user);
    const isTruemoney = req.query.method === 'truemoney';
    try {
      const _ids = { twitch_id: req.user.twitch_id || null, streamlabs_id: req.user.streamlabs_id || null, username: actualUsername };
      if (isTruemoney) {
        await db.saveStreamer({ ..._ids, truemoney_slipok_connected: 0, truemoney_slipok_last_check: new Date().toISOString() });
      } else {
        await db.saveStreamer({ ..._ids, slipok_connected: 0, slipok_last_check: new Date().toISOString(), truemoney_slipok_connected: 0, truemoney_slipok_last_check: new Date().toISOString() });
      }
    } catch (ignore) {}

    const status = err.response?.status || 500;
    res.status(status).json({ success: false, error: 'ไม่สามารถดึงข้อมูลโควต้าได้', errorCode: slipCode || null });
  }
});

/**
 * Generate PromptPay EMVCo QR payload
 * Based on Thai PromptPay standard (Tag 30: Merchant Account Info)
 */
function generatePromptPayPayload(phoneNumber, amount) {
  const phone = phoneNumber.replace(/[^0-9]/g, '');
  if (phone.length < 10) throw new Error('เบอร์โทรศัพท์ไม่ถูกต้อง (ต้องมีอย่างน้อย 10 หลัก)');

  const amountStr = amount ? amount.toFixed(2) : '';
  let normalizedPhone = phone;
  if (phone.startsWith('0')) {
    normalizedPhone = '66' + phone.substring(1);
  } else if (!phone.startsWith('66')) {
    normalizedPhone = '66' + phone;
  }
  const phoneInfo = `00${normalizedPhone}`;

  const tags = [];
  tags.push({ id: '00', value: '01' });
  tags.push({ id: '01', value: amount ? '12' : '11' });
  tags.push({ id: '29', value: `0016A00000067701011101${phoneInfo.length.toString().padStart(2, '0')}${phoneInfo}` });
  tags.push({ id: '58', value: 'TH' });
  tags.push({ id: '53', value: '764' });
  if (amountStr) tags.push({ id: '54', value: amountStr });

  let payload = '';
  tags.forEach(tag => {
    const len = tag.value.length.toString().padStart(2, '0');
    payload += `${tag.id}${len}${tag.value}`;
  });

  payload += '6304';
  const crc = crc16(payload);
  payload += crc.toString(16).toUpperCase().padStart(4, '0');

  return payload;
}

function generatePromptPayIdCardPayload(idCardNumber, amount) {
  const cleaned = idCardNumber.replace(/[^0-9]/g, '');
  if (cleaned.length !== 13) throw new Error('เลขบัตรประชาชนต้องมี 13 หลัก');

  const amountStr = amount ? amount.toFixed(2) : '';
  const idLen = cleaned.length.toString().padStart(2, '0');

  const tags = [];
  tags.push({ id: '00', value: '01' });
  tags.push({ id: '01', value: amount ? '12' : '11' });
  tags.push({ id: '29', value: `0016A00000067701011102${idLen}${cleaned}` });
  tags.push({ id: '58', value: 'TH' });
  tags.push({ id: '53', value: '764' });
  if (amountStr) tags.push({ id: '54', value: amountStr });

  let payload = '';
  tags.forEach(tag => {
    const len = tag.value.length.toString().padStart(2, '0');
    payload += `${tag.id}${len}${tag.value}`;
  });

  payload += '6304';
  const crc = crc16(payload);
  payload += crc.toString(16).toUpperCase().padStart(4, '0');

  return payload;
}

function generatePromptPayEWalletPayload(eWalletId, amount) {
  const cleaned = eWalletId.replace(/[^0-9]/g, '');
  if (cleaned.length !== 15) throw new Error('e-Wallet ID ต้องมี 15 หลัก');

  const amountStr = amount ? amount.toFixed(2) : '';
  const idLen = cleaned.length.toString().padStart(2, '0');

  const tags = [];
  tags.push({ id: '00', value: '01' });
  tags.push({ id: '01', value: amount ? '12' : '11' });
  tags.push({ id: '29', value: `0016A00000067701011103${idLen}${cleaned}` });
  tags.push({ id: '58', value: 'TH' });
  tags.push({ id: '53', value: '764' });
  if (amountStr) tags.push({ id: '54', value: amountStr });

  let payload = '';
  tags.forEach(tag => {
    const len = tag.value.length.toString().padStart(2, '0');
    payload += `${tag.id}${len}${tag.value}`;
  });

  payload += '6304';
  const crc = crc16(payload);
  payload += crc.toString(16).toUpperCase().padStart(4, '0');

  return payload;
}

function crc16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
  }
  return (crc & 0xFFFF);
}

// POST /api/truemoney/webhook - TrueMoney Wallet webhook (public)
const truemoneyWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many webhook requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/truemoney/create-qr - Create TrueMoney QR (public)
const truemoneyQrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'กรุณารอสักครู่ก่อนสร้าง QR ใหม่' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/donate/status/stream - Donation status SSE (public)
const donateStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many status connections' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/create-promptpay-qr - Create PromptPay QR for donation
const promptPayQrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'กรุณารอสักครู่ก่อนสร้าง QR ใหม่' }
});

// POST /api/truemoney/setup-webhook - Webhook connect/disconnect (authenticated) — F-02: throttle spam (each hit = 2 DB writes + JWT sign/verify)
const setupWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'คำขอมากเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/create-promptpay-qr', promptPayQrLimiter, async (req, res) => {
  try {
    if (!checkAntiBot(req, res)) return blockBot(req, res);
    const { username, amount, name, message, timerAction, tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd } = req.body;
    if (!username || !amount) return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    if (amount < 1) return res.status(400).json({ error: 'จำนวนเงินต้องมากกว่า 0' });

    await cleanupExpiredTransactionsWithR2();

    const pendingCount = await db.countPendingTransactions(username);
    if (pendingCount >= 50) {
      return res.status(429).json({ error: 'มีรายการค้างชำระมากเกินไป กรุณารอให้รายการเก่าหมดอายุก่อน' });
    }

    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
    if (!streamer.promptpay_enabled) return res.status(400).json({ error: 'ผู้ใช้ยังไม่ได้เปิด PromptPay' });

    const tierAssignment = computeTierAssignment(streamer, amount, { tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd });

    let phone = streamer.promptpay_value_encrypted || streamer.promptpay_phone;
    if (phone && phone.includes(':')) {
      try {
        phone = decrypt(phone);
      } catch (e) {
        console.error('Decrypt promptpay_value failed:', e.message);
        return res.status(400).json({ 
          error: 'ข้อมูล PromptPay ไม่ถูกต้อง', 
          details: 'ข้อมูลถูกเข้ารหัสด้วยคีย์ที่ไม่ตรงกัน กรุณาไปที่หน้า Dashboard > ตั้งค่าการชำระเงิน แล้วบันทึกข้อมูลพร้อมเพย์ใหม่อีกครั้ง'
        });
      }
    }
    if (!phone) return res.status(400).json({ error: 'ผู้ใช้ยังไม่ได้ตั้งค่าเบอร์ PromptPay' });

    const promptpayType = streamer.promptpay_type || 'phone';

    const referenceId = `donate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const qrPayload = promptpayType === 'idcard'
      ? generatePromptPayIdCardPayload(phone, amount)
      : promptpayType === 'ewallet'
        ? generatePromptPayEWalletPayload(phone, amount)
        : generatePromptPayPayload(phone, amount);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Record transaction
    const txData = {
      id: referenceId,
      amount,
      donor: name || 'Anonymous',
      message: message || '',
      status: 'pending',
      streamer_username: username,
      payment_method: 'promptpay',
      createdAt: new Date().toISOString(),
      timer_action: sanitizeTimerAction(timerAction),
      ...tierAssignment
    };
    await db.saveTransaction(txData);
    db.logIpEvent('donate_submit', req.ip, username, { amount, ref: referenceId }).catch(() => {});

    res.json({
      success: true,
      qrData: qrPayload,
      referenceId,
      expiresAt,
      recipientName: streamer.promptpay_name || streamer.username
    });
  } catch (err) {
    console.error('Create PromptPay QR error:', err);
    res.status(500).json({ error: 'ไม่สามารถสร้าง QR Code ได้' });
  }
});

// POST /api/truemoney/webhook - TrueMoney Open API webhook (public, JWT-signed)
app.post('/api/truemoney/webhook', truemoneyWebhookLimiter, async (req, res) => {
  try {
    const streamerId = req.query.streamerId;
    if (!streamerId) return res.status(400).json({ error: 'Missing streamerId' });

    const streamer = await db.getStreamer(streamerId);
    if (!streamer || streamer.truemoney_webhook_enabled !== 1) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (!streamer.truemoney_webhook_secret_encrypted) {
      return res.status(404).json({ error: 'Not found' }); // same as missing/disabled — no enumeration (Audit A2)
    }

    let secret;
    try {
      secret = decrypt(streamer.truemoney_webhook_secret_encrypted);
    } catch (e) {
      console.error('Failed to decrypt TrueMoney webhook secret:', e.message);
      return res.status(500).json({ error: 'Secret decryption failed' });
    }

    const token = typeof req.body === 'string' ? req.body : (req.body?.message || '');
    if (!token) return res.status(400).json({ error: 'Missing token' });

    let decoded;
    try {
      decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (e) {
      console.warn('TrueMoney webhook JWT verification failed:', e.message);
      return res.status(401).json({ error: 'Invalid JWT' });
    }

    if (decoded.event_type === 'DIRECT_TOPUP') {
      return res.json({ success: true, ignored: 'direct_topup' });
    }

    const allowedMethods = (streamer.truemoney_webhook_methods || '').split(',').filter(Boolean);
    if (!allowedMethods.includes(decoded.event_type)) {
      return res.json({ success: true, ignored: 'method_not_enabled' });
    }

    const eventHash = crypto.createHash('sha256')
      .update(`${decoded.refId || ''}:${decoded.amount}:${decoded.sender_mobile || ''}:${decoded.received_time}`)
      .digest('hex');

    const { duplicate } = await db.insertProcessedWebhook({
      streamer_username: streamerId,
      event_hash: eventHash,
      ref_id: decoded.refId || null,
      amount_satang: decoded.amount || 0,
      sender_mobile_masked: db.maskMobile ? db.maskMobile(decoded.sender_mobile) : '',
      event_type: decoded.event_type,
      received_time: decoded.received_time,
      matched: 0
    });
    if (duplicate) return res.json({ success: true, duplicate: true });

    let tx = null;
    let matched = false;

    if (decoded.event_type === 'P2P') {
      const refId = ((decoded.message || '').trim().match(/donate-[a-z0-9-]+/i) || [])[0];
      if (refId) {
        const candidate = await db.getTransactionById(refId);
        if (candidate &&
            candidate.status === 'pending' &&
            candidate.payment_method === 'truemoney_webhook' &&
            candidate.streamer_username === streamerId) {
          if (Math.abs((decoded.amount / 100) - candidate.amount) <= 1) {
            tx = candidate;
            matched = true;
          }
        }
      }
    } else if (decoded.event_type === 'PROMPTPAY_IN') {
      const candidates = await db.getPendingWebhookTxByAmount(streamerId, decoded.amount);
      if (candidates.length === 1) {
        tx = candidates[0];
        matched = true;
      }
    }

    if (matched && tx) {
      // Store minimal event as raw_webhook — sender_mobile masked (PDPA data-minimization, Audit A1)
      const safeWebhook = {
        event_type: decoded.event_type,
        amount: decoded.amount,
        refId: decoded.refId || null,
        received_time: decoded.received_time || null,
        sender_mobile: db.maskMobile ? db.maskMobile(decoded.sender_mobile) : undefined
      };
      await confirmDonationSideEffects(tx.id, { amount: tx.amount, rawWebhook: safeWebhook });
      broadcastDonateStatus(tx.id, { status: 'confirmed' });
      return res.json({ success: true, matched: true, refId: tx.id });
    }

    return res.json({ success: true, matched: false });
  } catch (err) {
    console.error('TrueMoney webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Minimal sanitize for TrueMoney webhook Key/รหัสลับ copied from the app.
// Key is a raw HS256 shared secret — no URL/JWT to parse (research 2026-07-14).
// ponytail: no parse branches — dead code per RT#3; sanitize+length only.
function parseTrueMoneyToken(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (s.length < 32) return { secret: null };
  return { secret: s };
}

// POST /api/truemoney/setup-webhook - Enable/disable TrueMoney webhook (authenticated)
app.post('/api/truemoney/setup-webhook', setupWebhookLimiter, ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const { action, token, methods, promptpayId, consented } = req.body;
    const streamer = await getStreamerForUser(req.user);
    const actualUsername = await getActualUsername(req.user);
    if (!streamer) return res.status(404).json({ error: 'Streamer not found' });

    const ids = { twitch_id: req.user.twitch_id || null, streamlabs_id: req.user.streamlabs_id || null, username: actualUsername };

    if (action === 'disable') {
      // keep kyc_confirmed so consent popup doesn't reappear on reconnect
      await db.saveStreamer({ ...ids, truemoney_webhook_enabled: 0 });
      return res.json({ success: true, enabled: false });
    }

    if (action !== 'enable') return res.status(400).json({ error: 'Invalid action' });

    const ALLOWED_METHODS = ['P2P', 'PROMPTPAY_IN'];
    const cleanMethods = (Array.isArray(methods) ? methods : [methods])
      .filter(Boolean)
      .filter(m => ALLOWED_METHODS.includes(m));
    if (cleanMethods.length === 0) {
      return res.status(400).json({ error: 'กรุณาเลือกวิธีรับเงินอย่างน้อย 1 วิธี' });
    }

    // consent gate — only first time (kyc_confirmed persists after first successful connect)
    if (Number(streamer.truemoney_webhook_kyc_confirmed) !== 1 && !consented) {
      return res.status(400).json({ error: 'กรุณายอมรับเงื่อนไข' });
    }

    const { secret } = parseTrueMoneyToken(token);
    if (!secret) {
      return res.status(400).json({ error: 'Key ไม่ถูกต้อง กรุณาคัดลอก Key/รหัสลับใหม่จากหน้าตั้งค่า Webhook ในแอพ TrueMoney' });
    }

    if (cleanMethods.includes('PROMPTPAY_IN')) {
      if (!promptpayId || !/^\d{15}$/.test(String(promptpayId).replace(/\D/g, ''))) {
        return res.status(400).json({ error: 'PromptPay e-Wallet ID must be 15 digits' });
      }
    }

    // fold test — sign+verify with the provided secret; catches EasyDonate token that passes length
    try {
      const testToken = jwt.sign({ event_type: 'TEST', amount: 0 }, secret, { algorithm: 'HS256' });
      jwt.verify(testToken, secret, { algorithms: ['HS256'] });
    } catch (e) {
      return res.status(400).json({ error: 'Key ใช้ไม่ได้ — ตรวจว่าคัดลอก "Key/รหัสลับ" จากหน้าตั้งค่า Webhook (ไม่ใช่ Token จากบริการอื่นเช่น EasyDonate)' });
    }

    let conflict = false;
    if (cleanMethods.includes('PROMPTPAY_IN') && streamer.promptpay_enabled === 1) {
      await db.saveStreamer({ ...ids, promptpay_enabled: 0 });
      conflict = true;
    }

    await db.saveStreamer({
      ...ids,
      truemoney_webhook_secret: secret,
      truemoney_webhook_enabled: 1,
      truemoney_webhook_kyc_confirmed: 1,
      truemoney_webhook_methods: cleanMethods.join(','),
      ...(cleanMethods.includes('PROMPTPAY_IN') ? { truemoney_promptpay_id: promptpayId } : {})
    });

    res.json({ success: true, enabled: true, methods: cleanMethods, connected: true, promptpaySlipokDisabled: conflict });
  } catch (err) {
    console.error('TrueMoney setup-webhook error:', err);
    res.status(500).json({ error: 'Failed to save webhook settings' });
  }
});

// POST /api/truemoney/create-qr - Create TrueMoney P2P or PromptPay QR (public)
app.post('/api/truemoney/create-qr', truemoneyQrLimiter, async (req, res) => {
  try {
    if (!checkAntiBot(req, res)) return blockBot(req, res);

    const { username, amount, name, message, timerAction, method, tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd } = req.body;
    if (!username || !amount) return res.status(400).json({ error: 'Missing username or amount' });
    if (amount < 1) return res.status(400).json({ error: 'Amount must be at least 1' });
    if (!['P2P', 'PROMPTPAY_IN'].includes(method)) {
      return res.status(400).json({ error: 'Invalid method' });
    }

    await cleanupExpiredTransactionsWithR2();
    const pendingCount = await db.countPendingTransactions(username);
    if (pendingCount >= 50) {
      return res.status(429).json({ error: 'Too many pending transactions' });
    }

    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'Streamer not found' });
    if (streamer.truemoney_webhook_enabled !== 1) {
      return res.status(400).json({ error: 'TrueMoney webhook not enabled' });
    }
    const allowedMethods = (streamer.truemoney_webhook_methods || 'P2P').split(',').filter(Boolean);
    if (!allowedMethods.includes(method)) {
      return res.status(400).json({ error: 'Method not enabled for this streamer' });
    }

    const refId = `donate-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    let qrData;
    let displayAmount = parseFloat(amount);

    if (method === 'P2P') {
      const decrypted = decryptPaymentFields(streamer);
      const phone = decrypted.truemoney_phone;
      if (!phone) return res.status(400).json({ error: 'TrueMoney phone not configured' });
      qrData = promptparse.generate.trueMoney({ mobileNo: phone, amount: parseFloat(amount), message: refId });
    } else {
      const decrypted = decryptPaymentFields(streamer);
      const promptpayId = decrypted.truemoney_promptpay_id;
      if (!promptpayId) return res.status(400).json({ error: 'PromptPay e-Wallet ID not configured' });
      const extraSatang = crypto.randomInt(1, 100) / 100;
      displayAmount = parseFloat(amount) + extraSatang;
      qrData = generatePromptPayPayload(promptpayId, displayAmount);
    }

    const tierAssignment = computeTierAssignment(streamer, parseFloat(amount), { tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd });

    await db.saveTransaction({
      id: refId,
      amount: displayAmount,
      donor: name || 'Anonymous',
      message: message || '',
      status: 'pending',
      streamer_username: username,
      payment_method: 'truemoney_webhook',
      createdAt,
      timer_action: sanitizeTimerAction(timerAction),
      ...tierAssignment
    });
    db.logIpEvent('donate_submit', req.ip, username, { amount: displayAmount, method, ref: refId }).catch(() => {});

    res.json({ success: true, qrData, referenceId: refId, expiresAt, method, displayAmount });
  } catch (err) {
    console.error('TrueMoney create-qr error:', err);
    res.status(500).json({ error: 'Failed to create QR' });
  }
});

// GET /api/donate/status/stream - Public SSE for donors waiting on a pending transaction
app.get('/api/donate/status/stream', donateStatusLimiter, async (req, res) => {
  const ref = (req.query.ref || '').trim();
  if (!/^donate-[a-z0-9-]{1,60}$/.test(ref)) {
    return res.status(400).json({ error: 'Invalid reference' });
  }
  if (sseClients.length >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Too many concurrent connections' });
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
  const clientObj = { res, validated: false, ref, authMethod: 'public', lastActivity: Date.now(), source: 'donate-status' };
  sseClients.push(clientObj);

  const keepAlive = setInterval(() => {
    try { res.write(`: keep-alive\n\n`); clientObj.lastActivity = Date.now(); }
    catch { /* connection lost */ }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(client => client.res !== res);
  });
});

// POST /api/verify-slip — actual slip upload (10/min per IP)
const uploadSlipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'ตรวจพบพฤติกรรมผิดปกติ หรืออัพโหลดถี่เกินไป' },
  handler: (req, res) => {
    console.warn(`⚠️ Rate limit hit on /api/verify-slip — IP: ${req.ip}`);
    res.status(429).json({ success: false, errorCode: 'RATE_LIMITED', error: 'ตรวจพบพฤติกรรมผิดปกติ หรืออัพโหลดถี่เกินไป' });
  }
});

// POST /api/verify-promptpay-slip — polling (20/min per IP, called every 3s)
const pollSlipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, errorCode: 'RATE_LIMITED', error: 'กรุณารอสักครู่' }
});

app.post('/api/verify-slip', sameOriginCheck, uploadSlipLimiter, upload.single('slip'), async (req, res) => {
  try {
    if (!checkAntiBot(req, res)) return blockBot(req, res);
    const { referenceId, amount, phone, method, username: bodyUsername, name: donorName, message: donorMessage, timerAction, tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd } = req.body;
    const donorTimerAction = sanitizeTimerAction(timerAction);
    const slipFile = req.file;

    if (!slipFile) return res.status(400).json({ success: false, errorCode: 'NO_FILE', error: 'กรุณาอัพโหลดไฟล์สลิป' });

    const isTruemoney = method === 'truemoney';
    let username = bodyUsername;

    if (referenceId) {
      const tx = await db.getTransactionById(referenceId);
      if (tx) {
        username = tx.streamer_username;
      }
    }

    if (!username) return res.status(400).json({ success: false, errorCode: 'NO_USER', error: 'ไม่พบข้อมูลผู้ใช้' });

    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ success: false, errorCode: 'NO_USER', error: 'ไม่พบผู้ใช้งาน' });

    const decrypted = decryptPaymentFields(streamer);
    let slipOkApi, slipOkApiKey;
    if (isTruemoney) {
      slipOkApi = decrypted.truemoney_slipok_api || decrypted.slipok_api;
      slipOkApiKey = decrypted.truemoney_slipok_api_key || decrypted.slipok_api_key;
    } else {
      // Fallback: user เก่าที่มีเฉพาะ truemoney_slipok_* ใช้ bank/promptpay ได้โดยไม่ต้อง re-test
      slipOkApi = decrypted.slipok_api || decrypted.truemoney_slipok_api;
      slipOkApiKey = decrypted.slipok_api_key || decrypted.truemoney_slipok_api_key;
    }

    if (!slipOkApi || !slipOkApiKey) {
      return res.status(503).json({ success: false, errorCode: 'SLIPOK_NOT_CONFIGURED', error: 'ผู้ใช้ยังไม่ได้ตั้งค่า SlipOK API' });
    }

    try { validateSlipOkUrl(slipOkApi); } catch (e) {
      return res.status(400).json({ success: false, errorCode: 'SLIPOK_URL_INVALID', error: `SlipOK URL ไม่ถูกต้อง: ${e.message}` });
    }

    // Guard 1: Reject if transaction already successful (prevents re-verifying completed payments)
    // SEC-002: Pre-load tx here so we can use tx.amount as authoritative expected amount below
    let pendingTx = null;
    if (referenceId) {
      pendingTx = await db.getTransactionById(referenceId);
      if (pendingTx && pendingTx.status === 'successful') {
        return res.json({ success: false, errorCode: 'ALREADY_VERIFIED', error: '✅ รายการนี้ได้รับการยืนยันเรียบร้อยแล้ว' });
      }
    }

    // Guard 2: Deduplicate slip by image hash (1 min TTL per streamer) — mark only on
    // terminal SlipOK outcome below (markSlipHashUsed), not here, so temporary failures
    // (network error, SLIP_DELAY) don't false-positive a retry of the same image.
    const slipHash = crypto.createHash('sha256').update(slipFile.buffer).digest('hex');
    if (!slipHashCache.has(username)) slipHashCache.set(username, new Set());
    if (slipHashCache.get(username).has(slipHash)) {
      return res.json({ success: false, errorCode: 'SLIP_DUPLICATE', error: 'ตรวจพบสลิปซ้ำ — สลิปนี้เคยถูกใช้ไปแล้ว' });
    }

    // Bugfix Part 1: create the pending tx for truemoney/bank direct-upload BEFORE calling
    // SlipOK, so a SlipOK rejection (e.g. 1014 wrong receiver) still leaves a visible pending
    // row in the streamer's history instead of vanishing silently.
    let effectiveReferenceId = referenceId;
    if (!effectiveReferenceId && (isTruemoney || method === 'bank')) {
      effectiveReferenceId = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const tierAssignment = computeTierAssignment(streamer, parseFloat(amount) || 0, { tierImageUrl, tierSoundUrl, tierSoundIsTemp, tierSoundMode, tierYoutubeId, tierYoutubeStart, tierYoutubeEnd });
      await db.saveTransaction({
        id: effectiveReferenceId,
        amount: parseFloat(amount) || 0,
        donor: donorName || 'Anonymous',
        message: donorMessage || '',
        status: 'pending',
        streamer_username: username,
        payment_method: method,
        createdAt: new Date().toISOString(),
        timer_action: donorTimerAction,
        ...tierAssignment
      });
      pendingTx = await db.getTransactionById(effectiveReferenceId);
    }

    const base64Image = slipFile.buffer.toString('base64');
    const branchUrl = slipOkApi.replace(/\/quota$/, '');

    // SEC-002: Use server-stored tx.amount as authoritative amount — client-supplied
    // amount=0 used to bypass the check when referenceId is present
    const authoritativeAmount = pendingTx ? parseFloat(pendingTx.amount) : parseFloat(amount) || 0;

    const result = await callSlipOkVerify(branchUrl, slipOkApiKey, base64Image, authoritativeAmount);

    if (result.success) {
      const d = result.data;
      const slipAmount = result.amount;

      if (authoritativeAmount > 0 && Math.abs(slipAmount - authoritativeAmount) > 0.01) {
        // Terminal: slip is genuine and already logged into SlipOK (slipData.success=true) —
        // re-uploading the same image will never pass, so mark it used.
        markSlipHashUsed(username, slipHash);
        return res.json({ success: false, errorCode: 'AMOUNT_MISMATCH', error: `ยอดเงินในสลิป (${slipAmount}฿) ไม่ตรงกับยอดที่ต้องชำระ (${authoritativeAmount}฿)`, referenceId: effectiveReferenceId });
      }

      if (effectiveReferenceId) {
        const tx = pendingTx;
        if (tx) {
          await confirmDonationSideEffects(effectiveReferenceId, {
            amount: tx.amount,
            extraTx: {
              streamer_username: tx.streamer_username,
              promptpay_verified: 1,
              promptpay_verified_at: new Date().toISOString(),
              promptpay_slip_id: d.transRef || null
            }
          });
          if (isTruemoney || method === 'bank') {
            db.logIpEvent('donate_submit', req.ip, username, { amount: tx.amount, method, ref: effectiveReferenceId }).catch(() => {});
          }
        }
      }

      markSlipHashUsed(username, slipHash);

      return res.json({
        success: true,
        amount: slipAmount,
        transRef: d.transRef,
        sender: d.sender?.displayName,
        receiver: d.receiver?.displayName,
        referenceId: effectiveReferenceId
      });
    }

    // Failure (terminal or temporary) — errorCode/error/delayMinutes come straight from the
    // shared helper. Terminal codes (dup/amount/wrong-receiver/invalid): mark used. SLIP_DELAY
    // (bank sync lag) and CONNECTION_FAILED/SLIPOK_ERROR stay temporary — donor can retry.
    if (TERMINAL_SLIP_CODES.has(result.errorCode)) markSlipHashUsed(username, slipHash);
    if (result.errorCode === 'BANK_UNAVAILABLE' && effectiveReferenceId) {
      const tx = pendingTx || await db.getTransactionById(effectiveReferenceId);
      if (tx && tx.status === 'pending') {
        await db.saveTransaction({ ...tx, id: effectiveReferenceId, status: 'failed' });
      }
    }
    const status = result.errorCode === 'CONNECTION_FAILED' ? 502 : 200;
    return res.status(status).json({ success: false, errorCode: result.errorCode, error: result.error, delayMinutes: result.delayMinutes, referenceId: effectiveReferenceId });
  } catch (err) {
    console.error('Verify slip error:', err);
    res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'เกิดข้อผิดพลาดในการตรวจสอบสลิป' });
  }
});

app.post('/api/verify-promptpay-slip', pollSlipLimiter, async (req, res) => {
  try {
    if (!checkAntiBot(req, res)) return blockBot(req, res);
    const { referenceId } = req.body;
    if (!referenceId) return res.status(400).json({ error: 'ไม่พบ Reference ID' });

    const tx = await db.getTransactionById(referenceId);
    if (!tx) return res.status(404).json({ error: 'ไม่พบรายการบริจาค' });
    if (tx.status === 'successful') return res.json({ verified: true, amount: tx.amount, donor: tx.donor });

    const streamer = await db.getStreamer(tx.streamer_username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบข้อมูลผู้ใช้' });
    const decrypted = decryptPaymentFields(streamer);

    const slipOkApi = decrypted.slipok_api;
    const slipOkApiKey = decrypted.slipok_api_key;

    if (!slipOkApi || !slipOkApiKey) {
      return res.status(503).json({
        error: 'ระบบเช็คสลิปไม่ทำงานชั่วคราว โปรดรอสักครู่แล้วลองใหม่',
        errorCode: 'SLIPOK_NOT_CONFIGURED'
      });
    }

    // Check if QR has expired
    const createdAt = new Date(tx.createdAt);
    if (Date.now() - createdAt.getTime() > 10 * 60 * 1000) {
      return res.json({ verified: false, expired: true });
    }

    // For polling, we just return pending since SlipOK requires an actual slip
    // Real verification happens through /api/verify-slip with slip upload
    res.json({ verified: false });
  } catch (err) {
    console.error('Verify PromptPay slip error:', err);
    res.status(500).json({ error: 'ไม่สามารถตรวจสอบการโอนได้' });
  }
});

// GET /api/page/:username/payment-methods - Public endpoint for available payment methods
app.get('/api/page/:username/payment-methods', async (req, res) => {
  try {
    const { username } = req.params;
    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });

    const method = streamer.payment_method || 'ffp';
    const decrypted = decryptPaymentFields(streamer);

    // เลขบัญชี/เบอร์ TrueMoney ส่งเต็มโดยเจตนา (donor ต้องใช้โอนเงิน — censor แล้ว flow พัง)
    // แต่ต้อง gate ด้วย enabled flag เสมอ — ปิดวิธีรับเงินแล้วข้อมูลต้องไม่หลุด (SECURITY_AUDIT_2026-07-07 MED-1/MED-2)
    const bankEnabled = streamer.bank_enabled === 1;
    const truemoneyEnabled = streamer.truemoney_enabled === 1;

    res.json({
      // FIXME: เมื่อ FFP พร้อมใช้งาน เปลี่ยนเป็น (method === 'ffp' || method === 'both')
      ffp: false,
      promptpay: streamer.promptpay_enabled === 1,
      truemoney: truemoneyEnabled,
      bank: bankEnabled,
      beam: method === 'ffp' || method === 'both',
      promptpay_name: streamer.promptpay_name || streamer.username,
      truemoney_phone: truemoneyEnabled ? (decrypted.truemoney_phone || '') : '',
      slipok_connected: streamer.slipok_connected === 1 || streamer.tfp_connected === 1 || streamer.truemoney_slipok_connected === 1,
      truemoney_slipok_connected: streamer.truemoney_slipok_connected === 1,
      truemoney_webhook: streamer.truemoney_webhook_enabled === 1,
      truemoney_webhook_methods: streamer.truemoney_webhook_enabled === 1 ? (streamer.truemoney_webhook_methods || 'P2P') : '',
      bank_name: bankEnabled ? (streamer.bank_name || '') : '',
      bank_account_number: bankEnabled ? (decrypted.bank_account_number || '') : '',
      bank_account_name: bankEnabled ? (decrypted.bank_account_name || '') : ''
    });
  } catch (err) {
    console.error('Get payment methods error:', err);
    if (err.message && (err.message.includes('502') || err.message.includes('SERVER_ERROR'))) {
      return res.status(502).json({ error: 'ระบบฐานข้อมูลขัดข้องชั่วคราว' });
    }
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลวิธีรับเงินได้' });
  }
});

const UPLOAD_MAX_SIZES = {
  avatar: 5 * 1024 * 1024,
  profile: 5 * 1024 * 1024,
  header: 5 * 1024 * 1024,
  pagebg: 5 * 1024 * 1024,
  sound: 1024 * 1024,
  video: 5 * 1024 * 1024,
  tierAlert: 5 * 1024 * 1024
};

// POST /api/upload/presign — generate Cloudflare R2 presigned upload URL
app.post('/api/upload/presign', presignLimiter, ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const { fileType, category, originalName, oldFileUrl, fileSize } = req.body;

    if (!category || !UPLOAD_ALLOWED_TYPES[category]) {
      return res.status(400).json({ error: 'category ไม่ถูกต้อง (avatar, sound, video)' });
    }
    if (!fileType || !UPLOAD_ALLOWED_TYPES[category].includes(fileType)) {
      return res.status(400).json({ error: `ประเภทไฟล์ไม่รองรับ: ${fileType}` });
    }
    const ANIMATED_TYPES = ['image/gif', 'image/webp', 'video/webm'];
    const isAnimated = ANIMATED_TYPES.includes(fileType);
    const maxAllowed = (category === 'tierAlert' && isAnimated) ? 2 * 1024 * 1024 : UPLOAD_MAX_SIZES[category];
    if (fileSize !== undefined && fileSize > maxAllowed) {
      return res.status(413).json({ error: `ไฟล์ใหญ่เกินกำหนด (สูงสุด ${Math.round(maxAllowed / 1024 / 1024)}MB)` });
    }

    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

    const ext = UPLOAD_EXT_MAP[fileType] || 'bin';
    const folder = UPLOAD_FOLDER_MAP[category];

    // Sound: preserve original filename (prefixed with streamer ID to prevent cross-user collision)
    // Images/video: use timestamp to avoid browser cache issues on re-upload
    let key;
    if (category === 'sound' && originalName) {
      const safeName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      key = `${folder}/${streamer.id}-${safeName}`;
    } else {
      key = `${folder}/${streamer.id}-${Date.now()}.${ext}`;
    }

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: fileType
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

    res.json({ uploadUrl, fileUrl });
  } catch (err) {
    console.error('❌ Presign error:', err);
    res.status(500).json({ error: 'ไม่สามารถสร้าง URL อัปโหลดได้' });
  }
});

// POST /api/upload/delete-file — delete old R2 object after successful upload
app.post('/api/upload/delete-file', presignLimiter, ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const { fileUrl, category } = req.body;
    if (!category || !UPLOAD_FOLDER_MAP[category]) {
      return res.status(400).json({ deleted: false, reason: 'invalid_category' });
    }
    if (!fileUrl) return res.json({ deleted: false, reason: 'no_url' });

    const r2Base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (!r2Base || !String(fileUrl).startsWith(r2Base + '/')) {
      return res.json({ deleted: false, reason: 'not_r2_url' });
    }

    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ deleted: false, reason: 'user_not_found' });

    const folder = UPLOAD_FOLDER_MAP[category];
    const key = String(fileUrl).slice(r2Base.length + 1).split('?')[0];
    const ownerPrefix = `${folder}/${streamer.id}`;
    const isSafeKey = !key.includes('..') && !key.includes('//') &&
      (key.startsWith(ownerPrefix + '-') || key.startsWith(ownerPrefix + '.'));

    if (!isSafeKey) {
      console.warn(`R2 delete blocked — key "${key}" not owned by streamer ${streamer.id} (expected prefix "${ownerPrefix}-")`);
      return res.json({ deleted: false, reason: 'not_owner' });
    }

    await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    console.log(`🗑️ R2 deleted: ${key}`);
    res.json({ deleted: true });
  } catch (err) {
    console.error('❌ R2 delete-file error:', err.message);
    res.status(500).json({ deleted: false, reason: 'server_error', error: err.message });
  }
});

// Custom 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(`Server Error [${req.method} ${req.originalUrl}]:`, err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

if (typeof require !== 'undefined' && require.main === module) {
  // Only listen when run directly (node src/server.js), not when imported (Vercel)
  const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
  app.listen(PORT, BIND_HOST, () => {
    console.log(`🌸 Stream Donation server running at http://${BIND_HOST}:${PORT}`);
    console.log(`📋 Environment: ${process.env.BEAM_ENV || 'sandbox'}`);
    console.log(`🎬 Overlay URL: http://localhost:${PORT}/overlay`);
    console.log(`🧪 Alert Test: http://localhost:${PORT}/alert-test`);
    console.log(`📊 Admin Panel: http://localhost:${PORT}/admin`);
  });

  // Memory monitoring — emergency only
  setInterval(() => {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    // Emergency: log if memory spikes
    if (rssMB > 300) {
      console.warn(`⚠️ High memory usage: RSS=${rssMB}MB heap=${heapMB}MB sseClients=${sseClients.length}`);
    }
  }, 60000);
}
