// ===== 主畫面開啟紀錄、加入主畫面引導、PWA 推播、App 圖示紅點（2026-09-15）=====
// ⚠️ 本檔頂層只用 function 與 var（見 home-nav.js 開頭說明）
//
// 1) 開啟紀錄：users/{uid}.appUsage = { platform, lastMode, lastOrigin, lastStandaloneAt, lastBrowserAt }
//    同一模式 6 小時內只寫一次，避免每次開首頁都多一次寫入。
// 2) 加入主畫面：只對「手機＋從瀏覽器開」的人顯示白底膠囊，× 可隱藏 7 天。
// 3) 推播：標準 Web Push。訂閱經 Cloud Function pushSubscribe 存到 pushSubs（前端不直接寫）。
//    iPhone 必須先加入主畫面、從主畫面打開才有推播（Safari 分頁沒有 PushManager）。
// 4) 紅點：App 圖示顯示待處理件數（navigator.setAppBadge；只有裝成 App 的才看得到）。

var HP_VAPID_PUBLIC = 'BGhmoFm3LcXdHVJf0Abc6b5WtJzx25nktsKM01MQ7zUf6otCr6kOaTnGVQ0qUbGtuQf5W15muw55rRcfzZZi3cA'; // 與 functions/index.js 一致
var HP_HIDE_DAYS = 7;
var hpInstallPrompt = null;   // Android Chrome 的 beforeinstallprompt 事件（有它就能直接跳安裝視窗）

window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  hpInstallPrompt = e;
});
window.addEventListener('appinstalled', function () {
  hpInstallPrompt = null;
  var p = document.getElementById('a2hsPill'); if (p) p.style.display = 'none';
});

function hpPlatform() {
  var ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}
function hpStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
function hpInApp() { return /Line\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent || ''); }
function hpPushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function hpHidden(key) { try { return Number(localStorage.getItem(key) || 0) > Date.now(); } catch (e) { return false; } }
function hpHide(key) { try { localStorage.setItem(key, String(Date.now() + HP_HIDE_DAYS * 86400000)); } catch (e) {} }

// ===== 1) 開啟紀錄 =====
function hpRecordAppOpen() {
  if (!currentUser?.uid) return;
  try { if (sessionStorage.getItem('isPreviewMode') === '1') return; } catch (e) {}
  var standalone = hpStandalone();
  var mode = standalone ? 'standalone' : 'browser';
  var key = 'appOpenLogged:' + currentUser.uid + ':' + mode + ':' + location.host;
  try { if (Date.now() - Number(localStorage.getItem(key) || 0) < 6 * 3600000) return; } catch (e) {}
  var FV = firebase.firestore.FieldValue;
  var usage = { platform: hpPlatform(), lastMode: mode, lastOrigin: location.host };
  usage[standalone ? 'lastStandaloneAt' : 'lastBrowserAt'] = FV.serverTimestamp();
  window.db.collection('users').doc(currentUser.uid).set({ appUsage: usage }, { merge: true })
    .then(function () { try { localStorage.setItem(key, String(Date.now())); } catch (e) {} })
    .catch(function (e) { console.warn('開啟紀錄寫入失敗:', e); });
}

// ===== 2) 加入主畫面 =====
function hpUpdateA2hsPill() {
  var pill = document.getElementById('a2hsPill');
  if (!pill) return;
  var p = hpPlatform();
  var show = !hpStandalone() && (p === 'ios' || p === 'android') && !hpHidden('a2hsHideUntil');
  pill.style.display = show ? 'flex' : 'none';
}
function hideA2hsPill() {
  hpHide('a2hsHideUntil');
  hpUpdateA2hsPill();
  showToast('之後想加，可以從左上角 ☰ →「加入主畫面」');
}

function openA2hsGuide() {
  var p = hpPlatform();
  var body;
  if (hpStandalone()) {
    body = '<p class="hp-ok">✅ 你現在就是從主畫面打開的，不用再加一次。</p>';
  } else if (hpInApp()) {
    body = '<p>你目前在 LINE（或其他 App）裡面開這個網頁，沒辦法加入主畫面。</p>' +
      '<p>請點右上角選單，選「<b>用預設瀏覽器開啟</b>」，再從瀏覽器加入。</p>';
  } else if (p === 'ios') {
    body = '<ol class="hp-steps">' +
      '<li>點畫面下方（或網址列旁）的 <b>分享按鈕</b> <span class="hp-key">⬆︎</span>（方框加向上箭頭）</li>' +
      '<li>往下滑，點「<b>加入主畫面</b>」</li>' +
      '<li>點右上角「<b>新增</b>」</li>' +
      '<li>回到手機桌面，之後都從「<b>莉學商行</b>」圖示打開</li></ol>' +
      '<p class="hp-note">找不到「加入主畫面」：請改用 <b>Safari</b> 打開這個網址再試一次。<br>第一次從主畫面打開需要<b>重新登入一次</b>；要收推播通知也必須從主畫面打開。</p>';
  } else if (p === 'android') {
    body = (hpInstallPrompt
      ? '<button class="hp-btn" onclick="hpPromptInstall()">📲 立即安裝到主畫面</button><p class="hp-note">按了沒反應的話，照下面步驟手動加：</p>'
      : '') +
      '<ol class="hp-steps">' +
      '<li>點 Chrome 右上角 <span class="hp-key">⋮</span></li>' +
      '<li>點「<b>加到主畫面</b>」或「<b>安裝應用程式</b>」</li>' +
      '<li>點「<b>安裝</b>／<b>新增</b>」</li>' +
      '<li>之後都從手機桌面的「<b>莉學商行</b>」圖示打開</li></ol>';
  } else {
    body = '<p>請用手機打開這個網址，再照手機上的步驟加入主畫面。</p>';
  }
  hpOpenModal('📲 加入主畫面', '加入後會像一般 App 一樣從手機桌面打開，畫面比較大，也能開啟推播通知。', body);
}
async function hpPromptInstall() {
  if (!hpInstallPrompt) return;
  hpInstallPrompt.prompt();
  try { await hpInstallPrompt.userChoice; } catch (e) {}
  hpInstallPrompt = null;
  hpCloseModal();
}

// ===== 3) 推播 =====
function hpB64ToBytes(b64) {
  var pad = '='.repeat((4 - b64.length % 4) % 4);
  var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function hpCallable(name) { return firebase.app().functions('asia-east1').httpsCallable(name); }

async function hpGetSubscription() {
  if (!hpPushSupported()) return null;
  try {
    var reg = await Promise.race([navigator.serviceWorker.ready, new Promise(function (res) { setTimeout(function () { res(null); }, 4000); })]);
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch (e) { return null; }
}

function hpSubPayload(sub) {
  return { subscription: sub.toJSON(), platform: hpPlatform(), standalone: hpStandalone(), origin: location.host };
}

// 首頁載入：已訂閱的裝置每 3 天回報一次（更新 lastSeenAt；伺服器端被清掉時也會補回）
async function hpRefreshSubscription() {
  var sub = await hpGetSubscription();
  hpUpdatePushPill(sub);
  if (!sub || !currentUser?.uid) return;
  var key = 'pushSubSynced:' + currentUser.uid;
  try { if (Date.now() - Number(localStorage.getItem(key) || 0) < 3 * 86400000) return; } catch (e) {}
  try {
    await hpCallable('pushSubscribe')(hpSubPayload(sub));
    try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
  } catch (e) { console.warn('推播訂閱同步失敗:', e); }
}

// 白底膠囊「開啟推播通知」：能收推播（iPhone 要從主畫面開）、還沒訂閱、沒被封鎖、沒按 × 才顯示
function hpUpdatePushPill(sub) {
  var pill = document.getElementById('pushPill');
  if (!pill) return;
  var can = hpPushSupported() && (hpPlatform() !== 'ios' || hpStandalone());
  var show = can && !sub && Notification.permission !== 'denied' && !hpHidden('pushPillHideUntil');
  pill.style.display = show ? 'flex' : 'none';
}
function hidePushPill() {
  hpHide('pushPillHideUntil');
  var pill = document.getElementById('pushPill'); if (pill) pill.style.display = 'none';
  showToast('之後想開，可以從左上角 ☰ →「推播通知」');
}

async function openPushSettings() {
  hpOpenModal('🔔 推播通知', '開啟後，這台手機就能收到系統的即時通知，App 圖示上也會顯示待處理件數。', '<p class="hp-note">讀取中…</p>');
  var body = document.getElementById('hpModalBody');
  var p = hpPlatform();
  if (!hpPushSupported() || (p === 'ios' && !hpStandalone())) {
    body.innerHTML = p === 'ios'
      ? '<p>iPhone 要先<b>加入主畫面</b>，並且<b>從主畫面的圖示打開</b>，才能開啟推播（系統限制，iOS 16.4 以上）。</p>' +
        (hpStandalone() ? '' : '<button class="hp-btn" onclick="hpCloseModal();openA2hsGuide()">📲 教我加入主畫面</button>')
      : '<p>這個瀏覽器不支援推播通知。請改用手機的 Chrome（Android）或加入主畫面（iPhone）。</p>';
    return;
  }
  var sub = await hpGetSubscription();
  var perm = Notification.permission;
  if (perm === 'denied') {
    body.innerHTML = '<p class="hp-bad">⛔ 這台手機把本系統的通知<b>封鎖</b>了，系統沒辦法再跳出詢問。</p>' +
      (p === 'ios'
        ? '<p class="hp-note">到 iPhone「設定」→「通知」→ 找到「莉學商行」→ 打開「允許通知」，再回來這裡。</p>'
        : '<p class="hp-note">點網址列左邊的圖示（或 App 資訊）→「通知」→ 改成允許，再回來這裡。</p>');
    return;
  }
  if (sub) {
    body.innerHTML = '<p class="hp-ok">✅ 這台手機已開啟推播</p>' +
      '<button class="hp-btn" id="hpTestBtn" onclick="hpSendTest()">傳一則測試推播給我</button>' +
      '<button class="hp-btn ghost" onclick="hpDisablePush()">關閉這台手機的推播</button>' +
      '<p class="hp-note">測試推播會送到你所有開啟推播的裝置。收不到的話，檢查手機是否開了勿擾／專注模式。</p>';
  } else {
    body.innerHTML = '<p>這台手機還沒開啟推播。</p>' +
      '<button class="hp-btn" id="hpEnableBtn" onclick="hpEnablePush()">開啟推播通知</button>' +
      '<p class="hp-note">按下後手機會詢問是否允許通知，請選「<b>允許</b>」。</p>';
  }
}

async function hpEnablePush() {
  var btn = document.getElementById('hpEnableBtn');
  if (btn) { btn.disabled = true; btn.textContent = '處理中…'; }
  try {
    var perm = await Notification.requestPermission();   // ⚠️ 必須在使用者點擊當下呼叫（iOS 規定）
    if (perm !== 'granted') {
      showToast(perm === 'denied' ? '已封鎖通知，要到手機設定裡打開' : '沒有允許通知，推播沒有開啟');
      openPushSettings();
      return;
    }
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription() ||
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: hpB64ToBytes(HP_VAPID_PUBLIC) });
    await hpCallable('pushSubscribe')(hpSubPayload(sub));
    try { localStorage.setItem('pushSubSynced:' + currentUser.uid, String(Date.now())); } catch (e) {}
    showToast('✅ 已開啟推播');
    hpUpdatePushPill(sub);
    hpSetBadge(Number(document.getElementById('pendingBadgeCount')?.textContent || 0));
    openPushSettings();
  } catch (e) {
    console.error('開啟推播失敗:', e);
    showToast('❌ 開啟失敗：' + (e.message || e));
    openPushSettings();
  }
}

async function hpSendTest() {
  var btn = document.getElementById('hpTestBtn');
  if (btn) { btn.disabled = true; btn.textContent = '傳送中…'; }
  try {
    var r = await hpCallable('sendTestPush')({});
    var d = r.data || {};
    showToast(d.sent ? '已送出 ' + d.sent + ' 則，幾秒內會收到' : '沒有送出，請重新開啟推播');
  } catch (e) {
    showToast('❌ ' + (e.message || e));
  }
  if (btn) { btn.disabled = false; btn.textContent = '傳一則測試推播給我'; }
}

async function hpDisablePush() {
  try {
    var sub = await hpGetSubscription();
    if (sub) {
      await hpCallable('pushUnsubscribe')({ endpoint: sub.endpoint }).catch(function () {});
      await sub.unsubscribe();
    }
    try { localStorage.removeItem('pushSubSynced:' + currentUser.uid); } catch (e) {}
    showToast('已關閉這台手機的推播');
    hpUpdatePushPill(null);
    openPushSettings();
  } catch (e) { showToast('❌ 關閉失敗：' + (e.message || e)); }
}

// ===== 4) App 圖示紅點 =====
function hpSetBadge(n) {
  try {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) navigator.setAppBadge(n).catch(function () {});
    else navigator.clearAppBadge().catch(function () {});
  } catch (e) {}
}

// ===== 共用小視窗 =====
function hpOpenModal(title, lead, html) {
  var el = document.getElementById('hpModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hpModal';
    el.className = 'hp-overlay';
    el.onclick = function (e) { if (e.target === el) hpCloseModal(); };
    el.innerHTML = '<div class="hp-box" role="dialog" aria-modal="true" aria-labelledby="hpModalTitle">' +
      '<div class="hp-title" id="hpModalTitle"></div><div class="hp-lead" id="hpModalLead"></div>' +
      '<div id="hpModalBody"></div><button class="hp-close" onclick="hpCloseModal()">關閉</button></div>';
    document.body.appendChild(el);
  }
  document.getElementById('hpModalTitle').textContent = title;
  document.getElementById('hpModalLead').textContent = lead;
  document.getElementById('hpModalBody').innerHTML = html;
  el.classList.add('active');
}
function hpCloseModal() {
  var el = document.getElementById('hpModal'); if (el) el.classList.remove('active');
}

// 首頁 initApp 呼叫
function initHomePush() {
  hpRecordAppOpen();
  hpUpdateA2hsPill();
  hpRefreshSubscription();
}
