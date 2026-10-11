// ===== 首頁「每日營業」卡片（2026-10-11 使用者選 B 標準、放在常用功能上方）=====
// 店長：本店這個月有輸入每日營業才出現（沒填就整張不出現）；三行＝剩下每天要做到（達標／比去年）、最新一天比去年同星期、工時燈號。
// 加盟主／admin：固定列三店，沒輸入的店整行留白。
// 只顯示店長本來就看得到的數字（業績、達標、工時），不露經營報酬與目標利潤率。
// 口徑同每日營業頁與儀表板：扣大單多出的金額（lbBigDays）、去年同期＝364 天前（同星期幾）、達標＝lbEvaluate.targetPds。
// 讀取量：工時上限要讀損益、人事、薪資、半年每日營業（約 200 筆／店）→ 結果在本機快取 30 分鐘；
// 每日營業頁存檔時會清掉該店快取（daily-sales-page.js），輸入完回首頁馬上看到新數字。
// 比照 shift-utils.js：只有 function 與 var（前綴 hd），掛在首頁不會撞名。
var HD_TTL = 30 * 60 * 1000;
var hdBusy = false;

function hdUser() { try { return currentUser; } catch (e) { return null; } }
function hdEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function hdMoney(v) { return Math.round(v).toLocaleString('en-US'); }
function hdWan(v) { return Math.abs(v) >= 10000 ? (Math.round(v / 1000) / 10) + ' 萬' : hdMoney(v); }
function hdPct(v) { return (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%'; }
function hdMd(d) { return (+d.slice(5, 7)) + '/' + (+d.slice(8)); }
function hdYm() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function hdStores(u) {
  if (!u) return [];
  if (['owner', 'admin'].indexOf(u.permission) >= 0) {
    var all = []; try { all = (appConfig.stores || []).filter(function (s) { return s && s !== '人力支援'; }); } catch (e) {}
    return all.length ? all : ['美德', '聯鑫', '錦花'];
  }
  return u.permission === 'manager' && u.store ? [u.store] : [];
}
function hdCacheGet(store, ym) {
  try { var c = JSON.parse(localStorage.getItem('hdCache:' + store) || 'null'); if (c && c.ym === ym && Date.now() - c.at < HD_TTL) return c.v; } catch (e) {}
  return undefined;
}
function hdCacheSet(store, ym, v) { try { localStorage.setItem('hdCache:' + store, JSON.stringify({ at: Date.now(), ym: ym, v: v })); } catch (e) {} }

// 一家店的摘要；這個月沒有每日營業回 null
async function hdCompute(store, ym) {
  var db = window.db, ref = db.collection('stores').doc(store), FP = firebase.firestore.FieldPath.documentId();
  var n = lbDaysIn(ym), first = ym + '-01', lastDay = ym + '-' + String(n).padStart(2, '0');
  // 先用便宜的查詢確認這個月有沒有輸入，沒有就不讀其他東西
  var cur = await ref.collection('dailySales').where(FP, '>=', first).where(FP, '<=', lastDay).get().catch(function () { return null; });
  var days = {}; if (cur) cur.forEach(function (d) { if (d.data().sales != null) days[d.id] = d.data(); });
  var ds = Object.keys(days).sort(); if (!ds.length) return null;
  // 工時上限（同排班頁）：班表週次＝這個月每一天所在的週
  var weeks = {}; for (var dt = first; dt <= lastDay; dt = shiftDateAdd(dt, 1)) weeks[shiftWeekStr(dt)] = 1;
  weeks = Object.keys(weeks);
  var res = await Promise.all([
    lbLoadStore(db, store),
    ref.collection('dailySales').where(FP, '>=', shiftDateAdd(first, -364)).where(FP, '<=', shiftDateAdd(lastDay, -364)).get().catch(function () { return null; }),
  ].concat(weeks.map(function (w) { return ref.collection('weeks').doc(w).get().catch(function () { return null; }); })));
  var lb = res[0], ly = {}; if (res[1]) res[1].forEach(function (d) { ly[d.id] = d.data(); });
  var recs = []; res.slice(2).forEach(function (sn, i) { if (sn && sn.exists) (sn.data().records || []).forEach(function (r) { recs.push(Object.assign({}, r, { week: weeks[i] })); }); });
  var ev = lbEvaluate(lb, recs, ym);
  // 業績：扣大單多出的金額（基準＝上月＋本月）
  var pm = lbAddMonth(ym, -1), win = {};
  Object.keys(lb.daily || {}).forEach(function (d) { if (d.slice(0, 7) === pm) win[d] = lb.daily[d]; });
  Object.keys(days).forEach(function (d) { win[d] = days[d]; });
  var big = lbBigDays(win).big, lyBig = lbBigDays(ly).big;
  var adj = function (x, b) { return +x.sales - (b ? b.excess : 0); };
  var cum = 0; ds.forEach(function (d) { cum += adj(days[d], big[d]); });
  var lastD = ds[ds.length - 1], rem = n - (+lastD.slice(8));
  var tgt = ev && ev.targetPds;
  var lyAll = 0, lyOk = true;
  for (var i = 1; i <= n; i++) { var k = shiftDateAdd(ym + '-' + String(i).padStart(2, '0'), -364), l = ly[k]; if (!l || l.sales == null) { lyOk = false; break; } lyAll += adj(l, lyBig[k]); }
  var s1 = 0, s0 = 0, pk = 0;
  ds.forEach(function (d) { var k2 = shiftDateAdd(d, -364), l2 = ly[k2]; if (l2 && l2.sales != null) { s1 += adj(days[d], big[d]); s0 += adj(l2, lyBig[k2]); pk++; } });
  var lyLast = ly[shiftDateAdd(lastD, -364)];
  var lt = ev && ev.light;
  return {
    lastD: lastD, lastSales: +days[lastD].sales, lastBig: !!big[lastD],
    lastLy: lyLast && lyLast.sales != null ? +lyLast.sales : null,
    yoy: pk >= 5 ? s1 / s0 - 1 : null, rem: rem,
    needTgt: rem > 0 && tgt != null ? (tgt * n - cum) / rem : null,
    needLy: rem > 0 && lyOk ? (lyAll - cum) / rem : null,
    light: lt ? { level: lt.level, hours: ev.sched.hours, capP: lt.capP, lastDate: ev.sched.lastDate } : null,
  };
}

async function hdLoad() {
  var card = document.getElementById('dsHomeCard'); if (!card) return;
  var u = hdUser(), stores = hdStores(u);
  if (!stores.length || typeof lbLoadStore !== 'function') { card.style.display = 'none'; return; }
  if (hdBusy) return; hdBusy = true;
  var ym = hdYm(), out = {};
  try {
    await Promise.all(stores.map(async function (s) {
      var c = hdCacheGet(s, ym);
      if (c !== undefined) { out[s] = c; return; }
      try { out[s] = await Promise.race([hdCompute(s, ym), new Promise(function (r) { setTimeout(function () { r(undefined); }, 15000); })]); } // Firestore 沒有逾時
      catch (e) { console.warn('[home-ds]', s, e); out[s] = undefined; }
      if (out[s] !== undefined) hdCacheSet(s, ym, out[s]);
    }));
  } finally { hdBusy = false; }
  hdRender(card, u, stores, ym, out);
}

function hdRender(card, u, stores, ym, out) {
  var owner = ['owner', 'admin'].indexOf(u.permission) >= 0, mo = +ym.slice(5);
  var go = function (s) { return "location.href='daily-sales.html?store=" + encodeURIComponent(s) + "'"; };
  if (!owner) {
    var s = stores[0], x = out[s];
    if (!x) { card.style.display = 'none'; return; }   // 沒填 → 不出現
    var LC = { green: ['🟢', '#137333'], yellow: ['🟡', '#a15c00'], red: ['🔴', '#c5221f'] };
    var rows = [];
    if (x.rem > 0 && (x.needTgt != null || x.needLy != null)) {
      rows.push('<div class="hd-l">剩下 ' + x.rem + ' 天每天要做到</div><div class="hd-need">' +
        (x.needTgt != null ? '<span>達標 <b' + (x.needTgt <= 0 ? ' class="hd-ok">已做到' : '>' + hdMoney(x.needTgt)) + '</b></span>' : '') +
        (x.needLy != null ? '<span>比去年 <b' + (x.needLy <= 0 ? ' class="hd-ok">已超過' : '>' + hdMoney(x.needLy)) + '</b></span>' : '') + '</div>');
    }
    rows.push('<div class="hd-row"><span>' + hdMd(x.lastD) + ' 營業額</span><b>' + hdMoney(x.lastSales) + '</b>' +
      (x.lastLy ? '<span class="' + (x.lastSales >= x.lastLy ? 'hd-up' : 'hd-dn') + '">比去年同星期 ' + hdPct(x.lastSales / x.lastLy - 1) + '</span>' : '') +
      (x.lastBig ? '<span class="hd-big">大單</span>' : '') + '</div>');
    if (x.light) {
      var c = LC[x.light.level] || LC.green;
      rows.push('<div class="hd-row"><span>' + c[0] + ' 工時排到 ' + hdMd(x.light.lastDate) + '</span><b style="color:' + c[1] + '">' + hdMoney(x.light.hours) + 'h</b><span>／上限 ' + hdMoney(x.light.capP) + 'h</span></div>');
    }
    card.innerHTML = '<div class="hd-h" onclick="' + go(s) + '"><span class="hd-t">🧾 ' + hdEsc(s) + ' ' + mo + '月營業</span><span class="hd-more">看分析 ›</span></div>' + rows.join('');
    card.style.display = '';
    return;
  }
  // 加盟主：三店固定列，沒輸入的店留白
  card.innerHTML = '<div class="hd-h"><span class="hd-t">🧾 ' + mo + '月每日營業</span></div>' + stores.map(function (s) {
    var x = out[s];
    return '<div class="hd-orow"' + (x ? ' onclick="' + go(s) + '"' : '') + '><span class="hd-on">' + hdEsc(s) + '</span>' +
      (x ? (x.yoy != null ? '<span class="' + (x.yoy >= 0 ? 'hd-up' : 'hd-dn') + '">比去年 ' + hdPct(x.yoy) + '</span>' : '<span class="hd-mut">到 ' + hdMd(x.lastD) + '</span>') +
        (x.needTgt != null ? '<span class="hd-ot">每天要 <b' + (x.needTgt <= 0 ? ' class="hd-ok">已達標' : '>' + hdMoney(x.needTgt)) + '</b></span>' : '') + '<span class="hd-arr">›</span>' : '') + '</div>';
  }).join('');
  card.style.display = '';
}

(function () {
  var css = document.createElement('style');
  css.textContent =
    '#dsHomeCard{padding:14px 16px;}' +
    '.hd-h{display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;}' +
    '.hd-t{font-size:14.5px;font-weight:900;color:var(--navy,#0e2140);}' +
    '.hd-more{margin-left:auto;font-size:12.5px;font-weight:800;color:var(--primary,#1a73e8);}' +
    '.hd-l{font-size:12.5px;font-weight:800;color:var(--text-muted,#64748b);}' +
    '.hd-need{display:flex;gap:16px;flex-wrap:wrap;margin:2px 0 8px;font-size:13px;}' +
    '.hd-need b{font-size:20px;font-weight:900;margin-left:2px;}' +
    '.hd-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;padding:7px 0;border-top:1px solid #f1f4f8;font-size:13px;}' +
    '.hd-row b{font-size:15px;font-weight:900;}' +
    '.hd-up{color:#137333;font-weight:800;} .hd-dn{color:#c5221f;font-weight:800;} .hd-ok{color:#137333;}' +
    '.hd-big{font-size:11px;font-weight:800;color:#a15c00;background:#fef3c7;border-radius:6px;padding:1px 6px;}' +
    '.hd-orow{display:flex;align-items:center;gap:10px;min-height:40px;border-top:1px solid #f1f4f8;font-size:13px;cursor:pointer;}' +
    '.hd-orow:first-of-type{border-top:none;}' +
    '.hd-on{font-size:14px;font-weight:900;min-width:40px;}' +
    '.hd-ot{margin-left:auto;} .hd-ot b{font-size:15px;font-weight:900;}' +
    '.hd-mut{color:var(--text-muted,#64748b);} .hd-arr{color:#94a3b8;font-size:17px;}';
  document.head.appendChild(css);
})();
