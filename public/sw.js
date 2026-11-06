/* ReadPage · Nesux — funciona sin conexión para abrir la app (las páginas nuevas sí necesitan internet). */
const CACHE = 'readpage-v56';
const COMPARTIDO = 'readpage-compartido';
const BASE = ['/', '/index.html', '/styles.css', '/app.js', '/archivos.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== COMPARTIDO).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // «Compartir → ReadPage» desde la galería, WhatsApp, etc.: se guardan los archivos y se abre la app para leerlos.
  if (e.request.method === 'POST' && u.origin === location.origin && u.pathname === '/compartir') {
    e.respondWith((async () => {
      const datos = await e.request.formData();
      const archivos = datos.getAll('archivos').filter(f => f && typeof f === 'object' && f.size);
      const c = await caches.open(COMPARTIDO);
      for (const k of await c.keys()) await c.delete(k);
      let i = 0;
      for (const f of archivos) {
        await c.put('/compartido/' + (i++), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Nombre': encodeURIComponent(f.name || 'archivo') } }));
      }
      const q = new URLSearchParams();
      ['title', 'text', 'url'].forEach(k => { const v = datos.get(k); if (v) q.set(k, v); });
      if (i) q.set('compartido', String(i));
      return Response.redirect('/?' + q.toString(), 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/voz/')) return;   // la API siempre en vivo
  // Primero la red (para tener siempre lo último); si no hay conexión, lo guardado.
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});
