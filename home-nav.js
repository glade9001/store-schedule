// ===== 首頁改版（2026-09-15）：功能清單＋左側 ☰ ＋ 常用功能 3＋3 =====
// 所有功能入口只在 HOME_FEATURES 定義一次：☰ 抽屜、首頁常用、搜尋、新版教學都讀這一份。
// 權限一律在「顯示當下」判斷（show()），所以調職／角色預覽後沒權限的功能會自動從常用消失。
//
// 常用功能存在 users/{uid}.homeFavs = { me:[id…], mgmt:[id…] }（沒存過＝用角色預設）。
// 規則：users/{uid} 本人可寫，不必動 firestore.rules。
// ⚠️ 本檔頂層只用 function 與 var：跟 home-page.js 共用全域語彙環境，頂層 const/let 撞名會讓整段 script 失效。

var HN_FAV_MAX = 3;
var HN_TIER_LABEL = { owner: '加盟主', admin: '管理者' };   // 選單上的權限標籤（樣式見 home-page.css .nd-tier）

// 順序＝抽屜顯示順序。門市工具是全員功能，要排在「管理功能」分隔線之前，否則看起來像管理專用
var HN_GROUPS = [
  { key: 'me',     title: '我的',       fav: 'me' },
  { key: 'store',  title: '門市工具',   fav: '', fold: true },   // 首頁已固定顯示這幾個，抽屜裡預設收起來（狀態記在 localStorage）
  { key: 'sched',  title: '排班・出勤', fav: 'mgmt' },
  { key: 'people', title: '人事・薪資', fav: 'mgmt' },
  { key: 'ops',    title: '營運',       fav: 'mgmt', fold: true },
  { key: 'tools',  title: '管理工具',   fav: 'mgmt', fold: true },
  { key: 'sys',    title: '帳號與系統', fav: '' },
];

function hnIsLead() { return ['manager', 'owner', 'admin'].includes(currentUser?.permission); }
function hnIsOwner() { return ['owner', 'admin'].includes(currentUser?.permission); }
function hnIsAdmin() { return currentUser?.permission === 'admin'; }

var HOME_FEATURES = [
  // ── 我的（所有人）──
  { id: 'schedule',  group: 'me', icon: '📅', label: '班表',       sub: '本週、下週與月曆',         go: 'schedule-V2.html' },
  { id: 'leaveReq',  group: 'me', icon: '🗓️', label: '劃休申請',   sub: '排休、特休、補休月曆申請', go: 'leave-request.html', kw: '請假 排休 畫休' },
  { id: 'leaveRec',  group: 'me', icon: '🏖️', label: '特補休紀錄', sub: '餘額查詢、批次與異動明細', go: 'leave.html?mode=self', kw: '特休 補休 餘額' },
  { id: 'mySalary',  group: 'me', icon: '💰', label: '薪水',       sub: '薪資明細與簽收',           go: 'my-salary.html', show: function () { return !!currentUser?.empName; }, kw: '薪資 簽收' },
  { id: 'myAttend',  group: 'me', icon: '🕐', label: '我的出勤',   sub: '打卡紀錄、遲到早退、補登', go: 'my-attendance.html', kw: '打卡 補登 缺卡' },
  { id: 'todo',      group: 'me', icon: '✅', label: '代辦清單',   sub: '待辦事項與公告',           go: 'todo.html', kw: '待辦 公告' },
  // ── 管理（店長以上）──
  { id: 'adminSchedule', group: 'sched',  icon: '📋', label: '排班',       sub: '排班、發布班表',             go: 'schedule-V2.html?mode=admin', show: hnIsLead },
  { id: 'autoSchedule',  group: 'sched',  icon: '🤖', label: '自動排班設定', sub: '時段人數需求、人員可上班別', go: 'auto-schedule.html?ref=home.html', show: hnIsLead, kw: 'AI 自動排班 需求 可上班別 寒暑假' },
  { id: 'attendance',    group: 'sched',  icon: '🗂️', label: '出勤管理',   sub: '打卡紀錄、補登審核、缺卡',   go: 'attendance.html', show: hnIsLead, kw: '打卡 補登 審核 遲到' },
  { id: 'inspection',    group: 'sched',  icon: '📦', label: '盤點資料',   sub: '輪班表、出勤記錄表、薪資單', go: 'inspection.html?ref=home.html', show: hnIsLead },
  { id: 'salary',        group: 'people', icon: '💳', label: '算薪水',     sub: '每月薪資計算與發布',         go: 'salary.html', show: hnIsLead, kw: '薪資' },
  { id: 'employees',     group: 'people', icon: '👥', label: '員工資料',   sub: '帳號、職位、調店、離職',     go: 'employee-mgmt.html', show: hnIsLead, kw: '員工 帳號 密碼 離職' },
  { id: 'leaveMgmt',     group: 'people', icon: '📆', label: '員工特補休', sub: '假別管理、紀錄查詢',         go: 'leave.html?mode=mgmt', show: hnIsLead, kw: '特休 補休' },
  { id: 'performance',   group: 'ops',    icon: '📊', label: '經營績效',   sub: '每月門市損益輸入、同期比較', go: 'performance.html', show: hnIsLead, kw: '損益 營業額 盤損' },
  { id: 'owner',         group: 'ops',    tier: 'owner', icon: '👑', label: '決策儀表板', sub: '三店總覽、店長管理力',       go: 'owner-dashboard.html', show: hnIsOwner, kw: '加盟主' },
  { id: 'analytics',     group: 'ops',    tier: 'owner', icon: '📈', label: '人事分析',   sub: '多月趨勢、支援成本、時薪',   go: 'analytics.html', show: hnIsOwner, kw: '人事成本' },
  { id: 'export',        group: 'ops',    tier: 'owner', icon: '📤', label: '薪資匯出',   sub: 'Excel／PDF 薪資報表',        go: 'export.html', show: hnIsOwner },
  { id: 'cityAdmin',     group: 'tools',  tier: 'admin', icon: '🧾', label: 'CITY手順管理', sub: '確認每週同步的變動後發佈', go: 'city-admin.html', show: hnIsAdmin },
  { id: 'audit',         group: 'tools',  tier: 'admin', icon: '🩺', label: '資料健檢',   sub: '假別／到職日／跨店一致性',   go: 'data-audit.html', show: hnIsAdmin },
  { id: 'rolePreview',   group: 'tools',  tier: 'admin', icon: '🎭', label: '角色預覽',   sub: '以不同角色體驗介面',         run: function () { openRolePreviewModal(); }, show: function () { return (realUser || currentUser)?.permission === 'admin'; } },
  // ── 門市工具（首頁已固定顯示，這裡只為了搜尋得到）──
  { id: 'city',    group: 'store', icon: '☕', label: 'CITY手順',   sub: '飲品製作手順',   go: 'city.html' },
  { id: 'barcode', group: 'store', icon: '▥',  label: '條碼查詢',   sub: '外部網站',       href: 'https://bk-bc.github.io/Barcode/' },
  { id: 'wds',     group: 'store', icon: '💬', label: '大智通小智', sub: '外部網站',       href: 'https://www.wds.com.tw/webchat/?action=dispatch2&bb=2&openExternalBrowser=1' },
  { id: 'learn',   group: 'store', icon: '📚', label: '學習平台',   sub: '外部網站・線上課程', href: 'https://e-learning.unipcsc.com.tw/eHRD/eHRDOrg', browser: true, kw: '教育訓練 課程 e-learning' },
  // ── 帳號與系統 ──
  { id: 'account',   group: 'sys', icon: '👤', label: '帳號管理',     sub: '修改密碼、個人資料',         go: 'employee-mgmt.html?mode=self', kw: '密碼' },
  { id: 'push',      group: 'sys', icon: '📣', label: '推播通知',     sub: '開啟、測試、關閉這台手機的推播', run: function () { openPushSettings(); }, kw: '通知 推播' },
  { id: 'a2hs',      group: 'sys', icon: '📲', label: '加入主畫面',   sub: '像 App 一樣從手機桌面打開',   run: function () { openA2hsGuide(); }, show: function () { return !hpStandalone(); }, kw: '安裝 桌面 App' },
  { id: 'settings',  group: 'sys', icon: '🔧', label: '系統設定',     sub: '班別、工時、投保級距、更新日誌', go: 'settings.html', show: hnIsLead, kw: '設定 更新日誌' },
  { id: 'changelog', group: 'sys', icon: '📋', label: '更新日誌',     sub: '系統功能更新紀錄',           go: 'settings.html', show: function () { return !hnIsLead(); } },
  { id: 'tour',      group: 'sys', icon: '🎓', label: 'App 使用教學',  sub: '打卡、劃休、看班表、薪資簽收', run: function () { startHomeTour(true); }, kw: '教學 新人 導覽 怎麼用' },
  { id: 'logout',    group: 'sys', icon: '🚪', label: '登出',         sub: '退出目前帳號',               run: function () { doLogout(); }, danger: true },
];

// ===== 可折疊群組（目前只有門市工具）=====
// 首頁已固定顯示的功能在抽屜裡是重複資訊，預設收起來；展開與否記在 localStorage，換人登入不影響。
function hnFoldKey(key) { return 'navFold_' + key; }
function hnFoldOpen(key) { try { return localStorage.getItem(hnFoldKey(key)) === '1'; } catch (e) { return false; } }
function hnToggleGroup(key) {
  try { localStorage.setItem(hnFoldKey(key), hnFoldOpen(key) ? '0' : '1'); } catch (e) { /* 無痕模式：這次展開，下次回到預設 */ }
  renderNavDrawer();
}

function hnFeature(id) { return HOME_FEATURES.find(function (f) { return f.id === id; }); }
function hnVisible(f) { return !!f && (!f.show || !!f.show()); }
function hnFavKind(f) { var g = HN_GROUPS.find(function (x) { return x.key === f.group; }); return g ? g.fav : ''; }

function hnGo(id) {
  var f = hnFeature(id);
  if (!f) return;
  closeNavDrawer();
  if (f.run) { f.run(); return; }
  if (f.href && f.browser) { hpOpenInBrowser(f.href); return; }
  if (f.href) { window.open(f.href, '_blank', 'noopener'); return; }
  if (f.go) window.location.href = f.go;
}

// ===== 常用功能：預設、讀取、儲存 =====
var hnFavs = null;        // { me:[], mgmt:[] }；null＝尚未設定（用預設）
var hnUserDoc = null;     // users/{uid} 快照資料（常用＋教學紀錄）
var hnUserDocPromise = null;

function hnDefaultFavs() {
  return {
    me: ['schedule', 'leaveReq', 'mySalary'],
    mgmt: hnIsOwner() ? ['owner', 'performance', 'analytics'] : ['adminSchedule', 'salary', 'attendance'],
  };
}
// 兩區各自回退預設：員工只改過「常用功能」時，mgmt 仍是 null，之後升店長／加盟主會拿到對應角色的預設
function hnCurrentFavs() {
  var d = hnDefaultFavs();
  var me = (hnFavs && Array.isArray(hnFavs.me)) ? hnFavs.me : d.me;
  var mgmt = (hnFavs && Array.isArray(hnFavs.mgmt)) ? hnFavs.mgmt : d.mgmt;
  return { me: me.slice(), mgmt: mgmt.slice() };
}
function hnLocalKey() { return 'homeUserDoc:' + (currentUser?.uid || ''); }

// 先用本機快取畫、再讀遠端；同一次載入只讀一次 users/{uid}
function hnLoadUserDoc() {
  if (hnUserDocPromise) return hnUserDocPromise;
  try {
    var c = JSON.parse(localStorage.getItem(hnLocalKey()) || 'null');
    if (c) { hnUserDoc = c; hnFavs = c.homeFavs || null; }
  } catch (e) {}
  hnUserDocPromise = (async function () {
    if (!currentUser?.uid) return hnUserDoc;
    try {
      var snap = await Promise.race([
        window.db.collection('users').doc(currentUser.uid).get(),
        new Promise(function (res) { setTimeout(function () { res(null); }, 6000); }), // ⚠️ get 卡住不會 reject
      ]);
      if (snap && snap.exists) {
        var d = snap.data() || {};
        hnUserDoc = { homeFavs: d.homeFavs || null, homeTour: d.homeTour || null, pushInvite: d.pushInvite || null, a2hsInvite: d.a2hsInvite || null };
        hnFavs = hnUserDoc.homeFavs;
        try { localStorage.setItem(hnLocalKey(), JSON.stringify(hnUserDoc)); } catch (e) {}
      }
    } catch (e) { console.warn('讀取首頁常用設定失敗:', e); }
    return hnUserDoc;
  })();
  return hnUserDocPromise;
}

function hnSaveUserField(field, value) {
  hnUserDoc = Object.assign({}, hnUserDoc || {}, { [field]: value });
  try { localStorage.setItem(hnLocalKey(), JSON.stringify(hnUserDoc)); } catch (e) {}
  if (!currentUser?.uid) return Promise.resolve();
  return window.db.collection('users').doc(currentUser.uid)
    .set({ [field]: value }, { merge: true })
    .catch(function (e) { console.warn('儲存 ' + field + ' 失敗:', e); showToast('⚠️ 沒有存到雲端，換手機登入會回到舊設定'); });
}

function hnSaveFavs(favs) {
  var mgmtSaved = hnFavs && Array.isArray(hnFavs.mgmt);
  hnFavs = {
    me: favs.me.slice(0, HN_FAV_MAX),
    mgmt: (hnIsLead() || mgmtSaved) ? favs.mgmt.slice(0, HN_FAV_MAX) : null,
  };
  renderQuickBtns();
  return hnSaveUserField('homeFavs', hnFavs);
}

// ===== 首頁常用區塊 =====
function renderQuickBtns() {
  var personal = document.getElementById('grid-personal');
  var mgmt = document.getElementById('grid-mgmt');
  var mgmtSec = document.getElementById('mgmtSection');
  if (!personal) return;
  var favs = hnCurrentFavs();
  var tile = function (id) {
    var f = hnFeature(id);
    return '<button class="fav-btn" data-fid="' + f.id + '" onclick="hnGo(\'' + f.id + '\')"><span class="fav-ic">' + f.icon + '</span><span class="fav-label">' + f.label + '</span></button>';
  };
  var fill = function (ids) {
    var shown = ids.filter(function (id) { return hnVisible(hnFeature(id)); });
    var html = shown.map(tile).join('');
    for (var i = shown.length; i < HN_FAV_MAX; i++) {
      html += '<button class="fav-btn add" onclick="openNavDrawer()"><span class="fav-ic">＋</span><span class="fav-label">加入常用</span></button>';
    }
    return html;
  };
  personal.innerHTML = fill(favs.me);
  if (!hnIsLead()) { if (mgmtSec) mgmtSec.style.display = 'none'; return; }
  mgmtSec.style.display = '';
  mgmt.innerHTML = fill(favs.mgmt);
}

// 首頁載入時呼叫：先畫（快取或預設），遠端回來若不同再重畫
function initHomeNav() {
  renderQuickBtns();
  hnLoadUserDoc().then(function () { renderQuickBtns(); maybeAutoStartHomeTour(); });
}

// ===== ☰ 抽屜 =====
function openNavDrawer() {
  var dName = displayNameMap[currentUser.empName] || currentUser.displayName || currentUser.empName || '';
  document.getElementById('ndAvatar').textContent = dName ? dName[0] : '👤';
  document.getElementById('ndName').textContent = dName || '--';
  document.getElementById('ndRole').textContent =
    ({ employee: '員工', manager: '店長', owner: '加盟主', admin: '系統管理者' }[currentUser.permission] || '') +
    (currentUser.store ? ' · ' + currentUser.store : '');
  var s = document.getElementById('ndSearch');
  if (s) s.value = '';
  renderNavDrawer();
  document.getElementById('navDrawerOverlay').classList.add('active');
  var d = document.getElementById('navDrawer');
  d.classList.add('active');
  d.setAttribute('aria-hidden', 'false');
  document.getElementById('ndBody').scrollTop = 0;
}
function closeNavDrawer() {
  var o = document.getElementById('navDrawerOverlay');
  var d = document.getElementById('navDrawer');
  if (o) o.classList.remove('active');
  if (d) { d.classList.remove('active'); d.setAttribute('aria-hidden', 'true'); }
}

function hnItemHtml(f, favs, showGroup) {
  var kind = hnFavKind(f);
  var on = kind && favs[kind].indexOf(f.id) >= 0;
  var star = kind
    ? '<button class="nd-star' + (on ? ' on' : '') + '" onclick="event.stopPropagation();hnToggleFav(\'' + f.id + '\')" aria-label="' + (on ? '從首頁移除' : '加到首頁') + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + (on ? '★' : '☆') + '</button>'
    : '';
  var g = showGroup ? HN_GROUPS.find(function (x) { return x.key === f.group; }) : null;
  // 加盟主／管理者專用項目上底色＋左側色條＋標籤：清單太長時一眼看出哪些不是店長層級的功能
  var tierCls = f.tier ? ' tier-' + f.tier : '';
  var tierTag = f.tier ? '<span class="nd-tier">' + HN_TIER_LABEL[f.tier] + '</span>' : '';
  return '<div class="nd-item' + (f.danger ? ' danger' : '') + tierCls + '" role="button" tabindex="0" data-fid="' + f.id + '" onclick="hnGo(\'' + f.id + '\')" onkeydown="if(event.key===\'Enter\')hnGo(\'' + f.id + '\')">' +
    '<span class="nd-ic">' + f.icon + '</span>' +
    '<span class="nd-text"><span class="nd-label">' + f.label + tierTag + '</span><span class="nd-sub">' + (g ? g.title + '・' : '') + f.sub + '</span></span>' +
    (f.href ? '<span class="nd-ext" aria-hidden="true">↗</span>' : '') + star + '</div>';
}

function renderNavDrawer() {
  var body = document.getElementById('ndBody');
  if (!body) return;
  var favs = hnCurrentFavs();
  var q = (document.getElementById('ndSearch')?.value || '').trim().toLowerCase();
  var visible = HOME_FEATURES.filter(hnVisible);
  var countTag = function (kind) {
    var n = favs[kind].filter(function (id) { return hnVisible(hnFeature(id)); }).length;
    return '<em>首頁 ' + n + '／' + HN_FAV_MAX + '</em>';
  };

  if (q) {
    var hits = visible.filter(function (f) { return (f.label + ' ' + f.sub + ' ' + (f.kw || '')).toLowerCase().indexOf(q) >= 0; });
    body.innerHTML = hits.length
      ? hits.map(function (f) { return hnItemHtml(f, favs, true); }).join('')
      : '<div class="nd-empty">找不到「' + q.replace(/[<>&"]/g, '') + '」，換個關鍵字試試</div>';
    return;
  }

  var pendN = Number(document.getElementById('pendingBadgeCount')?.textContent || 0);
  var html = pendN > 0
    ? '<div class="nd-pending" role="button" tabindex="0" onclick="closeNavDrawer();document.getElementById(\'pendingCard\').scrollIntoView({behavior:\'smooth\'})"><span class="dot d-red"></span>待處理事項 ' + pendN + ' 件<span class="nd-go">›</span></div>'
    : '';
  var mgmtHeaderDone = false, mgmtEnded = false;
  HN_GROUPS.forEach(function (g) {
    var items = visible.filter(function (f) { return f.group === g.key; });
    if (!items.length) return;
    if (g.fav === 'mgmt' && !mgmtHeaderDone) {
      html += '<div class="nd-divider">管理功能' + countTag('mgmt') + '</div>';
      mgmtHeaderDone = true;
    } else if (g.fav !== 'mgmt' && mgmtHeaderDone && !mgmtEnded) {
      html += '<div class="nd-sep"></div>';   // 管理功能區塊結束，後面是全員項目
      mgmtEnded = true;
    }
    if (g.fold && items.length > 1) {   // 只剩一項就不用折了（例：店長的「營運」只有經營績效）
      var open = hnFoldOpen(g.key);
      html += '<div class="nd-group nd-fold' + (open ? ' open' : '') + '" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '"' +
        ' onclick="hnToggleGroup(\'' + g.key + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();hnToggleGroup(\'' + g.key + '\');}">' +
        '<span>' + g.title + '<em>' + items.length + ' 項</em></span><span class="nd-chev">▸</span></div>';
      if (open) html += items.map(function (f) { return hnItemHtml(f, favs, false); }).join('');
      return;
    }
    html += '<div class="nd-group">' + g.title + (g.fav === 'me' ? countTag('me') : '') + '</div>';
    html += items.map(function (f) { return hnItemHtml(f, favs, false); }).join('');
  });
  body.innerHTML = html;
}

function hnToggleFav(id) {
  var f = hnFeature(id);
  var kind = f && hnFavKind(f);
  if (!kind) return;
  var favs = hnCurrentFavs();
  // 先把已經沒權限的清掉，避免「看不到的項目」佔名額
  favs[kind] = favs[kind].filter(function (x) { return hnVisible(hnFeature(x)); });
  var i = favs[kind].indexOf(id);
  if (i >= 0) {
    favs[kind].splice(i, 1);
    showToast('已從首頁移除「' + f.label + '」');
  } else {
    if (favs[kind].length >= HN_FAV_MAX) {
      showToast((kind === 'me' ? '常用功能' : '常用管理') + '已經有 ' + HN_FAV_MAX + ' 個，請先移除一個');
      return;
    }
    favs[kind].push(id);
    showToast('已加到首頁「' + f.label + '」');
  }
  hnSaveFavs(favs);
  renderNavDrawer();
}

// ===== 編輯常用（調順序、移除、恢復預設）=====
var hnEditDraft = null;

function openFavEditor() {
  var favs = hnCurrentFavs();
  hnEditDraft = {
    me: favs.me.filter(function (id) { return hnVisible(hnFeature(id)); }),
    mgmt: favs.mgmt.filter(function (id) { return hnVisible(hnFeature(id)); }),
  };
  renderFavEditor();
  document.getElementById('favEditOverlay').classList.add('active');
  document.getElementById('favEditSheet').classList.add('active');
}
function closeFavEditor() {
  document.getElementById('favEditOverlay').classList.remove('active');
  document.getElementById('favEditSheet').classList.remove('active');
  hnEditDraft = null;
}
function renderFavEditor() {
  var box = document.getElementById('favEditBody');
  if (!box || !hnEditDraft) return;
  var sec = function (kind, title) {
    var ids = hnEditDraft[kind];
    var rows = ids.map(function (id, i) {
      var f = hnFeature(id);
      return '<div class="fe-row">' +
        '<button class="fe-rm" onclick="hnEditMove(\'' + kind + '\',' + i + ',0)" aria-label="移除' + f.label + '">−</button>' +
        '<span class="nd-ic">' + f.icon + '</span><span class="fe-label">' + f.label + '</span>' +
        '<button class="fe-arr" ' + (i === 0 ? 'disabled' : '') + ' onclick="hnEditMove(\'' + kind + '\',' + i + ',-1)" aria-label="上移">▲</button>' +
        '<button class="fe-arr" ' + (i === ids.length - 1 ? 'disabled' : '') + ' onclick="hnEditMove(\'' + kind + '\',' + i + ',1)" aria-label="下移">▼</button>' +
        '</div>';
    }).join('');
    return '<div class="fe-sec"><div class="fe-title">' + title + ' ' + ids.length + '／' + HN_FAV_MAX + '</div>' +
      (rows || '<div class="fe-empty">目前是空的</div>') + '</div>';
  };
  box.innerHTML = sec('me', '常用功能') + (hnIsLead() ? sec('mgmt', '常用管理') : '') +
    '<div class="fe-note">要換成別的功能：先按 − 移除，再到左上角 ☰ 裡點 ☆</div>' +
    '<button class="fe-reset" onclick="hnEditReset()">恢復預設</button>';
}
function hnEditMove(kind, i, dir) {
  var ids = hnEditDraft[kind];
  if (dir === 0) { ids.splice(i, 1); }
  else {
    var j = i + dir;
    if (j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
  }
  renderFavEditor();
}
function hnEditReset() {
  var d = hnDefaultFavs();
  hnEditDraft = {
    me: d.me.filter(function (id) { return hnVisible(hnFeature(id)); }),
    mgmt: d.mgmt.filter(function (id) { return hnVisible(hnFeature(id)); }),
  };
  renderFavEditor();
}
function saveFavEditor() {
  if (!hnEditDraft) return;
  // 管理區塊沒顯示（員工）時保留原本的 mgmt，不要被清空
  hnSaveFavs({ me: hnEditDraft.me, mgmt: hnIsLead() ? hnEditDraft.mgmt : hnCurrentFavs().mgmt });
  closeFavEditor();
  showToast('✅ 已更新首頁常用');
}
