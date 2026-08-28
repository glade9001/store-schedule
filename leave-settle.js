/**
 * 特補休結清 —— 離職與身份轉換（正職→工讀）共用的純計算層
 *
 * 為什麼要有這支（2026-08-28）：
 *   原本 leave.html 的 doSettle()/doCompSettle() 只把批次標記 settled，
 *   然後跳一句「請在薪資系統中手動計入日薪 × N 天」——金額全靠人工，
 *   而 salary-page.js 的 calcRetireSettlement()（週年制 vs 比例制擇優）寫好了卻沒有任何呼叫端。
 *   算法有、UI 有、就是沒接起來。這支把計算集中，讓 employee-mgmt（試算）與 salary（實際寫入）共用。
 *
 * 適用情境（用戶 2026-08-28 定案）：
 *   ① 離職：契約終止，勞基法 §38 未休特休應折發工資。
 *   ② 正職→工讀：契約未終止、法律上沒有強制結算時點，但折算基準會從「月薪÷30」變成時薪，
 *      不結清的話員工在正職期間累積的特休之後會用較低基準折現 → 採「折發後歸零」。
 *      並要求身份轉換一律從 1 號生效，避免產生系統無法表達的「前半月薪、後半時薪」混合月。
 *
 * 本檔比照 shift-utils.js：只有 function 宣告、沒有任何頂層 const/let/class，
 * 任何頁面掛上來都不會撞名把整段 script 打掛。純計算，不碰 DOM 也不碰 Firestore。
 */

/**
 * 結清應計入哪個薪資月
 * 生效日＝第一個不上班（或不再以原身份計薪）的日子，與 resignAccessUntil 同一套模型：
 *   1 號生效  → 當月一天都沒做 → 最後薪資月是「上個月」
 *   2 號以後  → 當月仍有工作   → 就算在「當月」
 * @param {string} effectDate 'YYYY-MM-DD'
 * @returns {string|null} 'YYYY-MM'
 */
function settleTargetMonth(effectDate) {
  var p = String(effectDate || '').split('-');
  if (p.length !== 3) return null;
  var y = +p[0], m = +p[1], d = +p[2];
  if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
  if (d === 1) { m -= 1; if (m < 1) { m = 12; y -= 1; } }
  return y + '-' + (m < 10 ? '0' + m : String(m));
}

/** 下一個薪資月（目標月已發布、選擇改列下月時用） */
function settleNextMonth(ym) {
  var p = String(ym || '').split('-');
  if (p.length !== 2) return null;
  var y = +p[0], m = +p[1] + 1;
  if (m > 12) { m = 1; y += 1; }
  return y + '-' + (m < 10 ? '0' + m : String(m));
}

/** 兩個日期相差幾個「月」（只看年月，與 salary-page.js monthsDiffSalary 同語意） */
function settleMonthsBetween(fromDate, toDate) {
  var f = new Date(fromDate), t = new Date(toDate);
  if (isNaN(f) || isNaN(t)) return 0;
  return (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth());
}

/** 勞基法 §38 特休天數表（與 salary-page.js annualLeaveRuleSalary 同一份） */
function settleAnnualRule(totalMonths) {
  if (totalMonths < 6) return 0;
  if (totalMonths < 12) return 3;
  if (totalMonths < 24) return 7;
  if (totalMonths < 36) return 10;
  if (totalMonths < 60) return 14;
  if (totalMonths < 120) return 15;
  return Math.min(30, 15 + Math.floor(totalMonths / 12) - 9);
}

/** 日薪基準：月薪 ÷ 30（與既有 calcCarrySettlement / calcRetireSettlement 一致） */
function settleDailyWage(monthWage) {
  var w = parseFloat(monthWage) || 0;
  return Math.round(w / 30);
}

/**
 * 結清試算
 * @param {object} o
 *   o.batches       特休批次 [{id,label,note,grantDate,days,used,settled,carried}]
 *   o.compRemaining 補休剩餘天數（current + carried）
 *   o.monthWage     月薪基準（底薪＋全勤）
 *   o.hireDate      到職日 'YYYY-MM-DD'（沒有就用最早批次 grantDate 往前推 6 個月）
 *   o.effectDate    生效日 'YYYY-MM-DD'
 * @returns {object} 天數、金額、依據、逐條說明
 */
function calcLeaveSettle(o) {
  o = o || {};
  var batches = (o.batches || []).filter(function (b) { return !b.settled; });
  var effectDate = o.effectDate || new Date().toISOString().slice(0, 10);

  // 到職日：優先用員工主檔；退而求其次用最早批次往前推 6 個月（特休於到職滿 6 個月首次發放）
  var hireDate = o.hireDate || null;
  if (!hireDate && batches.length) {
    var g = batches.slice().sort(function (a, b) { return String(a.grantDate || '').localeCompare(String(b.grantDate || '')); })[0].grantDate;
    if (g) { var d = new Date(g); d.setMonth(d.getMonth() - 6); hireDate = d.toISOString().slice(0, 10); }
  }

  // ① 週年制：現有未結清批次的剩餘天數總和
  var annualByBatch = 0, items = [];
  for (var i = 0; i < batches.length; i++) {
    var b = batches[i];
    var rem = Math.max(0, (parseFloat(b.days) || 0) - (parseFloat(b.used) || 0));
    if (rem > 0) items.push({ batchId: b.id, label: b.label || b.note || '特休批次', grantDate: b.grantDate || '', days: rem });
    annualByBatch += rem;
  }

  // ② 比例制：依實際在職月數換算「當個年度」應得天數（不重複計已發放的整年份）
  var totalMonths = hireDate ? settleMonthsBetween(hireDate, effectDate) : 0;
  var fullYearDays = settleAnnualRule(totalMonths);
  var monthsIntoYear = totalMonths > 0 ? (totalMonths % 12 || 12) : 0;
  var proportional = totalMonths > 0 ? Math.ceil(fullYearDays * monthsIntoYear / 12) : 0;

  // ③ 擇優（勞工有利原則）
  var annualDays = Math.max(annualByBatch, proportional);
  var basis = (annualDays === proportional && proportional > annualByBatch) ? '比例制' : '週年制';

  var compDays = Math.max(0, parseFloat(o.compRemaining) || 0);
  var totalDays = annualDays + compDays;
  var dailyWage = settleDailyWage(o.monthWage);
  var amount = Math.round(totalDays * dailyWage);

  var explain = [];
  explain.push('到職 ' + (hireDate || '—') + '，年資 ' + totalMonths + ' 個月');
  explain.push('週年制：現有批次剩餘合計 ' + annualByBatch + ' 天');
  explain.push('比例制：年度應得 ' + fullYearDays + ' 天 × ' + monthsIntoYear + '/12 = ' + proportional + ' 天');
  explain.push('特休擇優取高者 → ' + annualDays + ' 天（' + basis + '）');
  if (compDays > 0) explain.push('補休剩餘 ' + compDays + ' 天');
  explain.push('日薪 = 月薪 ' + (parseFloat(o.monthWage) || 0).toLocaleString() + ' ÷ 30 = ' + dailyWage.toLocaleString());
  explain.push('結清金額 = (' + annualDays + (compDays > 0 ? ' + ' + compDays : '') + ') 天 × ' + dailyWage.toLocaleString() + ' = ' + amount.toLocaleString());

  return {
    hireDate: hireDate, effectDate: effectDate, totalMonths: totalMonths,
    annualByBatch: annualByBatch, proportional: proportional,
    annualDays: annualDays, basis: basis, items: items,
    compDays: compDays, totalDays: totalDays,
    dailyWage: dailyWage, amount: amount, explain: explain,
  };
}
