// 排班頁之六：排班表格、點格子改班、班別檢查與勞基法軟擋、畫筆、每日／每週合計。2026-10-16 從 schedule-v2-page.js 原封不動切出來（整理第 4 階段）。

// 建一顆排班格按鈕（.cell-btn + 完整 dataset 契約）；經典／單日／單人檢視共用，
// 確保三種檢視都走同一套編輯(handleCellClick/applyShift)與同步(syncUIToMemory)邏輯。
function buildCellButton(emp, eIdx, day, store, weekStr, isReadonly) {
  const isVirtual = emp.name.startsWith('🆘');
  // 離職生效日：當天(含)之後的格子鎖死、產出空白，不可排班（存檔即清空該格）
  if(!isVirtual && emp.retireDate){
    const cellDate = dayToFullDate(weekStr, day);
    if(cellDate && cellDate >= emp.retireDate){
      const lb = document.createElement('button');
      lb.className = 'cell-btn locked-off';
      lb.dataset.emp=emp.name; lb.dataset.day=day; lb.dataset.week=weekStr; lb.dataset.eidx=eIdx;
      lb.dataset.shift=''; lb.dataset.hours=0; lb.dataset.loc='本店'; lb.dataset.note='';
      lb.dataset.ot=false; lb.dataset.hourly=false; lb.dataset.support=''; lb.dataset.approval=''; lb.dataset.reqoff=false; lb.dataset.lawoverrides=''; lb.dataset.badges='';
      lb.innerHTML='🔒'; lb.disabled=true;
      lb.title=`${getDisplayName(emp.name)} 已於 ${emp.retireDate} 離職，此日之後不可排班`;
      return lb;
    }
  }
  let rec = appData.records.find(r => r.name===emp.name && r.day===day && r.week===weekStr);
  let supportOutRec = null;
  if(!isVirtual) {
    // ⚠️ 不可因「本店排休/指休」就略過支援班：新模型下派出去支援的人在本店本來就是休假，
    //    略過會讓整格顯示「休」（同仁回報：支援日在班表上變成休）。產圖(drawSchedule)一直是這個規則。
    supportOutRec = appData.allStoresRecords.find(r =>
      r.supportEmp === `${store}-${emp.name}` && r.day===day && r.week===weekStr && r.approvalStatus==='approved'
    );
  }
  // 跨店支援顯示：區分「整日外派」vs「本店有主班＋同日又去他店支援」
  // ⚠️ rec 本身若已是派出支援記錄（location=支援X）就不算「本店主班」，否則會與整格支援顯示重複
  let supportBadge = '';
  const recIsSupportOut = !!(rec && rec.location && rec.location.startsWith('支援'));
  const homeHasShift = rec && rec.shift && rec.shift !== '排休' && rec.shift !== '指休' && !recIsSupportOut;
  // 整格顯示支援班只是即時衍生（loc=支援X），syncUIToMemory 會跳過不落地，本店那筆排休記錄原樣保留
  const isFullDaySupport = !!supportOutRec && !homeHasShift;
  if(supportOutRec && homeHasShift) {
    // 本店有主班 + 同日去他店支援 → 主班保留可編輯，支援以唯讀標籤呈現
    const _info = `${getDisplayName(emp.name)} 當日於「${supportOutRec._store}」支援 ${supportOutRec.shift}，請至該門市班表修改或取消`.replace(/'/g,'');
    supportBadge = `<div style="background:#e0f2fe;color:#0369a1;padding:1px 4px;border-radius:4px;font-size:10px;font-weight:800;margin-top:2px;cursor:pointer;line-height:1.3;" onclick="event.stopPropagation(); alert('${_info}')">🔵 支援${supportOutRec._store} ${supportOutRec.shift}</div>`;
  } else if(isFullDaySupport) {
    // 整日外派（無本店主班）→ 整格顯示支援（原行為）
    rec = { shift: supportOutRec.shift, location: `支援${supportOutRec._store}`, note: supportOutRec.note, actualHours: supportOutRec.actualHours, isOT: supportOutRec.isOT, supportEmp:'', approvalStatus:'', requestOff:false };
  } else if(!rec) {
    rec = { shift:'', location:'本店', note:'', actualHours:0, isOT:false, isHourly:false, supportEmp:'', approvalStatus:'', requestOff:false };
  }

  const btn = document.createElement('button');
  btn.className = 'cell-btn' + (isReadonly ? ' readonly' : '');
  btn.dataset.emp = emp.name;
  btn.dataset.day = day;
  btn.dataset.week = weekStr; // 格子記住自己所屬週，避免換週時 syncUIToMemory 標錯週（跨週覆蓋 bug）
  btn.dataset.shift = rec.shift || '';
  btn.dataset.hours = rec.actualHours || 0;
  btn.dataset.loc = rec.location || '本店';
  btn.dataset.note = rec.note || '';
  btn.dataset.ot = rec.isOT || false;
  btn.dataset.hourly = rec.isHourly || false;
  btn.dataset.support = rec.supportEmp || '';
  btn.dataset.approval = rec.approvalStatus || '';
  btn.dataset.reqoff = rec.requestOff || false;
  btn.dataset.lawoverrides = (rec.lawOverrides && rec.lawOverrides.length) ? JSON.stringify(rec.lawOverrides) : '';
  btn.dataset.draft = rec.draft ? 'true' : ''; // 🤖 草稿排的格子（店長改過就拿掉）→「依最新劃休重排」只重排這些
  btn.dataset.eidx = eIdx;

  // 待審核徽章
  let pendingBadges = '';
  if(!isVirtual) {
    const pendingReqs = appData.allStoresRecords.filter(r =>
      r.supportEmp === `${store}-${emp.name}` && r.day===day && r.approvalStatus==='pending' && r.week===weekStr
    );
    pendingReqs.forEach(req => {
      const rd = encodeURIComponent(JSON.stringify(req));
      pendingBadges += `<div class="support-pending" onclick="event.stopPropagation(); openApprovalModal('${rd}')">🔔 ${req._store} ${req.shift} 申請支援</div>`;
    });
  }
  btn.dataset.badges = pendingBadges + supportBadge;

  updateCellUI(btn, pendingBadges + supportBadge);

  if(isFullDaySupport) {
    btn.onclick = () => alert(`此班別為跨店支援（前往 ${supportOutRec._store}）\n請由需求門市修改或取消！`);
  } else if(!isReadonly) {
    btn.onmousedown = (e) => { if(isPaintMode) { e.preventDefault(); isDragging=true; applyPaintToCell(btn,eIdx); } };
    btn.onmouseenter = () => { if(isPaintMode && isDragging) applyPaintToCell(btn,eIdx); };
    btn.ontouchstart = () => { if(isPaintMode) { isDragging=true; applyPaintToCell(btn,eIdx); } };
    btn.onclick = () => { if(!isPaintMode) handleCellClick(btn, eIdx, isVirtual); };
  }
  return btn;
}

function renderTable() {
  toggleScheduleContainers('classic');
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';
  const weekStr = document.getElementById('weekSelector').value;
  const store = document.getElementById('storeSelector').value;
  // 歷史班表鎖定：已過週次且未解鎖 → 強制唯讀
  const isLockedHistory = isHistoryWeek(weekStr) && !historyEditUnlocked;
  const isReadonly = !canScheduleStore(store) || isLockedHistory;
  // 更新鎖定 UI
  updateHistoryLockUI(weekStr, store);
  currentWeekDates = getWeekDates(weekStr);

  // 更新表頭
  const hRow = document.getElementById('headerRow');
  hRow.innerHTML = '<th>員工</th>';
  dayNames.forEach((d,i) => hRow.innerHTML += `<th><span class="date-sub">${currentWeekDates[i]}</span>${d}</th>`);
  // 計算本月應休天數提示（用週一日期推算月份，避免跨年誤算）
  const weekStr2 = document.getElementById('weekSelector').value;
  const _weekMon2 = weekStringToDate(weekStr2);
  const monthKey = `${_weekMon2.getFullYear()}-${String(_weekMon2.getMonth()+1).padStart(2,'0')}`;
  const minLeave = parseInt(appConfig.minLeaveDays || 8);
  const holidayCount = Object.keys(TW_HOLIDAYS_SCHED).filter(k => k.startsWith(monthKey)).length;
  hRow.innerHTML += `<th style="min-width:110px;">本週統計</th>`;

  const emps = [...appData.employees];
  virtualRowNames.forEach(n => emps.push({ name: n, role: '待補' }));

  emps.forEach((emp, eIdx) => {
    const tr = document.createElement('tr');
    const isVirtual = emp.name.startsWith('🆘');

    // 員工名稱欄
    const dispName = isVirtual ? emp.name : getDisplayName(emp.name);
    let nameHtml = `<strong class="emp-cell">${dispName}</strong><span class="role-tag">${emp.role||''}</span>`;
    if(isVirtual) nameHtml += ` <span style="color:var(--danger); font-size:11px; cursor:pointer;" onclick="deleteVirtualRow('${emp.name}')">✖</span>`;
    // ✅ transferDate 當週（未發布）：加注（已調職）
    // 離職/已調職且生效的人不會出現在班表，不需要額外標注
    if(emp._transferThisWeek) nameHtml += ` <span style="color:#d97706; font-size:10px; font-weight:700;">(已調職)</span>`;
    tr.innerHTML = `<td>${nameHtml}</td>`;

    dayNames.forEach(day => {
      const td = document.createElement('td');
      td.appendChild(buildCellButton(emp, eIdx, day, store, weekStr, isReadonly));
      tr.appendChild(td);
    });

    const sumTd = document.createElement('td');
    sumTd.id = `sum-${eIdx}`;
    sumTd.style.cssText = 'font-size:11px; text-align:left; background:#f8f9fa; padding:6px 8px; font-weight:600; min-width:110px; vertical-align:top;';
    tr.appendChild(sumTd);
    tbody.appendChild(tr);
    updateSummary(eIdx, emp);
  });

  // 備註列
  const nTr = document.createElement('tr');
  nTr.innerHTML = `<td style="background:#fff8e1;"><strong>📝 備註</strong></td>`;
  dayNames.forEach(day => {
    const rec = appData.records.find(r => r.name==='門市備註' && r.day===day && r.week===weekStr);
    let noteRaw = rec?.note || '';
    // 每月最後一天：備註為空時自動帶入「1700月底帳」（存檔即寫入）
    const _fd = dayToFullDate(weekStr, day);
    if(_fd){ const _dt=new Date(_fd+'T00:00'); const _last=new Date(_dt.getFullYear(),_dt.getMonth()+1,0).getDate(); if(_dt.getDate()===_last && !noteRaw.trim()) noteRaw='1700月底帳'; }
    const noteVal = noteRaw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    nTr.innerHTML += `<td style="padding:0; background:#fffde7;"><textarea class="note-input" data-day="${day}" data-week="${weekStr}" oninput="autoResizeNote(this);triggerAutoSave()" rows="2">${noteVal}</textarea></td>`;
  });
  nTr.innerHTML += '<td></td>';
  tbody.appendChild(nTr);
  nTr.querySelectorAll('.note-input').forEach(autoResizeNote);

  updateDailyTotals();
  updateWeekTotalCell();
  document.getElementById('tableFoot').style.display = 'table-row-group';
}

function updateCellUI(btn, extraHtml='') {
  const s=btn.dataset.shift, h=btn.dataset.hours, l=btn.dataset.loc, n=btn.dataset.note;
  const isOT=(btn.dataset.ot==='true'), isHourly=(btn.dataset.hourly==='true'), w=btn.dataset.warn||'';
  const supportEmp=btn.dataset.support, approvalStatus=btn.dataset.approval;
  const requestOff=(btn.dataset.reqoff==='true');
  const isVirtual=btn.dataset.emp.startsWith('🆘');
  const hVal=parseFloat(h)||0;

  btn.classList.remove('unfilled','zhi-xiu','pai-xiu','shift-night','shift-morning','conflict','annual-leave','comp-leave','wish-worked');

  let txt='';
  if(isVirtual && !supportEmp && s && s!=='排休' && s!=='指休') {
    btn.classList.add('unfilled');
    txt=`<span class="ot-text">${s}</span>`;
    if(n) txt+=`<br><small style="color:#0088aa;">${n}</small>`;
    btn.innerHTML=txt+extraHtml; return;
  }

  if(s==='指休') { txt='休'; btn.classList.add('zhi-xiu'); }
  else if(s==='排休') { txt='休'; btn.classList.add('pai-xiu'); }
  // ✅ 特休/補休：專屬樣式，不走 shift-morning/night
  else if(s==='特休') { txt='🏖️<br><small>特休</small>'; btn.classList.add('annual-leave'); }
  else if(s==='補休') { txt='🗓️<br><small>補休</small>'; btn.classList.add('comp-leave'); }
  else if(s) {
    if(isOT) txt=`<span class="ot-text">${s}</span>`;
    else if(hVal>8 && s.includes('-')) {
      const p=s.split('-');
      txt=p.length===2 ? `${p[0]}-<span class="ot-text">${p[1]}</span>` : s;
    } else txt=s;
    const start=parseInt(s);
    if(start>=15||start<6) btn.classList.add('shift-night');
    else btn.classList.add('shift-morning');
  } else { txt='+'; }

  if(h && parseFloat(h)!==(appConfig.shiftHours||{})[s] && s!=='排休' && s!=='指休' && s!=='特休' && s!=='補休' && s)
    txt+=`<br><small>(${Math.round(parseFloat(h))}h)</small>`;

  if(isVirtual && supportEmp) {
    const empOnly=getDisplayName(supportEmp.split('-')[1]||supportEmp); // 顯示 app 顯示名稱（非短名）
    txt+=approvalStatus==='pending'
      ? `<br><small style="color:#e65100;font-weight:700;">${empOnly}<br>(待審)</small>`
      : `<br><small style="color:var(--primary);font-weight:900;">${empOnly}</small>`;
  }
  if(l && l!=='本店' && !isVirtual) txt+=`<br><small style="color:var(--danger);font-weight:800;">📍${l}</small>`;
  if(n) txt+=`<br><small style="color:#0088aa;">${n}</small>`;

  const hasConflict=(s && s!=='排休' && s!=='指休' && requestOff);
  if(hasConflict) { btn.classList.add('conflict'); txt+=`<br><span style="background:var(--danger);color:white;padding:1px 3px;border-radius:3px;font-size:10px;">⚠️ 衝突</span>`; }
  else if(requestOff) txt+=`<br><span class="req-tag">🙋‍♀️ 排休</span>`;
  // 時薪另計：休假樣式 + 顯示時數
  if(isHourly) {
    const hVal = btn.dataset.hours || '0';
    txt += `<br><span style="background:#f3e8ff;color:#7c3aed;padding:1px 4px;border-radius:3px;font-size:10px;font-weight:700;">時 ${hVal}h</span>`;
  }

  // ✅ 疊加 leaveRequests 劃休申請標籤（只在管理者視角 + 班別尚未填入時顯示）
  if(!isVirtual && (appData.leaveRequests||[]).length > 0) {
    const empName = btn.dataset.emp;
    const day = btn.dataset.day;
    const weekStr = document.getElementById('weekSelector')?.value;
    const fullDate = dayToFullDate(weekStr, day);
    const lr = appData.leaveRequests.find(r =>
      r.empName === empName && r.date === fullDate &&
      !['cancelled','unfulfilled'].includes(r.status)
    );
    if(lr) {
      // 若班別已對應假別 → 申請已處理，不再顯示標籤
      const alreadyHandled =
        (lr.type === 'annual' && s === '特休') ||
        (lr.type === 'comp'   && s === '補休') ||
        (lr.type === 'off'    && (s === '排休' || s === '指休'));
      if(!alreadyHandled) {
        // 是否被排了「實際上班」的班別（非休假別）→ 與許願休假衝突，需醒目提示以便改班
        const workedOverWish = !!(s && !['排休','指休','特休','補休'].includes(s));
        const partMap = { morning:'早', afternoon:'午', night:'晚', full:'整天' };
        const partTxt = partMap[lr.shift] || '';
        const typeName = lr.type==='annual'?'特休':lr.type==='comp'?'補休':'休';
        let lrColor = lr.type==='annual'?'#9334e6':lr.type==='comp'?'#0891b2':'var(--primary)';
        let lrBg   = lr.type==='annual'?'#f3e8ff':lr.type==='comp'?'#ecfeff':'#e8f0fe';
        let lrLabel;
        if(workedOverWish){
          // 被排班卻原本許願休 → 醒目警示 + 格子左側警示條
          lrLabel = `🙅 原想休${typeName}${partTxt?`(${partTxt})`:''}`;
          lrColor = '#b45309'; lrBg = '#fff7ed';
          btn.classList.add('wish-worked');
        } else {
          lrLabel = lr.type==='annual'?'🏖️特休申請':lr.type==='comp'?'🗓️補休申請':`📝排休許願${partTxt?`(${partTxt})`:''}`;
        }
        // 排休：顯示順位 M/N（依 createdAt 先送先贏、同角色同日）→ 店長依序裁決
        if(lr.type === 'off'){
          const alive = x => !['cancelled','unfulfilled'].includes(x.status);
          const full = lr.empType !== 'part';
          const sameDay = (appData.leaveRequests||[]).filter(x=>x.date===fullDate && x.type==='off' && alive(x) && (x.empType!=='part')===full)
            .sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''));
          const pos = sameDay.findIndex(x=>x.id===lr.id)+1;
          const lq = appData.leaveQuota || {fullTime:2, partTime:1};
          const limit = full ? (lq.fullTime ?? 2) : (lq.partTimeUnlimited ? '∞' : (lq.partTime ?? 1));
          if(pos>0) lrLabel += ` <b>順位${pos}/${limit}</b>${(limit!=='∞' && pos>limit)?'🕓候補':''}`;
        }
        txt += `<br><span style="background:${lrBg};color:${lrColor};padding:1px 4px;border-radius:4px;font-size:10px;font-weight:700;">${lrLabel}</span>`;
      }
    }
  }

  // 🟠 勞基法知情放行標記
  if(btn.dataset.lawoverrides) {
    txt += `<br><span style="background:#fff3e0;color:#e65100;padding:1px 4px;border-radius:4px;font-size:9px;font-weight:800;" title="已知情放行（違勞基法）">🟠 已放行</span>`;
  }

  btn.innerHTML=txt+extraHtml;
}

// ===== 班別 Modal =====
function handleCellClick(btn, eIdx, isVirtual) {
  currentCell = btn;
  document.getElementById('shiftModalTitle').textContent = `${btn.dataset.emp} — ${btn.dataset.day}`;
  document.getElementById('modalShift').value = btn.dataset.shift;
  document.getElementById('modalHours').value = btn.dataset.hours;
  document.getElementById('modalOT').checked = btn.dataset.ot==='true';
  document.getElementById('modalHourly').checked = btn.dataset.hourly==='true';
  document.getElementById('modalNote').value = btn.dataset.note;
  document.getElementById('conflictWarn').style.display = btn.dataset.reqoff==='true' && btn.dataset.shift ? 'block' : 'none';

  if(isVirtual) {
    document.getElementById('modalLocGroup').style.display = 'none';
    document.getElementById('modalSupportGroup').style.display = 'block';
    document.getElementById('modalSupportEmp').value = btn.dataset.support||'';
    document.getElementById('modalApproval').value = btn.dataset.approval||'pending';
    document.getElementById('clearReqWrap').style.display = 'none';
    toggleApprovalVis();
  } else {
    document.getElementById('modalLocGroup').style.display = 'block';
    document.getElementById('modalSupportGroup').style.display = 'none';
    document.getElementById('modalLocation').value = btn.dataset.loc||'本店';
    const clearWrap = document.getElementById('clearReqWrap');
    if(btn.dataset.reqoff==='true') {
      clearWrap.style.display = 'flex';
      document.getElementById('clearReqCheck').checked = true;
    } else {
      clearWrap.style.display = 'none';
    }
  }
  renderQuickShiftBtns();

  // 重置班別格式提示（開新格子不殘留上一格的錯誤）
  const _fmtHint = document.getElementById('shiftFmtHint');
  if(_fmtHint) _fmtHint.style.display = 'none';

  // ✅ 劃休申請提示橫幅
  const lrBanner = document.getElementById('leaveReqBanner');
  if(lrBanner && !isVirtual) {
    const weekStr = document.getElementById('weekSelector')?.value;
    const fullDate = dayToFullDate(weekStr, btn.dataset.day);
    const lr = (appData.leaveRequests||[]).find(r =>
      r.empName === btn.dataset.emp && r.date === fullDate &&
      !['cancelled','unfulfilled'].includes(r.status)
    );
    if(lr) {
      const typeLabel = lr.type==='annual'?'🏖️ 特休':lr.type==='comp'?'🗓️ 補休':'📝 排休許願';
      const shiftLabel = lr.shift==='morning'?'（早班）':lr.shift==='evening'?'（晚班）':'（全日）';
      const alreadyHandled =
        (lr.type==='annual' && btn.dataset.shift==='特休') ||
        (lr.type==='comp'   && btn.dataset.shift==='補休') ||
        (lr.type==='off'    && (btn.dataset.shift==='排休'||btn.dataset.shift==='指休'));

      if(alreadyHandled) {
        lrBanner.style.display = 'none';
      } else {
        const bgColor = lr.type==='annual'?'#f3e8ff':lr.type==='comp'?'#ecfeff':'#e8f0fe';
        const color   = lr.type==='annual'?'#6b21a8':lr.type==='comp'?'#0e7490':'#1557b0';

        // 時段限制說明
        const shiftRestrict = lr.shift==='morning'?'（不能上早班）':lr.shift==='evening'?'（不能上晚班）':'（整天不能上）';

        // 第一行：假別 + 時段限制
        const titleLine = lr.type==='off'
          ? `📝 排休申請${shiftRestrict}`
          : lr.type==='annual'
            ? `🏖️ 特休申請${shiftRestrict}`
            : `🗓️ 補休申請${shiftRestrict}`;

        // 第二行：備註 + 提示
        const hintText = lr.type==='annual'||lr.type==='comp'
          ? `排入「${lr.type==='annual'?'特休':'補休'}」即視為核准，店長排班前請確認餘額充足。`
          : '';
        const noteLine = lr.note
          ? `備註：${lr.note}${hintText ? '　' + hintText : ''}`
          : hintText;

        lrBanner.style.display = 'block';
        lrBanner.style.background = bgColor;
        lrBanner.style.border = `1px solid ${color}40`;
        lrBanner.style.color = color;
        lrBanner.innerHTML = `<strong>${titleLine}</strong><br><span style="opacity:0.85;font-size:11px;">${noteLine}</span>`;
      }
    } else {
      lrBanner.style.display = 'none';
    }
  } else if(lrBanner) {
    lrBanner.style.display = 'none';
  }

  openModal('shiftModal');
}

function renderQuickShiftBtns() {
  // 班別快捷（過濾掉「清空」，已有獨立按鈕）
  let h=`<button class="quick-shift-btn clear" onclick="clearModalShift()">🗑️ 清空</button>`;
  // ✅ 內建班別：特休/補休（固定顯示，不進系統設定）
  h+=`<button class="quick-shift-btn annual-leave" onclick="setModalShift('特休')">🏖️ 特休</button>`;
  h+=`<button class="quick-shift-btn comp-leave"   onclick="setModalShift('補休')">🗓️ 補休</button>`;
  (appConfig.shifts||[]).filter(s=>s!=='清空').forEach(s => {
    const isOff=(s==='排休'||s==='指休');
    h+=`<button class="quick-shift-btn ${isOff?'off':''}" onclick="setModalShift('${s}')">${s}</button>`;
  });
  document.getElementById('quickShiftBtns').innerHTML=h;

  // 備註快捷（動態渲染）
  const noteRow = document.getElementById('quickNoteRow');
  if(noteRow && appConfig.quickNotes) {
    noteRow.innerHTML = appConfig.quickNotes.map(n =>
      `<button class="qnote-btn" onclick="appendNote('${n}')">${n}</button>`
    ).join('');
  }
}
function setModalShift(s) { document.getElementById('modalShift').value=s; autoFillHours(); }
function clearModalShift() {
  document.getElementById('modalShift').value='';
  document.getElementById('modalHours').value='';
  document.getElementById('modalOT').checked=false;
  if(document.getElementById('modalHourly')) document.getElementById('modalHourly').checked=false;
  document.getElementById('modalNote').value='';
  document.getElementById('modalSupportEmp').value='';
  toggleApprovalVis();
}
function appendNote(t) {
  const el=document.getElementById('modalNote');
  el.value=el.value.trim() ? el.value+' '+t : t;
}
// 驗證班別格式：回傳錯誤訊息字串；正確則回傳 null
// 規則：時間班別必須是「開始-結束」，小數只允許 .25/.5/.75（=15/30/45分）
function validateShiftFormat(raw) {
  const s = (raw||'').trim();
  if(!s) return null; // 空白（清空）不擋
  // 純文字班別（排休/指休/特休/補休等，無數字）放行
  if(!/\d/.test(s)) return null;
  // 支援兩頭班：逗號分隔多段，每段須為「數字[.小數]-數字[.小數]」
  const segs = s.split(',').map(x => x.trim());
  for(const seg of segs) {
    const m = seg.match(/^(\d{1,2}(?:\.\d+)?)-(\d{1,2}(?:\.\d+)?)$/);
    if(!m) return `班別格式錯誤：請用「開始-結束」，兩頭班用逗號，例如 7-15、7-11,17-21`;
    for(const part of [m[1], m[2]]) {
      const dot = part.indexOf('.');
      if(dot >= 0) {
        const dec = part.slice(dot+1);
        if(!['25','5','75'].includes(dec))
          return `時間「${part}」小數錯誤：30分寫 .5、15分寫 .25、45分寫 .75（勿用 .30）`;
      }
    }
  }
  return null;
}

function autoFillHours() {
  const s=document.getElementById('modalShift').value.trim();
  const t=document.getElementById('modalHours');
  // 即時格式提示
  const hint=document.getElementById('shiftFmtHint');
  const err=validateShiftFormat(s);
  if(hint) {
    hint.style.display = err ? 'block' : 'none';
    hint.textContent = err || '';
  }
  if((appConfig.shiftHours||{})[s]) { t.value=(appConfig.shiftHours||{})[s]; return; }
  // 兩頭班：逐段加總時數
  let total = 0, matched = false;
  s.split(',').forEach(seg => {
    const m = seg.trim().match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/);
    if(m) { let sT=parseFloat(m[1]), eT=parseFloat(m[2]); if(eT<=sT) eT+=24; total += eT-sT; matched=true; }
  });
  if(matched) t.value = Math.round(total*100)/100;
  else if(s==='排休'||s==='指休'||s==='特休'||s==='補休') t.value=0;
}

// ===== 排班衝突偵測 =====
function detectScheduleConflicts(empName, day, weekStr, newShift, newHours) {
  const warnings   = [];
  const errors     = [];
  const softBlocks = []; // 軟擋：需知情放行（產生 lawOverride）
  if(!newShift || newShift === '排休' || newShift === '指休' || newShift === '清空') return { warnings, errors, softBlocks };

  const dayIdx = dayNames.indexOf(day);

  const curStore    = document.getElementById('storeSelector').value;
  const MIN_REST_H  = 11;
  const DAILY_MAX_H = 12;
  const fmtN = g => (Math.round(g * 10) / 10);

  // 班次(週,日,字串) → intervals[]（支援兩頭班：逗號多段）；非時間班別回 []
  function shiftIntervalsWD(recWeek, dayName, shiftStr) {
    const di = dayNames.indexOf(dayName);
    if(di < 0) return [];
    const base = weekStringToDate(recWeek).getTime() + di * 24 * 3600e3; // 該日 00:00
    const out = [];
    (shiftStr || '').split(',').forEach(seg => {
      const mm = seg.trim().match(/^(\d{1,2}(?:\.\d+)?)-(\d{1,2}(?:\.\d+)?)$/);
      if(!mm) return;
      const startH = parseFloat(mm[1]), endH = parseFloat(mm[2]);
      let start = base + startH * 3600e3;
      let end   = base + endH   * 3600e3;
      if(endH <= startH) end += 24 * 3600e3; // 跨夜：下班推隔天
      out.push({ start, end });
    });
    return out;
  }
  const dayKey = ms => { const dt = new Date(ms); return `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`; };

  const targetIvs = shiftIntervalsWD(weekStr, day, newShift);

  // 蒐集該員（跨週＋跨店）所有已載入班次段；排除正在編輯的本格；派出/接收雙記錄去重
  // ⚠️ 本店讀 live appData.records（即時反映未存編輯）；他店支援才讀 allStoresRecords 快照。
  const seen = new Set();
  const empIntervals = [];
  const pushIvs = (r, storeLabel) => {
    shiftIntervalsWD(r.week, r.day, r.shift).forEach(iv => {
      const k = `${iv.start}|${iv.end}`;
      if(seen.has(k)) return; // 同一實體班次的雙記錄（派出/接收）去重
      seen.add(k);
      empIntervals.push({ start: iv.start, end: iv.end, _store: storeLabel, _week: r.week, _day: r.day, _name: r.name });
    });
  };
  (appData.records || []).forEach(r => {
    const belongs = (r.name === empName) || (r.supportEmp === `${curStore}-${empName}`);
    if(!belongs) return;
    if(r.week === weekStr && r.day === day) return; // 目標格改用 newShift
    pushIvs(r, curStore);
  });
  (appData.allStoresRecords || []).forEach(r => {
    if(r._store === curStore) return; // 本店已用 appData.records
    const belongs = (r.name === empName) || (r.supportEmp === `${curStore}-${empName}`);
    if(!belongs) return;
    pushIvs(r, r._store);
  });

  if(targetIvs.length) {
    // 排除與任一 target 段完全同時段的鏡像（編輯支援日時，接收店那筆即本班另一份記錄）
    const neighbors = empIntervals.filter(iv => !targetIvs.some(t => iv.start === t.start && iv.end === t.end));
    const tFirstStart = Math.min(...targetIvs.map(t => t.start));
    const tLastEnd    = Math.max(...targetIvs.map(t => t.end));
    const tDay        = dayKey(tFirstStart);

    // 1. 時間重疊（強制錯誤）— 一個人不可能同一時刻在兩處
    let overlap = null;
    for(const t of targetIvs) { overlap = neighbors.find(iv => iv.start < t.end && t.start < iv.end); if(overlap) break; }
    let selfOverlap = false; // 兩頭班兩段互相重疊 = 輸入錯誤
    for(let i=0;i<targetIvs.length && !selfOverlap;i++)
      for(let j=i+1;j<targetIvs.length;j++)
        if(targetIvs[i].start < targetIvs[j].end && targetIvs[j].start < targetIvs[i].end) { selfOverlap = true; break; }
    if(overlap) {
      const where = overlap._store !== curStore ? `「${overlap._store}」` : '同日另一班';
      errors.push(`🔴 ${empName} 該時段已在${where}排班，時間重疊無法排！`);
    } else if(selfOverlap) {
      errors.push(`🔴 ${empName} 兩頭班的兩段時間重疊，請修正！`);
    }

    // 1.5 連續工時（軟擋 §32）— 把所有相接/重疊的段合併成連續區塊；含 target 段且跨度 >12h → 知情放行
    //     兩頭班中間有休息 → 不相接 → 不會合併；大夜 23-07 直接接早班 7-15 → 相接 → 合併 16h → 觸發
    const merged = neighbors.concat(targetIvs).sort((a,b)=>a.start-b.start);
    const blocks = [];
    for(const iv of merged) {
      const last = blocks[blocks.length-1];
      if(last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
      else blocks.push({ start: iv.start, end: iv.end });
    }
    const contBlk = blocks.find(b => (b.end - b.start)/3600e3 > DAILY_MAX_H &&
      targetIvs.some(t => t.start >= b.start && t.end <= b.end));
    if(contBlk) {
      const contH = (contBlk.end - contBlk.start)/3600e3;
      softBlocks.push({ rule:'continuous12h', measured: fmtN(contH), msg:`連續工時 ${fmtN(contH)}h（含相接／跨夜、中間無休息），超過 ${DAILY_MAX_H} 小時` });
    }

    // 2. 當日總工時 > 12h（同日多段＝兩頭班＋跨店加總，軟擋 §32）
    let dailyH = targetIvs.reduce((s,t)=>s+(t.end-t.start)/3600e3, 0);
    neighbors.forEach(iv => { if(dayKey(iv.start) === tDay) dailyH += (iv.end - iv.start)/3600e3; });
    if(dailyH > DAILY_MAX_H)
      softBlocks.push({ rule:'daily12h', measured: fmtN(dailyH), msg:`當日總工時 ${fmtN(dailyH)}h（含兩頭班／跨店加總），超過 ${DAILY_MAX_H} 小時` });

    // 4. 輪班間隔 < 11h（軟擋 §34）— 只算「跨工作日」的休息；同日多段(兩頭班午休/同日跨店)不算，
    //    由當日總工時把關。間隔 = 0（相接）屬連續班，由連續工時處理。
    const prev = neighbors.filter(iv => dayKey(iv.start) !== tDay && iv.end <= tFirstStart).sort((a,b)=>b.end-a.end)[0];
    if(prev) {
      const g = (tFirstStart - prev.end) / 3600e3;
      if(g > 0 && g < MIN_REST_H) softBlocks.push({ rule:'rest11h', measured: fmtN(g), msg:`距前一班下班僅 ${fmtN(g)} 小時（未達 11 小時休息）` });
    }
    const next = neighbors.filter(iv => dayKey(iv.start) !== tDay && iv.start >= tLastEnd).sort((a,b)=>a.start-b.start)[0];
    if(next) {
      const g = (next.start - tLastEnd) / 3600e3;
      // 往後看到的違規：責任在「較晚開始的那班」(next)，放行改記在 next 那格，不記本格（避免同一違規重複記在兩天、且與編輯順序無關）
      if(g > 0 && g < MIN_REST_H) softBlocks.push({
        rule:'rest11h', measured: fmtN(g),
        msg:`此班下班後，較晚那班僅隔 ${fmtN(g)} 小時（未達 11 小時休息）— 放行將記在較晚那班`,
        stampLater: { store: next._store, week: next._week, day: next._day, name: next._name }
      });
    }
  }

  // 3. 連續工作天數（第七天，軟擋 §36 七休一）
  if(dayIdx >= 0) {
    let consecutive = 0;
    // 往前數連續工班天數（含今天）
    for(let i = dayIdx; i >= 0; i--) {
      const checkDay = dayNames[i];
      const checkRec = appData.records.find(r =>
        r.name === empName && r.day === checkDay && r.week === weekStr
      );
      const checkShift = (i === dayIdx) ? newShift : (checkRec?.shift || '');
      if(checkShift && checkShift !== '排休' && checkShift !== '指休' && checkShift !== '清空') {
        consecutive++;
      } else { break; }
    }
    // 往後數（下週的連續情況不在本週計算，簡化處理）
    if(consecutive >= 7) {
      softBlocks.push({ rule:'weekly1off', measured: consecutive, msg:`本週連續出勤已達 ${consecutive} 天（未滿七休一）` });
    }
  }

  return { warnings, errors, softBlocks };
}

// ===== 勞基法軟擋：知情放行確認 sheet（Promise 化）=====
let _lawOverrideResolver = null;
function showLawOverrideSheet(softBlocks) {
  document.getElementById('lawOverrideList').innerHTML = softBlocks.map(sb => `• ${sb.msg}`).join('<br>');
  document.getElementById('lawOverrideReason').value = 'voluntary';
  document.getElementById('lawOverrideNote').value = '';
  openModal('lawOverrideModal');
  return new Promise(resolve => { _lawOverrideResolver = resolve; });
}
function confirmLawOverride() {
  const reason = document.getElementById('lawOverrideReason').value;
  const note   = document.getElementById('lawOverrideNote').value.trim();
  closeModal('lawOverrideModal');
  if(_lawOverrideResolver) { _lawOverrideResolver({ reason, note }); _lawOverrideResolver = null; }
}
function cancelLawOverride() {
  closeModal('lawOverrideModal');
  if(_lawOverrideResolver) { _lawOverrideResolver(null); _lawOverrideResolver = null; }
}

async function applyShift() {
  // ✅ 班別格式驗證（避免 .30 被當 .3、. 後空白等造成工時誤算）
  const fmtErr = validateShiftFormat(document.getElementById('modalShift').value);
  if(fmtErr) { alert('❌ ' + fmtErr); return; }

  pushToUndo(currentCell);
  currentCell.dataset.draft = ''; // 店長手動改過 → 不再算草稿格（重排時保留）
  const isVirtual = currentCell.dataset.emp.startsWith('🆘');

  // ✅ 排班衝突偵測（非虛擬行才檢查）
  if(!isVirtual) {
    const empName  = currentCell.dataset.emp;
    const day      = currentCell.dataset.day;
    const weekStr  = document.getElementById('weekSelector').value;
    const newShift = document.getElementById('modalShift').value;
    const newHours = document.getElementById('modalHours').value;

    currentCell.dataset.lawoverrides = ''; // 預設清空（重新評估）
    // 補休還沒生效（國定假日補休要過了那天才能用）→ 警告、可放行（2026-09-22）
    if(newShift === '補休' && currentCell.dataset.shift !== '補休' && typeof caCompAvailability === 'function') {
      try {
        const ca = await caCompAvailability(empName);
        if(ca.effective < 1) {
          const msg = `⚠️ ${getDisplayName(empName)}目前可用的補休只有 ${ca.effective} 天` +
            (ca.pending.length ? `\n（另有國定假日補休還沒生效：${caPendingText(ca.pending)}）` : '') +
            `\n\n國定假日補休要過了那天才能用，避免之後改班表收回時變成負數。\n確定還是要排補休？`;
          if(!confirm(msg)) return;
        }
      } catch(e) { console.warn('補休檢查失敗:', e); }
    }
    if(newShift && newShift !== '排休' && newShift !== '指休' && newShift !== '清空') {
      const { errors, softBlocks } = detectScheduleConflicts(empName, day, weekStr, newShift, newHours);

      // 🔴 硬擋（時間重疊等）→ 必須中止
      if(errors.length > 0) {
        alert(errors.join('\n\n') + '\n\n請修正後再儲存。');
        return;
      }

      // 🟠 軟擋（違勞基法）→ 知情放行 + 記錄 lawOverride
      if(softBlocks.length > 0) {
        const ov = await showLawOverrideSheet(softBlocks);
        if(!ov) return; // 取消 → 不排這班
        const at = new Date().toISOString();
        const approvedBy = currentUser.displayName || currentUser.empName || '';
        const mkOv = sb => ({ rule: sb.rule, measured: sb.measured, reason: ov.reason, note: ov.note, approvedBy, approverPerm: currentUser.permission || '', at });
        // 分兩類：本格自負(含 rest11h「往前」)；rest11h「往後」→ 放行歸較晚那班(stampLater)
        const ownBlocks   = softBlocks.filter(sb => !sb.stampLater);
        const laterBlocks = softBlocks.filter(sb => sb.stampLater);
        currentCell.dataset.lawoverrides = ownBlocks.length ? JSON.stringify(ownBlocks.map(mkOv)) : '';
        const _curWeek  = document.getElementById('weekSelector').value;
        const _curStore = document.getElementById('storeSelector').value;
        laterBlocks.forEach(sb => {
          const t = sb.stampLater;
          // 找較晚那班的畫面格（同店同週才在 DOM 上）→ 合併放行(同格同規則不重複)
          let cell = null;
          if(t.store === _curStore && t.week === _curWeek)
            cell = [...document.querySelectorAll('.cell-btn')].find(c => c.dataset.emp === t.name && c.dataset.day === t.day);
          if(cell) {
            let arr = []; try { arr = cell.dataset.lawoverrides ? JSON.parse(cell.dataset.lawoverrides) : []; } catch(e){}
            if(!arr.some(o => o.rule === 'rest11h')) arr.push(mkOv(sb));
            cell.dataset.lawoverrides = arr.length ? JSON.stringify(arr) : '';
          } else {
            // 跨週/跨店晚班不在畫面 → 退而求其次記本格，至少留存(不會無紀錄)
            let arr = []; try { arr = currentCell.dataset.lawoverrides ? JSON.parse(currentCell.dataset.lawoverrides) : []; } catch(e){}
            arr.push(mkOv(sb));
            currentCell.dataset.lawoverrides = JSON.stringify(arr);
          }
        });
      }
    }
  }

  const prevShift = currentCell.dataset.shift;
  currentCell.dataset.shift=document.getElementById('modalShift').value;
  currentCell.dataset.hours=document.getElementById('modalHours').value;
  currentCell.dataset.ot=document.getElementById('modalOT').checked;
  currentCell.dataset.hourly=document.getElementById('modalHourly').checked;
  currentCell.dataset.note=document.getElementById('modalNote').value;
  if(isVirtual) {
    currentCell.dataset.loc='本店';
    const _newSupport = document.getElementById('modalSupportEmp').value;
    const _prevSupport = currentCell.dataset.support||'';
    const _prevApproval = currentCell.dataset.approval||'';
    currentCell.dataset.support = _newSupport;
    // 支援人員沒換且原本已核准/已認領 → 保留；新指派或換人 → 一律 pending(待對方審核)；沒指定人 → 空
    currentCell.dataset.approval = (_newSupport && _newSupport===_prevSupport && _prevApproval==='approved')
      ? 'approved'
      : (_newSupport ? 'pending' : '');
    // 支援指派/取消有變動 → 蓋時間戳，讓合併存檔知道這是「較新的刻意異動」(含取消改成無)，不被 DB 舊值倒退
    if(_newSupport !== _prevSupport) currentCell.dataset.supportat = new Date().toISOString();
  } else {
    currentCell.dataset.loc=document.getElementById('modalLocation').value;
    if(document.getElementById('clearReqWrap').style.display!=='none' && document.getElementById('clearReqCheck').checked) {
      currentCell.dataset.reqoff='false';
      // ✅ bug fix：取消 requestOff 後，若格子無任何實際資料，清除 records 裡的空記錄
      // 防止備註欄（或其他欄位）殘留空字串導致 updateCellUI 顯示異常
      const _weekStr = document.getElementById('weekSelector').value;
      const _empName = currentCell.dataset.emp;
      const _day = currentCell.dataset.day;
      const _newShift = document.getElementById('modalShift').value.trim();
      const _newNote = document.getElementById('modalNote').value.trim();
      if(!_newShift && !_newNote) {
        const _idx = appData.records.findIndex(r =>
          r.name===_empName && r.day===_day && r.week===_weekStr
        );
        if(_idx !== -1) {
          const _rec = appData.records[_idx];
          // 若沒有其他有意義的資料，直接移除
          if(!_rec.shift && !_rec.note && !_rec.supportEmp) {
            appData.records.splice(_idx, 1);
          }
        }
      }
    }
  }
  // ✅ 特休/補休：扣天數（非虛擬行才扣）
  if(!isVirtual) {
    const newShift = currentCell.dataset.shift;
    const empName  = currentCell.dataset.emp;
    const day      = currentCell.dataset.day;
    const weekStr  = document.getElementById('weekSelector').value;
    deductLeave(empName, day, weekStr, prevShift, newShift);

    // 🎌 國定假日補休偵測
    const dates2 = getWeekDates(weekStr);
    const dIdx2  = dayNames.indexOf(day);
    if(dIdx2 >= 0) {
      const [m2, d2] = dates2[dIdx2].split('/');
      const fullDate2 = `${weekStr.split('-W')[0]}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
      const emp2 = appData.employees?.find(e => e.name === empName);
      checkHolidayCompOnSave(empName, fullDate2, prevShift, newShift, emp2);
    }
  }
  syncUIToMemory();
  renderSchedule();
  closeModal('shiftModal');
  triggerAutoSave();
}

// ===== 畫筆模式 =====
document.addEventListener('mouseup', ()=>{ isDragging=false; });
document.addEventListener('touchend', ()=>{ isDragging=false; });
document.addEventListener('DOMContentLoaded', ()=>{
  const tbl = document.getElementById('scheduleTable');
  if(tbl) tbl.addEventListener('touchmove', (e)=>{
    if(isPaintMode && isDragging) {
      e.preventDefault();
      const touch=e.touches[0];
      const el=document.elementFromPoint(touch.clientX, touch.clientY);
      const btn=el?.closest('.cell-btn');
      if(btn) applyPaintToCell(btn, parseInt(btn.dataset.eidx));
    }
  }, { passive:false });
});

function togglePaintMode() {
  isPaintMode=!isPaintMode;
  const btn=document.getElementById('paintModeBtn');
  const bar=document.getElementById('paintBar');
  if(isPaintMode) {
    btn.classList.add('active');
    btn.textContent='🛑 關閉畫筆';
    bar.classList.add('active');
    renderPaintBtns();
  } else {
    btn.classList.remove('active');
    btn.textContent='🖌️ 畫筆';
    bar.classList.remove('active');
    paintShift='';
  }
}
function renderPaintBtns() {
  let h=`<button class="paint-shift-btn ${paintShift==='清空'?'active-paint':''}" onclick="setPaintShift('清空')">🗑️ 清空</button>`;
  // ✅ 內建班別：特休/補休
  h+=`<button class="paint-shift-btn annual-leave ${paintShift==='特休'?'active-paint':''}" onclick="setPaintShift('特休')">🏖️ 特休</button>`;
  h+=`<button class="paint-shift-btn comp-leave ${paintShift==='補休'?'active-paint':''}" onclick="setPaintShift('補休')">🗓️ 補休</button>`;
  (appConfig.shifts||[]).filter(s=>s!=='清空').forEach(s=>{
    const isOff=(s==='排休'||s==='指休');
    h+=`<button class="paint-shift-btn ${isOff?'off-shift':''} ${paintShift===s?'active-paint':''}" onclick="setPaintShift('${s}')">${s}</button>`;
  });
  document.getElementById('paintBtns').innerHTML=h;
}
function setPaintShift(s) { paintShift=s; renderPaintBtns(); }
function applyPaintToCell(btn, eIdx) {
  if(!paintShift) { if(!isDragging) alert('請先選擇畫筆班別！'); return; }
  // 歷史班表鎖定保護
  const _weekStr = document.getElementById('weekSelector')?.value;
  if(_weekStr && isHistoryWeek(_weekStr) && !historyEditUnlocked) {
    showToast('🔒 歷史班表已鎖定，請點「✏️ 編輯歷史班表」解鎖後再操作');
    return;
  }
  const target=paintShift==='清空' ? '' : paintShift;
  if(btn.dataset.shift===target) return;
  pushToUndo(btn);
  btn.dataset.draft=''; // 畫筆＝店長手動 → 不再算草稿格
  const isVirtual=btn.dataset.emp.startsWith('🆘');
  const prevShift = btn.dataset.shift; // 記錄原班別
  btn.dataset.lawoverrides=''; // 畫筆不跑勞基法偵測 → 清掉舊放行標記避免殘留
  if(paintShift==='清空') {
    btn.dataset.shift=''; btn.dataset.hours=0; btn.dataset.ot='false'; btn.dataset.note='';
    if(isVirtual) { btn.dataset.support=''; btn.dataset.approval=''; }
    else btn.dataset.reqoff='false';
  } else {
    btn.dataset.shift=paintShift;
    let h=(appConfig.shiftHours||{})[paintShift]||0;
    if(!h && paintShift!=='排休' && paintShift!=='指休' && paintShift!=='特休' && paintShift!=='補休') {
      const m=paintShift.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/);
      if(m) { let sT=parseFloat(m[1]),eT=parseFloat(m[2]); if(eT<=sT) eT+=24; h=eT-sT; }
    }
    btn.dataset.hours=h; btn.dataset.ot='false';
    if(!isVirtual) { btn.dataset.loc='本店'; btn.dataset.reqoff='false'; }
  }
  // ✅ 特休/補休：扣天數（非虛擬行才扣）
  if(!isVirtual) {
    const week = document.getElementById('weekSelector').value;
    const _ded = deductLeave(btn.dataset.emp, btn.dataset.day, week, prevShift, btn.dataset.shift||'');
    // 畫筆排補休：不能中途問，扣完之後提醒補休還沒生效（2026-09-22）
    if(btn.dataset.shift === '補休' && prevShift !== '補休' && typeof caCompAvailability === 'function') {
      const _emp = btn.dataset.emp;
      Promise.resolve(_ded).then(() => caCompAvailability(_emp)).then(ca => {
        if(ca.effective < 0) showToast(`⚠️ ${getDisplayName(_emp)}可用補休不足（${ca.effective} 天）` + (ca.pending.length ? `；國定假日補休 ${caPendingText(ca.pending)}` : ''));
      }).catch(()=>{});
    }

    // 🎌 國定假日補休偵測
    const dates3 = getWeekDates(week);
    const dIdx3  = dayNames.indexOf(btn.dataset.day);
    if(dIdx3 >= 0) {
      const [m3, d3] = dates3[dIdx3].split('/');
      const fullDate3 = `${week.split('-W')[0]}-${m3.padStart(2,'0')}-${d3.padStart(2,'0')}`;
      const emp3 = appData.employees?.find(e => e.name === btn.dataset.emp);
      checkHolidayCompOnSave(btn.dataset.emp, fullDate3, prevShift, btn.dataset.shift||'', emp3);
    }
  }
  // 局部更新記憶體
  invalidateDayViewCache();   // 本店資料已變，單日檢視要重抓
  const week=document.getElementById('weekSelector').value;
  const idx=appData.records.findIndex(r=>r.name===btn.dataset.emp&&r.day===btn.dataset.day&&r.week===week);
  const data={ week, day:btn.dataset.day, name:btn.dataset.emp, shift:btn.dataset.shift||'', location:btn.dataset.loc||'本店', note:btn.dataset.note||'', actualHours:parseFloat(btn.dataset.hours||0), isOT:btn.dataset.ot==='true', isHourly:btn.dataset.hourly==='true', supportEmp:btn.dataset.support||'', approvalStatus:btn.dataset.approval||'', supportUpdatedAt:btn.dataset.supportat||'', requestOff:btn.dataset.reqoff==='true', lawOverrides: btn.dataset.lawoverrides ? JSON.parse(btn.dataset.lawoverrides) : [] };
  const hasData=btn.dataset.shift||btn.dataset.note||btn.dataset.ot==='true'||btn.dataset.support||btn.dataset.reqoff==='true';
  if(hasData) { if(idx!==-1) appData.records[idx]=data; else appData.records.push(data); }
  else { if(idx!==-1) appData.records.splice(idx,1); }
  updateCellUI(btn, btn.dataset.badges||'');
  updateDailyTotals();
  const empObj=appData.employees.find(e=>e.name===btn.dataset.emp)||{name:btn.dataset.emp,role:'待補'};
  updateSummary(eIdx,empObj);
  triggerAutoSave();
}

// ===== 統計 =====
function updateDailyTotals() {
  const sums=[0,0,0,0,0,0,0];
  document.querySelectorAll('.cell-btn').forEach(b=>{
    const idx=dayNames.indexOf(b.dataset.day);
    // 支援別間（location 非本店）不計入當日門市工時
    const loc = b.dataset.loc || '本店';
    const isCrossStore = loc !== '本店' && loc !== '';
    if(idx>=0 && !isCrossStore) sums[idx]+=parseFloat(b.dataset.hours||0);
  });
  sums.forEach((s,i)=>{ const el=document.getElementById(`dt-${i}`); if(el) el.textContent=Math.round(s); });
}

function updateWeekTotalCell() {
  const td = document.getElementById('weekTotalCell');
  if(!td) return;

  const weekStr = document.getElementById('weekSelector').value;
  const store = document.getElementById('storeSelector').value;
  const weekMon = weekStringToDate(weekStr);
  const monthKey = `${weekMon.getFullYear()}-${String(weekMon.getMonth()+1).padStart(2,'0')}`;

  // 本週全店總工時（本店出勤、非休假、非外派）
  let weekH = 0;
  (appData.allStoresRecords || []).forEach(r => {
    if(r._store !== store || r.week !== weekStr) return;
    const loc = r.location || '本店';
    if(loc !== '本店' && loc !== '') return;
    if(!r.shift || ['排休','指休','特休','補休'].includes(r.shift)) return;
    weekH += parseFloat(r.actualHours || 0);
  });

  // 累計至本週人力成本（不含公司負擔）
  let monthCost = 0;
  (appData.employees || []).forEach(emp => {
    if(emp.name.startsWith('🆘')) return;
    const role = emp.role || '';
    const isPartTime = isPartTimeEmp(emp);
    if(isPartTime) {
      const wage = parseFloat(emp.wage || 0);
      let monthH = 0;
      (appData.allStoresRecords || []).forEach(r => {
        if(!isEmpRecord(r, store, emp.name)) return;
        if(getRecordMonth(r) !== monthKey) return;
        if(r.week > weekStr) return;
        if(!r.shift || ['排休','指休','特休','補休'].includes(r.shift)) return;
        monthH += parseFloat(r.actualHours || 0);
      });
      monthCost += Math.round(wage * monthH);
    } else {
      const rec = (appData.salaryRecData || {})[emp.name];
      const base = parseFloat(rec?.baseSalary ?? emp.baseSalary ?? 0);
      const attend = parseFloat(rec?.fullAttendBonus ?? emp.fullAttendBonus ?? 0);
      monthCost += base + attend;
    }
  });

  const r10 = v => Math.round(v * 10) / 10;
  const mLabel = weekMon.getMonth() + 1;
  td.innerHTML = `<div style="font-size:11px;line-height:1.9;font-weight:600;">
    <span style="color:#1a73e8;">週總工時：${r10(weekH)}h</span><br>
    <span style="color:#34a853;">${mLabel}月人力：$${monthCost.toLocaleString()}</span>
  </div>`;
}
