require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const beam = require('./beam');
const https = require('https');
const session = require('express-session');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch-new').Strategy;

const app = express();
const PORT = process.env.PORT || 3000;

// Setup SQLite Database (Turso Cloud)
const db = require('./database');
db.initDB().catch(err => console.error('❌ Database connection failed:', err));

// ค่าตั้งค่าเริ่มต้นของ Overlay
const defaultSettings = {
  duration: 8, // seconds
  soundEnabled: true,
  soundChoice: 'chime', // chime, retro, modern, bell, none
  soundVolume: 0.5,
  ttsEnabled: false,
  ttsVolume: 0.8,
  ttsRate: 1.0,
  ttsLanguage: 'th-TH',
  ttsVoice: 'default',
  profanityFilterEnabled: true,
  profanityWords: 'ควย, เย็ด, สัส, เหี้ย, หี, แตด, ล่อ, ดอกทอง, ส้นตีน, อีดอก, อีเหี้ย, พ่อง, แม่มึง, กู, มึง',
  profanityReplaceStyle: 'asterisks', // asterisks, polite, block
  messageTemplate: '{donor} ได้บริจาค {amount} บาท! 🎉',
  showDonorMessage: true,
  minAmount: 1, // Minimum amount to trigger alert
  theme: 'glassmorphism', // glassmorphism, cyberpunk, minimal, custom
  animation: 'slide-down', // slide-down, slide-up, fade, zoom
  fontFamily: 'Noto Sans Thai',
  primaryColor: '#667eea',
  secondaryColor: '#764ba2',
  backgroundColor: 'rgba(255, 255, 255, 0.1)',
  textColor: '#ffffff',
  borderColor: 'rgba(255, 255, 255, 0.25)',
  particleCount: 15,
  fontSize: 32
};

// ========== SSE Alert System ==========
let sseClients = [];
let isOverlayActive = false;

function broadcastAlert(alertData) {
  const data = JSON.stringify(alertData);
  console.log(`📢 Broadcasting alert to ${sseClients.length} client(s):`, alertData.donor || 'System Update', alertData.amount || '');
  sseClients.forEach(client => {
    client.res.write(`data: ${data}\n\n`);
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
app.use(cors());

// SECURITY: Block direct access to /dashboard via express.static, but allow static assets
app.use((req, res, next) => {
  if (req.path.startsWith('/dashboard') && !req.path.match(/\.(css|js|jpg|jpeg|png|gif|svg|woff|woff2|ttf|otf)$/)) {
    return res.redirect('/login');
  }
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'twitch-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());

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

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// -----------------------------------------------------------------
// [FIXED ROUTES] - Define these BEFORE dynamic routes and static serving
// -----------------------------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/register', (req, res) => {
  res.send('<h1>Register Page</h1><p>Registration is coming soon!</p><a href="/">Back to Home</a>');
});

app.get('/auth/twitch', passport.authenticate('twitch'));

app.get('/auth/twitch/callback', 
  passport.authenticate('twitch', { failureRedirect: '/login-failed' }),
  (req, res) => {
    res.redirect('/admin');
  }
);

app.get('/login-failed', (req, res) => {
  res.send('Authentication failed. Please try again.');
});

app.get('/thank-you', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/thank-you.html'));
});

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay.html'));
});

app.get('/alert-test', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/alert-test.html'));
});

app.get('/admin', (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const twitchName = user.username || user.nickname || user.display_name || (user._json && user._json.display_name);
    if (twitchName) {
      return res.redirect(`/${twitchName.toLowerCase()}/dashboard`);
    }
  }
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, '../public')));

// API: สร้าง Donation (Payment Link)
app.post('/api/create-charge', async (req, res) => {
  try {
    const { amount, name, message } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const redirectUrl = `${protocol}://${host}/thank-you`;
    const charge = await beam.createPaymentLink({
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
      raw_response: charge
    });
    res.json({ success: true, paymentUrl: charge.url });
  } catch (error) {
    console.error('❌ Create payment link failed!', error.message);
    res.status(500).json({ error: 'ไม่สามารถสร้างรายการบริจาคได้', details: error.message });
  }
});

app.get('/api/charge/:id', async (req, res) => {
  try {
    const charge = await beam.getCharge(req.params.id);
    res.json({ id: charge.id, status: charge.status, amount: charge.amount / 100, paid: charge.status === 'successful' });
  } catch (error) {
    res.status(500).json({ error: 'ไม่สามารถเช็คสถานะได้' });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-beam-signature'];
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (webhookSecret && signature) {
      const secretBuffer = Buffer.from(webhookSecret, 'base64');
      const hmac = crypto.createHmac('sha256', secretBuffer);
      const digest = hmac.update(req.rawBody).digest('base64');
      if (signature !== digest) return res.status(401).json({ error: 'Invalid signature' });
    } else if (webhookSecret && !signature) {
      return res.status(400).json({ error: 'Missing signature' });
    }
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
        amount: amount || (tx ? tx.amount : 0),
        status: 'successful',
        paidAt: new Date().toISOString(),
        raw_webhook: event
      });
      const txDetails = (await db.getTransactionById(targetId)) || {};
      broadcastAlert({
        type: 'donation',
        donor: txDetails.donor || 'Anonymous',
        amount: amount || txDetails.amount || 0,
        message: txDetails.message || charge.description || '',
        timestamp: new Date().toISOString()
      });
    }
    res.json({ received: true });
  } catch (error) {
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

// ========== Multi-User Dynamic Routing Configuration ==========
const RESERVED_WORDS = ['login', 'auth', 'api', 'overlay', 'alert-test', 'thank-you', 'register'];

async function validateUsername(req, res, next) {
  const { username } = req.params;
  if (RESERVED_WORDS.includes(username)) return next();
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

function ensureUserOwner(req, res, next) {
  if (req.isAuthenticated()) {
    const { username } = req.params;
    const user = req.user;
    const twitchName = user.username || user.nickname || user.display_name || (user._json && user._json.display_name);
    if (twitchName && username && twitchName.toLowerCase() === username.toLowerCase()) return next();
    return res.status(403).send('Forbidden: คุณไม่มีสิทธิ์จัดการหน้า Dashboard ของผู้อื่น');
  }
  res.redirect('/login');
}

app.get('/api/alerts/stream', (req, res) => {
  const token = req.query.token;
  const isValidToken = token && token === process.env.OVERLAY_TOKEN;
  if (isValidToken) isOverlayActive = true;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Overlay connected' })}\n\n`);
  sseClients.push({ res, validated: isValidToken });
  const keepAlive = setInterval(() => { res.write(`: keep-alive\n\n`); }, 30000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(client => client.res !== res);
    isOverlayActive = sseClients.some(client => client.validated);
  });
});

app.get('/api/overlay/status', (req, res) => {
  res.json({ active: isOverlayActive });
});

app.get('/api/transactions/:username', ensureAuthenticated, async (req, res) => {
  const { username } = req.params;
  const user = req.user;
  const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
  
  if (twitchName !== username.toLowerCase()) {
    return res.status(403).json({ error: 'Forbidden: คุณไม่มีสิทธิ์เข้าถึงข้อมูลของผู้อื่น' });
  }

  try {
    const txs = await db.getTransactions(username);
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

app.post('/api/transactions/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['pending', 'successful', 'failed'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  try {
    const tx = await db.getTransactionById(id);
    if (!tx) return res.status(404).json({ error: 'ไม่พบธุรกรรม' });
    const updatedTx = await db.saveTransaction({ id, status });
    if (status === 'successful') {
      broadcastAlert({
        type: 'donation',
        donor: updatedTx.donor || 'Anonymous',
        amount: updatedTx.amount || 0,
        message: updatedTx.message || '',
        timestamp: new Date().toISOString(),
        isManualTrigger: true
      });
    }
    res.json({ success: true, transaction: updatedTx });
  } catch (err) {
    res.status(500).json({ error: 'ไม่สามารถอัปเดตสถานะได้' });
  }
});

app.get('/api/overlay/settings', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
    const streamer = await db.getStreamer(twitchName);
    
    if (!streamer) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลผู้ใช้งาน' });
    }
    
    res.json(streamer);
  } catch (err) {
    res.status(500).json({ error: 'ไม่สามารถดึงการตั้งค่าได้' });
  }
});

app.post('/api/overlay/settings', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
    
    const updatedStreamer = await db.saveStreamer({
      username: twitchName,
      ...req.body
    });
    
    broadcastAlert({ type: 'settings_update', settings: updatedStreamer });
    res.json({ success: true, settings: updatedStreamer });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าได้' });
  }
});

app.get('/api/tts', (req, res) => {
  try {
    const text = req.query.text;
    const lang = req.query.lang || 'th';
    if (!text) return res.status(400).send('Text is required');
    const encodedText = encodeURIComponent(text);
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodedText}`;
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

app.post('/api/alerts/test', (req, res) => {
  const { donor, amount, message } = req.body;
  const alertData = {
    type: 'donation',
    donor: donor || 'ผู้ทดสอบ',
    amount: amount || 100,
    message: message || 'นี่คือ test alert 🎉',
    timestamp: new Date().toISOString()
  };
  broadcastAlert(alertData);
  res.json({ success: true, alert: alertData, clients: sseClients.length });
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

app.get('/api/overlay/token', ensureAuthenticated, (req, res) => {
  res.json({ token: process.env.OVERLAY_TOKEN });
});

// -----------------------------------------------------------------
// [DYNAMIC ROUTES] - These must be defined LAST
// -----------------------------------------------------------------

app.get('/:username', validateUsername, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/donate-template/index.html'));
});

app.get('/:username/dashboard', ensureUserOwner, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

app.get('/:username/overlay', validateUsername, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay.html'));
});

app.listen(PORT, () => {
  console.log(`🌸 Stream Donation server running at http://localhost:${PORT}`);
  console.log(`📋 Environment: ${process.env.BEAM_ENV || 'sandbox'}`);
  console.log(`🎬 Overlay URL: http://localhost:${PORT}/overlay`);
  console.log(`🧪 Alert Test: http://localhost:${PORT}/alert-test`);
  console.log(`📊 Admin Panel: http://localhost:${PORT}/admin`);
});
