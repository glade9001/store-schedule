// 首頁（home.html）之一：全域狀態、共用小工具、首頁打卡狀態、出勤提醒、進站載入（window.onload）。
// 2026-10-16 整理第 4 階段：原本 2,467 行一個檔，原封不動按功能切成 7 個檔（串回去逐位元組相同），依序載入：
//   page（本檔）→ login 登入 → checks 登入後提醒 → schedule 首頁與我的班表 → calendar 月曆與統計 → pending 待處理 → preview 角色預覽、網路狀態
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
  // 2026-09-15 首頁改版：正常狀態改用主色藍（綠色留給「完成」語意）；紅色仍是「班已開始還沒打卡」
  const GREEN='#1a73e8', GREEN_SH='0 8px 22px rgba(14,33,64,.28)';
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
    else { setGreen('🕐',`記得準時打卡${atTail}`); } // 班別時段已顯示在卡片右側的 todayShiftBadge
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
  // 2026-09-15 首頁改版：員工本人的缺卡維持醒目卡片（影響薪資、要本人補登才會消失，首頁唯一的紅色卡）；
  // 店長的「門市缺卡（待辦）」與「遲到早退（知悉）」縮成提醒膠囊，看得到就夠，點進出勤管理再看細節。
  if(data.mine>0){
    box.innerHTML=`<div class="attn-mine" onclick="window.location.href='my-attendance.html'" role="button" tabindex="0">
      <span class="attn-mine-ic">⚠️</span>
      <span class="attn-mine-t"><b>你有 ${data.mine} 筆缺卡未補登</b><span>${period}・影響工時與薪資，點此補登</span></span>
      <span class="attn-mine-go">›</span>
    </div>`;
    box.style.display='';
  } else { box.style.display='none'; box.innerHTML=''; }

  const missPill=document.getElementById('attnMissPill');
  if(missPill){
    if(isLead && data.stMiss>0){
      document.getElementById('attnMissText').textContent=`${store} 缺卡 ${data.stMiss}・${period}`;
      missPill.style.display='flex';
    } else missPill.style.display='none';
  }
  // 遲到／早退＝知悉：LINE 式未讀數，浮水印記「最後看到哪個時間點」，比它新的才算未讀（見 attnSeenWatermark）
  const anomPill=document.getElementById('attnAnomPill');
  if(anomPill){
    let unread=0;
    if(isLead && data.stAnom>0){
      const seen=await attnSeenWatermark(store);
      unread=(data.anomTs||[]).filter(t=>t>seen).length;
    }
    if(unread>0){
      document.getElementById('attnAnomText').textContent=`${store} 遲到早退 ${data.stAnom}・${period}`;
      document.getElementById('attnAnomUnread').textContent=unread;
      anomPill.onclick=()=>{ markAttnSeen(store); window.location.href='attendance.html'; };
      document.getElementById('attnAnomX').onclick=(e)=>{ e.stopPropagation(); markAttnSeen(store,true); };
      anomPill.style.display='flex';
    } else anomPill.style.display='none';
  }
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
    const configP = window.db.collection('settings').doc('globalConfig').get();
    try {
      const snap = await Promise.race([
        configP,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      if(snap.exists) {
        appConfig = snap.data();
        localStorage.setItem('appConfig', JSON.stringify(appConfig));
      }
    } catch(e) {
      console.warn('設定讀取失敗，使用快取');
      // 逾時不代表讀不到：讓原本那次讀取在背景跑完，回來後補存快取並重畫打卡卡（新裝 App 第一次開常見）
      configP.then(snap => {
        if(!snap.exists) return;
        appConfig = snap.data();
        try { localStorage.setItem('appConfig', JSON.stringify(appConfig)); } catch(e2) {}
        if(currentUser && document.getElementById('appShell')?.classList.contains('active')) applyHomeClockCard();
      }).catch(() => {});
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
