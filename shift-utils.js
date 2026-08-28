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

/**
 * ===== 打卡判定規則（2026-08-28 集中化）=====
 *
 * ⚠️ 為什麼要集中：這兩條規則原本散在 7 處（配對視窗）與 4 處（遲到採計），
 *    每次改都要靠「記得還有哪幾處」。半點班那次已經示範過代價——同一條正則寫在 11 個地方，
 *    改漏一處就讓整條打卡鏈失效。記憶裡出現「N 處必須一致」就等於登記了一個未來的 bug。
 *
 * ⚠️ 後端 functions/index.js 有一份同語意副本（Node 不吃這支檔）。
 *    `node tools/check-clock-rules.js` 會對拍兩份是否等價，改任一邊都要跑。
 *
 * 註：本檔規定「只有 function 宣告、沒有頂層 const」，所以視窗常數用函式回傳而非 const。
 */

/** 打卡配對視窗（毫秒）—— 全系統唯一定義處 */
function punchWindowMs() {
  return {
    inBefore: 1 * 3600000,   // 上班：排定開始前 1 小時
    inAfter: 4 * 3600000,    // 上班：排定開始後 4 小時
    outBefore: 4 * 3600000,  // 下班：排定結束前 4 小時
    // 下班後 3 小時（2026-08-17 由 +1h 放寬）：人常收完店走到門口才想到打卡，
    // 超過就配不到班、被記成「到場」不計工時，還得走補登。
    outAfter: 3 * 3600000,
  };
}

/**
 * 從候選班段挑出這筆打卡該歸屬的班（取視窗內最接近的一段）
 * @param {Array<{shift:string,shiftDate:string,startMs:number,endMs:number}>} cands
 * @param {number} punchMs 打卡時間（絕對毫秒）
 * @param {string} type '上班' | '下班'
 * @returns {object|null} 命中的候選；null＝落在視窗外（狀態應判「到場」）
 */
function matchPunchShift(cands, punchMs, type) {
  var w = punchWindowMs();
  var isIn = (type === '上班');
  var win = [];
  for (var i = 0; i < (cands || []).length; i++) {
    var c = cands[i];
    var lo = isIn ? c.startMs - w.inBefore : c.endMs - w.outBefore;
    var hi = isIn ? c.startMs + w.inAfter : c.endMs + w.outAfter;
    if (punchMs >= lo && punchMs <= hi) win.push(c);
  }
  if (!win.length) return null;
  win.sort(function (a, b) {
    var ka = isIn ? a.startMs : a.endMs;
    var kb = isIn ? b.startMs : b.endMs;
    return Math.abs(punchMs - ka) - Math.abs(punchMs - kb);
  });
  return win[0];
}

/**
 * 遲到分鐘數 —— 採計到分、無條件捨去
 * ⚠️ 不可用 Math.round：畫面顯示的打卡時間是截斷到分（ISO slice(11,16)），
 *    07:00:30 顯示「07:00」卻被 round 成遲到 1 分 → 顯示與判定不一致（2026-08-28 修）。
 *    未滿 01 分 00 秒＝準時。
 */
function lateMinutesOf(punchMs, startMs) {
  if (!isFinite(punchMs) || !isFinite(startMs)) return 0;
  return Math.max(0, Math.floor((punchMs - startMs) / 60000));
}

/** 遲到分鐘 + 門市容許值 → 打卡狀態（容許值內＝「警告」，不列入出勤異常） */
function punchLateStatus(lateMin, tolMin) {
  var tol = (tolMin == null ? 10 : tolMin);
  if (lateMin > tol) return '遲到';
  if (lateMin > 0) return '警告';
  return '正常';
}
