// 團購管理（2026-10-10 第 1 階段：後台基礎）
// 權限（使用者定案，firestore.rules 同步擋）：
//  ・加盟主／admin：所有團購可開、可改、可切狀態；截單後仍可補單
//  ・店長：只能開／改「只開放自己店」的團；跨店團只能看與補本店的單
//  ・員工：看團購、補本店的單（只限開放中）
// 補單、改數量、取消都用 transaction 同時更新訂單與 gb_campaigns.ordered_qty／ordered_by_store，並檢查每人上限與庫存。

var gbUser = null, gbMyCode = '', gbCamps = [], gbFilter = 'all', gbOpen = {}, gbOrders = {};
var gbEditId = null, gbOrderCamp = null, gbQtyOrder = null;

window.onload = async function () {
  gbUser = await gbRequireUser();
  if (!gbUser) return;
  gbMyCode = gbCodeOf(gbUser.store);
  if (gbIsOwner(gbUser) || (gbIsManager(gbUser) && gbMyCode)) document.getElementById('newBtn').hidden = false;
  gbEnsureStoreSettings(gbUser);
  await loadCampaigns();
  gbLoading(false);
};

async function loadCampaigns() {
  try {
    var sn = await gbTimeout(window.db.collection('gb_campaigns').get());
    gbCamps = sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  } catch (e) {
    document.getElementById('list').innerHTML = '<div class="empty">讀取失敗：' + gbEsc(e.message) + '</div>';
    return;
  }
  render();
}

// ---- 權限 ----
function onlyMine(c) { var s = c.available_stores || []; return s.length === 1 && s[0] === gbMyCode; }
function canEdit(c) { return gbIsOwner(gbUser) || (gbIsManager(gbUser) && !!gbMyCode && onlyMine(c)); }
function visible(c) {
  if (gbIsOwner(gbUser)) return true;
  if (c.status === 'draft') return canEdit(c);               // 員工看不到草稿；店長只看得到自己店的草稿
  return (c.available_stores || []).indexOf(gbMyCode) >= 0;
}
function isDue(c) { var d = gbToDate(c.end_time); return c.status === 'open' && d && d.getTime() < Date.now(); }
/** 可以補單嗎：開放中且有開給這家店；截單後只有加盟主（未成團流局、已結案、草稿都不行） */
function canAddOrder(c) {
  if (gbIsOwner(gbUser)) return ['open', 'closed', 'success', 'arrived'].indexOf(c.status) >= 0;
  return c.status === 'open' && (c.available_stores || []).indexOf(gbMyCode) >= 0;
}
function canChangeOrders(c) { return c.status === 'open' || gbIsOwner(gbUser); }

// ---- 列表 ----
function render() {
  var vis = gbCamps.filter(visible);
  var cnt = { all: vis.length, due: vis.filter(isDue).length };
  GB_STATUS_ORDER.forEach(function (s) { cnt[s] = vis.filter(function (c) { return c.status === s; }).length; });
  var chips = [['all', '全部'], ['due', '待結算']].concat(GB_STATUS_ORDER.map(function (s) { return [s, GB_STATUS[s]]; }));
  document.getElementById('chips').innerHTML = chips.filter(function (x) { return x[0] === 'all' || cnt[x[0]] || gbFilter === x[0]; }).map(function (x) {
    return '<button class="chip' + (gbFilter === x[0] ? ' on' : '') + '" role="tab" aria-selected="' + (gbFilter === x[0]) + '" onclick="gbFilter=\'' + x[0] + '\';render()">' + x[1] + '<span class="n">' + cnt[x[0]] + '</span></button>';
  }).join('');
  var list = vis.filter(function (c) { return gbFilter === 'all' ? true : gbFilter === 'due' ? isDue(c) : c.status === gbFilter; });
  // 待結算最前，其次開放中依截單時間，其餘依建立時間新到舊
  var rank = function (c) { return isDue(c) ? 0 : c.status === 'open' ? 1 : c.status === 'draft' ? 2 : 3; };
  list.sort(function (a, b) {
    var r = rank(a) - rank(b); if (r) return r;
    if (a.status === 'open') return (gbToDate(a.end_time) || 0) - (gbToDate(b.end_time) || 0);
    return (gbToDate(b.created_at) || 0) - (gbToDate(a.created_at) || 0);
  });
  var el = document.getElementById('list');
  if (!list.length) { el.innerHTML = '<div class="empty">' + (gbCamps.length ? '這個狀態沒有團購' : '還沒有團購' + (document.getElementById('newBtn').hidden ? '' : '，按右上角「＋ 開團」建立第一檔')) + '</div>'; return; }
  el.innerHTML = list.map(campCard).join('');
}

function campCard(c) {
  var img = (c.images || [])[0];
  var imgOk = img && /^https:\/\//.test(img);
  var stock = c.stock == null ? '不限量' : '剩 <b>' + Math.max(0, c.stock - (c.ordered_qty || 0)) + '</b> / ' + c.stock;
  var rule = c.success_rule === 'threshold' ? '達標成團（' + (c.min_qty || 0) + '）' : '保證成團';
  var obs = c.ordered_by_store || {};
  var stores = (c.available_stores || []).map(function (s) { return '<span class="store-qty">' + gbStoreName(s) + '<b>' + (obs[s] || 0) + '</b></span>'; }).join('');
  var prog = c.success_rule === 'threshold' && c.min_qty ? '<div class="bar" title="成團進度"><i style="width:' + Math.min(100, Math.round((c.ordered_qty || 0) / c.min_qty * 100)) + '%"></i></div>' : '';
  var btns = '<button class="btn btn-g" onclick="toggleOrders(\'' + c.id + '\')">' + (gbOpen[c.id] ? '收起訂單' : '訂單明細') + '</button>';
  if (canAddOrder(c)) btns += '<button class="btn btn-p" onclick="openOrderForm(\'' + c.id + '\')">＋ 補單</button>';
  if (canEdit(c)) {
    btns += '<button class="btn btn-o" onclick="openCampaignForm(\'' + c.id + '\')">編輯</button>';
    btns += '<select class="inline" aria-label="切換狀態" onchange="changeStatus(\'' + c.id + '\',this.value);this.value=\'\'"><option value="">切換狀態…</option>' +
      GB_STATUS_ORDER.filter(function (s) { return s !== c.status; }).map(function (s) { return '<option value="' + s + '">改為「' + GB_STATUS[s] + '」</option>'; }).join('') + '</select>';
  }
  return '<div class="card" id="camp-' + c.id + '"><div class="camp">' +
    (imgOk ? '<div class="camp-img" style="background-image:url(\'' + gbEsc(img).replace(/'/g, '%27') + '\')"></div>' : '<div class="camp-img" aria-hidden="true"></div>') +
    '<div class="camp-body">' +
      '<span class="st st-' + c.status + '">' + (GB_STATUS[c.status] || c.status) + '</span>' + (isDue(c) ? ' <span class="st st-due">待結算</span>' : '') +
      '<div class="camp-title">' + gbEsc(c.title) + '</div>' +
      '<div class="camp-meta"><b>$' + (c.price || 0) + '</b>・每人上限 ' + (c.per_user_limit || '—') + '・' + rule + '・' + stock + '</div>' +
      '<div class="camp-meta">截單 ' + gbFmt(c.end_time) + (c.status === 'open' ? '（' + gbCountdown(c.end_time) + '）' : '') +
        (c.arrival_date ? '・到貨 ' + gbFmt(c.arrival_date, false) : '') + (c.pickup_deadline ? '・取貨到 ' + gbFmt(c.pickup_deadline, false) : '') + '</div>' +
      '<div class="stores">' + stores + '<span class="store-qty">合計<b>' + (c.ordered_qty || 0) + '</b></span></div>' + prog +
    '</div></div>' +
    '<div class="actions">' + btns + '</div>' +
    (gbOpen[c.id] ? '<div class="orders" id="orders-' + c.id + '">' + ordersHtml(c) + '</div>' : '') +
  '</div>';
}

// ---- 訂單明細 ----
async function toggleOrders(cid) {
  gbOpen[cid] = !gbOpen[cid];
  if (gbOpen[cid]) await loadOrders(cid);
  render();
}
async function loadOrders(cid) {
  try {
    var q = window.db.collection('gb_orders').where('campaign_id', '==', cid);
    if (!gbIsOwner(gbUser)) q = q.where('store', '==', gbMyCode);   // 規則只放行本店（查詢必須帶門市條件）
    var sn = await gbTimeout(q.get());
    gbOrders[cid] = sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  } catch (e) { gbOrders[cid] = { error: e.message }; }
}
function ordersHtml(c) {
  var os = gbOrders[c.id];
  if (!os) return '<div class="empty">讀取中…</div>';
  if (os.error) return '<div class="empty">讀取失敗：' + gbEsc(os.error) + '</div>';
  if (!os.length) return '<div class="empty" style="padding:14px;">還沒有訂單' + (gbIsOwner(gbUser) ? '' : '（只顯示本店）') + '</div>';
  var stores = gbIsOwner(gbUser) ? (c.available_stores || []) : [gbMyCode];
  return stores.map(function (s) {
    var list = os.filter(function (o) { return o.store === s; }).sort(function (a, b) { return (gbToDate(a.created_at) || 0) - (gbToDate(b.created_at) || 0); });
    var act = list.filter(function (o) { return o.status !== 'cancelled'; }).reduce(function (t, o) { return t + (o.qty || 0); }, 0);
    return '<div class="og-title">' + gbStoreName(s) + '・' + list.length + ' 筆・' + act + ' 份</div>' + (list.length ? list.map(function (o) { return orderRow(c, o); }).join('') : '<div style="font-size:12.5px;color:var(--muted);padding:4px 0;">沒有訂單</div>');
  }).join('');
}
function orderRow(c, o) {
  var off = o.status === 'cancelled';
  var can = o.status === 'active' && canChangeOrders(c);
  return '<div class="orow' + (off ? ' off' : '') + '">' +
    '<span class="nm">' + gbEsc(o.display_name) + '</span><span class="q">×' + (o.qty || 0) + '</span>' +
    '<span class="st st-' + (o.status === 'active' ? 'open' : o.status === 'picked_up' ? 'success' : o.status === 'no_show' ? 'failed' : 'draft') + '">' + (GB_ORDER_STATUS[o.status] || o.status) + '</span>' +
    (o.paid ? '<span class="st st-success">已付款</span>' : '') +
    '<span class="sub">' + (GB_SOURCE[o.source] || o.source || '') + (o.created_by_name ? '・' + gbEsc(o.created_by_name) : '') + '・' + gbFmt(o.created_at) + (o.note ? '・' + gbEsc(o.note) : '') + '</span>' +
    (can ? '<button class="mini" onclick="openQtyForm(\'' + c.id + '\',\'' + o.id + '\')">改數量</button><button class="mini d" onclick="cancelOrder(\'' + c.id + '\',\'' + o.id + '\')">取消</button>' : '') +
  '</div>';
}

// ---- Modal 共用 ----
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
function gbConfirm(title, text, yesText) {
  return new Promise(function (resolve) {
    document.getElementById('cmTitle').textContent = title;
    document.getElementById('cmText').textContent = text;
    var y = document.getElementById('cmYes'), n = document.getElementById('cmNo');
    y.textContent = yesText || '確定';
    y.onclick = function () { closeModal('confirmModal'); resolve(true); };
    n.onclick = function () { closeModal('confirmModal'); resolve(false); };
    openModal('confirmModal');
  });
}
function intOf(id) { var v = document.getElementById(id).value.trim(); if (v === '') return null; var n = Number(v); return Number.isInteger(n) ? n : NaN; }

// ---- 開團／編輯 ----
function openCampaignForm(cid) {
  var c = cid ? gbCamps.find(function (x) { return x.id === cid; }) : null;
  if (c && !canEdit(c)) return;
  gbEditId = cid || null;
  var owner = gbIsOwner(gbUser);
  document.getElementById('campFormTitle').textContent = c ? '編輯團購' : '開團';
  document.getElementById('campFormLead').textContent = owner ? '新團購先存成「草稿」，確認後用「切換狀態」改為開放中。'
    : '店長只能開「只開放本店」的團購；跨店共用庫存的團請加盟主開。新團購先存成「草稿」。';
  document.getElementById('cfTitle').value = c ? c.title || '' : '';
  document.getElementById('cfDesc').value = c ? c.description || '' : '';
  document.getElementById('cfPrice').value = c ? c.price || '' : '';
  document.getElementById('cfLimit').value = c ? c.per_user_limit || 5 : 5;
  document.getElementById('cfImage').value = c ? (c.images || [])[0] || '' : '';
  document.getElementById('cfStock').value = c && c.stock != null ? c.stock : '';
  document.getElementById('cfEnd').value = c ? gbInputDateTime(c.end_time) : '';
  document.getElementById('cfArrival').value = c ? gbInputDate(c.arrival_date) : '';
  document.getElementById('cfPickup').value = c ? gbInputDate(c.pickup_deadline) : '';
  document.getElementById('cfMin').value = c && c.min_qty ? c.min_qty : '';
  var rule = c ? c.success_rule || 'guaranteed' : 'guaranteed';
  document.querySelectorAll('input[name=cfRule]').forEach(function (r) { r.checked = r.value === rule; });
  var sel = c ? (c.available_stores || []) : (owner ? GB_STORES.map(function (s) { return s.code; }) : [gbMyCode]);
  document.getElementById('cfStores').innerHTML = GB_STORES.map(function (s) {
    var dis = !owner && s.code !== gbMyCode;
    return '<label' + (dis ? ' style="opacity:.45"' : '') + '><input type="checkbox" value="' + s.code + '"' + (sel.indexOf(s.code) >= 0 ? ' checked' : '') + (owner ? '' : ' disabled') + '> ' + s.name + '</label>';
  }).join('');
  document.getElementById('cfErr').textContent = '';
  syncRule();
  openModal('campModal');
}
function syncRule() {
  var th = document.querySelector('input[name=cfRule]:checked').value === 'threshold';
  document.getElementById('cfMinWrap').hidden = !th;
}
async function saveCampaign() {
  var err = document.getElementById('cfErr'); err.textContent = '';
  var owner = gbIsOwner(gbUser);
  var title = document.getElementById('cfTitle').value.trim();
  var price = intOf('cfPrice'), limit = intOf('cfLimit'), stock = intOf('cfStock'), min = intOf('cfMin');
  var stores = owner ? [].slice.call(document.querySelectorAll('#cfStores input:checked')).map(function (x) { return x.value; }) : [gbMyCode];
  var rule = document.querySelector('input[name=cfRule]:checked').value;
  var end = gbTsFromInput(document.getElementById('cfEnd').value);
  var img = document.getElementById('cfImage').value.trim();
  if (!title) return err.textContent = '請填商品名稱';
  if (!(price > 0)) return err.textContent = '價格要是大於 0 的整數';
  if (!(limit >= 1)) return err.textContent = '每人上限至少 1';
  if (stock !== null && !(stock >= 1)) return err.textContent = '總庫存要是正整數，或留空表示不限量';
  if (!stores.length) return err.textContent = '請至少勾選一家開放門市';
  if (!end) return err.textContent = '請填截單時間';
  if (rule === 'threshold' && !(min >= 1)) return err.textContent = '達標成團要填最低成團數';
  if (img && !/^https:\/\//.test(img)) return err.textContent = '圖片網址要以 https:// 開頭';
  var c = gbEditId ? gbCamps.find(function (x) { return x.id === gbEditId; }) : null;
  if (c && stock !== null && stock < (c.ordered_qty || 0)) return err.textContent = '總庫存不能少於已訂的 ' + (c.ordered_qty || 0) + ' 份';
  if (c) {
    var removed = (c.available_stores || []).filter(function (s) { return stores.indexOf(s) < 0 && (c.ordered_by_store || {})[s]; });
    if (removed.length) return err.textContent = removed.map(gbStoreName).join('、') + ' 已經有訂單，不能取消開放';
  }
  var data = {
    title: title, description: document.getElementById('cfDesc').value.trim(), price: price,
    images: img ? [img] : [], available_stores: stores, stock: stock, per_user_limit: limit,
    end_time: end, arrival_date: gbTsFromDate(document.getElementById('cfArrival').value, false),
    pickup_deadline: gbTsFromDate(document.getElementById('cfPickup').value, true),
    success_rule: rule, min_qty: rule === 'threshold' ? min : null,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  };
  var btn = document.getElementById('cfSave'); btn.disabled = true;
  try {
    if (c) {
      await gbTimeout(window.db.collection('gb_campaigns').doc(c.id).update(data));
    } else {
      Object.assign(data, { status: 'draft', ordered_qty: 0, ordered_by_store: {}, source_hq_post_id: null,
        created_by: gbUser.uid, created_by_name: gbUser.displayName || gbUser.empName || '', created_at: firebase.firestore.FieldValue.serverTimestamp(),
        settled_by: null, settled_at: null });
      await gbTimeout(window.db.collection('gb_campaigns').add(data));
    }
    closeModal('campModal');
    gbToast(c ? '✅ 已更新' : '✅ 已建立草稿，確認後用「切換狀態」開放');
    await loadCampaigns();
  } catch (e) { err.textContent = '儲存失敗：' + e.message; }
  btn.disabled = false;
}
async function changeStatus(cid, st) {
  if (!st) return;
  var c = gbCamps.find(function (x) { return x.id === cid; });
  if (!c || !canEdit(c)) return;
  var warn = st === 'open' && gbToDate(c.end_time) && gbToDate(c.end_time).getTime() < Date.now() ? '\n⚠️ 截單時間已經過了，開放後客人仍無法下單，請先改截單時間。' : '';
  var ok = await gbConfirm('切換狀態', '「' + c.title + '」從「' + GB_STATUS[c.status] + '」改為「' + GB_STATUS[st] + '」？' + warn, '改為' + GB_STATUS[st]);
  if (!ok) return;
  var upd = { status: st, updated_at: firebase.firestore.FieldValue.serverTimestamp() };
  if (st === 'success' || st === 'failed') { upd.settled_by = gbUser.uid; upd.settled_at = firebase.firestore.FieldValue.serverTimestamp(); }
  gbLoading(true, '更新中…');
  try { await gbTimeout(window.db.collection('gb_campaigns').doc(cid).update(upd)); gbToast('✅ 已改為「' + GB_STATUS[st] + '」'); await loadCampaigns(); }
  catch (e) { gbToast('更新失敗：' + e.message); }
  gbLoading(false);
}

// ---- 手動補單 ----
function openOrderForm(cid) {
  var c = gbCamps.find(function (x) { return x.id === cid; });
  if (!c || !canAddOrder(c)) return;
  gbOrderCamp = c;
  var stores = gbIsOwner(gbUser) ? (c.available_stores || []) : [gbMyCode];
  var sel = document.getElementById('ofStore');
  sel.innerHTML = stores.map(function (s) { return '<option value="' + s + '">' + gbStoreName(s) + '</option>'; }).join('');
  sel.disabled = stores.length <= 1;
  document.getElementById('ofLead').textContent = '「' + c.title + '」每人上限 ' + c.per_user_limit + '・' + (c.stock == null ? '不限量' : '剩 ' + Math.max(0, c.stock - (c.ordered_qty || 0)) + ' 份') + (c.status !== 'open' ? '・⚠️ 已截單（加盟主補單）' : '');
  document.getElementById('ofName').value = '';
  document.getElementById('ofQty').value = 1;
  document.getElementById('ofNote').value = '';
  document.getElementById('ofErr').textContent = '';
  openModal('orderModal');
  setTimeout(function () { document.getElementById('ofName').focus(); }, 50);
}
async function saveManualOrder() {
  var err = document.getElementById('ofErr'); err.textContent = '';
  var c = gbOrderCamp; if (!c) return;
  var store = document.getElementById('ofStore').value, name = document.getElementById('ofName').value.trim();
  var qty = intOf('ofQty'), note = document.getElementById('ofNote').value.trim();
  if (!name) return err.textContent = '請填客人暱稱';
  if (!(qty >= 1)) return err.textContent = '數量要是正整數';
  var btn = document.getElementById('ofSave'); btn.disabled = true;
  var cRef = window.db.collection('gb_campaigns').doc(c.id);
  var oRef = window.db.collection('gb_orders').doc(c.id + '_m_' + gbRand(10));
  try {
    await gbTimeout(window.db.runTransaction(async function (t) {
      var cs = await t.get(cRef);
      if (!cs.exists) throw new Error('找不到這檔團購');
      var d = cs.data();
      if (!gbIsOwner(gbUser) && d.status !== 'open') throw new Error('這檔團購已截單，只有加盟主可以補單');
      if (['draft', 'failed', 'done'].indexOf(d.status) >= 0) throw new Error('「' + GB_STATUS[d.status] + '」的團購不能補單');
      if ((d.available_stores || []).indexOf(store) < 0) throw new Error('這檔團購沒有開放給' + gbStoreName(store));
      if (qty > (d.per_user_limit || 0)) throw new Error('超過每人上限 ' + d.per_user_limit + ' 份');
      var now = d.ordered_qty || 0;
      if (d.stock != null && now + qty > d.stock) throw new Error('庫存不足，只剩 ' + Math.max(0, d.stock - now) + ' 份');
      var obs = Object.assign({}, d.ordered_by_store || {}); obs[store] = (obs[store] || 0) + qty;
      t.set(oRef, {
        campaign_id: c.id, store: store, source: 'manual', source_message_id: null, line_user_id: null,
        display_name: name, picture_url: null, note: note, qty: qty, status: 'active', paid: false,
        created_by: gbUser.uid, created_by_name: gbUser.displayName || gbUser.empName || '',
        created_at: firebase.firestore.FieldValue.serverTimestamp(), updated_at: firebase.firestore.FieldValue.serverTimestamp(),
        picked_up_at: null, picked_up_by: null,
      });
      t.update(cRef, { ordered_qty: now + qty, ordered_by_store: obs, updated_at: firebase.firestore.FieldValue.serverTimestamp() });
    }));
    closeModal('orderModal');
    gbToast('✅ 已補單：' + name + ' ×' + qty);
    gbOpen[c.id] = true;
    await loadOrders(c.id);
    await loadCampaigns();
  } catch (e) { err.textContent = friendly(e); }
  btn.disabled = false;
}
function friendly(e) {
  var m = String((e && e.message) || e);
  if (/permission|insufficient/i.test(m)) return '沒有權限（可能已截單、超過上限，或不是本店的團購）';
  return m;
}

// ---- 改數量／取消（同步扣回 ordered_qty）----
function findOrder(cid, oid) { return (gbOrders[cid] || []).find(function (o) { return o.id === oid; }); }
function openQtyForm(cid, oid) {
  var c = gbCamps.find(function (x) { return x.id === cid; }), o = findOrder(cid, oid);
  if (!c || !o) return;
  gbQtyOrder = { c: c, o: o };
  document.getElementById('qfLead').textContent = o.display_name + '・' + c.title + '（每人上限 ' + c.per_user_limit + '）';
  document.getElementById('qfQty').value = o.qty;
  document.getElementById('qfErr').textContent = '';
  openModal('qtyModal');
}
async function saveQty() {
  var err = document.getElementById('qfErr'); err.textContent = '';
  var x = gbQtyOrder; if (!x) return;
  var qty = intOf('qfQty');
  if (!(qty >= 1)) return err.textContent = '數量要是正整數；不要了請按「取消」';
  var btn = document.getElementById('qfSave'); btn.disabled = true;
  try {
    await adjustOrder(x.c.id, x.o.id, function (o) { return { qty: qty }; }, function (o) { return qty - o.qty; });
    closeModal('qtyModal'); gbToast('✅ 已改為 ' + qty + ' 份');
  } catch (e) { err.textContent = friendly(e); }
  btn.disabled = false;
}
async function cancelOrder(cid, oid) {
  var o = findOrder(cid, oid); if (!o) return;
  var ok = await gbConfirm('取消訂單', '取消 ' + o.display_name + ' 的 ' + o.qty + ' 份？已訂數量會扣回。', '取消訂單');
  if (!ok) return;
  gbLoading(true, '取消中…');
  try {
    await adjustOrder(cid, oid, function () { return { status: 'cancelled', cancelled_by: gbUser.uid, cancelled_at: firebase.firestore.FieldValue.serverTimestamp() }; }, function (o) { return -o.qty; });
    gbToast('✅ 已取消');
  } catch (e) { gbToast(friendly(e)); }
  gbLoading(false);
}
/** 訂單與團購數量一起改：patchOf(訂單)→要寫進訂單的欄位；deltaOf(訂單)→已訂數量的增減 */
async function adjustOrder(cid, oid, patchOf, deltaOf) {
  var cRef = window.db.collection('gb_campaigns').doc(cid), oRef = window.db.collection('gb_orders').doc(oid);
  await gbTimeout(window.db.runTransaction(async function (t) {
    var cs = await t.get(cRef), os = await t.get(oRef);
    if (!cs.exists || !os.exists) throw new Error('找不到資料，請重新整理');
    var d = cs.data(), o = os.data();
    if (o.status !== 'active') throw new Error('這筆訂單已經是「' + (GB_ORDER_STATUS[o.status] || o.status) + '」，不能再改');
    if (!gbIsOwner(gbUser) && d.status !== 'open') throw new Error('已截單，只有加盟主可以改數量或取消');
    var p = patchOf(o), delta = deltaOf(o), now = d.ordered_qty || 0;
    if (p.qty != null && p.qty > (d.per_user_limit || 0)) throw new Error('超過每人上限 ' + d.per_user_limit + ' 份');
    if (delta > 0 && d.stock != null && now + delta > d.stock) throw new Error('庫存不足，只能再加 ' + Math.max(0, d.stock - now) + ' 份');
    var obs = Object.assign({}, d.ordered_by_store || {}); obs[o.store] = Math.max(0, (obs[o.store] || 0) + delta);
    p.updated_at = firebase.firestore.FieldValue.serverTimestamp();
    t.update(oRef, p);
    t.update(cRef, { ordered_qty: Math.max(0, now + delta), ordered_by_store: obs, updated_at: firebase.firestore.FieldValue.serverTimestamp() });
  }));
  await loadOrders(cid);
  await loadCampaigns();
}
