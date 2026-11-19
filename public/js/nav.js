// Buscador de destino y rutas que esquivan las zonas inundadas.
// Geocodificación: Nominatim (OpenStreetMap). Rutas: OSRM (OpenStreetMap). Ninguno pide cuenta ni key.
// OSRM no sabe de inundaciones: pedimos rutas alternativas y, si todas cruzan una zona activa,
// probamos desvíos pasando por puntos a los lados de esa zona hasta encontrar una ruta libre.
import { haversine, bearing, nearestOnLine, inPolygon } from './gps.js';
import { esc, toast, ICON } from './common.js';
import { fromOsrmStep, createGuide } from './guide.js';
import { localSearch, createRemoteSearch, fmtDist, CITIES, QUICK_CITIES, TRAVEL_RADIUS_M } from './places.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

// Calles donde no pasan vehículos (malecón, peatonales…): OSRM a veces las usa porque en OpenStreetMap no están marcadas.
// Se reconocen por el nombre que trae cada paso de la ruta (lista editable en Admin → Configuración).
let NO_CAR = [];
const plain = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const setNoCar = list => { NO_CAR = (Array.isArray(list) ? list : []).map(plain).filter(x => x.length > 2); };
const noCarName = name => { const n = plain(name); return n && NO_CAR.some(w => n === w || n.includes(w)) ? name : null; };
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

// heading (opcional): rumbo del vehículo; así la ruta nueva sigue hacia donde va el auto en vez de mandarlo a dar la vuelta.
// ¿La ruta entra a un tramo y vuelve por el mismo camino (una "punta" que no va a ningún lado)?
// Pasa cuando un punto de paso cae al final de una calle sin salida: la ruta llega, da la vuelta y regresa.
export function hasSpur(coords) {
  const c = densify(coords, 10), P = i => ({ lat: c[i][0], lng: c[i][1] });
  for (let k = 8; k < c.length; k++) {
    for (let j = Math.max(0, k - 60); j <= k - 8; j++) {
      if (haversine(P(j), P(k)) > 9) continue;
      const m = Math.floor((j + k) / 2), out = c.slice(j, m + 1);
      let back = true;
      for (let t = m; t <= k && back; t++) back = nearestOnLine(P(t), out).d < 10;
      if (back) return true;
    }
  }
  return false;
}

async function osrm(pts, alternatives, heading = null) {
  const get = async hd => {
    const b = hd == null || isNaN(hd) ? '' : `&bearings=${[`${Math.round(((hd % 360) + 360) % 360)},70`, ...pts.slice(1).map(() => '')].join(';')}`;
    const url = `${OSRM}${pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';')}?overview=full&geometries=geojson&steps=true${alternatives ? '&alternatives=3' : ''}${b}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('OSRM ' + r.status);
    const j = await r.json();
    if (j.code && j.code !== 'Ok') throw new Error(j.code);
    return j;
  };
  let j;
  try { j = await get(heading); } catch (e) { if (heading == null) throw e; j = await get(null); } // sin ese rumbo no hay calle cercana: se intenta sin él
  return (j.routes || []).map(x => ({ coords: x.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distance: x.distance, duration: x.duration,
    noCar: (x.legs || []).flatMap(l => l.steps || []).filter(st => st.geometry?.coordinates?.length > 1 && noCarName(st.name)).map(st => ({ name: st.name, coords: st.geometry.coordinates.map(([lng, lat]) => [lat, lng]) })),
    steps: (x.legs || []).flatMap((l, i, all) => (l.steps || []).filter(st => !(st.maneuver?.type === 'arrive' && i < all.length - 1) && !(st.maneuver?.type === 'depart' && i > 0)).map(fromOsrmStep)) }));
}

// Ruta de o a d que evite las zonas. Devuelve { coords, distance, duration, avoided:[nombres], blocked:[zonas aún cruzadas] }
export async function safeRoute(o, d, zones) {
  const hd = o.heading ?? null; // si 'o' trae rumbo (auto en marcha), la ruta nueva respeta hacia dónde va
  const base = await osrm([o, d], true, hd);
  if (!base.length) throw new Error('Sin ruta');
  // las calles sin paso de vehículos que aparezcan en cualquier ruta se tratan como zonas a evitar
  const Z = [...zones], seen = new Set();
  const absorb = r => { for (let q of r.noCar || []) { q = { ...q, coords: q.coords.filter(([la, ln]) => haversine({ lat: la, lng: ln }, o) > 80 && haversine({ lat: la, lng: ln }, d) > 80) }; if (q.coords.length < 2) continue; const key = `${plain(q.name)}|${q.coords[0].map(v => v.toFixed(4))}`; if (seen.has(key)) continue; seen.add(key); Z.push({ id: 'nc-' + key, name: `${q.name} (no apta para vehículos)`, kind: 'street', coords: q.coords, center: mid(q.coords), restricted: true }); } return r; };
  base.forEach(absorb);
  const directHits = blockers(base[0].coords, Z);
  const score = r => ({ ...absorb(r), blocked: blockers(r.coords, Z) });
  // A igual de rápida, se prefiere la ruta con menos giros (una avenida larga antes que zigzaguear por calles chicas): cada giro cuenta como 25 s extra.
  const turns = r => (r.steps || []).filter(t => t.icon && t.icon !== 'straight' && t.type !== 'arrive' && t.type !== 'depart').length;
  const cost = r => r.duration + 25 * turns(r);
  let cands = base.map(score);
  // Rutas alternativas: hasta 2 más, distintas de la elegida, también libres de zonas inundadas y sin puntas.
  // Si OSRM no ofrece suficientes, se piden pasando por un punto a un lado del camino (a 30 %, 50 % y 70 % del trayecto).
  const sameRoute = (a, b) => { const pts = a.coords.filter((_, i) => i % 4 === 0); return pts.filter(q => nearestOnLine({ lat: q[0], lng: q[1] }, b.coords).d < 40).length / pts.length > .85; };
  const finish = async (main, pool, avoided) => {
    const alts = [];
    const take = list => { for (const c of list.sort((a, b) => cost(a) - cost(b))) { if (alts.length >= 2) break; if (c === main || c.blocked.length || hasSpur(c.coords)) continue; if ([main, ...alts].some(x => sameRoute(c, x) || sameRoute(x, c))) continue; alts.push(c); } };
    take(pool.slice());
    if (alts.length < 2 && !main.blocked.length) {
      const n = main.coords.length, tries = [];
      for (const f of [.3, .5, .7]) { const i = Math.max(0, Math.min(n - 2, Math.floor(n * f))), a = { lat: main.coords[i][0], lng: main.coords[i][1] }, b = { lat: main.coords[i + 1][0], lng: main.coords[i + 1][1] }, br = bearing(a, b); for (const side of [90, -90]) tries.push(offset(a, br + side, 350)); }
      const res = await Promise.all(tries.map(async v => { try { const r = (await osrm([o, v, d], false, hd))[0]; return r ? score(r) : null; } catch { return null; } }));
      take(res.filter(Boolean));
    }
    return { ...main, avoided, alts };
  };
  let clean = cands.filter(c => !c.blocked.length).sort((a, b) => cost(a) - cost(b))[0];
  if (clean) return finish(clean, cands, directHits.map(z => z.name));
  // Desvíos: puntos de paso a ambos lados de la zona que bloquea, cada vez más lejos.
  let vias = [], best = cands.sort((a, b) => a.blocked.length - b.blocked.length || a.duration - b.duration)[0];
  const tryVias = async tries => {
    const results = await Promise.all(tries.map(async v => {
      const all = [...vias, v].sort((x, y) => haversine(o, x) - haversine(o, y));
      try { const r = (await osrm([o, ...all, d], false, hd))[0]; return r ? { ...score(r), vias: all } : null; } catch { return null; }
    }));
    let ok = results.filter(Boolean);
    const noSpur = ok.filter(c => !hasSpur(c.coords)); // un desvío que llega a una calle sin salida y regresa no sirve
    if (noSpur.length) ok = noSpur;
    // lo que se descubrió al probar los desvíos también cuenta: se vuelve a evaluar contra todas las zonas conocidas
    ok.forEach(c => { c.blocked = blockers(c.coords, Z); });
    return ok;
  };
  for (let round = 0; round < 4 && best.blocked.length; round++) {
    const z = best.blocked[0], brg = bearing(o, d);
    // 1.º a los dos lados de la zona (lo habitual); si ninguno sirve, en las 8 direcciones y a más distancias
    let ok = await tryVias([220, 380, 600].flatMap(dist => [90, -90].map(side => offset(z.center, brg + side, dist))));
    clean = ok.filter(c => !c.blocked.length).sort((a, b) => cost(a) - cost(b))[0];
    if (!clean) {
      const more = await tryVias([160, 300, 500].flatMap(dist => [0, 45, 135, 180, 225, 315].map(a => offset(z.center, brg + a, dist))));
      ok = [...ok, ...more];
      clean = ok.filter(c => !c.blocked.length).sort((a, b) => cost(a) - cost(b))[0];
    }
    if (clean) return finish(clean, ok, directHits.map(x => x.name));
    if (!ok.length) break;
    best = ok.sort((a, b) => a.blocked.length - b.blocked.length || a.duration - b.duration)[0];
    vias = best.vias;
  }
  return { ...best, avoided: directHits.filter(z => !best.blocked.includes(z)).map(x => x.name) };
}

const fmtKm = m => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`);
const fmtMin = s => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
const clock = secs => new Date(Date.now() + secs * 1000).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Guardado local (funciona sin red): lugares favoritos, rutas guardadas y la ruta en curso.
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const slim = r => ({ coords: r.coords.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]), distance: r.distance, duration: r.duration, steps: r.steps || [], avoided: r.avoided || [], blocked: (r.blocked || []).map(z => ({ name: z.name })) });

// Punto de salida desde la posición del vehículo; el rumbo solo cuenta si va en movimiento (parado, el GPS no sabe hacia dónde mira).
const startFrom = u => ({ lat: u.lat, lng: u.lng, heading: (u.speed == null || u.speed > 1.5) && u.heading != null && !isNaN(u.heading) ? u.heading : null });

export function createNav({ getMap, getState, getUser, startGps, onChange = () => {}, sim = false, getDirect = () => false, getVoice = () => true }) {
  const $ = s => document.querySelector(s);
  let trip = null;      // { dest, origin, route, saved?, offline? }
  let shapes = [], detourR = null, picking = null, timer = null, seq = 0, replanning = false, plTimer = null, plSeq = 0;
  let from = null;      // null = mi ubicación; { lat, lng, name } = punto elegido
  let planTo = null;    // destino elegido en el panel "Mi ruta"
  let pendingDest = null; // simulador: destino en espera mientras se marca la salida
  let restore = sim ? null : LS.get('av_trip', null);

  const input = $('#nav-q'), list = $('#nav-results'), card = $('#nav-card');
  const fromIn = $('#nav-from'), fromRow = $('#nav-from-row'), fromClr = $('#nav-from-clear');
  let mode = 'dest', lastDest = null; // mode: qué campo está buscando ('dest' | 'from')
  // El campo "Punto de partida" aparece al buscar o cuando ya hay ruta; vacío = mi ubicación (GPS)
  function paintFrom() {
    fromIn.value = from ? from.name : ''; fromClr.hidden = !from; fromRow.classList.toggle('set', !!from);
    fromRow.hidden = !(from || trip || lastDest || input.value.trim() || document.activeElement === input || document.activeElement === fromIn);
  }
  // Indicaciones giro a giro; si el vehículo toma otra calle, se recalcula el camino desde donde está.
  // Tiempo y distancia que faltan (hoja inferior del modo navegación)
  function etaUpdate(r) {
    const el = $('#gps-eta'); if (!el) return;
    if (!r) { el.hidden = true; el.innerHTML = ''; return; }
    const at = new Date(Date.now() + r.dur * 1000).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' });
    el.hidden = false; el.innerHTML = `<b>${fmtMin(r.dur)}</b><span>${fmtKm(r.remain)} · ${at}</span>`;
  }
  const guide = createGuide({ el: $('#turn'), onProgress: etaUpdate, getVoice, onOffRoute: async user => {
    if (!trip) return;
    const route = await safeRoute(startFrom(user), trip.dest, hazardZones(getState()));
    setTrip({ ...trip, origin: { lat: user.lat, lng: user.lng, mine: true }, route, direct: false, offline: false }); draw(false); renderCard();
    toast(route.avoided?.length ? `Nueva ruta: sigue evitando ${route.avoided.length === 1 ? route.avoided[0] : `${route.avoided.length} zonas inundadas`}.` : 'Nueva ruta calculada desde donde estás.', 'ok');
  } });
  $('#nav-ic').innerHTML = ICON.search || ICON.nav;
  $('#nav-plan').innerHTML = ICON.route;
  const remote = createRemoteSearch();
  // La lista de resultados nunca queda tapada por el teclado del teléfono: se ajusta al alto visible
  const fitList = () => { if (list.hidden) return; const vv = window.visualViewport, top = list.getBoundingClientRect().top - (vv?.offsetTop || 0), h = (vv ? vv.height : innerHeight) - top - 12; list.style.maxHeight = `${Math.max(150, Math.min(460, h))}px`; };
  window.visualViewport?.addEventListener('resize', fitList);
  new MutationObserver(fitList).observe(list, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  input.addEventListener('input', () => {
    mode = 'dest'; paintFrom(); clearTimeout(timer); const q = input.value.trim(); $('#nav-clear').hidden = !q;
    if (!q) { list.innerHTML = ''; showQuick(); return; }
    if (q.length < 2) { list.hidden = true; return; }
    search(q); // los resultados de la ciudad y los lugares guardados salen al instante; los de internet llegan enseguida
  });
  input.addEventListener('focus', () => { mode = 'dest'; paintFrom(); if (!input.value.trim()) showQuick(); else if (list.innerHTML) list.hidden = false; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('[data-i]')?.click(); } if (e.key === 'Escape') list.hidden = true; });
  fromIn.addEventListener('focus', () => { mode = 'from'; paintFrom(); if (!fromIn.value.trim() || from) showQuickFrom(); else if (list.innerHTML) list.hidden = false; });
  fromIn.addEventListener('input', () => {
    mode = 'from'; clearTimeout(timer); const q = fromIn.value.trim(); fromClr.hidden = !q && !from;
    if (!q) { list.innerHTML = ''; showQuickFrom(); return; }
    if (q.length < 2) { list.hidden = true; return; }
    search(q);
  });
  fromIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('[data-i]')?.click(); } if (e.key === 'Escape') list.hidden = true; });
  fromIn.addEventListener('blur', () => setTimeout(paintFrom, 200));
  input.addEventListener('blur', () => setTimeout(paintFrom, 200));
  fromClr.addEventListener('click', () => { cancelSearch(); const had = !!from; from = null; fromIn.value = ''; list.hidden = true; list.innerHTML = ''; paintFrom(); const d = trip?.dest || lastDest; if (had && d) go(d); else fromIn.focus(); });
  $('#nav-clear').addEventListener('click', () => { lastDest = null; cancelSearch(); input.value = ''; $('#nav-clear').hidden = true; list.hidden = true; list.innerHTML = ''; end(); input.focus(); });
  document.addEventListener('click', e => { if (!e.target.closest('.nav-search')) list.hidden = true; });

  // Punto de partida: mi ubicación, un punto en el mapa, lugares guardados o ciudades
  function showQuickFrom() {
    const pl = LS.get('av_places', []);
    list.innerHTML = `<button type="button" class="nav-res${from ? '' : ' pick'}" data-me>${ICON.nav}<span><b>Mi ubicación (GPS)</b><small>Saldrás desde donde estás ahora</small></span></button>
      <button type="button" class="nav-res pick" data-pickfrom>${ICON.pin}<span><b>Elegir el punto de partida en el mapa</b><small>Toca el lugar desde donde sales</small></span></button>
      <div class="nav-sec">Ciudades cercanas</div>${chips()}` + (pl.length ? `<div class="nav-sec">Mis lugares</div>` + pl.slice(0, 4).map((p, i) => `<button type="button" class="nav-res" data-pl="${i}">${ICON.pin}<span><b>${esc(p.name)}</b><small>Lugar guardado</small></span></button>`).join('') : '');
    list.hidden = false;
    list.querySelector('[data-me]').onclick = () => { fromClr.click(); list.hidden = true; fromIn.blur(); };
    list.querySelector('[data-pickfrom]').onclick = () => { cancelSearch(); list.hidden = true; fromIn.blur(); startPick('from-s'); };
    list.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => chooseFrom(pl[+b.dataset.pl]));
    list.querySelectorAll('[data-city]').forEach(b => b.onclick = () => { const c = CITIES.find(x => x.name === b.dataset.city); if (c) chooseFrom({ ...c, kind: 'city' }); });
  }
  function chooseFrom(r) {
    cancelSearch(); from = { lat: r.lat, lng: r.lng, name: r.name }; list.hidden = true; fromIn.blur(); paintFrom();
    const d = trip?.dest || lastDest; if (d) go(d); else input.focus();
  }

  // Sin escribir nada: ciudades cercanas a un toque, rutas y lugares guardados.
  function showQuick() {
    const pl = LS.get('av_places', []), sv = LS.get('av_routes', []);
    list.innerHTML = `<div class="nav-sec">Ciudades cercanas</div>${chips()}` + (sv.length || pl.length ? `<div class="nav-sec">Mis rutas y lugares</div>` : '') +
      [...sv.slice(0, 3).map((r, i) => `<button type="button" class="nav-res" data-sv="${i}">${ICON.route}<span><b>${esc(r.name)}</b><small>Ruta guardada · funciona sin conexión</small></span></button>`),
        ...pl.slice(0, 4).map((p, i) => `<button type="button" class="nav-res" data-pl="${i}">${ICON.pin}<span><b>${esc(p.name)}</b><small>Lugar guardado</small></span></button>`)].join('') + pickBtn();
    list.hidden = false;
    list.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => { cancelSearch(); list.hidden = true; input.blur(); openSaved(sv[+b.dataset.sv]); });
    list.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => choose(pl[+b.dataset.pl]));
    list.querySelectorAll('[data-city]').forEach(b => b.onclick = () => { const c = CITIES.find(x => x.name === b.dataset.city); if (c) choose({ ...c, kind: 'city' }); });
    bindPick(list);
  }

  // Una fila de resultado: ciudades, lugares guardados y lo del mapa salen al instante; lo demás llega de internet
  const KIND_IC = { city: ICON.route, saved: ICON.pin, map: ICON.warn };
  const resRow = (r, i) => `<button type="button" class="nav-res${r.kind === 'city' ? ' city' : ''}" data-i="${i}">${KIND_IC[r.kind] || ICON.pin}<span><b>${esc(r.name)}</b><small>${esc([r.label, r.dist != null && r.dist > 1500 ? fmtDist(r.dist) : ''].filter(Boolean).join(' · '))}</small></span></button>`;
  const chips = () => `<div class="nav-chips" role="group" aria-label="Ciudades cercanas">${QUICK_CITIES.map(n => `<button type="button" class="nav-chip" data-city="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
  function bindRows(el, rows, pick) {
    el.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { const r = rows[+b.dataset.i]; if (r) pick(r); });
    el.querySelectorAll('[data-city]').forEach(b => b.onclick = () => { const c = CITIES.find(x => x.name === b.dataset.city); if (c) pick({ ...c, kind: 'city' }); });
  }
  const cancelSearch = () => { seq++; plSeq++; clearTimeout(timer); clearTimeout(plTimer); };
  const choose = r => { lastDest = r; cancelSearch(); input.value = r.name; $('#nav-clear').hidden = false; list.hidden = true; input.blur(); go(r); };
  const saved = () => LS.get('av_places', []);
  async function search(q) {
    const my = ++seq, st = getState(), center = st.config.center;
    const near = localSearch(q, { center, saved: saved(), state: st });
    const draw = (rows, status) => {
      list.hidden = false;
      list.innerHTML = rows.map(resRow).join('') + (status === 'load' ? `<div class="nav-msg load"><i class="nav-dots" aria-hidden="true"></i>Buscando más lugares…</div>`
        : status === 'none' ? `<div class="nav-msg">No encontramos “${esc(q)}”. Prueba con otra palabra (por ejemplo el nombre de la calle o el barrio), una ciudad de abajo, o elige el punto en el mapa.</div>${chips()}`
        : status === 'off' ? `<div class="nav-msg">Sin conexión para buscar más lugares. Puedes elegir una ciudad, el punto en el mapa o una ruta guardada.</div>` : '') + (mode === 'from' ? '' : pickBtn());
      bindRows(list, rows, r => mode === 'from' ? chooseFrom(r) : choose(r)); bindPick(list);
    };
    draw(near, 'load');
    try {
      const far = await new Promise((ok, ko) => { timer = setTimeout(() => remote(q, center).then(ok, ko), 90); });
      if (my !== seq) return;
      const rows = [...near, ...far.filter(f => !near.some(n => n.name === f.name && Math.abs(n.lat - f.lat) < .03))].slice(0, 9);
      draw(rows, rows.length ? '' : 'none');
    } catch (e) {
      if (my !== seq) return; // el usuario siguió escribiendo: esta búsqueda ya no vale
      draw(near, navigator.onLine === false ? 'off' : near.length ? '' : 'none');
    }
  }
  const pickBtn = () => `<button type="button" class="nav-res pick" data-pick>${ICON.nav}<span><b>Elegir el destino en el mapa</b><small>Toca el lugar al que quieres ir</small></span></button><div class="nav-scope">Lugares de Santa Rosa y ciudades cercanas</div>`;
  function bindPick(el) { el.querySelector('[data-pick]')?.addEventListener('click', () => { cancelSearch(); list.hidden = true; startPick('go'); }); }
  function startPick(target) {
    picking = target; document.body.classList.add('nav-picking'); closePlan();
    toast(target === 'from-go' ? 'Simulación: toca en el mapa de dónde sale el vehículo' : (target === 'from' || target === 'from-s') ? 'Toca en el mapa el lugar desde donde sales' : 'Toca en el mapa el lugar al que quieres ir', 'ok');
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
      setTrip({ dest, origin: o, route, direct, options: route.alts?.length ? [route, ...route.alts.map(a => ({ ...a, avoided: route.avoided }))] : null, sel: 0 }); renderCard(); draw(true); setTimeout(() => draw(true), 380);
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
  // Varias rutas libres de zonas inundadas: la persona escoge (como en un mapa de viajes)
  function chooseRoute(i) {
    if (!trip?.options?.[i] || trip.sel === i) return;
    trip.sel = i; trip.route = trip.options[i]; setTrip(trip); draw(false); renderCard();
    toast(`Ruta ${i + 1} elegida: ${fmtKm(trip.route.distance)}, ${fmtMin(trip.route.duration)}.`, 'ok');
  }
  function setTrip(t) {
    trip = t; guide.setRoute(trip ? trip.route : null); if (!trip) { guide.hide(); etaUpdate(null); }
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
        <div class="nav-meta"><span>${fmtMin(r.duration)}</span><span>${fmtKm(r.distance)}</span><span class="nav-eta">Llegas ${clock(r.duration)}</span></div>
        ${trip.options?.length > 1 ? `<div class="nav-opts" role="radiogroup" aria-label="Rutas posibles">${trip.options.map((o, i) => `<button type="button" role="radio" aria-checked="${i === trip.sel}" class="nav-opt${i === trip.sel ? ' on' : ''}" data-opt="${i}"><b>Ruta ${i + 1}</b><small>${fmtMin(o.duration)} · ${fmtKm(o.distance)}</small></button>`).join('')}</div>` : ''}
        <div class="nav-note">${trip.direct && bad ? `Ruta directa de prueba: cruza ${esc(r.blocked.map(z => z.name).join(', '))}. El GPS avisará al acercarse y ofrecerá un desvío.` : bad ? `No hay una ruta totalmente libre: pasa por ${esc(r.blocked.map(z => z.name).join(', '))}. Extreme precaución.`
          : r.avoided?.length ? `Ruta segura: evita ${r.avoided.length === 1 ? esc(r.avoided[0]) : `${r.avoided.length} zonas inundadas o calles cerradas`}.` : 'Ruta libre de zonas inundadas.'}</div>
        ${r.distance > 25000 ? `<div class="nav-far">${ICON.info} Viaje fuera de la ciudad: el mapa solo marca las zonas inundadas de Santa Rosa. En el camino sigue la señalización y las indicaciones de las autoridades.</div>` : ''}
        ${trip.offline ? `<div class="nav-off">${ICON.info} Sin conexión: usando tu ruta guardada.</div>` : ''}</div>
      <div class="nav-acts">${getUser() ? '' : `<button class="btn sm" id="nav-start">${sim ? ICON.play || ICON.nav : ICON.nav} ${sim ? 'Simular' : 'Iniciar'}</button>`}
        <button class="btn sm ghost${saved ? ' on' : ''}" id="nav-save" aria-pressed="${saved}" title="Guardar para usarla sin conexión">${saved ? ICON.check + ' Guardada' : 'Guardar'}</button>
        <button class="btn sm ghost" id="nav-x" aria-label="Terminar ruta">${ICON.x}</button></div>`;
    card.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => chooseRoute(+b.dataset.opt));
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
    (trip.options || []).forEach((o, i) => { if (i !== trip.sel) shapes.push(map.addPolyline({ coords: o.coords, status: 'osm', weight: 7, popup: `<b>Ruta ${i + 1}</b><br>${fmtKm(o.distance)} · ${fmtMin(o.duration)}<br><small>Tocar la línea elige esta ruta</small>`, onClick: () => chooseRoute(i) })); });
    shapes.push(map.addPolyline({ coords: trip.route.coords, status: 'nav', flow: 'route', weight: 8, popup: `<b>Tu ruta a ${esc(trip.dest.name)}</b><br>${fmtKm(trip.route.distance)} · ${fmtMin(trip.route.duration)}` }));
    if (!trip.origin.mine) shapes.push(map.addMarker({ lat: trip.origin.lat, lng: trip.origin.lng, cls: 'nav-from', icon: 'nav', popup: `<b>Salida</b><br>${esc(trip.origin.name || 'Punto elegido')}` }));
    shapes.push(map.addMarker({ lat: trip.dest.lat, lng: trip.dest.lng, cls: 'nav-dest', icon: 'flag', popup: `<b>${esc(trip.dest.name)}</b>` }));
    // la ruta se encuadra en lo que queda libre: debajo del buscador y encima de la tarjeta de ruta
    if (fit) { const mw = document.querySelector('.mapwrap')?.getBoundingClientRect(), cr = card.hidden ? null : card.getBoundingClientRect(), mob = innerWidth <= 900;
      map.fitBounds([[trip.origin.lat, trip.origin.lng], ...trip.route.coords], { top: mob ? 70 : 0, bottom: mob && cr && mw ? Math.max(0, mw.bottom - cr.top) : 0 }); }
  }
  function end() { paintFrom(); setTrip(null); detourR = null; draw(); card.hidden = true; card.innerHTML = ''; }

  /* ---------- Panel "Mi ruta": de dónde sales y a dónde vas ---------- */
  const plan = $('#plan-bg');
  function openPlan() { list.hidden = true; renderPlan(); plan.classList.add('open'); }
  function closePlan() { plan.classList.remove('open'); }
  function renderPlan() {
    paintFrom();
    $('#pl-from').textContent = from ? from.name : 'Mi ubicación (GPS)';
    document.querySelectorAll('[data-from]').forEach(b => b.classList.toggle('on', (b.dataset.from === 'me') === !from));
    if (planTo) $('#pl-to').value = planTo.name;
    $('#pl-go').disabled = !planTo;
    $('#pl-cities').innerHTML = `<h3>Ciudades cercanas</h3><div class="pl-chips">${QUICK_CITIES.map(n => `<span class="pl-chip${planTo?.name === n ? ' on' : ''}"><button type="button" data-pcity="${esc(n)}">${ICON.pin}${esc(n)}</button></span>`).join('')}</div>`;
    plan.querySelectorAll('[data-pcity]').forEach(b => b.onclick = () => { planTo = { ...CITIES.find(c => c.name === b.dataset.pcity), kind: 'city' }; renderPlan(); });
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
  const planRemote = createRemoteSearch();
  $('#pl-to').addEventListener('input', () => {
    clearTimeout(plTimer); const q = $('#pl-to').value.trim(); planTo = null; $('#pl-go').disabled = true;
    const box = $('#pl-res'); if (q.length < 2) { box.innerHTML = ''; return; }
    const my = ++plSeq, st = getState(), center = st.config.center, near = localSearch(q, { center, saved: saved(), state: st });
    const draw = (rows, status) => {
      box.innerHTML = rows.slice(0, 7).map(resRow).join('') + (status === 'load' ? `<div class="nav-msg load"><i class="nav-dots" aria-hidden="true"></i>Buscando más lugares…</div>`
        : status === 'none' ? `<div class="nav-msg">No lo encontramos. Prueba otra palabra, una ciudad o “En el mapa”.</div>` : status === 'off' ? `<div class="nav-msg">Sin conexión para buscar más lugares.</div>` : '');
      bindRows(box, rows, r => { planTo = r; box.innerHTML = ''; renderPlan(); });
    };
    draw(near, 'load');
    plTimer = setTimeout(async () => {
      try { const far = await planRemote(q, center); if (my !== plSeq) return; const rows = [...near, ...far.filter(f => !near.some(n => n.name === f.name && Math.abs(n.lat - f.lat) < .03))]; draw(rows, rows.length ? '' : 'none'); }
      catch { if (my === plSeq) draw(near, navigator.onLine === false ? 'off' : near.length ? '' : 'none'); }
    }, 90);
  });
  $('#pl-go').addEventListener('click', () => { if (!planTo) return; closePlan(); input.value = planTo.name; $('#nav-clear').hidden = false; go(planTo); });

  // Desvío automático para el GPS: desde la posición actual hasta un punto pasando la zona, sin cruzarla.
  async function detour(user, hz) {
    const c = hz.coords?.length ? { lat: hz.coords[Math.floor(hz.coords.length / 2)][0], lng: hz.coords[Math.floor(hz.coords.length / 2)][1] } : null;
    if (!c) return null;
    const dest = trip ? trip.dest : offset(c, bearing(user, c), 350);
    const r = await safeRoute(startFrom(user), dest, hazardZones(getState()));
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
      try { const u = getUser(); const o = u ? startFrom(u) : trip.origin; setTrip({ ...trip, route: await safeRoute(o, trip.dest, hazardZones(getState())), offline: false }); draw(false); renderCard(); toast('Se activó una zona inundada en tu camino: recalculamos la ruta.', 'ok'); }
      catch { toast('Se activó una zona inundada en tu camino y no hay conexión para recalcular. Sigue las vías alternas del mapa.', 'err'); trip.route.blocked = [{ name: 'una zona recién activada' }]; renderCard(); }
      replanning = false;
    }
  }

  return {
    refresh, detour, showDetour, go, openPlan,
    get active() { return !!trip; },
    get trip() { return trip; },
    track(user) { if (trip && user) guide.update(user); else guide.hide(); },
    resetFrom() { from = null; paintFrom(); },
    onMapClick(pos) {
      if (!picking) return false;
      const c = getState()?.config?.center;
      if (c && haversine(c, pos) > TRAVEL_RADIUS_M) { toast('Ese punto queda muy lejos de El Oro. Escribe el nombre de la ciudad en el buscador.', 'err'); return true; }
      const t = picking; picking = null; document.body.classList.remove('nav-picking');
      if (t === 'from') { from = { ...pos, name: 'Punto elegido en el mapa' }; openPlan(); return true; }
      if (t === 'from-s') { from = { ...pos, name: 'Punto elegido en el mapa' }; paintFrom(); const d = trip?.dest || lastDest; if (d) go(d); else input.focus(); return true; }
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
