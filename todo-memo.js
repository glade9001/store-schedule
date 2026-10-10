// 門市備忘：代辦頁（todo.html）專用的畫面與操作。共用的狀態定義與判斷在 store-memo.js（首頁也載入）。
let memoList = [], memoGbList = [], memoStore = '', memoEditingId = null, memoPay = '', memoClosedCollapsed = true;

async function memoLoad() {
  if (!memoStore) memoStore = myStore();
  try { memoList = await memoLoadOpen(memoStore); }
  catch (e) { memoList = []; console.warn('門市備忘讀取失敗', e); }
  try { memoGbList = await memoLoadGb(memoStore); }
  catch (e) { memoGbList = []; console.warn('團購留貨讀取失敗', e); }
}
function memoStores() {
  return (appConfig.stores || []).filter(s => s && s !== '人力支援' && s !== '測試店');
}
function memoSwitchStore(st) { memoStore = st; memoLoad().then(renderAll); }

function memoSectionHtml() {
  const open = memoList.filter(m => m.status < 3)
    .sort((a, b) => (!!memoStale(b) - !!memoStale(a)) || (b.status - a.status) || ((a.createdAt || 0) - (b.createdAt || 0)));
  const since = Date.now() - STORE_MEMO.CLOSED_SHOW_DAYS * 86400000;
  const closed = memoList.filter(m => m.status === 3 && (m.closedAt || 0) >= since).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  let h = `<div class="sec-header"><div class="sec-title">📦 門市備忘・${memoEsc(memoStore)}</div><div class="sec-count">${open.length + memoGbList.length}</div>
    <button class="memo-add" onclick="memoOpenAdd()">＋ 新增</button></div>`;
  if (isAdmin()) {
    h += `<div class="memo-stores">${memoStores().map(s => `<button class="memo-st ${s === memoStore ? 'on' : ''}" onclick="memoSwitchStore('${memoEsc(s)}')">${memoEsc(s)}</button>`).join('')}</div>`;
  }
  if (open.length || memoGbList.length) h += memoGbList.map((g, i) => memoGbCard(g, i)).join('') + open.map(m => memoCard(m)).join('');
  else h += `<div class="memo-empty">目前沒有客訂／留貨</div>`;
  if (closed.length) {
    h += `<div class="collapse-hdr" onclick="memoToggleClosed()">
      <span class="collapse-arrow ${memoClosedCollapsed ? '' : 'open'}" id="memoClosedArrow">›</span>
      <span class="sec-title">✅ 已取貨（近 ${STORE_MEMO.CLOSED_SHOW_DAYS} 天）</span><span class="sec-count">${closed.length}</span></div>
      <div id="memoClosedList" style="display:${memoClosedCollapsed ? 'none' : 'block'};">${closed.map(m => memoCard(m)).join('')}</div>`;
  }
  return h;
}
function memoToggleClosed() {
  memoClosedCollapsed = !memoClosedCollapsed;
  const l = document.getElementById('memoClosedList'), a = document.getElementById('memoClosedArrow');
  if (l) l.style.display = memoClosedCollapsed ? 'none' : 'block';
  if (a) a.classList.toggle('open', !memoClosedCollapsed);
}
function memoStepsHtml(m) {
  return `<div class="memo-steps">${STORE_MEMO.STATUS.map((s, i) =>
    `<span class="memo-step ${i < m.status ? 'past' : i === m.status ? 'cur' : ''}">${s}</span>`).join('<span class="memo-arrow">›</span>')}</div>`;
}
function memoCard(m) {
  const stale = m.status < 3 ? memoStale(m) : null;
  const done = m.status === 3;
  const payCls = m.pay === 'paid' ? 'paid' : m.pay === 'deposit' ? 'deposit' : 'unpaid';
  const next = done ? '' : `<button class="memo-next" onclick="event.stopPropagation();memoAdvance('${m.id}')">${STORE_MEMO.ICON[m.status + 1]} ${STORE_MEMO.STATUS[m.status + 1]}</button>`;
  return `<div class="todo-card memo-card ${done ? 'is-done' : ''}" onclick="memoOpenDet('${m.id}')">
    <div class="stripe ${stale ? 'memo-stale' : 'memo'}"></div>
    <div class="todo-body">
      <div class="todo-title">${memoEsc(memoTitle(m))}</div>
      ${memoStepsHtml(m)}
      <div class="todo-foot">
        <span class="tag memo-pay ${payCls}">${memoEsc(memoPayText(m))}</span>
        ${stale ? `<span class="tag dl-soon">⚠️ ${stale.text}</span>` : ''}
        ${m.note ? `<span class="tag scope">${memoEsc(m.note.length > 14 ? m.note.slice(0, 14) + '…' : m.note)}</span>` : ''}
      </div>
    </div>
    ${next}
  </div>`;
}

// 推進一步（全店共用狀態 → 用 transaction 確認沒被別人先推過，避免兩人同時按跳兩格）
async function memoAdvance(id, back) {
  const m = memoList.find(x => x.id === id); if (!m) return;
  const to = back ? m.status - 1 : m.status + 1;
  if (to < 0 || to > 3) return;
  const upd = { status: to, updatedAt: Date.now() };
  if (to === 3) {
    if (m.pay !== 'paid') {
      const owe = m.pay === 'deposit' ? `只付了訂金${m.deposit ? ' $' + m.deposit : ''}` : '還沒結帳';
      if (!confirm(`⚠️ 這張單${owe}。\n\n請確認客人已經付清，再按「確定」交貨結案。`)) return;
      upd.pay = 'paid'; upd.paidAtPickup = true;
    } else if (!confirm(`確認「${memoTitle(m)}」客人已經取貨？`)) return;
    upd.closedAt = Date.now();
  }
  if (back) {
    if (!confirm(`退回「${STORE_MEMO.STATUS[to]}」？（按錯時用）`)) return;
    if (m.status === 3) upd.closedAt = null;
  }
  const ref = window.db.collection('storeMemos').doc(id);
  showLoading('更新中…');
  try {
    await Promise.race([
      window.db.runTransaction(async tx => {
        const cur = await tx.get(ref);
        if (!cur.exists) throw new Error('這張單已被刪除');
        if (cur.data().status !== m.status) throw new Error(`別人剛剛已改成「${STORE_MEMO.STATUS[cur.data().status]}」，已重新整理`);
        tx.update(ref, { ...upd, log: [...(cur.data().log || []), { s: to, by: myName(), at: Date.now(), ...(back ? { back: true } : {}) }] });
      }),
      new Promise((_, r) => setTimeout(() => r(new Error('連線逾時，請再試一次')), 10000)),
    ]);
    closeModal('memoDetModal');
    showToast(`已改為「${STORE_MEMO.STATUS[to]}」`);
  } catch (e) { alert(e.message); }
  await memoLoad(); renderAll(); hideLoading();
}

function memoOpenDet(id) {
  const m = memoList.find(x => x.id === id); if (!m) return;
  const fmt = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const stale = m.status < 3 ? memoStale(m) : null;
  const log = (m.log || []).map(l => `<div class="memo-log">${fmt(l.at)}　${memoEsc(getDN(l.by))}　${l.back ? '退回' : ''}${STORE_MEMO.STATUS[l.s]}</div>`).join('');
  document.getElementById('memoDetTitle').textContent = memoTitle(m);
  document.getElementById('memoDetContent').innerHTML = `
    ${memoStepsHtml(m)}
    ${stale ? `<div class="memo-warn">⚠️ ${stale.text}${m.status === 2 ? '，請聯絡客人' : '，請追一下廠商'}</div>` : ''}
    <div class="memo-kv"><span>客人</span><b>${memoEsc(m.customer)}</b></div>
    <div class="memo-kv"><span>電話</span>${m.phone ? `<a href="tel:${memoEsc(m.phone)}">${memoEsc(m.phone)}</a>` : `<i>${m.phoneClearedAt ? '結案後已清除' : '未留'}</i>`}</div>
    <div class="memo-kv"><span>商品</span><b>${memoEsc(m.item)}${m.qty ? ' ×' + memoEsc(m.qty) : ''}</b></div>
    <div class="memo-kv"><span>付款</span><b>${memoEsc(memoPayText(m))}${m.paidAtPickup ? '（取貨時付清）' : ''}</b></div>
    ${m.note ? `<div class="memo-note">${memoEsc(m.note)}</div>` : ''}
    <div class="memo-log-hdr">紀錄</div>${log}`;
  const btns = [];
  if (m.status < 3) btns.push(`<button class="det-btn memo-go" onclick="memoAdvance('${id}')">${STORE_MEMO.ICON[m.status + 1]} 改為「${STORE_MEMO.STATUS[m.status + 1]}」</button>`);
  document.getElementById('memoDetActions').innerHTML = btns.join('') +
    `<div class="det-actions">
      ${m.status > 0 ? `<button class="det-btn" style="background:#f1f3f4;" onclick="memoAdvance('${id}',true)">↩ 退回上一步</button>` : ''}
      <button class="det-btn edit" onclick="memoOpenEdit('${id}')">✏️ 編輯</button>
      ${isManager() ? `<button class="det-btn del" onclick="memoDelete('${id}')">🗑️ 刪除</button>` : ''}
    </div>`;
  openModal('memoDetModal');
}

function memoSetPay(p) {
  memoPay = p;
  ['paid', 'unpaid', 'deposit'].forEach(k => document.getElementById('memoPay_' + k).classList.toggle('on', k === p));
  document.getElementById('memoDepositGrp').style.display = p === 'deposit' ? 'block' : 'none';
}
function memoOpenAdd() {
  closeModal('addModal');
  memoEditingId = null;
  document.getElementById('memoModalTitle').textContent = `新增門市備忘（${memoStore || myStore()}）`;
  ['memoCustomer', 'memoPhone', 'memoItem', 'memoNote', 'memoDeposit'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('memoQty').value = '1';
  document.getElementById('memoStatus').value = '0';
  document.getElementById('memoStatusGrp').style.display = 'block';
  memoSetPay('');   // 不給預設：預設「已結帳」而店員忘了改，取貨時就不會跳「確認已付清」
  document.getElementById('memoSaveBtn').textContent = '確認新增';
  openModal('memoModal');
}
function memoOpenEdit(id) {
  const m = memoList.find(x => x.id === id); if (!m) return;
  closeModal('memoDetModal');
  memoEditingId = id;
  document.getElementById('memoModalTitle').textContent = '編輯門市備忘';
  document.getElementById('memoCustomer').value = m.customer || '';
  document.getElementById('memoPhone').value = m.phone || '';
  document.getElementById('memoItem').value = m.item || '';
  document.getElementById('memoQty').value = m.qty || '';
  document.getElementById('memoNote').value = m.note || '';
  document.getElementById('memoDeposit').value = m.deposit || '';
  document.getElementById('memoStatusGrp').style.display = 'none'; // 狀態一律用推進／退回，留紀錄
  memoSetPay(m.pay || 'unpaid');
  document.getElementById('memoSaveBtn').textContent = '儲存修改';
  openModal('memoModal');
}
async function memoSave() {
  const customer = document.getElementById('memoCustomer').value.trim();
  const item = document.getElementById('memoItem').value.trim();
  if (!customer) { showToast('⚠️ 請填客人稱呼'); return; }
  if (!item) { showToast('⚠️ 請填商品'); return; }
  if (!memoPay) { showToast('⚠️ 請選付款狀態'); return; }
  const data = {
    customer, item,
    phone: document.getElementById('memoPhone').value.trim(),
    qty: document.getElementById('memoQty').value.trim(),
    note: document.getElementById('memoNote').value.trim(),
    pay: memoPay,
    deposit: memoPay === 'deposit' ? (parseInt(document.getElementById('memoDeposit').value) || 0) : 0,
    updatedAt: Date.now(),
  };
  showLoading('儲存中…');
  try {
    if (memoEditingId) {
      await window.db.collection('storeMemos').doc(memoEditingId).update(data);
    } else {
      const st = parseInt(document.getElementById('memoStatus').value) || 0;
      const now = Date.now();
      await window.db.collection('storeMemos').add({
        ...data, store: memoStore || myStore(), status: st,
        log: [{ s: st, by: myName(), at: now }], createdBy: myName(), createdAt: now, closedAt: null,
      });
    }
    closeModal('memoModal');
    showToast(memoEditingId ? '已儲存' : '已新增');
  } catch (e) { alert('儲存失敗：' + e.message); }
  await memoLoad(); renderAll(); hideLoading();
}
async function memoDelete(id) {
  const m = memoList.find(x => x.id === id); if (!m) return;
  if (!confirm(`刪除「${memoTitle(m)}」？\n刪除後無法復原（客人取消、或建錯單時用）。`)) return;
  showLoading('刪除中…');
  try { await window.db.collection('storeMemos').doc(id).delete(); closeModal('memoDetModal'); showToast('已刪除'); }
  catch (e) { alert('刪除失敗：' + e.message); }
  await memoLoad(); renderAll(); hideLoading();
}

// ===== 保證成團的團購留貨（資料在 gb_orders，store-memo.js memoLoadGb）=====
// 一檔一張卡；點開逐人列出，按「已取貨」＝團購〔取貨〕分頁的同一個動作（記已取貨＋已付款）。
// 已到貨、或已成團且到了取貨日（預計到貨日）才能按取貨（store-memo.js memoGbCanPick）。
let memoGbPhone = {};
function memoGbCard(g, i) {
  const w = memoGbWarn(g);
  const st = memoGbStep(g), wait = memoGbWaitText(g);
  return `<div class="todo-card memo-card" onclick="memoGbOpen(${i})">
    <div class="stripe ${w ? 'memo-stale' : 'memo'}"></div>
    <div class="todo-body">
      <div class="todo-title">${memoEsc(memoGbTitle(g))}</div>
      ${memoStepsHtml({ status: st })}
      <div class="todo-foot">
        <span class="tag scope">團購・保證成團</span>
        ${g.deadline && g.arrived ? `<span class="tag scope">取貨到 ${new Date(g.deadline).getMonth() + 1}/${new Date(g.deadline).getDate()}</span>` : ''}
        ${w ? `<span class="tag dl-soon">⚠️ ${w.text}</span>` : ''}
        ${wait ? `<span class="tag scope">${memoEsc(wait)}</span>` : ''}
      </div>
    </div>
  </div>`;
}
async function memoGbOpen(i) {
  const g = memoGbList[i]; if (!g) return;
  // 電話：訂單上手動填的優先，其次客人在 LINE 下單頁留的（gb_customers，員工可讀）
  await Promise.all(g.orders.filter(o => !o.phone && o.line_user_id && memoGbPhone[o.line_user_id] === undefined).map(o =>
    window.db.collection('gb_customers').doc(o.line_user_id).get()
      .then(d => { memoGbPhone[o.line_user_id] = d.exists ? (d.data().phone || '') : ''; })
      .catch(() => { memoGbPhone[o.line_user_id] = ''; })));
  const canPick = memoGbCanPick(g);
  const w = memoGbWarn(g);
  const rows = g.orders.slice().sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''), 'zh-Hant')).map(o => {
    const p = o.phone || (o.line_user_id ? memoGbPhone[o.line_user_id] : '') || '';
    return `<div class="memo-kv" style="align-items:center;gap:8px;">
      <span style="flex:1;min-width:0;"><b>${memoEsc(o.display_name || '客人')}</b> ×${o.qty || 0}${o.paid ? ' <small style="color:#137333;">已付款</small>' : ''}
        <br>${p ? `<a href="tel:${memoEsc(p)}">📞 ${memoEsc(p)}</a>` : '<i>未留電話</i>'}</span>
      ${canPick ? `<button class="det-btn memo-go" style="width:auto;padding:6px 12px;margin:0;" onclick="memoGbPick(${i},'${memoEsc(o.id)}')">✅ 已取貨</button>` : ''}
    </div>`;
  }).join('');
  document.getElementById('memoDetTitle').textContent = memoGbTitle(g);
  document.getElementById('memoDetContent').innerHTML = `
    ${memoStepsHtml({ status: memoGbStep(g) })}
    ${w ? `<div class="memo-warn">⚠️ ${w.text}，請聯絡還沒取的客人</div>` : ''}
    ${canPick ? '' : `<div class="memo-note">${memoEsc(memoGbWaitText(g))}，到時才能按取貨</div>`}
    ${rows}`;
  document.getElementById('memoDetActions').innerHTML =
    `<div class="det-actions"><button class="det-btn" style="background:#f1f3f4;" onclick="location.href='groupbuy.html?tab=pick'">🛒 到團購取貨頁（改付款、棄單）</button></div>`;
  openModal('memoDetModal');
}
async function memoGbPick(i, oid) {
  const g = memoGbList[i]; if (!g) return;
  const o = g.orders.find(x => x.id === oid); if (!o) return;
  const amt = (o.qty || 0) * (g.c.price || 0);
  if (!confirm(o.paid ? `確認「${o.display_name}」已取貨？` : `「${o.display_name}」${g.c.title} ×${o.qty}${amt ? '，應收 $' + amt : ''}\n\n請確認已收款，按「確定」記為已取貨、已付款。`)) return;
  showLoading('更新中…');
  try {
    const fu = firebase.auth().currentUser;
    // 欄位跟團購〔取貨〕分頁 togglePicked 一致；規則 gbPickupOnly 只允許這幾個欄位
    await Promise.race([
      window.db.collection('gb_orders').doc(oid).update({ status: 'picked_up', paid: true,
        picked_up_at: firebase.firestore.FieldValue.serverTimestamp(), picked_up_by: fu ? fu.uid : null,
        updated_at: firebase.firestore.FieldValue.serverTimestamp() }),
      new Promise((_, r) => setTimeout(() => r(new Error('連線逾時，請再試一次')), 10000)),
    ]);
    showToast(`✅ ${o.display_name} 已取貨、已收款`);
  } catch (e) { alert('更新失敗：' + (/permission/i.test(e.message) ? '沒有權限' : e.message)); }
  await memoLoad(); renderAll(); hideLoading();
  const ni = memoGbList.findIndex(x => x.c.id === g.c.id);
  if (ni >= 0) memoGbOpen(ni); else closeModal('memoDetModal');
}
