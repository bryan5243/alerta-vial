export const LEVELS = { normal: 'Sin alerta', amarilla: 'Alerta amarilla', naranja: 'Alerta naranja', roja: 'Alerta roja' };
export const LEVEL_DESC = { normal: 'Vías operando con normalidad.', amarilla: 'Lluvia prevista. Planifique su ruta.', naranja: 'Calles inundadas. Evite los sectores marcados.', roja: 'Riesgo alto. No circule por las zonas señaladas.' };
export const STATUS = { inundada: 'Inundada', parcial: 'Parcialmente inundada', despejada: 'Despejada' };
export const PTYPE = { interseccion: 'Intersección inundable', inundacion: 'Inundación', riesgo: 'Zona de riesgo', alcantarilla: 'Alcantarilla obstruida' };
export const SEV = { alta: 'Alta', media: 'Media', baja: 'Baja' };
export const RIVER = { normal: 'Nivel normal', crecido: 'Crecido', desbordado: 'Desbordado' };
export const ZSEV = { alta: 'Grave · sin paso', media: 'Moderada', baja: 'Leve' };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTime = iso => iso ? new Date(iso).toLocaleString('es-EC', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '';
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
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>',
  stop: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  volume: '<svg class="i" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
  gauge: '<svg class="i" viewBox="0 0 24 24"><path d="M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0"/></svg>',
  wave: '<svg class="i" viewBox="0 0 24 24"><path d="M2 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
};
export const waveSvg = `<svg viewBox="0 0 1200 40" preserveAspectRatio="none"><path fill="#fff" d="M0 20 Q75 0 150 20 T300 20 T450 20 T600 20 T750 20 T900 20 T1050 20 T1200 20 V40 H0z"/></svg>`;
