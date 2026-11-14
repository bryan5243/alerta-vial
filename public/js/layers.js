// Convierte archivos de capas a GeoJSON en el navegador.
// Formatos: .geojson / .json, .kml, .kmz, Shapefile comprimido (.zip con .shp, .dbf, .prj)
const MAX_FEATURES = 8000;

export async function parseLayerFile(file) {
  const name = file.name.toLowerCase();
  let fc;
  if (name.endsWith('.geojson') || name.endsWith('.json')) fc = fromGeoJSON(JSON.parse(await file.text()));
  else if (name.endsWith('.kml')) fc = kmlToGeoJSON(await file.text());
  else if (name.endsWith('.kmz')) {
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const kml = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith('.kml'));
    if (!kml) throw new Error('El archivo KMZ no contiene un .kml adentro.');
    fc = kmlToGeoJSON(await kml.async('string'));
  } else if (name.endsWith('.zip')) {
    const out = await window.shp(await file.arrayBuffer());
    fc = Array.isArray(out) ? { type: 'FeatureCollection', features: out.flatMap(x => x.features) } : out;
  } else throw new Error('Formato no soportado. Usa GeoJSON, KML, KMZ o Shapefile en .zip.');

  fc.features = fc.features.filter(f => f && f.geometry);
  if (!fc.features.length) throw new Error('No se encontraron elementos con ubicación en el archivo.');
  if (fc.features.length > MAX_FEATURES) throw new Error(`La capa tiene ${fc.features.length} elementos; el máximo es ${MAX_FEATURES}. Recórtala a tu ciudad.`);
  if (!looksLikeLatLng(fc)) throw new Error('Las coordenadas no parecen estar en grados (WGS84). Exporta la capa en EPSG:4326 o incluye el archivo .prj en el .zip.');
  roundCoords(fc);
  return fc;
}

export function summarize(fc) {
  const c = { Point: 0, Line: 0, Polygon: 0 };
  for (const f of fc.features) { const t = f.geometry.type; if (t.includes('Point')) c.Point++; else if (t.includes('Line')) c.Line++; else if (t.includes('Polygon')) c.Polygon++; }
  return [c.Point && `${c.Point} puntos`, c.Line && `${c.Line} líneas`, c.Polygon && `${c.Polygon} zonas`].filter(Boolean).join(' · ');
}

function fromGeoJSON(j) {
  if (j.type === 'FeatureCollection') return j;
  if (j.type === 'Feature') return { type: 'FeatureCollection', features: [j] };
  if (j.type && j.coordinates) return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: j }] };
  throw new Error('El JSON no es un GeoJSON válido.');
}

function kmlToGeoJSON(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('El KML está dañado o no es XML válido.');
  const styles = {};
  doc.querySelectorAll('Style[id]').forEach(st => { const c = st.querySelector('LineStyle color, PolyStyle color, IconStyle color')?.textContent; if (c) styles['#' + st.id] = abgr(c); });
  const coords = el => el.textContent.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(a => a.length >= 2 && !isNaN(a[0])).map(([x, y]) => [x, y]);
  const geom = el => {
    switch (el.tagName) {
      case 'Point': return { type: 'Point', coordinates: coords(el.querySelector('coordinates'))[0] };
      case 'LineString': return { type: 'LineString', coordinates: coords(el.querySelector('coordinates')) };
      case 'Polygon': {
        const outer = el.querySelector('outerBoundaryIs coordinates'); const inner = [...el.querySelectorAll('innerBoundaryIs coordinates')];
        return { type: 'Polygon', coordinates: [coords(outer), ...inner.map(coords)] };
      }
      case 'MultiGeometry': return { type: 'GeometryCollection', geometries: [...el.children].map(geom).filter(Boolean) };
      default: return null;
    }
  };
  const features = [];
  doc.querySelectorAll('Placemark').forEach(pm => {
    const g = [...pm.children].map(geom).find(Boolean); if (!g) return;
    const props = { name: pm.querySelector(':scope > name')?.textContent?.trim() || '', description: (pm.querySelector(':scope > description')?.textContent || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 300) };
    pm.querySelectorAll('ExtendedData Data').forEach(d => { props[d.getAttribute('name')] = d.querySelector('value')?.textContent; });
    pm.querySelectorAll('ExtendedData SimpleData').forEach(d => { props[d.getAttribute('name')] = d.textContent; });
    const su = pm.querySelector('styleUrl')?.textContent; if (su && styles[su]) props.stroke = props.fill = styles[su];
    features.push({ type: 'Feature', properties: props, geometry: g });
  });
  return { type: 'FeatureCollection', features };
}
const abgr = c => { c = c.trim(); return c.length === 8 ? `#${c.slice(6, 8)}${c.slice(4, 6)}${c.slice(2, 4)}` : undefined; };

function eachCoord(g, fn) {
  if (!g) return;
  if (g.type === 'GeometryCollection') return g.geometries.forEach(x => eachCoord(x, fn));
  const walk = a => (typeof a[0] === 'number' ? fn(a) : a.forEach(walk));
  walk(g.coordinates);
}
function looksLikeLatLng(fc) {
  let ok = true, n = 0;
  for (const f of fc.features) { eachCoord(f.geometry, c => { if (n++ < 200 && (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) ok = false; }); if (n > 200) break; }
  return ok;
}
function roundCoords(fc) {
  for (const f of fc.features) eachCoord(f.geometry, c => { c[0] = +c[0].toFixed(6); c[1] = +c[1].toFixed(6); c.length = 2; });
}

// Extrae elementos importables: puntos → puntos críticos, líneas → calles
export function importable(fc) {
  const points = [], lines = [];
  for (const f of fc.features) {
    const g = f.geometry, nm = f.properties?.name || f.properties?.nombre || f.properties?.NOMBRE || '';
    if (g.type === 'Point') points.push({ name: nm || 'Punto importado', lat: g.coordinates[1], lng: g.coordinates[0], description: f.properties?.description || '' });
    if (g.type === 'LineString') lines.push({ name: nm || 'Calle importada', coords: g.coordinates.map(([x, y]) => [y, x]) });
    if (g.type === 'MultiLineString') g.coordinates.forEach((l, i) => lines.push({ name: `${nm || 'Calle importada'} ${i + 1}`, coords: l.map(([x, y]) => [y, x]) }));
  }
  return { points, lines };
}
