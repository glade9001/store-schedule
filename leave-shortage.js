// 劃休頁人力提醒（2026-09-22，先在美德試）
// ⚠️ 不能先假設班表（使用者 2026-09-22）：例如宇璿那週沒劃休，他哪兩天休由店長之後決定，
//    用草稿預估會把草稿自己挑的休假日標成「缺人」，誤導員工。
// 所以只看「已經確定的事」：自動排班設定（誰能上哪些班、哪天不能上）＋已送出的劃休＋每時段至少要幾人。
// 對每一天：假設「還沒劃休、那天能上的人全部都來」，每個時段最多有幾人能上——
//   🔴 已經不夠：全來都還低於至少人數（劃休或人力結構造成，一定缺）
//   🟡 你是關鍵人力：能上的人剛好等於至少人數、而你是其中一個（你劃這天就一定缺）；只給本人看
// 店長以上：看 🔴 與「剛好夠」的時段。只提醒、不擋申請、不寫入任何資料。
// 依賴 leave-request-page.js 的全域：currentUser、currentStore、storeRequests、canSchedule、renderCalBody、today
// 本檔頂層只用 function 與 var（前綴 lsh）。

var LSH_STORES = ['美德'];   // 試用門市
var lshBase = null;         // { store, cfg, auto:[名字] }
var lshLoading = false;

function lshEnabled() { return LSH_STORES.indexOf(currentStore) >= 0; }

/** 讀自動排班設定（只讀）；讀完重畫月曆 */
function lshEnsure() {
  if (!lshEnabled() || typeof asAvailableShifts !== 'function') return;
  if ((lshBase && lshBase.store === currentStore) || lshLoading) return;
  lshLoading = true;
  window.db.collection('stores').doc(currentStore).collection('config').doc('autoSchedule').get()
    .then(function (snap) {
      var cfg = snap.exists ? snap.data() : null;
      lshBase = { store: currentStore, cfg: cfg };
      renderCalBody();
    })
    .catch(function (e) { console.warn('人力提醒讀取失敗:', e); })
    .then(function () { lshLoading = false; });
}
/** 劃休有新增／取消：判斷是即時算的，不用快取，保留介面給 leave-request-page.js 呼叫 */
function lshInvalidate() {}

/** 這天各時段的至少人數（48 格） */
function lshMinSlots(dateStr) {
  var bands = ((lshBase.cfg.demand || {})[shiftDayName(dateStr)]) || [];
  var mn = new Array(asSlots()).fill(0);
  bands.forEach(function (b) {
    var m = b.min == null ? b.n : Math.min(b.min, b.n);
    for (var h = b.s; h < b.e; h += 0.5) { var i = Math.round((h - asAxisStart()) * 2); if (i >= 0 && i < asSlots()) mn[i] = Math.max(mn[i], m); }
  });
  return mn;
}

/** 某人這天能上的時段（48 格集合）；劃休整天→空，只休早上／晚上→去掉那段 */
function lshCanCover(name, st, dateStr) {
  var lv = { full: false, morning: false, evening: false };
  storeRequests.forEach(function (r) {
    if (r.empName !== name || r.date !== dateStr || ['cancelled', 'unfulfilled', 'rejected'].indexOf(r.status) >= 0) return;
    if (r.shift === 'morning') lv.morning = true; else if (r.shift === 'evening') lv.evening = true; else lv.full = true;
  });
  var set = {};
  if (lv.full) return set;
  asAvailableShifts(st, dateStr, lshBase.cfg.seasons).forEach(function (sh) {
    var sp = shiftSpan(sh); if (!sp) return;
    var s = sp.startH < asAxisStart() ? sp.startH + 24 : sp.startH;
    if (lv.morning && s < 15) return;                 // 同草稿規則：早上休不排 15:00 前開始的班
    if (lv.evening && s + shiftTotalHours(sh) > 15) return;
    asShiftSlots(sh).forEach(function (i) { set[i] = 1; });
  });
  return set;
}

/** 這天的判斷：[{s, e, kind:'short'|'tight', who:[能上的人]}] */
function lshDayInfo(dateStr) {
  if (!lshEnabled() || !lshBase || !lshBase.cfg) return [];
  var mn = lshMinSlots(dateStr);
  var staff = lshBase.cfg.staff || {};
  var covers = Object.keys(staff).filter(function (n) { return staff[n] && staff[n].auto; })
    .map(function (n) { return { name: n, set: lshCanCover(n, staff[n], dateStr) }; });
  var segs = [];
  for (var i = 0; i < asSlots(); i++) {
    if (!mn[i]) continue;
    var who = covers.filter(function (c) { return c.set[i]; }).map(function (c) { return c.name; });
    var kind = who.length < mn[i] ? 'short' : (who.length === mn[i] ? 'tight' : '');
    if (!kind) continue;
    var h = asAxisStart() + i / 2, last = segs[segs.length - 1], key = kind + '|' + who.join(',');
    if (last && last.e === h && last.key === key) last.e = h + 0.5;
    else segs.push({ s: h, e: h + 0.5, kind: kind, who: who, need: mn[i], key: key });
  }
  return segs;
}

function lshLabel(g) { return asHourLabel(g.s).replace('隔天 ', '') + '–' + asHourLabel(g.e); }

/**
 * 結構性的「剛好夠」：同一時段、同一批人，在這週 5 天以上都剛好夠（例：大夜只有宇璿能上）。
 * 這種每天都標等於沒標，還會讓那個人覺得哪天都不能休——不標記，只在申請視窗說明。
 */
function lshStructural(dateStr, g) {
  var mon = asWeekMonday(shiftWeekStr(dateStr)), n = 0;
  for (var i = 0; i < 7; i++) {
    var d = shiftDateAdd(mon, i);
    if (lshDayInfo(d).some(function (x) { return x.kind === 'tight' && x.s < g.e && g.s < x.e && x.who.join(',') === g.who.join(','); })) n++;
  }
  return n >= 5;
}

/** 這天要顯示給目前使用者的提醒 */
function lshFor(dateStr) {
  var info = lshDayInfo(dateStr);
  var me = currentUser && currentUser.empName;
  var tightAll = info.filter(function (g) { return g.kind === 'tight'; });
  var structural = tightAll.filter(function (g) { return lshStructural(dateStr, g); });
  var real = tightAll.filter(function (g) { return structural.indexOf(g) < 0; });
  return {
    short: info.filter(function (g) { return g.kind === 'short'; }),
    mine: real.filter(function (g) { return g.who.indexOf(me) >= 0; }),      // 我是關鍵人力（這天特別緊）
    tight: canSchedule() ? real : [],                                         // 店長看這天特別緊的時段
    structMine: structural.filter(function (g) { return g.who.indexOf(me) >= 0; }) // 每天都只有我能上的時段（結構性）
  };
}

function lshBadge(dateStr) {
  if (!lshEnabled() || !lshBase || !lshBase.cfg || dateStr < today()) return '';
  var f = lshFor(dateStr);
  if (f.short.length) return '<span class="cal-short red" title="這天已經不夠人">⚠️缺人</span>';
  if (f.mine.length) return '<span class="cal-short" title="你這天劃休就會缺人">⚠️關鍵</span>';
  return '';
}

/** 申請視窗說明（只提醒，不擋） */
function lshModalBox(dateStr) {
  if (!lshEnabled() || !lshBase || !lshBase.cfg) return '';
  var f = lshFor(dateStr), out = '';
  if (f.short.length) out += '<div class="info-box short">⚠️ <b>這天已經不夠人</b>：' +
    f.short.map(function (g) { return lshLabel(g) + '（至少 ' + g.need + ' 人，能上的只有 ' + (g.who.length ? g.who.join('、') : '0 人') + '）'; }).join('、') +
    '。<br>依目前設定與大家已送出的劃休計算；如果可以，請改其他天。</div>';
  if (f.mine.length) out += '<div class="info-box short">⚠️ <b>你這天劃休就會缺人</b>：' +
    f.mine.map(function (g) { return lshLabel(g) + '能上的只有 ' + g.who.join('、'); }).join('；') + '。如果可以，請改其他天。</div>';
  if (f.structMine.length) out += '<div class="info-box">ℹ️ ' + f.structMine.map(lshLabel).join('、') +
    ' 這個時段平常就只有 ' + f.structMine[0].who.join('、') + ' 能上，休假的日子本來就會開待補由店長安排，這是店裡人力的問題，不影響你劃休。</div>';
  if (f.tight.length && !f.mine.length) out += '<div class="info-box">👀 店長參考：這天人力剛好夠——' +
    f.tight.map(function (g) { return lshLabel(g) + '（' + g.who.join('、') + '）'; }).join('、') + '，再有人劃休就會缺。</div>';
  return out;
}
