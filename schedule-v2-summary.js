// 排班頁之七：本月統計（特休／補休摘要）、復原、虛擬列、審核、跨店待補看板、匯出圖片、Service Worker 註冊。2026-10-16 從 schedule-v2-page.js 原封不動切出來（整理第 4 階段）。

// 取得某記錄屬於哪個月份（YYYY-MM）
function getRecordMonth(r) {
  const yr = r.week.split('-W')[0];
  const dates = getWeekDates(r.week);
  const dayIdx = dayNames.indexOf(r.day);
  if(dayIdx < 0) return null;
  const dateStr = dates[dayIdx]; // "4/27"
  const p = dateStr.split('/');
  return `${yr}-${p[0].padStart(2,'0')}`;
}

// 取得本週涵蓋的月份清單（可能1或2個）
function getWeekMonths(weekStr) {
  const yr = weekStr.split('-W')[0];
  const dates = getWeekDates(weekStr);
  return [...new Set(dates.map(d => {
    const p = d.split('/');
    return `${yr}-${p[0].padStart(2,'0')}`;
  }))];
}

// 判斷某筆記錄是否屬於指定員工（含跨店支援，去除重複計算）
function isEmpRecord(r, store, empName) {
  const isNative = (r._store === store && r.name === empName);
  const isSupport = (r.supportEmp === `${store}-${empName}` && r.approvalStatus === 'approved');
  if(!isNative && !isSupport) return false;
  if(isNative) {
    const hasSupportThat = (appData.allStoresRecords || []).some(sr =>
      sr.supportEmp === `${store}-${empName}` && sr.approvalStatus === 'approved' &&
      sr.day === r.day && sr.week === r.week
    );
    if(hasSupportThat) return false;
  }
  return true;
}

// ===== 特補休餘額（背景讀取＋快取）=====
// 補休改從帳本算（comp-avail.js 的 caCompAvailability：leaveLog + compUsage），不再讀 comp/{年}.earned/used
// ——那兩個統計欄位會漂（曾有人 comp/2026.earned=4 但 leaveLog 有 5 筆發放），而且會把負數夾成 0 把超用蓋掉。
// ⚠️ updateSummary 每改一格就會被呼叫一次，帳本是每人十幾筆文件，所以一定要快取；
//    寫到補休／特休的路徑（deductLeave、發放/撤銷國定假日補休）記得呼叫 invalidateLeaveSum()。
const leaveSumCache = {};
function invalidateLeaveSum(empName) {
  if(empName) delete leaveSumCache[empName];
  else Object.keys(leaveSumCache).forEach(k => delete leaveSumCache[k]);
}
/** @returns {Promise<{annual:number, noAnnual:boolean, comp:number, pending:Array, pendingDays:number}>} */
function fetchLeaveSum(empName) {
  if(typeof caCompAvailability !== 'function') return Promise.reject(new Error('comp-avail.js 未載入'));
  if(leaveSumCache[empName]) return leaveSumCache[empName];
  const p = Promise.all([
    window.db.collection('employees').doc(empName).collection('leaveBatches').get(),
    caCompAvailability(empName)
  ]).then(([bSnap, ca]) => {
    const todayStr2 = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().split('T')[0];
    let annual = 0;
    bSnap.forEach(b => {
      const bd = b.data();
      if(bd.settled) return;
      const rem = (bd.days||0)-(bd.used||0);
      if(rem<=0) return;
      let expDate = bd.expireDate;
      if(bd.carried) { const e=new Date(bd.expireDate); e.setFullYear(e.getFullYear()+1); e.setDate(e.getDate()-1); expDate=e.toISOString().split('T')[0]; }
      if(todayStr2 <= expDate) annual += rem;
    });
    const pending = ca.pending || [];
    return { annual, noAnnual: bSnap.size === 0, comp: ca.effective,
             pending, pendingDays: pending.reduce((a,x) => a + x.n, 0) };
  });
  leaveSumCache[empName] = p;   // 存 Promise：同一輪多人重畫只會各打一次
  p.catch(() => { delete leaveSumCache[empName]; });  // 失敗不留快取，下次重試
  return p;
}

async function updateSummary(idx, emp) {
  const t = document.getElementById(`sum-${idx}`);
  if(!t || emp.name.startsWith('🆘')) { if(t) t.textContent = '-'; return; }

  const weekStr = document.getElementById('weekSelector').value;
  const store = document.getElementById('storeSelector').value;
  const role = emp.role || '';
  const isPartTime = isPartTimeEmp(emp);
  const isFullTime = (role === '正職' || role === '店長' || role === '加盟主');

  // 本週涵蓋月份（可能跨月）
  const weekMonths = getWeekMonths(weekStr);

  // ===== 本週統計 =====
  let wH = 0, wOff = 0, wOT = 0;
  (appData.allStoresRecords || []).forEach(r => {
    if(!isEmpRecord(r, store, emp.name)) return;
    if(r.week !== weekStr) return;
    const h = parseFloat(r.actualHours || 0);
    const isOff = (r.shift === '排休' || r.shift === '指休' || r.shift === '特休' || r.shift === '補休');
    if(isOff) { wOff++; }
    else if(r.isHourly) { /* 時薪另計算休假，不計工時 */ }
    else if(r.shift) {
      wH += h;
      if(r.isOT || h > 8) wOT += Math.max(0, h - 8);
    }
  });

  // ===== 各月份統計（逐月分開）=====
  // ✅ 用「目前選取班表週次」的週一所在月份計算，而非今天的自然月
  // 例：查 6/19 那週 → 統計 6 月的累計資料
  const today = new Date();
  const weekMonForStats = weekStringToDate(weekStr);
  const currentMonthKey = `${weekMonForStats.getFullYear()}-${String(weekMonForStats.getMonth()+1).padStart(2,"0")}`;

  // monthStats 只統計班表週次所在月份的記錄
  const monthStats = { [currentMonthKey]: { h: 0, off: 0, ot: 0 } };

  (appData.allStoresRecords || []).forEach(r => {
    if(!isEmpRecord(r, store, emp.name)) return;
    const month = getRecordMonth(r);
    if(!month) return;
    // ✅ 只統計今天實際所在月份的記錄，每天個別用實際日期判斷
    if(month !== currentMonthKey) return;
    const h = parseFloat(r.actualHours || 0);
    const isOff = (r.shift === '排休' || r.shift === '指休' || r.shift === '特休' || r.shift === '補休');
    if(isOff) {
      monthStats[currentMonthKey].off++;
    } else if(r.isHourly) { /* 時薪另計算休假，不計月工時 */ }
    else if(r.shift) {
      monthStats[currentMonthKey].h += h;
      if(r.isOT || h > 8) monthStats[currentMonthKey].ot += Math.max(0, h - 8);
    }
  });

  // ===== 渲染統計 =====
  const r10 = v => Math.round(v * 10) / 10;
  let html = '';

  // ✅ 特補休剩餘（背景非同步讀取，顯示在統計欄底部）
  const leaveHtmlId = `leave-sum-${idx}`;
  // 先渲染 placeholder，背景讀取後填入
  const leavePlaceholder = `<div id="${leaveHtmlId}" style="font-size:10px;color:#94a3b8;">--</div>`;
  // 背景讀取（不阻塞表格渲染）；結果有快取，改格子重畫統計不會再打資料庫
  fetchLeaveSum(emp.name).then(s => {
    const el = document.getElementById(leaveHtmlId);
    if(!el) return;
    // 未建特休（完全沒有 batch 資料）與有建但剩 0 天分開顯示
    const annualPart = s.noAnnual
      ? '<span style="color:#94a3b8;">未建特休</span>'
      : `<span style="color:#7c3aed;font-weight:700;">🏖️特${s.annual}天</span>`;
    // 補休顯示「現在可以用的」：還沒過的國定假日補休另外標，避免店長照著排出負數
    const compTip = s.pending.length ? ` title="另有國定假日補休：${caPendingText(s.pending)}"` : '';
    const compPart = `<span style="color:${s.comp < 0 ? '#d93025' : '#0891b2'};font-weight:700;margin-left:4px;"${compTip}>🗓️補${s.comp}天</span>`
      + (s.pending.length ? `<span style="color:#94a3b8;margin-left:2px;"${compTip}>+${s.pendingDays}待生效</span>` : '');
    el.innerHTML = annualPart + compPart;
  }).catch(()=>{});

  if(isPartTime) {
    const wage = parseFloat(emp.wage || 0);
    const ms = monthStats[currentMonthKey];
    const mLabel = weekMonForStats.getMonth()+1 + "月";
    const salary = Math.round(ms.h * wage);
    const salColor = salary >= 18000 ? '#d93025' : '#34a853';
    html = `<div style="font-size:11px; line-height:1.8;">`;
    html += `<b>週時:${r10(wH)}h</b><br>`;
    html += `${mLabel}時: ${r10(ms.h)}h<br>`;
    if(wage > 0) html += `<span style="color:${salColor};">(估:$${salary.toLocaleString()})</span><br>`;
    html += leavePlaceholder;
    html += `</div>`;

  } else if(isFullTime) {
    const ms = monthStats[currentMonthKey];
    const mLabel = weekMonForStats.getMonth()+1 + "月";
    const offColor = wOff >= 2 ? '#34a853' : '#d93025';
    const offLabel = wOff >= 2 ? '達標' : '不足';
    const otColor = ms.ot > 0 ? '#d93025' : '#64748b';
    html = `<div style="font-size:11px; line-height:1.8;">`;
    html += `<b>週休:${wOff}天 <span style="color:${offColor};">(${offLabel})</span></b><br>`;
    html += `${mLabel}已休:${ms.off||0}天<br>`;
    html += `${mLabel}加班: <span style="color:${otColor};font-weight:${ms.ot>0?900:400};">${r10(ms.ot)}h</span><br>`;
    html += leavePlaceholder;
    html += `</div>`;

  } else {
    html = `<div style="font-size:11px;">本週: ${r10(wH)}h<br>${leavePlaceholder}</div>`;
  }
  t.innerHTML = html;
}

// ===== 記憶體同步 =====
function syncUIToMemory() {
  const selWeek=document.getElementById('weekSelector').value;
  document.querySelectorAll('.cell-btn').forEach(btn=>{
    // 🌟 跨店支援「整日外派」的格子是即時衍生顯示（loc=支援X），不可落地存成本店記錄（否則又生出雙軌 set#1）
    if(String(btn.dataset.loc||'').startsWith('支援')) return;
    // ✅ 以「格子自己的週」為準（非全域 selector），避免換週瞬間把畫面資料標成新週而覆蓋他週
    const week=btn.dataset.week||selWeek;
    const idx=appData.records.findIndex(r=>r.name===btn.dataset.emp&&r.day===btn.dataset.day&&r.week===week);
    const data={ week, day:btn.dataset.day, name:btn.dataset.emp, shift:btn.dataset.shift||'', location:btn.dataset.loc||'本店', note:btn.dataset.note||'', actualHours:parseFloat(btn.dataset.hours||0), isOT:btn.dataset.ot==='true', isHourly:btn.dataset.hourly==='true', supportEmp:btn.dataset.support||'', approvalStatus:btn.dataset.approval||'', supportUpdatedAt:btn.dataset.supportat||'', requestOff:btn.dataset.reqoff==='true', lawOverrides: btn.dataset.lawoverrides ? JSON.parse(btn.dataset.lawoverrides) : [], ...(btn.dataset.draft==='true' ? { draft:true } : {}) };
    const hasData=btn.dataset.shift||btn.dataset.note||btn.dataset.ot==='true'||btn.dataset.support||btn.dataset.reqoff==='true';
    if(hasData) { if(idx!==-1) appData.records[idx]=data; else appData.records.push(data); }
    else { if(idx!==-1) appData.records.splice(idx,1); }
  });
  document.querySelectorAll('.note-input').forEach(inp=>{
    const day=inp.dataset.day, val=inp.value;
    const week=inp.dataset.week||selWeek; // 同上：以備註格自己的週為準
    const idx=appData.records.findIndex(r=>r.name==='門市備註'&&r.day===day&&r.week===week);
    if(val) { if(idx!==-1) appData.records[idx].note=val; else appData.records.push({week,day,name:'門市備註',shift:'',location:'',note:val,actualHours:0,isOT:false}); }
    else { if(idx!==-1) appData.records.splice(idx,1); }
  });
}

// ===== Undo =====
function pushToUndo(btn) {
  undoStack.push({ btn, s:btn.dataset.shift, h:btn.dataset.hours, l:btn.dataset.loc, n:btn.dataset.note, ot:btn.dataset.ot, supp:btn.dataset.support, app:btn.dataset.approval, reqOff:btn.dataset.reqoff, lo:btn.dataset.lawoverrides, dr:btn.dataset.draft||'' });
  if(undoStack.length>30) undoStack.shift();
}
function undoLastAction() {
  if(!undoStack.length) { showToast('沒有可回復的動作'); return; }
  const l=undoStack.pop();
  const fromShift=l.btn.dataset.shift||''; // 回復前的班別
  l.btn.dataset.shift=l.s; l.btn.dataset.hours=l.h; l.btn.dataset.loc=l.l; l.btn.dataset.note=l.n;
  l.btn.dataset.ot=l.ot; l.btn.dataset.support=l.supp; l.btn.dataset.approval=l.app; l.btn.dataset.reqoff=l.reqOff; l.btn.dataset.lawoverrides=l.lo||''; l.btn.dataset.draft=l.dr||'';
  // 🌟 undo 也要同步特休/補休扣還（否則回復班別後假別對不上）
  if(fromShift!==(l.s||'')) deductLeave(l.btn.dataset.emp, l.btn.dataset.day, document.getElementById('weekSelector').value, fromShift, l.s||'');
  syncUIToMemory(); renderSchedule(); triggerAutoSave();
}

// ===== 待補欄位 =====
function addVirtualRow() {
  syncUIToMemory();
  let n=1;
  while(virtualRowNames.includes('🆘待補'+n)) n++;
  virtualRowNames.push('🆘待補'+n);
  renderSchedule();
  triggerAutoSave();
}
function deleteVirtualRow(name) {
  if(!confirm(`確定刪除 ${name}？`)) return;
  const week=document.getElementById('weekSelector').value;
  appData.records=appData.records.filter(r=>!(r.name===name&&r.week===week));
  virtualRowNames=virtualRowNames.filter(n=>n!==name);
  renderSchedule();
  triggerAutoSave();
}

// ===== 跨店支援審核 =====
function openApprovalModal(encodedReq) {
  const req=JSON.parse(decodeURIComponent(encodedReq));
  document.getElementById('approvalData').value=encodedReq;
  const supportEmpName = req.supportEmp?.split('-')[1] || '';
  document.getElementById('approvalDesc').innerHTML=
    `<strong>${req._store}</strong> 提出跨店支援請求：<br><br>
    <span style="font-size:22px; font-weight:900; color:var(--primary);">${getDisplayName(supportEmpName)}</span><br>
    於 <strong>${req.day} ${req.shift}</strong> 前往支援`;
  openModal('approvalModal');
}
async function handleApproval(isApproved) {
  const req=JSON.parse(decodeURIComponent(document.getElementById('approvalData').value));
  showLoading('處理中...');
  try {
    const docRef=window.db.collection('stores').doc(req._store).collection('weeks').doc(req.week);
    let done=false, stale=false;
    // 交易：交易內重讀，只在「這筆申請仍存在(supportEmp 未變)」時才寫，避免與他店/自動存檔互相覆蓋
    await window.db.runTransaction(async (tx)=>{
      done=false; stale=false; // 每次重試都重置
      const snap=await tx.get(docRef);
      if(!snap.exists){ stale=true; return; }
      const records=snap.data().records||[];
      const idx=records.findIndex(r=>r.name===req.name&&r.day===req.day&&r.shift===req.shift&&(r.supportEmp||'')===(req.supportEmp||''));
      if(idx===-1){ stale=true; return; } // 已被取消/變更 → 不動作
      if(isApproved) records[idx].approvalStatus='approved';
      else { records[idx].supportEmp=''; records[idx].approvalStatus=''; } // 拒絕→清空→退回開放缺口
      tx.update(docRef,{ records });
      done=true;
    });
    if(!done){
      showToast(stale ? '⚠️ 這筆申請已被取消或變更，請重新整理' : '⚠️ 處理未完成，請重試');
      closeModal('approvalModal'); await fetchAllStoreData(); hideLoading(); return;
    }
    showToast(isApproved?'✅ 已同意支援':'已拒絕支援');
    closeModal('approvalModal');
    await fetchAllStoreData();
  } catch(e) { showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

// ===== 跨店待補看板（開缺口 → 別店認領）=====
let _supportGaps = [];
const _OFF_SHIFTS = ['排休','指休','特休','補休','清空',''];

// 「請求支援」按鈕：只有其他門市當週有開放缺口時才顯示（紅色系醒目）
function updateCrossGapBtn() {
  const btn = document.getElementById('crossGapBtn');
  if(!btn) return;
  const weekStr = document.getElementById('weekSelector')?.value;
  const n = (appData.crossStoreGaps||[]).filter(g => g.week === weekStr).length;
  if(n > 0) { btn.style.display = 'flex'; btn.textContent = `🆘 請求支援 ${n}`; }
  else { btn.style.display = 'none'; }
}

async function openSupportBoard() {
  const weekStr = document.getElementById('weekSelector').value;
  if(!weekStr){ showToast('請先選擇週次'); return; }
  showLoading('讀取各店待補缺口...');
  try {
    const stores = (appConfig.stores||[]);
    const dates = getWeekDates(weekStr); // ['M/D'...] 對應 dayNames(週一..週日)
    _supportGaps = [];
    await Promise.all(stores.map(s =>
      window.db.collection('stores').doc(s).collection('weeks').doc(weekStr).get()
        .then(snap => {
          if(!snap.exists) return;
          (snap.data().records||[]).forEach(r => {
            if(!r || !String(r.name||'').startsWith('🆘待補')) return;              // 只看待補格
            if(!r.shift || _OFF_SHIFTS.includes(String(r.shift).trim())) return;     // 要有實際班別
            if(r.supportEmp) return;                                                 // 已指定/認領/申請中 → 非開放
            _supportGaps.push({ store:s, week:weekStr, name:r.name, day:r.day, shift:r.shift, note:r.note||'' });
          });
        }).catch(()=>{})
    ));
    document.getElementById('supportBoardWeekLbl').textContent = `📅 ${weekStr}　${dates[0]}～${dates[6]}`;
    renderSupportBoard();
    openModal('supportBoardModal');
  } catch(e) { showToast('❌ 讀取失敗：'+e.message); }
  hideLoading();
}

function renderSupportBoard() {
  const myViewStore = document.getElementById('storeSelector').value;
  const el = document.getElementById('supportBoardList');
  const gaps = _supportGaps.filter(g => g.store !== myViewStore); // 本店缺口自己排即可，看板只列他店
  if(!gaps.length){ el.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);">目前其他門市沒有開放中的待補缺口 🎉</div>`; return; }
  gaps.sort((a,b)=> a.store.localeCompare(b.store) || dayNames.indexOf(a.day)-dayNames.indexOf(b.day));
  el.innerHTML = gaps.map(g => {
    const enc = encodeURIComponent(JSON.stringify(g));
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;">
      <div style="flex:1 1 auto;min-width:0;">
        <div style="font-weight:800;font-size:14px;line-height:1.4;">🏪 ${g.store}　${g.day}　<span style="color:var(--primary);">${g.shift}</span></div>
        ${g.note?`<div style="font-size:12px;color:var(--text-muted);margin-top:2px;word-break:break-word;">📝 ${g.note}</div>`:''}
      </div>
      <button class="tool-btn" style="flex:0 0 auto;background:#0369a1;color:#fff;padding:8px 16px;" onclick="openClaimGap('${enc}')">支援</button>
    </div>`;
  }).join('');
}

async function openClaimGap(enc) {
  const g = JSON.parse(decodeURIComponent(enc));
  document.getElementById('claimGapData').value = enc;
  document.getElementById('claimGapDesc').innerHTML =
    `派人前往 <strong>${g.store}</strong> 支援：<br>
     <span style="font-size:18px;font-weight:900;color:var(--primary);">${g.day}　${g.shift}</span>
     ${g.note?`<br><span style="font-size:12px;color:var(--text-muted);">📝 ${g.note}</span>`:''}`;
  const perm = currentUser.permission;
  const canPickStore = (perm==='admin' || perm==='owner');
  const storeGroup = document.getElementById('claimStoreGroup');
  const storeSel = document.getElementById('claimStoreSel');
  if(canPickStore){
    storeGroup.style.display='block';
    storeSel.innerHTML = (appConfig.stores||[]).filter(s=>s!==g.store).map(s=>`<option value="${s}">${s}</option>`).join('');
  } else {
    storeGroup.style.display='none';
    storeSel.innerHTML = `<option value="${currentUser.store}">${currentUser.store}</option>`;
  }
  await onClaimStoreChange();
  openModal('claimGapModal');
}

async function onClaimStoreChange() {
  const g = JSON.parse(decodeURIComponent(document.getElementById('claimGapData').value));
  const fromStore = document.getElementById('claimStoreSel').value;
  const empSel = document.getElementById('claimEmpSel');
  const hint = document.getElementById('claimGapHint');
  empSel.innerHTML = `<option value="">讀取中...</option>`; hint.textContent='';
  let recs = [];
  try { const snap = await window.db.collection('stores').doc(fromStore).collection('weeks').doc(g.week).get(); if(snap.exists) recs = snap.data().records||[]; } catch(e){}
  let emps = (fromStore === document.getElementById('storeSelector').value)
    ? (appData.employees||[]).map(e=>e.name)
    : (appData.allStoresEmployees[fromStore] || []);
  emps = emps.filter(n => n && !String(n).startsWith('🆘'));
  const busyShift = {}; // 當日已排者 → 班別（分割日/跨時段支援仍可派，只提醒確認不衝突）
  recs.forEach(r => { if(r.day===g.day && r.name && r.shift && !_OFF_SHIFTS.includes(String(r.shift).trim())) busyShift[r.name]=r.shift; });
  if(!emps.length){ empSel.innerHTML = `<option value="">（${fromStore} 無可派員工）</option>`; hint.textContent=''; return; }
  const freeE = emps.filter(n=>!busyShift[n]);
  const busyE = emps.filter(n=>busyShift[n]);
  empSel.innerHTML = freeE.map(n=>`<option value="${n}">${getDisplayName(n)}</option>`).join('')
    + busyE.map(n=>`<option value="${n}">${getDisplayName(n)}（當日已排「${busyShift[n]}」，請確認不衝突）</option>`).join('');
  hint.textContent = `${fromStore} ${g.day}：可派 ${freeE.length} 位未排班；另 ${busyE.length} 位當日已排班（分割日/跨時段仍可派，請自行確認時間不衝突）。`;
}

async function confirmClaimGap() {
  const g = JSON.parse(decodeURIComponent(document.getElementById('claimGapData').value));
  const fromStore = document.getElementById('claimStoreSel').value;
  const emp = document.getElementById('claimEmpSel').value;
  if(!emp){ showToast('請選擇支援人員'); return; }
  if(!confirm(`確定派「${getDisplayName(emp)}」（${fromStore}）於 ${g.day} ${g.shift} 前往 ${g.store} 支援？`)) return;
  showLoading('安排支援中...');
  try {
    const docRef = window.db.collection('stores').doc(g.store).collection('weeks').doc(g.week);
    let claimed=false;
    // 交易：交易內重讀，只在「缺口仍開放(supportEmp 仍為空)」時才寫，避免與他店支援/A店取消或存檔互相覆蓋
    await window.db.runTransaction(async (tx)=>{
      claimed=false; // 每次重試都重置
      const snap=await tx.get(docRef);
      if(!snap.exists) return;
      const records=snap.data().records||[];
      const idx=records.findIndex(r => r.name===g.name && r.day===g.day && r.shift===g.shift && !r.supportEmp);
      if(idx===-1) return; // 缺口已被搶先支援/被取消/已異動 → 不動作
      records[idx].supportEmp = `${fromStore}-${emp}`;
      records[idx].approvalStatus = 'approved';
      records[idx].claimedBy = fromStore; // 供 onSupportRequest 發「已被支援」通知給缺工店
      records[idx].supportUpdatedAt = new Date().toISOString(); // 跨店異動時間戳，供合併存檔判新舊
      tx.update(docRef,{ records });
      claimed=true;
    });
    if(!claimed){
      showToast('⚠️ 此缺口已被搶先支援或已異動，請重新開啟看板');
      closeModal('claimGapModal'); closeModal('supportBoardModal'); await fetchAllStoreData(); hideLoading(); return;
    }
    showToast('✅ 已排定支援');
    closeModal('claimGapModal');
    closeModal('supportBoardModal');
    await fetchAllStoreData();
  } catch(e) { showToast('❌ 安排支援失敗：'+e.message); }
  hideLoading();
}

// ===== 畫休紀錄 =====
async function openLogModal() {
  openModal('logModal');
  await loadLogs();
}


// ⚠️ calcCanvasLines / canvasDrawWrappedText / drawScheduleCanvas 已移到 schedule-draw.js（共用給盤點資料頁）。
//    schedule-V2.html 已載入該檔，呼叫方式不變。



// ===== 共用產圖核心（黑白版）=====

// ===== 產圖（管理者用）=====
function exportImage() {
  syncUIToMemory();
  showLoading('產生圖片中...');
  setTimeout(() => {
    try {
      const store = document.getElementById('storeSelector').value;
      const weekStr = document.getElementById('weekSelector').value;
      const emps = [...appData.employees];
      virtualRowNames.forEach(n => emps.push({ name: n, role: '待補' }));

      // 直接用本店記錄，跨店支援由 drawScheduleCanvas 內部處理
      const processedRecords = appData.records.filter(r => r.week === weekStr);

      const canvas = document.createElement('canvas');
      drawScheduleCanvas(canvas, store, weekStr, processedRecords, emps, currentWeekDates, appData.allStoresRecords);

      const img = document.getElementById('previewImg');
      img.src = canvas.toDataURL('image/jpeg', 0.95);
      document.getElementById('downloadBtn').onclick = () => {
        const a = document.createElement('a');
        a.href = img.src;
        a.download = `${store}_班表_${weekStr}.jpg`;
        a.click();
      };
      openModal('imgModal');
      hideLoading();
    } catch(e) { alert('產圖失敗：' + e); hideLoading(); }
  }, 100);
}


if('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        console.log('[PWA] Service Worker 已註冊');
        // 有新版本時提示用戶
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if(newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // 有新版本，靜默更新
              newWorker.postMessage('SKIP_WAITING');
              window.location.reload();
            }
          });
        });
      })
      .catch(err => console.warn('[PWA] SW 註冊失敗:', err));
  });
}
