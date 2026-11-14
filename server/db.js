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
      weather: { lat: -3.459603, lng: -79.965844, rainThresholdMm: 5, rainThresholdMm3h: 15, autoMode: true },
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
