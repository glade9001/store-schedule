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
