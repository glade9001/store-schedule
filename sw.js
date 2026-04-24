// ===== 莉學商行 Service Worker =====
const CACHE_NAME = 'lixue-v1';
const CACHE_VERSION = 1;

// 需要快取的核心資源
const CORE_ASSETS = [
  '/store-schedule/home.html',
  '/store-schedule/schedule-V2.html',
  '/store-schedule/salary.html',
  '/store-schedule/manifest.json',
  '/store-schedule/icon-192.svg',
  '/store-schedule/icon-512.svg',
];

// ===== 安裝：快取核心資源 =====
self.addEventListener('install', event => {
  console.log('[SW] 安裝中...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] 快取核心資源');
      return cache.addAll(CORE_ASSETS).catch(err => {
        console.warn('[SW] 部分資源快取失敗:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ===== 啟動：清除舊快取 =====
self.addEventListener('activate', event => {
  console.log('[SW] 啟動，清除舊快取...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] 刪除舊快取:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// ===== 攔截請求：Network First 策略 =====
// Firebase 請求：直接走網路
// HTML/JS/CSS：先走網路，失敗才用快取
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase 請求不快取
  if(url.hostname.includes('firebase') || 
     url.hostname.includes('google') ||
     url.hostname.includes('gstatic')) {
    return; // 直接走網路
  }

  // HTML 頁面：Network First（確保拿到最新版）
  if(event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // 更新快取
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 其他資源：Cache First（圖示、manifest）
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

// ===== 版本更新通知 =====
self.addEventListener('message', event => {
  if(event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
