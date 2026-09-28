// ===== 循環代辦：下次發生日／當期（2026-09-28）=====
// 代辦頁（todo-page.js）與首頁（home-page.js）共用。原本兩頁各寫一份，首頁那份的「當期」判斷寫錯，
// 每月 7 號前自檢只要勾過一次，首頁之後每個月都不再出現。改判斷只改這裡。
// ⚠️ 日期字串一律用本地時間解析：new Date('2026-10-05') 是 UTC 午夜＝台灣早上 8 點，
//    跟本地午夜比會讓「開始日當天」被判成還沒開始、跳到下一次（兩份舊寫法都有這個問題）。
// 名稱都帶 tr 前綴（頁面頂層撞名會讓整頁全滅）。

function trParseDay(s) {
  if (!s) return null;
  if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  var p = String(s).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}
function trFmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
/** 從 from（預設今天）起，下一次（或當天）發生的日期；沒有下一次回 null */
function trCalcNext(todo, from) {
  var base = trParseDay(from || new Date());
  var start = todo.startDate ? trParseDay(todo.startDate) : base;
  var end = todo.recurringEnd ? trParseDay(todo.recurringEnd) : null;
  if (end && base > end) return null;
  var next = null;
  if (todo.recurringType === 'weekly') {
    var tgt = parseInt(todo.recurringDay || 1);
    var dow = base.getDay() === 0 ? 7 : base.getDay();
    var diff = tgt - dow; if (diff < 0) diff += 7;
    next = new Date(base); next.setDate(base.getDate() + diff);
    while (next < start) next.setDate(next.getDate() + 7);
  } else if (todo.recurringType === 'monthly') {
    var isLast = (todo.recurringDay === 'last' || parseInt(todo.recurringDay) === 0);
    var dayOf = function (yr, mo) { return isLast ? new Date(yr, mo + 1, 0).getDate() : Math.min(parseInt(todo.recurringDay || 1), new Date(yr, mo + 1, 0).getDate()); };
    next = new Date(base.getFullYear(), base.getMonth(), dayOf(base.getFullYear(), base.getMonth()));
    if (next < base) { var y = base.getFullYear(), m = base.getMonth() + 1; next = new Date(y, m, dayOf(y, m)); }
    while (next < start) { var y2 = next.getFullYear(), m2 = next.getMonth() + 1; next = new Date(y2, m2, dayOf(y2, m2)); }
  } else if (todo.recurringType === 'custom') {
    var iv = parseInt(todo.recurringInterval || 7);
    next = new Date(start);
    while (next < base) next.setDate(next.getDate() + iv);
  }
  if (!next || (end && next > end)) return null;
  return next;
}
function trNextStr(todo, from) {
  var d = trCalcNext(todo, from);
  return d ? trFmt(d) : null;
}
/**
 * 勾選紀錄的「當期」key（todoChecks.checkKey）：
 *   非循環＝id；每月型＝id__YYYY-MM（完成後該月消失、下月自動重現）；其他循環＝id__下次發生日
 */
function trPeriodKey(todo) {
  if (!todo.isRecurring) return todo.id;
  if (todo.recurringType === 'monthly') { var n = new Date(); return todo.id + '__' + n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0'); }
  var s = trNextStr(todo);
  return s ? todo.id + '__' + s : todo.id;
}
