// State
let selectedAmount = 0;
let timerPublicConfig = null;
let timerActive = false;             // mirror จาก server — drives gate (TIMER_CHOICE_GATE B1)
let overlayActive = false;           // mirror จาก server — drives statusBtn
let widgetStatusSource = null;       // EventSource for real-time widget status
let widgetStatusRetryDelay = 3000;   // manual reconnect backoff (EventSource gives up after a 503)
let widgetStatusRetryTimer = null;
let timerChoice = 'add';
let restoredTimerAction = null;
let hasRestoredTimerAction = false;
let selectedPaymentMethod = 'ffp';
let currentChargeId = null;
let pollInterval = null;
let countdownInterval = null;
let qrExpiresAt = null;
const POLLING_TIMEOUT = 600000; // 10 minutes
const QR_EXPIRY = 10 * 60 * 1000; // 10 minutes
let pollingStartTime = null;

// P1-3: pause bg video เมื่อสลับแท็บ/ซ่อนหน้า — ประหยัด CPU/แบต
document.addEventListener('visibilitychange', () => {
  const bgVid = document.getElementById('page-bg-video');
  if (!bgVid) return;
  if (document.hidden) bgVid.pause();
  else bgVid.play().catch(() => {});
});

// TrueMoney webhook QR state
let trueMoneyQrMethod = 'P2P';
const TRUEMONEY_QR_METHODS = Object.freeze(['P2P', 'PROMPTPAY_IN']);
let trueMoneyQrRequestSeq = 0;
const trueMoneyQrInFlight = new Map();
let trueMoneyQrRefId = null;
let trueMoneyQrSource = null;
let trueMoneyStatusRetryDelay = 3000; // manual reconnect backoff (EventSource gives up after a 503)
let trueMoneyStatusRetryTimer = null;
let trueMoneyStatusStopped = false;
let trueMoneyQrFallbackTimer = null;
let trueMoneyQrCountdownInterval = null;
let trueMoneyQrExpiresAt = null;

// A method switch makes older responses UI-stale, but it does not cancel the
// server transaction: a donor may already have scanned that QR. Keep it
// payable until the normal 30-minute expiry/cleanup path, while never storing
// or rendering its stale response in this page.
function isCurrentTrueMoneyQrRequest(requestId, requestedMethod) {
  return requestId === trueMoneyQrRequestSeq && requestedMethod === trueMoneyQrMethod;
}

// Tier Donate (TIER_DONATE_BLUEPRINT.md § 4)
let pageSettings = null;
let tierSettings = null;
let currentUnlockedTier = null;
let selectedTierImageUrl = null;
let selectedTierSoundUrl = null;
let selectedTierSoundIsTemp = false;
let selectedTierSoundLabel = '';
let restoredTierSnapshot = null;
let tierMediaRecorder = null;
let tierMicStream = null;
let tierAudioContext = null;
let tierGainNode = null;
let tierRecordedChunks = [];
let tierRecordTimeout = null;
let tierRecordWarmupTimeout = null;
let tierRecordCountdownInterval = null;
let tierRecordPendingBlob = null;
let tierRecordPreviewUrl = null;
let tierRecordOriginalBlob = null;
let tierRecordEqBusy = false;
let tierRecordUploadInFlight = false;
let currentSoundSource = null;

// YouTube Tier Sound (YOUTUBE_TIER_SOUND_BLUEPRINT.md §8.1)
let selectedTierYoutube = null; // { videoId, startSec, endSec } — null = ไม่ได้เลือก
let ytPlayer = null;
let ytPlayerReady = false;
let ytDuration = 0;
let ytStartSec = 0;
let ytEndSec = 10;
let ytApiLoading = false;
let currentYtVideoId = null;
let pendingYtStartSec = null;
let ytPlayTestTimer = null;

// ========== Anti-Bot: Page Token from Server ==========
let pageToken = '';
const metaToken = document.querySelector('meta[name="page-token"]');
if (metaToken) pageToken = metaToken.getAttribute('content') || '';

// Auto-reload if token expired (new deploy / cache)
if (!pageToken) location.reload();

// Global fetch guard: auto-reload on 403 FORBIDDEN (stale token from cache)
const _fetch = window.fetch;
window.fetch = async function(url, options) {
  const res = await _fetch(url, options);
  if (res.status === 403) {
    try {
      const clone = res.clone();
      const body = await clone.json();
      if (body.error === 'FORBIDDEN') {
        console.warn('🔄 Token expired — reloading page...');
        location.reload();
        return new Response(null, { status: 503 });
      }
    } catch (_) {}
  }
  return res;
};

function getAntiBotPayload() {
  return {
    page_token: pageToken,
    contact_email: ''
  };
}
// ========== End Anti-Bot ==========

// ========== Cookie Helpers for Donor Name ==========

function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

// ========== Pending QR Cache (localStorage) ==========

const PENDING_HISTORY_STATE_KEY = 'tipkubPendingPayments';
const PENDING_CLEAR_MARKER_PREFIX = 'tipkubPendingCleared:';
const EXPIRED_QR_GRACE_MS = 10 * 60 * 1000;
const MANUAL_PAYMENT_TTL_MS = 30 * 60 * 1000;
const pendingClearMarkers = new Set();
const HISTORY_PENDING_FIELDS = Object.freeze([
  // Core fields needed to restore the payment step.
  'method', 'amount', 'referenceId', 'expiresAt',
  // Non-PII renderer/expiry fields needed when localStorage is unavailable.
  'qrData', 'recipientName', 'displayAmount', 'savedAt', 'timerAction', 'backedOutAt',
  'tierImageUrl', 'tierSoundUrl', 'tierSoundIsTemp', 'tierSoundMode',
  'tierYoutubeId', 'tierYoutubeStart', 'tierYoutubeEnd'
]);

function isPendingRestorable(pending, now = Date.now(), graceMs = EXPIRED_QR_GRACE_MS) {
  if (!pending || pending.backedOutAt) return false;
  const expiresAt = new Date(pending.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt >= now - graceMs;
}

function isManualPaymentStepFresh(pending, now = Date.now(), ttlMs = MANUAL_PAYMENT_TTL_MS) {
  if (!pending || !Number.isFinite(Number(pending.savedAt))) return false;
  const age = now - Number(pending.savedAt);
  return age >= 0 && age < ttlMs;
}

function getHistoryPendingState(value) {
  const safeValue = {};
  if (!value || typeof value !== 'object') return safeValue;
  HISTORY_PENDING_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(value, field)) safeValue[field] = value[field];
  });
  return safeValue;
}

function getHistoryPendingStates(value) {
  const safeStates = {};
  if (!value || typeof value !== 'object') return safeStates;
  Object.keys(value).forEach(key => {
    const safeValue = getHistoryPendingState(value[key]);
    if (Object.keys(safeValue).length > 0) safeStates[key] = safeValue;
  });
  return safeStates;
}

function getPendingClearMarkerKey(key) {
  return `${PENDING_CLEAR_MARKER_PREFIX}${key}`;
}

function markPendingStateCleared(key) {
  pendingClearMarkers.add(key);
  try { sessionStorage.setItem(getPendingClearMarkerKey(key), '1'); } catch (e) { /* Storage unavailable */ }
}

function clearPendingStateMarker(key) {
  pendingClearMarkers.delete(key);
  try { sessionStorage.removeItem(getPendingClearMarkerKey(key)); } catch (e) { /* Storage unavailable */ }
}

function isPendingStateCleared(key) {
  if (pendingClearMarkers.has(key)) return true;
  try { return sessionStorage.getItem(getPendingClearMarkerKey(key)) === '1'; } catch (e) { return false; }
}

function writePendingState(key, value) {
  clearPendingStateMarker(key);
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* localStorage full or disabled */ }

  try {
    const historyState = history.state && typeof history.state === 'object' ? history.state : {};
    const pendingStates = historyState[PENDING_HISTORY_STATE_KEY] && typeof historyState[PENDING_HISTORY_STATE_KEY] === 'object'
      ? historyState[PENDING_HISTORY_STATE_KEY]
      : {};
    const safePendingStates = getHistoryPendingStates(pendingStates);
    const safeValue = getHistoryPendingState(value);
    if (Object.keys(safeValue).length > 0) safePendingStates[key] = safeValue;
    history.replaceState({
      ...historyState,
      [PENDING_HISTORY_STATE_KEY]: safePendingStates
    }, document.title);
  } catch (e) { /* History API unavailable */ }
}

function readPendingState(key) {
  if (isPendingStateCleared(key)) return null;

  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { /* Try history.state fallback */ }

  try {
    const pendingStates = history.state?.[PENDING_HISTORY_STATE_KEY];
    const pending = pendingStates && typeof pendingStates === 'object' ? pendingStates[key] : null;
    return pending ? getHistoryPendingState(pending) : null;
  } catch (e) {
    return null;
  }
}

function clearPendingState(key) {
  markPendingStateCleared(key);
  try { localStorage.removeItem(key); } catch (e) {}

  try {
    const historyState = history.state && typeof history.state === 'object' ? history.state : {};
    const pendingStates = historyState[PENDING_HISTORY_STATE_KEY];
    if (!pendingStates || typeof pendingStates !== 'object' || !(key in pendingStates)) return;
    const nextPendingStates = { ...pendingStates };
    delete nextPendingStates[key];
    history.replaceState({
      ...historyState,
      [PENDING_HISTORY_STATE_KEY]: nextPendingStates
    }, document.title);
  } catch (e) { /* History API unavailable */ }
}

function getPendingKey() {
  const username = window.location.pathname.split('/')[1];
  return username ? `promptpay_pending_${username}` : 'promptpay_pending';
}

function savePendingQR(data) {
  clearManualPaymentStep();
  clearTrueMoneyPendingQR();
  const pending = {
    referenceId: data.referenceId,
    qrData: data.qrData,
    amount: selectedAmount,
    donorName: donorNameInput?.value?.trim() || '',
    message: donorMessageInput?.value?.trim() || '',
    expiresAt: data.expiresAt,
    recipientName: data.recipientName || '',
    timerAction: getTimerActionForSubmit()
  };
  writePendingState(getPendingKey(), pending);
}

function getPendingQR(includeExpired = false) {
  const pending = readPendingState(getPendingKey());
  if (!pending || !pending.referenceId || !pending.qrData || !pending.expiresAt) return null;
  const expiresAt = new Date(pending.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  if (!includeExpired && Date.now() >= expiresAt) return null;
  return pending;
}

function clearPendingQR() {
  clearPendingState(getPendingKey());
}

function markPendingBackedOut(key) {
  const pending = readPendingState(key);
  if (pending && typeof pending === 'object') writePendingState(key, { ...pending, backedOutAt: Date.now() });
}

function getManualPaymentKey() {
  const username = window.location.pathname.split('/')[1];
  return username ? `manual_payment_pending_${username}` : 'manual_payment_pending';
}

function saveManualPaymentStep(method) {
  if (!['truemoney', 'bank'].includes(method) || !Number.isFinite(selectedAmount) || selectedAmount <= 0) return;
  clearPendingQR();
  clearTrueMoneyPendingQR();
  writePendingState(getManualPaymentKey(), {
    method,
    amount: selectedAmount,
    donorName: donorNameInput?.value?.trim() || '',
    message: donorMessageInput?.value?.trim() || '',
    savedAt: Date.now(),
    timerAction: getTimerActionForSubmit(),
    tierImageUrl: selectedTierImageUrl || null,
    tierSoundUrl: selectedTierSoundUrl || null,
    tierSoundIsTemp: !!selectedTierSoundIsTemp,
    tierSoundMode: selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : null,
    tierYoutubeId: selectedTierYoutube?.videoId || null,
    tierYoutubeStart: selectedTierYoutube?.startSec ?? null,
    tierYoutubeEnd: selectedTierYoutube?.endSec ?? null
  });
}

function getManualPaymentStep() {
  const pending = readPendingState(getManualPaymentKey());
  if (!pending || !['truemoney', 'bank'].includes(pending.method)) return null;
  const amount = Number(pending.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!isManualPaymentStepFresh(pending)) {
    clearManualPaymentStep();
    return null;
  }
  return { ...pending, amount };
}

function clearManualPaymentStep() {
  clearPendingState(getManualPaymentKey());
}

// Social icons map
const SOCIAL_ICONS = {
  twitch: 'fa-twitch',
  youtube: 'fa-youtube',
  tiktok: 'fa-tiktok',
  facebook: 'fa-facebook',
  x: 'fa-x-twitter',
  discord: 'fa-discord',
  instagram: 'fa-instagram',
  kick: 'fa-kick'   // ไม่มี glyph Kick ใน Font Awesome — ตัว K มาจาก .social-btn.kick i::before ใน style.css
};

// Elements
const stepAmount = document.getElementById('step-amount');
const stepPaymentMethod = document.getElementById('step-payment-method');
const stepQR = document.getElementById('step-qr');
const amountBtns = document.querySelectorAll('.amount-btn');
const customAmountInput = document.getElementById('customAmount');
const donorNameInput = document.getElementById('donorName');
const donorMessageInput = document.getElementById('donorMessage');
const btnDonate = document.getElementById('btnDonate');
const btnBack = document.getElementById('btnBack');
const btnBackToAmount = document.getElementById('btnBackToAmount');
const btnProceedPayment = document.getElementById('btnProceedPayment');
const btnRetryQR = document.getElementById('btnRetryQR');
const qrLoading = document.getElementById('qrLoading');
const qrImage = document.getElementById('qrImage');
const qrContainer = document.getElementById('qrContainer');
const displayAmount = document.getElementById('displayAmount');
const paymentStatus = document.getElementById('paymentStatus');
const minAmountWarning = document.getElementById('minAmountWarning');
const minAmountWarningValue = document.getElementById('minAmountWarningValue');
const paymentError = document.getElementById('paymentError');
const paymentErrorMessage = document.getElementById('paymentErrorMessage');
const proceedError = document.getElementById('proceedError');
const proceedErrorMessage = document.getElementById('proceedErrorMessage');
const qrExpiry = document.getElementById('qrExpiry');
const qrRecipientName = document.getElementById('qrRecipientName');
const qrReference = document.getElementById('qrReference');

// Current user's minimum amount (loaded from API)
let userMinAmount = 1;
let streamerPaymentMethods = {};
let paymentMethodsLoadPromise = null;

// Dynamic Page Elements
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const pageSubtitle2 = document.getElementById('pageSubtitle2');
const profileImage = document.getElementById('profileImage');
const socialLinksContainer = document.getElementById('socialLinks');

function renderTtsDonorNotice(visible) {
  const notice = document.getElementById('ttsDonorNotice');
  if (!notice) return;
  const isVisible = visible === true;
  notice.classList.toggle('is-visible', isVisible);
  notice.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
  const link = notice.querySelector('a');
  if (link) link.tabIndex = isVisible ? 0 : -1;
}

function isWebm(url) { return url && /\.webm(\?|$)/i.test(url); }

// ⚠️ CANONICAL COLOR TABLE — duplicate byte-per-byte ใน dashboard/dashboard.js
function getBadgeDefinitions() {
  return {
    dev:          { icon: 'fa-solid fa-code',   color: '#8b5cf6', label: 'TipKub Dev — ผู้พัฒนา TipKub',                    tier: 99 },
    beta_tester:  { icon: 'fa-solid fa-flask',  color: '#22c55e', label: 'TestKub — ผู้ทดสอบระบบยุคแรกเริ่ม',      tier: 98 },
    member_1m:    { icon: 'fa-solid fa-medal',  color: '#cd7f32', label: 'สมาชิก 1 เดือน',                                  tier: 1 },
    member_3m:    { icon: 'fa-solid fa-medal',  color: '#c0c0c0', label: 'สมาชิก 3 เดือน',                                  tier: 2 },
    member_6m:    { icon: 'fa-solid fa-medal',  color: '#ffd700', label: 'สมาชิก 6 เดือน',                                  tier: 3 },
    member_1y:    { icon: 'fa-solid fa-trophy', color: '#ffd700', label: 'สมาชิก 1 ปี — ขอบคุณที่อยู่ด้วยกัน',               tier: 4 },
    member_2y:    { icon: 'fa-solid fa-crown',  color: '#f59e0b', label: 'สมาชิก 2 ปี — ตำนานผู้ภักดี',                      tier: 5 }
  };
}

function attachBadgeTooltip(el, label) {
  el.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); showBadgeTooltip(el, label); });
  el.addEventListener('mouseenter', function() { showBadgeTooltip(el, label); });
  el.addEventListener('mouseleave', function() { hideBadgeTooltip(); });
}

function renderAvatarBadges(displayKeys, applyTierGlow) {
  const orbit = document.getElementById('avatarOrbit');
  const crown = document.getElementById('avatarTierCrown');
  if (!orbit || !crown) return;
  orbit.innerHTML = '';
  crown.innerHTML = '';
  crown.style.display = 'none';
  if (!Array.isArray(displayKeys) || displayKeys.length === 0) return;

  const defs = getBadgeDefinitions();
  const active = displayKeys
    .filter(k => defs[k])
    .sort((a, b) => defs[b].tier - defs[a].tier)
    .slice(0, 5); // cap 5
  if (active.length === 0) return;

  // tier สูงสุด → crown + (optional) glow override
  const topDef = defs[active[0]];
  crown.innerHTML = `<i class="${topDef.icon}"></i>`;
  crown.style.setProperty('--tier-color', topDef.color);
  crown.style.display = '';
  attachBadgeTooltip(crown, topDef.label);
  if (applyTierGlow) {
    document.documentElement.style.setProperty('--avatar-glow-color', topDef.color);
  }

  // ที่เหลือ (สูงสุด 4) → necklace โค้งล่าง สลับข้างจากจี้ (tier สูงใกล้จี้)
  const NECKLACE_OFFSETS = [-28, 28, -56, 56];
  const rest = active.slice(1);
  rest.forEach(function(key, i) {
    const def = defs[key];
    const angle = 180 + NECKLACE_OFFSETS[i];
    const b = document.createElement('span');
    b.className = 'orbit-badge';
    b.innerHTML = `<i class="${def.icon}"></i>`;
    b.style.color = def.color;
    b.style.setProperty('--a', angle + 'deg');
    attachBadgeTooltip(b, def.label);
    orbit.appendChild(b);
  });
}

function showBadgeTooltip(anchor, text) {
  hideBadgeTooltip();
  const tip = document.createElement('div');
  tip.className = 'badge-tooltip';
  tip.textContent = text;
  tip.id = 'badgeTooltip';
  document.body.appendChild(tip);

  const rect = anchor.getBoundingClientRect();
  tip.style.left = rect.left + rect.width / 2 + 'px';
  tip.style.top = rect.top - 8 + 'px';
  tip.style.transform = 'translate(-50%, -100%)';

  anchor.classList.add('badge-active');
  requestAnimationFrame(() => tip.classList.add('visible'));
}

function hideBadgeTooltip() {
  const existing = document.getElementById('badgeTooltip');
  if (existing) existing.remove();
  document.querySelectorAll('.badge-active').forEach(el => el.classList.remove('badge-active'));
}

async function loadPageContent() {
  const username = window.location.pathname.split('/')[1];
  if (!username) { TipKubLoading.hide(); return; }

  try {
    const response = await fetch(`/api/page/${username}/settings`);
    if (response.ok) {
      const data = await response.json();
      pageSettings = data || null;
      renderTtsDonorNotice(data.ttsNotice === true);
      
       // Update texts
      pageTitle.textContent = data.pageTitle;
      document.title = data.pageTitle;
      pageSubtitle.textContent = data.pageSubtitle;
      // Since the template has 2 subtitle lines, we'll split the subtitle by newline if available, or just use the first one
      const subtitles = data.pageSubtitle.split('\n');
      pageSubtitle.textContent = subtitles[0];
      pageSubtitle2.textContent = subtitles[1] || '';

       // Update minimum amount
      userMinAmount = data.minAmount != null ? data.minAmount : 1;
      customAmountInput.min = userMinAmount;
      minAmountWarningValue.textContent = userMinAmount.toLocaleString();
      updateAmountOptions(userMinAmount);
      updateDonateButton();
      
       // Update profile image
       if (isWebm(data.profileImage)) {
         let profileVid = document.getElementById('profileVideo');
         if (!profileVid) {
           profileVid = document.createElement('video');
           profileVid.id = 'profileVideo';
           profileVid.autoplay = true; profileVid.loop = true; profileVid.muted = true; profileVid.playsInline = true;
           profileVid.className = profileImage.className;
           profileVid.setAttribute('width', '190'); profileVid.setAttribute('height', '190');
           profileImage.insertAdjacentElement('afterend', profileVid);
         }
         profileImage.style.display = 'none';
         profileVid.src = data.profileImage;
         profileVid.style.display = '';
       } else {
         const profileVid = document.getElementById('profileVideo');
         if (profileVid) profileVid.style.display = 'none';
         profileImage.src = data.profileImage || '/avatar.jpg';
         profileImage.style.display = 'block';
       }
       
       // Set glow color CSS variable
       if (data.profileGlowColor) {
         document.documentElement.style.setProperty('--avatar-glow-color', data.profileGlowColor);
       }
       
       // Update social links
      renderSocialLinks(data.socials);
      timerPublicConfig = data.timer || null;
      timerActive = !!(timerPublicConfig && timerPublicConfig.timerActive);  // B2
      updateTimerChoiceBox();
      startWidgetStatusStream();                                              // Real-time (B5')

       // Update favicon
       const favicon = document.getElementById('favicon');
       if (favicon) {
         favicon.href = data.profileImage || '/avatar.jpg';
       }

       // Render badges (หลัง if/else webm จบ — glow override เฉพาะเมื่อ streamer ไม่ได้ตั้งสีเอง)
       if (Array.isArray(data.badges) && data.badges.length > 0) renderAvatarBadges(data.badges, !data.profileGlowColor);

       // Apply custom background images (validate protocol before use)
       if (data.headerBgUrl) {
         try {
           const u = new URL(data.headerBgUrl);
           if (u.protocol === 'https:' || u.protocol === 'http:') {
             const safeUrl = data.headerBgUrl.replace(/"/g, '%22');
             const y = data.headerBgY != null ? data.headerBgY : 0;
             let styleEl = document.getElementById('header-bg-dynamic');
             if (!styleEl) {
               styleEl = document.createElement('style');
               styleEl.id = 'header-bg-dynamic';
               document.head.appendChild(styleEl);
             }
             if (isWebm(data.headerBgUrl)) {
               styleEl.textContent = `
                 .header { position: relative; margin: -35px -30px 0 -30px; padding: 35px 30px 25px; overflow: hidden; }
                 #step-amount .header .avatar-wrap { margin-top: 80px; }
                 #step-payment-method .header, #step-qr .header, #step-truemoney .header, #step-bank .header { padding-top: 180px; }
                 .header > * { position: relative; z-index: 1; }
                 #header-bg-video { position: absolute; top: 0; left: 0; right: 0; height: 170px; width: 100%; object-fit: cover; object-position: center ${y}%; z-index: 0; pointer-events: none; -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 60%, rgba(0,0,0,0) 100%); mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 60%, rgba(0,0,0,0) 100%); }
               `;
               let headerVid = document.getElementById('header-bg-video');
               if (!headerVid) {
                 headerVid = document.createElement('video');
                 headerVid.id = 'header-bg-video';
                 headerVid.autoplay = true; headerVid.loop = true; headerVid.muted = true; headerVid.playsInline = true;
                 const header = document.querySelector('.header');
                 if (header) header.insertBefore(headerVid, header.firstChild);
               }
               headerVid.src = data.headerBgUrl;
             } else {
               const headerVid = document.getElementById('header-bg-video');
               if (headerVid) headerVid.remove();
               styleEl.textContent = `
                 .header {
                   position: relative;
                   margin: -35px -30px 0 -30px;
                   padding: 35px 30px 25px;
                 }
                 #step-amount .header .avatar-wrap {
                   margin-top: 80px;
                 }
                 #step-payment-method .header,
                 #step-qr .header,
                 #step-truemoney .header,
                 #step-bank .header {
                   padding-top: 180px;
                 }
                 .header::before {
                   content: '';
                   position: absolute;
                   top: 0;
                   left: 0;
                   right: 0;
                   height: 170px;
                   background-image: url("${safeUrl}");
                   background-size: cover;
                   background-position: center ${y}%;
                   -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 60%, rgba(0,0,0,0) 100%);
                   mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 60%, rgba(0,0,0,0) 100%);
                   z-index: 0;
                 }
                 .header > * { position: relative; z-index: 1; }
               `;
             }
           }
         } catch(e) {}
       }
       if (data.pageBgUrl) {
         try {
           const u = new URL(data.pageBgUrl);
           if (u.protocol === 'https:' || u.protocol === 'http:') {
             const safeUrl = data.pageBgUrl.replace(/"/g, '%22');
             if (isWebm(data.pageBgUrl)) {
               document.body.classList.add('has-video-bg');
               const bgDiv = document.getElementById('page-bg-layer');
               if (bgDiv) bgDiv.style.display = 'none';
               let bgVid = document.getElementById('page-bg-video');
               if (!bgVid) {
                 bgVid = document.createElement('video');
                 bgVid.id = 'page-bg-video';
                 bgVid.autoplay = true; bgVid.loop = true; bgVid.muted = true; bgVid.playsInline = true;
                 Object.assign(bgVid.style, {
                   position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                   zIndex: '-1', objectFit: 'cover', opacity: '0.1', pointerEvents: 'none'
                 });
                 document.body.insertBefore(bgVid, document.body.firstChild);
               }
               bgVid.src = data.pageBgUrl;
             } else {
               document.body.classList.remove('has-video-bg');
               const bgVid = document.getElementById('page-bg-video');
               if (bgVid) bgVid.remove();
               let bgDiv = document.getElementById('page-bg-layer');
               if (!bgDiv) {
                 bgDiv = document.createElement('div');
                 bgDiv.id = 'page-bg-layer';
                 document.body.insertBefore(bgDiv, document.body.firstChild);
               }
               Object.assign(bgDiv.style, {
                 position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
                 zIndex: '-1', backgroundSize: 'cover',
                 backgroundPosition: 'center', backgroundRepeat: 'no-repeat', opacity: '0.1', pointerEvents: 'none',
                 display: ''
               });
               const preload = new Image();
               preload.src = safeUrl;
               (preload.decode ? preload.decode() : Promise.resolve()).catch(() => {}).finally(() => {
                 bgDiv.style.backgroundImage = `url("${safeUrl}")`;
               });
             }
           }
          } catch(e) {}
        }

        // Load donation goal bar
        loadGoal(username);
        loadTierSettings(username);
        TipKubLoading.hide();
    }
  } catch (error) {
    TipKubLoading.hide();
    console.error('Error loading page content:', error);
  }
}

async function loadGoal(username) {
  try {
    const data = await fetch(`/api/page/${username}/goal`).then(r => r.json());
    if (!data.enabled || !data.showOnDonate) return;
    const pct = Math.min(100, data.amount > 0 ? (data.current / data.amount) * 100 : 0);
    document.getElementById('donateGoalLabel').textContent = data.label;
    document.getElementById('donateGoalFill').style.width = pct + '%';
    const donateBarColor = data.barColor || '#7c3aed';
    const opaqueDonateBarColor = /^#[0-9a-fA-F]{8}$/.test(donateBarColor)
      ? donateBarColor.slice(0, 7)
      : donateBarColor;
    document.getElementById('donateGoalFill').style.background = opaqueDonateBarColor;
    document.getElementById('donateGoalAmounts').textContent =
      `${data.current.toLocaleString('th-TH')} / ${data.amount.toLocaleString('th-TH')} บาท`;
    document.getElementById('goalBarSection').style.display = '';
  } catch (e) {
    // Silent fail — goal bar is decorative
  }
}

// ========== Tier Donate (TIER_DONATE_BLUEPRINT.md § 4) ==========
async function loadTierSettings(username) {
  try {
    const res = await fetch(`/api/page/${username}/tier-settings`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.enabled) return;
    tierSettings = data;
    renderTierUnlockHint();
    recomputeTierUnlock();
  } catch (e) {
    // Silent fail — tier donate is an enhancement, ไม่บล็อกการโดเนทหลัก (§4.6 Mobile Donor Resilience)
  }
}

// เขียนข้อความกำกับใต้ customAmount บอกเงินเริ่มต้นปลดล็อกแต่ละ Tier
function renderTierUnlockHint() {
  const hint = document.getElementById('tierUnlockHint');
  if (!hint) return;
  if (!tierSettings || !Array.isArray(tierSettings.tiers) || tierSettings.tiers.length === 0) {
    hint.style.display = 'none';
    return;
  }
  const tiers = tierSettings.tiers
    .filter(t => t.active !== false)
    .sort((a, b) => a.level - b.level);
  if (tiers.length === 0) { hint.style.display = 'none'; return; }
  const parts = tiers.map(t => {
    const name = (t.name || '').trim() || ('Tier ' + t.level);
    return `<span class="tier-hint-item">${escapeHtml(name)} @ ฿${t.min_amount.toLocaleString()}</span>`;
  });
  hint.innerHTML = 'ปลดล็อก: ' + parts.join('<span class="tier-hint-sep">·</span>');
  hint.style.display = '';
}

function recomputeTierUnlock() {
  if (!tierSettings || !Array.isArray(tierSettings.tiers)) return;
  const amt = selectedAmount;
  const unlocked = tierSettings.tiers
    .filter(t => t.active !== false && amt >= t.min_amount)
    .sort((a, b) => b.level - a.level)[0] || null;
  if ((unlocked?.level || null) !== (currentUnlockedTier?.level || null)) {
    currentUnlockedTier = unlocked;
    renderTierSection(unlocked);
    applyRestoredTierSnapshot();
  }
}

function applyRestoredTierSnapshot() {
  if (!restoredTierSnapshot) return;
  selectedTierImageUrl = restoredTierSnapshot.tierImageUrl || null;
  selectedTierSoundUrl = restoredTierSnapshot.tierSoundUrl || null;
  selectedTierSoundIsTemp = !!restoredTierSnapshot.tierSoundIsTemp;
  currentSoundSource = selectedTierSoundIsTemp ? (restoredTierSnapshot.tierSoundMode || 'upload') : null;
  selectedTierYoutube = restoredTierSnapshot.tierYoutubeId
    ? {
        videoId: restoredTierSnapshot.tierYoutubeId,
        startSec: Number(restoredTierSnapshot.tierYoutubeStart) || 0,
        endSec: Number(restoredTierSnapshot.tierYoutubeEnd) || 0
      }
    : null;
}

function resetTierSelections() {
  selectedTierImageUrl = null;
  selectedTierSoundUrl = null;
  selectedTierSoundIsTemp = false;
  selectedTierSoundLabel = '';
  currentSoundSource = null;
  updateSoundSourceUI(null);
  stopTierRecording(true);
  const fileInput = document.getElementById('tierOwnAudioFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('tierOwnAudioStatus');
  if (status) status.textContent = '';
  closeTierSoundPicker();
  const soundLabel = document.getElementById('tierSoundSelectedLabel');
  if (soundLabel) soundLabel.textContent = 'เสียงเริ่มต้น';
  const changeBtn = document.getElementById('btnChangeTierSound');
  if (changeBtn) changeBtn.style.display = 'none';
  hideTierRecordReview();
  hideTierUploadReview();

  // YouTube Tier Sound reset (§8.10)
  clearInterval(ytPlayTestTimer);
  selectedTierYoutube = null;
  if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  const ytPlayerDiv = document.getElementById('ytPlayer');
  if (ytPlayerDiv) ytPlayerDiv.innerHTML = '';
  ytPlayerReady = false;
  closeYoutubeModal();
  const ytBtnLabel = document.getElementById('btnPickTierYoutube');
  if (ytBtnLabel) ytBtnLabel.innerHTML = '<i class="fa-brands fa-youtube"></i> YouTube';
}

function buildDefaultTierImagePreview() {
  const mode = pageSettings?.customImageMode || 'emoji';
  const value = pageSettings?.customImageValue || '';
  if (!value) return '';
  if (mode === 'upload') {
    return isWebm(value)
      ? `<video src="${escapeAttr(value)}" width="56" height="56" muted loop autoplay playsinline></video>`
      : `<img src="${escapeAttr(value)}" width="56" height="56" alt="">`;
  }
  return escapeHtml(value);
}

function renderTierSection(unlocked) {
  const section = document.getElementById('tierDonateSection');
  const banner = document.getElementById('tierBanner');
  resetTierSelections();

  if (!unlocked) {
    section.classList.remove('tier-open');
    document.getElementById('tierImageChoiceBlock')?.classList.remove('tier-block-open');
    document.getElementById('tierSoundChoiceBlock')?.classList.remove('tier-block-open');
    document.getElementById('tierOwnAudioBlock')?.classList.remove('tier-block-open');
    return;
  }
  section.classList.add('tier-open');
  banner.className = 'tier-banner tier-level-' + unlocked.level;
  const tierName = (unlocked.name || '').trim();
  banner.textContent = `ปลดล็อกระดับ :${tierName ? tierName : 'Tier ' + unlocked.level}!`;

  // Image choices
  const imgBlock = document.getElementById('tierImageChoiceBlock');
  const imgChoicesEl = document.getElementById('tierImageChoices');
  if (unlocked.allow_image_choice && Array.isArray(tierSettings.alert_images) && tierSettings.alert_images.length > 0) {
    imgChoicesEl.innerHTML = '';
    const defaultChoice = document.createElement('div');
    defaultChoice.className = 'tier-image-choice tier-default-choice selected';
    // §10.6 — default choice shows streamer custom image preview
    const defaultImageHtml = buildDefaultTierImagePreview();
    defaultChoice.innerHTML = defaultImageHtml || 'ค่าเริ่มต้น';
    defaultChoice.onclick = () => selectTierImage(null, defaultChoice);
    imgChoicesEl.appendChild(defaultChoice);
    tierSettings.alert_images.forEach(img => {
      const el = document.createElement('div');
      el.className = 'tier-image-choice';
      if (img.type === 'video') {
        el.innerHTML = `<video src="${escapeAttr(img.url)}" width="56" height="56" muted loop autoplay playsinline></video>`;
      } else {
        el.innerHTML = `<img src="${escapeAttr(img.url)}" width="56" height="56" alt="">`;
      }
      el.onclick = () => selectTierImage(img.url, el);
      imgChoicesEl.appendChild(el);
    });
    imgBlock.classList.add('tier-block-open');
  } else {
    imgBlock.classList.remove('tier-block-open');
  }

  // Sound library choices
  const sndBlock = document.getElementById('tierSoundChoiceBlock');
  if (unlocked.allow_sound_choice) {
    sndBlock.classList.add('tier-block-open');
  } else {
    sndBlock.classList.remove('tier-block-open');
  }

  // Own audio (upload / record)
  const ownBlock = document.getElementById('tierOwnAudioBlock');
  const uploadSubtab = document.getElementById('tierUploadSubtabBtn');
  const recordSubtab = document.getElementById('tierRecordSubtabBtn');
  const ownSubtabs = document.getElementById('tierOwnAudioSubtabs');
  const uploadPane = document.getElementById('tierUploadPane');
  const recordPane = document.getElementById('tierRecordPane');
  const hasUpload = unlocked.allow_own_upload === true;
  const hasRecord = unlocked.allow_own_record === true && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  const hasYoutube = unlocked.allow_youtube_clip === true;
  const ownLabelText = document.getElementById('tierOwnAudioLabelText');
  if (ownLabelText) ownLabelText.textContent = hasRecord ? 'อัพโหลด/อัดเสียงของคุณเอง' : 'อัพโหลดเสียง';
  if (hasUpload || hasRecord || hasYoutube) {
    ownBlock.classList.add('tier-block-open');
    if (uploadSubtab) uploadSubtab.style.display = (hasUpload || hasYoutube) ? '' : 'none';
    if (recordSubtab) recordSubtab.style.display = hasRecord ? '' : 'none';
    if (ownSubtabs) ownSubtabs.style.display = ((hasUpload || hasYoutube) && hasRecord) ? '' : 'none';
    if ((hasUpload || hasYoutube) && !hasRecord) {
      uploadPane.style.display = '';
      recordPane.style.display = 'none';
    } else if (!(hasUpload || hasYoutube) && hasRecord) {
      uploadPane.style.display = 'none';
      recordPane.style.display = '';
    }
  } else {
    ownBlock.classList.remove('tier-block-open');
  }
  const uploadLabelBtn = document.getElementById('tierUploadLabelBtn');
  if (uploadLabelBtn) uploadLabelBtn.style.display = hasUpload ? '' : 'none';
  const catalogBtn = document.getElementById('btnPickTierCatalog');
  if (catalogBtn) catalogBtn.style.display = hasUpload ? '' : 'none'; // กัน bypass gap — ดู §11
  const ytBtn = document.getElementById('btnPickTierYoutube');
  if (ytBtn) ytBtn.style.display = hasYoutube ? '' : 'none';
}

function selectTierImage(url, el) {
  selectedTierImageUrl = url;
  document.querySelectorAll('.tier-image-choice').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s || '';
  return div.innerHTML;
}

function getTierOwnAudioStatusLabel(activeSource) {
  if (activeSource === 'upload') return `🔊 ${selectedTierSoundLabel || 'ไฟล์เสียงที่อัปโหลด'}`;
  if (activeSource === 'catalog') return `🎵 ${selectedTierSoundLabel || 'เสียงจาก URL'}`;
  if (activeSource === 'youtube') return `▶️ YouTube${selectedTierYoutube?.videoId ? ` (${selectedTierYoutube.videoId})` : ''}`;
  if (activeSource === 'record') return '🎙️ เสียงที่อัดจากไมค์';
  return '';
}

function renderTierOwnAudioStatus(activeSource = currentSoundSource) {
  const row = document.getElementById('tierOwnAudioStatusRow');
  const status = document.getElementById('tierOwnAudioStatus');
  const ownAudioChangeBtn = document.getElementById('btnChangeTierOwnAudioSound');
  const youtubeChangeBtn = document.getElementById('btnChangeTierYoutubeSound');
  const recordChangeBtn = document.getElementById('btnChangeTierRecordSound');
  const ownAudioSource = ['upload', 'catalog', 'youtube', 'record'].includes(activeSource);
  const hasRecordSelection = activeSource === 'record' && !!selectedTierSoundUrl;

  if (row) row.style.display = ownAudioSource ? 'flex' : 'none';
  if (status) {
    status.classList.remove('tier-status-busy');
    status.textContent = ownAudioSource ? getTierOwnAudioStatusLabel(activeSource) : '';
  }
  if (ownAudioChangeBtn) ownAudioChangeBtn.style.display = ['upload', 'catalog'].includes(activeSource) ? '' : 'none';
  if (youtubeChangeBtn) youtubeChangeBtn.style.display = activeSource === 'youtube' ? '' : 'none';
  if (recordChangeBtn) recordChangeBtn.style.display = hasRecordSelection && !tierRecordUploadInFlight ? '' : 'none';
}

// §10.10 — mutual-exclusion UI for the 3 sound sources
function updateSoundSourceUI(activeSource) {
  currentSoundSource = activeSource || null;
  const libraryBlock = document.getElementById('tierSoundChoiceBlock');
  const uploadPane = document.getElementById('tierUploadPane');
  const recordPane = document.getElementById('tierRecordPane');
  const changeBtn = document.getElementById('btnChangeTierSound');

  [libraryBlock, uploadPane, recordPane,
    document.getElementById('tierUploadLabelBtn'),
    document.getElementById('btnPickTierCatalog')
  ].forEach(el => el?.classList.remove('sound-source-dimmed'));
  if (activeSource === 'library') {
    uploadPane?.classList.add('sound-source-dimmed');
    recordPane?.classList.add('sound-source-dimmed');
  } else if (activeSource === 'upload' || activeSource === 'catalog') {
    libraryBlock?.classList.add('sound-source-dimmed');
    recordPane?.classList.add('sound-source-dimmed');
  } else if (activeSource === 'record') {
    libraryBlock?.classList.add('sound-source-dimmed');
    uploadPane?.classList.add('sound-source-dimmed');
  } else if (activeSource === 'youtube') {
    libraryBlock?.classList.add('sound-source-dimmed');
    recordPane?.classList.add('sound-source-dimmed');
    document.getElementById('tierUploadLabelBtn')?.classList.add('sound-source-dimmed');
    document.getElementById('btnPickTierCatalog')?.classList.add('sound-source-dimmed');
  }

  if (changeBtn) changeBtn.style.display = activeSource === 'library' ? '' : 'none';
  renderTierOwnAudioStatus(currentSoundSource);
}

// Plan B: auto-clear previous sound source when switching to a new one
// Amber "system busy" line for the tier sound area (inline, never a modal — the donor
// hasn't paid yet and is mid-form; a modal would look like their choice was lost).
function setTierStatusBusy(el, message) {
  if (!el) return;
  el.classList.add('tier-status-busy');
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-hourglass-half';
  el.replaceChildren(icon, ' ' + message);
}

function clearTierSoundSource() {
  // Clear upload state
  hideTierUploadReview();
  const fileInput = document.getElementById('tierOwnAudioFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('tierOwnAudioStatus');
  if (status) status.textContent = '';

  // Clear YouTube state
  clearInterval(ytPlayTestTimer);
  if (selectedTierYoutube) {
    selectedTierYoutube = null;
    if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
    const ytPlayerDiv = document.getElementById('ytPlayer');
    if (ytPlayerDiv) ytPlayerDiv.innerHTML = '';
    ytPlayerReady = false;
    const ytBtnLabel = document.getElementById('btnPickTierYoutube');
    if (ytBtnLabel) ytBtnLabel.innerHTML = '<i class="fa-brands fa-youtube"></i> YouTube';
  }
  resetYoutubeModalToStep1();
  closeYoutubeModal();

  // Clear catalog/library state
  closeTierSoundPicker();
  stopTierSoundPreview();

  // Clear record state
  stopTierRecording(true);
  hideTierRecordReview();

  // Reset shared state
  selectedTierSoundUrl = null;
  selectedTierSoundIsTemp = false;
  selectedTierSoundLabel = '';
}

function resetTierOwnAudioSelection() {
  if (tierRecordUploadInFlight) return;
  clearTierSoundSource();
  selectedTierYoutube = null;
  const ytBtnLabel = document.getElementById('btnPickTierYoutube');
  if (ytBtnLabel) ytBtnLabel.innerHTML = '<i class="fa-brands fa-youtube"></i> YouTube';
  const labelEl = document.getElementById('tierSoundSelectedLabel');
  if (labelEl) labelEl.textContent = 'เสียงเริ่มต้น';
  const recordStatus = document.getElementById('tierRecordStatus');
  if (recordStatus) recordStatus.textContent = '';
  const confirmHint = document.getElementById('tierRecordConfirmHint');
  if (confirmHint) confirmHint.style.display = 'none';
  updateSoundSourceUI(null);
}

// §10.7 / §10.15 — tier sound picker modal
let currentPreviewAudio = null;
let currentPreviewUrl = null;
let currentDefaultPreviewPlaying = false;
let defaultPreviewAudioCtx = null;

function openTierSoundPicker(mode) {
  const modal = document.getElementById('tierSoundPickerModal');
  if (!modal) return;
  const title = document.getElementById('tierSoundPickerTitle');
  document.getElementById('tierSoundPickerLibrary')?.classList.toggle('active', mode !== 'catalog');
  document.getElementById('tierSoundPickerCatalog')?.classList.toggle('active', mode === 'catalog');
  if (mode === 'catalog') {
    if (title) title.innerHTML = '<i class="fa-solid fa-globe" style="color:#3b82f6;margin-right:8px;"></i>ค้นหาเสียงสำเร็จรูป';
    searchTierSoundCatalog('');
  } else {
    if (title) title.innerHTML = '<i class="fa-solid fa-music" style="color:#60a5fa;margin-right:8px;"></i>เลือกเสียงแจ้งเตือน';
    renderTierSoundLibraryList();
  }
  modal.classList.add('active');
  modal.style.display = 'flex';
}

function closeTierSoundPicker() {
  const modal = document.getElementById('tierSoundPickerModal');
  if (!modal) return;
  stopTierSoundPreview();
  modal.classList.remove('active');
  setTimeout(() => { if (!modal.classList.contains('active')) modal.style.display = 'none'; }, 200);
}

// ========== YouTube Tier Sound (YOUTUBE_TIER_SOUND_BLUEPRINT.md §8) ==========

function ensureYoutubeApi(cb, onFail) {
  if (window.YT && window.YT.Player) return cb();
  if (ytApiLoading) {
    const check = setInterval(() => { if (window.YT && window.YT.Player) { clearInterval(check); cb(); } }, 100);
    return;
  }
  ytApiLoading = true;
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    ytApiLoading = false;
    if (onFail) onFail();
  }, 10000); // §10 mobile resilience — webview may block YouTube embed
  window.onYouTubeIframeAPIReady = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    ytApiLoading = false;
    cb();
  };
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function parseYoutubeUrl(url) {
  try {
    const u = new URL(url);
    let videoId = null;
    const host = u.hostname.replace('www.', '');
    if (host === 'youtube.com' && u.pathname === '/watch') videoId = u.searchParams.get('v');
    else if (u.hostname === 'youtu.be') videoId = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' && u.pathname.startsWith('/embed/')) videoId = u.pathname.split('/')[2];
    else if (host === 'youtube.com' && u.pathname.startsWith('/shorts/')) videoId = u.pathname.split('/')[2];
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
    const tRaw = u.searchParams.get('t') || u.searchParams.get('start');
    return { videoId, tSec: parseYoutubeTimestamp(tRaw) };
  } catch { return null; }
}

function parseYoutubeTimestamp(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
}

function ytShowStatus(msg, isError) {
  const el = document.getElementById('ytModalStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'yt-status-text' + (isError ? ' yt-status-error' : '');
  el.style.display = msg ? '' : 'none';
}

function showYtStep1() {
  const s1 = document.getElementById('ytStep1');
  const s2 = document.getElementById('ytStep2');
  if (s1) s1.style.display = '';
  if (s2) s2.style.display = 'none';
}

function showYtStep2() {
  const s1 = document.getElementById('ytStep1');
  const s2 = document.getElementById('ytStep2');
  if (s1) s1.style.display = 'none';
  if (s2) s2.style.display = '';
  ytShowStatus('');
}

function resetYoutubeModalToStep1() {
  clearInterval(ytPlayTestTimer);
  if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  const ytPlayerDiv = document.getElementById('ytPlayer');
  if (ytPlayerDiv) ytPlayerDiv.innerHTML = '';
  ytPlayerReady = false;
  ytDuration = 0;
  const btn = document.getElementById('ytUrlLoadBtn');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-download"></i> โหลดคลิป';
  }
  showYtStep1();
}

function openYoutubeModal() {
  const modal = document.getElementById('tierSoundYoutubeModal');
  if (!modal) return;
  modal.classList.add('active');
  modal.style.display = 'flex';
  if (selectedTierYoutube || ytPlayer) {
    showYtStep2();
  } else {
    ytShowStatus('');
    showYtStep1();
  }
}

function closeYoutubeModal() {
  const modal = document.getElementById('tierSoundYoutubeModal');
  if (!modal) return;
  modal.classList.remove('active');
  setTimeout(() => { if (!modal.classList.contains('active')) modal.style.display = 'none'; }, 200);
}

function formatYtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

// ชม.:นาที:วินาที เฉพาะคลิปยาว ≥1 ชม. — สั้นกว่านั้นโชว์แค่ นาที:วินาที
function formatYtTimeHMS(sec, duration) {
  if (duration >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = (sec % 60).toFixed(1);
    return `${h}:${String(m).padStart(2, '0')}:${s.padStart(4, '0')}`;
  }
  return formatYtTime(sec);
}

function parseYtTimeInput(str) {
  if (!str) return NaN;
  const parts = str.trim().split(':').map(p => parseFloat(p));
  if (parts.some(p => !Number.isFinite(p))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return NaN;
}

function updateYtRangeUI() {
  const startHandle = document.getElementById('ytStartHandle');
  const lengthHandle = document.getElementById('ytEndHandle');
  const fill = document.getElementById('ytRangeFill');
  const startLabel = document.getElementById('ytStartLabel');
  const endLabel = document.getElementById('ytEndLabel');
  const startInput = document.getElementById('ytStartInput');
  const endInput = document.getElementById('ytEndInput');
  const lengthLabel = document.getElementById('ytLengthLabel');
  if (!startHandle || !lengthHandle || !ytDuration) return;
  startHandle.value = ytStartSec;
  lengthHandle.max = Math.min(10, ytDuration - ytStartSec);
  lengthHandle.value = ytEndSec - ytStartSec;
  const pctStart = (ytStartSec / ytDuration) * 100;
  const pctEnd = (ytEndSec / ytDuration) * 100;
  if (fill) { fill.style.left = pctStart + '%'; fill.style.width = Math.max(0, pctEnd - pctStart) + '%'; }
  if (startLabel) startLabel.textContent = formatYtTime(ytStartSec);
  if (endLabel) endLabel.textContent = formatYtTime(ytEndSec);
  if (startInput) startInput.value = formatYtTimeHMS(ytStartSec, ytDuration);
  if (endInput) endInput.value = formatYtTimeHMS(ytEndSec, ytDuration);
  if (lengthLabel) lengthLabel.textContent = (ytEndSec - ytStartSec).toFixed(1) + ' วิ';
}

function initDualHandle(duration) {
  const startHandle = document.getElementById('ytStartHandle');
  const lengthHandle = document.getElementById('ytEndHandle');
  if (!startHandle || !lengthHandle) return;
  startHandle.min = 0;
  startHandle.max = duration;
  startHandle.step = 0.1;
  lengthHandle.min = 0.1;
  lengthHandle.step = 0.1;
  updateYtRangeUI();
}

function onYtStartInput(v) {
  if (!Number.isFinite(v)) return;
  const length = ytEndSec - ytStartSec;
  ytStartSec = Math.max(0, Math.min(v, ytDuration - 0.1));
  ytEndSec = Math.min(ytStartSec + (length > 0.05 ? length : 10), ytDuration);
  updateYtRangeUI();
}

function onYtEndInput(v) {
  if (!Number.isFinite(v)) return;
  ytEndSec = Math.min(ytDuration, Math.max(v, 0.1));
  // ponytail: 0.05 epsilon ทน float drift (เช่นเดียวกับ validation ใน ytUseClipBtn)
  if (ytEndSec - ytStartSec > 10.05 || ytStartSec >= ytEndSec) ytStartSec = Math.max(ytEndSec - 10, 0);
  updateYtRangeUI();
}

// ปรับความยาวคลิปแบบซูม (scale 0.1-10 วิคงที่ ไม่ขึ้นกับความยาวคลิปเต็ม) — แก้ปัญหาเลื่อนละเอียดยากเมื่อคลิปยาว
function onYtLengthInput(len) {
  if (!Number.isFinite(len)) return;
  const maxLen = Math.min(10, ytDuration - ytStartSec);
  ytEndSec = ytStartSec + Math.max(0.1, Math.min(len, maxLen));
  updateYtRangeUI();
}

document.getElementById('ytStartHandle')?.addEventListener('input', (e) => onYtStartInput(parseFloat(e.target.value)));
document.getElementById('ytEndHandle')?.addEventListener('input', (e) => onYtLengthInput(parseFloat(e.target.value)));
document.getElementById('ytStartInput')?.addEventListener('change', (e) => onYtStartInput(parseYtTimeInput(e.target.value)));
document.getElementById('ytEndInput')?.addEventListener('change', (e) => onYtEndInput(parseYtTimeInput(e.target.value)));

function onYtPlayerReady(e) {
  ytPlayerReady = true;
  ytDuration = e.target.getDuration();
  if (!ytDuration || ytDuration === Infinity || ytDuration > 86400) {
    ytShowStatus('คลิป Live ไม่รองรับ — กรุณาเลือกคลิปปกติ', true);
    resetYoutubeModalToStep1();
    return;
  }
  ytStartSec = Math.max(0, Math.min(pendingYtStartSec ?? 0, ytDuration - 0.1));
  ytEndSec = Math.min(ytStartSec + 10, ytDuration);
  initDualHandle(ytDuration);
  showYtStep2();
}

function onYtPlayerError(e) {
  console.warn('[YT donate] error', e.data);
  ytShowStatus('เจ้าของคลิปปิดการฝัง กรุณาเลือกคลิปอื่น', true);
  resetYoutubeModalToStep1();
}

document.getElementById('ytUrlLoadBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('ytUrlLoadBtn');
  const url = document.getElementById('ytUrlInput')?.value?.trim();
  const parsed = parseYoutubeUrl(url);
  if (!parsed) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-download"></i> โหลดคลิป';
    }
    ytShowStatus('ลิงก์ YouTube ไม่ถูกต้อง', true);
    return;
  }
  ytShowStatus('');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...'; }
  currentYtVideoId = parsed.videoId;
  pendingYtStartSec = parsed.tSec;
  ensureYoutubeApi(() => {
    if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
    const ytPlayerDiv = document.getElementById('ytPlayer');
    if (ytPlayerDiv) ytPlayerDiv.innerHTML = '';
    ytPlayer = new YT.Player('ytPlayer', {
      videoId: currentYtVideoId,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: { onReady: onYtPlayerReady, onError: onYtPlayerError }
    });
  }, () => {
    ytShowStatus('กรุณาเปิดผ่านเบราว์เซอร์ (Chrome/Safari) เพื่อใช้ฟีเจอร์นี้', true);
    resetYoutubeModalToStep1();
  });
});

document.getElementById('ytPlayTestBtn')?.addEventListener('click', () => {
  if (!ytPlayer || !ytPlayerReady) return;
  const btn = document.getElementById('ytPlayTestBtn');
  if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
    ytPlayer.pauseVideo();
    clearInterval(ytPlayTestTimer);
    if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i> ทดลองฟัง';
    return;
  }
  ytPlayer.seekTo(ytStartSec, true);
  ytPlayer.playVideo();
  if (btn) btn.innerHTML = '<i class="fa-solid fa-pause"></i> หยุดฟัง';
  clearInterval(ytPlayTestTimer);
  ytPlayTestTimer = setInterval(() => {
    if (ytPlayer.getCurrentTime() >= ytEndSec) {
      ytPlayer.pauseVideo();
      clearInterval(ytPlayTestTimer);
      if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i> ทดลองฟัง';
    }
  }, 100);
});

document.getElementById('ytChangeUrlBtn')?.addEventListener('click', () => {
  clearInterval(ytPlayTestTimer);
  if (ytPlayer) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  const ytPlayerDiv = document.getElementById('ytPlayer');
  if (ytPlayerDiv) ytPlayerDiv.innerHTML = '';
  ytPlayerReady = false;
  ytDuration = 0;
  selectedTierYoutube = null;
  const urlInput = document.getElementById('ytUrlInput');
  if (urlInput) urlInput.value = '';
  const loadBtn = document.getElementById('ytUrlLoadBtn');
  if (loadBtn) { loadBtn.disabled = false; loadBtn.innerHTML = '<i class="fa-solid fa-download"></i> โหลดคลิป'; }
  ytShowStatus('');
  showYtStep1();
});

document.getElementById('ytUseClipBtn')?.addEventListener('click', () => {
  // ponytail: 0.05 epsilon ทน IEEE-754 drift — (6.1+10)-6.1 = 10.000000000000002 ซึ่งความยาวจริงคือ 10
  const len = ytEndSec - ytStartSec;
  if (len < 0.05 || len > 10.05) {
    ytShowStatus('ช่วงเสียงต้องมากกว่า 0 และไม่เกิน 10 วินาที', true);
    return;
  }
  clearTierSoundSource();
  if (ytPlayer) { try { ytPlayer.pauseVideo(); } catch {} }
  selectedTierYoutube = { videoId: currentYtVideoId, startSec: ytStartSec, endSec: ytEndSec };
  closeYoutubeModal();
  updateSoundSourceUI('youtube');
  renderTierOwnAudioStatus('youtube');
  const labelBtn = document.getElementById('btnPickTierYoutube');
  if (labelBtn) labelBtn.innerHTML = '<i class="fa-brands fa-youtube"></i> Youtube <i class="fas fa-check-circle"></i>';
});

document.getElementById('btnPickTierYoutube')?.addEventListener('click', openYoutubeModal);
document.getElementById('btnCloseYoutubeModal')?.addEventListener('click', closeYoutubeModal);

function playTierSoundPreview(url) {
  stopTierSoundPreview();
  const audio = new Audio(url);
  audio.play().catch(() => {});
  currentPreviewAudio = audio;
  currentPreviewUrl = url;
  updateTierSoundPlayIcons();
}

function stopTierSoundPreview() {
  if (currentPreviewAudio) {
    currentPreviewAudio.pause();
    currentPreviewAudio.currentTime = 0;
    currentPreviewAudio = null;
    currentPreviewUrl = null;
  }
  stopDefaultSoundPreview();
  updateTierSoundPlayIcons();
}

function updateTierSoundPlayIcons() {
  document.querySelectorAll('.tier-sound-item').forEach(item => {
    const playBtn = item.querySelector('.sound-play-btn');
    if (!playBtn) return;
    const url = item.dataset.url;
    const isPlaying = (currentPreviewAudio && !currentPreviewAudio.paused && currentPreviewUrl === url)
                   || (url === '__default__' && currentDefaultPreviewPlaying);
    playBtn.innerHTML = `<i class="fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}"></i>`;
  });
}

// "เสียงเริ่มต้น" = alert sound ที่ streamer ตั้งใน overlay (soundChoice + customSoundUrl + soundVolume)
// ทดสอบฟังได้ทั้ง URL-based (custom_url/upload_sound/custom) และ synth preset (chime/retro/modern/bell)
// ponytail: synth ทับซ้อน overlay.js ~130 บรรทัดโดยเจตนา — overlay คือ core feature + เคยมี bug เสียง (2026-07-20), ห้ามแตะ
function getDefaultSoundInfo() {
  const s = pageSettings || {};
  if (!s.soundEnabled) return { type: 'none' };
  const choice = s.soundChoice || 'none';
  if (choice === 'none') return { type: 'none' };
  if (choice === 'custom') return { type: 'url', url: '/assets/audio/my-sound.mp3' };
  if (choice === 'custom_url' || choice === 'upload_sound') {
    if (!s.customSoundUrl) return { type: 'none' };
    return { type: 'url', url: s.customSoundUrl };
  }
  if (choice === 'chime' || choice === 'retro' || choice === 'modern' || choice === 'bell') {
    return { type: 'synth', choice };
  }
  return { type: 'none' };
}

function stopDefaultSoundPreview() {
  currentDefaultPreviewPlaying = false;
  if (currentPreviewAudio) {
    currentPreviewAudio.pause();
    currentPreviewAudio.currentTime = 0;
    currentPreviewAudio = null;
  }
  if (currentPreviewUrl === '__default__') currentPreviewUrl = null;
}

async function playDefaultSoundPreview() {
  const info = getDefaultSoundInfo();
  if (info.type === 'none') return;
  stopTierSoundPreview();
  currentDefaultPreviewPlaying = true;
  currentPreviewUrl = '__default__';
  updateTierSoundPlayIcons();
  const volume = Number(pageSettings.soundVolume) || 0.5;
  if (info.type === 'url') {
    const audio = new Audio(info.url);
    audio.volume = volume;
    currentPreviewAudio = audio;
    audio.onended = () => { stopDefaultSoundPreview(); updateTierSoundPlayIcons(); };
    audio.onerror = () => { stopDefaultSoundPreview(); updateTierSoundPlayIcons(); };
    await audio.play().catch(() => { stopDefaultSoundPreview(); updateTierSoundPlayIcons(); });
    return;
  }
  try {
    await synthAlertSound(info.choice, volume);
  } finally {
    stopDefaultSoundPreview();
    updateTierSoundPlayIcons();
  }
}

// synth preset replica — mirror overlay.js playNotificationSound() synth branches
async function synthAlertSound(choice, volume) {
  if (!defaultPreviewAudioCtx) {
    defaultPreviewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const audioCtx = defaultPreviewAudioCtx;
  const now = audioCtx.currentTime;
  const masterGain = audioCtx.createGain();
  masterGain.gain.setValueAtTime(volume, now);
  masterGain.connect(audioCtx.destination);

  if (choice === 'chime') {
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
      osc.connect(gainNode); gainNode.connect(masterGain);
      osc.start(now + note.start); osc.stop(now + note.start + note.duration + 0.05);
    });
    return new Promise(r => setTimeout(r, 700));
  }
  if (choice === 'retro') {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.exponentialRampToValueAtTime(1046.50, now + 0.25);
    gainNode.gain.setValueAtTime(0.15, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(gainNode); gainNode.connect(masterGain);
    osc.start(now); osc.stop(now + 0.3);
    return new Promise(r => setTimeout(r, 400));
  }
  if (choice === 'modern') {
    const oscTypes = ['sine', 'triangle'];
    const freqs = [329.63, 392.00, 523.25, 659.25];
    freqs.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      osc.type = oscTypes[idx % oscTypes.length];
      osc.frequency.setValueAtTime(freq, now);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.08, now + 0.1);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.6 + (idx * 0.1));
      osc.connect(gainNode); gainNode.connect(masterGain);
      osc.start(now); osc.stop(now + 1.0);
    });
    return new Promise(r => setTimeout(r, 1100));
  }
  if (choice === 'bell') {
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1567.98, now);
    osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.8);
    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    osc.connect(gainNode); gainNode.connect(masterGain);
    osc.start(now); osc.stop(now + 0.9);
    return new Promise(r => setTimeout(r, 1000));
  }
  return Promise.resolve();
}

function renderTierSoundLibraryList() {
  const list = document.getElementById('tierSoundLibraryList');
  if (!list) return;
  list.innerHTML = '';
  const defaultItem = document.createElement('div');
  defaultItem.className = 'tier-sound-item' + (selectedTierSoundUrl ? '' : ' selected');
  defaultItem.dataset.url = '__default__';
  defaultItem.dataset.label = 'เสียงเริ่มต้น';
  const hasDefault = getDefaultSoundInfo().type !== 'none';
  const playBtn = hasDefault
    ? `<span class="sound-actions"><button type="button" class="sound-play-btn" aria-label="ฟังตัวอย่าง"><i class="fa-solid fa-play"></i></button></span>`
    : '';
  defaultItem.innerHTML = `<span class="sound-label"><i class="fa-solid fa-volume-high" style="margin-right:6px;"></i>เสียงเริ่มต้น</span>${playBtn}`;
  defaultItem.onclick = (e) => {
    if (hasDefault && e.target.closest('.sound-play-btn')) {
      if (currentDefaultPreviewPlaying) { stopDefaultSoundPreview(); updateTierSoundPlayIcons(); }
      else playDefaultSoundPreview();
    } else {
      selectTierSound(null, 'เสียงเริ่มต้น', 'library');
    }
  };
  list.appendChild(defaultItem);

  const library = Array.isArray(tierSettings?.sound_library) ? tierSettings.sound_library : [];
  if (library.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tier-sound-empty';
    empty.textContent = 'สตรีมเมอร์ยังไม่ได้เพิ่มเสียงในคลัง';
    list.appendChild(empty);
    return;
  }
  library.forEach(s => {
    const item = document.createElement('div');
    const isSelected = selectedTierSoundUrl === s.url;
    item.className = 'tier-sound-item' + (isSelected ? ' selected' : '');
    item.dataset.url = s.url;
    item.dataset.label = s.label;
    item.innerHTML = `
      <span class="sound-label">${escapeHtml(s.label)}</span>
      <span class="sound-actions">
        <button type="button" class="sound-play-btn" aria-label="ฟังตัวอย่าง"><i class="fa-solid fa-play"></i></button>
      </span>`;
    item.onclick = (e) => {
      if (e.target.closest('.sound-play-btn')) {
        if (currentPreviewUrl === s.url && currentPreviewAudio && !currentPreviewAudio.paused) stopTierSoundPreview();
        else playTierSoundPreview(s.url);
      } else {
        selectTierSound(s.url, s.label, 'library');
      }
    };
    list.appendChild(item);
  });
}

let myinstantsPagesCache = null;

async function loadMyinstantsPages() {
  if (myinstantsPagesCache) return myinstantsPagesCache;
  try {
    const res = await fetch('/api/public/myinstants/pages');
    const data = await res.json();
    myinstantsPagesCache = Array.isArray(data.pages) ? data.pages : [];
    return myinstantsPagesCache;
  } catch (e) {
    return [];
  }
}

async function searchTierSoundCatalog(query) {
  const list = document.getElementById('tierSoundCatalogList');
  if (!list) return;
  list.innerHTML = '<div class="tier-sound-empty">กำลังค้นหา...</div>';
  try {
    const q = (query || '').trim();
    const url = q ? `/api/public/myinstants/search?q=${encodeURIComponent(q)}` : '/api/public/myinstants/search';
    const res = await fetch(url);
    const data = await res.json();
    // The tier-upload busy message points donors at this catalog, so it must not
    // read as "ไม่พบเสียง" while the search itself is being shed.
    if (isOverloadResponse(res, data)) {
      list.innerHTML = '<div class="tier-sound-empty">ระบบกำลังมีผู้ใช้งานหนาแน่น กรุณาลองค้นหาอีกครั้งใน 1 นาที</div>';
      return;
    }
    list.innerHTML = '';
    const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) {
      list.innerHTML = '<div class="tier-sound-empty">ไม่พบเสียง ลองคำค้นอื่น</div>';
      return;
    }
    results.forEach(s => {
      const item = document.createElement('div');
      const isSelected = selectedTierSoundUrl === s.mp3Url;
      item.className = 'tier-sound-item' + (isSelected ? ' selected' : '');
      item.dataset.url = s.mp3Url;
      item.dataset.label = s.name;
      item.innerHTML = `
        <span class="sound-label">${escapeHtml(s.name)}</span>
        <span class="sound-actions">
          <button type="button" class="sound-play-btn" aria-label="ฟังตัวอย่าง"><i class="fa-solid fa-play"></i></button>
        </span>`;
      item.onclick = (e) => {
        if (e.target.closest('.sound-play-btn')) {
          if (currentPreviewUrl === s.mp3Url && currentPreviewAudio && !currentPreviewAudio.paused) stopTierSoundPreview();
          else playTierSoundPreview(s.mp3Url);
        } else {
          selectTierSound(s.mp3Url, s.name, 'catalog');
        }
      };
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = '<div class="tier-sound-empty">ค้นหาไม่ได้ชั่วคราว ลองใหม่ภายหลัง</div>';
  }
}

function selectTierSound(url, label, source) {
  clearTierSoundSource();
  selectedTierSoundUrl = url || null;
  selectedTierSoundIsTemp = false;
  selectedTierSoundLabel = label || 'เสียงเริ่มต้น';
  currentSoundSource = url ? source : null;
  updateSoundSourceUI(currentSoundSource);
  if (source === 'catalog') {
    renderTierOwnAudioStatus(currentSoundSource);
  } else {
    const labelEl = document.getElementById('tierSoundSelectedLabel');
    if (labelEl) labelEl.textContent = selectedTierSoundLabel;
  }
  closeTierSoundPicker();
  stopTierSoundPreview();
}

function resetTierSoundSelection() {
  selectedTierSoundUrl = null;
  selectedTierSoundIsTemp = false;
  selectedTierSoundLabel = '';
  currentSoundSource = null;
  updateSoundSourceUI(null);
  const labelEl = document.getElementById('tierSoundSelectedLabel');
  if (labelEl) labelEl.textContent = 'เสียงเริ่มต้น';
  const status = document.getElementById('tierOwnAudioStatus');
  if (status) {
    status.classList.remove('tier-status-busy');
    status.textContent = '';
  }
  renderTierOwnAudioStatus(null);
}

// Sound picker bindings
document.getElementById('btnPickTierSound')?.addEventListener('click', () => openTierSoundPicker('library'));
document.getElementById('btnPickTierCatalog')?.addEventListener('click', () => openTierSoundPicker('catalog'));
document.getElementById('btnCloseTierSoundPicker')?.addEventListener('click', closeTierSoundPicker);
document.getElementById('btnChangeTierSound')?.addEventListener('click', resetTierSoundSelection);
document.getElementById('btnChangeTierOwnAudioSound')?.addEventListener('click', resetTierOwnAudioSelection);
document.getElementById('btnChangeTierYoutubeSound')?.addEventListener('click', resetTierOwnAudioSelection);
document.getElementById('btnChangeTierRecordSound')?.addEventListener('click', resetTierOwnAudioSelection);
document.getElementById('btnTierSoundCatalogSearch')?.addEventListener('click', () => {
  const q = document.getElementById('tierSoundCatalogSearch')?.value || '';
  searchTierSoundCatalog(q);
});
document.getElementById('tierSoundCatalogSearch')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchTierSoundCatalog(e.target.value);
});

// Own-audio subtab toggle (upload / record)
document.querySelectorAll('.tier-subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tier-subtab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const sub = btn.dataset.subtab;
    document.getElementById('tierUploadPane').style.display = sub === 'upload' ? '' : 'none';
    document.getElementById('tierRecordPane').style.display = sub === 'record' ? '' : 'none';
  });
});

// Own-audio: upload flow
document.getElementById('tierOwnAudioFile')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  clearTierSoundSource();
  const status = document.getElementById('tierOwnAudioStatus');
  const setStatus = (msg) => { if (status) { status.classList.remove('tier-status-busy'); status.textContent = msg; } };
  if (file.size > 1024 * 1024) {
    setStatus('ไฟล์ต้องไม่เกิน 1MB');
    e.target.value = '';
    return;
  }
  setStatus('กำลังอัปโหลด...');
  try {
    const username = window.location.pathname.split('/')[1];
    const formData = new FormData();
    formData.append('audio', file);
    formData.append('username', username);
    formData.append('mode', 'upload');
    const res = await fetch('/api/donate/upload-tier-audio', { method: 'POST', body: formData });
    const data = await res.json();
    // 503 carries `message`, not `error` — without this branch the donor would see "อัปโหลดไม่สำเร็จ: undefined"
    if (isOverloadResponse(res, data)) {
      setTierStatusBusy(status, 'ระบบกำลังมีผู้ใช้งานหนาแน่น กรุณาลองอัปโหลดอีกครั้งใน 1 นาที — หรือเลือกเสียงจากคลังของสตรีมเมอร์ไปก่อนได้');
      e.target.value = ''; // let the donor re-pick the same file
      return;
    }
    if (!res.ok) throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
    selectedTierSoundUrl = data.url;
    selectedTierSoundIsTemp = true;
    selectedTierSoundLabel = file.name || 'ไฟล์ที่อัพโหลด';
    currentSoundSource = 'upload';
    updateSoundSourceUI('upload');
    setStatus('อัปโหลดสำเร็จ ✓');
    renderTierOwnAudioStatus('upload');
    showTierUploadReview(data.url);
  } catch (err) {
    setStatus('อัปโหลดไม่สำเร็จ: ' + err.message);
  }
});

// Own-audio: uploaded file review (play + change)
function showTierUploadReview(url) {
  const labelBtn = document.getElementById('tierUploadLabelBtn');
  const review = document.getElementById('tierUploadReview');
  const preview = document.getElementById('tierUploadPreview');
  if (labelBtn) labelBtn.style.display = 'none';
  if (review) review.style.display = '';
  if (preview) preview.src = url;
}

function hideTierUploadReview() {
  const labelBtn = document.getElementById('tierUploadLabelBtn');
  const review = document.getElementById('tierUploadReview');
  const preview = document.getElementById('tierUploadPreview');
  if (labelBtn) labelBtn.style.display = '';
  if (review) review.style.display = 'none';
  if (preview) { preview.pause(); preview.src = ''; }
}

document.getElementById('tierUploadCancelBtn')?.addEventListener('click', () => {
  hideTierUploadReview();
  const fileInput = document.getElementById('tierOwnAudioFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('tierOwnAudioStatus');
  if (status) status.textContent = '';
  if (currentSoundSource === 'upload') {
    selectedTierSoundUrl = null;
    selectedTierSoundIsTemp = false;
    selectedTierSoundLabel = '';
    currentSoundSource = null;
    updateSoundSourceUI(null);
  }
});

// §10.8 — recorded audio review
function showTierRecordReview(blob) {
  tierRecordPendingBlob = blob;
  tierRecordOriginalBlob = blob;
  const controls = document.getElementById('tierRecordControls');
  const review = document.getElementById('tierRecordReview');
  const preview = document.getElementById('tierRecordPreview');
  const eqRow = document.getElementById('tierEqRow');
  if (controls) controls.style.display = 'none';
  if (review) review.style.display = '';
  if (eqRow) {
    const supportsEq = !!(window.AudioContext || window.webkitAudioContext);
    eqRow.style.display = supportsEq ? '' : 'none';
    eqRow.querySelectorAll('.tier-eq-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.eq === 'normal'));
  }
  const eqStatus = document.getElementById('tierEqStatus');
  if (eqStatus) { eqStatus.classList.remove('tier-status-busy'); eqStatus.textContent = ''; }
  if (preview) {
    tierRecordPreviewUrl = URL.createObjectURL(blob);
    preview.src = tierRecordPreviewUrl;
    preview.load();
    // Chrome bug: live-recorded webm blob has no duration box → duration reports
    // Infinity/NaN and controls UI shows stuck 0:00. Force a seek so the browser
    // computes the real duration, then reset playhead to 0.
    preview.addEventListener('loadedmetadata', function fixDuration() {
      preview.removeEventListener('loadedmetadata', fixDuration);
      if (preview.duration === Infinity || isNaN(preview.duration)) {
        preview.currentTime = 1e101;
        preview.addEventListener('timeupdate', function resetTime() {
          preview.removeEventListener('timeupdate', resetTime);
          preview.currentTime = 0;
        });
      }
    });
  }
}

function hideTierRecordReview() {
  tierRecordPendingBlob = null;
  tierRecordOriginalBlob = null;
  tierRecordEqBusy = false;
  const controls = document.getElementById('tierRecordControls');
  const review = document.getElementById('tierRecordReview');
  const preview = document.getElementById('tierRecordPreview');
  const eqRow = document.getElementById('tierEqRow');
  const confirmHint = document.getElementById('tierRecordConfirmHint');
  if (controls) controls.style.display = '';
  if (review) review.style.display = 'none';
  if (eqRow) eqRow.style.display = 'none';
  if (confirmHint) confirmHint.style.display = 'none';
  if (preview) { preview.src = ''; preview.load(); }
  if (tierRecordPreviewUrl) { URL.revokeObjectURL(tierRecordPreviewUrl); tierRecordPreviewUrl = null; }
}

// §Donor EQ Bake — offline render 3 fixed presets onto recorded blob
function encodeWav(audioBuffer) {
  const ch = audioBuffer.getChannelData(0);
  const n = ch.length, sr = audioBuffer.sampleRate;
  const ab = new ArrayBuffer(44 + n * 2);
  const v = new DataView(ab);
  const wStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wStr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); wStr(8, 'WAVE');
  wStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wStr(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, ch[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
}

// Pitch-shift preserving duration (chipmunk/deep-voice) — NOT tone-EQ, NOT playbackRate
// (playbackRate/detune always change pitch+speed together). Algorithm: resample to a
// shorter/longer sample count (shifts pitch), then OLA time-stretch back to the original
// sample count (restores duration while keeping the pitch the resample already set).
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

function resampleLinear(input, targetLength) {
  const output = new Float32Array(targetLength);
  const ratio = (input.length - 1) / Math.max(1, targetLength - 1);
  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const s0 = input[i0] || 0;
    const s1 = input[i0 + 1] !== undefined ? input[i0 + 1] : s0;
    output[i] = s0 + (s1 - s0) * frac;
  }
  return output;
}

// WSOLA stretch `input` to exactly `targetLength` samples, preserving its pitch/timbre.
// Plain OLA (copy each grain from a fixed hop position) causes phase clashes between
// overlapping grains — audible as a doubled/echoey "chorus" artifact. WSOLA fixes this by
// nudging each grain's read position (±maxShift) to whichever offset best correlates with
// the tail of the previous grain, so waveform cycles line up across the overlap.
// Loop is still bounded by outPos only (never breaks early on input exhaustion) so the full
// targetLength is always covered — reading past input end just zero-pads instead of cutting
// the clip short. The shift search only changes WHERE a grain is read from, never whether
// the loop keeps going, so that guarantee holds regardless of shift.
function timeStretch(input, targetLength, grainSize = 2048) {
  const output = new Float32Array(targetLength);
  const weight = new Float32Array(targetLength);
  const win = hannWindow(grainSize);
  const hopOut = Math.floor(grainSize / 4);
  const hopIn = (hopOut * input.length) / targetLength;
  const overlapLen = grainSize - hopOut;
  const corrLen = Math.min(overlapLen, 400);
  const maxShift = Math.min(Math.floor(hopIn / 2), 150);

  let inPos = 0, outPos = 0;
  let prevRi = null;
  while (outPos < targetLength) {
    let ri = Math.floor(inPos);
    if (prevRi !== null && maxShift > 0) {
      const refStart = prevRi + hopOut;
      if (refStart >= 0 && refStart + corrLen <= input.length) {
        let bestShift = 0, bestScore = -Infinity;
        for (let shift = -maxShift; shift <= maxShift; shift++) {
          const start = ri + shift;
          if (start < 0 || start + corrLen > input.length) continue;
          let score = 0;
          for (let k = 0; k < corrLen; k++) score += input[start + k] * input[refStart + k];
          if (score > bestScore) { bestScore = score; bestShift = shift; }
        }
        ri += bestShift;
      }
    }
    const end = Math.min(grainSize, targetLength - outPos);
    for (let k = 0; k < end; k++) {
      const idx = ri + k;
      const sample = idx >= 0 && idx < input.length ? input[idx] : 0;
      output[outPos + k] += sample * win[k];
      weight[outPos + k] += win[k];
    }
    prevRi = ri;
    inPos += hopIn;
    outPos += hopOut;
  }
  for (let i = 0; i < targetLength; i++) {
    if (weight[i] > 1e-6) output[i] /= weight[i];
  }
  return output;
}

function pitchShiftSamples(channelData, rate) {
  const resampledLength = Math.max(1, Math.round(channelData.length / rate));
  const resampled = resampleLinear(channelData, resampledLength);
  return timeStretch(resampled, channelData.length);
}

const TIER_EQ_PRESETS = {
  bright: { rate: 1.45 }, // chipmunk — higher pitch, same duration
  warm: { rate: 0.72 }    // deep voice — lower pitch, same duration
};

async function renderEqBlob(originalBlob, mode) {
  const preset = TIER_EQ_PRESETS[mode];
  if (!preset) return originalBlob;
  const DecodeCtx = window.AudioContext || window.webkitAudioContext;
  if (!DecodeCtx) throw new Error('AudioContext unsupported');

  const arrayBuffer = await originalBlob.arrayBuffer();
  const decodeCtx = new DecodeCtx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    decodeCtx.close();
  }

  const shifted = pitchShiftSamples(decoded.getChannelData(0), preset.rate);
  const targetSr = 24000;
  const finalLength = Math.round((shifted.length * targetSr) / decoded.sampleRate);
  const final = resampleLinear(shifted, finalLength);
  const wavBlob = encodeWav({ getChannelData: () => final, sampleRate: targetSr });
  if (wavBlob.size > 1024 * 1024) console.warn('[tier-eq] WAV blob exceeds 1MB:', wavBlob.size);
  return wavBlob;
}

document.getElementById('tierEqRow')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tier-eq-btn');
  if (!btn || tierRecordEqBusy) return;
  const mode = btn.dataset.eq;
  const eqRow = document.getElementById('tierEqRow');
  const preview = document.getElementById('tierRecordPreview');
  if (!tierRecordOriginalBlob) return;

  tierRecordEqBusy = true;
  try {
    const resultBlob = mode === 'normal' ? tierRecordOriginalBlob : await renderEqBlob(tierRecordOriginalBlob, mode);
    tierRecordPendingBlob = resultBlob;
    if (preview) {
      if (tierRecordPreviewUrl) URL.revokeObjectURL(tierRecordPreviewUrl);
      tierRecordPreviewUrl = URL.createObjectURL(resultBlob);
      preview.src = tierRecordPreviewUrl;
      preview.load();
      preview.play().catch(() => {});
    }
    eqRow.querySelectorAll('.tier-eq-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const eqStatusOk = document.getElementById('tierEqStatus');
    if (eqStatusOk) eqStatusOk.textContent = '';
  } catch (err) {
    console.warn('[tier-eq] render failed, fallback to original:', err);
    tierRecordPendingBlob = tierRecordOriginalBlob;
    eqRow.querySelectorAll('.tier-eq-btn').forEach((b) => b.classList.toggle('active', b.dataset.eq === 'normal'));
    const eqStatus = document.getElementById('tierEqStatus');
    if (eqStatus) eqStatus.textContent = 'ปรับโทนเสียงไม่สำเร็จ ใช้เสียงต้นฉบับแทน';
  } finally {
    tierRecordEqBusy = false;
  }
});

document.getElementById('tierRecordRetryBtn')?.addEventListener('click', () => {
  hideTierRecordReview();
  closeTierAudioContext();
});
document.getElementById('tierRecordConfirmBtn')?.addEventListener('click', () => {
  if (!tierRecordPendingBlob) return;
  uploadTierRecordedAudio(tierRecordPendingBlob);
});

// Own-audio: mic recording flow (§4.4 + §10.9 auto-gain)
document.getElementById('tierRecordBtn')?.addEventListener('click', () => {
  // กำลังอัด หรือกำลัง warmup (ปุ่มขึ้น "หยุดอัดเสียง" แล้ว) → กดคือหยุด
  if ((tierMediaRecorder && tierMediaRecorder.state === 'recording') || tierRecordWarmupTimeout) {
    stopTierRecording(false);
  } else {
    startTierRecording();
  }
});

function closeTierAudioContext() {
  if (tierAudioContext && tierAudioContext.state !== 'closed') {
    try { tierAudioContext.close(); } catch {}
  }
  tierAudioContext = null;
  tierGainNode = null;
}

let tierRecordStarting = false;
const TIER_RECORD_WARN = {
  // เว็บวิวในแอป (TikTok/IG/FB/LINE) หรือเบราว์เซอร์เก่า — ไม่มี getUserMedia
  nobrowser: '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> <strong>เบราว์เซอร์นี้ใช้ไมโครโฟนไม่ได้</strong><br>ถ้าคุณเปิดหน้านี้จากในแอป (เช่น TikTok, Facebook, IG, LINE) กรุณาแตะปุ่มเมนู <i class="fa-solid fa-ellipsis"></i> มุมขวาบน แล้วเลือก <strong>"เปิดในเบราว์เซอร์"</strong> (Chrome / Safari) จากนั้นกลับมาลองอัดเสียงใหม่อีกครั้ง',
  // ผู้ใช้กดไม่อนุญาต / บล็อกสิทธิ์ไมค์ / ยังไม่กดอนุญาต (NotAllowedError, SecurityError)
  permission: '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> <strong>ต้องอนุญาตให้ใช้ไมโครโฟนก่อน</strong><br>ต้องกด <strong>"อนุญาต"</strong> ให้เว็บเข้าถึงไมโครโฟน ถึงจะอัดเสียงได้ ถ้าเปิดจากในแอป (TikTok/Facebook/IG/LINE) ให้เลือก <strong>"เปิดในเบราว์เซอร์"</strong> ที่มุมบนขวาก่อน',
  // ไม่มีไมค์ในอุปกรณ์ (NotFoundError)
  nomic: '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> <strong>ไม่พบไมโครโฟน</strong><br>อุปกรณ์นี้ไม่มีไมโครโฟน หรือถูกปิดใช้งานอยู่ กรุณาเชื่อมต่อหรือเปิดใช้ไมโครโฟน แล้วลองอัดเสียงใหม่อีกครั้ง'
};
// ปุ่มก๊อปลิงก์หน้า Donate — สำหรับผู้ใช้ที่ติดในเว็บวิวแอปแล้วหาปุ่มเมนู … ไม่เจอ
const TIER_RECORD_COPY_LINK = '<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(239,68,68,0.25);">หรือก๊อปลิงก์นี้ไปเปิดในเบราว์เซอร์ภายนอกได้ <button type="button" id="tierRecordCopyLink" style="margin-left:4px;padding:4px 10px;border-radius:6px;border:1px solid rgba(252,165,165,0.5);background:rgba(239,68,68,0.15);color:#fca5a5;font-size:12px;cursor:pointer;"><i class="fa-solid fa-copy"></i> <span>คัดลอกลิงก์</span></button></div>';

async function copyDonatePageLink(e) {
  const btn = e.currentTarget;
  const url = window.location.href;
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    // เว็บวิวในแอปมัก block clipboard API → fallback execCommand
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  btn.innerHTML = ok
    ? '<i class="fa-solid fa-check" style="color:#22c55e;"></i> <span>คัดลอกแล้ว</span>'
    : '<i class="fa-solid fa-triangle-exclamation" style="color:#fbbf24;"></i> <span>ก๊อปเองที่ช่อง URL</span>';
}

function showTierRecordWarn(kind) {
  const box = document.getElementById('tierRecordUnsupported');
  if (!box) return;
  const base = TIER_RECORD_WARN[kind] || TIER_RECORD_WARN.nobrowser;
  // nomic = เบราว์เซอร์จริงแต่ไม่มีไมค์ → ก๊อปลิงก์เปิดที่อื่นไม่ช่วย
  box.innerHTML = base + (kind === 'nomic' ? '' : TIER_RECORD_COPY_LINK);
  box.style.display = '';
  const copyBtn = document.getElementById('tierRecordCopyLink');
  if (copyBtn) copyBtn.addEventListener('click', copyDonatePageLink);
}

async function startTierRecording() {
  const unsupportedBox = document.getElementById('tierRecordUnsupported');
  // เว็บวิวในแอป (TikTok/IG/FB/LINE) มักไม่มี getUserMedia → เตือนให้เปิดเบราว์เซอร์ภายนอก
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showTierRecordWarn('nobrowser');
    return;
  }
  if (unsupportedBox) unsupportedBox.style.display = 'none'; // เคลียร์เตือนเก่าเมื่อกดลองใหม่
  // กันกดซ้ำระหว่างรอ getUserMedia (permission prompt) — double-start ทำให้ countdown interval ซ้อนแล้ววิ่งติดลบ
  if (tierRecordStarting) return;
  tierRecordStarting = true;
  const status = document.getElementById('tierRecordStatus');
  const btnLabel = document.getElementById('tierRecordBtnLabel');
  const timerEl = document.getElementById('tierRecordTimer');
  try {
    closeTierAudioContext();
    tierAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    // §10.9 — getUserMedia ก่อน (ใช้ user gesture จากปุ่มกด), ค่อย resume AudioContext ทีหลัง
    // iOS Safari: await ระหว่างทางอาจตัด gesture chain → getUserMedia reject
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
    } catch (e) {
      // iOS 14-15 ไม่รองรับ constraint object → OverconstrainedError → fallback เป็น default
      if (e.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        throw e;
      }
    }
    tierMicStream = stream; // เก็บ ref ไว้ปิดไมค์ได้ทุก path (รวม cancel/หยุดระหว่าง warmup)
    await tierAudioContext.resume();
    const source = tierAudioContext.createMediaStreamSource(stream);
    tierGainNode = tierAudioContext.createGain();
    tierGainNode.gain.value = 2.5;
    source.connect(tierGainNode);
    // brick-wall limiter — กัน digital clip โดยไม่ตัดเสียงกลางทาง
    // threshold -3dB จับเฉพาะ peak ใกล้เพดาน, ratio 20:1 เกือบ brick-wall,
    // attack 0.003s เร็วทัน peak, release 0.05s เร็วมากไม่ pumping
    const limiter = tierAudioContext.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.05;
    const dest = tierAudioContext.createMediaStreamDestination();
    tierGainNode.connect(limiter);
    limiter.connect(dest);
    tierMediaRecorder = new MediaRecorder(dest.stream);
    tierRecordedChunks = [];
    tierMediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) tierRecordedChunks.push(e.data);
    };
    tierMediaRecorder.onerror = (e) => {
      if (status) status.textContent = 'อัดเสียงล้มเหลว: ' + (e.message || 'MediaRecorder error');
      stopTierRecording(true);
    };
    const recorder = tierMediaRecorder;
    tierMediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      tierMicStream = null;
      closeTierAudioContext();
      // iOS Safari อัดเป็น audio/mp4 ไม่ใช่ webm — ต้องใช้ mime จริงของ recorder ไม่งั้นไฟล์ติดป้ายผิด
      const mime = (recorder.mimeType || 'audio/webm').split(';')[0];
      const blob = new Blob(tierRecordedChunks, { type: mime });
      if (blob.size === 0) {
        if (status) status.textContent = 'ไม่ได้บันทึกเสียง กรุณาอัดใหม่';
        hideTierRecordReview();
      } else {
        showTierRecordReview(blob);
      }
    };
    if (btnLabel) btnLabel.textContent = 'หยุดอัดเสียง';
    // เปิดไมค์แล้วแต่ยังไม่อัด — นับถอยหลัง 3 วิก่อนเริ่มอัดจริง. ได้ประโยชน์ 2 ทาง:
    // (1) condenser mic (desktop) มี "ตุ๊บ" กระแทกตอนเปิดกระทันหัน อยู่ใน buffer แรก → 3 วินี้
    //     click ไหลผ่าน graph → dest ทิ้งไป โดย recorder ยังไม่ start = ไม่ถูกอัด
    // (2) donor เตรียมตัวพูดพอดี. มือถือไม่มีอาการนี้แต่นับถอยหลังเหมือนกันเพื่อ UX เดียว
    let prep = 3;
    if (status) status.textContent = 'เตรียมตัว...';
    if (timerEl) { timerEl.style.display = ''; timerEl.classList.add('prep'); timerEl.textContent = `เริ่มอัดใน ${prep} วินาที...`; }
    const prepId = setInterval(() => {
      prep -= 1;
      if (prep > 0 && timerEl) timerEl.textContent = `เริ่มอัดใน ${prep} วินาที...`;
    }, 1000);
    tierRecordCountdownInterval = prepId; // ให้ stopTierRecording (clear ที่ top) เก็บกวาดได้ถ้ากดหยุดระหว่างนับ
    tierRecordWarmupTimeout = setTimeout(() => {
      tierRecordWarmupTimeout = null;
      clearInterval(prepId);
      // ถูกยกเลิก/ปิด context ระหว่างนับถอยหลัง (กด "หยุด" เร็ว) → ห้าม start
      if (!tierMediaRecorder || tierMediaRecorder.state !== 'inactive') return;
      tierRecordedChunks = [];
      tierMediaRecorder.start(1000);
      if (status) status.textContent = 'กำลังอัด...';

      let remaining = 8;
      if (timerEl) { timerEl.classList.remove('prep'); timerEl.textContent = `กำลังอัด... เหลือ ${remaining} วินาที`; }
      // clear ด้วย id ของตัวเอง — ห้ามอ้างตัวแปร shared (ถ้าถูก start รอบใหม่ทับ จะ clear ผิดตัว)
      const countdownId = setInterval(() => {
        remaining -= 1;
        if (timerEl) timerEl.textContent = `กำลังอัด... เหลือ ${remaining} วินาที`;
        if (remaining <= 0) clearInterval(countdownId);
      }, 1000);
      tierRecordCountdownInterval = countdownId;
      tierRecordTimeout = setTimeout(() => stopTierRecording(false), 8000);
    }, 3000);
    tierRecordStarting = false;
  } catch (err) {
    tierRecordStarting = false;
    tierMicStream?.getTracks().forEach(t => t.stop());
    tierMicStream = null;
    closeTierAudioContext();
    if (btnLabel) btnLabel.textContent = 'เริ่มอัดเสียง';
    if (status) status.textContent = '';
    // แยกเหตุผล: ปฏิเสธ/บล็อกสิทธิ์ vs ไม่มีไมค์ vs เว็บวิวไม่รองรับ
    const name = err && err.name;
    const kind = (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') ? 'permission'
      : (name === 'NotFoundError' || name === 'DevicesNotFoundError') ? 'nomic'
      : 'nobrowser';
    showTierRecordWarn(kind);
  }
}

function stopTierRecording(cancel) {
  clearTimeout(tierRecordTimeout);
  clearInterval(tierRecordCountdownInterval);
  const timerEl = document.getElementById('tierRecordTimer');
  if (timerEl) { timerEl.style.display = 'none'; timerEl.classList.remove('prep'); }
  const btnLabel = document.getElementById('tierRecordBtnLabel');
  if (btnLabel) btnLabel.textContent = 'เริ่มอัดเสียง';
  // หยุดระหว่าง warmup (recorder ยังไม่ start) → ยังไม่มีอะไรอัด ทิ้ง cleanup เหมือน cancel
  if (tierRecordWarmupTimeout) {
    clearTimeout(tierRecordWarmupTimeout);
    tierRecordWarmupTimeout = null;
    if (tierMediaRecorder) tierMediaRecorder.onstop = null;
    tierMicStream?.getTracks().forEach(t => t.stop());
    tierMicStream = null;
    closeTierAudioContext();
    tierMediaRecorder = null;
    const status = document.getElementById('tierRecordStatus');
    if (status) status.textContent = '';
    return;
  }
  // ห้ามปิด AudioContext ก่อน MediaRecorder.stop() — จะทำให้ WebM ขาด/ว่าง
  if (cancel && tierMediaRecorder) {
    tierMediaRecorder.onstop = null;
    if (tierMediaRecorder.state === 'recording') tierMediaRecorder.stop();
    tierMicStream?.getTracks().forEach(t => t.stop()); // ปิดไมค์จริง (ไม่ใช่ dest.stream)
    tierMicStream = null;
    closeTierAudioContext();
    tierMediaRecorder = null;
    return;
  }
  if (tierMediaRecorder && tierMediaRecorder.state === 'recording') {
    tierMediaRecorder.stop(); // onstop จะปิด AudioContext + สร้าง blob เอง
  }
}

async function uploadTierRecordedAudio(blob) {
  if (!blob || tierRecordUploadInFlight) return;
  tierRecordUploadInFlight = true;
  const status = document.getElementById('tierRecordStatus');
  const eqStatus = document.getElementById('tierEqStatus');
  const confirmBtn = document.getElementById('tierRecordConfirmBtn');
  const setStatus = (msg) => { if (status) { status.classList.remove('tier-status-busy'); status.textContent = msg; } };
  if (confirmBtn) confirmBtn.disabled = true;
  setTierStatusBusy(eqStatus, 'กำลังอัปโหลดเสียง...');
  let uploadCompleted = false;
  try {
    const username = window.location.pathname.split('/')[1];
    const formData = new FormData();
    const ext = { 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav' }[blob.type] || 'webm';
    formData.append('audio', blob, 'recording.' + ext);
    formData.append('username', username);
    formData.append('mode', 'record');
    const res = await fetch('/api/donate/upload-tier-audio', { method: 'POST', body: formData });
    const data = await res.json();
    if (isOverloadResponse(res, data)) {
      setTierStatusBusy(document.getElementById('tierEqStatus'), 'ระบบกำลังมีผู้ใช้งานหนาแน่น เสียงที่อัดไว้ยังอยู่ กดส่งใหม่อีกครั้งใน 1 นาทีได้เลย');
      return;
    }
    if (!res.ok) throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
    if (!data.url) throw new Error('ไม่ได้รับ URL ของไฟล์เสียง');
    selectedTierSoundUrl = data.url;
    selectedTierSoundIsTemp = true;
    selectedTierSoundLabel = 'เสียงที่อัดจากไมค์';
    currentSoundSource = 'record';
    updateSoundSourceUI('record');
    renderTierOwnAudioStatus('record');
    uploadCompleted = true;
    hideTierRecordReview();
    const confirmHint = document.getElementById('tierRecordConfirmHint');
    if (confirmHint) confirmHint.style.display = 'none';
    setStatus('อัดเสียงสำเร็จ ✓');
  } catch (err) {
    setTierStatusBusy(eqStatus, 'อัปโหลดไม่สำเร็จ: ' + err.message + ' — กดใช้เสียงนี้อีกครั้งได้เลย');
  } finally {
    tierRecordUploadInFlight = false;
    if (confirmBtn) confirmBtn.disabled = false;
    renderTierOwnAudioStatus(currentSoundSource);
  }
}

function renderSocialLinks(socials) {
  socialLinksContainer.innerHTML = '';
  
  const activeLinks = Object.entries(socials).filter(([_, url]) => url);
  const showLabels = activeLinks.length <= 4;

  const platformNames = {
    twitch: 'Twitch',
    youtube: 'YouTube',
    tiktok: 'TikTok',
    facebook: 'Facebook',
    x: 'X (Twitter)',
    discord: 'Discord',
    instagram: 'Instagram',
    kick: 'Kick'
  };

  activeLinks.forEach(([platform, url]) => {
    // SEC-001 / SEC-012: Validate URL scheme and add noopener to prevent XSS and tab-nabbing
    let parsed;
    try {
      parsed = new URL(url);
    } catch { return; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    // userinfo ในลิงก์ = ส่ง credential ไปปลายทาง — ตัดทุกแพลตฟอร์ม ไม่ใช่แค่ Kick
    if (parsed.username || parsed.password) return;
    // ปุ่ม Kick ติดป้ายแบรนด์ — mirror validateKickUrl() ฝั่ง server กัน legacy data ที่บันทึกไว้ก่อนมี validation
    if (platform === 'kick') {
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || url.length > 2048 || (host !== 'kick.com' && !host.endsWith('.kick.com'))) return;
    }
    const iconClass = SOCIAL_ICONS[platform] || 'fa-link';
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = `social-btn ${platform}`;
    a.setAttribute('aria-label', platformNames[platform] || platform);

    const label = showLabels ? `<span class="social-label">${platformNames[platform] || platform}</span>` : '';
    a.innerHTML = `<i class="fa-brands ${iconClass}"></i>${label}`;

    socialLinksContainer.appendChild(a);
  });
}

function updateAmountOptions(min) {
  const base = min <= 10 ? 10 : min;
  const amounts = [base, base + 5, base + 10, base + 40];
  amountBtns.forEach((btn, i) => {
    if (amounts[i] != null) {
      btn.dataset.amount = amounts[i];
      btn.querySelector('.amount-val').textContent = `฿${amounts[i].toLocaleString()}`;
    }
  });
}

// Amount button click — กดปุ่มเดิมซ้ำ = ยกเลิกเลือก
amountBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    restoredTierSnapshot = null;
    hasRestoredTimerAction = false;
    const wasSelected = btn.classList.contains('selected');
    amountBtns.forEach(b => b.classList.remove('selected'));
    if (wasSelected) {
      selectedAmount = 0;
      customAmountInput.value = '';
    } else {
      btn.classList.add('selected');
      selectedAmount = parseInt(btn.dataset.amount);
      customAmountInput.value = selectedAmount;
    }
    updateDonateButton();
  });
});

// Custom amount input
customAmountInput.addEventListener('input', () => {
  restoredTierSnapshot = null;
  hasRestoredTimerAction = false;
  amountBtns.forEach(b => b.classList.remove('selected'));
  selectedAmount = parseInt(customAmountInput.value) || 0;
  updateDonateButton();
});

// Timer choice button click
document.getElementById('timerChoiceBox')?.addEventListener('click', e => {
  const btn = e.target.closest('.timer-choice-btn');
  if (!btn) return;
  hasRestoredTimerAction = false;
  timerChoice = btn.dataset.choice;
  updateTimerChoiceBox();
});

// Update donate button state
function updateDonateButton() {
  const isValid = selectedAmount >= userMinAmount;
  btnDonate.disabled = !isValid;
  
  if (isValid) {
    btnDonate.textContent = `บริจาค ฿${selectedAmount.toLocaleString()}`;
  } else {
    btnDonate.textContent = 'ดำเนินการต่อ';
  }
  
  // Show/hide min amount warning for custom input
  const customVal = parseInt(customAmountInput.value);
  if (customAmountInput.value && !isNaN(customVal) && customVal < userMinAmount) {
    minAmountWarning.style.display = 'block';
  } else {
    minAmountWarning.style.display = 'none';
  }
  updateTimerChoiceBox();
  recomputeTierUnlock();
}

// ── Timer Donor Choice ──
function formatChoiceTime(secs) {
  const m = Math.floor(secs / 60), s = secs % 60, h = Math.floor(m / 60);
  if (h > 0) return `${h} ชม. ${m % 60 ? (m % 60) + ' นาที' : ''}`.trim();
  if (m > 0) return `${m} นาที${s ? ' ' + s + ' วิ' : ''}`;
  return `${s} วินาที`;
}

function resolveTimerAction(amount) {
  // returns { seconds, action } or null — ครอบคลุม add/sub/choice ทั้ง 3 mode
  const t = timerPublicConfig;
  if (!t || !amount) return null;
  const rules = Array.isArray(t.rules) ? t.rules : [];
  if (t.mode === 'multiplier') {
    // Tier-pick: ใช้กฏเดียวที่ base_amount สูงสุดที่ amount ถึง — ต้องตรงกับ server calculateTimeDelta เป๊ะ
    const qualifying = rules.filter(r => r.base_amount > 0 && amount >= r.base_amount);
    if (qualifying.length === 0) return null;
    const tier = qualifying.reduce((a, b) => b.base_amount > a.base_amount ? b : a);
    const mult = Math.floor(amount / tier.base_amount);
    if (mult <= 0 || !tier.time_seconds) return null;
    return { seconds: mult * tier.time_seconds, action: tier.action || 'add' };
  }
  if (t.mode === 'threshold') {
    const tier = [...rules].sort((a, b) => b.amount - a.amount).find(r => amount >= r.amount);
    if (!tier || !tier.time_seconds) return null;
    return { seconds: tier.time_seconds, action: tier.action || 'add' };
  }
  if (t.mode === 'fixed') {
    const m = rules.find(r => Math.abs(r.amount - amount) < 0.01);
    if (!m || !m.time_seconds) return null;
    return { seconds: m.time_seconds, action: m.action || 'add' };
  }
  return null;
}

function getChoiceEffect(amount) {
  const t = timerPublicConfig;
  if (!t || !t.enabled || !amount) return null;
  const resolved = resolveTimerAction(amount);
  if (!resolved) return null;
  const { seconds: rawSecs, action } = resolved;

  // Cap layer — mirror server applyTimerOnDonation clamp เป๊ะ (B3/B4)
  const capOn = t.capType && (t.capValue || 0) > 0;
  const room = capOn ? Math.max(0, (t.capValue || 0) - (t.capCurrent || 0)) : 0;
  let addSeconds = rawSecs, subSeconds = rawSecs;
  if (capOn && t.capType === 'money') {
    // server: นับเสมือนโดเนทแค่ยอดที่เหลือใน room — clamp ทั้งสองทิศทาง
    const clampedSecs = room > 0 ? (resolveTimerAction(Math.min(amount, room))?.seconds || 0) : 0;
    addSeconds = clampedSecs;
    subSeconds = clampedSecs;
  } else if (capOn && t.capType === 'time') {
    addSeconds = Math.min(rawSecs, room); // server clamp เฉพาะฝั่งเพิ่ม — ฝั่งลดไม่จำกัด
  }
  const capFull = action === 'add' ? addSeconds <= 0 :
                  action === 'sub' ? subSeconds <= 0 :
                  (addSeconds <= 0 && subSeconds <= 0);
  return {
    seconds: rawSecs,
    action,
    addSeconds,
    subSeconds,
    clamped: addSeconds < rawSecs || subSeconds < rawSecs,
    capFull,
  };
}

function updateTimerChoiceBox() {
  const box = document.getElementById('timerChoiceBox');
  if (!box) return;
  // Gate 1 (TIMER_CHOICE_GATE B3): timer widget ต้องเปิดอยู่บน OBS (มี SSE client source='timer' ค้าง)
  if (!timerActive) { box.classList.remove('visible'); return; }
  // Gate 2: ยอดต้องเข้ากฏ (add/sub/choice ทั้งหมด)
  const eff = getChoiceEffect(selectedAmount);
  if (!eff) { box.classList.remove('visible'); return; }
  box.classList.add('visible');
  const effEl = document.getElementById('timerChoiceEffect');
  const optsEl = box.querySelector('.timer-choice-options');
  const titleText = document.getElementById('timerChoiceTitleText');

  if (eff.capFull) {
    if (titleText) titleText.textContent = 'เลือกปรับเวลานับถอยหลัง';
    effEl.className = 'timer-choice-effect';
    effEl.textContent = '(ครบเป้าหมายแล้ว — โดเนทนี้ไม่ปรับเวลา)';
    if (optsEl) optsEl.style.display = 'none';
    return;
  }

  // กรณี action ถูกกำหนดตายตัว — ซ่อน options, แสดงสีแดง/เขียว
  if (eff.action === 'add') {
    if (titleText) titleText.textContent = 'โดเนทนี้จะปรับเวลานับถอยหลัง';
    effEl.className = 'timer-choice-effect timer-choice-effect--add';
    effEl.textContent = `+${formatChoiceTime(eff.addSeconds)}${eff.clamped ? '\n(ถึงยอดสูงสุดที่ปรับได้แล้ว)' : ''}`;
    if (optsEl) optsEl.style.display = 'none';
    return;
  }
  if (eff.action === 'sub') {
    if (titleText) titleText.textContent = 'โดเนทนี้จะลดเวลานับถอยหลัง';
    effEl.className = 'timer-choice-effect timer-choice-effect--sub';
    effEl.textContent = `−${formatChoiceTime(eff.subSeconds)}${eff.clamped ? '\n(ถึงยอดสูงสุดที่ปรับได้แล้ว)' : ''}`;
    if (optsEl) optsEl.style.display = 'none';
    return;
  }

  // action === 'choice': พฤติกรรมเดิม — donor เลือกเองได้
  if (titleText) titleText.textContent = 'เลือกปรับเวลานับถอยหลัง';
  effEl.className = 'timer-choice-effect';
  if (optsEl) optsEl.style.display = '';
  if (eff.addSeconds !== eff.subSeconds) {
    effEl.textContent = `(+${formatChoiceTime(eff.addSeconds)} / −${formatChoiceTime(eff.subSeconds)})`;
  } else {
    effEl.textContent = `±${formatChoiceTime(eff.addSeconds)}${eff.clamped ? '\n(ถึงยอดสูงสุดที่ปรับได้แล้ว)' : ''}`;
  }
  const noneBtn = box.querySelector('[data-choice="none"]');
  if (noneBtn) noneBtn.style.display = timerPublicConfig.allowPassthrough ? '' : 'none';
  if (!timerPublicConfig.allowPassthrough && timerChoice === 'none') timerChoice = 'add';
  box.querySelectorAll('.timer-choice-btn').forEach(b => {
    const on = b.dataset.choice === timerChoice;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function getTimerActionForSubmit() {
  if (hasRestoredTimerAction) return restoredTimerAction;
  if (!timerActive) return null;                                            // B6: defense-in-depth
  const eff = getChoiceEffect(selectedAmount);
  if (!eff || eff.capFull) return null;                                     // capFull: server ignore อยู่แล้ว — กันชั้นสอง
  if (eff.action !== 'choice') return eff.action;                          // กฏตายตัว — ส่งตรง
  return timerChoice;
}

// Real-time widget status via SSE — drives both statusBtn and timerChoiceBox
function startWidgetStatusStream() {
  if (widgetStatusSource) return;
  const username = window.location.pathname.split('/')[1];
  if (!username) return;
  widgetStatusSource = new EventSource(`/api/widget/status/stream?username=${encodeURIComponent(username)}`);
  widgetStatusSource.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'timer_cap' && timerPublicConfig) {
        timerPublicConfig.capType = data.capType;
        timerPublicConfig.capValue = data.capValue;
        timerPublicConfig.capCurrent = data.capCurrent;
        updateTimerChoiceBox();
        return;
      }
      if (data.type !== 'widget_status') return;
      if (typeof data.overlayActive === 'boolean' && data.overlayActive !== overlayActive) {
        overlayActive = data.overlayActive;
        applyOverlayStatus(overlayActive);
      }
      if (typeof data.timerActive === 'boolean' && data.timerActive !== timerActive) {
        timerActive = data.timerActive;
        updateTimerChoiceBox();
      }
    } catch (_) { /* ignore parse blip */ }
  };
  widgetStatusSource.onopen = () => { widgetStatusRetryDelay = 3000; };
  // EventSource only auto-reconnects after a dropped 200 stream — a 503 (load shedding)
  // kills it permanently. Reconnect by hand, starting at 3s so a crowd of donate pages
  // doesn't hammer an already-overloaded server. The server pushes current state on
  // connect (broadcastWidgetStatus), so no extra fetch is needed after reconnecting.
  widgetStatusSource.onerror = () => {
    widgetStatusSource.close();
    widgetStatusSource = null;
    clearTimeout(widgetStatusRetryTimer);
    widgetStatusRetryTimer = setTimeout(startWidgetStatusStream, widgetStatusRetryDelay);
    widgetStatusRetryDelay = Math.min(widgetStatusRetryDelay * 1.5, 30000);
  };
}

function applyOverlayStatus(active) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusNote = document.getElementById('statusNote');
  const refreshIcon = document.querySelector('#statusBtn .lucide-refresh-ccw');
  if (refreshIcon) refreshIcon.classList.remove('spinning');
  if (active) {
    if (statusDot) statusDot.classList.add('online');
    if (statusText) statusText.textContent = 'โดขึ้นจอ | เปิดอยู่';
    if (statusNote) statusNote.style.display = 'none';
  } else {
    if (statusDot) statusDot.classList.remove('online');
    if (statusText) statusText.textContent = 'โดขึ้นจอ | ปิดอยู่';
    if (statusNote) statusNote.style.display = 'block';
  }
}

// PromptPay/Bank ยืนยันด้วยการอัปโหลดสลิป จึงต้องมี SlipOK ที่ตั้งค่าแล้วและเชื่อมต่อได้
// TrueMoney Webhook ยืนยันเองผ่าน webhook — ไม่เกี่ยวกับ SlipOK จึงห้ามถูกซ่อนตาม
function getUsablePaymentMethods(methods) {
  if (!methods || typeof methods !== 'object') {
    return { ffp: false, promptpay: false, truemoney: false, bank: false, any: false };
  }
  // slipok_ready = server คำนวณตาม lane เดียวกับ /api/verify-slip (primary มาก่อน fallback TrueMoney)
  // fallback expression ไว้เผื่อ client cache เก่าเจอ response ที่ยังไม่มี field นี้
  const slipOkReady = methods.slipok_ready !== undefined
    ? !!methods.slipok_ready
    : !!(methods.slipok_configured && methods.slipok_connected);
  const usable = {
    ffp: !!methods.ffp,
    promptpay: !!methods.promptpay && slipOkReady,
    truemoney: !!methods.truemoney_webhook,
    bank: !!methods.bank && slipOkReady
  };
  usable.any = usable.ffp || usable.promptpay || usable.truemoney || usable.bank;
  return usable;
}

function hydratePaymentMethodStep(methods) {
  if (!methods || typeof methods !== 'object') return false;
  streamerPaymentMethods = methods;
  const usable = getUsablePaymentMethods(methods);

  // ซ่อนการ์ดก่อนเสมอ แม้ไม่มีวิธีที่ใช้ได้เลย — การ์ดใน index.html แสดงเป็น default
  // ถ้า return ก่อนตรงนี้ เส้นทาง restore แล้วกด Back จะโชว์การ์ดที่ใช้ไม่ได้ทั้งหมด (AUDIT ROUND_1 A2)
  const optionFFP = document.getElementById('optionFFP');
  const optionPromptPay = document.getElementById('optionPromptPay');
  const optionTrueMoney = document.getElementById('optionTrueMoney');
  const optionBank = document.getElementById('optionBank');
  if (optionFFP) optionFFP.style.display = usable.ffp ? '' : 'none';
  if (optionPromptPay) optionPromptPay.style.display = usable.promptpay ? '' : 'none';
  if (optionBank) optionBank.style.display = usable.bank ? '' : 'none';

  // ปิดปรับปรุงชั่วคราว (global kill-switch) — โชว์การ์ดแบบกดไม่ได้ แทนการซ่อน
  const maintenanceBadge = document.getElementById('trueMoneyMaintenanceBadge');
  const featureRibbon = document.getElementById('trueMoneyFeatureRibbon');
  if (optionTrueMoney) {
    if (methods.truemoney_webhook_maintenance) {
      optionTrueMoney.style.display = '';
      optionTrueMoney.classList.add('disabled');
      if (maintenanceBadge) maintenanceBadge.style.display = '';
      if (featureRibbon) featureRibbon.style.display = 'none';
    } else {
      optionTrueMoney.style.display = usable.truemoney ? '' : 'none';
      optionTrueMoney.classList.remove('disabled');
      if (maintenanceBadge) maintenanceBadge.style.display = 'none';
      if (featureRibbon) featureRibbon.style.display = '';
    }
  }

  if (!usable.any) return false;

  const trueMoneyP2PBadge = document.getElementById('trueMoneyP2PBadge');
  const trueMoneyPromptPayBadge = document.getElementById('trueMoneyPromptPayBadge');
  if (trueMoneyP2PBadge || trueMoneyPromptPayBadge) {
    const methodList = (methods.truemoney_webhook_methods || 'P2P').split(',').filter(Boolean);
    const hasP2P = methodList.includes('P2P');
    const hasPromptPayIn = methodList.includes('PROMPTPAY_IN');
    if (trueMoneyP2PBadge) {
      trueMoneyP2PBadge.style.display = hasP2P ? '' : 'none';
      trueMoneyP2PBadge.textContent = 'P2P';
    }
    if (trueMoneyPromptPayBadge) {
      trueMoneyPromptPayBadge.style.display = hasPromptPayIn ? '' : 'none';
    }
  }

  if (usable.promptpay) {
    selectPaymentMethod('promptpay');
  } else if (usable.truemoney) {
    selectPaymentMethod('truemoney');
  } else if (usable.bank) {
    selectPaymentMethod('bank');
  } else {
    selectPaymentMethod('promptpay');
  }
  return true;
}

// แสดง error ใต้ปุ่มโดเนท (shake + red glow + ข้อความ) — ใช้ node/animation เดิมทั้งหมด
function showDonateBlockedMessage(text) {
  const btn = document.getElementById('btnDonate');
  const existingMsg = document.getElementById('noPaymentMethodMsg');

  // ลบ animation เดิม (ถ้ามี) เพื่อ re-trigger
  btn.classList.remove('btn-shake', 'btn-glow-red');
  void btn.offsetWidth; // reflow
  btn.classList.add('btn-shake', 'btn-glow-red');

  if (!existingMsg) {
    const msg = document.createElement('div');
    msg.id = 'noPaymentMethodMsg';
    msg.className = 'no-payment-message';
    msg.textContent = text;
    btn.parentElement.appendChild(msg);
  } else {
    existingMsg.textContent = text;
    // re-trigger animation
    existingMsg.style.animation = 'none';
    void existingMsg.offsetWidth;
    existingMsg.style.animation = 'revealMessage 0.5s ease-out forwards';
  }
}

function isTierRecordAwaitingConfirmation() {
  const review = document.getElementById('tierRecordReview');
  return !!(
    tierRecordPendingBlob
    || (review && review.style.display !== 'none')
    || tierRecordUploadInFlight
  );
}

function showTierRecordConfirmationGate() {
  const btn = document.getElementById('btnDonate');
  const recordSubtab = document.getElementById('tierRecordSubtabBtn');
  const confirmBtn = document.getElementById('tierRecordConfirmBtn');
  const hint = document.getElementById('tierRecordConfirmHint');

  if (recordSubtab && !recordSubtab.classList.contains('active')) recordSubtab.click();
  if (btn) {
    btn.classList.remove('btn-shake', 'btn-glow-red');
    void btn.offsetWidth;
    btn.classList.add('btn-shake', 'btn-glow-red');
  }
  if (hint) {
    hint.style.display = '';
    hint.textContent = tierRecordUploadInFlight
      ? 'กำลังอัปโหลดเสียง กรุณารอสักครู่ก่อนดำเนินการต่อ'
      : 'กรุณากด “ใช้เสียงนี้” ก่อนดำเนินการต่อ';
  }
  if (confirmBtn) {
    confirmBtn.classList.remove('btn-glow-red');
    void confirmBtn.offsetWidth;
    confirmBtn.classList.add('btn-glow-red');
    confirmBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    try { confirmBtn.focus({ preventScroll: true }); } catch { confirmBtn.focus(); }
  }
}

// Donate button click -> go to payment method selection
let donateGateInFlight = false;
btnDonate.addEventListener('click', async () => {
  if (isTierRecordAwaitingConfirmation()) {
    showTierRecordConfirmationGate();
    return;
  }
  if (donateGateInFlight) return; // กดรัวระหว่างรอ response = ยิงซ้ำโดยเปล่าประโยชน์ (QA ROUND_1 Q1)
  if (selectedAmount < userMinAmount) return;

  const username = window.location.pathname.split('/')[1];
  if (!username) {
    alert('ไม่พบชื่อผู้รับบริจาคใน URL');
    return;
  }

  // Guard: เช็คว่า streamer ตั้งค่าวิธีชำระเงินอย่างน้อย 1 วิธีหรือไม่
  let methods = null;
  donateGateInFlight = true;
  // request นี้ใช้เวลา ~0.5 วิ — ต้องบอกสถานะ ไม่งั้น donor คิดว่าปุ่มไม่ทำงานแล้วกดซ้ำ (QA ROUND_1 Q2)
  btnDonate.disabled = true;
  btnDonate.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังตรวจสอบ...';
  try {
    const res = await fetch(`/api/page/${username}/payment-methods`);
    if (res.ok) methods = await res.json();
  } catch (e) {
    console.error('Error checking payment methods:', e);
  } finally {
    donateGateInFlight = false;
    updateDonateButton(); // คืนทั้ง label และ disabled ตามยอดล่าสุด
  }

  // Fail closed — ตรวจสถานะช่องทางรับเงินไม่ได้ ห้ามเดาว่าพร้อม (AUDIT ROUND_1 A1)
  if (!methods || typeof methods !== 'object') {
    showDonateBlockedMessage('ไม่สามารถตรวจสอบช่องทางรับเงินได้ กรุณาลองใหม่อีกครั้ง');
    return;
  }

  // วิธีที่ต้องใช้ SlipOK แต่ SlipOK ใช้ไม่ได้ = ไม่นับว่าเป็นช่องทางที่พร้อม (การ์ดจะถูกซ่อนใน hydrate)
  if (!getUsablePaymentMethods(methods).any) {
    if (methods.truemoney_webhook_maintenance) {
      showDonateBlockedMessage('ระบบ TrueMoney ปิดปรับปรุงชั่วคราว กรุณาลองใหม่ภายหลัง');
    } else {
      showDonateBlockedMessage('เจ้าของหน้าโดเนทยังไม่ตั้งวิธีชำระเงิน');
    }
    return; // หยุด — ไม่ไปหน้าถัดไป
  }

  // แสดงเฉพาะวิธีชำระเงินที่ใช้งานได้ + auto-select ตัวแรก (P2P badge อยู่ใน hydrate)
  hydratePaymentMethodStep(methods);

  // Update summary
  document.getElementById('summaryAmount').textContent = `฿${selectedAmount.toLocaleString()}`;
  document.getElementById('summaryDonor').textContent = donorNameInput.value || 'ไม่ระบุชื่อ';

  // เข้าหน้าถัดไปได้แล้ว — ล้าง error เดิม ไม่ให้ค้างตอน Back กลับมาหน้าเลือกจำนวนเงิน
  btnDonate.classList.remove('btn-shake', 'btn-glow-red');
  document.getElementById('noPaymentMethodMsg')?.remove();

  // Show payment method step
  stepAmount.classList.remove('active');
  stepPaymentMethod.classList.add('active');
});

// Payment method option click
document.querySelectorAll('.payment-method-option').forEach(opt => {
  opt.addEventListener('click', () => {
    if (opt.classList.contains('disabled')) return;
    selectPaymentMethod(opt.getAttribute('data-method'));
  });
});

function selectPaymentMethod(method) {
  const target = document.querySelector(`.payment-method-option[data-method="${method}"]`);
  if (!target || target.classList.contains('disabled')) return;
  selectedPaymentMethod = method;
  document.querySelectorAll('.payment-method-option').forEach(o => o.classList.remove('selected'));
  target.classList.add('selected');
  hideProceedError();
  btnProceedPayment.disabled = false;
}

// Back to amount from payment method step
if (btnBackToAmount) {
  btnBackToAmount.addEventListener('click', () => {
    stepPaymentMethod.classList.remove('active');
    stepAmount.classList.add('active');
  });
}

// Proceed with selected payment method
btnProceedPayment.addEventListener('click', async () => {
  const username = window.location.pathname.split('/')[1];
  if (!username) return;

  hideProceedError();
  btnProceedPayment.disabled = true;
  btnProceedPayment.textContent = 'กำลังดำเนินการ...';

  if (selectedPaymentMethod === 'ffp') {
    // Redirect to Beam/FFP payment
    try {
      const response = await fetch('/api/create-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          amount: selectedAmount,
          name: donorNameInput.value,
          message: donorMessageInput.value,
          timerAction: getTimerActionForSubmit(),
          tierImageUrl: selectedTierImageUrl || null,
          tierSoundUrl: selectedTierSoundUrl || null,
          tierSoundIsTemp: selectedTierSoundIsTemp || false,
          tierSoundMode: selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : null,
          tierYoutubeId: selectedTierYoutube?.videoId || null,
          tierYoutubeStart: selectedTierYoutube?.startSec ?? null,
          tierYoutubeEnd: selectedTierYoutube?.endSec ?? null
        })
      });

      const data = await response.json();
      if (isOverloadResponse(response, data)) {
        showOverloadNotice('qr');
        btnProceedPayment.disabled = false;
        btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
        return;
      }
      if (!response.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
      } else {
        throw new Error('ไม่ได้รับลิงก์ชำระเงิน');
      }
    } catch (error) {
      showProceedError('สร้างรายการไม่สำเร็จชั่วคราว โปรดลองใหม่อีกครั้ง');
      btnProceedPayment.disabled = false;
      btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
    }
  } else if (selectedPaymentMethod === 'promptpay') {
    // Check if there's a pending QR with the same params (donor went back and forth without changes)
    const pending = getPendingQR();
    const currentDonorName = donorNameInput?.value?.trim() || '';
    const currentMessage = donorMessageInput?.value?.trim() || '';
    if (pending && pending.amount === selectedAmount && pending.donorName === currentDonorName && pending.message === currentMessage && (pending.timerAction ?? null) === getTimerActionForSubmit()) {
      restoreQRStep(pending);
      btnProceedPayment.disabled = false;
      btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
      return;
    }

    // Clear any expired/mismatched pending entry
    clearPendingQR();

    // Create PromptPay QR
    try {
      const response = await fetch('/api/create-promptpay-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...getAntiBotPayload(),
          username,
          amount: selectedAmount,
          name: donorNameInput.value,
          message: donorMessageInput.value,
          timerAction: getTimerActionForSubmit(),
          tierImageUrl: selectedTierImageUrl || null,
          tierSoundUrl: selectedTierSoundUrl || null,
          tierSoundIsTemp: selectedTierSoundIsTemp || false,
          tierSoundMode: selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : null,
          tierYoutubeId: selectedTierYoutube?.videoId || null,
          tierYoutubeStart: selectedTierYoutube?.startSec ?? null,
          tierYoutubeEnd: selectedTierYoutube?.endSec ?? null
        })
      });

      const data = await response.json();
      if (!response.ok) {
        if (isOverloadResponse(response, data)) {
          showOverloadNotice('qr');
        } else if (data.errorCode === 'TFP_NOT_CONFIGURED') {
          showProceedError('ระบบเช็คสลิปไม่ทำงานชั่วคราว โปรดรอสักครู่แล้วลองใหม่');
        } else {
          showProceedError('ไม่สามารถสร้าง QR Code ได้ โปรดลองใหม่อีกครั้ง');
        }
        btnProceedPayment.disabled = false;
        btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
        return;
      }

      // Save to localStorage before showing QR step
      savePendingQR(data);

      // Show QR step
      showQRStep(data);
    } catch (error) {
      showProceedError('ไม่สามารถสร้าง QR Code ได้ โปรดลองใหม่อีกครั้ง');
      btnProceedPayment.disabled = false;
      btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
    }
  }
});

// Render QR locally — ห้ามส่ง payload (มีเบอร์พร้อมเพย์/pageToken) ออกไปยัง third-party
function renderQRDataURL(text, sizePx) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const cell = Math.max(3, Math.round(sizePx / (qr.getModuleCount() + 4)));
  return qr.createDataURL(cell, 2);
}

function setQrExpiredVisualState(expired) {
  qrContainer?.classList.toggle('qr-display-expired', expired);
  trueMoneyQrDisplayBox?.classList.toggle('qr-display-expired', expired);
}

function generateQRImage(qrData) {
  if (!qrImage) return;
  setQrExpiredVisualState(false);
  qrLoading.style.display = 'block';
  qrImage.style.display = 'none';

  const qrSlowHint = document.getElementById('qrSlowHint');
  if (qrSlowHint) qrSlowHint.style.display = 'none';

  const slowTimer = setTimeout(() => {
    if (qrSlowHint) qrSlowHint.style.display = 'block';
  }, 8000);

  const btnReloadQR = document.getElementById('btnReloadQR');
  if (btnReloadQR) {
    btnReloadQR.onclick = () => {
      clearTimeout(slowTimer);
      if (qrSlowHint) qrSlowHint.style.display = 'none';
      generateQRImage(qrData);
    };
  }

  qrImage.onload = () => {
    clearTimeout(slowTimer);
    if (qrSlowHint) qrSlowHint.style.display = 'none';
    qrLoading.style.display = 'none';
    qrImage.style.display = 'block';
  };
  qrImage.onerror = () => {
    clearTimeout(slowTimer);
    if (qrSlowHint) qrSlowHint.style.display = 'none';
    const errMsg = document.createElement('p');
    errMsg.textContent = 'ไม่สามารถสร้าง QR Code ได้ กรุณาลองใหม่';
    qrLoading.replaceChildren(errMsg);
    const btnSaveQRErr = document.getElementById('btnSaveQR');
    if (btnSaveQRErr) btnSaveQRErr.style.display = 'none';
  };

  try {
    qrImage.src = renderQRDataURL(qrData, 250);
  } catch (e) {
    qrImage.onerror();
    return;
  }
  if (qrImage.complete) {            // data URI พร้อมทันที
    clearTimeout(slowTimer);
    if (qrSlowHint) qrSlowHint.style.display = 'none';
    qrLoading.style.display = 'none';
    qrImage.style.display = 'block';
  }

  const btnSaveQR = document.getElementById('btnSaveQR');
  if (btnSaveQR) {
    btnSaveQR.href = qrImage.src;
    btnSaveQR.style.display = 'inline-flex';
  }
}

function showQRStep(data) {
  showOnlyPaymentStep(stepQR);
  currentChargeId = data.referenceId;

  updateSlipOkWarning(false);

  generateQRImage(data.qrData);
  displayAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
  if (qrRecipientName) qrRecipientName.textContent = data.recipientName || '-';
  if (qrReference) qrReference.textContent = data.referenceId;
  qrExpiresAt = new Date(data.expiresAt).getTime();

  startCountdown();
  startPromptPayPolling();
  hidePaymentError();
  btnRetryQR.style.display = 'none';
  paymentStatus.style.display = 'none';
}

function restoreQRStep(pending) {
  currentChargeId = pending.referenceId;
  selectedAmount = pending.amount;

  showOnlyPaymentStep(stepQR);

  updateSlipOkWarning(false);

  generateQRImage(pending.qrData);
  displayAmount.textContent = `฿${pending.amount.toLocaleString()}`;
  if (qrRecipientName) qrRecipientName.textContent = pending.recipientName || '-';
  if (qrReference) qrReference.textContent = pending.referenceId;
  qrExpiresAt = new Date(pending.expiresAt).getTime();

  const remaining = Math.max(0, qrExpiresAt - Date.now());
  if (remaining <= 0) {
    showQRExpired();
    return;
  }

  startCountdown();
  startPromptPayPolling();
  hidePaymentError();
  btnRetryQR.style.display = 'none';
  paymentStatus.style.display = 'none';
}

function showQRExpired() {
  stopPolling();
  stopCountdown();
  setQrExpiredVisualState(true);
  if (paymentStatus) {
    paymentStatus.style.display = 'flex';
    paymentStatus.className = 'status expired';
    paymentStatus.innerHTML = '<i class="fa-solid fa-clock"></i> QR Code หมดอายุแล้ว';
  }
  if (btnRetryQR) btnRetryQR.style.display = 'block';
  const btnSaveQR = document.getElementById('btnSaveQR');
  if (btnSaveQR) btnSaveQR.style.display = 'none';
}

function startCountdown() {
  stopCountdown();
  updateCountdown();
  countdownInterval = setInterval(updateCountdown, 1000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function updateCountdown() {
  if (!qrExpiry || !qrExpiresAt) return;
  const remaining = Math.max(0, qrExpiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  if (qrExpiry) qrExpiry.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  // Add urgent class when less than 1 minute remaining
  if (remaining < 60000 && remaining > 0) {
    qrExpiry.classList.add('urgent');
  } else {
    qrExpiry.classList.remove('urgent');
  }

  if (remaining <= 0) {
    showQRExpired();
  }
}

function startPromptPayPolling() {
  pollingStartTime = Date.now();

  pollInterval = setInterval(async () => {
    if (!currentChargeId) return;

    if (qrExpiresAt && Date.now() > qrExpiresAt) {
      stopPolling();
      stopCountdown();
      return;
    }

    try {
      const response = await fetch('/api/verify-promptpay-slip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...getAntiBotPayload(), referenceId: currentChargeId })
      });

      const data = await response.json();

      if (isOverloadResponse(response, data)) {
        showOverloadNotice('paid', true); // keep polling — the guard releases on its own
        return;
      }

      if (data.verified) {
        clearPendingQR();
        stopPolling();
        stopCountdown();
        closeMobileSlipModal();
        if (paymentStatus) {
          paymentStatus.style.display = 'flex';
          paymentStatus.className = 'status success';
          paymentStatus.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#22c55e;"></i> ชำระเงินสำเร็จ!';
        }
        setTimeout(() => {
          window.location.href = `/${window.location.pathname.split('/')[1]}/thank-you`;
        }, 1500);
      } else if (data.expired) {
        stopPolling();
        stopCountdown();
        closeMobileSlipModal();
        if (paymentStatus) {
          paymentStatus.style.display = 'flex';
          paymentStatus.className = 'status expired';
          paymentStatus.innerHTML = '<i class="fa-solid fa-clock"></i> QR Code หมดอายุแล้ว';
        }
        if (btnRetryQR) btnRetryQR.style.display = 'block';
      }
    } catch (error) {
      console.error('PromptPay polling error:', error);
    }
  }, 3000);
}

function showPaymentError(message, isWarning) {
  if (paymentError) {
    paymentError.style.display = 'flex';
    paymentError.classList.toggle('warning', !!isWarning);
  }
  if (paymentErrorMessage) {
    paymentErrorMessage.textContent = message;
  }
}

function hidePaymentError() {
  if (paymentError) {
    paymentError.style.display = 'none';
  }
}

// Proceed-stage error: banner lives on stepPaymentMethod (the step the donor is actually on
// when they click Proceed), so create-qr/charge failures are visible instead of writing into
// a step that only activates on success. Reuse .payment-error (already has transition).
function showProceedError(message) {
  if (proceedError) {
    proceedError.style.display = 'flex';
  }
  if (proceedErrorMessage) {
    proceedErrorMessage.textContent = message;
  }
}

function hideProceedError() {
  if (proceedError) {
    proceedError.style.display = 'none';
  }
}

// ===== Overload notice (HTTP 503 SYSTEM_BUSY from loadShedGuard) =====
const OVERLOAD_BODY = 'ขณะนี้มีผู้ใช้งานจำนวนมากพร้อมกัน เพื่อรักษาเสถียรภาพของระบบ เราขอจำกัดการทำรายการเป็นการชั่วคราว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง ต้องขออภัยในความไม่สะดวกมา ณ ที่นี้';
const OVERLOAD_BODY_PAID = '\n\nหากท่านโอนเงินแล้ว ยอดเงินของท่านไม่สูญหาย — สามารถกดตรวจสอบสลิปอีกครั้งเมื่อระบบกลับสู่ปกติ หรือสตรีมเมอร์สามารถยืนยันรายการให้ได้โดยตรง';

const OVERLOAD_SNOOZE_MS = 60000;
let overloadDismissedAt = 0;

// mode 'paid' = donor already transferred money, so reassure them the amount isn't lost.
// fromPoller = triggered by the background slip poller rather than by the donor. Only
// those respect the snooze — an action the donor just took must always get an answer.
function showOverloadNotice(mode, fromPoller) {
  const overlay = document.getElementById('overloadOverlay');
  if (!overlay || overlay.classList.contains('open')) return; // idempotent — the slip poller hits this every tick
  if (fromPoller && Date.now() - overloadDismissedAt < OVERLOAD_SNOOZE_MS) return;
  const body = document.getElementById('overloadBody');
  if (body) body.textContent = OVERLOAD_BODY + (mode === 'paid' ? OVERLOAD_BODY_PAID : '');
  overlay.classList.add('open');
}

function isOverloadResponse(response, data) {
  return response.status === 503 && data && data.error === 'SYSTEM_BUSY';
}

document.getElementById('overloadRetryBtn')?.addEventListener('click', () => {
  overloadDismissedAt = Date.now();
  document.getElementById('overloadOverlay')?.classList.remove('open');
});

// SlipOK account-issue donor messages (streamer's SlipOK account broken/expired/over-quota,
// not the donor's slip). Non-retryable UX: streamer must fix/renew first. subCode = raw
// SlipOK code (1002/1003/1004/1015) forwarded from backend as slipSubCode.
function getSlipOkAccountIssueMessage(subCode) {
  switch (subCode) {
    case 1002:
      return 'ระบบตรวจสลิปของผู้รับตั้งค่าผิดพลาด — โปรดแจ้งสตรีมเมอร์ให้อัพเดทการเชื่อมต่อ SlipOK ในแดชบอร์ด';
    case 1003:
      return 'ระบบตรวจสลิปของผู้รับหมดอายุ — โปรดแจ้งสตรีมเมอร์ให้ต่ออายุแพ็กเกจใน Line SlipOK แล้วลองใหม่';
    case 1004:
      return 'ระบบตรวจสลิปของผู้รับใช้เกินโควต้าเต็มเพดาน — โปรดแจ้งสตรีมเมอร์ให้ชำระส่วนเกิน/ต่อแพ็กเกจใน Line SlipOK';
    case 1015:
      return 'ระบบตรวจสลิปของผู้รับขัดข้อง — โปรดแจ้งสตรีมเมอร์ตรวจสอบสิทธิ์แพ็กเกจ SlipOK';
    default:
      return 'ระบบตรวจสลิปของผู้รับขัดข้องหรือหมดอายุ — โปรดแจ้งสตรีมเมอร์ให้อัพเดท/ต่ออายุ ระบบตรวจสลิป';
  }
}

// Retry QR button
if (btnRetryQR) {
  btnRetryQR.addEventListener('click', () => {
    clearPendingQR();
    btnRetryQR.style.display = 'none';
    if (paymentStatus) {
      paymentStatus.style.display = 'flex';
      paymentStatus.className = 'status checking';
      paymentStatus.innerHTML = '<div class="spinner-small"></div><span>กำลังสร้าง QR ใหม่...</span>';
    }
    btnProceedPayment.click();
  });
}

// Back button from QR step
if (btnBack) {
  btnBack.addEventListener('click', () => {
    stopPolling();
    stopCountdown();
    markPendingBackedOut(getPendingKey());
    stepQR.classList.remove('active');
    stepPaymentMethod.classList.add('active');
    currentChargeId = null;
  });
}

// ========== Slip Upload System ==========
let slipFile = null;
let trueMoneySlipFile = null;

// PromptPay Slip Upload
const slipFileInput = document.getElementById('slipFileInput');
const slipUploadBtn = document.getElementById('slipUploadBtn');
const slipPreview = document.getElementById('slipPreview');
const slipPreviewImage = document.getElementById('slipPreviewImage');
const btnRemoveSlip = document.getElementById('btnRemoveSlip');
const btnVerifySlip = document.getElementById('btnVerifySlip');

if (slipUploadBtn) {
  // Drag & Drop
  slipUploadBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    slipUploadBtn.classList.add('dragover');
  });

  slipUploadBtn.addEventListener('dragleave', () => {
    slipUploadBtn.classList.remove('dragover');
  });

  slipUploadBtn.addEventListener('drop', (e) => {
    e.preventDefault();
    slipUploadBtn.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) handleSlipFile(files[0]);
  });
}

if (slipFileInput) {
  slipFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleSlipFile(e.target.files[0]);
  });
}

function handleSlipFile(file) {
  if (!file.type.startsWith('image/')) {
    showPaymentError('กรุณาเลือกไฟล์รูปภาพเท่านั้น');
    return;
  }

  slipFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    slipPreviewImage.src = e.target.result;
    slipPreview.style.display = 'block';
    slipUploadBtn.style.display = 'none';
    btnVerifySlip.disabled = false;
  };
  reader.readAsDataURL(file);
}

if (btnRemoveSlip) {
  btnRemoveSlip.addEventListener('click', () => {
    slipFile = null;
    slipFileInput.value = '';
    slipPreview.style.display = 'none';
    slipUploadBtn.style.display = 'flex';
    btnVerifySlip.disabled = true;
    paymentStatus.style.display = 'none';
  });
}

// ========== Mobile Slip Upload (QR handoff) ==========
// promptpay: referenceId มีอยู่แล้วก่อนเข้าหน้านี้ + desktop poll /api/verify-promptpay-slip อยู่แล้ว
//   → modal แสดง "รอการอัพโหลด..." ได้จริง เพราะมีคนรออยู่จริง
// truemoney/bank: ยังไม่มี referenceId ล่วงหน้า (server สร้างเองตอนอัพสลิปจริง) และ desktop
//   ไม่มี polling loop รอผลอยู่เดิม (fire-and-forget) → ต้องบอกตามจริงว่าหน้านี้จะไม่อัปเดตเอง
//   (การบริจาคยังสำเร็จจริงฝั่ง server เหมือนเดิม แค่ tab นี้ไม่รู้)
const btnMobileSlipUpload = document.getElementById('btnMobileSlipUpload');
const btnMobileSlipUploadTrueMoney = document.getElementById('btnMobileSlipUploadTrueMoney');
const btnMobileSlipUploadBank = document.getElementById('btnMobileSlipUploadBank');
const mobileSlipModal = document.getElementById('mobileSlipModal');
const mobileSlipQrImage = document.getElementById('mobileSlipQrImage');
const btnCloseMobileSlipModal = document.getElementById('btnCloseMobileSlipModal');
const mobileSlipModalStatus = document.getElementById('mobileSlipModalStatus');

function openMobileSlipModal(method) {
  if (!mobileSlipModal) return;
  if (method === 'promptpay' && !currentChargeId) return;

  const username = window.location.pathname.split('/')[1];
  let mobileUrl = `${window.location.origin}/mobile-slip/?m=${encodeURIComponent(method)}&amt=${encodeURIComponent(selectedAmount)}&u=${encodeURIComponent(username)}&pt=${encodeURIComponent(pageToken)}`;
  if (currentChargeId) mobileUrl += `&ref=${encodeURIComponent(currentChargeId)}`;

  try {
    mobileSlipQrImage.src = renderQRDataURL(mobileUrl, 200);
  } catch (e) {
    mobileSlipModalStatus.className = 'status expired';
    mobileSlipModalStatus.innerHTML = '<span><i class="fa-solid fa-triangle-exclamation"></i> ไม่สามารถสร้าง QR ได้ กรุณาลองใหม่</span>';
    mobileSlipModal.style.display = 'flex';
    return;
  }

  if (method === 'promptpay') {
    mobileSlipModalStatus.className = 'status checking';
    mobileSlipModalStatus.innerHTML = '<div class="spinner-small"></div><span>รอการอัพโหลดจากมือถือ...</span>';
  } else {
    mobileSlipModalStatus.className = 'status checking';
    mobileSlipModalStatus.innerHTML = '<span><i class="fa-solid fa-circle-info"></i> อัพโหลดจากมือถือได้เลย หน้านี้จะไม่อัปเดตอัตโนมัติ — ปิดหน้าต่างนี้เองได้หลังอัพสลิปเสร็จ</span>';
  }
  mobileSlipModal.style.display = 'flex';
}

function closeMobileSlipModal() {
  if (mobileSlipModal) mobileSlipModal.style.display = 'none';
}

if (btnMobileSlipUpload) btnMobileSlipUpload.addEventListener('click', () => openMobileSlipModal('promptpay'));
if (btnMobileSlipUploadTrueMoney) btnMobileSlipUploadTrueMoney.addEventListener('click', () => openMobileSlipModal('truemoney'));
if (btnMobileSlipUploadBank) btnMobileSlipUploadBank.addEventListener('click', () => openMobileSlipModal('bank'));
if (btnCloseMobileSlipModal) btnCloseMobileSlipModal.addEventListener('click', closeMobileSlipModal);
if (mobileSlipModal) {
  mobileSlipModal.addEventListener('click', (e) => {
    if (e.target === mobileSlipModal) closeMobileSlipModal();
  });
}

if (btnVerifySlip) {
  btnVerifySlip.addEventListener('click', async () => {
    if (!slipFile || !currentChargeId) return;

    btnVerifySlip.disabled = true;
    btnVerifySlip.innerHTML = '<i class="fas fa-spinner fa-spin"></i> กำลังตรวจสอบ...';
    hidePaymentError();

    await doVerifySlip();
  });
}

async function doVerifySlip() {
  if (!slipFile || !currentChargeId) return;

  try {
    const formData = new FormData();
    formData.append('slip', slipFile);
    formData.append('referenceId', currentChargeId);
    formData.append('amount', selectedAmount);
    formData.append('username', window.location.pathname.split('/')[1]);
    formData.append('page_token', pageToken);
    formData.append('contact_email', '');

    const response = await fetch('/api/verify-slip', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (isOverloadResponse(response, data)) {
      showOverloadNotice('paid');
      paymentStatus.style.display = 'none';
      btnVerifySlip.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
      btnVerifySlip.disabled = false;
      return;
    }

    if (data.success) {
      clearPendingQR();
      stopPolling();
      stopCountdown();
      paymentStatus.className = 'status success';
      paymentStatus.innerHTML = '✅ ชำระเงินสำเร็จ!';
      setTimeout(() => {
        window.location.href = `/${window.location.pathname.split('/')[1]}/thank-you`;
      }, 1500);
      return;
    }

    const errorCode = data.errorCode || '';
    if (errorCode === 'QR_EXPIRED') {
      clearPendingQR();
      stopPolling();
      stopCountdown();
      closeMobileSlipModal();
      showQRExpired();
      slipFile = null;
      slipFileInput.value = '';
      slipPreview.style.display = 'none';
      slipUploadBtn.style.display = 'flex';
      btnVerifySlip.disabled = true;
      return;
    }

    const isRetryable = errorCode === 'CONNECTION_FAILED' || errorCode === 'SERVER_ERROR' || errorCode === 'RATE_LIMITED';

    if (errorCode === 'SLIP_DELAY') {
      const delayMin = data.delayMinutes || 5;
      handleSlipDelay(delayMin, btnVerifySlip, paymentStatus, doVerifySlip,
	() => `<i class="fa-solid fa-clock"></i> ${data.error || 'กรุณารอการตรวจสอบ'}`,
		() => '<i class="fa-solid fa-clock"></i> พร้อมตรวจสอบแล้ว — กำลังตรวจใหม่...'
      );
      return;
    }

    if (errorCode === 'SLIP_DUPLICATE' || errorCode === 'ALREADY_VERIFIED') {
      paymentStatus.style.display = 'none';
      showPaymentError(data.error || 'สลิปนี้ถูกใช้แล้ว');
      btnVerifySlip.innerHTML = '<i class="fas fa-check-circle"></i> ตรวจสอบสลิป';
      btnVerifySlip.disabled = false;
      return;
    }

    if (errorCode === 'BANK_UNAVAILABLE') {
      paymentStatus.style.display = 'none';
      showPaymentError('ระบบธนาคารขัดข้องชั่วคราว ทำให้ตรวจสลิปอัตโนมัติไม่ได้\n\nกรุณาแจ้งสตรีมเมอร์ว่าเงินเข้าแล้วแต่ตรวจสลิปไม่ได้ เพื่อให้สตรีมเมอร์กดยืนยันรับด้วยตัวเอง — รายการของคุณถูกบันทึกไว้ในระบบแล้ว\n\n(หรือรอประมาณ 15 นาทีแล้วอัพโหลดสลิปใบเดิมอีกครั้ง)', true);
      btnVerifySlip.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
      btnVerifySlip.disabled = false;
      return;
    }

    if (errorCode === 'SLIPOK_ACCOUNT_ISSUE') {
      paymentStatus.style.display = 'none';
      showPaymentError(getSlipOkAccountIssueMessage(data.slipSubCode), true);
      btnVerifySlip.innerHTML = '<i class="fas fa-check-circle"></i> ตรวจสอบสลิป';
      btnVerifySlip.disabled = false;
      return;
    }

    if (isRetryable) {
      // Connection failure - keep slip preview, show retry button
      paymentStatus.style.display = 'none';
      showPaymentError(`${data.error} — คุณสามารถลองใหม่ได้`);
      btnVerifySlip.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
      btnVerifySlip.disabled = false;
    } else {
      // Slip invalid or mismatch - show error, let user replace slip
      paymentStatus.style.display = 'none';
      showPaymentError(data.error || 'สลิปไม่ถูกต้อง หรือยอดเงินไม่ตรง');
      btnVerifySlip.innerHTML = '<i class="fas fa-check-circle"></i> ตรวจสอบสลิป';
      btnVerifySlip.disabled = false;
    }
  } catch (error) {
    // Network error (can't reach our server) - keep slip, allow retry
    paymentStatus.style.display = 'none';
    showPaymentError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ — กรุณาลองใหม่อีกครั้ง');
    btnVerifySlip.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
    btnVerifySlip.disabled = false;
  }
}

// ========== TrueMoney Wallet Flow ==========
const stepTrueMoney = document.getElementById('step-truemoney');
const btnBackTrueMoney = document.getElementById('btnBackTrueMoney');
const btnVerifyTrueMoney = document.getElementById('btnVerifyTrueMoney');
const trueMoneyAmount = document.getElementById('trueMoneyAmount');
const trueMoneyPhoneDisplay = document.getElementById('trueMoneyPhoneDisplay');
const btnCopyTrueMoneyPhone = document.getElementById('btnCopyTrueMoneyPhone');
const trueMoneySlipFileInput = document.getElementById('trueMoneySlipFileInput');
const trueMoneySlipUploadBtn = document.getElementById('trueMoneySlipUploadBtn');
const trueMoneySlipPreview = document.getElementById('trueMoneySlipPreview');
const trueMoneySlipPreviewImage = document.getElementById('trueMoneySlipPreviewImage');
const btnRemoveTrueMoneySlip = document.getElementById('btnRemoveTrueMoneySlip');
const trueMoneyPaymentStatus = document.getElementById('trueMoneyPaymentStatus');
const trueMoneyPaymentError = document.getElementById('trueMoneyPaymentError');
const trueMoneyPaymentErrorMessage = document.getElementById('trueMoneyPaymentErrorMessage');

// TrueMoney webhook QR elements
const stepTrueMoneyQr = document.getElementById('step-truemoney-qr');
const trueMoneyQrImage = document.getElementById('trueMoneyQrImage');
const trueMoneyQrLoading = document.getElementById('trueMoneyQrLoading');
const trueMoneyQrDisplayBox = document.getElementById('trueMoneyQrDisplayBox');
const trueMoneyQrAmount = document.getElementById('trueMoneyQrAmount');
const trueMoneyQrHint = document.getElementById('trueMoneyQrHint');
const trueMoneyQrExpiry = document.getElementById('trueMoneyQrExpiry');
const trueMoneyQrWaiting = document.getElementById('trueMoneyQrWaiting');
const trueMoneyQrStatus = document.getElementById('trueMoneyQrStatus');
const trueMoneyQrMethodToggle = document.getElementById('trueMoneyQrMethodToggle');
const btnTrueMoneyQrSlipFallback = document.getElementById('btnTrueMoneyQrSlipFallback');
const btnBackTrueMoneyQr = document.getElementById('btnBackTrueMoneyQr');
const btnRetryTrueMoneyQr = document.getElementById('btnRetryTrueMoneyQr');

// TrueMoney ใช้ webhook อย่างเดียว — SlipOK ตรวจสลิป TrueMoney ไม่ได้ จึงปิดทาง fallback อัปโหลดสลิปถาวร
// โค้ด slip/SlipOK ของ TrueMoney ด้านล่างคงไว้ทั้งหมด เผื่อกลับมาใช้ แค่ไม่มีทางเข้าถึงจาก UI
const TRUEMONEY_SLIP_FALLBACK_ENABLED = false;

function setTrueMoneyQrSlipFallbackVisible(visible) {
  if (!btnTrueMoneyQrSlipFallback) return;
  const show = visible && TRUEMONEY_SLIP_FALLBACK_ENABLED;
  btnTrueMoneyQrSlipFallback.classList.toggle('visible', show);
  btnTrueMoneyQrSlipFallback.setAttribute('aria-hidden', String(!show));
  btnTrueMoneyQrSlipFallback.tabIndex = show ? 0 : -1;
}

// Copy phone number button
if (btnCopyTrueMoneyPhone) {
  btnCopyTrueMoneyPhone.addEventListener('click', () => {
    const phone = streamerPaymentMethods.truemoney_phone || '';
    if (!phone) return;
    
    navigator.clipboard.writeText(phone).then(() => {
      btnCopyTrueMoneyPhone.classList.add('copied');
      btnCopyTrueMoneyPhone.innerHTML = '<i class="fas fa-check"></i> คัดลอกแล้ว!';
      setTimeout(() => {
        btnCopyTrueMoneyPhone.classList.remove('copied');
        btnCopyTrueMoneyPhone.innerHTML = '<i class="fas fa-copy"></i> คัดลอก';
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy:', err);
    });
  });
}

if (trueMoneySlipUploadBtn) {
  trueMoneySlipUploadBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    trueMoneySlipUploadBtn.classList.add('dragover');
  });

  trueMoneySlipUploadBtn.addEventListener('dragleave', () => {
    trueMoneySlipUploadBtn.classList.remove('dragover');
  });

  trueMoneySlipUploadBtn.addEventListener('drop', (e) => {
    e.preventDefault();
    trueMoneySlipUploadBtn.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) handleTrueMoneySlipFile(files[0]);
  });
}

if (trueMoneySlipFileInput) {
  trueMoneySlipFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleTrueMoneySlipFile(e.target.files[0]);
  });
}

function handleTrueMoneySlipFile(file) {
  if (!file.type.startsWith('image/')) {
    showTrueMoneyError('กรุณาเลือกไฟล์รูปภาพเท่านั้น');
    return;
  }

  trueMoneySlipFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    trueMoneySlipPreviewImage.src = e.target.result;
    trueMoneySlipPreview.style.display = 'block';
    trueMoneySlipUploadBtn.style.display = 'none';
    btnVerifyTrueMoney.disabled = false;
  };
  reader.readAsDataURL(file);
}

if (btnRemoveTrueMoneySlip) {
  btnRemoveTrueMoneySlip.addEventListener('click', () => {
    trueMoneySlipFile = null;
    trueMoneySlipFileInput.value = '';
    trueMoneySlipPreview.style.display = 'none';
    trueMoneySlipUploadBtn.style.display = 'flex';
    btnVerifyTrueMoney.disabled = true;
  });
}

if (btnVerifyTrueMoney) {
  btnVerifyTrueMoney.addEventListener('click', async () => {
    if (!trueMoneySlipFile || !streamerPaymentMethods.truemoney_phone) return;

    btnVerifyTrueMoney.disabled = true;
    btnVerifyTrueMoney.innerHTML = '<i class="fas fa-spinner fa-spin"></i> กำลังตรวจสอบ...';
    hideTrueMoneyError();

    await doVerifyTrueMoney();
  });
}

async function doVerifyTrueMoney() {
  if (!trueMoneySlipFile || !streamerPaymentMethods.truemoney_phone) return;

  try {
    const formData = new FormData();
    formData.append('slip', trueMoneySlipFile);
    formData.append('phone', streamerPaymentMethods.truemoney_phone);
    formData.append('amount', selectedAmount);
    formData.append('method', 'truemoney');
    formData.append('username', window.location.pathname.split('/')[1]);
    formData.append('page_token', pageToken);
    formData.append('contact_email', '');
    formData.append('name', donorNameInput?.value?.trim() || '');
    formData.append('message', donorMessageInput?.value?.trim() || '');
    formData.append('timerAction', getTimerActionForSubmit() || '');
    formData.append('tierImageUrl', selectedTierImageUrl || '');
    formData.append('tierSoundUrl', selectedTierSoundUrl || '');
    formData.append('tierSoundIsTemp', selectedTierSoundIsTemp ? 'true' : 'false');
    formData.append('tierSoundMode', selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : '');
    formData.append('tierYoutubeId', selectedTierYoutube?.videoId || '');
    formData.append('tierYoutubeStart', selectedTierYoutube ? String(selectedTierYoutube.startSec) : '');
    formData.append('tierYoutubeEnd', selectedTierYoutube ? String(selectedTierYoutube.endSec) : '');
    if (currentChargeId) formData.append('referenceId', currentChargeId);

    const response = await fetch('/api/verify-slip', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (data.referenceId) currentChargeId = data.referenceId;

    if (isOverloadResponse(response, data)) {
      showOverloadNotice('paid');
      trueMoneyPaymentStatus.style.display = 'none';
      btnVerifyTrueMoney.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
      btnVerifyTrueMoney.disabled = false;
      return;
    }

    if (data.success) {
      clearPendingQR();
      clearManualPaymentStep();
      trueMoneyPaymentStatus.className = 'status success';
      trueMoneyPaymentStatus.innerHTML = '✅ ชำระเงินสำเร็จ!';
      setTimeout(() => {
        window.location.href = `/${window.location.pathname.split('/')[1]}/thank-you`;
      }, 1500);
      return;
    }

    const errorCode = data.errorCode || '';
    const isRetryable = errorCode === 'CONNECTION_FAILED' || errorCode === 'SERVER_ERROR';

    if (errorCode === 'SLIP_DELAY') {
      const delayMin = data.delayMinutes || 5;
      handleSlipDelay(delayMin, btnVerifyTrueMoney, trueMoneyPaymentStatus, doVerifyTrueMoney,
	() => `<i class="fa-solid fa-clock"></i> ${data.error || 'กรุณารอการตรวจสอบ'}`,
		() => '<i class="fa-solid fa-clock"></i> พร้อมตรวจสอบแล้ว — กำลังตรวจใหม่...'
      );
      return;
    }

    if (errorCode === 'BANK_UNAVAILABLE') {
      trueMoneyPaymentStatus.style.display = 'none';
      showTrueMoneyError('ระบบธนาคารขัดข้องชั่วคราว ทำให้ตรวจสลิปอัตโนมัติไม่ได้\n\nกรุณาแจ้งสตรีมเมอร์ว่าเงินเข้าแล้วแต่ตรวจสลิปไม่ได้ เพื่อให้สตรีมเมอร์กดยืนยันรับด้วยตัวเอง — รายการของคุณถูกบันทึกไว้ในระบบแล้ว\n\n(หรือรอประมาณ 15 นาทีแล้วอัพโหลดสลิปใบเดิมอีกครั้ง)', true);
      btnVerifyTrueMoney.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
      btnVerifyTrueMoney.disabled = false;
      return;
    }

    if (errorCode === 'SLIPOK_ACCOUNT_ISSUE') {
      trueMoneyPaymentStatus.style.display = 'none';
      showTrueMoneyError(getSlipOkAccountIssueMessage(data.slipSubCode), true);
      btnVerifyTrueMoney.innerHTML = '<i class="fas fa-check-circle"></i> ตรวจสอบสลิป';
      btnVerifyTrueMoney.disabled = false;
      return;
    }

    if (isRetryable) {
      trueMoneyPaymentStatus.style.display = 'none';
      showTrueMoneyError(`${data.error} — คุณสามารถลองใหม่ได้`);
      btnVerifyTrueMoney.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
      btnVerifyTrueMoney.disabled = false;
    } else {
      trueMoneyPaymentStatus.style.display = 'none';
      showTrueMoneyError(data.error || 'สลิปไม่ถูกต้อง หรือยอดเงินไม่ตรง');
      btnVerifyTrueMoney.innerHTML = '<i class="fas fa-check-circle"></i> ตรวจสอบสลิป';
      btnVerifyTrueMoney.disabled = false;
    }
  } catch (error) {
    trueMoneyPaymentStatus.style.display = 'none';
    showTrueMoneyError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ — กรุณาลองใหม่อีกครั้ง');
    btnVerifyTrueMoney.innerHTML = '<i class="fas fa-redo"></i> ลองใหม่อีกครั้ง';
    btnVerifyTrueMoney.disabled = false;
  }
}

// ========== SlipOK Delay Handler (BBL/SCB auto-retry) ==========

function handleSlipDelay(delayMinutes, btnElement, statusElement, retryFn, getStatusText, getReadyText) {
  btnElement.disabled = true;
  const totalSeconds = delayMinutes * 60;
  let remaining = totalSeconds;

  statusElement.style.display = 'flex';
  statusElement.className = 'status checking';

  function updateDelayUI() {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    statusElement.innerHTML = `${getStatusText()} (${m}:${s.toString().padStart(2, '0')})`;
    hidePaymentError();
    hideTrueMoneyError();

    if (remaining <= 0) {
      statusElement.innerHTML = getReadyText();
      btnElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> กำลังตรวจใหม่...';
      setTimeout(() => retryFn(), 500);
      return;
    }
    remaining--;
    setTimeout(updateDelayUI, 1000);
  }

  updateDelayUI();
}

function showTrueMoneyError(message, isWarning) {
  if (trueMoneyPaymentError) {
    trueMoneyPaymentError.style.display = 'flex';
    trueMoneyPaymentError.classList.toggle('warning', !!isWarning);
  }
  if (trueMoneyPaymentErrorMessage) trueMoneyPaymentErrorMessage.textContent = message;
}

function hideTrueMoneyError() {
  if (trueMoneyPaymentError) trueMoneyPaymentError.style.display = 'none';
}

if (btnBackTrueMoney) {
  btnBackTrueMoney.addEventListener('click', () => {
    clearManualPaymentStep();
    stepTrueMoney.classList.remove('active');
    stepPaymentMethod.classList.add('active');
    trueMoneySlipFile = null;
    trueMoneySlipFileInput.value = '';
    trueMoneySlipPreview.style.display = 'none';
    trueMoneySlipUploadBtn.style.display = 'flex';
    btnVerifyTrueMoney.disabled = true;
    trueMoneyPaymentStatus.style.display = 'none';
    hideTrueMoneyError();
  });
}

// ========== Bank Transfer Flow ==========
const stepBank = document.getElementById('step-bank');
const btnBackBank = document.getElementById('btnBackBank');
const btnVerifyBank = document.getElementById('btnVerifyBank');
const bankAmount = document.getElementById('bankAmount');
const bankNameDisplay = document.getElementById('bankNameDisplay');
const BANK_FULL_NAMES = {
  kbank: 'กสิกรไทย', scb: 'ไทยพาณิชย์', krungthai: 'กรุงไทย', bbl: 'กรุงเทพ',
  ttb: 'ทีเอ็มบีธนชาต', bay: 'กรุงศรีอยุธยา', cimb: 'ซีไอเอ็มบี ไทย', lhbank: 'แลนด์ แอนด์ เฮ้าส์',
  uob: 'ยูโอบี', tcrb: 'ไทยเครดิตเพื่อรายย่อย', gsb: 'ออมสิน', baac: 'ธ.ก.ส.',
  citibank: 'ซิตี้แบงก์', sc: 'สแตนดาร์ดชาร์เตอร์ด', kkp: 'เกียรตินาคินภัทร', ghb: 'อาคารสงเคราะห์',
  tisco: 'ทิสโก้', ibank: 'อิสลามแห่งประเทศไทย'
};
function formatBankName(code) {
  if (!code) return '';
  const full = BANK_FULL_NAMES[code.toLowerCase()];
  return full ? `${full} (${code.toUpperCase()})` : code;
}
const bankAccountNumberDisplay = document.getElementById('bankAccountNumberDisplay');
const bankAccountNameDisplay = document.getElementById('bankAccountNameDisplay');
const bankSlipFileInput = document.getElementById('bankSlipFileInput');
const bankSlipUploadBtn = document.getElementById('bankSlipUploadBtn');
const bankSlipPreview = document.getElementById('bankSlipPreview');
const bankSlipPreviewImage = document.getElementById('bankSlipPreviewImage');
const btnRemoveBankSlip = document.getElementById('btnRemoveBankSlip');
const btnCopyBankAccount = document.getElementById('btnCopyBankAccount');
const bankPaymentStatus = document.getElementById('bankPaymentStatus');
const bankPaymentError = document.getElementById('bankPaymentError');
const bankPaymentErrorMessage = document.getElementById('bankPaymentErrorMessage');
let bankSlipFile = null;

if (btnCopyBankAccount) {
  btnCopyBankAccount.addEventListener('click', () => {
    const account = streamerPaymentMethods.bank_account_number || '';
    if (!account) return;
    navigator.clipboard.writeText(account).then(() => {
      btnCopyBankAccount.classList.add('copied');
      btnCopyBankAccount.textContent = 'คัดลอกแล้ว!';
      setTimeout(() => {
        btnCopyBankAccount.classList.remove('copied');
        btnCopyBankAccount.innerHTML = '<i class="fas fa-copy"></i> คัดลอก';
      }, 2000);
    }).catch(() => {});
  });
}

if (bankSlipUploadBtn) {
  bankSlipUploadBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    bankSlipUploadBtn.classList.add('dragover');
  });
  bankSlipUploadBtn.addEventListener('dragleave', () => {
    bankSlipUploadBtn.classList.remove('dragover');
  });
  bankSlipUploadBtn.addEventListener('drop', (e) => {
    e.preventDefault();
    bankSlipUploadBtn.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) handleBankSlipFile(files[0]);
  });
}

if (bankSlipFileInput) {
  bankSlipFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleBankSlipFile(e.target.files[0]);
  });
}

function handleBankSlipFile(file) {
  if (!file.type.startsWith('image/')) {
    showBankError('กรุณาเลือกไฟล์รูปภาพเท่านั้น');
    return;
  }
  bankSlipFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    bankSlipPreviewImage.src = e.target.result;
    bankSlipPreview.style.display = 'block';
    bankSlipUploadBtn.style.display = 'none';
    btnVerifyBank.disabled = false;
  };
  reader.readAsDataURL(file);
}

if (btnRemoveBankSlip) {
  btnRemoveBankSlip.addEventListener('click', () => {
    bankSlipFile = null;
    bankSlipFileInput.value = '';
    bankSlipPreview.style.display = 'none';
    bankSlipUploadBtn.style.display = 'flex';
    btnVerifyBank.disabled = true;
  });
}

if (btnVerifyBank) {
  btnVerifyBank.addEventListener('click', async () => {
    if (!bankSlipFile) return;
    btnVerifyBank.disabled = true;
    btnVerifyBank.innerHTML = '<i class="fas fa-spinner fa-spin"></i> กำลังตรวจสอบ...';
    hideBankError();
    await doVerifyBank();
  });
}

async function doVerifyBank() {
  if (!bankSlipFile) return;
  try {
    const formData = new FormData();
    formData.append('slip', bankSlipFile);
    formData.append('amount', selectedAmount);
    formData.append('method', 'bank');
    formData.append('username', window.location.pathname.split('/')[1]);
    formData.append('page_token', pageToken);
    formData.append('contact_email', '');
    formData.append('name', donorNameInput?.value?.trim() || '');
    formData.append('message', donorMessageInput?.value?.trim() || '');
    formData.append('timerAction', getTimerActionForSubmit() || '');
    formData.append('tierImageUrl', selectedTierImageUrl || '');
    formData.append('tierSoundUrl', selectedTierSoundUrl || '');
    formData.append('tierSoundIsTemp', selectedTierSoundIsTemp ? 'true' : 'false');
    formData.append('tierSoundMode', selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : '');
    formData.append('tierYoutubeId', selectedTierYoutube?.videoId || '');
    formData.append('tierYoutubeStart', selectedTierYoutube ? String(selectedTierYoutube.startSec) : '');
    formData.append('tierYoutubeEnd', selectedTierYoutube ? String(selectedTierYoutube.endSec) : '');
    if (currentChargeId) formData.append('referenceId', currentChargeId);

    bankPaymentStatus.style.display = 'flex';
    bankPaymentStatus.className = 'status checking';

    const response = await fetch('/api/verify-slip', { method: 'POST', body: formData });
    const data = await response.json();
    if (data.referenceId) currentChargeId = data.referenceId;

    if (isOverloadResponse(response, data)) {
      showOverloadNotice('paid');
      bankPaymentStatus.style.display = 'none';
      btnVerifyBank.textContent = 'ลองใหม่อีกครั้ง';
      btnVerifyBank.disabled = false;
      return;
    }

    if (data.success) {
      clearPendingQR();
      clearManualPaymentStep();
      bankPaymentStatus.className = 'status success';
      bankPaymentStatus.querySelector('span').textContent = '✅ ชำระเงินสำเร็จ!';
      setTimeout(() => {
        window.location.href = `/${window.location.pathname.split('/')[1]}/thank-you`;
      }, 1500);
      return;
    }

    const errorCode = data.errorCode || '';
    const isRetryable = errorCode === 'CONNECTION_FAILED' || errorCode === 'SERVER_ERROR';

    if (errorCode === 'SLIP_DELAY') {
      const delayMin = data.delayMinutes || 5;
      handleSlipDelay(delayMin, btnVerifyBank, bankPaymentStatus, doVerifyBank,
        () => '<i class="fa-solid fa-clock"></i> กรุณารอการตรวจสอบ',
        () => '<i class="fa-solid fa-clock"></i> พร้อมตรวจสอบแล้ว — กำลังตรวจใหม่...'
      );
      return;
    }

    if (errorCode === 'BANK_UNAVAILABLE') {
      bankPaymentStatus.style.display = 'none';
      showBankError('ระบบธนาคารขัดข้องชั่วคราว ทำให้ตรวจสลิปอัตโนมัติไม่ได้\n\nกรุณาแจ้งสตรีมเมอร์ว่าเงินเข้าแล้วแต่ตรวจสลิปไม่ได้ เพื่อให้สตรีมเมอร์กดยืนยันรับด้วยตัวเอง — รายการของคุณถูกบันทึกไว้ในระบบแล้ว\n\n(หรือรอประมาณ 15 นาทีแล้วอัพโหลดสลิปใบเดิมอีกครั้ง)', true);
      btnVerifyBank.textContent = 'ลองใหม่อีกครั้ง';
      btnVerifyBank.disabled = false;
      return;
    }

    if (errorCode === 'SLIPOK_ACCOUNT_ISSUE') {
      bankPaymentStatus.style.display = 'none';
      showBankError(getSlipOkAccountIssueMessage(data.slipSubCode), true);
      btnVerifyBank.innerHTML = '<i class="fas fa-check-circle"></i> ตรวจสอบสลิป';
      btnVerifyBank.disabled = false;
      return;
    }

    bankPaymentStatus.style.display = 'none';
    const errText = typeof data.error === 'string' ? data.error : 'สลิปไม่ถูกต้อง หรือยอดเงินไม่ตรง';
    if (isRetryable) {
      showBankError(`${errText} — คุณสามารถลองใหม่ได้`);
      btnVerifyBank.textContent = 'ลองใหม่อีกครั้ง';
      btnVerifyBank.disabled = false;
    } else {
      showBankError(errText);
      btnVerifyBank.textContent = 'ตรวจสอบสลิป';
      btnVerifyBank.disabled = false;
    }
  } catch (error) {
    bankPaymentStatus.style.display = 'none';
    showBankError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ — กรุณาลองใหม่อีกครั้ง');
    btnVerifyBank.textContent = 'ลองใหม่อีกครั้ง';
    btnVerifyBank.disabled = false;
  }
}

function showBankError(message, isWarning) {
  if (bankPaymentError) {
    bankPaymentError.style.display = 'flex';
    bankPaymentError.classList.toggle('warning', !!isWarning);
  }
  if (bankPaymentErrorMessage) bankPaymentErrorMessage.textContent = message;
}

function hideBankError() {
  if (bankPaymentError) bankPaymentError.style.display = 'none';
}

if (btnBackBank) {
  btnBackBank.addEventListener('click', () => {
    clearManualPaymentStep();
    stepBank.classList.remove('active');
    stepPaymentMethod.classList.add('active');
    bankSlipFile = null;
    bankSlipFileInput.value = '';
    bankSlipPreview.style.display = 'none';
    bankSlipUploadBtn.style.display = 'flex';
    btnVerifyBank.disabled = true;
    bankPaymentStatus.style.display = 'none';
    hideBankError();
  });
}

// TrueMoney webhook QR method toggle
if (trueMoneyQrMethodToggle) {
  trueMoneyQrMethodToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.qr-method-btn');
    if (!btn) return;
    const nextMethod = btn.dataset.method || 'P2P';
    if (nextMethod === trueMoneyQrMethod) return;
    trueMoneyQrMethodToggle.querySelectorAll('.qr-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    trueMoneyQrMethod = nextMethod;
    void createTrueMoneyQR();
  });
}

function normalizeTrueMoneyQrMethod(method) {
  return TRUEMONEY_QR_METHODS.includes(method) ? method : 'P2P';
}

function getTrueMoneyQrRequestKey(method = trueMoneyQrMethod) {
  return JSON.stringify({
    method: normalizeTrueMoneyQrMethod(method),
    amount: selectedAmount,
    donorName: donorNameInput?.value?.trim() || '',
    message: donorMessageInput?.value?.trim() || '',
    timerAction: getTimerActionForSubmit() ?? null,
    tierImageUrl: selectedTierImageUrl || null,
    tierSoundUrl: selectedTierSoundUrl || null,
    tierSoundIsTemp: !!selectedTierSoundIsTemp,
    tierSoundMode: selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : null,
    tierYoutubeId: selectedTierYoutube?.videoId || null,
    tierYoutubeStart: selectedTierYoutube?.startSec ?? null,
    tierYoutubeEnd: selectedTierYoutube?.endSec ?? null
  });
}

function getTrueMoneyPendingKey(method = trueMoneyQrMethod) {
  const username = window.location.pathname.split('/')[1];
  const normalizedMethod = normalizeTrueMoneyQrMethod(method);
  return username ? `truemoney_webhook_pending_${username}_${normalizedMethod}` : `truemoney_webhook_pending_${normalizedMethod}`;
}

function getTrueMoneyQrActiveKey() {
  const username = window.location.pathname.split('/')[1];
  return username ? `truemoney_webhook_pending_active_${username}` : 'truemoney_webhook_pending_active';
}

function setTrueMoneyQrActiveMethod(method) {
  writePendingState(getTrueMoneyQrActiveKey(), { method: normalizeTrueMoneyQrMethod(method) });
}

function getTrueMoneyQrActiveMethod() {
  const method = readPendingState(getTrueMoneyQrActiveKey())?.method;
  return TRUEMONEY_QR_METHODS.includes(method) ? method : null;
}

function saveTrueMoneyPendingQR(data) {
  clearManualPaymentStep();
  clearPendingQR();
  const method = normalizeTrueMoneyQrMethod(data.method);
  const pending = {
    referenceId: data.referenceId,
    qrData: data.qrData,
    amount: selectedAmount,
    donorName: donorNameInput?.value?.trim() || '',
    message: donorMessageInput?.value?.trim() || '',
    expiresAt: data.expiresAt,
    method,
    displayAmount: data.displayAmount ?? selectedAmount,
    timerAction: getTimerActionForSubmit()
  };
  writePendingState(getTrueMoneyPendingKey(method), pending);
  setTrueMoneyQrActiveMethod(method);
}

function getTrueMoneyPendingQR(includeExpired = false, method = trueMoneyQrMethod) {
  const pending = readPendingState(getTrueMoneyPendingKey(method));
  if (!pending || !pending.referenceId || !pending.qrData || !pending.expiresAt) return null;
  const expiresAt = new Date(pending.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  if (!includeExpired && Date.now() >= expiresAt) return null;
  return pending;
}

function clearTrueMoneyPendingQR(method) {
  const methods = method ? [normalizeTrueMoneyQrMethod(method)] : TRUEMONEY_QR_METHODS;
  methods.forEach(currentMethod => clearPendingState(getTrueMoneyPendingKey(currentMethod)));

  const activeMethod = getTrueMoneyQrActiveMethod();
  if (!method || activeMethod === normalizeTrueMoneyQrMethod(method)) {
    clearPendingState(getTrueMoneyQrActiveKey());
  }
}

function getTrueMoneyPendingRestoreCandidate() {
  const activeMethod = getTrueMoneyQrActiveMethod();
  const methods = activeMethod
    ? [activeMethod, ...TRUEMONEY_QR_METHODS.filter(method => method !== activeMethod)]
    : TRUEMONEY_QR_METHODS;

  for (const method of methods) {
    const pending = getTrueMoneyPendingQR(true, method);
    if (pending && isPendingRestorable(pending)) return pending;
    if (pending && !pending.backedOutAt) clearTrueMoneyPendingQR(method);
  }
  return null;
}

function generateTrueMoneyQRImage(qrData) {
  if (!trueMoneyQrImage) return;
  setQrExpiredVisualState(false);
  trueMoneyQrLoading.style.display = 'block';
  trueMoneyQrImage.style.display = 'none';

  trueMoneyQrImage.onload = () => {
    trueMoneyQrLoading.style.display = 'none';
    trueMoneyQrImage.style.display = 'block';
  };
  trueMoneyQrImage.onerror = () => {
    trueMoneyQrLoading.innerHTML = '<p>ไม่สามารถสร้าง QR Code ได้ กรุณาลองใหม่</p>';
    const btnSaveQRTrueMoneyErr = document.getElementById('btnSaveQRTrueMoney');
    if (btnSaveQRTrueMoneyErr) btnSaveQRTrueMoneyErr.style.display = 'none';
  };

  try {
    trueMoneyQrImage.src = renderQRDataURL(qrData, 250);
  } catch (e) {
    trueMoneyQrImage.onerror();
    return;
  }
  if (trueMoneyQrImage.complete) {   // data URI พร้อมทันที
    trueMoneyQrLoading.style.display = 'none';
    trueMoneyQrImage.style.display = 'block';
  }

  const btnSaveQRTrueMoney = document.getElementById('btnSaveQRTrueMoney');
  if (btnSaveQRTrueMoney) {
    btnSaveQRTrueMoney.href = trueMoneyQrImage.src;
    btnSaveQRTrueMoney.style.display = 'inline-flex';
  }
}

function stopTrueMoneyQr() {
  trueMoneyStatusStopped = true; // QR expired / confirmed / replaced — stop reconnecting
  if (trueMoneyStatusRetryTimer) {
    clearTimeout(trueMoneyStatusRetryTimer);
    trueMoneyStatusRetryTimer = null;
  }
  if (trueMoneyQrSource) {
    trueMoneyQrSource.close();
    trueMoneyQrSource = null;
  }
  if (trueMoneyQrFallbackTimer) {
    clearTimeout(trueMoneyQrFallbackTimer);
    trueMoneyQrFallbackTimer = null;
  }
  if (trueMoneyQrCountdownInterval) {
    clearInterval(trueMoneyQrCountdownInterval);
    trueMoneyQrCountdownInterval = null;
  }
}

function setTrueMoneyQrWaitingError(message) {
  if (!trueMoneyQrWaiting) return;
  trueMoneyQrWaiting.className = 'qr-waiting-indicator expired';
  trueMoneyQrWaiting.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i>';
  const span = document.createElement('span');
  span.textContent = message || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
  trueMoneyQrWaiting.appendChild(span);
}

function updateTrueMoneyQrCountdown() {
  if (!trueMoneyQrExpiresAt || !trueMoneyQrExpiry) return;
  const remaining = Math.max(0, trueMoneyQrExpiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  trueMoneyQrExpiry.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  if (remaining < 60000 && remaining > 0) trueMoneyQrExpiry.classList.add('urgent');
  else trueMoneyQrExpiry.classList.remove('urgent');
  if (remaining <= 0) {
    stopTrueMoneyQr();
    setQrExpiredVisualState(true);
    if (trueMoneyQrWaiting) {
      trueMoneyQrWaiting.className = 'qr-waiting-indicator expired';
      trueMoneyQrWaiting.innerHTML = '<i class="fa-solid fa-clock" style="color:#ef4444;"></i><span>QR หมดอายุแล้ว กดสร้าง QR ใหม่เพื่อบริจาคต่อ</span>';
    }
    const btnSaveQRTrueMoney = document.getElementById('btnSaveQRTrueMoney');
    if (btnSaveQRTrueMoney) btnSaveQRTrueMoney.style.display = 'none';
    setTrueMoneyQrSlipFallbackVisible(true);
    if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'block';
  }
}

function startTrueMoneyQrCountdown(expiresAt) {
  if (trueMoneyQrCountdownInterval) {
    clearInterval(trueMoneyQrCountdownInterval);
    trueMoneyQrCountdownInterval = null;
  }
  trueMoneyQrExpiresAt = new Date(expiresAt).getTime();
  updateTrueMoneyQrCountdown();
  if (trueMoneyQrExpiresAt > Date.now()) {
    trueMoneyQrCountdownInterval = setInterval(updateTrueMoneyQrCountdown, 1000);
  }
}

function handleTrueMoneyConfirmed() {
  stopTrueMoneyQr();
  if (trueMoneyQrWaiting) {
    trueMoneyQrWaiting.className = 'qr-waiting-indicator confirmed';
    trueMoneyQrWaiting.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#22c55e;"></i><span>ได้รับเงินบริจาคแล้ว! ขอบคุณมากครับ</span>';
  }
  clearTrueMoneyPendingQR();
  setTimeout(() => {
    window.location.href = `/${window.location.pathname.split('/')[1]}/thank-you`;
  }, 1500);
}

function startTrueMoneyStatusStream(refId) {
  stopTrueMoneyQr();
  if (!refId) return;
  trueMoneyStatusStopped = false;
  trueMoneyStatusRetryDelay = 3000;
  connectTrueMoneyStatusStream(refId);
}

function connectTrueMoneyStatusStream(refId) {
  if (trueMoneyStatusStopped) return;
  trueMoneyQrSource = new EventSource(`/api/donate/status/stream?ref=${encodeURIComponent(refId)}`);
  trueMoneyQrSource.onopen = () => { trueMoneyStatusRetryDelay = 3000; };
  trueMoneyQrSource.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'donate_status' && data.status === 'confirmed') {
        handleTrueMoneyConfirmed();
      }
    } catch (_) {}
  };
  // A 503 (load shedding) makes EventSource give up for good, so reconnect by hand.
  // Backoff starts at 3s — donate pages open in bulk, and faster retries would only
  // deepen the overload we are backing off from.
  trueMoneyQrSource.onerror = () => {
    if (trueMoneyQrSource) {
      trueMoneyQrSource.close();
      trueMoneyQrSource = null;
    }
    if (trueMoneyStatusStopped) return;
    clearTimeout(trueMoneyStatusRetryTimer);
    trueMoneyStatusRetryTimer = setTimeout(() => resyncTrueMoneyStatus(refId), trueMoneyStatusRetryDelay);
    trueMoneyStatusRetryDelay = Math.min(trueMoneyStatusRetryDelay * 1.5, 30000);
  };
}

// While the stream was down the payment may already have been confirmed (webhook fired,
// or the phone was locked). Check the transaction once before re-opening the stream
// instead of waiting for an event that has already been missed.
async function resyncTrueMoneyStatus(refId) {
  if (trueMoneyStatusStopped) return;
  try {
    const response = await fetch('/api/verify-promptpay-slip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...getAntiBotPayload(), referenceId: refId })
    });
    const data = await response.json();
    if (data.verified) {
      handleTrueMoneyConfirmed();
      return;
    }
  } catch (_) { /* offline or still shedding — just reconnect */ }
  connectTrueMoneyStatusStream(refId);
}

// createTrueMoneyQR() ถูกเรียกได้จาก 2 ที่: ปุ่ม "ดำเนินการต่อ" (ยังอยู่ step เลือกวิธีจ่าย) และ
// ปุ่ม toggle/ลองใหม่ (อยู่ step QR แล้ว) — #proceedError อยู่บน step แรกเท่านั้น ถ้าพังตอนอยู่ step QR
// จะไม่เห็นข้อความอะไรเลยและ spinner ค้าง (Audit R5-A3) จึงต้องเลือกที่แสดง error ตาม step ที่ active
function showTrueMoneyQrError(message) {
  if (trueMoneyQrLoading) trueMoneyQrLoading.style.display = 'none';
  if (!trueMoneyQrStatus || !stepTrueMoneyQr?.classList.contains('active')) {
    showProceedError(message);
    return;
  }
  trueMoneyQrStatus.className = 'status expired';
  trueMoneyQrStatus.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i><span></span>';
  trueMoneyQrStatus.querySelector('span').textContent = message;
  trueMoneyQrStatus.style.display = 'flex';
}

async function createTrueMoneyQR() {
  const requestId = ++trueMoneyQrRequestSeq;
  const requestedMethod = trueMoneyQrMethod;
  const username = window.location.pathname.split('/')[1];
  if (!username) return;

  // Check cached pending first
  const pending = getTrueMoneyPendingQR(false, requestedMethod);
  const currentDonorName = donorNameInput?.value?.trim() || '';
  const currentMessage = donorMessageInput?.value?.trim() || '';
  const currentTimerAction = getTimerActionForSubmit() ?? null;
  if (pending && pending.amount === selectedAmount && pending.donorName === currentDonorName && pending.message === currentMessage && (pending.timerAction ?? null) === currentTimerAction && pending.method === requestedMethod) {
    showTrueMoneyQrStep(pending);
    return;
  }

  const requestKey = getTrueMoneyQrRequestKey(requestedMethod);
  const inFlight = trueMoneyQrInFlight.get(requestKey);
  let requestPromise = inFlight;
  if (!requestPromise) {
    clearTrueMoneyPendingQR(requestedMethod);

    if (trueMoneyQrLoading) trueMoneyQrLoading.style.display = 'block';
    if (trueMoneyQrImage) trueMoneyQrImage.style.display = 'none';
    if (trueMoneyQrStatus) trueMoneyQrStatus.style.display = 'none';

    requestPromise = fetch('/api/truemoney/create-qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...getAntiBotPayload(),
        username,
        amount: selectedAmount,
        name: donorNameInput.value,
        message: donorMessageInput.value,
        timerAction: getTimerActionForSubmit(),
        method: requestedMethod,
        tierImageUrl: selectedTierImageUrl || null,
        tierSoundUrl: selectedTierSoundUrl || null,
        tierSoundIsTemp: selectedTierSoundIsTemp || false,
        tierSoundMode: selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : null,
        tierYoutubeId: selectedTierYoutube?.videoId || null,
        tierYoutubeStart: selectedTierYoutube?.startSec ?? null,
        tierYoutubeEnd: selectedTierYoutube?.endSec ?? null
      })
    }).then(async response => ({ response, data: await response.json() }));
    trueMoneyQrInFlight.set(requestKey, requestPromise);
  }

  try {
    const { response, data } = await requestPromise;
    if (!isCurrentTrueMoneyQrRequest(requestId, requestedMethod)) return;
    if (isOverloadResponse(response, data)) {
      showOverloadNotice('qr');
      // Two callers: the proceed button (still on the payment-method step) and
      // btnRetryTrueMoneyQr (on the QR step, which hides itself before calling).
      // Restore both, otherwise whichever path was used has no way back.
      if (trueMoneyQrLoading) trueMoneyQrLoading.style.display = 'none';
      if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'block';
      btnProceedPayment.disabled = false;
      btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
      return;
    }
    if (!response.ok) {
      showTrueMoneyQrError(response.status === 409
        ? (data.error || 'ยอดนี้มีรายการรอชำระอยู่แล้ว กรุณาเลือกยอดอื่น')
        : 'ไม่สามารถสร้าง QR ได้ โปรดลองใหม่อีกครั้ง');
      if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'block';
      return;
    }

    saveTrueMoneyPendingQR(data);
    showTrueMoneyQrStep(data);
  } catch (error) {
    if (!isCurrentTrueMoneyQrRequest(requestId, requestedMethod)) return;
    showTrueMoneyQrError('เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง');
    if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'block';
  } finally {
    if (trueMoneyQrInFlight.get(requestKey) === requestPromise) trueMoneyQrInFlight.delete(requestKey);
  }
}

function showTrueMoneyQrStep(data) {
  trueMoneyQrMethod = normalizeTrueMoneyQrMethod(data.method);
  setTrueMoneyQrActiveMethod(trueMoneyQrMethod);
  showOnlyPaymentStep(stepTrueMoneyQr);
  trueMoneyQrRefId = data.referenceId;
  // มี QR ขึ้นแล้ว = error เก่าหมดความหมาย (สลับกลับมาเจอ cache ก็ผ่านทางนี้)
  if (trueMoneyQrStatus) trueMoneyQrStatus.style.display = 'none';

  generateTrueMoneyQRImage(data.qrData);
  if (trueMoneyQrAmount) {
    const displayAmount = data.displayAmount != null ? data.displayAmount : data.amount;
    trueMoneyQrAmount.textContent = `฿${Number(displayAmount).toLocaleString('th-TH', { minimumFractionDigits: displayAmount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  if (trueMoneyQrHint) {
    trueMoneyQrHint.textContent = data.method === 'PROMPTPAY_IN'
      ? 'สแกนด้วยแอปธนาคาร/พร้อมเพย์ แล้วโอนตามยอดนี้เป๊ะ ๆ'
      : 'สแกนด้วยแอป TrueMoney แล้วโอนตามยอดนี้เป๊ะ ๆ';
  }
  const providerBadge = document.getElementById('trueMoneyQrProvider');
  if (providerBadge) providerBadge.style.display = (data.method === 'PROMPTPAY_IN') ? 'flex' : 'none';
  if (trueMoneyQrWaiting) {
    trueMoneyQrWaiting.className = 'qr-waiting-indicator';
    trueMoneyQrWaiting.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="color:#3b82f6;"></i><span>รอการยืนยันอัตโนมัติ... โอนแล้วระบบจะขึ้นสำเร็จเองใน 1 นาที</span>';
  }
  setTrueMoneyQrSlipFallbackVisible(false);
  if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'none';

  startTrueMoneyStatusStream(data.referenceId);
  startTrueMoneyQrCountdown(data.expiresAt);

  trueMoneyQrFallbackTimer = setTimeout(() => {
    if (btnTrueMoneyQrSlipFallback) {
      setTrueMoneyQrSlipFallbackVisible(true);
    }
  }, 90000);
}

// Post-click pulse ring — ปุ่มที่กดแล้วไม่เปลี่ยนหน้า (select/control) เท่านั้น
// ref: .timer-control-buttons pulse ใน dashboard.js — delegate เพราะ .tier-image-choice ถูกสร้างด้วย JS
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.amount-btn, .tier-image-choice, .tier-subtab-btn, .tier-eq-btn, #tierRecordBtn, #trueMoneyQrMethodToggle .qr-method-btn');
  if (!btn) return;
  btn.classList.remove('tk-btn-pulse');
  void btn.offsetWidth;
  btn.classList.add('tk-btn-pulse');
});

function restoreTrueMoneyQrStep(pending) {
  trueMoneyQrRefId = pending.referenceId;
  selectedAmount = pending.amount;
  trueMoneyQrMethod = normalizeTrueMoneyQrMethod(pending.method);
  setTrueMoneyQrActiveMethod(trueMoneyQrMethod);
  if (trueMoneyQrMethodToggle) {
    trueMoneyQrMethodToggle.querySelectorAll('.qr-method-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.method === trueMoneyQrMethod);
    });
  }
  showOnlyPaymentStep(stepTrueMoneyQr);
  generateTrueMoneyQRImage(pending.qrData);
  if (trueMoneyQrAmount) {
    const displayAmount = Number(pending.displayAmount || pending.amount);
    trueMoneyQrAmount.textContent = `฿${displayAmount.toLocaleString('th-TH', { minimumFractionDigits: displayAmount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  if (trueMoneyQrHint) {
    trueMoneyQrHint.textContent = trueMoneyQrMethod === 'PROMPTPAY_IN'
      ? 'สแกนด้วยแอปธนาคาร/พร้อมเพย์ แล้วโอนตามยอดนี้เป๊ะ ๆ'
      : 'สแกนด้วยแอป TrueMoney แล้วโอนตามยอดนี้เป๊ะ ๆ';
  }
  const providerBadge = document.getElementById('trueMoneyQrProvider');
  if (providerBadge) providerBadge.style.display = trueMoneyQrMethod === 'PROMPTPAY_IN' ? 'flex' : 'none';
  if (trueMoneyQrWaiting) {
    trueMoneyQrWaiting.className = 'qr-waiting-indicator';
    trueMoneyQrWaiting.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="color:#3b82f6;"></i><span>รอการยืนยันอัตโนมัติ... โอนแล้วระบบจะขึ้นสำเร็จเองใน 1 นาที</span>';
  }
  if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'none';
  if (new Date(pending.expiresAt).getTime() > Date.now()) {
    startTrueMoneyStatusStream(pending.referenceId);
  }
  startTrueMoneyQrCountdown(pending.expiresAt);

  // Show fallback button if 90s window already elapsed
  const expiresMs = new Date(pending.expiresAt).getTime();
  const createdMs = expiresMs - 30 * 60 * 1000;
  const elapsed = Date.now() - createdMs;
  if (elapsed >= 90000) {
    setTrueMoneyQrSlipFallbackVisible(true);
  } else {
    trueMoneyQrFallbackTimer = setTimeout(() => {
      setTrueMoneyQrSlipFallbackVisible(true);
    }, 90000 - elapsed);
  }
}

if (btnBackTrueMoneyQr) {
  btnBackTrueMoneyQr.addEventListener('click', () => {
    stopTrueMoneyQr();
    markPendingBackedOut(getTrueMoneyPendingKey());
    stepTrueMoneyQr.classList.remove('active');
    stepPaymentMethod.classList.add('active');
    if (btnProceedPayment) {
      btnProceedPayment.disabled = false;
      btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
    }
  });
}

if (btnTrueMoneyQrSlipFallback) {
  btnTrueMoneyQrSlipFallback.addEventListener('click', async () => {
    stopTrueMoneyQr();
    clearTrueMoneyPendingQR();
    showOnlyPaymentStep(stepTrueMoney);
    saveManualPaymentStep('truemoney');
    applyManualPaymentDetails('truemoney');
    await ensureStreamerPaymentMethodsLoaded();
    if (stepTrueMoney?.classList.contains('active')) applyManualPaymentDetails('truemoney');
  });
}

if (btnRetryTrueMoneyQr) {
  btnRetryTrueMoneyQr.addEventListener('click', () => {
    clearTrueMoneyPendingQR();
    if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'none';
    createTrueMoneyQR();
  });
}

// Override btnProceedPayment to handle TrueMoney & Bank
const originalProceedHandler = btnProceedPayment.onclick;
btnProceedPayment.addEventListener('click', async (e) => {
  if (selectedPaymentMethod === 'truemoney') {
    e.stopImmediatePropagation();

    // Determine available webhook methods
    const webhookMethods = (streamerPaymentMethods.truemoney_webhook_methods || 'P2P').split(',').filter(Boolean);
    const webhookEnabled = !!streamerPaymentMethods.truemoney_webhook;

    if (webhookEnabled) {
      // Show method toggle only if both P2P and PROMPTPAY_IN are enabled
      if (trueMoneyQrMethodToggle) {
        const p2p = webhookMethods.includes('P2P');
        const ppin = webhookMethods.includes('PROMPTPAY_IN');
        trueMoneyQrMethodToggle.style.display = (p2p && ppin) ? 'flex' : 'none';
        trueMoneyQrMethod = p2p ? 'P2P' : (ppin ? 'PROMPTPAY_IN' : 'P2P');
        trueMoneyQrMethodToggle.querySelectorAll('.qr-method-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.method === trueMoneyQrMethod);
        });
      }
      await createTrueMoneyQR();
    } else {
      showOnlyPaymentStep(stepTrueMoney);
      saveManualPaymentStep('truemoney');

      updateSlipOkWarning('truemoney');

      if (trueMoneyAmount) {
        trueMoneyAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
      }

      // Display phone number
      if (trueMoneyPhoneDisplay) {
        const phone = streamerPaymentMethods.truemoney_phone || 'ไม่พบเบอร์โทรศัพท์';
        trueMoneyPhoneDisplay.textContent = phone;
      }
    }

    btnProceedPayment.disabled = false;
    btnProceedPayment.textContent = 'ดำเนินการต่อ →';
  } else if (selectedPaymentMethod === 'bank') {
    e.stopImmediatePropagation();

    showOnlyPaymentStep(stepBank);
    saveManualPaymentStep('bank');

    updateSlipOkWarning('bank');

    if (bankAmount) bankAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
    if (bankNameDisplay) bankNameDisplay.textContent = formatBankName(streamerPaymentMethods.bank_name);
    if (bankAccountNumberDisplay) bankAccountNumberDisplay.textContent = streamerPaymentMethods.bank_account_number || '';
    if (bankAccountNameDisplay) bankAccountNameDisplay.textContent = streamerPaymentMethods.bank_account_name || '';

    btnProceedPayment.disabled = false;
    btnProceedPayment.textContent = 'ดำเนินการต่อ →';
  }
}, true);

function updateSlipOkWarning(method) {
  const methodsLoaded = streamerPaymentMethods && Object.keys(streamerPaymentMethods).length > 0;
  if (method === 'truemoney') {
    const warning = document.getElementById('trueMoneySlipokWarning');
    if (warning) {
      warning.style.display = methodsLoaded && streamerPaymentMethods.truemoney_slipok_connected ? 'none' : 'flex';
    }
  } else if (method === 'bank') {
    const warning = document.getElementById('bankSlipokWarning');
    if (warning) {
      warning.style.display = methodsLoaded && streamerPaymentMethods.slipok_connected ? 'none' : 'flex';
    }
  } else {
    const warning = document.getElementById('slipokWarning');
    if (warning) {
      warning.style.display = methodsLoaded && streamerPaymentMethods.slipok_connected ? 'none' : 'flex';
    }
  }
}

// Widget Status Check (manual button — SSE handles real-time; this is one-shot verify)
async function updateStatus() {
  const statusBtn = document.getElementById('statusBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusNote = document.getElementById('statusNote');
  const refreshIcon = statusBtn?.querySelector('.lucide-refresh-ccw');

  if (!statusBtn || !statusDot || !statusText) return;

  if (refreshIcon) refreshIcon.classList.add('spinning');
  statusText.textContent = 'ตรวจสอบสถานะ...';

  try {
    const username = window.location.pathname.replace(/^\/|\/$/g, '');
    const [response] = await Promise.all([
      fetch(`/api/overlay/status/${username}`),
      new Promise(resolve => setTimeout(resolve, 1200))
    ]);

    if (!response.ok) { applyOverlayStatus(false); return; }
    const data = await response.json();
    overlayActive = !!data.active;
    applyOverlayStatus(overlayActive);
  } catch (error) {
    applyOverlayStatus(false);
  } finally {
    if (refreshIcon) refreshIcon.classList.remove('spinning');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Restore donor name from cookie
  const savedName = getCookie('tk_donor_name');
  if (savedName && donorNameInput) {
    donorNameInput.value = savedName;
  }
  // Save donor name to cookie on input
  if (donorNameInput) {
    donorNameInput.addEventListener('input', () => {
      setCookie('tk_donor_name', donorNameInput.value.trim(), 365);
    });
  }

  restorePendingPaymentStep();
  await loadPageContent();
  updateStatus();
  const statusBtn = document.getElementById('statusBtn');
  if (statusBtn) {
    statusBtn.addEventListener('click', updateStatus);
  }

});

function showOnlyPaymentStep(targetStep) {
  document.querySelectorAll('.step.active').forEach(step => step.classList.remove('active'));
  if (targetStep) targetStep.classList.add('active');
}

function restorePendingDonorDetails(pending) {
  if (!pending) return;
  if (donorNameInput && pending.donorName) donorNameInput.value = pending.donorName;
  if (donorMessageInput && typeof pending.message === 'string') donorMessageInput.value = pending.message;
  hasRestoredTimerAction = Object.prototype.hasOwnProperty.call(pending, 'timerAction');
  restoredTimerAction = ['add', 'sub', 'none'].includes(pending.timerAction) ? pending.timerAction : null;
  if (hasRestoredTimerAction && ['add', 'sub', 'none'].includes(pending.timerAction)) timerChoice = pending.timerAction;
  restoredTierSnapshot = {
    tierImageUrl: pending.tierImageUrl || null,
    tierSoundUrl: pending.tierSoundUrl || null,
    tierSoundIsTemp: !!pending.tierSoundIsTemp,
    tierSoundMode: pending.tierSoundMode || null,
    tierYoutubeId: pending.tierYoutubeId || null,
    tierYoutubeStart: pending.tierYoutubeStart,
    tierYoutubeEnd: pending.tierYoutubeEnd
  };
  applyRestoredTierSnapshot();
}

async function ensureStreamerPaymentMethodsLoaded() {
  if (streamerPaymentMethods && Object.keys(streamerPaymentMethods).length > 0) return true;
  if (paymentMethodsLoadPromise) return paymentMethodsLoadPromise;
  const username = window.location.pathname.split('/')[1];
  if (!username) return false;

  paymentMethodsLoadPromise = (async () => {
    try {
      const response = await fetch(`/api/page/${username}/payment-methods`);
      if (!response.ok) return false;
      streamerPaymentMethods = await response.json();
      return true;
    } catch (e) {
      return false;
    } finally {
      paymentMethodsLoadPromise = null;
    }
  })();

  return paymentMethodsLoadPromise;
}

async function hydratePaymentMethodsForRestore() {
  const loaded = await ensureStreamerPaymentMethodsLoaded();
  if (loaded) hydratePaymentMethodStep(streamerPaymentMethods);
  return loaded;
}

function applyManualPaymentDetails(method) {
  const methodsLoaded = streamerPaymentMethods && Object.keys(streamerPaymentMethods).length > 0;
  const loadingText = 'กำลังโหลดข้อมูลผู้รับ...';

  if (method === 'truemoney') {
    if (trueMoneyAmount) trueMoneyAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
    if (trueMoneyPhoneDisplay) {
      trueMoneyPhoneDisplay.textContent = methodsLoaded ? (streamerPaymentMethods.truemoney_phone || loadingText) : loadingText;
    }
    updateSlipOkWarning('truemoney');
    return;
  }

  if (bankAmount) bankAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
  if (bankNameDisplay) bankNameDisplay.textContent = methodsLoaded ? formatBankName(streamerPaymentMethods.bank_name) : loadingText;
  if (bankAccountNumberDisplay) bankAccountNumberDisplay.textContent = methodsLoaded ? (streamerPaymentMethods.bank_account_number || loadingText) : loadingText;
  if (bankAccountNameDisplay) bankAccountNameDisplay.textContent = methodsLoaded ? (streamerPaymentMethods.bank_account_name || loadingText) : loadingText;
  updateSlipOkWarning('bank');
}

function restoreManualPaymentStep(pending) {
  selectedAmount = pending.amount;
  selectedPaymentMethod = pending.method;
  restorePendingDonorDetails(pending);
  const targetStep = pending.method === 'truemoney' ? stepTrueMoney : stepBank;
  showOnlyPaymentStep(targetStep);
  applyManualPaymentDetails(pending.method);

}

async function restorePendingPaymentStep() {
  const pendingPromptPay = getPendingQR(true);
  if (pendingPromptPay && isPendingRestorable(pendingPromptPay)) {
    selectedAmount = pendingPromptPay.amount;
    selectedPaymentMethod = 'promptpay';
    restorePendingDonorDetails(pendingPromptPay);
    restoreQRStep(pendingPromptPay);
    await hydratePaymentMethodsForRestore();
    selectPaymentMethod('promptpay');
    if (stepQR?.classList.contains('active')) updateSlipOkWarning(false);
    return;
  }
  if (pendingPromptPay && !pendingPromptPay.backedOutAt) clearPendingQR();

  const pendingTrueMoney = getTrueMoneyPendingRestoreCandidate();
  if (pendingTrueMoney && isPendingRestorable(pendingTrueMoney)) {
    selectedAmount = pendingTrueMoney.amount;
    selectedPaymentMethod = 'truemoney';
    trueMoneyQrMethod = pendingTrueMoney.method;
    restorePendingDonorDetails(pendingTrueMoney);
    restoreTrueMoneyQrStep(pendingTrueMoney);
    await hydratePaymentMethodsForRestore();
    selectPaymentMethod('truemoney');
    return;
  }

  const pendingManualPayment = getManualPaymentStep();
  // TrueMoney manual step ไม่มี SSE รอ webhook — restore เข้าไปแล้วยืนยันไม่ได้ ปล่อยให้เริ่มใหม่จากหน้าแรกแทน
  if (pendingManualPayment && pendingManualPayment.method === 'truemoney') {
    clearManualPaymentStep();
    return;
  }
  if (pendingManualPayment) {
    restoreManualPaymentStep(pendingManualPayment);
    await hydratePaymentMethodsForRestore();
    selectPaymentMethod(pendingManualPayment.method);
    if (stepTrueMoney?.classList.contains('active') || stepBank?.classList.contains('active')) {
      applyManualPaymentDetails(pendingManualPayment.method);
    }
  }
}


// Report modal
(function initReportModal() {
  const overlay = document.getElementById('reportModal');
  const btnOpen = document.getElementById('btnOpenReport');
  const btnClose = document.getElementById('btnCloseReport');
  const btnCancel = document.getElementById('btnCancelReport');
  const btnSubmit = document.getElementById('btnSubmitReport');
  const msgEl = document.getElementById('reportMessage');
  const charEl = document.getElementById('reportCharCount');
  const statusEl = document.getElementById('reportStatus');

  if (!overlay || !btnOpen) return;

  function openModal(e) {
    e.preventDefault();
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    statusEl.style.display = 'none';
    statusEl.textContent = '';
    document.getElementById('reportType').value = 'inappropriate';
    msgEl.value = '';
    charEl.textContent = '0';
    btnSubmit.disabled = false;
  }

  btnOpen.addEventListener('click', openModal);
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  msgEl.addEventListener('input', () => { charEl.textContent = msgEl.value.length; });

  btnSubmit.addEventListener('click', async () => {
    btnSubmit.disabled = true;
    statusEl.style.display = 'none';

    try {
      const res = await fetch('/api/report-donate-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportType: document.getElementById('reportType').value,
          message: msgEl.value.trim(),
          donatePageUrl: window.location.href,
          streamerUsername: document.getElementById('pageTitle')?.textContent?.trim() || '',
        }),
      });
      const data = await res.json();
      statusEl.style.display = 'block';
      if (res.ok) {
        statusEl.className = 'report-status report-status-ok';
        statusEl.textContent = 'ส่งรายงานสำเร็จแล้ว ✅ ขอบคุณที่แจ้งให้เราทราบ';
        setTimeout(closeModal, 2500);
      } else {
        statusEl.className = 'report-status report-status-err';
        statusEl.textContent = data.error || 'ส่งรายงานไม่สำเร็จ กรุณาลองใหม่';
        btnSubmit.disabled = false;
      }
    } catch {
      statusEl.style.display = 'block';
      statusEl.className = 'report-status report-status-err';
      statusEl.textContent = 'เกิดข้อผิดพลาด กรุณาลองใหม่ภายหลัง';
      btnSubmit.disabled = false;
    }
  });
})();
