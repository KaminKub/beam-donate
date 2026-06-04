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
  backgroundColor: 'rgba(15, 15, 25, 0.88)',
  textColor: '#ffffff',
  borderColor: 'rgba(255, 255, 255, 0.05)',
  particleCount: 15,
  fontSize: 48
};

// ========== SSE Alert System ==========
let sseClients = [];

function broadcastAlert(username, alertData) {
  const data = JSON.stringify(alertData);
  console.log(`📢 Broadcasting alert to ${username}'s client(s):`, alertData.donor || 'System Update', alertData.amount || '');
  
  sseClients.forEach(client => {
    if (client.username === username) {
      client.res.write(`data: ${data}\n\n`);
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
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true, 
    sameSite: 'Lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
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
  res.redirect('/auth/twitch');
});

app.get('/register/setup', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../public/register-setup.html'));
});

app.get('/api/register/pending', (req, res) => {
  if (!req.session.pendingUser) return res.status(401).json({ error: 'Unauthorized' });
  res.json(req.session.pendingUser);
});

app.post('/api/register/complete', async (req, res) => {
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
  
  try {
    console.log(`🔎 [Register Complete] Checking if ${normalizedUsername} exists...`);
    const existingUser = await db.getStreamer(normalizedUsername);
    if (existingUser) {
      console.error(`❌ [Register Complete] Username ${normalizedUsername} already exists`);
      return res.status(400).json({ error: 'This username is already taken' });
    }

    const pending = req.session.pendingUser;
    console.log(`💾 [Register Complete] Saving new user to DB...`, { twitchId: pending.twitchId });
    
    const newUser = await db.saveStreamer({
      twitch_id: pending.twitchId,
      username: normalizedUsername,
      overlay_token: crypto.randomBytes(16).toString('hex'),
      is_active: 1
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
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

app.get('/auth/twitch', passport.authenticate('twitch'));


app.get('/auth/twitch/callback', 
  passport.authenticate('twitch', { failureRedirect: '/login-failed' }),
  async (req, res) => {
    const user = req.user;
    const twitchId = user.twitch_id || user.id;
    const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();

    try {
      // 1. Try finding by Twitch ID first
      let existingUser = await db.getStreamerByTwitchId(twitchId);
      
      // 2. If not found by ID, try finding by Username (Linking existing accounts)
      if (!existingUser) {
        existingUser = await db.getStreamer(twitchName);
        if (existingUser) {
          console.log(`🔗 Linking existing account for ${twitchName} with Twitch ID ${twitchId}`);
          await db.saveStreamer({
            ...existingUser,
            twitch_id: twitchId
          });
        }
      }

    if (existingUser) {
      return res.redirect(`/${existingUser.username.toLowerCase()}/dashboard`);
    } else {

        // Store temporary info in session for the setup page
        req.session.pendingUser = {
          twitchId: twitchId,
          twitchName: twitchName,
          profileImage: user._json?.profile_image_url || '/avatar.jpg'
        };
        return res.redirect('/register/setup');
      }
    } catch (err) {
      console.error('Callback error:', err);
      res.redirect('/login-failed');
    }
  }
);

app.get('/login-failed', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login-failed.html'));
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

app.get('/admin', async (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const twitchId = user.twitch_id || user.id;
    try {
      const streamer = await db.getStreamerByTwitchId(twitchId);
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
app.post('/api/create-charge', async (req, res) => {
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
    res.status(500).json({ error: 'ไม่สามารถสร้างรายการบริจาคได้', details: error.message });
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
      
      // Targeted Broadcast: Send only to the streamer who received the money
      broadcastAlert(txDetails.streamer_username, {
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

async function ensureUserOwner(req, res, next) {
  if (req.isAuthenticated()) {
    const { username } = req.params;
    const user = req.user;
    
    // Handle both Twitch profile (user.id) and Streamer record (user.twitch_id)
    const twitchId = user.twitch_id || user.id;
    
    if (!twitchId) {
      console.error('❌ Ownership check failed: No Twitch ID found in user session');
      return res.status(403).send('Forbidden: ไม่พบข้อมูลการยืนยันตัวตน');
    }

    try {
      const streamer = await db.getStreamerByTwitchId(twitchId);
      if (streamer && streamer.username.toLowerCase() === username.toLowerCase()) {
        return next();
      }
    } catch (err) {
      console.error('Ownership check error:', err);
    }
    return res.status(403).send('Forbidden: คุณไม่มีสิทธิ์จัดการหน้า Dashboard ของผู้อื่น');
  }
  res.redirect('/login');
}

app.get('/api/alerts/stream', async (req, res) => {
  const token = req.query.token;
  let authenticatedUser = null;
  let authMethod = null;

  if (token) {
    try {
      // Look up the user by their unique overlay_token in the DB
      const streamer = await db.getStreamerByToken(token);
      if (streamer) {
        authenticatedUser = streamer.username;
        authMethod = 'token';
      }
    } catch (err) {
      console.error('Token lookup error:', err);
    }
  } else if (req.isAuthenticated()) {
    // Fallback to session authentication if no token is provided (e.g., opening in browser while logged in)
    const user = req.user;
    authenticatedUser = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
    authMethod = 'session';
  }

  const isValidToken = authMethod === 'token';
  
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: `Overlay connected as ${authenticatedUser || 'Unknown'}` })}\n\n`);
  
  sseClients.push({ res, validated: isValidToken, username: authenticatedUser, authMethod: authMethod });
  
  const keepAlive = setInterval(() => { res.write(`: keep-alive\n\n`); }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(client => client.res !== res);
  });
});

app.get('/api/overlay/status', ensureAuthenticated, (req, res) => {
  const user = req.user;
  const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
  
  const isActive = sseClients.some(client => client.username === twitchName && client.authMethod === 'token');
  res.json({ active: isActive });
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
      const txDetails = await db.getTransactionById(id);
      broadcastAlert(txDetails.streamer_username, {
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

app.get('/api/overlay/settings', async (req, res) => {
  try {
    let username = null;

    if (req.isAuthenticated()) {
      const user = req.user;
      username = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
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

app.post('/api/overlay/settings', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
    const twitchId = user.twitch_id || user.id;
    
    const updatedStreamer = await db.saveStreamer({
      twitch_id: twitchId,
      username: twitchName,
      ...req.body
    });
    
    broadcastAlert(twitchName, { type: 'settings_update', settings: updatedStreamer });
    res.json({ success: true, settings: updatedStreamer });
  } catch (error) {
    console.error('Save settings error:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าได้' });
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
      profileGlowColor: streamer.profile_glow_color || '#00ff0e',
      pageTitle: streamer.page_title || `เลี้ยงกาแฟ ${streamer.username}`,
      pageSubtitle: streamer.page_subtitle || 'ทุกการสนับสนุนคือกำลังใจที่มีค่าสำหรับผม✨',
      thankYouHeader: streamer.thank_you_header || 'ขอบคุณสำหรับการสนับสนุน!',
      thankYouSubtitle: streamer.thank_you_subtitle || 'การสนับสนุนของคุณช่วยให้เราพัฒนาคอนเทนต์ต่อไปได้',
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

app.post('/api/page/settings', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
    const twitchId = user.twitch_id || user.id;
    
    const updatedStreamer = await db.saveStreamer({
      twitch_id: twitchId,
      username: twitchName,
      ...req.body
    });
    
    res.json({ success: true, settings: updatedStreamer });
  } catch (error) {
    console.error('Save page settings error:', error);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าหน้าเว็บได้' });
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

app.post('/api/alerts/test', ensureAuthenticated, (req, res) => {
  const { donor, amount, message } = req.body;
  const user = req.user;
  const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();

  const alertData = {
    type: 'donation',
    donor: donor || 'ผู้ทดสอบ',
    amount: amount || 100,
    message: message || 'นี่คือ test alert 🎉',
    timestamp: new Date().toISOString()
  };
  
  broadcastAlert(twitchName, alertData);
  res.json({ success: true, alert: alertData });
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

app.get('/api/overlay/token', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const twitchName = (user.username || user.nickname || user.display_name || (user._json && user._json.display_name)).toLowerCase();
    const streamer = await db.getStreamer(twitchName);
    
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
