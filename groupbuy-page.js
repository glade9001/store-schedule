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
  if (gbUser.gbPreview) {
    var pb = document.createElement('div');
    pb.style.cssText = 'background:#fff3e0;color:#b45309;font-size:13px;font-weight:800;padding:8px 14px;text-align:center;line-height:1.5;';
    pb.textContent = '🎭 角色預覽：' + ({ employee: '員工', manager: '店長', owner: '加盟主' }[gbUser.permission] || gbUser.permission) + '（' + (gbUser.store || '未設門市') + '）・按鈕會真的寫入資料，請只看不按；回首頁可恢復身分';
    document.querySelector('.header').after(pb);
  }
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
  else if (!gbCampLoaded) { gbCampLoaded = true; await loadCampaigns(); loadPending(); }
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
// 標題列「🛍️ 下單頁」（2026-10-10 使用者）：快速打開客人看到的下單頁；有門市就直接帶本店
function gbLiffUrl() { return 'https://glade9001.github.io/store-schedule/liff.html' + (gbMyCode ? '?store=' + encodeURIComponent(gbMyCode) : ''); }
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
  // 置頂的開放中／草稿團排在同一類最前面
  var rank = function (c) { return isDue(c) ? 0 : c.status === 'open' ? 1 : c.status === 'draft' ? 2 : 3; };
  list.sort(function (a, b) {
    var r = rank(a) - rank(b); if (r) return r;
    var pa = gbIsPinned(a, gbCamps), pb = gbIsPinned(b, gbCamps); if (pa !== pb) return pa ? -1 : 1;
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
  var rule = (c.success_rule === 'threshold' ? '達標成團（' + (c.min_qty || 0) + '）' : '保證成團') + (c.auto_next ? '・額滿自動開下一團' : '');
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
  if (c.status === 'failed' && (c.ordered_qty || 0) > 0 && (canEdit(c) || gbIsManager(gbUser))) {
    btns += '<button class="btn btn-g" onclick="openCopy(\'' + c.id + '\',\'failed\')">📝 流局文案</button>';
  }
  if (['open', 'success', 'arrived'].indexOf(c.status) >= 0 && (canEdit(c) || gbIsManager(gbUser))) {
    btns += '<button class="btn btn-g" onclick="openCopy(\'' + c.id + '\',\'' + (c.status === 'open' ? 'open' : c.status === 'success' ? 'success' : 'arrived') + '\')">📝 ' + (c.status === 'open' ? '開團文案' : c.status === 'success' ? '成團文案' : '取貨通知') + '</button>';
  }
  if (gbIsOwner(gbUser) && c.status !== 'open') btns += '<button class="btn btn-g" style="color:#d93025;" onclick="deleteCampaign(\'' + c.id + '\')">🗑 刪除</button>';
  if (canEdit(c) && (c.status === 'open' || c.status === 'draft')) {
    btns += '<button class="btn btn-g" onclick="togglePin(\'' + c.id + '\')">' + (gbIsPinned(c, gbCamps) ? '取消置頂' : '📌 置頂') + '</button>';
  }
  if (canEdit(c)) {
    btns += '<button class="btn btn-o" onclick="openCampaignForm(\'' + c.id + '\')">編輯</button>';
    btns += '<select class="inline" aria-label="切換狀態" onchange="changeStatus(\'' + c.id + '\',this.value);this.value=\'\'"><option value="">切換狀態…</option>' +
      GB_STATUS_ORDER.filter(function (s) { return s !== c.status; }).map(function (s) { return '<option value="' + s + '">改為「' + GB_STATUS[s] + '」</option>'; }).join('') + '</select>';
  }
  return '<div class="card" id="camp-' + c.id + '"><div class="camp">' +
    (imgOk ? '<div class="camp-img" style="background-image:url(\'' + gbEsc(img).replace(/'/g, '%27') + '\')"></div>' : '<div class="camp-img" aria-hidden="true"></div>') +
    '<div class="camp-body">' +
      '<span class="st st-' + c.status + '">' + (GB_STATUS[c.status] || c.status) + '</span>' + (isDue(c) ? ' <span class="st st-due">待結算</span>' : '') + (c.is_test ? ' <span class="st" style="background:#ede9fe;color:#6d28d9;">🧪 測試團</span>' : '') +
        (gbIsPinned(c, gbCamps) && (c.status === 'open' || c.status === 'draft') ? ' <span class="st" style="background:#fff3e0;color:#b45309;">📌 置頂</span>' : '') +
      '<div class="camp-title">' + gbEsc(c.title) + '</div>' +
      ((c.bundles || []).length ? '<div class="camp-meta">' + c.bundles.map(function (b) { return gbEsc(b.code + ' ' + b.label) + ' $' + b.mult * c.price + (b.mult > 1 ? '（' + b.mult + ' 份）' : ''); }).join('・') + '</div>' : '') +
      '<div class="camp-meta"><b>$' + (c.price || 0) + '</b>・' + (gbNoLimit(c) ? '每人不限' : '每人上限 ' + c.per_user_limit) + '・' + rule + '・' + stock + '</div>' +
      '<div class="camp-meta">截單 ' + gbFmt(c.end_time) + (c.status === 'open' ? '（' + gbCountdown(c.end_time) + '）' : '') +
        (c.arrival_date ? '・到貨 ' + gbFmt(c.arrival_date, false) : '') + (c.pickup_deadline ? '・取貨到 ' + gbFmt(c.pickup_deadline, false) : '') + '</div>' +
      (c.purged_at ? '<div class="camp-meta" style="color:#94a3b8;">🔒 訂單已於 ' + gbFmt(c.purged_at, false) + ' 依隱私權政策刪除（結案滿 2 個月）</div>' : '') +
      '<div class="stores">' + stores + '<span class="store-qty">合計<b>' + (c.ordered_qty || 0) + '</b></span></div>' + prog +
    '</div></div>' +
    '<div class="actions">' + btns + '</div>' +
    (gbOpen[c.id] ? '<div class="orders" id="orders-' + c.id + '">' + ordersHtml(c) + '</div>' : '') +
  '</div>';
}

// 置頂（2026-10-10 使用者）：客人下單頁、首頁卡片、這裡的列表都排最前面；多規格／同系列整組一起切
async function togglePin(cid) {
  var c = gbCamps.find(function (x) { return x.id === cid; }); if (!c || !canEdit(c)) return;
  var on = !gbIsPinned(c, gbCamps), k = gbPinKey(c);
  var group = gbCamps.filter(function (o) { return gbPinKey(o) === k; });
  try {
    var b = window.db.batch();
    group.forEach(function (o) { b.update(window.db.collection('gb_campaigns').doc(o.id), { pinned: on, updated_at: firebase.firestore.FieldValue.serverTimestamp() }); });
    await gbTimeout(b.commit());
    group.forEach(function (o) { o.pinned = on; });
    gbToast(on ? '📌 已置頂，客人下單頁會排在最前面' : '已取消置頂');
    render();
  } catch (e) { gbToast('更新失敗：' + friendly(e)); }
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
    await gbLoadNoShow(gbOrders[cid]);
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
    '<span class="nm">' + gbEsc(o.display_name) + '</span>' + gbNoShowTag(o) + '<span class="q">×' + (o.qty || 0) + '</span>' +
    '<span class="st st-' + (o.status === 'active' ? 'open' : o.status === 'picked_up' ? 'success' : o.status === 'no_show' ? 'failed' : 'draft') + '">' + (GB_ORDER_STATUS[o.status] || o.status) + '</span>' +
    (o.paid ? '<span class="st st-success">已付款</span>' : '') +
    '<span class="sub">' + (gbPhoneHtml(o) ? gbPhoneHtml(o) + '・' : '') + (GB_SOURCE[o.source] || o.source || '') + (o.created_by_name ? '・' + gbEsc(o.created_by_name) : '') + '・' + gbFmt(o.created_at) + (o.note ? '・' + gbEsc(o.note) : '') + '</span>' +
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
  // 多規格（2026-10-11）：編輯其中一種＝整組一起編輯；共同欄位存到每一種，品名存 base_title
  gbOptRows = c && c.opt_group ? optMembers(c.opt_group).map(function (m) { return { id: m.id, code: m.opt_code, label: m.opt_label || '', price: m.price || '' }; })
    : c && (c.bundles || []).length ? c.bundles.map(function (b) { return { code: b.code, label: b.label, price: b.mult * c.price, kept: true }; }) : [];
  setOptMode(c && c.opt_group ? 'split' : 'merge');
  document.querySelectorAll('input[name=cfOptMode]').forEach(function (r) { r.disabled = !!c; });   // 已建立的團不能切換計算方式
  document.getElementById('cfMulti').checked = gbOptRows.length > 0;
  document.getElementById('cfMulti').disabled = !!c;
  document.getElementById('cfPasteWrap').hidden = !!c;   // 只在開新團時用
  document.getElementById('cfPaste').value = ''; document.getElementById('cfPasteMsg').textContent = '';   // 已建立的團不能切換單一／多規格
  document.getElementById('cfTitle').value = c ? (c.opt_group || (c.bundles || []).length ? c.base_title || '' : c.title || '') : '';
  document.getElementById('cfDesc').value = c ? c.description || '' : '';
  document.getElementById('cfPrice').value = c ? c.price || '' : '';
  document.getElementById('cfLimit').value = c && !gbNoLimit(c) ? c.per_user_limit : '';
  gbImgs = c ? (c.images || []).slice(0, GB_MAX_IMGS) : []; document.getElementById('cfImage').value = ''; renderImgs();
  document.getElementById('cfFile').value = ''; document.getElementById('cfUpMsg').textContent = '';
  document.getElementById('cfStock').value = c && c.stock != null ? c.stock : '';
  document.getElementById('cfEnd').value = c ? gbInputDateTime(c.end_time) : '';
  document.getElementById('cfArrival').value = c ? gbInputDate(c.arrival_date) : '';
  document.getElementById('cfPickup').value = c ? gbInputDate(c.pickup_deadline) : '';
  document.getElementById('cfMin').value = c && c.min_qty ? c.min_qty : '';
  document.getElementById('cfTest').checked = !!(c && c.is_test);
  document.getElementById('cfAutoNext').checked = !!(c && c.auto_next);
  var rule = c ? c.success_rule || 'guaranteed' : 'guaranteed';
  document.querySelectorAll('input[name=cfRule]').forEach(function (r) { r.checked = r.value === rule; });
  var sel = c ? (c.available_stores || []) : (owner ? GB_STORES.map(function (s) { return s.code; }) : [gbMyCode]);
  document.getElementById('cfStores').innerHTML = GB_STORES.map(function (s) {
    var dis = !owner && s.code !== gbMyCode;
    return '<label' + (dis ? ' style="opacity:.45"' : '') + '><input type="checkbox" value="' + s.code + '"' + (sel.indexOf(s.code) >= 0 ? ' checked' : '') + (owner ? '' : ' disabled') + '> ' + s.name + '</label>';
  }).join('');
  document.getElementById('cfErr').textContent = '';
  syncRule(); syncMulti();
  openModal('campModal');
}
// ---- 貼上總部文案自動填表（2026-10-11）----
// 純規則解析（不用 AI）：總部格式大致固定，遇到抓錯的格式再補規則。
var GB_EMOJI_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
/** LINE 表情貼複製出來會變成 (one)(seven)(five)、(警告)、(+)，還有康熙部首字（⼝⼈⾊）→ 轉回正常文字 */
function gbCleanHq(t) {
  return String(t || '')
    .replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, function (ch) { return ch.normalize('NFKC'); })
    .replace(/\((zero|one|two|three|four|five|six|seven|eight|nine)\)/gi, function (_, w) { return String(GB_EMOJI_NUM[w.toLowerCase()]); })
    .replace(/\(([0-9])\)/g, '$1')
    .replace(/\(\+\)/g, '+')
    .replace(/\(:\)\)|\(:\(\)/g, '')
    .replace(/\([\u4e00-\u9fff]{1,4}\)/g, '')
    // (toilet)(loud volume)(Moon Smile) 這類英文表情代碼（要有小寫字母）；(A) 單字母是規格編號、(USB) 全大寫縮寫，不刪
    .replace(/\((?=[^)]*[a-z])[A-Za-z][A-Za-z0-9 '’&_-]{1,29}\)/g, '')
    .replace(/^[ \t\u3000]+/gm, '').replace(/[ \t\u3000]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n');
}
function gbPriceIn(line) {
  var m = line.match(/(\d[\d,]*)\s*元/) || line.match(/\$\s*(\d[\d,]*)/) || line.match(/(?:NT|價)\s*\$?\s*(\d[\d,]*)/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
/** 單一規格時挑售價：「組合價／團購價／特價」優先，「均價／原價／單瓶」這類參考價最後才用 */
function gbPickPrice(lines) {
  var best = null, bestScore = -9;
  lines.forEach(function (l) {
    var p = gbPriceIn(l); if (p == null) return;
    var sc = /組合價|團購價|團購|優惠價|特價|售價|只要|下殺|價/.test(l) ? 1 : 0;
    if (/均價|平均|原價|市價|建議售價|定價|單[瓶包罐盒入顆支片條件]|每[瓶包罐盒入顆支片條件]|省下?\s*\$?\d/.test(l)) sc = -1;
    if (sc > bestScore) { best = p; bestScore = sc; }
  });
  return best;
}
/** 文案最後常有「品名+1」給大家照著留言 → 當品名用，並從說明拿掉 */
var GB_HQ_PLUS_RE = /^(.{2,40}?)\s*[+＋]\s*\d{1,2}$/;
/** 回傳 { text, title, price, options:[{code,label,price}], end: Date|null }（end 目前沒用：截單由使用者自己填） */
function gbParseHq(raw) {
  var text = gbCleanHq(raw).trim();
  var lines = text.split(/\n/).map(function (l) { return l.trim(); });
  var plusLine = lines.filter(function (l) { return GB_HQ_PLUS_RE.test(l) && !/^[(（\[]?[A-Ja-j][)）\]]?\s*[+＋]/.test(l); }).pop();
  if (plusLine) {
    text = text.split(/\n/).filter(function (l) { return l.trim() !== plusLine; }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    lines = lines.filter(function (l) { return l !== plusLine; });
  }
  var title = plusLine ? plusLine.match(GB_HQ_PLUS_RE)[1] : (lines.find(function (l) { return l; }) || '');
  title = title.replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]+/gu, '')
    .replace(/^[\s－\-–—•・★☆◆◇▶►※]+/, '').replace(/\s{2,}/g, ' ').trim();
  // 規格：(A) 開頭的行，價格在同一行或後面幾行
  var options = [], cur = null;
  lines.forEach(function (l) {
    var m = l.match(/^[(（\[]\s*([A-Ja-j])\s*[)）\]]\s*(.*)$/) || l.match(/^([A-Ja-j])[.、:：]\s*(.+)$/);
    if (m) { cur = { code: m[1].toUpperCase(), label: m[2].replace(/(只要|特價|售價)?\s*\$?\d[\d,]*\s*元.*$/, '').trim(), price: gbPriceIn(m[2]) }; options.push(cur); return; }
    if (!cur) return;
    if (!l) { if (cur.label && cur.price) cur = null; return; }
    if (cur.price == null && gbPriceIn(l) != null) { cur.price = gbPriceIn(l); return; }
    if (!cur.label) cur.label = l;
  });
  options = options.filter(function (o) { return o.label || o.price; });
  var price = null;
  if (!options.length) price = gbPickPrice(lines);
  // 截單：「期間／截止／截單／到」那一行的最後一個日期，晚上 10 點
  var end = null, now = new Date();
  var hay = '';
  for (var li = 0; li < lines.length && !hay; li++) {
    if (!/期間|截止|截單|預購|到期/.test(lines[li])) continue;
    var h2 = lines[li] + ' ' + (lines[li + 1] || '');   // 「優惠期間：」的日期常在下一行
    if (/\d{1,2}[\/.\-月]\d{1,2}/.test(h2)) hay = h2;
  }
  var ds = [], re = /(?:(\d{4})[\/.\-年])?(\d{1,2})[\/.\-月](\d{1,2})/g, m2, lastY = null;
  while ((m2 = re.exec(hay))) { if (m2[1]) lastY = Number(m2[1]); ds.push({ y: m2[1] ? Number(m2[1]) : lastY, mo: Number(m2[2]), d: Number(m2[3]) }); }
  if (ds.length) {
    var e = ds[ds.length - 1], y = e.y || now.getFullYear();
    if (!e.y && e.mo < now.getMonth() + 1 - 6) y++;   // 沒寫年份、月份比現在早很多 → 明年
    end = new Date(y, e.mo - 1, e.d, 22, 0);
  }
  return { text: text, title: title, price: price, options: options, end: end };
}
function applyHqPaste() {
  var raw = document.getElementById('cfPaste').value, msg = document.getElementById('cfPasteMsg');
  if (!raw.trim()) { msg.textContent = '請先貼上文案'; return; }
  var r = gbParseHq(raw), got = [];
  if (r.title) { document.getElementById('cfTitle').value = r.title.slice(0, 60); got.push('品名'); }
  document.getElementById('cfDesc').value = r.text.slice(0, 600); got.push('說明');
  if (r.options.length >= 2) {
    document.getElementById('cfMulti').checked = true;
    gbOptRows = r.options.slice(0, GB_OPT_CODES.length).map(function (o, i) { return { code: GB_OPT_CODES[i], label: o.label || '', price: o.price || '' }; });
    syncMulti();
    var bs = gbBundlesOf(gbOptRows);   // 價格成比例 → 預設合併成一檔
    setOptMode(typeof bs === 'string' ? 'split' : 'merge');
    got.push(r.options.length + ' 種規格（' + (typeof bs === 'string' ? '價格不成比例，分開計算' : '價格成比例，合併成一檔') + '）');
  } else {
    var p0 = r.options.length ? r.options[0].price : r.price;
    document.getElementById('cfMulti').checked = false; gbOptRows = []; syncMulti();
    if (p0) { document.getElementById('cfPrice').value = p0; got.push('價格'); }
  }
  // 截單時間由使用者自己填（2026-10-11 使用者決定；總部的「優惠期間」不一定等於截單）
  msg.textContent = '✅ 已填入：' + got.join('、') + '。' + (r.text.length > 600 ? '說明超過 600 字已截斷，' : '') + '⏰ 截單時間請自己填，圖片要另外上傳。';
}
// ---- 多規格 ----
var gbOptRows = [];
var GB_OPT_CODES = 'ABCDEFGHIJ';
/** 同一組的各規格（只取第 1 團；額滿自動開的第 2 團以後不算） */
function optMembers(group) {
  return gbCamps.filter(function (x) { return x.opt_group === group && !(x.round > 1); })
    .sort(function (a, b) { return String(a.opt_code).localeCompare(String(b.opt_code)); });
}
function optMode() { var r = document.querySelector('input[name=cfOptMode]:checked'); return r ? r.value : 'merge'; }
function setOptMode(m) { document.querySelectorAll('input[name=cfOptMode]').forEach(function (r) { r.checked = r.value === m; }); syncOptHint(); }
function syncOptHint() {
  document.getElementById('cfOptHint').textContent = optMode() === 'merge'
    ? '價格成比例時用（例：10包 $175、30包 $525）：最便宜的那種算 1 份，B+1 自動記成 3 份；名單、成團數、庫存都看總份數'
    : '每一種各開一檔，庫存、每人上限、成團數各自計算（價格不成比例時用，例如買多有折扣）';
}
/** 合併成一檔：最便宜的規格＝1 份，其他規格的價格要是它的整數倍 → 回傳 { unit, bundles } 或錯誤字串 */
function gbBundlesOf(rows) {
  var base = rows.reduce(function (m, o) { return Number(o.price) < Number(m.price) ? o : m; }, rows[0]);
  var unit = Number(base.price), out = [];
  for (var i = 0; i < rows.length; i++) {
    var p = Number(rows[i].price);
    if (p % unit) return '規格 ' + rows[i].code + ' 的價格 $' + p + ' 不是 $' + unit + ' 的整數倍，不能合併成一檔，請改用「分開計算」';
    out.push({ code: rows[i].code, label: rows[i].label, mult: p / unit });
  }
  return { unit: unit, unitLabel: base.label, bundles: out };
}
function syncMulti() {
  var on = document.getElementById('cfMulti').checked;
  if (on && !gbOptRows.length) gbOptRows = [{ code: 'A', label: '', price: '' }, { code: 'B', label: '', price: '' }];
  document.getElementById('cfOptsWrap').hidden = !on;
  document.getElementById('cfPriceWrap').hidden = on;
  document.getElementById('cfPrice').required = !on;
  renderOptRows();
}
function readOptRows() {
  document.querySelectorAll('#cfOpts .opt-row').forEach(function (r, i) {
    if (!gbOptRows[i]) return;
    gbOptRows[i].label = r.querySelector('.ol').value.trim();
    gbOptRows[i].price = r.querySelector('.op').value.trim();
  });
}
function renderOptRows() {
  document.getElementById('cfOpts').innerHTML = gbOptRows.map(function (o, i) {
    return '<div class="opt-row"><b>' + o.code + '</b><input class="ol" placeholder="規格，例：10包" maxlength="30" value="' + gbEsc(o.label) + '">' +
      '<input class="op" type="number" inputmode="numeric" min="1" step="1" placeholder="價格" value="' + gbEsc(String(o.price)) + '">' +
      (o.id ? '<span></span>' : '<button type="button" class="x" aria-label="刪除" onclick="removeOptRow(' + i + ')">✕</button>') + '</div>';
  }).join('');
}
function addOptRow() {
  readOptRows();
  if (gbOptRows.length >= GB_OPT_CODES.length) return gbToast('最多 ' + GB_OPT_CODES.length + ' 種');
  var used = gbOptRows.map(function (o) { return o.code; });
  var code = GB_OPT_CODES.split('').find(function (x) { return used.indexOf(x) < 0; });
  gbOptRows.push({ code: code, label: '', price: '' }); renderOptRows();
}
function removeOptRow(i) {
  readOptRows(); gbOptRows.splice(i, 1);
  // 還沒建立的規格重新依序編號（已建立的代號不動，客人可能已經喊過）
  var used = gbOptRows.filter(function (o) { return o.id || o.kept; }).map(function (o) { return o.code; });
  gbOptRows.forEach(function (o) { if (!o.id && !o.kept) { o.code = GB_OPT_CODES.split('').find(function (x) { return used.indexOf(x) < 0; }); used.push(o.code); } });
  renderOptRows();
}
function syncRule() {
  var th = document.querySelector('input[name=cfRule]:checked').value === 'threshold';
  document.getElementById('cfMinWrap').hidden = !th;
}
async function saveCampaign() {
  var err = document.getElementById('cfErr'); err.textContent = '';
  var owner = gbIsOwner(gbUser);
  var title = document.getElementById('cfTitle').value.trim();
  var multi = document.getElementById('cfMulti').checked;
  if (multi) readOptRows();
  var price = multi ? 1 : intOf('cfPrice'), limit = intOf('cfLimit'), stock = intOf('cfStock'), min = intOf('cfMin');
  var stores = owner ? [].slice.call(document.querySelectorAll('#cfStores input:checked')).map(function (x) { return x.value; }) : [gbMyCode];
  var rule = document.querySelector('input[name=cfRule]:checked').value;
  var end = gbTsFromInput(document.getElementById('cfEnd').value);
  if (document.getElementById('cfImage').value.trim()) addImgUrl();   // 貼了網址忘了按「加入」
  if (!title) return err.textContent = '請填商品名稱';
  if (!(price > 0)) return err.textContent = '價格要是大於 0 的整數';
  if (multi) {
    if (gbOptRows.length < 2) return err.textContent = '多規格至少要 2 種';
    for (var oi = 0; oi < gbOptRows.length; oi++) {
      var o = gbOptRows[oi], op = Number(o.price);
      if (!o.label) return err.textContent = '規格 ' + o.code + ' 請填名稱（例：10包）';
      if (!(Number.isInteger(op) && op > 0)) return err.textContent = '規格 ' + o.code + ' 的價格要是大於 0 的整數';
    }
  }
  if (limit !== null && !(limit >= 1 && limit < GB_NO_LIMIT)) return err.textContent = '每人上限要是 1～' + (GB_NO_LIMIT - 1) + ' 的整數，或留空表示不限';
  if (limit === null) limit = GB_NO_LIMIT;
  if (stock !== null && !(stock >= 1)) return err.textContent = '總庫存要是正整數，或留空表示不限量';
  if (!stores.length) return err.textContent = '請至少勾選一家開放門市';
  if (!end) return err.textContent = '請填截單時間';
  if (rule === 'threshold' && !(min >= 1)) return err.textContent = '達標成團要填最低成團數';
  var autoNext = document.getElementById('cfAutoNext').checked;
  if (autoNext && stock === null) return err.textContent = '勾「額滿自動開下一團」要先填總庫存（每一團的份數）';
  var c = gbEditId ? gbCamps.find(function (x) { return x.id === gbEditId; }) : null;
  if (c && stock !== null && stock < (c.ordered_qty || 0)) return err.textContent = '總庫存不能少於已訂的 ' + (c.ordered_qty || 0) + ' 份';
  if (c) {
    var removed = (c.available_stores || []).filter(function (s) { return stores.indexOf(s) < 0 && (c.ordered_by_store || {})[s]; });
    if (removed.length) return err.textContent = removed.map(gbStoreName).join('、') + ' 已經有訂單，不能取消開放';
  }
  var data = {
    title: title, description: document.getElementById('cfDesc').value.trim(), price: price,
    images: gbImgs.slice(0, GB_MAX_IMGS), available_stores: stores, stock: stock, per_user_limit: limit,
    end_time: end, arrival_date: gbTsFromDate(document.getElementById('cfArrival').value, false),
    pickup_deadline: gbTsFromDate(document.getElementById('cfPickup').value, true),
    success_rule: rule, min_qty: rule === 'threshold' ? min : null, is_test: document.getElementById('cfTest').checked, auto_next: autoNext,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  };
  if (multi && optMode() === 'split') return saveMultiCampaign(c, data, stock, err);
  if (multi) {
    var bs = gbBundlesOf(gbOptRows);
    if (typeof bs === 'string') return err.textContent = bs;
    Object.assign(data, { base_title: title, title: title + '（每份 ' + bs.unitLabel + '）', price: bs.unit, bundles: bs.bundles, unit_label: bs.unitLabel });
  }
  var btn = document.getElementById('cfSave'); btn.disabled = true;
  try {
    if (!c || !c.short) data.short = await gbNewShort();
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
// 多規格存檔：每一種規格是一檔團購（共用 opt_group），訂單、庫存、上限、結算都沿用單一團購的邏輯
// 連結短碼（2026-10-11）：4 碼、避開 0/O/1/I/L 這類容易看錯的字；先查有沒有重複
var GB_SHORT_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
async function gbNewShort() {
  for (var t = 0; t < 5; t++) {
    var k = ''; for (var i = 0; i < 4; i++) k += GB_SHORT_CHARS[Math.floor(Math.random() * GB_SHORT_CHARS.length)];
    try { var q = await gbTimeout(window.db.collection('gb_campaigns').where('short', '==', k).limit(1).get()); if (q.empty) return k; } catch (e) { return k; }
  }
  return null;
}
async function saveMultiCampaign(c, data, stock, err) {
  var base = data.title, members = c ? optMembers(c.opt_group) : [];
  for (var i = 0; i < members.length; i++) {
    if (stock !== null && stock < (members[i].ordered_qty || 0)) return err.textContent = '規格 ' + members[i].opt_code + ' 已訂 ' + members[i].ordered_qty + ' 份，總庫存不能更少';
    var rm = (members[i].available_stores || []).filter(function (s) { return data.available_stores.indexOf(s) < 0 && (members[i].ordered_by_store || {})[s]; });
    if (rm.length) return err.textContent = '規格 ' + members[i].opt_code + ' 在' + rm.map(gbStoreName).join('、') + ' 已經有訂單，不能取消開放';
  }
  var group = c ? c.opt_group : 'og' + Date.now().toString(36) + gbRand(4);
  var batch = window.db.batch(), col = window.db.collection('gb_campaigns');
  var shared = Object.assign({}, data); delete shared.title; delete shared.price;
  shared.short = (members[0] && members[0].short) || await gbNewShort();   // 同一組共用一個短碼（連結對應到 A，機器人再依編號找）
  gbOptRows.forEach(function (o) {
    var own = { title: base + ' (' + o.code + ') ' + o.label, price: Number(o.price), base_title: base, opt_group: group, opt_code: o.code, opt_label: o.label };
    if (o.id) batch.update(col.doc(o.id), Object.assign({}, shared, own));
    else batch.set(col.doc(), Object.assign({}, shared, own, {
      // 新增在已開放的組裡：跟著組的狀態（避免同一組有的開放、有的還是草稿）
      status: c ? c.status : 'draft', ordered_qty: 0, ordered_by_store: {}, source_hq_post_id: null,
      created_by: gbUser.uid, created_by_name: gbUser.displayName || gbUser.empName || '', created_at: firebase.firestore.FieldValue.serverTimestamp(),
      settled_by: null, settled_at: null }));
  });
  var btn = document.getElementById('cfSave'); btn.disabled = true;
  try {
    await gbTimeout(batch.commit());
    closeModal('campModal');
    gbToast(c ? '✅ 已更新 ' + gbOptRows.length + ' 種規格' : '✅ 已建立 ' + gbOptRows.length + ' 種規格的草稿，確認後用「切換狀態」開放');
    await loadCampaigns();
  } catch (e) { err.textContent = '儲存失敗：' + e.message; }
  btn.disabled = false;
}
// 手動刪除整檔團購（加盟主／admin，2026-10-11）：訂單一起刪、不能復原；開放中的不能刪
async function deleteCampaign(cid) {
  var c = gbCamps.find(function (x) { return x.id === cid; }); if (!c) return;
  var n = c.ordered_qty || 0;
  if (!await gbConfirm('🗑 刪除團購', '刪除「' + c.title + '」？' + (n ? '\n⚠️ 這檔有 ' + n + ' 份訂單，會一起刪除。' : '') + '\n刪除後無法復原。', '刪除')) return;
  if (n && !await gbConfirm('再確認一次', '「' + c.title + '」的 ' + n + ' 份訂單會永久刪除，取貨名單也會不見。確定？', '確定刪除')) return;
  gbLoading(true, '刪除中…');
  try { var r = await gbTimeout(gbFn('gbDeleteCampaign')({ campaignId: cid }), 60000); gbToast('✅ 已刪除（訂單 ' + ((r.data && r.data.orders) || 0) + ' 筆）'); await loadCampaigns(); }
  catch (e) { gbToast('刪除失敗：' + friendly(e)); }
  gbLoading(false);
}
async function changeStatus(cid, st) {
  if (!st) return;
  var c = gbCamps.find(function (x) { return x.id === cid; });
  if (!c || !canEdit(c)) return;
  var warn = st === 'open' && gbToDate(c.end_time) && gbToDate(c.end_time).getTime() < Date.now() ? '\n⚠️ 截單時間已經過了，開放後客人仍無法下單，請先改截單時間。' : '';
  // 多規格：同一組、目前狀態相同的規格一起改（草稿→開放、開放→截單）
  // 成團／流局／到貨／結案每種規格結果可能不同（A 達標、B 沒有），只改這一種
  var targets = c.opt_group && ['draft', 'open', 'closed'].indexOf(st) >= 0 ? optMembers(c.opt_group).filter(function (m) { return m.status === c.status; }) : [c];
  var name = targets.length > 1 ? '「' + c.base_title + '」' + targets.map(function (m) { return m.opt_code; }).join('／') + ' 共 ' + targets.length + ' 種規格' : '「' + c.title + '」';
  var ok = await gbConfirm('切換狀態', name + '從「' + GB_STATUS[c.status] + '」改為「' + GB_STATUS[st] + '」？' + warn, '改為' + GB_STATUS[st]);
  if (!ok) return;
  var upd = { status: st, updated_at: firebase.firestore.FieldValue.serverTimestamp() };
  if (st === 'success' || st === 'failed') { upd.settled_by = gbUser.uid; upd.settled_at = firebase.firestore.FieldValue.serverTimestamp(); }
  if (st === 'done') upd.ended_at = firebase.firestore.FieldValue.serverTimestamp();   // 結案滿 2 個月自動刪訂單從這天算
  gbLoading(true, '更新中…');
  var batch = window.db.batch();
  targets.forEach(function (m) { batch.update(window.db.collection('gb_campaigns').doc(m.id), upd); });
  try { await gbTimeout(batch.commit()); gbToast('✅ 已改為「' + GB_STATUS[st] + '」'); await loadCampaigns(); }
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
  document.getElementById('ofLead').textContent = '「' + c.title + '」' + (gbNoLimit(c) ? '每人不限' : '每人上限 ' + c.per_user_limit) + '・' + (c.stock == null ? '不限量' : '剩 ' + Math.max(0, c.stock - (c.ordered_qty || 0)) + ' 份') + (c.status !== 'open' ? '・⚠️ 已截單（加盟主補單）' : '');
  document.getElementById('ofName').value = '';
  document.getElementById('ofQty').value = 1;
  document.getElementById('ofNote').value = '';
  document.getElementById('ofPhone').value = '';
  document.getElementById('ofErr').textContent = '';
  openModal('orderModal');
  setTimeout(function () { document.getElementById('ofName').focus(); }, 50);
}
async function saveManualOrder() {
  var err = document.getElementById('ofErr'); err.textContent = '';
  var c = gbOrderCamp; if (!c) return;
  var store = document.getElementById('ofStore').value, name = document.getElementById('ofName').value.trim();
  var qty = intOf('ofQty'), note = document.getElementById('ofNote').value.trim();
  var phone = document.getElementById('ofPhone').value.replace(/[\s-]/g, '');
  if (phone && !/^09\d{8}$/.test(phone)) return err.textContent = '手機號碼格式不正確（09 開頭共 10 碼），或留空';
  if (!name) return err.textContent = '請填客人暱稱';
  if (!(qty >= 1)) return err.textContent = '數量要是正整數';
  var btn = document.getElementById('ofSave'); btn.disabled = true;
  // 額滿自動開下一團：這一團裝不下 → 請伺服器建立／找到下一團，訂單放那裡
  if (c.auto_next && c.stock != null && (c.ordered_qty || 0) + qty > c.stock) {
    try {
      var nr = await gbTimeout(gbFn('gbNextRound')({ campaignId: c.id, qty: qty }));
      await loadCampaigns();
      var nc = gbCamps.find(function (x) { return x.id === nr.data.campaignId; });
      if (nc) { c = nc; gbOrderCamp = nc; gbToast('這一團滿了，改登記到「' + nc.title + '」'); }
    } catch (e) { btn.disabled = false; return err.textContent = friendly(e); }
  }
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
        display_name: name, picture_url: null, note: note, phone: phone || null, qty: qty, status: 'active', paid: false,
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
  document.getElementById('qfLead').textContent = o.display_name + '・' + c.title + (gbNoLimit(c) ? '' : '（每人上限 ' + c.per_user_limit + '）');
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
    // 流局：有人訂才跳流局文案（讓 +1 過的客人知道不用等）；沒人訂就不用通知（2026-10-10 使用者）
    if (success) openCopy(cid, 'success'); else if (total > 0) openCopy(cid, 'failed'); else gbToast('已流局（沒有人訂購，不用通知群組）');
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
  // 加盟主先選門市（2026-10-11 使用者）：單店或最後的「三店合併」；記住上次選的。店長只有本店
  var multi = owner && stores.length > 1 && kind !== 'open' && kind !== 'failed';   // 開團、流局文案三店共用一份，不用選門市
  document.getElementById('cpStore').parentElement.hidden = kind === 'open' || kind === 'failed';
  sel.innerHTML = (multi ? '<option value="-">— 請先選門市 —</option>' : '') + stores.map(function (s) { return '<option value="' + s + '">' + gbStoreName(s) + '</option>'; }).join('') +
    (multi ? '<option value="">三店合併</option>' : '');
  if (multi) {
    var last = null; try { last = localStorage.getItem('gbCopyStore'); } catch (e) {}
    sel.value = last !== null && (last === '' || stores.indexOf(last) >= 0) ? last : '-';
  }
  document.getElementById('cpTitle').textContent = { open: '📝 開團文案', success: '🎉 成團文案', arrived: '📦 取貨通知', failed: '😢 流局文案' }[kind];
  document.getElementById('cpNamesWrap').hidden = kind === 'open' || kind === 'failed';
  document.getElementById('cpInfoBtn').hidden = document.getElementById('cpInfoHint').hidden = kind !== 'open';
  document.getElementById('cpArrivalWrap').hidden = kind !== 'success';
  document.getElementById('cpArrival').value = gbInputDate(c.arrival_date);
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
  var ta = document.getElementById('cpText');
  if (st === '-') { x.info = ''; ta.value = ''; ta.placeholder = '👆 請先選門市，文案裡的下單連結是各店分開的'; return; }
  ta.placeholder = '';
  try { localStorage.setItem('gbCopyStore', st); } catch (e) {}
  var qty = st ? (obs[st] || 0) : (c.ordered_qty || 0);
  var where = st ? gbStoreName(st) : x.stores.map(gbStoreName).join('・');
  var lines = [];
  x.info = '';
  if (x.kind === 'open') {
    // 2026-10-11 使用者：總部小編原文（貼在「說明」）放最上面，系統再補客人需要的資訊
    var liffId = await gbLiffLinks();
    if (c.description) lines.push(c.description, '', '──────────');
    var infoFrom = lines.length;   // 從這裡往下是「團購資訊」：自己發圖文時只複製這段貼在下方（2026-10-11）
    // 多規格：一段文案列出所有規格，客人打編號 +1
    var opts = c.opt_group ? optMembers(c.opt_group).filter(function (m) { return m.status === 'open' || m.status === 'draft'; }) : [];
    var bds = c.bundles || [];
    // 總部原文已經列了 (A)(B)(C) 價格就不再重複列（2026-10-11 使用者給的格式）
    var codes = bds.length ? bds.map(function (b) { return b.code; }) : opts.map(function (m) { return m.opt_code; });
    var listed = !!c.description && codes.length > 0 && codes.every(function (k) { return new RegExp('[(（]\\s*' + k + '\\s*[)）]').test(c.description); });
    if (bds.length) {
      // 合併成一檔：A＝1 份、B＝3 份…
      lines.push('🛒 ' + c.base_title);
      if (!listed) bds.forEach(function (b) { lines.push('(' + b.code + ') ' + b.label + '　$' + b.mult * c.price); });
      if (gbLimitTxt(c)) lines.push(gbLimitTxt(c) + '（每份 ' + c.unit_label + '）');
      lines.push(c.success_rule === 'threshold' ? '🎯 滿 ' + c.min_qty + ' 份（每份 ' + c.unit_label + '）成團（三店合計）' : '✅ 保證成團');
      opts = bds.map(function (b) { return { opt_code: b.code }; });   // 下面「編號＋數量」說明共用
    } else if (opts.length) {
      lines.push('🛒 ' + c.base_title);
      if (!listed) opts.forEach(function (m) { lines.push('(' + m.opt_code + ') ' + m.opt_label + '　$' + m.price); });
      if (gbLimitTxt(c, true)) lines.push(gbLimitTxt(c, true));
      lines.push(c.success_rule === 'threshold' ? '🎯 每種各滿 ' + c.min_qty + ' 份成團（三店合計）' : '✅ 保證成團');
    } else {
      lines.push('🛒 ' + c.title, '💰 $' + c.price + '／份' + (gbLimitTxt(c) ? '・' + gbLimitTxt(c) : ''));
      lines.push(c.success_rule === 'threshold' ? '🎯 滿 ' + c.min_qty + ' 份成團（三店合計）' : '✅ 保證成團');
    }
    lines.push('⏰ 預購至 ' + gbFmt(c.end_time), c.arrival_date ? '🚚 預計 ' + gbFmt(c.arrival_date, false) + ' 起到貨，到貨會在群組通知' : '🚚 到貨日確定後在群組通知', '💰 到店取貨付款');
    // 連結帶 c=團購 ID：機器人看到這則訊息會記下「訊息→團購」，客人引用這則回覆 +1 就知道是哪一檔
    var tq = c.is_test ? '&test=1' : '';   // 測試團的連結只在測試模式顯示
    var ex = opts.length ? opts[0].opt_code : '';
    if (opts.length) lines.push('', '👉 回覆這則留言打「編號＋數量」，例如 ' + ex + '+1、' + (opts[1] ? opts[1].opt_code : ex) + '+2');
    // 一個連結三店共用（2026-10-11）：不帶門市，客人第一次打開選取貨門市、之後記住；機器人照群組判斷門市。
    // c＝4 碼短碼（沒有短碼的舊團用團購 ID），機器人看到會記下「這則貼文→這檔團購」
    var link = liffId ? 'https://liff.line.me/' + liffId + '?c=' + (c.short || c.id) + tq : '';
    if (opts.length) { if (link) lines.push('或點這裡下單：' + link); }
    else lines.push('', link ? '👉 點這裡 +1（或直接回覆這則留言 +1）：' + link : '👉 直接回覆這則訊息打「+1」（要 2 份就打 +2）');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    x.info = lines.slice(infoFrom).join('\n');
  } else if (x.kind === 'success') {
    lines.push('🎉【團購成團】' + c.title, '感謝大家支持！' + (st ? where + '共 ' + qty + ' 份' : '三店共 ' + qty + ' 份（' + x.stores.map(function (s) { return gbStoreName(s) + ' ' + (obs[s] || 0); }).join('・') + '）'));
    lines.push('📦 預計到貨：' + (c.arrival_date ? gbFmt(c.arrival_date, false) : '到貨日確定後通知'), '到貨後會再通知取貨，到店付款 $' + c.price + '／份');
  } else if (x.kind === 'failed') {
    var tot = c.ordered_qty || 0;
    lines.push('😢【未成團】' + c.title, '這次三店合計 ' + tot + ' 份' + (c.min_qty ? '，未達成團數量 ' + c.min_qty + ' 份' : '') + '，這次不會出貨，不用取貨也不用付款。', '謝謝大家支持，有再次開團會在群組通知 🙏');
  } else {
    lines.push('📦【到貨通知】' + c.title + ' 到貨囉！', '請在 ' + (c.pickup_deadline ? gbFmt(c.pickup_deadline, false) : '3 天內') + ' 前到' + where + '門市取貨，到店付款 $' + c.price + '／份');
  }
  // 名單（成團、取貨都可附）：選單店只列該店；三店合併依門市分開列（2026-10-11）
  if (x.kind !== 'open' && document.getElementById('cpNames').checked) {
    try {
      var sn = await gbTimeout(window.db.collection('gb_orders').where('campaign_id', '==', c.id).get());
      var os = sn.docs.map(function (d) { return d.data(); }).filter(function (o) { return o.status === 'active' && (st ? o.store === st : x.stores.indexOf(o.store) >= 0); });
      var label = x.kind === 'success' ? '成團名單' : '取貨名單';
      (st ? [st] : x.stores).forEach(function (s) {
        var mine = os.filter(function (o) { return o.store === s; });
        if (!mine.length) return;
        lines.push('', st ? label + '：' : '【' + gbStoreName(s) + '門市】' + label + '（' + mine.reduce(function (a, o) { return a + o.qty; }, 0) + ' 份）');
        mine.forEach(function (o) { lines.push('・' + o.display_name + ' ×' + o.qty); });
      });
    } catch (e) { lines.push('', '（名單讀取失敗）'); }
  }
  document.getElementById('cpText').value = lines.join('\n');
}
async function copyText() {
  var t = document.getElementById('cpText');
  if (!t.value) return gbToast('請先選門市');
  try { await navigator.clipboard.writeText(t.value); gbToast('✅ 已複製，貼到門市群組就好'); }
  catch (e) { t.focus(); t.select(); try { document.execCommand('copy'); gbToast('✅ 已複製'); } catch (e2) { gbToast('請長按文字框自行複製'); } }
}
// 只複製團購資訊（不含總部原文）：自己發的圖文貼完，再把這段貼在下方
async function copyInfo() {
  var info = gbCopyCtx && gbCopyCtx.info; if (!info) return gbToast('請先選門市');
  try { await navigator.clipboard.writeText(info); gbToast('✅ 已複製團購資訊，貼在你的文案下方'); }
  catch (e) {
    var t = document.getElementById('cpText'), i = t.value.indexOf(info);
    t.focus(); if (i >= 0) t.setSelectionRange(i, i + info.length);
    try { document.execCommand('copy'); gbToast('✅ 已複製團購資訊'); } catch (e2) { gbToast('請長按選取文字框下半段自行複製'); }
  }
}


// ===== 團購設定（2026-10-10）：LIFF ID／Channel ID 存 gb_settings/liff，三店下單連結＋QR Code =====
// gb_settings/liff 開放未登入讀取（LIFF 客人頁要拿 liff_id 初始化；兩個值都不是密碼），只有加盟主／admin 能寫。
async function loadLiffSettings() {
  try { var so = await gbTimeout(window.db.collection('gb_settings').doc('stores').get()); setOpenUi(so.exists && so.data().open === true); } catch (e) {}
  var d = {};
  try { var s = await gbTimeout(window.db.collection('gb_settings').doc('liff').get()); if (s.exists) d = s.data(); } catch (e) {}
  document.getElementById('stLiff').value = d.liff_id || '';
  document.getElementById('stChannel').value = d.channel_id || '';
  renderLiffLinks(d.liff_id || '');
  loadBotGroups();
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
// 多圖（2026-10-10 使用者：最多 6 張）：gbImgs 是表單上目前的圖片網址，第一張＝封面
var GB_MAX_IMGS = 6, gbImgs = [];
function renderImgs() {
  document.getElementById('cfImgs').innerHTML = gbImgs.map(function (u, i) {
    return '<div class="cf-img" style="background-image:url(\'' + gbEsc(u).replace(/'/g, '%27') + '\')">' +
      (i ? '<button type="button" class="cf-img-l" title="往前移" onclick="moveImg(' + i + ')">◀</button>' : '<span class="cf-img-cover">封面</span>') +
      '<button type="button" class="cf-img-x" title="移除" onclick="removeImg(' + i + ')">✕</button></div>';
  }).join('');
  document.getElementById('cfAddImg').hidden = gbImgs.length >= GB_MAX_IMGS;
}
function moveImg(i) { var t = gbImgs[i - 1]; gbImgs[i - 1] = gbImgs[i]; gbImgs[i] = t; renderImgs(); }
function removeImg(i) { gbImgs.splice(i, 1); renderImgs(); document.getElementById('cfUpMsg').textContent = ''; }
function addImgUrl() {
  var el = document.getElementById('cfImage'), v = el.value.trim(), msg = document.getElementById('cfUpMsg');
  if (!v) return;
  if (!/^https:\/\//.test(v)) { msg.textContent = '網址要是 https:// 開頭'; return; }
  if (gbImgs.length >= GB_MAX_IMGS) { msg.textContent = '最多 ' + GB_MAX_IMGS + ' 張'; return; }
  gbImgs.push(v); el.value = ''; renderImgs();
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
async function uploadCampImages(files) {
  var msg = document.getElementById('cfUpMsg'), save = document.getElementById('cfSave');
  var list = [].slice.call(files || []);
  if (!list.length) return;
  var room = GB_MAX_IMGS - gbImgs.length;
  if (room <= 0) { msg.textContent = '最多 ' + GB_MAX_IMGS + ' 張'; return; }
  var skipped = Math.max(0, list.length - room);
  list = list.slice(0, room);
  save.disabled = true;
  var fail = 0;
  for (var i = 0; i < list.length; i++) {
    var file = list[i], tag = list.length > 1 ? '第 ' + (i + 1) + '/' + list.length + ' 張 ' : '';
    if (!/^image\//.test(file.type)) { fail++; continue; }
    try {
      msg.textContent = tag + '處理中…';
      var blob = await shrinkImage(file);
      if (blob.size > 5 * 1024 * 1024) throw new Error('圖片太大（超過 5MB）');
      var d = new Date(), ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
      var ref = firebase.app().storage(GB_BUCKET).ref('gb/' + ym + '/' + Date.now() + '_' + gbRand(6) + '.jpg');
      var task = ref.put(blob, { contentType: 'image/jpeg' });
      task.on('state_changed', function (sn) { msg.textContent = tag + '上傳中 ' + Math.round(sn.bytesTransferred / sn.totalBytes * 100) + '%'; });
      await gbTimeout(task, 60000, '上傳逾時，請確認網路後再試');
      gbImgs.push(await ref.getDownloadURL());
      renderImgs();
    } catch (e) { fail++; console.warn('上傳失敗', e); }
  }
  msg.textContent = (fail ? '⚠️ ' + fail + ' 張上傳失敗' : '✅ 已上傳') + (skipped ? '（超過 ' + GB_MAX_IMGS + ' 張，略過 ' + skipped + ' 張）' : '');
  save.disabled = false;
}

function setOpenUi(on) { document.getElementById('stOpen').checked = on; document.getElementById('stOpenTxt').textContent = on ? '目前：已開放給全員' : '目前：未開放（只有系統管理者能用）'; }
async function toggleGbOpen(el) {
  var on = el.checked;
  var ok = await gbConfirm(on ? '開放團購給全員' : '關閉團購', on ? '開放後所有員工都能使用團購頁，截單提醒會發給加盟主與店長。確定開放？' : '關閉後只有系統管理者能用，其他人會看到「開發中」。確定關閉？', on ? '開放' : '關閉');
  if (!ok) { el.checked = !on; return; }
  try { await gbTimeout(window.db.collection('gb_settings').doc('stores').set({ open: on, open_changed_by: gbUser.uid, open_changed_at: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })); setOpenUi(on); gbToast(on ? '✅ 已開放' : '已關閉'); }
  catch (e) { el.checked = !on; gbToast('更新失敗：' + friendly(e)); }
}


// ===== 第 4 階段：機器人群組白名單（〔設定〕）＋待確認區（〔團購〕）=====
function gbFn(name) { return firebase.app().functions('asia-east1').httpsCallable(name); }
var gbBotGroups = [];
async function loadBotGroups() {
  var el = document.getElementById('stBot'); if (!el) return;
  var bot = {};
  try { var b = await window.db.collection('gb_settings').doc('bot').get(); if (b.exists) bot = b.data(); } catch (e) {}
  try { var sn = await gbTimeout(window.db.collection('gb_bot_groups').get()); gbBotGroups = sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); }
  catch (e) { el.innerHTML = '<div class="empty">讀取失敗：' + gbEsc(e.message) + '</div>'; return; }
  var ST = { pending: ['待核准', 'st-closed'], approved: ['運作中', 'st-open'], rejected: ['已拒絕', 'st-draft'], left: ['已被移出', 'st-draft'], auto_left: ['逾時自動退出', 'st-draft'] };
  var order = { pending: 0, approved: 1 };
  gbBotGroups.sort(function (a, b) { return (order[a.status] == null ? 9 : order[a.status]) - (order[b.status] == null ? 9 : order[b.status]); });
  var rows = gbBotGroups.map(function (g) {
    var st = ST[g.status] || [g.status, 'st-draft'];
    var mode = g.status === 'approved' ? (g.mode === 'store_listen' ? (g.is_test ? '🧪 測試群組・只抓測試團（' + gbStoreName(g.store) + '）' : '監聽 ' + gbStoreName(g.store) + ' 的 +1') : '已停用') : '';
    var act = '';
    if (g.status === 'pending' || (g.status === 'approved' && g.mode !== 'store_listen')) {
      act = '<select class="inline" id="bs-' + g.id + '">' + GB_STORES.map(function (s) { return '<option value="' + s.code + '"' + (s.code === g.store ? ' selected' : '') + '>' + s.name + '</option>'; }).join('') + '</select>' +
        '<label style="font-size:12px;font-weight:700;display:flex;align-items:center;gap:4px;"><input type="checkbox" id="bt-' + g.id + '"' + (g.is_test ? ' checked' : '') + '> 測試群組</label>' +
        '<button class="mini" onclick="botAction(\'' + g.id + '\',\'approve\')">核准監聽</button>';
    }
    if (g.status === 'approved' && g.mode === 'store_listen') act += '<button class="mini" onclick="botAction(\'' + g.id + '\',\'' + (g.is_test ? 'setReal' : 'setTest') + '\')">' + (g.is_test ? '改成正式群組' : '改成測試群組') + '</button><button class="mini" onclick="botAction(\'' + g.id + '\',\'disable\')">暫停</button>';
    if (g.status === 'pending' || g.status === 'approved') act += '<button class="mini d" onclick="botAction(\'' + g.id + '\',\'reject\')">退出群組</button>';
    return '<div class="orow"><span class="nm">' + gbEsc(g.name || '（沒有名稱）') + '</span><span class="st ' + st[1] + '">' + st[0] + '</span><span class="sub">' + mode + (g.status === 'pending' ? '・加入 ' + gbFmt(g.joined_at) + '，24 小時內沒核准會自動退出' : '') + '</span>' + act + '</div>';
  }).join('');
  el.innerHTML = '<div style="font-size:15px;font-weight:900;margin-bottom:4px;">LINE 機器人群組</div>' +
    '<p style="font-size:12.5px;color:var(--muted);margin:0 0 8px;line-height:1.6;">機器人被拉進群組後會出現在這裡，核准並選門市才會開始抓 +1；不認識的群組按「退出群組」。</p>' +
    (rows || '<div class="empty" style="padding:14px;">機器人還沒有加入任何群組</div>') +
    '<div style="display:flex;align-items:center;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);flex-wrap:wrap;"><span style="flex:1;min-width:180px;font-size:13.5px;font-weight:700;">LINE 圖文選單<span style="display:block;font-weight:600;color:var(--muted);font-size:12px;">' +
    (bot.rich_menu_at ? '上次更新：' + gbFmt(bot.rich_menu_at, true) : '還沒建立') + '・改了 LIFF ID 要再按一次</span></span><button class="mini" onclick="setupRichMenu()">更新 LINE 選單</button></div>';
}
async function setupRichMenu() {
  if (!await gbConfirm('LINE 圖文選單', '把「我要下單／我的訂單／怎麼團購」選單套用到所有加好友的客人？舊選單會被取代。', '套用')) return;
  gbLoading(true, '建立選單中…');
  try { await gbTimeout(gbFn('gbSetupRichMenu')({}), 60000); gbToast('✅ 選單已更新，客人重新打開聊天室就會看到'); await loadBotGroups(); }
  catch (e) { gbToast('失敗：' + friendly(e)); }
  gbLoading(false);
}
async function botAction(gid, action) {
  var g = gbBotGroups.find(function (x) { return x.id === gid; }); if (!g) return;
  var store = action === 'approve' ? document.getElementById('bs-' + gid).value : g.store;
  var test = action === 'approve' ? document.getElementById('bt-' + gid).checked : action === 'setTest';
  if (action === 'setTest' || action === 'setReal') action = 'approve';
  var txt = { approve: '「' + (g.name || gid) + '」' + (test ? '設為 🧪 測試群組（只抓測試團）' : '設為正式群組') + '，監聽 ' + gbStoreName(store) + ' 的 +1？', disable: '暫停「' + (g.name || gid) + '」的 +1 監聽？機器人會留在群組。', reject: '讓機器人退出「' + (g.name || gid) + '」？' }[action];
  if (!await gbConfirm('機器人群組', txt, { approve: '核准', disable: '暫停', reject: '退出群組' }[action])) return;
  gbLoading(true, '處理中…');
  try { await gbTimeout(gbFn('gbBotGroupAction')({ groupId: gid, action: action, store: store, test: test })); gbToast('✅ 已更新'); await loadBotGroups(); }
  catch (e) { gbToast('失敗：' + friendly(e)); }
  gbLoading(false);
}
async function saveBotReply(on) {
  try { await window.db.collection('gb_settings').doc('bot').set({ reply_on_success: on, updated_at: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }); gbToast(on ? '已開啟成單回覆' : '已關閉成單回覆'); }
  catch (e) { gbToast('更新失敗：' + friendly(e)); }
}

var gbPending = [];
async function loadPending() {
  var el = document.getElementById('pendBox'); if (!el) return;
  try {
    var q = window.db.collection('gb_pending_plus').where('status', '==', 'pending');
    if (!gbIsOwner(gbUser)) q = q.where('store', '==', gbMyCode);
    var sn = await gbTimeout(q.get());
    gbPending = sn.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }).sort(function (a, b) { return (gbToDate(a.received_at) || 0) - (gbToDate(b.received_at) || 0); });
  } catch (e) { gbPending = []; }
  renderPending();
}
function renderPending() {
  var el = document.getElementById('pendBox'); if (!el) return;
  if (!gbPending.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="card" style="border:1.5px solid #fbbf24;"><div style="font-size:15px;font-weight:900;margin-bottom:2px;">🙋 群組 +1 待確認 <span class="st st-closed">' + gbPending.length + '</span></div>' +
    '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">機器人判斷不了是哪一檔，選好團購與數量按「成立」；不是要訂的按「忽略」。</div>' +
    gbPending.map(function (p) {
      var opts = gbCamps.filter(function (c) { return c.status === 'open' && (c.available_stores || []).indexOf(p.store) >= 0; });
      return '<div class="orow"><span class="nm">' + gbEsc(p.display_name || 'LINE 用戶') + '</span><span class="sub">' + (gbIsOwner(gbUser) ? gbStoreName(p.store) + '・' : '') + '「' + gbEsc(p.text) + '」・' + gbEsc(p.reason || '') + '・' + gbFmt(p.received_at) + '</span>' +
        '<select class="inline" id="pc-' + p.id + '">' + (opts.length ? opts.map(function (c) { return '<option value="' + c.id + '"' + (c.id === p.campaign_id ? ' selected' : '') + '>' + gbEsc(c.title) + '</option>'; }).join('') : '<option value="">沒有開放中的團購</option>') + '</select>' +
        '<input id="pq-' + p.id + '" type="number" min="1" step="1" value="' + (p.parsed_qty || 1) + '" style="width:58px;padding:7px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;font-weight:800;">' +
        '<button class="mini" onclick="resolvePending(\'' + p.id + '\',\'make\')"' + (opts.length ? '' : ' disabled') + '>成立</button><button class="mini d" onclick="resolvePending(\'' + p.id + '\',\'ignore\')">忽略</button></div>';
    }).join('') + '</div>';
}
async function resolvePending(id, action) {
  var data = { pendingId: id, action: action };
  if (action === 'make') { data.campaignId = document.getElementById('pc-' + id).value; data.qty = parseInt(document.getElementById('pq-' + id).value, 10); if (!data.campaignId || !(data.qty >= 1)) return gbToast('請選團購與數量'); }
  gbLoading(true, '處理中…');
  try {
    var r = await gbTimeout(gbFn('gbResolvePending')(data), 30000);
    var lr = (r.data && r.data.learned) || {};
    // 客人是回覆某則貼文：系統記住那則＝這檔，同一則的其他 +1 一起補記
    gbToast(action !== 'make' ? '已忽略' : '✅ 已成立訂單' + (lr.mapped ? '，已記住這篇貼文' + (lr.resolved ? '，另外自動補記 ' + lr.resolved + ' 筆' : '') : ''));
    await loadPending(); if (action === 'make') await loadCampaigns();
  }
  catch (e) { gbToast(friendly(e)); }
  gbLoading(false);
}

// 成團後才知道到貨日：在成團文案畫面填，存回團購（客人「我的訂單」也看得到），文案跟著更新
async function saveCopyArrival() {
  var x = gbCopyCtx; if (!x) return;
  var v = document.getElementById('cpArrival').value;
  try {
    await gbTimeout(window.db.collection('gb_campaigns').doc(x.c.id).update({ arrival_date: gbTsFromDate(v, false), updated_at: firebase.firestore.FieldValue.serverTimestamp() }));
    x.c.arrival_date = gbTsFromDate(v, false);
    await buildCopy();
    gbToast(v ? '✅ 已更新到貨日' : '已清除到貨日');
  } catch (e) { gbToast('更新失敗：' + friendly(e)); }
}
