import { createMap } from './map-provider.js';
import { createGps, nearestOnLine, haversine, progressOn, isAhead } from './gps.js';
import { createNav, setNoCar } from './nav.js';
import { createWeatherFx } from './weather-fx.js';
import { RIVER, ZSEV, LEVELS, LEVEL_DESC, STATUS, PTYPE, SEV, esc, ago, wxTime, toast, ICON, waveSvg, edgeFade, dec, rainHours, daysCards } from './common.js';

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
// En el celular el mapa ocupa la pantalla menos el encabezado y la banda de alerta, midiendo su alto real
// (cambia al abrir la alerta, con mensajes largos o al girar el teléfono) para que nada quede fuera de la pantalla.
const chromeH = () => document.documentElement.style.setProperty('--chrome', `${document.querySelector('header.top').offsetHeight + $('#band').offsetHeight}px`);
const chromeObs = new ResizeObserver(() => { chromeH(); map?.invalidate(); });
chromeObs.observe(document.querySelector('header.top')); chromeObs.observe($('#band')); chromeH();
new ResizeObserver(() => map?.invalidate()).observe(document.getElementById('map'));
// Alto real de la pantalla: en iPhone (sobre todo como acceso directo) 100dvh queda desactualizado al girar, volver de otra app o cambiar la barra,
// y hacía falta cerrar y abrir. Se vuelve a medir en cada cambio y se reacomoda el mapa.
// Respaldo: si el teléfono llegó a ampliar la página al escribir, al salir del campo se devuelve el zoom a 1
(() => {
  const m = document.querySelector('meta[name="viewport"]'); if (!m) return; const base = m.content;
  const reset = () => { m.content = `${base}, maximum-scale=1`; setTimeout(() => { m.content = base; }, 350); };
  document.addEventListener('focusout', e => { if (e.target.matches?.('input,select,textarea')) setTimeout(reset, 120); });
})();
let vpT = 0;
const syncViewport = () => {
  const root = document.documentElement;
  root.style.setProperty('--app-h', `${window.innerHeight}px`);
  root.style.setProperty('--app-w', `${root.clientWidth}px`);
  chromeH(); map?.invalidate();
};
const syncSoon = () => { clearTimeout(vpT); syncViewport(); vpT = setTimeout(syncViewport, 350); };
window.addEventListener('resize', syncSoon); window.addEventListener('orientationchange', syncSoon); window.addEventListener('pageshow', syncSoon);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(); });
window.visualViewport?.addEventListener('resize', () => { clearTimeout(vpT); vpT = setTimeout(syncViewport, 200); });
syncViewport();
const hiddenLayers = new Set(JSON.parse((() => { try { return localStorage.getItem('av_hidden_layers'); } catch { return null; } })() || '[]'));
// Clima sobre el mapa: indicador + animación de lluvia / tormenta
const wxFx = createWeatherFx({ canvas: $('#wx-fx'), flash: $('#wx-flash') });
const WX_IC = {
  rain: '<svg viewBox="0 0 24 24"><path d="M7 15a4 4 0 0 1-.5-8A6 6 0 0 1 18 8a3.5 3.5 0 0 1 0 7"/><path d="M9 18l-1 2m5-3-1 2m5-3-1 2"/></svg>',
  storm: '<svg viewBox="0 0 24 24"><path d="M7 15a4 4 0 0 1-.5-8A6 6 0 0 1 18 8a3.5 3.5 0 0 1 0 7"/><path d="M13 12l-3 5h4l-3 5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 11a3.5 3.5 0 0 1 0 7z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  partly: '<svg viewBox="0 0 24 24"><path d="M9 2.5v1.5M3.6 4.6l1.1 1.1M2 10h1.5M14.4 4.6l-1.1 1.1"/><path d="M12.6 9.2A4 4 0 1 0 6 12.6"/><path d="M8.5 20a3.5 3.5 0 0 1-.3-7 5 5 0 0 1 9.5 1A3 3 0 0 1 17.5 20z"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.6 6.6 0 0 0 10 10z"/></svg>',
};
// Cielo según el clima real: decide el ícono, el color de la tarjeta y el efecto sobre el mapa
const skyOf = w => (w?.intensity || 0) > 0 ? 'lluvia' : w?.sun?.sky || ((w?.cloudCover ?? 0) >= 80 ? 'nublado' : (w?.cloudCover ?? 0) >= 40 ? 'parcial' : 'soleado');
const skyIcon = w => { const i = w?.intensity || 0, sky = skyOf(w); return i >= 4 ? 'storm' : i > 0 ? 'rain' : sky === 'noche' ? 'moon' : sky === 'nublado' ? 'cloud' : sky === 'parcial' ? 'partly' : 'sun'; };
const uvOn = w => w?.sun?.uvIndex != null && w.sun.isDay !== 0;
// Efecto del cielo sobre el mapa (sol, nubes, noche); la lluvia la dibuja el canvas
function applySky(w) {
  const mw = document.querySelector('.mapwrap');
  const sky = wxFx.enabled && w?.ok && state?.config?.features?.weather !== false ? skyOf(w) : '';
  for (const k of ['soleado', 'parcial', 'nublado', 'noche']) mw.classList.toggle(`sky-${k}`, sky === k);
  mw.style.setProperty('--sun', Math.min(1, Math.max(.45, (w?.sun?.uvIndex ?? 6) / 10)).toFixed(2));
}
// Aviso de lluvia posible (no cambia el semáforo): se muestra cuando las fuentes ven señales de que podría llover
const cap = t => t ? t[0].toUpperCase() + t.slice(1) : '';
function outlookCard(o) {
  if (!o || !['atencion', 'probable'].includes(o.level)) return '';
  return `<div class="ol-card ol-${o.level}" role="status">
    <span class="ol-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 15a4 4 0 0 1-.5-8A6 6 0 0 1 18 8a3.5 3.5 0 0 1 0 7"/></svg><i></i><i></i><i></i></span>
    <div class="ol-tx"><b>${esc(o.title)}</b><p>${esc(o.text)}</p>${o.reasons?.length ? `<ul>${o.reasons.map(r => `<li>${esc(cap(r))}</li>`).join('')}</ul>` : ''}</div></div>`;
}
// Resumen de un vistazo: riesgo, lluvia y calles. Cada ficha lleva a su pestaña.
function renderGlance(nFlood) {
  const { weather: w, risk: r, config } = state, F = config.features || {}, el = $('#glance'), t = [];
  if (F.risk !== false && r) t.push(`<button type="button" class="gl lv-${r.level}" data-go="sum" aria-label="Índice de riesgo ${r.value} de 100"><span class="gl-v"><b>${r.value}</b><small>/100</small></span><span class="gl-l">Riesgo</span><span class="gl-bar"><i style="width:${r.value}%"></i></span></button>`);
  if (F.weather !== false && w?.ok) {
    const p = w.probNext3h;
    t.push((w.intensity || 0) > 0 ? `<button type="button" class="gl rain wet" data-go="sum"><span class="gl-v"><b>${dec(w.rainNow)}</b><small>mm/h</small></span><span class="gl-l">Lloviendo</span></button>`
      : `<button type="button" class="gl rain${p >= 80 ? ' on' : ''}" data-go="sum" aria-label="Probabilidad de lluvia en las próximas 3 horas: ${p ?? 'sin dato'} %"><span class="gl-v"><b>${p ?? '–'}</b><small>%</small></span><span class="gl-l">Lluvia 3 h</span><span class="gl-bar"><i style="width:${p ?? 0}%"></i></span></button>`);
  }
  if (F.streets !== false) t.push(`<button type="button" class="gl st${nFlood ? ' on' : ' ok'}" data-go="streets" aria-label="${nFlood} ${nFlood === 1 ? 'calle inundada' : 'calles inundadas'}"><span class="gl-v"><b>${nFlood}</b><small>${nFlood === 1 ? 'calle' : 'calles'}</small></span><span class="gl-l">Inundadas</span></button>`);
  el.innerHTML = t.join(''); el.hidden = !t.length;
}
const goTab = id => { const t = document.querySelector(`.tab[data-tab="${id}"]`); if (!t || t.hidden) return; t.click();
  if (window.innerWidth <= 900 && !matchMedia('(min-width:768px) and (min-height:561px)').matches) window.scrollTo({ top: Math.max(0, $('.panel').getBoundingClientRect().top + window.scrollY - Math.round(window.innerHeight * .3)), behavior: 'smooth' }); };
$('#glance').addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) goTab(b.dataset.go); });
// Sensación térmica, humedad y viento
function feelCard(w) {
  if (w.apparent == null) return '';
  const h = w.heat;
  return `<div class="wx-feel${h ? ` hf-${h.key}` : ''}"><div class="wf-h"><span class="wf-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/></svg></span><b>Sensación térmica</b><span class="wf-v">${Math.round(w.apparent)}<small>°C</small></span></div>
    <div class="wf-m">${h ? `<span class="wf-tag">${esc(h.label)}</span>` : ''}${w.humidity != null ? `<span>Humedad <b>${w.humidity} %</b></span>` : ''}${w.wind != null ? `<span>Viento <b>${w.wind} km/h</b></span>` : ''}${w.temperature != null ? `<span>Aire <b>${Math.round(w.temperature)}°C</b></span>` : ''}</div>
    ${h?.advice ? `<p>${esc(h.advice)}</p>` : ''}</div>`;
}
// Probabilidad estimada de tormenta eléctrica (próximas 6 h)
function thunderCard(w) {
  const t = w.thunder; if (!t) return '';
  return `<div class="wx-thunder th-${t.level}"><div class="th-h"><span class="th-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg></span><b>Tormenta eléctrica</b><span class="th-p">${t.prob}<small>%</small></span></div>
    <div class="th-now ${t.activity ? 'on lv' + t.activity.level : 'off'}"><i aria-hidden="true"></i><span>${t.activity ? `<b>${esc(t.activity.label)}</b> en este momento${t.activity.mm ? ` · ~${t.activity.mm} mm/h` : ''}` : 'Ahora: <b>sin tormenta detectada</b>'}</span></div>
    <div class="th-bar" role="img" aria-label="Probabilidad de tormenta eléctrica ${t.prob} por ciento, ${esc(t.label)}"><i style="width:${t.prob}%"></i></div>
    <div class="th-l"><b>${esc(t.label)}</b><span>próximas 6 h · estimado</span></div>
    <p>${esc(t.text)}</p>${t.reasons?.length ? `<details class="th-why"><summary>Por qué</summary><ul>${t.reasons.map(r => `<li>${esc(cap(r))}</li>`).join('')}</ul></details>` : ''}</div>`;
}
// Vista de inicio: un radio de 1 km alrededor del centro (así caben todas las zonas afectadas). Se calcula con el tamaño real del mapa.
const HOME_RADIUS = () => +state?.config?.homeRadius || 1000;
function homeZoom() {
  const c = state?.config?.center, el = document.getElementById('map'); if (!c || !el) return Math.max(+state?.config?.zoom || 0, 16);
  const w = el.clientWidth, h = el.clientHeight, appNav = document.documentElement.classList.contains('app-nav');
  const avail = Math.min(w - 24, h - (appNav ? 150 : 90)); if (!(avail > 80)) return 15;
  // En el teléfono la barra de escala abre marcando 1 km (≈1/3 del ancho); en pantallas grandes, 1 km de radio
  const mpp = w <= 900 ? HOME_RADIUS() / Math.max(100, Math.min(140, w * .32)) : HOME_RADIUS() * 2 / avail;
  return Math.max(12, Math.min(18, Math.log2(156543.03 * Math.cos(c.lat * Math.PI / 180) / mpp)));
}
const goHome = () => { const c = state?.config?.center; if (c && map) map.setCenter(c, homeZoom()); };
let daysData = null;
// Tarjeta "Clima ahora": cielo, temperatura, lluvia y sol (índice UV, radiación, salida y puesta)
function weatherCard(w) {
  const sky = skyOf(w), s = w.sun, night = s?.isDay === 0;
  const uvBadge = uvOn(w) ? `<div class="uv-badge uv-${s.uv.key}" title="Índice UV (escala de la OMS)"><b>${dec(s.uvIndex)}</b><small>UV ${esc(s.uv.label.toLowerCase())}</small></div>` : '';
  const pos = s?.uvIndex != null ? Math.min(100, (night ? 0 : s.uvIndex) / 12 * 100) : null;
  const sunRow = s ? `<div class="wx-sun">
      ${pos != null && !night ? `<div class="wx-hours-h"><span class="wx-hours-t">Sol e índice UV</span><span class="wx-hours-k">ahora ${dec(s.uvIndex)} · ${esc(s.uv.label.toLowerCase())}</span></div><div class="uv-scale" role="img" aria-label="Índice UV ${dec(s.uvIndex)} de 11 o más"><i style="left:${pos}%"></i></div><div class="uv-ticks"><span>Bajo</span><span>Moderado</span><span>Alto</span><span>Muy alto</span><span>Extremo</span></div>` : ''}
      <div class="wx-sun-meta">
        ${!night && s.radiation != null ? `<span>${WX_IC.sun}Radiación <b>${s.radiation} W/m²</b></span>` : ''}
        ${s.uvMax != null ? `<span>Máx. hoy <b>UV ${dec(s.uvMax)}</b></span>` : ''}
        ${s.sunrise ? `<span>${night ? 'Amanece' : 'Sol'} <b>${wxTime(s.sunrise)}${night ? '' : `–${wxTime(s.sunset)}`}</b></span>` : ''}
      </div>
      ${!night && s.uvIndex >= 3 && !(w.intensity > 0) && s.uv.advice ? `<p class="uv-tip uv-${s.uv.key}">${esc(s.uv.advice)}</p>` : ''}
    </div>` : '';
  return `<div class="wx-card sky-${sky}">
    <div class="wx-now"><span class="wx-big">${WX_IC[skyIcon(w)]}</span>
      <div class="wx-now-t"><b>${esc(w.condition || 'Clima')}</b><small>${w.temperature != null ? `${Math.round(w.temperature)}°C${w.apparent != null ? ` · sensación ${Math.round(w.apparent)}°C` : ''} · ` : ''}dato de las ${wxTime(w.observedAt)}</small></div>${uvBadge}</div>
    <div class="wx-auto${w.raining ? ' on' : ''}" role="status"><i aria-hidden="true"></i><b>${w.raining ? 'Lloviendo ahora' : 'No está lloviendo'}</b><small>detección automática${w.models?.length ? ` · ${w.models.filter(m => m.ok).length} fuentes` : ''}</small></div>
    <div class="wx-stats">
      <div class="stat${w.raining ? ' rain' : ''}"><b>${dec(w.rainNow)}<small> mm/h</small></b><span>Lluvia ahora</span></div>
      <div class="stat"><b>${dec(w.rainPast3h)}<small> mm</small></b><span>Últimas 3 h</span></div>
      <div class="stat"><b>${dec(w.rainNext3h)}<small> mm</small></b><span>Próximas 3 h</span></div>
    </div>${rainHours(w)}${feelCard(w)}${thunderCard(w)}${sunRow}</div>`;
}
function renderWx(w) {
  const chip = $('#wx-chip'); wxFx.set(w); applySky(w);
  if (!w?.ok || state.config.features?.weather === false) { chip.hidden = true; return; }
  const i = w.intensity || 0, ic = skyIcon(w);
  chip.hidden = false; chip.className = `wx-chip i${i} sky-${skyOf(w)}`;
  const extra = w.rainNow > 0 ? `<span>${dec(w.rainNow)} mm/h</span>` : w.probNext3h >= 80 ? `<span>${w.probNext3h}% en 3 h</span>` : '';
  const ol = !i && ['atencion', 'probable'].includes(w.outlook?.level) ? `<span class="ol-tag ol-${w.outlook.level}">${w.outlook.level === 'probable' ? 'Lluvia probable' : 'Podría llover'}${w.outlook.from ? ` ${w.outlook.from.slice(11, 16)}` : ''}</span>` : '';
  const th = !i && ['moderada', 'alta'].includes(w.thunder?.level) ? `<span class="ol-tag ol-probable">Tormenta ${w.thunder.prob} %</span>` : '';
  const uv = ol || th || (!i && uvOn(w) && w.sun.uvIndex >= 3 ? `<span class="uv-tag uv-${w.sun.uv.key}">UV ${dec(w.sun.uvIndex)}</span>` : '');
  // aviso una sola vez cuando la lluvia pasa a "probable"
  if (!i && w.outlook?.level === 'probable') { const k = `av_ol_${w.outlook.from || ''}`; try { if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, '1'); toast(`Lluvia probable${w.outlook.from ? ` desde las ${w.outlook.from.slice(11, 16)}` : ' en las próximas horas'}. Lleva paraguas.`); } } catch {} }
  chip.innerHTML = `<span class="wx-ic">${WX_IC[ic]}</span><b>${esc(w.condition || 'Clima')}</b>${w.temperature != null && !i ? `<span>${Math.round(w.temperature)}°C</span>` : ''}${ol ? '' : extra}${uv}${w.simulated ? '<em>prueba</em>' : ''}<u aria-hidden="true">${wxFx.enabled ? 'efectos' : 'sin efectos'}</u>`;
  chip.title = `${w.decidedBy ? `Lo detectó: ${w.decidedBy}` : `Fuente: ${w.source}`} · dato de las ${wxTime(w.observedAt)} · toca para mostrar u ocultar el clima sobre el mapa`;
}
$('#wx-chip').addEventListener('click', () => { if (!state?.weather?.ok) return; const on = wxFx.toggle(); toast(on ? 'Clima sobre el mapa activado' : 'Clima sobre el mapa oculto', 'ok'); renderWx(state.weather); });

// Simulador de navegación (Admin → Simular navegación abre el mapa con ?sim=1)
const SIM = new URLSearchParams(location.search).has('sim');
const gps = createGps({ getMap: () => map, getState: () => state, getShapes: () => shapes, getNav: () => nav, onMove: u => { syncRoutes(); nav.track(u); document.body.classList.toggle('navigating', !!(u && nav.trip)); } });
const nav = createNav({ getMap: () => map, getState: () => state, getUser: () => gps.user, startGps: () => (SIM ? (gps.simulating || gps.simulate()) : gps.start()), onChange: () => syncRoutes(), sim: SIM, getDirect: () => SIM && $('#sim-direct').checked, getVoice: () => gps.voiceOn });

if (SIM) {
  document.body.classList.add('sim-mode'); $('#sim-bar').hidden = false;
  $('#nav-q').placeholder = 'Destino del recorrido de prueba';
  // En el simulador el botón GPS arranca el vehículo virtual en vez del GPS real.
  document.addEventListener('click', e => { if (!e.target.closest('#btn-gps')) return; e.stopPropagation(); if (gps.simulating) gps.stop(); else gps.simulate(); }, true);
  document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => { gps.setSimSpeed(+b.dataset.speed); document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('on', x === b)); }));
  $('#sim-pause').addEventListener('click', e => { if (!gps.simulating) return; const p = gps.toggleSimPause(); e.currentTarget.textContent = p ? 'Seguir' : 'Pausa'; e.currentTarget.classList.toggle('on', p); });
  $('#sim-off').addEventListener('click', () => { if (!gps.simDeviate()) return toast('Primero inicia la simulación con una ruta.', 'err'); toast('El vehículo tomó otra calle: mira cómo se recalcula la ruta.', 'ok'); });
  $('#sim-reset').addEventListener('click', () => { gps.stop(); nav.resetFrom(); $('#nav-clear').click(); $('#sim-pause').textContent = 'Pausa'; toast('Busca un destino o elígelo en el mapa para una nueva prueba.', 'ok'); });
}

// Copia local del último estado: si se cae la señal, el mapa, las zonas y los avisos del GPS siguen funcionando.
const CACHE_KEY = 'av_state_cache';
async function fetchState() {
  try {
    const res = await fetch('/api/public/state', { signal: AbortSignal.timeout(12000) }); if (!res.ok) throw new Error(res.status);
    const st = await res.json();
    const reports = await (await fetch('/api/public/reports', { signal: AbortSignal.timeout(12000) })).json();
    const pack = { state: st, reports, at: Date.now() };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(pack)); } catch { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...pack, state: { ...st, layers: [] } })); } catch {} }
    setOffline(null); return pack;
  } catch (e) {
    let pack = null; try { pack = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch {}
    if (!pack) throw e;
    setOffline(pack.at); return pack;
  }
}
function setOffline(at) {
  const el = $('#offline'); document.body.classList.toggle('is-offline', !!at);
  if (!at) { el.hidden = true; return; }
  const t = new Date(at); const today = new Date().toDateString() === t.toDateString();
  el.textContent = `Sin conexión · datos ${today ? 'de las' : 'del'} ${today ? t.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}`;
  el.hidden = false;
}
window.addEventListener('online', () => load().catch(() => {}));
window.addEventListener('offline', () => { if (state) setOffline(JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')?.at || Date.now()); });

// Si el equipo pulsó "Actualizar mapa" en el admin, este teléfono renueva sus archivos y cuadros guardados (una sola vez).
async function checkMapVersion(v) {
  v = +v || 0; let mine = null; try { mine = localStorage.getItem('av_map_ver'); } catch {}
  if (mine === null) { try { localStorage.setItem('av_map_ver', String(v)); } catch {} return; } // primera visita: ya está al día
  if (+mine === v) return;
  try { localStorage.setItem('av_map_ver', String(v)); } catch {}
  try { if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
    if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch {}
  location.reload();
}
async function load() {
  const pack = await fetchState(); state = pack.state; setNoCar(state?.config?.noCar);
  if (!document.body.classList.contains('is-offline')) checkMapVersion(state?.config?.mapVersion);
  const reports = pack.reports;
  if (!map) {
    map = await createMap({ provider: state.config.mapProvider, el: document.getElementById('map'), center: state.config.center, zoom: homeZoom(), googleKey: state.config.googleMapsKey, style: state.config.baseStyle });
    map.onClick(onMapClick);
    // El mapa a veces se mide antes de que termine de acomodarse la pantalla: se reajusta a 1 km una vez más
    const rehome = () => { if (!document.body.classList.contains('gps-on') && !nav?.active) goHome(); };
    setTimeout(() => { rehome(); setTimeout(() => document.getElementById('splash')?.classList.add('out'), 250); }, 700); window.addEventListener('load', () => setTimeout(rehome, 300), { once: true });
  }
  render(reports);
  gps.refresh(); nav.refresh();
}

// Vías alternas por cercanía: con una ruta marcada o el GPS encendido solo se muestran las que
// están en tu camino, y van apareciendo a medida que te acercas. "Ver todas" vuelve a la vista general.
const ALT_AHEAD_M = 700, ALT_SIDE_M = 150;
// Las vías alternas NO se dibujan por defecto (llenan el mapa y confunden): salen al navegar con GPS, al elegir
// un destino o una ruta, al tocar una en la lista, o con el botón del mapa para verlas todas.
let altAll = false, altDrawn = new Set(); const altFocus = new Set();
function altAnchor(r) {
  const p = state.points.find(x => x.id === r.avoids); if (p) return { lat: p.lat, lng: p.lng };
  const s = state.streets.find(x => x.id === r.avoids); const c = s ? s.coords : r.coords;
  const m = c[Math.floor(c.length / 2)]; return { lat: m[0], lng: m[1] };
}
// Con ruta o GPS: solo la vía alterna del PRÓXIMO peligro que está adelante en tu camino (una por peligro,
// máximo dos peligros), y desaparece cuando lo dejas atrás. Así el mapa no se llena de líneas.
function wantedRoutes(trip, user) {
  const groups = new Map(); // peligro -> { order, routes }
  for (const r of state.routes) {
    const a = altAnchor(r), key = r.avoids || r.id;
    let order;
    if (trip) {
      const h = progressOn(trip.route.coords, a); if (h.d > ALT_SIDE_M) continue;
      const u = user ? progressOn(trip.route.coords, user).s : 0;
      if (h.s < u - 20 || (user && h.s - u > ALT_AHEAD_M)) continue; // ya pasó, o aún muy lejos
      order = h.s - u;
    } else {
      const d = haversine(user, a); if (d > ALT_AHEAD_M) continue;
      if (isAhead({ user, point: a, heading: user.heading }) === false) continue;
      order = d;
    }
    const g = groups.get(key) || { order, routes: [] }; g.routes.push(r); groups.set(key, g);
  }
  return [...groups.values()].sort((x, y) => x.order - y.order).slice(0, trip && !user ? 3 : 2)
    .map(g => g.routes.sort((x, y) => nearestOnLine(altAnchor(x), x.coords).d - nearestOnLine(altAnchor(y), y.coords).d)[0]);
}
function syncRoutes() {
  if (!map || !state) return;
  const trip = nav.trip, user = gps.user, filtering = !altAll && (trip || user);
  const on = state.config.features?.routes !== false;
  const base = !on ? [] : altAll ? state.routes : (trip || user) ? wantedRoutes(trip, user) : [];
  const want = new Set([...base.map(r => r.id), ...(on ? [...altFocus].filter(id => state.routes.some(r => r.id === id)) : [])]);
  for (const [id, shp] of shapes.routes) if (!want.has(id)) { shp.remove(); shapes.routes.delete(id); }
  let fresh = 0;
  for (const r of state.routes) {
    if (!want.has(r.id) || shapes.routes.has(r.id)) continue;
    const shp = map.addPolyline({ coords: r.coords, status: 'ruta', flow: 'route', weight: 7, popup: `<b>Vía alterna: ${esc(r.name)}</b><br>${esc(r.description || '')}` });
    shapes.routes.set(r.id, shp);
    if (filtering && !altDrawn.has(r.id)) { shp.addClass?.('route-in'); fresh++; }
  }
  altDrawn = filtering ? new Set([...altDrawn, ...want].filter(id => want.has(id))) : new Set();
  if (fresh && user && Date.now() - (syncRoutes.lastToast || 0) > 8000 && (syncRoutes.lastToast = Date.now())) toast(fresh === 1 ? 'Vía alterna para el próximo punto inundado de tu camino.' : `${fresh} vías alternas para lo que viene en tu camino.`, 'ok');
  // Aviso con el conteo y el botón para la vista general
  const chip = $('#alt-chip'), total = state.routes.length, btn = $('#btn-alt'), shown = altAll || altFocus.size > 0;
  btn.hidden = !total || !on; btn.classList.toggle('on', shown); btn.setAttribute('aria-pressed', shown);
  btn.setAttribute('aria-label', shown ? 'Ocultar vías alternas' : 'Mostrar vías alternas'); btn.title = shown ? 'Ocultar las vías alternas' : `Mostrar las ${total} vías alternas`;
  chip.hidden = !(trip || user) || !total || !on;
  if (!chip.hidden) chip.innerHTML = altAll ? `<i></i>Vista general: ${total} vías alternas <u>Solo mi camino</u>`
    : `<i></i>${want.size ? `${want.size} ${want.size === 1 ? 'vía alterna' : 'vías alternas'} ${user ? 'adelante en tu camino' : 'en tu camino'}` : user ? 'Sin peligros adelante' : 'Ninguna vía alterna en tu camino'} <u>Ver todas</u>`;
}
$('#alt-chip').addEventListener('click', () => { altAll = !altAll; altFocus.clear(); altDrawn = new Set(); syncRoutes(); if (altAll && state.routes.length) map.fitBounds(state.routes.flatMap(r => r.coords)); });
$('#btn-alt').innerHTML = ICON.route;
$('#btn-alt').addEventListener('click', () => {
  const was = altAll || altFocus.size > 0; altAll = !was; altFocus.clear(); altDrawn = new Set(); syncRoutes();
  if (altAll && state.routes.length) map.fitBounds(state.routes.flatMap(r => r.coords));
  toast(altAll ? `Mostrando las ${state.routes.length} vías alternas. Vuelve a tocar el botón para ocultarlas.` : 'Vías alternas ocultas. Saldrán solas cuando elijas un destino o navegues.', 'ok');
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  // si ya había una versión instalada y llega una nueva, recarga una vez (así no queda CSS/JS viejo hasta salir y entrar)
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded && !document.body.classList.contains('gps-on')) { reloaded = true; location.reload(); } });
  // el service worker avisa cuando detecta archivos nuevos en el servidor: se recarga una vez (salvo mientras se navega con GPS)
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type !== 'shell-updated' || reloaded) return;
    const go = () => { if (reloaded) return; if (document.body.classList.contains('gps-on')) { setTimeout(go, 15000); return; } reloaded = true; location.reload(); };
    go();
  });
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Instalar como app (PWA): Android/Chrome/Edge muestran el botón Instalar; en iPhone se explica "Agregar a inicio".
(() => {
  const box = $('#install'); let deferred = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const later = () => { try { return Date.now() < +(localStorage.getItem('av_install_later') || 0); } catch { return false; } };
  const show = () => { if (standalone || later() || SIM) return; box.hidden = false; requestAnimationFrame(() => box.classList.add('on')); };
  const hide = days => { box.classList.remove('on'); setTimeout(() => (box.hidden = true), 300); if (days) try { localStorage.setItem('av_install_later', Date.now() + days * 864e5); } catch {} };
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; setTimeout(show, 4000); });
  window.addEventListener('appinstalled', () => { hide(); toast('El Sistema de Alerta Vial quedó instalado en tu teléfono.', 'ok'); });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  if (ios && !standalone) {
    $('#ins-d').innerHTML = 'Toca <svg class="ins-share" viewBox="0 0 24 24"><path d="M12 3v12m-4-8 4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg> <b>Compartir</b> y luego <b>Agregar a inicio</b>.';
    $('#ins-go').textContent = 'Entendido'; setTimeout(show, 4000);
  }
  $('#ins-go').addEventListener('click', async () => {
    if (!deferred) return hide(30);
    deferred.prompt(); const r = await deferred.userChoice.catch(() => null); deferred = null; hide(r?.outcome === 'accepted' ? 0 : 7);
  });
  $('#ins-x').addEventListener('click', () => hide(7));
})();

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
  $('#band-msg').innerHTML = `${weather.simulated ? '<span class="sim-tag">Simulación de prueba</span>' : ''}${esc(lvlMsg)}${alert.message ? `<span class="lvl-extra">${esc(alert.message)}</span>` : ''}`;

  // Clima
  const w = weather; renderWx(w);
  $('#weather').innerHTML = (w.ok ? outlookCard(w.outlook) + weatherCard(w)
    : `<div class="wx-card wx-off">${ICON.cloud}<span>Sin datos de clima por ahora. Las alertas manuales siguen activas.</span></div>`)
    + `<div class="wx-card wx-daycard sky-${w.ok ? skyOf(w) : 'nublado'}"><div class="wx-days" data-days>${daysCards(daysData)}</div></div>`;
  const srcOpen = $('#srcline details')?.open;
  $('#srcline').innerHTML = `<details class="src"${srcOpen ? ' open' : ''}><summary>${ICON.info}<span>De dónde salen los datos${w.ok ? ` <small>· ${wxTime(w.observedAt)}</small>` : ''}</span></summary><div class="src-b">
    <p><b>Clima:</b> ${esc(w.source)}${w.ok ? `, dato de las ${wxTime(w.observedAt)}` : ''}.${w.decidedBy ? ` Lluvia detectada por ${esc(w.decidedBy)}.` : ''}</p>
    ${w.ok && w.hourly?.length ? `<p><b>Probabilidad de lluvia:</b> la mayor entre la que publican los modelos y la parte de los modelos que prevén lluvia en cada hora${w.hourly[0]?.of ? ` (${w.hourly[0].of} modelos ahora)` : ''}.</p>` : ''}
    <p><b>Semáforo:</b> sube con lluvia medida desde ${dec(config.rainThresholdMm)} mm/h. Nivel sugerido por el clima: <span class="chip ${alert.suggested}">${LEVELS[alert.suggested]}</span></p></div></details>`;

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
  const nFlood = +$('#n-streets').textContent;
  renderGlance(nFlood);
  // La primera vez: si hay calles inundadas se abre esa pestaña; si no, el resumen
  if (!render.started && (render.started = true) && nFlood && config.features?.streets !== false) document.querySelector('.tab[data-tab="streets"]')?.click();
  const olv = !weather.intensity && ['atencion', 'probable'].includes(weather.outlook?.level) ? (weather.outlook.level === 'probable' ? 'Lluvia probable' : 'Podría llover') : '';
  $('#peek-t').textContent = `${nFlood ? `${nFlood} ${nFlood === 1 ? 'calle inundada' : 'calles inundadas'}` : olv || 'Sin calles inundadas'} · ${state.routes.length} ${state.routes.length === 1 ? 'vía alterna' : 'vías alternas'}`;
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

  // el contador de una pestaña solo se muestra si hay algo que contar
  document.querySelectorAll('.tab .n').forEach(n => { n.hidden = n.textContent.trim() === '0'; }); tabsFade();
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
  syncRoutes();
  for (const p of state.points) map.addMarker({ lat: p.lat, lng: p.lng, cls: p.severity, icon: p.type, pulse: p.severity === 'alta', popup: `<b>${esc(p.name)}</b><br><span class="chip ${p.severity === 'alta' ? 'roja' : p.severity === 'media' ? 'naranja' : 'accent'}">${PTYPE[p.type]} · ${SEV[p.severity]}</span><br>${esc(p.description || '')}` });
  shapes.overflows = new Map();
  for (const o of overflows) shapes.overflows.set(o.id, map.addOverflow({ lat: o.lat, lng: o.lng, iconSvg: ICON.wave,
    popup: `<b>Desborde de río</b><br>${esc(o.street || '')}<br>${esc(o.description)}<br><span style="color:#5A6B7D">Reportado ${ago(o.createdAt)} · verificado por EMOVTT</span>` }));
  renderOverflowBanner(overflows, rivers.filter(r => r.status === 'desbordado'));
  for (const r of reports.filter(r => r.type !== 'desborde')) map.addMarker({ lat: r.lat, lng: r.lng, cls: 'report', icon: 'report', popup: `<b>Reporte ciudadano verificado</b>${r.photo ? `<br><img src="${esc(r.photo)}" alt="Foto del reporte" style="width:100%;max-width:220px;border-radius:8px;margin:6px 0">` : ''}<br>${esc(r.street)} · ${esc(r.level)}<br>${esc(r.description)}<br><span style="color:#5A6B7D">${ago(r.createdAt)}</span>` });
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
  const tabs = [...document.querySelectorAll('.tab:not(.tab-map)')];
  tabs.forEach(t => { t.hidden = t.dataset.tab === 'sum' ? off('risk') && off('weather') : off(tabF[t.dataset.tab]); });
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
  if (pts.length === 1) { map.panTo({ lat: pts[0][0], lng: pts[0][1] }, 18); setTimeout(() => [...shapes.overflows.values()][0]?.open?.(), 500); }
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
const tabsFade = edgeFade($('#tabs'));
// Celular: barra de pestañas inferior; al tocar una sube la hoja con su contenido, y "Mapa" (o tocar el mapa) la baja
const isAppNav = () => document.documentElement.classList.contains('app-nav');
const paintTabs = () => { const open = document.documentElement.classList.contains('sheet-open');
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('is-on', x.dataset.tab === 'map' ? !open : open && x.getAttribute('aria-selected') === 'true')); };
function setSheet(on) { document.documentElement.classList.toggle('sheet-open', !!on && isAppNav()); paintTabs(); map?.invalidate(); }
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', e => {
  if (t.dataset.tab === 'map') { setSheet(false); return; }
  const same = t.getAttribute('aria-selected') === 'true';
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', x === t));
  document.querySelectorAll('.pane').forEach(p => p.hidden = p.id !== `pane-${t.dataset.tab}`);
  if (isAppNav() && e.isTrusted) { const open = document.documentElement.classList.contains('sheet-open'); setSheet(!(open && same)); if (!open || !same) $('.panel').scrollTop = 0; } else paintTabs();
  if (!isAppNav()) t.scrollIntoView({ inline: 'nearest', block: 'nearest' }); tabsFade();
}));
window.addEventListener('resize', () => { if (!isAppNav()) setSheet(false); else paintTabs(); });
document.querySelector('.mapwrap').addEventListener('pointerdown', e => { if (isAppNav() && document.documentElement.classList.contains('sheet-open') && !e.target.closest('.map-actions,.nav-search,.nav-card,.fab,.gps-bar')) setSheet(false); });
paintTabs();
// Celular: la tira de arriba de la hoja dice qué hay debajo del mapa y la abre o cierra
$('#peek-ic').innerHTML = ICON.chevron;
const panelUp = () => document.body.classList.toggle('panel-up', window.scrollY > 60);
window.addEventListener('scroll', panelUp, { passive: true });
$('#peek').addEventListener('click', () => {
  const up = window.scrollY > 60;
  window.scrollTo({ top: up ? 0 : Math.max(0, $('.panel').getBoundingClientRect().top + window.scrollY - Math.round(window.innerHeight * 0.3)), behavior: 'smooth' });
});
// Clic en lista → centrar en mapa
document.querySelector('.panel').addEventListener('click', e => {
  const it = e.target.closest('.item[data-id]'); if (!it) return;
  const sh = shapes[it.dataset.kind].get(it.dataset.id); const src = state[it.dataset.kind].find(x => x.id === it.dataset.id);
  if (it.dataset.kind === 'overflows') { map.panTo({ lat: src.lat, lng: src.lng }, 18); setTimeout(() => sh?.open?.(), 500); if (isAppNav()) setSheet(false); else if (window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  document.querySelectorAll('.item.selected').forEach(x => x.classList.remove('selected')); it.classList.add('selected');
  if (it.dataset.kind === 'routes' && !shapes.routes.has(it.dataset.id)) { altFocus.add(it.dataset.id); syncRoutes(); }
  const sh2 = it.dataset.kind === 'routes' ? shapes.routes.get(it.dataset.id) : sh;
  map.fitBounds(src.coords); setTimeout(() => sh2?.open?.(), 400);
  if (isAppNav()) setSheet(false); else if (window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('#btn-fit').addEventListener('click', goHome);

// Radar RainViewer
async function applyRadar() {
  if (!radarFrames.length) { const r = await (await fetch('/api/public/radar')).json(); radarFrames = r.frames || []; if (!radarFrames.length) { toast('El radar de lluvia no está disponible ahora.', 'err'); radarOn = false; $('#btn-radar').classList.remove('on'); return; } }
  let i = 0; clearInterval(radarTimer);
  const step = () => { map.setRadar(radarFrames[i].url); i = (i + 1) % radarFrames.length; };
  step(); radarTimer = setInterval(step, 900);
}
$('#btn-radar').addEventListener('click', () => { radarOn = !radarOn; $('#btn-radar').classList.toggle('on', radarOn); if (radarOn) applyRadar(); else { clearInterval(radarTimer); map.setRadar(null); } });

// Reporte ciudadano
$('#btn-report').addEventListener('click', () => { picking = true; $('#picking').classList.add('on'); if (isAppNav()) setSheet(false); else if (window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' }); });
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
const closeSheet = () => { clearPhoto(); $('#sheet-bg').classList.remove('open'); if (pickMarker) { pickMarker.remove(); pickMarker = null; } };
$('#r-cancel').addEventListener('click', closeSheet);
$('#sheet-bg').addEventListener('click', e => { if (e.target === e.currentTarget) closeSheet(); });
// Foto del reporte: se reduce en el teléfono (máx. 1280 px, JPEG) para que suba rápido con datos móviles.
let photoData = null;
function showPhoto(on) { $('#r-photo-view').hidden = !on; $('#r-photo-empty').hidden = on; $('#r-photo-box').classList.toggle('has', on); }
function clearPhoto() { photoData = null; $('#r-photo-cam').value = ''; $('#r-photo-gal').value = ''; $('#r-photo-prev').removeAttribute('src'); showPhoto(false); $('#r-photo-err').textContent = ''; $('#r-photo-box').classList.remove('bad'); }
async function onPhoto(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    photoData = c.toDataURL('image/jpeg', 0.72);
    $('#r-photo-prev').src = photoData; showPhoto(true);
    $('#r-photo-err').textContent = ''; $('#r-photo-box').classList.remove('bad');
  } catch { photoData = null; showPhoto(false); $('#r-photo-err').textContent = 'No se pudo leer esa imagen. Prueba con otra foto.'; }
  e.target.value = '';
}
$('#r-photo-cam').addEventListener('change', onPhoto); $('#r-photo-gal').addEventListener('change', onPhoto);
$('#r-photo-del').addEventListener('click', clearPhoto);
$('#report-form').addEventListener('submit', async e => {
  e.preventDefault(); $('#r-err').textContent = '';
  if (!photoData) { $('#r-photo-err').textContent = 'Agrega una fotografía: es obligatoria para comprobar el reporte.'; $('#r-photo-box').classList.add('bad'); return; }
  const body = { ...pickPos, type: rType, street: $('#r-street').value, level: $('#r-level').value, description: $('#r-desc').value, photo: photoData };
  const r = await fetch('/api/public/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { $('#r-err').textContent = j.error; return; }
  closeSheet(); e.target.reset(); clearPhoto(); toast('Gracias. Tu reporte fue enviado y será revisado.', 'ok');
});

load().catch(err => { console.error(err); toast('No se pudo cargar la información. Reintenta en unos segundos.', 'err'); });
setInterval(() => load().catch(() => {}), 60000);
// Cambios del admin en vivo: cada 10 s se consulta un número de revisión; si cambió, se recarga el estado de inmediato
let lastRev = null, revBusy = false;
async function pollRev() {
  if (revBusy || document.hidden || !navigator.onLine) return; revBusy = true;
  try { const r = await (await fetch('/api/public/rev', { cache: 'no-store', signal: AbortSignal.timeout(6000) })).json();
    const k = `${r.rev}|${r.mapVersion}`; if (lastRev !== null && k !== lastRev) await load(); lastRev = k; } catch {} finally { revBusy = false; }
}
setInterval(pollRev, 10000); pollRev();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastRev = null; load().catch(() => {}); pollRev(); } });

// Avisos de lluvia y tormenta (notificaciones push)
const pushBtn = $('#btn-push'), tip = $('#push-tip');
const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const b64 = k => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function pushSub() { const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
async function pushRefresh() {
  const on = !!(await pushSub().catch(() => null)) && Notification.permission === 'granted';
  pushBtn.setAttribute('aria-pressed', on);
  pushBtn.setAttribute('aria-label', on ? 'Avisos activados. Toca para desactivar' : 'Activar avisos de lluvia y tormenta');
  pushBtn.title = on ? 'Avisos activados (toca para desactivar)' : 'Activar avisos de lluvia y tormenta';
  if (on) tip.hidden = true;
  return on;
}
async function pushToggle() {
  try {
    const cur = await pushSub();
    if (cur) { await fetch('/api/public/push-unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: cur.endpoint }) }); await cur.unsubscribe(); toast('Avisos desactivados', 'ok'); return pushRefresh(); }
    if (Notification.permission === 'denied') return toast('Las notificaciones están bloqueadas: permítelas en los ajustes del navegador.', 'err');
    if (await Notification.requestPermission() !== 'granted') return toast('Sin permiso no podemos avisarte. Puedes activarlo cuando quieras con la campana.', 'err');
    const { key } = await (await fetch('/api/public/push-key')).json();
    const sub = await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    const r = await fetch('/api/public/push-subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    if (!r.ok) throw new Error('subscribe');
    toast('Avisos activados: te avisaremos si hay tormenta o se acerca lluvia.', 'ok'); pushRefresh();
  } catch { toast('No se pudieron activar los avisos en este navegador.', 'err'); }
}
if (pushOk) {
  pushBtn.hidden = false; pushBtn.innerHTML = ICON.bell; $('#pt-ic').innerHTML = ICON.bell;
  pushBtn.addEventListener('click', pushToggle);
  $('#pt-yes').addEventListener('click', () => { tip.hidden = true; pushToggle(); });
  $('#pt-no').addEventListener('click', () => { tip.hidden = true; try { localStorage.setItem('av_push_no', String(Date.now())); } catch {} });
  // Sugerencia: si aún no están activados (y no los rechazó hace poco), se ofrece una vez al abrir
  pushRefresh().then(on => {
    let no = 0; try { no = +localStorage.getItem('av_push_no') || 0; } catch {}
    if (!on && Notification.permission === 'default' && Date.now() - no > 7 * 864e5) setTimeout(() => { if (pushBtn.getAttribute('aria-pressed') !== 'true') tip.hidden = false; }, 4000);
  });
}
// Pronóstico de ayer, hoy y los próximos 2 días (se pide aparte y se guarda 30 min en el servidor)
async function loadDays() {
  try { const r = await fetch('/api/public/forecast-days', { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw 0; daysData = await r.json(); try { localStorage.setItem('av_days', JSON.stringify(daysData)); } catch {} }
  catch { try { daysData ||= JSON.parse(localStorage.getItem('av_days') || 'null'); } catch {} daysData ||= { ok: false, days: [] }; }
  document.querySelectorAll('[data-days]').forEach(el => { el.innerHTML = daysCards(daysData); });
}
loadDays(); setInterval(loadDays, 30 * 60 * 1000);
document.addEventListener('click', e => { if (e.target.closest('[data-days-retry]')) { daysData = null; document.querySelectorAll('[data-days]').forEach(el => { el.innerHTML = daysCards(null); }); loadDays(); } });
