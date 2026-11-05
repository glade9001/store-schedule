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
// ---- 轉發的總部圖文 → 對應到哪一檔團購（2026-11-06 使用者：先建團購、再轉發總部圖文，客人回覆那則 +1 機器人對不到）----
// 開團時「自動填表」貼的就是總部原文（campaign.description），轉發到群組的是同一段字 → 比對文字相似度。
// 只留中英數字比（表情、標點、空白、換行在轉貼／自動填表時常被改掉）；兩段取「共同的兩字組 ÷ 較短那段」，
// 所以只轉發一部分也對得到。太短（< POST_MIN_LEN 字）不比，避免聊天短句誤判。
// Codex 2026-11-06：只拿一小段就命中太寬 → 至少 POST_MIN_LEN 字，且要有說明全文的 POST_COVER 以上長度
const POST_MIN_LEN = 25, POST_MATCH = 0.6, POST_MARGIN = 0.1, POST_COVER = 0.4;
function postNorm(s) { return String(s || "").normalize("NFKC").toLowerCase().replace(/[^0-9a-z\u3400-\u9fff]/g, ""); }
function bigrams(s) { const b = new Set(); for (let i = 0; i < s.length - 1; i++) b.add(s.slice(i, i + 2)); return b; }
/**
 * @param {string} text 群組文字訊息
 * @param {{key:string, desc:string}[]} list 候選（同一組規格／同系列要給同一個 key）
 * @returns {string|null} 對到的 key；最像的兩檔太接近（POST_MARGIN 內）就不猜
 */
function postLongEnough(text) { return postNorm(text).length >= POST_MIN_LEN; }
function matchPost(text, list) {
  const a = postNorm(text); if (a.length < POST_MIN_LEN) return null;
  const A = bigrams(a), best = {};
  (list || []).forEach((x) => {
    const b = postNorm(x.desc); if (b.length < POST_MIN_LEN || a.length < b.length * POST_COVER) return;
    const B = bigrams(b); let n = 0; A.forEach((g) => { if (B.has(g)) n++; });
    const sc = n / Math.min(A.size, B.size);
    if (!(best[x.key] >= sc)) best[x.key] = sc;
  });
  const r = Object.entries(best).sort((x, y) => y[1] - x[1]);
  if (!r.length || r[0][1] < POST_MATCH) return null;
  if (r[1] && r[0][1] - r[1][1] < POST_MARGIN) return null;
  return r[0][0];
}
module.exports = { parsePlus, matchPost, postLongEnough };
