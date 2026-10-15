// 首頁之六：回到前景自動重讀、待處理事項（loadPendingItems）、已離職員工、前往排班。2026-10-16 從 home-page.js 原封不動切出來（整理第 4 階段）。

// ===== 待處理事項（店長以上 + 員工自身代辦）=====
// ===== 回到首頁時重新整理待處理（2026-10-10，使用者回報「要關掉再打開才會更新」）=====
// 原本只在 window.onload 讀一次。從主畫面 App 切回來、或從其他頁按返回（bfcache）都不會重新載入頁面，
// 待處理清單、紅點、各種提醒就停在舊的。回到前景時重讀；30 秒內不重複（省讀取）。
// ⚠️ Firestore SDK 沒有逾時（見記憶 reference_firestore_no_timeout）：一定要 race 逾時並清旗標，
//    否則一次卡住就永遠不會再更新。
let _homeRefreshAt = Date.now(), _homeRefreshing = false;
async function refreshHomeLive(force) {
  if(!currentUser || _homeRefreshing) return;
  if(!force && Date.now() - _homeRefreshAt < 30000) return;
  _homeRefreshing = true; _homeRefreshAt = Date.now();
  try {
    await Promise.race([loadPendingItems(), new Promise(res => setTimeout(res, 15000))]);
  } catch(e) { console.warn('首頁重新整理失敗', e); }
  finally { _homeRefreshing = false; }
  checkSalaryAck(); checkPnlPending(); checkPnlAnomaly(); checkLeaveHint();
  loadStats().catch(() => {});
  if (typeof hgLoad === 'function') hgLoad();
  if (typeof hdLoad === 'function') hdLoad();
}
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') refreshHomeLive(false); });
window.addEventListener('pageshow', e => { if(e.persisted) refreshHomeLive(true); });   // 從其他頁按返回

async function loadPendingItems() {
  const weekStr = getCurrentWeekString();
  const nextWeek = getNextWeekString();
  let pending = [];

  const storesToScan = currentUser.store ? [currentUser.store] : (appConfig.stores || []);
  const currentYear = new Date().getFullYear().toString();

  // Timeout 保護：超時不拋錯，直接繼續（避免 catch 吃掉 todo/公告）
  const withTimeout = (promise, ms = 8000) => {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), ms))
    ]);
  };

  // ===== 管理員待處理（店長以上）=====
  try {
    if(canSchedule()) {
      const storePromises = storesToScan.map(async (store) => {
        let storePending = [];

        const weekPromises = [weekStr, nextWeek].map(wk =>
          window.db.collection('stores').doc(store).collection('weeks').doc(wk).get().catch(() => null)
        );
        const empSnapPromise = window.db.collection('stores').doc(store).collection('employees').get().catch(() => null);
        const now = new Date();
        const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
        const isLastWeek = now.getDate() > lastDay - 7;
        const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
        const salaryPromise = isLastWeek
          ? window.db.collection('stores').doc(store).collection('salary').doc(ym).get().catch(() => null)
          : Promise.resolve(null);

        const [weekSnaps, empSnap, salSnap] = await Promise.race([
          Promise.all([Promise.all(weekPromises), empSnapPromise, salaryPromise]),
          new Promise(res => setTimeout(() => res([[],null,null]), 6000))
        ]);

        // 班表審核
        (weekSnaps||[]).forEach(snap => {
          if(!snap?.exists) return;
          snap.data().records?.forEach(r => {
            if(r.requestOff && r.shift && r.shift !== '排休' && r.shift !== '指休') {
              storePending.push({ type:'畫休衝突', desc:`${store}｜${r.name} 在 ${r.day} 有畫休衝突`, link:'schedule-V2.html?mode=admin', color:'var(--danger)' });
            }
          });
        });

        // 薪資提醒
        if(salSnap?.exists && salSnap.data().status === 'draft') {
          storePending.push({ type:'薪資提醒', desc:`${ym.replace('-','年')}月薪資尚未送出`, link:'salary.html', color:'var(--warn)' });
        }

        // ===== 出勤待審核（補登/修改申請、加班待審、離線待核）=====
        try {
          const [reqSnap, otSnap, offSnap] = await Promise.all([
            window.db.collection('stores').doc(store).collection('attendanceRequests').where('status','==','pending').get().catch(()=>null),
            window.db.collection('stores').doc(store).collection('attendance').where('otStatus','==','pending').get().catch(()=>null),
            window.db.collection('stores').doc(store).collection('attendance').where('needReview','==',true).get().catch(()=>null),
          ]);
          const nReq = reqSnap ? reqSnap.size : 0;
          const nOt  = otSnap ? otSnap.docs.filter(d=>!d.data().voided).length : 0;
          const nOff = offSnap ? offSnap.docs.filter(d=>!d.data().voided).length : 0;
          const tot = nReq + nOt + nOff;
          if(tot > 0){
            const parts=[]; if(nReq)parts.push(`補登/修改 ${nReq}`); if(nOt)parts.push(`加班 ${nOt}`); if(nOff)parts.push(`離線待核 ${nOff}`);
            storePending.push({ type:'出勤待審核', desc:`${store}｜出勤待審 ${tot} 件（${parts.join('、')}）`, link:'attendance.html', color:'var(--danger)' });
          }
        } catch(e){}

        // ===== 特休 / 補休 週年提醒與到期提醒 =====
        if(empSnap) {
          const emps = [];
          empSnap.forEach(d => { if(!['離職','調走'].includes(d.data().status)) emps.push({ id:d.id, ...d.data() }); });

          const now = new Date();
          const todayStr = new Date(now - now.getTimezoneOffset()*60000).toISOString().split('T')[0]; // 本機日期（UTC 半夜會是昨天）
          const isDecember = now.getMonth() === 11;
          const thisYear = now.getFullYear();
          const prevYear = thisYear - 1;

          // 日期工具（home 頁面 inline，避免相依外部函式）
          const _dateAdd = (s, months) => { const d=new Date(s); d.setMonth(d.getMonth()+months); return d.toISOString().split('T')[0]; };
          const _isExpThisMonth = (ds) => { if(!ds) return false; const e=new Date(ds); return e.getFullYear()===now.getFullYear()&&e.getMonth()===now.getMonth(); };

          const leaveResults = await Promise.race([
            Promise.all(emps.map(async emp => {
              try {
                const [batchSnap, leaveLegacySnap, compSnap, compPrevSnap] = await Promise.all([
                  window.db.collection('employees').doc(emp.id).collection('leaveBatches').get(),
                  window.db.collection('employees').doc(emp.id).collection('leaves').doc(String(thisYear)).get(),
                  window.db.collection('employees').doc(emp.id).collection('comp').doc(String(thisYear)).get(),
                  window.db.collection('employees').doc(emp.id).collection('comp').doc(String(prevYear)).get()
                ]);
                const compAv = isDecember && typeof caCompAvailability === 'function' ? await caCompAvailability(emp.id).catch(() => null) : null;
                return { emp, batchSnap, leaveLegacySnap, compSnap, compPrevSnap, compAv };
              } catch(e) { return null; }
            })),
            new Promise(res => setTimeout(() => res([]), 8000))
          ]);

          leaveResults.forEach(item => {
            if(!item) return;
            const { emp, batchSnap, leaveLegacySnap, compSnap, compPrevSnap } = item;
            const empDisplayName = displayNameMap[emp.id] || emp.id;

            // === 取得到職日 ===
            let hireDate = null;
            const batches = [];
            if(batchSnap) batchSnap.forEach(d => batches.push({ id:d.id, ...d.data() }));
            batches.sort((a,b) => (a.grantDate||'').localeCompare(b.grantDate||''));
            if(batches.length > 0) {
              const firstBatch = batches[0];
              hireDate = firstBatch.grantDate ? _dateAdd(firstBatch.grantDate, -6) : null;
            }
            if(!hireDate && leaveLegacySnap?.exists) hireDate = leaveLegacySnap.data()?.hireDate || null;

            // === 1. 尚未建檔 ===
            if(!hireDate) {
              storePending.push({ type:'特休建檔', desc:`${store}｜請幫 ${empDisplayName} 設定到職日`, link:'leave.html', color:'var(--warn)' });
              return;
            }

            // === 2. 週年日提醒 ===
            // ⚠️ 2026-10-15：原本只在「剛好當天」提醒，那天沒人開 App 就永遠不再出現，批次只能手動新增 → 特休就漏了
            //    （查到 2 位正職 7/1 該新增的批次沒有）。正職改成：週年後 180 天內、還沒有對應批次（取得日差 31 天內）就一直提醒。
            //    工讀維持只在當天提醒（工讀幾乎都沒建特休批次，是否要追蹤待使用者決定）。
            const isPT = lvIsPayPartTime(emp);
            const hasBatchNear = d => batches.some(b => b.grantDate && Math.abs((new Date(b.grantDate) - new Date(d)) / 86400000) <= 31);
            const dueNow = d => isPT ? d === todayStr
              : (d <= todayStr && (new Date(todayStr) - new Date(d)) / 86400000 <= 180 && !hasBatchNear(d));
            const whenTxt = d => d === todayStr ? '今天' : `${+d.slice(5,7)}/${+d.slice(8,10)} 已`;
            // 滿6個月
            const m6Date = _dateAdd(hireDate, 6);
            if(dueNow(m6Date)) {
              storePending.push({ type:'特休週年', desc:`${store}｜${empDisplayName} ${whenTxt(m6Date)}滿6個月，請至特休管理新增批次（3天）`, link:'leave.html', color:'#9334e6' });
            }
            // 每個週年
            for(let yr = 1; yr <= 30; yr++) {
              const annivDate = _dateAdd(hireDate, yr * 12);
              if(annivDate > todayStr) break;
              if(dueNow(annivDate)) {
                const days = lvAnnualDays(yr * 12); // 規則在 leave-rules.js
                storePending.push({ type:'特休週年', desc:`${store}｜${empDisplayName} ${whenTxt(annivDate)}滿${yr}年，請至特休管理新增批次（${days}天）`, link:'leave.html', color:'#9334e6' });
              }
            }

            // === 3. 特休批次本月到期提醒 ===
            batches.forEach(b => {
              if(b.settled) return;
              const remaining = (b.days||0) - (b.used||0);
              if(remaining <= 0) return;
              const expDate = b.carried ? _dateAdd(b.expireDate, 12) : b.expireDate;
              if(_isExpThisMonth(expDate)) {
                const canCarry = !b.carried;
                storePending.push({
                  type:'特休到期',
                  desc:`${store}｜${empDisplayName} 的「${b.label||b.note}」剩 ${remaining} 天本月到期${canCarry?'，可結算或遞延':'，已無法遞延，請結算'}`,
                  link:'leave.html',
                  color:'var(--danger)'
                });
              }
            });

            // === 4. 補休本月（12月）到期提醒 ===
            if(isDecember) {
              // 本年度補休：取得／使用從帳本算（item.compAv＝comp-avail.js，2026-10-15；comp/{年}.earned/used 統計欄會漂）
              if(item.compAv || compSnap?.exists) {
                const cd = compSnap?.exists ? compSnap.data() : {};
                const remaining = item.compAv ? Math.max(0, item.compAv.earned - item.compAv.used) : Math.max(0, (cd.earned||0) - (cd.used||0));
                if(!cd.settled && remaining > 0) {
                  storePending.push({ type:'補休結算', desc:`${store}｜${empDisplayName} 本年度補休剩 ${remaining} 天，12/31 到期，請結算或遞延`, link:'leave.html', color:'var(--accent)' });
                }
              }
              // 遞延補休（不可再延）
              if(compPrevSnap?.exists) {
                const cpd = compPrevSnap.data();
                const carriedRemaining = cpd.carried && !cpd.settled ? Math.max(0,(cpd.earned||0)-(cpd.used||0)-(cpd.carriedUsed||0)) : 0;
                if(carriedRemaining > 0) {
                  storePending.push({ type:'補休結算', desc:`${store}｜${empDisplayName} ${prevYear}年遞延補休剩 ${carriedRemaining} 天，本月底到期且不可再延，請盡速結算`, link:'leave.html', color:'var(--danger)' });
                }
              }
            }
          });
        }
        return storePending;
      });

      const allResults = await Promise.race([
        Promise.all(storePromises),
        new Promise(res => setTimeout(() => res([]), 10000))
      ]);
      allResults.forEach(res => pending.push(...(res||[])));
    }
  } catch(e) {
    console.warn('管理員待處理讀取失敗:', e);
  }

  // ===== 代辦事項 + 公告橫幅（所有人）=====
  try {
    const _n = new Date(); const today = `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`;  // 本地日期（toISOString 是 UTC，台灣凌晨 0~8 點會算成前一天）
    const empName = currentUser.empName || '';
    const store   = currentUser.store || '';
    const isManagerRole = canSchedule();

    const [todoSnap, checkSnap] = await Promise.race([
      Promise.all([
        window.db.collection('todos').where('deleted','==',false).get(),
        window.db.collection('todoChecks').where('empName','==',empName).get()
      ]),
      new Promise(res => setTimeout(() => res([null, null]), 8000))
    ]);

    if(todoSnap) {
      const myChecks = {};
      checkSnap?.forEach(d => {
        const data=d.data();
        // 只認「當期」的 key；原本另外記 myChecks[todoId]，循環任務只要曾經完成過一次就永遠不再出現在首頁
        if(data.checked){ myChecks[data.checkKey||data.todoId]=true; }
      });

      const isTodoVisible = (t) => {
        if(t.deleted) return false;
        if(t.startDate && today < t.startDate) return false;
        if(t.isRecurring && t.recurringEnd && today > t.recurringEnd) return false;
        if(t.type==='announcement' && !t.isRecurring && t.endDate && today > t.endDate) return false;
        // 循環「公告」只在發生日當天顯示（如每月最後一天提醒），與 todo 頁一致，避免每天都出現
        if(t.isRecurring && t.type==='announcement' && trNextStr(t) !== today) return false;
        const tt = t.targetType;
        if(tt==='self') return t.createdBy === empName;
        if(tt==='all') return true;
        if(tt==='store') return t.targetStore===store || (t.targetStores||[]).includes(store);
        if(tt==='stores_manager') {
          if(!isManagerRole) return false;
          const s=t.targetStores||[];
          return s.length===0 || s.includes(store) || t.targetStore===store;
        }
        if(tt==='specific') return (t.targetEmps||[]).includes(empName);
        return false;
      };

      const announcements = [], pendingTodos = [];
      todoSnap.forEach(d => {
        const t = { id:d.id, ...d.data() };
        if(!isTodoVisible(t)) return;
        if(t.type==='announcement') { announcements.push(t); return; }
        const ck = trPeriodKey(t); // 當期 key（todo-recur.js，跟代辦頁同一份）
        if(myChecks[ck]) return;
        pendingTodos.push(t);
      });

      // 公告橫幅
      const bannerWrap = document.getElementById('announceBannerWrap');
      const banner     = document.getElementById('announceBanner');
      if(bannerWrap && banner) {
        if(announcements.length > 0) {
          bannerWrap.style.display = 'block';
          banner.innerHTML = announcements.map(t => {
            const days = t.endDate ? Math.ceil((new Date(t.endDate)-new Date())/86400000) : null;
            const dlText = days===null?'':days<0?'已截止':days===0?'今天截止':`${days}天後截止`;
            const urgent = days!==null && days<=2;
            return `<div onclick="window.location.href='todo.html'" style="flex-shrink:0;min-width:200px;max-width:260px;background:${urgent?'#fff3e0':'white'};border:1.5px solid ${urgent?'var(--warn)':'var(--border)'};border-radius:12px;padding:10px 12px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
              <div style="font-size:13px;font-weight:700;line-height:1.4;margin-bottom:4px;">${t.title}</div>
              ${t.note?`<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${t.note}</div>`:''}
              ${dlText?`<div style="font-size:10px;font-weight:700;color:${urgent?'var(--warn)':'var(--text-muted)'};">📅 ${dlText}</div>`:''}
            </div>`;
          }).join('');
        } else {
          bannerWrap.style.display = 'none';
        }
      }

      // 代辦加入待處理
      pendingTodos.forEach(t => {
        pending.push({ type:'代辦', desc:t.title, link:'todo.html', color:'var(--primary)' });
      });
    }
  } catch(e) {
    console.warn('代辦/公告讀取失敗:', e);
  }

  // ===== CITY手順（僅 admin）：待確認的同步變動、同步失敗、排程停擺 =====
  // 資料規則只讓 admin 讀 cityPending/cityMeta；筆數要數 cityPending 本身（cityMeta.pending 只在同步時更新）
  try {
    if(canSysConfig()) {
      const res = await withTimeout(Promise.all([
        window.db.collection('cityMeta').doc('sync').get(),
        window.db.collection('cityPending').get(),
      ]));
      if(res) {
        const [metaSnap, pendSnap] = res;
        const m = metaSnap.exists ? metaSnap.data() : null;
        const lastMs = m && m.lastRunAt && m.lastRunAt.toMillis ? m.lastRunAt.toMillis() : 0;
        if(m && !m.ok) {
          pending.push({ type:'CITY手順', desc:'每週同步失敗，點此查看原因', link:'city-admin.html', color:'var(--danger)' });
        } else if(lastMs && Date.now() - lastMs > 8 * 86400000) {
          // 排程每週一跑；超過 8 天沒紀錄＝排程停了但不會報錯
          pending.push({ type:'CITY手順', desc:`已經 ${Math.floor((Date.now()-lastMs)/86400000)} 天沒有同步，請檢查排程`, link:'city-admin.html', color:'var(--danger)' });
        }
        if(pendSnap.size > 0) {
          pending.push({ type:'CITY手順', desc:`${pendSnap.size} 筆變動待確認後發佈`, link:'city-admin.html', color:'var(--warn)' });
        }
      }
    }
  } catch(e) {
    console.warn('CITY手順待確認讀取失敗:', e);
  }

  // ===== 門市備忘（客訂／留貨，store-memo.js）=====
  // 使用者 2026-09-25 要求：跟代辦一樣列在待處理清單裡，但「不算件數」——不亮「待處理 N」膠囊、☰ 紅點、App 圖示紅點。
  // 所以另外放 memoRows，不進 pending。只看本人所屬門市的未結案單。
  const memoRows = [];
  try {
    const st = currentUser.store || '';
    if(st && typeof memoLoadOpen === 'function') {
      const ms = await withTimeout(memoLoadOpen(st));
      (ms || []).filter(m => m.status < 3)
        .sort((a, b) => (!!memoStale(b) - !!memoStale(a)) || (b.status - a.status))
        .forEach(m => {
          const stale = memoStale(m);
          memoRows.push({ type:'門市備忘', desc:`${memoEsc(memoTitle(m))}・${STORE_MEMO.STATUS[m.status]}${stale ? `・<span style="color:var(--danger);font-weight:800;">⚠️ ${stale.text}</span>` : ''}`,
            link:'todo.html', color: stale ? 'var(--danger)' : '#0f9d8a' });
        });
    }
    // 保證成團的團購（門市自己的貨）：一檔一行，點進代辦頁才逐人列出（2026-10-10 使用者）
    if(st && typeof memoLoadGb === 'function') {
      const gs = await withTimeout(memoLoadGb(st));
      (gs || []).forEach(g => {
        const w = memoGbWarn(g);
        memoRows.push({ type:'門市備忘', desc:`${memoEsc(memoGbTitle(g))}・${memoGbStatus(g)}${g.arrival && !g.arrived ? `・${memoGbMd(g.arrival)} 起取貨` : ''}${w ? `・<span style="color:${w.late ? 'var(--danger)' : '#c2410c'};font-weight:800;">⚠️ ${w.text}</span>` : ''}`,
          link:'todo.html', color: w ? (w.late ? 'var(--danger)' : '#f97316') : '#0f9d8a' });
      });
    }
  } catch(e) {
    console.warn('門市備忘讀取失敗:', e);
  }

  // 確保無論如何都能順利渲染到畫面，UI不會卡死
  const pendingCountEl = document.getElementById('pendingCount');
  if(pendingCountEl) pendingCountEl.textContent = pending.length + ' 件';

  const pendingCard = document.getElementById('pendingCard');
  const badge = document.getElementById('pendingBadgeBar');

  const menuDot = document.getElementById('headerMenuDot'); // ☰ 紅點：抽屜最上面會列出待處理件數
  if(menuDot) menuDot.hidden = pending.length === 0;
  if(typeof hpSetBadge === 'function') hpSetBadge(pending.length); // App 圖示紅點＝待處理件數

  if(badge) {
    if(pending.length > 0) {
      badge.style.display = 'flex';
      document.getElementById('pendingBadgeCount').textContent = pending.length;
    } else {
      badge.style.display = 'none';
    }
  }

  const el = document.getElementById('pendingList');
  if(pendingCard) pendingCard.style.display = 'block';
  if(pending.length === 0 && memoRows.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:12px 0 4px;font-size:13px;color:var(--text-muted);font-weight:600;">✅ 目前無待辦事項</div>`;
  } else {
    el.innerHTML = [...pending, ...memoRows].map(p => `
      <div class="notice-item" ${p.link ? `style="cursor:pointer;" onclick="window.location.href='${p.link}'"` : ''}>
        <div class="notice-dot" style="background:${p.color};"></div>
        <div style="flex:1;">
          <div class="notice-text"><strong>${p.type}</strong>：${p.desc}</div>
        </div>
        ${p.link ? `<div style="color:var(--primary); font-size:16px; font-weight:900; padding-left:8px;">›</div>` : ''}
      </div>`).join('');
  }
}

// ===== 離職員工清單 =====
async function openRetiredEmpModal() {
  openModal('retiredEmpModal');
  const listEl = document.getElementById('retiredEmpList');
  listEl.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:20px 0;">載入中...</div>`;
  try {
    const store = currentEmpAdminStore || currentUser.store || '';
    const snap = await window.db.collection('stores').doc(store).collection('employees').get();
    const retired = [];
    snap.forEach(d => {
      const s = d.data().status;
      if(s === '離職' || s === '調走') retired.push({ id:d.id, ...d.data() });
    });
    if(retired.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:30px 0;">📭 無離職/調走員工資料</div>`;
      return;
    }
    listEl.innerHTML = retired.map(emp => {
      const isRetired = emp.status === '離職';
      const tagStyle = isRetired
        ? 'background:#fce8e6;color:var(--danger);'
        : 'background:#fff3e0;color:#e65100;';
      const tagText = isRetired ? '已離職' : `已調走${emp.transferredTo?` → ${emp.transferredTo}`:''}`;
      return `
      <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--border);">
        <div style="width:36px;height:36px;border-radius:10px;background:#f1f3f4;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:var(--text-muted);">${emp.id[0]}</div>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:700;color:var(--text-muted);">${emp.id}
            <span style="font-size:11px;${tagStyle}padding:1px 6px;border-radius:4px;">${tagText}</span>
          </div>
          <div style="font-size:11px;color:var(--text-muted);">${emp.role||''}</div>
        </div>
        ${canManageEmployee() && isRetired ? `
        <button onclick="reinstateEmp('${emp.id}','${store}')"
          style="background:#e8f5e9;color:#2e7d32;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">✅ 復職</button>` : ''}
      </div>`;
    }).join('');
  } catch(e) {
    listEl.innerHTML = `<div style="text-align:center;color:var(--danger);padding:20px 0;">讀取失敗</div>`;
  }
}

async function reinstateEmp(empName, store) {
  if(!confirm(`確定將 ${empName} 設為復職？`)) return;
  showLoading('更新中...');
  try {
    await window.db.collection('stores').doc(store).collection('employees').doc(empName).update({ status: '在職' });
    showToast(`✅ ${empName} 已復職`);
    closeModal('retiredEmpModal');
    // 原本這裡呼叫 loadEmpAdminList(store)，但那個函式只存在於 employee-mgmt.html，
    // 在本頁必定拋 ReferenceError 而被下面的 catch 接住 → 復職其實成功了，畫面卻顯示「❌ 失敗」。
    // 清單已隨 modal 關閉，openRetiredEmpModal() 每次開啟都會重新讀取，不需要在這裡刷新。
  } catch(e) { showToast('❌ 失敗：' + e.message); }
  hideLoading();
}

