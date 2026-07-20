(() => {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  const amt = params.get('amt') || '0';
  const username = params.get('u') || '';
  const pageToken = params.get('pt') || '';

  const streamerLine = document.getElementById('streamerLine');
  const amountLine = document.getElementById('amountLine');
  const dropzone = document.getElementById('dropzone');
  const slipFileInput = document.getElementById('slipFileInput');
  const previewBox = document.getElementById('previewBox');
  const previewImage = document.getElementById('previewImage');
  const statusBox = document.getElementById('statusBox');
  const btnRetry = document.getElementById('btnRetry');
  const honeypot = document.getElementById('honeypot');

  streamerLine.textContent = username ? `กำลังส่งสลิปให้ ${username}` : 'ไม่พบข้อมูลผู้รับ';
  amountLine.textContent = `฿${amt}`;

  if (!ref) {
    dropzone.style.display = 'none';
    showStatus('error', 'ลิงก์ไม่สมบูรณ์ กรุณากลับไปที่หน้าคอมพิวเตอร์แล้วสแกน QR ใหม่');
    return;
  }

  function showStatus(type, text, withSpinner = false) {
    statusBox.style.display = 'flex';
    statusBox.className = `status-box ${type}`;
    statusBox.innerHTML = withSpinner
      ? `<div class="spinner"></div><span>${text}</span>`
      : `<span>${text}</span>`;
  }

  function resetToDropzone() {
    slipFileInput.value = '';
    previewBox.style.display = 'none';
    dropzone.style.display = 'flex';
    statusBox.style.display = 'none';
    btnRetry.style.display = 'none';
  }

  btnRetry.addEventListener('click', resetToDropzone);

  slipFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showStatus('error', 'กรุณาเลือกไฟล์รูปภาพเท่านั้น');
      btnRetry.style.display = 'block';
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      previewImage.src = ev.target.result;
      previewBox.style.display = 'block';
      dropzone.style.display = 'none';
    };
    reader.readAsDataURL(file);

    uploadSlip(file);
  });

  async function uploadSlip(file) {
    showStatus('checking', 'กำลังส่งสลิป...', true);
    btnRetry.style.display = 'none';

    try {
      const formData = new FormData();
      formData.append('slip', file);
      formData.append('referenceId', ref);
      formData.append('amount', amt);
      formData.append('username', username);
      formData.append('page_token', pageToken);
      formData.append('contact_email', honeypot.value || '');

      const response = await fetch('/api/verify-slip', { method: 'POST', body: formData });
      const data = await response.json();

      if (data.success) {
        showStatus('success', '✅ ส่งสลิปสำเร็จ! กรุณากลับไปที่หน้าคอมพิวเตอร์');
        return;
      }

      if (data.errorCode === 'ALREADY_VERIFIED') {
        showStatus('success', '✅ รายการนี้ยืนยันเรียบร้อยแล้ว');
        return;
      }

      // blockBot() (server.js:355) ตอบ {error:'FORBIDDEN'} ตอน page_token หมดอายุ (>1 ชม.) — แปลงเป็นข้อความไทย
      const message = (data.error && data.error !== 'FORBIDDEN')
        ? data.error
        : 'ไม่สามารถอัพโหลดได้ อาจเนื่องจากลิงก์หมดอายุ กรุณากลับไปที่หน้าคอมพิวเตอร์แล้วสร้าง QR ใหม่';
      showStatus('error', message);
      btnRetry.style.display = 'block';
    } catch (err) {
      showStatus('error', 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง');
      btnRetry.style.display = 'block';
    }
  }
})();
