// Buscador de destino y rutas que esquivan las zonas inundadas.
// Geocodificación: Nominatim (OpenStreetMap). Rutas: OSRM (OpenStreetMap). Ninguno pide cuenta ni key.
// OSRM no sabe de inundaciones: pedimos rutas alternativas y, si todas cruzan una zona activa,
// probamos desvíos pasando por puntos a los lados de esa zona hasta encontrar una ruta libre.
import { haversine, bearing, nearestOnLine, inPolygon } from './gps.js';
import { esc, toast, ICON } from './common.js';

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
  const url = `${OSRM}${pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';')}?overview=full&geometries=geojson${alternatives ? '&alternatives=3' : ''}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('OSRM ' + r.status);
  const j = await r.json();
  if (j.code && j.code !== 'Ok') throw new Error(j.code);
  return (j.routes || []).map(x => ({ coords: x.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distance: x.distance, duration: x.duration }));
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

export async function geocode(q, center) {
  const vb = [center.lng - 0.2, center.lat + 0.2, center.lng + 0.2, center.lat - 0.2].join(',');
  const go = async extra => {
    const r = await fetch(`${NOMINATIM}?format=jsonv2&limit=6&countrycodes=ec&accept-language=es&q=${encodeURIComponent(q)}&viewbox=${vb}${extra}`, { signal: AbortSignal.timeout(8000) });
    return (await r.json()).map(x => ({ name: x.name || x.display_name.split(',')[0], label: x.display_name, lat: +x.lat, lng: +x.lon }));
  };
  const near = await go('&bounded=1');
  return near.length ? near : go('');
}

const fmtKm = m => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`);
const fmtMin = s => `${Math.max(1, Math.round(s / 60))} min`;

export function createNav({ getMap, getState, getUser, startGps }) {
  const $ = s => document.querySelector(s);
  let trip = null;      // { dest, origin, route }
  let shapes = [], detourR = null, picking = false, timer = null, seq = 0, replanning = false;

  const input = $('#nav-q'), list = $('#nav-results'), card = $('#nav-card');
  $('#nav-ic').innerHTML = ICON.search || ICON.nav;
  input.addEventListener('input', () => {
    clearTimeout(timer); const q = input.value.trim(); $('#nav-clear').hidden = !q;
    if (q.length < 3) { list.hidden = true; return; }
    timer = setTimeout(() => search(q), 450);
  });
  input.addEventListener('focus', () => { if (list.innerHTML) list.hidden = false; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('[data-i]')?.click(); } if (e.key === 'Escape') list.hidden = true; });
  $('#nav-clear').addEventListener('click', () => { input.value = ''; $('#nav-clear').hidden = true; list.hidden = true; end(); input.focus(); });
  document.addEventListener('click', e => { if (!e.target.closest('.nav-search')) list.hidden = true; });

  async function search(q) {
    const my = ++seq; const st = getState();
    list.hidden = false; list.innerHTML = `<div class="nav-msg">Buscando…</div>`;
    let res = [];
    try { res = await geocode(q, st.config.center); } catch { if (my === seq) list.innerHTML = `<div class="nav-msg">No se pudo buscar ahora (sin conexión con OpenStreetMap).</div>${pickBtn()}`; bindPick(); return; }
    if (my !== seq) return;
    list.innerHTML = (res.length ? res.map((r, i) => `<button type="button" class="nav-res" data-i="${i}">${ICON.pin}<span><b>${esc(r.name)}</b><small>${esc(r.label)}</small></span></button>`).join('') : `<div class="nav-msg">Sin resultados para “${esc(q)}”.</div>`) + pickBtn();
    list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const r = res[+b.dataset.i]; input.value = r.name; list.hidden = true; go(r); });
    bindPick();
  }
  const pickBtn = () => `<button type="button" class="nav-res pick" data-pick>${ICON.nav}<span><b>Elegir el destino en el mapa</b><small>Toca el lugar al que quieres ir</small></span></button>`;
  function bindPick() { list.querySelector('[data-pick]')?.addEventListener('click', () => { list.hidden = true; picking = true; document.body.classList.add('nav-picking'); toast('Toca en el mapa el lugar al que quieres ir', 'ok'); }); }

  async function origin() {
    const u = getUser(); if (u) return { lat: u.lat, lng: u.lng, mine: true };
    if ('geolocation' in navigator && window.isSecureContext) {
      try {
        const p = await new Promise((ok, ko) => navigator.geolocation.getCurrentPosition(ok, ko, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }));
        return { lat: p.coords.latitude, lng: p.coords.longitude, mine: true };
      } catch {}
    }
    const c = getState().config.center; toast('No tenemos tu ubicación: la ruta sale desde el centro de la ciudad.', 'err');
    return { lat: c.lat, lng: c.lng, mine: false };
  }

  async function go(dest) {
    card.hidden = false; card.className = 'nav-card loading';
    card.innerHTML = `<div class="nav-spin"></div><div><b>Calculando ruta segura…</b><small>Revisando zonas inundadas activas</small></div>`;
    try {
      const o = await origin();
      const route = await safeRoute(o, dest, hazardZones(getState()));
      trip = { dest, origin: o, route }; draw(true); renderCard();
    } catch (e) {
      card.className = 'nav-card err';
      card.innerHTML = `<div><b>No se pudo calcular la ruta</b><small>Sin conexión con el servicio de rutas de OpenStreetMap. Intenta de nuevo en un momento.</small></div><button class="btn sm ghost" id="nav-x">Cerrar</button>`;
      $('#nav-x').onclick = end;
    }
  }
  function renderCard() {
    const r = trip.route, bad = r.blocked?.length;
    card.hidden = false; card.className = `nav-card ${bad ? 'warn' : 'ok'}`;
    card.innerHTML = `
      <div class="nav-badge">${bad ? ICON.warn : ICON.check}</div>
      <div class="nav-info"><small>${trip.origin.mine ? 'Desde tu ubicación' : 'Desde el centro'} hasta</small><b>${esc(trip.dest.name)}</b>
        <div class="nav-meta"><span>${fmtKm(r.distance)}</span><span>${fmtMin(r.duration)}</span></div>
        <div class="nav-note">${bad ? `No hay una ruta totalmente libre: pasa por ${esc(r.blocked.map(z => z.name).join(', '))}. Extreme precaución.`
          : r.avoided?.length ? `Ruta segura: evita ${r.avoided.length === 1 ? esc(r.avoided[0]) : `${r.avoided.length} zonas inundadas`}.` : 'Ruta libre de zonas inundadas.'}</div></div>
      <div class="nav-acts">${getUser() ? '' : `<button class="btn sm" id="nav-start">${ICON.nav} Iniciar</button>`}<button class="btn sm ghost" id="nav-x" aria-label="Terminar ruta">${ICON.x}</button></div>`;
    $('#nav-start')?.addEventListener('click', () => { startGps(); renderCard(); });
    $('#nav-x').onclick = () => { input.value = ''; $('#nav-clear').hidden = true; end(); };
  }
  function draw(fit) {
    shapes.forEach(s => s.remove?.()); shapes = [];
    const map = getMap();
    if (!trip) { if (detourR) shapes.push(map.addPolyline({ coords: detourR.coords, status: 'nav', flow: 'route', weight: 8, popup: `<b>${esc(detourR.name)}</b>` })); return; }
    shapes.push(map.addPolyline({ coords: trip.route.coords, status: 'nav', flow: 'route', weight: 8, popup: `<b>Tu ruta a ${esc(trip.dest.name)}</b><br>${fmtKm(trip.route.distance)} · ${fmtMin(trip.route.duration)}` }));
    shapes.push(map.addMarker({ lat: trip.dest.lat, lng: trip.dest.lng, cls: 'nav-dest', icon: 'flag', popup: `<b>${esc(trip.dest.name)}</b>` }));
    if (fit) map.fitBounds([[trip.origin.lat, trip.origin.lng], ...trip.route.coords]);
  }
  function end() { trip = null; detourR = null; draw(); card.hidden = true; card.innerHTML = ''; }

  // Desvío automático para el GPS: desde la posición actual hasta un punto pasando la zona, sin cruzarla.
  async function detour(user, hz) {
    const c = hz.coords?.length ? { lat: hz.coords[Math.floor(hz.coords.length / 2)][0], lng: hz.coords[Math.floor(hz.coords.length / 2)][1] } : null;
    if (!c) return null;
    const dest = trip ? trip.dest : offset(c, bearing(user, c), 350);
    const r = await safeRoute(user, dest, hazardZones(getState()));
    if (r.blocked?.length) return null;
    return { id: 'auto', name: trip ? `Ruta segura a ${trip.dest.name}` : 'Desvío automático', description: r.avoided?.length ? `Evita ${r.avoided.join(', ')}.` : '', coords: r.coords, auto: true };
  }
  function showDetour(r) {
    if (trip) { trip.route = { ...trip.route, coords: r.coords }; draw(); return; }
    detourR = r; draw(false);
  }

  // Cada vez que el mapa se redibuja: volver a pintar la ruta y recalcular si ahora cruza una zona nueva.
  async function refresh() {
    draw(false);
    if (!trip || replanning) return;
    if (blockers(trip.route.coords, hazardZones(getState())).length && !trip.route.blocked?.length) {
      replanning = true;
      try { const u = getUser(); const o = u || trip.origin; trip.route = await safeRoute(o, trip.dest, hazardZones(getState())); draw(false); renderCard(); toast('Se activó una zona inundada en tu camino: recalculamos la ruta.', 'ok'); } catch {}
      replanning = false;
    }
  }

  return {
    refresh, detour, showDetour, go,
    get active() { return !!trip; },
    onMapClick(pos) { if (!picking) return false; picking = false; document.body.classList.remove('nav-picking'); input.value = 'Punto elegido en el mapa'; $('#nav-clear').hidden = false; go({ ...pos, name: 'el punto elegido' }); return true; },
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
