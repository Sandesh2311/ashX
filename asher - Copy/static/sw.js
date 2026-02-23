const CACHE_NAME = 'pulsechat-v1';
const SHELL = [
  '/',
  '/chat',
  '/static/css/styles.css',
  '/static/js/chat.js',
  '/static/js/pwa.js',
  '/static/manifest.webmanifest',
  '/static/images/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (req.url.includes('/api/messages/') || req.url.includes('/api/contacts')) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/chat')))
  );
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const payload = event.data.payload || {};
    self.registration.showNotification(payload.title || 'PulseChat', {
      body: payload.body || 'New message',
      icon: '/static/images/icon.svg',
      badge: '/static/images/icon.svg',
      data: payload.data || { url: '/chat' }
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/chat';
  event.waitUntil(clients.openWindow(url));
});
