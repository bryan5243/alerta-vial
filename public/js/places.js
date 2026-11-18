// Búsqueda de lugares para el buscador de destino: rápida (resultados al instante mientras se escribe)
// y con alcance de viaje (Santa Rosa y ciudades cercanas de El Oro y la región).
//  1) Al instante, sin red: lugares guardados, ciudades cercanas, y puntos/calles/ríos/zonas del propio mapa.
//  2) Con red: Photon (OpenStreetMap, sirve para escribir a medias: "cement" ya encuentra "Cementerio") y,
//     si falla o no devuelve nada, Nominatim (OpenStreetMap). Ninguno pide cuenta ni key.
import { haversine } from './gps.js';

// Ciudades y pueblos cercanos (centro aproximado). Salen aunque no haya internet; la ruta la calcula OSRM.
export const CITIES = [
  { name: 'Machala', lat: -3.2581, lng: -79.9554, note: 'Capital de El Oro' },
  { name: 'Pasaje', lat: -3.3261, lng: -79.8044 },
  { name: 'Huaquillas', lat: -3.4767, lng: -80.2314, note: 'Frontera con Perú' },
  { name: 'Arenillas', lat: -3.5469, lng: -80.0689 },
  { name: 'El Guabo', lat: -3.2333, lng: -79.8333 },
  { name: 'Puerto Bolívar', lat: -3.2656, lng: -79.9917, note: 'Puerto de Machala' },
  { name: 'Zaruma', lat: -3.6931, lng: -79.6111 },
  { name: 'Piñas', lat: -3.6783, lng: -79.6836 },
  { name: 'Portovelo', lat: -3.7156, lng: -79.6167 },
  { name: 'Balsas', lat: -3.7667, lng: -79.8167 },
  { name: 'Marcabelí', lat: -3.7833, lng: -79.9167 },
  { name: 'Naranjal', lat: -2.6743, lng: -79.618, note: 'Guayas' },
  { name: 'Guayaquil', lat: -2.1894, lng: -79.8891, note: 'Guayas' },
  { name: 'Cuenca', lat: -2.9006, lng: -79.0045, note: 'Azuay' },
  { name: 'Loja', lat: -3.9931, lng: -79.2042, note: 'Loja' },
];
export const QUICK_CITIES = ['Machala', 'Pasaje', 'Huaquillas', 'Arenillas', 'El Guabo', 'Zaruma', 'Piñas', 'Portovelo'];
// Hasta dónde se puede elegir un destino tocando el mapa (la región de El Oro y alrededores)
export const TRAVEL_RADIUS_M = 260000;
// Los lugares (cementerio, terminal, colegio…) se buscan solo en Santa Rosa; las demás ciudades salen de la lista CITIES.
export const AREA_M = 9000;

// minúsculas y sin tildes, para que "pinas" encuentre "Piñas" y "huaquillar" se acerque a "Huaquillas"
export const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Escrituras comunes que la gente usa
const ALIAS = { huaquillar: 'huaquillas', huaquilla: 'huaquillas', wakillas: 'huaquillas', pasage: 'pasaje', guabo: 'el guabo', pinas: 'pinas', puertobolivar: 'puerto bolivar', gye: 'guayaquil' };

// ¿La consulta corresponde a este texto? Empieza igual, o alguna palabra empieza igual, o lo contiene (3+ letras)
function matches(q, text) {
  const t = norm(text); if (!q || !t) return 0;
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (t.split(' ').some(w => w.startsWith(q))) return 2;
  return q.length >= 3 && t.includes(q) ? 1 : 0;
}
const rank = (q, name) => { const a = ALIAS[q.replace(/ /g, '')] ? matches(norm(ALIAS[q.replace(/ /g, '')]), name) : 0; return Math.max(matches(q, name), a); };

export const fmtDist = m => (m < 950 ? `a ${Math.round(m / 50) * 50 || 50} m` : m < 10000 ? `a ${(m / 1000).toFixed(1).replace('.', ',')} km` : `a ${Math.round(m / 1000)} km`);

// Resultados al instante (sin red)
export function localSearch(raw, { center, saved = [], state } = {}) {
  const q = norm(raw); if (q.length < 2) return [];
  const out = [];
  for (const p of saved) { const s = rank(q, p.name); if (s) out.push({ ...p, kind: 'saved', score: s + 10, label: 'Lugar guardado' }); }
  for (const c of CITIES) { const s = rank(q, c.name); if (s) out.push({ ...c, kind: 'city', score: s + 6, label: c.note ? `Ciudad · ${c.note}` : 'Ciudad cercana' }); }
  // Lo que ya está dibujado en el mapa de EMOVTT (puntos críticos, calles inundadas, ríos, zonas de desborde)
  const feat = (list, label, pos) => { for (const x of list || []) { const s = rank(q, x.name); const p = pos(x); if (s && p) out.push({ name: x.name, lat: p.lat, lng: p.lng, kind: 'map', score: s + 2, label }); } };
  const midOf = c => (c?.length ? { lat: c[Math.floor(c.length / 2)][0], lng: c[Math.floor(c.length / 2)][1] } : null);
  feat(state?.points, 'Punto crítico', x => ({ lat: x.lat, lng: x.lng }));
  feat(state?.streets, 'Calle del mapa', x => midOf(x.coords));
  feat(state?.rivers, 'Río', x => midOf(x.coords));
  feat(state?.zones, 'Zona de desborde', x => midOf(x.coords));
  return dedupe(out.sort((a, b) => b.score - a.score), center).slice(0, 8);
}

function dedupe(list, center) {
  const out = [];
  for (const r of list) {
    if (out.some(o => norm(o.name) === norm(r.name) && haversine(o, r) < 3000)) continue;
    out.push({ ...r, dist: center ? haversine(center, r) : null });
  }
  return out;
}

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const uniq = a => [...new Set(a.filter(Boolean))];

async function getJson(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function photon(q, center, signal) {
  const dl = AREA_M / 111000, bbox = [center.lng - dl, center.lat - dl, center.lng + dl, center.lat + dl].join(',');
  const j = await getJson(`${PHOTON}?q=${encodeURIComponent(q)}&limit=10&lat=${center.lat}&lon=${center.lng}&bbox=${bbox}`, signal);
  return (j.features || []).filter(f => !f.properties?.countrycode || f.properties.countrycode === 'EC').map(f => {
    const p = f.properties || {}, [lng, lat] = f.geometry?.coordinates || [];
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const name = p.name || street || p.city || p.county;
    const where = uniq([p.name && street ? street : '', p.district || p.locality, p.city, p.county, p.state]).filter(x => x !== name).slice(0, 3);
    return { name, label: where.join(', '), lat, lng, kind: 'remote' };
  }).filter(x => x.name && Number.isFinite(x.lat));
}
async function nominatim(q, center, signal) {
  const d = AREA_M / 111000, vb = [center.lng - d, center.lat + d, center.lng + d, center.lat - d].join(',');
  const j = await getJson(`${NOMINATIM}?format=jsonv2&limit=8&countrycodes=ec&accept-language=es&bounded=1&viewbox=${vb}&q=${encodeURIComponent(q)}`, signal);
  return j.map(x => ({ name: x.name || x.display_name.split(',')[0], label: x.display_name.split(',').slice(1, 4).join(',').trim(), lat: +x.lat, lng: +x.lon, kind: 'remote' }));
}

// Cada consulta tiene su propio tiempo límite y se corta si el usuario sigue escribiendo
const limit = (master, ms) => { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); master.signal.addEventListener('abort', () => c.abort()); return { signal: c.signal, done: () => clearTimeout(t) }; };

// Búsqueda con red: se cancela sola si el usuario sigue escribiendo, y recuerda lo ya buscado
export function createRemoteSearch() {
  let master = null; const cache = new Map();
  return async function remote(raw, center) {
    const q = raw.trim(), key = norm(q);
    if (cache.has(key)) return cache.get(key);
    master?.abort(); const me = (master = new AbortController());
    let res = [];
    const l1 = limit(me, 3500);
    try { res = await photon(q, center, l1.signal); } catch (e) { if (me.signal.aborted) throw e; } finally { l1.done(); }
    if (!res.length) { const l2 = limit(me, 5000); try { res = await nominatim(q, center, l2.signal); } finally { l2.done(); } }
    // solo lugares de Santa Rosa (el servicio a veces devuelve de otras ciudades aunque se le pida el área)
    const out = dedupe(res.filter(r => haversine(center, r) <= AREA_M), center);
    cache.set(key, out); if (cache.size > 40) cache.delete(cache.keys().next().value);
    return out;
  };
}
