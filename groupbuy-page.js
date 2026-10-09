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
  gbCanCreate = gbIsOwner(gbUser) || (gbIsManager(gbUser) && !!gbMyCode);
  if (gbIsOwner(gbUser)) document.getElementById('tabSet').hidden = false;
  gbEnsureStoreSettings(gbUser);
  // 舊取貨名單網址（groupbuy-pickup.html）轉過來會帶 ?tab=pick；其他一律先開〔團購〕（使用者 2026-10-10）
  var t = new URLSearchParams(location.search).get('tab');
  await gbSetTab(t === 'pick' ? 'pick' : 'camp');
  gbLoading(false);
};
var gbCanCreate = false, gbCampLoaded = false;
async function gbSetTab(t) {
  if (t === 'set' && !gbIsOwner(gbUser)) t = 'camp';
  [['camp', 'secCamp', 'tabCamp'], ['pick', 'secPick', 'tabPick'], ['set', 'secSet', 'tabSet']].forEach(function (x) {
    var on = x[0] === t;
    document.getElementById(x[1]).hidden = !on;
    document.getElementById(x[2]).classList.toggle('on', on); document.getElementById(x[2]).setAttribute('aria-selected', String(on));
  });
  document.getElementById('newBtn').hidden = t !== 'camp' || !gbCanCreate;
  if (t === 'pick') await pkInit(gbUser);
  else if (t === 'set') await loadLiffSettings();
  else if (!gbCampLoaded) { gbCampLoaded = true; await loadCampaigns(); }
}

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
  // 第 3 階段（2026-10-10）：結算、標記到貨、文案
  if (canEdit(c)) {
    if (isDue(c) || c.status === 'closed') btns += '<button class="btn btn-p" style="background:#d93025;" onclick="settleCampaign(\'' + c.id + '\')">⚖️ 結算</button>';
    if (c.status === 'success') btns += '<button class="btn btn-p" style="background:#6d28d9;" onclick="markArrived(\'' + c.id + '\')">📦 標記到貨</button>';
  }
  if (['open', 'success', 'arrived'].indexOf(c.status) >= 0 && (canEdit(c) || gbIsManager(gbUser))) {
    btns += '<button class="btn btn-g" onclick="openCopy(\'' + c.id + '\',\'' + (c.status === 'open' ? 'open' : c.status === 'success' ? 'success' : 'arrived') + '\')">📝 ' + (c.status === 'open' ? '開團文案' : c.status === 'success' ? '成團文案' : '取貨通知') + '</button>';
  }
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
  document.getElementById('cfFile').value = ''; document.getElementById('cfUpMsg').textContent = ''; syncPreview();
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


// ===== 第 3 階段：結算與文案（2026-10-10）=====
// 結算：保證成團 → 直接成團；達標成團 → 三店合計（ordered_qty，已扣掉取消）≥ 最低成團數才成團，否則流局（流局不產生文案、不通知）。
// 文案一律「可編輯＋複製」，由小編自己貼回門市群組（規格書：機器人不主動推播）。
async function settleCampaign(cid) {
  var c = gbCamps.find(function (x) { return x.id === cid; }); if (!c || !canEdit(c)) return;
  var total = c.ordered_qty || 0;
  var success = c.success_rule !== 'threshold' || total >= (c.min_qty || 0);
  var why = c.success_rule === 'threshold' ? '達標成團：三店合計 ' + total + ' 份，最低 ' + c.min_qty + ' 份 → ' + (success ? '達標' : '未達標') : '保證成團：三店合計 ' + total + ' 份';
  var ok = await gbConfirm('結算「' + c.title + '」', why + '\n\n結算後狀態會改為「' + (success ? '已成團' : '已流局') + '」' + (success ? '，接著可以複製成團文案貼到群組。' : '，不會產生文案。'), success ? '確定成團' : '確定流局');
  if (!ok) return;
  gbLoading(true, '結算中…');
  try {
    await gbTimeout(window.db.collection('gb_campaigns').doc(cid).update({ status: success ? 'success' : 'failed', settled_by: gbUser.uid, settled_at: firebase.firestore.FieldValue.serverTimestamp(), updated_at: firebase.firestore.FieldValue.serverTimestamp() }));
    await loadCampaigns();
    gbLoading(false);
    if (success) openCopy(cid, 'success'); else gbToast('已流局（未達最低成團數），不產生文案');
  } catch (e) { gbLoading(false); gbToast('結算失敗：' + friendly(e)); }
}
async function markArrived(cid) {
  var c = gbCamps.find(function (x) { return x.id === cid; }); if (!c || !canEdit(c)) return;
  if (!await gbConfirm('標記到貨', '「' + c.title + '」已經到貨？標記後可以複製取貨通知貼到群組。', '已到貨')) return;
  gbLoading(true, '更新中…');
  try {
    var upd = { status: 'arrived', arrived_at: firebase.firestore.FieldValue.serverTimestamp(), updated_at: firebase.firestore.FieldValue.serverTimestamp() };
    // 沒設取貨期限 → 預設到貨後 3 天（使用者 2026-10-10 照建議）
    if (!c.pickup_deadline) upd.pickup_deadline = firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 3 * 86400000));
    await gbTimeout(window.db.collection('gb_campaigns').doc(cid).update(upd));
    await loadCampaigns();
    gbLoading(false);
    openCopy(cid, 'arrived');
  } catch (e) { gbLoading(false); gbToast('更新失敗：' + friendly(e)); }
}

// ---- 文案 ----
var gbCopyCtx = null;
async function openCopy(cid, kind) {
  var c = gbCamps.find(function (x) { return x.id === cid; }); if (!c) return;
  var owner = gbIsOwner(gbUser);
  var stores = owner ? (c.available_stores || []) : [gbMyCode];
  gbCopyCtx = { c: c, kind: kind, stores: stores };
  var sel = document.getElementById('cpStore');
  // 加盟主可選「三店合併」或單店；店長只有本店
  sel.innerHTML = (owner && stores.length > 1 ? '<option value="">三店合併</option>' : '') + stores.map(function (s) { return '<option value="' + s + '">' + gbStoreName(s) + '</option>'; }).join('');
  document.getElementById('cpTitle').textContent = { open: '📝 開團文案', success: '🎉 成團文案', arrived: '📦 取貨通知' }[kind];
  document.getElementById('cpNamesWrap').hidden = kind !== 'arrived';
  document.getElementById('cpNames').checked = false;
  openModal('copyModal');
  await buildCopy();
}
async function gbLiffLinks() {
  try { var s = await window.db.collection('gb_settings').doc('liff').get(); var id = s.exists ? (s.data().liff_id || '') : ''; return id; } catch (e) { return ''; }
}
async function buildCopy() {
  var x = gbCopyCtx; if (!x) return;
  var c = x.c, st = document.getElementById('cpStore').value, obs = c.ordered_by_store || {};
  var qty = st ? (obs[st] || 0) : (c.ordered_qty || 0);
  var where = st ? gbStoreName(st) : x.stores.map(gbStoreName).join('・');
  var lines = [];
  if (x.kind === 'open') {
    var liffId = await gbLiffLinks();
    lines.push('🛒【團購開跑】' + c.title, '💰 $' + c.price + '／份' + (c.per_user_limit ? '・每人限 ' + c.per_user_limit + ' 份' : ''));
    if (c.description) lines.push(c.description);
    lines.push('⏰ ' + gbFmt(c.end_time) + ' 截單' + (c.arrival_date ? '・預計 ' + gbFmt(c.arrival_date, false) + ' 到貨' : ''));
    if (c.success_rule === 'threshold') lines.push('🎯 三店合計滿 ' + c.min_qty + ' 份成團');
    if (st && liffId) lines.push('', '👉 點這裡 +1：https://liff.line.me/' + liffId + '?store=' + st);
    else if (!st && liffId) x.stores.forEach(function (s) { lines.push(gbStoreName(s) + ' +1：https://liff.line.me/' + liffId + '?store=' + s); });
    else lines.push('', '要的朋友請在群組留言「+1」或私訊小編 🙌');
  } else if (x.kind === 'success') {
    lines.push('🎉【團購成團】' + c.title, '感謝大家支持！' + (st ? where + '共 ' + qty + ' 份' : '三店共 ' + qty + ' 份（' + x.stores.map(function (s) { return gbStoreName(s) + ' ' + (obs[s] || 0); }).join('・') + '）'));
    lines.push('📦 預計到貨：' + (c.arrival_date ? gbFmt(c.arrival_date, false) : '到貨日確定後通知'), '到貨後會再通知取貨，到店付款 $' + c.price + '／份');
  } else {
    lines.push('📦【到貨通知】' + c.title + ' 到貨囉！', '請在 ' + (c.pickup_deadline ? gbFmt(c.pickup_deadline, false) : '3 天內') + ' 前到' + where + '門市取貨，到店付款 $' + c.price + '／份');
    if (document.getElementById('cpNames').checked && st) {
      try {
        var sn = await gbTimeout(window.db.collection('gb_orders').where('campaign_id', '==', c.id).where('store', '==', st).get());
        var os = sn.docs.map(function (d) { return d.data(); }).filter(function (o) { return o.status === 'active'; });
        if (os.length) { lines.push('', '取貨名單：'); os.forEach(function (o) { lines.push('・' + o.display_name + ' ×' + o.qty); }); }
      } catch (e) { lines.push('', '（取貨名單讀取失敗）'); }
    } else if (document.getElementById('cpNames').checked) { lines.push('', '（取貨名單請選單一門市）'); }
  }
  document.getElementById('cpText').value = lines.join('\n');
}
async function copyText() {
  var t = document.getElementById('cpText');
  try { await navigator.clipboard.writeText(t.value); gbToast('✅ 已複製，貼到門市群組就好'); }
  catch (e) { t.focus(); t.select(); try { document.execCommand('copy'); gbToast('✅ 已複製'); } catch (e2) { gbToast('請長按文字框自行複製'); } }
}


// ===== 團購設定（2026-10-10）：LIFF ID／Channel ID 存 gb_settings/liff，三店下單連結＋QR Code =====
// gb_settings/liff 開放未登入讀取（LIFF 客人頁要拿 liff_id 初始化；兩個值都不是密碼），只有加盟主／admin 能寫。
async function loadLiffSettings() {
  var d = {};
  try { var s = await gbTimeout(window.db.collection('gb_settings').doc('liff').get()); if (s.exists) d = s.data(); } catch (e) {}
  document.getElementById('stLiff').value = d.liff_id || '';
  document.getElementById('stChannel').value = d.channel_id || '';
  renderLiffLinks(d.liff_id || '');
}
async function saveLiffSettings() {
  var err = document.getElementById('stErr'); err.textContent = '';
  var liff = document.getElementById('stLiff').value.trim(), ch = document.getElementById('stChannel').value.trim();
  if (liff && !/^\d{6,}-[A-Za-z0-9]{4,}$/.test(liff)) return err.textContent = 'LIFF ID 格式應該像 1234567890-AbCdEfGh';
  if (ch && !/^\d{6,15}$/.test(ch)) return err.textContent = 'Channel ID 應該是一串數字';
  if (/secret/i.test(liff + ch)) return err.textContent = '不要貼 Channel Secret';
  try {
    await gbTimeout(window.db.collection('gb_settings').doc('liff').set({ liff_id: liff, channel_id: ch, updated_by: gbUser.uid, updated_at: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }));
    gbToast('✅ 已儲存');
    renderLiffLinks(liff);
  } catch (e) { err.textContent = '儲存失敗：' + friendly(e); }
}
function loadQrLib() {
  if (window.qrcode) return Promise.resolve();
  return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js'; s.onload = res; s.onerror = function () { rej(new Error('QR Code 元件載入失敗')); }; document.head.appendChild(s); });
}
async function renderLiffLinks(liffId) {
  var el = document.getElementById('stLinks');
  if (!liffId) { el.innerHTML = '<div class="empty">儲存 LIFF ID 後，這裡會出現三家店的下單連結與 QR Code</div>'; return; }
  try { await loadQrLib(); } catch (e) {}
  el.innerHTML = '<div style="font-size:15px;font-weight:900;margin-bottom:8px;">門市下單連結</div><div style="font-size:12.5px;color:var(--muted);margin-bottom:8px;">貼到各門市客人群組；客人點開就能 +1，不用另外登入。</div>' +
    GB_STORES.map(function (s) {
      var url = 'https://liff.line.me/' + liffId + '?store=' + s.code, qr = '';
      if (window.qrcode) { try { var q = qrcode(0, 'M'); q.addData(url); q.make(); qr = q.createSvgTag({ cellSize: 3, margin: 2, scalable: true }); } catch (e) {} }
      return '<div class="orow" style="align-items:center;"><div style="width:84px;height:84px;flex:none;">' + qr + '</div><div style="flex:1;min-width:0;"><b style="font-size:15px;">' + s.name + '</b><div style="font-size:12px;color:var(--muted);word-break:break-all;">' + gbEsc(url) + '</div></div><button class="mini" onclick="copyLink(\'' + url + '\')">複製</button></div>';
    }).join('');
}
async function copyLink(url) {
  try { await navigator.clipboard.writeText(url); gbToast('✅ 已複製連結'); } catch (e) { gbToast(url); }
}

// ===== 商品圖片上傳（2026-10-10）=====
// 存在 store-schedule-3b056-city 這個 bucket 的 gb/ 資料夾（storage.rules：登入者可上傳 5MB 以內的圖片，其他一律不可讀寫），
// 顯示用下載權杖網址（不經規則；LIFF 客人頁也看得到）。上傳前先在手機上縮到長邊 1280px、JPEG 0.85，省流量也省空間。
var GB_BUCKET = 'gs://store-schedule-3b056-city';
function syncPreview() {
  var v = document.getElementById('cfImage').value.trim(), p = document.getElementById('cfPreview');
  p.style.backgroundImage = /^https:\/\//.test(v) ? "url('" + v.replace(/'/g, '%27') + "')" : '';
}
function shrinkImage(file) {
  return new Promise(function (res, rej) {
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var max = 1280, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
      var cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob(function (b) { b ? res(b) : rej(new Error('圖片轉檔失敗')); }, 'image/jpeg', 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('讀不到這張圖片，請換一張')); };
    img.src = url;
  });
}
async function uploadCampImage(file) {
  var msg = document.getElementById('cfUpMsg'), save = document.getElementById('cfSave');
  if (!file) return;
  if (!/^image\//.test(file.type)) { msg.textContent = '請選圖片檔'; return; }
  save.disabled = true; msg.textContent = '處理中…';
  try {
    var blob = await shrinkImage(file);
    if (blob.size > 5 * 1024 * 1024) throw new Error('圖片太大（超過 5MB）');
    var d = new Date(), ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
    var ref = firebase.app().storage(GB_BUCKET).ref('gb/' + ym + '/' + Date.now() + '_' + gbRand(6) + '.jpg');
    var task = ref.put(blob, { contentType: 'image/jpeg' });
    task.on('state_changed', function (sn) { msg.textContent = '上傳中 ' + Math.round(sn.bytesTransferred / sn.totalBytes * 100) + '%'; });
    await gbTimeout(task, 60000, '上傳逾時，請確認網路後再試');
    var url = await ref.getDownloadURL();
    document.getElementById('cfImage').value = url; syncPreview();
    msg.textContent = '✅ 已上傳';
  } catch (e) { msg.textContent = '上傳失敗：' + (e.message || e); }
  save.disabled = false;
}
