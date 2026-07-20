(function () {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';

  let eventSource = null;
  let reconnectDelay = 2000;
  let cfg = {};
  let lastEntries = [];
  let amountSuffix = 'บาท'; // global Alert setting (amountSuffix) — recent-donate has no currency field of its own
  let relTimeTimer = null;

  const wrapper = document.getElementById('rdWrapper');
  const titleEl = document.getElementById('rdTitle');
  const listEl = document.getElementById('rdList');

  function isDemo() { return window.DEMO_MODE === true; }

  function settingsUrl() {
    return isDemo()
      ? '/api/demo/overlay/settings'
      : (token ? `/api/overlay/settings?token=${encodeURIComponent(token)}` : '/api/overlay/settings');
  }

  function streamUrl() {
    return isDemo()
      ? '/api/demo/alerts/stream?source=demo-recent-donate'
      : (token ? `/api/alerts/stream?token=${encodeURIComponent(token)}&source=recent-donate` : '/api/alerts/stream?source=recent-donate');
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

  function relativeTime(iso) {
    if (!iso) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 60) return `${diffSec} วินาที`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} นาทีก่อน`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr} ชม.ก่อน`;
  }

  function applyTemplateColored(tpl, vars) {
    return tpl.replace(/\{(ผู้โดเนท|จำนวนเงิน|สกุลเงิน|ข้อความ)\}/g, (_, key) => {
      const map = { 'ผู้โดเนท': 'donor', 'จำนวนเงิน': 'amount', 'สกุลเงิน': 'currency', 'ข้อความ': 'message' };
      const cls = map[key];
      return `<span class="rd-var-${cls}">${escapeHtml(String(vars[map[key]] ?? ''))}</span>`;
    });
  }

  function applySettings(c) {
    cfg = c;
    const root = document.documentElement.style;

    titleEl.textContent = cfg.title || '🕐 โดเนทล่าสุด';

    const w = parseInt(cfg.width, 10);
    if (w >= 300 && w <= 2560) {
      wrapper.style.setProperty('--rd-width', w + 'px');
    } else {
      wrapper.style.removeProperty('--rd-width');
    }

    const bgAlpha = (cfg.bg_enabled !== false && cfg.bg_enabled !== 0)
      ? ((parseInt(cfg.bg_opacity, 10) ?? 60) / 100)
      : 0;
    root.setProperty('--rd-bg', hexToRgba(cfg.bg_color || '#000000', bgAlpha));

    const borderAlpha = (cfg.border_enabled !== false && cfg.border_enabled !== 0)
      ? ((parseInt(cfg.border_opacity, 10) ?? 100) / 100)
      : 0;
    root.setProperty('--rd-border', hexToRgba(cfg.border_color || '#06b6d4', borderAlpha));

    root.setProperty('--rd-font-title', (cfg.font_size_title || 28) + 'px');
    root.setProperty('--rd-font-row', (cfg.font_size_row || 21) + 'px');
    root.setProperty('--rd-font-time', (cfg.font_size_time || 15) + 'px');

    // Outline — SVG filter (UI_UX_LESSONS.md #8), ไม่ใช้ -webkit-text-stroke
    const ow = parseInt(cfg.outline_width, 10);
    const owFinal = Number.isFinite(ow) ? ow : 2;
    const oc = cfg.outline_color || '#000000';
    const dilateEl = document.getElementById('rdOutlineDilate');
    const floodEl = document.getElementById('rdOutlineFlood');
    if (dilateEl) dilateEl.setAttribute('radius', owFinal);
    if (floodEl) floodEl.setAttribute('flood-color', oc);
    const outlineFn = owFinal > 0 ? 'url(#rd-outline)' : '';
    root.setProperty('--rd-title-filter', [outlineFn, 'drop-shadow(0 1px 3px rgba(0,0,0,0.8))'].filter(Boolean).join(' '));
    root.setProperty('--rd-row-filter', outlineFn || 'none');

    // Row background ("เปิดสีพื้นหลังชื่อ") — RD: on/off + สี + ความโปร่งใส
    const rowBgOn = cfg.row_bg_enabled !== false && cfg.row_bg_enabled !== 0;
    const rowBgAlpha = rowBgOn ? ((parseInt(cfg.row_bg_opacity, 10) ?? 5) / 100) : 0;
    root.setProperty('--rd-row-bg', hexToRgba(cfg.row_bg_color || '#ffffff', rowBgAlpha));

    // Row border ("เปิดกรอบชื่อ") — RD: on/off + สีของตัวเอง แยกจากกรอบ #rdWrapper (border_enabled ด้านบน) โดยสิ้นเชิง
    const rowBorderOn = cfg.row_border_enabled !== false && cfg.row_border_enabled !== 0;
    root.setProperty('--rd-row-border', rowBorderOn ? hexToRgba(cfg.row_border_color || '#ffffff', 0.6) : 'transparent');

    root.setProperty('--rd-color-donor', cfg.color_donor || '#ffffff');
    root.setProperty('--rd-color-amount', cfg.color_amount || '#4ade80');
    root.setProperty('--rd-color-currency', cfg.color_currency || '#f59e0b');
    root.setProperty('--rd-color-message', cfg.color_message || '#94a3b8');
    root.setProperty('--rd-color-text', cfg.color_text || '#ffffff');

    // Animation toggle
    const animOn = cfg.animation_enabled !== false && cfg.animation_enabled !== 0;
    wrapper.classList.toggle('rd-anim-off', !animOn);
  }

  function render(entries) {
    const max = Math.min(Math.max(parseInt(cfg.max_entries, 10) || 5, 1), 10);
    const rows = (entries || []).slice(0, max);
    const tplLeft = cfg.row_template_left || '{ผู้โดเนท}  {จำนวนเงิน} {สกุลเงิน} ';
    const tplRight = cfg.row_template_right || ' {ข้อความ}';
    const currency = amountSuffix;
    const showTime = cfg.show_time !== false && cfg.show_time !== 0;

    const isNewFirst = rows.length && (!lastEntries.length || rows[0].donor !== lastEntries[0].donor || rows[0].paidAt !== lastEntries[0].paidAt);

    listEl.innerHTML = '';
    rows.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'rd-row';

      const vars = { donor: entry.donor || 'Anonymous', amount: Number(entry.amount || 0).toLocaleString('th-TH'), currency, message: entry.message || '' };

      const left = document.createElement('span');
      left.className = 'rd-text-left';
      left.innerHTML = applyTemplateColored(tplLeft, vars);

      const right = document.createElement('span');
      right.className = 'rd-text-right';
      right.innerHTML = applyTemplateColored(tplRight, vars);

      row.appendChild(left);
      row.appendChild(right);

      if (showTime) {
        const time = document.createElement('span');
        time.className = 'rd-time';
        time.dataset.paidAt = entry.paidAt || '';
        time.textContent = relativeTime(entry.paidAt);
        row.appendChild(time);
      }

      const animOn = cfg.animation_enabled !== false && cfg.animation_enabled !== 0;
      if (i === 0 && isNewFirst && animOn) row.classList.add('rd-row-enter');
      listEl.appendChild(row);
    });

    lastEntries = rows;
  }

  function tickRelativeTimes() {
    listEl.querySelectorAll('.rd-time').forEach(el => {
      el.textContent = relativeTime(el.dataset.paidAt);
    });
  }

  function handleEvent(data) {
    if (data.type === 'recentdonate_update') render(data.entries);
    if (data.type === 'settings_update' && data.settings && data.settings.recentdonate_settings !== undefined) {
      if (data.settings.amountSuffix) amountSuffix = data.settings.amountSuffix;
      let c = {};
      try { c = JSON.parse(data.settings.recentdonate_settings || '{}'); } catch (_) {}
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
      try { c = JSON.parse(data.recentdonate_settings || '{}'); } catch (_) {}
      if (!c.enabled && !isDemo()) return;
      wrapper.style.display = '';
      applySettings(c);
      connectSSE();
      relTimeTimer = setInterval(tickRelativeTimes, 30000);
    } catch (e) {
      console.error('Recent donate init failed:', e.message);
    }
  }

  init();
})();
