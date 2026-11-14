import { createMap } from './map-provider.js';
import { createGps } from './gps.js';
import { createNav } from './nav.js';
import { RIVER, ZSEV, LEVELS, LEVEL_DESC, STATUS, PTYPE, SEV, esc, ago, toast, ICON, waveSvg } from './common.js';

const $ = s => document.querySelector(s);
let map, state, radarOn = false, radarFrames = [], radarTimer = null, picking = false, pickMarker = null, pickPos = null;
const shapes = { streets: new Map(), routes: new Map(), rivers: new Map(), zones: new Map(), overflows: new Map() };

document.getElementById('band-wave').innerHTML = waveSvg;
$('#btn-full').innerHTML = ICON.expand; $('#band-more').innerHTML = ICON.chevron; $('#btn-report .fab-ic').innerHTML = ICON.drop;
$('#band').addEventListener('click', () => $('#band').classList.toggle('open'));
$('#btn-full').addEventListener('click', () => {
  const on = document.body.classList.toggle('map-full');
  $('#btn-full').innerHTML = on ? ICON.shrink : ICON.expand; $('#btn-full').setAttribute('aria-pressed', on);
  $('#btn-full').setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Ampliar mapa');
});
$('#btn-radar').innerHTML = ICON.radar; $('#btn-fit').innerHTML = ICON.eye; $('#btn-layers').innerHTML = ICON.layers;
$('#btn-gps').innerHTML = `${ICON.nav}<span class="gps-lbl">GPS</span>`; $('#gps-follow').innerHTML = ICON.nav; $('#gps-voice').innerHTML = ICON.volume; $('#gps-stop').innerHTML = ICON.x; document.querySelector('.sim-ic').innerHTML = ICON.play;
new MutationObserver(() => map?.invalidate()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
const hiddenLayers = new Set(JSON.parse((() => { try { return localStorage.getItem('av_hidden_layers'); } catch { return null; } })() || '[]'));
const gps = createGps({ getMap: () => map, getState: () => state, getShapes: () => shapes, getNav: () => nav });
const nav = createNav({ getMap: () => map, getState: () => state, getUser: () => gps.user, startGps: () => gps.start() });

async function load() {
  const res = await fetch('/api/public/state'); state = await res.json();
  const reports = await (await fetch('/api/public/reports')).json();
  if (!map) {
    map = await createMap({ provider: state.config.mapProvider, el: document.getElementById('map'), center: state.config.center, zoom: state.config.zoom, googleKey: state.config.googleMapsKey });
    map.onClick(onMapClick);
  }
  render(reports);
  gps.refresh(); nav.refresh();
}

function render(reports) {
  const { alert, weather, config } = state;
  const overflows = reports.filter(r => r.type === 'desborde');
  state.overflows = overflows;
  $('#city').textContent = `${config.city} · ${config.features?.routes === false ? 'calles inundadas y alertas' : 'calles inundadas y vías alternas'}`;
  $('#updated').textContent = `Actualizado ${ago(alert.updatedAt)} · ${alert.mode === 'auto' ? 'modo automático por clima' : 'activada manualmente'}`;

  // Banda de nivel
  const lvl = alert.effective; const band = $('#band');
  band.className = `level-band ${lvl}${band.classList.contains('open') ? ' open' : ''}`;
  $('#band-icon').innerHTML = lvl === 'normal' ? ICON.check : ICON.warn;
  $('#band-label').textContent = LEVELS[lvl];
  const lvlMsg = config.levelMessages?.[lvl] || LEVEL_DESC[lvl];
  $('#band-msg').innerHTML = `${esc(lvlMsg)}${alert.message ? `<span class="lvl-extra">${esc(alert.message)}</span>` : ''}`;

  // Clima
  const w = weather;
  $('#weather').innerHTML = w.ok ? `
    <div class="stat${w.raining ? ' rain' : ''}"><b>${w.rainNow} <small>mm</small></b><span>${esc(w.condition || 'Lluvia ahora')}</span></div>
    <div class="stat"><b>${w.rainPast3h} <small>mm</small></b><span>Últimas 3 h</span></div>
    <div class="stat"><b>${w.rainNext3h} <small>mm</small></b><span>Próximas 3 h</span></div>`
    : `<div class="stat" style="grid-column:1/-1;display:flex;gap:10px;align-items:center">${ICON.cloud}<span>Sin datos de clima por ahora. Las alertas manuales siguen activas.</span></div>`;
  $('#srcline').innerHTML = `${ICON.cloud} Clima: ${esc(w.source)}${w.ok ? ` · ${esc(w.condition || '')} · ${w.temperature}°C${w.probNext3h != null ? ` · prob. lluvia 3 h ${w.probNext3h}%` : ''} · umbral ${config.rainThresholdMm} mm/h` : ''} · nivel sugerido por clima: <span class="chip ${alert.suggested}">${LEVELS[alert.suggested]}</span>`;

  // Google Flood Forecasting
  const f = state.flood; const fc = $('#flood'); fc.hidden = !!f.disabled;
  fc.innerHTML = `${ICON.wave}<div><b>Ríos (Google Flood Forecasting)</b><br>${f.ok && f.gauges.length ? f.gauges.map(g => `${esc(g.river)}: ${esc(g.severity)}`).join(' · ') : f.configured ? 'Sin medidores con alerta en la zona.' : 'Pronóstico de ríos no configurado.'} <a href="${esc(f.hubUrl)}" target="_blank" rel="noopener">Ver en Flood Hub</a></div>`;

  // Listas
  const streets = [...state.streets].sort((a, b) => rank(a.status) - rank(b.status));
  $('#n-streets').textContent = streets.filter(s => s.status !== 'despejada').length;
  $('#n-routes').textContent = state.routes.length;
  const recs = state.recommendations.filter(r => r.level === 'normal' || lvlRank(r.level) <= lvlRank(lvl) || true);
  $('#n-recs').textContent = recs.length;
  const rivers = state.rivers || [], zones = state.zones || [];
  $('#n-rivers').textContent = rivers.filter(r => r.status !== 'normal').length + zones.length + overflows.length;
  $('#list-rivers').innerHTML = (rivers.length || zones.length || overflows.length) ? [
    ...overflows.map(o => `<button class="item" data-kind="overflows" data-id="${o.id}"><span class="dot roja" style="margin-top:6px"></span>
      <div><div class="title">Desborde reportado${o.street ? ` · ${esc(o.street)}` : ''}</div><div class="meta"><span class="chip roja">Activo</span> ${esc(o.description)} · ${ago(o.createdAt)}</div></div></button>`),
    ...rivers.map(r => `<button class="item" data-kind="rivers" data-id="${r.id}"><span class="dot rio_${r.status}" style="margin-top:6px"></span>
      <div><div class="title">${esc(r.name)}</div><div class="meta"><span class="chip rio_${r.status}">${RIVER[r.status]}</span> ${esc(r.note || '')}</div></div></button>`),
    ...(zones.length ? [`<h3 style="margin:8px 0 0">Zonas a donde se sale el agua</h3>`] : []),
    ...zones.map(z => `<button class="item" data-kind="zones" data-id="${z.id}"><span class="dot ${z.severity}" style="margin-top:6px"></span>
      <div><div class="title">${esc(z.name)}</div><div class="meta">Desborde · ${ZSEV[z.severity]}${z.depthCm ? ` · ~${z.depthCm} cm` : ''}${z.note ? ` · ${esc(z.note)}` : ''}</div></div></button>`)].join('')
    : empty(ICON.wave, 'Sin ríos registrados.', 'El equipo los dibujará desde el panel.');

  $('#list-streets').innerHTML = streets.length ? streets.map(s => `
    <button class="item" data-kind="streets" data-id="${s.id}"><span class="dot ${s.status}" style="margin-top:6px"></span>
      <div><div class="title">${esc(s.name)}</div><div class="meta">${STATUS[s.status]}${s.depthCm ? ` · ~${s.depthCm} cm de agua` : ''}${s.note ? ` · ${esc(s.note)}` : ''}</div></div></button>`).join('')
    : empty(ICON.check, 'No hay calles inundadas reportadas.', 'Las vías operan con normalidad.');
  $('#list-routes').innerHTML = state.routes.length ? state.routes.map(r => {
    const av = state.streets.find(s => s.id === r.avoids) || state.points.find(p => p.id === r.avoids);
    return `<button class="item" data-kind="routes" data-id="${r.id}"><span class="dot ruta" style="margin-top:6px"></span>
      <div><div class="title">${esc(r.name)}</div><div class="meta">${[r.from || r.to ? `${esc(r.from || '')} → ${esc(r.to || '')}` : '', av ? `evita ${esc(av.name)}` : ''].filter(Boolean).join(' · ')}</div><div class="meta" style="color:var(--ink);margin-top:4px">${esc(r.description || '')}</div></div></button>`; }).join('')
    : empty(ICON.route, 'No hay vías alternas publicadas.', 'Se mostrarán aquí cuando el equipo las active.');
  $('#list-recs').innerHTML = recs.length ? recs.sort((a, b) => lvlRank(b.level) - lvlRank(a.level)).map(r => `
    <div class="item" style="cursor:default"><span class="dot ${r.level}" style="margin-top:6px"></span><div><div class="title" style="font-weight:500">${esc(r.text)}</div><div class="meta"><span class="chip ${r.level}">${LEVELS[r.level]}</span></div></div></div>`).join('')
    : empty(ICON.info, 'Sin recomendaciones activas.', '');

  applyFeatures(config.features || {});
  // Índice de riesgo (estilo Amaru)
  renderRisk(state.risk);
  renderLayersPop();

  // Mapa
  map.clear(); shapes.streets.clear(); shapes.routes.clear();
  for (const l of state.layers || []) if (!hiddenLayers.has(l.id)) map.addGeoJSON({ data: l.geojson, color: l.color, name: l.name });
  for (const s of state.streets) shapes.streets.set(s.id, map.addPolyline({ coords: s.coords, status: s.status, popup: `<b>${esc(s.name)}</b><br>${STATUS[s.status]}${s.depthCm ? ` · ~${s.depthCm} cm` : ''}<br><span style="color:#5A6B7D">${esc(s.note || '')}</span>` }));
  shapes.rivers.clear(); shapes.zones.clear();
  for (const z of state.zones || []) shapes.zones.set(z.id, map.addPolygon({ coords: z.coords, severity: z.severity, popup: `<b>${esc(z.name)}</b><br>Zona de desborde · ${ZSEV[z.severity]}${z.depthCm ? ` · ~${z.depthCm} cm` : ''}<br><span style="color:#5A6B7D">${esc(z.note || '')}</span>` }));
  for (const r of state.rivers || []) shapes.rivers.set(r.id, map.addPolyline({ coords: r.coords, status: 'rio_' + r.status, flow: 'river', weight: 9, popup: `<b>${esc(r.name)}</b><br>${RIVER[r.status]}<br><span style="color:#5A6B7D">${esc(r.note || '')}</span>` }));
  for (const r of state.routes) shapes.routes.set(r.id, map.addPolyline({ coords: r.coords, status: 'ruta', flow: 'route', weight: 7, popup: `<b>Vía alterna: ${esc(r.name)}</b><br>${esc(r.description || '')}` }));
  for (const p of state.points) map.addMarker({ lat: p.lat, lng: p.lng, cls: p.severity, icon: p.type, pulse: p.severity === 'alta', popup: `<b>${esc(p.name)}</b><br><span class="chip ${p.severity === 'alta' ? 'roja' : p.severity === 'media' ? 'naranja' : 'accent'}">${PTYPE[p.type]} · ${SEV[p.severity]}</span><br>${esc(p.description || '')}` });
  shapes.overflows = new Map();
  for (const o of overflows) shapes.overflows.set(o.id, map.addOverflow({ lat: o.lat, lng: o.lng, iconSvg: ICON.wave,
    popup: `<b>Desborde de río</b><br>${esc(o.street || '')}<br>${esc(o.description)}<br><span style="color:#5A6B7D">Reportado ${ago(o.createdAt)} · verificado por EMOVTT</span>` }));
  renderOverflowBanner(overflows, rivers.filter(r => r.status === 'desbordado'));
  for (const r of reports.filter(r => r.type !== 'desborde')) map.addMarker({ lat: r.lat, lng: r.lng, cls: 'report', icon: 'report', popup: `<b>Reporte ciudadano verificado</b><br>${esc(r.street)} · ${esc(r.level)}<br>${esc(r.description)}<br><span style="color:#5A6B7D">${ago(r.createdAt)}</span>` });
  if (radarOn) applyRadar();
}
// Secciones que el equipo apagó en Admin → Configuración desaparecen del mapa público.
function applyFeatures(F) {
  const off = k => F[k] === false;
  $('#risk').hidden = off('risk'); $('#weather').hidden = off('weather'); $('#srcline').hidden = off('weather');
  $('#btn-gps').hidden = off('gps'); if (off('gps') && gps.on) gps.stop();
  $('#btn-radar').hidden = off('radar'); if (off('radar') && radarOn) { radarOn = false; $('#btn-radar').classList.remove('on'); clearInterval(radarTimer); map?.setRadar(null); }
  $('#btn-report').hidden = off('reports');
  const tabF = { streets: 'streets', routes: 'routes', rivers: 'rivers', recs: 'recommendations' };
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach(t => { t.hidden = off(tabF[t.dataset.tab]); });
  const vis = tabs.filter(t => !t.hidden);
  $('#tabs').hidden = !vis.length;
  const sel = tabs.find(t => t.getAttribute('aria-selected') === 'true');
  if (!vis.length) document.querySelectorAll('.pane').forEach(p => p.hidden = true);
  else if (!sel || sel.hidden) vis[0].click();
  else document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== `pane-${sel.dataset.tab}`);
  document.querySelectorAll('.legend [data-f]').forEach(s => { s.hidden = off(s.dataset.f); });
  document.querySelector('.legend').hidden = ![...document.querySelectorAll('.legend [data-f]')].some(s => !s.hidden);
}
function renderOverflowBanner(ovf, rivers) {
  const b = $('#ovf'); const n = ovf.length + rivers.length;
  if (!n) { b.hidden = true; b.dataset.key = ''; return; }
  const key = [...ovf, ...rivers].map(x => x.id).join(',');
  const where = [...rivers.map(r => r.name), ...ovf.map(o => o.street).filter(Boolean)].slice(0, 2).join(' · ');
  b.innerHTML = `<span class="ic">${ICON.wave}</span><span><b>${n > 1 ? `${n} desbordes activos` : 'Desborde de río activo'}</b><small>${esc(where || 'Ver en el mapa')} · aléjese de la orilla</small></span>`;
  if (b.dataset.key !== key) { b.hidden = false; b.style.animation = 'none'; void b.offsetWidth; b.style.animation = ''; }
  b.hidden = false; b.dataset.key = key;
}
$('#ovf').addEventListener('click', () => {
  const pts = [...(state.overflows || []).map(o => [o.lat, o.lng]), ...(state.rivers || []).filter(r => r.status === 'desbordado').flatMap(r => r.coords)];
  if (!pts.length) return;
  if (pts.length === 1) { map.panTo({ lat: pts[0][0], lng: pts[0][1] }, 16); setTimeout(() => [...shapes.overflows.values()][0]?.open?.(), 500); }
  else map.fitBounds(pts);
});
function renderRisk(r) {
  if (!r) return;
  const col = { normal: 'var(--normal)', amarilla: 'var(--amarilla)', naranja: 'var(--naranja)', roja: 'var(--roja)' }[r.level];
  const L = Math.PI * 54, k = r.value / 100;
  $('#risk').innerHTML = `
    <div class="risk-g" title="Índice de riesgo de inundación (0 a 100)">
      <svg viewBox="0 0 130 76"><path d="M11 70 A54 54 0 0 1 119 70" fill="none" stroke="var(--line)" stroke-width="12" stroke-linecap="round"/>
        <path d="M11 70 A54 54 0 0 1 119 70" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${L}" stroke-dashoffset="${L * (1 - k)}" style="transition:stroke-dashoffset 1s var(--ease)"/></svg>
      <div class="val">${r.value}<small>RIESGO / 100</small></div></div>
    <div class="risk-parts">${r.parts.map(p => `<div class="rp ${p.ok ? '' : 'off'}" title="${p.ok ? '' : 'Sin datos por ahora'}"><span>${p.label}</span><span class="bar"><i style="width:${(p.value / p.max) * 100}%;background:${col}"></i></span></div>`).join('')}</div>`;
}
function renderLayersPop() {
  const ls = state.layers || [];
  $('#btn-layers').hidden = !ls.length;
  $('#layers-pop').innerHTML = `<h3>Capas del mapa</h3>${ls.map(l => `<label><input type="checkbox" data-layer="${l.id}" ${hiddenLayers.has(l.id) ? '' : 'checked'}><span class="sw" style="background:${esc(l.color)}"></span>${esc(l.name)}</label>`).join('')}`;
  $('#layers-pop').querySelectorAll('[data-layer]').forEach(c => c.onchange = () => {
    c.checked ? hiddenLayers.delete(c.dataset.layer) : hiddenLayers.add(c.dataset.layer);
    try { localStorage.setItem('av_hidden_layers', JSON.stringify([...hiddenLayers])); } catch {}
    load();
  });
}
$('#btn-layers').addEventListener('click', e => { e.stopPropagation(); const p = $('#layers-pop'); p.hidden = !p.hidden; e.currentTarget.setAttribute('aria-expanded', !p.hidden); });
document.addEventListener('click', e => { const p = $('#layers-pop'); if (!p.hidden && !p.contains(e.target)) { p.hidden = true; $('#btn-layers').setAttribute('aria-expanded', 'false'); } });

const rank = s => ({ inundada: 0, parcial: 1, despejada: 2 }[s] ?? 3);
const lvlRank = l => ({ normal: 0, amarilla: 1, naranja: 2, roja: 3 }[l] ?? 0);
const empty = (icon, t, s) => `<div class="empty">${icon}<div style="font-weight:600;color:var(--ink)">${t}</div><div class="small">${s}</div></div>`;

// Tabs
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', x === t));
  document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== `pane-${t.dataset.tab}`);
}));
// Clic en lista → centrar en mapa
document.querySelector('.panel').addEventListener('click', e => {
  const it = e.target.closest('.item[data-id]'); if (!it) return;
  const sh = shapes[it.dataset.kind].get(it.dataset.id); const src = state[it.dataset.kind].find(x => x.id === it.dataset.id);
  if (it.dataset.kind === 'overflows') { map.panTo({ lat: src.lat, lng: src.lng }, 16); setTimeout(() => sh?.open?.(), 500); if (window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  document.querySelectorAll('.item.selected').forEach(x => x.classList.remove('selected')); it.classList.add('selected');
  map.fitBounds(src.coords); setTimeout(() => sh?.open?.(), 400);
  if (window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('#btn-fit').addEventListener('click', () => map.fitBounds([...state.streets, ...state.routes].flatMap(x => x.coords)));

// Radar RainViewer
async function applyRadar() {
  if (!radarFrames.length) { const r = await (await fetch('/api/public/radar')).json(); radarFrames = r.frames || []; if (!radarFrames.length) { toast('El radar de lluvia no está disponible ahora.', 'err'); radarOn = false; $('#btn-radar').classList.remove('on'); return; } }
  let i = 0; clearInterval(radarTimer);
  const step = () => { map.setRadar(radarFrames[i].url); i = (i + 1) % radarFrames.length; };
  step(); radarTimer = setInterval(step, 900);
}
$('#btn-radar').addEventListener('click', () => { radarOn = !radarOn; $('#btn-radar').classList.toggle('on', radarOn); if (radarOn) applyRadar(); else { clearInterval(radarTimer); map.setRadar(null); } });

// Reporte ciudadano
$('#btn-report').addEventListener('click', () => { picking = true; $('#picking').classList.add('on'); if (window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('#pick-cancel').addEventListener('click', stopPick);
function stopPick() { picking = false; $('#picking').classList.remove('on'); }
function onMapClick(pos) {
  if (nav.onMapClick(pos)) return;
  if (!picking) return; stopPick(); pickPos = pos;
  if (pickMarker) pickMarker.remove(); pickMarker = map.addMarker({ ...pos, cls: 'report', icon: 'report' });
  $('#r-coords').textContent = `Ubicación: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`;
  $('#sheet-bg').classList.add('open'); $('#r-street').focus();
}
let rType = 'inundacion';
document.querySelectorAll('[data-rtype]').forEach(btn => btn.addEventListener('click', () => {
  rType = btn.dataset.rtype;
  document.querySelectorAll('[data-rtype]').forEach(x => { x.classList.toggle('on', x === btn); x.setAttribute('aria-pressed', x === btn); });
  $('#r-title').textContent = rType === 'desborde' ? 'Reportar desborde de río' : 'Reportar calle inundada';
  $('#r-desc').placeholder = rType === 'desborde' ? 'Ej. El río se salió por la margen derecha y el agua llega a las casas.' : 'Ej. El agua cubre la vereda frente al parque y el bus no pasa.';
}));
const closeSheet = () => { $('#sheet-bg').classList.remove('open'); if (pickMarker) { pickMarker.remove(); pickMarker = null; } };
$('#r-cancel').addEventListener('click', closeSheet);
$('#sheet-bg').addEventListener('click', e => { if (e.target === e.currentTarget) closeSheet(); });
$('#report-form').addEventListener('submit', async e => {
  e.preventDefault(); $('#r-err').textContent = '';
  const body = { ...pickPos, type: rType, street: $('#r-street').value, level: $('#r-level').value, description: $('#r-desc').value };
  const r = await fetch('/api/public/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { $('#r-err').textContent = j.error; return; }
  closeSheet(); e.target.reset(); toast('Gracias. Tu reporte fue enviado y será revisado.', 'ok');
});

load().catch(err => { console.error(err); toast('No se pudo cargar la información. Reintenta en unos segundos.', 'err'); });
setInterval(() => load().catch(() => {}), 60000);
