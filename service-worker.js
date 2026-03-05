// Flota ML — Service Worker v4.1
const CACHE = 'flota-ml-v4';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c =>
      c.addAll(['/LogisticaML/', '/LogisticaML/index.html', '/LogisticaML/manifest.json'])
       .catch(()=>{})
    )
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
  // No interceptar API calls ni POST
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('workers.dev')) return;
  if (e.request.url.includes('fonts.googleapis')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      // Network first, cache fallback
      return fetch(e.request)
        .then(res => {
          // Solo cachear respuestas válidas de github.io — sin clonar si ya se usó
          if (res.ok && res.status === 200 && e.request.url.includes('github.io')) {
            const resClone = res.clone(); // clonar ANTES de usar
            caches.open(CACHE).then(c => c.put(e.request, resClone));
          }
          return res;
        })
        .catch(() => cached || caches.match('/LogisticaML/index.html'));
    })
  );
});

self.addEventListener('sync', e => {
  if (e.tag === 'flush-queue') {
    e.waitUntil(
      self.clients.matchAll({type:'window'}).then(clients =>
        clients.forEach(c => c.postMessage({type:'FLUSH_QUEUE'}))
      )
    );
  }
});

self.addEventListener('push', e => {
  let d = {title:'Flota ML', body:'Notificación', tag:'fml'};
  try { d = {...d, ...e.data.json()}; } catch(_) {}
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body, tag: d.tag,
      icon: '/LogisticaML/icon-192.png',
      badge: '/LogisticaML/icon-192.png',
      vibrate: [100, 50, 100],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:'window', includeUncontrolled:true}).then(clients => {
      const app = clients.find(c => c.url.includes('LogisticaML'));
      return app ? app.focus() : self.clients.openWindow('/LogisticaML/');
    })
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
