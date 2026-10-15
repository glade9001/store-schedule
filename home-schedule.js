// 首頁之四：initApp（登入後畫首頁）、下週班表發布提示、今日班別、我的班表。2026-10-16 從 home-page.js 原封不動切出來（整理第 4 階段）。

// 打卡卡呈現：一律可點（2026-09-23 起打卡不再分階段開放，clockIn.stage／enabledByStore 已移除）。
// 這也順便解掉舊的 2026-09-15 雷：以前設定還沒讀到會把 stage 當 'off' 而讓整張卡消失
// （iPhone 新加入主畫面的 App 與 Safari 分開存資料＝沒有 appConfig 快取），現在不看設定就沒這個問題。
function applyHomeClockCard(){
  try{
    const cc=document.getElementById('homeClockCard');
    if(!cc) return;
    cc.style.display='';
    cc.onclick=()=>{ window.location.href='clock.html'; }; cc.style.cursor='pointer';
    updateHomeClockStatus(); updateHomeAttnAlert();
  }catch(e){}
}

async function initApp() {
  if(await checkMaintenance()) return; // 維護模式：非管理者顯示維護畫面、不進 App
  showSystemNotice(); // 不 await：公告慢不影響首頁載入
  showLoading('載入個人資料中...');
  const storeLabel = currentUser.store || '全門市';
  const dName = currentUser.displayName || currentUser.empName || '使用者';

  applyHomeClockCard();

  // ✅ 讀取門市 displayNameMap（設定 sheet 和待處理清單都需要）
  displayNameMap = {};
  displayNameMap[currentUser.empName] = dName;
  try {
    const usersSnap = await window.db.collection('users').where('store','==', currentUser.store||'').get().catch(()=>null);
    if(usersSnap) usersSnap.forEach(d => {
      const a = d.data();
      if(a.empName && a.displayName) displayNameMap[a.empName] = a.displayName;
    });
  } catch(e) {}

  // 更新 header
  document.getElementById('headerName').textContent = dName;
  document.getElementById('headerRole').textContent = (ROLE_LABELS[currentUser.role] || currentUser.role || '管理者') + ' · ' + (PERM_LABELS[currentUser.permission] || '');
  document.getElementById('headerStore').textContent = storeLabel;
  document.getElementById('headerAvatar').textContent = dName ? dName[0] : '👤';

  // ===== 根據權限調整 UI =====
  // 待處理卡片：所有人都顯示（員工看代辦，管理者看排班/薪資/特休等）
  document.getElementById('pendingCard').style.display = 'block';

  initHomeNav(); // 常用功能 3＋3 與 ☰（home-nav.js）；讀回設定後視情況自動跳新版教學
  initHomePush(); // 主畫面開啟紀錄、加入主畫面膠囊、推播訂閱同步（home-push.js）
  checkSalaryAck(); // 背景檢查薪資待簽收，完成後顯示橫幅
  checkPnlPending(); // 背景檢查經營績效待輸入
  checkHireDateGate(); // 店長：補齊缺到職日的員工（強制）
  checkPnlAnomaly(); // 店長：經營績效資料異常提醒（如營業淨額多打一位數）
  checkLeaveHint(); // 背景檢查下週劃休提醒

  const permColors = { employee: '#34a853', manager: '#1a73e8', owner: '#9334e6', admin: '#d93025' };
  document.getElementById('headerStore').style.background = (permColors[currentUser.permission] || '#5f6368') + '55';


  // ✅ 班表讀取加 timeout + catch，任何錯誤都不影響整頁顯示
  await Promise.race([
    loadTodayShifts().catch(() => {}),
    new Promise(res => setTimeout(res, 5000))
  ]);
  loadStats().catch(() => {});
  loadPendingItems();
  if (typeof hgLoad === 'function') hgLoad();   // 首頁團購儀表板（home-gb.js）
  if (typeof hdLoad === 'function') hdLoad();   // 首頁每日營業（home-ds.js）

  document.getElementById('appShell').classList.add('active');
  hideLoading();
}

// ===== 我的班表（本週+下週）=====
let homeCurrentWeek = '';
let homeCanGoNext = false;
let homePublishUnsubscribe = null;

// 下週班表已發布的首頁橫幅。
// 2026-09-02 起「班表已發布」不再發 LINE（免費額度 200 則/月，光這條就吃掉約 77 則，而且它是
// 每週固定時間的常規、完全可預期）。改由這個橫幅承接——資料本來就已經即時訂閱了，
// 只是過去沒有主動講出來，員工得自己發現「下週」按鈕變亮。
// 關掉的狀態記在 localStorage（一人一裝置一週一次），不寫 Firestore：這只是顯示偏好，
// 沒必要為它增加寫入量，換裝置重看一次也無妨。
function nextWeekBannerKey(weekStr) {
  return 'homeNextWeekSeen:' + (currentUser?.empName || '') + ':' + weekStr;
}
function dismissNextWeekBanner() {
  const w = getNextWeekString();
  try { localStorage.setItem(nextWeekBannerKey(w), '1'); } catch (e) { /* 無痕模式等：關掉就好，不留記錄 */ }
  const el = document.getElementById('homeNextWeekBanner');
  if (el) el.style.display = 'none';
}
function updateNextWeekBanner(nextWeekStr) {
  const el = document.getElementById('homeNextWeekBanner');
  if (!el) return;
  let seen = false;
  try { seen = localStorage.getItem(nextWeekBannerKey(nextWeekStr)) === '1'; } catch (e) { /* 讀不到就當沒看過 */ }
  // 只在「停在本週」時出現：翻到別週還跳「下週已發布」會很錯亂
  const show = homeCanGoNext && !seen && homeCurrentWeek === getCurrentWeekString();
  el.style.display = show ? 'flex' : 'none';
  if (show) {
    el.onclick = () => { dismissNextWeekBanner(); homeChangeWeek(1); };
    el.style.cursor = 'pointer';
  }
}

function subscribeNextWeekPublish(store, nextWeekStr) {
  if (homePublishUnsubscribe) {
    homePublishUnsubscribe();
    homePublishUnsubscribe = null;
  }
  const update = (published) => {
    homeCanGoNext = published || isAutoPublishedHome(nextWeekStr);
    const nextBtn = document.getElementById('homeNextBtn');
    if (nextBtn) {
      nextBtn.style.opacity = (homeCanGoNext && homeCurrentWeek === getCurrentWeekString()) ? '1' : '0.3';
    }
    updateNextWeekBanner(nextWeekStr);
  };
  homePublishUnsubscribe = window.db
    .collection('stores').doc(store)
    .collection('weeks').doc(nextWeekStr)
    .onSnapshot(
      snap => update(snap.exists ? !!snap.data().published : false),
      ()   => update(false)
    );
}

async function loadTodayShifts() {
  homeCurrentWeek = getCurrentWeekString();
  const store = currentUser?.store;
  if (store) subscribeNextWeekPublish(store, getNextWeekString());
  await loadMySchedule();
}

async function homeChangeWeek(offset) {
  const p = homeCurrentWeek.split('-W');
  let yr = parseInt(p[0]), wk = parseInt(p[1]);
  wk += offset;
  if(wk < 1) { yr--; wk = 52; }
  if(wk > 52) { yr++; wk = 1; }
  const newWeek = `${yr}-W${wk < 10 ? '0'+wk : wk}`;

  const thisWeek = getCurrentWeekString();
  const nextWeek = getNextWeekString();

  // 上週邊界：不能早於上週
  const tp = thisWeek.split('-W');
  let ty = parseInt(tp[0]), tw = parseInt(tp[1]) - 1;
  if(tw < 1) { ty--; tw = 52; }
  const prevWeek = `${ty}-W${tw < 10 ? '0'+tw : tw}`;
  if(offset < 0 && newWeek < prevWeek) {
    showToast('⚠️ 最多只能查看上週班表');
    return;
  }

  // 下週邊界：只有「本週→下週」時才檢查發布狀態；已在下週就不能再往後
  if(offset > 0) {
    if(homeCurrentWeek === nextWeek) {
      showToast('⚠️ 已是最新班表');
      return;
    }
    if(homeCurrentWeek === thisWeek) {
      // ✅ 即時判斷，不依賴非同步的 homeCanGoNext
      const nextWk = getNextWeekString();
      const canGo = homeCanGoNext || isAutoPublishedHome(nextWk);
      if(!canGo) {
        showToast('⚠️ 下週班表尚未發布');
        return;
      }
    }
  }

  homeCurrentWeek = newWeek;
  updateNextWeekBanner(nextWeek); // 翻到別週就把「下週已發布」橫幅收起來
  await loadMySchedule();
}

async function loadMySchedule() {
  const empName = currentUser.empName;
  const store = currentUser.store;
  const weekStr = homeCurrentWeek;
  const el = document.getElementById('homeWeekShifts');
  const labelEl = document.getElementById('homeWeekLabel');
  const prevBtn = document.getElementById('homePrevBtn');
  const nextBtn = document.getElementById('homeNextBtn');

  if(!el) return;
  if(!store || !empName) {
    if(labelEl) labelEl.textContent = '無個人班表';
    el.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:13px;padding:10px 0;">管理帳號未綁定門市</div>`;
    return;
  }

  const dates = getWeekDates(weekStr);
  const thisWeekStr = getCurrentWeekString();
  const p = thisWeekStr.split('-W');
  let ty = parseInt(p[0]), tw = parseInt(p[1]) - 1;
  if(tw < 1) { ty--; tw = 52; }
  const prevWeekStr = `${ty}-W${tw < 10 ? '0'+tw : tw}`;
  const nextWeekStr = getNextWeekString();

  let tag = '';
  if(weekStr === thisWeekStr) tag = '（本週）';
  else if(weekStr === nextWeekStr) tag = '（下週）';
  else if(weekStr === prevWeekStr) tag = '（上週）';
  if(labelEl) labelEl.textContent = `${dates[0]} ～ ${dates[6]}${tag}`;

  el.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:6px 0;">載入中...</div>`;

  try {
    const withTimeout = (p, ms=5000) =>
      Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);

    // ✅ 本店班表 + 其他門市 weeks（支援記錄在目的地門市的 weeks 裡）
    // r.name = '🆘待補X'，r.supportEmp = '來源門市-empName'（例如「聯鑫-淡」）
    const otherStores = (appConfig.stores || []).filter(s => s !== store);
    const [snap, ...otherSnaps] = await Promise.all([
      withTimeout(window.db.collection('stores').doc(store).collection('weeks').doc(weekStr).get()),
      ...otherStores.map(s =>
        withTimeout(window.db.collection('stores').doc(s).collection('weeks').doc(weekStr).get())
      )
    ]);

    const data = snap?.exists ? snap.data() : {};
    const records = data.records || [];
    let myRecs = records.filter(r => r.name === empName);

    // 調店過渡期：帳號已切到新店，但排班記錄仍在舊店 → fallback 到其他門市查自己的記錄
    if (myRecs.length === 0) {
      for (let i = 0; i < otherSnaps.length; i++) {
        if (!otherSnaps[i]?.exists) continue;
        const fallback = (otherSnaps[i].data().records || []).filter(r => r.name === empName);
        if (fallback.length > 0) { myRecs = fallback; break; }
      }
    }

    // 在其他門市 weeks 找 supportEmp === '本店-自己empName' 且 approved
    const mySupportKey = `${store}-${empName}`; // 例如「聯鑫-淡」
    const supportRecs = [];
    otherSnaps.forEach((s, idx) => {
      if(!s?.exists) return;
      const toStore = otherStores[idx];
      (s.data().records || []).forEach(r => {
        if(r.approvalStatus === 'approved' && r.supportEmp === mySupportKey) {
          supportRecs.push({ ...r, _supportStore: toStore });
        }
      });
    });
    console.log('[支援] key:', mySupportKey, 'found:', supportRecs.length);

    // › 按鈕：本週視圖由 onSnapshot 控制；下週視圖禁止再往後
    if(nextBtn) nextBtn.style.opacity = (weekStr === thisWeekStr && homeCanGoNext) ? '1' : '0.3';

    if(prevBtn) prevBtn.style.opacity = weekStr === prevWeekStr ? '0.3' : '1';

    const dNames = ['週一','週二','週三','週四','週五','週六','週日'];
    const now = new Date();
    const todayStr = `${now.getMonth()+1}/${now.getDate()}`;

    el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;">` +
      dNames.map((day, i) => {
        const rec = myRecs.find(r => r.day === day) || {};
        const shift = rec.shift || '';
        const homeOff = shift === '排休' || shift === '指休';
        const isEmpty = !shift;
        const isToday = dates[i] === todayStr;

        // ✅ 支援班
        const suppRec = supportRecs.find(r => r.day === day);
        const hasSupport = !!suppRec;

        // 派去他店支援＝當天實際有上班。本店那格通常是「排休」（人不在本店），
        // 若讓排休贏就會變成「支援日顯示休」（同仁回報的 bug）。
        // 規則：本店空白或排休/指休 → 顯示支援班；本店有實班（同日兩頭跑）→ 顯示本店班＋🆘 標記。
        const showSupport = hasSupport && (isEmpty || homeOff);
        const isOff = homeOff && !showSupport;

        const bg = showSupport ? '#f0fdf4' : isOff ? '#fce8e6' : isEmpty ? '#f8fafc' : '#e8f0fe';
        const clr = showSupport ? '#16a34a' : isOff ? '#d93025' : isEmpty ? '#bbb' : '#1a73e8';
        const displayShift = showSupport ? (suppRec.shift || '支援') : isOff ? '休' : (shift || '–');

        return `<div style="text-align:center;background:${bg};border-radius:8px;padding:5px 2px;${isToday ? 'box-shadow:0 0 0 2px var(--primary);' : ''}">
          <div style="font-size:11px;color:${isToday ? 'var(--primary)' : 'var(--text-muted)'};font-weight:${isToday ? 800 : 500};text-align:center;">${dates[i]}</div>
          <div style="font-size:10px;color:var(--text-muted);text-align:center;">${day}</div>
          <div style="font-size:13px;color:${clr};font-weight:${isEmpty && !showSupport ? 400 : 900};margin-top:2px;text-align:center;letter-spacing:-0.5px;">${displayShift}</div>
          ${rec.note ? `<div style="font-size:9px;color:#0088aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;">${rec.note}</div>` : ''}
          ${hasSupport ? `<div style="font-size:8px;color:#16a34a;font-weight:700;text-align:center;margin-top:1px;">🆘 ${suppRec._supportStore}</div>` : ''}
        </div>`;
      }).join('') + `</div>`;

    if(weekStr === thisWeekStr) {
      updateTodayShiftBadge(myRecs, dates, dNames, todayStr, supportRecs);
    }
  } catch(e) {
    el.innerHTML = `<div style="color:var(--danger);font-size:12px;text-align:center;">載入失敗</div>`;
  }
}

// 從 YYYY-Www 取得週一的 Date 物件（與 schedule-V2 同邏輯）
function weekStringToDateHome(weekStr) {
  const [yr, wk] = weekStr.split('-W').map(Number);
  const jan4 = new Date(yr, 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() || 7) - 1));
  const mon = new Date(startOfWeek1);
  mon.setDate(startOfWeek1.getDate() + (wk - 1) * 7);
  return mon;
}

// 週五自動發布判斷（下週班表的上週五 18:00 起即視為已發布）
function isAutoPublishedHome(weekStr) {
  const weekMon = weekStringToDateHome(weekStr);
  const prevFri = new Date(weekMon);
  prevFri.setDate(weekMon.getDate() - 3); // 週一 - 3 = 上週五
  prevFri.setHours(18, 0, 0, 0);
  return new Date() >= prevFri;
}

window.addEventListener('beforeunload', () => {
  if (homePublishUnsubscribe) homePublishUnsubscribe();
});
