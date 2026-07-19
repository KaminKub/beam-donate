(function() {
  const _params = new URLSearchParams(location.search);
  const token = _params.get('token') || '';
  // URL param overrides DB setting: ?bottom or ?position=bottom
  const urlPosition = _params.has('bottom') || _params.get('position') === 'bottom'
    ? 'bottom'
    : _params.has('top') || _params.get('position') === 'top' ? 'top' : null;

  let barColor = '#4ade80';
  let goalAmount = 0;
  let goalCurrent = 0;
  let goalLabel = 'ค่ากาแฟ';
  let goalBarText = '{เปอร์เซนต์}';
  let goalSubtitle1 = '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿';
  let goalSubtitle2 = '';
  let goalEndDate = null;
  let eventSource = null;
  let reconnectDelay = 2000;

  let animCurrent = 0;
  let animTarget = 0;
  let animFrom = 0;
  let animStartTime = 0;
  let animDuration = 800;
  let animFrameId = null;
  let isFirstUpdate = true;
  let pendingGoalUpdate = null;
  let alertDurationMs = 8000;
  let animEnabled = true;
  let isWaitingForOverlay = false;
  let overlayWaitTimer = null;
  let goalBarLayout = 'horizontal';
  let pointerEnabled = false;
  let pointerSide = 'right';
  let pointerContent = 'both';
  let lastDonor = '';
  let lastAmount = 0;
  let amountSuffix = '฿';

  function normalizeAmountSuffix(suffix) {
    return (suffix === 'บาท' || suffix === 'THB') ? '฿' : (suffix || '฿');
  }

  const wrapper = document.getElementById('goalBarWrapper');
  const labelEl = document.getElementById('goalLabel');
  const fillEl = document.getElementById('goalFill');
  const barTextEl = document.getElementById('goalBarText');
  const sub1El = document.getElementById('goalSub1');
  const sub2El = document.getElementById('goalSub2');
  const labelTextEl = labelEl.querySelector('.goal-grad-label');
  const barTextTextEl = barTextEl.querySelector('.goal-grad-bar');
  const sub1TextEl = sub1El.querySelector('.goal-grad-sub1');
  const sub2TextEl = sub2El.querySelector('.goal-grad-sub2');
  const arrowEl = document.getElementById('goalPointerArrow');
  const pointerLabelEl = document.getElementById('goalPointerLabel');
  const ptrNameEl = pointerLabelEl.querySelector('.ptr-name');
  const ptrAmountEl = pointerLabelEl.querySelector('.ptr-amount');

  [labelEl, barTextEl, sub1El, sub2El].forEach(el => { if (el) el.style.whiteSpace = 'pre-wrap'; });

  function getDaysLeft(endDate) {
    if (!endDate) return null;
    const end = new Date(endDate);
    if (isNaN(end.getTime())) return null;
    const diff = Math.ceil((end - Date.now()) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  }

  function interpolate(template, pct, current, amount) {
    if (!template) return '';
    const daysLeft = getDaysLeft(goalEndDate);
    return template
      .replace(/{เปอร์เซนต์}/g, Math.round(pct) + '%')
      .replace(/{ยอดปัจจุบัน}/g, current.toLocaleString('th-TH', { maximumFractionDigits: 0 }))
      .replace(/{ยอดเป้าหมาย}/g, amount.toLocaleString('th-TH', { maximumFractionDigits: 0 }))
      .replace(/{ยอดคงเหลือ}/g, Math.max(0, amount - current).toLocaleString('th-TH', { maximumFractionDigits: 0 }))
      .replace(/{วันคงเหลือ}/g, daysLeft !== null ? daysLeft : '0');
  }

  function renderFillWidth(val) {
    const fillPct = Math.min(100, goalAmount > 0 ? (val / goalAmount) * 100 : 0);
    if (goalBarLayout === 'vertical') {
      fillEl.style.height = fillPct + '%';
      fillEl.style.width = '';
    } else {
      fillEl.style.width = fillPct + '%';
      fillEl.style.height = '';
    }
    return fillPct;
  }

  function updatePointer(enabled, side, content, donor, amount, fillPct) {
    pointerEnabled = !!enabled;
    pointerSide = (side === 'left') ? 'left' : 'right';
    pointerContent = ['name', 'amount', 'both', 'percent', 'current'].includes(content) ? content : 'both';
    if (donor !== undefined) lastDonor = String(donor || '');
    if (amount !== undefined) lastAmount = Number(amount) || 0;
    const pct = fillPct !== undefined
      ? fillPct
      : Math.min(100, goalAmount > 0 ? (goalCurrent / goalAmount) * 100 : 0);

    if (!arrowEl || !pointerLabelEl) return;

    const showPointer = pointerEnabled;
    arrowEl.style.opacity = showPointer ? '1' : '0';
    pointerLabelEl.style.opacity = showPointer ? '1' : '0';
    if (!showPointer) {
      wrapper.classList.remove('pointer-active-h');
      return;
    }

    // XSS-safe text rendering
    ptrNameEl.textContent = lastDonor;
    if (pointerContent === 'percent') {
      ptrAmountEl.textContent = Math.round(pct) + '%';
    } else if (pointerContent === 'current') {
      ptrAmountEl.textContent = goalCurrent.toLocaleString('th-TH', { maximumFractionDigits: 0 }) + ' ' + amountSuffix;
    } else {
      ptrAmountEl.textContent = lastAmount > 0
        ? lastAmount.toLocaleString('th-TH', { maximumFractionDigits: 0 }) + ' ' + amountSuffix
        : '';
    }

    ptrNameEl.style.display = (pointerContent === 'name' || pointerContent === 'both') ? '' : 'none';
    ptrAmountEl.style.display = (pointerContent === 'amount' || pointerContent === 'both' || pointerContent === 'percent' || pointerContent === 'current') ? '' : 'none';

    const isVertical = goalBarLayout === 'vertical';
    // ตำแหน่งตามปลาย fill: แนวนอน = left%, แนวตั้ง = bottom%
    // transform: แนวนอน set inline (translateX(-50%) จัดกึ่งกลาง);
    //            แนวตั้ง ปล่อยให้ CSS (.side-left/right) จัดการ translateY(50%) — ล้าง inline
    arrowEl.style.left = isVertical ? '' : pct + '%';
    arrowEl.style.bottom = isVertical ? pct + '%' : '';
    arrowEl.style.right = '';
    arrowEl.style.top = '';
    arrowEl.style.transform = isVertical ? '' : 'translateX(-50%)';
    pointerLabelEl.style.left = isVertical ? '' : pct + '%';
    pointerLabelEl.style.bottom = isVertical ? pct + '%' : '';
    pointerLabelEl.style.right = '';
    pointerLabelEl.style.top = '';
    pointerLabelEl.style.transform = isVertical ? '' : 'translateX(-50%)';
    pointerLabelEl.classList.remove('side-left', 'side-right');

    if (isVertical) {
      arrowEl.classList.add('vertical');
      pointerLabelEl.classList.add('vertical');
      pointerLabelEl.classList.add(pointerSide === 'left' ? 'side-left' : 'side-right');
      arrowEl.classList.toggle('side-left', pointerSide === 'left');
      arrowEl.classList.toggle('side-right', pointerSide === 'right');
    } else {
      arrowEl.classList.remove('vertical', 'side-left', 'side-right');
      pointerLabelEl.classList.remove('vertical', 'side-left', 'side-right');
    }
    // จองพื้นที่กัน overflow:hidden ตัดข้อความ เฉพาะแนวนอน (แนวตั้งอยู่ข้างหลอด ไม่กระทบความสูง)
    wrapper.classList.toggle('pointer-active-h', !isVertical);
  }

  function applyBarLayout(layout) {
    const next = layout === 'vertical' ? 'vertical' : 'horizontal';
    const changed = next !== goalBarLayout;
    goalBarLayout = next;
    wrapper.classList.toggle('layout-vertical', goalBarLayout === 'vertical');
    // สลับ layout แบบ live (settings_update): inline style ของแกนเก่า (width/height)
    // ยัง override CSS ของ layout ใหม่อยู่ — ต้อง re-render ทันที
    // ไม่งั้น fill หาย/ผิดขนาดจนกว่าจะมี goal_update ถัดไป
    if (changed && !isFirstUpdate) {
      renderFillWidth(goalCurrent);
      updatePointer(pointerEnabled, pointerSide, pointerContent);
    }
  }

  function renderTexts(val) {
    const actualPct = goalAmount > 0 ? (val / goalAmount) * 100 : 0;
    barTextTextEl.textContent = interpolate(goalBarText, actualPct, val, goalAmount);
    sub1TextEl.textContent = interpolate(goalSubtitle1, actualPct, val, goalAmount);
    sub2TextEl.textContent = goalSubtitle2 ? interpolate(goalSubtitle2, actualPct, val, goalAmount) : '';
  }

  let lastTextTs = 0;
  function animateCount(timestamp) {
    if (!animStartTime) animStartTime = timestamp;
    const elapsed = timestamp - animStartTime;
    const progress = Math.min(elapsed / animDuration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    animCurrent = Math.round(animFrom + (animTarget - animFrom) * eased);

    if (timestamp - lastTextTs >= 83 || progress >= 1) {
      lastTextTs = timestamp;
      renderTexts(animCurrent);
    }

    if (progress < 1) {
      animFrameId = requestAnimationFrame(animateCount);
    } else {
      animCurrent = animTarget;
      animFrameId = null;
      renderTexts(animTarget);
    }
  }

  function updateBar(current, amount, label, color, barText, subtitle1, subtitle2, endDate) {
    goalAmount = amount;
    if (label !== undefined) goalLabel = label;
    if (color) {
      barColor = color;
      fillEl.style.background = color;
      document.documentElement.style.setProperty('--bar-color', color);
    }
    if (barText !== undefined) goalBarText = barText || '';
    if (subtitle1 !== undefined) goalSubtitle1 = subtitle1 || '';
    if (subtitle2 !== undefined) goalSubtitle2 = subtitle2 || '';
    if (endDate !== undefined) goalEndDate = endDate || null;

    goalCurrent = current;

    labelTextEl.textContent = goalLabel;
    sub1El.className = goalSubtitle2 ? '' : 'centered';

    let fillPct = 0;
    if (isFirstUpdate) {
      animCurrent = current;
      isFirstUpdate = false;
      fillPct = renderFillWidth(current);
      renderTexts(current);
    } else if (current !== animCurrent) {
      if (animFrameId) cancelAnimationFrame(animFrameId);
      animFrom = animCurrent;
      animTarget = current;
      animStartTime = 0;
      fillPct = renderFillWidth(current);
      animFrameId = requestAnimationFrame(animateCount);
    } else {
      fillPct = renderFillWidth(current);
      renderTexts(current);
    }
    updatePointer(pointerEnabled, pointerSide, pointerContent, lastDonor, lastAmount, fillPct);
  }

  function applyBarPosition(pos) {
    const isBottom = pos === 'bottom';
    wrapper.classList.toggle('position-bottom', isBottom);
    document.body.classList.toggle('position-bottom', isBottom);
  }

  function applyTextSettings(c) {
    const root = document.documentElement.style;
    root.setProperty('--goal-color-label', c.color_label || '#ffffff');
    root.setProperty('--goal-color-bar', c.color_bar || '#ffffff');
    root.setProperty('--goal-color-sub1', c.color_sub1 || '#ffffff');
    root.setProperty('--goal-color-sub2', c.color_sub2 || '#ffffff');
    root.setProperty('--goal-font-label', c.font_size_label || 30);
    root.setProperty('--goal-font-bar', c.font_size_bar || 25);
    root.setProperty('--goal-font-sub1', c.font_size_sub1 || 20);
    root.setProperty('--goal-font-sub2', c.font_size_sub2 || 20);

    const oc = c.outline_color || '#000000';
    // ponytail: single outline_width applies to all 4 positions (merged 2026-07-18); fall back to old per-key field then 2
    const wRaw = parseInt(c.outline_width, 10);
    const wAny = Number.isFinite(wRaw) ? wRaw : parseInt(c.outline_width_label, 10);
    const MAP = { Label: 'label', Bar: 'bar', Sub1: 'sub1', Sub2: 'sub2' };
    Object.keys(MAP).forEach(p => {
      const key = MAP[p];
      const wFinal = Number.isFinite(wAny) ? Math.min(5, Math.max(0, wAny)) : 2;
      const dilate = document.getElementById('goalOutlineDilate' + p);
      const flood = document.getElementById('goalOutlineFlood' + p);
      if (dilate) dilate.setAttribute('radius', wFinal);
      if (flood) flood.setAttribute('flood-color', oc);
      const fn = wFinal > 0
        ? `url(#goal-outline-${key}) drop-shadow(0 2px 5px rgba(0,0,0,0.75))`
        : 'drop-shadow(0 2px 5px rgba(0,0,0,0.75))';
      root.setProperty('--goal-filter-' + key, fn);
    });
  }

  async function init() {
    try {
      const isDemo = window.DEMO_MODE === true;
      const settingsUrl = isDemo
        ? '/api/demo/overlay/settings'
        : (token ? `/api/overlay/settings?token=${encodeURIComponent(token)}` : '/api/overlay/settings');
      const res = await fetch(settingsUrl);
      if (!res.ok) return;
      const data = await res.json();

      if (!data.goal_enabled && !isDemo) return;

      pointerEnabled = data.goal_pointer_enabled !== 0 && data.goal_pointer_enabled !== false;
      pointerSide = data.goal_pointer_side || 'right';
      pointerContent = ['name', 'amount', 'both', 'percent', 'current'].includes(data.goal_pointer_content)
        ? data.goal_pointer_content
        : 'both';
      lastDonor = String(data.goal_last_donor || '');
      lastAmount = Number(data.goal_last_amount) || 0;
      amountSuffix = normalizeAmountSuffix(data.amountSuffix);
      if (typeof window.setGoalAnimAmountSuffix === 'function') {
        window.setGoalAnimAmountSuffix(amountSuffix);
      }

      wrapper.style.display = '';
      const color = data.goal_bar_color || '#4ade80';
      document.documentElement.style.setProperty('--bar-color', color);
      const raw = parseInt(data.goal_bar_width, 10);
      const barMaxWidth = (raw >= 300 && raw <= 1080) ? raw : 600;
      wrapper.style.setProperty('--bar-max-width', barMaxWidth + 'px');
      const rawThickness = parseInt(data.goal_bar_thickness, 10);
      const barThickness = (rawThickness >= 20 && rawThickness <= 140) ? rawThickness : 45;
      wrapper.style.setProperty('--bar-thickness', barThickness + 'px');
      if (data.fontFamily) {
        document.documentElement.style.setProperty('--font-family', `'${data.fontFamily}', 'Noto Sans Thai', sans-serif`);
      }

      alertDurationMs = (Number(data.duration) || 8) * 1000;

      applyBarPosition(urlPosition || data.goal_bar_position || 'top');
      applyBarLayout(data.goal_bar_layout || 'horizontal');
      if (data.goal_text_settings) {
        let gtc = {};
        try { gtc = JSON.parse(data.goal_text_settings); } catch (e) {}
        applyTextSettings(gtc);
      }
      animEnabled = data.goal_anim_enabled !== 0 && data.goal_anim_enabled !== false;
      if (typeof window.setGoalAnimSound === 'function') {
        window.setGoalAnimSound(data.goal_anim_sound !== 0 && data.goal_anim_sound !== false);
      }
      if (typeof window.setGoalAnimVolume === 'function') {
        window.setGoalAnimVolume(data.goal_anim_sound_volume);
      }

      updateBar(
        data.goal_current || 0,
        data.goal_amount || 5000,
        data.goal_label !== undefined ? data.goal_label : 'ค่ากาแฟ',
        color,
        data.goal_bar_text,
        data.goal_subtitle1,
        data.goal_subtitle2,
        data.goal_end_date
      );

      connectSSE();
    } catch (e) {
      console.error('Goal bar init failed:', e.message);
    }
  }

  function connectSSE() {
    if (eventSource) eventSource.close();

    const isDemo = window.DEMO_MODE === true;
    const streamUrl = isDemo
      ? '/api/demo/alerts/stream?source=demo-goal-bar'
      : (token ? `/api/alerts/stream?token=${encodeURIComponent(token)}&source=goal-bar` : '/api/alerts/stream?source=goal-bar');
    eventSource = new EventSource(streamUrl);

    eventSource.onmessage = function(e) {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'donation') {
          if (!animEnabled) return;
          const delay = (data.overlayOnline && alertDurationMs > 0) ? alertDurationMs : 0;
          if (delay > 0) {
            isWaitingForOverlay = true;
            clearTimeout(overlayWaitTimer);
            overlayWaitTimer = setTimeout(() => {
              isWaitingForOverlay = false;
              if (typeof window.triggerDonationAnimation === 'function') {
                window.triggerDonationAnimation(data.amount || 0);
              }
            }, delay);
          } else {
            if (typeof window.triggerDonationAnimation === 'function') {
              window.triggerDonationAnimation(data.amount || 0);
            }
          }
        }
        if (data.type === 'settings_update' && data.settings) {
          const s = data.settings;
          if (s.fontFamily) {
            document.documentElement.style.setProperty('--font-family', `'${s.fontFamily}', 'Noto Sans Thai', sans-serif`);
          }
          applyBarPosition(urlPosition || s.goal_bar_position || 'top');
          applyBarLayout(s.goal_bar_layout || 'horizontal');
          if (s.goal_pointer_enabled !== undefined) {
            pointerEnabled = s.goal_pointer_enabled !== 0 && s.goal_pointer_enabled !== false;
          }
          if (s.goal_pointer_side) pointerSide = s.goal_pointer_side;
          if (s.goal_pointer_content) pointerContent = s.goal_pointer_content;
          if (s.amountSuffix) {
            amountSuffix = normalizeAmountSuffix(s.amountSuffix);
            if (typeof window.setGoalAnimAmountSuffix === 'function') {
              window.setGoalAnimAmountSuffix(amountSuffix);
            }
          }
          updatePointer(pointerEnabled, pointerSide, pointerContent);
          if (s.goal_text_settings) {
            let gtc = {};
            try { gtc = JSON.parse(s.goal_text_settings); } catch (e) {}
            applyTextSettings(gtc);
          }
          animEnabled = s.goal_anim_enabled !== 0 && s.goal_anim_enabled !== false;
          if (typeof window.setGoalAnimSound === 'function') {
            window.setGoalAnimSound(s.goal_anim_sound !== 0 && s.goal_anim_sound !== false);
          }
          if (s.goal_anim_sound_volume !== undefined && typeof window.setGoalAnimVolume === 'function') {
            window.setGoalAnimVolume(s.goal_anim_sound_volume);
          }
        }
        if (data.type === 'goal_update') {
          const busy = isWaitingForOverlay ||
            (typeof window.isGoalAnimating === 'function' && window.isGoalAnimating());
          if (data.last_donor !== undefined) lastDonor = String(data.last_donor || '');
          if (data.last_amount !== undefined) lastAmount = Number(data.last_amount) || 0;
          if (busy) {
            pendingGoalUpdate = data;
          } else {
            updateBar(data.current, data.amount, data.label, data.barColor, data.barText, data.subtitle1, data.subtitle2, data.endDate);
          }
        }
      } catch (err) {}
    };

    window.onGoalAnimationComplete = function() {
      if (pendingGoalUpdate) {
        const d = pendingGoalUpdate;
        pendingGoalUpdate = null;
        updateBar(d.current, d.amount, d.label, d.barColor, d.barText, d.subtitle1, d.subtitle2, d.endDate);
      }
    };

    eventSource.onopen = function() {
      reconnectDelay = 2000;
    };

    eventSource.onerror = function() {
      eventSource.close();
      eventSource = null;
      setTimeout(connectSSE, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    };
  }

  init();
})();
