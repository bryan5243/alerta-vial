export const LEVELS = { normal: 'Sin alerta', amarilla: 'Alerta amarilla', naranja: 'Alerta naranja', roja: 'Alerta roja' };
export const LEVEL_DESC = { normal: 'Vías operando con normalidad.', amarilla: 'Lluvia prevista. Planifique su ruta.', naranja: 'Calles inundadas. Evite los sectores marcados.', roja: 'Riesgo alto. No circule por las zonas señaladas.' };
export const STATUS = { inundada: 'Inundada', parcial: 'Parcialmente inundada', despejada: 'Despejada' };
export const PTYPE = { interseccion: 'Intersección inundable', inundacion: 'Inundación', riesgo: 'Zona de riesgo', alcantarilla: 'Alcantarilla obstruida' };
export const SEV = { alta: 'Alta', media: 'Media', baja: 'Baja' };
export const RIVER = { normal: 'Nivel normal', crecido: 'Crecido', desbordado: 'Desbordado' };
export const ZSEV = { alta: 'Grave · sin paso', media: 'Moderada', baja: 'Leve' };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTime = iso => iso ? new Date(iso).toLocaleString('es-EC', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '';
// Hora de un dato del clima en hora de Ecuador (Open-Meteo ya viene en hora local, sin zona; el resto en UTC)
export const wxTime = t => !t ? '' : /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? new Date(t).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil', hourCycle: 'h23' }) : String(t).slice(11, 16);
export const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };

export function toast(msg, kind = '') {
  let w = document.querySelector('.toast-wrap'); if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; w.setAttribute('aria-live', 'polite'); document.body.appendChild(w); }
  if ([...w.children].some(x => x.dataset.msg === msg && !x.classList.contains('out'))) return; // mismo aviso ya visible
  while (w.children.length >= 3) w.firstChild.remove(); // no apilar demasiados avisos
  const t = document.createElement('div'); t.className = `toast ${kind}`;
  t.innerHTML = `<span class="toast-ic">${kind === 'err' ? ICON.warn : kind === 'ok' ? ICON.check : ICON.info}</span><span></span><i class="toast-bar"></i>`;
  t.children[1].textContent = msg; t.dataset.msg = msg; w.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 280); }, 3400);
}

// Ventana de confirmación propia (en lugar del confirm() del navegador). Devuelve una promesa con true/false.
export function confirmBox({ title = '¿Estás seguro?', text = '', ok = 'Aceptar', cancel = 'Cancelar', tone = 'danger', icon } = {}) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'cbox-bg';
    bg.innerHTML = `<div class="cbox ${tone}" role="alertdialog" aria-modal="true" aria-labelledby="cbox-t" aria-describedby="cbox-d">
      <div class="cbox-ic">${icon || (tone === 'danger' ? ICON.trash || ICON.warn : ICON.warn)}</div>
      <h3 id="cbox-t"></h3><p id="cbox-d"></p>
      <div class="cbox-acts"><button type="button" class="btn ghost" data-c="0"></button><button type="button" class="btn ${tone === 'danger' ? 'danger' : ''}" data-c="1"></button></div></div>`;
    bg.querySelector('h3').textContent = title; bg.querySelector('p').textContent = text;
    bg.querySelector('[data-c="0"]').textContent = cancel; bg.querySelector('[data-c="1"]').textContent = ok;
    const prev = document.activeElement;
    const done = v => { bg.classList.add('out'); document.removeEventListener('keydown', key, true); setTimeout(() => { bg.remove(); prev?.focus?.(); }, 200); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(false); } if (e.key === 'Tab') { const bs = [...bg.querySelectorAll('button')]; const i = bs.indexOf(document.activeElement); e.preventDefault(); bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus(); } };
    bg.addEventListener('click', e => { if (e.target === bg) done(false); const b = e.target.closest('[data-c]'); if (b) done(b.dataset.c === '1'); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(bg); bg.querySelector('[data-c="1"]').focus();
  });
}
export const ICON = {
  bell: '<svg class="i" viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  drop: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/></svg>',
  route: '<svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H12"/></svg>',
  info: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>',
  warn: '<svg class="i" viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  cloud: '<svg class="i" viewBox="0 0 24 24"><path d="M17.5 19a4.5 4.5 0 0 0 .4-9A7 7 0 0 0 4.3 12.5 3.5 3.5 0 0 0 5.5 19z"/><path d="M8 21l1-2m3 2 1-2m3 2 1-2"/></svg>',
  radar: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  flag: '<svg class="i" viewBox="0 0 24 24"><path d="M4 22V4a2 2 0 0 1 2-2h11l-1.5 4L17 10H6"/></svg>',
  check: '<svg class="i" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  edit: '<svg class="i" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg class="i" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  shield: '<svg class="i" viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5z"/></svg>',
  settings: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  inbox: '<svg class="i" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/></svg>',
  logout: '<svg class="i" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  expand: '<svg class="i" viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  shrink: '<svg class="i" viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  chevron: '<svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  eye: '<svg class="i" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  layers: '<svg class="i" viewBox="0 0 24 24"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>',
  upload: '<svg class="i" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  nav: '<svg class="i" viewBox="0 0 24 24"><path d="M3 11 22 2l-9 19-2-8z"/></svg>',
  locate: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3" class="loc-dot"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>',
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>',
  stop: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  volume: '<svg class="i" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
  gauge: '<svg class="i" viewBox="0 0 24 24"><path d="M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0"/></svg>',
  wave: '<svg class="i" viewBox="0 0 24 24"><path d="M2 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
};
export const waveSvg = `<svg viewBox="0 0 1200 40" preserveAspectRatio="none"><path fill="#fff" d="M0 20 Q75 0 150 20 T300 20 T450 20 T600 20 T750 20 T900 20 T1050 20 T1200 20 V40 H0z"/></svg>`;

// Marca con fade-l / fade-r una fila que se desplaza de lado, para que se note que hay más opciones fuera de la vista
export function edgeFade(el) {
  if (!el) return () => {};
  const f = () => { const max = el.scrollWidth - el.clientWidth; el.classList.toggle('fade-r', max > 16 && el.scrollLeft < max - 16); el.classList.toggle('fade-l', max > 16 && el.scrollLeft > 2); };
  el.addEventListener('scroll', f, { passive: true }); new ResizeObserver(f).observe(el); f();
  return f;
}

export const dec = n => String(n).replace('.', ',');
// Lluvia por horas (12 h, se desliza): probabilidad arriba y milímetros abajo; y el resumen por partes del día
const tone = p => (p >= 80 ? ' hi' : p >= 50 ? ' mid' : '');
export function rainHours(w) {
  const hrs = (w.hourly || []).slice(0, 12).filter(h => h?.time);
  if (hrs.length < 3) return '';
  return `<div class="wx-hours"><div class="wx-hours-h"><span class="wx-hours-t">Lluvia por horas</span><span class="wx-hours-k">% de probabilidad · mm</span></div>
    <div class="wx-hours-g" role="list" tabindex="0" aria-label="Probabilidad de lluvia de las próximas ${hrs.length} horas">${hrs.map((h, i) => {
    const p = h.probability == null ? null : Math.max(0, Math.min(100, Math.round(h.probability))), mm = h.precipitation ?? 0, t = i ? `${h.time.slice(11, 13)} h` : 'Ahora';
    return `<div class="wh${tone(p)}${i ? '' : ' now'}" role="listitem" aria-label="${t}: ${p == null ? 'sin dato' : `${p} %`}${mm >= .1 ? `, ${dec(mm)} mm` : ''}"><span class="wh-p">${p == null ? '–' : `${p}%`}</span><span class="wh-bar"><i style="height:${Math.max(4, p ?? 0)}%"></i></span><span class="wh-mm${mm >= .1 ? '' : ' z'}">${mm >= .1 ? dec(mm) : '0'}</span><span class="wh-t">${t}</span></div>`;
  }).join('')}</div>${partsRows(w)}</div>`;
}
function partsRows(w) {
  const ps = (w.periods || []).slice(0, 4); if (!ps.length) return '';
  const hr = t => +t.slice(11, 13);
  // todo seco: una sola línea en vez de cuatro renglones iguales
  if (ps.every(p => p.probability < 80)) return `<p class="wx-dry">Sin probabilidad alta de lluvia (80 % o más) en las próximas 24 horas.</p>`;
  return `<div class="wx-parts">${ps.map(p => `<div class="wp${tone(p.probability)}"><span class="wp-l">${p.label}<small>${hr(p.from)}–${(hr(p.to) + 1) % 24} h</small></span><span class="wp-bar"><i style="width:${Math.max(3, p.probability)}%"></i></span><b class="wp-p">${p.probability}%</b><span class="wp-mm">${p.precipitation >= .1 ? `${dec(p.precipitation)} mm` : p.probability >= 50 ? '< 0,1 mm' : '0 mm'}</span></div>`).join('')}</div>`;
}

// Pronóstico por días: ayer (ya ocurrió), hoy y los 2 días siguientes
const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export function daysCards(d) {
  const head = '<div class="wx-days-h"><span class="wx-hours-t">Ayer, hoy y los próximos 2 días</span><span class="wx-hours-k">pronóstico</span></div>';
  if (!d) return `${head}<p class="wx-days-msg">Cargando el pronóstico…</p>`;
  if (!d.ok || !d.days?.length) return `${head}<p class="wx-days-msg">No se pudo cargar el pronóstico por días${d.error ? ` <small>(${esc(d.error)})</small>` : ''}. <button type="button" class="linklike" data-days-retry>Reintentar</button></p>`;
  const lab = x => x.rel === -1 ? 'Ayer' : x.rel === 0 ? 'Hoy' : x.rel === 1 ? 'Mañana' : WD[new Date(x.date + 'T12:00:00').getDay()];
  return `<div class="wx-days-h"><span class="wx-hours-t">Ayer, hoy y los próximos 2 días</span><span class="wx-hours-k">${d.stale ? 'dato guardado' : esc(d.source || 'Open-Meteo')}</span></div>
    <div class="wx-days-g" role="list">${d.days.map(x => {
    const p = x.prob == null ? null : Math.round(x.prob), past = x.rel < 0;
    if (x.na) return `<div class="wd past" role="listitem"><span class="wd-l">${lab(x)}</span><span class="wd-t">Sin dato</span><span class="wd-r">no disponible</span></div>`;
    const wet = past ? x.mm >= 1 : (p ?? 0) >= 80 || x.mm >= 5;
    return `<div class="wd${x.rel === 0 ? ' today' : ''}${past ? ' past' : ''}${wet ? ' wet' : ''}" role="listitem" aria-label="${lab(x)}: ${x.text}, ${past ? 'llovió' : 'lluvia'} ${dec(x.mm)} mm${p == null || past ? '' : `, probabilidad ${p} %`}">
      <span class="wd-l">${lab(x)}</span><span class="wd-t">${x.text || '–'}</span>
      <span class="wd-temp"><b>${x.tMax == null ? '–' : Math.round(x.tMax)}°</b> <small>${x.tMin == null ? '' : Math.round(x.tMin) + '°'}</small></span>
      <span class="wd-r">${past ? `${dec(x.mm)} mm` : p == null ? `${dec(x.mm)} mm` : `${p}% · ${dec(x.mm)} mm`}</span>${past ? `<span class="wd-n">${x.saved ? 'registrado' : 'ya ocurrió'}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

// Transitabilidad de un reporte ciudadano: cómo está el paso y qué vehículos pueden pasar ('allow': los únicos que se pueden elegir)
const sv = d => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
export const VEH = {
  moto: ['Motos', sv('<circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path fill="currentColor" d="M6 11.5h5.5l1.8-2.2h3.2l.8 3-3 1.2h-2.6L10 16H8.2L7 13.5H4.8z"/><path d="M19 17l-2.6-7.7M15 7.3h2.8M5 17l2-3.5"/>')],
  auto: ['Autos', sv('<path d="M3 13l2-5.5A2 2 0 0 1 6.9 6h10.2A2 2 0 0 1 19 7.5l2 5.5v4a1 1 0 0 1-1 1h-1M3 13v4a1 1 0 0 0 1 1h1M3 13h18M9 18h6"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>')],
  camioneta: ['Camionetas 4x4', sv('<path d="M2 16v-5.5h9V7h5l3.5 4H22v5h-1.5M2 16h1.5M8.5 16h7"/><circle cx="6" cy="16.5" r="2.2"/><circle cx="18" cy="16.5" r="2.2"/>')],
  pesado: ['Buses y camiones', sv('<rect x="4" y="3" width="16" height="14.5" rx="2.5"/><path d="M4 10.5h16M7.5 21v-3.5M16.5 21v-3.5M8 14h.01M16 14h.01"/>')],
};
const WATER = '<path d="M2 21c1.7 0 1.7-1.3 3.3-1.3S7 21 8.7 21s1.6-1.3 3.3-1.3 1.7 1.3 3.3 1.3 1.7-1.3 3.4-1.3S20.3 21 22 21"/>';
export const PASS = {
  cerrada: { t: 'Calle cerrada', d: 'No pasa ningún vehículo', c: '#C62E2E', can: [], ic: sv('<rect x="3" y="7" width="18" height="6" rx="1.5"/><path d="M8.5 7 5.5 13M14 7l-3 6M19.5 7l-3 6M6 13v7M18 13v7M4 20h4M16 20h4"/>') },
  altos: { t: 'Solo vehículos altos', d: 'Camionetas, buses y camiones', c: '#E36A17', can: ['camioneta', 'pesado'], allow: ['camioneta', 'pesado'], ic: sv('<path d="M2 14v-5h9V6h5l3.5 4H22v4h-1.5M2 14h1.5M8.5 14h7"/><circle cx="6" cy="14.5" r="2"/><circle cx="18" cy="14.5" r="2"/>' + WATER) },
  lento: { t: 'Tránsito lento', d: 'Motos y autos pasan con cuidado', c: '#B98900', can: ['moto', 'auto', 'camioneta', 'pesado'], ic: sv('<path d="M3 12l2-5a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 7l2 5v3a1 1 0 0 1-1 1h-1M3 12v3a1 1 0 0 0 1 1h1M3 12h18M9 16h6"/><circle cx="7" cy="16" r="1.8"/><circle cx="17" cy="16" r="1.8"/>' + WATER) },
  normal: { t: 'Se puede pasar', d: 'Poca agua, tránsito casi normal', c: '#2A8C5A', can: ['moto', 'auto', 'camioneta', 'pesado'], ic: sv('<path d="M20 6 9 17l-5-5"/>') },
};
// Resumen para popups y el panel: estado del paso + íconos de quién puede pasar
export function accessHtml(a, { small = false } = {}) {
  const p = a && PASS[a.pass]; if (!p) return '';
  const can = (a.can || []).filter(v => VEH[v]);
  return `<span class="acc${small ? ' sm' : ''}"><span class="acc-pass" style="--c:${p.c}">${p.ic}${esc(p.t)}</span>`
    + (a.pass === 'cerrada' ? '' : can.length ? `<span class="acc-veh" title="Pueden pasar: ${esc(can.map(v => VEH[v][0]).join(', '))}">${can.map(v => `<span aria-label="${esc(VEH[v][0])}">${VEH[v][1]}</span>`).join('')}</span>` : '<span class="acc-veh none">Nadie indicado</span>')
    + '</span>';
}
