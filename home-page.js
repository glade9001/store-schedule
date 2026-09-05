// ===== 全域狀態 =====
let currentUser = null;  // { name, store, role, permission, username }
let appConfig = { stores: [], shifts: [], shiftHours: {} };
let empListCache = {};
let weekRecordsCache = {};
let displayNameMap = {}; // ✅ empName → displayName 對應表
let currentEmpAdminStore = '';

const ROLE_LABELS = { 工讀: '工讀生', 正職: '正職員工', 副店長: '副店長', 店長: '店長' };
const PERM_LABELS = { employee: '👤 員工', manager: '🏪 店長', owner: '👑 加盟主', admin: '⚙️ 系統管理者' };

// ===== 權限判斷核心 =====
const canViewAllStores = () => ['manager','owner','admin'].includes(currentUser?.permission);
const canSchedule = () => ['manager','owner','admin'].includes(currentUser?.permission);
const canManageEmployee = () => ['manager','owner','admin'].includes(currentUser?.permission);
const canManageAccounts = () => ['manager','owner','admin'].includes(currentUser?.permission);
const canViewAllSalary = () => ['owner','admin'].includes(currentUser?.permission);
const canViewSalaryConfig = () => ['owner','admin'].includes(currentUser?.permission);
const canViewReport = () => ['owner','admin'].includes(currentUser?.permission);
const canApprove = () => ['manager','owner','admin'].includes(currentUser?.permission);
const canSysConfig = () => currentUser?.permission === 'admin';
const isManagerOnly = () => currentUser?.permission === 'manager';

// ===== 工具函式 =====
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function showLoading(txt) {
  const ov = document.getElementById('loadingOverlay');
  ov.querySelector('.loading-sub').textContent = txt || '載入中...';
  ov.classList.remove('hidden');
  ov.style.display = 'flex';
}
function hideLoading() {
  const ov = document.getElementById('loadingOverlay');
  ov.classList.add('hidden');
  setTimeout(() => { ov.style.display = 'none'; }, 400);
}

function showWip(name) {
  document.getElementById('wipTitle').textContent = name + ' 開發中';
  document.getElementById('wipDesc').textContent = `「${name}」功能正在積極建置中，預計近期上線！敬請期待。`;
  document.getElementById('wipModal').classList.add('active');
}
function closeWip(e) {
  if(e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
}
function openModal(id) {
  document.getElementById(id).classList.add('active');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function getGreeting() {
  const h = new Date().getHours();
  if(h < 6) return { greet: '深夜辛苦了', icon: '🌙' };
  if(h < 12) return { greet: '早安，今天也加油！', icon: '🌅' };
  if(h < 18) return { greet: '午安，保持精神！', icon: '☀️' };
  return { greet: '晚上好，辛苦了！', icon: '🌆' };
}

function getWeekDates(wStr) {
  let p = wStr.split('-W'); let yr = parseInt(p[0]); let wk = parseInt(p[1]);
  let d = new Date(yr, 0, 1); let day = d.getDay();
  d.setDate(d.getDate() + (wk - 1) * 7);
  let offset = day <= 4 ? 1 - day : 8 - day;
  d.setDate(d.getDate() + offset);
  let res = [];
  for(let i=0; i<7; i++) {
    res.push((d.getMonth()+1) + '/' + d.getDate()); 
    d.setDate(d.getDate()+1);
  }
  return res;
}
// 週次字串必須是上面週次→日期換算的精準反函式（每週以「週一」起算）。
// 只「對齊週一」還不夠：跨年首尾週（如 2027/1/4~1/10）仍會差一週，故一律走本函式。
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
const dayNames = ['週一','週二','週三','週四','週五','週六','週日'];
function getTodayDayName() {
  // ⚠️ getDay() 週日回傳 0（不是 7）。原本用 1-based 的 [null,'週一',…] 對照表配 `|| '週一'`
  //    保底，週日會落在 null → 被保底吃成「週一」，於是首頁打卡卡每個週日都去讀週一的班
  //    （2026-08-23 員工回報：當天休假，卡片卻說「你今天 08-16 的班已開始」）。
  //    改用 0-based 對照表直接索引，不留保底值——保底值正是把錯誤蓋掉的元凶。
  return ['週日','週一','週二','週三','週四','週五','週六'][new Date().getDay()];
}

// 首頁打卡卡：依今日排班＋今日打卡顯示狀態（有排班未打上班卡且已過開始→整卡變色）
async function updateHomeClockStatus(){
  const card=document.getElementById('homeClockCard');
  const icon=document.getElementById('homeClockIcon');
  const sub=document.getElementById('homeClockSub');
  if(!card||!sub) return;
  const store=currentUser.store, emp=currentUser.empName;
  const GREEN='linear-gradient(135deg,#34a853,#1e7e34)', GREEN_SH='0 3px 12px rgba(52,168,83,.3)';
  const RED='linear-gradient(135deg,#ea4335,#c5221f)', RED_SH='0 3px 14px rgba(234,67,53,.4)';
  const setGreen=(ic,txt)=>{ card.style.background=GREEN; card.style.boxShadow=GREEN_SH; if(icon)icon.textContent=ic; sub.textContent=txt; };
  const setRed=(ic,txt)=>{ card.style.background=RED; card.style.boxShadow=RED_SH; if(icon)icon.textContent=ic; sub.textContent=txt; };
  if(!store){ return; } // 無歸屬門市（如人力支援）→ 維持預設
  try{
    const ds=new Date(); const dss=`${ds.getFullYear()}-${String(ds.getMonth()+1).padStart(2,'0')}-${String(ds.getDate()).padStart(2,'0')}`;
    const dayName=getTodayDayName();
    const [wd, att]=await Promise.all([
      window.db.collection('stores').doc(store).collection('weeks').doc(getCurrentWeekString()).get().catch(()=>null),
      window.db.collection('stores').doc(store).collection('attendance').where('date','==',dss).where('empName','==',emp).get().catch(()=>null)
    ]);
    // 今日排班（本店班 or 已核准支援班）
    const shifts=[];
    if(wd&&wd.exists)(wd.data().records||[]).forEach(r=>{
      if(r.day!==dayName) return;
      const mine=(r.name===emp)||(r.supportEmp===`${store}-${emp}`&&r.approvalStatus==='approved');
      if(!mine) return;
      parseShiftSegs(r.shift).forEach(g=>shifts.push({shift:r.shift, startMs:shiftTimeMs(dss,g.startH)}));
    });
    // 今日打卡
    let nIn=0,nOut=0;
    const countPunch=snap=>{ if(snap) snap.forEach(d=>{ const t=d.data().type; if(t==='上班')nIn++; else if(t==='下班')nOut++; }); };
    countPunch(att);
    // 支援日：本店查無班 → 找他店已核准的支援記錄（當天實際上班的門市與打卡紀錄都在那邊）
    let supportStore='';
    if(!shifts.length){
      const others=(appConfig.stores||[]).filter(s=>s!==store);
      const snaps=await Promise.all(others.map(s2=>
        window.db.collection('stores').doc(s2).collection('weeks').doc(getCurrentWeekString()).get().catch(()=>null)
      ));
      snaps.forEach((sn,i)=>{
        if(!sn||!sn.exists) return;
        (sn.data().records||[]).forEach(r=>{
          if(r.day!==dayName) return;
          if(r.supportEmp!==`${store}-${emp}`||r.approvalStatus!=='approved') return;
          supportStore=others[i];
          parseShiftSegs(r.shift).forEach(g=>shifts.push({shift:r.shift, startMs:shiftTimeMs(dss,g.startH)}));
        });
      });
      if(supportStore){
        const sAtt=await window.db.collection('stores').doc(supportStore).collection('attendance')
          .where('date','==',dss).where('empName','==',emp).get().catch(()=>null);
        countPunch(sAtt);
      }
    }
    const atTail = supportStore ? `（支援 ${supportStore}）` : '';
    if(!shifts.length){ setGreen('🕐','今日無排班｜需要時可打卡'); return; }
    if(nIn>nOut){ setGreen('🟢','上班中，記得打下班卡'); return; }
    if(nIn>0){ setGreen('✅','今日已完成打卡'); return; }
    // 有排班、尚未打上班卡
    shifts.sort((a,b)=>a.startMs-b.startMs);
    const up=shifts.find(s=>Date.now()<=s.startMs+punchWindowMs().inAfter)||shifts[0];
    if(Date.now()>=up.startMs){ setRed('⚠️',`你今天 ${up.shift}${atTail} 的班已開始，還沒打上班卡！`); }
    else { setGreen('🕐',`今天 ${up.shift}${atTail} 上班，記得準時打卡`); }
  }catch(e){}
}

// ===== 首頁缺卡／出勤異常提醒（近 7 天）=====
// 2026-08-17 新增。LINE 免費額度只有 200 則/月，店長端的即時缺卡/異常通知已改成每週一彙整，
// 中間幾天就靠這張卡補上即時性——首頁顯示不花額度，而且永遠是最新的。
// 成本控制：只查近 7 天、一次查詢同時算「自己的」與「全店的」（避免 empName 等值 + date 範圍
// 需要複合索引），結果在 sessionStorage 快取 5 分鐘。
const ATTN_CACHE_MIN = 5;
async function updateHomeAttnAlert(){
  const box=document.getElementById('homeAttnAlert');
  if(!box) return;
  const store=currentUser.store, emp=currentUser.empName;
  if(!store||!emp) return;
  const isLead=['manager','owner','admin'].includes(currentUser.permission);
  // 提醒起始日：這天以前的缺卡／異常不再主動提醒（紀錄本身仍完整保留，出勤管理照樣查得到）。
  // 2026-08-17 設此線的原因：半點班 bug 修好前累積了大量系統自己造成的缺卡，
  // 全部拿來提醒只會變成雜訊，索性從修好當天重新起算。改日期只要動 Firestore，不必重新部署。
  const attnSince=((appConfig.clockIn||{}).attnSince)||'';
  const ck=`attnAlert:${store}:${emp}:${attnSince}`;   // 起始日改變時舊快取自動失效
  let data=null;
  try{
    const c=JSON.parse(sessionStorage.getItem(ck)||'null');
    if(c && Date.now()-c.at < ATTN_CACHE_MIN*60000) data=c;
  }catch(e){}
  if(!data){
    const from=new Date(Date.now()-6*86400000);
    let fromStr=`${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,'0')}-${String(from.getDate()).padStart(2,'0')}`;
    if(attnSince && attnSince>fromStr) fromStr=attnSince;   // 取兩者較晚者
    try{
      const snap=await window.db.collection('stores').doc(store).collection('attendance')
        .where('date','>=',fromStr).get();
      let mine=0, stMiss=0, stAnom=0; const anomTs=[];
      snap.forEach(d=>{
        const r=d.data()||{};
        if(r.voided) return;
        const isMiss=(r.status==='缺卡'||r.type==='缺卡');
        const isAnom=(r.status==='遲到'||r.status==='早退');
        if(isMiss) stMiss++; else if(isAnom){ stAnom++;
          // 未讀判定用：只留時間戳（近 7 天約 10 筆，體積可忽略）
          const t=(typeof r.tsMs==='number')?r.tsMs:Date.parse(r.deviceTs||r.ts||'');
          if(isFinite(t)) anomTs.push(t);
        }
        if(isMiss && r.empName===emp) mine++;
      });
      data={at:Date.now(), mine, stMiss, stAnom, anomTs, from:fromStr};
      sessionStorage.setItem(ck, JSON.stringify(data));
    }catch(e){ return; }   // 查不到就安靜略過，不要卡住首頁
  }
  // 期間標籤：起始日把 7 天視窗截短時，改寫成「自 M/D 起」，不要謊稱近 7 天
  const d7=new Date(Date.now()-6*86400000);
  const d7Str=`${d7.getFullYear()}-${String(d7.getMonth()+1).padStart(2,'0')}-${String(d7.getDate()).padStart(2,'0')}`;
  const period=(data.from&&data.from>d7Str)
    ? `自 ${+data.from.slice(5,7)}/${+data.from.slice(8,10)} 起`
    : '近 7 天';
  const rows=[];
  if(data.mine>0){
    rows.push(`<div onclick="window.location.href='my-attendance.html'" style="display:flex;align-items:center;gap:12px;padding:13px 15px;background:linear-gradient(135deg,#ea4335,#c5221f);border-radius:14px;cursor:pointer;box-shadow:0 3px 14px rgba(234,67,53,.35);">
      <div style="font-size:26px;line-height:1;">🔴</div>
      <div style="flex:1;">
        <div style="font-size:15.5px;font-weight:900;color:#fff;">你有 ${data.mine} 筆缺卡未補登</div>
        <div style="font-size:12px;color:rgba(255,255,255,.92);margin-top:2px;">${period}・影響工時與薪資，請盡快補登 →</div>
      </div>
    </div>`);
  }
  // 缺卡＝待辦：影響工時與薪資，店長去催補登、補完就消失，有明確的完成狀態 → 維持醒目橘卡
  if(isLead && data.stMiss>0){
    rows.push(`<div onclick="window.location.href='attendance.html'" style="display:flex;align-items:center;gap:12px;padding:13px 15px;background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;cursor:pointer;${data.mine>0?'margin-top:8px;':''}">
      <div style="font-size:24px;line-height:1;">📋</div>
      <div style="flex:1;">
        <div style="font-size:14.5px;font-weight:900;color:#c2410c;">${store} ${period} ${data.stMiss} 筆缺卡</div>
        <div style="font-size:12px;color:#9a3412;margin-top:2px;">請提醒員工補打卡 →</div>
      </div>
    </div>`);
  }
  // 遲到／早退＝知悉：既成事實，店長做什麼都不會讓它消失，跟待辦混在同一行紅字只會稀釋訊號。
  // 但整個拿掉又會讓店長要等到週一彙整才知道（週二發生的事週一才看到太遲），所以改成
  // 灰色知悉列＋LINE 式未讀數：浮水印記「最後看到哪個時間點」，比它新的才算未讀。
  // 浮水印先放 localStorage——零後端改動、零 Firestore 成本、不必動 rules；代價是換裝置會重新變未讀。
  if(isLead && data.stAnom>0){
    const seen=await attnSeenWatermark(store);
    const unread=(data.anomTs||[]).filter(t=>t>seen).length;
    if(unread>0){
      rows.push(`<div onclick="markAttnSeen('${store}');window.location.href='attendance.html'" style="display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--bg-soft,#f8fafc);border:1px solid #e2e8f0;border-radius:14px;cursor:pointer;margin-top:8px;">
        <div style="position:relative;font-size:20px;line-height:1;">👀<span style="position:absolute;top:-4px;right:-7px;min-width:16px;height:16px;padding:0 4px;background:#ef4444;color:#fff;border-radius:8px;font-size:10px;font-weight:900;line-height:16px;text-align:center;">${unread}</span></div>
        <div style="flex:1;">
          <div style="font-size:13.5px;font-weight:800;color:#475569;">${store} ${period} ${data.stAnom} 筆遲到／早退</div>
          <div style="font-size:11.5px;color:#94a3b8;margin-top:1px;">知悉用，不需處理 →</div>
        </div>
        <button onclick="event.stopPropagation();markAttnSeen('${store}',true);" title="標為已讀" style="background:none;border:none;color:#94a3b8;font-size:17px;font-weight:900;cursor:pointer;padding:2px 6px;line-height:1;">✕</button>
      </div>`);
    }
  }
  if(!rows.length){ box.style.display='none'; box.innerHTML=''; return; }
  box.innerHTML=rows.join('');
  box.style.display='';
}

// ===== 出勤知悉列的已讀浮水印（2026-08-28 改為跨裝置同步）=====
// 只記「這位店長最後看到哪個時間點」，比浮水印新的遲到才算未讀（LINE 語意）。
// 逐筆已讀要往法定出勤紀錄塞 seenBy 陣列、每人每筆各寫一次，既污染紀錄又昂貴。
//
// 存 notifyPrefs/{empName}.attnSeenAt.{店} = epoch ms。
//  · 用既有的 notifyPrefs 而不是新集合：firestore.rules 的 catch-all 已涵蓋，不必動規則
//    （動規則有踩過雷，見 reference_firestore_rules_gotcha）。
//  · localStorage 仍保留為即時快取：先用本機值畫，遠端回來取「兩者較大值」再重畫，
//    避免開首頁時閃一下未讀數。取較大值也確保在 A 裝置標已讀不會被 B 裝置的舊值蓋回去。
//  · 成本：首頁每次多讀 1 份小文件，標已讀時多寫 1 次。
let _attnSeenCache = {};
function _attnSeenLocal(store){ try{ return Number(localStorage.getItem(`attnSeenAt:${store}`)||0); }catch(e){ return 0; } }

async function attnSeenWatermark(store){
  const local = _attnSeenLocal(store);
  if(_attnSeenCache[store] != null) return Math.max(local, _attnSeenCache[store]);
  let remote = 0;
  try{
    const d = await window.db.collection('notifyPrefs').doc(currentUser.empName).get();
    if(d.exists) remote = Number(((d.data().attnSeenAt)||{})[store] || 0) || 0;
  }catch(e){ /* 讀不到就只用本機值，不要卡住首頁 */ }
  _attnSeenCache[store] = remote;
  const merged = Math.max(local, remote);
  // 遠端比本機新 → 回寫本機，下次開頁不必等網路
  if(remote > local){ try{ localStorage.setItem(`attnSeenAt:${store}`, String(remote)); }catch(e){} }
  return merged;
}

function markAttnSeen(store, rerender){
  const now = Date.now();
  try{ localStorage.setItem(`attnSeenAt:${store}`, String(now)); }catch(e){}
  _attnSeenCache[store] = now;
  // 跨裝置同步：寫進 notifyPrefs（set+merge 會併入 map 的既有鍵，不會蓋掉其他門市）
  try{
    window.db.collection('notifyPrefs').doc(currentUser.empName)
      .set({ attnSeenAt: { [store]: now } }, { merge:true })
      .catch(()=>{});   // 寫失敗不影響本機已讀，下次標記會再試
  }catch(e){}
  if(rerender) updateHomeAttnAlert();
}

// ===== 登入系統 =====
window.onload = async () => {
  showLoading('連線雲端資料庫中...');
  try {
    const cachedConfig = localStorage.getItem('appConfig');
    if(cachedConfig) {
      try { appConfig = JSON.parse(cachedConfig); } catch(e) {}
    }
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
      console.warn('設定讀取失敗，使用快取');
    }

    // 手機 Google 登入：先處理 redirect 回傳結果，避免閃回登入頁
    try {
      const redirectProfile = await handleGoogleRedirectResult();
      if (redirectProfile) {
        currentUser = redirectProfile;
        _cacheCurrentUser(redirectProfile);
        await _afterLogin(redirectProfile, { skipPwdChange: true, showBindSuggestion: true });
        return;
      }
    } catch(e) {
      if(e.code === 'not-linked') {
        // Google 帳號未綁定工號：顯示登入頁並提示
        hideLoading();
        showLoginScreen();
        document.getElementById('loginError').textContent = '❌ 此 Google 帳號尚未綁定工號，請先用工號登入';
        return;
      }
      // 其他錯誤（網路、環境不支援等）：忽略，繼續走正常 onAuthStateChanged 流程
      console.warn('handleGoogleRedirectResult 非預期錯誤:', e);
    }

    // Firebase Auth 狀態偵測（一次性）
    const unsub = firebase.auth().onAuthStateChanged(async fbUser => {
      unsub();
      if(fbUser) {
        try {
          const profile = await _loadProfile(fbUser);
          if(!profile) {
            await firebase.auth().signOut();
            showLoginScreen();
            return;
          }
          currentUser = profile;
          _cacheCurrentUser(profile);
          await _afterLogin(profile).catch(e => {
            console.error('initApp 失敗:', e);
            document.getElementById('appShell').classList.add('active');
            hideLoading();
          });
        } catch(e) {
          await firebase.auth().signOut();
          showLoginScreen();
          if(e.code === 'disabled' || e.code === 'resigned-expired') {
            document.getElementById('loginError').textContent = '⛔ ' + e.message;
          }
        }
      } else {
        showLoginScreen();
      }
    });
  } catch(e) {
    hideLoading();
    document.getElementById('loginScreen').classList.add('active');
    document.getElementById('loginError').textContent = '⚠️ 連線失敗：' + e.message;
  }
};

function _cacheCurrentUser(profile) {
  const remember = localStorage.getItem('rememberMe') === '1';
  if(remember) {
    localStorage.setItem('currentUser', JSON.stringify(profile));
  } else {
    sessionStorage.setItem('currentUser', JSON.stringify(profile));
    localStorage.removeItem('currentUser');
  }
}

function showLoginScreen() {
  hideLoading();
  const mt = document.getElementById('maintenanceScreen'); if(mt) mt.style.display = 'none'; // 避免維護畫面蓋住登入頁
  document.getElementById('loginScreen').classList.add('active');
  const lastUser = localStorage.getItem('lastLoginUsername');
  const rememberMe = localStorage.getItem('rememberMe') === '1';
  if(lastUser) document.getElementById('loginUsername').value = lastUser;
  if(rememberMe) {
    const cb = document.getElementById('rememberMe');
    if(cb) cb.checked = true;
  }
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim().toUpperCase();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if(!username) { errEl.textContent = '⚠️ 請輸入帳號'; return; }
  if(!/^[A-Z][0-9]{5}$/.test(username)) { errEl.textContent = '⚠️ 帳號格式錯誤（1個字母 + 5碼數字）'; return; }
  if(!password) { errEl.textContent = '⚠️ 請輸入密碼'; return; }

  showLoading('驗證身分中...');
  try {
    const remember = document.getElementById('rememberMe')?.checked;

    // 依「記住我」設定 Firebase 持久性
    await firebase.auth().setPersistence(
      remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION
    );

    const profile = await authLogin(username, password);
    if(!profile) {
      // Auth 驗證成功但 users 文件不存在（account/users 不同步）→ 給清楚訊息，不進入會崩潰的初始化
      await firebase.auth().signOut().catch(()=>{});
      hideLoading();
      errEl.textContent = '❌ 此帳號尚未建立個人資料，請聯絡管理員在「員工管理」重設一次密碼（工號 ' + username + '）';
      return;
    }
    currentUser = profile;

    localStorage.setItem('lastLoginUsername', username);
    if(remember) {
      localStorage.setItem('rememberMe', '1');
      localStorage.setItem('currentUser', JSON.stringify(profile));
    } else {
      localStorage.removeItem('rememberMe');
      localStorage.removeItem('currentUser');
      sessionStorage.setItem('currentUser', JSON.stringify(profile));
    }

    document.getElementById('loginScreen').classList.remove('active');
    await _afterLogin(profile, { showBindSuggestion: true });
  } catch(e) {
    hideLoading();
    console.error('登入流程失敗:', e);
    // 防呆：登入後初始化階段若出錯，重新顯示登入畫面，避免整片白畫面
    document.getElementById('loginScreen').classList.add('active');
    const codeMap = {
      'auth/user-not-found': '查無此帳號，請確認工號是否正確',
      'auth/wrong-password': '密碼錯誤，請重新輸入',
      'auth/invalid-credential': '帳號或密碼錯誤，請再次確認',
      'auth/invalid-login-credentials': '帳號或密碼錯誤，請再次確認',
      'auth/too-many-requests': '登入嘗試次數過多，請稍後再試',
      'not-linked': e.message,
      'disabled': e.message,
      'resigned-expired': e.message,
    };
    // 已通過帳密驗證後才發生的錯誤（登入後載入階段）：顯示真正原因，方便對症下藥
    errEl.textContent = '❌ ' + (codeMap[e.code] || ('登入後載入失敗：' + (e.message || e.code || '未知錯誤')));
  }
}

async function doLogout() {
  if(!confirm('確定要登出嗎？')) return;
  await authLogout();
  currentUser = null;
  document.getElementById('appShell').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('loginUsername').value = localStorage.getItem('lastLoginUsername') || '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').textContent = '';
}

// ===== 登入後主流程 =====
async function _afterLogin(profile, { skipPwdChange = false, showBindSuggestion = false } = {}) {
  // 首次登入：先顯示說明視窗（Google 登入者不強制，因為不知道 email 密碼）
  if(!profile.pwdChanged && !skipPwdChange) {
    hideLoading();
    openModal('firstLoginInfoModal');
    return;
  }
  // 離職受限帳號：期限內只開放「查看薪水」，其餘全鎖
  if(profile.resigned) { showResignedHome(profile); return; }
  // 跳轉
  const redirect = localStorage.getItem('redirectAfterLogin');
  if(redirect) {
    localStorage.removeItem('redirectAfterLogin');
    window.location.href = redirect;
    return;
  }
  await initApp();
  if(showBindSuggestion) maybeShowGoogleBindSuggestion();
  // 管理者登入後背景掃描並套用所有到期的待轉換職稱
  if(['manager','owner','admin'].includes(profile.permission)) {
    applyOverduePendingRoles().catch(() => {});
  }
}

// 離職受限首頁：只給查看薪水（preview=true 為 admin 預覽，加返回鈕、不影響真實資料）
function showResignedHome(profile, preview){
  hideLoading();
  try{ document.getElementById('loginScreen').classList.remove('active'); }catch(e){}
  const until = profile.resignAccessUntil || '';
  let el = document.getElementById('resignedScreen');
  if(!el){ el = document.createElement('div'); el.id='resignedScreen'; document.body.appendChild(el); }
  el.style.cssText='position:fixed;inset:0;z-index:99998;background:#f4f6fb;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;';
  el.innerHTML=`
    <div style="font-size:44px;margin-bottom:12px;">🧾</div>
    <div style="font-size:20px;font-weight:900;color:#1e293b;margin-bottom:10px;">${profile.displayName||profile.empName||''}</div>
    <div style="background:#fff3e0;border:1.5px solid #ffc27a;border-radius:12px;padding:12px 16px;font-size:13px;color:#c0620f;font-weight:700;line-height:1.7;max-width:360px;margin-bottom:24px;">
      此帳號已離職，僅開放<b>查看薪資</b>。<br>存取期限至 <b>${until}</b>，逾期將無法登入。
    </div>
    <button onclick="window.location.href='my-salary.html'" style="width:100%;max-width:320px;padding:15px;background:var(--primary,#1a73e8);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer;margin-bottom:12px;">🧾 查看薪水</button>
    <button onclick="doLogout()" style="width:100%;max-width:320px;padding:12px;background:#f1f3f4;color:#334155;border:none;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;">登出</button>
    ${preview?`<button onclick="document.getElementById('resignedScreen').remove()" style="width:100%;max-width:320px;padding:10px;background:none;color:#94a3b8;border:none;font-size:13px;font-weight:700;cursor:pointer;margin-top:14px;">🔙 結束預覽</button>`:''}`;
}
// admin 預覽離職受限畫面（純畫面、不改任何資料）
function previewResigned(){
  closeModal('rolePreviewModal');
  showResignedHome({ displayName:(currentUser.displayName||currentUser.empName||''), empName:currentUser.empName, resignAccessUntil:'（預覽·範例）' }, true);
}

function startFirstLoginSetup() {
  closeModal('firstLoginInfoModal');
  document.getElementById('pwdChangeScreen').classList.add('active');
  document.getElementById('pcOldPwd').focus();
}

// ===== 首次登入改密碼 =====
async function doFirstTimePwdChange() {
  const oldP  = document.getElementById('pcOldPwd').value;
  const newP  = document.getElementById('pcNewPwd').value;
  const newC  = document.getElementById('pcNewPwdC').value;
  const errEl = document.getElementById('pcError');
  errEl.textContent = '';

  if(!oldP || !newP || !newC) { errEl.textContent = '⚠️ 請填寫所有欄位'; return; }
  if(newP !== newC) { errEl.textContent = '⚠️ 兩次新密碼不一致'; return; }
  if(newP.length < 6) { errEl.textContent = '⚠️ 新密碼至少 6 碼'; return; }

  showLoading('設定新密碼中...');
  try {
    await authChangePassword(String(oldP).padEnd(6,'0'), String(newP).padEnd(6,'0'));
    // 標記已完成首次改密碼
    if(currentUser.uid) {
      await window.db.collection('users').doc(currentUser.uid).update({ pwdChanged: true });
    }
    currentUser.pwdChanged = true;
    _cacheCurrentUser(currentUser);

    hideLoading();
    hideLoading();
    document.getElementById('pwdChangeScreen').classList.remove('active');
    document.getElementById('pcOldPwd').value = '';
    document.getElementById('pcNewPwd').value = '';
    document.getElementById('pcNewPwdC').value = '';

    // 首登精靈：改密碼完成 → 確認個人資料 → 綁定 LINE → 進 App
    const redirect = localStorage.getItem('redirectAfterLogin');
    if(redirect) {
      localStorage.removeItem('redirectAfterLogin');
      window.location.href = redirect;
      return;
    }
    startOnboardConfirm();
  } catch(e) {
    hideLoading();
    const codeMap = {
      'auth/wrong-password': '舊密碼錯誤',
      'auth/invalid-credential': '舊密碼錯誤',
      'auth/requires-recent-login': '請重新登入後再設定密碼',
    };
    errEl.textContent = '❌ ' + (codeMap[e.code] || e.message);
  }
}

// ===== 首登精靈：確認個人資料 → LINE 綁定（Feature③）=====
let _afterLineBindCb = null;
async function startOnboardConfirm(){
  try{
    const dn = currentUser.displayName || currentUser.empName || '';
    const roleLabel = (ROLE_LABELS[currentUser.role] || currentUser.role || '');
    const emp = currentUser.empName, st = currentUser.store;
    let hire = '';
    if(st && emp){
      const es = await window.db.collection('stores').doc(st).collection('employees').doc(emp).get().catch(()=>null);
      hire = (es && es.exists && es.data().startDate) ? es.data().startDate : '';
    }
    if(!hire && emp){
      const cy = new Date().getFullYear().toString();
      const lv = await window.db.collection('employees').doc(emp).collection('leaves').doc(cy).get().catch(()=>null);
      hire = (lv && lv.exists && lv.data().hireDate) ? lv.data().hireDate : '';
    }
    const row=(k,v)=>`<div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:var(--text-muted);">${k}</span><b>${v||'—'}</b></div>`;
    document.getElementById('obcInfo').innerHTML =
      row('姓名', dn) + row('職稱', roleLabel) + row('門市', st||'—') + row('到職日', hire);
    openModal('onboardConfirmModal');
  }catch(e){ console.error('startOnboardConfirm', e); initApp(); }
}
function onboardConfirmOK(){
  closeModal('onboardConfirmModal');
  // LINE 綁定於 LINE 端非同步完成；關閉綁定視窗後進入 App，未綁定者首頁仍會持續提醒
  _afterLineBindCb = () => { initApp(); };
  openLineBindModal();
}

// ===== Google 登入 =====
async function doGoogleLogin() {
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  return; // [Google 登入凍結] 暫停 Google 登入功能
  showLoading('Google 登入中...');
  try {
    const profile = await authLoginWithGoogle();
    if (!profile) return; // 手機 redirect 中，頁面即將導航離開
    currentUser = profile;
    _cacheCurrentUser(profile);
    document.getElementById('loginScreen').classList.remove('active');
    await _afterLogin(profile, { skipPwdChange: true, showBindSuggestion: true });
  } catch(e) {
    hideLoading();
    if(e.code === 'not-linked') {
      errEl.textContent = '❌ 此 Google 帳號尚未綁定工號，請先用工號登入';
    } else if(e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
      errEl.textContent = '';
    } else if(e.code === 'auth/popup-blocked') {
      errEl.textContent = '❌ 瀏覽器封鎖了彈窗，請允許本頁彈窗後重試';
    } else if(e.code === 'auth/unauthorized-domain') {
      errEl.textContent = '❌ 此網域尚未授權使用 Google 登入，請聯絡管理員';
    } else if(e.code === 'auth/network-request-failed') {
      errEl.textContent = '❌ 網路連線失敗，請確認網路後重試';
    } else {
      errEl.textContent = '❌ Google 登入失敗，請稍後再試';
    }
  }
}

// ===== Google 綁定建議 =====
function maybeShowGoogleBindSuggestion() {
  return; // [Google 綁定凍結] 暫停顯示綁定建議說明視窗
  if(authIsGoogleLinked()) return;
  setTimeout(() => {
    document.getElementById('googleBindOverlay').classList.add('active');
    document.getElementById('googleBindSheet').classList.add('active');
  }, 1200);
}

async function doGoogleBind() {
  dismissGoogleBind();
  try {
    await authLinkGoogle();
    showToast('✅ Google 帳號已綁定，下次可直接 Google 登入');
  } catch(e) {
    if(e.code === 'auth/popup-closed-by-user') return;
    showToast('❌ 綁定失敗：' + e.message);
  }
}

// ===== 強制 Google 綁定（首次登入流程）=====
async function doMandatoryGoogleBind() {
  const errEl = document.getElementById('googleBindError');
  errEl.textContent = '';
  try {
    await authLinkGoogle();
    sessionStorage.setItem('googleBindDone', '1');
    document.getElementById('googleBindScreen').classList.remove('active');
    const redirect = localStorage.getItem('redirectAfterLogin');
    if(redirect) {
      localStorage.removeItem('redirectAfterLogin');
      window.location.href = redirect;
      return;
    }
    await initApp();
  } catch(e) {
    if(e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    errEl.textContent = '❌ ' + (e.code === 'auth/credential-already-in-use' ? '此 Google 帳號已被其他工號使用' : e.message);
  }
}

async function skipMandatoryGoogleBind() {
  sessionStorage.setItem('googleBindDone', '1');
  document.getElementById('googleBindScreen').classList.remove('active');
  const redirect = localStorage.getItem('redirectAfterLogin');
  if(redirect) {
    localStorage.removeItem('redirectAfterLogin');
    window.location.href = redirect;
    return;
  }
  await initApp();
  // 仍會在 app 內顯示一次 Google 綁定建議
  maybeShowGoogleBindSuggestion();
}

function dismissGoogleBind() {
  document.getElementById('googleBindOverlay').classList.remove('active');
  document.getElementById('googleBindSheet').classList.remove('active');
}

// ===== 薪資待簽收提醒（步驟4）=====
const SALARY_ACK_START = '2026-06'; // 與 my-salary.html 同值
function _ackMonthsFromStart(){
  const now=new Date();
  const cur=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const out=[]; let [y,m]=SALARY_ACK_START.split('-').map(Number);
  // 只納入「已可查看」月份：M 月薪資要 M+1 月才可看，故排除當月(cur)
  for(let i=0;i<60;i++){ const ym=`${y}-${String(m).padStart(2,'0')}`; if(ym>=cur) break; out.push(ym); m++; if(m>12){m=1;y++;} }
  return out;
}
// 經營績效發送日推算(對齊 functions pnlSendDay)：從1號數工作日(跳週末+國定假日)，第3工作天隔一日曆天=公司提供報表日
function pnlSendDayClient(year, month, holidays){
  let count=0;
  for(let day=1; day<=40; day++){
    const dateStr=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dow=new Date(year, month-1, day).getDay(); // 0=日..6=六（本機=台北）
    if(dow===0||dow===6||holidays[dateStr]) continue;
    count++;
    if(count===3) return day+1;
  }
  return 4;
}
// 經營績效待輸入提醒（店長以上）：本店在 2025/07~上月 有未輸入者 → 顯示橫幅
async function checkPnlPending(){
  try{
    if(!['manager','owner','admin'].includes(currentUser?.permission)) return;
    const store = currentUser.store;
    if(!store) return;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), 1); d.setMonth(d.getMonth()-1); // 上個月
    const months=[]; let cy=d.getFullYear(), cm=d.getMonth()+1;
    while(cy>2025 || (cy===2025 && cm>=7)){ months.push(`${cy}-${String(cm).padStart(2,'0')}`); cm--; if(cm<1){cm=12;cy--;} }
    // 上月資料在「公司提供報表日的隔天」後才算待輸入(對齊 LINE 排程 provideDay+1)
    let _holidays={};
    try{ const hs=await window.db.collection('settings').doc('holidays').collection('years').doc(String(now.getFullYear())).get(); if(hs.exists && hs.data().dates) _holidays=hs.data().dates; }catch(e){}
    const _provideDay=pnlSendDayClient(now.getFullYear(), now.getMonth()+1, _holidays);
    if(now.getDate() < _provideDay+1 && months.length) months.shift();
    if(!months.length) return;
    const snap = await window.db.collection('stores').doc(store).collection('pnl').get();
    const have = new Set(); snap.forEach(x=>have.add(x.id));
    const missing = months.filter(m=>!have.has(m));
    if(!missing.length) return;
    const bar = document.getElementById('pnlPendingBanner');
    if(!bar) return;
    document.getElementById('pnlPendingMonths').textContent = missing.length===1
      ? missing[0].replace('-','年')+'月'
      : `${missing.length} 個月`;
    bar.style.display = 'flex';
  }catch(e){ console.error('checkPnlPending', e); }
}
// ===== 店長登入：補齊員工到職日（強制，Feature②）=====
let _hireGateStore = '';
async function checkHireDateGate(){
  try{
    if(!['manager','owner','admin'].includes(currentUser?.permission)) return;
    const store = currentUser.store;
    if(!store) return;
    _hireGateStore = store;
    const empSnap = await window.db.collection('stores').doc(store).collection('employees').get().catch(()=>null);
    if(!empSnap) return;
    const todayStr = new Date().toISOString().slice(0,10);
    const cy = new Date().getFullYear().toString();
    const candidates = [];
    empSnap.forEach(d=>{
      const data = d.data();
      if(['離職','調走'].includes(data.status)) return;
      // 需處理：缺 startDate，或被標記為「待確認」(建檔日預設值等)
      const needsReview = !data.startDate || data.startDateConfirmed === false;
      if(!needsReview) return;
      candidates.push({ name: d.id, startDate: data.startDate||'', confirmed: data.startDateConfirmed, transferDate: data.transferDate||'' });
    });
    if(!candidates.length) return;
    // 缺 startDate 但有可用日期且非待確認 → 靜默同步(調店員工用調入日、否則用到職日)；其餘(待確認/完全無)→ 列給店長核對
    const need = [];
    await Promise.all(candidates.map(async c=>{
      const lv = await window.db.collection('employees').doc(c.name).collection('leaves').doc(cy).get().catch(()=>null);
      const hire = (lv && lv.exists && lv.data().hireDate) ? lv.data().hireDate : '';
      const autoDate = c.transferDate || hire; // 調店進來的以調入日為本店薪資起算，不用到職日
      if(!c.startDate && autoDate && c.confirmed !== false){
        await window.db.collection('stores').doc(store).collection('employees').doc(c.name).set({ startDate: autoDate }, { merge:true });
      } else {
        need.push({ name: c.name, prefill: c.startDate || autoDate || todayStr }); // 待確認 或 完全無到職日
      }
    }));
    if(!need.length) return;
    document.getElementById('hireGateList').innerHTML = need.map(n=>{
      const dn = displayNameMap[n.name] || n.name;
      return `<div style="display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid #eef1f4;">
        <span style="flex:1; font-weight:700; font-size:15px;">${dn}</span>
        <input type="date" data-emp="${n.name.replace(/"/g,'&quot;')}" value="${n.prefill}" style="padding:8px; border:1.5px solid #d0d7de; border-radius:8px; font-size:14px;">
      </div>`;
    }).join('');
    openModal('hireDateGateModal');
  }catch(e){ console.error('checkHireDateGate', e); }
}
async function saveHireDateGate(){
  const inputs = [...document.querySelectorAll('#hireGateList input[data-emp]')];
  if(!inputs.length){ closeModal('hireDateGateModal'); return; }
  if(inputs.some(i=>!i.value)){ showToast('⚠️ 請確認每位員工的到職日都已填寫'); return; }
  showLoading('儲存到職日中...');
  try{
    const cy = new Date().getFullYear().toString();
    for(const i of inputs){
      const emp = i.dataset.emp, date = i.value;
      await window.db.collection('stores').doc(_hireGateStore).collection('employees').doc(emp).set({ startDate: date, startDateConfirmed: true }, { merge:true });
      await window.db.collection('employees').doc(emp).collection('leaves').doc(cy).set({ hireDate: date, store:_hireGateStore }, { merge:true });
    }
    hideLoading();
    closeModal('hireDateGateModal');
    showToast('✅ 已補齊到職日');
  }catch(e){ hideLoading(); showToast('❌ 儲存失敗：'+e.message); }
}
// ===== 經營績效資料異常提醒（店長登入）=====
let _pnlAnomalyMonths=[];
async function checkPnlAnomaly(){
  try{
    if(!['manager','owner','admin'].includes(currentUser?.permission)) return;
    const store = currentUser.store;
    if(!store) return;
    const snap = await window.db.collection('stores').doc(store).collection('pnl').get().catch(()=>null);
    if(!snap) return;
    const bad=[];
    snap.forEach(d=>{ const data=d.data()||{}; const ns=Number(data.netSales); if(ns && ns>10000000 && !data.netSalesAnomalyAck) bad.push({ id:d.id, ns }); });
    if(!bad.length) return;
    _pnlAnomalyMonths=bad;
    const rows=bad.map(b=>{
      const y=b.id.split('-')[0], mo=parseInt(b.id.split('-')[1]);
      const suggest=Math.round(b.ns/10);
      return `<div style="background:#fff5f5; border-left:3px solid #d93025; border-radius:6px; padding:8px 10px; margin-top:8px;">
        <b>${y}年${mo}月</b>：營業淨額登記為 <b style="color:#c5221f;">${b.ns.toLocaleString()}</b> 元，明顯多打一位數（其他月份約 360～400 萬），推估正確值約 <b>${suggest.toLocaleString()}</b> 元。</div>`;
    }).join('');
    document.getElementById('pnlAnomalyBody').innerHTML =
      `系統偵測到「${store}」的經營績效資料異常，此錯誤會拉高年度趨勢與同期比較，請確認並修正：${rows}
       <div style="font-size:12px; color:var(--text-muted); margin-top:10px;">點「前往修正」到經營績效專區編輯該月數字；或「我已確認」暫不再提醒（修正後也會自動停止）。</div>`;
    openModal('pnlAnomalyModal');
  }catch(e){ console.error('checkPnlAnomaly', e); }
}
async function ackPnlAnomaly(){
  try{
    const store=currentUser.store;
    for(const b of _pnlAnomalyMonths){
      await window.db.collection('stores').doc(store).collection('pnl').doc(b.id)
        .set({ netSalesAnomalyAck:true, netSalesAnomalyAckBy:(currentUser.displayName||currentUser.empName||''), netSalesAnomalyAckAt:new Date().toISOString() }, { merge:true });
    }
  }catch(e){}
  closeModal('pnlAnomalyModal');
  showToast('已確認，將不再提醒');
}
async function checkSalaryAck(){
  try{
    if(!currentUser?.uid || !currentUser?.empName) return;
    const myStore=currentUser.store;
    const stores=[myStore, ...((appConfig.stores||[]).filter(s=>s&&s!==myStore))].filter(Boolean);
    const pending=[];
    const _now=new Date();
    const _nowYM=`${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}`;
    const _nowDay=_now.getDate(), _nowHour=_now.getHours();
    // 發薪提醒日：5號遇週末/國定假日順延到下一工作日；當天 15:00 後才提醒(對齊 LINE)
    let _shol={};
    try{ const hs=await window.db.collection('settings').doc('holidays').collection('years').doc(String(_now.getFullYear())).get(); if(hs.exists && hs.data().dates) _shol=hs.data().dates; }catch(e){}
    let _remDay=5; for(let day=5;day<=20;day++){ const ds=`${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`; const dow=new Date(_now.getFullYear(),_now.getMonth(),day).getDay(); if(dow!==0&&dow!==6&&!_shol[ds]){_remDay=day;break;} }
    for(const ym of _ackMonthsFromStart()){
      const [_yy,_mm]=ym.split('-').map(Number);
      const _payYM=_mm===12?`${_yy+1}-01`:`${_yy}-${String(_mm+1).padStart(2,'0')}`;
      if(_payYM===_nowYM && (_nowDay<_remDay || (_nowDay===_remDay && _nowHour<15))) continue;
      // 找本人在該月「已發布」的薪資記錄（先本店，找到就停）
      let rec=null;
      for(const st of stores){
        const snap=await window.db.collection('stores').doc(st).collection('salary').doc(ym).get().catch(()=>null);
        if(snap && snap.exists){
          const d=snap.data();
          if((d.status||'draft')==='published'){
            const r=(d.records||[]).find(x=>x.empName===currentUser.empName);
            if(r){ rec=r; break; }
          }
        }
      }
      if(!rec) continue; // 該月無已發布記錄 → 不提醒
      const ackSnap=await window.db.collection('salaryAck').doc(`${currentUser.uid}_${ym}`).get().catch(()=>null);
      const ack=ackSnap && ackSnap.exists ? ackSnap.data() : null;
      const signed = ack && (ack.signedPayHash||'')===(rec.payHash||'');
      if(!signed) pending.push(ym);
    }
    renderSalaryAckBanner(pending);
  }catch(e){ console.error('checkSalaryAck 失敗', e); }
}
function renderSalaryAckBanner(pending){
  const bar=document.getElementById('salaryAckBanner');
  if(!bar) return;
  if(!pending.length){ bar.style.display='none'; return; }
  document.getElementById('salaryAckMonths').textContent = pending.map(m=>m.replace('-','/')).join('、');
  bar.dataset.month = pending[0];
  bar.style.display='flex';
}
function gotoSalaryAck(){
  const m=document.getElementById('salaryAckBanner')?.dataset.month||'';
  window.location.href='my-salary.html'+(m?`?month=${m}`:'');
}

// ===== 首頁劃休提醒（鼓勵、可關、有劃自動消失）=====
// 截止規則與 leave-request 一致：目標週的申請截止 = 前一週週一 23:59。
// 故提示鎖定「目前仍開放中的最早一週」（下週常已截止），並顯示其區間與截止時間。
const _weekStrOf = weekStrOfDate;
function _firstOpenLeaveWeek(){
  const now=new Date();
  const t=new Date(); const day=t.getDay(); // 0=Sun
  const thisMon=new Date(t); thisMon.setDate(t.getDate()-((day+6)%7)); thisMon.setHours(0,0,0,0);
  for(let off=1; off<=4; off++){
    const mon=new Date(thisMon); mon.setDate(thisMon.getDate()+off*7);
    const deadline=new Date(mon); deadline.setDate(mon.getDate()-7); deadline.setHours(23,59,59,0);
    if(now<=deadline){
      const sun=new Date(mon); sun.setDate(mon.getDate()+6);
      return { weekStr:_weekStrOf(mon), mon, sun, deadline };
    }
  }
  return null;
}
async function checkLeaveHint(){
  try{
    if(!currentUser?.empName || !currentUser?.store) return;
    const bar=document.getElementById('leaveHintBanner'); if(!bar) return;
    const info=_firstOpenLeaveWeek();
    if(!info){ bar.style.display='none'; return; } // 目前無開放中的劃休週
    const wk=info.weekStr;
    bar.dataset.week=wk;
    if(localStorage.getItem('leaveHintDismissed_'+wk)==='1'){ bar.style.display='none'; return; } // 本人已關該週
    // 本人該週是否已有劃休（含排休/特休/補休）
    const snap=await window.db.collection('stores').doc(currentUser.store).collection('leaveRequests')
      .where('empName','==',currentUser.empName).get().catch(()=>null);
    const has = snap && snap.docs.some(d=>{ const r=d.data(); return r.week===wk && !['cancelled','unfulfilled'].includes(r.status); });
    if(has){ bar.style.display='none'; return; }
    const md=x=>`${x.getMonth()+1}/${x.getDate()}`;
    const dow=['日','一','二','三','四','五','六'][info.deadline.getDay()];
    const el=document.getElementById('leaveHintText');
    if(el) el.innerHTML = `${md(info.mon)}–${md(info.sun)} 劃休開放中，需要休假記得去劃休～<br><span style="font-size:11px;font-weight:600;">截止 ${md(info.deadline)}（週${dow}）23:59</span>`;
    bar.style.display='flex';
  }catch(e){ console.error('checkLeaveHint 失敗', e); }
}
async function dismissLeaveHint(){
  const bar=document.getElementById('leaveHintBanner');
  if(!bar) return;
  const wk=bar.dataset.week||'';
  localStorage.setItem('leaveHintDismissed_'+wk,'1');
  bar.style.display='none';
  // 同步寫 Firestore，讓「截止前提醒」的排程知道此人已打X（打X＝不再 LINE 提醒該週）
  try{
    if(currentUser?.store && currentUser?.empName && wk){
      await window.db.collection('stores').doc(currentUser.store)
        .collection('leaveDismiss').doc(`${wk}__${currentUser.empName}`)
        .set({ empName: currentUser.empName, week: wk, dismissedAt: new Date().toISOString() });
    }
  }catch(e){ console.error('leaveDismiss 寫入失敗', e); }
}

// ===== LINE 通知綁定（綁定碼版）=====
// 首頁小條：僅在「未綁定」時顯示，綁定後（下次載入）自動消失
async function checkLineBindHint(){
  try{
    if(!currentUser?.uid) return;
    const el=document.getElementById('lineBindHome'); if(!el) return;
    const bs=await window.db.collection('lineBindings').doc(currentUser.uid).get().catch(()=>null);
    el.style.display = (bs && bs.exists) ? 'none' : 'flex';
  }catch(e){ console.error('checkLineBindHint', e); }
}
function closeLineBind(){ document.getElementById('lineBindOverlay').style.display='none'; const mt=document.getElementById('maintenanceScreen'); if(mt && mt.style.display!=='none') renderMaintenanceNotifyState(); if(_afterLineBindCb){ const cb=_afterLineBindCb; _afterLineBindCb=null; cb(); } }
async function openLineBindModal(){
  document.getElementById('lineBindOverlay').style.display='flex';
  const body=document.getElementById('lineBindBody');
  body.innerHTML='載入中…';
  try{
    const bs=await window.db.collection('lineBindings').doc(currentUser.uid).get().catch(()=>null);
    if(bs && bs.exists){
      const canTest = ['manager','owner','admin'].includes(currentUser.permission);
      body.innerHTML=`<div style="color:#2e7d32;font-weight:800;">✅ 已綁定 LINE 通知</div>
        <div style="margin-top:8px;color:var(--text-muted);">綁定時間：${String(bs.data().boundAt||'').slice(0,16).replace('T',' ')}</div>
        ${canTest ? `<button id="lineTestBtn" onclick="sendTestNotify()" style="width:100%;padding:10px;background:#e7f7ed;color:#06c755;border:none;border-radius:10px;font-weight:800;cursor:pointer;margin-top:14px;">🔔 發送測試通知（僅管理者）</button>` : ''}
        <button onclick="unbindLine()" style="width:100%;padding:10px;background:#fce8e6;color:var(--danger);border:none;border-radius:10px;font-weight:700;cursor:pointer;margin-top:8px;">解除綁定</button>`;
      return;
    }
    const code=String(Math.floor(100000+Math.random()*900000));
    await window.db.collection('lineBindCodes').doc(code).set({
      uid:currentUser.uid, empName:currentUser.empName||'', displayName:currentUser.displayName||currentUser.empName||'', store:currentUser.store||'',
      createdAt:new Date().toISOString(), expiresAt:Date.now()+10*60*1000
    });
    const oa=(appConfig&&appConfig.lineOaUrl)||'';
    const basicId=(oa.match(/@[\w.\-]+/)||[''])[0];
    const url=basicId?`https://line.me/R/oaMessage/${basicId}/?${encodeURIComponent(code)}`:oa;
    const btn = url
      ? `<a href="${url}" target="_blank" style="display:block;text-align:center;background:#06c755;color:#fff;padding:13px;border-radius:10px;font-weight:800;text-decoration:none;margin:12px 0;">➕ 開啟 LINE 加入並帶入綁定碼</a>`
      : `<div style="color:var(--danger);margin:12px 0;font-weight:700;">⚠️ 官方帳號連結尚未設定，請聯絡管理員設定 lineOaUrl。</div>`;
    body.innerHTML=`
      <div style="color:var(--text-muted);">綁定後，薪資發布、班表發布、劃休截止提醒等會主動用 LINE 通知你。</div>
      <div style="margin-top:10px;">點下方按鈕 → 開啟官方帳號 → 若尚未加入請先按「加入」→ 綁定碼已自動帶入，按<strong>送出</strong>即完成。</div>
      ${btn}
      <div style="font-size:12px;color:var(--text-muted);text-align:center;">（萬一沒帶入，手動輸入綁定碼：<strong style="color:var(--primary);letter-spacing:2px;">${code}</strong>，10 分鐘內有效）</div>`;
  }catch(e){ body.innerHTML='載入失敗：'+e.message; }
}
async function sendTestNotify(){
  const btn=document.getElementById('lineTestBtn');
  if(btn){ btn.disabled=true; btn.textContent='傳送中…'; }
  try{
    const fn=firebase.app().functions('asia-east1').httpsCallable('sendTestNotify');
    await fn({});
    if(typeof showToast==='function') showToast('✅ 已送出，請到 LINE 查看');
    if(btn){ btn.textContent='🔔 已送出，請看 LINE'; }
  }catch(e){
    if(typeof showToast==='function') showToast('❌ '+(e.message||'發送失敗'));
    if(btn){ btn.disabled=false; btn.textContent='🔔 發送測試通知（僅管理者）'; }
  }
}
async function unbindLine(){
  if(!confirm('確定解除 LINE 通知綁定？')) return;
  await window.db.collection('lineBindings').doc(currentUser.uid).delete().catch(()=>{});
  closeLineBind();
  if(typeof showToast==='function') showToast('已解除綁定');
}

// ===== 初始化 APP =====
// ===== 系統維護模式 =====
async function checkMaintenance() {
  const mt = document.getElementById('maintenanceScreen');
  if(currentUser?.permission === 'admin') { if(mt) mt.style.display = 'none'; return false; } // 管理者不受影響
  let on = false;
  try { const d = await window.db.collection('settings').doc('maintenance').get(); on = !!(d.exists && d.data().enabled); } catch(e) {}
  if(!on) { if(mt) mt.style.display = 'none'; return false; }
  document.getElementById('appShell').classList.remove('active');
  await renderMaintenanceNotifyState();
  document.getElementById('maintenanceScreen').style.display = 'flex';
  hideLoading();
  return true;
}
async function renderMaintenanceNotifyState() {
  const uid = currentUser.uid;
  const nameEl = document.getElementById('mtName');
  if(nameEl) nameEl.textContent = '👤 ' + (currentUser.displayName || currentUser.empName || '');
  let opted = false, bound = false;
  try { const b = await window.db.collection('lineBindings').doc(uid).get(); bound = !!(b.exists && b.data().lineUserId); } catch(e) {}
  try { const n = await window.db.collection('maintenanceNotify').doc(uid).get(); opted = n.exists; } catch(e) {}
  const bindBtn = document.getElementById('mtBindBtn');
  const btn = document.getElementById('mtNotifyBtn'), hint = document.getElementById('mtNotifyHint');
  if(bindBtn) bindBtn.style.display = bound ? 'none' : 'block'; // 只有「真的已綁定」才隱藏綁定鈕
  if(opted) {
    btn.textContent = '✅ 已登記，完成後通知你'; btn.disabled = true; btn.style.opacity = '.75';
    hint.textContent = bound ? '維護完成會用 LINE 通知你' : '⚠️ 尚未綁定 LINE，請點上方「綁定 LINE」完成，才收得到通知';
  } else {
    btn.textContent = '🔔 維護完成後請通知我'; btn.disabled = false; btn.style.opacity = '1';
    hint.textContent = bound ? '' : '（未綁定 LINE？可先點「綁定 LINE」，或點「通知我」會一起帶你綁定）';
  }
}
async function maintenanceNotifyMe() {
  const uid = currentUser.uid;
  try {
    await window.db.collection('maintenanceNotify').doc(uid).set({
      uid, empName: currentUser.empName || '', displayName: currentUser.displayName || currentUser.empName || '', store: currentUser.store || '', at: new Date().toISOString()
    }, { merge: true });
    let bound = false;
    try { const b = await window.db.collection('lineBindings').doc(uid).get(); bound = !!(b.exists && b.data().lineUserId); } catch(e) {}
    showToast('✅ 已登記，維護完成會通知你');
    await renderMaintenanceNotifyState();
    if(!bound) openLineBindModal(); // 未綁定 → 同時開綁定流程
  } catch(e) { showToast('登記失敗：' + e.message); }
}

async function initApp() {
  if(await checkMaintenance()) return; // 維護模式：非管理者顯示維護畫面、不進 App
  showLoading('載入個人資料中...');
  const storeLabel = currentUser.store || '全門市';
  const dName = currentUser.displayName || currentUser.empName || '使用者';

  // 打卡卡呈現：功能未啟用(off)→整卡隱藏；已啟用但對此人尚未開放(層級未到 或 全面開放下本店未勾選)→變灰標「尚未開放」不可點；正常→綠色可點
  try{
    const clk=(appConfig.clockIn)||{}; const stage=clk.stage||'off';
    const okPerm = stage==='all' || (stage==='manager' && ['manager','owner','admin'].includes(currentUser.permission)) || (stage==='admin' && currentUser.permission==='admin');
    const storeOn = stage!=='all' || ((clk.enabledByStore||{})[currentUser.store]===true);
    const cc=document.getElementById('homeClockCard');
    if(cc){
      if(stage==='off'){ cc.style.display='none'; }
      else if(okPerm && storeOn){ cc.style.display=''; updateHomeClockStatus(); updateHomeAttnAlert(); }
      else {
        cc.style.display='';
        cc.onclick=null; cc.removeAttribute('onclick'); cc.style.cursor='default';
        cc.style.background='linear-gradient(135deg,#9ca3af,#6b7280)'; cc.style.boxShadow='none';
        const sub=document.getElementById('homeClockSub'); if(sub) sub.textContent='尚未開放';
        const arr=document.getElementById('homeClockArrow'); if(arr) arr.style.display='none';
      }
    }
  }catch(e){}

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

  // Greeting
  const now = new Date();
  const { greet, icon } = getGreeting();
  document.getElementById('greetingTime').textContent = `${icon} ${now.getMonth()+1}月${now.getDate()}日 · ${['週日','週一','週二','週三','週四','週五','週六'][now.getDay()]}`;
  document.getElementById('greetingName').textContent = `嗨，${dName}！`;
  document.getElementById('greetingDesc').textContent = greet;
  document.getElementById('greetingBadge').textContent = currentUser.store ? `🏪 ${currentUser.store}` : `🏬 全門市管理`;

  // 個人頁面更新
  document.getElementById('profileAvatar').textContent = dName ? dName[0] : '👤';
  document.getElementById('profileName').textContent = dName;
  document.getElementById('profileRoleText').textContent = ROLE_LABELS[currentUser.role] || currentUser.role || '管理者';
  document.getElementById('profileStoreText').textContent = currentUser.store ? currentUser.store : '全門市';

  // ===== 根據權限調整 UI =====
  // 待處理卡片：所有人都顯示（員工看代辦，管理者看排班/薪資/特休等）
  document.getElementById('pendingCard').style.display = 'block';

  renderQuickBtns();
  checkSalaryAck(); // 背景檢查薪資待簽收，完成後顯示橫幅
  checkPnlPending(); // 背景檢查經營績效待輸入
  checkHireDateGate(); // 店長：補齊缺到職日的員工（強制）
  checkPnlAnomaly(); // 店長：經營績效資料異常提醒（如營業淨額多打一位數）
  checkLeaveHint(); // 背景檢查下週劃休提醒
  checkLineBindHint(); // 未綁定 LINE → 首頁顯示小條

  if(canManageEmployee()) {
    document.getElementById('menuAccountSub').textContent = '管理員工帳號密碼';
  } else {
    document.getElementById('menuAccountSub').textContent = '查看帳號 / 修改密碼';
  }

  const permColors = { employee: '#34a853', manager: '#1a73e8', owner: '#9334e6', admin: '#d93025' };
  document.getElementById('headerStore').style.background = (permColors[currentUser.permission] || '#5f6368') + '55';

  const sysMenuItem = document.getElementById('menuSysConfig');
  if(sysMenuItem) sysMenuItem.style.display = canSysConfig() ? 'flex' : 'none';
  const storeConfigItem = document.getElementById('menuStoreConfig');
  if(storeConfigItem) storeConfigItem.style.display = canSchedule() ? 'flex' : 'none';
  const rolePrevItem = document.getElementById('menuRolePreview');
  if(rolePrevItem) rolePrevItem.style.display = (currentUser.permission === 'admin') ? 'flex' : 'none';

  // ✅ 班表讀取加 timeout + catch，任何錯誤都不影響整頁顯示
  await Promise.race([
    loadTodayShifts().catch(() => {}),
    new Promise(res => setTimeout(res, 5000))
  ]);
  loadStats().catch(() => {});
  loadPendingItems();

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
  const todayStr = new Date().toISOString().split('T')[0];
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
          <div class="stat-val" id="statMonthOT" style="color:var(--danger); font-size:20px;">--</div>
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
    const todayStr = new Date().toISOString().split('T')[0];

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
        Promise.all([
          window.db.collection('employees').doc(empNameStr).collection('leaveBatches').get(),
          window.db.collection('employees').doc(empNameStr).collection('comp').doc(String(thisYear)).get()
        ]).then(([batchSnap, compSnap]) => {
          const todayStr = new Date().toISOString().split('T')[0];
          let totalAvail = 0;
          if(batchSnap) {
            batchSnap.forEach(d => {
              const b = d.data();
              if(b.settled) return;
              const rem = (b.days||0) - (b.used||0);
              if(rem <= 0) return;
              const expDate = b.carried
                ? new Date(b.expireDate).setMonth(new Date(b.expireDate).getMonth()+12) && (() => { const d2=new Date(b.expireDate); d2.setMonth(d2.getMonth()+12); return d2.toISOString().split('T')[0]; })()
                : b.expireDate;
              if(todayStr <= expDate) totalAvail += rem;
            });
          }
          const compData = compSnap?.exists ? compSnap.data() : {};
          const remainComp = Math.max(0, (compData.earned||0) - (compData.used||0));
          
          if(annualLeaveEl) {
            annualLeaveEl.textContent = totalAvail;
            annualLeaveEl.style.color = totalAvail > 0 ? '#7c3aed' : 'var(--text-muted)';
          }
          if(compLeaveEl) {
            compLeaveEl.textContent = remainComp;
            compLeaveEl.style.color = remainComp > 0 ? '#1a73e8' : 'var(--text-muted)';
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

// ===== 待處理事項（店長以上 + 員工自身代辦）=====
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
          const todayStr = now.toISOString().split('T')[0];
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
                return { emp, batchSnap, leaveLegacySnap, compSnap, compPrevSnap };
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

            // === 2. 週年日提醒（今天 = 到職日某個週年）===
            // 滿6個月
            const m6Date = _dateAdd(hireDate, 6);
            if(m6Date === todayStr) {
              storePending.push({ type:'特休週年', desc:`${store}｜${empDisplayName} 今天滿6個月，請至特休管理新增批次（3天）`, link:'leave.html', color:'#9334e6' });
            }
            // 每個週年
            for(let yr = 1; yr <= 30; yr++) {
              const annivDate = _dateAdd(hireDate, yr * 12);
              if(annivDate > todayStr) break;
              if(annivDate === todayStr) {
                const months = yr * 12;
                let days = 0;
                if(months < 24) days = 7;
                else if(months < 36) days = 10;
                else if(months < 48) days = 14;
                else if(months < 60) days = 14;
                else if(months < 120) days = 15;
                else days = Math.min(30, 15 + Math.floor(months/12) - 10 + 1);
                storePending.push({ type:'特休週年', desc:`${store}｜${empDisplayName} 今天滿${yr}年，請至特休管理新增批次（${days}天）`, link:'leave.html', color:'#9334e6' });
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
              // 本年度補休
              if(compSnap?.exists) {
                const cd = compSnap.data();
                const remaining = Math.max(0, (cd.earned||0) - (cd.used||0));
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
    const today = new Date().toISOString().split('T')[0];
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
      // 計算循環任務「下次(或當天)發生日」YYYY-MM-DD（比照 todo.html calcNext）
      const recurNextStr = (todo) => {
        const base=new Date(); base.setHours(0,0,0,0);
        const start=todo.startDate?new Date(todo.startDate):base;
        const end=todo.recurringEnd?new Date(todo.recurringEnd):null;
        if(end&&base>end)return null;
        let next=null;
        if(todo.recurringType==='weekly'){
          const tgt=parseInt(todo.recurringDay||1);
          const dow=base.getDay()===0?7:base.getDay();
          let diff=tgt-dow; if(diff<0)diff+=7;
          next=new Date(base); next.setDate(base.getDate()+diff);
          if(next<start)next.setDate(next.getDate()+7);
        } else if(todo.recurringType==='monthly'){
          const isLast=(todo.recurringDay==='last'||parseInt(todo.recurringDay)===0);
          const dayOf=(yr,mo)=> isLast ? new Date(yr,mo+1,0).getDate() : Math.min(parseInt(todo.recurringDay||1), new Date(yr,mo+1,0).getDate());
          next=new Date(base.getFullYear(),base.getMonth(),dayOf(base.getFullYear(),base.getMonth()));
          if(next<base){const y=base.getFullYear(),m=base.getMonth()+1;next=new Date(y,m,dayOf(y,m));}
          if(next<start){const y=next.getFullYear(),m=next.getMonth()+1;next=new Date(y,m,dayOf(y,m));}
        } else if(todo.recurringType==='custom'){
          const iv=parseInt(todo.recurringInterval||7);
          let cur=new Date(start); while(cur<base)cur.setDate(cur.getDate()+iv); next=cur;
        }
        if(!next)return null;
        if(end&&next>end)return null;
        return `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;
      };
      const myChecks = {};
      checkSnap?.forEach(d => {
        const data=d.data();
        if(data.checked){ myChecks[data.checkKey||data.todoId]=true; myChecks[data.todoId]=true; }
      });

      const isTodoVisible = (t) => {
        if(t.deleted) return false;
        if(t.startDate && today < t.startDate) return false;
        if(t.isRecurring && t.recurringEnd && today > t.recurringEnd) return false;
        if(t.type==='announcement' && !t.isRecurring && t.endDate && today > t.endDate) return false;
        // 循環「公告」只在發生日當天顯示（如每月最後一天提醒），與 todo 頁一致，避免每天都出現
        if(t.isRecurring && t.type==='announcement' && recurNextStr(t) !== today) return false;
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
        const ck = t.isRecurring ? `${t.id}__${today}` : t.id;
        if(myChecks[ck] || myChecks[t.id]) return;
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

  // 確保無論如何都能順利渲染到畫面，UI不會卡死
  const pendingCountEl = document.getElementById('pendingCount');
  if(pendingCountEl) pendingCountEl.textContent = pending.length + ' 件';

  const pendingCard = document.getElementById('pendingCard');
  const badge = document.getElementById('pendingBadgeBar');

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
  if(pending.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:12px 0 4px;font-size:13px;color:var(--text-muted);font-weight:600;">✅ 目前無待辦事項</div>`;
  } else {
    el.innerHTML = pending.map(p => `
      <div class="notice-item" ${p.link ? `style="cursor:pointer;" onclick="window.location.href='${p.link}'"` : ''}>
        <div class="notice-dot" style="background:${p.color};"></div>
        <div style="flex:1;">
          <div class="notice-text"><strong>${p.type}</strong>：${p.desc}</div>
        </div>
        ${p.link ? `<div style="color:var(--primary); font-size:16px; font-weight:900; padding-left:8px;">›</div>` : ''}
      </div>`).join('');
  }
}

// ===== 頁面切換 =====
function switchPage(name) {
  if(name === 'salary') { goToSalary(); return; }

  const pageEl = document.getElementById(`page-${name}`);
  if(!pageEl) { console.warn('找不到頁面:', name); return; }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  pageEl.classList.add('active');
  document.querySelector(`[data-page="${name}"]`)?.classList.add('active');

  // 註：原本這裡呼叫 loadProfilePage()，但該函式全專案都不存在，每次點「個人」都會拋 ReferenceError。
  // 個人頁的欄位（profileName/profileRoleText/profileStoreText）已由 initApp() 於登入時填好，不需另外載入。
}

// ===== 快速功能按鈕動態渲染 =====
function renderQuickBtns() {
  const personal = document.getElementById('grid-personal');
  const mgmt     = document.getElementById('grid-mgmt');
  const mgmtSec  = document.getElementById('mgmtSection');
  if(!personal) return;

  // 折疊狀態記憶
  const mState = localStorage.getItem('funcSection-mgmt') !== 'collapsed';
  setFuncSectionState('mgmt', mState);

  // ===== 常用功能（所有人，3個）=====
  personal.innerHTML = `
    <button class="func-btn blue-dark" onclick="window.location.href='schedule-V2.html'">
      <div class="func-icon">📅</div><div class="func-label">班表</div>
    </button>
    <button class="func-btn purple" onclick="openLeaveSheet()">
      <div class="func-icon">🏖️</div><div class="func-label" style="text-align:center;line-height:1.4;">特補休/劃休</div>
    </button>
    ${currentUser.empName ? `
    <button class="func-btn orange" onclick="window.location.href='my-salary.html'">
      <div class="func-icon">💰</div><div class="func-label">薪水</div>
    </button>` : ''}`;

  // ===== 管理功能（店長以上）=====
  if(!canSchedule()) { mgmtSec.style.display='none'; return; }
  mgmtSec.style.display = 'block';

  mgmt.innerHTML = `
    <button class="func-btn blue-dark" onclick="window.location.href='schedule-V2.html?mode=admin'">
      <div class="func-icon">📋</div><div class="func-label">排班</div>
    </button>
    <button class="func-btn orange-dark" onclick="window.location.href='salary.html'">
      <div class="func-icon">💳</div><div class="func-label">算薪水</div>
    </button>
    <button class="func-btn gray" onclick="openMoreMgmtSheet()">
      <div class="func-icon">⋯</div><div class="func-label">更多管理</div>
    </button>`;

  // 更多管理 sheet 的項目顯示：加盟主專區（人事分析＋薪資匯出）
  const bsOwner = document.getElementById('bsMgmtOwner');
  if(bsOwner) bsOwner.style.display = canViewReport() ? 'flex' : 'none';
  const bsRp = document.getElementById('bsRolePreview');
  if(bsRp) bsRp.style.display = (currentUser?.permission === 'admin') ? 'flex' : 'none';
}

// ===== Bottom Sheet 控制 =====
function openSettingsSheet() {
  // 更新 sheet 裡的使用者資訊
  const dName = displayNameMap[currentUser.empName] || currentUser.empName || '';
  document.getElementById('settingsAvatar').textContent = dName ? dName[0] : '👤';
  document.getElementById('settingsName').textContent = dName || currentUser.empName || '--';
  document.getElementById('settingsRole').textContent =
    ({ employee:'員工', manager:'店長', owner:'加盟主', admin:'系統管理者' }[currentUser.permission] || '') +
    (currentUser.store ? ` · ${currentUser.store}` : '');
  // 系統設定（整合門市設定＋更新日誌）：店長以上顯示，settings.html 內再依權限顯示各區塊
  const canCfg = canSchedule();
  const bsStore = document.getElementById('bsStoreConfig');
  if(bsStore) bsStore.style.display = canCfg ? 'flex' : 'none';
  // 更新日誌：員工才顯示獨立入口（店長以上已整合在系統設定內）
  const bsChangelog = document.getElementById('bsChangelog');
  if(bsChangelog) bsChangelog.style.display = canCfg ? 'none' : 'flex';

  document.getElementById('settingsOverlay').classList.add('active');
  document.getElementById('settingsSheet').classList.add('active');
}
function closeSettingsSheet() {
  document.getElementById('settingsOverlay').classList.remove('active');
  document.getElementById('settingsSheet').classList.remove('active');
}
function openMoreMgmtSheet() {
  const bsOwner = document.getElementById('bsMgmtOwner'); // 加盟主專區（人事分析＋薪資匯出）
  if(bsOwner) bsOwner.style.display = canViewReport() ? 'flex' : 'none';
  const bsRp = document.getElementById('bsRolePreview');
  if(bsRp) bsRp.style.display = (currentUser?.permission === 'admin') ? 'flex' : 'none';
  const bsAudit = document.getElementById('bsMgmtAudit'); // 資料健檢（僅系統管理者）
  if(bsAudit) bsAudit.style.display = canSysConfig() ? 'flex' : 'none';
  document.getElementById('moreMgmtOverlay').classList.add('active');
  document.getElementById('moreMgmtSheet').classList.add('active');
}
function closeMoreMgmtSheet() {
  document.getElementById('moreMgmtOverlay').classList.remove('active');
  document.getElementById('moreMgmtSheet').classList.remove('active');
}
function openOwnerZoneSheet() {
  document.getElementById('ownerZoneOverlay').classList.add('active');
  document.getElementById('ownerZoneSheet').classList.add('active');
}
function closeOwnerZoneSheet() {
  document.getElementById('ownerZoneOverlay').classList.remove('active');
  document.getElementById('ownerZoneSheet').classList.remove('active');
}
function openLeaveSheet() {
  document.getElementById('leaveOverlay').classList.add('active');
  document.getElementById('leaveSheet').classList.add('active');
}
function closeLeaveSheet() {
  document.getElementById('leaveOverlay').classList.remove('active');
  document.getElementById('leaveSheet').classList.remove('active');
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

// 折疊/展開
function toggleFuncSection(key) {
  const grid  = document.getElementById(`grid-${key}`);
  const arrow = document.getElementById(`arrow-${key}`);
  if(!grid) return;
  const isOpen = grid.classList.contains('expanded');
  setFuncSectionState(key, !isOpen);
  localStorage.setItem(`funcSection-${key}`, isOpen ? 'collapsed' : 'expanded');
}
function setFuncSectionState(key, open) {
  const grid  = document.getElementById(`grid-${key}`);
  const arrow = document.getElementById(`arrow-${key}`);
  if(!grid) return;
  grid.classList.toggle('expanded',  open);
  grid.classList.toggle('collapsed', !open);
  if(arrow) arrow.classList.toggle('open', open);
}

function goToSchedule() { window.location.href = 'schedule-V2.html'; }


// ===== 角色預覽 =====
let realUser = null; 
let previewRole = null; 

const ROLE_PREVIEW_LABELS = {
  employee: '員工',
  manager: '店長',
  owner: '加盟主',
  admin: '系統管理員'
};

function openRolePreviewModal() {
  const realPerm = realUser ? realUser.permission : currentUser.permission;
  if(realPerm !== 'admin') return;

  const sub = document.getElementById('rolePreviewSub');
  const warning = document.getElementById('rolePreviewWarning');
  const restoreBtn = document.getElementById('restoreRealBtn');

  if(previewRole) {
    sub.textContent = `目前預覽：${ROLE_PREVIEW_LABELS[previewRole]}`;
    warning.style.display = 'block';
    document.getElementById('previewRoleName').textContent = ROLE_PREVIEW_LABELS[previewRole];
    restoreBtn.style.display = 'block';
  } else {
    sub.textContent = '目前以真實身份（系統管理員）登入';
    warning.style.display = 'none';
    restoreBtn.style.display = 'none';
  }

  ['employee','manager','owner','admin'].forEach(r => {
    const btn = document.getElementById(`rpBtn-${r}`);
    if(btn) btn.classList.toggle('selected', r === (previewRole || 'admin'));
  });

  openModal('rolePreviewModal');
}

let selectedPreviewRole = null;
function setPreviewRole(role) {
  selectedPreviewRole = role;
  ['employee','manager','owner','admin'].forEach(r => {
    const btn = document.getElementById(`rpBtn-${r}`);
    if(btn) btn.classList.toggle('selected', r === role);
  });
  const warning = document.getElementById('rolePreviewWarning');
  const nameEl = document.getElementById('previewRoleName');
  if(role === 'admin') {
    warning.style.display = 'none';
  } else {
    warning.style.display = 'block';
    nameEl.textContent = ROLE_PREVIEW_LABELS[role];
  }
}

async function confirmRolePreview() {
  const role = selectedPreviewRole;
  if(!role) { showToast('⚠️ 請選擇角色'); return; }

  if(!realUser) realUser = { ...currentUser };

  if(role === 'admin') {
    restoreRealRole();
    return;
  }

  previewRole = role;
  currentUser = {
    ...realUser,
    permission: role,
    role: role === 'employee' ? '工讀' : role === 'manager' ? '店長' : '加盟主',
  };
  if(role === 'employee') currentUser.store = realUser.store || (appConfig.stores && appConfig.stores[0]);

  sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
  sessionStorage.setItem('isPreviewMode', '1');

  closeModal('rolePreviewModal');
  showToast(`🎭 正在以「${ROLE_PREVIEW_LABELS[role]}」角色預覽`);

  const banner = document.getElementById('previewBanner');
  const bannerRole = document.getElementById('previewBannerRole');
  if(banner) { banner.classList.add('show'); bannerRole.textContent = ROLE_PREVIEW_LABELS[role]; }

  try {
    await Promise.race([
      initApp(),
      new Promise(res => setTimeout(res, 8000))
    ]);
  } catch(e) {
    console.warn('預覽模式 initApp 失敗:', e);
  } finally {
    // 無論如何確保 loading 關閉、首頁顯示
    document.getElementById('appShell').classList.add('active');
    hideLoading();
  }
}

function restoreRealRole() {
  if(!realUser) return;
  currentUser = { ...realUser };
  previewRole = null;
  realUser = null;
  selectedPreviewRole = null;

  sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
  sessionStorage.removeItem('isPreviewMode');

  closeModal('rolePreviewModal');
  showToast('✅ 已恢復真實身份');

  const banner = document.getElementById('previewBanner');
  if(banner) banner.classList.remove('show');

  Promise.race([initApp(), new Promise(res=>setTimeout(res,8000))])
    .catch(()=>{})
    .finally(()=>{ document.getElementById('appShell').classList.add('active'); hideLoading(); });
}

// ===== 薪資頁面跳轉 =====
function goToSalary() {
  const perm = currentUser?.permission;
  if(['manager','owner','admin'].includes(perm)) {
    window.location.href = 'salary.html';
  } else {
    window.location.href = 'my-salary.html';
  }
}

// ===== Enter 鍵登入 =====
document.getElementById('loginPassword').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') doLogin();
});
document.getElementById('loginUsername').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') document.getElementById('loginPassword').focus();
});
document.getElementById('pcNewPwdC').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') doFirstTimePwdChange();
});

// ===== 離線偵測 =====
function updateNetworkStatus() {
  const dot    = document.getElementById('networkDot');
  const banner = document.getElementById('offlineBanner');
  if(!dot || !banner) return;
  const online = navigator.onLine;
  dot.style.background = online ? '#34a853' : '#d93025';
  dot.title = online ? '連線正常' : '離線中';
  banner.style.display = online ? 'none' : 'block';
}
window.addEventListener('online',  updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
updateNetworkStatus(); // 初始執行一次


if('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        console.log('[PWA] Service Worker 已註冊');
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if(newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              newWorker.postMessage('SKIP_WAITING');
              window.location.reload();
            }
          });
        });
      })
      .catch(err => console.warn('[PWA] SW 註冊失敗:', err));
  });
}
