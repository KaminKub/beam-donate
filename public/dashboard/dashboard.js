// ========== DOM Elements & Global State ==========
let allTransactions = [];
let activeTab = 'dashboard';

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
          const indicator = document.getElementById('overlayStatusIndicator');
          const text = document.getElementById('overlayStatusText');
          
          if (indicator && text) {
            if (active) {
              indicator.className = 'status-indicator online';
              text.textContent = 'ออนไลน์ (Active)';
              text.style.color = 'var(--success)';
            } else {
              indicator.className = 'status-indicator offline';
              text.textContent = 'ออฟไลน์ (Inactive)';
              text.style.color = 'var(--text-muted)';
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
        toggleProfanitySettings(chkProfanity.checked);
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
    'account': { title: 'User Account', subtitle: 'จัดการข้อมูลส่วนตัวและความปลอดภัยของบัญชี' }
  };


  if (titles[tabId]) {
    document.getElementById('tabTitle').textContent = titles[tabId].title;
    document.getElementById('tabSubtitle').textContent = titles[tabId].subtitle;
  }

  // Action based on tab entry
  if (tabId === 'dashboard' || tabId === 'transactions') {
    fetchTransactions();
  }
  if (tabId === 'account') {
    loadAccountInfo();
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

function showConfirmModal(title, text, icon = '⚠️', onConfirm = null) {
  confirmTitle.textContent = title;
  confirmText.textContent = text;
  confirmIcon.textContent = icon;
  currentConfirmAction = onConfirm;
  
  confirmModal.style.display = 'flex';
}

function hideConfirmModal() {
  confirmModal.style.display = 'none';
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
      // Handle Streamlabs Connection
      updateConnectionBtn('btnConnectStreamlabs', data.streamlabsId, '/auth/streamlabs', 'statusStreamlabs');

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
            const response = await fetch('/api/user/delete', { method: 'DELETE' });
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
    const nameMatch = (t.donor || '').toLowerCase().includes(searchQuery);
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
    
    let actionsHtml = `
      <button class="btn btn-secondary btn-sm" onclick="inspectTransaction('${t.id}')">🔍 Raw</button>
      <button class="btn btn-primary btn-sm" onclick="simulateTransactionAlert('${t.id}')">🎉 Test Alert</button>
    `;

    if (t.status === 'pending') {
      actionsHtml += `
        <button class="btn btn-primary btn-sm" style="background:var(--success);box-shadow:none;" onclick="forceSuccessTransaction('${t.id}')">✔️ Force Pay</button>
      `;
    }

    tr.innerHTML = `
      <td>${date}</td>
      <td style="font-family: monospace; font-size: 11px;">${t.id}</td>
      <td style="font-weight: 600; color: #818cf8;">฿${(Number(t.amount) || 0).toLocaleString()}</td>
      <td style="font-weight: 500;">${escapeHtml(t.donor || 'Anonymous')}</td>
      <td class="text-muted" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.message || '-')}</td>
      <td><span class="badge ${getStatusBadgeClass(t.status)}">${t.status}</span></td>
      <td>${actionsHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ========== Transactions Logic ==========
async function forceSuccessTransaction(id) {
  if (!confirm('ยืนยันการเปลี่ยนสถานะเป็น "ชำระเงินสำเร็จ"? (จะมีการส่ง Alert ไปยัง Overlay)')) return;
  
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
  alert(JSON.stringify(tx, null, 2));
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
function toggleProfanitySettings(isEnabled) {
  const container = document.getElementById('profanitySubSettingsContainer');
  if (!container) return;
  container.style.display = isEnabled ? 'block' : 'none';
}

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
    const res = await fetch('/api/overlay/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showNotification('💾 บันทึกสำเร็จ!🎉');
    }
  } catch (err) {
    showNotification('❌ ไม่สามารถบันทึกการตั้งค่าได้', 'error');
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
  if (sourceInput) {
    settings.profile_image_source = sourceInput.value;
  }

  try {
    const response = await fetch('/api/page/settings', {
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
    case 'pending': return 'badge-warning';
    case 'failed': return 'badge-danger';
    default: return 'badge-secondary';
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