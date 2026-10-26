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

/** 日期字串位移 n 天 */
function settleDateAdd(dateStr, n) {
  var d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 年資「滿幾個月」——會看日，未滿當月對應日不算滿一個月
 * ⚠️ 不可只比年月（原本的寫法）：3/15 到職的人到 9/01 只滿 5 個多月，
 *    只比年月會算成 6 個月而多給一整年度的特休。
 */
function settleMonthsBetween(fromDate, toDate) {
  var f = new Date(fromDate), t = new Date(toDate);
  if (isNaN(f) || isNaN(t)) return 0;
  var m = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth());
  if (t.getDate() < f.getDate()) m -= 1;
  return Math.max(0, m);
}

/** 勞基法 §38 特休天數表：規則在 leave-rules.js lvAnnualDays（載入本檔的頁面要先載 leave-rules.js） */
function settleAnnualRule(totalMonths) { return lvAnnualDays(totalMonths); }

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
 * ⚠️ 2026-10-26 修正：「已使用」改從特休逐日帳本（annualUsage）算，不再讀批次上的 used。
 *   批次的 used 是快取，批次當天才補建時是 0 → 某正職實際休了 9 天，試算卻當成一天都沒休，
 *   算出 10 天 $10,930（店長手動改成 1 天才沒多發）。
 *   有傳 annualUseDates 時：帳本日期依「先拿到先用」（grantDate 由早到晚，不看到期日，
 *   與排班頁 recompute 的批次已用規則相同）分配到未結清批次；量測點之後的日期（已是新身分）不算。
 *   沒傳時退回舊算法（讀批次 used），並在說明裡標示。
 *
 * @param {object} o batches / annualUseDates / compRemaining / monthWage / hireDate / effectDate
 */
function calcLeaveSettle(o) {
  o = o || {};
  var all = o.batches || [];
  var batches = all.filter(function (b) { return !b.settled; });
  var effectDate = o.effectDate || new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0, 10);

  // 到職日：優先用員工主檔；退而求其次用最早批次往前推 6 個月（特休於到職滿 6 個月首次發放）
  var hireDate = o.hireDate || null;
  if (!hireDate && all.length) {
    var g = all.slice().sort(function (a, b) { return String(a.grantDate || '').localeCompare(String(b.grantDate || '')); })[0].grantDate;
    if (g) { var d0 = new Date(g); d0.setMonth(d0.getMonth() - 6); hireDate = d0.toISOString().slice(0, 10); }
  }

  // ⚠️ 量測點是「舊身分的最後一天」＝生效日前一天，不是生效日本身（2026-08-28 修）。
  //    生效日是新身分的第一天：離職生效日當天已經不上班、轉工讀生效日當天已經是工讀。
  //    邊界實例（某工讀）：到職 2026-03-01、9/1 轉工讀，滿 6 個月正好落在 9/1 當天。
  //    用生效日量會算成「正職期間有 3 天特休」→ 以正職日薪折現 $3,051，但那 3 天其實是
  //    以工讀身分取得的，而且契約沒終止、她不會失去，之後照樣能休 → 等於多付。
  //    用 8/31 量則是滿 5 個月 → 正職期間應結清 0 天，正確。
  var measureDate = settleDateAdd(effectDate, -1);
  var totalMonths = hireDate ? settleMonthsBetween(hireDate, measureDate) : 0;
  var yearStart = settleYearStart(hireDate, totalMonths);
  var entitled = settleAnnualRule(totalMonths);   // 當年度法定應得（整年度，不按比例）

  var useDates = Array.isArray(o.annualUseDates) ? o.annualUseDates : null;
  if (useDates) return settleFromLedger(o, batches, useDates, hireDate, effectDate, measureDate, totalMonths, yearStart, entitled);

  // （舊算法：沒有帳本資料時才走）批次拆成「本年度」與「前期」：本年度用來抵扣已使用，前期未結清的直接累加
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
  explain.push('到職 ' + (hireDate || '—') + '，至 ' + measureDate + '（生效日前一天）年資 ' + totalMonths + ' 個月');
  explain.push('目前特休年度起算 ' + (yearStart || '—') + '，該年度法定應得 ' + entitled + ' 天（滿年資即整年度取得，不按比例）');
  explain.push('本年度已使用 ' + usedThisYear + ' 天' + (priorRemain > 0 ? '，前期未結清 ' + priorRemain + ' 天' : ''));
  explain.push('⚠️ 沒有讀到特休使用帳本，已使用天數取自批次紀錄，可能不準，請核對');
  explain.push('特休應結清 ' + annualDays + ' 天（' + basis + '）');
  if (uncovered > 0) explain.push('⚠️ 其中 ' + uncovered + ' 天在系統裡沒有對應批次（該年度批次未發放），仍須結算');
  explain.push('※ 比例制僅供對照：' + entitled + ' × ' + monthsIntoYear + '/12 = ' + proportional + ' 天，依施行細則 §24 不得低於週年制，故不採用');
  if (compDays > 0) explain.push('補休剩餘 ' + compDays + ' 天');
  explain.push('日薪 = 月薪 ' + (parseFloat(o.monthWage) || 0).toLocaleString() + ' ÷ 30 = ' + dailyWage.toLocaleString());
  explain.push('結清金額 = (' + annualDays + (compDays > 0 ? ' + ' + compDays : '') + ') 天 × ' + dailyWage.toLocaleString() + ' = ' + amount.toLocaleString());

  return {
    hireDate: hireDate, effectDate: effectDate, measureDate: measureDate, totalMonths: totalMonths,
    yearStart: yearStart, entitled: entitled, usedThisYear: usedThisYear, priorRemain: priorRemain,
    statutory: statutory, batchRemainTotal: batchRemainTotal, uncovered: uncovered,
    annualDays: annualDays, basis: basis, items: items, proportional: proportional,
    compDays: compDays, totalDays: totalDays,
    dailyWage: dailyWage, amount: amount, explain: explain,
  };
}

/**
 * 帳本版試算（calcLeaveSettle 有傳 annualUseDates 時走這裡）
 *   可結清天數＝（本年度法定應得＋前期未結清批次天數）−（這段期間帳本上的特休使用天數）
 *   期間＝最早一個未結清批次的取得日（沒有就用本年度起算日）～量測點。
 *   批次剩餘照「先拿到先用」分配，用來決定結清時標記哪些批次。
 */
function settleFromLedger(o, batches, useDates, hireDate, effectDate, measureDate, totalMonths, yearStart, entitled) {
  var bs = batches.slice().sort(function (a, b) { return String(a.grantDate || '').localeCompare(String(b.grantDate || '')); });
  var from = yearStart || '';
  var priorDays = 0;
  for (var i = 0; i < bs.length; i++) {
    var gd = String(bs[i].grantDate || '');
    if (!(yearStart && gd >= yearStart)) { priorDays += parseFloat(bs[i].days) || 0; if (gd && (!from || gd < from)) from = gd; }
  }
  var dates = useDates.map(String).filter(function (d) { return (!from || d >= from) && d <= measureDate; }).sort();
  var used = dates.length;

  // 先拿到先用：每一天扣在「取得日 ≤ 該日、還有剩」的最早批次
  var rem = bs.map(function (b) { return parseFloat(b.days) || 0; });
  dates.forEach(function (d) {
    for (var j = 0; j < bs.length; j++) if (String(bs[j].grantDate || '') <= d && rem[j] > 0) { rem[j]--; return; }
  });
  var items = [], batchRemainTotal = 0;
  for (var k = 0; k < bs.length; k++) {
    batchRemainTotal += rem[k];
    if (rem[k] > 0) items.push({ batchId: bs[k].id, label: bs[k].label || bs[k].note || '特休批次', grantDate: bs[k].grantDate || '', days: rem[k] });
  }

  var statutory = Math.max(0, entitled + priorDays - used);
  var annualDays = Math.max(statutory, batchRemainTotal);
  var basis = annualDays === statutory && statutory >= batchRemainTotal ? '法定應得（週年制）' : '系統批次剩餘';
  var monthsIntoYear = totalMonths > 0 ? (totalMonths % 12 || 12) : 0;
  var proportional = totalMonths > 0 ? Math.ceil(entitled * monthsIntoYear / 12) : 0;
  var compDays = Math.max(0, parseFloat(o.compRemaining) || 0);
  var totalDays = annualDays + compDays;
  var dailyWage = settleDailyWage(o.monthWage);
  var amount = Math.round(totalDays * dailyWage);
  var uncovered = Math.max(0, annualDays - batchRemainTotal);

  var explain = [];
  explain.push('到職 ' + (hireDate || '—') + '，至 ' + measureDate + '（生效日前一天）年資 ' + totalMonths + ' 個月');
  explain.push('目前特休年度起算 ' + (yearStart || '—') + '，該年度法定應得 ' + entitled + ' 天（滿年資即整年度取得，不按比例）');
  if (priorDays > 0) explain.push('前期未結清批次 ' + priorDays + ' 天');
  explain.push((from || '—') + ' ～ ' + measureDate + ' 特休使用帳本共 ' + used + ' 天');
  explain.push('特休應結清 ' + annualDays + ' 天（' + basis + '）');
  if (uncovered > 0) explain.push('⚠️ 其中 ' + uncovered + ' 天在系統裡沒有對應批次（該年度批次未發放），仍須結算');
  explain.push('※ 比例制僅供對照：' + entitled + ' × ' + monthsIntoYear + '/12 = ' + proportional + ' 天，依施行細則 §24 不得低於週年制，故不採用');
  if (compDays > 0) explain.push('補休剩餘 ' + compDays + ' 天');
  explain.push('日薪 = 月薪 ' + (parseFloat(o.monthWage) || 0).toLocaleString() + ' ÷ 30 = ' + dailyWage.toLocaleString());
  explain.push('結清金額 = (' + annualDays + (compDays > 0 ? ' + ' + compDays : '') + ') 天 × ' + dailyWage.toLocaleString() + ' = ' + amount.toLocaleString());

  return {
    hireDate: hireDate, effectDate: effectDate, measureDate: measureDate, totalMonths: totalMonths,
    yearStart: yearStart, entitled: entitled, usedThisYear: used, priorRemain: priorDays,
    statutory: statutory, batchRemainTotal: batchRemainTotal, uncovered: uncovered,
    annualDays: annualDays, basis: basis, items: items, proportional: proportional,
    compDays: compDays, totalDays: totalDays,
    dailyWage: dailyWage, amount: amount, explain: explain, fromLedger: true,
  };
}
