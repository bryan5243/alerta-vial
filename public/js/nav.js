// Buscador de destino y rutas que esquivan las zonas inundadas.
// Geocodificación: Nominatim (OpenStreetMap). Rutas: OSRM (OpenStreetMap). Ninguno pide cuenta ni key.
// OSRM no sabe de inundaciones: pedimos rutas alternativas y, si todas cruzan una zona activa,
// probamos desvíos pasando por puntos a los lados de esa zona hasta encontrar una ruta libre.
import { haversine, bearing, nearestOnLine, inPolygon } from './gps.js';
import { esc, toast, ICON } from './common.js';
import { fromOsrmStep, createGuide } from './guide.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

export function offset(p, brg, m) {
  const d = m / R, b = rad(brg), la = rad(p.lat), lo = rad(p.lng);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: deg(la2), lng: deg(lo2) };
}

// Zonas que una ruta no debe cruzar, a partir del estado público (solo lo activo llega aquí).
export function hazardZones(st) {
  if (!st) return [];
  const out = [];
  for (const p of st.points || []) if (p.type !== 'alcantarilla' || p.severity !== 'baja') out.push({ id: p.id, name: p.name, kind: 'point', center: { lat: p.lat, lng: p.lng }, r: 45 });
  for (const o of st.overflows || []) out.push({ id: o.id, name: o.street || 'Desborde de río', kind: 'point', center: { lat: o.lat, lng: o.lng }, r: 80 });
  for (const s of st.streets || []) if (s.status !== 'despejada' && s.coords?.length > 1) out.push({ id: s.id, name: s.name, kind: 'street', coords: s.coords, center: mid(s.coords) });
  for (const z of st.zones || []) if (z.coords?.length > 2) out.push({ id: z.id, name: z.name, kind: 'zone', ring: z.coords, center: centroid(z.coords) });
  return out;
}
const mid = c => ({ lat: c[Math.floor(c.length / 2)][0], lng: c[Math.floor(c.length / 2)][1] });
const centroid = c => ({ lat: c.reduce((s, p) => s + p[0], 0) / c.length, lng: c.reduce((s, p) => s + p[1], 0) / c.length });

// ¿Qué zonas cruza esta ruta? (coords en [lat, lng])
export function blockers(coords, zones) {
  const hit = [];
  for (const z of zones) {
    if (z.kind === 'point') { if (nearestOnLine(z.center, coords).d < z.r) hit.push(z); }
    else if (z.kind === 'street') {
      // la calle cuenta como cruzada si la ruta recorre un tramo de ella (>= 2 vértices pegados)
      const dense = densify(z.coords, 12); let n = 0;
      for (const v of dense) if (nearestOnLine({ lat: v[0], lng: v[1] }, coords).d < 14 && ++n >= 2) break;
      if (n >= 2) hit.push(z);
    } else if (z.kind === 'zone') { if (densify(coords, 15).some(v => inPolygon({ lat: v[0], lng: v[1] }, z.ring))) hit.push(z); }
  }
  return hit;
}
function densify(c, step) {
  const out = [];
  for (let i = 0; i < c.length - 1; i++) {
    const a = { lat: c[i][0], lng: c[i][1] }, b = { lat: c[i + 1][0], lng: c[i + 1][1] }, n = Math.max(1, Math.ceil(haversine(a, b) / step));
    for (let k = 0; k < n; k++) out.push([a.lat + (b.lat - a.lat) * k / n, a.lng + (b.lng - a.lng) * k / n]);
  }
  if (c.length) out.push(c.at(-1));
  return out;
}

async function osrm(pts, alternatives) {
  const url = `${OSRM}${pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';')}?overview=full&geometries=geojson&steps=true${alternatives ? '&alternatives=3' : ''}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('OSRM ' + r.status);
  const j = await r.json();
  if (j.code && j.code !== 'Ok') throw new Error(j.code);
  return (j.routes || []).map(x => ({ coords: x.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distance: x.distance, duration: x.duration,
    steps: (x.legs || []).flatMap((l, i, all) => (l.steps || []).filter(st => !(st.maneuver?.type === 'arrive' && i < all.length - 1) && !(st.maneuver?.type === 'depart' && i > 0)).map(fromOsrmStep)) }));
}

// Ruta de o a d que evite las zonas. Devuelve { coords, distance, duration, avoided:[nombres], blocked:[zonas aún cruzadas] }
export async function safeRoute(o, d, zones) {
  const base = await osrm([o, d], true);
  if (!base.length) throw new Error('Sin ruta');
  const directHits = blockers(base[0].coords, zones);
  const score = r => ({ ...r, blocked: blockers(r.coords, zones) });
  let cands = base.map(score);
  let clean = cands.filter(c => !c.blocked.length).sort((a, b) => a.duration - b.duration)[0];
  if (clean) return { ...clean, avoided: directHits.map(z => z.name) };
  // Desvíos: puntos de paso a ambos lados de la zona que bloquea, cada vez más lejos.
  let vias = [], best = cands.sort((a, b) => a.blocked.length - b.blocked.length || a.duration - b.duration)[0];
  for (let round = 0; round < 3 && best.blocked.length; round++) {
    const z = best.blocked[0], brg = bearing(o, d);
    const tries = [];
    for (const dist of [220, 380, 600]) for (const side of [90, -90]) tries.push(offset(z.center, brg + side, dist));
    const results = await Promise.all(tries.map(async v => {
      const all = [...vias, v].sort((a, b) => haversine(o, a) - haversine(o, b));
      try { const r = (await osrm([o, ...all, d], false))[0]; return r ? { ...score(r), vias: all } : null; } catch { return null; }
    }));
    const ok = results.filter(Boolean);
    if (!ok.length) break;
    clean = ok.filter(c => !c.blocked.length).sort((a, b) => a.duration - b.duration)[0];
    if (clean) return { ...clean, avoided: directHits.map(x => x.name) };
    best = ok.sort((a, b) => a.blocked.length - b.blocked.length || a.duration - b.duration)[0];
    vias = best.vias;
  }
  return { ...best, avoided: directHits.filter(z => !best.blocked.includes(z)).map(x => x.name) };
}

// Búsqueda solo dentro de Santa Rosa: caja de ~7 km alrededor del centro configurado, sin salir de ella.
export const SEARCH_RADIUS_M = 7000;
export async function geocode(q, center) {
  const d = 0.065, vb = [center.lng - d, center.lat + d, center.lng + d, center.lat - d].join(',');
  const go = async qq => {
    const r = await fetch(`${NOMINATIM}?format=jsonv2&limit=8&countrycodes=ec&accept-language=es&bounded=1&viewbox=${vb}&q=${encodeURIComponent(qq)}`, { signal: AbortSignal.timeout(8000) });
    return (await r.json()).map(x => ({ name: x.name || x.display_name.split(',')[0], label: x.display_name.split(',').slice(0, 4).join(','), lat: +x.lat, lng: +x.lon }))
      .filter(x => haversine(center, x) <= SEARCH_RADIUS_M);
  };
  const near = await go(q);
  return (near.length ? near : await go(`${q}, Santa Rosa`)).slice(0, 6);
}

const fmtKm = m => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`);
const fmtMin = s => `${Math.max(1, Math.round(s / 60))} min`;

// Guardado local (funciona sin red): lugares favoritos, rutas guardadas y la ruta en curso.
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const slim = r => ({ coords: r.coords.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]), distance: r.distance, duration: r.duration, steps: r.steps || [], avoided: r.avoided || [], blocked: (r.blocked || []).map(z => ({ name: z.name })) });

export function createNav({ getMap, getState, getUser, startGps, onChange = () => {}, sim = false, getDirect = () => false, getVoice = () => true }) {
  const $ = s => document.querySelector(s);
  let trip = null;      // { dest, origin, route, saved?, offline? }
  let shapes = [], detourR = null, picking = null, timer = null, seq = 0, replanning = false;
  let from = null;      // null = mi ubicación; { lat, lng, name } = punto elegido
  let planTo = null;    // destino elegido en el panel "Mi ruta"
  let pendingDest = null; // simulador: destino en espera mientras se marca la salida
  let restore = sim ? null : LS.get('av_trip', null);

  const input = $('#nav-q'), list = $('#nav-results'), card = $('#nav-card');
  // Indicaciones giro a giro; si el vehículo toma otra calle, se recalcula el camino desde donde está.
  const guide = createGuide({ el: $('#turn'), getVoice, onOffRoute: async user => {
    if (!trip) return;
    const route = await safeRoute(user, trip.dest, hazardZones(getState()));
    setTrip({ ...trip, origin: { lat: user.lat, lng: user.lng, mine: true }, route, direct: false, offline: false }); draw(false); renderCard();
    toast(route.avoided?.length ? `Nueva ruta: sigue evitando ${route.avoided.length === 1 ? route.avoided[0] : `${route.avoided.length} zonas inundadas`}.` : 'Nueva ruta calculada desde donde estás.', 'ok');
  } });
  $('#nav-ic').innerHTML = ICON.search || ICON.nav;
  $('#nav-plan').innerHTML = ICON.route;
  input.addEventListener('input', () => {
    clearTimeout(timer); const q = input.value.trim(); $('#nav-clear').hidden = !q;
    if (q.length < 3) { list.hidden = true; return; }
    timer = setTimeout(() => search(q), 450);
  });
  input.addEventListener('focus', () => { if (list.innerHTML) list.hidden = false; else if (!input.value.trim()) showQuick(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('[data-i]')?.click(); } if (e.key === 'Escape') list.hidden = true; });
  $('#nav-clear').addEventListener('click', () => { input.value = ''; $('#nav-clear').hidden = true; list.hidden = true; list.innerHTML = ''; end(); input.focus(); });
  document.addEventListener('click', e => { if (!e.target.closest('.nav-search')) list.hidden = true; });

  // Sin escribir nada: accesos rápidos a lugares y rutas guardadas.
  function showQuick() {
    const pl = LS.get('av_places', []), sv = LS.get('av_routes', []);
    if (!pl.length && !sv.length) return;
    list.innerHTML = [...sv.slice(0, 3).map((r, i) => `<button type="button" class="nav-res" data-sv="${i}">${ICON.route}<span><b>${esc(r.name)}</b><small>Ruta guardada · funciona sin conexión</small></span></button>`),
      ...pl.slice(0, 4).map((p, i) => `<button type="button" class="nav-res" data-pl="${i}">${ICON.pin}<span><b>${esc(p.name)}</b><small>Lugar guardado</small></span></button>`)].join('') + pickBtn();
    list.hidden = false;
    list.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => { list.hidden = true; openSaved(sv[+b.dataset.sv]); });
    list.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => { const p = pl[+b.dataset.pl]; input.value = p.name; $('#nav-clear').hidden = false; list.hidden = true; go(p); });
    bindPick(list);
  }

  async function search(q) {
    const my = ++seq; const st = getState();
    list.hidden = false; list.innerHTML = `<div class="nav-msg">Buscando…</div>`;
    const local = LS.get('av_places', []).filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
    let res = [];
    try { res = await geocode(q, st.config.center); } catch {
      if (my !== seq) return;
      res = local;
      list.innerHTML = (local.length ? '' : `<div class="nav-msg">Sin conexión para buscar direcciones. Elige el destino en el mapa o usa una ruta guardada.</div>`) + local.map((r, i) => `<button type="button" class="nav-res" data-i="${i}">${ICON.pin}<span><b>${esc(r.name)}</b><small>Lugar guardado</small></span></button>`).join('') + pickBtn();
      list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const r = res[+b.dataset.i]; input.value = r.name; list.hidden = true; go(r); });
      bindPick(list); return;
    }
    if (my !== seq) return;
    res = [...local, ...res];
    list.innerHTML = (res.length ? res.map((r, i) => `<button type="button" class="nav-res" data-i="${i}">${ICON.pin}<span><b>${esc(r.name)}</b><small>${esc(r.label || 'Lugar guardado')}</small></span></button>`).join('') : `<div class="nav-msg">No encontramos “${esc(q)}” en Santa Rosa. Prueba con el nombre de una calle, un barrio o un lugar conocido, o elige el punto en el mapa.</div>`) + pickBtn();
    list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const r = res[+b.dataset.i]; input.value = r.name; list.hidden = true; go(r); });
    bindPick(list);
  }
  const pickBtn = () => `<button type="button" class="nav-res pick" data-pick>${ICON.nav}<span><b>Elegir el destino en el mapa</b><small>Toca el lugar al que quieres ir</small></span></button><div class="nav-scope">Búsqueda solo dentro de Santa Rosa</div>`;
  function bindPick(el) { el.querySelector('[data-pick]')?.addEventListener('click', () => { list.hidden = true; startPick('go'); }); }
  function startPick(target) {
    picking = target; document.body.classList.add('nav-picking'); closePlan();
    toast(target === 'from-go' ? 'Simulación: toca en el mapa de dónde sale el vehículo' : target === 'from' ? 'Toca en el mapa el lugar desde donde sales' : 'Toca en el mapa el lugar al que quieres ir', 'ok');
  }

  async function origin() {
    if (from) return { ...from, mine: false };
    const u = getUser(); if (u) return { lat: u.lat, lng: u.lng, mine: true };
    if ('geolocation' in navigator && window.isSecureContext) {
      try {
        const p = await new Promise((ok, ko) => navigator.geolocation.getCurrentPosition(ok, ko, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }));
        return { lat: p.coords.latitude, lng: p.coords.longitude, mine: true };
      } catch {}
    }
    const c = getState().config.center; toast('No tenemos tu ubicación: la ruta sale desde el centro. Puedes marcar el punto de salida en "Mi ruta".', 'err');
    return { lat: c.lat, lng: c.lng, mine: false, name: 'el centro' };
  }

  async function go(dest) {
    // Simulador: el vehículo virtual necesita un punto de salida en el mapa.
    if (sim && !from) { pendingDest = dest; startPick('from-go'); return; }
    card.hidden = false; card.className = 'nav-card loading';
    card.innerHTML = `<div class="nav-spin"></div><div><b>Calculando ruta segura…</b><small>Revisando zonas inundadas activas</small></div>`;
    const o = await origin();
    try {
      const zones = hazardZones(getState());
      let route, direct = false;
      if (getDirect()) { const r = await safeRoute(o, dest, []); route = { ...r, avoided: [], blocked: blockers(r.coords, zones) }; direct = true; }
      else route = await safeRoute(o, dest, zones);
      setTrip({ dest, origin: o, route, direct }); draw(true); renderCard();
    } catch (e) {
      // Sin red: si hay una ruta guardada hacia ese mismo lugar, la usamos.
      const sv = LS.get('av_routes', []).find(r => haversine(r.dest, dest) < 80);
      if (sv) { openSaved(sv, true); return; }
      card.className = 'nav-card err';
      card.innerHTML = `<div class="nav-info"><b>${navigator.onLine === false ? 'Estás sin conexión' : 'No se pudo calcular la ruta'}</b><small>${navigator.onLine === false
        ? 'Para una ruta nueva hace falta internet. Mientras tanto puedes usar tus rutas guardadas: el mapa, las zonas inundadas y los avisos del GPS siguen funcionando.'
        : 'Sin conexión con el servicio de rutas de OpenStreetMap. Intenta de nuevo en un momento.'}</small></div>
        <div class="nav-acts"><button class="btn sm" id="nav-open-plan">${ICON.route} Mis rutas</button><button class="btn sm ghost" id="nav-x">Cerrar</button></div>`;
      $('#nav-x').onclick = end; $('#nav-open-plan').onclick = openPlan;
    }
  }
  function setTrip(t) {
    trip = t; guide.setRoute(trip ? trip.route : null); if (!trip) guide.hide();
    if (!sim) LS.set('av_trip', trip ? { dest: trip.dest, origin: trip.origin, route: slim(trip.route), saved: trip.saved, at: Date.now() } : null);
    onChange();
  }
  function openSaved(sv, offline) {
    input.value = sv.dest.name; $('#nav-clear').hidden = false;
    setTrip({ dest: sv.dest, origin: sv.origin, route: sv.route, saved: sv.id, offline: !!offline });
    draw(true); renderCard();
  }
  function renderCard() {
    const r = trip.route, bad = r.blocked?.length;
    const saved = LS.get('av_routes', []).some(x => x.id === trip.saved);
    card.hidden = false; card.className = `nav-card ${bad ? 'warn' : 'ok'}`;
    const fromTxt = trip.origin.mine ? 'Desde tu ubicación' : `Desde ${esc(trip.origin.name || 'el punto elegido')}`;
    card.innerHTML = `
      <div class="nav-badge">${bad ? ICON.warn : ICON.check}</div>
      <div class="nav-info"><small>${fromTxt} hasta</small><b>${esc(trip.dest.name)}</b>
        <div class="nav-meta"><span>${fmtKm(r.distance)}</span><span>${fmtMin(r.duration)}</span></div>
        <div class="nav-note">${trip.direct && bad ? `Ruta directa de prueba: cruza ${esc(r.blocked.map(z => z.name).join(', '))}. El GPS avisará al acercarse y ofrecerá un desvío.` : bad ? `No hay una ruta totalmente libre: pasa por ${esc(r.blocked.map(z => z.name).join(', '))}. Extreme precaución.`
          : r.avoided?.length ? `Ruta segura: evita ${r.avoided.length === 1 ? esc(r.avoided[0]) : `${r.avoided.length} zonas inundadas`}.` : 'Ruta libre de zonas inundadas.'}</div>
        ${trip.offline ? `<div class="nav-off">${ICON.info} Sin conexión: usando tu ruta guardada.</div>` : ''}</div>
      <div class="nav-acts">${getUser() ? '' : `<button class="btn sm" id="nav-start">${sim ? ICON.play || ICON.nav : ICON.nav} ${sim ? 'Simular' : 'Iniciar'}</button>`}
        <button class="btn sm ghost${saved ? ' on' : ''}" id="nav-save" aria-pressed="${saved}" title="Guardar para usarla sin conexión">${saved ? ICON.check + ' Guardada' : 'Guardar'}</button>
        <button class="btn sm ghost" id="nav-x" aria-label="Terminar ruta">${ICON.x}</button></div>`;
    $('#nav-start')?.addEventListener('click', () => { startGps(); renderCard(); });
    $('#nav-save').onclick = saveTrip;
    $('#nav-x').onclick = () => { input.value = ''; $('#nav-clear').hidden = true; end(); };
    onChange();
  }
  function saveTrip() {
    const all = LS.get('av_routes', []);
    if (trip.saved && all.some(x => x.id === trip.saved)) { LS.set('av_routes', all.filter(x => x.id !== trip.saved)); trip.saved = null; renderCard(); toast('Ruta quitada de tus rutas guardadas.', 'ok'); return; }
    const id = 'r' + Date.now().toString(36);
    const name = `${trip.origin.mine ? 'Mi ubicación' : trip.origin.name || 'Punto elegido'} → ${trip.dest.name}`;
    all.unshift({ id, name, origin: trip.origin, dest: trip.dest, route: slim(trip.route), at: Date.now() });
    LS.set('av_routes', all.slice(0, 10));
    const pl = LS.get('av_places', []);
    if (!pl.some(p => haversine(p, trip.dest) < 40)) { pl.unshift({ name: trip.dest.name, lat: trip.dest.lat, lng: trip.dest.lng }); LS.set('av_places', pl.slice(0, 12)); }
    trip.saved = id; setTrip(trip); renderCard();
    toast('Ruta guardada. Podrás abrirla aunque no tengas internet.', 'ok');
  }
  function draw(fit) {
    shapes.forEach(s => s.remove?.()); shapes = [];
    const map = getMap(); if (!map) return;
    if (!trip) { if (detourR) shapes.push(map.addPolyline({ coords: detourR.coords, status: 'nav', flow: 'route', weight: 8, popup: `<b>${esc(detourR.name)}</b>` })); return; }
    shapes.push(map.addPolyline({ coords: trip.route.coords, status: 'nav', flow: 'route', weight: 8, popup: `<b>Tu ruta a ${esc(trip.dest.name)}</b><br>${fmtKm(trip.route.distance)} · ${fmtMin(trip.route.duration)}` }));
    if (!trip.origin.mine) shapes.push(map.addMarker({ lat: trip.origin.lat, lng: trip.origin.lng, cls: 'nav-from', icon: 'nav', popup: `<b>Salida</b><br>${esc(trip.origin.name || 'Punto elegido')}` }));
    shapes.push(map.addMarker({ lat: trip.dest.lat, lng: trip.dest.lng, cls: 'nav-dest', icon: 'flag', popup: `<b>${esc(trip.dest.name)}</b>` }));
    if (fit) map.fitBounds([[trip.origin.lat, trip.origin.lng], ...trip.route.coords]);
  }
  function end() { setTrip(null); detourR = null; draw(); card.hidden = true; card.innerHTML = ''; }

  /* ---------- Panel "Mi ruta": de dónde sales y a dónde vas ---------- */
  const plan = $('#plan-bg'); let plTimer = null, plSeq = 0;
  function openPlan() { list.hidden = true; renderPlan(); plan.classList.add('open'); }
  function closePlan() { plan.classList.remove('open'); }
  function renderPlan() {
    $('#pl-from').textContent = from ? from.name : 'Mi ubicación (GPS)';
    document.querySelectorAll('[data-from]').forEach(b => b.classList.toggle('on', (b.dataset.from === 'me') === !from));
    if (planTo) $('#pl-to').value = planTo.name;
    $('#pl-go').disabled = !planTo;
    const pl = LS.get('av_places', []), sv = LS.get('av_routes', []);
    $('#pl-places').innerHTML = pl.length ? `<h3>Mis lugares</h3><div class="pl-chips">${pl.map((p, i) => `<span class="pl-chip${planTo && haversine(planTo, p) < 30 ? ' on' : ''}"><button type="button" data-place="${i}">${ICON.pin}${esc(p.name)}</button><button type="button" data-delplace="${i}" aria-label="Quitar ${esc(p.name)}">×</button></span>`).join('')}</div>`
      : `<p class="small muted pl-hint">Cuando guardes una ruta, el destino queda aquí como lugar favorito.</p>`;
    $('#pl-saved').innerHTML = sv.length ? `<h3>Rutas guardadas <small>funcionan sin conexión</small></h3>${sv.map((r, i) => `<div class="pl-route"><button type="button" data-sv="${i}">${ICON.route}<span><b>${esc(r.name)}</b><small>${fmtKm(r.route.distance)} · ${fmtMin(r.route.duration)} · guardada ${new Date(r.at).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}</small></span></button><button type="button" class="pl-del" data-delsv="${i}" aria-label="Borrar ruta">×</button></div>`).join('')}` : '';
    plan.querySelectorAll('[data-place]').forEach(b => b.onclick = () => { planTo = pl[+b.dataset.place]; renderPlan(); });
    plan.querySelectorAll('[data-delplace]').forEach(b => b.onclick = () => { pl.splice(+b.dataset.delplace, 1); LS.set('av_places', pl); renderPlan(); });
    plan.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => { closePlan(); openSaved(sv[+b.dataset.sv], navigator.onLine === false); });
    plan.querySelectorAll('[data-delsv]').forEach(b => b.onclick = () => { sv.splice(+b.dataset.delsv, 1); LS.set('av_routes', sv); renderPlan(); });
  }
  $('#nav-plan').addEventListener('click', openPlan);
  $('#pl-close').addEventListener('click', closePlan);
  plan.addEventListener('click', e => { if (e.target === plan) closePlan(); });
  document.querySelectorAll('[data-from]').forEach(b => b.addEventListener('click', () => { if (b.dataset.from === 'me') { from = null; renderPlan(); } else startPick('from'); }));
  $('[data-to="map"]').addEventListener('click', () => startPick('to'));
  $('#pl-to').addEventListener('input', () => {
    clearTimeout(plTimer); const q = $('#pl-to').value.trim(); planTo = null; $('#pl-go').disabled = true;
    const box = $('#pl-res'); if (q.length < 3) { box.innerHTML = ''; return; }
    plTimer = setTimeout(async () => {
      const my = ++plSeq; box.innerHTML = `<div class="nav-msg">Buscando…</div>`;
      const local = LS.get('av_places', []).filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
      let res = local;
      try { res = [...local, ...await geocode(q, getState().config.center)]; } catch { if (!local.length) { box.innerHTML = `<div class="nav-msg">Sin conexión para buscar. Usa "Elegir en el mapa".</div>`; return; } }
      if (my !== plSeq) return;
      box.innerHTML = res.length ? res.slice(0, 6).map((r, i) => `<button type="button" class="nav-res" data-r="${i}">${ICON.pin}<span><b>${esc(r.name)}</b><small>${esc(r.label || 'Lugar guardado')}</small></span></button>`).join('') : `<div class="nav-msg">No está en Santa Rosa. Prueba otro nombre o "En el mapa".</div>`;
      box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { planTo = res[+b.dataset.r]; box.innerHTML = ''; renderPlan(); });
    }, 450);
  });
  $('#pl-go').addEventListener('click', () => { if (!planTo) return; closePlan(); input.value = planTo.name; $('#nav-clear').hidden = false; go(planTo); });

  // Desvío automático para el GPS: desde la posición actual hasta un punto pasando la zona, sin cruzarla.
  async function detour(user, hz) {
    const c = hz.coords?.length ? { lat: hz.coords[Math.floor(hz.coords.length / 2)][0], lng: hz.coords[Math.floor(hz.coords.length / 2)][1] } : null;
    if (!c) return null;
    const dest = trip ? trip.dest : offset(c, bearing(user, c), 350);
    const r = await safeRoute(user, dest, hazardZones(getState()));
    if (r.blocked?.length) return null;
    return { id: 'auto', name: trip ? `Ruta segura a ${trip.dest.name}` : 'Desvío automático', description: r.avoided?.length ? `Evita ${r.avoided.join(', ')}.` : '', coords: r.coords, steps: r.steps, auto: true };
  }
  function showDetour(r) {
    if (trip) { trip.route = { ...trip.route, coords: r.coords, steps: r.steps || [], blocked: [], avoided: r.description ? [r.description.replace(/^Evita |\.$/g, '')] : trip.route.avoided }; trip.direct = false; setTrip(trip); draw(); renderCard(); return; }
    detourR = r; draw(false);
  }

  // Cada vez que el mapa se redibuja: volver a pintar la ruta y recalcular si ahora cruza una zona nueva.
  async function refresh() {
    if (!trip && restore?.route?.coords?.length && Date.now() - (restore.at || 0) < 12 * 3600e3) {
      trip = { ...restore, offline: navigator.onLine === false }; restore = null; guide.setRoute(trip.route);
      input.value = trip.dest.name; $('#nav-clear').hidden = false; draw(true); renderCard(); return;
    }
    restore = null;
    draw(false);
    if (!trip || replanning || trip.direct) return;
    if (blockers(trip.route.coords, hazardZones(getState())).length && !trip.route.blocked?.length) {
      replanning = true;
      try { const u = getUser(); const o = u || trip.origin; setTrip({ ...trip, route: await safeRoute(o, trip.dest, hazardZones(getState())), offline: false }); draw(false); renderCard(); toast('Se activó una zona inundada en tu camino: recalculamos la ruta.', 'ok'); }
      catch { toast('Se activó una zona inundada en tu camino y no hay conexión para recalcular. Sigue las vías alternas del mapa.', 'err'); trip.route.blocked = [{ name: 'una zona recién activada' }]; renderCard(); }
      replanning = false;
    }
  }

  return {
    refresh, detour, showDetour, go, openPlan,
    get active() { return !!trip; },
    get trip() { return trip; },
    track(user) { if (trip && user) guide.update(user); else guide.hide(); },
    resetFrom() { from = null; },
    onMapClick(pos) {
      if (!picking) return false;
      const c = getState()?.config?.center;
      if (c && haversine(c, pos) > SEARCH_RADIUS_M) { toast('Ese punto está fuera de Santa Rosa. Elige un lugar dentro de la ciudad.', 'err'); return true; }
      const t = picking; picking = null; document.body.classList.remove('nav-picking');
      if (t === 'from') { from = { ...pos, name: 'Punto elegido en el mapa' }; openPlan(); return true; }
      if (t === 'to') { planTo = { ...pos, name: 'Punto elegido en el mapa' }; openPlan(); return true; }
      if (t === 'from-go') { from = { ...pos, name: 'Salida de la simulación' }; const d = pendingDest; pendingDest = null; if (d) go(d); return true; }
      input.value = 'Punto elegido en el mapa'; $('#nav-clear').hidden = false; go({ ...pos, name: 'el punto elegido' }); return true;
    },
  };
}

// Genera vías alternas automáticas para un punto de riesgo: busca las calles que cruzan el punto
// (probando ejes norte–sur, este–oeste y diagonales) y, para cada una, una ruta de un lado al otro
// que no pase por ese punto ni por los demás puntos de riesgo.
export async function autoDetoursFor(p, allPoints, max = 2) {
  const P = { lat: p.lat, lng: p.lng };
  const zones = allPoints.map(x => ({ id: x.id, name: x.name, kind: 'point', center: { lat: x.lat, lng: x.lng }, r: 45 }));
  const self = zones.find(z => z.id === p.id) || { id: p.id, name: p.name, kind: 'point', center: P, r: 45 };
  const AX = [['norte–sur', 0], ['este–oeste', 90], ['noreste–suroeste', 45], ['noroeste–sureste', 135]];
  const out = [];
  for (const [axis, b] of AX) {
    if (out.length >= max) break;
    const A = offset(P, b, 300), B = offset(P, b + 180, 300);
    let direct;
    try { direct = (await osrm([A, B], false))[0]; } catch { continue; }
    if (!direct || !blockers(direct.coords, [self]).length) continue; // por este eje no hay calle que cruce el punto
    let r; try { r = await safeRoute(A, B, zones); } catch { continue; }
    if (!r || r.blocked?.length) continue;
    if (out.some(o => nearestOnLine({ lat: r.coords[Math.floor(r.coords.length / 2)][0], lng: r.coords[Math.floor(r.coords.length / 2)][1] }, o.coords).d < 30)) continue; // repetida
    out.push({ axis, coords: r.coords.map(([la, ln]) => [+la.toFixed(6), +ln.toFixed(6)]), distance: r.distance, duration: r.duration, extra: Math.max(0, r.distance - direct.distance) });
  }
  return out;
}
