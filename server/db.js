// Base de datos simple en archivo JSON (sin dependencias nativas).
// Para producción se puede reemplazar por SQLite/Postgres manteniendo esta misma interfaz.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');

let cache = null;
export let createdNow = false; // true solo si el archivo de datos no existía (instalación nueva)

export function load() {
  if (cache) return cache;
  if (!fs.existsSync(DB_PATH)) {
    createdNow = true;
    cache = emptyDb();
    save();
  } else {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    // Umbrales de Santa Rosa (EMOVTT, nov 2026): con más de 2,4 mm/h ya se inundan las calles.
    // Si siguen los valores de fábrica antiguos (5 mm/h y 15 mm en 3 h), se pasan a los nuevos una sola vez.
    const w = cache.config?.weather;
    if (w && !w.thresholdsV2) {
      if (+w.rainThresholdMm === 5) w.rainThresholdMm = 2.4;
      if (+w.rainThresholdMm3h === 15) w.rainThresholdMm3h = 7;
      w.thresholdsV2 = true; save();
    }
  }
  return cache;
}

export function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

export function reset(data) {
  cache = data;
  save();
}

export function emptyDb() {
  return {
    config: {
      city: 'Santa Rosa, El Oro',
      center: { lat: -3.459603, lng: -79.965844 },
      zoom: 15,
      mapProvider: 'leaflet',
      googleMapsKey: '',
      gps: { warnM: 400, dangerM: 150, voice: true },
      weather: { lat: -3.459603, lng: -79.965844, rainThresholdMm: 2.4, rainThresholdMm3h: 7, thresholdsV2: true, autoMode: true },
    },
    alert: { level: 'normal', mode: 'auto', message: '', updatedAt: new Date().toISOString() },
    points: [],
    streets: [],
    routes: [],
    recommendations: [],
    layers: [],
    rivers: [],
    zones: [],
    reports: [],
  };
}

export function nextId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
