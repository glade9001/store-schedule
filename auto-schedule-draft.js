// 排班頁「🤖 產生草稿」：讀設定與資料 → auto-schedule-core.js asGenerateDraft → 預覽 → 店長按套用才填進班表。
// 開放：能排這家店的人都看得到按鈕；設定未完成就點 → 請他先去自動排班設定。
// ⚠️ 鐵則（使用者 2026-09-22）：不可改過去資料，尤其已發布的班表 —— 已發布／已過去的週一律不能產生、不能套用；
//    只填空白格，店長已排的格子不動。
// 依賴 schedule-v2-page.js 的全域：appData、appConfig、currentUser、virtualRowNames、weekPublishData、
//   isHistoryWeek、isAutoPublished、canScheduleStore、syncUIToMemory、renderSchedule、triggerAutoSave、
//   deductLeave、checkHolidayCompOnSave、showLoading、hideLoading、showToast、getDisplayName
// 本檔頂層只用 function 與 var（前綴 asd），避免跟頁面撞名。

var asdLast = null; // 最近一次草稿結果 { week, store, res }

/** 能排這家店的人都看得到按鈕（2026-09-22 起不限美德）；設定還沒完成時點了會請他先去設定 */
function asdAllowedUser(store) {
  return canScheduleStore(store);
}

/** 設定算「完成」：已儲存，且至少一天有人數需求、至少一個自動排班的人有可上班別（空白存檔不算） */
function asdConfigReady(cfg) {
  if (!cfg) return false;
  var hasDemand = asDayNames().some(function (d) { return ((cfg.demand || {})[d] || []).length > 0; });
  var hasStaff = Object.keys(cfg.staff || {}).some(function (n) {
    var st = cfg.staff[n];
    return st && st.auto && ((st.term || []).length > 0 || Object.keys(st.termDays || {}).length > 0);
  });
  return hasDemand && hasStaff;
}

function asdGoSetup(store) {
  if (confirm('「' + store + '」需先完成自動排班設定（每天各時段需要幾人、每個人可上的班別），才能產生草稿。\n\n要現在前往設定嗎？')) {
    location.href = 'auto-schedule.html?store=' + encodeURIComponent(store) + '&ref=' + encodeURIComponent('schedule-V2.html?mode=admin');
  }
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

var asdIncludeGaps = true; // 「本次自動新增待補格」（預覽勾選；不勾＝不新增也不移除任何待補格）

/**
 * mode：'new'＝填空白格；'redraft'＝依最新劃休重排（2026-09-22）
 *   重排：①劃休衝突先修正（新劃休→指休／特休／補休，原本的班清空；只休半天→碰到的班清空；取消劃休→指休清空）
 *         ②清掉「草稿排、店長沒動過」的格子 ③勾「自動新增待補格」時，清掉草稿開、還沒人認領的待補
 *         ——店長手動改過的格子、他店已認領的待補一律不動
 */
async function asdGenerate(mode) {
  mode = mode === 'redraft' ? 'redraft' : 'new';
  var store = document.getElementById('storeSelector').value;
  var week = document.getElementById('weekSelector').value;
  var why = asdBlockReason(store, week);
  if (why) { showToast('⚠️ ' + why); return; }
  showLoading(mode === 'redraft' ? '🔄 依最新劃休重排…' : '🤖 讀取設定與班表…');
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
    var cfg = snaps[0].exists ? snaps[0].data() : null;
    if (!asdConfigReady(cfg)) { hideLoading(); asdGoSetup(store); return; }
    var weeks = {};
    snaps[1].forEach(function (d) { weeks[d.id] = d.data().records || []; });
    // 本週用記憶體裡的（含還沒存的修改），不用資料庫那份
    var curRecs = (appData.records || []).filter(function (r) { return r.week === week; });
    var fixes = [], working = curRecs.map(function (r) { return Object.assign({}, r); });
    if (mode === 'redraft') {
      fixes = asdConflicts(week);
      fixes.forEach(function (f) {
        var r = working.find(function (x) { return x.name === f.name && x.day === f.day && asIsHomeRecord(x); });
        if (r) { r.shift = f.to; r.actualHours = 0; delete r.draft; }
        else if (f.to) working.push({ week: week, day: f.day, name: f.name, shift: f.to, location: '本店', actualHours: 0 });
      });
      var fixedKey = {}; fixes.forEach(function (f) { fixedKey[f.name + '|' + f.day] = 1; });
      working = working.filter(function (r) {
        if (fixedKey[r.name + '|' + r.day]) return true;
        var gap = String(r.name).startsWith('🆘');
        if (gap) return !(asdIncludeGaps && r.draft && !r.supportEmp && !r.approvalStatus); // 他店已認領的待補不動
        return !r.draft; // 草稿排、店長沒動過 → 清掉重排
      });
      working = working.filter(function (r) { return String(r.shift || '').trim() || r.note || r.supportEmp; });
    }
    weeks[week] = working;
    var leaves = [];
    snaps[2].forEach(function (d) { leaves.push(d.data()); });
    var emps = (appData.employees || []).filter(function (e) { return !String(e.name).startsWith('🆘') && !e._transferThisWeek; })
      .map(function (e) {
        var sal = (appData.salaryRecData || {})[e.name] || {};
        return { name: e.name, role: e.role, payAsPartTime: !!e.payAsPartTime,
          wage: parseFloat(sal.wage || e.wage || 0), base: parseFloat(sal.baseSalary != null ? sal.baseSalary : (e.baseSalary || 0)),
          startDate: e.startDate || '', departDate: e.status === '離職' ? (e.departDate || '') : '' };
      });
    // 已核准的跨店支援：那天人在別店，本店不排（排班頁載入時已把他店支援本店員工的記錄放進 allStoresRecords）
    var DAYS = asDayNames();
    var away = (appData.allStoresRecords || []).filter(function (r) {
      return r._store !== store && r.week === week && r.approvalStatus === 'approved' && String(r.supportEmp || '').startsWith(store + '-');
    }).map(function (r) {
      return { name: String(r.supportEmp).slice(store.length + 1), di: DAYS.indexOf(r.day), shift: r.shift, store: r._store };
    }).filter(function (a) { return a.di >= 0; });
    var hist = {};
    Object.keys(weeks).forEach(function (w) { if (w < week) hist[w] = weeks[w]; });
    var catalog = asBuildCatalog(appConfig.shifts || [], hist, 3);

    showLoading('🤖 排班中…（約需幾秒）');
    await new Promise(function (r) { setTimeout(r, 30); }); // 讓「排班中」先畫出來
    var t0 = Date.now();
    // 重排：告訴草稿原本的草稿格排什麼，盡量維持（只動跟劃休變動有關的格子）
    var keep = {};
    if (mode === 'redraft') curRecs.forEach(function (r) {
      if (r.draft && !String(r.name).startsWith('🆘') && asIsHomeRecord(r)) { var di = asDayNames().indexOf(r.day); if (di >= 0) keep[r.name + '|' + di] = String(r.shift || '').trim(); }
    });
    var res = asGenerateDraft({ weekStr: week, cfg: cfg, emps: emps, weeks: weeks, leaves: leaves, away: away, catalog: catalog, opt: { keep: keep } });
    asdLast = { week: week, store: store, res: res, ms: Date.now() - t0, cur: weeks[week], mode: mode, before: curRecs, fixes: fixes };
    hideLoading();
    asdShowPreview();
  } catch (e) {
    hideLoading();
    console.error('產生草稿失敗:', e);
    showToast('❌ 產生草稿失敗：' + e.message);
  }
}

// ───────── 劃休衝突（排班頁上方提醒＋重排用）─────────
/**
 * 目前班表跟最新劃休對不上的格子：
 *   新劃休：整天排休→指休、特休→特休、補休→補休（原本排什麼都改掉）；只休早上／晚上→碰到那段的班清空
 *   取消劃休：班表還是指休、且這天已沒有有效劃休 → 清空
 * @returns [{name, day, from, to, why}]
 */
function asdConflicts(week) {
  var out = [];
  var recs = (appData.records || []).filter(function (r) { return r.week === week && asIsHomeRecord(r); });
  var cell = function (n, d) { var r = recs.find(function (x) { return x.name === n && x.day === d; }); return r ? String(r.shift || '').trim() : ''; };
  var alive = function (r) { return ['cancelled', 'unfulfilled', 'rejected'].indexOf(r.status) < 0; };
  var mon = asWeekMonday(week), days = asDayNames();
  var lrs = appData.leaveRequests || [];
  days.forEach(function (d, di) {
    var date = shiftDateAdd(mon, di);
    var names = {};
    lrs.forEach(function (r) { if (r.date === date) names[r.empName] = 1; });
    Object.keys(names).forEach(function (n) {
      if (String(n).startsWith('🆘')) return;
      var act = lrs.filter(function (r) { return r.date === date && r.empName === n && alive(r); });
      var cur = cell(n, d);
      var full = act.filter(function (r) { return !r.shift || r.shift === 'full'; })[0];
      if (full) {
        var to = full.type === 'annual' ? '特休' : full.type === 'comp' ? '補休' : '指休';
        // 空白格不算衝突（還沒排，產生草稿時本來就會照劃休給）
        if (cur && cur !== to) out.push({ name: n, day: d, date: date, from: cur, to: to, why: '新劃休' });
        return;
      }
      var half = act[0];
      if (half && asIsWorkShift(cur)) {
        var sp = shiftSpan(cur), sH = sp.startH < 7 ? sp.startH + 24 : sp.startH, eH = sH + shiftTotalHours(cur);
        var hit = half.shift === 'morning' ? sH < 15 : eH > 15;
        if (hit) out.push({ name: n, day: d, date: date, from: cur, to: '', why: half.shift === 'morning' ? '劃休早上' : '劃休晚上' });
        return;
      }
      if (!act.length && cur === '指休') out.push({ name: n, day: d, date: date, from: cur, to: '', why: '已取消劃休' });
    });
  });
  return out;
}

/** 排班頁上方：列出劃休衝突＋「依最新劃休重排」 */
function asdRenderConflicts() {
  var el = document.getElementById('leaveConflictBanner');
  if (!el) return;
  var store = document.getElementById('storeSelector').value;
  var week = document.getElementById('weekSelector').value;
  if (!asdAllowedUser(store) || asdBlockReason(store, week)) { el.style.display = 'none'; return; }
  var list = asdConflicts(week);
  if (!list.length) { el.style.display = 'none'; return; }
  var md = function (ds) { return (+ds.slice(5, 7)) + '/' + (+ds.slice(8)); };
  var items = list.map(function (f) {
    return getDisplayName(f.name) + ' ' + md(f.date) + ' ' + f.why + '：' + (f.from || '空白') + ' → ' + (f.to || '清空重排');
  });
  el.innerHTML = '<div class="lc-text"><b>📋 劃休有變動（' + list.length + ' 筆）</b>：' + asdEsc(items.slice(0, 4).join('；')) +
    (items.length > 4 ? '…等' : '') + '</div><button class="lc-btn" onclick="asdGenerate(\'redraft\')">🔄 依最新劃休重排</button>';
  el.style.display = 'flex';
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
    '<div class="asd-foot"><label class="asd-gapchk"><input type="checkbox" id="asdGapChk" checked onchange="asdToggleGaps(this.checked)"> 本次自動新增待補格</label>' +
    '<button class="asd-btn ghost" onclick="asdClose()">關閉</button>' +
    '<button class="asd-btn primary" id="asdApplyBtn" onclick="asdApply()">✅ 套用到班表</button></div></div>';
  document.body.appendChild(ov);
}
/** 勾選變了 → 重算（重排時要不要保留舊待補會影響人力；新草稿則只影響要不要開待補） */
function asdToggleGaps(v) { asdIncludeGaps = !!v; if (asdLast) asdGenerate(asdLast.mode); }
function asdClose() { var ov = document.getElementById('asdOverlay'); if (ov) ov.classList.remove('show'); }

function asdEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

function asdShowPreview() {
  asdEnsureModal();
  var L = asdLast, res = L.res, days = asDayNames();
  var mon = asWeekMonday(L.week);
  var md = function (i) { var d = shiftDateAdd(mon, i); return (+d.slice(5, 7)) + '/' + (+d.slice(8)); };
  document.getElementById('asdTitle').textContent = (L.mode === 'redraft' ? '🔄 ' + L.week.slice(-3) + ' 依最新劃休重排（' : '🤖 ' + L.week.slice(-3) + ' 班表草稿（') + md(0) + '～' + md(6) + '）';
  var gc = document.getElementById('asdGapChk'); if (gc) gc.checked = asdIncludeGaps;
  var beforeMap = {};
  (L.before || []).forEach(function (r) { if (asIsHomeRecord(r)) beforeMap[r.name + '|' + r.day] = String(r.shift || '').trim(); });

  var curMap = {};
  L.cur.forEach(function (r) { if (String(r.shift || '').trim()) curMap[r.name + '|' + r.day] = r.shift; });
  var draftMap = {};
  res.cells.forEach(function (c) { draftMap[c.name + '|' + c.day] = c; });
  var newCount = res.cells.filter(function (c) { return !curMap[c.name + '|' + c.day]; }).length;

  var h = L.mode === 'redraft'
    ? '<div class="asd-note">依最新劃休重排：<b>店長手動改過的格子、他店已認領的待補都不動</b>，只重排草稿排的格子。<b class="chg-legend">紫框</b>＝跟現在班表不一樣的格子。</div>'
    : '<div class="asd-note">只會填<b>空白格</b>（共 ' + newCount + ' 格），店長已排的格子不動。橘色＝草稿要填的；灰色＝已排好的。套用後照樣可以改。</div>';
  if (L.fixes && L.fixes.length) {
    h += '<div class="asd-alert blue"><b>📋 依劃休修正 ' + L.fixes.length + ' 格：</b><br>' + L.fixes.map(function (f) {
      return asdEsc(getDisplayName(f.name)) + ' ' + md(asDayNames().indexOf(f.day)) + ' ' + f.why + '：' + asdEsc(f.from || '空白') + ' → ' + (f.to || '重排');
    }).join('<br>') + '</div>';
  }
  if (!asdIncludeGaps) h += '<div class="asd-alert amber">這次不新增待補格：缺口只列出來，現有待補格照原樣保留。</div>';

  // 提醒區
  var alerts = [];
  if (res.gaps.length) alerts.push('<div class="asd-alert red"><b>🆘 補不到最少人數' + (asdIncludeGaps ? '，會開待補 ' : '（這次不開待補）') + res.gaps.length + ' 格：</b><br>' +
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
      var aw = (pe.away || [])[days.indexOf(d)];
      if (aw && !cur) { h += '<td class="asd-cell locked" title="已核准的跨店支援">支援' + asdEsc(aw.store) + '<small>' + asdEsc(aw.shift) + '</small></td>'; return; }
      var was = beforeMap[n + '|' + d] || '';
      var now = cur || (c ? c.shift : '');
      var chg = L.mode === 'redraft' && was !== now ? ' chg' : '';
      var wasTxt = chg ? '<small>原 ' + asdEsc(was || '空白') + '</small>' : '';
      if (cur) { h += '<td class="asd-cell locked' + chg + '">' + asdEsc(cur) + wasTxt + '</td>'; return; }
      if (!c) { h += '<td class="asd-cell' + chg + '">' + wasTxt + '</td>'; return; }
      var cls = c.shift === '指休' ? 'zhi' : (c.shift === '排休' ? 'off' : (asIsWorkShift(c.shift) ? 'work' : 'off'));
      h += '<td class="asd-cell new ' + cls + chg + '" title="' + asdEsc(c.why || '') + '">' + asdEsc(c.shift === '指休' ? '休(劃)' : c.shift) + wasTxt + '</td>';
    });
    h += '<td class="asd-sum">' + pe.hours + 'h<small>休' + pe.offs + (pe.pt ? '' : '／應' + pe.offTarget) + '</small></td></tr>';
  });
  // 待補列：現有的（灰＝原本的班、紅＝這次補進去的）＋新開的（紅）
  asdGapRows(asdIncludeGaps ? res.gaps : [], asdExistingGapRows(L.week)).forEach(function (r) {
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
  document.getElementById('asdApplyBtn').disabled = L.mode !== 'redraft' && newCount === 0 && (!asdIncludeGaps || res.gaps.length === 0);
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
  // 重排時用「重排後保留下來」的待補（草稿開、沒人認領的已清掉）
  var src = (asdLast && asdLast.week === week && asdLast.mode === 'redraft') ? asdLast.cur : (appData.records || []);
  var recs = src.filter(function (r) { return r.week === week && String(r.name).startsWith('🆘'); });
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
  var gapN = asdIncludeGaps ? L.res.gaps.length : 0;
  var ask = L.mode === 'redraft'
    ? '依最新劃休重排 ' + week.slice(-3) + '？\n會修正劃休對不上的 ' + (L.fixes || []).length + ' 格、重排草稿排的格子' + (gapN ? '，並開待補 ' + gapN + ' 格' : '') + '。\n店長手動改過的格子、他店已認領的待補不會動。'
    : '把草稿填進 ' + week.slice(-3) + ' 的空白格' + (gapN ? '，並新增 🆘 待補 ' + gapN + ' 格' : '') + '？\n店長已排的格子不會被改。';
  if (!confirm(ask)) return;

  syncUIToMemory();
  var filled = 0, compCells = [], holidayCells = [], leaveMoves = [];
  var findRec = function (n, d) { return appData.records.find(function (r) { return r.name === n && r.day === d && r.week === week && asIsHomeRecord(r); }); };
  var mkRec = function (n, d, shift) {
    return { week: week, day: d, name: n, shift: shift, location: '本店', note: '', actualHours: asIsWorkShift(shift) ? shiftTotalHours(shift) : 0,
      isOT: false, isHourly: false, supportEmp: '', approvalStatus: '', supportUpdatedAt: '', requestOff: false, lawOverrides: [], draft: true };
  };
  if (L.mode === 'redraft') {
    // ① 劃休修正（照預覽時算好的；之後店長若又改了同一格，以店長為準就跳過）
    (L.fixes || []).forEach(function (f) {
      var ex = findRec(f.name, f.day), cur = ex ? String(ex.shift || '').trim() : '';
      if (cur !== (f.from || '')) return;
      if (f.to) {
        if (ex) { ex.shift = f.to; ex.actualHours = 0; ex.isOT = false; delete ex.draft; }
        else appData.records.push(Object.assign(mkRec(f.name, f.day, f.to), { draft: false }));
      } else if (ex) {
        appData.records.splice(appData.records.indexOf(ex), 1);
      }
      leaveMoves.push({ name: f.name, day: f.day, from: cur, to: f.to || '' });
    });
    // ② 清掉草稿格（店長沒動過）＋勾選時清掉草稿開、沒人認領的待補
    var fixedKey = {}; (L.fixes || []).forEach(function (f) { fixedKey[f.name + '|' + f.day] = 1; });
    appData.records = appData.records.filter(function (r) {
      if (r.week !== week || !r.draft || fixedKey[r.name + '|' + r.day]) return true;
      if (String(r.name).startsWith('🆘')) {
        if (!asdIncludeGaps || r.supportEmp || r.approvalStatus) return true;
        return false;
      }
      if (r.shift === '特休' || r.shift === '補休') leaveMoves.push({ name: r.name, day: r.day, from: r.shift, to: '' });
      return false;
    });
    // 待補列名單同步：整列都被清空的草稿待補列拿掉
    virtualRowNames = virtualRowNames.filter(function (n) { return appData.records.some(function (r) { return r.week === week && r.name === n; }) || !(L.before || []).some(function (r) { return r.name === n && r.draft; }); });
  }
  L.res.cells.forEach(function (c) {
    var ex = findRec(c.name, c.day);
    if (ex && String(ex.shift || '').trim()) return; // 預覽之後店長又排了 → 以店長為準
    if (ex) Object.assign(ex, mkRec(c.name, c.day, c.shift)); else appData.records.push(mkRec(c.name, c.day, c.shift));
    filled++;
    if (c.shift === '補休') compCells.push(c);
    if (asIsWorkShift(c.shift)) holidayCells.push(c);
  });
  var gapRows = asdIncludeGaps ? asdGapRows(L.res.gaps, asdExistingGapRows(week)) : [];
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

  // 特休／補休帳本：劃休修正與清掉的草稿格照實扣還；補休要扣帳本；國定假日上班要問補休——跟手動排班走同一套
  for (var k = 0; k < leaveMoves.length; k++) await deductLeave(leaveMoves[k].name, leaveMoves[k].day, week, leaveMoves[k].from, leaveMoves[k].to);
  for (var i = 0; i < compCells.length; i++) await deductLeave(compCells[i].name, compCells[i].day, week, '', '補休');
  var mon = asWeekMonday(week);
  for (var j = 0; j < holidayCells.length; j++) {
    var c = holidayCells[j];
    var emp = (appData.employees || []).find(function (e) { return e.name === c.name; });
    await checkHolidayCompOnSave(c.name, shiftDateAdd(mon, c.di), '', c.shift, emp);
  }
  showToast((L.mode === 'redraft' ? '✅ 已依最新劃休重排：修正 ' + leaveMoves.length + ' 格、' : '✅ ') + '已填入 ' + filled + ' 格' + (gapCells ? '、待補 ' + gapCells + ' 格' + (newRows ? '（新開 ' + newRows + ' 列）' : '（都放進現有待補列）') : '') + '，可再手動調整');
}
