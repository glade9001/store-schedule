/**
 * 特休／補休「存摺」計算層（2026-10-26）
 *
 * 為什麼要有這支：特補休頁原本把同一個數字分散在 4 個區塊（概況、法規表、批次卡、使用明細），
 * 而且來源不同——概況讀逐日帳本、批次卡讀批次上的 used 快取——兩邊對不上時沒人看得出哪個對
 * （某正職批次卡寫已用 0、概況寫已用 9；結清後概況還會出現「剩餘 −9」）。
 * 改成存摺：所有異動照日期排、每一列帶「這筆之後剩幾天」，畫面上只有一個數字。
 *
 * 規則（與結清試算 leave-settle.js settleFromLedger 相同口徑）：
 *   - 使用一律以逐日帳本（annualUsage／compUsage）為準，不讀批次 used。
 *   - 特休使用「先拿到先用」：扣在取得日 ≤ 使用日、還有剩的最早批次（不看到期日）。
 *   - 轉工讀／離職「特補休結清」＝餘額歸零（結清當下剩多少就結多少）。
 *   - 到期沒處理、週年沒建批次 → 列成「待處理」，不動餘額（錢還是要算給員工）。
 *
 * 本檔比照 leave-settle.js：只有 function 宣告、沒有頂層 const/let（多支 script 共用全域，頂層 const 撞名會讓整頁全滅）。
 */

/** 這筆 leaveLog 是不是「轉工讀／離職特補休結清」（整個人歸零那種），不是單一批次到期結算 */
function pbIsWholeSettle(r) {
  return !!r && r.type === 'settle' && String(r.note || '').indexOf('特補休結清') >= 0;
}

/** 結清在存摺上的日期＝生效日前一天（備註裡有「生效日 YYYY-MM-DD」）；讀不到就用辦理日 */
function pbSettleAt(r) {
  var m = String(r.note || '').match(/生效日\s*(\d{4}-\d{2}-\d{2})/);
  if (!m) return r.date;
  var d = new Date(m[1] + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 實際到期日：遞延過的往後一年（算法與特休頁 dateAddExpire(expireDate,12) 一字不差，兩邊才對得上） */
function pbExpireOf(b) {
  if (!b.expireDate) return '';
  if (!b.carried) return b.expireDate;
  var d = new Date(b.expireDate);
  d.setMonth(d.getMonth() + 12); d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * 特休存摺
 * @param o.batches  leaveBatches（含已結清）
 * @param o.usage    annualUsage [{date, store, source, savedBy}]
 * @param o.logs     leaveLog 攤平 [{type, date, days, note, actualAmount, ...}]
 * @param o.schedule 依到職日應有的批次 [{label, grantDate, expireDate, days}]（工讀傳 []）
 * @param o.today    YYYY-MM-DD
 * @return {rows(由舊到新), balance, batchRem{id:剩}, nextExpire{date,days,label}|null, todo(待處理筆數)}
 */
function pbAnnualBook(o) {
  var today = o.today;
  var bs = (o.batches || []).filter(function (b) { return !b._legacy && b.grantDate; })
    .slice().sort(function (a, b) { return String(a.grantDate).localeCompare(String(b.grantDate)); });
  var ev = [];   // [date, 先後順序, 事件]
  bs.forEach(function (b) {
    ev.push([b.grantDate, 0, { k: 'grant', b: b }]);
    var whole = String(b.settledNote || '').indexOf('特補休結清') >= 0;
    if (b.settled && !whole && b.settledAt) ev.push([b.settledAt, 3, { k: 'bsettle', b: b }]);
    var exp = pbExpireOf(b);
    if (b.carried && b.expireDate) ev.push([b.expireDate, 4, { k: 'carry', b: b, to: exp }]);
    if (exp && exp < today) ev.push([exp, 5, { k: 'expire', b: b }]);
  });
  (o.usage || []).forEach(function (u) { if (u && u.date) ev.push([u.date, 1, { k: 'use', u: u }]); });
  // 結清算的是「到生效日前一天」為止（leave-settle.js 的量測點），生效日前已排的特休也算在裡面
  // → 放在生效日前一天、當天使用之後，不是放在辦理那天（否則 10/26 辦理、10/28～30 已排的特休會變成歸零後再扣成負數）
  (o.logs || []).forEach(function (r) { if (pbIsWholeSettle(r)) ev.push([pbSettleAt(r), 2, { k: 'wsettle', r: r }]); });
  // 系統上線前的年資（例：2017 到職、批次從 2026 才開始建）不算漏建：
  // 只看「還沒過期」或「不早於最早一個已建批次」的週年
  var firstGrant = bs.length ? bs[0].grantDate : '';
  (o.schedule || []).forEach(function (s) {
    if (!s.grantDate || s.grantDate > today) return;
    if (!(s.expireDate >= today || (firstGrant && s.grantDate >= firstGrant))) return;
    var has = bs.some(function (b) { return Math.abs((new Date(b.grantDate) - new Date(s.grantDate)) / 86400000) <= 31; });
    if (!has) ev.push([s.grantDate, 0.5, { k: 'missing', s: s }]);
  });
  ev.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]; });

  var rem = {}, bal = 0, rows = [], todo = 0, settledIds = {};
  ev.forEach(function (e) {
    var d = e[0], x = e[2], row = null;
    if (x.k === 'grant') {
      rem[x.b.id] = parseFloat(x.b.days) || 0; bal += rem[x.b.id];
      row = { date: d, kind: 'grant', title: (x.b.label || x.b.note || '特休') + ' 取得', delta: rem[x.b.id],
        sub: '到期 ' + (pbExpireOf(x.b) || '—') + (x.b.carried ? '（已遞延）' : ''), batchId: x.b.id };
    } else if (x.k === 'use') {
      var hit = null;
      for (var i = 0; i < bs.length; i++) if (bs[i].grantDate <= d && rem[bs[i].id] > 0 && !settledIds[bs[i].id]) { hit = bs[i]; break; }
      if (hit) rem[hit.id]--;
      bal -= 1;
      row = { date: d, kind: 'use', title: '休特休', delta: -1, future: d > today, over: !hit,
        sub: [x.u.store, pbSourceText(x.u)].filter(Boolean).join('・'), usageDate: d, manual: x.u.source === 'manual' };
    } else if (x.k === 'bsettle') {
      var n = Math.min(rem[x.b.id] || 0, parseFloat(x.b.settledDays) || 0);
      rem[x.b.id] = (rem[x.b.id] || 0) - n; settledIds[x.b.id] = true; bal -= n;
      row = { date: d, kind: 'settle', title: (x.b.label || '特休') + ' 到期結算（折發工資）', delta: -n };
    } else if (x.k === 'wsettle') {
      var all = Math.max(0, bal);
      Object.keys(rem).forEach(function (id) { rem[id] = 0; settledIds[id] = true; });
      bal -= all;
      row = { date: d, kind: 'settle', title: String(x.r.note || '').indexOf('離職') >= 0 ? '離職結清（折發工資）' : '轉工讀結清（折發工資）',
        delta: -all, amount: x.r.actualAmount != null ? x.r.actualAmount : null, sub: x.r.date && x.r.date !== d ? x.r.date + ' 辦理' : '' };
    } else if (x.k === 'carry') {
      row = { date: d, kind: 'info', title: (x.b.label || '特休') + ' 遞延', delta: 0, sub: '到期延到 ' + x.to };
    } else if (x.k === 'expire') {
      if (!x.b.settled && (rem[x.b.id] || 0) > 0) {
        todo++;
        row = { date: d, kind: 'todo', title: (x.b.label || '特休') + ' 到期還剩 ' + rem[x.b.id] + ' 天沒處理', delta: 0,
          sub: x.b.carried ? '已遞延過，要折發工資' : '要折發工資或遞延', batchId: x.b.id, canCarry: !x.b.carried, days: rem[x.b.id] };
      }
    } else if (x.k === 'missing') {
      todo++;
      row = { date: d, kind: 'todo', title: x.s.label + ' 應取得 ' + x.s.days + ' 天，還沒建立', delta: 0,
        sub: '建立後才會加進餘額', missing: x.s };
    }
    if (row) { row.balance = bal; rows.push(row); }
  });

  var next = null;
  bs.forEach(function (b) {
    var exp = pbExpireOf(b);
    if (settledIds[b.id] || b.settled || !(rem[b.id] > 0) || !exp || exp < today) return;
    if (!next || exp < next.date) next = { date: exp, days: rem[b.id], label: b.label || '' };
  });
  return { rows: rows, balance: bal, batchRem: rem, nextExpire: next, todo: todo };
}

/**
 * 補休存摺（只看今年；去年遞延沒結算的當成期初）
 * @param o.logs  leaveLog 攤平（全部年份都可以，這裡會篩今年）
 * @param o.usage compUsage
 * @param o.prev  comp/{去年} 文件 {earned, used, carried, settled}
 * @param o.year  '2026'
 * @return {rows, balance, pending(今年還沒到的國定假日補休天數)}
 */
function pbCompBook(o) {
  var y = String(o.year), today = o.today, inY = function (d) { return String(d || '').slice(0, 4) === y; };
  var ev = [], prev = o.prev || {};
  if (prev.carried && !prev.settled) {
    var open = Math.max(0, (parseFloat(prev.earned) || 0) - (parseFloat(prev.used) || 0));
    if (open > 0) ev.push([y + '-01-01', 0, { k: 'open', n: open }]);
  }
  var logs = (o.logs || []).filter(function (r) { return r && inY(r.date); })
    .slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || ((a.ts || 0) - (b.ts || 0)); });
  // 撤銷配對：同一天（國定假日）優先，否則撤最新一筆還沒被撤的發放（與薪資頁 Bug6 的扣法相同）
  var earns = [];
  logs.forEach(function (r) {
    if (r.type === 'comp_earn') { var e = { r: r, cancel: null }; earns.push(e); ev.push([r.date, 1, { k: 'earn', e: e }]); }
  });
  logs.forEach(function (r) {
    if (r.type === 'comp_cancel') {
      if (r.source === 'settle') { ev.push([r.date, 3, { k: 'csettle', r: r }]); return; }
      var t = null, i;
      for (i = earns.length - 1; i >= 0; i--) if (!earns[i].cancel && earns[i].r.date === r.date) { t = earns[i]; break; }
      if (!t) for (i = earns.length - 1; i >= 0; i--) if (!earns[i].cancel && earns[i].r.date <= r.date) { t = earns[i]; break; }
      if (t) t.cancel = r; else ev.push([r.date, 2, { k: 'cancel', r: r }]);
    }
    if (r.type === 'settle' && String(r.note || '').indexOf('補休薪資結算') >= 0) ev.push([r.date, 3, { k: 'ysettle', r: r }]);
  });
  (o.usage || []).forEach(function (u) { if (u && inY(u.date)) ev.push([u.date, 2, { k: 'use', u: u }]); });
  ev.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]; });

  var bal = 0, rows = [], pending = 0;
  ev.forEach(function (e) {
    var d = e[0], x = e[2], row = null;
    if (x.k === 'open') {
      bal += x.n; row = { date: d, kind: 'grant', title: '去年遞延', delta: x.n, sub: '今年 12/31 前要休完，不能再遞延' };
    } else if (x.k === 'earn') {
      var r = x.e.r, n = parseFloat(r.days) || 0, src = pbCompSourceText(r);
      if (x.e.cancel) {
        row = { date: d, kind: 'void', title: src.title, delta: 0, sub: '已撤銷' + (x.e.cancel.savedBy ? '（' + x.e.cancel.savedBy + '）' : ''), struck: n };
      } else {
        bal += n;
        var fut = r.source === 'holiday' && d > today;
        if (fut) pending += n;
        row = { date: d, kind: 'grant', title: src.title, delta: n, sub: src.sub + (fut ? '・當天才能用' : ''), future: fut,
          earn: { ym: r.ym, ts: r.ts || null, date: r.date, source: r.source || '', note: r.note || '', days: n } };
      }
    } else if (x.k === 'cancel') {
      var c = parseFloat(x.r.days) || 0; bal -= c;
      row = { date: d, kind: 'settle', title: '撤銷', delta: -c, sub: x.r.note || '' };
    } else if (x.k === 'use') {
      bal -= 1; row = { date: d, kind: 'use', title: '休補休', delta: -1, future: d > today, sub: [x.u.store, pbSourceText(x.u)].filter(Boolean).join('・'), usageDate: d, manual: x.u.source === 'manual' };
    } else if (x.k === 'csettle') {
      var s = parseFloat(x.r.days) || 0; bal -= s;
      row = { date: d, kind: 'settle', title: '結清（折發工資）', delta: -s };
    } else if (x.k === 'ysettle') {
      var ys = parseFloat(x.r.days) || 0; bal -= ys;
      row = { date: d, kind: 'settle', title: '年度結算（折發工資）', delta: -ys };
    }
    if (row) { row.balance = bal; rows.push(row); }
  });
  return { rows: rows, balance: bal, pending: pending };
}

/** 使用紀錄的來源（排班畫上的／手動補登） */
function pbSourceText(u) {
  var s = String(u.source || '');
  if (s === 'manual') return '手動補登' + (u.savedBy ? '・' + u.savedBy : '');
  return '';
}

/** 補休發放的來源文字 */
function pbCompSourceText(r) {
  var note = String(r.note || ''), m = note.match(/\d{4}-\d{2}-\d{2}\s*(\S+?)\s*國定假日/);
  if (r.source === 'holiday' || note.indexOf('國定假日') >= 0) return { title: (m ? m[1] : '國定假日') + '上班', sub: '國定假日補休' };
  if (r.source === 'unworked') return { title: '應休未休', sub: '薪資頁發放' };
  return { title: '補休取得', sub: [note, r.savedBy].filter(Boolean).join('・') };
}
