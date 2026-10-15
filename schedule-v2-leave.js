// 排班頁（schedule-V2.html）之二：特休／補休扣還、國定假日補休發放與撤銷、歷史補休修正。2026-10-16 從 schedule-v2-page.js 原封不動切出來（整理第 4 階段）。
// ⚠️ 排班頁的程式依序載入 page → leave → save → emp → views → table → summary，共用同一組全域變數；頂層只有宣告，不要在這裡加會馬上執行的程式。

// ===== ✅ 特休/補休扣天數（全自動雙軌同步 - 終極防錯版）=====
// ===== 特休/補休扣還（方案C：日期化事件帳本為唯一真相）=====
// annualUsage/{YYYY-MM-DD}、compUsage/{YYYY-MM-DD} 每格一筆(存在=該日使用)。
// 冪等：排上→set、塗掉→delete；counter 一律從帳本集合重算 → cell 與帳本永遠一致，
// 不論走一般改班、畫筆或 undo 都不會漂（不再依賴 leaveLog 淨額累計）。
async function deductLeave(empName, day, weekStr, prevShift, newShift) {
  const prevIsAnnual = prevShift === '特休';
  const prevIsComp   = prevShift === '補休';
  const newIsAnnual  = newShift  === '特休';
  const newIsComp    = newShift  === '補休';
  if(prevIsAnnual === newIsAnnual && prevIsComp === newIsComp) return;

  // 精確計算這格的日期 (處理跨年)
  const dIdx = dayNames.indexOf(day);
  if(dIdx < 0) return;
  const weekMon = weekStringToDate(weekStr);
  const cellDate = new Date(weekMon);
  cellDate.setDate(weekMon.getDate() + dIdx);
  const cy = cellDate.getFullYear();
  const cm = String(cellDate.getMonth()+1).padStart(2,'0');
  const cd = String(cellDate.getDate()).padStart(2,'0');
  const fullDate = `${cy}-${cm}-${cd}`;
  const yearStr = String(cy);
  const savedBy = currentUser?.displayName || currentUser?.empName || '';
  const ts = new Date().getTime();

  try {
    const empRef    = window.db.collection('employees').doc(empName);
    const annUseRef = empRef.collection('annualUsage').doc(fullDate);
    const compUseRef= empRef.collection('compUsage').doc(fullDate);
    const batchesRef= empRef.collection('leaveBatches');

    // --- 1) 帳本日期冪等寫入（唯一真相）---
    if(newIsAnnual && !prevIsAnnual) {
      await annUseRef.set({ date: fullDate, store: (currentUser?.store||''), source: `schedule:${fullDate}`, note: `${fullDate} 使用特休`, savedBy, ts });
    } else if(prevIsAnnual && !newIsAnnual) {
      await annUseRef.delete();
    }
    if(newIsComp && !prevIsComp) {
      await compUseRef.set({ date: fullDate, store: (currentUser?.store||''), source: `schedule:${fullDate}`, note: `${fullDate} 使用補休`, savedBy, ts });
    } else if(prevIsComp && !newIsComp) {
      await compUseRef.delete();
    }

    // --- 2) 特休批次 used 增減（沿用既有 FIFO：新增扣最早、取消退最晚；餘額不足僅提示不阻擋）---
    if(newIsAnnual !== prevIsAnnual) {
      const bSnap = await batchesRef.get();
      if(newIsAnnual) {
        let target=null, latest=null, remainTotal=0;
        bSnap.forEach(doc => {
          const b = { id: doc.id, ...doc.data() };
          if(!latest || b.createdAt > latest.createdAt) latest = b;
          if(!b.settled) { const rem=(b.days||0)-(b.used||0); remainTotal+=rem; if(rem>0 && (!target || b.grantDate < target.grantDate)) target=b; }
        });
        const bd = target || latest;
        if(bd) await batchesRef.doc(bd.id).update({ used: (bd.used||0) + 1 });
        if(remainTotal <= 0) showToast(`⚠️ ${getDisplayName(empName)} 特休餘額不足，仍已排入（餘額轉負，請留意）`);
      } else {
        let target=null;
        bSnap.forEach(doc => { const b={ id:doc.id, ...doc.data() }; if(b.used>0 && (!target || b.grantDate > target.grantDate)) target=b; });
        if(target) await batchesRef.doc(target.id).update({ used: Math.max(0, target.used - 1) });
      }
    }

    // --- 3) 從帳本集合重算所有快取 counter ---
    await recomputeLeaveCounters(empName, yearStr);

    invalidateLeaveSum(empName);   // 帳本動過了，統計欄的餘額快取要重抓
    setTimeout(() => {
      const eIdx = appData.employees.findIndex(e => e.name === empName);
      if(eIdx !== -1) updateSummary(eIdx, appData.employees[eIdx]);
    }, 400);

  } catch(e) {
    console.warn('deductLeave 失敗:', e.message);
  }
}

// ===== 從 annualUsage / compUsage 帳本重算快取欄位（給 salary/leave/export 等既有讀取端用）=====
// usedAnnual/usedComp = 帳本筆數(依年)；補休 earned 仍取自 leaveLog(comp_earn/comp_cancel)；
// 補休遞延(前一年度 carried)優先扣，其餘記當年度。idempotent。
async function recomputeLeaveCounters(empName, yearStr) { return lvRecomputeLeaveCounters(empName, yearStr); } // 規則在 leave-rules.js（2026-10-16 合併）
// 某天國定假日補休的淨額（發放 − 撤銷）；同 functions syncHolidayCompForWeek、comp-avail.js 的口徑
function holidayCompNet(records, date) { return lvHolidayCompNet(records, date); } // 規則在 leave-rules.js
// ===== 國定假日補休：發放 =====
async function grantHolidayComp(empName, fullDate, holidayName) {
  const year = fullDate.slice(0,4);
  const ym   = fullDate.slice(0,7);
  const savedBy = currentUser?.displayName || currentUser?.empName || '';
  const logRef  = window.db.collection('employees').doc(empName).collection('leaveLog').doc(ym);
  const compRef = window.db.collection('employees').doc(empName).collection('comp').doc(year);
  const leaveRef= window.db.collection('employees').doc(empName).collection('leaves').doc(year);

  // 防重複：看「發放 − 撤銷」的淨額，不能只看有沒有 comp_earn（2026-10-15：發放→撤銷→再發放被擋，16 班正職國定假日上班補休是 0）
  const logSnap = await logRef.get();
  if(holidayCompNet(logSnap.exists ? logSnap.data().records||[] : [], fullDate) > 0) { showToast(`⚠️ ${empName} ${fullDate} 補休已發放過`); return false; }

  const note = `${fullDate} ${holidayName} 國定假日補休`;
  await logRef.set({ records: firebase.firestore.FieldValue.arrayUnion({
    date: fullDate, type: 'comp_earn', days: 1, note,
    source: 'holiday', // ✅ Bug6 S2：標記為國定假日補休來源
    savedBy, ts: Date.now() // ts：arrayUnion 會吃掉一模一樣的紀錄（再發放時跟第一筆完全相同）
  })}, { merge: true });

  // 同步 comp/{year}
  const compSnap = await compRef.get();
  const cd = compSnap.exists ? compSnap.data() : { earned:0, used:0 };
  await compRef.set({ earned: (cd.earned||0)+1, used: cd.used||0 }, { merge: true });

  // 同步 leaves/{year}
  const leaveSnap = await leaveRef.get();
  const ld = leaveSnap.exists ? leaveSnap.data() : {};
  await leaveRef.set({ ...ld, earnedComp: (ld.earnedComp||0)+1, updatedAt: new Date().toISOString() }, { merge: true });

  invalidateLeaveSum(empName);   // 帳本動過了，統計欄的餘額快取要重抓
  return true;
}

// ===== 國定假日補休：撤銷 =====
async function revokeHolidayComp(empName, fullDate, holidayName) {
  const year = fullDate.slice(0,4);
  const ym   = fullDate.slice(0,7);
  const savedBy = currentUser?.displayName || currentUser?.empName || '';
  const logRef  = window.db.collection('employees').doc(empName).collection('leaveLog').doc(ym);
  const compRef = window.db.collection('employees').doc(empName).collection('comp').doc(year);
  const leaveRef= window.db.collection('employees').doc(empName).collection('leaves').doc(year);

  const note = `${fullDate} ${holidayName} 國定假日補休撤銷`;
  const logSnap0 = await logRef.get();
  if(holidayCompNet(logSnap0.exists ? logSnap0.data().records||[] : [], fullDate) <= 0) return false; // 目前沒有發放中的，不撤（避免撤成負的）
  await logRef.set({ records: firebase.firestore.FieldValue.arrayUnion({
    date: fullDate, type: 'comp_cancel', days: 1, note, source: 'holiday', savedBy, ts: Date.now()
  })}, { merge: true });

  const compSnap = await compRef.get();
  const cd = compSnap.exists ? compSnap.data() : { earned:0, used:0 };
  await compRef.set({ earned: Math.max(0,(cd.earned||0)-1), used: cd.used||0 }, { merge: true });

  const leaveSnap = await leaveRef.get();
  const ld = leaveSnap.exists ? leaveSnap.data() : {};
  await leaveRef.set({ ...ld, earnedComp: Math.max(0,(ld.earnedComp||0)-1), updatedAt: new Date().toISOString() }, { merge: true });
  invalidateLeaveSum(empName);   // 同上
}

// ===== 國定假日偵測：這格儲存時檢查是否需要發/撤銷補休 =====
// 計薪模式：payAsPartTime（如楷岳，職務店長但領時薪）在排班端也比照工讀——統計看工時、國定假日不發補休
// （與 salary.html effSalaryRole 同一旗標）
function isPartTimeEmp(emp) { return lvIsPayPartTime(emp); } // 規則在 leave-rules.js

async function checkHolidayCompOnSave(empName, fullDate, prevShift, newShift, emp) {
  // 工讀生不處理補休（加盟主照發：使用者 2026-10-15 確認）
  if(!emp || isPartTimeEmp(emp)) return;

  const holidayName = TW_HOLIDAYS_SCHED[fullDate];
  if(!holidayName) return; // 不是國定假日
  // 發布前不發也不撤（使用者 2026-10-15）：發布當下由後端依班表一次對齊（functions syncHolidayCompForWeek）；發布後改班才逐格詢問
  const wkOf = shiftWeekStr(fullDate), pdh = weekPublishData[wkOf] || {};
  if(!(pdh.published || isAutoPublished(wkOf))) return;

  const wasWorking = prevShift && prevShift !== '排休' && prevShift !== '指休' && prevShift !== '特休' && prevShift !== '補休';
  const isWorking  = newShift  && newShift  !== '排休' && newShift  !== '指休' && newShift  !== '特休' && newShift  !== '補休';

  if(!wasWorking && isWorking) {
    // 新增上班 → 提示發放補休
    if(confirm(`🎌 ${fullDate} 是${holidayName}（國定假日）
${getDisplayName(empName)} 有上班，是否發放 1 天補休？`)) {
      const ok = await grantHolidayComp(empName, fullDate, holidayName);
      if(ok) showToast(`✅ 已發放 ${getDisplayName(empName)} ${fullDate} 補休`);
    }
  } else if(wasWorking && !isWorking) {
    // 取消上班 → 檢查是否已發補休
    const ym = fullDate.slice(0,7);
    const logSnap = await window.db.collection('employees').doc(empName).collection('leaveLog').doc(ym).get();
    const hasComp = holidayCompNet(logSnap.exists ? logSnap.data().records||[] : [], fullDate) > 0;
    if(hasComp) {
      if(confirm(`⚠️ ${fullDate} ${holidayName} 已發放補休
${getDisplayName(empName)} 取消上班，是否一併撤銷補休？`)) {
        await revokeHolidayComp(empName, fullDate, holidayName);
        showToast(`已撤銷 ${getDisplayName(empName)} ${fullDate} 補休`);
      }
    }
  }
}

// ===== 朔及既往補休修復（系統管理員）詳細報告版 =====
async function runHistoricalCompFix() {
  if(!['admin'].includes(currentUser?.permission)) { showToast('⚠️ 僅系統管理員可執行'); return; }

  const TARGET_HOLIDAYS = {
    '2026-04-04': '兒童節',
    '2026-04-05': '清明節',
    '2026-05-01': '勞動節'
  };

  if(!confirm('即將掃描「所有門市」的 4/4、4/5、5/1 班表，補發漏掉的國定假日補休。\n\n確定執行嗎？')) return;

  showLoading('朔及既往補休修復中...');
  let report = "📊 【補休修復詳細報告】\n\n";

  try {
    let totalFixCount = 0;
    const storesToFix = (appConfig.stores && appConfig.stores.length > 0) ? appConfig.stores : [currentUser.store];
    
    // 讀取 4, 5 月涵蓋週次
    const targetWeeks = [];
    ['2026-04', '2026-05'].forEach(ym => {
      const [y, mo] = ym.split('-').map(Number);
      const firstDay = new Date(y, mo-1, 1);
      const lastDay  = new Date(y, mo, 0);
      let d = new Date(firstDay);
      while(d <= lastDay) {
        const mon = new Date(d);
        const day = mon.getDay() || 7;
        mon.setDate(mon.getDate() - day + 1);
        const wStr = weekStrOfDate(mon);
        if(!targetWeeks.includes(wStr)) targetWeeks.push(wStr);
        d.setDate(d.getDate() + 7);
      }
    });

    const dNames = ['週一','週二','週三','週四','週五','週六','週日'];

    for(const store of storesToFix) {
      report += `🏠 門市：${store}\n`;
      let storeFixCount = 0;
      let skippedPartTime = 0;
      let noWorkCount = 0;
      let alreadyGivenCount = 0;

      const empSnap = await window.db.collection('stores').doc(store).collection('employees').get();
      const emps = [];
      empSnap.forEach(d => {
        const data = d.data();
        if(!['離職','調走'].includes(data.status)) {
          if(isPartTimeEmp(data)) {
            skippedPartTime++;
          } else {
            emps.push({ name: d.id, ...data });
          }
        }
      });

      const weekData = {};
      await Promise.all(targetWeeks.map(async ws => {
        const snap = await window.db.collection('stores').doc(store).collection('weeks').doc(ws).get();
        weekData[ws] = snap.exists ? (snap.data().records || []) : [];
      }));

      for(const [dateStr, holName] of Object.entries(TARGET_HOLIDAYS)) {
        const [hy, hm, hd] = dateStr.split('-').map(Number);
        for(const emp of emps) {
          let hasWork = false;
          for(const [ws, recs] of Object.entries(weekData)) {
            const wsYear = parseInt(ws.split('-W')[0]);
            const wsWeek = parseInt(ws.split('-W')[1]);
            const jan1 = new Date(wsYear, 0, 1);
            const offset = (jan1.getDay() <= 4 ? 1 - jan1.getDay() : 8 - jan1.getDay());
            const mon = new Date(wsYear, 0, 1 + offset + (wsWeek-1)*7);
            
            for(let i=0; i<7; i++) {
              const cellDate = new Date(mon);
              cellDate.setDate(mon.getDate() + i);
              if(cellDate.getFullYear()===hy && cellDate.getMonth()+1===hm && cellDate.getDate()===hd) {
                const rec = recs.find(r => r.name===emp.name && r.day===dNames[i]);
                if(rec && rec.shift && !['排休','指休','特休','補休'].includes(rec.shift)) {
                  hasWork = true;
                }
              }
            }
          }

          if(hasWork) {
            const ok = await grantHolidayComp(emp.name, dateStr, holName);
            if(ok) { 
              storeFixCount++; 
              totalFixCount++;
              const loadingEl = document.getElementById('loadingSub');
              if(loadingEl) loadingEl.textContent = `修復中(${store})... 已處理 ${totalFixCount} 筆`; 
            } else {
              alreadyGivenCount++;
            }
          } else {
            noWorkCount++;
          }
        }
      }
      
      report += `   ✅ 成功補發：${storeFixCount} 筆\n`;
      report += `   ⏩ 略過工讀生：${skippedPartTime} 人\n`;
      report += `   ⏩ 沒排班或已休：${noWorkCount} 人次（每假計算）\n`;
      report += `   ⏩ 先前已發放：${alreadyGivenCount} 筆\n\n`;
    }

    report += `🎉 總計成功補發：${totalFixCount} 筆`;
    
    // 更新紀錄
    await window.db.collection('settings').doc('compFixFlag').set({ 
      done: true, doneAt: new Date().toISOString(), by: currentUser.empName, count: totalFixCount 
    });

    alert(report);
    showToast(`✅ 全門市掃描完畢！`);

  } catch(e) { 
    alert('❌ 發生錯誤：\n' + e.message); 
  }
  hideLoading();
}
