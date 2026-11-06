// 類別毛利（總部「類別進貨毛利分析表 II」，PSR501D 純進貨 PMA II 未稅）— 2026-11-06 使用者定案
// 資料：stores/{店}/categoryGp/{YYYY-MM} = { month, rows:[{code,name,cost,retail,share,gp,contrib,yoy_gp,yoy_contrib}], total:{同欄位}, source }
// 只有拍照給 Claude 抄錄、各類別加總跟合計對得上才寫入（目前只有美德固定拍）；前端只讀，沒有輸入畫面。
// 用在：加盟主儀表板「類別毛利」卡、每日營業分析「這個月要顧的 3 個數字」「下個月季節提醒」（店長以上）。
// ⚠️ 合計毛利率已扣 96 變價（促銷折讓）、97 壞品，跟損益表毛利率口徑不同。
// ⚠️ 46 CITY CAFE 要跟 96 變價合起來看：咖啡優惠有時記在咖啡、有時記在變價（2026-08～10 合計 −12.9／−12.1／−12.3）。
var CG_SKIP = { '38': 1, '46': 1, '88': 1, '96': 1, '97': 1 };   // 季節提醒／異常不看：香菸、咖啡（要跟變價合看）、贈品、變價、壞品
// 店長每月要顧的數字（2026-11-06 使用者選：米飯、零食占比、關東煮毛利率）
var CG_FOCUS = [{ code: '65', key: 'share', label: '米飯占營收' }, { code: '27', key: 'share', label: '零食占營收' }, { code: '66', key: 'gp', label: '關東煮毛利率' }];

function cgAddMonth(ym, k) { var d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + k, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function cgMon(ym) { return +ym.slice(5, 7) + ' 月'; }
async function cgLoad(db, store) {
  var out = {};
  try { (await db.collection('stores').doc(store).collection('categoryGp').get()).forEach(function (d) { out[d.id] = d.data(); }); } catch (e) { console.warn('[categoryGp]', store, e && e.message); }
  return out;
}
function cgRow(doc, code) { return doc && (doc.rows || []).find(function (r) { return r.code === code; }) || null; }
function cgLatest(data) { var ks = Object.keys(data || {}).filter(function (k) { return /^\d{4}-\d{2}$/.test(k); }).sort(); return ks.length ? ks[ks.length - 1] : null; }
/** 咖啡＋變價的合計貢獻（分開看會誤判） */
function cgCafeMix(doc) { var a = cgRow(doc, '46'), b = cgRow(doc, '96'); return a && b ? +a.contrib + +b.contrib : null; }
/** 賺錢前 n 類（依貢獻） */
function cgTop(doc, n) {
  return (doc.rows || []).filter(function (r) { return r.code !== '96' && r.code !== '97'; }).sort(function (a, b) { return b.contrib - a.contrib; }).slice(0, n || 3);
}
/** 異常：占營收 ≥ 0.5%、毛利率比去年低 5 個百分點以上（香菸、咖啡、贈品、變價、壞品不算） */
function cgAlerts(doc) {
  return (doc.rows || []).filter(function (r) { return !CG_SKIP[r.code] && r.share >= 0.5 && r.yoy_gp <= -5; }).sort(function (a, b) { return a.yoy_gp - b.yoy_gp; });
}
/** 這個月要顧的數字：最新一個月的值、前一個月、去年同一個「這個月」 */
function cgFocus(data, cur) {
  var L = cgLatest(data); if (!L) return null;
  var P = cgAddMonth(L, -1), Y = cgAddMonth(cur, -12);
  var items = CG_FOCUS.map(function (f) {
    var a = cgRow(data[L], f.code); if (!a) return null;
    var p = cgRow(data[P], f.code), y = cgRow(data[Y], f.code);
    var val = function (r) { return !r || (f.key === 'gp' && !(+r.retail > 0)) ? null : +r[f.key]; };   // 沒有銷售的月份毛利率不算（關東煮夏天停賣）
    return { label: f.label, v: val(a), prev: val(p), ly: val(y) };
  }).filter(Boolean);
  return items.length ? { latest: L, prevYm: P, lyYm: Y, items: items } : null;
}
/** 下個月季節提醒：去年「下個月」比去年「這個月」占比變化大的類別（≥1.5 倍要備貨、≤0.7 倍要減量；去年占比要 ≥2%） */
function cgSeason(data, cur) {
  var A = data[cgAddMonth(cur, -12)], B = data[cgAddMonth(cur, -11)];
  if (!A || !B) return null;
  var tips = [];
  (B.rows || []).forEach(function (b) {
    if (CG_SKIP[b.code]) return;
    var a = cgRow(A, b.code); if (!a || !(+a.share > 0)) return;
    var r = +b.share / +a.share;
    if (r >= 1.5 && +b.share >= 2) tips.push({ up: true, name: b.name, from: +a.share, to: +b.share, r: r });
    else if (r <= 0.7 && +a.share >= 2) tips.push({ up: false, name: b.name, from: +a.share, to: +b.share, r: r });
  });
  tips.sort(function (x, y) { return Math.abs(Math.log(y.r)) - Math.abs(Math.log(x.r)); });
  return { thisM: cgAddMonth(cur, -12), nextM: cgAddMonth(cur, -11), tips: tips.slice(0, 3) };
}
function cgTipText(t, nextM) {
  var m = +nextM.slice(5, 7), pm = m === 1 ? 12 : m - 1;
  return t.up ? '去年 ' + m + ' 月「' + t.name + '」占營收 ' + t.to.toFixed(1) + '%，是 ' + pm + ' 月的 ' + t.r.toFixed(1) + ' 倍：這個月下旬開始備貨'
    : '去年 ' + m + ' 月「' + t.name + '」占營收從 ' + t.from.toFixed(1) + '% 掉到 ' + t.to.toFixed(1) + '%：下個月訂量往下調';
}
