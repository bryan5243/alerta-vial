// Clima de varias fuentes, porque un solo pronóstico no ve los aguaceros locales de la costa:
//  · Open-Meteo con 8 modelos meteorológicos (una sola consulta) + MET Norway (yr.no): pronósticos; dos tienen que coincidir
//  · Estación del aeropuerto de Santa Rosa (METAR SERO, NOAA): observación real, cuando el aeropuerto reporta
//  · Radar de lluvia de RainViewer: ve los aguaceros locales sobre la ciudad
//  · OpenWeatherMap (opcional, con API key gratuita)
//  · Lo que marca el equipo en el panel ("Está lloviendo ahora") y los reportes ciudadanos recientes
// Para el semáforo gana la fuente que vea la lluvia más fuerte (peor caso).
const TTL = 5 * 60 * 1000;
const UA = { 'user-agent': 'AlertaVial/1.0 (alertas de inundacion)' };
let cache = { at: 0, key: '', data: null };
let tideCache = { at: 0, key: '', data: null };
let metarCache = { at: 0, data: null }, owmCache = { at: 0, key: '', data: null };

export const MODELS = { best_match: 'Mejor modelo', ecmwf_ifs025: 'ECMWF (Europa)', gfs_seamless: 'GFS (EE. UU.)', icon_seamless: 'ICON (Alemania)',
  jma_seamless: 'JMA (Japón)', meteofrance_seamless: 'Météo-France', ukmo_seamless: 'UK Met Office', gem_seamless: 'GEM (Canadá)' };
const r1 = x => +(+x || 0).toFixed(1);
// Lluvia medible: menos de 0,5 mm/h es "ruido" de los modelos (garúa de la costa que no moja la calle).
const MIN_MM = 0.5;
const mmInt = mm => (mm >= 8 ? 3 : mm >= 2.5 ? 2 : mm >= MIN_MM ? 1 : 0);
const INT_MM = [0, 1, 4, 10, 20]; // lluvia típica (mm/h) para una intensidad observada sin medición
const INT_TXT = ['Sin lluvia', 'Lluvia leve', 'Lluvia moderada', 'Lluvia fuerte', 'Tormenta eléctrica'];
// Intensidad de lluvia: 0 nada, 1 leve, 2 moderada, 3 fuerte. La tormenta eléctrica va aparte (w.storm / w.thunder.now):
// puede haber rayos sin lluvia fuerte, y lo que inunda las calles es el agua, no los rayos.
const INT_CODE = [0, 61, 63, 65, 95];

async function getJson(url, ms = 8000) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: UA }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? 'no respondió a tiempo' : 'sin conexión'); }
  if (!res.ok) throw new Error(res.status === 401 ? 'API key no válida' : res.status === 429 ? 'demasiadas consultas, reintenta luego' : `respondió con error ${res.status}`);
  return res.json();
}

// Open-Meteo: los 8 modelos en UNA sola consulta (antes eran 8; los servidores compartidos agotan el límite gratuito
// y Open-Meteo responde "demasiadas consultas"). Con varios modelos, "hourly" y "daily" vienen con sufijo _<modelo>
// y "current" trae un solo juego de valores (el del mejor modelo): la lluvia de cada modelo sale de su hora actual.
const OM_TTL = 10 * 60 * 1000;     // el dato "actual" de Open-Meteo cambia cada 15 min: no hace falta pedirlo más seguido
const OM_BLOCK = 15 * 60 * 1000;   // si responde "demasiadas consultas", no se vuelve a pedir en 15 min
const OM_STALE = 60 * 60 * 1000;   // mientras tanto se sigue mostrando el último dato bueno, hasta 1 hora
let om = { at: 0, key: '', models: null, goodAt: 0, good: null, blockedUntil: 0, error: '' };

function omQuery(lat, lng, models) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: lat, longitude: lng,
    current: 'precipitation,rain,showers,temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code,cloud_cover,is_day,uv_index,shortwave_radiation',
    daily: 'uv_index_max,sunrise,sunset', hourly: 'precipitation,precipitation_probability,cape,weather_code',
    past_hours: 12, forecast_hours: 24, timezone: 'America/Guayaquil', ...(models ? { models } : {}) });
  return url;
}
// Saca los datos de un modelo de la respuesta (sufijo = respuesta con varios modelos)
function omParse(model, j, sfx) {
  const g = (o, k) => (sfx ? o?.[`${k}_${model}`] : o?.[k]);
  const H = j.hourly || {}, times = H.time || [];
  const P = g(H, 'precipitation') || [], PP = g(H, 'precipitation_probability') || [], CP = g(H, 'cape') || [], WC = g(H, 'weather_code') || [];
  const hours = times.map((t, i) => ({ time: t, precipitation: P[i] ?? null, probability: PP[i] ?? null, cape: CP[i] ?? null, code: WC[i] ?? null }));
  if (!hours.length || hours.every(h => h.precipitation == null)) return { model, name: MODELS[model], ok: false, error: 'sin datos para este punto', intensity: 0 };
  const cur = j.current || {}, useCur = model === 'best_match' || !sfx; // "current" es del mejor modelo
  const nowIdx = Math.max(0, hours.findIndex(h => h.time.slice(0, 13) === String(cur.time || '').slice(0, 13)));
  const sum = arr => r1(arr.reduce((s, h) => s + (h.precipitation || 0), 0));
  // "current" suele ser la suma de los últimos 15 min: se pasa a mm/h para compararla con la hora.
  const k = 3600 / (cur.interval || 900);
  const curMm = useCur ? Math.max(cur.precipitation ?? 0, (cur.rain ?? 0) + (cur.showers ?? 0)) * k : 0;
  const rainNow = r1(Math.max(curMm, hours[nowIdx]?.precipitation ?? 0));
  // El código del cielo solo cuenta si viene con lluvia medible: un "llovizna" con 0 mm no es lluvia.
  // Tormenta eléctrica (95–99): se anota aparte. La intensidad de lluvia sale solo de los milímetros: puede haber rayos sin aguacero.
  const code = useCur ? cur.weather_code : undefined, storm = code >= 95;
  const D = j.daily || {};
  // Sol: si es de día, índice UV (OMS), radiación solar en W/m² y horas de salida y puesta del sol
  const sun = useCur ? { isDay: cur.is_day ?? null, uvIndex: cur.uv_index ?? null, radiation: cur.shortwave_radiation ?? null,
    uvMax: g(D, 'uv_index_max')?.[0] ?? null, sunrise: g(D, 'sunrise')?.[0] ?? null, sunset: g(D, 'sunset')?.[0] ?? null } : null;
  return { model, name: MODELS[model], ok: true, observedAt: cur.time, temperature: useCur ? cur.temperature_2m : undefined, apparent: useCur ? cur.apparent_temperature : undefined, humidity: useCur ? cur.relative_humidity_2m : undefined, wind: useCur ? cur.wind_speed_10m : undefined, gust: useCur ? cur.wind_gusts_10m : undefined, cloudCover: useCur ? cur.cloud_cover : undefined, sun,
    weatherCode: code, rainNow, intensity: mmInt(rainNow), storm: storm || undefined,
    rainPast3h: sum(hours.slice(Math.max(0, nowIdx - 3), nowIdx + 1)), rainPast6h: sum(hours.slice(Math.max(0, nowIdx - 6), nowIdx + 1)), rainPast12h: sum(hours.slice(Math.max(0, nowIdx - 12), nowIdx + 1)),
    wetHours: (() => { let n = 0; for (let i = nowIdx; i >= 0 && (hours[i]?.precipitation ?? 0) >= 0.5; i--) n++; return n; })(), rainNext3h: sum(hours.slice(nowIdx + 1, nowIdx + 4)),
    rainNext24h: sum(hours.slice(nowIdx + 1, nowIdx + 25)),
    probNext3h: hours.some(h => h.probability != null) ? Math.max(0, ...hours.slice(nowIdx, nowIdx + 4).map(h => h.probability || 0)) : null,
    maxProbability24h: hours.some(h => h.probability != null) ? Math.max(0, ...hours.slice(nowIdx + 1, nowIdx + 25).map(h => h.probability || 0)) : null,
    // CAPE: energía del aire para formar nubes de tormenta (J/kg). Más de ~1000 en la costa = aguaceros posibles
    capeMax6h: hours.slice(nowIdx, nowIdx + 7).reduce((m, h) => (h.cape != null && h.cape > (m ?? -1) ? h.cape : m), null),
    thunderCode6h: hours.slice(nowIdx, nowIdx + 7).some(h => h.code >= 95),
    hourly: hours.slice(nowIdx, nowIdx + 25).map(({ cape, code, ...h }) => h) };
}
// Puente: si Open-Meteo bloquea la IP de este servidor (Render comparte IP con muchas apps), los mismos datos
// se piden a la versión PHP en cPanel, donde Open-Meteo sí responde. Así las dos páginas muestran el mismo pronóstico.
const OM_RELAY = process.env.OM_RELAY ?? 'https://www.emovttsr.gob.ec/alertavial/api/public/om-relay';
let relay = { at: 0, models: null };
async function relayModels(lat, lng) {
  if (!OM_RELAY) return null;
  if (relay.models && Date.now() - relay.at < OM_TTL) return relay.models;
  try {
    const j = await getJson(OM_RELAY, 10000);
    if (Math.abs(j.latitude - lat) > 0.15 || Math.abs(j.longitude - lng) > 0.15) return null; // otro punto: no sirve
    const models = Object.keys(MODELS).map(m => ({ ...omParse(m, j, true), via: 'cPanel' }));
    if (!models.some(m => m.ok)) return null;
    relay = { at: Date.now(), models }; return models;
  } catch { return null; }
}
async function openMeteoAll(lat, lng) {
  const ids = Object.keys(MODELS), key = `${lat},${lng}`, now = Date.now();
  if (om.models && om.key === key && now - om.at < OM_TTL) return om.models;
  const fail = (error) => {
    // Sin dato nuevo: se sigue usando el último bueno (si no es muy viejo), avisando de cuándo es
    if (om.good && om.key === key && now - om.goodAt < OM_STALE) {
      const min = Math.round((now - om.goodAt) / 60000);
      return om.good.map(m => ({ ...m, stale: true, staleMin: min, staleWhy: error }));
    }
    return ids.map(m => ({ model: m, name: MODELS[m], ok: false, error, intensity: 0 }));
  };
  if (now < om.blockedUntil && om.key === key) return (await relayModels(lat, lng)) || fail(om.error);
  let models;
  try {
    const j = await getJson(omQuery(lat, lng, ids.join(',')), 10000);
    models = ids.map(m => omParse(m, j, true));
  } catch (e) {
    if (/demasiadas consultas/.test(e.message)) { om = { ...om, key, models: null, blockedUntil: now + OM_BLOCK, error: e.message }; return (await relayModels(lat, lng)) || fail(e.message); }
    { const r = await relayModels(lat, lng); if (r) { om = { ...om, key, at: now, models: r, error: '', good: r, goodAt: now }; return r; } }
    // Si la consulta combinada no funciona por otro motivo, al menos se intenta el mejor modelo solo
    try { models = [omParse('best_match', await getJson(omQuery(lat, lng)), false), ...ids.slice(1).map(m => ({ model: m, name: MODELS[m], ok: false, error: e.message, intensity: 0 }))]; }
    catch (e2) { om = { ...om, key, models: null, error: e2.message }; return fail(e2.message); }
  }
  om = { ...om, key, at: now, models, error: '' };
  if (models.some(m => m.ok)) Object.assign(om, { good: models, goodAt: now });
  return models;
}

// MET Norway (yr.no), la otra fuente que usa Amaru: un modelo más para el consenso y respaldo si Open-Meteo falla.
// Pide identificarse con un User-Agent con contacto y no consultar más de lo necesario (10 min de caché).
const METNO_UA = { 'user-agent': 'AlertaVial/1.0 github.com/bryan5243/alerta-vial' };
let metnoCache = { at: 0, key: '', data: null };
const METNO_CODE = s => (/thunder/.test(s) ? 95 : /heavyrain|heavysleet/.test(s) ? 65 : /lightrain|lightsleet/.test(s) ? 61 : /rain|sleet/.test(s) ? 63
  : /fog/.test(s) ? 45 : /^cloudy/.test(s) ? 3 : /partlycloudy/.test(s) ? 2 : /fair/.test(s) ? 1 : 0);
async function metnoSource(lat, lng) {
  const key = `${lat},${lng}`;
  if (metnoCache.data && metnoCache.key === key && Date.now() - metnoCache.at < OM_TTL) return metnoCache.data;
  let data;
  try {
    let res;
    try { res = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${(+lat).toFixed(4)}&lon=${(+lng).toFixed(4)}`, { signal: AbortSignal.timeout(8000), headers: METNO_UA }); }
    catch (e) { throw new Error(e.name === 'TimeoutError' ? 'no respondió a tiempo' : 'sin conexión'); }
    if (!res.ok) throw new Error(res.status === 429 || res.status === 403 ? 'demasiadas consultas, reintenta luego' : `respondió con error ${res.status}`);
    const ts = (await res.json())?.properties?.timeseries || [];
    const t0 = ts[0]; if (!t0) throw new Error('sin datos para este punto');
    const det = t0.data?.instant?.details || {}, n1 = t0.data?.next_1_hours || {}, sym = n1.summary?.symbol_code || t0.data?.next_6_hours?.summary?.symbol_code || '';
    const mm = i => ts[i]?.data?.next_1_hours?.details?.precipitation_amount ?? 0;
    const rainNow = r1(mm(0)), code = METNO_CODE(sym), storm = code >= 95;
    const local = new Date(new Date(t0.time).getTime() - 5 * 3600e3), hr = local.getUTCHours();
    const isDay = /_night/.test(sym) ? 0 : /_day/.test(sym) ? 1 : hr >= 6 && hr < 18 ? 1 : 0;
    // UV con cielo despejado corregido por la nubosidad (factor empírico de Kasten-Czeplak)
    const cloud = det.cloud_area_fraction ?? null;
    const uv = det.ultraviolet_index_clear_sky == null ? null : r1(det.ultraviolet_index_clear_sky * (1 - 0.75 * Math.pow((cloud ?? 0) / 100, 3.4)));
    const prob = ts.slice(0, 4).map(x => x.data?.next_1_hours?.details?.probability_of_precipitation).filter(v => v != null);
    const symAt = i => ts[i]?.data?.next_1_hours?.summary?.symbol_code || '';
    const locHour = t => new Date(new Date(t).getTime() - 5 * 3600e3).toISOString().slice(0, 13) + ':00';
    const hourly = ts.slice(0, 25).filter(x => x.data?.next_1_hours).map(x => ({ time: locHour(x.time), precipitation: x.data.next_1_hours.details?.precipitation_amount ?? 0,
      probability: x.data.next_1_hours.details?.probability_of_precipitation ?? null, thunder: /thunder/.test(x.data.next_1_hours.summary?.symbol_code || '') || undefined }));
    data = { model: 'met_no', name: 'MET Norway (yr.no)', ok: true, observedAt: local.toISOString().slice(0, 16),
      temperature: det.air_temperature, humidity: det.relative_humidity, wind: det.wind_speed == null ? undefined : r1(det.wind_speed * 3.6), apparent: apparentTemp(det.air_temperature, det.relative_humidity, det.wind_speed), cloudCover: cloud == null ? undefined : Math.round(cloud), weatherCode: code, rainNow, intensity: mmInt(rainNow), storm: storm || undefined,
      sun: { isDay: isDay ? 1 : 0, uvIndex: isDay ? uv : 0, radiation: null, uvMax: null, sunrise: null, sunset: null },
      rainPast3h: 0, rainNext3h: r1(mm(1) + mm(2) + mm(3)), rainNext24h: r1(ts.slice(1, 25).reduce((a, _, i) => a + mm(i + 1), 0)),
      probNext3h: prob.length ? Math.max(...prob) : null, maxProbability24h: null, hourly,
      thunder6h: [0, 1, 2, 3, 4, 5].some(i => /thunder/.test(symAt(i))) };
  } catch (e) { data = { model: 'met_no', name: 'MET Norway (yr.no)', ok: false, error: e.message, intensity: 0 }; }
  metnoCache = { at: Date.now(), key, data };
  return data;
}

// METAR: reporte del aeropuerto. Ej. "SERO 142300Z 24005KT 3000 +TSRA BKN010CB 24/23 Q1010"
export function parseMetar(raw) {
  const body = String(raw || '').split(/\sRMK\s/)[0];
  let intensity = 0, near = false, txt = '';
  for (const t of body.split(/\s+/)) {
    const m = t.match(/^(\+|-|VC)?(TS|SH)?((?:DZ|RA|GR|GS|UP)*)$/);
    if (!m || (!m[2] && !m[3])) continue;
    if (m[1] === 'VC') { near = true; continue; }
    // TS = tormenta eléctrica. La lluvia se mide aparte: "TS" solo (sin RA) es tormenta sin lluvia; "-TSRA" es tormenta con lluvia leve.
    const ts = m[2] === 'TS', rain = /RA|DZ|GR|GS|UP/.test(m[3]);
    let i = /RA|GR|GS|UP/.test(m[3]) ? 2 : /DZ/.test(m[3]) ? 1 : 0;
    if (i && m[1] === '-') i = Math.max(1, i - 1);
    if (i && m[1] === '+') i = 3;
    if (i > intensity || (ts && !txt.startsWith('Tormenta'))) { intensity = Math.max(intensity, i); txt = ts ? (rain ? `Tormenta con ${INT_TXT[i].toLowerCase()}` : 'Tormenta eléctrica sin lluvia') : `${m[1] === '+' ? 'Lluvia fuerte' : m[1] === '-' ? 'Lluvia leve' : /DZ/.test(m[3]) && !/RA/.test(m[3]) ? 'Llovizna' : 'Lluvia'}${m[2] === 'SH' ? ' (chubasco)' : ''}`; }
  }
  // VC = lluvia a 8–16 km del aeropuerto, no sobre él: se informa pero no sube el semáforo.
  const air = metarAir(body);
  if (!intensity && near) return { intensity: 0, near, text: 'Lluvia en los alrededores (no sobre el aeropuerto)', ...air };
  return { intensity, near, text: txt || 'Sin lluvia', ...air };
}
// Temperatura, humedad (del punto de rocío) y viento medidos en el aeropuerto: "29/22" (M = bajo cero), "23008KT"
export function metarAir(body) {
  const out = {};
  const t = /\s(M?\d{2})\/(M?\d{2})(?=\s|$)/.exec(' ' + body);
  if (t) {
    const n = x => (x[0] === 'M' ? -1 : 1) * +x.replace('M', ''), T = n(t[1]), D = n(t[2]);
    out.temperature = T; out.humidity = Math.round(100 * Math.exp(17.625 * D / (243.04 + D)) / Math.exp(17.625 * T / (243.04 + T)));
  }
  const w = /\b(?:\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?(KT|MPS)\b/.exec(body);
  if (w) out.wind = Math.round(+w[1] * (w[2] === 'KT' ? 1.852 : 3.6));
  return out;
}
async function metarSource(station) {
  if (metarCache.data && Date.now() - metarCache.at < TTL) return metarCache.data;
  const base = { id: 'metar', kind: 'observación', name: `Aeropuerto Santa Rosa (${station})` };
  let d;
  try {
    // Dos servidores a la vez (aviationweather.gov y el de NOAA); gana el reporte más reciente que llegue.
    const fromAwc = getJson(`https://aviationweather.gov/api/data/metar?ids=${station}&format=json&hours=3`, 12000)
      .then(j => (Array.isArray(j) ? j : []).map(x => ({ raw: x.rawOb || '', at: x.obsTime ? new Date(x.obsTime * 1000) : new Date(x.reportTime || 0) })));
    const fromNoaa = fetch(`https://tgftp.nws.noaa.gov/data/observations/metar/stations/${station}.TXT`, { signal: AbortSignal.timeout(12000) })
      .then(r => { if (!r.ok) throw new Error(`NOAA ${r.status}`); return r.text(); })
      .then(t => { const [d, raw] = t.trim().split('\n'); return [{ raw: (raw || '').trim(), at: new Date(d.trim().replace(/\//g, '-').replace(' ', 'T') + ':00Z') }]; });
    const all = (await Promise.allSettled([fromAwc, fromNoaa])).flatMap(r => r.status === 'fulfilled' ? r.value : []);
    if (!all.length) throw new Error('no respondió a tiempo (se probaron 2 servidores)');
    const last = all.filter(x => x.raw && !isNaN(x.at)).sort((a, b) => b.at - a.at)[0];
    if (!last) throw new Error('el aeropuerto no envió reportes en las últimas 3 h');
    const ageMin = Math.round((Date.now() - last.at) / 60000), p = parseMetar(last.raw);
    const fresh = ageMin <= 90;
    d = { ...base, ok: fresh, stale: !fresh, at: last.at.toISOString(), ageMin, raw: last.raw, intensity: fresh ? p.intensity : 0, rainNow: fresh ? INT_MM[p.intensity] : 0,
      near: fresh && !!p.near, cb: fresh && /\b(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)\b/.test(last.raw), ts: fresh && /\b(VC)?TS/.test(last.raw.replace(/^\S+\s+\S+\s+/, '')),
      detail: `${p.text} · reporte de hace ${ageMin} min`, error: fresh ? undefined : `último reporte hace ${ageMin} min`,
      temperature: fresh ? p.temperature : undefined, humidity: fresh ? p.humidity : undefined, wind: fresh ? p.wind : undefined };
  } catch (e) { d = { ...base, ok: false, intensity: 0, error: e.message }; }
  metarCache = { at: d.ok ? Date.now() : Date.now() - TTL + 3 * 60e3, data: d }; // si falla, se reintenta en 3 min
  return d;
}


// Radar de lluvia (RainViewer): ve los aguaceros locales que los modelos de 11 km no ven.
// Se baja el cuadro de radar más reciente y se mira el píxel sobre la ciudad (a zoom 7 un píxel ≈ 1,2 km).
import zlib from 'node:zlib';
import { lightningSnapshot } from './lightning.js';
import { satSource } from './sat.js';
import { licorSources } from './licor.js';
let radarCache = { at: 0, key: '', data: null };
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('imagen de radar no válida');
  let o = 8, w = 0, h = 0, bd = 0, ct = 0, il = 0, plte = null, trns = null; const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; }
    else if (type === 'PLTE') plte = d; else if (type === 'tRNS') trns = d; else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bd !== 8 || il !== 0 || ![2, 3, 6].includes(ct)) throw new Error('formato de radar no soportado');
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 1, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = x >= bpp && y ? px[dst - stride + x - bpp] : 0, v = raw[src + x];
      px[dst + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1)
        : (() => { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); return v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); })()) & 255;
    }
  }
  return { w, h, at(x, y) {
    if (ct === 6) { const i = y * stride + x * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; }
    if (ct === 2) { const i = y * stride + x * 3; return [px[i], px[i + 1], px[i + 2], 255]; }
    const k = px[y * stride + x]; return [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], trns && k < trns.length ? trns[k] : 255];
  } };
}
// Escala "Universal Blue" (color 2) de RainViewer, de 15 a 64 dBZ (RGB). Por debajo de 15 dBZ los píxeles son semitransparentes (eco muy débil).
const UB = '88ddee 6cd1eb 51c5e8 36bae5 1baee2 00a3e0 009ad5 0091ca 0088bf 007fb4 0077aa 0070a3 00699c 006295 005b8e 005588 005180 004e78 004a70 004768 ffee00 ffe000 ffd200 ffc500 ffb700 ffaa00 ff9f00 ff9500 ff8b00 ff8100 ff4400 f23600 e62800 d91b00 cd0d00 c10000 a80000 8f0000 760000 5d0000 ffaaff ff9fff ff95ff ff8bff ff81ff ff77ff ff6cff ff62ff ff58ff ff4eff'
  .split(' ').map((h, i) => ({ dbz: 15 + i, c: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)] }));
// dBZ del píxel: busca el color más parecido de la escala; transparente o muy débil = -1
export function radarDbz([r, g, b, a]) {
  if (a < 250) return -1;
  let best = null, bd = 1e9; for (const e of UB) { const d = (e.c[0] - r) ** 2 + (e.c[1] - g) ** 2 + (e.c[2] - b) ** 2; if (d < bd) { bd = d; best = e; } }
  return bd < 40 * 40 * 3 ? best.dbz : -1;
}
// mm/h a partir de dBZ (relación Z = 200·R^1,6)
export const dbzToMm = dbz => dbz < 0 ? 0 : r1(Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6));
// Intensidad como los modelos: lluvia medible desde 0,5 mm/h (≈22 dBZ); fuerte desde 8 mm/h (≈37 dBZ)
export const radarIntensity = px => mmInt(dbzToMm(radarDbz(px)));
export function radarPixel(lat, lng, z = 7) {
  const n = 2 ** z, fx = (lng + 180) / 360 * n, sin = Math.sin(lat * Math.PI / 180), fy = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n;
  const tx = Math.floor(fx), ty = Math.floor(fy);
  return { z, tx, ty, px: Math.min(255, Math.floor((fx - tx) * 256)), py: Math.min(255, Math.floor((fy - ty) * 256)) };
}
// Lluvia medible más cercana en la imagen del radar (hasta ~50 km): sirve para saber si en la próxima hora puede llegar algo.
// A zoom 7 cada píxel mide ~1,2 km. Si la ciudad queda cerca del borde de la imagen, el radio que se revisa es menor (scanKm).
export function radarEcho(img, px, py, lat, z = 7) {
  const kmPx = 40075 * Math.cos(lat * Math.PI / 180) / (256 * 2 ** z), R = Math.min(ECHO_R, px, py, 255 - px, 255 - py);
  let best = Infinity;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const d2 = dx * dx + dy * dy; if (d2 > R * R || d2 >= best) continue;
    if (radarIntensity(img.at(px + dx, py + dy)) > 0) best = d2;
  }
  return { echoKm: best === Infinity ? null : Math.round(Math.sqrt(best) * kmPx), scanKm: Math.round(R * kmPx) };
}
// RainViewer no tiene radares en Ecuador ni en Perú (rainviewer.com/coverage.html): ahí su imagen sale vacía aunque llueva,
// y el sistema creía que "el radar no ve lluvia". En esa zona el radar no se usa.
export const radarBlind = (lat, lng) => lat > -18.5 && lat < 1.6 && lng > -81.5 && lng < -68.5;
async function radarSource(lat, lng) {
  const base = { id: 'radar', kind: 'observación', name: 'Radar de lluvia (RainViewer)' };
  if (radarBlind(lat, lng)) return null; // ni se usa ni se muestra: lo reemplaza el satélite (sat.js)
  const ck = `${lat},${lng}`;
  if (radarCache.data && radarCache.key === ck && Date.now() - radarCache.at < 4 * 60 * 1000) return radarCache.data;
  let d;
  try {
    const j = await getJson('https://api.rainviewer.com/public/weather-maps.json');
    const fr = (j.radar?.past || []).at(-1); if (!fr) throw new Error('sin cuadros de radar');
    const ageMin = Math.round((Date.now() - fr.time * 1000) / 60000);
    const { z, tx, ty, px, py } = radarPixel(lat, lng);
    // ¿Hay radar real en esta zona? (el mapa de cobertura de RainViewer: transparente = sin radar)
    const cov = await fetch(`${j.host}/v2/coverage/0/256/${z}/${tx}/${ty}/0/0_0.png`, { signal: AbortSignal.timeout(8000), headers: UA });
    if (cov.ok) {
      const ci = decodePng(Buffer.from(await cov.arrayBuffer()));
      let covered = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) covered = Math.max(covered, ci.at(Math.max(0, Math.min(255, px + dx)), Math.max(0, Math.min(255, py + dy)))[3]);
      if (covered < 40) throw new Error('sin cobertura de radar en esta zona (RainViewer no tiene radar sobre Santa Rosa)');
    }
    const res = await fetch(`${j.host}${fr.path}/256/${z}/${tx}/${ty}/2/1_1.png`, { signal: AbortSignal.timeout(8000), headers: UA });
    if (!res.ok) throw new Error(`respondió con error ${res.status}`);
    const img = decodePng(Buffer.from(await res.arrayBuffer()));
    const at = (x, y) => img.at(Math.max(0, Math.min(255, x)), Math.max(0, Math.min(255, y)));
    // "Sobre la ciudad" = el píxel y sus vecinos (≈3,6 km): un aguacero es pequeño y la ciudad ocupa varios píxeles
    let mmHere = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mmHere = Math.max(mmHere, dbzToMm(radarDbz(at(px + dx, py + dy))));
    const here = mmInt(mmHere);
    let dbzHere = -1, dbzNear = -1;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const v = radarDbz(at(px + dx, py + dy)); dbzNear = Math.max(dbzNear, v); if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) dbzHere = Math.max(dbzHere, v); }
    let nearest = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) nearest = Math.max(nearest, radarIntensity(at(px + dx, py + dy)));
    const { echoKm, scanKm } = radarEcho(img, px, py, lat);
    const fresh = ageMin <= 25;
    d = { ...base, ok: fresh, at: new Date(fr.time * 1000).toISOString(), intensity: fresh ? here : 0, rainNow: fresh ? mmHere : 0, near: fresh && nearest > 0, echoKm: fresh ? echoKm : null, scanKm: fresh ? scanKm : 0, dbz: fresh ? dbzHere : -1, dbzNear: fresh ? dbzNear : -1,
      detail: `${here ? `El radar ve lluvia sobre la ciudad (${INT_TXT[here].toLowerCase()}, ~${mmHere} mm/h)` : nearest ? 'El radar ve lluvia cerca (a pocos km), no sobre la ciudad' : 'El radar no ve lluvia sobre la ciudad'}${here ? '' : echoKm != null ? ` · la lluvia más cercana está a ~${echoKm} km` : ` · sin lluvia en ${scanKm} km a la redonda`} · imagen de hace ${ageMin} min`,
      error: fresh ? undefined : `imagen de radar de hace ${ageMin} min` };
  } catch (e) { d = { ...base, ok: false, intensity: 0, error: e.message }; }
  radarCache = { at: Date.now(), key: ck, data: d };
  return d;
}


// wttr.in (World Weather Online): otra fuente automática sin clave. Trae lluvia actual y la probabilidad de tormenta eléctrica por franjas de 3 h.
let wttrCache = { at: 0, key: '', data: null };
const WWO_THUNDER = new Set([200, 386, 389, 392, 395]);
export function parseWttr(j, hourNow) {
  const cur = j.current_condition?.[0] || {}, day = j.weather?.[0]?.hourly || [];
  const slot = Math.max(0, Math.min(day.length - 1, Math.floor(hourNow / 3)));
  const near = day.slice(slot, slot + 2), n = v => +v || 0;
  const mm = n(cur.precipMM), code = n(cur.weatherCode);
  const chance = Math.max(0, ...near.map(h => n(h.chanceofthunder)));
  const thunderNow = WWO_THUNDER.has(code) && mm >= 0.2;
  return { mm, code, chance, thunderNow, intensity: 0 };
}
async function wttrSource(lat, lng) {
  const base = { id: 'wttr', kind: 'pronóstico', name: 'World Weather Online (wttr.in)' };
  const ck = `${lat},${lng}`;
  if (wttrCache.data && wttrCache.key === ck && Date.now() - wttrCache.at < 10 * 60 * 1000) return wttrCache.data;
  let d;
  try {
    const j = await getJson(`https://wttr.in/${lat},${lng}?format=j1`, 10000);
    const hour = +new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'America/Guayaquil' }).slice(0, 2) || 0;
    const p = parseWttr(j, hour);
    // wttr.in es un modelo (pronóstico): sus mm solo respaldan a otra fuente; por sí solo no enciende "lloviendo" (salvo tormenta en curso).
    d = { ...base, ok: true, at: new Date().toISOString(), mm: p.mm, intensity: 0, rainNow: 0, thunderChance: p.chance, thunderNow: p.thunderNow,
      detail: `${p.mm} mm ahora · probabilidad de tormenta eléctrica ${p.chance} %${p.thunderNow ? ' · tormenta ahora' : ''}` };
  } catch (e) { d = { ...base, ok: false, intensity: 0, error: e.message }; }
  wttrCache = { at: Date.now(), key: ck, data: d };
  return d;
}

// OpenWeatherMap (opcional): solo si hay API key
async function owmSource(lat, lng, key) {
  const base = { id: 'owm', kind: 'pronóstico', name: 'OpenWeatherMap' }; // su "clima actual" sale de un modelo, no de una estación en la ciudad
  if (!key) return { ...base, ok: false, disabled: true, intensity: 0, error: 'sin API key' };
  const ck = `${lat},${lng},${key}`;
  if (owmCache.data && owmCache.key === ck && Date.now() - owmCache.at < TTL) return owmCache.data;
  let d;
  try {
    const j = await getJson(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${encodeURIComponent(key)}&units=metric&lang=es`);
    const id = j.weather?.[0]?.id || 800, mm = r1(j.rain?.['1h'] ?? (j.rain?.['3h'] ? j.rain['3h'] / 3 : 0));
    // Llovizna/lluvia leve sin milímetros no cuenta (mismo criterio que los modelos)
    // Tormentas (2xx): la lluvia según el código (200/230 leve, 201/231 moderada, 202/232 fuerte; 210–221 sin lluvia)
    // Códigos de OWM: 500 leve, 501 moderada, 502–504 fuerte, 511 moderada, 520 chubasco leve, 521 chubasco, 522 chubasco fuerte, 531 irregular.
    // Antes 520/522/531 se tomaban todos como "fuerte" (un chubasco leve salía como lluvia fuerte).
    const codeInt = id >= 200 && id < 300 ? ({ 200: 1, 230: 1, 201: 2, 231: 2, 202: 3, 232: 3 }[id] || 0)
      : ({ 501: 2, 502: 3, 503: 3, 504: 3, 511: 2, 521: 2, 522: 3, 531: 2 }[id] || 0); // 500/520 (leve) sin milímetros no cuentan
    // Si OWM informa los milímetros, mandan los milímetros (su código suele exagerar); el código solo se usa si no hay medida, y como mucho moderada.
    const hasMm = j.rain?.['1h'] != null || j.rain?.['3h'] != null;
    const intensity = hasMm ? mmInt(mm) : Math.min(2, codeInt);
    d = { ...base, ok: true, at: new Date((j.dt || Date.now() / 1000) * 1000).toISOString(), intensity, storm: (id >= 200 && id < 300) || undefined, rainNow: hasMm ? mm : intensity ? INT_MM[intensity] / 2 : 0,
      temperature: j.main?.temp, cloudCover: j.clouds?.all, detail: `${j.weather?.[0]?.description || ''}${mm ? ` · ${mm} mm/h` : ''}` };
  } catch (e) { d = { ...base, ok: false, intensity: 0, error: e.message }; }
  owmCache = { at: Date.now(), key: ck, data: d };
  return d;
}

// Lluvia acumulada que el propio servidor ha visto pasar (muestras de lo que decide el clima, mm/h en el tiempo).
// Sirve cuando las fuentes no traen el pasado (MET Norway y wttr.in no lo traen; Open-Meteo sí, pero a veces está bloqueado).
const rainLog = [];
export function logRain(mm, now = Date.now()) {
  const last = rainLog.at(-1);
  if (last && now - last.t < 45 * 1000) return;
  rainLog.push({ t: now, mm: Math.max(0, +mm || 0) });
  const cut = now - 13 * 3600e3; while (rainLog.length && rainLog[0].t < cut) rainLog.shift();
}
export function rainFromLog(hours, now = Date.now()) {
  let sum = 0;
  for (let i = 1; i < rainLog.length; i++) {
    const a = rainLog[i - 1], b = rainLog[i]; if (b.t < now - hours * 3600e3) continue;
    const dt = Math.min(b.t - a.t, 30 * 60 * 1000) / 3600e3; sum += (a.mm + b.mm) / 2 * dt;
  }
  return r1(sum);
}
export function wetHoursFromLog(now = Date.now()) {
  let end = null, start = null;
  for (let i = rainLog.length - 1; i >= 0; i--) {
    const x = rainLog[i];
    if (x.mm >= 0.5) { if (end == null) end = x.t; start = x.t; }
    else if (end != null && (rainLog[i + 1]?.t ?? now) - x.t > 20 * 60 * 1000) break;
  }
  return end != null && now - end < 30 * 60 * 1000 ? r1((end - start) / 3600e3) : 0;
}
// Registro de aciertos: por cada hora, la probabilidad que daban los modelos para esa hora y si de verdad llovió.
let fcLog = [];
const localHour = (now = Date.now()) => new Date(now - 5 * 3600e3).toISOString().slice(0, 13) + ':00';
export function logForecast(w, now = Date.now()) {
  const h0 = w.hourly?.[0]; if (!h0) return;
  const hour = h0.time, fc = h0.fc ?? h0.probability ?? 0, rain = w.intensity > 0;
  const e = fcLog.find(x => x.h === hour);
  if (e) { e.fc = Math.max(e.fc, fc); e.rain ||= rain; } else fcLog.push({ h: hour, fc, rain });
  fcLog = fcLog.filter(x => x.h >= localHour(now - 13 * 3600e3));
}
export function verifyFromLog(now = Date.now(), log = fcLog) {
  const cur = localHour(now), from = localHour(now - 3 * 3600e3);
  const past = log.filter(x => x.h < cur && x.h >= from), day = log.filter(x => x.h < cur && x.h >= localHour(now - 12 * 3600e3) && x.fc >= NOWCAST.bustProb);
  return { busts: past.filter(x => x.fc >= NOWCAST.bustProb && !x.rain).length, hits: past.filter(x => x.rain).length, hours: past.length,
    fc12: day.length, hit12: day.filter(x => x.rain).length };
}
function applyRainLog(w, now = Date.now()) {
  logRain(w.intensity > 0 ? w.rainNow : 0, now);
  logForecast(w, now);
  const h = n => rainFromLog(n, now);
  w.rainPast3h = Math.max(w.rainPast3h || 0, h(3)); w.rainPast6h = Math.max(w.rainPast6h || 0, h(6)); w.rainPast12h = Math.max(w.rainPast12h || 0, h(12));
  w.wetHours = Math.max(w.wetHours || 0, Math.floor(wetHoursFromLog(now)));
  return w;
}

// Combina modelos y observaciones. `extra` son fuentes locales (equipo, reportes) que arma el servidor.
// Pide todas las fuentes a la vez (puede tardar hasta ~12 s si alguna no responde)
async function fetchRemote(lat, lng, metarStation, owmKey) {
  const [omModels, metno, metar, owm, radar, wttr, sat, stations] = await Promise.all([
    openMeteoAll(lat, lng).catch(e => Object.keys(MODELS).map(m => ({ model: m, name: MODELS[m], ok: false, error: e.message, intensity: 0 }))),
    metnoSource(lat, lng),
    metarStation ? metarSource(metarStation) : Promise.resolve(null),
    owmSource(lat, lng, owmKey),
    radarSource(lat, lng),
    wttrSource(lat, lng),
    radarBlind(lat, lng) ? satSource(lat, lng) : Promise.resolve(null),
    licorSources().catch(() => []), // estaciones HOBO (LI-COR) con pluviómetro
  ]);
  return { models: [...omModels, metno], metar, owm, radar, wttr, sat, stations, at: new Date().toISOString() };
}
let refreshing = null;
// Combina modelos y observaciones. `extra` son fuentes locales (equipo, reportes) que arma el servidor.
// Nadie espera a las fuentes: si hay un dato de menos de 1 h se responde con él al instante y se renueva por detrás.
export async function getWeather({ lat, lng, metarStation = 'SERO', owmKey = '' } = {}, extra = []) {
  const key = `${lat},${lng},${metarStation},${owmKey ? 1 : 0}`;
  const age = Date.now() - cache.at, have = cache.data && cache.key === key;
  if (!have || age >= TTL) {
    refreshing ||= fetchRemote(lat, lng, metarStation, owmKey).then(data => { cache = { at: Date.now(), key, data }; }).finally(() => { refreshing = null; });
    // Con un dato guardado (aunque sea viejo) se responde al instante y se renueva por detrás; la página vuelve a pedir a los 12 s
    if (!have) await refreshing.catch(() => {});
  }
  const remote = cache.data && cache.key === key ? cache.data : await fetchRemote(lat, lng, metarStation, owmKey);
  const w = combine({ ...remote, lightning: lightningSnapshot(), verify: verifyFromLog() }, extra);
  return w.ok ? applyRainLog(w) : w;
}

// Satélite (donde no hay radar): sin nubes sobre la ciudad ni tormenta a menos de 25 km = seco; cimas de tormenta sobre la ciudad = respaldo
const satDryOf = sat => !!(sat?.ok && sat.clear && !(sat.stormKm != null && sat.stormKm <= 25));
const satWetOf = sat => !!(sat?.ok && sat.storm);
const obsDryPre = (radar, metar, sat) => (radar?.ok && !radar.intensity && !radar.near) || (metar?.ok && !metar.intensity && !metar.near) || satDryOf(sat);
export function combine({ models, metar, owm, radar, wttr, lightning, sat, station, stations = station ? [station] : [], at, verify }, extra = []) {
  // wttr.in es pronóstico: su "tormenta ahora" solo cuenta si el detector de rayos o el aeropuerto la confirman.
  if (wttr?.ok && wttr.thunderNow && !(lightning?.strikes15 > 0 || metar?.ts)) wttr = { ...wttr, thunderNow: false, detail: `${wttr.detail} · sin rayos detectados: no cuenta como tormenta` };
  // El aeropuerto reporta cada hora; el radar, cada 10 min. Si un radar al menos 30 min más reciente ya no ve lluvia ni sobre la ciudad
  // ni cerca, la lluvia de ese reporte viejo ya pasó: no cuenta ni como lluvia ni para respaldar a los pronósticos (modelos, OWM).
  if (metar?.ok && (metar.intensity || metar.near) && radar?.ok && !radar.intensity && !radar.near && Date.parse(radar.at) - Date.parse(metar.at) >= 30 * 60000)
    metar = { ...metar, intensity: 0, rainNow: 0, near: false, detail: `${metar.detail} · el radar, más reciente, ya no ve lluvia: no cuenta` };
  const okM = models.filter(m => m.ok), base = okM.find(m => m.model === 'best_match') || okM.find(m => m.model === 'met_no') || okM[0];
  // Como Amaru: las señales tienen que coincidir. Un modelo solo no basta: hace falta que al menos
  // un tercio de los modelos (3 de 9) vean lluvia medible. Y si el mejor modelo dice cielo casi despejado, los modelos no cuentan.
  // Dos modelos que coincidan. Si Open-Meteo no responde y queda un solo modelo (MET Norway, que es pronóstico),
  // solo cuenta si otra fuente lo respalda (wttr.in, radar o aeropuerto): así no marca "lluvia leve" con sol.
  // Los modelos y wttr.in son PRONÓSTICOS: dos pronósticos de acuerdo no prueban que esté lloviendo (por eso marcaba
  // lluvia con el cielo solo nublado). El respaldo tiene que ser una observación real: radar o aeropuerto.
  // "Lluvia en los alrededores" del aeropuerto (VCSH: a 8–16 km de la pista, que está a ~4 km del centro) no respalda a los pronósticos
  // si el radar, que mira la ciudad y sus alrededores, no ve nada: esa lluvia está lejos (cerros, campo).
  // Sin radar (Ecuador), el satélite hace su papel a medias: cielo sin nubes de lluvia = seco; nubes de tormenta sobre la ciudad = respaldo.
  const satDry = satDryOf(sat), satWet = satWetOf(sat);
  // Pluviómetros LI-COR. La estación de la parte baja (Ducupalta, cerca del nivel de la ciudad) manda: si llueve ahí respalda
  // a los pronósticos y si está seca cuenta como observación "no llueve". La de la parte alta solo respalda si ni la parte baja
  // ni el aeropuerto dicen que está seco: si no, esa lluvia está en los cerros (avisa de lo que bajará por los ríos, no de la ciudad).
  const sts = stations.filter(x => x?.ok), lowWet = sts.some(x => x.zone === 'baja' && x.wet), lowDry = !lowWet && sts.some(x => x.zone === 'baja' && x.dry);
  const metarDry = metar?.ok && !metar.intensity && !metar.near, highWet = sts.some(x => x.zone !== 'baja' && x.wet);
  const highBlocked = highWet && !lowWet && (lowDry || metarDry);
  const stWet = !satDry && (lowWet || (highWet && !highBlocked)); // con el cielo de la ciudad despejado (satélite), esa lluvia quedó en los cerros
  if (highBlocked || (highWet && satDry)) stations = stations.map(x => x?.ok && x.zone !== 'baja' && x.wet ? { ...x, detail: `${x.detail} · llueve en la parte alta, pero ${satDry ? 'el satélite ve despejada la ciudad' : lowDry ? 'Ducupalta (parte baja) está seca' : 'el aeropuerto no ve lluvia'}: no cuenta para la ciudad; vigila los ríos` } : x);
  const radarDry = (radar?.ok && !radar.intensity && !radar.near) || satDry;
  // "Lluvia en los alrededores" del aeropuerto (VCSH) tampoco respalda si Ducupalta (parte baja) está seca: esa lluvia está en los cerros
  const corro = (radar?.ok && (radar.intensity > 0 || radar.near)) || (metar?.ok && (metar.intensity > 0 || (metar.near && !radarDry && !lowDry))) || satWet || stWet;
  if (metar?.ok && !metar.intensity && metar.near && (radarDry || lowDry)) metar = { ...metar, detail: `${metar.detail} · ${radarDry ? `el ${satDry ? 'satélite no ve nubes de lluvia sobre la ciudad' : 'radar no la ve cerca de la ciudad'}` : 'Ducupalta (parte baja) está seca'}: no respalda a los pronósticos` };
  // OpenWeatherMap: su "clima actual" es un modelo (marcaba lluvia con cielo seco). Su lluvia solo cuenta si el radar o el aeropuerto la confirman.
  if (owm?.ok && owm.intensity && !corro) owm = { ...owm, intensity: 0, rainNow: 0, detail: `${owm.detail} · el radar y el aeropuerto no ven lluvia: no cuenta` };
  // Y aun confirmada, OWM no puede decir que llueve más fuerte que lo que ven el radar o el aeropuerto (si solo la ven cerca: leve).
  else if (owm?.ok && owm.intensity) {
    const obsMax = Math.max(radar?.ok ? radar.intensity || 0 : 0, metar?.ok ? metar.intensity || 0 : 0, 1);
    if (owm.intensity > obsMax) owm = { ...owm, intensity: obsMax, rainNow: Math.min(owm.rainNow || 0, INT_MM[obsMax]), detail: `${owm.detail} · el radar/aeropuerto ven ${INT_TXT[obsMax].toLowerCase()}: se cuenta así` };
  }
  // Observación que dice "no llueve": radar sin ecos cerca o aeropuerto sin precipitación
  const obsDry = !corro && ((radar?.ok && !radar.intensity && !radar.near) || (metar?.ok && !metar.intensity && !metar.near) || satDry || lowDry);
  // Con Open-Meteo (9 modelos) hacen falta 3 que coincidan; si solo responden 1-2 modelos, no confirman lluvia sin una observación.
  // Si una observación dice que no llueve, hace falta que la mitad de los modelos vea lluvia.
  // Excepción: si el modelo y wttr.in coinciden en lluvia moderada o más (≥ 2,5 mm/h), se acepta aunque no haya radar (no es una simple llovizna de pronóstico).
  const fcStrong = !obsDryPre(radar, metar, sat) && !lowDry && wttr?.ok && wttr.mm >= 2.5 && okM.some(m => m.rainNow >= 2.5);
  let need = okM.length >= 6 ? 3 : okM.length >= 3 ? 2 : corro || fcStrong ? 1 : 99;
  if (obsDry) need = Math.max(need, Math.ceil(okM.length * 0.6), 3);
  const kth = arr => { const v = arr.slice().sort((x, y) => y - x); return v.length >= need ? v[need - 1] : 0; };
  const clear = (base?.cloudCover ?? 100) < 50;
  const raining = okM.filter(m => m.intensity > 0);
  const mInt = clear ? 0 : kth(okM.map(m => m.intensity)), mRain = mInt ? r1(kth(okM.map(m => m.rainNow))) : 0;
  const omOk = okM.filter(m => m.model !== 'met_no').length, stale = okM.find(m => m.stale);
  const provs = [omOk && (okM.some(m => m.via) ? 'Open-Meteo vía cPanel' : 'Open-Meteo'), okM.some(m => m.model === 'met_no') && 'MET Norway'].filter(Boolean).join(' + ') || 'Open-Meteo + MET Norway';
  const modelSrc = { id: 'modelos', kind: 'pronóstico', name: `${provs} · ${okM.length} de ${models.length} modelos`, ok: okM.length > 0,
    at: base?.observedAt, intensity: mInt, rainNow: mRain,
    detail: !okM.length ? `Sin conexión con los pronósticos (${[...new Set(models.map(m => m.error).filter(Boolean))].join(' · ')})`
      : `${stale ? `Dato de Open-Meteo de hace ${stale.staleMin} min (${stale.staleWhy}) · ` : ''}${raining.length} de ${okM.length} modelos ven lluvia medible${raining.length ? ` (${raining.map(m => m.name).join(', ')})` : ''}; ${need > okM.length ? (okM.length < 3 ? 'con tan pocos modelos hace falta que el radar o el aeropuerto confirmen' : 'el radar/aeropuerto no ven lluvia: hace falta la mitad de los modelos') : `hacen falta ${need}`}${obsDry && need <= okM.length ? ` (${lowDry ? 'Ducupalta/aeropuerto' : 'radar/aeropuerto'} secos)` : ''}${clear && raining.length ? ' · no cuenta: el cielo está casi despejado' : ''} · nubosidad ${base?.cloudCover ?? '—'} %`,
    error: okM.length ? undefined : models[0]?.error, models: models.map(m => ({ name: m.name, ok: m.ok, rainNow: m.rainNow ?? 0, intensity: m.intensity || 0, error: m.error, stale: m.stale ? m.staleMin : undefined })) };
  // El radar (imagen reciente) no ve lluvia sobre la ciudad ni cerca y ninguna otra observación la ve: los modelos son pronóstico
  // y por sí solos no pueden decir "está lloviendo ahora" (marcaban lluvia leve, y el semáforo en naranja, con el cielo solo nublado).
  // Lo mismo si los dos pluviómetros/observaciones junto a la ciudad están secos a la vez: Ducupalta (parte baja) y el aeropuerto.
  const groundDry = lowDry && !(metar?.ok && metar.intensity); // Ducupalta seca y el aeropuerto sin lluvia (o sin reporte: de noche no opera)
  if ((radarDry || groundDry) && !corro && modelSrc.intensity > 0)
    Object.assign(modelSrc, { intensity: 0, rainNow: 0, detail: `${modelSrc.detail} · ${radarDry ? `el ${satDry ? 'satélite no ve nubes de lluvia sobre la ciudad' : 'radar no ve lluvia sobre la ciudad ni cerca'}` : 'Ducupalta (pluviómetro) no ve lluvia'}: no cuenta como lluvia ahora` });
  // Solo valores reales de Santa Rosa deciden si llueve ahora (pedido del 27-nov-2026): aeropuerto, pluviómetros, satélite, rayos,
  // equipo. Los modelos de Open-Meteo quedan solo como pronóstico de las próximas horas; OpenWeatherMap y wttr.in ya no se muestran.
  if (modelSrc.intensity > 0) Object.assign(modelSrc, { intensity: 0, rainNow: 0, detail: `${modelSrc.detail} · es pronóstico: no decide si llueve ahora` });
  modelSrc.forecastOnly = true;
  // El pluviómetro de la parte baja (Ducupalta) sí dice cuánto llueve: su lluvia de la última hora da la intensidad
  stations = stations.map(x => x?.ok && x.zone === 'baja' && x.wet && !satDry ? (mm => ({ ...x, intensity: mm >= 7.6 ? 3 : mm >= 2.5 ? 2 : 1, rainNow: r1(mm) }))(Math.max(x.stepMin < 60 ? x.rain1h || 0 : x.lastMm || 0, (x.rain30m || 0) * 2)) : x);
  let sources = [modelSrc, metar, ...stations, radar, sat, lightning, ...extra].filter(Boolean);
  // El equipo marcó "no llueve" en el centro: lo ven en la calle, así que ni los pronósticos (modelos, OWM, wttr) ni el aeropuerto
  // (a unos 4 km) ni el radar (píxeles de ~1 km) encienden "lloviendo" mientras dure la marca. Los reportes ciudadanos siguen contando.
  if (extra.some(x => x.id === 'equipo' && x.ok && x.dry))
    sources = sources.map(s => s.id !== 'reportes' && s.id !== 'equipo' && s.intensity > 0 ? { ...s, intensity: 0, rainNow: 0, detail: `${s.detail || INT_TXT[s.intensity]} · el equipo marcó que no llueve en el centro: no cuenta` } : s);
  const live = sources.filter(s => s.ok);
  if (!live.length) return { ok: false, source: 'Open-Meteo', error: modelSrc.error || 'sin conexión', rainNow: 0, rainPast3h: 0, rainNext3h: 0, rainNext24h: 0, hourly: [], sources, checkedAt: at };
  // Entre fuentes gana la que vea la lluvia más fuerte (cada una ya es confiable por sí sola: observación o consenso de modelos)
  const top = live.reduce((x, s) => (s.intensity > x.intensity || (s.intensity === x.intensity && (s.rainNow || 0) > (x.rainNow || 0)) ? s : x), live[0]);
  const intensity = Math.min(3, top.intensity || 0); // 0–3: la tormenta eléctrica no es una intensidad de lluvia
  // Milímetros de las últimas/próximas horas: el valor en que coinciden los modelos; si responden muy pocos, el mayor de ellos
  const pick = k => { const v = okM.map(m => m[k] || 0); return r1(v.length >= need ? kth(v) : Math.max(0, ...v)); };
  const baseCode = base?.weatherCode ?? 0, baseRainy = baseCode >= 50; // códigos de lluvia del modelo
  const gauge = stations.find(x => x?.ok && x.zone === 'baja' && x.rain3h != null);
  const w = {
    ok: true, sources, checkedAt: at, modelsNeeded: need,
    decidedBy: intensity > 0 ? top.name : null,
    source: live.map(s => s.id === 'modelos' ? `${provs} (${okM.length} modelos)` : s.name).join(' + '),
    observedAt: (intensity > 0 ? top.at : base?.observedAt) || at,
    // Temperatura: la medida en el aeropuerto si hay reporte reciente; si no, la del modelo
    temperature: (metar?.ok ? metar.temperature : null) ?? base?.temperature ?? okM.find(m => m.temperature != null)?.temperature ?? owm?.temperature, cloudCover: Math.max(base?.cloudCover ?? 0, owm?.cloudCover ?? 0, intensity ? 95 : 0),
    rainNow: intensity ? r1(Math.max(...live.map(s => (s.intensity ? s.rainNow || 0 : 0)))) : 0,
    // Acumulados: los mide el pluviómetro de la parte baja (Ducupalta); sin él, lo observado por el sistema (registro, ver withHistory)
    ...(gauge ? { rainPast3h: Math.max(gauge.rain3h || 0, intensity >= 2 ? INT_MM[intensity] : 0), rainPast6h: gauge.rain6h || 0, rainPast12h: gauge.rain12h || 0, wetHours: 0 }
      : { rainPast3h: intensity >= 2 ? INT_MM[intensity] : 0, rainPast6h: 0, rainPast12h: 0, wetHours: 0 }),
    rainNext3h: pick('rainNext3h'), rainNext24h: pick('rainNext24h'),
    probNext3h: null, maxProbability24h: null,
    // Si nadie confirma lluvia, el ícono no puede decir "llovizna": se muestra nublado (3) o el cielo del modelo.
    weatherCode: intensity ? INT_CODE[intensity] : baseRainy ? 3 : baseCode,
    hourly: mergeHourly(okM),
  };
  // Si una fuente confirma que está lloviendo, la hora en curso es 100 % (ya no es pronóstico)
  if (intensity > 0 && w.hourly.length) w.hourly[0] = rainingNow(w.hourly[0], w.rainNow);
  // No llueve y el radar no ve nada sobre la ciudad ni cerca: la columna "Ahora" muestra lo observado, no el pronóstico
  // (marcaba 100 % y 2,3 mm con el cielo seco). Queda una probabilidad baja por si se forma algo dentro de la hora.
  else if ((radarDry || groundDry) && w.hourly.length) w.hourly[0] = { ...w.hourly[0], fc: w.hourly[0].probability, probability: Math.min(w.hourly[0].probability, NOW_DRY_PROB), precipitation: 0, estimated: undefined, observed: true };
  w.nowcast = nowcast(w, radar, verify, sat);
  // Probabilidad de lluvia: la de la hora en curso y las 3 siguientes, y la mayor de las próximas 24 h
  if (w.hourly.length) {
    w.probNext3h = Math.max(...w.hourly.slice(0, 4).map(h => h.probability));
    w.maxProbability24h = Math.max(...w.hourly.slice(1, 25).map(h => h.probability));
    w.probEstimated = w.hourly.slice(0, 4).every(h => h.estimated);
  }
  w.periods = dayParts(w.hourly);
  { // humedad y viento: del aeropuerto si hay reporte reciente; si no, del mejor modelo
    const obs = metar?.ok && metar.temperature != null ? metar : null;
    const pk = k => obs?.[k] ?? base?.[k] ?? okM.find(m => m[k] != null)?.[k];
    w.humidity = pk('humidity') == null ? undefined : Math.round(pk('humidity')); w.wind = pk('wind') == null ? undefined : Math.round(pk('wind')); w.gust = base?.gust ?? okM.find(m => m.gust != null)?.gust; if (w.gust != null) w.gust = Math.round(w.gust);
    w.tempFrom = obs ? 'aeropuerto' : 'modelo';
    // Sensación térmica a la sombra (Steadman: temperatura + humedad − viento), como la publica el INAMHI.
    // La de Open-Meteo suma también el sol directo del mediodía y daba 6–8 °C de más (p. ej. 41 °C con 34 °C de aire).
    w.apparent = apparentTemp(w.temperature, w.humidity, (w.wind || 0) / 3.6);
    w.heat = heatInfo(w.apparent);
  }
  w.sun = sunInfo(base?.sun || okM.find(m => m.sun?.uvIndex != null)?.sun, w.cloudCover, intensity);
  Object.assign(w, describe(w));
  if (intensity !== w.intensity) Object.assign(w, { intensity, raining: intensity > 0, condition: intensity ? INT_TXT[intensity] : w.condition });
  // Sin lluvia: de día y despejado es "Soleado"; de noche, "Noche despejada"
  // Modelos con cielo cubierto pero el sol pasando entre las nubes: "Resplandor"
  if (!w.intensity && w.sun?.sky === 'parcial' && w.condition === 'Nublado') w.condition = 'Resplandor';
  if (!w.intensity && w.sun?.sky === 'soleado' && w.condition === 'Nublado') w.condition = 'Soleado';
  if (!w.intensity && w.sun && ['Despejado', 'Parcialmente nublado'].includes(w.condition) && (w.condition === 'Despejado' || w.sun.sky === 'soleado')) w.condition = w.sun.sky === 'noche' ? 'Noche despejada' : 'Soleado';
  // Sol muy fuerte (UV muy alto o radiación de cielo casi limpio): "Sol intenso"
  if (w.condition === 'Soleado' && ((w.sun?.uvIndex ?? 0) >= 8 || (w.sun?.radiation ?? 0) >= 800)) w.condition = 'Sol intenso';
  w.outlook = outlookOf(w, { okM, metar, need, base, radarDry });
  if (w.outlook.level !== 'calma' && w.nowcast.note) w.outlook.reasons.push(w.nowcast.note);
  w.thunder = thunderOf(w, { okM, metar, radar, wttr, lightning, sat, extra });
  // Tormenta eléctrica en curso: se muestra (ícono, rayos, aviso), pero el semáforo de inundación sigue la lluvia que cae.
  w.storm = !!w.thunder.now;
  if (w.storm) w.condition = w.intensity ? `Tormenta con ${INT_TXT[Math.min(3, w.intensity)].toLowerCase()}` : 'Tormenta eléctrica sin lluvia';
  return w;
}

// Ajusta las próximas horas (no la actual) con el radar y con los aciertos recientes de los modelos. Devuelve qué hizo.
function nowcast(w, radar, verify, sat) {
  const H = w.hourly || [], v = verify || {}, out = { factor: 1, busts: v.busts || 0, hits: v.hits || 0, caps: [] };
  if (!H.length || w.intensity > 0) return out;
  const short = out.busts >= 2 && !out.hits ? (out.busts >= 3 ? 0.6 : 0.75) : 1;
  const rate = v.fc12 >= 4 ? v.hit12 / v.fc12 : 1, day = rate < 0.2 ? 0.6 : rate < 0.4 ? 0.75 : 1;
  const cap = (i, p, why) => { if (H[i] && H[i].probability > p) { H[i] = { ...H[i], fc: H[i].fc ?? H[i].probability, probability: p, nowcast: why }; out.caps.push(i); } };
  out.factor = Math.min(short, day);
  if (out.factor < 1) {
    for (let i = 1; i < H.length && i <= 24; i++) {
      const f = 1 - (1 - out.factor) * (i <= 6 ? 1 : i <= 12 ? 0.75 : 0.5);
      cap(i, Math.round(H[i].probability * f / 5) * 5, 'fallos');
    }
    out.note = short <= day ? `los modelos anunciaron lluvia ${out.busts} de las últimas 3 horas y no llovió: se bajó su probabilidad para las próximas horas`
      : `hoy los modelos acertaron ${v.hit12} de ${v.fc12} horas en que anunciaban lluvia: se bajó su probabilidad para las próximas horas`;
  }
  if (radar?.ok && !radar.intensity && !radar.near) {
    const e = radar.echoKm, s = radar.scanKm || 0;
    if (e == null && s >= NOWCAST.near1) cap(1, NOWCAST.h1Clear, 'radar');
    else if (e != null && e > NOWCAST.near1) cap(1, NOWCAST.h1Far, 'radar');
    if (e == null && s >= NOWCAST.near2) cap(2, NOWCAST.h2Clear, 'radar');
  }
  // Satélite: sin nubes de lluvia sobre la ciudad y sin tormentas a menos de 40 km → la próxima hora como mucho 50 %
  else if (sat?.ok && sat.clear && sat.stormKm == null) cap(1, NOWCAST.h1Far, 'satélite');
  return out;
}

// Pronóstico hora por hora juntando todos los modelos que respondieron (próximas 24 h).
// Probabilidad de lluvia de cada hora = la mayor entre:
//  · la probabilidad que publican los modelos (sale de sus "ensambles": decenas de corridas del mismo modelo), en promedio
//  · la parte de los modelos que prevén lluvia en esa hora (si 4 de 9 ven lluvia, ~45 %)
// Así nunca queda en 0 % por falta de dato cuando varios modelos sí ven lluvia. Con 1 o 2 modelos se estima por los milímetros.
const P_MM = [[5, 90], [2.5, 80], [1, 70], [0.5, 55], [0.2, 40], [0.1, 25]];
const WET_MM = 0.1; // desde 0,1 mm el modelo "ve lluvia" en esa hora
const FC_MAX_PROB = 90, NOW_DRY_PROB = 20, ECHO_R = 40;
// Corrección de las próximas horas con lo que se ve ahora (radar) y con cuánto vienen acertando los modelos hoy:
//  · radar sin lluvia en 25 km → la próxima hora como mucho 35 % (con lluvia a más de 25 km, 50 %); sin lluvia en 45 km → la siguiente, 60 %
//  · aciertos de los modelos: si en las últimas 3 h dieron ≥ 70 % y no llovió (2 o 3 veces), o si en las últimas 12 h
//    acertaron menos del 40 % (o del 20 %) de las horas en que dieron ≥ 70 %, se baja la probabilidad de las próximas 24 h:
//    entera en las próximas 6 h, 3/4 de la corrección de 7 a 12 h y la mitad de 13 a 24 h (cuanto más lejos, menos se sabe)
export const NOWCAST = { h1Clear: 35, h1Far: 50, h2Clear: 60, near1: 25, near2: 45, bustProb: 70 };
export function mergeHourly(okM) {
  const withH = okM.filter(m => m.hourly?.length);
  if (!withH.length) return [];
  // empieza en la hora actual de la fuente más reciente (un dato viejo de Open-Meteo puede traer una hora ya pasada)
  const start = withH.map(m => m.hourly[0].time).sort().at(-1);
  const times = [...new Set(withH.flatMap(m => m.hourly.map(h => h.time)))].filter(t => t >= start).sort().slice(0, 25);
  const by = withH.map(m => new Map(m.hourly.map(h => [h.time, h])));
  return times.map(time => {
    const at = by.map(b => b.get(time)).filter(h => h && h.precipitation != null);
    const mm = at.map(h => h.precipitation), n = mm.length, wet = mm.filter(v => v >= WET_MM).length, max = n ? Math.max(...mm) : 0;
    const api = at.map(h => h.probability).filter(v => v != null);
    const pApi = api.length ? api.reduce((a, v) => a + v, 0) / api.length : null;
    const pModels = n >= 3 ? (wet / n) * 100 : (P_MM.find(([min]) => max >= min)?.[1] ?? 0);
    const p = Math.max(pApi ?? 0, pModels);
    // Milímetros de la hora: si al menos un tercio de los modelos ve lluvia, el promedio de esos ("si llueve, cae esto"); si no, el promedio de todos
    const avg = arr => (arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0), wetMm = mm.filter(v => v >= WET_MM);
    // Un pronóstico nunca es seguro: tope de 90 %. El 100 % queda solo para la hora en que una observación confirma que llueve.
    return { time, probability: Math.min(FC_MAX_PROB, Math.round(p / 5) * 5), precipitation: r1(wet * 3 >= n ? avg(wetMm) : avg(mm)), precipMax: r1(max),
      wet, of: n, estimated: pApi == null || pModels > pApi || undefined, thunder: at.some(h => h.thunder) || undefined };
  });
}
export const rainingNow = (h, mm) => ({ ...h, probability: 100, precipitation: Math.max(h.precipitation || 0, r1(mm)), estimated: undefined });
// Resumen por partes del día (madrugada, mañana, tarde, noche) de las próximas 24 h: probabilidad más alta y milímetros esperados
const PART = h => (h < 6 ? 'Madrugada' : h < 12 ? 'Mañana' : h < 18 ? 'Tarde' : 'Noche');
export function dayParts(hourly) {
  const out = [];
  for (const h of (hourly || []).slice(0, 24)) {
    const hr = +h.time.slice(11, 13), day = h.time.slice(0, 10), key = `${day}-${PART(hr)}`;
    let p = out.at(-1);
    if (!p || p.key !== key) out.push(p = { key, label: PART(hr), day, from: h.time, to: h.time, probability: 0, precipitation: 0, hours: 0 });
    p.to = h.time; p.hours++; p.probability = Math.max(p.probability, h.probability); p.precipitation = r1(p.precipitation + h.precipitation);
  }
  // un tramo de una sola hora al final no dice nada
  if (out.length > 1 && out.at(-1).hours < 2) out.pop();
  return out.map(({ key, ...p }) => p);
}

// Aviso de lluvia probable (no cambia el semáforo). Solo se publica si en alguna de las próximas 6 horas la
// probabilidad llega a NOTICE_PROB (80 %): con menos, el aviso se cae a "calma" aunque haya otras señales,
// porque avisar de una lluvia que no llega confunde a la gente. Las demás señales solo explican el aviso.
export const NOTICE_PROB = 80;
function outlookOf(w, { okM, metar, need, base, radarDry }) {
  const reasons = []; let score = 0;
  // Para la hora en curso manda el radar: si no ve nada sobre la ciudad ni cerca, el pronóstico de "esta hora" ya falló
  // (decía "Lluvia probable 11:00" a las 11:42 sin una gota). Se miran las horas siguientes.
  const hrs = (w.hourly || []).slice(radarDry ? 1 : 0, 7);
  const peak = Math.max(0, ...hrs.map(h => h.probability ?? 0));
  if (peak >= NOTICE_PROB) { score += 3; reasons.push(`probabilidad de lluvia de ${peak} % en las próximas 6 h`); }
  const wet = okM.filter(m => (m.rainNext3h || 0) >= MIN_MM);
  if (wet.length) {
    score += wet.length >= need ? 2 : 1;
    reasons.push(`${wet.length} de ${okM.length} modelos prevén lluvia en las próximas 3 h (hasta ~${String(r1(Math.max(...wet.map(m => m.rainNext3h)))).replace('.', ',')} mm)`);
  }
  const cape = Math.max(-1, ...okM.map(m => m.capeMax6h ?? -1));
  if (cape >= 1000) { score += cape >= 2000 ? 2 : 1; reasons.push(`el aire tiene energía para formar aguaceros (ambiente de tormenta${cape >= 2000 ? ' fuerte' : ''})`); }
  if (okM.some(m => m.thunder6h)) { score += 1; reasons.push('MET Norway prevé tormenta en las próximas 6 h'); }
  if (metar?.ok && metar.ts) { score += 2; reasons.push('el aeropuerto reporta tormenta en la zona'); }
  else if (metar?.ok && metar.near) { score += 2; reasons.push('el aeropuerto ve lluvia en los alrededores'); }
  else if (metar?.ok && metar.cb) { score += 1; reasons.push('el aeropuerto ve nubes de tormenta (cumulonimbos) cerca'); }
  // ¿desde qué hora? la primera hora con probabilidad alta o lluvia prevista
  const from = hrs.find(h => (h.probability ?? 0) >= NOTICE_PROB)?.time || null;
  // Si esa hora es la que está corriendo (p. ej. son las 09:16 y la hora es 09:00), no se dice "desde las 09:00": ya empezó
  const fromNow = !!from && from === w.hourly[0]?.time;
  const level = w.intensity > 0 ? 'lloviendo' : peak >= NOTICE_PROB ? 'probable' : 'calma';
  const title = { lloviendo: 'Está lloviendo', probable: 'Lluvia probable en las próximas horas', calma: 'Sin lluvia a la vista' }[level];
  const text = level === 'lloviendo' ? 'Revisa las calles inundadas y las vías alternas antes de salir.'
    : level === 'calma' ? `No hay una probabilidad alta de lluvia (${NOTICE_PROB} % o más) en las próximas 6 horas.`
    : `Ahora no llueve, pero es probable un aguacero${fromNow ? ' en cualquier momento de esta hora' : from ? ` desde las ${from.slice(11, 16)}, aproximadamente` : ''}. Lleva paraguas y evita las calles que suelen inundarse.`;
  return { level, score, title, text, reasons: level === 'calma' ? [] : reasons, from, fromNow, peak, min: NOTICE_PROB };
}


// Probabilidad estimada de tormenta eléctrica en las próximas 6 h. No existe un dato oficial de rayos para este punto: se combinan
// los modelos que prevén tormenta (códigos 95-99 / MET Norway), la energía del aire (CAPE), la lluvia probable y lo que ve el aeropuerto.
function thunderOf(w, { okM, metar, radar, wttr, lightning, sat, extra = [] }) {
  const reasons = [], n = okM.length || 1;
  const votes = okM.filter(m => m.thunderCode6h || m.thunder6h).length, share = votes / n;
  const cape = Math.max(-1, ...okM.map(m => m.capeMax6h ?? -1));
  const capeP = cape < 300 ? 0 : cape < 1000 ? 10 + (cape - 300) / 700 * 20 : cape < 2000 ? 30 + (cape - 1000) / 1000 * 25 : Math.min(75, 55 + (cape - 2000) / 1500 * 20);
  const peak = Math.max(0, ...(w.hourly || []).slice(0, 7).map(h => h.probability ?? 0));
  let p = Math.max(share * 85, capeP);
  if (votes) reasons.push(`${votes} de ${n} modelos prevén tormenta eléctrica en las próximas 6 h`);
  if (cape >= 1000) reasons.push(`el aire tiene energía para tormentas${cape >= 2000 ? ' fuertes' : ''} (CAPE ${Math.round(cape)} J/kg)`);
  if (peak >= 60 && cape >= 800) { p += 12; reasons.push(`probabilidad de lluvia de ${peak} %`); }
  if (metar?.ok && metar.cb) { p = Math.max(p, 60); reasons.push('el aeropuerto ve nubes de tormenta (cumulonimbos) cerca'); }
  // Radar: ecos de 45 dBZ o más son núcleos de tormenta (aguacero convectivo muy intenso)
  if (radar?.ok && radar.dbz >= 45) { p = Math.max(p, radar.dbz >= 50 ? 85 : 70); reasons.push(`el radar ve un núcleo de tormenta sobre la ciudad (${radar.dbz} dBZ)`); }
  else if (radar?.ok && radar.dbzNear >= 45) { p = Math.max(p, 55); reasons.push(`el radar ve un núcleo de tormenta cerca (${radar.dbzNear} dBZ)`); }
  // Satélite: cimas de 12 km o más sobre la ciudad son cumulonimbos (nubes de tormenta); de 15 km o más, tormenta fuerte
  if (sat?.ok && sat.storm) { p = Math.max(p, sat.topKm >= 15 ? 75 : 60); reasons.push(`el satélite ve nubes de tormenta sobre la ciudad (cima a ~${sat.topKm} km)`); }
  else if (sat?.ok && sat.stormKm != null && sat.stormKm <= 40) { p = Math.max(p, 45); reasons.push(`el satélite ve nubes de tormenta a ~${sat.stormKm} km`); }
  if (wttr?.ok && wttr.thunderChance >= 20) { const wp = Math.min(85, Math.round(wttr.thunderChance * 0.9)); p = Math.max(p, wp); reasons.push(`World Weather Online da ${wttr.thunderChance} % de probabilidad de tormenta eléctrica`); }
  // Rayos detectados: la señal más confiable. Cerca (15 km) = tormenta en curso; a 30–60 km = tormenta cercana
  const lg = lightning?.ok ? lightning : null;
  if (lg?.strikes15 > 0) { p = 90; reasons.push(`se detectaron ${lg.strikes10 || lg.strikes15} rayo${(lg.strikes10 || lg.strikes15) > 1 ? 's' : ''} a menos de 15 km en los últimos minutos`); }
  else if (lg?.strikes30 > 0) { p = Math.max(p, 75); reasons.push(`hay rayos a menos de 30 km (el más cercano a ${lg.nearestKm} km)`); }
  else if (lg?.strikes60 > 0) { p = Math.max(p, 55); reasons.push(`hay rayos a menos de 60 km (el más cercano a ${lg.nearestKm} km)`); }
  const team = extra.some(x => x.id === 'equipo' && x.ok && x.storm);
  if (team) reasons.push('el equipo EMOVTT confirma tormenta eléctrica');
  // Tormenta ahora: la confirma el aeropuerto, el detector de rayos o el equipo; o la ven a la vez tantos modelos como los que se piden para la lluvia
  const mStorm = okM.filter(m => m.storm).length >= (w.modelsNeeded || 99);
  if (mStorm) reasons.push('varios modelos ven tormenta eléctrica en este momento');
  const now = mStorm || w.weatherCode >= 95 || !!(metar?.ok && metar.ts) || team || !!(wttr?.ok && wttr.thunderNow) || (lg?.strikes15 > 0);
  if (metar?.ok && metar.ts) { p = Math.max(p, 90); reasons.push('el aeropuerto reporta tormenta en la zona'); }
  if (w.weatherCode >= 95) { p = Math.max(p, 90); reasons.push('hay tormenta eléctrica ahora mismo'); }
  // Intensidad de la tormenta en curso (como "lluvia leve / moderada / fuerte"): por los mm/h que reportan las fuentes y los núcleos del radar
  let activity = null;
  if (now) {
    const rm = Math.max(radar?.ok ? radar.rainNow || 0 : 0, wttr?.ok ? wttr.mm || 0 : 0, ...okM.map(m => m.rainNow || 0), ...extra.filter(x => x.ok && x.storm).map(x => x.rainNow || 0));
    const dbz = radar?.ok ? radar.dbz : -1;
    const rate = lg?.strikes10 || 0, lv = dbz >= 50 || rm >= 8 || rate >= 20 ? 3 : dbz >= 45 || rm >= 2.5 || rate >= 6 ? 2 : 1;
    activity = { level: lv, label: ['', 'Tormenta leve', 'Tormenta moderada', 'Tormenta intensa'][lv], mm: r1(rm) };
  }
  p = now ? Math.max(90, Math.round(p)) : Math.max(0, Math.min(90, Math.round(p / 5) * 5));
  const level = now ? 'activa' : p >= 70 ? 'alta' : p >= 40 ? 'moderada' : p >= 15 ? 'baja' : 'nula';
  const label = { activa: 'Tormenta ahora', alta: 'Alta', moderada: 'Moderada', baja: 'Baja', nula: 'Muy baja' }[level];
  const text = { activa: 'Hay tormenta eléctrica. Busca refugio bajo techo, evita árboles y zonas abiertas, y no cruces calles inundadas.',
    alta: 'Es muy probable una tormenta eléctrica en las próximas horas. Evita salir y mantente lejos de ríos y calles que se inundan.',
    moderada: 'Puede haber tormenta eléctrica en las próximas horas. Revisa el cielo y ten un plan por si cae un aguacero fuerte.',
    baja: 'Hay poca probabilidad de tormenta eléctrica, pero conviene revisar el clima si vas a salir.',
    nula: 'No se espera tormenta eléctrica en las próximas 6 horas.' }[level];
  return { prob: p, level, label, text, reasons: level === 'nula' ? [] : reasons, now, activity, models: { votes, of: n }, cape: cape >= 0 ? Math.round(cape) : null };
}


// Sensación térmica (temperatura aparente, fórmula de Steadman: suma la humedad y resta el viento). t en °C, rh en %, ws en m/s.
export function apparentTemp(t, rh, ws) {
  if (t == null || rh == null) return undefined;
  const e = rh / 100 * 6.105 * Math.exp(17.27 * t / (237.7 + t));
  return r1(t + 0.33 * e - 0.70 * (ws || 0) - 4);
}
// Nivel de calor según la sensación térmica y consejo para la gente
export function heatInfo(app) {
  if (app == null) return null;
  const L = [[41, 'peligro', 'Calor peligroso', 'Evita el sol y el esfuerzo; hidrátate y busca lugares frescos. Riesgo de golpe de calor.'],
    [32, 'extremo', 'Muy caluroso', 'Toma agua seguido, descansa a la sombra y evita actividad intensa al mediodía.'],
    [27, 'caluroso', 'Caluroso', 'Hidrátate y usa ropa ligera. Cuida a niños y adultos mayores.'],
    [18, 'agradable', 'Agradable', ''], [-99, 'fresco', 'Fresco', 'Lleva una prenda de abrigo.']];
  const [, key, label, advice] = L.find(x => app >= x[0]);
  return { key, label, advice };
}

// Índice UV según la escala de la OMS, con el consejo para la gente
const UV = [[11, 'extremo', 'Extremo', 'Evita salir al sol; si sales, protector, gorra, lentes y ropa que cubra.'],
  [8, 'muy-alto', 'Muy alto', 'Evita el sol de 10:00 a 15:00. Protector solar, gorra y lentes.'],
  [6, 'alto', 'Alto', 'Usa protector solar y gorra; busca sombra al mediodía.'],
  [3, 'moderado', 'Moderado', 'Protector solar si vas a estar más de 30 minutos al sol.'],
  [0, 'bajo', 'Bajo', 'Sin riesgo por el sol.']];
export const uvLevel = v => { const u = UV.find(([min]) => (v ?? 0) >= min); return { key: u[1], label: u[2], advice: u[3] }; };
// Estado del cielo para el mapa y el panel: soleado, parcial, nublado, lluvia o noche
function sunInfo(s, cloud, intensity) {
  if (!s) return null;
  const night = s.isDay === 0, c = cloud ?? 0;
  // Con mucha radiación o UV alto el sol "pega fuerte": es soleado aunque los modelos reporten algo de nube alta (c < 80)
  const strongSun = !night && c < 80 && ((s.radiation ?? 0) >= 550 || (s.uvIndex ?? 0) >= 4.5);
  // Con el cielo cubierto según los modelos (≥ 80 %) pero el sol pasando (radiación ≥ 450 W/m² o UV ≥ 6), las nubes son finas o
  // dejan claros: no es "nublado" sino sol entre nubes. (Con el cielo de verdad cubierto la radiación cae a 100–300 W/m².)
  const sunThrough = !night && ((s.radiation ?? 0) >= 450 || (s.uvIndex ?? 0) >= 6);
  const sky = intensity > 0 ? 'lluvia' : night ? 'noche' : strongSun ? 'soleado' : c >= 80 ? (sunThrough ? 'parcial' : 'nublado') : c >= 40 ? 'parcial' : 'soleado';
  const uv = s.uvIndex == null ? null : Math.round(s.uvIndex * 10) / 10;
  return { ...s, uvIndex: uv, uvMax: s.uvMax == null ? null : Math.round(s.uvMax * 10) / 10, radiation: s.radiation == null ? null : Math.round(s.radiation),
    sky, uv: uvLevel(night ? 0 : uv), uvMaxLevel: uvLevel(s.uvMax) };
}

// Fuentes locales: lo que marca el equipo y los reportes ciudadanos de la última hora
export function localSources({ observed, reports = [] }) {
  const out = [];
  const hasta = observed && new Date(observed.until).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil', hourCycle: 'h23' });
  // "No llueve": el equipo ve la calle seca en el centro. Manda sobre los pronósticos y las estaciones de afuera (ver combine).
  if (observed?.dry && new Date(observed.until) > Date.now())
    out.push({ id: 'equipo', kind: 'observación', name: 'Equipo EMOVTT', ok: true, at: observed.at, intensity: 0, rainNow: 0, dry: true, detail: `No llueve en el centro (marcado en el panel) · vigente hasta ${hasta}` });
  else if (observed && new Date(observed.until) > Date.now()) {
    // "Tormenta" (4) del equipo = truenos y rayos con lluvia moderada: el semáforo sigue a la lluvia, la tormenta se avisa aparte.
    const o = Math.max(0, Math.min(4, +observed.intensity || 0)), i = o >= 4 ? 2 : o;
    out.push({ id: 'equipo', kind: 'observación', name: 'Equipo EMOVTT', ok: true, at: observed.at, intensity: i, rainNow: INT_MM[i], storm: o >= 4 || undefined,
      detail: `${INT_TXT[o]} marcada en el panel · vigente hasta ${new Date(observed.until).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil', hourCycle: 'h23' })}` });
  }
  const recent = reports.filter(r => r.status !== 'descartado' && Date.now() - new Date(r.createdAt) < 3600e3);
  if (recent.length) {
    const ver = recent.filter(r => r.status === 'verificado');
    const i = ver.some(r => r.level === 'grave') ? 3 : ver.length ? 2 : recent.length >= 3 ? 2 : recent.length >= 2 ? 1 : 0;
    out.push({ id: 'reportes', kind: 'observación', name: 'Reportes ciudadanos', ok: true, at: recent.map(r => r.createdAt).sort().at(-1), intensity: i, rainNow: INT_MM[i],
      detail: `${recent.length} reporte${recent.length > 1 ? 's' : ''} en la última hora${ver.length ? ` (${ver.length} verificado${ver.length > 1 ? 's' : ''})` : ''}${i ? '' : ' · hace falta otro para contar como lluvia'}` });
  }
  return out;
}

// Códigos WMO de Open-Meteo → intensidad de lluvia (0 nada, 1 llovizna/leve, 2 moderada, 3 fuerte, 4 tormenta)
const CODE = { 51: [1, 'Llovizna'], 53: [1, 'Llovizna'], 55: [2, 'Llovizna intensa'], 56: [1, 'Llovizna'], 57: [2, 'Llovizna intensa'],
  61: [1, 'Lluvia leve'], 63: [2, 'Lluvia moderada'], 65: [3, 'Lluvia fuerte'], 66: [1, 'Lluvia leve'], 67: [3, 'Lluvia fuerte'],
  80: [1, 'Chubascos leves'], 81: [2, 'Chubascos moderados'], 82: [3, 'Chubascos fuertes'], 95: [0, 'Tormenta eléctrica'], 96: [0, 'Tormenta con granizo'], 99: [0, 'Tormenta con granizo'] };
export function describe(w) {
  const [codeInt, codeTxt] = CODE[w.weatherCode] || [0, ''];
  const mmInt = w.rainNow >= 8 ? 3 : w.rainNow >= 2.5 ? 2 : w.rainNow >= MIN_MM ? 1 : 0;
  const intensity = Math.max(codeInt, mmInt);
  const condition = codeTxt || (mmInt === 3 ? 'Lluvia fuerte' : mmInt === 2 ? 'Lluvia moderada' : mmInt === 1 ? 'Lluvia leve'
    : (w.cloudCover ?? 0) >= 70 ? 'Nublado' : (w.cloudCover ?? 0) >= 30 ? 'Parcialmente nublado' : 'Despejado');
  // Tormenta (95–99): la intensidad de lluvia sale de los milímetros; la tormenta se marca aparte
  return { raining: intensity > 0, intensity, condition, storm: w.weatherCode >= 95 };
}

// Marea (nivel del mar) desde Open-Meteo Marine. Útil en ciudades costeras como Santa Rosa (El Oro).
// Devuelve qué tan alta está la marea ahora respecto al rango de las próximas 24 h (0 = bajamar, 1 = pleamar).
// Marea: igual que el clima, se responde con el último dato y se renueva por detrás
let tideRefreshing = null;
export async function getTide({ lat, lng }) {
  const key = `${lat},${lng}`, have = tideCache.data && tideCache.key === key, age = Date.now() - tideCache.at;
  if (have && age < TTL * 3) return tideCache.data;
  tideRefreshing ||= fetchTide(lat, lng, key).finally(() => { tideRefreshing = null; });
  return have && age < 6 * 3600e3 ? tideCache.data : tideRefreshing;
}
async function fetchTide(lat, lng, key) {
  try {
    const url = new URL('https://marine-api.open-meteo.com/v1/marine');
    url.search = new URLSearchParams({ latitude: lat, longitude: lng, hourly: 'sea_level_height_msl', forecast_hours: 24, past_hours: 1, timezone: 'America/Guayaquil', cell_selection: 'sea' });
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Marine ${res.status}`);
    const j = await res.json();
    const v = (j.hourly.sea_level_height_msl || []).filter(x => x != null);
    if (v.length < 3) throw new Error('sin datos de marea');
    const min = Math.min(...v), max = Math.max(...v), now = v[1] ?? v[0];
    const data = { ok: true, source: 'Open-Meteo Marine', levelM: +now.toFixed(2), relative: max > min ? +((now - min) / (max - min)).toFixed(2) : 0 };
    tideCache = { at: Date.now(), key, data };
    return data;
  } catch (err) {
    const data = { ok: false, source: 'Open-Meteo Marine', error: err.message, relative: 0 };
    tideCache = { at: Date.now(), key, data };
    return data;
  }
}

// Índice de riesgo 0–100 (inspirado en Amaru): combina varias señales independientes.
//  lluvia actual 30 · pronóstico 24 h 25 · ríos 20 · reportes ciudadanos 15 · marea 10
export function riskIndex({ weather: w, cfg, flood, reports = [], tide, rivers = [] }) {
  const t = cfg.rainThresholdMm || 2.4, t3 = cfg.rainThresholdMm3h || 7;
  const clamp = x => Math.max(0, Math.min(1, x));
  const parts = [];
  const rainNow = w.ok ? clamp(Math.max(w.rainNow / (t * 3), (w.intensity ? w.rainPast3h : 0) / (t3 * 2), [0, 0.25, 0.5, 0.8, 1][w.intensity || 0])) : 0; // el acumulado solo pesa mientras llueve
  parts.push({ key: 'lluvia', label: 'Lluvia actual', max: 30, value: Math.round(rainNow * 30), ok: w.ok });
  const fc = w.ok ? clamp((w.rainNext24h || 0) / (t3 * 3)) * clamp((w.maxProbability24h ?? 100) / 100 + 0.3) : 0;
  parts.push({ key: 'pronostico', label: 'Pronóstico 24 h', max: 25, value: Math.round(fc * 25), ok: w.ok });
  const sevScore = { EXTREME: 1, SEVERE: 0.75, ABOVE_NORMAL: 0.4 };
  // Ríos: Google Flood si está activo; si no, el estado que el equipo marca en cada río del mapa.
  const local = Math.max(0, ...rivers.map(r => ({ desbordado: 1, crecido: 0.6 })[r.status] || 0));
  const river = Math.max(local, flood?.ok ? Math.max(0, ...(flood.gauges || []).map(g => sevScore[g.severity] || 0)) : 0);
  parts.push({ key: 'rios', label: 'Ríos', max: 20, value: Math.round(river * 20), ok: !!flood?.ok || rivers.length > 0 });
  // Los reportes ciudadanos ya no cambian el clima ni el semáforo: sirven para marcar calles (puntos críticos de nivel medio).
  const tideV = tide?.ok ? clamp((tide.relative - 0.5) * 2) : 0;
  parts.push({ key: 'marea', label: 'Marea', max: 10, value: Math.round(tideV * 10), ok: !!tide?.ok });
  const value = parts.reduce((s, p) => s + p.value, 0);
  // Umbrales pensados para que una sola señal (por ejemplo, solo el pronóstico de 24 h, máx. 25) no encienda la amarilla.
  return { value, parts, level: value >= 70 ? 'roja' : value >= 50 ? 'naranja' : value >= 30 ? 'amarilla' : 'normal' };
}

// Nivel sugerido por el clima: normal | amarilla | naranja | roja
export function levelFromWeather(w, cfg) { return levelWhy(w, cfg).level; }
// El mismo cálculo, con el motivo en palabras (se muestra en el mapa para que se entienda por qué está en ese color)
const mmTxt = x => `${String(Math.round(x * 10) / 10).replace('.', ',')} mm`;
export function levelWhy(w, cfg) {
  if (!w.ok) return { level: 'normal', why: '' };
  const t = +cfg.rainThresholdMm || 2.4, t3 = +cfg.rainThresholdMm3h || 7, i = Math.min(3, w.intensity || 0);
  // Lo que inunda las calles no es solo la intensidad de ahora, sino cuánta agua cayó y por cuánto tiempo:
  // 6 h y 12 h de lluvia acumulada y horas seguidas lloviendo.
  const p3 = w.rainPast3h || 0, p6 = w.rainPast6h || 0, p12 = w.rainPast12h || 0, wet = w.wetHours || 0, now = w.rainNow || 0;
  const it = ['', 'lluvia leve', 'lluvia moderada', 'lluvia fuerte'][i];
  // Los acumulados solo cuentan mientras sigue lloviendo: cuando para, el semáforo baja de a un color (stepDown en index.js).
  // Sin lluvia medida no hay color: el pronóstico ya no sube el semáforo (solo valores reales, 27-nov-2026); queda como aviso
  if (!i) return { level: 'normal', why: '' };
  // Roja: aguacero fuerte ahora, o lluvia moderada/fuerte sobre mucha agua acumulada. Con lluvia leve ya no se queda en roja
  // por lo que cayó antes: baja a naranja (de a un color cada 45 min) aunque siga lloviznando.
  if (now >= t * 3) return { level: 'roja', why: `${it} de ${mmTxt(now)}/h` };
  if (i >= 2 && (p3 >= t3 * 2 || p6 >= t3 * 3 || p12 >= t3 * 5)) return { level: 'roja', why: `${it} con ${mmTxt(p3 >= t3 * 2 ? p3 : p6 >= t3 * 3 ? p6 : p12)} acumulados en ${p3 >= t3 * 2 ? 3 : p6 >= t3 * 3 ? 6 : 12} h` };
  if (now >= t || i >= 3) return { level: 'naranja', why: `${it} de ${mmTxt(now)}/h` };
  if (p3 >= t3 || p6 >= t3 * 1.6 || p12 >= t3 * 2.7) return { level: 'naranja', why: `sigue la ${it} con ${mmTxt(p3 >= t3 ? p3 : p6 >= t3 * 1.6 ? p6 : p12)} acumulados en ${p3 >= t3 ? 3 : p6 >= t3 * 1.6 ? 6 : 12} h` };
  if (wet >= 3 && p6 >= t3 * 0.9) return { level: 'naranja', why: `${wet} h seguidas lloviendo (${mmTxt(p6)} en 6 h)` };
  if (p3 >= t3 * 0.6 && now >= t / 2) return { level: 'naranja', why: `${it} con ${mmTxt(p3)} en las últimas 3 h` };
  return { level: 'amarilla', why: `${it} en curso` };
}

// Pronóstico por días: ayer (dato ya ocurrido), hoy y los 2 días siguientes. Una sola consulta a Open-Meteo,
// guardada 30 min; si falla se sigue mostrando el último dato bueno.
let daysCache = { at: 0, key: '', data: null };
const WMO_TXT = { 0: 'Despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado', 45: 'Neblina', 48: 'Neblina', 51: 'Llovizna', 53: 'Llovizna', 55: 'Llovizna intensa',
  56: 'Llovizna', 57: 'Llovizna', 61: 'Lluvia leve', 63: 'Lluvia moderada', 65: 'Lluvia fuerte', 66: 'Lluvia leve', 67: 'Lluvia fuerte', 80: 'Chubascos leves', 81: 'Chubascos', 82: 'Chubascos fuertes',
  95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta con granizo' };
// Respaldo: MET Norway (yr.no) agrupado por día local (Ecuador, UTC-5). No trae ayer.
async function daysFromMetno({ lat, lng }) {
  let res;
  try { res = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${(+lat).toFixed(4)}&lon=${(+lng).toFixed(4)}`, { signal: AbortSignal.timeout(9000), headers: METNO_UA }); }
  catch { throw new Error('sin conexión'); }
  if (!res.ok) throw new Error(`respondió con error ${res.status}`);
  const ts = (await res.json())?.properties?.timeseries || [];
  const byDay = new Map();
  for (const x of ts) {
    const d = new Date(new Date(x.time).getTime() - 5 * 3600e3), date = d.toISOString().slice(0, 10), hr = d.getUTCHours();
    const o = byDay.get(date) || { date, t: [], mm: 0, prob: null, sym: '', symHr: 99 };
    const det = x.data?.instant?.details || {};
    if (det.air_temperature != null) o.t.push(det.air_temperature);
    const n1 = x.data?.next_1_hours, n6 = x.data?.next_6_hours;
    // lluvia: por hora mientras haya; si no, por bloques de 6 h (solo en horas 0, 6, 12, 18 para no repetir)
    if (n1) o.mm += n1.details?.precipitation_amount ?? 0; else if (n6 && hr % 6 === 0) o.mm += n6.details?.precipitation_amount ?? 0;
    const pr = (n1 || n6)?.details?.probability_of_precipitation; if (pr != null) o.prob = Math.max(o.prob ?? 0, pr);
    const sym = (n6 || n1)?.summary?.symbol_code; if (sym && Math.abs(hr - 13) < o.symHr) { o.sym = sym; o.symHr = Math.abs(hr - 13); }
    byDay.set(date, o);
  }
  const dates = [...byDay.keys()].sort();
  const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
  const mk = (date, rel) => { const o = byDay.get(date); if (!o) return { date, rel, na: true, text: '' };
    const code = METNO_CODE(o.sym); return { date, rel, code, text: WMO_TXT[code] || '', tMax: o.t.length ? Math.max(...o.t) : null, tMin: o.t.length ? Math.min(...o.t) : null, mm: r1(o.mm), prob: o.prob, partial: date === dates[0] }; };
  const day = k => new Date(new Date(today + 'T12:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);
  return [mk(day(-1), -1), mk(day(0), 0), mk(day(1), 1), mk(day(2), 2)];
}
export { INT_TXT, WMO_TXT };
// Ayer desde el archivo de pronósticos de Open-Meteo (otro servidor que el de pronóstico; puede responder aunque aquel limite)
export async function yesterdayFromArchive({ lat, lng }, date) {
  const url = new URL('https://historical-forecast-api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: lat, longitude: lng, timezone: 'America/Guayaquil', start_date: date, end_date: date,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum' });
  const D = (await getJson(url, 8000)).daily || {};
  if (!D.time?.length || D.temperature_2m_max?.[0] == null) throw new Error('sin datos');
  return { date, rel: -1, code: D.weather_code?.[0], text: WMO_TXT[D.weather_code?.[0]] || '', tMax: D.temperature_2m_max[0], tMin: D.temperature_2m_min?.[0], mm: r1(D.precipitation_sum?.[0]) };
}
export async function getDays({ lat, lng }) {
  const key = `${lat},${lng}`;
  if (daysCache.data && daysCache.key === key && Date.now() - daysCache.at < 30 * 60 * 1000) return daysCache.data;
  const errs = [];
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: lat, longitude: lng, timezone: 'America/Guayaquil', past_days: 1, forecast_days: 3,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,precipitation_hours' });
    const j = await getJson(url);
    const D = j.daily || {}, t = D.time || [];
    if (t.length < 3) throw new Error('respuesta incompleta');
    const days = t.map((date, i) => ({ date, rel: i - 1, code: D.weather_code?.[i], text: WMO_TXT[D.weather_code?.[i]] || '',
      tMax: D.temperature_2m_max?.[i], tMin: D.temperature_2m_min?.[i], mm: r1(D.precipitation_sum?.[i]),
      prob: D.precipitation_probability_max?.[i] ?? null, hours: D.precipitation_hours?.[i] ?? null }));
    daysCache = { at: Date.now(), key, data: { ok: true, source: 'Open-Meteo', days } };
    return daysCache.data;
  } catch (e) { errs.push(`Open-Meteo: ${e.message}`); }
  try {
    const days = await daysFromMetno({ lat, lng });
    daysCache = { at: Date.now() - 20 * 60 * 1000, key, data: { ok: true, source: 'MET Norway (yr.no)', days } }; // se reintenta Open-Meteo en 10 min
    return daysCache.data;
  } catch (e) { errs.push(`MET Norway: ${e.message}`); }
  if (daysCache.data && daysCache.key === key) return { ...daysCache.data, stale: true };
  return { ok: false, error: errs.join(' · '), days: [] };
}
