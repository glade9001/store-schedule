// 首頁之五：我的月曆、今日班別徽章、統計區。2026-10-16 從 home-page.js 原封不動切出來（整理第 4 階段）。

// ===== 個人出勤月曆 =====
let myCalMonth = null; // { year, month }

function toggleMyCalendar() {
  const btn = document.getElementById('myCalToggleBtn');
  const calView = document.getElementById('myCalView');
  const weekView = document.getElementById('homeWeekView');
  const isOpen = calView.style.display !== 'none';
  if(!isOpen) {
    weekView.style.display = 'none';
    calView.style.display = 'block';
    btn.textContent = '週次';
    btn.classList.add('active');
    const now = new Date();
    myCalMonth = { year: now.getFullYear(), month: now.getMonth() };
    loadMyCalendar();
  } else {
    calView.style.display = 'none';
    weekView.style.display = 'block';
    btn.textContent = '月曆';
    btn.classList.remove('active');
  }
}

function myCalChangeMonth(offset) {
  myCalMonth.month += offset;
  if(myCalMonth.month < 0)  { myCalMonth.month = 11; myCalMonth.year--; }
  if(myCalMonth.month > 11) { myCalMonth.month = 0;  myCalMonth.year++; }
  loadMyCalendar();
}

function myCalMonthWeeks(year, month) {
  // 逐日收集週次；必須先退到該日所屬「週一」再換算，否則「月初落在週六/週日」的月份會整週漏抓。
  const weeks = new Set();
  const last = new Date(year, month + 1, 0).getDate();
  for(let d = 1; d <= last; d++) weeks.add(weekStrOfDate(new Date(year, month, d)));
  return [...weeks];
}

function myCalDateStr(weekStr, dayIdx) {
  const mon = weekStringToDateHome(weekStr);
  const d = new Date(mon);
  d.setDate(mon.getDate() + dayIdx);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadMyCalendar() {
  const empName = currentUser?.empName;
  const store   = currentUser?.store;
  const { year, month } = myCalMonth;

  document.getElementById('myCalMonthTitle').textContent = `${year} 年 ${month + 1} 月`;

  const now = new Date();
  const diff = (year - now.getFullYear()) * 12 + (month - now.getMonth());
  const prevBtn = document.getElementById('myCalPrevBtn');
  const nextBtn = document.getElementById('myCalNextBtn');
  if(prevBtn) prevBtn.disabled = diff <= -2;
  if(nextBtn) nextBtn.disabled = diff >= 2;

  const grid = document.getElementById('myCalGrid');
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">載入中...</div>';

  if(!store || !empName) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">無個人班表</div>';
    return;
  }

  const weeks = myCalMonthWeeks(year, month);
  const otherStores = (appConfig.stores || []).filter(s => s !== store);
  const dNamesLocal = ['週一','週二','週三','週四','週五','週六','週日'];
  const supportKey = `${store}-${empName}`;

  // 平行讀取本店各週 + 其他門市（支援記錄）
  const snaps = await Promise.all(
    weeks.map(w =>
      Promise.all([
        window.db.collection('stores').doc(store).collection('weeks').doc(w).get().catch(()=>null),
        ...otherStores.map(s =>
          window.db.collection('stores').doc(s).collection('weeks').doc(w).get().catch(()=>null)
        )
      ]).then(([own, ...others]) => ({ w, own, others }))
    )
  );

  // dateStr -> { shift, note, isSupport, supportStore, published }
  const dayMap = {};

  snaps.forEach(({ w, own, others }) => {
    // 優先用本店；若本店無此員工記錄（調店過渡期），fallback 到舊店
    let recSnap = null, recPub = false, recStoreName = store;
    if(own?.exists && (own.data().records || []).some(r => r.name === empName)) {
      recSnap = own;
      recPub = own.data().published || isAutoPublishedHome(w);
      recStoreName = store;
    } else {
      for(let fi = 0; fi < others.length; fi++) {
        const snap = others[fi];
        if(!snap?.exists) continue;
        if((snap.data().records || []).some(r => r.name === empName)) {
          recSnap = snap;
          recPub = snap.data().published || isAutoPublishedHome(w);
          recStoreName = otherStores[fi];
          break;
        }
      }
    }
    const published = recSnap ? recPub : ((own?.exists && own.data().published) || isAutoPublishedHome(w));

    // 標記該週所有天（published 狀態）
    dNamesLocal.forEach((_, di) => {
      const ds = myCalDateStr(w, di);
      if(!dayMap[ds]) dayMap[ds] = { shift:'', note:'', isSupport:false, supportStore:'', published };
    });

    // 員工本人記錄（本店或 fallback 舊店）
    if(recSnap) {
      (recSnap.data().records || []).forEach(r => {
        if(r.name !== empName) return;
        const di = dNamesLocal.indexOf(r.day);
        if(di < 0) return;
        const ds = myCalDateStr(w, di);
        const loc = (r.location && r.location !== '本店') ? r.location : '';
        dayMap[ds] = { shift: r.shift||'', note: r.note||'', isSupport: !!loc, supportStore: loc, published };
      });
    }

    // 其他門市：找 supportEmp === '本店-自己' 且 approved → 去支援別店
    others.forEach((snap, idx) => {
      if(!snap?.exists) return;
      const toStore = otherStores[idx];
      (snap.data().records || []).forEach(r => {
        if(r.approvalStatus !== 'approved' || r.supportEmp !== supportKey) return;
        const di = dNamesLocal.indexOf(r.day);
        if(di < 0) return;
        const ds = myCalDateStr(w, di);
        // 有支援記錄就補上目的門市，不論 own record 有無 shift
        // ⚠️ 本店那格通常是「排休」（人不在本店），不可讓它蓋掉支援班 → 否則支援日會顯示「休」
        const prev = dayMap[ds] || {};
        const prevShift = prev.shift || '';
        const prevOff = prevShift === '排休' || prevShift === '指休';
        const takeSupport = !prevShift || prevOff;   // 整日外派
        dayMap[ds] = takeSupport
          ? { shift: r.shift || prevShift, note: prev.note||'', isSupport:true, supportStore: toStore, published: prev.published ?? published }
          : { shift: prevShift, note: prev.note||'', isSupport: !!prev.isSupport, supportStore: prev.supportStore || '',
              supportMark: prev.isSupport ? '' : toStore, published: prev.published ?? published };
      });
    });
  });

  renderMyCalendar(year, month, dayMap);
}

function renderMyCalendar(year, month, dayMap) {
  const grid = document.getElementById('myCalGrid');
  const todayStr = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().split('T')[0];
  const hdrs = ['一','二','三','四','五','六','日'];
  let html = hdrs.map((h,i) => `<div class="my-cal-hdr${i>=5?' we':''}">${h}</div>`).join('');

  const firstDay = new Date(year, month, 1);
  const dow = firstDay.getDay() || 7;
  let cur = new Date(firstDay);
  cur.setDate(cur.getDate() - (dow - 1));

  const lastDay = new Date(year, month + 1, 0);
  let end = new Date(lastDay);
  const edow = end.getDay() || 7;
  end.setDate(end.getDate() + (7 - edow));

  while(cur <= end) {
    const ds = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    const isThis = cur.getMonth() === month;
    const isToday = ds === todayStr;
    const isWe = cur.getDay() === 0 || cur.getDay() === 6;
    const info = dayMap[ds];
    let cls = 'my-cal-cell';
    if(!isThis) cls += ' blank';
    else if(isToday) cls += ' today';
    else if(isWe) cls += ' we-cell';

    let inner = '';
    if(isThis) {
      inner += `<span class="my-cal-dn">${cur.getDate()}</span>`;
      if(info) {
        if(!info.published && ds >= todayStr) {
          inner += `<span class="my-cal-st np">待公布</span>`;
        } else if(info.published) {
          const s = info.shift;
          if(info.isSupport && s) {
            inner += `<span style="font-size:9px;color:#16a34a;font-weight:900;display:block;text-align:center;line-height:1.4;">${info.supportStore}</span>`;
            inner += `<span class="my-cal-st su">${s.replace('-','/')}</span>`;
          } else if(info.supportMark && s) {
            // 本店有主班＋同日再去他店支援
            inner += `<span class="my-cal-st w">${s.replace('-','/')}</span>`;
            inner += `<span style="font-size:9px;color:#16a34a;font-weight:900;display:block;text-align:center;line-height:1.4;">🆘${info.supportMark}</span>`;
          } else if(s === '指休') {
            inner += `<span class="my-cal-st or">休</span>`;
          } else if(s === '排休') {
            inner += `<span class="my-cal-st o">休</span>`;
          } else if(s === '特休') {
            inner += `<span class="my-cal-st sp">特休</span>`;
          } else if(s === '補休') {
            inner += `<span class="my-cal-st cp">補休</span>`;
          } else if(s) {
            inner += `<span class="my-cal-st w">${s.replace('-','/')}</span>`;
          }
        }
      }
    }
    html += `<div class="${cls}">${inner}</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  grid.innerHTML = html;
}

function updateTodayShiftBadge(myRecs, dates, dNames, todayStr, supportRecs) {
  const badge = document.getElementById('todayShiftBadge');
  if(!badge) return;
  const todayIdx = dates.findIndex(d => d === todayStr);
  if(todayIdx < 0) { badge.style.display = 'none'; return; }
  const rec = myRecs.find(r => r.day === dNames[todayIdx]) || {};
  const shift = rec.shift || '';
  // 支援班優先（同 loadMySchedule：本店空白或排休/指休時，今天實際是去他店上班）
  const supp = (supportRecs || []).find(r => r.day === dNames[todayIdx]);
  const homeOff = shift === '排休' || shift === '指休';
  if(supp && (!shift || homeOff)) {
    badge.textContent = `⏰ ${supp.shift || '支援'}　🆘 ${supp._supportStore}`;
    badge.style.display = 'inline-block';
    badge.style.background = 'rgba(255,255,255,0.25)';
    return;
  }
  if(!shift) { badge.style.display = 'none'; return; }
  const isOff = homeOff;
  let text = isOff ? '今日休假' : `⏰ ${shift}`;
  if(rec.note) text += `　${rec.note}`;
  badge.textContent = text;
  badge.style.display = 'inline-block';
  badge.style.background = isOff ? 'rgba(217,48,37,0.3)' : 'rgba(255,255,255,0.25)';
}

// ===== 統計 =====
function renderStatsArea() {
  const role = currentUser.role || '';
  // 以工讀採計的特例（店長但以工讀時薪計）— 規則寫死
  const isPartTime = role === '工讀' || ['楷岳'].includes(currentUser.empName);
  const el = document.getElementById('statsArea');
  if(!el) return;

  if(isPartTime) {
    // 使用 Flexbox 實現兩欄等寬並列
    el.innerHTML = `
      <div class="stats-row" style="display: flex; gap: 8px;">
        <div class="stat-card" style="flex: 1; display: flex; flex-direction: column; align-items: center; padding: 10px 4px;">
          <div class="stat-icon">⏱️</div>
          <div class="stat-val" id="statWeekH" style="font-size:20px;">--</div>
          <div class="stat-label" style="font-size: 11px;">本週工時 (h)</div>
        </div>
        <div class="stat-card" style="flex: 1; display: flex; flex-direction: column; align-items: center; padding: 10px 4px;">
          <div class="stat-icon">📆</div>
          <div class="stat-val" id="statMonthH" style="font-size:20px;">--</div>
          <div class="stat-label" style="font-size: 11px;">本月工時 (h)</div>
        </div>
      </div>`;
  } else {
    // 正職人員保持三欄佈局
    el.innerHTML = `
      <div class="stats-row" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
        <div class="stat-card" onclick="window.location.href='leave.html'" style="cursor:pointer; padding: 10px 4px; display: flex; flex-direction: column; align-items: center;">
          <div class="stat-icon">🏖️</div>
          <div class="stat-val" id="statAnnualLeave" style="font-size:20px;">--</div>
          <div class="stat-label" style="font-size: 9px;">特休 (天)</div>
        </div>
        <div class="stat-card" onclick="window.location.href='leave.html'" style="cursor:pointer; padding: 10px 4px; display: flex; flex-direction: column; align-items: center;">
          <div class="stat-icon">📆</div>
          <div class="stat-val" id="statCompLeave" style="font-size:20px;">--</div>
          <div class="stat-label" style="font-size: 9px;">補休 (天)</div>
        </div>
        <div class="stat-card" style="padding: 10px 4px; display: flex; flex-direction: column; align-items: center;">
          <div class="stat-icon">⚡</div>
          <div class="stat-val" id="statMonthOT" style="font-size:20px;">--</div>
          <div class="stat-label" style="font-size: 9px;">本月加班 (h)</div>
        </div>
      </div>`;
  }
}

// ===== 統計 =====
async function loadStats() {
  renderStatsArea();
  const weekStr = getCurrentWeekString();
  const store = currentUser.store;
  const empName = currentUser.empName;
  const role = currentUser.role || '';
  // ⚠️ 必須與 renderStatsArea 的 isPartTime 一致(含楷岳特例)，否則卡片是工讀版、卻走正職分支→工時不填顯示「--」
  const isPartTime = role === '工讀' || ['楷岳'].includes(currentUser.empName);

  if(!store || !empName) return;

  try {
    const snap = await Promise.race([
      window.db.collection('stores').doc(store).collection('weeks').doc(weekStr).get(),
      new Promise(res => setTimeout(() => res(null), 6000))
    ]);
    const records = (snap?.exists && snap.data().records) ? snap.data().records : [];
    const myRecs = records.filter(r => r.name === empName);
    const workDays = myRecs.filter(r => r.shift && r.shift !== '排休' && r.shift !== '指休').length;
    const weekHours = myRecs.reduce((s, r) => {
      if(r.shift && r.shift !== '排休' && r.shift !== '指休') return s + (parseFloat(r.actualHours)||0);
      return s;
    }, 0);

    const nowMonth = new Date();
    const targetY = nowMonth.getFullYear();
    const targetM = nowMonth.getMonth() + 1; 
    const targetMonthStr = `${targetY}-${String(targetM).padStart(2, '0')}`;

    const firstDay = new Date(targetY, targetM - 1, 1);
    const lastDay = new Date(targetY, targetM, 0);

    const weeksToFetch = new Set();
    let tempD = new Date(firstDay);
    while (tempD <= lastDay) {
      weeksToFetch.add(weekStrOfDate(tempD));
      tempD.setDate(tempD.getDate() + 1);
    }

    // 今天日期字串（YYYY-MM-DD），用於截止判斷
    const todayStr = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().split('T')[0];

    let monthHours = 0, monthOff = 0, monthOT = 0;

    // 🚀 優化 1：平行拉取所有週次的統計資料
    const weekPromises = Array.from(weeksToFetch).map(ws => 
      window.db.collection('stores').doc(store).collection('weeks').doc(ws).get()
        .then(s2 => ({ ws, snap: s2 }))
        .catch(e => { console.warn(`拉取 ${ws} 統計失敗`, e); return null; })
    );

    const weekResults = await Promise.race([
      Promise.all(weekPromises),
      new Promise(res => setTimeout(() => res([]), 6000))
    ]);

    weekResults.forEach(res => {
      if (!res || !res.snap.exists) return;
      const { ws, snap: s2 } = res;
      const recs2 = (s2.data().records || []).filter(r => r.name === empName);
      const wDates = getWeekDates(ws); 

      recs2.forEach(r => {
        const dayIdx = ['週一','週二','週三','週四','週五','週六','週日'].indexOf(r.day);
        if(dayIdx < 0) return;

        const [recM] = wDates[dayIdx].split('/');
        let recY = parseInt(ws.split('-W')[0]);

        if (parseInt(recM) === 12 && parseInt(ws.split('-W')[1]) === 1) recY -= 1;
        if (parseInt(recM) === 1 && parseInt(ws.split('-W')[1]) >= 52) recY += 1;

        const recMonthStr = `${recY}-${recM.padStart(2, '0')}`;

        if(recMonthStr === targetMonthStr) {
          // 只統計到今天（含今天），未來日期不計入
          const recDay = parseInt(wDates[dayIdx].split('/')[1]);
          const recDateStr = `${recY}-${recM.padStart(2,'0')}-${String(recDay).padStart(2,'0')}`;
          if(recDateStr > todayStr) return;
          const h = parseFloat(r.actualHours || 0);
          if(r.shift === '排休' || r.shift === '指休') {
            monthOff++;
          } else if(r.shift) {
            monthHours += h;
            if(r.isOT || h > 8) monthOT += Math.max(0, h - 8);
          }
        }
      });
    });

    if(isPartTime) {
      const whEl = document.getElementById('statWeekH');
      const mhEl = document.getElementById('statMonthH');
      if(whEl) whEl.textContent = Math.round(weekHours * 10) / 10;
      if(mhEl) mhEl.textContent = Math.round(monthHours * 10) / 10;
    } else {
      const otEl = document.getElementById('statMonthOT');
      const annualLeaveEl = document.getElementById('statAnnualLeave');
      const compLeaveEl = document.getElementById('statCompLeave');

      if(otEl) {
        const otVal = Math.round(monthOT * 10) / 10;
        otEl.textContent = otVal;
        otEl.style.color = otVal > 0 ? 'var(--danger)' : 'var(--text)';
      }
      const empNameStr = currentUser.empName || currentUser.displayName || '';
      const thisYear = new Date().getFullYear();
      if(empNameStr) {
        // 讀取批次計算特休剩餘
        // 跟劃休頁同一套算法（2026-10-15）：補休用 comp-avail.js 的「已生效」可用天數（從帳本算）；
        // 原本讀 comp/{年}.earned − used（統計欄會漂、也算進還沒到那天的國定假日補休），21 人中有 8 人跟劃休頁不一樣
        Promise.all([
          window.db.collection('employees').doc(empNameStr).collection('leaveBatches').get(),
          typeof caCompAvailability === 'function' ? caCompAvailability(empNameStr) : Promise.resolve(null)
        ]).then(([batchSnap, compAv]) => {
          const todayStr = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().split('T')[0];
          let totalAvail = 0;
          if(batchSnap) {
            batchSnap.forEach(d => {
              const b = d.data();
              if(b.settled) return;
              const rem = (b.days||0) - (b.used||0);
              if(rem <= 0) return;
              // 遞延批次到期＝原到期日＋12 個月−1 天（同劃休頁 addMonths、假勤頁 dateAddExpire）
              const expDate = b.carried
                ? (() => { const d2=new Date(b.expireDate); d2.setMonth(d2.getMonth()+12); d2.setDate(d2.getDate()-1); return d2.toISOString().split('T')[0]; })()
                : b.expireDate;
              if(todayStr <= expDate) totalAvail += rem;
            });
          }
          const remainComp = compAv ? Math.max(0, compAv.effective) : '--';
          
          if(annualLeaveEl) {
            annualLeaveEl.textContent = totalAvail;
            annualLeaveEl.style.color = totalAvail > 0 ? '#7c3aed' : 'var(--text-muted)';
          }
          if(compLeaveEl) {
            compLeaveEl.textContent = remainComp;
            compLeaveEl.style.color = remainComp > 0 ? '#1a73e8' : 'var(--text-muted)';
            compLeaveEl.title = compAv && compAv.pending.length ? '另有國定假日補休：' + caPendingText(compAv.pending) : '';
          }
        }).catch(() => { 
          if(annualLeaveEl) annualLeaveEl.textContent = '--';
          if(compLeaveEl) compLeaveEl.textContent = '--';
        });
      } else {
        if(annualLeaveEl) annualLeaveEl.textContent = '--';
        if(compLeaveEl) compLeaveEl.textContent = '--';
      }
    }
  } catch(e) {
    console.error('統計載入失敗:', e);
  }
}
