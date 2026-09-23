// ===== 狀態 =====
let currentUser = null;
let appConfig = { stores: [], shifts: [], shiftHours: {} };

// ===== 工具 =====
function showLoading(txt) {
  const el = document.getElementById('loadingOverlay');
  el.classList.add('active');
  document.getElementById('loadingText').textContent = txt || '載入中...';
}
function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('active');
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

function canAdmin()   { return ['admin'].includes(currentUser?.permission); }
function canOwner()   { return ['owner','admin'].includes(currentUser?.permission); }
function canManager() { return ['manager','owner','admin'].includes(currentUser?.permission); }
// 折疊式設定項：點標題展開/收合
function toggleSet(head){
  const item = head.closest('.set-item'); if(!item) return;
  item.classList.toggle('set-open');
  const chev = head.querySelector('.set-chev');
  if(chev) chev.textContent = item.classList.contains('set-open') ? '▾' : '▸';
}

// ===== 初始化 =====
window.onload = async () => {
  showLoading('驗證登入...');
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if(!saved) { window.location.replace('home.html'); return; }
  try { currentUser = JSON.parse(saved); } catch { window.location.replace('home.html'); return; }
  const _fbAuth = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(fb => { u(); r(fb); }); });
  if (!_fbAuth) { localStorage.removeItem('currentUser'); sessionStorage.removeItem('currentUser'); window.location.replace('home.html'); return; }

  try {
    const snap = await window.db.collection('settings').doc('globalConfig').get();
    if(snap.exists) appConfig = snap.data();
  } catch(e) {}

  // 更新 header
  const PERM_LABELS = { manager:'店長', owner:'加盟主', admin:'系統管理者' };
  document.getElementById('headerInfo').innerHTML =
    `${currentUser.displayName || currentUser.empName || ''}<br>${PERM_LABELS[currentUser.permission] || ''} · ${currentUser.store || ''}`;

  // 依權限顯示區塊
  const showEl=(id,ok)=>{const el=document.getElementById(id);if(el)el.style.display=ok?'block':'none';};
  // 各設定項依權限顯示（分類分組）
  showEl('itemClock', canAdmin()); showEl('itemStoreMgmt', canAdmin()); showEl('itemCity', canAdmin()); showEl('itemMaint', canAdmin()); showEl('itemLineKw', canAdmin()); showEl('itemNotice', canAdmin()); showEl('itemTour', canAdmin()); showEl('itemAppUsage', canAdmin());
  showEl('itemShift', canManager());
  showEl('itemInsurance', canOwner()); showEl('itemHoliday', canOwner());
  showEl('itemChangelog', true);
  if(canAdmin()){ loadLineKeywords(); loadMaintenanceState(); loadClockConfig(); loadCitySummary(); loadNoticeStats(); loadTourStats(); loadAppUsageStats(); }
  // 群組標題：該類任一項可見才顯示整組
  [['grpOps',['itemClock','itemShift','itemStoreMgmt','itemCity']],['grpPayLaw',['itemInsurance','itemHoliday']],['grpSystem',['itemMaint','itemLineKw','itemNotice','itemAppUsage','itemTour','itemChangelog']]]
    .forEach(([g,items])=>{ const any=items.some(id=>{const el=document.getElementById(id);return el&&el.style.display!=='none';}); showEl(g,any); });

  hideLoading();
};

// ===== 系統基礎設定 =====
async function openSysConfigModal() {
  const listEl = document.getElementById('sysStoreList');
  listEl.innerHTML = '';
  (appConfig.stores || []).forEach(s => {
    listEl.innerHTML += `<div style="display:flex; align-items:center; gap:8px; padding:8px; background:#f8fafc; border-radius:8px; margin-bottom:6px;">
      <span style="flex:1; font-weight:700;">${s}</span>
      <button onclick="removeSysStore('${s}')" style="background:#fce8e6; color:var(--danger); border:none; border-radius:6px; padding:4px 10px; font-size:12px; font-weight:700; cursor:pointer;">刪除</button>
    </div>`;
  });

  // 國定假日區塊（管理者才顯示）
  holidayMgrYear = new Date().getFullYear();
  openModal('sysConfigModal');
}

function addSysStore() {
  const val = document.getElementById('sysNewStore').value.trim();
  if(!val) { showToast('⚠️ 請輸入門市名稱'); return; }
  if(appConfig.stores.includes(val)) { showToast('⚠️ 門市已存在'); return; }
  appConfig.stores.push(val);
  document.getElementById('sysNewStore').value = '';
  openSysConfigModal();
}

function removeSysStore(name) {
  if(!confirm(`確定刪除「${name}」門市？\n此操作不影響已儲存的排班資料。`)) return;
  appConfig.stores = appConfig.stores.filter(s => s !== name);
  openSysConfigModal();
}

// ===== LINE 群組關鍵字（格子編輯：左多關鍵字 → 右回覆）=====
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function kwRowHtml(keys, reply){
  const ta = 'padding:8px; border:1.5px solid var(--border); border-radius:8px; font-size:13px; font-family:inherit; box-sizing:border-box; resize:vertical;';
  return `<div class="kw-row" style="display:flex; gap:8px; margin-bottom:8px; align-items:stretch;">
    <textarea class="kw-keys" placeholder="班表&#10;排班&#10;班" style="flex:1; min-height:64px; ${ta}">${_esc((keys||[]).join('\n'))}</textarea>
    <textarea class="kw-reply" placeholder="回覆內容" style="flex:1.5; min-height:64px; ${ta}">${_esc(reply||'')}</textarea>
    <button onclick="this.closest('.kw-row').remove()" title="刪除此列" style="width:32px; flex-shrink:0; background:#fce8e6; color:var(--danger); border:none; border-radius:8px; font-size:16px; cursor:pointer;">🗑</button>
  </div>`;
}
function addKwRow(keys, reply){
  document.getElementById('kwGrid').insertAdjacentHTML('beforeend', kwRowHtml(keys, reply));
}
// ===== 系統維護模式 =====
// CITY手順：入口顯示待確認筆數與同步狀態
// ⚠️ 筆數要數 cityPending 本身：cityMeta/sync.pending 只在同步時更新，發佈後會是舊數字
async function loadCitySummary() {
  try {
    const [d, pend] = await Promise.all([window.db.collection('cityMeta').doc('sync').get(), window.db.collection('cityPending').get()]);
    if(!d.exists) return;
    const m = d.data(); const n = pend.size;
    const sub = document.getElementById('citySub');
    if(!m.ok) { sub.innerHTML = '<b style="color:var(--danger);">上次同步失敗，點進去看原因</b>'; return; }
    sub.innerHTML = n ? `<b style="color:#e65100;">待確認 ${n} 筆</b>・確認後才會發佈給員工` : '沒有待確認的變動';
  } catch(e) {}
}

// ===== 系統公告已讀統計（notices/{id}/reads）=====
// 應讀名單＝各店 employees 裡「在職」的人（離職已生效者排除；調走的人不在原店名單）；以 empName 對 reads.empName
async function loadNoticeStats() {
  const box = document.getElementById('noticeStats');
  try {
    const ns = await window.db.collection('notices').get();
    if(ns.empty) { box.textContent = '目前沒有公告'; return; }
    const notices = ns.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => ((b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0))).slice(0, 3);
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
    const roster = []; // {name, store}
    for(const st of (appConfig.stores || [])) {
      const es = await window.db.collection('stores').doc(st).collection('employees').get().catch(() => null);
      if(es) es.forEach(d => {
        const e = d.data() || {};
        if(e.status === '調走') return;
        if(e.status === '離職' && (!e.retireDate || today >= e.retireDate)) return;
        roster.push({ name: d.id, store: st, disp: e.displayName || d.id });
      });
    }
    const fmt = (ts) => { if(!ts || !ts.toDate) return ''; const x = ts.toDate(); return `${x.getMonth()+1}/${x.getDate()} ${String(x.getHours()).padStart(2,'0')}:${String(x.getMinutes()).padStart(2,'0')}`; };
    const parts = [];
    for(const n of notices) {
      const rs = await window.db.collection('notices').doc(n.id).collection('reads').get();
      const readBy = new Map(rs.docs.map(d => [d.data().empName, d.data()]));
      const read = roster.filter(r => readBy.has(r.name));
      const unreadByStore = {};
      roster.filter(r => !readBy.has(r.name)).forEach(r => (unreadByStore[r.store] ||= []).push(r.disp));
      const extra = rs.size - read.length; // 名單外（admin、加盟主等不在門市員工名單的人）
      parts.push(`<div style="border:1.5px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;font-weight:800;">${_esc(n.title)}</div>
          <span style="font-size:11px;font-weight:800;color:${n.active ? '#137333' : 'var(--text-muted)'};">${n.active ? '跳出中' : '已停止'}</span>
        </div>
        <div style="margin:6px 0;"><b style="font-size:18px;color:var(--primary);">${read.length}</b> / ${roster.length} 位在職員工已讀${extra > 0 ? `<span style="color:var(--text-muted);">（另有 ${extra} 位非門市名單）</span>` : ''}</div>
        ${Object.keys(unreadByStore).length ? `<div style="font-size:12px;color:var(--text-muted);line-height:1.7;">還沒看過：${Object.entries(unreadByStore).map(([st, ns]) => `<br><b style="color:var(--text);">${_esc(st)}</b>　${ns.map(_esc).join('、')}`).join('')}</div>` : '<div style="font-size:12px;color:#137333;">✅ 全部在職員工都看過了</div>'}
        <details style="margin-top:6px;font-size:12px;"><summary style="cursor:pointer;color:var(--primary);">已讀明細（${rs.size}）</summary>
          ${rs.docs.map(d => { const r = d.data(); return `<div>${_esc(r.displayName || r.empName)}・${_esc(r.store)}・首次 ${fmt(r.firstAt)}・看了 ${r.count || 1} 次</div>`; }).join('')}
        </details>
        ${n.active ? `<button onclick="stopNotice('${_esc(n.id)}')" style="margin-top:8px;padding:7px 12px;border:1.5px solid var(--border);background:white;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;">停止跳出</button>` : ''}
      </div>`);
    }
    box.innerHTML = parts.join('');
  } catch(e) {
    box.textContent = '讀取失敗：' + e.message;
  }
}
// ===== 主畫面與推播使用狀況（users/{uid}.appUsage 由 home-push.js 記錄；pushSubs 由 Cloud Function 寫入、規則只給 admin 讀）=====
// 「主畫面」＝近 30 天內至少一次從主畫面圖示開首頁；紀錄從 2026-09-15 起才有，之前沒開過首頁的人會顯示「還沒有紀錄」
async function loadAppUsageStats() {
  const box = document.getElementById('appUsageStats');
  if(!box) return;
  try {
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
    const roster = [];
    for(const st of (appConfig.stores || [])) {
      const es = await window.db.collection('stores').doc(st).collection('employees').get().catch(() => null);
      if(es) es.forEach(d => {
        const e = d.data() || {};
        if(e.status === '調走') return;
        if(e.status === '離職' && (!e.retireDate || today >= e.retireDate)) return;
        roster.push({ name: d.id, store: st, disp: e.displayName || d.id });
      });
    }
    const [us, ps] = await Promise.all([window.db.collection('users').get(), window.db.collection('pushSubs').get()]);
    const usageBy = new Map(); const uidBy = new Map();
    us.forEach(d => { const u = d.data() || {}; if(u.empName) { usageBy.set(u.empName, u.appUsage || null); uidBy.set(u.empName, d.id); } });
    const pushCount = {}; const origins = {};
    ps.forEach(d => { const p = d.data() || {}; pushCount[p.uid] = (pushCount[p.uid] || 0) + 1; origins[p.origin || '?'] = (origins[p.origin || '?'] || 0) + 1; });
    const ms = (ts) => ts && ts.toMillis ? ts.toMillis() : 0;
    const d30 = Date.now() - 30 * 86400000;
    const g = { home: [], browser: [], none: [] };
    let pushOn = 0;
    roster.forEach(r => {
      const a = usageBy.get(r.name);
      const push = pushCount[uidBy.get(r.name)] || 0;
      if(push) pushOn++;
      const tag = `${_esc(r.disp)}${push ? '🔔' : ''}${a && a.platform ? `<span style="color:var(--text-muted);">(${a.platform === 'ios' ? 'iPhone' : a.platform === 'android' ? 'Android' : '電腦'})</span>` : ''}`;
      if(a && ms(a.lastStandaloneAt) > d30) g.home.push({ ...r, tag });
      else if(a && ms(a.lastBrowserAt)) g.browser.push({ ...r, tag });
      else g.none.push({ ...r, tag });
    });
    const byStore = (list) => {
      const m = {}; list.forEach(r => (m[r.store] ||= []).push(r.tag));
      return Object.entries(m).map(([st, ns]) => `<br><b style="color:var(--text);">${_esc(st)}</b>　${ns.join('、')}`).join('');
    };
    box.innerHTML = `<div style="border:1.5px solid var(--border);border-radius:12px;padding:10px 12px;line-height:1.7;">
      <div>從主畫面開：<b style="font-size:18px;color:var(--primary);">${g.home.length}</b>　只用瀏覽器：<b>${g.browser.length}</b>　還沒有紀錄：<b>${g.none.length}</b>　／ 在職 ${roster.length} 人</div>
      <div>開啟推播：<b style="font-size:18px;color:var(--primary);">${pushOn}</b> 人（共 ${ps.size} 台裝置${ps.size ? '；' + Object.entries(origins).map(([o, n]) => `${_esc(o)} ${n}`).join('、') : ''}）</div>
      ${g.home.length ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">主畫面：${byStore(g.home)}</div>` : ''}
      ${g.browser.length ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">只用瀏覽器：${byStore(g.browser)}</div>` : ''}
      ${g.none.length ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">還沒有紀錄：${byStore(g.none)}</div>` : ''}
      <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">🔔＝已開推播。紀錄從 2026-09-15 起，員工打開新版首頁後才會出現。</div>
    </div>`;
  } catch(e) {
    box.textContent = '讀取失敗：' + e.message;
  }
}

// ===== 新版首頁教學完成率（users/{uid}.homeTour，見 home-tour.js）=====
// 應看名單與公告已讀統計相同：各店 employees「在職」者，以 empName 對 users.empName
var TOUR_VERSION_FOR_STATS = 'home-2026-09';   // 與 home-tour.js 的 HOME_TOUR_VERSION 同值
async function loadTourStats() {
  const box = document.getElementById('tourStats');
  if(!box) return;
  try {
    const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
    const roster = [];
    for(const st of (appConfig.stores || [])) {
      const es = await window.db.collection('stores').doc(st).collection('employees').get().catch(() => null);
      if(es) es.forEach(d => {
        const e = d.data() || {};
        if(e.status === '調走') return;
        if(e.status === '離職' && (!e.retireDate || today >= e.retireDate)) return;
        roster.push({ name: d.id, store: st, disp: e.displayName || d.id });
      });
    }
    const us = await window.db.collection('users').get();
    const tourBy = new Map();
    us.forEach(d => { const u = d.data() || {}; if(u.empName) tourBy.set(u.empName, u.homeTour || null); });
    const buckets = { done: [], skipped: [], none: [] };
    roster.forEach(r => {
      const t = tourBy.get(r.name);
      if(t && t.v === TOUR_VERSION_FOR_STATS && t.done) buckets.done.push(r);
      else if(t && t.v === TOUR_VERSION_FOR_STATS && t.skips > 0) buckets.skipped.push({ ...r, skips: t.skips });
      else buckets.none.push(r);
    });
    const byStore = (list, fmt) => {
      const g = {};
      list.forEach(r => (g[r.store] ||= []).push(fmt ? fmt(r) : _esc(r.disp)));
      return Object.entries(g).map(([st, ns]) => `<br><b style="color:var(--text);">${_esc(st)}</b>　${ns.join('、')}`).join('');
    };
    box.innerHTML = `<div style="border:1.5px solid var(--border);border-radius:12px;padding:10px 12px;">
      <div style="margin-bottom:6px;"><b style="font-size:18px;color:var(--primary);">${buckets.done.length}</b> / ${roster.length} 位在職員工看完教學</div>
      ${buckets.skipped.length ? `<div style="font-size:12px;color:var(--text-muted);line-height:1.7;margin-bottom:4px;">跳過或中途離開（跳過 2 次後不再自動出現）：${byStore(buckets.skipped, r => `${_esc(r.disp)}(${r.skips})`)}</div>` : ''}
      ${buckets.none.length ? `<div style="font-size:12px;color:var(--text-muted);line-height:1.7;">還沒開過新版首頁：${byStore(buckets.none)}</div>` : '<div style="font-size:12px;color:#137333;">✅ 全部在職員工都開過新版首頁了</div>'}
    </div>`;
  } catch(e) {
    box.textContent = '讀取失敗：' + e.message;
  }
}

async function stopNotice(id) {
  if(!confirm('停止跳出這則公告？已讀紀錄會保留。')) return;
  try {
    await window.db.collection('notices').doc(id).update({ active: false, stoppedAt: new Date().toISOString(), stoppedBy: currentUser.empName || '' });
    showToast('已停止跳出');
    loadNoticeStats();
  } catch(e) { showToast('失敗：' + e.message); }
}

async function loadMaintenanceState() {
  try {
    const d = await window.db.collection('settings').doc('maintenance').get();
    const on = !!(d.exists && d.data().enabled);
    const t = document.getElementById('maintenanceToggle');
    if(t) t.checked = on;
    const st = document.getElementById('maintenanceStatus');
    if(st) st.textContent = on ? '目前：🔧 維護中' : '目前：關閉';
  } catch(e) {}
}
async function toggleMaintenance(on) {
  const t = document.getElementById('maintenanceToggle');
  if(on && !confirm('確定啟用「系統維護模式」？\n\n管理者以外的人登入都會被擋在「系統維護中」畫面。')) { if(t) t.checked = false; return; }
  if(!on && !confirm('確定關閉維護、恢復系統？\n\n會通知所有登記「完成後通知我」的使用者（有開推播發推播，否則 LINE）。')) { if(t) t.checked = true; return; }
  try {
    await window.db.collection('settings').doc('maintenance').set({
      enabled: on, updatedBy: currentUser.empName || '', updatedAt: new Date().toISOString()
    }, { merge: true });
    document.getElementById('maintenanceStatus').textContent = on ? '目前：🔧 維護中' : '目前：關閉';
    showToast(on ? '🔧 已啟用維護模式' : '✅ 已關閉維護，將通知登記者');
  } catch(e) { showToast('失敗：' + e.message); if(t) t.checked = !on; }
}
// ===== 打卡系統設定（功能旗標＋門市座標）=====
function loadClockConfig() {
  renderClockGeo();   // 2026-09-23：打卡一律開啟，沒有 stage 下拉要回填了
}
function renderClockGeo() {
  const grid = document.getElementById('clockGeoGrid');
  if(!grid) return;
  const geo = ((appConfig.clockIn||{}).geo) || {};
  const stores = (appConfig.stores||[]).filter(s=>s!=='人力支援');
  grid.innerHTML = stores.map(s=>{
    const g = geo[s] || {};
    return `<div style="background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <b style="font-size:14px;">${s}</b>
        <button onclick="captureStoreGeo('${s.replace(/'/g,'')}')" style="background:var(--primary);color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:800;cursor:pointer;">📍 抓當下座標</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <input data-geo="${s}" data-k="lat" type="number" step="0.000001" placeholder="緯度 lat" value="${g.lat!=null?g.lat:''}" style="flex:1;min-width:110px;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;">
        <input data-geo="${s}" data-k="lng" type="number" step="0.000001" placeholder="經度 lng" value="${g.lng!=null?g.lng:''}" style="flex:1;min-width:110px;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;">
        <input data-geo="${s}" data-k="radiusM" type="number" placeholder="半徑m" value="${g.radiusM!=null?g.radiusM:120}" style="width:80px;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;">
      </div>
      <div id="geoAcc-${s}" style="font-size:11px;color:var(--text-muted);margin-top:4px;"></div>
    </div>`;
  }).join('') || '<div style="font-size:12px;color:var(--text-muted);">尚無門市</div>';
}
function captureStoreGeo(store){
  const acc=document.getElementById('geoAcc-'+store);
  if(!navigator.geolocation){ showToast('此裝置不支援定位'); return; }
  if(acc) acc.textContent='定位中…';
  navigator.geolocation.getCurrentPosition(p=>{
    const lat=p.coords.latitude, lng=p.coords.longitude, a=Math.round(p.coords.accuracy);
    const li=document.querySelector(`input[data-geo="${store}"][data-k="lat"]`);
    const gi=document.querySelector(`input[data-geo="${store}"][data-k="lng"]`);
    if(li) li.value=lat.toFixed(6); if(gi) gi.value=lng.toFixed(6);
    if(acc) acc.textContent=`✅ 已抓：${lat.toFixed(6)}, ${lng.toFixed(6)}（精度約 ${a}m，可多抓幾次確認）`;
  }, e=>{ if(acc) acc.textContent='❌ 定位失敗：'+e.message; showToast('定位失敗：'+e.message); }, {enableHighAccuracy:true,timeout:10000,maximumAge:0});
}
async function saveClockConfig(){
  const geo={};
  (appConfig.stores||[]).filter(s=>s!=='人力支援').forEach(s=>{
    const lat=parseFloat((document.querySelector(`input[data-geo="${s}"][data-k="lat"]`)||{}).value);
    const lng=parseFloat((document.querySelector(`input[data-geo="${s}"][data-k="lng"]`)||{}).value);
    const radiusM=parseInt((document.querySelector(`input[data-geo="${s}"][data-k="radiusM"]`)||{}).value)||120;
    if(!isNaN(lat)&&!isNaN(lng)) geo[s]={lat,lng,radiusM};
  });
  try{
    await window.db.collection('settings').doc('globalConfig').set({ clockIn:{ geo } }, { merge:true });
    appConfig.clockIn=Object.assign({}, appConfig.clockIn, { geo });
    showToast('✅ 打卡設定已儲存');
  }catch(e){ showToast('儲存失敗：'+e.message); }
}
async function loadLineKeywords() {
  try {
    const snap = await window.db.collection('settings').doc('lineKeywords').get();
    const list = (snap.exists && Array.isArray(snap.data().list)) ? snap.data().list : [];
    const grid = document.getElementById('kwGrid');
    grid.innerHTML = '';
    list.forEach(p => {
      const keys = Array.isArray(p.keys) ? p.keys : (p.k != null ? [p.k] : []);
      addKwRow(keys, p.r || '');
    });
    if(!list.length) addKwRow([], ''); // 至少一列空白供輸入
  } catch(e) {}
}
async function saveLineKeywords() {
  const list = [];
  document.querySelectorAll('#kwGrid .kw-row').forEach(row => {
    const keys = (row.querySelector('.kw-keys').value || '')
      .split(/[\n,、，]/).map(s => s.trim()).filter(Boolean);
    const r = (row.querySelector('.kw-reply').value || '').trim();
    const uniqKeys = [...new Set(keys)];
    if(uniqKeys.length && r) list.push({ keys: uniqKeys, r });
  });
  showLoading('儲存關鍵字中...');
  try {
    await window.db.collection('settings').doc('lineKeywords').set({ list, updatedAt: new Date().toISOString() });
    hideLoading();
    const kwCount = list.reduce((n,p)=>n+p.keys.length,0);
    showToast(`✅ 已儲存 ${list.length} 列 / ${kwCount} 個關鍵字`);
  } catch(e) { hideLoading(); showToast('❌ 儲存失敗：' + e.message); }
}

async function saveSysConfig() {
  showLoading('儲存系統設定中...');
  try {
    await window.db.collection('settings').doc('globalConfig').set(appConfig, { merge: true });
    localStorage.setItem('appConfig', JSON.stringify(appConfig));
    closeModal('sysConfigModal');
    showToast('✅ 系統設定已儲存');
  } catch(e) {
    showToast('❌ 儲存失敗：' + e.message);
  }
  hideLoading();
}

// ===== 國定假日管理 =====
// 國定假日：全專案唯一來源在 holidays.js（原本各頁一份拷貝、五份互相矛盾且全錯）
const BUILTIN_HOLIDAYS = builtinHolidaysByYear();

let holidayMgrYear = new Date().getFullYear();
let holidayMgrData = {};

async function loadHolidayMgrData(year) {
  if(holidayMgrData[year]) return;
  try {
    const snap = await window.db.collection('settings').doc('holidays').collection('years').doc(String(year)).get();
    if(snap.exists) {
      holidayMgrData[year] = { ...snap.data().dates };
    } else {
      holidayMgrData[year] = { ...(BUILTIN_HOLIDAYS[String(year)] || {}) };
    }
  } catch(e) {
    holidayMgrData[year] = { ...(BUILTIN_HOLIDAYS[String(year)] || {}) };
  }
}

async function openHolidayModal() {
  holidayMgrYear = new Date().getFullYear();
  await loadHolidayMgrData(holidayMgrYear);
  renderHolidayYearTabs();
  renderHolidayList();
  openModal('holidayModal');
}

function renderHolidayYearTabs() {
  const curY = new Date().getFullYear();
  const years = [curY - 1, curY, curY + 1];
  document.getElementById('holidayYearTabs').innerHTML = years.map(y =>
    `<button onclick="switchHolidayYear(${y})"
      style="padding:5px 14px; border-radius:16px; border:1.5px solid ${y===holidayMgrYear?'var(--primary)':'var(--border)'};
      background:${y===holidayMgrYear?'var(--primary)':'white'}; color:${y===holidayMgrYear?'white':'var(--text-muted)'};
      font-size:12px; font-weight:700; cursor:pointer;">${y}年</button>`
  ).join('');
}

async function switchHolidayYear(year) {
  holidayMgrYear = year;
  await loadHolidayMgrData(year);
  renderHolidayYearTabs();
  renderHolidayList();
}

function renderHolidayList() {
  const data = holidayMgrData[holidayMgrYear] || {};
  const el = document.getElementById('holidayList');
  const entries = Object.entries(data).sort((a,b) => a[0].localeCompare(b[0]));
  if(!entries.length) {
    el.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:16px;">尚無假日資料</div>';
    return;
  }
  el.innerHTML = entries.map(([date, name]) => {
    const d = new Date(date);
    const wd = ['日','一','二','三','四','五','六'][d.getDay()];
    return `<div class="holiday-item">
      <span class="holiday-date">${date.slice(5)} (${wd})</span>
      <span class="holiday-name">${name}</span>
      <button class="holiday-del" onclick="removeHoliday('${date}')">✕</button>
    </div>`;
  }).join('');
}

async function addHoliday() {
  const date = document.getElementById('holidayNewDate').value;
  const name = document.getElementById('holidayNewName').value.trim();
  if(!date || !name) { showToast('⚠️ 請填寫日期與假日名稱'); return; }
  const year = date.split('-')[0];
  if(parseInt(year) !== holidayMgrYear) { showToast(`⚠️ 請新增 ${holidayMgrYear} 年的假日`); return; }
  if(!holidayMgrData[holidayMgrYear]) holidayMgrData[holidayMgrYear] = {};
  holidayMgrData[holidayMgrYear][date] = name;
  document.getElementById('holidayNewDate').value = '';
  document.getElementById('holidayNewName').value = '';
  renderHolidayList();
}

async function removeHoliday(dateStr) {
  if(!confirm(`確定移除「${dateStr} ${holidayMgrData[holidayMgrYear]?.[dateStr]}」？`)) return;
  delete holidayMgrData[holidayMgrYear][dateStr];
  renderHolidayList();
}

async function saveHolidayYear(year) {
  showLoading('儲存假日設定中...');
  try {
    await window.db.collection('settings').doc('holidays').collection('years').doc(String(year))
      .set({ dates: holidayMgrData[year] || {} });
    closeModal('holidayModal');
    showToast('✅ 假日設定已儲存');
  } catch(e) {
    showToast('❌ 儲存失敗：' + e.message);
  }
  hideLoading();
}

// ===== 門市班別設定 =====
const DEFAULT_SHIFTS = ['7-15','15-23','23-07','18-23','清空','指休','排休'];
const DEFAULT_SHIFT_HOURS = { '7-15':8, '15-23':8, '23-07':8, '18-23':5 };
let storeConfig = { shifts: [...DEFAULT_SHIFTS], shiftHours: {...DEFAULT_SHIFT_HOURS}, quickNotes: ['作帳','訂鮮食','訂捷盟','訂乳品18度C'] };

async function openStoreConfigModal(targetStore) {
  const isMulti = canOwner();
  const stores = isMulti ? (appConfig.stores || []) : [currentUser.store || appConfig.stores?.[0] || ''];
  const store = targetStore || currentUser.store || stores[0] || '';

  const tabsEl = document.getElementById('storeConfigTabs');
  if(isMulti && stores.length > 1) {
    tabsEl.style.display = 'flex';
    tabsEl.innerHTML = stores.map(s =>
      `<button style="padding:5px 14px;border-radius:16px;border:1.5px solid ${s===store?'var(--primary)':'var(--border)'};background:${s===store?'var(--primary)':'white'};color:${s===store?'white':'var(--text-muted)'};font-size:12px;font-weight:700;cursor:pointer;"
        onclick="openStoreConfigModal('${s}')">${s}</button>`
    ).join('');
  } else { tabsEl.style.display = 'none'; }

  document.getElementById('storeConfigStore').value = store;
  document.getElementById('storeConfigSub').textContent = `「${store}」班別快捷設定`;
  document.getElementById('storeConfigFirstSave').style.display = 'none';

  showLoading('讀取門市設定...');
  try {
    const snap = await window.db.collection('stores').doc(store).collection('config').doc('shifts').get();
    if(snap.exists) {
      storeConfig = {
        shifts:     snap.data().shifts     || [...DEFAULT_SHIFTS],
        shiftHours: snap.data().shiftHours || {...DEFAULT_SHIFT_HOURS},
        quickNotes: snap.data().quickNotes || ['作帳','訂鮮食','訂捷盟','訂乳品18度C'],
        leaveQuota: snap.data().leaveQuota || { fullTime: 2, partTime: 1 }
      };
    } else {
      storeConfig = {
        shifts: [...(appConfig.shifts || DEFAULT_SHIFTS)],
        shiftHours: {...(appConfig.shiftHours || DEFAULT_SHIFT_HOURS)},
        quickNotes: appConfig.quickNotes ? [...appConfig.quickNotes] : ['作帳','訂鮮食','訂捷盟','訂乳品18度C'],
        leaveQuota: { fullTime: 2, partTime: 1 }
      };
      document.getElementById('storeConfigFirstSave').style.display = 'block';
    }
  } catch(e) {}
  hideLoading();

  renderShiftBtnList();
  renderNoteBtnList();
  document.getElementById('newShiftBtn').value = '';
  document.getElementById('newShiftHours').value = '';
  document.getElementById('newNoteBtn').value = '';
  const _q = storeConfig.leaveQuota || {};
  document.getElementById('quotaFullTime').value = _q.fullTime ?? 2;
  document.getElementById('quotaPartTime').value = _q.partTime ?? 1;
  document.getElementById('quotaPartUnlimited').checked = _q.partTimeUnlimited === true;
  document.getElementById('quotaPartTime').disabled = _q.partTimeUnlimited === true;
  document.getElementById('quotaWeeklyFull').value = _q.weeklyFull ?? 2;
  document.getElementById('quotaHardBlock').checked = _q.hardBlock === true;

  if(!document.getElementById('storeConfigModal').classList.contains('active'))
    openModal('storeConfigModal');
}

function renderShiftBtnList() {
  document.getElementById('shiftBtnList').innerHTML = storeConfig.shifts.map(s => {
    const isDefault = DEFAULT_SHIFTS.includes(s);
    const h = storeConfig.shiftHours[s] || '';
    return `<div style="display:inline-flex;align-items:center;background:${isDefault?'#f1f3f4':'#e8f0fe'};border-radius:8px;padding:5px 8px;gap:4px;font-size:12px;font-weight:700;">
      <span>${s}${h?` <span style="color:var(--text-muted);font-size:10px;">(${h}h)</span>`:''}</span>
      ${isDefault ? '<span style="color:var(--text-muted);font-size:10px;">預設</span>' :
        `<span onclick="removeShiftBtn('${s}')" style="cursor:pointer;color:var(--danger);font-size:13px;font-weight:900;">✕</span>`}
    </div>`;
  }).join('');
}

function renderNoteBtnList() {
  document.getElementById('noteBtnList').innerHTML = storeConfig.quickNotes.map(n =>
    `<div style="display:inline-flex;align-items:center;background:#e8f0fe;border-radius:8px;padding:6px 10px;gap:6px;font-size:13px;font-weight:700;">
      ${n}
      <span onclick="removeNoteBtn('${n}')" style="cursor:pointer;color:var(--danger);font-size:14px;font-weight:900;">✕</span>
    </div>`
  ).join('');
}

function addShiftBtn() {
  const name = document.getElementById('newShiftBtn').value.trim();
  const hours = parseFloat(document.getElementById('newShiftHours').value) || 0;
  if(!name) { showToast('⚠️ 請輸入班別名稱'); return; }
  if(storeConfig.shifts.includes(name)) { showToast('⚠️ 此班別已存在'); return; }
  storeConfig.shifts.push(name);
  if(hours) storeConfig.shiftHours[name] = hours;
  document.getElementById('newShiftBtn').value = '';
  document.getElementById('newShiftHours').value = '';
  renderShiftBtnList();
}

function removeShiftBtn(name) {
  if(DEFAULT_SHIFTS.includes(name)) { showToast('⚠️ 預設班別不可刪除'); return; }
  storeConfig.shifts = storeConfig.shifts.filter(s => s !== name);
  delete storeConfig.shiftHours[name];
  renderShiftBtnList();
}

function addNoteBtn() {
  const name = document.getElementById('newNoteBtn').value.trim();
  if(!name) { showToast('⚠️ 請輸入備註文字'); return; }
  if(storeConfig.quickNotes.includes(name)) { showToast('⚠️ 此備註已存在'); return; }
  storeConfig.quickNotes.push(name);
  document.getElementById('newNoteBtn').value = '';
  renderNoteBtnList();
}

function removeNoteBtn(name) {
  storeConfig.quickNotes = storeConfig.quickNotes.filter(n => n !== name);
  renderNoteBtnList();
}

async function saveStoreConfig() {
  const store = document.getElementById('storeConfigStore').value;
  const qFull = parseInt(document.getElementById('quotaFullTime').value) || 0;
  const qPart = parseInt(document.getElementById('quotaPartTime').value) || 0;
  const qPartUnlimited = document.getElementById('quotaPartUnlimited').checked;
  const qWeekly = parseInt(document.getElementById('quotaWeeklyFull').value) || 0;
  const qHardBlock = document.getElementById('quotaHardBlock').checked;
  storeConfig.leaveQuota = { fullTime: qFull, partTime: qPart, partTimeUnlimited: qPartUnlimited, weeklyFull: qWeekly, hardBlock: qHardBlock };
  showLoading('儲存門市設定中...');
  try {
    await window.db.collection('stores').doc(store).collection('config').doc('shifts').set(storeConfig);
    closeModal('storeConfigModal');
    showToast('✅ 門市設定已儲存');
  } catch(e) {
    showToast('❌ 儲存失敗：' + e.message);
  }
  hideLoading();
}

// ===== 更新日誌 =====
const README_URL = 'https://raw.githubusercontent.com/glade9001/store-schedule/main/README.md';

async function openChangelogModal() {
  openModal('changelogModal');
  const content = document.getElementById('changelogContent');
  const sub = document.getElementById('changelogSub');

  content.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">載入中...</div>';
  try {
    const res = await fetch(`${README_URL}?t=${Date.now()}`, { cache: 'no-cache' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();

    const match = md.match(/## 更新紀錄\n([\s\S]*)/);
    if(!match) { content.innerHTML = '<div style="color:var(--text-muted);">尚無更新紀錄。</div>'; return; }

    content.innerHTML = parseChangelog(match[1]);
    const firstDate = match[1].match(/### (\d{4}-\d{2}-\d{2})/);
    sub.textContent = firstDate ? `最近更新：${firstDate[1]}` : '';
  } catch(e) {
    content.innerHTML = `<div style="color:var(--danger);">❌ 載入失敗：${e.message}</div>`;
  }
}

function parseChangelog(md) {
  const lines = md.split('\n');
  let html = '';
  for(const raw of lines) {
    const line = raw.trimEnd();
    if(!line) { html += '<div style="height:6px;"></div>'; continue; }

    // ### 日期標題
    if(/^### \d{4}-\d{2}-\d{2}/.test(line)) {
      const date = line.replace('### ', '');
      html += `<div style="font-size:15px; font-weight:900; color:var(--primary); margin:14px 0 6px; padding-bottom:4px; border-bottom:2px solid var(--border);">${date}</div>`;
      continue;
    }
    // #### 分類標題
    if(/^#### /.test(line)) {
      html += `<div style="font-size:13px; font-weight:800; color:var(--text); margin:10px 0 4px;">${line.replace('#### ', '')}</div>`;
      continue;
    }
    // --- 分隔線
    if(/^---/.test(line)) {
      html += '<hr style="border:none; border-top:1px solid var(--border); margin:12px 0;">';
      continue;
    }
    // - **粗體** 主要項目
    if(/^- \*\*/.test(line)) {
      const text = line.replace(/^- \*\*(.+?)\*\*(.*)/, (_, bold, rest) =>
        `<span style="font-weight:800;">${bold}</span>${rest || ''}`);
      html += `<div style="margin:4px 0 2px; display:flex; gap:6px;"><span style="color:var(--primary); flex-shrink:0;">•</span><div>${text}</div></div>`;
      continue;
    }
    // - 一般項目
    if(/^- /.test(line)) {
      const text = line.replace(/^- /, '').replace(/`([^`]+)`/g, '<code style="background:#f0f4ff; padding:1px 5px; border-radius:4px; font-size:12px;">$1</code>');
      html += `<div style="margin:2px 0 2px 12px; display:flex; gap:6px; color:var(--text-muted);"><span style="flex-shrink:0;">–</span><div>${text}</div></div>`;
      continue;
    }
    //   - 縮排項目
    if(/^  - /.test(line)) {
      const text = line.replace(/^  - /, '').replace(/`([^`]+)`/g, '<code style="background:#f0f4ff; padding:1px 5px; border-radius:4px; font-size:12px;">$1</code>');
      html += `<div style="margin:2px 0 2px 20px; display:flex; gap:6px; color:var(--text-muted); font-size:12px;"><span style="flex-shrink:0;">·</span><div>${text}</div></div>`;
      continue;
    }
  }
  return html;
}

// ===== 勞健保級距設定 =====
let insuranceData = null;

async function openInsuranceModal() {
  openModal('insuranceModal');
  if(insuranceData) { renderInsuranceTable(); return; }
  showLoading('載入級距資料...');
  try {
    const snap = await window.db.collection('settings').doc('insuranceGrades').get();
    if(!snap.exists) { showToast('❌ 尚無級距資料'); hideLoading(); closeModal('insuranceModal'); return; }
    insuranceData = snap.data();
    renderInsuranceTable();
  } catch(e) { showToast('❌ 載入失敗：' + e.message); }
  hideLoading();
}

function renderInsuranceTable() {
  const d = insuranceData;
  document.getElementById('insuranceYear').textContent = d.year || '—';
  document.getElementById('insuranceModalSub').textContent =
    `${d.year || ''}年度（${d.effectiveDate || ''}起）　勞保${(d.laborRate||0)/10}%　健保${(d.healthRate||0)/100}%　勞退${(d.pensionRate||0)/10}%`;
  document.getElementById('inLaborRate').value  = d.laborRate  || 125;
  document.getElementById('inHealthRate').value = d.healthRate || 517;
  document.getElementById('inPensionRate').value= d.pensionRate|| 60;

  document.getElementById('insuranceMenuTitle').textContent =
    `${d.year || ''}年度投保級距金額表`;

  const grades = d.grades || [];
  const LABOR_MAX   = d.laborMaxSalary   || 45800;
  const PENSION_MAX = d.pensionMaxSalary || 150000;

  const tbody = document.getElementById('insuranceTableBody');
  tbody.innerHTML = grades.map((g, i) => {
    const isMin = g.insuredSalary === 29500;
    const isLaborMax = g.insuredSalary === LABOR_MAX;
    const isPensionMax = g.insuredSalary === PENSION_MAX;
    const bg = isMin ? '#fff9e6' : (i % 2 === 0 ? 'white' : '#f8fafc');
    const badge = isMin ? ' 🔴' : (isLaborMax ? ' 🔵' : (isPensionMax ? ' 🟢' : ''));
    return `<tr style="background:${bg};" onclick="editInsuranceRow(${i})" title="點擊編輯">
      <td style="padding:5px 6px; text-align:right; font-weight:700; white-space:nowrap;">${g.insuredSalary.toLocaleString()}${badge}</td>
      <td style="padding:5px 4px; text-align:right; color:#0d47a1;">${(g.laborEmp||0).toLocaleString()}</td>
      <td style="padding:5px 4px; text-align:right; color:#0d47a1;">${(g.laborEr||0).toLocaleString()}</td>
      <td style="padding:5px 4px; text-align:right; color:#0d47a1;">${(g.laborGov||0).toLocaleString()}</td>
      <td style="padding:5px 4px; text-align:right; color:#2e7d32;">${(g.healthEmp||0).toLocaleString()}</td>
      <td style="padding:5px 4px; text-align:right; color:#2e7d32;">${(g.healthEr||0).toLocaleString()}</td>
      <td style="padding:5px 4px; text-align:right; color:#2e7d32;">${(g.healthGov||0).toLocaleString()}</td>
      <td style="padding:5px 4px; text-align:right; color:#e65100;">${(g.pension||0).toLocaleString()}</td>
    </tr>`;
  }).join('');
}

function editInsuranceRow(idx) {
  const g = insuranceData.grades[idx];
  const fields = [
    ['勞保 勞工', 'laborEmp'], ['勞保 雇主', 'laborEr'], ['勞保 政府', 'laborGov'],
    ['健保 勞工', 'healthEmp'], ['健保 雇主', 'healthEr'], ['健保 政府', 'healthGov'],
    ['勞退 雇主', 'pension']
  ];
  let html = `<div style="font-weight:800; margin-bottom:10px;">編輯 $${g.insuredSalary.toLocaleString()} 級距</div>`;
  html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">';
  fields.forEach(([label, key]) => {
    html += `<div><div style="font-size:11px; color:var(--text-muted); margin-bottom:3px;">${label}</div>
      <input type="number" id="editIns_${key}" value="${g[key]||0}" style="width:100%; padding:7px; border:1.5px solid var(--border); border-radius:8px; font-size:13px; text-align:right;"></div>`;
  });
  html += '</div>';
  html += `<div style="display:flex; gap:8px; margin-top:12px;">
    <button onclick="applyInsuranceRowEdit(${idx})" style="flex:1; padding:9px; background:var(--primary); color:white; border:none; border-radius:8px; font-weight:700; cursor:pointer;">確認</button>
    <button onclick="closeModal('insuranceEditModal')" style="flex:1; padding:9px; background:none; border:1.5px solid var(--border); border-radius:8px; font-weight:700; cursor:pointer;">取消</button>
  </div>`;

  let modal = document.getElementById('insuranceEditModal');
  if(!modal) {
    modal = document.createElement('div');
    modal.id = 'insuranceEditModal';
    modal.className = 'modal-overlay';
    modal.onclick = e => { if(e.target === modal) modal.classList.remove('active'); };
    modal.innerHTML = `<div class="modal-box"><div class="modal-handle"></div><div id="insuranceEditContent"></div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('insuranceEditContent').innerHTML = html;
  modal.classList.add('active');
}

function applyInsuranceRowEdit(idx) {
  const fields = ['laborEmp','laborEr','laborGov','healthEmp','healthEr','healthGov','pension'];
  fields.forEach(k => {
    const el = document.getElementById(`editIns_${k}`);
    if(el) insuranceData.grades[idx][k] = parseInt(el.value) || 0;
  });
  renderInsuranceTable();
  document.getElementById('insuranceEditModal').classList.remove('active');
}

function recalcInsuranceGrades() {
  if(!insuranceData) return;
  const lr  = (parseInt(document.getElementById('inLaborRate').value)  || 125) / 1000;
  const hr  = (parseInt(document.getElementById('inHealthRate').value) || 517) / 10000;
  const pr  = (parseInt(document.getElementById('inPensionRate').value)|| 60)  / 1000;
  const LABOR_MAX   = insuranceData.laborMaxSalary   || 45800;
  const PENSION_MAX = insuranceData.pensionMaxSalary || 150000;
  const r = Math.round;

  insuranceData.grades = insuranceData.grades.map(g => {
    const s  = g.insuredSalary;
    const ls = Math.min(s, LABOR_MAX);
    const ps = Math.min(s, PENSION_MAX);
    const lt = r(ls * lr);
    const le = r(ls * lr * 0.20);
    const lg = r(ls * lr * 0.10);
    return {
      insuredSalary: s,
      laborEmp: le, laborEr: lt - le - lg, laborGov: lg, laborTotal: lt,
      healthEmp: r(s * hr * 0.30), healthEr: r(s * hr * 0.60), healthGov: r(s * hr * 0.10),
      healthTotal: r(s * hr * 0.30) + r(s * hr * 0.60) + r(s * hr * 0.10),
      pension: r(ps * pr)
    };
  });
  insuranceData.laborRate  = parseInt(document.getElementById('inLaborRate').value)  || 125;
  insuranceData.healthRate = parseInt(document.getElementById('inHealthRate').value) || 517;
  insuranceData.pensionRate= parseInt(document.getElementById('inPensionRate').value)|| 60;
  renderInsuranceTable();
  showToast('✅ 已重新計算，請確認後儲存');
}

async function saveInsuranceGrades() {
  if(!insuranceData) return;
  insuranceData.laborRate  = parseInt(document.getElementById('inLaborRate').value)  || 125;
  insuranceData.healthRate = parseInt(document.getElementById('inHealthRate').value) || 517;
  insuranceData.pensionRate= parseInt(document.getElementById('inPensionRate').value)|| 60;
  showLoading('儲存中...');
  try {
    await window.db.collection('settings').doc('insuranceGrades').set(insuranceData);
    showToast('✅ 級距設定已儲存');
    closeModal('insuranceModal');
  } catch(e) { showToast('❌ 儲存失敗：' + e.message); }
  hideLoading();
}
