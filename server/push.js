// Notificaciones push (Web Push). Las claves VAPID se crean una vez y se guardan en la base (db.push).
// Cada teléfono que activa los avisos queda en db.push.subs. No hay servicios de pago: lo envía el navegador del teléfono.
import webpush from 'web-push';
import { load, save } from './db.js';

function store() {
  const db = load();
  if (!db.push) db.push = {};
  if (!db.push.vapid) { const k = webpush.generateVAPIDKeys(); db.push.vapid = { publicKey: k.publicKey, privateKey: k.privateKey }; save(); }
  db.push.subs ||= []; db.push.last ||= {};
  return db.push;
}
export const publicKey = () => store().vapid.publicKey;
export const subCount = () => store().subs.length;

export function addSub(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  const p = store();
  p.subs = p.subs.filter(s => s.endpoint !== sub.endpoint);
  if (p.subs.length >= 5000) p.subs.shift();
  p.subs.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, at: new Date().toISOString() });
  save(); return true;
}
export function removeSub(endpoint) { const p = store(); const n = p.subs.length; p.subs = p.subs.filter(s => s.endpoint !== endpoint); if (p.subs.length !== n) save(); }

export async function sendAll({ title, body, tag, level }) {
  const p = store();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:alertavial@emovtt.gob.ec', p.vapid.publicKey, p.vapid.privateKey);
  const payload = JSON.stringify({ title, body, tag: tag || 'alertavial', level: level || 'normal', url: '/' });
  let sent = 0, dead = [];
  await Promise.all(p.subs.map(s => webpush.sendNotification(s, payload, { TTL: 3 * 3600, urgency: 'high' }).then(() => { sent++; })
    .catch(e => { if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint); })));
  if (dead.length) { p.subs = p.subs.filter(s => !dead.includes(s.endpoint)); save(); }
  return { sent, removed: dead.length, total: p.subs.length + dead.length };
}

const LV = { normal: 0, amarilla: 1, naranja: 2, roja: 3 };
const NAME = { amarilla: 'Alerta amarilla', naranja: 'Alerta naranja', roja: 'Alerta roja' };
const COOLDOWN = 2 * 3600 * 1000;
// Decide qué avisar según el estado actual. Solo avisa cuando algo EMPIEZA o EMPEORA (no repite cada 5 minutos).
export async function checkAndNotify(st, { levelMessage, simulated } = {}) {
  const p = store(), L = p.last, now = Date.now();
  const pre = simulated ? 'Prueba: ' : '';
  const out = [];
  const w = st.weather || {}, ol = w.outlook?.level;
  const storm = (w.intensity >= 4) || (w.outlook?.reasons || []).some(r => /prevé tormenta|reporta tormenta/.test(r));
  const rainy = ol === 'lloviendo' || w.intensity > 0;
  const soon = ol === 'probable';
  const can = k => !L[k + 'At'] || now - L[k + 'At'] > COOLDOWN;
  const fire = async (k, msg) => { L[k + 'At'] = now; save(); out.push({ k, ...msg }); if (p.subs.length) await sendAll(msg); };
  // 1) Nivel de alerta que sube
  const first = L.init !== true; L.init = true;
  const lv = LV[st.effective] ?? 0, prev = L.level ?? 0;
  if (!first && lv > prev && lv >= 1) await fire('level', { title: `${pre}${NAME[st.effective]} en Santa Rosa`, body: levelMessage || 'Revisa el mapa para ver las calles afectadas.', tag: 'nivel', level: st.effective });
  L.level = lv;
  // 2) Tormenta
  if (!first && storm && !L.storm && can('storm')) await fire('storm', { title: `${pre}Tormenta en la zona`, body: 'Hay tormenta o se prevé en las próximas horas. Evita ríos, canales y calles bajas.', tag: 'tormenta', level: 'naranja' });
  L.storm = !!storm;
  // 3) Se aproxima lluvia / empezó a llover
  if (!first && !storm && soon && !L.soon && !rainy && can('soon')) await fire('soon', { title: `${pre}Se aproxima lluvia`, body: w.outlook?.text || 'Es probable un aguacero en las próximas horas. Lleva paraguas.', tag: 'lluvia', level: 'amarilla' });
  L.soon = !!soon;
  if (!first && rainy && !L.rain && can('rain')) await fire('rain', { title: `${pre}Está lloviendo en Santa Rosa`, body: 'Revisa las calles inundadas y las vías alternas antes de salir.', tag: 'lluvia', level: 'amarilla' });
  L.rain = !!rainy; save();
  return out;
}
