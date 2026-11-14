import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Datos de ejemplo para Santa Rosa (El Oro). Ejecuta `npm run seed` para restaurarlos.
import { load, reset, emptyDb } from './db.js';
import * as dbmod from './db.js';

// Centro: 3°27'34.57"S 79°57'57.04"W → Santa Rosa, El Oro (Ecuador).
// Los nombres y trazados son de EJEMPLO: reemplázalos desde el panel admin con las calles reales.
const C = { lat: -3.459603, lng: -79.965844 };
const o = (dLat, dLng) => [+(C.lat + dLat).toFixed(6), +(C.lng + dLng).toFixed(6)];
const pt = (dLat, dLng) => { const [lat, lng] = o(dLat, dLng); return { lat, lng }; };

export function sampleData() {
  const db = emptyDb();
  db.alert = { level: 'naranja', mode: 'manual', message: 'Lluvias intensas en Santa Rosa. El río está crecido: evite circular junto a la orilla y por los pasos bajos.', updatedAt: new Date().toISOString() };
  db.points = [
    { id: 'pt_1', name: 'Puente sobre el río Santa Rosa (ejemplo)', ...pt(0.0010, 0.0035), type: 'inundacion', severity: 'alta', active: true,
      description: 'El agua del río sube al nivel de la calzada. Paso restringido.' },
    { id: 'pt_2', name: 'Calle junto a la orilla del río (ejemplo)', ...pt(-0.0030, 0.0045), type: 'inundacion', severity: 'alta', active: true,
      description: 'Desborde en la orilla. Tránsito cerrado.' },
    { id: 'pt_3', name: 'Zona baja del centro (ejemplo)', ...pt(0.0005, -0.0020), type: 'riesgo', severity: 'media', active: true,
      description: 'Sector que se anega con lluvias fuertes. Circular con precaución.' },
    { id: 'pt_4', name: 'Barrio sector sur (ejemplo)', ...pt(-0.0080, -0.0030), type: 'inundacion', severity: 'media', active: true,
      description: 'Agua a nivel de vereda. Vehículos pequeños no deben pasar.' },
    { id: 'pt_5', name: 'Alcantarilla obstruida sector norte (ejemplo)', ...pt(0.0075, -0.0010), type: 'alcantarilla', severity: 'baja', active: true,
      description: 'Rejilla obstruida reportada por vecinos. Cuadrilla asignada.' },
  ];
  db.streets = [
    { id: 'st_1', name: 'Calle paralela al río, tramo centro (ejemplo)', status: 'inundada', depthCm: 45, active: true,
      note: 'Cerrada en ambos sentidos.', coords: [o(0.0020, 0.0040), o(-0.0010, 0.0042), o(-0.0040, 0.0046)] },
    { id: 'st_2', name: 'Acceso al puente del río Santa Rosa (ejemplo)', status: 'inundada', depthCm: 35, active: true,
      note: 'Paso bajo cerrado. Use la ruta alterna.', coords: [o(0.0010, 0.0010), o(0.0010, 0.0035), o(0.0010, 0.0060)] },
    { id: 'st_3', name: 'Calle del centro, zona baja (ejemplo)', status: 'parcial', depthCm: 15, active: true,
      note: 'Un carril habilitado. Velocidad máxima 20 km/h.', coords: [o(0.0015, -0.0035), o(0.0005, -0.0020), o(-0.0005, -0.0005)] },
    { id: 'st_4', name: 'Calle principal barrio sur (ejemplo)', status: 'inundada', depthCm: 30, active: true,
      note: 'Solo paso peatonal por aceras altas.', coords: [o(-0.0065, -0.0045), o(-0.0080, -0.0030), o(-0.0095, -0.0015)] },
    { id: 'st_5', name: 'Vía de acceso norte (ejemplo)', status: 'despejada', depthCm: 0, active: true,
      note: 'Despejada. Vía habilitada.', coords: [o(0.0110, -0.0060), o(0.0080, -0.0040), o(0.0050, -0.0025)] },
  ];
  db.routes = [
    { id: 'rt_1', name: 'Desvío por calles interiores del centro (ejemplo)', from: 'Norte', to: 'Centro', active: true, avoids: 'st_1',
      description: 'Evite la orilla del río. Avance por las calles interiores, dos cuadras hacia el oeste.',
      coords: [o(0.0030, 0.0020), o(0.0000, 0.0018), o(-0.0030, 0.0020), o(-0.0050, 0.0030)] },
    { id: 'rt_2', name: 'Alternativa al puente (ejemplo)', from: 'Centro', to: 'Este del río', active: true, avoids: 'st_2',
      description: 'Use el siguiente cruce disponible aguas arriba hasta que baje el nivel del río.',
      coords: [o(0.0020, 0.0005), o(0.0045, 0.0015), o(0.0055, 0.0040), o(0.0050, 0.0065)] },
    { id: 'rt_3', name: 'Salida del barrio sur por calles altas (ejemplo)', from: 'Barrio sur', to: 'Centro', active: true, avoids: 'st_4',
      description: 'Suba por las calles altas del oeste hacia el centro. Tramo sin acumulación de agua.',
      coords: [o(-0.0090, -0.0060), o(-0.0070, -0.0065), o(-0.0045, -0.0055), o(-0.0025, -0.0040)] },
  ];
  db.recommendations = [
    { id: 'rc_1', level: 'roja', active: true, text: 'No intente cruzar calles con agua en movimiento: 30 cm bastan para arrastrar un vehículo.' },
    { id: 'rc_2', level: 'naranja', active: true, text: 'Manténgase lejos de la orilla del río Santa Rosa mientras esté crecido.' },
    { id: 'rc_3', level: 'amarilla', active: true, text: 'Si debe salir, revise este mapa antes y agregue tiempo a su trayecto.' },
    { id: 'rc_4', level: 'normal', active: true, text: 'Reporte alcantarillas obstruidas con el botón "Reportar inundación" para que la cuadrilla acuda.' },
  ];
  db.reports = [
    { id: 'rep_1', ...pt(0.0060, 0.0010), street: 'Sector norte', level: 'moderado', status: 'pendiente', createdAt: new Date(Date.now() - 25 * 60000).toISOString(),
      description: 'Agua hasta la mitad de la llanta frente al parque.' },
    { id: 'rep_2', ...pt(-0.0020, -0.0050), street: 'Centro', level: 'leve', status: 'verificado', createdAt: new Date(Date.now() - 90 * 60000).toISOString(),
      description: 'Charco grande en la esquina, salpica a los peatones.' },
  ];
  // Capas de ejemplo (como las que entregaría el GAD o la Secretaría de Riesgos). Reemplázalas subiendo las reales.
  const ll = (dLat, dLng) => { const [lat, lng] = o(dLat, dLng); return [lng, lat]; };
  db.layers = [
    { id: 'ly_1', name: 'Zonas de riesgo de inundación (ejemplo)', color: '#C62E2E', kind: 'riesgo', source: 'ejemplo.geojson', active: true, createdAt: new Date().toISOString(),
      geojson: { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { name: 'Zona baja junto al río', riesgo: 'Alto' }, geometry: { type: 'Polygon', coordinates: [[ll(0.0040, 0.0030), ll(0.0040, 0.0058), ll(-0.0055, 0.0062), ll(-0.0055, 0.0034), ll(0.0040, 0.0030)]] } },
        { type: 'Feature', properties: { name: 'Barrio sur anegable', riesgo: 'Medio' }, geometry: { type: 'Polygon', coordinates: [[ll(-0.0060, -0.0055), ll(-0.0060, -0.0005), ll(-0.0105, 0.0000), ll(-0.0105, -0.0050), ll(-0.0060, -0.0055)]] } },
      ] } },
  ];
  // Ríos y zonas de desborde (dibujados desde Admin → Ríos / Desbordes). Trazados de EJEMPLO.
  db.rivers = [
    { id: 'rv_1', name: 'Río Santa Rosa (trazado de ejemplo)', status: 'crecido', active: true, note: 'Nivel alto tras las lluvias de la madrugada. Vigilancia permanente.',
      coords: [o(0.0120, 0.0030), o(0.0060, 0.0044), o(0.0010, 0.0047), o(-0.0040, 0.0052), o(-0.0090, 0.0060), o(-0.0140, 0.0072)] },
    { id: 'rv_2', name: 'Estero / canal sur (ejemplo)', status: 'desbordado', active: true, note: 'Desbordado en el barrio sur.',
      coords: [o(-0.0050, -0.0110), o(-0.0075, -0.0070), o(-0.0085, -0.0030), o(-0.0100, 0.0010), o(-0.0115, 0.0055)] },
  ];
  db.zones = [
    { id: 'zn_1', name: 'Desborde margen del río, sector centro (ejemplo)', severity: 'alta', riverId: 'rv_1', depthCm: 40, active: true, note: 'Agua sobre la calzada. No ingresar.',
      coords: [o(0.0025, 0.0040), o(0.0020, 0.0060), o(-0.0035, 0.0064), o(-0.0040, 0.0046)] },
    { id: 'zn_2', name: 'Desborde barrio sur (ejemplo)', severity: 'media', riverId: 'rv_2', depthCm: 25, active: true, note: 'Anegamiento en calles interiores.',
      coords: [o(-0.0070, -0.0060), o(-0.0068, -0.0010), o(-0.0102, 0.0002), o(-0.0105, -0.0048)] },
  ];
  return db;
}

export function seedIfEmpty() {
  load();
  // Solo en una instalación nueva: si el equipo borró los ejemplos, no se vuelven a cargar.
  if (dbmod.createdNow) {
    // Hosting gratuito (Render) borra los archivos al reiniciar: si existe data/initial.json (un respaldo
    // descargado desde Admin → Configuración), se carga ese en lugar de los ejemplos.
    const initial = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'initial.json');
    if (fs.existsSync(initial)) {
      try { reset(JSON.parse(fs.readFileSync(initial, 'utf8'))); console.log('Base de datos nueva: se cargó data/initial.json.'); return; }
      catch (e) { console.error('data/initial.json no es válido:', e.message); }
    }
    reset(sampleData());
    console.log('Base de datos vacía: se cargaron datos de ejemplo de Santa Rosa (El Oro).');
  }
}

if (process.argv.includes('--force')) {
  reset(sampleData());
  console.log('Datos de ejemplo restaurados.');
}
