// Flota ML — Service Worker v23
const CACHE = 'flota-ml-v23';
const STATIC = ['/LogisticaML/', '/LogisticaML/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname.includes('workers.dev') || url.hostname.includes('googleapis') || url.hostname.includes('brevo')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200) return res;
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => cached);
    })
  );
});

self.addEventListener('sync', e => {
  if (e.tag === 'flush-queue') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'FLUSH_QUEUE' }))
      )
    );
  }
});

// ── WEB PUSH ──────────────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let title = '🚛 Flota ML';
  let body = 'Nueva notificación';
  let tag = 'fml';

  try {
    if (e.data) {
      const d = e.data.json();
      if (d.title) title = d.title;
      if (d.body)  body  = d.body;
      if (d.tag)   tag   = d.tag;
    }
  } catch (_) {
    try { if (e.data) body = e.data.text(); } catch(__) {}
  }

  // Ícono PNG para Android (SVG no es soportado por el NotificationManager nativo de Android)
  // Usamos el ícono hosteado en GitHub Pages para no depender de CDNs externos
  const ICON_PNG = 'https://pablosantamaria26.github.io/LogisticaML/icon-192.png';

  const options = {
    body,
    tag,
    icon: ICON_PNG,
    badge: ICON_PNG,
    vibrate: [200, 100, 200],
    requireInteraction: false,
    data: { url: '/LogisticaML/' },
  };

  e.waitUntil(
    self.registration.showNotification(title, options)
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
