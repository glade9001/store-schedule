// 打卡提醒預設值（2026-09-16 起預設開啟，與 functions/index.js CLOCK_REMIND_DEFAULT 同值；員工可自行關閉）
const CLOCK_REMIND_DEFAULT={inBefore:10, outRemind:true};
let currentUser=null, appConfig={}, geoCfg={}, myGeo=null, atStore='', distanceM=null, todayShifts=[], todayPunches=[], locating=false, isBound=true, carriedOpenIn=null, candShifts=[], openPunch=null, staleOpenIn=null, remindPref={...CLOCK_REMIND_DEFAULT};
// 週文件 id 必須是排班表 getWeekDates() 的精準反函式（每週以「週一」起算）。
// 舊公式把「當下日期(含時間)」直接套年度週次 → 每個週六/週日都算成下一週，打卡因此讀到下週班表。
function week1Monday(yr){ const d=new Date(yr,0,1), day=d.getDay(); d.setDate(d.getDate()+(day<=4?1-day:8-day)); return d; }
function weekStrOf(d){
  const mon=new Date(d.getFullYear(),d.getMonth(),d.getDate());   // 去掉時間，避免小數天數把週次進位
  mon.setDate(mon.getDate()-((mon.getDay()+6)%7));                // 退到該日所屬的週一
  let yr=mon.getFullYear();
  if(mon<week1Monday(yr)) yr--; else if(mon>=week1Monday(yr+1)) yr++;  // 跨年首尾週
  const w=Math.round((mon-week1Monday(yr))/604800000)+1;
  return `${yr}-W${w<10?'0'+w:w}`;
}
let serverOffset=0, clockTimer=null; // 伺服器校時：serverOffset = 伺服器時間 − 本機時間
async function syncServerTime(){
  try{ const fn=firebase.app().functions('asia-east1').httpsCallable('serverNow');
    const t0=Date.now(); const res=await fn({}); const t1=Date.now(); const rtt=(t1-t0)/2;
    serverOffset=(res.data.nowMs+rtt)-t1;
  }catch(e){ serverOffset=0; } // 校時失敗 → 退回本機時間
}
function serverNowMs(){ return Date.now()+serverOffset; }
function tickClock(){ const el=document.getElementById('srvClock'); if(!el)return;
  const d=new Date(serverNowMs()+8*3600000); const p=n=>String(n).padStart(2,'0');
  el.textContent='🕐 '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds());
}
const DAYS=["週一","週二","週三","週四","週五","週六","週日"];
function fmtT(iso){ if(!iso)return''; const d=new Date(iso); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
// weeks doc id 一律走 weekStrOf（對齊 schedule-V2 getWeekDates 的日期）
function curWeekStr(){ return weekStrOf(new Date()); }
function showLoading(t){document.getElementById('loadingText').textContent=t||'載入中…';document.getElementById('loadingOverlay').classList.remove('hidden');}
function hideLoading(){document.getElementById('loadingOverlay').classList.add('hidden');}
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800);}
function todayStr(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function hm(d){return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
function distM(la1,lo1,la2,lo2){const R=6371000,rad=x=>x*Math.PI/180;const dLa=rad(la2-la1),dLo=rad(lo2-lo1);const s=Math.sin(dLa/2)**2+Math.cos(rad(la1))*Math.cos(rad(la2))*Math.sin(dLo/2)**2;return R*2*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));}

window.onload=async()=>{
  showLoading('驗證登入…');
  const saved=localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser');
  if(!saved){location.replace('home.html');return;}
  try{currentUser=JSON.parse(saved);}catch(e){location.replace('home.html');return;}
  if(currentUser && currentUser.resigned){ location.replace('my-salary.html'); return; }
  const fb=await new Promise(r=>{const u=firebase.auth().onAuthStateChanged(x=>{u();r(x);});});
  if(!fb){localStorage.removeItem('currentUser');location.replace('home.html');return;}
  try{const s=await window.db.collection('settings').doc('globalConfig').get();if(s.exists)appConfig=s.data();}catch(e){}
  // 2026-09-23：打卡一律開啟。原本的 clockIn.stage（分階段開放）與 enabledByStore（單店開關）
  // 都已移除——三店早就全開，留著只是多一層會擋人的判斷。geo 圍欄、遲到容許值等設定照舊。
  const clk=appConfig.clockIn||{}; geoCfg=clk.geo||{};
  // 2026-09-15 起不再請人綁 LINE（通知改推播）：不再查綁定、不顯示「尚未綁定 LINE」提醒（isBound 維持預設 true）
  // 讀打卡提醒偏好（暫停期間不顯示設定，省一次讀取）
  if(!CLOCK_REMIND_SUSPENDED){
    try{ const rp=await window.db.collection('clockRemindPrefs').doc(currentUser.empName).get(); if(rp.exists){ const d=rp.data()||{}; remindPref={inBefore:Number(d.inBefore)||0, outRemind:!!d.outRemind}; } }catch(e){} // 沒有文件＝維持預設（都開）
  }
  await syncServerTime();
  refreshGeoPerm();   // 讀定位權限狀態，供診斷顯示
  hideLoading();
  render();
  if(!clockTimer) clockTimer=setInterval(tickClock,1000);
  locate();
  flushOffline(); // 有離線暫存則自動補傳
};

// 取「當下」即時定位（maximumAge:0，不吃快取），並回傳落在哪家店
function freshGeo(){
  return new Promise((resolve,reject)=>{
    if(!navigator.geolocation){ reject(new Error('此裝置不支援定位')); return; }
    navigator.geolocation.getCurrentPosition(p=>{
      const g={lat:p.coords.latitude,lng:p.coords.longitude,acc:Math.round(p.coords.accuracy)};
      let best=null;
      Object.entries(geoCfg).forEach(([st,cfg])=>{
        if(cfg.lat==null||cfg.lng==null)return;
        const d=distM(g.lat,g.lng,cfg.lat,cfg.lng);
        if(d<=(cfg.radiusM||120) && (!best||d<best.d)) best={st,d};
      });
      resolve({geo:g, store:best?best.st:'', dist:best?Math.round(best.d):null});
    }, e=>reject(e), {enableHighAccuracy:true,timeout:12000,maximumAge:0});
  });
}

// 精度門檻：超過這個值代表手機不是用 GPS，而是退回基地台/WiFi 粗略定位
// （實例：某員工 2026-08-09 兩筆打卡精度 1427m / 2000m，同店其他人都是 5~22m），
// 這種座標無法判斷是否真的在店裡——落在圍欄內是碰巧，落在外面就會被硬擋。
const ACC_BAD = 100;
// 定位權限狀態：iOS 只有在「網頁至少成功請求過一次定位」之後，才會把它列進
// 設定→定位服務。員工回報「清單裡找不到」通常代表權限從沒被授予過（或被拒絕），
// 光靠口頭指引很難確認，所以直接把狀態讀出來顯示。
let geoPerm = '未知';
async function refreshGeoPerm(){
  try{
    if(navigator.permissions && navigator.permissions.query){
      const r = await navigator.permissions.query({name:'geolocation'});
      geoPerm = ({granted:'已允許', denied:'已拒絕 ⛔', prompt:'尚未授權（會跳詢問）'})[r.state] || r.state;
      r.onchange = ()=>{ refreshGeoPerm().then(render); };
    } else geoPerm = '此瀏覽器不支援查詢';
  }catch(e){ geoPerm = '無法查詢'; }
}
// 是否從桌面圖示開啟（standalone）→ 決定 iOS 設定裡要找哪個名稱
function isStandalone(){
  return (window.navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}
function accWarnHtml(){
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  return `<div style="font-size:12px;font-weight:600;line-height:1.75;text-align:left;margin-top:6px;">
    你的定位誤差約 <b>±${myGeo.acc} 公尺</b>，手機沒有用到 GPS，無法確認你在店內。<br>
    <b>請依序試：</b><br>
    ① 把 <b>Wi-Fi 打開</b>（不用連上任何網路，開著就能大幅提升室內定位）<br>
    ${ios
      ? `② 在 Safari 網址列左邊點 <b>ㄅA</b>（或 <b>AA</b>）→ <b>網站設定</b> → <b>位置</b> → 選「<b>允許</b>」<br>
         ③ 設定 → 隱私權與安全性 → 定位服務 → 往下找 <b>「Safari網站」</b><br>
         　（若你是從桌面圖示開的，要找的是 <b>「莉學商行」</b>）<br>
         　→ 進去把 <b>「精確位置」開啟</b>，取用位置選「使用 App 期間」<br>`
      : `② 設定 → 位置 → 應用程式權限 → 你的瀏覽器 → 開啟<b>「使用精確位置」</b><br>
         ③ 瀏覽器網址列左邊的鎖頭 → 權限 → 位置 → 允許<br>`}
    ④ 走到<b>靠窗或門口</b>再按「重新定位」<br>
    <br><b>⚠️ 在「定位服務」清單裡完全找不到？</b><br>
    代表這個網頁<b>從來沒有成功取得過定位權限</b>，所以 iOS 還沒把它列進去——
    這種情況去設定裡找是找不到東西可改的。請改用下面兩招之一：<br>
    · 按「🔄 重新定位」，若跳出詢問視窗就選<b>「允許」</b>（選過「不允許」的話這個視窗不會再出現）<br>
    · 若不再跳詢問：<b>把桌面圖示刪掉重新加入</b>（或 Safari → 設定 → 清除瀏覽資料），
      權限會重置，下次按重新定位就會再問一次<br>
    仍不行就用下方「📝 補登／修改」，由店長審核。
  </div>`;
}
// 定位診斷：失敗時原本什麼都沒留下，事後只能猜。這裡把當下座標、精度、
// 到各門市的距離攤開來，並提供一鍵複製，員工可直接貼給店長判斷是
// 「精度不足」「門市座標設錯」還是「真的不在店裡」。
function geoDiagText(){
  if(!myGeo) return '（尚未定位）';
  const rows = Object.entries(geoCfg).filter(([,g])=>g.lat!=null&&g.lng!=null).map(([st,g])=>{
    const d = Math.round(distM(myGeo.lat,myGeo.lng,g.lat,g.lng));
    const r = g.radiusM||120;
    return `  ${st}：距 ${d}m / 半徑 ${r}m ${d<=r?'✓ 範圍內':'✗ 範圍外'}`;
  });
  return [
    `【打卡定位診斷】`,
    `員工：${currentUser.displayName||currentUser.empName}（${currentUser.store||''}）`,
    `時間：${new Date(serverNowMs()).toLocaleString('zh-TW')}`,
    `座標：${myGeo.lat.toFixed(6)}, ${myGeo.lng.toFixed(6)}`,
    `精度：±${myGeo.acc} m ${myGeo.acc>ACC_BAD?'（過大，手機未使用 GPS）':'（正常）'}`,
    `各門市距離：`, ...rows,
    `定位權限：${geoPerm}`,
    `開啟方式：${isStandalone() ? '桌面圖示（設定裡找「莉學商行」）' : 'Safari 瀏覽器（設定裡找「Safari網站」）'}`,
    `裝置：${navigator.userAgent.slice(0,90)}`,
  ].join('\n');
}
function geoDiagHtml(){
  if(!myGeo) return '';
  return `<details style="margin-top:10px;">
    <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);font-weight:700;">🔧 定位診斷資訊（打不了卡時請複製給店長）</summary>
    <pre style="white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.7;background:#f8fafc;border-radius:8px;padding:10px;margin-top:8px;color:#334155;">${geoDiagText().replace(/</g,'&lt;')}</pre>
    <button id="geoSendBtn" onclick="sendGeoIssue()" style="width:100%;padding:10px;background:#eef2ff;color:#4338ca;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;">📨 傳送給系統管理員</button>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.6;">只有你按這顆才會送出並留存紀錄；平常點開打卡頁不會通知任何人。回報後請改用「補登／修改」先完成打卡。</div>
  </details>`;
}
// 直接把診斷資訊送給店長（LINE），並在後端留一筆紀錄。
// 刻意做成「員工主動按」而不是自動記錄——否則任何人在家點開打卡頁都會產生紀錄與通知。
async function sendGeoIssue(){
  const btn=document.getElementById('geoSendBtn');
  if(!myGeo){ toast('尚未取得定位，請先按「重新定位」'); return; }
  if(btn){ btn.disabled=true; btn.textContent='傳送中…'; }
  try{
    const fn=firebase.app().functions('asia-east1').httpsCallable('reportGeoIssue');
    const r=await fn({
      lat:myGeo.lat, lng:myGeo.lng, accuracy:myGeo.acc,
      reason: myGeo.acc>ACC_BAD ? `定位精度不足（±${myGeo.acc}m）` : '不在門市範圍內',
      deviceInfo: navigator.userAgent.slice(0,180),
    });
    toast(r.data && r.data.skipped ? '（10 分鐘內已回報過，未重複發送）' : '✅ 已通知系統管理員');
    if(btn){ btn.textContent='✅ 已傳送'; }
  }catch(e){
    if(btn){ btn.disabled=false; btn.textContent='📨 傳送給系統管理員'; }
    toast('傳送失敗：'+(e.message||e));
  }
}
function locate(){
  if(!navigator.geolocation){ atStore=''; distanceM=null; render(); toast('此裝置不支援定位'); return; }
  locating=true; render();
  navigator.geolocation.getCurrentPosition(async p=>{
    myGeo={lat:p.coords.latitude,lng:p.coords.longitude,acc:Math.round(p.coords.accuracy)};
    // 找落在哪家店圍欄（取最近的一家）
    let best=null;
    Object.entries(geoCfg).forEach(([st,g])=>{
      if(g.lat==null||g.lng==null)return;
      const d=distM(myGeo.lat,myGeo.lng,g.lat,g.lng);
      if(d<=(g.radiusM||120) && (!best||d<best.d)) best={st,d};
    });
    atStore=best?best.st:''; distanceM=best?Math.round(best.d):null;
    locating=false;
    if(atStore) await loadToday();
    render();
  }, e=>{ locating=false; atStore=''; distanceM=null; render(); toast('定位失敗：'+e.message); }, {enableHighAccuracy:true,timeout:12000,maximumAge:0});
}

async function loadToday(){
  todayShifts=[]; todayPunches=[];
  const ds=todayStr();
  // 今日在 atStore 的打卡
  try{
    const snap=await window.db.collection('stores').doc(atStore).collection('attendance')
      .where('date','==',ds).where('empName','==',currentUser.empName).get();
    snap.forEach(d=>todayPunches.push({id:d.id,...d.data()}));
    todayPunches.sort((a,b)=>(a.deviceTs||'').localeCompare(b.deviceTs||''));
  }catch(e){}
  // 跨日班(夜班)：用「昨日+今日」時間序列配對找出尚未打下班的上班。
  // 不能用同一日曆日的上/下班筆數判斷——連續夜班時，同一日曆日會同時含「收前一晚的班」+「開當晚的班」而筆數打平，導致誤判(某員工 8/4：00:39下班收8/3班 + 16:00上班開8/4班 → 1:1 打平)。
  carriedOpenIn=null; openPunch=null; staleOpenIn=null;
  try{
    const y=new Date(Date.now()-86400000);
    const dsY=`${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,'0')}-${String(y.getDate()).padStart(2,'0')}`;
    const ys=await window.db.collection('stores').doc(atStore).collection('attendance')
      .where('date','==',dsY).where('empName','==',currentUser.empName).get();
    const yp=[]; ys.forEach(d=>yp.push(d.data()));
    const ts=p=>(p.tsMs||Date.parse(p.deviceTs||'')||0);
    const seq=[...yp, ...todayPunches].filter(p=>p.type==='上班'||p.type==='下班').sort((a,b)=>ts(a)-ts(b));
    const stack=[]; // 依序配對：上班入堆、下班出堆；剩下的堆頂即尚未打下班的上班
    seq.forEach(p=>{ if(p.type==='上班') stack.push(p); else stack.pop(); });
    openPunch = stack.length ? stack[stack.length-1] : null;
    // 未收的上班屬昨日 → 可能是跨日夜班(仍該補打下班)，也可能是「昨天忘了打下班」的呆帳。
    // 呆帳若一直掛著，今天的按鈕會永遠停在「下班」→ 過了合理補打期限就放掉，改走補登申請。
    if(openPunch && (openPunch.date||'')===dsY){
      if(serverNowMs() > openInDeadline(openPunch)){ staleOpenIn=openPunch; openPunch=null; }
      else carriedOpenIn={date:dsY};
    }
  }catch(e){}
  // 今日在 atStore 的排班（本店班 or 支援班；兩頭班會有多筆）
  try{
    const wk=curWeekStr();
    const dayName=DAYS[(new Date().getDay()+6)%7];
    const wd=await window.db.collection('stores').doc(atStore).collection('weeks').doc(wk).get();
    if(wd.exists){
      (wd.data().records||[]).forEach(r=>{
        if(r.day!==dayName) return;
        const mine=(r.name===currentUser.empName) || (r.supportEmp===`${currentUser.store}-${currentUser.empName}` && r.approvalStatus==='approved');
        if(!mine) return;
        // 兩頭班一筆記錄會有多段；跨夜的 end 已推成 >24（見 shift-utils.js）
        parseShiftSegs(r.shift).forEach(g=>todayShifts.push({shift:r.shift,start:g.startH,end:g.endH}));
      });
    }
  }catch(e){}
  // 3日候選班(絕對時間)供加班防呆視窗比對，對齊後端(避免 00:00 班/夜班誤跳加班)
  candShifts=[];
  try{
    for(const off of [-1,0,1]){
      const dt=new Date(Date.now()+off*86400000);
      const dss=`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
      const wdd=await window.db.collection('stores').doc(atStore).collection('weeks').doc(weekStrOf(dt)).get();
      const dn=DAYS[(dt.getDay()+6)%7];
      if(wdd.exists)(wdd.data().records||[]).forEach(r=>{
        if(r.day!==dn) return;
        const mine=(r.name===currentUser.empName)||(r.supportEmp===`${currentUser.store}-${currentUser.empName}`&&r.approvalStatus==='approved');
        if(!mine) return;
        parseShiftSegs(r.shift).forEach(g=>{   // 兩頭班：每段各自成為一個候選
          const startMs=shiftTimeMs(dss,g.startH);
          if(!isFinite(startMs)) return;
          candShifts.push({shift:r.shift,shiftDate:dss,startMs,endMs:startMs+g.durH*3600000});
        });
      });
    }
  }catch(e){}
}

// 未收上班的合理補打期限：該班排定下班 +4 小時（夜班照跨日算）；查不到班別則打卡後 12 小時。
// 超過即視為缺卡呆帳，不再要求打下班（否則隔天按鈕會卡在「下班」）。
function openInDeadline(p){
  const sp=shiftSpan(p.shift);   // 兩頭班取最後一段的下班時刻
  if(sp && p.shiftDate){
    const endMs=shiftTimeMs(p.shiftDate,sp.endH);
    if(isFinite(endMs)) return endMs+4*3600000;
  }
  return (p.tsMs||Date.parse(p.deviceTs||'')||0)+12*3600000;
}
// 依「最後一次打卡」決定下一步，只有上班/下班（可重複多段：兩頭班/跨店連班）。
// 沒排班的打卡由後端自動歸類為「到場」，不做成按鈕。
function nextAction(){
  // 依「昨日+今日時間序列配對」結果：尚有未打下班的上班(含跨日夜班) → 下班；否則 上班
  return openPunch ? '下班' : '上班';
}

// 打卡提醒：2026-08-17 因 LINE 免費額度暫停；2026-09-15 改用 PWA 推播恢復（functions scheduledClockRemindPush）。
//    員工既有的 clockRemindPrefs 偏好原封不動恢復生效。只發推播：沒開推播的人收不到（畫面上會提示去開）。
//    要再暫停：改回 true 即可隱藏設定（後端沒有對應常數，偏好沒人開推播時排程也不讀排班）。
const CLOCK_REMIND_SUSPENDED = false;

// 打卡提醒偏好：寫 clockRemindPrefs/{empName}，排程依排班時間發推播
async function saveRemindPref(){
  if(CLOCK_REMIND_SUSPENDED) return;
  const on=document.getElementById('remIn').checked;
  let x=parseInt(document.getElementById('remInMin').value,10); if(!(x>0))x=10; if(x>30)x=30;
  document.getElementById('remInMin').value=x;
  const outR=document.getElementById('remOut').checked;
  remindPref={inBefore:on?x:0, outRemind:outR};
  try{
    await window.db.collection('clockRemindPrefs').doc(currentUser.empName).set({
      empName:currentUser.empName, store:currentUser.store||'', inBefore:remindPref.inBefore, outRemind:outR, updatedAt:new Date().toISOString()
    },{merge:true});
    const pushOn = await remindPushReady();
    toast('✅ 打卡提醒設定已儲存'+((remindPref.inBefore>0||outR)&&!pushOn?'（還要開啟推播通知才收得到）':''));
    renderRemindPushHint();
  }catch(e){ toast('儲存失敗：'+e.message); }
}
// 這台手機是否已開推播（首頁 home-push.js 訂閱；打卡頁與首頁共用同一個 Service Worker）
async function remindPushReady(){
  try{
    if(!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const reg=await Promise.race([navigator.serviceWorker.getRegistration(), new Promise(r=>setTimeout(()=>r(null),3000))]);
    return !!(reg && await reg.pushManager.getSubscription());
  }catch(e){ return false; }
}
async function renderRemindPushHint(){
  const el=document.getElementById('remPushHint'); if(!el) return;
  const on=await remindPushReady();
  el.innerHTML = on
    ? '<span style="color:#137333;font-weight:700;">✅ 這台手機已開啟推播，會收到提醒</span>'
    : '<span style="color:#c2410c;font-weight:700;">⚠️ 這台手機還沒開啟推播，勾了也收不到。</span> <a href="home.html" style="color:var(--primary);font-weight:800;">回首頁 ☰ →「設定」→「通知設定」開啟</a>';
}

// 補登／修改申請（同 my-attendance：寫 attendanceRequests、店長審核）
function openReqModal(){
  const stores=(appConfig.stores||[]).filter(s=>s!=='人力支援');
  document.getElementById('rqStore').innerHTML=stores.map(s=>`<option value="${s}"${s===(atStore||currentUser.store)?' selected':''}>${s}</option>`).join('');
  document.getElementById('rqDate').value=todayStr();
  document.getElementById('rqTime').value=''; document.getElementById('rqReason').value=''; document.getElementById('rqReasonCode').value=''; onReqReasonChange();
  document.getElementById('reqModal').style.display='flex';
  syncReqStore();
}
// 門市預設值跟著「那天的排班」走，不是跟著你現在人在哪。
// 支援日的班在別家店，照舊的預設送出去就會送錯店 → 缺卡單配不到、工時也配不起來。
// 仍然是可改的下拉，只是把預設值挑對，並把依據寫在下面讓人看得懂。
async function syncReqStore(){
  const hint=document.getElementById('rqStoreHint'); if(!hint) return;
  const ds=document.getElementById('rqDate').value;
  const sel=document.getElementById('rqStore');
  if(!ds){ hint.textContent=''; return; }
  hint.textContent='查詢當天排班中…';
  try{
    const hits=await findShiftStoresOn(ds, currentUser.empName, currentUser.store||'', appConfig.stores||[]);
    if(!hits.length){
      hint.innerHTML='當天查無排班，門市請自行選擇。';
      return;
    }
    const uniq=[...new Set(hits.map(h=>h.store))];
    if(uniq.length===1) sel.value=uniq[0];
    const txt=hits.map(h=>`${h.store} ${h.shift}${h.fromPrevDay?'（前一日跨夜班）':''}`).join('、');
    hint.innerHTML=uniq.length===1
      ? `✅ 當天排班：<b>${txt}</b>　已自動選好門市`
      : `⚠️ 當天在多家店有班：<b>${txt}</b>　請自行確認要補哪一家`;
  }catch(e){ hint.textContent='（查不到當天排班，門市請自行確認）'; }
}
// ===== 補登原因分類（2026-09-16）=====
// 原本是選填的自由輸入 → 8/1~9/16 的 321 張申請有 189 張（59%）空白，店長看到「原因：—」、也無從統計根因。
// 改成必選分類（選「其他」才強制打字），並另存 reasonCode/reasonText 供統計；reason 仍組成文字供既有顯示與通知使用。
var REQ_REASONS={forgot:'忘記打卡', device:'手機沒帶／沒電／故障', system:'打不進去（定位或系統出錯）', support:'支援他店，不知道在哪打卡', noshift:'沒排班但有到場', wrongtime:'打卡時間錯誤，要修改', other:'其他'};
var REQ_REASON_HINTS={
  system:'若你還在店裡，請先回打卡頁按「📨 傳送給系統管理員」附上定位診斷，這樣才查得出原因。',
  support:'提醒：支援他店時，要在<b>實際上班的那家店</b>打卡，門市請選那一家。',
  wrongtime:'這是「修改時間」：填正確時間即可，原本的打卡紀錄會保留備查。',
  noshift:'沒排班卻有到場，請順便提醒店長補排班，否則工時可能算不進去。',
  other:'請具體說明原因（至少 5 個字），店長才有辦法判斷。'
};
function onReqReasonChange(){
  var code=document.getElementById('rqReasonCode').value;
  var hint=document.getElementById('rqReasonHint');
  var ta=document.getElementById('rqReason');
  if(hint){ hint.innerHTML=REQ_REASON_HINTS[code]||''; hint.style.display=REQ_REASON_HINTS[code]?'block':'none'; }
  if(ta) ta.placeholder = code==='other' ? '請說明原因（必填，至少 5 個字）' : '補充說明（選填）';
}
// 薪資送審後鎖定（2026-09-16 使用者定案）：該月薪資 submitted/published 後員工不能自行補登，改由店長代補（會留記號）
async function salaryLockedFor(store, ym){
  try{
    const d=await window.db.collection('stores').doc(store).collection('salary').doc(ym).get();
    const st=d.exists ? (d.data().status||'draft') : 'draft';
    return ['submitted','published'].includes(st);
  }catch(e){ return false; }   // 查不到就不擋，避免連線問題讓人補不了卡
}
// 回傳 null＝驗證未過（已提示使用者）
function collectReqReason(){
  var code=document.getElementById('rqReasonCode').value;
  var text=document.getElementById('rqReason').value.trim();
  if(!code){ alert('請選擇原因'); return null; }
  if(code==='other' && text.length<5){ alert('選「其他」時請具體說明原因（至少 5 個字）'); return null; }
  return { reasonCode:code, reasonText:text, reason:REQ_REASONS[code]+(text?'：'+text:'') };
}
async function submitReq(){
  const st=document.getElementById('rqStore').value;
  const targetDate=document.getElementById('rqDate').value;
  const punchType=document.getElementById('rqType').value;
  const requestedTime=document.getElementById('rqTime').value;
  const rr=collectReqReason(); if(!rr) return;
  if(await salaryLockedFor(atStore, targetDate.slice(0,7))){
    alert(`${targetDate.slice(0,7)} 的薪資已送審，無法自行補登。\n請聯絡店長協助補登（店長端仍可代補）。`);
    return;
  }
  if(!st||!targetDate||!requestedTime){ toast('請填門市、日期、時間'); return; }
  // 這個時間對得上哪一班？對不上就先問（跨夜班的下班是隔天；2026-09-22）
  let mt={ shift:'', shiftDate:targetDate };
  try{ mt=await matchSchedShift(st, currentUser.empName, currentUser.store||'', targetDate, requestedTime, punchType); }catch(e){}
  if(!mt.shift && rr.reasonCode!=='noshift' && !confirm(`⚠️ ${targetDate} ${requestedTime} 的${punchType}卡，對不上你在 ${st} 的任何一個班。\n\n跨夜班的下班是「隔天」早上（例：9/17 大夜 23-07 → 9/18 07:00）。\n確定要這樣送出嗎？`)) return;
  try{
    await window.db.collection('stores').doc(st).collection('attendanceRequests').add({
      empName:currentUser.empName, displayName:currentUser.displayName||currentUser.empName,
      homeStore:currentUser.store||'', atStore:st, type:'補登/修改', targetDate, punchType, requestedTime,
      reason:rr.reason, reasonCode:rr.reasonCode, reasonText:rr.reasonText,
      shiftDate: mt.shiftDate, matchedShift: mt.shift||'',
      status:'pending', createdAt:new Date().toISOString(), createdBy:currentUser.empName
    });
    document.getElementById('reqModal').style.display='none';
    toast('✅ 已送出，等店長審核（有開推播會通知你結果）');
  }catch(e){ toast('送出失敗：'+e.message); }
}
function render(){
  const wrap=document.getElementById('wrap');
  const d=new Date();
  const dateLine=`${d.getMonth()+1}月${d.getDate()}日（${['日','一','二','三','四','五','六'][d.getDay()]}）`;
  let loc='';
  if(locating) loc=`<div class="locbox loc-wait">📍 定位中…</div>`;
  else if(atStore) loc=`<div class="locbox loc-ok">📍 ${atStore}　距 ${distanceM}m　±${myGeo?myGeo.acc:'?'}m　✓ 可打卡${myGeo&&myGeo.acc>ACC_BAD?'<br><span style="font-size:11.5px;font-weight:600;">⚠️ 定位誤差偏大，建議開啟 Wi-Fi 與「精確位置」</span>':''}</div>`;
  // 定位精度太差時，講「不在門市範圍內」會誤導——真正的問題是手機沒用到 GPS。
  // 原本那句「請至設定確認門市座標」對員工也沒用（他改不了，而且多半不是座標的問題）。
  else if(myGeo && myGeo.acc > ACC_BAD) loc=`<div class="locbox loc-bad">⚠️ 定位精度不足，無法確認你在店內${accWarnHtml()}</div>`;
  else if(myGeo) loc=`<div class="locbox loc-bad">⚠️ 不在任何門市範圍內，無法打卡<br><span style="font-size:12px;font-weight:600;">目前定位誤差 ±${myGeo.acc}m。若你確實在店內，請走到門口再按「重新定位」；仍不行請用下方「📝 補登／修改」，或請店長確認門市座標。</span></div>`;
  else loc=`<div class="locbox loc-wait">📍 尚未定位</div>`;

  const shiftLine = atStore ? (todayShifts.length?`<div class="shiftinfo">今日班別：${todayShifts.map(s=>s.shift).join('、')}</div>`
    : `<div class="shiftinfo" style="color:var(--text-muted);">今日於 ${atStore} 無排班（打卡將自動記為到場）</div>`) : '';

  const act=nextAction();
  let btn='';
  if(!atStore){
    // 精度不足時，按鈕不要只寫「需在門市範圍內」——她人就在店裡，那句話只會讓人反覆重試。
    const bad = myGeo && myGeo.acc > ACC_BAD;
    btn = `<button class="punch-btn" disabled>${bad ? '定位精度不足，無法打卡' : '需在門市範圍內才能打卡'}</button>`
        + (bad ? `<button onclick="openReqModal()" style="width:100%;margin-top:8px;padding:11px;background:#fff7ed;color:#c2410c;border:1.5px solid #fed7aa;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;">📝 定位一直失敗？改用補登（店長審核）</button>` : '');
  }
  else if(!act){ btn=`<button class="punch-btn" disabled>✅ 今日已完成</button>`; }
  else{
    const cls=act==='上班'?'punch-in':'punch-out';
    btn=`<button class="punch-btn ${cls}" onclick="doPunch('${act}')">${act}打卡</button>`;
  }

  const plist = todayPunches.length? `<div class="plist">${todayPunches.map(p=>{
    const tag=p.type==='上班'?'tag-in':p.type==='下班'?'tag-out':'tag-visit';
    const sc=p.status==='遲到'?'stat-bad':p.status==='早退'?'stat-bad':p.status==='警告'?'stat-warn':p.status==='到場'?'stat-visit':'stat-ok';
    const statTxt=p.status==='遲到'?`遲到${p.lateMin||''}分`:p.status||'';
    return `<div class="pitem"><span class="ptag ${tag}">${p.type}</span><span>${fmtT(p.deviceTs)}</span><span style="color:var(--text-muted);font-size:12px;">@${p.atStore}</span><span class="pstat ${sc}">${statTxt}</span></div>`;
  }).join('')}</div>`:'';

  const offCnt = offlineQueue().length;
  const offBanner = offCnt ? `<div style="background:#e8f0fe;border:1.5px solid #a8c7fa;border-radius:12px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;"><span style="font-size:20px;">📴</span><div style="flex:1;font-size:12.5px;font-weight:700;color:#1a56c4;line-height:1.5;">有 ${offCnt} 筆離線打卡待補傳</div><button onclick="flushOffline()" style="background:#1a73e8;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-weight:800;font-size:12px;cursor:pointer;">立即補傳</button></div>` : '';
  const openIn = todayPunches.filter(p=>p.type==='上班').length > todayPunches.filter(p=>p.type==='下班').length;
  const openWarn = (openIn||carriedOpenIn) ? `<div style="background:#fff3e0;border:1.5px solid #ffc27a;border-radius:12px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;"><span style="font-size:20px;">⏰</span><div style="flex:1;font-size:12.5px;font-weight:700;color:#c0620f;line-height:1.5;">你有一筆上班尚未打下班${carriedOpenIn?`（${carriedOpenIn.date} 跨日班）`:''}，記得補打下班</div></div>` : '';
  // 昨日上班卡沒收尾且已過補打期限：不擋今天打卡，但要講清楚該去補登，否則會留著缺卡
  const staleWarn = staleOpenIn ? `<div style="background:#fff3e0;border:1.5px solid #ffc27a;border-radius:12px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;"><span style="font-size:20px;">📝</span><div style="flex:1;font-size:12.5px;font-weight:700;color:#c0620f;line-height:1.5;">${staleOpenIn.date} 有一筆上班沒有對應的下班卡（已超過補打時間）<br><span style="font-weight:600;">今天的打卡不受影響；那天的下班請按下方「補登／修改」申請</span></div><button onclick="openReqModal()" style="background:#c0620f;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-weight:800;font-size:12px;cursor:pointer;white-space:nowrap;">去補登</button></div>` : '';
  const bindWarn = '';
  // A2 今日狀態醒目提醒：有排班卻還沒打上班卡
  let a2Warn='';
  { const hasInToday=todayPunches.some(p=>p.type==='上班');
    const todayCand=candShifts.filter(c=>c.shiftDate===todayStr()).sort((a,b)=>a.startMs-b.startMs);
    if(!openPunch && !carriedOpenIn && !hasInToday && todayCand.length){
      const up=todayCand.find(c=>Date.now()<=c.startMs+punchWindowMs().inAfter)||todayCand[0];
      a2Warn = (Date.now()>=up.startMs)
        ? `<div style="background:#fce8e6;border:1.5px solid #f5a3a3;border-radius:12px;padding:11px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;"><span style="font-size:22px;">⚠️</span><div style="flex:1;font-size:13.5px;font-weight:900;color:#c5221f;line-height:1.5;">你今天 ${up.shift} 的班已開始，還沒打上班卡！<br><span style="font-size:11.5px;font-weight:700;">請盡快打卡；若準時上班只是忘了打，打卡時可填實際時間</span></div></div>`
        : `<div style="background:#e8f0fe;border:1.5px solid #a8c7fa;border-radius:12px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;"><span style="font-size:20px;">🕐</span><div style="flex:1;font-size:13px;font-weight:800;color:#1a56c4;line-height:1.5;">今天 ${up.shift} 上班，記得準時打卡</div></div>`;
    }
  }
  wrap.innerHTML=a2Warn+offBanner+openWarn+staleWarn+bindWarn+`<div class="card">
    <div class="today">${dateLine}</div>
    <div id="srvClock" style="text-align:center;font-size:34px;font-weight:900;letter-spacing:1px;color:var(--primary);font-variant-numeric:tabular-nums;margin:2px 0 2px;">🕐 --:--:--</div>
    <div style="text-align:center;font-size:11px;color:var(--text-muted);margin-bottom:8px;">以伺服器時間為準</div>
    <div class="sub">${currentUser.displayName||currentUser.empName}（${currentUser.store||''}）</div>
    ${loc}${shiftLine}${btn}${geoDiagHtml()}
    <div style="text-align:center;margin-top:10px;"><button onclick="locate()" style="background:none;border:none;color:var(--primary);font-size:13px;font-weight:700;cursor:pointer;">🔄 重新定位</button></div>
  </div>
  <div class="card" style="display:flex;gap:8px;padding:12px;">
    <button onclick="window.location.href='my-attendance.html'" style="flex:1;padding:11px;background:#eef2ff;color:#4338ca;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;">📋 我的出勤</button>
    <button onclick="openReqModal()" style="flex:1;padding:11px;background:#fff7ed;color:#c2410c;border:1.5px solid #fed7aa;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;">📝 補登／修改</button>
  </div>
  ${CLOCK_REMIND_SUSPENDED?`
  <div class="card" style="padding:14px;">
    <div style="font-size:13px;font-weight:800;color:var(--text-muted);margin-bottom:8px;">🔔 打卡提醒</div>
    <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:10px;padding:12px;font-size:13px;font-weight:700;color:#c2410c;line-height:1.7;">
      因使用人數過多，超出免費用量，全面暫停使用
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.5;">※ 其他通知（缺卡、班表、薪資）不受影響。</div>
  </div>`:`
  <div class="card" style="padding:14px;">
    <div style="font-size:13px;font-weight:800;color:var(--text-muted);margin-bottom:10px;">🔔 打卡提醒（依你的排班時間推播通知）</div>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;margin-bottom:10px;flex-wrap:wrap;">
      <input type="checkbox" id="remIn" ${remindPref.inBefore>0?'checked':''} onchange="saveRemindPref()" style="width:18px;height:18px;">
      上班前 <input type="number" id="remInMin" min="1" max="30" value="${remindPref.inBefore>0?remindPref.inBefore:10}" onchange="saveRemindPref()" style="width:56px;padding:5px;border:1.5px solid var(--border);border-radius:6px;text-align:center;font-weight:800;"> 分鐘提醒上班打卡
    </label>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;">
      <input type="checkbox" id="remOut" ${remindPref.outRemind?'checked':''} onchange="saveRemindPref()" style="width:18px;height:18px;">
      下班時間提醒下班打卡
    </label>
    <div id="remPushHint" style="font-size:12px;margin-top:8px;line-height:1.6;"></div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.5;">※ 兩項<b>預設都開啟</b>，不想收到可以取消勾選。上班前分鐘數上限 30 分；已經打過卡就不提醒，未排班的日子也不提醒。</div>
  </div>`}
  ${todayPunches.length?`<div class="card"><div style="font-size:13px;font-weight:800;color:var(--text-muted);margin-bottom:8px;">今日打卡</div>${plist}</div>`:''}
  <div style="padding:2px 10px 16px;">
    <div style="font-size:11.5px;font-weight:800;color:var(--text-muted);margin-bottom:5px;">💡 忘記打卡怎麼辦</div>
    <ul style="margin:0;padding-left:17px;font-size:11px;color:var(--text-muted);line-height:1.85;">
      <li><b>還在店裡</b>：先照常打卡（留下定位），時間要改再送修改申請</li>
      <li><b>已離店／要補別天</b>：按上方「📝 補登／修改」</li>
      <li><b>昨天忘打下班</b>：今天照常打上班卡，再補登昨天那筆</li>
      <li>一律由<b>店長審核</b>，有開推播的話結果會推播通知你</li>
    </ul>
  </div>`;
  tickClock();
  if(!CLOCK_REMIND_SUSPENDED) renderRemindPushHint();
}

// 依排班表(3日候選、絕對時間、視窗前1h後4h)判斷是否非排班時段，對齊後端
function offSchedule(type, nowMs){
  if(!candShifts.length) return {off:true, reason:'no-shift'};
  if(type==='上班'){
    const hit=matchPunchShift(candShifts, nowMs, '上班'); // 視窗定義見 shift-utils.js
    if(hit){
      const diff=(nowMs-hit.startMs)/60000; // 負=提早
      return diff < -30 ? {off:true, reason:'early'} : {off:false};
    }
    const upcoming=candShifts.some(c=>c.startMs>nowMs && c.startMs-nowMs<=8*3600000);
    return {off:true, reason: upcoming?'early':'no-shift'};
  } else {
    // 下班配對視窗：排定下班前 4h ~ 後 3h。後段原為 +1h，2026-08-17 放寬——
    // 人常常收完店走到門口才想到打卡，超過就配不到班、被記成「到場」不計工時，還得走補登。
    // 放寬不影響加班判定(門檻是另一條「晚超過 30 分」)，工時本來也有排班時數封頂。
    const hit=matchPunchShift(candShifts, nowMs, '下班'); // 視窗定義見 shift-utils.js
    if(hit){
      const diff=(nowMs-hit.endMs)/60000; // 正=晚
      return diff > 30 ? {off:true, reason:'late'} : {off:false};
    }
    const recent=candShifts.some(c=>c.endMs<nowMs && nowMs-c.endMs<=8*3600000);
    return {off:true, reason: recent?'late':'no-shift'};
  }
}
// 加班/私事詢問 modal（Promise：回傳 {intent:'apply',content} / {intent:'private'} / null 取消）
let _otResolve=null;
let _otReason=null;
function otPrompt(reason){
  return new Promise(resolve=>{
    _otResolve=resolve; _otReason=reason;
    const isAdmin=(currentUser.permission==='admin');
    const msg = reason==='no-shift'?'你目前在此門市沒有排班。'
      : reason==='early'?'你比排班開始時間提早超過 30 分鐘。'
      : '你已超過排班結束時間 30 分鐘以上。';
    document.getElementById('otMsg').textContent='⏰ 目前非排班時段：'+msg;
    document.getElementById('otContent').value='';
    document.getElementById('otContentRow').style.display='none';
    document.getElementById('otApplyBtn').textContent='📝 我要申請加班';
    // private 按鈕：下班晚打(非加班·私事/忘記)全員可用；上班/未排班「到場」只給 admin
    const pv=document.getElementById('otPrivateBtn');
    const showPriv = (reason==='late') || isAdmin;
    pv.style.display = showPriv ? '' : 'none';
    pv.textContent = (reason==='late') ? '否，非加班：私事或忘記才晚打（不計工時）' : '否，僅到場／私事（不計工時）';
    // 提示文字
    document.getElementById('otHint').innerHTML = (reason==='late')
      ? '剛才是<b>工作(加班)</b>嗎？是→申請加班(待審)。<br>若只是<b>私事或忘了打卡才晚打</b>、實際工作到下班時間為止，請選「非加班」（<b>不計工時</b>，保留下班紀錄）。'
      : isAdmin
        ? '是否要<b>申請加班</b>？<br>若只是巡店到場或處理私事，請選「到場」（<b>不計工時</b>）。'
        : '要<b>申請加班</b>嗎？<br>若不是要上班，請選「取消打卡」。';
    document.getElementById('otModal').style.display='flex';
  });
}
function otChooseApply(){
  const row=document.getElementById('otContentRow');
  if(row.style.display==='none'){ row.style.display='block'; document.getElementById('otApplyBtn').textContent='送出加班申請'; document.getElementById('otContent').focus(); return; }
  const c=document.getElementById('otContent').value.trim();
  if(!c){ toast('請填寫加班內容/事由'); return; }
  _otDone({intent:'apply', content:c});
}
function otChoosePrivate(){ _otDone({intent:'private', content: _otReason==='late' ? '員工聲明：私事或忘記才晚打，非加班（實際工作至下班時間為止）' : ''}); }
function otCancel(){ _otDone(null); }
function _otDone(v){ document.getElementById('otModal').style.display='none'; const r=_otResolve; _otResolve=null; if(r) r(v); }

// 遲到才想起來打卡：照實記錄時間，只讓員工留一句說明（2026-09-16 使用者定案）。
// 時間要改一律走補登/修改申請（店長核准、留痕），這裡不提供任何改時間的捷徑。
let _lnResolve=null;
function latePrompt(lateMin, schedTime, nowHm){
  return new Promise(resolve=>{
    _lnResolve=resolve;
    document.getElementById('lnMsg').innerHTML=`排班 ${schedTime} 開始，現在打卡會記錄為 <b>${nowHm}</b>（遲到 ${lateMin} 分）。<br>時間不會被修改；如果是系統或其他原因，可以在下面說明，店長看得到。`;
    document.getElementById('lnNote').value='';
    document.getElementById('lateNoteModal').style.display='flex';
  });
}
function lnSubmit(){ const v=document.getElementById('lnNote').value.trim().slice(0,200); _lnDone({ok:true, note:v}); }
function lnCancel(){ _lnDone(null); }
function _lnDone(v){ document.getElementById('lateNoteModal').style.display='none'; const r=_lnResolve; _lnResolve=null; if(r) r(v); }

// ✂️ B1「遲到 10 分鐘內問是否忘記打卡」已移除（2026-09-15 使用者決定）：
//    8/1～9/15 共 29 筆經此送出的更正申請 100% 核准、申報時間多比實際打卡早 3～7 分鐘，
//    遲到者約三分之一用它把遲到抹掉，實質變成「消遲到」按鈕。真的忘記打卡請走「📝 補登／修改」。

async function doPunch(type){
  if(!atStore){ toast('不在門市範圍內'); return; }
  // 防抖：同類型 10 分鐘內只成功一次
  const now=new Date();
  const dup=todayPunches.find(p=>p.type===type && p.deviceTs && (now-new Date(p.deviceTs))<10*60*1000);
  if(dup){ toast(`剛剛已${type}打卡，10 分鐘內不用再打`); return; }
  // 上班後 5 分鐘內不能打下班（避免誤按）
  if(type==='下班'){
    const lastIn=todayPunches.filter(p=>p.type==='上班').map(p=>p.deviceTs).filter(Boolean).sort().pop();
    if(lastIn && (now-new Date(lastIn))<5*60*1000){ toast('上班後 5 分鐘內不能打下班'); return; }
    // 也擋離線佇列裡剛打的上班（尚未補傳）
    const qIn=offlineQueue().filter(o=>o.type==='上班').map(o=>o.clientPunchTime).filter(Boolean).sort().pop();
    if(qIn && (now-new Date(qIn))<5*60*1000){ toast('上班後 5 分鐘內不能打下班'); return; }
  }
  showLoading('定位中…');
  // 🌟 打卡「當下」重新抓即時定位，避免在店內開頁面後走遠再打卡
  let fg;
  try{ fg=await freshGeo(); }
  catch(e){ hideLoading(); toast('定位失敗：'+(e.message||e)); return; }
  myGeo=fg.geo; atStore=fg.store; distanceM=fg.dist;
  if(!atStore){ hideLoading(); render(); toast('目前不在門市範圍內，無法打卡'); return; }
  // 🌟 加班事前防呆：打卡落在非排班時段(無排班／上班早>30分／下班晚>30分) → 詢問加班或私事
  let otIntent=null, otContent='';
  const os=offSchedule(type, serverNowMs());
  if(os.off){
    hideLoading();
    const choice=await otPrompt(os.reason);
    if(choice===null) return; // 取消
    otIntent=choice.intent; otContent=choice.content||'';
  }
  // 遲到才打卡 → 先告知會記錄的時間，並讓員工留一句說明（不改時間）
  let empNote='';
  if(!os.off && type==='上班'){
    const nm=serverNowMs();
    const sh=matchPunchShift(candShifts, nm, '上班');
    if(sh){
      const lateMin=lateMinutesOf(nm, sh.startMs);
      if(lateMin>0){
        hideLoading();
        const schedT=new Date(sh.startMs).toLocaleTimeString('zh-TW',{hour12:false,hour:'2-digit',minute:'2-digit'});
        const nowHm=new Date(nm).toLocaleTimeString('zh-TW',{hour12:false,hour:'2-digit',minute:'2-digit'});
        const ln=await latePrompt(lateMin, schedT, nowHm);
        if(ln===null) return;   // 取消打卡
        empNote=ln.note||'';
        showLoading('打卡中…');
      }
    }
  }
  showLoading('打卡中…');
  // 🌟 交由後端 callable 權威判定（伺服器時間＋複驗圍欄＋狀態），前端只送座標
  try{
    const fn=firebase.app().functions('asia-east1').httpsCallable('clockPunch');
    const res=await fn({ lat:myGeo.lat, lng:myGeo.lng, accuracy:myGeo.acc, type,
      clientTime:new Date().toISOString(), deviceInfo:navigator.userAgent, punchMethod:'GPS', otIntent, otContent, empNote });
    const r=res.data||{};
    hideLoading();
    const msg = r.status==='遲到'?`⚠️ ${type}打卡成功（遲到 ${r.lateMin} 分）`
      : r.status==='早退'?`⚠️ ${type}打卡成功（早退）`
      : r.status==='警告'?`${type}打卡成功（遲到 ${r.lateMin} 分，容許內）`
      : `✅ ${type}打卡成功`;
    const otTail = otIntent==='apply'?'\n📝 已送出加班申請，待店長審核（同意才計工時）':otIntent==='private'?'\n🅿️ 已記為不計工時（非加班）':'';
    toast(`${msg}　${r.hm||''} @${r.atStore||atStore}${otTail}`);
    await loadToday(); render();
  }catch(e){
    hideLoading();
    // 網路不佳/離線 → 暫存本機，恢復連線後自動補傳（記手機當下時間，回傳後由店長複核）
    if(!navigator.onLine || /unavailable|deadline|network|internal|fetch|failed/i.test(String(e.code||e.message||e))){
      queueOffline({ lat:myGeo.lat, lng:myGeo.lng, accuracy:myGeo.acc, type,
        clientPunchTime:new Date().toISOString(), deviceInfo:navigator.userAgent, punchMethod:'GPS', atStore });
      toast('📴 目前無法連線，已離線暫存，恢復連線後自動補傳');
      render();
    } else {
      toast('打卡失敗：'+(e.message||e));
    }
  }
}

// ===== 離線打卡快取 =====
const OFFLINE_KEY='offlinePunches';
function offlineQueue(){ try{ return JSON.parse(localStorage.getItem(OFFLINE_KEY)||'[]'); }catch(e){ return []; } }
function saveQueue(q){ localStorage.setItem(OFFLINE_KEY, JSON.stringify(q)); }
function queueOffline(item){ const q=offlineQueue(); q.push(item); saveQueue(q); }
async function flushOffline(){
  let q=offlineQueue(); if(!q.length) return;
  const fn=firebase.app().functions('asia-east1').httpsCallable('clockPunchOffline');
  const remain=[]; let ok=0;
  for(const it of q){
    try{ await fn(it); ok++; }
    catch(e){ if(!navigator.onLine){ remain.push(it); } else { remain.push(it); } }
  }
  saveQueue(remain);
  if(ok>0){ toast(`✅ 已補傳 ${ok} 筆離線打卡（待店長複核）`); try{ if(atStore) await loadToday(); }catch(e){} render(); }
}
window.addEventListener('online', ()=>{ flushOffline(); });
