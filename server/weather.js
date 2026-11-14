// Clima de varias fuentes, porque un solo pronóstico no ve los aguaceros locales de la costa:
//  · Open-Meteo con 8 modelos meteorológicos distintos (pronóstico; se pide que al menos 2 coincidan)
//  · Estación del aeropuerto de Santa Rosa (METAR SERO, NOAA): observación real, cuando el aeropuerto reporta
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
const mmInt = mm => (mm >= 8 ? 3 : mm >= 2.5 ? 2 : mm >= 0.2 ? 1 : 0);
const INT_MM = [0, 1, 4, 10, 20]; // lluvia típica (mm/h) para una intensidad observada sin medición
const INT_TXT = ['Sin lluvia', 'Lluvia leve', 'Lluvia moderada', 'Lluvia fuerte', 'Tormenta eléctrica'];
const INT_CODE = [0, 61, 63, 65, 95];

async function getJson(url, ms = 8000) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: UA }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? 'no respondió a tiempo' : 'sin conexión'); }
  if (!res.ok) throw new Error(res.status === 401 ? 'API key no válida' : res.status === 429 ? 'demasiadas consultas, reintenta luego' : `respondió con error ${res.status}`);
  return res.json();
}

// Un modelo de Open-Meteo (pedidos por separado: si uno falla, los demás siguen)
async function openMeteoModel(model, lat, lng) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  const q = { latitude: lat, longitude: lng, current: 'precipitation,rain,showers,temperature_2m,weather_code,cloud_cover',
    hourly: 'precipitation,precipitation_probability', past_hours: 3, forecast_hours: 24, timezone: 'America/Guayaquil' };
  if (model !== 'best_match') q.models = model;
  url.search = new URLSearchParams(q);
  const j = await getJson(url);
  const H = j.hourly || {}, times = H.time || [];
  const hours = times.map((t, i) => ({ time: t, precipitation: H.precipitation?.[i] ?? null, probability: H.precipitation_probability?.[i] ?? null }));
  if (!hours.length || hours.every(h => h.precipitation == null)) throw new Error('sin datos para este punto');
  const nowIdx = Math.max(0, hours.findIndex(h => h.time.slice(0, 13) === String(j.current?.time || '').slice(0, 13)));
  const sum = arr => r1(arr.reduce((s, h) => s + (h.precipitation || 0), 0));
  // "current" suele ser la suma de los últimos 15 min: se pasa a mm/h para compararla con la hora.
  const k = 3600 / (j.current?.interval || 900);
  const cur = Math.max(j.current?.precipitation ?? 0, (j.current?.rain ?? 0) + (j.current?.showers ?? 0)) * k;
  const rainNow = r1(Math.max(cur, hours[nowIdx]?.precipitation ?? 0));
  const [codeInt] = CODE[j.current?.weather_code] || [0];
  return { model, name: MODELS[model], ok: true, observedAt: j.current?.time, temperature: j.current?.temperature_2m, cloudCover: j.current?.cloud_cover,
    weatherCode: j.current?.weather_code, rainNow, intensity: Math.max(codeInt, mmInt(rainNow)),
    rainPast3h: sum(hours.slice(Math.max(0, nowIdx - 3), nowIdx + 1)), rainNext3h: sum(hours.slice(nowIdx + 1, nowIdx + 4)),
    rainNext24h: sum(hours.slice(nowIdx + 1, nowIdx + 25)),
    probNext3h: hours.some(h => h.probability != null) ? Math.max(0, ...hours.slice(nowIdx, nowIdx + 4).map(h => h.probability || 0)) : null,
    maxProbability24h: hours.some(h => h.probability != null) ? Math.max(0, ...hours.slice(nowIdx + 1, nowIdx + 25).map(h => h.probability || 0)) : null,
    hourly: hours.slice(nowIdx, nowIdx + 12) };
}

// METAR: reporte del aeropuerto. Ej. "SERO 142300Z 24005KT 3000 +TSRA BKN010CB 24/23 Q1010"
export function parseMetar(raw) {
  const body = String(raw || '').split(/\sRMK\s/)[0];
  let intensity = 0, near = false, txt = '';
  for (const t of body.split(/\s+/)) {
    const m = t.match(/^(\+|-|VC)?(TS|SH)?((?:DZ|RA|GR|GS|UP)*)$/);
    if (!m || (!m[2] && !m[3])) continue;
    if (m[1] === 'VC') { near = true; continue; }
    const ts = m[2] === 'TS', rain = /RA|DZ|GR|GS|UP/.test(m[3]);
    let i = ts ? (rain ? 4 : 3) : /RA|GR|GS|UP/.test(m[3]) ? 2 : /DZ/.test(m[3]) ? 1 : 0;
    if (!ts && m[1] === '-') i = Math.max(1, i - 1);
    if (!ts && m[1] === '+') i = 3;
    if (i > intensity) { intensity = i; txt = ts ? (rain ? 'Tormenta con lluvia' : 'Tormenta eléctrica') : `${m[1] === '+' ? 'Lluvia fuerte' : m[1] === '-' ? 'Lluvia leve' : /DZ/.test(m[3]) && !/RA/.test(m[3]) ? 'Llovizna' : 'Lluvia'}${m[2] === 'SH' ? ' (chubasco)' : ''}`; }
  }
  // VC = lluvia a menos de ~16 km del aeropuerto, que puede estar cayendo sobre la ciudad: cuenta como leve.
  if (!intensity && near) return { intensity: 1, near, text: 'Lluvia en los alrededores' };
  return { intensity, near, text: txt || 'Sin lluvia' };
}
async function metarSource(station) {
  if (metarCache.data && Date.now() - metarCache.at < TTL) return metarCache.data;
  const base = { id: 'metar', kind: 'observación', name: `Aeropuerto Santa Rosa (${station})` };
  let d;
  try {
    const j = await getJson(`https://aviationweather.gov/api/data/metar?ids=${station}&format=json&hours=3`);
    const last = (Array.isArray(j) ? j : []).map(x => ({ raw: x.rawOb || '', at: x.obsTime ? new Date(x.obsTime * 1000) : new Date(x.reportTime || 0) }))
      .filter(x => x.raw).sort((a, b) => b.at - a.at)[0];
    if (!last) throw new Error('el aeropuerto no envió reportes en las últimas 3 h');
    const ageMin = Math.round((Date.now() - last.at) / 60000), p = parseMetar(last.raw);
    const fresh = ageMin <= 90;
    d = { ...base, ok: fresh, stale: !fresh, at: last.at.toISOString(), ageMin, raw: last.raw, intensity: fresh ? p.intensity : 0, rainNow: fresh ? INT_MM[p.intensity] : 0,
      detail: `${p.text} · reporte de hace ${ageMin} min`, error: fresh ? undefined : `último reporte hace ${ageMin} min` };
  } catch (e) { d = { ...base, ok: false, intensity: 0, error: e.message }; }
  metarCache = { at: Date.now(), data: d };
  return d;
}

// OpenWeatherMap (opcional): solo si hay API key
async function owmSource(lat, lng, key) {
  const base = { id: 'owm', kind: 'observación', name: 'OpenWeatherMap' };
  if (!key) return { ...base, ok: false, disabled: true, intensity: 0, error: 'sin API key' };
  const ck = `${lat},${lng},${key}`;
  if (owmCache.data && owmCache.key === ck && Date.now() - owmCache.at < TTL) return owmCache.data;
  let d;
  try {
    const j = await getJson(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${encodeURIComponent(key)}&units=metric&lang=es`);
    const id = j.weather?.[0]?.id || 800, mm = r1(j.rain?.['1h'] ?? (j.rain?.['3h'] ? j.rain['3h'] / 3 : 0));
    const codeInt = id >= 200 && id < 300 ? 4 : id >= 300 && id < 400 ? 1 : [500, 520].includes(id) ? 1 : [501, 521, 511].includes(id) ? 2 : id >= 502 && id < 600 ? 3 : 0;
    const intensity = Math.max(codeInt, mmInt(mm));
    d = { ...base, ok: true, at: new Date((j.dt || Date.now() / 1000) * 1000).toISOString(), intensity, rainNow: Math.max(mm, intensity ? INT_MM[intensity] / 2 : 0),
      temperature: j.main?.temp, cloudCover: j.clouds?.all, detail: `${j.weather?.[0]?.description || ''}${mm ? ` · ${mm} mm/h` : ''}` };
  } catch (e) { d = { ...base, ok: false, intensity: 0, error: e.message }; }
  owmCache = { at: Date.now(), key: ck, data: d };
  return d;
}

// Combina modelos y observaciones. `extra` son fuentes locales (equipo, reportes) que arma el servidor.
export async function getWeather({ lat, lng, metarStation = 'SERO', owmKey = '' } = {}, extra = []) {
  const key = `${lat},${lng},${metarStation},${owmKey ? 1 : 0}`;
  let remote;
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL) remote = cache.data;
  else {
    const [models, metar, owm] = await Promise.all([
      Promise.all(Object.keys(MODELS).map(m => openMeteoModel(m, lat, lng).catch(e => ({ model: m, name: MODELS[m], ok: false, error: e.message, intensity: 0 })))),
      metarStation ? metarSource(metarStation) : Promise.resolve(null),
      owmSource(lat, lng, owmKey),
    ]);
    remote = { models, metar, owm, at: new Date().toISOString() };
    cache = { at: Date.now(), key, data: remote };
  }
  return combine(remote, extra);
}

export function combine({ models, metar, owm, at }, extra = []) {
  const okM = models.filter(m => m.ok), base = okM.find(m => m.model === 'best_match') || okM[0];
  // Modelos: se toma el segundo valor más alto (al menos 2 modelos de acuerdo) para no alarmar por un solo modelo.
  const second = arr => { const v = arr.slice().sort((a, b) => b - a); return v.length >= 3 ? v[1] : v[0] ?? 0; };
  const mInt = second(okM.map(m => m.intensity)), mRain = r1(second(okM.map(m => m.rainNow)));
  const raining = okM.filter(m => m.intensity > 0);
  const modelSrc = { id: 'modelos', kind: 'pronóstico', name: `Open-Meteo · ${okM.length} de ${models.length} modelos`, ok: okM.length > 0,
    at: base?.observedAt, intensity: mInt, rainNow: mRain,
    detail: okM.length ? (raining.length ? `${raining.length} de ${okM.length} modelos ven lluvia (${raining.map(m => m.name).join(', ')})` : 'Ningún modelo ve lluvia en esta hora') : 'Sin conexión con Open-Meteo',
    error: okM.length ? undefined : models[0]?.error, models: models.map(m => ({ name: m.name, ok: m.ok, rainNow: m.rainNow ?? 0, intensity: m.intensity || 0, error: m.error })) };
  const sources = [modelSrc, metar, owm, ...extra].filter(Boolean);
  const live = sources.filter(s => s.ok);
  if (!live.length) return { ok: false, source: 'Open-Meteo', error: modelSrc.error || 'sin conexión', rainNow: 0, rainPast3h: 0, rainNext3h: 0, rainNext24h: 0, hourly: [], sources, checkedAt: at };
  const top = live.reduce((a, s) => (s.intensity > a.intensity || (s.intensity === a.intensity && (s.rainNow || 0) > (a.rainNow || 0)) ? s : a), live[0]);
  const intensity = top.intensity || 0;
  const pickMax = k => r1(second(okM.map(m => m[k] || 0)));
  const w = {
    ok: true, sources, checkedAt: at,
    decidedBy: intensity > 0 ? top.name : null,
    source: live.map(s => s.id === 'modelos' ? `Open-Meteo (${okM.length} modelos)` : s.name).join(' + '),
    observedAt: (intensity > 0 ? top.at : base?.observedAt) || at,
    temperature: base?.temperature ?? owm?.temperature, cloudCover: Math.max(base?.cloudCover ?? 0, owm?.cloudCover ?? 0, intensity ? 95 : 0),
    rainNow: r1(Math.max(...live.map(s => s.rainNow || 0))),
    rainPast3h: Math.max(pickMax('rainPast3h'), intensity >= 2 ? INT_MM[intensity] : 0),
    rainNext3h: pickMax('rainNext3h'), rainNext24h: pickMax('rainNext24h'),
    probNext3h: base?.probNext3h ?? null, maxProbability24h: base?.maxProbability24h ?? null,
    weatherCode: intensity > (CODE[base?.weatherCode]?.[0] || 0) ? INT_CODE[intensity] : base?.weatherCode,
    hourly: base?.hourly || [],
  };
  Object.assign(w, describe(w));
  if (intensity > w.intensity) Object.assign(w, { intensity, raining: true, condition: INT_TXT[intensity] });
  return w;
}

// Fuentes locales: lo que marca el equipo y los reportes ciudadanos de la última hora
export function localSources({ observed, reports = [] }) {
  const out = [];
  if (observed && new Date(observed.until) > Date.now()) {
    const i = Math.max(0, Math.min(4, +observed.intensity || 0));
    out.push({ id: 'equipo', kind: 'observación', name: 'Equipo EMOVTT', ok: true, at: observed.at, intensity: i, rainNow: INT_MM[i],
      detail: `${INT_TXT[i]} marcada en el panel · vigente hasta ${new Date(observed.until).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil', hourCycle: 'h23' })}` });
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
  80: [1, 'Chubascos leves'], 81: [2, 'Chubascos moderados'], 82: [3, 'Chubascos fuertes'], 95: [4, 'Tormenta eléctrica'], 96: [4, 'Tormenta con granizo'], 99: [4, 'Tormenta con granizo'] };
export function describe(w) {
  const [codeInt, codeTxt] = CODE[w.weatherCode] || [0, ''];
  const mmInt = w.rainNow >= 8 ? 3 : w.rainNow >= 2.5 ? 2 : w.rainNow > 0 ? 1 : 0;
  const intensity = Math.max(codeInt, mmInt);
  const condition = codeTxt || (mmInt === 3 ? 'Lluvia fuerte' : mmInt === 2 ? 'Lluvia moderada' : mmInt === 1 ? 'Lluvia leve'
    : w.probNext3h >= 60 ? 'Lluvia probable' : (w.cloudCover ?? 0) >= 70 ? 'Nublado' : (w.cloudCover ?? 0) >= 30 ? 'Parcialmente nublado' : 'Despejado');
  return { raining: intensity > 0, intensity, condition };
}

// Marea (nivel del mar) desde Open-Meteo Marine. Útil en ciudades costeras como Santa Rosa (El Oro).
// Devuelve qué tan alta está la marea ahora respecto al rango de las próximas 24 h (0 = bajamar, 1 = pleamar).
export async function getTide({ lat, lng }) {
  const key = `${lat},${lng}`;
  if (tideCache.data && tideCache.key === key && Date.now() - tideCache.at < TTL * 3) return tideCache.data;
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
  const t = cfg.rainThresholdMm || 5, t3 = cfg.rainThresholdMm3h || 15;
  const clamp = x => Math.max(0, Math.min(1, x));
  const parts = [];
  const rainNow = w.ok ? clamp(Math.max(w.rainNow / (t * 3), w.rainPast3h / (t3 * 2), [0, 0.25, 0.5, 0.8, 1][w.intensity || 0])) : 0;
  parts.push({ key: 'lluvia', label: 'Lluvia actual', max: 30, value: Math.round(rainNow * 30), ok: w.ok });
  const fc = w.ok ? clamp((w.rainNext24h || 0) / (t3 * 3)) * clamp((w.maxProbability24h ?? 100) / 100 + 0.3) : 0;
  parts.push({ key: 'pronostico', label: 'Pronóstico 24 h', max: 25, value: Math.round(fc * 25), ok: w.ok });
  const sevScore = { EXTREME: 1, SEVERE: 0.75, ABOVE_NORMAL: 0.4 };
  // Ríos: Google Flood si está activo; si no, el estado que el equipo marca en cada río del mapa.
  const local = Math.max(0, ...rivers.map(r => ({ desbordado: 1, crecido: 0.6 })[r.status] || 0));
  const river = Math.max(local, flood?.ok ? Math.max(0, ...(flood.gauges || []).map(g => sevScore[g.severity] || 0)) : 0);
  parts.push({ key: 'rios', label: 'Ríos', max: 20, value: Math.round(river * 20), ok: !!flood?.ok || rivers.length > 0 });
  const recent = reports.filter(r => r.status !== 'descartado' && Date.now() - new Date(r.createdAt) < 3 * 3600e3);
  const rep = clamp(recent.reduce((s, r) => s + ({ leve: 0.15, moderado: 0.3, grave: 0.5 }[r.level] || 0.2) * (r.status === 'verificado' ? 1.5 : 1), 0));
  parts.push({ key: 'reportes', label: 'Reportes (3 h)', max: 15, value: Math.round(rep * 15), ok: true });
  const tideV = tide?.ok ? clamp((tide.relative - 0.5) * 2) : 0;
  parts.push({ key: 'marea', label: 'Marea', max: 10, value: Math.round(tideV * 10), ok: !!tide?.ok });
  const value = parts.reduce((s, p) => s + p.value, 0);
  return { value, parts, level: value >= 70 ? 'roja' : value >= 45 ? 'naranja' : value >= 20 ? 'amarilla' : 'normal' };
}

// Nivel sugerido por el clima: normal | amarilla | naranja | roja
export function levelFromWeather(w, cfg) {
  if (!w.ok) return 'normal';
  const t = cfg.rainThresholdMm, t3 = cfg.rainThresholdMm3h, i = w.intensity || 0;
  if (w.rainNow >= t * 3 || w.rainPast3h >= t3 * 2 || (i >= 4 && w.rainNow >= t)) return 'roja';
  if (w.rainNow >= t || w.rainPast3h >= t3 || i >= 3) return 'naranja';
  // Cualquier lluvia en curso (aunque sea llovizna) o lluvia muy probable en las próximas horas: amarilla.
  if (i >= 1 || w.rainNow > 0 || w.rainNext3h >= t / 2 || (w.probNext3h ?? 0) >= 70) return 'amarilla';
  return 'normal';
}
