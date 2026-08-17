/**
 * 班別字串解析 —— 前端唯一版本
 *
 * 班別文法（與 schedule-V2 validateShiftFormat 同一套，勿各自再寫正則）：
 *   「開始-結束」，小時可帶小數 .25/.5/.75；兩頭班用逗號分隔。
 *   例：7-15、08-16、23.5-07.5、7-11,17-21
 *   結束 <= 開始 視為跨夜，下班時刻推到隔天（endH 會 > 24）。
 *   非時間班別（排休/指休/特休/補休/作帳…）一律回空陣列。
 *
 * ⚠️ 為什麼要有這個檔（2026-08-17）：
 *   原本 clock/home/attendance/functions 各自寫 /^(\d{1,2})-(\d{1,2})$/，
 *   「半點班」(23.5-07.5、7.5-15.5) 一律匹配失敗被當成沒排班 —— 三店約一成班別中招。
 *   後果：打卡頁顯示「無排班」→ 打卡被記成「到場」、attendance.shift 寫入空字串
 *   （遲到早退判不出來）、缺卡偵測與打卡提醒整批漏發、出勤表排班時數算成 0。
 *
 * ⚠️ 後端 functions/index.js 有一份同語意的副本（Node 不吃這支檔），改這裡請一併改那邊。
 *
 * 本檔刻意「只有 function 宣告、沒有任何頂層 const/let/class」——
 * 這樣任何頁面掛上來都不會撞名把整段 script 打掛。新增內容請維持這個限制。
 */

/**
 * 班別字串 → 時段陣列
 * @param {string} shiftStr 例 '23.5-07.5'、'7-11,17-21'
 * @returns {Array<{startH:number,endH:number,durH:number}>} 非時間班別回 []
 */
function parseShiftSegs(shiftStr) {
  var s = String(shiftStr == null ? '' : shiftStr).trim();
  if (!s || !/\d/.test(s)) return [];
  var segs = s.split(',');
  var out = [];
  for (var i = 0; i < segs.length; i++) {
    var m = segs[i].trim().match(/^(\d{1,2}(?:\.\d+)?)-(\d{1,2}(?:\.\d+)?)$/);
    if (!m) return []; // 任一段不合法 → 整串都不當成時間班別（寧可少判，不要半套）
    var startH = parseFloat(m[1]);
    var endH = parseFloat(m[2]);
    if (!isFinite(startH) || !isFinite(endH)) return [];
    if (endH <= startH) endH += 24; // 跨夜
    out.push({ startH: startH, endH: endH, durH: endH - startH });
  }
  return out;
}

/** 排定時數（兩頭班逐段加總）；非時間班別回 0 */
function shiftTotalHours(shiftStr) {
  var segs = parseShiftSegs(shiftStr);
  var t = 0;
  for (var i = 0; i < segs.length; i++) t += segs[i].durH;
  return t;
}

/** 第一段上班 / 最後一段下班的時刻（小時，跨夜 endH > 24）；非時間班別回 null */
function shiftSpan(shiftStr) {
  var segs = parseShiftSegs(shiftStr);
  if (!segs.length) return null;
  return { startH: segs[0].startH, endH: segs[segs.length - 1].endH };
}

/**
 * 下班是否落在隔天（含正好 24:00 收班的 16-00：下班卡會打在隔天日期上，
 * 出勤/缺卡一律當跨日班處理，與舊行為 `end <= start` 相同）
 */
function shiftIsOvernight(shiftStr) {
  var sp = shiftSpan(shiftStr);
  return !!sp && sp.endH >= 24;
}

/**
 * 台北時區絕對毫秒：dateStr 當日 00:00 起算第 hours 小時
 * hours 可含小數、可 > 24（跨夜班的下班時刻）
 */
function shiftTimeMs(dateStr, hours) {
  var base = Date.parse(String(dateStr) + 'T00:00:00+08:00');
  return isFinite(base) ? base + hours * 3600000 : NaN;
}

/**
 * 日期字串 → 週文件 id（stores/{店}/weeks/{此值}）
 * 必須是 schedule-V2 getWeekDates() 的精準反函式：每週以「週一」起算。
 * ⚠️ 別自己重寫：舊公式把含時間的日期直接套年度週次，每個週六/週日都會算成下一週。
 */
function shiftWeekStr(dateStr) {
  var p = String(dateStr).split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 退到該日所屬的週一
  var yr = d.getFullYear();
  var w1 = function (y) { var a = new Date(y, 0, 1), k = a.getDay(); a.setDate(a.getDate() + (k <= 4 ? 1 - k : 8 - k)); return a; };
  if (d < w1(yr)) yr--; else if (d >= w1(yr + 1)) yr++;
  var w = Math.round((d - w1(yr)) / 604800000) + 1;
  return yr + '-W' + (w < 10 ? '0' + w : w);
}

/** 日期字串 → 班表用的星期名（週一…週日），對應 weeks records 的 day 欄位 */
function shiftDayName(dateStr) {
  var p = String(dateStr).split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  return ['週一', '週二', '週三', '週四', '週五', '週六', '週日'][(d.getDay() + 6) % 7];
}

/** 日期字串位移 n 天 → YYYY-MM-DD */
function shiftDateAdd(dateStr, n) {
  var p = String(dateStr).split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
