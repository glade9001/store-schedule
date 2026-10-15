/**
 * 假勤共用規則 —— 前端唯一版本（2026-10-16 整理第 1 階段）
 *
 * ⚠️ 為什麼要有這個檔：同一套規則原本散在好幾頁、各寫一份，改了一份忘了另一份就出事。
 *   2026-10-15 實例：國定假日補休「發放→撤銷→再發放」被擋，薪資頁修過、排班頁沒修，16 班正職少補休。
 *   合併前逐份比對過算法相同（特休天數表 4 份逐月算到 40 年相同；整年重算 2 份逐行相同）。
 *
 * 後端（functions/index.js）因為跑在 Node、不能直接用這個檔，另有一份同規則：
 *   recomputeLeaveStats ↔ lvRecomputeLeaveCounters、syncHolidayCompForWeek 的淨額 ↔ lvHolidayCompNet。改規則兩邊一起改。
 *
 * 本檔只有 function 宣告、名稱一律 lv 開頭（同 holidays.js、shift-utils.js 的規矩），任何頁面掛上來都不會撞名。
 */

/** 本機日期 YYYY-MM-DD（不用 toISOString：那是 UTC，台灣半夜 0～8 點會變成昨天） */
function lvLocalYmd(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 勞基法 §38 特休天數：年資（月）→ 天數。滿 6 個月 3、1 年 7、2 年 10、3～4 年 14、5～9 年 15、10 年起每年加 1，最多 30 */
function lvAnnualDays(totalMonths) {
  if (totalMonths < 6) return 0;
  if (totalMonths < 12) return 3;
  if (totalMonths < 24) return 7;
  if (totalMonths < 36) return 10;
  if (totalMonths < 60) return 14;
  if (totalMonths < 120) return 15;
  return Math.min(30, 15 + Math.floor(totalMonths / 12) - 9);
}

/**
 * 按工讀計薪：職稱是工讀，或 payAsPartTime（職務是店長但領時薪的人）。
 * 用在：國定假日不發補休、工時上限的工讀時薪、首頁特休週年提醒。
 * ⚠️ 假勤頁（leave-page.js）、劃休頁（leave-request-page.js）目前只看職稱／寫死姓名，口徑不同，待使用者決定要不要統一。
 */
function lvIsPayPartTime(emp) {
  return !!emp && (!!emp.payAsPartTime || String(emp.role || '').indexOf('工讀') >= 0);
}

/** 某天國定假日補休的淨額（發放 − 撤銷）；不能只看有沒有 comp_earn（撤銷是追加 comp_cancel，原本那筆還在） */
function lvHolidayCompNet(records, date) {
  var net = 0;
  (records || []).forEach(function (r) {
    if (!r || r.date !== date || !(r.source === 'holiday' || String(r.note || '').indexOf('國定假日') >= 0)) return;
    var n = parseFloat(r.days) || 1;
    if (r.type === 'comp_earn') net += n; else if (r.type === 'comp_cancel') net -= n;
  });
  return net;
}

/**
 * 從帳本重算統計快取（特休／補休已用、補休取得、遞延已用、特休批次已用）——排班頁、假勤頁共用。
 * 帳本：annualUsage、compUsage（逐日）、leaveLog（comp_earn／comp_cancel）。後端 onLeaveLogStats 等觸發器也會用同一套規則校正。
 * 補休使用「先扣去年遞延、再扣今年」；特休批次「先拿到先用（FIFO）」，settled 不動，超額記在最新批次（容許負餘額）。
 */
async function lvRecomputeLeaveCounters(empName, yearStr) {
  var empRef = window.db.collection('employees').doc(empName);
  var batchesRef = empRef.collection('leaveBatches');
  var r = await Promise.all([
    empRef.collection('annualUsage').get(),
    empRef.collection('compUsage').get(),
    empRef.collection('leaves').doc(yearStr).get(),
    empRef.collection('leaveLog').get(),
    empRef.collection('comp').doc(String(parseInt(yearStr) - 1)).get(),
    batchesRef.get()
  ]);
  var annSnap = r[0], compSnap = r[1], leaveSnap = r[2], logSnaps = r[3], prevCompSnap = r[4], bSnap = r[5];

  var finalAnnualUse = 0, finalCompUse = 0, annDatesAll = []; // annDatesAll：全部特休使用日（跨年），批次歸屬用
  annSnap.forEach(function (d) { var dt = (d.data().date) || d.id; annDatesAll.push(dt); if (String(dt).indexOf(yearStr) === 0) finalAnnualUse++; });
  compSnap.forEach(function (d) { var dt = (d.data().date) || d.id; if (String(dt).indexOf(yearStr) === 0) finalCompUse++; });

  var cEarn = 0, cCan = 0;
  logSnaps.forEach(function (doc) {
    if (doc.id.indexOf(yearStr) !== 0) return;
    (doc.data().records || []).forEach(function (x) { var rd = parseFloat(x.days) || 0; if (x.type === 'comp_earn') cEarn += rd; if (x.type === 'comp_cancel') cCan += rd; });
  });
  var finalCompEarn = Math.max(0, cEarn - cCan);

  var ld = leaveSnap.exists ? leaveSnap.data() : {};
  var prevC = prevCompSnap.exists ? prevCompSnap.data() : null;
  var carriedActive = !!(prevC && prevC.carried === true && !prevC.settled);
  var carriedAvail = carriedActive ? Math.max(0, (prevC.earned || 0) - (prevC.used || 0)) : 0;
  var carriedUsedNow = carriedActive ? Math.min(finalCompUse, carriedAvail) : 0;
  var currentCompUse = finalCompUse - carriedUsedNow;

  var writes = [
    empRef.collection('leaves').doc(yearStr).set(Object.assign({}, ld, { usedAnnual: finalAnnualUse, earnedComp: finalCompEarn, usedComp: finalCompUse, updatedAt: new Date().toISOString() }), { merge: true }),
    empRef.collection('comp').doc(yearStr).set({ earned: finalCompEarn, used: currentCompUse }, { merge: true })
  ];
  if (carriedActive) writes.push(empRef.collection('comp').doc(String(parseInt(yearStr) - 1)).set({ carriedUsed: carriedUsedNow }, { merge: true }));

  var batches = []; bSnap.forEach(function (d) { batches.push(Object.assign({ id: d.id }, d.data())); });
  var settledUsed = batches.filter(function (b) { return b.settled; }).reduce(function (s, b) { return s + (b.used || 0); }, 0);
  var nonS = batches.filter(function (b) { return !b.settled; }).sort(function (a, b) { return String(a.grantDate || '').localeCompare(String(b.grantDate || '')); });
  var rem = Math.max(0, annDatesAll.length - settledUsed);
  nonS.forEach(function (b, i) {
    var cap = b.days || 0, u = Math.min(cap, rem); rem -= u;
    if (i === nonS.length - 1 && rem > 0) { u += rem; rem = 0; }
    if ((b.used || 0) !== u) writes.push(batchesRef.doc(b.id).set({ used: u }, { merge: true }));
  });

  await Promise.all(writes);
}
