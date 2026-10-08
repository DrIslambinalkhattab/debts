const V = 'daftar-aldoyoon-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const CDN = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']; // خطوط وأيقونات: تُخزَّن عند أول زيارة بنت
self.addEventListener('install', e => {
  // كل ملف على حدة: غياب ملف واحد (مثل أيقونة) لا يُفشل تثبيت الـ Service Worker كله
  e.waitUntil(caches.open(V).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url), same = u.origin === self.location.origin;
  if (!same && !CDN.includes(u.hostname)) return; // طلبات Supabase لا تمر من هنا إطلاقًا
  e.respondWith((async () => {
    const c = await caches.open(V);
    const hit = await c.match(r, { ignoreSearch: same });
    const upd = () => fetch(r).then(x => { if (x && (x.ok || x.type === 'opaque')) c.put(r, x.clone()); return x; }).catch(() => null);
    if (hit) { if (same) e.waitUntil(upd()); return hit; } // نسخة الكاش فورًا، وتحديثها في الخلفية (يصل التحديث في الفتحة التالية)
    const x = await upd();
    return x || (r.mode === 'navigate' ? (await c.match('./index.html')) || Response.error() : Response.error());
  })());
});
