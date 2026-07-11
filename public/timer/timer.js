(function() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';

  let remainingSeconds = 600;
  let lastUpdateTs = null;
  let isRunning = false;
  let settings = {};
  let eventSource = null;
  let reconnectDelay = 2000;
  let timeoutFired = false;
  let lastDisplayStr = '';

  const wrapper = document.getElementById('timerWrapper');
  const digitsEl = document.getElementById('timerDigits');
  const rulesEl = document.getElementById('timerRules');

  function pad(n) { return String(Math.max(0, n)).padStart(2, '0'); }

  function formatTime(secs) {
    const s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  function formatTimeDelta(sec) {
    const s = Math.abs(Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0 && m > 0) return `${h} ชม. ${m} นาที`;
    if (h > 0) return `${h} ชม.`;
    if (m > 0 && rem > 0) return `${m} นาที ${rem} วินาที`;
    if (m > 0) return `${m} นาที`;
    return `${rem} วินาที`;
  }

  function getCurrentRemaining() {
    if (timeoutFired) return 0;
    if (!isRunning || !lastUpdateTs) return remainingSeconds;
    const elapsed = (Date.now() - lastUpdateTs) / 1000;
    return Math.max(0, remainingSeconds - elapsed);
  }

  function handleTimeout() {
    if (timeoutFired) return;
    timeoutFired = true;
    isRunning = false;
    playTimeoutSound();
    const effectType = settings.timeout_effect_type || 'blink';
    triggerTimeoutEffect(effectType);
  }

  function triggerTimeoutEffect(type) {
    if (type === 'none') return;
    if (type === 'blink') { wrapper.classList.add('timer-expired'); return; }
    if (type === 'shake') {
      wrapper.classList.add('timer-effect-shake');
      setTimeout(() => wrapper.classList.remove('timer-effect-shake'), 700);
      return;
    }
    if (type === 'party') { launchConfetti(); return; }
    if (type === 'emoji') { launchEmojiExplosion(settings.timeout_effect_emoji || '🎉'); return; }
  }

  function launchConfetti() {
    const canvas = document.getElementById('timerEffectCanvas');
    if (!canvas) return;
    canvas.style.display = '';
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#fbbf24','#10b981','#3b82f6','#ef4444','#a78bfa','#06b6d4','#f97316'];
    const particles = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width, y: -20,
      vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2 + 1,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: Math.random() * 10 + 5,
      rot: Math.random() * 360, rotV: (Math.random() - 0.5) * 5,
    }));
    let frame = 0;
    function animate() {
      if (frame++ > 260) { canvas.style.display = 'none'; return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.rot += p.rotV;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot * Math.PI / 180);
        ctx.fillStyle = p.color; ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
        ctx.restore();
      });
      requestAnimationFrame(animate);
    }
    animate();
  }

  function launchEmojiExplosion(emoji) {
    const canvas = document.getElementById('timerEffectCanvas');
    if (!canvas) return;
    canvas.style.display = '';
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    // pre-render emoji once to avoid per-frame text parsing jank
    const eSize = 56;
    const off = Object.assign(document.createElement('canvas'), { width: eSize + 8, height: eSize + 8 });
    const offCtx = off.getContext('2d');
    offCtx.font = `${eSize}px sans-serif`;
    offCtx.textAlign = 'center'; offCtx.textBaseline = 'middle';
    offCtx.fillText(emoji, (eSize + 8) / 2, (eSize + 8) / 2);
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const particles = Array.from({ length: 18 }, () => ({
      x: cx, y: cy,
      vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.75) * 10,
      scale: Math.random() * 0.7 + 0.6, alpha: 1,
    }));
    let frame = 0;
    function animate() {
      if (frame++ > 100) { canvas.style.display = 'none'; return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.alpha -= 0.01;
        if (p.alpha <= 0) return;
        const w = (eSize + 8) * p.scale, h = (eSize + 8) * p.scale;
        ctx.save(); ctx.globalAlpha = p.alpha;
        ctx.drawImage(off, p.x - w / 2, p.y - h / 2, w, h);
        ctx.restore();
      });
      requestAnimationFrame(animate);
    }
    animate();
  }

  function tick() {
    const r = getCurrentRemaining();
    if (digitsEl) {
      const s = formatTime(r);
      if (s !== lastDisplayStr) { digitsEl.textContent = s; lastDisplayStr = s; }
    }
    if (r <= 0 && isRunning) handleTimeout();
  }

  setInterval(tick, 100);

  function applySettings(s) {
    if (!s) return;
    settings = s;
    // R5 migration: derive timeout_effect_type from legacy key
    if (!settings.timeout_effect_type) {
      settings.timeout_effect_type = (settings.timeout_effect === false || settings.timeout_effect === 0) ? 'none' : 'blink';
    }
    timeoutFired = false;
    wrapper.classList.remove('timer-expired');

    if (digitsEl) {
      digitsEl.style.fontSize = (s.font_size || 64) + 'px';
      digitsEl.style.setProperty('--timer-main-color', s.color_main || '#fbbf24');
      const shaneOn = s.shane_enabled !== false && s.shane_enabled !== 0;
      digitsEl.classList.toggle('shine-off', !shaneOn);
      digitsEl.style.animation = '';
      // outline: controlled by border_radius value (0 = off); ?? avoids || treating 0 as falsy
      const radius = Math.min(5, Math.max(0, s.border_radius ?? 0));
      const filterVal = radius > 0 ? 'url(#timer-outline)' : 'none';
      digitsEl.style.filter = filterVal;
      if (rulesEl) rulesEl.style.filter = filterVal;
      const morphEl = document.querySelector('#timer-outline feMorphology');
      if (morphEl) morphEl.setAttribute('radius', radius);
      const floodEl = document.querySelector('#timer-outline feFlood');
      if (floodEl) floodEl.setAttribute('flood-color', s.outline_color || '#000000');
    }

    if (rulesEl) {
      const showRules = s.show_rules !== false && s.show_rules !== 0;
      if (showRules && s.rules && s.rules.length) {
        rulesEl.replaceChildren();
        const template = s.rules_template || 'โดเนท {จำนวนเงิน}฿ {เครื่องหมาย}{เวลา}';
        s.rules.forEach(rule => {
          const div = document.createElement('div');
          div.className = 'timer-rule-line';
          div.textContent = interpolateRule(template, rule.amount || rule.base_amount || 0, rule.time_seconds || 0, rule.action || 'add');
          rulesEl.appendChild(div);
        });
        rulesEl.style.display = '';
      } else {
        rulesEl.style.display = 'none';
      }
    }
  }

  function interpolateRule(template, amount, timeSec, action) {
    const sign = action === 'add' ? '+' : action === 'sub' ? '-' : '±';
    const actionWord = action === 'add' ? 'เพิ่ม' : action === 'sub' ? 'ลด' : 'เพิ่มหรือลด';
    return template
      .replace(/{จำนวนเงิน}/g, Number(amount).toLocaleString('th-TH'))
      .replace(/{เวลา}/g, formatTimeDelta(timeSec))
      .replace(/{เครื่องหมาย}/g, sign)
      .replace(/{ทิศทาง}/g, actionWord);
  }

  function playTimeoutSound() {
    if (settings.sound_enabled === false || settings.sound_enabled === 0) return;
    const rawVol = settings.sound_volume;
    const vol = (rawVol === undefined || rawVol === null || isNaN(rawVol)) ? 0.7 : rawVol;
    const choice = settings.sound_choice || settings.sound_type || 'synthetic';
    if ((choice === 'url' || choice === 'upload') && settings.sound_url) {
      const audio = new Audio(settings.sound_url);
      audio.volume = vol;
      audio.play().catch(() => {});
    } else {
      try {
        const ctx = new AudioContext();
        [880, 660, 440].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(vol * 0.3, ctx.currentTime + i * 0.3);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.3 + 0.25);
          osc.start(ctx.currentTime + i * 0.3);
          osc.stop(ctx.currentTime + i * 0.3 + 0.3);
        });
      } catch (e) {}
    }
  }

  function handleEvent(data) {
    if (data.type === 'timer_update') {
      if (data.remaining !== undefined) remainingSeconds = data.remaining;
      lastUpdateTs = data.lastUpdate ? new Date(data.lastUpdate).getTime() : Date.now();
      isRunning = !!data.running;
      if (remainingSeconds > 0 && isRunning) {
        timeoutFired = false;
        wrapper.classList.remove('timer-expired');
      }
    }
    if (data.type === 'settings_update' && data.settings) {
      try {
        const t = JSON.parse(data.settings.timer_settings || '{}');
        applySettings(t);
      } catch (e) {}
    }
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

      let t = {};
      try { t = JSON.parse(data.timer_settings || '{}'); } catch (e) {}

      if (!t.enabled && !isDemo) return;

      wrapper.style.display = '';
      applySettings(t);

      remainingSeconds = data.timer_remaining_seconds ?? (t.initial_seconds || 600);
      isRunning = !!data.timer_running;
      if (data.timer_last_update && isRunning) {
        lastUpdateTs = new Date(data.timer_last_update).getTime();
      }

      connectSSE();
    } catch (e) {
      console.error('Timer init failed:', e.message);
    }
  }

  function connectSSE() {
    if (eventSource) eventSource.close();
    const isDemo = window.DEMO_MODE === true;
    const streamUrl = isDemo
      ? '/api/demo/alerts/stream?source=demo-timer'
      : (token ? `/api/alerts/stream?token=${encodeURIComponent(token)}&source=timer` : '/api/alerts/stream?source=timer');
    eventSource = new EventSource(streamUrl);

    eventSource.onmessage = function(e) {
      try { handleEvent(JSON.parse(e.data)); } catch (err) {}
    };

    eventSource.onopen = function() { reconnectDelay = 2000; };

    eventSource.onerror = function() {
      eventSource.close();
      eventSource = null;
      setTimeout(connectSSE, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    };
  }

  // R9: origin-checked postMessage for dashboard test button
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === 'test_effect') {
      wrapper.classList.remove('timer-expired', 'timer-effect-shake');
      settings.timeout_effect_emoji = e.data.emoji || '🎉';
      triggerTimeoutEffect(e.data.effect || 'blink');
    }
  });

  init();
})();
