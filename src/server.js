// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
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

const TwitchStrategy = require('passport-twitch-new').Strategy;
const OAuth2Strategy = require('passport-oauth2').Strategy;


const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Setup SQLite Database (Turso Cloud)
const db = require('./database');
const { encrypt, decrypt, censor } = require('./encryption');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
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
  fontSize: 48,
  customImageMode: 'emoji',
  customImageValue: '💝',
  customSoundUrl: ''
};

// ========== SSE Alert System ==========
const MAX_SSE_CLIENTS = 500;
const SSE_CLIENT_TTL = 5 * 60 * 1000;
let sseClients = [];

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

function broadcastAlert(username, alertData) {
  const data = JSON.stringify(alertData);
  console.log(`📢 [Broadcast] Sending to ${username}:`, alertData.type);
  
  sseClients = sseClients.filter(client => {
    if (client.username === username) {
      try {
        client.res.write(`data: ${data}\n\n`);
        return true;
      } catch (err) {
        console.error(`❌ [Broadcast] Failed to write to client ${username}:`, err.message);
        return false; // Remove dead client
      }
    }
    return true;
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
    // Check if obj is a simple ID or a full user object
    const userId = typeof obj === 'object' ? (obj.twitch_id || obj.id || obj.streamlabs_id) : obj;
    
    if (!userId) return done(null, obj);

    // Try to find the streamer by either Twitch or Streamlabs ID
    const streamer = await db.getStreamerById(userId);
    
    if (streamer) {
      // Attach username to the user object for easy access in req.user.username
      if (typeof obj === 'object') {
        obj.username = streamer.username;
      } else {
        // If obj was just an ID, we return the full streamer object
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

// ========== Helper Functions ==========
async function getActualUsername(user) {
  if (!user) return null;
  const userId = user.twitch_id || user.streamlabs_id || user.id;
  try {
    const streamer = await db.getStreamerById(userId);
    if (streamer) return streamer.username;
  } catch (err) {
    console.error('Error resolving actual username:', err);
  }
  return (user.username || user.nickname || user.display_name || (user._json && user._json.display_name) || 'Unknown').toLowerCase();
}

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// -----------------------------------------------------------------
// [FIXED ROUTES] - Define these BEFORE dynamic routes and static serving
// -----------------------------------------------------------------

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/register.html'));
});

app.get('/register/setup', (req, res) => {
  if (!req.session.pendingUser) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '../public/register-setup.html'));
});

app.get('/api/register/pending', (req, res) => {
  console.log('📋 [Register Pending] Session pendingUser:', req.session.pendingUser ? JSON.stringify({ streamlabsId: !!req.session.pendingUser.streamlabsId, twitchId: !!req.session.pendingUser.twitchId, streamlabsName: req.session.pendingUser.streamlabsName, profileImage: !!req.session.pendingUser.profileImage }) : '(none)');
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
    console.log(`💾 [Register Complete] Saving user...`, { twitchId: pending.twitchId, streamlabsId: pending.streamlabsId, username: normalizedUsername, hasProfileImage: !!pending.profileImage });
    
    const newUser = await db.saveStreamer({
      twitch_id: pending.twitchId || null,
      streamlabs_id: pending.streamlabsId || null,
      streamlabs_username: pending.streamlabsUsername || null,
      streamlabs_access_token: pending.streamlabs_access_token || null,
      streamlabs_refresh_token: pending.streamlabs_refresh_token || null,
      username: normalizedUsername,
      overlay_token: crypto.randomBytes(16).toString('hex'),
      is_active: 1,
      profile_image_value: pending.profileImage || null,
      profile_image_source: pending.profileImage ? (pending.streamlabsId ? 'streamlabs' : 'twitch') : null
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

app.get('/auth/twitch', (req, res, next) => {
  passport.authenticate('twitch')(req, res, next);
});

app.get('/auth/streamlabs', (req, res) => {
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

  let authUrl = `https://streamlabs.com/api/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURI(callbackUrl)}&scope=${encodeURIComponent(scope).replace(/%20/g, '+')}&response_type=${responseType}&state=${state}`;
  
  console.log(`🚀 Redirecting to Streamlabs: ${authUrl}`);
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
  passport.authenticate('twitch', { failureRedirect: '/login-failed' }),
  async (req, res) => {
    const user = req.user;
    const twitchId = user.twitch_id || user.id;
    const twitchName = await getActualUsername(user);
  
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
      // Refresh Twitch profile image on every login
      const profileImageUrl = user.profile_image_url || existingUser.profile_image_value;
      if (profileImageUrl && profileImageUrl !== existingUser.profile_image_value) {
        await db.saveStreamer({
          ...existingUser,
          twitch_id: twitchId,
          profile_image_value: profileImageUrl,
          profile_image_source: 'twitch'
        }).catch(e => console.error('Failed to sync profile image:', e.message));
      }

      // Force save session to DB before redirecting to prevent session loss on serverless environments
      req.session.save((err) => {
        if (err) {
          console.error('❌ Session save error during login:', err);
        }
        return res.redirect(`/${existingUser.username.toLowerCase()}/dashboard`);
      });
    } else {
  
        // Store temporary info in session for the setup page
        req.session.pendingUser = {
          twitchId: twitchId,
          twitchName: twitchName,
          profileImage: user.profile_image_url || '/avatar.jpg'
        };
        
        // Force save session to DB before redirecting to prevent session loss on serverless environments
        req.session.save((err) => {
          if (err) {
            console.error('❌ Session save error during registration:', err);
          }
        return res.redirect('/register');
        });
      }
    } catch (err) {
      console.error('Callback error:', err);
      res.redirect('/login-failed');
    }
  }
);

app.get('/auth/streamlabs/callback', async (req, res) => {
  console.log('📥 [Streamlabs] FULL query:', JSON.stringify(req.query));
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error(`❌ Streamlabs returned error: ${error} - ${error_description || 'no description'}`);
    delete req.session.oauthState;
    return res.redirect('/login-failed');
  }

  if (!code) {
    console.error('❌ Streamlabs callback missing code');
    return res.redirect('/login-failed');
  }

  if (state && req.session.oauthState && state !== req.session.oauthState) {
    console.error(`❌ Streamlabs CSRF state mismatch (continuing anyway): session=${req.session.oauthState?.substring(0,8)}... query=${state?.substring(0,8)}...`);
  } else if (!state || !req.session.oauthState) {
    console.warn(`⚠️ Streamlabs CSRF state not validated: session=${!!req.session.oauthState} query=${!!state}`);
  }

  delete req.session.oauthState;

  try {
    // 1. Exchange code for access_token (v1.0 uses form-encoded body)
    console.log('🔑 [Streamlabs] Exchanging code for token...');
    console.log('🔑 [Streamlabs] Client ID valid:', !!process.env.STREAMLABS_CLIENT_ID);
    console.log('🔑 [Streamlabs] Client Secret valid:', !!process.env.STREAMLABS_CLIENT_SECRET);
    console.log('🔑 [Streamlabs] Client ID prefix:', process.env.STREAMLABS_CLIENT_ID?.substring(0, 12) + '...');
    console.log('🔑 [Streamlabs] Redirect URI:', process.env.STREAMLABS_CALLBACK_URL);
    console.log('🔑 [Streamlabs] Code prefix:', code?.substring(0, 8) + '...');

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

    console.log('🔑 [Streamlabs] Token response status:', response.status);
    console.log('🔑 [Streamlabs] Token response keys:', Object.keys(response.data).join(', '));

    const accessToken = response.data.access_token;
    const refreshToken = response.data.refresh_token;
    if (!accessToken) {
      console.error('❌ [Streamlabs] Token response missing access_token:', JSON.stringify(response.data));
      throw new Error('No access token received from Streamlabs');
    }

    console.log('✅ [Streamlabs] Token obtained successfully');

    // 2. Get user profile info using access_token
    console.log('👤 [Streamlabs] Fetching user profile...');
    const userResponse = await axios.get('https://streamlabs.com/api/v2.0/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('👤 [Streamlabs] User response status:', userResponse.status);
    console.log('👤 [Streamlabs] User response keys:', Object.keys(userResponse.data).join(', '));
    console.log('👤 [Streamlabs] User data:', JSON.stringify(userResponse.data).substring(0, 300));

    const userData = userResponse.data;
    const streamlabsId = userData.id;
    const streamlabsName = userData.username;
    const profileImage = userData.profile_image || '/avatar.jpg';

    console.log('👤 [Streamlabs] Parsed - ID:', streamlabsId, 'Username:', streamlabsName, 'Image:', profileImage ? '(present)' : '(missing)');

    if (!streamlabsId) {
      console.error('❌ [Streamlabs] No streamlabs ID in profile response');
      throw new Error('No Streamlabs ID received from profile API');
    }

    // 3. DB Logic: Upsert / Linking
    console.log('🗄️ [Streamlabs] Checking DB...');
    
    // Check if there's an existing authenticated session (e.g. logged in via Twitch)
    if (req.isAuthenticated()) {
      const currentUserId = req.user.id || req.user.twitch_id;
      console.log('🔗 [Streamlabs] User already authenticated, looking up by:', currentUserId);
      const existingUser = await db.getStreamerById(currentUserId);
      
      if (existingUser) {
        console.log(`🔗 [Streamlabs] Linking Streamlabs ID ${streamlabsId} to user ${existingUser.username}`);
        await db.saveStreamer({
          ...existingUser,
          streamlabs_id: streamlabsId,
          streamlabs_username: streamlabsName,
          streamlabs_access_token: accessToken,
          streamlabs_refresh_token: refreshToken
        });
        return res.redirect(`/${existingUser.username.toLowerCase()}/dashboard`);
      }
    }

    // Check if this Streamlabs ID already exists in our DB
    console.log('🔍 [Streamlabs] Looking up by streamlabsId:', streamlabsId);
    const existingUser = await db.getStreamerByStreamlabsId(streamlabsId);
    console.log('🔍 [Streamlabs] Existing user:', existingUser ? existingUser.username : 'none');

    if (existingUser) {
      console.log(`✅ [Streamlabs] Returning user ${existingUser.username}. Updating tokens...`);
      await db.saveStreamer({
        ...existingUser,
        streamlabs_access_token: accessToken,
        streamlabs_refresh_token: refreshToken
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
      console.log(`🆕 [Streamlabs] New user: ${streamlabsName}. Storing in session...`);
       req.session.pendingUser = {
         streamlabsId: streamlabsId,
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
    console.error('💥 [Streamlabs] Error stack:', err.stack?.substring(0, 500));
    if (err.response) {
      console.error('💥 [Streamlabs] Response status:', err.response.status);
      console.error('💥 [Streamlabs] Response data:', JSON.stringify(err.response.data).substring(0, 500));
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

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay.html'));
});

app.get('/alert-test', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/alert-test.html'));
});

app.get('/admin', async (req, res) => {
  if (req.isAuthenticated()) {
    const user = req.user;
    const userId = user.twitch_id || user.id;
    try {
      const streamer = await db.getStreamerById(userId);
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

app.post('/webhook', async (req, res) => {
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
    }
    res.json({ received: true });
  } catch (error) {
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

const RESERVED_WORDS = ['login', 'auth', 'api', 'overlay', 'alert-test', 'thank-you', 'register'];

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
    const user = req.user;
    
    const userId = user.twitch_id || user.id;
    
    if (!userId) {
      console.error('❌ Ownership check failed: No user ID found in session');
      return res.status(403).send('Forbidden: ไม่พบข้อมูลการยืนยันตัวตน');
    }

    try {
      const streamer = await db.getStreamerById(userId);
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
    authenticatedUser = await getActualUsername(req.user);
    authMethod = 'session';
  }

  if (sseClients.length >= MAX_SSE_CLIENTS) {
    res.status(503).json({ error: 'Too many concurrent overlay connections' });
    return;
  }

  const isValidToken = authMethod === 'token';
  const now = Date.now();
  
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: `Overlay connected as ${authenticatedUser || 'Unknown'}` })}\n\n`);
  
  sseClients.push({ res, validated: isValidToken, username: authenticatedUser, authMethod: authMethod, lastActivity: now });
  
  const keepAlive = setInterval(() => { res.write(`: keep-alive\n\n`); }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(client => client.res !== res);
  });
});

app.get('/api/overlay/status', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    
    const isActive = sseClients.some(client => client.username === actualUsername && client.authMethod === 'token');
    res.json({ active: isActive });
  } catch (err) {
    console.error('Get overlay status error:', err);
    res.status(500).json({ error: 'ไม่สามารถตรวจสอบสถานะได้' });
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

app.post('/api/cron/cleanup-expired', async (req, res) => {
  try {
    const expiredCount = await db.cleanupExpiredTransactions();
    const deletedCount = await db.hardDeleteExpiredTransactions();
    res.json({ success: true, expired: expiredCount, deleted: deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cron/cleanup-quarterly', async (req, res) => {
  try {
    const months = parseInt(req.body?.months) || 3;
    const count = await db.hardDeleteOldTransactions(months);
    res.json({ success: true, deleted: count, months });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions/:id/status', ensureAuthenticated, async (req, res) => {
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
      // Refresh txDetails to get the most recent data for broadcasting
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
    console.error('Error updating transaction status:', err);
    res.status(500).json({ error: 'ไม่สามารถอัปเดตสถานะได้' });
  }
});

app.get('/api/user/me', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    const streamer = await db.getStreamer(actualUsername);
    if (!streamer) return res.status(404).json({ error: 'User not found in database' });
    
    res.json({
      username: streamer.username,
      twitchId: streamer.twitch_id,
      streamlabsId: streamer.streamlabs_id,
      email: req.user.email || 'Not provided'
    });
  } catch (err) {
    console.error('Get user info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', (req, res) => {
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
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });
});

app.delete('/api/user/delete', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const twitchId = user.twitch_id || user.id;
    
    // Verify ownership one last time
    const streamer = await db.getStreamerById(twitchId);
    if (!streamer) return res.status(404).json({ error: 'User not found' });
    
    console.log(`🗑️ [User Delete] Deleting user: ${streamer.username} (ID: ${streamer.id})`);
    
    // Delete from streamers table
    await db.deleteStreamer(streamer.id);
    
    // Destroy session
    req.logout((err) => {
      if (err) console.error('Logout error during deletion:', err);
      req.session.destroy((sErr) => {
        if (sErr) console.error('Session destroy error during deletion:', sErr);
        res.clearCookie('connect.sid');
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

app.post('/api/overlay/settings', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    const twitchId = req.user.twitch_id || req.user.id;
    
    const updatedStreamer = await db.saveStreamer({
      twitch_id: twitchId,
      ...req.body
    });
    
    broadcastAlert(actualUsername, { type: 'settings_update', settings: updatedStreamer });
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
      profileGlowColor: streamer.profile_glow_color || '#005704',
      pageTitle: streamer.page_title || `เลี้ยงกาแฟ ${streamer.username}`,
      pageSubtitle: streamer.page_subtitle || 'ทุกการสนับสนุนคือกำลังใจที่มีค่าสำหรับผม✨',
      thankYouHeader: streamer.thank_you_header || 'ขอบคุณสำหรับการสนับสนุน!',
      thankYouSubtitle: streamer.thank_you_subtitle || 'การสนับสนุนของคุณช่วยให้เราพัฒนาคอนเทนต์ต่อไปได้',
      minAmount: streamer.minAmount != null ? streamer.minAmount : 1,
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
    const twitchId = req.user.twitch_id || req.user.id;
    
    const updatedStreamer = await db.saveStreamer({
      twitch_id: twitchId,
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

app.post('/api/alerts/test', ensureAuthenticated, async (req, res) => {
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
  res.redirect('/login');
}

app.get('/api/overlay/token', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.user;
    const twitchId = user.twitch_id || user.id;
    const streamer = await db.getStreamerById(twitchId);
    
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
    const instantBlockRegex = /<div class="instant">[\s\S]*?<button class="small-button" onclick="play\('([^']+)'[^"]*"[^>]*title="Play\s*(?:&quot;)?([^"&]*?)(?:&quot;)?\s*sound"[\s\S]*?<a href="[^"]*" class="instant-link[^"]*">([^<]+)<\/a>/g;
    
    let match;
    while ((match = instantBlockRegex.exec(html)) !== null) {
      const mp3Path = match[1];
      const mp3Url = mp3Path.startsWith('http') ? mp3Path : `https://www.myinstants.com${mp3Path}`;
      const slug = mp3Path.replace('/media/sounds/', '').replace('.mp3', '');
      const name = match[3].trim() || match[2].trim() || slug.replace(/[-_]/g, ' ');
      
      if (mp3Url && name) {
        results.push({
          id: slug,
          name: name,
          slug: slug,
          mp3Url: mp3Url,
        });
      }
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

    res.json({ 
      results: paginatedResults,
      total: allResults.length,
      hasMore: offset + limit < allResults.length,
      pageName: pageName,
      currentPageId: query ? 'search' : pageId,
    });
  } catch (err) {
    console.error('MyInstants search error:', err.message);
    res.status(500).json({ error: 'ไม่สามารถค้นหาเสียงได้', details: err.message });
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
    let htmlContent = DONATE_TEMPLATE;
 
    const ogTitle = `TipKub | ${streamer.page_title || streamer.username}`;
    const ogDescription = streamer.page_subtitle || 'สนับสนุนสตรีมเมอร์ที่คุณรักผ่าน TipKub';
    const ogImage = streamer.profile_image_value || '/avatar.jpg';
 
    htmlContent = htmlContent
      .replace(/{{username}}/g, escapeHTML(streamer.username))
      .replace(/{{og_title}}/g, escapeHTML(ogTitle))
      .replace(/{{og_description}}/g, escapeHTML(ogDescription))
      .replace(/{{og_image}}/g, escapeHTML(ogImage));
 
    res.send(htmlContent);
  } catch (err) {
    console.error('Error serving dynamic donation page:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดหน้าเว็บ');
  }
});

app.get('/:username/dashboard', ensureUserOwner, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
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
      tfp_api_key: decrypted.tfp_api_key || '',
      tfp_api_secret: decrypted.tfp_api_secret || '',
      tfp_connected: decrypted.tfp_connected || 0,
      tfp_last_check: decrypted.tfp_last_check || '',
      promptpay_type: decrypted.promptpay_type || 'phone',
      promptpay_value: decrypted.promptpay_value || '',
      slipok_api: censor(decrypted.slipok_api || '', 8, 4),
      slipok_api_key: censor(decrypted.slipok_api_key || ''),
      slipok_connected: decrypted.slipok_connected || 0,
      slipok_last_check: decrypted.slipok_last_check || '',
      truemoney_enabled: decrypted.truemoney_enabled || 0,
      truemoney_phone: decrypted.truemoney_phone || '',
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
app.post('/api/payment/settings', ensureAuthenticated, async (req, res) => {
  try {
    const actualUsername = await getActualUsername(req.user);
    const twitchId = req.user.twitch_id || req.user.id;

    const updatedStreamer = await db.saveStreamer({
      twitch_id: twitchId,
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

// POST /api/payment/test-tfp - Test TFP API connection
app.post('/api/payment/test-slipok', ensureAuthenticated, async (req, res) => {
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
      const streamer = await db.getStreamer(actualUsername);
      if (streamer) {
        const decrypted = decryptPaymentFields(streamer);
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

    const branchUrl = realApi.endsWith('/quota') ? realApi.replace(/\/quota$/, '') : realApi;
    const quotaUrl = `${branchUrl}/quota`;

    const response = await axios.get(quotaUrl, {
      headers: {
        'x-authorization': realApiKey
      },
      timeout: 10000
    });

    if (isTruemoney) {
      await db.saveStreamer({
        twitch_id: twitchId,
        truemoney_slipok_connected: 1,
        truemoney_slipok_last_check: new Date().toISOString(),
        truemoney_phone: realTruemoneyPhone,
        truemoney_slipok_api: realApi,
        truemoney_slipok_api_key: realApiKey
      });
    } else {
      await db.saveStreamer({
        twitch_id: twitchId,
        slipok_connected: 1,
        slipok_last_check: new Date().toISOString(),
        promptpay_type: realPromptpayType,
        promptpay_value: realPromptpayValue,
        slipok_api: realApi,
        slipok_api_key: realApiKey
      });
    }

    res.json({ success: true, message: 'เชื่อมต่อ SlipOK สำเร็จ', quota: response.data?.data?.quota });
  } catch (err) {
    console.error('Test SlipOK error:', err);
    const actualUsername = await getActualUsername(req.user);
    const twitchId = req.user.twitch_id || req.user.id;
    const isTruemoney = req.body.method === 'truemoney';
    try {
      if (isTruemoney) {
        await db.saveStreamer({ twitch_id: twitchId, truemoney_slipok_connected: 0, truemoney_slipok_last_check: new Date().toISOString() });
      } else {
        await db.saveStreamer({ twitch_id: twitchId, slipok_connected: 0, slipok_last_check: new Date().toISOString() });
      }
    } catch (ignore) {}

    const errorMsg = err.response
      ? `SlipOK ตอบกลับ: ${err.response.status} ${JSON.stringify(err.response.data)}`
      : err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND'
        ? 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ SlipOK ได้'
        : err.code === 'ETIMEDOUT'
          ? 'หมดเวลาเชื่อมต่อกับ SlipOK'
          : `เกิดข้อผิดพลาด: ${err.message}`;

    res.status(502).json({ success: false, error: errorMsg });
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
    const { username, amount, name, message } = req.body;
    if (!username || !amount) return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    if (amount < 1) return res.status(400).json({ error: 'จำนวนเงินต้องมากกว่า 0' });

    await db.cleanupExpiredTransactions();

    const pendingCount = await db.countPendingTransactions(username);
    if (pendingCount >= 5) {
      return res.status(429).json({ error: 'มีรายการค้างชำระมากเกินไป กรุณารอให้รายการเก่าหมดอายุก่อน' });
    }

    const streamer = await db.getStreamer(username);
    if (!streamer) return res.status(404).json({ error: 'ไม่พบผู้ใช้งาน' });
    if (!streamer.promptpay_enabled) return res.status(400).json({ error: 'ผู้ใช้ยังไม่ได้เปิด PromptPay' });

    let phone = streamer.promptpay_value_encrypted || streamer.promptpay_phone;
    if (phone && phone.includes(':')) {
      try { phone = decrypt(phone); } catch (e) { return res.status(500).json({ error: 'ไม่สามารถถอดรหัสข้อมูล PromptPay ได้' }); }
    }
    if (!phone) return res.status(400).json({ error: 'ผู้ใช้ยังไม่ได้ตั้งค่าเบอร์ PromptPay' });

    const referenceId = `donate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const qrPayload = generatePromptPayPayload(phone, amount);
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
    res.status(500).json({ error: err.message || 'ไม่สามารถสร้าง QR Code ได้' });
  }
});

// POST /api/verify-promptpay-slip - Verify PromptPay slip via TFP API
const verifySlipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'กรุณารอสักครู่' }
});

app.post('/api/verify-slip', upload.single('slip'), async (req, res) => {
  try {
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

    const base64Image = slipFile.buffer.toString('base64');
    const branchUrl = slipOkApi.replace(/\/quota$/, '');

    try {
      const slipOkResponse = await axios.post(branchUrl, {
        files: base64Image,
        amount: parseFloat(amount) || 0,
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
      const expectedAmount = parseFloat(amount) || 0;

      if (slipData && slipData.success && d) {
        if (expectedAmount > 0 && Math.abs(slipAmount - expectedAmount) > 0.01) {
          return res.json({ success: false, errorCode: 'AMOUNT_MISMATCH', error: `ยอดเงินในสลิป (${slipAmount}฿) ไม่ตรงกับยอดที่ต้องชำระ (${expectedAmount}฿)` });
        }

        if (referenceId) {
          const tx = await db.getTransactionById(referenceId);
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

app.post('/api/verify-promptpay-slip', verifySlipLimiter, async (req, res) => {
  try {
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
      ffp: method === 'ffp' || method === 'both',
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

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🌸 Stream Donation server running at http://localhost:${PORT}`);
    console.log(`📋 Environment: ${process.env.BEAM_ENV || 'sandbox'}`);
    console.log(`🎬 Overlay URL: http://localhost:${PORT}/overlay`);
    console.log(`🧪 Alert Test: http://localhost:${PORT}/alert-test`);
    console.log(`📊 Admin Panel: http://localhost:${PORT}/admin`);
  });
}
