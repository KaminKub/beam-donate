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
const session = require('express-session');
const TursoStore = require('./sessionStore');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const TwitchStrategy = require('passport-twitch-new').Strategy;
const OAuth2Strategy = require('passport-oauth2').Strategy;


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
  video:   ['video/mp4', 'video/webm']
};
const UPLOAD_EXT_MAP = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm'
};
const UPLOAD_FOLDER_MAP = {
  avatar: 'avatars', profile: 'profiles', header: 'headers', pagebg: 'pagebg',
  sound: 'sounds', video: 'videos'
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

async function uploadAvatarFromUrl(imageUrl, twitchId) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    const ext = contentType.includes('webp') ? 'webp' : contentType.includes('png') ? 'png' : 'jpg';
    const key = `avatars/twitch_${twitchId}.${ext}`;
    return await uploadBufferToR2(Buffer.from(response.data), key, contentType);
  } catch (err) {
    console.error('❌ R2 avatar upload failed:', err.message);
    return null;
  }
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

// ค่าตั้งค่าเริ่มต้นของ Overlay
const defaultSettings = {
  duration: 8, // seconds
  soundEnabled: true,
  soundChoice: 'chime', // chime, retro, modern, bell, none
  soundVolume: 0.5,
  ttsEnabled: true,
  ttsVolume: 0.8,
  ttsRate: 1.0,
  ttsLanguage: 'th-TH',

  profanityFilterEnabled: true,
  profanityWords: 'ควย, เย็ด, สัส, เหี้ย, หี, แตด, ล่อ, ดอกทอง, ส้นตีน, อีดอก, อีเหี้ย, พ่อง, แม่มึง, กู, มึง',
  profanityReplaceStyle: 'asterisks', // asterisks, polite, block
  messageTemplate: '{donor} ได้บริจาค {amount} บาท! 🎉',
  showLabel: false,
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
  goal_subtitle1: '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿',
  goal_subtitle2: 'ปิดหลอดใน {วันคงเหลือ} วัน',
  goal_anim_sound: true,
  goal_bar_position: 'top'
};

// ========== SSE Alert System ==========
const MAX_SSE_CLIENTS = 500;
const SSE_CLIENT_TTL = 5 * 60 * 1000;
let sseClients = [];
const tokenCache = new Map(); // token → { username, cachedAt }
const TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 min
const disconnectTimers = new Map(); // username → setTimeout (5s grace before logging disconnect)
const slipHashCache = new Map(); // username → Set of base64 hashes (5 min TTL against slip re-submit)

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
// When adding a new SSE source: update ALL four functions above.
// ──────────────────────────────────────────────────────────────────────
function broadcastAlert(username, alertData) {
  let payload = alertData;
  if (alertData.type === 'donation') {
    const overlayOnline = sseClients.some(c => c.username === username && c.source === 'overlay');
    payload = { ...alertData, overlayOnline };
  }
  const data = JSON.stringify(payload);
  console.log(`📢 [Broadcast] Sending to ${username}:`, alertData.type);

  sseClients = sseClients.filter(client => {
    // Never send real broadcasts to any demo client (demo-overlay or demo-goal-bar)
    const isDemo = client.source === 'demo-overlay' || client.source === 'demo-goal-bar';
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

function broadcastGoalUpdate(username, streamer) {
  if (!streamer.goal_enabled) return;
  const payload = JSON.stringify({
    type: 'goal_update',
    current: streamer.goal_current,
    amount: streamer.goal_amount,
    label: streamer.goal_label,
    barColor: streamer.goal_bar_color,
    barText: streamer.goal_bar_text,
    subtitle1: streamer.goal_subtitle1,
    subtitle2: streamer.goal_subtitle2,
    endDate: streamer.goal_end_date
  });
  sseClients
    .filter(c => c.username === username && c.source !== 'demo-overlay' && c.source !== 'demo-goal-bar')
    .forEach(c => {
      try {
        c.res.write(`data: ${payload}\n\n`);
        c.lastActivity = Date.now();
      } catch (err) {
        console.error(`❌ [BroadcastGoal] Failed to write to client ${username}:`, err.message);
      }
    });
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
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
        connectSrc: ["'self'", 'https://www.myinstants.com', 'https://*.r2.cloudflarestorage.com', 'https://cdn.jsdelivr.net'],
        workerSrc: ["'self'", 'blob:'],
        mediaSrc: ["'self'", 'https://translate.google.com', 'https://www.myinstants.com', 'data:', process.env.R2_PUBLIC_URL || 'https://pub-db8500a3bce347deb31e3ac1eb556de8.r2.dev'],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://streamlabs.com', 'https://id.twitch.tv']
      }
    },
    crossOriginEmbedderPolicy: false
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

// SECURITY: Block direct access to /dashboard via express.static, but allow static assets
app.use((req, res, next) => {
  // Exclude /demo/* from auth guard — demo dashboard is intentionally public
  if (req.path.startsWith('/demo/')) return next();
  if (req.path.startsWith('/dashboard') || req.path.match(/\/\w+\/dashboard/)) {
    if (!req.isAuthenticated() && !req.path.match(/\.(css|js|jpg|jpeg|png|gif|svg|woff|woff2|ttf|otf)$/)) {
      return res.redirect('/login');
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
        obj.username = streamer.username;
        obj.twitch_id = streamer.twitch_id;
        obj.streamlabs_id = streamer.streamlabs_id;
      }
    } else {
      streamer = await db.getStreamerById(obj);
      if (streamer) return done(null, streamer);
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
    'showLabel', 'showDonorMessage',
    'messageTemplate', 'amountSuffix', 'minAmount',
    'profanityFilterEnabled', 'profanityWords', 'profanityReplaceStyle',
    'theme', 'fontFamily', 'animation',
    'primaryColor', 'secondaryColor', 'textColor', 'backgroundColor', 'borderColor',
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
    // Goal bar
    'goal_enabled', 'goal_amount', 'goal_current', 'goal_label', 'goal_bar_color',
    'goal_show_on_donate', 'goal_end_date', 'goal_bar_text',
    'goal_subtitle1', 'goal_subtitle2', 'goal_anim_sound', 'goal_bar_position',
    // Streamlabs display name (not tokens)
    'streamlabs_username',
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

app.get('/api/demo/settings', demoRateLimiter, async (req, res) => {
  try {
    const row = await db.getStreamer(DEMO_STREAMER_USERNAME);
    if (!row) return res.status(503).json({ error: 'Demo data unavailable' });
    const masked = applyDemoMask(row);
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
    res.json(applyDemoMask(row));
  } catch (e) {
    console.error('💥 Demo overlay settings error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

const MAX_DEMO_SSE_CLIENTS = 50;
const MAX_DEMO_SSE_PER_IP = 3;

const ALLOWED_DEMO_SOURCES = new Set(['demo-overlay', 'demo-goal-bar']);

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
  const clientObj = { res, validated: false, username: DEMO_STREAMER_USERNAME, authMethod: 'demo', lastActivity: now, source: clientSource, ip: clientIp };
  sseClients.push(clientObj);
  req.on('close', () => {
    const idx = sseClients.indexOf(clientObj);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

app.get('/demo/overlay', demoRateLimiter, (req, res) => {
  const filePath = path.join(__dirname, '../public/overlay.html');
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
  const goalData = {
    type: 'goal_update',
    current: Math.max(0, Math.min(parseFloat(current) || 0, 99999)),
    amount:  Math.max(1, Math.min(parseFloat(amount)  || 5000, 9999999)),
    label:   String(label   || 'ค่ากาแฟ').slice(0, 60),
    barColor: String(barColor || '#4ade80').slice(0, 20),
    barText:  String(barText  || '{เปอร์เซนต์}').slice(0, 60),
    subtitle1: String(subtitle1 || '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿').slice(0, 80),
    subtitle2: String(subtitle2 || '').slice(0, 80),
    endDate: null
  };
  broadcastDemoGoalBar(DEMO_STREAMER_USERNAME, goalData);
  res.json({ success: true });
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
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/login', redirectIfAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/register', redirectIfAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/register.html'));
});

app.get('/register/setup', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../public/register-setup.html'));
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
  
  const { username } = req.body;
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
      const r2Url = await uploadAvatarFromUrl(avatarUrl, avatarUploadId);
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
      profile_image_source: avatarUrl ? (pending.streamlabsPlatform || (pending.streamlabsId ? 'streamlabs' : 'twitch')) : null
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
          return res.redirect('/register');
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
  for (const key of PLATFORM_KEYS) {
    const p = userData[key];
    if (p && p.id) {
      return {
        platformId: String(p.id),
        platformType: key,
        platformName: p.display_name || p.name || p.username || p.title || null,
        platformImage: p.profile_image_url || p.thumbnail_url || p.icon_url || p.avatar || p.thumbnail || p.picture || p.logo || p.profile_picture || p.image || null
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
  const sl = userData.streamlabs;
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
      
      // Create a session for this user
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
        return res.redirect('/register');
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
  res.sendFile(path.join(__dirname, '../public/login-failed.html'));
});

app.get('/thank-you', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/thank-you.html'));
});

app.get('/goal-bar', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/goal-bar/index.html'));
});

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay.html'));
});

app.get('/alert-test', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/alert-test.html'));
});

app.get('/admin', async (req, res) => {
  if (req.isAuthenticated()) {
    try {
      const streamer = await getStreamerForUser(req.user);
      if (streamer) {
        return res.redirect(`/${streamer.username.toLowerCase()}/dashboard`);
      }
    } catch (err) {
      console.error('Admin redirect error:', err);
    }
  }
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, '../public')));

// API: สร้าง Donation (Payment Link)
app.post('/api/create-charge', createChargeLimiter, async (req, res) => {
  try {
    const { amount, name, message, username } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
    if (!username) return res.status(400).json({ error: 'ไม่ระบุชื่อผู้รับบริจาค' });

    const streamer = await db.getDecryptedStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้รับบริจาคในระบบ' });

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
      streamer_username: username
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
      await logTransaction({
        id: targetId,
        streamer_username: tx?.streamer_username,
        amount: amount || (tx ? tx.amount : 0),
        status: 'successful',
        paidAt: new Date().toISOString(),
        raw_webhook: event
      });
      const txDetails = (await db.getTransactionById(targetId)) || {};
      
      broadcastAlert(txDetails.streamer_username, {
        type: 'donation',
        donor: txDetails.donor || 'Anonymous',
        amount: amount || txDetails.amount || 0,
        message: txDetails.message || charge.description || '',
        timestamp: new Date().toISOString()
      });

      // Update donation goal if enabled
      const finalAmount = amount || txDetails.amount || 0;
      if (txDetails.streamer_username && finalAmount > 0) {
        try {
          const streamer = await db.getStreamer(txDetails.streamer_username);
          if (streamer && streamer.goal_enabled) {
            const updated = await db.updateGoalCurrent(streamer.id, finalAmount);
            broadcastGoalUpdate(streamer.username, { ...streamer, ...updated });
          }
        } catch (e) {
          console.error('Goal update after webhook failed:', e.message);
        }
      }
    }
    res.json({ received: true });
  } catch (error) {
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

const RESERVED_WORDS = [
  'login', 'auth', 'api', 'overlay', 'alert-test', 'thank-you', 'register',
  'admin', 'demo', 'health', 'goal-bar', 'webhook', 'login-failed',
  'privacy', 'terms-of-services',
];

function isReservedPath(path) {
  const firstSegment = path.split('/')[1];
  return RESERVED_WORDS.includes(firstSegment);
}

async function validateUsername(req, res, next) {
  const { username } = req.params;
  if (isReservedPath(req.path)) return next();
  try {
    const user = await db.getStreamer(username);
    if (user) {
      req.streamer = user;
      next();
    } else {
      res.status(404).send('ไม่พบผู้ใช้งานรายนี้ในระบบ');
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
    return res.redirect('/forbidden.html?reason=owner');
  }
  res.redirect('/login');
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
        if (streamer) {
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
      (t.donor || 'Anonymous').replace(/"/g, '""'),
      Number(t.amount) || 0,
      (t.message || '').replace(/"/g, '""'),
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

app.get('/api/transactions/:username', ensureAuthenticated, async (req, res) => {
  const { username } = req.params;
  const actualUsername = await getActualUsername(req.user);
  
  if (actualUsername !== username.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: คุณไม่มีสิทธิ์เข้าถึงข้อมูลของผู้อื่น' });
  }
  
  try {
    await db.cleanupExpiredTransactions();
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
    const expiredCount = await db.cleanupExpiredTransactions();
    const deletedCount = await db.hardDeleteExpiredTransactions();
    res.json({ success: true, expired: expiredCount, deleted: deletedCount });
  } catch (err) {
    console.error('Cron cleanup-expired error:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

app.post('/api/cron/cleanup-quarterly', checkCronAuth, async (req, res) => {
  try {
    const months = parseInt(req.body?.months, 10) || 3;
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

    const updatedTx = await db.saveTransaction({ ...tx, id, status });
    if (status === 'successful') {
      const txDetails = await db.getTransactionById(id);
      broadcastAlert(txDetails.streamer_username, {
        type: 'donation',
        donor: updatedTx.donor || 'Anonymous',
        amount: updatedTx.amount || 0,
        message: updatedTx.message || '',
        timestamp: new Date().toISOString(),
        isManualTrigger: true
      });

      const finalAmount = updatedTx.amount || 0;
      if (txDetails.streamer_username && finalAmount > 0) {
        try {
          const streamer = await db.getStreamer(txDetails.streamer_username);
          if (streamer && streamer.goal_enabled) {
            const updated = await db.updateGoalCurrent(streamer.id, finalAmount);
            broadcastGoalUpdate(streamer.username, { ...streamer, ...updated });
          }
        } catch (e) {
          console.error('Goal update after manual confirm failed:', e.message);
        }
      }
    }
    res.json({ success: true, transaction: updatedTx });
  } catch (err) {
    console.error('Error updating transaction status:', err);
    res.status(500).json({ error: 'ไม่สามารถอัปเดตสถานะได้' });
  }
});

function determinePrimaryAuth(streamerRow) {
  const hasTwitch = !!streamerRow.twitch_id;
  const hasStreamlabs = !!streamerRow.streamlabs_id;
  if (hasTwitch && !hasStreamlabs) return 'twitch';
  if (!hasTwitch && hasStreamlabs) return 'streamlabs';
  if (hasTwitch && hasStreamlabs && streamerRow.twitch_id === streamerRow.streamlabs_id) return 'streamlabs';
  return 'twitch';
}

app.get('/api/user/me', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    const streamer = await db.getStreamer(actualUsername);
    if (!streamer) return res.status(404).json({ error: 'User not found in database' });

    const profileImage = await db.resolveProfileImage(streamer);

    res.json({
      username: streamer.username,
      twitchId: streamer.twitch_id,
      streamlabsId: streamer.streamlabs_id,
      authProvider: determinePrimaryAuth(streamer),
      email: req.user.email || 'Not provided',
      slipok_connected: !!streamer.slipok_connected,
      truemoney_slipok_connected: !!streamer.truemoney_slipok_connected,
      profileImage,
      profileGlowColor: streamer.profile_glow_color || '#005704'
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
        if (streamer) {
          username = streamer.username;
        }
      }
    }
 
    if (!username) {
      return res.status(401).json({ error: 'Unauthorized: Please log in or provide a valid token' });
    }
 
    const settings = await db.getSettings(username, defaultSettings);
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
  'soundEnabled', 'soundChoice', 'soundVolume', 'customSoundUrl',
  'ttsEnabled', 'ttsReadDonor', 'ttsPrefixEnabled', 'ttsLanguage', 'ttsVolume', 'ttsRate',
  'messageTemplate', 'amountSuffix', 'showLabel', 'showDonorMessage', 'minAmount',
  'profanityFilterEnabled', 'profanityWords', 'profanityReplaceStyle',
  'customImageMode', 'customImageValue',
  'goal_enabled', 'goal_amount', 'goal_current',
  'goal_label', 'goal_bar_color', 'goal_show_on_donate',
  'goal_end_date', 'goal_bar_text', 'goal_subtitle1', 'goal_subtitle2',
  'goal_anim_sound', 'goal_bar_position'
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

    const updatedStreamer = await db.saveStreamer({
      twitch_id: req.user.twitch_id || null,
      streamlabs_id: req.user.streamlabs_id || null,
      username: actualUsername,
      ...safeBody
    });
    
    broadcastAlert(actualUsername, { type: 'settings_update', settings: updatedStreamer });
    res.json({ success: true, settings: updatedStreamer });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าได้' });
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
    broadcastGoalUpdate(actualUsername, { ...streamer, goal_current: updated.goal_current });
    res.json({ success: true, current: updated.goal_current });
  } catch (error) {
    console.error('Goal adjust error:', error);
    res.status(500).json({ error: 'ไม่สามารถปรับยอดได้' });
  }
});

app.post('/api/goal/reset', ensureAuthenticated, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerForUser(req.user);
    if (!streamer) return res.status(404).json({ error: 'streamer not found' });
    const updated = await db.resetGoalCurrent(streamer.id);
    const actualUsername = await getActualUsername(req.user);
    broadcastGoalUpdate(actualUsername, { ...streamer, goal_current: 0 });
    res.json({ success: true });
  } catch (error) {
    console.error('Goal reset error:', error);
    res.status(500).json({ error: 'ไม่สามารถรีเซ็ตได้' });
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
      socials: {
        twitch: streamer.social_twitch,
        youtube: streamer.social_youtube,
        tiktok: streamer.social_tiktok,
        facebook: streamer.social_facebook,
        x: streamer.social_x,
        discord: streamer.social_discord,
        instagram: streamer.social_instagram,
      }
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
    
    broadcastAlert(actualUsername, alertData);
    res.json({ success: true, alert: alertData });
  } catch (err) {
    console.error('Test alert error:', err);
    res.status(500).json({ error: 'ไม่สามารถส่ง Alert ทดสอบได้' });
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

app.get('/api/myinstants/search', ensureAuthenticated, myinstantsLimiter, async (req, res) => {
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
});

app.get('/api/myinstants/pages', ensureAuthenticated, (req, res) => {
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
  res.sendFile(path.join(__dirname, '../public/overlay.html'));
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
      slipok_api: censor(decrypted.slipok_api || '', 8, 4),
      slipok_api_key: censor(decrypted.slipok_api_key || ''),
      slipok_connected: decrypted.slipok_connected || 0,
      slipok_last_check: decrypted.slipok_last_check || '',
      truemoney_enabled: decrypted.truemoney_enabled || 0,
      truemoney_phone: censor(decrypted.truemoney_phone || '', 3, 2),
      truemoney_slipok_api: censor(decrypted.truemoney_slipok_api || '', 8, 4),
      truemoney_slipok_api_key: censor(decrypted.truemoney_slipok_api_key || ''),
      truemoney_slipok_connected: decrypted.truemoney_slipok_connected || 0,
      truemoney_slipok_last_check: decrypted.truemoney_slipok_last_check || ''
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
      truemoney_slipok_api_key: req.body.truemoney_slipok_api_key || ''
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
          if (slipok_api.includes('*')) realApi = decrypted.slipok_api || '';
          if (slipok_api_key.includes('*')) realApiKey = decrypted.slipok_api_key || '';
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

    if (isTruemoney) {
      const currentQuota = response.data?.data?.quota || 0;
      const existingTotal = streamer?.truemoney_slipok_quota_total || 0;
      const candidate = inferBasePlan(currentQuota);
      const newSnapshot = (!existingTotal || candidate > existingTotal) ? candidate : existingTotal;
      await db.saveStreamer({
        twitch_id: twitchId,
        truemoney_slipok_connected: 1,
        truemoney_slipok_last_check: new Date().toISOString(),
        truemoney_phone: realTruemoneyPhone,
        truemoney_slipok_api: realApi,
        truemoney_slipok_api_key: realApiKey,
        truemoney_slipok_quota_total: newSnapshot
      });
    } else {
      const currentQuota = response.data?.data?.quota || 0;
      const existingTotal = streamer?.slipok_quota_total || 0;
      const candidate = inferBasePlan(currentQuota);
      const newSnapshot = (!existingTotal || candidate > existingTotal) ? candidate : existingTotal;
      await db.saveStreamer({
        twitch_id: twitchId,
        slipok_connected: 1,
        slipok_last_check: new Date().toISOString(),
        promptpay_type: realPromptpayType,
        promptpay_value: realPromptpayValue,
        slipok_api: realApi,
        slipok_api_key: realApiKey,
        slipok_quota_total: newSnapshot
      });
    }

    res.json({ success: true, message: 'เชื่อมต่อ SlipOK สำเร็จ', quota: response.data?.data?.quota });
  } catch (err) {
    console.error('Test SlipOK error:', err);
    const actualUsername = await getActualUsername(req.user);
    const isTruemoney = req.body.method === 'truemoney';
    try {
      const _ids = { twitch_id: req.user.twitch_id || null, streamlabs_id: req.user.streamlabs_id || null, username: actualUsername };
      if (isTruemoney) {
        await db.saveStreamer({ ..._ids, truemoney_slipok_connected: 0, truemoney_slipok_last_check: new Date().toISOString() });
      } else {
        await db.saveStreamer({ ..._ids, slipok_connected: 0, slipok_last_check: new Date().toISOString() });
      }
    } catch (ignore) {}

    const errorMsg = err.response
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

    res.status(502).json({ success: false, error: errorMsg });
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
    console.error('SlipOK quota fetch error:', err.response?.status || 'NO_RESPONSE', err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: 'ไม่สามารถดึงข้อมูลโควต้าได้' });
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

// POST /api/create-promptpay-qr - Create PromptPay QR for donation
const promptPayQrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'กรุณารอสักครู่ก่อนสร้าง QR ใหม่' }
});

app.post('/api/create-promptpay-qr', promptPayQrLimiter, async (req, res) => {
  try {
    if (!checkAntiBot(req, res)) return blockBot(req, res);
    const { username, amount, name, message } = req.body;
    if (!username || !amount) return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    if (amount < 1) return res.status(400).json({ error: 'จำนวนเงินต้องมากกว่า 0' });

    await db.cleanupExpiredTransactions();

    const pendingCount = await db.countPendingTransactions(username);
    if (pendingCount >= 50) {
      return res.status(429).json({ error: 'มีรายการค้างชำระมากเกินไป กรุณารอให้รายการเก่าหมดอายุก่อน' });
    }

    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
    if (!streamer.promptpay_enabled) return res.status(400).json({ error: 'ผู้ใช้ยังไม่ได้เปิด PromptPay' });

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
      createdAt: new Date().toISOString()
    };
    await db.saveTransaction(txData);

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

app.post('/api/verify-slip', uploadSlipLimiter, upload.single('slip'), async (req, res) => {
  try {
    if (!checkAntiBot(req, res)) return blockBot(req, res);
    const { referenceId, amount, phone, method, username: bodyUsername } = req.body;
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
      slipOkApi = decrypted.slipok_api;
      slipOkApiKey = decrypted.slipok_api_key;
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

    // Guard 2: Deduplicate slip by image hash (1 min TTL per streamer)
    const slipHash = crypto.createHash('sha256').update(slipFile.buffer).digest('hex');
    if (!slipHashCache.has(username)) slipHashCache.set(username, new Set());
    if (slipHashCache.get(username).has(slipHash)) {
      return res.json({ success: false, errorCode: 'SLIP_DUPLICATE', error: 'ตรวจพบสลิปซ้ำ — สลิปนี้เคยถูกใช้ไปแล้ว' });
    }
    slipHashCache.get(username).add(slipHash);
    // Auto-expire hash after 1 min
    setTimeout(() => {
      const set = slipHashCache.get(username);
      if (set) set.delete(slipHash);
    }, 60 * 1000);

    const base64Image = slipFile.buffer.toString('base64');
    const branchUrl = slipOkApi.replace(/\/quota$/, '');

    // SEC-002: Use server-stored tx.amount as authoritative amount — client-supplied
    // amount=0 used to bypass the check when referenceId is present
    const authoritativeAmount = pendingTx ? parseFloat(pendingTx.amount) : parseFloat(amount) || 0;

    try {
      const slipOkResponse = await axios.post(branchUrl, {
        files: base64Image,
        amount: authoritativeAmount,
        log: true
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-authorization': slipOkApiKey
        },
        timeout: 30000
      });

      const slipData = slipOkResponse.data;
      const d = slipData?.data;
      const slipAmount = d?.amount || 0;

      if (slipData && slipData.success && d) {
        if (authoritativeAmount > 0 && Math.abs(slipAmount - authoritativeAmount) > 0.01) {
          return res.json({ success: false, errorCode: 'AMOUNT_MISMATCH', error: `ยอดเงินในสลิป (${slipAmount}฿) ไม่ตรงกับยอดที่ต้องชำระ (${authoritativeAmount}฿)` });
        }

        if (referenceId) {
          const tx = pendingTx;
          if (tx) {
            await db.saveTransaction({
              id: referenceId,
              streamer_username: tx.streamer_username,
              status: 'successful',
              promptpay_verified: 1,
              promptpay_verified_at: new Date().toISOString(),
              promptpay_slip_id: d.transRef || null,
              paidAt: new Date().toISOString()
            });

            broadcastAlert(tx.streamer_username, {
              type: 'donation',
              donor: tx.donor,
              amount: tx.amount,
              message: tx.message
            });

            // Update donation goal if enabled
            if (tx.streamer_username && tx.amount > 0) {
              try {
                const goalStreamer = await db.getStreamer(tx.streamer_username);
                if (goalStreamer && goalStreamer.goal_enabled) {
                  const goalUpdated = await db.updateGoalCurrent(goalStreamer.id, tx.amount);
                  broadcastGoalUpdate(goalStreamer.username, { ...goalStreamer, ...goalUpdated });
                }
              } catch (e) {
                console.error('Goal update after slip verify failed:', e.message);
              }
            }
          }
        } else if (isTruemoney) {
          const referenceIdNew = `truemoney-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          await db.saveTransaction({
            id: referenceIdNew,
            amount: parseFloat(amount) || 0,
            donor: phone || 'Anonymous',
            message: '',
            status: 'successful',
            streamer_username: username,
            payment_method: 'truemoney',
            promptpay_verified: 1,
            promptpay_verified_at: new Date().toISOString(),
            promptpay_slip_id: d.transRef || null,
            paidAt: new Date().toISOString(),
            createdAt: new Date().toISOString()
          });

          broadcastAlert(username, {
            type: 'donation',
            donor: phone || 'Anonymous',
            amount: parseFloat(amount) || 0,
            message: ''
          });

          // Update donation goal if enabled
          const finalAmount = parseFloat(amount) || 0;
          if (username && finalAmount > 0) {
            try {
              const goalStreamer = await db.getStreamer(username);
              if (goalStreamer && goalStreamer.goal_enabled) {
                const goalUpdated = await db.updateGoalCurrent(goalStreamer.id, finalAmount);
                broadcastGoalUpdate(username, { ...goalStreamer, ...goalUpdated });
              }
            } catch (e) {
              console.error('Goal update after truemoney verify failed:', e.message);
            }
          }
        }

        return res.json({
          success: true,
          amount: slipAmount,
          transRef: d.transRef,
          sender: d.sender?.displayName,
          receiver: d.receiver?.displayName
        });
      } else {
        const slipCode = slipData?.code;
        const errorMsg = slipData?.message || slipData?.error || 'สลิปไม่ถูกต้อง';
        const delayMinutes = slipData?.delay || null;
        const mappedCode = slipCode === 1010 ? 'SLIP_DELAY' :
                           slipCode === 1012 ? 'SLIP_DUPLICATE' :
                           slipCode === 1013 ? 'AMOUNT_MISMATCH' :
                           slipCode === 1014 ? 'WRONG_RECEIVER' :
                           'SLIP_INVALID';
        return res.json({ success: false, errorCode: mappedCode, error: errorMsg, delayMinutes });
      }
    } catch (slipErr) {
      console.error('SlipOK verification error:', slipErr.message);
      if (slipErr.response) {
        const body = slipErr.response.data;
        const slipCode = body?.code;
        const errMsg = body?.message || body?.error || 'SlipOK API error';
        const delayMinutes = body?.delay || null;
        const mappedCode = slipCode === 1010 ? 'SLIP_DELAY' :
                           slipCode === 1012 ? 'SLIP_DUPLICATE' :
                           slipCode === 1013 ? 'AMOUNT_MISMATCH' :
                           slipCode === 1014 ? 'WRONG_RECEIVER' :
                           'SLIPOK_ERROR';
        return res.json({ success: false, errorCode: mappedCode, error: errMsg, delayMinutes });
      }
      return res.status(502).json({ success: false, errorCode: 'CONNECTION_FAILED', error: 'ไม่สามารถเชื่อมต่อ SlipOK ได้' });
    }
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
    
    // Decrypt TrueMoney phone if encrypted
    let truemoneyPhone = '';
    if (streamer.truemoney_phone_encrypted) {
      try {
        truemoneyPhone = decrypt(streamer.truemoney_phone_encrypted);
      } catch (e) {
        console.warn('Failed to decrypt truemoney_phone:', e.message);
      }
    }
    
    res.json({
      // FIXME: เมื่อ FFP พร้อมใช้งาน เปลี่ยนเป็น (method === 'ffp' || method === 'both')
      ffp: false,
      promptpay: streamer.promptpay_enabled === 1,
      truemoney: streamer.truemoney_enabled === 1,
      beam: method === 'ffp' || method === 'both',
      promptpay_name: streamer.promptpay_name || streamer.username,
      truemoney_phone: truemoneyPhone,
      slipok_connected: streamer.slipok_connected === 1 || streamer.tfp_connected === 1,
      truemoney_slipok_connected: streamer.truemoney_slipok_connected === 1
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
  video: 5 * 1024 * 1024
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
    if (fileSize !== undefined && fileSize > UPLOAD_MAX_SIZES[category]) {
      return res.status(413).json({ error: `ไฟล์ใหญ่เกินกำหนด (สูงสุด ${Math.round(UPLOAD_MAX_SIZES[category] / 1024 / 1024)}MB)` });
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
  console.error('Server Error:', err.message);
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
