// ========== DOM Elements & Global State ==========
let allTransactions = [];
let activeTab = 'dashboard';
let _csrfToken = null;

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
  
  const icon = type === 'success' ? '✅' : '❌';
  notification.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  
  container.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('fade-out');
    notification.addEventListener('animationend', () => notification.remove());
  }, 5000);
}

async function initializeDashboard() {
  console.log('🚀 Starting initializeDashboard...');
  try {
    // 1. Data Load
    console.log('📡 Triggering data loads...');
    fetchTransactions();
    loadPageSettings().catch(err => console.error('Initial settings load failed:', err));

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

    const btnApplyProfile = document.getElementById('btnApplyProfile');
    if (btnApplyProfile) {
      btnApplyProfile.onclick = () => {
        const val = document.getElementById('profileImageValue');
        if (val && val.value) {
          document.getElementById('profilePreview').src = val.value;
          document.getElementById('brandLogoImg').src = val.value;
          showNotification('อัปเดตพรีวิวรูปภาพแล้ว');
        }
      };
    }

    const btnReloadPage = document.getElementById('btnReloadPagePreview');
    if (btnReloadPage) {
      btnReloadPage.onclick = updatePagePreview;
    }

    const btnQuickAlert = document.getElementById('btnQuickTestAlert');
    if (btnQuickAlert) btnQuickAlert.onclick = triggerRandomTestAlert;
    
    const btnQuickAlertMobile = document.getElementById('btnQuickTestAlertMobile');
    if (btnQuickAlertMobile) btnQuickAlertMobile.onclick = triggerRandomTestAlert;

    const btnReloadPreview = document.getElementById('btnReloadPreview');
    if (btnReloadPreview) {
      btnReloadPreview.onclick = () => {
        const iframe = document.getElementById('overlayPreviewIframe');
        if (iframe) iframe.src = iframe.src;
      };
    }

    // Slider Real-time Updates
    const sliders = [
      { id: 'sliderDuration', lbl: 'lblDuration', fn: v => v },
      { id: 'sliderParticles', lbl: 'lblParticles', fn: v => v },
      { id: 'sliderFontSize', lbl: 'lblFontSize', fn: v => v },
      { id: 'sliderSoundVolume', lbl: 'lblSoundVolume', fn: v => Math.round(v * 100) },
      { id: 'sliderTtsVolume', lbl: 'lblTtsVolume', fn: v => Math.round(v * 100) },
      { id: 'sliderTtsRate', lbl: 'lblTtsRate', fn: v => Number(v).toFixed(1) },
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

    const btnBrowseSounds = document.getElementById('btnBrowseSounds');
    if (btnBrowseSounds) {
      btnBrowseSounds.onclick = openSoundBrowser;
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

    async function updateObsUrl() {
      try {
        console.log('🔑 Requesting OBS token...');
        const response = await fetch('/api/overlay/token');
        if (response.ok) {
          const { token } = await response.json();
          const urlInput = document.getElementById('obsOverlayUrl');
          if (urlInput) {
            const host = window.location.origin;
            urlInput.value = `${host}/overlay?token=${token}`;
          }
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
    loadOverlaySettings();

    document.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const tab = e.currentTarget.getAttribute('data-tab');
        switchTab(tab);
      });
    });

    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
      // Color picker visibility is now always enabled
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

    // SlipOK Test buttons
    const btnTestSlipOk = document.getElementById('btnTestSlipOk');
    if (btnTestSlipOk) {
      btnTestSlipOk.onclick = testSlipOkConnection;
    }

    const btnTestTrueMoneySlipOk = document.getElementById('btnTestTrueMoneySlipOk');
    if (btnTestTrueMoneySlipOk) {
      btnTestTrueMoneySlipOk.onclick = testTrueMoneySlipOkConnection;
    }

    const btnSyncSlipOk = document.getElementById('btnSyncSlipOkFromPromptPay');
    if (btnSyncSlipOk) {
      btnSyncSlipOk.onclick = syncSlipOkFromPromptPay;
    }

    if (btnSavePayment) {
      btnSavePayment.onclick = savePaymentSettings;
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

// ========== Navigation (Tab Switching) ==========
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
    'overlay-config': { title: 'Overlay Live Settings', subtitle: 'ปรับแต่งดีไซน์ รูปแบบ เสียง และข้อความเตือนของ OBS Stream' },
    'page-customization': { title: 'Page Customization', subtitle: 'ปรับแต่งหน้าโดเนท โปรไฟล์ และลิงก์โซเชียลมีเดีย' },
    'account': { title: 'User Account', subtitle: 'จัดการข้อมูลส่วนตัวและความปลอดภัยของบัญชี' },
    'payment-setup': { title: 'Payment Setup', subtitle: 'ตั้งค่าวิธีรับเงินบริจาคจากผู้ชม' }
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
    loadOverlaySettings();
  }
  if (tabId === 'page-customization') {
    loadPageSettings();
  }
  if (tabId === 'account') {
    loadAccountInfo();
  }
  if (tabId === 'payment-setup') {
    loadPaymentSettings();
  }
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

function showConfirmModal(title, text, icon = '⚠️', onConfirm = null, btnText = 'ยืนยัน', btnClass = 'btn-danger') {
  confirmTitle.textContent = title;
  confirmText.textContent = text;
  confirmIcon.textContent = icon;
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

async function loadAccountInfo() {
  try {
    const response = await fetch('/api/user/me');
    if (response.ok) {
      const data = await response.json();
      document.getElementById('accUsername').textContent = data.username;

      // Handle Twitch Connection
      updateConnectionBtn('btnConnectTwitch', data.twitchId, '/auth/twitch', 'statusTwitch');
      // Handle Streamlabs Connection (TEMPORARILY DISABLED - OAuth config pending)
      const slBtn = document.getElementById('btnConnectStreamlabs');
      const slStatus = document.getElementById('statusStreamlabs');
      if (slBtn) {
        slBtn.innerHTML = 'รออัปเดต';
        slBtn.classList.add('btn-disconnected');
        slBtn.style.pointerEvents = 'none';
        slBtn.onclick = null;
      }
      if (slStatus) slStatus.textContent = 'รออัปเดต';

    } else {
      throw new Error('Failed to load account info');
    }
  } catch (err) {
    console.error('Error loading account info:', err);
    document.getElementById('accUsername').textContent = 'Error';
  }
}

function updateConnectionBtn(id, connected, authUrl, statusId) {
  const btn = document.getElementById(id);
  if (!btn) return;

  const row = btn.closest('.connection-row');
  const statusEl = statusId ? document.getElementById(statusId) : null;

  if (connected) {
    btn.innerHTML = 'เชื่อมต่อแล้ว';
    btn.classList.add('btn-connected');
    btn.classList.remove('btn-disconnected');
    if (row) row.classList.add('is-connected');
    if (statusEl) {
      statusEl.textContent = 'เชื่อมต่อแล้ว';
      statusEl.classList.add('connected');
    }
    btn.onclick = null;
  } else {
    btn.innerHTML = 'เชื่อมต่อ';
    btn.classList.remove('btn-connected');
    btn.classList.add('btn-disconnected');
    if (row) row.classList.remove('is-connected');
    if (statusEl) {
      statusEl.textContent = 'ยังไม่ได้เชื่อมต่อ';
      statusEl.classList.remove('connected');
    }
    btn.onclick = () => window.location.href = authUrl;
  }
}

async function handleAccountDeletion() {
  // Step 1: First confirmation
  showConfirmModal(
    '⚠️ ลบบัญชีถาวร', 
    'คุณต้องการลบข้อมูลทั้งหมดของบัญชีนี้หรือไม่? การดำเนินการนี้ไม่สามารถย้อนกลับได้', 
    '🗑️', 
    async () => {
      // Step 2: Second confirmation (Crucial)
      showConfirmModal(
        '🚨 ยืนยันอีกครั้ง!', 
        'คุณมั่นใจจริงๆ ใช่ไหมว่าต้องการลบข้อมูลทั้งหมด? ข้อมูลทุกอย่างจะหายไปตลอดกาล!', 
        '🔴', 
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
      this.select.style.display = 'none';
      this.select.insertAdjacentElement('beforebegin', wrapper);
      wrapper.appendChild(trigger);
      wrapper.appendChild(panel);

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
      this.panel.classList.add('open');
      this.trigger.classList.add('open');
      // Scroll selected into view
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

  // Global click-outside-to-close
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cs-wrapper')) {
      CustomSelect._closeAll();
    }
  });

  return { initAll };
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
    '👋 ออกจากระบบ', 
    'คุณต้องการออกจากระบบใช่หรือไม่?', 
    '🚪', 
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

  const totalCompleted = successCount + failedCount;
  const successRate = totalCompleted > 0 ? Math.round((successCount / totalCompleted) * 100) : 0;

  // Render to DOM
  document.getElementById('statTotalAmount').textContent = `฿${totalAmount.toLocaleString('th-TH')}`;
  document.getElementById('statSuccessCount').textContent = successCount.toLocaleString();
  document.getElementById('statSuccessRate').textContent = `${successRate}%`;
  document.getElementById('statPendingCount').textContent = `${pendingCount} / ${failedCount}`;
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
      <td><span class="badge ${getStatusBadgeClass(t.status)}">${t.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderFullTransactions(transactions) {
  const tbody = document.querySelector('#fullTransactionsTable tbody');
  tbody.innerHTML = '';

  const searchQuery = document.getElementById('inputSearchDonor').value.toLowerCase().trim();
  const filterStatus = document.getElementById('selectFilterStatus').value;

  const filtered = transactions.filter(t => {
    const nameMatch = (t.donor || '').toLowerCase().includes(searchQuery) || (t.id || '').toLowerCase().includes(searchQuery);
    const statusMatch = filterStatus === 'all' || t.status === filterStatus;
    return nameMatch && statusMatch;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">ไม่พบข้อมูลตรงตามเงื่อนไขที่เลือก</td></tr>`;
    return;
  }

  filtered.forEach(t => {
    const date = t.createdAt ? new Date(t.createdAt).toLocaleString('th-TH') : '-';
    const tr = document.createElement('tr');
    
    let actionsHtml = '<div class="action-buttons-grid">';
    actionsHtml += t.status === 'successful' 
      ? `<button class="btn btn-secondary btn-sm" onclick="inspectTransaction('${t.id}')">🔍 ดูรายละเอียด</button>`
      : '<div></div>';
    actionsHtml += `<button class="btn btn-primary btn-sm" onclick="simulateTransactionAlert('${t.id}')">🔔 ยิง Alert ซ้ำ</button>`;
    actionsHtml += t.status === 'pending'
      ? `<button class="btn btn-primary btn-sm" style="background:var(--success);box-shadow:none;" onclick="forceSuccessTransaction('${t.id}')" title="ยืนยันการชำระเงินด้วยตนเอง">✔ ยืนยัน</button>`
      : '<div></div>';
    actionsHtml += '</div>';

    tr.innerHTML = `
      <td>${date}</td>
      <td style="font-family: monospace; font-size: 11px;">${t.id}</td>
      <td style="font-weight: 500;">${escapeHtml(t.donor || 'Anonymous')}</td>
      <td style="font-weight: 600; color: #818cf8;">฿${(Number(t.amount) || 0).toLocaleString()}</td>
      <td class="text-muted" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.message || '-')}</td>
      <td><span class="badge ${getStatusBadgeClass(t.status)}">${t.status}</span></td>
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
    btn.textContent = '⏳ กำลังดาวน์โหลด...';

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
      btn.textContent = '📥 ดาวน์โหลด CSV';
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
    '✅ ยืนยันการชำระเงินด้วยตนเอง',
    `ระบบจะส่ง Alert และเปลี่ยนสถานะเป็นชำระสำเร็จ\n\nผู้โดเนท: ${donorName}\nจำนวน: ${amount}`,
    '💰',
    async () => {
      try {
        const response = await fetch(`/api/transactions/${id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'successful' })
        });
        
        if (response.ok) {
          fetchTransactions();
        } else {
          const err = await response.json();
          throw new Error(err.error || 'อัปเดตสถานะไม่สำเร็จ');
        }
      } catch (err) {
        // Notification removed as per request
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
    
    const response = await fetch('/api/alerts/test', {
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
  } catch (err) {
    // Notification removed as per request
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
    const res = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ donor, amount, message })
    });
    if (res.ok) {
      console.log('Fired test alert');
    }
  } catch (err) {
    console.error('Failed to trigger test alert:', err);
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
  const container = document.getElementById('customSoundUrlContainer');
  if (!container) return;
  container.style.display = choice === 'custom_url' ? 'block' : 'none';
}

function toggleProfanitySubSettings(enabled) {
  const container = document.getElementById('profanitySubSettingsContainer');
  if (!container) return;
  container.style.display = enabled ? 'block' : 'none';
}

async function loadOverlaySettings() {
  try {
    const response = await fetch('/api/overlay/settings');
    if (response.ok) {
      const s = await response.json();
      
      // Map to inputs
      document.getElementById('themeSelect').value = s.theme;
      document.getElementById('fontSelect').value = s.fontFamily;
      document.getElementById('animSelect').value = s.animation;
      
      // Color pickers
      document.getElementById('colorPrimary').value = s.primaryColor;
      document.getElementById('txtPrimary').value = s.primaryColor;
      document.getElementById('colorSecondary').value = s.secondaryColor;
      document.getElementById('txtSecondary').value = s.secondaryColor;
      document.getElementById('colorText').value = s.textColor;
      document.getElementById('txtText').value = s.textColor;
      
      // Background Hex or RGBA converter support
      document.getElementById('txtBg').value = s.backgroundColor;
      if (s.backgroundColor.startsWith('#')) {
        document.getElementById('colorBg').value = s.backgroundColor;
      }
 
      // Ranges
      document.getElementById('sliderDuration').value = s.duration;
      document.getElementById('lblDuration').textContent = s.duration;
 
      document.getElementById('sliderParticles').value = s.particleCount;
      document.getElementById('lblParticles').textContent = s.particleCount;
 
      document.getElementById('sliderFontSize').value = s.fontSize || 32;
      document.getElementById('lblFontSize').textContent = s.fontSize || 32;
 
       // Audio Checkboxes
       document.getElementById('chkSoundEnabled').checked = s.soundEnabled;
       document.getElementById('soundChoiceSelect').value = s.soundChoice;
       toggleCustomSoundUrlContainer(s.soundChoice);
       document.getElementById('sliderSoundVolume').value = s.soundVolume;
       document.getElementById('lblSoundVolume').textContent = Math.round(s.soundVolume * 100);

 
      // TTS Checkboxes
      document.getElementById('chkTtsEnabled').checked = s.ttsEnabled;
      document.getElementById('chkTtsReadDonor').checked = s.ttsReadDonor !== undefined ? s.ttsReadDonor : true;
 
      document.getElementById('sliderTtsVolume').value = s.ttsVolume;
      document.getElementById('lblTtsVolume').textContent = Math.round(s.ttsVolume * 100);
      document.getElementById('sliderTtsRate').value = s.ttsRate;
      document.getElementById('lblTtsRate').textContent = s.ttsRate.toFixed(1);
 
      // Template Strings
      document.getElementById('inputMessageTemplate').value = s.messageTemplate;
      document.getElementById('inputAmountSuffix').value = s.amountSuffix || 'บาท';
      document.getElementById('chkShowLabel').checked = s.showLabel !== undefined ? s.showLabel : true;
       document.getElementById('chkShowDonorMessage').checked = s.showDonorMessage;
       document.getElementById('inputMinAmount').value = s.minAmount;
       
       // Custom Visuals
       document.getElementById('customImageMode').value = s.customImageMode || 'emoji';
       document.getElementById('customImageValue').value = s.customImageValue || '🎁';
       document.getElementById('customSoundUrl').value = s.customSoundUrl || '';
       
       // Profanity Filter
       document.getElementById('chkProfanityFilterEnabled').checked = s.profanityFilterEnabled;
       document.getElementById('profanityReplaceStyleSelect').value = s.profanityReplaceStyle || 'asterisks';
       document.getElementById('inputProfanityWords').value = s.profanityWords || '';

       // Notify CustomSelect wrappers by dispatching change events
       ['themeSelect', 'fontSelect', 'animSelect', 'soundChoiceSelect',
        'customImageMode', 'profanityReplaceStyleSelect'].forEach(id => {
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
  }
}

// Color picker bindings (Hex inputs <-> Color box picker)
const colorPickers = [
  { picker: 'colorPrimary', txt: 'txtPrimary' },
  { picker: 'colorSecondary', txt: 'txtSecondary' },
  { picker: 'colorText', txt: 'txtText' },
  { picker: 'colorBg', txt: 'txtBg' }
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

async function saveOverlaySettings() {
  const payload = {
    theme: document.getElementById('themeSelect').value,
    fontFamily: document.getElementById('fontSelect').value,
    animation: document.getElementById('animSelect').value,
    duration: parseInt(document.getElementById('sliderDuration').value),
     particleCount: parseInt(document.getElementById('sliderParticles').value),
     fontSize: parseInt(document.getElementById('sliderFontSize').value) || 32,
     customImageMode: document.getElementById('customImageMode').value,
     customImageValue: document.getElementById('customImageValue').value,
     
     primaryColor: document.getElementById('txtPrimary').value,
 
    secondaryColor: document.getElementById('txtSecondary').value,
    textColor: document.getElementById('txtText').value,
    backgroundColor: document.getElementById('txtBg').value,
    borderColor: hexToRgbA(document.getElementById('txtPrimary').value, 0.25),
    
     soundEnabled: document.getElementById('chkSoundEnabled').checked,
     soundChoice: document.getElementById('soundChoiceSelect').value,
     soundVolume: parseFloat(document.getElementById('sliderSoundVolume').value),
     customSoundUrl: document.getElementById('customSoundUrl').value,
     
     ttsEnabled: document.getElementById('chkTtsEnabled').checked,
     ttsReadDonor: document.getElementById('chkTtsReadDonor').checked,
     ttsLanguage: 'th-TH',
     ttsVolume: parseFloat(document.getElementById('sliderTtsVolume').value),
     ttsRate: parseFloat(document.getElementById('sliderTtsRate').value),
 
 
    messageTemplate: document.getElementById('inputMessageTemplate').value,
    amountSuffix: document.getElementById('inputAmountSuffix').value,
    showLabel: document.getElementById('chkShowLabel').checked,
    showDonorMessage: document.getElementById('chkShowDonorMessage').checked,
    minAmount: parseInt(document.getElementById('inputMinAmount').value) || 1,
    
    profanityFilterEnabled: document.getElementById('chkProfanityFilterEnabled').checked,
    profanityWords: document.getElementById('inputProfanityWords').value,
    profanityReplaceStyle: document.getElementById('profanityReplaceStyleSelect').value
  };
 
  try {
    const res = await fetchWithCsrf('/api/overlay/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showNotification('💾 บันทึกสำเร็จ!🎉');
    }
  } catch (err) {
    showNotification('ไม่สามารถบันทึกการตั้งค่าได้', 'error');
  }
}


function updateOverlayPreview(settings) {
  const iframe = document.getElementById('overlayPreviewIframe');
  if (!iframe) return;

  // Pass settings via URL fragment to avoid page reload or use postMessage
  const params = new URLSearchParams(settings).toString();
  iframe.src = `/overlay?preview=${encodeURIComponent(params)}`;
}

// ========== Page Customization Logic ==========
async function loadPageSettings() {
  try {
    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    if (!username) return;
    
    // Set Iframe SRC immediately to avoid redirect to dashboard
    const iframe = document.getElementById('pagePreviewIframe');
    if (iframe) {
        iframe.src = `/${username}`;
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

    // Update Preview
    document.getElementById('profilePreview').src = data.profileImage || '/avatar.jpg';
    document.getElementById('brandLogoImg').src = data.profileImage || '/avatar.jpg';
    
    if (data.profileGlowColor) {
      updateBrandGlow(data.profileGlowColor);
    }

    // For other previews, we rely on the iframe reload
    if (iframe) {

        iframe.src = iframe.src;
    }
    
  } catch (err) {
    console.error('Load page settings error:', err);
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

function parseRgba(rgba) {
  if (!rgba || !rgba.startsWith('rgba')) return { hex: '#ffffff', alpha: 1 };
  const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) return { hex: '#ffffff', alpha: 1 };
  
  const r = parseInt(match[1]).toString(16).padStart(2, '0');
  const g = parseInt(match[2]).toString(16).padStart(2, '0');
  const b = parseInt(match[3]).toString(16).padStart(2, '0');
  const a = match[4] ? parseFloat(match[4]) : 1;
  
  return { hex: `#${r}${g}${b}`, alpha: a };
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
    default: return 'badge-pending';
  }
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
let _soundBrowserOffset = 0;
let _soundBrowserLoading = false;
let _soundBrowserHasMore = true;
let _soundBrowserQuery = '';
let _soundBrowserPageId = 'th';
let _soundBrowserPages = ['th', 'global', 'us', 'jp', 'de', 'br', 'fr', 'uk'];
let _soundBrowserPageIndex = 0;

function openSoundBrowser() {
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
                onclick="previewSound(this)">▶️ เล่น</button>
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
        ⚠️ ไม่สามารถค้นหาอัตโนมัติได้กรุณาค้นหาด้วยวิธีนี้ <br>
        กดคลิกขวาที่ Download MP3 > Copy Link > วางลิงก์เสียง
      </div>
      <a href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener"
         style="display:inline-block;padding:10px 20px;background:var(--primary,#667eea);color:#fff;border-radius:8px;text-decoration:none;font-size:14px;margin-bottom:16px;">
        🔗 เปิด myinstants.com ค้นหาเสียง
      </a>
      <div style="display:flex;gap:8px;align-items:center;max-width:400px;margin:0 auto;">
        <input type="text" id="manualSoundUrl" class="form-control"
               placeholder="วาง URL เสียงจาก myinstants.com ที่นี่..."
               style="flex:1;font-size:13px;">
        <button class="btn btn-primary btn-sm" onclick="addManualSound()"
                style="white-space:nowrap;">➕ เพิ่ม</button>
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
            onclick="previewSound(this)">▶️ เล่น</button>
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

  btn.textContent = '⏳ โหลด...';
  btn.disabled = true;

  let hasError = false;
  let errorTimeout = null;

  try {
    // Play with caching (lazy load - only fetches on first play)
    const audio = await soundPlayer.play(url, { volume: 0.5 });
    
    btn.textContent = '⏸️ หยุด';
    btn.disabled = false;

    audio.onended = () => { 
      btn.textContent = '▶️ เล่น'; 
    };
    
    audio.onerror = () => { 
      // Delay error display to prevent flicker
      if (errorTimeout) clearTimeout(errorTimeout);
      errorTimeout = setTimeout(() => {
        if (soundPlayer.isPlaying()) return; // Still playing, ignore error
        btn.textContent = '❌ เล่นไม่ได้'; 
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
        btn.textContent = '▶️ เล่น';
      } else {
        soundPlayer.resume();
        btn.textContent = '⏸️ หยุด';
      }
    };
  } catch (err) {
    console.error('[previewSound] Failed to play:', url, err);
    
    // Delay error display to prevent flicker
    if (errorTimeout) clearTimeout(errorTimeout);
    errorTimeout = setTimeout(() => {
      btn.textContent = '❌ เล่นไม่ได้';
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
      
      btn.textContent = '⏸️ หยุด';
      btn.disabled = false;
      
      audio.onended = () => { btn.textContent = '▶️ เล่น'; };
      audio.onerror = () => { 
        if (errorTimeout) clearTimeout(errorTimeout);
        errorTimeout = setTimeout(() => {
          if (!audio.paused) return;
          btn.textContent = '❌ เล่นไม่ได้'; 
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
          btn.textContent = '▶️ เล่น';
        } else {
          audio.play();
          btn.textContent = '⏸️ หยุด';
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

  const input = document.getElementById('customSoundUrl');
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

function updateSettingsPanels() {
  // ฟังก์ชันนี้ไม่ใช้แล้ว เพราะใช้ independent toggle แทน
  // เก็บไว้เพื่อ backward compatibility
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
    phone: { placeholder: '081-234-5678', hint: 'กรุณากรอกเบอร์โทรศัพท์ที่ผูกกับบัญชีพร้อมเพย์', maxlength: 10 },
    idcard: { placeholder: '1-1001-00360-12-5', hint: 'กรุณากรอกเลขบัตรประจำตัวประชาชน', maxlength: 13 },
    ewallet: { placeholder: 'e-Wallet ID', hint: 'กรุณากรอก e-Wallet ID', maxlength: 15 }
  };

  const config = configs[type] || configs.phone;
  input.placeholder = config.placeholder;
  input.maxLength = config.maxlength;
  hint.textContent = config.hint;
}

function validatePromptPaySettings() {
  const errors = [];
  const promptpayCard = document.getElementById('cardPromptPay');
  
  if (promptpayCard?.classList.contains('active')) {
    const promptpayValue = document.getElementById('inputPromptPay')?.value.trim();
    const api = document.getElementById('inputSlipOkApi')?.value.trim();
    const apiKey = document.getElementById('inputSlipOkApiKey')?.value.trim();

    if (!promptpayValue) errors.push('ข้อมูลพร้อมเพย์');
    if (!api) errors.push('SlipOK API');
    if (!apiKey) errors.push('SlipOK API Key');

    // ไฮไลท์ฟิลด์ที่ยังไม่ได้กรอก
    ['inputPromptPay', 'inputSlipOkApi', 'inputSlipOkApiKey'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (!el.value.trim()) {
          el.style.borderColor = '#f87171';
          el.style.boxShadow = '0 0 0 3px rgba(248,113,113,0.2)';
        } else {
          el.style.borderColor = '';
          el.style.boxShadow = '';
        }
      }
    });
  }

  const truemoneyCard = document.getElementById('cardTrueMoney');
  if (truemoneyCard?.classList.contains('active')) {
    const phone = document.getElementById('inputTrueMoneyPhone')?.value.trim();
    const api = document.getElementById('inputTrueMoneyApi')?.value.trim();
    const apiKey = document.getElementById('inputTrueMoneyApiKey')?.value.trim();

    if (!phone) errors.push('เบอร์ TrueMoney');
    if (!api) errors.push('SlipOK API (TrueMoney)');
    if (!apiKey) errors.push('SlipOK API Key (TrueMoney)');

    ['inputTrueMoneyPhone', 'inputTrueMoneyApi', 'inputTrueMoneyApiKey'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        if (!el.value.trim()) {
          el.style.borderColor = '#f87171';
          el.style.boxShadow = '0 0 0 3px rgba(248,113,113,0.2)';
        } else {
          el.style.borderColor = '';
          el.style.boxShadow = '';
        }
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

async function loadPaymentSettings() {
  try {
    const response = await fetch('/api/payment/settings');
    if (!response.ok) return;
    const data = await response.json();

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
    const trueMoneyApi = document.getElementById('inputTrueMoneyApi');
    const trueMoneyApiKey = document.getElementById('inputTrueMoneyApiKey');
    if (trueMoneyPhone) trueMoneyPhone.value = data.truemoney_phone || '';
    if (trueMoneyApi) trueMoneyApi.value = data.truemoney_slipok_api || '';
    if (trueMoneyApiKey) trueMoneyApiKey.value = data.truemoney_slipok_api_key || '';

    updateTrueMoneySlipOkStatus(data.truemoney_slipok_connected, data.truemoney_slipok_last_check);
  } catch (err) {
    console.error('Load payment settings error:', err);
  }
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
}

function updateTrueMoneySlipOkStatus(connected, lastCheck) {
  const container = document.getElementById('trueMoneySlipOkStatusContainer');
  const status = document.getElementById('trueMoneySlipOkStatus');
  const title = document.getElementById('trueMoneySlipOkStatusTitle');
  const desc = document.getElementById('trueMoneySlipOkStatusDesc');
  const apiNotice = document.getElementById('truemoneyApiNotice');

  if (!container || !status) return;
  container.style.display = 'block';

  if (connected) {
    status.className = 'tfp-status connected';
    if (title) title.textContent = 'เชื่อมต่อแล้ว';
    if (desc) desc.textContent = lastCheck ? `เช็คล่าสุด: ${new Date(lastCheck).toLocaleString('th-TH')}` : 'เชื่อมต่อ SlipOK (TrueMoney) สำเร็จ';
    
    // Fade out api-notice only
    if (apiNotice) apiNotice.classList.add('fade-out');
  } else {
    status.className = 'tfp-status disconnected';
    if (title) title.textContent = lastCheck ? 'เชื่อมต่อไม่สำเร็จ' : 'ยังไม่ได้เชื่อมต่อ';
    if (desc) desc.textContent = lastCheck ? `เช็คล่าสุด: ${new Date(lastCheck).toLocaleString('th-TH')}` : 'กรุณากรอก API และ API Key แล้วทดสอบการเชื่อมต่อ';
    
    // Fade in api-notice
    if (apiNotice) apiNotice.classList.remove('fade-out');
  }
}

async function testSlipOkConnection() {
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
      slipok_api: api,
      slipok_api_key: apiKey,
      promptpay_type: document.getElementById('inputPromptPayType')?.value || 'phone',
      promptpay_value: document.getElementById('inputPromptPay')?.value.trim() || ''
    };

    const response = await fetch('/api/payment/test-slipok', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data.success) {
      showNotification('เชื่อมต่อ SlipOK สำเร็จ — บันทึกข้อมูลเรียบร้อย');
      updateSlipOkStatus(true, new Date().toISOString());
    } else {
      showNotification((data.error || 'เชื่อมต่อ SlipOK ไม่สำเร็จ'), 'error');
    }
  } catch (err) {
    showNotification('เกิดข้อผิดพลาดในการเชื่อมต่อ SlipOK', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> ทดสอบการเชื่อมต่อ';
    }
  }
}

async function testTrueMoneySlipOkConnection() {
  const api = document.getElementById('inputTrueMoneyApi')?.value.trim();
  const apiKey = document.getElementById('inputTrueMoneyApiKey')?.value.trim();

  if (!api || !apiKey) {
    showNotification('กรุณากรอก SlipOK API และ API Key สำหรับ TrueMoney', 'error');
    return;
  }

  const btn = document.getElementById('btnTestTrueMoneySlipOk');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> กำลังทดสอบ...';
  }

  try {
    const payload = {
      slipok_api: api,
      slipok_api_key: apiKey,
      method: 'truemoney',
      truemoney_phone: document.getElementById('inputTrueMoneyPhone')?.value.trim() || ''
    };

    const response = await fetch('/api/payment/test-slipok', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data.success) {
      showNotification('เชื่อมต่อ SlipOK (TrueMoney) สำเร็จ — บันทึกข้อมูลเรียบร้อย');
      updateTrueMoneySlipOkStatus(true, new Date().toISOString());
    } else {
      showNotification((data.error || 'เชื่อมต่อ SlipOK ไม่สำเร็จ'), 'error');
    }
  } catch (err) {
    showNotification('เกิดข้อผิดพลาดในการเชื่อมต่อ SlipOK', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plug"></i> ทดสอบการเชื่อมต่อ';
    }
  }
}

function syncSlipOkFromPromptPay() {
  const promptpayApi = document.getElementById('inputSlipOkApi')?.value.trim();
  const promptpayApiKey = document.getElementById('inputSlipOkApiKey')?.value.trim();

  if (!promptpayApi && !promptpayApiKey) {
    showNotification('ยังไม่ได้กรอก API ในส่วนพร้อมเพย์ — กรุณากรอกก่อนซิงค์', 'error');
    return;
  }

  if (promptpayApi.includes('*') || promptpayApiKey.includes('*')) {
    showNotification('ข้อมูล API ในพร้อมเพย์เป็นค่าเซนเซอร์ — กรุณากรอกใหม่ก่อนซิงค์', 'error');
    return;
  }

  const trueMoneyApi = document.getElementById('inputTrueMoneyApi');
  const trueMoneyApiKey = document.getElementById('inputTrueMoneyApiKey');

  if (trueMoneyApi) trueMoneyApi.value = promptpayApi;
  if (trueMoneyApiKey) trueMoneyApiKey.value = promptpayApiKey;

  showNotification('ดึงข้อมูล API จากพร้อมเพย์เรียบร้อย');
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

  const payload = {
    promptpay_enabled: promptpayCard?.classList.contains('active') || false,
    promptpay_type: document.getElementById('inputPromptPayType')?.value || 'phone',
    promptpay_value: document.getElementById('inputPromptPay')?.value.trim() || '',
    slipok_api: document.getElementById('inputSlipOkApi')?.value.trim() || '',
    slipok_api_key: document.getElementById('inputSlipOkApiKey')?.value.trim() || '',
    truemoney_enabled: truemoneyCard?.classList.contains('active') || false,
    truemoney_phone: document.getElementById('inputTrueMoneyPhone')?.value.trim() || '',
    truemoney_slipok_api: document.getElementById('inputTrueMoneyApi')?.value.trim() || '',
    truemoney_slipok_api_key: document.getElementById('inputTrueMoneyApiKey')?.value.trim() || ''
  };

  try {
    const response = await fetchWithCsrf('/api/payment/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      showNotification('💾 บันทึกการตั้งค่าการรับเงินสำเร็จ');
    } else {
      const err = await response.json();
      throw new Error(err.error || 'บันทึกไม่สำเร็จ');
    }
  } catch (err) {
    showNotification(err.message, 'error');
  }
}