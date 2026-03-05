const CACHE_NAME = 'gastos-nafta-v2';
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/template-ticket.json'
];

// Install event - cachea archivos críticos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(URLS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate event - limpia cachés antigués
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - network-first para API, cache-first para assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Las API calls van a red primero
  if (url.pathname.includes('/api/') || url.pathname.includes('/worker')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cachea si es exitosa
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clone);
            });
          }
          return response;
        })
        .catch(() => {
          // Si falla, intenta caché
          return caches.match(request)
            .then((response) => response || new Response('Offline mode - No hay caché disponible', { status: 503 }));
        })
    );
  } else {
    // Assets: cache first, network fallback
    event.respondWith(
      caches.match(request)
        .then((response) => response || fetch(request)
          .then((response) => {
            if (!response.ok) throw new Error('Network response not ok');
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clone);
            });
            return response;
          })
          .catch(() => new Response('Offline - recurso no disponible', { status: 503 }))
        )
    );
  }
});

// Background sync - sincroniza tickets pendientes cuando vuelve online
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-tickets') {
    event.waitUntil(
      (async () => {
        const db = await openIndexedDB();
        const pendingTickets = await getPendingTickets(db);
        
        for (const ticket of pendingTickets) {
          try {
            const response = await fetch('/api/ticket', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(ticket)
            });
            if (response.ok) {
              await markTicketSynced(db, ticket.id);
            }
          } catch (error) {
            console.error('Sync failed:', error);
          }
        }
      })()
    );
  }
});

// Notificaciones push
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const options = {
    body: data.body || 'Nuevo evento',
    icon: '/data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect fill="%231e40af" width="192" height="192"/><text x="96" y="110" font-size="80" font-weight="bold" fill="white" text-anchor="middle">⛽</text></svg>',
    badge: '/data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="%231e40af"/></svg>',
    tag: data.tag || 'notification',
    requireInteraction: data.requireInteraction || false
  };

  event.waitUntil(self.registration.showNotification(data.title || 'Gastos Nafta', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// Helper: OpenIndexedDB
async function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('gastosNaftaDB', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('tickets')) {
        db.createObjectStore('tickets', { keyPath: 'id' });
      }
    };
  });
}

// Helper: Get pending tickets
async function getPendingTickets(db) {
  return new Promise((resolve) => {
    const tx = db.transaction('tickets', 'readonly');
    const store = tx.objectStore('tickets');
    const request = store.getAll();
    request.onsuccess = () => {
      resolve(request.result.filter((t) => !t.synced));
    };
  });
}

// Helper: Mark ticket as synced
async function markTicketSynced(db, ticketId) {
  return new Promise((resolve) => {
    const tx = db.transaction('tickets', 'readwrite');
    const store = tx.objectStore('tickets');
    const request = store.get(ticketId);
    request.onsuccess = () => {
      const ticket = request.result;
      ticket.synced = true;
      store.put(ticket);
      resolve();
    };
  });
}
