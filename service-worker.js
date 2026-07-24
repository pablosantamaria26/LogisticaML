// Flota ML 2.0 — Service Worker
const CACHE = 'fml2-v2';
const SHELL = ['/LogisticaML/', '/LogisticaML/index.html', '/LogisticaML/manifest.json', '/LogisticaML/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // API y externos: siempre red
  if (url.hostname.includes('workers.dev')) return;
  if (url.origin !== self.location.origin) return;

  // HTML: SIEMPRE red, ignorando el caché HTTP del navegador (GitHub Pages manda
  // Cache-Control: max-age=600 — sin esto, un fix recién publicado puede tardar
  // hasta 10 minutos en llegarle a un celular, o quedar "pegado" en una pestaña
  // que Android reanuda sin recargar). Cache de Cache Storage solo como respaldo offline.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('index.html') || url.pathname === '/LogisticaML/') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('/LogisticaML/index.html')))
    );
    return;
  }
  // Resto: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => cached))
  );
});

// Background Sync → avisar a la página que mande la cola
self.addEventListener('sync', e => {
  if (e.tag === 'flush-queue') {
    e.waitUntil(self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage({ type: 'FLUSH_QUEUE' }))));
  }
});

// ── WEB PUSH (igual a v1, probado en producción) ─────────────────────────────
self.addEventListener('push', e => {
  let title = '🚛 Flota ML', body = 'Nueva notificación', tag = 'fml';
  try {
    if (e.data) { const d = e.data.json(); if (d.title) title = d.title; if (d.body) body = d.body; if (d.tag) tag = d.tag; }
  } catch (_) { try { if (e.data) body = e.data.text(); } catch (__) { } }
  const ICON = '/LogisticaML/icon-192.png';
  const isIOS = /iphone|ipad|ipod/i.test(self.navigator?.userAgent || '');
  const options = {
    body, tag,
    ...(isIOS ? {} : { icon: ICON, badge: ICON }),
    vibrate: [200, 100, 200],
    data: { url: '/LogisticaML/' },
  };
  e.waitUntil(
    self.registration.showNotification(title, options).catch(() =>
      self.registration.showNotification(title, { body, tag, vibrate: [200, 100, 200], data: { url: '/LogisticaML/' } })
    )
  );
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/LogisticaML/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes('/LogisticaML/'));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});