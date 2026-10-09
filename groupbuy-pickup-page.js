// 取貨名單（2026-10-10 第 1 階段）
// 列出「已成團」或「已到貨」團購中、該門市的訂單；員工與店長固定本店，加盟主／admin 可切換門市。
// 勾「已取貨」→ status: picked_up＋picked_up_at／picked_up_by；「已付款」→ paid: true；
// 過了取貨期限可標「棄單」→ status: no_show，有 LINE userId 的客人 gb_customers.no_show_count +1。
// 截單後員工只能改這幾個欄位（firestore.rules gbPickupOnly）。

var pkUser = null, pkCamps = [], pkOrders = [], pkView = 'todo';

window.onload = async function () {
  pkUser = await gbRequireUser();
  if (!pkUser) return;
  var my = gbCodeOf(pkUser.store);
  var sel = document.getElementById('pkStore');
  var opts = gbIsOwner(pkUser) ? GB_STORES : GB_STORES.filter(function (s) { return s.code === my; });
  if (!opts.length) { document.getElementById('pkList').innerHTML = '<div class="empty">找不到你的門市（' + gbEsc(pkUser.store || '') + '），請洽管理者</div>'; gbLoading(false); return; }
  sel.innerHTML = opts.map(function (s) { return '<option value="' + s.code + '"' + (s.code === my ? ' selected' : '') + '>' + s.name + '</option>'; }).join('');
  sel.disabled = opts.length <= 1;
  await loadPickup();
  gbLoading(false);
};

async function loadPickup() {
  var store = document.getElementById('pkStore').value;
  document.getElementById('pkList').innerHTML = '<div class="empty">載入中…</div>';
  try {
    var cs = await gbTimeout(window.db.collection('gb_campaigns').where('status', 'in', ['success', 'arrived']).get());
    pkCamps = cs.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (c) { return (c.available_stores || []).indexOf(store) >= 0; });
    // 每檔團購各查一次（campaign_id＋store 兩個等號條件，不需要複合索引；規則要求查詢帶門市）
    var all = await Promise.all(pkCamps.map(function (c) {
      return gbTimeout(window.db.collection('gb_orders').where('campaign_id', '==', c.id).where('store', '==', store).get())
        .then(function (sn) { return sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); });
    }));
    pkOrders = [].concat.apply([], all).filter(function (o) { return o.status !== 'cancelled'; });
  } catch (e) {
    document.getElementById('pkList').innerHTML = '<div class="empty">讀取失敗：' + gbEsc(e.message) + '</div>';
    return;
  }
  var cSel = document.getElementById('pkCamp'), keep = cSel.value;
  cSel.innerHTML = '<option value="">全部團購（' + pkCamps.length + '）</option>' + pkCamps.map(function (c) {
    return '<option value="' + c.id + '">' + gbEsc(c.title) + '・' + GB_STATUS[c.status] + '</option>';
  }).join('');
  if (pkCamps.some(function (c) { return c.id === keep; })) cSel.value = keep;
  renderPickup();
}

function campOf(o) { return pkCamps.find(function (c) { return c.id === o.campaign_id; }) || {}; }
function pastDeadline(c) { var d = gbToDate(c.pickup_deadline); return !!d && d.getTime() < Date.now(); }

function renderPickup() {
  var cid = document.getElementById('pkCamp').value;
  var kw = document.getElementById('pkSearch').value.trim().toLowerCase();
  var base = pkOrders.filter(function (o) { return (!cid || o.campaign_id === cid) && (!kw || String(o.display_name || '').toLowerCase().indexOf(kw) >= 0); });
  var todo = base.filter(function (o) { return o.status === 'active'; });
  var done = base.filter(function (o) { return o.status !== 'active'; });
  var unpaid = base.filter(function (o) { return o.status !== 'no_show' && !o.paid; });
  var views = [['todo', '待取貨', todo.length], ['unpaid', '未付款', unpaid.length], ['done', '已處理', done.length]];
  document.getElementById('pkChips').innerHTML = views.map(function (v) {
    return '<button class="chip' + (pkView === v[0] ? ' on' : '') + '" onclick="pkView=\'' + v[0] + '\';renderPickup()">' + v[1] + '<span class="n">' + v[2] + '</span></button>';
  }).join('');
  var amt = function (arr) { return arr.reduce(function (t, o) { return t + (o.qty || 0) * (campOf(o).price || 0); }, 0); };
  document.getElementById('pkSum').innerHTML =
    '<div><b>' + todo.length + '</b><span>待取貨（筆）</span></div>' +
    '<div><b>' + todo.reduce(function (t, o) { return t + (o.qty || 0); }, 0) + '</b><span>待取貨（份）</span></div>' +
    '<div><b>$' + amt(unpaid).toLocaleString() + '</b><span>未收款</span></div>';
  var list = pkView === 'todo' ? todo : pkView === 'unpaid' ? unpaid : done;
  list.sort(function (a, b) { return String(a.display_name || '').localeCompare(String(b.display_name || ''), 'zh-Hant'); });
  var el = document.getElementById('pkList');
  if (!pkCamps.length) { el.innerHTML = '<div class="empty">目前沒有「已成團」或「已到貨」的團購</div>'; return; }
  if (!list.length) { el.innerHTML = '<div class="empty">' + (kw ? '找不到「' + gbEsc(kw) + '」' : pkView === 'todo' ? '都取完了 🎉' : '沒有資料') + '</div>'; return; }
  el.innerHTML = list.map(pkCard).join('');
}

function pkCard(o) {
  var c = campOf(o), picked = o.status === 'picked_up', ns = o.status === 'no_show';
  var canNs = !picked && (ns || pastDeadline(c));
  return '<div class="pk' + (picked || ns ? ' done' : '') + '">' +
    '<div class="pk-top"><span class="pk-name">' + gbEsc(o.display_name) + '</span>' +
      (o.source === 'manual' ? '<span class="st st-draft">手動</span>' : '') +
      '<span class="pk-amt">$' + ((o.qty || 0) * (c.price || 0)).toLocaleString() + '</span></div>' +
    '<div class="pk-sub">' + gbEsc(c.title || '') + ' ×<b>' + (o.qty || 0) + '</b>' +
      (c.pickup_deadline ? '・取貨到 ' + gbFmt(c.pickup_deadline, false) + (pastDeadline(c) && !picked ? ' <b style="color:var(--danger)">已過期</b>' : '') : '') +
      (o.note ? '<br>備註：' + gbEsc(o.note) : '') +
      (picked ? '<br>✅ ' + gbFmt(o.picked_up_at) + ' 取貨' : '') + '</div>' +
    '<div class="pk-btns">' +
      '<button class="pk-btn' + (picked ? ' on-pick' : '') + '" ' + (ns ? 'disabled ' : '') + 'onclick="togglePicked(\'' + o.id + '\')">' + (picked ? '✅ 已取貨' : '取貨') + '</button>' +
      '<button class="pk-btn' + (o.paid ? ' on-paid' : '') + '" ' + (ns ? 'disabled ' : '') + 'onclick="togglePaid(\'' + o.id + '\')">' + (o.paid ? '💰 已付款' : '付款') + '</button>' +
      '<button class="pk-btn ns' + (ns ? ' on-ns' : '') + '" ' + (canNs ? '' : 'disabled title="過了取貨期限才能標棄單" ') + 'onclick="toggleNoShow(\'' + o.id + '\')">' + (ns ? '🚫 棄單' : '棄單') + '</button>' +
    '</div></div>';
}

function pkConfirm(title, text, yes) {
  return new Promise(function (resolve) {
    document.getElementById('cmTitle').textContent = title;
    document.getElementById('cmText').textContent = text;
    var y = document.getElementById('cmYes'), n = document.getElementById('cmNo');
    y.textContent = yes || '確定';
    y.onclick = function () { document.getElementById('confirmModal').hidden = true; resolve(true); };
    n.onclick = function () { document.getElementById('confirmModal').hidden = true; resolve(false); };
    document.getElementById('confirmModal').hidden = false;
  });
}
function orderById(id) { return pkOrders.find(function (o) { return o.id === id; }); }
async function patchOrder(o, upd, msg) {
  upd.updated_at = firebase.firestore.FieldValue.serverTimestamp();
  try {
    await gbTimeout(window.db.collection('gb_orders').doc(o.id).update(upd));
    Object.keys(upd).forEach(function (k) { if (k !== 'updated_at') o[k] = (upd[k] instanceof firebase.firestore.FieldValue) ? new Date() : upd[k]; });
    renderPickup();
    if (msg) gbToast(msg);
  } catch (e) { gbToast('更新失敗：' + (/permission/i.test(e.message) ? '沒有權限' : e.message)); }
}
async function togglePicked(id) {
  var o = orderById(id); if (!o) return;
  if (o.status === 'picked_up') {
    if (!await pkConfirm('取消取貨', '把 ' + o.display_name + ' 改回「待取貨」？', '改回待取貨')) return;
    return patchOrder(o, { status: 'active', picked_up_at: null, picked_up_by: null }, '已改回待取貨');
  }
  return patchOrder(o, { status: 'picked_up', picked_up_at: firebase.firestore.FieldValue.serverTimestamp(), picked_up_by: pkUser.uid }, '✅ ' + o.display_name + ' 已取貨');
}
async function togglePaid(id) {
  var o = orderById(id); if (!o) return;
  if (o.paid && !await pkConfirm('取消付款', '把 ' + o.display_name + ' 改回「未付款」？', '改回未付款')) return;
  return patchOrder(o, { paid: !o.paid }, o.paid ? '已改回未付款' : '💰 ' + o.display_name + ' 已付款');
}
async function toggleNoShow(id) {
  var o = orderById(id); if (!o) return;
  if (o.status === 'no_show') {
    if (!await pkConfirm('取消棄單', '把 ' + o.display_name + ' 改回「待取貨」？（棄單次數不會自動扣回）', '改回待取貨')) return;
    return patchOrder(o, { status: 'active', no_show_at: null, no_show_by: null }, '已改回待取貨');
  }
  if (!await pkConfirm('標記棄單', o.display_name + ' 超過取貨期限沒來取，標記為棄單？' + (o.line_user_id ? '\n這位客人的棄單次數會 +1。' : ''), '標記棄單')) return;
  await patchOrder(o, { status: 'no_show', no_show_at: firebase.firestore.FieldValue.serverTimestamp(), no_show_by: pkUser.uid }, '已標記棄單');
  if (o.line_user_id) {
    try {
      await gbTimeout(window.db.collection('gb_customers').doc(o.line_user_id).set({
        no_show_count: firebase.firestore.FieldValue.increment(1), last_no_show_at: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }));
    } catch (e) { gbToast('棄單已標記，但客人棄單次數沒加到：' + e.message); }
  }
}
