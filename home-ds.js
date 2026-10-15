// ===== 首頁「門市經營看板」（2026-10-11 使用者：每日營業做成儀表板樣子、有圖像化；放在常用功能上方）=====
// 店長：本店這個月有輸入每日營業才出現（沒填就整張不出現）；三行＝剩下每天要做到（達標／比去年）、最新一天比去年同星期、工時燈號。
// 加盟主／admin：固定列三店，沒輸入的店整行留白。
// 只顯示店長本來就看得到的數字（業績、達標、工時），不露經營報酬與目標利潤率。
// 口徑同每日營業頁與儀表板：扣大單多出的金額（lbBigDays）、去年同期＝364 天前（同星期幾）、達標＝lbEvaluate.targetPds。
// 讀取量：工時上限要讀損益、人事、薪資、半年每日營業（約 200 筆／店）→ 結果在本機快取 30 分鐘；
// 每日營業頁存檔時會清掉該店快取（daily-sales-page.js），輸入完回首頁馬上看到新數字。
// 比照 shift-utils.js：只有 function 與 var（前綴 hd），掛在首頁不會撞名。
var HD_TTL = 30 * 60 * 1000;
var HD_KEY = 'hdc6:';   // 快取鍵（資料格式改版就換名字，舊快取自然失效）
var HD_COLORS = ['#c0841f', '#2f8fcc', '#d9628e'];   // 三店在深藍底上的顏色（dataviz 驗證：亮度帶、色盲分辨、對比都過）
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
  try { var c = JSON.parse(localStorage.getItem(HD_KEY + store) || 'null'); if (c && c.ym === ym && Date.now() - c.at < HD_TTL) return c.v; } catch (e) {}
  return undefined;
}
function hdCacheSet(store, ym, v) { try { localStorage.setItem(HD_KEY + store, JSON.stringify({ at: Date.now(), ym: ym, v: v })); } catch (e) {} }

// 一家店的摘要；這個月沒有每日營業回 null
async function hdCompute(store, ym) {
  var db = window.db, ref = db.collection('stores').doc(store), FP = firebase.firestore.FieldPath.documentId();
  var n = lbDaysIn(ym), first = ym + '-01', lastDay = ym + '-' + String(n).padStart(2, '0');
  // 先用便宜的查詢確認這個月有沒有輸入，沒有就不讀其他東西
  var cur = await ref.collection('dailySales').where(FP, '>=', first).where(FP, '<=', lastDay).get().catch(function () { return null; });
  var days = {}; if (cur) cur.forEach(function (d) { if (d.data().sales != null) days[d.id] = d.data(); });
  var ds = Object.keys(days).sort(); if (!ds.length) return null;
  // 工時上限（同排班頁）：班表週次＝這個月每一天所在的週
  var winFrom = shiftDateAdd(ds[ds.length - 1], -55); // 本週提醒：近 8 週星期幾人力
  var weeks = {}; for (var dt = winFrom < first ? winFrom : first; dt <= lastDay; dt = shiftDateAdd(dt, 1)) weeks[shiftWeekStr(dt)] = 1;
  weeks = Object.keys(weeks);
  var res = await Promise.all([
    lbLoadStore(db, store),
    ref.collection('dailySales').where(FP, '>=', shiftDateAdd(first, -364 - 7)).where(FP, '<=', shiftDateAdd(lastDay, -364)).get().catch(function () { return null; }),
  ].concat(weeks.map(function (w) { return ref.collection('weeks').doc(w).get().catch(function () { return null; }); })));
  var lb = res[0], ly = {}, ly7 = {};   // ly＝本月對應的去年；ly7 另含近 7 日跨到上個月的部分
  if (res[1]) res[1].forEach(function (d) { ly7[d.id] = d.data(); if (d.id >= shiftDateAdd(first, -364)) ly[d.id] = d.data(); });
  var recs = []; res.slice(2).forEach(function (sn, i) { if (sn && sn.exists) (sn.data().records || []).forEach(function (r) { recs.push(Object.assign({}, r, { week: weeks[i] })); }); });
  var ev = lbEvaluate(lb, recs, ym);
  // 業績：扣大單多出的金額（基準＝上月＋本月）
  var pm = lbAddMonth(ym, -1), win = {};
  Object.keys(lb.daily || {}).forEach(function (d) { if (d.slice(0, 7) === pm) win[d] = lb.daily[d]; });
  Object.keys(days).forEach(function (d) { win[d] = days[d]; });
  var bigOn = !(lb.pds && lb.pds.bigOn === false); // 大單有進損益表的店（聯鑫）不扣
  var big = lbBigDays(win, bigOn).big, lyBig = lbBigDays(ly, bigOn).big;
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
  // 看板用：本月營業額（照實際輸入）、來客、客單、近 7 日（含去年同星期）、月底推估
  var raw = 0, cust = 0, cn = 0, cs = 0;
  ds.forEach(function (d) { raw += +days[d].sales; if (+days[d].customers > 0) { cust += +days[d].customers; cn++; cs += +days[d].sales; } });
  var lcust = 0, lcn = 0, curPair = 0;
  ds.forEach(function (d) { var l3 = ly[shiftDateAdd(d, -364)]; if (l3 && +l3.customers > 0 && +days[d].customers > 0) { lcust += +l3.customers; curPair += +days[d].customers; lcn++; } });
  var chart = [];
  for (var j = 6; j >= 0; j--) {
    var cd = shiftDateAdd(lastD, -j), cx = days[cd] || (lb.daily || {})[cd], cl = ly7[shiftDateAdd(cd, -364)];
    chart.push({ d: cd, v: cx && cx.sales != null ? +cx.sales : null, p: cl && cl.sales != null ? +cl.sales : null,
      c: cx && +cx.customers > 0 ? +cx.customers : null, pc: cl && +cl.customers > 0 ? +cl.customers : null });   // c／pc：來客（2026-10-16 走勢可切換）
  }
  var proj = cum;
  if (rem > 0) {
    if (lyOk && pk >= 5) { var lr = 0; for (var q = +lastD.slice(8) + 1; q <= n; q++) { var kq = shiftDateAdd(ym + '-' + String(q).padStart(2, '0'), -364); lr += adj(ly[kq], lyBig[kq]); } proj = cum + lr * (s1 / s0); }
    else proj = cum / ds.length * n;
  }
  return {
    lastD: lastD, days: ds.length, raw: raw, rem: rem,
    cust: cn ? cust / cn : null, ticket: cust ? cs / cust : null, custYoy: lcn >= 5 ? curPair / lcust - 1 : null,
    yoy: pk >= 5 ? s1 / s0 - 1 : null,
    needTgt: rem > 0 && tgt != null ? (tgt * n - cum) / rem : null,
    needLy: rem > 0 && lyOk ? (lyAll - cum) / rem : null,
    proj: proj, tgtMonth: tgt != null ? tgt * n : null, beMonth: ev && ev.beSchedPds != null ? ev.beSchedPds * n : null,
    light: lt ? { level: lt.level, hours: ev.sched.hours, capP: lt.capP, lastDate: ev.sched.lastDate } : null,
    tip: hdTip(lt, ev, days, lb.daily || {}, ly7, recs, lastD, winFrom),
    chart: chart,
  };
}

// 本週提醒（2026-10-11 使用者選）：一次只挑一件最值得做的事
//   ① 排班超過上限 → 要調班　② 來客連續 5 天以上低於去年同星期 → 留意流失　③ 近 8 週每排 1 小時接客最少的星期 → 排班可優先減
var HD_OFF = ['排休', '指休', '特休', '補休', '清空', ''];
function hdTip(lt, ev, days, daily, ly, recs, lastD, from) {
  if (lt && lt.level === 'red') return '排班已超過上限 ' + hdMoney(ev.sched.hours - lt.capP) + ' 小時，請調整班表';
  var all = Object.assign({}, daily, days), streak = 0;
  for (var d = lastD; ; d = shiftDateAdd(d, -1)) {
    var c = all[d], l = ly[shiftDateAdd(d, -364)];
    if (!c || !l || !(+c.customers > 0) || !(+l.customers > 0) || +c.customers >= +l.customers) break;
    streak++;
  }
  if (streak >= 5) return '來客已連續 ' + streak + ' 天低於去年同星期，留意客人是否流失';
  // 營業日＝晚班、大夜算到隔天（同每日營業頁 DS_DAY_CUT）
  var hrs = {};
  recs.forEach(function (r) {
    if (!r || r.name === '門市備註' || HD_OFF.indexOf(String(r.shift || '').trim()) >= 0) return;
    if (r.location && r.location !== '本店') return;
    var dt = lbRecDate(r.week, r.day), h = parseFloat(r.actualHours || 0), sp = shiftSpan(r.shift);
    if (!dt || !(h > 0) || !sp) return;
    var biz = sp.startH >= 14 ? shiftDateAdd(dt, 1) : dt;
    hrs[biz] = (hrs[biz] || 0) + h;
  });
  var by = {}, n = 0, WD = ['日', '一', '二', '三', '四', '五', '六'];
  for (var e = from; e <= lastD; e = shiftDateAdd(e, 1)) {
    var x = all[e]; if (!x || !(+x.customers > 0) || !(hrs[e] > 0)) continue;
    var w = new Date(e + 'T00:00:00').getDay(), b = by[w] = by[w] || { c: 0, h: 0 };
    b.c += +x.customers; b.h += hrs[e]; n++;
  }
  if (n < 14) return '';
  var ws = Object.keys(by), lo = ws.reduce(function (a, k) { return by[k].c / by[k].h < by[a].c / by[a].h ? k : a; }, ws[0]);
  var avg = ws.reduce(function (t, k) { return t + by[k].c; }, 0) / ws.reduce(function (t, k) { return t + by[k].h; }, 0);
  return '近 8 週週' + WD[lo] + '每排 1 小時只接 ' + (by[lo].c / by[lo].h).toFixed(1) + ' 位客人（平均 ' + avg.toFixed(1) + '），排班可優先減這天';
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

// ── 看板畫面：深色底、上排 4 張彩色數字卡、下面近 7 日營業額長條（2026-10-11 使用者：要儀表板的樣子、有圖像化）──
var HD_ICON = {
  money: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 4.5a3 3 0 010 6M18 14.5c2 .6 3 2.6 3 5.5"/>',
};
function hdIc(k) { return '<span class="hbIc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + HD_ICON[k] + '</svg></span>'; }
function hdW1(v) { return (Math.round(v / 1000) / 10).toFixed(1); }
var HD_LT = { green: 'up', yellow: 'warn', red: 'down' };

// 一家店的 4 個數字：{k, name, v, u, sub, tone}；v＝null 顯示「—」
function hdMetrics(x) {
  var m = [];
  // 💰 月底會不會達標（使用者 2026-10-11：要看了能行動）＝月底推估 ÷ 達標；算不出達標才退回本月營業額
  var yo = x.yoy == null ? '' : '・比去年 ' + (x.yoy >= 0 ? '+' : '−') + Math.abs(x.yoy * 100).toFixed(1) + '%';
  // 三段色（使用者 2026-10-11）：綠＝推估 ≥ 達標（賺到目標利潤率）、黃＝兩平～達標（有賺但不到目標）、紅＝推估 < 兩平（照現在排班會虧）
  if (x.tgtMonth && x.proj != null) {
    var lv = x.proj >= x.tgtMonth ? 'up' : x.beMonth != null && x.proj >= x.beMonth ? 'warn' : 'down';
    m.push({ k: 'money', name: x.rem > 0 ? '月底會不會達標' : '本月達標率', v: (x.proj / x.tgtMonth * 100).toFixed(0), u: '%', tone: lv, valTone: lv,
      sub: lv === 'up' ? '累計 ' + hdW1(x.raw) + ' 萬' + yo : lv === 'warn' ? '有賺，未到目標利潤' : '照現在排班會虧錢' });
  }
  else m.push({ k: 'money', name: '本月營業額', v: hdW1(x.raw), u: '萬', tone: x.yoy == null ? '' : x.yoy >= 0 ? 'up' : 'down', sub: '已填 ' + x.days + ' 天' + yo });
  if (x.rem > 0 && x.needTgt != null) m.push({ k: 'target', name: '每天要做到', v: x.needTgt <= 0 ? '已達標' : hdMoney(x.needTgt), u: x.needTgt <= 0 ? '' : '元', tone: x.needTgt <= 0 ? 'up' : '', sub: '達標・剩 ' + x.rem + ' 天' });
  else m.push({ k: 'target', name: '本月營業額', v: hdW1(x.raw), u: '萬', sub: '整月已結束' + yo });
  m.push(x.light ? { k: 'clock', name: '本月工時', v: hdMoney(x.light.hours), u: 'h', tone: HD_LT[x.light.level] || '', sub: '排到 ' + hdMd(x.light.lastDate) + '・上限 ' + hdMoney(x.light.capP) + 'h' }
    : { k: 'clock', name: '本月工時', v: null, sub: '還沒排班' });
  // 👥 每天來客（使用者 2026-10-11：來客流失是最要處理的訊號，客單放小字）
  m.push({ k: 'people', name: '每天來客', v: x.cust ? hdMoney(x.cust) : null, u: '人', tone: x.custYoy == null ? '' : x.custYoy >= 0 ? 'up' : 'down',
    sub: !x.cust ? '沒有來客資料' : x.custYoy == null ? '去年沒有資料' : (x.custYoy >= 0 ? '▲ ' : '▼ ') + Math.abs(x.custYoy * 100).toFixed(1) + '% 較去年' }); // 客單價放到走勢下方那行（卡片太窄）
  return m;
}
function hdVal(m) { return m.v == null ? '—' : hdEsc(m.v) + (m.u ? '<small> ' + hdEsc(m.u) + '</small>' : ''); }
function hdCard(m) {
  return '<div class="hbCard ' + m.k + '"><span class="hbHead">' + hdIc(m.k) + '<span>' + hdEsc(m.name) + '</span></span>' +
    '<b class="hbVal' + (m.valTone ? ' v-' + m.valTone : '') + '">' + hdVal(m) + '</b><small class="hbSub ' + (m.tone || '') + '">' + hdEsc(m.sub) + '</small></div>';
}
// 加盟主：同一個數字、每店一行；沒輸入的店整行留白
function hdMultiCard(i, stores, out) {
  var ms = stores.map(function (s) { return out[s] ? hdMetrics(out[s])[i] : null; }), h = ms.filter(Boolean)[0];
  return '<div class="hbCard multi ' + h.k + '"><span class="hbHead">' + hdIc(h.k) + '<span>' + hdEsc(h.name) + '</span></span>' +
    stores.map(function (s, j) {
      var m = ms[j];
      return '<span class="hbRow" data-st="' + hdEsc(s) + '"><span class="hbSt"><i style="background:' + out[s].color + '"></i>' + hdEsc(s) + '</span>' +
        (m ? '<b class="hbVal">' + hdVal(m) + '</b><small class="hbSub ' + (m.tone || '') + '">' + hdEsc(m.sub) + '</small>' : '<b class="hbVal"></b>') + '</span>';
    }).join('') + '</div>';
}

// 近 7 日走勢：單店＝長條＋去年同星期折線；多店＝每天一組長條、一店一色。照實際寬度畫（手機字不縮小）
// mode：'sales' 營業額（刻度以萬）／'cust' 來客（刻度以人；2026-10-16 使用者：同一張圖切換，不另外加圖）
function hdChart(xs, names, W, mode) {
  var cust = mode === 'cust', V = function (r) { return cust ? r.c : r.v; }, P = function (r) { return cust ? r.pc : r.p; };
  var multi = xs.length > 1, rows = xs[0].chart, H = 190, L = 34, base = H - 34, top = 22, step = (W - L - 4) / 7;
  var vals = []; xs.forEach(function (x) { x.chart.forEach(function (r) { if (V(r) != null) vals.push(V(r)); if (!multi && P(r) != null) vals.push(P(r)); }); });
  if (!vals.length) return '<p class="hbEmpty">近 7 天還沒有' + (cust ? '來客' : '營業') + '資料</p>';
  // 刻度：營業額每格 2 萬的倍數；來客每格 100 人的倍數（三格）
  var unit = cust ? 100 : 20000, stepV = Math.max(unit, Math.ceil(Math.max.apply(null, vals) / 3 / unit) * unit), max = stepV * 3, k = (base - top) / max;
  var axis = function (v) { return !v ? '0' : cust ? hdMoney(v) : (v / 10000) + '萬'; }, num = function (v) { return cust ? hdMoney(v) : hdW1(v); };
  var y = function (v) { return (base - v * k).toFixed(1); };
  var s = ['<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" class="hbChart" role="img" aria-label="近 7 日' + (cust ? '來客' : '營業額') + '長條圖">'];
  for (var g = 0; g <= 3; g++) { var yy = base - g * stepV * k; s.push('<line x1="' + L + '" x2="' + (W - 4) + '" y1="' + yy + '" y2="' + yy + '" class="hbGrid"/><text x="' + (L - 5) + '" y="' + (yy + 3.5) + '" text-anchor="end" class="hbAx">' + axis(g * stepV) + '</text>'); }
  var groupW = Math.min(multi ? 40 : 28, step * (multi ? 0.74 : 0.56)), bw = multi ? (groupW - 2 * (xs.length - 1)) / xs.length : groupW, pts = [];
  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  rows.forEach(function (r, i) {
    var cx = L + step * i + step / 2, last = i === rows.length - 1;
    xs.forEach(function (x, j) {
      var v = V(x.chart[i]); if (v == null) return;
      var bx = multi ? cx - groupW / 2 + j * (bw + 2) : cx - bw / 2;
      s.push('<rect x="' + bx.toFixed(1) + '" y="' + y(v) + '" width="' + bw.toFixed(1) + '" height="' + (v * k).toFixed(1) + '" rx="3" ' + (multi ? 'fill="' + x.color + '"' : 'class="hbBar' + (last ? ' now' : '') + '"') + '><title>' + hdMd(r.d) + ' ' + hdEsc(names[j]) + ' ' + hdMoney(v) + (cust ? ' 人' : '') + '</title></rect>');
      if (!multi) { var ny = Math.min(base - v * k, P(r) == null ? Infinity : base - P(r) * k - 4) - 5; s.push('<text x="' + cx.toFixed(1) + '" y="' + ny.toFixed(1) + '" text-anchor="middle" class="hbNum">' + num(v) + '</text>'); }
    });
    if (xs.every(function (x) { return V(x.chart[i]) == null; })) s.push('<text x="' + cx.toFixed(1) + '" y="' + (base - 6) + '" text-anchor="middle" class="hbAx">未填</text>');
    var dw = WD[new Date(r.d + 'T00:00:00').getDay()];
    s.push('<text x="' + cx.toFixed(1) + '" y="' + (base + 15) + '" text-anchor="middle" class="hbAx' + (last ? ' now' : '') + '">' + hdMd(r.d) + '</text><text x="' + cx.toFixed(1) + '" y="' + (base + 28) + '" text-anchor="middle" class="hbAx' + (last ? ' now' : '') + '">(' + dw + ')</text>');
    pts.push(multi || P(r) == null ? null : [cx.toFixed(1), y(P(r))]);
  });
  for (var p = 1; p < pts.length; p++) if (pts[p - 1] && pts[p]) s.push('<line x1="' + pts[p - 1][0] + '" y1="' + pts[p - 1][1] + '" x2="' + pts[p][0] + '" y2="' + pts[p][1] + '" class="hbLine"/>');
  pts.forEach(function (q) { if (q) s.push('<circle cx="' + q[0] + '" cy="' + q[1] + '" r="3.5" class="hbDot"/>'); });
  return s.join('') + '</svg>';
}

function hdRender(card, u, stores, ym, out) {
  var mo = +ym.slice(5);
  var shown = stores.filter(function (s) { return out[s]; });
  if (!shown.length) { card.style.display = 'none'; return; }   // 店長沒填 → 不出現；加盟主三店都沒填也不出現
  // 店長、加盟主同一種版面，只差在幾家店有資料（使用者 2026-10-11）：一家＝單店版；兩家以上＝每張卡每店一行，只列有資料的店
  var multi = shown.length > 1;
  var xs = shown.map(function (s) { var x = out[s]; x.color = HD_COLORS[stores.indexOf(s) % HD_COLORS.length]; return x; });
  var sub = multi ? mo + ' 月・' + shown.map(function (s) { return s + ' 填到 ' + hdMd(out[s].lastD); }).join('・')
    : shown[0] + '・' + mo + ' 月・填到 ' + hdMd(xs[0].lastD);
  var cards = multi ? [0, 1, 2, 3].map(function (i) { return hdMultiCard(i, shown, out); }).join('') : hdMetrics(xs[0]).map(hdCard).join('');
  var mode = 'sales'; try { if (localStorage.getItem('hdMode') === 'cust') mode = 'cust'; } catch (e) {}   // 記住上次看營業額還是來客
  var legendOf = function (md) { return shown.length > 1 ? shown.map(function (s, j) { return '<span><i class="bar" style="background:' + xs[j].color + '"></i>' + hdEsc(s) + '</span>'; }).join('')
    : '<span><i class="bar"></i>' + (md === 'cust' ? '來客' : '營業額') + '</span><span><i class="line"></i>去年同星期</span>'; };
  var titleOf = function (md) { return md === 'cust' ? '來客走勢 <small>近 7 日・人</small>' : '營業額走勢 <small>近 7 日・含稅</small>'; };
  var seg = '<span class="hbSeg" role="group" aria-label="走勢切換"><button type="button" data-md="sales">營業額</button><button type="button" data-md="cust">來客</button></span>';
  var foot = xs.map(function (x, j) {
    var bits = [];
    if (x.rem > 0 && x.needLy != null) bits.push('<span>比去年成長每天要 <b>' + (x.needLy <= 0 ? '已超過' : hdMoney(x.needLy)) + '</b></span>');
    if (x.proj != null) bits.push('<span>月底推估 <b>' + hdW1(x.proj) + ' 萬</b></span>');
    if (x.tgtMonth) bits.push('<span>達標 <b>' + hdW1(x.tgtMonth) + ' 萬</b></span>');
    if (x.ticket) bits.push('<span>客單 <b>' + hdMoney(x.ticket) + ' 元</b></span>');
    return bits.length ? '<div class="hbFoot">' + (multi ? '<span class="hbSt"><i style="background:' + x.color + '"></i>' + hdEsc(shown[j]) + '</span>' : '') + bits.join('') + '</div>' : '';
  }).join('');
  var tips = xs.map(function (x, j) { return x.tip ? '<div class="hbTip">💡 ' + (multi ? '<b>' + hdEsc(shown[j]) + '</b> ' : '') + hdEsc(x.tip) + '</div>' : ''; }).join('');
  card.className = 'hBoard';
  card.innerHTML = '<div class="hbTitle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 20V11M10 20V6M15 20V9M20 20V4"/></svg><h2>門市經營看板</h2><span>' + hdEsc(sub) + '</span></div>' +
    '<div class="hbCards' + (multi ? ' multi' : '') + '">' + cards + '</div>' +
    '<div class="hbTrend"><div class="hbTrendH"><h3>' + titleOf(mode) + '</h3>' + seg + '<span class="hbLeg">' + legendOf(mode) + '</span></div><div class="hbSvg"></div>' + foot + '</div>' + tips +
    '<button type="button" class="hbMore">看完整分析<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>';
  card.style.display = '';
  card.onclick = function (e) { var r = e.target.closest('[data-st]'), st = r ? r.getAttribute('data-st') : shown[0]; if (r && !out[st]) return; location.href = 'daily-sales.html?store=' + encodeURIComponent(st); };
  // 走勢照實際寬度畫：首頁剛顯示時寬度可能是 0 → 等下一個畫面再量
  var el = card.querySelector('.hbSvg'), tries = 0;
  function fill() {
    var w = Math.round(el.clientWidth);
    if (!w && tries++ < 30) { requestAnimationFrame(fill); return; }
    el.innerHTML = hdChart(xs, shown, Math.max(280, Math.min(900, w || 340)), mode);
    card.querySelectorAll('.hbSeg button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-md') === mode); b.setAttribute('aria-pressed', b.getAttribute('data-md') === mode); });
  }
  fill();
  // 切換只重畫走勢，不跳到每日營業頁（整張看板的 onclick 會跳頁）
  card.querySelector('.hbSeg').onclick = function (e) {
    e.stopPropagation();
    var b = e.target.closest('button'); if (!b) return;
    mode = b.getAttribute('data-md');
    try { localStorage.setItem('hdMode', mode); } catch (err) {}
    card.querySelector('.hbTrendH h3').innerHTML = titleOf(mode);
    card.querySelector('.hbLeg').innerHTML = legendOf(mode);
    fill();
  };
}

(function () {
  var css = document.createElement('style');
  css.textContent =
    '.hBoard{background:#13294b;border:1px solid #2a4675;border-radius:18px;padding:14px 12px;display:grid;gap:12px;color:#eef3fb;margin-bottom:14px;cursor:pointer;}' +
    '.hbTitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
    '.hbTitle svg{width:20px;height:20px;color:#8ec5ff;flex:none}' +
    '.hbTitle h2{margin:0;font-size:16px;font-weight:900;color:#fff;letter-spacing:.04em}' +
    '.hbTitle span{margin-left:auto;font-size:11.5px;color:#a9bad3}' +
    '.hbCards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}' +
    '.hbCard{text-align:center;border-radius:14px;padding:10px 4px;display:grid;gap:5px;align-content:start;min-width:0;border:1px solid}' +
    '.hbHead{display:flex;flex-direction:column;align-items:center;gap:5px;font-size:11px;line-height:1.3;color:#dce6f5;white-space:nowrap}' +
    '.hbIc{width:28px;height:28px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff}.hbIc svg{width:16px;height:16px}' +
    '.hbVal{font-size:17px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;line-height:1.2;white-space:nowrap}' +
    '.hbVal small{font-size:10.5px;font-weight:600;color:#b8c7dc}' +
    '.hbSub{font-size:10px;color:#b8c7dc;line-height:1.35}' +
    '.hbSub.up{color:#8fd6a1}.hbSub.down{color:#ff9d8a}.hbSub.warn{color:#f4c06a}' +
    '.hbVal.v-up{color:#8fd6a1}.hbVal.v-warn{color:#f4c06a}.hbVal.v-down{color:#ff9d8a}' +
    '.hbCard.money{background:#2b2a24;border-color:#5c4a30}.hbCard.money .hbIc{background:#c0841f}' +
    '.hbCard.target{background:#17324f;border-color:#2a5578}.hbCard.target .hbIc{background:#2f8fcc}' +
    '.hbCard.clock{background:#1c3329;border-color:#2f5a44}.hbCard.clock .hbIc{background:#3f8f5a}' +
    '.hbCard.people{background:#2d2140;border-color:#4b3a66}.hbCard.people .hbIc{background:#8a63c9}' +
    '.hbCards.multi{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}' +
    '.hbCard.multi{text-align:left;padding:10px;gap:6px}.hbCard.multi .hbHead{flex-direction:row;justify-content:flex-start}' +
    '.hbRow{display:grid;grid-template-columns:auto 1fr;align-items:baseline;gap:0 6px;border-top:1px solid rgba(255,255,255,.08);padding-top:5px;min-height:22px}' +
    '.hbRow .hbVal{font-size:15px;text-align:right}.hbRow .hbSub{grid-column:1/-1;font-size:10px}' +
    '.hbSt{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#dce6f5;white-space:nowrap}.hbSt i{width:9px;height:9px;border-radius:2px;flex:none}' +
    '.hbTrend{border-top:1px solid #2a4675;padding-top:12px;display:grid;gap:6px}' +
    '.hbTrendH{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
    '.hbTrendH h3{margin:0;font-size:14px;font-weight:800}.hbTrendH h3 small{font-weight:500;color:#a9bad3;font-size:11.5px}' +
    '.hbLeg{margin-left:auto;display:flex;gap:12px;font-size:11px;color:#b8c7dc}.hbLeg span{display:flex;align-items:center;gap:5px}' +
    '.hbSeg{display:inline-flex;border:1px solid #2f8fcc;border-radius:999px;overflow:hidden}' +
    '.hbSeg button{font:inherit;font-size:12px;font-weight:800;color:#8ec5ff;background:transparent;border:0;padding:5px 12px;min-height:30px;cursor:pointer}' +
    '.hbSeg button.on{background:#2f8fcc;color:#fff}' +
    '.hbLeg i{display:inline-block;width:10px;height:10px;border-radius:2px;background:#c0841f}.hbLeg i.line{width:14px;height:2px;border-radius:0;background:#8ec5ff}' +
    '.hbChart{display:block;max-width:100%}' +
    '.hbGrid{stroke:#2a4675;stroke-width:1}.hbAx{font-size:10px;fill:#93a6c2}.hbAx.now{fill:#f4c06a;font-weight:700}' +
    '.hbNum{font-size:10px;fill:#dce6f5}.hbBar{fill:#c0841f}.hbBar.now{fill:#e0a640}' +
    '.hbLine{stroke:#8ec5ff;stroke-width:2}.hbDot{fill:#13294b;stroke:#8ec5ff;stroke-width:2}' +
    '.hbFoot{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:#a9bad3;padding:0 2px}.hbFoot b{color:#fff}' +
    '.hbTip{background:#0f2240;border:1px solid #2a4675;border-radius:12px;padding:9px 12px;font-size:12.5px;line-height:1.6;color:#f4d58a}.hbTip b{color:#fff}' +
    '.hbEmpty{margin:0;font-size:13px;color:#a9bad3}' +
    '.hbMore{font:inherit;font-size:14.5px;font-weight:800;color:#8ec5ff;background:#0f2240;border:1.5px solid #2f8fcc;border-radius:14px;min-height:44px;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}.hbMore svg{width:16px;height:16px}' +
    '@media (min-width:700px){.hBoard{padding:18px 20px}.hbCard{text-align:left;padding:14px 16px}.hbHead{flex-direction:row;font-size:13px}.hbVal{font-size:24px}.hbSub{font-size:12px}}';
  document.head.appendChild(css);
})();
