// 排班頁之四：員工視角（我的班表、劃休申請、支援下拉、核准顯示）。2026-10-16 從 schedule-v2-page.js 原封不動切出來（整理第 4 階段）。

// ===== 員工視角 =====
// 查閱模式門市切換（店長以上）
async function onEmpStoreChange() {
  empWeekStr = getCurrentWeekString();
  updateEmpWeekLabel();
  await loadEmpView();
}

function empChangeWeek(offset) {
  const p = empWeekStr.split('-W');
  let yr = parseInt(p[0]), wk = parseInt(p[1]);
  wk += offset;
  if(wk < 1) { yr--; wk = weeksInYear(yr); }
  if(wk > weeksInYear(yr)) { yr++; wk = 1; }
  const newWeekStr = `${yr}-W${wk < 10 ? '0'+wk : wk}`;
  const perm = currentUser?.permission || 'employee';
  const isOwnerAdmin = ['owner','admin'].includes(perm);

  // ===== 往前限制：最多到上個月 =====
  if(offset < 0 && !isOwnerAdmin) {
    const now = new Date();
    const limitMonth = now.getMonth() === 0
      ? `${now.getFullYear()-1}-12`
      : `${now.getFullYear()}-${String(now.getMonth()).padStart(2,'0')}`;
    const newDates = getWeekDates(newWeekStr);
    const newYr = newWeekStr.split('-W')[0];
    const weekMonths = newDates.map(d => {
      const mo = d.split('/')[0].padStart(2,'0');
      return `${newYr}-${mo}`;
    });
    if(!weekMonths.some(m => m >= limitMonth)) {
      showToast('⚠️ 最多只能查閱上個月的班表');
      return;
    }
  }

  // ===== 往後限制 =====
  if(offset > 0) {
    // 計算下下週的週字串
    const curWeekStr = getCurrentWeekString();
    const cp = curWeekStr.split('-W');
    let cy = parseInt(cp[0]), cw = parseInt(cp[1]);
    // 最大週次：加盟主/管理者→下下週，員工/店長→下下週（皆同）
    const maxOffset = isOwnerAdmin ? 2 : 2;
    let maxW = cw + maxOffset, maxY = cy;
    if(maxW > weeksInYear(maxY)) { maxW -= weeksInYear(maxY); maxY++; }
    const maxWeekStr = `${maxY}-W${maxW < 10 ? '0'+maxW : maxW}`;
    if(newWeekStr > maxWeekStr) {
      showToast('⚠️ 最多只能查閱到下下週');
      return;
    }
  }

  empWeekStr = newWeekStr;
  updateEmpWeekLabel();
  loadEmpView();
}

function updateEmpWeekLabel() {
  document.getElementById('empWeekLabel').textContent = weekLabelFromStr(empWeekStr);
}

async function loadEmpView() {
  // ✅ 查閱模式讀 empStoreSelector，排班模式讀 storeSelector
  const empStoreSel = document.getElementById('empStoreSelector');
  const adminStoreSel = document.getElementById('storeSelector');
  const store = (empStoreSel?.value) || (adminStoreSel?.value) || currentUser.store;
  if(!store) return;

  showLoading('載入班表...');

  const infoCard = document.getElementById('publishInfoCard');
  const notPubCard = document.getElementById('notPublishedCard');
  const imgWrap = document.getElementById('scheduleImgWrap');
  try {
    // 平行讀取：班表 + 員工名單 + 其他門市本週記錄 + displayName（跨店支援用）
    const otherStores = (appConfig.stores || []).filter(s => s !== store);
    const [weekSnap, empSnap, accSnap, ...otherSnaps] = await Promise.all([
      window.db.collection('stores').doc(store).collection('weeks').doc(empWeekStr).get(),
      window.db.collection('stores').doc(store).collection('employees').get(),
      window.db.collection('account').where('store','==',store).get().catch(()=>null),
      ...otherStores.map(s =>
        window.db.collection('stores').doc(s).collection('weeks').doc(empWeekStr).get()
          .catch(() => null)
      )
    ]);

    // ✅ 建立 displayNameMap（員工視角也需要顯示正確姓名）
    appData.displayNameMap = {};
    if(accSnap) accSnap.forEach(d => {
      const acc = d.data();
      if(acc.empName && acc.displayName) appData.displayNameMap[acc.empName] = acc.displayName;
    });

    const data = weekSnap.exists ? weekSnap.data() : {};
    const records = data.records || [];
    const published = data.published || false;
    const publishedAt = data.publishedAt || null;
    const isVisible = published || isAutoPublished(empWeekStr);

    if(isVisible) {
      infoCard.style.display = 'block';
      notPubCard.style.display = 'none';
      imgWrap.style.display = 'block';

      document.getElementById('publishInfoTitle').textContent = `📅 ${weekLabelFromStr(empWeekStr)} 班表`;
      if(publishedAt) {
        const d = new Date(publishedAt);
        document.getElementById('publishInfoTime').textContent =
          `最後更新：${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')} · ${data.publishedBy || ''}`;
      } else {
        document.getElementById('publishInfoTime').textContent = '已自動發布（週五後自動公開）';
      }

      let emps = [];
      // ✅ 員工視角 transferDate 判斷（與管理員視角邏輯一致）
      const empViewPublished = weekSnap.exists && (weekSnap.data().published || false);
      const evWeekMonStr = getWeekMondayStr(empWeekStr);
      const evWeekSunStr = getWeekSundayStr(empWeekStr);
      empSnap.forEach(d => {
        const data = d.data();
        const status = data.status;
        if(!['離職','調走'].includes(status)) {
          const dep = data.departDate, st = data.startDate;
          if(dep && st && dep < st) {
            if(evWeekMonStr >= st) emps.push({ name: d.id, ...data });
            else if(evWeekSunStr < dep) emps.push({ name: d.id, ...data });
            else if(dep >= evWeekMonStr && dep <= evWeekSunStr) emps.push({ name: d.id, ...data, _transferThisWeek: true });
            return;
          }
          if(st && evWeekSunStr < st) return; // 尚未到職 → 不顯示
          emps.push({ name: d.id, ...data }); return;
        }

        // 離職：永遠隱藏
        if(status === '離職') return;

        // 調走：依 transferDate 判斷
        const effectDate = data.transferDate;
        if(!effectDate) return;

        if(empViewPublished && effectDate >= evWeekMonStr) {
          emps.push({ name: d.id, ...data });
        } else if(effectDate > evWeekSunStr) {
          emps.push({ name: d.id, ...data });
        } else if(effectDate >= evWeekMonStr && effectDate <= evWeekSunStr) {
          emps.push({ name: d.id, ...data, _transferThisWeek: true });
        }
        // 已過調職日：隱藏
      });
      emps.sort((a,b) => (a.sortKey||0) - (b.sortKey||0));

      // ✅ 收集其他門市的支援記錄（supportEmp 指向本店 且 approved）
      const supportRecords = []; // 格式與本店 records 一致
      const supportEmpsAdded = new Set(); // 避免重複加入員工列

      otherSnaps.forEach((snap, idx) => {
        if(!snap || !snap.exists) return;
        const fromStore = otherStores[idx];
        (snap.data().records || []).forEach(r => {
          // 找出「要來本店支援」且已核准的記錄
          if(r.supportEmp === `${store}-${r.name}` && r.approvalStatus === 'approved') {
            // 把這筆記錄轉換成本店視角：name 就是支援者本人
            supportRecords.push({ ...r, _fromStore: fromStore });
            supportEmpsAdded.add(`${fromStore}-${r.name}`);
          }
        });
      });

      // ✅ 把支援人員加入員工列（如果本店沒有這個人）
      const supportEmpObjs = [];
      supportEmpsAdded.forEach(key => {
        const [fromStore, empName] = key.split('-');
        if(!emps.find(e => e.name === empName)) {
          supportEmpObjs.push({
            name: empName,
            _isSupport: true,
            _fromStore: fromStore,
            sortKey: 9999
          });
        }
      });

      // 支援人員排在本店員工後面
      const allEmps = [...emps, ...supportEmpObjs];

      // ✅ 合併 records：本店記錄 + 支援者在本店的班別記錄
      // 支援者的記錄以 supportRecords 為主（因為班別存在對方門市）
      const mergedRecords = [...records];
      supportRecords.forEach(sr => {
        // 只有在 mergedRecords 沒有這個人這天的記錄時才加
        const exists = mergedRecords.find(r => r.name === sr.name && r.day === sr.day);
        if(!exists) {
          mergedRecords.push({
            name: sr.name,
            day: sr.day,
            week: sr.week,
            shift: sr.shift,
            location: `來自${sr._fromStore}`,
            note: sr.note || '',
            actualHours: sr.actualHours || 0,
            isOT: sr.isOT || false,
            supportEmp: '',
            approvalStatus: 'approved',
            requestOff: false
          });
        }
      });

      // 跨店記錄：供產圖顯示「本店員工去他店支援」（他店🆘待補格 supportEmp='{本店}-{員工}' approved）
      const crossRecs = [];
      otherSnaps.forEach((snap, idx) => {
        if(!snap || !snap.exists) return;
        const os = otherStores[idx];
        (snap.data().records || []).forEach(r => crossRecs.push({ ...r, _store: os, week: empWeekStr }));
      });
      renderEmpCanvas(store, empWeekStr, records, emps, [...records, ...crossRecs]);
    } else {
      infoCard.style.display = 'none';
      notPubCard.style.display = 'block';
      imgWrap.style.display = 'none';
    }
  } catch(e) {
    showToast('載入失敗：' + e.message);
    infoCard.style.display = 'none';
    notPubCard.style.display = 'block';
    imgWrap.style.display = 'none';
  }
  hideLoading();
}

function renderEmpCanvas(store, weekStr, records, emps, allRecs) {
  const canvas = document.getElementById('scheduleCanvas');
  const dates = getWeekDates(weekStr);
  // 加入 virtual rows（🆘 緊急人力），與店長產圖保持一致
  const virtualRows = [...new Set(records.map(r=>r.name).filter(n=>n&&n.startsWith('🆘')))];
  const allEmpsWithVirtual = [...emps];
  virtualRows.forEach(n => { if(!allEmpsWithVirtual.find(e=>e.name===n)) allEmpsWithVirtual.push({ name:n, role:'待補' }); });
  drawScheduleCanvas(canvas, store, weekStr, records, allEmpsWithVirtual, dates, allRecs || records);
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
}


// ===== 渲染班表（管理者）=====
function renderSupportDropdown() {
  const myStore = document.getElementById('storeSelector').value;
  let html = `<option value="">-- 無（顯示橘色待補）--</option>`;
  for(const s in appData.allStoresEmployees) {
    if(s !== myStore) {
      html += `<optgroup label="[${s}]">`;
      // ✅ 顯示 displayName，value 保持原始 empName 供系統識別
      appData.allStoresEmployees[s].forEach(emp => html += `<option value="${s}-${emp}">${getDisplayName(emp)}</option>`);
      html += `</optgroup>`;
    }
  }
  const sel = document.getElementById('modalSupportEmp');
  if(sel) sel.innerHTML = html;

  // 只保留「本店」：不再提供把自己人主動排到別店（那會讓被支援店沒有紀錄）。
  // 跨店支援一律走「待補格 + 指定支援人員(申請/審核)」或「開缺口→別店認領」，記錄都存在被支援店。
  document.getElementById('modalLocation').innerHTML = `<option value="本店">本店</option>`;
}

function toggleApprovalVis() {
  const val = document.getElementById('modalSupportEmp').value;
  document.getElementById('modalApproval').style.display = val ? 'block' : 'none';
}

