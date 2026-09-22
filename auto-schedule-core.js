/**
 * 自動排班核心 —— 設定資料模型、歷史推算（第 1 步），之後的草稿產生器（第 2 步）也放這裡。
 *
 * 設定存在 stores/{store}/config/autoSchedule：
 *   demand : { 週一: [{s:7, e:15, n:2}, …], …週日 }
 *            各時段需要幾個人。s/e 是「小時」，0.5 為單位；一天的軸從 07:00 到隔天 07:00，
 *            所以 s/e 落在 7～31 之間（23:00～隔天 07:00 存成 {s:23, e:31}）。
 *            可選 min＝最少人數（沒寫＝n）：人數在 min～n 之間只提醒、不開待補；少於 min 才開 🆘 待補。
 *              例：美德平日 7-8 點 n:2 min:1（偶爾一人可以），週一 n:2（盡量不要一人）。
 *            ⚠️ 不存「班別組合」：週六工讀排 8-15 還是 16-23 要看正職上哪班，組合寫死就表達不了。
 *   seasons: { summer:{from:'07-01', to:'08-31'}, winter:{from:'01-20', to:'02-20'} }  每年重複的 MM-DD
 *   staff  : { 員工名: { auto:true, term:['18-23',…], vacation:['15-23',…], note:'' } }
 *            term＝學期中、vacation＝寒暑假可上的班別，第一個＝主力。auto=false＝不自動排、由店長手動排（如楷岳）。
 *            maxDays / maxHours＝每週最多幾天／幾小時（null＝不限；正職另有 40 小時上限）。草稿不會超過，
 *              營運需要超過時由店長手動排（排班頁「知情放行」留紀錄）。
 *            termDays / vacationDays＝逐日例外：{ 週二:'off', 週三:['15-23'] }
 *              'off'＝那天不能上；陣列＝那天只能上這些班；沒寫的日子照整季的 term / vacation。
 *              （學生每學期課表不同，例：小羊這學期週二、四不能上，週三只能 15-23）
 *
 * 依賴 shift-utils.js（parseShiftSegs / shiftWeekStr / shiftDateAdd），班別文法只認那一份。
 * 本檔只有 function 宣告、沒有頂層 const/let —— 任何頁面掛上來都不會撞名。
 */

function asDayNames() { return ['週一', '週二', '週三', '週四', '週五', '週六', '週日']; }
function asOffShifts() { return ['排休', '指休', '特休', '補休']; }
/** 一天的軸：07:00 → 隔天 07:00，0.5 小時一格共 48 格 */
function asAxisStart() { return 7; }
function asSlots() { return 48; }

function asDefaultConfig() {
  var demand = {};
  asDayNames().forEach(function (d) { demand[d] = []; });
  return {
    version: 1,
    demand: demand,
    seasons: { summer: { from: '07-01', to: '08-31' }, winter: { from: '01-20', to: '02-20' } },
    staff: {}
  };
}

/** 班別字串正規化：'07-15' → '7-15'、'23-07' → '23-7'；非時間班別回 ''。 */
function asNormShift(s) {
  var segs = parseShiftSegs(s);
  if (!segs.length) return '';
  return segs.map(function (g) {
    // 16-0 收在午夜，照店裡寫法存 '16-0'；但 7-24 這種長時段（正職寫的可上範圍）保留 24，存成 '7-0' 會看不懂
    var e = g.endH > 24 || (g.endH === 24 && g.durH < 12) ? g.endH - 24 : g.endH;
    return asFmtNum(g.startH) + '-' + asFmtNum(e);
  }).join(',');
}
function asFmtNum(h) { return String(Math.round(h * 100) / 100); }

/** 軸上的小時 → 顯示文字：7 → '07:00'、23.5 → '23:30'、31 → '隔天 07:00' */
function asHourLabel(h) {
  var next = h >= 24;
  var x = next ? h - 24 : h;
  var hh = Math.floor(x), mm = Math.round((x - hh) * 60);
  return (next && h > 24 ? '隔天 ' : '') + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** 週次 → 該週週一 'YYYY-MM-DD'（shiftWeekStr 的反函式；以 ISO 規則，與 schedule 的 week1MondayOf 同一套） */
function asWeekMonday(weekStr) {
  var p = String(weekStr).split('-W');
  var yr = +p[0], wk = +p[1];
  var a = new Date(yr, 0, 1), k = a.getDay();
  a.setDate(a.getDate() + (k <= 4 ? 1 - k : 8 - k) + (wk - 1) * 7);
  return a.getFullYear() + '-' + String(a.getMonth() + 1).padStart(2, '0') + '-' + String(a.getDate()).padStart(2, '0');
}
function asRecordDate(weekStr, dayName) {
  var i = asDayNames().indexOf(dayName);
  return i < 0 ? '' : shiftDateAdd(asWeekMonday(weekStr), i);
}

/** 寒暑假分季開關：先關閉（設定頁與草稿都只用「學期中」那一份可上班別） */
function asSeasonsEnabled() { return false; }

/** 某日期屬於學期中('term')還是寒暑假('vacation')。範圍可跨年（例 12-25～02-20）。 */
function asSeasonOf(dateStr, seasons) {
  // 寒暑假功能先全面隱藏（使用者 2026-09-22，含美德）：一律當學期中。設定裡的寒暑假資料保留，之後開啟再用
  if (!asSeasonsEnabled()) return 'term';
  var md = String(dateStr).slice(5);
  var s = seasons || {};
  var inRange = function (r) {
    if (!r || !r.from || !r.to) return false;
    return r.from <= r.to ? (md >= r.from && md <= r.to) : (md >= r.from || md <= r.to);
  };
  return (inRange(s.summer) || inRange(s.winter)) ? 'vacation' : 'term';
}

/**
 * 班別 → 當天軸上佔用的格子索引（0～47）。
 * 早於 07:00 開始的班（例 0-8）屬於前一晚的大夜，推到軸的尾端；超出軸的部分截掉。
 */
function asShiftSlots(shiftStr) {
  var out = [];
  parseShiftSegs(shiftStr).forEach(function (g) {
    var s = g.startH, e = g.endH;
    if (s < asAxisStart()) { s += 24; e += 24; }
    for (var h = s; h < e; h += 0.5) {
      var i = Math.round((h - asAxisStart()) * 2);
      if (i >= 0 && i < asSlots()) out.push(i);
    }
  });
  return out;
}

/**
 * 班別延伸到「隔天軸」的格子：23-8 這種大夜在隔天 07:00～08:00 仍在場，
 * 軸在 07:00 切日，這一段要算給隔天（否則隔天 7-8 點會少算一人——2026-09-22 踩到）。
 */
function asShiftSpillSlots(shiftStr) {
  var out = [];
  parseShiftSegs(shiftStr).forEach(function (g) {
    var s = g.startH, e = g.endH;
    if (s < asAxisStart()) { s += 24; e += 24; }
    var end = asAxisStart() + 24;
    for (var h = Math.max(s, end); h < e; h += 0.5) {
      var i = Math.round((h - end) * 2);
      if (i >= 0 && i < asSlots()) out.push(i);
    }
  });
  return out;
}

/** 需求時段 [{s,e,n}] → 48 格人數陣列 */
function asDemandToSlots(bands) {
  var arr = new Array(asSlots()).fill(0);
  (bands || []).forEach(function (b) {
    for (var h = b.s; h < b.e; h += 0.5) {
      var i = Math.round((h - asAxisStart()) * 2);
      if (i >= 0 && i < asSlots()) arr[i] = Math.max(arr[i], +b.n || 0);
    }
  });
  return arr;
}
/** 48 格人數陣列 → 需求時段（相鄰同人數合併；0 人不存） */
function asSlotsToDemand(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var n = arr[i];
    if (!n) continue;
    var h = asAxisStart() + i / 2;
    var last = out[out.length - 1];
    if (last && last.n === n && last.e === h) last.e = h + 0.5;
    else out.push({ s: h, e: h + 0.5, n: n });
  }
  return out;
}

function asIsWorkShift(shift) {
  return !!shift && asOffShifts().indexOf(shift) < 0 && parseShiftSegs(shift).length > 0;
}
/** 支援別店的整日外派格（loc=支援X）是衍生顯示，不算本店人力 */
function asIsHomeRecord(r) {
  return !String((r && r.location) || '').startsWith('支援');
}

/**
 * 從歷史班表推算設定。
 * @param {Object} weeks   { 'YYYY-Www': records[] }（本店 weeks 文件的 records）
 * @param {Array}  emps    本店在職員工 [{name, role, payAsPartTime, …}]
 * @param {Object} seasons 寒暑假範圍（決定每筆歷史算學期中還是寒暑假）
 * @param {Object} opt     { demandWeeks: 8 } 需求範本只看最近幾週
 * @returns {{demand, staff, stats}}
 */
function asInferFromHistory(weeks, emps, seasons, opt) {
  opt = opt || {};
  var days = asDayNames();
  var weekIds = Object.keys(weeks || {}).sort();

  // ── 需求：最近 N 週，每個星期幾、每半小時的上班人數取中位數（🆘 待補也算——那是店長認為需要的人）──
  var recent = weekIds.slice(-(opt.demandWeeks || 8));
  // 先按日期收集上班的班別（週一要看上週日延過來的大夜，所以不能只在同一週裡找）
  var byDate = {};
  weekIds.forEach(function (w) {
    (weeks[w] || []).forEach(function (r) {
      if (!asIsHomeRecord(r) || !asIsWorkShift(r.shift)) return;
      var dt = asRecordDate(w, r.day);
      if (dt) (byDate[dt] = byDate[dt] || []).push(r.shift);
    });
  });
  var demand = {};
  days.forEach(function (d, di) {
    var perWeek = recent.map(function (w) {
      var arr = new Array(asSlots()).fill(0);
      var dt = shiftDateAdd(asWeekMonday(w), di);
      (byDate[dt] || []).forEach(function (sh) { asShiftSlots(sh).forEach(function (i) { arr[i]++; }); });
      (byDate[shiftDateAdd(dt, -1)] || []).forEach(function (sh) { asShiftSpillSlots(sh).forEach(function (i) { arr[i]++; }); });
      return arr;
    }).filter(function (arr) { return arr.some(function (x) { return x > 0; }); }); // 還沒排的週不算
    var med = new Array(asSlots()).fill(0);
    for (var i = 0; i < asSlots(); i++) {
      var v = perWeek.map(function (a) { return a[i]; }).sort(function (a, b) { return a - b; });
      med[i] = v.length ? v[Math.floor((v.length - 1) / 2)] : 0; // 偶數取偏低的中位數：寧可少估，待補會補上
    }
    demand[d] = asSlotsToDemand(med);
  });

  // ── 人員：依季節分開統計常上的班別 ──
  var staff = {}, stats = {};
  (emps || []).forEach(function (e) {
    var cnt = { term: {}, vacation: {} }, tot = { term: 0, vacation: 0 };
    var hours = 0, recentWeeks = weekIds.slice(-12);
    weekIds.forEach(function (w) {
      (weeks[w] || []).forEach(function (r) {
        if (r.name !== e.name || !asIsHomeRecord(r) || !asIsWorkShift(r.shift)) return;
        var sh = asNormShift(r.shift);
        var season = asSeasonOf(asRecordDate(w, r.day), seasons);
        cnt[season][sh] = (cnt[season][sh] || 0) + 1;
        tot[season]++;
        if (recentWeeks.indexOf(w) >= 0) hours += shiftTotalHours(r.shift);
      });
    });
    var pick = function (season) {
      var c = cnt[season];
      return Object.keys(c)
        .filter(function (k) { return c[k] >= 5 || c[k] / tot[season] >= 0.1; }) // 偶爾代幾次班的不算
        .sort(function (a, b) { return c[b] - c[a]; });
    };
    var term = pick('term'), vac = pick('vacation');
    if (!term.length) term = vac.slice();   // 某一季沒有歷史 → 先沿用另一季，請店長修
    if (!vac.length) vac = term.slice();
    // 預設都自動排（使用者 2026-09-22：店長、加盟主也自動；手動的人由設定頁的開關個別關掉，如楷岳）
    staff[e.name] = { auto: true, term: term, vacation: vac, note: '' };
    stats[e.name] = {
      termCount: cnt.term, vacCount: cnt.vacation,
      weeklyHours: recentWeeks.length ? Math.round(hours / recentWeeks.length * 10) / 10 : 0
    };
  });

  return { demand: demand, staff: staff, stats: stats };
}

/**
 * 某人某天可上的班別（已套用季節與逐日例外）。回 [] ＝那天不能排。
 * @param {Object} st      staff[名] 設定
 * @param {string} dateStr 'YYYY-MM-DD'
 */
function asAvailableShifts(st, dateStr, seasons) {
  if (!st || !st.auto) return [];
  var season = asSeasonOf(dateStr, seasons);
  var ex = (st[season + 'Days'] || {})[shiftDayName(dateStr)];
  if (ex === 'off') return [];
  if (Array.isArray(ex) && ex.length) return ex.slice();
  return (st[season] || []).slice();
}

/* ════════════════════════════════════════════════════════════════════════════
 * 第 2 步：草稿產生器 asGenerateDraft
 *
 * 做法：把這週「空白格」的每個選項（排休、各可上班別）交給區域搜尋，
 *       最小化一個「成本」——缺人、法規、正職休假配額、工讀薪資……都換算成分數。
 *       不用 LLM：硬規則（11 小時間隔、七休一）必須保證不違反。
 *
 * 規則來源（2026-09-22 與使用者定案，見 memory project_auto_schedule）：
 *  - 店長已排的格子、手動排的人（auto=false，如楷岳）、🆘 待補都不動，只算進人力
 *  - 劃休（leaveRequests 未取消）一定照給：整天→指休；半天→那段不排
 *  - 正職：只排清單上的完整班別；以 40h 為主、不自動排加班（>8h/天或 >40h/週重罰）；
 *          當月應休＝該月六日數（只算排休/指休），平均攤到各週，跨月週按天數拆算；
 *          盡量不連上第 6 天；不要連續兩週都排連休（只看排休）；最後讓平日／假日休假輪流
 *  - 工讀：可排落在「單一」可上班別時間內的較短班（不延長、不合併），長度不限；
 *          每月盡量 ≤ 1.8 萬（按月份進度攤）；先顧成本、再讓時數接近
 *  - 補不到「最少人數」的時段 → 開該段 🆘 待補；介於最少與目標之間只提醒
 * ════════════════════════════════════════════════════════════════════════════ */

/** 班別 a 是否完全落在 b 的時間內（都用單段班判斷；兩頭班不拿來縮短） */
function asShiftWithin(a, b) {
  var sa = parseShiftSegs(a), sb = parseShiftSegs(b);
  if (sa.length !== 1 || sb.length !== 1) return a === b;
  var x = sa[0], y = sb[0];
  var xs = x.startH < asAxisStart() ? x.startH + 24 : x.startH, xe = xs + x.durH;
  var ys = y.startH < asAxisStart() ? y.startH + 24 : y.startH, ye = ys + y.durH;
  return xs >= ys && xe <= ye;
}

/** 軸上 [s,e) → 班別字串（31 → 7） */
function asRangeToShift(s, e) {
  var f = function (h) { return asFmtNum(h >= 24 ? h - 24 : h); };
  return f(s) + '-' + f(e);
}

/** 簡單可重現的亂數（同一份輸入每次排出一樣的草稿） */
function asRng(seed) {
  var x = seed >>> 0 || 1;
  return function () { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/**
 * @param {Object} inp
 *   weekStr   'YYYY-Www'
 *   cfg       autoSchedule 設定
 *   emps      [{name, role, payAsPartTime, wage, base}]  本店在職（role 用計薪身分判斷正職/工讀）
 *   weeks     { weekStr: records[] } 本店：本週、上週、以及本週涵蓋月份的所有週
 *   leaves    leaveRequests [{date, empName, type, shift, status}]
 *   away      已核准的跨店支援 [{name, di, shift, store}]：那天去別店，本店不排；工時仍算進這個人（週工時、間隔、連上天數）
 *   catalog   門市可用班別（已正規化）
 *   opt       { restarts, seed, capMonthly }
 * @returns {{cells, gaps, soft, notes, perEmp, cost}}
 */
function asGenerateDraft(inp) {
  var opt = inp.opt || {};
  var cfg = inp.cfg, days = asDayNames(), week = inp.weekStr;
  var mon = asWeekMonday(week);
  var dates = days.map(function (_, i) { return shiftDateAdd(mon, i); });
  var prevWeek = shiftWeekStr(shiftDateAdd(mon, -7));
  var weeks = inp.weeks || {};
  var cur = weeks[week] || [];
  var CAP = opt.capMonthly || 18000;
  var OFF = asOffShifts();
  var isOffShift = function (s) { return OFF.indexOf(s) >= 0; };
  var notes = [];

  // ── 人員 ──
  var staffCfg = cfg.staff || {};
  var P = []; // 草稿要排的人
  var manualNames = {};
  (inp.emps || []).forEach(function (e) {
    var st = staffCfg[e.name];
    if (!st || !st.auto) { manualNames[e.name] = true; return; }
    // 還沒到職／已經離職的日子不排（回測時宇璿、浚、劉孟絃被排進到職前的週；實際上新人到職週也會錯）
    var from = e.startDate || '', to = e.departDate || '';
    if ((from && from > dates[6]) || (to && to < dates[0])) return;
    var partTime = e.payAsPartTime || e.role === '工讀';
    P.push({ name: e.name, pt: partTime, wage: +e.wage || 0, base: +e.base || 0, st: st, from: from, to: to });
  });

  // ── 本週現況：店長已排的格子鎖住 ──
  var locked = {}; // name|dayIdx → shift
  var fixedWork = []; // 不歸草稿管的上班（手動排的人、🆘、已鎖格） [{dayIdx, shift}]
  cur.forEach(function (r) {
    var di = days.indexOf(r.day);
    if (di < 0 || !asIsHomeRecord(r)) return;
    var sh = String(r.shift || '').trim();
    if (!sh) return;
    locked[r.name + '|' + di] = sh;
  });
  Object.keys(locked).forEach(function (k) {
    var p = k.split('|'), sh = locked[k];
    if (asIsWorkShift(sh)) fixedWork.push({ name: p[0], di: +p[1], shift: sh });
  });

  // ── 已核准的跨店支援（那天人在別店）──
  var awayBy = {};
  (inp.away || []).forEach(function (a) { if (asIsWorkShift(a.shift)) awayBy[a.name + '|' + a.di] = a; });

  // ── 劃休 ──
  var leaveBy = {}; // name|date → {full, morning, evening, comp}
  (inp.leaves || []).forEach(function (l) {
    if (l.status === 'cancelled' || l.status === 'rejected') return;
    var k = l.empName + '|' + l.date;
    var o = leaveBy[k] = leaveBy[k] || {};
    if (l.type === 'comp') o.comp = true;
    else if (l.shift === 'morning') o.morning = true;
    else if (l.shift === 'evening') o.evening = true;
    else o.full = true;
  });

  // ── 上週尾巴（連續上班天數、11 小時間隔、延到週一早上的大夜）──
  var prevRecs = weeks[prevWeek] || [];
  var prevByName = {}; // name → [{di, shift}] 上週
  prevRecs.forEach(function (r) {
    var di = days.indexOf(r.day);
    if (di < 0 || !asIsHomeRecord(r)) return;
    (prevByName[r.name] = prevByName[r.name] || []).push({ di: di, shift: String(r.shift || '').trim() });
  });
  var prevSundayWork = prevRecs.filter(function (r) { return r.day === '週日' && asIsHomeRecord(r) && asIsWorkShift(r.shift); })
    .map(function (r) { return r.shift; });

  // ── 月份資料：每個人在各月份「本週之前」的上班時數、排休數 ──
  // ⚠️ 只看本週之前：店長若已先排好後面幾週，那些休假不能拿來扣本週的應休（回測時正職被排成 6 天 48h 就是這樣）
  var monthsOfWeek = [];
  dates.forEach(function (d) { var m = d.slice(0, 7); if (monthsOfWeek.indexOf(m) < 0) monthsOfWeek.push(m); });
  var monthStat = {}; // name|ym → {hours, offs, wkOffs, weOffs}
  var ms = function (n, m) { var k = n + '|' + m; return monthStat[k] = monthStat[k] || { hours: 0, offs: 0, weOffs: 0, wdOffs: 0 }; };
  Object.keys(weeks).forEach(function (w) {
    if (w === week) return;
    (weeks[w] || []).forEach(function (r) {
      var dt = asRecordDate(w, r.day);
      if (!dt || dt >= mon || monthsOfWeek.indexOf(dt.slice(0, 7)) < 0 || !asIsHomeRecord(r)) return;
      var o = ms(r.name, dt.slice(0, 7)), sh = String(r.shift || '').trim();
      if (sh === '排休' || sh === '指休' || r.isHourly === true) {
        o.offs++;
        var wd = new Date(dt + 'T00:00:00').getDay();
        if (wd === 0 || wd === 6) o.weOffs++; else o.wdOffs++;
      } else if (asIsWorkShift(sh)) o.hours += parseFloat(r.actualHours) || shiftTotalHours(sh);
    });
  });
  // 本週之後、同月份的劃休：一定會休，先從應休額度扣掉
  var futureLeaveOffs = {}; // name|ym → n
  Object.keys(leaveBy).forEach(function (k) {
    var p = k.split('|'), dt = p[1];
    if (!leaveBy[k].full || dt <= dates[6] || monthsOfWeek.indexOf(dt.slice(0, 7)) < 0) return;
    futureLeaveOffs[p[0] + '|' + dt.slice(0, 7)] = (futureLeaveOffs[p[0] + '|' + dt.slice(0, 7)] || 0) + 1;
  });
  var daysInMonth = function (ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); return new Date(y, m, 0).getDate(); };
  var weekendsIn = function (ym) {
    var n = 0, dm = daysInMonth(ym);
    for (var d = 1; d <= dm; d++) { var wd = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, d).getDay(); if (wd === 0 || wd === 6) n++; }
    return n;
  };

  // ── 每個人每格的選項 ──
  var catalog = (inp.catalog || []).filter(function (s) { return parseShiftSegs(s).length === 1; });
  P.forEach(function (p) {
    p.cells = [];      // 7 格：{fixed:shift} 或 {opts:[...]}
    p.offTarget = 0;   // 正職：本週該休幾天（排休+指休）
    for (var di = 0; di < 7; di++) {
      var dt = dates[di], key = p.name + '|' + di;
      if (locked[key] != null) { p.cells.push({ fixed: locked[key] }); continue; }
      var aw = awayBy[key];
      if (aw) { p.cells.push({ fixed: aw.shift, away: aw.store, why: '支援' + aw.store }); continue; } // 使用者 2026-09-22：已核准支援的那天不排本店
      if ((p.from && dt < p.from) || (p.to && dt > p.to)) { p.cells.push({ fixed: '未在職', why: '未在職' }); continue; } // 標記值：不是班別也不算休假
      var lv = leaveBy[p.name + '|' + dt] || {};
      if (lv.full) { p.cells.push({ fixed: '指休', why: '劃休' }); continue; }
      if (lv.comp) { p.cells.push({ fixed: '補休', why: '申請補休' }); continue; }
      var avail = asAvailableShifts(p.st, dt, cfg.seasons);
      var opts = [];
      var add = function (s, pen) {
        s = asNormShift(s); if (!s) return;
        for (var i = 0; i < opts.length; i++) if (opts[i].s === s) { opts[i].pen = Math.min(opts[i].pen, pen); return; }
        opts.push({ s: s, pen: pen, h: shiftTotalHours(s), slots: asShiftSlots(s), spill: asShiftSpillSlots(s), span: shiftSpan(s) });
      };
      avail.forEach(function (s, i) {
        var dur = shiftTotalHours(s);
        if (!p.pt) {
          // 正職：完整班別。清單寫的是時間範圍（例：浚週末 7-23）→ 取範圍內 8～9 小時的門市班別
          if (dur <= 9) add(s, i === 0 ? 0 : 20);
          else catalog.forEach(function (c) { var h = shiftTotalHours(c); if (h >= 8 && h <= 9 && asShiftWithin(c, s)) add(c, 20); });
        } else {
          add(s, i === 0 ? 0 : 20); // 清單原班別，★ 主力最優先
          catalog.forEach(function (c) { if (c !== asNormShift(s) && asShiftWithin(c, s)) add(c, 40); }); // 範圍內的較短班
        }
      });
      // 半天劃休：早上休→不排 15:00 前開始的班；晚上休→不排 15:00 後
      //   （劉孟絃早上劃休只能上 16-23 是他個人的情況，使用者定案由店長手動調整，不做成通用規則）
      opts = opts.filter(function (o) {
        var s = o.span.startH < asAxisStart() ? o.span.startH + 24 : o.span.startH, e = s + o.h;
        if (lv.morning && s < 15) return false;
        if (lv.evening && e > 15) return false;
        return true;
      });
      p.cells.push({ opts: opts, date: dt });
    }
    // 正職本週應休天數：當月應休（六日數）扣掉其他週已休的，按剩餘天數攤給本週
    if (!p.pt) {
      var target = 0;
      monthsOfWeek.forEach(function (m) {
        var o = ms(p.name, m);
        var q = weekendsIn(m) - o.offs - (futureLeaveOffs[p.name + '|' + m] || 0);
        var inWeek = dates.filter(function (d) { return d.slice(0, 7) === m; });
        var lastDay = m + '-' + String(daysInMonth(m)).padStart(2, '0');
        // 本週在該月的第一天到月底，還沒排的天數（未來週的格子都還沒排才算）
        var left = 0, dd = inWeek[0];
        while (dd <= lastDay) { left++; dd = shiftDateAdd(dd, 1); }
        left -= (futureLeaveOffs[p.name + '|' + m] || 0);
        // 一個月在這週只有幾天，就最多休幾天（例：8/31 只有一天在 8 月，8 月剩 2 天應休也只能休 1 天，其餘由薪資頁應休未休處理）
        target += left > 0 ? Math.min(inWeek.length, Math.max(0, q) * inWeek.length / left) : 0;
      });
      p.offTargetRaw = target;
      p.offTarget = Math.max(1, Math.round(target));
    }
  });

  // ── 需求 ──
  var dem = days.map(function (d) {
    var bands = (cfg.demand || {})[d] || [];
    var n = new Array(asSlots()).fill(0), mn = new Array(asSlots()).fill(0);
    bands.forEach(function (b) {
      var bm = b.min == null ? b.n : Math.min(b.min, b.n);
      for (var h = b.s; h < b.e; h += 0.5) {
        var i = Math.round((h - asAxisStart()) * 2);
        if (i >= 0 && i < asSlots()) { n[i] = Math.max(n[i], +b.n || 0); mn[i] = Math.max(mn[i], bm); }
      }
    });
    return { n: n, min: mn };
  });
  // 固定人力（鎖住的格子，包含草稿人員自己的鎖格）
  var baseCov = days.map(function () { return new Array(asSlots()).fill(0); });
  var addCov = function (cov, di, shift, sign) {
    asShiftSlots(shift).forEach(function (i) { cov[di][i] += sign; });
    if (di < 6) asShiftSpillSlots(shift).forEach(function (i) { cov[di + 1][i] += sign; });
  };
  fixedWork.forEach(function (f) { addCov(baseCov, f.di, f.shift, 1); });
  prevSundayWork.forEach(function (sh) { asShiftSpillSlots(sh).forEach(function (i) { baseCov[0][i]++; }); });

  // ── 狀態：每人 7 格目前選的值（字串；鎖格就是鎖住的值）──
  // 權重（分數≈新台幣）：缺人以每半小時計；ot＝草稿不自動排加班，所以比任何缺人都貴——寧可開待補
  // offDev 比「缺一整班(16 格×1000)」還重：正職應休不拿來換人力，缺人就開待補
  // ptShift＝工讀每多上一班的固定成本（通勤），讓草稿偏好少人、較長的班，不排 14-15 這種碎班
  // capPerDollar：1.8 萬只當「差不多的人選先排工時少的」參考——每小時 196×1＋薪資 208 ≈ 400，永遠比缺人(每小時 600～2000)輕。
  //   使用者定案（2026-09-22）：先以人力排滿為主；工讀本月工時太高由店長人工判斷（先開跨店支援，沒人再換回），草稿只提醒
  // pairOff：正職連續兩週都被排「兩天相連的排休」→ 中間會連上很多天、一直覺得在上班（使用者 2026-09-22）。
  //   只看排休，員工自己劃的指休不算；比缺半小時人力(1000)輕，人力優先
  var W = { min: 1000, tgt: 300, ot: 100000, offDev: 20000, sixth: 800, rot: 60, capPerDollar: 1, fair: 4, ptShift: 250, pairOff: 900 };
  var rng = asRng(opt.seed || 20260922);

  var endAbs = function (di, shift) { var sp = shiftSpan(shift); return sp ? di * 24 + sp.endH : null; };
  var startAbs = function (di, shift) { var sp = shiftSpan(shift); return sp ? di * 24 + sp.startH : null; };

  function costOf(state, bd) {
    var cost = 0;
    var tag = function (t, v) { if (bd) bd[t] = (bd[t] || 0) + v; return v; };
    var cov = baseCov.map(function (a) { return a.slice(); });
    P.forEach(function (p, pi) {
      for (var di = 0; di < 7; di++) {
        var c = p.cells[di];
        if (c.fixed) continue; // 鎖格已在 baseCov
        var sh = state[pi][di];
        if (asIsWorkShift(sh)) addCov(cov, di, sh, 1);
      }
    });
    // 1) 人力：少於最少重罰、少於目標中罰
    for (var di = 0; di < 7; di++) for (var i = 0; i < asSlots(); i++) {
      var have = cov[di][i], d = dem[di];
      if (have < d.min[i]) cost += tag('W.min * (d.min[i] ', W.min * (d.min[i] - have));
      if (have < d.n[i]) cost += tag('W.tgt * (d.n[i] - ', W.tgt * (d.n[i] - Math.max(have, d.min[i])));
    }
    // 2) 每個人
    var ptMonthHours = [];
    P.forEach(function (p, pi) {
      var row = state[pi];
      var wkH = 0, offs = 0, overDay = 0;
      var workFlags = [];
      for (var di = 0; di < 7; di++) {
        var sh = row[di], c = p.cells[di];
        if (!c.fixed) { var o = c.optMap[sh]; if (o) cost += tag('o.pen', o.pen); }
        if (asIsWorkShift(sh)) {
          var h = shiftTotalHours(sh); wkH += h;
          if (h > 12) cost += tag('1e6', 1e6);                 // 單日 12 小時上限（硬）
          if (h > 8 && !c.fixed) overDay += h - 8; // 草稿不自動排加班
          if (p.pt && !c.fixed) cost += tag('W.ptShift', W.ptShift);
          workFlags.push(true);
        } else { workFlags.push(false); if (sh === '排休' || sh === '指休') offs++; }
      }
      cost += tag('W.ot * overDay', W.ot * overDay);
      if (wkH > 40) cost += tag('W.ot * (wkH - 40)', W.ot * (wkH - 40));
      // 每人每週上限（設定頁填的；草稿不超過，要超過由店長手動）
      var mh = p.st.maxHours, md = p.st.maxDays;
      if (mh != null && mh !== '' && wkH > +mh) cost += tag('maxHours', W.ot * (wkH - mh));
      if (md != null && md !== '') { var wdn = workFlags.filter(Boolean).length; if (wdn > +md) cost += tag('maxDays', W.ot * 8 * (wdn - md)); }
      // 連續上班（接上週尾巴）：第 7 天硬擋、第 6 天軟擋
      var prev = prevByName[p.name] || [];
      var run = 0;
      for (var k = 6; k >= 0; k--) { var pr = prev.filter(function (x) { return x.di === k; })[0]; if (pr && asIsWorkShift(pr.shift)) run++; else break; }
      for (var dj = 0; dj < 7; dj++) {
        if (workFlags[dj]) { run++; if (run >= 7) cost += tag('1e6', 1e6); else if (run === 6) cost += tag('W.sixth', W.sixth); } else run = 0;
      }
      // 11 小時間隔（含上週日 → 本週一）
      var lastEnd = null;
      var prevSun = prev.filter(function (x) { return x.di === 6 && asIsWorkShift(x.shift); })[0];
      if (prevSun) lastEnd = endAbs(-1, prevSun.shift);
      for (var dk = 0; dk < 7; dk++) {
        if (!asIsWorkShift(row[dk])) continue;
        var s0 = startAbs(dk, row[dk]);
        if (lastEnd != null && s0 - lastEnd > 0 && s0 - lastEnd < 11) cost += tag('1e6', 1e6);
        lastEnd = endAbs(dk, row[dk]);
      }
      if (!p.pt) {
        cost += tag('W.offDev * Math.ab', W.offDev * Math.abs(offs - p.offTarget));
        // 連續兩週都連休（只算排休；上週日＋本週一相連也算本週）
        var prevRow = days.map(function (_, k) { var x = prev.filter(function (y) { return y.di === k; })[0]; return x ? x.shift : ''; });
        var pairIn = function (r) { for (var q = 0; q < 6; q++) if (r[q] === '排休' && r[q + 1] === '排休') return true; return false; };
        if (pairIn(prevRow) && (pairIn(row) || (prevRow[6] === '排休' && row[0] === '排休'))) cost += tag('pairOff', W.pairOff);
        // 平日／假日輪流：本月已休的假日比例越高，這週再休假日越貴
        var mo = ms(p.name, monthsOfWeek[0]);
        for (var dw = 0; dw < 7; dw++) {
          var ss = row[dw], cc = p.cells[dw];
          if (cc.fixed || !(ss === '排休')) continue;
          cost += tag('W.rot * (dw >= 5 ?', W.rot * (dw >= 5 ? mo.weOffs : mo.wdOffs));
        }
      } else {
        // 工讀：實際薪資成本、每月上限（按月份進度攤）
        var byMonth = {};
        for (var dm = 0; dm < 7; dm++) if (asIsWorkShift(row[dm])) { var mk = dates[dm].slice(0, 7); byMonth[mk] = (byMonth[mk] || 0) + shiftTotalHours(row[dm]); }
        var pay = 0;
        Object.keys(byMonth).forEach(function (m) {
          var hrs = byMonth[m];
          pay += hrs * p.wage * 1.06;
          var soFar = ms(p.name, m).hours + hrs;
          var lastInMonth = dates.filter(function (d) { return d.slice(0, 7) === m; }).pop();
          var budget = CAP * (+lastInMonth.slice(8)) / daysInMonth(m);
          // 只罰「這週多排造成的超額」：之前幾週已經超過的是既成事實，不能算到這週的某一班頭上
          // （否則這週只要排他一班，前面的超額就整筆冒出來——阿默 W40 一班被算成 +3.2 萬）
          var pastPay = ms(p.name, m).hours * p.wage;
          var over = Math.max(0, soFar * p.wage - budget) - Math.max(0, pastPay - budget);
          if (over > 0) cost += tag('cap', W.capPerDollar * over);
        });
        cost += tag('pay', pay);
        ptMonthHours.push(ms(p.name, monthsOfWeek[monthsOfWeek.length - 1]).hours + wkH);
      }
    });
    // 3) 工讀時數接近（最後才考慮）
    if (ptMonthHours.length > 1) {
      var mean = ptMonthHours.reduce(function (a, b) { return a + b; }, 0) / ptMonthHours.length;
      ptMonthHours.forEach(function (h) { cost += tag('W.fair * (h - mean', W.fair * (h - mean) * (h - mean)); });
    }
    return cost;
  }

  // ── 初始解＋區域搜尋 ──
  P.forEach(function (p) {
    p.cells.forEach(function (c) {
      if (c.fixed) return;
      c.optMap = { '排休': { pen: 0 } };
      c.opts.forEach(function (o) { c.optMap[o.s] = o; });
      c.choices = ['排休'].concat(c.opts.map(function (o) { return o.s; }));
    });
  });
  var free = []; // [pi, di]
  P.forEach(function (p, pi) { p.cells.forEach(function (c, di) { if (!c.fixed) free.push([pi, di]); }); });

  function initState(randomize) {
    return P.map(function (p) {
      return p.cells.map(function (c) {
        if (c.fixed) return c.fixed;
        if (!randomize) return c.choices.length > 1 ? c.choices[1] : '排休';
        return c.choices[Math.floor(rng() * c.choices.length)];
      });
    });
  }
  function improve(state) {
    var best = costOf(state), changed = true, guard = 0;
    while (changed && guard++ < 40) {
      changed = false;
      // 單格換值
      for (var f = 0; f < free.length; f++) {
        var pi = free[f][0], di = free[f][1], ch = P[pi].cells[di].choices, orig = state[pi][di];
        for (var j = 0; j < ch.length; j++) {
          if (ch[j] === orig) continue;
          state[pi][di] = ch[j];
          var c = costOf(state);
          if (c < best - 1e-9) { best = c; orig = ch[j]; changed = true; } else state[pi][di] = orig;
        }
      }
      // 同一人兩天對調（移動休假日，不改變休假天數）
      for (var a = 0; a < free.length; a++) for (var b = a + 1; b < free.length; b++) {
        if (free[a][0] !== free[b][0]) continue;
        var p0 = free[a][0], x = free[a][1], y = free[b][1];
        var vx = state[p0][x], vy = state[p0][y];
        if (vx === vy) continue;
        var cx = P[p0].cells[x].choices, cy = P[p0].cells[y].choices;
        if (cy.indexOf(vx) < 0) {
          // 對方那天不能上同一班 → 休假換過去，班別改成那天的主力
          if (vx !== '排休' && vy !== '排休') continue;
        }
        var nx = vy, ny = cy.indexOf(vx) >= 0 ? vx : (cy[1] || '排休');
        if (cx.indexOf(nx) < 0) nx = vy === '排休' ? '排休' : (cx[1] || '排休');
        state[p0][x] = nx; state[p0][y] = ny;
        var c2 = costOf(state);
        if (c2 < best - 1e-9) { best = c2; changed = true; } else { state[p0][x] = vx; state[p0][y] = vy; }
      }
    }
    return best;
  }

  var bestState = initState(false), bestCost = improve(bestState);
  var restarts = opt.restarts == null ? 12 : opt.restarts;
  for (var r = 0; r < restarts; r++) {
    var s = initState(true), c = improve(s);
    if (c < bestCost) { bestCost = c; bestState = s; }
  }

  // ── 收尾：同一天兩個人一起換 ──
  // 一次只動一格會卡在「要兩人同時換才補得到」的情況。
  // 例：週六浚改早班＋軒暄補 15-23 才能補滿 8-15，單獨任何一步都不划算，區域搜尋走不過去。
  (function polishPairs() {
    for (var round = 0; round < 3; round++) {
      var improved = false;
      for (var di = 0; di < 7; di++) {
        var dayFree = free.filter(function (f) { return f[1] === di; });
        for (var a = 0; a < dayFree.length; a++) for (var b = a + 1; b < dayFree.length; b++) {
          var pa = dayFree[a][0], pb = dayFree[b][0];
          var ca = P[pa].cells[di].choices, cb = P[pb].cells[di].choices;
          var va = bestState[pa][di], vb = bestState[pb][di];
          for (var i = 0; i < ca.length; i++) for (var j = 0; j < cb.length; j++) {
            if (ca[i] === va && cb[j] === vb) continue;
            bestState[pa][di] = ca[i]; bestState[pb][di] = cb[j];
            var c = costOf(bestState);
            if (c < bestCost - 1e-9) { bestCost = c; va = ca[i]; vb = cb[j]; improved = true; }
            else { bestState[pa][di] = va; bestState[pb][di] = vb; }
          }
        }
      }
      if (improved) bestCost = improve(bestState); else break;
    }
  })();

  // ── 產出 ──
  var cells = [];
  P.forEach(function (p, pi) {
    p.cells.forEach(function (c, di) {
      if (c.fixed && locked[p.name + '|' + di] != null) return; // 店長已排的不輸出
      if (c.why === '未在職' || c.away) return; // 未在職、去別店支援的格子不寫進本店班表
      var sh = c.fixed || bestState[pi][di];
      var why = c.why || '';
      if (!c.fixed && asIsWorkShift(sh)) {
        var o = c.optMap[sh];
        why = o && o.pen === 0 ? '主力班別' : (o && o.pen >= 40 ? '可上時段內的較短班' : '可上班別');
      }
      cells.push({ name: p.name, day: days[di], di: di, shift: sh, why: why });
    });
  });
  // 最終人力 → 待補與提醒
  var cov = baseCov.map(function (a) { return a.slice(); });
  P.forEach(function (p, pi) { p.cells.forEach(function (c, di) { if (!c.fixed && asIsWorkShift(bestState[pi][di])) addCov(cov, di, bestState[pi][di], 1); }); });
  var gaps = [], soft = [];
  // 連續 >0 的格子 → [{s,e}]；在需求時段交界切開（週五 8-15 早班＋15-18 下午都缺，是兩個人的事，不合成一格 8-18）
  var segs = function (arr, d) {
    var out = [];
    arr.forEach(function (v, i) {
      if (!v) return;
      var h = asAxisStart() + i / 2, last = out[out.length - 1];
      var sameBand = i > 0 && d.n[i] === d.n[i - 1] && d.min[i] === d.min[i - 1];
      if (last && last.e === h && sameBand) last.e = h + 0.5; else out.push({ s: h, e: h + 0.5 });
    });
    return out;
  };
  for (var di2 = 0; di2 < 7; di2++) {
    var lack = [], lackT = [];
    for (var i2 = 0; i2 < asSlots(); i2++) {
      lack.push(Math.max(0, dem[di2].min[i2] - cov[di2][i2]));
      lackT.push(Math.max(0, dem[di2].n[i2] - Math.max(cov[di2][i2], dem[di2].min[i2])));
    }
    // 一層一層切：缺 2 人的時段開兩格
    for (var layer = 1; layer <= 5; layer++) {
      segs(lack.map(function (v) { return v >= layer ? 1 : 0; }), dem[di2]).forEach(function (g) {
        gaps.push({ day: days[di2], di: di2, shift: asRangeToShift(g.s, g.e), s: g.s, e: g.e });
      });
    }
    segs(lackT.map(function (v) { return v > 0 ? 1 : 0; }), dem[di2]).forEach(function (g) {
      soft.push({ day: days[di2], di: di2, s: g.s, e: g.e, label: asHourLabel(g.s) + '～' + asHourLabel(g.e) });
    });
  }
  // 缺口旁若正職延長 1～2 小時就能補 → 建議（系統不自動排加班，由店長決定）
  var suggestions = [];
  var ptW = P.filter(function (p) { return p.pt && p.wage > 0; });
  var ptAvgWage = ptW.length ? ptW.reduce(function (a, p) { return a + p.wage; }, 0) / ptW.length : 0;
  gaps.concat(soft).forEach(function (g) {
    var len = g.e - g.s;
    if (len > 2) return;
    P.forEach(function (p, pi) {
      if (p.pt) return;
      var sh = bestState[pi][g.di];
      var sp = asIsWorkShift(sh) ? shiftSpan(sh) : null;
      var viaPrev = false;
      if (!sp && g.di > 0 && asIsWorkShift(bestState[pi][g.di - 1])) {
        var pp = shiftSpan(bestState[pi][g.di - 1]);
        if (pp.endH - 24 === g.s - 0 || pp.endH === g.s) { sp = { startH: pp.startH, endH: pp.endH - 24 }; viaPrev = true; }
      }
      if (!sp) return;
      var sS = sp.startH < asAxisStart() ? sp.startH + 24 : sp.startH, sE = sS + (sp.endH - sp.startH);
      if (viaPrev) { sE = sp.endH; sS = null; }
      var touches = (sE === g.s) || (sS === g.e) || (viaPrev && sp.endH === g.s - 0);
      if (!touches) return;
      var otRate = Math.ceil(p.base / 240) * 1.34;
      var ptRate = ptAvgWage * 1.06;
      suggestions.push({ day: g.day, name: p.name, hours: len, label: asHourLabel(g.s) + '～' + asHourLabel(g.e),
        save: Math.round((ptRate - otRate) * len), otCost: Math.round(otRate * len), viaPrev: viaPrev });
    });
  });

  var perEmp = {};
  P.forEach(function (p, pi) {
    var h = 0, offs = 0;
    bestState[pi].forEach(function (sh) { if (asIsWorkShift(sh)) h += shiftTotalHours(sh); else if (sh === '排休' || sh === '指休') offs++; });
    // 工讀本月薪資提醒：本週之前＋這週草稿，超過 1.8 萬（或照月份進度已超前）就提醒店長考慮開跨店支援
    if (p.pt && p.wage > 0) {
      monthsOfWeek.forEach(function (m) {
        var wkH = 0;
        bestState[pi].forEach(function (sh, di) { if (dates[di].slice(0, 7) === m && asIsWorkShift(sh)) wkH += shiftTotalHours(sh); });
        var pay = Math.round((ms(p.name, m).hours + wkH) * p.wage);
        var lastInMonth = dates.filter(function (d) { return d.slice(0, 7) === m; }).pop();
        var elapsed = +lastInMonth.slice(8), dim = daysInMonth(m);
        var proj = Math.round(pay * dim / elapsed); // 照目前速度推到月底
        // 月初只排了幾天就推算會失真（10 月第一週排兩班就「超標」），過了 10 天才看推算
        var warn = pay > CAP ? '，已超過 1.8 萬' : (elapsed >= 10 && proj > CAP ? '，照目前速度月底約 $' + proj.toLocaleString() : '');
        if (wkH > 0 && warn) {
          notes.push({ type: 'cap', name: p.name, month: m, pay: pay, proj: proj,
            msg: p.name + ' ' + (+m.slice(5)) + ' 月到這週 $' + pay.toLocaleString() + warn + '——可考慮先開放跨店支援' });
        }
      });
    }
    perEmp[p.name] = { away: p.cells.map(function (c) { return c.away ? { store: c.away, shift: c.fixed } : null; }), pt: p.pt, hours: h, offs: offs, offTarget: p.pt ? null : p.offTarget, offTargetRaw: p.offTargetRaw,
      monthHours: monthsOfWeek.map(function (m) { return { m: m, before: ms(p.name, m).hours }; }) };
  });

  var out = { cells: cells, gaps: gaps, soft: soft, suggestions: suggestions, perEmp: perEmp, cost: bestCost, notes: notes, state: bestState, people: P.map(function (p) { return p.name; }) };
  if (opt.debug) { out.costOf = costOf; out.P = P; }
  return out;
}

/**
 * 門市可用班別：班別設定＋歷史上用過至少 minUse 次的（偶爾一次的怪班如 14-15、10-18 不收）
 * @param {Array} cfgShifts  stores/{store}/config/shifts.shifts
 * @param {Object} weeks     { weekStr: records[] }
 */
function asBuildCatalog(cfgShifts, weeks, minUse) {
  var cnt = {}, out = [];
  (cfgShifts || []).forEach(function (s) { var n = asNormShift(s); if (n && out.indexOf(n) < 0) out.push(n); });
  Object.keys(weeks || {}).forEach(function (w) {
    (weeks[w] || []).forEach(function (r) { var n = asNormShift(r.shift); if (n) cnt[n] = (cnt[n] || 0) + 1; });
  });
  Object.keys(cnt).forEach(function (n) { if (cnt[n] >= (minUse || 3) && out.indexOf(n) < 0) out.push(n); });
  return out;
}

/**
 * 推算結果太零碎就別預填（使用者 2026-09-22：複雜的店先顯示空白，讓店長自己填，比修一堆碎時段好）
 *  - 需求：任一天有半點交界或超過 6 段 → 整份需求清空
 *  - 個人：可上班別超過 3 種或含半點班 → 那個人的清單清空
 * @returns {{demandBlank:boolean, blankStaff:string[]}}
 */
function asBlankIfComplex(inf) {
  var half = function (h) { return Math.round(h * 2) % 2 !== 0; };
  var demandBlank = asDayNames().some(function (d) {
    var b = inf.demand[d] || [];
    return b.length > 6 || b.some(function (x) { return half(x.s) || half(x.e); });
  });
  if (demandBlank) asDayNames().forEach(function (d) { inf.demand[d] = []; });
  var blankStaff = [];
  Object.keys(inf.staff).forEach(function (n) {
    var st = inf.staff[n];
    var messy = function (list) {
      return list.length > 3 || list.some(function (sh) { return parseShiftSegs(sh).some(function (g) { return half(g.startH) || half(g.endH); }); });
    };
    if (messy(st.term) || messy(st.vacation)) { st.term = []; st.vacation = []; blankStaff.push(n); }
  });
  return { demandBlank: demandBlank, blankStaff: blankStaff };
}
