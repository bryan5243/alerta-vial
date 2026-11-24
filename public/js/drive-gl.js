// Vista de conducción 3D con MapLibre GL (WebGL), como la de Google Maps.
// La inclinación, el giro y el zoom los dibuja la tarjeta gráfica: el mapa llena toda la pantalla hasta el horizonte
// (los cuadros lejanos se piden en menor detalle), el zoom con dos dedos es continuo y las rutas nunca se recortan.
// Las capas (ruta, calles inundadas, zonas, puntos críticos) se copian del registro del mapa normal (scene).
let libP = null;
function loadLib() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  return libP ||= new Promise((ok, ko) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/maplibre/maplibre-gl.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = '/vendor/maplibre/maplibre-gl.js'; s.async = true;
    const fail = e => { libP = null; s.remove(); ko(e); };
    s.onload = () => window.maplibregl ? ok(window.maplibregl) : fail(new Error('maplibre'));
    s.onerror = () => fail(new Error('No se pudo cargar la vista 3D'));
    setTimeout(() => !window.maplibregl && fail(new Error('timeout')), 25000);
    document.head.appendChild(s);
  });
}
// ¿El teléfono tiene WebGL? (sin WebGL se usa la vista de respaldo)
let webgl = null;
export function hasWebGL() {
  if (webgl != null) return webgl;
  try { const c = document.createElement('canvas'), x = c.getContext('webgl2') || c.getContext('webgl'); webgl = !!x; x?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { webgl = false; }
  return webgl;
}

const EMPTY = { type: 'FeatureCollection', features: [] };
const W = k => ['interpolate', ['exponential', 1.6], ['zoom'], 12, ['*', ['get', k], .38], 15, ['*', ['get', k], .8], 16, ['*', ['get', k], 1], 17.5, ['*', ['get', k], 1.45], 19, ['*', ['get', k], 2.1]];
const flip = c => [c[1], c[0]];
const ring = r => { const o = r.map(flip); const a = o[0], b = o[o.length - 1]; if (a && (a[0] !== b[0] || a[1] !== b[1])) o.push(a); return o; };

// Flecha blanca con borde para el sentido de la ruta (se dibuja una vez en un canvas)
function chevron() {
  const s = 48, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  g.lineCap = 'round'; g.lineJoin = 'round';
  const path = () => { g.beginPath(); g.moveTo(16, 11); g.lineTo(31, 24); g.lineTo(16, 37); };
  g.strokeStyle = 'rgba(14,31,107,.9)'; g.lineWidth = 11; path(); g.stroke();
  g.strokeStyle = '#fff'; g.lineWidth = 6; path(); g.stroke();
  return g.getImageData(0, 0, s, s);
}

export function createDriveGL({ wrap, scene, tiles, attr }) {
  let gl = null, el = null, lib = null, readyP = null, broken = false, shown = false;
  const marks = new Map(); // id del registro -> marcador de MapLibre
  const dirty = { main: true, live: true, geo: true, mk: true }; let tmr = 0, popup = null;

  function style() {
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles, tileSize: 256, maxzoom: 19, attribution: attr } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#E9EEF2' } },
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 120 } },
      ],
    };
  }
  function addLayers() {
    gl.addImage('av-chev', chevron(), { pixelRatio: 2 });
    for (const s of ['av-geo', 'av-main', 'av-live']) gl.addSource(s, { type: 'geojson', data: EMPTY, tolerance: .3, buffer: 64 });
    const isLine = ['==', ['get', 'k'], 'line'], notNav = ['!=', ['get', 'nav'], 1], nav = ['==', ['get', 'nav'], 1];
    const L = (id, src, filter, layout, paint, type = 'line') => gl.addLayer({ id, type, source: src, ...(filter ? { filter } : {}), layout, paint });
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    // Capas subidas (GIS)
    L('geo-fill', 'av-geo', ['==', ['geometry-type'], 'Polygon'], {}, { 'fill-color': ['coalesce', ['get', 'fill'], ['get', '_c']], 'fill-opacity': ['coalesce', ['get', 'fill-opacity'], .18] }, 'fill');
    L('geo-line', 'av-geo', ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'Polygon']], round, { 'line-color': ['coalesce', ['get', 'stroke'], ['get', '_c']], 'line-width': 2.5, 'line-opacity': .9 });
    L('geo-pt', 'av-geo', ['==', ['geometry-type'], 'Point'], {}, { 'circle-radius': 6, 'circle-color': ['coalesce', ['get', 'marker-color'], ['get', '_c']], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' }, 'circle');
    // Zonas de desborde
    L('zone-fill', 'av-main', ['==', ['get', 'k'], 'poly'], {}, { 'fill-color': ['get', 'c'], 'fill-opacity': .22 }, 'fill');
    L('zone-line', 'av-main', ['==', ['get', 'k'], 'poly'], round, { 'line-color': ['get', 'c'], 'line-width': 2.5, 'line-dasharray': [3, 2] });
    // Calles, ríos y vías alternas: borde + línea; resaltado con brillo cuando es el peligro activo
    L('hl-glow', 'av-main', ['all', isLine, ['==', ['get', 'hl'], 1]], round, { 'line-color': ['get', 'c'], 'line-width': W('hw'), 'line-blur': 10, 'line-opacity': .55, 'line-gap-width': 0 });
    L('casing', 'av-main', ['all', isLine, notNav], { ...round, 'line-sort-key': ['get', 'z'] }, { 'line-color': ['get', 'hc'], 'line-width': W('hw'), 'line-opacity': ['get', 'hop'] });
    L('main', 'av-main', ['all', isLine, notNav, ['!=', ['get', 'dash'], 1]], { ...round, 'line-sort-key': ['get', 'z'] }, { 'line-color': ['get', 'c'], 'line-width': W('w'), 'line-opacity': ['get', 'op'] });
    L('main-dash', 'av-main', ['all', isLine, notNav, ['==', ['get', 'dash'], 1]], { 'line-join': 'round' }, { 'line-color': ['get', 'c'], 'line-width': W('w'), 'line-opacity': ['get', 'op'], 'line-dasharray': [1.4, 1.4] });
    L('arrows', 'av-main', ['all', isLine, notNav, ['==', ['get', 'flow'], 'route']], { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'av-chev', 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, .45, 16, .7, 18, 1], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true }, { 'icon-opacity': .9 }, 'symbol');
    // Tu ruta va siempre encima de todo
    L('nav-casing', 'av-main', ['all', isLine, nav], round, { 'line-color': '#0E1F6B', 'line-width': W('hw') });
    L('nav-main', 'av-main', ['all', isLine, nav], round, { 'line-color': '#3B6BFF', 'line-width': W('w') });
    L('nav-arrows', 'av-main', ['all', isLine, nav], { 'symbol-placement': 'line', 'symbol-spacing': 80, 'icon-image': 'av-chev', 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, .5, 16, .8, 18, 1.1], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true }, {}, 'symbol');
    // Línea al peligro más cercano
    L('live', 'av-live', null, { 'line-cap': 'round' }, { 'line-color': ['get', 'c'], 'line-width': 4, 'line-dasharray': [1, 1.6], 'line-opacity': .95 });
    // Zona táctil ancha (invisible) para tocar líneas con el dedo
    L('hit', 'av-main', ['all', isLine, ['==', ['get', 'tap'], 1]], round, { 'line-color': '#000', 'line-width': 26, 'line-opacity': .01 });
    gl.on('click', 'hit', e => { const f = scene.get(e.features?.[0]?.properties?.id); if (f) tap(f, e.lngLat); });
  }
  function tap(f, ll) {
    if (f.popup) { popup?.remove(); popup = new lib.Popup({ maxWidth: '260px', offset: f.t === 'pin' ? [0, -30] : f.t === 'html' ? [0, -16] : 8, className: 'drive-pop' }).setLngLat(ll).setHTML(f.popup).addTo(gl); }
    f.onClick?.();
  }
  function lineProps(f) {
    const p = { k: 'line', id: f.id, z: f.id + (f.status === 'osm' ? 0 : 1e5), c: f.color, w: f.w, hc: f.halo || '#fff', hw: f.hw || f.w + 4, hop: f.hop ?? .9, op: f.op ?? .95,
      dash: f.dash ? 1 : 0, flow: f.flow || '', nav: f.status === 'nav' ? 1 : 0, hl: f.cls?.has('hazard-flow') || f.cls?.has('route-flow') ? 1 : 0, tap: f.popup || f.onClick ? 1 : 0 };
    if (p.nav) { p.w = 10; p.hw = 15; }
    if (p.hl) { p.w *= 1.25; p.hw *= 1.25; p.z += 2e5; }
    return p;
  }
  function polyCoords(c) { return typeof c[0][0] === 'number' ? [ring(c)] : c.map(ring); }
  function build() {
    tmr = 0; if (!gl || !shown) return;
    if (dirty.main) {
      const fs = [];
      for (const f of scene.values()) {
        if (f.t === 'line' && !f.live && f.coords?.length > 1) fs.push({ type: 'Feature', properties: lineProps(f), geometry: { type: 'LineString', coordinates: f.coords.map(flip) } });
        else if (f.t === 'poly' && f.coords?.length > 2) fs.push({ type: 'Feature', properties: { k: 'poly', id: f.id, c: f.color }, geometry: { type: 'Polygon', coordinates: polyCoords(f.coords) } });
      }
      gl.getSource('av-main').setData({ type: 'FeatureCollection', features: fs });
    }
    if (dirty.live) {
      const fs = []; for (const f of scene.values()) if (f.live && f.coords?.length > 1) fs.push({ type: 'Feature', properties: { c: f.color }, geometry: { type: 'LineString', coordinates: f.coords.map(flip) } });
      gl.getSource('av-live').setData({ type: 'FeatureCollection', features: fs });
    }
    if (dirty.geo) {
      const fs = [];
      for (const f of scene.values()) if (f.t === 'geo') {
        const d = f.data, list = d?.type === 'FeatureCollection' ? d.features : d?.type === 'Feature' ? [d] : d?.type ? [{ type: 'Feature', properties: {}, geometry: d }] : [];
        for (const x of list || []) if (x?.geometry) {
          const g = x.geometry; const parts = g.type === 'MultiPolygon' ? g.coordinates.map(c => ({ type: 'Polygon', coordinates: c })) : g.type === 'MultiLineString' ? g.coordinates.map(c => ({ type: 'LineString', coordinates: c })) : g.type === 'MultiPoint' ? g.coordinates.map(c => ({ type: 'Point', coordinates: c })) : [g];
          for (const geometry of parts) fs.push({ type: 'Feature', properties: { ...(x.properties || {}), _c: f.color }, geometry });
        }
      }
      gl.getSource('av-geo').setData({ type: 'FeatureCollection', features: fs });
    }
    if (dirty.mk) {
      const seen = new Set();
      for (const f of scene.values()) {
        if (f.t !== 'pin' && f.t !== 'html') continue; seen.add(f.id);
        let m = marks.get(f.id);
        if (!m) {
          const node = document.createElement('div'); node.className = 'dgl-mk ' + (f.t === 'pin' ? 'dgl-pin' : 'dgl-0'); node.innerHTML = f.html(); node.style.zIndex = String(f.z || 1);
          if (f.popup || f.onClick) node.addEventListener('click', e => { e.stopPropagation(); tap(f, [f.lng, f.lat]); }); else node.style.pointerEvents = 'none';
          m = new lib.Marker({ element: node, anchor: f.t === 'pin' ? 'bottom' : 'center' }).setLngLat([f.lng, f.lat]).addTo(gl);
          marks.set(f.id, m); f.el = node;
        } else m.setLngLat([f.lng, f.lat]);
      }
      for (const [id, m] of marks) if (!seen.has(id)) { m.remove(); marks.delete(id); }
    }
    dirty.main = dirty.live = dirty.geo = dirty.mk = false;
  }
  const api = {
    get ready() { return !!gl; },
    get broken() { return broken; },
    init(center) {
      if (broken) return Promise.reject(new Error('sin webgl'));
      return readyP ||= loadLib().then(L => new Promise((ok, ko) => {
        lib = L;
        el = document.createElement('div'); el.className = 'drive-gl'; el.setAttribute('aria-hidden', 'true'); wrap.insertBefore(el, wrap.querySelector('.drive-horizon'));
        try {
          gl = new L.Map({ container: el, style: style(), center: [center.lng, center.lat], zoom: 16, pitch: 0, bearing: 0, attributionControl: false,
            dragPan: false, scrollZoom: false, boxZoom: false, dragRotate: false, keyboard: false, doubleClickZoom: false, touchZoomRotate: false, touchPitch: false,
            maxPitch: 62, minZoom: 3, maxZoom: 19.5, pixelRatio: Math.min(2, window.devicePixelRatio || 1), fadeDuration: 0, renderWorldCopies: false, refreshExpiredTiles: false, maxTileCacheSize: 300 });
        } catch (e) { broken = true; el.remove(); el = null; gl = null; return ko(e); }
        let done = false;
        gl.once('style.load', () => { try { addLayers(); } catch (e) { console.warn(e); } done = true; ok(api); });
        gl.on('error', e => { if (!done) console.warn('Vista 3D:', e?.error?.message || e); });
        el.addEventListener('webglcontextlost', () => console.warn('Vista 3D: contexto WebGL perdido'), true);
        setTimeout(() => { if (!done) { broken = true; try { gl.remove(); } catch {} el?.remove(); el = gl = null; ko(new Error('timeout')); } }, 12000);
      })).catch(e => { if (!broken) readyP = null; throw e; });
    },
    show() { if (!gl) return; shown = true; el.hidden = false; gl.resize(); dirty.main = dirty.live = dirty.geo = dirty.mk = true; build(); },
    hide() { shown = false; popup?.remove(); if (el) el.hidden = true; },
    // Algo cambió en las capas: se reconstruye en el siguiente momento libre (agrupa muchos cambios seguidos)
    touch(f) {
      if (!f) dirty.main = dirty.live = dirty.geo = dirty.mk = true;
      else if (f.t === 'pin' || f.t === 'html') dirty.mk = true; else if (f.t === 'geo') dirty.geo = true; else if (f.live) dirty.live = true; else dirty.main = true;
      if (shown && !tmr) tmr = setTimeout(build, f?.live ? 0 : 60);
    },
    move(f) { const m = marks.get(f.id); if (m) m.setLngLat([f.lng, f.lat]); },
    camera(c) { gl?.jumpTo(c); },
    resize() { gl?.resize(); },
    get el() { return el; }, get map() { return gl; },
    get size() { return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 }; },
  };
  return api;
}
