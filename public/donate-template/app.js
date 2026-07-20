// State
let selectedAmount = 0;
let timerPublicConfig = null;
let timerActive = false;             // mirror จาก server — drives gate (TIMER_CHOICE_GATE B1)
let overlayActive = false;           // mirror จาก server — drives statusBtn
let widgetStatusSource = null;       // EventSource for real-time widget status
let timerChoice = 'add';
let selectedPaymentMethod = 'ffp';
let currentChargeId = null;
let pollInterval = null;
let countdownInterval = null;
let qrExpiresAt = null;
const POLLING_TIMEOUT = 600000; // 10 minutes
const QR_EXPIRY = 10 * 60 * 1000; // 10 minutes
let pollingStartTime = null;

// TrueMoney webhook QR state
let trueMoneyQrMethod = 'P2P';
let trueMoneyQrRefId = null;
let trueMoneyQrSource = null;
let trueMoneyQrFallbackTimer = null;
let trueMoneyQrCountdownInterval = null;
let trueMoneyQrExpiresAt = null;

// Tier Donate (TIER_DONATE_BLUEPRINT.md § 4)
let pageSettings = null;
let tierSettings = null;
let currentUnlockedTier = null;
let selectedTierImageUrl = null;
let selectedTierSoundUrl = null;
let selectedTierSoundIsTemp = false;
let selectedTierSoundLabel = '';
let tierMediaRecorder = null;
let tierAudioContext = null;
let tierGainNode = null;
let tierRecordedChunks = [];
let tierRecordTimeout = null;
let tierRecordCountdownInterval = null;
let tierRecordPendingBlob = null;
let tierRecordPreviewUrl = null;
let currentSoundSource = null;

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

function getPendingKey() {
  const username = window.location.pathname.split('/')[1];
  return username ? `promptpay_pending_${username}` : 'promptpay_pending';
}

function savePendingQR(data) {
  try {
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
    localStorage.setItem(getPendingKey(), JSON.stringify(pending));
  } catch (e) { /* localStorage full or disabled */ }
}

function getPendingQR() {
  try {
    const raw = localStorage.getItem(getPendingKey());
    if (!raw) return null;
    const pending = JSON.parse(raw);
    if (!pending || !pending.referenceId || !pending.qrData || !pending.expiresAt) return null;
    if (Date.now() >= new Date(pending.expiresAt).getTime()) {
      localStorage.removeItem(getPendingKey());
      return null;
    }
    return pending;
  } catch (e) { return null; }
}

function clearPendingQR() {
  try { localStorage.removeItem(getPendingKey()); } catch (e) {}
}

// Social icons map
const SOCIAL_ICONS = {
  twitch: 'fa-twitch',
  youtube: 'fa-youtube',
  tiktok: 'fa-tiktok',
  facebook: 'fa-facebook',
  x: 'fa-x-twitter',
  discord: 'fa-discord',
  instagram: 'fa-instagram'
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
const displayAmount = document.getElementById('displayAmount');
const paymentStatus = document.getElementById('paymentStatus');
const minAmountWarning = document.getElementById('minAmountWarning');
const minAmountWarningValue = document.getElementById('minAmountWarningValue');
const paymentError = document.getElementById('paymentError');
const paymentErrorMessage = document.getElementById('paymentErrorMessage');
const qrExpiry = document.getElementById('qrExpiry');
const qrRecipientName = document.getElementById('qrRecipientName');
const qrReference = document.getElementById('qrReference');

// Current user's minimum amount (loaded from API)
let userMinAmount = 1;
let streamerPaymentMethods = {};

// Dynamic Page Elements
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const pageSubtitle2 = document.getElementById('pageSubtitle2');
const profileImage = document.getElementById('profileImage');
const socialLinksContainer = document.getElementById('socialLinks');

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
    document.getElementById('donateGoalFill').style.background = data.barColor || '#7c3aed';
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
    recomputeTierUnlock();
  } catch (e) {
    // Silent fail — tier donate is an enhancement, ไม่บล็อกการโดเนทหลัก (§4.6 Mobile Donor Resilience)
  }
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
  }
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
  if (soundLabel) soundLabel.textContent = 'ไม่ใช้เสียงพิเศษ';
  const changeBtn = document.getElementById('btnChangeTierSound');
  if (changeBtn) changeBtn.style.display = 'none';
  hideTierRecordReview();
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
    return;
  }
  section.classList.add('tier-open');
  banner.className = 'tier-banner tier-level-' + unlocked.level;
  const tierName = (unlocked.name || '').trim();
  banner.textContent = `${tierName ? tierName : 'Tier ' + unlocked.level}!`;

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
    imgBlock.style.display = '';
  } else {
    imgBlock.style.display = 'none';
  }

  // Sound library choices
  const sndBlock = document.getElementById('tierSoundChoiceBlock');
  if (unlocked.allow_sound_choice) {
    sndBlock.style.display = '';
  } else {
    sndBlock.style.display = 'none';
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
  if (hasUpload || hasRecord) {
    ownBlock.style.display = '';
    if (uploadSubtab) uploadSubtab.style.display = hasUpload ? '' : 'none';
    if (recordSubtab) recordSubtab.style.display = hasRecord ? '' : 'none';
    if (ownSubtabs) ownSubtabs.style.display = (hasUpload && hasRecord) ? '' : 'none';
    if (hasUpload && !hasRecord) {
      uploadPane.style.display = '';
      recordPane.style.display = 'none';
    } else if (!hasUpload && hasRecord) {
      uploadPane.style.display = 'none';
      recordPane.style.display = '';
    }
  } else {
    ownBlock.style.display = 'none';
  }
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

// §10.10 — mutual-exclusion UI for the 3 sound sources
function updateSoundSourceUI(activeSource) {
  currentSoundSource = activeSource || null;
  const libraryBlock = document.getElementById('tierSoundChoiceBlock');
  const uploadPane = document.getElementById('tierUploadPane');
  const recordPane = document.getElementById('tierRecordPane');
  const changeBtn = document.getElementById('btnChangeTierSound');

  [libraryBlock, uploadPane, recordPane].forEach(el => el?.classList.remove('sound-source-dimmed'));
  if (activeSource === 'library') {
    uploadPane?.classList.add('sound-source-dimmed');
    recordPane?.classList.add('sound-source-dimmed');
  } else if (activeSource === 'upload') {
    libraryBlock?.classList.add('sound-source-dimmed');
    recordPane?.classList.add('sound-source-dimmed');
  } else if (activeSource === 'record') {
    libraryBlock?.classList.add('sound-source-dimmed');
    uploadPane?.classList.add('sound-source-dimmed');
  }

  if (changeBtn) changeBtn.style.display = activeSource ? '' : 'none';
}

// §10.7 / §10.15 — tier sound picker modal
let currentPreviewAudio = null;
let currentPreviewUrl = null;

function openTierSoundPicker() {
  const modal = document.getElementById('tierSoundPickerModal');
  if (!modal) return;
  switchTierSoundTab('library');
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

function switchTierSoundTab(tab) {
  document.querySelectorAll('.tier-sound-picker-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tier-sound-picker-panel').forEach(p => {
    p.classList.toggle('active', p.id === (tab === 'library' ? 'tierSoundPickerLibrary' : 'tierSoundPickerCatalog'));
  });
  if (tab === 'library') renderTierSoundLibraryList();
}

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
  updateTierSoundPlayIcons();
}

function updateTierSoundPlayIcons() {
  document.querySelectorAll('.tier-sound-item').forEach(item => {
    const playBtn = item.querySelector('.sound-play-btn');
    if (!playBtn) return;
    const url = item.dataset.url;
    const isPlaying = currentPreviewAudio && !currentPreviewAudio.paused && currentPreviewUrl === url;
    playBtn.innerHTML = `<i class="fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}"></i>`;
  });
}

function renderTierSoundLibraryList() {
  const list = document.getElementById('tierSoundLibraryList');
  if (!list) return;
  list.innerHTML = '';
  const defaultItem = document.createElement('div');
  defaultItem.className = 'tier-sound-item' + (selectedTierSoundUrl ? '' : ' selected');
  defaultItem.dataset.url = '';
  defaultItem.dataset.label = 'ไม่ใช้เสียงพิเศษ';
  defaultItem.innerHTML = `<span class="sound-label"><i class="fa-solid fa-ban" style="margin-right:6px;"></i>ไม่ใช้เสียงพิเศษ</span>`;
  defaultItem.onclick = () => selectTierSound(null, 'ไม่ใช้เสียงพิเศษ', 'library');
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
          selectTierSound(s.mp3Url, s.name, 'library');
        }
      };
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = '<div class="tier-sound-empty">ค้นหาไม่ได้ชั่วคราว ลองใหม่ภายหลัง</div>';
  }
}

function selectTierSound(url, label, source) {
  selectedTierSoundUrl = url || null;
  selectedTierSoundIsTemp = false;
  selectedTierSoundLabel = label || 'ไม่ใช้เสียงพิเศษ';
  currentSoundSource = url ? source : null;
  updateSoundSourceUI(currentSoundSource);
  const labelEl = document.getElementById('tierSoundSelectedLabel');
  if (labelEl) labelEl.textContent = selectedTierSoundLabel;
  closeTierSoundPicker();
  stopTierSoundPreview();
}

// Sound picker bindings
document.getElementById('btnPickTierSound')?.addEventListener('click', openTierSoundPicker);
document.getElementById('btnCloseTierSoundPicker')?.addEventListener('click', closeTierSoundPicker);
document.getElementById('btnChangeTierSound')?.addEventListener('click', () => {
  selectedTierSoundUrl = null;
  selectedTierSoundIsTemp = false;
  selectedTierSoundLabel = '';
  currentSoundSource = null;
  updateSoundSourceUI(null);
  const labelEl = document.getElementById('tierSoundSelectedLabel');
  if (labelEl) labelEl.textContent = 'ไม่ใช้เสียงพิเศษ';
});
document.querySelectorAll('.tier-sound-picker-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    switchTierSoundTab(tab);
    if (tab === 'catalog') searchTierSoundCatalog('');
  });
});
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
  const status = document.getElementById('tierOwnAudioStatus');
  const setStatus = (msg) => { if (status) status.textContent = msg; };
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
    if (!res.ok) throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
    selectedTierSoundUrl = data.url;
    selectedTierSoundIsTemp = true;
    selectedTierSoundLabel = file.name || 'ไฟล์ที่อัพโหลด';
    currentSoundSource = 'upload';
    updateSoundSourceUI('upload');
    setStatus('อัปโหลดสำเร็จ ✓');
  } catch (err) {
    setStatus('อัปโหลดไม่สำเร็จ: ' + err.message);
  }
});

// §10.8 — recorded audio review
function showTierRecordReview(blob) {
  tierRecordPendingBlob = blob;
  const controls = document.getElementById('tierRecordControls');
  const review = document.getElementById('tierRecordReview');
  const preview = document.getElementById('tierRecordPreview');
  if (controls) controls.style.display = 'none';
  if (review) review.style.display = '';
  if (preview) {
    tierRecordPreviewUrl = URL.createObjectURL(blob);
    preview.src = tierRecordPreviewUrl;
  }
}

function hideTierRecordReview() {
  tierRecordPendingBlob = null;
  const controls = document.getElementById('tierRecordControls');
  const review = document.getElementById('tierRecordReview');
  const preview = document.getElementById('tierRecordPreview');
  if (controls) controls.style.display = '';
  if (review) review.style.display = 'none';
  if (preview) { preview.src = ''; preview.load(); }
  if (tierRecordPreviewUrl) { URL.revokeObjectURL(tierRecordPreviewUrl); tierRecordPreviewUrl = null; }
}

document.getElementById('tierRecordRetryBtn')?.addEventListener('click', () => {
  hideTierRecordReview();
  closeTierAudioContext();
});
document.getElementById('tierRecordConfirmBtn')?.addEventListener('click', () => {
  if (!tierRecordPendingBlob) return;
  uploadTierRecordedAudio(tierRecordPendingBlob);
  hideTierRecordReview();
});

// Own-audio: mic recording flow (§4.4 + §10.9 auto-gain)
document.getElementById('tierRecordBtn')?.addEventListener('click', () => {
  if (tierMediaRecorder && tierMediaRecorder.state === 'recording') {
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

async function startTierRecording() {
  const status = document.getElementById('tierRecordStatus');
  const btnLabel = document.getElementById('tierRecordBtnLabel');
  const timerEl = document.getElementById('tierRecordTimer');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // §10.9 — live auto-gain + compressor to boost quiet mobile mics and prevent clipping
    tierAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = tierAudioContext.createMediaStreamSource(stream);
    tierGainNode = tierAudioContext.createGain();
    tierGainNode.gain.value = 2.5;
    const compressor = tierAudioContext.createDynamicsCompressor();
    source.connect(tierGainNode).connect(compressor);
    const dest = tierAudioContext.createMediaStreamDestination();
    compressor.connect(dest);
    tierMediaRecorder = new MediaRecorder(dest.stream);
    tierRecordedChunks = [];
    tierMediaRecorder.ondataavailable = e => tierRecordedChunks.push(e.data);
    tierMediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      closeTierAudioContext();
      const blob = new Blob(tierRecordedChunks, { type: 'audio/webm' });
      showTierRecordReview(blob);
    };
    tierMediaRecorder.start();
    if (btnLabel) btnLabel.textContent = 'หยุดอัดเสียง';
    if (status) status.textContent = '';

    let remaining = 15;
    if (timerEl) { timerEl.style.display = ''; timerEl.textContent = `กำลังอัด... เหลือ ${remaining} วินาที`; }
    tierRecordCountdownInterval = setInterval(() => {
      remaining -= 1;
      if (timerEl) timerEl.textContent = `กำลังอัด... เหลือ ${remaining} วินาที`;
      if (remaining <= 0) clearInterval(tierRecordCountdownInterval);
    }, 1000);
    tierRecordTimeout = setTimeout(() => stopTierRecording(false), 15000);
  } catch (err) {
    document.getElementById('tierRecordSubtabBtn').style.display = 'none';
    document.getElementById('tierUploadPane').style.display = '';
    document.getElementById('tierRecordPane').style.display = 'none';
    document.querySelector('.tier-subtab-btn[data-subtab="upload"]')?.classList.add('active');
    document.getElementById('tierRecordSubtabBtn')?.classList.remove('active');
  }
}

function stopTierRecording(cancel) {
  clearTimeout(tierRecordTimeout);
  clearInterval(tierRecordCountdownInterval);
  const timerEl = document.getElementById('tierRecordTimer');
  if (timerEl) timerEl.style.display = 'none';
  const btnLabel = document.getElementById('tierRecordBtnLabel');
  if (btnLabel) btnLabel.textContent = 'เริ่มอัดเสียง';
  closeTierAudioContext();
  if (cancel && tierMediaRecorder) {
    tierMediaRecorder.onstop = null;
    if (tierMediaRecorder.state === 'recording') {
      tierMediaRecorder.stream?.getTracks().forEach(t => t.stop());
      tierMediaRecorder.stop();
    }
    tierMediaRecorder = null;
    return;
  }
  if (tierMediaRecorder && tierMediaRecorder.state === 'recording') {
    tierMediaRecorder.stop();
  }
}

async function uploadTierRecordedAudio(blob) {
  const status = document.getElementById('tierRecordStatus');
  const setStatus = (msg) => { if (status) status.textContent = msg; };
  setStatus('กำลังอัปโหลด...');
  try {
    const username = window.location.pathname.split('/')[1];
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');
    formData.append('username', username);
    formData.append('mode', 'record');
    const res = await fetch('/api/donate/upload-tier-audio', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
    selectedTierSoundUrl = data.url;
    selectedTierSoundIsTemp = true;
    selectedTierSoundLabel = 'เสียงที่อัดจากไมค์';
    currentSoundSource = 'record';
    updateSoundSourceUI('record');
    setStatus('อัดเสียงสำเร็จ ✓');
  } catch (err) {
    setStatus('อัปโหลดไม่สำเร็จ: ' + err.message);
  }
}

function renderSocialLinks(socials) {
  socialLinksContainer.innerHTML = '';
  
  const activeLinks = Object.entries(socials).filter(([_, url]) => url);
  const showLabels = activeLinks.length <= 3;

  const platformNames = {
    twitch: 'Twitch',
    youtube: 'YouTube',
    tiktok: 'TikTok',
    facebook: 'Facebook',
    x: 'X (Twitter)',
    discord: 'Discord',
    instagram: 'Instagram'
  };

  activeLinks.forEach(([platform, url]) => {
    // SEC-001 / SEC-012: Validate URL scheme and add noopener to prevent XSS and tab-nabbing
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    } catch { return; }
    const iconClass = SOCIAL_ICONS[platform] || 'fa-link';
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = `social-btn ${platform}`;
    
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

// Amount button click
amountBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    amountBtns.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedAmount = parseInt(btn.dataset.amount);
    customAmountInput.value = selectedAmount;
    updateDonateButton();
  });
});

// Custom amount input
customAmountInput.addEventListener('input', () => {
  amountBtns.forEach(b => b.classList.remove('selected'));
  selectedAmount = parseInt(customAmountInput.value) || 0;
  updateDonateButton();
});

// Timer choice button click
document.getElementById('timerChoiceBox')?.addEventListener('click', e => {
  const btn = e.target.closest('.timer-choice-btn');
  if (!btn) return;
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
  // EventSource auto-reconnects; browser handles visibility
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

// Donate button click -> go to payment method selection
btnDonate.addEventListener('click', async () => {
  if (selectedAmount < userMinAmount) return;

  const username = window.location.pathname.split('/')[1];
  if (!username) {
    alert('ไม่พบชื่อผู้รับบริจาคใน URL');
    return;
  }

  // Guard: เช็คว่า streamer ตั้งค่าวิธีชำระเงินอย่างน้อย 1 วิธีหรือไม่
  try {
    const res = await fetch(`/api/page/${username}/payment-methods`);
    if (res.ok) {
      const methods = await res.json();
      streamerPaymentMethods = methods;
      const hasAnyMethod = methods.promptpay || methods.truemoney || methods.truemoney_webhook || methods.bank || methods.ffp;

      if (!hasAnyMethod) {
        // Shake + Red Glow + Message
        const btn = document.getElementById('btnDonate');
        const existingMsg = document.getElementById('noPaymentMethodMsg');

        // ลบ animation เดิม (ถ้ามี) เพื่อ re-trigger
        btn.classList.remove('btn-shake', 'btn-glow-red');
        void btn.offsetWidth; // reflow
        btn.classList.add('btn-shake', 'btn-glow-red');

        // แสดง/สร้างข้อความ
        if (!existingMsg) {
          const msg = document.createElement('div');
          msg.id = 'noPaymentMethodMsg';
          msg.className = 'no-payment-message';
          msg.textContent = 'เจ้าของหน้าโดเนทยังไม่ตั้งวิธีชำระเงิน';
          btn.parentElement.appendChild(msg);
        } else {
          // re-trigger animation
          existingMsg.style.animation = 'none';
          void existingMsg.offsetWidth;
          existingMsg.style.animation = 'revealMessage 0.5s ease-out forwards';
        }

        return; // หยุด — ไม่ไปหน้าถัดไป
      }

      // แสดงเฉพาะวิธีชำระเงินที่เปิดใช้งาน
      const optionFFP = document.getElementById('optionFFP');
      const optionPromptPay = document.getElementById('optionPromptPay');
      const optionTrueMoney = document.getElementById('optionTrueMoney');
      const optionBank = document.getElementById('optionBank');

      if (optionFFP) optionFFP.style.display = methods.ffp ? '' : 'none';
      if (optionPromptPay) optionPromptPay.style.display = methods.promptpay ? '' : 'none';
      if (optionTrueMoney) optionTrueMoney.style.display = (methods.truemoney || methods.truemoney_webhook) ? '' : 'none';
      if (optionBank) optionBank.style.display = methods.bank ? '' : 'none';

      // Auto-select first available method
      if (methods.promptpay) {
        selectPaymentMethod('promptpay');
      } else if (methods.truemoney || methods.truemoney_webhook) {
        selectPaymentMethod('truemoney');
      } else if (methods.bank) {
        selectPaymentMethod('bank');
      } else {
        selectPaymentMethod('promptpay'); // fallback
      }
    }
  } catch (e) {
    // ถ้า API ล่ม ให้ดำเนินการต่อได้ (legacy behavior)
    console.error('Error checking payment methods:', e);
  }

  // Update summary
  document.getElementById('summaryAmount').textContent = `฿${selectedAmount.toLocaleString()}`;
  document.getElementById('summaryDonor').textContent = donorNameInput.value || 'ไม่ระบุชื่อ';

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
          tierSoundMode: selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : null
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
      } else {
        throw new Error('ไม่ได้รับลิงก์ชำระเงิน');
      }
    } catch (error) {
      alert(error.message);
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
          tierSoundMode: selectedTierSoundIsTemp ? (currentSoundSource === 'record' ? 'record' : 'upload') : null
        })
      });

      const data = await response.json();
      if (!response.ok) {
        if (data.errorCode === 'TFP_NOT_CONFIGURED') {
          showPaymentError(data.error || 'ระบบเช็คสลิปไม่ทำงานชั่วคราว โปรดรอสักครู่แล้วลองใหม่');
        } else {
          showPaymentError(data.error || 'ไม่สามารถสร้าง QR Code ได้');
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
      showPaymentError(error.message);
      btnProceedPayment.disabled = false;
      btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
    }
  }
});

function generateQRImage(qrData) {
  if (!qrImage) return;
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

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrData)}`;
  qrImage.src = qrUrl;
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
  };
}

function showQRStep(data) {
  stepPaymentMethod.classList.remove('active');
  stepQR.classList.add('active');
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

  stepPaymentMethod.classList.remove('active');
  stepQR.classList.add('active');

  updateSlipOkWarning(false);

  generateQRImage(pending.qrData);
  displayAmount.textContent = `฿${pending.amount.toLocaleString()}`;
  if (qrRecipientName) qrRecipientName.textContent = pending.recipientName || '-';
  if (qrReference) qrReference.textContent = pending.referenceId;
  qrExpiresAt = new Date(pending.expiresAt).getTime();

  const remaining = Math.max(0, qrExpiresAt - Date.now());
  if (remaining <= 0) {
    clearPendingQR();
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
  if (paymentStatus) {
    paymentStatus.style.display = 'flex';
    paymentStatus.className = 'status expired';
    paymentStatus.innerHTML = '<i class="fa-solid fa-clock"></i> QR Code หมดอายุแล้ว';
  }
  if (btnRetryQR) btnRetryQR.style.display = 'block';
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
    clearPendingQR();
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

      if (data.verified) {
        clearPendingQR();
        stopPolling();
        stopCountdown();
        if (paymentStatus) {
          paymentStatus.style.display = 'flex';
          paymentStatus.className = 'status success';
          paymentStatus.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#22c55e;"></i> ชำระเงินสำเร็จ!';
        }
        setTimeout(() => {
          window.location.href = `/${window.location.pathname.split('/')[1]}/thank-you`;
        }, 1500);
      } else if (data.expired) {
        clearPendingQR();
        stopPolling();
        stopCountdown();
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
    stepQR.classList.remove('active');
    stepPaymentMethod.classList.add('active');
    currentChargeId = null;
    // Keep localStorage so donor can resume same QR
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
const trueMoneyQrAmount = document.getElementById('trueMoneyQrAmount');
const trueMoneyQrHint = document.getElementById('trueMoneyQrHint');
const trueMoneyQrExpiry = document.getElementById('trueMoneyQrExpiry');
const trueMoneyQrWaiting = document.getElementById('trueMoneyQrWaiting');
const trueMoneyQrStatus = document.getElementById('trueMoneyQrStatus');
const trueMoneyQrMethodToggle = document.getElementById('trueMoneyQrMethodToggle');
const btnTrueMoneyQrSlipFallback = document.getElementById('btnTrueMoneyQrSlipFallback');
const btnBackTrueMoneyQr = document.getElementById('btnBackTrueMoneyQr');
const btnRetryTrueMoneyQr = document.getElementById('btnRetryTrueMoneyQr');

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
    if (currentChargeId) formData.append('referenceId', currentChargeId);

    const response = await fetch('/api/verify-slip', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (data.referenceId) currentChargeId = data.referenceId;

    if (data.success) {
      clearPendingQR();
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
    if (currentChargeId) formData.append('referenceId', currentChargeId);

    bankPaymentStatus.style.display = 'flex';
    bankPaymentStatus.className = 'status checking';

    const response = await fetch('/api/verify-slip', { method: 'POST', body: formData });
    const data = await response.json();
    if (data.referenceId) currentChargeId = data.referenceId;

    if (data.success) {
      clearPendingQR();
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
    trueMoneyQrMethodToggle.querySelectorAll('.qr-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    trueMoneyQrMethod = btn.dataset.method || 'P2P';
  });
}

function getTrueMoneyPendingKey() {
  const username = window.location.pathname.split('/')[1];
  return username ? `truemoney_webhook_pending_${username}` : 'truemoney_webhook_pending';
}

function saveTrueMoneyPendingQR(data) {
  try {
    const pending = {
      referenceId: data.referenceId,
      qrData: data.qrData,
      amount: selectedAmount,
      donorName: donorNameInput?.value?.trim() || '',
      message: donorMessageInput?.value?.trim() || '',
      expiresAt: data.expiresAt,
      method: data.method || 'P2P',
      displayAmount: data.displayAmount ?? selectedAmount,
      timerAction: getTimerActionForSubmit()
    };
    localStorage.setItem(getTrueMoneyPendingKey(), JSON.stringify(pending));
  } catch (e) {}
}

function getTrueMoneyPendingQR() {
  try {
    const raw = localStorage.getItem(getTrueMoneyPendingKey());
    if (!raw) return null;
    const pending = JSON.parse(raw);
    if (!pending || !pending.referenceId || !pending.qrData || !pending.expiresAt) return null;
    if (Date.now() >= new Date(pending.expiresAt).getTime()) {
      localStorage.removeItem(getTrueMoneyPendingKey());
      return null;
    }
    return pending;
  } catch (e) { return null; }
}

function clearTrueMoneyPendingQR() {
  try { localStorage.removeItem(getTrueMoneyPendingKey()); } catch (e) {}
}

function generateTrueMoneyQRImage(qrData) {
  if (!trueMoneyQrImage) return;
  trueMoneyQrLoading.style.display = 'block';
  trueMoneyQrImage.style.display = 'none';

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrData)}`;
  trueMoneyQrImage.src = qrUrl;
  trueMoneyQrImage.onload = () => {
    trueMoneyQrLoading.style.display = 'none';
    trueMoneyQrImage.style.display = 'block';
  };
  trueMoneyQrImage.onerror = () => {
    trueMoneyQrLoading.innerHTML = '<p>ไม่สามารถสร้าง QR Code ได้ กรุณาลองใหม่</p>';
  };
}

function stopTrueMoneyQr() {
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
    if (trueMoneyQrWaiting) {
      trueMoneyQrWaiting.className = 'qr-waiting-indicator expired';
      trueMoneyQrWaiting.innerHTML = '<i class="fa-solid fa-clock" style="color:#ef4444;"></i><span>QR หมดอายุแล้ว กดสร้าง QR ใหม่เพื่อบริจาคต่อ</span>';
    }
    if (btnTrueMoneyQrSlipFallback) btnTrueMoneyQrSlipFallback.style.display = 'none';
    if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'block';
  }
}

function startTrueMoneyQrCountdown(expiresAt) {
  trueMoneyQrExpiresAt = new Date(expiresAt).getTime();
  updateTrueMoneyQrCountdown();
  trueMoneyQrCountdownInterval = setInterval(updateTrueMoneyQrCountdown, 1000);
}

function startTrueMoneyStatusStream(refId) {
  stopTrueMoneyQr();
  if (!refId) return;
  trueMoneyQrSource = new EventSource(`/api/donate/status/stream?ref=${encodeURIComponent(refId)}`);
  trueMoneyQrSource.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'donate_status' && data.status === 'confirmed') {
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
    } catch (_) {}
  };
  trueMoneyQrSource.onerror = () => {};
}

async function createTrueMoneyQR() {
  const username = window.location.pathname.split('/')[1];
  if (!username) return;

  // Check cached pending first
  const pending = getTrueMoneyPendingQR();
  const currentDonorName = donorNameInput?.value?.trim() || '';
  const currentMessage = donorMessageInput?.value?.trim() || '';
  const currentTimerAction = getTimerActionForSubmit() || '';
  if (pending && pending.amount === selectedAmount && pending.donorName === currentDonorName && pending.message === currentMessage && pending.timerAction === currentTimerAction && pending.method === trueMoneyQrMethod) {
    showTrueMoneyQrStep(pending);
    return;
  }
  clearTrueMoneyPendingQR();

  if (trueMoneyQrLoading) trueMoneyQrLoading.style.display = 'block';
  if (trueMoneyQrImage) trueMoneyQrImage.style.display = 'none';
  if (trueMoneyQrStatus) trueMoneyQrStatus.style.display = 'none';

  try {
    const response = await fetch('/api/truemoney/create-qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...getAntiBotPayload(),
        username,
        amount: selectedAmount,
        name: donorNameInput.value,
        message: donorMessageInput.value,
        timerAction: getTimerActionForSubmit(),
        method: trueMoneyQrMethod
      })
    });

    const data = await response.json();
    if (!response.ok) {
      setTrueMoneyQrWaitingError(data.error || 'ไม่สามารถสร้าง QR ได้');
      if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'block';
      return;
    }

    saveTrueMoneyPendingQR(data);
    showTrueMoneyQrStep(data);
  } catch (error) {
    setTrueMoneyQrWaitingError('เกิดข้อผิดพลาด กรุณาลองใหม่');
    if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'block';
  }
}

function showTrueMoneyQrStep(data) {
  stepPaymentMethod.classList.remove('active');
  stepTrueMoneyQr.classList.add('active');
  trueMoneyQrRefId = data.referenceId;

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
  if (btnTrueMoneyQrSlipFallback) btnTrueMoneyQrSlipFallback.style.display = 'none';
  if (btnRetryTrueMoneyQr) btnRetryTrueMoneyQr.style.display = 'none';

  startTrueMoneyStatusStream(data.referenceId);
  startTrueMoneyQrCountdown(data.expiresAt);

  trueMoneyQrFallbackTimer = setTimeout(() => {
    if (btnTrueMoneyQrSlipFallback) {
      btnTrueMoneyQrSlipFallback.style.display = 'block';
    }
  }, 90000);
}

function restoreTrueMoneyQrStep(pending) {
  trueMoneyQrRefId = pending.referenceId;
  selectedAmount = pending.amount;
  trueMoneyQrMethod = pending.method || 'P2P';
  if (trueMoneyQrMethodToggle) {
    trueMoneyQrMethodToggle.querySelectorAll('.qr-method-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.method === trueMoneyQrMethod);
    });
  }
  stepPaymentMethod.classList.remove('active');
  stepTrueMoneyQr.classList.add('active');
  generateTrueMoneyQRImage(pending.qrData);
  if (trueMoneyQrAmount) {
    const displayAmount = Number(pending.displayAmount || pending.amount);
    trueMoneyQrAmount.textContent = `฿${displayAmount.toLocaleString('th-TH', { minimumFractionDigits: displayAmount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  startTrueMoneyStatusStream(pending.referenceId);
  startTrueMoneyQrCountdown(pending.expiresAt);

  // Show fallback button if 90s window already elapsed
  const expiresMs = new Date(pending.expiresAt).getTime();
  const createdMs = expiresMs - 30 * 60 * 1000;
  const elapsed = Date.now() - createdMs;
  if (elapsed >= 90000) {
    if (btnTrueMoneyQrSlipFallback) btnTrueMoneyQrSlipFallback.style.display = 'block';
  } else {
    trueMoneyQrFallbackTimer = setTimeout(() => {
      if (btnTrueMoneyQrSlipFallback) btnTrueMoneyQrSlipFallback.style.display = 'block';
    }, 90000 - elapsed);
  }
}

if (btnBackTrueMoneyQr) {
  btnBackTrueMoneyQr.addEventListener('click', () => {
    stopTrueMoneyQr();
    stepTrueMoneyQr.classList.remove('active');
    stepPaymentMethod.classList.add('active');
    if (btnProceedPayment) {
      btnProceedPayment.disabled = false;
      btnProceedPayment.innerHTML = 'ดำเนินการต่อ <i class="fa-solid fa-arrow-right"></i>';
    }
  });
}

if (btnTrueMoneyQrSlipFallback) {
  btnTrueMoneyQrSlipFallback.addEventListener('click', () => {
    stopTrueMoneyQr();
    stepTrueMoneyQr.classList.remove('active');
    stepTrueMoney.classList.add('active');
    if (trueMoneyAmount) trueMoneyAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
    if (trueMoneyPhoneDisplay) {
      trueMoneyPhoneDisplay.textContent = streamerPaymentMethods.truemoney_phone || 'ไม่พบเบอร์โทรศัพท์';
    }
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
      stepPaymentMethod.classList.remove('active');
      stepTrueMoney.classList.add('active');

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

    stepPaymentMethod.classList.remove('active');
    stepBank.classList.add('active');

    updateSlipOkWarning('bank');

    if (bankAmount) bankAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
    if (bankNameDisplay) bankNameDisplay.textContent = streamerPaymentMethods.bank_name || '';
    if (bankAccountNumberDisplay) bankAccountNumberDisplay.textContent = streamerPaymentMethods.bank_account_number || '';
    if (bankAccountNameDisplay) bankAccountNameDisplay.textContent = streamerPaymentMethods.bank_account_name || '';

    btnProceedPayment.disabled = false;
    btnProceedPayment.textContent = 'ดำเนินการต่อ →';
  }
}, true);

function updateSlipOkWarning(method) {
  if (method === 'truemoney') {
    const warning = document.getElementById('trueMoneySlipokWarning');
    if (warning) {
      warning.style.display = streamerPaymentMethods.truemoney_slipok_connected ? 'none' : 'flex';
    }
  } else if (method === 'bank') {
    const warning = document.getElementById('bankSlipokWarning');
    if (warning) {
      warning.style.display = streamerPaymentMethods.slipok_connected ? 'none' : 'flex';
    }
  } else {
    const warning = document.getElementById('slipokWarning');
    if (warning) {
      warning.style.display = streamerPaymentMethods.slipok_connected ? 'none' : 'flex';
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

document.addEventListener('DOMContentLoaded', () => {
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

  loadPageContent();
  updateStatus();
  const statusBtn = document.getElementById('statusBtn');
  if (statusBtn) {
    statusBtn.addEventListener('click', updateStatus);
  }
});


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
