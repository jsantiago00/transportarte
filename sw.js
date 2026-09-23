// Service worker mínimo: sólo existe para que el navegador considere la
// página "instalable" y para que la app abra (aunque sea con lo último que
// se pudo cargar) sin conexión. No intenta cachear datos en vivo - mapas,
// rutas y ubicación siempre van a la red, tal cual.
const CACHE_NAME = 'transportarte-shell-v1';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // mapas/API/geocoder: siempre a la red

  // Red primero (para no quedar pegado a una versión vieja de la app), y
  // sólo si falla (sin conexión) recurrimos a lo último que quedó guardado.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
