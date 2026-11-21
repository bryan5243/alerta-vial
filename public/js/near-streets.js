// Calles y sector cercanos a un punto (para ayudar a quien reporta y no sabe el nombre de la calle).
// Calles: OpenStreetMap vía Overpass (vías con nombre a menos de 150 m). Sector/barrio: Photon (reverse).
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const rad = x => x * Math.PI / 180;
const meters = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
const cache = new Map();

async function overpassStreets(lat, lng) {
  const q = `[out:json][timeout:8];way(around:150,${lat},${lng})[highway][name];out tags geom;`;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const j = await r.json(), best = new Map();
      for (const w of j.elements || []) {
        const name = w.tags?.name; if (!name || !w.geometry?.length) continue;
        const d = Math.min(...w.geometry.map(g => meters({ lat, lng }, { lat: g.lat, lng: g.lon })));
        if (!best.has(name) || best.get(name) > d) best.set(name, d);
      }
      return [...best].map(([name, dist]) => ({ name, dist: Math.round(dist) })).sort((a, b) => a.dist - b.dist).slice(0, 5);
    } catch {}
  }
  return [];
}
async function photonSector(lat, lng) {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return { sector: '', street: '' };
    const p = (await r.json()).features?.[0]?.properties || {};
    return { sector: p.district || p.locality || p.suburb || '', street: p.street || '' };
  } catch { return { sector: '', street: '' }; }
}
export async function nearStreets(lat, lng) {
  const k = `${lat.toFixed(4)},${lng.toFixed(4)}`; if (cache.has(k)) return cache.get(k);
  const [streets, ph] = await Promise.all([overpassStreets(lat, lng), photonSector(lat, lng)]);
  if (ph.street && !streets.some(s => s.name === ph.street)) streets.unshift({ name: ph.street, dist: 0 });
  const out = { streets, sector: ph.sector };
  if (streets.length || ph.sector) cache.set(k, out);
  return out;
}
