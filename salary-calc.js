// ===== 薪資計算共用模組（單一真相）=====
// 供 salary.html / my-salary.html / analytics.html 共用，以 salary.html 現行版為唯一基準。
// 未來調整薪資公式只改這裡，三檔自動一致，根絕「三檔各抄一份」的飄移。
// schedule 相依的函式吃 ctx = { scheduleData, currentMonth }。
window.SalaryCalc = (function(){
  const ROLE_PART = '工讀';
  const DAY = ['週一','週二','週三','週四','週五','週六','週日'];
  const n = v => parseFloat(v || 0);

  function getWeekDatesFromStr(weekStr){
    const [yr, wk] = weekStr.split('-W').map(Number);
    const d = new Date(yr, 0, 1);
    const day = d.getDay();
    d.setDate(d.getDate() + (wk-1)*7);
    const offset = day <= 4 ? 1-day : 8-day;
    d.setDate(d.getDate() + offset);
    const res = [];
    for(let i=0;i<7;i++){ res.push(`${d.getMonth()+1}/${d.getDate()}`); d.setDate(d.getDate()+1); }
    return res;
  }

  // 一筆排班是否屬於某員工：本名出勤，或以支援身分（supportEmp='{homeStore}-{empName}'）出勤
  function recBelongsTo(r, empName){
    if(r.name === empName) return true;
    if(r.supportEmp){
      const i = r.supportEmp.indexOf('-');
      if(i >= 0 && r.supportEmp.substring(i+1) === empName) return true;
    }
    return false;
  }

  function hourlyRate(rec){
    return (n(rec.baseSalary) + n(rec.fullAttendBase) + n(rec.otherBase)) / 30 / 8;
  }

  function calcDeduct(rec){
    return n(rec.laborInsurance) + n(rec.healthInsurance) + n(rec.dependentInsurance) + n(rec.laborPension) + n(rec.otherDeduction);
  }

  // 本月正常工時（跳過休假/isHourly；跨店以 recBelongsTo 認人；按日去重）。ctx={scheduleData,currentMonth}
  function calcEmpHours(empName, ctx){
    let totalH = 0, otH = 0;
    const cm = parseInt((ctx.currentMonth||'').split('-')[1], 10);
    const counted = new Set();
    Object.entries(ctx.scheduleData || {}).forEach(([ws, weekRecs]) => {
      (weekRecs || []).forEach(r => {
        if(!recBelongsTo(r, empName)) return;
        const h = n(r.actualHours);
        if(r.shift === '排休' || r.shift === '指休' || r.shift === '特休' || r.shift === '補休' || !r.shift || r.isHourly) return;
        const wDates = getWeekDatesFromStr(ws);
        const dIdx = DAY.indexOf(r.day);
        if(dIdx < 0) return;
        const dateStr = wDates[dIdx];
        if(!dateStr) return;
        const [dm, dd] = dateStr.split('/').map(Number);
        if(dm !== cm) return;
        const dayKey = `${dm}/${dd}`;
        if(counted.has(dayKey)) return;
        counted.add(dayKey);
        totalH += h;
        if(r.isOT || h > 8) otH += Math.max(0, h - 8);
      });
    });
    return { totalH: Math.round(totalH*10)/10, otH: Math.round(otH*10)/10 };
  }

  // 本月時薪另計（isHourly=true）時數。ctx={scheduleData,currentMonth}
  function calcHourlySupportHours(empName, ctx){
    const cm = parseInt((ctx.currentMonth||'').split('-')[1], 10);
    let total = 0;
    const counted = new Set();
    Object.entries(ctx.scheduleData || {}).forEach(([ws, weekRecs]) => {
      (weekRecs || []).forEach(r => {
        if(!recBelongsTo(r, empName) || !r.isHourly) return;
        const wDates = getWeekDatesFromStr(ws);
        const dIdx = DAY.indexOf(r.day);
        if(dIdx < 0) return;
        const dateStr = wDates[dIdx];
        if(!dateStr) return;
        const [dm, dd] = dateStr.split('/').map(Number);
        if(dm !== cm) return;
        const key = `${dm}/${dd}`;
        if(counted.has(key)) return;
        counted.add(key);
        total += n(r.actualHours);
      });
    });
    return Math.round(total * 10) / 10;
  }

  // 純算術：給定 role / totalH / hourlySupportAmt / rph → 應發薪資（與 salary.html calcGross 逐字一致）
  function grossFromParts(rec, parts){
    const { role, totalH, hourlySupportAmt, rph } = parts || {};
    const isPart = role === ROLE_PART;
    if(isPart){
      const wage = n(rec.wage);
      const gross = Math.round(wage * (n(totalH) + n(rec.extraHours)) + wage * n(rec.holidayHours) * 1 + n(rec.roleBonus));
      return Math.max(0, gross - Math.abs(n(rec.personalSickLeave)));
    } else {
      const base = n(rec.baseSalary), attend = n(rec.fullAttendBonus);
      const mgmt = ['mgmtOps','mgmtQuality','mgmtKPI','mgmtAccount','mgmtLeader'].reduce((s,k)=>s+n(rec[k]),0);
      const laborAllow = n(rec.laborAllowance), perf = n(rec.performance), night = n(rec.nightAllowance);
      const roleBonus = n(rec.roleBonus), otherBonus = n(rec.otherBonus);
      const annualEncash = n(rec.annualLeaveEncash), compEncash = n(rec.compLeaveEncash);
      const hasCustomOt = rec.customOtEnabled === true;
      const otRate = hasCustomOt ? n(rec.customOtRate) : Math.ceil(n(rph));
      const otMult = hasCustomOt ? (rec.customOtX134 !== false ? 1.34 : 1) : 1.34;
      const wdOtAmt = Math.ceil(otRate * otMult * n(rec.otHours));
      const restOtAmt = n(rec.restDayOtPay), holOtAmt = n(rec.holidayOtPay);
      const additions = base + attend + mgmt + laborAllow + perf + night + roleBonus + otherBonus + annualEncash + compEncash + wdOtAmt + restOtAmt + holOtAmt + n(hourlySupportAmt);
      const lateDeduct = Math.round(n(rph)/60 * n(rec.lateMinutes));
      return Math.max(0, additions - lateDeduct - Math.abs(n(rec.personalSickLeave)));
    }
  }

  return { ROLE_PART, getWeekDatesFromStr, recBelongsTo, hourlyRate, calcDeduct, calcEmpHours, calcHourlySupportHours, grossFromParts };
})();
