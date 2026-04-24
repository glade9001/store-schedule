// ===== 莉學商行 Service Worker =====
// 策略：HTML 永遠走網路，靜態資源才快取

const CACHE_NAME = 'lixue-static-v1';

// 只快取靜態資源（圖示、manifest）
const STATIC_ASSETS = [
  '/store-schedule/icon-192.svg',
  '/store-schedule/icon-512.svg',
  '/store-schedule/manifest.json',
];

// ===== 安裝 =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting()) // 立即接管，不等舊 SW 結束
  );
});

// ===== 啟動：清除舊快取 =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // 立即接管所有分頁
  );
});

// ===== 攔截請求 =====
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase / Google 請求：完全不攔截
  if(url.hostname.includes('firebase') ||
     url.hostname.includes('firestore') ||
     url.hostname.includes('google') ||
     url.hostname.includes('gstatic')) {
    return;
  }

  // HTML 頁面：永遠走網路（確保拿到最新版本）
  // 離線時才用快取
  if(event.request.destination === 'document' ||
     event.request.url.endsWith('.html')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' }) // 強制不用瀏覽器快取
        .catch(() => caches.match(event.request)) // 離線時用快取
    );
    return;
  }

  // 靜態資源（圖示、manifest）：Cache First
  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(response => {
        if(response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ===== 接收訊息 =====
self.addEventListener('message', event => {
  if(event.data === 'SKIP_WAITING') self.skipWaiting();
});
