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

/** 某人這天能上的時段（48 格集合）；劃休整天→空，只休早上／晚上→去掉 15:00 前／後 */
function lshCanCover(name, st, dateStr, reqs) {
  var lv = { full: false, morning: false, evening: false };
  (reqs || storeRequests).forEach(function (r) {
    if (r.empName !== name || r.date !== dateStr || ['cancelled', 'unfulfilled', 'rejected'].indexOf(r.status) >= 0) return;
    if (r.shift === 'morning') lv.morning = true; else if (r.shift === 'evening') lv.evening = true; else lv.full = true;
  });
  var set = {};
  if (lv.full) return set;
  // 半天劃休只扣掉休的那一段（工讀可排範圍內較短的班：週二只能上 7-16 的阿默劃晚上休，早上照樣能上）
  var cut = (15 - asAxisStart()) * 2; // 15:00 在軸上的格子
  asAvailableShifts(st, dateStr, lshBase.cfg.seasons).forEach(function (sh) {
    asShiftSlots(sh).forEach(function (i) {
      if (lv.morning && i < cut) return;
      if (lv.evening && i >= cut) return;
      set[i] = 1;
    });
  });
  return set;
}

/** 這天的判斷：[{s, e, kind:'short'|'tight', who:[能上的人]}] */
function lshDayInfo(dateStr, reqs) {
  if (!lshEnabled() || !lshBase || !lshBase.cfg) return [];
  var mn = lshMinSlots(dateStr);
  var staff = lshBase.cfg.staff || {};
  var covers = Object.keys(staff).filter(function (n) { return staff[n] && staff[n].auto; })
    .map(function (n) { return { name: n, set: lshCanCover(n, staff[n], dateStr, reqs) }; });
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
  // 使用者 2026-09-22：月曆只標「確定缺人」；會不會因為某人劃休而缺，在他按送出時才試算、再確認
  return f.short.length ? '<span class="cal-short red" title="這天已經不夠人">⚠️缺人</span>' : '';
}

/** 申請視窗說明（只提醒，不擋） */
function lshModalBox(dateStr) {
  if (!lshEnabled() || !lshBase || !lshBase.cfg) return '';
  var f = lshFor(dateStr), out = '';
  if (f.short.length) out += '<div class="info-box short">⚠️ <b>這天已經不夠人</b>：' +
    f.short.map(function (g) { return lshLabel(g) + '（至少 ' + g.need + ' 人，能上的只有 ' + (g.who.length ? g.who.join('、') : '0 人') + '）'; }).join('、') +
    '。<br>依目前設定與大家已送出的劃休計算；如果可以，請改其他天。</div>';
  return out;
}

/**
 * 按「確認送出」時呼叫：這筆劃休會不會讓某個時段變成不夠人？會的話回傳確認訊息，不會就回 ''。
 * 只算「因為這筆才缺」的（本來就缺的不算）；結構性的（大夜本來就只有宇璿）也不算——他休哪天都一樣。
 */
function lshConfirmMessage(dateStr, shiftKind, who) {
  if (!lshEnabled() || !lshBase || !lshBase.cfg || !currentUser) return '';
  var me = who || currentUser.empName; // 店長代劃休時算的是被代登的人
  var st = (lshBase.cfg.staff || {})[me];
  if (!st || !st.auto) return '';
  var before = lshDayInfo(dateStr);
  var after = lshDayInfo(dateStr, storeRequests.concat([{ empName: me, date: dateStr, shift: shiftKind, status: 'noted' }]));
  var wasShort = function (g) { return before.some(function (b) { return b.kind === 'short' && b.s < g.e && g.s < b.e; }); };
  var added = after.filter(function (g) {
    if (g.kind !== 'short' || wasShort(g)) return false;
    var tb = before.filter(function (b) { return b.kind === 'tight' && b.s < g.e && g.s < b.e && b.who.indexOf(me) >= 0; })[0];
    return !(tb && lshStructural(dateStr, tb));
  });
  if (!added.length) return '';
  return '⚠️ ' + (me === currentUser.empName ? '你' : me) + '這天劃休後，下面這些時段能上的人會不夠：\n' +
    added.map(function (g) { return '・' + lshLabel(g) + '：至少要 ' + g.need + ' 人，只剩 ' + (g.who.length ? g.who.join('、') : '0 人'); }).join('\n') +
    '\n\n（依自動排班設定與大家已送出的劃休計算）\n確定還是要劃休嗎？';
}
