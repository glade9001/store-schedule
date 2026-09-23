// 補休「已生效」餘額（劃休頁、排班頁共用；2026-09-22 使用者定案）
// 國定假日補休在排班時就發放，但要「過了那天」才能用：9/28 的補休 9/29 起才可用，
// 9/28 以前不能用（包括劃後面日子的補休）——避免之後改班表、那天不上班收回補休時變負數。
// 可用＝今年取得（leaveLog）−今年使用（compUsage）＋去年遞延 −「還沒過的國定假日補休」。
// 還沒過的＝leaveLog 裡 comp_earn 來源是國定假日、日期 ≥ 今天，扣掉同日期的國定假日補休撤銷（comp_cancel）。
// 本檔只有 function 宣告（前綴 ca），任何頁面掛上來都不會撞名。

function caToday() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * @returns {Promise<{balance:number, effective:number, pending:Array<{date:string, n:number}>}>}
 *   balance＝原本的餘額；effective＝現在可以用的；pending＝還沒生效的國定假日補休（日期、天數）
 */
async function caCompAvailability(empName) {
  // ⚠️ 取得／使用都從帳本算（方案C：leaveLog 的 comp_earn/comp_cancel、compUsage 逐日文件），不讀 comp/{年}.earned/used——
  //    那兩個統計欄位會漂（某正職（大夜） comp/2026.earned=4，但 leaveLog 有 5 筆發放 → 可用被算成 -1，2026-09-22）
  var t = caToday(), yr = +t.slice(0, 4);
  var emp = window.db.collection('employees').doc(empName);
  var FP = firebase.firestore.FieldPath.documentId();
  var snaps = await Promise.all([
    emp.collection('leaveLog').where(FP, '>=', yr + '-01').where(FP, '<=', yr + '-12').get(),
    emp.collection('compUsage').where(FP, '>=', yr + '-01-01').where(FP, '<=', yr + '-12-31').get(),
    emp.collection('comp').doc(String(yr - 1)).get().catch(function () { return null; })
  ]);
  var earned = 0, byDate = {};
  snaps[0].forEach(function (d) {
    (d.data().records || []).forEach(function (r) {
      var n = parseFloat(r.days) || 0;
      if (r.type === 'comp_earn') earned += n;
      else if (r.type === 'comp_cancel') earned = Math.max(0, earned - n);
      // 還沒過的國定假日補休
      var isHol = r.source === 'holiday' || String(r.note || '').indexOf('國定假日') >= 0;
      if (!isHol || !r.date || r.date < t) return;
      if (r.type === 'comp_earn') byDate[r.date] = (byDate[r.date] || 0) + (n || 1);
      else if (r.type === 'comp_cancel') byDate[r.date] = (byDate[r.date] || 0) - (n || 1);
    });
  });
  var used = snaps[1].size;
  var balance = earned - used;
  // 去年遞延（沿用劃休頁原本的算法）
  var pd = snaps[2] && snaps[2].exists ? snaps[2].data() : null;
  if (pd && pd.carried && !pd.settled) balance += Math.max(0, (pd.earned || 0) - (pd.used || 0) - (pd.carriedUsed || 0));
  var pending = Object.keys(byDate).filter(function (k) { return byDate[k] > 0; }).sort()
    .map(function (k) { return { date: k, n: byDate[k] }; });
  var pn = pending.reduce(function (a, p) { return a + p.n; }, 0);
  return { balance: balance, effective: balance - pn, pending: pending, earned: earned, used: used };
}

/** 「9/29 起可用 1 天、10/11 起可用 1 天」 */
function caPendingText(pending) {
  return (pending || []).map(function (p) {
    var d = new Date(p.date + 'T00:00:00'); d.setDate(d.getDate() + 1);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' 起可用 ' + p.n + ' 天';
  }).join('、');
}
