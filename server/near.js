// Calles y sector cercanos a un punto (para los reportes ciudadanos). Lo consulta el servidor para que funcione
// aunque el teléfono tenga mala señal o bloqueos: Overpass (calles con nombre a < 180 m), Nominatim y Photon (calle y barrio).
const UA = 'SistemaAlertaVial/1.0 (EMOVTT Santa Rosa EP)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const rad = x => x * Math.PI / 180;
const meters = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
const cache = new Map();

// Los servidores de Overpass se consultan a la vez y gana el primero que responde (antes uno tras otro: hasta 30 s).
function overpassOne(url, q, lat, lng) {
  return fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, signal: AbortSignal.timeout(5000) })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => {
      const best = new Map();
      for (const w of j.elements || []) {
        const name = w.tags?.name; if (!name || !w.geometry?.length) continue;
        const d = Math.min(...w.geometry.map(g => meters({ lat, lng }, { lat: g.lat, lng: g.lon })));
        if (!best.has(name) || best.get(name) > d) best.set(name, d);
      }
      return [...best].map(([name, dist]) => ({ name, dist: Math.round(dist) })).sort((a, b) => a.dist - b.dist).slice(0, 6);
    });
}
async function overpass(lat, lng) {
  const q = `[out:json][timeout:5];way(around:180,${lat},${lng})[highway][name];out tags geom;`;
  try { return await Promise.any(OVERPASS.map(u => overpassOne(u, q, lat, lng))); } catch { return []; }
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
  const [streets, nm, ph] = await Promise.all([overpass(lat, lng), nominatim(lat, lng), photon(lat, lng)]); // máx. ~5 s en total
  for (const s of [ph.street, nm.street]) if (s && !streets.some(x => x.name === s)) streets.unshift({ name: s, dist: 0 });
  const v = { streets: streets.slice(0, 6), sector: nm.sector || ph.sector || '' };
  if (v.streets.length || v.sector) { cache.set(k, { t: Date.now(), v }); if (cache.size > 500) cache.delete(cache.keys().next().value); }
  return v;
}
