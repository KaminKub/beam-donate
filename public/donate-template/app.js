// State
let selectedAmount = 0;
let currentChargeId = null;
let pollInterval = null;
const POLLING_TIMEOUT = 600000; // 10 minutes
let pollingStartTime = null;

// Elements
const stepAmount = document.getElementById('step-amount');
const stepQR = document.getElementById('step-qr');
const amountBtns = document.querySelectorAll('.amount-btn');
const customAmountInput = document.getElementById('customAmount');
const donorNameInput = document.getElementById('donorName');
const donorMessageInput = document.getElementById('donorMessage');
const btnDonate = document.getElementById('btnDonate');
const btnBack = document.getElementById('btnBack');
const qrLoading = document.getElementById('qrLoading');
const qrImage = document.getElementById('qrImage');
const displayAmount = document.getElementById('displayAmount');
const paymentStatus = document.getElementById('paymentStatus');

// Amount button click
amountBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    amountBtns.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedAmount = parseInt(btn.dataset.amount);
    customAmountInput.value = '';
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
  btnDonate.disabled = selectedAmount < 1;
  if (selectedAmount >= 1) {
    btnDonate.textContent = `บริจาค ฿${selectedAmount.toLocaleString()}`;
  } else {
    btnDonate.textContent = 'ดำเนินการต่อ';
  }
}

// Donate button click
btnDonate.addEventListener('click', async () => {
  if (selectedAmount < 1) return;

  // Show loading state
  btnDonate.disabled = true;
  btnDonate.textContent = 'กำลังดำเนินการ...';

  try {
    // Create charge (Payment Link)
    const response = await fetch('/api/create-charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: selectedAmount,
        name: donorNameInput.value,
        message: donorMessageInput.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'เกิดข้อผิดพลาด');
    }

    if (data.paymentUrl) {
      // Redirect to Beam Payment Page
      btnDonate.textContent = 'กำลังพาท่านไปหน้าชำระเงิน...';
      window.location.href = data.paymentUrl;
    } else {
      throw new Error('ไม่ได้รับลิงก์ชำระเงิน');
    }

  } catch (error) {
    alert(error.message);
    // Reset button
    updateDonateButton();
  }
});

// Back button
btnBack.addEventListener('click', goBack);

function goBack() {
  stopPolling();
  stepQR.classList.remove('active');
  stepAmount.classList.add('active');
  currentChargeId = null;
}

// Poll for payment status
function startPolling() {
  pollingStartTime = Date.now();

  pollInterval = setInterval(async () => {
    if (!currentChargeId) return;

    // Check timeout
    if (Date.now() - pollingStartTime > POLLING_TIMEOUT) {
      stopPolling();
      paymentStatus.className = 'status checking'; // Keep yellow/neutral
      paymentStatus.innerHTML = '⚠️ หมดเวลาการตรวจสอบสถานะ กรุณารีเฟรชหากจ่ายเงินแล้ว';
      return;
    }

    try {
      const response = await fetch(`/api/charge/${currentChargeId}`);
      const data = await response.json();

      if (data.paid) {
        stopPolling();
        paymentStatus.className = 'status success';
        paymentStatus.innerHTML = '✅ ชำระเงินสำเร็จ!';

        // Redirect to thank you page
        setTimeout(() => {
          window.location.href = '/thank-you';
        }, 1500);
      }
    } catch (error) {
      console.error('Polling error:', error);
    }
  }, 3000); // Check every 3 seconds
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
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
    // ใช้ Promise.all เพื่อดึงข้อมูลและหน่วงเวลาขั้นต่ำ 1.2 วินาที เพื่อความนุ่มนวล (Premium Feel)
    const [response] = await Promise.all([
      fetch('/api/overlay/status'),
      new Promise(resolve => setTimeout(resolve, 1200))
    ]);

    if (response.ok) {
      const data = await response.json();
      if (data.active) {
        statusDot.classList.add('online');
        statusText.textContent = 'โดขึ้นจอ | เปิดอยู่';
        if (statusNote) statusNote.style.display = 'none';
      } else {
        throw new Error('Overlay inactive');
      }
    } else {
      throw new Error();
    }
  } catch (error) {
    statusDot.classList.remove('online');
    statusText.textContent = 'โดขึ้นจอ | ปิดอยู่';
    if (statusNote) statusNote.style.display = 'block';
  } finally {
    // Stop Loading Animation
    if (refreshIcon) refreshIcon.classList.remove('spinning');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateStatus();
  const statusBtn = document.getElementById('statusBtn');
  if (statusBtn) {
    statusBtn.addEventListener('click', updateStatus);
  }
});

