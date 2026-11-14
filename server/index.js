import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { load, save, nextId, reset } from './db.js';
import { getWeather, getTide, levelFromWeather, riskIndex, describe } from './weather.js';
import { getFloodForecast } from './flood.js';
import { seedIfEmpty } from './seed.js';

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
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  return Object.assign(w, describe(w));
}
async function computeStatus() {
  const db = load();
  let [weather, tide, flood] = await Promise.all([
    getWeather(db.config.weather),
    getTide(db.config.weather),
    db.config.floodEnabled === true
      ? getFloodForecast({ ...db.config.center, apiKey: process.env.GOOGLE_FLOOD_KEY || db.config.googleFloodKey || '' })
      : Promise.resolve({ ok: false, disabled: true, gauges: [] }),
  ]);
  if (simOn()) weather = simulatedWeather(weather);
  const risk = riskIndex({ weather, cfg: db.config.weather, flood, reports: db.reports || [], tide, rivers: (db.rivers || []).filter(r => r.active !== false) });
  // Nivel sugerido: el mayor entre la regla de lluvia y el índice de riesgo combinado.
  const suggested = maxLevel(levelFromWeather(weather, db.config.weather), risk.level);
  // Durante una simulación el nivel publicado sigue al clima simulado, aunque la alerta esté en manual.
  const effective = db.alert.mode === 'manual' && !simOn() ? db.alert.level : suggested;
  return { weather, suggested, effective, risk, tide, flood };
}

// ---------- API pública ----------
app.get('/api/public/state', async (req, res) => {
  const db = load();
  const { weather, suggested, effective, risk, tide, flood } = await computeStatus();
  const f = featuresCfg(db); const on = (k, list) => (f[k] ? list : []);
  // Un punto con "auto" se enciende solo cuando la alerta es naranja o roja.
  const pointOn = p => p.active || (p.auto && LV[effective] >= 2);
  // Una vía alterna vinculada a un punto o calle solo se muestra mientras ese peligro esté activo.
  const routeOn = r => {
    if (!r.active) return false;
    const pt = db.points.find(p => p.id === r.avoids); if (pt) return pointOn(pt) && f.points;
    const st = db.streets.find(s => s.id === r.avoids); if (st) return st.active && st.status !== 'despejada' && f.streets;
    return true;
  };
  res.json({
    config: { city: db.config.city, center: db.config.center, zoom: db.config.zoom,
      mapProvider: db.config.mapProvider, googleMapsKey: db.config.googleMapsKey || '',
      rainThresholdMm: db.config.weather.rainThresholdMm, gps: gpsCfg(db), levelMessages: levelMsgs(db), features: f },
    alert: { ...db.alert, effective, suggested },
    weather: { ...weather, hourly: weather.hourly?.slice(0, 10) },
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
const reportLimiter = new Map();
app.post('/api/public/reports', (req, res) => {
  const ip = req.ip;
  const recent = (reportLimiter.get(ip) || []).filter(t => Date.now() - t < 10 * 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Has enviado muchos reportes seguidos. Espera unos minutos.' });
  if (!featuresCfg(load()).reports) return res.status(403).json({ error: 'Los reportes ciudadanos están desactivados por ahora.' });
  const { lat, lng, description, level, street, type } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Toca el mapa para indicar el lugar del reporte.' });
  if (!description || description.trim().length < 5) return res.status(400).json({ error: 'Describe brevemente qué está pasando (mínimo 5 letras).' });
  const db = load();
  db.reports ||= [];
  const report = { id: nextId('rep'), lat, lng, street: String(street || '').slice(0, 120),
    description: String(description).slice(0, 400), level: ['leve', 'moderado', 'grave'].includes(level) ? level : 'moderado',
    type: type === 'desborde' ? 'desborde' : 'inundacion',
    status: 'pendiente', createdAt: new Date().toISOString() };
  db.reports.push(report);
  save();
  reportLimiter.set(ip, [...recent, Date.now()]);
  res.status(201).json(report);
});
// Reportes verificados se muestran en el mapa público
app.get('/api/public/reports', (req, res) => {
  const db = load();
  const f = featuresCfg(db);
  res.json((db.reports || []).filter(r => r.status === 'verificado' && (r.type === 'desborde' ? f.rivers : f.reports)));
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
  const { weather, suggested, effective, risk, tide } = await computeStatus();
  res.json({ ...db, config: { ...db.config, gps: gpsCfg(db), levelMessages: levelMsgs(db), features: featuresCfg(db) }, alert: { ...db.alert, effective, suggested }, weather: { ...weather, hourly: weather.hourly?.slice(0, 10) }, risk, tide, reports: db.reports || [], layers: db.layers || [], rivers: db.rivers || [], zones: db.zones || [] });
});

app.put('/api/admin/config', auth, (req, res) => {
  const db = load();
  const c = req.body || {};
  if (c.city) db.config.city = String(c.city).slice(0, 80);
  if (c.center) db.config.center = { lat: +c.center.lat, lng: +c.center.lng };
  if (c.zoom) db.config.zoom = +c.zoom;
  if (c.mapProvider) db.config.mapProvider = c.mapProvider === 'google' ? 'google' : 'leaflet';
  if (c.googleMapsKey !== undefined) db.config.googleMapsKey = String(c.googleMapsKey).trim();
  if (c.features) db.config.features = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map(k => [k, c.features[k] !== false]));
  if (c.floodEnabled !== undefined) db.config.floodEnabled = c.floodEnabled === true;
  if (c.googleFloodKey !== undefined) db.config.googleFloodKey = String(c.googleFloodKey).trim();
  if (c.levelMessages) db.config.levelMessages = Object.fromEntries(Object.keys(DEFAULT_LEVEL_MESSAGES).map(k => [k, String(c.levelMessages[k] ?? '').trim().slice(0, 300) || DEFAULT_LEVEL_MESSAGES[k]]));
  if (c.gps) db.config.gps = { warnM: Math.max(50, +c.gps.warnM || 400), dangerM: Math.max(20, +c.gps.dangerM || 150), voice: c.gps.voice !== false };
  if (c.weather) db.config.weather = { ...db.config.weather, ...c.weather,
    lat: +(c.weather.lat ?? db.config.weather.lat), lng: +(c.weather.lng ?? db.config.weather.lng),
    rainThresholdMm: +(c.weather.rainThresholdMm ?? db.config.weather.rainThresholdMm),
    rainThresholdMm3h: +(c.weather.rainThresholdMm3h ?? db.config.weather.rainThresholdMm3h) };
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
  if (!ok) return res.status(400).json({ error: 'El archivo no es un respaldo de AlertaVial.' });
  reset(d); simulation = null;
  res.json({ ok: true, counts: Object.fromEntries(['points', 'streets', 'routes', 'rivers', 'zones', 'layers', 'reports'].map(k => [k, (d[k] || []).length])) });
});

app.get('/api/admin/simulation', auth, (req, res) => res.json(simOn() || { active: false }));
app.put('/api/admin/simulation', auth, (req, res) => {
  const b = req.body || {};
  if (!b.active) { simulation = null; return res.json({ active: false }); }
  const n = (v, max) => Math.max(0, Math.min(max, +v || 0));
  simulation = { active: true, preset: String(b.preset || 'manual').slice(0, 30), rainNow: n(b.rainNow, 200), rainPast3h: n(b.rainPast3h, 500), rainNext3h: n(b.rainNext3h, 500),
    probNext3h: n(b.probNext3h, 100), weatherCode: Math.round(n(b.weatherCode, 99)), until: Date.now() + Math.max(1, Math.min(240, +b.minutes || 30)) * 60000 };
  res.json(simulation);
});

app.put('/api/admin/alert', auth, (req, res) => {
  const db = load();
  const { level, mode, message } = req.body || {};
  if (mode) db.alert.mode = mode === 'manual' ? 'manual' : 'auto';
  if (level && ['normal', 'amarilla', 'naranja', 'roja'].includes(level)) db.alert.level = level;
  if (message !== undefined) db.alert.message = String(message).slice(0, 300);
  db.alert.updatedAt = new Date().toISOString();
  save();
  res.json(db.alert);
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
  r.reviewedAt = new Date().toISOString();
  if (r.status === 'retirado') r.clearedAt = r.reviewedAt;
  save();
  res.json(r);
});
app.delete('/api/admin/reports/:id', auth, (req, res) => {
  const db = load();
  db.reports = (db.reports || []).filter(x => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// Secciones del mapa público que el equipo puede mostrar u ocultar.
const DEFAULT_FEATURES = { streets: true, routes: true, rivers: true, points: true, recommendations: true, reports: true, gps: true, radar: true, risk: true, weather: true, layers: true };
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

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor.' }); });

app.listen(PORT, () => {
  console.log(`\n  AlertaVial listo`);
  console.log(`  En esta PC:      http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`  En tu teléfono:  http://${ip}:${PORT}   (misma red WiFi)`);
  console.log(`  Panel admin:     http://localhost:${PORT}/admin\n`);
});
function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
}
