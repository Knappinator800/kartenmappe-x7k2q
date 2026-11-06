/* Hält die App-Dateien offline bereit. Karten-API und Bilder laufen übers Netz, außer die Bilder der Wunschliste, die du offline gespeichert hast. */
var CACHE = 'pokesammlung-v7';
var IMG = 'pokesammlung-img';
var FILES = ['./', 'index.html', 'sync.js', 'firebase-config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    /* Der Bilderspeicher bleibt bei App-Updates erhalten. */
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== IMG; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) {
    /* Kartenbilder: gespeicherte Kopie, sonst ganz normal übers Netz. */
    if (req.destination === 'image') {
      e.respondWith(
        caches.match(req, { cacheName: IMG }).catch(function () { return null; }).then(function (r) { return r || fetch(req); })
      );
    }
    return;
  }
  /* Zuerst das Netz (damit Updates sofort ankommen), ohne Netz die gespeicherte Kopie. */
  e.respondWith(
    fetch(req).then(function (res) {
      /* Fehlerseiten (zum Beispiel 404 bei einer Störung) weder anzeigen noch speichern, stattdessen die gespeicherte Kopie nehmen. */
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () { return caches.match(req, { cacheName: CACHE }).then(function (r) { return r || caches.match('index.html', { cacheName: CACHE }); }); })
  );
});
