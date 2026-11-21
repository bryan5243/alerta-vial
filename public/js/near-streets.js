// Calles y sector cercanos a un punto (para ayudar a quien reporta y no sabe el nombre de la calle).
// Calles: OpenStreetMap vía Overpass (vías con nombre a menos de 150 m). Sector/barrio: Photon (reverse).
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const rad = x => x * Math.PI / 180;
const meters = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
const cache = new Map();

async function overpassStreets(lat, lng) {
  const q = `[out:json][timeout:5];way(around:150,${lat},${lng})[highway][name];out tags geom;`;
  const one = url => fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(6000) })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => {
      const best = new Map();
      for (const w of j.elements || []) {
        const name = w.tags?.name; if (!name || !w.geometry?.length) continue;
        const d = Math.min(...w.geometry.map(g => meters({ lat, lng }, { lat: g.lat, lng: g.lon })));
        if (!best.has(name) || best.get(name) > d) best.set(name, d);
      }
      return [...best].map(([name, dist]) => ({ name, dist: Math.round(dist) })).sort((a, b) => a.dist - b.dist).slice(0, 5);
    });
  try { return await Promise.any(OVERPASS.map(one)); } catch { return []; }
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
  const [streets, q] = await Promise.all([overpassStreets(lat, lng), quick]);
  for (const s of q.streets) if (!streets.some(x => x.name === s.name)) streets.unshift(s);
  const out = { streets, sector: q.sector };
  if (streets.length || out.sector) cache.set(k, out);
  return out;
}
