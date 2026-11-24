import { createMap } from './map-provider.js';
import { parseLayerFile, summarize, importable } from './layers.js';
import { fetchWaterways, KIND } from './osm-rivers.js';
import { autoDetoursFor, setNoCar } from './nav.js';
import { RIVER, ZSEV, LEVELS, STATUS, PTYPE, SEV, esc, ago, fmtTime, wxTime, toast, confirmBox, ICON, waveSvg, edgeFade, rainHours } from './common.js';

const root = document.getElementById('root');
let token = sessionStorage.getItem('av_token');
let db = null, map = null, section = 'alert', editing = null, drawMode = null, drawCoords = [], drawShapes = [], pickShape = null, pending = {};

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (r.status === 401) { token = null; sessionStorage.removeItem('av_token'); renderLogin(j.error); throw new Error('401'); }
  if (!r.ok) { toast(j.error || 'Algo salió mal.', 'err'); throw new Error(j.error); }
  return j;
};

/* ================= LOGIN ================= */
function renderLogin(err) {
  map = null;
  root.innerHTML = `<div class="login"><form class="card" id="login">
    <img src="/img/emovtt-logo.png" alt="EMOVTT Santa Rosa EP" style="height:64px;width:auto;margin:0 auto 18px;display:block">
    <h1 style="margin-bottom:4px">Panel de administración</h1><p class="muted small" style="margin-bottom:20px">Sistema de Alerta Vial · gestión de alertas, calles inundadas y desbordes</p>
    <div class="field"><label for="u">Usuario</label><input id="u" autocomplete="username" value="admin"></div>
    <div class="field"><label for="p">Contraseña</label><input id="p" type="password" autocomplete="current-password"><span class="err" id="lerr">${esc(err || '')}</span></div>
    <button class="btn" style="width:100%">Entrar al panel</button>
    <p class="small muted" style="margin-top:14px;text-align:center"><a href="/">Volver al mapa público</a></p></form></div>`;
  document.getElementById('login').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: e.target.u.value, password: e.target.p.value }) });
    const j = await r.json();
    if (!r.ok) { document.getElementById('lerr').textContent = j.error; return; }
    token = j.token; sessionStorage.setItem('av_token', token); boot();
  });
}

/* ================= SHELL ================= */
const NAV = [
  ['alert', 'Alerta', ICON.warn, 'Alerta'], ['points', 'Puntos críticos', ICON.pin, 'Puntos'], ['streets', 'Calles', ICON.drop, 'Calles'],
  ['routes', 'Vías alternas', ICON.route, 'Vías'], ['rivers', 'Ríos', ICON.wave, 'Ríos'], ['zones', 'Desbordes', ICON.drop, 'Desbordes'], ['recommendations', 'Recomendaciones', ICON.info, 'Consejos'], ['reports', 'Reportes', ICON.inbox, 'Reportes'], ['layers', 'Capas', ICON.layers, 'Capas'], ['navsim', 'Simular navegación', ICON.nav, 'Simular'], ['config', 'Configuración', ICON.settings, 'Ajustes'],
];
// En el celular la barra de abajo muestra 4 secciones principales y "Más" abre las demás
const MAIN_NAV = new Set(['alert', 'points', 'reports', 'routes']);
const ICON_MORE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>';
const HAS_MAP = { points: 1, streets: 1, routes: 1, rivers: 1, zones: 1, reports: 1, config: 1, layers: 1 };

async function boot() {
  try { db = await api('/api/admin/state'); } catch { return; }
  renderShell();
}
function renderShell() {
  const pend = (db.reports || []).filter(r => r.status === 'pendiente').length;
  root.innerHTML = `<div class="app">
    <nav class="side" aria-label="Secciones">
      <div class="brand"><img src="/img/emovtt-logo-blanco.png" alt="EMOVTT Santa Rosa EP"><div>SISTEMA DE ALERTA VIAL<small>ADMINISTRACIÓN</small></div></div>
      ${NAV.map(([k, l, i, sh]) => `<button class="navbtn ${k === section ? 'on' : ''} ${MAIN_NAV.has(k) ? '' : 'sec'}" data-s="${k}">${i}<span class="t"><span class="long">${l}</span><span class="short">${sh}</span></span>${k === 'reports' && pend ? `<span class="n">${pend}</span>` : ''}</button>`).join('')}
      <button class="navbtn more ${MAIN_NAV.has(section) ? '' : 'on'}" id="nav-more" aria-haspopup="dialog" aria-expanded="false">${ICON_MORE}<span class="t">${MAIN_NAV.has(section) ? 'Más' : esc(NAV.find(n => n[0] === section)?.[3] || 'Más')}</span></button>
      <div class="spacer"></div>
      <a class="navbtn sec" href="/" target="_blank">${ICON.eye}<span class="t"><span class="long">Ver mapa público</span><span class="short">Mapa</span></span></a>
      <button class="navbtn sec" id="logout">${ICON.logout}<span class="t">Salir</span></button>
    </nav>
    <div class="more-bg" id="more-bg" hidden><div class="more-sheet" role="dialog" aria-label="Más secciones"><div class="more-grab"></div><p class="more-t">Más secciones</p><div class="more-grid">
      ${NAV.filter(([k]) => !MAIN_NAV.has(k)).map(([k, l, i]) => `<button class="more-it ${k === section ? 'on' : ''}" data-s="${k}">${i}<span>${l}</span></button>`).join('')}
      <a class="more-it" href="/" target="_blank">${ICON.eye}<span>Ver mapa público</span></a>
      <button class="more-it" id="logout2">${ICON.logout}<span>Salir</span></button></div></div></div>
    <div class="content">
      <div class="topbar"><h2 id="title"></h2><span class="chip ${db.alert.effective}" id="top-level">${LEVELS[db.alert.effective]}</span><div class="spacer"></div><span class="small muted" id="top-weather"></span></div>
      <div class="work ${HAS_MAP[section] ? '' : 'nomap'}"><div class="col" id="col"></div>${HAS_MAP[section] ? `<div class="mapcol"><div id="map"></div><div class="draw-tools" id="tools"></div><div class="draw-hint" id="hint"></div></div>` : ''}</div>
    </div></div>`;
  root.querySelectorAll('.navbtn[data-s], .more-it[data-s]').forEach(b => b.addEventListener('click', () => { section = b.dataset.s; editing = null; cancelDraw(); renderShell(); }));
  const moreBg = document.getElementById('more-bg'), moreBtn = document.getElementById('nav-more');
  const moreOpen = on => { moreBg.hidden = !on; moreBtn.setAttribute('aria-expanded', on); requestAnimationFrame(() => moreBg.classList.toggle('open', on)); };
  moreBtn.addEventListener('click', () => moreOpen(moreBg.hidden));
  moreBg.addEventListener('click', e => { if (e.target === moreBg) moreOpen(false); });
  document.getElementById('logout2').addEventListener('click', () => document.getElementById('logout').click());
  document.getElementById('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); token = null; sessionStorage.removeItem('av_token'); renderLogin(); });
  topWeather();
  map = null;
  if (window.innerWidth <= 900) root.querySelector('.navbtn.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  edgeFade(root.querySelector('nav.side'));
  if (HAS_MAP[section]) initMap().then(renderSection); else renderSection();
}
async function initMap() {
  map = await createMap({ provider: db.config.mapProvider, el: document.getElementById('map'), center: db.config.center, zoom: db.config.zoom, googleKey: db.config.googleMapsKey, style: db.config.baseStyle });
  map.onClick(onMapClick);
}
async function refresh() { db = await api('/api/admin/state'); document.getElementById('top-level').className = `chip ${db.alert.effective}`; document.getElementById('top-level').textContent = LEVELS[db.alert.effective]; topWeather(); renderSection(); }
function topWeather() {
  const w = db.weather; document.getElementById('top-weather').textContent = w.ok ? `Clima: ${w.condition || '—'} · ${w.rainNow} mm/h${w.decidedBy ? ` (${w.decidedBy})` : ''}${w.sun?.uvIndex != null && w.sun.isDay ? ` · UV ${String(w.sun.uvIndex).replace('.', ',')} ${w.sun.uv.label.toLowerCase()}` : ''} · sugiere ${LEVELS[db.alert.suggested]}` : 'Clima no disponible (sin conexión con las fuentes)';
}

function renderSection() {
  document.getElementById('title').textContent = NAV.find(n => n[0] === section)[1];
  ({ alert: secAlert, points: secPoints, streets: secStreets, routes: secRoutes, rivers: secRivers, zones: secZones, recommendations: secRecs, reports: secReports, layers: secLayers, navsim: secNavSim, config: secConfig })[section]();
}

/* ================= ALERTA ================= */
function secAlert() {
  const a = db.alert, w = db.weather, cfg = db.config.weather, lm = db.config.levelMessages || {};
  col(`
    <div class="level-band ${a.effective}" style="border-radius:16px"><div class="lvl-icon">${a.effective === 'normal' ? ICON.check : ICON.warn}</div><div><div class="lvl-label">Publicado ahora: ${LEVELS[a.effective]}</div><div class="lvl-msg">${esc(lm[a.effective] || '')}${a.message ? ` · ${esc(a.message)}` : ''} · ${w.simulated ? 'Simulación de prueba' : a.mode === 'auto' ? 'Modo automático' : 'Manual'}</div></div><div class="wave">${waveSvg}</div></div>
    ${kpiRow()}
    <div class="alert-grid"><div class="ag-main">
    ${testsCard(a, w)}
    ${drainCard(a)}
    ${obsCard(a)}
    <div class="card">
      <h3 style="margin-bottom:12px">Modo de activación</h3>
      <div class="seg" role="radiogroup"><button class="${a.mode === 'auto' ? 'on' : ''}" data-mode="auto">Automático por clima</button><button class="${a.mode === 'manual' ? 'on' : ''}" data-mode="manual">Manual</button></div>
      <p class="small muted" style="margin-top:10px">${a.mode === 'auto' ? `El nivel se calcula con todas las fuentes de clima (la que vea la lluvia más fuerte): ≥ ${cfg.rainThresholdMm} mm/h o ≥ ${cfg.rainThresholdMm3h} mm en 3 h activa alerta naranja; el triple activa roja. Ahora sugiere <b>${LEVELS[a.suggested]}</b>.` : 'Tú decides el nivel. El clima solo se muestra como referencia.'}</p>
    </div>
    <div class="card">
      <h3 style="margin-bottom:12px">Nivel manual</h3>
      <div class="lvl-grid">${Object.entries(LEVELS).map(([k, l]) => `<button class="lvl-opt ${a.level === k ? 'on' : ''}" data-level="${k}" ${a.mode === 'auto' ? 'disabled style="opacity:.5"' : ''}><span class="dot ${k}"></span>${l.replace('Alerta ', '').replace(/^./, c => c.toUpperCase())}</button>`).join('')}</div>
    </div>
    <div class="card">
      <div class="section-head"><h3>Mensaje por color de alerta</h3></div>
      <p class="small muted" style="margin:6px 0 14px">Cada color tiene su propio mensaje. El mapa público muestra el del nivel activo, sea automático o manual.</p>
      ${Object.entries(LEVELS).map(([k, l]) => `<div class="field lvlmsg ${k === a.effective ? 'cur' : ''}"><label for="lm-${k}"><span class="dot ${k}"></span> ${l}${k === a.effective ? ' <span class="chip accent">publicado ahora</span>' : ''}</label><textarea id="lm-${k}" maxlength="300" rows="2">${esc(lm[k] || '')}</textarea></div>`).join('')}
      <button class="btn" id="save-lm">Guardar mensajes</button>
    </div>
    <div class="card">
      <div class="field"><label for="msg">Aviso adicional (opcional)</label><textarea id="msg" maxlength="300" placeholder="Ej. Evite circular por Av. Orellana entre 14:00 y 18:00.">${esc(a.message)}</textarea><span class="hint">Se muestra debajo del mensaje del color. Déjalo vacío si no hace falta.</span></div>
      <button class="btn soft" id="save-msg">Guardar aviso</button>
    </div>
    ${simCard(w)}
    </div><aside class="ag-side" aria-label="Clima y riesgo">
    ${riskCard()}
    ${sourcesCard(w)}
    </aside></div>
  `);
  q('.kpis [data-go]').forEach(b => b.onclick = () => root.querySelector(`.navbtn[data-s="${b.dataset.go}"]`)?.click());
  q('[data-mode]').forEach(b => b.onclick = async () => {
    const r = await api('/api/admin/alert', { method: 'PUT', body: { mode: b.dataset.mode } });
    toast(b.dataset.mode === 'auto' ? `Automático: el semáforo sigue al pronóstico${r.simStopped ? ' · simulación apagada' : ''}` : 'Modo manual: tú eliges el nivel', 'ok'); refresh();
  });
  q('[data-level]').forEach(b => b.onclick = async () => { await api('/api/admin/alert', { method: 'PUT', body: { level: b.dataset.level } }); toast(`Nivel: ${LEVELS[b.dataset.level]}`, 'ok'); refresh(); });
  id('save-msg').onclick = async () => { await api('/api/admin/alert', { method: 'PUT', body: { message: id('msg').value } }); toast('Aviso guardado', 'ok'); refresh(); };
  bindSim(w); bindObs();
  id('save-lm').onclick = async () => { await api('/api/admin/config', { method: 'PUT', body: { levelMessages: Object.fromEntries(Object.keys(LEVELS).map(k => [k, id('lm-' + k).value])) } }); toast('Mensajes por color guardados', 'ok'); refresh(); };
}

/* ================= SIMULAR NAVEGACIÓN ================= */
let simView = 'phone';
function secNavSim() {
  col(`
    <div class="card navsim-help">
      <div class="section-head"><h3>${ICON.nav} Simulador de navegación</h3><a class="btn ghost sm" href="/?sim=1" target="_blank" rel="noopener">${ICON.eye} Abrir en otra pestaña</a></div>
      <ol class="navsim-steps">
        <li><b>Destino:</b> búscalo arriba o elígelo en el mapa.</li>
        <li><b>Salida:</b> toca en el mapa de dónde sale el vehículo.</li>
        <li><b>Simular:</b> el vehículo recorre la ruta. Verás los avisos del GPS, las vías alternas apareciendo al acercarte y los desvíos.</li>
      </ol>
      <p class="small muted">Marca "Ruta directa, sin esquivar" para que el vehículo vaya hacia una zona inundada y probar el aviso y el botón "Tomar desvío": el vehículo cambia de camino y sigue la ruta segura. Usa el simulador de lluvia (Alerta) para encender los puntos con alerta naranja. Nada de esto cambia lo que ve la ciudadanía.</p>
      <div class="seg navsim-view" role="radiogroup" aria-label="Tamaño de la vista"><button type="button" data-view="phone" class="${simView === 'phone' ? 'on' : ''}">Vista teléfono</button><button type="button" data-view="wide" class="${simView === 'wide' ? 'on' : ''}">Vista computadora</button></div>
    </div>
    <div class="navsim-frame ${simView}"><iframe src="/?sim=1" title="Simulador de navegación" allow="geolocation"></iframe></div>`);
  q('[data-view]').forEach(b => b.onclick = () => { simView = b.dataset.view; id('col').querySelector('.navsim-frame').className = `navsim-frame ${simView}`; q('[data-view]').forEach(x => x.classList.toggle('on', x === b)); });
}

/* ---------- Simulador de lluvia (pruebas) ---------- */
const SIM = {
  seco: ['Sin lluvia', 0, 0, 0, 10, 0], llovizna: ['Llovizna', 0.2, 0.5, 0.5, 60, 51], leve: ['Lluvia leve', 1, 2, 2, 70, 61],
  moderada: ['Lluvia moderada', 4, 9, 6, 85, 63], fuerte: ['Lluvia fuerte', 12, 30, 20, 95, 65], tormenta: ['Tormenta', 35, 80, 40, 100, 95],
};
const WCODES = { 0: 'Sin lluvia (despejado)', 51: 'Llovizna', 61: 'Lluvia leve', 63: 'Lluvia moderada', 65: 'Lluvia fuerte', 80: 'Chubascos leves', 82: 'Chubascos fuertes', 95: 'Tormenta eléctrica' };
// "Está lloviendo ahora": el equipo confirma la lluvia que ve en la calle
const OBS = [[1, 'Leve', 'Llovizna o lluvia suave'], [2, 'Moderada', 'Lluvia constante'], [3, 'Fuerte', 'Aguacero, calles con agua'], [4, 'Tormenta', 'Con truenos y rayos']];
function obsCard(a) {
  const o = a.observed && new Date(a.observed.until) > Date.now() ? a.observed : null;
  const until = o ? wxTime(o.until) : '';
  return `<div class="card obs-card${o ? ' on' : ''}">
    <div class="section-head"><h3>${ICON.cloud} ¿Está lloviendo ahora en Santa Rosa?</h3>${o ? `<span class="chip naranja">Marcado: ${OBS[o.intensity - 1][1]} · hasta ${until}</span>` : ''}</div>
    <p class="small muted" style="margin:6px 0 12px">Si llueve y el sistema no lo detecta, márcalo aquí. Cuenta como una fuente más del clima (la del equipo EMOVTT) y el semáforo sube solo según la intensidad; se apaga sola al terminar el tiempo. No dice "simulación": es lluvia real.</p>
    <div class="obs-opts">${OBS.map(([i, l, d]) => `<button type="button" class="obs-opt${o?.intensity === i ? ' on' : ''}" data-obs="${i}"><b>${l}</b><small>${d}</small></button>`).join('')}</div>
    <div class="sim-foot"><label class="small" for="obs-min">Durante</label><select id="obs-min">${[[60, '1 hora'], [120, '2 horas'], [180, '3 horas'], [360, '6 horas']].map(([m, l]) => `<option value="${m}" ${m === 120 ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${o ? `<button type="button" class="btn ghost" id="obs-off">Ya no llueve</button>` : ''}</div>
  </div>`;
}
// Pruebas encendidas (simulación, lluvia marcada, modo manual, nivel arrastrado): un solo botón las apaga todas
function testsCard(a, w) {
  const on = [];
  if (w.simulated) on.push('simulación de lluvia');
  if (a.observed && new Date(a.observed.until) > Date.now()) on.push('lluvia marcada por el equipo');
  if (a.mode === 'manual') on.push(`modo manual (${LEVELS[a.level]})`);
  if (!on.length && a.effective !== a.suggested) on.push(`nivel ${LEVELS[a.effective]} que baja de a poco (el clima ahora sugiere ${LEVELS[a.suggested]})`);
  if (!on.length) return '';
  return `<div class="card tests-card" style="border-color:var(--naranja,#E36A17)">
    <div class="section-head"><h3>${ICON.warn} El mapa no muestra solo el clima real</h3></div>
    <p class="small muted" style="margin:6px 0 12px">Activo ahora: <b>${on.map(esc).join(', ')}</b>. Pulsa el botón para apagar todas las pruebas y publicar lo que dicen las fuentes del clima en este momento.</p>
    <div class="sim-foot"><button type="button" class="btn" id="reset-real">Apagar todas las pruebas</button></div>
  </div>`;
}
// Tiempo de drenaje: el equipo puede darlo por terminado si el agua bajó antes de lo previsto
function drainCard(a) {
  if (!a.draining) return '';
  const until = a.drainUntil ? wxTime(a.drainUntil) : '';
  return `<div class="card drain-card">
    <div class="section-head"><h3>${ICON.cloud} El agua aún está bajando</h3>${until ? `<span class="chip naranja">Puntos activos hasta ${until}</span>` : ''}</div>
    <p class="small muted" style="margin:6px 0 12px">Ya no llueve, pero los puntos críticos automáticos${a.drainPoints ? ` (${a.drainPoints})` : ''} y sus vías alternas siguen publicados mientras drena el agua. Si en la calle ya está despejado, apágalos ahora; se volverán a encender solos con la próxima alerta naranja o roja.</p>
    <div class="sim-foot"><button type="button" class="btn" id="drain-end">El agua ya bajó: apagar puntos</button></div>
  </div>`;
}
function bindObs() {
  const rr = id('reset-real'); if (rr) rr.onclick = async () => {
    if (!await confirmBox({ title: 'Volver al clima real', text: 'Se apagan la simulación de lluvia, la lluvia marcada por el equipo y el modo manual. El semáforo pasa a lo que dicen las fuentes del clima ahora.', ok: 'Apagar pruebas', tone: 'warn', icon: ICON.check })) return;
    try { const r = await api('/api/admin/reset-real', { method: 'POST' }); toast(`Clima real: ${LEVELS[r.effective]}${r.done.length ? ' · apagado: ' + r.done.join(', ') : ''}`, 'ok'); } catch {}
    refresh();
  };
  const de = id('drain-end'); if (de) de.onclick = async () => {
    if (!await confirmBox({ title: 'Apagar puntos críticos', text: 'Los puntos críticos automáticos y sus vías alternas dejarán de verse en el mapa. Se encenderán otra vez solos con la próxima alerta naranja o roja.', ok: 'Apagar puntos', tone: 'warn', icon: ICON.check })) return;
    try { const r = await api('/api/admin/drain-end', { method: 'POST' }); toast(r.turnedOff ? `Listo: ${r.turnedOff} punto(s) apagados` : 'Listo: drenaje terminado', 'ok'); } catch {}
    refresh();
  };
  q('[data-obs]').forEach(b => b.onclick = async () => { await api('/api/admin/observed', { method: 'PUT', body: { intensity: +b.dataset.obs, minutes: +id('obs-min').value } }); toast(`Lluvia ${OBS[b.dataset.obs - 1][1].toLowerCase()} marcada por el equipo`, 'ok'); refresh(); });
  const off = id('obs-off'); if (off) off.onclick = async () => { await api('/api/admin/observed', { method: 'PUT', body: { intensity: 0 } }); toast('Listo: el clima vuelve a las fuentes en línea', 'ok'); refresh(); };
}
// Resumen de un vistazo al entrar al panel: cada ficha lleva a su sección
function kpiRow() {
  const w = db.weather, r = db.risk, LV = { normal: 0, amarilla: 1, naranja: 2, roja: 3 }, dec = n => String(n).replace('.', ',');
  const flooded = db.streets.filter(s => s.active && s.status !== 'despejada').length;
  const ptsOn = db.points.filter(p => p.active || (p.auto && LV[db.alert.effective] >= 2)).length;
  const pend = (db.reports || []).filter(x => x.status === 'pendiente').length;
  const t = (cls, go, v, unit, label, bar) => `<button type="button" class="gl ${cls}"${go ? ` data-go="${go}"` : ''}><span class="gl-v"><b>${v}</b>${unit ? `<small>${unit}</small>` : ''}</span><span class="gl-l">${label}</span>${bar != null ? `<span class="gl-bar"><i style="width:${bar}%"></i></span>` : ''}</button>`;
  return `<div class="kpis" aria-label="Resumen del sistema">
    ${r ? t(`lv-${r.level}`, '', r.value, '/100', 'Riesgo', r.value) : ''}
    ${!w.ok ? t('', '', '–', '', 'Clima sin dato') : w.intensity > 0 ? t('rain wet', '', dec(w.rainNow), 'mm/h', 'Lloviendo ahora') : t(`rain${w.probNext3h >= 80 ? ' on' : ''}`, '', w.probNext3h ?? '–', '%', 'Lluvia 3 h', w.probNext3h ?? 0)}
    ${t(`st${flooded ? ' on' : ' ok'}`, 'streets', flooded, flooded === 1 ? 'calle' : 'calles', 'Inundadas')}
    ${t('', 'points', ptsOn, `de ${db.points.length}`, 'Puntos activos')}
    ${t('', 'routes', db.routes.length, '', 'Vías alternas')}
    ${t(pend ? 'pend' : '', 'reports', pend, pend === 1 ? 'reporte' : 'reportes', 'Por revisar')}</div>`;
}
// De qué está hecho el índice de riesgo (0 a 100)
function riskCard() {
  const r = db.risk; if (!r) return '';
  const c = { normal: 'var(--normal)', amarilla: 'var(--amarilla)', naranja: 'var(--naranja)', roja: 'var(--roja)' }[r.level];
  return `<div class="card"><div class="section-head"><h3>Índice de riesgo</h3><span class="chip ${r.level}" style="margin-left:auto">${r.value} de 100</span></div>
    <div class="risk-parts rp3" style="margin-top:12px">${r.parts.map(p => `<div class="rp"><span>${esc(p.label)}</span><span class="bar"><i style="width:${p.ok ? (p.value / p.max) * 100 : 0}%;background:${c}"></i></span><span class="rp-v">${p.ok ? `${p.value}/${p.max}` : 'sin dato'}</span></div>`).join('')}</div>
    <p class="small muted" style="margin-top:10px">Suma lluvia, pronóstico, ríos, reportes y marea. Amarilla desde 30, naranja desde 50 y roja desde 70.</p></div>`;
}
// Qué dice cada fuente, a qué hora, y cuál decidió el semáforo
function sourcesCard(w) {
  const src = w.sources || [];
  const row = s => {
    const st = s.disabled ? 'off' : !s.ok ? 'err' : s.intensity >= 3 ? 'hi' : s.intensity > 0 ? 'mid' : 'ok';
    const val = s.disabled ? 'No configurada' : !s.ok ? `Sin dato: ${esc(s.error || 'no disponible')}` : `${['Sin lluvia', 'Lluvia leve', 'Lluvia moderada', 'Lluvia fuerte', 'Tormenta'][s.intensity || 0]}${s.rainNow ? ` · ${s.rainNow} mm/h` : ''}`;
    return `<div class="src-row ${st}${w.decidedBy && w.decidedBy === s.name ? ' top' : ''}"><i></i><div><b>${esc(s.name)}</b> <small>${esc(s.kind || '')}${s.at && s.ok ? ` · dato de las ${wxTime(s.at)}` : ''}</small><div class="small">${val}</div>${s.detail && s.ok ? `<div class="small muted">${esc(s.detail)}</div>` : ''}${s.raw ? `<code>${esc(s.raw)}</code>` : ''}
      ${s.models ? `<details><summary class="small">Ver cada modelo</summary><div class="kv" style="margin-top:6px">${s.models.map(m => `<b>${esc(m.name)}</b><span>${m.ok ? `${m.rainNow} mm/h` : `sin dato (${esc(m.error || '')})`}</span>`).join('')}</div></details>` : ''}</div>
      ${w.decidedBy && w.decidedBy === s.name ? '<span class="chip accent">decide el nivel</span>' : ''}</div>`;
  };
  return `<div class="card"><div class="section-head"><h3>Fuentes del clima</h3><span class="small muted">revisado a las ${wxTime(w.checkedAt || new Date().toISOString())}</span></div>
    <p class="small muted" style="margin:6px 0 12px">${w.ok ? `Resultado: <b>${esc(w.condition || '—')}</b>${w.intensity ? ` (intensidad ${w.intensity}/4)` : ''} · ${w.rainNow} mm/h ahora · ${w.rainPast3h} mm en 3 h · próximas 3 h ${w.rainNext3h} mm${w.probNext3h != null ? ` (probabilidad ${w.probNext3h} %)` : ''} · ${w.temperature ?? '—'} °C.` : 'Ninguna fuente responde ahora. Si está lloviendo, márcalo arriba o pon la alerta en manual.'} Gana la fuente que vea la lluvia más fuerte. Los modelos son pronósticos y a veces no ven los aguaceros locales; las observaciones (aeropuerto, equipo, reportes) mandan cuando existen.</p>
    ${w.ok && w.hourly?.length >= 3 ? `<div class="wx-card adm-hours">${rainHours(w)}<p class="small muted" style="margin:8px 0 0">Probabilidad de cada hora: la mayor entre la que publican los modelos y la parte de los modelos que prevén lluvia. Es lo mismo que ve la ciudadanía.</p></div>` : ''}
    <div class="src-list">${src.map(row).join('') || '<p class="small muted">Sin datos.</p>'}</div></div>`;
}
function simCard(w) {
  const on = !!w.simulated, v = on ? w : { rainNow: 1, rainPast3h: 2, rainNext3h: 2, probNext3h: 70, weatherCode: 61 };
  const until = on ? new Date(w.simUntil).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }) : '';
  return `<div class="card sim-card${on ? ' on' : ''}">
    <div class="section-head"><h3>${ICON.cloud} Simulador de lluvia (pruebas)</h3>${on ? `<span class="chip naranja">Simulación activa · hasta ${until}</span>` : ''}</div>
    <p class="small muted" style="margin:6px 0 12px">Prueba cómo reacciona el sistema sin esperar a que llueva: el nivel de alerta, los puntos que se encienden con naranja, sus vías alternas, el mapa público y el GPS. Mientras dura, el nivel publicado sigue a la simulación aunque estés en modo manual, y el mapa público muestra "Simulación de prueba". Se apaga sola al terminar el tiempo.</p>
    <div class="sim-presets">${Object.entries(SIM).map(([k, p]) => `<button type="button" class="btn sm ghost${on && w.weatherCode === p[5] && w.rainNow === p[1] ? ' on' : ''}" data-sim="${k}">${p[0]}</button>`).join('')}</div>
    <details class="sim-adv"${on ? ' open' : ''}><summary>Valores a mano</summary>
      <div class="sim-grid">
        <div class="field"><label for="sim-now">Lluvia ahora (mm/h)</label><input id="sim-now" type="number" min="0" step="0.1" value="${v.rainNow}"></div>
        <div class="field"><label for="sim-p3">Últimas 3 h (mm)</label><input id="sim-p3" type="number" min="0" step="0.1" value="${v.rainPast3h}"></div>
        <div class="field"><label for="sim-n3">Próximas 3 h (mm)</label><input id="sim-n3" type="number" min="0" step="0.1" value="${v.rainNext3h}"></div>
        <div class="field"><label for="sim-prob">Probabilidad (%)</label><input id="sim-prob" type="number" min="0" max="100" value="${v.probNext3h ?? 0}"></div>
        <div class="field"><label for="sim-code">Cómo se ve el cielo</label><select id="sim-code">${Object.entries(WCODES).map(([c, l]) => `<option value="${c}" ${+c === +v.weatherCode ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div></details>
    <div class="sim-foot">
      <label class="small" for="sim-min">Duración</label><select id="sim-min">${[15, 30, 60, 120].map(m => `<option value="${m}" ${m === 30 ? 'selected' : ''}>${m} min</option>`).join('')}</select>
      <button type="button" class="btn" id="sim-go">${on ? 'Aplicar cambios' : 'Iniciar simulación'}</button>
      ${on ? `<button type="button" class="btn ghost" id="sim-stop">Detener</button>` : ''}
    </div>
    ${on ? `<p class="sim-res">Resultado: <b>${esc(w.condition)}</b> · nivel publicado <span class="chip ${db.alert.effective}">${LEVELS[db.alert.effective]}</span> · riesgo ${db.risk?.value ?? '—'}/100</p>` : ''}
  </div>`;
}
function bindSim() {
  const start = async (vals, label) => {
    await api('/api/admin/simulation', { method: 'PUT', body: { active: true, ...vals, minutes: +id('sim-min').value } });
    toast(`Simulación: ${label}`, 'ok'); refresh();
  };
  q('[data-sim]').forEach(b => b.onclick = () => { const [l, rainNow, rainPast3h, rainNext3h, probNext3h, weatherCode] = SIM[b.dataset.sim]; start({ preset: b.dataset.sim, rainNow, rainPast3h, rainNext3h, probNext3h, weatherCode }, l); });
  id('sim-go').onclick = () => start({ preset: 'manual', rainNow: +id('sim-now').value, rainPast3h: +id('sim-p3').value, rainNext3h: +id('sim-n3').value, probNext3h: +id('sim-prob').value, weatherCode: +id('sim-code').value }, 'valores a mano');
  const st = id('sim-stop'); if (st) st.onclick = async () => { await api('/api/admin/simulation', { method: 'PUT', body: { active: false } }); toast('Simulación detenida: vuelve el clima real', 'ok'); refresh(); };
}

/* ================= PUNTOS ================= */
function secPoints() {
  const e = editing || {};
  col(`
    <div class="card"><div class="section-head"><h3>${e.id ? 'Editar punto crítico' : 'Nuevo punto crítico'}</h3>${e.id ? `<button class="btn ghost sm" id="cancel">Cancelar</button>` : ''}</div>
      <p class="small muted" style="margin:6px 0 14px">Haz clic en el mapa para ubicar el punto. Luego completa los datos.</p>
      <form id="f" novalidate>
        <div class="field"><label for="name">Nombre</label><input id="name" value="${esc(e.name || '')}" placeholder="Ej. Paso a desnivel Av. de las Américas"></div>
        <div class="row"><div class="field"><label for="type">Tipo</label><select id="type">${opts(PTYPE, e.type || 'inundacion')}</select></div>
        <div class="field"><label for="sev">Severidad</label><select id="sev">${opts(SEV, e.severity || 'alta')}</select></div></div>
        <div class="field"><label for="desc">Descripción</label><textarea id="desc" placeholder="Qué pasa y qué debe hacer la gente">${esc(e.description || '')}</textarea></div>
        <p class="small muted" id="pos" style="margin-bottom:12px">${e.lat != null ? `Ubicación: ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}` : 'Aún sin ubicación: toca el mapa.'}</p>
        <div class="form-foot"><button class="btn">${e.id ? 'Guardar cambios' : 'Crear punto'}</button><label class="switch"><input type="checkbox" id="active" ${e.active !== false ? 'checked' : ''}> Activo ahora (visible y con aviso GPS)</label></div>
        <label class="switch" style="margin-top:10px"><input type="checkbox" id="auto" ${e.auto ? 'checked' : ''}> Activarlo solo cuando la alerta sea naranja o roja</label>
      </form></div>
    <div class="section-head"><h3>Puntos registrados (${db.points.length})</h3>${db.points.length ? `<span class="small muted">${db.points.filter(p => p.active).length} activos ahora${db.alert.effective === 'naranja' || db.alert.effective === 'roja' ? ` · ${db.points.filter(p => !p.active && p.auto).length} encendidos por la alerta` : ''}</span>` : ''}</div>
    ${db.points.length ? bulkBar('points', true) : ''}
    ${db.points.length ? `<div class="card auto-card"><div><b>${ICON.route} Vías alternas automáticas</b><small>Para cada punto sin vía alterna, el sistema busca por las calles reales un desvío que no pase por ningún punto de riesgo. Cada vía queda ligada a su punto: aparece sola cuando el punto se activa.</small></div>
      <button class="btn" id="auto-routes">${db.points.filter(p => !db.routes.some(r => r.avoids === p.id)).length ? `Generar para ${db.points.filter(p => !db.routes.some(r => r.avoids === p.id)).length} puntos` : 'Todos tienen vía alterna'}</button></div>` : ''}
    <p class="small muted" style="margin:-4px 0 4px">Enciende el interruptor cuando el punto esté inundado: aparece en el mapa, el GPS avisa y se muestra su vía alterna.</p>
    <div class="list">${db.points.length ? db.points.map(pointRow).join('') : emptyBox('Aún no hay puntos críticos. Toca el mapa para ubicar el primero, o conviértelos desde una capa KMZ en Capas.')}</div>`);
  pending = { lat: e.lat, lng: e.lng };
  drawMode = 'point'; setTools([]); hint('Toca el mapa para ubicar el punto crítico');
  drawAll(); if (e.lat != null) setPick(e);
  id('f').onsubmit = async ev => { ev.preventDefault(); const body = { name: id('name').value, type: id('type').value, severity: id('sev').value, description: id('desc').value, active: id('active').checked, auto: id('auto').checked, lat: pending.lat, lng: pending.lng };
    await save('points', body); };
  q('[data-pon]').forEach(cb => { cb.onclick = ev => ev.stopPropagation(); cb.onchange = async () => { await api(`/api/admin/points/${cb.dataset.pon}`, { method: 'PUT', body: { active: cb.checked } }); toast(cb.checked ? 'Punto activado: visible, con aviso GPS y su vía alterna' : 'Punto desactivado', 'ok'); refresh(); }; });
  q('[data-mkroute]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const p = db.points.find(x => x.id === b.dataset.mkroute); editing = { name: `Desvío por ${p.name}`, avoids: p.id, active: true }; section = 'routes'; renderShell(); setTimeout(() => map?.panTo(p, 17), 300); });
  bindBulk('points');
  if (id('auto-routes')) id('auto-routes').onclick = () => genAuto(db.points.filter(p => !db.routes.some(r => r.avoids === p.id)), id('auto-routes'));
  q('[data-autoroute]').forEach(b => b.onclick = ev => { ev.stopPropagation(); genAuto([db.points.find(x => x.id === b.dataset.autoroute)], b); });
  bindList('points');
}

// Genera y guarda vías alternas automáticas (OSRM) para los puntos indicados
async function genAuto(points, btn) {
  if (!points.length) { toast('Todos los puntos ya tienen vía alterna.', 'ok'); return; }
  btn.disabled = true; let made = 0, none = [], i = 0;
  for (const p of points) {
    btn.textContent = `Generando ${++i} de ${points.length}…`;
    let list = [];
    setNoCar(db.config.noCar);
    try { list = await autoDetoursFor(p, db.points); } catch {}
    if (!list.length) none.push(p.name);
    // Un punto con vía alterna se enciende solo con alerta naranja/roja y se apaga cuando baja
    else if (!p.auto) { try { await api(`/api/admin/points/${p.id}`, { method: 'PUT', body: { auto: true, active: false } }); } catch {} }
    for (const d of list) {
      try { await api('/api/admin/routes', { method: 'POST', body: { name: `Desvío ${d.axis} · ${p.name}`, from: '', to: '', avoids: p.id, auto: true, active: true, coords: d.coords,
        description: `Desvío automático que evita ${p.name}${d.extra > 30 ? ` (unos ${Math.round(d.extra / 10) * 10} m más)` : ''}.` } }); made++; } catch {}
    }
  }
  toast(made ? `Se crearon ${made} vías alternas automáticas.${none.length ? ` Sin desvío posible para: ${none.slice(0, 3).join(', ')}${none.length > 3 ? '…' : ''}. Dibújalas a mano.` : ''}`
    : 'No se pudo generar ninguna vía. Revisa la conexión a internet (usa el servicio de rutas de OpenStreetMap).', made ? 'ok' : 'err');
  await refresh();
}
// Barra para activar o desactivar todo de una vez
function bulkBar(kind, withAuto) {
  return `<div class="bulk"><button class="btn soft sm" data-bulk="${kind}" data-v="1">${ICON.eye} Activar todos</button><button class="btn ghost sm" data-bulk="${kind}" data-v="0">${ICON.x} Desactivar todos</button>${withAuto ? `<button class="btn ghost sm" data-bulkauto="1" title="Todos se encienden solos cuando la alerta pase a naranja o roja">Auto con alerta naranja: todos</button><button class="btn ghost sm" data-bulkauto="0">Auto: ninguno</button>` : ''}</div>`;
}
function bindBulk(kind) {
  q(`[data-bulk="${kind}"]`).forEach(b => b.onclick = async () => {
    const on = b.dataset.v === '1';
    if (!on && !await confirmBox({ title: 'Desactivar todos', text: 'Dejarán de verse en el mapa público y el GPS no avisará por ellos. Puedes volver a activarlos cuando quieras.', ok: 'Desactivar todos', tone: 'warn', icon: ICON.eye })) return;
    const r = await api(`/api/admin/${kind}/bulk`, { method: 'PUT', body: { active: on } }); toast(`${r.updated} ${on ? 'activados' : 'desactivados'}`, 'ok'); refresh();
  });
  q('[data-bulkauto]').forEach(b => b.onclick = async () => {
    const on = b.dataset.bulkauto === '1';
    const r = await api('/api/admin/points/bulk', { method: 'PUT', body: { auto: on } }); toast(on ? `${r.updated} puntos se activarán solos con alerta naranja o roja` : 'Activación automática quitada', 'ok'); refresh();
  });
}
function pointRow(p) {
  const rts = db.routes.filter(r => r.avoids === p.id);
  const lit = !p.active && p.auto && ['naranja', 'roja'].includes(db.alert.effective);
  return `<div class="item pt-row ${p.active || lit ? 'on' : 'inactive'}" data-focus-kind="points" data-focus="${p.id}"><span class="dot ${p.severity}" style="margin-top:6px"></span>
    <div style="min-width:0;flex:1"><div class="title">${esc(p.name)}</div>
      <div class="meta">${PTYPE[p.type] || ''}${p.auto ? ' · <span class="chip amarilla">se activa con alerta naranja/roja</span>' : ''}</div>
      <div class="meta">${rts.length ? `${ICON.route} ${rts.length === 1 ? 'Vía alterna' : `${rts.length} vías alternas`}: ${rts.map(r => esc(r.name.replace(/ · .*$/, ''))).join(', ')}` : `<span class="pt-acts"><button class="btn soft sm" data-autoroute="${p.id}">${ICON.route} Generar automática</button><button class="btn ghost sm" data-mkroute="${p.id}">${ICON.edit} Dibujar a mano</button></span>`}</div></div>
    <label class="pt-switch" title="${p.active ? 'Inundado: activo' : 'Sin agua: inactivo'}"><input type="checkbox" data-pon="${p.id}" ${p.active ? 'checked' : ''} aria-label="Activo ${esc(p.name)}"><span class="tg"></span><small>${p.active ? 'Activo' : lit ? 'Por alerta' : 'Inactivo'}</small></label>
    <div class="acts"><button class="btn ghost" title="Editar" aria-label="Editar" data-edit="${p.id}">${ICON.edit}</button><button class="btn danger" title="Eliminar" aria-label="Eliminar" data-del="${p.id}">${ICON.trash}</button></div></div>`;
}

/* ================= CALLES / RUTAS ================= */
function secStreets() { secLine('streets'); }
function secRoutes() { secLine('routes'); }
function secLine(kind) {
  const e = editing || {}; const isStreet = kind === 'streets';
  col(`
    <div class="card"><div class="section-head"><h3>${e.id ? 'Editar' : 'Nueva'} ${isStreet ? 'calle inundada' : 'vía alterna'}</h3>${e.id ? `<button class="btn ghost sm" id="cancel">Cancelar</button>` : ''}</div>
      <p class="small muted" style="margin:6px 0 10px">Pulsa <b>Dibujar</b> y toca el mapa en el inicio, en las esquinas por donde debe pasar y en el final. Con <b>Seguir las calles</b> la línea va sola por las calles reales entre cada toque.</p>
      <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="snap" ${snapOn ? 'checked' : ''}> Seguir las calles automáticamente</label>
      <form id="f" novalidate>
        <div class="field"><label for="name">Nombre</label><input id="name" value="${esc(e.name || '')}" placeholder="${isStreet ? 'Ej. Av. Francisco de Orellana (Carrión → Bonín)' : 'Ej. Desvío por Av. Benjamín Rosales'}"></div>
        ${isStreet ? `<div class="row"><div class="field"><label for="status">Estado</label><select id="status">${opts(STATUS, e.status || 'inundada')}</select></div>
          <div class="field"><label for="depth">Agua aprox. (cm)</label><input id="depth" type="number" min="0" max="300" value="${e.depthCm ?? ''}"></div></div>
          <div class="field"><label for="note">Indicación</label><input id="note" value="${esc(e.note || '')}" placeholder="Ej. Cerrada en ambos sentidos. Use el paso superior."></div>`
        : `<div class="row"><div class="field"><label for="from">Desde</label><input id="from" value="${esc(e.from || '')}" placeholder="Alborada"></div><div class="field"><label for="to">Hasta</label><input id="to" value="${esc(e.to || '')}" placeholder="Centro"></div></div>
          <div class="field"><label for="avoids">Evita (punto crítico o calle)</label><select id="avoids"><option value="">— ninguno en particular —</option>
            ${db.points.length ? `<optgroup label="Puntos críticos e intersecciones">${db.points.map(p => `<option value="${p.id}" ${e.avoids === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>` : ''}
            ${db.streets.length ? `<optgroup label="Calles">${db.streets.map(x => `<option value="${x.id}" ${e.avoids === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : ''}</select>
            <span class="hint">Si eliges un punto o calle, esta vía solo aparece al público (y en el GPS) mientras ese punto esté activo.</span></div>
          <div class="field"><label for="desc">Instrucciones para el conductor</label><textarea id="desc" placeholder="Describe el recorrido paso a paso">${esc(e.description || '')}</textarea></div>`}
        <p class="small muted" id="pos" style="margin-bottom:12px">${(e.coords || []).length} puntos dibujados</p>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn">${e.id ? 'Guardar cambios' : (isStreet ? 'Publicar calle' : 'Publicar vía alterna')}</button><label class="switch"><input type="checkbox" id="active" ${e.active !== false ? 'checked' : ''}> Activa</label></div>
      </form></div>
    <h3>${isStreet ? 'Calles' : 'Vías alternas'} registradas (${db[kind].length})</h3>
    ${db[kind].length ? bulkBar(kind) : ''}
    <div class="list">${db[kind].length ? db[kind].map(x => itemRow(x, isStreet ? `${STATUS[x.status]}${x.depthCm ? ` · ~${x.depthCm} cm` : ''}` : `${esc(x.from || '')} → ${esc(x.to || '')}`, kind, isStreet ? x.status : 'ruta')).join('') : emptyBox(`Aún no hay ${isStreet ? 'calles' : 'vías alternas'}. Dibuja la primera sobre el mapa.`)}</div>`);
  drawCoords = [...(e.coords || [])]; drawMode = null; segStack = [];
  setTools([['draw', 'Dibujar', ICON.edit], ['undo', 'Deshacer', ICON.x], ['clear', 'Limpiar', ICON.trash]]);
  drawAll();
  id('snap').onchange = () => { snapOn = id('snap').checked; };
  if (!e.id && e.avoids) { const t = q('[data-tool="draw"]')[0]; t?.click(); }
  id('f').onsubmit = async ev => { ev.preventDefault();
    const body = isStreet ? { name: id('name').value, status: id('status').value, depthCm: +id('depth').value || 0, note: id('note').value, coords: drawCoords, active: id('active').checked }
      : { name: id('name').value, from: id('from').value, to: id('to').value, avoids: id('avoids').value, description: id('desc').value, coords: drawCoords, active: id('active').checked };
    await save(kind, body); };
  bindBulk(kind);
  bindList(kind);
}

/* ================= RÍOS ================= */
let osmFound = null, osmSel = new Set(), osmBusy = false;
function secRivers() {
  const e = editing || {}; db.rivers ||= [];
  const have = new Set(db.rivers.map(r => r.name.toLowerCase()));
  const c = db.config.center;
  col(`
    <div class="card osm-card"><div class="section-head"><h3>${ICON.wave} Ríos automáticos</h3></div>
      <p class="small muted" style="margin:6px 0 12px">Trae los ríos, esteros y canales reales de la zona desde OpenStreetMap, ya trazados y en el sentido del agua. Tú solo eliges cuáles mostrar y cambias su estado cuando crezcan.</p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="margin:0;min-width:150px"><label for="osm-km">Alrededor del centro</label><select id="osm-km"><option value="3">3 km</option><option value="5" selected>5 km</option><option value="8">8 km</option><option value="12">12 km</option></select></div>
        <label class="switch" style="margin-bottom:10px"><input type="checkbox" id="osm-streams" checked> Incluir esteros</label>
        <button class="btn" id="osm-go" ${osmBusy ? 'disabled' : ''}>${osmBusy ? 'Buscando…' : `${ICON.download || ICON.upload} Buscar ríos de la zona`}</button>
      </div>
      ${osmFound ? (osmFound.length ? `
        <div class="osm-list">${osmFound.map((w, i) => { const dup = have.has(w.name.toLowerCase()); return `<label class="osm-row ${dup ? 'dup' : ''}"><input type="checkbox" data-osm="${i}" ${osmSel.has(i) ? 'checked' : ''} ${dup ? 'disabled' : ''}><span class="osm-sw ${w.kind}"></span><span><b>${esc(w.name)}</b><small>${KIND[w.kind] || w.kind} · ${w.km} km${dup ? ' · ya agregado' : ''}</small></span></label>`; }).join('')}</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px"><button class="btn" id="osm-add" ${osmSel.size ? '' : 'disabled'}>Agregar ${osmSel.size || ''} al mapa</button><button class="btn ghost sm" id="osm-all">Seleccionar todos</button><button class="btn ghost sm" id="osm-close">Cerrar</button></div>`
        : `<p class="small muted" style="margin-top:12px">No se encontraron cauces con nombre en ese radio. Prueba con un radio mayor.</p>`) : ''}
    </div>
    <h3>Ríos y canales en el mapa (${db.rivers.length})</h3>
    <p class="small muted" style="margin:-4px 0 4px">Cambia el estado aquí mismo: <b>crecido</b> y <b>desbordado</b> aceleran el agua y avisan al público.</p>
    <div class="list">${db.rivers.length ? db.rivers.map(x => itemRow(x, `<select class="rv-status" data-rstatus="${x.id}" aria-label="Estado de ${esc(x.name)}">${opts(RIVER, x.status)}</select> ${x.source === 'osm' ? '<span class="chip neutral">OpenStreetMap</span>' : ''} ${esc(x.note || '')}`, 'rivers', 'rio_' + x.status)).join('') : emptyBox('Aún no hay ríos. Pulsa “Buscar ríos de la zona” para traerlos automáticamente.')}</div>
    <details class="card manual" ${e.id ? 'open' : ''}><summary><b>${e.id ? `Editar “${esc(e.name)}”` : 'Trazar un cauce a mano'}</b> <span class="small muted">· solo si no aparece en la búsqueda</span></summary>
      ${e.id ? `<div style="text-align:right;margin-top:6px"><button class="btn ghost sm" id="cancel">Cancelar</button></div>` : ''}
      <p class="small muted" style="margin:10px 0 14px">Pulsa <b>Dibujar</b> y marca el cauce en el sentido en que corre el agua.</p>
      <form id="f" novalidate>
        <div class="field"><label for="name">Nombre</label><input id="name" value="${esc(e.name || '')}" placeholder="Ej. Río Santa Rosa"></div>
        <div class="field"><label for="status">Estado actual</label><select id="status">${opts(RIVER, e.status || 'normal')}</select></div>
        <div class="field"><label for="note">Observación</label><input id="note" value="${esc(e.note || '')}" placeholder="Ej. Nivel alto, vigilancia permanente."></div>
        <p class="small muted" id="pos" style="margin-bottom:12px">${(e.coords || []).length} puntos dibujados</p>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn">${e.id ? 'Guardar cambios' : 'Publicar río'}</button><label class="switch"><input type="checkbox" id="active" ${e.active !== false ? 'checked' : ''}> Visible</label></div>
      </form></details>`);
  drawCoords = [...(e.coords || [])]; drawMode = null;
  const man = document.querySelector('details.manual');
  const tools = () => setTools(man.open ? [['draw', 'Dibujar', ICON.edit], ['undo', 'Deshacer', ICON.x], ['clear', 'Limpiar', ICON.trash]] : []);
  man.addEventListener('toggle', tools); tools();
  drawAll();
  id('f').onsubmit = async ev => { ev.preventDefault(); await save('rivers', { name: id('name').value, status: id('status').value, note: id('note').value, coords: drawCoords, active: id('active').checked, source: e.source || 'manual' }); };
  id('osm-go').onclick = async () => {
    osmBusy = true; secRivers();
    try {
      osmFound = await fetchWaterways({ lat: c.lat, lng: c.lng, km: +id('osm-km').value, kinds: id('osm-streams').checked ? ['river', 'canal', 'stream'] : ['river', 'canal'] });
      osmSel = new Set(osmFound.map((w, i) => i).filter(i => osmFound[i].kind !== 'stream' && !have.has(osmFound[i].name.toLowerCase())));
      if (osmFound.length) map?.fitBounds(osmFound.flatMap(w => w.coords));
    } catch (err) { toast(err.message, 'err'); }
    osmBusy = false; secRivers();
  };
  q('[data-osm]').forEach(cb => cb.onchange = () => { cb.checked ? osmSel.add(+cb.dataset.osm) : osmSel.delete(+cb.dataset.osm); secRivers(); });
  if (id('osm-all')) id('osm-all').onclick = () => { osmFound.forEach((w, i) => { if (!have.has(w.name.toLowerCase())) osmSel.add(i); }); secRivers(); };
  if (id('osm-close')) id('osm-close').onclick = () => { osmFound = null; osmSel.clear(); secRivers(); };
  if (id('osm-add')) id('osm-add').onclick = async () => {
    const list = [...osmSel].map(i => osmFound[i]); let ok = 0;
    for (const w of list) { try { await api('/api/admin/rivers', { method: 'POST', body: { name: w.name, coords: w.coords, status: 'normal', note: '', active: true, source: 'osm', kind: w.kind } }); ok++; } catch {} }
    toast(`${ok} cauce${ok === 1 ? '' : 's'} agregado${ok === 1 ? '' : 's'} al mapa`, 'ok'); osmFound = null; osmSel.clear(); await refresh();
  };
  q('[data-rstatus]').forEach(sel => { sel.onclick = ev => ev.stopPropagation(); sel.onchange = async () => { await api(`/api/admin/rivers/${sel.dataset.rstatus}`, { method: 'PUT', body: { status: sel.value } }); toast(`${db.rivers.find(r => r.id === sel.dataset.rstatus)?.name}: ${RIVER[sel.value]}`, 'ok'); refresh(); }; });
  bindList('rivers');
}
function drawOsm() {
  if (!map || section !== 'rivers' || !osmFound) return;
  osmFound.forEach((w, i) => map.addPolyline({ coords: w.coords, status: osmSel.has(i) ? 'osm_sel' : 'osm', dashed: !osmSel.has(i), weight: osmSel.has(i) ? 6 : 4, popup: `<b>${esc(w.name)}</b><br>${KIND[w.kind] || ''} · ${w.km} km` }));
}

/* ================= ZONAS DE DESBORDE ================= */
function secZones() {
  const e = editing || {}; db.zones ||= []; db.rivers ||= [];
  col(`
    <div class="card"><div class="section-head"><h3>${e.id ? 'Editar zona de desborde' : 'Nueva zona de desborde'}</h3>${e.id ? `<button class="btn ghost sm" id="cancel">Cancelar</button>` : ''}</div>
      <p class="small muted" style="margin:6px 0 14px">Pulsa <b>Dibujar</b> y marca el contorno del área a donde se sale el agua (mínimo 3 puntos). El área se cierra sola. Quien navegue con GPS recibe un aviso al acercarse o entrar.</p>
      <form id="f" novalidate>
        <div class="field"><label for="name">Nombre</label><input id="name" value="${esc(e.name || '')}" placeholder="Ej. Desborde margen derecha, barrio Las Palmeras"></div>
        <div class="row"><div class="field"><label for="sev">Gravedad</label><select id="sev">${opts(ZSEV, e.severity || 'alta')}</select></div>
        <div class="field"><label for="depth">Agua aprox. (cm)</label><input id="depth" type="number" min="0" max="400" value="${e.depthCm ?? ''}"></div></div>
        <div class="field"><label for="river">Río que se desborda</label><select id="river"><option value="">— no especificado —</option>${db.rivers.map(r => `<option value="${r.id}" ${e.riverId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="note">Indicación</label><input id="note" value="${esc(e.note || '')}" placeholder="Ej. Agua sobre la calzada. No ingresar."></div>
        <p class="small muted" id="pos" style="margin-bottom:12px">${(e.coords || []).length} puntos dibujados</p>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn">${e.id ? 'Guardar cambios' : 'Publicar zona'}</button><label class="switch"><input type="checkbox" id="active" ${e.active !== false ? 'checked' : ''}> Activa</label></div>
      </form></div>
    <h3>Zonas de desborde (${db.zones.length})</h3>
    ${db.zones.length ? bulkBar('zones') : ''}
    <div class="list">${db.zones.length ? db.zones.map(x => itemRow(x, `${ZSEV[x.severity]}${x.depthCm ? ` · ~${x.depthCm} cm` : ''}${x.riverId ? ` · ${esc(db.rivers.find(r => r.id === x.riverId)?.name || '')}` : ''}`, 'zones', x.severity)).join('') : emptyBox('Aún no hay zonas de desborde. Dibuja la primera sobre el mapa.')}</div>`);
  drawCoords = [...(e.coords || [])]; drawMode = null;
  setTools([['draw', 'Dibujar', ICON.edit], ['undo', 'Deshacer', ICON.x], ['clear', 'Limpiar', ICON.trash]]);
  drawAll();
  id('f').onsubmit = async ev => { ev.preventDefault(); await save('zones', { name: id('name').value, severity: id('sev').value, depthCm: +id('depth').value || 0, riverId: id('river').value, note: id('note').value, coords: drawCoords, active: id('active').checked }); };
  bindBulk('zones');
  bindList('zones');
}

/* ================= RECOMENDACIONES ================= */
function secRecs() {
  const e = editing || {};
  col(`
    <div class="card"><div class="section-head"><h3>${e.id ? 'Editar recomendación' : 'Nueva recomendación'}</h3>${e.id ? `<button class="btn ghost sm" id="cancel">Cancelar</button>` : ''}</div>
      <form id="f" novalidate style="margin-top:12px">
        <div class="field"><label for="text">Texto</label><textarea id="text" maxlength="300" placeholder="Ej. No intente cruzar calles con agua en movimiento.">${esc(e.text || '')}</textarea></div>
        <div class="field"><label for="level">Nivel asociado</label><select id="level">${opts(LEVELS, e.level || 'naranja')}</select><span class="hint">Se muestra con la etiqueta del nivel en el mapa público.</span></div>
        <div class="form-foot"><button class="btn">${e.id ? 'Guardar cambios' : 'Publicar recomendación'}</button><label class="switch"><input type="checkbox" id="active" ${e.active !== false ? 'checked' : ''}> Activa</label></div>
      </form></div>
    <h3>Recomendaciones (${db.recommendations.length})</h3>
    <div class="list">${db.recommendations.map(r => itemRow({ ...r, name: r.text }, LEVELS[r.level], 'recommendations', r.level)).join('') || emptyBox('Sin recomendaciones todavía.')}</div>`);
  id('f').onsubmit = async ev => { ev.preventDefault(); await save('recommendations', { text: id('text').value, level: id('level').value, active: id('active').checked }); };
  bindList('recommendations');
}

/* ================= REPORTES ================= */
function secReports() {
  const reps = [...(db.reports || [])].sort((a, b) => (a.status === 'pendiente' ? -1 : 1) - (b.status === 'pendiente' ? -1 : 1) || b.createdAt.localeCompare(a.createdAt));
  const chip = s => ({ pendiente: 'amarilla', verificado: 'normal', descartado: 'neutral', retirado: 'neutral' })[s];
  const hasPt = r => r.pointId && db.points.some(p => p.id === r.pointId);
  const act = reps.filter(r => r.type === 'desborde' && r.status === 'verificado' && !hasPt(r));
  const loose = reps.filter(r => r.status === 'verificado' && !hasPt(r));
  col(`<p class="small muted">Reportes enviados por la ciudadanía desde el mapa público. Un reporte se ve en el mapa público solo durante <b>1 hora</b>. Al <b>aceptarlo</b> se convierte en <b>punto crítico de nivel medio</b> con su vía alterna: aparece cuando la alerta sube a <b>naranja o roja</b>, se retira <b>2 horas después de que para la lluvia</b> y queda guardado para las próximas lluvias. Los reportes no cambian el clima ni el semáforo.</p>
    ${loose.length ? `<div class="card" style="border-color:var(--naranja);background:#FFF6E8;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:200px"><b>${loose.length} reporte${loose.length > 1 ? 's' : ''} verificado${loose.length > 1 ? 's' : ''} todavía se ve${loose.length > 1 ? 'n' : ''} como reporte.</b> <span class="small muted">Conviértelos en puntos críticos automáticos.</span></span><button class="btn sm" id="crit-all">${ICON.pin} Convertir todos</button></div>` : ''}
    ${act.length ? `<div class="card" style="border-color:#1E88E5;background:#EEF6FE"><b>${act.length} desborde${act.length > 1 ? 's' : ''} activo${act.length > 1 ? 's' : ''} en el mapa público.</b> <span class="small muted">Retíralo cuando el agua haya bajado.</span></div>` : ''}
    <div class="list">${reps.length ? reps.map(r => `<div class="item" data-focus="${r.id}" style="cursor:pointer"><span class="dot ${r.level}" style="margin-top:6px"></span>
      <div style="flex:1"><div class="title">${r.type === 'desborde' ? `<span class="chip roja">Desborde de río</span> ` : ''}${esc(r.street || 'Sin calle indicada')} <span class="chip ${chip(r.status)}">${r.status}</span></div><div class="meta">${esc(r.description)}</div>${r.photo ? `<a href="${esc(r.photo)}" target="_blank" rel="noopener"><img src="${esc(r.photo)}" alt="Foto del reporte" loading="lazy" style="display:block;margin-top:8px;width:100%;max-width:240px;border-radius:10px;border:1px solid var(--line,#DDE3EA)"></a>` : '<div class="meta" style="color:var(--naranja)">Sin fotografía</div>'}<div class="meta">${ago(r.createdAt)} · ${fmtTime(r.createdAt)}${Date.now() - new Date(r.createdAt) >= 3600e3 ? ' · <b>ya no se ve en el mapa (pasó 1 h)</b>' : ''}</div>
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          ${hasPt(r) ? `<span class="chip naranja">${ICON.pin} Punto crítico (nivel medio) · se activa con naranja/roja</span>`
            : r.status !== 'descartado' ? `<button class="btn sm" data-crit="${r.id}" title="Crea un punto crítico que se activa solo con alerta naranja o roja, genera su vía alterna y deja de mostrarse como reporte">${ICON.check} Aceptar como punto crítico</button>` : ''}
          ${r.status === 'verificado' && !hasPt(r) ? `<button class="btn soft sm" data-rs="retirado" data-id="${r.id}">Retirar (el agua bajó)</button>` : ''}
          ${r.status !== 'descartado' && r.status !== 'retirado' && !hasPt(r) ? `<button class="btn ghost sm" data-rs="descartado" data-id="${r.id}">Descartar</button>` : ''}
          <button class="btn ghost sm" data-topoint="${r.id}">Editar como punto</button>
          <button class="btn danger sm" data-rdel="${r.id}">${ICON.trash}</button></div></div></div>`).join('') : emptyBox('No hay reportes ciudadanos todavía.')}</div>`);
  setTools([]); drawMode = null; drawAll(true);
  q('[data-rs]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); await api(`/api/admin/reports/${b.dataset.id}`, { method: 'PUT', body: { status: b.dataset.rs } }); toast(`Reporte ${b.dataset.rs}`, 'ok'); refresh(); });
  q('[data-rdel]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); if (!await confirmBox({ title: 'Eliminar reporte', text: 'El reporte se borrará definitivamente. Si solo quieres ocultarlo del mapa, usa "Retirar" o "Descartar".', ok: 'Eliminar' })) return; await api(`/api/admin/reports/${b.dataset.rdel}`, { method: 'DELETE' }); refresh(); });
  q('[data-topoint]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const r = db.reports.find(x => x.id === b.dataset.topoint); editing = { name: r.street, lat: r.lat, lng: r.lng, type: 'inundacion', severity: r.level === 'grave' ? 'alta' : r.level === 'moderado' ? 'media' : 'baja', description: r.description }; section = 'points'; renderShell(); });
  q('[data-focus]').forEach(b => b.onclick = () => { const r = db.reports.find(x => x.id === b.dataset.focus); map?.panTo(r, 16); });
  // Un clic: el reporte aprobado pasa a punto crítico automático (se enciende con naranja/roja) con su vía alterna
  q('[data-crit]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation(); const r = db.reports.find(x => x.id === b.dataset.crit); if (!r) return;
    b.disabled = true; b.textContent = 'Creando punto…';
    try { const p = await reportToPoint(r); toast('Reporte aceptado: ahora es punto crítico automático (aparece con alerta naranja o roja). Generando vía alterna…', 'ok'); await genAuto([p], b); }
    catch (e) { toast(e.message || 'No se pudo crear el punto crítico.', 'err'); b.disabled = false; b.textContent = 'Aceptar como punto crítico'; }
  });
  if (id('crit-all')) id('crit-all').onclick = async () => {
    const b = id('crit-all'); b.disabled = true; b.textContent = 'Convirtiendo…'; const pts = [];
    try { for (const r of loose) pts.push(await reportToPoint(r)); toast(`${pts.length} reporte(s) convertidos en puntos críticos automáticos. Generando vías alternas…`, 'ok'); await genAuto(pts, b); }
    catch (e) { toast(e.message || 'No se pudo convertir todos los reportes.', 'err'); refresh(); }
  };
}
// Un reporte aceptado pasa a ser punto crítico automático: se enciende solo con naranja/roja y deja de verse como reporte
async function reportToPoint(r) {
  const sev = 'media'; // los reportes ciudadanos pasan a puntos críticos de nivel medio
  const p = await api('/api/admin/points', { method: 'POST', body: { name: r.street || `Reporte ciudadano ${new Date(r.createdAt).toLocaleDateString('es-EC')}`, lat: r.lat, lng: r.lng,
    type: r.type === 'desborde' ? 'riesgo' : 'inundacion', severity: sev, description: r.description || 'Creado a partir de un reporte ciudadano.', auto: true, active: false, source: 'reporte' } });
  await api(`/api/admin/reports/${r.id}`, { method: 'PUT', body: { status: 'verificado', pointId: p.id } });
  r.status = 'verificado'; r.pointId = p.id; db.points.push(p); return p;
}

/* ================= CAPAS ================= */
let preview = null; // { fc, file }
function secLayers() {
  const layers = db.layers || [];
  col(`
    <div class="card"><h3 style="margin-bottom:6px">Subir capa</h3>
      <p class="small muted" style="margin-bottom:14px">Sube la capa que te entreguen (catastro, zonas de riesgo, cauces, alcantarillado…). Formatos: <b>GeoJSON</b>, <b>KML</b>, <b>KMZ</b> (Google Earth) o <b>Shapefile</b> comprimido en .zip.</p>
      <form id="fl" novalidate>
        <label class="drop" id="drop"><input type="file" id="file" accept=".geojson,.json,.kml,.kmz,.zip" hidden>${ICON.upload}<span id="drop-t"><b>Elige un archivo</b> o arrástralo aquí</span></label>
        <p class="small" id="lsum" style="margin:10px 0 0"></p><span class="err small" id="lerr" style="color:var(--roja)"></span>
        <div class="row" style="margin-top:14px"><div class="field"><label for="lname">Nombre de la capa</label><input id="lname" placeholder="Ej. Zonas de riesgo GAD Santa Rosa"></div>
        <div class="field"><label for="lkind">Tipo</label><select id="lkind"><option value="riesgo">Zonas de riesgo</option><option value="cauce">Ríos y canales</option><option value="drenaje">Alcantarillado / drenaje</option><option value="referencia">Referencia general</option></select></div></div>
        <div class="field"><label for="lcolor">Color</label><input id="lcolor" type="color" value="#6B4DD6" style="height:48px;padding:6px"></div>
        <label class="switch"><input type="checkbox" id="lpub" checked> Visible en el mapa público</label>
        <label class="switch"><input type="checkbox" id="limp"> Crear puntos críticos y calles con sus puntos y líneas (quedan inactivos para que los revises)</label>
        <div style="margin-top:12px"><button class="btn" id="lsave" disabled>Guardar capa</button></div>
      </form></div>
    <h3>Capas cargadas (${layers.length})</h3>
    <div class="list">${layers.length ? layers.map(l => `<div class="item ${l.active === false ? 'inactive' : ''}" data-lfocus="${l.id}"><span class="dot" style="background:${esc(l.color)};margin-top:6px"></span>
      <div style="min-width:0"><div class="title">${esc(l.name)}</div><div class="meta">${esc(summarize(l.geojson))}${l.source ? ` · ${esc(l.source)}` : ''}${l.active === false ? ' · <b>oculta al público</b>' : ''}</div></div>
      ${importable(l.geojson).points.length ? `<button class="btn soft sm" data-lconv="${l.id}" title="Crear un punto crítico por cada punto de la capa">${ICON.pin} Convertir en puntos críticos</button>` : ''}<div class="acts"><button class="btn ghost" aria-label="${l.active === false ? 'Mostrar' : 'Ocultar'}" title="${l.active === false ? 'Mostrar al público' : 'Ocultar al público'}" data-ltoggle="${l.id}">${l.active === false ? ICON.eye : ICON.x}</button><button class="btn danger" aria-label="Eliminar" title="Eliminar" data-ldel="${l.id}">${ICON.trash}</button></div></div>`).join('')
      : emptyBox('Aún no hay capas. Sube la primera con el formulario de arriba.')}</div>`);
  setTools([]); drawMode = null; drawAll(); preview = null;
  const drop = id('drop'), file = id('file');
  const handle = async f => {
    id('lerr').textContent = ''; id('lsum').textContent = 'Leyendo archivo…'; id('lsave').disabled = true;
    try {
      const fc = await parseLayerFile(f); preview = { fc, file: f.name };
      id('lsum').innerHTML = `${ICON.check} <b>${esc(f.name)}</b>: ${summarize(fc)}`; id('drop-t').innerHTML = `<b>${esc(f.name)}</b> · cambiar archivo`;
      if (!id('lname').value) id('lname').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      id('lsave').disabled = false; drawAll();
      const tmp = map.addGeoJSON({ data: fc, color: id('lcolor').value, name: 'Vista previa' }); tmp.bounds && map.raw.fitBounds?.(tmp.bounds(), { padding: [30, 30] });
    } catch (e) { preview = null; id('lsum').textContent = ''; id('lerr').textContent = e.message; }
  };
  file.onchange = () => file.files[0] && handle(file.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && handle(e.dataTransfer.files[0]); };
  id('fl').onsubmit = async e => {
    e.preventDefault(); if (!preview) return;
    id('lsave').disabled = true; id('lsave').textContent = 'Guardando…';
    try {
      await api('/api/admin/layers', { method: 'POST', body: { name: id('lname').value, color: id('lcolor').value, kind: id('lkind').value, source: preview.file, geojson: preview.fc, active: id('lpub').checked } });
      if (id('limp').checked) {
        const { points, lines } = importable(preview.fc);
        for (const p of points.slice(0, 300)) await api('/api/admin/points', { method: 'POST', body: { ...p, type: 'riesgo', severity: 'media', active: false } });
        for (const l of lines.slice(0, 300)) await api('/api/admin/streets', { method: 'POST', body: { ...l, status: 'inundada', depthCm: 0, note: 'Importada desde capa', active: false } });
        toast(`Capa guardada. Se crearon ${Math.min(points.length, 300)} puntos y ${Math.min(lines.length, 300)} calles inactivas para revisar.`, 'ok');
      } else toast('Capa guardada', 'ok');
      preview = null; refresh();
    } catch { id('lsave').disabled = false; id('lsave').textContent = 'Guardar capa'; }
  };
  q('[data-ltoggle]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); const l = db.layers.find(x => x.id === b.dataset.ltoggle); await api(`/api/admin/layers/${l.id}`, { method: 'PUT', body: { active: l.active === false } }); toast(l.active === false ? 'Capa visible al público' : 'Capa oculta al público', 'ok'); refresh(); });
  q('[data-lconv]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation(); const l = db.layers.find(x => x.id === b.dataset.lconv);
    const near = (a, p) => Math.abs(a.lat - p.lat) < 0.00005 && Math.abs(a.lng - p.lng) < 0.00005;
    const pts = importable(l.geojson).points.filter(p => !db.points.some(x => near(x, p)));
    if (!pts.length) { toast('Esos puntos ya existen como puntos críticos.', 'ok'); return; }
    b.disabled = true; b.textContent = 'Creando…'; let n = 0;
    for (const p of pts.slice(0, 300)) { try { await api('/api/admin/points', { method: 'POST', body: { name: p.name, lat: p.lat, lng: p.lng, description: p.description ? String(p.description).replace(/<[^>]+>/g, ' ').trim().slice(0, 300) : '', type: 'interseccion', severity: 'alta', active: false, auto: true, source: l.name } }); n++; } catch {} }
    toast(`${n} zonas inundables creadas. Se activan solas con alerta naranja o roja, o enciéndelas a mano.`, 'ok');
    if (l.active !== false) await api(`/api/admin/layers/${l.id}`, { method: 'PUT', body: { active: false } });
    section = 'points'; editing = null; await refresh(); renderShell();
  });
  q('[data-ldel]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); const ly = (db.layers || []).find(x => x.id === b.dataset.ldel); if (!await confirmBox({ title: 'Eliminar capa', text: `Se borrará "${ly?.name || 'la capa'}" del sistema. Los puntos que ya convertiste desde ella se mantienen.`, ok: 'Eliminar capa' })) return; await api(`/api/admin/layers/${b.dataset.ldel}`, { method: 'DELETE' }); toast('Capa eliminada', 'ok'); refresh(); });
  q('[data-lfocus]').forEach(b => b.onclick = () => { const l = db.layers.find(x => x.id === b.dataset.lfocus); const pts = []; for (const f of l.geojson.features) walkC(f.geometry, c => pts.push([c[1], c[0]])); map.fitBounds(pts); });
}
const walkC = (g, fn) => { if (!g) return; if (g.type === 'GeometryCollection') return g.geometries.forEach(x => walkC(x, fn)); const w = a => (typeof a[0] === 'number' ? fn(a) : a.forEach(w)); w(g.coordinates); };

/* ================= CONFIG ================= */
const FEATURES = {
  streets: ['Calles inundadas', 'Líneas rojas, naranjas y verdes y la pestaña Calles'],
  routes: ['Vías alternas', 'Líneas azules animadas y la pestaña Vías alternas'],
  rivers: ['Ríos y desbordes', 'Ríos, zonas de desborde, aviso de desborde y la pestaña Ríos'],
  points: ['Puntos críticos', 'Marcadores de alcantarillas, pasos bajos y zonas de riesgo'],
  recommendations: ['Consejos', 'La pestaña Consejos'],
  reports: ['Reportes ciudadanos', 'Botón Reportar inundación y reportes verificados en el mapa'],
  gps: ['Navegación con GPS', 'Botón GPS y avisos al acercarse a un peligro'],
  radar: ['Radar de lluvia', 'Botón de radar RainViewer'],
  risk: ['Índice de riesgo', 'El medidor de 0 a 100'],
  weather: ['Datos de clima', 'Lluvia ahora, últimas y próximas 3 horas'],
  layers: ['Capas subidas', 'Archivos KML, GeoJSON o Shapefile cargados en Capas'],
};
function secConfig() {
  const c = db.config; const F = c.features || {};
  col(`
    <div class="card share-card"><h3 style="margin-bottom:6px">Compartir con la ciudadanía</h3>
      <p class="small muted" style="margin-bottom:12px">Este es el enlace directo al mapa. Al abrirlo en el teléfono, la página ofrece <b>Instalar</b> para dejarla en la pantalla de inicio como una app (en iPhone: Compartir → Agregar a inicio). El QR sirve para afiches, redes y paradas de bus.</p>
      <div class="share-row"><div class="share-qr" id="qr" aria-label="Código QR del mapa público"></div>
        <div class="share-acts"><input id="pub-url" readonly value="${esc(location.origin)}/" aria-label="Enlace del mapa público">
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn sm" id="sh-copy">Copiar enlace</button><a class="btn sm soft" id="sh-wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Sistema de Alerta Vial · EMOVTT Santa Rosa: calles inundadas, vías alternas y navegación segura. ${location.origin}/`)}">WhatsApp</a><button type="button" class="btn sm ghost" id="sh-qr">Descargar QR</button></div>
          ${/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) ? `<p class="small" style="color:var(--naranja);margin-top:8px">Estás en una dirección local: este enlace solo funciona en tu red. Usa el de Render o tu dominio para compartir con todos.</p>` : ''}</div></div></div>
    <div class="card"><h3 style="margin-bottom:6px">Qué ve la ciudadanía</h3><p class="small muted" style="margin-bottom:12px">Apaga lo que no quieras mostrar en el mapa público, para no confundir. Los datos no se borran: al volver a encender, reaparecen.</p>
      <form id="ff" novalidate><div class="feat-grid">${Object.entries(FEATURES).map(([k, [t, d]]) => `<label class="feat ${F[k] === false ? '' : 'on'}"><input type="checkbox" data-feat="${k}" ${F[k] === false ? '' : 'checked'}><span class="tg" aria-hidden="true"></span><span><b>${t}</b><small>${d}</small></span></label>`).join('')}</div>
      <button class="btn" style="margin-top:14px">Guardar lo que se muestra</button></form></div>
    <div class="card"><h3 style="margin-bottom:6px">Calles donde no pasan vehículos</h3><p class="small muted" style="margin-bottom:12px">Malecones, peatonales, ciclovías o escalinatas. Las rutas y las vías alternas nunca pasarán por una calle cuyo nombre contenga alguna de estas palabras. Una por línea.</p>
      <form id="fnc" novalidate><div class="field"><label for="nocar">Nombres o palabras</label><textarea id="nocar" rows="5" placeholder="Malecón">${esc((c.noCar || []).join('\n'))}</textarea></div>
      <button class="btn">Guardar calles sin paso</button></form></div>
    <div class="card"><h3 style="margin-bottom:6px">Avisos en el teléfono</h3><p class="small muted" style="margin-bottom:12px">La ciudadanía puede activar avisos con la campana del mapa. Reciben una notificación cuando se aproxima lluvia, hay tormenta o sube el color de la alerta. Teléfonos suscritos: <b>${db.pushCount || 0}</b>. En iPhone funciona si la app se agrega a la pantalla de inicio.</p>
      <button type="button" class="btn ghost" id="push-test">Enviar notificación de prueba</button></div>
    <div class="card"><h3 style="margin-bottom:6px">Actualizar el mapa</h3><p class="small muted" style="margin-bottom:12px">Borra los cuadros del mapa de OpenStreetMap y los archivos guardados en este equipo, y vuelve a descargarlos. Úsalo si el mapa se ve borroso, desactualizado o con calles que no coinciden. Al pulsarlo, <b>todos los teléfonos</b> que abran el mapa después renuevan sus archivos solos (una sola vez). Los datos de la ciudad no se borran.</p>
      <button type="button" class="btn" id="map-refresh">Actualizar mapa de OpenStreetMap</button></div>
    <div class="card backup-card"><h3 style="margin-bottom:6px">Respaldo de datos</h3>
      <p class="small muted" style="margin-bottom:12px">Descarga todo (puntos, calles, vías alternas, ríos, zonas, capas, reportes y configuración) en un archivo. Sirve para pasar los datos de tu computadora al hosting, o para guardarlos antes de un cambio grande. En el hosting gratuito, guárdalo como <code>data/initial.json</code> para que se cargue solo cada vez que el servidor se reinicia.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button type="button" class="btn" id="bk-down">${ICON.inbox} Descargar respaldo</button><label class="btn ghost" for="bk-file" style="cursor:pointer">${ICON.layers} Restaurar desde archivo</label><input type="file" id="bk-file" accept=".json,application/json" hidden></div></div>
    <div class="card"><h3 style="margin-bottom:12px">Ciudad y mapa</h3><form id="fc" novalidate>
      <div class="field"><label for="city">Ciudad</label><input id="city" value="${esc(c.city)}"></div>
      <div class="row"><div class="field"><label for="clat">Centro · latitud</label><input id="clat" type="number" step="any" value="${c.center.lat}"></div><div class="field"><label for="clng">Centro · longitud</label><input id="clng" type="number" step="any" value="${c.center.lng}"></div></div>
      <div class="field"><label for="zoom">Zoom inicial</label><input id="zoom" type="number" min="8" max="18" value="${c.zoom}"><span class="hint">Tip: mueve el mapa de la derecha y pulsa "Usar vista actual".</span></div>
      <button type="button" class="btn ghost sm" id="usemap" style="margin-bottom:16px">Usar vista actual del mapa</button>
      <div class="field"><label for="prov">Proveedor de mapa</label><select id="prov"><option value="leaflet" ${c.mapProvider === 'leaflet' ? 'selected' : ''}>OpenStreetMap / Leaflet (gratis, sin key)</option><option value="google" ${c.mapProvider === 'google' ? 'selected' : ''}>Google Maps (requiere API key)</option></select></div>
      <div class="field"><label for="bstyle">Estilo del mapa base</label><select id="bstyle"><option value="osm" ${(c.baseStyle || 'osm') === 'osm' ? 'selected' : ''}>OpenStreetMap estándar</option><option value="hot" ${c.baseStyle === 'hot' ? 'selected' : ''}>OpenStreetMap HOT (humanitario)</option><option value="osmfr" ${c.baseStyle === 'osmfr' ? 'selected' : ''}>OpenStreetMap Francia</option></select><span class="hint">Si en un estilo algún terreno o área dibujada estorba las calles, prueba otro. Se aplica a todos los usuarios.</span></div>
      <div class="field"><label for="gkey">Google Maps API key</label><input id="gkey" value="${esc(c.googleMapsKey || '')}" placeholder="AIza..."><span class="hint">Si falla la carga de Google, el sistema vuelve automáticamente a OpenStreetMap.</span></div>
      <label class="switch" style="margin:4px 0 10px"><input type="checkbox" id="fon" ${c.floodEnabled === true ? 'checked' : ''}> Usar Google Flood Forecasting</label>
      <div class="field" id="fkey-f" ${c.floodEnabled === true ? '' : 'hidden'}><label for="fkey">Google Flood Forecasting API key</label><input id="fkey" value="${esc(c.googleFloodKey || '')}" placeholder="AIza..."><span class="hint">Google la entrega solo con acceso aprobado. Si no la tienes, deja esto apagado: el índice de riesgo usa el estado de los ríos que marcas en el mapa.</span></div>
      <button class="btn">Guardar configuración</button></form></div>
    <div class="card"><h3 style="margin-bottom:12px">Clima automático (fuentes)</h3><form id="fw" novalidate>
      <div class="row"><div class="field"><label for="wlat">Estación · latitud</label><input id="wlat" type="number" step="any" value="${c.weather.lat}"></div><div class="field"><label for="wlng">Estación · longitud</label><input id="wlng" type="number" step="any" value="${c.weather.lng}"></div></div>
      <div class="row"><div class="field"><label for="t1">Umbral lluvia (mm/h)</label><input id="t1" type="number" step="0.1" min="0" value="${c.weather.rainThresholdMm}"><span class="hint">Al superarlo: alerta naranja. El triple: roja.</span></div>
      <div class="field"><label for="t3">Umbral acumulado 3 h (mm)</label><input id="t3" type="number" step="0.5" min="0" value="${c.weather.rainThresholdMm3h}"></div></div>
      <div class="row"><div class="field"><label for="sdm">Bajar un color cada (minutos)</label><input id="sdm" type="number" step="5" min="5" value="${c.weather.stepDownMin ?? 45}"><span class="hint">Cuando deja de llover el semáforo baja de a un color: roja → naranja → amarilla → normal.</span></div>
      <div class="field"><label for="drh">Tiempo de drenaje (horas)</label><input id="drh" type="number" step="0.5" min="0" value="${c.weather.drainHours ?? 3}"><span class="hint">Los puntos críticos automáticos siguen activos este tiempo después de la última alerta naranja o roja, mientras baja el agua.</span></div></div>
      <div class="row"><div class="field"><label for="metar">Estación del aeropuerto (código OACI)</label><input id="metar" maxlength="4" value="${esc(c.weather.metarStation ?? 'SERO')}" placeholder="SERO"><span class="hint">SERO = aeropuerto de Santa Rosa. Envía reportes reales (METAR) cuando está operando. Déjalo vacío para no usarlo.</span></div>
      <div class="field"><label for="owm">OpenWeatherMap API key (opcional)</label><input id="owm" value="${esc(c.weather.owmKey || '')}" placeholder="Gratis en openweathermap.org"><span class="hint">Suma otra fuente. Crea una cuenta gratuita en openweathermap.org, copia tu API key y pégala aquí (tarda hasta 2 h en activarse).</span></div></div>
      <button class="btn">Guardar clima</button></form></div>
    <div class="card"><h3 style="margin-bottom:6px">Avisos por GPS</h3><p class="small muted" style="margin-bottom:14px">Cuando alguien usa "Navegar con GPS" en el mapa público, recibe un aviso al acercarse a una calle inundada o a un punto crítico.</p><form id="fg" novalidate>
      <div class="row"><div class="field"><label for="gw">Primer aviso a (metros)</label><input id="gw" type="number" min="50" step="10" value="${c.gps?.warnM ?? 400}"></div>
      <div class="field"><label for="gd">Aviso de peligro a (metros)</label><input id="gd" type="number" min="20" step="10" value="${c.gps?.dangerM ?? 150}"></div></div>
      <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="gv" ${c.gps?.voice !== false ? 'checked' : ''}> Aviso por voz</label><br>
      <button class="btn">Guardar avisos GPS</button></form></div>`);
  setTools([]); drawMode = null; drawAll();
  q('[data-feat]').forEach(cb => cb.onchange = () => cb.closest('.feat').classList.toggle('on', cb.checked));
  id('push-test').onclick = async e => { const b = e.currentTarget; b.disabled = true; try { const r = await api('/api/admin/push/test', { method: 'POST' }); toast(r.total ? `Enviada a ${r.sent} de ${r.total} teléfonos` : 'Aún no hay teléfonos suscritos', r.sent ? 'ok' : 'err'); } catch {} b.disabled = false; };
  id('map-refresh').onclick = async e => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Actualizando…';
    try { await api('/api/admin/map-refresh', { method: 'POST' }); } catch {}
    try { if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
      if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {}
    toast('Mapa actualizado: se descargará de nuevo', 'ok'); setTimeout(() => { location.href = '/?mapa=' + Date.now(); }, 900); };
  id('fnc').onsubmit = async e => { e.preventDefault(); await api('/api/admin/config', { method: 'PUT', body: { noCar: id('nocar').value } }); toast('Calles sin paso de vehículos guardadas', 'ok'); db = await api('/api/admin/state'); setNoCar(db.config.noCar); };
  id('ff').onsubmit = async e => { e.preventDefault(); await api('/api/admin/config', { method: 'PUT', body: { features: Object.fromEntries(q('[data-feat]').map(cb => [cb.dataset.feat, cb.checked])) } }); toast('Mapa público actualizado', 'ok'); db = await api('/api/admin/state'); };
  id('fon').onchange = () => { id('fkey-f').hidden = !id('fon').checked; };
  id('usemap').onclick = () => { if (!map) return; const r = map.raw; const cc = map.provider === 'google' ? { lat: r.getCenter().lat(), lng: r.getCenter().lng() } : r.getCenter(); id('clat').value = (+cc.lat).toFixed(5); id('clng').value = (+cc.lng).toFixed(5); id('zoom').value = r.getZoom(); };
  const url = id('pub-url').value;
  if (window.qrcode) { const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make(); id('qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    id('sh-qr').onclick = () => { const big = window.qrcode(0, 'M'); big.addData(url); big.make(); const a = document.createElement('a'); a.href = big.createDataURL(16, 4); a.download = 'alertavial-qr.gif'; a.click(); }; }
  else id('sh-qr').hidden = true;
  id('sh-copy').onclick = async () => { try { await navigator.clipboard.writeText(url); } catch { id('pub-url').select(); document.execCommand('copy'); } toast('Enlace copiado', 'ok'); };
  id('bk-down').onclick = async () => {
    const r = await fetch('/api/admin/backup', { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return toast('No se pudo descargar el respaldo.', 'err');
    const blob = await r.blob(), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = (r.headers.get('content-disposition') || '').match(/filename="(.+)"/)?.[1] || 'alertavial-respaldo.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Respaldo descargado', 'ok');
  };
  id('bk-file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    let data; try { data = JSON.parse(await f.text()); } catch { return toast('El archivo no es un JSON válido.', 'err'); }
    const n = k => (data[k] || []).length;
    if (!await confirmBox({ title: 'Restaurar respaldo', text: `Se reemplazarán TODOS los datos actuales por los del archivo "${f.name}" (${n('points')} puntos, ${n('routes')} vías alternas, ${n('streets')} calles, ${n('layers')} capas). Te recomendamos descargar un respaldo antes.`, ok: 'Reemplazar datos', tone: 'warn', icon: ICON.layers })) return;
    const r = await api('/api/admin/restore', { method: 'POST', body: data });
    toast(`Datos restaurados: ${r.counts.points} puntos y ${r.counts.routes} vías alternas`, 'ok'); db = await api('/api/admin/state'); renderShell();
  };
  id('fc').onsubmit = async e => { e.preventDefault(); await api('/api/admin/config', { method: 'PUT', body: { city: id('city').value, center: { lat: id('clat').value, lng: id('clng').value }, zoom: id('zoom').value, mapProvider: id('prov').value, baseStyle: id('bstyle').value, googleMapsKey: id('gkey').value, googleFloodKey: id('fkey').value, floodEnabled: id('fon').checked } }); toast('Configuración guardada', 'ok'); db = await api('/api/admin/state'); renderShell(); };
  id('fg').onsubmit = async e => { e.preventDefault(); await api('/api/admin/config', { method: 'PUT', body: { gps: { warnM: id('gw').value, dangerM: id('gd').value, voice: id('gv').checked } } }); toast('Avisos GPS guardados', 'ok'); refresh(); };
  id('fw').onsubmit = async e => { e.preventDefault(); await api('/api/admin/config', { method: 'PUT', body: { weather: { lat: id('wlat').value, lng: id('wlng').value, rainThresholdMm: id('t1').value, rainThresholdMm3h: id('t3').value, stepDownMin: id('sdm').value, drainHours: id('drh').value, metarStation: id('metar').value, owmKey: id('owm').value } } }); toast('Clima guardado', 'ok'); refresh(); };
}

/* ================= helpers ================= */
const id = s => document.getElementById(s); const q = s => [...document.querySelectorAll(s)];
const col = html => { id('col').innerHTML = html; const c = id('cancel'); if (c) c.onclick = () => { editing = null; cancelDraw(); renderSection(); }; };
const opts = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
const emptyBox = t => `<div class="empty">${ICON.inbox}<div>${t}</div></div>`;
function itemRow(x, meta, kind, dot) {
  return `<div class="item ${x.active === false ? 'inactive' : ''}" data-focus-kind="${kind}" data-focus="${x.id}"><span class="dot ${dot}" style="margin-top:6px"></span>
    <div style="min-width:0"><div class="title">${esc(x.name)}</div><div class="meta">${meta}${x.active === false ? ' · <b>inactivo</b>' : ''}</div></div>
    <div class="acts"><button class="btn ghost" title="${x.active === false ? 'Activar' : 'Desactivar'}" aria-label="${x.active === false ? 'Activar' : 'Desactivar'}" data-toggle="${x.id}">${x.active === false ? ICON.eye : ICON.x}</button>
    <button class="btn ghost" title="Editar" aria-label="Editar" data-edit="${x.id}">${ICON.edit}</button><button class="btn danger" title="Eliminar" aria-label="Eliminar" data-del="${x.id}">${ICON.trash}</button></div></div>`;
}
function bindList(kind) {
  q('[data-toggle]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); const x = db[kind].find(i => i.id === b.dataset.toggle); await api(`/api/admin/${kind}/${x.id}`, { method: 'PUT', body: { active: x.active === false } }); toast(x.active === false ? 'Activado y visible al público' : 'Desactivado: oculto al público', 'ok'); refresh(); });
  q('[data-edit]').forEach(b => b.onclick = ev => { ev.stopPropagation(); editing = { ...db[kind].find(i => i.id === b.dataset.edit) }; renderSection(); });
  q('[data-del]').forEach(b => b.onclick = async ev => { ev.stopPropagation(); const it = (db[kind] || []).find(x => x.id === b.dataset.del); if (!await confirmBox({ title: `Eliminar ${({ points: 'punto crítico', streets: 'calle', routes: 'vía alterna', rivers: 'río', zones: 'zona de desborde', recommendations: 'recomendación' })[kind] || 'elemento'}`, text: `${it?.name || it?.text ? `"${(it.name || it.text).slice(0, 80)}" se` : 'Se'} borrará definitivamente. Si solo quieres ocultarlo, apágalo con su interruptor.`, ok: 'Eliminar' })) return; await api(`/api/admin/${kind}/${b.dataset.del}`, { method: 'DELETE' }); toast('Eliminado', 'ok'); editing = null; refresh(); });
  q('[data-focus-kind]').forEach(b => b.onclick = () => { const x = db[kind].find(i => i.id === b.dataset.focus); if (!map || !x) return; x.coords ? map.fitBounds(x.coords) : map.panTo(x, 16); });
}
async function save(kind, body) {
  try {
  const r = editing?.id ? await api(`/api/admin/${kind}/${editing.id}`, { method: 'PUT', body }) : await api(`/api/admin/${kind}`, { method: 'POST', body });
  toast(editing?.id ? 'Cambios guardados' : 'Publicado en el mapa', 'ok'); editing = null; drawCoords = []; pending = {}; await refresh();
  } catch (e) { /* el error ya se mostró en un toast */ }
}

/* ---- Mapa / dibujo ---- */
function setTools(list) {
  const t = id('tools'); if (!t) return;
  t.innerHTML = list.map(([k, l, i]) => `<button class="btn sm" data-tool="${k}">${i} ${l}</button>`).join('');
  q('[data-tool]').forEach(b => b.onclick = () => {
    if (b.dataset.tool === 'draw') { drawMode = drawMode === 'line' ? null : 'line'; b.classList.toggle('on', drawMode === 'line'); hint(drawMode === 'line' ? 'Haz clic sobre el mapa para agregar puntos. Vuelve a pulsar "Dibujar" para terminar.' : ''); }
    if (b.dataset.tool === 'undo') { const n = segStack.pop() ?? 1; drawCoords.splice(Math.max(0, drawCoords.length - n)); drawAll(); }
    if (b.dataset.tool === 'clear') { drawCoords = []; segStack = []; drawAll(); }
  });
}
function hint(t) { const h = id('hint'); if (!h) return; h.textContent = t; h.classList.toggle('on', !!t); }
function cancelDraw() { drawMode = null; drawCoords = []; pending = {}; hint(''); }
function onMapClick(pos) {
  if (drawMode === 'point') { pending = pos; setPick(pos); const p = id('pos'); if (p) p.textContent = `Ubicación: ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`; }
  if (drawMode === 'line') addLinePoint(pos);
}
// Seguir calles: pide a OSRM (OpenStreetMap, sin cuenta) el recorrido por calles entre el último punto y el toque.
let snapOn = true, segStack = [], snapBusy = false;
async function addLinePoint(pos) {
  const useSnap = snapOn && ['routes', 'streets'].includes(section) && drawCoords.length > 0;
  if (!useSnap) { drawCoords.push([pos.lat, pos.lng]); segStack.push(1); drawAll(); return; }
  if (snapBusy) return; snapBusy = true; hint('Buscando el recorrido por las calles…');
  const [la, ln] = drawCoords.at(-1);
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${ln},${la};${pos.lng},${pos.lat}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json(); const g = j.routes?.[0]?.geometry?.coordinates;
    if (!g?.length) throw new Error('sin ruta');
    const seg = g.slice(1).map(([x, y]) => [+y.toFixed(6), +x.toFixed(6)]);
    drawCoords.push(...seg); segStack.push(seg.length);
    hint('Toca la siguiente esquina o el final. Vuelve a pulsar "Dibujar" para terminar.');
  } catch {
    drawCoords.push([pos.lat, pos.lng]); segStack.push(1);
    hint('No se pudo seguir la calle (sin conexión con OpenStreetMap). Se agregó una línea recta.');
  }
  snapBusy = false; drawAll();
}
function setPick(pos) { if (!map) return; pickShape?.remove(); pickShape = map.addMarker({ lat: pos.lat, lng: pos.lng, cls: 'baja pulse', icon: 'inundacion' }); }
function drawAll(withReports) {
  if (!map) return; map.clear(); pickShape = null;
  for (const l of (db.layers || []).filter(l => l.active !== false)) map.addGeoJSON({ data: l.geojson, color: l.color, name: l.name });
  for (const s of db.streets) map.addPolyline({ coords: s.coords, status: s.status, weight: 6, popup: `<b>${esc(s.name)}</b><br>${STATUS[s.status]}${s.active === false ? ' · inactiva' : ''}` });
  for (const z of db.zones || []) map.addPolygon({ coords: z.coords, severity: z.severity, popup: `<b>${esc(z.name)}</b><br>Desborde · ${ZSEV[z.severity]}${z.active === false ? ' · inactiva' : ''}` });
  for (const r of db.rivers || []) map.addPolyline({ coords: r.coords, status: 'rio_' + r.status, flow: 'river', weight: 8, popup: `<b>${esc(r.name)}</b><br>${RIVER[r.status]}` });
  for (const r of db.routes) map.addPolyline({ coords: r.coords, status: 'ruta', flow: 'route', weight: 6, popup: `<b>${esc(r.name)}</b>` });
  for (const p of db.points) map.addMarker({ lat: p.lat, lng: p.lng, cls: p.severity + (p.active ? '' : ' muted'), icon: p.type, popup: `<b>${esc(p.name)}</b><br>${PTYPE[p.type]}${p.active === false ? ' · inactivo' : ''}` });
  if (withReports) for (const r of db.reports || []) map.addMarker({ lat: r.lat, lng: r.lng, cls: 'report', icon: 'report', popup: `<b>Reporte · ${esc(r.status)}</b><br>${esc(r.street)}<br>${esc(r.description)}` });
  if (drawCoords.length) {
    if (section === 'zones' && drawCoords.length > 2) map.addPolygon({ coords: drawCoords, severity: id('sev')?.value || 'alta', draft: true });
    else if (drawCoords.length > 1) map.addPolyline({ coords: drawCoords, status: section === 'routes' ? 'ruta' : section === 'rivers' ? 'rio_' + (id('status')?.value || 'normal') : 'inundada', flow: section === 'routes' ? 'route' : section === 'rivers' ? 'river' : null, weight: 6 });
    drawCoords.forEach(([lat, lng]) => map.addVertex({ lat, lng }));
  }
  const p = id('pos'); if (p && section !== 'points') p.textContent = `${drawCoords.length} puntos dibujados`;
  if (pending.lat != null) setPick(pending);
  drawOsm();
}

token ? boot() : renderLogin();
