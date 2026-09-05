// ===== 莉學商行 Service Worker =====
// 策略：HTML 永遠走網路，靜態資源才快取

const CACHE_NAME = 'lixue-static-v12';

// 快取靜態資源（相對於 sw.js 位置，故 web.app 與 github.io 皆適用）
const STATIC_ASSETS = [
  'icon-192.svg',
  'icon-512.svg',
  'manifest.json',
  'firebase-init.js',
  'auth.js',
  'utils.js',
  'shift-utils.js',
  'salary-calc.js',
  // ⚠️ clock-page.js 是唯一被預快取的「單頁」JS：打卡支援離線送出（clockPunchOffline），
  //    但外部化後，若使用者第一次開打卡頁就沒網路，這支還沒進過快取 → 整頁死掉。
  //    預快取只是保底：.js 走上面的 network-first 分支，每次成功抓取都會覆寫，不會卡舊版。
  'clock-page.js',
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

  // 非 http/https 請求（例如 chrome-extension://）：完全不攔截
  if(!event.request.url.startsWith('http')) return;

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

  // 自家 JS：Network First（永遠先拿最新，離線才回快取）
  // ⚠️ 為什麼不能用 Cache First（2026-08-17 踩到）：
  //    HTML 每次都走網路拿最新，JS 卻鎖在快取裡 → 會出現「新版 HTML 配舊版 JS」，
  //    新頁面呼叫舊檔還沒有的函式就直接炸（實例：attendance.html 叫 shiftDateAdd()，
  //    但使用者快取裡的 shift-utils.js 是加這支函式之前的版本 → Can't find variable）。
  //    靠「改檔就記得進 CACHE_NAME 版號」是不可靠的紀律，改成由架構保證。
  // ⚠️ `.css` 必須跟 `.js` 走同一條（2026-09-05 把行內 CSS 外部化時加）：
  //    若讓它掉到最下面的 Cache First，就會變成「每次都拿最新 HTML 配鎖在快取裡的舊樣式」，
  //    正是 2026-08-17 在 JS 上踩過的那個坑（版面錯亂比 JS 報錯更難聯想到是快取）。
  if(url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      // ⚠️ 一定要帶 cache:'no-cache'（2026-08-28 加）：
      //    GitHub Pages 對 .js 回 Cache-Control: max-age=600，預設 fetch 會直接吃瀏覽器快取、
      //    連請求都不發 → 改了 JS 最多要 10 分鐘才會到已載過的人手上。
      //    2026-08-28 把六個巨檔的行內 JS 外部化後，等於整個網站的邏輯都受這個延遲影響
      //    （以前 HTML 走 no-cache，push 後約 1 分鐘就生效）。
      //    no-cache ≠ no-store：仍會帶 ETag 去問，沒變就回 304 空回應。
      //    真正的省是「不用傳 200KB 本體」而不是「不發請求」，所以幾乎不損失頻寬。
      fetch(event.request, { cache: 'no-cache' }).then(response => {
        if(response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))   // 離線：回上次成功抓到的版本
    );
    return;
  }

  // 其餘靜態資源（圖示、manifest）：Cache First
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
