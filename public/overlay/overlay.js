function escapeForHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DEMO_MODE_OVERLAY = window.DEMO_MODE === true;

// ========== Local Configuration State ==========
let overlaySettings = {
  duration: 8,
  soundEnabled: true,
  soundChoice: 'chime',
  soundVolume: 0.5,
  ttsEnabled: false,
  ttsVolume: 0.8,
  ttsRate: 1.3,
  ttsLanguage: 'th-TH',
  ttsVoice: 'default',
  ttsPrefixEnabled: true,
  profanityFilterEnabled: true,
  profanityWords: 'ควย, เย็ด, สัส, เหี้ย, หี, แตด, ล่อ, ดอกทอง, ส้นตีน, อีดอก, อีเหี้ย, พ่อง, แม่มึง, กู, มึง',
  profanityReplaceStyle: 'asterisks',
  messageTemplate: '{ผู้โดเนท} ได้เลี้ยงกาแฟ {จำนวนเงิน} {สกุลเงิน} 🎉',
  template_line1: '{ผู้โดเนท} ได้เลี้ยงกาแฟ',
  template_line2: '{จำนวนเงิน} {สกุลเงิน} 🎉',
  showDonorMessage: true,
  minAmount: 1,
  theme: 'glassmorphism',
  animation: 'slide-down',
  fontFamily: 'Noto Sans Thai',
  primaryColor: '#667eea',
  secondaryColor: '#764ba2',
  backgroundColor: 'rgba(15, 15, 25, 0.88)',
  textColor: '#ffffff',
  borderColor: 'rgba(255, 255, 255, 0.05)',
  theme_colors: '{"glassmorphism":{"amount":"#4ade80","border":"#667eea","bg":"rgba(15,15,25,0.123)","text":"#ffffff"},"cyberpunk":{"donor":"#ff007f","amount":"#00f3ff","border":"#ff007f","text":"#00f3ff","suffix":"#ff007f"},"custom":{"amount":"#667eea","border":"rgba(255,255,255,0.25)","bg":"rgba(15,15,25,0.88)","text":"#ffffff"},"text-only":{"amount":"#4ade80","text":"#ffffff"},"minimal":{"amount":"#667eea","border":"rgba(255,255,255,0.15)","text":"#ffffff"}}',
  alert_font_sizes: '{"header":24,"message":18,"amount":48,"suffix":24}',
  alert_outline: '{"header_amount":2,"message":1}',
  particleCount: 15,
  fontSize: 48,
  customImageMode: 'emoji',
  customImageValue: '🎁',
  customSoundUrl: ''
};

// ========== Queue System ==========
const alertQueue = [];
let isShowing = false;

// ========== Static Preview State ==========
let staticPreviewEl = null;
let currentStickyAlertBox = null;

// ========== Skip/Pin State ==========
// currentAlertBox/currentAlertTimeoutId/currentAlertToken track only the non-sticky (real
// donation) alert box, so Skip can force-dismiss it without touching the unrelated sticky
// test-preview box. currentAlertToken is a per-alert cancellation flag: Skip can arrive while
// showAlert() is still awaiting sound/TTS (before any timer exists to clearTimeout), so the
// paused continuation checks token.cancelled before it touches shared state — otherwise it would
// resurrect a timer for an alert Skip already removed, or corrupt whichever alert is showing next.
let currentAlertBox = null;
let currentAlertTimeoutId = null;
let currentAlertToken = null;
// Pin ("ตรึง") holds an alert on screen indefinitely AND stops the queue: later alerts wait until
// Skip or unpin, they never slide in behind/over a pinned alert. pendingPin is a pin waiting for
// the alert currently playing to finish — Pin queues, it never interrupts.
let isPinned = false;
let pendingPin = null;
// Set by whichever audio path is currently playing so Skip can cut it mid-playback ("ตัดจบทุกอย่าง").
let stopActiveAlertAudio = null;

// ========== SSE Connection ==========
let eventSource = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// ========== Initialize & Load Settings ==========
async function loadInitialSettings() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const settingsUrl = DEMO_MODE_OVERLAY
      ? '/api/demo/overlay/settings'
      : (token ? `/api/overlay/settings?token=${encodeURIComponent(token)}` : '/api/overlay/settings');
    
    console.log(`📡 Attempting to load settings from: ${settingsUrl}`);
    
    const res = await fetch(settingsUrl).catch(err => {
      console.error('❌ Fetch network error:', err);
      throw err;
    });

    if (res.ok) {
      const settings = await res.json();
      console.log('📋 Loaded overlay settings from server:', settings);
      applySettings(settings);
    } else {
      console.warn(`⚠️ Server responded with status: ${res.status} for ${settingsUrl}`);
    }
  } catch (err) {
    console.error('Failed to load initial settings, using defaults:', err);
    applySettings(overlaySettings);
  }
}

// ========== Apply Settings Dynamically ==========
function parseJsonField(value, fallback = null) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function applySettings(settings) {
  overlaySettings = { ...overlaySettings, ...settings };

  const doc = document.documentElement;
  const theme = overlaySettings.theme || 'glassmorphism';

  // Per-theme colors (fallback to legacy flat colors if new JSON missing)
  const themeColors = parseJsonField(overlaySettings.theme_colors, {});
  const colors = themeColors[theme] || {};
  doc.style.setProperty('--theme-amount', colors.amount || overlaySettings.primaryColor || '#4ade80');
  doc.style.setProperty('--theme-border', colors.border || overlaySettings.borderColor || 'rgba(255,255,255,0.25)');
  doc.style.setProperty('--theme-bg', colors.bg || overlaySettings.backgroundColor || 'rgba(15,15,25,0.88)');
  doc.style.setProperty('--theme-text', colors.text || overlaySettings.textColor || '#ffffff');
  doc.style.setProperty('--theme-suffix', colors.suffix || '#f59e0b');
  doc.style.setProperty('--theme-donor', colors.donor || '#fde047');

  // Legacy variables (for any old CSS still using them)
  doc.style.setProperty('--primary-color', overlaySettings.primaryColor);
  doc.style.setProperty('--secondary-color', overlaySettings.secondaryColor);
  doc.style.setProperty('--bg-color', overlaySettings.backgroundColor);
  doc.style.setProperty('--text-color', overlaySettings.textColor);
  doc.style.setProperty('--border-color', overlaySettings.borderColor);
  doc.style.setProperty('--font-family', `'${overlaySettings.fontFamily}', 'Segoe UI', sans-serif`);
  doc.style.setProperty('--glow-color', hexToRgbA(overlaySettings.primaryColor, 0.25));

  // Per-element font sizes (fallback to legacy fontSize)
  const fontSizes = parseJsonField(overlaySettings.alert_font_sizes, {});
  doc.style.setProperty('--font-header', fontSizes.header ?? 24);
  doc.style.setProperty('--font-donor-hl', fontSizes.donor_hl ?? fontSizes.header ?? 24);
  doc.style.setProperty('--font-message', fontSizes.message ?? 18);
  doc.style.setProperty('--font-amount', fontSizes.amount ?? overlaySettings.fontSize ?? 48);
  doc.style.setProperty('--font-amount-hl', fontSizes.amount_hl ?? fontSizes.amount ?? overlaySettings.fontSize ?? 48);
  doc.style.setProperty('--font-suffix', fontSizes.suffix ?? 24);
  doc.style.setProperty('--font-size', `${fontSizes.amount ?? overlaySettings.fontSize ?? 32}px`);

  // Cyberpunk gradient override: if user customized amount away from default, switch to solid fill
  if (theme === 'cyberpunk' && colors.amount && colors.amount !== '#00f3ff') {
    document.body.classList.add('custom-amount-active');
  } else {
    document.body.classList.remove('custom-amount-active');
  }

  applyOutline(overlaySettings);

  console.log('⚡ Applied settings:', overlaySettings.theme, overlaySettings.animation);
  if (!isShowing) {
    requestAnimationFrame(() => showStaticPreview());
  }
}

function applyOutline(settings) {
  let outline = parseJsonField(settings.alert_outline, { header_amount: 2, message: 1 });
  if (!outline) outline = { header_amount: 2, message: 1 };
  const hw = Math.min(5, Math.max(0, parseInt(outline.header_amount, 10) || 0));
  const mw = Math.min(5, Math.max(0, parseInt(outline.message, 10) || 0));
  // width 0 = filter ที่ไม่วาดอะไร แต่ยังบังคับ software raster ทั้ง element → ใช้ 'none' แทน
  document.querySelectorAll('.alert-header, .alert-amount').forEach(el => {
    el.style.filter = hw ? `url(#outline-h-${hw})` : 'none';
  });
  document.querySelectorAll('.alert-message').forEach(el => {
    el.style.filter = mw ? `url(#outline-m-${mw})` : 'none';
  });
}

// Helper to convert hex color to rgba with transparency
function hexToRgbA(hex, alpha = 1) {
  let c;
  if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)) {
    c = hex.substring(1).split('');
    if (c.length === 3) {
      c = [c[0], c[0], c[1], c[1], c[2], c[2]];
    }
    c = '0x' + c.join('');
    return `rgba(${[(c >> 16) & 255, (c >> 8) & 255, c & 255].join(',')},${alpha})`;
  }
  return hex;
}

// ========== Connect to SSE stream ==========
function connectSSE() {
  const baseUrl = window.location.origin;
  
  // Extract token from current page URL
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  
  const streamUrl = DEMO_MODE_OVERLAY
    ? `${baseUrl}/api/demo/alerts/stream`
    : (token
      ? `${baseUrl}/api/alerts/stream?token=${encodeURIComponent(token)}&source=overlay`
      : `${baseUrl}/api/alerts/stream?source=overlay`);

  eventSource = new EventSource(streamUrl);

  eventSource.onopen = () => {
    console.log('✅ SSE connected');
    reconnectAttempts = 0;
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'connected') {
        console.log('🔗 Overlay stream active');
        return;
      }

      // Real-time Settings Sync!
      if (data.type === 'settings_update') {
        console.log('🔄 SSE Settings Update received:', data.settings);
        applySettings(data.settings);
        return;
      }

      // Donation Alert Event
      if (data.type === 'donation') {
        console.log('💝 Donation event received:', data);

        // Client-side minimum amount filter
        const amount = Number(data.amount) || 0;
        if (amount < overlaySettings.minAmount) {
          console.log(`⚠️ Donation filtered out (฿${amount} is below threshold ฿${overlaySettings.minAmount})`);
          return;
        }

        alertQueue.push(data);
        processQueue();
      }

      if (data.type === 'clear_sticky_alert') {
        if (currentStickyAlertBox) {
          currentStickyAlertBox.classList.add('exit');
          setTimeout(() => {
            currentStickyAlertBox.remove();
            currentStickyAlertBox = null;
            isShowing = false;
            processQueue();
          }, 550);
        }
      }

      // Skip = cut everything now (visuals + any playing sound/TTS), release any pin, and let the
      // next queued alert in immediately. Does NOT touch currentStickyAlertBox (test-preview).
      if (data.type === 'skip_alert') {
        forceSkipCurrentAlert();
      }

      // Pin ("ตรึง") = hold this donation's alert on screen and stop the queue behind it.
      if (data.type === 'pin_alert') {
        applyPinAlert(data);
      }

      if (data.type === 'clear_pin') {
        releasePinnedAlert();
      }
    } catch (err) {
      console.error('Error parsing SSE data:', err);
    }
  };

  eventSource.onerror = () => {
    console.warn('⚠️ SSE connection lost. Reconnecting...');
    eventSource.close();

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    setTimeout(connectSSE, delay);
  };
}

// ========== Queue Processor ==========
// R15 — TTS is prepared (network fetch + audio decode-ready, or a Web Speech artifact) *before*
// the alert renders, so there's no dead-air gap after the notification sound while a slow
// provider (Vertex) is still synthesizing. isShowing is set before the await so a 'donation'
// event arriving mid-prepare can't dequeue a second alert concurrently.
async function processQueue() {
  // isPinned holds the queue: a pinned alert stays alone on screen until Skip or unpin.
  if (isShowing || isPinned) return;

  // A pin that was requested while an alert was playing takes the next slot — it was asked for
  // before anything still sitting in alertQueue, and it never cuts into an alert mid-play.
  if (pendingPin) {
    const pinData = pendingPin;
    pendingPin = null;
    displayPinnedAlert(pinData);
    return;
  }

  if (alertQueue.length === 0) return;

  isShowing = true;
  const alertData = alertQueue.shift();
  // codex adversarial-review 2026-08-11: cancel the previous alert's TTS the moment this one is
  // dequeued, not later when this one starts playing (playSpeech() previously only cancelled the
  // artifact it was about to replace, and that call happens after the next alert has already
  // appended + played its notification sound) — a long previous utterance could speak over the
  // next alert's visuals/notification audio in the gap between those two points.
  cancelCurrentSpeech();
  // Skip-cancellation token, created here rather than inside showAlert() so it already covers the
  // TTS-prepare await below: a Skip landing during prepare must abort this alert before it ever
  // renders, otherwise showAlert() would resume and paint an alert the user already skipped.
  const alertToken = alertData.sticky ? null : { cancelled: false };
  if (alertToken) currentAlertToken = alertToken;
  try {
    const ttsArtifact = await prepareAlertTts(alertData); // never throws — resolves null on any failure
    if (alertToken && alertToken.cancelled) return; // skipped while its TTS was still being prepared
    await showAlert(alertData, ttsArtifact, alertToken);
  } catch (err) {
    // defense in depth (codex adversarial-review round 2 2026-08-11) — prepareAlertTts() itself
    // never throws, but an unexpected showAlert() failure must not leave isShowing stuck true
    // forever; every later alert would stay queued until reload.
    console.error('Alert render error:', err);
    // A cancelled alert has already had isShowing reset and the queue advanced by Skip — recovering
    // here too would dequeue a second alert on top of the one Skip just started.
    if (alertToken && alertToken.cancelled) return;
    isShowing = false;
    processQueue();
  }
}

function cancelCurrentSpeech() {
  if (currentTtsAudio) { currentTtsAudio.pause(); if (currentTtsAudio._objUrl) URL.revokeObjectURL(currentTtsAudio._objUrl); currentTtsAudio.src = ''; currentTtsAudio = null; }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (currentTtsAbort) { currentTtsAbort.abort(); currentTtsAbort = null; }
}

// Same template-rendering logic showAlert() uses for the on-screen header, minus the DOM —
// extracted so the speech text can be computed (and its audio prepared) before the alert box
// exists at all (R15).
function buildAlertSpeechText(data) {
  const amountFormatted = Number(data.amount).toLocaleString('th-TH', { minimumFractionDigits: 0 });
  const filteredMessage = filterProfanity(data.message || '');
  const donorSpan = `<span class="highlight-donor">${escapeForHtml(filterProfanity(data.donor || 'Anonymous'))}</span>`;
  const amountSpan = `<span class="highlight-amount shine-effect">${escapeForHtml(amountFormatted)}</span>`;
  const suffixSpan = `<span class="highlight-suffix shine-effect">${escapeForHtml((overlaySettings.amountSuffix || 'บาท').trim())}</span>`;
  const line1 = (overlaySettings.template_line1 || overlaySettings.messageTemplate || '{ผู้โดเนท} ได้เลี้ยงกาแฟ')
    .replace(/\{ผู้โดเนท\}|\{donor\}/g, () => donorSpan)
    .replace(/\{จำนวนเงิน\}|\{amount\}/g, () => amountSpan)
    .replace(/\{สกุลเงิน\}/g, () => suffixSpan);

  if (overlaySettings.ttsReadDonor) {
    const cleanHeader = line1.replace(/<[^>]*>/g, '');
    const ttsSuffix = (overlaySettings.amountSuffix || 'บาท').trim();
    const headerPrefix = cleanHeader.split(amountFormatted)[0];
    return `${headerPrefix}${amountFormatted} ${ttsSuffix}${data.message ? (overlaySettings.ttsPrefixEnabled ? `. ฝากข้อความว่า ${filteredMessage}` : `. ${filteredMessage}`) : ''}`;
  }
  return filteredMessage;
}

async function prepareAlertTts(data) {
  if (!overlaySettings.ttsEnabled) return null;
  // codex adversarial-review round 2 2026-08-11: buildAlertSpeechText() was previously called
  // *outside* this try — a malformed alert (e.g. a non-string `message`, which /api/alerts/test
  // doesn't coerce) throws there, and since processQueue() sets isShowing=true before awaiting
  // this function and never catches its rejection, that exception would deadlock the queue
  // permanently (every later alert stays queued forever). Now every step is guarded.
  try {
    const speakText = buildAlertSpeechText(data).trim();
    if (!speakText) return null;
    return await prepareSpeech(speakText, overlaySettings.ttsLanguage, overlaySettings.ttsVolume, overlaySettings.ttsRate, overlaySettings.ttsVoice);
  } catch (err) {
    console.error('TTS prepare error:', err);
    return null; // terminal silent outcome — never let a prepare failure hang the queue
  }
}

// ========== Static Preview (frozen idle state) ==========
// Only active on /overlay with no token (dashboard iframe, not real OBS overlay)
function isDashboardPreview() {
  return !new URLSearchParams(window.location.search).get('token');
}

function showStaticPreview() {
  if (isShowing || currentStickyAlertBox || !isDashboardPreview()) return;

  if (staticPreviewEl) {
    staticPreviewEl.remove();
    staticPreviewEl = null;
  }

  const template = document.getElementById('alertTemplate');
  const container = document.getElementById('alertContainer');
  if (!template || !container) return;

  const clone = template.content.cloneNode(true);
  const alertBox = clone.querySelector('.alert-box');

  alertBox.classList.add(`theme-${overlaySettings.theme}`);
  alertBox.classList.add('static-preview');

  const sampleDonor = 'ผู้สนับสนุนลึกลับ';
  const sampleAmount = '500';
  const suffixSafe = escapeForHtml((overlaySettings.amountSuffix || 'บาท').trim());
  const donorSpan = `<span class="highlight-donor">${escapeForHtml(sampleDonor)}</span>`;
  const amountSpan = `<span class="highlight-amount shine-effect">${escapeForHtml(sampleAmount)}</span>`;
  const suffixSpan = `<span class="highlight-suffix shine-effect">${suffixSafe}</span>`;

  function renderTemplate(tpl) {
    return tpl
      .replace(/\{ผู้โดเนท\}|\{donor\}/g, () => donorSpan)
      .replace(/\{จำนวนเงิน\}|\{amount\}/g, () => amountSpan)
      .replace(/\{สกุลเงิน\}/g, () => suffixSpan);
  }

  const line1 = renderTemplate(overlaySettings.template_line1 || overlaySettings.messageTemplate || '{ผู้โดเนท} ได้เลี้ยงกาแฟ');
  const line2 = renderTemplate(overlaySettings.template_line2 || '');

  alertBox.querySelector('.donor-name').innerHTML = line1;
  const amountEl = alertBox.querySelector('.alert-amount');
  if (line2) {
    amountEl.innerHTML = line2;
    amountEl.style.display = '';
  } else {
    amountEl.innerHTML = '';
    amountEl.style.display = 'none';
  }

  const iconEmojiEl = alertBox.querySelector('.icon-emoji');
  const iconContainer = alertBox.querySelector('.alert-icon');
  const isTextOnly = overlaySettings.theme === 'text-only';

  if (iconEmojiEl && iconContainer) {
    iconEmojiEl.textContent = '';
    if ((overlaySettings.customImageMode === 'url' || overlaySettings.customImageMode === 'upload') && overlaySettings.customImageValue) {
      const img = document.createElement('img');
      img.src = overlaySettings.customImageValue;
      img.className = 'custom-alert-img';
      iconEmojiEl.appendChild(img);
      iconContainer.style.display = 'flex';
    } else if (overlaySettings.customImageMode === 'emoji') {
      if (overlaySettings.customImageValue) {
        iconEmojiEl.textContent = overlaySettings.customImageValue;
      } else {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-heart';
        iconEmojiEl.appendChild(icon);
      }
      iconContainer.style.display = isTextOnly ? 'none' : 'flex';
    } else {
      iconContainer.style.display = 'none';
    }
    if ((overlaySettings.customImageMode === 'url' || overlaySettings.customImageMode === 'upload') && !overlaySettings.customImageValue) {
      iconContainer.style.display = 'none';
    }
  }

  const messageElement = alertBox.querySelector('.alert-message');
  if (messageElement) {
    messageElement.textContent = overlaySettings.showDonorMessage ? 'ขอบคุณสำหรับการสนับสนุน! 🎉' : '';
  }

  const progressEl = alertBox.querySelector('.alert-progress');
  if (progressEl) progressEl.style.display = 'none';

  alertBox.style.opacity = '0';
  alertBox.style.transition = 'opacity 0.7s ease';
  container.appendChild(alertBox);
  staticPreviewEl = alertBox;
  applyOutline(overlaySettings);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (staticPreviewEl === alertBox) alertBox.style.opacity = '1';
    });
  });
}

// ========== Show Alert Panel ==========
// ========== Profanity Filter (Anti-Troll) ==========
function filterProfanity(text) {
  if (!text || !overlaySettings.profanityFilterEnabled) return text;
  
  let censoredText = text;
  const wordsStr = overlaySettings.profanityWords || '';
  const words = wordsStr
    .split(',')
    .map(w => w.trim())
    .filter(w => w.length > 0);
  
  if (words.length === 0) return text;
  
  // 1. บล็อกทั้งข้อความหากมีคำหยาบ (แสดงข้อความถูกกรองโดยระบบ)
  if (overlaySettings.profanityReplaceStyle === 'block') {
    const hasProfanity = words.some(w => censoredText.toLowerCase().includes(w.toLowerCase()));
    if (hasProfanity) {
      return '[ข้อความไม่เหมาะสม ถูกบล็อกโดยระบบ]';
    }
  }

  // 2. เซนเซอร์ด้วยเครื่องหมายดอกจันหรือคำสุภาพน่ารัก
  words.forEach(word => {
    const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(escapedWord, 'gi');
    
    if (overlaySettings.profanityReplaceStyle === 'polite') {
      const politeReplacements = ['รักนะ', 'ชื่นชม', 'สู้ๆ', 'ยินดี', 'ขอบคุณ'];
      censoredText = censoredText.replace(regex, () => politeReplacements[Math.floor(Math.random() * politeReplacements.length)]);
    } else {
      censoredText = censoredText.replace(regex, (match) => '*'.repeat(match.length));
    }
  });

  return censoredText;
}

// Fills an already-cloned .alert-box with donor/amount/message/icon content. Shared by showAlert()
// (live queue) and displayPinnedAlert() (held alert) so both render identically.
function renderAlertVisual(alertBox, data) {
  // Format amount and escape values for template rendering
  const amountFormatted = Number(data.amount).toLocaleString('th-TH', { minimumFractionDigits: 0 });
  const filteredDonor = escapeForHtml(filterProfanity(data.donor || 'Anonymous'));
  const filteredMessage = filterProfanity(data.message || '');
  const suffixSafe = escapeForHtml((overlaySettings.amountSuffix || 'บาท').trim());

  const donorSpan = `<span class="highlight-donor">${filteredDonor}</span>`;
  const amountSpan = `<span class="highlight-amount shine-effect">${escapeForHtml(amountFormatted)}</span>`;
  const suffixSpan = `<span class="highlight-suffix shine-effect">${suffixSafe}</span>`;

  function renderTemplate(tpl) {
    return tpl
      .replace(/\{ผู้โดเนท\}|\{donor\}/g, () => donorSpan)
      .replace(/\{จำนวนเงิน\}|\{amount\}/g, () => amountSpan)
      .replace(/\{สกุลเงิน\}/g, () => suffixSpan);
  }

  const line1 = renderTemplate(overlaySettings.template_line1 || overlaySettings.messageTemplate || '{ผู้โดเนท} ได้เลี้ยงกาแฟ');
  const line2 = renderTemplate(overlaySettings.template_line2 || '');

  // Set content
  const donorNameEl = alertBox.querySelector('.donor-name');
  donorNameEl.innerHTML = line1;
  // Handle Custom Icon/Image
  const iconEmojiEl = alertBox.querySelector('.icon-emoji');
  const iconContainer = alertBox.querySelector('.alert-icon');
  const isTextOnly = alertBox.classList.contains('theme-text-only');

  // TIER_DONATE_BLUEPRINT.md § 5.1 — donor's tier image pick overrides the streamer's default alert image/emoji entirely
  const tierImageUrl = data.tierImageUrl || null;

  if (iconEmojiEl && iconContainer) {
    iconEmojiEl.textContent = '';
    if (tierImageUrl) {
      const el = /\.webm(\?|$)/i.test(tierImageUrl) ? document.createElement('video') : document.createElement('img');
      if (el.tagName === 'VIDEO') { el.autoplay = true; el.loop = true; el.muted = true; el.playsInline = true; }
      el.src = tierImageUrl;
      el.className = 'custom-alert-img';
      iconEmojiEl.appendChild(el);
      iconContainer.style.display = 'flex';
    } else if ((overlaySettings.customImageMode === 'url' || overlaySettings.customImageMode === 'upload') && overlaySettings.customImageValue) {
      const img = document.createElement('img');
      img.src = overlaySettings.customImageValue;
      img.className = 'custom-alert-img';
      iconEmojiEl.appendChild(img);
      iconContainer.style.display = 'flex';
    } else if (overlaySettings.customImageMode === 'emoji') {
      if (overlaySettings.customImageValue) {
        iconEmojiEl.textContent = overlaySettings.customImageValue;
      } else {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-heart';
        iconEmojiEl.appendChild(icon);
      }
      // In Text Only theme, emojis/text icons are hidden
      iconContainer.style.display = isTextOnly ? 'none' : 'flex';
    } else {
      iconContainer.style.display = 'none';
    }

    // Special case: hide if URL is empty but mode is url/upload (only when no tier override is active)
    if (!tierImageUrl && (overlaySettings.customImageMode === 'url' || overlaySettings.customImageMode === 'upload') && !overlaySettings.customImageValue) {
      iconContainer.style.display = 'none';
    }
  }

  const amountEl2 = alertBox.querySelector('.alert-amount');
  if (line2) {
    amountEl2.innerHTML = line2;
    amountEl2.style.display = '';
  } else {
    amountEl2.innerHTML = '';
    amountEl2.style.display = 'none';
  }

  // User private message
  const messageElement = alertBox.querySelector('.alert-message');
  if (overlaySettings.showDonorMessage && data.message) {
    messageElement.textContent = filteredMessage;
  } else {
    messageElement.textContent = '';
  }
}

// R15 — ttsArtifact is prepared by processQueue() before this function is even called; showAlert()
// only plays it, never fetches/synthesizes TTS itself.
async function showAlert(data, ttsArtifact = null, alertToken = null) {
  if (staticPreviewEl) {
    const el = staticPreviewEl;
    staticPreviewEl = null;
    el.style.transition = 'opacity 0.25s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 280);
  }
  if (currentStickyAlertBox) {
    const el = currentStickyAlertBox;
    currentStickyAlertBox = null;
    el.classList.add('exit');
    setTimeout(() => el.remove(), 550);
  }

  const template = document.getElementById('alertTemplate');
  const clone = template.content.cloneNode(true);
  const alertBox = clone.querySelector('.alert-box');

  // Apply Theme and Animation classes
  alertBox.classList.add(`theme-${overlaySettings.theme}`);
  alertBox.classList.add(`anim-${overlaySettings.animation}`);

  renderAlertVisual(alertBox, data);

  // Register as the current alert before the sound/TTS awaits below, so a Skip arriving mid-await
  // (before any timer exists to clearTimeout) can still find and remove this box. alertToken was
  // created by processQueue(); every continuation after an await re-checks alertToken.cancelled
  // before touching shared state or starting anything new.
  if (alertToken) {
    currentAlertBox = alertBox;
  }

  const alertDurationMs = (Number(overlaySettings.duration) || 8) * 1000;

  // Append to overlay
  const container = document.getElementById('alertContainer');
  container.appendChild(alertBox);
  applyOutline(overlaySettings);
  const shownAt = performance.now();

  // Spawn visual particles immediately
  setTimeout(() => spawnParticles(alertBox, overlaySettings.particleCount), 300);

  // Play Alert Audio Notification
  // TIER_DONATE_BLUEPRINT.md § 5.1 — donor's tier sound pick overrides the streamer's configured alert sound entirely
  if (overlaySettings.soundEnabled) {
    if (data.tierYoutubeId) {
      await playYoutubeTierSound(data.tierYoutubeId, data.tierYoutubeStart, data.tierYoutubeEnd, overlaySettings.soundVolume);
    } else if (data.tierSoundUrl) {
      await playAudioUrlOnce(data.tierSoundUrl, overlaySettings.soundVolume);
    } else {
      await playNotificationSound(overlaySettings.soundChoice, overlaySettings.soundVolume);
    }
  }

    // Skip landed while the notification sound above was still playing: stopAllAlertAudio() cut
    // that sound, which *resolves* the await and resumes us right here — so without this check we
    // would start speaking an alert the user already skipped, and it would keep talking until a
    // second Skip. One Skip must end the whole alert, TTS included.
    if (alertToken && alertToken.cancelled) return;

    // Play Speech Synthesis (TTS) — already prepared/ready by processQueue() before this alert
    // was even rendered (R15); playSpeech() is a no-op when ttsArtifact is null (TTS off, empty
    // text, or a terminal silent outcome where neither the provider nor its fallback loaded).
    try {
      playSpeech(ttsArtifact);
    } catch (err) {
      console.error('TTS play error:', err);
    }

  // Set progress bar now (after sound await) so it ends exactly when the alert is removed.
  // Delay only covers whatever remains of the entrance animation.
  const ENTRANCE_MS = { 'slide-down': 600, 'slide-up': 600, 'fade': 500, 'zoom': 600 };
  const EXIT_MS = 550; // must match the exit setTimeout in the auto-remove block below
  const entranceMs = ENTRANCE_MS[overlaySettings.animation] || 600;
  const elapsedMs = performance.now() - shownAt;
  const barDelayMs = Math.max(entranceMs - elapsedMs, 0);
  const barDurationMs = Math.max(alertDurationMs + EXIT_MS - barDelayMs, 500);
  const progressBar = alertBox.querySelector('.alert-progress-bar');
  progressBar.style.animation = `progressShrink ${barDurationMs}ms linear ${barDelayMs}ms both`;

  if (data.sticky) {
    // Sticky preview: stay on screen until explicitly cleared by a real alert or clear_sticky_alert event.
    currentStickyAlertBox = alertBox;
    const ENTRANCE_MS = { 'slide-down': 600, 'slide-up': 600, 'fade': 500, 'zoom': 600 };
    const entranceMs = ENTRANCE_MS[overlaySettings.animation] || 600;
    setTimeout(() => {
      isShowing = false;
      processQueue();
    }, entranceMs);
  } else {
    // Skip already force-removed this alert while showAlert() was still awaiting sound/TTS above
    // (no timer existed yet for forceSkipCurrentAlert() to clearTimeout) — bail out instead of
    // scheduling a timer for a box that's already gone, or stomping on whichever alert is next.
    if (alertToken.cancelled) return;
    currentAlertTimeoutId = setTimeout(() => {
      if (alertToken.cancelled) return;
      alertBox.classList.add('exit');

      // Reassign (not a second, untracked timer) so a Skip landing during this exit animation
      // still clears the correct pending timer via forceSkipCurrentAlert()'s clearTimeout.
      currentAlertTimeoutId = setTimeout(() => {
        if (alertToken.cancelled) return;
        alertBox.remove();
        isShowing = false;
        currentAlertBox = null;
        currentAlertToken = null;
        currentAlertTimeoutId = null;
        processQueue(); // a pin requested mid-alert gets its turn here, before the rest of the queue
        if (alertQueue.length === 0) {
          setTimeout(showStaticPreview, 700);
        }
      }, 550);
    }, alertDurationMs);
  }
}

// ========== Skip/Pin (ALERT_CONTROL_CONTRACT_BLUEPRINT.md — Senior-approved contract) ==========

// Cuts every sound path an alert can be playing: TTS (fetched clip or Web Speech) plus whatever
// tier/custom audio playAudioUrlOnce()/playYoutubeTierSound() currently owns. Skip must silence
// the alert it removes, not leave it audible over the next one.
function stopAllAlertAudio() {
  cancelCurrentSpeech();
  if (stopActiveAlertAudio) {
    try { stopActiveAlertAudio(); } catch {}
    stopActiveAlertAudio = null;
  }
}

// Tears down whatever alert is on screen (live or pinned) without advancing the queue.
// Returns true if there was something to tear down.
function teardownCurrentAlert() {
  if (currentAlertToken) {
    currentAlertToken.cancelled = true;
    currentAlertToken = null;
  }
  if (currentAlertTimeoutId) {
    clearTimeout(currentAlertTimeoutId);
    currentAlertTimeoutId = null;
  }
  const el = currentAlertBox;
  currentAlertBox = null;
  if (!el) return false;
  el.classList.add('exit');
  setTimeout(() => el.remove(), 550);
  return true;
}

// Skip = ตัดจบทุกอย่าง then release the queue immediately: kill audio, drop the alert (live or
// pinned), clear the pin, and let the next queued alert run as a normal alert would.
function forceSkipCurrentAlert() {
  stopAllAlertAudio();
  const had = teardownCurrentAlert();
  isPinned = false;
  pendingPin = null; // Skip drops a pin waiting its turn too — the server clears its pin state as well
  if (!had && !isShowing) return; // nothing was on screen — queue is already free
  isShowing = false;
  processQueue();
  if (alertQueue.length === 0) {
    setTimeout(showStaticPreview, 700);
  }
}

// Pin ("ตรึง") never cuts in front of an alert that is already playing — it waits its turn like a
// queued alert, then displays and holds until unpinned or skipped. Pressing Pin only *requests*
// it; processQueue() is what actually puts it on screen, ahead of the alerts queued after it.
//
//   Alert 2 playing → Pin Alert 1 → (Alert 2 finishes) → Alert 1 held → unpin/skip → Alert 3
//   Alert 1 playing → Pin Alert 1 → (Alert 1 finishes) → Alert 1 held → unpin/skip → Alert 2
//
// Pinning the alert that is currently playing is not a special case: it still plays out normally
// first, then comes back as a held display.
function applyPinAlert(data) {
  // Latest-wins. A pin already on screen is static, so swapping it is not an interruption.
  if (isPinned) {
    teardownCurrentAlert();
    isPinned = false;
    displayPinnedAlert(data);
    return;
  }
  pendingPin = data; // replaces any earlier pin still waiting for its turn
  if (!isShowing) processQueue(); // nothing playing — its turn is now
}

// Shows the held alert: visuals only. No notification sound, and no TTS synthesis at all — the
// artifact is never prepared, so this is silent by construction rather than muted.
function displayPinnedAlert(data) {
  if (staticPreviewEl) {
    const el = staticPreviewEl;
    staticPreviewEl = null;
    el.style.transition = 'opacity 0.25s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 280);
  }

  const template = document.getElementById('alertTemplate');
  const clone = template.content.cloneNode(true);
  const alertBox = clone.querySelector('.alert-box');
  alertBox.classList.add(`theme-${overlaySettings.theme}`);
  alertBox.classList.add(`anim-${overlaySettings.animation}`);
  alertBox.classList.add('pinned-alert');
  renderAlertVisual(alertBox, data);

  const progressBar = alertBox.querySelector('.alert-progress-bar');
  if (progressBar) progressBar.style.display = 'none'; // nothing is counting down — no bar to show

  document.getElementById('alertContainer').appendChild(alertBox);
  applyOutline(overlaySettings);
  setTimeout(() => spawnParticles(alertBox, overlaySettings.particleCount), 300);

  currentAlertBox = alertBox;
  isPinned = true;
  isShowing = true; // holds the queue: nothing else runs until unpin/skip
}

// Unpin: drop the held alert and let the queue resume. Unpinning before the pin ever got its turn
// just cancels the request — the alert playing at the time is left alone.
function releasePinnedAlert() {
  if (!isPinned) {
    pendingPin = null;
    return;
  }
  isPinned = false;
  teardownCurrentAlert();
  isShowing = false;
  processQueue();
  if (alertQueue.length === 0) {
    setTimeout(showStaticPreview, 700);
  }
}

// ========== Web Audio API Notification Synthesizer ==========
let audioCtx = null;

// ========== YouTube Tier Sound (YOUTUBE_TIER_SOUND_BLUEPRINT.md §9) ==========
let ytApiLoadingOverlay = false;

function ensureYoutubeApi(cb, onFail) {
  if (window.YT && window.YT.Player) return cb();
  if (ytApiLoadingOverlay) {
    const check = setInterval(() => { if (window.YT && window.YT.Player) { clearInterval(check); cb(); } }, 100);
    return;
  }
  ytApiLoadingOverlay = true;
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    ytApiLoadingOverlay = false;
    if (onFail) onFail();
  }, 10000);
  window.onYouTubeIframeAPIReady = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    ytApiLoadingOverlay = false;
    cb();
  };
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function playYoutubeTierSound(videoId, startSec, endSec, volume) {
  return new Promise((resolve) => {
    ensureYoutubeApi(() => {
      const hiddenDiv = document.createElement('div');
      hiddenDiv.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:200px;height:200px;opacity:0;pointer-events:none;';
      document.body.appendChild(hiddenDiv);
      let done = false;
      let iv;
      let playerRef = null;
      const finish = (player) => {
        if (done) return;
        done = true;
        clearTimeout(constructTimeout);
        clearInterval(iv);
        if (stopActiveAlertAudio === stopThis) stopActiveAlertAudio = null;
        try { (player || playerRef)?.destroy(); } catch {}
        hiddenDiv.remove();
        resolve();
      };
      const stopThis = () => finish(playerRef);
      stopActiveAlertAudio = stopThis; // lets Skip cut this clip mid-playback
      // codex adversarial-review round 4 2026-08-11: onReady/onError aren't guaranteed to fire if
      // player construction/iframe loading itself stalls (network blip, blocked iframe) — the
      // per-playback watchdog below only exists *inside* onReady, so that gap had no timeout at
      // all. Cover construction-through-ready with its own bound, cleared once onReady fires.
      const constructTimeout = setTimeout(() => finish(playerRef), 10000);
      playerRef = new YT.Player(hiddenDiv, {
        videoId,
        playerVars: { autoplay: 0, controls: 0, modestbranding: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: (e) => {
            clearTimeout(constructTimeout);
            // codex adversarial-review round 5 2026-08-11: clearing constructTimeout leaves no
            // watchdog covering setVolume/seekTo/playVideo until the setInterval/setTimeout below
            // are reached — a synchronous throw from any of them (bad/destroyed player state) would
            // otherwise leave finish() never scheduled, deadlocking the queue exactly like the gaps
            // rounds 1-4 closed elsewhere in this file.
            try {
              e.target.setVolume(Math.round((Number(volume) || 0.5) * 100));
              e.target.seekTo(startSec, true);
              e.target.playVideo();
              iv = setInterval(() => {
                if (e.target.getCurrentTime() >= endSec) { finish(e.target); }
              }, 100);
              setTimeout(() => { finish(e.target); }, (endSec - startSec) * 1000 + 1500);
            } catch (err) {
              console.warn('[YT overlay] onReady error', err);
              finish(e.target);
            }
          },
          onError: (e) => { console.warn('[YT overlay] error', e.data); finish(e.target); }
        }
      });
    }, () => resolve());
  });
}

// codex adversarial-review round 3 2026-08-11: an `onended`-only promise never settles if
// playback starts successfully (play() resolves) but then stalls or errors mid-stream (dropped
// network, corrupt file) — no onerror handler and no timeout meant showAlert()'s await could hang
// forever, permanently deadlocking the queue exactly like the R15 fetch-deadline bug did. Shared
// by every raw-URL playback path (tier sound, custom sound, custom sound URL) so the fix lives in
// one place instead of three copies that could drift.
function playAudioUrlOnce(url, volume, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const audio = new Audio(url);
    audio.volume = Number(volume) || 0.5;
    const timer = setTimeout(done, timeoutMs);
    // codex adversarial-review round 4 2026-08-11: the timeout path used to just resolve without
    // stopping the element — a stalled clip could keep buffering/playing and then audibly resume
    // (or emit ended/error late) after the queue had already moved on to later alerts. Stop it on
    // every settle path, not just onended, so a late event can never affect a subsequent alert.
    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.onended = null;
      audio.onerror = null;
      if (stopActiveAlertAudio === done) stopActiveAlertAudio = null;
      try { audio.pause(); audio.src = ''; } catch {}
      resolve();
    }
    stopActiveAlertAudio = done; // lets Skip cut this clip mid-playback
    audio.onended = done;
    audio.onerror = () => { console.warn('Audio playback failed'); done(); };
    audio.play().catch(err => { console.warn('Audio play() rejected:', err.message); done(); });
  });
}

async function playNotificationSound(soundChoice, volume) {
  try {
    if (soundChoice === 'none') return Promise.resolve();
    
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    const now = audioCtx.currentTime;
    
    // Create master gain control
    const masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(Number(volume) || 0.5, now);
    masterGain.connect(audioCtx.destination);

    if (soundChoice === 'custom') {
      return playAudioUrlOnce('/assets/audio/my-sound.mp3', volume);
    }
    else if (soundChoice === 'custom_url' || soundChoice === 'upload_sound') {
      if (!overlaySettings.customSoundUrl) {
        console.warn('Custom sound URL is empty');
        return Promise.resolve();
      }
      return playAudioUrlOnce(overlaySettings.customSoundUrl, volume);
    }
    
    if (soundChoice === 'chime') {

      // 3-note classic chime (D5 -> A5 -> D6)
      const notes = [
        { freq: 587.33, start: 0, duration: 0.15 },
        { freq: 880.00, start: 0.12, duration: 0.25 },
        { freq: 1174.66, start: 0.28, duration: 0.35 }
      ];

      notes.forEach(note => {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.freq, now + note.start);
        
        gainNode.gain.setValueAtTime(0, now + note.start);
        gainNode.gain.linearRampToValueAtTime(0.25, now + note.start + 0.03);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);
        
        osc.connect(gainNode);
        gainNode.connect(masterGain);
        
        osc.start(now + note.start);
        osc.stop(now + note.start + note.duration + 0.05);
      });
      return new Promise(resolve => setTimeout(resolve, 700));
    } 
    else if (soundChoice === 'retro') {
      // 8-bit Arcade coin jump sound (Quick rising pitch)
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      osc.type = 'square';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.25); // C6
      
      gainNode.gain.setValueAtTime(0.15, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      
      osc.connect(gainNode);
      gainNode.connect(masterGain);
      
      osc.start(now);
      osc.stop(now + 0.3);
      return new Promise(resolve => setTimeout(resolve, 400));
    } 
    else if (soundChoice === 'modern') {
      // Warm modern synthesizer pad chord
      const oscTypes = ['sine', 'triangle'];
      const freqs = [329.63, 392.00, 523.25, 659.25]; // E4, G4, C5, E5
      
      freqs.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        osc.type = oscTypes[idx % oscTypes.length];
        osc.frequency.setValueAtTime(freq, now);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.08, now + 0.1);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.6 + (idx * 0.1));
        
        osc.connect(gainNode);
        gainNode.connect(masterGain);
        
        osc.start(now);
        osc.stop(now + 1.0);
      });
      return new Promise(resolve => setTimeout(resolve, 1100));
    } 
    else if (soundChoice === 'bell') {
      // Soft high bell chime (Crystal resonance)
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1567.98, now); // G6
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.8); // G5
      
      gainNode.gain.setValueAtTime(0.3, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
      
      osc.connect(gainNode);
      gainNode.connect(masterGain);
      
      osc.start(now);
      osc.stop(now + 0.9);
      return new Promise(resolve => setTimeout(resolve, 1000));
    }
    return Promise.resolve();
  } catch (err) {
    console.warn('Audio synthesis failed:', err);
    return Promise.resolve();
  }
}

// ========== Web Speech API (TTS) Prepare/Play Engine ==========
// R15 — split into prepare (resolve a ready-to-play artifact, or null on a terminal silent
// outcome) and play, so the queue can await readiness *before* the alert box renders instead of
// firing the request after render and leaving a silent gap while it synthesizes (Vertex latency).
let currentTtsAudio = null; // module-level — lets us cancel a still-playing TTS clip when a new alert arrives
let currentTtsAbort = null; // cancels an in-flight fetch too — a slow paid-mode request must not play after a newer alert
let ttsRequestSeq = 0;      // guards against a fetch that resolves after being superseded (abort() isn't instant)

// Never throws / never rejects — always resolves to an artifact or null, so the queue can never
// hang waiting on a promise that doesn't settle. null = nothing to play (TTS off, empty text, or
// both the requested voice and the server's own provider+Google-Translate fallback failed to
// produce playable audio — a "terminal silent outcome" per R15, not an error to surface further).
async function prepareSpeech(text, lang = 'th-TH', volume = 0.8, rate = 1.0, voiceName = 'default') {
  const truncatedText = text.substring(0, 180);

  // R13 — Microsoft voices (เปรมวดี/นิวัฒน์) moved client-side: server Edge TTS is an unofficial
  // endpoint that now 403s. The browser's own Web Speech API can still say them for free with zero
  // server round-trip if the OS/browser ships the voice; if not, fall through to the fetch below,
  // which already lands on Google Translate free mode server-side (edgeTts() throws → catch-all fallback).
  // Readiness here is synchronous (no network) — the utterance object itself is the artifact.
  if (voiceName && voiceName.startsWith('th-TH-') && 'speechSynthesis' in window) {
    const match = window.speechSynthesis.getVoices().find(v => v.name === voiceName || v.voiceURI === voiceName);
    if (match) {
      const utter = new SpeechSynthesisUtterance(truncatedText);
      utter.voice = match;
      utter.lang = lang;
      utter.volume = Number(volume) || 0.8;
      utter.rate = Number(rate) || 1.0;
      return { type: 'webspeech', utter };
    }
  }

  // R8 codex adversarial-review round 2 — the demo page (window.DEMO_MODE) calls a fully isolated
  // free-only endpoint, same convention as loadInitialSettings()/connectSSE() above, instead of
  // relying on server-side session/token guessing that couldn't tell the demo account's own real
  // OBS overlay apart from a public demo visitor (they're the same request shape).
  const token = new URLSearchParams(window.location.search).get('token');
  const localTtsUrl = DEMO_MODE_OVERLAY
    ? `/api/demo/tts?lang=${lang.split('-')[0]}&text=${encodeURIComponent(truncatedText)}`
    : `/api/tts?token=${encodeURIComponent(token || '')}&lang=${lang.split('-')[0]}&text=${encodeURIComponent(truncatedText)}`;
  // cancel any fetch still in-flight from a previous alert (superseded — its artifact would never be played)
  if (currentTtsAbort) { currentTtsAbort.abort(); currentTtsAbort = null; }
  const mySeq = ++ttsRequestSeq;
  const abortCtrl = new AbortController();
  currentTtsAbort = abortCtrl;
  // codex adversarial-review 2026-08-11: a fetch with no deadline of its own can hang forever —
  // isShowing stays true the whole time, so no later alert can ever start a prepare that would
  // abort this one, deadlocking the queue permanently. The server's 10s provider deadline is not
  // the whole request: a paid-provider failure can spend another 10s in the Google-free fallback
  // (and paid providers may perform setup/retry work). Keep a bounded client deadline, but leave
  // enough time for the uncached live request to complete before treating it as terminal silence.
  const TTS_FETCH_TIMEOUT_MS = 30000;
  const timeoutId = setTimeout(() => abortCtrl.abort(), TTS_FETCH_TIMEOUT_MS);
  try {
    // fetch as blob (not <audio src=...> directly) so we control lifecycle/cancellation
    // cache: 'no-store' — a browser/OBS session left open since before the server's Cache-Control
    // fix (server.js /api/tts) may still hold a year-long-cached response for this exact URL; the
    // server header alone can't invalidate what's already sitting in the HTTP cache.
    const res = await fetch(localTtsUrl, { signal: abortCtrl.signal, cache: 'no-store' });
    if (mySeq !== ttsRequestSeq) return null; // superseded by a newer alert while this was in flight
    if (!res.ok) throw new Error('TTS ' + res.status);
    const blob = await res.blob();
    if (mySeq !== ttsRequestSeq) return null;
    const objUrl = URL.createObjectURL(blob);
    const audio = new Audio();
    audio._objUrl = objUrl;
    audio._targetRate = Number(rate) || 1.0; // Chromium resets playbackRate when load() assigns a new resource — reapply right before play() in playSpeech()
    audio.volume = Number(volume) || 0.8;
    audio.playbackRate = audio._targetRate;
    // a resolved fetch isn't "ready" — wait for the browser to confirm it can actually play the
    // blob before treating it as prepared. codex adversarial-review 2026-08-11: the wait cap must
    // resolve false (terminal silent), not true — resolving true here would render the alert and
    // call play() on audio the browser never proved playable, exactly the "call it and assume
    // ready" bug R15 exists to eliminate.
    const ready = await new Promise((resolve) => {
      let settled = false;
      const onReady = () => done(true);
      const onError = () => done(false);
      const done = (ok) => {
        if (settled) return;
        settled = true;
        audio.removeEventListener('canplaythrough', onReady);
        audio.removeEventListener('loadeddata', onReady);
        audio.removeEventListener('error', onError);
        resolve(ok);
      };
      audio.addEventListener('canplaythrough', onReady, { once: true });
      audio.addEventListener('loadeddata', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
      setTimeout(() => done(false), 4000);
      audio.src = objUrl;
      audio.load();
    });
    if (mySeq !== ttsRequestSeq) { URL.revokeObjectURL(objUrl); return null; }
    if (!ready) { URL.revokeObjectURL(objUrl); return null; } // terminal silent outcome
    return { type: 'audio', audio };
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('⚠️ TTS prepare failed:', err.message); // never log the URL/token/text itself, message only
    return null; // terminal silent outcome
  } finally {
    clearTimeout(timeoutId);
    if (currentTtsAbort === abortCtrl) currentTtsAbort = null;
  }
}

function playSpeech(artifact) {
  if (!artifact) return;
  if (currentTtsAudio) { currentTtsAudio.pause(); if (currentTtsAudio._objUrl) URL.revokeObjectURL(currentTtsAudio._objUrl); currentTtsAudio.src = ''; currentTtsAudio = null; }
  if (artifact.type === 'webspeech') {
    window.speechSynthesis.cancel(); // stop whatever a previous alert queued/was speaking
    window.speechSynthesis.speak(artifact.utter);
    return;
  }
  const audio = artifact.audio;
  currentTtsAudio = audio;
  audio.onended = () => { URL.revokeObjectURL(audio._objUrl); if (currentTtsAudio === audio) currentTtsAudio = null; };
  audio.onerror = () => { URL.revokeObjectURL(audio._objUrl); if (currentTtsAudio === audio) currentTtsAudio = null; };
  if (audio._targetRate) audio.playbackRate = audio._targetRate; // reassert — load() may have silently reset it
  audio.play().catch(() => { URL.revokeObjectURL(audio._objUrl); });
}



// ========== Particle Effects Generator ==========
function spawnParticles(alertBox, particleCount = 12) {
  const rect = alertBox.getBoundingClientRect();
  const colors = [
    overlaySettings.primaryColor, 
    overlaySettings.secondaryColor, 
    '#f093fb', 
    '#ffd700', 
    '#00f3ff'
  ];
  
  const count = Number(particleCount) || 0;
  if (count <= 0) return;

  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';

    const x = rect.left + Math.random() * rect.width;
    const y = rect.top + Math.random() * rect.height;

    const tx = (Math.random() - 0.5) * 180;
    const ty = (Math.random() - 0.7) * 140;

    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    particle.style.setProperty('--tx', `${tx}px`);
    particle.style.setProperty('--ty', `${ty}px`);
    
    const size = 6 + Math.random() * 4;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;


    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 1000);
  }
}

// ========== Boot Sequence ==========
window.addEventListener('DOMContentLoaded', async () => {
  await loadInitialSettings();
  connectSSE();
});
