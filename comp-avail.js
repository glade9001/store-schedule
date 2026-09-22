// 補休「已生效」餘額（劃休頁、排班頁共用；2026-09-22 使用者定案）
// 國定假日補休在排班時就發放，但要「過了那天」才能用：9/28 的補休 9/29 起才可用，
// 9/28 以前不能用（包括劃後面日子的補休）——避免之後改班表、那天不上班收回補休時變負數。
// 可用＝現有餘額（comp/{年} earned−used ＋去年遞延）−「還沒過的國定假日補休」。
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
  var t = caToday(), yr = +t.slice(0, 4);
  var emp = window.db.collection('employees').doc(empName);
  var FP = firebase.firestore.FieldPath.documentId();
  var snaps = await Promise.all([
    emp.collection('comp').doc(String(yr)).get().catch(function () { return null; }),
    emp.collection('comp').doc(String(yr - 1)).get().catch(function () { return null; }),
    emp.collection('leaveLog').where(FP, '>=', t.slice(0, 7)).get().catch(function () { return null; })
  ]);
  var cd = snaps[0] && snaps[0].exists ? snaps[0].data() : {};
  var balance = (cd.earned || 0) - (cd.used || 0);
  var pd = snaps[1] && snaps[1].exists ? snaps[1].data() : null;
  if (pd && pd.carried && !pd.settled) balance += Math.max(0, (pd.earned || 0) - (pd.used || 0) - (pd.carriedUsed || 0));

  var byDate = {};
  if (snaps[2]) snaps[2].forEach(function (d) {
    (d.data().records || []).forEach(function (r) {
      var isHol = r.source === 'holiday' || String(r.note || '').indexOf('國定假日') >= 0;
      if (!isHol || !r.date || r.date < t) return;
      var n = parseFloat(r.days) || 1;
      if (r.type === 'comp_earn') byDate[r.date] = (byDate[r.date] || 0) + n;
      else if (r.type === 'comp_cancel') byDate[r.date] = (byDate[r.date] || 0) - n;
    });
  });
  var pending = Object.keys(byDate).filter(function (k) { return byDate[k] > 0; }).sort()
    .map(function (k) { return { date: k, n: byDate[k] }; });
  var pn = pending.reduce(function (a, p) { return a + p.n; }, 0);
  return { balance: balance, effective: balance - pn, pending: pending };
}

/** 「9/29 起可用 1 天、10/11 起可用 1 天」 */
function caPendingText(pending) {
  return (pending || []).map(function (p) {
    var d = new Date(p.date + 'T00:00:00'); d.setDate(d.getDate() + 1);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' 起可用 ' + p.n + ' 天';
  }).join('、');
}
