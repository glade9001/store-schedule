// 自動排班設定（第 1 步）：時段人數需求、人員兩季可上班別、寒暑假日期。
// 資料模型與推算邏輯在 auto-schedule-core.js；這支只管畫面與讀寫。
// 設定文件：stores/{store}/config/autoSchedule（catch-all 規則：登入者可讀寫，與 config/shifts 相同）

let aspSeason = null; // ③ 目前在設定哪一季：'term' 學期中／'vacation' 寒暑假（一次只顯示一季，兩季並排太難設定）
let aspDayEdit = null; // 正在編輯逐日例外的格子 {idx, season, day}
let aspOpenDays = new Set(); // 需求區展開中的星期（手機上七天全展開太長）
let aspUser = null, aspStore = '', aspCfg = null, aspEmps = [], aspStats = {}, aspWeeks = {}, aspDirty = false;
const aspIsOwner = () => ['owner', 'admin'].includes(aspUser?.permission);
// 2026-09-22 起設定頁開放給所有店長（只能設定自己的店；owner/admin 可切三店）。
// 「🤖 產生草稿」仍只限美德（auto-schedule-draft.js asdAllowedUser）
const aspIsLead = () => ['manager', 'owner', 'admin'].includes(aspUser?.permission);
const aspCanUse = () => aspIsLead();
const aspHistoryWeeks = 26; // 歷史推算看最近半年（涵蓋學期中＋暑假）

function aspLoading(t) { document.getElementById('loadingText').textContent = t || '載入中…'; document.getElementById('loadingOverlay').classList.remove('hidden'); }
function aspLoaded() { document.getElementById('loadingOverlay').classList.add('hidden'); }
let _aspTt;
function aspToast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(_aspTt); _aspTt = setTimeout(() => t.classList.remove('show'), 2400); }
function aspEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function aspTodayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function aspSetDirty(v) {
  aspDirty = v;
  document.getElementById('dirtyHint').textContent = v ? '● 有尚未儲存的修改' : '';
}
window.addEventListener('beforeunload', e => { if (aspDirty) { e.preventDefault(); e.returnValue = ''; } });

function aspGoBack() {
  if (aspDirty && !confirm('設定還沒儲存，確定離開？')) return;
  const ref = new URLSearchParams(location.search).get('ref');
  location.href = ref || 'schedule-V2.html?mode=admin';
}

window.onload = async () => {
  aspLoading('驗證登入…');
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  try { aspUser = JSON.parse(saved); } catch (e) { location.replace('home.html'); return; }
  const fb = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(x => { u(); r(x); }); });
  if (!fb) { localStorage.removeItem('currentUser'); location.replace('home.html'); return; }
  if (!aspIsLead()) { aspToast('僅店長以上可用'); setTimeout(() => location.replace('home.html'), 1200); return; }

  let stores = [];
  try {
    const s = await window.db.collection('settings').doc('globalConfig').get();
    if (s.exists) stores = (s.data().stores || []).filter(x => x !== '人力支援');
  } catch (e) {}
  if (aspIsOwner() && stores.length) {
    const sel = document.getElementById('storeSel');
    sel.style.display = 'block';
    sel.innerHTML = stores.map(s => `<option value="${aspEsc(s)}">${aspEsc(s)}</option>`).join('');
    const want = new URLSearchParams(location.search).get('store'); // 從排班頁「產生草稿」帶過來的門市
    aspStore = stores.includes(want) ? want : (stores.includes('美德') ? '美德' : stores[0]);
    sel.value = aspStore;
  } else {
    aspStore = aspUser.store || '';
  }
  await aspLoadStore();
  aspLoaded();
};

async function aspOnStoreChange() {
  const sel = document.getElementById('storeSel');
  if (aspDirty && !confirm('目前門市的設定還沒儲存，確定切換？')) { sel.value = aspStore; return; }
  aspStore = sel.value;
  aspLoading('載入…'); await aspLoadStore(); aspLoaded();
}

async function aspLoadStore() {
  aspSetDirty(false); aspDayEdit = null;
  const storeRef = window.db.collection('stores').doc(aspStore);
  const thisWeek = shiftWeekStr(aspTodayStr());
  const fromWeek = shiftWeekStr(shiftDateAdd(aspTodayStr(), -7 * aspHistoryWeeks));
  let cfgSnap, empSnap, shiftSnap, weekSnap;
  try {
    [cfgSnap, empSnap, shiftSnap, weekSnap] = await Promise.all([
      storeRef.collection('config').doc('autoSchedule').get(),
      storeRef.collection('employees').get(),
      storeRef.collection('config').doc('shifts').get().catch(() => null),
      storeRef.collection('weeks').where(firebase.firestore.FieldPath.documentId(), '>=', fromWeek).get()
    ]);
  } catch (e) {
    aspBanner('warn', '讀取失敗：' + e.message);
    return;
  }

  aspEmps = [];
  empSnap.forEach(d => {
    const e = d.data();
    if (d.id.startsWith('🆘') || ['離職', '調走'].includes(e.status)) return;
    aspEmps.push({ name: d.id, ...e });
  });
  aspEmps.sort((a, b) => (a.sortKey ?? 999) - (b.sortKey ?? 999));

  // 只拿「已過完的週」推算：本週和未來週可能只排了一半，會把需求拉低
  aspWeeks = {};
  weekSnap.forEach(d => { if (d.id < thisWeek) aspWeeks[d.id] = (d.data().records || []); });

  // 班別候選：門市班別設定＋歷史上出現過的
  const opts = new Set();
  ((shiftSnap && shiftSnap.exists && shiftSnap.data().shifts) || []).forEach(s => { const n = asNormShift(s); if (n) opts.add(n); });
  Object.values(aspWeeks).forEach(recs => recs.forEach(r => { const n = asNormShift(r.shift); if (n) opts.add(n); }));
  document.getElementById('shiftList').innerHTML = [...opts].sort(aspShiftSort).map(s => `<option value="${aspEsc(s)}">`).join('');

  const hasCfg = cfgSnap.exists;
  const base = asDefaultConfig();
  aspCfg = hasCfg ? { ...base, ...cfgSnap.data() } : base;
  const inf = asInferFromHistory(aspWeeks, aspEmps, aspCfg.seasons, {});
  aspStats = inf.stats;

  if (!hasCfg) {
    const cx = asBlankIfComplex(inf);
    aspCfg.demand = inf.demand;
    aspCfg.staff = inf.staff;
    const blanks = [];
    if (cx.demandBlank) blanks.push('人數需求');
    if (cx.blankStaff.length) blanks.push(cx.blankStaff.join('、') + ' 的可上班別');
    aspBanner('info', `這家店還沒有設定，已依最近 ${Object.keys(aspWeeks).length} 週的班表自動帶入。` +
      (blanks.length ? `其中${blanks.join('，以及')}歷史排法太零碎，先留空請店長自己填。` : '') + '請逐項確認、修改後按「儲存設定」。');
    aspSetDirty(true);
  } else {
    // 新進員工還沒設定 → 用歷史推算補上；已不在職的人留在文件裡也不顯示（儲存時清掉）
    const added = [];
    aspEmps.forEach(e => { if (!aspCfg.staff[e.name]) { aspCfg.staff[e.name] = inf.staff[e.name]; added.push(e.name); } });
    if (added.length) { aspBanner('warn', `新增人員（已從歷史帶入，請確認）：${added.join('、')}`); aspSetDirty(true); }
    else aspBanner('', '');
  }
  document.getElementById('metaInfo').textContent = aspCfg.updatedAt ? aspSavedLabel(aspCfg) : '尚未儲存過';
  aspRenderAll();
}

// updatedAt 存 UTC ISO；直接截字串會少 8 小時
function aspSavedLabel(c) {
  const t = new Date(c.updatedAt);
  const p = n => String(n).padStart(2, '0');
  return `上次儲存：${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}（${c.updatedBy || ''}）`;
}

function aspShiftSort(a, b) {
  const sa = shiftSpan(a), sb = shiftSpan(b);
  const ka = sa ? (sa.startH < 7 ? sa.startH + 24 : sa.startH) : 99, kb = sb ? (sb.startH < 7 ? sb.startH + 24 : sb.startH) : 99;
  return ka - kb || a.localeCompare(b);
}

function aspBanner(type, msg) {
  const el = document.getElementById('statusBanner');
  if (!msg) { el.style.display = 'none'; return; }
  el.className = 'banner ' + type; el.textContent = msg; el.style.display = 'block';
}

function aspReinfer() {
  if (!confirm('用歷史班表重新帶入「人數需求」與「可上班別」？\n目前畫面上的修改會被覆蓋（寒暑假日期、各人的「自動排班」開關保留）。')) return;
  const inf = asInferFromHistory(aspWeeks, aspEmps, aspCfg.seasons, {});
  // 「自動排班」開關是店長的決定，不是歷史推得出來的 → 重新帶入時保留（美德楷岳才不會被改回自動）
  Object.keys(inf.staff).forEach(n => { if (aspCfg.staff[n] && aspCfg.staff[n].auto === false) inf.staff[n].auto = false; });
  aspCfg.demand = inf.demand; aspCfg.staff = inf.staff; aspStats = inf.stats; aspDayEdit = null;
  aspSetDirty(true); aspRenderAll();
  aspToast('已重新帶入，確認後記得儲存');
}

function aspRenderAll() {
  if (!aspSeason) aspSeason = asSeasonOf(aspTodayStr(), aspCfg.seasons); // 預設開今天所屬的季節（寒暑假關閉時一律學期中）
  const on = asSeasonsEnabled();
  document.getElementById('seasonSection').style.display = on ? '' : 'none';
  document.getElementById('seasonSwitch').style.display = on ? '' : 'none';
  aspRenderSeasons(); aspRenderDemand(); aspRenderSeasonSwitch(); aspRenderStaff();
}

// ───────── ① 寒暑假 ─────────
function aspMdPicker(key, field) {
  const v = (aspCfg.seasons[key] || {})[field] || '01-01';
  const [mm, dd] = v.split('-');
  const mSel = Array.from({ length: 12 }, (_, i) => { const x = String(i + 1).padStart(2, '0'); return `<option value="${x}" ${x === mm ? 'selected' : ''}>${i + 1} 月</option>`; }).join('');
  const dSel = Array.from({ length: 31 }, (_, i) => { const x = String(i + 1).padStart(2, '0'); return `<option value="${x}" ${x === dd ? 'selected' : ''}>${i + 1} 日</option>`; }).join('');
  return `<select class="sm" onchange="aspSetSeason('${key}','${field}',this.value,null)">${mSel}</select>`
       + `<select class="sm" onchange="aspSetSeason('${key}','${field}',null,this.value)">${dSel}</select>`;
}
function aspRenderSeasons() {
  const row = (key, label) => `<div class="season-row"><span class="season-name">${label}</span>${aspMdPicker(key, 'from')}<span class="tilde">～</span>${aspMdPicker(key, 'to')}</div>`;
  document.getElementById('seasonCard').innerHTML = row('summer', '暑假') + row('winter', '寒假')
    + `<div class="meta" style="margin-top:6px;">寒假日期每年不同，請依當年校曆調整。今天（${aspTodayStr()}）屬於：<b>${asSeasonOf(aspTodayStr(), aspCfg.seasons) === 'vacation' ? '寒暑假' : '學期中'}</b></div>`;
}
function aspSetSeason(key, field, mm, dd) {
  const cur = ((aspCfg.seasons[key] || {})[field] || '01-01').split('-');
  aspCfg.seasons[key] = { ...(aspCfg.seasons[key] || {}), [field]: (mm || cur[0]) + '-' + (dd || cur[1]) };
  aspSetDirty(true); aspRenderSeasons(); aspRenderSeasonSwitch();
}

// ───────── ② 人數需求 ─────────
function aspHourOptions(sel, min, max) {
  let h = '';
  for (let x = min; x <= max; x += 0.5) h += `<option value="${x}" ${x === sel ? 'selected' : ''}>${asHourLabel(x)}</option>`;
  return h;
}
function aspCovBar(bands) {
  const arr = asDemandToSlots(bands);
  const cells = arr.map((n, i) => `<div class="cov-cell cov-${Math.min(n, 4)}" title="${asHourLabel(7 + i / 2)} ${n} 人"></div>`).join('');
  return `<div class="cov">${cells}</div><div class="cov-axis"><span>07</span><span>11</span><span>15</span><span>19</span><span>23</span><span>03</span><span>07</span></div>`;
}
function aspBandWarn(bands) {
  const sorted = [...bands].sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].s < sorted[i - 1].e) return '⚠️ 時段重疊：重疊的部分以人數較多的為準';
  return '';
}
function aspRenderDemand() {
  const days = asDayNames();
  document.getElementById('demandWrap').innerHTML = days.map(d => {
    const bands = aspCfg.demand[d] || [];
    const rows = bands.map((b, i) => `
      <div class="band">
        <select class="sm" onchange="aspEditBand('${d}',${i},'s',this.value)">${aspHourOptions(b.s, 7, 30.5)}</select>
        <span class="tilde">～</span>
        <select class="sm" onchange="aspEditBand('${d}',${i},'e',this.value)">${aspHourOptions(b.e, 7.5, 31)}</select>
        <span class="stepper"><button onclick="aspStepBand('${d}',${i},-1)">−</button><span>${b.n} 人</span><button onclick="aspStepBand('${d}',${i},1)">＋</button></span>
        <button class="btn-x" onclick="aspDelBand('${d}',${i})" aria-label="刪除這個時段">✕</button>
      </div>
      <div class="band-min">最少 <span class="stepper sm"><button onclick="aspStepMin('${d}',${i},-1)">−</button><span>${aspMinOf(b)} 人</span><button onclick="aspStepMin('${d}',${i},1)">＋</button></span>
        <span class="meta">${aspMinOf(b) < b.n ? `少於 ${b.n} 人可以，排不到只提醒、不開待補` : '一定要排滿，排不到開 🆘 待補'}</span></div>`).join('');
    const warn = aspBandWarn(bands);
    const open = aspOpenDays.has(d);
    const summary = bands.map(b => `${asHourLabel(b.s).replace('隔天 ', '')}–${asHourLabel(b.e).replace('隔天 ', '')} ${b.n}人${aspMinOf(b) < b.n ? `(最少${aspMinOf(b)})` : ''}`).join('・') || '還沒有時段';
    return `<div class="card">
      <div class="day-head" onclick="aspToggleDay('${d}')" style="cursor:pointer;"><span class="day-name">${d}</span><span class="btn-mini">${open ? '收合 ▲' : '編輯 ▼'}</span></div>
      ${aspCovBar(bands)}
      ${open ? '' : `<div class="day-sum">${summary}</div>${warn ? `<div class="band-warn">${warn}</div>` : ''}</div>`}
      ${open ? `${rows || '<div class="meta">（還沒有時段）</div>'}
      ${warn ? `<div class="band-warn">${warn}</div>` : ''}
      <div class="day-actions">
        <button class="btn-mini" onclick="aspAddBand('${d}')">＋ 新增時段</button>
        <button class="btn-mini" onclick="aspCopyDay('${d}','weekday')">複製到週一～週五</button>
        <button class="btn-mini" onclick="aspCopyDay('${d}','all')">複製到每天</button>
      </div>
    </div>` : ''}`;
  }).join('');
}
function aspToggleDay(d) { if (aspOpenDays.has(d)) aspOpenDays.delete(d); else aspOpenDays.add(d); aspRenderDemand(); }
function aspEditBand(d, i, f, v) {
  const b = aspCfg.demand[d][i];
  b[f] = parseFloat(v);
  if (b.e <= b.s) { if (f === 's') b.e = Math.min(31, b.s + 0.5); else b.s = Math.max(7, b.e - 0.5); }
  aspCfg.demand[d].sort((a, c) => a.s - c.s);
  aspSetDirty(true); aspRenderDemand();
}
function aspStepBand(d, i, delta) {
  const b = aspCfg.demand[d][i];
  b.n = Math.max(1, Math.min(9, b.n + delta));
  aspSetDirty(true); aspRenderDemand();
}
// 最少人數：沒存＝跟目標一樣（一定要排滿）
function aspMinOf(b) { return b.min == null ? b.n : Math.min(b.min, b.n); }
function aspStepMin(d, i, delta) {
  const b = aspCfg.demand[d][i];
  b.min = Math.max(0, Math.min(b.n, aspMinOf(b) + delta));
  aspSetDirty(true); aspRenderDemand();
}
function aspDelBand(d, i) { aspCfg.demand[d].splice(i, 1); aspSetDirty(true); aspRenderDemand(); }
function aspAddBand(d) {
  const bands = aspCfg.demand[d] = aspCfg.demand[d] || [];
  const last = bands[bands.length - 1];
  const s = last ? Math.min(30.5, last.e) : 7;
  bands.push({ s, e: Math.min(31, s + 8), n: 1 });
  aspSetDirty(true); aspRenderDemand();
}
function aspCopyDay(src, scope) {
  const days = asDayNames();
  const targets = scope === 'weekday' ? days.slice(0, 5) : days;
  const label = scope === 'weekday' ? '週一～週五' : '每天';
  if (!confirm(`把「${src}」的時段需求複製到${label}？（會覆蓋那些天目前的設定）`)) return;
  targets.forEach(d => { if (d !== src) aspCfg.demand[d] = aspCfg.demand[src].map(b => ({ ...b })); });
  aspSetDirty(true); aspRenderDemand();
}

// ───────── ③ 人員 ─────────
function aspTopCounts(cnt, k) {
  return Object.entries(cnt || {}).sort((a, b) => b[1] - a[1]).slice(0, k).map(([s, n]) => `${s}×${n}`).join('、') || '無紀錄';
}
function aspRenderSeasonSwitch() {
  const cur = asSeasonOf(aspTodayStr(), aspCfg.seasons);
  const btn = (k, label) => `<button class="${aspSeason === k ? 'sel' : ''}" onclick="aspSetSeasonView('${k}')">${label}${cur === k ? '<small>現在</small>' : ''}</button>`;
  document.getElementById('seasonSwitch').innerHTML = btn('term', '📚 學期中') + btn('vacation', '🏖️ 寒暑假');
}
function aspSetSeasonView(k) {
  if (aspSeason === k) return;
  aspSeason = k; aspDayEdit = null;
  aspRenderSeasonSwitch(); aspRenderStaff();
}

function aspRenderStaff() {
  const wrap = document.getElementById('staffWrap');
  if (!aspEmps.length) { wrap.innerHTML = '<div class="card meta">這家店沒有在職人員</div>'; return; }
  wrap.innerHTML = aspEmps.map((e, idx) => {
    const st = aspCfg.staff[e.name] || { auto: true, term: [], vacation: [] };
    const ref = aspStats[e.name] || {};
    const ft = e.role && e.role !== '工讀';
    const roleTxt = (e.role || '工讀') + (e.payAsPartTime ? '・時薪計' : '');
    const block = (season, label) => {
      const list = st[season] || [];
      const chips = list.map((s, i) => `<span class="chip ${i === 0 ? 'main' : ''}">
          <span class="chip-txt" onclick="aspMakeMain(${idx},'${season}',${i})" title="設為主力">${i === 0 ? '★ ' : ''}${aspEsc(s)}</span>
          <button class="chip-x" onclick="aspDelShift(${idx},'${season}',${i})" aria-label="移除">×</button></span>`).join('');
      return `<div class="season-block"><div class="season-label">${label}</div><div class="chips">
          ${chips || (st.auto ? '<span class="empty-chips">還沒有可上班別，自動排班不會排這個人</span>' : '')}
          <span class="chip-add"><input list="shiftList" placeholder="＋ 班別" id="add-${idx}-${season}" onkeydown="if(event.key==='Enter')aspAddShift(${idx},'${season}')">
          <button class="btn-mini" onclick="aspAddShift(${idx},'${season}')">加入</button></span>
        </div>${aspDayRow(idx, st, season)}</div>`;
    };
    return `<div class="card ${st.auto ? '' : 'emp-off'}">
      <div class="emp-head">
        <span class="emp-name">${aspEsc(e.name)}</span><span class="role-tag ${ft ? 'ft' : ''}">${aspEsc(roleTxt)}</span>
        <label class="toggle"><input type="checkbox" ${st.auto ? 'checked' : ''} onchange="aspToggleAuto(${idx},this.checked)">自動排班</label>
      </div>
      ${st.auto ? `<div class="cap-row">每週最多
        <input type="number" inputmode="numeric" min="1" max="7" value="${st.maxDays ?? ''}" placeholder="不限" onchange="aspSetCap(${idx},'maxDays',this.value)"> 天
        <input type="number" inputmode="decimal" min="1" max="${ft ? 40 : 80}" step="0.5" value="${st.maxHours ?? ''}" placeholder="${ft ? '40' : '不限'}" onchange="aspSetCap(${idx},'maxHours',this.value)"> 小時
        ${ft ? '<span class="meta">（正職最多 40）</span>' : ''}</div>` : ''}
      <div class="emp-ref">歷史參考：近 12 週週均 ${ref.weeklyHours ?? 0} 小時｜${asSeasonsEnabled() ? (aspSeason === 'term' ? '學期中' : '寒暑假') : ''}常上 ${aspEsc(aspTopCounts(aspSeason === 'term' ? ref.termCount : ref.vacCount, 3))}</div>
      ${st.auto ? block(aspSeason, asSeasonsEnabled() ? (aspSeason === 'term' ? '📚 學期中' : '🏖️ 寒暑假') : '可上班別') : '<div class="meta">不自動排，由店長手動排這個人。</div>'}
    </div>`;
  }).join('');
}
// ── 逐日例外：某季某個星期幾「不能上」或「只能上指定班別」──
function aspDayRow(idx, st, season) {
  const ex = st[season + 'Days'] || {};
  const pills = asDayNames().map(d => {
    const v = ex[d];
    const cls = v === 'off' ? 'off' : (Array.isArray(v) ? 'only' : '');
    const sub = v === 'off' ? '不能上' : (Array.isArray(v) ? v.join(' ') : '');
    const on = aspDayEdit && aspDayEdit.idx === idx && aspDayEdit.season === season && aspDayEdit.day === d;
    return `<button class="day-pill ${cls} ${on ? 'on' : ''}" onclick="aspPickDay(${idx},'${season}','${d}')">${d.slice(1)}${sub ? `<small>${aspEsc(sub)}</small>` : ''}</button>`;
  }).join('');
  let editor = '';
  if (aspDayEdit && aspDayEdit.idx === idx && aspDayEdit.season === season) {
    const d = aspDayEdit.day, v = ex[d];
    const mode = v === 'off' ? 'off' : (Array.isArray(v) ? 'only' : 'default');
    const onlyChips = Array.isArray(v) ? v.map((sh, i) => `<span class="chip"><span class="chip-txt">${aspEsc(sh)}</span><button class="chip-x" onclick="aspDelDayShift(${i})" aria-label="移除">×</button></span>`).join('') : '';
    editor = `<div class="day-editor">
      <div class="day-editor-title">${d}（${season === 'term' ? '學期中' : '寒暑假'}）</div>
      <div class="seg">
        <button class="${mode === 'default' ? 'sel' : ''}" onclick="aspSetDayMode('default')">照上面班別</button>
        <button class="${mode === 'off' ? 'sel' : ''}" onclick="aspSetDayMode('off')">不能上</button>
        <button class="${mode === 'only' ? 'sel' : ''}" onclick="aspSetDayMode('only')">只上指定班別</button>
      </div>
      ${mode === 'only' ? `<div class="chips" style="margin-top:6px;">${onlyChips}
        <span class="chip-add"><input list="shiftList" placeholder="＋ 班別" id="dayadd" onkeydown="if(event.key==='Enter')aspAddDayShift()">
        <button class="btn-mini" onclick="aspAddDayShift()">加入</button></span></div>` : ''}
      <div style="text-align:right;margin-top:6px;"><button class="btn-mini" onclick="aspPickDay(${idx},'${season}','${d}')">完成</button></div>
    </div>`;
  }
  return `<div class="day-row-label">每週可上日 <span class="meta">（點星期幾設定例外）</span></div><div class="day-pills">${pills}</div>${editor}`;
}
function aspPickDay(idx, season, day) {
  const same = aspDayEdit && aspDayEdit.idx === idx && aspDayEdit.season === season && aspDayEdit.day === day;
  aspDayEdit = same ? null : { idx, season, day };
  aspRenderStaff();
}
function aspDayMap() {
  const st = aspStaffOf(aspDayEdit.idx), k = aspDayEdit.season + 'Days';
  return st[k] = st[k] || {};
}
function aspSetDayMode(mode) {
  const m = aspDayMap(), d = aspDayEdit.day;
  if (mode === 'default') delete m[d];
  else if (mode === 'off') m[d] = 'off';
  else if (!Array.isArray(m[d])) m[d] = []; // 先開空清單，加了班別才生效（空的＝照上面班別）
  aspSetDirty(true); aspRenderStaff();
}
function aspAddDayShift() {
  const n = asNormShift(document.getElementById('dayadd').value);
  if (!n) { aspToast('班別格式不對，例：15-23、18-23'); return; }
  const m = aspDayMap(), d = aspDayEdit.day;
  if (!Array.isArray(m[d])) m[d] = [];
  if (!m[d].includes(n)) m[d].push(n);
  aspSetDirty(true); aspRenderStaff();
}
function aspDelDayShift(i) { aspDayMap()[aspDayEdit.day].splice(i, 1); aspSetDirty(true); aspRenderStaff(); }

function aspStaffOf(idx) {
  const name = aspEmps[idx].name;
  return aspCfg.staff[name] = aspCfg.staff[name] || { auto: true, term: [], vacation: [], note: '' };
}
// 每週上限：空白＝不限（正職仍受 40 小時）；超過只能由店長在排班頁手動排
function aspSetCap(idx, key, v) {
  const st = aspStaffOf(idx), n = parseFloat(v);
  if (v === '' || !(n > 0)) delete st[key];
  else st[key] = key === 'maxDays' ? Math.min(7, Math.round(n)) : Math.round(n * 2) / 2;
  aspSetDirty(true);
}
function aspToggleAuto(idx, v) { aspStaffOf(idx).auto = v; aspSetDirty(true); aspRenderStaff(); }
function aspMakeMain(idx, season, i) {
  const list = aspStaffOf(idx)[season];
  if (i === 0) return;
  list.unshift(list.splice(i, 1)[0]);
  aspSetDirty(true); aspRenderStaff();
}
function aspDelShift(idx, season, i) { aspStaffOf(idx)[season].splice(i, 1); aspSetDirty(true); aspRenderStaff(); }
function aspAddShift(idx, season) {
  const inp = document.getElementById(`add-${idx}-${season}`);
  const n = asNormShift(inp.value);
  if (!n) { aspToast('班別格式不對，例：7-15、18-23、23.5-7.5'); return; }
  const st = aspStaffOf(idx);
  st[season] = st[season] || [];
  if (st[season].includes(n)) { aspToast('已經有這個班別'); return; }
  st[season].push(n);
  aspSetDirty(true); aspRenderStaff();
}

// ───────── 儲存 ─────────
async function aspSave() {
  const btn = document.getElementById('saveBtn');
  // 只存在職的人：離職／調走的留著只會讓之後的自動排班誤排
  const staff = {};
  aspEmps.forEach(e => {
    const st = aspCfg.staff[e.name];
    if (!st) return;
    ['termDays', 'vacationDays'].forEach(k => { // 選了「只上指定」卻沒加班別＝照上面班別，不存空陣列
      Object.keys(st[k] || {}).forEach(d => { if (Array.isArray(st[k][d]) && !st[k][d].length) delete st[k][d]; });
    });
    staff[e.name] = st;
  });
  const demand = {};
  asDayNames().forEach(d => {
    demand[d] = (aspCfg.demand[d] || []).map(b => {
      const o = { s: +b.s, e: +b.e, n: +b.n };
      if (aspMinOf(b) < o.n) o.min = aspMinOf(b); // 跟目標一樣就不存
      return o;
    });
  });
  const doc = {
    version: 1, demand, seasons: aspCfg.seasons, staff,
    updatedAt: new Date().toISOString(),
    updatedBy: aspUser.displayName || aspUser.empName || ''
  };
  btn.disabled = true;
  try {
    await window.db.collection('stores').doc(aspStore).collection('config').doc('autoSchedule').set(doc);
    aspCfg = { ...aspCfg, ...doc };
    aspSetDirty(false); aspBanner('', '');
    document.getElementById('metaInfo').textContent = aspSavedLabel(doc);
    aspToast('✅ 已儲存');
  } catch (e) {
    aspToast('儲存失敗：' + e.message);
  } finally { btn.disabled = false; }
}
