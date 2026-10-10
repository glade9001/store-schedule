// 團購第 2 階段：客人端 LIFF 頁（2026-10-10）
// 網址：liff.html?store=meide／lianxin／jinhua（小編貼在各門市群組）
//   不帶門市（LINE 圖文選單、加好友歡迎訊息，2026-10-11）：記住的門市 → 最近一筆訂單的門市 → 請客人選；
//   pick=1 強制重選門市、tab=mine 直接開〔我的訂單〕。
// 客人不需登入莉學系統；身分＝LINE（liff.getIDToken），下單／改單／查單一律走 Cloud Functions（functions/groupbuy.js），
// 伺服器驗證 Token 後才寫入。團購列表直接讀 Firestore（規則只放行 status == "open" 的查詢）。

// LIFF ID：加盟主在團購頁〔設定〕分頁貼上，存在 gb_settings/liff（未登入可讀）；這裡留空就讀那份設定
var LF_LIFF_ID = '';

var lfPhone = '', lfAfterPhone = null;
// 測試模式：連結帶 test=1 只看「測試團」；正式連結看不到測試團（2026-10-11）
var lfTest = (function () { var q = new URLSearchParams(location.search); if (q.get('test') === '1') return true; try { return /(?:^|[?&])test=1(?:&|$)/.test(decodeURIComponent(q.get('liff.state') || '')); } catch (e) { return false; } })();
var lfStore = '', lfToken = '', lfProfile = null, lfCamps = [], lfMine = {}, lfMineList = [], lfPick = null, lfQty = 1, lfMax = 1, lfEdit = false;

function lfFn(name) { return firebase.app().functions('asia-east1').httpsCallable(name); }
function lfErr(e) {
  var m = String((e && e.message) || e || '');
  if (/unauthenticated|過期/.test(m)) return 'LINE 登入已過期，請關閉頁面重新開啟';
  return m.replace(/^(FirebaseError|Error):\s*/, '') || '發生錯誤，請稍後再試';
}

// 網址參數：liff.init 之後可能被包進 liff.state，兩邊都要讀
function lfParam(k) {
  var q = new URLSearchParams(location.search);
  if (q.get(k)) return q.get(k);
  try { var st = q.get('liff.state') || ''; return new URLSearchParams(decodeURIComponent(st).replace(/^[^?]*\?/, '')).get(k) || ''; } catch (e) { return ''; }
}
function lfValidStore(c) { return !!c && GB_STORES.some(function (s) { return s.code === c; }); }
var LF_STORE_KEY = 'gbLiffStore';
function lfRemember(c) { try { localStorage.setItem(LF_STORE_KEY, c); } catch (e) {} }

window.onload = async function () {
  lfStore = lfParam('store');
  if (lfValidStore(lfStore)) lfRemember(lfStore); else lfStore = '';
  if (!LF_LIFF_ID) {
    try { var cfg = await gbTimeout(window.db.collection('gb_settings').doc('liff').get(), 10000); if (cfg.exists) LF_LIFF_ID = cfg.data().liff_id || ''; } catch (e) {}
  }
  if (!LF_LIFF_ID) { lfFatal('團購還在準備中，請稍後再試'); return; }
  try {
    await liff.init({ liffId: LF_LIFF_ID });
    if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
    lfToken = liff.getIDToken() || '';
    lfProfile = await liff.getProfile().catch(function () { return null; });
    if (lfProfile) document.getElementById('lfHello').textContent = '嗨，' + lfProfile.displayName + '・到店取貨付款';
  } catch (e) { lfFatal('LINE 連線失敗：' + lfErr(e)); return; }
  await lfLoadMine();
  // 沒帶門市：記住的門市 → 最近一筆訂單的門市 → 請客人選（pick=1 一律重選）
  var forcePick = lfParam('pick') === '1';
  if (!lfStore && !forcePick) {
    try { var saved = localStorage.getItem(LF_STORE_KEY) || ''; if (lfValidStore(saved)) lfStore = saved; } catch (e) {}
    if (!lfStore && lfMineList.length && lfValidStore(lfMineList[0].store)) lfStore = lfMineList[0].store;
  }
  if (!lfStore) { lfAskStore(); return; }
  await lfStart();
};
function lfAskStore() {
  gbLoading(false);
  document.getElementById('lfStoreName').textContent = '請選擇取貨門市';
  document.querySelector('.gb-tabs').hidden = true;
  document.getElementById('lfMine').hidden = true;
  document.getElementById('lfList').hidden = false;
  document.getElementById('lfList').innerHTML = '<div class="card"><div style="font-size:15px;font-weight:800;margin-bottom:4px;">你要在哪一家門市取貨？</div>' +
    '<div style="font-size:13px;color:var(--muted);margin-bottom:10px;">選一次就會記住，之後可以按上方「換門市」修改。</div>' +
    GB_STORES.map(function (s) { return '<button class="lf-go" style="background:#0e2140;" onclick="lfChooseStore(\'' + s.code + '\')">7-ELEVEN ' + s.name + '門市</button>'; }).join('') + '</div>';
}
async function lfChooseStore(code) {
  if (!lfValidStore(code)) return;
  lfStore = code; lfRemember(code);
  document.querySelector('.gb-tabs').hidden = false;
  gbLoading(true);
  await lfStart();
}
async function lfStart() {
  document.getElementById('lfStoreName').innerHTML = gbEsc('7-ELEVEN ' + gbStoreName(lfStore) + '門市 團購' + (lfTest ? '（測試）' : '')) +
    ' <button onclick="lfAskStore()" style="margin-left:6px;font-size:12px;font-weight:800;padding:3px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.5);background:transparent;color:#fff;cursor:pointer;font-family:inherit;vertical-align:middle;">換門市</button>';
  await lfLoadCamps();
  lfRender();
  lfSetTab(lfParam('tab') === 'mine' ? 'mine' : 'list');
  gbLoading(false);
  // 在群組直接 +1 的客人系統拿不到手機（2026-10-11 使用者：先做「打開頁面時請他補」）：
  // 有訂單、還沒留手機 → 一打開就請他留（只在他自己手機上填，不會出現在群組）
  if (!lfPhone && lfMineList.some(function (o) { return o.status === 'active'; })) {
    lfAskPhone(null, '你在群組登記的團購已經收到了！留個手機號碼，到貨或沒來取貨時門市才聯絡得到你。只在莉學商行三家門市內部使用，不會公開在群組。');
  }
}
function lfFatal(msg) {
  gbLoading(false);
  document.getElementById('lfList').innerHTML = '<div class="card"><div class="empty" style="font-size:15px;">' + gbEsc(msg) + '</div></div>';
}

async function lfLoadCamps() {
  try {
    var sn = await gbTimeout(window.db.collection('gb_campaigns').where('status', '==', 'open').get());
    var now = Date.now();
    lfCamps = sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (c) { var e = gbToDate(c.end_time); return (c.available_stores || []).indexOf(lfStore) >= 0 && e && e.getTime() > now && (c.is_test === true) === lfTest; })
      .sort(function (a, b) { return gbToDate(a.end_time) - gbToDate(b.end_time) || (a.round || 1) - (b.round || 1); });
  } catch (e) { lfCamps = []; gbToast('讀取團購失敗：' + lfErr(e)); }
}
async function lfLoadMine() {
  try {
    var r = await gbTimeout(lfFn('gbMyOrders')({ idToken: lfToken }));
    lfMineList = (r.data && r.data.orders) || [];
    lfPhone = (r.data && r.data.phone) || '';
    lfMine = {}; lfMineList.forEach(function (o) { if (o.status === 'active') lfMine[o.campaignId] = o; });
  } catch (e) { lfMineList = []; lfMine = {}; }
}

function lfSetTab(t) {
  var mine = t === 'mine';
  document.getElementById('lfList').hidden = mine; document.getElementById('lfMine').hidden = !mine;
  document.getElementById('lfTabList').classList.toggle('on', !mine); document.getElementById('lfTabList').setAttribute('aria-selected', String(!mine));
  document.getElementById('lfTabMine').classList.toggle('on', mine); document.getElementById('lfTabMine').setAttribute('aria-selected', String(mine));
}

function lfRender() {
  var el = document.getElementById('lfList');
  // 額滿自動開下一團：已經額滿、而且我沒訂的那一團不顯示，只看正在接單的團
  var seriesOf = function (c) { return c.series_id || c.id; };
  var hasRoomInSeries = function (c) { return lfCamps.some(function (o) { return o.id !== c.id && seriesOf(o) === seriesOf(c) && lfRemain(o) > 0; }); };
  // 額滿、我沒訂、而且同系列已經有接單中的下一團 → 不顯示；還沒有下一團就保留，讓客人按了排進下一團
  var shown = lfCamps.filter(function (c) { return !(c.auto_next && lfRemain(c) <= 0 && !lfMine[c.id] && hasRoomInSeries(c)); });
  // 多規格（2026-10-11）：同一組的規格合成一張卡片，依編號排
  var seen = {}, cards = [];
  shown.forEach(function (c) {
    if (!c.opt_group) { cards.push(lfCard(c)); return; }
    if (seen[c.opt_group]) return;
    seen[c.opt_group] = 1;
    cards.push(lfGroupCard(shown.filter(function (m) { return m.opt_group === c.opt_group; })
      .sort(function (a, b) { return String(a.opt_code).localeCompare(String(b.opt_code)) || (a.round || 1) - (b.round || 1); })));
  });
  el.innerHTML = shown.length ? cards.join('') : '<div class="card"><div class="empty" style="font-size:15px;">目前沒有開放中的團購<br>新團購會在群組裡通知 🙌</div></div>';
  var me = document.getElementById('lfMine');
  me.innerHTML = '<div class="card" style="display:flex;align-items:center;gap:10px;"><span style="flex:1;font-size:14px;">📱 聯絡手機：<b>' + (lfPhone ? gbEsc(lfPhone) : '還沒留') + '</b></span><button class="btn btn-o" onclick="lfAskPhone()">' + (lfPhone ? '修改' : '填寫') + '</button></div>' +
    (lfMineList.length ? lfMineList.map(lfMineCard).join('') : '<div class="card"><div class="empty" style="font-size:15px;">還沒有訂單</div></div>');
}
function lfRemain(c) { return c.stock == null ? Infinity : Math.max(0, c.stock - (c.ordered_qty || 0)); }
function lfCard(c) {
  var img = (c.images || [])[0], mine = lfMine[c.id], had = mine ? mine.qty : 0;
  var remain = lfRemain(c), canAdd = Math.min((c.per_user_limit || 0) - had, remain);
  var toNext = c.auto_next && remain <= 0;   // 額滿但會自動開下一團 → 照樣可以喊，伺服器排進下一團
  if (toNext) { canAdd = c.per_user_limit || 0; remain = Infinity; }
  // 保證成團也要讓客人看得到（2026-10-11 使用者）
  var prog = c.success_rule === 'threshold' ? '' : '<div class="lf-meta" style="margin-top:6px;"><span style="background:#e6f4ea;color:#137333;font-weight:800;border-radius:7px;padding:2px 9px;">✅ 保證成團</span>　截單後一定出貨</div>';
  if (c.success_rule === 'threshold' && c.min_qty) {
    var p = Math.min(100, Math.round((c.ordered_qty || 0) / c.min_qty * 100)), lack = Math.max(0, c.min_qty - (c.ordered_qty || 0));
    prog = '<div class="lf-meta" style="margin-top:6px;">' + (lack ? '還差 <b>' + lack + '</b> 份成團（三店合計）' : '✅ 已達成團門檻') + '</div><div class="bar"><i style="width:' + p + '%;background:#06c755;"></i></div>';
  }
  var btn = lfBtn(c);
  return '<div class="lf-card">' + (img && /^https:\/\//.test(img) ? '<div class="lf-img" style="background-image:url(\'' + gbEsc(img).replace(/'/g, '%27') + '\')"></div>' : '') +
    '<div class="lf-body"><div class="lf-title">' + gbEsc(c.title) + '</div><div class="lf-price">$' + (c.price || 0) + '</div>' +
    (c.description ? '<div class="lf-desc">' + gbEsc(c.description) + '</div>' : '') +
    '<div class="lf-meta">⏰ ' + gbFmt(c.end_time) + ' 截單（' + gbCountdown(c.end_time) + '）' +
      (c.stock != null ? '<br>📦 剩 ' + remain + ' 份' : '') + (gbLimitTxt(c) ? '<br>' + gbLimitTxt(c) : '') +
      (c.arrival_date ? (gbLimitTxt(c) ? '・' : '<br>') + '預計 ' + gbFmt(c.arrival_date, false) + ' 到貨' : '') + '</div>' + prog +
    (had ? '<div class="lf-mine">✅ 你已訂 ' + had + ' 份（' + gbStoreName(mine.store) + '取貨）</div>' : '') + btn + '</div></div>';
}
function lfBtn(c, small) {
  var mine = lfMine[c.id], had = mine ? mine.qty : 0;
  var remain = lfRemain(c), canAdd = Math.min((c.per_user_limit || 0) - had, remain);
  var toNext = c.auto_next && remain <= 0;
  if (toNext) { canAdd = c.per_user_limit || 0; remain = Infinity; }
  var cls = 'lf-go' + (small ? ' lf-go-s' : '');
  return remain <= 0 ? '<button class="' + cls + '" disabled>已售完</button>'
    : canAdd <= 0 ? '<button class="' + cls + '" disabled>' + (small ? '已達上限' : '已達每人上限 ' + c.per_user_limit + ' 份') + '</button>'
    : '<button class="' + cls + '" onclick="lfOpen(\'' + c.id + '\')">' + (toNext ? (small ? '＋1 排下一團' : '＋1（這團已滿，排進下一團）') : had ? '＋ 再加' : (small ? '＋1' : '＋1 我要')) + '</button>';
}
function lfGroupCard(ms) {
  var c = ms[0], img = (c.images || [])[0];
  var rows = ms.map(function (m) {
    var mine = lfMine[m.id];
    return '<div class="lf-opt"><div class="lf-opt-t"><b>(' + gbEsc(m.opt_code) + ') ' + gbEsc(m.opt_label || '') + '</b> <span class="lf-opt-p">$' + (m.price || 0) + '</span>' +
      (m.round > 1 ? ' <small>第' + m.round + '團</small>' : '') + (m.stock != null ? '<small>剩 ' + lfRemain(m) + ' 份</small>' : '') +
      (mine ? '<span class="lf-opt-mine">✅ 已訂 ' + mine.qty + ' 份</span>' : '') +
      (m.success_rule === 'threshold' && m.min_qty ? '<small>' + (Math.max(0, m.min_qty - (m.ordered_qty || 0)) ? '還差 ' + Math.max(0, m.min_qty - (m.ordered_qty || 0)) + ' 份成團' : '✅ 已成團門檻') + '</small>' : '') +
      '</div>' + lfBtn(m, true) + '</div>';
  }).join('');
  var guaranteed = ms.every(function (m) { return m.success_rule !== 'threshold'; });
  return '<div class="lf-card">' + (img && /^https:\/\//.test(img) ? '<div class="lf-img" style="background-image:url(\'' + gbEsc(img).replace(/'/g, '%27') + '\')"></div>' : '') +
    '<div class="lf-body"><div class="lf-title">' + gbEsc(c.base_title || c.title) + '</div>' +
    (c.description ? '<div class="lf-desc">' + gbEsc(c.description) + '</div>' : '') +
    '<div class="lf-meta">⏰ ' + gbFmt(c.end_time) + ' 截單（' + gbCountdown(c.end_time) + '）' + (gbLimitTxt(c, true) ? '<br>' + gbLimitTxt(c, true) : '') +
      (c.arrival_date ? (gbLimitTxt(c, true) ? '・' : '<br>') + '預計 ' + gbFmt(c.arrival_date, false) + ' 到貨' : '') + '</div>' +
    (guaranteed ? '<div class="lf-meta" style="margin-top:6px;"><span style="background:#e6f4ea;color:#137333;font-weight:800;border-radius:7px;padding:2px 9px;">✅ 保證成團</span>　截單後一定出貨</div>' : '') +
    '<div style="margin-top:10px;">' + rows + '</div></div></div>';
}
function lfMineCard(o) {
  var st = o.status === 'picked_up' ? '✅ 已取貨' : o.status === 'no_show' ? '未取貨' :
    o.campaignStatus === 'open' ? '訂購中' : o.campaignStatus === 'success' ? '已成團・等到貨' : o.campaignStatus === 'arrived' ? '📦 已到貨，可以取貨了' :
    o.campaignStatus === 'failed' ? '未成團（不用取貨）' : o.campaignStatus === 'closed' ? '已截單・等結果' : (GB_STATUS[o.campaignStatus] || '');
  return '<div class="card"><div style="display:flex;gap:10px;align-items:baseline;"><b style="font-size:16px;flex:1;">' + gbEsc(o.title) + '</b><b>$' + (o.price * o.qty) + '</b></div>' +
    '<div class="lf-meta">' + o.qty + ' 份・' + gbStoreName(o.store) + '取貨・' + st +
      (o.pickupDeadline ? '<br>取貨期限 ' + gbFmt(o.pickupDeadline, false) : '') + (o.endTime && o.editable ? '<br>截單前可以修改（' + gbCountdown(o.endTime) + '）' : '') + '</div>' +
    (o.editable ? '<div class="actions"><button class="btn btn-o" onclick="lfOpenEdit(\'' + o.campaignId + '\')">改數量</button><button class="btn btn-d" onclick="lfCancel(\'' + o.campaignId + '\')">取消訂單</button></div>' : '') + '</div>';
}

// ---- 選數量 ----
function lfOpen(cid) {
  var c = lfCamps.find(function (x) { return x.id === cid; }); if (!c) return;
  if (!lfPhone) { lfAskPhone(function () { lfOpen(cid); }); return; }   // 第一次下單先留手機
  var had = lfMine[cid] ? lfMine[cid].qty : 0;
  lfPick = c; lfEdit = false; lfQty = 1;
  lfMax = (c.auto_next && lfRemain(c) <= 0) ? (c.per_user_limit || 0) : Math.min((c.per_user_limit || 0) - had, lfRemain(c));
  document.getElementById('qmTitle').textContent = c.title;
  document.getElementById('qmLead').textContent = '$' + c.price + '／份・' + (had ? '你已訂 ' + had + ' 份，這次再加' : '要訂幾份？') + '（最多 ' + lfMax + ' 份）';
  lfShowQty();
}
function lfOpenEdit(cid) {
  var o = lfMineList.find(function (x) { return x.campaignId === cid; }); if (!o) return;
  var c = lfCamps.find(function (x) { return x.id === cid; });
  lfPick = { id: cid, title: o.title, price: o.price }; lfEdit = true; lfQty = o.qty;
  lfMax = Math.min(o.perUserLimit, o.qty + (c ? lfRemain(c) : 0));
  document.getElementById('qmTitle').textContent = '修改數量：' + o.title;
  document.getElementById('qmLead').textContent = '目前 ' + o.qty + ' 份（最多 ' + lfMax + ' 份）';
  lfShowQty();
}
function lfShowQty() { document.getElementById('qmQty').textContent = lfQty; document.getElementById('qmErr').textContent = ''; document.getElementById('qtyModal').hidden = false; }
function lfStep(d) { lfQty = Math.max(1, Math.min(lfMax, lfQty + d)); document.getElementById('qmQty').textContent = lfQty; }
async function lfConfirm() {
  var btn = document.getElementById('qmOk'); btn.disabled = true;
  var c = lfPick;
  try {
    if (lfEdit) {
      await gbTimeout(lfFn('gbUpdateMyOrder')({ idToken: lfToken, campaignId: c.id, qty: lfQty }));
      gbToast('✅ 已改為 ' + lfQty + ' 份');
    } else {
      if (!lfPhone) { document.getElementById('qtyModal').hidden = true; lfAskPhone(lfConfirm); btn.disabled = false; return; }
      var r = await gbTimeout(lfFn('gbPlaceOrder')({ idToken: lfToken, campaignId: c.id, store: lfStore, qty: lfQty }));
      var rt = (r.data && r.data.title) || c.title;
      gbToast('✅ 登記成功：' + rt + ' 共 ' + ((r.data && r.data.qty) || lfQty) + ' 份');
      lfPostToGroup(rt, lfQty);
    }
    document.getElementById('qtyModal').hidden = true;
    await Promise.all([lfLoadCamps(), lfLoadMine()]); lfRender();
  } catch (e) { document.getElementById('qmErr').textContent = lfErr(e); }
  btn.disabled = false;
}
async function lfCancel(cid) {
  var o = lfMineList.find(function (x) { return x.campaignId === cid; }); if (!o) return;
  lfPick = { id: cid }; lfEdit = true;
  // 用確認視窗（LIFF 內不用 confirm()）
  document.getElementById('qmTitle').textContent = '取消訂單';
  document.getElementById('qmLead').textContent = '確定取消「' + o.title + '」' + o.qty + ' 份？';
  document.querySelector('#qtyModal .stepper').hidden = true;
  var ok = document.getElementById('qmOk'); ok.textContent = '取消訂單'; ok.style.background = '#d93025';
  ok.onclick = async function () {
    ok.disabled = true;
    try { await gbTimeout(lfFn('gbUpdateMyOrder')({ idToken: lfToken, campaignId: cid, qty: 0 })); gbToast('已取消'); lfResetModal(); await Promise.all([lfLoadCamps(), lfLoadMine()]); lfRender(); }
    catch (e) { document.getElementById('qmErr').textContent = lfErr(e); }
    ok.disabled = false;
  };
  document.getElementById('qmErr').textContent = '';
  document.getElementById('qtyModal').hidden = false;
}
function lfResetModal() {
  document.getElementById('qtyModal').hidden = true;
  document.querySelector('#qtyModal .stepper').hidden = false;
  var ok = document.getElementById('qmOk'); ok.textContent = '確定'; ok.style.background = '#06c755'; ok.onclick = lfConfirm;
}
document.addEventListener('click', function (e) { if (e.target && e.target.matches && e.target.matches('#qtyModal .btn-g')) lfResetModal(); });

// 在群組聊天室裡開啟時，代客人發「商品名 +數量」；失敗（外部瀏覽器、權限）直接略過，不影響訂單
function lfPostToGroup(title, qty) {
  try {
    if (!liff.isInClient()) return;
    var ctx = liff.getContext() || {};
    if (['group', 'room', 'square_chat'].indexOf(ctx.type) < 0) return;
    // ⚠️ 開頭固定「✅ 已登記」：機器人看到就知道是下單頁代發的，不會再當成 +1 重複建單（2026-10-11 修）
    liff.sendMessages([{ type: 'text', text: '✅ 已登記 ' + title + ' +' + qty }]).catch(function () {});
  } catch (e) {}
}

// ---- 手機（第一次下單前要留；我的訂單可改）----
function lfAskPhone(after, lead) {
  lfAfterPhone = typeof after === 'function' ? after : null;
  document.querySelector('#phoneModal .lead').textContent = lead || '到貨時或逾期沒來取貨時，門市會用這支電話聯絡你。只在莉學商行三家門市內部使用，不會拿來行銷，也不會公開在群組。';
  document.getElementById('pmPhone').value = lfPhone || '';
  document.getElementById('pmErr').textContent = '';
  document.getElementById('phoneModal').hidden = false;
  setTimeout(function () { document.getElementById('pmPhone').focus(); }, 50);
}
async function lfSavePhone() {
  var v = document.getElementById('pmPhone').value.replace(/[\s-]/g, '');
  var err = document.getElementById('pmErr'); err.textContent = '';
  if (!/^09\d{8}$/.test(v)) { err.textContent = '請填 09 開頭的 10 碼手機號碼'; return; }
  var ok = document.getElementById('pmOk'); ok.disabled = true;
  try {
    await gbTimeout(lfFn('gbSetPhone')({ idToken: lfToken, phone: v }));
    lfPhone = v;
    document.getElementById('phoneModal').hidden = true;
    gbToast('✅ 已儲存手機');
    lfRender();
    if (lfAfterPhone) { var f = lfAfterPhone; lfAfterPhone = null; f(); }
  } catch (e) { err.textContent = lfErr(e); }
  ok.disabled = false;
}
