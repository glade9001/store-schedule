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
 * 目前所處「特休年度」的起算日
 * 勞基法 §38 的年資級距：滿 6 個月、滿 1 年、滿 2 年、滿 3 年…
 * 例：到職 2025-07-01、年資 14 個月 → 目前落在「滿 1 年」那個年度，起算日 2026-07-01
 */
function settleYearStart(hireDate, totalMonths) {
  if (!hireDate || totalMonths < 6) return null;
  var d = new Date(hireDate);
  if (totalMonths < 12) d.setMonth(d.getMonth() + 6);
  else d.setFullYear(d.getFullYear() + Math.floor(totalMonths / 12));
  return d.toISOString().slice(0, 10);
}

/**
 * 結清試算
 *
 * ⚠️ 2026-08-28 修正（用戶指正，勞基法施行細則 §24）：
 *   特休在「符合年資的當下」就整年度取得，**不是隨在職月數按比例累進**。
 *   例：到職 2025-07-01 的人在 2026-07-01 滿 1 年，當下即取得第 2 年度的 7 天；
 *   9/1 離職時這 7 天是既得權利，不因為只做了 2 個月而打折，必須全額結算。
 *   同細則亦規定曆年制得比例計給但「**不得低於**」週年制 → 比例制只能是下限參考，
 *   永遠不該被選中當答案。
 *
 *   原本的錯誤：把「週年制」用「系統裡現有批次的剩餘」來代表。批次沒發 ≠ 員工沒有權利，
 *   於是週年制欄算成 0，擇優就掉到比例制、少付 5 天。
 *   現在改為：法定應得 = 依年資的當年度天數 − 當年度已使用 + 前期未結清餘額。
 *
 * @param {object} o batches / compRemaining / monthWage / hireDate / effectDate
 */
function calcLeaveSettle(o) {
  o = o || {};
  var all = o.batches || [];
  var batches = all.filter(function (b) { return !b.settled; });
  var effectDate = o.effectDate || new Date().toISOString().slice(0, 10);

  // 到職日：優先用員工主檔；退而求其次用最早批次往前推 6 個月（特休於到職滿 6 個月首次發放）
  var hireDate = o.hireDate || null;
  if (!hireDate && all.length) {
    var g = all.slice().sort(function (a, b) { return String(a.grantDate || '').localeCompare(String(b.grantDate || '')); })[0].grantDate;
    if (g) { var d0 = new Date(g); d0.setMonth(d0.getMonth() - 6); hireDate = d0.toISOString().slice(0, 10); }
  }

  var totalMonths = hireDate ? settleMonthsBetween(hireDate, effectDate) : 0;
  var yearStart = settleYearStart(hireDate, totalMonths);
  var entitled = settleAnnualRule(totalMonths);   // 當年度法定應得（整年度，不按比例）

  // 批次拆成「本年度」與「前期」：本年度用來抵扣已使用，前期未結清的直接累加
  var usedThisYear = 0, priorRemain = 0, items = [], batchRemainTotal = 0;
  for (var i = 0; i < batches.length; i++) {
    var b = batches[i];
    var days = parseFloat(b.days) || 0, used = parseFloat(b.used) || 0;
    var rem = Math.max(0, days - used);
    batchRemainTotal += rem;
    var isThisYear = yearStart && b.grantDate && String(b.grantDate) >= yearStart;
    if (isThisYear) usedThisYear += used;
    else priorRemain += rem;
    if (rem > 0) items.push({ batchId: b.id, label: b.label || b.note || '特休批次', grantDate: b.grantDate || '', days: rem });
  }

  // 法定應得：當年度整年度天數 − 當年度已使用 + 前期未結清餘額
  var statutory = Math.max(0, entitled - usedThisYear) + priorRemain;

  // 保險起見取「法定應得」與「系統批次剩餘總和」的高者（批次若因故多發，以實際為準）
  var annualDays = Math.max(statutory, batchRemainTotal);
  var basis = annualDays === statutory && statutory >= batchRemainTotal ? '法定應得（週年制）' : '系統批次剩餘';

  // 比例制僅作下限參考，不參與取值（施行細則 §24：曆年制得比例計給但不得低於週年制）
  var monthsIntoYear = totalMonths > 0 ? (totalMonths % 12 || 12) : 0;
  var proportional = totalMonths > 0 ? Math.ceil(entitled * monthsIntoYear / 12) : 0;

  var compDays = Math.max(0, parseFloat(o.compRemaining) || 0);
  var totalDays = annualDays + compDays;
  var dailyWage = settleDailyWage(o.monthWage);
  var amount = Math.round(totalDays * dailyWage);

  // 批次沒涵蓋到的天數（例如當年度批次根本沒發放）→ 結清時沒有批次可標記，要另外說明
  var uncovered = Math.max(0, annualDays - batchRemainTotal);

  var explain = [];
  explain.push('到職 ' + (hireDate || '—') + '，至 ' + effectDate + ' 年資 ' + totalMonths + ' 個月');
  explain.push('目前特休年度起算 ' + (yearStart || '—') + '，該年度法定應得 ' + entitled + ' 天（滿年資即整年度取得，不按比例）');
  explain.push('本年度已使用 ' + usedThisYear + ' 天' + (priorRemain > 0 ? '，前期未結清 ' + priorRemain + ' 天' : ''));
  explain.push('特休應結清 ' + annualDays + ' 天（' + basis + '）');
  if (uncovered > 0) explain.push('⚠️ 其中 ' + uncovered + ' 天在系統裡沒有對應批次（該年度批次未發放），仍須結算');
  explain.push('※ 比例制僅供對照：' + entitled + ' × ' + monthsIntoYear + '/12 = ' + proportional + ' 天，依施行細則 §24 不得低於週年制，故不採用');
  if (compDays > 0) explain.push('補休剩餘 ' + compDays + ' 天');
  explain.push('日薪 = 月薪 ' + (parseFloat(o.monthWage) || 0).toLocaleString() + ' ÷ 30 = ' + dailyWage.toLocaleString());
  explain.push('結清金額 = (' + annualDays + (compDays > 0 ? ' + ' + compDays : '') + ') 天 × ' + dailyWage.toLocaleString() + ' = ' + amount.toLocaleString());

  return {
    hireDate: hireDate, effectDate: effectDate, totalMonths: totalMonths,
    yearStart: yearStart, entitled: entitled, usedThisYear: usedThisYear, priorRemain: priorRemain,
    statutory: statutory, batchRemainTotal: batchRemainTotal, uncovered: uncovered,
    annualDays: annualDays, basis: basis, items: items, proportional: proportional,
    compDays: compDays, totalDays: totalDays,
    dailyWage: dailyWage, amount: amount, explain: explain,
  };
}
