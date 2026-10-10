// 首頁團購儀表板（2026-10-11 使用者：A 只看即時資料）
// 重點：還差幾份成團、剩餘時間。員工、店長看本店；加盟主／admin 用 owner-scope.js 切三店／單店（跟儀表板等頁共用同一個選擇）。
// 保證成團的團只顯示本店份數（2026-10-11 使用者）；達標成團顯示三店合計（成團看的是三店加總）＋本店。資料只讀開放中的團購（gb_campaigns status==open，規則本來就開放讀取），不碰訂單與個資。
// 比照 shift-utils.js：只有 function 與 var（前綴 hg），掛在首頁不會撞名。
var HG_STORES = ['美德', '聯鑫', '錦花'];
var HG_CODE = { '美德': 'meide', '聯鑫': 'lianxin', '錦花': 'jinhua' };
var hgCamps = null, hgTimer = null, hgUnsub = null;

function hgUser() { try { return currentUser; } catch (e) { return null; } }
function hgIsOwner(u) { return !!u && ['owner', 'admin'].indexOf(u.permission) >= 0; }
function hgCanSee(u) { return !!u && ['employee', 'manager', 'owner', 'admin'].indexOf(u.permission) >= 0; }   // 2026-10-11 員工也看
function hgEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function hgMs(ts) { return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : (ts && ts.seconds ? ts.seconds * 1000 : 0); }

async function hgLoad() {
  var u = hgUser(), card = document.getElementById('gbDashCard');
  if (!card) return;
  if (!hgCanSee(u)) { card.style.display = 'none'; return; }
  // 即時監聽（2026-10-11 使用者：數據要自動更新）：有人下單／取消、改團購資料，卡片馬上跟著變；只聽開放中的團，筆數少
  if (!hgUnsub) {
    hgUnsub = window.db.collection('gb_campaigns').where('status', '==', 'open').onSnapshot(function (sn) {
      hgCamps = sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      hgRender();
    }, function (e) {
      console.warn('[home-gb] 團購監聽失敗', e);
      hgUnsub = null;   // 下次回到首頁（hgLoad）再重接
      if (!hgCamps) { hgCamps = []; hgRender(); }
    });
  } else hgRender();
  if (!hgTimer) hgTimer = setInterval(function () { if (document.visibilityState === 'visible') hgRender(); }, 60000);   // 倒數每分鐘更新
}

/** 目前看哪一店的代碼；'' = 三店 */
function hgScopeCode() {
  var u = hgUser();
  if (hgIsOwner(u)) return window.OwnerScope ? (HG_CODE[OwnerScope.get()] || '') : '';
  return HG_CODE[u && u.store] || '__none__';
}

function hgLeft(ms) {
  var left = ms - Date.now();
  if (left <= 0) return { t: '已截單', urgent: true };
  var d = Math.floor(left / 86400000), h = Math.floor(left % 86400000 / 3600000), m = Math.floor(left % 3600000 / 60000);
  return { t: d ? '剩 ' + d + ' 天 ' + h + ' 時' : h ? '剩 ' + h + ' 時 ' + m + ' 分' : '剩 ' + Math.max(1, m) + ' 分', urgent: left < 86400000 };
}

function hgRender() {
  var card = document.getElementById('gbDashCard'); if (!card || !hgCamps) return;
  var u = hgUser(), code = hgScopeCode();
  card.style.display = '';
  if (hgIsOwner(u) && window.OwnerScope) {
    var sc = document.getElementById('hgScope');
    OwnerScope.render(sc, HG_STORES);
    if (!sc._hgBound) { sc._hgBound = true; OwnerScope.onChange(function () { hgRender(); }); }
  }
  var now = Date.now();
  var live = hgCamps.filter(function (c) {
    return c.is_test !== true && hgMs(c.end_time) > now && (!code || (c.available_stores || []).indexOf(code) >= 0);
  });
  // 同一檔的多規格（opt_group）、額滿自動開的第 2、3 團（series_id）合成一列
  var groups = {};
  live.forEach(function (c) { var k = c.opt_group || c.series_id || c.id; (groups[k] = groups[k] || []).push(c); });
  var rows = Object.keys(groups).map(function (k) {
    var ms = groups[k], c = ms[0];
    var ordered = ms.reduce(function (a, m) { return a + (m.ordered_qty || 0); }, 0);
    var mine = code ? ms.reduce(function (a, m) { return a + ((m.ordered_by_store || {})[code] || 0); }, 0) : null;
    // 三店檢視：括號列出各門市份數（只列這檔有開放的門市）
    var by = code ? '' : HG_STORES.filter(function (n) {
      return ms.some(function (m) { return (m.available_stores || []).indexOf(HG_CODE[n]) >= 0; });
    }).map(function (n) {
      return n + ' ' + ms.reduce(function (a, m) { return a + ((m.ordered_by_store || {})[HG_CODE[n]] || 0); }, 0);
    }).join('・');
    var th = c.success_rule === 'threshold' && c.min_qty;
    // 多規格各自成團：取「最接近成團」那種的差額
    var lack = th ? Math.min.apply(null, ms.map(function (m) { return Math.max(0, (m.min_qty || 0) - (m.ordered_qty || 0)); })) : 0;
    var minQ = th ? (c.min_qty || 0) : 0;
    return { c: c, pin: ms.some(function (m) { return m.pinned === true; }), end: Math.min.apply(null, ms.map(function (m) { return hgMs(m.end_time); })), ordered: ordered, mine: mine, by: by, th: th, lack: lack, minQ: minQ,
      title: c.base_title || String(c.title || '').replace(/（第\d+團）$/, '') };
  }).sort(function (a, b) { return (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || a.end - b.end; });   // 置頂的在前

  var body = document.getElementById('hgBody'), cnt = document.getElementById('hgCount');
  cnt.textContent = rows.length ? rows.length + ' 檔' : '';
  if (!rows.length) { body.innerHTML = '<div class="hg-empty">目前沒有進行中的團購</div>'; return; }
  var show = rows.slice(0, 4);
  body.innerHTML = show.map(function (r) {
    var lf = hgLeft(r.end);
    var status = r.th ? (r.lack ? '還差 <b>' + r.lack + '</b> 份成團' : '🎉 已達成團') : '保證成團';
    var pct = r.th ? Math.min(100, Math.round((r.minQ - r.lack) / (r.minQ || 1) * 100)) : 100;
    return '<div class="hg-row" onclick="location.href=\'groupbuy.html\'">' +
      '<div class="hg-top"><span class="hg-t">' + (r.pin ? '📌 ' : '') + hgEsc(r.title) + '</span><span class="hg-left' + (lf.urgent ? ' urgent' : '') + '">⏰ ' + lf.t + '</span></div>' +
      '<div class="hg-mid"><span class="hg-st' + (r.th && r.lack ? ' lack' : ' ok') + '">' + status + '</span>' +
        '<span class="hg-q">' + (r.th ? '已訂 ' + r.ordered + ' 份' + (code ? '・本店 ' + r.mine : '') : (code ? '本店已訂 ' + r.mine + ' 份' : '三店已訂 ' + r.ordered + ' 份')) + (r.by ? '（' + r.by + '）' : '') + '</span></div>' +
      (r.th ? '<div class="hg-bar"><i style="width:' + pct + '%"></i></div>' : '') + '</div>';
  }).join('') + (rows.length > show.length ? '<div class="hg-more" onclick="location.href=\'groupbuy.html\'">還有 ' + (rows.length - show.length) + ' 檔 →</div>' : '');
}

(function hgCss() {
  var st = document.createElement('style');
  st.textContent =
    '.hg-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}' +
    '.hg-head .hg-title{font-size:15px;font-weight:900;flex:1;}' +
    '.hg-head .hg-cnt{font-size:12px;font-weight:800;color:#64748b;}' +
    '.hg-head a{font-size:12px;font-weight:800;color:#1a73e8;text-decoration:none;}' +
    '.hg-row{padding:10px 0;border-top:1px solid #eef2f7;cursor:pointer;}' +
    '.hg-row:first-child{border-top:none;}' +
    '.hg-top{display:flex;align-items:baseline;gap:8px;}' +
    '.hg-t{flex:1;min-width:0;font-size:14px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.hg-left{font-size:12px;font-weight:800;color:#64748b;white-space:nowrap;}' +
    '.hg-left.urgent{color:#d93025;}' +
    '.hg-mid{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin-top:3px;font-size:12.5px;}' +
    '.hg-st{font-weight:800;}' +
    '.hg-st.lack{color:#c2410c;} .hg-st.ok{color:#137333;}' +
    '.hg-q{color:#64748b;font-weight:700;margin-left:auto;white-space:nowrap;}' +
    '.hg-bar{height:6px;border-radius:3px;background:#eef2f7;margin-top:6px;overflow:hidden;}' +
    '.hg-bar i{display:block;height:100%;background:#f97316;border-radius:3px;}' +
    '.hg-empty{font-size:13px;color:#94a3b8;text-align:center;padding:10px 0;}' +
    '.hg-more{font-size:12.5px;font-weight:800;color:#1a73e8;text-align:center;padding-top:8px;cursor:pointer;}';
  document.head.appendChild(st);
})();
