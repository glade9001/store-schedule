// ===== 員工補登申請（2026-09-28 收成一份）=====
// 打卡頁（clock-page.js）與我的出勤（my-attendance.html）共用。原本兩頁各寫一份、已經長歪：
//   ・打卡頁送出的申請沒有「自述準時」標記（店長看不到）
//   ・9/24 打卡頁查薪資是否送審時誤用「定位到的門市」
// 開視窗（預設門市不同）與送出後的提示方式（alert／toast）仍由各頁自己處理，判斷與要寫的資料都在這裡。
// 依賴：currentUser、appConfig、findShiftStoresOn／matchSchedShift／parseShiftSegs（shift-utils.js）
// 表單欄位 id：rqStore rqDate rqType rqTime rqReasonCode rqReason rqReasonHint rqStoreHint

// ── 原因分類（2026-09-16）──
// 原本是選填的自由輸入 → 8/1~9/16 的 321 張申請有 189 張（59%）空白，店長看到「原因：—」、也無從統計根因。
// 改成必選分類（選「其他」才強制打字），並另存 reasonCode/reasonText 供統計；reason 仍組成文字供既有顯示與通知使用。
var REQ_REASONS = { forgot: '忘記打卡', device: '手機沒帶／沒電／故障', system: '打不進去（定位或系統出錯）', support: '支援他店，不知道在哪打卡', noshift: '沒排班但有到場', wrongtime: '打卡時間錯誤，要修改', other: '其他' };
var REQ_REASON_HINTS = {
  system: '若你還在店裡，請先回打卡頁按「📨 傳送給系統管理員」附上定位診斷，這樣才查得出原因。',
  support: '提醒：支援他店時，要在<b>實際上班的那家店</b>打卡，門市請選那一家。',
  wrongtime: '這是「修改時間」：填正確時間即可，原本的打卡紀錄會保留備查。',
  noshift: '沒排班卻有到場，請順便提醒店長補排班，否則工時可能算不進去。',
  other: '請具體說明原因（至少 5 個字），店長才有辦法判斷。'
};
function onReqReasonChange() {
  var code = document.getElementById('rqReasonCode').value;
  var hint = document.getElementById('rqReasonHint');
  var ta = document.getElementById('rqReason');
  if (hint) { hint.innerHTML = REQ_REASON_HINTS[code] || ''; hint.style.display = REQ_REASON_HINTS[code] ? 'block' : 'none'; }
  if (ta) ta.placeholder = code === 'other' ? '請說明原因（必填，至少 5 個字）' : '補充說明（選填）';
}
/** 清空表單並帶今天（本地日期；不可用 toISOString＝UTC，台灣 00:00~08:00 會變成昨天） */
function resetReqForm(stores, defaultStore) {
  document.getElementById('rqStore').innerHTML = stores.map(function (s) { return '<option value="' + s + '"' + (s === defaultStore ? ' selected' : '') + '>' + s + '</option>'; }).join('');
  var d = new Date();
  document.getElementById('rqDate').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  document.getElementById('rqTime').value = ''; document.getElementById('rqReason').value = '';
  document.getElementById('rqReasonCode').value = ''; onReqReasonChange();
}

// ── 門市預設值跟著「那天的排班」走，不是跟著你現在人在哪 ──
// 支援日的班在別家店，照舊的預設送出去就會送錯店 → 缺卡單配不到、工時也配不起來。
// 仍然是可改的下拉，只是把預設值挑對，並把依據寫在下面讓人看得懂。
var _rqShifts = [];   // 當天排班（「自述準時」判定用）
async function syncReqStore() {
  var hint = document.getElementById('rqStoreHint'); if (!hint) return;
  var ds = document.getElementById('rqDate').value;
  var sel = document.getElementById('rqStore');
  _rqShifts = [];
  if (!ds) { hint.textContent = ''; return; }
  hint.textContent = '查詢當天排班中…';
  try {
    var hits = await findShiftStoresOn(ds, currentUser.empName, currentUser.store || '', appConfig.stores || []);
    // 查詢期間日期被改了（例：從待補清單開啟時先以今天查、馬上又改成缺卡那天）→ 這次結果作廢，
    // 不然慢回來的「今天」會蓋掉正確那天的排班，自述準時就判錯
    if (document.getElementById('rqDate').value !== ds) return;
    _rqShifts = hits || [];
    if (!_rqShifts.length) { hint.textContent = '當天查無排班，門市請自行選擇。'; return; }
    var uniq = Array.from(new Set(_rqShifts.map(function (h) { return h.store; })));
    if (uniq.length === 1) sel.value = uniq[0];
    var txt = _rqShifts.map(function (h) { return h.store + ' ' + h.shift + (h.fromPrevDay ? '（前一日跨夜班）' : ''); }).join('、');
    hint.innerHTML = uniq.length === 1
      ? '✅ 當天排班：<b>' + txt + '</b>　已自動選好門市'
      : '⚠️ 當天在多家店有班：<b>' + txt + '</b>　請自行確認要補哪一家';
  } catch (e) { hint.textContent = '（查不到當天排班，門市請自行確認）'; }
}

// 該月薪資是否已送審／已發布。2026-09-24 改為「不擋、只標記」：原本送審後員工不能自行補登，
// 但薪資常在月底前就送審（9 月 9/24 就送了）→ 當月剩下的日子全補不了。改成照常送出，
// 申請帶 afterSalaryLock，店長審核時看到警示再決定要不要調薪資。
async function salaryLockedFor(store, ym) {
  try {
    var d = await window.db.collection('stores').doc(store).collection('salary').doc(ym).get();
    var st = d.exists ? (d.data().status || 'draft') : 'draft';
    return ['submitted', 'published'].indexOf(st) >= 0;
  } catch (e) { return false; }   // 查不到就不擋，避免連線問題讓人補不了卡
}
// 回傳 null＝驗證未過（已提示使用者）
function collectReqReason() {
  var code = document.getElementById('rqReasonCode').value;
  var text = document.getElementById('rqReason').value.trim();
  if (!code) { alert('請選擇原因'); return null; }
  if (code === 'other' && text.length < 5) { alert('選「其他」時請具體說明原因（至少 5 個字）'); return null; }
  return { reasonCode: code, reasonText: text, reason: REQ_REASONS[code] + (text ? '：' + text : '') };
}

/**
 * 讀表單、驗證、比對班表 → 回傳 { store, data }（要寫進 stores/{store}/attendanceRequests 的文件）；
 * 驗證沒過或使用者取消回傳 null（提示已顯示）。
 * @param opt.fixShiftDate 從待補清單點進來時的班別日期（跨夜班下班是隔天）
 */
async function buildFixRequest(opt) {
  opt = opt || {};
  var atStore = document.getElementById('rqStore').value;
  var targetDate = document.getElementById('rqDate').value;
  var punchType = document.getElementById('rqType').value;
  var requestedTime = document.getElementById('rqTime').value;
  if (!atStore || !targetDate || !requestedTime) { alert('請填寫門市、日期、時間'); return null; }
  var rr = collectReqReason(); if (!rr) return null;
  // 這個時間對得上哪一班？對不上就先問（2026-09-22：某跨店支援的正職 9/16 07:00 那筆不屬於任何一班，卻被核准）
  // 原因選「沒排班但有到場」就不用問（本來就沒班）
  var mt = { shift: '', shiftDate: opt.fixShiftDate || targetDate };
  try { mt = await matchSchedShift(atStore, currentUser.empName, currentUser.store || '', targetDate, requestedTime, punchType); } catch (e) {}
  if (!mt.shift && rr.reasonCode !== 'noshift' && !confirm('⚠️ ' + targetDate + ' ' + requestedTime + ' 的' + punchType + '卡，對不上你在 ' + atStore + ' 的任何一個班。\n\n跨夜班的下班是「隔天」早上（例：9/17 大夜 23-07 → 9/18 07:00）。\n確定要這樣送出嗎？')) return null;
  // 自述準時（2026-09-16）：補上班卡且申報時間落在排班開始 ±5 分鐘內 → 標記。
  // 系統無從查證員工幾點到店，能做的是讓「每次都剛好準時」這件事在店長眼前看得見。
  var claimOnTime = false;
  try {
    if (punchType === '上班') {
      var hit = _rqShifts.find(function (h) { return h.store === atStore; }) || _rqShifts[0];
      var segs = (hit && typeof parseShiftSegs === 'function') ? parseShiftSegs(hit.shift || '') : [];
      if (segs.length) {
        var startMin = Math.round(segs[0].startH * 60);
        var hm = requestedTime.split(':').map(Number);
        claimOnTime = Math.abs((hm[0] * 60 + hm[1]) - startMin) <= 5;
      }
    }
  } catch (e) {}
  var afterSalaryLock = await salaryLockedFor(atStore, targetDate.slice(0, 7));
  return {
    store: atStore,
    data: {
      empName: currentUser.empName, displayName: currentUser.displayName || currentUser.empName,
      homeStore: currentUser.store || '', atStore: atStore, type: '補登/修改', targetDate: targetDate, punchType: punchType, requestedTime: requestedTime,
      reason: rr.reason, reasonCode: rr.reasonCode, reasonText: rr.reasonText, claimOnTime: claimOnTime, afterSalaryLock: afterSalaryLock,
      shiftDate: mt.shift ? mt.shiftDate : (opt.fixShiftDate || targetDate), matchedShift: mt.shift || '',
      status: 'pending', createdAt: new Date().toISOString(), createdBy: currentUser.empName
    }
  };
}
