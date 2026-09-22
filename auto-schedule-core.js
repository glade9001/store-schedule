/**
 * 自動排班核心 —— 設定資料模型、歷史推算（第 1 步），之後的草稿產生器（第 2 步）也放這裡。
 *
 * 設定存在 stores/{store}/config/autoSchedule：
 *   demand : { 週一: [{s:7, e:15, n:2}, …], …週日 }
 *            各時段需要幾個人。s/e 是「小時」，0.5 為單位；一天的軸從 07:00 到隔天 07:00，
 *            所以 s/e 落在 7～31 之間（23:00～隔天 07:00 存成 {s:23, e:31}）。
 *            ⚠️ 不存「班別組合」：週六工讀排 8-15 還是 16-23 要看正職上哪班，組合寫死就表達不了。
 *   seasons: { summer:{from:'07-01', to:'08-31'}, winter:{from:'01-20', to:'02-20'} }  每年重複的 MM-DD
 *   staff  : { 員工名: { auto:true, term:['18-23',…], vacation:['15-23',…], note:'' } }
 *            term＝學期中、vacation＝寒暑假可上的班別，第一個＝主力。auto=false＝不自動排（店長等，手動排）。
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
    var e = g.endH >= 24 ? g.endH - 24 : g.endH; // 16-0 收在午夜，照店裡寫法存 '16-0' 不是 '16-24'
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

/** 某日期屬於學期中('term')還是寒暑假('vacation')。範圍可跨年（例 12-25～02-20）。 */
function asSeasonOf(dateStr, seasons) {
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
  var demand = {};
  days.forEach(function (d) {
    var perWeek = recent.map(function (w) {
      var arr = new Array(asSlots()).fill(0);
      (weeks[w] || []).forEach(function (r) {
        if (r.day !== d || !asIsHomeRecord(r) || !asIsWorkShift(r.shift)) return;
        asShiftSlots(r.shift).forEach(function (i) { arr[i]++; });
      });
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
    var lead = ['店長', '加盟主'].indexOf(e.role) >= 0;
    staff[e.name] = { auto: !lead, term: term, vacation: vac, note: '' };
    stats[e.name] = {
      termCount: cnt.term, vacCount: cnt.vacation,
      weeklyHours: recentWeeks.length ? Math.round(hours / recentWeeks.length * 10) / 10 : 0
    };
  });

  return { demand: demand, staff: staff, stats: stats };
}
