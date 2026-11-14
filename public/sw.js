// Service worker de AlertaVial: permite abrir el mapa sin señal.
// - La página, estilos y scripts se guardan al instalar y se actualizan cada vez que hay red.
// - Los cuadros del mapa (OpenStreetMap) que ya viste quedan guardados para verlos sin conexión.
// - Los datos (calles, zonas, vías alternas) los guarda la propia página en el teléfono.
const VER = 'av-shell-v5', TILES = 'av-tiles-v1', MAX_TILES = 1500;
const SHELL = ['/', '/css/app.css', '/js/app.js', '/js/common.js', '/js/gps.js', '/js/nav.js', '/js/map-provider.js',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/img/emovtt-logo.png', '/img/emovtt-logo-blanco.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tile.openstreetmap.org') { e.respondWith(tile(req)); return; }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return; // datos y panel: siempre en vivo
  e.respondWith(shell(req, url));
});

// Primero la red (para recibir siempre la última versión); si no hay señal, lo guardado.
async function shell(req, url) {
  const cache = await caches.open(VER);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, ko) => setTimeout(() => ko(new Error('timeout')), 6000))]);
    if (res.ok) cache.put(url.pathname === '/index.html' ? '/' : req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? cache.match('/') : Response.error());
  }
}

// Cuadros del mapa: si ya está guardado se usa sin gastar datos; si no, se descarga y se guarda.
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req); if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()).then(() => trim(cache)); }
    return res;
  } catch { return Response.error(); }
}
let trimming = false;
async function trim(cache) {
  if (trimming) return; trimming = true;
  try { const ks = await cache.keys(); for (let i = 0; i < ks.length - MAX_TILES; i++) await cache.delete(ks[i]); } finally { trimming = false; }
}
