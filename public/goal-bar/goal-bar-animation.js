(function () {
  'use strict';

  let isAnimating = false;
  let soundEnabled = true;
  let sharedAc = null;

  function getAudioCtx() {
    if (!sharedAc) sharedAc = new (window.AudioContext || window.webkitAudioContext)();
    if (sharedAc.state === 'suspended') sharedAc.resume();
    return sharedAc;
  }

  // ── Audio ─────────────────────────────────────────────────────────────────
  function playLogoPop() {
    if (!soundEnabled) return;
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.type = 'sine';
      // quick pitch sweep up = "pop" feel
      osc.frequency.setValueAtTime(280, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(560, ac.currentTime + 0.07);
      gain.gain.setValueAtTime(0, ac.currentTime);
      gain.gain.linearRampToValueAtTime(0.28, ac.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.14);
      osc.start();
      osc.stop(ac.currentTime + 0.15);
    } catch (_) {}
  }

  function playBubbleHit() {
    if (!soundEnabled) return;
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(80, ac.currentTime + 0.22);
      gain.gain.setValueAtTime(0, ac.currentTime);
      gain.gain.linearRampToValueAtTime(0.45, ac.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.28);
      osc.start();
      osc.stop(ac.currentTime + 0.3);
    } catch (_) {}
  }

  function playSparkle() {
    if (!soundEnabled) return;
    try {
      const ac = getAudioCtx();
      [880, 1320, 1760].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const t = ac.currentTime + i * 0.06;
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.start(t);
        osc.stop(t + 0.2);
      });
    } catch (_) {}
  }

  // ── Canvas helpers ────────────────────────────────────────────────────────
  const PAD = 220;

  function getCanvas(rect) {
    const c = document.getElementById('goalParticleCanvas');
    const left = Math.max(0, rect.left - PAD);
    const top = Math.max(0, rect.top - PAD);
    const w = Math.min(window.innerWidth, rect.right + PAD) - left;
    const h = Math.min(window.innerHeight, rect.bottom + PAD) - top;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.style.left = left + 'px';
    c.style.top = top + 'px';
    c.style.display = 'block';
    return { canvas: c, ctx: c.getContext('2d'), ox: left, oy: top };
  }

  function sparkleParticles() {
    const cardRect = document.getElementById('flipCard').getBoundingClientRect();
    const { canvas, ctx, ox, oy } = getCanvas(cardRect);
    const cx = cardRect.left + cardRect.width / 2;
    const cy = cardRect.top + cardRect.height / 2;

    const sparks = Array.from({ length: 24 }, () => ({
      angle: Math.random() * Math.PI * 2,
      speed: 1.5 + Math.random() * 3.5,
      r: 2 + Math.random() * 3,
      alpha: 1,
      x: cx,
      y: cy,
    }));

    let frame;
    let lastTs = null;
    function draw(ts) {
      const dt = lastTs === null ? 1 / 60 : Math.min((ts - lastTs) / 1000, 0.05);
      lastTs = ts;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(251,191,36,1)';
      let alive = false;
      sparks.forEach(s => {
        s.x += Math.cos(s.angle) * s.speed * dt * 60;
        s.y += Math.sin(s.angle) * s.speed * dt * 60;
        s.alpha -= 1.8 * dt;
        if (s.alpha <= 0) return;
        alive = true;
        ctx.globalAlpha = s.alpha;
        ctx.beginPath();
        ctx.arc(s.x - ox, s.y - oy, s.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      if (alive) {
        frame = requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
        cancelAnimationFrame(frame);
      }
    }
    frame = requestAnimationFrame(draw);
  }

  function hexToRgba(hex, alpha) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return isNaN(r) ? `rgba(74,222,128,${alpha})` : `rgba(${r},${g},${b},${alpha})`;
  }

  function liquidBubbles() {
    const track = document.getElementById('goalTrack');
    const rect = track.getBoundingClientRect();
    const { canvas, ctx, ox, oy } = getCanvas(rect);

    const barHex = getComputedStyle(document.documentElement)
      .getPropertyValue('--bar-color').trim() || '#4ade80';

    // Pre-parse hex once — avoids per-frame string ops inside draw loop
    const baseRgb = (() => {
      let h = barHex.replace('#', '');
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const r = parseInt(h.substring(0, 2), 16);
      const g = parseInt(h.substring(2, 4), 16);
      const b = parseInt(h.substring(4, 6), 16);
      return isNaN(r) ? '74,222,128' : `${r},${g},${b}`;
    })();

    const bubbles = Array.from({ length: 18 }, () => ({
      x: rect.left + Math.random() * rect.width,
      y: rect.top + rect.height * (0.2 + Math.random() * 0.8),
      r: 2.5 + Math.random() * 5.5,
      vy: -(0.5 + Math.random() * 1.3),
      phase: Math.random() * Math.PI * 2,
      life: 0,
    }));

    let frame;
    let lastTs = null;
    ctx.fillStyle = `rgba(${baseRgb},1)`;
    function draw(ts) {
      const dt = lastTs === null ? 1 / 60 : Math.min((ts - lastTs) / 1000, 0.05);
      lastTs = ts;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      bubbles.forEach(b => {
        b.life += dt;
        if (b.life > 1.8) return;
        alive = true;
        b.y += b.vy * dt * 60;
        b.x += 0.5 * Math.sin(b.life * 5 + b.phase) * dt * 60;
        const alpha = Math.max(0, 0.7 - b.life * 0.39);
        ctx.globalAlpha = alpha * 0.7;
        ctx.beginPath();
        ctx.arc(b.x - ox, b.y - oy, b.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      if (alive) {
        frame = requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
        cancelAnimationFrame(frame);
        isAnimating = false;
        if (typeof window.onGoalAnimationComplete === 'function') {
          window.onGoalAnimationComplete();
        }
      }
    }
    frame = requestAnimationFrame(draw);
  }

  // ── Step 5: Projectile ────────────────────────────────────────────────────
  function projectileToBar(amount) {
    const proj = document.createElement('div');
    proj.className = 'proj-amount';
    proj.textContent = '+' + amount.toLocaleString('th-TH') + '฿';
    document.body.appendChild(proj);

    const track = document.getElementById('goalTrack');
    const rect = track.getBoundingClientRect();
    const tx = rect.left + rect.width * 0.35;
    const ty = rect.top + rect.height / 2;
    const cardRect = document.getElementById('flipCard').getBoundingClientRect();
    const sx = cardRect.left + cardRect.width / 2;
    const sy = cardRect.top + cardRect.height / 2;
    const cpx = (sx + tx) / 2;
    const cpy = Math.min(sy, ty) - 55;

    const dur = 620;
    let t0 = null;

    function quad(t, a, b, c) {
      return (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;
    }

    function animate(ts) {
      if (!t0) t0 = ts;
      const p = Math.min((ts - t0) / dur, 1);
      const ep = p * p * (3 - 2 * p); // smoothstep easing
      proj.style.transform = `translate(-50%, -50%) translate3d(${quad(ep, sx, cpx, tx)}px, ${quad(ep, sy, cpy, ty)}px, 0)`;
      if (p < 1) {
        requestAnimationFrame(animate);
      } else {
        playBubbleHit();
        proj.remove();
        document.getElementById('animStage').style.display = 'none';
        liquidBubbles();
      }
    }

    requestAnimationFrame(animate);
  }

  // ── Step 3-4: 3D Card Flip ────────────────────────────────────────────────
  function cardFlip3D(amount) {
    const card = document.getElementById('flipCard');
    const amountEl = document.getElementById('flipAmountText');
    amountEl.textContent = '+' + amount.toLocaleString('th-TH') + '฿';

    const front = card.querySelector('.flip-front');
    const back = card.querySelector('.flip-back');

    gsap.timeline({
      onComplete() {
        sparkleParticles();
        setTimeout(() => projectileToBar(amount), 480);
      },
    })
      .to(card, {
        rotateY: 180,
        transformPerspective: 800,
        duration: 0.35,
        ease: 'power2.in',
        onComplete() {
          front.style.opacity = '0';
          back.style.opacity = '1';
          // sparkle fires on reveal (180°), not after 360° settle
          playSparkle();
        },
      })
      .to(card, {
        rotateY: 360,
        transformPerspective: 800,
        duration: 0.35,
        ease: 'power2.out',
      });
  }

  // ── Step 2: Logo Entrance ─────────────────────────────────────────────────
  function logoEntrance(amount) {
    const stage = document.getElementById('animStage');
    const card = document.getElementById('flipCard');
    const bar = document.getElementById('goalBarWrapper');
    const front = card.querySelector('.flip-front');
    const back = card.querySelector('.flip-back');
    const logoText = card.querySelector('.tipkub-logo-text');

    front.style.opacity = '1';
    back.style.opacity = '0';

    // Restart CSS shine animation each time
    logoText.style.animation = 'none';
    logoText.offsetHeight; // force reflow
    logoText.style.animation = '';

    // Place card just beside the bar so effects appear in open viewport space
    const isBottom = document.body.classList.contains('position-bottom');
    const barRect = bar.getBoundingClientRect();
    const vh = window.innerHeight;
    const GAP = 40;
    const CARD_H = 70;

    const rawTop = isBottom ? barRect.top - CARD_H - GAP : barRect.bottom + GAP;
    const cardTop = Math.max(GAP, Math.min(vh - CARD_H - GAP, rawTop));

    card.style.position = 'absolute';
    card.style.top = cardTop + 'px';
    card.style.left = 'calc(50% - 75px)';
    card.style.margin = '0';

    // Enter from bar side so card pops into open space (not clipped at far edge)
    const initY = isBottom ? 20 : -20;
    gsap.set(card, { rotateY: 0, scale: 0.5, opacity: 0, y: initY });
    stage.style.display = 'flex';

    playLogoPop();
    gsap.to(card, {
      scale: 1,
      opacity: 1,
      y: 0,
      duration: 0.48,
      ease: 'back.out(2)',
      onComplete: () => setTimeout(() => cardFlip3D(amount), 1200),
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.triggerDonationAnimation = function (amount) {
    if (isAnimating) return;
    isAnimating = true;
    try {
      logoEntrance(amount);
    } catch (err) {
      console.error('[GoalAnim] animation failed:', err);
      isAnimating = false;
      document.getElementById('animStage').style.display = 'none';
    }
  };

  window.isGoalAnimating = function () { return isAnimating; };

  window.setGoalAnimSound = function (enabled) { soundEnabled = !!enabled; };
  window.isGoalAnimSoundEnabled = function () { return soundEnabled; };
})();
