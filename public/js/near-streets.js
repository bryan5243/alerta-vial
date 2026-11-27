// Calles y sector cercanos a un punto (para ayudar a quien reporta y no sabe el nombre de la calle).
// Calles: OpenStreetMap vía Overpass (vías con nombre a menos de 250 m e intersección más cercana). Sector/barrio: Photon (reverse).
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const rad = x => x * Math.PI / 180;
const meters = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
const cache = new Map();

// Calles con nombre cerca del punto y la intersección más cercana (nodo que comparten dos calles de distinto nombre).
// La distancia se mide a cada tramo de la calle, no solo a sus vértices: así gana la calle donde realmente está la persona.
function nearAnalyze(elements, lat, lng) {
  const k = Math.cos(rad(lat)), P = g => [(g.lon - lng) * 111320 * k, (g.lat - lat) * 111320];
  const seg = ([ax, ay], [bx, by]) => { const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0; return Math.hypot(ax + t * dx, ay + t * dy); };
  const best = new Map(), names = new Map(), pos = new Map();
  for (const w of elements || []) {
    const name = w.tags?.name, g = w.geometry; if (!name || !g?.length) continue;
    const pts = g.map(x => x ? P(x) : null), ok = pts.filter(Boolean); if (!ok.length) continue;
    let d = Math.hypot(...ok[0]); for (let i = 1; i < pts.length; i++) if (pts[i - 1] && pts[i]) d = Math.min(d, seg(pts[i - 1], pts[i]));
    if (!best.has(name) || best.get(name) > d) best.set(name, d);
    (w.nodes || []).forEach((id, i) => { if (!pts[i]) return; if (!names.has(id)) names.set(id, new Set()); names.get(id).add(name); pos.set(id, pts[i]); });
  }
  let inter = null;
  for (const [id, set] of names) if (set.size >= 2) {
    const d = Math.hypot(...pos.get(id));
    if (!inter || d < inter.dist) inter = { streets: [...set].sort((a, b) => best.get(a) - best.get(b)).slice(0, 2), dist: Math.round(d) };
  }
  const streets = [...best].map(([name, dist]) => ({ name, dist: Math.round(dist) })).sort((a, b) => a.dist - b.dist).slice(0, 6);
  return { streets, inter };
}
async function overpassStreets(lat, lng) {
  const q = `[out:json][timeout:5];way(around:250,${lat},${lng})[highway][name];out body geom;`;
  const one = url => fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(6000) })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => nearAnalyze(j.elements, lat, lng));
  try { return await Promise.any(OVERPASS.map(one)); } catch { return { streets: [], inter: null }; }
}
async function photonSector(lat, lng) {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { sector: '', street: '' };
    const p = (await r.json()).features?.[0]?.properties || {};
    return { sector: p.district || p.locality || p.suburb || '', street: p.street || '' };
  } catch { return { sector: '', street: '' }; }
}
async function nominatim(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1&accept-language=es`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const a = (await r.json()).address || {};
    return { street: a.road || a.pedestrian || '', sector: a.neighbourhood || a.suburb || a.quarter || a.city_district || '' };
  } catch { return {}; }
}
// Todo a la vez: servidor del sistema + consulta rápida directa (Photon/Nominatim). `onQuick` pinta la primera calle
// en cuanto llega (1–2 s) y luego se completa con la lista del servidor. Tope: ~7 s.
async function fromServer(lat, lng) {
  try {
    const r = await fetch(`/api/public/near?lat=${lat}&lng=${lng}`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null; const j = await r.json();
    return j && (j.streets?.length || j.sector) ? j : null;
  } catch { return null; }
}
export async function nearStreets(lat, lng, onQuick) {
  const k = `${lat.toFixed(4)},${lng.toFixed(4)}`; if (cache.has(k)) return cache.get(k);
  const quick = Promise.all([photonSector(lat, lng), nominatim(lat, lng)]).then(([ph, nm]) => {
    const q = { streets: [...new Set([ph.street, nm.street].filter(Boolean))].map(name => ({ name, dist: 0 })), sector: nm.sector || ph.sector || '' };
    if (q.streets.length || q.sector) onQuick?.(q); return q;
  });
  const srv = await fromServer(lat, lng);
  if (srv) { cache.set(k, srv); return srv; }
  const [op, q] = await Promise.all([overpassStreets(lat, lng), quick]);
  const streets = op.streets.slice();
  for (const s of q.streets) if (!streets.some(x => x.name === s.name)) streets.push(s);
  const out = { streets, inter: op.inter, sector: q.sector };
  if (streets.length || out.sector) cache.set(k, out);
  return out;
}
