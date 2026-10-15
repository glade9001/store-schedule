// 排班頁之三：自動儲存、交易式合併存檔、畫筆塗格、讀紀錄、讀三店資料（fetchAllStoreData）。2026-10-16 從 schedule-v2-page.js 原封不動切出來（整理第 4 階段）。

// ===== 自動儲存 =====
function autoResizeNote(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function triggerAutoSave() {
  setSyncStatus('syncing', '儲存中...');
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveScheduleData(false), 1500);
}

// 交易式合併存檔：整包寫回時，保護「待補格」被別店寫入的跨店欄位不被倒退覆蓋
// （B 店支援/審核透過交易寫 supportEmp 到本店待補格；A 店整包存檔不可把它蓋回舊值）
async function saveWeekRecordsMerged(store, weekStr, localRecords, extra) {
  const docRef = window.db.collection('stores').doc(store).collection('weeks').doc(weekStr);
  try {
    await window.db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const dbRecs = (snap.exists && snap.data().records) ? snap.data().records : [];
      const merged = (localRecords || []).map(r => {
        if(!String(r.name || '').startsWith('🆘待補')) return r; // 只保護待補格
        const d = dbRecs.find(x => x.name === r.name && x.day === r.day);
        if(!d) return r;
        // 以 supportUpdatedAt 判新舊：DB 的跨店異動較新(別店剛支援/同意) → 保留 DB，不讓過時存檔倒退；
        // 但本地較新(含店長刻意「取消支援/改成無」) → 採用本地，讓取消能生效。無時間戳(舊資料)→採用本地。
        const dt = d.supportUpdatedAt || '', rt = r.supportUpdatedAt || '';
        if(dt && dt > rt) return { ...r, supportEmp: d.supportEmp || '', approvalStatus: d.approvalStatus || '', claimedBy: d.claimedBy || '', supportUpdatedAt: dt };
        return r;
      });
      tx.set(docRef, { records: merged, ...(extra || {}) }, { merge: true });
    });
  } catch(e) {
    // 交易失敗(多半離線/網路)→ 退回一般寫入(可離線佇列)，保 offline 可用；離線時本就無跨店併發，覆蓋風險極低
    await docRef.set({ records: localRecords || [], ...(extra || {}) }, { merge: true });
  }
}

async function saveScheduleData(isManual) {
  syncUIToMemory();
  lbRenderBar(); // 改了班 → 本月工時燈號跟著更新（用剛同步的記憶體資料，不重讀）
  const store = document.getElementById('storeSelector').value;
  const weekStr = document.getElementById('weekSelector').value;
  if(!store || !weekStr) return;
  try {
    const schedule = appData.records.filter(r => r.week === weekStr);
    const pd = weekPublishData[weekStr] || {};
    let extra = {};
    if(pd.published || isAutoPublished(weekStr)) {
      extra = {
        publishedAt: new Date().toISOString(),
        publishedBy: currentUser.displayName || currentUser.empName
      };
      weekPublishData[weekStr] = { ...weekPublishData[weekStr], ...extra };
      updatePublishBtn(store, weekStr);
    }
    await saveWeekRecordsMerged(store, weekStr, schedule, extra);
    setSyncStatus('ok', `已儲存 ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`);
    if(isManual) showToast('💾 儲存成功！');
  } catch(e) {
    setSyncStatus('err', '儲存失敗');
    showToast('❌ 儲存失敗：' + e.message);
  }
}

// 換週/換店前：取消待觸發的自動存檔，並把「目前畫面所屬的週」先存好（依格子自己的週，避免跨週覆蓋）
async function flushCurrentWeek(storeOverride) {
  clearTimeout(autoSaveTimer); // 關鍵：取消 debounce 中的 autosave，否則它會在換週/換店後以新目標存到舊畫面
  const cell = document.querySelector('.cell-btn');
  const domWeek = cell ? cell.dataset.week : null;
  if(!domWeek) return;
  syncUIToMemory(); // 以每格自己的 week 正確寫回記憶
  const store = storeOverride || loadedStore || document.getElementById('storeSelector').value;
  if(!store) return;
  if(typeof canScheduleStore === 'function' && !canScheduleStore(store)) return; // 只寫使用者可排班的門市，唯讀他店不寫
  try {
    const schedule = appData.records.filter(r => r.week === domWeek);
    await saveWeekRecordsMerged(store, domWeek, schedule, null);
    setSyncStatus('ok', '已儲存');
  } catch(e) { console.error('換週前存檔失敗', e); }
}

// ===== 班別 Modal =====
// 註：舊的 openShiftModal()／saveShiftModal() 已於 2026-08-09 移除。
// 兩者皆無任何呼叫者（含 HTML 屬性與動態呼叫），且僅它們使用 currentBtn；
// 現行流程走 handleCellClick() → openModal('shiftModal') → applyShift()。


// ===== 操作紀錄 =====
async function loadLogs() {
  const el = document.getElementById('logContent');
  if(!el) return;
  const store = document.getElementById('storeSelector').value;
  const weekStr = document.getElementById('weekSelector').value;
  el.innerHTML = '載入中...';
  try {
    // 取得本週七天的日期範圍
    const dates = getWeekDates(weekStr); // ['M/D', ...]
    const year  = parseInt(weekStr.split('-W')[0]);
    const dateStrs = dates.map(md => {
      const [m, d] = md.split('/');
      return `${year}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    });
    const [startDate, endDate] = [dateStrs[0], dateStrs[6]];

    // 讀 leaveRequests（不需索引：直接讀全部，JS 端過濾日期範圍）
    const lrSnapAll = await window.db.collection('stores').doc(store)
      .collection('leaveRequests').get().catch(() => null);

    const typeLabel = { off:'排休', annual:'特休', comp:'補休' };
    const statusLabel = { pending:'申請中', noted:'已核', cancelled:'已取消', unfulfilled:'未實現' };
    const shiftLabel = { full:'', morning:' 早班', evening:' 晚班' };

    const logs = [];
    if(lrSnapAll) {
      lrSnapAll.forEach(d => {
        const r = d.data();
        if(r.date < startDate || r.date > endDate) return; // JS 端過濾
        const name = r.empName || '--';
        const type = typeLabel[r.type] || r.type;
        const shift = shiftLabel[r.shift] || '';
        const status = statusLabel[r.status] || r.status;
        const dateObj = new Date(r.date);
        const dateLabel = `${dateObj.getMonth()+1}/${dateObj.getDate()}`;
        const dow = ['日','一','二','三','四','五','六'][dateObj.getDay()];
        const createdAt = r.createdAt ? r.createdAt.substring(0,10) : '';
        logs.push({ date: r.date, msg:
          `<span style="color:var(--text-muted);font-size:11px;">${dateLabel}(${dow})</span>　` +
          `<strong>${name}</strong>　${type}${shift}　` +
          `<span style="background:${r.status==='noted'?'#e8f5e9':r.status==='cancelled'?'#fce8e6':'#fff3e0'};` +
          `color:${r.status==='noted'?'#2e7d32':r.status==='cancelled'?'var(--danger)':'#e65100'};` +
          `padding:1px 7px;border-radius:10px;font-size:11px;font-weight:700;">${status}</span>` +
          (r.note ? `　<span style="font-size:11px;color:var(--text-muted);">${r.note}</span>` : '') +
          (createdAt ? `　<span style="font-size:10px;color:#ccc;">${createdAt}申請</span>` : '')
        });
      });
    }

    // 手動按日期排序（取代原本的 orderBy）
    logs.sort((a, b) => a.date.localeCompare(b.date));
    if(!logs.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px 0;">本週尚無紀錄</div>';
    } else {
      el.innerHTML = logs.map(l=>`<div class="log-item">${l.msg}</div>`).join('');
    }
  } catch(e) { el.innerHTML = `<div style="color:var(--danger);">讀取失敗：${e.message}</div>`; }
}

// ===== 資料載入 =====
async function fetchAllStoreData() {
  const store = document.getElementById('storeSelector').value;
  const weekStr = document.getElementById('weekSelector').value;
  if(!store || !weekStr) return;
  loadedStore = store; // 記住目前載入的門市，供換店前 flush 舊門市用

  localStorage.setItem('lastStore', store);
  document.getElementById('headerStoreBadge').textContent = store;
  setSyncStatus('syncing', '同步中...');
  historyEditUnlocked = false; // 切換門市或重新載入時重置解鎖狀態

  // 店長切換到非本店時，工具列改為唯讀提示
  const isMyStore = canScheduleStore(store);
  const toolBar = document.getElementById('adminToolBar');
  if(toolBar) {
    toolBar.style.opacity = isMyStore ? '1' : '0.4';
    toolBar.style.pointerEvents = isMyStore ? 'auto' : 'none';
  }
  const readonlyBanner = document.getElementById('readonlyBanner');
  if(readonlyBanner) readonlyBanner.style.display = isMyStore ? 'none' : 'flex';

  appData.allStoresRecords = [];
  appData.allStoresEmployees = {};

  showLoading('讀取班表資料...');
  try {
    // ✅ 計算「目前選取週次所在月份」涵蓋的所有週次供月統計使用
    // 例：查 6/19 那週（2026-W25），就讀 6 月的所有週次
    const weekMon = weekStringToDate(weekStr);
    const schedYr = weekMon.getFullYear();
    const schedMo = weekMon.getMonth(); // 0-indexed
    const currentMonthStr = `${schedYr}-${String(schedMo+1).padStart(2,'0')}`;

    // 收集班表週次所在月份的所有週次
    const monthWeeks = new Set([weekStr]); // 當前班表週一定要讀（顯示用）
    const daysInMonth = new Date(schedYr, schedMo+1, 0).getDate();
    for(let d = 1; d <= daysInMonth; d++) monthWeeks.add(weekStrOfDate(new Date(schedYr, schedMo, d)));

    // 平行讀取：本店員工 + 本週班表 + 跨店支援（其他店本週）+ displayName + 班別設定
    const [mainEmpSnap, mainWeekSnap, cfgSnap, accSnap] = await Promise.all([
      window.db.collection('stores').doc(store).collection('employees').get(),
      window.db.collection('stores').doc(store).collection('weeks').doc(weekStr).get(),
      window.db.collection('stores').doc(store).collection('config').doc('shifts').get().catch(()=>null),
      window.db.collection('account').where('store','==',store).get().catch(()=>null)
    ]);

    // 員工名單
    appData.employees = [];
    const mainWeekRecs = (mainWeekSnap.exists && mainWeekSnap.data().records) ? mainWeekSnap.data().records : [];
    const scheduledNames = mainWeekRecs.filter(r => r.shift && r.shift !== '').map(r=>r.name);

    // ✅ 排班系統生效日用「下週一」判斷
    const todaySched = new Date(); todaySched.setHours(0,0,0,0);
    const dow = todaySched.getDay() || 7;
    const nextMon = new Date(todaySched); nextMon.setDate(todaySched.getDate() + (8 - dow));
    const nextMonStr = `${nextMon.getFullYear()}-${String(nextMon.getMonth()+1).padStart(2,'0')}-${String(nextMon.getDate()).padStart(2,'0')}`;

    // ✅ 調職顯示邏輯：
    // - 已發布的週：一律正常顯示
    // - 未發布，transferDate 當週：顯示＋標注（已調職）
    // - 未發布，transferDate 之後：隱藏
    const isPublished = mainWeekSnap.exists && (mainWeekSnap.data().published || false);
    const weekMonStr = getWeekMondayStr(weekStr);
    const weekSunStr = getWeekSundayStr(weekStr);

    mainEmpSnap.forEach(d => {
      const data = d.data();
      const status = data.status;

      // 正常員工：直接顯示
      if(!['離職','調走'].includes(status)) {
        const dep = data.departDate, st = data.startDate;
        // 曾離開又回任（dep 離開日 < st 回任日）
        if(dep && st && dep < st) {
          if(weekMonStr >= st) appData.employees.push({ name: d.id, ...data });                 // 回任後：正常顯示
          else if(weekSunStr < dep) appData.employees.push({ name: d.id, ...data });             // 首次離開前：原本就在
          else if(dep >= weekMonStr && dep <= weekSunStr) appData.employees.push({ name: d.id, ...data, _transferThisWeek: true }); // 離開那週：已調職
          // 離開後、回任前：隱藏
          return;
        }
        // 一般在職：尚未到職（整週都早於 startDate）→ 不顯示（含調入過渡期）
        if(st && weekSunStr < st) return;
        appData.employees.push({ name: d.id, ...data });
        return;
      }

      // 離職：離職日「當週及之前」仍顯示（該週離職日起的格子由 buildCellButton 鎖死）；
      //       離職日之後的整週 → 隱藏。無 retireDate 則比照原本永遠隱藏。
      if(status === '離職') {
        const rd = data.retireDate;
        if(rd && weekMonStr < rd) appData.employees.push({ name: d.id, ...data });
        return;
      }

      // 調走：依 transferDate 判斷
      const effectDate = data.transferDate;
      if(!effectDate) return; // 沒有生效日視為已生效，隱藏

      if(isPublished && effectDate >= weekMonStr) {
        // 已發布的週：只顯示本週或之後才調走的員工（本週前已調走者不顯示）
        appData.employees.push({ name: d.id, ...data });
      } else if(effectDate > weekSunStr) {
        // transferDate 在本週之後：正常顯示
        appData.employees.push({ name: d.id, ...data });
      } else if(effectDate >= weekMonStr && effectDate <= weekSunStr) {
        // transferDate 在本週：顯示＋標注（已調職）
        appData.employees.push({ name: d.id, ...data, _transferThisWeek: true });
      }
      // transferDate 已過本週：隱藏
    });
    appData.employees.sort((a,b) => (a.sortKey||0)-(b.sortKey||0));

    // displayName 對應表
    appData.displayNameMap = {};
    if(accSnap) accSnap.forEach(d => {
      const acc = d.data();
      if(acc.empName && acc.displayName) appData.displayNameMap[acc.empName] = acc.displayName;
    });

    // 班別設定
    if(cfgSnap && cfgSnap.exists) {
      const cfg = cfgSnap.data();
      appConfig.shifts = cfg.shifts || appConfig.shifts;
      appConfig.shiftHours = cfg.shiftHours || appConfig.shiftHours;
      appConfig.quickNotes = cfg.quickNotes || appConfig.quickNotes;
    }

    // 讀取本店當月所有週次 + 其他店本週（跨店支援用）
    appData.allStoresRecords = [];
    appData.crossStoreGaps = []; // 其他店「開放中的待補缺口」→ 決定「請求支援」按鈕是否顯示
    const otherStores = (appConfig.stores||[]).filter(s => s !== store);

    const allFetches = [];
    // 本店當月週次
    [...monthWeeks].forEach(wk => {
      allFetches.push(
        window.db.collection('stores').doc(store).collection('weeks').doc(wk).get()
          .then(snap => { if(snap.exists && snap.data().records) snap.data().records.forEach(r => appData.allStoresRecords.push({...r,_store:store,week:wk})); })
          .catch(()=>{})
      );
    });
    // 其他店員工名單 + 本月所有週次班表（跨店支援用）
    // ✅ 修正：doc(s) 讀其他店；同時讀本月每週而非只讀當週，確保月累計工時正確
    otherStores.forEach(s => {
      allFetches.push(
        window.db.collection('stores').doc(s).collection('employees').get()
          .then(snap => {
            const emps=[];
            snap.forEach(d=>{ if(!['離職','調走'].includes(d.data().status)) emps.push(d.id); });
            appData.allStoresEmployees[s]=emps;
          })
          .catch(()=>{})
      );
      // ✅ 讀其他門市的 displayName，補入 displayNameMap
      allFetches.push(
        window.db.collection('account').where('store','==',s).get()
          .then(snap => {
            snap.forEach(d => {
              const acc = d.data();
              if(acc.empName && acc.displayName) appData.displayNameMap[acc.empName] = acc.displayName;
            });
          })
          .catch(()=>{})
      );
      // 讀其他店「本月所有週次」，只取有支援本店員工的記錄（含 pending + approved）
      [...monthWeeks].forEach(wk => {
        allFetches.push(
          window.db.collection('stores').doc(s).collection('weeks').doc(wk).get()
            .then(snap => {
              if(snap.exists && snap.data().records) {
                const _recs = snap.data().records;
                _recs
                  // ✅ 同時讀：supportEmp 指向本店(pending/approved) + 他店 location=支援本店(loc-based 來支援)
                  .filter(r =>
                    (r.supportEmp && r.supportEmp.startsWith(store + '-') && (r.approvalStatus === 'approved' || r.approvalStatus === 'pending'))
                    || (r.location === '支援' + store && r.shift && !['排休','指休','特休','補休','清空'].includes(r.shift))
                  )
                  .forEach(r => appData.allStoresRecords.push({...r, _store:s, week:wk}));
                // 收集他店開放中的待補缺口（有班別、未指定/未認領）
                _recs.forEach(r => {
                  if(String(r.name||'').startsWith('🆘待補') && r.shift
                     && !['排休','指休','特休','補休','清空',''].includes(String(r.shift).trim()) && !r.supportEmp)
                    appData.crossStoreGaps.push({ store:s, week:wk, name:r.name, day:r.day, shift:r.shift, note:r.note||'' });
                });
              }
            })
            .catch(()=>{})
        );
      });
    });

    await Promise.all(allFetches);

    // 去重：allStoresRecords 也移除完全相同的重複（含 _store），避免週時/月時被重複灌大（如 W28）
    {
      const _seenAll = new Set();
      appData.allStoresRecords = appData.allStoresRecords.filter(r => {
        const k = [r._store, r.name, r.day, r.week, r.shift, r.location, r.supportEmp, r.note].join('|');
        if(_seenAll.has(k)) return false; _seenAll.add(k); return true;
      });
    }

    // 本月薪資記錄（供本週總計人力成本估算用）
    appData.salaryRecData = {};
    try {
      const salSnap = await window.db.collection('stores').doc(store).collection('salary').doc(currentMonthStr).get();
      if(salSnap.exists) {
        (salSnap.data().records || []).forEach(r => {
          if(r.empName) appData.salaryRecData[r.empName] = r;
        });
      }
    } catch(e) {}

    // leaveRequests: 讀本週七天（改用 store 單欄索引 + JS 端過濾日期，不需複合索引）
    try {
      const wMon = weekStringToDate(weekStr);
      const wSun = new Date(wMon); wSun.setDate(wMon.getDate() + 6);
      const pad = n => String(n).padStart(2,"0");
      const dateFrom = wMon.getFullYear()+"-"+pad(wMon.getMonth()+1)+"-"+pad(wMon.getDate());
      const dateTo   = wSun.getFullYear()+"-"+pad(wSun.getMonth()+1)+"-"+pad(wSun.getDate());
      // 不加任何 where 條件，直接讀整個子集合再 JS 過濾日期（不需任何索引）
      const lrSnap = await window.db.collection("stores").doc(store).collection("leaveRequests").get();
      appData.leaveRequests = [];
      lrSnap.forEach(d => {
        const r = d.data();
        if(r.date >= dateFrom && r.date <= dateTo)
          appData.leaveRequests.push({ id: d.id, ...r });
      });
      console.log('[leaveRequests] loaded:', appData.leaveRequests.length, 'records for', dateFrom, '~', dateTo);
    } catch(e) {
      console.error('[leaveRequests] 讀取失敗:', e.message);
      appData.leaveRequests = [];
    }

    // 劃休配額（供排班時顯示順位 M/N）
    try {
      const lqSnap = await window.db.collection('stores').doc(store).collection('config').doc('shifts').get();
      appData.leaveQuota = (lqSnap.exists && lqSnap.data().leaveQuota) || { fullTime:2, partTime:1 };
    } catch(e) { appData.leaveQuota = { fullTime:2, partTime:1 }; }

    appData.allStoresEmployees[store] = appData.employees.map(e=>e.name);
    appData.records = appData.allStoresRecords.filter(r => r._store === store);
    // 去重：移除完全相同的重複記錄（同 name/day/week/shift/loc/support）→ 顯示正確，存檔即淨化 DB
    {
      const _seenRec = new Set();
      appData.records = appData.records.filter(r => {
        const k = [r.name, r.day, r.week, r.shift, r.location, r.supportEmp, r.note].join('|');
        if(_seenRec.has(k)) return false; _seenRec.add(k); return true;
      });
    }
    virtualRowNames = [...new Set(mainWeekRecs.map(r=>r.name).filter(n=>n&&n.startsWith('🆘')))];

    // 發布狀態
    await fetchPublishStatus(store, weekStr);

    // 唯讀提示
    const curStore = document.getElementById('storeSelector').value;
    const isReadonlyStore = (currentUser.permission === 'manager' && curStore !== currentUser.store);
    const pubBtn = document.getElementById('publishBtn');
    if(pubBtn) pubBtn.style.display = isReadonlyStore ? 'none' : 'flex';

    let roBar = document.getElementById('readonlyBar');
    if(isReadonlyStore) {
      if(!roBar) {
        roBar = document.createElement('div');
        roBar.id = 'readonlyBar';
        roBar.style.cssText = 'background:#fff3e0;color:#e65100;font-size:12px;font-weight:700;text-align:center;padding:6px;border-bottom:1px solid #ffcc80;';
        document.getElementById('adminView').insertBefore(roBar, document.querySelector('.week-bar'));
      }
      roBar.textContent = `👁️ 目前查看 ${curStore}（唯讀，無法編輯）`;
      roBar.style.display = 'block';
    } else {
      if(roBar) roBar.style.display = 'none';
    }

    renderSupportDropdown();
    renderSchedule();
    updateCrossGapBtn();
    setSyncStatus('ok', '已同步');
  } catch(e) {
    setSyncStatus('err', '同步失敗');
    showToast('❌ 讀取失敗：' + e.message);
    console.error(e);
  }
  hideLoading();
}

function updateHeaderInfo() {
  if(!currentUser) return;
  const PERM_LABELS = {
    'employee':'員工', 'manager':'店長',
    'owner':'加盟主', 'admin':'系統管理者'
  };
  const name = currentUser.displayName || currentUser.empName || currentUser.username || '';
  const permText = PERM_LABELS[currentUser.permission] || currentUser.permission || '';
  const storeText = currentUser.store || '全門市';
  const el = document.getElementById('headerUserInfo');
  if(el) el.textContent = name ? `${name}・${permText}・${storeText}` : `${permText}・${storeText}`;
}
