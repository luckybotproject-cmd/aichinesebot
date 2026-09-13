// ═══ Chinese Signal Bot — Service Worker (Push Notifications) ═══
// Handles push events, notification clicks, install & activate lifecycle.

const CACHE_VERSION = 'csai-sw-v3';
// Intentionally EMPTY: the app HTML must never be served from cache, otherwise
// users would keep running outdated application code after a deploy.
// (There is no fetch handler in this worker — every request goes to the network.)
const OFFLINE_ASSETS = [];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_VERSION).then(cache => cache.addAll(OFFLINE_ASSETS).catch(() => {}))
    );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        Promise.all([
            clients.claim(),
            caches.keys().then(keys =>
                Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
            ),
        ])
    );
});

// ── Push received ─────────────────────────────────────────────────────────────
// v8 (mobile fix): a push event MUST always end in a visible notification —
// Android Chrome and iOS PWAs revoke push permission for "silent" pushes. Every
// branch below therefore resolves to showNotification(), even on a parse error.
self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch(e) { data = { title: 'Chinese Signal Bot', body: (event.data && event.data.text && event.data.text()) || '' }; }
    if (!data || typeof data !== 'object') data = {};

    const title   = data.title   || '🤖 Chinese Signal Bot';
    const options = {
        body:    data.body    || 'You have a new update.',
        icon:    data.icon    || '/icon-192.png',
        badge:   data.badge   || '/icon-192.png',
        image:   data.image   || undefined,
        // A stable tag + renotify makes the phone re-alert (sound + vibration)
        // instead of silently replacing an older notification.
        tag:     data.tag     || 'csai-push-' + Date.now(),
        renotify: true,
        silent:  false,
        vibrate: data.vibrate || [300, 120, 300, 120, 300],
        timestamp: Date.now(),
        dir:     'auto',
        lang:    data.lang || 'en',
        requireInteraction: data.requireInteraction !== false,
        data:    { url: data.url || '/', orderId: data.orderId || null, key: data.key || null },
        actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
    };

    // Append key directly in body if present
    if (data.key) {
        options.body += `\n\n🔑 Key: ${data.key}`;
        options.requireInteraction = true;
    }

    event.waitUntil(
        self.registration.showNotification(title, options)
            // Last-resort fallback: some Android builds reject `actions`/`image`.
            // Retry with the bare minimum so the user still sees the message.
            .catch(() => self.registration.showNotification(title, {
                body:  options.body,
                icon:  '/icon-192.png',
                badge: '/icon-192.png',
                vibrate: [300, 120, 300],
                data:  options.data,
            }))
            .catch(() => {})
    );
});

// ── Notification clicked ──────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';

    const target = new URL(targetUrl, self.location.origin);

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windowClients => {
            // 1. Exact match → just focus it.
            for (const client of windowClients) {
                if (new URL(client.url).href === target.href) return client.focus();
            }
            // 2. Any tab of this site → reuse it and navigate (no duplicate tabs).
            for (const client of windowClients) {
                if (new URL(client.url).origin === target.origin) {
                    if ('navigate' in client) { try { await client.navigate(target.href); } catch (e) {} }
                    return client.focus();
                }
            }
            // 3. Nothing open → open one window.
            return clients.openWindow(target.href);
        })
    );
});

// ── Notification closed (dismissed) ──────────────────────────────────────────
self.addEventListener('notificationclose', event => {
    // Optional: track dismissals via beacon
});

// ── Background sync (for deferred analytics) ─────────────────────────────────
self.addEventListener('sync', event => {
    if (event.tag === 'csai-sync') {
        event.waitUntil(Promise.resolve());
    }
});

// ── Push subscription rotated by the browser (common on mobile) ──────────────
self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
            cs.forEach(c => c.postMessage({ type: 'csai-resubscribe' }));
        })
    );
});
