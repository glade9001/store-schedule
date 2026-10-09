// 團購系統共用（gb_ 前綴，2026-10-10 第 1 階段）
// 團購管理（groupbuy.html）與取貨名單（groupbuy-pickup.html）共用：門市代碼、狀態、時間格式、登入檢查。
// 比照 shift-utils.js：只有 function 與 var 宣告（前綴 gb），任何頁面掛上來都不會撞名。
// 門市在 gb_ 集合一律存代碼；使用者資料存中文店名，firestore.rules 的 gbCodeOf() 是同一張對照表。

var GB_STORES = [
  { code: 'meide', name: '美德' },
  { code: 'lianxin', name: '聯鑫' },
  { code: 'jinhua', name: '錦花' },
];
var GB_STATUS = {
  draft: '草稿', open: '開放中', closed: '已截單', success: '已成團',
  failed: '已流局', arrived: '已到貨', done: '已結案',
};
var GB_STATUS_ORDER = ['draft', 'open', 'closed', 'success', 'failed', 'arrived', 'done'];
var GB_ORDER_STATUS = { active: '訂購中', cancelled: '已取消', picked_up: '已取貨', no_show: '棄單' };
var GB_SOURCE = { manual: '手動補單', liff: 'LINE 下單', group_text: '群組 +1' };

function gbStoreName(code) {
  for (var i = 0; i < GB_STORES.length; i++) if (GB_STORES[i].code === code) return GB_STORES[i].name;
  return code || '';
}
function gbCodeOf(name) {
  for (var i = 0; i < GB_STORES.length; i++) if (GB_STORES[i].name === name) return GB_STORES[i].code;
  return '';
}
function gbEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function gbIsOwner(u) { return !!u && ['owner', 'admin'].indexOf(u.permission) >= 0; }
function gbIsManager(u) { return !!u && u.permission === 'manager'; }

// ---- 時間：一律存 Timestamp，顯示用台北時間 ----
function gbToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  var d = new Date(ts);
  return isNaN(d) ? null : d;
}
/** 台北時間的各欄位（不受裝置時區影響） */
function gbTpParts(d) {
  var t = new Date(d.getTime() + 8 * 3600000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), wd: t.getUTCDay() };
}
function gbFmt(ts, withTime) {
  var d = gbToDate(ts); if (!d) return '—';
  var p = gbTpParts(d), wd = '日一二三四五六'.charAt(p.wd);
  var s = p.m + '/' + p.d + '（' + wd + '）';
  if (withTime !== false) s += ' ' + String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0');
  return s;
}
/** <input type="datetime-local"> 的值（視為台北時間）→ Timestamp */
function gbTsFromInput(v) {
  if (!v) return null;
  var d = new Date(v + (v.length === 16 ? ':00' : '') + '+08:00');
  return isNaN(d) ? null : firebase.firestore.Timestamp.fromDate(d);
}
/** <input type="date"> 的值 → 當天 23:59（台北）的 Timestamp（到貨日、取貨期限用） */
function gbTsFromDate(v, endOfDay) {
  if (!v) return null;
  var d = new Date(v + (endOfDay ? 'T23:59:00' : 'T00:00:00') + '+08:00');
  return isNaN(d) ? null : firebase.firestore.Timestamp.fromDate(d);
}
function gbInputDateTime(ts) {
  var d = gbToDate(ts); if (!d) return '';
  var p = gbTpParts(d);
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0') + 'T' + String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0');
}
function gbInputDate(ts) { return gbInputDateTime(ts).slice(0, 10); }
/** 距離某時間：「還剩 2 天 3 小時」／「已過 5 小時」 */
function gbCountdown(ts) {
  var d = gbToDate(ts); if (!d) return '';
  var ms = d.getTime() - Date.now(), past = ms < 0; ms = Math.abs(ms);
  var day = Math.floor(ms / 86400000), hr = Math.floor(ms % 86400000 / 3600000), mi = Math.floor(ms % 3600000 / 60000);
  var t = day ? day + ' 天 ' + hr + ' 小時' : hr ? hr + ' 小時 ' + mi + ' 分' : mi + ' 分';
  return past ? '已過 ' + t : '還剩 ' + t;
}
function gbRand(n) {
  var s = '', a = 'abcdefghijkmnpqrstuvwxyz23456789';
  for (var i = 0; i < (n || 8); i++) s += a.charAt(Math.floor(Math.random() * a.length));
  return s;
}
/** Firestore SDK 沒有逾時：transaction／讀取卡住時畫面會凍住（記憶 reference_firestore_no_timeout） */
function gbTimeout(p, ms, msg) {
  return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(msg || '連線逾時，請稍後再試')); }, ms || 15000); })]);
}
function gbToast(msg) {
  var t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(gbToast._t); gbToast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
}
function gbLoading(on, text) {
  var el = document.getElementById('loadingOverlay'); if (!el) return;
  if (text) { var tx = document.getElementById('loadingText'); if (tx) tx.textContent = text; }
  el.classList.toggle('hidden', !on);
}

/**
 * 共用登入檢查（同其他頁：localStorage 的 currentUser＋Firebase Auth 狀態）
 * @returns {Promise<object|null>} currentUser（含 uid、empName、store、permission）；沒登入會導回首頁並回 null
 */
async function gbRequireUser() {
  var saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return null; }
  var u; try { u = JSON.parse(saved); } catch (e) { location.replace('home.html'); return null; }
  var fb = await new Promise(function (r) { var un = firebase.auth().onAuthStateChanged(function (x) { un(); r(x); }); });
  if (!fb) { location.replace('home.html'); return null; }
  if (['employee', 'manager', 'owner', 'admin'].indexOf(u.permission) < 0) { alert('沒有使用權限'); location.replace('home.html'); return null; }
  u.uid = u.uid || fb.uid;
  return u;
}
/** gb_settings/stores 不存在時由加盟主／admin 建立初始資料 */
async function gbEnsureStoreSettings(u) {
  if (!gbIsOwner(u)) return;
  try {
    var ref = window.db.collection('gb_settings').doc('stores');
    var sn = await ref.get();
    if (sn.exists) return;
    var data = {};
    GB_STORES.forEach(function (s) { data[s.code] = { name: s.name, liff_url: '' }; });
    data.created_at = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(data);
  } catch (e) { console.warn('gb_settings/stores 初始化失敗', e); }
}
