// Flota ML 2.0 — Service Worker
const CACHE = 'fml2-v6';
const API = 'https://logisticaml.santamariapablodaniel.workers.dev';
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
  // version.json: siempre red, nunca pasa por Cache Storage. El chequeo de
  // actualización le agrega ?t=timestamp para evitar el caché HTTP, pero eso
  // haría que el cache-first de abajo guarde una entrada NUEVA por cada
  // chequeo (cada pocos minutos, para siempre) sin limpiarlas nunca — un
  // leak de storage lento. Se deja pasar directo, sin interceptar.
  if (url.pathname.endsWith('/version.json')) return;

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

// Background Sync: Android lo dispara apenas hay señal, aunque la app esté
// cerrada o el celular bloqueado. Manda la cola directo desde acá (misma base
// IndexedDB 'fml2' que usa la página). Si algo falla, se rechaza la promesa y
// el navegador reintenta solo más tarde. El servidor ignora duplicados.
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('fml2', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    r.onupgradeneeded = () => { r.result.createObjectStore('pendientes', { keyPath: 'id' }); r.result.createObjectStore('cache'); }; });
}
const req = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
// Mismo candado que la página (IDB.reclamar): solo uno de los dos manda cada item
function reclamar(db, id) {
  return new Promise(res => { try {
    const t = db.transaction('pendientes', 'readwrite'), st = t.objectStore('pendientes'), q = st.get(id);
    q.onsuccess = () => { const it = q.result; if (!it || (it.enviandoDesde && Date.now() - it.enviandoDesde < 90000)) return res(false);
      it.enviandoDesde = Date.now(); st.put(it); t.oncomplete = () => res(true); t.onerror = () => res(false); };
    q.onerror = () => res(false); } catch (e) { res(false); } });
}
async function toDataURL(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer()); let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(bin);
}
async function enviarCola() {
  const db = await idb();
  const token = await req(db.transaction('cache').objectStore('cache').get('token'));
  if (!token) return;
  const items = await req(db.transaction('pendientes').objectStore('pendientes').getAll());
  let pendiente = false;
  for (const it of items || []) {
    if (!(await reclamar(db, it.id))) { pendiente = true; continue; }
    try {
      const url = it.retake ? `${API}/api/cargas/${it.cargaId}/foto` : `${API}/api/cargas`;
      const body = it.retake ? { tipo: it.fotoTipo, foto: await toDataURL(it.foto) }
        : { id: it.id, vehiculoId: it.vehiculoId, fotoTicket: await toDataURL(it.ticket), fotoTablero: it.tablero ? await toDataURL(it.tablero) : null };
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
      if (r.ok || (r.status >= 400 && r.status < 500 && ![401, 408, 429].includes(r.status)))
        await req(db.transaction('pendientes', 'readwrite').objectStore('pendientes').delete(it.id));
      else pendiente = true;
    } catch (e) { pendiente = true; }
  }
  (await self.clients.matchAll()).forEach(c => c.postMessage({ type: 'FLUSH_QUEUE' }));
  if (pendiente) throw new Error('quedan pendientes — el navegador reintenta');
}
self.addEventListener('sync', e => {
  if (e.tag === 'flush-queue') e.waitUntil(enviarCola());
});

// ── WEB PUSH (igual a v1, probado en producción) ─────────────────────────────
self.addEventListener('push', e => {
  let title = '🚛 Flota ML', body = 'Nueva notificación', tag = 'fml', url = '/LogisticaML/';
  try {
    if (e.data) { const d = e.data.json(); if (d.title) title = d.title; if (d.body) body = d.body; if (d.tag) tag = d.tag; if (d.url) url = d.url; }
  } catch (_) { try { if (e.data) body = e.data.text(); } catch (__) { } }
  const ICON = '/LogisticaML/icon-192.png';
  const isIOS = /iphone|ipad|ipod/i.test(self.navigator?.userAgent || '');
  const options = {
    body, tag,
    ...(isIOS ? {} : { icon: ICON, badge: ICON }),
    vibrate: [200, 100, 200],
    data: { url },
  };
  e.waitUntil(
    self.registration.showNotification(title, options).catch(() =>
      self.registration.showNotification(title, { body, tag, vibrate: [200, 100, 200], data: { url } })
    )
  );
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/LogisticaML/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes('/LogisticaML/'));
      // Si la app ya está abierta, se la lleva a la URL del aviso (ej. ?retake=id)
      if (existing) return existing.navigate(url).then(c => (c || existing).focus()).catch(() => existing.focus());
      return self.clients.openWindow(url);
    })
  );
});