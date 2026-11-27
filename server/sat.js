// Satélite GOES-19 (NOAA): altura de la cima de las nubes cada 10 minutos, también de noche (ABI-L2-ACHAF, ~10 km por píxel).
// Reemplaza al radar en Ecuador (RainViewer no tiene radares aquí). Un satélite no mide la lluvia: ve las nubes desde arriba.
//  · cielo sin nubes (o solo nubes muy bajas) sobre la ciudad → no puede estar lloviendo de forma medible
//  · nubes de 12 km o más cubriendo la ciudad → nubes de tormenta (cumulonimbos): respalda a los pronósticos que ven lluvia
//  · nubes de 7–11 km pueden ser solo cirros (nubes altas y finas que no llueven): no cuentan para nada
// Datos públicos y gratuitos en AWS (NOAA Open Data Dissemination), sin clave. El archivo de todo el disco pesa ~1,6 MB.
import h5wasm from 'h5wasm/node';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const BUCKETS = ['noaa-goes19', 'noaa-goes16'];
export const SAT = { cityKm: 12, nearKm: 40, stormKm: 12, clearKm: 2.5, maxAgeMin: 40, box: 1.0, png: 28 };
const rad = x => x * Math.PI / 180, pad = (n, l = 2) => String(n).padStart(l, '0');
const kmBetween = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
function hourPrefix(t) {
  const d = new Date(t), doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  return `ABI-L2-ACHAF/${d.getUTCFullYear()}/${pad(doy, 3)}/${pad(d.getUTCHours())}/`;
}
export function scanTime(key) {
  const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/.exec(key); if (!m) return 0;
  return Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 864e5 + (+m[3]) * 3600e3 + (+m[4]) * 60e3 + (+m[5]) * 1e3;
}
async function listKeys(bucket, prefix) {
  const r = await fetch(`https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`lista ${r.status}`);
  return [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
}

// Proyección fija de GOES-R (guía del usuario de productos, PUG vol. 4): latitud/longitud → ángulos de barrido x, y (radianes)
export function scanAngles(lat, lng, p) {
  const { a, b, H, lon0 } = p, e2 = 1 - (b * b) / (a * a);
  const pc = Math.atan((b * b) / (a * a) * Math.tan(rad(lat))), rc = b / Math.sqrt(1 - e2 * Math.cos(pc) ** 2), dl = rad(lng) - lon0;
  const sx = H - rc * Math.cos(pc) * Math.cos(dl), sy = -rc * Math.cos(pc) * Math.sin(dl), sz = rc * Math.sin(pc);
  return { x: Math.asin(-sy / Math.hypot(sx, sy, sz)), y: Math.atan(sz / sx) };
}

let ready = null;
// Lee la altura de nubes de un recuadro de ±box grados alrededor del punto: devuelve una función (lat, lng) → km (null = sin nube)
export async function readHeights(buf, lat, lng, box = SAT.box) {
  ready ||= h5wasm.ready;
  const { FS } = await ready;
  const tmp = path.join(os.tmpdir(), `acha_${Date.now()}_${Math.random().toString(36).slice(2)}.nc`);
  FS.writeFile(tmp, new Uint8Array(buf));
  const f = new h5wasm.File(tmp, 'r');
  try {
    const at = (ds, k) => { const v = ds?.attrs?.[k]?.value; return Array.isArray(v) || ArrayBuffer.isView(v) ? Number(v[0]) : Number(v); };
    const pj = f.get('goes_imager_projection'), X = f.get('x'), Y = f.get('y'), HT = f.get('HT');
    if (!pj || !X || !Y || !HT) throw new Error('archivo del satélite sin altura de nubes');
    const p = { a: at(pj, 'semi_major_axis'), b: at(pj, 'semi_minor_axis'), H: at(pj, 'perspective_point_height') + at(pj, 'semi_major_axis'), lon0: rad(at(pj, 'longitude_of_projection_origin')) };
    const xs = at(X, 'scale_factor'), xo = at(X, 'add_offset'), ys = at(Y, 'scale_factor'), yo = at(Y, 'add_offset');
    const [rows, cols] = HT.shape, sc = at(HT, 'scale_factor') || 1, fill = at(HT, '_FillValue');
    const rc = (la, lo) => { const s = scanAngles(la, lo, p); return [Math.round((s.y - yo) / ys), Math.round((s.x - xo) / xs)]; };
    const corners = [[lat - box, lng - box], [lat - box, lng + box], [lat + box, lng - box], [lat + box, lng + box]].map(([a, b]) => rc(a, b));
    const r0 = Math.max(0, Math.min(...corners.map(c => c[0])) - 1), r1 = Math.min(rows - 1, Math.max(...corners.map(c => c[0])) + 1);
    const c0 = Math.max(0, Math.min(...corners.map(c => c[1])) - 1), c1 = Math.min(cols - 1, Math.max(...corners.map(c => c[1])) + 1);
    if (r1 <= r0 || c1 <= c0) throw new Error('la ciudad queda fuera de la vista del satélite');
    const w = c1 - c0 + 1, blk = HT.slice([[r0, r1 + 1], [c0, c1 + 1]]);
    return (la, lo) => {
      const [r, c] = rc(la, lo); if (r < r0 || r > r1 || c < c0 || c > c1) return null;
      const v = Number(blk[(r - r0) * w + (c - c0)]);
      return v === fill || !Number.isFinite(v) ? null : Math.round(v * sc / 100) / 10; // m → km con un decimal
    };
  } finally { f.close(); try { FS.unlink(tmp); } catch {} }
}

// Resumen sobre la ciudad y alrededores (muestreo cada ~3 km, así cada píxel de 10 km se mira varias veces)
export function summarize(hAt, lat, lng) {
  const kmLng = 111 * Math.cos(rad(lat));
  const city = { n: 0, cloud: 0, deep: 0, max: 0 }; let nearStorm = null, nearMax = 0;
  for (let dy = -SAT.nearKm; dy <= SAT.nearKm; dy += 3) for (let dx = -SAT.nearKm; dx <= SAT.nearKm; dx += 3) {
    const d = Math.hypot(dx, dy); if (d > SAT.nearKm) continue;
    const h = hAt(lat + dy / 111, lng + dx / kmLng) ?? 0;
    if (d <= SAT.cityKm) { city.n++; if (h >= SAT.clearKm) city.cloud++; if (h >= SAT.stormKm) city.deep++; city.max = Math.max(city.max, h); }
    else nearMax = Math.max(nearMax, h);
    if (h >= SAT.stormKm && (nearStorm == null || d < nearStorm)) nearStorm = Math.round(d);
  }
  return {
    topKm: city.max, nearTopKm: Math.max(nearMax, city.max),
    clear: city.n > 0 && city.cloud === 0,
    // Tormenta sobre la ciudad: cimas de 12 km o más en al menos la mitad de la zona (no basta un borde de yunque)
    storm: city.n > 0 && city.deep * 2 >= city.n,
    stormKm: nearStorm, cloudShare: city.n ? Math.round(city.cloud / city.n * 100) : 0,
  };
}

// Imagen para el mapa: recuadro de ±box grados, colores por altura de la cima (transparente = despejado o nubes bajas)
const COLORS = [[14, [224, 24, 45, 210]], [12, [255, 138, 0, 190]], [9, [255, 213, 74, 150]], [6, [127, 179, 255, 115]], [3, [255, 255, 255, 70]]];
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function renderPng(hAt, lat, lng, box = SAT.box, size = SAT.png) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  // Mercator entre los bordes (así coincide con el mapa aunque el recuadro sea grande)
  const my = la => Math.log(Math.tan(Math.PI / 4 + rad(la) / 2)), top = my(lat + box), bot = my(lat - box);
  for (let y = 0; y < size; y++) {
    const la = (2 * Math.atan(Math.exp(top - (y + 0.5) / size * (top - bot))) - Math.PI / 2) * 180 / Math.PI;
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const lo = lng - box + (x + 0.5) / size * 2 * box, h = hAt(la, lo) ?? 0, c = COLORS.find(([min]) => h >= min)?.[1];
      if (c) raw.set(c, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function satDetail(s, ageMin) {
  const txt = s.clear ? 'Sin nubes de lluvia sobre la ciudad (despejado o solo nubes bajas)'
    : s.storm ? `Nubes de tormenta sobre la ciudad (cima a ~${s.topKm} km)`
    : `Nubes sobre la ciudad con cima a ~${s.topKm} km${s.topKm >= 7 ? ' (nubes altas: pueden ser solo cirros, que no llueven)' : ''}`;
  const near = !s.storm && s.stormKm != null ? ` · nubes de tormenta a ~${s.stormKm} km` : '';
  return `${txt}${near} · el satélite ve las nubes desde arriba, no mide la lluvia · imagen de hace ${ageMin} min`;
}

// Último archivo, con caché: el satélite publica cada 10 min y se revisa como mucho cada 4 min
let st = { checked: 0, key: '', at: 0, lat: null, lng: null, sum: null, png: null, error: '', bucket: 0, busy: null };
async function refresh(lat, lng) {
  const now = Date.now(), bucket = BUCKETS[st.bucket % BUCKETS.length];
  const keys = (await Promise.all([hourPrefix(now - 3600e3), hourPrefix(now)].map(p => listKeys(bucket, p).catch(() => [])))).flat().sort();
  const key = keys.at(-1);
  if (!key || now - scanTime(key) > 60 * 60e3) { st.bucket++; throw new Error(`el satélite ${bucket} no publica datos recientes`); }
  if (key === st.key && st.lat === lat && st.lng === lng) return;
  const r = await fetch(`https://${bucket}.s3.amazonaws.com/${key}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`descarga ${r.status}`);
  const hAt = await readHeights(Buffer.from(await r.arrayBuffer()), lat, lng);
  st = { ...st, key, at: scanTime(key), lat, lng, sum: summarize(hAt, lat, lng), png: renderPng(hAt, lat, lng), error: '' };
}
export async function satState(lat, lng) {
  lat = Math.round(lat * 100) / 100; lng = Math.round(lng * 100) / 100;
  const moved = st.lat !== lat || st.lng !== lng;
  if (moved || Date.now() - st.checked > 4 * 60e3) {
    st.busy ||= refresh(lat, lng).catch(e => { st.error = e.message || 'sin conexión con el satélite'; }).finally(() => { st.checked = Date.now(); st.busy = null; });
    if (moved || !st.sum) await st.busy;
  }
  return st;
}
export async function satSource(lat, lng) {
  const base = { id: 'satelite', kind: 'observación', name: 'Satélite GOES-19 (nubes de tormenta)', intensity: 0, rainNow: 0 };
  try {
    const s = await satState(lat, lng);
    if (!s.sum) return { ...base, ok: false, error: s.error || 'sin datos del satélite' };
    const ageMin = Math.round((Date.now() - s.at) / 60e3);
    if (ageMin > SAT.maxAgeMin) return { ...base, ok: false, at: new Date(s.at).toISOString(), error: `la última imagen del satélite es de hace ${ageMin} min` };
    return { ...base, ok: true, at: new Date(s.at).toISOString(), ...s.sum, detail: satDetail(s.sum, ageMin) };
  } catch (e) { return { ...base, ok: false, error: e.message }; }
}
export const satBounds = (lat, lng, box = SAT.box) => [[lat - box, lng - box], [lat + box, lng + box]];
