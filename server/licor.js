// Estación meteorológica HOBO RX2100 (Onset/LI-COR) de Santa Rosa: pluviómetro real, publicado en un tablero público de
// LI-COR Cloud. Se lee la lluvia por hora con la misma consulta que hace ese tablero (como mucho cada 5 min).
// La estación está en la parte alta (~450 m, según su presión), no en el centro: su lluvia respalda a los pronósticos
// y avisa de lo que va a bajar por los ríos, pero no enciende "lloviendo en la ciudad" por sí sola. Igual que php/api/lib/licor.php.
export const LICOR = { metric: 'com.onset.sensordata.rain_si', base: 'https://www.licor.cloud', ttl: 300000, wetMm: 0.5, freshMin: 90 };
// Estaciones (tablero público + canal de lluvia). "note" se agrega al detalle.
export const LICOR_STATIONS = [
  { key: 'licor1', name: 'Estación El Guayabo (LI-COR) · pluviómetro', dashboard: '5e1f6cd5-0815-49b9-9d1a-a8777d544579', rain: 'f869d179-1360-4b20-9eeb-e302646514e4', note: 'estación de El Guayabo', zone: 'baja' },
  { key: 'licor2', name: 'Estación Ducupalta (LI-COR) · pluviómetro', dashboard: 'ac7e885a-8b1d-4add-b38b-917a7973446a', rain: '326ce07c-c41d-45a9-ba50-0329483ace24', note: 'estación de Ducupalta: avisa de la lluvia en los alrededores, no decide por la ciudad', zone: 'alta' },
];
const UA = 'Mozilla/5.0 (compatible; AlertaVial/1.0)';
const r1 = x => Math.round(x * 10) / 10;
const headers = (cookie, dash) => ({ accept: 'application/json, text/plain, */*', origin: LICOR.base, referer: `${LICOR.base}/dashboards/public/${dash}/true`, 'user-agent': UA, ...(cookie ? { cookie } : {}) });
const query = (st, now, cookie) => fetch(`${LICOR.base}/api/v2/timeseriesdata`, { method: 'POST', signal: AbortSignal.timeout(12000), headers: { ...headers(cookie, st.dashboard), 'content-type': 'application/json' },
  body: JSON.stringify({ channels: [{ channelUUID: st.rain, channelType: 'dataChannel', metricName: LICOR.metric, limit: 500, aggregationFunction: 'avg', aggregationInterval: { value: 1, unit: 'seconds' } }],
    time: { absolute: { from: now - 26 * 3600000, to: now } }, dashboardUUID: st.dashboard }) });
export function licorSummary(pts, now) {
  pts = pts.slice().sort((a, b) => a[0] - b[0]);
  const d = pts.slice(1).map((p, i) => p[0] - pts[i][0]).sort((a, b) => a - b);
  const step = d.length ? Math.max(300000, Math.min(86400000, d[Math.floor(d.length / 2)])) : 3600000; // 5 min, 1 h o 1 día
  const sum = h => r1(pts.reduce((s, [t, v]) => s + (t + step > now - h * 3600000 ? Math.max(0, v) : 0), 0));
  const [lt, lv] = pts.at(-1), end = lt + step, age = Math.max(0, Math.round((now - end) / 60000));
  const s = { lastMm: r1(Math.max(0, lv)), lastFrom: lt, lastTo: end, stepMin: Math.round(step / 60000), ageMin: age, rain15m: r1(pts.reduce((a, [t, v]) => a + (t >= end - 900000 ? Math.max(0, v) : 0), 0)), rain30m: sum(0.5), rain1h: sum(1), rain3h: sum(3), rain6h: sum(6), rain12h: sum(12), rain24h: sum(24) };
  return { ...s, wet: licorWet(s) };
}
// "Llueve en la estación": con lecturas cada 5 min, ≥ 0,4 mm en la última media hora (≈ 0,8 mm/h) y el dato de hace ≤ 20 min;
// si publica por hora, ≥ 0,5 mm en su última hora y el dato de hace ≤ 90 min; un canal diario no dice si llueve ahora
// "Seco en la estación": dato reciente y nada (o casi nada) en la última media hora / última hora
// Lo que cuenta es el momento: las lecturas de los últimos 15 min (antes: la última hora, y seguía "lloviendo" cuando ya había parado)
export const licorDry = s => s.stepMin < 60 ? s.ageMin <= 30 && (s.rain15m ?? 0) < 0.2 : s.stepMin <= 60 && s.ageMin <= LICOR.freshMin && s.lastMm < 0.2;
export const licorWet = s => s.stepMin < 60 ? s.ageMin <= 20 && (s.rain15m ?? 0) >= 0.2 : s.stepMin <= 60 && s.ageMin <= LICOR.freshMin && s.lastMm >= LICOR.wetMm;
const hm = ms => new Date(ms - 5 * 3600000).toISOString().slice(11, 16);
export function licorDetail(s, note = '') {
  if (s.stepMin > 60) return `Lluvia del día: ${s.lastMm} mm (el canal publica un total diario, no sirve para saber si llueve ahora)${note ? ` · ${note}` : ''}`;
  const h1 = s.stepMin < 60 ? s.rain1h : s.lastMm;
  const now = s.stepMin < 60 ? ((s.rain15m ?? 0) > 0 ? `Ahora: ${s.rain15m} mm en los últimos 15 min (≈${r1(s.rain15m * 4)} mm/h) · ` : 'Ahora: sin lluvia en los últimos 15 min · ') : '';
  const last = now + (h1 > 0 ? `${h1} mm en la última hora` : 'sin lluvia en la última hora');
  return `${last} · últimas 3 h: ${s.rain3h} mm · 24 h: ${s.rain24h} mm · lectura de las ${hm(s.lastTo)} (hace ${s.ageMin} min)${note ? ` · ${note}` : ''}`;
}
const cache = {};
export const licorSources = () => Promise.all(LICOR_STATIONS.map((st, i) => licorSource(st, i).catch(() => null))).then(a => a.filter(Boolean));
export async function licorSource(st, i = 0) {
  const base = { id: i ? `estacion${i + 1}` : 'estacion', kind: 'observación', name: st.name, intensity: 0, rainNow: 0 }, now = Date.now();
  let c = cache[st.key] ||= { checked: 0, cookie: '', sum: null, error: '', okAt: 0 };
  if (now - c.checked >= LICOR.ttl) {
    c.checked = now;
    try {
      let r = await query(st, now, c.cookie), j = r.ok ? await r.json().catch(() => null) : null;
      // El tablero público pide una sesión anónima: se abre la página para obtenerla y se reintenta
      if (r.status === 401 || r.status === 403 || (r.ok && !j?.success)) {
        const p = await fetch(`${LICOR.base}/dashboards/public/${st.dashboard}/true`, { signal: AbortSignal.timeout(12000), headers: headers('', st.dashboard) });
        c.cookie = (p.headers.getSetCookie?.() || []).map(x => x.split(';')[0]).join('; ');
        r = await query(st, now, c.cookie); j = r.ok ? await r.json().catch(() => null) : null;
      }
      if (!r.ok) throw new Error(`respondió con error ${r.status}`);
      const pts = (j?.value?.records?.[0]?.datum?.valid || []).filter(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1])).map(p => [+p[0], +p[1]]);
      if (!pts.length) throw new Error(j?.success ? 'sin lecturas de lluvia en las últimas 24 h' : 'el tablero no entregó datos');
      c = cache[st.key] = { ...c, sum: licorSummary(pts, now), error: '', okAt: now };
    } catch (e) { c.error = e.name === 'TimeoutError' ? 'no respondió a tiempo' : e.message; }
  }
  if (!c.sum || now - c.okAt > 3 * 3600000) return { ...base, ok: false, error: c.error || 'sin datos de la estación' };
  const s = { ...c.sum }; s.ageMin = Math.max(0, Math.round((now - s.lastTo) / 60000)); s.wet = licorWet(s); s.dry = !s.wet && licorDry(s);
  // El estado de la tarjeta muestra lo que mide la estación (su "intensity" queda en 0: no decide el nivel por sí sola)
  const status = s.wet ? `Lloviendo ahora en la estación · ≈${s.stepMin < 60 ? r1(s.rain15m * 4) : s.lastMm} mm/h` : null;
  return { ...base, ok: true, zone: st.zone || 'alta', at: new Date(s.lastTo).toISOString(), ...s, status, detail: licorDetail(s, st.note) };
}
