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

  // ===== 2026-10-16 整理第 3 階段：以下從 salary-page.js 搬來（薪資頁版本為準），my-salary 共用 =====
  // ctx = { scheduleData, currentMonth, holidays }（holidays＝頁面的國定假日表，已跟系統設定同步）
  const WEEKDAY = DAY;

  // 計薪職稱：payAsPartTime（例：店長職稱但領時薪）一律以工讀計
  function effSalaryRole(emp, rec){
    const flag = (emp && emp.payAsPartTime) || (rec && rec.payAsPartTime);
    return flag ? ROLE_PART : ((emp && emp.role) || (rec && rec.role) || '');
  }

  // 某月的國定假日
  function monthHolidays(ym, holidays){
    return Object.entries(holidays || {})
      .filter(([k]) => k.startsWith(ym))
      .map(([k, v]) => ({ date: k, name: v, day: parseInt(k.split('-')[2]) }));
  }

  // ISO 週次（週一為一週開始）
  function week1MondayOf(yr){
    const d = new Date(yr, 0, 1), day = d.getDay();
    d.setDate(d.getDate() + (day <= 4 ? 1 - day : 8 - day));
    return d;
  }
  function weekStrOfDate(dt){
    const mon = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); // 去掉時間，避免小數天數進位
    mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));               // 退到該日所屬的週一
    let yr = mon.getFullYear();
    if(mon < week1MondayOf(yr)) yr--; else if(mon >= week1MondayOf(yr + 1)) yr++;  // 跨年首尾週
    const w = Math.round((mon - week1MondayOf(yr)) / 604800000) + 1;
    return `${yr}-W${String(w).padStart(2,'0')}`;
  }
  // 某月份涵蓋的所有週次（逐日掃描，確保不漏週）
  function monthWeeks(ym){
    const [y, m] = ym.split('-').map(Number);
    const weeks = new Set();
    const daysInMonth = new Date(y, m, 0).getDate();
    for(let day = 1; day <= daysInMonth; day++) weeks.add(weekStrOfDate(new Date(y, m-1, day)));
    return [...weeks];
  }

  // 排班列的實際日期 → [月, 日]；對不到回 null
  function recMonthDay(ws, r){
    const wDates = getWeekDatesFromStr(ws);
    const dIdx = WEEKDAY.indexOf(r.day);
    if(dIdx < 0) return null;
    const dateStr = wDates[dIdx];
    if(!dateStr) return null;
    return dateStr.split('/').map(Number);
  }
  const isWorkShift = r => r.shift && r.shift !== '排休' && r.shift !== '指休' && r.shift !== '特休' && r.shift !== '補休';

  // 本月已休（例休：排休／指休；時薪另計視為休假）。只看本人名字的列（支援別店的班不算本店的休）
  function calcMonthOffDays(empName, ym, ctx){
    const cm = Number(ym.split('-')[1]);
    let offDays = 0;
    Object.entries(ctx.scheduleData).forEach(([ws, recs]) => {
      recs.forEach(r => {
        if(r.name !== empName) return;
        const isRegOff = r.shift === '排休' || r.shift === '指休';
        const isHourlyOff = r.isHourly === true; // 時薪另計視為休假
        if(!isRegOff && !isHourlyOff) return;
        const md = recMonthDay(ws, r);
        if(md && md[0] === cm) offDays++;
      });
    });
    return offDays;
  }

  // 國定假日有上班的日子：本人或跨店支援（recBelongsTo）；排休／指休／特休／補休不算上班
  // ⚠️ 原本 my-salary 那份只看本人名字、而且把特休／補休當上班（員工端會看到「國定假日上班」其實是請特休），2026-10-16 統一成這份
  function detectHolidayWork(empName, ym, ctx){
    const worked = [];
    monthHolidays(ym, ctx.holidays).forEach(h => {
      const hm = Number(h.date.slice(5, 7)), hd = Number(h.date.slice(8, 10));
      let hasWork = false;
      Object.entries(ctx.scheduleData).forEach(([ws, recs]) => {
        recs.forEach(r => {
          if(!recBelongsTo(r, empName)) return;
          const md = recMonthDay(ws, r);
          if(md && md[0] === hm && md[1] === hd && isWorkShift(r)) hasWork = true;
        });
      });
      if(hasWork) worked.push(h);
    });
    return worked;
  }

  // 工讀國定假日出勤時數（同一天只算一次）
  function calcEmpHolidayHours(empName, ctx){
    let autoH = 0;
    const counted = new Set(); // 已經算過的日期，避免重複加總
    monthHolidays(ctx.currentMonth, ctx.holidays).forEach(h => {
      const hm = Number(h.date.slice(5, 7)), hd = Number(h.date.slice(8, 10));
      Object.entries(ctx.scheduleData).forEach(([ws, weekRecs]) => {
        (weekRecs || []).forEach(r => {
          if(!recBelongsTo(r, empName)) return;
          const md = recMonthDay(ws, r);
          if(md && md[0] === hm && md[1] === hd && isWorkShift(r)) {
            const dayKey = `${md[0]}/${md[1]}`;
            if(counted.has(dayKey)) return;
            counted.add(dayKey);
            autoH += parseFloat(r.actualHours || 0);
          }
        });
      });
    });
    return Math.round(autoH * 10) / 10;
  }

  return { ROLE_PART, getWeekDatesFromStr, recBelongsTo, hourlyRate, calcDeduct, calcEmpHours, calcHourlySupportHours, grossFromParts,
    effSalaryRole, monthHolidays, week1MondayOf, weekStrOfDate, monthWeeks, calcMonthOffDays, detectHolidayWork, calcEmpHolidayHours };
})();
