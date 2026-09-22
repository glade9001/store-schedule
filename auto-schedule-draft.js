// 排班頁「🤖 產生草稿」：讀設定與資料 → auto-schedule-core.js asGenerateDraft → 預覽 → 店長按套用才填進班表。
// ⚠️ 鐵則（使用者 2026-09-22）：不可改過去資料，尤其已發布的班表 —— 已發布／已過去的週一律不能產生、不能套用；
//    只填空白格，店長已排的格子不動。
// 依賴 schedule-v2-page.js 的全域：appData、appConfig、currentUser、virtualRowNames、weekPublishData、
//   isHistoryWeek、isAutoPublished、canScheduleStore、syncUIToMemory、renderSchedule、triggerAutoSave、
//   deductLeave、checkHolidayCompOnSave、showLoading、hideLoading、showToast、getDisplayName
// 本檔頂層只用 function 與 var（前綴 asd），避免跟頁面撞名。

var asdLast = null; // 最近一次草稿結果 { week, store, res }

/** 示範期：只有美德、只有 admin／owner／美德店長（與 auto-schedule-page.js aspCanUse 同一條） */
function asdAllowedUser(store) {
  var p = currentUser && currentUser.permission;
  if (store !== '美德') return false;
  return p === 'admin' || p === 'owner' || (p === 'manager' && currentUser.store === '美德');
}

/** 這週能不能產生草稿：回傳 '' ＝可以，否則是原因 */
function asdBlockReason(store, week) {
  if (!canScheduleStore(store)) return '沒有這家店的排班權限';
  if (isHistoryWeek(week)) return '已過去的週不能產生草稿';
  var pd = weekPublishData[week] || {};
  if (pd.published || isAutoPublished(week)) return '已發布的班表不能產生草稿';
  return '';
}

/** 發布狀態、歷史鎖定、換店換週後都呼叫：更新按鈕顯示 */
function asdRefreshBtn() {
  var btn = document.getElementById('draftBtn');
  if (!btn) return;
  var store = document.getElementById('storeSelector').value;
  var week = document.getElementById('weekSelector').value;
  if (!asdAllowedUser(store)) { btn.style.display = 'none'; return; }
  btn.style.display = 'inline-flex';
  var why = asdBlockReason(store, week);
  btn.classList.toggle('disabled', !!why);
  btn.title = why || '依自動排班設定排出這週空白格的草稿，預覽後再決定要不要套用';
}

async function asdGenerate() {
  var store = document.getElementById('storeSelector').value;
  var week = document.getElementById('weekSelector').value;
  var why = asdBlockReason(store, week);
  if (why) { showToast('⚠️ ' + why); return; }
  showLoading('🤖 讀取設定與班表…');
  try {
    syncUIToMemory(); // 畫面上還沒存的修改也算「店長已排」
    var storeRef = window.db.collection('stores').doc(store);
    var mon = asWeekMonday(week);
    // 需要的週：半年前（班別目錄）～本週最後一天所屬月份的月底（月份統計）
    var fromWeek = shiftWeekStr(shiftDateAdd(mon, -7 * 26));
    var sun = shiftDateAdd(mon, 6);
    var monthEnd = sun.slice(0, 8) + String(new Date(+sun.slice(0, 4), +sun.slice(5, 7), 0).getDate()).padStart(2, '0');
    var toWeek = shiftWeekStr(monthEnd);
    var FP = firebase.firestore.FieldPath.documentId();
    var snaps = await Promise.all([
      storeRef.collection('config').doc('autoSchedule').get(),
      storeRef.collection('weeks').where(FP, '>=', fromWeek).where(FP, '<=', toWeek).get(),
      storeRef.collection('leaveRequests').get()
    ]);
    if (!snaps[0].exists) { hideLoading(); showToast('⚠️ 這家店還沒有自動排班設定，請先到「自動排班設定」儲存'); return; }
    var cfg = snaps[0].data();
    var weeks = {};
    snaps[1].forEach(function (d) { weeks[d.id] = d.data().records || []; });
    // 本週用記憶體裡的（含還沒存的修改），不用資料庫那份
    weeks[week] = (appData.records || []).filter(function (r) { return r.week === week; });
    var leaves = [];
    snaps[2].forEach(function (d) { leaves.push(d.data()); });
    var emps = (appData.employees || []).filter(function (e) { return !String(e.name).startsWith('🆘') && !e._transferThisWeek; })
      .map(function (e) {
        var sal = (appData.salaryRecData || {})[e.name] || {};
        return { name: e.name, role: e.role, payAsPartTime: !!e.payAsPartTime,
          wage: parseFloat(sal.wage || e.wage || 0), base: parseFloat(sal.baseSalary != null ? sal.baseSalary : (e.baseSalary || 0)),
          startDate: e.startDate || '', departDate: e.status === '離職' ? (e.departDate || '') : '' };
      });
    var hist = {};
    Object.keys(weeks).forEach(function (w) { if (w < week) hist[w] = weeks[w]; });
    var catalog = asBuildCatalog(appConfig.shifts || [], hist, 3);

    showLoading('🤖 排班中…（約需幾秒）');
    await new Promise(function (r) { setTimeout(r, 30); }); // 讓「排班中」先畫出來
    var t0 = Date.now();
    var res = asGenerateDraft({ weekStr: week, cfg: cfg, emps: emps, weeks: weeks, leaves: leaves, catalog: catalog, opt: {} });
    asdLast = { week: week, store: store, res: res, ms: Date.now() - t0, cur: weeks[week] };
    hideLoading();
    asdShowPreview();
  } catch (e) {
    hideLoading();
    console.error('產生草稿失敗:', e);
    showToast('❌ 產生草稿失敗：' + e.message);
  }
}

// ───────── 預覽 ─────────
function asdEnsureModal() {
  if (document.getElementById('asdOverlay')) return;
  var ov = document.createElement('div');
  ov.id = 'asdOverlay';
  ov.className = 'asd-overlay';
  ov.onclick = function (e) { if (e.target === ov) asdClose(); };
  ov.innerHTML = '<div class="asd-sheet"><div class="asd-head"><div class="asd-title" id="asdTitle"></div>' +
    '<button class="asd-x" onclick="asdClose()" aria-label="關閉">✕</button></div>' +
    '<div class="asd-body" id="asdBody"></div>' +
    '<div class="asd-foot"><button class="asd-btn ghost" onclick="asdClose()">關閉</button>' +
    '<button class="asd-btn primary" id="asdApplyBtn" onclick="asdApply()">✅ 套用到班表</button></div></div>';
  document.body.appendChild(ov);
}
function asdClose() { var ov = document.getElementById('asdOverlay'); if (ov) ov.classList.remove('show'); }

function asdEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

function asdShowPreview() {
  asdEnsureModal();
  var L = asdLast, res = L.res, days = asDayNames();
  var mon = asWeekMonday(L.week);
  var md = function (i) { var d = shiftDateAdd(mon, i); return (+d.slice(5, 7)) + '/' + (+d.slice(8)); };
  document.getElementById('asdTitle').textContent = '🤖 ' + L.week.slice(-3) + ' 班表草稿（' + md(0) + '～' + md(6) + '）';

  var curMap = {};
  L.cur.forEach(function (r) { if (String(r.shift || '').trim()) curMap[r.name + '|' + r.day] = r.shift; });
  var draftMap = {};
  res.cells.forEach(function (c) { draftMap[c.name + '|' + c.day] = c; });
  var newCount = res.cells.filter(function (c) { return !curMap[c.name + '|' + c.day]; }).length;

  var h = '<div class="asd-note">只會填<b>空白格</b>（共 ' + newCount + ' 格），店長已排的格子不動。橘色＝草稿要填的；灰色＝已排好的。套用後照樣可以改。</div>';

  // 提醒區
  var alerts = [];
  if (res.gaps.length) alerts.push('<div class="asd-alert red"><b>🆘 補不到最少人數，會開待補 ' + res.gaps.length + ' 格：</b><br>' +
    res.gaps.map(function (g) { return g.day + ' ' + g.shift; }).join('、') + '</div>');
  if (res.soft.length) alerts.push('<div class="asd-alert amber"><b>⚠️ 未達目標人數（在最少人數以上，不開待補）：</b><br>' +
    res.soft.map(function (g) { return g.day + ' ' + g.label; }).join('、') + '</div>');
  res.notes.forEach(function (n) { alerts.push('<div class="asd-alert amber">💰 ' + asdEsc(n.msg) + '</div>'); });
  res.suggestions.forEach(function (s) {
    alerts.push('<div class="asd-alert blue">💡 ' + s.day + ' ' + asdEsc(s.name) + ' 延長 ' + s.label + ' 可補缺口' +
      (s.save > 0 ? '，比找工讀約省 $' + s.save : '') + '（正職加班由店長決定，草稿不會自動排）</div>');
  });
  h += alerts.join('');

  // 表格
  h += '<div class="asd-table-wrap"><table class="asd-table"><thead><tr><th>人員</th>' +
    days.map(function (d, i) { return '<th>' + d.slice(1) + '<small>' + md(i) + '</small></th>'; }).join('') +
    '<th>本週</th></tr></thead><tbody>';
  res.people.forEach(function (n) {
    var pe = res.perEmp[n];
    h += '<tr><td class="asd-name">' + asdEsc(getDisplayName(n)) + '<small>' + (pe.pt ? '工讀' : '正職') + '</small></td>';
    days.forEach(function (d) {
      var cur = curMap[n + '|' + d], c = draftMap[n + '|' + d];
      if (cur) { h += '<td class="asd-cell locked">' + asdEsc(cur) + '</td>'; return; }
      if (!c) { h += '<td class="asd-cell"></td>'; return; }
      var cls = c.shift === '指休' ? 'zhi' : (c.shift === '排休' ? 'off' : (asIsWorkShift(c.shift) ? 'work' : 'off'));
      h += '<td class="asd-cell new ' + cls + '" title="' + asdEsc(c.why || '') + '">' + asdEsc(c.shift === '指休' ? '休(劃)' : c.shift) + '</td>';
    });
    h += '<td class="asd-sum">' + pe.hours + 'h<small>休' + pe.offs + (pe.pt ? '' : '／應' + pe.offTarget) + '</small></td></tr>';
  });
  // 待補列：現有的（灰＝原本的班、紅＝這次補進去的）＋新開的（紅）
  asdGapRows(res.gaps, asdExistingGapRows(L.week)).forEach(function (r) {
    var added = Object.keys(r.days).length;
    if (!r.isNew && !added && !Object.keys(r.locked).length) return; // 空的舊待補列而且這次也沒用到 → 不顯示
    var hrs = 0;
    var tds = days.map(function (d) {
      if (r.locked[d]) { if (asIsWorkShift(r.locked[d])) hrs += shiftTotalHours(r.locked[d]); return '<td class="asd-cell locked">' + asdEsc(r.locked[d]) + '</td>'; }
      if (r.days[d]) { hrs += shiftTotalHours(r.days[d]); return '<td class="asd-cell new gap">' + asdEsc(r.days[d]) + '</td>'; }
      return '<td class="asd-cell"></td>';
    }).join('');
    var tag = r.isNew ? '新開' : (added ? '已開＋補 ' + added + ' 格' : '已開');
    h += '<tr class="asd-gap-row"><td class="asd-name gap">' + asdEsc(r.name) + '<small>' + tag + '</small></td>' + tds +
      '<td class="asd-sum">' + (hrs ? hrs + 'h' : '') + '</td></tr>';
  });
  h += '</tbody></table></div>';
  h += '<div class="asd-meta">排班規則：人力優先 → 正職 40 小時、不自動加班、當月應休平均到各週 → 工讀先顧成本再求時數接近。耗時 ' + (L.ms / 1000).toFixed(1) + ' 秒。</div>';

  document.getElementById('asdBody').innerHTML = h;
  document.getElementById('asdApplyBtn').disabled = newCount === 0 && res.gaps.length === 0;
  document.getElementById('asdOverlay').classList.add('show');
}

/**
 * 待補分列（預覽與套用共用，看到的列＝套用後的列）：列數越少越好。
 *  1. 先塞進現有待補列的空白天（W40 的🆘待補1只有週二有班，其他六天都能用）
 *  2. 塞不下才新開，同一天缺幾段就至少要幾列
 * @param gaps      草稿的待補 [{day, shift}]
 * @param existing  現有待補列 [{name, days:{週X: 已占用}}]
 * @returns [{name, isNew, days:{週X: 新填的班}, locked:{週X: 原本的班}}]
 */
function asdGapRows(gaps, existing) {
  var rows = (existing || []).map(function (r) { return { name: r.name, isNew: false, days: {}, locked: r.days || {} }; });
  var used = function (r, d) { return r.days[d] || r.locked[d]; };
  (gaps || []).forEach(function (g) {
    var row = rows.find(function (r) { return !used(r, g.day); });
    if (!row) {
      var k = 1;
      while (rows.some(function (r) { return r.name === '🆘待補' + k; })) k++;
      row = { name: '🆘待補' + k, isNew: true, days: {}, locked: {} };
      rows.push(row);
    }
    row.days[g.day] = g.shift;
  });
  return rows;
}

/** 本週現有的待補列與已占用的天（記錄有班別、備註或支援都算占用） */
function asdExistingGapRows(week) {
  var names = virtualRowNames.slice();
  var recs = (appData.records || []).filter(function (r) { return r.week === week && String(r.name).startsWith('🆘'); });
  recs.forEach(function (r) { if (names.indexOf(r.name) < 0) names.push(r.name); });
  return names.map(function (n) {
    var days = {};
    recs.forEach(function (r) {
      if (r.name === n && (String(r.shift || '').trim() || r.note || r.supportEmp)) days[r.day] = String(r.shift || '').trim() || '（已用）';
    });
    return { name: n, days: days };
  });
}

// ───────── 套用 ─────────
async function asdApply() {
  var L = asdLast;
  if (!L) return;
  var store = document.getElementById('storeSelector').value;
  var week = document.getElementById('weekSelector').value;
  if (store !== L.store || week !== L.week) { showToast('⚠️ 已切換門市或週次，請重新產生草稿'); asdClose(); return; }
  var why = asdBlockReason(store, week); // 預覽期間可能被發布了
  if (why) { showToast('⚠️ ' + why); asdClose(); return; }
  if (!confirm('把草稿填進 ' + week.slice(-3) + ' 的空白格' + (L.res.gaps.length ? '，並新增 🆘 待補 ' + L.res.gaps.length + ' 格' : '') + '？\n店長已排的格子不會被改。')) return;

  syncUIToMemory();
  var filled = 0, compCells = [], holidayCells = [];
  var findRec = function (n, d) { return appData.records.find(function (r) { return r.name === n && r.day === d && r.week === week; }); };
  var mkRec = function (n, d, shift) {
    return { week: week, day: d, name: n, shift: shift, location: '本店', note: '', actualHours: asIsWorkShift(shift) ? shiftTotalHours(shift) : 0,
      isOT: false, isHourly: false, supportEmp: '', approvalStatus: '', supportUpdatedAt: '', requestOff: false, lawOverrides: [] };
  };
  L.res.cells.forEach(function (c) {
    var ex = findRec(c.name, c.day);
    if (ex && String(ex.shift || '').trim()) return; // 預覽之後店長又排了 → 以店長為準
    if (ex) Object.assign(ex, mkRec(c.name, c.day, c.shift)); else appData.records.push(mkRec(c.name, c.day, c.shift));
    filled++;
    if (c.shift === '補休') compCells.push(c);
    if (asIsWorkShift(c.shift)) holidayCells.push(c);
  });
  var gapRows = asdGapRows(L.res.gaps, asdExistingGapRows(week));
  var newRows = 0, gapCells = 0;
  gapRows.forEach(function (r) {
    var ds = Object.keys(r.days);
    if (!ds.length) return;
    if (r.isNew) { virtualRowNames.push(r.name); newRows++; }
    ds.forEach(function (d) {
      var ex = findRec(r.name, d);
      if (ex) Object.assign(ex, mkRec(r.name, d, r.days[d])); else appData.records.push(mkRec(r.name, d, r.days[d]));
      gapCells++;
    });
  });

  asdClose();
  renderSchedule();
  triggerAutoSave();

  // 補休要扣帳本；國定假日上班要問補休——跟手動排班走同一套
  for (var i = 0; i < compCells.length; i++) await deductLeave(compCells[i].name, compCells[i].day, week, '', '補休');
  var mon = asWeekMonday(week);
  for (var j = 0; j < holidayCells.length; j++) {
    var c = holidayCells[j];
    var emp = (appData.employees || []).find(function (e) { return e.name === c.name; });
    await checkHolidayCompOnSave(c.name, shiftDateAdd(mon, c.di), '', c.shift, emp);
  }
  showToast('✅ 已填入 ' + filled + ' 格' + (gapCells ? '、待補 ' + gapCells + ' 格' + (newRows ? '（新開 ' + newRows + ' 列）' : '（都放進現有待補列）') : '') + '，可再手動調整');
}
