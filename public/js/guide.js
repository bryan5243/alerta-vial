// Indicaciones giro a giro (estilo Google Maps) y detección de "te saliste de la ruta".
// Los giros vienen de OSRM (steps=true, con nombres de calles). Si una ruta no los trae
// (ruta guardada antigua o desvío armado a mano), se calculan por la forma de la línea.
import { haversine, bearing, progressOn } from './gps.js';

const SIDE = { left: 'a la izquierda', right: 'a la derecha', 'slight left': 'ligeramente a la izquierda', 'slight right': 'ligeramente a la derecha',
  'sharp left': 'cerrado a la izquierda', 'sharp right': 'cerrado a la derecha', straight: 'recto', uturn: 'en U' };
const ORD = ['', 'primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta'];
const CARD = b => ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'][Math.round(((b % 360) + 360) % 360 / 45) % 8];

// Paso de OSRM → { lat, lng, icon, text, short }
export function fromOsrmStep(st) {
  const m = st.maneuver || {}, mod = m.modifier || 'straight', side = SIDE[mod] || '', name = st.name ? ` por ${st.name}` : '', on = st.name ? ` en ${st.name}` : '';
  const [lng, lat] = m.location || [0, 0];
  let text, icon = mod.includes('left') ? (mod.includes('slight') ? 'slight-left' : 'left') : mod.includes('right') ? (mod.includes('slight') ? 'slight-right' : 'right') : mod === 'uturn' ? 'uturn' : 'straight';
  switch (m.type) {
    case 'depart': text = `Sal hacia el ${CARD(m.bearing_after || 0)}${name}`; icon = 'straight'; break;
    case 'arrive': text = 'Llegas a tu destino'; icon = 'flag'; break;
    case 'roundabout': case 'rotary': case 'roundabout turn': text = `En la rotonda, toma la ${ORD[m.exit] || ''} salida${name}`.replace('la  salida', 'la salida'); icon = 'roundabout'; break;
    case 'fork': text = `Mantente ${side}${name}`; break;
    case 'end of road': text = `Al final de la calle, gira ${side}${on}`; break;
    case 'new name': case 'continue': text = mod === 'straight' ? `Continúa recto${name}` : `Sigue ${side}${name}`; break;
    case 'merge': text = `Incorpórate ${side}${name}`; break;
    default: text = mod === 'straight' ? `Sigue recto${name}` : mod === 'uturn' ? 'Da la vuelta en U' : `Gira ${side}${on}`;
  }
  return { lat, lng, icon, text, type: m.type };
}

// Sin datos de OSRM: giros donde la línea cambia de rumbo más de 35°.
export function turnsFromGeometry(coords) {
  const out = [], P = i => ({ lat: coords[i][0], lng: coords[i][1] });
  let last = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    if (haversine(P(last), P(i)) < 25) continue;
    let j = i + 1; while (j < coords.length - 1 && haversine(P(i), P(j)) < 20) j++;
    const d = ((bearing(P(i), P(j)) - bearing(P(last), P(i)) + 540) % 360) - 180;
    if (Math.abs(d) < 35) continue;
    const mod = Math.abs(d) > 150 ? 'uturn' : `${Math.abs(d) < 60 ? 'slight ' : Math.abs(d) > 120 ? 'sharp ' : ''}${d < 0 ? 'left' : 'right'}`;
    out.push(fromOsrmStep({ maneuver: { type: 'turn', modifier: mod, location: [coords[i][1], coords[i][0]] } }));
    last = i;
  }
  const e = coords.at(-1); out.push({ lat: e[0], lng: e[1], icon: 'flag', text: 'Llegas a tu destino', type: 'arrive' });
  return out;
}

export const TURN_SVG = {
  straight: '<path d="M12 21V4m-6 6 6-6 6 6"/>',
  left: '<path d="M17 21v-7a4 4 0 0 0-4-4H5m5-5-5 5 5 5"/>',
  right: '<path d="M7 21v-7a4 4 0 0 1 4-4h8m-5-5 5 5-5 5"/>',
  'slight-left': '<path d="M15 21v-6L7 7m0 7V7h7"/>',
  'slight-right': '<path d="M9 21v-6l8-8m0 7V7h-7"/>',
  uturn: '<path d="M8 21V9a5 5 0 0 1 10 0v4m-4-3 4 4 4-4"/>',
  roundabout: '<circle cx="12" cy="10" r="4"/><path d="M12 21v-7m4-4h5m-3-3 3 3-3 3"/>',
  flag: '<path d="M6 21V4h11l-2 4 2 4H6"/>',
};

const fmt = m => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

// Guía de la ruta en curso: decide la próxima indicación, la anuncia por voz y detecta desvíos.
export function createGuide({ el, getVoice, onOffRoute }) {
  let route = null, steps = [], idx = 0, said = new Map(), off = 0, lastReroute = 0, busy = false;

  function setRoute(r) {
    route = r; idx = 0; said = new Map(); off = 0;
    const raw = r?.steps?.length ? r.steps : r ? turnsFromGeometry(r.coords) : [];
    steps = raw.filter(s => s.type !== 'depart').map(s => ({ ...s, s: progressOn(r.coords, s).s }));
  }
  function speak(t) {
    if (!getVoice() || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = 'es-ES'; u.rate = 1.03;
    speechSynthesis.speak(u); // en cola: no corta los avisos de peligro
  }
  function render(st, dist, next) {
    el.hidden = false; el.className = `turn${st.icon === 'flag' ? ' arrive' : ''}`;
    el.innerHTML = `<div class="turn-ic"><svg viewBox="0 0 24 24">${TURN_SVG[st.icon] || TURN_SVG.straight}</svg></div>
      <div class="turn-tx"><b>${fmt(dist)}</b><span>${st.text}</span></div>
      ${next ? `<div class="turn-next">Luego <svg viewBox="0 0 24 24">${TURN_SVG[next.icon] || TURN_SVG.straight}</svg></div>` : ''}`;
  }
  function rerouting(msg) {
    el.hidden = false; el.className = 'turn rerouting';
    el.innerHTML = `<div class="turn-ic"><span class="turn-spin"></span></div><div class="turn-tx"><b>Recalculando</b><span>${msg}</span></div>`;
  }

  // Se llama en cada posición del GPS (o del simulador).
  async function update(user) {
    if (!route || !user) { el.hidden = true; return; }
    const p = progressOn(route.coords, user);
    // ¿Fuera de la ruta? Muy lejos (más de ~2,5 veces el margen) = al instante; cerca del margen = 2 lecturas seguidas
    // (así un salto del GPS no recalcula por gusto). El margen es 35 m, o más si el GPS es impreciso.
    const tol = Math.max(35, (user.accuracy || 0) * 1.5);
    off = p.d > tol * 2.5 ? off + 2 : p.d > tol ? off + 1 : 0;
    if (off >= 2 && !busy && Date.now() - lastReroute > 3000) {
      busy = true; lastReroute = Date.now(); rerouting('Tomaste otra calle: buscando el mejor camino');
      speak('Recalculando ruta');
      let ok = false;
      for (let t = 0; t < 2 && !ok; t++) { try { await onOffRoute(user); ok = true; } catch { /* reintenta una vez */ } }
      if (!ok) { rerouting('Sin conexión para recalcular. Vuelve a la línea azul; lo intento de nuevo.'); speak('No hay conexión para recalcular. Regrese a la ruta marcada.'); lastReroute = Date.now() + 3000; off = 2; }
      else off = 0;
      busy = false; return;
    }
    if (busy) return;
    while (idx < steps.length - 1 && steps[idx].s < p.s - 8) idx++;
    const st = steps[idx]; if (!st) { el.hidden = true; return; }
    const dist = Math.max(0, st.s - p.s), next = steps[idx + 1];
    render(st, dist, dist < 120 && next && next.s - st.s < 150 ? next : null);
    const k = said.get(idx) || 0;
    if (st.icon === 'flag' && dist < 30 && k < 3) { said.set(idx, 3); speak('Llegaste a tu destino'); return; }
    if (k < 1 && dist > 60 && dist <= 260) { said.set(idx, 1); speak(`En ${fmt(dist).replace(' m', ' metros').replace(' km', ' kilómetros')}, ${lower(st.text)}`); }
    else if (k < 2 && dist <= 45) { said.set(idx, 2); speak(st.text); }
  }
  const lower = t => t.charAt(0).toLowerCase() + t.slice(1);

  return { setRoute, update, hide() { el.hidden = true; }, get rerouting() { return busy; } };
}
