// Clima de varias fuentes, porque un solo pronóstico no ve los aguaceros locales de la costa:
//  · Open-Meteo con 8 modelos meteorológicos (una sola consulta) + MET Norway (yr.no): pronósticos; un tercio tiene que coincidir
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
// Lluvia medible: menos de 0,5 mm/h es "ruido" de los modelos (garúa de la costa que no moja la calle).
const MIN_MM = 0.5;
const mmInt = mm => (mm >= 8 ? 3 : mm >= 2.5 ? 2 : mm >= MIN_MM ? 1 : 0);
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
    current: 'precipitation,rain,showers,temperature_2m,weather_code,cloud_cover,is_day,uv_index,shortwave_radiation',
    daily: 'uv_index_max,sunrise,sunset', hourly: 'precipitation,precipitation_probability,cape',
    past_hours: 3, forecast_hours: 24, timezone: 'America/Guayaquil', ...(models ? { models } : {}) });
  return url;
}
// Saca los datos de un modelo de la respuesta (sufijo = respuesta con varios modelos)
function omParse(model, j, sfx) {
  const g = (o, k) => (sfx ? o?.[`${k}_${model}`] : o?.[k]);
  const H = j.hourly || {}, times = H.time || [];
  const P = g(H, 'precipitation') || [], PP = g(H, 'precipitation_probability') || [], CP = g(H, 'cape') || [];
  const hours = times.map((t, i) => ({ time: t, precipitation: P[i] ?? null, probability: PP[i] ?? null, cape: CP[i] ?? null }));
  if (!hours.length || hours.every(h => h.precipitation == null)) return { model, name: MODELS[model], ok: false, error: 'sin datos para este punto', intensity: 0 };
  const cur = j.current || {}, useCur = model === 'best_match' || !sfx; // "current" es del mejor modelo
  const nowIdx = Math.max(0, hours.findIndex(h => h.time.slice(0, 13) === String(cur.time || '').slice(0, 13)));
  const sum = arr => r1(arr.reduce((s, h) => s + (h.precipitation || 0), 0));
  // "current" suele ser la suma de los últimos 15 min: se pasa a mm/h para compararla con la hora.
  const k = 3600 / (cur.interval || 900);
  const curMm = useCur ? Math.max(cur.precipitation ?? 0, (cur.rain ?? 0) + (cur.showers ?? 0)) * k : 0;
  const rainNow = r1(Math.max(curMm, hours[nowIdx]?.precipitation ?? 0));
  // El código del cielo solo cuenta si viene con lluvia medible: un "llovizna" con 0 mm no es lluvia.
  // Tormenta (95–99) con al menos 1 mm/h sí se toma como tormenta.
  const code = useCur ? cur.weather_code : undefined, storm = code >= 95 && rainNow >= 1;
  const D = j.daily || {};
  // Sol: si es de día, índice UV (OMS), radiación solar en W/m² y horas de salida y puesta del sol
  const sun = useCur ? { isDay: cur.is_day ?? null, uvIndex: cur.uv_index ?? null, radiation: cur.shortwave_radiation ?? null,
    uvMax: g(D, 'uv_index_max')?.[0] ?? null, sunrise: g(D, 'sunrise')?.[0] ?? null, sunset: g(D, 'sunset')?.[0] ?? null } : null;
  return { model, name: MODELS[model], ok: true, observedAt: cur.time, temperature: useCur ? cur.temperature_2m : undefined, cloudCover: useCur ? cur.cloud_cover : undefined, sun,
    weatherCode: code, rainNow, intensity: storm ? 4 : mmInt(rainNow),
    rainPast3h: sum(hours.slice(Math.max(0, nowIdx - 3), nowIdx + 1)), rainNext3h: sum(hours.slice(nowIdx + 1, nowIdx + 4)),
    rainNext24h: sum(hours.slice(nowIdx + 1, nowIdx + 25)),
    probNext3h: hours.some(h => h.probability != null) ? Math.max(0, ...hours.slice(nowIdx, nowIdx + 4).map(h => h.probability || 0)) : null,
    maxProbability24h: hours.some(h => h.probability != null) ? Math.max(0, ...hours.slice(nowIdx + 1, nowIdx + 25).map(h => h.probability || 0)) : null,
    // CAPE: energía del aire para formar nubes de tormenta (J/kg). Más de ~1000 en la costa = aguaceros posibles
    capeMax6h: hours.slice(nowIdx, nowIdx + 7).reduce((m, h) => (h.cape != null && h.cape > (m ?? -1) ? h.cape : m), null),
    hourly: hours.slice(nowIdx, nowIdx + 25).map(({ cape, ...h }) => h) };
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
  if (now < om.blockedUntil && om.key === key) return fail(om.error);
  let models;
  try {
    const j = await getJson(omQuery(lat, lng, ids.join(',')), 10000);
    models = ids.map(m => omParse(m, j, true));
  } catch (e) {
    if (/demasiadas consultas/.test(e.message)) { om = { ...om, key, models: null, blockedUntil: now + OM_BLOCK, error: e.message }; return fail(e.message); }
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
    const rainNow = r1(mm(0)), code = METNO_CODE(sym), storm = code >= 95 && rainNow >= 1;
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
      temperature: det.air_temperature, cloudCover: cloud == null ? undefined : Math.round(cloud), weatherCode: code, rainNow, intensity: storm ? 4 : mmInt(rainNow),
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
    const ts = m[2] === 'TS', rain = /RA|DZ|GR|GS|UP/.test(m[3]);
    let i = ts ? (rain ? 4 : 3) : /RA|GR|GS|UP/.test(m[3]) ? 2 : /DZ/.test(m[3]) ? 1 : 0;
    if (!ts && m[1] === '-') i = Math.max(1, i - 1);
    if (!ts && m[1] === '+') i = 3;
    if (i > intensity) { intensity = i; txt = ts ? (rain ? 'Tormenta con lluvia' : 'Tormenta eléctrica') : `${m[1] === '+' ? 'Lluvia fuerte' : m[1] === '-' ? 'Lluvia leve' : /DZ/.test(m[3]) && !/RA/.test(m[3]) ? 'Llovizna' : 'Lluvia'}${m[2] === 'SH' ? ' (chubasco)' : ''}`; }
  }
  // VC = lluvia a 8–16 km del aeropuerto, no sobre él: se informa pero no sube el semáforo.
  if (!intensity && near) return { intensity: 0, near, text: 'Lluvia en los alrededores (no sobre el aeropuerto)' };
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
      near: fresh && !!p.near, cb: fresh && /\b(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)\b/.test(last.raw), ts: fresh && /\b(VC)?TS/.test(last.raw.replace(/^\S+\s+\S+\s+/, '')),
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
    // Llovizna/lluvia leve sin milímetros no cuenta (mismo criterio que los modelos)
    const codeInt = id >= 200 && id < 300 ? 4 : [501, 521, 511].includes(id) ? 2 : id >= 502 && id < 600 ? 3 : 0;
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
    const [omModels, metno, metar, owm] = await Promise.all([
      openMeteoAll(lat, lng).catch(e => Object.keys(MODELS).map(m => ({ model: m, name: MODELS[m], ok: false, error: e.message, intensity: 0 }))),
      metnoSource(lat, lng),
      metarStation ? metarSource(metarStation) : Promise.resolve(null),
      owmSource(lat, lng, owmKey),
    ]);
    remote = { models: [...omModels, metno], metar, owm, at: new Date().toISOString() };
    cache = { at: Date.now(), key, data: remote };
  }
  return combine(remote, extra);
}

export function combine({ models, metar, owm, at }, extra = []) {
  const okM = models.filter(m => m.ok), base = okM.find(m => m.model === 'best_match') || okM.find(m => m.model === 'met_no') || okM[0];
  // Como Amaru: las señales tienen que coincidir. Un modelo solo no basta: hace falta que al menos
  // un tercio de los modelos (3 de 9) vean lluvia medible. Y si el mejor modelo dice cielo casi despejado, los modelos no cuentan.
  const need = Math.max(2, Math.ceil(okM.length / 3));
  const kth = arr => { const v = arr.slice().sort((x, y) => y - x); return v.length >= need ? v[need - 1] : 0; };
  const clear = (base?.cloudCover ?? 100) < 50;
  const raining = okM.filter(m => m.intensity > 0);
  const mInt = clear ? 0 : kth(okM.map(m => m.intensity)), mRain = mInt ? r1(kth(okM.map(m => m.rainNow))) : 0;
  const omOk = okM.filter(m => m.model !== 'met_no').length, stale = okM.find(m => m.stale);
  const provs = [omOk && 'Open-Meteo', okM.some(m => m.model === 'met_no') && 'MET Norway'].filter(Boolean).join(' + ') || 'Open-Meteo + MET Norway';
  const modelSrc = { id: 'modelos', kind: 'pronóstico', name: `${provs} · ${okM.length} de ${models.length} modelos`, ok: okM.length > 0,
    at: base?.observedAt, intensity: mInt, rainNow: mRain,
    detail: !okM.length ? `Sin conexión con los pronósticos (${[...new Set(models.map(m => m.error).filter(Boolean))].join(' · ')})`
      : `${stale ? `Dato de Open-Meteo de hace ${stale.staleMin} min (${stale.staleWhy}) · ` : ''}${raining.length} de ${okM.length} modelos ven lluvia medible${raining.length ? ` (${raining.map(m => m.name).join(', ')})` : ''}; hacen falta ${need}${clear && raining.length ? ' · no cuenta: el cielo está casi despejado' : ''} · nubosidad ${base?.cloudCover ?? '—'} %`,
    error: okM.length ? undefined : models[0]?.error, models: models.map(m => ({ name: m.name, ok: m.ok, rainNow: m.rainNow ?? 0, intensity: m.intensity || 0, error: m.error, stale: m.stale ? m.staleMin : undefined })) };
  const sources = [modelSrc, metar, owm, ...extra].filter(Boolean);
  const live = sources.filter(s => s.ok);
  if (!live.length) return { ok: false, source: 'Open-Meteo', error: modelSrc.error || 'sin conexión', rainNow: 0, rainPast3h: 0, rainNext3h: 0, rainNext24h: 0, hourly: [], sources, checkedAt: at };
  // Entre fuentes gana la que vea la lluvia más fuerte (cada una ya es confiable por sí sola: observación o consenso de modelos)
  const top = live.reduce((x, s) => (s.intensity > x.intensity || (s.intensity === x.intensity && (s.rainNow || 0) > (x.rainNow || 0)) ? s : x), live[0]);
  const intensity = top.intensity || 0;
  // Milímetros de las últimas/próximas horas: el valor en que coinciden los modelos; si responden muy pocos, el mayor de ellos
  const pick = k => { const v = okM.map(m => m[k] || 0); return r1(v.length >= need ? kth(v) : Math.max(0, ...v)); };
  const baseCode = base?.weatherCode ?? 0, baseRainy = baseCode >= 50; // códigos de lluvia del modelo
  const w = {
    ok: true, sources, checkedAt: at, modelsNeeded: need,
    decidedBy: intensity > 0 ? top.name : null,
    source: live.map(s => s.id === 'modelos' ? `${provs} (${okM.length} modelos)` : s.name).join(' + '),
    observedAt: (intensity > 0 ? top.at : base?.observedAt) || at,
    temperature: base?.temperature ?? okM.find(m => m.temperature != null)?.temperature ?? owm?.temperature, cloudCover: Math.max(base?.cloudCover ?? 0, owm?.cloudCover ?? 0, intensity ? 95 : 0),
    rainNow: intensity ? r1(Math.max(...live.map(s => (s.intensity ? s.rainNow || 0 : 0)))) : 0,
    rainPast3h: Math.max(pick('rainPast3h'), intensity >= 2 ? INT_MM[intensity] : 0),
    rainNext3h: pick('rainNext3h'), rainNext24h: pick('rainNext24h'),
    probNext3h: null, maxProbability24h: null,
    // Si nadie confirma lluvia, el ícono no puede decir "llovizna": se muestra nublado (3) o el cielo del modelo.
    weatherCode: intensity ? INT_CODE[intensity] : baseRainy ? 3 : baseCode,
    hourly: mergeHourly(okM),
  };
  // Si una fuente confirma que está lloviendo, la hora en curso es 100 % (ya no es pronóstico)
  if (intensity > 0 && w.hourly.length) w.hourly[0] = rainingNow(w.hourly[0], w.rainNow);
  // Probabilidad de lluvia: la de la hora en curso y las 3 siguientes, y la mayor de las próximas 24 h
  if (w.hourly.length) {
    w.probNext3h = Math.max(...w.hourly.slice(0, 4).map(h => h.probability));
    w.maxProbability24h = Math.max(...w.hourly.slice(1, 25).map(h => h.probability));
    w.probEstimated = w.hourly.slice(0, 4).every(h => h.estimated);
  }
  w.periods = dayParts(w.hourly);
  w.sun = sunInfo(base?.sun || okM.find(m => m.sun?.uvIndex != null)?.sun, w.cloudCover, intensity);
  Object.assign(w, describe(w));
  if (intensity !== w.intensity) Object.assign(w, { intensity, raining: intensity > 0, condition: intensity ? INT_TXT[intensity] : w.condition });
  // Sin lluvia: de día y despejado es "Soleado"; de noche, "Noche despejada"
  if (!w.intensity && w.condition === 'Despejado' && w.sun) w.condition = w.sun.sky === 'noche' ? 'Noche despejada' : 'Soleado';
  w.outlook = outlookOf(w, { okM, metar, need, base });
  return w;
}

// Pronóstico hora por hora juntando todos los modelos que respondieron (próximas 24 h).
// Probabilidad de lluvia de cada hora = la mayor entre:
//  · la probabilidad que publican los modelos (sale de sus "ensambles": decenas de corridas del mismo modelo), en promedio
//  · la parte de los modelos que prevén lluvia en esa hora (si 4 de 9 ven lluvia, ~45 %)
// Así nunca queda en 0 % por falta de dato cuando varios modelos sí ven lluvia. Con 1 o 2 modelos se estima por los milímetros.
const P_MM = [[5, 90], [2.5, 80], [1, 70], [0.5, 55], [0.2, 40], [0.1, 25]];
const WET_MM = 0.1; // desde 0,1 mm el modelo "ve lluvia" en esa hora
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
    return { time, probability: Math.min(100, Math.round(p / 5) * 5), precipitation: r1(wet * 3 >= n ? avg(wetMm) : avg(mm)), precipMax: r1(max),
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

// Aviso de lluvia posible (no cambia el semáforo): junta las señales de que podría llover pronto.
// Cada señal suma puntos; con 2 o más se avisa "podría llover", con 4 o más "lluvia probable".
function outlookOf(w, { okM, metar, need, base }) {
  const reasons = []; let score = 0;
  const prob = w.probNext3h ?? null;
  if (prob != null && prob >= 35) { score += prob >= 70 ? 3 : prob >= 50 ? 2 : 1; reasons.push(`probabilidad de lluvia de hasta ${prob} % en las próximas 3 h`); }
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
  const from = (w.hourly || []).slice(1, 7).find(h => (h.probability ?? 0) >= 50 || (h.precipitation ?? 0) >= MIN_MM)?.time || null;
  const level = w.intensity > 0 ? 'lloviendo' : score >= 4 ? 'probable' : score >= 2 ? 'atencion' : 'calma';
  const title = { lloviendo: 'Está lloviendo', probable: 'Lluvia probable en las próximas horas', atencion: 'Atención: podría llover pronto', calma: 'Sin lluvia a la vista' }[level];
  const text = level === 'lloviendo' ? 'Revisa las calles inundadas y las vías alternas antes de salir.'
    : level === 'calma' ? 'Ninguna fuente prevé lluvia en las próximas 3 horas.'
    : `Ahora no llueve, pero ${level === 'probable' ? 'es probable un aguacero' : 'podría caer un aguacero corto'}${from ? ` desde las ${from.slice(11, 16)}, aproximadamente` : ''}. Lleva paraguas y evita las calles que suelen inundarse.`;
  return { level, score, title, text, reasons, from };
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
  const sky = intensity > 0 ? 'lluvia' : night ? 'noche' : c >= 80 ? 'nublado' : c >= 40 ? 'parcial' : 'soleado';
  const uv = s.uvIndex == null ? null : Math.round(s.uvIndex * 10) / 10;
  return { ...s, uvIndex: uv, uvMax: s.uvMax == null ? null : Math.round(s.uvMax * 10) / 10, radiation: s.radiation == null ? null : Math.round(s.radiation),
    sky, uv: uvLevel(night ? 0 : uv), uvMaxLevel: uvLevel(s.uvMax) };
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
  const mmInt = w.rainNow >= 8 ? 3 : w.rainNow >= 2.5 ? 2 : w.rainNow >= MIN_MM ? 1 : 0;
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
  // Umbrales pensados para que una sola señal (por ejemplo, solo el pronóstico de 24 h, máx. 25) no encienda la amarilla.
  return { value, parts, level: value >= 70 ? 'roja' : value >= 50 ? 'naranja' : value >= 30 ? 'amarilla' : 'normal' };
}

// Nivel sugerido por el clima: normal | amarilla | naranja | roja
export function levelFromWeather(w, cfg) {
  if (!w.ok) return 'normal';
  const t = cfg.rainThresholdMm, t3 = cfg.rainThresholdMm3h, i = w.intensity || 0;
  if (w.rainNow >= t * 3 || w.rainPast3h >= t3 * 2 || (i >= 4 && w.rainNow >= t)) return 'roja';
  if (w.rainNow >= t || w.rainPast3h >= t3 || i >= 3) return 'naranja';
  // Lluvia confirmada en curso, o lluvia casi segura (≥ 80 % y varios modelos con ≥ la mitad del umbral) en las próximas 3 h: amarilla.
  if (i >= 1 || ((w.probNext3h ?? 0) >= 80 && w.rainNext3h >= t / 2)) return 'amarilla';
  return 'normal';
}
