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
    const orders = sn.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.status === 'active');
    return { c, orders, qty: orders.reduce((t, o) => t + (o.qty || 0), 0),
      deadline: memoGbMs(c.pickup_deadline), arrived: c.status === 'arrived' };
  }));
  return out.filter(g => g.orders.length).sort((a, b) => (b.arrived - a.arrived) || ((a.deadline || 9e15) - (b.deadline || 9e15)));
}
function memoGbStatus(g) { return g.arrived ? STORE_MEMO.STATUS[2] : STORE_MEMO.STATUS[1]; }
/** 取貨期限警示：過期 → 紅；36 小時內 → 橘；其他 null */
function memoGbWarn(g) {
  if (!g.arrived || !g.deadline) return null;
  const left = g.deadline - Date.now();
  if (left < 0) return { late: true, text: '已過取貨期限' };
  if (left <= 36 * 3600000) return { late: false, text: '取貨期限剩 ' + Math.max(1, Math.round(left / 3600000)) + ' 小時' };
  return null;
}
function memoGbTitle(g) {
  return `🛒 ${g.c.title || ''}・留貨 ${g.qty} 份（未取 ${g.orders.length} 人）`;
}
