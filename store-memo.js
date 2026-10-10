// ===== 門市備忘（客訂／留貨單，2026-09-25）=====
// 例：客人已結帳但貨還欠著、或訂了貨還沒結帳 → 待訂貨 → 已訂貨 → 已到貨留貨 → 已取貨（結案）。
// 跟代辦不同：狀態是「全店共用一份」（代辦的勾選是每人各自一份，一人交貨了其他人還掛著）。
// 資料：storeMemos/{id}，規則只讓該門市的人讀（加盟主／admin 全部）；刪除限店長以上。
// 電話在結案 14 天後由 scheduledMemoPhoneCleanup 清掉。
// 本檔首頁與代辦頁共用（代辦頁專用的畫面在 todo-memo.js）；全部名稱都帶 memo／STORE_MEMO 前綴，避免與頁面既有頂層名稱撞名（撞名會讓整頁全滅）。
const STORE_MEMO = {
  STATUS: ['待訂貨', '已訂貨', '已到貨留貨', '已取貨'],
  ICON: ['📝', '🚚', '📦', '✅'],
  PAY: { paid: '已結帳', unpaid: '未結帳', deposit: '付訂金' },
  // 放太久要被點名：已訂貨 N 天沒到貨（追廠商）、到貨留貨 N 天沒來拿（聯絡客人）
  STALE_DAYS: { 1: 10, 2: 7 },
  CLOSED_SHOW_DAYS: 30,
};
function memoEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 進入目前這一步的時間（ms）
function memoStepAt(m) {
  const log = m.log || [];
  for (let i = log.length - 1; i >= 0; i--) if (log[i].s === m.status) return log[i].at;
  return m.createdAt || null;
}
// 放太久 → { days, text }；沒事回 null
function memoStale(m) {
  const lim = STORE_MEMO.STALE_DAYS[m.status];
  const at = memoStepAt(m);
  if (!lim || !at) return null;
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days < lim) return null;
  return { days, text: m.status === 1 ? `訂貨 ${days} 天還沒到` : `留貨 ${days} 天還沒來拿` };
}
function memoPayText(m) {
  if (m.pay === 'deposit') return `付訂金${m.deposit ? ' $' + m.deposit : ''}`;
  return STORE_MEMO.PAY[m.pay] || '未結帳';
}
function memoTitle(m) {
  return `${m.customer || '客人'}・${m.item || ''}${m.qty && String(m.qty) !== '1' ? ' ×' + m.qty : ''}`;
}
async function memoLoadOpen(store) {
  const snap = await window.db.collection('storeMemos').where('store', '==', store).get();
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// ===== 保證成團的團購訂單也列進留貨單（2026-10-10 使用者：保證成團就是門市自己的貨，例如藍莓汁）=====
// 不複製資料：直接讀 gb_orders 的「待取貨」，按「已取貨」寫回訂單——跟團購頁〔取貨〕分頁是同一份，不會兩邊不同步。
// 首頁一檔一行（不算件數），代辦頁點開才逐人列出。達標成團的團不列（還不確定會不會成團）。
const MEMO_GB_CODE = { '美德': 'meide', '聯鑫': 'lianxin', '錦花': 'jinhua' };
function memoGbMs(ts) { return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : (ts && ts.seconds ? ts.seconds * 1000 : 0); }
/** 本店保證成團、還有人沒取的團 → [{ c, orders(待取貨), qty, deadline(ms|0), arrived }] */
async function memoLoadGb(store) {
  const code = MEMO_GB_CODE[store];
  if (!code) return [];
  const cs = await window.db.collection('gb_campaigns').where('status', 'in', ['open', 'closed', 'success', 'arrived']).get();
  const camps = cs.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.success_rule !== 'threshold' && c.is_test !== true && (c.available_stores || []).indexOf(code) >= 0);
  // 每檔各查一次（campaign_id＋store 兩個等號條件，不需要複合索引；規則要求查詢帶門市）
  const out = await Promise.all(camps.map(async c => {
    const sn = await window.db.collection('gb_orders').where('campaign_id', '==', c.id).where('store', '==', code).get();
    const all = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    const orders = all.filter(o => o.status === 'active');
    // 已取消的也帶著（2026-10-10 使用者：客人取消要讓店員看到紀錄，不然會以為單不見了）
    const cancelled = all.filter(o => o.status === 'cancelled').sort((a, b) => memoGbMs(b.cancelled_at) - memoGbMs(a.cancelled_at));
    return { c, orders, cancelled, qty: orders.reduce((t, o) => t + (o.qty || 0), 0),
      deadline: memoGbMs(c.pickup_deadline), arrival: memoGbMs(c.arrival_date), arrived: c.status === 'arrived' };
  }));
  // 還有人沒取；或全都取消了但取消在 3 天內（讓店員看得到為什麼不見了）
  const recent = Date.now() - 3 * 86400000;
  return out.filter(g => g.orders.length || g.cancelled.some(o => memoGbMs(o.cancelled_at) >= recent)).sort((a, b) => (b.arrived - a.arrived) || ((a.deadline || 9e15) - (b.deadline || 9e15)));
}
// 狀態跟著團購自動走（2026-10-10 使用者）：開放／截單＝待訂貨（門市不一定有貨）、成團＝已訂貨、到貨＝已到貨留貨
function memoGbStep(g) { return g.arrived ? 2 : g.c.status === 'success' ? 1 : 0; }
function memoGbStatus(g) { return STORE_MEMO.STATUS[memoGbStep(g)]; }
function memoGbMd(ms) { const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); }
// 可以按「已取貨」：已到貨；或已成團且有設取貨日（預計到貨日）、今天已到取貨日（使用者：取貨日開始才能來門市結帳）
function memoGbCanPick(g) {
  if (g.arrived) return true;
  if (g.c.status !== 'success' || !g.arrival) return false;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return g.arrival <= t.getTime() + 86399999;
}
// 還不能取時的說明；可以取就回空字串
function memoGbWaitText(g) {
  if (memoGbCanPick(g)) return '';
  if (g.arrival) return memoGbMd(g.arrival) + ' 起可取貨結帳';
  return g.c.status === 'success' ? '到貨後才能取貨結帳' : g.c.status === 'open' ? '還在開放下單，成團後才叫貨' : '等結算，成團後才叫貨';
}
/** 取貨期限警示：過期 → 紅；36 小時內 → 橘；其他 null */
function memoGbWarn(g) {
  if (!g.arrived || !g.deadline) return null;
  const left = g.deadline - Date.now();
  if (left < 0) return { late: true, text: '已過取貨期限' };
  if (left <= 36 * 3600000) return { late: false, text: '取貨期限剩 ' + Math.max(1, Math.round(left / 3600000)) + ' 小時' };
  return null;
}
function memoGbTitle(g) {
  return `🛒 ${g.c.title || ''}・留貨 ${g.qty} 份（未取 ${g.orders.length} 人${g.cancelled.length ? '・取消 ' + g.cancelled.length + ' 筆' : ''}）`;
}
function memoGbCancelText(o) {
  const t = memoGbMs(o.cancelled_at), d = new Date(t);
  return (o.cancelled_by === 'customer' ? '客人自己取消' : '店員取消') +
    (t ? ` ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '');
}
