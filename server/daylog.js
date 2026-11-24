// Diario del clima: el servidor anota cada día lo que vio (temperaturas, lluvia confirmada) y el último pronóstico del día.
// Así "Ayer" tiene dato aunque Open-Meteo no responda (MET Norway no da días pasados).
import { load, save } from './db.js';
import { rainFromLog, INT_TXT, WMO_TXT, yesterdayFromArchive } from './weather.js';

const r1 = x => +(+x || 0).toFixed(1);
const ecNow = (t = Date.now()) => new Date(t - 5 * 3600e3);
export const dayKey = (t = Date.now()) => ecNow(t).toISOString().slice(0, 10);
const addDays = (date, k) => new Date(new Date(date + 'T12:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10);
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

function entry(db, date) {
  db.dayLog ||= {};
  return (db.dayLog[date] ||= { date });
}
function prune(db) {
  const keys = Object.keys(db.dayLog || {}).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete db.dayLog[k];
}
let lastSave = 0;
function maybeSave(changed) { if (changed && Date.now() - lastSave > 5 * 60e3) { lastSave = Date.now(); save(); } }

// Cada vez que se calcula el clima: temperatura y lluvia observadas del día
export function noteObservation(w, now = Date.now()) {
  if (!w?.ok) return;
  const db = load(), e = entry(db, dayKey(now)), before = JSON.stringify(e);
  if (w.temperature != null) { e.oMax = Math.max(e.oMax ?? -99, w.temperature); e.oMin = Math.min(e.oMin ?? 99, w.temperature); }
  const sinceMidnight = (now - new Date(dayKey(now) + 'T05:00:00Z').getTime()) / 3600e3;
  e.oMm = Math.max(e.oMm || 0, rainFromLog(Math.max(0.1, sinceMidnight), now));
  e.maxInt = Math.max(e.maxInt || 0, w.intensity || 0);
  e.obs = (e.obs || 0) + 1;
  prune(db);
  const changed = JSON.stringify({ ...e, obs: 0 }) !== JSON.stringify({ ...JSON.parse(before), obs: 0 });
  maybeSave(changed);
}
// La tarjeta "Hoy" del pronóstico: se guarda el máximo de lluvia/temperatura visto en el día
function noteForecast(db, card) {
  if (!card || card.na) return;
  const e = entry(db, card.date);
  if (card.tMax != null) e.fMax = Math.max(e.fMax ?? -99, card.tMax);
  if (card.tMin != null) e.fMin = Math.min(e.fMin ?? 99, card.tMin);
  if ((card.mm ?? 0) >= (e.fMm ?? -1)) { e.fMm = card.mm ?? 0; e.code = card.code; e.text = card.text; }
}
function cardFromLog(e, rel) {
  if (!e || (e.fMax == null && e.oMax == null)) return null;
  const observedRain = e.maxInt > 0 || e.oMm > 0;
  // Lluvia: lo que el sistema confirmó; si no confirmó lluvia en todo el día, 0 aunque el pronóstico dijera otra cosa.
  const mm = e.obs >= 6 ? r1(e.oMm) : r1(Math.max(e.oMm || 0, e.fMm || 0));
  let text = e.text || '', code = e.code;
  if (observedRain && e.maxInt) text = INT_TXT[Math.min(4, e.maxInt)];
  else if (e.obs >= 6 && RAIN_CODES.has(e.code)) { text = WMO_TXT[3]; code = 3; } // el pronóstico decía lluvia pero no llovió: nublado
  return { date: e.date, rel, code, text, tMax: e.oMax ?? e.fMax, tMin: e.oMin ?? e.fMin, mm, saved: true };
}
// Completa "Ayer" con el diario (o con el archivo de Open-Meteo) cuando el pronóstico no lo trae
let archive = { date: '', card: null, at: 0 };
export async function withHistory(d, cfg) {
  if (!d?.ok || !d.days?.length) return d;
  const db = load();
  const today = d.days.find(x => x.rel === 0); noteForecast(db, today);
  const yDate = addDays(today?.date || dayKey(), -1);
  const days = d.days.map(x => ({ ...x }));
  const yi = days.findIndex(x => x.rel === -1);
  if (yi >= 0 && (days[yi].na || days[yi].partial)) {
    let card = cardFromLog(db.dayLog?.[yDate], -1);
    if (!card) {
      if (archive.date === yDate && archive.card) card = archive.card;
      else if (archive.date !== yDate || Date.now() - archive.at > 30 * 60e3) {
        archive = { date: yDate, card: null, at: Date.now() };
        try { archive.card = card = await yesterdayFromArchive(cfg, yDate); } catch {}
      }
    }
    if (card) days[yi] = card;
  }
  maybeSave(true);
  return { ...d, days };
}
