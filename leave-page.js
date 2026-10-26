// ===== 全域狀態 =====
let currentUser = null, appConfig = { stores:[], shifts:[] };
let empList = [], batchesAll = {}, leaveLogAll = {}, displayNameMap = {};
let compDataAll = {}; // empName -> { current: {year, earned, used, remaining}, carried: {year, earned, used, remaining} }
let annUsageAll = {}, compUsageAll = {}; // 方案C 日期化帳本 empName -> [{date,store,source,savedBy,ts}]
let hireDateAll = {}, compPrevAll = {};   // 系統到職日（leaves/{今年}.hireDate）、去年 comp 文件原始資料（存摺期初用）
let pbTab = 'annual', pbShowAll = false;  // 存摺目前看特休還是補休、是否展開全部
let currentStore = '', currentTab = 'overview', currentViewEmp = '';
let urlMode = '';

// ===== 權限 =====
const isAdmin   = () => ['owner','admin'].includes(currentUser?.permission);
const isManager = () => ['manager','owner','admin'].includes(currentUser?.permission);
const myName    = () => currentUser?.empName || '';
const myStore   = () => currentUser?.store || '';

// ===== 工具 =====
function showLoading(m){document.getElementById('loadingText').textContent=m||'載入中...';const o=document.getElementById('loadingOverlay');o.classList.remove('hidden');o.style.display='flex';}
function hideLoading(){document.getElementById('loadingOverlay').classList.add('hidden');setTimeout(()=>{document.getElementById('loadingOverlay').style.display='none';},400);}
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
function openModal(id){document.getElementById(id).classList.add('active');}
function closeModal(id){document.getElementById(id).classList.remove('active');}
function handleBack(){if(window.history.length>1)window.history.back();else window.location.href='home.html';}
function today(){ return lvLocalYmd(); } // leave-rules.js
function fmtDate(s){if(!s)return '--';const[y,m,d]=s.split('-');return `${y}/${parseInt(m)}/${parseInt(d)}`;}
function getDN(n){return displayNameMap[n]||n;}
// 方案C：把某年度使用日期排成「4/21、4/22」字串（給概況卡內嵌顯示）
function daysUntil(s){if(!s)return null;const t=new Date(s);t.setHours(23,59,59);return Math.ceil((t-new Date())/86400000);}
function dateAdd(s,months){const d=new Date(s);d.setMonth(d.getMonth()+months);return d.toISOString().split('T')[0];}
function dateAddExpire(s,months){const d=new Date(s);d.setMonth(d.getMonth()+months);d.setDate(d.getDate()-1);return d.toISOString().split('T')[0];}
function monthsDiff(from,to){const f=new Date(from),t=new Date(to);return(t.getFullYear()-f.getFullYear())*12+(t.getMonth()-f.getMonth());}

// 判斷是否為「本月到期」
function isExpiringThisMonth(dateStr) {
  if(!dateStr) return false;
  const now = new Date();
  const exp = new Date(dateStr);
  return exp.getFullYear() === now.getFullYear() && exp.getMonth() === now.getMonth();
}

// ===== 勞基法週年制 =====
function annualLeaveRule(totalMonths) { // 天數規則在 leave-rules.js lvAnnualDays；這裡只加顯示文字
  const y = Math.floor(totalMonths / 12);
  const label = totalMonths < 6 ? '未滿6個月' : totalMonths < 12 ? '滿6個月' : `滿${y}年`;
  return { days: lvAnnualDays(totalMonths), label };
}

function calcBatchSchedule(hireDate) {
  if(!hireDate) return [];
  const now = new Date();
  const batches = [];
  // 滿6個月
  const m6Grant  = dateAdd(hireDate, 6);
  const m6Expire = dateAddExpire(hireDate, 12);
  if(new Date(m6Grant) <= now) {
    batches.push({ grantDate:m6Grant, expireDate:m6Expire, days:3, label:'滿6個月', months:6 });
  }
  // 每個週年
  for(let yr=1; yr<=30; yr++) {
    const grantDate  = dateAdd(hireDate, yr*12);
    const expireDate = dateAddExpire(hireDate, (yr+1)*12);
    if(new Date(grantDate) > now) break;
    const rule = annualLeaveRule(yr*12);
    if(rule.days > 0) {
      batches.push({ grantDate, expireDate, days:rule.days, label:rule.label, months:yr*12 });
    }
  }
  return batches;
}

// 取得下一個週年提醒（未來最近一個）
function getNextAnniversary(hireDate) {
  if(!hireDate) return null;
  const now = new Date();
  // 滿6個月
  const m6 = new Date(dateAdd(hireDate,6));
  if(m6 > now) return { date: dateAdd(hireDate,6), label:'滿6個月（3天）', months:6 };
  // 週年
  for(let yr=1; yr<=30; yr++) {
    const d = new Date(dateAdd(hireDate, yr*12));
    if(d > now) {
      const rule = annualLeaveRule(yr*12);
      return { date: dateAdd(hireDate, yr*12), label:`滿${yr}年（${rule.days}天）`, months:yr*12 };
    }
  }
  return null;
}

// ===== 初始化 =====
window.onload = async () => {
  showLoading('驗證登入狀態...');
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if(!saved){ window.location.replace('home.html'); return; }
  try{ currentUser=JSON.parse(saved); } catch(e){ window.location.replace('home.html'); return; }

  const _fbAuth = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(fb => { u(); r(fb); }); });
  if (!_fbAuth) { localStorage.removeItem('currentUser'); sessionStorage.removeItem('currentUser'); window.location.replace('home.html'); return; }

  showLoading('載入設定...');
  try{
    const cached = localStorage.getItem('appConfig');
    if(cached) try{ appConfig=JSON.parse(cached); }catch(e){}
    try{
      const snap = await Promise.race([
        window.db.collection('settings').doc('globalConfig').get(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5000))
      ]);
      if(snap.exists){ appConfig=snap.data(); localStorage.setItem('appConfig',JSON.stringify(appConfig)); }
    }catch(e){}

    urlMode = new URLSearchParams(window.location.search).get('mode') || '';
    currentStore = myStore();
    document.getElementById('headerBadge').textContent = currentStore;

    const accSnap = await window.db.collection('users').where('store','==',currentStore).get().catch(()=>null);
    if(accSnap) accSnap.forEach(d=>{ const a=d.data(); if(a.empName&&a.displayName) displayNameMap[a.empName]=a.displayName; });

    if(isManager()) document.getElementById('reportBtn').style.display='block';

    if(urlMode==='self') {
      document.getElementById('tabBar').style.display='none';
      currentViewEmp = myName();
      await loadEmpBatches(myName());
      await loadEmpComp(myName());
      renderMyView();
    } else if(urlMode==='mgmt' || isManager()) {
      document.getElementById('tabBar').style.display='flex';
      if(isAdmin()) setupStoreTabs();
      await loadAllEmps();
      renderOverview();
    } else {
      document.getElementById('tabBar').style.display='none';
      currentViewEmp = myName();
      await loadEmpBatches(myName());
      await loadEmpComp(myName());
      renderMyView();
    }

    await checkExpiredBatches();
    document.getElementById('appShell').classList.add('active');
    hideLoading();
  }catch(e){ hideLoading(); alert('載入失敗：'+e.message); }
};

// ===== 加盟主門市切換 =====
function setupStoreTabs() {
  const bar = document.getElementById('storeBar');
  bar.style.display = 'flex';
  bar.innerHTML = (appConfig.stores||[]).map(s=>
    `<button class="store-tab ${s===currentStore?'active':''}" onclick="switchMgmtStore('${s}')">${s}</button>`
  ).join('');
}
async function switchMgmtStore(store) {
  currentStore = store;
  document.getElementById('headerBadge').textContent = store;
  document.querySelectorAll('.store-tab').forEach(b=>b.classList.toggle('active',b.textContent===store));
  const accSnap = await window.db.collection('users').where('store','==',store).get().catch(()=>null);
  if(accSnap) accSnap.forEach(d=>{ const a=d.data(); if(a.empName&&a.displayName) displayNameMap[a.empName]=a.displayName; });
  await loadAllEmps();
  renderOverview();
}

// ===== 讀取所有員工 =====
async function loadAllEmps() {
  showLoading('讀取員工資料...');
  const todayStr = today();
  const empSnap = await window.db.collection('stores').doc(currentStore).collection('employees').get().catch(()=>null);
  empList = [];
  if(empSnap) empSnap.forEach(d=>{
    const data = d.data();
    const effectDate = data.retireDate || data.transferDate;
    const isEffective = ['離職','調走'].includes(data.status) && (!effectDate || todayStr >= effectDate);
    if(!isEffective) empList.push({ name:d.id, ...data });
  });
  empList.sort((a,b)=>(a.sortKey||0)-(b.sortKey||0));
  await Promise.all(empList.map(async emp => {
    await loadEmpBatches(emp.name);
    await loadEmpComp(emp.name);
  }));
  hideLoading();
}

// ===== 讀取特休批次 =====
async function loadEmpBatches(empName) {
  const [batchSnap, leaveSnap, logSnap, annUseSnap, compUseSnap] = await Promise.all([
    window.db.collection('employees').doc(empName).collection('leaveBatches').get().catch(()=>null),
    window.db.collection('employees').doc(empName).collection('leaves').doc(new Date().getFullYear().toString()).get().catch(()=>null),
    window.db.collection('employees').doc(empName).collection('leaveLog').get().catch(()=>null),
    window.db.collection('employees').doc(empName).collection('annualUsage').get().catch(()=>null),
    window.db.collection('employees').doc(empName).collection('compUsage').get().catch(()=>null)
  ]);

  // 方案C 日期化使用帳本（唯一真相）
  const annU=[], compU=[];
  if(annUseSnap) annUseSnap.forEach(d=>annU.push({ date:d.id, ...d.data() }));
  if(compUseSnap) compUseSnap.forEach(d=>compU.push({ date:d.id, ...d.data() }));
  annU.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  compU.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  annUsageAll[empName] = annU;
  compUsageAll[empName] = compU;

  let batches = [];
  if(batchSnap) batchSnap.forEach(d=>batches.push({id:d.id,...d.data()}));
  batches.sort((a,b)=>(a.grantDate||'').localeCompare(b.grantDate||''));
  batchesAll[empName] = batches;

  hireDateAll[empName] = (leaveSnap?.exists && leaveSnap.data()?.hireDate) || null;
  if(batches.length===0 && leaveSnap?.exists && leaveSnap.data()?.hireDate) {
    batchesAll[empName] = [{ _legacy: true, hireDate: leaveSnap.data().hireDate, ...leaveSnap.data() }];
  }

  let logs = [];
  // _i＝這筆在該月份文件 records 裡的位置（編輯／刪除要用）。畫面上的清單是跨月份、排序過、
  // 又濾掉使用紀錄的，它的序號跟 records 位置對不上——曾因此刪到別筆（2026-10-26 某正職的國定假日補休發放不見）。
  if(logSnap) logSnap.forEach(d=>{ const data=d.data(); (data.records||[]).forEach((r,i)=>logs.push({ym:d.id,...r,_i:i})); });
  logs.sort((a,b)=>(b.date||b.ym).localeCompare(a.date||a.ym));
  leaveLogAll[empName] = logs;
}

// ===== 讀取補休資料 =====
// 補休結構：employees/{empName}/comp/{year} -> { earned, used, carried(bool), carriedFrom, settledAt, settledDays }
// 「本年度」和「遞延」各一份
async function loadEmpComp(empName) {
  const thisYear = new Date().getFullYear();
  const prevYear = thisYear - 1;

  const [thisSnap, prevSnap] = await Promise.all([
    window.db.collection('employees').doc(empName).collection('comp').doc(String(thisYear)).get().catch(()=>null),
    window.db.collection('employees').doc(empName).collection('comp').doc(String(prevYear)).get().catch(()=>null)
  ]);

  const thisData = thisSnap?.exists ? thisSnap.data() : { earned:0, used:0 };
  const prevData = prevSnap?.exists ? prevSnap.data() : { earned:0, used:0 };
  compPrevAll[empName] = prevData;

  // 遞延的補休：上年度 carried=true 且未結算
  const carriedRemaining = prevData.carried && !prevData.settled
    ? Math.max(0, (prevData.earned||0) - (prevData.used||0) - (prevData.carriedUsed||0))
    : 0;

  compDataAll[empName] = {
    current: {
      year: thisYear,
      earned: thisData.earned||0,
      used: thisData.used||0,
      remaining: (thisData.earned||0)-(thisData.used||0), // 允許負數（應休未休撤回時可能為負）
      expireDate: `${thisYear}-12-31`,
      settled: thisData.settled||false
    },
    carried: carriedRemaining > 0 ? {
      year: prevYear,
      remaining: carriedRemaining,
      expireDate: `${thisYear}-12-31`, // 遞延後到本年底
      canCarryAgain: false, // 遞延只能一次
      settled: prevData.settled||false
    } : null
  };
}

// ===== 補休重算（方案C：委派給權威重算）=====
// used 來自 compUsage 日期化帳本、earned 來自 leaveLog(comp_earn/comp_cancel)，
// 遞延優先扣、其餘記當年度，並同步更新 leaves 與 comp。（recomputeCountersClient 已 hoist）
async function recalcCompCarriedFirst(empName, year) {
  await recomputeCountersClient(empName, String(year));
}

// ===== 計算特休概況 =====
function calcEmpSummary(empName) {
  const batches = batchesAll[empName] || [];
  const logs    = leaveLogAll[empName] || [];
  const todayStr = today();

  // 🌟 方案C：使用天數一律以「日期化帳本」筆數為準（唯一真相，不再從 leaveLog 淨額累計）
  const yStr = todayStr.slice(0,4);
  const usedAnnual = (annUsageAll[empName]||[]).filter(u=>String(u.date||'').startsWith(yStr)).length;
  const usedComp   = (compUsageAll[empName]||[]).filter(u=>String(u.date||'').startsWith(yStr)).length;
  // 補休「取得」仍記在 leaveLog（國定假日/例休未休/手動）
  let earnedComp=0;
  logs.forEach(r=>{
    const d=parseFloat(r.days)||0;
    if(r.type==='comp_earn')   earnedComp+=d;
    if(r.type==='comp_cancel') earnedComp=Math.max(0,earnedComp-d);
  });

  let activeDays=0, carriedDays=0, nearExpire=null;
  batches.filter(b=>!b._legacy).forEach(b=>{
    const remaining = (b.days||0)-(b.used||0);
    if(remaining<=0||b.settled) return;
    const settleDate = b.carried ? dateAddExpire(b.expireDate, 12) : b.expireDate;
    if(b.carried) {
      if(todayStr<=settleDate) carriedDays+=remaining;
    } else {
      if(todayStr<=b.expireDate) activeDays+=remaining;
    }
    const exp = b.carried ? settleDate : b.expireDate;
    if(!nearExpire||exp<nearExpire) nearExpire=exp;
  });

  const cd = compDataAll[empName];
  const compCurrentRemain = cd?.current?.remaining || 0;
  const compCarriedRemain = cd?.carried?.remaining || 0;

  return {
    activeDays, carriedDays,
    totalAvail: activeDays+carriedDays,
    usedAnnual, earnedComp, usedComp,
    remainComp: compCurrentRemain,
    remainCompCarried: compCarriedRemain,
    nearExpire
  };
}

// ===== 存摺（leave-passbook.js 的純計算，畫面上所有特補休數字都從這裡來）=====
function getBooks(empName) {
  const emp = empList.find(e=>e.name===empName) || {};
  const hire = getHireDate(empName);
  const isPT = (emp.role||'').includes('工讀');   // 工讀特休規則未定案 → 不列「週年沒建批次」
  const todayStr = today();
  return {
    annual: pbAnnualBook({ batches: batchesAll[empName]||[], usage: annUsageAll[empName]||[], logs: leaveLogAll[empName]||[],
      schedule: (hire && !isPT) ? calcBatchSchedule(hire) : [], today: todayStr }),
    comp: pbCompBook({ logs: leaveLogAll[empName]||[], usage: compUsageAll[empName]||[], prev: compPrevAll[empName]||{},
      year: todayStr.slice(0,4), today: todayStr }),
  };
}
// 批次目前剩幾天（帳本先拿到先用分配；批次上的 used 是快取，不準）
function batchRemain(empName, b) {
  const r = getBooks(empName).annual.batchRem[b.id];
  return r == null ? Math.max(0,(b.days||0)-(b.used||0)) : r;
}

// ===== 取得需要提醒的到期批次（本月到期）=====
function getExpiringBatches(empName) {
  const batches = batchesAll[empName] || [];
  return batches.filter(b=>{
    if(b._legacy||b.settled) return false;
    if(batchRemain(empName, b)<=0) return false;
    const expDate = b.carried ? dateAddExpire(b.expireDate, 12) : b.expireDate;
    return isExpiringThisMonth(expDate);
  });
}

// 取得需要提醒的補休（本月為12月 or 上年遞延補休本月到期）
function getExpiringComp(empName) {
  const cd = compDataAll[empName];
  if(!cd) return [];
  const result = [];
  const now = new Date();
  const isDecember = now.getMonth() === 11;

  // 本年度補休：12月到期
  if(isDecember && cd.current && !cd.current.settled && cd.current.remaining > 0) {
    result.push({ type:'current', year: cd.current.year, remaining: cd.current.remaining, canCarry: true });
  }
  // 遞延補休：本月到期（同樣12/31，但不可再延）
  if(isDecember && cd.carried && !cd.carried.settled && cd.carried.remaining > 0) {
    result.push({ type:'carried', year: cd.carried.year, remaining: cd.carried.remaining, canCarry: false });
  }
  return result;
}

// ===== 自動檢查到期批次 =====
async function checkExpiredBatches() {
  const todayStr = today();
  const emps = empList.length > 0 ? empList : [{ name: myName() }];
  for(const emp of emps) {
    const batches = batchesAll[emp.name] || [];
    for(const b of batches) {
      if(b._legacy||b.settled||b.carried) continue;
      const remaining = (b.days||0)-(b.used||0);
      if(remaining<=0) continue;
      // 週年日已過 → 自動標記「需處理」但不自動遞延，等店長手動操作
      // 不在這裡自動遞延，改由 UI 引導店長操作
    }
  }
}

// ===== 渲染：管理者總覽 =====
function renderOverview() {
  const el = document.getElementById('mainContent');
  if(!empList.length){ el.innerHTML=`<div class="empty-state"><div class="empty-icon">👥</div><div>無員工資料</div></div>`; return; }

  let html='';

  // 週年到職提醒（今天）
  const todayStr = today();
  empList.forEach(emp=>{
    let hireDate = getHireDate(emp.name);
    if(!hireDate) return;
    const next = getNextAnniversary(hireDate);
    if(next && next.date === todayStr) {
      html+=`<div class="alert-banner info"><div class="alert-banner-icon">🎉</div><div class="alert-banner-text">今天是 ${getDN(emp.name)} 的週年日！請至明細更新特休批次（${next.label}）</div></div>`;
    }
  });

  // 本月到期警示
  const expiring = empList.filter(emp=>getExpiringBatches(emp.name).length>0||getExpiringComp(emp.name).length>0);
  if(expiring.length>0) {
    html+=`<div class="alert-banner" style="cursor:pointer;" onclick="switchTab('detail')"><div class="alert-banner-icon">⏰</div><div class="alert-banner-text">有 ${expiring.length} 位員工的特休/補休本月到期，須在薪資送出前完成處理！</div><div style="font-size:16px;">›</div></div>`;
  }

  // 員工卡片
  html += empList.map(emp => {
    const rawBatches = batchesAll[emp.name]||[];
    const batches = rawBatches.filter(b=>!b._legacy);
    let hireDate = getHireDate(emp.name);
    const needSetup = !hireDate;
    const bk = getBooks(emp.name);
    const hasExpiring = getExpiringBatches(emp.name).length>0||getExpiringComp(emp.name).length>0;
    const avatarColor = emp.role==='店長'?'linear-gradient(135deg,#9334e6,#6a1bb5)':emp.role==='正職'?'linear-gradient(135deg,#34a853,#1e7e34)':'linear-gradient(135deg,#1a73e8,#0d47a1)';

    return `<div class="emp-card" onclick="openEmpDetail('${emp.name}')">
      <div class="emp-card-header">
        <div class="emp-avatar" style="background:${avatarColor};">${getDN(emp.name)[0]}</div>
        <div class="emp-info">
          <div class="emp-name">${getDN(emp.name)}${hasExpiring?` <span style="color:var(--danger);font-size:11px;">⚠️ 待處理</span>`:''}</div>
          <div class="emp-role">${emp.role||''}</div>
          <div class="leave-chips">
            ${needSetup
              ? `<span class="lchip warn">⚠️ 尚未建檔</span>`
              : `<span class="lchip annual">特休 ${bk.annual.balance} 天</span>
                 <span class="lchip comp">補休 ${bk.comp.balance} 天</span>
                 ${bk.annual.todo>0?`<span class="lchip warn">⚠️ ${bk.annual.todo} 件待處理</span>`:''}
                 ${bk.annual.nextExpire&&daysUntil(bk.annual.nextExpire.date)<=30?`<span class="lchip expire">⏰ ${daysUntil(bk.annual.nextExpire.date)}天後到期</span>`:''}`
            }
          </div>
        </div>
        <div style="font-size:18px;color:var(--text-muted);">›</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = html;
}

// ===== 員工個人視圖 =====
function renderMyView() {
  currentViewEmp = myName();
  renderEmpDetail(myName(), false);
}

function openEmpDetail(empName) {
  currentViewEmp = empName;
  currentTab = 'detail';
  document.querySelectorAll('.tab-item').forEach(el=>el.classList.remove('active'));
  document.getElementById('tab-detail')?.classList.add('active');
  renderEmpDetail(empName, true);
}

// ===== 取得到職日 =====
function getHireDate(empName) { return hireDateAll[empName] || getHireDateFromBatches(batchesAll[empName]||[]); }
function getHireDateFromBatches(rawBatches) {
  if(!rawBatches||rawBatches.length===0) return null;
  const legacy = rawBatches.find(b=>b._legacy);
  if(legacy?.hireDate) return legacy.hireDate;
  const first = rawBatches.filter(b=>!b._legacy).sort((a,b)=>a.grantDate?.localeCompare(b.grantDate))[0];
  if(first?.grantDate) {
    const offsetMonths = first.months || 6;
    return dateAdd(first.grantDate, -offsetMonths);
  }
  return null;
}

// ===== 員工詳細頁 =====
function renderEmpDetail(empName, showBack=true) {
  const el = document.getElementById('mainContent');
  const emp = empList.find(e=>e.name===empName)||{ name:empName, role:currentUser?.role||'' };
  const rawBatches = batchesAll[empName]||[];
  const batches = rawBatches.filter(b=>!b._legacy);
  const logs = leaveLogAll[empName]||[];
  const hireDate = getHireDate(empName);
  const isPartTime = (emp.role||'').includes('工讀');
  const canEdit = isManager();
  const todayStr = today();

  const expiringBatches = getExpiringBatches(empName);
  const expiringComp = getExpiringComp(empName);
  const hasUrgent = expiringBatches.length>0||expiringComp.length>0;

  let html = '';
  if(showBack) html+=`<button onclick="switchTab('overview')" style="background:none;border:none;color:var(--primary);font-size:13px;font-weight:700;cursor:pointer;padding:4px 0;margin-bottom:12px;">← 回總覽</button>`;

  // 員工標題
  const avatarColor = emp.role==='店長'?'linear-gradient(135deg,#9334e6,#6a1bb5)':emp.role==='正職'?'linear-gradient(135deg,#34a853,#1e7e34)':'linear-gradient(135deg,#1a73e8,#0d47a1)';
  html+=`<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
    <div class="emp-avatar" style="background:${avatarColor};width:44px;height:44px;">${getDN(empName)[0]}</div>
    <div><div style="font-size:17px;font-weight:900;">${getDN(empName)}</div><div style="font-size:12px;color:var(--text-muted);">${emp.role||''}</div></div>
    ${canEdit?`<button onclick="openHireDateModal('${empName}')" style="margin-left:auto;background:#f1f3f4;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">✏️ 修改到職日</button>`:''}
  </div>`;

  // ⚠️ 到期待處理警示（本月）
  if(canEdit && hasUrgent) {
    expiringBatches.forEach(b=>{
      const remaining = batchRemain(empName, b);
      const expDate = b.carried ? dateAddExpire(b.expireDate,12) : b.expireDate;
      const canCarry = !b.carried; // 遞延批次不可再延
      html+=`<div class="expire-alert" onclick="openSettleCarryModal('${empName}','${b.id}',${canCarry})">
        <div class="expire-alert-title">⚠️ 特休到期：${b.label||b.note} — 剩 ${remaining} 天（${fmtDate(expDate)} 到期）</div>
        <div class="expire-alert-sub">點擊選擇「結算薪資」或「遞延${canCarry?'一年':'（不可再延，請結算）'}」→ 處理前薪資無法送出</div>
      </div>`;
    });
    expiringComp.forEach(c=>{
      html+=`<div class="expire-alert warn-type" onclick="openCompSettleModal('${empName}',${c.year},${c.canCarry})">
        <div class="expire-alert-title">${c.canCarry?'⚠️':'🚨'} 補休到期（${c.year}年度）— 剩 ${c.remaining} 天（12/31 到期${c.canCarry?''+'':'，不可再延'}）</div>
        <div class="expire-alert-sub">點擊選擇「結算薪資」${c.canCarry?'或「遞延至明年12/31」':''} → 處理前薪資無法送出</div>
      </div>`;
    });
  }

  // ===== 存摺（2026-10-26 改版：取代概況／批次卡／補休管理／使用明細／發放紀錄五個區塊）=====
  html += renderPassbook(empName, canEdit);

  // 法規說明框
  if(hireDate && !isPartTime) {
    // 若此員工是「歷史建檔略過模式」建入的，法規表格也省略已到期批次
    const isHistoricalSetup = batches.some(b=>b.historicalSetup===true);
    let schedule = calcBatchSchedule(hireDate);
    if(isHistoricalSetup) schedule = schedule.filter(b=>b.expireDate > todayStr);
    const _totalM = monthsDiff(hireDate, todayStr);
    const _yrs = Math.floor(_totalM/12);
    const _mths = _totalM % 12;
    const serviceLabel = _yrs===0 ? `約${_totalM}個月` : _mths===0 ? `約${_yrs}年` : `約${_yrs}年${_mths}個月`;
    const setupNote = isHistoricalSetup ? `<div style="font-size:11px;color:#b45309;background:#fff8e1;border-radius:6px;padding:4px 8px;margin-top:6px;display:inline-block;">⚙️ 歷史建檔模式：已到期批次已省略</div>` : '';
    html+=`<details class="law-box pb-law">
      <summary class="law-box-title">📋 特休天數怎麼算（週年制）</summary>
      <div>到職日：${fmtDate(hireDate)}，目前年資 ${serviceLabel}</div>
      ${setupNote}
      <table class="law-table">
        <tr><th>週年</th><th>發放日</th><th>到期日</th><th>天數</th><th>狀態</th></tr>
        ${schedule.map(b=>{
          const existing = batches.find(x=>x.grantDate===b.grantDate);
          let status = '待發放';
          if(existing) {
            const rem = batchRemain(empName, existing);
            status = existing.settled ? '已結算' : existing.carried ? '遞延中' : rem<=0 ? '已用完' : '進行中';
          }
          const rowClass = existing ? (existing.settled||(batchRemain(empName, existing)<=0) ? '' : 'highlight') : '';
          const grantBtn = (!existing && canEdit)
            ? `<button onclick="grantBatch('${empName}','${b.grantDate}','${b.expireDate}',${b.days},'${String(b.label).replace(/'/g,'')}')" style="margin-left:6px;background:var(--primary);color:white;border:none;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:800;cursor:pointer;">🎁 發放</button>`
            : '';
          return `<tr class="${rowClass}"><td>${b.label}</td><td>${fmtDate(b.grantDate)}</td><td>${fmtDate(b.expireDate)}</td><td>${b.days} 天</td><td style="color:${status==='已用完'?'var(--text-muted)':status==='進行中'?'var(--accent)':status==='遞延中'?'var(--warn)':'inherit'};">${status}${grantBtn}</td></tr>`;
        }).join('')}
      </table>
    </details>`;
  }
  if(isPartTime) {
    html+=`<div class="law-box"><div class="law-box-title">📝 工讀生備註</div>工讀生特休規則尚未定案，目前採手動建檔方式管理。</div>`;
  }

  el.innerHTML = html;
}

// ===== 存摺畫面 =====
// 一頁只有一個數字（剩幾天）；底下每一筆都寫「這筆之後剩幾天」，看得出數字怎麼來的。
// 改錯不刪紀錄：補休發放用「撤銷」另記一筆（留誰、為什麼），使用日照舊可移除（帳本以日期為 key，不會刪到別筆）。
function renderPassbook(empName, canEdit) {
  const bk = getBooks(empName);
  const isA = pbTab === 'annual';
  const book = isA ? bk.annual : bk.comp;
  const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const md = d => { const p = String(d||'').split('-'); return p.length===3 ? `${+p[1]}/${+p[2]}` : esc(d); };
  const sign = n => n>0 ? `+${n}` : n<0 ? `−${-n}` : '';
  const en = empName.replace(/'/g, "\\'");

  let hint = '';
  if(isA) {
    if(bk.annual.nextExpire) hint = `${fmtDate(bk.annual.nextExpire.date)} 前要休完 ${bk.annual.nextExpire.days} 天`;
    if(bk.annual.todo>0) hint = `<span style="color:var(--danger);font-weight:800;">⚠️ ${bk.annual.todo} 件待處理</span>` + (hint?`・${hint}`:'');
  } else {
    hint = `今年 12/31 前要休完` + (bk.comp.pending>0 ? `・其中 ${bk.comp.pending} 天國定假日還沒到` : '');
  }

  const rows = book.rows.slice().reverse();   // 新的在上面
  const shown = pbShowAll ? rows : rows.slice(0, 6);
  let lastY = '';
  const rowHtml = r => {
    const yr = String(r.date).slice(0,4), showY = yr !== lastY; lastY = yr;
    let act = '';
    if(canEdit) {
      if(r.kind==='todo' && r.missing) act = `<button class="pb-act pri" onclick="grantBatch('${en}','${r.missing.grantDate}','${r.missing.expireDate}',${r.missing.days},'${esc(r.missing.label)}')">建立</button>`;
      else if(r.kind==='todo' && r.batchId) act = `<button class="pb-act pri" onclick="openSettleCarryModal('${en}','${r.batchId}',${!!r.canCarry})">處理</button>`;
      // 排班表畫上的使用日：在這裡刪掉帳本、排班那格還寫著特休/補休 → 兩邊對不上，請他回排班表改
      else if(r.kind==='use') act = r.manual ? `<button class="pb-act" onclick="removeUsageDay('${en}','${isA?'annual':'comp'}','${r.usageDate}')">移除這天</button>`
        : `<span class="pb-note">排班表畫的，要改請到排班表</span>`;
      else if(isA && r.kind==='grant' && r.batchId) {
        const b = (batchesAll[empName]||[]).find(x=>x.id===r.batchId);
        const left = bk.annual.batchRem[r.batchId]||0;
        if(b && !b.settled && left>0) act = `<button class="pb-act" onclick="openSettleCarryModal('${en}','${b.id}',${!b.carried})">結算／遞延</button>`;
        if(b && !b.settled && left===(+b.days||0)) act += `<button class="pb-act" onclick="deleteBatch('${en}','${b.id}')">刪除</button>`;
      } else if(!isA && r.kind==='grant' && r.earn) {
        act = r.earn.source==='unworked' ? `<span class="pb-note">要撤回請到薪資頁</span>`
          : `<button class="pb-act" onclick="revokeCompEarn('${en}','${r.earn.date}',${r.earn.ts||0})">撤銷</button>`;
      }
    }
    const amt = (canEdit && r.amount!=null) ? `・$${Number(r.amount).toLocaleString()}` : '';
    // 操作收起來，點那一筆才出現（每筆都擺按鈕太吵）；待處理的一律直接顯示
    const open = r.kind==='todo';
    return `<div class="pb-row k-${r.kind}${r.future?' future':''}${act&&!open?' tap':''}"${act&&!open?` onclick="if(!event.target.closest('button'))this.classList.toggle('open')"`:''}>
      <div class="pb-date">${md(r.date)}${showY?`<small>${yr}</small>`:''}</div>
      <div class="pb-main">
        <div class="pb-title">${esc(r.title)}${r.future?' <span class="pb-tag">已排</span>':''}${r.over?' <span class="pb-tag red">超休</span>':''}</div>
        ${(r.sub||amt)?`<div class="pb-sub">${esc(r.sub||'')}${amt}</div>`:''}
        ${act?`<div class="pb-acts${open?' show':''}">${act}</div>`:''}
      </div>
      <div class="pb-num">
        <div class="pb-delta">${r.kind==='void'?`<s>+${r.struck}</s>`:sign(r.delta)}</div>
        ${r.kind==='todo'||r.kind==='void'||r.kind==='info'?'':`<div class="pb-bal">剩 ${r.balance}</div>`}
      </div>
    </div>`;
  };

  const adds = !canEdit ? '' : isA
    ? `<button class="pb-add" onclick="addUsageDay('${en}','annual')">＋ 補登休特休</button><button class="pb-add" onclick="openAddBatchModal('${en}')">＋ 新增特休批次</button>`
    : `<button class="pb-add" onclick="addUsageDay('${en}','comp')">＋ 補登休補休</button><button class="pb-add" onclick="openAddLogModal('${en}')">＋ 發放補休</button>`;

  return `<div class="pb-card">
    <div class="pb-tabs">
      <button class="pb-tab${isA?' on':''}" onclick="pbSwitch('${en}','annual')">🏖️ 特休</button>
      <button class="pb-tab${!isA?' on':''}" onclick="pbSwitch('${en}','comp')">🔄 補休</button>
    </div>
    <div class="pb-head">
      <div class="pb-big ${book.balance<0?'neg':''}">${book.balance}<span> 天</span></div>
      <div class="pb-hint">${hint || (isA?'目前沒有要到期的特休':'')}</div>
    </div>
    ${rows.length ? shown.map(rowHtml).join('') : `<div class="pb-empty">還沒有紀錄</div>`}
    ${rows.length>6 ? `<button class="pb-more" onclick="pbShowAll=!pbShowAll;renderEmpDetail('${en}', currentTab==='detail')">${pbShowAll?'收起':`顯示全部（${rows.length} 筆）`}</button>` : ''}
    ${canEdit&&shown.some(r=>r.kind!=='todo'&&r.kind!=='void'&&r.kind!=='info'&&r.kind!=='settle')?`<div class="pb-tip">點一筆可以修改</div>`:''}
    ${adds?`<div class="pb-adds">${adds}</div>`:''}
  </div>`;
}
function pbSwitch(empName, tab) { pbTab = tab; pbShowAll = false; renderEmpDetail(empName, currentTab==='detail'); }

// 撤銷補休發放：另記一筆 comp_cancel（同月份文件、同日期），不刪原紀錄
// 國定假日的撤銷要帶 source/備註「國定假日」，班表發布時的自動對帳（syncHolidayCompForWeek）才認得
async function revokeCompEarn(empName, date, ts) {
  if(!isManager()) return;
  const earn = (leaveLogAll[empName]||[]).find(r=>r.type==='comp_earn' && r.date===date && (r.ts||0)===ts);
  if(!earn) { showToast('⚠️ 找不到這筆發放，請重新整理'); return; }
  const isHol = earn.source==='holiday' || String(earn.note||'').includes('國定假日');
  const reason = prompt(`撤銷 ${fmtDate(date)} 的補休發放（${earn.days} 天）\n\n請填原因（會留下紀錄）：${isHol?'\n\n※ 如果那天其實有上班，之後重新發布該週班表時系統會再發回來。':''}`, '');
  if(reason===null) return;
  if(!reason.trim()) { showToast('⚠️ 要填撤銷原因'); return; }
  const m = String(earn.note||'').match(/\d{4}-\d{2}-\d{2}\s*(\S+?)\s*國定假日/);
  const rec = { ts: Date.now(), date, type:'comp_cancel', days: parseFloat(earn.days)||1,
    note: isHol ? `${date} ${m?m[1]+' ':''}國定假日補休撤銷：${reason.trim()}` : `${date} 補休撤銷：${reason.trim()}`,
    source: isHol ? 'holiday' : 'manual', savedBy: currentUser.displayName||currentUser.empName };
  showLoading('撤銷中...');
  try {
    await window.db.collection('employees').doc(empName).collection('leaveLog').doc(date.slice(0,7)).set({
      records: firebase.firestore.FieldValue.arrayUnion(rec) }, { merge:true });
    await recalcCompCarriedFirst(empName, date.slice(0,4));
    await loadEmpBatches(empName); await loadEmpComp(empName);
    renderEmpDetail(empName, currentTab==='detail');
    showToast('✅ 已撤銷');
  } catch(e) { showToast('❌ 撤銷失敗：'+e.message); }
  hideLoading();
}

// 手動補登 / 移除使用日（管理者）— 寫帳本 + 重算快取，與排班同一套邏輯
async function addUsageDay(empName, type) {
  const dateStr = prompt(`補登${type==='annual'?'特休':'補休'}使用日期（YYYY-MM-DD）：`, today());
  if(!dateStr) return;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { showToast('⚠️ 日期格式需 YYYY-MM-DD'); return; }
  const yearStr = dateStr.slice(0,4);
  const savedBy = currentUser?.displayName || currentUser?.empName || '';
  const empRef = window.db.collection('employees').doc(empName);
  const coll = type==='annual'?'annualUsage':'compUsage';
  const store = (empList.find(e=>e.name===empName)||{}).store || currentStore || '';
  showLoading('補登中...');
  try {
    await empRef.collection(coll).doc(dateStr).set({ date:dateStr, store, source:'manual', note:`${dateStr} 手動補登使用${type==='annual'?'特休':'補休'}`, savedBy, ts:Date.now() });
    if(type==='annual') await adjustBatchUsed(empName, +1);
    await recomputeCountersClient(empName, yearStr);
    await loadEmpBatches(empName); await loadEmpComp(empName);
    renderEmpDetail(empName, true);
    showToast('✅ 已補登');
  } catch(e){ showToast('❌ 補登失敗：'+e.message); }
  hideLoading();
}
async function removeUsageDay(empName, type, dateStr) {
  if(!confirm(`確定移除 ${fmtDate(dateStr)} 的${type==='annual'?'特休':'補休'}使用紀錄？（會退還 1 天）`)) return;
  const yearStr = dateStr.slice(0,4);
  const empRef = window.db.collection('employees').doc(empName);
  const coll = type==='annual'?'annualUsage':'compUsage';
  showLoading('移除中...');
  try {
    await empRef.collection(coll).doc(dateStr).delete();
    if(type==='annual') await adjustBatchUsed(empName, -1);
    await recomputeCountersClient(empName, yearStr);
    await loadEmpBatches(empName); await loadEmpComp(empName);
    renderEmpDetail(empName, true);
    showToast('✅ 已移除並退還');
  } catch(e){ showToast('❌ 移除失敗：'+e.message); }
  hideLoading();
}
async function adjustBatchUsed(empName, delta) {
  const ref = window.db.collection('employees').doc(empName).collection('leaveBatches');
  const snap = await ref.get();
  let target=null, latest=null;
  if(delta>0) {
    snap.forEach(d=>{ const b={id:d.id,...d.data()}; if(!latest||b.createdAt>latest.createdAt)latest=b; if(!b.settled){ const rem=(b.days||0)-(b.used||0); if(rem>0&&(!target||b.grantDate<target.grantDate))target=b; } });
    const bd = target||latest; if(bd) await ref.doc(bd.id).update({ used:(bd.used||0)+1 });
  } else {
    snap.forEach(d=>{ const b={id:d.id,...d.data()}; if(b.used>0&&(!target||b.grantDate>target.grantDate))target=b; });
    if(target) await ref.doc(target.id).update({ used:Math.max(0,target.used-1) });
  }
}
// 從帳本集合重算快取（與 schedule-V2.html recomputeLeaveCounters 一致）
async function recomputeCountersClient(empName, yearStr) { return lvRecomputeLeaveCounters(empName, yearStr); } // 規則在 leave-rules.js（2026-10-16 合併）

// ===== Tab 切換 =====
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-item').forEach(el=>el.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  if(tab==='overview') renderOverview();
  else if(currentViewEmp) renderEmpDetail(currentViewEmp,true);
}

// ===== 到職日設定 =====
function openHireDateModal(empName) {
  const emp = empList.find(e=>e.name===empName)||{};
  const isPartTime = (emp.role||'').includes('工讀');
  document.getElementById('hireDateEmpName').value = empName;
  document.getElementById('hireDateEmpDisplay').value = getDN(empName);
  document.getElementById('manualDaysGroup').style.display = isPartTime?'block':'none';
  document.getElementById('autoDaysPreview').style.display = 'none';
  const rawBatches = batchesAll[empName]||[];
  const hireDate = getHireDateFromBatches(rawBatches);
  document.getElementById('hireDateInput').value = hireDate||'';
  document.getElementById('hireDateInput').oninput = ()=>previewHireDate(isPartTime);
  // 僅系統管理員顯示「略過已到期批次」選項
  const skipGroup = document.getElementById('skipExpiredGroup');
  const skipCheck = document.getElementById('skipExpiredCheck');
  if(skipGroup) skipGroup.style.display = isAdmin() ? 'block' : 'none';
  if(skipCheck) {
    skipCheck.checked = false;
    skipCheck.onchange = () => previewHireDate(isPartTime);
  }
  openModal('hireDateModal');
}

function previewHireDate(isPartTime) {
  const hireDate = document.getElementById('hireDateInput').value;
  const preview = document.getElementById('autoDaysPreview');
  if(!hireDate||isPartTime){ preview.style.display='none'; return; }
  const skipExpired = document.getElementById('skipExpiredCheck')?.checked || false;
  let schedule = calcBatchSchedule(hireDate);
  if(skipExpired) {
    const todayStr = today();
    schedule = schedule.filter(b => b.expireDate > todayStr);
  }
  if(!schedule.length){ preview.style.display='none'; return; }
  preview.style.display='block';
  preview.innerHTML=`<b>預計發放批次（${skipExpired?'僅有效、略過已到期':'已到的全部'}）：</b><br>`+
    schedule.map(b=>`${b.label}（${fmtDate(b.grantDate)}）：${b.days} 天  到期 ${fmtDate(b.expireDate)}`).join('<br>');
}

async function saveHireDate() {
  const empName  = document.getElementById('hireDateEmpName').value;
  const hireDate = document.getElementById('hireDateInput').value;
  if(!hireDate){ showToast('⚠️ 請輸入到職日'); return; }
  const emp = empList.find(e=>e.name===empName)||{};
  const isPartTime = (emp.role||'').includes('工讀');

  showLoading('建立批次中...');
  try{
    const batchRef = window.db.collection('employees').doc(empName).collection('leaveBatches');
    const oldSnap = await batchRef.get();
    for(const d of oldSnap.docs) await d.ref.delete();

    if(isPartTime) {
      const manualDays = parseInt(document.getElementById('manualAnnualDays').value)||0;
      if(manualDays>0) {
        await batchRef.add({ grantDate:hireDate, expireDate:dateAddExpire(hireDate,12), days:manualDays, used:0, label:'手動建檔（工讀生）', carried:false, settled:false, createdAt:today() });
      }
    } else {
      const skipExpired = document.getElementById('skipExpiredCheck')?.checked || false;
      let schedule = calcBatchSchedule(hireDate);
      if(skipExpired) {
        const todayStr = today();
        schedule = schedule.filter(b => b.expireDate > todayStr);
      }
      for(const b of schedule) {
        await batchRef.add({ ...b, used:0, carried:false, settled:false, createdAt:today(), historicalSetup: skipExpired||false });
      }
    }

    const year = new Date().getFullYear().toString();
    await window.db.collection('employees').doc(empName).collection('leaves').doc(year).set({ hireDate },{ merge:true });
    // 🌟 同步門市員工檔 startDate（供薪資「到職前不顯示」篩選）
    // ⚠️ 調店進來的員工 startDate=調入本店日，不可被到職日覆蓋——到職日(年資)持續累積、與本店薪資起算分離
    const _st = emp.store || currentStore;
    const _isTransferIn = !!(emp.transferDate || emp.transferFrom);
    if(_st && !_isTransferIn) await window.db.collection('stores').doc(_st).collection('employees').doc(empName).set({ startDate: hireDate }, { merge:true });

    showToast('✅ 已設定到職日並建立批次');
    closeModal('hireDateModal');
    await loadEmpBatches(empName);
    renderEmpDetail(empName, true);
  }catch(e){ showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

// ===== 結算/遞延 Modal（特休）=====
function openSettleCarryModal(empName, batchId, canCarry) {
  if(!isManager()) return;
  const b = batchesAll[empName]?.find(x=>x.id===batchId);
  if(!b) return;
  const remaining = batchRemain(empName, b);
  const expDate = b.carried ? dateAddExpire(b.expireDate,12) : b.expireDate;

  document.getElementById('scEmpName').value = empName;
  document.getElementById('scBatchId').value = batchId;
  document.getElementById('scCanCarry').value = canCarry?'1':'0';
  document.getElementById('scModalTitle').textContent = `處理特休：${getDN(empName)} — ${b.label||b.note}`;
  document.getElementById('scInfo').innerHTML = `
    員工：<b>${getDN(empName)}</b><br>
    批次：<b>${b.label||b.note}</b>${b.carried?' <span style="color:var(--warn);">(遞延批)</span>':''}<br>
    剩餘天數：<b style="color:var(--danger);">${remaining} 天</b><br>
    到期日：<b>${fmtDate(expDate)}</b>`;

  const carryBtn = document.getElementById('scCarryBtn');
  if(!canCarry) {
    carryBtn.style.display='none';
    document.getElementById('scHint').textContent='⚠️ 此批次為遞延批，不可再延。請結算薪資，否則薪資無法送出審核。';
  } else {
    carryBtn.style.display='block';
    carryBtn.textContent='📌 遞延一年（到 '+fmtDate(dateAdd(expDate,12))+'）';
    document.getElementById('scHint').textContent='⚠️ 此批次特休本月到期，請選擇處理方式。處理完成前薪資無法送出審核。';
  }
  openModal('settleCarryModal');
}

async function doSettle() {
  const empName = document.getElementById('scEmpName').value;
  const batchId = document.getElementById('scBatchId').value;
  const b = batchesAll[empName]?.find(x=>x.id===batchId);
  if(!b) return;
  const remaining = batchRemain(empName, b);
  if(!confirm(`確定將 ${getDN(empName)} 剩餘 ${remaining} 天特休結算為薪資？\n請在薪資系統中手動計入日薪 × ${remaining} 天。`)) return;
  showLoading('結算中...');
  try{
    await window.db.collection('employees').doc(empName).collection('leaveBatches').doc(batchId).update({
      settled:true, settledAt:today(), settledNote:'月底結算', settledDays:remaining
    });
    // 寫入 log
    const ym = today().slice(0,7);
    await window.db.collection('employees').doc(empName).collection('leaveLog').doc(ym).set({
      records: firebase.firestore.FieldValue.arrayUnion({ ts: Date.now(), date:today(), type:'settle', days:remaining, note:`特休薪資結算（${b.label||b.note}）`, savedBy:currentUser.displayName||currentUser.empName })
    },{ merge:true });
    showToast('✅ 已結算，請至薪資系統確認');
    closeModal('settleCarryModal');
    await loadEmpBatches(empName);
    renderEmpDetail(empName, true);
  }catch(e){ showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

async function doCarry() {
  const empName = document.getElementById('scEmpName').value;
  const batchId = document.getElementById('scBatchId').value;
  const canCarry = document.getElementById('scCanCarry').value === '1';
  if(!canCarry){ showToast('⚠️ 此批次不可再遞延'); return; }
  const b = batchesAll[empName]?.find(x=>x.id===batchId);
  if(!b) return;
  if(!confirm(`確定將此批次遞延一年？遞延後不可再延，下次到期必須結算。`)) return;
  showLoading('遞延中...');
  try{
    await window.db.collection('employees').doc(empName).collection('leaveBatches').doc(batchId).update({
      carried:true, carriedAt:today(), carriedNote:'月底遞延'
    });
    showToast('✅ 已標記遞延');
    closeModal('settleCarryModal');
    await loadEmpBatches(empName);
    renderEmpDetail(empName, true);
  }catch(e){ showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

// ===== 補休結算/遞延 =====
function openCompSettleModal(empName, compYear, canCarry) {
  if(!isManager()) return;
  const cd = compDataAll[empName];
  if(!cd) return;
  const isCarried = String(compYear) === String(cd.carried?.year);
  const data = isCarried ? cd.carried : cd.current;
  if(!data) return;

  document.getElementById('csEmpName').value = empName;
  document.getElementById('csCompYear').value = compYear;
  document.getElementById('csCanCarry').value = canCarry?'1':'0';
  document.getElementById('csModalTitle').textContent = `處理補休：${getDN(empName)} — ${compYear}年度`;
  document.getElementById('csInfo').innerHTML = `
    員工：<b>${getDN(empName)}</b><br>
    年度：<b>${compYear} 年度補休</b>${isCarried?' <span style="color:var(--warn);">(遞延批，不可再延)</span>':''}<br>
    剩餘天數：<b style="color:var(--danger);">${data.remaining} 天</b><br>
    到期日：<b>12/31</b>`;

  const carryBtn = document.getElementById('csCarryBtn');
  if(!canCarry) {
    carryBtn.style.display='none';
    document.getElementById('csHint').textContent='🚨 此補休為遞延批，不可再延，請結算薪資。';
  } else {
    carryBtn.style.display='block';
    document.getElementById('csHint').textContent='⚠️ 12月底補休即將到期，請選擇處理方式。處理完成前薪資無法送出審核。';
  }
  openModal('compSettleModal');
}

async function doCompSettle() {
  const empName = document.getElementById('csEmpName').value;
  const compYear = document.getElementById('csCompYear').value;
  const cd = compDataAll[empName];
  const isCarried = String(compYear) === String(cd?.carried?.year);
  const data = isCarried ? cd.carried : cd.current;
  if(!data) return;

  if(!confirm(`確定將 ${getDN(empName)} ${compYear}年度剩餘 ${data.remaining} 天補休結算為薪資？`)) return;
  showLoading('結算中...');
  try{
    const compRef = window.db.collection('employees').doc(empName).collection('comp').doc(String(compYear));
    if(isCarried) {
      await compRef.update({ settled:true, settledAt:today(), settledDays:data.remaining });
    } else {
      await compRef.set({ earned:data.earned||0, used:data.used||0, settled:true, settledAt:today(), settledDays:data.remaining },{ merge:true });
    }
    // 寫入 log
    const ym = today().slice(0,7);
    await window.db.collection('employees').doc(empName).collection('leaveLog').doc(ym).set({
      records: firebase.firestore.FieldValue.arrayUnion({ ts: Date.now(), date:today(), type:'settle', days:data.remaining, note:`補休薪資結算（${compYear}年度）`, savedBy:currentUser.displayName||currentUser.empName })
    },{ merge:true });
    showToast('✅ 補休已結算，請至薪資系統確認');
    closeModal('compSettleModal');
    await loadEmpComp(empName);
    renderEmpDetail(empName, true);
  }catch(e){ showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

async function doCompCarry() {
  const empName = document.getElementById('csEmpName').value;
  const compYear = document.getElementById('csCompYear').value;
  const canCarry = document.getElementById('csCanCarry').value === '1';
  if(!canCarry){ showToast('⚠️ 此補休不可再遞延'); return; }
  const cd = compDataAll[empName];
  if(!cd) return;
  if(!confirm(`確定將 ${getDN(empName)} ${compYear}年度補休遞延至明年12/31？遞延後不可再延。`)) return;
  showLoading('遞延中...');
  try{
    const compRef = window.db.collection('employees').doc(empName).collection('comp').doc(String(compYear));
    await compRef.set({ earned:cd.current.earned||0, used:cd.current.used||0, carried:true, carriedAt:today() },{ merge:true });
    showToast('✅ 補休已遞延至明年12/31');
    closeModal('compSettleModal');
    await loadEmpComp(empName);
    renderEmpDetail(empName, true);
  }catch(e){ showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

// ===== 批次操作 =====
async function deleteBatch(empName, batchId) {
  if(!confirm('確定刪除此批次？')) return;
  showLoading('刪除中...');
  try{
    await window.db.collection('employees').doc(empName).collection('leaveBatches').doc(batchId).delete();
    await loadEmpBatches(empName);
    renderEmpDetail(empName, true);
    showToast('✅ 已刪除');
  }catch(e){ showToast('❌ 失敗'); }
  hideLoading();
}

// ===== 新增批次 =====
function openAddBatchModal(empName) {
  document.getElementById('addBatchEmp').value = empName;
  document.getElementById('addBatchGrantDate').value = today();
  document.getElementById('addBatchExpireDate').value = dateAddExpire(today(),12);
  document.getElementById('addBatchDays').value = '';
  document.getElementById('addBatchNote').value = '';
  openModal('addBatchModal');
}
// 一鍵發放：帶入該週年批次的發放日/到期日/天數
function grantBatch(empName, grantDate, expireDate, days, label){
  document.getElementById('addBatchEmp').value = empName;
  document.getElementById('addBatchGrantDate').value = grantDate;
  document.getElementById('addBatchExpireDate').value = expireDate;
  document.getElementById('addBatchDays').value = days;
  document.getElementById('addBatchNote').value = label || '';
  openModal('addBatchModal');
}
async function saveAddBatch() {
  const empName   = document.getElementById('addBatchEmp').value;
  const grantDate = document.getElementById('addBatchGrantDate').value;
  const expireDate= document.getElementById('addBatchExpireDate').value;
  const days      = parseFloat(document.getElementById('addBatchDays').value);
  const note      = document.getElementById('addBatchNote').value.trim();
  if(!grantDate||!expireDate||isNaN(days)||days<=0){ showToast('⚠️ 請填寫完整'); return; }
  showLoading('新增中...');
  try{
    await window.db.collection('employees').doc(empName).collection('leaveBatches').add({
      grantDate, expireDate, days, used:0, label:note||'手動新增', note, carried:false, settled:false, createdAt:today()
    });
    closeModal('addBatchModal');
    await loadEmpBatches(empName);
    renderEmpDetail(empName, true);
    showToast('✅ 已新增批次');
  }catch(e){ showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

// ===== 新增 leaveLog =====
function openAddLogModal(empName) {
  if(!isManager()) return;
  document.getElementById('addLogTitle').textContent = `新增紀錄：${getDN(empName)}`;
  document.getElementById('addLogEmpName').value = empName;
  document.getElementById('addLogDate').value = today();
  document.getElementById('addLogDays').value = '';
  document.getElementById('addLogNote').value = '';
  document.getElementById('addLogType').value = 'comp_earn';
  document.getElementById('addLogDays').value = '1';
  openModal('addLogModal');
}
async function saveAddLog() {
  const empName = document.getElementById('addLogEmpName').value || currentViewEmp;
  const type  = document.getElementById('addLogType').value;
  const date  = document.getElementById('addLogDate').value;
  const days  = parseFloat(document.getElementById('addLogDays').value||0);
  const note  = document.getElementById('addLogNote').value.trim();
  if(!date||days<=0){ showToast('⚠️ 請填寫完整'); return; }
  const ym = date.slice(0,7);
  const year = date.slice(0,4);
  showLoading('儲存中...');
  try{
    // ✅ Bug6：加入 source 欄位追溯補休來源
    const _logRec = { date, type, days, note:note||'', savedBy:currentUser.displayName||currentUser.empName, ts: Date.now() }; // ts：同一天兩筆一模一樣的紀錄會被 arrayUnion 吃掉一筆
    if(type==='comp_earn') _logRec.source = 'manual';
    if(type==='comp_use')  _logRec.source = `schedule:${date}`;
    await window.db.collection('employees').doc(empName).collection('leaveLog').doc(ym).set({
      records: firebase.firestore.FieldValue.arrayUnion(_logRec)
    },{ merge:true });
    // 補休異動 → 以「先扣遞延、再扣當年度」整年重算（取代舊的增量更新；舊版會把使用夾在 earned 內導致少扣）
    if(['comp_earn','comp_use','comp_cancel','comp_use_cancel'].includes(type)) {
      await recalcCompCarriedFirst(empName, year);
    }
    closeModal('addLogModal');
    await loadEmpBatches(empName);
    await loadEmpComp(empName);
    renderEmpDetail(empName, true);
    showToast('✅ 已新增');
  }catch(e){ showToast('❌ 失敗：'+e.message); }
  hideLoading();
}

// ===== 年度報表 =====
async function openReport() {
  showLoading('產出報表中...');
  if(empList.length===0) await loadAllEmps();
  const year = new Date().getFullYear();
  const el = document.getElementById('mainContent');
  currentTab = '';
  document.querySelectorAll('.tab-item').forEach(el=>el.classList.remove('active'));

  let rows = empList.map(emp=>{
    const s = calcEmpSummary(emp.name);
    const batches = (batchesAll[emp.name]||[]).filter(b=>!b._legacy);
    const totalGranted = batches.reduce((a,b)=>a+(b.days||0),0);
    const rate = totalGranted>0?Math.round((s.usedAnnual/totalGranted)*100):null;
    const rateClass = rate===null?'':rate>=70?'high':rate>=30?'mid':'low';
    return { emp, s, totalGranted, rate, rateClass };
  });

  let html=`<button onclick="switchTab('overview')" style="background:none;border:none;color:var(--primary);font-size:13px;font-weight:700;cursor:pointer;margin-bottom:12px;">← 回總覽</button>
  <div class="report-section">
    <div class="report-title">📊 ${year} 年度特補休報表 — ${currentStore}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">產出：${new Date().toLocaleString('zh-TW')}</div>
    <table class="report-table">
      <tr><th>員工</th><th>發放</th><th>已休</th><th>達成率</th><th>特休剩</th><th>補休剩</th></tr>
      ${rows.map(({emp,s,totalGranted,rate,rateClass})=>{
        const rowClass = rate!==null&&rate<30?'danger-row':'';
        const bk = getBooks(emp.name);   // 與明細頁存摺同一個數字
        return `<tr class="${rowClass}">
          <td><b>${getDN(emp.name)}</b><br><span style="font-size:10px;color:var(--text-muted);">${emp.role||''}</span></td>
          <td>${totalGranted} 天</td>
          <td>${s.usedAnnual} 天</td>
          <td>${rate!==null?`<span class="achievement ${rateClass}">${rate}%</span>`:'--'}</td>
          <td>${bk.annual.balance} 天</td>
          <td>${bk.comp.balance} 天</td>
        </tr>`;
      }).join('')}
    </table>
  </div>`;

  el.innerHTML = html;
  hideLoading();
}
