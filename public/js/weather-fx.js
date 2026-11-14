// Animación del clima sobre el mapa: lluvia (más densa según la intensidad) y relámpagos en tormenta eléctrica.
// Es solo una capa visual: no bloquea clics y se puede apagar tocando el indicador del clima.
const DROPS = [0, 90, 190, 330, 460]; // gotas por cada 1000×700 px según la intensidad 0–4

export function createWeatherFx({ canvas, flash }) {
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let drops = [], intensity = 0, storm = false, raf = null, enabled = true, nextBolt = 0, bolt = null, w = 0, h = 0, dpr = 1;
  try { enabled = localStorage.getItem('av_wx_fx') !== 'off'; } catch {}

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width; h = r.height; canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }
  function seed() {
    const n = Math.round(DROPS[intensity] * (w * h) / 700000);
    drops = Array.from({ length: n }, () => drop(true));
  }
  function drop(anyY) {
    const z = Math.random(); // profundidad: las gotas cercanas son más largas, rápidas y opacas
    return { x: Math.random() * (w + 120) - 60, y: anyY ? Math.random() * h : -20 - Math.random() * 60, len: 10 + z * 16 + intensity * 2, v: 9 + z * 9 + intensity * 2, a: .18 + z * .35, wdt: .8 + z * .9 };
  }
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    const slant = .22 + intensity * .05;
    ctx.lineCap = 'round';
    for (const d of drops) {
      ctx.strokeStyle = `rgba(200,225,245,${d.a})`; ctx.lineWidth = d.wdt;
      ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.len * slant, d.y + d.len); ctx.stroke();
      d.y += d.v; d.x -= d.v * slant;
      if (d.y > h + 20 || d.x < -80) Object.assign(d, drop(false));
    }
    if (storm) {
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
    const show = enabled && intensity > 0;
    canvas.parentElement.classList.toggle('wx-rain', show);
    canvas.parentElement.classList.toggle('wx-storm', show && storm);
    canvas.parentElement.dataset.wx = show ? intensity : 0;
    if (!show || reduce) { stopAnim(); return; } // con "reducir movimiento" solo queda el tono oscuro del cielo
    resize(); if (!raf) raf = requestAnimationFrame(frame);
  }
  window.addEventListener('resize', () => { if (raf) resize(); });
  new ResizeObserver(() => { if (raf) resize(); }).observe(canvas.parentElement);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAnim(); else apply(); });

  return {
    set(w) { const i = w?.ok ? (w.intensity || 0) : 0, st = i >= 4; if (i === intensity && st === storm) return; intensity = i; storm = st; nextBolt = performance.now() + 1500; apply(); },
    toggle() { enabled = !enabled; try { localStorage.setItem('av_wx_fx', enabled ? 'on' : 'off'); } catch {} apply(); return enabled; },
    get enabled() { return enabled; },
  };
}
