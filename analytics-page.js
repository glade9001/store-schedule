// ===== 全域 =====
let currentUser = null, appConfig = { stores:[] };
let analysisData = null; // 快取
let displayNameMap = {}; // 短名 → app 顯示名(全名)
function dispName(n){ return displayNameMap[n] || n; }
const STORE_COLORS = ['#1a73e8','#34a853','#f9ab00','#9334e6','#d93025','#0891b2'];
let chartCostTrend = null, chartOtHoliday = null;

// ===== 工具 =====
const n = v => parseFloat(v)||0;
const comma = v => Math.round(n(v)).toLocaleString();
const showToast = msg => { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2800); };
const showLoading = msg => { document.getElementById('loadingOverlay').classList.remove('hidden'); document.getElementById('loadingText').textContent=msg||'載入中...'; };
const hideLoading = () => document.getElementById('loadingOverlay').classList.add('hidden');
const setProgress = (pct,msg) => {
  document.getElementById('progressBar').style.width=pct+'%';
  document.getElementById('progressText').textContent=msg;
};

// ===== 初始化 =====
window.onload = async () => {
  showLoading('驗證登入狀態...');
  const saved = localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser');
  if(!saved){ window.location.replace('home.html'); return; }
  try{ currentUser=JSON.parse(saved); }catch{ window.location.replace('home.html'); return; }
  const _fbAuth = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(fb => { u(); r(fb); }); });
  if (!_fbAuth) { localStorage.removeItem('currentUser'); sessionStorage.removeItem('currentUser'); window.location.replace('home.html'); return; }
  if(!['owner','admin'].includes(currentUser?.permission)){
    alert('⚠️ 此功能僅限加盟主以上權限');
    window.location.replace('home.html'); return;
  }
  try{
    const snap = await window.db.collection('settings').doc('globalConfig').get();
    if(snap.exists) appConfig = snap.data();
  }catch{}

  buildYearMonthSelects();
  hideLoading();
};

function buildYearMonthSelects(){
  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth()+1;
  const months = Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0'));

  ['selStartYear','selEndYear'].forEach(id => {
    const el = document.getElementById(id);
    for(let y=curY;y>=curY-3;y--)
      el.innerHTML += `<option value="${y}">${y}</option>`;
  });
  months.forEach(m => {
    document.getElementById('selStartMonth').innerHTML += `<option value="${m}">${parseInt(m)}月</option>`;
    document.getElementById('selEndMonth').innerHTML += `<option value="${m}">${parseInt(m)}月</option>`;
  });

  // 預設：近 3 個月
  const startM = curM - 2 <= 0 ? curM + 10 : curM - 2;
  const startY = curM - 2 <= 0 ? curY - 1 : curY;
  document.getElementById('selStartYear').value = startY;
  document.getElementById('selStartMonth').value = String(startM).padStart(2,'0');
  document.getElementById('selEndYear').value = curY;
  document.getElementById('selEndMonth').value = String(curM).padStart(2,'0');

  // 區間驗證
  ['selStartYear','selStartMonth','selEndYear','selEndMonth'].forEach(id =>
    document.getElementById(id).onchange = validateRange
  );
  validateRange();
}

function validateRange(){
  const sy=document.getElementById('selStartYear').value;
  const sm=document.getElementById('selStartMonth').value;
  const ey=document.getElementById('selEndYear').value;
  const em=document.getElementById('selEndMonth').value;
  const start = sy+'-'+sm, end = ey+'-'+em;
  if(start > end){
    document.getElementById('rangeHint').textContent = '⚠️ 起始月份不能晚於結束月份';
    document.getElementById('rangeHint').style.color = 'var(--danger)';
    document.getElementById('runBtn').disabled = true; return;
  }
  // 計算月數
  const months = (parseInt(ey)-parseInt(sy))*12 + parseInt(em)-parseInt(sm) + 1;
  if(months > 12){
    document.getElementById('rangeHint').textContent = '⚠️ 區間最長 12 個月';
    document.getElementById('rangeHint').style.color = 'var(--danger)';
    document.getElementById('runBtn').disabled = true; return;
  }
  document.getElementById('rangeHint').textContent = `共 ${months} 個月`;
  document.getElementById('rangeHint').style.color = 'var(--text-muted)';
  document.getElementById('runBtn').disabled = false;
}

// ===== 產生月份列表 =====
// ===== 週文件載入器（2026-08-28 加）=====
// weeks 是「一週一份、只增不減」的集合，原本兩處都直接 collection('weeks').get() 全撈再由
// 前端過濾，而且第一處還被包在 ymList × stores 雙層迴圈裡——分析區間選 12 個月就把整個集合
// 重撈 12 次（每店 24 份 × 12 個月 × 3 店 ≈ 864 次讀取，真正用到的只有 73 份）。
// 改成：每店只撈一次並快取，且用 documentId 範圍把年份夾住 → 讀取量不再隨歷史累積無限成長。
// 週文件 id 一律是補零的 'YYYY-Www'（已核對三店 73 份全符合），故字典序範圍查詢安全。
let _weekDocCache = {};
async function loadWeekDocs(store, years){
  const lo=`${Math.min(...years)}-W00`, hi=`${Math.max(...years)}-W99`;
  const ck=`${store}|${lo}|${hi}`;
  if(_weekDocCache[ck]) return _weekDocCache[ck];
  const snap = await window.db.collection('stores').doc(store).collection('weeks')
    .where(firebase.firestore.FieldPath.documentId(), '>=', lo)
    .where(firebase.firestore.FieldPath.documentId(), '<=', hi).get();
  const out=[]; snap.forEach(d=>out.push({ id:d.id, data:d.data()||{} }));
  return (_weekDocCache[ck]=out);
}

function getYMRange(){
  const sy=document.getElementById('selStartYear').value;
  const sm=document.getElementById('selStartMonth').value;
  const ey=document.getElementById('selEndYear').value;
  const em=document.getElementById('selEndMonth').value;
  const result=[];
  let y=parseInt(sy), m=parseInt(sm);
  while(true){
    result.push(`${y}-${String(m).padStart(2,'0')}`);
    if(y===parseInt(ey) && m===parseInt(em)) break;
    m++; if(m>12){m=1;y++;}
  }
  return result;
}

// ===== 主分析 =====
async function runAnalysis(){
  document.getElementById('runBtn').disabled = true;
  document.getElementById('progressWrap').style.display = 'block';
  setProgress(0,'讀取中...');

  const ymList = getYMRange();
  const anaYears = [...new Set(ymList.map(x=>parseInt(x.slice(0,4))))];
  _weekDocCache = {};   // 每次重跑都重新讀，避免拿到上一次區間的快取
  const stores = appConfig.stores||[];
  const complianceRows = []; // 勞基法合規稽核：知情放行 lawOverrides（歷史快照）
  if(!stores.length){ showToast('⚠️ 無門市資料'); document.getElementById('runBtn').disabled=false; return; }

  try{
    // 1. 員工名單
    setProgress(5,'讀取員工名單...');
    let allEmps = [];
    for(const store of stores){
      const snap = await window.db.collection('stores').doc(store).collection('employees').get();
      snap.forEach(d=>{
        const data=d.data();
        // 包含離職/調走員工（計入他們實際在職月份的成本），但需有離職日期才能按月過濾
        allEmps.push({ name:d.id, store, ...data });
      });
    }
    allEmps.sort((a,b)=>(stores.indexOf(a.store)-stores.indexOf(b.store))||(a.sortKey||0)-(b.sortKey||0));

    // app 顯示名對照（account.empName → displayName）
    displayNameMap = {};
    try {
      const accSnap = await window.db.collection('account').get();
      accSnap.forEach(d=>{ const a=d.data(); if(a.empName && a.displayName) displayNameMap[a.empName]=a.displayName; });
    } catch(e){}

    // 2. 薪資記錄（每月每店）
    setProgress(15,'讀取薪資記錄...');
    // salaryMap[ym][empName] = rec
    const salaryMap = {};
    let loaded = 0;
    for(const ym of ymList){
      salaryMap[ym] = {};
      for(const store of stores){
        try{
          const snap = await window.db.collection('stores').doc(store).collection('salary').doc(ym).get();
          if(snap.exists)
            (snap.data().records||[]).forEach(r=>{ salaryMap[ym][r.empName]={ ...r, _store:store, _tabConfirmed: snap.data().tabConfirmed?.[r.empName] }; });
        }catch{}
      }
      loaded++;
      setProgress(15 + Math.round(loaded/ymList.length*40), `薪資 ${ym}...`);
    }

    // 3. 排班記錄（跨店支援）
    setProgress(58,'讀取排班支援記錄...');
    // supportMap[ym][empName] = { toStore, days, hours, role }[]
    const supportMap = {};
    for(const ym of ymList){
      supportMap[ym] = {};
      const [y,m] = ym.split('-').map(Number);
      // 找該月所有週次
      for(const store of stores){
        try{
          const weeksSnap = await loadWeekDocs(store, anaYears);
          weeksSnap.forEach(wd => {
            const wk = wd.id; // 'YYYY-Www'
            if(!wk.startsWith(String(y))) return;
            (wd.data.records||[]).forEach(r => {
              // 合規稽核：蒐集知情放行的勞基法軟擋（只存在真實員工列；歷史快照，不重算）
              if(Array.isArray(r.lawOverrides) && r.lawOverrides.length && r.name && !String(r.name).startsWith('🆘')){
                const wMon2 = weekStringToDate(wk);
                const dIdx2 = ['週一','週二','週三','週四','週五','週六','週日'].indexOf(r.day);
                if(dIdx2>=0){
                  const cDate = new Date(wMon2); cDate.setDate(wMon2.getDate()+dIdx2);
                  if(cDate.getFullYear()===y && cDate.getMonth()+1===m){
                    const ds = `${cDate.getFullYear()}-${String(cDate.getMonth()+1).padStart(2,'0')}-${String(cDate.getDate()).padStart(2,'0')}`;
                    r.lawOverrides.forEach(ov => complianceRows.push({
                      ym, date: ds, store, empName: r.name,
                      rule: ov.rule||'', measured: ov.measured, reason: ov.reason||'',
                      note: ov.note||'', approvedBy: ov.approvedBy||'', at: ov.at||''
                    }));
                  }
                }
              }
              if(!r.supportEmp || r.approvalStatus !== 'approved') return;
              // supportEmp 格式：'{homeStore}-{empName}'，儲存在接收門市（store）的 weeks collection
              const dashIdx = r.supportEmp.indexOf('-');
              if(dashIdx < 0) return;
              const homeStore = r.supportEmp.substring(0, dashIdx);
              const empName = r.supportEmp.substring(dashIdx + 1);
              if(!homeStore || !empName) return;
              // 判斷這筆記錄的日期是否在 ym 月
              const wMon = weekStringToDate(wk);
              const dIdx = ['週一','週二','週三','週四','週五','週六','週日'].indexOf(r.day);
              if(dIdx<0) return;
              const cellDate = new Date(wMon); cellDate.setDate(wMon.getDate()+dIdx);
              if(cellDate.getFullYear()!==y || cellDate.getMonth()+1!==m) return;
              if(!supportMap[ym][empName]) supportMap[ym][empName]=[];
              supportMap[ym][empName].push({
                fromStore: homeStore,  // 員工的本店
                toStore: store,        // 去支援的門市（此記錄所在門市）
                hours: parseFloat(r.actualHours||0),
                day: r.day
              });
            });
          });
        }catch{}
      }
    }

    // 3.5 每週工時（優先C）：每店每週彙總（weeks doc 一週一份，直接加總）
    setProgress(70,'計算每週工時...');
    const periodStart = `${ymList[0]}-01`;
    const [_ly,_lm] = ymList[ymList.length-1].split('-').map(Number);
    const periodEnd = `${ymList[ymList.length-1]}-${String(new Date(_ly,_lm,0).getDate()).padStart(2,'0')}`;
    const fmtD = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const weeklyMap = {}; // `${store}|${wk}` -> {store,wk,mon,emps:{...}}（每人明細，發薪歸屬店）
    const physMap = {};   // `${store}|${wk}` -> {store,wk,mon,hours}（店別實體工時：自有+受支援-外派）
    const monthlyHoursMap = {}; // ym -> { hours, ot, byStore }（依班次日期歸月，供每工時成本用；發薪歸屬）
    for(const store of stores){
      try{
        const wSnap = await loadWeekDocs(store, anaYears);
        wSnap.forEach(wd=>{
          const wk = wd.id;
          if(!/^\d{4}-W\d{1,2}$/.test(wk)) return;
          const mon = weekStringToDate(wk);
          const sun = new Date(mon); sun.setDate(mon.getDate()+6);
          if(fmtD(sun) < periodStart || fmtD(mon) > periodEnd) return; // 週完全在期間外
          const key = `${store}|${wk}`;
          const bucket = weeklyMap[key] || (weeklyMap[key] = { store, wk, mon, emps:{} });
          const phys = physMap[key] || (physMap[key] = { store, wk, mon, hours:0 });
          const _seenRec = new Set(); // 去重：同筆記錄重複(如 W28 被灌爆)不重複計工時
          (wd.data.records||[]).forEach(r=>{
            if(!r || !r.name || r.name==='門市備註') return;
            const _rk = [r.name, r.day, r.shift, r.location, r.supportEmp].join('|');
            if(_seenRec.has(_rk)) return; _seenRec.add(_rk);
            const sh = r.shift;
            if(!sh || ['排休','指休','特休','補休','清空'].includes(sh)) return;
            const dIdx = ['週一','週二','週三','週四','週五','週六','週日'].indexOf(r.day);
            if(dIdx<0) return;
            const h = n(r.actualHours);
            const ot = (r.isOT || h>8) ? Math.max(0,h-8) : 0;
            const isPlaceholder = String(r.name).startsWith('🆘');
            const loc = r.location || '本店';
            // 店別實體工時：本店自有(非🆘、location=本店、非時薪) + 受支援(🆘 approved)；外派(location≠本店)不計本店(計在對方)
            if(!isPlaceholder && !r.isHourly && (loc==='本店'||loc==='')) phys.hours += h;
            else if(isPlaceholder && r.supportEmp && r.approvalStatus==='approved') phys.hours += h;
            // 以下為每人明細＋每月工時(發薪歸屬)：只算真實員工、非時薪（含其外派時數，屬本人工時）
            if(isPlaceholder || r.isHourly) return;
            const e = bucket.emps[r.name] || (bucket.emps[r.name] = { hours:0, ot:0, days:new Set() });
            e.hours += h; e.ot += ot; e.days.add(dIdx);
            const cd = new Date(mon); cd.setDate(mon.getDate()+dIdx);
            const ym2 = `${cd.getFullYear()}-${String(cd.getMonth()+1).padStart(2,'0')}`;
            if(ymList.includes(ym2)){
              const mh = monthlyHoursMap[ym2] || (monthlyHoursMap[ym2] = { hours:0, ot:0, byStore:{} });
              mh.hours += h; mh.ot += ot;
              const bs = mh.byStore[store] || (mh.byStore[store] = { hours:0, ot:0 });
              bs.hours += h; bs.ot += ot;
            }
          });
        });
      }catch{}
    }
    const mkLabel = m => { const s=new Date(m); s.setDate(m.getDate()+6); return `${m.getMonth()+1}/${m.getDate()}~${s.getMonth()+1}/${s.getDate()}`; };
    const weeklyRows = [], weeklyTrend = {};
    // 每人明細（發薪歸屬店，含本人外派時數 → 勞基法把關看本人）
    Object.values(weeklyMap).forEach(b=>{
      const label = mkLabel(b.mon);
      Object.entries(b.emps).forEach(([emp,e])=>{
        weeklyRows.push({ wk:b.wk, weekLabel:label, store:b.store, empName:emp,
          hours:Math.round(e.hours*10)/10, ot:Math.round(e.ot*10)/10, days:e.days.size });
      });
    });
    weeklyRows.sort((a,b)=> a.wk.localeCompare(b.wk) || b.hours-a.hours);
    // 店別每週趨勢（實體工時：自有+受支援-外派）
    Object.values(physMap).forEach(p=>{
      const t = weeklyTrend[p.wk] || (weeklyTrend[p.wk] = { wk:p.wk, label:mkLabel(p.mon), sortKey:p.mon.getTime(), byStore:{} });
      t.byStore[p.store] = Math.round(p.hours*10)/10;
    });

    // 4. 組裝分析資料
    setProgress(80,'計算分析數據...');
    // 合規去重（同日/同人/同規則/同數值/同理由/同時間視為同一筆，避免重複列出）
    const _seenC = new Set();
    const complianceUniq = complianceRows.filter(r=>{
      const k = [r.date,r.empName,r.rule,r.measured,r.reason,r.note,r.at].join('|');
      if(_seenC.has(k)) return false; _seenC.add(k); return true;
    });
    complianceUniq.sort((a,b)=> b.date.localeCompare(a.date) || String(a.empName).localeCompare(String(b.empName)));
    analysisData = { ymList, stores, allEmps, salaryMap, supportMap, complianceRows:complianceUniq, weeklyRows, weeklyTrend, monthlyHoursMap };
    renderAll();
    setProgress(100,'✅ 完成');
    document.getElementById('mainAnalysis').style.display = 'block';

  }catch(e){
    showToast('❌ 分析失敗：'+e.message);
    console.error(e);
    setProgress(0,'❌ 失敗：'+e.message);
  }
  document.getElementById('runBtn').disabled = false;
}

// ===== 週次字串轉日期 =====
function weekStringToDate(wStr){
  let p=wStr.split('-W'); let yr=parseInt(p[0]); let wk=parseInt(p[1]);
  let d=new Date(yr,0,1); let day=d.getDay();
  d.setDate(d.getDate()+(wk-1)*7);
  let offset=day<=4?1-day:8-day;
  d.setDate(d.getDate()+offset);
  return d;
}

// ===== 薪資計算 =====
const calcHourlyRate = rec => (n(rec.baseSalary)+n(rec.fullAttendBase)+n(rec.otherBase))/30/8;
const calcOtPay = rec => {
  const rph=calcHourlyRate(rec);
  const hasCustom=n(rec.customOtRate)>0;
  const rate=hasCustom?n(rec.customOtRate):Math.ceil(rph);
  const mult=hasCustom?(rec.customOtX134!==false?1.34:1):1.34;
  return Math.ceil(rate*mult*n(rec.otHours));
};
// 計薪模式：payAsPartTime 者以工讀時薪計（職務角色不變）；主要金額仍優先讀存檔快照
const effR = (emp, rec) => (((emp && emp.payAsPartTime) || (rec && rec.payAsPartTime)) ? '工讀' : ((emp && emp.role) || (rec && rec.role) || ''));
// 該「記錄月」是否以工讀時薪計——以記錄本身判(歷史不可變)：工讀轉正職者，過去月份仍算工讀時薪。避免現況正職→用底薪算成 0
function recIsPart(emp, rec){
  return !!((emp && emp.payAsPartTime) || (rec && rec.payAsPartTime) || (rec && rec.role==='工讀') || (rec && n(rec.wage)>0 && n(rec.baseSalary)===0));
}
const calcGross = (rec, role) => {
  if(rec.grossAmt != null) return n(rec.grossAmt); // ✅ 讀 salary.html 存的實發快照
  if(role==='工讀'){
    const w=n(rec.wage),h=n(rec.hours||0);
    return Math.max(0, Math.round(w*h)+Math.round(w*n(rec.holidayHours))+n(rec.roleBonus)+Math.round(n(rec.extraHours)*w)-Math.abs(n(rec.personalSickLeave)));
  }
  const mgmt=['mgmtOps','mgmtQuality','mgmtKPI','mgmtAccount','mgmtLeader'].reduce((s,k)=>s+n(rec[k]),0);
  return Math.max(0, n(rec.baseSalary)+n(rec.fullAttendBonus)+mgmt+n(rec.laborAllowance)+n(rec.performance)+n(rec.nightAllowance)+n(rec.roleBonus)+n(rec.otherBonus)+n(rec.annualLeaveEncash)+n(rec.compLeaveEncash)+calcOtPay(rec)+n(rec.restDayOtPay)+n(rec.holidayOtPay)+n(rec.hourlySupportAmt||0)-Math.round(calcHourlyRate(rec)/60*n(rec.lateMinutes))-Math.abs(n(rec.personalSickLeave)));
};
const calcDeduct = rec => rec.deductAmt != null ? n(rec.deductAmt) : (n(rec.laborInsurance)+n(rec.healthInsurance)+n(rec.dependentInsurance)+n(rec.laborPension)+n(rec.otherDeduction));
const calcNet = (rec,role) => calcGross(rec,role)-calcDeduct(rec);
const calcPension = (rec,role) => (rec.insuranceGrade!=null)?n(rec.pensionEr||0):(role==='工讀'?0:Math.round((n(rec.baseSalary)+n(rec.fullAttendBonus))*0.06));
const calcErBurden = (rec,role) => n(rec.laborEr||0)+n(rec.healthEr||0)+calcPension(rec,role);
const calcRealCost = (rec,role) => calcGross(rec,role)+calcErBurden(rec,role);

// 判斷員工在指定月份是否在職（含離職/調走員工的歷史月份）
function isEmpActiveInMonth(emp, ym) {
  // 到職日晚於該月：尚未到職
  if(emp.startDate && emp.startDate > ym + '-31') return false;
  // 離職/調走日期：若在該月底之前則已離開（與 salary.html 一致）
  // 離職：當月仍計(生效日<當月1號才排除)；調走：生效當月即歸新店(<=當月1號排除)
  if(emp.retireDate && emp.retireDate < ym + '-01') return false;
  const tDate = emp.transferDate;
  if(emp.status === '調走' && tDate && tDate <= ym + '-01') return false;
  if(emp.status !== '調走' && tDate && !emp.retireDate && tDate < ym + '-01') return false;
  return true;
}

// 該員當月是否「由某門市發薪」——完全比照 salary.html empList 的納入條件。
// 用於跨店支援成本歸屬：被支援(in) 排除已由接收門市發薪者；支援別人(out) 只算發薪門市的員工。
// 注意：不能用 isEmpActiveInMonth，因為調入本店者(如楷岳)其 transferDate 是「調入日」會被誤判為離開。
function isPaidByStoreInMonth(empName, store, ym, allEmps) {
  const [cy, cm] = ym.split('-').map(Number);
  const monthEnd = `${ym}-${new Date(cy, cm, 0).getDate()}`;
  return allEmps.some(e => {
    if(e.name !== empName || e.store !== store) return false;
    const eff = e.retireDate || e.transferDate;            // 僅在「離職/調走」狀態下才視為離開
    // 離職：當月仍由本店發薪(<當月1號才排除)；調走：生效當月即歸新店(<=當月1號排除)
    if(e.status === '離職' && (!eff || eff < `${ym}-01`)) return false;
    if(e.status === '調走' && (!eff || eff <= `${ym}-01`)) return false;
    if(e.startDate){ const [sy, sm] = e.startDate.split('-').map(Number); if(sy > cy || (sy === cy && sm > cm)) return false; }
    return true;
  });
}

// 計算支援調整金額（正職日薪 or 工讀時薪）
function calcSupportAdj(empName, ym, salaryMap, supportMap, allEmps){
  const emp = allEmps.find(e=>e.name===empName);
  const rec = salaryMap[ym]?.[empName];
  const supports = supportMap[ym]?.[empName]||[];
  if(!supports.length) return { adj:0, details:[] };

  const role = effR(emp, rec) || rec?._role || '';
  const isPart = role==='工讀';
  let adj = 0;
  const details = [];

  supports.forEach(s => {
    let amt = 0;
    if(isPart){
      const wage = n(rec?.wage||emp?.wage||0);
      amt = Math.round(wage * s.hours);
    } else {
      const base = n(rec?.baseSalary||0)+n(rec?.fullAttendBonus||0);
      const hrRate = base / 30 / 8;
      amt = Math.round(hrRate * s.hours);
    }
    adj += amt;
    details.push({ ...s, amt });
  });

  return { adj, details };
}

// ===== Tab 切換 =====
function switchTab(tab){
  ['cost','ot','hourly','compliance','weekly'].forEach(t=>{
    document.getElementById('tab-'+t).classList.toggle('active', t===tab);
    document.getElementById('panel-'+t).classList.toggle('active', t===tab);
  });
  if(tab==='ot') renderAnomalyTab(); // 加班與異常同頁
  if(tab==='compliance') renderComplianceTab();
  if(tab==='weekly') renderWeeklyTab();
}

// ===== 經營儀表板（優先4：每工時成本／加班佔比／趨勢／合理範圍帶／決策提示）=====
function buildMonthlySeries(){
  const { ymList, salaryMap, monthlyHoursMap } = analysisData;
  return ymList.map(ym=>{
    let gross=0, er=0; const head={full:0,part:0,manager:0};
    Object.values(salaryMap[ym]||{}).forEach(rec=>{
      const role = effR(null, rec);
      gross += calcGross(rec, role);
      er += calcErBurden(rec, role);
      if(role==='工讀') head.part++; else if(role==='店長') head.manager++; else head.full++;
    });
    const mh = monthlyHoursMap?.[ym] || { hours:0, ot:0 };
    const cost = gross + er;
    return { ym, gross:Math.round(gross), er:Math.round(er), cost:Math.round(cost),
      hours:Math.round(mh.hours*10)/10, ot:Math.round(mh.ot*10)/10,
      cph: mh.hours>0 ? Math.round(cost/mh.hours) : 0,
      otRatio: mh.hours>0 ? Math.round(mh.ot/mh.hours*1000)/10 : 0, head };
  });
}
function renderDashboardTab(){
  const el = document.getElementById('dashboardContent'); if(!el) return;
  if(!analysisData){ el.innerHTML='<div style="text-align:center;color:var(--text-muted);padding:40px 0;">請先執行分析</div>'; return; }
  try {
  const otTarget = parseFloat(document.getElementById('dashOtTarget').value)||8;
  const bandPct = (parseFloat(document.getElementById('dashBandPct').value)||10)/100;
  const series = buildMonthlySeries().filter(s=>s.hours>0 || s.cost>0);
  if(!series.length){ el.innerHTML='<div style="text-align:center;color:var(--text-muted);padding:40px 0;">本期無資料</div>'; return; }
  const last = series[series.length-1], prev = series[series.length-2];
  const comma = x => (x||0).toLocaleString();
  // 合理範圍帶：以「本月之前」的每工時成本滾動平均 ±bandPct
  const cphHist = series.slice(0,-1).map(s=>s.cph).filter(v=>v>0);
  const cphAvg = cphHist.length ? Math.round(cphHist.reduce((a,b)=>a+b,0)/cphHist.length) : last.cph;
  const bandLo = Math.round(cphAvg*(1-bandPct)), bandHi = Math.round(cphAvg*(1+bandPct));
  const cphStatus = last.cph>bandHi ? {c:'#d93025',t:'偏高'} : last.cph<bandLo ? {c:'#188038',t:'偏低(佳)'} : {c:'#188038',t:'合理'};
  const otStatus = last.otRatio>otTarget ? {c:'#d93025',t:'超標'} : {c:'#188038',t:'達標'};
  const mom = (cur,pv)=> pv? `<span style="font-size:11px;font-weight:800;color:${cur>pv?'#d93025':'#188038'};">${cur>pv?'▲':'▼'}${Math.abs(Math.round((cur-pv)/pv*1000)/10)}%</span>` : '';
  // KPI
  const kpi = `<div class="kpi-grid">
    <div class="kpi-card"><div class="kpi-label">⏱️ 每工時人事成本</div><div class="kpi-val" style="color:${cphStatus.c};">$${comma(last.cph)}</div><div class="kpi-sub">含公司負擔　${prev?mom(last.cph,prev.cph):''}</div><div class="kpi-trend" style="color:${cphStatus.c};">${cphStatus.t}（合理帶 $${comma(bandLo)}–$${comma(bandHi)}）</div></div>
    <div class="kpi-card"><div class="kpi-label">⚡ 加班佔比</div><div class="kpi-val" style="color:${otStatus.c};">${last.otRatio}%</div><div class="kpi-sub">加班${last.ot}h / 總${last.hours}h　${prev?mom(last.otRatio,prev.otRatio):''}</div><div class="kpi-trend" style="color:${otStatus.c};">${otStatus.t}（目標 ≤${otTarget}%）</div></div>
    <div class="kpi-card"><div class="kpi-label">💰 月總成本(含公司負擔)</div><div class="kpi-val">$${comma(last.cost)}</div><div class="kpi-sub">實發$${comma(last.gross)}＋負擔$${comma(last.er)}　${prev?mom(last.cost,prev.cost):''}</div></div>
    <div class="kpi-card"><div class="kpi-label">👥 人數(正/工/店長)</div><div class="kpi-val" style="font-size:20px;">${last.head.full}/${last.head.part}/${last.head.manager}</div><div class="kpi-sub">總工時 ${last.hours}h</div></div>
  </div>`;
  // 決策提示
  const tips = [];
  if(last.otRatio>otTarget){
    const targetOtH = Math.round(last.hours*otTarget/100*10)/10;
    const saveH = Math.round((last.ot-targetOtH)*10)/10;
    tips.push(`⚡ 加班佔比 ${last.otRatio}% 超過目標 ${otTarget}%：若降到目標，約可減少 <b>${saveH}h</b> 加班（檢視排班密度／增補人力）。`);
  }
  if(last.cph>bandHi) tips.push(`⏱️ 每工時成本 $${comma(last.cph)} 高於近期均 $${comma(cphAvg)}（+${Math.round((last.cph-cphAvg)/cphAvg*1000)/10}%），留意人力配置／薪資結構。`);
  if(!tips.length) tips.push('✅ 本月每工時成本與加班佔比皆在合理範圍。');
  const tipsHtml = `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;padding:12px 14px;margin:12px 0;font-size:13px;line-height:1.8;">${tips.map(t=>`<div>${t}</div>`).join('')}</div>`;
  // 趨勢表
  const rows = series.map(s=>{
    const st = s.cph>bandHi?'🔴':s.cph<bandLo?'🟢':'🟡';
    return `<tr><td><b>${s.ym}</b></td><td class="num">$${comma(s.cost)}</td><td class="num">${s.hours}</td><td class="num"><b>$${comma(s.cph)}</b> ${st}</td><td class="num" style="${s.otRatio>otTarget?'color:#d93025;font-weight:800;':''}">${s.otRatio}%</td></tr>`;
  }).join('');
  const trend = `<div class="section-title">📈 月度趨勢（🟢低/🟡合理/🔴偏高，合理帶 $${comma(bandLo)}–$${comma(bandHi)}）</div>
    <div style="overflow-x:auto;"><table class="data-table"><thead><tr><th>月份</th><th class="num">總成本</th><th class="num">總工時</th><th class="num">每工時成本</th><th class="num">加班佔比</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  el.innerHTML = kpi + tipsHtml + trend;
  } catch(err){
    el.innerHTML = `<div style="color:var(--danger);padding:20px;font-size:13px;">儀表板計算錯誤：${err.message}<br><span style="color:var(--text-muted);">請點上方「執行分析」重新載入。</span></div>`;
    console.error('renderDashboardTab', err);
  }
}

// ===== 每週工時（勞基法單週把關 + 週趨勢）=====
function weeklyFlag(row, yellow, red){
  if(row.days>=7) return { lv:'red', txt:'🔴 無例假(連7天)' };
  if(row.hours>=red) return { lv:'red', txt:`🔴 單週 ${row.hours}h` };
  if(row.hours>=yellow) return { lv:'yellow', txt:`⚠️ 單週 ${row.hours}h` };
  return null;
}
function renderWeeklyTab(){
  const el = document.getElementById('weeklyContent'); if(!el) return;
  if(!analysisData){ el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px 0;">請先執行分析</div>'; return; }
  const yellow = parseFloat(document.getElementById('weeklyYellow').value)||48;
  const red = parseFloat(document.getElementById('weeklyRed').value)||60;
  const onlyFlag = document.getElementById('weeklyOnlyFlag').checked;
  const weeklyRows = analysisData.weeklyRows||[], weeklyTrend = analysisData.weeklyTrend||{}, stores = analysisData.stores||[];
  // 週趨勢表
  const weeks = Object.values(weeklyTrend).sort((a,b)=>a.sortKey-b.sortKey);
  let trendHtml = '';
  if(weeks.length){
    const head = stores.map(s=>`<th class="num">${s}</th>`).join('');
    const body = weeks.map(w=>{
      const cells = stores.map(s=>`<td class="num">${w.byStore[s]!=null?w.byStore[s]:'—'}</td>`).join('');
      const tot = stores.reduce((a,s)=>a+(w.byStore[s]||0),0);
      return `<tr><td><b>${w.label}</b></td>${cells}<td class="num"><b>${Math.round(tot*10)/10}</b></td></tr>`;
    }).join('');
    trendHtml = `<div class="section-title">📈 各店每週實體工時 (h)（含受支援、扣外派）</div><div style="overflow-x:auto;"><table class="data-table"><thead><tr><th>週</th>${head}<th class="num">合計</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }
  // 單週把關明細
  let list = weeklyRows.map(r=>({ r, f:weeklyFlag(r,yellow,red) }));
  const flaggedCount = list.filter(x=>x.f).length;
  if(onlyFlag) list = list.filter(x=>x.f);
  const trs = list.map(({r,f})=>`<tr style="${f?(f.lv==='red'?'background:#fef2f2;':'background:#fffbeb;'):''}">
    <td>${r.weekLabel}</td><td><b>${dispName(r.empName)}</b></td><td>${r.store}</td>
    <td class="num">${r.hours}</td><td class="num">${r.ot||''}</td>
    <td class="num">${r.days}${r.days>=7?' 🔴':''}</td>
    <td>${f?f.txt:''}</td></tr>`).join('');
  const detail = `<div class="section-title" style="margin-top:16px;">📋 單週把關（黃≥${yellow}h／紅≥${red}h／連7天無例假 §36；共 ${flaggedCount} 筆異常）</div>
    <div style="overflow-x:auto;"><table class="data-table" id="tableWeekly"><thead><tr><th>週</th><th>員工</th><th>門市</th><th class="num">工時</th><th class="num">加班</th><th class="num">出勤天</th><th>把關</th></tr></thead><tbody>${trs||'<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px;">無資料</td></tr>'}</tbody></table></div>`;
  el.innerHTML = trendHtml + detail;
}
function exportWeeklyTable(){
  if(!analysisData){ showToast('⚠️ 請先執行分析'); return; }
  const table = document.getElementById('tableWeekly'); if(!table){ showToast('⚠️ 無資料'); return; }
  const ws = XLSX.utils.table_to_sheet(table);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '每週工時');
  XLSX.writeFile(wb, `每週工時_${document.getElementById('selStartYear').value}${document.getElementById('selStartMonth').value}-${document.getElementById('selEndYear').value}${document.getElementById('selEndMonth').value}.xlsx`);
}

// ===== 合規稽核（勞基法軟擋知情放行）=====
const COMPLIANCE_RULE_LABEL = {
  rest11h:'輪班間隔<11h', daily12h:'當日工時>12h', continuous12h:'連續工時>12h', weekly1off:'七休一(連續≥7天)'
};
const COMPLIANCE_RULE_LAW = {
  rest11h:'§34', daily12h:'§32', continuous12h:'§32', weekly1off:'§36'
};
const COMPLIANCE_REASON_LABEL = {
  voluntary:'員工自願', urgent:'營運急需', coverage:'排不出人／臨時代班', other:'其他'
};
function renderComplianceTab(){
  const el = document.getElementById('complianceContent');
  if(!el) return;
  if(!analysisData){ el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px 0;">請先執行分析</div>'; return; }
  const rows = analysisData.complianceRows || [];
  if(!rows.length){
    el.innerHTML = '<div style="text-align:center;color:var(--accent);padding:40px 0;font-weight:700;">✅ 本期無勞基法軟擋放行紀錄</div>';
    return;
  }
  const byRule = {}, byEmp = {};
  rows.forEach(r=>{ byRule[r.rule]=(byRule[r.rule]||0)+1; byEmp[r.empName]=(byEmp[r.empName]||0)+1; });
  const chip = (txt,color)=>`<span style="display:inline-block;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:700;background:${color||'#fff3e0'};color:#b45309;margin:2px 4px 2px 0;">${txt}</span>`;
  const ruleChips = Object.entries(byRule).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>chip(`${COMPLIANCE_RULE_LABEL[k]||k}：${v}`)).join('');
  const empChips = Object.entries(byEmp).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>chip(`${dispName(k)}：${v}`, '#eef4ff')).join('');
  const trs = rows.map(r=>`<tr>
    <td>${r.date}</td>
    <td><b>${dispName(r.empName)}</b></td>
    <td>${r.store}</td>
    <td>${COMPLIANCE_RULE_LABEL[r.rule]||r.rule} <span style="color:var(--text-muted);font-size:11px;">${COMPLIANCE_RULE_LAW[r.rule]||''}</span>${r.measured!=null&&r.measured!==''?`　<b>${r.measured}</b>`:''}</td>
    <td>${COMPLIANCE_REASON_LABEL[r.reason]||r.reason||''}</td>
    <td>${r.note||''}</td>
    <td>${r.approvedBy||''}</td>
  </tr>`).join('');
  el.innerHTML = `
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:12px 14px;margin-bottom:12px;">
      <div style="font-weight:800;color:#b45309;margin-bottom:6px;">共 ${rows.length} 筆知情放行</div>
      <div>${ruleChips}</div>
      <div style="margin-top:6px;">${empChips}</div>
    </div>
    <div style="overflow-x:auto;">
      <table class="data-table" id="tableCompliance">
        <thead><tr><th>日期</th><th>員工</th><th>門市</th><th>違規類型(勞基法)</th><th>放行理由</th><th>備註</th><th>放行者</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
}
function exportComplianceTable(){
  if(!analysisData){ showToast('⚠️ 請先執行分析'); return; }
  const table = document.getElementById('tableCompliance');
  if(!table){ showToast('⚠️ 本期無稽核資料'); return; }
  const ws = XLSX.utils.table_to_sheet(table);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '勞基法合規稽核');
  XLSX.writeFile(wb, `勞基法合規稽核_${document.getElementById('selStartYear').value}${document.getElementById('selStartMonth').value}-${document.getElementById('selEndYear').value}${document.getElementById('selEndMonth').value}.xlsx`);
}

// ===== 渲染所有分析 =====
function renderAll(){
  if(!analysisData) return;
  initFilterState();
  renderKPIs();
  renderCostTab();
  renderOtTab();
  const anomalyCount = renderAnomalyTab();
  renderHourlyTab();
  renderComplianceTab();
  renderWeeklyTab();
  updateAnomalyBadge(anomalyCount);
  // 合規稽核筆數標記
  const compCount = (analysisData.complianceRows||[]).length;
  const compTab = document.getElementById('tab-compliance');
  if(compTab) compTab.textContent = compCount>0 ? `🛡️ 合規稽核 (${compCount})` : '🛡️ 合規稽核';
  const alertBar = document.getElementById('anomalyAlertBar');
  if(anomalyCount > 0){
    document.getElementById('anomalyAlertText').textContent = `本期有 ${anomalyCount} 筆薪資異常，已自動切換至「加班與異常」頁`;
    if(alertBar) alertBar.style.display = 'flex';
    setTimeout(() => switchTab('ot'), 50);
  } else {
    if(alertBar) alertBar.style.display = 'none';
  }
}

// ===== KPI 卡片 =====
function renderKPIs(){
  const { ymList, stores, allEmps, salaryMap, supportMap } = analysisData;
  let totalCost=0, totalOt=0, totalHol=0;
  let fullCnt=0, partCnt=0;

  allEmps.forEach(emp=>{
    ymList.forEach(ym=>{
      if(!isEmpActiveInMonth(emp,ym)) return;
      const rec = salaryMap[ym]?.[emp.name];
      if(!rec) return;
      const { adj } = calcSupportAdj(emp.name, ym, salaryMap, supportMap, allEmps);
      const isSupporter = (supportMap[ym]?.[emp.name]||[]).length > 0;
      totalCost += calcGross(rec,emp.role) + (isSupporter ? adj : 0);
      totalOt += calcOtPay(rec);
      totalHol += emp.role==='工讀' ? Math.round(n(rec.wage)*n(rec.holidayHours)) : n(rec.holidayOtPay);
    });
  });

  // 在職人數：計算在分析末月仍在職的人數
  const lastYm = ymList[ymList.length-1];
  allEmps.forEach(e=>{ if(!isEmpActiveInMonth(e,lastYm)) return; if(e.role==='工讀') partCnt++; else fullCnt++; });

  document.getElementById('kpiTotalCost').textContent = '$'+Math.round(totalCost/1000)+'K';
  document.getElementById('kpiTotalSub').textContent = `含勞退提撥 · 共 ${ymList.length} 個月`;
  document.getElementById('kpiEmpCount').textContent = fullCnt+partCnt;
  document.getElementById('kpiEmpSub').textContent = `正職 ${fullCnt} 人 / 工讀 ${partCnt} 人`;
  document.getElementById('kpiOtTotal').textContent = '$'+comma(totalOt);
  document.getElementById('kpiOtSub').textContent = '平日加班費';
  document.getElementById('kpiHolidayTotal').textContent = '$'+comma(totalHol);

  // A. 環比趨勢（最後一個月 vs 倒數第二個月）
  if(ymList.length >= 2){
    const lastYm = ymList[ymList.length-1];
    const prevYm = ymList[ymList.length-2];
    const ymVal = (ym, type) => {
      let v = 0;
      allEmps.forEach(emp=>{
        const rec = salaryMap[ym]?.[emp.name];
        if(!rec) return;
        if(type==='cost'){ const {adj}=calcSupportAdj(emp.name,ym,salaryMap,supportMap,allEmps); v+=calcRealCost(rec,emp.role)+((supportMap[ym]?.[emp.name]||[]).length?adj:0); }
        else if(type==='ot') v+=calcOtPay(rec);
        else if(type==='hol') v+=emp.role==='工讀'?Math.round(n(rec.wage)*n(rec.holidayHours)):n(rec.holidayOtPay);
      });
      return v;
    };
    const renderTrend = (id, last, prev) => {
      const el = document.getElementById(id); if(!el||prev===0) return;
      const pct = Math.round((last-prev)/prev*100);
      el.innerHTML = pct>0?`<span style="color:var(--danger);">▲ +${pct}%</span>`:pct<0?`<span style="color:var(--accent);">▼ ${pct}%</span>`:`<span style="color:var(--text-muted);">— 持平</span>`;
    };
    renderTrend('kpiCostTrend',    ymVal(lastYm,'cost'),    ymVal(prevYm,'cost'));
    renderTrend('kpiOtTrend',      ymVal(lastYm,'ot'),      ymVal(prevYm,'ot'));
    renderTrend('kpiHolidayTrend', ymVal(lastYm,'hol'),     ymVal(prevYm,'hol'));
  }
}

// ===== 人事成本 Tab =====
function renderCostTab(){
  const { ymList, stores, allEmps, salaryMap, supportMap } = analysisData;
  const fEmps = getFE(); const fStores = getFS();
  const storeColors = {};
  stores.forEach((s,i)=>storeColors[s]=STORE_COLORS[i%STORE_COLORS.length]);

  // 月 × 店 成本矩陣
  const costMatrix = {}; // costMatrix[store][ym]
  fStores.forEach(s=>{ costMatrix[s]={}; ymList.forEach(ym=>costMatrix[s][ym]=0); });

  // 支援調整矩陣（拆為進/出）
  const inMatrix  = {}; // 被支援費用（外店來）
  const outMatrix = {}; // 支援別人（本店出）
  fStores.forEach(s=>{ inMatrix[s]={}; outMatrix[s]={}; ymList.forEach(ym=>{ inMatrix[s][ym]=0; outMatrix[s][ym]=0; }); });

  // 以薪資記錄為準（與 salary.html 一致）
  fStores.forEach(store=>{
    ymList.forEach(ym=>{
      Object.values(salaryMap[ym]||{}).filter(r=>r._store===store).forEach(rec=>{
        const role = effR(null, rec);
        costMatrix[store][ym] = (costMatrix[store][ym]||0) + calcRealCost(rec,role);
      });
    });
  });

  // 支援調整：以支援記錄的 fromStore 為準（與 salary.html 一致）
  // 同時收集明細供 drill-down 使用
  const supportInDetails  = {}; // [store|ym] = [{empName, fromStore, hours, hrRate, amt}]
  const supportOutDetails = {}; // [store|ym] = [{empName, toStore, hours, hrRate, amt}]
  ymList.forEach(ym=>{
    Object.entries(supportMap[ym]||{}).forEach(([empName,supports])=>{
      supports.forEach(s=>{
        if(!fStores.includes(s.fromStore)) return;
        const empRec = (salaryMap[ym]?.[empName]?._store === s.fromStore)
          ? salaryMap[ym][empName] : null;
        const empData = allEmps.find(e=>e.name===empName && e.store===s.fromStore)
                     || allEmps.find(e=>e.name===empName);
        if(!empRec && !empData) return;
        const role = empRec?.role || empData?.role || '';
        const isPart = role==='工讀';
        const base   = n(empRec?.baseSalary||0)     || n(empData?.baseSalary||0);
        const attend = n(empRec?.fullAttendBonus||0) || n(empData?.fullAttendBonus||0);
        const wage   = n(empRec?.wage||0)            || n(empData?.wage||0);
        const hrRate = isPart ? wage : (base+attend)/30/8;
        const amt = Math.round(hrRate * s.hours);
        // 對齊 salary.html 規則：
        //  支援別人(out) 只算 fromStore 當月實際發薪的員工；
        //  被支援(in) 排除已由 toStore 發薪者（例：調入本店計薪、卻仍有支援身分排班者）。
        const activeAtFrom = isPaidByStoreInMonth(empName, s.fromStore, ym, allEmps);
        const activeAtTo   = isPaidByStoreInMonth(empName, s.toStore,   ym, allEmps);
        if(activeAtFrom){
          outMatrix[s.fromStore][ym] = (outMatrix[s.fromStore][ym]||0) + amt;
          const outKey = s.fromStore+'|'+ym;
          if(!supportOutDetails[outKey]) supportOutDetails[outKey]=[];
          supportOutDetails[outKey].push({ empName, toStore:s.toStore, hours:s.hours, hrRate:Math.round(hrRate*100)/100, amt });
        }
        if(!activeAtTo){
          inMatrix[s.toStore] = inMatrix[s.toStore]||{};
          inMatrix[s.toStore][ym] = (inMatrix[s.toStore][ym]||0) + amt;
          const inKey = s.toStore+'|'+ym;
          if(!supportInDetails[inKey]) supportInDetails[inKey]=[];
          supportInDetails[inKey].push({ empName, fromStore:s.fromStore, hours:s.hours, hrRate:Math.round(hrRate*100)/100, amt });
        }
      });
    });
  });

  // 趨勢圖
  if(chartCostTrend) chartCostTrend.destroy();
  const ctx = document.getElementById('chartCostTrend').getContext('2d');
  chartCostTrend = new Chart(ctx, {
    type:'line',
    data:{
      labels: ymList.map(ym=>{ const [y,m]=ym.split('-'); return `${parseInt(m)}月`; }),
      datasets: fStores.map(s=>({
        label: s,
        data: ymList.map(ym=>Math.round(((costMatrix[s]?.[ym]||0)+(inMatrix[s]?.[ym]||0)-(outMatrix[s]?.[ym]||0))/1000)),
        borderColor: storeColors[s],
        backgroundColor: storeColors[s]+'20',
        borderWidth:2.5, pointRadius:4, tension:0.3, fill:false
      }))
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false} },
      scales:{
        y:{ ticks:{ callback:v=>'$'+v+'K' }, grid:{color:'#f1f3f4'} },
        x:{ grid:{display:false} }
      }
    }
  });

  // 圖例
  document.getElementById('legendCost').innerHTML = fStores.map(s=>
    `<div class="legend-item"><div class="legend-dot" style="background:${storeColors[s]};"></div>${s}</div>`
  ).join('');

  // 明細表
  const tbody = document.getElementById('tbodyCostDetail');
  const rows = [];
  const storeTotals = {};
  fStores.forEach(s=>{ storeTotals[s]={ gross:0, er:0, supportIn:0, supportOut:0, actual:0, total:0 }; });

  fStores.forEach(store=>{
    ymList.forEach(ym=>{
      let grossSum=0, erSum=0;
      const grossDetails=[], erDetails=[], recNames = new Set();
      Object.values(salaryMap[ym]||{}).filter(r=>r._store===store).forEach(rec=>{
        const role = effR(null, rec), name = rec.empName||'';
        const g = calcGross(rec, role), e = calcErBurden(rec, role);
        grossSum += g; erSum += e;
        grossDetails.push({ name, role, gross:g });
        erDetails.push({ name, role, er:e });
        recNames.add(name);
      });
      // 補算無薪資記錄員工的公司負擔
      allEmps.filter(e=>e.store===store && isEmpActiveInMonth(e,ym) && !recNames.has(e.name)).forEach(emp=>{
        const fakeRec = { baseSalary:emp.baseSalary||0, fullAttendBonus:emp.fullAttendBonus||0, wage:emp.wage||0, laborEr:0, healthEr:0, pensionEr:0 };
        const e2 = calcErBurden(fakeRec, emp.role||'');
        erSum += e2;
        erDetails.push({ name:emp.name, role:emp.role||'', er:e2 });
      });
      const key = store+'|'+ym;
      window._costDetailData[key] = { grossDetails, erDetails, inDetails:supportInDetails[key]||[], outDetails:supportOutDetails[key]||[] };
      const supportIn  = inMatrix[store]?.[ym]||0;
      const supportOut = outMatrix[store]?.[ym]||0;
      const actual     = grossSum + supportIn - supportOut;
      const total      = actual + erSum;
      rows.push({ store, ym, gross:grossSum, er:erSum, supportIn, supportOut, actual, total });
      storeTotals[store].gross    += grossSum;
      storeTotals[store].er       += erSum;
      storeTotals[store].supportIn  += supportIn;
      storeTotals[store].supportOut += supportOut;
      storeTotals[store].actual   += actual;
      storeTotals[store].total    += total;
    });
  });

  const mkRow = (cells, cls='') =>
    `<tr class="${cls}">${cells.map((c,i)=>`<td class="${i>=2?'num':''}">${c}</td>`).join('')}</tr>`;

  const fmtIn  = v => v > 0 ? `<span style="color:var(--danger);">+$${comma(v)}</span>` : '—';
  const fmtOut = v => v > 0 ? `<span style="color:var(--accent);">-$${comma(v)}</span>` : '—';

  let html = '';
  fStores.forEach(store=>{
    const color = storeColors[store];
    rows.filter(r=>r.store===store).forEach(r=>{
      const st = r.store.replace(/'/g,"\\'"), ym2 = r.ym;
      html += mkRow([
        `<span class="store-badge" style="background:${color};">${r.store}</span>`,
        r.ym.replace('-','年').replace(/^(\d+)年0?(\d+)$/,'$1年$2月'),
        `<span class="detail-clickable" onclick="showCostDetail('${st}','${ym2}','gross')">$${comma(r.gross)}</span>`,
        `<span class="detail-clickable" onclick="showCostDetail('${st}','${ym2}','er')">$${comma(r.er)}</span>`,
        r.supportIn>0?`<span class="detail-clickable" onclick="showCostDetail('${st}','${ym2}','in')">${fmtIn(r.supportIn)}</span>`:'—',
        r.supportOut>0?`<span class="detail-clickable" onclick="showCostDetail('${st}','${ym2}','out')">${fmtOut(r.supportOut)}</span>`:'—',
        '<strong>$'+comma(r.actual)+'</strong>',
        '$'+comma(r.total)
      ]);
    });
    const t = storeTotals[store];
    html += mkRow([
      `<strong>${store} 小計</strong>`,'—',
      '$'+comma(t.gross),'$'+comma(t.er),
      fmtIn(t.supportIn), fmtOut(t.supportOut),
      '<strong>$'+comma(t.actual)+'</strong>', '$'+comma(t.total)
    ], 'store-subtotal');
  });

  const grand = Object.values(storeTotals).reduce((a,b)=>({
    gross:a.gross+b.gross, er:a.er+b.er,
    supportIn:a.supportIn+b.supportIn, supportOut:a.supportOut+b.supportOut,
    actual:a.actual+b.actual, total:a.total+b.total
  }),{gross:0,er:0,supportIn:0,supportOut:0,actual:0,total:0});
  html += mkRow([
    '<strong>合計</strong>','—',
    '$'+comma(grand.gross),'$'+comma(grand.er),
    fmtIn(grand.supportIn), fmtOut(grand.supportOut),
    '<strong>$'+comma(grand.actual)+'</strong>', '$'+comma(grand.total)
  ], 'grand-total');
  tbody.innerHTML = html;

  // D. 手機卡片
  const costCardList = document.getElementById('costCardList');
  if(costCardList){
    let ch='';
    fStores.forEach(store=>{
      rows.filter(r=>r.store===store).forEach(r=>{
        ch+=`<div class="m-card">
          <div class="m-card-hd"><span class="store-badge" style="background:${storeColors[store]};">${r.store}</span><span style="font-size:12px;color:var(--text-muted);font-weight:700;">${r.ym.replace('-','年').replace(/^(\d+)年0?(\d+)$/,'$1年$2月')}</span></div>
          <div class="m-card-main">$${comma(r.actual)}</div>
          <div class="m-card-grid">
            <div class="m-card-row">本月薪資合計 <span>$${comma(r.gross)}</span></div>
            <div class="m-card-row">公司負擔合計 <span>$${comma(r.er)}</span></div>
            ${r.supportIn>0?`<div class="m-card-row">被支援費用 <span style="color:var(--danger);">+$${comma(r.supportIn)}</span></div>`:''}
            ${r.supportOut>0?`<div class="m-card-row">支援別人 <span style="color:var(--accent);">-$${comma(r.supportOut)}</span></div>`:''}
            <div class="m-card-row" style="grid-column:span 2;">含公司負擔 <span>$${comma(r.total)}</span></div>
          </div>
        </div>`;
      });
    });
    costCardList.innerHTML = ch||'<div class="empty-state">無資料</div>';
  }
}

// ===== 加班/國假 Tab =====
function renderOtTab(){
  const { ymList, stores, allEmps, salaryMap } = analysisData;
  const fEmps = getFE(); const fStores = getFS();
  const storeColors = {};
  stores.forEach((s,i)=>storeColors[s]=STORE_COLORS[i%STORE_COLORS.length]);

  const otByYm = {}, holByYm = {};
  ymList.forEach(ym=>{ otByYm[ym]=0; holByYm[ym]=0; });
  fEmps.forEach(emp=>{
    ymList.forEach(ym=>{
      if(!isEmpActiveInMonth(emp,ym)) return;
      const rec = salaryMap[ym]?.[emp.name];
      if(!rec) return;
      otByYm[ym] += calcOtPay(rec);
      holByYm[ym] += emp.role==='工讀'?Math.round(n(rec.wage)*n(rec.holidayHours)):n(rec.holidayOtPay);
    });
  });

  if(chartOtHoliday) chartOtHoliday.destroy();
  const ctx2 = document.getElementById('chartOtHoliday').getContext('2d');
  chartOtHoliday = new Chart(ctx2, {
    type:'bar',
    data:{
      labels: ymList.map(ym=>{ const[y,m]=ym.split('-'); return `${parseInt(m)}月`; }),
      datasets:[
        { label:'加班費', data:ymList.map(ym=>otByYm[ym]), backgroundColor:'#1a73e8aa', borderColor:'#1a73e8', borderWidth:1.5 },
        { label:'國定假日費用', data:ymList.map(ym=>holByYm[ym]), backgroundColor:'#f9ab00aa', borderColor:'#f9ab00', borderWidth:1.5 }
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'top', labels:{ font:{ size:11, weight:'700' } } } },
      scales:{
        y:{ ticks:{ callback:v=>'$'+v.toLocaleString() }, grid:{color:'#f1f3f4'} },
        x:{ grid:{display:false} }
      }
    }
  });

  const empOtRows = [];
  fEmps.forEach(emp=>{
    // 每月一列（分析多月時看得出是哪個月）
    ymList.forEach(ym=>{
      if(!isEmpActiveInMonth(emp,ym)) return;
      const rec = salaryMap[ym]?.[emp.name];
      if(!rec) return;
      const otH=n(rec.otHours), otAmt=calcOtPay(rec);
      const holH=n(rec.holidayHours), holAmt=emp.role==='工讀'?Math.round(n(rec.wage)*holH):n(rec.holidayOtPay);
      if(otAmt>0||holAmt>0)
        empOtRows.push({ emp, ym, totOtH:otH, totOtAmt:otAmt, totHolH:holH, totHolAmt:holAmt, total:otAmt+holAmt });
    });
  });
  // 月份新到舊；同月依合計高到低
  empOtRows.sort((a,b)=> a.ym!==b.ym ? b.ym.localeCompare(a.ym) : b.total-a.total);

  const tbody = document.getElementById('tbodyOtDetail');
  if(!empOtRows.length){
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">本區間無加班/國假費用記錄</td></tr>';
    return;
  }
  tbody.innerHTML = empOtRows.map(r=>{
    const color = storeColors[r.emp.store];
    return `<tr>
      <td style="white-space:nowrap;font-weight:700;">${r.ym.slice(0,4)}/${r.ym.slice(5)}</td>
      <td><span class="store-badge" style="background:${color};">${r.emp.store}</span></td>
      <td><strong>${dispName(r.emp.name)}</strong></td>
      <td>${r.emp.role||'--'}</td>
      <td class="num">${r.totOtH}h</td>
      <td class="num">$${comma(r.totOtAmt)}</td>
      <td class="num">${r.totHolH}h</td>
      <td class="num">$${comma(r.totHolAmt)}</td>
      <td class="num"><strong>$${comma(r.total)}</strong></td>
    </tr>`;
  }).join('');

  // D. 手機卡片
  const otCardList = document.getElementById('otCardList');
  if(otCardList){
    otCardList.innerHTML = empOtRows.map(r=>{
      const color = storeColors[r.emp.store]||'#1a73e8';
      return `<div class="m-card">
        <div class="m-card-hd">
          <span class="store-badge" style="background:#64748b;">${r.ym.slice(0,4)}/${r.ym.slice(5)}</span>
          <span class="store-badge" style="background:${color};">${r.emp.store}</span>
          <strong style="font-size:13px;">${dispName(r.emp.name)}</strong>
          <span style="font-size:11px;color:var(--text-muted);">${r.emp.role||'--'}</span>
        </div>
        <div class="m-card-main">$${comma(r.total)}</div>
        <div class="m-card-grid">
          <div class="m-card-row">加班費 <span>$${comma(r.totOtAmt)}</span></div>
          <div class="m-card-row">國假費用 <span>$${comma(r.totHolAmt)}</span></div>
        </div>
      </div>`;
    }).join('') || '<div class="empty-state">本區間無加班/國假記錄</div>';
  }
}

// ===== 薪資異常 Tab =====
function renderAnomalyTab(){
  if(!analysisData){ document.getElementById('anomalyContent').innerHTML='<div class="empty-state">請先執行分析</div>'; return 0; }
  const { ymList, stores, allEmps, salaryMap } = analysisData;
  const fEmps = getFE();
  const pctThreshold = parseFloat(document.getElementById('anomalyPct').value)||20;
  const otHLimit = parseFloat(document.getElementById('anomalyOtH').value)||46;

  const anomalies = [];

  fEmps.forEach(emp=>{
    ymList.forEach((ym,idx)=>{
      if(!isEmpActiveInMonth(emp,ym)) return;
      const rec = salaryMap[ym]?.[emp.name];
      if(!rec) return;

      // 1. 比上月波動
      if(idx>0){
        const prevYm = ymList[idx-1];
        const prevRec = salaryMap[prevYm]?.[emp.name];
        if(prevRec){
          const cur = calcGross(rec,emp.role), prev = calcGross(prevRec,emp.role);
          if(prev>0){
            const pct = Math.round((cur-prev)/prev*100);
            if(Math.abs(pct)>=pctThreshold)
              anomalies.push({ type:'wave', emp, ym, prevYm,
                msg:`${pct>0?'+':''}${pct}%`, badge:pct>0?'up':'down',
                badgeText:(pct>0?'↑':'↓')+Math.abs(pct)+'%',
                prevAmount:prev, amount:cur });
          }
        }
      }

      // 2. 加班分級預警（黃/紅/嚴重）— 以 otHLimit 為紅線(§32 每月46h)，黃=紅-6、嚴重=紅+8
      const otH = n(rec.otHours);
      const redLine = otHLimit, yellowLine = Math.max(1, otHLimit - 6), severeLine = otHLimit + 8;
      if(otH >= yellowLine){
        let otLevel, badgeText;
        if(otH >= severeLine){ otLevel='severe'; badgeText='⛔加班嚴重'; }
        else if(otH >= redLine){ otLevel='red'; badgeText='🔴加班超46h'; }
        else { otLevel='yellow'; badgeText='⚠️加班接近'; }
        anomalies.push({ type:'ot', emp, ym, otLevel,
          msg:`加班 ${otH}h（黃${yellowLine}／紅${redLine}／嚴重${severeLine}）`,
          badge:'ot', badgeText, amount:calcOtPay(rec) });
      }

      // 3. 未完成確認
      if(rec._tabConfirmed !== undefined){
        const cfm = rec._tabConfirmed||{};
        const missing = [0,1,2].filter(i=>!cfm[i]).map(i=>['考勤','薪資','代扣'][i]);
        if(missing.length)
          anomalies.push({ type:'unconfirmed', emp, ym, msg:`未確認：${missing.join('、')}`, badge:'unconfirmed', badgeText:'未確認', amount:0 });
      }
    });
  });

  const storeColors = {};
  stores.forEach((s,i)=>storeColors[s]=STORE_COLORS[i%STORE_COLORS.length]);

  const el = document.getElementById('anomalyContent');
  if(!anomalies.length){
    el.innerHTML = `<div class="empty-state">✅ 本區間無異常記錄</div>`; return 0;
  }

  // 依類型分組
  const groups = { wave:'💰 薪資波動', ot:'⚡ 加班超時', unconfirmed:'📋 未完成確認' };
  let html = '';
  Object.keys(groups).forEach(type=>{
    const items = anomalies.filter(a=>a.type===type);
    if(!items.length) return;
    const isWave = type==='wave';
    html += `<div class="section-title">${groups[type]}（${items.length} 筆）</div>`;
    html += `<div style="overflow-x:auto;"><table class="data-table"><thead><tr>
      <th>門市</th><th>姓名</th><th>月份</th><th>異常說明</th>
      ${isWave ? `<th class="num">前月應發</th><th class="num">本月應發</th>` : `<th class="num">金額</th>`}
    </tr></thead><tbody>`;
    items.forEach(a=>{
      const color = storeColors[a.emp.store];
      const amtCell = isWave
        ? `<td class="num" style="color:var(--text-muted);font-size:12px;">$${comma(a.prevAmount)}</td>
           <td class="num"><strong style="color:${a.badge==='up'?'var(--danger)':'var(--accent)'};">$${comma(a.amount)}</strong></td>`
        : `<td class="num">${a.amount>0?'$'+comma(a.amount):'—'}</td>`;
      html += `<tr>
        <td><span class="store-badge" style="background:${color};">${a.emp.store}</span></td>
        <td><strong>${dispName(a.emp.name)}</strong></td>
        <td style="white-space:nowrap;">${a.prevYm??''}<br><span style="font-weight:900;">${a.ym}</span></td>
        <td><span class="warn-badge ${a.badge}">${a.badgeText}</span> ${a.msg}</td>
        ${amtCell}
      </tr>`;
    });
    html += '</tbody></table></div><div style="height:12px;"></div>';
  });
  el.innerHTML = html;
  return anomalies.length;
}

// ===== 員工時薪 Tab =====
function renderHourlyTab(){
  if(!analysisData) return;
  const { ymList, stores, allEmps, salaryMap, supportMap } = analysisData;
  const storeColors = {};
  stores.forEach((s,i)=>storeColors[s]=STORE_COLORS[i%STORE_COLORS.length]);

  // 每人取最後一個有記錄的月份算時薪
  const hourlyRows = [];
  allEmps.filter(e=>e.role!=='工讀').forEach(emp=>{
    let rec = null;
    for(let i=ymList.length-1;i>=0;i--){
      rec = salaryMap[ymList[i]]?.[emp.name];
      if(rec) break;
    }
    if(!rec) return;

    const isPart = recIsPart(emp, rec); // 以該記錄月判身份：工讀轉正職者過去月份仍算工讀時薪(不會變 0)
    const base = n(rec.baseSalary);
    const fullAttend = n(rec.fullAttendBonus);
    const hrRate = isPart ? n(rec.wage) : (base+fullAttend)/30/8;

    let supportH=0, supportCost=0;
    ymList.forEach(ym=>{
      (supportMap[ym]?.[emp.name]||[]).forEach(s=>{
        const mRec = salaryMap[ym]?.[emp.name];
        // 以「支援當月」的記錄判身份與時薪
        const mIsPart = recIsPart(emp, mRec||rec);
        const rate = mIsPart ? n((mRec&&mRec.wage)||rec.wage) : ((mRec ? n(mRec.baseSalary)+n(mRec.fullAttendBonus) : base+fullAttend)/30/8);
        supportH = Math.round((supportH+s.hours)*10)/10;
        supportCost += Math.round(rate*s.hours);
      });
    });

    hourlyRows.push({ emp, base, fullAttend, hrRate, supportH, supportCost, isPart });
  });

  const tbody1 = document.getElementById('tbodyHourlyRate');
  tbody1.innerHTML = !hourlyRows.length
    ? '<tr><td colspan="8" class="empty-state">無正職員工薪資資料</td></tr>'
    : hourlyRows.map(r=>{
        const color = storeColors[r.emp.store];
        return `<tr>
          <td><span class="store-badge" style="background:${color};">${r.emp.store}</span></td>
          <td><strong>${dispName(r.emp.name)}</strong></td>
          <td>${r.emp.role||'--'}${r.isPart?'<span style="color:#e67e22;font-size:11px;"> (工讀計)</span>':''}</td>
          <td class="num">${r.isPart?'—':'$'+comma(r.base)}</td>
          <td class="num">${r.isPart?'—':'$'+comma(r.fullAttend)}</td>
          <td class="num"><strong>$${Math.round(r.hrRate).toLocaleString()}/h</strong></td>
          <td class="num">${r.supportH>0?r.supportH+'h':'—'}</td>
          <td class="num">${r.supportCost>0?'$'+comma(r.supportCost):'—'}</td>
        </tr>`;
      }).join('');

  // 跨店支援明細（逐筆展開）
  const supportRows = [];
  ymList.forEach(ym=>{
    Object.entries(supportMap[ym]||{}).forEach(([empName, supports])=>{
      const emp = allEmps.find(e=>e.name===empName);
      const rec = salaryMap[ym]?.[empName];
      supports.forEach(s=>{
        const isPart = recIsPart(emp, rec); // 以支援當月記錄判身份(工讀轉正職者過去月份仍工讀時薪)
        let hrRate;
        if(isPart){
          hrRate = n(rec?.wage||emp?.wage||0);
        } else {
          hrRate = (n(rec?.baseSalary||0)+n(rec?.fullAttendBonus||0))/30/8;
        }
        supportRows.push({ ym, empName, role:(isPart?'工讀':(rec?.role||emp?.role||'--')), fromStore:s.fromStore, toStore:s.toStore, hours:s.hours, hrRate, cost:Math.round(hrRate*s.hours) });
      });
    });
  });
  supportRows.sort((a,b)=>a.ym.localeCompare(b.ym)||(a.fromStore.localeCompare(b.fromStore)));

  const tbody2 = document.getElementById('tbodySupportDetail');
  tbody2.innerHTML = !supportRows.length
    ? '<tr><td colspan="7" class="empty-state">本區間無跨店支援記錄</td></tr>'
    : supportRows.map(r=>{
        const fc = storeColors[r.fromStore]||'#888';
        const tc = storeColors[r.toStore]||'#888';
        return `<tr>
          <td>${r.ym.replace(/^(\d+)-0?(\d+)$/,'$1年$2月')}</td>
          <td><strong>${dispName(r.empName)}</strong><br><span style="font-size:10px;color:var(--text-muted);">${r.role}</span></td>
          <td><span class="store-badge" style="background:${fc};">${r.fromStore}</span></td>
          <td><span class="store-badge" style="background:${tc};">${r.toStore}</span></td>
          <td class="num">${r.hours}h</td>
          <td class="num">$${Math.round(r.hrRate).toLocaleString()}/h</td>
          <td class="num"><strong>$${comma(r.cost)}</strong></td>
        </tr>`;
      }).join('');
}

// ===== C. 篩選器 =====
let filterState = { stores: new Set(), roles: new Set(['正職','工讀']) };
function getFE(){
  if(!analysisData) return [];
  return analysisData.allEmps.filter(e=>{
    if(!filterState.stores.has(e.store)) return false;
    // 店長/加盟主 視同「正職」歸類，確保不被排除
    const r = e.role||'正職';
    const bucket = (r==='店長'||r==='加盟主') ? '正職' : r;
    return filterState.roles.has(bucket);
  });
}
function getFS(){
  if(!analysisData) return [];
  return analysisData.stores.filter(s=>filterState.stores.has(s));
}
function initFilterState(){
  filterState.stores = new Set(analysisData.stores);
  filterState.roles  = new Set(['正職','工讀']);
  const sc = document.getElementById('storeChips');
  sc.innerHTML = analysisData.stores.map(s=>`<div class="chip active" onclick="toggleStoreChip(this,'${s.replace(/'/g,"\\'")}')">${s}</div>`).join('');
  const rc = document.getElementById('roleChips');
  rc.innerHTML = ['正職','工讀'].map(r=>`<div class="chip active" onclick="toggleRoleChip(this,'${r}')">${r}</div>`).join('');
  document.getElementById('filterCard').style.display = 'block';
}
function toggleStoreChip(el, store){
  if(filterState.stores.has(store)){
    if(filterState.stores.size<=1){ showToast('⚠️ 至少保留一個門市'); return; }
    filterState.stores.delete(store); el.classList.remove('active');
  } else { filterState.stores.add(store); el.classList.add('active'); }
  reRenderCurrentTab();
}
function toggleRoleChip(el, role){
  if(filterState.roles.has(role)){
    if(filterState.roles.size<=1){ showToast('⚠️ 至少保留一個身份'); return; }
    filterState.roles.delete(role); el.classList.remove('active');
  } else { filterState.roles.add(role); el.classList.add('active'); }
  reRenderCurrentTab();
}
function reRenderCurrentTab(){
  const id = document.querySelector('.tab-item.active')?.id?.replace('tab-','');
  if(id==='cost') renderCostTab();
  else if(id==='ot'){ renderOtTab(); renderAnomalyTab(); }
  else if(id==='hourly') renderHourlyTab();
}

// ===== 勞退欄切換 =====
function togglePensionCol(){
  const show = document.getElementById('showPensionCol').checked;
  const table = document.getElementById('tableCostDetail');
  if(table) table.classList.toggle('hide-pension', !show);
  if(analysisData) renderCostTab(); // 重算實際成本
}

// ===== B. 異常 badge & alert =====
function updateAnomalyBadge(count){
  const tab = document.getElementById('tab-ot');
  if(!tab) return;
  tab.innerHTML = count>0
    ? `⚡ 加班與異常 <span style="background:var(--danger);color:white;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;margin-left:3px;">${count}</span>`
    : '⚡ 加班與異常';
}
function dismissAnomalyAlert(){
  const bar = document.getElementById('anomalyAlertBar');
  if(bar) bar.style.display='none';
}

// ===== F. 匯出 dropdown =====
function toggleExportDropdown(){ document.getElementById('exportDropdown').classList.toggle('open'); }
function closeExportDropdown(){ document.getElementById('exportDropdown').classList.remove('open'); }
document.addEventListener('click', e=>{ if(!e.target.closest('.export-dropdown-wrap')) closeExportDropdown(); });

// ===== J. 右滑返回 =====
(function(){
  let sx=0;
  document.addEventListener('touchstart', e=>{ sx=e.touches[0].clientX; }, {passive:true});
  document.addEventListener('touchend',   e=>{ if(e.changedTouches[0].clientX-sx>60) window.location.href=(new URLSearchParams(location.search).get('ref')||'home.html'); }, {passive:true});
})();

// ===== 匯出 =====
function exportCostTable(){
  if(!analysisData){ showToast('⚠️ 請先執行分析'); return; }
  const table = document.getElementById('tableCostDetail');
  const ws = XLSX.utils.table_to_sheet(table);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '人事成本');
  XLSX.writeFile(wb, `人事成本_${document.getElementById('selStartYear').value}${document.getElementById('selStartMonth').value}-${document.getElementById('selEndYear').value}${document.getElementById('selEndMonth').value}.xlsx`);
}

function exportOtTable(){
  if(!analysisData){ showToast('⚠️ 請先執行分析'); return; }
  const table = document.getElementById('tableOtDetail');
  const ws = XLSX.utils.table_to_sheet(table);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '加班國假');
  XLSX.writeFile(wb, `加班國假_${document.getElementById('selStartYear').value}${document.getElementById('selStartMonth').value}-${document.getElementById('selEndYear').value}${document.getElementById('selEndMonth').value}.xlsx`);
}

function exportHourlyTable(){
  if(!analysisData){ showToast('⚠️ 請先執行分析'); return; }
  const table = document.getElementById('tableHourlyRate');
  const ws = XLSX.utils.table_to_sheet(table);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '員工時薪');
  XLSX.writeFile(wb, `員工時薪_${document.getElementById('selStartYear').value}${document.getElementById('selStartMonth').value}-${document.getElementById('selEndYear').value}${document.getElementById('selEndMonth').value}.xlsx`);
}

// ===== 人事成本明細 Modal =====
window._costDetailData = {};

window.showCostDetail = function(store, ym, type) {
  const key = store+'|'+ym;
  const d = _costDetailData[key];
  if(!d) return;
  const ymLabel = ym.replace('-','年').replace(/^(\d+)年0?(\d+)$/, '$1年$2月');
  const comma = v => Math.round(v).toLocaleString();
  let title = '', rows = [], total = 0;

  if(type==='gross'){
    title = '本月薪資合計明細';
    rows = d.grossDetails.map(r=>`<div class="detail-row"><div><span>${r.name}</span><span class="detail-row-label" style="margin-left:8px;">${r.role}</span></div><div>$${comma(r.gross)}</div></div>`);
    total = d.grossDetails.reduce((s,r)=>s+r.gross,0);
  } else if(type==='er'){
    title = '公司負擔合計明細';
    rows = d.erDetails.map(r=>`<div class="detail-row"><div><span>${r.name}</span><span class="detail-row-label" style="margin-left:8px;">${r.role}</span></div><div>$${comma(r.er)}</div></div>`);
    total = d.erDetails.reduce((s,r)=>s+r.er,0);
  } else if(type==='in'){
    title = '被支援費用明細';
    rows = d.inDetails.map(r=>`<div class="detail-row"><div><span>${dispName(r.empName)}</span><span class="detail-row-label" style="margin-left:6px;">來自 ${r.fromStore}</span></div><div style="text-align:right;"><div style="font-size:11px;color:var(--text-muted);">$${comma(r.hrRate)}/h × ${r.hours}h</div><div>$${comma(r.amt)}</div></div></div>`);
    total = d.inDetails.reduce((s,r)=>s+r.amt,0);
  } else if(type==='out'){
    title = '支援別人明細';
    rows = d.outDetails.map(r=>`<div class="detail-row"><div><span>${dispName(r.empName)}</span><span class="detail-row-label" style="margin-left:6px;">→ ${r.toStore}</span></div><div style="text-align:right;"><div style="font-size:11px;color:var(--text-muted);">$${comma(r.hrRate)}/h × ${r.hours}h</div><div>$${comma(r.amt)}</div></div></div>`);
    total = d.outDetails.reduce((s,r)=>s+r.amt,0);
  }

  document.getElementById('costDetailTitle').textContent = title;
  document.getElementById('costDetailSub').textContent = `${store}・${ymLabel}`;
  document.getElementById('costDetailRows').innerHTML = rows.join('')||'<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">無資料</div>';
  document.getElementById('costDetailTotal').textContent = '$'+comma(total);
  document.getElementById('costDetailOverlay').classList.add('open');
}
window.closeCostDetail = function(){ document.getElementById('costDetailOverlay').classList.remove('open'); };
