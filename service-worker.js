// Flota ML — Service Worker v4
// Maneja: notificaciones push + background sync + cache offline

const CACHE_NAME = 'flota-ml-v4';
const API_BASE   = 'https://logisticaml.santamariapablodaniel.workers.dev';

// ── INSTALL: cachear recursos esenciales ─────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/LogisticaML/', '/LogisticaML/index.html', '/LogisticaML/manifest.json'])
        .catch(() => {}) // silencioso si falla algún recurso
    )
  );
  self.skipWaiting();
});

// ── ACTIVATE: limpiar caches viejos ──────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH: cache-first para assets, network-first para API ───────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // No interceptar llamadas a la API del worker
  if (url.hostname.includes('workers.dev')) return;
  // No interceptar POST
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.url.includes('github.io')) {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('/LogisticaML/index.html'));
    })
  );
});

// ── BACKGROUND SYNC: flush cola offline ──────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'flush-queue') {
    e.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  try {
    // Notificar a todos los clientes abiertos para que hagan flush
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage({ type: 'FLUSH_QUEUE' }));
  } catch(e) {}
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Flota ML', body: 'Notificación', tag: 'fml', icon: '' };
  try { data = { ...data, ...e.data.json() }; } catch(_) {}

  const options = {
    body:    data.body,
    tag:     data.tag,
    icon:    data.icon || '/LogisticaML/icon-192.png',
    badge:   '/LogisticaML/icon-192.png',
    vibrate: [100, 50, 100],
    data:    data,
    actions: data.actions || [],
    requireInteraction: data.requireInteraction || false,
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Si la app está abierta, enfocarla
      const existing = clients.find(c => c.url.includes('LogisticaML'));
      if (existing) return existing.focus();
      // Si no, abrirla
      return self.clients.openWindow('/LogisticaML/');
    })
  );
});

// ── MESSAGE: recibir mensajes de la app ───────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
