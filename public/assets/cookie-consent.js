(function() {
  // Check if user already accepted cookies
  if (localStorage.getItem('tipkub-cookie-consent') === 'true') {
    return;
  }

  // Create styles
  const style = document.createElement('style');
  style.textContent = `
    .cookie-consent-banner {
      position: fixed;
      top: 20px;
      left: 0;
      right: 0;
      margin: 0 auto;
      width: auto;
      max-width: 90%;
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(15px);
      -webkit-backdrop-filter: blur(15px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 16px;
      padding: 0.8rem 1.5rem;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1.2rem;
      z-index: 9999;
      font-family: 'Kanit', sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      animation: slideDown 0.5s ease-out forwards;
      box-sizing: border-box;
    }
    .cookie-consent-text {
      font-size: 0.9rem;
      line-height: 1.4;
      color: #cbd5e1;
      text-align: center;
      white-space: nowrap;
    }
    .cookie-consent-text a {
      color: #a5b4fc;
      text-decoration: none;
      font-weight: 500;
      transition: color 0.3s ease;
    }
    .cookie-consent-text a:hover {
      color: #ffffff;
    }
    .cookie-consent-btn {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      border: none;
      padding: 0.6rem 1.2rem;
      border-radius: 10px;
      cursor: pointer;
      font-family: 'Kanit', sans-serif;
      font-weight: 500;
      font-size: 0.9rem;
      white-space: nowrap;
      transition: all 0.3s ease;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
    }
    .cookie-consent-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 15px rgba(102, 126, 234, 0.4);
      filter: brightness(1.1);
    }
    @keyframes slideDown {
      from { transform: translateY(-100px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    @media (max-width: 600px) {
      .cookie-consent-banner {
        flex-direction: column;
        text-align: center;
        width: 90%;
        padding: 1rem;
      }
      .cookie-consent-text {
        white-space: normal;
      }
      .cookie-consent-btn {
        width: 100%;
      }
    }
  `;
  document.head.appendChild(style);

  // Create Banner
  const banner = document.createElement('div');
  banner.className = 'cookie-consent-banner';
  banner.innerHTML = `
    <div class="cookie-consent-text">
      เว็บไซต์นี้ใช้คุกกี้เพื่อเพิ่มประสิทธิภาพในการใช้งานและยืนยันตัวตนของคุณ 
      <a href="/privacy.html" target="_blank">อ่านนโยบายความเป็นส่วนตัว</a>
    </div>
    <button class="cookie-consent-btn" id="accept-cookies">ยอมรับ</button>
  `;
  document.body.appendChild(banner);

  // Accept button logic
  document.getElementById('accept-cookies').addEventListener('click', () => {
    localStorage.setItem('tipkub-cookie-consent', 'true');
    banner.style.transition = 'all 0.3s ease';
    banner.style.opacity = '0';
    banner.style.transform = 'translateY(-20px)';
    setTimeout(() => banner.remove(), 300);
  });
})();
