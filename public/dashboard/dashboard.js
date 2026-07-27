// ========== DOM Elements & Global State ==========
const DEMO_MODE = window.DEMO_MODE === true;
const DEMO_STREAMER = window.DEMO_STREAMER || 'KaminKub';

let allTransactions = [];
let activeTab = 'dashboard';
let _csrfToken = null;

const tabLoaded = {
  'overlay-config': false,
  'page-customization': false,
  'account': false,
  'payment-setup': false,
  'feedback': false,
};

// Popup OAuth callback: if this page opened as popup result, notify parent then close
(function() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('sl_linked') !== '1') return;
  params.delete('sl_linked');
  const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
  history.replaceState({}, '', clean);
  try {
    const bc = new BroadcastChannel('sl_oauth');
    bc.postMessage({ type: 'sl_linked', success: true });
    bc.close();
    window.close();
    return;
  } catch (e) {}
  // Not in popup — switch to conn-platform after dashboard init
  window._slLinkedOnLoad = true;
}());

// Identity collision / link result flags — read query params before DOM ready, handle in initializeDashboard
(function() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('twitch_conflict') === '1') {
    history.replaceState({}, '', window.location.pathname);
    window._twitchConflictOnLoad = true;
  } else if (params.get('twitch_linked') === '1') {
    history.replaceState({}, '', window.location.pathname);
    window._twitchLinkedOnLoad = true;
  } else if (params.get('sl_conflict') === '1') {
    history.replaceState({}, '', window.location.pathname);
    window._slConflictOnLoad = true;
  }
}());

function isWebm(url) { return url && /\.webm(\?|$)/i.test(url); }

function setMediaPreview(imgEl, url) {
  if (!imgEl || !url) return;
  const vidId = imgEl.id + '_vid';
  let vid = document.getElementById(vidId);
  if (isWebm(url)) {
    imgEl.style.display = 'none';
    if (!vid) {
      vid = document.createElement('video');
      vid.id = vidId;
      vid.autoplay = true; vid.loop = true; vid.muted = true; vid.playsInline = true;
      if (imgEl.width) vid.width = imgEl.width;
      if (imgEl.height) vid.height = imgEl.height;
      vid.className = imgEl.className;
      imgEl.insertAdjacentElement('afterend', vid);
    }
    vid.src = url;
    vid.style.display = '';
  } else {
    if (vid) vid.style.display = 'none';
    imgEl.src = url;
    imgEl.style.display = '';
  }
}

async function ensureCsrfToken() {
  if (_csrfToken) return _csrfToken;
  try {
    const res = await fetch('/api/csrf-token');
    if (res.ok) {
      const data = await res.json();
      _csrfToken = data.csrfToken;
    }
  } catch (e) {}
  return _csrfToken;
}

async function fetchWithCsrf(url, options = {}) {
  // DEMO MODE: block all non-GET except /api/demo/* endpoints
  if (DEMO_MODE && options.method && options.method.toUpperCase() !== 'GET') {
    if (!url.startsWith('/api/demo/')) {
      showNotification('Demo Mode — ไม่สามารถบันทึกได้', 'info');
      return { ok: false, status: 403, json: async () => ({}), _demoBlocked: true };
    }
  }
  const token = await ensureCsrfToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['X-CSRF-Token'] = token;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 403) {
    let body;
    try { body = await res.json(); } catch (e) { body = null; }
    if (body && body.code === 'CSRF_INVALID') {
      _csrfToken = null;
      const fresh = await ensureCsrfToken();
      headers['X-CSRF-Token'] = fresh;
      return fetch(url, { ...options, headers });
    }
    if (body !== null) {
      return { ok: false, status: 403, json: async () => body, headers: res.headers };
    }
  }
  return res;
}

// Sound Cache System
const soundCache = new SoundCacheManager('tipkub-sounds-v1');
const soundPlayer = new SoundPlayer(soundCache);

function showNotification(message, type = 'success') {
  console.log(`[Notification] ${type}: ${message}`);
  let container = document.querySelector('.notification-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'notification-container';
    document.body.appendChild(container);
  }

  const notification = document.createElement('div');
  notification.className = `notification ${type}`;

  const iconClass = type === 'success' ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark';
  const iconSpan = document.createElement('span');
  iconSpan.innerHTML = `<i class="${iconClass}"></i>`;
  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  notification.appendChild(iconSpan);
  notification.appendChild(msgSpan);
  
  container.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('fade-out');
    notification.addEventListener('animationend', () => notification.remove());
  }, 5000);
}

// ========== Copy-to-clipboard + open-in-new-tab helpers (L22/L23) ==========
// ponytail: shared by all copy-url-group instances (OBS overlay, account, page-customization)
function copyToClipboard(inputId, btnEl) {
  return () => {
    const input = document.getElementById(inputId);
    if (!input || !input.value) return;
    const text = input.value;
    // ponytail: detect icon-only button vs text button — ใช้ icon toggle สำหรับ compact/flat, text toggle สำหรับ legacy
    const isIconBtn = btnEl.classList.contains('copy-url-group__icon-btn');
    const origBg = btnEl.style.background;
    navigator.clipboard.writeText(text)
      .then(() => {
        if (isIconBtn) {
          const icon = btnEl.querySelector('i');
          if (icon) {
            // ponytail: เก็บ class เดิมไว้ใน dataset ก่อน toggle — ปลอดภัยกว่า innerHTML
            if (!btnEl.dataset.origIconClass) btnEl.dataset.origIconClass = icon.className;
            icon.className = 'fa-solid fa-check';
            btnEl.classList.add('is-copied');
          }
        } else {
          btnEl.dataset.origText = btnEl.dataset.origText || btnEl.textContent;
          btnEl.textContent = 'คัดลอกแล้ว!';
          btnEl.style.background = 'var(--success)';
        }
        setTimeout(() => {
          if (isIconBtn) {
            const icon = btnEl.querySelector('i');
            if (icon && btnEl.dataset.origIconClass) {
              icon.className = btnEl.dataset.origIconClass;
              btnEl.classList.remove('is-copied');
            }
          } else {
            btnEl.textContent = btnEl.dataset.origText || 'คัดลอก';
            btnEl.style.background = origBg;
          }
        }, 1500);
      })
      .catch(err => console.error('Failed to copy text: ', err));
  };
}

function openUrlInNewTab(inputId) {
  const input = document.getElementById(inputId);
  if (!input || !input.value) return;
  // ponytail: input value ตัด protocol ออกตาม L22 → ต้องเติม https:// กลับก่อน window.open (มิงั้น browser เปิด tab "untitled")
  const raw = input.value.trim();
  const hasProtocol = /^https?:\/\//i.test(raw);
  const url = hasProtocol ? raw : `https://${raw}`;
  window.open(url, '_blank', 'noopener');
}

// ========== Edit Account Modal (L20/L21) ==========
function openEditAccountModal() {
  const modal = document.getElementById('editAccountModal');
  const input = document.getElementById('editUsernameInput');
  if (!modal || !input) return;
  const current = document.getElementById('accUsername')?.textContent?.trim() || '';
  input.value = current;
  input.dataset.original = current;
  updateEditUsernameHint(input.value);
  modal.style.display = 'flex';
  modal.style.animation = 'modalFade 0.25s ease forwards';
  setTimeout(() => input.focus(), 50);
}

function closeEditAccountModal() {
  const modal = document.getElementById('editAccountModal');
  if (!modal) return;
  modal.style.animation = 'modalFadeOut 0.2s ease forwards';
  modal.addEventListener('animationend', function handler() {
    modal.style.display = 'none';
    modal.style.animation = '';
    modal.removeEventListener('animationend', handler);
  });
}

function updateEditUsernameHint(value) {
  const hint = document.getElementById('editUsernameHint');
  if (!hint) return;
  const v = (value || '').toLowerCase();
  if (!v) { hint.textContent = 'กรอก Username ใหม่ (3-30 ตัวอักษร)'; hint.style.color = 'var(--text-muted)'; return; }
  if (v.length < 3) { hint.textContent = `อีก ${3 - v.length} ตัวอักษร`; hint.style.color = '#ef4444'; return; }
  if (!/^[a-z0-9_]{3,30}$/.test(v)) { hint.textContent = 'ใช้ได้เฉพาะ a-z, 0-9, underscore'; hint.style.color = '#ef4444'; return; }
  hint.textContent = `✓ ${v.length} ตัวอักษร — ดูดี`; hint.style.color = '#10b981';
}

async function submitEditAccount() {
  const input = document.getElementById('editUsernameInput');
  const btn = document.getElementById('btnSaveEditAccount');
  if (!input || !btn) return;
  const value = input.value.toLowerCase().trim();
  if (value === (input.dataset.original || '').toLowerCase()) {
    showNotification('Username เดิม ไม่มีอะไรเปลี่ยน', 'info');
    return;
  }
  btn.disabled = true;
  const origHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...';
  try {
    const res = await fetchWithCsrf('/api/account/username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showNotification(data.error || 'เปลี่ยน Username ไม่สำเร็จ', 'error');
      return;
    }
    showNotification('เปลี่ยน Username สำเร็จ กำลังพาไปหน้าใหม่...', 'success');
    closeEditAccountModal();
    // Full page reload: URL path เปลี่ยน — SPA route ใช้ path-based ไม่ได้
    setTimeout(() => { window.location.href = data.redirectTo; }, 1200);
  } catch (err) {
    console.error('submitEditAccount error:', err);
    showNotification('เกิดข้อผิดพลาด กรุณาลองใหม่', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// ========== Demo Goal State (module-level so loadDemoGoalSettingsFromData can seed it) ==========
const demoGoalState = {
  current: 0,
  amount: 5000,
  label: 'ค่ากาแฟ',
  barColor: '#4ade80',
  barText: '{เปอร์เซนต์}',
  subtitle1: '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿',
  subtitle2: ''
};

async function sendDemoGoalUpdate() {
  try {
    await fetch('/api/demo/goal/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...demoGoalState })
    });
    updateGoalPreview(demoGoalState.current, demoGoalState.amount);
  } catch (e) { console.error('Demo goal update failed:', e); }
}

async function initializeDashboard() {
  console.log('🚀 Starting initializeDashboard...');
  try {
    // ponytail: Widget shortcut intro — ไล่ highlight ทีละปุ่ม วน 3 รอบ, สีตาม semantic ของแต่ละ widget
    // ย้ายมาก่อน DEMO_MODE branch เพื่อให้รันทั้ง demo + real mode (เดิมอยู่หลัง `if (DEMO_MODE) return;` เลยไม่เคยรันใน demo)
    const SHORTCUT_INTRO_COLORS = {
      alert: '#f59e0b', goal: '#4ade80', timer: '#fbbf24',
      leaderboard: '#a855f7', recentdonate: '#06b6d4', topdonor: '#6366f1'
    };
    function shortcutHexToRgba(hex, a) {
      const h = hex.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    function playWidgetShortcutIntro() {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const dest = document.getElementById('widgetShortcutToggle');
      if (!dest) return;
      const btns = Array.from(dest.querySelectorAll('button.subtab-btn[data-widget-subtab]'));
      if (!btns.length) return;
      // 1→5 ครั้งเดียว = [0,1,2,3,4] = 5 สเต็ป; STEP 300ms → รวม 1.5s
      const seq = [];
      for (let i = 0; i < btns.length; i++) seq.push(i);
      const STEP = 300;
      let p = 0;
      (function step() {
        if (p >= seq.length) return;
        const btn = btns[seq[p]];
        const c = SHORTCUT_INTRO_COLORS[btn.getAttribute('data-widget-subtab')] || '#fbbf24';
        btn.style.setProperty('--intro-color', c);
        btn.style.setProperty('--intro-bg', shortcutHexToRgba(c, 0.14));
        btn.style.setProperty('--intro-glow', shortcutHexToRgba(c, 0.6));
        btn.classList.add('shortcut-intro');
        setTimeout(() => btn.classList.remove('shortcut-intro'), STEP - 10);
        p++;
        setTimeout(step, STEP);
      })();
    }

    // ponytail: Widget shortcut card (OBS Setup Card repurposed) — clone ปุ่มจาก #widgetSubtabToggle
    // ไป #widgetShortcutToggle (ก๊อปปี้ ไม่ย้าย) เพื่อหลีก ID ซ้ำ; กดแล้วพาไป tab overlay-config + สลับ subtab.
    // รองรับปุ่มอนาคต: อ่านจาก data-widget-subtab ของปุ่มต้นฉบับ ใครมี attr นี้ถูก clone หมด
    const srcToggle = document.getElementById('widgetSubtabToggle');
    const destToggle = document.getElementById('widgetShortcutToggle');
    if (srcToggle && destToggle) {
      srcToggle.querySelectorAll('button.subtab-btn[data-widget-subtab]').forEach((srcBtn) => {
        const key = srcBtn.getAttribute('data-widget-subtab');
        if (!key) return;
        const clone = srcBtn.cloneNode(true);
        clone.id = `widgetShortcut-${key}`;
        clone.classList.remove('active'); // ปุ่มลัด = navigate-only, ไม่โชว์ active state
        clone.setAttribute('title', `ไปตั้งค่า${srcBtn.textContent.trim()}`);
        clone.addEventListener('click', () => {
          switchTab('overlay-config');
          // คลิกปุ่มต้นฉบับเพื่อ reuse switchWidgetSubtab/demoSwitchSubtab (active + preview + load) ทั้งหมด
          const target = srcToggle.querySelector(`button.subtab-btn[data-widget-subtab="${key}"]`);
          if (target) target.click();
        });
        destToggle.appendChild(clone);
      });

      // [Requirement #9] ปุ่มที่ 6 — ไม่ได้ clone จาก widget subtab, สร้างเองเพราะพาไปคนละหน้า (tab-transactions ไม่ใช่ tab-overlay-config)
      // [UI Fix] แยกชั้นเป็นแถวของตัวเอง + label กันสับสนว่าเป็นวิดเจ็ตแบบเดียวกับปุ่มอื่น
      const topdonorGroup = document.createElement('div');
      topdonorGroup.className = 'widget-shortcut-topdonor-group';

      const topdonorLabel = document.createElement('span');
      topdonorLabel.className = 'widget-shortcut-topdonor-label';
      topdonorLabel.innerHTML = '<i class="fa-solid fa-grip-lines"></i> ประวัติสะสม';

      const topdonorBtn = document.createElement('button');
      topdonorBtn.type = 'button';
      topdonorBtn.id = 'widgetShortcut-topdonor';
      topdonorBtn.className = 'subtab-btn subtab-btn--topdonor';
      topdonorBtn.setAttribute('data-widget-subtab', 'topdonor');
      topdonorBtn.setAttribute('title', 'ไปหน้าประวัติผู้โดเนทสูงสุด');
      topdonorBtn.innerHTML = '<i class="fa-solid fa-ranking-star"></i> ประวัติผู้โดเนทสูงสุด';
      topdonorBtn.addEventListener('click', () => {
        switchTab('transactions');
        const btn = document.getElementById('btnTxSubviewTopdonor');
        if (btn) btn.click();
      });

      topdonorGroup.appendChild(topdonorLabel);
      topdonorGroup.appendChild(topdonorBtn);
      destToggle.appendChild(topdonorGroup);

      // เล่น intro animation ทุกครั้งที่เข้า dashboard (perf: async + composite-only, ไม่ block load)
      // debug: window.playWidgetShortcutIntro() เพื่อเล่นซ้ำ
      window.playWidgetShortcutIntro = playWidgetShortcutIntro;
      setTimeout(playWidgetShortcutIntro, 400);
    }

    if (DEMO_MODE) {
      // Tab switching + mobile menu (normally set up later in normal flow)
      const wrapper = document.querySelector('.admin-wrapper');
      const btnMobileMenu = document.getElementById('btnMobileMenu');
      if (btnMobileMenu && wrapper) {
        btnMobileMenu.onclick = () => wrapper.classList.toggle('mobile-menu-active');
      }
      const btnCloseMobileMenu = document.getElementById('btnCloseMobileMenu');
      if (btnCloseMobileMenu && wrapper) {
        btnCloseMobileMenu.onclick = () => wrapper.classList.remove('mobile-menu-active');
      }
      document.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (wrapper) wrapper.classList.remove('mobile-menu-active');
          const tab = e.currentTarget.getAttribute('data-tab');
          if (tab) switchTab(tab);
        });
      });

      // Close sidebar when tapping outside (mobile UX parity with normal mode)
      document.addEventListener('click', (event) => {
        const sidebar = document.querySelector('.admin-sidebar');
        if (wrapper && wrapper.classList.contains('mobile-menu-active')) {
          if (sidebar && !sidebar.contains(event.target) && event.target !== btnMobileMenu) {
            wrapper.classList.remove('mobile-menu-active');
          }
        }
      });

      initHeaderBgPreview();
      await loadDemoSettings();
      await loadDemoTransactions();
      applyDemoRestrictions();
      injectDemoBanner();

      // Donate page links → KaminKub's real page
      ['btnOpenDonateDesktop', 'btnOpenDonateMobile'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.href = '/kaminkub';
      });

      // Quick Alert buttons → fire real alert via demo endpoint
      const demoAlertHandler = async () => {
        const names = ['สมศักดิ์ รักเรียน', 'แม่ค้าออนไลน์สายลุย', 'น้องเป็ดก้าบๆ 🐤', 'สุดหล่อคีย์บอร์ดเรืองแสง', 'SuraGaming 🎮', 'ผู้สนับสนุนลึกลับ'];
        const msgs = ['สู้ๆ นะครับ! 💪', 'ขอเพลงชิลๆ เพลงนึงค่าา 🎵', 'ระบบใหม่เฟี้ยวมากครับ! ✨', 'บริจาคค่าน้ำเก๊กฮวยเย็นๆ 🍺', 'ชอบเว็บนี้มาก 🚀'];
        const amounts = [50, 100, 250, 500, 1000];
        const donor   = names[Math.floor(Math.random() * names.length)];
        const message = msgs[Math.floor(Math.random() * msgs.length)];
        const amount  = amounts[Math.floor(Math.random() * amounts.length)];
        try {
          const res = await fetch('/api/demo/alerts/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ donor, amount, message })
          });
          if (res.ok) showNotification('ส่ง Alert ทดสอบแล้ว!', 'success');
          else if (res.status === 429) showNotification('ส่ง Alert บ่อยเกินไป กรุณารอสักครู่', 'error');
        } catch (e) { console.error('Demo alert failed:', e); }
      };
      ['btnQuickTestAlert', 'btnQuickTestAlertMobile'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
        btn.onclick = demoAlertHandler;
      });

      // Overlay subtab buttons (Alert vs Goal vs Timer)
      const demoSubtabAlert = document.getElementById('btnSubtabAlert');
      const demoSubtabGoal  = document.getElementById('btnSubtabGoal');
      const demoSubtabTimer = document.getElementById('btnSubtabTimer');
      const demoSubtabLeaderboard = document.getElementById('btnSubtabLeaderboard');
      const demoSubtabRecentdonate = document.getElementById('btnSubtabRecentdonate');

      function demoSwitchSubtab(active) {
        const showAlert = active === 'alert';
        const showGoal  = active === 'goal';
        const showTimer = active === 'timer';
        const showLeaderboard = active === 'leaderboard';
        const showRecentdonate = active === 'recentdonate';
        document.getElementById('overlaySettingsForm')?.style.setProperty('display', showAlert ? '' : 'none');
        document.getElementById('goalSettingsPanel')?.style.setProperty('display', showGoal ? '' : 'none');
        document.getElementById('timerSettingsPanel')?.style.setProperty('display', showTimer ? '' : 'none');
        document.getElementById('leaderboardSettingsPanel')?.style.setProperty('display', showLeaderboard ? '' : 'none');
        document.getElementById('recentdonateSettingsPanel')?.style.setProperty('display', showRecentdonate ? '' : 'none');
        document.getElementById('alertPreviewCard')?.style.setProperty('display', showAlert ? '' : 'none');
        document.getElementById('goalPreviewCard')?.style.setProperty('display', showGoal ? '' : 'none');
        document.getElementById('timerPreviewCard')?.style.setProperty('display', showTimer ? '' : 'none');
        document.getElementById('leaderboardPreviewCard')?.style.setProperty('display', showLeaderboard ? '' : 'none');
        document.getElementById('recentdonatePreviewCard')?.style.setProperty('display', showRecentdonate ? '' : 'none');
        if (demoSubtabAlert) demoSubtabAlert.classList.toggle('active', showAlert);
        if (demoSubtabGoal)  demoSubtabGoal.classList.toggle('active', showGoal);
        if (demoSubtabTimer) demoSubtabTimer.classList.toggle('active', showTimer);
        if (demoSubtabLeaderboard) demoSubtabLeaderboard.classList.toggle('active', showLeaderboard);
        if (demoSubtabRecentdonate) demoSubtabRecentdonate.classList.toggle('active', showRecentdonate);
        if (showAlert) { activateOverlayPreview(); deactivateGoalBarPreview(); deactivateTimerPreview(); deactivateLeaderboardPreview(); deactivateRecentdonatePreview(); }
        if (showGoal)  { deactivateOverlayPreview(); activateGoalBarPreview(); deactivateTimerPreview(); deactivateLeaderboardPreview(); deactivateRecentdonatePreview(); }
        if (showTimer) { deactivateOverlayPreview(); deactivateGoalBarPreview(); activateTimerPreview(); deactivateLeaderboardPreview(); deactivateRecentdonatePreview(); }
        if (showLeaderboard) { deactivateOverlayPreview(); deactivateGoalBarPreview(); deactivateTimerPreview(); activateLeaderboardPreview(); deactivateRecentdonatePreview(); }
        if (showRecentdonate) { deactivateOverlayPreview(); deactivateGoalBarPreview(); deactivateTimerPreview(); deactivateLeaderboardPreview(); activateRecentdonatePreview(); }
      }

      if (demoSubtabAlert) demoSubtabAlert.addEventListener('click', () => demoSwitchSubtab('alert'));
      if (demoSubtabGoal)  demoSubtabGoal.addEventListener('click', () => demoSwitchSubtab('goal'));
      if (demoSubtabTimer) demoSubtabTimer.addEventListener('click', () => demoSwitchSubtab('timer'));
      if (demoSubtabLeaderboard) demoSubtabLeaderboard.addEventListener('click', () => demoSwitchSubtab('leaderboard'));
      if (demoSubtabRecentdonate) demoSubtabRecentdonate.addEventListener('click', () => demoSwitchSubtab('recentdonate'));

      // Activate alert subtab by default
      // NOTE: do NOT call activateOverlayPreview() here — iframe must only load
      // when user actually navigates to the overlay-config tab (switchTab handles it)
      demoSwitchSubtab('alert');

      // Set demo overlay URLs to production domain instead of localhost:3000
      const demoOverlayUrl = `${location.origin}/demo/overlay`;
      const obsUrlLeft = document.getElementById('obsOverlayUrl');
      if (obsUrlLeft) obsUrlLeft.value = demoOverlayUrl;
      const obsUrlPreview = document.getElementById('obsOverlayUrlPreview');
      if (obsUrlPreview) obsUrlPreview.value = demoOverlayUrl;

      // Demo goal bar quick-add buttons: call /api/demo/goal/test instead of blocked fetchWithCsrf
      document.querySelectorAll('.btn-goal-quick').forEach(btn => {
        btn.onclick = async () => {
          const delta = parseFloat(btn.dataset.val) || 0;
          demoGoalState.current = Math.max(0, demoGoalState.current + delta);
          await sendDemoGoalUpdate();
        };
      });

      // Override global transaction functions for demo safety
      window.forceSuccessTransaction = () => showDemoBlockModal();
      window.simulateTransactionAlert = async (id) => {
        const tx = allTransactions.find(t => t.id === id);
        if (!tx) return;
        try {
          await fetch('/api/demo/alerts/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ donor: tx.donor, amount: tx.amount, message: tx.message })
          });
          showNotification('ส่ง Alert ซ้ำแล้ว!', 'success');
        } catch (e) { console.error('Demo re-alert failed:', e); }
      };

      // Prevent form submit buttons from reloading the page — show demo modal instead
      const overlayForm = document.getElementById('overlaySettingsForm');
      if (overlayForm) overlayForm.onsubmit = (e) => { e.preventDefault(); showDemoBlockModal(); };
      const pageForm = document.getElementById('pageSettingsForm');
      if (pageForm) pageForm.onsubmit = (e) => { e.preventDefault(); showDemoBlockModal(); };

      // Enable payment panel expand/collapse so visitors can browse settings
      setupDemoPaymentHandlers();

      return;
    }

    // 1. Data Load
    console.log('📡 Triggering data loads...');
    fetchTransactions();
    fetchUserPaymentStatus();

    const btnMobileMenu = document.getElementById('btnMobileMenu');
    const wrapper = document.querySelector('.admin-wrapper');

    if (btnMobileMenu && wrapper) {
      btnMobileMenu.onclick = () => {
        console.log('📱 Mobile menu toggled');
        wrapper.classList.toggle('mobile-menu-active');
      };
    }

    const btnCloseMobileMenu = document.getElementById('btnCloseMobileMenu');
    if (btnCloseMobileMenu && wrapper) {
      btnCloseMobileMenu.onclick = () => {
        wrapper.classList.remove('mobile-menu-active');
      };
    }

    document.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', () => {
        if (wrapper) wrapper.classList.remove('mobile-menu-active');
      });
    });

    document.addEventListener('click', (event) => {
      const sidebar = document.querySelector('.admin-sidebar');
      if (wrapper && wrapper.classList.contains('mobile-menu-active')) {
        if (sidebar && !sidebar.contains(event.target) && event.target !== btnMobileMenu) {
          wrapper.classList.remove('mobile-menu-active');
        }
      }
    });

    // Robust username extraction
    const path = window.location.pathname;
    console.log(`📍 Current path: ${path}`);
    const pathParts = path.split('/').filter(p => p);
    let username = pathParts[0];
    
    const reserved = ['dashboard', 'login', 'auth', 'api', 'overlay', 'alert-test', 'thank-you', 'register'];
    if (username && reserved.includes(username.toLowerCase())) {
      console.warn(`⚠️ Path segment "${username}" is a reserved word. User not found in URL.`);
      username = null;
    }

    console.log(`👤 Detected username from URL: ${username}`);

    if (username) {
      const btnOpenDesktop = document.getElementById('btnOpenDonateDesktop');
      const btnOpenMobile = document.getElementById('btnOpenDonateMobile');
      if (btnOpenDesktop) btnOpenDesktop.href = `/${username}`;
      if (btnOpenMobile) btnOpenMobile.href = `/${username}`;
    }

    const socialInputs = [
      'socialTwitch', 'socialYoutube', 'socialTiktok', 
      'socialFacebook', 'socialX', 'socialDiscord', 'socialInstagram'
    ];
    
    socialInputs.forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('input', () => {
          const errorSpan = document.getElementById(`err-${id}`);
          if (!validateUrl(input.value.trim())) {
            input.classList.add('input-error');
            if (errorSpan) errorSpan.style.display = 'block';
          } else {
            input.classList.remove('input-error');
            if (errorSpan) errorSpan.style.display = 'none';
          }
        });
      }
    });

    const pageForm = document.getElementById('pageSettingsForm');
    if (pageForm) {
      pageForm.onsubmit = savePageSettings;
    }

    const profileImageFileEl = document.getElementById('profileImageFile');
    if (profileImageFileEl) profileImageFileEl.onchange = handleProfileImageSelect;

    const headerBgFileEl = document.getElementById('headerBgFile');
    if (headerBgFileEl) headerBgFileEl.onchange = handleHeaderBgSelect;

    const pageBgFileEl = document.getElementById('pageBgFile');
    if (pageBgFileEl) pageBgFileEl.onchange = handlePageBgSelect;

    function initHeaderBgPreview() {
      // Header BG — URL input shows/hides controls + updates preview
      const headerBgUrlInput = document.getElementById('inputHeaderBgUrl');
      const headerBgControlsDiv = document.getElementById('headerBgControls');
      const headerBgDragPreview = document.getElementById('headerBgDragPreview');
      const headerBgYInput = document.getElementById('inputHeaderBgY');
      const headerBgYDisp = document.getElementById('headerBgYDisplay');
      const headerBgSpinner = document.getElementById('headerBgSpinner');

      // Header display ratio: card max-width 440px / header height 170px
      const HEADER_FIT_RATIO = (440 / 170) * 0.9; // ~2.33 — images this wide or wider fit naturally

      function setHint(hint, iconClass, iconColor, text) {
        hint.textContent = '';
        const icon = document.createElement('i');
        icon.className = iconClass;
        icon.style.color = iconColor;
        hint.appendChild(icon);
        hint.appendChild(document.createTextNode(' ' + text));
      }

      function updateHeaderBgPreview() {
        if (!headerBgDragPreview || !headerBgUrlInput) return;
        const url = headerBgUrlInput.value;
        if (!url) return;
        if (isWebm(url)) {
          headerBgDragPreview.style.backgroundImage = 'none';
          let vid = headerBgDragPreview.querySelector('video.header-bg-vid');
          if (!vid) {
            vid = document.createElement('video');
            vid.className = 'header-bg-vid';
            vid.autoplay = true; vid.loop = true; vid.muted = true; vid.playsInline = true;
            Object.assign(vid.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '0', pointerEvents: 'none' });
            headerBgDragPreview.style.position = 'relative';
            headerBgDragPreview.style.overflow = 'hidden';
            headerBgDragPreview.insertBefore(vid, headerBgDragPreview.firstChild);
          }
          vid.src = url;
          if (headerBgSpinner) headerBgSpinner.style.display = 'none';
          headerBgDragPreview.dataset.fitsNaturally = '1';
          const hint = headerBgDragPreview.querySelector('[data-hint]');
          if (hint) setHint(hint, 'fa-solid fa-video', '#60a5fa', 'WebM Animation');
        } else {
          const vid = headerBgDragPreview.querySelector('video.header-bg-vid');
          if (vid) vid.remove();
          headerBgDragPreview.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
          const img = new Image();
          img.onload = function () {
            if (headerBgSpinner) headerBgSpinner.style.display = 'none';
            const fitsNaturally = (img.naturalWidth / img.naturalHeight) >= HEADER_FIT_RATIO;
            headerBgDragPreview.dataset.fitsNaturally = fitsNaturally ? '1' : '0';
            const hint = headerBgDragPreview.querySelector('[data-hint]');
            if (fitsNaturally) {
              headerBgDragPreview.style.backgroundSize = 'contain';
              headerBgDragPreview.style.backgroundPosition = 'center center';
              headerBgDragPreview.style.cursor = 'default';
              if (hint) setHint(hint, 'fa-solid fa-check', '#4ade80', 'ภาพพอดีกับ Header อัตโนมัติ');
            } else {
              const y = headerBgYInput ? headerBgYInput.value : 0;
              headerBgDragPreview.style.backgroundSize = 'cover';
              headerBgDragPreview.style.backgroundPositionY = `${y}%`;
              headerBgDragPreview.style.cursor = 'grab';
              if (hint) setHint(hint, 'fa-solid fa-up-down', '#f59e0b', 'ลากขึ้น-ลงเพื่อปรับตำแหน่ง');
            }
          };
          img.onerror = function () {
            if (headerBgSpinner) headerBgSpinner.style.display = 'none';
            headerBgDragPreview.dataset.fitsNaturally = '0';
            const y = headerBgYInput ? headerBgYInput.value : 0;
            headerBgDragPreview.style.backgroundSize = 'cover';
            headerBgDragPreview.style.backgroundPositionY = `${y}%`;
            headerBgDragPreview.style.cursor = 'grab';
          };
          img.src = url;
        }
      }

      if (headerBgUrlInput && headerBgControlsDiv) {
        let headerBgDebounce = null;
        headerBgUrlInput.addEventListener('input', () => {
          const hasUrl = !!headerBgUrlInput.value;
          headerBgControlsDiv.classList.toggle('is-open', hasUrl);
          clearTimeout(headerBgDebounce);
          if (hasUrl) {
            if (headerBgSpinner) headerBgSpinner.style.display = 'flex';
            headerBgDebounce = setTimeout(updateHeaderBgPreview, 400);
          } else {
            if (headerBgSpinner) headerBgSpinner.style.display = 'none';
          }
        });
      }

      // Drag-to-position on headerBgDragPreview
      if (headerBgDragPreview && headerBgYInput) {
        let isDraggingBg = false;
        let bgDragStartY = 0;
        let bgDragStartPosY = 0;

        function applyBgY(newY) {
          if (headerBgDragPreview.dataset.fitsNaturally === '1') return;
          const clamped = Math.max(0, Math.min(100, newY));
          headerBgYInput.value = clamped;
          headerBgDragPreview.style.backgroundPositionY = `${clamped}%`;
          if (headerBgYDisp) headerBgYDisp.textContent = Math.round(clamped);
        }

        headerBgDragPreview.addEventListener('mousedown', (e) => {
          if (headerBgDragPreview.dataset.fitsNaturally === '1') return;
          isDraggingBg = true;
          bgDragStartY = e.clientY;
          bgDragStartPosY = parseFloat(headerBgYInput.value) || 0;
          headerBgDragPreview.style.cursor = 'grabbing';
          e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
          if (!isDraggingBg) return;
          applyBgY(bgDragStartPosY + (e.clientY - bgDragStartY) * 0.5);
        });
        document.addEventListener('mouseup', () => {
          if (isDraggingBg) {
            isDraggingBg = false;
            if (headerBgDragPreview.dataset.fitsNaturally !== '1') headerBgDragPreview.style.cursor = 'grab';
          }
        });

        // Touch support
        headerBgDragPreview.addEventListener('touchstart', (e) => {
          if (headerBgDragPreview.dataset.fitsNaturally === '1') return;
          isDraggingBg = true;
          bgDragStartY = e.touches[0].clientY;
          bgDragStartPosY = parseFloat(headerBgYInput.value) || 0;
          e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', (e) => {
          if (!isDraggingBg) return;
          applyBgY(bgDragStartPosY + (e.touches[0].clientY - bgDragStartY) * 0.5);
        }, { passive: false });
        document.addEventListener('touchend', () => { isDraggingBg = false; });
      }
    }

    initHeaderBgPreview();

    const btnReloadPage = document.getElementById('btnReloadPagePreview');
    if (btnReloadPage) {
      btnReloadPage.onclick = () => {
        btnReloadPage.classList.add('spinning');
        updatePagePreview();
        setTimeout(() => btnReloadPage.classList.remove('spinning'), 1200);
      };
    }

    const btnQuickAlert = document.getElementById('btnQuickTestAlert');
    if (btnQuickAlert) btnQuickAlert.onclick = triggerRandomTestAlert;

    const btnQuickAlertMobile = document.getElementById('btnQuickTestAlertMobile');
    if (btnQuickAlertMobile) btnQuickAlertMobile.onclick = triggerRandomTestAlert;

    const btnReloadPreview = document.getElementById('btnReloadPreview');
    if (btnReloadPreview) {
      btnReloadPreview.onclick = () => {
        btnReloadPreview.classList.add('spinning');
        const iframe = document.getElementById('overlayPreviewIframe');
        if (iframe) iframe.src = iframe.src;
        setTimeout(() => btnReloadPreview.classList.remove('spinning'), 1200);
      };
    }

    // Slider Real-time Updates
    const sliders = [
      { id: 'sliderDuration', lbl: 'lblDuration', fn: v => v },
      { id: 'sliderSoundVolume', lbl: 'lblSoundVolume', fn: v => Math.round(v * 100) },
      { id: 'sliderTtsVolume', lbl: 'lblTtsVolume', fn: v => Math.round(v * 100) },
      { id: 'sliderTtsRate', lbl: 'lblTtsRate', fn: v => (Number(v) - 0.3).toFixed(1) },
      { id: 'sliderGoalAnimVolume', lbl: 'lblGoalAnimVolume', fn: v => Math.round(v * 100) },
      { id: 'sliderTimerAnimVolume', lbl: 'lblTimerAnimVolume', fn: v => Math.round(v * 100) },
    ];

    sliders.forEach(s => {
      const el = document.getElementById(s.id);
      const lbl = document.getElementById(s.lbl);
      if (el && lbl) {
        el.oninput = (e) => {
          lbl.textContent = s.fn(e.target.value);
        };
      }
    });

    const soundChoiceSelect = document.getElementById('soundChoiceSelect');
    if (soundChoiceSelect) {
      soundChoiceSelect.onchange = (e) => {
        toggleCustomSoundUrlContainer(e.target.value);
      };
    }

    const customImageModeEl = document.getElementById('customImageMode');
    if (customImageModeEl) {
      customImageModeEl.onchange = (e) => toggleCustomImageUI(e.target.value);
    }

    const customImageFileEl = document.getElementById('customImageFile');
    if (customImageFileEl) {
      customImageFileEl.onchange = handleImageFileSelect;
    }

    const uploadSoundFileEl = document.getElementById('uploadSoundFile');
    if (uploadSoundFileEl) {
      uploadSoundFileEl.onchange = handleAudioFileSelect;
    }

    const btnClearProfileEl = document.getElementById('btnClearProfileImage');
    if (btnClearProfileEl) btnClearProfileEl.onclick = clearProfileImage;

    const btnClearHeaderEl = document.getElementById('btnClearHeaderBg');
    if (btnClearHeaderEl) btnClearHeaderEl.onclick = clearHeaderBg;

    const btnClearPageBgEl = document.getElementById('btnClearPageBg');
    if (btnClearPageBgEl) btnClearPageBgEl.onclick = clearPageBg;

    const btnClearCustomImgEl = document.getElementById('btnClearCustomImage');
    if (btnClearCustomImgEl) btnClearCustomImgEl.onclick = clearCustomImage;

    const btnClearSoundEl = document.getElementById('btnClearUploadSound');
    if (btnClearSoundEl) btnClearSoundEl.onclick = clearUploadSound;

    const btnBrowseSounds = document.getElementById('btnBrowseSounds');
    if (btnBrowseSounds) {
      btnBrowseSounds.onclick = () => openSoundBrowser('customSoundUrl');
    }

    const btnCloseSoundBrowser = document.getElementById('btnCloseSoundBrowser');
    if (btnCloseSoundBrowser) {
      btnCloseSoundBrowser.onclick = closeSoundBrowser;
    }

    const btnSoundSearch = document.getElementById('btnSoundSearch');
    if (btnSoundSearch) {
      btnSoundSearch.onclick = searchSounds;
    }

    const soundSearchInput = document.getElementById('soundSearchInput');
    if (soundSearchInput) {
      soundSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') searchSounds();
      });
    }

    const soundBrowserModal = document.getElementById('soundBrowserModal');
    if (soundBrowserModal) {
      soundBrowserModal.addEventListener('click', (e) => {
        if (e.target === soundBrowserModal) closeSoundBrowser();
      });
    }

    // Tier Donate (TIER_DONATE_BLUEPRINT.md § 3)
    [1, 2, 3].forEach(slot => {
      const ids = TIER_IMAGE_SLOT_IDS[slot];
      const fileEl = document.getElementById(ids.file);
      if (fileEl) fileEl.onchange = (e) => handleTierImageFileSelect(slot, e);
      const clearEl = document.getElementById(ids.clear);
      if (clearEl) clearEl.onclick = () => clearTierImage(slot);
    });
    const btnManageSoundLibraryEl = document.getElementById('btnManageSoundLibrary');
    if (btnManageSoundLibraryEl) btnManageSoundLibraryEl.onclick = openSoundLibraryModal;
    const btnCloseSoundLibraryEl = document.getElementById('btnCloseSoundLibrary');
    if (btnCloseSoundLibraryEl) btnCloseSoundLibraryEl.onclick = closeSoundLibraryModal;
    const soundLibraryModalEl = document.getElementById('soundLibraryModal');
    if (soundLibraryModalEl) {
      soundLibraryModalEl.addEventListener('click', (e) => {
        if (e.target === soundLibraryModalEl) closeSoundLibraryModal();
      });
    }
    const btnManageTierImageLibraryEl = document.getElementById('btnManageTierImageLibrary');
    if (btnManageTierImageLibraryEl) btnManageTierImageLibraryEl.onclick = openTierImageLibraryModal;
    const btnCloseTierImageLibraryEl = document.getElementById('btnCloseTierImageLibrary');
    if (btnCloseTierImageLibraryEl) btnCloseTierImageLibraryEl.onclick = closeTierImageLibraryModal;
    const tierImageLibraryModalEl = document.getElementById('tierImageLibraryModal');
    if (tierImageLibraryModalEl) {
      tierImageLibraryModalEl.addEventListener('click', (e) => {
        if (e.target === tierImageLibraryModalEl) closeTierImageLibraryModal();
      });
    }
    const soundLibraryFileEl = document.getElementById('soundLibraryFile');
    if (soundLibraryFileEl) soundLibraryFileEl.onchange = handleSoundLibraryFileSelect;

    // Real-time brand glow update
    const glowPicker = document.getElementById('profileGlowColor');
    const glowText = document.getElementById('txtProfileGlowColor');
    if (glowPicker) {
      glowPicker.oninput = (e) => {
        if (glowText) glowText.value = e.target.value;
        updateBrandGlow(e.target.value);
      };
    }
    if (glowText) {
      glowText.oninput = (e) => {
        if (glowPicker) {
          if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) {
            glowPicker.value = e.target.value;
          }
        }
        updateBrandGlow(e.target.value);
      };
    }

    const btnCopyObsUrl = document.getElementById('btnCopyObsUrl');
    const btnOpenObsUrl = document.getElementById('btnOpenObsUrl');

    if (btnCopyObsUrl) {
      btnCopyObsUrl.onclick = () => {
        const copyText = document.getElementById('obsOverlayUrl');
        if (!copyText) return;
        copyText.select();
        copyText.setSelectionRange(0, 99999);
        
        navigator.clipboard.writeText(copyText.value)
          .then(() => {
            const orig = btnCopyObsUrl.textContent;
            btnCopyObsUrl.textContent = 'คัดลอกแล้ว!';
            btnCopyObsUrl.style.background = 'var(--success)';
            
            setTimeout(() => {
              btnCopyObsUrl.textContent = orig;
              btnCopyObsUrl.style.background = '';
            }, 1500);
          })
          .catch(err => {
            console.error('Failed to copy text: ', err);
          });
      };
    }

    if (btnOpenObsUrl) {
      btnOpenObsUrl.onclick = () => {
        const urlInput = document.getElementById('obsOverlayUrl');
        if (urlInput && urlInput.value) {
          window.open(urlInput.value, '_blank');
        }
      };
    }

    const btnCopyObsUrlPreview = document.getElementById('btnCopyObsUrlPreview');
    const btnOpenObsUrlPreview = document.getElementById('btnOpenObsUrlPreview');

    if (btnCopyObsUrlPreview) btnCopyObsUrlPreview.onclick = copyToClipboard('obsOverlayUrlPreview', btnCopyObsUrlPreview);
    if (btnOpenObsUrlPreview) {
      btnOpenObsUrlPreview.onclick = () => openUrlInNewTab('obsOverlayUrlPreview');
    }

    // L23: copy-url-group ในหน้า Account (no-border variant — icon-only button)
    const btnCopyAccountDonateUrl = document.getElementById('btnCopyAccountDonateUrl');
    if (btnCopyAccountDonateUrl) btnCopyAccountDonateUrl.onclick = copyToClipboard('accountDonateUrlPreview', btnCopyAccountDonateUrl);

    // L22: copy-url-group ในหน้า Page Customization (compact variant — ย้ายมาใต้ Page Preview นอก form)
    const btnCopyPageCustomizationDonateUrl = document.getElementById('btnCopyPageCustomizationDonateUrl');
    if (btnCopyPageCustomizationDonateUrl) btnCopyPageCustomizationDonateUrl.onclick = copyToClipboard('pageCustomizationDonateUrlPreview', btnCopyPageCustomizationDonateUrl);

    // Edit Account Modal (L20/L21) — bind once at init
    const btnOpenEditAccount = document.getElementById('btnOpenEditAccount');
    if (btnOpenEditAccount) btnOpenEditAccount.onclick = openEditAccountModal;
    const btnCloseEditAccount = document.getElementById('btnCloseEditAccount');
    if (btnCloseEditAccount) btnCloseEditAccount.onclick = closeEditAccountModal;
    const btnCancelEditAccount = document.getElementById('btnCancelEditAccount');
    if (btnCancelEditAccount) btnCancelEditAccount.onclick = closeEditAccountModal;
    const btnSaveEditAccount = document.getElementById('btnSaveEditAccount');
    if (btnSaveEditAccount) btnSaveEditAccount.onclick = submitEditAccount;
    const editUsernameInput = document.getElementById('editUsernameInput');
    if (editUsernameInput) {
      editUsernameInput.addEventListener('input', (e) => {
        // auto-lowercase + strip invalid chars client-side (server validates again)
        let v = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (v !== e.target.value) e.target.value = v;
        updateEditUsernameHint(v);
      });
      editUsernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitEditAccount(); }
        if (e.key === 'Escape') { e.preventDefault(); closeEditAccountModal(); }
      });
    }
    const editAccountModal = document.getElementById('editAccountModal');
    if (editAccountModal) {
      editAccountModal.addEventListener('click', (e) => {
        if (e.target === editAccountModal) closeEditAccountModal();
      });
    }

    async function updateObsUrl() {
      try {
        const response = await fetch('/api/overlay/token');
        if (response.ok) {
          const { token } = await response.json();
          const host = window.location.origin;
          const url = `${host}/overlay?token=${token}`;
          const urlInput = document.getElementById('obsOverlayUrl');
          if (urlInput) urlInput.value = url;
          const urlInputPreview = document.getElementById('obsOverlayUrlPreview');
          if (urlInputPreview) urlInputPreview.value = url;
        } else {
          console.warn(`⚠️ Token request failed: ${response.status}`);
        }
      } catch (err) {
        console.error('Error updating OBS URL:', err);
      }
    }

    async function updateOverlayStatus() {
      try {
        const response = await fetch('/api/overlay/status');
        if (response.ok) {
          const { active } = await response.json();
          const pill = document.getElementById('overlayStatusPill');
          if (pill) {
            if (active) {
              pill.className = 'status-pill online';
              pill.innerHTML = 'Overlay Connected';
            } else {
              pill.className = 'status-pill offline';
              pill.innerHTML = 'Overlay Offline';
            }
          }
        }
      } catch (err) {
        console.error('Error updating overlay status:', err);
      }
    }

    updateObsUrl();
    updateOverlayStatus();
    setInterval(updateOverlayStatus, 30000); // Check every 30 seconds

    document.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        switchTab(tab);
      });
    });

    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
      themeSelect.addEventListener('change', () => updateColorPickerVisibility());
    }

    const chkProfanity = document.getElementById('chkProfanityFilterEnabled');
    if (chkProfanity) {
      chkProfanity.onchange = () => {
        toggleProfanitySubSettings(chkProfanity.checked);
      };
    }

    const chkTtsEnabled = document.getElementById('chkTtsEnabled');
    if (chkTtsEnabled) {
      chkTtsEnabled.onchange = () => {
        toggleTtsSubSettings(chkTtsEnabled.checked);
      };
    }

    const chkSoundEnabled = document.getElementById('chkSoundEnabled');
    if (chkSoundEnabled) {
      chkSoundEnabled.onchange = () => {
        toggleAudioSettingsRow(chkSoundEnabled.checked);
      };
    }

    const overlayForm = document.getElementById('overlaySettingsForm');
    if (overlayForm) {
      overlayForm.onsubmit = (e) => {
        e.preventDefault();
        saveOverlaySettings();
      };
    }

    // Widget sub-tab toggle: Alert vs Goal vs Timer
    const btnSubtabAlert = document.getElementById('btnSubtabAlert');
    const btnSubtabGoal = document.getElementById('btnSubtabGoal');
    const btnSubtabTimer = document.getElementById('btnSubtabTimer');
    const btnSubtabLeaderboard = document.getElementById('btnSubtabLeaderboard');
    const btnSubtabRecentdonate = document.getElementById('btnSubtabRecentdonate');

    function switchWidgetSubtab(active) {
      const showAlert = active === 'alert';
      const showGoal  = active === 'goal';
      const showTimer = active === 'timer';
      const showLeaderboard = active === 'leaderboard';
      const showRecentdonate = active === 'recentdonate';
      document.getElementById('overlaySettingsForm').style.display = showAlert ? '' : 'none';
      document.getElementById('goalSettingsPanel').style.display = showGoal ? '' : 'none';
      document.getElementById('timerSettingsPanel').style.display = showTimer ? '' : 'none';
      document.getElementById('leaderboardSettingsPanel').style.display = showLeaderboard ? '' : 'none';
      document.getElementById('recentdonateSettingsPanel').style.display = showRecentdonate ? '' : 'none';
      document.getElementById('alertPreviewCard').style.display = showAlert ? '' : 'none';
      document.getElementById('goalPreviewCard').style.display = showGoal ? '' : 'none';
      document.getElementById('timerPreviewCard').style.display = showTimer ? '' : 'none';
      document.getElementById('leaderboardPreviewCard').style.display = showLeaderboard ? '' : 'none';
      document.getElementById('recentdonatePreviewCard').style.display = showRecentdonate ? '' : 'none';
      if (btnSubtabAlert) btnSubtabAlert.classList.toggle('active', showAlert);
      if (btnSubtabGoal)  btnSubtabGoal.classList.toggle('active', showGoal);
      if (btnSubtabTimer) btnSubtabTimer.classList.toggle('active', showTimer);
      if (btnSubtabLeaderboard) btnSubtabLeaderboard.classList.toggle('active', showLeaderboard);
      if (btnSubtabRecentdonate) btnSubtabRecentdonate.classList.toggle('active', showRecentdonate);
      if (showAlert) { activateOverlayPreview(); deactivateGoalBarPreview(); deactivateTimerPreview(); deactivateLeaderboardPreview(); deactivateRecentdonatePreview(); }
      if (showGoal)  { deactivateOverlayPreview(); activateGoalBarPreview(); deactivateTimerPreview(); deactivateLeaderboardPreview(); deactivateRecentdonatePreview(); loadGoalSettings(); }
      if (showTimer) { deactivateOverlayPreview(); deactivateGoalBarPreview(); activateTimerPreview(); deactivateLeaderboardPreview(); deactivateRecentdonatePreview(); loadTimerSettings(); }
      if (showLeaderboard) { deactivateOverlayPreview(); deactivateGoalBarPreview(); deactivateTimerPreview(); activateLeaderboardPreview(); deactivateRecentdonatePreview(); loadLeaderboardSettings(); }
      if (showRecentdonate) { deactivateOverlayPreview(); deactivateGoalBarPreview(); deactivateTimerPreview(); deactivateLeaderboardPreview(); activateRecentdonatePreview(); loadRecentdonateSettings(); }
    }

    if (btnSubtabAlert) btnSubtabAlert.addEventListener('click', () => switchWidgetSubtab('alert'));
    if (btnSubtabGoal)  btnSubtabGoal.addEventListener('click', () => switchWidgetSubtab('goal'));
    if (btnSubtabTimer) btnSubtabTimer.addEventListener('click', () => switchWidgetSubtab('timer'));
    if (btnSubtabLeaderboard) btnSubtabLeaderboard.addEventListener('click', () => switchWidgetSubtab('leaderboard'));
    if (btnSubtabRecentdonate) btnSubtabRecentdonate.addEventListener('click', () => switchWidgetSubtab('recentdonate'));

    // ponytail: deep-link จาก timer-dock (และหน้าอื่นในอนาคต) — ?tab=overlay-config&subtab=timer
    (function() {
      var params = new URLSearchParams(window.location.search);
      var tab = params.get('tab');
      var subtab = params.get('subtab');
      if (tab) {
        switchTab(tab);
        if (subtab && tab === 'overlay-config') {
          var btn = document.querySelector('button.subtab-btn[data-widget-subtab="' + subtab + '"]');
          if (btn) btn.click();
        }
        // clean URL หลัง navigate แล้ว
        params.delete('tab');
        params.delete('subtab');
        var clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
        history.replaceState({}, '', clean);
      }
    })();

    // Goal color picker <-> hex text sync
    const goalColorPicker = document.getElementById('inputGoalBarColor');
    const goalColorTxt = document.getElementById('txtGoalBarColor');
    if (goalColorPicker && goalColorTxt) {
      goalColorPicker.oninput = (e) => { goalColorTxt.value = e.target.value; };
      goalColorTxt.oninput = (e) => {
        if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) {
          goalColorPicker.value = e.target.value;
        }
      };
    }

    // Goal text customization color pickers <-> hex text sync
    [
      ['inputGoalTextColorLabel', 'txtGoalTextColorLabel'],
      ['inputGoalTextColorBar', 'txtGoalTextColorBar'],
      ['inputGoalTextColorSub1', 'txtGoalTextColorSub1'],
      ['inputGoalTextColorSub2', 'txtGoalTextColorSub2'],
      ['inputGoalOutlineColor', 'txtGoalOutlineColor']
    ].forEach(([pickId, txtId]) => {
      const p = document.getElementById(pickId);
      const t = document.getElementById(txtId);
      if (p && t) {
        p.oninput = (e) => { t.value = e.target.value; };
        t.oninput = (e) => {
          if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) {
            p.value = e.target.value;
          }
        };
      }
    });

    // Goal bar width range slider sync
    const rangeEl = document.getElementById('inputGoalBarWidth');
    const txtEl = document.getElementById('txtGoalBarWidth');
    const autoWidthEl = document.getElementById('chkGoalBarWidthAuto');
    if (rangeEl && txtEl) {
      rangeEl.addEventListener('input', () => {
        if (autoWidthEl && autoWidthEl.checked) return;
        txtEl.textContent = rangeEl.value + 'px';
      });
    }
    if (rangeEl && txtEl && autoWidthEl) {
      autoWidthEl.addEventListener('change', () => {
        rangeEl.disabled = autoWidthEl.checked;
        if (autoWidthEl.checked) {
          txtEl.textContent = 'Auto';
          txtEl.style.opacity = '0.6';
        } else {
          txtEl.textContent = rangeEl.value + 'px';
          txtEl.style.opacity = '';
        }
      });
    }

    // Goal bar thickness range slider sync
    const thicknessRangeEl = document.getElementById('inputGoalBarThickness');
    const thicknessTxtEl = document.getElementById('txtGoalBarThickness');
    if (thicknessRangeEl && thicknessTxtEl) {
      thicknessRangeEl.addEventListener('input', () => {
        thicknessTxtEl.textContent = thicknessRangeEl.value + 'px';
      });
    }

    // Goal bar layout -> width label sync
    const goalLayoutSelectEl = document.getElementById('selectGoalBarLayout');
    if (goalLayoutSelectEl) { goalLayoutSelectEl.addEventListener('change', syncGoalWidthLabel); }

    // Goal adjust button
    async function applyGoalDelta(delta) {
      if (isNaN(delta) || delta === 0) return;
      const res = await fetchWithCsrf('/api/goal/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta })
      });
      if (!res.ok) {
        showNotification('ปรับยอดไม่สำเร็จ', 'error');
        return;
      }
      const data = await res.json();
      const amount = parseFloat(document.getElementById('inputGoalAmount').value);
      updateGoalPreview(data.current, amount);
    }

    const btnGoalAdjust = document.getElementById('btnGoalAdjust');
    if (btnGoalAdjust) {
      btnGoalAdjust.addEventListener('click', async () => {
        const delta = parseFloat(document.getElementById('inputGoalDelta').value);
        if (isNaN(delta)) { showNotification('ระบุจำนวนก่อน', 'error'); return; }
        await applyGoalDelta(delta);
        document.getElementById('inputGoalDelta').value = '';
      });
    }

    // Quick-add buttons (+100, +500, +1000, -100)
    document.querySelectorAll('.btn-goal-quick').forEach(btn => {
      btn.addEventListener('click', () => applyGoalDelta(parseFloat(btn.dataset.val)));
    });

    // Goal reset button
    const btnGoalReset = document.getElementById('btnGoalReset');
    if (btnGoalReset) {
      btnGoalReset.addEventListener('click', () => {
        showConfirmModal(
          'รีเซ็ตยอดโดเนท',
          'คุณแน่ใจหรือไม่ว่าต้องการรีเซ็ตยอดโดเนทปัจจุบันเป็น 0?',
          '<i class="fa-solid fa-rotate-left"></i>',
          async () => {
            await fetchWithCsrf('/api/goal/reset', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}'
            });
            const amount = parseFloat(document.getElementById('inputGoalAmount').value);
            updateGoalPreview(0, amount);
          },
          'รีเซ็ต',
          'btn-danger'
        );
      });
    }

    // Save goal settings button
    const btnSaveGoal = document.getElementById('btnSaveGoalSettings');
    if (btnSaveGoal) {
      btnSaveGoal.addEventListener('click', async () => {
        const chkEndDate = document.getElementById('chkGoalEndDate');
        const endDateVal = chkEndDate && chkEndDate.checked
          ? (document.getElementById('inputGoalEndDate').value || '')
          : '';
        const payload = {
          goal_enabled: document.getElementById('chkGoalEnabled').checked ? 1 : 0,
          goal_anim_sound: document.getElementById('chkGoalAnimSound').checked ? 1 : 0,
          goal_anim_enabled: document.getElementById('chkGoalAnimEnabled').checked ? 1 : 0,
          goal_anim_sound_volume: (() => { const v = parseFloat(document.getElementById('sliderGoalAnimVolume')?.value); return isNaN(v) ? 1 : v; })(),
          goal_show_on_donate: document.getElementById('chkGoalShowOnDonate').checked ? 1 : 0,
          goal_bar_position: document.getElementById('selectGoalBarPosition').value || 'top',
          goal_bar_layout: document.getElementById('selectGoalBarLayout').value || 'horizontal',
          goal_pointer_enabled: document.getElementById('chkGoalPointerEnabled').checked ? 1 : 0,
          goal_pointer_side: document.getElementById('selectGoalPointerSide').value || 'right',
          goal_pointer_content: document.getElementById('selectGoalPointerContent').value || 'both',
          goal_label: document.getElementById('inputGoalLabel').value.trim(),
          goal_amount: parseFloat(document.getElementById('inputGoalAmount').value) || 5000,
          goal_bar_color: document.getElementById('inputGoalBarColor').value,
          goal_bar_text: (document.getElementById('inputGoalBarText') || {}).value ?? '{เปอร์เซนต์}',
          goal_subtitle1: (document.getElementById('inputGoalSubtitle1') || {}).value ?? '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿',
          goal_subtitle2: (document.getElementById('inputGoalSubtitle2') || {}).value ?? '',
          goal_end_date: endDateVal,
          goal_bar_width: document.getElementById('inputGoalBarWidth').value || '600',
          goal_bar_thickness: document.getElementById('inputGoalBarThickness').value || '45',
          goal_bar_width_auto: document.getElementById('chkGoalBarWidthAuto').checked ? 1 : 0,
          goal_text_settings: JSON.stringify({
            color_label: document.getElementById('inputGoalTextColorLabel')?.value || '#ffffff',
            color_bar:   document.getElementById('inputGoalTextColorBar')?.value   || '#ffffff',
            color_sub1:  document.getElementById('inputGoalTextColorSub1')?.value  || '#ffffff',
            color_sub2:  document.getElementById('inputGoalTextColorSub2')?.value  || '#ffffff',
            font_size_label: parseInt(document.getElementById('selectGoalFontSizeLabel')?.value) || 30,
            font_size_bar:   parseInt(document.getElementById('selectGoalFontSizeBar')?.value)   || 25,
            font_size_sub1:  parseInt(document.getElementById('selectGoalFontSizeSub1')?.value)  || 20,
            font_size_sub2:  parseInt(document.getElementById('selectGoalFontSizeSub2')?.value)  || 20,
            outline_width: parseInt(document.getElementById('selectGoalOutlineWidth')?.value) || 2,
            outline_color: document.getElementById('inputGoalOutlineColor')?.value || '#000000'
          }),
        };
        const res = await fetchWithCsrf('/api/overlay/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          showNotification('บันทึกการตั้งค่าหลอดโดเนทแล้ว', 'success');
          await loadGoalSettings();
        } else {
          showNotification('ไม่สามารถบันทึกได้', 'error');
        }
      });

      // [UI Fix] เปิด/ปิดวิดเจ็ต = บันทึกอัตโนมัติ ไม่ต้องกดปุ่มบันทึกแยก
      const chkGoalEnabledAuto = document.getElementById('chkGoalEnabled');
      if (chkGoalEnabledAuto) chkGoalEnabledAuto.addEventListener('change', () => btnSaveGoal.click());
    }

    // End date toggle → show/hide date section + auto-fill sub2
    const GOAL_SUB2_DEFAULT = 'ปิดหลอดใน {วันคงเหลือ} วัน';
    const chkGoalEndDate = document.getElementById('chkGoalEndDate');
    if (chkGoalEndDate) {
      chkGoalEndDate.addEventListener('change', () => {
        const section = document.getElementById('goalEndDateSection');
        if (section) section.style.display = chkGoalEndDate.checked ? '' : 'none';

        if (!chkGoalEndDate.checked) return;

        const sub2 = document.getElementById('inputGoalSubtitle2');
        if (!sub2) return;

        if (sub2.value.trim() === '') {
          sub2.value = GOAL_SUB2_DEFAULT;
        } else {
          showConfirmModal(
            'แทนที่ข้อความใต้หลอด (ขวา)?',
            'ต้องการแทนที่วันปิดหลอดเป้าหมาย ที่ช่อง ข้อความใต้หลอด (ขวา) หรือไม่?',
            '<i class="fa-solid fa-calendar-days" style="color:#f59e0b"></i>',
            () => { sub2.value = GOAL_SUB2_DEFAULT; },
            'แทนที่',
            'btn-primary'
          );
        }
      });
    }

    // Copy goal bar URL button (right preview card)
    const btnCopyObsGoalUrlPreview = document.getElementById('btnCopyObsGoalUrlPreview');
    if (btnCopyObsGoalUrlPreview) {
      btnCopyObsGoalUrlPreview.addEventListener('click', () => {
        const urlInput = document.getElementById('obsGoalBarUrlPreview');
        if (!urlInput || !urlInput.value) return;
        navigator.clipboard.writeText(urlInput.value).then(() => {
          const orig = btnCopyObsGoalUrlPreview.textContent;
          btnCopyObsGoalUrlPreview.textContent = 'คัดลอกแล้ว!';
          btnCopyObsGoalUrlPreview.style.background = 'var(--success)';
          setTimeout(() => {
            btnCopyObsGoalUrlPreview.textContent = orig;
            btnCopyObsGoalUrlPreview.style.background = '';
          }, 1500);
        }).catch(err => console.error('Failed to copy:', err));
      });
    }

    // Open goal bar URL in new tab
    const btnOpenObsGoalUrlPreview = document.getElementById('btnOpenObsGoalUrlPreview');
    if (btnOpenObsGoalUrlPreview) {
      btnOpenObsGoalUrlPreview.addEventListener('click', () => {
        const urlInput = document.getElementById('obsGoalBarUrlPreview');
        if (urlInput && urlInput.value) window.open(urlInput.value, '_blank');
      });
    }

    // Reload goal bar preview iframe
    const btnReloadGoalPreview = document.getElementById('btnReloadGoalPreview');
    if (btnReloadGoalPreview) {
      btnReloadGoalPreview.addEventListener('click', () => {
        btnReloadGoalPreview.classList.add('spinning');
        const iframe = document.getElementById('goalBarPreviewIframe');
        if (iframe && iframe.src !== 'about:blank') iframe.src = iframe.src;
        setTimeout(() => btnReloadGoalPreview.classList.remove('spinning'), 1200);
      });
    }

    initTimerSettingsUI();
    initLeaderboardSettingsUI();
    initRecentdonateSettingsUI();
    initTiktokCard();

    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
      btnLogout.onclick = handleLogout;
    }

    const btnDeleteAccount = document.getElementById('btnDeleteAccount');
    if (btnDeleteAccount) {
      btnDeleteAccount.onclick = handleAccountDeletion;
    }

    // Payment Settings Handlers
    const paymentCards = document.querySelectorAll('.payment-method-card');
    const btnSavePayment = document.getElementById('btnSavePaymentSettings');

    // Default: ไม่เลือกวิธีไหนเลย (Save button disabled)
    paymentCards.forEach(c => c.classList.remove('active'));
    if (btnSavePayment) btnSavePayment.disabled = true;

    // Toggle selection (เลือกได้หลายวิธี) - เฉพาะการเลือก ไม่เปิด panel
    paymentCards.forEach(card => {
      card.addEventListener('click', (e) => {
        // ไม่ toggle ถ้า click ที่ปุ่มตั้งค่า
        if (e.target.closest('.btn-settings')) return;

        const method = card.getAttribute('data-method');

        // FFP disabled - ไม่ทำอะไร
        if (method === 'ffp') return;

        // Toggle active state (checkbox behavior)
        card.classList.toggle('active');

        if (card.classList.contains('active')) {
          showSelectionBubble(card, 'เลือกแล้ว');
        }

        updateSaveButton();
      });
    });

    // Settings button click handlers
    document.querySelectorAll('.btn-settings').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetPanelId = btn.getAttribute('data-target');
        const card = btn.closest('.payment-method-card');
        
        // ถ้า card ยังไม่ได้เลือก → ไม่เปิด panel
        if (!card.classList.contains('active')) {
          showNotification('กรุณาเลือกวิธีรับเงินก่อนตั้งค่า', 'error');
          return;
        }

        // Toggle panel
        const isCurrentlyOpen = btn.classList.contains('panel-open');
        
        if (isCurrentlyOpen) {
          // ปิด panel
          closeSettingsPanel(targetPanelId);
          btn.classList.remove('panel-open');
          card.classList.remove('panel-open');
        } else {
          // เปิด panel (ไม่ปิด panel อื่น)
          openSettingsPanel(targetPanelId);
          btn.classList.add('panel-open');
          card.classList.add('panel-open');
          
          // Smooth scroll ไปที่ panel
          setTimeout(() => {
            const panel = document.getElementById(targetPanelId);
            if (panel) {
              panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, 100);
        }
      });
    });

    // Close panel button handlers
    document.querySelectorAll('.btn-close-panel').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetPanelId = btn.getAttribute('data-target');
        closeSettingsPanel(targetPanelId);
        
        // Reset ปุ่มตั้งค่า
        const settingsBtn = document.querySelector(`.btn-settings[data-target="${targetPanelId}"]`);
        if (settingsBtn) {
          settingsBtn.classList.remove('panel-open');
          const card = settingsBtn.closest('.payment-method-card');
          if (card) {
            card.classList.remove('panel-open');
          }
        }
      });
    });

    // PromptPay Type dropdown handler
    const promptpayTypeSelect = document.getElementById('inputPromptPayType');
    if (promptpayTypeSelect) {
      promptpayTypeSelect.addEventListener('change', updatePromptPayPlaceholder);
    }

    // PW-1: numeric-only enforcement for payment inputs
    ['inputBankAccountNumber', 'inputTrueMoneyPhone', 'inputPromptPay', 'webhookPromptpayId'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        const clean = el.value.replace(/\D/g, '');
        if (clean !== el.value) el.value = clean;
      });
    });

    // SlipOK Test buttons
    const btnTestSlipOk = document.getElementById('btnTestSlipOk');
    if (btnTestSlipOk) {
      btnTestSlipOk.onclick = () => testSlipOkConnection('promptpay');
    }

    // SlipOK Test link (per-method, in slipok-linked-note)
    document.querySelectorAll('.slipok-test-link').forEach(btn => {
      btn.onclick = () => testSlipOkConnection(btn.getAttribute('data-method') || 'promptpay');
    });

    // TrueMoney Webhook modal
    initTrueMoneyWebhookModal();

    if (btnSavePayment) {
      btnSavePayment.onclick = savePaymentSettings;
    }

    const btnRefreshSlipokQuotaMini = document.getElementById('btnRefreshSlipokQuotaMini');
    if (btnRefreshSlipokQuotaMini) {
      btnRefreshSlipokQuotaMini.addEventListener('click', () => {
        fetchQuotaMini('promptpay', true);
      });
    }

    initCardPanels();

    // Widget enable-collapse: register toggles so only the on/off switch shows when disabled
    registerWidgetVisibility('chkGoalEnabled', '#goalSettingsBody, [data-body-for="goal"]');
    registerWidgetVisibility('chkTimerEnabled', '#timerSettingsBody, [data-body-for="timer"]');
    registerWidgetVisibility('chkLeaderboardEnabled', '#leaderboardSettingsBody, [data-body-for="leaderboard"]');
    registerWidgetVisibility('chkRecentdonateEnabled', '#recentdonateSettingsBody, [data-body-for="recentdonate"]');
    registerWidgetVisibility('chkTierDonateEnabled', '[data-body-for="tierDonate"]');
    registerWidgetVisibility('tierActive2', '[data-body-for="tier2"]');
    registerWidgetVisibility('tierActive3', '[data-body-for="tier3"]');

    if (window._slLinkedOnLoad) {
      window._slLinkedOnLoad = false;
      switchTab('account');
      showNotification('เชื่อมต่อ Streamlabs สำเร็จ', 'success');
    } else if (window._twitchConflictOnLoad) {
      window._twitchConflictOnLoad = false;
      switchTab('account');
      showNotification('Twitch นี้ถูกเชื่อมต่อกับบัญชี TipKub อื่นอยู่แล้ว กรุณาใช้บัญชีนั้นโดยตรง', 'error');
    } else if (window._twitchLinkedOnLoad) {
      window._twitchLinkedOnLoad = false;
      switchTab('account');
      showNotification('เชื่อมต่อ Twitch สำเร็จ', 'success');
    } else if (window._slConflictOnLoad) {
      window._slConflictOnLoad = false;
      switchTab('account');
      showNotification('Streamlabs นี้ถูกเชื่อมต่อกับบัญชี TipKub อื่นอยู่แล้ว กรุณาใช้บัญชีนั้นโดยตรง', 'error');
    }

    console.log('✅ initializeDashboard completed successfully');
  } catch (criticalErr) {
    console.error('💥 Critical error during dashboard initialization:', criticalErr);
    showNotification('เกิดข้อผิดพลาดในการโหลด Dashboard', 'error');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initializeDashboard());
} else {
  initializeDashboard();
}

// ========== Demo Mode ==========

async function loadDemoSettings() {
  try {
    const res = await fetch('/api/demo/settings');
    if (!res.ok) {
      showNotification('ไม่สามารถโหลดข้อมูล Demo ได้', 'error');
      return;
    }
    const data = await res.json();
    loadOverlaySettingsFromData(data);
    loadPageSettingsFromData(data);
    loadDemoAccountInfo(data);
    loadDemoPaymentInfo(data);
    loadDemoGoalSettingsFromData(data);
    loadDemoTimerSettings(data);
    loadDemoLeaderboardSettings(data);
    loadDemoRecentdonateSettings(data);
  } catch (e) {
    console.error('Demo settings load failed:', e);
    showNotification('เกิดข้อผิดพลาดในการโหลด Demo', 'error');
  }
}

// Normalize goal_bar_width to the valid px range [300, 1080]; fallback 600 to match widget behavior.
function normalizeGoalBarWidth(raw) {
  const val = parseInt(raw, 10);
  return (val >= 300 && val <= 1080) ? String(val) : '600';
}

// Normalize goal_bar_thickness to the valid px range [20, 140]; fallback 45.
function normalizeGoalBarThickness(raw) {
  const val = parseInt(raw, 10);
  return (val >= 20 && val <= 140) ? String(val) : '45';
}

function syncGoalWidthLabel() {
  const lbl = document.getElementById('lblGoalBarWidth');
  const layout = document.getElementById('selectGoalBarLayout');
  const isVertical = layout && layout.value === 'vertical';
  if (lbl && layout) lbl.textContent = isVertical ? 'ความสูงหลอด (px)' : 'ความยาวหลอดสูงสุด (px)';

  const rec = document.getElementById('goalPreviewRecommendationText');
  if (rec) rec.textContent = isVertical
    ? 'แนะนำ: ขนาด 360×800px, background transparent'
    : 'แนะนำ: ขนาด 600×350px, background transparent';
}

// Widget enable-collapse: hide all related settings when toggle is off
const widgetVisibilityUpdaters = {};

// animate=false ใช้ตอน init/โหลดข้อมูล (ไม่อยากให้กระพริบตอนเปิดหน้า/สลับ demo)
// animate=true ใช้ตอน user คลิก toggle เองเท่านั้น (change event จริง)
function applyWidgetVisibility(bodies, show, animate) {
  bodies.forEach(b => {
    b.classList.remove('panel-opening', 'panel-closing');
    if (show) {
      b.classList.remove('widget-body-hidden');
      if (animate) {
        b.classList.add('panel-opening');
        setTimeout(() => b.classList.remove('panel-opening'), 400);
      }
    } else if (animate) {
      b.classList.add('panel-closing');
      setTimeout(() => {
        // guard: ถ้า user เปิดกลับมาก่อน timeout นี้ทำงาน (สลับเร็ว) panel-closing
        // จะถูกลบไปแล้วโดย call ใหม่ด้านบน — ห้ามซ่อนซ้ำทับสถานะที่เพิ่งเปิด
        if (b.classList.contains('panel-closing')) {
          b.classList.remove('panel-closing');
          b.classList.add('widget-body-hidden');
        }
      }, 300);
    } else {
      b.classList.add('widget-body-hidden');
    }
  });
}

function registerWidgetVisibility(toggleId, bodySelector) {
  const toggle = document.getElementById(toggleId);
  const bodies = document.querySelectorAll(bodySelector);
  if (!toggle || !bodies.length) return;
  const update = (animate) => applyWidgetVisibility(bodies, toggle.checked, animate === true);
  toggle.addEventListener('change', () => update(true));
  widgetVisibilityUpdaters[toggleId] = update;
  update(false);
}

function updateWidgetBodyVisibility(toggleId) {
  widgetVisibilityUpdaters[toggleId]?.();
}

function loadDemoGoalSettingsFromData(data) {
  const chkEnabled = document.getElementById('chkGoalEnabled');
  if (chkEnabled) chkEnabled.checked = !!data.goal_enabled;
  updateWidgetBodyVisibility('chkGoalEnabled');
  const chkSound = document.getElementById('chkGoalAnimSound');
  if (chkSound) chkSound.checked = data.goal_anim_sound !== 0 && data.goal_anim_sound !== false;
  const chkAnimEnabled = document.getElementById('chkGoalAnimEnabled');
  const volSlider = document.getElementById('sliderGoalAnimVolume');
  const volLbl = document.getElementById('lblGoalAnimVolume');
  const goalAnimVol = data.goal_anim_sound_volume !== undefined && data.goal_anim_sound_volume !== null ? data.goal_anim_sound_volume : 1;
  if (volSlider) volSlider.value = goalAnimVol;
  if (volLbl) volLbl.textContent = Math.round(goalAnimVol * 100);
  if (chkAnimEnabled) {
    chkAnimEnabled.checked = data.goal_anim_enabled !== 0 && data.goal_anim_enabled !== false;
    const syncSoundVis = () => {
      const soundGroup = chkSound && chkSound.closest('.form-group');
      const volGroup = document.getElementById('goalAnimVolumeGroup');
      if (soundGroup) soundGroup.style.display = chkAnimEnabled.checked ? '' : 'none';
      if (volGroup) volGroup.style.display = (chkAnimEnabled.checked && chkSound && chkSound.checked) ? '' : 'none';
    };
    chkAnimEnabled.onchange = syncSoundVis;
    if (chkSound) chkSound.onchange = syncSoundVis;
    syncSoundVis();
  }
  const chkShowOnDonate = document.getElementById('chkGoalShowOnDonate');
  if (chkShowOnDonate) chkShowOnDonate.checked = !!data.goal_show_on_donate;

  const posEl = document.getElementById('selectGoalBarPosition');
  if (posEl) {
    posEl.value = data.goal_bar_position || 'top';
    posEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const layoutEl = document.getElementById('selectGoalBarLayout');
  if (layoutEl) {
    layoutEl.value = data.goal_bar_layout || 'horizontal';
    layoutEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  syncGoalPointerControls(data);
  syncGoalWidthLabel();
  const labelEl = document.getElementById('inputGoalLabel');
  if (labelEl) labelEl.value = data.goal_label !== undefined ? data.goal_label : 'ค่ากาแฟ';
  const amountEl = document.getElementById('inputGoalAmount');
  if (amountEl) amountEl.value = data.goal_amount || 5000;
  const colorEl = document.getElementById('inputGoalBarColor');
  if (colorEl) colorEl.value = data.goal_bar_color || '#4ade80';
  const txtColor = document.getElementById('txtGoalBarColor');
  if (txtColor) txtColor.value = data.goal_bar_color || '#4ade80';
  const gAutoW = data.goal_bar_width_auto == 1 || data.goal_bar_width_auto === true;
  const widthEl = document.getElementById('inputGoalBarWidth');
  if (widthEl) {
    widthEl.value = normalizeGoalBarWidth(data.goal_bar_width);
    widthEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const gAutoChk = document.getElementById('chkGoalBarWidthAuto');
  if (gAutoChk) { gAutoChk.checked = gAutoW; gAutoChk.dispatchEvent(new Event('change', { bubbles: true })); }
  const thicknessEl = document.getElementById('inputGoalBarThickness');
  if (thicknessEl) {
    thicknessEl.value = normalizeGoalBarThickness(data.goal_bar_thickness);
    thicknessEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const barTextEl = document.getElementById('inputGoalBarText');
  if (barTextEl) barTextEl.value = data.goal_bar_text !== undefined ? data.goal_bar_text : '{เปอร์เซนต์}';
  const sub1El = document.getElementById('inputGoalSubtitle1');
  if (sub1El) sub1El.value = data.goal_subtitle1 !== undefined ? data.goal_subtitle1 : '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿';
  const sub2El = document.getElementById('inputGoalSubtitle2');
  if (sub2El) sub2El.value = data.goal_subtitle2 !== undefined ? data.goal_subtitle2 : '';

  // Goal text customization blob
  let gtc = {};
  try { gtc = JSON.parse(data.goal_text_settings || '{}'); } catch (e) {}
  setSelectValue('selectGoalFontSizeLabel', gtc.font_size_label || 30);
  setSelectValue('selectGoalFontSizeBar',   gtc.font_size_bar   || 25);
  setSelectValue('selectGoalFontSizeSub1',  gtc.font_size_sub1  || 20);
  setSelectValue('selectGoalFontSizeSub2',  gtc.font_size_sub2  || 20);
  setSelectValue('selectGoalOutlineWidth', gtc.outline_width ?? gtc.outline_width_label ?? 2);
  ['selectGoalFontSizeLabel','selectGoalFontSizeBar','selectGoalFontSizeSub1','selectGoalFontSizeSub2',
   'selectGoalOutlineWidth']
    .forEach(id => { const el = document.getElementById(id); if (el) el.dispatchEvent(new Event('change', { bubbles: true })); });
  [
    ['inputGoalTextColorLabel','txtGoalTextColorLabel', gtc.color_label, '#ffffff'],
    ['inputGoalTextColorBar','txtGoalTextColorBar',     gtc.color_bar,   '#ffffff'],
    ['inputGoalTextColorSub1','txtGoalTextColorSub1',   gtc.color_sub1,  '#ffffff'],
    ['inputGoalTextColorSub2','txtGoalTextColorSub2',   gtc.color_sub2,  '#ffffff'],
    ['inputGoalOutlineColor','txtGoalOutlineColor',     gtc.outline_color, '#000000']
  ].forEach(([p, t, v, f]) => {
    const pe = document.getElementById(p), te = document.getElementById(t);
    if (pe) pe.value = v || f;
    if (te) te.value = v || f;
  });

  const current = data.goal_current || 0;
  const amount  = data.goal_amount  || 5000;
  updateGoalPreview(current, amount);

  // Seed module-level state so quick-add buttons start from real current value
  demoGoalState.current   = current;
  demoGoalState.amount    = amount;
  demoGoalState.label     = data.goal_label      !== undefined ? data.goal_label : 'ค่ากาแฟ';
  demoGoalState.barColor  = data.goal_bar_color  || '#4ade80';
  demoGoalState.barText   = data.goal_bar_text   !== undefined ? data.goal_bar_text   : '{เปอร์เซนต์}';
  demoGoalState.subtitle1 = data.goal_subtitle1  !== undefined ? data.goal_subtitle1  : '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿';
  demoGoalState.subtitle2 = data.goal_subtitle2  !== undefined ? data.goal_subtitle2  : '';

  // Seed URL input with demo info (no real token needed)
  const obsUrlEl = document.getElementById('obsGoalBarUrlPreview');
  if (obsUrlEl) obsUrlEl.value = `${location.origin}/demo/goal-bar`;
}

function loadDemoTimerSettings(data) {
  let t = {};
  try { t = JSON.parse(data.timer_settings || '{}'); } catch (e) {}

  const chkEnabled = document.getElementById('chkTimerEnabled');
  if (chkEnabled) chkEnabled.checked = !!t.enabled;
  updateWidgetBodyVisibility('chkTimerEnabled');

  const initSecs = t.initial_seconds || 600;
  const hh = Math.floor(initSecs / 3600);
  const mm = Math.floor((initSecs % 3600) / 60);
  const ss = initSecs % 60;
  const hhEl = document.getElementById('timerInitHH');
  const mmEl = document.getElementById('timerInitMM');
  const ssEl = document.getElementById('timerInitSS');
  if (hhEl) hhEl.value = hh;
  if (mmEl) mmEl.value = mm;
  if (ssEl) ssEl.value = ss;

  const modeEl = document.getElementById('timerModeSelect');
  const mode = t.mode || 'multiplier';
  if (modeEl) {
    modeEl.value = mode;
    modeEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (typeof syncModeCards === 'function') syncModeCards(mode);

  const timeUnitEl = document.getElementById('timerTimeUnit');
  if (timeUnitEl) {
    timeUnitEl.value = t.time_unit || 'minutes';
    timeUnitEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  timerRules = Array.isArray(t.rules) ? JSON.parse(JSON.stringify(t.rules)) : [];
  if (typeof timerRulesSetMode === 'function') timerRulesSetMode(mode);
  if (mode === 'multiplier') {
    if (timerRules.length === 0) timerRules = [{ base_amount: 10, time_seconds: 60, action: 'add' }];
    if (typeof renderMultiplierRules === 'function') renderMultiplierRules();
  } else {
    if (typeof renderTimerRules === 'function') renderTimerRules(mode);
  }

  const outlineColorEl = document.getElementById('inputTimerOutlineColor');
  const outlineTxtEl = document.getElementById('txtTimerOutlineColor');
  const outlineColor = t.outline_color || '#000000';
  if (outlineColorEl) outlineColorEl.value = outlineColor;
  if (outlineTxtEl) outlineTxtEl.value = outlineColor;

  const chkPass = document.getElementById('chkTimerAllowPassthrough');
  if (chkPass) chkPass.checked = t.allow_passthrough !== 0 && t.allow_passthrough !== false;

  const chkShowRules = document.getElementById('chkTimerShowRules');
  if (chkShowRules) chkShowRules.checked = t.show_rules !== false && t.show_rules !== 0;


  const tmplEl = document.getElementById('inputTimerRulesTemplate');
  if (tmplEl) tmplEl.value = t.rules_template || 'โดเนท {จำนวนเงิน}฿ {เครื่องหมาย}{เวลา}';

  const tmplCoinEl = document.getElementById('inputTimerRulesTemplateCoin');
  if (tmplCoinEl) tmplCoinEl.value = t.rules_template_coin || 'Gift {จำนวนเงิน} เหรียญ {เครื่องหมาย}{เวลา}';

  const capTypeEl = document.getElementById('timerCapTypeSelect');
  if (capTypeEl) {
    capTypeEl.value = t.cap_type || '';
    capTypeEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const capValEl = document.getElementById('inputTimerCapValue');
  if (capValEl) {
    if (t.cap_type === 'time') {
      const isMin = (t.time_unit || 'minutes') === 'minutes';
      capValEl.value = isMin ? Math.round((t.cap_value || 0) / 60) : (t.cap_value || '');
    } else {
      capValEl.value = t.cap_value || '';
    }
  }

  if (typeof renderTimerCapStatus === 'function') renderTimerCapStatus(t, data.timer_cap_current || 0);

  const colorMainEl = document.getElementById('inputTimerColorMain');
  const txtColorMain = document.getElementById('txtTimerColorMain');
  const color = t.color_main || '#fbbf24';
  if (colorMainEl) colorMainEl.value = color;
  if (txtColorMain) txtColorMain.value = color;

  const fontSizeEl = document.getElementById('sliderTimerFontSize');
  const fontSizeLbl = document.getElementById('lblTimerFontSize');
  if (fontSizeEl) { fontSizeEl.value = t.font_size || 64; if (fontSizeLbl) fontSizeLbl.textContent = fontSizeEl.value; }

  const borderRadEl = document.getElementById('sliderTimerBorderRadius');
  const borderRadLbl = document.getElementById('lblTimerBorderRadius');
  if (borderRadEl) { borderRadEl.value = t.border_radius ?? 2; if (borderRadLbl) borderRadLbl.textContent = borderRadEl.value; }

  // Animation toggles
  const chkAnim = document.getElementById('chkTimerAnimEnabled');
  const chkAnimSound = document.getElementById('chkTimerAnimSound');
  const timerVolSlider = document.getElementById('sliderTimerAnimVolume');
  const timerVolLbl = document.getElementById('lblTimerAnimVolume');
  const timerAnimVol = t.timer_anim_sound_volume !== undefined && t.timer_anim_sound_volume !== null ? t.timer_anim_sound_volume : 1;
  if (timerVolSlider) timerVolSlider.value = timerAnimVol;
  if (timerVolLbl) timerVolLbl.textContent = Math.round(timerAnimVol * 100);
  if (chkAnimSound) chkAnimSound.checked = t.timer_anim_sound_enabled !== 0 && t.timer_anim_sound_enabled !== false;
  if (chkAnim) {
    chkAnim.checked = t.timer_anim_enabled !== 0 && t.timer_anim_enabled !== false;
    const syncAnimTestVis = () => {
      const soundGroup = document.getElementById('timerAnimSoundGroup');
      const volGroup = document.getElementById('timerAnimVolumeGroup');
      if (soundGroup) soundGroup.style.display = chkAnim.checked ? '' : 'none';
      if (volGroup) volGroup.style.display = (chkAnim.checked && chkAnimSound && chkAnimSound.checked) ? '' : 'none';
    };
    chkAnim.onchange = syncAnimTestVis;
    if (chkAnimSound) chkAnimSound.onchange = syncAnimTestVis;
    syncAnimTestVis();
  }

  // Timeout effect
  const effectTypeEl = document.getElementById('timerTimeoutEffectType');
  if (effectTypeEl) {
    let effectType = t.timeout_effect_type;
    if (!effectType) effectType = (t.timeout_effect === false || t.timeout_effect === 0) ? 'none' : 'blink';
    effectTypeEl.value = effectType;
    effectTypeEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const emojiEl = document.getElementById('inputTimerEffectEmoji');
  if (emojiEl) emojiEl.value = t.timeout_effect_emoji || '🎉';

  // Sound panel
  const chkSoundEnabledEl = document.getElementById('chkTimerSoundEnabled');
  if (chkSoundEnabledEl) {
    chkSoundEnabledEl.checked = t.sound_enabled !== false && t.sound_enabled !== 0;
    chkSoundEnabledEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const soundChoiceEl = document.getElementById('timerSoundChoiceSelect');
  if (soundChoiceEl) {
    soundChoiceEl.value = t.sound_choice || t.sound_type || 'synthetic';
    soundChoiceEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const volEl = document.getElementById('sliderTimerSoundVolume');
  const volLbl = document.getElementById('lblTimerSoundVolume');
  if (volEl) {
    const vol = t.sound_volume ?? 0.7;
    volEl.value = vol;
    if (volLbl) volLbl.textContent = Math.round(vol * 100);
  }
  const timerUrlEl = document.getElementById('timerCustomSoundUrl');
  if (timerUrlEl) timerUrlEl.value = t.sound_url || '';

  // Shine effect
  const chkShine = document.getElementById('chkTimerShine');
  if (chkShine) chkShine.checked = !!t.shine_enabled;

  // TikTok toggle (demo: always show but disabled)
  const tiktokToggle = document.getElementById('tiktokEnableToggle');
  if (tiktokToggle) tiktokToggle.checked = !!t.tiktokEnabled;
  if (typeof syncTiktokCard === 'function') syncTiktokCard();

  // Demo URL (no real token)
  const urlEl = document.getElementById('obsTimerUrlPreview');
  if (urlEl) urlEl.value = `${location.origin}/demo/timer`;
}

function loadDemoLeaderboardSettings(data) {
  let c = {};
  try { c = JSON.parse(data.leaderboard_settings || '{}'); } catch (e) {}

  const chkEnabled = document.getElementById('chkLeaderboardEnabled');
  if (chkEnabled) chkEnabled.checked = !!c.enabled;
  updateWidgetBodyVisibility('chkLeaderboardEnabled');

  const maxEl = document.getElementById('selectLeaderboardMaxEntries');
  if (maxEl) { maxEl.value = c.max_entries || 5; maxEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const chkShine = document.getElementById('chkLeaderboardShine');
  if (chkShine) chkShine.checked = c.shine_enabled !== false && c.shine_enabled !== 0;
  const chkAnim = document.getElementById('chkLeaderboardAnimation');
  if (chkAnim) chkAnim.checked = c.animation_enabled !== false && c.animation_enabled !== 0;
  const chkShowMedal = document.getElementById('chkLeaderboardShowMedal');
  if (chkShowMedal) chkShowMedal.checked = c.show_medal !== false && c.show_medal !== 0;

  const periodMode = c.period_mode || 'all';
  const periodEl = document.getElementById('selectLeaderboardPeriodMode');
  if (periodEl) { periodEl.value = periodMode; periodEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const periodDaysEl = document.getElementById('inputLeaderboardPeriodCustomDays');
  if (periodDaysEl) periodDaysEl.value = c.period_custom_days || 30;
  toggleGroup('leaderboardPeriodCustomGroup', periodMode === 'custom');

  const widthEl = document.getElementById('inputLeaderboardWidth');
  const widthTxt = document.getElementById('txtLeaderboardWidth');
  const autoWidthEl = document.getElementById('chkLeaderboardWidthAuto');
  const savedWidth = parseInt(c.width, 10);
  const widthAuto = !Number.isFinite(savedWidth) || savedWidth < 300 || savedWidth > 1920;
  const width = widthAuto ? 900 : savedWidth;
  if (autoWidthEl) { autoWidthEl.checked = widthAuto; autoWidthEl.dispatchEvent(new Event('change', { bubbles: true })); }
  if (widthEl) {
    widthEl.value = width;
    widthEl.disabled = widthAuto;
    widthEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (widthTxt) {
    widthTxt.textContent = widthAuto ? 'Auto' : width + 'px';
    widthTxt.style.opacity = widthAuto ? '0.6' : '';
  }

  const bgOn = c.bg_enabled !== false && c.bg_enabled !== 0;
  const chkBg = document.getElementById('chkLeaderboardBgEnabled');
  if (chkBg) chkBg.checked = bgOn;
  const bgColorEl = document.getElementById('inputLeaderboardBgColor');
  const bgColorTxt = document.getElementById('txtLeaderboardBgColor');
  if (bgColorEl) bgColorEl.value = c.bg_color || '#000000';
  if (bgColorTxt) bgColorTxt.value = c.bg_color || '#000000';
  const bgOpacityEl = document.getElementById('selectLeaderboardBgOpacity');
  if (bgOpacityEl) { bgOpacityEl.value = c.bg_opacity ?? 60; bgOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
  toggleGroup('leaderboardBgGroup', bgOn);

  const borderOn = c.border_enabled !== false && c.border_enabled !== 0;
  const chkBorder = document.getElementById('chkLeaderboardBorderEnabled');
  if (chkBorder) chkBorder.checked = borderOn;
  const borderColorEl = document.getElementById('inputLeaderboardBorderColor');
  const borderColorTxt = document.getElementById('txtLeaderboardBorderColor');
  if (borderColorEl) borderColorEl.value = c.border_color || '#a855f7';
  if (borderColorTxt) borderColorTxt.value = c.border_color || '#a855f7';
  const borderOpacityEl = document.getElementById('selectLeaderboardBorderOpacity');
  if (borderOpacityEl) { borderOpacityEl.value = c.border_opacity ?? 100; borderOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
  toggleGroup('leaderboardBorderGroup', borderOn);

  const titleEl = document.getElementById('inputLeaderboardTitle');
  if (titleEl) titleEl.value = c.title || '🏆 อันดับผู้โดเนท';
  const fsTitleEl = document.getElementById('selectLeaderboardFontSizeTitle');
  if (fsTitleEl) { fsTitleEl.value = c.font_size_title || 22; fsTitleEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const fsRowEl = document.getElementById('selectLeaderboardFontSizeRow');
  if (fsRowEl) { fsRowEl.value = c.font_size_row || 18; fsRowEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const fsMedalEl = document.getElementById('selectLeaderboardFontSizeMedal');
  if (fsMedalEl) { fsMedalEl.value = c.font_size_medal || 20; fsMedalEl.dispatchEvent(new Event('change', { bubbles: true })); }

  const outlineWEl = document.getElementById('selectLeaderboardOutlineWidth');
  if (outlineWEl) { outlineWEl.value = c.outline_width || 0; outlineWEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const outlineColorEl = document.getElementById('inputLeaderboardOutlineColor');
  const outlineColorTxt = document.getElementById('txtLeaderboardOutlineColor');
  if (outlineColorEl) outlineColorEl.value = c.outline_color || '#000000';
  if (outlineColorTxt) outlineColorTxt.value = c.outline_color || '#000000';

  [
    ['inputLeaderboardColorText', 'txtLeaderboardColorText', c.color_text, '#ffffff'],
    ['inputLeaderboardColorRank', 'txtLeaderboardColorRank', c.color_rank, '#ffd700'],
    ['inputLeaderboardColorDonor', 'txtLeaderboardColorDonor', c.color_donor, '#ffffff'],
    ['inputLeaderboardColorAmount', 'txtLeaderboardColorAmount', c.color_amount, '#4ade80'],
    ['inputLeaderboardColorCurrency', 'txtLeaderboardColorCurrency', c.color_currency, '#f59e0b'],
    ['inputLeaderboardColorCount', 'txtLeaderboardColorCount', c.color_count, '#94a3b8']
  ].forEach(([pickId, txtId, val, fallback]) => {
    const p = document.getElementById(pickId);
    const t = document.getElementById(txtId);
    if (p) p.value = val || fallback;
    if (t) t.value = val || fallback;
  });

  const tplLeftEl = document.getElementById('inputLeaderboardTplLeft');
  if (tplLeftEl) tplLeftEl.value = c.row_template_left || '#{อันดับ}  {ผู้โดเนท} ';
  const tplRightEl = document.getElementById('inputLeaderboardTplRight');
  if (tplRightEl) tplRightEl.value = c.row_template_right || '{จำนวนเงิน} {สกุลเงิน}';

  // Demo URL (no real token)
  const urlEl = document.getElementById('obsLeaderboardUrlPreview');
  if (urlEl) urlEl.value = `${location.origin}/demo/leader-board`;
}

function loadDemoRecentdonateSettings(data) {
  let c = {};
  try { c = JSON.parse(data.recentdonate_settings || '{}'); } catch (e) {}

  const chkEnabled = document.getElementById('chkRecentdonateEnabled');
  if (chkEnabled) chkEnabled.checked = !!c.enabled;
  updateWidgetBodyVisibility('chkRecentdonateEnabled');

  const maxEl = document.getElementById('selectRecentdonateMaxEntries');
  if (maxEl) { maxEl.value = c.max_entries || 5; maxEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const chkShowTime = document.getElementById('chkRecentdonateShowTime');
  if (chkShowTime) chkShowTime.checked = c.show_time !== false && c.show_time !== 0;
  const chkAnim = document.getElementById('chkRecentdonateAnimation');
  if (chkAnim) chkAnim.checked = c.animation_enabled !== false && c.animation_enabled !== 0;

  const periodMode = c.period_mode || 'all';
  const periodEl = document.getElementById('selectRecentdonatePeriodMode');
  if (periodEl) { periodEl.value = periodMode; periodEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const periodDaysEl = document.getElementById('inputRecentdonatePeriodCustomDays');
  if (periodDaysEl) periodDaysEl.value = c.period_custom_days || 30;
  toggleGroup('recentdonatePeriodCustomGroup', periodMode === 'custom');

  const widthEl = document.getElementById('inputRecentdonateWidth');
  const widthTxt = document.getElementById('txtRecentdonateWidth');
  const autoWidthEl = document.getElementById('chkRecentdonateWidthAuto');
  const savedWidth = parseInt(c.width, 10);
  const widthAuto = !Number.isFinite(savedWidth) || savedWidth < 300 || savedWidth > 1920;
  const width = widthAuto ? 900 : savedWidth;
  if (autoWidthEl) { autoWidthEl.checked = widthAuto; autoWidthEl.dispatchEvent(new Event('change', { bubbles: true })); }
  if (widthEl) {
    widthEl.value = width;
    widthEl.disabled = widthAuto;
    widthEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (widthTxt) {
    widthTxt.textContent = widthAuto ? 'Auto' : width + 'px';
    widthTxt.style.opacity = widthAuto ? '0.6' : '';
  }

  const bgOn = c.bg_enabled !== false && c.bg_enabled !== 0;
  const chkBg = document.getElementById('chkRecentdonateBgEnabled');
  if (chkBg) chkBg.checked = bgOn;
  const bgColorEl = document.getElementById('inputRecentdonateBgColor');
  const bgColorTxt = document.getElementById('txtRecentdonateBgColor');
  if (bgColorEl) bgColorEl.value = c.bg_color || '#000000';
  if (bgColorTxt) bgColorTxt.value = c.bg_color || '#000000';
  const bgOpacityEl = document.getElementById('selectRecentdonateBgOpacity');
  if (bgOpacityEl) { bgOpacityEl.value = c.bg_opacity ?? 60; bgOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
  toggleGroup('recentdonateBgGroup', bgOn);

  const borderOn = c.border_enabled !== false && c.border_enabled !== 0;
  const chkBorder = document.getElementById('chkRecentdonateBorderEnabled');
  if (chkBorder) chkBorder.checked = borderOn;
  const borderColorEl = document.getElementById('inputRecentdonateBorderColor');
  const borderColorTxt = document.getElementById('txtRecentdonateBorderColor');
  if (borderColorEl) borderColorEl.value = c.border_color || '#06b6d4';
  if (borderColorTxt) borderColorTxt.value = c.border_color || '#06b6d4';
  const borderOpacityEl = document.getElementById('selectRecentdonateBorderOpacity');
  if (borderOpacityEl) { borderOpacityEl.value = c.border_opacity ?? 100; borderOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
  toggleGroup('recentdonateBorderGroup', borderOn);

  const titleEl = document.getElementById('inputRecentdonateTitle');
  if (titleEl) titleEl.value = c.title || '🕐 โดเนทล่าสุด';

  const fsTitleEl = document.getElementById('selectRecentdonateFontSizeTitle');
  if (fsTitleEl) { fsTitleEl.value = c.font_size_title || 22; fsTitleEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const fsRowEl = document.getElementById('selectRecentdonateFontSizeRow');
  if (fsRowEl) { fsRowEl.value = c.font_size_row || 17; fsRowEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const fsTimeEl = document.getElementById('selectRecentdonateFontSizeTime');
  if (fsTimeEl) { fsTimeEl.value = c.font_size_time || 13; fsTimeEl.dispatchEvent(new Event('change', { bubbles: true })); }

  const outlineWEl = document.getElementById('selectRecentdonateOutlineWidth');
  if (outlineWEl) { outlineWEl.value = c.outline_width || 0; outlineWEl.dispatchEvent(new Event('change', { bubbles: true })); }
  const outlineColorEl = document.getElementById('inputRecentdonateOutlineColor');
  const outlineColorTxt = document.getElementById('txtRecentdonateOutlineColor');
  if (outlineColorEl) outlineColorEl.value = c.outline_color || '#000000';
  if (outlineColorTxt) outlineColorTxt.value = c.outline_color || '#000000';

  [
    ['inputRecentdonateColorText', 'txtRecentdonateColorText', c.color_text, '#ffffff'],
    ['inputRecentdonateColorDonor', 'txtRecentdonateColorDonor', c.color_donor, '#ffffff'],
    ['inputRecentdonateColorAmount', 'txtRecentdonateColorAmount', c.color_amount, '#4ade80'],
    ['inputRecentdonateColorCurrency', 'txtRecentdonateColorCurrency', c.color_currency, '#f59e0b'],
    ['inputRecentdonateColorMessage', 'txtRecentdonateColorMessage', c.color_message, '#94a3b8']
  ].forEach(([pickId, txtId, val, fallback]) => {
    const p = document.getElementById(pickId);
    const t = document.getElementById(txtId);
    if (p) p.value = val || fallback;
    if (t) t.value = val || fallback;
  });

  const tplLeftEl = document.getElementById('inputRecentdonateTplLeft');
  if (tplLeftEl) tplLeftEl.value = c.row_template_left || '{ผู้โดเนท}  {จำนวนเงิน} {สกุลเงิน} ';
  const tplRightEl = document.getElementById('inputRecentdonateTplRight');
  if (tplRightEl) tplRightEl.value = c.row_template_right || ' {ข้อความ}';

  // Demo URL (no real token)
  const urlEl = document.getElementById('obsRecentdonateUrlPreview');
  if (urlEl) urlEl.value = `${location.origin}/demo/recent-donate`;
}

function loadDemoAccountInfo(data) {
  const el = document.getElementById('accUsername');
  const username = data.username || 'KaminKub';
  if (el) el.textContent = username;

  // Avatar + glow (use computed profileImage/profileGlowColor from demo API)
  const avatarEl = document.getElementById('accountAvatarPreview');
  if (avatarEl) avatarEl.src = data.profileImage || '/avatar.jpg';
  const avatarWrapEl = avatarEl?.closest('.avatar-wrap');
  if (avatarWrapEl) avatarWrapEl.style.setProperty('--avatar-glow-color', data.profileGlowColor || data.profile_glow_color || '#005704');

  // Badges — parse from demo data (now in ALLOWED_DEMO_FIELDS)
  let earnedBadges = {};
  try { earnedBadges = JSON.parse(data.badges || '{}'); } catch (e) {}
  let badgeDisplay = [];
  try { badgeDisplay = JSON.parse(data.badge_display || '[]'); } catch (e) {}
  if (!Array.isArray(badgeDisplay)) badgeDisplay = [];
  renderAvatarOrbitBadges('accountAvatarOrbit', 'accountAvatarTierCrown', badgeDisplay);
  // Also seed membership badge selector state for page-customization tab
  earnedBadgesCache = earnedBadges;
  currentBadgeDisplay = [...badgeDisplay];
  badgesLoaded = true;

  // Membership card — real memberSince from KaminKub
  const memberSince = data.memberSince;
  if (memberSince) {
    const joined = new Date(memberSince);
    const elJoin = document.getElementById('memberJoinDate');
    if (elJoin) elJoin.textContent = joined.toLocaleDateString('th-TH', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    const now = new Date();
    const totalDays = Math.floor((now - joined) / (1000 * 60 * 60 * 24));
    const years = Math.floor(totalDays / 365);
    const months = Math.floor((totalDays % 365) / 30);
    const days = totalDays % 30;
    let durationText = '';
    if (years > 0) durationText += `${years} ปี `;
    if (months > 0) durationText += `${months} เดือน `;
    durationText += `${days} วัน`;
    const elDur = document.getElementById('memberDuration');
    if (elDur) elDur.textContent = durationText;
  } else {
    const elJoin = document.getElementById('memberJoinDate');
    if (elJoin) elJoin.textContent = 'ผู้ใช้ยุคบุกเบิก 🏛️';
    const elDur = document.getElementById('memberDuration');
    if (elDur) elDur.textContent = 'ก่อนระบบบันทึกเวลา';
  }

  // Donate URL preview
  const donateUrl = `${location.host}/${username.toLowerCase()}`;
  const accUrlInput = document.getElementById('accountDonateUrlPreview');
  if (accUrlInput) {
    accUrlInput.value = donateUrl;
    accUrlInput.size = Math.max(donateUrl.length, 1);
  }
  const pageCustInput = document.getElementById('pageCustomizationDonateUrlPreview');
  if (pageCustInput) pageCustInput.value = donateUrl;

  // Connection status — real booleans from demo API (not hardcoded)
  const twitchOk = data.twitchConnected === true;
  const streamlabsOk = data.streamlabsConnected === true;
  const authProvider = data.authProvider || 'twitch';
  if (typeof updateConnectionBtn === 'function') {
    updateConnectionBtn('btnConnectTwitch', twitchOk, '/auth/twitch', 'statusTwitch', authProvider);
    updateConnectionBtn('btnConnectStreamlabs', streamlabsOk, '/auth/streamlabs', 'statusStreamlabs', authProvider);
  }
}

function loadDemoPaymentInfo(data) {
  document.querySelectorAll('.payment-method-card').forEach(c => c.classList.remove('active'));
  if (data.promptpay_enabled) document.getElementById('cardPromptPay')?.classList.add('active');
  if (data.truemoney_enabled) document.getElementById('cardTrueMoney')?.classList.add('active');

  const promptpayType = document.getElementById('inputPromptPayType');
  if (promptpayType) {
    promptpayType.value = data.promptpay_type || 'phone';
    promptpayType.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Sensitive fields show censored placeholder
  const censor = '●●●●●●●●';
  const promptpayInput = document.getElementById('inputPromptPay');
  if (promptpayInput) { promptpayInput.value = censor; promptpayInput.disabled = true; }

  if (typeof updateSlipOkStatus === 'function') updateSlipOkStatus(data.slipok_connected, data.slipok_last_check);
  const slipOkApi = document.getElementById('inputSlipOkApi');
  const slipOkApiKey = document.getElementById('inputSlipOkApiKey');
  if (slipOkApi) { slipOkApi.value = censor; slipOkApi.disabled = true; }
  if (slipOkApiKey) { slipOkApiKey.value = censor; slipOkApiKey.disabled = true; }

  const trueMoneyPhone = document.getElementById('inputTrueMoneyPhone');
  if (trueMoneyPhone) { trueMoneyPhone.value = censor; trueMoneyPhone.disabled = true; }

  if (data.bank_enabled) document.getElementById('cardBank')?.classList.add('active');
  const bankNameSel = document.getElementById('inputBankName');
  if (bankNameSel) {
    bankNameSel.value = data.bank_name || '';
    bankNameSel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const bankAccNo = document.getElementById('inputBankAccountNumber');
  const bankAccName = document.getElementById('inputBankAccountName');
  if (bankAccNo) { bankAccNo.value = censor; bankAccNo.disabled = true; }
  if (bankAccName) { bankAccName.value = censor; bankAccName.disabled = true; }

  renderTrueMoneyWebhookState(data);
}

function loadOverlaySettingsFromData(data) {
  const sliderDuration = document.getElementById('sliderDuration');
  if (sliderDuration && data.duration !== undefined) {
    sliderDuration.value = data.duration;
    const lbl = document.getElementById('lblDuration');
    if (lbl) lbl.textContent = data.duration;
  }
  setSelectValue('selectParticles', data.particleCount ?? 15);

  const checkboxMap = {
    chkSoundEnabled: 'soundEnabled',
    chkTtsEnabled: 'ttsEnabled',
    chkTtsReadDonor: 'ttsReadDonor',
    chkTtsPrefixEnabled: 'ttsPrefixEnabled',
    chkShowDonorMessage: 'showDonorMessage',
    chkProfanityFilterEnabled: 'profanityFilterEnabled',
  };
  for (const [id, key] of Object.entries(checkboxMap)) {
    const el = document.getElementById(id);
    if (el && data[key] !== undefined) el.checked = !!data[key];
  }

  const textMap = {
    inputAmountSuffix: 'amountSuffix',
    inputMinAmount: 'minAmount',
    inputProfanityWords: 'profanityWords',
  };
  for (const [id, key] of Object.entries(textMap)) {
    const el = document.getElementById(id);
    if (el && data[key] !== undefined) el.value = data[key];
  }

  // 2-line template (fallback to legacy messageTemplate for line 1)
  const line1El = document.getElementById('inputTemplateLine1');
  if (line1El) line1El.value = data.template_line1 || data.messageTemplate || '{ผู้โดเนท} ได้เลี้ยงกาแฟ';
  const line2El = document.getElementById('inputTemplateLine2');
  if (line2El) line2El.value = data.template_line2 || '';

  const selectMap = {
    themeSelect: 'theme',
    fontSelect: 'fontFamily',
    animSelect: 'animation',
    soundChoiceSelect: 'soundChoice',
    profanityReplaceStyleSelect: 'profanityReplaceStyle',
  };
  for (const [id, key] of Object.entries(selectMap)) {
    const el = document.getElementById(id);
    if (el && data[key] !== undefined) {
      el.value = data[key];
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Per-theme color overrides
  const theme = data.theme || 'glassmorphism';
  const themeColors = parseJsonField(data.theme_colors, {});
  const container = document.getElementById('customColorsContainer');
  if (container) container.dataset.savedThemeColors = JSON.stringify(themeColors);
  const colors = themeColors[theme] || {};
  setColorInput('colorDonor', 'txtDonor', colors.donor || '#fde047');
  setColorInput('colorAmount', 'txtAmount', colors.amount || data.primaryColor || '#4ade80');
  setColorInput('colorBorder', 'txtBorder', colors.border || data.borderColor || 'rgba(255,255,255,0.25)');
  setColorInput('colorBg', 'txtBg', colors.bg || data.backgroundColor || 'rgba(15,15,25,0.88)');
  setColorInput('colorText', 'txtText', colors.text || data.textColor || '#ffffff');
  setColorInput('colorSuffix', 'txtSuffix', colors.suffix || '#f59e0b');
  updateColorPickerVisibility(theme);

  // Per-element font sizes + outline
  const fontSizes = parseJsonField(data.alert_font_sizes, {});
  setSelectValue('selectFontSizeHeader', fontSizes.header ?? 36);
  setSelectValue('selectFontSizeDonorHl', fontSizes.donor_hl ?? fontSizes.header ?? 40);
  setSelectValue('selectFontSizeMessage', fontSizes.message ?? 28);
  setSelectValue('selectFontSizeAmount', fontSizes.amount ?? data.fontSize ?? 36);
  setSelectValue('selectFontSizeAmountHl', fontSizes.amount_hl ?? fontSizes.amount ?? data.fontSize ?? 72);
  setSelectValue('selectFontSizeSuffix', fontSizes.suffix ?? 72);

  const outline = parseJsonField(data.alert_outline, { header_amount: 2, message: 1 });
  setSelectValue('selectOutlineHeaderAmount', outline.header_amount ?? 2);
  setSelectValue('selectOutlineMessage', outline.message ?? 1);

  // Sound/TTS/Profanity sub-section visibility (mirrors loadOverlaySettings logic)
  if (typeof toggleCustomSoundUrlContainer === 'function') toggleCustomSoundUrlContainer(data.soundChoice);
  if (typeof toggleTtsSubSettings === 'function') toggleTtsSubSettings(data.ttsEnabled);
  if (typeof toggleAudioSettingsRow === 'function') toggleAudioSettingsRow(data.soundEnabled);
  if (typeof toggleProfanitySubSettings === 'function') toggleProfanitySubSettings(data.profanityFilterEnabled);

  // Custom image/sound display
  const imgMode = data.customImageMode === 'url' ? 'upload' : (data.customImageMode || 'emoji');
  const customImageModeEl = document.getElementById('customImageMode');
  if (customImageModeEl) {
    customImageModeEl.value = imgMode;
    customImageModeEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const customImageValueEl = document.getElementById('customImageValue');
  if (customImageValueEl) customImageValueEl.value = data.customImageValue || '🎁';
  if (typeof toggleCustomImageUI === 'function') toggleCustomImageUI(imgMode, data.customImageValue);
  const customSoundUrlEl = document.getElementById('customSoundUrl');
  if (customSoundUrlEl) customSoundUrlEl.value = data.customSoundUrl || '';

  // sliders missing from original: soundVolume, ttsVolume, ttsRate
  const sliderSoundVolume = document.getElementById('sliderSoundVolume');
  if (sliderSoundVolume && data.soundVolume !== undefined) {
    sliderSoundVolume.value = data.soundVolume;
    const lbl = document.getElementById('lblSoundVolume');
    if (lbl) lbl.textContent = Math.round(data.soundVolume * 100);
  }
  const sliderTtsVolume = document.getElementById('sliderTtsVolume');
  if (sliderTtsVolume && data.ttsVolume !== undefined) {
    sliderTtsVolume.value = data.ttsVolume;
    const lbl = document.getElementById('lblTtsVolume');
    if (lbl) lbl.textContent = Math.round(data.ttsVolume * 100);
  }
  const sliderTtsRate = document.getElementById('sliderTtsRate');
  if (sliderTtsRate && data.ttsRate !== undefined) {
    sliderTtsRate.value = data.ttsRate;
    const lbl = document.getElementById('lblTtsRate');
    if (lbl) lbl.textContent = (data.ttsRate - 0.3).toFixed(1);
  }
}

function loadPageSettingsFromData(data) {
  // Text fields (snake_case from demo API)
  const fieldMap = {
    inputPageTitle:        'page_title',
    inputPageSubtitle:     'page_subtitle',
    inputThankYouHeader:   'thank_you_header',
    inputThankYouSubtitle: 'thank_you_subtitle',
  };
  for (const [id, apiKey] of Object.entries(fieldMap)) {
    const el = document.getElementById(id);
    if (el && data[apiKey] !== undefined) el.value = data[apiKey] || '';
  }

  // Profile image
  const profileImageUrl = data.profile_image_value || '/avatar.jpg';
  const profileImageValueEl = document.getElementById('profileImageValue');
  if (profileImageValueEl) profileImageValueEl.value = data.profile_image_value || '';
  setMediaPreview(document.getElementById('profilePreview'), profileImageUrl);
  setMediaPreview(document.getElementById('brandLogoImg'), profileImageUrl);

  // Profile glow color
  const glowColor = data.profile_glow_color || '#005704';
  const glowPicker = document.getElementById('profileGlowColor');
  const glowText = document.getElementById('txtProfileGlowColor');
  if (glowPicker) glowPicker.value = glowColor;
  if (glowText) glowText.value = glowColor;
  updateBrandGlow(glowColor);

  // Header background
  const headerBgEl = document.getElementById('inputHeaderBgUrl');
  if (headerBgEl) {
    headerBgEl.value = data.header_bg_url || '';
    headerBgEl.dispatchEvent(new Event('input'));
  }
  const headerBgYEl = document.getElementById('inputHeaderBgY');
  if (headerBgYEl) {
    headerBgYEl.value = data.header_bg_y != null ? data.header_bg_y : 0;
    const disp = document.getElementById('headerBgYDisplay');
    if (disp) disp.textContent = headerBgYEl.value;
  }

  // Page background
  const pageBgEl = document.getElementById('inputPageBgUrl');
  if (pageBgEl) pageBgEl.value = data.page_bg_url || '';
  if (data.page_bg_url) {
    const pageBgPreview = document.getElementById('pageBgPreview');
    if (pageBgPreview) {
      setMediaPreview(pageBgPreview, data.page_bg_url);
      if (!isWebm(data.page_bg_url)) pageBgPreview.style.display = 'block';
    }
  }

  // Social links
  const socialMap = {
    socialTwitch:    'social_twitch',
    socialYoutube:   'social_youtube',
    socialTiktok:    'social_tiktok',
    socialFacebook:  'social_facebook',
    socialX:         'social_x',
    socialDiscord:   'social_discord',
    socialInstagram: 'social_instagram',
  };
  for (const [id, key] of Object.entries(socialMap)) {
    const el = document.getElementById(id);
    if (el) el.value = data[key] || '';
  }

  // Donate page preview iframe: activatePagePreview() โหลดตอนเข้าแท็บ page-customization
  // (ห้ามเซ็ตที่นี่ — demo init จะทำให้หน้าโดเนทค้างใน renderer ทุกแท็บ)
}

const DEMO_TRANSACTIONS = [
  { id: 1, donor_name: 'Viewer_ABC', amount: 99,   message: 'เป็นกำลังใจนะครับ!',  created_at: '2026-06-29T20:14:00Z', status: 'confirmed' },
  { id: 2, donor_name: 'FanNo1',     amount: 500,  message: 'ขอเพลงหน่อยครับ 555', created_at: '2026-06-29T19:05:00Z', status: 'confirmed' },
  { id: 3, donor_name: 'SuperFan',   amount: 1000, message: 'ไปเที่ยวด้วยกันนะ!',  created_at: '2026-06-28T22:30:00Z', status: 'confirmed' },
  { id: 4, donor_name: 'Anonymous',  amount: 20,   message: '',                    created_at: '2026-06-28T18:00:00Z', status: 'confirmed' },
  { id: 5, donor_name: 'StreamFan2', amount: 200,  message: 'ขอบคุณที่สตรีม!',     created_at: '2026-06-27T21:45:00Z', status: 'confirmed' },
];

async function loadDemoTransactions() {
  try {
    const res = await fetch('/api/demo/transactions');
    if (res.ok) {
      const txs = await res.json();
      txs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      allTransactions = txs;
      calculateStats(txs);
      renderRecentTransactions(txs);
      renderFullTransactions(txs);
      syncDemoTopDonor();
      return;
    }
  } catch (e) {
    console.error('Demo transactions fetch failed:', e);
  }
  // Fallback to static data if API fails
  allTransactions = DEMO_TRANSACTIONS;
  calculateStats(DEMO_TRANSACTIONS);
  renderRecentTransactions(DEMO_TRANSACTIONS);
  renderFullTransactions(DEMO_TRANSACTIONS);
  syncDemoTopDonor();
}

// txSubviewTopdonor cache invalidate ทุกครั้งที่ allTransactions รีเฟรช (loadDemoTransactions ถูกเรียกทุกครั้งที่เข้า tab dashboard/transactions)
// กัน topdonor ค้างข้อมูลเก่าไม่ตรงกับ txSubviewHistory หลังมี transaction ใหม่ (เช่น กด Quick Test Alert)
function syncDemoTopDonor() {
  if (!DEMO_MODE) return;
  leaderboardAlltimeCache = null;
  if (document.getElementById('txSubviewTopdonor')?.style.display !== 'none') {
    fetchLeaderboardAlltime();
  }
}

function applyDemoRestrictions() {
  // Block save buttons — show modal instead of small notification
  document.querySelectorAll('[id^="btn"][id*="Save"]').forEach(btn => {
    btn.disabled = true;
    btn.title = 'Demo Mode — สมัครสมาชิกเพื่อบันทึก';
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
    btn.onclick = (e) => { e.preventDefault(); showDemoBlockModal(); };
  });

  // Block upload file inputs
  ['profileImageFile', 'headerBgFile', 'pageBgFile', 'customImageFile', 'uploadSoundFile'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = true;
    const wrap = el.closest('.upload-btn') || el.parentElement;
    if (wrap) { wrap.style.opacity = '0.5'; wrap.style.pointerEvents = 'none'; wrap.title = 'Demo Mode — ไม่สามารถอัปโหลดได้'; }
  });

  // Block connection test buttons
  ['btnTestSlipOk'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    btn.onclick = (e) => { e.preventDefault(); showNotification('Demo Mode — ไม่สามารถทดสอบการเชื่อมต่อได้', 'info'); };
  });

  // Block OAuth connect buttons
  ['btnConnectStreamlabs'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    btn.onclick = (e) => { e.preventDefault(); showDemoBlockModal(); };
  });

  // Block download CSV
  ['btnDownloadTransactions', 'btnDownloadFromNote'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    btn.onclick = (e) => { e.preventDefault(); showNotification('Demo Mode — ไม่สามารถดาวน์โหลดได้', 'info'); };
  });

  // Hide logout + account delete (no session in demo)
  const logoutBtn = document.getElementById('btnLogout');
  if (logoutBtn) logoutBtn.style.display = 'none';
  const btnDeleteAccount = document.getElementById('btnDeleteAccount');
  if (btnDeleteAccount) btnDeleteAccount.style.display = 'none';
}

function showDemoBlockModal() {
  showConfirmModal(
    '<i class="fa-solid fa-eye" style="color:#f59e0b;margin-right:8px;"></i>ตัวอย่าง Dashboard',
    'นี่คือหน้าสาธิต — ไม่สามารถบันทึกข้อมูลได้\n\nสมัครสมาชิกฟรีเพื่อตั้งค่าหน้าโดเนทของคุณเอง',
    '<i class="fa-solid fa-lock" style="color:#f59e0b;"></i>',
    () => { window.location.href = '/login'; },
    'สมัคร / เข้าสู่ระบบ ฟรี',
    'btn-primary'
  );
}

function setupDemoPaymentHandlers() {
  // Card toggle (visual selection only — no save)
  document.querySelectorAll('.payment-method-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-settings')) return;
      const method = card.getAttribute('data-method');
      if (method === 'ffp') return;
      card.classList.toggle('active');
      if (card.classList.contains('active')) showSelectionBubble(card, 'เลือกแล้ว');
    });
  });

  // Settings button — open panel for browsing (no active-card requirement in demo)
  document.querySelectorAll('.btn-settings').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetPanelId = btn.getAttribute('data-target');
      const card = btn.closest('.payment-method-card');
      if (!card.classList.contains('active')) {
        card.classList.add('active');
      }
      const isOpen = btn.classList.contains('panel-open');
      if (isOpen) {
        closeSettingsPanel(targetPanelId);
        btn.classList.remove('panel-open');
        card.classList.remove('panel-open');
      } else {
        openSettingsPanel(targetPanelId);
        btn.classList.add('panel-open');
        card.classList.add('panel-open');
        setTimeout(() => {
          const panel = document.getElementById(targetPanelId);
          if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
    });
  });

  // Close panel buttons
  document.querySelectorAll('.btn-close-panel').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetPanelId = btn.getAttribute('data-target');
      closeSettingsPanel(targetPanelId);
      const settingsBtn = document.querySelector(`.btn-settings[data-target="${targetPanelId}"]`);
      if (settingsBtn) {
        settingsBtn.classList.remove('panel-open');
        settingsBtn.closest('.payment-method-card')?.classList.remove('panel-open');
      }
    });
  });

  // PromptPay type dropdown
  const promptpayTypeSelect = document.getElementById('inputPromptPayType');
  if (promptpayTypeSelect) {
    promptpayTypeSelect.addEventListener('change', updatePromptPayPlaceholder);
  }
}

function injectDemoBanner() {
  const banner = document.createElement('div');
  banner.id = 'demoBanner';
  banner.style.cssText = `
    background: linear-gradient(135deg, #f59e0b, #d97706);
    color: #1a1a1a; text-align: center; padding: 8px 16px;
    font-weight: 600; font-size: 14px; z-index: 100;
    position: sticky; top: 0; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  `;
  banner.innerHTML = `
    <i class="fa-solid fa-eye" style="color:#1a1a1a;"></i>
    ตัวอย่าง Dashboard — ข้อมูลของ ${Object.assign(document.createElement('div'),{textContent:DEMO_STREAMER}).innerHTML} (อ่านอย่างเดียว)
    <a href="/login" style="margin-left:16px; background:#1a1a1a; color:#f59e0b;
       padding:4px 12px; border-radius:6px; text-decoration:none; font-size:13px;
       display:inline-block;">
      <i class="fa-solid fa-right-to-bracket"></i> สมัคร / เข้าสู่ระบบ
    </a>
  `;
  document.body.prepend(banner);
  // Expose banner height so mobile CSS can offset the fixed header below it
  const bannerH = banner.offsetHeight || 40;
  document.documentElement.style.setProperty('--demo-banner-h', bannerH + 'px');
  document.body.classList.add('demo-mode-active');
}

// ========== Navigation (Tab Switching) ==========
function showTabLoading(tabId) {
  const section = document.getElementById(`tab-${tabId}`);
  if (!section || section.querySelector('.tab-loading-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'tab-loading-bar';
  const spinner = document.createElement('div');
  spinner.className = 'tab-loading-spinner';
  const label = document.createElement('span');
  label.textContent = 'กำลังโหลด...';
  bar.appendChild(spinner);
  bar.appendChild(label);
  section.insertBefore(bar, section.firstChild);
}

function hideTabLoading(tabId) {
  const section = document.getElementById(`tab-${tabId}`);
  if (!section) return;
  const bar = section.querySelector('.tab-loading-bar');
  if (bar) bar.remove();
}

function switchTab(tabId) {
  activeTab = tabId;
  
  // Update menu button active states
  document.querySelectorAll('.menu-item').forEach(btn => {
    if (btn.getAttribute('data-tab') === tabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update content section visibility
  document.querySelectorAll('.tab-content').forEach(section => {
    if (section.id === `tab-${tabId}`) {
      section.classList.add('active');
    } else {
      section.classList.remove('active');
    }
  });

  // Update Header titles
  const titles = {
    'dashboard': { title: 'Dashboard Overview', subtitle: 'ภาพรวมยอดบริจาคและสถิติระบบ' },
    'transactions': { title: 'Donation History', subtitle: 'ประวัติธุรกรรมและการจำลองส่ง Alert' },
    'overlay-config': { title: 'Overlay Live Settings', subtitle: 'ปรับแต่งดีไซน์ รูปแบบ เสียง และข้อความเตือนของโปรแกรมสตรีมไลฟ์สด' },
    'page-customization': { title: 'Page Customization', subtitle: 'ปรับแต่งหน้าโดเนท โปรไฟล์ และลิงก์โซเชียลมีเดีย' },
    'account': { title: 'User Account', subtitle: 'จัดการข้อมูลส่วนตัวและความปลอดภัยของบัญชี' },
    'payment-setup': { title: 'Payment Setup', subtitle: 'ตั้งค่าวิธีรับเงินบริจาคจากผู้ชม' },
    'feedback': { title: 'เสนอไอเดีย & Feedback', subtitle: 'ช่วยพัฒนา TipKub ให้ดีขึ้น' }
  };


  if (titles[tabId]) {
    document.getElementById('tabTitle').textContent = titles[tabId].title;
    document.getElementById('tabSubtitle').textContent = titles[tabId].subtitle;
  }

  // Action based on tab entry
  if (tabId === 'dashboard' || tabId === 'transactions') {
    fetchTransactions();
  }
  if (tabId === 'overlay-config') {
    if (!DEMO_MODE && !tabLoaded['overlay-config']) {
      tabLoaded['overlay-config'] = true;
      loadOverlaySettings();
    }
    const alertBtn = document.getElementById('btnSubtabAlert');
    const goalBtn  = document.getElementById('btnSubtabGoal');
    const timerBtn = document.getElementById('btnSubtabTimer');
    if (alertBtn && alertBtn.classList.contains('active')) {
      activateOverlayPreview();
    }
    if (goalBtn && goalBtn.classList.contains('active')) {
      activateGoalBarPreview();
    }
    if (timerBtn && timerBtn.classList.contains('active')) {
      activateTimerPreview();
    }
  }
  if (tabId !== 'overlay-config') {
    deactivateOverlayPreview();
    deactivateGoalBarPreview();
    deactivateTimerPreview();
  }
  if (tabId === 'page-customization') {
    activatePagePreview(); // ต้องอยู่นอก tabLoaded gate — ไม่งั้นเข้าแท็บครั้งที่ 2 preview ว่างถาวร
    if (!DEMO_MODE && !tabLoaded['page-customization']) {
      tabLoaded['page-customization'] = true;
      loadPageSettings();
    }
    if (DEMO_MODE) {
      // Demo already has badges from loadDemoAccountInfo — render directly
      if (typeof renderMembershipBadges === 'function') renderMembershipBadges(earnedBadgesCache, currentBadgeDisplay);
    } else {
      ensureBadgesLoaded(); // badge selector ในหน้านี้ต้องมีข้อมูล แม้เปิด account tab ยังไม่เคยโหลด
    }
  }
  if (tabId !== 'page-customization') {
    deactivatePagePreview();
  }
  if (tabId === 'account') {
    if (!DEMO_MODE && !tabLoaded['account']) {
      tabLoaded['account'] = true;
      loadAccountInfo();
    }
  }
  if (tabId === 'payment-setup') {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const imgs = document.querySelectorAll('#tab-payment-setup .card-icon img');
        imgs.forEach(img => {
          const src = img.getAttribute('src');
          if (src) {
            img.src = '';
            img.src = src;
          }
        });
      });
    });
    if (!DEMO_MODE && !tabLoaded['payment-setup']) {
      tabLoaded['payment-setup'] = true;
      loadPaymentSettings();
    }
  }
  if (tabId === 'feedback') {
    if (!tabLoaded['feedback']) {
      tabLoaded['feedback'] = true;
      initFeedbackTab();
    }
  }
}

// ========== Overlay Preview Iframe Control ==========
function activateOverlayPreview() {
  const iframe = document.getElementById('overlayPreviewIframe');
  if (!iframe) return;
  if (!iframe.src || iframe.src.includes('about:blank')) {
    iframe.src = DEMO_MODE ? '/demo/overlay' : '/overlay';
  }
}

function deactivateOverlayPreview() {
  const iframe = document.getElementById('overlayPreviewIframe');
  if (!iframe) return;
  iframe.src = 'about:blank';
}

// ========== Goal Bar Preview Iframe Control ==========
function activateGoalBarPreview() {
  const iframe = document.getElementById('goalBarPreviewIframe');
  if (!iframe) return;
  if (!iframe.src || iframe.src.includes('about:blank')) {
    iframe.src = DEMO_MODE ? '/demo/goal-bar' : `${location.origin}/goal-bar`;
  }
}

function deactivateGoalBarPreview() {
  const iframe = document.getElementById('goalBarPreviewIframe');
  if (!iframe) return;
  iframe.src = 'about:blank';
}

// ========== Timer Preview Iframe Control ==========
function activateTimerPreview() {
  const iframe = document.getElementById('timerPreviewIframe');
  if (!iframe) return;
  if (!iframe.src || iframe.src.includes('about:blank')) {
    iframe.src = DEMO_MODE ? '/demo/timer' : `${location.origin}/timer`;
  }
}

function deactivateTimerPreview() {
  const iframe = document.getElementById('timerPreviewIframe');
  if (!iframe) return;
  iframe.src = 'about:blank';
}

// ========== Leader Board Preview Iframe Control ==========
function activateLeaderboardPreview() {
  const iframe = document.getElementById('leaderboardPreviewIframe');
  if (!iframe) return;
  if (!iframe.src || iframe.src.includes('about:blank')) {
    iframe.src = DEMO_MODE ? '/demo/leader-board' : `${location.origin}/leader-board`;
  }
}

function deactivateLeaderboardPreview() {
  const iframe = document.getElementById('leaderboardPreviewIframe');
  if (!iframe) return;
  iframe.src = 'about:blank';
}

// ========== Recent Donate Preview Iframe Control ==========
function activateRecentdonatePreview() {
  const iframe = document.getElementById('recentdonatePreviewIframe');
  if (!iframe) return;
  if (!iframe.src || iframe.src.includes('about:blank')) {
    iframe.src = DEMO_MODE ? '/demo/recent-donate' : `${location.origin}/recent-donate`;
  }
}

function deactivateRecentdonatePreview() {
  const iframe = document.getElementById('recentdonatePreviewIframe');
  if (!iframe) return;
  iframe.src = 'about:blank';
}

// ========== Donate Page Preview Iframe Control ==========
// หน้าโดเนทเต็มหน้า (bg video + fonts + QR lib + SSE) ต้องไม่ค้างใน renderer เวลาอยู่แท็บอื่น
// — ไม่งั้นมันแย่ง frame budget กับ Alert Preview จนภาพ GIF กระตุก
function activatePagePreview() {
  const iframe = document.getElementById('pagePreviewIframe');
  if (!iframe) return;
  if (!iframe.src || iframe.src.includes('about:blank')) {
    // demo dashboard = /demo/dashboard → pathname[1] คือ 'demo' ไม่ใช่ username
    const username = DEMO_MODE ? 'kaminkub' : window.location.pathname.split('/')[1];
    if (!username) return;
    iframe.src = `/${username}`;
  }
}

function deactivatePagePreview() {
  const iframe = document.getElementById('pagePreviewIframe');
  if (!iframe) return;
  iframe.src = 'about:blank';
}

// ========== Navigation (Tab Switching) ==========

// ========== Fetch & Compute Data ==========
// ========== Confirmation Modal Logic ==========
const confirmModal = document.getElementById('confirmModal');
const confirmTitle = document.getElementById('confirmModalTitle');
const confirmText = document.getElementById('confirmModalText');
const confirmIcon = document.getElementById('confirmModalIcon');
const btnConfirmOk = document.getElementById('btnConfirmOk');
const btnConfirmCancel = document.getElementById('btnConfirmCancel');

let currentConfirmAction = null;

function showConfirmModal(title, text, icon = '<i class="fa-solid fa-triangle-exclamation"></i>', onConfirm = null, btnText = 'ยืนยัน', btnClass = 'btn-danger') {
  confirmTitle.innerHTML = title;
  confirmText.textContent = text;
  confirmIcon.innerHTML = icon;
  currentConfirmAction = onConfirm;
  btnConfirmOk.textContent = btnText;
  btnConfirmOk.className = `btn ${btnClass}`;
  
  confirmModal.style.display = 'flex';
  confirmModal.style.animation = 'modalFade 0.25s ease forwards';
}

function hideConfirmModal() {
  confirmModal.style.animation = 'modalFadeOut 0.2s ease forwards';
  confirmModal.addEventListener('animationend', function handler() {
    confirmModal.style.display = 'none';
    confirmModal.style.animation = '';
    confirmModal.removeEventListener('animationend', handler);
  });
  currentConfirmAction = null;
}

btnConfirmCancel.onclick = hideConfirmModal;
btnConfirmOk.onclick = async () => {
  if (currentConfirmAction) {
    await currentConfirmAction();
  }
  hideConfirmModal();
};

// ========== Account Management Logic ==========

// ponytail: single source of truth for badge metadata
// ⚠️ CANONICAL COLOR TABLE — duplicate byte-per-byte ใน donate-template/app.js
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

let currentBadgeDisplay = []; // state ปัจจุบัน (subset ที่โชว์)
const MEMBERSHIP_KEYS_UI = ['member_1m','member_3m','member_6m','member_1y','member_2y'];

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
  requestAnimationFrame(() => tip.classList.add('visible'));
}

function hideBadgeTooltip() {
  const existing = document.getElementById('badgeTooltip');
  if (existing) existing.remove();
}

let earnedBadgesCache = {}; // เก็บ earned ไว้ re-render container ที่โผล่ทีหลัง (customization tab)
let badgesLoaded = false;

// รับประกันว่า badge selector มีข้อมูล — ใช้ cache ถ้าโหลดแล้ว, ไม่งั้น fetch /api/user/me
async function ensureBadgesLoaded() {
  if (badgesLoaded) { renderMembershipBadges(earnedBadgesCache, currentBadgeDisplay); return; }
  try {
    const r = await fetch('/api/user/me');
    if (!r.ok) return;
    const d = await r.json();
    badgesLoaded = true;
    renderMembershipBadges(d.badges || {}, d.badgeDisplay || []);
  } catch (e) { /* silent — badge selector เป็น optional UI */ }
}

// render badge selector เข้าทุก container ที่มี class .membership-badges (tab-account + page-customization)
function renderMembershipBadges(earned, badgeDisplay) {
  earnedBadgesCache = earned || {};
  if (Array.isArray(badgeDisplay)) currentBadgeDisplay = [...badgeDisplay];

  const badgeDefs = getBadgeDefinitions();
  document.querySelectorAll('.membership-badges').forEach(container => {
    container.innerHTML = '';
    for (const [key, def] of Object.entries(badgeDefs)) {
      if (!earnedBadgesCache[key]) continue; // แสดงเฉพาะ badge ที่ได้จริง
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'membership-badge' + (currentBadgeDisplay.includes(key) ? ' selected' : '');
      badge.dataset.key = key;
      badge.innerHTML = `<i class="${def.icon}" style="color:${def.color};"></i>`;
      badge.addEventListener('click', () => toggleBadgeDisplay(key));
      badge.addEventListener('mouseenter', () => showBadgeTooltip(badge, def.label));
      badge.addEventListener('mouseleave', () => hideBadgeTooltip());
      container.appendChild(badge);
    }
    // แสดง/ซ่อนข้อความ "ยังไม่มี badge" ที่เป็น sibling ถัดไป (customization tab)
    const emptyHint = container.nextElementSibling;
    if (emptyHint && emptyHint.classList.contains('badge-selector-empty')) {
      emptyHint.style.display = container.children.length ? 'none' : 'block';
    }
  });
}

// ⚠️ CANONICAL DUPLICATE (adapted) ของ renderAvatarBadges() ใน donate-template/app.js —
// public page hardcode id 'avatarOrbit'/'avatarTierCrown' ตรงตัว (มี avatar-wrap เดียว), ที่นี่รับ
// id เป็นพารามิเตอร์เพราะ dashboard อาจมี avatar-wrap หลายจุดในอนาคต. ใช้ getBadgeDefinitions() +
// showBadgeTooltip()/hideBadgeTooltip() ที่มีอยู่แล้วในไฟล์นี้แทนการก็อป attachBadgeTooltip() ซ้ำอีกชั้น
function renderAvatarOrbitBadges(orbitId, crownId, displayKeys) {
  const orbit = document.getElementById(orbitId);
  const crown = document.getElementById(crownId);
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

  // tier สูงสุด → crown
  const topDef = defs[active[0]];
  crown.innerHTML = `<i class="${topDef.icon}"></i>`;
  crown.style.setProperty('--tier-color', topDef.color);
  crown.style.display = '';
  crown.addEventListener('mouseenter', () => showBadgeTooltip(crown, topDef.label));
  crown.addEventListener('mouseleave', () => hideBadgeTooltip());

  // ที่เหลือ (สูงสุด 4) → necklace โค้งล่าง สลับข้างจากจี้ (tier สูงใกล้จี้)
  const NECKLACE_OFFSETS = [-28, 28, -56, 56];
  const rest = active.slice(1);
  rest.forEach((key, i) => {
    const def = defs[key];
    const angle = 180 + NECKLACE_OFFSETS[i];
    const b = document.createElement('span');
    b.className = 'orbit-badge';
    b.innerHTML = `<i class="${def.icon}"></i>`;
    b.style.color = def.color;
    b.style.setProperty('--a', angle + 'deg');
    b.addEventListener('mouseenter', () => showBadgeTooltip(b, def.label));
    b.addEventListener('mouseleave', () => hideBadgeTooltip());
    orbit.appendChild(b);
  });
}

function toggleBadgeDisplay(key) {
  if (DEMO_MODE) { showNotification('Demo Mode — ไม่สามารถเปลี่ยน Badge ได้', 'info'); return; }
  const isMember = MEMBERSHIP_KEYS_UI.includes(key);
  const on = currentBadgeDisplay.includes(key);

  if (on) {
    currentBadgeDisplay = currentBadgeDisplay.filter(k => k !== key); // แตะซ้ำ = ยกเลิก
  } else if (isMember) {
    // membership = radio: เอา member เดิมออกก่อน แล้วใส่ใหม่
    currentBadgeDisplay = currentBadgeDisplay.filter(k => !MEMBERSHIP_KEYS_UI.includes(k));
    currentBadgeDisplay.push(key);
  } else {
    currentBadgeDisplay.push(key); // dev/beta = checkbox independent
  }

  document.querySelectorAll('.membership-badge').forEach(el => {
    el.classList.toggle('selected', currentBadgeDisplay.includes(el.dataset.key));
  });
  renderAvatarOrbitBadges('accountAvatarOrbit', 'accountAvatarTierCrown', currentBadgeDisplay); // preview อัปเดตทันที ไม่ต้องรอ save/reload
  saveBadgeDisplay();
}

let badgeSaveSeq = 0;
let badgeSaveTimer = null;
function saveBadgeDisplay() {
  clearTimeout(badgeSaveTimer);
  badgeSaveTimer = setTimeout(async () => {
    const seq = ++badgeSaveSeq;
    try {
      const res = await fetchWithCsrf('/api/badges/display', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display: currentBadgeDisplay })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'save failed');
      if (seq !== badgeSaveSeq) return; // stale response — newer request in flight
      currentBadgeDisplay = data.badgeDisplay; // sync กับ server (เผื่อ clamp)
      document.querySelectorAll('.membership-badge').forEach(el => {
        el.classList.toggle('selected', currentBadgeDisplay.includes(el.dataset.key));
      });
      renderAvatarOrbitBadges('accountAvatarOrbit', 'accountAvatarTierCrown', currentBadgeDisplay); // re-sync เผื่อ server clamp ต่างจาก optimistic update
      showNotification('บันทึกการแสดง badge แล้ว ✅', 'success');
    } catch (e) {
      if (seq !== badgeSaveSeq) return; // stale error — ignore
      showNotification('บันทึก badge ไม่สำเร็จ กรุณาลองใหม่', 'error');
    }
  }, 400); // debounce กันแตะรัวๆ
}

async function loadAccountInfo() {
  showTabLoading('account');
  try {
    const response = await fetch('/api/user/me');
    if (response.ok) {
      const data = await response.json();
      document.getElementById('accUsername').textContent = data.username;
      fillWebhookUrl(); // webhook URL อาศัย accUsername — re-fill หลังได้ username จริง (แก้ URL ลงท้าย '...')

      // L26: avatar preview (96×96) — resolve via existing resolveProfileImage (returns URL or default)
      const avatarEl = document.getElementById('accountAvatarPreview');
      if (avatarEl && data.profileImage) {
        avatarEl.src = data.profileImage;
      }
      // avatar-wrap glow — เหมือนหน้าโดเนทจริง (--avatar-glow-color scoped ใต้ .avatar-wrap เท่านั้น)
      const avatarWrapEl = avatarEl?.closest('.avatar-wrap');
      if (avatarWrapEl) avatarWrapEl.style.setProperty('--avatar-glow-color', data.profileGlowColor || '');

      // L23: Donate URL preview (ตัด protocol ออก — แสดงแค่ host/username ตาม L22)
      const usernameLower = (data.username || '').toLowerCase();
      const donateUrl = usernameLower ? `${location.host}/${usernameLower}` : '';
      const donateUrlInput = document.getElementById('accountDonateUrlPreview');
      if (donateUrlInput) {
        donateUrlInput.value = donateUrl;
        donateUrlInput.size = Math.max(donateUrl.length, 1); // shrink-to-fit ปุ่ม copy ให้ติดตัวอักษร
      }
      const pageCustInput = document.getElementById('pageCustomizationDonateUrlPreview');
      if (pageCustInput) pageCustInput.value = donateUrl;

      // Handle Twitch Connection
      updateConnectionBtn('btnConnectTwitch', data.twitchId, '/auth/twitch', 'statusTwitch', data.authProvider);
      // Handle Streamlabs Connection
      updateConnectionBtn('btnConnectStreamlabs', data.streamlabsId, '/auth/streamlabs', 'statusStreamlabs', data.authProvider);

      // Render membership card
      const memberSince = data.memberSince;
      const earnedBadges = data.badges || {};

      if (memberSince) {
        const joined = new Date(memberSince);
        document.getElementById('memberJoinDate').textContent = joined.toLocaleDateString('th-TH', {
          year: 'numeric', month: 'long', day: 'numeric'
        });
        const now = new Date();
        const totalDays = Math.floor((now - joined) / (1000 * 60 * 60 * 24));
        const years = Math.floor(totalDays / 365);
        const months = Math.floor((totalDays % 365) / 30);
        const days = totalDays % 30;
        let durationText = '';
        if (years > 0) durationText += `${years} ปี `;
        if (months > 0) durationText += `${months} เดือน `;
        durationText += `${days} วัน`;
        document.getElementById('memberDuration').textContent = durationText;
      } else {
        document.getElementById('memberJoinDate').textContent = 'ผู้ใช้ยุคบุกเบิก 🏛️';
        document.getElementById('memberDuration').textContent = 'ก่อนระบบบันทึกเวลา';
      }

      badgesLoaded = true;
      renderMembershipBadges(earnedBadges, data.badgeDisplay || []);
      renderAvatarOrbitBadges('accountAvatarOrbit', 'accountAvatarTierCrown', currentBadgeDisplay);

    } else {
      throw new Error('Failed to load account info');
    }
  } catch (err) {
    console.error('Error loading account info:', err);
    document.getElementById('accUsername').textContent = 'Error';
    tabLoaded['account'] = false;
  } finally {
    hideTabLoading('account');
  }
}

function updateConnectionBtn(id, connected, authUrl, statusId, authProvider) {
  const btn = document.getElementById(id);
  if (!btn) return;

  const row = btn.closest('.connection-row');
  const platform = row ? row.dataset.platform : null;
  const statusEl = statusId ? document.getElementById(statusId) : null;

  const disconnectIconId = id.replace('btnConnect', 'btnDisconnect');
  const disconnectIcon = document.getElementById(disconnectIconId);

  const badgeId = 'primaryBadge' + (platform === 'twitch' ? 'Twitch' : 'Streamlabs');
  const primaryBadge = document.getElementById(badgeId);

  if (connected) {
    btn.innerHTML = 'เชื่อมต่อแล้ว';
    btn.classList.add('btn-connected');
    btn.classList.remove('btn-disconnected');
    btn.disabled = false;
    if (row) row.classList.add('is-connected');
    if (statusEl) {
      statusEl.textContent = 'เชื่อมต่อแล้ว';
      statusEl.classList.add('connected');
    }
    btn.onclick = null;

    if (authProvider && authProvider !== platform && disconnectIcon) {
      disconnectIcon.style.display = '';
    } else if (disconnectIcon) {
      disconnectIcon.style.display = 'none';
    }

    if (authProvider === platform && primaryBadge) {
      primaryBadge.style.display = '';
    }
  } else {
    btn.innerHTML = 'เชื่อมต่อ';
    btn.classList.remove('btn-connected');
    btn.classList.add('btn-disconnected');
    btn.disabled = false;
    if (row) row.classList.remove('is-connected');
    if (statusEl) {
      statusEl.textContent = 'ยังไม่ได้เชื่อมต่อ';
      statusEl.classList.remove('connected');
    }
    if (id === 'btnConnectStreamlabs') {
      btn.onclick = () => openStreamlabsPopup(btn, statusEl, row);
    } else if (id === 'btnConnectTwitch') {
      btn.onclick = () => openTwitchOAuth(btn, authUrl);
    } else {
      btn.onclick = () => window.location.href = authUrl;
    }

    if (disconnectIcon) disconnectIcon.style.display = 'none';
    if (primaryBadge) primaryBadge.style.display = 'none';
  }
}

const SL_POPUP_TIMEOUT_MS = 90 * 1000; // 90s — covers login+2FA worst case on mobile

async function verifyStreamlabsConnection(retryCount = 0, maxRetries = 3) {
  try {
    const response = await fetch('/api/user/me');
    if (!response.ok) throw new Error('API error');
    const data = await response.json();

    if (data.streamlabsId) {
      updateConnectionBtn('btnConnectStreamlabs', data.streamlabsId, '/auth/streamlabs', 'statusStreamlabs', data.authProvider);
      document.getElementById('accUsername').textContent = data.username;
      return;
    }

    if (retryCount < maxRetries) {
      console.log(`[SL Verify] Retry ${retryCount + 1}/${maxRetries} — session not ready yet`);
      setTimeout(() => verifyStreamlabsConnection(retryCount + 1, maxRetries), 800);
      return;
    }

    console.warn('[SL Verify] Max retries reached, force updating UI');
    updateConnectionBtn('btnConnectStreamlabs', data.streamlabsId, '/auth/streamlabs', 'statusStreamlabs', data.authProvider);
    document.getElementById('accUsername').textContent = data.username;

  } catch (err) {
    console.error('[SL Verify] Error:', err);
    if (retryCount < maxRetries) {
      setTimeout(() => verifyStreamlabsConnection(retryCount + 1, maxRetries), 800);
    }
  }
}

function openStreamlabsPopup(btn, statusEl, row) {
  const prevHTML = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังเชื่อมต่อ...';
  btn.disabled = true;

  // Hint: cancel button shown while waiting
  const hint = document.createElement('div');
  hint.id = 'slConnectHint';
  hint.style.cssText = 'margin-top:8px;text-align:center;font-size:0.78rem;color:#94a3b8;';
  hint.innerHTML = 'ค้างนาน? <button id="btnSlCancel" style="background:#ef4444;color:#fff;border:none;border-radius:6px;padding:2px 10px;font-size:0.78rem;font-weight:600;cursor:pointer;margin-left:4px;">ยกเลิก</button>';
  btn.insertAdjacentElement('afterend', hint);
  document.getElementById('btnSlCancel').onclick = () => { cleanup(); resetBtn(); };

  const popup = window.open(
    '/auth/streamlabs?mode=popup',
    'sl_oauth',
    'width=600,height=700,scrollbars=yes,resizable=yes'
  );

  let done = false;
  let bc = null;

  function onMessage(event) {
    if (event.origin !== window.location.origin) return;
    if (!event.data || (event.data.type !== 'sl_linked' && event.data.type !== 'sl_conflict')) return;
    done = true;
    cleanup();
    if (event.data.type === 'sl_conflict') {
      resetBtn();
      switchTab('account');
      showNotification('Streamlabs นี้ถูกเชื่อมต่อกับบัญชี TipKub อื่นอยู่แล้ว กรุณาใช้บัญชีนั้นโดยตรง', 'error');
    } else if (event.data.success) {
      verifyStreamlabsConnection();
      tabLoaded['account'] = false;
      showNotification('เชื่อมต่อ Streamlabs สำเร็จ', 'success');
    } else {
      resetBtn();
    }
  }

  function resetBtn() {
    btn.innerHTML = prevHTML;
    btn.disabled = false;
  }

  function cleanup() {
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    if (bc) { try { bc.close(); } catch(e) {} bc = null; }
    window.removeEventListener('message', onMessage);
    document.getElementById('slConnectHint')?.remove();
  }

  // Poll for popup closure (desktop: works reliably)
  const pollTimer = setInterval(() => {
    if (popup && popup.closed) {
      cleanup();
      if (!done) resetBtn();
    }
  }, 500);

  // Timeout fallback for mobile (popup becomes new tab — closed check never fires)
  const timeoutTimer = setTimeout(() => {
    if (!done) {
      cleanup();
      resetBtn();
      showNotification('หมดเวลา — หากเห็นหน้า Streamlabs ให้ปิดแท็บนั้นแล้วกดเชื่อมต่ออีกครั้ง', 'error');
    }
  }, SL_POPUP_TIMEOUT_MS);

  try {
    bc = new BroadcastChannel('sl_oauth');
    bc.onmessage = (e) => onMessage({ origin: window.location.origin, data: e.data });
  } catch(err) {
    window.addEventListener('message', onMessage);
  }
}

function openTwitchOAuth(btn, authUrl) {
  const prevHTML = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังเชื่อมต่อ...';
  btn.disabled = true;

  setTimeout(() => {
    window.location.href = authUrl;
  }, 80);

  window.addEventListener('pageshow', function onPageShow(e) {
    if (e.persisted) {
      btn.innerHTML = prevHTML;
      btn.disabled = false;
    }
    window.removeEventListener('pageshow', onPageShow);
  }, { once: true });
}

async function handleAccountDeletion() {
  // Step 1: First confirmation
  showConfirmModal(
    '<i class="fa-solid fa-triangle-exclamation"></i> ลบบัญชีถาวร', 
    'คุณต้องการลบข้อมูลทั้งหมดของบัญชีนี้หรือไม่? การดำเนินการนี้ไม่สามารถย้อนกลับได้', 
    '<i class="fa-solid fa-trash"></i>', 
    async () => {
      // Step 2: Second confirmation (Crucial)
      showConfirmModal(
        '<i class="fa-solid fa-circle-exclamation"></i> ยืนยันอีกครั้ง!', 
        'คุณมั่นใจจริงๆ ใช่ไหมว่าต้องการลบข้อมูลทั้งหมด? ข้อมูลทุกอย่างจะหายไปตลอดกาล!', 
        '<i class="fa-solid fa-circle" style="color:#ef4444;"></i>', 
        async () => {
          try {
             const response = await fetchWithCsrf('/api/user/delete', { method: 'DELETE' });
            if (response.ok) {
              showNotification('ลบบัญชีสำเร็จ ระบบจะพากลับไปหน้าหลัก');
              setTimeout(() => { window.location.href = '/'; }, 2000);
            } else {
              const err = await response.json();
              throw new Error(err.error || 'ลบบัญชีไม่สำเร็จ');
            }
  } catch (err) {
    showNotification(err.message, 'error');
  }
}
    );
  }
);
}

// ========== Custom Select Dropdown Component ==========
const CustomDropdown = (() => {
  const instances = [];

  function initAll() {
    document.querySelectorAll('select.form-select').forEach(select => {
      if (select.dataset.customSelect !== 'true') {
        new CustomSelect(select);
      }
    });
  }

  class CustomSelect {
    constructor(select) {
      this.select = select;
      this.select.dataset.customSelect = 'true';
      this._build();
      instances.push(this);
    }

    _build() {
      const wrapper = document.createElement('div');
      wrapper.className = 'cs-wrapper';

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'cs-trigger form-select';
      trigger.textContent = this.select.options[this.select.selectedIndex]?.textContent || '';

      const panel = document.createElement('div');
      panel.className = 'cs-panel';

      Array.from(this.select.options).forEach((opt, i) => {
        const item = document.createElement('div');
        item.className = 'cs-option';
        item.textContent = opt.textContent;
        if (i === this.select.selectedIndex) item.classList.add('selected');
        item.addEventListener('click', () => {
          this._select(i);
        });
        // Mouse move shimmer per option
        item.addEventListener('mousemove', (e) => {
          const rect = item.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * 100;
          item.style.setProperty('--mx', `${x}%`);
        });
        panel.appendChild(item);
      });

      // Insert wrapper before select, then hide select
      // panel goes to body so it escapes card stacking context (fix z-index conflict with sticky save button)
      this.select.style.display = 'none';
      this.select.insertAdjacentElement('beforebegin', wrapper);
      wrapper.appendChild(trigger);
      document.body.appendChild(panel);

      this.wrapper = wrapper;
      this.trigger = trigger;
      this.panel = panel;
      this.items = panel.querySelectorAll('.cs-option');

      // Events
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });

      this.select.addEventListener('change', () => {
        trigger.textContent = this.select.options[this.select.selectedIndex]?.textContent;
        this._highlightSelected();
      });
    }

    _select(index) {
      this.select.selectedIndex = index;
      this.select.dispatchEvent(new Event('change', { bubbles: true }));
      window.setTimeout(() => this.select.dispatchEvent(new Event('input', { bubbles: true })), 0);
      this.trigger.textContent = this.select.options[index]?.textContent;
      this._highlightSelected();
      this._close();
    }

    _highlightSelected() {
      this.items.forEach((el, i) => {
        el.classList.toggle('selected', i === this.select.selectedIndex);
      });
    }

    toggle() {
      this.panel.classList.contains('open') ? this._close() : this._open();
    }

    _open() {
      CustomSelect._closeAll();
      const rect = this.trigger.getBoundingClientRect();
      this.panel.style.top = rect.bottom + 'px';
      this.panel.style.left = rect.left + 'px';
      this.panel.style.width = rect.width + 'px';
      this.panel.classList.add('open');
      this.trigger.classList.add('open');
      const sel = this.panel.querySelector('.cs-option.selected');
      if (sel) {
        window.setTimeout(() => sel.scrollIntoView({ block: 'nearest' }), 150);
      }
    }

    _close() {
      this.trigger.classList.remove('open');
      this.panel.classList.add('closing');
      const onEnd = () => {
        this.panel.classList.remove('open', 'closing');
        this.panel.removeEventListener('animationend', onEnd);
      };
      this.panel.addEventListener('animationend', onEnd);
    }

    static _closeAll() {
      instances.forEach(inst => {
        if (inst.panel.classList.contains('open')) {
          inst._close();
        }
      });
    }
  }

  // Global click-outside-to-close (also check .cs-panel since panels are on body)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cs-wrapper') && !e.target.closest('.cs-panel')) {
      CustomSelect._closeAll();
    }
  });

  function wrapEl(select) {
    if (select.dataset.customSelect !== 'true') new CustomSelect(select);
  }

  function removeBySelect(select) {
    const idx = instances.findIndex(i => i.select === select);
    if (idx !== -1) {
      instances[idx].panel.remove();
      instances.splice(idx, 1);
    }
  }

  return { initAll, wrapEl, removeBySelect };
})();

// Initialize custom selects on first load and when tabs switch
const _origSwitchTab = switchTab;
switchTab = function(tabId, ...args) {
  _origSwitchTab.call(this, tabId, ...args);
  if (tabId === 'payment-setup') {
    window.setTimeout(() => CustomDropdown.initAll(), 300);
  }
};

// Initial init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.setTimeout(() => CustomDropdown.initAll(), 500);
  });
} else {
  window.setTimeout(() => CustomDropdown.initAll(), 500);
}

async function handleLogout() {
  showConfirmModal(
    '<i class="fa-solid fa-right-from-bracket"></i> ออกจากระบบ', 
    'คุณต้องการออกจากระบบใช่หรือไม่?', 
    '<i class="fa-solid fa-door-open"></i>', 
    async () => {
      try {
        const res = await fetch('/api/logout', { method: 'POST' });
        if (res.ok) {
          window.location.href = '/login';
        } else {
          showNotification('ออกจากระบบไม่สำเร็จ', 'error');
        }
      } catch (err) {
        showNotification('เกิดข้อผิดพลาดในการออกจากระบบ', 'error');
      }
    }
  );
}

async function fetchTransactions() {
  if (DEMO_MODE) return loadDemoTransactions();
  try {
    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    if (!username) throw new Error('Username not found in URL');

    const response = await fetch(`/api/transactions/${username}`);
    if (response.ok) {
      allTransactions = await response.json();
      // เรียงจากใหม่ไปเก่า
      allTransactions.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      
      calculateStats(allTransactions);
      renderRecentTransactions(allTransactions);
      renderFullTransactions(allTransactions);
    } else {
      throw new Error(`Server responded with ${response.status}`);
    }
  } catch (err) {
    console.error('Error fetching transactions:', err);
    // Clear loading state by rendering empty data on error
    allTransactions = [];
    calculateStats(allTransactions);
    renderRecentTransactions(allTransactions);
    renderFullTransactions(allTransactions);
  }
}

// ========== [Requirement #9] Top Donor (leaderboard_alltime) subview ==========
let leaderboardAlltimeCache = null; // lazy-load, cache ไว้ไม่ fetch ซ้ำทุกครั้งที่สลับ tab

function switchTransactionsSubview(view) {
  const showHistory = view === 'history';
  document.getElementById('txSubviewHistory').style.display = showHistory ? '' : 'none';
  document.getElementById('txSubviewTopdonor').style.display = showHistory ? 'none' : '';
  document.getElementById('btnTxSubviewHistory').classList.toggle('active', showHistory);
  document.getElementById('btnTxSubviewTopdonor').classList.toggle('active', !showHistory);
  if (!showHistory && !leaderboardAlltimeCache) fetchLeaderboardAlltime();
}
document.getElementById('btnTxSubviewHistory')?.addEventListener('click', () => switchTransactionsSubview('history'));
document.getElementById('btnTxSubviewTopdonor')?.addEventListener('click', () => switchTransactionsSubview('topdonor'));

async function fetchLeaderboardAlltime() {
  const tbody = document.querySelector('#topDonorTable tbody');
  try {
    if (DEMO_MODE) {
      // Demo: aggregate from loaded demo transactions (no auth endpoint available)
      const map = new Map();
      (allTransactions || []).forEach(t => {
        if ((t.status || '').toLowerCase() !== 'confirmed') return;
        const donor = t.donor_name || t.donor || 'ไม่ระบุชื่อ';
        const amount = Number(t.amount) || 0;
        const existing = map.get(donor);
        if (existing) {
          existing.total_amount += amount;
          existing.donation_count += 1;
          if (amount > existing.top_amount) existing.top_amount = amount;
          const tDate = new Date(t.createdAt || t.created_at || 0);
          const lastDate = new Date(existing.last_donation_at || 0);
          if (tDate > lastDate) existing.last_donation_at = tDate.toISOString();
        } else {
          map.set(donor, {
            donor,
            total_amount: amount,
            donation_count: 1,
            avg_amount: amount,
            top_amount: amount,
            last_donation_at: t.createdAt || t.created_at || null
          });
        }
      });
      leaderboardAlltimeCache = Array.from(map.values())
        .map(r => ({ ...r, avg_amount: r.total_amount / r.donation_count }))
        .sort((a, b) => b.total_amount - a.total_amount);
      renderTopDonorTable(leaderboardAlltimeCache);
      return;
    }
    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    const res = await fetch(`/api/leaderboard-alltime/${username}`);
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
    leaderboardAlltimeCache = await res.json();
    renderTopDonorTable(leaderboardAlltimeCache);
  } catch (err) {
    console.error('Error fetching leaderboard-alltime:', err);
    leaderboardAlltimeCache = [];
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">โหลดข้อมูลไม่สำเร็จ</td></tr>';
  }
}

function renderTopDonorTable(rows) {
  const tbody = document.querySelector('#topDonorTable tbody');
  if (!tbody) return;
  const q = (document.getElementById('inputSearchTopDonor')?.value || '').toLowerCase().trim();
  const filtered = q ? rows.filter(r => (r.donor || '').toLowerCase().includes(q)) : rows;
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">ไม่พบข้อมูล</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map((r, i) => `
    <tr>
      <td>#${i + 1}</td>
      <td>${escapeHtml(r.donor)}</td>
      <td>฿${Number(r.total_amount).toLocaleString('th-TH')}</td>
      <td>${r.donation_count}</td>
      <td>฿${Number(r.avg_amount).toLocaleString('th-TH', { maximumFractionDigits: 0 })}</td>
      <td>฿${Number(r.top_amount).toLocaleString('th-TH')}</td>
      <td>${r.last_donation_at ? new Date(r.last_donation_at).toLocaleDateString('th-TH') : '—'}</td>
    </tr>
  `).join('');
}

document.getElementById('inputSearchTopDonor')?.addEventListener('input', () => renderTopDonorTable(leaderboardAlltimeCache || []));
document.getElementById('btnRefreshTopDonor')?.addEventListener('click', fetchLeaderboardAlltime);
document.getElementById('btnDownloadTopDonor')?.addEventListener('click', () => {
  const rows = leaderboardAlltimeCache || [];
  // CSV formula-injection guard — donor is donor-controlled free text; Excel/Sheets treats a
  // leading =+-@ (or tab/CR) as a formula. Prefix with ' to force text interpretation.
  const csvSafeField = (value) => {
    const s = String(value ?? '');
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return guarded.replace(/"/g, '""');
  };
  const header = 'อันดับ,ผู้บริจาค,ยอดรวม,จำนวนครั้ง,เฉลี่ยต่อครั้ง,สูงสุดต่อครั้ง,บริจาคล่าสุด\n';
  const body = rows.map((r, i) => `${i + 1},"${csvSafeField(r.donor)}",${r.total_amount},${r.donation_count},${r.avg_amount},${r.top_amount},${r.last_donation_at || ''}`).join('\n');
  const blob = new Blob(['﻿' + header + body], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `top-donors-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function calculateStats(transactions) {
  let totalAmount = 0;
  let successCount = 0;
  let pendingCount = 0;
  let failedCount = 0;

  transactions.forEach(t => {
    const amt = Number(t.amount) || 0;
    if (t.status === 'successful') {
      totalAmount += amt;
      successCount++;
    } else if (t.status === 'pending') {
      pendingCount++;
    } else if (t.status === 'failed') {
      failedCount++;
    }
  });

  // Render to DOM
  document.getElementById('statTotalAmount').textContent = `฿${totalAmount.toLocaleString('th-TH')}`;
  document.getElementById('statSuccessCount').textContent = successCount.toLocaleString();
  document.getElementById('statPendingCount').textContent = `${pendingCount} / ${failedCount}`;
}

// ========== SlipOK Quota Dashboard Card ==========
async function fetchUserPaymentStatus() {
  try {
    const response = await fetch('/api/user/me');
    if (!response.ok) return;
    const user = await response.json();

    // Sidebar brand identity (logo + glow) is global — must apply at startup
    // regardless of which tab is active, since page-customization is now lazy-loaded.
    applyBrandIdentity(user);

    const connected = user.slipok_connected || user.truemoney_slipok_connected;
    // disconnected at load: distinguish "never configured" vs "was connected but failed"
    const reason = connected ? null : (user.slipokApiConfigured ? 'error' : 'no-api');
    renderSlipokDashCard(connected, reason);

    if (connected) {
      fetchSlipokDashQuota();
    }
  } catch (err) {
    console.error('fetchUserPaymentStatus error:', err);
  }
}

function applyBrandIdentity(user) {
  if (!user) return;
  if (user.profileImage) {
    setMediaPreview(document.getElementById('brandLogoImg'), user.profileImage);
  }
  if (user.profileGlowColor) {
    updateBrandGlow(user.profileGlowColor);
  }
}

// Cross-fade swap between two panels (avoids instant display:none↔block per UI/UX show/hide rule)
function slipokFadeSwap(showEl, hideEl) {
  if (hideEl && hideEl.style.display !== 'none' && hideEl.style.opacity !== '0') {
    hideEl.style.opacity = '0';
    hideEl.addEventListener('transitionend', function done() {
      hideEl.style.display = 'none';
    }, { once: true });
  }
  if (showEl && (showEl.style.display === 'none' || showEl.style.opacity === '0')) {
    showEl.style.display = 'block';
    showEl.style.opacity = '0';
    requestAnimationFrame(() => { showEl.style.opacity = '1'; });
  }
}

// reason: 'no-api' (never configured) | 'error' (was connected but fetch failed)
function renderSlipokDashCard(connected, reason) {
  const card = document.getElementById('statCardSlipok');
  const connectedEl = document.getElementById('slipokDashConnected');
  const disconnectedEl = document.getElementById('slipokDashDisconnected');
  const titleEl = document.getElementById('slipokDashNoApiTitle');
  const linkEl = document.getElementById('slipokDashSetupLink');

  if (!card) return;

  if (connected) {
    slipokFadeSwap(connectedEl, disconnectedEl);
    card.onclick = () => fetchSlipokDashQuota(null, true);
    card.title = 'คลิกเพื่อรีเฟรชเครดิต SlipOK';
  } else {
    const isError = reason === 'error';
    if (titleEl) {
      titleEl.textContent = isError ? 'ไม่สามารถเชื่อมต่อ SlipOK' : 'ยังไม่เชื่อมต่อ API';
      titleEl.classList.toggle('is-error', isError);
    }
    if (linkEl) {
      linkEl.innerHTML = isError
        ? 'คลิกเพื่อลองใหม่ <i class="fa-solid fa-rotate"></i>'
        : 'คลิกตั้งค่า <i class="fa-solid fa-arrow-right"></i>';
    }
    slipokFadeSwap(disconnectedEl, connectedEl);
    card.onclick = (e) => {
      e.stopPropagation();
      if (isError) fetchSlipokDashQuota(null, true);
      else switchTab('payment-setup');
    };
    card.title = isError ? 'คลิกเพื่อลองเชื่อมต่อ SlipOK อีกครั้ง' : 'คลิกเพื่อตั้งค่า SlipOK API';
  }
}

async function fetchSlipokDashQuota(method, showFeedback) {
  const usedEl = document.getElementById('slipokDashUsed');
  const totalEl = document.getElementById('slipokDashTotal');
  const barEl = document.getElementById('slipokDashBar');
  const metaEl = document.getElementById('slipokDashMeta');
  const affordEl = document.querySelector('.slipok-dash-refresh-afford .fa-rotate');

  if (!method) {
    if (affordEl) affordEl.classList.add('spinning');
    const ok = await fetchSlipokDashQuota('promptpay', showFeedback);
    if (!ok) await fetchSlipokDashQuota('truemoney', showFeedback);
    if (metaEl && (!usedEl || usedEl.textContent === '—')) {
      metaEl.textContent = 'ไม่สามารถเชื่อมต่อ SlipOK';
    }
    setTimeout(() => { if (affordEl) affordEl.classList.remove('spinning'); }, 1200);
    return;
  }

  try {
    const response = await fetch(`/api/payment/slipok-quota?method=${method}`);
    if (response.status === 429) {
      if (metaEl && method === 'truemoney') metaEl.textContent = 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่';
      return false;
    }
    if (!response.ok) {
      if (metaEl && method === 'truemoney') metaEl.textContent = 'ไม่สามารถดึงข้อมูลได้';
      // 401/403/404 = API key issue → disconnect (server already set slipok_connected=0)
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        updateSlipOkStatus(false, new Date().toISOString());
        renderSlipokDashCard(false, 'error');
      }
      return false;
    }
    const result = await response.json();
    if (!result.success) {
      if (metaEl && method === 'truemoney') metaEl.textContent = result.error || 'ไม่สามารถดึงข้อมูลได้';
      updateSlipOkStatus(false, new Date().toISOString());
      renderSlipokDashCard(false, 'error');
      return false;
    }

    const quota = result.data;
    const snapshotFromDb = result.data.snapshotTotal;
    const remaining = quota.quota || 0;
    const specialQuota = quota.specialQuota || 0;
    const overQuota = quota.overQuota || 0;

    let totalPool;
    let used;
    if (snapshotFromDb && snapshotFromDb > 0) {
      totalPool = Math.max(snapshotFromDb, remaining) + specialQuota;
      used = Math.max(0, totalPool - remaining);
    } else {
      totalPool = remaining + specialQuota;
      used = overQuota;
    }
    const ratio = totalPool > 0 ? used / totalPool : 0;

    _cachedQuotaData = { ...quota, method: method };

    if (usedEl) usedEl.textContent = used;
    if (totalEl) totalEl.textContent = totalPool;

    if (barEl) {
      barEl.style.width = `${ratio * 100}%`;
      barEl.className = 'slipok-dash-bar ' + (
        ratio < 0.5 ? 'green' : ratio < 0.8 ? 'yellow' : 'red'
      );
    }

    if (metaEl) {
      const basePlan = snapshotFromDb && snapshotFromDb > 0 ? snapshotFromDb : totalPool;
      const packageLabel = quota.packageName
        || (basePlan <= 100 ? 'Free Plan' : basePlan <= 500 ? 'OK Start' : basePlan <= 1000 ? 'OK SME' : 'Enterprise');
      const endDate = quota.endDate
        ? new Date(quota.endDate).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
        : '—';
      metaEl.innerHTML = `${packageLabel}<span class="slipok-dash-sep-dot">·</span>รีเซท ${endDate}`;
    }

    const origText = affordEl ? affordEl.parentElement.innerHTML : '';
    if (showFeedback && affordEl && affordEl.parentElement) {
      affordEl.parentElement.innerHTML = '<i class="fa-solid fa-circle-check" style="color:#22c55e;"></i> อัปเดตแล้ว';
      affordEl.parentElement.style.opacity = '1';
    }
    setTimeout(() => {
      if (affordEl && affordEl.parentElement && showFeedback) {
        affordEl.parentElement.innerHTML = origText;
        affordEl.parentElement.style.opacity = '';
      }
    }, 2000);

    return true;
  } catch (err) {
    console.error('fetchSlipokDashQuota error:', err.message);
    if (metaEl && method === 'truemoney') metaEl.textContent = 'ไม่สามารถเชื่อมต่อ SlipOK';
    // Auto-disconnect UI on network/parse failure
    updateSlipOkStatus(false, new Date().toISOString());
    renderSlipokDashCard(false, 'error');
    return false;
  }
}

// ========== SlipOK Quota Mini-Card (Payment Setup) ==========
let _cachedQuotaData = null;

async function fetchQuotaMini(method, forceRefresh) {
  const ids = method === 'truemoney' ? {
    card: 'trueMoneySlipokQuotaMini',
    value: 'trueMoneySlipokQuotaMiniValue',
    over: 'trueMoneySlipokOverQuotaMiniValue',
    date: 'trueMoneySlipokEndDateMiniValue',
    updated: 'trueMoneySlipokQuotaMiniUpdated',
    btn: 'btnRefreshTrueMoneySlipokQuotaMini'
  } : {
    card: 'slipokQuotaMini',
    value: 'slipokQuotaMiniValue',
    over: 'slipokOverQuotaMiniValue',
    date: 'slipokEndDateMiniValue',
    updated: 'slipokQuotaMiniUpdated',
    btn: 'btnRefreshSlipokQuotaMini'
  };

  var card = document.getElementById(ids.card);
  var valueEl = document.getElementById(ids.value);
  var overEl = document.getElementById(ids.over);
  var dateEl = document.getElementById(ids.date);
  var updatedEl = document.getElementById(ids.updated);
  var btnRefresh = document.getElementById(ids.btn);

  if (!card) return;
  card.style.display = 'block';

  var d = null;
  var fetched = false;
  if (!forceRefresh && _cachedQuotaData && _cachedQuotaData.method === method) {
    d = _cachedQuotaData;
  } else {
    try {
      var response = await fetch(`/api/payment/slipok-quota?method=${method}`);
      if (response.status === 429) {
        if (updatedEl) updatedEl.textContent = 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่';
        return;
      }
      if (!response.ok) { if (valueEl) valueEl.textContent = 'N/A'; return; }
      var result = await response.json();
      if (!result.success) { if (valueEl) valueEl.textContent = 'N/A'; return; }
      d = result.data;
      d.method = method;
      _cachedQuotaData = d;
      fetched = true;
    } catch (err) {
      console.error('fetchQuotaMini error:', err.message);
      if (valueEl) valueEl.textContent = 'Error';
      return;
    }
  }

  if (valueEl) valueEl.textContent = d.quota ?? '—';
  if (overEl) overEl.textContent = d.overQuota ?? '0';
  if (dateEl) dateEl.textContent = d.endDate
    ? new Date(d.endDate).toLocaleDateString('th-TH')
    : '—';
  if (updatedEl && forceRefresh) {
    updatedEl.textContent = 'อัปเดตแล้ว ✓';
    setTimeout(function() {
      if (updatedEl) updatedEl.textContent = 'อัปเดตล่าสุด: ' + new Date().toLocaleTimeString('th-TH');
    }, 2000);
  } else if (updatedEl && fetched) {
    updatedEl.textContent = 'อัปเดตล่าสุด: ' + new Date().toLocaleTimeString('th-TH');
  }

  if (btnRefresh && forceRefresh) {
    btnRefresh.classList.add('spinning');
    setTimeout(function() { if (btnRefresh) btnRefresh.classList.remove('spinning'); }, 1200);
  }
}

// ========== Render Tables ==========
function renderRecentTransactions(transactions) {
  const tbody = document.querySelector('#recentTransactionsTable tbody');
  tbody.innerHTML = '';

  const recent = transactions.slice(0, 5);

  if (recent.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">ยังไม่มีประวัติการบริจาค</td></tr>`;
    return;
  }

  recent.forEach(t => {
    const date = t.createdAt ? new Date(t.createdAt).toLocaleString('th-TH') : '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${date}</td>
      <td style="font-weight: 500;">${escapeHtml(t.donor || 'Anonymous')}</td>
      <td style="font-weight: 600; color: #818cf8;">฿${(Number(t.amount) || 0).toLocaleString()}</td>
      <td class="text-muted" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.message || '-')}</td>
      <td><span class="badge ${getStatusBadgeClass(t.status)}">${getStatusLabel(t.status)}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------- Transaction date-range + payment-method summary ----------
// วันที่ทั้งหมดเทียบเป็น local time (browser tz) — createdAt เป็น ISO UTC, new Date() แปลงให้เอง
// ห้ามใช้ toISOString() ทำ date string (จะได้ UTC = คลาดวันในไทย +7)
function toLocalDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTxDateRangeBounds() {
  const sel = document.getElementById('selectTxDateRange');
  const value = sel ? sel.value : '90';

  const to = new Date();
  to.setHours(23, 59, 59, 999);

  if (value === 'custom') {
    const fromStr = document.getElementById('inputTxDateFrom')?.value;
    const toStr = document.getElementById('inputTxDateTo')?.value;
    return {
      from: fromStr ? new Date(`${fromStr}T00:00:00`) : null,
      to: toStr ? new Date(`${toStr}T23:59:59.999`) : to
    };
  }

  const days = parseInt(value, 10);
  if (!days) return { from: null, to: null };
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { from, to };
}

function getTxMethodBucket(method) {
  const m = String(method || '').toLowerCase();
  if (m === 'promptpay') return 'promptpay';
  if (m === 'truemoney' || m === 'truemoney_webhook') return 'truemoney';
  if (m === 'bank') return 'bank';
  return 'other';
}

function renderTxSummaryCards(filtered) {
  const buckets = {
    promptpay: { amount: 0, count: 0 },
    truemoney: { amount: 0, count: 0 },
    bank: { amount: 0, count: 0 },
    other: { amount: 0, count: 0 }
  };
  let total = 0;
  let totalCount = 0;

  (filtered || []).forEach(t => {
    if (t.status !== 'successful') return;
    const amount = Number(t.amount) || 0;
    const b = buckets[getTxMethodBucket(t.payment_method)];
    b.amount += amount;
    b.count++;
    total += amount;      // ยอดรวม = ผลรวมทุก bucket รวม "อื่นๆ" แม้การ์ดถูกซ่อน
    totalCount++;
  });

  const money = n => `฿${n.toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('txSumTotal', money(total));
  setText('txSumMeta', `${totalCount.toLocaleString('th-TH')} รายการสำเร็จ`);

  Object.keys(buckets).forEach(key => {
    const suffix = key.charAt(0).toUpperCase() + key.slice(1);
    setText(`txSum${suffix}`, money(buckets[key].amount));
    setText(`txSum${suffix}Count`, `${buckets[key].count.toLocaleString('th-TH')} รายการ`);
  });

  document.getElementById('txSumOtherCard')?.classList.toggle('visible', buckets.other.count > 0);
}

function renderFullTransactions(transactions) {
  const tbody = document.querySelector('#fullTransactionsTable tbody');
  tbody.innerHTML = '';

  const searchQuery = document.getElementById('inputSearchDonor').value.toLowerCase().trim();
  const filterStatus = document.getElementById('selectFilterStatus').value;
  const { from, to } = getTxDateRangeBounds();

  const filtered = (transactions || []).filter(t => {
    const nameMatch = (t.donor || '').toLowerCase().includes(searchQuery) || (t.id || '').toLowerCase().includes(searchQuery);
    const statusMatch = filterStatus === 'all' || t.status === filterStatus;
    const ts = t.createdAt ? new Date(t.createdAt) : null;
    const dateMatch = !ts || isNaN(ts.getTime())
      ? true                                    // ไม่มีวันที่ = ไม่ซ่อน (ห้ามทำเงินหาย)
      : (!from || ts >= from) && (!to || ts <= to);
    return nameMatch && statusMatch && dateMatch;
  });

  renderTxSummaryCards(filtered);   // ต้องอยู่ก่อน early-return ไม่งั้นการ์ดค้างค่าเก่า

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">ไม่พบข้อมูลตรงตามเงื่อนไขที่เลือก</td></tr>`;
    return;
  }

  filtered.forEach(t => {
    const date = t.createdAt ? new Date(t.createdAt).toLocaleString('th-TH') : '-';
    const tr = document.createElement('tr');
    
    let actionsHtml = '<div class="action-buttons-grid">';
    actionsHtml += t.status === 'successful' 
      ? `<button class="btn btn-secondary btn-sm" onclick="inspectTransaction('${t.id}')"><i class="fa-solid fa-magnifying-glass"></i> ดูรายละเอียด</button>`
      : '<div></div>';
    actionsHtml += `<button class="btn btn-primary btn-sm" onclick="simulateTransactionAlert('${t.id}')"><i class="fa-solid fa-bell"></i> ยิง Alert ซ้ำ</button>`;
    actionsHtml += (t.status === 'pending' || t.status === 'failed')
      ? `<button class="btn btn-primary btn-sm" style="background:#059669;box-shadow:none;" onclick="forceSuccessTransaction('${t.id}')" title="ยืนยันการชำระเงินด้วยตนเอง"><i class="fa-solid fa-check" style="color:#4ade80;"></i> ยืนยัน</button>`
      : '<div></div>';
    actionsHtml += '</div>';

    tr.innerHTML = `
      <td>${date}</td>
      <td style="font-family: monospace; font-size: 11px;">${t.id}</td>
      <td style="font-weight: 500;">${escapeHtml(t.donor || 'Anonymous')}</td>
      <td style="font-weight: 600; color: #818cf8;">฿${(Number(t.amount) || 0).toLocaleString()}</td>
      <td class="text-muted" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.message || '-')}</td>
      <td><span class="badge ${getStatusBadgeClass(t.status)}">${getStatusLabel(t.status)}</span></td>
      <td>${actionsHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ========== Transaction Filter & Search ==========
const inputSearchDonor = document.getElementById('inputSearchDonor');
const selectFilterStatus = document.getElementById('selectFilterStatus');
const btnRefreshTransactions = document.getElementById('btnRefreshTransactions');
const btnCopyPopupUrl = document.getElementById('btnCopyPopupUrl');

if (inputSearchDonor) {
  inputSearchDonor.addEventListener('input', () => {
    renderFullTransactions(allTransactions);
  });
}

if (selectFilterStatus) {
  selectFilterStatus.addEventListener('change', () => {
    renderFullTransactions(allTransactions);
  });
}

const selectTxDateRange = document.getElementById('selectTxDateRange');
if (selectTxDateRange) {
  selectTxDateRange.addEventListener('change', () => {
    const isCustom = selectTxDateRange.value === 'custom';
    const inputFrom = document.getElementById('inputTxDateFrom');
    const inputTo = document.getElementById('inputTxDateTo');

    if (isCustom && inputFrom && inputTo && !inputFrom.value && !inputTo.value) {
      const today = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 89);
      inputFrom.value = toLocalDateInput(start);
      inputTo.value = toLocalDateInput(today);
    }

    document.getElementById('txDateRangeCustom')?.classList.toggle('visible', isCustom);
    renderFullTransactions(allTransactions);
  });
}

['inputTxDateFrom', 'inputTxDateTo'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => {
    renderFullTransactions(allTransactions);
  });
});

if (btnRefreshTransactions) {
  btnRefreshTransactions.addEventListener('click', async () => {
    btnRefreshTransactions.classList.add('spinning');
    await fetchTransactions();
    btnRefreshTransactions.classList.remove('spinning');
  });
}

// Download button + modal logic
const btnDownloadTransactions = document.getElementById('btnDownloadTransactions');
const btnDownloadFromNote = document.getElementById('btnDownloadFromNote');
const downloadModal = document.getElementById('downloadModal');

function openDownloadModal() {
  if (!downloadModal) return;
  const now = new Date();
  const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  document.getElementById('downloadMonthFrom').value = oneMonthAgo.toISOString().slice(0, 7);
  document.getElementById('downloadMonthTo').value = now.toISOString().slice(0, 7);
  document.getElementById('downloadNote').style.display = 'block';
  downloadModal.style.display = 'flex';
  downloadModal.style.animation = 'modalFade 0.25s ease forwards';
}

if (btnDownloadTransactions && downloadModal) {
  btnDownloadTransactions.addEventListener('click', openDownloadModal);
}

if (btnDownloadFromNote) {
  btnDownloadFromNote.addEventListener('click', (e) => {
    e.preventDefault();
    openDownloadModal();
  });
}

if (btnCopyPopupUrl) {
  btnCopyPopupUrl.addEventListener('click', () => {
    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    if (!username) return;
    const url = window.location.origin + '/' + username + '/dona-monitor';
    navigator.clipboard.writeText(url).then(() => {
      showNotification('คัดลอกลิงก์ Dona-Monitor แล้ว!', 'success');
    }).catch(() => {
      showNotification('ไม่สามารถคัดลอกลิงก์ได้', 'error');
    });
  });
}

if (downloadModal) {

  document.getElementById('btnCloseDownload').onclick = closeDownloadModal;
  document.getElementById('btnCancelDownload').onclick = closeDownloadModal;

  downloadModal.addEventListener('click', (e) => {
    if (e.target === downloadModal) closeDownloadModal();
  });

  document.getElementById('btnConfirmDownload').onclick = async () => {
    const fromVal = document.getElementById('downloadMonthFrom').value;
    const toVal = document.getElementById('downloadMonthTo').value;
    if (!fromVal || !toVal) {
      showNotification('กรุณาเลือกทั้งเดือนเริ่มต้นและเดือนสิ้นสุด', 'error');
      return;
    }

    const fromDate = `${fromVal}-01`;
    const [toYear, toMonth] = toVal.split('-');
    const lastDay = new Date(parseInt(toYear), parseInt(toMonth), 0).getDate();
    const toDate = `${toVal}-${String(lastDay).padStart(2, '0')}`;

    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    if (!username) return;

    const btn = document.getElementById('btnConfirmDownload');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังดาวน์โหลด...';

    try {
      const response = await fetch(`/api/transactions/${username}/download?from=${fromDate}&to=${toDate}`);
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'ดาวน์โหลดไม่สำเร็จ');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tipkub-donations-${username}-${fromVal}-${toVal}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showNotification('ดาวน์โหลดสำเร็จ');
      closeDownloadModal();
    } catch (err) {
      showNotification(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-download"></i> ดาวน์โหลด CSV';
    }
  };
}

function closeDownloadModal() {
  if (!downloadModal) return;
  downloadModal.style.animation = 'modalFadeOut 0.2s ease forwards';
  downloadModal.addEventListener('animationend', function handler() {
    downloadModal.style.display = 'none';
    downloadModal.style.animation = '';
    downloadModal.removeEventListener('animationend', handler);
  });
}

// ========== Transactions Logic ==========
async function forceSuccessTransaction(id) {
  const tx = allTransactions.find(t => t.id === id);
  const donorName = tx ? (tx.donor || 'Anonymous') : '';
  const amount = tx ? `฿${(Number(tx.amount) || 0).toLocaleString()}` : '';
  
  showConfirmModal(
    `<i class="fa-solid fa-circle-check" style="color:#22c55e;"></i> ยืนยันการชำระเงินด้วยตนเอง`,
    `ระบบจะส่ง Alert และเปลี่ยนสถานะเป็นชำระสำเร็จ\n\nผู้โดเนท: ${donorName}\nจำนวน: ${amount}`,
    '<i class="fa-solid fa-sack-dollar"></i>',
    async () => {
      try {
        const response = await fetchWithCsrf(`/api/transactions/${id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'successful' })
        });
        
        if (response.ok) {
          showNotification('ยืนยันชำระเงินสำเร็จ', 'success');
          fetchTransactions();
        } else {
          const err = await response.json();
          throw new Error(err.error || 'อัปเดตสถานะไม่สำเร็จ');
        }
      } catch (err) {
        showNotification(err.message || 'อัปเดตสถานะไม่สำเร็จ', 'error');
      }
    },
    'ยืนยันชำระเงิน',
    'btn-success'
  );
}


async function simulateTransactionAlert(id) {
  try {
    const tx = allTransactions.find(t => t.id === id);
    if (!tx) throw new Error('ไม่พบข้อมูลธุรกรรม');
    
    const response = await fetchWithCsrf('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        donor: tx.donor,
        amount: tx.amount,
        message: tx.message
      })
    });
    
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'ส่ง Alert ไม่สำเร็จ');
    }
    showNotification('ส่ง Alert ซ้ำแล้ว!', 'success');
  } catch (err) {
    showNotification(err.message || 'ส่ง Alert ไม่สำเร็จ', 'error');
  }
}


function inspectTransaction(id) {
  const tx = allTransactions.find(t => t.id === id);
  if (!tx) return;
  
  const modal = document.getElementById('transactionDetailModal');
  const btnClose = document.getElementById('btnCloseTransactionDetail');
  
  // Populate data
  document.getElementById('detailDonorName').textContent = tx.donor || 'Anonymous';
  document.getElementById('detailAmount').textContent = `฿${(Number(tx.amount) || 0).toLocaleString()}`;
  
  const messageSection = document.getElementById('detailMessageSection');
  const messageContent = document.getElementById('detailMessage');
  if (tx.message && tx.message.trim()) {
    messageContent.textContent = tx.message;
    messageSection.style.display = 'block';
  } else {
    messageSection.style.display = 'none';
  }
  
  const statusBadge = document.getElementById('detailStatus');
  statusBadge.textContent = tx.status;
  statusBadge.className = `badge ${getStatusBadgeClass(tx.status)}`;
  
  document.getElementById('detailTime').textContent = tx.createdAt 
    ? new Date(tx.createdAt).toLocaleString('th-TH', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
      })
    : '-';
  
  document.getElementById('detailId').textContent = tx.id;
  
  // Show modal
  modal.style.display = 'flex';
  modal.style.animation = 'modalFade 0.25s ease forwards';
  
  // Close button handler
  btnClose.onclick = () => {
    modal.style.animation = 'modalFadeOut 0.2s ease forwards';
    modal.addEventListener('animationend', function handler() {
      modal.style.display = 'none';
      modal.style.animation = '';
      modal.removeEventListener('animationend', handler);
    });
  };
  
  // Close on backdrop click
  modal.onclick = (e) => {
    if (e.target === modal) {
      btnClose.click();
    }
  };
}

function openDonationPopup() {
  const pathParts = window.location.pathname.split('/');
  const username = pathParts[1];
  if (!username) return;

  const url = '/' + username + '/dona-monitor';
  const width = 750;
  const height = 600;
  const left = Math.max(0, (window.screen.width - width) / 2);
  const top = Math.max(0, (window.screen.height - height) / 2);

  window.open(url, 'TipKubDonationMonitor',
    'width=' + width + ',height=' + height +
    ',left=' + left + ',top=' + top +
    ',resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no');
}

async function triggerRandomTestAlert() {
  const names = ['สมศักดิ์ รักเรียน', 'แม่ค้าออนไลน์สายลุย', 'น้องเป็ดก้าบๆ 🐤', 'สุดหล่อคีย์บอร์ดเรืองแสง', 'SuraGaming 🎮', 'นินจานักพัฒนา', 'ผู้สนับสนุนลึกลับ'];
  const messages = ['สู้ๆ นะครับพี่! เป็นกำลังใจให้ทุกไลฟ์เลย 💪', 'ขอเพลงสากลชิลๆ เพลงนึงค่าา 🎵', 'ระบบใหม่เฟี้ยวเงาะมากครับ! ✨', 'บริจาคค่าน้ำเก๊กฮวยเย็นๆ ครับผม 🍺', 'พัฒนาต่อไปครับ ชอบเว็บนี้มาก 🚀', '', 'สุดจัดปลัดบอก ขนาดปลัดลาออกยังต้องบอกว่าสุดจัด!'];
  const amounts = [50, 100, 250, 500, 1000, 2500, 5000];

  const donor = names[Math.floor(Math.random() * names.length)];
  const message = messages[Math.floor(Math.random() * messages.length)];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];

  simulateCustomAlert(donor, amount, message);
}

async function simulateCustomAlert(donor, amount, message) {
  try {
    const res = await fetchWithCsrf('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ donor, amount, message })
    });
    if (res.ok) {
      showNotification('ส่ง Alert ทดสอบแล้ว!', 'success');
    } else if (res.status === 429) {
      showNotification('ส่ง Alert บ่อยเกินไป กรุณารอสักครู่', 'error');
    } else {
      showNotification('ส่ง Alert ไม่สำเร็จ', 'error');
    }
  } catch (err) {
    console.error('Failed to trigger test alert:', err);
    showNotification('ส่ง Alert ไม่สำเร็จ', 'error');
  }
}

// ========== Overlay Settings Logic ==========
function toggleTtsSubSettings(enabled) {
  const container = document.getElementById('ttsSubSettingsContainer');
  if (!container) return;
  container.style.display = enabled ? 'block' : 'none';
}

function toggleAudioSettingsRow(enabled) {
  const row = document.getElementById('soundVolumeSettingsRow');
  if (!row) return;
  row.style.display = enabled ? 'grid' : 'none';
}

function toggleCustomSoundUrlContainer(choice) {
  const urlContainer = document.getElementById('customSoundUrlContainer');
  const uploadContainer = document.getElementById('uploadSoundContainer');
  if (urlContainer) urlContainer.style.display = choice === 'custom_url' ? 'block' : 'none';
  if (uploadContainer) uploadContainer.style.display = choice === 'upload_sound' ? 'block' : 'none';
}

function toggleCustomImageUI(mode, currentValue) {
  const emojiWrap = document.getElementById('customImageEmojiWrap');
  const uploadWrap = document.getElementById('customImageUploadWrap');
  if (!emojiWrap || !uploadWrap) return;
  if (mode === 'upload') {
    emojiWrap.style.display = 'none';
    uploadWrap.style.display = '';
    const val = currentValue !== undefined ? currentValue : document.getElementById('customImageValue')?.value;
    if (val && val.startsWith('http')) {
      const preview = document.getElementById('customImagePreview');
      if (preview) { setMediaPreview(preview, val); preview.style.display = isWebm(val) ? 'none' : 'block'; }
    }
  } else {
    emojiWrap.style.display = '';
    uploadWrap.style.display = 'none';
  }
}

function deleteOldR2File(fileUrl, category) {
  if (!fileUrl || !fileUrl.startsWith('http')) return;
  fetchWithCsrf('/api/upload/delete-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileUrl, category })
  }).then(r => r.json()).then(d => {
    if (d.deleted) console.log('🗑️ R2 old file deleted:', fileUrl);
    else console.warn('R2 delete skipped:', d.reason, fileUrl);
  }).catch(e => console.warn('R2 delete-file call failed:', e.message));
}

async function uploadImageToR2(file, category, maxSizeMB, maxWidthOrHeight, onStatus) {
  const isAnimated = file.type === 'image/gif' || file.type === 'image/webp' || file.type === 'video/webm';
  const maxBytes = isAnimated ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(isAnimated
      ? 'ไฟล์ภาพเคลื่อนไหวใหญ่เกินไป (จำกัดไม่เกิน 2MB)'
      : 'ไฟล์ภาพใหญ่เกินไป (จำกัดไม่เกิน 5MB) กรุณาลดขนาดภาพก่อนนำมาอัปโหลด');
  }
  let uploadFile, uploadMime;
  if (isAnimated) {
    if (onStatus) onStatus('กำลังเตรียมไฟล์...');
    uploadFile = file;
    uploadMime = file.type;
  } else {
    if (onStatus) onStatus('กำลังบีบอัดรูปภาพ...');
    uploadFile = await imageCompression(file, {
      maxSizeMB: maxSizeMB || 0.2,
      maxWidthOrHeight: maxWidthOrHeight || 1200,
      useWebWorker: true,
      fileType: 'image/webp'
    });
    uploadMime = 'image/webp';
  }
  if (onStatus) onStatus('กำลังขอ URL อัปโหลด...');
  const presignRes = await fetchWithCsrf('/api/upload/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileType: uploadMime, category, fileSize: uploadFile.size })
  });
  if (!presignRes.ok) throw new Error((await presignRes.json()).error || 'ขอ URL ไม่สำเร็จ');
  const { uploadUrl, fileUrl } = await presignRes.json();
  if (onStatus) onStatus('กำลังอัปโหลด...');
  const putRes = await fetch(uploadUrl, { method: 'PUT', body: uploadFile, headers: { 'Content-Type': uploadMime } });
  if (!putRes.ok) throw new Error('PUT ไม่สำเร็จ HTTP ' + putRes.status);
  return fileUrl;
}

async function handleImageFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('customImageStatus');
  const valueInput = document.getElementById('customImageValue');
  const preview = document.getElementById('customImagePreview');
  const setStatus = (msg, color) => { if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; } };
  try {
    const urlToDelete = valueInput?.value || null;
    const fileUrl = await uploadImageToR2(file, 'avatar', 0.2, 800, setStatus);
    deleteOldR2File(urlToDelete, 'avatar');
    if (valueInput) valueInput.value = fileUrl;
    if (preview) { setMediaPreview(preview, fileUrl + '?t=' + Date.now()); preview.style.display = isWebm(fileUrl) ? 'none' : 'block'; }
    document.getElementById('btnClearCustomImage')?.style.setProperty('display', '');
    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('อัปโหลดรูปภาพสำเร็จ');
    fetchWithCsrf('/api/overlay/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customImageMode: 'upload', customImageValue: fileUrl }) })
      .catch(e => console.warn('Auto-save customImage failed:', e.message));
  } catch (err) {
    console.error('Image upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

async function handleProfileImageSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('profileImageStatus');
  const setStatus = (msg, color) => { if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; } };
  try {
    const urlToDelete = document.getElementById('profileImageValue')?.value || null;
    const fileUrl = await uploadImageToR2(file, 'profile', 0.2, 800, setStatus);
    deleteOldR2File(urlToDelete, 'profile');
    document.getElementById('profileImageValue').value = fileUrl;
    const cacheBust = fileUrl + '?t=' + Date.now();
    const profilePreview = document.getElementById('profilePreview');
    const brandLogoImg = document.getElementById('brandLogoImg');
    if (profilePreview) setMediaPreview(profilePreview, cacheBust);
    if (brandLogoImg) setMediaPreview(brandLogoImg, cacheBust);
    document.getElementById('btnClearProfileImage')?.style.setProperty('display', '');
    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('อัปโหลดรูปโปรไฟล์สำเร็จ');
    fetchWithCsrf('/api/page/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_image_value: fileUrl, profile_image_source: 'custom' }) })
      .catch(e => console.warn('Auto-save profileImage failed:', e.message));
  } catch (err) {
    console.error('Profile image upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

async function handleHeaderBgSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('headerBgStatus');
  const setStatus = (msg, color) => { if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; } };
  try {
    const urlToDelete = document.getElementById('inputHeaderBgUrl')?.value || null;
    const fileUrl = await uploadImageToR2(file, 'header', 0.5, 1920, setStatus);
    deleteOldR2File(urlToDelete, 'header');
    const hiddenInput = document.getElementById('inputHeaderBgUrl');
    if (hiddenInput) {
      hiddenInput.value = fileUrl;
      hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.getElementById('btnClearHeaderBg')?.style.setProperty('display', '');
    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('อัปโหลดภาพปก Header สำเร็จ');
    fetchWithCsrf('/api/page/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ header_bg_url: fileUrl }) })
      .catch(e => console.warn('Auto-save headerBg failed:', e.message));
  } catch (err) {
    console.error('Header BG upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

async function handlePageBgSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('pageBgStatus');
  const setStatus = (msg, color) => { if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; } };
  try {
    const urlToDelete = document.getElementById('inputPageBgUrl')?.value || null;
    const fileUrl = await uploadImageToR2(file, 'pagebg', 0.5, 1920, setStatus);
    deleteOldR2File(urlToDelete, 'pagebg');
    const hiddenInput = document.getElementById('inputPageBgUrl');
    if (hiddenInput) hiddenInput.value = fileUrl;
    const pageBgPreview = document.getElementById('pageBgPreview');
    if (pageBgPreview) { setMediaPreview(pageBgPreview, fileUrl + '?t=' + Date.now()); if (!isWebm(fileUrl)) pageBgPreview.style.display = 'block'; }
    document.getElementById('btnClearPageBg')?.style.setProperty('display', '');
    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('อัปโหลดภาพพื้นหลังสำเร็จ');
    fetchWithCsrf('/api/page/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_bg_url: fileUrl }) })
      .catch(e => console.warn('Auto-save pageBg failed:', e.message));
  } catch (err) {
    console.error('Page BG upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

async function handleAudioFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('uploadSoundStatus');
  const soundUrlInput = document.getElementById('customSoundUrl');
  const currentNameEl = document.getElementById('uploadSoundCurrentName');
  const currentWrap = document.getElementById('uploadSoundCurrentWrap');

  const setStatus = (msg, color) => {
    if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; }
  };

  const allowedFormats = ['audio/mpeg', 'audio/mp3', 'audio/ogg'];
  const normalizedType = file.type === 'audio/mp3' ? 'audio/mpeg' : file.type;
  if (!allowedFormats.includes(file.type) && !allowedFormats.includes(normalizedType)) {
    showNotification('รองรับเฉพาะไฟล์ .mp3 และ .ogg เท่านั้น', 'error');
    return;
  }
  if (file.size > 1024 * 1024) {
    showNotification('ไฟล์ต้องไม่เกิน 1MB เพื่อให้เสียงเด้งไวบน OBS', 'error');
    return;
  }

  const soundUrlToDelete = soundUrlInput?.value || null;
  setStatus('กำลังขอ URL อัปโหลด...');
  try {
    const presignRes = await fetchWithCsrf('/api/upload/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileType: normalizedType, category: 'sound', originalName: file.name, fileSize: file.size })
    });
    if (!presignRes.ok) throw new Error((await presignRes.json()).error || 'ขอ URL ไม่สำเร็จ');
    const { uploadUrl, fileUrl } = await presignRes.json();

    setStatus('กำลังอัปโหลดไฟล์เสียง...');
    const putRes = await fetch(uploadUrl, {
      method: 'PUT', body: file,
      headers: { 'Content-Type': normalizedType }
    });
    if (!putRes.ok) throw new Error('PUT ไม่สำเร็จ HTTP ' + putRes.status);

    deleteOldR2File(soundUrlToDelete, 'sound');
    if (soundUrlInput) soundUrlInput.value = fileUrl;
    if (currentNameEl) currentNameEl.textContent = `${file.name} (${Math.round(file.size / 1024)}KB)`;
    if (currentWrap) currentWrap.style.display = 'flex';
    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('อัปโหลดไฟล์เสียงสำเร็จ');
    fetchWithCsrf('/api/overlay/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soundChoice: 'upload_sound', customSoundUrl: fileUrl }) })
      .catch(e => console.warn('Auto-save sound failed:', e.message));
  } catch (err) {
    console.error('Audio upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

function clearProfileImage() {
  document.getElementById('profileImageValue').value = '';
  const profilePreview = document.getElementById('profilePreview');
  if (profilePreview) {
    setMediaPreview(profilePreview, '/avatar.jpg');
    const vid = document.getElementById('profilePreview_vid');
    if (vid) vid.style.display = 'none';
  }
  const brandLogo = document.getElementById('brandLogoImg');
  if (brandLogo) setMediaPreview(brandLogo, '/avatar.jpg');
  const fileInput = document.getElementById('profileImageFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('profileImageStatus');
  if (status) status.textContent = '';
  const btn = document.getElementById('btnClearProfileImage');
  if (btn) btn.style.display = 'none';
}

function clearHeaderBg() {
  const urlInput = document.getElementById('inputHeaderBgUrl');
  if (urlInput) {
    urlInput.value = '';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const dragPreview = document.getElementById('headerBgDragPreview');
  if (dragPreview) {
    dragPreview.style.backgroundImage = 'none';
    const vid = dragPreview.querySelector('video.header-bg-vid');
    if (vid) vid.remove();
  }
  const fileInput = document.getElementById('headerBgFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('headerBgStatus');
  if (status) status.textContent = '';
  const btn = document.getElementById('btnClearHeaderBg');
  if (btn) btn.style.display = 'none';
}

function clearPageBg() {
  const urlInput = document.getElementById('inputPageBgUrl');
  if (urlInput) urlInput.value = '';
  const preview = document.getElementById('pageBgPreview');
  if (preview) {
    preview.src = '';
    preview.style.display = 'none';
    const vid = document.getElementById('pageBgPreview_vid');
    if (vid) vid.style.display = 'none';
  }
  const fileInput = document.getElementById('pageBgFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('pageBgStatus');
  if (status) status.textContent = '';
  const btn = document.getElementById('btnClearPageBg');
  if (btn) btn.style.display = 'none';
}

function clearCustomImage() {
  const valueInput = document.getElementById('customImageValue');
  if (valueInput) valueInput.value = '';
  const preview = document.getElementById('customImagePreview');
  if (preview) {
    preview.src = '';
    preview.style.display = 'none';
    const vid = document.getElementById('customImagePreview_vid');
    if (vid) vid.style.display = 'none';
  }
  const fileInput = document.getElementById('customImageFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('customImageStatus');
  if (status) status.textContent = '';
  const btn = document.getElementById('btnClearCustomImage');
  if (btn) btn.style.display = 'none';
}

function clearUploadSound() {
  const urlInput = document.getElementById('customSoundUrl');
  if (urlInput) urlInput.value = '';
  const currentWrap = document.getElementById('uploadSoundCurrentWrap');
  if (currentWrap) currentWrap.style.display = 'none';
  const fileInput = document.getElementById('uploadSoundFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('uploadSoundStatus');
  if (status) status.textContent = '';
}

// ========== Tier Donate (TIER_DONATE_BLUEPRINT.md § 3) ==========
let tierAlertImages = [null, null, null]; // index 0-2 = slot 1-3, saved with main form submit
let soundLibraryItems = []; // auto-saved on every add/remove (§ 3.3)

const TIER_IMAGE_SLOT_IDS = {
  1: { preview: 'tierImagePreview1', file: 'tierImageFile1', clear: 'btnClearTierImage1', status: 'tierImageStatus1' },
  2: { preview: 'tierImagePreview2', file: 'tierImageFile2', clear: 'btnClearTierImage2', status: 'tierImageStatus2' },
  3: { preview: 'tierImagePreview3', file: 'tierImageFile3', clear: 'btnClearTierImage3', status: 'tierImageStatus3' }
};

function updateTierImageLibraryCount() {
  const countLbl = document.getElementById('lblTierImageLibraryCount');
  if (countLbl) countLbl.textContent = tierAlertImages.filter(img => img && img.url).length;
}

function renderTierImageSlot(slot) {
  const ids = TIER_IMAGE_SLOT_IDS[slot];
  const entry = tierAlertImages[slot - 1];
  const preview = document.getElementById(ids.preview);
  const clearBtn = document.getElementById(ids.clear);
  updateTierImageLibraryCount();
  if (entry && entry.url) {
    if (preview) { setMediaPreview(preview, entry.url); preview.style.display = isWebm(entry.url) ? 'none' : 'block'; }
    if (clearBtn) clearBtn.style.display = '';
  } else {
    if (preview) {
      preview.src = '';
      preview.style.display = 'none';
      const vid = document.getElementById(ids.preview + '_vid');
      if (vid) vid.style.display = 'none';
    }
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

async function handleTierImageFileSelect(slot, event) {
  const file = event.target.files[0];
  if (!file) return;
  const ids = TIER_IMAGE_SLOT_IDS[slot];
  const status = document.getElementById(ids.status);
  const setStatus = (msg, color) => { if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; } };
  try {
    const oldUrl = tierAlertImages[slot - 1]?.url || null;
    const fileUrl = await uploadImageToR2(file, 'tierAlert', 5, 1200, setStatus);
    deleteOldR2File(oldUrl, 'tierAlert');
    tierAlertImages[slot - 1] = { url: fileUrl, type: isWebm(fileUrl) ? 'video' : 'image' };
    renderTierImageSlot(slot);
    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('อัปโหลดภาพสำเร็จ กด "บันทึกการตั้งค่า" เพื่อยืนยัน');
  } catch (err) {
    console.error('Tier image upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

function clearTierImage(slot) {
  const entry = tierAlertImages[slot - 1];
  if (entry && entry.url) deleteOldR2File(entry.url, 'tierAlert');
  tierAlertImages[slot - 1] = null;
  const ids = TIER_IMAGE_SLOT_IDS[slot];
  const fileInput = document.getElementById(ids.file);
  if (fileInput) fileInput.value = '';
  const status = document.getElementById(ids.status);
  if (status) status.textContent = '';
  renderTierImageSlot(slot);
}

function loadTierDonateSettingsFromData(s) {
  let t = {};
  try { t = JSON.parse(s.tier_donate_settings || '{}'); } catch (e) {}
  const chkEnabled = document.getElementById('chkTierDonateEnabled');
  if (chkEnabled) chkEnabled.checked = !!t.enabled;
  updateWidgetBodyVisibility('chkTierDonateEnabled');

  const tiers = Array.isArray(t.tiers) ? t.tiers : [];
  const defaults = [
    { level: 1, min_amount: 50, allow_image_choice: true, allow_sound_choice: false, allow_own_upload: false, allow_own_record: false, allow_youtube_clip: false },
    { level: 2, min_amount: 200, active: false, allow_image_choice: true, allow_sound_choice: true, allow_own_upload: false, allow_own_record: false, allow_youtube_clip: false },
    { level: 3, min_amount: 500, active: false, allow_image_choice: true, allow_sound_choice: true, allow_own_upload: true, allow_own_record: true, allow_youtube_clip: false }
  ];
  const rowIds = {
    1: { name: 'tierName1', min: 'tierMinAmount1', img: 'tierAllowImage1', snd: 'tierAllowSound1', upload: 'tierAllowOwnUpload1', youtube: 'tierAllowYoutubeClip1', record: 'tierAllowOwnRecord1' },
    2: { active: 'tierActive2', name: 'tierName2', min: 'tierMinAmount2', img: 'tierAllowImage2', snd: 'tierAllowSound2', upload: 'tierAllowOwnUpload2', youtube: 'tierAllowYoutubeClip2', record: 'tierAllowOwnRecord2' },
    3: { active: 'tierActive3', name: 'tierName3', min: 'tierMinAmount3', img: 'tierAllowImage3', snd: 'tierAllowSound3', upload: 'tierAllowOwnUpload3', youtube: 'tierAllowYoutubeClip3', record: 'tierAllowOwnRecord3' }
  };
  [1, 2, 3].forEach(level => {
    const d = defaults[level - 1];
    const saved = tiers.find(x => x.level === level) || d;
    const ids = rowIds[level];
    if (ids.active) {
      const activeEl = document.getElementById(ids.active);
      if (activeEl) activeEl.checked = saved.active !== false && saved.active !== undefined ? !!saved.active : false;
      updateWidgetBodyVisibility(ids.active);
    }
    const nameEl = document.getElementById(ids.name);
    if (nameEl) nameEl.value = saved.name ?? '';
    const minEl = document.getElementById(ids.min);
    if (minEl) minEl.value = saved.min_amount ?? d.min_amount;
    const imgEl = document.getElementById(ids.img);
    if (imgEl) imgEl.checked = saved.allow_image_choice !== undefined ? !!saved.allow_image_choice : !!d.allow_image_choice;
    const sndEl = document.getElementById(ids.snd);
    if (sndEl) sndEl.checked = saved.allow_sound_choice !== undefined ? !!saved.allow_sound_choice : !!d.allow_sound_choice;
    const uploadEl = document.getElementById(ids.upload);
    if (uploadEl) uploadEl.checked = saved.allow_own_upload !== undefined ? !!saved.allow_own_upload : (!!saved.allow_own_audio || !!d.allow_own_upload);
    const youtubeEl = document.getElementById(ids.youtube);
    if (youtubeEl) youtubeEl.checked = saved.allow_youtube_clip !== undefined ? !!saved.allow_youtube_clip : !!d.allow_youtube_clip;
    const recordEl = document.getElementById(ids.record);
    if (recordEl) recordEl.checked = saved.allow_own_record !== undefined ? !!saved.allow_own_record : (!!saved.allow_own_audio || !!d.allow_own_record);
  });

  tierAlertImages = [null, null, null];
  const images = Array.isArray(t.alert_images) ? t.alert_images : [];
  images.slice(0, 3).forEach((img, i) => { tierAlertImages[i] = img; });
  [1, 2, 3].forEach(slot => renderTierImageSlot(slot));

  let library = [];
  try { library = JSON.parse(s.sound_library || '[]'); } catch (e) {}
  soundLibraryItems = Array.isArray(library) ? library : [];
  renderSoundLibraryList();
}

function renderSoundLibraryList() {
  const list = document.getElementById('soundLibraryList');
  const countLbl = document.getElementById('lblSoundLibraryCount');
  const fullNotice = document.getElementById('soundLibraryFullNotice');
  const addWrap = document.getElementById('soundLibraryAddWrap');
  if (countLbl) countLbl.textContent = soundLibraryItems.length;
  if (fullNotice) fullNotice.style.display = soundLibraryItems.length >= 5 ? '' : 'none';
  if (addWrap) addWrap.style.display = soundLibraryItems.length >= 5 ? 'none' : '';
  if (!list) return;
  list.innerHTML = '';
  soundLibraryItems.forEach((item, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;background:rgba(255,255,255,0.03);border-radius:8px;';
    row.innerHTML = `
      <span style="flex:1;font-size:13px;">${escapeHtml(item.label)}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-play-idx="${i}"><i class="fa-solid fa-play"></i></button>
      <button type="button" class="btn-clear-upload" data-remove-idx="${i}" title="ลบ"><i class="fa-solid fa-xmark"></i></button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-play-idx]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.playIdx, 10);
      new Audio(soundLibraryItems[idx].url).play().catch(() => {});
    };
  });
  list.querySelectorAll('[data-remove-idx]').forEach(btn => {
    btn.onclick = () => removeSoundLibraryItem(parseInt(btn.dataset.removeIdx, 10));
  });
}

async function saveSoundLibrary() {
  try {
    const res = await fetchWithCsrf('/api/overlay/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sound_library: JSON.stringify(soundLibraryItems) })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      showNotification(errData.error || 'บันทึกคลังเสียงไม่สำเร็จ', 'error');
      return false;
    }
    return true;
  } catch (err) {
    showNotification('ไม่สามารถบันทึกคลังเสียงได้', 'error');
    return false;
  }
}

async function removeSoundLibraryItem(idx) {
  const item = soundLibraryItems[idx];
  if (!item) return;
  soundLibraryItems.splice(idx, 1);
  renderSoundLibraryList();
  const saved = await saveSoundLibrary();
  if (saved) {
    deleteOldR2File(item.url, 'sound');
    showNotification('ลบเสียงสำเร็จ');
  }
}

async function handleSoundLibraryFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('soundLibraryStatus');
  const labelInput = document.getElementById('soundLibraryLabelInput');
  const setStatus = (msg, color) => { if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; } };
  const label = (labelInput?.value || '').trim();
  if (!label) { showNotification('กรุณาใส่ชื่อเสียงก่อนอัปโหลด', 'error'); return; }
  if (soundLibraryItems.length >= 5) { showNotification('ครบจำนวนสูงสุด 5 ไฟล์แล้ว', 'error'); return; }

  const allowedFormats = ['audio/mpeg', 'audio/mp3', 'audio/ogg'];
  const normalizedType = file.type === 'audio/mp3' ? 'audio/mpeg' : file.type;
  if (!allowedFormats.includes(file.type) && !allowedFormats.includes(normalizedType)) {
    showNotification('รองรับเฉพาะไฟล์ .mp3 และ .ogg เท่านั้น', 'error');
    return;
  }
  if (file.size > 1024 * 1024) {
    showNotification('ไฟล์ต้องไม่เกิน 1MB', 'error');
    return;
  }

  setStatus('กำลังขอ URL อัปโหลด...');
  try {
    const presignRes = await fetchWithCsrf('/api/upload/presign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileType: normalizedType, category: 'sound', originalName: file.name, fileSize: file.size })
    });
    if (!presignRes.ok) throw new Error((await presignRes.json()).error || 'ขอ URL ไม่สำเร็จ');
    const { uploadUrl, fileUrl } = await presignRes.json();

    setStatus('กำลังอัปโหลดไฟล์เสียง...');
    const putRes = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': normalizedType } });
    if (!putRes.ok) throw new Error('PUT ไม่สำเร็จ HTTP ' + putRes.status);

    soundLibraryItems.push({ url: fileUrl, label });
    renderSoundLibraryList();
    const saved = await saveSoundLibrary();
    if (!saved) { soundLibraryItems.pop(); renderSoundLibraryList(); deleteOldR2File(fileUrl, 'sound'); return; }

    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('เพิ่มเสียงในคลังสำเร็จ');
    if (labelInput) labelInput.value = '';
    event.target.value = '';
  } catch (err) {
    console.error('Sound library upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

function openSoundLibraryModal() {
  const modal = document.getElementById('soundLibraryModal');
  if (modal) modal.classList.add('active');
}
function closeSoundLibraryModal() {
  const modal = document.getElementById('soundLibraryModal');
  if (modal) modal.classList.remove('active');
}
function openTierImageLibraryModal() {
  const modal = document.getElementById('tierImageLibraryModal');
  if (modal) modal.classList.add('active');
}
function closeTierImageLibraryModal() {
  const modal = document.getElementById('tierImageLibraryModal');
  if (modal) modal.classList.remove('active');
}

async function handleTimerAudioFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const status = document.getElementById('timerUploadSoundStatus');
  const soundUrlInput = document.getElementById('timerCustomSoundUrl');
  const currentNameEl = document.getElementById('timerUploadSoundCurrentName');
  const currentWrap = document.getElementById('timerUploadSoundCurrentWrap');

  const setStatus = (msg, color) => {
    if (status) { status.textContent = msg; status.style.color = color || 'var(--text-muted)'; }
  };

  const allowedFormats = ['audio/mpeg', 'audio/mp3', 'audio/ogg'];
  const normalizedType = file.type === 'audio/mp3' ? 'audio/mpeg' : file.type;
  if (!allowedFormats.includes(file.type) && !allowedFormats.includes(normalizedType)) {
    showNotification('รองรับเฉพาะไฟล์ .mp3 และ .ogg เท่านั้น', 'error');
    return;
  }
  if (file.size > 1024 * 1024) {
    showNotification('ไฟล์ต้องไม่เกิน 1MB เพื่อให้เสียงเด้งไวบน OBS', 'error');
    return;
  }

  setStatus('กำลังขอ URL อัปโหลด...');
  try {
    const presignRes = await fetchWithCsrf('/api/upload/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileType: normalizedType, category: 'sound', originalName: file.name, fileSize: file.size })
    });
    if (!presignRes.ok) throw new Error((await presignRes.json()).error || 'ขอ URL ไม่สำเร็จ');
    const { uploadUrl, fileUrl } = await presignRes.json();

    setStatus('กำลังอัปโหลดไฟล์เสียง...');
    const putRes = await fetch(uploadUrl, {
      method: 'PUT', body: file,
      headers: { 'Content-Type': normalizedType }
    });
    if (!putRes.ok) throw new Error('PUT ไม่สำเร็จ HTTP ' + putRes.status);

    if (soundUrlInput) soundUrlInput.value = fileUrl;
    if (currentNameEl) currentNameEl.textContent = `${file.name} (${Math.round(file.size / 1024)}KB)`;
    if (currentWrap) currentWrap.style.display = 'flex';
    setStatus('อัปโหลดสำเร็จ!', '#22c55e');
    showNotification('อัปโหลดไฟล์เสียง Timer สำเร็จ');
  } catch (err) {
    console.error('Timer audio upload error:', err);
    setStatus('เกิดข้อผิดพลาด: ' + err.message, '#ef4444');
    showNotification('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
  }
}

function clearTimerUploadSound() {
  const urlInput = document.getElementById('timerCustomSoundUrl');
  if (urlInput) urlInput.value = '';
  const currentWrap = document.getElementById('timerUploadSoundCurrentWrap');
  if (currentWrap) currentWrap.style.display = 'none';
  const fileInput = document.getElementById('timerUploadSoundFile');
  if (fileInput) fileInput.value = '';
  const status = document.getElementById('timerUploadSoundStatus');
  if (status) status.textContent = '';
}

function toggleProfanitySubSettings(enabled) {
  const container = document.getElementById('profanitySubSettingsContainer');
  if (!container) return;
  container.style.display = enabled ? 'block' : 'none';
}

function parseJsonField(value, fallback = null) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function updateColorPickerVisibility(theme) {
  const container = document.getElementById('customColorsContainer');
  if (!container) return;
  if (!theme) {
    const themeSelect = document.getElementById('themeSelect');
    theme = themeSelect ? themeSelect.value : 'glassmorphism';
  }
  container.setAttribute('data-theme', theme);
  const themeKeys = {
    glassmorphism: ['donor', 'amount', 'border', 'text', 'suffix'],
    cyberpunk: ['donor', 'amount', 'border', 'text', 'suffix'],
    custom: ['donor', 'amount', 'border', 'bg', 'text', 'suffix'],
    'text-only': ['donor', 'amount', 'text', 'suffix'],
    minimal: ['donor', 'amount', 'border', 'text', 'suffix']
  };
  const keys = themeKeys[theme] || themeKeys.glassmorphism;
  document.querySelectorAll('#themeColorGrid .color-picker-group').forEach(group => {
    const match = group.className.match(/color-key-(\w+)/);
    const key = match ? match[1] : null;
    group.style.display = key && keys.includes(key) ? '' : 'none';
  });
}

function setColorInput(colorId, textId, value) {
  const colorEl = document.getElementById(colorId);
  const textEl = document.getElementById(textId);
  const raw = value || '';
  if (textEl) textEl.value = raw;
  if (colorEl && raw.startsWith('#')) {
    colorEl.value = raw;
  }
}

function setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.value = String(value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function syncGoalPointerControls(data) {
  const chk = document.getElementById('chkGoalPointerEnabled');
  const sideEl = document.getElementById('selectGoalPointerSide');
  const contentEl = document.getElementById('selectGoalPointerContent');
  const panel = document.getElementById('goalPointerPanel');
  if (chk) chk.checked = !!data.goal_pointer_enabled;
  if (sideEl) {
    sideEl.value = data.goal_pointer_side || 'right';
    sideEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (contentEl) {
    contentEl.value = data.goal_pointer_content || 'both';
    contentEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (panel) {
    panel.classList.toggle('disabled', !(chk && chk.checked));
    if (!chk._pointerToggleBound) {
      chk.addEventListener('change', () => {
        panel.classList.toggle('disabled', !chk.checked);
      });
      chk._pointerToggleBound = true;
    }
  }
}

async function loadOverlaySettings() {
  showTabLoading('overlay-config');
  try {
    const response = await fetch('/api/overlay/settings');
    if (response.ok) {
      const s = await response.json();
      
      // Map to inputs
      const theme = s.theme || 'glassmorphism';
      document.getElementById('themeSelect').value = theme;
      document.getElementById('fontSelect').value = s.fontFamily;
      document.getElementById('animSelect').value = s.animation;

      // Per-theme color overrides (fallback to legacy flat colors)
      const themeColors = parseJsonField(s.theme_colors, {});
      const container = document.getElementById('customColorsContainer');
      if (container) container.dataset.savedThemeColors = JSON.stringify(themeColors);
      const colors = themeColors[theme] || {};
      setColorInput('colorDonor', 'txtDonor', colors.donor || '#fde047');
      setColorInput('colorAmount', 'txtAmount', colors.amount || s.primaryColor || '#4ade80');
      setColorInput('colorBorder', 'txtBorder', colors.border || s.borderColor || 'rgba(255,255,255,0.25)');
      setColorInput('colorBg', 'txtBg', colors.bg || s.backgroundColor || 'rgba(15,15,25,0.88)');
      setColorInput('colorText', 'txtText', colors.text || s.textColor || '#ffffff');
      setColorInput('colorSuffix', 'txtSuffix', colors.suffix || '#f59e0b');
      updateColorPickerVisibility(theme);

      // Per-element font sizes (fallback to legacy fontSize for amount)
      const fontSizes = parseJsonField(s.alert_font_sizes, {});
      setSelectValue('selectFontSizeHeader', fontSizes.header ?? 36);
      setSelectValue('selectFontSizeDonorHl', fontSizes.donor_hl ?? fontSizes.header ?? 40);
      setSelectValue('selectFontSizeMessage', fontSizes.message ?? 28);
      setSelectValue('selectFontSizeAmount', fontSizes.amount ?? s.fontSize ?? 36);
      setSelectValue('selectFontSizeAmountHl', fontSizes.amount_hl ?? fontSizes.amount ?? s.fontSize ?? 72);
      setSelectValue('selectFontSizeSuffix', fontSizes.suffix ?? 72);

      // Outline widths
      const outline = parseJsonField(s.alert_outline, { header_amount: 2, message: 1 });
      setSelectValue('selectOutlineHeaderAmount', outline.header_amount ?? 2);
      setSelectValue('selectOutlineMessage', outline.message ?? 1);

      // Ranges
      document.getElementById('sliderDuration').value = s.duration;
      document.getElementById('lblDuration').textContent = s.duration;

      setSelectValue('selectParticles', s.particleCount ?? 15);
 
       // Audio Checkboxes
       document.getElementById('chkSoundEnabled').checked = s.soundEnabled;
       document.getElementById('soundChoiceSelect').value = s.soundChoice;
       toggleCustomSoundUrlContainer(s.soundChoice);
       document.getElementById('sliderSoundVolume').value = s.soundVolume;
       document.getElementById('lblSoundVolume').textContent = Math.round(s.soundVolume * 100);

 
      // TTS Checkboxes
      document.getElementById('chkTtsEnabled').checked = s.ttsEnabled;
      document.getElementById('chkTtsReadDonor').checked = s.ttsReadDonor !== undefined ? s.ttsReadDonor : true;
      document.getElementById('chkTtsPrefixEnabled').checked = s.ttsPrefixEnabled !== undefined ? s.ttsPrefixEnabled : true;

      document.getElementById('sliderTtsVolume').value = s.ttsVolume;
      document.getElementById('lblTtsVolume').textContent = Math.round(s.ttsVolume * 100);
      document.getElementById('sliderTtsRate').value = s.ttsRate;
      document.getElementById('lblTtsRate').textContent = (s.ttsRate - 0.3).toFixed(1);
 
      // Template Strings
      document.getElementById('inputTemplateLine1').value = s.template_line1 || s.messageTemplate || '{ผู้โดเนท} ได้เลี้ยงกาแฟ';
      document.getElementById('inputTemplateLine2').value = s.template_line2 || '';
      document.getElementById('inputAmountSuffix').value = s.amountSuffix || 'บาท';
       document.getElementById('chkShowDonorMessage').checked = s.showDonorMessage;
       document.getElementById('inputMinAmount').value = s.minAmount;
       
       // Custom Visuals — normalize legacy 'url' mode to 'upload'
       const imgMode = s.customImageMode === 'url' ? 'upload' : (s.customImageMode || 'emoji');
       document.getElementById('customImageMode').value = imgMode;
       document.getElementById('customImageValue').value = s.customImageValue || '🎁';
       toggleCustomImageUI(imgMode, s.customImageValue);
       document.getElementById('customSoundUrl').value = s.customSoundUrl || '';
       // Show current uploaded sound name if upload_sound mode
       if (s.soundChoice === 'upload_sound' && s.customSoundUrl) {
         const wrap = document.getElementById('uploadSoundCurrentWrap');
         const nameEl = document.getElementById('uploadSoundCurrentName');
         if (wrap) wrap.style.display = 'flex';
         if (nameEl) nameEl.textContent = s.customSoundUrl.split('/').pop();
       }
       // Show clear button for custom image if upload mode with value
       const loadedImgMode = s.customImageMode === 'url' ? 'upload' : (s.customImageMode || 'emoji');
       const loadedImgVal = s.customImageValue || '';
       document.getElementById('btnClearCustomImage')?.style.setProperty('display',
         (loadedImgMode === 'upload' && loadedImgVal.startsWith('http')) ? '' : 'none');
       
       // Profanity Filter
       document.getElementById('chkProfanityFilterEnabled').checked = s.profanityFilterEnabled;
       document.getElementById('profanityReplaceStyleSelect').value = s.profanityReplaceStyle || 'asterisks';
       document.getElementById('inputProfanityWords').value = s.profanityWords || '';

       // Tier Donate (TIER_DONATE_BLUEPRINT.md § 3)
       loadTierDonateSettingsFromData(s);

       // Notify CustomSelect wrappers by dispatching change events
       ['themeSelect', 'fontSelect', 'animSelect', 'soundChoiceSelect',
        'customImageMode', 'profanityReplaceStyleSelect',
        'selectFontSizeHeader', 'selectFontSizeDonorHl', 'selectFontSizeMessage', 'selectFontSizeAmount', 'selectFontSizeAmountHl', 'selectFontSizeSuffix',
        'selectOutlineHeaderAmount', 'selectOutlineMessage', 'selectParticles'].forEach(id => {
         const el = document.getElementById(id);
         if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
       });

       // Handle custom fields toggle on startup
       toggleTtsSubSettings(s.ttsEnabled);
       toggleAudioSettingsRow(s.soundEnabled);
       toggleProfanitySubSettings(s.profanityFilterEnabled);
    }
  } catch (err) {
    console.error('Failed to load overlay settings:', err);
    tabLoaded['overlay-config'] = false;
  } finally {
    hideTabLoading('overlay-config');
  }
}

async function loadGoalSettings() {
  try {
    const [settingsRes, tokenRes] = await Promise.all([
      fetch('/api/overlay/settings'),
      fetch('/api/overlay/token')
    ]);
    if (!settingsRes.ok) return;
    const data = await settingsRes.json();
    const color = data.goal_bar_color || '#4ade80';

    document.getElementById('chkGoalEnabled').checked = !!data.goal_enabled;
    updateWidgetBodyVisibility('chkGoalEnabled');
    const chkSound = document.getElementById('chkGoalAnimSound');
    chkSound.checked = data.goal_anim_sound !== 0 && data.goal_anim_sound !== false;
    const chkAnimEnabled = document.getElementById('chkGoalAnimEnabled');
    chkAnimEnabled.checked = data.goal_anim_enabled !== 0 && data.goal_anim_enabled !== false;
    const volSlider = document.getElementById('sliderGoalAnimVolume');
    const volLbl = document.getElementById('lblGoalAnimVolume');
    const goalAnimVol = data.goal_anim_sound_volume !== undefined && data.goal_anim_sound_volume !== null ? data.goal_anim_sound_volume : 1;
    if (volSlider) volSlider.value = goalAnimVol;
    if (volLbl) volLbl.textContent = Math.round(goalAnimVol * 100);
    const syncSoundVis = () => {
      const soundGroup = chkSound.closest('.form-group');
      const volGroup = document.getElementById('goalAnimVolumeGroup');
      if (soundGroup) soundGroup.style.display = chkAnimEnabled.checked ? '' : 'none';
      if (volGroup) volGroup.style.display = (chkAnimEnabled.checked && chkSound.checked) ? '' : 'none';
    };
    chkAnimEnabled.onchange = syncSoundVis;
    chkSound.onchange = syncSoundVis;
    syncSoundVis();
    document.getElementById('chkGoalShowOnDonate').checked = !!data.goal_show_on_donate;
    const posEl = document.getElementById('selectGoalBarPosition');
    if (posEl) {
      posEl.value = data.goal_bar_position || 'top';
      posEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const layoutEl = document.getElementById('selectGoalBarLayout');
    if (layoutEl) {
      layoutEl.value = data.goal_bar_layout || 'horizontal';
      layoutEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncGoalPointerControls(data);
    syncGoalWidthLabel();
    document.getElementById('inputGoalLabel').value = data.goal_label !== undefined ? data.goal_label : 'ค่ากาแฟ';
    document.getElementById('inputGoalAmount').value = data.goal_amount || 5000;
    document.getElementById('inputGoalBarColor').value = color;
    const txtColor = document.getElementById('txtGoalBarColor');
    if (txtColor) txtColor.value = color;
    const widthEl = document.getElementById('inputGoalBarWidth');
    if (widthEl) {
      widthEl.value = normalizeGoalBarWidth(data.goal_bar_width);
      widthEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const thicknessEl = document.getElementById('inputGoalBarThickness');
    if (thicknessEl) {
      thicknessEl.value = normalizeGoalBarThickness(data.goal_bar_thickness);
      thicknessEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const barTextEl = document.getElementById('inputGoalBarText');
    if (barTextEl) barTextEl.value = data.goal_bar_text !== undefined ? data.goal_bar_text : '{เปอร์เซนต์}';
    const sub1El = document.getElementById('inputGoalSubtitle1');
    if (sub1El) sub1El.value = data.goal_subtitle1 !== undefined ? data.goal_subtitle1 : '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿';
    const sub2El = document.getElementById('inputGoalSubtitle2');
    if (sub2El) sub2El.value = data.goal_subtitle2 !== undefined ? data.goal_subtitle2 : '';

    // Goal text customization blob
    let gtc = {};
    try { gtc = JSON.parse(data.goal_text_settings || '{}'); } catch (e) {}
    setSelectValue('selectGoalFontSizeLabel', gtc.font_size_label || 30);
    setSelectValue('selectGoalFontSizeBar',   gtc.font_size_bar   || 25);
    setSelectValue('selectGoalFontSizeSub1',  gtc.font_size_sub1  || 20);
    setSelectValue('selectGoalFontSizeSub2',  gtc.font_size_sub2  || 20);
    setSelectValue('selectGoalOutlineWidth', gtc.outline_width ?? gtc.outline_width_label ?? 2);
    ['selectGoalFontSizeLabel','selectGoalFontSizeBar','selectGoalFontSizeSub1','selectGoalFontSizeSub2',
     'selectGoalOutlineWidth']
      .forEach(id => { const el = document.getElementById(id); if (el) el.dispatchEvent(new Event('change', { bubbles: true })); });
    [
      ['inputGoalTextColorLabel','txtGoalTextColorLabel', gtc.color_label, '#ffffff'],
      ['inputGoalTextColorBar','txtGoalTextColorBar',     gtc.color_bar,   '#ffffff'],
      ['inputGoalTextColorSub1','txtGoalTextColorSub1',   gtc.color_sub1,  '#ffffff'],
      ['inputGoalTextColorSub2','txtGoalTextColorSub2',   gtc.color_sub2,  '#ffffff'],
      ['inputGoalOutlineColor','txtGoalOutlineColor',     gtc.outline_color, '#000000']
    ].forEach(([p, t, v, f]) => {
      const pe = document.getElementById(p), te = document.getElementById(t);
      if (pe) pe.value = v || f;
      if (te) te.value = v || f;
    });

    const hasEndDate = !!(data.goal_end_date);
    const chkEndDate = document.getElementById('chkGoalEndDate');
    const endDateSection = document.getElementById('goalEndDateSection');
    const endDateInput = document.getElementById('inputGoalEndDate');
    if (chkEndDate) chkEndDate.checked = hasEndDate;
    if (endDateSection) endDateSection.style.display = hasEndDate ? '' : 'none';
    if (endDateInput && data.goal_end_date) {
      // datetime-local needs format YYYY-MM-DDTHH:MM
      endDateInput.value = data.goal_end_date.slice(0, 16);
    }

    updateGoalPreview(data.goal_current || 0, data.goal_amount || 5000);

    if (tokenRes.ok) {
      const { token } = await tokenRes.json();
      const goalBarUrl = `${location.origin}/goal-bar?token=${token}`;
      const obsUrlEl = document.getElementById('obsGoalBarUrlPreview');
      if (obsUrlEl) obsUrlEl.value = goalBarUrl;
    }
  } catch (err) {
    console.error('Failed to load goal settings:', err);
  }
}

function updateGoalPreview(current, amount) {
  const curEl = document.getElementById('spanGoalCurrent');
  const amtEl = document.getElementById('spanGoalAmount');
  if (curEl) curEl.textContent = (current || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
  if (amtEl) amtEl.textContent = (amount || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}

// ========== Timer Settings ==========

// Rules builder helpers
const MAX_TIMER_RULES = 10;
let timerRules = [];

// TikTok ack = browser-level consent (localStorage), ไม่ใช่ account setting
const TIKTOK_ACK_KEY = 'tipkub_tiktok_ack';
const isTiktokAcked = () => localStorage.getItem(TIKTOK_ACK_KEY) === '1';
const setTiktokAcked = () => localStorage.setItem(TIKTOK_ACK_KEY, '1');

// ── TikTok Bridge card logic ────────────────────────────────────

function goToTiktokPanel() {
  const header = document.querySelector('.settings-card-header[data-target="panelTiktok"]');
  const panel = document.getElementById('panelTiktok');
  const card = header?.closest('.dashboard-card');
  if (!card) return;
  if (panel && panel.style.display === 'none') header.click();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('tiktok-attention');
  void card.offsetWidth;
  card.classList.add('tiktok-attention');
}

// ── Bridge connection badge (แยกจาก toggle: toggle=setting, badge=สถานะจริง) ──
let tiktokPollTimer = null;

// state → [dotClass, label, textColor] — dot ใช้ .status-dot เหมือนหน้าโดเนท (ไม่ใช้ emoji)
function renderTiktokBadge(state) {
  const map = {
    ready:   ['online', 'พร้อมรับ Gift', '#22c55e'],
    open:    ['warn', 'เปิดตัวเชื่อมต่อแล้ว · TikFinity ยังไม่เชื่อม', '#f59e0b'],
    notopen: ['', 'ยังไม่เปิดตัวเชื่อมต่อ', '#94a3b8'],
  };
  const [dotCls, label, color] = map[state] || map.notopen;
  document.querySelectorAll('.js-tiktok-badge').forEach(badge => {
    const dot = badge.querySelector('.status-dot');
    const text = badge.querySelector('.js-tiktok-badge-text');
    if (dot) dot.className = 'status-dot' + (dotCls ? ' ' + dotCls : '');
    if (text) text.textContent = label;
    badge.style.color = color;
  });
}

// set dot+text โดยไม่แตะ structure (placeholder / ปิดอยู่)
function setTiktokBadgeText(label, color, dotCls = '') {
  document.querySelectorAll('.js-tiktok-badge').forEach(badge => {
    const dot = badge.querySelector('.status-dot');
    const text = badge.querySelector('.js-tiktok-badge-text');
    if (dot) dot.className = 'status-dot' + (dotCls ? ' ' + dotCls : '');
    if (text) text.textContent = label;
    badge.style.color = color;
  });
}

async function pollTiktokStatus() {
  try {
    const r = await fetch('/api/tiktok/status', { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    renderTiktokBadge(d.state);
  } catch { /* network blip — คงสถานะเดิมไว้ */ }
}

function startTiktokPoll() {
  stopTiktokPoll();
  setTiktokBadgeText('กำลังตรวจสอบ…', '#94a3b8');
  pollTiktokStatus();
  tiktokPollTimer = setInterval(pollTiktokStatus, 10000);
}
function stopTiktokPoll() {
  if (tiktokPollTimer) { clearInterval(tiktokPollTimer); tiktokPollTimer = null; }
}

function syncTiktokCard() {
  const toggle = document.getElementById('tiktokEnableToggle');
  const panel = document.getElementById('tiktokSettingsPanel');
  const badge = document.getElementById('tiktokStatusBadge');
  if (!toggle || !panel || !badge) return;
  const on = toggle.checked;
  panel.classList.toggle('tk-open', on);                   // grid slide-down
  const bridgeWrap = document.getElementById('btnTimerTiktokBridgeWrap');
  if (bridgeWrap) bridgeWrap.classList.toggle('tk-open', on);
  const refreshBtn = document.getElementById('tiktokStatusRefresh');
  if (refreshBtn) refreshBtn.style.display = on ? '' : 'none';
  if (on) {
    startTiktokPoll();                       // badge = สถานะ Bridge จริง (poll ทุก 10s)
  } else {
    stopTiktokPoll();
    setTiktokBadgeText('ปิดอยู่', '#64748b');
  }
  if (!on && timerRules.some(r => r.currency === 'coin')) {
    showNotification('กฏสกุลเหรียญจะหยุดทำงานชั่วคราวจนกว่าจะเปิด TikTok Live อีกครั้ง', 'error');
  }
}

function initTiktokCard() {
  const toggle = document.getElementById('tiktokEnableToggle');
  if (!toggle) return;

  const refreshBtn = document.getElementById('tiktokStatusRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    const icon = refreshBtn.querySelector('i');
    if (icon) { icon.classList.add('fa-spin'); setTimeout(() => icon.classList.remove('fa-spin'), 600); }
    pollTiktokStatus();
  });

  toggle.addEventListener('change', async (e) => {
    if (!e.target.checked) {
      syncTiktokCard();
      return;
    }
    if (isTiktokAcked()) {
      syncTiktokCard();
      return;
    }
    // C3: ack gate — show modal before enabling
    e.target.checked = false;
    syncTiktokCard();
    const modal = document.getElementById('tiktokAckModal');
    const ackCheck = document.getElementById('tiktokAckCheck');
    const btnAccept = document.getElementById('btnAcceptTiktokAck');
    if (!modal) return;
    if (ackCheck) ackCheck.checked = false;
    if (btnAccept) btnAccept.disabled = true;
    modal.style.display = 'flex';
  });

  const ackCheck = document.getElementById('tiktokAckCheck');
  const btnAccept = document.getElementById('btnAcceptTiktokAck');
  if (ackCheck && btnAccept) {
    const syncAckBtn = () => { btnAccept.disabled = !ackCheck.checked; };
    ackCheck.addEventListener('change', syncAckBtn);
    ackCheck.addEventListener('input', syncAckBtn);   // กัน change ไม่ fire บาง browser
  }

  // Disclaimer link in card opens modal (C6)
  const disclaimerLink = document.getElementById('tiktokDisclaimerLink');
  if (disclaimerLink) {
    disclaimerLink.addEventListener('click', (e) => {
      e.preventDefault();
      const modal = document.getElementById('tiktokAckModal');
      const ackCheck = document.getElementById('tiktokAckCheck');
      const btnAccept = document.getElementById('btnAcceptTiktokAck');
      if (modal) {
        if (ackCheck) ackCheck.checked = false;
        if (btnAccept) btnAccept.disabled = true;
        modal.style.display = 'flex';
      }
    });
  }

  const btnCancel = document.getElementById('btnCancelTiktokAck');
  const btnClose = document.getElementById('btnCloseTiktokAck');
  const closeModal = () => {
    const modal = document.getElementById('tiktokAckModal');
    if (modal) modal.style.display = 'none';
  };
  if (btnCancel) btnCancel.addEventListener('click', closeModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);

  if (btnAccept) {
    btnAccept.addEventListener('click', async () => {
      setTiktokAcked();           // ← localStorage แทน tiktokAcked = true
      closeModal();
      const toggle = document.getElementById('tiktokEnableToggle');
      if (toggle) toggle.checked = true;
      syncTiktokCard();
      await saveTimerSettings();
    });
  }
}

function timerRulesSetMode(mode) {
  const multSec = document.getElementById('timerMultiplierSection');
  const ruleSec = document.getElementById('timerRulesSection');
  if (!multSec || !ruleSec) return;
  const isMultiplier = mode === 'multiplier';
  multSec.style.display = isMultiplier ? '' : 'none';
  ruleSec.style.display = isMultiplier ? 'none' : '';
}

function makeEl(tag, props, text) {
  const el = document.createElement(tag);
  if (props) Object.assign(el, props);
  if (text !== undefined) el.textContent = text;
  return el;
}

// action select ร่วม 2 render — coin ตัด 'choice' (คนดู gift เลือกเวลาไม่ได้)
function buildRuleActionSelect(idx) {
  const rule = timerRules[idx];
  const isCoin = (rule.currency || 'thb') === 'coin';
  if (isCoin && rule.action === 'choice') rule.action = 'add'; // coin + choice → บังคับ add
  const sel = makeEl('select', { style: 'width:130px;' });
  const opts = [['add', '+เพิ่มเวลา'], ['sub', '−ลดเวลา']];
  if (!isCoin) opts.push(['choice', '±ผู้โดเนทเลือก']);
  opts.forEach(([val, label]) => {
    const opt = makeEl('option', { value: val }, label);
    if (rule.action === val) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = (e) => { timerRules[idx].action = e.target.value; };
  return sel;
}

function renderTimerRules(mode) {
  const container = document.getElementById('timerRulesContainer');
  const btnAdd = document.getElementById('btnAddTimerRule');
  if (!container) return;
  // cleanup orphaned cs-panels from previous render
  container.querySelectorAll('select[data-custom-select="true"]').forEach(sel => CustomDropdown.removeBySelect(sel));
  container.replaceChildren();
  const unit = document.getElementById('timerTimeUnit')?.value || 'seconds';
  timerRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'timer-rule-row';

    const lbl = makeEl('span', { style: 'color:var(--text-muted);white-space:nowrap;' }, `กฏ${idx + 1}`);

    const amtInput = makeEl('input', { type: 'number', className: 'form-control', min: 0, step: 'any', placeholder: '10', style: 'width:70px;' });
    amtInput.value = rule.amount ?? rule.base_amount ?? '';
    amtInput.oninput = (e) => {
      const v = parseFloat(e.target.value) || 0;
      timerRules[idx].amount = v;
      timerRules[idx].base_amount = v; // sync มาโหมด multiplier กัน user ต้องกรอกซ้ำ
    };

    const curSel = makeEl('select', { style: 'width:92px;' });
    [['thb', '฿ บาท'], ['coin', '🪙 เหรียญ']].forEach(([val, label]) => {
      const opt = makeEl('option', { value: val }, label);
      if ((rule.currency || 'thb') === val) opt.selected = true;
      curSel.appendChild(opt);
    });
    curSel.onchange = (e) => {
      if (e.target.value === 'coin' && !document.getElementById('tiktokEnableToggle')?.checked) {
        e.target.value = 'thb';
        e.target.dispatchEvent(new Event('change', { bubbles: true }));
        showNotification('เปิดใช้งาน TikTok Live ก่อน จึงจะตั้งกฏสกุลเหรียญได้', 'error');
        goToTiktokPanel();
        return;
      }
      timerRules[idx].currency = e.target.value;
      renderTimerRules(mode);
    };

    const arrow = makeEl('span', { style: 'color:var(--text-muted);white-space:nowrap;' }, '→');

    const actionSel = buildRuleActionSelect(idx);

    const rawSecs = rule.time_seconds || 0;
    const timeInput = makeEl('input', { type: 'number', className: 'form-control', min: 0, step: 'any', placeholder: '60', style: 'width:70px;' });
    timeInput.value = unit === 'minutes' ? +(rawSecs / 60).toFixed(2) : rawSecs;
    timeInput.oninput = (e) => {
      const factor = document.getElementById('timerTimeUnit')?.value === 'minutes' ? 60 : 1;
      timerRules[idx].time_seconds = (parseFloat(e.target.value) || 0) * factor;
    };

    const unitLbl = makeEl('span', { style: 'color:var(--text-muted);white-space:nowrap;' }, unit === 'minutes' ? 'นาที' : 'วิ');

    const delBtn = makeEl('button', { type: 'button', className: 'btn btn-icon', title: 'ลบกฏ', style: 'color:#ef4444;padding:6px 10px;' });
    delBtn.appendChild(Object.assign(document.createElement('i'), { className: 'fa-solid fa-trash-can' }));
    delBtn.onclick = () => { timerRules.splice(idx, 1); renderTimerRules(mode); };

    [lbl, amtInput, curSel, arrow, actionSel, timeInput, unitLbl, delBtn].forEach(el => row.appendChild(el));
    container.appendChild(row);
    CustomDropdown.wrapEl(curSel);
    CustomDropdown.wrapEl(actionSel);
  });
  if (btnAdd) btnAdd.disabled = timerRules.length >= MAX_TIMER_RULES;
}

function syncModeCards(mode) {
  document.querySelectorAll('.timer-mode-card').forEach(c => {
    c.classList.toggle('active', c.dataset.mode === mode);
  });
}

function renderMultiplierRules() {
  const container = document.getElementById('timerMultRulesContainer');
  const btnAdd = document.getElementById('btnAddTimerMultRule');
  if (!container) return;
  container.querySelectorAll('select[data-custom-select="true"]').forEach(sel => CustomDropdown.removeBySelect(sel));
  container.replaceChildren();
  const unit = document.getElementById('timerTimeUnit')?.value || 'seconds';
  timerRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'timer-rule-row';

    const lbl = makeEl('span', { style: 'color:var(--text-muted);font-size:12px;white-space:nowrap;' }, `กฏ${idx + 1}`);

    const baseInput = makeEl('input', { type: 'number', className: 'form-control', min: 0, step: 'any', placeholder: '10', style: 'width:70px;', title: 'ทุกๆ X หน่วย' });
    baseInput.value = rule.base_amount ?? rule.amount ?? '';
    baseInput.oninput = (e) => {
      const v = parseFloat(e.target.value) || 0;
      timerRules[idx].base_amount = v;
      timerRules[idx].amount = v; // sync มาโหมด threshold/fixed กัน user ต้องกรอกซ้ำ
      updateMultWarn();
    };

    const curSel = makeEl('select', { style: 'width:92px;' });
    [['thb', '฿ บาท'], ['coin', '🪙 เหรียญ']].forEach(([val, label]) => {
      const opt = makeEl('option', { value: val }, label);
      if ((rule.currency || 'thb') === val) opt.selected = true;
      curSel.appendChild(opt);
    });
    curSel.onchange = (e) => {
      if (e.target.value === 'coin' && !document.getElementById('tiktokEnableToggle')?.checked) {
        e.target.value = 'thb';
        e.target.dispatchEvent(new Event('change', { bubbles: true }));
        showNotification('เปิดใช้งาน TikTok Live ก่อน จึงจะตั้งกฏสกุลเหรียญได้', 'error');
        goToTiktokPanel();
        return;
      }
      timerRules[idx].currency = e.target.value;
      renderMultiplierRules();
    };

    const arrow = makeEl('span', { style: 'color:var(--text-muted);white-space:nowrap;' }, '→');

    const actionSel = buildRuleActionSelect(idx);
    const prevActionOnchange = actionSel.onchange;
    actionSel.onchange = (e) => { prevActionOnchange(e); updateMultWarn(); };

    const rawSecs = rule.time_seconds || 0;
    const timeInput = makeEl('input', { type: 'number', className: 'form-control', min: 0, step: 'any', placeholder: '60', style: 'width:70px;' });
    timeInput.value = unit === 'minutes' ? +(rawSecs / 60).toFixed(2) : rawSecs;
    timeInput.oninput = (e) => {
      const factor = document.getElementById('timerTimeUnit')?.value === 'minutes' ? 60 : 1;
      timerRules[idx].time_seconds = (parseFloat(e.target.value) || 0) * factor;
      updateMultWarn();
    };

    const unitLbl = makeEl('span', { style: 'color:var(--text-muted);white-space:nowrap;' }, unit === 'minutes' ? 'นาที' : 'วิ');

    const delBtn = makeEl('button', { type: 'button', className: 'btn btn-icon', title: 'ลบกฏ', style: 'color:#ef4444;padding:6px 10px;' });
    delBtn.appendChild(Object.assign(document.createElement('i'), { className: 'fa-solid fa-trash-can' }));
    delBtn.onclick = () => { timerRules.splice(idx, 1); renderMultiplierRules(); };

    [lbl, baseInput, curSel, arrow, actionSel, timeInput, unitLbl, delBtn].forEach(el => row.appendChild(el));
    container.appendChild(row);
    CustomDropdown.wrapEl(curSel);
    CustomDropdown.wrapEl(actionSel);
  });
  if (btnAdd) btnAdd.disabled = timerRules.length >= MAX_TIMER_RULES;
  updateMultWarn();
}

// เตือน real-time เมื่อมี ≥2 กฏ currency เดียวกัน (ไม่สนใจ action — server tier-pick ยึดกฏ base_amount
// สูงสุดที่ถึงเพียงกฏเดียวข้ามทุก action รวม choice ด้วย กฏฐานต่ำกว่าจะ "โดนกลืน" เสมอ) — เรียกตรงจาก
// oninput ไม่ต้อง re-render ทั้ง section
function updateMultWarn() {
  const warn = document.getElementById('timerMultWarn');
  const msgEl = document.getElementById('timerMultWarnMsg');
  if (!warn) return;

  const groups = {};
  timerRules.forEach(r => {
    if (!r.base_amount || r.base_amount <= 0) return;
    const key = r.currency || 'thb';
    (groups[key] = groups[key] || []).push(r);
  });

  const signPrefix = a => a === 'sub' ? '−' : a === 'choice' ? '±' : '+';
  let message = null;
  for (const key in groups) {
    const list = groups[key];
    if (list.length < 2) continue;
    const curLabel = key === 'coin' ? 'เหรียญ' : '฿';
    const sorted = [...list].sort((a, b) => b.base_amount - a.base_amount);
    const [top, second] = sorted;
    const fmtTime = s => s >= 60 ? `${+(s / 60).toFixed(2)} นาที` : `${s} วิ`;
    message = `ตั้งกฏ "ทุกๆ ${curLabel}" มากกว่า 1 กฏในสกุลเงินเดียวกัน (${sorted.map(r => r.base_amount).join(curLabel + ', ')}${curLabel}) — ระบบยึด "กฏยอดสูงสุดที่โดเนทถึง" เพียงกฏเดียว ไม่รวมกฏอื่นไม่ว่า action จะเป็นแบบไหน เช่น โดเนท ${top.base_amount + Math.round(second.base_amount / 2)}${curLabel} จะยึดกฏ ${top.base_amount}${curLabel} (${signPrefix(top.action)}${fmtTime(top.time_seconds)}) เท่านั้น ไม่นับกฏ ${second.base_amount}${curLabel} (${signPrefix(second.action)}${fmtTime(second.time_seconds)}) เพิ่ม`;
    break;
  }

  if (msgEl && message) msgEl.textContent = message;
  if (message) {
    warn.style.display = 'flex';
    requestAnimationFrame(() => { warn.style.opacity = '1'; warn.style.transform = 'translateY(0)'; });
  } else {
    warn.style.opacity = '0';
    warn.style.transform = 'translateY(-6px)';
    setTimeout(() => { if (warn.style.opacity === '0') warn.style.display = 'none'; }, 300);
  }
}

// B2: cap status + หลอด progress — shared ระหว่าง loadTimerSettings() กับ refreshCapStatus()
function renderTimerCapStatus(t, capCurrent) {
  const capStatusText = document.getElementById('timerCapStatusText');
  const capStatusRow = document.getElementById('timerCapStatusRow');
  if (!capStatusRow) return;
  if (!t.cap_type) { capStatusRow.style.display = 'none'; return; }
  capStatusRow.style.display = '';

  capCurrent = Number(capCurrent) || 0; // ค่าใน template เป็นตัวเลขเสมอ — กัน XSS ผ่าน innerHTML
  t = { ...t, cap_value: Number(t.cap_value) || 0 };
  let unitLabel, dispCurr, dispMax;
  if (t.cap_type === 'money') {
    unitLabel = ' ฿'; dispCurr = capCurrent || 0; dispMax = t.cap_value || 0;
  } else {
    const isMin = (t.time_unit || 'seconds') === 'minutes';
    unitLabel = isMin ? ' นาที' : ' วินาที';
    dispCurr = isMin ? Math.round((capCurrent || 0) / 60) : (capCurrent || 0);
    dispMax = isMin ? Math.round((t.cap_value || 0) / 60) : (t.cap_value || 0);
  }

  if (capStatusText) {
    const remaining = Math.max(0, dispMax - dispCurr);
    if (dispCurr >= dispMax && dispMax > 0) {
      capStatusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color:#fbbf24;"></i> <strong>ใช้ไป: ${dispCurr} / ${dispMax}${unitLabel}</strong> — ครบจำกัดแล้ว <span style="color:#fbbf24;font-weight:700;">ปิดปรับเวลาแบบอัตโนมัติ</span>`;
    } else {
      capStatusText.textContent = `ใช้ไป: ${dispCurr} / ${dispMax}${unitLabel} (เหลือ ${remaining}${unitLabel})`;
    }
  }

  const fill = document.getElementById('timerCapProgressFill');
  if (fill && dispMax > 0) {
    const pct = Math.min(100, Math.round((dispCurr / dispMax) * 100));
    fill.style.width = pct + '%';
    fill.style.backgroundColor = pct >= 100 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';
  }
}

async function refreshCapStatus() {
  try {
    const res = await fetch('/api/overlay/settings');
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    let t = {};
    try { t = JSON.parse(data.timer_settings || '{}'); } catch (e) {}
    renderTimerCapStatus(t, data.timer_cap_current || 0);
    showNotification('รีเฟรชสถานะข้อจำกัดแล้ว', 'success');
  } catch (err) {
    showNotification('รีเฟรชสถานะไม่สำเร็จ ลองใหม่อีกครั้ง', 'error');
  }
}

async function loadTimerSettings() {
  try {
    const [settingsRes, tokenRes] = await Promise.all([
      fetch('/api/overlay/settings'),
      fetch('/api/overlay/token')
    ]);
    if (!settingsRes.ok) return;
    const data = await settingsRes.json();
    let t = {};
    try { t = JSON.parse(data.timer_settings || '{}'); } catch (e) {}

    const chkEnabled = document.getElementById('chkTimerEnabled');
    if (chkEnabled) chkEnabled.checked = !!t.enabled;
    updateWidgetBodyVisibility('chkTimerEnabled');

    const initSecs = t.initial_seconds || 600;
    const hh = Math.floor(initSecs / 3600);
    const mm = Math.floor((initSecs % 3600) / 60);
    const ss = initSecs % 60;
    const hhEl = document.getElementById('timerInitHH');
    const mmEl = document.getElementById('timerInitMM');
    const ssEl = document.getElementById('timerInitSS');
    if (hhEl) hhEl.value = hh;
    if (mmEl) mmEl.value = mm;
    if (ssEl) ssEl.value = ss;

    const modeEl = document.getElementById('timerModeSelect');
    const mode = t.mode || 'multiplier';
    if (modeEl) {
      modeEl.value = mode;
      modeEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncModeCards(mode);

    const timeUnitEl = document.getElementById('timerTimeUnit');
    if (timeUnitEl) {
      timeUnitEl.value = t.time_unit || 'minutes';
      timeUnitEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    timerRules = Array.isArray(t.rules) ? JSON.parse(JSON.stringify(t.rules)) : [];
    timerRulesSetMode(mode);
    if (mode === 'multiplier') {
      if (timerRules.length === 0) timerRules = [{ base_amount: 10, time_seconds: 60, action: 'add' }];
      renderMultiplierRules();
    } else {
      renderTimerRules(mode);
    }

    const outlineColorEl = document.getElementById('inputTimerOutlineColor');
    const outlineTxtEl = document.getElementById('txtTimerOutlineColor');
    const outlineColor = t.outline_color || '#000000';
    if (outlineColorEl) outlineColorEl.value = outlineColor;
    if (outlineTxtEl) outlineTxtEl.value = outlineColor;

    const chkPass = document.getElementById('chkTimerAllowPassthrough');
    if (chkPass) chkPass.checked = t.allow_passthrough !== 0 && t.allow_passthrough !== false;

    const chkShowRules = document.getElementById('chkTimerShowRules');
    if (chkShowRules) chkShowRules.checked = t.show_rules !== false && t.show_rules !== 0;


    const tmplEl = document.getElementById('inputTimerRulesTemplate');
    if (tmplEl) tmplEl.value = t.rules_template || 'โดเนท {จำนวนเงิน}฿ {เครื่องหมาย}{เวลา}';

    const tmplCoinEl = document.getElementById('inputTimerRulesTemplateCoin');
    if (tmplCoinEl) tmplCoinEl.value = t.rules_template_coin || 'Gift {จำนวนเงิน} เหรียญ {เครื่องหมาย}{เวลา}';

    const capTypeEl = document.getElementById('timerCapTypeSelect');
    if (capTypeEl) {
      capTypeEl.value = t.cap_type || '';
      capTypeEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const capValEl = document.getElementById('inputTimerCapValue');
    if (capValEl) {
      if (t.cap_type === 'time') {
        const isMin = (t.time_unit || 'minutes') === 'minutes';
        capValEl.value = isMin ? Math.round((t.cap_value || 0) / 60) : (t.cap_value || '');
      } else {
        capValEl.value = t.cap_value || '';
      }
    }

    renderTimerCapStatus(t, data.timer_cap_current || 0);

    const colorMainEl = document.getElementById('inputTimerColorMain');
    const txtColorMain = document.getElementById('txtTimerColorMain');
    const color = t.color_main || '#fbbf24';
    if (colorMainEl) colorMainEl.value = color;
    if (txtColorMain) txtColorMain.value = color;

    const fontSizeEl = document.getElementById('sliderTimerFontSize');
    const fontSizeLbl = document.getElementById('lblTimerFontSize');
    if (fontSizeEl) { fontSizeEl.value = t.font_size || 64; if (fontSizeLbl) fontSizeLbl.textContent = fontSizeEl.value; }

    const borderRadEl = document.getElementById('sliderTimerBorderRadius');
    const borderRadLbl = document.getElementById('lblTimerBorderRadius');
    if (borderRadEl) { borderRadEl.value = t.border_radius ?? 2; if (borderRadLbl) borderRadLbl.textContent = borderRadEl.value; }

    const chkShine = document.getElementById('chkTimerShine');
    if (chkShine) chkShine.checked = t.shine_enabled !== false && t.shine_enabled !== 0;

    // P5-B: timeout effect (R5 migration fallback)
    const effectTypeEl = document.getElementById('timerTimeoutEffectType');
    if (effectTypeEl) {
      let effectType = t.timeout_effect_type;
      if (!effectType) effectType = (t.timeout_effect === false || t.timeout_effect === 0) ? 'none' : 'blink';
      effectTypeEl.value = effectType;
      effectTypeEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const emojiEl = document.getElementById('inputTimerEffectEmoji');
    if (emojiEl) emojiEl.value = t.timeout_effect_emoji || '🎉';

    // P5-A: sound panel
    const chkSoundEnabledEl = document.getElementById('chkTimerSoundEnabled');
    if (chkSoundEnabledEl) {
      chkSoundEnabledEl.checked = t.sound_enabled !== false && t.sound_enabled !== 0;
      chkSoundEnabledEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const soundChoiceEl = document.getElementById('timerSoundChoiceSelect');
    if (soundChoiceEl) {
      soundChoiceEl.value = t.sound_choice || t.sound_type || 'synthetic';
      soundChoiceEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const volEl = document.getElementById('sliderTimerSoundVolume');
    const volLbl = document.getElementById('lblTimerSoundVolume');
    if (volEl) {
      const vol = t.sound_volume ?? 0.7;
      volEl.value = vol;
      if (volLbl) volLbl.textContent = Math.round(vol * 100);
    }
    const timerUrlEl = document.getElementById('timerCustomSoundUrl');
    if (timerUrlEl) timerUrlEl.value = t.sound_url || '';
    if (t.sound_choice === 'upload' && t.sound_url) {
      const wrap = document.getElementById('timerUploadSoundCurrentWrap');
      const name = document.getElementById('timerUploadSoundCurrentName');
      if (wrap) wrap.style.display = 'flex';
      if (name) {
        const parts = t.sound_url.split('/');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-music';
        name.textContent = '';
        name.appendChild(icon);
        name.append(' ' + parts[parts.length - 1]);
      }
    }

    const chkTimerAnim = document.getElementById('chkTimerAnimEnabled');
    const chkTimerAnimSound = document.getElementById('chkTimerAnimSound');
    const timerVolSlider2 = document.getElementById('sliderTimerAnimVolume');
    const timerVolLbl2 = document.getElementById('lblTimerAnimVolume');
    const timerAnimVol2 = t.timer_anim_sound_volume !== undefined && t.timer_anim_sound_volume !== null ? t.timer_anim_sound_volume : 1;
    if (timerVolSlider2) timerVolSlider2.value = timerAnimVol2;
    if (timerVolLbl2) timerVolLbl2.textContent = Math.round(timerAnimVol2 * 100);
    if (chkTimerAnimSound) chkTimerAnimSound.checked = t.timer_anim_sound_enabled !== 0 && t.timer_anim_sound_enabled !== false;
    if (chkTimerAnim) {
      chkTimerAnim.checked = t.timer_anim_enabled !== 0 && t.timer_anim_enabled !== false;
      const syncAnimTestVis = () => {
        const soundGroup = document.getElementById('timerAnimSoundGroup');
        const volGroup = document.getElementById('timerAnimVolumeGroup');
        if (soundGroup) soundGroup.style.display = chkTimerAnim.checked ? '' : 'none';
        if (volGroup) volGroup.style.display = (chkTimerAnim.checked && chkTimerAnimSound && chkTimerAnimSound.checked) ? '' : 'none';
      };
      syncAnimTestVis();
      chkTimerAnim.addEventListener('change', syncAnimTestVis);
      if (chkTimerAnimSound) chkTimerAnimSound.addEventListener('change', syncAnimTestVis);
    }

    // TikTok card
    const tiktokToggle = document.getElementById('tiktokEnableToggle');
    if (tiktokToggle) tiktokToggle.checked = !!t.tiktokEnabled;
    syncTiktokCard();

    if (tokenRes.ok) {
      const { token } = await tokenRes.json();
      const timerUrl = `${location.origin}/timer?token=${token}`;
      const urlLeft = document.getElementById('obsTimerUrlPreview');
      const urlRight = document.getElementById('obsTimerUrlPreviewRight');
      if (urlLeft) urlLeft.value = timerUrl;
      if (urlRight) urlRight.value = timerUrl;
    }
  } catch (err) {
    console.error('Failed to load timer settings:', err);
  }
}

async function saveTimerSettings() {
  const mode = document.getElementById('timerModeSelect')?.value || 'multiplier';
  const hh = parseInt(document.getElementById('timerInitHH')?.value) || 0;
  const mm = parseInt(document.getElementById('timerInitMM')?.value) || 0;
  const ss = parseInt(document.getElementById('timerInitSS')?.value) || 0;
  const initialSeconds = hh * 3600 + mm * 60 + ss || 600;

  let rules;
  if (mode === 'multiplier') {
    rules = timerRules.map(r => ({
      base_amount: r.base_amount || r.amount || 10,
      time_seconds: r.time_seconds || 60,
      action: r.action || 'add',
      currency: r.currency || 'thb'
    }));
  } else {
    // amount/base_amount ซิงค์กันแค่ตอน oninput — กฏที่ยังไม่เคยแก้เลข (เพิ่งโหลด/เพิ่งสลับโหมด) อาจมีแค่ field เดียว
    rules = timerRules.map(r => ({ ...r, amount: r.amount ?? r.base_amount ?? 10 }));
  }

  const capType = document.getElementById('timerCapTypeSelect')?.value || null;
  const rawCapVal = parseFloat(document.getElementById('inputTimerCapValue')?.value) || 0;
  const capUnitForSave = document.getElementById('timerTimeUnit')?.value || 'seconds';
  const t = {
    enabled: document.getElementById('chkTimerEnabled')?.checked ? 1 : 0,
    mode,
    rules,
    initial_seconds: initialSeconds,
    time_unit: document.getElementById('timerTimeUnit')?.value || 'seconds',
    allow_passthrough: document.getElementById('chkTimerAllowPassthrough')?.checked ? 1 : 0,
    show_rules: document.getElementById('chkTimerShowRules')?.checked ? 1 : 0,
    rules_template: document.getElementById('inputTimerRulesTemplate')?.value || 'โดเนท {จำนวนเงิน}฿ {เครื่องหมาย}{เวลา}',
    rules_template_coin: document.getElementById('inputTimerRulesTemplateCoin')?.value || 'Gift {จำนวนเงิน} เหรียญ {เครื่องหมาย}{เวลา}',
    cap_type: capType || null,
    cap_value: capType === 'time' && capUnitForSave === 'minutes' ? rawCapVal * 60 : rawCapVal,
    color_main: document.getElementById('inputTimerColorMain')?.value || '#fbbf24',
    font_size: parseInt(document.getElementById('sliderTimerFontSize')?.value) || 64,
    border_radius: parseInt(document.getElementById('sliderTimerBorderRadius')?.value) ?? 2,
    outline_color: document.getElementById('inputTimerOutlineColor')?.value || '#000000',
    shine_enabled: document.getElementById('chkTimerShine')?.checked ? 1 : 0,
    timeout_effect_type: document.getElementById('timerTimeoutEffectType')?.value || 'blink',
    timeout_effect_emoji: document.getElementById('inputTimerEffectEmoji')?.value || '🎉',
    sound_enabled: document.getElementById('chkTimerSoundEnabled')?.checked ? 1 : 0,
    sound_choice: document.getElementById('timerSoundChoiceSelect')?.value || 'synthetic',
    sound_url: document.getElementById('timerCustomSoundUrl')?.value || '',
    sound_volume: (() => { const v = parseFloat(document.getElementById('sliderTimerSoundVolume')?.value); return isNaN(v) ? 0.7 : v; })(),
    timer_anim_enabled: document.getElementById('chkTimerAnimEnabled')?.checked ? 1 : 0,
    timer_anim_sound_enabled: document.getElementById('chkTimerAnimSound')?.checked ? 1 : 0,
    timer_anim_sound_volume: (() => { const v = parseFloat(document.getElementById('sliderTimerAnimVolume')?.value); return isNaN(v) ? 1 : v; })(),
    tiktokEnabled: document.getElementById('tiktokEnableToggle')?.checked ? 1 : 0,
  };

  try {
    const res = await fetchWithCsrf('/api/overlay/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timer_settings: JSON.stringify(t) })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('บันทึกการตั้งค่า Timer แล้ว', 'success');
      await loadTimerSettings();
    } else {
      showNotification(data.error || 'ไม่สามารถบันทึกได้', 'error');
    }
  } catch (err) {
    showNotification('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
  }
}

async function timerControl(action, delta = 0) {
  try {
    const body = { action };
    if (delta > 0) body.delta = delta;
    const res = await fetchWithCsrf('/api/timer/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.success) {
      const label = action === 'add' ? `+${delta} วิ` : action === 'sub' ? `-${delta} วิ` : action;
      showNotification(`Timer ${label} สำเร็จ`, 'success');
    } else {
      showNotification(data.error || 'เกิดข้อผิดพลาด', 'error');
    }
  } catch (err) {
    showNotification('เชื่อมต่อไม่ได้ กรุณาลองใหม่', 'error');
  }
}

function initTimerSettingsUI() {
  // Mode switch
  const modeEl = document.getElementById('timerModeSelect');
  if (modeEl) {
    modeEl.addEventListener('change', () => {
      timerRulesSetMode(modeEl.value);
      if (modeEl.value === 'multiplier') renderMultiplierRules();
      else renderTimerRules(modeEl.value);
    });
  }

  // Mode cards click
  document.querySelectorAll('.timer-mode-card').forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      syncModeCards(mode);
      if (modeEl) {
        modeEl.value = mode;
        modeEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });

  // Time unit change → re-render active section
  const timeUnitEl = document.getElementById('timerTimeUnit');
  if (timeUnitEl) {
    timeUnitEl.addEventListener('change', () => {
      const mode = document.getElementById('timerModeSelect')?.value || 'multiplier';
      if (mode === 'multiplier') renderMultiplierRules();
      else renderTimerRules(mode);
      syncCapUnit();
      const unitLabel = document.getElementById('timerTestDeltaUnit');
      if (unitLabel) unitLabel.textContent = timeUnitEl.value === 'minutes' ? 'นาที' : 'วินาที';
    });
  }

  // Add rule button (threshold/fixed)
  const btnAdd = document.getElementById('btnAddTimerRule');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      const mode = document.getElementById('timerModeSelect')?.value || 'threshold';
      timerRules.push({ amount: 0, time_seconds: 60, action: 'add' });
      renderTimerRules(mode);
    });
  }

  // Add multiplier rule button
  const btnAddMult = document.getElementById('btnAddTimerMultRule');
  if (btnAddMult) {
    btnAddMult.addEventListener('click', () => {
      if (timerRules.length >= MAX_TIMER_RULES) return;
      timerRules.push({ base_amount: 10, time_seconds: 60, action: 'add' });
      renderMultiplierRules();
    });
  }

  // Outline color sync + toggle row
  const outlinePicker = document.getElementById('inputTimerOutlineColor');
  const outlineTxt = document.getElementById('txtTimerOutlineColor');
  if (outlinePicker && outlineTxt) {
    outlinePicker.oninput = (e) => { outlineTxt.value = e.target.value; };
    outlineTxt.oninput = (e) => {
      if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) outlinePicker.value = e.target.value;
    };
  }
  // chkTimerShine controls shine animation (in timer.js applySettings); outline row always visible

  // Show rules toggle → template row visibility
  const chkShowRules = document.getElementById('chkTimerShowRules');
  const tmplRow = document.getElementById('timerRulesTemplateRow');
  if (chkShowRules && tmplRow) {
    const syncTmplRow = () => { tmplRow.style.display = chkShowRules.checked ? '' : 'none'; };
    chkShowRules.addEventListener('change', syncTmplRow);
    syncTmplRow();
  }

  // Cap type toggle
  function syncCapUnit() {
    const capType = document.getElementById('timerCapTypeSelect')?.value;
    const unit = document.getElementById('timerTimeUnit')?.value || 'seconds';
    const lbl = document.getElementById('lblTimerCapUnit');
    if (lbl) lbl.textContent = capType === 'time' ? (unit === 'minutes' ? '(นาที)' : '(วินาที)') : '';
  }

  const capTypeEl = document.getElementById('timerCapTypeSelect');
  if (capTypeEl) {
    capTypeEl.addEventListener('change', () => {
      const hasCap = !!capTypeEl.value;
      const capValGroup = document.getElementById('timerCapValueGroup');
      const capStatusRow = document.getElementById('timerCapStatusRow');
      if (capValGroup) capValGroup.style.display = hasCap ? '' : 'none';
      if (capStatusRow) capStatusRow.style.display = hasCap ? '' : 'none';
      syncCapUnit();
    });
  }

  // P5-A: sound enabled toggle
  const chkTimerSound = document.getElementById('chkTimerSoundEnabled');
  if (chkTimerSound) {
    chkTimerSound.addEventListener('change', () => {
      const row = document.getElementById('timerSoundSettingsRow');
      if (row) row.style.display = chkTimerSound.checked ? '' : 'none';
    });
  }

  // P5-A: sound choice toggle — url=URL input only, upload=upload section only
  const soundChoiceEl = document.getElementById('timerSoundChoiceSelect');
  if (soundChoiceEl) {
    soundChoiceEl.addEventListener('change', () => {
      const v = soundChoiceEl.value;
      const urlCont = document.getElementById('timerCustomSoundUrlContainer');
      const uploadCont = document.getElementById('timerUploadSoundContainer');
      if (urlCont) urlCont.style.display = v === 'url' ? '' : 'none';
      if (uploadCont) uploadCont.style.display = v === 'upload' ? '' : 'none';
    });
  }
  const btnBrowseTimer = document.getElementById('btnBrowseTimerSounds');
  if (btnBrowseTimer) btnBrowseTimer.addEventListener('click', () => openSoundBrowser('timerCustomSoundUrl'));
  const timerUploadFile = document.getElementById('timerUploadSoundFile');
  if (timerUploadFile) timerUploadFile.addEventListener('change', handleTimerAudioFileSelect);
  const btnClearTimerSound = document.getElementById('btnClearTimerUploadSound');
  if (btnClearTimerSound) btnClearTimerSound.addEventListener('click', clearTimerUploadSound);
  const volSlider = document.getElementById('sliderTimerSoundVolume');
  if (volSlider) volSlider.addEventListener('input', () => {
    const lbl = document.getElementById('lblTimerSoundVolume');
    if (lbl) lbl.textContent = Math.round(parseFloat(volSlider.value) * 100);
  });

  // P5-B: timeout effect type toggle + test button
  const effectTypeEl = document.getElementById('timerTimeoutEffectType');
  if (effectTypeEl) {
    effectTypeEl.addEventListener('change', () => {
      const emojiRow = document.getElementById('timerEffectEmojiRow');
      if (emojiRow) emojiRow.style.display = effectTypeEl.value === 'emoji' ? '' : 'none';
    });
  }
  const btnTestEffect = document.getElementById('btnTestTimerEffect');
  if (btnTestEffect) {
    btnTestEffect.addEventListener('click', () => {
      const iframe = document.getElementById('timerPreviewIframe');
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage({
        type: 'test_effect',
        effect: document.getElementById('timerTimeoutEffectType')?.value || 'blink',
        emoji: document.getElementById('inputTimerEffectEmoji')?.value || '🎉'
      }, location.origin);
    });
  }

  const btnTestAnimAdd = document.getElementById('btnTestTimerAnimAdd');
  const btnTestAnimSub = document.getElementById('btnTestTimerAnimSub');
  function sendTestTimerAnim(sign) {
    const input = document.getElementById('inputTestTimerDelta');
    let raw = parseInt(input?.value) || 30;
    if (raw < 1) { raw = 1; input.value = 1; }
    const timeUnit = document.getElementById('timerTimeUnit')?.value || 'seconds';
    const deltaSeconds = timeUnit === 'minutes' ? raw * 60 : raw;

    if (timerLiveMode) {
      // Live mode: send to server → broadcast to real overlay
      const action = sign > 0 ? 'add' : 'sub';
      timerControl(action, deltaSeconds);
    } else {
      // Test mode: postMessage to preview iframe (delta always in seconds)
      const iframe = document.getElementById('timerPreviewIframe');
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage({
        type: 'test_delta_anim',
        delta: deltaSeconds * sign,
        timeUnit,
        source: 'preview'
      }, location.origin);
    }
  }
  if (btnTestAnimAdd) btnTestAnimAdd.addEventListener('click', () => sendTestTimerAnim(1));
  if (btnTestAnimSub) btnTestAnimSub.addEventListener('click', () => sendTestTimerAnim(-1));
  const inputTestDelta = document.getElementById('inputTestTimerDelta');
  if (inputTestDelta) {
    inputTestDelta.addEventListener('change', () => {
      let v = parseInt(inputTestDelta.value) || 30;
      if (v < 1) inputTestDelta.value = 1;
    });
  }

  // Color sync
  const colorPicker = document.getElementById('inputTimerColorMain');
  const colorTxt = document.getElementById('txtTimerColorMain');
  if (colorPicker && colorTxt) {
    colorPicker.oninput = (e) => { colorTxt.value = e.target.value; };
    colorTxt.oninput = (e) => {
      if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) colorPicker.value = e.target.value;
    };
  }

  // Sliders
  const fontSizeEl = document.getElementById('sliderTimerFontSize');
  if (fontSizeEl) fontSizeEl.oninput = (e) => {
    const lbl = document.getElementById('lblTimerFontSize');
    if (lbl) lbl.textContent = e.target.value;
  };
  const borderEl = document.getElementById('sliderTimerBorderRadius');
  if (borderEl) borderEl.oninput = (e) => {
    const lbl = document.getElementById('lblTimerBorderRadius');
    if (lbl) lbl.textContent = e.target.value;
  };

  // ── Timer Test/Live mode toggle ──
  let timerLiveMode = false;
  const chkLive = document.getElementById('chkTimerLiveMode');
  const lblTest = document.getElementById('lblTimerModeTest');
  const lblLive = document.getElementById('lblTimerModeLive');
  const modeBadge = document.getElementById('timerModeBadge');
  const modeHint = document.getElementById('timerModeHint');

  function updateTimerModeUI() {
    if (timerLiveMode) {
      if (lblTest) { lblTest.style.color = 'var(--text-muted)'; lblTest.style.fontWeight = '400'; }
      if (lblLive) { lblLive.style.color = '#ef4444'; lblLive.style.fontWeight = '700'; }
      if (modeBadge) { modeBadge.textContent = 'Live — ควบคุมบนจอจริง'; modeBadge.style.background = 'rgba(239,68,68,0.15)'; modeBadge.style.color = '#ef4444'; }
      if (modeHint) { modeHint.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> กำลังควบคุม Timer บนหน้าจอไลฟ์สดจริง — การเปลี่ยนแปลงมีผลทันทีต่อผู้ชม'; }
    } else {
      if (lblTest) { lblTest.style.color = '#3b82f6'; lblTest.style.fontWeight = '700'; }
      if (lblLive) { lblLive.style.color = 'var(--text-muted)'; lblLive.style.fontWeight = '400'; }
      if (modeBadge) { modeBadge.textContent = 'ตัวอย่างในหน้านี้เท่านั้น'; modeBadge.style.background = 'rgba(59,130,246,0.15)'; modeBadge.style.color = '#3b82f6'; }
      if (modeHint) { modeHint.innerHTML = '<i class="fa-solid fa-circle-info" style="color:#60a5fa;"></i> สำหรับดูตัวอย่างในหน้านี้เท่านั้น'; }
    }
  }

  if (chkLive) {
    chkLive.addEventListener('change', () => {
      timerLiveMode = chkLive.checked;
      updateTimerModeUI();
    });
  }

  // Helper: send timer command to preview iframe
  function timerPostMessage(type, data = {}) {
    const iframe = document.getElementById('timerPreviewIframe');
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type, ...data, source: 'preview' }, location.origin);
    }
  }

  // Control buttons
  const btnStart = document.getElementById('btnTimerStart');
  const btnStop  = document.getElementById('btnTimerStop');
  const btnReset = document.getElementById('btnTimerReset');
  const btnResetCap = document.getElementById('btnTimerResetCap');
  if (btnStart) btnStart.addEventListener('click', () => timerControl('start'));
  if (btnStop)  btnStop.addEventListener('click',  () => timerControl('stop'));
  if (btnReset) btnReset.addEventListener('click', () => timerControl('reset'));
  if (btnResetCap) btnResetCap.addEventListener('click', () => timerControl('reset-cap'));
  const btnRefreshCap = document.getElementById('btnRefreshCapStatus');
  if (btnRefreshCap) btnRefreshCap.addEventListener('click', refreshCapStatus);

  // Post-click pulse — delegate ครอบทั้ง 2 กลุ่มปุ่ม (control + test)
  document.querySelectorAll('.timer-control-buttons .btn, .btn-test-add, .btn-test-sub')
    .forEach(btn => btn.addEventListener('click', () => {
      btn.classList.remove('timer-btn-pulse');
      void btn.offsetWidth;                 // reflow → เล่นซ้ำได้ทุกคลิก
      btn.classList.add('timer-btn-pulse');
    }));

  // Save button
  const btnSave = document.getElementById('btnSaveTimerSettings');
  if (btnSave) btnSave.addEventListener('click', saveTimerSettings);

  // [UI Fix] เปิด/ปิดวิดเจ็ต = บันทึกอัตโนมัติ ไม่ต้องกดปุ่มบันทึกแยก
  const chkTimerEnabledAuto = document.getElementById('chkTimerEnabled');
  if (chkTimerEnabledAuto) chkTimerEnabledAuto.addEventListener('change', saveTimerSettings);

  // Copy URL buttons
  function copyUrl(inputId, btn) {
    const el = document.getElementById(inputId);
    if (!el || !el.value) return;
    navigator.clipboard.writeText(el.value).then(() => {
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = 'คัดลอกแล้ว!';
      btn.style.background = 'var(--success)';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '';
      }, 1500);
    }).catch(() => {});
  }
  const btnCopyLeft = document.getElementById('btnCopyObsTimerUrl');
  const btnCopyRight = document.getElementById('btnCopyObsTimerUrlRight');
  const btnOpenLeft = document.getElementById('btnOpenObsTimerUrl');
  const btnOpenRight = document.getElementById('btnOpenObsTimerUrlRight');
  if (btnCopyLeft) btnCopyLeft.addEventListener('click', () => copyUrl('obsTimerUrlPreview', btnCopyLeft));
  if (btnCopyRight) btnCopyRight.addEventListener('click', () => copyUrl('obsTimerUrlPreviewRight', btnCopyRight));
  if (btnOpenLeft) btnOpenLeft.addEventListener('click', () => {
    const url = document.getElementById('obsTimerUrlPreview')?.value;
    if (url) window.open(url, '_blank');
  });
  if (btnOpenRight) btnOpenRight.addEventListener('click', () => {
    const url = document.getElementById('obsTimerUrlPreviewRight')?.value;
    if (url) window.open(url, '_blank');
  });

  // Timer Dock (OBS Custom Browser Dock)
  function timerDockUrl() {
    const u = window.location.pathname.split('/')[1];
    return u ? `${location.origin}/${u}/timer-dock` : '';
  }
  const btnCopyDock = document.getElementById('btnCopyTimerDockUrl');
  const btnOpenDock = document.getElementById('btnOpenTimerDockUrl');
  if (btnCopyDock) btnCopyDock.addEventListener('click', () => {
    const url = timerDockUrl();
    if (!url) return;
    navigator.clipboard.writeText(url)
      .then(() => showNotification('คัดลอกลิงก์ Dock ควบคุม Timer แล้ว!', 'success'))
      .catch(() => showNotification('ไม่สามารถคัดลอกลิงก์ได้', 'error'));
  });
  if (btnOpenDock) btnOpenDock.addEventListener('click', () => {
    const url = timerDockUrl();
    if (!url) return;
    const w = 420, h = 340;
    const left = Math.max(0, (window.screen.width - w) / 2);
    const top = Math.max(0, (window.screen.height - h) / 2);
    window.open(url, 'TipKubTimerDock',
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no,status=no,toolbar=no,menubar=no,location=no`);
  });

  const btnReloadTimer = document.getElementById('btnReloadTimerPreview');
  if (btnReloadTimer) btnReloadTimer.addEventListener('click', () => {
    btnReloadTimer.classList.add('spinning');
    const iframe = document.getElementById('timerPreviewIframe');
    if (iframe) { const s = iframe.src; iframe.src = 'about:blank'; iframe.src = s; }
    setTimeout(() => btnReloadTimer.classList.remove('spinning'), 1200);
  });
}

// ========== Leader Board settings (load/save) ==========
// Req #4 (animation) — .tk-collapse driven by tk-open class (CSS handles the grid 0fr→1fr transition)
function toggleGroup(groupId, show) {
  const el = document.getElementById(groupId);
  if (el) el.classList.toggle('tk-open', show);
}

async function loadLeaderboardSettings() {
  try {
    const [settingsRes, tokenRes] = await Promise.all([
      fetch('/api/overlay/settings'),
      fetch('/api/overlay/token')
    ]);
    if (!settingsRes.ok) return;
    const data = await settingsRes.json();
    let c = {};
    try { c = JSON.parse(data.leaderboard_settings || '{}'); } catch (e) {}

    const chkEnabled = document.getElementById('chkLeaderboardEnabled');
    if (chkEnabled) chkEnabled.checked = !!c.enabled;
    updateWidgetBodyVisibility('chkLeaderboardEnabled');

    const maxEl = document.getElementById('selectLeaderboardMaxEntries');
    if (maxEl) { maxEl.value = c.max_entries || 5; maxEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const chkShine = document.getElementById('chkLeaderboardShine');
    if (chkShine) chkShine.checked = c.shine_enabled !== false && c.shine_enabled !== 0;
    const chkAnim = document.getElementById('chkLeaderboardAnimation');
    if (chkAnim) chkAnim.checked = c.animation_enabled !== false && c.animation_enabled !== 0;
    const chkShowMedal = document.getElementById('chkLeaderboardShowMedal');
    if (chkShowMedal) chkShowMedal.checked = c.show_medal !== false && c.show_medal !== 0;

    const periodMode = c.period_mode || 'all';
    const periodEl = document.getElementById('selectLeaderboardPeriodMode');
    if (periodEl) { periodEl.value = periodMode; periodEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const periodDaysEl = document.getElementById('inputLeaderboardPeriodCustomDays');
    if (periodDaysEl) periodDaysEl.value = c.period_custom_days || 30;
    toggleGroup('leaderboardPeriodCustomGroup', periodMode === 'custom');

    const widthEl = document.getElementById('inputLeaderboardWidth');
    const widthTxt = document.getElementById('txtLeaderboardWidth');
    const autoWidthEl = document.getElementById('chkLeaderboardWidthAuto');
    const savedWidth = parseInt(c.width, 10);
    const widthAuto = !Number.isFinite(savedWidth) || savedWidth < 300 || savedWidth > 1920;
    const width = widthAuto ? 900 : savedWidth;
    if (autoWidthEl) { autoWidthEl.checked = widthAuto; autoWidthEl.dispatchEvent(new Event('change', { bubbles: true })); }
    if (widthEl) {
      widthEl.value = width;
      widthEl.disabled = widthAuto;
      widthEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (widthTxt) {
      widthTxt.textContent = widthAuto ? 'Auto' : width + 'px';
      widthTxt.style.opacity = widthAuto ? '0.6' : '';
    }

    const bgOn = c.bg_enabled !== false && c.bg_enabled !== 0;
    const chkBg = document.getElementById('chkLeaderboardBgEnabled');
    if (chkBg) chkBg.checked = bgOn;
    const bgColorEl = document.getElementById('inputLeaderboardBgColor');
    const bgColorTxt = document.getElementById('txtLeaderboardBgColor');
    if (bgColorEl) bgColorEl.value = c.bg_color || '#000000';
    if (bgColorTxt) bgColorTxt.value = c.bg_color || '#000000';
    const bgOpacityEl = document.getElementById('selectLeaderboardBgOpacity');
    if (bgOpacityEl) { bgOpacityEl.value = c.bg_opacity ?? 60; bgOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
    toggleGroup('leaderboardBgGroup', bgOn);

    const borderOn = c.border_enabled !== false && c.border_enabled !== 0;
    const chkBorder = document.getElementById('chkLeaderboardBorderEnabled');
    if (chkBorder) chkBorder.checked = borderOn;
    const borderColorEl = document.getElementById('inputLeaderboardBorderColor');
    const borderColorTxt = document.getElementById('txtLeaderboardBorderColor');
    if (borderColorEl) borderColorEl.value = c.border_color || '#a855f7';
    if (borderColorTxt) borderColorTxt.value = c.border_color || '#a855f7';
    const borderOpacityEl = document.getElementById('selectLeaderboardBorderOpacity');
    if (borderOpacityEl) { borderOpacityEl.value = c.border_opacity ?? 100; borderOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
    toggleGroup('leaderboardBorderGroup', borderOn);

    // เปิดสีพื้นหลังชื่อ
    const rowBgOn = c.row_bg_enabled !== false && c.row_bg_enabled !== 0;
    const chkRowBg = document.getElementById('chkLeaderboardRowBgEnabled');
    if (chkRowBg) chkRowBg.checked = rowBgOn;
    const rowBgColorEl = document.getElementById('inputLeaderboardRowBgColor');
    const rowBgColorTxt = document.getElementById('txtLeaderboardRowBgColor');
    if (rowBgColorEl) rowBgColorEl.value = c.row_bg_color || '#ffffff';
    if (rowBgColorTxt) rowBgColorTxt.value = c.row_bg_color || '#ffffff';
    const rowBgOpacityEl = document.getElementById('selectLeaderboardRowBgOpacity');
    if (rowBgOpacityEl) { rowBgOpacityEl.value = c.row_bg_opacity ?? 6; rowBgOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
    toggleGroup('leaderboardRowBgGroup', rowBgOn);

    // เปิดกรอบชื่อ (แยกจากกรอบ #lbWrapper ด้านบน)
    const rowBorderOn = c.row_border_enabled !== false && c.row_border_enabled !== 0;
    const chkRowBorder = document.getElementById('chkLeaderboardRowBorderEnabled');
    if (chkRowBorder) chkRowBorder.checked = rowBorderOn;
    const rowBorderColorEl = document.getElementById('inputLeaderboardRowBorderColor');
    const rowBorderColorTxt = document.getElementById('txtLeaderboardRowBorderColor');
    if (rowBorderColorEl) rowBorderColorEl.value = c.row_border_color || '#ffffff';
    if (rowBorderColorTxt) rowBorderColorTxt.value = c.row_border_color || '#ffffff';
    toggleGroup('leaderboardRowBorderGroup', rowBorderOn);

    const titleEl = document.getElementById('inputLeaderboardTitle');
    if (titleEl) titleEl.value = c.title || '🏆 อันดับผู้โดเนท';

    const fsTitleEl = document.getElementById('selectLeaderboardFontSizeTitle');
    if (fsTitleEl) { fsTitleEl.value = c.font_size_title || 22; fsTitleEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const fsRowEl = document.getElementById('selectLeaderboardFontSizeRow');
    if (fsRowEl) { fsRowEl.value = c.font_size_row || 18; fsRowEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const fsMedalEl = document.getElementById('selectLeaderboardFontSizeMedal');
    if (fsMedalEl) { fsMedalEl.value = c.font_size_medal || 20; fsMedalEl.dispatchEvent(new Event('change', { bubbles: true })); }

    const outlineWEl = document.getElementById('selectLeaderboardOutlineWidth');
    if (outlineWEl) { outlineWEl.value = c.outline_width || 0; outlineWEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const outlineColorEl = document.getElementById('inputLeaderboardOutlineColor');
    const outlineColorTxt = document.getElementById('txtLeaderboardOutlineColor');
    if (outlineColorEl) outlineColorEl.value = c.outline_color || '#000000';
    if (outlineColorTxt) outlineColorTxt.value = c.outline_color || '#000000';

    const colorFields = [
      ['inputLeaderboardColorText', 'txtLeaderboardColorText', c.color_text, '#ffffff'],
      ['inputLeaderboardColorRank', 'txtLeaderboardColorRank', c.color_rank, '#ffd700'],
      ['inputLeaderboardColorDonor', 'txtLeaderboardColorDonor', c.color_donor, '#ffffff'],
      ['inputLeaderboardColorAmount', 'txtLeaderboardColorAmount', c.color_amount, '#4ade80'],
      ['inputLeaderboardColorCurrency', 'txtLeaderboardColorCurrency', c.color_currency, '#f59e0b'],
      ['inputLeaderboardColorCount', 'txtLeaderboardColorCount', c.color_count, '#94a3b8']
    ];
    colorFields.forEach(([pickId, txtId, val, fallback]) => {
      const p = document.getElementById(pickId);
      const t = document.getElementById(txtId);
      if (p) p.value = val || fallback;
      if (t) t.value = val || fallback;
    });

    const tplLeftEl = document.getElementById('inputLeaderboardTplLeft');
    if (tplLeftEl) tplLeftEl.value = c.row_template_left || '#{อันดับ}  {ผู้โดเนท} ';
    const tplRightEl = document.getElementById('inputLeaderboardTplRight');
    if (tplRightEl) tplRightEl.value = c.row_template_right || '{จำนวนเงิน} {สกุลเงิน}';

    if (tokenRes.ok) {
      const { token } = await tokenRes.json();
      const url = `${location.origin}/leader-board?token=${token}`;
      const urlEl = document.getElementById('obsLeaderboardUrlPreview');
      if (urlEl) urlEl.value = url;
    }
  } catch (err) {
    console.error('Failed to load leaderboard settings:', err);
  }
}

// parseInt(...) || fallback ผิดเมื่อค่าจริงคือ 0 (0 เป็น falsy → หลุดไป fallback เสมอ) — ความโปร่งใส 0% เคยเด้งกลับ default เพราะบั๊กนี้
function intOrDefault(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}

async function saveLeaderboardSettings() {
  const widthAuto = document.getElementById('chkLeaderboardWidthAuto')?.checked;
  const c = {
    enabled: document.getElementById('chkLeaderboardEnabled')?.checked ? 1 : 0,
    max_entries: parseInt(document.getElementById('selectLeaderboardMaxEntries')?.value) || 5,
    shine_enabled: document.getElementById('chkLeaderboardShine')?.checked ? 1 : 0,
    animation_enabled: document.getElementById('chkLeaderboardAnimation')?.checked ? 1 : 0,
    show_medal: document.getElementById('chkLeaderboardShowMedal')?.checked ? 1 : 0,
    period_mode: document.getElementById('selectLeaderboardPeriodMode')?.value || 'all',
    period_custom_days: parseInt(document.getElementById('inputLeaderboardPeriodCustomDays')?.value) || 30,
    bg_enabled: document.getElementById('chkLeaderboardBgEnabled')?.checked ? 1 : 0,
    bg_color: document.getElementById('inputLeaderboardBgColor')?.value || '#000000',
    bg_opacity: intOrDefault(document.getElementById('selectLeaderboardBgOpacity')?.value, 60),
    border_enabled: document.getElementById('chkLeaderboardBorderEnabled')?.checked ? 1 : 0,
    border_color: document.getElementById('inputLeaderboardBorderColor')?.value || '#a855f7',
    border_opacity: intOrDefault(document.getElementById('selectLeaderboardBorderOpacity')?.value, 100),
    row_bg_enabled: document.getElementById('chkLeaderboardRowBgEnabled')?.checked ? 1 : 0,
    row_bg_color: document.getElementById('inputLeaderboardRowBgColor')?.value || '#ffffff',
    row_bg_opacity: intOrDefault(document.getElementById('selectLeaderboardRowBgOpacity')?.value, 6),
    row_border_enabled: document.getElementById('chkLeaderboardRowBorderEnabled')?.checked ? 1 : 0,
    row_border_color: document.getElementById('inputLeaderboardRowBorderColor')?.value || '#ffffff',
    title: document.getElementById('inputLeaderboardTitle')?.value || '🏆 อันดับผู้โดเนท',
    font_size_title: parseInt(document.getElementById('selectLeaderboardFontSizeTitle')?.value) || 22,
    font_size_row: parseInt(document.getElementById('selectLeaderboardFontSizeRow')?.value) || 18,
    font_size_medal: parseInt(document.getElementById('selectLeaderboardFontSizeMedal')?.value) || 20,
    outline_width: parseInt(document.getElementById('selectLeaderboardOutlineWidth')?.value) || 0,
    outline_color: document.getElementById('inputLeaderboardOutlineColor')?.value || '#000000',
    color_text: document.getElementById('inputLeaderboardColorText')?.value || '#ffffff',
    color_rank: document.getElementById('inputLeaderboardColorRank')?.value || '#ffd700',
    color_donor: document.getElementById('inputLeaderboardColorDonor')?.value || '#ffffff',
    color_amount: document.getElementById('inputLeaderboardColorAmount')?.value || '#4ade80',
    color_currency: document.getElementById('inputLeaderboardColorCurrency')?.value || '#f59e0b',
    color_count: document.getElementById('inputLeaderboardColorCount')?.value || '#94a3b8',
    row_template_left: document.getElementById('inputLeaderboardTplLeft')?.value || '#{อันดับ}  {ผู้โดเนท} ',
    row_template_right: document.getElementById('inputLeaderboardTplRight')?.value || '{จำนวนเงิน} {สกุลเงิน}'
  };
  if (!widthAuto) {
    c.width = parseInt(document.getElementById('inputLeaderboardWidth')?.value) || 900;
  }
  try {
    const res = await fetchWithCsrf('/api/overlay/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaderboard_settings: JSON.stringify(c) })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('บันทึกการตั้งค่าอันดับผู้โดเนทแล้ว', 'success');
      await loadLeaderboardSettings();
    } else {
      showNotification(data.error || 'ไม่สามารถบันทึกได้', 'error');
    }
  } catch (err) {
    showNotification('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
  }
}

// ========== Leader Board Test Animation (Req #5) ==========
async function triggerLeaderboardTest() {
  const names = ['สมศักดิ์ รักเรียน', 'แม่ค้าออนไลน์สายลุย', 'น้องเป็ดก้าบๆ 🐤', 'สุดหล่อคีย์บอร์ดเรืองแสง',
    'SuraGaming 🎮', 'นินจานักพัฒนา', 'ผู้สนับสนุนลึกลับ', 'สายฟ้า ไวเปอร์', 'คุณนายตื่นสาย',
    'กุ๊กไก่ ขายไข่', 'ลุงวิศวะ ซ่อมได้ทุกอย่าง', 'ป้าหนึ่ง ขายดี'];
  const amounts = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
  const donor = names[Math.floor(Math.random() * names.length)];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  const btn = document.getElementById('btnTestLeaderboard');
  if (btn) { btn.disabled = true; btn.querySelector('i').className = 'fa-solid fa-spinner fa-spin'; }
  try {
    const res = await fetchWithCsrf('/api/widget/leaderboard/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ donor, amount })
    });
    if (res.ok) {
      showNotification('ส่ง Leader Board ทดสอบแล้ว!', 'success');
    } else if (res.status === 429) {
      showNotification('ส่งทดสอบบ่อยเกินไป กรุณารอสักครู่', 'error');
    } else {
      showNotification('ส่งทดสอบไม่สำเร็จ', 'error');
    }
  } catch (err) {
    showNotification('ส่งทดสอบไม่สำเร็จ', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('i').className = 'fa-solid fa-shuffle'; }
  }
}

function initLeaderboardSettingsUI() {
  const colorGroups = [
    ['inputLeaderboardBgColor', 'txtLeaderboardBgColor'],
    ['inputLeaderboardBorderColor', 'txtLeaderboardBorderColor'],
    ['inputLeaderboardRowBgColor', 'txtLeaderboardRowBgColor'],
    ['inputLeaderboardRowBorderColor', 'txtLeaderboardRowBorderColor'],
    ['inputLeaderboardOutlineColor', 'txtLeaderboardOutlineColor'],
    ['inputLeaderboardColorText', 'txtLeaderboardColorText'],
    ['inputLeaderboardColorRank', 'txtLeaderboardColorRank'],
    ['inputLeaderboardColorDonor', 'txtLeaderboardColorDonor'],
    ['inputLeaderboardColorAmount', 'txtLeaderboardColorAmount'],
    ['inputLeaderboardColorCurrency', 'txtLeaderboardColorCurrency'],
    ['inputLeaderboardColorCount', 'txtLeaderboardColorCount']
  ];
  colorGroups.forEach(([pickId, txtId]) => {
    const p = document.getElementById(pickId);
    const t = document.getElementById(txtId);
    if (p && t) {
      p.oninput = (e) => { t.value = e.target.value; };
      t.oninput = (e) => {
        if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) p.value = e.target.value;
      };
    }
  });

  const rangeEl = document.getElementById('inputLeaderboardWidth');
  const txtEl = document.getElementById('txtLeaderboardWidth');
  const autoWidthEl = document.getElementById('chkLeaderboardWidthAuto');
  if (rangeEl && txtEl && autoWidthEl) {
    rangeEl.addEventListener('input', () => {
      if (!autoWidthEl.checked) txtEl.textContent = rangeEl.value + 'px';
    });
    autoWidthEl.addEventListener('change', () => {
      rangeEl.disabled = autoWidthEl.checked;
      if (autoWidthEl.checked) {
        txtEl.textContent = 'Auto';
        txtEl.style.opacity = '0.6';
      } else {
        txtEl.textContent = rangeEl.value + 'px';
        txtEl.style.opacity = '';
      }
    });
  }

  // Template inputs must allow spaces explicitly (esp. TplRight)
  ['inputLeaderboardTplLeft', 'inputLeaderboardTplRight'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ') e.stopPropagation();
    });
    el.addEventListener('input', () => {
      if (el.value !== el.dataset.lastValue) {
        el.dataset.lastValue = el.value;
      }
    });
  });

  const chkBg = document.getElementById('chkLeaderboardBgEnabled');
  if (chkBg) chkBg.addEventListener('change', () => toggleGroup('leaderboardBgGroup', chkBg.checked));
  const chkBorder = document.getElementById('chkLeaderboardBorderEnabled');
  if (chkBorder) chkBorder.addEventListener('change', () => toggleGroup('leaderboardBorderGroup', chkBorder.checked));
  const chkRowBg = document.getElementById('chkLeaderboardRowBgEnabled');
  if (chkRowBg) chkRowBg.addEventListener('change', () => toggleGroup('leaderboardRowBgGroup', chkRowBg.checked));
  const chkRowBorder = document.getElementById('chkLeaderboardRowBorderEnabled');
  if (chkRowBorder) chkRowBorder.addEventListener('change', () => toggleGroup('leaderboardRowBorderGroup', chkRowBorder.checked));

  const periodEl = document.getElementById('selectLeaderboardPeriodMode');
  if (periodEl) periodEl.addEventListener('change', () => toggleGroup('leaderboardPeriodCustomGroup', periodEl.value === 'custom'));

  // [UI Fix] เปิด/ปิดวิดเจ็ต = บันทึกอัตโนมัติ ไม่ต้องกดปุ่มบันทึกแยก
  const chkLbEnabled = document.getElementById('chkLeaderboardEnabled');
  if (chkLbEnabled) chkLbEnabled.addEventListener('change', saveLeaderboardSettings);

  const btnSave = document.getElementById('btnSaveLeaderboardSettings');
  if (btnSave) btnSave.addEventListener('click', saveLeaderboardSettings);
  const btnTest = document.getElementById('btnTestLeaderboard');
  if (btnTest) btnTest.addEventListener('click', triggerLeaderboardTest);

  function copyUrl(inputId, btn) {
    const el = document.getElementById(inputId);
    if (!el || !el.value) return;
    navigator.clipboard.writeText(el.value).then(() => {
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = 'คัดลอกแล้ว!';
      btn.style.background = 'var(--success)';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '';
      }, 1500);
    }).catch(() => {});
  }
  const btnCopy = document.getElementById('btnCopyObsLeaderboardUrl');
  const btnOpen = document.getElementById('btnOpenObsLeaderboardUrl');
  if (btnCopy) btnCopy.addEventListener('click', () => copyUrl('obsLeaderboardUrlPreview', btnCopy));
  if (btnOpen) btnOpen.addEventListener('click', () => {
    const url = document.getElementById('obsLeaderboardUrlPreview')?.value;
    if (url) window.open(url, '_blank');
  });

  const btnReload = document.getElementById('btnReloadLeaderboardPreview');
  if (btnReload) btnReload.addEventListener('click', () => {
    btnReload.classList.add('spinning');
    const iframe = document.getElementById('leaderboardPreviewIframe');
    if (iframe) { const s = iframe.src; iframe.src = 'about:blank'; iframe.src = s; }
    setTimeout(() => btnReload.classList.remove('spinning'), 1200);
  });
}

// ========== Recent Donate settings (load/save) ==========
async function loadRecentdonateSettings() {
  try {
    const [settingsRes, tokenRes] = await Promise.all([
      fetch('/api/overlay/settings'),
      fetch('/api/overlay/token')
    ]);
    if (!settingsRes.ok) return;
    const data = await settingsRes.json();
    let c = {};
    try { c = JSON.parse(data.recentdonate_settings || '{}'); } catch (e) {}

    const chkEnabled = document.getElementById('chkRecentdonateEnabled');
    if (chkEnabled) chkEnabled.checked = !!c.enabled;
    updateWidgetBodyVisibility('chkRecentdonateEnabled');

    const maxEl = document.getElementById('selectRecentdonateMaxEntries');
    if (maxEl) { maxEl.value = c.max_entries || 5; maxEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const chkShowTime = document.getElementById('chkRecentdonateShowTime');
    if (chkShowTime) chkShowTime.checked = c.show_time !== false && c.show_time !== 0;
    const chkAnim = document.getElementById('chkRecentdonateAnimation');
    if (chkAnim) chkAnim.checked = c.animation_enabled !== false && c.animation_enabled !== 0;

    const periodMode = c.period_mode || 'all';
    const periodEl = document.getElementById('selectRecentdonatePeriodMode');
    if (periodEl) { periodEl.value = periodMode; periodEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const periodDaysEl = document.getElementById('inputRecentdonatePeriodCustomDays');
    if (periodDaysEl) periodDaysEl.value = c.period_custom_days || 30;
    toggleGroup('recentdonatePeriodCustomGroup', periodMode === 'custom');

    const widthEl = document.getElementById('inputRecentdonateWidth');
    const widthTxt = document.getElementById('txtRecentdonateWidth');
    const autoWidthEl = document.getElementById('chkRecentdonateWidthAuto');
    const savedWidth = parseInt(c.width, 10);
    const widthAuto = !Number.isFinite(savedWidth) || savedWidth < 300 || savedWidth > 1920;
    const width = widthAuto ? 900 : savedWidth;
    if (autoWidthEl) { autoWidthEl.checked = widthAuto; autoWidthEl.dispatchEvent(new Event('change', { bubbles: true })); }
    if (widthEl) {
      widthEl.value = width;
      widthEl.disabled = widthAuto;
      widthEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (widthTxt) {
      widthTxt.textContent = widthAuto ? 'Auto' : width + 'px';
      widthTxt.style.opacity = widthAuto ? '0.6' : '';
    }

    const bgOn = c.bg_enabled !== false && c.bg_enabled !== 0;
    const chkBg = document.getElementById('chkRecentdonateBgEnabled');
    if (chkBg) chkBg.checked = bgOn;
    const bgColorEl = document.getElementById('inputRecentdonateBgColor');
    const bgColorTxt = document.getElementById('txtRecentdonateBgColor');
    if (bgColorEl) bgColorEl.value = c.bg_color || '#000000';
    if (bgColorTxt) bgColorTxt.value = c.bg_color || '#000000';
    const bgOpacityEl = document.getElementById('selectRecentdonateBgOpacity');
    if (bgOpacityEl) { bgOpacityEl.value = c.bg_opacity ?? 60; bgOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
    toggleGroup('recentdonateBgGroup', bgOn);

    const borderOn = c.border_enabled !== false && c.border_enabled !== 0;
    const chkBorder = document.getElementById('chkRecentdonateBorderEnabled');
    if (chkBorder) chkBorder.checked = borderOn;
    const borderColorEl = document.getElementById('inputRecentdonateBorderColor');
    const borderColorTxt = document.getElementById('txtRecentdonateBorderColor');
    if (borderColorEl) borderColorEl.value = c.border_color || '#06b6d4';
    if (borderColorTxt) borderColorTxt.value = c.border_color || '#06b6d4';
    const borderOpacityEl = document.getElementById('selectRecentdonateBorderOpacity');
    if (borderOpacityEl) { borderOpacityEl.value = c.border_opacity ?? 100; borderOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
    toggleGroup('recentdonateBorderGroup', borderOn);

    // เปิดสีพื้นหลังชื่อ (Recent Donate = on/off + สี + ความโปร่งใส)
    const rowBgOn = c.row_bg_enabled !== false && c.row_bg_enabled !== 0;
    const chkRowBg = document.getElementById('chkRecentdonateRowBgEnabled');
    if (chkRowBg) chkRowBg.checked = rowBgOn;
    const rowBgColorEl = document.getElementById('inputRecentdonateRowBgColor');
    const rowBgColorTxt = document.getElementById('txtRecentdonateRowBgColor');
    if (rowBgColorEl) rowBgColorEl.value = c.row_bg_color || '#ffffff';
    if (rowBgColorTxt) rowBgColorTxt.value = c.row_bg_color || '#ffffff';
    const rowBgOpacityEl = document.getElementById('selectRecentdonateRowBgOpacity');
    if (rowBgOpacityEl) { rowBgOpacityEl.value = c.row_bg_opacity ?? 5; rowBgOpacityEl.dispatchEvent(new Event('change', { bubbles: true })); }
    toggleGroup('recentdonateRowBgGroup', rowBgOn);

    // เปิดกรอบชื่อ (Recent Donate = on/off + สีของตัวเอง แยกจากกรอบ #rdWrapper ด้านบน)
    const rowBorderOn = c.row_border_enabled !== false && c.row_border_enabled !== 0;
    const chkRowBorder = document.getElementById('chkRecentdonateRowBorderEnabled');
    if (chkRowBorder) chkRowBorder.checked = rowBorderOn;
    const rowBorderColorEl = document.getElementById('inputRecentdonateRowBorderColor');
    const rowBorderColorTxt = document.getElementById('txtRecentdonateRowBorderColor');
    if (rowBorderColorEl) rowBorderColorEl.value = c.row_border_color || '#ffffff';
    if (rowBorderColorTxt) rowBorderColorTxt.value = c.row_border_color || '#ffffff';
    toggleGroup('recentdonateRowBorderGroup', rowBorderOn);

    const titleEl = document.getElementById('inputRecentdonateTitle');
    if (titleEl) titleEl.value = c.title || '🕐 โดเนทล่าสุด';

    const fsTitleEl = document.getElementById('selectRecentdonateFontSizeTitle');
    if (fsTitleEl) { fsTitleEl.value = c.font_size_title || 22; fsTitleEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const fsRowEl = document.getElementById('selectRecentdonateFontSizeRow');
    if (fsRowEl) { fsRowEl.value = c.font_size_row || 17; fsRowEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const fsTimeEl = document.getElementById('selectRecentdonateFontSizeTime');
    if (fsTimeEl) { fsTimeEl.value = c.font_size_time || 13; fsTimeEl.dispatchEvent(new Event('change', { bubbles: true })); }

    const outlineWEl = document.getElementById('selectRecentdonateOutlineWidth');
    if (outlineWEl) { outlineWEl.value = c.outline_width || 0; outlineWEl.dispatchEvent(new Event('change', { bubbles: true })); }
    const outlineColorEl = document.getElementById('inputRecentdonateOutlineColor');
    const outlineColorTxt = document.getElementById('txtRecentdonateOutlineColor');
    if (outlineColorEl) outlineColorEl.value = c.outline_color || '#000000';
    if (outlineColorTxt) outlineColorTxt.value = c.outline_color || '#000000';

    const colorFields = [
      ['inputRecentdonateColorText', 'txtRecentdonateColorText', c.color_text, '#ffffff'],
      ['inputRecentdonateColorDonor', 'txtRecentdonateColorDonor', c.color_donor, '#ffffff'],
      ['inputRecentdonateColorAmount', 'txtRecentdonateColorAmount', c.color_amount, '#4ade80'],
      ['inputRecentdonateColorCurrency', 'txtRecentdonateColorCurrency', c.color_currency, '#f59e0b'],
      ['inputRecentdonateColorMessage', 'txtRecentdonateColorMessage', c.color_message, '#94a3b8']
    ];
    colorFields.forEach(([pickId, txtId, val, fallback]) => {
      const p = document.getElementById(pickId);
      const t = document.getElementById(txtId);
      if (p) p.value = val || fallback;
      if (t) t.value = val || fallback;
    });

    const tplLeftEl = document.getElementById('inputRecentdonateTplLeft');
    if (tplLeftEl) tplLeftEl.value = c.row_template_left || '{ผู้โดเนท}  {จำนวนเงิน} {สกุลเงิน} ';
    const tplRightEl = document.getElementById('inputRecentdonateTplRight');
    if (tplRightEl) tplRightEl.value = c.row_template_right || ' {ข้อความ}';

    if (tokenRes.ok) {
      const { token } = await tokenRes.json();
      const url = `${location.origin}/recent-donate?token=${token}`;
      const urlEl = document.getElementById('obsRecentdonateUrlPreview');
      if (urlEl) urlEl.value = url;
    }
  } catch (err) {
    console.error('Failed to load recentdonate settings:', err);
  }
}

async function saveRecentdonateSettings() {
  const widthAuto = document.getElementById('chkRecentdonateWidthAuto')?.checked;
  const c = {
    enabled: document.getElementById('chkRecentdonateEnabled')?.checked ? 1 : 0,
    max_entries: parseInt(document.getElementById('selectRecentdonateMaxEntries')?.value) || 5,
    show_time: document.getElementById('chkRecentdonateShowTime')?.checked ? 1 : 0,
    animation_enabled: document.getElementById('chkRecentdonateAnimation')?.checked ? 1 : 0,
    period_mode: document.getElementById('selectRecentdonatePeriodMode')?.value || 'all',
    period_custom_days: parseInt(document.getElementById('inputRecentdonatePeriodCustomDays')?.value) || 30,
    bg_enabled: document.getElementById('chkRecentdonateBgEnabled')?.checked ? 1 : 0,
    bg_color: document.getElementById('inputRecentdonateBgColor')?.value || '#000000',
    bg_opacity: intOrDefault(document.getElementById('selectRecentdonateBgOpacity')?.value, 60),
    border_enabled: document.getElementById('chkRecentdonateBorderEnabled')?.checked ? 1 : 0,
    border_color: document.getElementById('inputRecentdonateBorderColor')?.value || '#06b6d4',
    border_opacity: intOrDefault(document.getElementById('selectRecentdonateBorderOpacity')?.value, 100),
    row_bg_enabled: document.getElementById('chkRecentdonateRowBgEnabled')?.checked ? 1 : 0,
    row_bg_color: document.getElementById('inputRecentdonateRowBgColor')?.value || '#ffffff',
    row_bg_opacity: intOrDefault(document.getElementById('selectRecentdonateRowBgOpacity')?.value, 5),
    row_border_enabled: document.getElementById('chkRecentdonateRowBorderEnabled')?.checked ? 1 : 0,
    row_border_color: document.getElementById('inputRecentdonateRowBorderColor')?.value || '#ffffff',
    title: document.getElementById('inputRecentdonateTitle')?.value || '🕐 โดเนทล่าสุด',
    font_size_title: parseInt(document.getElementById('selectRecentdonateFontSizeTitle')?.value) || 22,
    font_size_row: parseInt(document.getElementById('selectRecentdonateFontSizeRow')?.value) || 17,
    font_size_time: parseInt(document.getElementById('selectRecentdonateFontSizeTime')?.value) || 13,
    outline_width: parseInt(document.getElementById('selectRecentdonateOutlineWidth')?.value) || 0,
    outline_color: document.getElementById('inputRecentdonateOutlineColor')?.value || '#000000',
    color_text: document.getElementById('inputRecentdonateColorText')?.value || '#ffffff',
    color_donor: document.getElementById('inputRecentdonateColorDonor')?.value || '#ffffff',
    color_amount: document.getElementById('inputRecentdonateColorAmount')?.value || '#4ade80',
    color_currency: document.getElementById('inputRecentdonateColorCurrency')?.value || '#f59e0b',
    color_message: document.getElementById('inputRecentdonateColorMessage')?.value || '#94a3b8',
    row_template_left: document.getElementById('inputRecentdonateTplLeft')?.value || '{ผู้โดเนท}  {จำนวนเงิน} {สกุลเงิน} ',
    row_template_right: document.getElementById('inputRecentdonateTplRight')?.value || ' {ข้อความ}'
  };
  if (!widthAuto) {
    c.width = parseInt(document.getElementById('inputRecentdonateWidth')?.value) || 900;
  }
  try {
    const res = await fetchWithCsrf('/api/overlay/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recentdonate_settings: JSON.stringify(c) })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('บันทึกการตั้งค่าโดเนทล่าสุดแล้ว', 'success');
      await loadRecentdonateSettings();
    } else {
      showNotification(data.error || 'ไม่สามารถบันทึกได้', 'error');
    }
  } catch (err) {
    showNotification('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
  }
}

// ========== Recent Donate Test Animation (Req #5) ==========
async function triggerRecentdonateTest() {
  const names = ['สมศักดิ์ รักเรียน', 'แม่ค้าออนไลน์สายลุย', 'น้องเป็ดก้าบๆ 🐤', 'สุดหล่อคีย์บอร์ดเรืองแสง',
    'SuraGaming 🎮', 'นินจานักพัฒนา', 'ผู้สนับสนุนลึกลับ', 'สายฟ้า ไวเปอร์', 'คุณนายตื่นสาย',
    'กุ๊กไก่ ขายไข่', 'ลุงวิศวะ ซ่อมได้ทุกอย่าง', 'ป้าหนึ่ง ขายดี'];
  const amounts = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
  const donor = names[Math.floor(Math.random() * names.length)];
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  const btn = document.getElementById('btnTestRecentdonate');
  if (btn) { btn.disabled = true; btn.querySelector('i').className = 'fa-solid fa-spinner fa-spin'; }
  try {
    const res = await fetchWithCsrf('/api/widget/recentdonate/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ donor, amount })
    });
    if (res.ok) {
      showNotification('ส่งโดเนทล่าสุดทดสอบแล้ว!', 'success');
    } else if (res.status === 429) {
      showNotification('ส่งทดสอบบ่อยเกินไป กรุณารอสักครู่', 'error');
    } else {
      showNotification('ส่งทดสอบไม่สำเร็จ', 'error');
    }
  } catch (err) {
    showNotification('ส่งทดสอบไม่สำเร็จ', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('i').className = 'fa-solid fa-shuffle'; }
  }
}

function initRecentdonateSettingsUI() {
  const colorGroups = [
    ['inputRecentdonateBgColor', 'txtRecentdonateBgColor'],
    ['inputRecentdonateBorderColor', 'txtRecentdonateBorderColor'],
    ['inputRecentdonateRowBgColor', 'txtRecentdonateRowBgColor'],
    ['inputRecentdonateRowBorderColor', 'txtRecentdonateRowBorderColor'],
    ['inputRecentdonateOutlineColor', 'txtRecentdonateOutlineColor'],
    ['inputRecentdonateColorText', 'txtRecentdonateColorText'],
    ['inputRecentdonateColorDonor', 'txtRecentdonateColorDonor'],
    ['inputRecentdonateColorAmount', 'txtRecentdonateColorAmount'],
    ['inputRecentdonateColorCurrency', 'txtRecentdonateColorCurrency'],
    ['inputRecentdonateColorMessage', 'txtRecentdonateColorMessage']
  ];
  colorGroups.forEach(([pickId, txtId]) => {
    const p = document.getElementById(pickId);
    const t = document.getElementById(txtId);
    if (p && t) {
      p.oninput = (e) => { t.value = e.target.value; };
      t.oninput = (e) => {
        if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) p.value = e.target.value;
      };
    }
  });

  const rangeEl = document.getElementById('inputRecentdonateWidth');
  const txtEl = document.getElementById('txtRecentdonateWidth');
  const autoWidthEl = document.getElementById('chkRecentdonateWidthAuto');
  if (rangeEl && txtEl && autoWidthEl) {
    rangeEl.addEventListener('input', () => {
      if (!autoWidthEl.checked) txtEl.textContent = rangeEl.value + 'px';
    });
    autoWidthEl.addEventListener('change', () => {
      rangeEl.disabled = autoWidthEl.checked;
      if (autoWidthEl.checked) {
        txtEl.textContent = 'Auto';
        txtEl.style.opacity = '0.6';
      } else {
        txtEl.textContent = rangeEl.value + 'px';
        txtEl.style.opacity = '';
      }
    });
  }

  // Template inputs must allow spaces explicitly (esp. TplRight)
  ['inputRecentdonateTplLeft', 'inputRecentdonateTplRight'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ') e.stopPropagation();
    });
    el.addEventListener('input', () => {
      if (el.value !== el.dataset.lastValue) {
        el.dataset.lastValue = el.value;
      }
    });
  });

  const chkBg = document.getElementById('chkRecentdonateBgEnabled');
  if (chkBg) chkBg.addEventListener('change', () => toggleGroup('recentdonateBgGroup', chkBg.checked));
  const chkBorder = document.getElementById('chkRecentdonateBorderEnabled');
  if (chkBorder) chkBorder.addEventListener('change', () => toggleGroup('recentdonateBorderGroup', chkBorder.checked));
  const chkRowBg = document.getElementById('chkRecentdonateRowBgEnabled');
  if (chkRowBg) chkRowBg.addEventListener('change', () => toggleGroup('recentdonateRowBgGroup', chkRowBg.checked));
  const chkRowBorder = document.getElementById('chkRecentdonateRowBorderEnabled');
  if (chkRowBorder) chkRowBorder.addEventListener('change', () => toggleGroup('recentdonateRowBorderGroup', chkRowBorder.checked));

  const periodEl = document.getElementById('selectRecentdonatePeriodMode');
  if (periodEl) periodEl.addEventListener('change', () => toggleGroup('recentdonatePeriodCustomGroup', periodEl.value === 'custom'));

  // [UI Fix] เปิด/ปิดวิดเจ็ต = บันทึกอัตโนมัติ ไม่ต้องกดปุ่มบันทึกแยก
  const chkRdEnabled = document.getElementById('chkRecentdonateEnabled');
  if (chkRdEnabled) chkRdEnabled.addEventListener('change', saveRecentdonateSettings);

  const btnSave = document.getElementById('btnSaveRecentdonateSettings');
  if (btnSave) btnSave.addEventListener('click', saveRecentdonateSettings);
  const btnTest = document.getElementById('btnTestRecentdonate');
  if (btnTest) btnTest.addEventListener('click', triggerRecentdonateTest);

  function copyUrl(inputId, btn) {
    const el = document.getElementById(inputId);
    if (!el || !el.value) return;
    navigator.clipboard.writeText(el.value).then(() => {
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = 'คัดลอกแล้ว!';
      btn.style.background = 'var(--success)';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '';
      }, 1500);
    }).catch(() => {});
  }
  const btnCopy = document.getElementById('btnCopyObsRecentdonateUrl');
  const btnOpen = document.getElementById('btnOpenObsRecentdonateUrl');
  if (btnCopy) btnCopy.addEventListener('click', () => copyUrl('obsRecentdonateUrlPreview', btnCopy));
  if (btnOpen) btnOpen.addEventListener('click', () => {
    const url = document.getElementById('obsRecentdonateUrlPreview')?.value;
    if (url) window.open(url, '_blank');
  });

  const btnReload = document.getElementById('btnReloadRecentdonatePreview');
  if (btnReload) btnReload.addEventListener('click', () => {
    btnReload.classList.add('spinning');
    const iframe = document.getElementById('recentdonatePreviewIframe');
    if (iframe) { const s = iframe.src; iframe.src = 'about:blank'; iframe.src = s; }
    setTimeout(() => btnReload.classList.remove('spinning'), 1200);
  });
}

// ========== Color picker bindings (Hex inputs <-> Color box picker) ==========
const colorPickers = [
  { picker: 'colorDonor', txt: 'txtDonor' },
  { picker: 'colorAmount', txt: 'txtAmount' },
  { picker: 'colorBorder', txt: 'txtBorder' },
  { picker: 'colorText', txt: 'txtText' },
  { picker: 'colorBg', txt: 'txtBg' },
  { picker: 'colorSuffix', txt: 'txtSuffix' }
];

colorPickers.forEach(group => {
  const p = document.getElementById(group.picker);
  const t = document.getElementById(group.txt);
  if (p && t) {
    p.oninput = (e) => { t.value = e.target.value; };
    t.oninput = (e) => {
      if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) {
        p.value = e.target.value;
      }
    };
  }
});

// § 3.4 TIER_DONATE_BLUEPRINT.md — client-side validation ก่อน submit: min_amount ของ tier ที่ active ต้องเรียงน้อยไปมาก
function collectTierDonateSettings() {
  const errEl = document.getElementById('tierOrderError');
  if (errEl) errEl.style.display = 'none';

  const tiers = [
    { level: 1, active: true, name: 'tierName1', min: 'tierMinAmount1', img: 'tierAllowImage1', snd: 'tierAllowSound1', upload: 'tierAllowOwnUpload1', youtube: 'tierAllowYoutubeClip1', record: 'tierAllowOwnRecord1' },
    { level: 2, active: document.getElementById('tierActive2')?.checked || false, name: 'tierName2', min: 'tierMinAmount2', img: 'tierAllowImage2', snd: 'tierAllowSound2', upload: 'tierAllowOwnUpload2', youtube: 'tierAllowYoutubeClip2', record: 'tierAllowOwnRecord2' },
    { level: 3, active: document.getElementById('tierActive3')?.checked || false, name: 'tierName3', min: 'tierMinAmount3', img: 'tierAllowImage3', snd: 'tierAllowSound3', upload: 'tierAllowOwnUpload3', youtube: 'tierAllowYoutubeClip3', record: 'tierAllowOwnRecord3' }
  ].map(t => ({
    level: t.level,
    active: t.active,
    name: (document.getElementById(t.name)?.value || '').trim(),
    min_amount: parseInt(document.getElementById(t.min)?.value, 10) || 1,
    allow_image_choice: document.getElementById(t.img)?.checked || false,
    allow_sound_choice: document.getElementById(t.snd)?.checked || false,
    allow_own_upload: document.getElementById(t.upload)?.checked || false,
    allow_youtube_clip: document.getElementById(t.youtube)?.checked || false,
    allow_own_record: document.getElementById(t.record)?.checked || false
  }));

  let prevMin = -Infinity;
  for (const t of tiers) {
    if (!t.active) continue;
    if (t.min_amount <= prevMin) {
      if (errEl) errEl.style.display = '';
      return { valid: false };
    }
    prevMin = t.min_amount;
  }

  return {
    valid: true,
    settings: {
      enabled: document.getElementById('chkTierDonateEnabled')?.checked || false,
      tiers,
      alert_images: tierAlertImages.filter(Boolean)
    }
  };
}

async function saveOverlaySettings() {
  const tierResult = collectTierDonateSettings();
  if (!tierResult.valid) {
    showNotification('ยอดขั้นต่ำของแต่ละ Tier ต้องเรียงจากน้อยไปมาก', 'error');
    return;
  }

  const theme = document.getElementById('themeSelect').value;
  const txtDonor = document.getElementById('txtDonor').value || '#fde047';
  const txtAmount = document.getElementById('txtAmount').value || '#4ade80';
  const txtBorder = document.getElementById('txtBorder').value || 'rgba(255,255,255,0.25)';
  const txtBg = document.getElementById('txtBg').value || 'rgba(15,15,25,0.88)';
  const txtText = document.getElementById('txtText').value || '#ffffff';
  const txtSuffix = document.getElementById('txtSuffix').value || '#f59e0b';
  const templateLine1 = document.getElementById('inputTemplateLine1').value || '{ผู้โดเนท} ได้เลี้ยงกาแฟ';
  const existingThemeColors = parseJsonField(
    document.getElementById('customColorsContainer').dataset.savedThemeColors || '{}',
    {}
  );
  const mergedThemeColors = {
    ...existingThemeColors,
    [theme]: theme === 'glassmorphism'
      ? { donor: txtDonor, amount: txtAmount, border: txtBorder, text: txtText, suffix: txtSuffix }
      : { donor: txtDonor, amount: txtAmount, border: txtBorder, bg: txtBg, text: txtText, suffix: txtSuffix }
  };

  const payload = {
    theme,
    fontFamily: document.getElementById('fontSelect').value,
    animation: document.getElementById('animSelect').value,
    duration: parseInt(document.getElementById('sliderDuration').value),
    particleCount: parseInt(document.getElementById('selectParticles').value),
    customImageMode: document.getElementById('customImageMode').value,
    customImageValue: document.getElementById('customImageValue').value,

    // Legacy flat colors kept as fallback
    primaryColor: txtAmount,
    secondaryColor: txtBorder,
    textColor: txtText,
    backgroundColor: txtBg,
    borderColor: txtBorder,
    fontSize: parseInt(document.getElementById('selectFontSizeAmount').value) || 36,

    // New per-theme JSON fields
    theme_colors: JSON.stringify(mergedThemeColors),
    alert_font_sizes: JSON.stringify({
      header: parseInt(document.getElementById('selectFontSizeHeader').value) || 36,
      donor_hl: parseInt(document.getElementById('selectFontSizeDonorHl').value) || 40,
      message: parseInt(document.getElementById('selectFontSizeMessage').value) || 28,
      amount: parseInt(document.getElementById('selectFontSizeAmount').value) || 36,
      amount_hl: parseInt(document.getElementById('selectFontSizeAmountHl').value) || 72,
      suffix: parseInt(document.getElementById('selectFontSizeSuffix').value) || 72
    }),
    alert_outline: JSON.stringify({
      header_amount: parseInt(document.getElementById('selectOutlineHeaderAmount').value) || 0,
      message: parseInt(document.getElementById('selectOutlineMessage').value) || 0
    }),
    template_line1: templateLine1,
    template_line2: document.getElementById('inputTemplateLine2').value || '',
    messageTemplate: templateLine1,

    soundEnabled: document.getElementById('chkSoundEnabled').checked,
    soundChoice: document.getElementById('soundChoiceSelect').value,
    soundVolume: parseFloat(document.getElementById('sliderSoundVolume').value),
    customSoundUrl: document.getElementById('customSoundUrl').value,

    ttsEnabled: document.getElementById('chkTtsEnabled').checked,
    ttsReadDonor: document.getElementById('chkTtsReadDonor').checked,
    ttsPrefixEnabled: document.getElementById('chkTtsPrefixEnabled').checked,
    ttsLanguage: 'th-TH',
    ttsVolume: parseFloat(document.getElementById('sliderTtsVolume').value),
    ttsRate: parseFloat(document.getElementById('sliderTtsRate').value),

    amountSuffix: document.getElementById('inputAmountSuffix').value,
    showDonorMessage: document.getElementById('chkShowDonorMessage').checked,
    minAmount: parseInt(document.getElementById('inputMinAmount').value) || 1,

    profanityFilterEnabled: document.getElementById('chkProfanityFilterEnabled').checked,
    profanityWords: document.getElementById('inputProfanityWords').value,
    profanityReplaceStyle: document.getElementById('profanityReplaceStyleSelect').value,

    tier_donate_settings: JSON.stringify(tierResult.settings)
  };
 
  try {
    const res = await fetchWithCsrf('/api/overlay/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showNotification('บันทึกสำเร็จ!');
    } else {
      const errData = await res.json().catch(() => ({}));
      showNotification(errData.error || 'บันทึกไม่สำเร็จ กรุณาลองใหม่', 'error');
    }
  } catch (err) {
    showNotification('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
  }
}


// ========== Page Customization Logic ==========
async function loadPageSettings() {
  showTabLoading('page-customization');
  try {
    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    if (!username) return;

    // preview iframe: activatePagePreview() เป็นเจ้าของ src แล้ว (เรียกทุกครั้งที่เข้าแท็บ)

    // L23: Donate URL preview — set here too (not only in loadAccountInfo)
    // ไม่งั้นเปิด tab page-customization ก่อน account tab → ช่องว่างจนกว่าจะสลับไป account แล้วกลับมา
    const pageCustUrlInput = document.getElementById('pageCustomizationDonateUrlPreview');
    if (pageCustUrlInput) {
      pageCustUrlInput.value = `${location.host}/${username.toLowerCase()}`;
    }

    const response = await fetch(`/api/page/${username}/settings`);
    if (!response.ok) throw new Error('โหลดข้อมูลไม่สำเร็จ');
    const data = await response.json();


    // Map API response (camelCase) to inputs
    const mapping = {
      inputPageTitle: 'pageTitle',
      inputPageSubtitle: 'pageSubtitle',
      inputThankYouHeader: 'thankYouHeader',
      inputThankYouSubtitle: 'thankYouSubtitle',
      profileImageValue: 'profileImageValue',
      profileGlowColor: 'profileGlowColor',
      inputHeaderBgUrl: 'headerBgUrl',
      inputPageBgUrl: 'pageBgUrl',
      inputHeaderBgY: 'headerBgY',
    };

    Object.entries(mapping).forEach(([id, apiKey]) => {
      const input = document.getElementById(id);
      if (input) {
        input.value = data[apiKey] || '';
        // Sync text field for profile glow color
        if (id === 'profileGlowColor') {
          const textInput = document.getElementById('txtProfileGlowColor');
          if (textInput) textInput.value = data[apiKey] || '';
        }
      }
    });

    // Handle nested social links
    if (data.socials) {
      const socialMapping = {
        socialTwitch: 'twitch',
        socialYoutube: 'youtube',
        socialTiktok: 'tiktok',
        socialFacebook: 'facebook',
        socialX: 'x',
        socialDiscord: 'discord',
        socialInstagram: 'instagram',
      };
      Object.entries(socialMapping).forEach(([id, socialKey]) => {
        const input = document.getElementById(id);
        if (input) input.value = data.socials[socialKey] || '';
      });
    }

    // Sync Y + show/hide controls + init drag preview
    const headerBgYEl = document.getElementById('inputHeaderBgY');
    const headerBgUrlEl = document.getElementById('inputHeaderBgUrl');
    if (headerBgYEl) {
      headerBgYEl.value = data.headerBgY != null ? data.headerBgY : 0;
      const disp = document.getElementById('headerBgYDisplay');
      if (disp) disp.textContent = headerBgYEl.value;
    }
    if (headerBgUrlEl) headerBgUrlEl.dispatchEvent(new Event('input'));

    // Show pageBg preview if URL exists
    if (data.pageBgUrl) {
      const pageBgPreview = document.getElementById('pageBgPreview');
      if (pageBgPreview) { setMediaPreview(pageBgPreview, data.pageBgUrl); if (!isWebm(data.pageBgUrl)) pageBgPreview.style.display = 'block'; }
    }

    // Update Preview
    setMediaPreview(document.getElementById('profilePreview'), data.profileImage || '/avatar.jpg');
    setMediaPreview(document.getElementById('brandLogoImg'), data.profileImage || '/avatar.jpg');
    // Show clear buttons for already-uploaded assets
    const loadedProfileVal = document.getElementById('profileImageValue')?.value;
    document.getElementById('btnClearProfileImage')?.style.setProperty('display', loadedProfileVal ? '' : 'none');
    document.getElementById('btnClearHeaderBg')?.style.setProperty('display', (data.headerBgUrl || '') ? '' : 'none');
    document.getElementById('btnClearPageBg')?.style.setProperty('display', (data.pageBgUrl || '') ? '' : 'none');
    
    if (data.profileGlowColor) {
      updateBrandGlow(data.profileGlowColor);
    }

    // For other previews, we rely on the iframe reload
    if (iframe) {

        iframe.src = iframe.src;
    }
    
  } catch (err) {
    console.error('Load page settings error:', err);
    tabLoaded['page-customization'] = false;
  } finally {
    hideTabLoading('page-customization');
  }
}

async function savePageSettings(e) {
  e.preventDefault();
  
  // Explicitly map frontend IDs (camelCase) to DB column names (snake_case)
  // to ensure the backend saveStreamer function receives correct keys.
  const settings = {
    page_title: document.getElementById('inputPageTitle')?.value || '',
    page_subtitle: document.getElementById('inputPageSubtitle')?.value || '',
    thank_you_header: document.getElementById('inputThankYouHeader')?.value || '',
    thank_you_subtitle: document.getElementById('inputThankYouSubtitle')?.value || '',
    social_twitch: document.getElementById('socialTwitch')?.value || '',
    social_youtube: document.getElementById('socialYoutube')?.value || '',
    social_tiktok: document.getElementById('socialTiktok')?.value || '',
    social_facebook: document.getElementById('socialFacebook')?.value || '',
    social_x: document.getElementById('socialX')?.value || '',
    social_discord: document.getElementById('socialDiscord')?.value || '',
    social_instagram: document.getElementById('socialInstagram')?.value || '',
    profile_image_value: document.getElementById('profileImageValue')?.value || '',
    profile_glow_color: document.getElementById('profileGlowColor')?.value || '',
    header_bg_url: document.getElementById('inputHeaderBgUrl')?.value || '',
    page_bg_url: document.getElementById('inputPageBgUrl')?.value || '',
    header_bg_y: parseInt(document.getElementById('inputHeaderBgY')?.value || '0', 10),
  };
  
  // Only add profile_image_source if the element exists to avoid overwriting with empty string
  const sourceInput = document.getElementById('profileImageSource');
  if (sourceInput && sourceInput.value) {
    settings.profile_image_source = sourceInput.value;
  } else if (settings.profile_image_value) {
    settings.profile_image_source = 'custom';
  }

  try {
    const response = await fetchWithCsrf('/api/page/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    if (response.ok) {
      showNotification('บันทึกการตั้งค่าหน้าเว็บสำเร็จ');
      loadPageSettings();
    } else {
      const err = await response.json();
      throw new Error(err.error || 'บันทึกไม่สำเร็จ');
    }
  } catch (err) {
    showNotification(err.message, 'error');
  }
}

function updatePagePreview() {
  const iframe = document.getElementById('pagePreviewIframe');
  if (iframe) {
    iframe.src = iframe.src;
  }
}

// ========== Helpers ==========
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getStatusBadgeClass(status) {
  switch (status) {
    case 'successful': return 'badge-success';
    case 'pending': return 'badge-pending';
    case 'failed': return 'badge-failed';
    case 'expired': return 'badge-expired';
    default: return 'badge-pending';
  }
}

function getStatusLabel(status) {
  var labels = { successful: 'สำเร็จ', pending: 'รอชำระ', failed: 'ล้มเหลว', expired: 'หมดอายุ' };
  return labels[status] || status;
}

function validateUrl(url) {
  if (!url) return true; // Optional
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function updateBrandGlow(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--brand-glow-color', color);
}

// Initialize settings on load
// (Moved inside DOMContentLoaded)

// ========== Sound Browser Functions ==========
let _soundBrowserTarget = 'customSoundUrl'; // input id to write selected URL into
let _soundBrowserOffset = 0;
let _soundBrowserLoading = false;
let _soundBrowserHasMore = true;
let _soundBrowserQuery = '';
let _soundBrowserPageId = 'th';
let _soundBrowserPages = ['th', 'global', 'us', 'jp', 'de', 'br', 'fr', 'uk'];
let _soundBrowserPageIndex = 0;

function openSoundBrowser(targetInputId) {
  _soundBrowserTarget = targetInputId || 'customSoundUrl';
  const modal = document.getElementById('soundBrowserModal');
  const input = document.getElementById('soundSearchInput');
  const resultsDiv = document.getElementById('soundResults');
  if (modal) modal.style.display = 'flex';
  if (input) {
    input.value = '';
    input.focus();
  }
  if (resultsDiv) resultsDiv.innerHTML = '';
  _soundBrowserOffset = 0;
  _soundBrowserLoading = false;
  _soundBrowserHasMore = true;
  _soundBrowserQuery = '';
  _soundBrowserPageId = 'th';
  _soundBrowserPageIndex = 0;
  updatePageName('Thailand');
  loadMoreSounds();
}

function closeSoundBrowser() {
  const modal = document.getElementById('soundBrowserModal');
  if (modal) modal.style.display = 'none';
  
  // Stop playback and cleanup
  soundPlayer.cleanup();
  
  if (window._soundPreviewAudio) {
    window._soundPreviewAudio.pause();
    window._soundPreviewAudio = null;
  }
  
  // Log cache stats
  if (soundCache) {
    soundCache.getStats().then(stats => {
      console.log('[SoundBrowser] Cache stats:', stats.count, 'sounds,', stats.sizeMB, 'MB');
    }).catch(() => {});
  }
}

function updatePageName(name) {
  const el = document.getElementById('soundPageName');
  if (el) el.textContent = name;
}

function loadNextPage() {
  if (_soundBrowserLoading) return;
  
  const resultsDiv = document.getElementById('soundResults');
  if (resultsDiv) resultsDiv.innerHTML = '';
  
  _soundBrowserPageIndex++;
  if (_soundBrowserPageIndex >= _soundBrowserPages.length) {
    _soundBrowserPageIndex = 0;
  }
  _soundBrowserPageId = _soundBrowserPages[_soundBrowserPageIndex];
  _soundBrowserOffset = 0;
  _soundBrowserHasMore = true;
  _soundBrowserQuery = '';
  
  const input = document.getElementById('soundSearchInput');
  if (input) input.value = '';
  
  console.log('[SoundBrowser] Next page:', _soundBrowserPageId, 'index:', _soundBrowserPageIndex);
  loadMoreSounds();
}

async function loadMoreSounds() {
  if (_soundBrowserLoading || !_soundBrowserHasMore) return;
  _soundBrowserLoading = true;

  const resultsDiv = document.getElementById('soundResults');
  if (!resultsDiv) return;

  const loader = document.createElement('div');
  loader.id = 'soundLoader';
  loader.style.cssText = 'text-align:center;padding:16px;color:var(--text-muted);';
  loader.innerHTML = '<i class="fa fa-spinner fa-spin" style="font-size:20px;"></i>';
  resultsDiv.appendChild(loader);

  try {
    const url = _soundBrowserQuery 
      ? `/api/myinstants/search?q=${encodeURIComponent(_soundBrowserQuery)}&page=${_soundBrowserPageId}&offset=${_soundBrowserOffset}&limit=10`
      : `/api/myinstants/search?page=${_soundBrowserPageId}&offset=${_soundBrowserOffset}&limit=10`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();

    const loaderEl = document.getElementById('soundLoader');
    if (loaderEl) loaderEl.remove();

    if (data.pageName) {
      updatePageName(data.pageName);
    }

    if (!data.results || data.results.length === 0) {
      if (_soundBrowserOffset === 0 && data.fallbackDirectUrl) {
        await loadSoundsViaClientParse(resultsDiv, data.fallbackDirectUrl);
        _soundBrowserLoading = false;
        return;
      }
      if (_soundBrowserOffset === 0) {
        resultsDiv.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">ไม่พบเสียง</div>';
      }
      _soundBrowserHasMore = false;
      _soundBrowserLoading = false;
      return;
    }

    data.results.forEach(sound => {
      const item = document.createElement('div');
      item.className = 'sound-item';
      item.innerHTML = `
        <span style="flex:1;font-size:14px;">${escapeHtml(sound.name)}</span>
        <button class="btn btn-sm btn-play-sound" data-mp3="${escapeHtml(sound.mp3Url)}"
                style="background:var(--bg-secondary,#1e293b);"
                onclick="previewSound(this)"><i class="fa-solid fa-play"></i> เล่น</button>
        <button class="btn btn-sm btn-primary btn-select-sound" data-mp3="${escapeHtml(sound.mp3Url)}"
                onclick="selectSound(this)">เลือก</button>
      `;
      resultsDiv.appendChild(item);
    });

    _soundBrowserOffset += data.results.length;
    _soundBrowserHasMore = data.hasMore || false;
    _soundBrowserLoading = false;

    if (_soundBrowserHasMore && resultsDiv.scrollHeight <= resultsDiv.clientHeight) {
      setTimeout(() => loadMoreSounds(), 100);
    }
  } catch (err) {
    const loaderEl = document.getElementById('soundLoader');
    if (loaderEl) loaderEl.remove();
    if (_soundBrowserOffset === 0) {
      resultsDiv.innerHTML = '<div style="text-align:center;padding:20px;color:var(--failed,#ef4444);">ค้นหาไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
    }
    _soundBrowserLoading = false;
  }
}

async function loadSoundsViaClientParse(resultsDiv, directUrl) {
  const searchQuery = _soundBrowserQuery || '';
  const searchUrl = searchQuery
    ? `https://www.myinstants.com/search/?name=${encodeURIComponent(searchQuery)}`
    : directUrl;

  resultsDiv.innerHTML = `
    <div style="padding:20px;text-align:center;">
      <div style="color:var(--text-muted);margin-bottom:12px;">
        <i class="fa-solid fa-triangle-exclamation"></i> ไม่สามารถค้นหาอัตโนมัติได้กรุณาค้นหาด้วยวิธีนี้ <br>
        กดคลิกขวาที่ Download MP3 > Copy Link > วางลิงก์เสียง
      </div>
      <a href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener"
         style="display:inline-block;padding:10px 20px;background:var(--primary,#667eea);color:#fff;border-radius:8px;text-decoration:none;font-size:14px;margin-bottom:16px;">
         <i class="fa-solid fa-external-link-alt"></i> เปิด myinstants.com ค้นหาเสียง
      </a>
      <div style="display:flex;gap:8px;align-items:center;max-width:400px;margin:0 auto;">
        <input type="text" id="manualSoundUrl" class="form-control"
               placeholder="วาง URL เสียงจาก myinstants.com ที่นี่..."
               style="flex:1;font-size:13px;">
        <button class="btn btn-primary btn-sm" onclick="addManualSound()"
                style="white-space:nowrap;"><i class="fa-solid fa-plus"></i> เพิ่ม</button>
      </div>
      <small style="color:var(--text-muted);display:block;margin-top:8px;">
        ตัวอย่าง: https://www.myinstants.com/media/sounds/aimaihwaelw.mp3
      </small>
    </div>`;

  _soundBrowserHasMore = false;
}

function addManualSound() {
  const input = document.getElementById('manualSoundUrl');
  const resultsDiv = document.getElementById('soundResults');
  if (!input || !resultsDiv) return;

  const rawUrl = input.value.trim();
  if (!rawUrl) return;

  let slug = '';
  let mp3Url = '';
  let name = '';

  const urlLower = rawUrl.toLowerCase();

  if (urlLower.includes('/media/sounds/')) {
    const m = rawUrl.match(/\/media\/sounds\/([\w-]+)\.mp3/);
    if (m) {
      slug = m[1];
      mp3Url = rawUrl;
    }
  } else if (urlLower.includes('/instant/')) {
    const m = rawUrl.match(/\/instant\/([\w-]+)/);
    if (m) {
      slug = m[1].replace(/\/$/, '');
      mp3Url = `https://www.myinstants.com/media/sounds/${slug}.mp3`;
    }
  }

  if (!slug || !mp3Url) {
    input.style.borderColor = '#ef4444';
    setTimeout(() => { input.style.borderColor = ''; }, 2000);
    return;
  }

  name = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const item = document.createElement('div');
  item.className = 'sound-item';
  item.innerHTML = `
    <span style="flex:1;font-size:14px;">${escapeHtml(name)}</span>
    <button class="btn btn-sm btn-play-sound" data-mp3="${escapeHtml(mp3Url)}"
            style="background:var(--bg-secondary,#1e293b);"
            onclick="previewSound(this)"><i class="fa-solid fa-play"></i> เล่น</button>
    <button class="btn btn-sm btn-primary btn-select-sound" data-mp3="${escapeHtml(mp3Url)}"
            onclick="selectSound(this)">เลือก</button>
  `;

  const existing = resultsDiv.querySelector('.sound-item');
  if (existing) {
    resultsDiv.insertBefore(item, existing);
  } else {
    resultsDiv.innerHTML = '';
    resultsDiv.appendChild(item);
  }

  input.value = '';
}

async function searchSounds() {
  const input = document.getElementById('soundSearchInput');
  const resultsDiv = document.getElementById('soundResults');
  if (!resultsDiv) return;

  _soundBrowserQuery = input ? input.value.trim() : '';
  _soundBrowserOffset = 0;
  _soundBrowserHasMore = true;
  _soundBrowserLoading = false;
  resultsDiv.innerHTML = '';
  
  if (_soundBrowserQuery) {
    updatePageName(`Search: ${_soundBrowserQuery}`);
  }
  
  loadMoreSounds();
}

async function previewSound(btn) {
  const url = btn.getAttribute('data-mp3');
  if (!url) return;

  // Stop any current playback
  soundPlayer.stop();

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> โหลด...';
  btn.disabled = true;

  let hasError = false;
  let errorTimeout = null;

  try {
    // Play with caching (lazy load - only fetches on first play)
    const audio = await soundPlayer.play(url, { volume: 0.5 });
    
    btn.innerHTML = '<i class="fa-solid fa-pause"></i> หยุด';
    btn.disabled = false;

    audio.onended = () => { 
      btn.innerHTML = '<i class="fa-solid fa-play"></i> เล่น'; 
    };
    
    audio.onerror = () => { 
      // Delay error display to prevent flicker
      if (errorTimeout) clearTimeout(errorTimeout);
      errorTimeout = setTimeout(() => {
        if (soundPlayer.isPlaying()) return; // Still playing, ignore error
        btn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> เล่นไม่ได้'; 
        btn.disabled = false;
        hasError = true;
      }, 500);
    };

    // Toggle play/pause
    btn.onclick = () => {
      if (hasError) {
        // Reset and retry
        hasError = false;
        previewSound(btn);
        return;
      }
      if (soundPlayer.isPlaying()) {
        soundPlayer.pause();
        btn.innerHTML = '<i class="fa-solid fa-play"></i> เล่น';
      } else {
        soundPlayer.resume();
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> หยุด';
      }
    };
  } catch (err) {
    console.error('[previewSound] Failed to play:', url, err);
    
    // Delay error display to prevent flicker
    if (errorTimeout) clearTimeout(errorTimeout);
    errorTimeout = setTimeout(() => {
      btn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> เล่นไม่ได้';
      btn.disabled = false;
      hasError = true;
    }, 500);
    
    // Fallback: try direct play without cache
    try {
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.volume = 0.5;
      
      // Wait for audio to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
        audio.oncanplaythrough = () => { clearTimeout(timeout); resolve(); };
        audio.onerror = () => { clearTimeout(timeout); reject(new Error('Load failed')); };
        if (audio.readyState >= 4) { clearTimeout(timeout); resolve(); }
      });
      
      await audio.play();
      window._soundPreviewAudio = audio;
      
      // Clear error state since fallback worked
      if (errorTimeout) clearTimeout(errorTimeout);
      hasError = false;
      
      btn.innerHTML = '<i class="fa-solid fa-pause"></i> หยุด';
      btn.disabled = false;
      
      audio.onended = () => { btn.innerHTML = '<i class="fa-solid fa-play"></i> เล่น'; };
      audio.onerror = () => { 
        if (errorTimeout) clearTimeout(errorTimeout);
        errorTimeout = setTimeout(() => {
          if (!audio.paused) return;
          btn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> เล่นไม่ได้'; 
        }, 500);
      };
      
      btn.onclick = () => {
        if (hasError) {
          hasError = false;
          previewSound(btn);
          return;
        }
        if (!audio.paused) {
          audio.pause();
          btn.innerHTML = '<i class="fa-solid fa-play"></i> เล่น';
        } else {
          audio.play();
          btn.innerHTML = '<i class="fa-solid fa-pause"></i> หยุด';
        }
      };
    } catch (fallbackErr) {
      console.error('[previewSound] Fallback also failed:', url, fallbackErr);
      // Error already shown above
    }
  }
}

function selectSound(btn) {
  const url = btn.getAttribute('data-mp3');
  if (!url) return;
  const input = document.getElementById(_soundBrowserTarget);
  if (input) {
    input.value = url;
    showNotification('เลือกเสียงแล้ว');
  }
  closeSoundBrowser();
}

function handleSoundScroll(el) {
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 30) {
    loadMoreSounds();
  }
}

// ========== Expandable Settings Cards ==========

function toggleCardPanel(card, panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;

  const isOpen = card.classList.contains('panel-open');

  if (isOpen) {
    panel.classList.remove('panel-opening');
    panel.classList.add('panel-closing');
    card.classList.remove('panel-open');
    setTimeout(() => {
      panel.style.display = 'none';
      panel.classList.remove('panel-closing');
    }, 300);
  } else {
    panel.style.display = 'block';
    panel.classList.remove('panel-closing');
    panel.classList.add('panel-opening');
    card.classList.add('panel-open');
    setTimeout(() => {
      panel.classList.remove('panel-opening');
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 400);
  }
}

function initCardPanels() {
  document.querySelectorAll('.settings-card').forEach(card => {
    const header = card.querySelector('.settings-card-header');
    const panelId = header?.dataset.target;
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) return;

    if (card.classList.contains('panel-open')) {
      panel.style.display = 'block';
    } else {
      panel.style.display = 'none';
    }
  });
}

document.addEventListener('click', (e) => {
  const header = e.target.closest('.settings-card-header');
  if (!header || !header.dataset.target) return;

  const card = header.closest('.settings-card');
  if (!card) return;

  header.classList.remove('header-clicked');
  void header.offsetWidth;
  header.classList.add('header-clicked');
  header.addEventListener('animationend', () => header.classList.remove('header-clicked'), { once: true });

  toggleCardPanel(card, header.dataset.target);
});

// ========== Payment Settings Functions ==========

function showSelectionBubble(element, message) {
  // ลบ bubble เดิมถ้ามี
  const existingBubble = element.querySelector('.selection-bubble');
  if (existingBubble) existingBubble.remove();

  const bubble = document.createElement('div');
  bubble.className = 'selection-bubble';
  bubble.textContent = message;
  element.style.position = 'relative';
  element.appendChild(bubble);

  setTimeout(() => {
    if (bubble.parentNode) bubble.remove();
  }, 1800);
}

function openSettingsPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  
  panel.style.display = 'block';
  panel.classList.remove('panel-closing');
  panel.classList.add('panel-opening');
  
  // ลบ class panel-opening หลัง animation จบ (400ms)
  setTimeout(() => {
    panel.classList.remove('panel-opening');
  }, 400);
}

function closeSettingsPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel || panel.style.display === 'none') return;
  
  panel.classList.add('panel-closing');
  
  // รอ animation จบแล้วค่อยซ่อน (300ms)
  setTimeout(() => {
    panel.style.display = 'none';
    panel.classList.remove('panel-closing');
  }, 300);
}

function updateSaveButton() {
  const btnSave = document.getElementById('btnSavePaymentSettings');
  if (!btnSave) return;

  // อนุญาตให้บันทึกได้เสมอ (แม้ไม่มีวิธีไหนถูกเลือก)
  // เพื่อให้ Guard ในหน้า Donate ทำงานได้
  btnSave.disabled = false;
}

function updatePromptPayPlaceholder() {
  const type = document.getElementById('inputPromptPayType')?.value;
  const input = document.getElementById('inputPromptPay');
  const hint = document.getElementById('promptpayHint');

  if (!input || !hint) return;

  const configs = {
    phone: { placeholder: '0812345678', hint: 'กรุณากรอกเบอร์โทรศัพท์ที่ผูกกับบัญชีพร้อมเพย์', maxlength: 10 },
    idcard: { placeholder: 'เลขบัตร 13 หลัก', hint: 'กรุณากรอกเลขบัตรประจำตัวประชาชน', maxlength: 13 },
    ewallet: { placeholder: 'e-Wallet ID', hint: 'กรุณากรอก e-Wallet ID', maxlength: 15 }
  };

  const config = configs[type] || configs.phone;
  input.placeholder = config.placeholder;
  input.maxLength = config.maxlength;
  hint.textContent = config.hint;
}

function validatePromptPaySettings() {
  const errors = [];
  const promptpayActive = document.getElementById('cardPromptPay')?.classList.contains('active');
  const trueMoneyActive = document.getElementById('cardTrueMoney')?.classList.contains('active');
  const bankActive = document.getElementById('cardBank')?.classList.contains('active');

  const highlight = (id, bad) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.borderColor = bad ? '#f87171' : '';
    el.style.boxShadow = bad ? '0 0 0 3px rgba(248,113,113,0.2)' : '';
  };

  // Unified SlipOK — บังคับถ้าเลือกวิธีรับเงินอย่างน้อย 1 วิธี
  if (promptpayActive || trueMoneyActive || bankActive) {
    const api = document.getElementById('inputSlipOkApi')?.value.trim();
    const apiKey = document.getElementById('inputSlipOkApiKey')?.value.trim();
    if (!api) errors.push('SlipOK API');
    if (!apiKey) errors.push('SlipOK API Key');
    highlight('inputSlipOkApi', !api);
    highlight('inputSlipOkApiKey', !apiKey);
  }

  if (promptpayActive) {
    const v = document.getElementById('inputPromptPay')?.value.trim();
    if (!v) errors.push('ข้อมูลพร้อมเพย์');
    highlight('inputPromptPay', !v);
  }

  if (trueMoneyActive) {
    const phone = document.getElementById('inputTrueMoneyPhone')?.value.trim();
    if (!phone) errors.push('เบอร์ TrueMoney');
    highlight('inputTrueMoneyPhone', !phone);
  }

  if (bankActive) {
    const bankName = document.getElementById('inputBankName')?.value;
    const accNo = document.getElementById('inputBankAccountNumber')?.value.trim();
    const accName = document.getElementById('inputBankAccountName')?.value.trim();
    if (!bankName) errors.push('ธนาคาร');
    if (!accNo) errors.push('เลขบัญชีธนาคาร');
    if (!accName) errors.push('ชื่อเจ้าของบัญชี');
    highlight('inputBankAccountNumber', !accNo);
    highlight('inputBankAccountName', !accName);
  }

  return { valid: errors.length === 0, errors };
}

// fill webhook URL input — guard against placeholder ('กำลังโหลด...') before accUsername loads
function fillWebhookUrl() {
  const urlInput = document.getElementById('webhookUrlInput');
  // canonical username จาก payment settings (ไม่พึ่ง accUsername DOM ที่ default 'กำลังโหลด...')
  const username = window._lastPaymentSettings?.username
    || document.getElementById('accUsername')?.textContent?.trim() || '';
  if (!urlInput || !username || username === 'กำลังโหลด...' || username.includes('...')) return;
  urlInput.value = `${location.origin}/api/truemoney/webhook?streamerId=${encodeURIComponent(username)}`;
}

function renderTrueMoneyWebhookState(data) {
  const badge = document.getElementById('webhookStatusBadge');
  const quota = document.getElementById('webhookQuotaMini');
  const conflictBanner = document.getElementById('webhookConflictBanner');
  const urlInput = document.getElementById('webhookUrlInput');
  const connectBtn = document.getElementById('btnConnectWebhook');
  const connectedActions = document.getElementById('webhookConnectedActions');
  const swP2P = document.getElementById('swMethodP2P');
  const swPromptpay = document.getElementById('swMethodPromptpay');
  const promptpayGroup = document.getElementById('webhookPromptpayIdGroup');
  const promptpayIdInput = document.getElementById('webhookPromptpayId');

  if (!badge) return;

  fillWebhookUrl();

  const enabled = data.truemoney_webhook_enabled === 1 || data.truemoney_webhook_enabled === true || data.truemoney_webhook_enabled === '1';
  const secretSet = !!data.truemoney_webhook_secret_set;
  const methods = (data.truemoney_webhook_methods || 'P2P').split(',').filter(Boolean);

  const hiddenNote = document.getElementById('truemoneyWebhookRequiredNote');
  if (hiddenNote) hiddenNote.classList.toggle('is-visible', !!data.truemoney_enabled && !enabled);

  // badge — three states (no expiry countdown: Open API expiry unknown, RT#5)
  // dot ใช้ .status-dot เหมือนหน้าโดเนท/TikTok bridge badge (ไม่ใช้ emoji)
  let badgeText, badgeColor, dotCls;
  if (enabled) {
    badgeText = 'เชื่อมต่อแล้ว · ไม่ต้องใช้สลิป';
    badgeColor = '#10b981';
    dotCls = 'online';
  } else if (secretSet) {
    badgeText = 'เชื่อมต่อไม่ได้ · กดต่ออายุ';
    badgeColor = '#ef4444';
    dotCls = 'error';
  } else {
    badgeText = 'ยังไม่เชื่อมต่อ';
    badgeColor = '#94a3b8';
    dotCls = '';
  }
  badge.className = 'webhook-badge';
  badge.style.background = `${badgeColor}26`;
  badge.style.color = badgeColor;
  badge.style.border = `1px solid ${badgeColor}40`;
  const badgeDot = badge.querySelector('.status-dot');
  const badgeTextEl = badge.querySelector('.webhook-badge-text');
  if (badgeDot) badgeDot.className = 'status-dot' + (dotCls ? ' ' + dotCls : '');
  if (badgeTextEl) badgeTextEl.textContent = badgeText;

  if (quota) {
    const tx = data.truemoney_webhook_tx_month || 0;
    quota.textContent = `เดือนนี้ ${tx}/100 ครั้งฟรี`;
  }

  // hide eligibility + tip notes once connected — no longer relevant
  const section = document.getElementById('truemoneyWebhookSection');
  if (section) {
    section.querySelectorAll('.webhook-eligibility-note').forEach(n => {
      n.style.display = enabled ? 'none' : '';
    });
  }

  // connect button — hidden when enabled; "เชื่อมต่อใหม่" when secret exists but disabled
  if (connectBtn) {
    if (enabled) {
      connectBtn.style.display = 'none';
    } else {
      connectBtn.style.display = '';
      const labelEl = connectBtn.querySelector('span');
      if (labelEl) labelEl.textContent = secretSet ? 'เชื่อมต่อใหม่' : 'เชื่อมต่อ TrueMoney';
    }
  }

  // connected actions (ต่ออายุ/ตัดการเชื่อมต่อ) — visible once a secret exists or connected
  if (connectedActions) {
    connectedActions.style.display = (secretSet || enabled) ? 'flex' : 'none';
  }

  // "ตั้งค่าวิธีรับเงิน" — hidden until connected (gate method config behind active webhook)
  const openMethodsBtn = document.getElementById('btnOpenWebhookModal');
  if (openMethodsBtn) openMethodsBtn.style.display = enabled ? '' : 'none';

  // method switches — reflect stored state (preference only until connected)
  if (swP2P) { swP2P.checked = methods.includes('P2P') || methods.length === 0; swP2P.dispatchEvent(new Event('change', { bubbles: true })); }
  if (swPromptpay) { swPromptpay.checked = methods.includes('PROMPTPAY_IN'); swPromptpay.dispatchEvent(new Event('change', { bubbles: true })); }
  if (promptpayGroup) promptpayGroup.style.display = (swPromptpay?.checked) ? 'block' : 'none';
  if (promptpayIdInput) promptpayIdInput.value = data.truemoney_promptpay_id || '';

  if (conflictBanner) {
    const hasPromptpayIn = methods.includes('PROMPTPAY_IN');
    const slipokPromptpayEnabled = data.promptpay_enabled === 1 || data.promptpay_enabled === true || data.promptpay_enabled === '1';
    conflictBanner.style.display = (enabled && hasPromptpayIn && !slipokPromptpayEnabled) ? 'flex' : 'none';
  }
}

function initTrueMoneyWebhookModal() {
  const guideModal = document.getElementById('webhookGuideModal');
  const consentModal = document.getElementById('webhookConsentModal');
  const btnOpenMethods = document.getElementById('btnOpenWebhookModal');
  const methodSettings = document.getElementById('webhookMethodSettings');
  const btnConnect = document.getElementById('btnConnectWebhook');
  const btnRenew = document.getElementById('btnRenewWebhook');
  const btnDisconnect = document.getElementById('btnDisconnectWebhook');
  const swPromptpay = document.getElementById('swMethodPromptpay');
  const promptpayGroup = document.getElementById('webhookPromptpayIdGroup');

  if (!guideModal) return;

  const TMN_LINK = 'https://tmn.app.link/PFCCLT';
  const isMobile = () => /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  function openModal(modal) {
    modal.style.display = 'flex';
    modal.style.animation = 'modalFade 0.25s ease forwards';
  }
  function closeModal(modal) {
    modal.style.animation = 'modalFadeOut 0.2s ease forwards';
    modal.addEventListener('animationend', function handler() {
      modal.style.display = 'none';
      modal.style.animation = '';
      modal.removeEventListener('animationend', handler);
    });
  }

  // ---- toggle method settings (replaces old modal open) ----
  if (btnOpenMethods && methodSettings) {
    btnOpenMethods.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = methodSettings.style.display === 'none' || !methodSettings.style.display;
      methodSettings.style.display = open ? 'block' : 'none';
      const chev = btnOpenMethods.querySelector('i');
      if (chev) chev.style.transform = open ? 'rotate(180deg)' : '';
    });
  }

  // ---- toggle whole webhook section (collapsed shows only h5) ----
  const sectionToggle = document.getElementById('webhookSectionToggle');
  const sectionBody = document.getElementById('webhookSectionBody');
  if (sectionToggle && sectionBody) {
    sectionToggle.addEventListener('click', () => {
      const open = !sectionBody.classList.contains('is-open');
      sectionBody.classList.toggle('is-open', open);
      sectionToggle.classList.toggle('is-open', open);
    });
  }

  if (swPromptpay && promptpayGroup) {
    swPromptpay.addEventListener('change', () => {
      promptpayGroup.style.display = swPromptpay.checked ? 'block' : 'none';
    });
  }

  // ---- 5-step guide stepper ----
  let currentStep = 1;
  const steps = guideModal.querySelectorAll('.webhook-step');
  const dots = guideModal.querySelectorAll('#webhookStepDots .dot');
  const btnPrev = document.getElementById('btnWebhookGuidePrev');
  const btnNext = document.getElementById('btnWebhookGuideNext');
  const btnSave = document.getElementById('btnSaveWebhook');
  const stepCount = document.getElementById('webhookStepCount');
  const btnOpenApp = document.getElementById('btnOpenTrueMoneyApp');

  function showStep(n) {
    currentStep = n;
    steps.forEach(s => { s.style.display = (Number(s.dataset.step) === n) ? 'block' : 'none'; });
    dots.forEach((d, i) => d.classList.toggle('active', i === n - 1));
    if (stepCount) stepCount.textContent = `${n} / 5`;
    if (btnPrev) btnPrev.style.visibility = n > 1 ? 'visible' : 'hidden';
    if (btnNext) btnNext.style.display = n < 5 ? '' : 'none';
    if (btnSave) btnSave.style.display = n === 5 ? '' : 'none';
    // mobile gate on step 1
    const deskGate = document.getElementById('webhookMobileGateDesktop');
    const mobGate = document.getElementById('webhookMobileGateMobile');
    if (n === 1 && deskGate && mobGate) {
      const mob = isMobile();
      deskGate.style.display = mob ? 'none' : 'block';
      mobGate.style.display = mob ? 'block' : 'none';
    }
  }

  function openGuide() {
    fillWebhookUrl();
    const tokenInput = document.getElementById('webhookConnectToken');
    if (tokenInput) tokenInput.value = '';
    showStep(1);
    openModal(guideModal);
  }

  if (btnConnect) btnConnect.addEventListener('click', openGuide);
  document.getElementById('btnCloseWebhookGuide')?.addEventListener('click', () => closeModal(guideModal));
  guideModal.addEventListener('click', e => { if (e.target === guideModal) closeModal(guideModal); });
  if (btnPrev) btnPrev.addEventListener('click', () => { if (currentStep > 1) showStep(currentStep - 1); });
  if (btnNext) btnNext.addEventListener('click', () => { if (currentStep < 5) showStep(currentStep + 1); });

  // step 4 — open TrueMoney app (mobile-only enabled)
  if (btnOpenApp) {
    if (!isMobile()) btnOpenApp.disabled = true;
    btnOpenApp.addEventListener('click', () => {
      if (btnOpenApp.disabled) {
        showNotification('เปิดหน้านี้ในมือถือเพื่อเปิดแอพ TrueMoney ได้', 'error');
        return;
      }
      window.open(TMN_LINK, '_blank', 'noopener');
    });
  }

  // copy webhook url (step 3)
  const btnCopy = document.getElementById('btnCopyWebhookUrl');
  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      const input = document.getElementById('webhookUrlInput');
      if (!input?.value) return;
      try {
        await navigator.clipboard.writeText(input.value);
        const icon = btnCopy.querySelector('i');
        if (icon) { icon.className = 'fa-solid fa-check'; icon.style.color = '#22c55e'; }
        setTimeout(() => { if (icon) { icon.className = 'fa-solid fa-copy'; icon.style.color = '#3b82f6'; } }, 2000);
      } catch (err) {
        showNotification('ไม่สามารถคัดลอก URL ได้', 'error');
      }
    });
  }

  // ---- single save (บันทึก+เปิดใช้งาน) ----
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      const token = (document.getElementById('webhookConnectToken')?.value || '').trim();
      const p2p = document.getElementById('swMethodP2P')?.checked;
      const promptpay = document.getElementById('swMethodPromptpay')?.checked;
      const promptpayId = (document.getElementById('webhookPromptpayId')?.value || '').trim();

      const methods = [];
      if (p2p) methods.push('P2P');
      if (promptpay) methods.push('PROMPTPAY_IN');

      if (token.replace(/\s+/g, '').length < 32) {
        showNotification('Key ไม่ถูกต้อง กรุณาคัดลอก Key/รหัสลับใหม่จากหน้าตั้งค่า Webhook ในแอพ TrueMoney', 'error');
        return;
      }
      if (methods.length === 0) {
        showNotification('กรุณาเลือกอย่างน้อย 1 วิธีรับเงิน', 'error');
        return;
      }
      if (promptpay && !/^\d{15}$/.test(promptpayId)) {
        showNotification('PromptPay e-Wallet ID ต้องเป็นตัวเลข 15 หลัก', 'error');
        return;
      }

      const payload = {
        action: 'enable',
        token,
        methods,
        promptpayId: promptpay ? promptpayId : undefined
        // consented ไม่ส่งเป็น default — set เฉพาะใน onAccept หลัง user ติ๊กยอมรับ (F-01)
      };

      const currentSettings = window._lastPaymentSettings || {};
      const kycConfirmed = Number(currentSettings.truemoney_webhook_kyc_confirmed) === 1;
      const slipokPromptpayEnabled = currentSettings.promptpay_enabled === 1 || currentSettings.promptpay_enabled === true || currentSettings.promptpay_enabled === '1';

      const submit = async () => {
        try {
          const res = await fetchWithCsrf('/api/truemoney/setup-webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (res.ok && data.success) {
            showNotification('เชื่อมต่อ TrueMoney สำเร็จ! ✅ รับเงินอัตโนมัติได้เลย ไม่ต้องใช้สลิป', 'success');
            if (data.promptpaySlipokDisabled) {
              showNotification('พร้อมเพย์ SlipOK ถูกปิดอัตโนมัติ — เปิดกลับได้ที่การตั้งค่าพร้อมเพย์');
            }
            closeModal(guideModal);
            await loadPaymentSettings();
          } else {
            showNotification(data.error || 'Key ใช้ไม่ได้ กรุณาคัดลอก Key/รหัสลับใหม่จากหน้าตั้งค่า Webhook ในแอพ TrueMoney', 'error');
          }
        } catch (err) {
          showNotification(err.message || 'ไม่สามารถบันทึก Webhook ได้', 'error');
        }
      };

      // PROMPTPAY switch ON + SlipOK enabled → confirm disable SlipOK (§5.7)
      const runWithConflictConfirm = async () => {
        if (promptpay && slipokPromptpayEnabled) {
          showConfirmModal(
            'เปิดพร้อมเพย์ทรูมันนี่',
            'เปิดพร้อมเพย์ทรูมันนี่ → ระบบจะปิดพร้อมเพย์ SlipOK อัตโนมัติ (เงินเข้า wallet เดียวกัน) เปิดกลับได้ที่ตั้งค่าพร้อมเพย์',
            '<i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b;"></i>',
            submit,
            'ตกลง',
            'btn-primary'
          );
        } else {
          await submit();
        }
      };

      // consent popup — first time only
      if (!kycConfirmed) {
        const agree = document.getElementById('webhookConsentAgree');
        if (agree) agree.checked = false;
        openModal(consentModal);
        const acceptBtn = document.getElementById('btnAcceptWebhookConsent');
        const onAccept = async () => {
          if (!agree?.checked) {
            showNotification('กรุณาติ๊กยอมรับเงื่อนไขก่อน', 'error');
            return;
          }
          acceptBtn?.removeEventListener('click', onAccept);
          closeModal(consentModal);
          payload.consented = true; // set เฉพาะหลัง user ยอมรับจริง (F-01)
          await runWithConflictConfirm();
        };
        acceptBtn?.addEventListener('click', onAccept);
      } else {
        await runWithConflictConfirm();
      }
    });
  }

  // consent modal close handlers
  document.getElementById('btnCloseWebhookConsent')?.addEventListener('click', () => closeModal(consentModal));
  document.getElementById('btnCancelWebhookConsent')?.addEventListener('click', () => closeModal(consentModal));
  consentModal?.addEventListener('click', e => { if (e.target === consentModal) closeModal(consentModal); });

  // ---- ต่ออายุ ----
  if (btnRenew) {
    btnRenew.addEventListener('click', () => {
      if (!isMobile()) {
        showNotification('แนะนำให้กดต่ออายุในมือถือ — เปิดแอพ TrueMoney หน้า บริการ Webhook และ API', 'error');
      }
      window.open(TMN_LINK, '_blank', 'noopener');
    });
  }

  // ---- ตัดการเชื่อมต่อ ----
  if (btnDisconnect) {
    btnDisconnect.addEventListener('click', () => {
      showConfirmModal(
        'ตัดการเชื่อมต่อ TrueMoney Webhook',
        'ระบบจะปิด Webhook ฝั่ง TipKub และเปิดหน้าจัดการในแอพ TrueMoney ให้คุณ revoke การเชื่อมต่อ (หน้าเดียวกับต่ออายุ)',
        '<i class="fa-solid fa-link-slash" style="color:#ef4444;"></i>',
        async () => {
          try {
            const res = await fetchWithCsrf('/api/truemoney/setup-webhook', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'disable' })
            });
            const data = await res.json();
            if (res.ok && data.success) {
              showNotification('ตัดการเชื่อมต่อแล้ว — ระบบกลับไปใช้สลิป SlipOK', 'success');
              window.open(TMN_LINK, '_blank', 'noopener');
              await loadPaymentSettings();
            } else {
              showNotification(data.error || 'ตัดการเชื่อมต่อไม่สำเร็จ', 'error');
            }
          } catch (err) {
            showNotification(err.message || 'ตัดการเชื่อมต่อไม่สำเร็จ', 'error');
          }
        },
        'ตัดการเชื่อมต่อ',
        'btn-danger'
      );
    });
  }
}

async function loadPaymentSettings() {
  showTabLoading('payment-setup');
  try {
    const response = await fetch('/api/payment/settings');
    if (!response.ok) {
      window._lastPaymentSettings = {};

      // No settings yet (404) or auth issue — show SlipOK setup panel so user can configure
      updateSlipOkStatus(false, null);
      return;
    }
    const data = await response.json();
    window._lastPaymentSettings = data || {};

    // ไม่ auto-select — โหลดสถานะจาก database
    document.querySelectorAll('.payment-method-card').forEach(c => c.classList.remove('active'));

    const promptpayCard = document.getElementById('cardPromptPay');
    const truemoneyCard = document.getElementById('cardTrueMoney');

    if (data.promptpay_enabled && promptpayCard) {
      promptpayCard.classList.add('active');
    }
    if (data.truemoney_enabled && truemoneyCard) {
      truemoneyCard.classList.add('active');
    }

    updateSaveButton();

    // Fill PromptPay fields
    const promptpayType = document.getElementById('inputPromptPayType');
    const promptpayInput = document.getElementById('inputPromptPay');
    if (promptpayType) promptpayType.value = data.promptpay_type || 'phone';
    if (promptpayType) promptpayType.dispatchEvent(new Event('change', { bubbles: true }));
    if (promptpayInput) promptpayInput.value = data.promptpay_value || '';
    updatePromptPayPlaceholder();

    // Fill SlipOK fields (PromptPay)
    const slipOkApi = document.getElementById('inputSlipOkApi');
    const slipOkApiKey = document.getElementById('inputSlipOkApiKey');
    if (slipOkApi) slipOkApi.value = data.slipok_api || '';
    if (slipOkApiKey) slipOkApiKey.value = data.slipok_api_key || '';

    // SlipOK connection status
    updateSlipOkStatus(data.slipok_connected, data.slipok_last_check);

    // Fill TrueMoney fields
    const trueMoneyPhone = document.getElementById('inputTrueMoneyPhone');
    if (trueMoneyPhone) trueMoneyPhone.value = data.truemoney_phone || '';

    // Bank Account fields
    const bankName = document.getElementById('inputBankName');
    const bankAccountNumber = document.getElementById('inputBankAccountNumber');
    const bankAccountName = document.getElementById('inputBankAccountName');
    if (bankName) { bankName.value = data.bank_name || ''; bankName.dispatchEvent(new Event('change', { bubbles: true })); }
    if (bankAccountNumber) bankAccountNumber.value = data.bank_account_number || '';
    if (bankAccountName) bankAccountName.value = data.bank_account_name || '';

    const bankCard = document.getElementById('cardBank');
    if (data.bank_enabled && bankCard) bankCard.classList.add('active');

    renderTrueMoneyWebhookState(data);
    updateAccountVerifyBadges();

    if (data.slipok_connected) fetchQuotaMini('promptpay');
  } catch (err) {
    console.error('Load payment settings error:', err);
    tabLoaded['payment-setup'] = false;
    updateSlipOkStatus(false, null);
  } finally {
    hideTabLoading('payment-setup');
  }
}

// Part 3 — account verification gate helpers
function isMethodAccountVerified(method) {
  const d = window._lastPaymentSettings || {};
  if (method === 'truemoney') return !!(d.truemoney_account_verified || d.truemoney_webhook_enabled);
  if (method === 'bank') return !!d.bank_account_verified;
  if (method === 'promptpay') return !!d.promptpay_account_verified;
  return true;
}

// เชื่อมต่อ API สำเร็จ = verified ทันที (ความรับผิดชอบของ streamer เองว่าเพิ่มบัญชีตรงกันใน
// SlipOK แล้ว) กลับเป็น unverified เฉพาะตอนเปลี่ยนข้อมูลบัญชี (payment/settings reset-on-change)
// — ต้องกด "ทดสอบการเชื่อมต่อ" ใหม่เพื่อให้กลับมา verified
const ACCOUNT_UNVERIFIED_TEXT = {
  promptpay: 'ข้อมูลบัญชีพร้อมเพย์เปลี่ยนไปหลังยืนยันล่าสุด — หากมั่นใจว่าเพิ่มบัญชีนี้ตรงกันใน SlipOK แล้ว เพื่อความปลอดภัย กรุณากด "ทดสอบการเชื่อมต่อ" ของ API อีกครั้ง',
  bank: 'ข้อมูลบัญชีธนาคารเปลี่ยนไปหลังยืนยันล่าสุด — หากมั่นใจว่าเพิ่มบัญชีนี้ตรงกันใน SlipOK แล้ว เพื่อความปลอดภัย กรุณากด "ทดสอบการเชื่อมต่อ" ของ API อีกครั้ง',
  truemoney: 'ข้อมูลบัญชี TrueMoney เปลี่ยนไปหลังยืนยันล่าสุด — หากมั่นใจว่าเพิ่มบัญชีนี้ตรงกันใน SlipOK แล้ว เพื่อความปลอดภัย กรุณากด "ทดสอบการเชื่อมต่อ" ของ API อีกครั้ง'
};

function updateAccountVerifyBadges() {
  const d = window._lastPaymentSettings || {};
  document.querySelectorAll('.slipok-linked-note[data-method]').forEach(note => {
    const method = note.getAttribute('data-method');
    const verified = isMethodAccountVerified(method);
    note.setAttribute('data-verify-state', verified ? 'verified' : 'unverified');
    const text = note.querySelector('.verify-text');
    const caveat = note.querySelector('.verify-caveat');
    const testBtn = note.querySelector('.slipok-test-link');
    if (verified) {
      const at = d[`${method}_account_verified_at`];
      let dateStr = '-';
      try { if (at) dateStr = new Date(at).toLocaleString('th-TH'); } catch (e) {}
      if (text) text.textContent = `เชื่อมต่อ SlipOK สำเร็จ (ล่าสุด: ${dateStr})`;
      if (caveat) caveat.textContent = '⚠️ ข้อมูลบัญชีต้องตรงกับเว็บ SlipOK เสมอ — เป็นความรับผิดชอบของคุณเองที่ต้องตรวจสอบ หากเปลี่ยนข้อมูลบัญชีในภายหลัง ต้องกด "ทดสอบการเชื่อมต่อ" ใหม่อีกครั้ง';
    } else {
      if (text) text.textContent = ACCOUNT_UNVERIFIED_TEXT[method] || 'ยังไม่ได้ทดสอบการเชื่อมต่อ SlipOK';
      if (caveat) caveat.textContent = '';
    }
    if (testBtn) {
      // visible เฉพาะ unverified
      testBtn.style.display = verified ? 'none' : '';
    }
  });
}

function updateSlipOkStatus(connected, lastCheck) {
  const container = document.getElementById('slipokStatusContainer');
  const status = document.getElementById('slipokStatus');
  const title = document.getElementById('slipokStatusTitle');
  const desc = document.getElementById('slipokStatusDesc');
  const apiNotice = document.getElementById('promptpayApiNotice');

  if (!container || !status) return;
  container.style.display = 'block';

  if (connected) {
    status.className = 'tfp-status connected';
    if (title) title.textContent = 'เชื่อมต่อแล้ว';
    if (desc) desc.textContent = lastCheck ? `เช็คล่าสุด: ${new Date(lastCheck).toLocaleString('th-TH')}` : 'เชื่อมต่อ SlipOK สำเร็จ';

    // Fade out api-notice only
    if (apiNotice) apiNotice.classList.add('fade-out');
  } else {
    status.className = 'tfp-status disconnected';
    if (title) title.textContent = lastCheck ? 'เชื่อมต่อไม่สำเร็จ' : 'ยังไม่ได้เชื่อมต่อ';
    if (desc) desc.textContent = lastCheck ? `เช็คล่าสุด: ${new Date(lastCheck).toLocaleString('th-TH')}` : 'กรุณากรอก API และ API Key แล้วทดสอบการเชื่อมต่อ';

    // Fade in api-notice
    if (apiNotice) apiNotice.classList.remove('fade-out');
  }

  // PW-2: header icon + badge
  const headerIcon = document.getElementById('slipokHeaderIcon');
  const headerBadge = document.getElementById('slipokHeaderBadge');
  if (connected) {
    if (headerIcon) { headerIcon.className = 'fa-solid fa-circle-check'; headerIcon.style.color = '#4ade80'; }
    if (headerBadge) {
      headerBadge.style.display = 'inline-block';
      headerBadge.className = 'slipok-header-badge connected';
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-circle-check';
      headerBadge.replaceChildren(icon, document.createTextNode(' เชื่อมต่อแล้ว'));
    }
  } else {
    if (headerIcon) { headerIcon.className = 'fa-solid fa-triangle-exclamation'; headerIcon.style.color = '#f59e0b'; }
    if (headerBadge) {
      headerBadge.style.display = 'inline-block';
      headerBadge.className = 'slipok-header-badge attention';
      const apiVal = document.getElementById('inputSlipOkApi')?.value.trim();
      const msg = !apiVal ? 'ยังไม่เชื่อม API' : (lastCheck ? 'เชื่อมต่อไม่ได้' : 'ยังไม่ได้ทดสอบ');
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-triangle-exclamation';
      headerBadge.replaceChildren(icon, document.createTextNode(' ' + msg));
    }
  }

  // PW-3: disconnected → open panel for editing; connected → collapse
  // ต้อง sync ทั้ง class และ inline display เพราะ initCardPanels/toggleCardPanel คุมด้วย inline style
  const slipokPanel = document.getElementById('panelSlipOkUnified');
  const slipokCard = slipokPanel?.closest('.settings-card');
  if (slipokCard && slipokPanel) {
    slipokCard.classList.toggle('panel-open', !connected);
    slipokPanel.style.display = connected ? 'none' : 'block';
  }
}


async function testSlipOkConnection(method) {
  const api = document.getElementById('inputSlipOkApi')?.value.trim();
  const apiKey = document.getElementById('inputSlipOkApiKey')?.value.trim();

  if (!api || !apiKey) {
    showNotification('กรุณากรอก SlipOK API และ API Key', 'error');
    return;
  }

  const btn = document.getElementById('btnTestSlipOk');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> กำลังทดสอบ...';
  }

  try {
    const payload = {
      method: method || 'promptpay',
      slipok_api: api,
      slipok_api_key: apiKey,
      promptpay_type: document.getElementById('inputPromptPayType')?.value || 'phone',
      promptpay_value: document.getElementById('inputPromptPay')?.value.trim() || '',
      truemoney_phone: document.getElementById('inputTrueMoneyPhone')?.value.trim() || ''
    };

    const response = await fetchWithCsrf('/api/payment/test-slipok', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data.success) {
      showNotification('เชื่อมต่อ SlipOK สำเร็จ — บันทึกข้อมูลเรียบร้อย');
      const now = new Date().toISOString();
      updateSlipOkStatus(true, now);

      // เชื่อมต่อสำเร็จ = verified ทันทีทั้ง 3 วิธี (promptpay/bank/truemoney ใช้ API เดียวกัน)
      window._lastPaymentSettings = window._lastPaymentSettings || {};
      ['promptpay', 'bank', 'truemoney'].forEach(method => {
        window._lastPaymentSettings[`${method}_account_verified`] = 1;
        window._lastPaymentSettings[`${method}_account_verified_at`] = now;
      });
      updateAccountVerifyBadges();

      fetchQuotaMini('promptpay', true);
      // Reconnect dashboard stat card + refresh quota numbers
      renderSlipokDashCard(true);
      fetchSlipokDashQuota();
    } else {
      showNotification((data.error || 'เชื่อมต่อ SlipOK ไม่สำเร็จ'), 'error');
      // Auto-disconnect UI (server already sets slipok_connected=0)
      updateSlipOkStatus(false, new Date().toISOString());
      renderSlipokDashCard(false, 'error');
    }
  } catch (err) {
    showNotification('เกิดข้อผิดพลาดในการเชื่อมต่อ SlipOK', 'error');
    updateSlipOkStatus(false, new Date().toISOString());
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> ทดสอบการเชื่อมต่อ';
    }
  }
}


async function savePaymentSettings() {
  // Validate ก่อนบันทึก
  const validation = validatePromptPaySettings();
  if (!validation.valid) {
    showNotification('กรุณากรอกข้อมูลให้ครบ: ' + validation.errors.join(', '), 'error');
    return;
  }

  const promptpayCard = document.getElementById('cardPromptPay');
  const truemoneyCard = document.getElementById('cardTrueMoney');
  const bankCard = document.getElementById('cardBank');

  const api = document.getElementById('inputSlipOkApi')?.value.trim() || '';
  const apiKey = document.getElementById('inputSlipOkApiKey')?.value.trim() || '';

  const payload = {
    promptpay_enabled: promptpayCard?.classList.contains('active') || false,
    promptpay_type: document.getElementById('inputPromptPayType')?.value || 'phone',
    promptpay_value: document.getElementById('inputPromptPay')?.value.trim() || '',
    slipok_api: api,
    slipok_api_key: apiKey,
    truemoney_enabled: truemoneyCard?.classList.contains('active') || false,
    truemoney_phone: document.getElementById('inputTrueMoneyPhone')?.value.trim() || '',
    truemoney_slipok_api: api,
    truemoney_slipok_api_key: apiKey,
    bank_enabled: bankCard?.classList.contains('active') || false,
    bank_name: document.getElementById('inputBankName')?.value || '',
    bank_account_number: document.getElementById('inputBankAccountNumber')?.value.trim() || '',
    bank_account_name: document.getElementById('inputBankAccountName')?.value.trim() || ''
  };

  try {
    const response = await fetchWithCsrf('/api/payment/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      showNotification('บันทึกการตั้งค่าการรับเงินสำเร็จ');
      // Reload — server may have reset an account_verified flag (account value changed)
      // or rejected an enable transition (guard); either way, badges/toggles must reflect it.
      await loadPaymentSettings();
    } else {
      const err = await response.json();
      throw new Error(err.error || 'บันทึกไม่สำเร็จ');
    }
  } catch (err) {
    showNotification(err.message, 'error');
  }
}

// ========== Connection Disconnect ==========

function disconnectPlatform(platform, iconEl) {
  const name = platform === 'twitch' ? 'Twitch' : 'Streamlabs';

  showConfirmModal(
    `ยกเลิกการเชื่อมต่อ ${name}`,
    `ต้องการยกเลิกการเชื่อมต่อ ${name} ใช่หรือไม่? สามารถเชื่อมต่อใหม่ได้ตลอดเวลา`,
    '<i class="fa-solid fa-link-slash" style="color:#ef4444;"></i>',
    async () => {
      const savedClass = iconEl.className;
      const savedColor = iconEl.style.color;
      iconEl.className = 'fa-solid fa-spinner fa-spin btn-disconnect';
      iconEl.style.color = '#94a3b8';
      iconEl.style.pointerEvents = 'none';

      try {
        const response = await fetchWithCsrf('/api/connections/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform })
        });
        const data = await response.json();

        if (response.ok && data.success) {
          showNotification(`ยกเลิกการเชื่อมต่อ ${name} สำเร็จ`, 'success');
          tabLoaded['account'] = false;
          loadAccountInfo();
        } else {
          showNotification(data.error || `ไม่สามารถยกเลิกการเชื่อมต่อ ${name} ได้`, 'error');
          iconEl.className = savedClass;
          iconEl.style.color = savedColor;
          iconEl.style.pointerEvents = '';
        }
      } catch (err) {
        console.error(`[Disconnect] Error disconnecting ${platform}:`, err);
        showNotification(`เกิดข้อผิดพลาดในการยกเลิกการเชื่อมต่อ ${name}`, 'error');
        iconEl.className = savedClass;
        iconEl.style.color = savedColor;
        iconEl.style.pointerEvents = '';
      }
    },
    'ยกเลิกการเชื่อมต่อ',
    'btn-danger'
  );
}

document.getElementById('btnDisconnectTwitch')?.addEventListener('click', function() {
  disconnectPlatform('twitch', this);
});
document.getElementById('btnDisconnectStreamlabs')?.addEventListener('click', function() {
  disconnectPlatform('streamlabs', this);
});

// ========== Feedback Tab ==========
function initFeedbackTab() {
  const btn = document.getElementById('btnSendFeedback');
  const textarea = document.getElementById('feedbackMessage');
  const charCount = document.getElementById('feedbackCharCount');
  const statusEl = document.getElementById('feedbackStatus');

  textarea.addEventListener('input', () => {
    charCount.textContent = textarea.value.length;
  });

  btn.addEventListener('click', () => {
    const type = document.getElementById('feedbackType').value;
    const message = textarea.value.trim();

    if (message.length < 10) {
      showFeedbackStatus('กรุณากรอกรายละเอียดอย่างน้อย 10 ตัวอักษร', 'error');
      return;
    }

    const typeLabel = { idea: 'ไอเดีย / Feature ใหม่', bug: 'รายงานบัค / ปัญหา', ux: 'ปรับปรุง UI/UX', question: 'คำถาม / ขอความช่วยเหลือ' };
    const preview = message.length > 80 ? message.slice(0, 80) + '…' : message;

    showConfirmModal(
      '<i class="fa-brands fa-discord" style="color:#5865f2;margin-right:8px;"></i>ยืนยันการส่ง Feedback',
      `ประเภท: ${typeLabel[type]}\n\n"${preview}"\n\nข้อความนี้จะถูกส่งตรงถึงนักพัฒนาผ่าน Discord — ไม่แสดงต่อสาธารณะ`,
      '<i class="fa-solid fa-paper-plane" style="color:#fb923c;"></i>',
      async () => {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังส่ง...';
        try {
          const res = await fetchWithCsrf('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, message }),
          });
          const data = await res.json();
          if (res.ok) {
            showFeedbackStatus('ส่ง Feedback สำเร็จ! ขอบคุณที่ช่วยพัฒนา TipKub 🙏', 'success');
            textarea.value = '';
            charCount.textContent = '0';
          } else {
            showFeedbackStatus(data.error || 'เกิดข้อผิดพลาด กรุณาลองใหม่', 'error');
          }
        } catch {
          showFeedbackStatus('เชื่อมต่อไม่ได้ กรุณาลองใหม่ภายหลัง', 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> ส่ง Feedback';
        }
      },
      'ส่ง Feedback',
      'btn-primary'
    );
  });

  function showFeedbackStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = `feedback-status ${type}`;
    statusEl.style.display = 'block';
    setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
  }
}