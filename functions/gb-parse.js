// 團購第 4 階段：門市群組留言的「+1」解析（純函式，2026-10-10）
// 規格書 10.1：符合格式才處理——「+1」「＋1」「+2」，以及「我要」「留 N 個」；數量取訊息中的數字，沒有數字視為 1。
// 不符合的回 null（不存檔、不回應）。刻意保守：一般聊天裡剛好出現數字不能被當成下單。
const CN = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function numOf(s) {
  if (s == null || s === "") return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (CN[s] != null) return CN[s];
  return null;
}
// 多規格（2026-10-11）：總部文案「+1 標記編號」→ 客人打「A+1」「B +2」「(C)+1」「+1 A」，一則也可能寫「A+1 B+2」。
// 編號字母前後不能緊貼英文字（擋 iPhone+1 這種）。
const OPT_BEFORE = /(?:^|[^A-Za-z])[(\[]?([A-Za-z])[)\]]?\s*\+\s*(\d{1,2})(?!\d)/g;
const OPT_AFTER = /(?:^|[^A-Za-z0-9])\+\s*(\d{1,2})\s*[(\[]?([A-Za-z])[)\]]?(?![A-Za-z])/g;
function parseOptions(t) {
  const items = [];
  let m;
  OPT_BEFORE.lastIndex = 0;
  while ((m = OPT_BEFORE.exec(t))) items.push({ opt: m[1].toUpperCase(), qty: parseInt(m[2], 10) });
  if (!items.length) { OPT_AFTER.lastIndex = 0; while ((m = OPT_AFTER.exec(t))) items.push({ opt: m[2].toUpperCase(), qty: parseInt(m[1], 10) }); }
  // 同一個編號寫兩次就加總
  const by = {};
  items.forEach((x) => { by[x.opt] = (by[x.opt] || 0) + x.qty; });
  return Object.keys(by).sort().map((k) => ({ opt: k, qty: by[k] }));
}
/**
 * @param {string} text 群組文字訊息
 * @returns {null | { qty: number, opt: string|null, items: {opt:string|null, qty:number}[], otherStore: string|null }}
 *   items：每個編號一筆；沒標編號時是 [{ opt: null, qty }]
 */
function parsePlus(text) {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC").replace(/\s+/g, " ").trim();   // 全形＋１ → +1
  if (!t || t.length > 40) return null;                              // 長訊息多半是聊天，不處理
  const om0 = t.match(/(美德|聯鑫|錦花)/);
  const opts = parseOptions(t);
  if (opts.length) {
    if (opts.some((x) => x.qty < 1 || x.qty > 99)) return null;
    return { qty: opts.reduce((a, x) => a + x.qty, 0), opt: opts.length === 1 ? opts[0].opt : null, items: opts, otherStore: om0 ? om0[1] : null };
  }
  let qty = null;
  // 「+N」開頭（後面不能再接數字：擋 +886 電話、+100）或「…… +N」「藍莓汁+1」結尾（中文字後直接接 +N 也算，2026-10-11）
  let m = t.match(/^\+ ?(\d{1,2})(?!\d)/) || t.match(/(?:^|[\s㐀-鿿])\+ ?(\d{1,2})$/);
  if (m) qty = parseInt(m[1], 10);
  if (qty == null) {
    m = t.match(/^(?:我要|我也要|要)\s*([0-9一二兩三四五六七八九十]{0,2})\s*(?:個|份|盒|包|組)?(?:\s|$|[!！~～。.])/);
    if (m) qty = numOf(m[1]) ?? 1;
  }
  if (qty == null) {
    m = t.match(/(?:^|\s)(?:幫我)?留\s*([0-9一二兩三四五六七八九十]{1,2})\s*(?:個|份|盒|包|組)/);
    if (m) qty = numOf(m[1]);
  }
  if (qty == null || qty < 1 || qty > 99) return null;
  return { qty, opt: null, items: [{ opt: null, qty }], otherStore: om0 ? om0[1] : null };
}
module.exports = { parsePlus };
