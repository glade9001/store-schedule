// 團購第 2 階段：客人端 LIFF 頁（2026-10-10）
// 網址：liff.html?store=meide／lianxin／jinhua（小編貼在各門市群組）
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

window.onload = async function () {
  lfStore = new URLSearchParams(location.search).get('store') || '';
  // liff.init 之後網址可能帶 liff.state，門市參數從那裡也要讀得到
  if (!lfStore) { try { var st = new URLSearchParams(location.search).get('liff.state') || ''; lfStore = new URLSearchParams(st.replace(/^[^?]*\?/, '')).get('store') || ''; } catch (e) {} }
  if (!gbStoreName(lfStore) || lfStore === gbStoreName(lfStore)) { lfFatal('連結少了門市資訊，請從門市群組裡的連結開啟'); return; }
  document.getElementById('lfStoreName').textContent = '7-ELEVEN ' + gbStoreName(lfStore) + '門市 團購' + (lfTest ? '（測試）' : '');
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
  await Promise.all([lfLoadCamps(), lfLoadMine()]);
  lfRender();
  gbLoading(false);
  // 在群組直接 +1 的客人系統拿不到手機（2026-10-11 使用者：先做「打開頁面時請他補」）：
  // 有訂單、還沒留手機 → 一打開就請他留（只在他自己手機上填，不會出現在群組）
  if (!lfPhone && lfMineList.some(function (o) { return o.status === 'active'; })) {
    lfAskPhone(null, '你在群組登記的團購已經收到了！留個手機號碼，到貨或沒來取貨時門市才聯絡得到你。只在莉學商行三家門市內部使用，不會公開在群組。');
  }
};
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
      .sort(function (a, b) { return gbToDate(a.end_time) - gbToDate(b.end_time); });
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
  el.innerHTML = lfCamps.length ? lfCamps.map(lfCard).join('') : '<div class="card"><div class="empty" style="font-size:15px;">目前沒有開放中的團購<br>新團購會在群組裡通知 🙌</div></div>';
  var me = document.getElementById('lfMine');
  me.innerHTML = '<div class="card" style="display:flex;align-items:center;gap:10px;"><span style="flex:1;font-size:14px;">📱 聯絡手機：<b>' + (lfPhone ? gbEsc(lfPhone) : '還沒留') + '</b></span><button class="btn btn-o" onclick="lfAskPhone()">' + (lfPhone ? '修改' : '填寫') + '</button></div>' +
    (lfMineList.length ? lfMineList.map(lfMineCard).join('') : '<div class="card"><div class="empty" style="font-size:15px;">還沒有訂單</div></div>');
}
function lfRemain(c) { return c.stock == null ? Infinity : Math.max(0, c.stock - (c.ordered_qty || 0)); }
function lfCard(c) {
  var img = (c.images || [])[0], mine = lfMine[c.id], had = mine ? mine.qty : 0;
  var remain = lfRemain(c), canAdd = Math.min((c.per_user_limit || 0) - had, remain);
  // 保證成團也要讓客人看得到（2026-10-11 使用者）
  var prog = c.success_rule === 'threshold' ? '' : '<div class="lf-meta" style="margin-top:6px;"><span style="background:#e6f4ea;color:#137333;font-weight:800;border-radius:7px;padding:2px 9px;">✅ 保證成團</span>　截單後一定出貨</div>';
  if (c.success_rule === 'threshold' && c.min_qty) {
    var p = Math.min(100, Math.round((c.ordered_qty || 0) / c.min_qty * 100)), lack = Math.max(0, c.min_qty - (c.ordered_qty || 0));
    prog = '<div class="lf-meta" style="margin-top:6px;">' + (lack ? '還差 <b>' + lack + '</b> 份成團（三店合計）' : '✅ 已達成團門檻') + '</div><div class="bar"><i style="width:' + p + '%;background:#06c755;"></i></div>';
  }
  var btn = remain <= 0 ? '<button class="lf-go" disabled>已售完</button>'
    : canAdd <= 0 ? '<button class="lf-go" disabled>已達每人上限 ' + c.per_user_limit + ' 份</button>'
    : '<button class="lf-go" onclick="lfOpen(\'' + c.id + '\')">' + (had ? '＋ 再加' : '＋1 我要') + '</button>';
  return '<div class="lf-card">' + (img && /^https:\/\//.test(img) ? '<div class="lf-img" style="background-image:url(\'' + gbEsc(img).replace(/'/g, '%27') + '\')"></div>' : '') +
    '<div class="lf-body"><div class="lf-title">' + gbEsc(c.title) + '</div><div class="lf-price">$' + (c.price || 0) + '</div>' +
    (c.description ? '<div class="lf-desc">' + gbEsc(c.description) + '</div>' : '') +
    '<div class="lf-meta">⏰ ' + gbFmt(c.end_time) + ' 截單（' + gbCountdown(c.end_time) + '）' +
      (c.stock != null ? '<br>📦 剩 ' + remain + ' 份' : '') + '<br>每人限 ' + c.per_user_limit + ' 份' +
      (c.arrival_date ? '・預計 ' + gbFmt(c.arrival_date, false) + ' 到貨' : '') + '</div>' + prog +
    (had ? '<div class="lf-mine">✅ 你已訂 ' + had + ' 份（' + gbStoreName(mine.store) + '取貨）</div>' : '') + btn + '</div></div>';
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
  lfPick = c; lfEdit = false; lfQty = 1; lfMax = Math.min((c.per_user_limit || 0) - had, lfRemain(c));
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
      gbToast('✅ 登記成功，共 ' + ((r.data && r.data.qty) || lfQty) + ' 份');
      lfPostToGroup(c.title, lfQty);
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
    liff.sendMessages([{ type: 'text', text: title + ' +' + qty }]).catch(function () {});
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
