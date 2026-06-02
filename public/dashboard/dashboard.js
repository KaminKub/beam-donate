// ========== DOM Elements & Global State ==========
let allTransactions = [];
let activeTab = 'dashboard';
let savedVoiceName = 'default';

// Populate dynamic speech voices dropdown (checks for Niwat, Premwadee, Achara support)
function populateVoiceList() {
  if (!('speechSynthesis' in window)) return;
  
  const voiceSelect = document.getElementById('ttsVoiceSelect');
  if (!voiceSelect) return;
  
  const hint = document.getElementById('ttsVoiceHint');
  const voices = window.speechSynthesis.getVoices();
  
  // Apply saved voice selection directly
  if (savedVoiceName) {
    voiceSelect.value = savedVoiceName;
  }
  
  // ตรวจสอบว่ามีเสียงพรีเมียม 3 ตัวที่ระบุอยู่ในเครื่องนี้หรือไม่
  const hasPremwadee = voices.some(v => v.name.toLowerCase().includes('premwadee'));
  const hasNiwat = voices.some(v => v.name.toLowerCase().includes('niwat'));
  const hasAchara = voices.some(v => v.name.toLowerCase().includes('achara'));
  
  if (hint) {
    if (voices.length === 0) {
      hint.textContent = '⚠️ กำลังตรวจสอบเสียงในเครื่อง... (โปรดรัน Chrome/Edge บน Windows เพื่อเสียงพรีเมียม)';
      return;
    }
    
    // แสดงสถานะเสียงอย่างสวยงาม
    let statusText = 'เอนจินเครื่อง: ';
    statusText += `เปรมวดี ${hasPremwadee ? '✅ พร้อมใช้' : '❌ ไม่มี'} | `;
    statusText += `นิวัต ${hasNiwat ? '✅ พร้อมใช้' : '❌ ไม่มี'} | `;
    statusText += `อัจฉรา ${hasAchara ? '✅ พร้อมใช้' : '❌ ไม่มี'}`;
    
    if (!hasPremwadee && !hasNiwat && !hasAchara) {
      statusText += ' (ใช้เสียง Google Cloud ให้อัตโนมัติ 🌟)';
    } else {
      statusText += ' (เลือกใช้เสียงพรีเมียมที่มีเครื่องหมาย ✅ ได้เลย)';
    }
    
    hint.textContent = statusText;
  }
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = populateVoiceList;
  // Trigger loading after a short timeout in case it doesn't fire immediately
  setTimeout(populateVoiceList, 400);
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
    'page-customization': { title: 'Page Customization', subtitle: 'ปรับแต่งหน้าโดเนท โปรไฟล์ และลิงก์โซเชียลมีเดีย' }
  };


  if (titles[tabId]) {
    document.getElementById('tabTitle').textContent = titles[tabId].title;
    document.getElementById('tabSubtitle').textContent = titles[tabId].subtitle;
  }

  // Action based on tab entry
  if (tabId === 'dashboard' || tabId === 'transactions') {
    fetchTransactions();
  }
}

// Attach menu listeners
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    const tab = e.currentTarget.getAttribute('data-tab');
    switchTab(tab);
  });
});

// ========== Fetch & Compute Data ==========
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
    
    // Status Action Buttons
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
      <td style="font-weight: 600;">${escapeHtml(t.donor || 'Anonymous')}</td>
      <td style="font-weight: 700; color: #818cf8;">฿${(Number(t.amount) || 0).toLocaleString()}</td>
      <td class="text-muted" style="max-width: 200px; white-space: normal; word-break: break-all;">${escapeHtml(t.message || '-')}</td>
      <td><span class="badge ${getStatusBadgeClass(t.status)}">${t.status}</span></td>
      <td>
        <div style="display:flex; gap:6px;">
          ${actionsHtml}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function getStatusBadgeClass(status) {
  if (status === 'successful') return 'badge-success';
  if (status === 'pending') return 'badge-pending';
  return 'badge-failed';
}

// ========== Table Action Helpers ==========
window.inspectTransaction = function(id) {
  const tx = allTransactions.find(t => t.id === id);
  if (!tx) return;

  document.getElementById('jsonInspectCode').textContent = JSON.stringify(tx, null, 2);
  document.getElementById('inspectModal').classList.add('active');
};

window.simulateTransactionAlert = async function(id) {
  const tx = allTransactions.find(t => t.id === id);
  if (!tx) return;

  try {
    const res = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        donor: tx.donor,
        amount: tx.amount,
        message: tx.message
      })
    });
    if (res.ok) {
      console.log('Simulated alert successfully');
    }
  } catch (err) {
    console.error('Simulation call failed:', err);
  }
};

window.forceSuccessTransaction = async function(id) {
  if (!confirm('ต้องการบังคับให้สถานะรายการนี้เป็น "ชำระเงินสำเร็จ" หรือไม่? การกระทำนี้จะยิง Alert ขึ้นหน้าจอด้วย')) return;

  try {
    const res = await fetch(`/api/transactions/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'successful' })
    });
    if (res.ok) {
      fetchTransactions(); // Refresh tables
    }
  } catch (err) {
    console.error('Status check update failed:', err);
  }
};

// Modal Close Action
document.getElementById('btnCloseModal').onclick = () => {
  document.getElementById('inspectModal').classList.remove('active');
};

// ========== Search & Filter Event Bindings ==========
document.getElementById('inputSearchDonor').addEventListener('input', () => renderFullTransactions(allTransactions));
document.getElementById('selectFilterStatus').addEventListener('change', () => renderFullTransactions(allTransactions));
document.getElementById('btnRefreshTransactions').onclick = fetchTransactions;

// ========== Overlay Settings Management ==========
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
      document.getElementById('sliderSoundVolume').value = s.soundVolume;
      document.getElementById('lblSoundVolume').textContent = Math.round(s.soundVolume * 100);

      // TTS Checkboxes
      document.getElementById('chkTtsEnabled').checked = s.ttsEnabled;
      document.getElementById('chkTtsReadDonor').checked = s.ttsReadDonor !== undefined ? s.ttsReadDonor : true;
      savedVoiceName = s.ttsVoice || 'default';
      populateVoiceList(); // Re-populate with saved value
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

      // Profanity Filter
      document.getElementById('chkProfanityFilterEnabled').checked = s.profanityFilterEnabled;
      document.getElementById('profanityReplaceStyleSelect').value = s.profanityReplaceStyle || 'asterisks';
      document.getElementById('inputProfanityWords').value = s.profanityWords || '';

      // Handle custom fields toggle on startup
      toggleCustomColors(s.theme);
      toggleTtsSubSettings(s.ttsEnabled);
      toggleAudioSettingsRow(s.soundEnabled);
      toggleProfanitySubSettings(s.profanityFilterEnabled);
    }
  } catch (err) {
    console.error('Failed to load overlay settings:', err);
  }
}

// Dynamic input value updates
document.getElementById('sliderDuration').oninput = (e) => {
  document.getElementById('lblDuration').textContent = e.target.value;
};
document.getElementById('sliderParticles').oninput = (e) => {
  document.getElementById('lblParticles').textContent = e.target.value;
};
document.getElementById('sliderFontSize').oninput = (e) => {
  document.getElementById('lblFontSize').textContent = e.target.value;
};
document.getElementById('sliderSoundVolume').oninput = (e) => {
  document.getElementById('lblSoundVolume').textContent = Math.round(e.target.value * 100);
};
document.getElementById('sliderTtsVolume').oninput = (e) => {
  document.getElementById('lblTtsVolume').textContent = Math.round(e.target.value * 100);
};
document.getElementById('sliderTtsRate').oninput = (e) => {
  document.getElementById('lblTtsRate').textContent = Number(e.target.value).toFixed(1);
};

// Toggle display rules
function toggleCustomColors(theme) {
  const container = document.getElementById('customColorsContainer');
  if (theme === 'custom' || theme === 'glassmorphism' || theme === 'text-only') {
    container.style.display = 'block';
  } else {
    container.style.display = 'none';
  }
}

function toggleTtsSubSettings(enabled) {
  const container = document.getElementById('ttsSubSettingsContainer');
  container.style.display = enabled ? 'block' : 'none';
}

function toggleAudioSettingsRow(enabled) {
  const row = document.getElementById('soundVolumeSettingsRow');
  row.style.display = enabled ? 'grid' : 'none';
}

function toggleProfanitySubSettings(enabled) {
  const container = document.getElementById('profanitySubSettingsContainer');
  container.style.display = enabled ? 'block' : 'none';
}

// Watch Selectors
document.getElementById('themeSelect').onchange = (e) => toggleCustomColors(e.target.value);
document.getElementById('chkTtsEnabled').onchange = (e) => toggleTtsSubSettings(e.target.checked);
document.getElementById('chkSoundEnabled').onchange = (e) => toggleAudioSettingsRow(e.target.checked);
document.getElementById('chkProfanityFilterEnabled').onchange = (e) => toggleProfanitySubSettings(e.target.checked);

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

  p.oninput = (e) => { t.value = e.target.value; };
  t.oninput = (e) => {
    if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(e.target.value)) {
      p.value = e.target.value;
    }
  };
});

// ========== Save Overlay Settings Form ==========
document.getElementById('overlaySettingsForm').onsubmit = async (e) => {
  e.preventDefault();
  
  const payload = {
    theme: document.getElementById('themeSelect').value,
    fontFamily: document.getElementById('fontSelect').value,
    animation: document.getElementById('animSelect').value,
    duration: parseInt(document.getElementById('sliderDuration').value),
    particleCount: parseInt(document.getElementById('sliderParticles').value),
    fontSize: parseInt(document.getElementById('sliderFontSize').value) || 32,
    
    primaryColor: document.getElementById('txtPrimary').value,
    secondaryColor: document.getElementById('txtSecondary').value,
    textColor: document.getElementById('txtText').value,
    backgroundColor: document.getElementById('txtBg').value,
    borderColor: hexToRgbA(document.getElementById('txtPrimary').value, 0.25),
    
    soundEnabled: document.getElementById('chkSoundEnabled').checked,
    soundChoice: document.getElementById('soundChoiceSelect').value,
    soundVolume: parseFloat(document.getElementById('sliderSoundVolume').value),
    
    ttsEnabled: document.getElementById('chkTtsEnabled').checked,
    ttsReadDonor: document.getElementById('chkTtsReadDonor').checked,
    ttsLanguage: 'th-TH',
    ttsVoice: document.getElementById('ttsVoiceSelect').value,
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
      alert('💾 บันทึกและซิงค์การตั้งค่าสำเร็จ! หน้าจอจำลองสดจะปรับดีไซน์ใหม่ทันที 🎉');
    }
  } catch (err) {
    alert('❌ ไม่สามารถบันทึกการตั้งค่าได้');
  }
};

// Helper: Hex to RGBA
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

// ========== Send Test Alert (Form / Header Button) ==========
function triggerRandomTestAlert() {
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

document.getElementById('btnQuickTestAlert').onclick = triggerRandomTestAlert;
document.getElementById('btnTestOverlayForm').onclick = triggerRandomTestAlert;

// Reload preview frame
document.getElementById('btnReloadPreview').onclick = () => {
  const iframe = document.getElementById('overlayPreviewIframe');
  iframe.src = iframe.src;
};

// Copy OBS URL to Clipboard
document.getElementById('btnCopyObsUrl').onclick = () => {
  const copyText = document.getElementById('obsOverlayUrl');
  copyText.select();
  copyText.setSelectionRange(0, 99999);
  
  navigator.clipboard.writeText(copyText.value)
    .then(() => {
      const orig = document.getElementById('btnCopyObsUrl').textContent;
      document.getElementById('btnCopyObsUrl').textContent = 'คัดลอกแล้ว!';
      document.getElementById('btnCopyObsUrl').style.background = 'var(--success)';
      
      setTimeout(() => {
        document.getElementById('btnCopyObsUrl').textContent = orig;
        document.getElementById('btnCopyObsUrl').style.background = '';
      }, 1500);
    })
    .catch(err => {
      console.error('Failed to copy text: ', err);
    });
};

// ========== Html Escape Helper ==========
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ========== Page Customization Management ==========
async function loadPageSettings() {
  try {
    const pathParts = window.location.pathname.split('/');
    const username = pathParts[1];
    if (!username) return;

    const response = await fetch(`/api/page/${username}/settings`);
    if (response.ok) {
      const s = await response.json();
      
      // Map to inputs
      document.getElementById('inputPageTitle').value = s.pageTitle;
      document.getElementById('inputPageSubtitle').value = s.pageSubtitle;
      document.getElementById('inputThankYouHeader').value = s.thankYouHeader;
      document.getElementById('inputThankYouSubtitle').value = s.thankYouSubtitle;
      
      // Socials
      document.getElementById('socialTwitch').value = s.socials.twitch || '';
      document.getElementById('socialYoutube').value = s.socials.youtube || '';
      document.getElementById('socialTiktok').value = s.socials.tiktok || '';
      document.getElementById('socialFacebook').value = s.socials.facebook || '';
      document.getElementById('socialX').value = s.socials.x || '';
      document.getElementById('socialDiscord').value = s.socials.discord || '';
      document.getElementById('socialInstagram').value = s.socials.instagram || '';
      
      // Profile
      document.getElementById('profilePreview').src = s.profileImage;
      document.getElementById('profileImageValue').value = s.profileImageValue || '';
      
      updatePagePreview();
    }
  } catch (err) {
    console.error('Failed to load page settings:', err);
  }
}

async function savePageSettings(e) {
  e.preventDefault();
  
  const payload = {
    page_title: document.getElementById('inputPageTitle').value,
    page_subtitle: document.getElementById('inputPageSubtitle').value,
    thank_you_header: document.getElementById('inputThankYouHeader').value,
    thank_you_subtitle: document.getElementById('inputThankYouSubtitle').value,
    social_twitch: document.getElementById('socialTwitch').value,
    social_youtube: document.getElementById('socialYoutube').value,
    social_tiktok: document.getElementById('socialTiktok').value,
    social_facebook: document.getElementById('socialFacebook').value,
    social_x: document.getElementById('socialX').value,
    social_discord: document.getElementById('socialDiscord').value,
    social_instagram: document.getElementById('socialInstagram').value,
    profile_image_source: 'custom', // Always set to custom now
    profile_image_value: document.getElementById('profileImageValue').value,
  };
  
  try {
    const res = await fetch('/api/page/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      alert('💾 บันทึกการปรับแต่งหน้าเว็บสำเร็จ!');
      updatePagePreview();
    }
  } catch (err) {
    alert('❌ ไม่สามารถบันทึกการตั้งค่าได้');
  }
}

function updatePagePreview() {
  const pathParts = window.location.pathname.split('/');
  const username = pathParts[1];
  if (username) {
    document.getElementById('pagePreviewIframe').src = `/${username}`;
  }
}

// Profile Edit Handlers
document.getElementById('btnChangeProfile').onclick = () => {
  const container = document.getElementById('profileSourceContainer');
  container.style.display = container.style.display === 'none' ? 'flex' : 'none';
};

document.getElementById('btnApplyProfile').onclick = async () => {
  const value = document.getElementById('profileImageValue').value;
  
  let previewUrl = '/avatar.jpg';
  if (value) {
    previewUrl = value;
  }
  
  document.getElementById('profilePreview').src = previewUrl;
};

document.getElementById('btnReloadPagePreview').onclick = updatePagePreview;
document.getElementById('pageSettingsForm').onsubmit = savePageSettings;
document.addEventListener('DOMContentLoaded', () => {
  // Extract username from URL
  const pathParts = window.location.pathname.split('/');
  const username = pathParts[1];
  
  if (username) {
    // Update Donation Page links to use the username
    // Target all links that refer to the donation page (home)
    document.querySelectorAll('a').forEach(link => {
      if (link.getAttribute('href') === '/' || link.textContent.includes('หน้าบริจาค')) {
        link.href = `/${username}`;
      }
    });
  }
  
  // Sync the current host domain and Token into copy OBS box
  const baseUrl = window.location.origin;
  updateObsUrlWithToken(baseUrl, username);
  
  fetchTransactions();
  loadOverlaySettings();
  loadPageSettings();
  
  // Check Overlay Status
  updateOverlayStatus();
  setInterval(updateOverlayStatus, 5000); // Check every 5 seconds
  
  // Auto refresh table statistics every 20 seconds silently
  setInterval(fetchTransactions, 20000);
});

async function updateObsUrlWithToken(baseUrl, username) {
  const urlInput = document.getElementById('obsOverlayUrl');
  if (!urlInput) return;
  
  try {
    const response = await fetch('/api/overlay/token');
    if (response.ok) {
      const { token } = await response.json();
      // บังคับให้มี token เสมอ เพื่อป้องกันการสุ่มหายบน Vercel
      urlInput.value = `${baseUrl}/${username}/overlay?token=${token}`;
    } else {
      // หาก API token มีปัญหา ให้ใช้ token เริ่มต้น (แต่ยังระบุโครงสร้างให้ชัดเจน)
      urlInput.value = `${baseUrl}/${username}/overlay?token=ready1`;
      console.warn('Could not fetch overlay token, using fallback token');
    }
  } catch (err) {
    console.error('Failed to fetch overlay token:', err);
    urlInput.value = `${baseUrl}/${username}/overlay?token=ready1`;
  }
}

async function updateOverlayStatus() {
  try {
    const response = await fetch('/api/overlay/status');
    if (response.ok) {
      const { active } = await response.json();
      const indicator = document.getElementById('overlayStatusIndicator');
      const text = document.getElementById('overlayStatusText');
      
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
  } catch (err) {
    console.error('Failed to fetch overlay status:', err);
  }
}

