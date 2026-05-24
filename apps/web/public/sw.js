/* eslint-disable no-restricted-globals */
// aistock service worker — minimal: install/activate + push + notificationclick.
// iOS 16.4+ requires the SW to be home-screen-installed AND every push to call
// showNotification() — silent pushes will unregister the subscription.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'aistock', body: '', url: '/' };
  try {
    if (event.data) {
      try {
        payload = { ...payload, ...event.data.json() };
      } catch {
        payload.body = event.data.text();
      }
    }
  } catch {
    // swallow — still must call showNotification per iOS policy
  }

  const { title, body, url } = payload;
  event.waitUntil(
    self.registration.showNotification(title || 'aistock', {
      body: body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          const target = new URL(targetUrl, self.location.origin);
          if (clientUrl.origin === target.origin) {
            await client.focus();
            if ('navigate' in client) {
              await client.navigate(target.href);
            }
            return;
          }
        } catch {
          // ignore parse errors, fall through to openWindow
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
