// Capa de abstracción de mapas. Cambia el proveedor desde el panel admin (Configuración).
//  - 'leaflet': Leaflet + OpenStreetMap (sin API key, por defecto)
//  - 'google' : Google Maps JavaScript API (requiere key)
// Ambos exponen la misma interfaz: addMarker, addPolyline, onClick, fitBounds, clear, setCenter, setRadar.

const COLORS = { inundada: '#C62E2E', parcial: '#E36A17', despejada: '#2A8C5A', ruta: '#0A6DAE', report: '#6B4DD6',
  rio_normal: '#2BA3E0', rio_crecido: '#1C7FD6', rio_desbordado: '#1565C0', osm: '#7FB8DE', osm_sel: '#1E88E5', nav: '#1B2B8B' };
const ZONE = { alta: '#C62E2E', media: '#E36A17', baja: '#E3B417' };
const ICONS = {
  inundacion: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  riesgo: '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  alcantarilla: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/>',
  report: '<path d="M4 4h16v12H7l-3 3z"/>',
  flag: '<path d="M6 21V4h11l-2 4 2 4H6"/>',
  nav: '<path d="M4 11 20 4l-7 16-2-7z"/>',
  interseccion: '<path d="M12 2v20M2 12h20"/><path d="M5 18c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0"/>',
};
export const pinHtml = (cls, icon) => `<div class="pin ${cls}"><svg viewBox="0 0 24 24">${ICONS[icon] || ICONS.inundacion}</svg></div>`;

export async function createMap({ provider = 'leaflet', el, center, zoom, googleKey }) {
  if (provider === 'google' && googleKey) {
    try { return await googleMap({ el, center, zoom, googleKey }); }
    catch (e) { console.warn('Google Maps no disponible, usando Leaflet.', e); }
  }
  return leafletMap({ el, center, zoom });
}

/* ---------------- Leaflet ---------------- */
function leafletMap({ el, center, zoom }) {
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], zoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  // Mapa base: OpenStreetMap oficial (gratis, sin API key).
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  // Aviso cuando los tiles no cargan (sin internet)
  const fb = document.createElement('div'); fb.className = 'map-fallback'; fb.textContent = 'Sin conexión al mapa base. Las capas de alerta siguen visibles.';
  el.appendChild(fb); tiles.on('load', () => fb.remove()); tiles.on('tileerror', () => { if (!el.contains(fb)) el.appendChild(fb); });
  const layers = L.layerGroup().addTo(map);
  let radar = null, clickCb = null;
  map.on('click', e => clickCb && clickCb({ lat: e.latlng.lat, lng: e.latlng.lng }));
  return {
    provider: 'leaflet', raw: map,
    addMarker({ lat, lng, cls, icon, popup, onClick, pulse }) {
      const m = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: pinHtml(cls + (pulse ? ' pulse' : ''), icon), iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] }) });
      if (popup) m.bindPopup(popup, { maxWidth: 260 });
      if (onClick) m.on('click', onClick);
      m.addTo(layers); return { remove: () => layers.removeLayer(m), open: () => m.openPopup() };
    },
    // flow: 'route' (vía alterna con flechas que avanzan) | 'river' (agua que corre)
    addPolyline({ coords, status, popup, onClick, dashed, weight, flow }) {
      const color = COLORS[status] || COLORS.ruta;
      const w = weight || 7;
      const halo = L.polyline(coords, { color: '#fff', weight: w + (flow === 'river' ? 6 : 4), opacity: flow === 'river' ? .55 : .9, className: flow ? `casing-${flow} ${status || ''}` : '' }).addTo(layers);
      const line = L.polyline(coords, { color, weight: w, opacity: .95, dashArray: dashed && !flow ? '10 10' : null, lineCap: 'round', lineJoin: 'round', className: flow ? `base-${flow} ${status || ''}` : '' }).addTo(layers);
      const over = flow ? L.polyline(coords, { color: '#fff', weight: flow === 'river' ? Math.max(2, w * .35) : Math.max(3, w * .5), opacity: flow === 'river' ? .75 : 1, lineCap: 'round', interactive: false, className: `flow-${flow} ${status || ''}` }).addTo(layers) : null;
      if (popup) line.bindPopup(popup, { maxWidth: 260 });
      if (onClick) line.on('click', onClick);
      return { remove: () => { layers.removeLayer(line); layers.removeLayer(halo); over && layers.removeLayer(over); }, open: () => line.openPopup(), bounds: () => line.getBounds(),
        addClass: c => { line.getElement()?.classList.add(c); halo.getElement()?.classList.add(c + '-halo'); line.bringToFront(); over?.bringToFront(); },
        removeClass: c => { line.getElement()?.classList.remove(c); halo.getElement()?.classList.remove(c + '-halo'); } };
    },
    addVertex({ lat, lng }) { const c = L.circleMarker([lat, lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#0B6E99', fillOpacity: 1 }).addTo(layers); return { remove: () => layers.removeLayer(c) }; },
    // Zona de desborde (polígono animado)
    addPolygon({ coords, severity = 'alta', popup, draft }) {
      const color = ZONE[severity] || ZONE.alta;
      const pg = L.polygon(coords, { color, weight: 2.5, fillColor: color, fillOpacity: .22, dashArray: '8 6', className: draft ? 'zone-draft' : `zone ${severity}` }).addTo(layers);
      if (popup) pg.bindPopup(popup, { maxWidth: 260 });
      return { remove: () => layers.removeLayer(pg), open: () => pg.openPopup(), bounds: () => pg.getBounds() };
    },
    // Capas subidas (GeoJSON). Se dibujan debajo de las alertas.
    addGeoJSON({ data, color = '#6B4DD6', name = '' }) {
      const g = L.geoJSON(data, {
        pane: 'overlayPane',
        style: f => ({ color: f.properties?.stroke || color, weight: f.properties?.['stroke-width'] || 3, opacity: .9, fillColor: f.properties?.fill || color, fillOpacity: f.properties?.['fill-opacity'] ?? .18 }),
        pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: f.properties?.['marker-color'] || color, fillOpacity: 1 }),
        onEachFeature: (f, l) => { const pr = f.properties || {}; const title = pr.name || pr.nombre || pr.NOMBRE || pr.Name || ''; const extra = Object.entries(pr).filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && !/^(name|nombre|stroke.*|fill.*|marker.*|styleUrl)$/i.test(k)).slice(0, 6).map(([k, v]) => `<br><span style="color:#5A6B7D">${k}:</span> ${String(v).slice(0, 80)}`).join(''); l.bindPopup(`<b>${title || name}</b>${title ? `<br><span style="color:#5A6B7D">${name}</span>` : ''}${extra}`, { maxWidth: 280 }); },
      });
      g.addTo(layers); g.bringToBack?.();
      return { remove: () => layers.removeLayer(g), bounds: () => g.getBounds() };
    },
    // Desborde activo: agua expandiéndose (persiste hasta que el equipo lo retire)
    addOverflow({ lat, lng, popup, iconSvg = '' }) {
      const m = L.marker([lat, lng], { zIndexOffset: 800, icon: L.divIcon({ className: '', iconSize: [0, 0], popupAnchor: [0, -18],
        html: `<div class="ovf"><span class="pool"></span><span class="rip"></span><span class="rip"></span><span class="rip"></span><span class="drop d1"></span><span class="drop d2"></span><span class="drop d3"></span><span class="core">${iconSvg}</span></div>` }) });
      if (popup) m.bindPopup(popup, { maxWidth: 260 });
      m.addTo(layers); return { remove: () => layers.removeLayer(m), open: () => m.openPopup() };
    },
    // Efecto de sonar (anillos) en un punto de peligro
    addPulse({ lat, lng, tone = 'roja' }) {
      const m = L.marker([lat, lng], { interactive: false, zIndexOffset: 900, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="sonar ${tone}"><i></i><i></i><i></i><b></b></div>` }) }).addTo(map);
      return { remove: () => map.removeLayer(m), move: (p) => m.setLatLng([p.lat, p.lng]), setTone: t => { const el = m.getElement()?.querySelector('.sonar'); if (el) el.className = `sonar ${t}`; } };
    },
    // Línea animada entre el usuario y el peligro
    addLink(a, b, tone = 'roja') {
      const l = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { className: `threat-link ${tone}`, weight: 3, interactive: false }).addTo(map);
      return { remove: () => map.removeLayer(l), set: (p, q, t) => { l.setLatLngs([[p.lat, p.lng], [q.lat, q.lng]]); const el = l.getElement(); if (el && t) el.setAttribute('class', `leaflet-interactive threat-link ${t}`); } };
    },
    // Marcador de ubicación del usuario (GPS) con flecha de rumbo y círculo de precisión
    addUser({ lat, lng }) {
      const acc = L.circle([lat, lng], { radius: 20, color: '#0B6E99', weight: 1, fillColor: '#0B6E99', fillOpacity: .12, interactive: false }).addTo(map);
      const m = L.marker([lat, lng], { zIndexOffset: 1000, interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="me"><span class="me-cone"></span><span class="me-dot"></span></div>' }) }).addTo(map);
      return {
        update({ lat, lng, accuracy, heading }) { m.setLatLng([lat, lng]); acc.setLatLng([lat, lng]); if (accuracy) acc.setRadius(Math.min(accuracy, 200)); const cone = m.getElement()?.querySelector('.me-cone'); if (cone) { cone.style.opacity = heading == null || isNaN(heading) ? 0 : 1; cone.style.transform = `translate(-50%,-100%) rotate(${heading || 0}deg)`; } },
        remove() { map.removeLayer(m); map.removeLayer(acc); },
      };
    },
    onClick(cb) { clickCb = cb; },
    clear() { layers.clearLayers(); },
    setCenter(c, z) { map.setView([c.lat, c.lng], z || map.getZoom()); },
    fitBounds(coords) { if (coords.length) map.fitBounds(L.latLngBounds(coords), { padding: [40, 40], maxZoom: 16 }); },
    panTo({ lat, lng }, z) { map.flyTo([lat, lng], z || Math.max(map.getZoom(), 15), { duration: .6 }); },
    setRadar(url) { if (radar) { map.removeLayer(radar); radar = null; } // RainViewer gratis solo entrega hasta zoom 7 (desde 2026): Leaflet amplía esos cuadros al acercarse.
      if (url) radar = L.tileLayer(url, { opacity: .6, zIndex: 400, maxNativeZoom: 7, maxZoom: 19, className: 'radar-tiles' }).addTo(map); },
    invalidate() { setTimeout(() => map.invalidateSize(), 50); },
  };
}

/* ---------------- Google Maps ---------------- */
function loadGoogle(key) {
  return new Promise((ok, ko) => {
    if (window.google?.maps) return ok();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=es&region=EC`;
    s.onload = ok; s.onerror = ko; document.head.appendChild(s);
    setTimeout(() => ko(new Error('timeout')), 10000);
  });
}
async function googleMap({ el, center, zoom, googleKey }) {
  await loadGoogle(googleKey);
  const g = window.google.maps;
  const map = new g.Map(el, { center, zoom, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false });
  let items = [], radar = null, clickCb = null, info = new g.InfoWindow();
  map.addListener('click', e => clickCb && clickCb({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
  const svgPin = (cls) => ({ path: 'M12 0C6.5 0 2 4.5 2 10c0 7 10 18 10 18s10-11 10-18C22 4.5 17.5 0 12 0z', fillColor: cls.includes('alta') || cls.includes('inundacion') ? '#C62E2E' : cls.includes('media') || cls.includes('riesgo') ? '#E36A17' : cls.includes('report') ? '#6B4DD6' : '#0B6E99', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 1.3, anchor: new g.Point(12, 28) });
  return {
    provider: 'google', raw: map,
    addMarker({ lat, lng, cls, popup, onClick }) {
      const m = new g.Marker({ position: { lat, lng }, map, icon: svgPin(cls || '') });
      m.addListener('click', (e) => { if (popup) { info.setContent(popup); info.open({ anchor: m, map }); } onClick && onClick(e); });
      items.push(m); return { remove: () => m.setMap(null), open: () => { info.setContent(popup); info.open({ anchor: m, map }); } };
    },
    addPolyline({ coords, status, popup, onClick, dashed, weight, flow }) {
      const color = COLORS[status] || COLORS.ruta;
      const path = coords.map(([lat, lng]) => ({ lat, lng }));
      const halo = new g.Polyline({ path, map, strokeColor: '#fff', strokeWeight: (weight || 7) + 4, strokeOpacity: .9 });
      const flowIcons = flow === 'route' ? [{ icon: { path: g.SymbolPath.FORWARD_OPEN_ARROW, strokeColor: '#fff', strokeWeight: 2, scale: 2 }, offset: '0', repeat: '28px' }]
        : flow === 'river' ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: .8, strokeColor: '#fff', scale: 2 }, offset: '0', repeat: '30px' }] : null;
      const line = new g.Polyline({ path, map, strokeColor: color, strokeWeight: weight || 7, strokeOpacity: dashed && !flow ? 0 : .95,
        icons: flowIcons || (dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: color, scale: 4 }, offset: '0', repeat: '20px' }] : []) });
      let flowAnim = null;
      if (flowIcons) { let off = 0; const rep = flow === 'route' ? 28 : 30; flowAnim = setInterval(() => { off = (off + 1) % rep; const ic = line.get('icons'); if (ic?.[0]) { ic[0].offset = off + 'px'; line.set('icons', ic); } }, flow === 'route' ? 40 : 70); }
      line.addListener('click', (e) => { if (popup) { info.setContent(popup); info.setPosition(e.latLng); info.open(map); } onClick && onClick(e); });
      items.push(halo, line);
      let anim = null;
      return { remove: () => { halo.setMap(null); line.setMap(null); clearInterval(anim); clearInterval(flowAnim); }, open: () => { info.setContent(popup); info.setPosition(path[Math.floor(path.length / 2)]); info.open(map); },
        addClass: () => { let off = 0; line.setOptions({ strokeWeight: (weight || 7) + 3, zIndex: 50, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#fff', scale: 3 }, offset: '0', repeat: '24px' }] }); clearInterval(anim); anim = setInterval(() => { off = (off + 2) % 24; const ic = line.get('icons'); if (ic?.[0]) { ic[0].offset = off + 'px'; line.set('icons', ic); } }, 60); },
        removeClass: () => { clearInterval(anim); line.setOptions({ strokeWeight: weight || 7, icons: dashed ? line.get('icons') : [] }); } };
    },
    addVertex({ lat, lng }) { const c = new g.Marker({ position: { lat, lng }, map, icon: { path: g.SymbolPath.CIRCLE, scale: 6, fillColor: '#0B6E99', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } }); items.push(c); return { remove: () => c.setMap(null) }; },
    addPolygon({ coords, severity = 'alta', popup }) {
      const color = ZONE[severity] || ZONE.alta;
      const pg = new g.Polygon({ paths: coords.map(([lat, lng]) => ({ lat, lng })), map, strokeColor: color, strokeWeight: 2, fillColor: color, fillOpacity: .22 });
      let t = 0; const iv = setInterval(() => { t += .08; pg.setOptions({ fillOpacity: .16 + Math.abs(Math.sin(t)) * .2 }); }, 60);
      pg.addListener('click', e => { if (popup) { info.setContent(popup); info.setPosition(e.latLng); info.open(map); } });
      items.push({ setMap: v => { pg.setMap(v); clearInterval(iv); } });
      return { remove: () => { pg.setMap(null); clearInterval(iv); } };
    },
    addGeoJSON({ data, color = '#6B4DD6', name = '' }) {
      const layer = new g.Data({ map });
      layer.addGeoJson(data);
      layer.setStyle(f => ({ strokeColor: f.getProperty('stroke') || color, strokeWeight: 3, fillColor: f.getProperty('fill') || color, fillOpacity: .18, icon: { path: g.SymbolPath.CIRCLE, scale: 6, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } }));
      layer.addListener('click', e => { info.setContent(`<b>${e.feature.getProperty('name') || e.feature.getProperty('nombre') || name}</b><br><span style="color:#5A6B7D">${name}</span>`); info.setPosition(e.latLng); info.open(map); });
      items.push(layer); return { remove: () => layer.setMap(null) };
    },
    addOverflow({ lat, lng, popup }) {
      const pool = new g.Circle({ center: { lat, lng }, map, radius: 60, strokeOpacity: 0, fillColor: '#1E88E5', fillOpacity: .3, clickable: false });
      const rings = [0, 1, 2].map(i => new g.Circle({ center: { lat, lng }, map, radius: 10, strokeColor: i === 2 ? '#C62E2E' : '#1E88E5', strokeWeight: 2, fillOpacity: 0, clickable: false }));
      const m = new g.Marker({ position: { lat, lng }, map, zIndex: 800, icon: { path: g.SymbolPath.CIRCLE, scale: 10, fillColor: '#0B5FA5', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } });
      if (popup) m.addListener('click', () => { info.setContent(popup); info.open({ anchor: m, map }); });
      let t = 0; const iv = setInterval(() => { t += 1; rings.forEach((c, i) => { const p = ((t + i * 25) % 75) / 75; c.setRadius(15 + p * 180); c.setOptions({ strokeOpacity: 1 - p }); }); pool.setRadius(55 + Math.sin(t / 12) * 18); }, 40);
      const all = { setMap: v => { if (!v) { clearInterval(iv); [pool, ...rings, m].forEach(x => x.setMap(null)); } } };
      items.push(all); return { remove: () => all.setMap(null), open: () => { info.setContent(popup); info.open({ anchor: m, map }); } };
    },
    addPulse({ lat, lng }) {
      const circles = [0, 1, 2].map(() => new g.Circle({ center: { lat, lng }, map, radius: 10, strokeColor: '#C62E2E', strokeWeight: 2, fillOpacity: 0, clickable: false }));
      let t = 0; const iv = setInterval(() => { t += 1; circles.forEach((c, i) => { const p = ((t + i * 20) % 60) / 60; c.setRadius(10 + p * 120); c.setOptions({ strokeOpacity: 1 - p }); }); }, 40);
      return { remove: () => { clearInterval(iv); circles.forEach(c => c.setMap(null)); }, move: p => circles.forEach(c => c.setCenter(p)), setTone: t => circles.forEach(c => c.setOptions({ strokeColor: t === 'roja' ? '#C62E2E' : '#E36A17' })) };
    },
    addLink(a, b) {
      const l = new g.Polyline({ path: [a, b], map, strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#C62E2E', scale: 3 }, offset: '0', repeat: '14px' }] });
      return { remove: () => l.setMap(null), set: (p, q) => l.setPath([p, q]) };
    },
    addUser({ lat, lng }) {
      const acc = new g.Circle({ center: { lat, lng }, radius: 20, map, strokeColor: '#0B6E99', strokeWeight: 1, fillColor: '#0B6E99', fillOpacity: .12, clickable: false });
      const m = new g.Marker({ position: { lat, lng }, map, zIndex: 999, icon: { path: g.SymbolPath.CIRCLE, scale: 8, fillColor: '#0B6E99', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } });
      return { update({ lat, lng, accuracy, heading }) { m.setPosition({ lat, lng }); acc.setCenter({ lat, lng }); if (accuracy) acc.setRadius(Math.min(accuracy, 200)); if (heading != null && !isNaN(heading)) m.setIcon({ path: g.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, rotation: heading, fillColor: '#0B6E99', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }); }, remove() { m.setMap(null); acc.setMap(null); } };
    },
    onClick(cb) { clickCb = cb; },
    clear() { items.forEach(i => i.setMap(null)); items = []; info.close(); },
    setCenter(c, z) { map.setCenter(c); if (z) map.setZoom(z); },
    fitBounds(coords) { if (!coords.length) return; const b = new g.LatLngBounds(); coords.forEach(([lat, lng]) => b.extend({ lat, lng })); map.fitBounds(b, 40); },
    panTo({ lat, lng }, z) { map.panTo({ lat, lng }); if (z) map.setZoom(Math.max(map.getZoom(), z)); },
    setRadar(url) {
      if (radar) { const i = map.overlayMapTypes.getArray().indexOf(radar); if (i >= 0) map.overlayMapTypes.removeAt(i); radar = null; }
      if (url) { radar = new g.ImageMapType({ getTileUrl: (c, z) => z <= 7 ? url.replace('{z}', z).replace('{x}', c.x).replace('{y}', c.y) : null, tileSize: new g.Size(256, 256), opacity: .6 }); map.overlayMapTypes.push(radar); }
    },
    invalidate() { g.event.trigger(map, 'resize'); },
  };
}
