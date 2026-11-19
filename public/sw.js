// Service worker de AlertaVial: permite abrir el mapa sin señal.
// - La página, estilos y scripts se guardan al instalar y se actualizan cada vez que hay red.
// - Los cuadros del mapa (OpenStreetMap) que ya viste quedan guardados para verlos sin conexión.
// - Los datos (calles, zonas, vías alternas) los guarda la propia página en el teléfono.
const VER = 'av-shell-v55', TILES = 'av-tiles-v3', MAX_TILES = 1500;
const SHELL = ['/', '/css/app.css', '/js/app.js', '/js/common.js', '/js/gps.js', '/js/nav.js', '/js/map-provider.js', '/js/weather-fx.js', '/js/guide.js',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/img/emovtt-logo.png', '/img/emovtt-logo-blanco.png', '/manifest.webmanifest', '/img/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tile.openstreetmap.org' || /^[abc]\.tile\.openstreetmap\.fr$/.test(url.hostname)) { e.respondWith(tile(req)); return; }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return; // datos y panel: siempre en vivo
  e.respondWith(shell(req, url));
});

// Primero la red (para recibir siempre la última versión); si no hay señal, lo guardado.
async function shell(req, url) {
  const cache = await caches.open(VER);
  try {
    const res = await Promise.race([fetch(req, { cache: 'no-cache' }), new Promise((_, ko) => setTimeout(() => ko(new Error('timeout')), 6000))]);
    if (res.ok) cache.put(url.pathname === '/index.html' ? '/' : req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? cache.match('/') : Response.error());
  }
}

// Cuadros del mapa: si ya está guardado (y tiene menos de 3 días) se usa sin gastar datos; si es más viejo se pide de nuevo
// y solo si no hay señal se usa el guardado. Solo se guardan respuestas correctas (nunca cuadros de error).
const TILE_AGE = 3 * 24 * 3600 * 1000;
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  const age = hit ? Date.now() - (+hit.headers.get('x-cached-at') || 0) : Infinity;
  if (hit && age < TILE_AGE) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type !== 'opaque') {
      const blob = await res.clone().blob();
      if (blob.size > 200) cache.put(req, new Response(blob, { headers: { 'content-type': res.headers.get('content-type') || 'image/png', 'x-cached-at': String(Date.now()) } })).then(() => trim(cache));
    }
    return res;
  } catch { return hit || Response.error(); }
}
let trimming = false;
async function trim(cache) {
  if (trimming) return; trimming = true;
  try { const ks = await cache.keys(); for (let i = 0; i < ks.length - MAX_TILES; i++) await cache.delete(ks[i]); } finally { trimming = false; }
}

// Avisos push: lluvia que se aproxima, tormenta o cambio de alerta.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'AlertaVial', { body: d.body || '', tag: d.tag || 'alertavial', renotify: true,
    icon: '/img/icons/icon-192.png', badge: '/img/icons/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => { const c = cs.find(x => 'focus' in x); return c ? c.focus() : self.clients.openWindow(e.notification.data?.url || '/'); }));
});
