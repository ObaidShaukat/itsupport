// Service worker for desktop notifications (Web Push). The server sends
// { title, body, url, tag }; clicking the notification focuses an open portal tab on that
// page, or opens a new one. Works while the browser is running, even with no portal tab.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Cleartwo IT Support';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/logo.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = windows.find((w) => w.url === target.href);
    if (same) return same.focus();
    const tab = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      return tab.navigate(target.href).catch(() => self.clients.openWindow(target.href));
    }
    return self.clients.openWindow(target.href);
  })());
});
