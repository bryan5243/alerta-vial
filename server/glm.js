// Rayos desde el satélite GOES-East (NOAA): el instrumento GLM ve los rayos de toda América, incluido Ecuador.
// Datos públicos y gratuitos en AWS (programa NOAA Open Data Dissemination), sin clave. Cada 20 s sale un archivo
// NetCDF con los "flashes" (rayos) detectados; se leen solo los de los últimos minutos y solo se guardan los cercanos.
import h5wasm from 'h5wasm/node';
const rad = x => x * Math.PI / 180;
const kmBetween = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };

const BUCKETS = ['noaa-goes19', 'noaa-goes16']; // GOES-19 es el GOES-East operativo; GOES-16 queda de respaldo
const RADIUS_KM = 60, KEEP_MS = 30 * 60e3, POLL_MS = 2 * 60e3, LOOKBACK_MS = 6 * 60e3;
const st = { center: null, strikes: [], seen: new Set(), lastFile: 0, lastOk: 0, error: '', bucket: 0, timer: null, busy: false, files: 0 };

const pad = (n, l = 2) => String(n).padStart(l, '0');
function hourPrefix(t) {
  const d = new Date(t), start = Date.UTC(d.getUTCFullYear(), 0, 1), doy = Math.floor((t - start) / 864e5) + 1;
  return `GLM-L2-LCFA/${d.getUTCFullYear()}/${pad(doy, 3)}/${pad(d.getUTCHours())}/`;
}
// s2026328133400 + décima → fecha
export function fileTime(key) {
  const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)/.exec(key); if (!m) return 0;
  return Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 864e5 + (+m[3]) * 3600e3 + (+m[4]) * 60e3 + (+m[5]) * 1e3 + (+m[6]) * 100;
}
async function listKeys(bucket, prefix) {
  const r = await fetch(`https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`lista ${r.status}`);
  return [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
}
let ready = null;
// Lee flash_lat/flash_lon (aplica scale_factor/add_offset si vienen empaquetados)
export async function readFlashes(buf) {
  ready ||= h5wasm.ready;
  const { FS } = await ready;
  const tmp = `/glm_${Date.now()}_${Math.random().toString(36).slice(2)}.nc`;
  FS.writeFile(tmp, new Uint8Array(buf));
  const f = new h5wasm.File(tmp, 'r');
  try {
    const col = name => {
      const ds = f.get(name); if (!ds) return [];
      const a = ds.attrs || {}, at = k => { const v = a[k]?.value; return Array.isArray(v) || ArrayBuffer.isView(v) ? v[0] : v; };
      const sc = at('scale_factor') ?? 1, off = at('add_offset') ?? 0, uns = String(at('_Unsigned') ?? '') === 'true', fill = at('_FillValue');
      return Array.from(ds.value || [], v => { let x = Number(v); if (fill != null && x === Number(fill)) return NaN; if (uns && x < 0) x += 65536; return x * sc + off; });
    };
    const lat = col('flash_lat'), lon = col('flash_lon');
    return lat.map((y, i) => ({ lat: y, lon: lon[i] })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } finally { f.close(); try { FS.unlink(tmp); } catch {} }
}
async function poll() {
  if (st.busy || !st.center) return; st.busy = true;
  try {
    const now = Date.now(), bucket = BUCKETS[st.bucket % BUCKETS.length];
    const prefixes = [...new Set([hourPrefix(now - LOOKBACK_MS), hourPrefix(now)])];
    const all = (await Promise.all(prefixes.map(p => listKeys(bucket, p).catch(e => { if (p === hourPrefix(now)) throw e; return []; })))).flat();
    const keys = all.filter(k => fileTime(k) >= now - LOOKBACK_MS && !st.seen.has(k)).sort();
    const newest = Math.max(0, ...all.map(fileTime));
    if (!newest || now - newest > 20 * 60e3) { st.bucket++; throw new Error(`el satélite ${bucket} no publica datos recientes; se prueba el otro`); }
    for (const k of keys) {
      const r = await fetch(`https://${bucket}.s3.amazonaws.com/${k}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const t = fileTime(k);
      for (const p of await readFlashes(await r.arrayBuffer())) {
        const km = kmBetween(st.center, { lat: p.lat, lng: p.lon });
        if (km <= RADIUS_KM) st.strikes.push({ t, km });
      }
      st.seen.add(k); st.files++; st.lastFile = Math.max(st.lastFile, t);
    }
    if (st.seen.size > 400) st.seen = new Set([...st.seen].slice(-200));
    const cut = Date.now() - KEEP_MS; st.strikes = st.strikes.filter(s => s.t >= cut);
    st.lastOk = Date.now(); st.error = '';
  } catch (e) { st.error = e.message || 'sin conexión con el satélite'; }
  finally { st.busy = false; }
}
export function startGlm(center) {
  if (st.center || !center) return;
  st.center = { lat: +center.lat, lng: +center.lng };
  poll(); st.timer = setInterval(poll, POLL_MS); st.timer.unref?.();
}
// Estado para el detector de rayos: ok si leyó datos del satélite en los últimos 10 min
export function glmState(now = Date.now()) {
  if (!st.center) return null;
  const ok = st.lastOk && now - st.lastOk < 10 * 60e3 && st.lastFile && now - st.lastFile < 15 * 60e3;
  return { ok: !!ok, strikes: st.strikes.filter(s => now - s.t <= KEEP_MS), delayMin: st.lastFile ? Math.round((now - st.lastFile) / 60e3) : null, error: st.error || (st.lastOk ? '' : 'conectando con el satélite…') };
}
