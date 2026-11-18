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
    // insExtraDeduct：員工自願提高投保級距時，公司多付的差額（只有部分工時月薪的人會有，其他人是 0）
    return n(rec.laborInsurance) + n(rec.healthInsurance) + n(rec.dependentInsurance) + n(rec.laborPension) + n(rec.otherDeduction) + n(rec.insExtraDeduct);
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
    const { role, totalH, hourlySupportAmt, rph, ptmParts } = parts || {};
    if(rec.ptm && ptmParts) return ptmBreakdown(rec, ptmParts).gross; // 部分工時月薪：照合約另算（見下方 ptmBreakdown）
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

  // ===== 部分工時月薪（2026-11 新增）=====
  // 合約：每月約定 N 天（例 15 天）×8 小時，月薪固定；日薪＝月薪÷N，時薪＝日薪÷8。
  // 多上一天加一日薪、少一天扣一日薪（店家自己沒排滿的天數店長可標「不扣」）；
  // 特休、補休當天算出勤；病假、事假照合約跟沒上班一樣扣。
  // 一天超過 8 小時：第 9～10 小時 × 4/3，第 11～12 小時 × 5/3；國定假日出勤另加一日薪。
  // 主檔設定 emp.ptMonthly = { agreedDays: 15, monthly: [{ from: 'YYYY-MM', amount }] }；
  // 每月薪資紀錄存 rec.ptm = { monthly, agreedDays, waiveDays }，發布後不再跟主檔連動（歷史不可變）。

  // 某月適用的月薪：monthly 依生效月份排，取最後一筆 from <= ym
  function ptmMonthlyFor(cfg, ym){
    const list = ((cfg && cfg.monthly) || []).filter(x => x && x.from && x.from <= ym).sort((a, b) => a.from.localeCompare(b.from));
    return list.length ? n(list[list.length - 1].amount) : 0;
  }

  // 本月出勤明細（跨店支援也算；同一天只算一次；時薪另計的班不算）。ctx={scheduleData,currentMonth,holidays}
  function calcPtmParts(empName, ctx){
    const cm = Number((ctx.currentMonth || '').split('-')[1]);
    const dayH = new Map(), leave = new Set();
    Object.entries(ctx.scheduleData || {}).forEach(([ws, recs]) => {
      (recs || []).forEach(r => {
        const md = recMonthDay(ws, r);
        if(!md || md[0] !== cm) return;
        const key = `${md[0]}/${md[1]}`;
        if((r.shift === '特休' || r.shift === '補休') && r.name === empName) { leave.add(key); return; }
        if(!recBelongsTo(r, empName) || !isWorkShift(r) || r.isHourly) return;
        if(!dayH.has(key)) dayH.set(key, n(r.actualHours));
      });
    });
    let workH = 0, ot1 = 0, ot2 = 0;
    dayH.forEach(h => {
      workH += Math.min(h, 8);
      ot1 += Math.min(Math.max(h - 8, 0), 2);
      ot2 += Math.min(Math.max(h - 10, 0), 2);
    });
    leave.forEach(k => { if(dayH.has(k)) leave.delete(k); }); // 同一天又上班又請假，以上班算
    const holidayDays = detectHolidayWork(empName, ctx.currentMonth, ctx).length;
    const r1 = x => Math.round(x * 10) / 10;
    return { workDays: dayH.size, workH: r1(workH), leaveDays: leave.size, ot1: r1(ot1), ot2: r1(ot2), holidayDays };
  }

  // 依合約算出每一項（給薪資頁、薪資單、員工端顯示用；gross 就是這些加總）
  function ptmBreakdown(rec, parts){
    const p = parts || {};
    const cfg = rec.ptm || {};
    const monthly = n(cfg.monthly), agreed = n(cfg.agreedDays) || 15;
    const dayRate = monthly / agreed, hourRate = dayRate / 8;
    const creditH = n(p.workH) + n(p.leaveDays) * 8;            // 算出勤的時數
    const extraH = Math.max(0, creditH - agreed * 8);
    const shortH = Math.max(0, agreed * 8 - creditH);
    const waiveH = Math.min(shortH, n(cfg.waiveDays) * 8);       // 店家沒排、不扣
    const items = [
      { key: 'monthly', label: `月薪（約定 ${agreed} 天）`, amt: monthly },
      extraH > 0 && { key: 'extra', label: `多出勤 ${r1d(extraH / 8)} 天`, amt: Math.round(extraH * hourRate) },
      shortH - waiveH > 0 && { key: 'short', label: `少出勤 ${r1d((shortH - waiveH) / 8)} 天`, amt: -Math.round((shortH - waiveH) * hourRate) },
      n(p.ot1) > 0 && { key: 'ot1', label: `延長工時 ${p.ot1}h × 4/3`, amt: Math.round(n(p.ot1) * hourRate * 4 / 3) },
      n(p.ot2) > 0 && { key: 'ot2', label: `延長工時 ${p.ot2}h × 5/3`, amt: Math.round(n(p.ot2) * hourRate * 5 / 3) },
      n(p.holidayDays) > 0 && { key: 'holiday', label: `國定假日出勤 ${p.holidayDays} 天加給`, amt: Math.round(n(p.holidayDays) * dayRate) },
      n(rec.extraHours) !== 0 && { key: 'manual', label: `手動調整 ${rec.extraHours}h`, amt: Math.round(n(rec.extraHours) * hourRate) },
    ].filter(Boolean);
    // 其他加項（津貼、獎金、休息日加班、特補休結算）照表單填的金額
    [['roleBonus', '職務津貼'], ['laborAllowance', '勞務津貼'], ['performance', '績效津貼'], ['nightAllowance', '夜點費'],
     ['otherBonus', rec.otherBonusNote ? `其他獎金/津貼（${rec.otherBonusNote}）` : '其他獎金/津貼'], ['restDayOtPay', '休息日加班'],
     ['annualLeaveEncash', '特休折現'], ['compLeaveEncash', '補休折現']]
      .forEach(([k, label]) => { if(n(rec[k]) > 0) items.push({ key: k, label, amt: Math.round(n(rec[k])) }); });
    if(n(rec.personalSickLeave) !== 0) items.push({ key: 'sick', label: '事病假扣款', amt: -Math.abs(Math.round(n(rec.personalSickLeave))) });
    const gross = Math.max(0, items.reduce((s, x) => s + x.amt, 0));
    return { items, gross, dayRate: Math.round(dayRate * 100) / 100, hourRate: Math.round(hourRate * 100) / 100,
      agreed, creditDays: r1d(creditH / 8), shortDays: r1d(shortH / 8), waivedDays: r1d(waiveH / 8), parts: p };
  }
  function r1d(x){ return Math.round(x * 10) / 10; }

  // 勞健保自願提高級距：公司因此多付的（勞保＋健保＋勞退）差額由員工負擔（合約第 6 條第 3 款）
  function insExtraFor(chosen, base){
    if(!chosen || !base) return 0;
    const er = g => n(g.laborEr) + n(g.healthEr) + n(g.pension);
    return Math.max(0, Math.round(er(chosen) - er(base)));
  }

  return { ROLE_PART, getWeekDatesFromStr, recBelongsTo, hourlyRate, calcDeduct, calcEmpHours, calcHourlySupportHours, grossFromParts,
    effSalaryRole, monthHolidays, week1MondayOf, weekStrOfDate, monthWeeks, calcMonthOffDays, detectHolidayWork, calcEmpHolidayHours,
    ptmMonthlyFor, calcPtmParts, ptmBreakdown, insExtraFor };
})();
