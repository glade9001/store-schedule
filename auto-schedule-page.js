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

let _aspChk = 0;
function aspSetDirty(v) {
  aspDirty = v;
  document.getElementById('dirtyHint').textContent = v ? '● 有尚未儲存的修改' : '';
  if (!aspCfg) return;
  cancelAnimationFrame(_aspChk);
  _aspChk = requestAnimationFrame(() => aspRenderChecks());
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
  aspCfg = null; aspSetDirty(false); aspDayEdit = null; aspSplitDays = new Set(); aspOpenDays = new Set();
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
  aspRenderSeasons(); aspRenderDemand(); aspRenderSeasonSwitch(); aspRenderStaff(); aspRenderChecks();
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

// ───────── ① 人數需求 ─────────
// 畫面分組：平日（週一～週五）一張、假日（週六、週日）一張；某天不一樣才拆成單獨一張。
// ⚠️ 只是畫面分組——資料照舊每天存一份（草稿產生器不用改）；編輯分組卡＝同時改那幾天。
const ASP_GROUPS = [
  { key: 'wd', label: '平日', full: '平日（週一～週五）', days: ['週一', '週二', '週三', '週四', '週五'] },
  { key: 'we', label: '假日', full: '週六、週日', days: ['週六', '週日'] }
];
let aspSplitDays = new Set(); // 店長按了「單獨設定」的星期（就算內容一樣也分開顯示）
let aspCardDays = {};         // 卡片 key → 這張卡管的星期（render 時建立）

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
// 最少人數：沒存＝跟理想人數一樣（一定要排滿）
function aspMinOf(b) { return b.min == null ? b.n : Math.min(b.min, b.n); }
function aspBandSig(bands) { return JSON.stringify((bands || []).map(b => [+b.s, +b.e, +b.n, aspMinOf(b)]).sort((a, b) => a[0] - b[0])); }
function aspShortDay(d) { return d.slice(1); }
function aspTimeLabel(s, e) { return asHourLabel(s).replace('隔天 ', '') + '–' + asHourLabel(e); }

/** 依目前內容算出要顯示哪些卡片 */
function aspDemandCards() {
  const cards = [];
  aspCardDays = {};
  ASP_GROUPS.forEach(g => {
    const cnt = {};
    g.days.forEach(d => { if (!aspSplitDays.has(d)) { const k = aspBandSig(aspCfg.demand[d]); cnt[k] = (cnt[k] || 0) + 1; } });
    // 基準＝這組裡最多天一樣的那份（平手取先出現的）
    let base = null, best = 0;
    g.days.forEach(d => { if (aspSplitDays.has(d)) return; const k = aspBandSig(aspCfg.demand[d]); if (cnt[k] > best) { best = cnt[k]; base = k; } });
    const members = g.days.filter(d => !aspSplitDays.has(d) && aspBandSig(aspCfg.demand[d]) === base);
    const others = g.days.filter(d => members.indexOf(d) < 0);
    if (members.length >= 2) {
      const key = 'G:' + g.key;
      aspCardDays[key] = members;
      cards.push({ key, days: members, group: g, isGroup: true,
        title: members.length === g.days.length ? g.full : g.label + '（' + members.map(aspShortDay).join('、') + '）' });
    } else members.forEach(d => others.unshift(d));
    others.sort((a, b) => g.days.indexOf(a) - g.days.indexOf(b)).forEach(d => {
      const key = 'D:' + d;
      aspCardDays[key] = [d];
      cards.push({ key, days: [d], group: g, isGroup: false, title: d, differs: members.length >= 2 });
    });
  });
  return cards;
}
function aspDaysOf(key) { return aspCardDays[key] || []; }
/** 改第一天的內容，再複製給這張卡的其他天 */
function aspApplyToCard(key, fn) {
  const days = aspDaysOf(key);
  if (!days.length) return;
  const first = aspCfg.demand[days[0]] = aspCfg.demand[days[0]] || [];
  fn(first);
  first.sort((a, c) => a.s - c.s);
  days.slice(1).forEach(d => { aspCfg.demand[d] = first.map(b => ({ ...b })); });
  aspSetDirty(true); aspRenderDemand();
}

function aspRenderDemand() {
  const cards = aspDemandCards();
  document.getElementById('demandWrap').innerHTML = cards.map(c => {
    const bands = aspCfg.demand[c.days[0]] || [];
    const k = c.key;
    const rows = bands.map((b, i) => `
      <div class="band">
        <select class="sm" onchange="aspEditBand('${k}',${i},'s',this.value)">${aspHourOptions(b.s, 7, 30.5)}</select>
        <span class="tilde">～</span>
        <select class="sm" onchange="aspEditBand('${k}',${i},'e',this.value)">${aspHourOptions(b.e, 7.5, 31)}</select>
        <span class="stepper"><button onclick="aspStepBand('${k}',${i},-1)">−</button><span>${b.n} 人</span><button onclick="aspStepBand('${k}',${i},1)">＋</button></span>
        <button class="btn-x" onclick="aspDelBand('${k}',${i})" aria-label="刪除這個時段">✕</button>
      </div>
      <div class="band-min">至少要有 <span class="stepper sm"><button onclick="aspStepMin('${k}',${i},-1)">−</button><span>${aspMinOf(b)} 人</span><button onclick="aspStepMin('${k}',${i},1)">＋</button></span>
        <span class="meta">${aspMinOf(b) < b.n ? `排不到 ${b.n} 人只提醒；少於 ${aspMinOf(b)} 人才開 🆘 待補` : '一定要排滿，排不到就開 🆘 待補'}</span></div>`).join('');
    const warn = aspBandWarn(bands);
    const open = aspOpenDays.has(k);
    const summary = bands.map(b => `${aspTimeLabel(b.s, b.e)} ${b.n}人${aspMinOf(b) < b.n ? `(至少${aspMinOf(b)})` : ''}`).join('・') || '<span class="empty-chips">還沒填</span>';
    const g = c.group;
    let actions = `<button class="btn-mini" onclick="aspAddBand('${k}')">＋ 新增時段</button>`;
    if (c.isGroup) {
      actions += `<select class="sm mini-sel" onchange="if(this.value)aspSplitDay(this.value)"><option value="">某一天不一樣…</option>${c.days.map(d => `<option value="${d}">${d} 單獨設定</option>`).join('')}</select>`;
    } else if (c.differs) {
      actions += `<button class="btn-mini" onclick="aspJoinGroup('${c.days[0]}')">↩ 改回跟${g.label}一樣</button>`;
    }
    return `<div class="card">
      <div class="day-head" onclick="aspToggleDay('${k}')" style="cursor:pointer;">
        <span class="day-name">${c.title}${c.differs ? ' <span class="diff-tag">跟' + g.label + '不同</span>' : ''}</span>
        <span class="btn-mini">${open ? '收合 ▲' : '編輯 ▼'}</span></div>
      ${aspCovBar(bands)}
      ${open ? `${rows || '<div class="meta">（還沒有時段，按「＋ 新增時段」）</div>'}
        ${warn ? `<div class="band-warn">${warn}</div>` : ''}
        <div class="day-actions">${actions}</div>`
      : `<div class="day-sum">${summary}</div>${warn ? `<div class="band-warn">${warn}</div>` : ''}`}
    </div>`;
  }).join('');
}
function aspToggleDay(k) { if (aspOpenDays.has(k)) aspOpenDays.delete(k); else aspOpenDays.add(k); aspRenderDemand(); }
function aspEditBand(k, i, f, v) {
  aspApplyToCard(k, bands => {
    const b = bands[i];
    b[f] = parseFloat(v);
    if (b.e <= b.s) { if (f === 's') b.e = Math.min(31, b.s + 0.5); else b.s = Math.max(7, b.e - 0.5); }
  });
}
function aspStepBand(k, i, delta) { aspApplyToCard(k, bands => { const b = bands[i]; b.n = Math.max(1, Math.min(9, b.n + delta)); }); }
function aspStepMin(k, i, delta) { aspApplyToCard(k, bands => { const b = bands[i]; b.min = Math.max(0, Math.min(b.n, aspMinOf(b) + delta)); }); }
function aspDelBand(k, i) { aspApplyToCard(k, bands => { bands.splice(i, 1); }); }
function aspAddBand(k) {
  aspApplyToCard(k, bands => {
    const last = bands[bands.length - 1];
    const s = last ? Math.min(30.5, last.e) : 7;
    bands.push({ s, e: Math.min(31, s + 8), n: 1 });
  });
}
/** 分組卡裡的某天拆出來單獨設定（先照抄同一份，之後改它不影響其他天） */
function aspSplitDay(d) {
  aspSplitDays.add(d);
  aspOpenDays.add('D:' + d);
  aspRenderDemand();
}
/** 單獨的那天改回跟分組一樣（抄分組的內容） */
function aspJoinGroup(d) {
  const g = ASP_GROUPS.find(x => x.days.indexOf(d) >= 0);
  const groupKey = 'G:' + g.key;
  const src = aspDaysOf(groupKey)[0];
  if (!src) return;
  if (!confirm(`把${d}改回跟${g.label}一樣？（${d}目前的設定會被取代）`)) return;
  aspCfg.demand[d] = (aspCfg.demand[src] || []).map(b => ({ ...b }));
  aspSplitDays.delete(d);
  aspOpenDays.delete('D:' + d);
  aspSetDirty(true); aspRenderDemand();
}

// ───────── ② 人員 ─────────
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
function aspIsFt(e) { return !!(e.role && e.role !== '工讀' && !e.payAsPartTime); }

/** 人員 × 星期總覽：一眼看出誰哪天不能上／只能上什麼；點格子在表格下方編輯 */
function aspRenderWeekGrid() {
  const days = asDayNames(), season = aspSeason;
  const head = `<tr><th>人員</th>${days.map(d => `<th>${aspShortDay(d)}</th>`).join('')}</tr>`;
  const body = aspEmps.map((e, idx) => {
    const st = aspCfg.staff[e.name] || {};
    if (!st.auto) return `<tr class="wg-manual"><td class="wg-name">${aspEsc(e.name)}<small>手動排</small></td>${days.map(() => '<td class="wg-cell na"></td>').join('')}</tr>`;
    const ex = st[season + 'Days'] || {};
    const empty = !(st[season] || []).length;
    return `<tr><td class="wg-name">${aspEsc(e.name)}<small>${aspIsFt(e) ? '正職' : '工讀'}</small></td>` + days.map(d => {
      const v = ex[d];
      const on = aspDayEdit && aspDayEdit.idx === idx && aspDayEdit.day === d;
      const cls = v === 'off' ? 'off' : (Array.isArray(v) && v.length ? 'only' : (empty ? 'none' : ''));
      const txt = v === 'off' ? '✕' : (Array.isArray(v) && v.length ? v.join('<br>') : (empty ? '？' : '・'));
      return `<td class="wg-cell ${cls} ${on ? 'on' : ''}" onclick="aspPickDay(${idx},'${season}','${d}')">${txt}</td>`;
    }).join('') + '</tr>';
  }).join('');
  document.getElementById('weekGrid').innerHTML =
    `<div class="wg-legend">・＝照平常可以排的班　✕＝不能上　班別＝那天只能上這些　？＝還沒填可以排的班</div>
     <div class="wg-wrap"><table class="wg-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>${aspDayEditor()}`;
}
function aspDayEditor() {
  if (!aspDayEdit) return '';
  const e = aspEmps[aspDayEdit.idx];
  if (!e) return '';
  const st = aspCfg.staff[e.name] || {};
  const d = aspDayEdit.day, v = (st[aspDayEdit.season + 'Days'] || {})[d];
  const mode = v === 'off' ? 'off' : (Array.isArray(v) ? 'only' : 'default');
  const onlyChips = Array.isArray(v) ? v.map((sh, i) => `<span class="chip"><span class="chip-txt">${aspEsc(sh)}</span><button class="chip-x" onclick="aspDelDayShift(${i})" aria-label="移除">×</button></span>`).join('') : '';
  return `<div class="day-editor">
    <div class="day-editor-title">${aspEsc(e.name)}・${d}</div>
    <div class="seg">
      <button class="${mode === 'default' ? 'sel' : ''}" onclick="aspSetDayMode('default')">照平常</button>
      <button class="${mode === 'off' ? 'sel' : ''}" onclick="aspSetDayMode('off')">不能上</button>
      <button class="${mode === 'only' ? 'sel' : ''}" onclick="aspSetDayMode('only')">只能上…</button>
    </div>
    ${mode === 'only' ? `<div class="chips" style="margin-top:6px;">${onlyChips}
      <span class="chip-add"><input list="shiftList" placeholder="＋ 班別" id="dayadd" onkeydown="if(event.key==='Enter')aspAddDayShift()">
      <button class="btn-mini" onclick="aspAddDayShift()">加入</button></span></div>` : ''}
    <div style="text-align:right;margin-top:6px;"><button class="btn-mini" onclick="aspPickDay(${aspDayEdit.idx},'${aspDayEdit.season}','${d}')">完成</button></div>
  </div>`;
}

function aspRenderStaff() {
  const wrap = document.getElementById('staffWrap');
  if (!aspEmps.length) { wrap.innerHTML = '<div class="card meta">這家店沒有在職人員</div>'; document.getElementById('weekGrid').innerHTML = ''; return; }
  aspRenderWeekGrid();
  const season = aspSeason;
  wrap.innerHTML = aspEmps.map((e, idx) => {
    const st = aspCfg.staff[e.name] || { auto: true, term: [], vacation: [] };
    const ref = aspStats[e.name] || {};
    const ft = aspIsFt(e);
    const roleTxt = (e.role || '工讀') + (e.payAsPartTime ? '・時薪計' : '');
    const list = st[season] || [];
    const chips = list.map((s, i) => `<span class="chip ${i === 0 ? 'main' : ''}">
        <span class="chip-txt" onclick="aspMakeMain(${idx},'${season}',${i})" title="點一下設為最常排的班">${i === 0 ? '★ ' : ''}${aspEsc(s)}</span>
        <button class="chip-x" onclick="aspDelShift(${idx},'${season}',${i})" aria-label="移除">×</button></span>`).join('');
    const ex = st[season + 'Days'] || {};
    const exTxt = Object.keys(ex).filter(d => ex[d] === 'off' || (Array.isArray(ex[d]) && ex[d].length))
      .sort((a, b) => asDayNames().indexOf(a) - asDayNames().indexOf(b))
      .map(d => aspShortDay(d) + (ex[d] === 'off' ? ' 不能上' : ' 只能上 ' + ex[d].join('、'))).join('；');
    return `<div class="card ${st.auto ? '' : 'emp-off'}" id="emp-${idx}">
      <div class="emp-head">
        <span class="emp-name">${aspEsc(e.name)}</span><span class="role-tag ${ft ? 'ft' : ''}">${aspEsc(roleTxt)}</span>
        <label class="toggle"><input type="checkbox" ${st.auto ? 'checked' : ''} onchange="aspToggleAuto(${idx},this.checked)">自動排班</label>
      </div>
      ${st.auto ? `
        <div class="season-label">可以排的班 <span class="meta">（★＝最常排的班；工讀寫 7-15 代表這段時間內都能排）</span></div>
        <div class="chips">
          ${chips || '<span class="empty-chips">還沒填，自動排班不會排這個人</span>'}
          <span class="chip-add"><input list="shiftList" placeholder="＋ 班別" id="add-${idx}-${season}" onkeydown="if(event.key==='Enter')aspAddShift(${idx},'${season}')">
          <button class="btn-mini" onclick="aspAddShift(${idx},'${season}')">加入</button></span>
        </div>
        ${exTxt ? `<div class="ex-line">📅 ${aspEsc(exTxt)} <span class="meta">（在上面的總覽表改）</span></div>` : ''}
        <div class="cap-row">每週最多
          <input type="number" inputmode="numeric" min="1" max="7" value="${st.maxDays ?? ''}" placeholder="不限" onchange="aspSetCap(${idx},'maxDays',this.value)"> 天
          <input type="number" inputmode="decimal" min="1" max="${ft ? 40 : 80}" step="0.5" value="${st.maxHours ?? ''}" placeholder="${ft ? '40' : '不限'}" onchange="aspSetCap(${idx},'maxHours',this.value)"> 小時
          ${ft ? '<span class="meta">（正職最多 40）</span>' : ''}</div>
        <details class="emp-ref"><summary>過去排班參考</summary>近 12 週平均每週 ${ref.weeklyHours ?? 0} 小時｜常上 ${aspEsc(aspTopCounts(season === 'term' ? ref.termCount : ref.vacCount, 4))}</details>`
      : '<div class="meta">不自動排，由店長手動排這個人。</div>'}
    </div>`;
  }).join('');
}
function aspPickDay(idx, season, day) {
  const same = aspDayEdit && aspDayEdit.idx === idx && aspDayEdit.season === season && aspDayEdit.day === day;
  aspDayEdit = same ? null : { idx, season, day };
  aspRenderWeekGrid();
}
function aspDayMap() {
  const st = aspStaffOf(aspDayEdit.idx), k = aspDayEdit.season + 'Days';
  return st[k] = st[k] || {};
}
function aspSetDayMode(mode) {
  const m = aspDayMap(), d = aspDayEdit.day;
  if (mode === 'default') delete m[d];
  else if (mode === 'off') m[d] = 'off';
  else if (!Array.isArray(m[d])) m[d] = []; // 先開空清單，加了班別才生效（空的＝照平常）
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

// ───────── ③ 人力夠不夠（供需檢查）＋ 完成度 ─────────
// 每個時段「至少要幾人」vs「有幾個人能上」。能上＝自動排班的人那天可以排的班涵蓋這個時段（手動排的人不算）。
// 每週：正職一週最多上 5 天、工讀照「每週最多幾天」（沒填＝7），加總後跟需要的天數比 → 看出大夜這種結構性缺口。
function aspSampleDate(di) {
  // 用下週的日期判斷（寒暑假關閉時季節不影響）
  const mon = asWeekMonday(shiftWeekStr(shiftDateAdd(aspTodayStr(), 7)));
  return shiftDateAdd(mon, di);
}
function aspSupply() {
  const days = asDayNames();
  const people = aspEmps.filter(e => (aspCfg.staff[e.name] || {}).auto).map(e => {
    const st = aspCfg.staff[e.name];
    const cover = days.map((d, di) => {
      const set = new Set();
      asAvailableShifts(st, aspSampleDate(di), aspCfg.seasons).forEach(sh => asShiftSlots(sh).forEach(i => set.add(i)));
      return set;
    });
    const weekDays = st.maxDays ? +st.maxDays : (aspIsFt(e) ? 5 : 7);
    return { name: e.name, cover, weekDays };
  });
  // 每天每個時段：至少人數、能上的人
  const perBand = {}; // "s-e" → { s, e, days:[{d, min, who}] }
  days.forEach((d, di) => {
    (aspCfg.demand[d] || []).forEach(b => {
      const mn = aspMinOf(b);
      if (!mn) return;
      const idxs = []; for (let h = b.s; h < b.e; h += 0.5) idxs.push(Math.round((h - 7) * 2));
      // 能「整段都上」的人不一定有；以每半小時能上的人裡最少的那一刻為準
      let who = null;
      idxs.forEach(i => { const w = people.filter(p => p.cover[di].has(i)).map(p => p.name); if (!who || w.length < who.length) who = w; });
      const key = b.s + '-' + b.e;
      (perBand[key] = perBand[key] || { s: b.s, e: b.e, days: [] }).days.push({ d, di, min: mn, who: who || [] });
    });
  });
  const issues = [];
  Object.values(perBand).sort((a, b) => a.s - b.s).forEach(pb => {
    const label = aspTimeLabel(pb.s, pb.e);
    // 當天就不夠（每天檢查）
    const shortDays = pb.days.filter(x => x.who.length < x.min);
    if (shortDays.length) {
      const zero = shortDays.filter(x => !x.who.length);
      if (zero.length) issues.push({ lv: 'red', msg: `${zero.map(x => aspShortDay(x.d)).join('、')} ${label}：沒有人能上（至少要 ${zero[0].min} 人）` });
      shortDays.filter(x => x.who.length).forEach(x => issues.push({ lv: 'red', msg: `${aspShortDay(x.d)} ${label}：至少要 ${x.min} 人，能上的只有 ${x.who.join('、')}` }));
    }
    // 每週加總：需要的人天 vs 這些人一週最多能上的天數
    const need = pb.days.reduce((a, x) => a + x.min, 0);
    const names = {}; pb.days.forEach(x => x.who.forEach(n => { names[n] = (names[n] || 0) + 1; }));
    const cap = Object.keys(names).reduce((a, n) => a + Math.min(names[n], people.find(p => p.name === n).weekDays), 0);
    if (cap < need) issues.push({ lv: 'red', msg: `${label}：一週需要 ${need} 人天，能上的 ${Object.keys(names).join('、') || '（無）'} 一週最多只能上 ${cap} 天 → 每週約缺 ${need - cap} 天` });
    else if (!shortDays.length && cap - need <= 1 && need > 0) issues.push({ lv: 'amber', msg: `${label}：人力剛好（能上的 ${Object.keys(names).join('、')}），有人請假就會缺` });
  });
  return issues;
}
function aspRenderChecks() {
  // 完成度
  const days = asDayNames();
  const emptyDays = days.filter(d => !(aspCfg.demand[d] || []).length);
  const noShift = aspEmps.filter(e => { const st = aspCfg.staff[e.name] || {}; return st.auto && !(st[aspSeason] || []).length; }).map(e => e.name);
  const todo = [];
  if (emptyDays.length === 7) todo.push(`<a onclick="aspJump('demandSec')">每天各時段需要幾人還沒填</a>`);
  else if (emptyDays.length) todo.push(`<a onclick="aspJump('demandSec')">${emptyDays.map(aspShortDay).join('、')} 的人數需求還沒填</a>`);
  if (noShift.length) todo.push(`<a onclick="aspJump('staffSec')">還沒填可以排的班：${aspEsc(noShift.join('、'))}</a>`);
  const pb = document.getElementById('progressBox');
  pb.className = 'progress ' + (todo.length ? 'todo' : 'done');
  pb.innerHTML = todo.length
    ? `<b>還差 ${todo.length} 項就能產生草稿：</b><br>${todo.map(t => '・' + t).join('<br>')}`
    : `✅ 設定完成${aspDirty ? '（記得按「儲存設定」）' : ''}，排班頁可以按「🤖 產生草稿」。`;
  // 供需
  const issues = (emptyDays.length === 7) ? [] : aspSupply();
  document.getElementById('supplyWrap').innerHTML = emptyDays.length === 7
    ? '<div class="card meta">填好人數需求後，這裡會檢查每個時段有沒有足夠的人能上。</div>'
    : `<div class="card">${issues.length ? issues.map(x => `<div class="sup ${x.lv}">${x.lv === 'red' ? '🔴' : '🟡'} ${aspEsc(x.msg)}</div>`).join('') : '<div class="sup ok">✅ 每個時段都有足夠的人能上</div>'}
       <div class="meta" style="margin-top:6px;">🔴 的時段草稿一定排不滿，會開 🆘 待補——要解決得靠多一個能上的人，或改人數需求。手動排的人不算在內。</div></div>`;
}
function aspJump(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

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
