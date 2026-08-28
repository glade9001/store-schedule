let currentUser = null;
let appConfig   = { stores: [] };
let exportFormat = 'xlsx';
let pdfMode = 'simple'; // H: 'simple' | 'full'
let pdfPreviewData = null; // I: 儲存以重繪薪資頁

const showToast = msg => {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
};
const showLoading = msg => {
  document.getElementById('loadingOverlay').classList.remove('hidden');
  document.getElementById('loadingText').textContent = msg || '載入中...';
};
const hideLoading = () => document.getElementById('loadingOverlay').classList.add('hidden');
const setProgress = (pct, msg, log) => {
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressText').textContent = msg;
  if(log) {
    const el = document.getElementById('progressLog');
    el.innerHTML += `<div>• ${log}</div>`;
    el.scrollTop = el.scrollHeight;
  }
};
const toggleCheck = key => {
  const chk = document.getElementById('chk-' + key);
  document.getElementById('ci-' + key).classList.toggle('checked', chk.checked);
};
// H. PDF 模式切換
const setPdfMode = mode => {
  pdfMode = mode;
  document.getElementById('pdf-simple').classList.toggle('active', mode==='simple');
  document.getElementById('pdf-full').classList.toggle('active', mode==='full');
  document.getElementById('pdf-mode-hint').textContent = mode==='simple'
    ? '精簡版：僅顯示姓名・應發・實發・公司勞退・人事成本'
    : '完整版：完整 19 欄薪資明細（可選擇顯示欄位）';
};

// I. 欄位勾選 → CSS 注入控制顯示（不重建 HTML）
function rerenderPdfSalaryPage() {
  const styleEl = document.getElementById('pdf-col-style');
  if(!styleEl) return;
  const rules = [];
  if(!document.getElementById('col-laborAllow').checked) rules.push('.opt-col-la{display:none;}');
  if(!document.getElementById('col-perf').checked)       rules.push('.opt-col-pf{display:none;}');
  if(!document.getElementById('col-other').checked)      rules.push('.opt-col-ot{display:none;}');
  if(!document.getElementById('col-holiday').checked)    rules.push('.opt-col-ho{display:none;}');
  styleEl.textContent = rules.join('');
}

// G. 資料筆數查詢
async function updateCounts() {
  const year  = document.getElementById('selYear').value;
  const month = document.getElementById('selMonth').value;
  if(!year||!month) return;
  const ym = `${year}-${month}`;
  const stores = appConfig.stores || [];
  if(!stores.length) return;
  const [_ey,_em] = ym.split('-').map(Number);
  const endDay = new Date(_ey,_em,0).getDate();
  const exportMonthEnd = `${_ey}-${String(_em).padStart(2,'0')}-${endDay}`;

  // 員工人數
  try {
    let cnt=0;
    for(const store of stores){
      const snap=await window.db.collection('stores').doc(store).collection('employees').get();
      snap.forEach(d=>{
        const data=d.data();
        const ed=data.retireDate||data.transferDate;
        if(['離職','調走'].includes(data.status)&&(!ed||ed<=exportMonthEnd)) return;
        cnt++;
      });
    }
    const badge = cnt>0?` (${cnt} 人)`:'';
    ['summary','emp'].forEach(k=>{ const el=document.getElementById(`count-badge-${k}`); if(el) el.textContent=badge; });
  } catch(e){}

  // 薪資記錄筆數
  try {
    let salCnt=0;
    for(const s of stores){
      const snap=await window.db.collection('stores').doc(s).collection('salary').doc(ym).get();
      if(snap.exists) salCnt+=(snap.data().records||[]).length;
    }
    const salEl = document.getElementById('count-badge-salary');
    if(salEl) salEl.textContent = salCnt>0?` (${salCnt} 筆)`:'  (無資料)';
    if(salCnt===0){ document.getElementById('chk-salary').checked=false; toggleCheck('salary'); }
    else if(!document.getElementById('chk-salary').checked){ document.getElementById('chk-salary').checked=true; toggleCheck('salary'); }
  } catch(e){}

  // 特補休筆數（估算：等於在職人數）
  const leaveEl=document.getElementById('count-badge-leave');
  if(leaveEl && document.getElementById('count-badge-emp').textContent)
    leaveEl.textContent = document.getElementById('count-badge-emp').textContent;
}

const setFormat = fmt => {
  exportFormat = fmt;
  document.getElementById('fmt-xlsx').classList.toggle('active', fmt === 'xlsx');
  document.getElementById('fmt-csv').classList.toggle('active', fmt === 'csv');
  document.getElementById('fmt-note').textContent = fmt === 'xlsx'
    ? 'Excel 格式：四個工作表整合在同一個檔案，含凍結欄列'
    : 'CSV 格式：每個工作表分開下載為獨立 .csv 檔案（不含格式）';
};

// 數字工具
const n = v => parseFloat(v) || 0;
const comma = v => n(v).toLocaleString();

// 民國年轉換
const toROC = dateStr => {
  if(!dateStr) return '--';
  try {
    const [y,m,d] = dateStr.split('-').map(Number);
    return `${y-1911}/${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}`;
  } catch { return dateStr; }
};

// 在職年資
const calcSeniority = startDate => {
  if(!startDate) return '--';
  try {
    const s = new Date(startDate), now = new Date();
    let years = now.getFullYear()-s.getFullYear();
    let months = now.getMonth()-s.getMonth();
    if(months<0){years--;months+=12;}
    return years>0 ? `${years}年${months}月` : `${months}個月`;
  } catch { return '--'; }
};

// 特休到期日（從 leaveBatches）
const getAnnualExpire = (empName, batchMap, year) => {
  const batches = (batchMap[empName]||[]).filter(b=>!b.carried);
  if(!batches.length) return '--';
  const target = batches.find(b=>b.grantDate&&b.grantDate.startsWith(year)) || batches[batches.length-1];
  if(target.expireDate) return toROC(target.expireDate);
  try {
    const d = new Date(target.grantDate);
    d.setFullYear(d.getFullYear()+2);
    return toROC(d.toISOString().split('T')[0]);
  } catch { return '--'; }
};

// 距到期天數
const daysUntilExpire = expROC => {
  if(expROC==='--') return 9999;
  try {
    const [ry,rm,rd] = expROC.split('/').map(Number);
    return Math.ceil((new Date(ry+1911,rm-1,rd)-new Date())/86400000);
  } catch { return 9999; }
};

// 本月是否週年日
const shouldGrantThisMonth = (startDate, ym) => {
  if(!startDate) return false;
  try {
    const sm = parseInt(startDate.split('-')[1]);
    const cm = parseInt(ym.split('-')[1]);
    return sm === cm;
  } catch { return false; }
};

// 特休是否已發放
const checkAnnualGranted = (empName, batchMap, year) =>
  (batchMap[empName]||[]).filter(b=>!b.carried).some(b=>b.grantDate&&b.grantDate.startsWith(year));

// 薪資計算
const calcHourlyRate = rec =>
  (n(rec.baseSalary)+n(rec.fullAttendBase)+n(rec.otherBase))/30/8;

const calcOtPay = rec => {
  const rph = calcHourlyRate(rec);
  const hasCustom = n(rec.customOtRate)>0;
  const rate = hasCustom ? n(rec.customOtRate) : Math.ceil(rph);
  const mult = hasCustom ? (rec.customOtX134!==false?1.34:1) : 1.34;
  return Math.ceil(rate*mult*n(rec.otHours));
};

// 以記錄本身判是否工讀計(payAsPartTime店長如楷岳、或工讀、或有時薪無底薪)——不依現況角色，守歷史不可變
const isPartRec = rec => !!(rec && (rec.payAsPartTime || rec.role==='工讀' || (n(rec.wage)>0 && n(rec.baseSalary)===0)));
const calcGross = (rec, role) => {
  if(rec && rec.grossAmt != null) return n(rec.grossAmt); // 已發布快照(=實發)優先
  if(isPartRec(rec) || role==='工讀') {
    const w=n(rec.wage), h=n(rec.hours||0);
    return Math.max(0,
      Math.round(w*h)+Math.round(w*n(rec.holidayHours))+
      n(rec.roleBonus)+Math.round(n(rec.extraHours)*w)-
      Math.abs(n(rec.personalSickLeave)));
  }
  const mgmt=['mgmtOps','mgmtQuality','mgmtKPI','mgmtAccount','mgmtLeader'].reduce((s,k)=>s+n(rec[k]),0);
  const rph=calcHourlyRate(rec);
  return Math.max(0,
    n(rec.baseSalary)+n(rec.fullAttendBonus)+mgmt+
    n(rec.laborAllowance)+n(rec.performance)+n(rec.nightAllowance)+
    n(rec.roleBonus)+n(rec.otherBonus)+
    n(rec.annualLeaveEncash)+n(rec.compLeaveEncash)+
    calcOtPay(rec)+n(rec.restDayOtPay)+n(rec.holidayOtPay)+n(rec.hourlySupportAmt||0)-
    Math.round(rph/60*n(rec.lateMinutes))-
    Math.abs(n(rec.personalSickLeave)));
};

const calcDeduct = rec =>
  (rec && rec.deductAmt != null) ? n(rec.deductAmt) :
  (n(rec.laborInsurance)+n(rec.healthInsurance)+
   n(rec.dependentInsurance)+n(rec.laborPension)+n(rec.otherDeduction));

const calcNet = (rec, role) =>
  (rec && rec.netAmt != null) ? n(rec.netAmt) : (calcGross(rec,role)-calcDeduct(rec));

const calcCompPension = (rec, role) =>
  (isPartRec(rec) || role==='工讀') ? 0 : Math.round((n(rec.baseSalary)+n(rec.fullAttendBonus))*0.06);

const calcRealCost = (rec, role) => calcNet(rec,role)+calcCompPension(rec,role);

const chunkArray = (arr,size) => {
  const out=[];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
};

// 初始化
window.onload = async () => {
  showLoading('驗證登入...');
  const saved = localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser');
  if(!saved){window.location.replace('home.html');return;}
  try{currentUser=JSON.parse(saved);}catch{window.location.replace('home.html');return;}
  const _fbAuth = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(fb => { u(); r(fb); }); });
  if (!_fbAuth) { localStorage.removeItem('currentUser'); sessionStorage.removeItem('currentUser'); window.location.replace('home.html'); return; }
  if(!['owner','admin'].includes(currentUser?.permission)){
    alert('⚠️ 此功能僅限加盟主以上權限');
    window.location.replace('home.html');return;
  }
  try{
    const snap=await window.db.collection('settings').doc('globalConfig').get();
    if(snap.exists) appConfig=snap.data();
  }catch{}
  const now=new Date();
  const sel=document.getElementById('selYear');
  for(let y=now.getFullYear();y>=now.getFullYear()-2;y--)
    sel.innerHTML+=`<option value="${y}">${y} 年（民國 ${y-1911} 年）</option>`;
  sel.value=now.getFullYear();
  document.getElementById('selMonth').value=String(now.getMonth()+1).padStart(2,'0');
  hideLoading();
  // G. 初始載入筆數
  updateCounts();
};

// J. 右滑返回
(function(){
  let sx=0;
  document.addEventListener('touchstart', e=>{ sx=e.touches[0].clientX; }, {passive:true});
  document.addEventListener('touchend',   e=>{ if(e.changedTouches[0].clientX-sx>60) window.location.href=(new URLSearchParams(location.search).get('ref')||'home.html'); }, {passive:true});
})();

// ═══ 主匯出 ═══
async function startExport() {
  const doSummary=document.getElementById('chk-summary').checked;
  const doEmp=document.getElementById('chk-emp').checked;
  const doLeave=document.getElementById('chk-leave').checked;
  const doSalary=document.getElementById('chk-salary').checked;
  if(!doSummary&&!doEmp&&!doLeave&&!doSalary){showToast('⚠️ 請至少選擇一項');return;}

  const year=document.getElementById('selYear').value;
  const month=document.getElementById('selMonth').value;
  const ym=`${year}-${month}`;
  const stores=appConfig.stores||[];
  if(!stores.length){showToast('⚠️ 無門市資料');return;}

  document.getElementById('exportBtn').disabled=true;
  document.getElementById('exportBtnText').textContent='匯出中...';
  document.getElementById('progressArea').style.display='block';
  document.getElementById('progressLog').innerHTML='';
  document.getElementById('summaryCard').style.display='none';
  setProgress(0,'開始讀取資料...');

  try {
    // 1. 員工名單
    setProgress(5,'讀取員工名單...');
    const [_ey,_em]=ym.split('-').map(Number);
    const exportMonthEnd=`${_ey}-${String(_em).padStart(2,'0')}-${new Date(_ey,_em,0).getDate()}`;
    let allEmps=[];
    for(const store of stores){
      const snap=await window.db.collection('stores').doc(store).collection('employees').get();
      snap.forEach(d=>{
        const data=d.data();
        const effectDate=data.retireDate||data.transferDate;
        if(['離職','調走'].includes(data.status)&&(!effectDate||effectDate<=exportMonthEnd)) return;
        if(data.startDate){
          const [sy,sm]=data.startDate.split('-').map(Number);
          const [cy,cm]=ym.split('-').map(Number);
          if(sy>cy||(sy===cy&&sm>cm)) return;
        }
        allEmps.push({name:d.id,store,...data});
      });
    }
    allEmps.sort((a,b)=>{
      const si=stores.indexOf(a.store)-stores.indexOf(b.store);
      return si!==0?si:(a.sortKey||0)-(b.sortKey||0);
    });
    setProgress(12,`員工 ${allEmps.length} 人`,`員工名單讀取完成：${allEmps.length} 人`);

    // 2. 薪資記錄
    setProgress(15,'讀取薪資記錄...');
    let salaryRecMap={};
    for(const store of stores){
      try{
        const snap=await window.db.collection('stores').doc(store).collection('salary').doc(ym).get();
        if(snap.exists)
          (snap.data().records||[]).forEach(r=>{salaryRecMap[r.empName]={...r,_store:store};});
      }catch{}
    }
    setProgress(25,`薪資記錄 ${Object.keys(salaryRecMap).length} 筆`,`薪資讀取完成`);

    // 3. 特補休
    setProgress(28,'讀取特補休資料...');
    let leaveStatMap={}, compStatMap={}, leaveLogAll=[], batchMap={};
    const chunks=chunkArray(allEmps,6);
    for(let ci=0;ci<chunks.length;ci++){
      setProgress(28+ci*4,`特補休 ${Math.min((ci+1)*6,allEmps.length)}/${allEmps.length}...`);
      await Promise.all(chunks[ci].map(async emp=>{
        try{
          const lSnap=await window.db.collection('employees').doc(emp.name).collection('leaves').doc(year).get();
          leaveStatMap[emp.name]=lSnap.exists?lSnap.data():{};
          const cSnap=await window.db.collection('employees').doc(emp.name).collection('comp').doc(year).get();
          compStatMap[emp.name]=cSnap.exists?cSnap.data():{earned:0,used:0};
          const bSnap=await window.db.collection('employees').doc(emp.name).collection('leaveBatches').get();
          const batches=[];
          bSnap.forEach(d=>batches.push({id:d.id,...d.data()}));
          batchMap[emp.name]=batches.sort((a,b)=>(a.grantDate||'').localeCompare(b.grantDate||''));
          const months=[];
          for(let m2=1;m2<=parseInt(month);m2++)
            months.push(`${year}-${String(m2).padStart(2,'0')}`);
          await Promise.all(months.map(async ym2=>{
            try{
              const logSnap=await window.db.collection('employees').doc(emp.name).collection('leaveLog').doc(ym2).get();
              if(!logSnap.exists) return;
              const typeMap={
                'annual_use':       {label:'特休・使用',  cat:'annual'},
                'annual_encash':    {label:'特休・折現',  cat:'annual'},
                'annual_use_cancel':{label:'特休・取消',  cat:'annual'},
                'comp_earn':        {label:'補休・取得',  cat:'comp'},
                'comp_use':         {label:'補休・使用',  cat:'comp'},
                'comp_cancel':      {label:'補休・撤回',  cat:'comp'},
                'comp_encash':      {label:'補休・折現',  cat:'comp'},
                'comp_use_cancel':  {label:'補休・取消',  cat:'comp'},
              };
              (logSnap.data().records||[]).forEach(r=>{
                if(!typeMap[r.type]) return;
                leaveLogAll.push({
                  empName:emp.displayName||emp.name, store:emp.store, role:emp.role||'',
                  date:r.date||ym2+'-01', typeKey:r.type,
                  typeLabel:typeMap[r.type].label, cat:typeMap[r.type].cat,
                  days:r.days||0, note:r.note||'', savedBy:r.savedBy||''
                });
              });
            }catch{}
          }));
        }catch{}
      }));
    }
    leaveLogAll.sort((a,b)=>a.date.localeCompare(b.date));
    setProgress(68,'特補休讀取完成',`特補休紀錄：${leaveLogAll.length} 筆`);

    // 4. 產生 Workbook
    setProgress(72,'產生工作表...');
    const wb=XLSX.utils.book_new();

    if(doSummary){
      setProgress(74,'產生摘要工作表...');
      XLSX.utils.book_append_sheet(wb,
        buildSummarySheet(allEmps,salaryRecMap,leaveStatMap,compStatMap,batchMap,stores,year,ym),
        '人事費用摘要');
    }
    if(doEmp){
      setProgress(80,'產生員工資料工作表...');
      XLSX.utils.book_append_sheet(wb,
        buildEmpSheet(allEmps,salaryRecMap,leaveStatMap,compStatMap,batchMap,year,ym),
        '員工資料');
    }
    if(doLeave){
      setProgress(87,'產生特補休工作表...');
      XLSX.utils.book_append_sheet(wb,
        buildLeaveSheet(allEmps,leaveLogAll,leaveStatMap,compStatMap,batchMap,year,ym,month),
        '特補休紀錄');
    }
    if(doSalary){
      setProgress(93,'產生薪資明細工作表...');
      XLSX.utils.book_append_sheet(wb,
        buildSalarySheet(allEmps,salaryRecMap,stores,ym),
        '薪資明細');
    }

    // 5. 下載
    setProgress(97,'產生檔案...');
    const rocY=parseInt(year)-1911;
    const fileName=`莉學商行-民國${rocY}年${parseInt(month)}月薪資清冊`;
    if(exportFormat==='xlsx'){
      XLSX.writeFile(wb,`${fileName}.xlsx`);
    } else {
      wb.SheetNames.forEach((name,i)=>{
        setTimeout(()=>{
          const csv=XLSX.utils.sheet_to_csv(wb.Sheets[name]);
          const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
          const a=document.createElement('a');
          a.href=URL.createObjectURL(blob);
          a.download=`${fileName}_${name}.csv`;
          a.click();
        },i*700);
      });
    }

    setProgress(100,'✅ 匯出完成！');
    const totalCost=allEmps.reduce((s,emp)=>{
      const rec=salaryRecMap[emp.name];
      return rec?s+calcRealCost(rec,emp.role):s;
    },0);
    document.getElementById('sum-emp').textContent=allEmps.length;
    document.getElementById('sum-leave').textContent=leaveLogAll.length;
    document.getElementById('sum-salary').textContent=Object.keys(salaryRecMap).length;
    document.getElementById('sum-cost').textContent='$'+Math.round(totalCost/1000)+'K';
    document.getElementById('summaryCard').style.display='block';
    showToast('✅ 匯出成功！');

  }catch(e){
    setProgress(0,'❌ 匯出失敗：'+e.message);
    showToast('❌ 匯出失敗：'+e.message);
    console.error(e);
  }
  document.getElementById('exportBtn').disabled=false;
  document.getElementById('exportBtnText').textContent='再次匯出';
}

// ═══ Sheet ① 人事費用摘要 ═══
function buildSummarySheet(allEmps,salaryRecMap,leaveStatMap,compStatMap,batchMap,stores,year,ym){
  const [y,m]=ym.split('-').map(Number);
  const rocY=y-1911;
  const rows=[];

  rows.push([`莉學商行 民國${rocY}年${m}月 人事費用摘要`]);
  rows.push([`匯出時間：${new Date().toLocaleString('zh-TW')}`]);
  rows.push([]);

  // A. 各門市薪資匯總
  rows.push(['▌ 各門市薪資匯總']);
  rows.push(['門市','員工人數','正職','工讀','應發薪資','代扣合計','實發合計','公司勞退提撥(6%)','★ 本月人事總成本']);
  let gGross=0,gDeduct=0,gNet=0,gPension=0,gCost=0,gFull=0,gPart=0;
  stores.forEach(store=>{
    const emps=allEmps.filter(e=>e.store===store);
    const full=emps.filter(e=>e.role!=='工讀').length;
    const part=emps.filter(e=>e.role==='工讀').length;
    let gross=0,deduct=0,net=0,pension=0;
    emps.forEach(emp=>{
      const rec=salaryRecMap[emp.name];
      if(!rec) return;
      gross+=calcGross(rec,emp.role);
      deduct+=calcDeduct(rec);
      net+=calcNet(rec,emp.role);
      pension+=calcCompPension(rec,emp.role);
    });
    const cost=net+pension;
    gGross+=gross;gDeduct+=deduct;gNet+=net;gPension+=pension;gCost+=cost;
    gFull+=full;gPart+=part;
    rows.push([store,emps.length,full,part,gross,deduct,net,pension,cost]);
  });
  rows.push(['全店合計',allEmps.length,gFull,gPart,gGross,gDeduct,gNet,gPension,gCost]);
  rows.push([]);

  // B. 特休到期警示（90天內）
  rows.push(['▌ 特休到期警示（90天內）']);
  rows.push(['員工','門市','剩餘特休天數','到期日','距到期','狀態']);
  let hasWarn=false;
  allEmps.forEach(emp=>{
    const stat=leaveStatMap[emp.name]||{};
    const remain=Math.max(0,n(stat.annualDays)-n(stat.usedAnnual));
    const exp=getAnnualExpire(emp.name,batchMap,year);
    const days=daysUntilExpire(exp);
    if(days<=90&&remain>0){
      hasWarn=true;
      const status=days<=30?'🔴 緊急':days<=60?'🟠 警示':'🟡 注意';
      rows.push([emp.displayName||emp.name,emp.store,remain+'天',exp,days+'天後',status]);
    }
  });
  if(!hasWarn) rows.push(['（近90天無到期警示）']);
  rows.push([]);

  // C. 本月應發特休
  rows.push(['▌ 本月週年日應發特休提醒']);
  rows.push(['員工','門市','到職日','發放狀態']);
  let hasGrant=false;
  allEmps.forEach(emp=>{
    if(!shouldGrantThisMonth(emp.startDate,ym)) return;
    hasGrant=true;
    const granted=checkAnnualGranted(emp.name,batchMap,year);
    rows.push([emp.displayName||emp.name,emp.store,toROC(emp.startDate),granted?'✅ 已發放':'⚠️ 尚未發放']);
  });
  if(!hasGrant) rows.push(['（本月無週年日員工）']);
  rows.push([]);

  // D. 補休餘額偏高（>5天）
  rows.push(['▌ 補休餘額偏高警示（>5天）']);
  rows.push(['員工','門市','補休餘額','建議']);
  let hasComp=false;
  allEmps.forEach(emp=>{
    const cd=compStatMap[emp.name]||{};
    const remain=Math.max(0,n(cd.earned)-n(cd.used));
    if(remain>5){
      hasComp=true;
      rows.push([emp.displayName||emp.name,emp.store,remain+'天','建議儘速安排補休或折現']);
    }
  });
  if(!hasComp) rows.push(['（無補休餘額偏高員工）']);
  rows.push([]);

  // E. 異常提示
  rows.push(['▌ 異常提示']);
  const noRec=allEmps.filter(e=>!salaryRecMap[e.name]);
  rows.push(noRec.length
    ?[`⚠️ 以下 ${noRec.length} 位員工本月無薪資記錄：`+noRec.map(e=>e.name).join('、')]
    :['✅ 所有在職員工均有薪資記錄']);

  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!merges']=[
    {s:{r:0,c:0},e:{r:0,c:8}},
    {s:{r:1,c:0},e:{r:1,c:8}},
  ];
  ws['!cols']=[
    {wch:12},{wch:10},{wch:6},{wch:6},
    {wch:14},{wch:12},{wch:12},{wch:16},{wch:16}
  ];
  return ws;
}

// ═══ Sheet ② 員工資料 ═══
function buildEmpSheet(allEmps,salaryRecMap,leaveStatMap,compStatMap,batchMap,year,ym){
  const [y,m]=ym.split('-').map(Number);
  const rocY=y-1911;
  const rows=[];
  const headers=[
    '編號','門市','姓名','職稱','到職日','在職年資',
    '底薪/時薪（本月說明）','勞保費','健保費','勞退個人自提',
    '年度特休（發/用/餘）','年度補休（取/用/餘）','剩餘特+補休',
    '特休到期日','特休發放狀態','到期警示'
  ];

  rows.push([`莉學商行 民國${rocY}年${m}月 員工資料`]);
  rows.push([]);
  rows.push(headers);

  // 正職/店長區塊
  const fulls=allEmps.filter(e=>e.role!=='工讀');
  if(fulls.length){
    rows.push(['── 正職 / 店長 ──']);
    let seq=1;
    fulls.forEach(emp=>{
      const rec=salaryRecMap[emp.name]||{};
      const stat=leaveStatMap[emp.name]||{};
      const cd=compStatMap[emp.name]||{};
      const annD=n(stat.annualDays),usedA=n(stat.usedAnnual);
      const earnC=n(cd.earned),usedC=n(cd.used);
      const remA=Math.max(0,annD-usedA), remC=Math.max(0,earnC-usedC);
      const exp=getAnnualExpire(emp.name,batchMap,year);
      const days=daysUntilExpire(exp);
      const granted=checkAnnualGranted(emp.name,batchMap,year);
      const warn=days<=30?'🔴 緊急':days<=60?'🟠 警示':days<=90?'🟡 注意':'';
      const baseSal=n(rec.baseSalary)||n(emp.baseSalary);
      rows.push([
        seq++,emp.store,emp.name,emp.role,toROC(emp.startDate),calcSeniority(emp.startDate),
        `底薪 $${comma(baseSal)}`,
        n(rec.laborInsurance),n(rec.healthInsurance)+n(rec.dependentInsurance),n(rec.laborPension),
        `${annD}/${usedA}/${remA}`,`${earnC}/${usedC}/${remC}`,remA+remC,
        exp,
        granted?'✅ 已發放':(shouldGrantThisMonth(emp.startDate,ym)?'⚠️ 本月應發':'--'),
        warn
      ]);
    });
  }

  rows.push([]);

  // 工讀區塊
  const parts=allEmps.filter(e=>e.role==='工讀');
  if(parts.length){
    rows.push(['── 工讀生 ──']);
    let seq=fulls.length+1;
    parts.forEach(emp=>{
      const rec=salaryRecMap[emp.name]||{};
      const cd=compStatMap[emp.name]||{};
      const earnC=n(cd.earned),usedC=n(cd.used);
      const remC=Math.max(0,earnC-usedC);
      const wage=n(rec.wage)||n(emp.wage);
      const hrs=n(rec.hours||0);
      rows.push([
        seq++,emp.store,emp.name,emp.role,toROC(emp.startDate),calcSeniority(emp.startDate),
        `時薪 $${wage}，本月 ${hrs}h → $${comma(Math.round(wage*hrs))}`,
        n(rec.laborInsurance),n(rec.healthInsurance)+n(rec.dependentInsurance),n(rec.laborPension),
        '--',`${earnC}/${usedC}/${remC}`,remC,'--','--',''
      ]);
    });
  }

  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:headers.length-1}}];
  ws['!cols']=[
    {wch:5},{wch:8},{wch:10},{wch:8},{wch:12},{wch:10},
    {wch:30},{wch:10},{wch:10},{wch:12},
    {wch:16},{wch:16},{wch:12},
    {wch:14},{wch:14},{wch:10}
  ];
  ws['!freeze']={xSplit:3,ySplit:3};
  return ws;
}

// ═══ Sheet ③ 特補休紀錄 ═══
function buildLeaveSheet(allEmps,leaveLogAll,leaveStatMap,compStatMap,batchMap,year,ym,month){
  const [y,m]=ym.split('-').map(Number);
  const rocY=y-1911;
  const rows=[];

  // 左9欄 + 空白1 + 右11欄 = 21欄
  const STAT=10;
  const TOTAL=STAT+11;
  const mkRow=()=>new Array(TOTAL).fill('');

  let r=mkRow();
  r[0]=`莉學商行 民國${rocY}年 特補休紀錄（1月至${m}月）`;
  r[STAT]=`民國${rocY}年 特補休統計表`;
  rows.push(r);
  rows.push(mkRow());

  r=mkRow();
  ['日期','門市','姓名','職稱','類型','天數','備註','操作人','特休到期日'].forEach((h,i)=>r[i]=h);
  ['編號','門市','姓名','職稱','取得特休','使用特休','剩餘特休','年度折現天數',
   '取得補休','使用補休','剩餘補休'].forEach((h,i)=>r[STAT+i]=h);
  rows.push(r);

  // 計算折現天數（annual_encash 筆數加總）
  const encashMap={};
  leaveLogAll.filter(l=>l.typeKey==='annual_encash').forEach(l=>{
    encashMap[l.empName]=(encashMap[l.empName]||0)+n(l.days);
  });

  const total=Math.max(leaveLogAll.length,allEmps.length);
  let seq=1;
  for(let i=0;i<total;i++){
    r=mkRow();
    if(i<leaveLogAll.length){
      const log=leaveLogAll[i];
      r[0]=toROC(log.date);r[1]=log.store;r[2]=log.empName;r[3]=log.role;
      r[4]=log.typeLabel;r[5]=log.days;r[6]=log.note;r[7]=log.savedBy;
      r[8]=log.cat==='annual'?getAnnualExpire(log.empName,batchMap,year):'';
    }
    if(i<allEmps.length){
      const emp=allEmps[i];
      const stat=leaveStatMap[emp.name]||{};
      const cd=compStatMap[emp.name]||{};
      const annD=n(stat.annualDays),usedA=n(stat.usedAnnual);
      const earnC=n(cd.earned),usedC=n(cd.used);
      r[STAT+0]=seq++;r[STAT+1]=emp.store;r[STAT+2]=emp.name;r[STAT+3]=emp.role||'';
      r[STAT+4]=annD;r[STAT+5]=usedA;r[STAT+6]=Math.max(0,annD-usedA);
      r[STAT+7]=encashMap[emp.name]||0;
      r[STAT+8]=earnC;r[STAT+9]=usedC;r[STAT+10]=Math.max(0,earnC-usedC);
    }
    rows.push(r);
  }

  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!merges']=[
    {s:{r:0,c:0},e:{r:0,c:8}},
    {s:{r:0,c:STAT},e:{r:0,c:TOTAL-1}},
  ];
  ws['!cols']=[
    {wch:12},{wch:8},{wch:10},{wch:8},{wch:14},{wch:6},{wch:20},{wch:12},{wch:14},
    {wch:2},
    {wch:5},{wch:8},{wch:10},{wch:8},{wch:10},{wch:10},{wch:10},{wch:12},
    {wch:10},{wch:10},{wch:10}
  ];
  return ws;
}

// ═══ Sheet ④ 薪資明細 ═══
function buildSalarySheet(allEmps,salaryRecMap,stores,ym){
  const [y,m]=ym.split('-').map(Number);
  const rocY=y-1911;
  const rows=[];

  const headers=[
    '編號','門市','姓名','職稱',
    '底薪(B1)','工讀時數','工讀本薪','全勤獎金(B2)',
    '管理責任獎金','勞務津貼','績效獎金','夜點費','其他津貼','職務津貼',
    '特休折現','補休折現',
    '平日加班時數','國假時數','平日加班費','休息日加班費','國假加班費',
    '遲到分鐘','遲到扣款','事病假扣款',
    '應發薪資',
    '勞保費','健保費','眷屬健保','勞退個人自提','其他扣款',
    '實發金額','公司勞退提撥(6%)','★ 實際人事成本'
  ];
  const NC=headers.length; // 33欄

  rows.push([`莉學商行 民國${rocY}年${m}月 薪資明細`]);
  rows.push([]);
  rows.push(headers);

  let seq=1;
  stores.forEach(store=>{
    const storeEmps=allEmps.filter(e=>e.store===store);
    if(!storeEmps.length) return;

    // 正職/店長
    const fulls=storeEmps.filter(e=>e.role!=='工讀');
    if(fulls.length){
      const divRow=new Array(NC).fill(''); divRow[1]=`── ${store} 正職/店長 ──`;
      rows.push(divRow);
      fulls.forEach(emp=>rows.push(buildSalaryRow(seq++,emp,salaryRecMap[emp.name],NC)));
    }
    // 工讀
    const parts=storeEmps.filter(e=>e.role==='工讀');
    if(parts.length){
      const divRow=new Array(NC).fill(''); divRow[1]=`── ${store} 工讀生 ──`;
      rows.push(divRow);
      parts.forEach(emp=>rows.push(buildSalaryRow(seq++,emp,salaryRecMap[emp.name],NC)));
    }

    // 門市小計
    const subRow=new Array(NC).fill('');
    subRow[2]=`${store} 小計`;
    const sGross=storeEmps.reduce((s,e)=>s+(salaryRecMap[e.name]?calcGross(salaryRecMap[e.name],e.role):0),0);
    const sNet=storeEmps.reduce((s,e)=>s+(salaryRecMap[e.name]?calcNet(salaryRecMap[e.name],e.role):0),0);
    const sPension=storeEmps.reduce((s,e)=>s+(salaryRecMap[e.name]?calcCompPension(salaryRecMap[e.name],e.role):0),0);
    subRow[24]=sGross; subRow[30]=sNet; subRow[31]=sPension; subRow[32]=sNet+sPension;
    rows.push(subRow);
    rows.push(new Array(NC).fill(''));
  });

  // 全店合計（Excel公式）
  const dataStart=4, dataEnd=rows.length+1;
  const totalRow=new Array(NC).fill('');
  totalRow[2]='★ 全店合計';
  [24,30,31,32].forEach(ci=>{
    const col=XLSX.utils.encode_col(ci);
    totalRow[ci]={f:`SUM(${col}${dataStart}:${col}${dataEnd})`,t:'n'};
  });
  rows.push(totalRow);

  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:NC-1}}];
  ws['!cols']=[
    {wch:5},{wch:10},{wch:10},{wch:8},
    {wch:10},{wch:8},{wch:10},{wch:10},
    {wch:14},{wch:10},{wch:10},{wch:8},{wch:10},{wch:8},
    {wch:10},{wch:10},
    {wch:10},{wch:8},{wch:10},{wch:12},{wch:12},
    {wch:8},{wch:10},{wch:10},
    {wch:12},
    {wch:10},{wch:10},{wch:10},{wch:10},{wch:8},
    {wch:12},{wch:14},{wch:14}
  ];
  ws['!freeze']={xSplit:4,ySplit:3};
  return ws;
}

// 單一員工薪資列
function buildSalaryRow(seq,emp,rec,NC){
  const row=new Array(NC).fill('');
  row[0]=seq; row[1]=emp.store; row[2]=emp.displayName||emp.name; row[3]=(emp.role||'')+(isPartRec(rec)&&emp.role!=='工讀'?'(工讀計)':'');
  if(!rec) return row;
  const isPart=isPartRec(rec); // 楷岳等 payAsPartTime 店長走工讀欄位(時薪/工時)
  const mgmt=['mgmtOps','mgmtQuality','mgmtKPI','mgmtAccount','mgmtLeader'].reduce((s,k)=>s+n(rec[k]),0);
  const rph=isPart?0:calcHourlyRate(rec);
  const late=isPart?0:Math.round(rph/60*n(rec.lateMinutes));
  const otPay=isPart?0:calcOtPay(rec);
  const gross=calcGross(rec,emp.role);
  const deduct=calcDeduct(rec);
  const net=gross-deduct;
  const comp=calcCompPension(rec,emp.role);
  if(!isPart){
    row[4]=n(rec.baseSalary);
    row[7]=n(rec.fullAttendBonus);
    row[8]=mgmt||'';
    row[9]=n(rec.laborAllowance)||'';
    row[10]=n(rec.performance)||'';
    row[11]=n(rec.nightAllowance)||'';
    row[12]=n(rec.otherBonus)||'';
    row[13]=n(rec.roleBonus)||'';
    row[16]=n(rec.otHours)||'';
    row[17]=n(rec.holidayHours)||'';
    row[18]=otPay||'';
    row[19]=n(rec.restDayOtPay)||'';
    row[20]=n(rec.holidayOtPay)||'';
    row[21]=n(rec.lateMinutes)||'';
    row[22]=late||'';
  } else {
    row[5]=n(rec.hours||0)||'';
    row[6]=Math.round(n(rec.wage)*n(rec.hours||0))||'';
    row[13]=n(rec.roleBonus)||'';
  }
  row[14]=n(rec.annualLeaveEncash)||'';
  row[15]=n(rec.compLeaveEncash)||'';
  row[23]=Math.abs(n(rec.personalSickLeave))||'';
  row[24]=gross;
  row[25]=n(rec.laborInsurance);
  row[26]=n(rec.healthInsurance);
  row[27]=n(rec.dependentInsurance)||'';
  row[28]=n(rec.laborPension);
  row[29]=n(rec.otherDeduction)||'';
  row[30]=net;
  row[31]=comp||'';
  row[32]=net+comp;
  return row;
}

// ══════════════════════════════════════════
// PDF 預覽
// ══════════════════════════════════════════
let _pdfData = null; // 快取上次讀取的資料

function closePdfModal() {
  const modal = document.getElementById('pdfModal');
  modal.style.display = 'none';
}

async function startPdfPreview() {
  const year  = document.getElementById('selYear').value;
  const month = document.getElementById('selMonth').value;
  const ym    = `${year}-${month}`;
  const stores = appConfig.stores || [];
  if(!stores.length) { showToast('⚠️ 無門市資料'); return; }

  document.getElementById('pdfBtn').disabled = true;
  showLoading('讀取資料中...');

  try {
    // ── 讀取資料（與 Excel 匯出共用邏輯）──
    const [_ey2,_em2]=ym.split('-').map(Number);
    const exportMonthEnd2=`${_ey2}-${String(_em2).padStart(2,'0')}-${new Date(_ey2,_em2,0).getDate()}`;
    let allEmps = [];
    for(const store of stores) {
      const snap = await window.db.collection('stores').doc(store).collection('employees').get();
      snap.forEach(d => {
        const data = d.data();
        const effectDate=data.retireDate||data.transferDate;
        if(['離職','調走'].includes(data.status)&&(!effectDate||effectDate<=exportMonthEnd2)) return;
        if(data.startDate) {
          const [sy,sm] = data.startDate.split('-').map(Number);
          const [cy,cm] = ym.split('-').map(Number);
          if(sy > cy || (sy===cy && sm>cm)) return;
        }
        allEmps.push({ name:d.id, store, ...data });
      });
    }
    allEmps.sort((a,b) => {
      const si = stores.indexOf(a.store)-stores.indexOf(b.store);
      return si!==0 ? si : (a.sortKey||0)-(b.sortKey||0);
    });

    let salaryRecMap = {};
    for(const store of stores) {
      try {
        const snap = await window.db.collection('stores').doc(store).collection('salary').doc(ym).get();
        if(snap.exists)
          (snap.data().records||[]).forEach(r => { salaryRecMap[r.empName]={...r,_store:store}; });
      } catch {}
    }

    let leaveStatMap={}, compStatMap={}, leaveLogAll=[], batchMap={};
    const chunks = chunkArray(allEmps, 6);
    for(const chunk of chunks) {
      await Promise.all(chunk.map(async emp => {
        try {
          const lSnap = await window.db.collection('employees').doc(emp.name).collection('leaves').doc(year).get();
          leaveStatMap[emp.name] = lSnap.exists ? lSnap.data() : {};
          const cSnap = await window.db.collection('employees').doc(emp.name).collection('comp').doc(year).get();
          compStatMap[emp.name] = cSnap.exists ? cSnap.data() : { earned:0, used:0 };
          const bSnap = await window.db.collection('employees').doc(emp.name).collection('leaveBatches').get();
          const batches=[];
          bSnap.forEach(d => batches.push({id:d.id,...d.data()}));
          batchMap[emp.name] = batches.sort((a,b)=>(a.grantDate||'').localeCompare(b.grantDate||''));
          const months=[];
          for(let m2=1; m2<=parseInt(month); m2++)
            months.push(`${year}-${String(m2).padStart(2,'0')}`);
          await Promise.all(months.map(async ym2 => {
            try {
              const logSnap = await window.db.collection('employees').doc(emp.name).collection('leaveLog').doc(ym2).get();
              if(!logSnap.exists) return;
              const typeMap = {
                'annual_use':'特休・使用','annual_encash':'特休・折現','annual_use_cancel':'特休・取消',
                'comp_earn':'補休・取得','comp_use':'補休・使用','comp_cancel':'補休・撤回',
                'comp_encash':'補休・折現','comp_use_cancel':'補休・取消',
              };
              (logSnap.data().records||[]).forEach(r => {
                if(!typeMap[r.type]) return;
                leaveLogAll.push({
                  empName:emp.displayName||emp.name, store:emp.store, role:emp.role||'',
                  date:r.date||ym2+'-01', typeLabel:typeMap[r.type],
                  cat: r.type.startsWith('annual') ? 'annual' : 'comp',
                  days:r.days||0, note:r.note||''
                });
              });
            } catch {}
          }));
        } catch {}
      }));
    }
    leaveLogAll.sort((a,b) => a.date.localeCompare(b.date));

    hideLoading();

    // ── 產生 PDF HTML ──
    pdfPreviewData = { allEmps, salaryRecMap, leaveStatMap, compStatMap, batchMap, leaveLogAll, stores, year, month, ym };
    const visCols = {
      laborAllow: document.getElementById('col-laborAllow').checked,
      perf:       document.getElementById('col-perf').checked,
      other:      document.getElementById('col-other').checked,
      holiday:    document.getElementById('col-holiday').checked,
    };
    const html = buildPdfHtml(allEmps, salaryRecMap, leaveStatMap, compStatMap, batchMap, leaveLogAll, stores, year, month, ym, pdfMode, visCols);
    document.getElementById('pdfPreviewBody').innerHTML = `<div id="pdfContent">${html}</div>`;
    // I. 顯示欄位選擇器（完整版才顯示）
    document.getElementById('colToggleWrap').style.display = pdfMode==='full' ? 'block' : 'none';
    const modal = document.getElementById('pdfModal');
    modal.style.display = 'flex';

  } catch(e) {
    hideLoading();
    showToast('❌ 讀取失敗：' + e.message);
    console.error(e);
  }
  document.getElementById('pdfBtn').disabled = false;
}

function buildPdfHtml(allEmps, salaryRecMap, leaveStatMap, compStatMap, batchMap, leaveLogAll, stores, year, month, ym, mode='simple', visCols={}) {
  const [y, m] = ym.split('-').map(Number);
  const rocY   = y - 1911;
  const now    = new Date().toLocaleString('zh-TW');
  const title  = `莉學商行 民國${rocY}年${m}月 薪資清冊`;
  let html     = '';

  // ════ Page 1：人事費用摘要 ════
  let gGross=0,gNet=0,gPension=0,gCost=0;
  const storeStats = stores.map(store => {
    const emps = allEmps.filter(e => e.store===store);
    let gross=0,deduct=0,net=0,pension=0;
    emps.forEach(emp => {
      const rec = salaryRecMap[emp.name];
      if(!rec) return;
      gross+=calcGross(rec,emp.role); deduct+=calcDeduct(rec);
      net+=calcNet(rec,emp.role); pension+=calcCompPension(rec,emp.role);
    });
    gGross+=gross; gNet+=net; gPension+=pension; gCost+=net+pension;
    return { store, count:emps.length,
      full:emps.filter(e=>e.role!=='工讀').length,
      part:emps.filter(e=>e.role==='工讀').length,
      gross, deduct, net, pension, cost:net+pension };
  });

  // 警示列表
  const warnList = [];
  allEmps.forEach(emp => {
    const stat  = leaveStatMap[emp.name]||{};
    const remain= Math.max(0,n(stat.annualDays)-n(stat.usedAnnual));
    const exp   = getAnnualExpire(emp.name,batchMap,year);
    const days  = daysUntilExpire(exp);
    if(days<=90 && remain>0)
      warnList.push({ name:emp.displayName||emp.name, store:emp.store, remain, exp, days,
        cls: days<=30?'warn-red':days<=60?'warn-orange':'warn-yellow',
        badge: days<=30?'badge-red':days<=60?'badge-orange':'badge-blue',
        label: days<=30?'🔴 緊急':days<=60?'🟠 警示':'🟡 注意' });
  });

  const grantList = allEmps.filter(e => shouldGrantThisMonth(e.startDate,ym));
  const compWarnList = allEmps.filter(e => {
    const cd = compStatMap[e.name]||{};
    return Math.max(0,n(cd.earned)-n(cd.used)) > 5;
  });

  html += `<div class="pdf-page">
    <div class="pdf-header">
      <div><div class="pdf-header-title">📊 ${title}</div><div class="pdf-header-sub">人事費用摘要</div></div>
      <div style="text-align:right;font-size:10px;opacity:0.8;">匯出時間：${now}</div>
    </div>
    <div class="pdf-body">
      <!-- 總覽數字 -->
      <div class="pdf-summary-grid">
        <div class="pdf-summary-box"><div class="pdf-summary-num">${allEmps.length}</div><div class="pdf-summary-label">全店員工人數</div></div>
        <div class="pdf-summary-box"><div class="pdf-summary-num">$${Math.round(gGross/1000)}K</div><div class="pdf-summary-label">應發薪資合計</div></div>
        <div class="pdf-summary-box"><div class="pdf-summary-num">$${Math.round(gNet/1000)}K</div><div class="pdf-summary-label">實發薪資合計</div></div>
        <div class="pdf-summary-box" style="background:#f0fdf4;border-color:#bbf7d0;"><div class="pdf-summary-num" style="color:#16a34a;">$${Math.round(gCost/1000)}K</div><div class="pdf-summary-label">★ 實際人事總成本</div></div>
      </div>

      <!-- 門市薪資匯總 -->
      <div class="pdf-section">
        <div class="pdf-section-title">各門市薪資匯總</div>
        <table class="pdf-table">
          <tr><th>門市</th><th>人數</th><th>正職</th><th>工讀</th><th>應發薪資</th><th>代扣合計</th><th>實發合計</th><th>公司勞退(6%)</th><th style="background:#1e3a8a;">★ 人事總成本</th></tr>
          ${storeStats.map(s=>`<tr>
            <td style="font-weight:700;text-align:left;">${s.store}</td>
            <td>${s.count}</td><td>${s.full}</td><td>${s.part}</td>
            <td>$${comma(s.gross)}</td><td style="color:#dc2626;">$${comma(s.deduct)}</td>
            <td style="font-weight:700;">$${comma(s.net)}</td>
            <td>$${comma(s.pension)}</td>
            <td style="font-weight:900;color:#1a73e8;">$${comma(s.cost)}</td>
          </tr>`).join('')}
          <tr class="grand-total">
            <td style="text-align:left;">全店合計</td>
            <td>${allEmps.length}</td>
            <td>${allEmps.filter(e=>e.role!=='工讀').length}</td>
            <td>${allEmps.filter(e=>e.role==='工讀').length}</td>
            <td>$${comma(gGross)}</td><td>$${comma(gGross-gNet)}</td>
            <td>$${comma(gNet)}</td><td>$${comma(gPension)}</td>
            <td>$${comma(gCost)}</td>
          </tr>
        </table>
      </div>

      <!-- 警示區 -->
      ${warnList.length ? `<div class="pdf-section">
        <div class="pdf-section-title" style="color:#dc2626;">⚠️ 特休到期警示（90天內）</div>
        <table class="pdf-table">
          <tr><th>員工</th><th>門市</th><th>剩餘特休</th><th>到期日</th><th>距到期</th><th>狀態</th></tr>
          ${warnList.map(w=>`<tr class="${w.cls}">
            <td style="font-weight:700;">${w.name}</td><td>${w.store}</td>
            <td>${w.remain}天</td><td>${w.exp}</td><td>${w.days}天後</td>
            <td><span class="${w.badge}">${w.label}</span></td>
          </tr>`).join('')}
        </table>
      </div>` : `<div class="pdf-alert"><div class="pdf-alert-title">✅ 特休到期</div>近90天無到期警示</div>`}

      ${grantList.length ? `<div class="pdf-section">
        <div class="pdf-section-title" style="color:#9334e6;">📅 本月週年日應發特休</div>
        <table class="pdf-table">
          <tr><th>員工</th><th>門市</th><th>到職日</th><th>發放狀態</th></tr>
          ${grantList.map(e=>{
            const granted = checkAnnualGranted(e.name,batchMap,year);
            return `<tr>
              <td style="font-weight:700;">${e.displayName||e.name}</td><td>${e.store}</td>
              <td>${toROC(e.startDate)}</td>
              <td><span class="${granted?'badge-green':'badge-red'}">${granted?'✅ 已發放':'⚠️ 尚未發放'}</span></td>
            </tr>`;
          }).join('')}
        </table>
      </div>` : ''}

      ${compWarnList.length ? `<div class="pdf-section">
        <div class="pdf-section-title" style="color:#ea580c;">⏰ 補休餘額偏高（>5天）</div>
        <table class="pdf-table">
          <tr><th>員工</th><th>門市</th><th>補休餘額</th><th>建議</th></tr>
          ${compWarnList.map(e=>{
            const cd=compStatMap[e.name]||{};
            const rem=Math.max(0,n(cd.earned)-n(cd.used));
            return `<tr><td style="font-weight:700;">${e.displayName||e.name}</td><td>${e.store}</td><td style="color:#ea580c;font-weight:700;">${rem}天</td><td>建議儘速安排補休或折現</td></tr>`;
          }).join('')}
        </table>
      </div>` : ''}
    </div>
    <div class="pdf-footer"><span>${title} · 人事費用摘要</span><span>第 1 頁</span></div>
  </div>`;

  // ════ Page 2：員工資料 ════
  const empRows = allEmps.map((emp,i) => {
    const rec   = salaryRecMap[emp.name]||{};
    const stat  = leaveStatMap[emp.name]||{};
    const cd    = compStatMap[emp.name]||{};
    const isPart= emp.role==='工讀';
    const annD  = n(stat.annualDays), usedA=n(stat.usedAnnual);
    const earnC = n(cd.earned), usedC=n(cd.used);
    const remA  = Math.max(0,annD-usedA), remC=Math.max(0,earnC-usedC);
    const exp   = isPart?'--':getAnnualExpire(emp.name,batchMap,year);
    const expDays=daysUntilExpire(exp);
    const granted=!isPart&&checkAnnualGranted(emp.name,batchMap,year);
    const warn=expDays<=30?'badge-red':expDays<=60?'badge-orange':expDays<=90?'badge-blue':'';
    const warnLabel=expDays<=30?'🔴':expDays<=60?'🟠':expDays<=90?'🟡':'';
    const wage=isPart?(n(rec.wage)||n(emp.wage)):(n(rec.baseSalary)||n(emp.baseSalary));
    const hrs=n(rec.hours||0);
    return `<tr ${i%2===1?'style="background:#f8fafc;"':''}>
      <td>${i+1}</td><td style="font-weight:700;">${emp.store}</td>
      <td style="font-weight:800;">${emp.displayName||emp.name}</td>
      <td><span class="${emp.role==='工讀'?'badge-blue':emp.role==='店長'?'badge-red':'badge-green'}">${emp.role||''}</span></td>
      <td>${toROC(emp.startDate)}</td>
      <td>${calcSeniority(emp.startDate)}</td>
      <td style="text-align:right;">${isPart?`$${wage}/hr × ${hrs}h = $${comma(Math.round(wage*hrs))}`:`$${comma(wage)}`}</td>
      <td style="text-align:right;">${n(rec.laborInsurance)||'--'}</td>
      <td style="text-align:right;">${(n(rec.healthInsurance)+n(rec.dependentInsurance))||'--'}</td>
      <td style="text-align:right;">${n(rec.laborPension)||'--'}</td>
      <td>${isPart?'--':`${annD}/${usedA}/${remA}`}</td>
      <td>${`${earnC}/${usedC}/${remC}`}</td>
      <td style="font-weight:700;">${isPart?remC:remA+remC}</td>
      <td>${isPart?'--':exp}</td>
      <td>${isPart?'--':`<span class="${granted?'badge-green':'badge-orange'}">${granted?'✅ 已發':'⚠️ 未發'}</span>`}</td>
      <td>${warn?`<span class="${warn}">${warnLabel}</span>`:''}</td>
    </tr>`;
  }).join('');

  html += `<div class="pdf-page">
    <div class="pdf-header">
      <div><div class="pdf-header-title">👥 ${title}</div><div class="pdf-header-sub">員工資料</div></div>
    </div>
    <div class="pdf-body">
      <table class="pdf-table">
        <tr>
          <th>#</th><th>門市</th><th>姓名</th><th>職稱</th><th>到職日</th><th>年資</th>
          <th>底薪/時薪（本月）</th><th>勞保</th><th>健保</th><th>勞退</th>
          <th>特休發/用/餘</th><th>補休取/用/餘</th><th>特+補餘</th>
          <th>特休到期</th><th>發放</th><th>警示</th>
        </tr>
        ${empRows}
      </table>
    </div>
    <div class="pdf-footer"><span>${title} · 員工資料</span><span>第 2 頁</span></div>
  </div>`;

  // ════ Page 3：特補休紀錄 ════
  const leaveRows = leaveLogAll.map((log,i) => {
    const exp = log.cat==='annual' ? getAnnualExpire(log.empName,batchMap,year) : '--';
    const isAnnual = log.cat==='annual';
    return `<tr ${i%2===1?'style="background:#f8fafc;"':''}>
      <td>${toROC(log.date)}</td>
      <td>${log.store}</td>
      <td style="font-weight:700;">${log.empName}</td>
      <td>${log.role}</td>
      <td><span class="${isAnnual?'badge-orange':'badge-blue'}">${log.typeLabel}</span></td>
      <td style="font-weight:700;">${log.days}</td>
      <td style="text-align:left;font-size:10px;">${log.note}</td>
      <td>${isAnnual?exp:'--'}</td>
    </tr>`;
  }).join('');

  // 統計表
  const statRows = allEmps.map((emp,i) => {
    const stat  = leaveStatMap[emp.name]||{};
    const cd    = compStatMap[emp.name]||{};
    const annD  = n(stat.annualDays), usedA=n(stat.usedAnnual), remA=Math.max(0,annD-usedA);
    const earnC = n(cd.earned), usedC=n(cd.used), remC=Math.max(0,earnC-usedC);
    const encash= leaveLogAll.filter(l=>l.empName===emp.name&&l.typeLabel==='特休・折現').reduce((s,l)=>s+n(l.days),0);
    const exp   = emp.role!=='工讀' ? getAnnualExpire(emp.name,batchMap,year) : '--';
    return `<tr ${i%2===1?'style="background:#f8fafc;"':''}>
      <td>${i+1}</td><td>${emp.store}</td>
      <td style="font-weight:700;">${emp.displayName||emp.name}</td>
      <td>${emp.role||''}</td>
      <td>${annD}</td><td>${usedA}</td>
      <td style="font-weight:700;color:${remA>0?'#1a73e8':'#64748b'};">${remA}</td>
      <td style="color:#9334e6;">${encash||'--'}</td>
      <td>${earnC}</td><td>${usedC}</td>
      <td style="font-weight:700;color:${remC>0?'#16a34a':'#64748b'};">${remC}</td>
      <td style="font-size:10px;">${exp}</td>
    </tr>`;
  }).join('');

  html += `<div class="pdf-page">
    <div class="pdf-header" style="background:linear-gradient(135deg,#9334e6,#6a1bb5);">
      <div><div class="pdf-header-title">📋 ${title}</div><div class="pdf-header-sub">特補休紀錄（民國${rocY}年 1月至${m}月）</div></div>
    </div>
    <div class="pdf-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div>
          <div class="pdf-section-title" style="color:#9334e6;">流水明細</div>
          <table class="pdf-table">
            <tr><th>日期</th><th>門市</th><th>姓名</th><th>職稱</th><th>類型</th><th>天數</th><th>備註</th><th>到期日</th></tr>
            ${leaveRows||'<tr><td colspan="8" style="color:#94a3b8;">本年度無紀錄</td></tr>'}
          </table>
        </div>
        <div>
          <div class="pdf-section-title" style="color:#9334e6;">統計表</div>
          <table class="pdf-table">
            <tr><th>#</th><th>門市</th><th>姓名</th><th>職稱</th><th>取得</th><th>使用</th><th>餘特</th><th>折現</th><th>取補</th><th>用補</th><th>餘補</th><th>到期日</th></tr>
            ${statRows}
          </table>
        </div>
      </div>
    </div>
    <div class="pdf-footer"><span>${title} · 特補休紀錄</span><span>第 3 頁</span></div>
  </div>`;

  // ════ Page 4：薪資明細 ════
  html += buildSalaryPageHtml(allEmps, salaryRecMap, stores, ym, year, month, mode, visCols);
  return html;
}

// 薪資頁 HTML（支援精簡/完整 + 欄位勾選）
function buildSalaryPageHtml(allEmps, salaryRecMap, stores, ym, year, month, mode, visCols={}) {
  const [y,m] = ym.split('-').map(Number);
  const rocY = y-1911;
  const title = `莉學商行 民國${rocY}年${m}月 薪資清冊`;
  let html = '';

  if(mode === 'simple') {
    // 精簡：5 欄
    let sRows='';
    stores.forEach(store=>{
      const emps=allEmps.filter(e=>e.store===store);
      if(!emps.length) return;
      sRows+=`<tr class="section-header"><td colspan="5">── ${store} ──</td></tr>`;
      let sGross=0,sNet=0,sPension=0;
      emps.forEach((emp,i)=>{
        const rec=salaryRecMap[emp.name];
        if(!rec){sRows+=`<tr><td>${emp.displayName||emp.name}</td><td colspan="4" style="color:#94a3b8;">無薪資記錄</td></tr>`;return;}
        const gross=calcGross(rec,emp.role),net=calcNet(rec,emp.role),comp=calcCompPension(rec,emp.role);
        sGross+=gross;sNet+=net;sPension+=comp;
        sRows+=`<tr style="${i%2===1?'background:#f8fafc':''}">
          <td style="font-weight:800;text-align:left;">${emp.displayName||emp.name}</td>
          <td style="text-align:right;">$${comma(gross)}</td>
          <td style="text-align:right;font-weight:700;color:#16a34a;">$${comma(net)}</td>
          <td style="text-align:right;">$${comma(comp)||'-'}</td>
          <td style="text-align:right;font-weight:900;color:#1a73e8;">$${comma(net+comp)}</td>
        </tr>`;
      });
      sRows+=`<tr class="subtotal">
        <td style="text-align:left;font-weight:900;">${store} 小計</td>
        <td style="text-align:right;">$${comma(sGross)}</td>
        <td style="text-align:right;">$${comma(sNet)}</td>
        <td style="text-align:right;">$${comma(sPension)}</td>
        <td style="text-align:right;">$${comma(sNet+sPension)}</td>
      </tr><tr><td colspan="5" style="height:6px;"></td></tr>`;
    });
    const tGross=allEmps.reduce((s,e)=>{const r=salaryRecMap[e.name];return r?s+calcGross(r,e.role):s;},0);
    const tNet=allEmps.reduce((s,e)=>{const r=salaryRecMap[e.name];return r?s+calcNet(r,e.role):s;},0);
    const tPension=allEmps.reduce((s,e)=>{const r=salaryRecMap[e.name];return r?s+calcCompPension(r,e.role):s;},0);
    html = `<div class="pdf-page pdf-page-landscape" id="pdf-salary-page" style="page-break-before:always;">
      <div class="pdf-header" style="background:linear-gradient(135deg,#34a853,#1e7e34);">
        <div><div class="pdf-header-title">💰 ${title}</div><div class="pdf-header-sub">薪資明細（精簡版）</div></div>
      </div>
      <div class="pdf-body">
        <table class="pdf-table">
          <tr><th style="text-align:left;min-width:70px;">姓名</th><th>應發薪資</th><th>實發金額</th><th>公司勞退(6%)</th><th style="background:#1e3a8a;">人事成本</th></tr>
          ${sRows}
          <tr class="grand-total">
            <td style="text-align:left;">★ 全店合計</td>
            <td>$${comma(tGross)}</td><td>$${comma(tNet)}</td><td>$${comma(tPension)}</td><td>$${comma(tNet+tPension)}</td>
          </tr>
        </table>
      </div>
      <div class="pdf-footer"><span>${title} · 薪資明細（精簡）</span><span>第 4 頁</span></div>
    </div>`;
    return html;
  }

  // 完整版：動態欄位
  const showLA = visCols.laborAllow !== false;
  const showPf = visCols.perf      !== false;
  const showOt = visCols.other     !== false;
  const showHo = visCols.holiday   !== false;
  const optCount = [showLA,showPf,showOt,showHo].filter(Boolean).length;
  const totalCols = 15 + optCount; // base 15 + optional cols

  let salRows = '';
  stores.forEach(store => {
    const storeEmps = allEmps.filter(e => e.store===store);
    if(!storeEmps.length) return;
    let sGross=0,sNet=0,sPension=0;
    // 正職
    const fulls=storeEmps.filter(e=>e.role!=='工讀');
    if(fulls.length) {
      salRows+=`<tr class="section-header"><td colspan="21">── ${store} 正職/店長 ──</td></tr>`;
      fulls.forEach((emp,i) => {
        const rec=salaryRecMap[emp.name];
        if(!rec){salRows+=`<tr><td>${emp.displayName||emp.name}</td><td colspan="20" style="color:#94a3b8;">無薪資記錄</td></tr>`;return;}
        const mgmt=['mgmtOps','mgmtQuality','mgmtKPI','mgmtAccount','mgmtLeader'].reduce((s,k)=>s+n(rec[k]),0);
        const rph=calcHourlyRate(rec),late=Math.round(rph/60*n(rec.lateMinutes));
        const otPay=calcOtPay(rec),gross=calcGross(rec,emp.role);
        const deduct=calcDeduct(rec),net=gross-deduct,comp=calcCompPension(rec,emp.role);
        sGross+=gross;sNet+=net;sPension+=comp;
        salRows+=`<tr style="${i%2===1?'background:#f8fafc':''}">
          <td style="font-weight:800;">${emp.displayName||emp.name}</td>
          <td style="text-align:right;">$${comma(n(rec.baseSalary))}</td>
          <td style="text-align:right;">$${comma(n(rec.fullAttendBonus))}</td>
          <td style="text-align:right;">${mgmt?`$${comma(mgmt)}`:'-'}</td>
          <td class="opt-col-la" style="text-align:right;">${n(rec.laborAllowance)?`$${comma(n(rec.laborAllowance))}`:'-'}</td>
          <td class="opt-col-pf" style="text-align:right;">${n(rec.performance)?`$${comma(n(rec.performance))}`:'-'}</td>
          <td class="opt-col-ot" style="text-align:right;">${n(rec.otherBonus)?`$${comma(n(rec.otherBonus))}`:'-'}</td>
          <td class="opt-col-ho" style="text-align:right;">${n(rec.annualLeaveEncash)||n(rec.compLeaveEncash)?`$${comma(n(rec.annualLeaveEncash)+n(rec.compLeaveEncash))}`:'-'}</td>
          <td style="text-align:right;">${n(rec.otHours)?`${n(rec.otHours)}h`:'-'}</td>
          <td style="text-align:right;color:#16a34a;">${otPay?`+$${comma(otPay)}`:'-'}</td>
          <td style="text-align:right;">${n(rec.lateMinutes)?`${n(rec.lateMinutes)}分 -$${comma(late)}`:'-'}</td>
          <td style="text-align:right;">${Math.abs(n(rec.personalSickLeave))?`-$${comma(Math.abs(n(rec.personalSickLeave)))}`:'-'}</td>
          <td style="text-align:right;font-weight:700;background:#eff6ff;">$${comma(gross)}</td>
          <td style="text-align:right;color:#dc2626;">$${comma(n(rec.laborInsurance))}</td>
          <td style="text-align:right;color:#dc2626;">$${comma(n(rec.healthInsurance)+n(rec.dependentInsurance))}</td>
          <td style="text-align:right;color:#dc2626;">$${comma(n(rec.laborPension))}</td>
          <td style="text-align:right;font-weight:800;background:#dcfce7;">$${comma(net)}</td>
          <td style="text-align:right;">$${comma(comp)||'-'}</td>
          <td style="text-align:right;font-weight:900;color:#1a73e8;">$${comma(net+comp)}</td>
        </tr>`;
      });
    }
    // 工讀
    const parts=storeEmps.filter(e=>e.role==='工讀');
    if(parts.length) {
      salRows+=`<tr class="section-header"><td colspan="21">── ${store} 工讀生 ──</td></tr>`;
      parts.forEach((emp,i) => {
        const rec=salaryRecMap[emp.name];
        if(!rec){salRows+=`<tr><td>${emp.displayName||emp.name}</td><td colspan="20" style="color:#94a3b8;">無薪資記錄</td></tr>`;return;}
        const wage=n(rec.wage),hrs=n(rec.hours||0);
        const gross=calcGross(rec,emp.role),deduct=calcDeduct(rec),net=gross-deduct;
        sGross+=gross;sNet+=net;
        salRows+=`<tr style="${i%2===1?'background:#f8fafc':''}">
          <td style="font-weight:800;">${emp.displayName||emp.name}</td>
          <td style="text-align:right;">$${wage}/hr×${hrs}h</td>
          <td colspan="6" style="text-align:center;color:#94a3b8;">（工讀生）</td>
          <td style="text-align:right;">${n(rec.holidayHours)?`${n(rec.holidayHours)}h`:'-'}</td>
          <td style="text-align:right;color:#16a34a;">${n(rec.holidayHours)?`+$${comma(Math.round(wage*n(rec.holidayHours)))}`:'-'}</td>
          <td>-</td><td style="text-align:right;">${Math.abs(n(rec.personalSickLeave))?`-$${comma(Math.abs(n(rec.personalSickLeave)))}`:'-'}</td>
          <td style="text-align:right;font-weight:700;background:#eff6ff;">$${comma(gross)}</td>
          <td style="text-align:right;color:#dc2626;">$${comma(n(rec.laborInsurance))}</td>
          <td style="text-align:right;color:#dc2626;">$${comma(n(rec.healthInsurance)+n(rec.dependentInsurance))}</td>
          <td style="text-align:right;color:#dc2626;">$${comma(n(rec.laborPension))}</td>
          <td style="text-align:right;font-weight:800;background:#dcfce7;">$${comma(net)}</td>
          <td>-</td>
          <td style="text-align:right;font-weight:900;color:#1a73e8;">$${comma(net)}</td>
        </tr>`;
      });
    }
    // 門市小計
    salRows+=`<tr class="subtotal">
      <td style="text-align:left;font-weight:900;">${store} 小計</td>
      <td colspan="11"></td>
      <td style="text-align:right;">$${comma(sGross)}</td>
      <td colspan="3"></td>
      <td style="text-align:right;">$${comma(sNet)}</td>
      <td style="text-align:right;">$${comma(sPension)}</td>
      <td style="text-align:right;">$${comma(sNet+sPension)}</td>
    </tr><tr><td colspan="21" style="height:6px;"></td></tr>`;
  });

  // 全店合計
  const totalGross=allEmps.reduce((s,e)=>{const r=salaryRecMap[e.name];return r?s+calcGross(r,e.role):s;},0);
  const totalNet=allEmps.reduce((s,e)=>{const r=salaryRecMap[e.name];return r?s+calcNet(r,e.role):s;},0);
  const totalPension=allEmps.reduce((s,e)=>{const r=salaryRecMap[e.name];return r?s+calcCompPension(r,e.role):s;},0);

  // I. 加 class 到可選欄位（勞務津貼、績效、其他津貼、假日結算）
  // 使用 CSS 注入控制顯示，不重建 HTML
  const pdfColStyle = `
    ${visCols.laborAllow===false?'.opt-col-la{display:none;}':''}
    ${visCols.perf===false?'.opt-col-pf{display:none;}':''}
    ${visCols.other===false?'.opt-col-ot{display:none;}':''}
    ${visCols.holiday===false?'.opt-col-ho{display:none;}':''}
  `;

  html = `<div class="pdf-page pdf-page-landscape" id="pdf-salary-page" style="page-break-before:always;">
    <style id="pdf-col-style">${pdfColStyle}</style>
    <div class="pdf-header" style="background:linear-gradient(135deg,#34a853,#1e7e34);">
      <div><div class="pdf-header-title">💰 ${title}</div><div class="pdf-header-sub">薪資明細（完整版）</div></div>
    </div>
    <div class="pdf-body" style="overflow-x:auto;">
      <table class="pdf-table" style="min-width:1200px;">
        <tr>
          <th style="min-width:70px;">姓名</th>
          <th>底薪/時薪</th><th>全勤</th><th>管理獎金</th>
          <th class="opt-col-la">勞務津貼</th><th class="opt-col-pf">績效</th><th class="opt-col-ot">其他津貼</th><th class="opt-col-ho">假日結算</th>
          <th>加班時數</th><th>加班費</th><th>遲到扣</th><th>事病假</th>
          <th style="background:#1e3a8a;">應發薪資</th>
          <th style="background:#7f1d1d;">勞保</th><th style="background:#7f1d1d;">健保</th><th style="background:#7f1d1d;">勞退</th>
          <th style="background:#14532d;">實發金額</th>
          <th>公司勞退</th><th style="background:#1e3a8a;">人事成本</th>
        </tr>
        ${salRows}
        <tr class="grand-total">
          <td style="text-align:left;">★ 全店合計</td>
          <td colspan="11"></td>
          <td>$${comma(totalGross)}</td>
          <td colspan="3"></td>
          <td>$${comma(totalNet)}</td>
          <td>$${comma(totalPension)}</td>
          <td>$${comma(totalNet+totalPension)}</td>
        </tr>
      </table>
    </div>
    <div class="pdf-footer"><span>${title} · 薪資明細</span><span>第 4 頁</span></div>
  </div>`;

  return html;
}
