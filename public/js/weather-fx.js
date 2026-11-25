// Animación del clima sobre el mapa: lluvia (más densa según la intensidad) y relámpagos en tormenta eléctrica.
// Es solo una capa visual: no bloquea clics y se puede apagar tocando el indicador del clima.
const DROPS = [0, 380, 620, 900, 1150]; // gotas por cada 1000×700 px según la intensidad 0–4
const RINGS = [0, 14, 24, 36, 46];      // salpicaduras en el suelo, por la misma área

export function createWeatherFx({ canvas, flash }) {
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let drops = [], rings = [], intensity = 0, storm = false, raf = null, enabled = true, nextBolt = 0, bolt = null, w = 0, h = 0, dpr = 1;
  try { enabled = localStorage.getItem('av_wx_fx') !== 'off'; } catch {}

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width; h = r.height; canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }
  function seed() {
    const k = (w * h) / 700000 * (reduce ? .45 : 1);
    drops = Array.from({ length: Math.round(DROPS[intensity] * k) }, () => drop(true));
    rings = Array.from({ length: Math.round(RINGS[intensity] * k) }, () => ring(true));
  }
  function drop(anyY) {
    const z = Math.random(); // profundidad: las gotas cercanas son más largas, rápidas y opacas
    return { L: z < .5 ? 0 : z < .85 ? 1 : 2, x: Math.random() * (w + 160) - 40, y: anyY ? Math.random() * h : -30 - Math.random() * 80, len: 16 + z * 26 + intensity * 4, v: (11 + z * 12 + intensity * 2.5) * (reduce ? .5 : 1), a: .38 + z * .5, wdt: 1 + z * 1.4 };
  }
  function ring(anyT) { return { x: Math.random() * w, y: Math.random() * h, t: anyT ? Math.random() : 0, sp: .025 + Math.random() * .03, r: 5 + Math.random() * 7 + intensity * 1.5 }; }
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    const slant = .22 + intensity * .05;
    ctx.lineCap = 'round';
    // salpicaduras: anillos que se abren y desaparecen, como gotas cayendo en charcos
    ctx.lineWidth = 1.3;
    for (const r of rings) {
      r.t += r.sp; if (r.t >= 1) Object.assign(r, ring(false));
      ctx.strokeStyle = `rgba(225,240,255,${.75 * (1 - r.t)})`;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r * r.t + 1, (r.r * r.t + 1) * .42, 0, 0, 2 * Math.PI); ctx.stroke();
    }
    // gotas en 3 capas de profundidad (un solo trazo por capa: fluido incluso con mil gotas)
    for (let L = 0; L < 3; L++) {
      ctx.strokeStyle = ['rgba(215,232,250,.42)', 'rgba(230,242,255,.62)', 'rgba(245,250,255,.85)'][L];
      ctx.lineWidth = [1, 1.5, 2.1][L];
      ctx.beginPath();
      for (const d of drops) {
        if (d.L !== L) continue;
        ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.len * slant, d.y + d.len);
        d.y += d.v; d.x -= d.v * slant;
        if (d.y > h + 30 || d.x < -100) Object.assign(d, drop(false));
      }
      ctx.stroke();
    }
    if (storm && !reduce) {
      if (t > nextBolt) { strike(); nextBolt = t + 3500 + Math.random() * 6000; }
      if (bolt && t - bolt.t < 260) drawBolt(bolt, 1 - (t - bolt.t) / 260);
    }
    raf = requestAnimationFrame(frame);
  }
  function strike() {
    const x0 = w * (.15 + Math.random() * .7), pts = [[x0, 0]]; let x = x0, y = 0;
    while (y < h * (.45 + Math.random() * .3)) { y += 18 + Math.random() * 30; x += (Math.random() - .5) * 46; pts.push([x, y]); }
    bolt = { pts, t: performance.now() };
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(30); } catch {}
  }
  function drawBolt(b, k) {
    ctx.save(); ctx.strokeStyle = `rgba(255,255,240,${.95 * k})`; ctx.shadowColor = 'rgba(190,210,255,.9)'; ctx.shadowBlur = 18; ctx.lineWidth = 2.6; ctx.lineJoin = 'round';
    ctx.beginPath(); b.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.restore();
  }
  function stopAnim() { cancelAnimationFrame(raf); raf = null; ctx.clearRect(0, 0, w, h); }

  function apply() {
    const show = enabled && (intensity > 0 || storm); // tormenta sin lluvia: solo relámpagos
    canvas.parentElement.classList.toggle('wx-rain', show);
    canvas.parentElement.classList.toggle('wx-storm', show && storm);
    canvas.parentElement.dataset.wx = show ? intensity : 0;
    if (!show) { stopAnim(); return; } // con "reducir movimiento" la lluvia cae más lenta, con menos gotas y sin relámpagos
    resize(); if (!raf) raf = requestAnimationFrame(frame);
  }
  window.addEventListener('resize', () => { if (raf) resize(); });
  new ResizeObserver(() => { if (raf) resize(); }).observe(canvas.parentElement);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAnim(); else apply(); });

  return {
    set(w) { const i = w?.ok ? (w.intensity || 0) : 0, st = i >= 4 || !!w?.storm; if (i === intensity && st === storm) return; intensity = i; storm = st; nextBolt = performance.now() + 1500; apply(); },
    toggle() { enabled = !enabled; try { localStorage.setItem('av_wx_fx', enabled ? 'on' : 'off'); } catch {} apply(); return enabled; },
    get enabled() { return enabled; },
  };
}
