// 首頁之三：登入後的各種提醒與關卡（經營績效待填、到職日補填、損益異常、薪資簽收、劃休提醒、維護公告、系統公告）。2026-10-16 從 home-page.js 原封不動切出來（整理第 4 階段）。

// ===== 薪資待簽收提醒（步驟4）=====
const SALARY_ACK_START = '2026-06'; // 與 my-salary.html 同值
function _ackMonthsFromStart(){
  const now=new Date();
  const cur=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const out=[]; let [y,m]=SALARY_ACK_START.split('-').map(Number);
  // 只納入「已可查看」月份：M 月薪資要 M+1 月才可看，故排除當月(cur)
  for(let i=0;i<60;i++){ const ym=`${y}-${String(m).padStart(2,'0')}`; if(ym>=cur) break; out.push(ym); m++; if(m>12){m=1;y++;} }
  return out;
}
// 經營績效發送日推算(對齊 functions pnlSendDay)：從1號數工作日(跳週末+國定假日)，第3工作天隔一日曆天=公司提供報表日
function pnlSendDayClient(year, month, holidays){
  let count=0;
  for(let day=1; day<=40; day++){
    const dateStr=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dow=new Date(year, month-1, day).getDay(); // 0=日..6=六（本機=台北）
    if(dow===0||dow===6||holidays[dateStr]) continue;
    count++;
    if(count===3) return day+1;
  }
  return 4;
}
// 經營績效待輸入提醒（店長以上）：本店在 2025/07~上月 有未輸入者 → 顯示橫幅
async function checkPnlPending(){
  try{
    if(!['manager','owner','admin'].includes(currentUser?.permission)) return;
    const store = currentUser.store;
    if(!store) return;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), 1); d.setMonth(d.getMonth()-1); // 上個月
    const months=[]; let cy=d.getFullYear(), cm=d.getMonth()+1;
    while(cy>2025 || (cy===2025 && cm>=7)){ months.push(`${cy}-${String(cm).padStart(2,'0')}`); cm--; if(cm<1){cm=12;cy--;} }
    // 上月資料在「公司提供報表日的隔天」後才算待輸入(對齊 LINE 排程 provideDay+1)
    let _holidays={};
    try{ const hs=await window.db.collection('settings').doc('holidays').collection('years').doc(String(now.getFullYear())).get(); if(hs.exists && hs.data().dates) _holidays=hs.data().dates; }catch(e){}
    const _provideDay=pnlSendDayClient(now.getFullYear(), now.getMonth()+1, _holidays);
    if(now.getDate() < _provideDay+1 && months.length) months.shift();
    if(!months.length) return;
    const snap = await window.db.collection('stores').doc(store).collection('pnl').get();
    const have = new Set(); snap.forEach(x=>have.add(x.id));
    const missing = months.filter(m=>!have.has(m));
    if(!missing.length) return;
    const bar = document.getElementById('pnlPendingBanner');
    if(!bar) return;
    document.getElementById('pnlPendingMonths').textContent = missing.length===1
      ? missing[0].replace('-','年')+'月'
      : `${missing.length} 個月`;
    bar.style.display = 'flex';
  }catch(e){ console.error('checkPnlPending', e); }
}
// ===== 店長登入：補齊員工到職日（強制，Feature②）=====
let _hireGateStore = '';
async function checkHireDateGate(){
  try{
    if(!['manager','owner','admin'].includes(currentUser?.permission)) return;
    const store = currentUser.store;
    if(!store) return;
    _hireGateStore = store;
    const empSnap = await window.db.collection('stores').doc(store).collection('employees').get().catch(()=>null);
    if(!empSnap) return;
    const todayStr = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
    const cy = new Date().getFullYear().toString();
    const candidates = [];
    empSnap.forEach(d=>{
      const data = d.data();
      if(['離職','調走'].includes(data.status)) return;
      // 需處理：缺 startDate，或被標記為「待確認」(建檔日預設值等)
      const needsReview = !data.startDate || data.startDateConfirmed === false;
      if(!needsReview) return;
      candidates.push({ name: d.id, startDate: data.startDate||'', confirmed: data.startDateConfirmed, transferDate: data.transferDate||'' });
    });
    if(!candidates.length) return;
    // 缺 startDate 但有可用日期且非待確認 → 靜默同步(調店員工用調入日、否則用到職日)；其餘(待確認/完全無)→ 列給店長核對
    const need = [];
    await Promise.all(candidates.map(async c=>{
      const lv = await window.db.collection('employees').doc(c.name).collection('leaves').doc(cy).get().catch(()=>null);
      const hire = (lv && lv.exists && lv.data().hireDate) ? lv.data().hireDate : '';
      const autoDate = c.transferDate || hire; // 調店進來的以調入日為本店薪資起算，不用到職日
      if(!c.startDate && autoDate && c.confirmed !== false){
        await window.db.collection('stores').doc(store).collection('employees').doc(c.name).set({ startDate: autoDate }, { merge:true });
      } else {
        need.push({ name: c.name, prefill: c.startDate || autoDate || todayStr }); // 待確認 或 完全無到職日
      }
    }));
    if(!need.length) return;
    document.getElementById('hireGateList').innerHTML = need.map(n=>{
      const dn = displayNameMap[n.name] || n.name;
      return `<div style="display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid #eef1f4;">
        <span style="flex:1; font-weight:700; font-size:15px;">${dn}</span>
        <input type="date" data-emp="${n.name.replace(/"/g,'&quot;')}" value="${n.prefill}" style="padding:8px; border:1.5px solid #d0d7de; border-radius:8px; font-size:14px;">
      </div>`;
    }).join('');
    openModal('hireDateGateModal');
  }catch(e){ console.error('checkHireDateGate', e); }
}
async function saveHireDateGate(){
  const inputs = [...document.querySelectorAll('#hireGateList input[data-emp]')];
  if(!inputs.length){ closeModal('hireDateGateModal'); return; }
  if(inputs.some(i=>!i.value)){ showToast('⚠️ 請確認每位員工的到職日都已填寫'); return; }
  showLoading('儲存到職日中...');
  try{
    const cy = new Date().getFullYear().toString();
    for(const i of inputs){
      const emp = i.dataset.emp, date = i.value;
      await window.db.collection('stores').doc(_hireGateStore).collection('employees').doc(emp).set({ startDate: date, startDateConfirmed: true }, { merge:true });
      await window.db.collection('employees').doc(emp).collection('leaves').doc(cy).set({ hireDate: date, store:_hireGateStore }, { merge:true });
    }
    hideLoading();
    closeModal('hireDateGateModal');
    showToast('✅ 已補齊到職日');
  }catch(e){ hideLoading(); showToast('❌ 儲存失敗：'+e.message); }
}
// ===== 經營績效資料異常提醒（店長登入）=====
let _pnlAnomalyMonths=[];
async function checkPnlAnomaly(){
  try{
    if(!['manager','owner','admin'].includes(currentUser?.permission)) return;
    const store = currentUser.store;
    if(!store) return;
    const snap = await window.db.collection('stores').doc(store).collection('pnl').get().catch(()=>null);
    if(!snap) return;
    const bad=[];
    snap.forEach(d=>{ const data=d.data()||{}; const ns=Number(data.netSales); if(ns && ns>10000000 && !data.netSalesAnomalyAck) bad.push({ id:d.id, ns }); });
    if(!bad.length) return;
    _pnlAnomalyMonths=bad;
    const rows=bad.map(b=>{
      const y=b.id.split('-')[0], mo=parseInt(b.id.split('-')[1]);
      const suggest=Math.round(b.ns/10);
      return `<div style="background:#fff5f5; border-left:3px solid #d93025; border-radius:6px; padding:8px 10px; margin-top:8px;">
        <b>${y}年${mo}月</b>：營業淨額登記為 <b style="color:#c5221f;">${b.ns.toLocaleString()}</b> 元，明顯多打一位數（其他月份約 360～400 萬），推估正確值約 <b>${suggest.toLocaleString()}</b> 元。</div>`;
    }).join('');
    document.getElementById('pnlAnomalyBody').innerHTML =
      `系統偵測到「${store}」的經營績效資料異常，此錯誤會拉高年度趨勢與同期比較，請確認並修正：${rows}
       <div style="font-size:12px; color:var(--text-muted); margin-top:10px;">點「前往修正」到經營績效專區編輯該月數字；或「我已確認」暫不再提醒（修正後也會自動停止）。</div>`;
    openModal('pnlAnomalyModal');
  }catch(e){ console.error('checkPnlAnomaly', e); }
}
async function ackPnlAnomaly(){
  try{
    const store=currentUser.store;
    for(const b of _pnlAnomalyMonths){
      await window.db.collection('stores').doc(store).collection('pnl').doc(b.id)
        .set({ netSalesAnomalyAck:true, netSalesAnomalyAckBy:(currentUser.displayName||currentUser.empName||''), netSalesAnomalyAckAt:new Date().toISOString() }, { merge:true });
    }
  }catch(e){}
  closeModal('pnlAnomalyModal');
  showToast('已確認，將不再提醒');
}
async function checkSalaryAck(){
  try{
    if(!currentUser?.uid || !currentUser?.empName) return;
    const myStore=currentUser.store;
    const pending=[];
    const _now=new Date();
    const _nowYM=`${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}`;
    const _nowDay=_now.getDate(), _nowHour=_now.getHours();
    // 發薪提醒日：5號遇週末/國定假日順延到下一工作日；當天 15:00 後才提醒(對齊 LINE)
    let _shol={};
    try{ const hs=await window.db.collection('settings').doc('holidays').collection('years').doc(String(_now.getFullYear())).get(); if(hs.exists && hs.data().dates) _shol=hs.data().dates; }catch(e){}
    let _remDay=5; for(let day=5;day<=20;day++){ const ds=`${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`; const dow=new Date(_now.getFullYear(),_now.getMonth(),day).getDay(); if(dow!==0&&dow!==6&&!_shol[ds]){_remDay=day;break;} }
    const _months=_ackMonthsFromStart().filter(ym=>{
      const [_yy,_mm]=ym.split('-').map(Number);
      const _payYM=_mm===12?`${_yy+1}-01`:`${_yy}-${String(_mm+1).padStart(2,'0')}`;
      return !(_payYM===_nowYM && (_nowDay<_remDay || (_nowDay===_remDay && _nowHour<15)));
    });
    if(!_months.length){ renderSalaryAckBanner([]); return; }
    // 「全部已簽」當天記住，不再每次打開首頁都呼叫 getMySalary（2026-10-15：一週 1,981 次，幾乎都是已簽完的人）。
    // 只記到當天：薪資更正後重新發布（payHash 變了要重簽）最晚隔天會再提醒；有待簽月份不記，照舊每次查。
    const _ackKey='salAckOk:'+currentUser.uid, _today=`${_nowYM}-${String(_nowDay).padStart(2,'0')}`;
    try{ const c=JSON.parse(localStorage.getItem(_ackKey)||'null'); if(c && c.day===_today && c.months===_months.join(',')){ renderSalaryAckBanner([]); return; } }catch(e){}
    // 找本人在各月「已發布」的薪資記錄（先本店，找到就停）。
    // 2026-10-10 薪資規則收緊：員工不能直接讀 salary 文件，改由 getMySalary 只回本人那筆。
    const _fn=firebase.app().functions('asia-east1').httpsCallable('getMySalary');
    const _res=await _fn({ months:_months, prefer:myStore, publishedOnly:true });
    const _byYM={}; ((_res.data||{}).items||[]).forEach(it=>{ if(it && it.rec) _byYM[it.ym]=it.rec; });
    for(const ym of _months){
      const rec=_byYM[ym];
      if(!rec) continue; // 該月無已發布記錄 → 不提醒
      const ackSnap=await window.db.collection('salaryAck').doc(`${currentUser.uid}_${ym}`).get().catch(()=>null);
      const ack=ackSnap && ackSnap.exists ? ackSnap.data() : null;
      const signed = ack && (ack.signedPayHash||'')===(rec.payHash||'');
      if(!signed) pending.push(ym);
    }
    try{ if(pending.length) localStorage.removeItem(_ackKey); else localStorage.setItem(_ackKey, JSON.stringify({ day:_today, months:_months.join(',') })); }catch(e){}
    renderSalaryAckBanner(pending);
  }catch(e){ console.error('checkSalaryAck 失敗', e); }
}
function renderSalaryAckBanner(pending){
  const bar=document.getElementById('salaryAckBanner');
  if(!bar) return;
  if(!pending.length){ bar.style.display='none'; return; }
  document.getElementById('salaryAckMonths').textContent = pending.map(m=>m.replace('-','/')).join('、');
  bar.dataset.month = pending[0];
  bar.style.display='flex';
}
function gotoSalaryAck(){
  const m=document.getElementById('salaryAckBanner')?.dataset.month||'';
  window.location.href='my-salary.html'+(m?`?month=${m}`:'');
}

// ===== 首頁劃休提醒（鼓勵、可關、有劃自動消失）=====
// 截止規則與 leave-request 一致：目標週的申請截止 = 前一週週一 23:59。
// 故提示鎖定「目前仍開放中的最早一週」（下週常已截止），並顯示其區間與截止時間。
const _weekStrOf = weekStrOfDate;
function _firstOpenLeaveWeek(){
  const now=new Date();
  const t=new Date(); const day=t.getDay(); // 0=Sun
  const thisMon=new Date(t); thisMon.setDate(t.getDate()-((day+6)%7)); thisMon.setHours(0,0,0,0);
  for(let off=1; off<=4; off++){
    const mon=new Date(thisMon); mon.setDate(thisMon.getDate()+off*7);
    const deadline=new Date(mon); deadline.setDate(mon.getDate()-7); deadline.setHours(23,59,59,0);
    if(now<=deadline){
      const sun=new Date(mon); sun.setDate(mon.getDate()+6);
      return { weekStr:_weekStrOf(mon), mon, sun, deadline };
    }
  }
  return null;
}
async function checkLeaveHint(){
  try{
    if(!currentUser?.empName || !currentUser?.store) return;
    const bar=document.getElementById('leaveHintBanner'); if(!bar) return;
    const info=_firstOpenLeaveWeek();
    if(!info){ bar.style.display='none'; return; } // 目前無開放中的劃休週
    const wk=info.weekStr;
    bar.dataset.week=wk;
    if(localStorage.getItem('leaveHintDismissed_'+wk)==='1'){ bar.style.display='none'; return; } // 本人已關該週
    // 本人該週是否已有劃休（含排休/特休/補休）
    const snap=await window.db.collection('stores').doc(currentUser.store).collection('leaveRequests')
      .where('empName','==',currentUser.empName).get().catch(()=>null);
    const has = snap && snap.docs.some(d=>{ const r=d.data(); return r.week===wk && !['cancelled','unfulfilled'].includes(r.status); });
    if(has){ bar.style.display='none'; return; }
    const md=x=>`${x.getMonth()+1}/${x.getDate()}`;
    const dow=['日','一','二','三','四','五','六'][info.deadline.getDay()];
    const el=document.getElementById('leaveHintText');
    if(el) el.textContent = `${md(info.mon)}–${md(info.sun)} 可劃休・${md(info.deadline)}（${dow}）截止`;
    bar.style.display='flex';
  }catch(e){ console.error('checkLeaveHint 失敗', e); }
}
async function dismissLeaveHint(){
  const bar=document.getElementById('leaveHintBanner');
  if(!bar) return;
  const wk=bar.dataset.week||'';
  localStorage.setItem('leaveHintDismissed_'+wk,'1');
  bar.style.display='none';
  // 2026-09-23：原本這裡會同步寫 stores/{店}/leaveDismiss 給「劃休截止提醒」排程判斷誰打過 X，
  // 但那支排程已於 2026-09-07 整支移除（劃休提醒改由首頁提醒統一處理），沒有任何人讀這份資料
  // → 移除這筆寫入。關閉提醒仍靠上面的 localStorage，行為不變。
}

// ===== LINE 通知綁定 =====
// 2026-09-23：☰ 的「LINE 通知綁定」入口已移除（帳號管理頁的「🔔 LINE 通知」卡片就有完整的
// 綁定時間／測試／解除綁定，見 employee-mgmt-page.js renderLineCard），首頁這份綁定 UI 一併刪掉，
// 也省下每次進首頁為了決定要不要顯示那個選單項而讀一次 lineBindings 的成本。

// ===== 初始化 APP =====
// ===== 系統維護模式 =====
async function checkMaintenance() {
  const mt = document.getElementById('maintenanceScreen');
  if(currentUser?.permission === 'admin') { if(mt) mt.style.display = 'none'; return false; } // 管理者不受影響
  let on = false;
  try { const d = await window.db.collection('settings').doc('maintenance').get(); on = !!(d.exists && d.data().enabled); } catch(e) {}
  if(!on) { if(mt) mt.style.display = 'none'; return false; }
  document.getElementById('appShell').classList.remove('active');
  await renderMaintenanceNotifyState();
  document.getElementById('maintenanceScreen').style.display = 'flex';
  hideLoading();
  return true;
}
async function renderMaintenanceNotifyState() {
  const uid = currentUser.uid;
  const nameEl = document.getElementById('mtName');
  if(nameEl) nameEl.textContent = '👤 ' + (currentUser.displayName || currentUser.empName || '');
  let opted = false, bound = false, pushOn = false;
  try { const b = await window.db.collection('lineBindings').doc(uid).get(); bound = !!(b.exists && b.data().lineUserId); } catch(e) {}
  try { const n = await window.db.collection('maintenanceNotify').doc(uid).get(); opted = n.exists; } catch(e) {}
  try { pushOn = typeof hpGetSubscription === 'function' && !!(await hpGetSubscription()); } catch(e) {}
  // 通知走推播優先、LINE 補位（onMaintenanceEnded → deliverToPeople）；2026-09-15 起不再引導綁 LINE
  const reachable = pushOn || bound;
  const bindBtn = document.getElementById('mtBindBtn');
  const btn = document.getElementById('mtNotifyBtn'), hint = document.getElementById('mtNotifyHint');
  if(bindBtn) bindBtn.style.display = reachable ? 'none' : 'block';
  if(opted) {
    btn.textContent = '✅ 已登記，完成後通知你'; btn.disabled = true; btn.style.opacity = '.75';
    hint.textContent = pushOn ? '維護完成會推播通知你' : bound ? '維護完成會用 LINE 通知你' : '⚠️ 這台手機還沒開推播，完成時收不到通知，請點上方「開啟推播通知」';
  } else {
    btn.textContent = '🔔 維護完成後請通知我'; btn.disabled = false; btn.style.opacity = '1';
    hint.textContent = reachable ? '' : '（要收到通知，請先點上方「開啟推播通知」）';
  }
}
async function maintenanceNotifyMe() {
  const uid = currentUser.uid;
  try {
    await window.db.collection('maintenanceNotify').doc(uid).set({
      uid, empName: currentUser.empName || '', displayName: currentUser.displayName || currentUser.empName || '', store: currentUser.store || '', at: new Date().toISOString()
    }, { merge: true });
    showToast('✅ 已登記，維護完成會通知你');
    await renderMaintenanceNotifyState();
  } catch(e) { showToast('登記失敗：' + e.message); }
}

// ===== 系統公告彈窗（notices/{id}，active=true）=====
// 每次進首頁都跳；按「我知道了」才關，並記在 notices/{id}/reads/{uid}（首次時間、次數）供設定頁統計。
// 開啟維護模式、或超過 endAt 就不跳（維護時段可能提早，不寫死開始時間）。
// 內文用 **粗體** 標記；一律先跳脫再轉 <b>。
function noticeFmt(t) {
  return String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}
async function showSystemNotice() {
  try {
    const timeout = new Promise((res) => setTimeout(() => res(null), 8000)); // ⚠️ Firestore get 卡住不會 reject
    const res = await Promise.race([Promise.all([
      window.db.collection('notices').where('active', '==', true).limit(1).get(),
      window.db.collection('settings').doc('maintenance').get(),
    ]), timeout]);
    if(!res) return;
    const [ns, mt] = res;
    if(mt.exists && mt.data().enabled) return;
    if(ns.empty) return;
    const d = ns.docs[0], n = d.data();
    if(n.endAt && n.endAt.toMillis && n.endAt.toMillis() < Date.now()) return;
    if(document.getElementById('sysNoticeOverlay')) return;
    const el = document.createElement('div');
    el.id = 'sysNoticeOverlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9800;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    el.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="sysNoticeTitle" style="background:#fff;border-radius:18px;width:100%;max-width:420px;max-height:88vh;overflow-y:auto;padding:20px 18px 16px;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <div id="sysNoticeTitle" style="font-size:18px;font-weight:900;margin-bottom:10px;">${noticeFmt(n.title)}</div>
        ${(n.lead || []).map((l) => `<div style="font-size:14.5px;line-height:1.6;">${noticeFmt(l)}</div>`).join('')}
        ${(n.sections || []).map((sec) => `
          <div style="margin-top:14px;">
            <div style="font-size:13px;font-weight:900;color:var(--primary);margin-bottom:4px;">${noticeFmt(sec.heading)}</div>
            ${(sec.lines || []).map((l) => `<div style="font-size:13.5px;line-height:1.65;padding-left:12px;text-indent:-12px;">・${noticeFmt(l)}</div>`).join('')}
          </div>`).join('')}
        ${n.footer ? `<div style="font-size:13.5px;margin-top:14px;color:var(--text-muted);">${noticeFmt(n.footer)}</div>` : ''}
        <button id="sysNoticeOk" style="width:100%;margin-top:16px;padding:13px;border:none;border-radius:12px;background:var(--primary);color:#fff;font-size:15px;font-weight:800;cursor:pointer;">${noticeFmt(n.button || '我知道了')}</button>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('sysNoticeOk').onclick = () => ackSystemNotice(d.id);
  } catch(e) {
    console.warn('系統公告讀取失敗:', e);
  }
}
async function ackSystemNotice(id) {
  const btn = document.getElementById('sysNoticeOk');
  if(btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const FV = firebase.firestore.FieldValue;
    const ref = window.db.collection('notices').doc(id).collection('reads').doc(currentUser.uid);
    const write = (async () => {
      const cur = await ref.get();
      await ref.set({
        uid: currentUser.uid, empName: currentUser.empName || '', displayName: currentUser.displayName || '',
        store: currentUser.store || '', permission: currentUser.permission || '',
        lastAt: FV.serverTimestamp(), count: FV.increment(1),
        ...(cur.exists ? {} : { firstAt: FV.serverTimestamp() }),
      }, { merge: true });
    })();
    await Promise.race([write, new Promise((res) => setTimeout(res, 5000))]); // 網路差也要能關，不卡住打卡
  } catch(e) {
    console.warn('公告已讀紀錄失敗:', e);
  }
  const el = document.getElementById('sysNoticeOverlay');
  if(el) el.remove();
}
