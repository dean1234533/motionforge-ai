// MotionForge service worker. It makes the app installable and shows a friendly page when offline.
// It deliberately caches nothing, so every deploy reaches people straight away.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MotionForge AI</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f14;color:#e8ebf2;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}button{margin-top:16px;min-height:44px;padding:0 20px;border:0;border-radius:999px;background:#6b7cff;color:#fff;font:inherit;font-weight:600}</style></head>
<body><div><h1>You're offline</h1><p>MotionForge needs an internet connection. Check your connection and try again.</p><button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
});
