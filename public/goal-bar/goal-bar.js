(function() {
  const token = new URLSearchParams(location.search).get('token');
  if (!token) return;

  let barColor = '#4ade80';
  let goalAmount = 0;
  let goalCurrent = 0;
  let goalLabel = '';
  let goalBarText = '{เปอร์เซนต์}';
  let goalSubtitle1 = '{ยอดปัจจุบัน}/{ยอดเป้าหมาย}฿';
  let goalSubtitle2 = 'ปิดหลอดใน {วันคงเหลือ} วัน';
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

  const wrapper = document.getElementById('goalBarWrapper');
  const labelEl = document.getElementById('goalLabel');
  const fillEl = document.getElementById('goalFill');
  const barTextEl = document.getElementById('goalBarText');
  const sub1El = document.getElementById('goalSub1');
  const sub2El = document.getElementById('goalSub2');

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
      .replace(/{วันคงเหลือ}/g, daysLeft !== null ? daysLeft : '?');
  }

  function renderBarDisplay(val) {
    const actualPct = goalAmount > 0 ? (val / goalAmount) * 100 : 0;
    const fillPct = Math.min(100, actualPct);
    fillEl.style.width = fillPct + '%';

    const clampedPct = Math.max(5, Math.min(fillPct, 94));
    barTextEl.style.left = clampedPct + '%';
    barTextEl.textContent = interpolate(goalBarText, actualPct, val, goalAmount);

    const hasEndDate = !!goalEndDate;
    sub1El.textContent = interpolate(goalSubtitle1, actualPct, val, goalAmount);
    if (hasEndDate) {
      sub2El.textContent = interpolate(goalSubtitle2, actualPct, val, goalAmount);
    } else {
      sub2El.textContent = '';
    }
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
    const hasEndDate = !!goalEndDate;
    sub1El.className = hasEndDate ? '' : 'centered';

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

  async function init() {
    try {
      const res = await fetch(`/api/overlay/settings?token=${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const data = await res.json();

      if (!data.goal_enabled) return;

      wrapper.style.display = '';
      const color = data.goal_bar_color || '#4ade80';
      document.documentElement.style.setProperty('--bar-color', color);

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

    eventSource = new EventSource(`/api/alerts/stream?token=${encodeURIComponent(token)}`);

    eventSource.onmessage = function(e) {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'goal_update') {
          updateBar(data.current, data.amount, data.label, data.barColor, data.barText, data.subtitle1, data.subtitle2, data.endDate);
        }
      } catch (err) {}
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
