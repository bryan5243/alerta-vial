// Carga automática de ríos, esteros y canales desde OpenStreetMap (API Overpass, sin cuenta ni key).
// En OSM los cauces se dibujan en el sentido del agua, así que la animación fluye en la dirección correcta.
import { haversine } from './gps.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const KIND = { river: 'Río', stream: 'Estero / quebrada', canal: 'Canal' };

export async function fetchWaterways({ lat, lng, km = 5, kinds = ['river', 'stream', 'canal'] }) {
  const dLat = km / 111, dLng = km / (111 * Math.cos(lat * Math.PI / 180));
  const bbox = [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map(v => v.toFixed(5)).join(',');
  const query = `[out:json][timeout:25];way["waterway"~"^(${kinds.join('|')})$"](${bbox});out tags geom;`;
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return group((await r.json()).elements || []);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`No se pudo conectar con OpenStreetMap (${lastErr?.message || 'sin respuesta'}). Revisa la conexión a internet.`);
}

// Une los tramos (ways) de un mismo cauce en líneas continuas.
function group(elements) {
  const byName = new Map();
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry?.length) continue;
    const name = el.tags?.name?.trim(); if (!name) continue; // los cauces sin nombre suelen ser zanjas: se omiten
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name, kind: el.tags.waterway, ways: [] });
    byName.get(key).ways.push(el.geometry.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]));
  }
  const out = [];
  for (const g of byName.values()) {
    const chains = chain(g.ways).map(c => simplify(c, 0.00003)).map(c => ({ coords: c, m: length(c) })).filter(c => c.m >= 150).sort((a, b) => b.m - a.m);
    chains.forEach((c, i) => out.push({ name: chains.length > 1 ? `${g.name} (tramo ${i + 1})` : g.name, baseName: g.name, kind: g.kind, coords: c.coords, km: +(c.m / 1000).toFixed(2) }));
  }
  const order = { river: 0, canal: 1, stream: 2 };
  return out.sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || b.km - a.km);
}

const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
function chain(ways) {
  const rest = ways.map(w => [...w]); const chains = [];
  while (rest.length) {
    let c = rest.shift(), grown = true;
    while (grown) {
      grown = false;
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i];
        if (same(c.at(-1), w[0])) c = [...c, ...w.slice(1)];
        else if (same(w.at(-1), c[0])) c = [...w, ...c.slice(1)];
        else if (same(c.at(-1), w.at(-1))) c = [...c, ...w.slice(0, -1).reverse()];
        else if (same(c[0], w[0])) c = [...w.slice(1).reverse(), ...c];
        else continue;
        rest.splice(i, 1); grown = true; break;
      }
    }
    chains.push(c);
  }
  return chains;
}
function length(c) { let m = 0; for (let i = 1; i < c.length; i++) m += haversine({ lat: c[i - 1][0], lng: c[i - 1][1] }, { lat: c[i][0], lng: c[i][1] }); return m; }
// Douglas-Peucker: menos puntos, misma forma (tolerancia en grados, ~3 m)
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)]; let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], a, b); if (d > max) { max = d; idx = i; } }
  if (max <= tol) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
