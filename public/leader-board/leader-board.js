(function () {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';

  let eventSource = null;
  let reconnectDelay = 2000;
  let cfg = {};
  let prevDonors = [];
  let amountSuffix = 'บาท'; // global Alert setting (amountSuffix) — leaderboard has no currency field of its own

  const wrapper = document.getElementById('lbWrapper');
  const titleEl = document.getElementById('lbTitle');
  const listEl = document.getElementById('lbList');

  const MEDALS = ['🥇', '🥈', '🥉'];

  function isDemo() { return window.DEMO_MODE === true; }

  function settingsUrl() {
    return isDemo()
      ? '/api/demo/overlay/settings'
      : (token ? `/api/overlay/settings?token=${encodeURIComponent(token)}` : '/api/overlay/settings');
  }

  function streamUrl() {
    return isDemo()
      ? '/api/demo/alerts/stream?source=demo-leader-board'
      : (token ? `/api/alerts/stream?token=${encodeURIComponent(token)}&source=leader-board` : '/api/alerts/stream?source=leader-board');
  }

  function hexToRgba(hex, alpha) {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // [Requirement #8] {ระยะเวลา} — title-only variable, ไม่ใช้ applyTemplateColored() (ไม่ใช่ per-row var)
  function periodLabel(mode, days) {
    if (mode === 'weekly') return 'รายสัปดาห์';
    if (mode === 'monthly') return 'รายเดือน';
    if (mode === 'custom') return `ล่าสุด ${parseInt(days, 10) || 30} วัน`;
    return 'ทั้งหมด'; // 'all'
  }

  function applySettings(c) {
    cfg = c;
    const root = document.documentElement.style;

    // textContent เท่านั้น (ไม่ใช่ innerHTML) — plain string replace ปลอดภัยจาก XSS อยู่แล้ว
    titleEl.textContent = (cfg.title || '🏆 อันดับผู้โดเนท').replace(/\{ระยะเวลา\}/g, periodLabel(cfg.period_mode, cfg.period_custom_days));

    // Width — explicit px OR responsive CSS default (auto)
    const w = parseInt(cfg.width, 10);
    if (w >= 300 && w <= 2560) {
      wrapper.style.setProperty('--lb-width', w + 'px');
    } else {
      wrapper.style.removeProperty('--lb-width');
    }

    // Background
    const bgAlpha = (cfg.bg_enabled !== false && cfg.bg_enabled !== 0)
      ? ((parseInt(cfg.bg_opacity, 10) ?? 60) / 100)
      : 0;
    root.setProperty('--lb-bg', hexToRgba(cfg.bg_color || '#000000', bgAlpha));

    // Border
    const borderAlpha = (cfg.border_enabled !== false && cfg.border_enabled !== 0)
      ? ((parseInt(cfg.border_opacity, 10) ?? 100) / 100)
      : 0;
    root.setProperty('--lb-border', hexToRgba(cfg.border_color || '#a855f7', borderAlpha));

    // Font sizes — larger defaults for high-resolution clarity
    root.setProperty('--lb-font-title', (cfg.font_size_title || 28) + 'px');
    root.setProperty('--lb-font-row', (cfg.font_size_row || 22) + 'px');
    root.setProperty('--lb-font-medal', (cfg.font_size_medal || 24) + 'px');

    // Outline — SVG filter (UI_UX_LESSONS.md #8), ไม่ใช้ -webkit-text-stroke
    const ow = parseInt(cfg.outline_width, 10);
    const owFinal = Number.isFinite(ow) ? ow : 2;
    const oc = cfg.outline_color || '#000000';
    const dilateEl = document.getElementById('lbOutlineDilate');
    const floodEl = document.getElementById('lbOutlineFlood');
    if (dilateEl) dilateEl.setAttribute('radius', owFinal);
    if (floodEl) floodEl.setAttribute('flood-color', oc);
    const outlineFn = owFinal > 0 ? 'url(#lb-outline)' : '';
    root.setProperty('--lb-title-filter', [outlineFn, 'drop-shadow(0 1px 3px rgba(0,0,0,0.8))'].filter(Boolean).join(' '));
    root.setProperty('--lb-row-filter', outlineFn || 'none');

    // Row background ("เปิดสีพื้นหลังชื่อ") — สี/ความโปร่งใสผูก user config; ไฮไลต์ทองอันดับ 1 คงที่ แยกจาก toggle นี้
    const rowBgOn = cfg.row_bg_enabled !== false && cfg.row_bg_enabled !== 0;
    const rowBgAlpha = rowBgOn ? (typeof cfg.row_bg_opacity === 'number' ? cfg.row_bg_opacity : 6) / 100 : 0;
    root.setProperty('--lb-row-bg', rowBgOn ? hexToRgba(cfg.row_bg_color || '#ffffff', rowBgAlpha) : 'transparent');
    root.setProperty('--lb-row-gold-bg', rowBgOn ? 'linear-gradient(90deg, rgba(255, 215, 0, 0.18), rgba(255, 255, 255, 0.04))' : 'transparent');

    // Row border ("เปิดกรอบชื่อ") — แยกจากกรอบ #lbWrapper (border_enabled ด้านบน) โดยสิ้นเชิง
    const rowBorderOn = cfg.row_border_enabled !== false && cfg.row_border_enabled !== 0;
    wrapper.classList.toggle('lb-row-border-off', !rowBorderOn);
    root.setProperty('--lb-row-border-color', cfg.row_border_color || '#ffffff');

    // Colors per variable
    root.setProperty('--lb-color-rank', cfg.color_rank || '#ffd700');
    root.setProperty('--lb-color-donor', cfg.color_donor || '#ffffff');
    root.setProperty('--lb-color-amount', cfg.color_amount || '#4ade80');
    root.setProperty('--lb-color-currency', cfg.color_currency || '#f59e0b');
    root.setProperty('--lb-color-count', cfg.color_count || '#94a3b8');
    root.setProperty('--lb-color-text', cfg.color_text || '#ffffff');

    // Shine — toggle pseudo-element animation
    root.setProperty('--lb-shine-display', (cfg.shine_enabled !== false && cfg.shine_enabled !== 0) ? 'block' : 'none');

    // Animation — row-enter/glow/text-shine
    const animOn = cfg.animation_enabled !== false && cfg.animation_enabled !== 0;
    wrapper.classList.toggle('lb-anim-off', !animOn);
  }

  function applyTemplateColored(tpl, vars) {
    // Replace {var} with <span class="lb-var-*">value</span> for per-variable coloring
    return tpl.replace(/\{(อันดับ|ผู้โดเนท|จำนวนเงิน|สกุลเงิน|จำนวนครั้ง)\}/g, (_, key) => {
      const map = { 'อันดับ': 'rank', 'ผู้โดเนท': 'donor', 'จำนวนเงิน': 'amount', 'สกุลเงิน': 'currency', 'จำนวนครั้ง': 'count' };
      const cls = map[key];
      return `<span class="lb-var-${cls}">${escapeHtml(String(vars[map[key]] ?? ''))}</span>`;
    });
  }

  function render(entries) {
    const max = Math.min(Math.max(parseInt(cfg.max_entries, 10) || 5, 1), 5);
    const rows = (entries || []).slice(0, max);
    const tplLeft = cfg.row_template_left || '#{อันดับ}  {ผู้โดเนท} ';
    const tplRight = cfg.row_template_right || '{จำนวนเงิน} {สกุลเงิน}';
    const currency = amountSuffix;
    const showMedal = cfg.show_medal !== false && cfg.show_medal !== 0;

    listEl.innerHTML = '';
    rows.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row' + (i === 0 ? ' lb-row-gold' : i === 1 ? ' lb-row-silver' : i === 2 ? ' lb-row-bronze' : '');

      if (showMedal) {
        const medal = document.createElement('span');
        medal.className = 'lb-medal';
        medal.textContent = MEDALS[i] || '';
        row.appendChild(medal);
      }

      const vars = { rank: entry.rank ?? (i + 1), donor: entry.donor || 'Anonymous', amount: Number(entry.total_amount || 0).toLocaleString('th-TH'), currency, count: entry.donation_count || 1 };

      const left = document.createElement('span');
      left.className = 'lb-text-left';
      left.innerHTML = applyTemplateColored(tplLeft, vars);

      const right = document.createElement('span');
      right.className = 'lb-text-right';
      right.innerHTML = applyTemplateColored(tplRight, vars);

      row.appendChild(left);
      row.appendChild(right);

      const animOn = cfg.animation_enabled !== false && cfg.animation_enabled !== 0;
      if (animOn && !prevDonors.includes(entry.donor)) {
        row.classList.add('lb-row-enter');
      }
      listEl.appendChild(row);
    });

    prevDonors = rows.map(r => r.donor);
  }

  function handleEvent(data) {
    if (data.type === 'leaderboard_update') render(data.entries);
    if (data.type === 'settings_update' && data.settings && data.settings.leaderboard_settings !== undefined) {
      if (data.settings.amountSuffix) amountSuffix = data.settings.amountSuffix;
      let c = {};
      try { c = JSON.parse(data.settings.leaderboard_settings || '{}'); } catch (_) {}
      if (!c.enabled && !isDemo()) { wrapper.style.display = 'none'; return; }
      wrapper.style.display = '';
      applySettings(c);
    }
  }

  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(streamUrl());
    eventSource.onmessage = function (e) {
      try { handleEvent(JSON.parse(e.data)); } catch (_) {}
    };
    eventSource.onopen = function () { reconnectDelay = 2000; };
    eventSource.onerror = function () {
      eventSource.close();
      eventSource = null;
      setTimeout(connectSSE, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    };
  }

  async function init() {
    try {
      const res = await fetch(settingsUrl());
      if (!res.ok) return;
      const data = await res.json();
      if (data.amountSuffix) amountSuffix = data.amountSuffix;
      let c = {};
      try { c = JSON.parse(data.leaderboard_settings || '{}'); } catch (_) {}
      if (!c.enabled && !isDemo()) return;
      wrapper.style.display = '';
      applySettings(c);
      connectSSE();
    } catch (e) {
      console.error('Leader board init failed:', e.message);
    }
  }

  init();
})();
