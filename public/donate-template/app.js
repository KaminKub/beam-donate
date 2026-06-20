// State
let selectedAmount = 0;
let selectedPaymentMethod = 'ffp';
let currentChargeId = null;
let pollInterval = null;
let countdownInterval = null;
let qrExpiresAt = null;
const POLLING_TIMEOUT = 600000; // 10 minutes
const QR_EXPIRY = 10 * 60 * 1000; // 10 minutes
let pollingStartTime = null;

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
      recipientName: data.recipientName || ''
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

async function loadPageContent() {
  const username = window.location.pathname.split('/')[1];
  if (!username) return;

  try {
    const response = await fetch(`/api/page/${username}/settings`);
    if (response.ok) {
      const data = await response.json();
      
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
       profileImage.src = data.profileImage || '/avatar.jpg';
       profileImage.style.display = 'block';
       
       // Set glow color CSS variable
       if (data.profileGlowColor) {
         document.documentElement.style.setProperty('--avatar-glow-color', data.profileGlowColor);
       }
       
       // Update social links
      renderSocialLinks(data.socials);

       // Update favicon
       const favicon = document.getElementById('favicon');
       if (favicon) {
         favicon.href = data.profileImage || '/avatar.jpg';
       }
    }
  } catch (error) {
    console.error('Error loading page content:', error);
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
    const iconClass = SOCIAL_ICONS[platform] || 'fa-link';
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
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
      const hasAnyMethod = methods.promptpay || methods.truemoney || methods.ffp;

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

      if (optionFFP) optionFFP.style.display = methods.ffp ? '' : 'none';
      if (optionPromptPay) optionPromptPay.style.display = methods.promptpay ? '' : 'none';
      if (optionTrueMoney) optionTrueMoney.style.display = methods.truemoney ? '' : 'none';

      // Auto-select first available method
      if (methods.promptpay) {
        selectPaymentMethod('promptpay');
      } else if (methods.truemoney) {
        selectPaymentMethod('truemoney');
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
          message: donorMessageInput.value
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
      btnProceedPayment.textContent = 'ดำเนินการต่อ →';
    }
  } else if (selectedPaymentMethod === 'promptpay') {
    // Check if there's a pending QR with the same params (donor went back and forth without changes)
    const pending = getPendingQR();
    const currentDonorName = donorNameInput?.value?.trim() || '';
    const currentMessage = donorMessageInput?.value?.trim() || '';
    if (pending && pending.amount === selectedAmount && pending.donorName === currentDonorName && pending.message === currentMessage) {
      restoreQRStep(pending);
      btnProceedPayment.disabled = false;
      btnProceedPayment.textContent = 'ดำเนินการต่อ →';
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
          username,
          amount: selectedAmount,
          name: donorNameInput.value,
          message: donorMessageInput.value
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
        btnProceedPayment.textContent = 'ดำเนินการต่อ →';
        return;
      }

      // Save to localStorage before showing QR step
      savePendingQR(data);

      // Show QR step
      showQRStep(data);
    } catch (error) {
      showPaymentError(error.message);
      btnProceedPayment.disabled = false;
      btnProceedPayment.textContent = 'ดำเนินการต่อ →';
    }
  }
});

function generateQRImage(qrData) {
  if (!qrImage) return;
  qrLoading.style.display = 'block';
  qrImage.style.display = 'none';

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrData)}`;
  qrImage.src = qrUrl;
  qrImage.onload = () => {
    qrLoading.style.display = 'none';
    qrImage.style.display = 'block';
  };
  qrImage.onerror = () => {
    qrLoading.innerHTML = '<p>ไม่สามารถสร้าง QR Code ได้ กรุณาลองใหม่</p>';
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
    paymentStatus.innerHTML = '⏰ QR Code หมดอายุแล้ว';
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
        body: JSON.stringify({ referenceId: currentChargeId })
      });

      const data = await response.json();

      if (data.verified) {
        clearPendingQR();
        stopPolling();
        stopCountdown();
        if (paymentStatus) {
          paymentStatus.style.display = 'flex';
          paymentStatus.className = 'status success';
          paymentStatus.innerHTML = '✅ ชำระเงินสำเร็จ!';
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
          paymentStatus.innerHTML = '⏰ QR Code หมดอายุแล้ว';
        }
        if (btnRetryQR) btnRetryQR.style.display = 'block';
      }
    } catch (error) {
      console.error('PromptPay polling error:', error);
    }
  }, 3000);
}

function showPaymentError(message) {
  if (paymentError) {
    paymentError.style.display = 'flex';
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
    paymentStatus.style.display = 'flex';
    paymentStatus.className = 'status checking';
    paymentStatus.innerHTML = '<div class="spinner-small"></div><span>กำลังตรวจสอบสลิป...</span>';
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
    const isRetryable = errorCode === 'CONNECTION_FAILED' || errorCode === 'SERVER_ERROR';

    if (errorCode === 'SLIP_DELAY') {
      const delayMin = data.delayMinutes || 5;
      handleSlipDelay(delayMin, btnVerifySlip, paymentStatus, doVerifySlip,
        () => `⏳ ${data.error || 'กรุณารอการตรวจสอบ'}`,
        () => '⏰ พร้อมตรวจสอบแล้ว — กำลังตรวจใหม่...'
      );
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
    trueMoneyPaymentStatus.style.display = 'flex';
    trueMoneyPaymentStatus.className = 'status checking';
    trueMoneyPaymentStatus.innerHTML = '<div class="spinner-small"></div><span>กำลังตรวจสอบสลิป...</span>';
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

    const response = await fetch('/api/verify-slip', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

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
        () => `⏳ ${data.error || 'กรุณารอการตรวจสอบ'}`,
        () => '⏰ พร้อมตรวจสอบแล้ว — กำลังตรวจใหม่...'
      );
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

function showTrueMoneyError(message) {
  if (trueMoneyPaymentError) trueMoneyPaymentError.style.display = 'flex';
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

// Override btnProceedPayment to handle TrueMoney
const originalProceedHandler = btnProceedPayment.onclick;
btnProceedPayment.addEventListener('click', async (e) => {
  if (selectedPaymentMethod === 'truemoney') {
    e.stopImmediatePropagation();
    
    stepPaymentMethod.classList.remove('active');
    stepTrueMoney.classList.add('active');
    
    updateSlipOkWarning(true);
    
    if (trueMoneyAmount) {
      trueMoneyAmount.textContent = `฿${selectedAmount.toLocaleString()}`;
    }
    
    // Display phone number
    if (trueMoneyPhoneDisplay) {
      const phone = streamerPaymentMethods.truemoney_phone || 'ไม่พบเบอร์โทรศัพท์';
      trueMoneyPhoneDisplay.textContent = phone;
    }
    
    btnProceedPayment.disabled = false;
    btnProceedPayment.textContent = 'ดำเนินการต่อ →';
  }
}, true);

function updateSlipOkWarning(isTruemoney) {
  if (isTruemoney) {
    const warning = document.getElementById('trueMoneySlipokWarning');
    if (warning) {
      warning.style.display = streamerPaymentMethods.truemoney_slipok_connected ? 'none' : 'flex';
    }
  } else {
    const warning = document.getElementById('slipokWarning');
    if (warning) {
      warning.style.display = streamerPaymentMethods.slipok_connected ? 'none' : 'flex';
    }
  }
}

// Widget Status Check
async function updateStatus() {
  const statusBtn = document.getElementById('statusBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusNote = document.getElementById('statusNote');
  const refreshIcon = statusBtn?.querySelector('.lucide-refresh-ccw');

  if (!statusBtn || !statusDot || !statusText) return;

  // Start Loading Animation
  if (refreshIcon) refreshIcon.classList.add('spinning');
  statusText.textContent = 'ตรวจสอบสถานะ...';

  try {
    const [response] = await Promise.all([
      fetch('/api/overlay/status'),
      new Promise(resolve => setTimeout(resolve, 1200))
    ]);

    if (!response.ok) {
      setStatusOffline();
      return;
    }

    const data = await response.json();
    if (data.active) {
      statusDot.classList.add('online');
      statusText.textContent = 'โดขึ้นจอ | เปิดอยู่';
      if (statusNote) statusNote.style.display = 'none';
    } else {
      setStatusOffline();
    }
  } catch (error) {
    setStatusOffline();
  } finally {
    if (refreshIcon) refreshIcon.classList.remove('spinning');
  }
}

function setStatusOffline() {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const statusNote = document.getElementById('statusNote');
  if (statusDot) statusDot.classList.remove('online');
  if (statusText) statusText.textContent = 'โดขึ้นจอ | ปิดอยู่';
  if (statusNote) statusNote.style.display = 'block';
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

