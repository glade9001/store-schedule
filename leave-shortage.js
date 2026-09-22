// 劃休頁「⚠️ 缺人」提醒（2026-09-22，先在美德試）
// 在背景對還能劃休的週跑一次自動排班草稿（auto-schedule-core.js asGenerateDraft，含大家目前的劃休），
// 看哪天會開 🆘 待補 → 月曆標「⚠️缺人」、申請視窗說明缺哪個時段。只提醒、不擋申請、不寫入任何資料。
// 員工只看跟自己有關的缺口（自己可以排的時段），店長以上看全部。
// 依賴 leave-request-page.js 的全域：currentUser、currentStore、storeRequests、canSchedule、renderCalBody、isDateLocked、today
// 本檔頂層只用 function 與 var（前綴 lsh）。

var LSH_STORES = ['美德'];   // 試用門市
var lshCache = {};          // store|week → { gaps:[{day, date, s, e, shift}] }
var lshBase = null;         // { store, cfg, emps, weeks, catalog } 每次進頁讀一次
var lshBusy = false, lshPending = false;

function lshEnabled() { return LSH_STORES.indexOf(currentStore) >= 0; }

/** 讀設定、員工、班表（只讀）；設定沒完成就不做 */
async function lshLoadBase() {
  if (lshBase && lshBase.store === currentStore) return lshBase;
  var ref = window.db.collection('stores').doc(currentStore);
  var fromWeek = shiftWeekStr(shiftDateAdd(today(), -7 * 10));
  var FP = firebase.firestore.FieldPath.documentId();
  var snaps = await Promise.all([
    ref.collection('config').doc('autoSchedule').get(),
    ref.collection('config').doc('shifts').get().catch(function () { return null; }),
    ref.collection('employees').get(),
    ref.collection('weeks').where(FP, '>=', fromWeek).get()
  ]);
  if (!snaps[0].exists) { lshBase = { store: currentStore, cfg: null }; return lshBase; }
  var emps = [];
  snaps[2].forEach(function (d) {
    var e = d.data();
    if (d.id.startsWith('🆘') || ['離職', '調走'].indexOf(e.status) >= 0) return;
    emps.push({ name: d.id, role: e.role, payAsPartTime: !!e.payAsPartTime, wage: parseFloat(e.wage || 0), base: 0, startDate: e.startDate || '' });
  });
  var weeks = {};
  snaps[3].forEach(function (d) { weeks[d.id] = d.data().records || []; });
  var hist = {};
  Object.keys(weeks).forEach(function (w) { if (w < shiftWeekStr(today())) hist[w] = weeks[w]; });
  var cfgShifts = (snaps[1] && snaps[1].exists && snaps[1].data().shifts) || [];
  lshBase = { store: currentStore, cfg: snaps[0].data(), emps: emps, weeks: weeks, catalog: asBuildCatalog(cfgShifts, hist, 3) };
  return lshBase;
}

/** 這個月裡還能劃休的週（未截止） */
function lshWeeksOfMonth(y, m) {
  var out = [], last = new Date(y, m + 1, 0).getDate();
  for (var d = 1; d <= last; d++) {
    var ds = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    if (ds < today() || isDateLocked(ds)) continue;
    var w = shiftWeekStr(ds);
    if (out.indexOf(w) < 0) out.push(w);
  }
  return out;
}

/** 月曆畫完後呼叫：背景計算這個月還沒算過的週，算完重畫月曆 */
function lshEnsure(y, m) {
  if (!lshEnabled() || typeof asGenerateDraft !== 'function') return;
  if (lshBusy) { lshPending = true; return; }
  var need = lshWeeksOfMonth(y, m).filter(function (w) { return !lshCache[currentStore + '|' + w]; });
  if (!need.length) return;
  lshBusy = true;
  (async function () {
    try {
      var base = await lshLoadBase();
      if (!base.cfg) return;
      var leaves = storeRequests.filter(function (r) { return ['cancelled', 'unfulfilled', 'rejected'].indexOf(r.status) < 0; });
      for (var i = 0; i < need.length; i++) {
        await new Promise(function (r) { setTimeout(r, 0); }); // 讓畫面先動，不卡住
        var w = need[i];
        var res = asGenerateDraft({ weekStr: w, cfg: base.cfg, emps: base.emps, weeks: base.weeks, leaves: leaves, catalog: base.catalog, opt: { restarts: 2 } });
        var mon = asWeekMonday(w);
        lshCache[currentStore + '|' + w] = { gaps: res.gaps.map(function (g) { return { day: g.day, date: shiftDateAdd(mon, g.di), s: g.s, e: g.e, shift: g.shift }; }) };
      }
      renderCalBody();
    } catch (e) {
      console.warn('缺人提醒計算失敗:', e);
    } finally {
      lshBusy = false;
      if (lshPending) { lshPending = false; lshEnsure(y, m); }
    }
  })();
}

/** 劃休有新增／取消 → 重算 */
function lshInvalidate() { lshCache = {}; }

/** 這天跟目前使用者有關的缺口（店長看全部；員工只看自己可以排的時段） */
function lshGapsFor(dateStr) {
  if (!lshEnabled() || !lshBase || !lshBase.cfg) return [];
  var c = lshCache[currentStore + '|' + shiftWeekStr(dateStr)];
  if (!c) return [];
  var gaps = c.gaps.filter(function (g) { return g.date === dateStr; });
  if (!gaps.length || canSchedule()) return gaps;
  var st = (lshBase.cfg.staff || {})[currentUser.empName];
  if (!st || !st.auto) return gaps; // 不在自動排班裡的人（手動排）看全部
  var mine = {};
  asAvailableShifts(st, dateStr, lshBase.cfg.seasons).forEach(function (sh) { asShiftSlots(sh).forEach(function (i) { mine[i] = 1; }); });
  return gaps.filter(function (g) {
    for (var h = g.s; h < g.e; h += 0.5) if (mine[Math.round((h - 7) * 2)]) return true;
    return false;
  });
}

function lshBadge(dateStr) {
  return lshGapsFor(dateStr).length ? '<span class="cal-short" title="這天預估人力不足">⚠️缺人</span>' : '';
}

/** 申請視窗：說明這天缺哪些時段（只提醒，不擋） */
function lshModalBox(dateStr) {
  var gaps = lshGapsFor(dateStr);
  if (!gaps.length) return '';
  var seen = {}, labels = [];
  gaps.forEach(function (g) {
    var l = asHourLabel(g.s).replace('隔天 ', '') + '–' + asHourLabel(g.e);
    seen[l] = (seen[l] || 0) + 1;
  });
  Object.keys(seen).forEach(function (l) { labels.push(l + (seen[l] > 1 ? '（缺 ' + seen[l] + ' 人）' : '')); });
  return '<div class="info-box short">⚠️ <b>這天預估人力不夠</b>：' + labels.join('、') +
    '。<br>系統依目前大家的劃休試排，這天已經排不滿；如果可以，請改其他天。</div>';
}
