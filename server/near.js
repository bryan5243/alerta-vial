// Calles y sector cercanos a un punto (para los reportes ciudadanos). Lo consulta el servidor para que funcione
// aunque el teléfono tenga mala señal o bloqueos: Overpass (calles con nombre a < 250 m e intersección más cercana), Nominatim y Photon (calle y barrio).
const UA = 'SistemaAlertaVial/1.0 (EMOVTT Santa Rosa EP)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const rad = x => x * Math.PI / 180;
const meters = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
const cache = new Map();

// Calles con nombre cerca del punto y la intersección más cercana (nodo que comparten dos calles de distinto nombre).
// La distancia se mide a cada tramo de la calle, no solo a sus vértices: así gana la calle donde realmente está la persona.
export function nearAnalyze(elements, lat, lng) {
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
// Los servidores de Overpass se consultan a la vez y gana el primero que responde (antes uno tras otro: hasta 30 s).
function overpassOne(url, q, lat, lng) {
  return fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, signal: AbortSignal.timeout(5000) })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => nearAnalyze(j.elements, lat, lng));
}
async function overpass(lat, lng) {
  const q = `[out:json][timeout:5];way(around:250,${lat},${lng})[highway][name];out body geom;`;
  try { return await Promise.any(OVERPASS.map(u => overpassOne(u, q, lat, lng))); } catch { return { streets: [], inter: null }; }
}
async function nominatim(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1&accept-language=es`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const a = (await r.json()).address || {};
    return { street: a.road || a.pedestrian || a.footway || '', sector: a.neighbourhood || a.suburb || a.quarter || a.city_district || a.hamlet || '' };
  } catch { return {}; }
}
async function photon(lat, lng) {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const p = (await r.json()).features?.[0]?.properties || {};
    return { street: p.street || '', sector: p.district || p.locality || p.suburb || '' };
  } catch { return {}; }
}
export async function nearStreets(lat, lng) {
  const k = `${lat.toFixed(4)},${lng.toFixed(4)}`, hit = cache.get(k);
  if (hit && Date.now() - hit.t < 24 * 3600e3) return hit.v;
  const [op, nm, ph] = await Promise.all([overpass(lat, lng), nominatim(lat, lng), photon(lat, lng)]); // máx. ~5 s en total
  // La calle de Nominatim/Photon solo se agrega si Overpass no la tiene (Overpass mide la distancia real a cada calle)
  const streets = op.streets.slice();
  for (const s of [nm.street, ph.street]) if (s && !streets.some(x => x.name === s)) streets.push({ name: s, dist: null });
  const v = { streets: streets.slice(0, 6), inter: op.inter, sector: nm.sector || ph.sector || '' };
  if (v.streets.length || v.sector) { cache.set(k, { t: Date.now(), v }); if (cache.size > 500) cache.delete(cache.keys().next().value); }
  return v;
}
