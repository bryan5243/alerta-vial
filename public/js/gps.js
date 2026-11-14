// Navegación con GPS: sigue la ubicación del usuario y avisa ANTES de llegar a una calle inundada
// o a un punto crítico, con una animación de proximidad (sonar, agua que sube, cuenta regresiva,
// flecha de dirección, borde pulsante, vibración y voz).
import { STATUS, PTYPE, esc, toast, ICON } from './common.js';

const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
// Distancia de un punto a una polilínea (proyección local en metros)
export function nearestOnLine(p, coords) {
  const kx = 111320 * Math.cos(rad(p.lat)), ky = 110540;
  let best = { d: Infinity, point: null };
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][1] - p.lng) * kx, ay = (coords[i][0] - p.lat) * ky;
    const bx = (coords[i + 1][1] - p.lng) * kx, by = (coords[i + 1][0] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy, d = Math.hypot(cx, cy);
    if (d < best.d) best = { d, point: { lat: p.lat + cy / ky, lng: p.lng + cx / kx } };
  }
  if (coords.length === 1) best = { d: haversine(p, { lat: coords[0][0], lng: coords[0][1] }), point: { lat: coords[0][0], lng: coords[0][1] } };
  return best;
}
// ¿El punto está dentro del polígono? (ray casting)
export function inPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export function createGps({ getMap, getState, getShapes, getNav = () => null, onMove = () => {} }) {
  const $ = s => document.querySelector(s);
  let watchId = null, simTimer = null, user = null, userMk = null, last = null, follow = true, voice = true;
  let active = null;       // { hz, level, d, point }
  let pulse = null, link = null, hlShape = null, routeShape = null;
  const hist = new Map();  // id -> [{d,t}]
  const detours = new Map(); // id -> desvío automático calculado
  const snoozed = new Map(); // id -> { until, level }
  let shownD = 0, tweenRaf = null;

  const cfg = () => ({ warnM: 400, dangerM: 150, voice: true, ...(getState()?.config?.gps || {}) });

  function hazards() {
    const st = getState(); if (!st) return [];
    const out = [];
    for (const s of st.streets) if (s.status !== 'despejada') out.push({ id: s.id, kind: 'street', tone: s.status === 'inundada' ? 'roja' : 'naranja', name: s.name, coords: s.coords,
      title: s.status === 'inundada' ? 'Calle inundada · sin paso' : 'Calle parcialmente inundada', meta: `${STATUS[s.status]}${s.depthCm ? ` · ~${s.depthCm} cm de agua` : ''}`, note: s.note, src: s });
    for (const p of st.points) if (p.type !== 'alcantarilla' || p.severity !== 'baja') out.push({ id: p.id, kind: 'point', tone: p.severity === 'alta' ? 'roja' : 'naranja', name: p.name, coords: [[p.lat, p.lng]],
      title: p.type === 'interseccion' ? 'Intersección inundada · sin paso' : p.severity === 'alta' ? 'Punto crítico · peligro' : 'Punto crítico', meta: PTYPE[p.type], note: p.description, src: p });
    for (const z of st.zones || []) out.push({ id: z.id, kind: 'zone', tone: z.severity === 'alta' ? 'roja' : 'naranja', name: z.name, coords: [...z.coords, z.coords[0]], ring: z.coords,
      title: z.severity === 'alta' ? 'Zona de desborde · sin paso' : 'Zona de desborde', meta: `Se sale el agua del río${z.depthCm ? ` · ~${z.depthCm} cm` : ''}`, note: z.note, src: z });
    for (const r of st.rivers || []) if (r.status === 'desbordado') out.push({ id: r.id, kind: 'river', tone: 'roja', name: r.name, coords: r.coords,
      title: 'Río desbordado', meta: 'Manténgase lejos de la orilla', note: r.note, src: r });
    for (const o of st.overflows || []) out.push({ id: o.id, kind: 'point', tone: 'roja', name: o.street || 'Desborde de río', coords: [[o.lat, o.lng]],
      title: 'Desborde de río · sin paso', meta: 'Reporte verificado', note: o.description, src: o });
    return out;
  }

  /* ---------- ciclo principal ---------- */
  function onPos(pos) {
    const now = Date.now();
    let heading = pos.heading;
    if ((heading == null || isNaN(heading)) && last && haversine(last, pos) > 3) heading = bearing(last, pos);
    user = { ...pos, heading };
    const map = getMap();
    if (!userMk) userMk = map.addUser(user); else userMk.update(user);
    $('#gps-acc').textContent = pos.accuracy ? `precisión ${Math.round(pos.accuracy)} m` : '';
    last = { lat: pos.lat, lng: pos.lng };

    const { warnM, dangerM } = cfg();
    let best = null;
    for (const hz of hazards()) {
      let { d, point } = nearestOnLine(user, hz.coords);
      if (hz.ring && inPolygon(user, hz.ring)) { d = 0; point = { lat: user.lat, lng: user.lng }; }
      const h = (hist.get(hz.id) || []).filter(x => now - x.t < 20000); h.push({ d, t: now }); hist.set(hz.id, h.slice(-6));
      if (d > warnM * 1.25) continue;
      const trend = h.length > 1 ? h[0].d - d : 0;
      const towards = heading != null && !isNaN(heading) ? angDiff(heading, bearing(user, point)) < 70 : false;
      const approaching = trend > 5 || towards;
      let level = d <= dangerM ? 'danger' : d <= warnM && approaching ? 'warn' : null;
      if (active?.hz.id === hz.id && !level && d <= warnM * 1.25) level = active.level; // histéresis
      if (!level) continue;
      const sz = snoozed.get(hz.id);
      if (sz && sz.until > now && !(level === 'danger' && sz.level === 'warn')) continue;
      const score = d - (level === 'danger' ? 1e5 : 0) - (hz.tone === 'roja' ? 50 : 0);
      if (!best || score < best.score) best = { hz, level, d, point, score };
    }
    if (best) show(best); else if (active) hide();
    if (!best && follow) map.panTo(user, 16);
    $('#gps-state').textContent = best ? (best.level === 'danger' ? 'Peligro cerca' : 'Precaución adelante') : `Sin peligros a ${warnM} m`;
    $('#gps-bar').dataset.level = best ? best.level : 'ok';
    onMove(user);
  }

  /* ---------- animación de alerta ---------- */
  function show(b) {
    const map = getMap(); const first = !active || active.hz.id !== b.hz.id; const escalate = !first && active.level !== b.level;
    const tone = b.level === 'danger' ? 'roja' : b.hz.tone;
    active = b;
    const card = $('#hz'); const vig = $('#hz-vignette');
    if (first) {
      clearFx();
      card.className = `hz ${tone} enter`; void card.offsetWidth; card.classList.remove('enter');
      $('#hz-title').textContent = b.hz.title; $('#hz-name').textContent = b.hz.name;
      $('#hz-meta').textContent = [b.hz.meta, b.hz.note].filter(Boolean).join(' · ');
      const shp = b.hz.kind === 'street' ? getShapes().streets.get(b.hz.id) : null;
      if (shp?.addClass) { shp.addClass('hazard-flow'); hlShape = shp; }
      pulse = map.addPulse({ ...b.point, tone });
      link = map.addLink(user, b.point, tone);
      const alt = altRoute(b.hz);
      $('#hz-alt').textContent = alt?.id === 'auto' ? (getNav()?.trip ? 'Tomar desvío' : 'Ver desvío') : 'Ver vía alterna';
      $('#hz-alt').hidden = !alt; $('#hz-alt').onclick = () => alt && showAlt(alt);
      if (!alt) autoDetour(b.hz);
      map.fitBounds([[user.lat, user.lng], [b.point.lat, b.point.lng]]);
      announce(b, true);
    }
    if (escalate) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); announce(b, false); }
    card.classList.toggle('danger', b.level === 'danger');
    card.dataset.tone = tone; card.className = card.className.replace(/\b(roja|naranja)\b/g, '').trim() + ' ' + tone;
    vig.className = `hz-vignette on ${tone} ${b.level}`;
    $('#hz-badge').textContent = b.level === 'danger' ? 'PELIGRO' : 'PRECAUCIÓN';
    pulse?.move(b.point); pulse?.setTone(tone); link?.set(user, b.point, tone);
    const { warnM } = cfg();
    const fill = Math.max(0.08, Math.min(1, 1 - b.d / warnM));
    $('#hz-water').style.transform = `translateY(${(1 - fill) * 100}%)`;
    const rel = (bearing(user, b.point) - (user.heading || 0) + 360) % 360;
    $('#hz-arrow').style.transform = `rotate(${user.heading != null && !isNaN(user.heading) ? rel : bearing(user, b.point)}deg)`;
    tweenTo(Math.round(b.d));
    card.hidden = false;
  }
  function hide() {
    const card = $('#hz'); card.classList.add('leave');
    setTimeout(() => { card.hidden = true; card.classList.remove('leave'); }, 280);
    $('#hz-vignette').className = 'hz-vignette';
    clearFx(); active = null;
  }
  function clearFx() {
    hlShape?.removeClass('hazard-flow'); hlShape = null;
    routeShape?.removeClass('route-flow'); routeShape = null;
    pulse?.remove(); pulse = null; link?.remove(); link = null;
  }
  function tweenTo(target) {
    cancelAnimationFrame(tweenRaf);
    const from = shownD || target + 80, t0 = performance.now(), dur = 380;
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3; shownD = Math.round(from + (target - from) * e);
      if (target === 0 && k >= 1) { $('#hz-dist').textContent = 'AQUÍ'; $('#hz-unit').textContent = 'estás dentro'; return; }
      $('#hz-dist').textContent = shownD >= 1000 ? (shownD / 1000).toFixed(1) : shownD; $('#hz-unit').textContent = shownD >= 1000 ? 'km' : 'm';
      if (k < 1) tweenRaf = requestAnimationFrame(step); };
    tweenRaf = requestAnimationFrame(step);
  }
  function announce(b, first) {
    try { navigator.vibrate?.(b.level === 'danger' ? [400, 150, 400, 150, 400] : [200, 100, 200]); } catch {}
    if (!voice || !cfg().voice || !('speechSynthesis' in window)) return;
    const m = Math.round(b.d / 10) * 10;
    const txt = b.level === 'danger' ? `Peligro. ${b.hz.title} a ${m} metros. ${b.hz.name}. No avance.` : `Atención. ${b.hz.title} a ${m} metros adelante. ${b.hz.name}.`;
    const alt = altRoute(b.hz);
    const u = new SpeechSynthesisUtterance(txt + (alt && first ? ` Vía alterna: ${alt.name}.` : '')); u.lang = 'es-ES'; u.rate = 1.02;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  // Sin vía alterna dibujada: el sistema calcula un desvío por calles que no cruce zonas inundadas.
  function autoDetour(hz) {
    const nav = getNav(); if (!nav || !user || detours.has(hz.id)) return;
    detours.set(hz.id, null);
    nav.detour(user, hz).then(r => {
      if (!r) { detours.delete(hz.id); return; }
      detours.set(hz.id, r);
      if (active?.hz.id === hz.id) { $('#hz-alt').textContent = getNav()?.trip ? 'Tomar desvío' : 'Ver desvío'; $('#hz-alt').hidden = false; $('#hz-alt').onclick = () => showAlt(r); }
    }).catch(() => detours.delete(hz.id));
  }
  function altRoute(hz) {
    const st = getState(); if (!st) return null;
    // Con una ruta marcada, el desvío es recalcular el camino al destino sin pasar por el peligro.
    if (getNav()?.trip) return detours.get(hz.id) || null;
    return st.routes.find(r => r.avoids === hz.id) || detours.get(hz.id) || (hz.kind === 'street' || hz.src?.type === 'interseccion' ? null : st.routes.slice().sort((a, b) => nearestOnLine(user, a.coords).d - nearestOnLine(user, b.coords).d)[0]) || null;
  }
  function showAlt(r) {
    if (r.id === 'auto') { getNav()?.showDetour(r); getMap().fitBounds([[user.lat, user.lng], ...r.coords]); toast(`${r.name}. ${r.description || ''}`.trim(), 'ok'); return; }
    const shp = getShapes().routes.get(r.id); routeShape?.removeClass('route-flow');
    if (shp?.addClass) { shp.addClass('route-flow'); routeShape = shp; }
    getMap().fitBounds([[user.lat, user.lng], ...r.coords]);
    toast(`Vía alterna: ${r.name}. ${r.description || ''}`.trim(), 'ok');
  }

  /* ---------- controles ---------- */
  function start() {
    $('#gps-bar').hidden = false; $('#btn-gps').classList.add('on'); document.body.classList.add('gps-on');
    if (!('geolocation' in navigator)) { toast('Tu navegador no permite usar el GPS. Prueba "Simular recorrido".', 'err'); return; }
    if (!window.isSecureContext) { toast('El GPS solo funciona con https o en localhost. Puedes usar "Simular recorrido".', 'err'); return; }
    watchId = navigator.geolocation.watchPosition(
      p => onPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed }),
      e => simTimer ? null : toast(e.code === 1 ? 'Permite el acceso a tu ubicación para recibir avisos.' : 'No se pudo obtener tu ubicación. Revisa que el GPS esté encendido.', 'err'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  }
  function stop() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null;
    clearInterval(simTimer); simTimer = null; $('#gps-sim').classList.remove('on');
    if (active) hide(); userMk?.remove(); userMk = null; user = null; last = null; hist.clear(); snoozed.clear(); detours.clear();
    $('#gps-bar').hidden = true; $('#btn-gps').classList.remove('on'); document.body.classList.remove('gps-on');
    try { speechSynthesis.cancel(); } catch {}
    onMove(null);
  }
  // Simulación de navegación: si hay una ruta marcada, un vehículo virtual la recorre (y sigue el desvío si lo aceptas).
  // Sin ruta: se acerca a la primera calle inundada para mostrar el aviso.
  let simSpeed = 2, simPaused = false;
  function simulate() {
    if (simTimer) { clearInterval(simTimer); simTimer = null; $('#gps-sim').classList.remove('on'); return; }
    const nav = getNav();
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    $('#gps-bar').hidden = false; $('#btn-gps').classList.add('on'); document.body.classList.add('gps-on'); $('#gps-sim').classList.add('on');
    hist.clear(); snoozed.clear(); detours.clear(); simPaused = false; follow = true; $('#gps-follow').classList.add('on');
    if (nav?.trip) {
      const c0 = nav.trip.route.coords[0]; let pos = { lat: c0[0], lng: c0[1] };
      onPos({ ...pos, accuracy: 5, heading: null });
      simTimer = setInterval(() => {
        if (simPaused) return;
        const t = nav.trip; if (!t) { stop(); return; }
        const r = advance(t.route.coords, pos, 5 * simSpeed); // 5 m por paso de 0,5 s = 36 km/h a velocidad 1×
        pos = r.pos; onPos({ ...pos, accuracy: 5, heading: r.heading, speed: 10 * simSpeed });
        if (r.done) { clearInterval(simTimer); simTimer = null; $('#gps-sim').classList.remove('on'); toast(`Llegaste a ${t.dest.name}. Fin de la simulación.`, 'ok'); }
      }, 500);
      return;
    }
    const hz = hazards().find(h => h.kind === 'street' && h.tone === 'roja') || hazards()[0];
    if (!hz) { toast('No hay peligros activos para simular. Marca un destino para recorrer una ruta.', 'err'); return; }
    const mid = hz.coords[Math.floor(hz.coords.length / 2)], target = { lat: mid[0], lng: mid[1] };
    const startP = { lat: target.lat - 0.0058, lng: target.lng - 0.0042 }; // ~ 790 m al suroeste
    const steps = 60; let i = 0;
    simTimer = setInterval(() => {
      if (simPaused) return;
      const k = Math.min(1, i / steps);
      onPos({ lat: startP.lat + (target.lat - startP.lat) * k * 0.97, lng: startP.lng + (target.lng - startP.lng) * k * 0.97, accuracy: 8 });
      if (++i > steps) { clearInterval(simTimer); simTimer = null; $('#gps-sim').classList.remove('on'); }
    }, 450);
  }
  // Avanza m metros sobre la polilínea desde el punto más cercano a pos.
  function advance(coords, pos, m) {
    let bi = 0, bd = Infinity, bt = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = { lat: coords[i][0], lng: coords[i][1] }, b = { lat: coords[i + 1][0], lng: coords[i + 1][1] };
      const np = nearestOnLine(pos, [coords[i], coords[i + 1]]); if (np.d < bd) { bd = np.d; bi = i; const L = haversine(a, b); bt = L ? haversine(a, np.point) / L : 0; }
    }
    let i = bi, cur = { lat: coords[i][0] + (coords[i + 1][0] - coords[i][0]) * bt, lng: coords[i][1] + (coords[i + 1][1] - coords[i][1]) * bt }, left = m;
    while (i < coords.length - 1) {
      const nx = { lat: coords[i + 1][0], lng: coords[i + 1][1] }, d = haversine(cur, nx);
      if (d >= left && d > 0) { const k = left / d; const p = { lat: cur.lat + (nx.lat - cur.lat) * k, lng: cur.lng + (nx.lng - cur.lng) * k }; return { pos: p, heading: bearing(cur, nx), done: false }; }
      left -= d; cur = nx; i++;
    }
    const n = coords.length; return { pos: cur, heading: n > 1 ? bearing({ lat: coords[n - 2][0], lng: coords[n - 2][1] }, cur) : null, done: true };
  }
  $('#btn-gps').addEventListener('click', () => (watchId != null || simTimer ? stop() : start()));
  $('#gps-stop').addEventListener('click', stop);
  $('#gps-sim').addEventListener('click', simulate);
  $('#gps-follow').addEventListener('click', e => { follow = !follow; e.currentTarget.classList.toggle('on', follow); if (follow && user) getMap().panTo(user, 16); });
  $('#gps-voice').addEventListener('click', e => { voice = !voice; e.currentTarget.classList.toggle('on', voice); if (!voice) try { speechSynthesis.cancel(); } catch {} });
  $('#hz-ok').addEventListener('click', () => { if (active) { snoozed.set(active.hz.id, { until: Date.now() + 120000, level: active.level }); hide(); } });

  return {
    // Se llama cuando el mapa se vuelve a dibujar (refresco cada minuto) para no perder el resaltado
    refresh() { if (active?.hz.kind === 'street') { const shp = getShapes().streets.get(active.hz.id); if (shp?.addClass) { shp.addClass('hazard-flow'); hlShape = shp; } } routeShape = null; },
    get on() { return watchId != null || !!simTimer; },
    get user() { return user; },
    start: () => { if (watchId == null && !simTimer) start(); },
    simulate, onPos, stop: () => { if (watchId != null || simTimer) stop(); },
    get simulating() { return !!simTimer; },
    setSimSpeed(v) { simSpeed = v; }, toggleSimPause() { simPaused = !simPaused; return simPaused; },
  };
}
