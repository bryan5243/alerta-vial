// Integración con Open-Meteo (gratuita, sin API key).
// Devuelve lluvia actual, acumulado de las últimas 3 h, pronóstico de 3 h y 24 h, y nivel del mar (marea).
let cache = { at: 0, key: '', data: null };
let tideCache = { at: 0, key: '', data: null };
const TTL = 10 * 60 * 1000;

export async function getWeather({ lat, lng }) {
  const key = `${lat},${lng}`;
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL) return cache.data;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: lat, longitude: lng,
    current: 'precipitation,rain,temperature_2m,weather_code',
    hourly: 'precipitation,precipitation_probability',
    past_hours: 3, forecast_hours: 24,
    timezone: 'America/Guayaquil',
  });

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const j = await res.json();
    const hours = j.hourly.time.map((t, i) => ({
      time: t,
      precipitation: j.hourly.precipitation[i],
      probability: j.hourly.precipitation_probability[i],
    }));
    const nowIdx = Math.max(0, hours.findIndex(h => h.time.slice(0, 13) === j.current.time.slice(0, 13)));
    const sum = arr => +arr.reduce((s, h) => s + (h.precipitation || 0), 0).toFixed(1);
    const data = {
      ok: true,
      source: 'Open-Meteo',
      observedAt: j.current.time,
      temperature: j.current.temperature_2m,
      rainNow: j.current.precipitation ?? j.current.rain ?? 0,
      rainPast3h: sum(hours.slice(Math.max(0, nowIdx - 3), nowIdx + 1)),
      rainNext3h: sum(hours.slice(nowIdx + 1, nowIdx + 4)),
      rainNext24h: sum(hours.slice(nowIdx + 1, nowIdx + 25)),
      maxProbability24h: Math.max(0, ...hours.slice(nowIdx + 1, nowIdx + 25).map(h => h.probability || 0)),
      weatherCode: j.current.weather_code,
      hourly: hours.slice(nowIdx, nowIdx + 12),
    };
    cache = { at: Date.now(), key, data };
    return data;
  } catch (err) {
    return { ok: false, source: 'Open-Meteo', error: err.message, rainNow: 0, rainPast3h: 0, rainNext3h: 0, rainNext24h: 0, hourly: [] };
  }
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
  const rainNow = w.ok ? clamp(Math.max(w.rainNow / (t * 3), w.rainPast3h / (t3 * 2))) : 0;
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
  const t = cfg.rainThresholdMm, t3 = cfg.rainThresholdMm3h;
  if (w.rainNow >= t * 3 || w.rainPast3h >= t3 * 2) return 'roja';
  if (w.rainNow >= t || w.rainPast3h >= t3) return 'naranja';
  if (w.rainNext3h >= t || w.rainNow >= t / 2) return 'amarilla';
  return 'normal';
}
