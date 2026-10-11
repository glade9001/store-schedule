// 班表分享頁（免登入）：資料一律由 getScheduleShare 函式驗證代碼後回傳，本頁不碰 Firestore。
// 畫法共用 schedule-draw.js 的 drawScheduleCanvas，與排班頁「查閱班表」同一套輸入（records＋待補列＋他店支援記錄）。
var SHARE_API = 'https://asia-east1-store-schedule-3b056.cloudfunctions.net/getScheduleShare';
var shareData = null, shareWeek = 0, shareStore = 0, shareLoadedAt = 0, shareZoom = false;

function shareEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function shareFmt(ms) {
  var d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function shareMsg(ic, t, d) {
  document.getElementById('app').innerHTML = '<div class="msg"><div class="ic">' + ic + '</div><div class="t">' + shareEsc(t) + '</div><div class="d">' + shareEsc(d || '') + '</div></div>';
}
// schedule-draw.js 透過 window.getDisplayName 把本名換成顯示名
window.getDisplayName = function (n) { return (shareData && shareData.names && shareData.names[n]) || n; };

async function shareLoad() {
  var t = new URLSearchParams(location.search).get('t') || '';
  if (!t) { shareMsg('🔗', '連結不完整', '請確認網址有完整複製'); return; }
  try {
    var res = await fetch(SHARE_API + '?t=' + encodeURIComponent(t), { cache: 'no-store' });
    if (res.status === 404) { shareMsg('🚫', '這個連結已失效', '請向系統管理員索取新的連結'); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    shareData = await res.json();
    shareLoadedAt = Date.now();
  } catch (e) {
    if (!shareData) { shareMsg('📶', '載入失敗', '請檢查網路後重新整理'); }
    return;
  }
  if (shareData.title) document.getElementById('headSub').textContent = shareData.title + '・本週與下週，打開時自動顯示最新版本';
  try { var saved = parseInt(localStorage.getItem('shareStore') || '0', 10); if (saved >= 0 && saved < shareData.weeks[0].stores.length) shareStore = saved; } catch (e) {}
  shareRender();
}

function shareRender() {
  var weeks = shareData.weeks;
  var wk = weeks[shareWeek];
  var st = wk.stores[shareStore];
  var html = '<div class="tabs">' + weeks.map(function (w, i) {
    var anyChg = w.stores.some(function (s) { return s.visible && s.lastChangeAt; });
    return '<button class="tab' + (i === shareWeek ? ' on' : '') + '" onclick="shareWeek=' + i + ';shareRender()">' + (i === 0 ? '本週' : '下週') +
      (anyChg ? '<span class="dot"></span>' : '') + '<small>' + w.dates[0] + '～' + w.dates[6] + '</small></button>';
  }).join('') + '</div>';
  html += '<div class="tabs">' + wk.stores.map(function (s, i) {
    return '<button class="tab' + (i === shareStore ? ' on' : '') + '" onclick="shareStore=' + i + ';shareSaveStore();shareRender()">' + shareEsc(s.store) +
      (s.visible && s.lastChangeAt ? '<span class="dot"></span>' : '') + '</button>';
  }).join('') + '</div>';

  if (!st.visible) {
    document.getElementById('app').innerHTML = html;
    document.getElementById('app').insertAdjacentHTML('beforeend',
      '<div class="msg"><div class="ic">🕒</div><div class="t">' + shareEsc(st.store) + ' ' + (shareWeek === 0 ? '本週' : '下週') + '班表尚未發布</div>' +
      '<div class="d">店長發布後，或週五 18:00 自動發布後就看得到</div></div>');
    return;
  }
  var pub = st.publishedAt ? ('已發布 ' + shareFmt(st.publishedAt) + (st.publishedBy ? '・' + shareEsc(st.publishedBy) : '')) : '週五 18:00 自動發布';
  var nChg = Object.keys(st.changes || {}).length;
  html += '<div class="info">' + pub +
    (nChg ? '<div class="chg"><i></i>發布後有 ' + nChg + ' 格異動，最後一次在 ' + shareFmt(st.lastChangeAt) + '（黃底格）</div>' : '') + '</div>';
  // 手機上整張 1500px 圖縮到螢幕寬，異動小字會看不清 → 點一下切換放大（可左右滑）
  html += '<div class="canvas-wrap' + (shareZoom ? ' zoom' : '') + '" onclick="shareZoom=!shareZoom;this.classList.toggle(\'zoom\',shareZoom)"><canvas id="shareCanvas"></canvas></div>' +
    '<div class="hint">點表格可放大／縮小</div>';
  document.getElementById('app').innerHTML = html;

  // 待補（🆘）列：比照排班頁 renderEmpCanvas 補進員工列
  var emps = st.emps.slice();
  st.records.forEach(function (r) {
    if (r.name && r.name.indexOf('🆘') === 0 && !emps.some(function (e) { return e.name === r.name; })) emps.push({ name: r.name, role: '待補' });
  });
  var changes = {};
  Object.keys(st.changes || {}).forEach(function (k) {
    var c = st.changes[k];
    changes[k] = shareFmt(c.at) + ' ' + window.getDisplayName(c.by || '');
  });
  drawScheduleCanvas(document.getElementById('shareCanvas'), st.store, wk.weekStr, st.records, emps, wk.dates,
    st.records.concat(st.cross), { changes: changes });
}
function shareSaveStore() { try { localStorage.setItem('shareStore', String(shareStore)); } catch (e) {} }

// 從背景切回來超過 1 分鐘就重抓（連結常開著放，避免看到舊班表）
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && shareData && Date.now() - shareLoadedAt > 60000) shareLoad();
});
shareLoad();
