// 排班頁（schedule-V2.html）之一：全域狀態、週次工具、登入後載入（window.onload）、發布、換週。
// 2026-10-16 整理第 4 階段：原本 3,478 行一個檔，原封不動按功能切成 7 個檔（串回去逐位元組相同），依序載入：
//   page（本檔）→ leave 特休補休 → save 存檔與讀資料 → emp 員工視角 → views 檢視模式與三店人力 → table 表格與改班 → summary 統計、待補看板、匯出
// ===== 全域狀態 =====
let currentUser = null;
let appConfig = { stores: [], shifts: [], shiftHours: {} };
let appData = { employees: [], records: [], allStoresRecords: [], allStoresEmployees: {}, leaveRequests: [], salaryRecData: {} };
let currentWeekDates = [];
let virtualRowNames = [];
let undoStack = [];
let currentCell = null;
let autoSaveTimer = null;
let isPaintMode = false;
let paintShift = '';
let isDragging = false;
// 員工視角週次
let empWeekStr = '';

const dayNames = ['週一','週二','週三','週四','週五','週六','週日'];
// weekStr + dayName → 'YYYY-MM-DD'
function dayToFullDate(weekStr, dayName) {
  const dIdx = dayNames.indexOf(dayName);
  if(dIdx < 0) return '';
  const mon = weekStringToDate(weekStr);
  const d = new Date(mon);
  d.setDate(mon.getDate() + dIdx);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// 台灣國定假日 2026-2027
// 國定假日：全專案唯一來源在 holidays.js（原本各頁一份拷貝、五份互相矛盾且全錯）
const TW_HOLIDAYS_SCHED = builtinHolidayMap();

// 取得顯示名字（有 displayName 用新名，否則用原名）
function getDisplayName(empName) {
  if(!empName) return empName;
  return (appData.displayNameMap && appData.displayNameMap[empName]) || empName;
}

// ===== 權限判斷 =====
const canSchedule = () => ['manager','owner','admin'].includes(currentUser?.permission);
const canScheduleStore = (store) => {
  if(['owner','admin'].includes(currentUser?.permission)) return true;
  if(currentUser?.permission === 'manager') {
    // 店長只能編輯本店，其他門市唯讀
    return store === currentUser?.store;
  }
  return false;
};
const canViewAllStores = () => ['manager','owner','admin'].includes(currentUser?.permission);
const canApprove = () => ['manager','owner','admin'].includes(currentUser?.permission);

// ===== 工具函式 =====
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
function showLoading(txt) {
  document.getElementById('loadingSub').textContent = txt || '載入中...';
  const ov = document.getElementById('loadingOverlay');
  ov.classList.remove('hidden');
  ov.style.display = 'flex';
}
function hideLoading() {
  const ov = document.getElementById('loadingOverlay');
  ov.classList.add('hidden');
  setTimeout(() => { ov.style.display = 'none'; }, 400);
}
function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function getWeekDates(wStr) {
  let p = wStr.split('-W'); let yr = parseInt(p[0]); let wk = parseInt(p[1]);
  let d = new Date(yr, 0, 1); let day = d.getDay();
  d.setDate(d.getDate() + (wk - 1) * 7);
  let offset = day <= 4 ? 1 - day : 8 - day;
  d.setDate(d.getDate() + offset);
  let res = [];
  for(let i=0; i<7; i++) { res.push((d.getMonth()+1)+'/'+d.getDate()); d.setDate(d.getDate()+1); }
  return res;
}
// 週次字串必須是上面 getWeekDates() 的精準反函式（每週以「週一」起算）。
// 舊寫法直接把「日期＋時間」套年度週次：週界會隨該年 1/1 是星期幾而變，
// 導致每個週六/週日都算成下一週 —— 與「跳到含今天的週次」的原意相反。
function week1MondayOf(yr) {
  const d = new Date(yr, 0, 1), day = d.getDay();
  d.setDate(d.getDate() + (day <= 4 ? 1 - day : 8 - day));
  return d;
}
function weekStrOfDate(dt) {
  const mon = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); // 去掉時間
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));               // 退到該日所屬的週一
  let yr = mon.getFullYear();
  if(mon < week1MondayOf(yr)) yr--; else if(mon >= week1MondayOf(yr + 1)) yr++;
  const w = Math.round((mon - week1MondayOf(yr)) / 604800000) + 1;
  return `${yr}-W${w < 10 ? '0'+w : w}`;
}
function getNextWeekString() {
  const d = new Date(); d.setDate(d.getDate() + 7);
  return weekStrOfDate(d);
}
function getCurrentWeekString() {
  return weekStrOfDate(new Date());
}
// 計算某年有幾週（52 或 53）：12/28 永遠落在該年最後一週
function weeksInYear(yr) {
  return parseInt(weekStrOfDate(new Date(yr, 11, 28)).split('-W')[1], 10);
}

function weekStringToDate(wStr) {
  let p = wStr.split('-W'); let yr = parseInt(p[0]); let wk = parseInt(p[1]);
  let d = new Date(yr, 0, 1); let day = d.getDay();
  d.setDate(d.getDate() + (wk - 1) * 7);
  let offset = day <= 4 ? 1 - day : 8 - day;
  d.setDate(d.getDate() + offset);
  return d;
}
// ✅ 調職週判斷 Helper（全域）
// 直接複用 weekStringToDate，確保與系統其他週計算一致
function getWeekMondayStr(ws) {
  const mon = weekStringToDate(ws); // weekStringToDate 回傳週一
  return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
}
function getWeekSundayStr(ws) {
  const mon = weekStringToDate(ws);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return `${sun.getFullYear()}-${String(sun.getMonth()+1).padStart(2,'0')}-${String(sun.getDate()).padStart(2,'0')}`;
}

function weekLabelFromStr(wStr) {
  const dates = getWeekDates(wStr);
  return `${dates[0]} ～ ${dates[6]}`;
}

// 判斷是否已自動發布：每週五 18:00 自動發布「下週」班表
// 對給定的 weekStr，其「上週五」= 該週週一 - 3 天
// 若今天 >= 上週五 18:00，代表到了可發布的時間點
function isAutoPublished(weekStr) {
  const weekMon = weekStringToDate(weekStr);
  const prevFri = new Date(weekMon);
  prevFri.setDate(weekMon.getDate() - 3); // 週一 - 3 = 上週五
  prevFri.setHours(18, 0, 0, 0);
  return new Date() >= prevFri;
}

// 判斷畫休是否已鎖定（週五前三天=週二？依原程式：往前3天=週四）
function isWeekLocked(weekStr) {
  const weekMon = weekStringToDate(weekStr);
  const lockDate = new Date(weekMon);
  lockDate.setDate(weekMon.getDate() - 3); // 前一週週五
  lockDate.setHours(0, 0, 0, 0);
  return new Date() >= lockDate;
}

// ===== 初始化 =====
window.onload = async () => {
  showLoading('驗證登入狀態...');

  // 驗證登入狀態
  // 先查 localStorage（記住我），再查 sessionStorage
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if(!saved) {
    localStorage.setItem('redirectAfterLogin', 'schedule-V2.html');
    window.location.replace('home.html');
    return;
  }
  try {
    currentUser = JSON.parse(saved);
  } catch(e) {
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('currentUser');
    window.location.replace('home.html');
    return;
  }

  const _fbAuth = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(fb => { u(); r(fb); }); });
  if (!_fbAuth) { localStorage.removeItem('currentUser'); sessionStorage.removeItem('currentUser'); window.location.replace('home.html'); return; }
  await syncHolidayMapInto(TW_HOLIDAYS_SCHED, [new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1]); // 國定假日跟著系統設定（holidays.js）

  showLoading('載入系統設定...');
  try {
    // 先用 localStorage 快取快速顯示，同時背景讀 Firebase
    const cachedConfig = localStorage.getItem('appConfig');
    if(cachedConfig) {
      try { appConfig = JSON.parse(cachedConfig); } catch(e) {}
    }

    // 讀取設定（加 timeout 保護）
    try {
      const snap = await Promise.race([
        window.db.collection('settings').doc('globalConfig').get(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      if(snap.exists) {
        appConfig = snap.data();
        localStorage.setItem('appConfig', JSON.stringify(appConfig));
      }
    } catch(e) {
      console.warn('設定讀取失敗，使用快取：', e.message);
      // 若有快取就繼續，否則用預設
      if(!appConfig.stores || appConfig.stores.length === 0) {
        appConfig = { stores: [currentUser.store || '門市'], shifts: ['7-15','15-23','23-07','18-23','指休','排休'], shiftHours: {'7-15':8,'15-23':8,'23-07':8,'18-23':5} };
      }
    }

    // Header
    document.getElementById('headerStoreBadge').textContent = currentUser.store || '全門市';

    // 門市選擇器
    const sel = document.getElementById('storeSelector');
    (appConfig.stores || []).forEach(s => sel.innerHTML += `<option value="${s}">${s}</option>`);
    const lastStore = localStorage.getItem('lastStore') || currentUser.store || appConfig.stores[0] || '';
    sel.value = lastStore;

    // 管理者排班視角預設下週，員工視角在下方各自設定
    document.getElementById('weekSelector').value = getNextWeekString();
    // 員工視角：週五後預設顯示「下週」（已自動發布），週四前顯示「本週」
    {
      const _nextWk = getNextWeekString();
      empWeekStr = isAutoPublished(_nextWk) ? _nextWk : getCurrentWeekString();
    }

    // 判斷模式：?mode=admin 進排班管理，其他進查閱
    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode');
    const isAdminMode = (mode === 'admin') && canSchedule();

    if(isAdminMode) {
      document.getElementById('adminView').style.display = 'flex';
      document.getElementById('empView').style.display = 'none';
      document.getElementById('appTitle').textContent = '📋 排班管理';
      // 店長：可切換所有門市查看，但只有本店可以編輯/發布
      if(currentUser.permission === 'manager') {
        sel.value = currentUser.store; // 預設本店
        // 不 disabled，讓店長可以切換看其他門市
      }
      document.getElementById('publishBtn').style.display = 'flex';
      // 系統管理員顯示補休修復按鈕
      if(currentUser.permission === 'admin') {
        const fixBtn = document.getElementById('compFixBtn');
        if(fixBtn) fixBtn.style.display = 'inline-block';
      }
      updateViewToggleUI();
      await fetchAllStoreData();
    } else {
      // 查閱模式：所有人都進員工視角（查看圖片）
      document.getElementById('adminView').style.display = 'none';
      document.getElementById('empView').style.display = 'block';
      document.getElementById('appTitle').textContent = '📅 查看班表';

      // 門市選擇器初始化
      const empStoreSel = document.getElementById('empStoreSelector');
      const empStoreWrap = document.getElementById('empStoreSelectWrap');
      if(canSchedule()) {
        // 店長以上：顯示門市選擇器
        empStoreWrap.style.display = 'block';
        empStoreSel.innerHTML = '';
        (appConfig.stores || []).forEach(s => {
          empStoreSel.innerHTML += `<option value="${s}">${s}</option>`;
        });
        empStoreSel.value = currentUser.store || appConfig.stores[0];
      } else {
        // 員工：隱藏選擇器，鎖定本店
        empStoreWrap.style.display = 'none';
        const myStore = currentUser.store || appConfig.stores[0];
        sel.value = myStore;
      }

      // 初始化：跳到含今天的週次
      empWeekStr = getCurrentWeekString();
      updateEmpWeekLabel();
      await loadEmpView();
    }

    document.getElementById('appShell').classList.add('active');
    updateHeaderInfo();
    // 預覽模式提示
    const isPreview = sessionStorage.getItem('isPreviewMode') === '1';
    const pb = document.getElementById('previewBanner');
    if(pb) pb.classList.toggle('show', isPreview);
    hideLoading();
  } catch(e) {
    hideLoading();
    alert('載入失敗：' + e.message);
  }
};

// ===== 發布功能 =====
let weekPublishData = {}; // weekStr -> { published, publishedAt, publishedBy }

async function fetchPublishStatus(store, weekStr) {
  try {
    const snap = await window.db.collection('stores').doc(store).collection('weeks').doc(weekStr).get();
    if(snap.exists) {
      const d = snap.data();
      weekPublishData[weekStr] = {
        published: d.published || false,
        publishedAt: d.publishedAt || null,
        publishedBy: d.publishedBy || ''
      };
    } else {
      weekPublishData[weekStr] = { published: false, publishedAt: null, publishedBy: '' };
    }
    updatePublishBtn(store, weekStr);
  } catch(e) {}
}

function updatePublishBtn(store, weekStr) {
  const btn = document.getElementById('publishBtn');
  const notifyBtn = document.getElementById('notifyBtn');
  const pd = weekPublishData[weekStr] || {};
  const isPublished = pd.published || isAutoPublished(weekStr);
  // 店長只能發布本店
  if(!canScheduleStore(store)) {
    btn.style.display = 'none';
    if(notifyBtn) notifyBtn.style.display = 'none';
    if(typeof asdRefreshBtn === 'function') asdRefreshBtn();
    return;
  }
  btn.style.display = 'flex';
  // 「立即通知」只在本店、已發布時可用（已發布週的異動才需通知）
  if(notifyBtn) notifyBtn.style.display = isPublished ? 'flex' : 'none';
  if(isPublished) {
    btn.classList.add('published');
    document.getElementById('publishBtnIcon').textContent = '✅';
    document.getElementById('publishBtnText').textContent = '已發布';
  } else {
    btn.classList.remove('published');
    document.getElementById('publishBtnIcon').textContent = '🚀';
    document.getElementById('publishBtnText').textContent = '發布';
  }
  if(typeof asdRefreshBtn === 'function') asdRefreshBtn(); // 🤖 產生草稿：已發布的週不能用
}

// 店長按「立即通知」→ 呼叫 flushScheduleNotify，馬上把本週班表異動發給相關員工
// （管道由後端 notifyEmployees 決定：有開推播的人只收推播，沒開的才發 LINE）
async function manualNotifySchedule() {
  const store = document.getElementById('storeSelector').value;
  const weekStr = document.getElementById('weekSelector').value;
  if(!store || !weekStr) return;
  if(!confirm(`立即通知「${store}」${weekStr} 班表異動給相關員工（有開推播發推播，否則 LINE）？\n（未按此鈕，系統也會在最後一次修改滿 10 分鐘後自動通知）`)) return;
  const btn = document.getElementById('notifyBtn');
  const old = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled = true; btn.innerHTML = '<span>⏳</span><span>發送中</span>'; }
  try {
    const fn = firebase.app().functions('asia-east1').httpsCallable('flushScheduleNotify');
    const res = await fn({ store, weekStr });
    const sent = (res && res.data && res.data.sent) || 0;
    alert(sent > 0 ? `✅ 已通知 ${sent} 位員工` : '✅ 已送出（本週目前無班次異動需通知）');
  } catch(e) {
    alert('通知失敗：' + (e.message || e));
  } finally {
    if(btn){ btn.disabled = false; btn.innerHTML = old; }
  }
}

// 找本週所有「空白格」（在職員工×七天，無班別；離職鎖死格不算）— 依 appData，跨檢視皆正確
function getBlankCellsData(weekStr){
  const blanks = [];
  (appData.employees||[]).forEach(emp=>{
    if(String(emp.name).startsWith('🆘')) return;
    dayNames.forEach(day=>{
      if(emp.retireDate){ const cd=dayToFullDate(weekStr,day); if(cd && cd>=emp.retireDate) return; } // 離職鎖死格
      const rec = appData.records.find(r=>r.name===emp.name && r.day===day && r.week===weekStr);
      if(!(rec && rec.shift && String(rec.shift).trim()!=='')) blanks.push({ name:emp.name, day });
    });
  });
  return blanks;
}
function fillBlanksWithOff(weekStr, blanks){
  blanks.forEach(({name,day})=>{
    const idx = appData.records.findIndex(r=>r.name===name && r.day===day && r.week===weekStr);
    const data = { week:weekStr, day, name, shift:'排休', location:'本店', note:'', actualHours:0, isOT:false, isHourly:false, supportEmp:'', approvalStatus:'', requestOff:false, lawOverrides:[] };
    if(idx!==-1) appData.records[idx]=data; else appData.records.push(data);
  });
}

async function togglePublish() {
  const store = document.getElementById('storeSelector').value;
  const weekStr = document.getElementById('weekSelector').value;
  if(!canScheduleStore(store)) { showToast('❌ 您無權限發布此門市班表'); return; }

  const pd = weekPublishData[weekStr] || {};
  const isPublished = pd.published || isAutoPublished(weekStr);

  if(isPublished && pd.published) {
    if(!confirm('確定要取消發布嗎？員工將看不到班表。')) return;
  } else if(!isPublished) {
    if(!confirm('確定要發布此週班表嗎？員工將可以看到。\n\n這週如果有國定假日，發布時會依班表自動發放正職的國定假日補休（沒上班的會撤回）。')) return;
    // 發布前：偵測空白格，詢問是否填「休」
    const blanks = getBlankCellsData(weekStr);
    if(blanks.length){
      if(confirm(`此週有 ${blanks.length} 個空白格。\n\n要把空白處都填為「休」再發布嗎？\n確定＝填休後發布；取消＝保留空白直接發布。`)){
        fillBlanksWithOff(weekStr, blanks);
        renderSchedule();
        await saveScheduleData(false);
      }
    }
  } else {
    showToast('下週班表已於週五自動發布，無法取消。如需修改請重新排班後儲存。');
    return;
  }

  showLoading('更新發布狀態...');
  try {
    const newPublished = !pd.published;
    const now = new Date();
    await window.db.collection('stores').doc(store).collection('weeks').doc(weekStr).set({
      published: newPublished,
      publishedAt: newPublished ? now.toISOString() : null,
      publishedBy: newPublished ? (currentUser.displayName || currentUser.empName) : ''
    }, { merge: true });

    weekPublishData[weekStr] = {
      published: newPublished,
      publishedAt: newPublished ? now.toISOString() : null,
      publishedBy: newPublished ? (currentUser.displayName || currentUser.empName) : ''
    };
    updatePublishBtn(store, weekStr);
    hideLoading();
    showToast(newPublished ? '✅ 班表已發布！員工現在可以查看' : '班表已取消發布');
  } catch(e) {
    hideLoading();
    showToast('❌ 操作失敗：' + e.message);
  }
}

// ===== 週次切換 =====
async function goToThisWeek() {
  await flushCurrentWeek(); // 先存目前週再跳到下週
  document.getElementById('weekSelector').value = getNextWeekString();
  historyEditUnlocked = false;
  fetchAllStoreData();
}

async function onStoreChange() {
  // 依目前模式決定行為
  const urlParams = new URLSearchParams(window.location.search);
  const isAdminMode = (urlParams.get('mode') === 'admin') && canSchedule();
  if(isAdminMode) {
    await flushCurrentWeek(loadedStore); // 先存「舊門市」目前週，避免換店時 autosave 跨店覆蓋
    fetchAllStoreData();
  } else {
    // 查閱模式：重新載入員工視角
    updateEmpWeekLabel();
    loadEmpView();
  }
}

// 歷史班表解鎖狀態（每次切換週次後重置）
let historyEditUnlocked = false;
let loadedStore = null; // 目前已載入的門市（換店前 flush 舊門市用）

async function changeWeek(offset) {
  const input = document.getElementById('weekSelector');
  if(!input.value) return;

  // 往前限制：管理者最多查閱 2 個月前
  if(offset < 0) {
    const p = input.value.split('-W');
    let yr = parseInt(p[0]), wk = parseInt(p[1]);
    wk += offset;
    if(wk < 1) { yr--; wk = weeksInYear(yr); }
    const newWeekStr = `${yr}-W${wk < 10 ? '0'+wk : wk}`;
    const newMon = weekStringToDate(newWeekStr);
    const now = new Date();
    // 2個月前的第一天
    const limitDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    if(newMon < limitDate) {
      showToast('⚠️ 最多只能查閱 2 個月前的班表');
      return;
    }
  }

  historyEditUnlocked = false; // 切換週次後重置解鎖狀態
  await flushCurrentWeek(); // 先存目前週，避免未存編輯遺失 / 跨週覆蓋
  input.stepUp(offset);
  fetchAllStoreData();
}

// weekSelector 直接輸入時也套用 2 個月往前限制
async function onWeekSelectorChange() {
  await flushCurrentWeek(); // 先存目前畫面的週（依格子自己的週），再載入新選的週
  const val = document.getElementById('weekSelector').value;
  if(!val) return;
  const newMon = weekStringToDate(val);
  const now = new Date();
  const limitDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  if(newMon < limitDate) {
    showToast('⚠️ 最多只能查閱 2 個月前的班表');
    // 恢復到 2 個月前的第一週
    document.getElementById('weekSelector').value = weekStrOfDate(limitDate);
  }
  historyEditUnlocked = false;
  fetchAllStoreData();
}

// 判斷目前選取的週次是否為已過的歷史班表
function isHistoryWeek(weekStr) {
  const weekMon = weekStringToDate(weekStr);
  const weekSun = new Date(weekMon);
  weekSun.setDate(weekMon.getDate() + 6);
  weekSun.setHours(23, 59, 59, 999);
  return new Date() > weekSun;
}

// 解鎖歷史班表編輯
function unlockHistoryEdit() {
  if(!confirm('⚠️ 歷史班表修改需謹慎！\n\n確定要編輯此已過週次的班表嗎？')) return;
  historyEditUnlocked = true;
  renderSchedule();
  showToast('✏️ 歷史班表已解鎖，可進行編輯');
}

// 更新歷史鎖定 UI 狀態
function updateHistoryLockUI(weekStr, store) {
  const lockBanner = document.getElementById('historyLockBanner');
  const editBtn = document.getElementById('editHistoryBtn');
  const isHistory = isHistoryWeek(weekStr);
  const canEdit = canScheduleStore(store);

  if(isHistory && canEdit && !historyEditUnlocked) {
    lockBanner.style.display = 'flex';
    editBtn.style.display = 'inline-flex';
  } else {
    lockBanner.style.display = 'none';
    editBtn.style.display = 'none';
  }  if(typeof asdRefreshBtn === 'function') asdRefreshBtn(); // 🤖 產生草稿：已過去的週不能用
}


// ===== 同步狀態 =====
function setSyncStatus(type, msg) {
  const el = document.getElementById('syncStatus');
  if(!el) return;
  el.className = 'sync-status' + (type === 'syncing' ? ' syncing' : '');
  el.innerHTML = `<div class="sync-dot"></div><span>${msg}</span>`;
}
