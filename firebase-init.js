// 共用 Firebase 初始化 – 在 firebase-app.js / firebase-firestore.js 之後載入
// 若頁面有載入 firebase-auth.js，window.auth 也會一併初始化
(function () {
  if (firebase.apps.length) return;
  firebase.initializeApp({
    apiKey: "AIzaSyAmVwq-Wny1KMRGNSdOnBEJ_A-3HmTO-hM",
    authDomain: "store-schedule-3b056.firebaseapp.com",
    projectId: "store-schedule-3b056",
    storageBucket: "store-schedule-3b056.firebasestorage.app",
    messagingSenderId: "296522693619",
    appId: "1:296522693619:web:f90ec5d666c7a4a5943086"
  });
  window.db = firebase.firestore();
  if (typeof firebase.auth === 'function') {
    window.auth = firebase.auth();
  }
})();

// ===== 版本更新偵測（2026-09-23）=====
// 問題：從主畫面開啟的 PWA 只要沒有真正「重新載入頁面」，就會一直跑當初載入的那份 JS。
//   .js 雖然是 network-first，但那只在重新載入時才會去抓；切走再切回來只是恢復原本那一頁。
//   結果是改版後同一台手機可能停在舊版好幾個小時，看起來像「改了沒上線」。
//   （原本唯一會自動重載的條件是 sw.js 本身變動，但平常改的都是頁面 JS，不會觸發。）
// 作法：載入時先記下這一頁用到的 JS 的 ETag，回到前景時（最多每 3 分鐘查一次）再比一次，
//   不一樣就顯示「有新版本」的小條，點一下才重新載入——不自動重載，免得打斷正在填的表單。
(function () {
  var MIN_GAP = 3 * 60 * 1000;
  var base = null, lastAt = 0, shown = false;

  function ownScripts() {
    return Array.prototype.slice.call(document.scripts)
      .map(function (s) { return s.src; })
      .filter(function (u) { return u && u.indexOf(location.origin) === 0; })
      .slice(0, 6);
  }
  function stamp(url) {
    return fetch(url, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) { return r.headers.get('etag') || r.headers.get('last-modified') || ''; })
      .catch(function () { return null; });   // 抓不到（離線等）→ null，這輪不比對
  }
  function snapshot() {
    var urls = ownScripts();
    return Promise.all(urls.map(stamp)).then(function (v) {
      return v.some(function (x) { return x === null; }) ? null : urls.join('|') + '||' + v.join('|');
    });
  }
  function showBar() {
    if (shown || document.getElementById('appUpdateBar')) return;
    shown = true;
    var b = document.createElement('div');
    b.id = 'appUpdateBar';
    b.setAttribute('role', 'button');
    b.textContent = '🔄 已有新版本，點這裡更新';
    b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px));' +
      'z-index:99999;background:#0e2140;color:#fff;border-radius:12px;padding:13px 16px;text-align:center;' +
      'font-size:14px;font-weight:800;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer;' +
      'font-family:inherit;line-height:1.4;';
    b.onclick = function () { b.textContent = '更新中…'; location.reload(); };
    document.body.appendChild(b);
  }
  function check() {
    if (shown || Date.now() - lastAt < MIN_GAP) return;
    lastAt = Date.now();
    snapshot().then(function (now) {
      if (!now) return;
      if (base === null) { base = now; return; }   // 載入時那次沒抓成功 → 這次當基準
      if (now !== base) showBar();
    });
  }

  window.addEventListener('load', function () {
    snapshot().then(function (v) { base = v; lastAt = Date.now(); });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
})();
