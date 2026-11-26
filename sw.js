/* TERRARIUM service worker — offline shell + cache */
var CACHE = 'gaggo-v23';
var SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/config.js',
  './js/storage.js',
  './js/zip.js',
  './js/zipread.js',
  './js/app.js',
  './assets/wallpaper.svg',
  './assets/wallpaper-night.svg',
  './assets/wallpaper-amber.svg',
  './assets/terrarium.svg',
  './assets/favicon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (url) {
      return c.add(url).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // låt CDN:er vara
  if (url.pathname.indexOf('/storage/v1/') >= 0) return; // filer aldrig i cache

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
      return res;
    }).catch(function () { return caches.match('./index.html'); }));
    return;
  }

  // Kod och stilar: alltid nätet först, annars kan en gammal app.js
  // bli kvar i cache trots att index.html är uppdaterad.
  if (/\.(js|css|webmanifest)$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return caches.match(req); }));
    return;
  }

  // Bilder och övrigt: cache-first med bakgrundsuppdatering.
  e.respondWith(caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  }));
});
