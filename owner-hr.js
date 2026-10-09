// 加盟主儀表板〔人事〕分頁（2026-10-10，原 analytics.html 併入；方案甲：照「想知道什麼」分 4 個小分頁）
//   ① 錢花在哪：成本組成（薪資／加班＋國假／公司負擔）＋門市×月份明細＋各店每週工時
//   ② 要注意的人：加班分級、單週工時、連上 7 天、薪資波動、知情放行 → 一人一列帶標籤
//   ③ 跨店支援：流向（誰去誰那裡）＋各店淨額＋逐筆明細
//   ④ 員工：一人一張卡（時薪、工時、加班、國假、支援、成本）
// ⚠️ 計算邏輯「原封不動」搬自 analytics-page.js（資料讀取、calcGross／calcErBurden／支援調整規則），只重寫畫面；
//    數字必須跟原本人事分析一致。整支包在 IIFE 裡，只對外露 window.HR——儀表板頂層已有 n／money／esc 等 const，
//    頂層同名宣告會讓整頁 script 中斷（記憶：重構安全網 check-globals）。
(function () {
  'use strict';
  const n = v => parseFloat(v) || 0;
  const comma = v => Math.round(n(v)).toLocaleString();
  const wan = v => (Math.abs(v) >= 10000 ? (Math.round(v / 1000) / 10) + ' 萬' : '$' + comma(v));
  const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let displayNameMap = {};
  const dispName = nm => displayNameMap[nm] || nm;

  function weekStringToDate(wStr){
    let p=wStr.split('-W'); let yr=parseInt(p[0]); let wk=parseInt(p[1]);
    let d=new Date(yr,0,1); let day=d.getDay();
    d.setDate(d.getDate()+(wk-1)*7);
    let offset=day<=4?1-day:8-day;
    d.setDate(d.getDate()+offset);
    return d;
  }

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


  // ===== 資料讀取（原 runAnalysis 主體，逐字搬移）=====
  async function hrLoad(ymList, stores, setProgress) {
    const anaYears = [...new Set(ymList.map(x => parseInt(x.slice(0, 4))))];
    _weekDocCache = {};
    const complianceRows = [];
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
      const unsettled = new Set();   // 有門市還沒發布薪資的月份（數字可能再變）
      let loaded = 0;
      for(const ym of ymList){
        salaryMap[ym] = {};
        for(const store of stores){
          try{
            const snap = await window.db.collection('stores').doc(store).collection('salary').doc(ym).get();
            if(!snap.exists || (snap.data().status||'draft')!=='published') unsettled.add(ym);
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
    return { ymList, stores, allEmps, salaryMap, supportMap, complianceRows: complianceUniq, weeklyRows, weeklyTrend, monthlyHoursMap, unsettled: [...unsettled].sort() };
  }

  // ===================================================================
  // 以下為新畫面（2026-10-10）
  // ===================================================================
  const SUBS = [['cost', '💰 錢花在哪'], ['watch', '⚠️ 要注意的人'], ['support', '🔁 跨店支援'], ['emps', '👥 員工']];
  const ST = { data: null, key: '', loading: null, sub: 'cost', charts: [], range: null, open: {}, empSort: 'cost', empQ: '', empAll: false };
  try { const s = localStorage.getItem('hrSub'); if (s && SUBS.some(x => x[0] === s)) ST.sub = s; } catch (e) {}
  const COL = { '美德': '#1a73e8', '聯鑫': '#e67e22', '錦花': '#34a853' };
  const ymAdd = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const ymLabel = ym => `${+ym.slice(5)}月`;
  const nowYm = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  function defaultRange() { const end = ymAdd(nowYm(), -1); return { start: ymAdd(end, -2), end }; }   // 本月薪資還沒結算 → 預設到上個月
  function ymList(r) { const out = []; let x = r.start; while (x <= r.end && out.length < 12) { out.push(x); x = ymAdd(x, 1); } return out; }
  function scopeStores() { const sc = window.OwnerScope ? OwnerScope.get() : ''; const all = (appConfig.stores || []).filter(s => s !== '人力支援'); return sc && all.includes(sc) ? [sc] : all; }
  function destroyCharts() { ST.charts.forEach(c => { try { c.destroy(); } catch (e) {} }); ST.charts = []; }

  async function ensureLoaded() {
    const r = ST.range || (ST.range = defaultRange());
    const key = r.start + '|' + r.end;
    if (ST.data && ST.key === key) return;
    if (ST.loading && ST.key === key) return ST.loading;
    ST.key = key; ST.data = null;
    const prog = (p, t) => { const el = document.getElementById('hrProg'); if (el) el.textContent = `${t}（${p}%）`; };
    ST.loading = hrLoad(ymList(r), appConfig.stores || [], prog).then(d => { if (ST.key === key) ST.data = d; ST.loading = null; render(); })
      .catch(e => { ST.loading = null; const el = document.getElementById('hrRoot'); if (el) el.innerHTML = rangeBar() + `<div class="empty">讀取失敗：${escH(e.message)}</div>`; });
    return ST.loading;
  }

  function rangeBar() {
    const r = ST.range || defaultRange(), opts = [];
    for (let i = 0; i < 18; i++) opts.push(ymAdd(nowYm(), -i));
    const sel = (id, v) => `<select id="${id}" class="hr-sel">${opts.map(o => `<option value="${o}"${o === v ? ' selected' : ''}>${o.slice(0, 4)}年${+o.slice(5)}月</option>`).join('')}</select>`;
    return `<div class="hr-range">區間 ${sel('hrStart', r.start)} ～ ${sel('hrEnd', r.end)} <button class="mini-btn" onclick="HR.applyRange()">套用</button><span id="hrRangeErr" class="hr-err"></span></div>`;
  }
  function applyRange() {
    const s = document.getElementById('hrStart').value, e = document.getElementById('hrEnd').value, err = document.getElementById('hrRangeErr');
    if (s > e) { err.textContent = '起始月份不能晚於結束月份'; return; }
    if (ymList({ start: s, end: '9999-12' }).indexOf(e) < 0 && ymList({ start: s, end: e }).length >= 12) { err.textContent = '區間最長 12 個月'; return; }
    ST.range = { start: s, end: e }; render();
  }

  function render() {
    const el = document.getElementById('hrRoot'); if (!el) return;
    destroyCharts();
    const r = ST.range || (ST.range = defaultRange());
    if (!ST.data || ST.key !== r.start + '|' + r.end) {
      el.innerHTML = rangeBar() + `<div class="card"><div class="empty">讀取人事資料中…<div id="hrProg" style="margin-top:6px;font-size:12px;"></div><div style="font-size:11.5px;margin-top:6px;">要讀幾個月的薪資與班表，第一次約需數秒；切回總覽再回來不用再等</div></div></div>`;
      ensureLoaded(); return;
    }
    const D = ST.data, fs = scopeStores();
    const un = D.unsettled.length ? `<div class="hr-warn">⚠️ ${D.unsettled.map(ymLabel).join('、')}薪資還沒全部發布，數字可能再變</div>` : '';
    const watchN = buildWatch(D, fs).length;
    const tabs = `<div class="hr-tabs" role="tablist">${SUBS.map(([k, t]) => `<button role="tab" aria-selected="${ST.sub === k}" class="${ST.sub === k ? 'on' : ''}" onclick="HR.setSub('${k}')">${t}${k === 'watch' && watchN ? `<span class="hr-dot">${watchN}</span>` : ''}</button>`).join('')}</div>`;
    let body = '';
    if (ST.sub === 'cost') body = renderCost(D, fs);
    else if (ST.sub === 'watch') body = renderWatch(D, fs);
    else if (ST.sub === 'support') body = renderSupport(D, fs);
    else body = renderEmps(D, fs);
    el.innerHTML = rangeBar() + un + tabs + body;
    drawPending();
  }
  function setSub(k) { ST.sub = k; try { localStorage.setItem('hrSub', k); } catch (e) {} render(); }

  // ---- Chart 排隊（innerHTML 設好之後才畫）----
  let pending = [];
  function chartBox(id, cfg, h) { pending.push({ id, cfg }); return `<div style="position:relative;height:${h || 200}px;"><canvas id="${id}"></canvas></div>`; }
  function drawPending() { const list = pending; pending = []; if (!window.Chart) return; list.forEach(({ id, cfg }) => { const c = document.getElementById(id); if (c) ST.charts.push(new Chart(c, cfg)); }); }
  const cOpts = (fmt, extra) => Object.assign({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: c => `${c.dataset.label}：${fmt(c.parsed.y)}` } } },
    scales: { y: { ticks: { callback: v => fmt(v), font: { size: 10 } }, grid: { color: '#f1f5f9' } }, x: { ticks: { font: { size: 10 } }, grid: { display: false } } } }, extra || {});
  function foldBox(id, title, sum, body) {
    return `<details class="fold" ${ST.open[id] ? 'open' : ''} ontoggle="HR.fold('${id}',this.open)"><summary><span class="fold-t">${title}</span><span class="fold-s">${sum || ''}</span></summary><div class="fold-b">${body}</div></details>`;
  }
  const exportBtn = kind => `<button class="mini-btn hr-xls" onclick="HR.exportXls('${kind}')">⬇️ 匯出 Excel</button>`;

  // ---- 成本（邏輯同原 renderCostTab：薪資與公司負擔以 salary 記錄為準、支援調整依 fromStore 與發薪歸屬）----
  function computeCost(D, fs) {
    const { ymList, allEmps, salaryMap, supportMap } = D;
    const rows = [], flows = [];
    const inM = {}, outM = {};
    fs.forEach(s => { inM[s] = {}; outM[s] = {}; });
    ymList.forEach(ym => {
      Object.entries(supportMap[ym] || {}).forEach(([empName, supports]) => {
        supports.forEach(s => {
          const empRec = (salaryMap[ym]?.[empName]?._store === s.fromStore) ? salaryMap[ym][empName] : null;
          const empData = allEmps.find(e => e.name === empName && e.store === s.fromStore) || allEmps.find(e => e.name === empName);
          if (!empRec && !empData) return;
          const role = empRec?.role || empData?.role || '';
          const isPart = role === '工讀';
          const base = n(empRec?.baseSalary || 0) || n(empData?.baseSalary || 0);
          const attend = n(empRec?.fullAttendBonus || 0) || n(empData?.fullAttendBonus || 0);
          const wage = n(empRec?.wage || 0) || n(empData?.wage || 0);
          const hrRate = isPart ? wage : (base + attend) / 30 / 8;
          const amt = Math.round(hrRate * s.hours);
          const activeAtFrom = isPaidByStoreInMonth(empName, s.fromStore, ym, allEmps);
          const activeAtTo = isPaidByStoreInMonth(empName, s.toStore, ym, allEmps);
          if (activeAtFrom && fs.includes(s.fromStore)) outM[s.fromStore][ym] = (outM[s.fromStore][ym] || 0) + amt;
          if (!activeAtTo && fs.includes(s.toStore)) inM[s.toStore][ym] = (inM[s.toStore][ym] || 0) + amt;
          if (fs.includes(s.fromStore) || fs.includes(s.toStore)) flows.push({ ym, empName, from: s.fromStore, to: s.toStore, hours: s.hours, hrRate: Math.round(hrRate * 100) / 100, amt, counted: activeAtFrom || !activeAtTo });
        });
      });
    });
    fs.forEach(store => {
      ymList.forEach(ym => {
        let gross = 0, er = 0, ot = 0, hol = 0; const names = new Set();
        Object.values(salaryMap[ym] || {}).filter(r => r._store === store).forEach(rec => {
          const role = effR(null, rec);
          gross += calcGross(rec, role); er += calcErBurden(rec, role);
          ot += calcOtPay(rec); hol += role === '工讀' ? Math.round(n(rec.wage) * n(rec.holidayHours)) : n(rec.holidayOtPay);
          names.add(rec.empName || '');
        });
        allEmps.filter(e => e.store === store && isEmpActiveInMonth(e, ym) && !names.has(e.name)).forEach(emp => {
          er += calcErBurden({ baseSalary: emp.baseSalary || 0, fullAttendBonus: emp.fullAttendBonus || 0, wage: emp.wage || 0, laborEr: 0, healthEr: 0, pensionEr: 0 }, emp.role || '');
        });
        const sIn = inM[store][ym] || 0, sOut = outM[store][ym] || 0, actual = gross + sIn - sOut;
        rows.push({ store, ym, gross, er, ot, hol, sIn, sOut, actual, total: actual + er });
      });
    });
    return { rows, flows };
  }
  function renderCost(D, fs) {
    const { rows } = computeCost(D, fs), yl = D.ymList;
    const byYm = ym => rows.filter(r => r.ym === ym).reduce((a, r) => ({ gross: a.gross + r.gross, er: a.er + r.er, ot: a.ot + r.ot, hol: a.hol + r.hol, total: a.total + r.total, sIn: a.sIn + r.sIn, sOut: a.sOut + r.sOut }), { gross: 0, er: 0, ot: 0, hol: 0, total: 0, sIn: 0, sOut: 0 });
    const tot = rows.reduce((a, r) => a + r.total, 0), otHol = rows.reduce((a, r) => a + r.ot + r.hol, 0), grossAll = rows.reduce((a, r) => a + r.gross, 0);
    const last = byYm(yl[yl.length - 1]), prev = yl.length > 1 ? byYm(yl[yl.length - 2]) : null;
    const chg = prev && prev.total ? Math.round((last.total - prev.total) / prev.total * 1000) / 10 : null;
    const kpi = `<div class="kpi-grid" style="margin-bottom:10px;">
      <div class="kpi"><div class="kpi-label">人事成本（含公司負擔）</div><div class="kpi-val">${wan(tot)}</div><div class="kpi-yoy ${chg == null ? 'flat' : chg > 0 ? 'down' : 'up'}">${chg == null ? `共 ${yl.length} 個月` : `${ymLabel(yl[yl.length - 1])}比上月 ${chg > 0 ? '+' : ''}${chg}%`}</div></div>
      <div class="kpi"><div class="kpi-label">加班費＋國定假日</div><div class="kpi-val">${wan(otHol)}</div><div class="kpi-yoy flat">占應發薪資 ${grossAll ? (otHol / grossAll * 100).toFixed(1) : 0}%</div></div></div>`;
    const W = v => Math.round(v / 1000) / 10;
    const chart = chartBox('hrStack', { type: 'bar', data: { labels: yl.map(ymLabel), datasets: [
      { label: '薪資', data: yl.map(ym => { const b = byYm(ym); return W(b.gross - b.ot - b.hol); }), backgroundColor: '#1a73e8', stack: 's', borderRadius: 3 },
      { label: '加班＋國假', data: yl.map(ym => { const b = byYm(ym); return W(b.ot + b.hol); }), backgroundColor: '#e67e22', stack: 's', borderRadius: 3 },
      { label: '公司負擔', data: yl.map(ym => W(byYm(ym).er)), backgroundColor: '#34a853', stack: 's', borderRadius: 3 } ] },
      options: cOpts(v => v + ' 萬', { scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } }, y: { stacked: true, ticks: { callback: v => v + '萬', font: { size: 10 } }, grid: { color: '#f1f5f9' } } } }) }, 210);
    const tbl = `<div class="scroll"><table class="tbl"><thead><tr><th>門市</th><th>月份</th><th>應發薪資</th><th>公司負擔</th><th>被支援</th><th>支援別人</th><th>含負擔合計</th></tr></thead><tbody>${
      rows.map(r => `<tr><td>${r.store}</td><td>${ymLabel(r.ym)}</td><td>$${comma(r.gross)}</td><td>$${comma(r.er)}</td><td>${r.sIn ? '<span style="color:#c5221f">+$' + comma(r.sIn) + '</span>' : '—'}</td><td>${r.sOut ? '<span style="color:#137333">−$' + comma(r.sOut) + '</span>' : '—'}</td><td><b>$${comma(r.total)}</b></td></tr>`).join('')}</tbody></table></div>
      <div style="font-size:11px;color:var(--muted);margin-top:6px;">含負擔合計＝應發薪資＋被支援－支援別人＋公司負擔（勞健保、勞退）。</div>`;
    const wks = Object.values(D.weeklyTrend || {}).filter(w => w.sortKey <= Date.now()).sort((a, b) => a.sortKey - b.sortKey);
    const wtbl = wks.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>週</th>${fs.map(s => `<th>${s}</th>`).join('')}</tr></thead><tbody>${wks.map(w => `<tr><td>${w.label}${Date.now() - w.sortKey < 7 * 86400000 ? ' <span style="font-size:10.5px;color:var(--muted);">進行中</span>' : ''}</td>${fs.map(s => `<td>${w.byStore[s] != null ? w.byStore[s] : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">實體工時（h）＝自有＋受支援－外派</div>` : '<div class="empty">無資料</div>';
    return kpi + `<div class="chart-card"><div class="chart-t">每月成本組成</div><div class="chart-s">單位萬元・未含跨店支援調整（見「跨店支援」）</div>${chart}</div>`
      + foldBox('costTbl', '📋 門市 × 月份明細', `${rows.length} 列`, tbl + exportBtn('cost'))
      + foldBox('weekly', '📅 各店每週工時', `${wks.length} 週`, wtbl);
  }

  // ---- 要注意的人：原「加班與異常」＋「每週工時」把關＋「合規稽核」，改成一人一列 ----
  function buildWatch(D, fs) {
    const { ymList, allEmps, salaryMap } = D, P = {};
    const add = (emp, store, key, sev, val, line) => {
      const p = P[emp] || (P[emp] = { emp, store, tags: {}, lines: [], score: 0 });
      const t = p.tags[key] || (p.tags[key] = { key, sev: 0, n: 0, val: null });
      t.n++; t.sev = Math.max(t.sev, sev); if (val != null && (t.val == null || Math.abs(val) > Math.abs(t.val))) t.val = val;
      p.lines.push({ sev, line }); p.score += sev === 3 ? 100 : sev === 2 ? 10 : 1;
    };
    // 1. 加班分級（§32 每月 46h 為紅線，黃＝紅－6、嚴重＝紅＋8；同原本設定）
    ymList.forEach(ym => Object.values(salaryMap[ym] || {}).forEach(rec => {
      if (!fs.includes(rec._store)) return;
      const h = n(rec.otHours); if (h < 40) return;
      add(rec.empName, rec._store, 'ot', h >= 54 ? 3 : h >= 46 ? 2 : 1, h, `${ymLabel(ym)}加班 ${h}h${h >= 54 ? '（嚴重）' : h >= 46 ? '（超過 46h）' : '（接近 46h）'}・加班費 $${comma(calcOtPay(rec))}`);
    }));
    // 2. 單週工時（黃 ≥48h／紅 ≥60h）、連上 7 天（§36）——只看已開始的週
    (D.weeklyRows || []).forEach(r => {
      if (!fs.includes(r.store) || weekStringToDate(r.wk).getTime() > Date.now()) return;
      if (r.days >= 7) add(r.empName, r.store, 'd7', 2, null, `${r.weekLabel} 連上 7 天（${r.hours}h）`);
      if (r.hours >= 48) add(r.empName, r.store, 'wk', r.hours >= 60 ? 2 : 1, r.hours, `${r.weekLabel} 單週 ${r.hours}h`);
    });
    // 3. 薪資比上月波動 ≥20%（同原本）
    allEmps.filter(e => fs.includes(e.store)).forEach(emp => ymList.forEach((ym, i) => {
      if (!i || !isEmpActiveInMonth(emp, ym)) return;
      const rec = salaryMap[ym]?.[emp.name], pr = salaryMap[ymList[i - 1]]?.[emp.name];
      if (!rec || !pr) return;
      const cur = calcGross(rec, emp.role), prev = calcGross(pr, emp.role);
      if (prev <= 0) return;
      const pct = Math.round((cur - prev) / prev * 100);
      if (Math.abs(pct) >= 20) add(emp.name, emp.store, 'wave', 1, pct, `${ymLabel(ym)}應發 $${comma(cur)}，比上月 $${comma(prev)} ${pct > 0 ? '+' : ''}${pct}%`);
    }));
    // 4. 排班知情放行（勞基法軟擋）
    (D.complianceRows || []).forEach(r => { if (fs.includes(r.store)) add(r.empName, r.store, 'law', 0, null, `${r.date.slice(5).replace('-', '/')} 知情放行：${COMPLIANCE_LABEL[r.rule] || r.rule}${r.reason ? '・' + r.reason : ''}${r.approvedBy ? '（' + r.approvedBy + '）' : ''}`); });
    return Object.values(P).sort((a, b) => b.score - a.score);
  }
  const COMPLIANCE_LABEL = { rest11h: '輪班間隔<11h', daily12h: '當日工時>12h', continuous12h: '連續工時>12h', weekly1off: '七休一' };
  const TAGTXT = { ot: t => `加班 ${t.val}h${t.n > 1 ? ' ×' + t.n : ''}`, wk: t => `單週 ${t.val}h${t.n > 1 ? ' ×' + t.n : ''}`, d7: t => `連上 7 天${t.n > 1 ? ' ×' + t.n : ''}`, wave: t => `薪資 ${t.val > 0 ? '+' : ''}${t.val}%`, law: t => `知情放行 ×${t.n}` };
  const SEVCLS = ['hr-tag-i', 'hr-tag-y', 'hr-tag-r', 'hr-tag-r'];
  function renderWatch(D, fs) {
    const list = buildWatch(D, fs);
    if (!list.length) return '<div class="card"><div class="empty">✅ 這段期間沒有需要注意的人</div></div>';
    const rows = list.map(p => {
      const tags = ['ot', 'wk', 'd7', 'wave', 'law'].filter(k => p.tags[k]).map(k => `<span class="hr-tag ${SEVCLS[p.tags[k].sev]}">${TAGTXT[k](p.tags[k])}</span>`).join('');
      const open = ST.open['w:' + p.emp];
      return `<div class="hr-person" onclick="HR.toggle('w:${escH(p.emp).replace(/'/g, '&#39;')}')"><div class="hr-p-top"><b>${escH(dispName(p.emp))}</b><span class="hr-p-st">${escH(p.store)}</span><span class="hr-p-arr">${open ? '▾' : '›'}</span></div><div class="hr-tags">${tags}</div>
        ${open ? `<div class="hr-lines">${p.lines.sort((a, b) => b.sev - a.sev).map(l => `<div>${escH(l.line)}</div>`).join('')}</div>` : ''}</div>`;
    }).join('');
    return `<div class="card"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span style="font-size:13px;font-weight:900;">${list.length} 人</span><span style="font-size:11.5px;color:var(--muted);">點人看是哪幾週、哪幾天</span>${exportBtn('watch')}</div>${rows}
      <div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.7;">標籤：加班 ≥40h 黃、≥46h 紅（§32）、≥54h 嚴重；單週 ≥48h 黃、≥60h 紅；連上 7 天（§36）；應發薪資比上月波動 ≥20%；排班時知情放行的勞基法軟擋。</div></div>`;
  }

  // ---- 跨店支援 ----
  function renderSupport(D, fs) {
    const { rows, flows } = computeCost(D, fs);
    if (!flows.length) return '<div class="card"><div class="empty">這段期間沒有跨店支援</div></div>';
    const agg = {};
    flows.forEach(f => { const k = f.from + '→' + f.to; const a = agg[k] || (agg[k] = { from: f.from, to: f.to, hours: 0, amt: 0, n: 0 }); a.hours += f.hours; a.amt += f.amt; a.n++; });
    const fl = Object.values(agg).sort((a, b) => b.amt - a.amt);
    const mx = Math.max(1, ...fl.map(f => f.amt));
    const flowHtml = fl.map(f => `<div class="hbar"><span class="nm" style="min-width:96px;">${f.from} → ${f.to}</span><span class="trk"><i class="fil" style="left:0;width:${Math.max(3, f.amt / mx * 100)}%;background:${COL[f.from] || '#64748b'};"></i></span><span class="v" style="min-width:110px;">${Math.round(f.hours * 10) / 10}h・$${comma(f.amt)}</span></div>`).join('');
    const net = fs.map(s => { const r = rows.filter(x => x.store === s); const i = r.reduce((a, x) => a + x.sIn, 0), o = r.reduce((a, x) => a + x.sOut, 0); return { s, i, o, net: i - o }; });
    const netHtml = net.map(x => `<div class="todo-line"><span>${x.s}<span style="font-size:11.5px;color:var(--muted);font-weight:600;margin-left:6px;">被支援 $${comma(x.i)}・支援別人 $${comma(x.o)}</span></span><span class="todo-cnt ${x.net > 0 ? 'sev-red' : x.net < 0 ? 'sev-ok' : ''}">${x.net > 0 ? '多付 +$' + comma(x.net) : x.net < 0 ? '少付 −$' + comma(-x.net) : '持平'}</span></div>`).join('');
    const det = `<div class="scroll"><table class="tbl"><thead><tr><th>月份</th><th>支援者</th><th>從</th><th>到</th><th>時數</th><th>時薪</th><th>費用</th></tr></thead><tbody>${flows.sort((a, b) => a.ym.localeCompare(b.ym) || b.amt - a.amt).map(f => `<tr><td>${ymLabel(f.ym)}</td><td>${escH(dispName(f.empName))}</td><td>${f.from}</td><td>${f.to}</td><td>${f.hours}h</td><td>$${Math.round(f.hrRate)}</td><td>$${comma(f.amt)}</td></tr>`).join('')}</tbody></table></div>
      <div style="font-size:11px;color:var(--muted);margin-top:6px;">時薪：正職（底薪＋全勤）÷30÷8、工讀時薪；同薪資頁的跨店支援費率規則。</div>`;
    return `<div class="chart-card"><div class="chart-t">支援流向</div><div class="chart-s">誰去誰那裡・時數與費用</div>${flowHtml}</div>
      <div class="card"><div class="chart-t" style="margin-bottom:4px;">各店淨額</div><div class="chart-s">被支援要付給對方的錢，扣掉自己人去支援收回的錢</div>${netHtml}</div>`
      + foldBox('supDet', '📋 逐筆明細', `${flows.length} 筆`, det + exportBtn('support'));
  }

  // ---- 員工：原「員工時薪」＋「加班明細」合成一人一張卡 ----
  function buildEmps(D, fs) {
    const { ymList, allEmps, salaryMap, supportMap } = D, E = {};
    ymList.forEach(ym => Object.values(salaryMap[ym] || {}).forEach(rec => {
      if (!fs.includes(rec._store)) return;
      const nm = rec.empName, e = E[nm] || (E[nm] = { nm, store: rec._store, role: '', months: 0, cost: 0, otH: 0, otPay: 0, holH: 0, holPay: 0, supH: 0, supCost: 0, hrRate: 0, part: false, lastYm: '' });
      const emp = allEmps.find(x => x.name === nm);
      const role = effR(emp, rec), part = recIsPart(emp, rec);
      e.months++; e.cost += calcRealCost(rec, role);
      e.otH += n(rec.otHours); e.otPay += calcOtPay(rec);
      e.holH += n(rec.holidayHours); e.holPay += role === '工讀' ? Math.round(n(rec.wage) * n(rec.holidayHours)) : n(rec.holidayOtPay);
      if (ym >= e.lastYm) { e.lastYm = ym; e.store = rec._store; e.role = (emp && emp.role) || rec.role || ''; e.part = part; e.hrRate = part ? n(rec.wage) : (n(rec.baseSalary) + n(rec.fullAttendBonus)) / 30 / 8; }
      (supportMap[ym]?.[nm] || []).forEach(s => { e.supH += s.hours; e.supCost += Math.round((part ? n(rec.wage) : (n(rec.baseSalary) + n(rec.fullAttendBonus)) / 30 / 8) * s.hours); });
    }));
    // 排班工時：每人每週明細（發薪歸屬店）加總區間內的週
    const r0 = ST.range.start + '-01';
    (D.weeklyRows || []).forEach(w => { const e = E[w.empName]; if (e && weekStringToDate(w.wk) >= new Date(r0)) e.hours = (e.hours || 0) + w.hours; });
    return Object.values(E);
  }
  function renderEmps(D, fs) {
    let list = buildEmps(D, fs);
    const q = ST.empQ.trim().toLowerCase();
    if (q) list = list.filter(e => (dispName(e.nm) + e.nm).toLowerCase().includes(q));
    const by = { cost: (a, b) => b.cost - a.cost, ot: (a, b) => b.otH - a.otH || b.otPay - a.otPay, name: (a, b) => dispName(a.nm).localeCompare(dispName(b.nm), 'zh-Hant') }[ST.empSort];
    list.sort(by);
    const shown = ST.empAll ? list : list.slice(0, 15);
    const cards = shown.map(e => `<div class="hr-emp"><div class="hr-p-top"><b>${escH(dispName(e.nm))}</b><span class="hr-p-st">${escH(e.store)}・${escH(e.role || '')}${e.part && e.role !== '工讀' ? '（工讀計）' : ''}</span><span class="hr-emp-cost">${wan(e.cost)}</span></div>
      <div class="hr-emp-meta">時薪 $${Math.round(e.hrRate)}${e.hours ? `・排班 ${Math.round(e.hours)}h` : ''}${e.otH ? `・<b>加班 ${Math.round(e.otH * 10) / 10}h $${comma(e.otPay)}</b>` : ''}${e.holH ? `・國假 ${e.holH}h $${comma(e.holPay)}` : ''}${e.supH ? `・支援 ${Math.round(e.supH * 10) / 10}h $${comma(e.supCost)}` : ''}${e.months < ST.data.ymList.length ? `・${e.months} 個月有薪資` : ''}</div></div>`).join('');
    return `<div class="card"><div class="hr-emp-bar"><input id="hrEmpQ" type="search" placeholder="🔍 搜尋姓名" value="${escH(ST.empQ)}" oninput="HR.empSearch(this.value)">
      <select class="hr-sel" onchange="HR.empSortBy(this.value)">${[['cost', '依成本'], ['ot', '依加班'], ['name', '依姓名']].map(([k, t]) => `<option value="${k}"${ST.empSort === k ? ' selected' : ''}>${t}</option>`).join('')}</select>${exportBtn('emps')}</div>
      ${cards || '<div class="empty">找不到</div>'}
      ${!ST.empAll && list.length > 15 ? `<button class="sc-more" onclick="HR.empMore()">看全部 ${list.length} 人</button>` : ''}
      <div style="font-size:11px;color:var(--muted);margin-top:8px;">成本＝區間內應發薪資＋公司負擔（不含跨店支援調整）；時薪取區間最後一個月：正職（底薪＋全勤）÷30÷8、工讀時薪。</div></div>`;
  }

  // ---- Excel（各小分頁各自匯出；SheetJS 用到時才載入）----
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('載入 Excel 元件失敗')); document.head.appendChild(s); });
  }
  async function exportXls(kind) {
    try { await loadXlsx(); } catch (e) { alert(e.message); return; }
    const D = ST.data, fs = scopeStores(); let aoa = [], name = '';
    if (kind === 'cost') { name = '人事成本'; aoa = [['門市', '月份', '應發薪資', '公司負擔', '被支援', '支援別人', '含負擔合計', '加班費', '國假費用']].concat(computeCost(D, fs).rows.map(r => [r.store, r.ym, Math.round(r.gross), Math.round(r.er), r.sIn, r.sOut, Math.round(r.total), r.ot, r.hol])); }
    else if (kind === 'watch') { name = '要注意的人'; aoa = [['姓名', '門市', '說明']]; buildWatch(D, fs).forEach(p => p.lines.forEach(l => aoa.push([dispName(p.emp), p.store, l.line]))); }
    else if (kind === 'support') { name = '跨店支援'; aoa = [['月份', '支援者', '從', '到', '時數', '時薪', '費用']].concat(computeCost(D, fs).flows.map(f => [f.ym, dispName(f.empName), f.from, f.to, f.hours, Math.round(f.hrRate), f.amt])); }
    else { name = '員工'; aoa = [['姓名', '門市', '職位', '時薪', '排班工時', '加班時數', '加班費', '國假時數', '國假費用', '支援時數', '支援費用', '成本']].concat(buildEmps(D, fs).map(e => [dispName(e.nm), e.store, e.role, Math.round(e.hrRate), Math.round(e.hours || 0), e.otH, e.otPay, e.holH, e.holPay, e.supH, e.supCost, Math.round(e.cost)])); }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    XLSX.writeFile(wb, `${name}_${ST.range.start}～${ST.range.end}${fs.length === 1 ? '_' + fs[0] : ''}.xlsx`);
  }

  window.HR = {
    render, applyRange, setSub, exportXls,
    fold: (id, open) => { ST.open[id] = open; },
    toggle: id => { ST.open[id] = !ST.open[id]; render(); },
    empSearch: v => { ST.empQ = v; const el = document.getElementById('hrEmpQ'); const pos = el ? el.selectionStart : null; render(); const e2 = document.getElementById('hrEmpQ'); if (e2) { e2.focus(); if (pos != null) e2.setSelectionRange(pos, pos); } },
    empSortBy: v => { ST.empSort = v; render(); },
    empMore: () => { ST.empAll = true; render(); },
    // 給月結進度用：某月各店「考勤／薪資／代扣」沒勾完的人數（原「未完成確認」）
  };

})();
