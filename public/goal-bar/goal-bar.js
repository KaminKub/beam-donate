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
  let goalLabel = '';
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

  const wrapper = document.getElementById('goalBarWrapper');
  const labelEl = document.getElementById('goalLabel');
  const fillEl = document.getElementById('goalFill');
  const barTextEl = document.getElementById('goalBarText');
  const sub1El = document.getElementById('goalSub1');
  const sub2El = document.getElementById('goalSub2');

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

  function renderBarDisplay(val) {
    const actualPct = goalAmount > 0 ? (val / goalAmount) * 100 : 0;
    const fillPct = Math.min(100, actualPct);
    fillEl.style.width = fillPct + '%';

    barTextEl.textContent = interpolate(goalBarText, actualPct, val, goalAmount);

    sub1El.textContent = interpolate(goalSubtitle1, actualPct, val, goalAmount);
    sub2El.textContent = goalSubtitle2 ? interpolate(goalSubtitle2, actualPct, val, goalAmount) : '';
  }

  function animateCount(timestamp) {
    if (!animStartTime) animStartTime = timestamp;
    const elapsed = timestamp - animStartTime;
    const progress = Math.min(elapsed / animDuration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    animCurrent = Math.round(animFrom + (animTarget - animFrom) * eased);

    renderBarDisplay(animCurrent);

    if (progress < 1) {
      animFrameId = requestAnimationFrame(animateCount);
    } else {
      animCurrent = animTarget;
      animFrameId = null;
      renderBarDisplay(animTarget);
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

    labelEl.textContent = goalLabel;
    sub1El.className = goalSubtitle2 ? '' : 'centered';

    if (isFirstUpdate) {
      animCurrent = current;
      isFirstUpdate = false;
      renderBarDisplay(current);
    } else if (current !== animCurrent) {
      if (animFrameId) cancelAnimationFrame(animFrameId);
      animFrom = animCurrent;
      animTarget = current;
      animStartTime = 0;
      animFrameId = requestAnimationFrame(animateCount);
    } else {
      renderBarDisplay(current);
    }
  }

  function applyBarPosition(pos) {
    const isBottom = pos === 'bottom';
    wrapper.classList.toggle('position-bottom', isBottom);
    document.body.classList.toggle('position-bottom', isBottom);
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

      wrapper.style.display = '';
      const color = data.goal_bar_color || '#4ade80';
      document.documentElement.style.setProperty('--bar-color', color);
      const raw = parseInt(data.goal_bar_width, 10);
      const barMaxWidth = (raw >= 300 && raw <= 1080) ? raw : 600;
      wrapper.style.setProperty('--bar-max-width', barMaxWidth + 'px');
      if (data.fontFamily) {
        document.documentElement.style.setProperty('--font-family', `'${data.fontFamily}', 'Noto Sans Thai', sans-serif`);
      }

      alertDurationMs = (Number(data.duration) || 8) * 1000;

      applyBarPosition(urlPosition || data.goal_bar_position || 'top');
      animEnabled = data.goal_anim_enabled !== 0 && data.goal_anim_enabled !== false;
      if (typeof window.setGoalAnimSound === 'function') {
        window.setGoalAnimSound(data.goal_anim_sound !== 0 && data.goal_anim_sound !== false);
      }

      updateBar(
        data.goal_current || 0,
        data.goal_amount || 5000,
        data.goal_label || 'ค่ากาแฟ',
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
          animEnabled = s.goal_anim_enabled !== 0 && s.goal_anim_enabled !== false;
          if (typeof window.setGoalAnimSound === 'function') {
            window.setGoalAnimSound(s.goal_anim_sound !== 0 && s.goal_anim_sound !== false);
          }
        }
        if (data.type === 'goal_update') {
          const busy = isWaitingForOverlay ||
            (typeof window.isGoalAnimating === 'function' && window.isGoalAnimating());
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
