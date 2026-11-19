// Detector de rayos en tiempo real: red Blitzortung (antenas de aficionados, sin clave).
// Solo se guardan los rayos cercanos a la ciudad (60 km, últimos 30 min) y solo se muestran datos derivados
// ("N rayos a X km"), nunca la lista cruda. Uso no comercial. Se desactiva con config.lightningEnabled = false.
const HOSTS = ['ws1', 'ws5', 'ws6', 'ws7'].map(h => `wss://${h}.blitzortung.org:3000/`);
const KEEP_MS = 30 * 60 * 1000, RADIUS_KM = 60;
const st = { ws: null, open: false, since: 0, lastMsg: 0, total: 0, strikes: [], center: null, host: 0, retry: 0, timer: null, error: '' };
const rad = x => x * Math.PI / 180;
export const kmBetween = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
export function addStrike(s, now = Date.now()) {
  st.lastMsg = now; st.total++;
  if (!st.center || typeof s?.lat !== 'number' || typeof s?.lon !== 'number') return;
  const km = kmBetween(st.center, { lat: s.lat, lng: s.lon });
  if (km > RADIUS_KM) return;
  st.strikes.push({ t: now, km });
  const cut = now - KEEP_MS; while (st.strikes.length && st.strikes[0].t < cut) st.strikes.shift();
}
function connect() {
  if (!st.center || typeof WebSocket === 'undefined') return;
  clearTimeout(st.timer);
  const url = HOSTS[st.host % HOSTS.length];
  let ws; try { ws = new WebSocket(url); } catch (e) { st.error = e.message; return schedule(); }
  st.ws = ws;
  ws.onopen = () => { st.open = true; st.since = Date.now(); st.retry = 0; st.error = ''; try { ws.send(JSON.stringify({ time: 0 })); } catch {} };
  ws.onmessage = ev => { try { addStrike(JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())); } catch {} };
  ws.onerror = () => { st.error = 'sin conexión con la red de rayos'; };
  ws.onclose = () => { st.open = false; st.ws = null; st.host++; schedule(); };
}
function schedule() { clearTimeout(st.timer); st.retry++; st.timer = setTimeout(connect, Math.min(60000, 2000 * 2 ** Math.min(st.retry, 5))); st.timer.unref?.(); }
export function startLightning(center) {
  if (st.center || !center) return;
  st.center = { lat: +center.lat, lng: +center.lng }; connect();
}
// Resumen para el clima: rayos recientes cerca de la ciudad
export function lightningSnapshot(now = Date.now()) {
  const base = { id: 'rayos', kind: 'observación', name: 'Detector de rayos (Blitzortung)', intensity: 0, rainNow: 0 };
  if (!st.center) return null;
  if (!st.open) return { ...base, ok: false, error: st.error || 'conectando con la red de rayos…' };
  const within = (km, ms) => st.strikes.filter(s => s.km <= km && now - s.t <= ms);
  const n15 = within(15, 15 * 60e3), n10 = within(15, 10 * 60e3).length, n30 = within(30, 30 * 60e3).length, n60 = within(60, 30 * 60e3).length;
  const nearest = st.strikes.length ? Math.min(...st.strikes.filter(s => now - s.t <= 30 * 60e3).map(s => s.km), Infinity) : Infinity;
  return { ...base, ok: true, at: new Date(st.lastMsg || now).toISOString(), strikes15: n15.length, strikes10: n10, strikes30: n30, strikes60: n60, nearestKm: Number.isFinite(nearest) ? Math.round(nearest) : null,
    detail: n60 ? `${n60} rayo${n60 > 1 ? 's' : ''} en los últimos 30 min a menos de 60 km${Number.isFinite(nearest) ? ` · el más cercano a ${Math.round(nearest)} km` : ''}` : 'Sin rayos detectados en 60 km (últimos 30 min)' };
}
