(function () {
  'use strict';

  /* ── Styles ─────────────────────────────────────────────── */
  const css = `
  .btn-slipok-guide-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: linear-gradient(135deg, rgba(74,222,128,0.15), rgba(34,211,238,0.15));
    border: 1px solid rgba(74,222,128,0.4);
    border-radius: 8px;
    color: #4ade80;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }
  .btn-slipok-guide-trigger:hover {
    background: linear-gradient(135deg, rgba(74,222,128,0.25), rgba(34,211,238,0.25));
    border-color: rgba(74,222,128,0.7);
    transform: translateY(-1px);
  }

  #slipokGuideModal .sg-wrapper {
    background: #0d1117;
    border: 1px solid rgba(74,222,128,0.25);
    border-radius: 20px;
    width: min(680px, 96vw);
    height: min(820px, 92vh);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 30px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(74,222,128,0.1);
  }

  .sg-topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 20px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
  }
  .sg-topbar-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 15px;
    color: #f0fdf4;
  }
  .sg-skip-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    color: #94a3b8;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .sg-skip-btn:hover { color: #fff; background: rgba(255,255,255,0.12); }

  .sg-slides-container {
    flex: 1;
    overflow: hidden;
    position: relative;
  }
  .sg-slide {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .sg-slide-hidden { display: none; }

  .sg-viewport {
    position: relative;
    overflow: hidden;
    background: #000;
    flex: 1;
    min-height: 0;
  }
  .sg-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
    display: block;
    transition: transform 1.2s cubic-bezier(0.4,0,0.2,1), transform-origin 0.1s, object-position 0.8s ease;
    transform-origin: center top;
  }
  #sgImg2 { object-position: left top; }

  .sg-caption {
    padding: 16px 22px;
    font-size: 16px;
    font-weight: 500;
    color: #e2e8f0;
    background: linear-gradient(180deg, rgba(74,222,128,0.08), rgba(34,211,238,0.04));
    border-top: 1px solid rgba(74,222,128,0.25);
    border-bottom: 1px solid rgba(255,255,255,0.05);
    margin: 0;
    flex-shrink: 0;
    line-height: 1.6;
    letter-spacing: 0.2px;
    text-align: center;
  }
  .sg-caption strong { color: #4ade80; font-weight: 700; }
  .sg-caption i { color: #22d3ee; margin-right: 8px; font-size: 17px; }

  .sg-dots {
    display: flex;
    justify-content: center;
    gap: 7px;
    padding: 10px 0 6px;
    flex-shrink: 0;
  }
  .sg-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: rgba(255,255,255,0.2);
    cursor: pointer;
    transition: all 0.25s;
  }
  .sg-dot:hover { background: rgba(255,255,255,0.45); }
  .sg-dot-active { background: #4ade80; transform: scale(1.2); }

  .sg-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px 14px;
    flex-shrink: 0;
    border-top: 1px solid rgba(255,255,255,0.05);
  }
  .sg-nav-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 16px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06);
    color: #cbd5e1;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .sg-nav-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #fff; }
  .sg-nav-btn:disabled { opacity: 0.3; cursor: default; }
  .sg-nav-btn-next {
    background: linear-gradient(135deg, rgba(74,222,128,0.2), rgba(34,211,238,0.2));
    border-color: rgba(74,222,128,0.4);
    color: #4ade80;
    font-weight: 600;
  }
  .sg-nav-btn-next:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(74,222,128,0.35), rgba(34,211,238,0.3));
    box-shadow: 0 4px 16px rgba(74,222,128,0.2);
  }
  .sg-step-label {
    font-size: 12px;
    color: #64748b;
    font-weight: 500;
  }

  .sg-cta-wrap {
    padding: 0 16px 14px;
    flex-shrink: 0;
  }
  .sg-cta-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 12px;
    border-radius: 12px;
    background: linear-gradient(135deg, #16a34a, #059669);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    text-decoration: none;
    transition: all 0.2s;
    box-shadow: 0 4px 20px rgba(22,163,74,0.4);
    animation: sgCtaPulse 2s ease-in-out infinite;
  }
  .sg-cta-btn:hover {
    background: linear-gradient(135deg, #15803d, #047857);
    transform: translateY(-2px);
    box-shadow: 0 8px 28px rgba(22,163,74,0.5);
    color: #fff;
    text-decoration: none;
  }
  @keyframes sgCtaPulse {
    0%,100% { box-shadow: 0 4px 20px rgba(22,163,74,0.4); }
    50%      { box-shadow: 0 4px 32px rgba(22,163,74,0.7); }
  }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ── Modal HTML ─────────────────────────────────────────── */
  function makeSlide(id, content, caption, hidden) {
    return `<div class="sg-slide${hidden ? ' sg-slide-hidden' : ''}" id="sgSlide${id}">${content}<p class="sg-caption">${caption}</p></div>`;
  }

  const modalHTML = `
  <div class="modal" id="slipokGuideModal">
    <div class="sg-wrapper">
      <div class="sg-topbar">
        <div class="sg-topbar-title">
          <i class="fas fa-book-open" style="color:#4ade80;"></i>
          วิธีรับ API จาก SlipOK
        </div>
        <button class="sg-skip-btn" onclick="closeSlipOkGuide()">
          ข้าม <i class="fas fa-forward-step"></i>
        </button>
      </div>

      <div class="sg-slides-container">
        ${makeSlide(1,
          `<div class="sg-viewport">
            <img class="sg-img" id="sgImg1" src="/assets/slipok-guide/SlipOK_Guide_1.jpg" alt="Account Tab" width="1614" height="885">
          </div>`,
          '<i class="fas fa-university"></i> คลิก <strong>บัญชี</strong> ในแถบเมนู แล้วกด <strong>+ สร้างบัญชีธนาคารเพิ่ม</strong>', false)}
        ${makeSlide(2,
          `<div class="sg-viewport">
            <img class="sg-img" id="sgImg2" src="/assets/slipok-guide/SlipOK_Guide_2.jpg" alt="Fill Bank" width="1414" height="891">
          </div>`,
          '<i class="fas fa-mobile-alt"></i> เลือกช่องทางรับเงิน (PromptPay / TrueMoney) กรอกข้อมูล แล้วกด <strong>สร้างบัญชี</strong>', true)}
        ${makeSlide(3,
          `<div class="sg-viewport">
            <img class="sg-img" id="sgImg3" src="/assets/slipok-guide/SlipOK_Guide_3.jpg" alt="Branch" width="1624" height="855">
          </div>`,
          '<i class="fas fa-code-branch"></i> คลิก <strong>สาขา</strong> ในแถบเมนู แล้วกด <strong>+ สร้างสาขาเพิ่ม</strong>', true)}
        ${makeSlide(4,
          `<div class="sg-viewport">
            <img class="sg-img" id="sgImg4" src="/assets/slipok-guide/SlipOK_Guide_4.jpg" alt="API Key" width="1522" height="796">
          </div>`,
          '<i class="fas fa-key"></i> เลือก <strong>API Key</strong> เป็นช่องทางตรวจสอบ — จดหรือคัดลอก <strong>API</strong> และ <strong>API Key</strong> ทั้ง 2 ค่าเก็บไว้ แล้วเลื่อนลงกด <strong>สร้างสาขา</strong> เพื่อยืนยัน', true)}
        ${makeSlide(5,
          `<div class="sg-viewport">
            <img class="sg-img" id="sgImg5" src="/assets/slipok-guide/SlipOK_Guide_5.jpg" alt="TipKub API" width="771" height="740">
          </div>`,
          '<i class="fas fa-paste"></i> วาง API และ API Key ใน TipKub แล้วกด <strong>ทดสอบการเชื่อมต่อ</strong>', true)}
        ${makeSlide(6,
          `<div class="sg-viewport">
            <img class="sg-img" id="sgImg6" src="/assets/slipok-guide/SlipOK_Guide_6.jpg" alt="API Recovery" width="1547" height="841">
          </div>`,
          '<i class="fas fa-redo"></i> ลืม API? กลับมาที่หน้า <strong>สาขา</strong> → กดปุ่ม <strong>⋮</strong> → <strong>แก้ไข</strong> เพื่อดู API ได้ตลอดเวลา', true)}
      </div>

      <div class="sg-dots" id="sgDots">
        <span class="sg-dot sg-dot-active" onclick="sgGoTo(1)"></span>
        <span class="sg-dot" onclick="sgGoTo(2)"></span>
        <span class="sg-dot" onclick="sgGoTo(3)"></span>
        <span class="sg-dot" onclick="sgGoTo(4)"></span>
        <span class="sg-dot" onclick="sgGoTo(5)"></span>
        <span class="sg-dot" onclick="sgGoTo(6)"></span>
      </div>

      <div class="sg-nav">
        <button class="sg-nav-btn" id="sgBtnPrev" onclick="sgNav(-1)" disabled>
          <i class="fas fa-chevron-left"></i> ก่อนหน้า
        </button>
        <span class="sg-step-label" id="sgStepLabel">1 / 6</span>
        <button class="sg-nav-btn sg-nav-btn-next" id="sgBtnNext" onclick="sgNav(1)">
          ถัดไป <i class="fas fa-chevron-right"></i>
        </button>
      </div>

      <div class="sg-cta-wrap" id="sgCtaWrap" style="display:none">
        <a href="https://app.slipok.com/" target="_blank" class="sg-cta-btn" id="sgCtaBtn">
          <i class="fas fa-external-link-alt"></i> ไปรับ API ที่ SlipOK ทันที
        </a>
      </div>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHTML);

  /* ── Logic ──────────────────────────────────────────────── */
  const TOTAL = 6;
  let current = 1;
  let animTimers = [];

  function openSlipOkGuide() {
    document.getElementById('slipokGuideModal').classList.add('active');
    sgGoTo(1);
    document.getElementById('sgCtaBtn').addEventListener('click', closeSlipOkGuide, { once: true });
  }

  function closeSlipOkGuide() {
    document.getElementById('slipokGuideModal').classList.remove('active');
    clearAnimTimers();
  }

  function clearAnimTimers() {
    animTimers.forEach(clearTimeout);
    animTimers = [];
  }

  function after(ms, fn) {
    animTimers.push(setTimeout(fn, ms));
  }

  function animSlide(n) {
    clearAnimTimers();

    if (n === 3) {
      // pan right to reveal + สร้างสาขาเพิ่ม button at far-right of wide image
      const img = document.getElementById('sgImg3');
      if (img) img.style.objectPosition = 'right top';

    } else if (n === 6) {
      // pan right to reveal ⋮ menu and แก้ไข option
      const img = document.getElementById('sgImg6');
      if (img) img.style.objectPosition = 'right top';
    }
  }

  function sgGoTo(n) {
    if (n < 1 || n > TOTAL) return;
    clearAnimTimers();

    for (let i = 1; i <= TOTAL; i++) {
      const s = document.getElementById('sgSlide' + i);
      if (s) { s.classList.add('sg-slide-hidden'); s.classList.remove('sg-slide-visible'); }
    }
    const target = document.getElementById('sgSlide' + n);
    if (target) target.classList.remove('sg-slide-hidden');

    current = n;

    document.querySelectorAll('.sg-dot').forEach(function (d, idx) {
      d.classList.toggle('sg-dot-active', idx + 1 === n);
    });

    document.getElementById('sgStepLabel').textContent = n + ' / ' + TOTAL;
    document.getElementById('sgBtnPrev').disabled = (n === 1);

    const nextBtn = document.getElementById('sgBtnNext');
    if (n === TOTAL) {
      nextBtn.innerHTML = '<i class="fas fa-check"></i> เสร็จสิ้น';
      nextBtn.disabled = true;
    } else {
      nextBtn.innerHTML = 'ถัดไป <i class="fas fa-chevron-right"></i>';
      nextBtn.disabled = false;
    }

    document.getElementById('sgCtaWrap').style.display = (n === TOTAL) ? 'block' : 'none';
    animSlide(n);
  }

  function sgNav(delta) {
    sgGoTo(current + delta);
  }

  document.getElementById('slipokGuideModal').addEventListener('click', function (e) {
    if (e.target === this) closeSlipOkGuide();
  });

  window.openSlipOkGuide  = openSlipOkGuide;
  window.closeSlipOkGuide = closeSlipOkGuide;
  window.sgGoTo  = sgGoTo;
  window.sgNav   = sgNav;
})();
