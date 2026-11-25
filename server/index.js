import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { load, save, nextId, reset } from './db.js';
import { getDays, getWeather, getTide, levelFromWeather, riskIndex, describe, localSources, dayParts, rainingNow } from './weather.js';
import { getFloodForecast } from './flood.js';
import { seedIfEmpty } from './seed.js';
import fs from 'node:fs';
import { DB_PATH } from './db.js';
import * as push from './push.js';

// Mensaje que ve la ciudadanía según el color de alerta (editable desde el panel).
const DEFAULT_LEVEL_MESSAGES = {
  normal: 'Vías operando con normalidad. Circule con precaución y respete la señalización.',
  amarilla: 'Lluvia prevista en la ciudad. Planifique su ruta, evite zonas bajas y manténgase informado.',
  naranja: 'Hay calles inundadas. Evite los sectores marcados en rojo y use las vías alternas en azul.',
  roja: 'Riesgo alto de inundación. No circule por las zonas señaladas, aléjese de ríos y canales y siga las indicaciones de EMOVTT y la SGR.',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const app = express();
app.set('trust proxy', 1); // detrás del proxy de Render/cPanel: IP real para el límite de reportes
app.use(express.json({ limit: '25mb' })); // capas GeoJSON pueden ser grandes
// no-cache: el navegador revalida siempre (usa ETag), así nadie se queda con archivos viejos tras una actualización
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res, f) => { if (/\.(html|js|css|webmanifest)$/.test(f)) res.setHeader('Cache-Control', 'no-cache'); } }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // datos siempre del momento (nunca de la caché del navegador)

// Revisión de datos: sube con cada cambio hecho desde el admin. Los teléfonos la consultan (muy liviano) y recargan al instante.
let dataRev = Date.now();
app.use('/api/admin', (req, res, next) => { if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) dataRev = Date.now(); }); next(); });
app.get('/api/public/rev', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ rev: dataRev, mapVersion: load().config.mapVersion || 0 }); });

seedIfEmpty();

// ---------- Auth (sesión simple en memoria) ----------
const sessions = new Map();
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Necesitas iniciar sesión como administrador.' });
}
app.post('/api/login', (req, res) => {
  const { user, password } = req.body || {};
  if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { user, at: Date.now() });
    return res.json({ token, user });
  }
  res.status(401).json({ error: 'Usuario o contraseña incorrectos. Revisa e intenta de nuevo.' });
});
app.post('/api/logout', auth, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});

// ---------- Estado combinado (clima + alerta efectiva) ----------
const LV = { normal: 0, amarilla: 1, naranja: 2, roja: 3 };
const maxLevel = (a, b) => (LV[a] >= LV[b] ? a : b);
// Simulador de lluvia para pruebas (Admin → Alerta). Vive solo en memoria: no toca la base de datos
// y se apaga solo al terminar el tiempo o al reiniciar el servidor.
let simulation = null;
const simOn = () => simulation && simulation.until > Date.now() ? simulation : (simulation = null);
function simulatedWeather(real) {
  const s = simOn();
  const w = { ok: true, source: 'Simulación de prueba', simulated: true, simUntil: new Date(s.until).toISOString(), observedAt: new Date().toISOString(),
    temperature: real?.temperature ?? 26, rainNow: s.rainNow, rainPast3h: s.rainPast3h, rainNext3h: s.rainNext3h, rainNext24h: s.rainNext3h * 2,
    probNext3h: s.probNext3h, maxProbability24h: s.probNext3h, cloudCover: s.rainNow > 0 || s.weatherCode ? 95 : 40, weatherCode: s.weatherCode, hourly: [] };
  // el sol sigue siendo el real; solo el cielo pasa a lluvia si la simulación llueve
  if (real?.sun) w.sun = { ...real.sun, sky: s.rainNow > 0 || s.weatherCode >= 50 ? 'lluvia' : real.sun.sky };
  w.hourly = real?.hourly || [];
  if (s.rainNow > 0 && w.hourly.length) w.hourly = [rainingNow(w.hourly[0], s.rainNow), ...w.hourly.slice(1)];
  w.periods = dayParts(w.hourly);
  w.outlook = s.rainNow > 0 ? { level: 'lloviendo', title: 'Está lloviendo', text: 'Revisa las calles inundadas y las vías alternas antes de salir.', reasons: [] } : real?.outlook;
  return Object.assign(w, describe(w));
}
import { startLightning } from './lightning.js';
import { nearStreets } from './near.js';
import { noteObservation, withHistory } from './daylog.js';
{ const c0 = load().config; if (c0.lightningEnabled !== false) startLightning({ lat: c0.weather?.lat ?? c0.center?.lat, lng: c0.weather?.lng ?? c0.center?.lng }); }
async function computeStatus() {
  const db = load();
  let [weather, tide, flood] = await Promise.all([
    getWeather({ ...db.config.weather, metarStation: db.config.weather.metarStation ?? 'SERO', owmKey: process.env.OWM_KEY || db.config.weather.owmKey || '' },
      localSources({ observed: db.alert.observed })),
    getTide(db.config.weather),
    db.config.floodEnabled === true
      ? getFloodForecast({ ...db.config.center, apiKey: process.env.GOOGLE_FLOOD_KEY || db.config.googleFloodKey || '' })
      : Promise.resolve({ ok: false, disabled: true, gauges: [] }),
  ]);
  if (!simOn()) noteObservation(weather); // diario del clima (para mostrar "Ayer")
  if (simOn()) weather = simulatedWeather(weather);
  const risk = riskIndex({ weather, cfg: db.config.weather, flood, reports: [], tide, rivers: (db.rivers || []).filter(r => r.active !== false) });
  // Nivel sugerido: el mayor entre la regla de lluvia y el índice de riesgo combinado.
  // Un río crecido o desbordado sube el nivel por sí solo (antes solo sumaba hasta 20 puntos al índice y no alcanzaba ni la amarilla).
  const activeRivers = (db.rivers || []).filter(r => r.active !== false);
  const over = activeRivers.filter(r => r.status === 'desbordado').length, high = activeRivers.filter(r => r.status === 'crecido').length;
  const gaugeSev = flood?.ok ? (flood.gauges || []).map(g => g.severity) : [];
  const riverLevel = gaugeSev.includes('EXTREME') || over >= 2 || (over >= 1 && (weather?.intensity || 0) >= 2) ? 'roja'
    : gaugeSev.includes('SEVERE') || over >= 1 ? 'naranja' : gaugeSev.includes('ABOVE_NORMAL') || high >= 1 ? 'amarilla' : 'normal';
  const suggested = maxLevel(maxLevel(levelFromWeather(weather, db.config.weather), risk.level), riverLevel);
  // Durante una simulación el nivel publicado sigue al clima simulado, aunque la alerta esté en manual.
  // La simulación es solo una prueba: muestra el nivel simulado pero no deja huella (ni bajada gradual ni drenaje).
  // Antes, al terminar una simulación en roja, el semáforo se quedaba en roja y bajaba de a un color cada 45 min.
  const sim = !!simOn();
  const effective = sim ? suggested : db.alert.mode === 'manual' ? db.alert.level : stepDown(db, suggested);
  const drain = sim ? { draining: false, until: null, reportOn: LV[effective] >= 2 } : syncAutoPoints(db, effective, Date.now(), weather);
  return { weather, suggested, effective, risk, tide, flood, drain };
}
// Al dejar de llover el semáforo no cae de golpe: baja un color cada cierto tiempo (por defecto 45 min),
// porque el agua tarda en irse. Si vuelve a llover, sube de inmediato.
function stepDown(db, suggested, now = Date.now()) {
  const a = db.alert, cur = a.autoLevel && LV[a.autoLevel] != null ? a.autoLevel : suggested;
  const hold = (+db.config.weather?.stepDownMin || 45) * 60e3;
  let next = cur;
  if (LV[suggested] >= LV[cur]) { next = suggested; a.autoStepAt = now; }
  else if (now - (a.autoStepAt || 0) >= hold) { next = Object.keys(LV).find(k => LV[k] === LV[cur] - 1); a.autoStepAt = now; }
  if (next !== a.autoLevel) { a.autoLevel = next; save(); }
  return next;
}
// Puntos automáticos (y sus vías alternas): se encienden solos con naranja/roja. Cuando el semáforo baja a
// amarilla o verde, también se apagan los que se encendieron a mano durante la alerta, para que no queden
// vías alternas publicadas sin peligro.
function syncAutoPoints(db, effective, now = Date.now(), weather = null) {
  const a = db.alert;
  // Hora de la última lluvia confirmada (para los puntos que vienen de reportes ciudadanos)
  if (weather?.intensity > 0 && (!a.lastRainAt || now - a.lastRainAt > 60e3)) { a.lastRainAt = now; save(); }
  const drainMs = (+(db.config.weather?.drainHours ?? 3) || 0) * 3600e3;
  // Mientras hay naranja o roja se anota la hora; los puntos críticos siguen activos hasta que pase el tiempo
  // de drenaje (por defecto 3 h) desde la última vez que hubo naranja/roja: el agua tarda en bajar.
  if (LV[effective] >= 2) { if (!a.lastHighAt || now - a.lastHighAt > 60e3) { a.lastHighAt = now; save(); } }
  const until = a.lastHighAt ? a.lastHighAt + drainMs : 0, draining = LV[effective] < 2 && until > now;
  if (LV[effective] < 2 && a.lastHighAt && until <= now && !a.drainDone) {
    let n = 0; for (const p of db.points) if (p.auto && p.active) { p.active = false; n++; }
    if (n) console.log(`Pasó el tiempo de drenaje: ${n} punto(s) automáticos apagados con sus vías alternas.`);
    a.drainDone = true; save();
  }
  if (LV[effective] >= 2 && a.drainDone) { a.drainDone = false; save(); }
  if (a.lastEffective !== effective) { a.lastEffective = effective; save(); }
  // Puntos creados desde reportes (nivel medio): encendidos con naranja/roja y hasta 2 h después de que para la lluvia.
  const repEnd = a.lastHighAt && now - a.lastHighAt < 12 * 3600e3 ? Math.max(a.lastHighAt, a.lastRainAt || 0) + REPORT_DRAIN_MS : 0;
  return { draining, until: draining ? new Date(until).toISOString() : null, reportOn: LV[effective] >= 2 || repEnd > now };
}
const REPORT_DRAIN_MS = 2 * 3600e3, REPORT_TTL_MS = 3600e3;

// ---------- API pública ----------
app.get('/api/public/state', async (req, res) => {
  const db = load();
  const { weather, suggested, effective, risk, tide, flood, drain } = await computeStatus();
  const f = featuresCfg(db); const on = (k, list) => (f[k] ? list : []);
  // Un punto con "auto" se enciende con naranja o roja y sigue encendido mientras el agua drena.
  const pointOn = p => p.active || (p.auto && (p.source === 'reporte' ? drain?.reportOn : (LV[effective] >= 2 || drain?.draining)));
  // Una vía alterna vinculada a un punto o calle solo se muestra mientras ese peligro esté activo.
  const routeOn = r => {
    if (!r.active) return false;
    const pt = db.points.find(p => p.id === r.avoids); if (pt) return pointOn(pt) && f.points;
    const st = db.streets.find(s => s.id === r.avoids); if (st) return st.active && st.status !== 'despejada' && f.streets;
    return true;
  };
  res.json({
    config: { city: db.config.city, center: db.config.center, zoom: db.config.zoom,
      mapProvider: db.config.mapProvider, baseStyle: db.config.baseStyle || 'osm', googleMapsKey: db.config.googleMapsKey || '',
      mapVersion: db.config.mapVersion || 0, rainThresholdMm: db.config.weather.rainThresholdMm, gps: gpsCfg(db), levelMessages: levelMsgs(db), features: f, noCar: noCarCfg(db) },
    alert: { ...db.alert, effective, suggested, draining: !!drain?.draining, drainUntil: drain?.until || null },
    weather: { ...weather, hourly: weather.hourly?.slice(0, 25) },
    risk, tide, flood,
    layers: on('layers', (db.layers || []).filter(l => l.active !== false)),
    rivers: on('rivers', (db.rivers || []).filter(r => r.active !== false)),
    zones: on('rivers', (db.zones || []).filter(z => z.active !== false)),
    points: on('points', db.points.filter(pointOn).map(p => ({ ...p, active: true }))),
    streets: on('streets', db.streets.filter(s => s.active)),
    routes: on('routes', db.routes.filter(routeOn)),
    recommendations: on('recommendations', db.recommendations.filter(r => r.active)),
  });
});

// Reportes ciudadanos (comunidad). Entran como "pendientes" y el admin los revisa.
// Fotos de los reportes: se guardan como archivos junto a la base de datos.
const PHOTOS = path.join(path.dirname(DB_PATH), 'photos');
function parsePhoto(d) {
  const m = typeof d === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(d);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 1000 || buf.length > 2 * 1024 * 1024 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  return buf;
}
app.get('/photos/:name', (req, res) => {
  if (!/^rep_[a-z0-9]+\.jpg$/.test(req.params.name)) return res.status(404).end();
  const f = path.join(PHOTOS, req.params.name);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400').type('image/jpeg').sendFile(f);
});
const reportLimiter = new Map();
app.post('/api/public/reports', (req, res) => {
  const ip = req.ip;
  const recent = (reportLimiter.get(ip) || []).filter(t => Date.now() - t < 10 * 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Has enviado muchos reportes seguidos. Espera unos minutos.' });
  if (!featuresCfg(load()).reports) return res.status(403).json({ error: 'Los reportes ciudadanos están desactivados por ahora.' });
  const { lat, lng, description, level, street, type } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Toca el mapa para indicar el lugar del reporte.' });
  const photo = parsePhoto(req.body?.photo);
  if (!photo) return res.status(400).json({ error: 'Adjunta una fotografía del lugar: es obligatoria para comprobar el reporte.' });
  if (!description || description.trim().length < 5) return res.status(400).json({ error: 'Describe brevemente qué está pasando (mínimo 5 letras).' });
  const db = load();
  db.reports ||= [];
  const report = { id: nextId('rep'), lat, lng, street: String(street || '').slice(0, 120),
    description: String(description).slice(0, 400), level: 'moderado', // la ciudadanía ya no elige gravedad: todo reporte aceptado es un punto crítico de nivel medio
    type: type === 'desborde' ? 'desborde' : 'inundacion',
    status: 'pendiente', createdAt: new Date().toISOString() };
  report.photo = `/photos/${report.id}.jpg`;
  fs.mkdirSync(PHOTOS, { recursive: true });
  fs.writeFileSync(path.join(PHOTOS, `${report.id}.jpg`), photo);
  db.reports.push(report);
  save();
  reportLimiter.set(ip, [...recent, Date.now()]);
  res.status(201).json(report);
});
// Reportes verificados se muestran en el mapa público
app.get('/api/public/reports', (req, res) => {
  const db = load();
  const f = featuresCfg(db);
  // Un reporte ya convertido en punto crítico no se muestra como reporte: lo representa el punto (solo con naranja/roja)
  const ids = new Set((db.points || []).map(p => p.id));
  res.json((db.reports || []).filter(r => r.status === 'verificado' && Date.now() - new Date(r.createdAt) < REPORT_TTL_MS && !(r.pointId && ids.has(r.pointId)) && (r.type === 'desborde' ? f.rivers : f.reports)));
});

// Radar RainViewer: devolvemos las plantillas de tiles más recientes (sin key).
let radarCache = { at: 0, data: null };
app.get('/api/public/radar', async (req, res) => {
  if (radarCache.data && Date.now() - radarCache.at < 5 * 60 * 1000) return res.json(radarCache.data);
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const past = j.radar?.past || [];
    const frames = past.slice(-6).map(f => ({ time: f.time, url: `${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` }));
    radarCache = { at: Date.now(), data: { ok: true, frames } };
  } catch (err) {
    radarCache = { at: Date.now(), data: { ok: false, error: err.message, frames: [] } };
  }
  res.json(radarCache.data);
});

// ---------- API administrativa ----------
app.get('/api/admin/state', auth, async (req, res) => {
  const db = load();
  const { weather, suggested, effective, risk, tide, drain } = await computeStatus();
  const pts = db.points.filter(p => p.auto && (p.source === 'reporte' ? drain?.reportOn : drain?.draining) && LV[effective] < 2).length;
  res.json({ ...db, push: undefined, pushCount: push.subCount(), config: { ...db.config, gps: gpsCfg(db), levelMessages: levelMsgs(db), features: featuresCfg(db), noCar: noCarCfg(db) }, alert: { ...db.alert, effective, suggested, draining: !!(drain?.draining || (LV[effective] < 2 && drain?.reportOn)), drainUntil: drain?.until || null, drainPoints: pts }, weather: { ...weather, hourly: weather.hourly?.slice(0, 25) }, risk, tide, reports: db.reports || [], layers: db.layers || [], rivers: db.rivers || [], zones: db.zones || [] });
});

// "El agua ya bajó": termina el tiempo de drenaje antes de lo previsto y apaga los puntos críticos automáticos
// (también los que vienen de reportes). Vuelven a encenderse solos con la próxima alerta naranja o roja.
app.post('/api/admin/drain-end', auth, async (req, res) => {
  const db = load(), { effective } = await computeStatus();
  if (LV[effective] >= 2) return res.status(400).json({ error: 'La alerta sigue en naranja o roja: los puntos críticos deben seguir activos.' });
  const a = db.alert; a.lastHighAt = null; a.lastRainAt = null; a.drainDone = true;
  let n = 0; for (const p of db.points) if (p.auto && p.active) { p.active = false; n++; }
  save(); res.json({ ok: true, turnedOff: n });
});
// "Volver al clima real": apaga todas las pruebas de una vez (simulación de lluvia, lluvia marcada por el equipo,
// modo manual, nivel que se arrastraba y puntos que quedaron encendidos por las pruebas) y publica lo que dice el clima real.
app.post('/api/admin/reset-real', auth, async (req, res) => {
  const db = load(), a = db.alert, done = [];
  if (simOn()) done.push('simulación de lluvia'); simulation = null;
  if (a.observed) { done.push('lluvia marcada por el equipo'); delete a.observed; }
  if (a.mode === 'manual') { done.push('modo manual'); a.mode = 'auto'; }
  delete a.autoLevel; a.autoStepAt = Date.now(); save();
  const st = await computeStatus();
  let off = 0;
  if (LV[st.effective] < 2) {
    a.lastHighAt = null; a.lastRainAt = null; a.drainDone = true;
    for (const p of db.points) if (p.auto && p.active) { p.active = false; off++; }
    if (off) done.push(`${off} punto(s) crítico(s) encendidos`);
  }
  a.updatedAt = new Date().toISOString(); save();
  res.json({ ok: true, done, effective: st.effective }); setTimeout(pushTick, 300);
});
// "Actualizar mapa": sube un número de versión; todos los teléfonos que abren el mapa lo notan y renuevan sus archivos y cuadros guardados.
app.post('/api/admin/map-refresh', auth, (req, res) => { const db = load(); db.config.mapVersion = Date.now(); save(); res.json({ ok: true, mapVersion: db.config.mapVersion }); });
app.put('/api/admin/config', auth, (req, res) => {
  const db = load();
  const c = req.body || {};
  if (c.city) db.config.city = String(c.city).slice(0, 80);
  if (c.center) db.config.center = { lat: +c.center.lat, lng: +c.center.lng };
  if (c.zoom) db.config.zoom = +c.zoom;
  if (c.mapProvider) db.config.mapProvider = c.mapProvider === 'google' ? 'google' : 'leaflet';
  if (c.baseStyle !== undefined) db.config.baseStyle = ['osm', 'hot', 'osmfr'].includes(c.baseStyle) ? c.baseStyle : 'osm';
  if (c.googleMapsKey !== undefined) db.config.googleMapsKey = String(c.googleMapsKey).trim();
  if (c.features) db.config.features = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map(k => [k, c.features[k] !== false]));
  if (c.noCar !== undefined) db.config.noCar = [...new Set((Array.isArray(c.noCar) ? c.noCar : String(c.noCar).split(/\n|,/)).map(x => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 40);
  if (c.floodEnabled !== undefined) db.config.floodEnabled = c.floodEnabled === true;
  if (c.googleFloodKey !== undefined) db.config.googleFloodKey = String(c.googleFloodKey).trim();
  if (c.levelMessages) db.config.levelMessages = Object.fromEntries(Object.keys(DEFAULT_LEVEL_MESSAGES).map(k => [k, String(c.levelMessages[k] ?? '').trim().slice(0, 300) || DEFAULT_LEVEL_MESSAGES[k]]));
  if (c.gps) db.config.gps = { warnM: Math.max(50, +c.gps.warnM || 400), dangerM: Math.max(20, +c.gps.dangerM || 150), voice: c.gps.voice !== false };
  if (c.weather) db.config.weather = { ...db.config.weather, ...c.weather,
    lat: +(c.weather.lat ?? db.config.weather.lat), lng: +(c.weather.lng ?? db.config.weather.lng),
    rainThresholdMm: +(c.weather.rainThresholdMm ?? db.config.weather.rainThresholdMm),
    rainThresholdMm3h: +(c.weather.rainThresholdMm3h ?? db.config.weather.rainThresholdMm3h),
    stepDownMin: Math.max(5, Math.min(360, +(c.weather.stepDownMin ?? db.config.weather.stepDownMin ?? 45) || 45)),
    drainHours: Math.max(0, Math.min(48, +(c.weather.drainHours ?? db.config.weather.drainHours ?? 3) || 0)),
    metarStation: String(c.weather.metarStation ?? db.config.weather.metarStation ?? 'SERO').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4),
    owmKey: String(c.weather.owmKey ?? db.config.weather.owmKey ?? '').trim().slice(0, 64) };
  save();
  res.json(db.config);
});

// Respaldo: descargar todos los datos o restaurarlos (para pasar del equipo local al hosting y viceversa).
app.get('/api/admin/backup', auth, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="alertavial-respaldo-${stamp}.json"`);
  res.type('application/json').send(JSON.stringify(load(), null, 2));
});
app.post('/api/admin/restore', auth, (req, res) => {
  const d = req.body;
  const ok = d && typeof d === 'object' && d.config && d.alert && ['points', 'streets', 'routes', 'recommendations'].every(k => Array.isArray(d[k]));
  if (!ok) return res.status(400).json({ error: 'El archivo no es un respaldo del Sistema de Alerta Vial.' });
  reset(d); simulation = null;
  res.json({ ok: true, counts: Object.fromEntries(['points', 'streets', 'routes', 'rivers', 'zones', 'layers', 'reports'].map(k => [k, (d[k] || []).length])) });
});

// "Está lloviendo ahora": el equipo confirma la lluvia que ve en la calle cuando las fuentes en línea no la detectan.
// Se guarda en la base (sobrevive a reinicios) y vence sola.
app.put('/api/admin/observed', auth, (req, res) => {
  const db = load(), b = req.body || {};
  const i = Math.round(+b.intensity || 0);
  if (!i) delete db.alert.observed;
  else db.alert.observed = { intensity: Math.max(1, Math.min(4, i)), at: new Date().toISOString(), until: new Date(Date.now() + Math.max(15, Math.min(720, +b.minutes || 120)) * 60000).toISOString() };
  save();
  res.json(db.alert.observed || { intensity: 0 }); setTimeout(pushTick, 300);
});

app.get('/api/admin/simulation', auth, (req, res) => res.json(simOn() || { active: false }));
app.put('/api/admin/simulation', auth, (req, res) => {
  const b = req.body || {};
  if (!b.active) { simulation = null; const db = load(); delete db.alert.autoLevel; db.alert.autoStepAt = Date.now(); save(); return res.json({ active: false }); }
  const n = (v, max) => Math.max(0, Math.min(max, +v || 0));
  simulation = { active: true, preset: String(b.preset || 'manual').slice(0, 30), rainNow: n(b.rainNow, 200), rainPast3h: n(b.rainPast3h, 500), rainNext3h: n(b.rainNext3h, 500),
    probNext3h: n(b.probNext3h, 100), weatherCode: Math.round(n(b.weatherCode, 99)), until: Date.now() + Math.max(1, Math.min(240, +b.minutes || 30)) * 60000 };
  res.json(simulation); setTimeout(pushTick, 300); // los avisos de prueba salen al instante (antes esperaban hasta 5 min)
});

app.put('/api/admin/alert', auth, (req, res) => {
  const db = load();
  const { level, mode, message } = req.body || {};
  if (mode) db.alert.mode = mode === 'manual' ? 'manual' : 'auto';
  // Al pasar a automático: el semáforo sigue de inmediato al pronóstico (sin arrastrar el nivel anterior)
  // y se apaga la simulación de lluvia si estaba encendida.
  let simStopped = false;
  if (mode === 'auto') { simStopped = !!simOn(); simulation = null; delete db.alert.autoLevel; db.alert.autoStepAt = Date.now(); }
  if (level && ['normal', 'amarilla', 'naranja', 'roja'].includes(level)) db.alert.level = level;
  if (message !== undefined) db.alert.message = String(message).slice(0, 300);
  db.alert.updatedAt = new Date().toISOString();
  save();
  res.json({ ...db.alert, simStopped }); setTimeout(pushTick, 300);
});

// CRUD genérico para points / streets / routes / recommendations
const collections = {
  points: { prefix: 'pt', fields: ['name', 'lat', 'lng', 'type', 'severity', 'description', 'active', 'auto', 'source'] },
  streets: { prefix: 'st', fields: ['name', 'coords', 'status', 'depthCm', 'note', 'active'] },
  routes: { prefix: 'rt', fields: ['name', 'coords', 'from', 'to', 'description', 'avoids', 'active', 'auto'] },
  recommendations: { prefix: 'rc', fields: ['text', 'level', 'active'] },
  rivers: { prefix: 'rv', fields: ['name', 'coords', 'status', 'note', 'active', 'source', 'kind'] },
  zones: { prefix: 'zn', fields: ['name', 'coords', 'severity', 'riverId', 'note', 'depthCm', 'active'] },
  layers: { prefix: 'ly', fields: ['name', 'color', 'geojson', 'kind', 'source', 'active'] },
};
for (const [name, def] of Object.entries(collections)) {
  // Cambio masivo: activar/desactivar (o "auto" en puntos) todos o los ids indicados.
  app.put(`/api/admin/${name}/bulk`, auth, (req, res) => {
    const db = load(); db[name] ||= [];
    const { ids, active, auto } = req.body || {};
    let n = 0;
    for (const it of db[name]) {
      if (Array.isArray(ids) && !ids.includes(it.id)) continue;
      if (typeof active === 'boolean') it.active = active;
      if (name === 'points' && typeof auto === 'boolean') it.auto = auto;
      it.updatedAt = new Date().toISOString(); n++;
    }
    save(); res.json({ ok: true, updated: n });
  });
  app.post(`/api/admin/${name}`, auth, (req, res) => {
    const db = load(); db[name] ||= [];
    const item = pick(req.body, def.fields);
    const err = validate(name, item);
    if (err) return res.status(400).json({ error: err });
    item.id = nextId(def.prefix);
    item.active = item.active !== false;
    item.createdAt = new Date().toISOString();
    db[name].push(item);
    save();
    res.status(201).json(item);
  });
  app.put(`/api/admin/${name}/:id`, auth, (req, res) => {
    const db = load(); db[name] ||= [];
    const i = db[name].findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'No se encontró el elemento.' });
    const merged = { ...db[name][i], ...pick(req.body, def.fields), updatedAt: new Date().toISOString() };
    const err = validate(name, merged);
    if (err) return res.status(400).json({ error: err });
    db[name][i] = merged;
    save();
    res.json(merged);
  });
  app.delete(`/api/admin/${name}/:id`, auth, (req, res) => {
    const db = load(); db[name] ||= [];
    const before = db[name].length;
    db[name] = db[name].filter(x => x.id !== req.params.id);
    if (db[name].length === before) return res.status(404).json({ error: 'No se encontró el elemento.' });
    save();
    res.json({ ok: true });
  });
}

// Revisión de reportes ciudadanos
app.put('/api/admin/reports/:id', auth, (req, res) => {
  const db = load();
  const r = (db.reports || []).find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'No se encontró el reporte.' });
  if (['pendiente', 'verificado', 'descartado', 'retirado'].includes(req.body.status)) r.status = req.body.status;
  if (typeof req.body.pointId === 'string') r.pointId = req.body.pointId.slice(0, 40); // punto crítico creado a partir de este reporte
  r.reviewedAt = new Date().toISOString();
  if (r.status === 'retirado') r.clearedAt = r.reviewedAt;
  save();
  res.json(r);
});
app.delete('/api/admin/reports/:id', auth, (req, res) => {
  const db = load();
  db.reports = (db.reports || []).filter(x => x.id !== req.params.id);
  if (/^rep_[a-z0-9]+$/.test(req.params.id)) fs.rm(path.join(PHOTOS, `${req.params.id}.jpg`), { force: true }, () => {});
  save();
  res.json({ ok: true });
});

// Secciones del mapa público que el equipo puede mostrar u ocultar.
const DEFAULT_FEATURES = { streets: true, routes: true, rivers: true, points: true, recommendations: true, reports: true, gps: true, radar: true, risk: true, weather: true, layers: true };
const DEFAULT_NOCAR = ['Malecón', 'peatonal', 'ciclovía', 'escalinata'];
const noCarCfg = db => Array.isArray(db.config.noCar) ? db.config.noCar : DEFAULT_NOCAR;
function featuresCfg(db) { return { ...DEFAULT_FEATURES, ...(db.config.features || {}) }; }
function levelMsgs(db) { return { ...DEFAULT_LEVEL_MESSAGES, ...(db.config.levelMessages || {}) }; }
function gpsCfg(db) { return { warnM: 400, dangerM: 150, voice: true, ...(db.config.gps || {}) }; }
function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}
function validate(name, item) {
  if (name === 'points') {
    if (!item.name) return 'Escribe un nombre para el punto crítico.';
    if (typeof item.lat !== 'number' || typeof item.lng !== 'number') return 'Haz clic en el mapa para ubicar el punto.';
  }
  if (name === 'streets' || name === 'routes') {
    if (!item.name) return 'Escribe el nombre de la calle o ruta.';
    if (!Array.isArray(item.coords) || item.coords.length < 2) return 'Dibuja al menos dos puntos sobre el mapa.';
  }
  if (name === 'rivers') {
    if (!item.name) return 'Escribe el nombre del río o canal.';
    if (!Array.isArray(item.coords) || item.coords.length < 2) return 'Dibuja el cauce con al menos dos puntos sobre el mapa.';
  }
  if (name === 'zones') {
    if (!item.name) return 'Escribe un nombre para la zona de desborde.';
    if (!Array.isArray(item.coords) || item.coords.length < 3) return 'Marca al menos tres puntos para cerrar el área de desborde.';
  }
  if (name === 'recommendations' && !item.text) return 'Escribe el texto de la recomendación.';
  if (name === 'layers') {
    if (!item.name) return 'Escribe un nombre para la capa.';
    if (!item.geojson || item.geojson.type !== 'FeatureCollection' || !Array.isArray(item.geojson.features)) return 'El archivo no tiene un formato de capa válido (GeoJSON FeatureCollection).';
    if (!item.geojson.features.length) return 'La capa no tiene elementos.';
  }
  return null;
}

app.get('/api/public/near', async (req, res) => {
  const lat = +req.query.lat, lng = +req.query.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Coordenadas inválidas' });
  try { res.json(await nearStreets(lat, lng)); } catch { res.json({ streets: [], sector: '' }); }
});
app.get('/api/public/forecast-days', async (req, res) => { const cfg = load().config.weather; res.json(await withHistory(await getDays(cfg), cfg)); });

// ---------- Notificaciones push ----------
app.get('/api/public/push-key', (req, res) => res.json({ key: push.publicKey() }));
app.post('/api/public/push-subscribe', (req, res) => push.addSub(req.body?.subscription) ? res.json({ ok: true }) : res.status(400).json({ error: 'Suscripción no válida.' }));
app.post('/api/public/push-unsubscribe', (req, res) => { push.removeSub(String(req.body?.endpoint || '')); res.json({ ok: true }); });
app.post('/api/admin/push/test', auth, async (req, res) => {
  const r = await push.sendAll({ title: 'Prueba de avisos', body: 'Si ves esto, las notificaciones funcionan en este teléfono.', tag: 'prueba' });
  res.json(r);
});
async function pushTick() {
  try {
    const st = await computeStatus(); const db = load();
    await push.checkAndNotify(st, { levelMessage: levelMsgs(db)[st.effective], simulated: !!simOn() });
  } catch (e) { console.error('Avisos push:', e.message); }
}
// El clima se consulta apenas arranca el servidor y luego cada 4 min, así ninguna visita espera a las fuentes.
setTimeout(() => computeStatus().catch(() => {}), 1000); setInterval(() => computeStatus().catch(() => {}), 4 * 60 * 1000);
setTimeout(pushTick, 20000); setInterval(pushTick, 5 * 60 * 1000);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor.' }); });

app.listen(PORT, () => {
  console.log(`\n  Sistema de Alerta Vial listo`);
  console.log(`  En esta PC:      http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`  En tu teléfono:  http://${ip}:${PORT}   (misma red WiFi)`);
  console.log(`  Panel admin:     http://localhost:${PORT}/admin\n`);
});
function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
}
