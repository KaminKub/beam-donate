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

  let animInProgress = false;
  let pendingUpdate = null;
  let animDelayTimer = null;
  let hadFirstOpen = false;

  let capState = { capType: null, capValue: 0, capCurrent: 0 };

  let alertDurationMs = 8000;
  let goalBarAnimEnabled = true;
  const GOALBAR_ANIM_BUFFER_MS = 4000;

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
    // ห้ามยิง timeout กลาง animation — ease-in ทำให้เลขค้าง 0 ช่วงแรกของ anim บวกเวลา
    // ไม่งั้น timeoutFired ถูก set ซ้ำ → getCurrentRemaining คืน 0 ตลอด anim (เลขแช่ที่ 00:00)
    if (r <= 0 && isRunning && !animInProgress) handleTimeout();
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
      const shineOn = s.shine_enabled !== false && s.shine_enabled !== 0;
      digitsEl.classList.toggle('shine-off', !shineOn);
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

    // B1: sync cap config จาก settings (capCurrent มาจาก init/SSE เท่านั้น)
    capState.capType = s.cap_type || null;
    capState.capValue = s.cap_value || 0;
    updateCapDisplay();
  }

  // B1: cap เต็ม → แทน rules ด้วย "ปิดปรับเวลาแบบอัตโนมัติ" (สำคัญกว่า show_rules toggle)
  function updateCapDisplay() {
    if (!rulesEl) return;
    const { capType, capValue, capCurrent } = capState;
    const isFull = capType && capValue > 0 && capCurrent >= capValue;

    if (isFull) {
      rulesEl.replaceChildren();
      const div = document.createElement('div');
      div.className = 'timer-cap-full';
      div.textContent = 'ปิดปรับเวลา\n(ครบเป้าหมายแล้ว)';
      rulesEl.appendChild(div);
      rulesEl.style.display = '';
      return;
    }

    const showRules = settings.show_rules !== false && settings.show_rules !== 0;
    if (showRules && settings.rules && settings.rules.length) {
      rulesEl.replaceChildren();
      const template = settings.rules_template || 'โดเนท {จำนวนเงิน}฿ {เครื่องหมาย}{เวลา}';
      settings.rules.forEach(rule => {
        const div = document.createElement('div');
        div.className = 'timer-rule-line';
        const isCoin = (rule.currency || 'thb') === 'coin';
        const tpl = isCoin
          ? (settings.rules_template_coin || 'Gift {จำนวนเงิน} เหรียญ {เครื่องหมาย}{เวลา}')
          : template;
        div.textContent = interpolateRule(tpl, rule.amount || rule.base_amount || 0, rule.time_seconds || 0, rule.action || 'add');
        rulesEl.appendChild(div);
      });
      rulesEl.style.display = '';
    } else {
      rulesEl.style.display = 'none';
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

  let _sharedAc = null;
  function getAc() {
    if (!_sharedAc || _sharedAc.state === 'closed') _sharedAc = new (window.AudioContext || window.webkitAudioContext)();
    if (_sharedAc.state === 'suspended') _sharedAc.resume();
    return _sharedAc;
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
        const ctx = getAc();
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
    if (data.type === 'settings_update' && data.settings) {
      if (data.settings.duration) alertDurationMs = (Number(data.settings.duration) || 8) * 1000;
      goalBarAnimEnabled = data.settings.goal_anim_enabled !== 0 && data.settings.goal_anim_enabled !== false;
      try {
        const t = JSON.parse(data.settings.timer_settings || '{}');
        if (data.settings.timer_cap_current !== undefined) capState.capCurrent = data.settings.timer_cap_current || 0;
        applySettings(t);
      } catch (e) {}
    }

    if (data.type === 'timer_update') {
      // B1: อัปเดต cap ก่อน branch อื่นทั้งหมด — animation path มี return กลางทาง
      if (data.capType !== undefined) {
        const nc = { capType: data.capType || null, capValue: data.capValue || 0, capCurrent: data.capCurrent || 0 };
        if (nc.capType !== capState.capType || nc.capValue !== capState.capValue || nc.capCurrent !== capState.capCurrent) {
          capState = nc;
          updateCapDisplay();
        }
      }
      const delta = data.delta || 0;
      const newRemaining = data.remaining !== undefined ? data.remaining : remainingSeconds;
      const animOn = settings.timer_anim_enabled !== false && settings.timer_anim_enabled !== 0;

      if (animOn && delta !== 0) {
        const overlayDelay = (data.overlayOnline && alertDurationMs > 0) ? alertDurationMs : 0;
        const goalBarDelay = (data.goalBarOnline && goalBarAnimEnabled) ? GOALBAR_ANIM_BUFFER_MS : 0;
        // immediate=true → manual control button (Live mode) → ข้าม alert+goalbar delay ทันที
        // immediate=false (default) → donation path ทั้ง 5 จุด → sequence Alert→GoalBar→Timer เดิม
        const totalDelay = data.immediate ? 0 : (overlayDelay + goalBarDelay);

        const pending = { remaining: newRemaining, running: !!data.running, lastUpdate: data.lastUpdate };

        if (totalDelay > 0) {
          pendingUpdate = pending;
          clearTimeout(animDelayTimer);
          animDelayTimer = setTimeout(() => {
            if (!pendingUpdate) return;
            // anim อื่นกำลังเล่น → เก็บ pendingUpdate ไว้ให้ finishAnimation เล่นต่อ ห้ามทิ้ง (update หายถาวร)
            if (animInProgress) return;
            const p = pendingUpdate;
            pendingUpdate = null;
            const nowRemaining = Math.round(getCurrentRemaining());
            const delayedDelta = p.remaining - nowRemaining;
            startDeltaAnimation(delayedDelta, nowRemaining, p.remaining, p.running, p.lastUpdate);
          }, totalDelay);
        } else {
          if (animInProgress) {
            pendingUpdate = pending;
          } else {
            // event นี้ใหม่กว่า pendingUpdate ที่ค้างคิวเสมอ (remaining เป็นค่าสะสมจาก server)
            // — เคลียร์ทิ้งกัน finishAnimation เอา state เก่ามาทับทีหลัง (เวลาถอยกลับ)
            pendingUpdate = null;
            clearTimeout(animDelayTimer);
            startDeltaAnimation(delta, remainingSeconds, newRemaining, !!data.running, data.lastUpdate);
          }
        }
        return;
      }

      if (animInProgress) {
        pendingUpdate = { remaining: newRemaining, delta: 0, running: !!data.running, lastUpdate: data.lastUpdate };
        return;
      }
      pendingUpdate = null;
      clearTimeout(animDelayTimer);
      remainingSeconds = newRemaining;
      lastUpdateTs = data.lastUpdate ? new Date(data.lastUpdate).getTime() : Date.now();
      isRunning = !!data.running;
      if (remainingSeconds > 0) {
        timeoutFired = false;
        wrapper.classList.remove('timer-expired');
      }
    }
  }

  function settingsUrl() {
    const isDemo = window.DEMO_MODE === true;
    return isDemo
      ? '/api/demo/overlay/settings'
      : (token ? `/api/overlay/settings?token=${encodeURIComponent(token)}` : '/api/overlay/settings');
  }

  async function init() {
    try {
      const isDemo = window.DEMO_MODE === true;
      const res = await fetch(settingsUrl());
      if (!res.ok) return;
      const data = await res.json();

      let t = {};
      try { t = JSON.parse(data.timer_settings || '{}'); } catch (e) {}

      if (data.duration) alertDurationMs = (Number(data.duration) || 8) * 1000;
      goalBarAnimEnabled = data.goal_anim_enabled !== 0 && data.goal_anim_enabled !== false;

      if (!t.enabled && !isDemo) return;

      wrapper.style.display = '';
      capState.capCurrent = data.timer_cap_current || 0; // seed ก่อน applySettings — cap อาจเต็มตั้งแต่โหลดหน้า
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

    eventSource.onopen = function() {
      reconnectDelay = 2000;
      // reconnect (ไม่ใช่ connect แรก) → timer_update ระหว่างหลุดอาจหายไป — ดึง state จริงมาทับ
      if (hadFirstOpen) resyncState();
      hadFirstOpen = true;
    };

    eventSource.onerror = function() {
      eventSource.close();
      eventSource = null;
      setTimeout(connectSSE, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    };
  }

  // Re-sync timer state หลัง SSE reconnect — โดเนทช่วงหลุด (server restart/network blip) จะไม่หายอีก
  async function resyncState() {
    try {
      const res = await fetch(settingsUrl());
      if (!res.ok) return;
      const data = await res.json();
      // มี anim/queue ค้างอยู่ = มี event ใหม่กว่ากำลังจัดการ — ข้าม (event ถัดไป sync เอง)
      if (animInProgress || pendingUpdate) return;
      capState.capCurrent = data.timer_cap_current || 0;
      updateCapDisplay();
      remainingSeconds = data.timer_remaining_seconds ?? remainingSeconds;
      isRunning = !!data.timer_running;
      lastUpdateTs = data.timer_last_update ? new Date(data.timer_last_update).getTime() : Date.now();
      const cur = (isRunning && lastUpdateTs)
        ? remainingSeconds - (Date.now() - lastUpdateTs) / 1000
        : remainingSeconds;
      if (cur > 0) { timeoutFired = false; wrapper.classList.remove('timer-expired'); }
    } catch (e) {}
  }

  function animSoundOn() {
    return settings.timer_anim_sound_enabled !== false && settings.timer_anim_sound_enabled !== 0;
  }

  function calcAnimDuration(absDelta) {
    if (absDelta <= 15)  return 2500;
    if (absDelta <= 60)  return 4000;
    if (absDelta <= 300) return 5500;
    return 7000;
  }

  function formatDeltaDisplay(secs, timeUnit) {
    const s = Math.abs(Math.round(secs));
    if (timeUnit === 'minutes') {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
      return `${m}:${String(r).padStart(2, '0')}`;
    }
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }
    return String(s);
  }

  function shakeTimerOnce(cls) {
    if (!wrapper) return;
    wrapper.classList.remove(cls);
    void wrapper.offsetWidth;
    wrapper.classList.add(cls);
    setTimeout(() => wrapper.classList.remove(cls), 250);
  }

  function glowTimer() {
    if (!wrapper) return;
    wrapper.classList.remove('timer-anim-glow');
    void wrapper.offsetWidth;
    wrapper.classList.add('timer-anim-glow');
    setTimeout(() => wrapper.classList.remove('timer-anim-glow'), 800);
  }

  function startDeltaAnimation(delta, startRemaining, newRemaining, newRunning, newLastUpdate) {
    animInProgress = true;
    // A1: ใช้ค่าจริงปัจจุบันเป็นจุดเริ่มนับ (ต้องเรียกก่อน clear timeoutFired — ตอน timeout ค่าจริงคือ 0)
    startRemaining = Math.round(getCurrentRemaining());
    if (newRemaining > 0) {
      timeoutFired = false;
      wrapper.classList.remove('timer-expired');
    }
    const absDelta = Math.abs(delta);
    const duration = calcAnimDuration(absDelta);
    const isAdd = delta > 0;
    const timeUnit = settings.time_unit || 'minutes';

    const deltaEl = document.getElementById('timerDeltaEl');
    if (!deltaEl) { finishAnimation(newRemaining, newRunning, newLastUpdate); return; }

    const digitsRect = digitsEl ? digitsEl.getBoundingClientRect() : null;
    const topY = digitsRect ? digitsRect.top + digitsRect.height + 18 : 90;
    deltaEl.style.top = topY + 'px';
    deltaEl.style.transform = 'translateX(-50%) translateY(18px) scale(0.85)';
    deltaEl.className = `delta-${isAdd ? 'add' : 'sub'}`;
    deltaEl.textContent = (isAdd ? '+' : '-') + formatDeltaDisplay(absDelta, timeUnit);
    deltaEl.style.display = '';
    // inline base = ค่า "จบ entrance" (centered) — หลัง cancel WAAPI จะไม่ snap กลับ 18px
    deltaEl.style.opacity = '1';
    deltaEl.style.transform = 'translateX(-50%) translateY(0) scale(1)';

    const entranceAnim = deltaEl.animate([
      { opacity: 0, transform: 'translateX(-50%) translateY(18px) scale(0.85)' },
      { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)' }
    ], { duration: 220, easing: 'cubic-bezier(0.34,1.56,0.64,1)', fill: 'forwards' });

    if (animSoundOn()) playDeltaEntrance(isAdd);

    lastUpdateTs = null;

    const start = performance.now();
    let lastTickSecond = -1;

    function frame(now) {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      const progress = t * t * t;

      const currentDelta = absDelta * (1 - progress);
      deltaEl.textContent = (isAdd ? '+' : '-') + formatDeltaDisplay(currentDelta, timeUnit);

      const syncedRemaining = startRemaining + (newRemaining - startRemaining) * progress;
      remainingSeconds = Math.max(0, Math.round(syncedRemaining));

      const currentSecond = Math.floor(elapsed / 1000);
      if (currentSecond !== lastTickSecond && currentSecond >= 1) {
        lastTickSecond = currentSecond;
        shakeTimerOnce('timer-tick-shake');
        if (animSoundOn()) {
          playCountdownTick(progress);
        }
      }

      if (t > 0.72 && digitsEl) {
        if (entranceAnim.playState !== 'idle') entranceAnim.cancel(); // ปลด WAAPI → inline คุม drift/fade ได้
        const driftP = (t - 0.72) / 0.28;
        const dRect = digitsEl.getBoundingClientRect();
        const eRect = deltaEl.getBoundingClientRect();
        const dx = (dRect.left + dRect.width / 2) - (eRect.left + eRect.width / 2);
        const dy = (dRect.top + dRect.height / 2) - (eRect.top + eRect.height / 2);
        deltaEl.style.transform = `translateX(calc(-50% + ${dx * driftP}px)) translateY(${dy * driftP}px) scale(${1 - driftP * 0.3})`;
        deltaEl.style.opacity = String(Math.max(0, 1 - driftP));
      }

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        onAnimationDone();
      }
    }

    requestAnimationFrame(frame);

    function onAnimationDone() {
      deltaEl.style.display = 'none';
      deltaEl.style.opacity = '0';
      deltaEl.style.transform = 'translateX(-50%)';
      finishAnimation(newRemaining, newRunning, newLastUpdate);
      glowTimer();
      if (animSoundOn()) {
        playGlowComplete();
      }
    }
  }

  function finishAnimation(newRemaining, newRunning, newLastUpdate) {
    remainingSeconds = newRemaining;
    isRunning = newRunning;
    lastUpdateTs = newLastUpdate ? new Date(newLastUpdate).getTime() : Date.now();
    if (remainingSeconds > 0) { timeoutFired = false; wrapper.classList.remove('timer-expired'); }
    animInProgress = false;
    if (pendingUpdate) {
      const p = pendingUpdate;
      pendingUpdate = null;
      const pDelta = p.remaining - remainingSeconds;
      if (Math.abs(pDelta) > 0) {
        startDeltaAnimation(pDelta, remainingSeconds, p.remaining, p.running, p.lastUpdate);
      } else {
        remainingSeconds = p.remaining;
        isRunning = p.running;
        lastUpdateTs = p.lastUpdate ? new Date(p.lastUpdate).getTime() : Date.now();
      }
    }
  }

  function animVol() {
    const v = settings.timer_anim_sound_volume;
    return (v === undefined || v === null || isNaN(v)) ? 1 : v;
  }

  function playDeltaEntrance(isAdd) {
    try {
      const ctx = getAc();
      const vol = animVol();
      const freqs = isAdd ? [523, 784, 1047] : [1047, 784, 523];
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        const t = ctx.currentTime + i * 0.07;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.25 * vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.start(t); osc.stop(t + 0.2);
      });
    } catch (e) {}
  }

  function playCountdownTick(progress) {
    try {
      const ctx = getAc();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.value = 380 + progress * 260;
      gain.gain.setValueAtTime((0.12 + progress * 0.08) * animVol(), ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.055);
      osc.start(); osc.stop(ctx.currentTime + 0.07);
    } catch (e) {}
  }

  function playGlowComplete() {
    try {
      const ctx = getAc();
      const vol = animVol();
      [523, 659, 784, 1047].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        const t = ctx.currentTime + i * 0.045;
        gain.gain.setValueAtTime(0.22 * vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
        osc.start(t); osc.stop(t + 0.42);
      });
    } catch (e) {}
  }

  // R9: origin-checked postMessage for dashboard test button
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === 'test_effect') {
      wrapper.classList.remove('timer-expired', 'timer-effect-shake');
      settings.timeout_effect_emoji = e.data.emoji || '🎉';
      triggerTimeoutEffect(e.data.effect || 'blink');
    }
    if (e.data?.type === 'test_delta_anim' && typeof e.data.delta === 'number') {
      if (e.data.timeUnit) settings.time_unit = e.data.timeUnit;
      const delta = e.data.delta;
      const currentRemaining = Math.max(0, Math.round(getCurrentRemaining()));
      const newRemaining = Math.max(0, currentRemaining + delta);
      if (animInProgress) {
        pendingUpdate = { remaining: newRemaining, running: isRunning, lastUpdate: new Date().toISOString() };
      } else {
        startDeltaAnimation(delta, currentRemaining, newRemaining, isRunning, new Date().toISOString());
      }
    }
    if (e.data?.type === 'timer_control') {
      const { action } = e.data;
      if (action === 'start') { isRunning = true; lastUpdateTs = Date.now(); }
      else if (action === 'stop') { remainingSeconds = Math.max(0, Math.round(getCurrentRemaining())); isRunning = false; lastUpdateTs = null; }
      else if (action === 'reset') { remainingSeconds = Math.round(settings.initial_seconds || 600); isRunning = false; lastUpdateTs = null; timeoutFired = false; wrapper.classList.remove('timer-expired'); }
    }
  });

  init();
})();
