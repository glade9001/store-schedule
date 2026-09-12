/**
 * ===== 盤點資料（inspection.html）=====
 *
 * 盤點前產出三份文件：職員輪班表、出勤記錄表、薪資單（PDF）。
 *
 * ⚠️ 與正式資料完全隔離：只讀寫 inspectionSheets/{id}，
 *    不碰 stores/{店}/weeks、attendance、salary，也不進任何成本／績效統計。
 *    班別清單是唯一的例外（唯讀 config/shifts，讓選項跟門市一致）。
 *
 * ⚠️ 檔名為什麼叫 inspection 而不是 audit/stocktake：
 *    「盤點」在本專案已經有兩個既有意思 —— pnl-loss.js 的盤點＝存貨盤點／盤損，
 *    data-audit.html 的資料健檢又佔掉 audit 這個字。為了不讓後人把三者搞混，
 *    程式一律用 inspection，介面文案才叫「盤點資料」。
 *
 * ⚠️ 出勤時間一律人工填寫，系統不會自動產生任何打卡時間。
 *    未來接打卡系統時，只要把 punches 的來源改成真實紀錄，表單格式不用動。
 */

// ===== 狀態 =====
let currentUser = null;
let appConfig = {};
let shiftOptions = [];          // 可選班別（時間班別，來自門市 config/shifts）
let sheets = [];                // 清單
let sheet = null;               // 正在編輯的盤點（含 id）
let activeStep = 1;
let holidayMap = {};            // YYYY-MM-DD → 假日名
let holidaySource = 'builtin';
let saveTimer = null;
let dirty = false;
let editingEmpId = '';
let myUid = '';
let insuranceGrades = null;   // settings/insuranceGrades，與薪資系統同一份

const DEFAULT_WAGE = 196;       // 工讀時薪（盤點預設值）
const OFF = '休';               // 休假在班表與出勤表上的表示法
const DAY_NAMES = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];

// ===== 權限 =====
const canUse = () => ['manager', 'owner', 'admin'].includes(currentUser?.permission);
// 加盟主以上不限；店長只能動自己建立的那幾份
const isOwnerUp = () => ['owner', 'admin'].includes(currentUser?.permission);
const canEditSheet = (sh) => {
  const t = sh || sheet;
  if (!t) return false;
  if (isOwnerUp()) return true;
  return !!t.ownerUid && t.ownerUid === myUid;
};

// ===== 小工具 =====
const pad = n => String(n).padStart(2, '0');
const n = v => parseFloat(v || 0) || 0;
const comma = v => Math.round(v || 0).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const parseD = s => { const p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mondayOf = s => { const d = parseD(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
const dayIdx = s => (parseD(s).getDay() + 6) % 7;
const mdOf = s => { const p = s.split('-'); return `${+p[1]}/${+p[2]}`; };
const rocOf = y => y - 1911;
const isHoliday = d => !!holidayMap[d];

let _tt;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(_tt); _tt = setTimeout(() => t.classList.remove('show'), 2400);
}
function showLoad(msg) {
  document.getElementById('loadingText').textContent = msg || '載入中...';
  document.getElementById('loadingOverlay').classList.remove('hidden');
}
function hideLoad() { document.getElementById('loadingOverlay').classList.add('hidden'); }

/**
 * 輪班表期間：含盤點當週，再往前推 weeks 週（每段都是週一～週日）
 * 例：9/20（週日）盤點、往前 4 週 → 8/17（一）~ 9/20（日），共 5 週
 */
function computeRange(auditDate, weeks) {
  const mon = mondayOf(auditDate);
  return { start: shiftDateAdd(mon, -7 * (+weeks || 4)), end: shiftDateAdd(mon, 6) };
}
function dateList(start, end) {
  const out = [];
  for (let d = start; d <= end; d = shiftDateAdd(d, 1)) out.push(d);
  return out;
}
/** 期間切成整週（每段 7 天，週一起） */
function weekBlocks(start, end) {
  const out = [];
  for (let d = start; d <= end; d = shiftDateAdd(d, 7)) out.push(dateList(d, shiftDateAdd(d, 6)));
  return out;
}
/** 某月每一天 */
function monthDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) out.push(`${y}-${pad(m)}-${pad(d)}`);
  return out;
}
const prevMonthOf = dateStr => {
  const [y, m] = dateStr.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
};

// ===== 啟動 =====
window.onload = async () => {
  showLoad('驗證登入…');
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  try { currentUser = JSON.parse(saved); } catch (e) { location.replace('home.html'); return; }
  const fb = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(x => { u(); r(x); }); });
  if (!fb) { localStorage.removeItem('currentUser'); location.replace('home.html'); return; }
  if (!canUse()) { toast('僅店長以上可用'); setTimeout(() => location.replace('home.html'), 1200); return; }
  myUid = fb.uid;

  try {
    const s = await window.db.collection('settings').doc('globalConfig').get();
    if (s.exists) appConfig = s.data();
  } catch (e) { }

  await loadShiftOptions();
  try {
    const g = await window.db.collection('settings').doc('insuranceGrades').get();
    if (g.exists) insuranceGrades = g.data();
  } catch (e) { }
  const yr = new Date().getFullYear();
  try {
    const h = await loadHolidayMap([yr, yr + 1, yr - 1]);
    holidayMap = h.map; holidaySource = h.source;
  } catch (e) { holidayMap = builtinHolidayMap(); }

  await loadSheets();
  hideLoad();
};

/** 班別選項：沿用本店 config/shifts，只留真正的時間班別 */
async function loadShiftOptions() {
  let list = [];
  try {
    const store = currentUser.store;
    if (store) {
      const snap = await window.db.collection('stores').doc(store).collection('config').doc('shifts').get();
      if (snap.exists) list = snap.data().shifts || [];
    }
  } catch (e) { }
  if (!list.length) list = appConfig.shifts || ['7-15', '15-23', '23-07'];
  shiftOptions = list.filter(s => parseShiftSegs(s).length > 0);
  // 盤點三班制保底：設定裡沒有就補上，避免門市班別被改掉後這裡變空
  ['7-15', '15-23', '23-07'].forEach(s => { if (!shiftOptions.includes(s)) shiftOptions.push(s); });
}

// ===== 清單 =====
async function loadSheets() {
  sheets = [];
  try {
    const snap = await window.db.collection('inspectionSheets').orderBy('auditDate', 'desc').limit(50).get();
    snap.forEach(d => sheets.push({ id: d.id, ...d.data() }));
  } catch (e) { toast('讀取失敗：' + e.message); }
  renderList();
}

function renderList() {
  const box = document.getElementById('sheetList');
  if (!sheets.length) { box.innerHTML = '<div class="empty">還沒有盤點資料<br>點上方「新增盤點資料」開始</div>'; return; }
  box.innerHTML = sheets.map(s => {
    const emps = (s.employees || []).length;
    return `<div class="sheet-card" onclick="openSheet('${s.id}')">
      <div class="sheet-main">
        <div class="sheet-title">${esc(s.title || '未命名盤點')}</div>
        <div class="sheet-sub">${esc(s.storeName || '未填門市')} · 盤點日 ${s.auditDate || '--'} · ${emps} 人 · 輪班 ${mdOf(s.rangeStart || '--')}~${mdOf(s.rangeEnd || '--')}</div>
        <div class="sheet-sub">建立者：${esc(s.createdBy || '--')}${canEditSheet(s) ? '' : ' <span class="ro-tag">唯讀</span>'}</div>
      </div>
      <button class="sheet-copy" onclick="copySheet('${s.id}',event)">📄 複製</button>
      <div class="sheet-arrow">›</div>
    </div>`;
  }).join('');
}

function goBack() {
  if (sheet) { flushSave(); sheet = null; showList(); return; }
  location.href = new URLSearchParams(location.search).get('ref') || 'home.html';
}
function showList() {
  document.getElementById('listView').style.display = 'block';
  document.getElementById('editView').style.display = 'none';
  document.getElementById('headerTitle').textContent = '📋 盤點資料';
  document.getElementById('saveState').textContent = '';
  loadSheets();
}

function newSheet() {
  const today = ymd(new Date());
  const r = computeRange(today, 6);
  sheet = {
    id: '', title: '', storeName: '', auditDate: today, weeks: 6,
    ownerUid: myUid, createdBy: currentUser.empName || currentUser.username || '',
    rangeStart: r.start, rangeEnd: r.end, salaryMonth: prevMonthOf(today),
    employees: [], schedule: {}, punches: {},
  };
  openEditor();
}

async function openSheet(id) {
  showLoad('讀取中…');
  try {
    const snap = await window.db.collection('inspectionSheets').doc(id).get();
    if (!snap.exists) { toast('找不到這筆盤點'); hideLoad(); return; }
    sheet = { id, ...snap.data() };
    sheet.employees = sheet.employees || [];
    sheet.schedule = sheet.schedule || {};
    sheet.punches = sheet.punches || {};
  } catch (e) { toast('讀取失敗：' + e.message); hideLoad(); return; }
  hideLoad();
  openEditor();
}

function openEditor() {
  document.getElementById('listView').style.display = 'none';
  document.getElementById('editView').style.display = 'block';
  document.getElementById('headerTitle').textContent = sheet.title || '新盤點資料';
  // 月份選單：輪班期間涵蓋的月份＋盤點日的上個月
  const months = new Set([prevMonthOf(sheet.auditDate)]);
  dateList(sheet.rangeStart, sheet.rangeEnd).forEach(d => months.add(d.slice(0, 7)));
  const sel = document.getElementById('fSalaryMonth');
  sel.innerHTML = [...months].sort().reverse()
    .map(m => `<option value="${m}">${m.split('-')[0]} 年 ${+m.split('-')[1]} 月</option>`).join('');
  document.getElementById('fTitle').value = sheet.title || '';
  document.getElementById('fStore').value = sheet.storeName || '';
  document.getElementById('fAuditDate').value = sheet.auditDate || '';
  document.getElementById('fWeeks').value = String(sheet.weeks || 6);
  sel.value = sheet.salaryMonth || prevMonthOf(sheet.auditDate);
  renderEmps();
  gotoStep(1);
  renderRange();
  applyReadonlyUI();
}

// ===== 儲存 =====
// 改動後 900ms 自動存；另外在「離開頁面／切到背景」時再補一次。
//
// ⚠️ 三個一定要處理的破口（都是這個專案踩過的）：
//   ① 建立中的重複寫入：原本第一次存用 add()，若 900ms 內連按兩下或逾時重試，
//      會建出兩份一模一樣的盤點。改成先在本地產生 doc id、一律用 set() 全量覆寫 → 重試是冪等的。
//   ② Firestore SDK 沒有逾時：卡住時不會 reject，畫面會一直停在「未儲存…」讓人以為還在存。
//      這裡用 Promise.race 自己加 12 秒上限，逾時就明講並保留 dirty 等下次重試。
//   ③ 存檔進行中又有新改動：用 saving 旗標擋併發，結束後若 dirty 又被設起來就再排一次。
let saving = false;

function markDirty() {
  dirty = true;
  document.getElementById('saveState').textContent = '未儲存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 900);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

async function flushSave() {
  if (!dirty || !sheet || saving) return;
  if (!canEditSheet()) { dirty = false; return; }   // 唯讀：本來就不該有待存內容，保險再擋一次
  clearTimeout(saveTimer);
  saving = true;
  dirty = false;                       // 先清：存檔期間的新改動要能再觸發一次
  const now = new Date().toISOString();
  const me = currentUser.empName || currentUser.username || '';
  if (!sheet.createdAt) { sheet.createdAt = now; sheet.createdBy = me; }
  if (!sheet.id) sheet.id = window.db.collection('inspectionSheets').doc().id;
  const payload = {
    title: sheet.title || '', storeName: sheet.storeName || '',
    auditDate: sheet.auditDate, weeks: +sheet.weeks || 6,
    rangeStart: sheet.rangeStart, rangeEnd: sheet.rangeEnd, salaryMonth: sheet.salaryMonth,
    employees: sheet.employees || [], schedule: sheet.schedule || {}, punches: sheet.punches || {},
    createdAt: sheet.createdAt, createdBy: sheet.createdBy || me,
    ownerUid: sheet.ownerUid || myUid,
    updatedAt: now, updatedBy: me,
  };
  try {
    await withTimeout(window.db.collection('inspectionSheets').doc(sheet.id).set(payload), 12000);
    document.getElementById('saveState').textContent = '已儲存 ✓';
  } catch (e) {
    dirty = true;                      // 沒存成功，保留待存狀態
    const msg = e.message === 'timeout' ? '儲存逾時，請檢查網路' : '儲存失敗';
    document.getElementById('saveState').textContent = msg;
    toast(msg + '（資料還在畫面上，恢復連線後會自動重試）');
  } finally {
    saving = false;
    if (dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 3000); }
  }
}

// 離開／切到背景時補存一次。
// visibilitychange 是手機上唯一可靠的時機（切 App、鎖螢幕、關分頁都會觸發）；
// beforeunload 在桌機補一道攔截，避免關視窗時最後 900ms 內的改動掉了。
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', () => { flushSave(); });
window.addEventListener('beforeunload', e => {
  if (!dirty) return;
  flushSave();
  e.preventDefault();
  e.returnValue = '';
});

// ===== 步驟切換 =====
function gotoStep(s) {
  activeStep = s;
  for (let i = 1; i <= 5; i++) {
    const p = document.getElementById('panel' + i);
    if (p) p.style.display = (i === s) ? 'block' : 'none';
  }
  renderStepBar();
  if (s === 2) renderEmps();
  if (s === 3) renderSchedule();
  if (s === 4) { renderPunchEmpSelect(); renderPunch(); }
  if (s === 5) renderReady();
  applyReadonlyUI();
  window.scrollTo(0, 0);
}
function renderStepBar() {
  const labels = ['① 基本', '② 人員', '③ 排班', '④ 出勤時間', '⑤ 產出'];
  document.getElementById('stepBar').innerHTML = labels.map((l, i) =>
    `<button class="step-chip ${activeStep === i + 1 ? 'active' : ''}" onclick="gotoStep(${i + 1})">${l}</button>`
  ).join('');
}

/**
 * 唯讀套用：店長開別人建立的盤點時，只能看與產出 PDF，不能改也不能刪。
 * ⚠️ 這只是介面層；真正的擋在 firestore.rules（ownerUid 比對），
 *    不然開 console 就繞過去了。
 */
function applyReadonlyUI() {
  const ro = !canEditSheet();
  const banner = document.getElementById('roBanner');
  if (banner) banner.style.display = ro ? 'block' : 'none';
  document.querySelectorAll('#editView input, #editView select, #empModal input, #empModal select')
    .forEach(el => { el.disabled = ro; });
  document.querySelectorAll('.edit-only').forEach(el => { el.style.display = ro ? 'none' : ''; });
}

// ===== 複製整份 =====
// 放在清單頁，按一下直接產生一份新的（不跳對話框）。
// 唯讀檢視他人的盤點時也能複製——複本歸自己、原件不動。

/**
 * 產生複本內容（純函式，不碰 DOM —— 日期平移最容易出錯，要能單獨測）
 * @param {object} src 原盤點
 * @param {number} days 平移天數（一律是 7 的倍數，星期幾才對得上）
 */
function buildCopyPayload(src, days, opt) {
  const shiftMap = m => {
    const out = {};
    Object.keys(m || {}).forEach(dt => { out[shiftDateAdd(dt, days)] = JSON.parse(JSON.stringify(m[dt])); });
    return out;
  };
  const audit = shiftDateAdd(src.auditDate, days);
  const now = new Date().toISOString();
  return {
    title: opt.title,
    storeName: src.storeName || '',
    auditDate: audit,
    weeks: +src.weeks || 6,
    rangeStart: shiftDateAdd(src.rangeStart, days),
    rangeEnd: shiftDateAdd(src.rangeEnd, days),
    salaryMonth: days ? prevMonthOf(audit) : (src.salaryMonth || prevMonthOf(audit)),
    // 員工 id 沿用即可：schedule/punches 以 id 對位，換了反而要整份重寫
    employees: JSON.parse(JSON.stringify(src.employees || [])),
    schedule: shiftMap(src.schedule),
    punches: shiftMap(src.punches),
    ownerUid: opt.ownerUid, createdBy: opt.createdBy, createdAt: now,
    updatedAt: now, updatedBy: opt.createdBy,
  };
}

/** 複本名稱：同名時自動累加「複本 2、複本 3…」 */
function copyTitleOf(base) {
  const root = String(base || '未命名盤點').replace(/\s*-\s*複本\s*\d*$/, '');
  const used = new Set(sheets.map(s => s.title));
  let t = root + ' - 複本';
  for (let i = 2; used.has(t); i++) t = `${root} - 複本 ${i}`;
  return t;
}

async function copySheet(id, ev) {
  if (ev) ev.stopPropagation();
  const src = sheets.find(s => s.id === id);
  if (!src) { toast('找不到這份盤點'); return; }
  const copy = buildCopyPayload(src, 0, {
    title: copyTitleOf(src.title),
    ownerUid: myUid,
    createdBy: currentUser.empName || currentUser.username || '',
  });
  showLoad('複製中…');
  try {
    const newId = window.db.collection('inspectionSheets').doc().id;
    await withTimeout(window.db.collection('inspectionSheets').doc(newId).set(copy), 12000);
    await loadSheets();
    hideLoad();
    toast(`已複製為「${copy.title}」`);
  } catch (e) {
    hideLoad();
    toast(e.message === 'timeout' ? '複製逾時，請檢查網路' : '複製失敗：' + e.message);
  }
}

async function deleteSheet() {
  if (!canEditSheet()) { toast('只能刪除自己建立的盤點'); return; }
  if (!sheet.id) { sheet = null; showList(); return; }
  if (!confirm(`確定刪除「${sheet.title || '未命名盤點'}」？人員、班表與已填的出勤時間都會一併刪除，無法復原。`)) return;
  showLoad('刪除中…');
  try {
    await window.db.collection('inspectionSheets').doc(sheet.id).delete();
    dirty = false; sheet = null;
    hideLoad(); showList(); toast('已刪除');
  } catch (e) { hideLoad(); toast('刪除失敗：' + e.message); }
}

// ===== 步驟 1 =====
function onField() {
  sheet.title = document.getElementById('fTitle').value.trim();
  sheet.storeName = document.getElementById('fStore').value.trim();
  sheet.salaryMonth = document.getElementById('fSalaryMonth').value;
  document.getElementById('headerTitle').textContent = sheet.title || '新盤點資料';
  markDirty();
}
function onAuditDateChange() {
  const d = document.getElementById('fAuditDate').value;
  if (!d) return;
  const oldAudit = sheet.auditDate;
  const w = +document.getElementById('fWeeks').value;
  const r = computeRange(d, w);
  sheet.auditDate = d; sheet.weeks = w; sheet.rangeStart = r.start; sheet.rangeEnd = r.end;
  const sel = document.getElementById('fSalaryMonth');
  const months = new Set([prevMonthOf(d)]);
  dateList(r.start, r.end).forEach(x => months.add(x.slice(0, 7)));
  const keep = sheet.salaryMonth;
  sel.innerHTML = [...months].sort().reverse()
    .map(m => `<option value="${m}">${m.split('-')[0]} 年 ${+m.split('-')[1]} 月</option>`).join('');
  // ⚠️ 換盤點日後舊月份可能已不在清單裡：不可沿用，否則使用者以為在編 8 月、其實寫進別的月
  sel.value = [...months].includes(keep) ? keep : prevMonthOf(d);
  sheet.salaryMonth = sel.value;
  if (oldAudit && oldAudit !== d) offerShiftDates(oldAudit, d);
  renderRange();
  markDirty();
}
function renderRange() {
  const r = { start: sheet.rangeStart, end: sheet.rangeEnd };
  const days = dateList(r.start, r.end).length;
  const sm = sheet.salaryMonth;
  const hols = monthDays(sm).filter(isHoliday);
  document.getElementById('rangeBox').innerHTML = `
    <div>輪班表期間：<b>${r.start}（${DAY_NAMES[dayIdx(r.start)]}）～ ${r.end}（${DAY_NAMES[dayIdx(r.end)]}）</b>　共 ${days} 天 / ${days / 7} 週（含盤點當週）</div>
    <div>出勤記錄表＋薪資單：<b>${sm.split('-')[0]} 年 ${+sm.split('-')[1]} 月整月</b></div>
    <div>該月國定假日：<b>${hols.length ? hols.map(h => `${mdOf(h)} ${holidayMap[h]}`).join('、') : '無'}</b></div>
    <div style="color:#64748b;font-size:11.5px;margin-top:4px;">盤點當日（${sheet.auditDate}）不列出勤紀錄。</div>`;
}

// ===== 步驟 2：人員 =====
function renderEmps() {
  const box = document.getElementById('empList');
  const emps = sheet.employees || [];
  if (!emps.length) { box.innerHTML = '<div class="empty">還沒有人員</div>'; return; }
  // 順序＝輪班表的列順序、出勤表與薪資單的頁順序，所以要能調
  box.innerHTML = emps.map((e, i) => {
    const money = e.role === '工讀'
      ? `時薪 $${n(e.wage) || DEFAULT_WAGE}`
      : `底薪 $${comma(n(e.baseSalary))}`;
    return `<div class="emp-row" onclick="openEmpEdit('${e.id}')">
      <span class="emp-ord">${i + 1}</span>
      <span class="emp-name">${esc(e.name)}</span>
      <span class="emp-badge ${e.role === '工讀' ? 'badge-part' : 'badge-full'}">${e.role}</span>
      <span class="emp-money">${money}${e.insuranceGrade === -1 ? '・未投保' : e.insuranceGrade == null ? '・未設級距' : ''}</span>
      <span class="emp-move edit-only">
        <button class="ord-btn" ${i === 0 ? 'disabled' : ''} onclick="event.stopPropagation();moveEmp('${e.id}',-1)">↑</button>
        <button class="ord-btn" ${i === emps.length - 1 ? 'disabled' : ''} onclick="event.stopPropagation();moveEmp('${e.id}',1)">↓</button>
      </span>
      <span class="sheet-arrow">›</span>
    </div>`;
  }).join('');
}

/** 投保級距選單：與薪資系統同一份 settings/insuranceGrades，選項也照它的分組 */
function renderGradeSelect(sel) {
  const grades = insuranceGrades?.grades || [];
  const pt = grades.map((g, i) => ({ ...g, i })).filter(g => g.type === 'partTime');
  const ft = grades.map((g, i) => ({ ...g, i })).filter(g => g.type === 'fullTime');
  const el = document.getElementById('eGrade');
  const cur = sel == null ? '' : String(sel);
  el.innerHTML = `<option value="">— 未設定 —</option><option value="-1">未投保</option>`
    + (pt.length ? `<optgroup label="── 部分工時 ──">${pt.map(g =>
      `<option value="${g.i}">月薪 ${comma(g.wageMin)}~${comma(g.wageMax)}</option>`).join('')}</optgroup>` : '')
    + (ft.length ? `<optgroup label="── 月薪制 ──">${ft.map(g =>
      `<option value="${g.i}">$${comma(g.insuredSalary)}</option>`).join('')}</optgroup>` : '');
  el.value = cur;
  if (!grades.length) {
    document.getElementById('gradeBox').innerHTML =
      '<div class="grade-warn">讀不到投保級距表（settings/insuranceGrades），請先在薪資系統設定；此處保費會留 0。</div>';
  }
}

/** 依選到的級距帶入保費（勞保／健保／眷屬／雇主負擔），畫面同步顯示 */
function onGradeChange(keepSel) {
  const grades = insuranceGrades?.grades || [];
  const v = document.getElementById('eGrade').value;
  const depCount = Math.max(0, n(document.getElementById('eDepCount').value));
  const noHealth = document.getElementById('eHealthUninsured').checked;
  const box = document.getElementById('gradeBox');
  if (v === '') { box.innerHTML = '<div class="grade-warn">未設定級距：勞保、健保皆以 0 計。</div>'; return; }
  if (v === '-1') { box.innerHTML = '<div class="grade-warn">未投保：勞保、健保皆為 0。</div>'; return; }
  const g = grades[parseInt(v, 10)];
  if (!g) { box.innerHTML = ''; return; }
  const health = noHealth ? 0 : n(g.healthEmp);
  box.innerHTML = `
    <div class="grade-row"><span>勞保費（個人）</span><b>$${comma(g.laborEmp)}</b></div>
    <div class="grade-row"><span>健保費（個人）</span><b>$${comma(health)}</b>${noHealth ? ' <span class="grade-tag">未投保</span>' : ''}</div>
    ${depCount ? `<div class="grade-row"><span>眷屬健保 ×${depCount}</span><b>$${comma(health * depCount)}</b></div>` : ''}
    <div class="grade-row muted"><span>雇主負擔：勞保 $${comma(g.laborEr)}・健保 $${comma(noHealth ? 0 : g.healthEr)}・勞退提撥 $${comma(g.pension)}</span></div>`;
}

/** 調整人員順序（輪班表列序／出勤表與薪資單的頁序都吃這個） */
function moveEmp(id, dir) {
  if (!canEditSheet()) return;
  const list = sheet.employees || [];
  const i = list.findIndex(e => e.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  markDirty(); renderEmps(); applyReadonlyUI();
}

function onRoleChange() {
  const isPart = document.getElementById('eRole').value === '工讀';
  document.getElementById('fullFields').style.display = isPart ? 'none' : 'block';
  document.getElementById('partFields').style.display = isPart ? 'block' : 'none';
}

function openEmpEdit(id) {
  editingEmpId = id;
  if (!canEditSheet() && !id) return;              // 唯讀：不給新增
  const e = (sheet.employees || []).find(x => x.id === id) || { role: '正職', wage: DEFAULT_WAGE };
  document.getElementById('empModalTitle').textContent = id ? '編輯人員' : '新增人員';
  document.getElementById('empDelBtn').style.display = id ? 'block' : 'none';
  const set = (el, v) => { document.getElementById(el).value = (v == null || v === 0) ? (v === 0 ? 0 : '') : v; };
  document.getElementById('eName').value = e.name || '';
  document.getElementById('eRole').value = e.role || '正職';
  set('eBase', e.baseSalary); set('eAttend', e.fullAttendBonus); set('eMgmt', e.mgmtBonus);
  set('eLaborAllow', e.laborAllowance); set('ePerf', e.performance); set('eOther', e.otherBonus);
  set('eOtHours', e.otHours); set('eLateMin', e.lateMinutes); set('eSick', e.personalSickLeave);
  document.getElementById('eWage').value = e.wage == null ? DEFAULT_WAGE : e.wage;
  set('eSickP', e.personalSickLeave);
  set('ePension', e.laborPension); set('eOtherDed', e.otherDeduction);
  document.getElementById('eDepCount').value = e.dependentCount || 0;
  document.getElementById('eHealthUninsured').checked = !!e.healthUninsured;
  renderGradeSelect(e.insuranceGrade == null ? '' : e.insuranceGrade);
  onGradeChange(true);
  onRoleChange();
  document.getElementById('empModal').classList.add('open');
  applyReadonlyUI();
}
function closeEmpEdit() { document.getElementById('empModal').classList.remove('open'); }

function saveEmp() {
  if (!canEditSheet()) { toast('唯讀模式'); return; }
  const name = document.getElementById('eName').value.trim();
  if (!name) { toast('請填姓名'); return; }
  const role = document.getElementById('eRole').value;
  const g = id => document.getElementById(id).value;
  const isPart = role === '工讀';
  const data = {
    name, role,
    baseSalary: isPart ? 0 : n(g('eBase')),
    fullAttendBonus: isPart ? 0 : n(g('eAttend')),
    mgmtBonus: isPart ? 0 : n(g('eMgmt')),
    laborAllowance: isPart ? 0 : n(g('eLaborAllow')),
    performance: isPart ? 0 : n(g('ePerf')),
    otherBonus: isPart ? 0 : n(g('eOther')),
    otHours: isPart ? 0 : n(g('eOtHours')),
    lateMinutes: isPart ? 0 : n(g('eLateMin')),
    wage: isPart ? (n(g('eWage')) || DEFAULT_WAGE) : 0,
    personalSickLeave: Math.abs(n(isPart ? g('eSickP') : g('eSick'))),
    laborPension: n(g('ePension')),
    otherDeduction: n(g('eOtherDed')),
    ...gradeFields(),
  };
  sheet.employees = sheet.employees || [];
  if (editingEmpId) {
    const i = sheet.employees.findIndex(x => x.id === editingEmpId);
    if (i >= 0) sheet.employees[i] = { ...sheet.employees[i], ...data };
  } else {
    data.id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    sheet.employees.push(data);
  }
  closeEmpEdit(); renderEmps(); markDirty();
}

/**
 * 由投保級距換算出要存的保費欄位。
 * ⚠️ 保費一律由級距帶入、不開放手填 —— 與薪資系統同一個規矩，
 *    避免「級距選 A、金額卻是 B」這種對不起來又查不出原因的資料。
 */
function gradeFields() {
  const v = document.getElementById('eGrade').value;
  const depCount = Math.max(0, Math.round(n(document.getElementById('eDepCount').value)));
  const noHealth = document.getElementById('eHealthUninsured').checked;
  const base = {
    insuranceGrade: v === '' ? null : parseInt(v, 10),
    dependentCount: depCount, healthUninsured: noHealth,
    laborInsurance: 0, healthInsurance: 0, dependentInsurance: 0,
    laborEr: 0, healthEr: 0, pensionEr: 0,
  };
  if (v === '' || v === '-1') return base;
  const g = (insuranceGrades?.grades || [])[parseInt(v, 10)];
  if (!g) return base;
  const health = noHealth ? 0 : n(g.healthEmp);
  return {
    ...base,
    laborInsurance: n(g.laborEmp),
    healthInsurance: health,
    dependentInsurance: health * depCount,
    laborEr: n(g.laborEr),
    healthEr: noHealth ? 0 : n(g.healthEr),
    pensionEr: n(g.pension),
  };
}

function deleteEmp() {
  if (!canEditSheet()) { toast('唯讀模式'); return; }
  if (!editingEmpId) return;
  const e = (sheet.employees || []).find(x => x.id === editingEmpId);
  if (!confirm(`刪除「${e?.name || ''}」？此人的排班與出勤時間也會一併清除。`)) return;
  sheet.employees = (sheet.employees || []).filter(x => x.id !== editingEmpId);
  Object.keys(sheet.schedule || {}).forEach(d => { if (sheet.schedule[d]) delete sheet.schedule[d][editingEmpId]; });
  Object.keys(sheet.punches || {}).forEach(d => { if (sheet.punches[d]) delete sheet.punches[d][editingEmpId]; });
  closeEmpEdit(); renderEmps(); markDirty();
}

// ===== 排班涵蓋範圍 =====
// ⚠️ 輪班表期間（往前 4~8 週）與薪資／出勤月份（上個月）常常不重疊：
//    9/20 盤點 → 輪班表 8/17~9/13、出勤表整個 8 月，8/1~8/16 不在輪班期間內。
//    所以排班必須填「兩者的聯集」，否則出勤記錄表與薪資會有整段沒有班的空窗。
function scopeBounds() {
  const md = monthDays(sheet.salaryMonth);
  const lo = sheet.rangeStart < md[0] ? sheet.rangeStart : md[0];
  const hiRaw = sheet.rangeEnd > md[md.length - 1] ? sheet.rangeEnd : md[md.length - 1];
  // 補滿整週（週一～週日）才畫得出七欄表格
  const start = mondayOf(lo);
  const end = shiftDateAdd(mondayOf(hiRaw), 6);
  return { start, end };
}
const inShiftRange = d => d >= sheet.rangeStart && d <= sheet.rangeEnd;
const inSalaryMonth = d => d.slice(0, 7) === sheet.salaryMonth;
const inScope = d => inShiftRange(d) || inSalaryMonth(d);

/**
 * 盤點日改變時，把既有的班表與出勤時間一起平移。
 *
 * ⚠️ 這裡原本是「把範圍外的資料刪掉」，改掉了：一鍵複製出來的複本沿用原日期，
 *    使用者接著改盤點日就會把整份班表清光，複製等於白做。
 *    現在改成問要不要平移；不平移就原樣留著（範圍外的資料不會被印出來，留著無害）。
 * ⚠️ 只在差距是整數週時才提議平移——班表是照週一~週日排的，
 *    差幾天的平移會讓每個人的星期幾整排錯位。
 */
function offerShiftDates(oldAudit, newAudit) {
  const days = Math.round((parseD(mondayOf(newAudit)) - parseD(mondayOf(oldAudit))) / 86400000);
  if (!days || days % 7 !== 0) return false;
  const hasData = Object.keys(sheet.schedule || {}).length > 0;
  if (!hasData) return false;
  const wk = Math.abs(days / 7);
  const dir = days > 0 ? '往後' : '往前';
  if (!confirm(`盤點日${dir}移了 ${wk} 週。\n要把現有的班表與出勤時間一起${dir}平移 ${wk} 週嗎？\n\n（按取消＝資料留在原本的日期上）`)) return false;
  const shiftMap = m => {
    const out = {};
    Object.keys(m || {}).forEach(dt => { out[shiftDateAdd(dt, days)] = m[dt]; });
    return out;
  };
  sheet.schedule = shiftMap(sheet.schedule);
  sheet.punches = shiftMap(sheet.punches);
  toast(`班表與出勤時間已${dir}平移 ${wk} 週`);
  return true;
}

/**
 * 該月的週六、週日天數 —— 排班時的例假／休息日基準。
 * 與 salary-page.js 的 getMonthWeekendDays 同一個算法。
 */
function monthWeekendDays(ym) {
  let sat = 0, sun = 0;
  monthDays(ym).forEach(d => {
    const i = dayIdx(d);          // 0=週一 … 5=週六 6=週日
    if (i === 5) sat++;
    if (i === 6) sun++;
  });
  return { sat, sun, total: sat + sun };
}

/** 排班表上方的月份摘要：六日天數＋國定假日，讓店長排班時心裡有底 */
function renderMonthSummary() {
  const months = [];
  const b = scopeBounds();
  dateList(b.start, b.end).forEach(d => {
    if (!inScope(d)) return;
    const ym = d.slice(0, 7);
    if (!months.includes(ym)) months.push(ym);
  });
  const box = document.getElementById('monthSummary');
  if (!box) return;
  box.innerHTML = months.map(ym => {
    const w = monthWeekendDays(ym);
    const hols = monthDays(ym).filter(isHoliday);
    const isSalary = ym === sheet.salaryMonth;
    return `<div class="msum ${isSalary ? 'msum-main' : ''}">
      <b>${+ym.split('-')[1]} 月</b>
      <span>週六 <b>${w.sat}</b> 天・週日 <b>${w.sun}</b> 天＝<b>${w.total}</b> 天</span>
      <span>${hols.length ? `國假 ${hols.map(h => mdOf(h)).join('、')}` : '無國假'}</span>
      ${isSalary ? '<span class="msum-tag">出勤／薪資月</span>' : ''}
    </div>`;
  }).join('');
}

// ===== 排班檢查（勞基法）=====
// 語意與排班頁 schedule-v2-page.js 的軟擋一致：
//   §34 輪班間隔 11 小時（只算「跨工作日」的休息，同日兩頭班由當日工時把關）
//   §36 七休一（連續出勤 7 天）
//   休假日數＝當月週六＋週日天數（正職的例假／休息日基準，與薪資頁 getMonthWeekendDays 同源）
// ⚠️ 這裡是「整份掃一遍」，不是編輯當下的單格檢查，所以連續天數可以跨週正確計算
//    （排班頁那支為了即時性只看本週，跨週的連續出勤看不到）。

function MIN_REST_H() { return 11; }
function MAX_CONSECUTIVE_DAYS() { return 6; }   // 第 7 天就違反七休一

/** 某人在某日是否有實際工作的班（休假／空白／非時間班別都不算） */
function worksOn(emp, d) {
  const v = (sheet.schedule[d] || {})[emp.id];
  return !!(v && v !== OFF && shiftTotalHours(v) > 0);
}

/** 掃描範圍：排班涵蓋的所有日子（輪班期間 ∪ 薪資月份） */
function checkDates() {
  const b = scopeBounds();
  return dateList(b.start, b.end).filter(inScope);
}

/** ① 正職休假日數是否等於當月六日天數（只檢查完整涵蓋在範圍內的月份） */
function checkOffDays(emp) {
  if (emp.role === '工讀') return [];       // 工讀不適用月休基準
  const dates = checkDates();
  const inSet = new Set(dates);
  const months = [...new Set(dates.map(d => d.slice(0, 7)))];
  const out = [];
  months.forEach(ym => {
    const days = monthDays(ym);
    if (!days.every(d => inSet.has(d))) return;          // 月份沒填滿就不比，否則一定是假警報
    const off = days.filter(d => (sheet.schedule[d] || {})[emp.id] === OFF).length;
    const blank = days.filter(d => !(sheet.schedule[d] || {})[emp.id]).length;
    const need = monthWeekendDays(ym).total;
    const m = +ym.split('-')[1];
    if (blank) {
      out.push({ level: 'warn', rule: 'offDays', emp: emp.name,
        msg: `${m} 月還有 ${blank} 天沒排，休假日數還算不準（目前休 ${off} 天／應休 ${need} 天）` });
    } else if (off !== need) {
      const diff = off - need;
      out.push({ level: 'error', rule: 'offDays', emp: emp.name,
        msg: `${m} 月休假 ${off} 天，與當月六日天數 ${need} 天${diff > 0 ? `不符（多休 ${diff} 天）` : `不符（少休 ${-diff} 天）`}` });
    }
  });
  return out;
}

/** ② 連續上班天數（達 7 天即違反七休一） */
function checkConsecutive(emp) {
  const dates = checkDates();
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > MAX_CONSECUTIVE_DAYS()) {
      out.push({ level: 'error', rule: 'consecutive', emp: emp.name,
        msg: `${mdOf(run[0])}~${mdOf(run[run.length - 1])} 連續上班 ${run.length} 天（七休一）` });
    }
    run = [];
  };
  dates.forEach((d, i) => {
    // 日期不連續（範圍有斷）也要把目前這串收掉，不能誤接成一長串
    if (i > 0 && d !== shiftDateAdd(dates[i - 1], 1)) flush();
    if (worksOn(emp, d)) run.push(d); else flush();
  });
  flush();
  return out;
}

/** ③ 前後班休息時間是否 ≥ 11 小時 */
function checkRestGaps(emp) {
  const dates = checkDates().filter(d => worksOn(emp, d));
  const out = [];
  for (let i = 1; i < dates.length; i++) {
    const prevD = dates[i - 1], curD = dates[i];
    const prevS = shiftSpan((sheet.schedule[prevD] || {})[emp.id]);
    const curS = shiftSpan((sheet.schedule[curD] || {})[emp.id]);
    if (!prevS || !curS) continue;
    // 跨夜班的 endH 會 > 24，shiftTimeMs 直接吃得下，不必自己加一天
    const gap = (shiftTimeMs(curD, curS.startH) - shiftTimeMs(prevD, prevS.endH)) / 3600000;
    if (gap >= MIN_REST_H()) continue;
    const g = Math.round(gap * 10) / 10;
    // ⚠️ 間隔剛好 0 是「下班後直接接下一班」，不是時間重疊；兩者在勞檢上的說法不一樣，不能混著寫
    const msg = g < 0
      ? `${mdOf(prevD)} 的班還沒下班，${mdOf(curD)} 的班就開始了（時間重疊 ${-g} 小時）`
      : g === 0
        ? `${mdOf(prevD)} 下班後直接接 ${mdOf(curD)} 的班（中間 0 小時休息）`
        : `${mdOf(prevD)} → ${mdOf(curD)} 只隔 ${g} 小時（未達 11 小時休息）`;
    out.push({ level: 'error', rule: 'rest11h', emp: emp.name, msg });
  }
  return out;
}

/** 三項一起跑，依人分組 */
function runComplianceChecks() {
  const out = [];
  (sheet.employees || []).forEach(e => {
    out.push(...checkOffDays(e), ...checkConsecutive(e), ...checkRestGaps(e));
  });
  return out;
}

function renderCompliancePanel() {
  const box = document.getElementById('lawCheck');
  if (!box) return;
  if (!(sheet.employees || []).length) { box.innerHTML = ''; return; }
  const issues = runComplianceChecks();
  if (!issues.length) {
    box.innerHTML = `<div class="law-ok">✅ 檢查通過：休假日數、七休一、輪班間隔 11 小時都沒問題</div>`;
    return;
  }
  const errs = issues.filter(i => i.level === 'error');
  const byEmp = {};
  issues.forEach(i => { (byEmp[i.emp] = byEmp[i.emp] || []).push(i); });
  box.innerHTML = `<div class="law-box">
    <div class="law-title">⚠️ 排班檢查：${errs.length} 項不符${issues.length - errs.length ? `、${issues.length - errs.length} 項待確認` : ''}</div>
    ${Object.entries(byEmp).map(([nm, list]) => `
      <div class="law-emp"><b>${esc(nm)}</b>
        ${list.map(i => `<div class="law-item ${i.level}">・${esc(i.msg)}</div>`).join('')}
      </div>`).join('')}
    <div class="law-foot">檢查項目：正職休假日數＝當月六日天數、連續上班不得達 7 天、前後班休息 ≥ 11 小時</div>
  </div>`;
}

// ===== 步驟 3：排班 =====
function renderSchedule() {
  renderMonthSummary();
  renderCompliancePanel();
  const emps = sheet.employees || [];
  const wrap = document.getElementById('schedWrap');
  if (!emps.length) { wrap.innerHTML = '<div class="empty">請先到「② 人員」新增被盤點人員</div>'; return; }
  const b = scopeBounds();
  const opts = ['', ...shiftOptions, OFF];
  let html = '';
  weekBlocks(b.start, b.end).forEach((week, wi) => {
    const used = week.some(inScope);
    if (!used) return;
    const tag = week.every(inShiftRange) ? '輪班表'
      : week.some(inShiftRange) ? '輪班表（部分）'
        : '出勤／薪資月';
    html += `<div class="week-block">
      <div class="week-head">${mdOf(week[0])} ~ ${mdOf(week[6])}　<span style="color:#64748b;font-weight:600;">${tag}</span>
        ${wi > 0 ? `<button class="btn-mini" style="margin-left:8px;padding:4px 9px;" onclick="copyPrevWeek('${week[0]}')">複製上一週</button>` : ''}
      </div>
      <div class="sched-scroll"><table class="sched"><tr><th style="min-width:86px;">姓名</th>
      ${week.map(d => `<th class="${isHoliday(d) ? 'hol' : ''}">${mdOf(d)}<br>${DAY_NAMES[dayIdx(d)].slice(1)}${isHoliday(d) ? '<br>國假' : ''}</th>`).join('')}
      <th style="min-width:92px;">整週填入</th></tr>`;
    emps.forEach(e => {
      const worked = week.filter(d => { const s = (sheet.schedule[d] || {})[e.id]; return s && s !== OFF && shiftTotalHours(s) > 0; }).length;
      const warn = worked >= 7 ? ' <span style="color:#c5221f;">⚠ 無休</span>' : '';
      html += `<tr><td class="namecol">${esc(e.name)}${warn}</td>`;
      week.forEach(d => {
        const v = (sheet.schedule[d] || {})[e.id] || '';
        const cls = v === OFF ? 'off' : v ? 'has' : '';
        const dim = inScope(d) ? '' : ' style="opacity:.45;"';
        html += `<td${dim}><select class="${cls}" onchange="setShift('${d}','${e.id}',this.value)">
          ${opts.map(o => `<option value="${o}"${o === v ? ' selected' : ''}>${o || '—'}</option>`).join('')}
        </select></td>`;
      });
      html += `<td><select onchange="fillWeek('${week[0]}','${e.id}',this.value);this.value='';">
        ${['', ...shiftOptions, OFF].map(o => `<option value="${o}">${o || '—'}</option>`).join('')}
      </select></td></tr>`;
    });
    html += '</table></div></div>';
  });
  wrap.innerHTML = html;
}

function setShift(date, empId, val) {
  if (!canEditSheet()) return;
  sheet.schedule = sheet.schedule || {};
  sheet.schedule[date] = sheet.schedule[date] || {};
  if (!val) delete sheet.schedule[date][empId];
  else sheet.schedule[date][empId] = val;
  if (!Object.keys(sheet.schedule[date]).length) delete sheet.schedule[date];
  // 班別變了，原本填的簽到／簽退就不屬於這個班了 → 清掉，避免印出 23-07 的班配 15:00 的簽到
  if (sheet.punches[date] && sheet.punches[date][empId]) {
    delete sheet.punches[date][empId];
    if (!Object.keys(sheet.punches[date]).length) delete sheet.punches[date];
  }
  markDirty();
  renderSchedule();
}

function fillWeek(weekStart, empId, val) {
  if (!canEditSheet()) return;
  if (!val) return;
  dateList(weekStart, shiftDateAdd(weekStart, 6)).forEach(d => {
    if (!inScope(d)) return;
    sheet.schedule[d] = sheet.schedule[d] || {};
    sheet.schedule[d][empId] = val;
    if (sheet.punches[d]) delete sheet.punches[d][empId];
  });
  markDirty(); renderSchedule();
}

function copyPrevWeek(weekStart) {
  if (!canEditSheet()) return;
  const prev = shiftDateAdd(weekStart, -7);
  let cnt = 0;
  for (let i = 0; i < 7; i++) {
    const src = shiftDateAdd(prev, i), dst = shiftDateAdd(weekStart, i);
    if (!inScope(dst)) continue;
    const row = sheet.schedule[src];
    if (!row) continue;
    sheet.schedule[dst] = { ...row };
    if (sheet.punches[dst]) delete sheet.punches[dst];
    cnt++;
  }
  markDirty(); renderSchedule();
  toast(cnt ? `已複製 ${cnt} 天` : '上一週沒有排班可複製');
}

function clearSchedule() {
  if (!canEditSheet()) return;
  if (!confirm('清空這份盤點的所有排班與已填的出勤時間？')) return;
  sheet.schedule = {}; sheet.punches = {};
  markDirty(); renderSchedule();
}

// ===== 步驟 4：出勤時間（人工填寫）=====
function renderPunchEmpSelect() {
  const sel = document.getElementById('fPunchEmp');
  const emps = sheet.employees || [];
  const keep = sel.value;
  sel.innerHTML = emps.map(e => `<option value="${e.id}">${esc(e.name)}（${e.role}）</option>`).join('');
  if (emps.some(e => e.id === keep)) sel.value = keep;
}

/** 該員在薪資月份內有班的日子（盤點當日不列） */
function punchRows(empId) {
  return monthDays(sheet.salaryMonth).map(d => {
    const sh = (sheet.schedule[d] || {})[empId] || '';
    return { date: d, shift: sh, isAudit: d === sheet.auditDate, hours: shiftTotalHours(sh) };
  });
}

function renderPunch() {
  const empId = document.getElementById('fPunchEmp').value;
  const wrap = document.getElementById('punchWrap');
  const bulk = document.getElementById('bulkRow');
  if (!empId) { wrap.innerHTML = '<div class="empty">請先新增人員</div>'; bulk.innerHTML = ''; return; }
  const rows = punchRows(empId);
  const workRows = rows.filter(r => r.hours > 0 && !r.isAudit);

bulk.innerHTML = workRows.length ? `
    <div class="bulk-box">
      <div class="bulk-line">
        <span class="bulk-label">帶入小時</span>
        <button class="btn-mini" onclick="fillShiftHours('')">🕐 依班別帶入（${workRows.length} 天）</button>
      </div>
      <div class="bulk-line"><span class="bulk-hint">按班別帶入「小時」後，分鐘逐日自己填（例：14:<b>52</b>）。已填的小時不會被覆蓋。</span></div>
      <div class="bulk-line">
        <span class="bulk-label">勾選套用</span>
        <button class="btn-mini" onclick="checkAll('in',true)">全選簽到</button>
        <button class="btn-mini" onclick="checkAll('out',true)">全選簽退</button>
        <button class="btn-mini danger" onclick="checkAll('in',false);checkAll('out',false)">取消</button>
        <input type="text" inputmode="numeric" maxlength="2" id="bkH" placeholder="時">
        <span class="colon">:</span>
        <input type="text" inputmode="numeric" maxlength="2" id="bkM" placeholder="分">
        <button class="btn-mini" onclick="applyChecked('in')">→ 簽到（<span id="cntIn">0</span>）</button>
        <button class="btn-mini" onclick="applyChecked('out')">→ 簽退（<span id="cntOut">0</span>）</button>
      </div>

      <!-- ==== 新增的隨機分鐘區塊 ==== -->
      <div class="bulk-line">
        <span class="bulk-label">隨機分鐘</span>
        <button class="btn-mini" onclick="applyRandomMinutes('in')">🎲 簽到 (51-59)</button>
        <button class="btn-mini" onclick="applyRandomMinutes('out')">🎲 簽退 (01-09)</button>
      </div>
      <!-- ============================ -->

      <div class="bulk-line">
        <button class="btn-mini danger" onclick="clearPunch('${empId}')">清空此人本月已填時間</button>
      </div>
    </div>` : '';

  const filled = workRows.filter(r => {
    const p = (sheet.punches[r.date] || {})[empId] || {};
    return punchTime(p, 'in') && punchTime(p, 'out');
  }).length;
  let html = `<div class="punch-sum">已填完整 ${filled} / ${workRows.length} 天${filled < workRows.length ? '（缺的在出勤記錄表上會留空）' : ' ✓'}</div>`;
  html += `<div class="punch-scroll"><table class="punch"><tr>
    <th style="width:50px;">日期</th><th style="width:32px;">星期</th><th style="width:58px;">班別</th>
    <th style="width:24px;">☑</th><th style="width:104px;">簽到</th>
    <th style="width:24px;">☑</th><th style="width:104px;">簽退</th></tr>`;
  rows.forEach(r => {
    const p = (sheet.punches[r.date] || {})[empId] || {};
    const wd = DAY_NAMES[dayIdx(r.date)].slice(1);
    if (r.isAudit) {
      html += `<tr class="off"><td class="d">${mdOf(r.date)}</td><td>${wd}</td><td colspan="5">盤點日，不列出勤紀錄</td></tr>`;
      return;
    }
    if (!r.hours) {
      html += `<tr class="off"><td class="d">${mdOf(r.date)}</td><td>${wd}</td><td colspan="5">${r.shift === OFF ? OFF : '未排班'}</td></tr>`;
      return;
    }
    const over = shiftIsOvernight(r.shift);
    const cell = key => {
      const h = punchPart(p, key, 'H'), m = punchPart(p, key, 'M');
      const done = h !== '' && m !== '';
      // ⚠️「次日」要放在 td 裡面：直接掛在 tr 底下，瀏覽器會把它提到表格外變成一排飄浮文字
      const tag = (key === 'out' && over) ? '<div class="nextday">次日</div>' : '';
      return `<td class="tcell ${done ? 'done' : ''}">
        <div class="tline">
          <input type="text" inputmode="numeric" maxlength="2" class="hh" placeholder="--" value="${h}"
            onchange="setPunchPart('${r.date}','${empId}','${key}','H',this.value)">
          <span class="colon">:</span>
          <input type="text" inputmode="numeric" maxlength="2" class="mm" placeholder="--" value="${m}"
            onchange="setPunchPart('${r.date}','${empId}','${key}','M',this.value)">
        </div>${tag}
      </td>`;
    };
    html += `<tr class="${isHoliday(r.date) ? 'hol' : ''}" data-shift="${r.shift}">
      <td class="d">${mdOf(r.date)}</td><td>${wd}</td>
      <td>${r.shift}${isHoliday(r.date) ? '<br><span style="color:#c5221f;font-size:10px;">國假</span>' : ''}</td>
      <td><input type="checkbox" class="pk pk-in" data-date="${r.date}" onchange="updateCounts()"></td>
      ${cell('in')}
      <td><input type="checkbox" class="pk pk-out" data-date="${r.date}" onchange="updateCounts()"></td>
      ${cell('out')}</tr>`;
  });
  html += '</table></div>';
  wrap.innerHTML = html;
  updateCounts();
  applyReadonlyUI();
}

function updateCounts() {
  ['in', 'out'].forEach(k => {
    const el = document.getElementById('cnt' + (k === 'in' ? 'In' : 'Out'));
    if (el) el.textContent = document.querySelectorAll('.pk-' + k + ':checked').length;
  });
}
function checkAll(kind, on) {
  document.querySelectorAll('.pk-' + kind).forEach(c => { c.checked = on; });
  updateCounts();
}

/**
 * 依班別帶入「小時」（分鐘不動）。
 * shift 給空字串＝所有班別一起帶。
 * ⚠️ 已經填過的小時不覆蓋——不然手動改過的例外會被一鍵洗掉。
 */
function fillShiftHours(shift) {
  if (!canEditSheet()) return;
  const empId = document.getElementById('fPunchEmp').value;
  let cnt = 0;
  punchRows(empId).forEach(r => {
    if (r.isAudit || !r.hours) return;
    if (shift && r.shift !== shift) return;
    const dh = shiftDefaultHours(r.shift);
    if (!dh) return;
    const p = (sheet.punches[r.date] || {})[empId] || {};
    if (punchPart(p, 'in', 'H') === '') { setPunchPart(r.date, empId, 'in', 'H', dh.inH); cnt++; }
    if (punchPart(p, 'out', 'H') === '') { setPunchPart(r.date, empId, 'out', 'H', dh.outH); }
  });
  renderPunch();
  toast(cnt ? `已帶入 ${cnt} 天的小時，分鐘請逐日填` : '這些日子的小時都填過了');
}

/**
 * 把指定的時／分套到已勾選的那幾格。
 * 時與分可以只填一個（例如整批只要改小時，分鐘維持逐日手填）。
 */
function applyChecked(kind) {
  if (!canEditSheet()) return;
  const empId = document.getElementById('fPunchEmp').value;
  const hRaw = document.getElementById('bkH').value.trim();
  const mRaw = document.getElementById('bkM').value.trim();
  if (hRaw === '' && mRaw === '') { toast('請先填要套用的時或分'); return; }
  const h = hRaw === '' ? null : parseInt(hRaw.replace(/[^0-9]/g, ''), 10);
  const m = mRaw === '' ? null : parseInt(mRaw.replace(/[^0-9]/g, ''), 10);
  if (h !== null && !(h >= 0 && h <= 23)) { toast('小時請填 0~23'); return; }
  if (m !== null && !(m >= 0 && m <= 59)) { toast('分鐘請填 0~59'); return; }
  const picked = [...document.querySelectorAll('.pk-' + kind + ':checked')].map(c => c.getAttribute('data-date'));
  if (!picked.length) { toast('請先勾選要填入的日期'); return; }
  picked.forEach(d => {
    if (h !== null) setPunchPart(d, empId, kind, 'H', h);
    if (m !== null) setPunchPart(d, empId, kind, 'M', m);
  });
  renderPunch();
  const what = (h !== null && m !== null) ? '時間' : (h !== null ? '小時' : '分鐘');
  toast(`已套用 ${picked.length} 天的${kind === 'in' ? '簽到' : '簽退'}${what}`);
}

/**
 * 隨機產生分鐘數並套用到已勾選的格子
 * 簽到 (in): 51~59
 * 簽退 (out): 01~09
 */
function applyRandomMinutes(kind) {
  if (!canEditSheet()) return;
  const empId = document.getElementById('fPunchEmp').value;
  const picked = [...document.querySelectorAll('.pk-' + kind + ':checked')].map(c => c.getAttribute('data-date'));
  if (!picked.length) { toast('請先勾選要填入的日期'); return; }

  picked.forEach(d => {
    // 簽到：產生 51~59 的亂數 (Math.random() * 9 會產生 0~8，加 51 變為 51~59)
    // 簽退：產生 1~9 的亂數 (Math.random() * 9 會產生 0~8，加 1 變為 1~9)
    const randomM = kind === 'in' 
      ? Math.floor(Math.random() * 9) + 51 
      : Math.floor(Math.random() * 9) + 1;
      
    // 呼叫原本的 setPunchPart 將產生的分鐘寫入該格
    setPunchPart(d, empId, kind, 'M', randomM);
  });
  
  // 重新渲染畫面並提示
  renderPunch();
  toast(`已套用 ${picked.length} 天的${kind === 'in' ? '簽到' : '簽退'}隨機分鐘`);
}

/** 寫入單一格（時或分）；超出範圍就清掉並提示 */
function setPunchPart(date, empId, key, part, raw) {
  if (!canEditSheet()) return;
  const str = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
  let v = '';
  if (str !== '') {
    const num = parseInt(str, 10);
    const max = part === 'H' ? 23 : 59;
    if (isFinite(num) && num >= 0 && num <= max) v = num;
    else toast(part === 'H' ? '小時請填 0~23' : '分鐘請填 0~59');
  }
  sheet.punches = sheet.punches || {};
  sheet.punches[date] = sheet.punches[date] || {};
  const rec = sheet.punches[date][empId] || {};
  // 舊格式（'HH:MM'）碰到就地拆成時分，之後一律用新格式
  if (rec[key]) {
    const parts = String(rec[key]).split(':');
    rec[key + 'H'] = parseInt(parts[0], 10);
    rec[key + 'M'] = parseInt(parts[1], 10);
    delete rec[key];
  }
  if (v === '') delete rec[key + part]; else rec[key + part] = v;
  sheet.punches[date][empId] = rec;
  if (!Object.keys(rec).length) delete sheet.punches[date][empId];
  if (!Object.keys(sheet.punches[date]).length) delete sheet.punches[date];
  markDirty();
}

function clearPunch(empId) {
  if (!canEditSheet()) return;
  if (!confirm('清空此人本月已填的簽到／簽退時間？')) return;
  Object.keys(sheet.punches || {}).forEach(d => {
    if (sheet.punches[d] && sheet.punches[d][empId]) {
      delete sheet.punches[d][empId];
      if (!Object.keys(sheet.punches[d]).length) delete sheet.punches[d];
    }
  });
  markDirty(); renderPunch();
}

/**
 * 打卡時間的存法：時與分分開存（inH/inM、outH/outM）。
 * 「小時」由班別帶入、「分鐘」一律人工填，所以兩者會分別存在、也可能只填一半。
 * ⚠️ 相容舊資料：先前存成 {in:'14:52'} 的照樣讀得出來。
 */
function punchTime(p, key) {
  if (!p) return '';
  if (p[key]) return p[key];                       // 舊格式 'HH:MM'
  const h = p[key + 'H'], m = p[key + 'M'];
  if (h === '' || h == null || m === '' || m == null) return '';
  return pad(h) + ':' + pad(m);
}
function punchPart(p, key, part) {
  if (!p) return '';
  if (p[key]) return p[key].split(':')[part === 'H' ? 0 : 1] || '';
  const v = p[key + part];
  return (v === '' || v == null) ? '' : pad(v);
}

/**
 * 班別 → 預設的簽到／簽退「小時」
 * 簽到取上班前一小時（例 15-23 → 14 點，人通常提早到），簽退取下班時刻（23 點）。
 * 只帶小時，分鐘一律人工填。跨夜與半點班一樣適用（23.5-07.5 → 22 / 07）。
 */
function shiftDefaultHours(shift) {
  const sp = shiftSpan(shift);
  if (!sp) return null;
  return { inH: (Math.floor(sp.startH) + 23) % 24, outH: Math.floor(sp.endH) % 24 };
}

// ===== 工時與薪資計算 =====
const toMin = t => { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };

/**
 * 某人某日的工時
 * 有填簽到＋簽退 → 依實際時間；沒填 → 依排定班別。
 * 兩份文件共用同一個基準，出勤記錄表與薪資單才不會互相矛盾。
 */
function dayHours(emp, d) {
  const sh = (sheet.schedule[d] || {})[emp.id] || '';
  if (!sh || sh === OFF || d === sheet.auditDate) return { shift: sh, sched: 0, actual: null, eff: 0 };
  const sched = shiftTotalHours(sh);
  if (!sched) return { shift: sh, sched: 0, actual: null, eff: 0 };
  const p = (sheet.punches[d] || {})[emp.id] || {};
  const tIn = punchTime(p, 'in'), tOut = punchTime(p, 'out');
  let actual = null;
  if (tIn && tOut) {
    let mi = toMin(tIn), mo = toMin(tOut);

    // ==== 新增：前後 15 分鐘緩衝判定 ====
    const sp = shiftSpan(sh);
    if (sp) {
      // 取得排定的簽到與簽退分鐘數 (shiftSpan 已處理跨夜，如 23-07 的 endH 會是 31)
      let sIn = sp.startH * 60;
      let sOut = sp.endH * 60;
      
      // 檢查實際簽到是否在緩衝內 (考量跨日的 24 小時循環)
      const diffIn = Math.min(Math.abs(mi - (sIn % 1440)), 1440 - Math.abs(mi - (sIn % 1440)));
      if (diffIn <= 15) mi = sIn; // 若在 15 分鐘內，計薪起點以排定時間為準
      
      // 檢查實際簽退是否在緩衝內
      const diffOut = Math.min(Math.abs(mo - (sOut % 1440)), 1440 - Math.abs(mo - (sOut % 1440)));
      if (diffOut <= 15) mo = sOut; // 若在 15 分鐘內，計薪終點以排定時間為準
    }
    // ===================================

    if (mo <= mi) mo += 1440;                     // 跨夜：下班落在隔天
    
    // ⚠️ 零頭未滿半小時一律捨去（無條件捨去到 0.5）：22:52~07:05 算 8.0 不是 8.22。
    //    捨去而不是四捨五入 —— 工時是計薪基準，寧可少算也不要算出沒做滿的時數。
    //    出勤記錄表與薪資單共用這個值，兩張紙才對得起來。
    actual = Math.floor((mo - mi) / 60 * 2) / 2;
  }
  return { shift: sh, sched, actual, eff: actual == null ? sched : actual };
}

/** 薪資月份的工時統計（盤點當日不計，與出勤記錄表一致） */
function monthStat(emp) {
  let hours = 0, holHours = 0, holDays = 0, workDays = 0, unfilled = 0;
  monthDays(sheet.salaryMonth).forEach(d => {
    const h = dayHours(emp, d);
    if (!h.eff) return;
    workDays++; hours += h.eff;
    if (h.actual == null) unfilled++;
    if (isHoliday(d)) { holDays++; holHours += h.eff; }
  });
  return { hours: Math.round(hours * 100) / 100, holHours: Math.round(holHours * 100) / 100, holDays, workDays, unfilled };
}

/**
 * 薪資計算
 * 正職：經常性給與 ＋ 國假出勤加發一日工資 ＋ 加班費 − 遲到 − 事病假
 *       一日工資＝(底薪＋全勤＋其他津貼)/30（與 salary-calc.js 的 hourlyRate 同一基準）
 * 工讀：時薪 × 工時 ＋ 時薪 × 國假工時（加給 1 倍）− 事病假
 */
function calcPay(emp) {
  const st = monthStat(emp);
  const deduct = n(emp.laborInsurance) + n(emp.healthInsurance) + n(emp.dependentInsurance)
    + n(emp.laborPension) + n(emp.otherDeduction);
  const sick = Math.abs(n(emp.personalSickLeave));

  if (emp.role === '工讀') {
    const wage = n(emp.wage) || DEFAULT_WAGE;
    const basePay = Math.round(wage * st.hours);
    const holPay = Math.round(wage * st.holHours);
    const gross = Math.max(0, basePay + holPay - sick);
    return { ...st, isPart: true, wage, basePay, holPay, otPay: 0, lateDed: 0, sick, gross, deduct,
      net: gross - deduct, comp: n(emp.pensionEr), dayWage: 0, rph: wage };
  }
  const base = n(emp.baseSalary), attend = n(emp.fullAttendBonus), other = n(emp.otherBonus);
  const mgmt = n(emp.mgmtBonus), la = n(emp.laborAllowance), perf = n(emp.performance);
  const recur = base + attend + mgmt + la + perf + other;
  const rph = (base + attend + other) / 30 / 8;
  const dayWage = Math.round((base + attend + other) / 30);
  const holPay = dayWage * st.holDays;
  const otPay = Math.ceil(Math.ceil(rph) * 1.34 * n(emp.otHours));
  const lateDed = Math.round(rph / 60 * n(emp.lateMinutes));
  const gross = Math.max(0, recur + holPay + otPay - lateDed - sick);
  // 公司提撥：選了級距就用級距的雇主提撥（與薪資系統帶入的一致），否則退回 (底薪+全勤)×6%
  const comp = n(emp.pensionEr) || Math.round((base + attend) * 0.06);
  return { ...st, isPart: false, basePay: base, holPay, otPay, lateDed, sick, gross, deduct, net: gross - deduct, comp, dayWage, rph };
}

// ===== 步驟 5：產出前檢查 =====
function renderReady() {
  const emps = sheet.employees || [];
  const items = [];
  const ok = (t) => items.push(`<div class="ready-item"><span class="ready-ok">✓</span><span>${t}</span></div>`);
  const no = (t) => items.push(`<div class="ready-item"><span class="ready-no">✕</span><span>${t}</span></div>`);

  sheet.storeName ? ok(`門市名稱：${esc(sheet.storeName)}`) : no('尚未填門市名稱');
  emps.length ? ok(`人員 ${emps.length} 人`) : no('尚未新增人員');

  // 輪班表期間的排班覆蓋率
  const rDays = dateList(sheet.rangeStart, sheet.rangeEnd);
  let blank = 0;
  rDays.forEach(d => emps.forEach(e => { if (!(sheet.schedule[d] || {})[e.id]) blank++; }));
  blank ? no(`輪班表期間有 ${blank} 格未填（空白格會印成空白）`) : ok('輪班表期間已填滿');

  // 出勤時間填寫率
  let need = 0, filled = 0;
  monthDays(sheet.salaryMonth).forEach(d => emps.forEach(e => {
    const h = dayHours(e, d);
    if (!h.eff) return;
    need++;
    const p = (sheet.punches[d] || {})[e.id] || {};
    if (punchTime(p, 'in') && punchTime(p, 'out')) filled++;
  }));
  need === 0 ? no('薪資月份內沒有任何排班') :
    filled === need ? ok(`出勤時間已填 ${filled}/${need} 天`)
      : no(`出勤時間已填 ${filled}/${need} 天，未填的會留空、工時改依排定班別計算`);

  // 連續 7 天無休提醒（勞基法 §36 七休一）
  const warns = [];
  emps.forEach(e => {
    weekBlocks(mondayOf(sheet.rangeStart), sheet.rangeEnd).forEach(week => {
      if (!week.some(inShiftRange)) return;
      const w = week.filter(d => { const h = dayHours(e, d); return h.eff > 0; }).length;
      if (w >= 7) warns.push(`${e.name}（${mdOf(week[0])}~${mdOf(week[6])}）`);
    });
  });
  if (warns.length) items.push(`<div class="ready-item"><span class="ready-no">⚠</span><span>整週無休息日：${warns.map(esc).join('、')}</span></div>`);

  document.getElementById('readyBox').innerHTML = items.join('');

  // 國定假日出勤
  const hols = monthDays(sheet.salaryMonth).filter(isHoliday);
  const box = document.getElementById('holidayBox');
  if (!hols.length) {
    box.innerHTML = `<div class="hint">${sheet.salaryMonth} 沒有國定假日。假日表來源：${holidaySource === 'firestore' ? '系統設定' : holidaySource === 'mixed' ? '系統設定＋內建' : '內建表'}</div>`;
    return;
  }
  box.innerHTML = hols.map(d => {
    const who = emps.filter(e => dayHours(e, d).eff > 0).map(e => e.name);
    return `<div class="hol-chip ${who.length ? 'worked' : ''}">${mdOf(d)} ${holidayMap[d]}${who.length ? `：${esc(who.join('、'))} 出勤` : '：無人出勤'}</div>`;
  }).join('') + `<div class="hint" style="margin-top:6px;">有出勤者：正職加發一日工資、工讀加給 1 倍時薪（已自動算入薪資單）。<br>假日表來源：${holidaySource === 'firestore' ? '系統設定' : holidaySource === 'mixed' ? '系統設定＋內建' : '內建表（可至系統設定維護）'}</div>`;
}

// ===== PDF 預覽 =====
function openPdf(title, html) {
  document.getElementById('pdfTitle').textContent = title;
  document.getElementById('pdfPreviewBody').innerHTML = html;
  document.getElementById('pdfModal').classList.add('open');
}
function closePdf() {
  document.getElementById('pdfModal').classList.remove('open');
  document.getElementById('pdfPreviewBody').innerHTML = '';
}

function buildOutput(kind) {
  if (!sheet.storeName) { toast('請先填門市名稱'); gotoStep(1); return; }
  if (!(sheet.employees || []).length) { toast('請先新增人員'); gotoStep(2); return; }
  flushSave();
  if (kind === 'shift') openPdf('職員輪班表', buildShiftDoc());
  if (kind === 'attend') openPdf('出勤記錄表', buildAttendDoc());
  if (kind === 'salary') openPdf('薪資單', buildSalaryDoc());
}

// ── 職員輪班表（每週一張）──
// 直接用排班系統的產圖函式（schedule-draw.js），格式與莉學商行現行輪班表完全一致。
// ⚠️ 不要在這裡另外畫一份表：兩邊只要各寫一份，遲早長不一樣。
function buildShiftDoc() {
  const emps = (sheet.employees || []).map(e => ({ name: e.name }));
  return weekBlocks(sheet.rangeStart, sheet.rangeEnd).map(week => {
    // 組成產圖函式看得懂的 records（它以「姓名＋星期」對位）
    const records = [];
    (sheet.employees || []).forEach(e => {
      week.forEach(d => {
        const v = (sheet.schedule[d] || {})[e.id];
        if (!v) return;
        records.push({
          name: e.name,
          day: DAY_NAMES[dayIdx(d)],
          // 盤點頁的休假只有一種，對應排班系統的「排休」（畫成粗體「休」）
          shift: v === OFF ? '排休' : v,
          actualHours: v === OFF ? 0 : shiftTotalHours(v),
        });
      });
    });
    const weekDates = week.map(mdOf);
    const canvas = document.createElement('canvas');
    drawScheduleCanvas(canvas, sheet.storeName, shiftWeekStr(week[0]), records, emps, weekDates, records);
    return `<div class="doc doc-shift"><img src="${canvas.toDataURL('image/png')}" style="width:100%;display:block;"></div>`;
  }).join('');
}

// ── 出勤記錄表（一人一張）──
function buildAttendDoc() {
  const [y, m] = sheet.salaryMonth.split('-').map(Number);
  return (sheet.employees || []).map(e => {
    const st = monthStat(e);
    const rows = monthDays(sheet.salaryMonth).map(d => {
      const wd = DAY_NAMES[dayIdx(d)];
      const dd = +d.split('-')[2];
      const holCls = isHoliday(d) ? ' class="hol"' : '';
      if (d === sheet.auditDate) return `<tr${holCls}><td>${dd}</td><td>${wd}</td><td colspan="5" class="off">—</td></tr>`;
      const h = dayHours(e, d);
      const sh = (sheet.schedule[d] || {})[e.id] || '';
      if (!h.eff) {
        return `<tr${holCls}><td>${dd}</td><td>${wd}</td><td class="off">${sh === OFF ? OFF : ''}</td><td class="off"></td><td class="off"></td><td class="off"></td><td>${isHoliday(d) ? holidayMap[d] : ''}</td></tr>`;
      }
      const p = (sheet.punches[d] || {})[e.id] || {};
      const tIn = punchTime(p, 'in'), tOut = punchTime(p, 'out');
      const over = shiftIsOvernight(sh);
      const notes = [];
      if (isHoliday(d)) notes.push(holidayMap[d] + '出勤');
      if (h.actual == null) notes.push('未填簽到／簽退，工時依排定班別');
      return `<tr${holCls}>
        <td>${dd}</td><td>${wd}</td><td>${sh}</td>
        <td>${tIn}</td>
        <td>${tOut ? tOut + (over ? '<span style="font-size:9.5px;">(次日)</span>' : '') : ''}</td>
        <td${h.actual == null ? ' style="color:#555;"' : ''}>${h.eff ? h.eff.toFixed(1) : ''}</td>
        <td style="font-size:10.5px;">${notes.join('；')}</td>
      </tr>`;
    }).join('');
    return `<div class="doc">
      <div class="doc-title">民國 ${rocOf(y)} 年 ${m} 月 出勤記錄表</div>
      <div class="doc-sub">${esc(sheet.storeName)}</div>
      <div class="doc-meta">
        <span>門市：<b>${esc(sheet.storeName)}</b></span>
        <span>姓名：<b>${esc(e.name)}</b></span>
        <span>職稱：<b>${e.role}</b></span>
      </div>
      <table class="doc-tbl">
        <tr><th style="width:34px;">日</th><th style="width:44px;">星期</th><th style="width:68px;">班別</th>
            <th style="width:76px;">簽到</th><th style="width:86px;">簽退</th><th style="width:52px;">工時</th><th style="width:200px;">備註</th></tr>
        ${rows}
      </table>
      <div class="doc-stat"><span>出勤天數：${st.workDays} 天</span><span>總工時：${st.hours.toFixed(1)} 小時</span>
        <span>國定假日出勤：${st.holDays} 天 / ${st.holHours.toFixed(1)} 小時</span></div>
      <div class="doc-foot"><div class="sign-line">員工簽名</div><div class="sign-line">店長</div></div>
    </div>`;
  }).join('');
}

// ── 薪資單（莉學商行格式：一張 A4 兩人）──
// 版面照 salary-page.js 的 buildAllPayslipsHtml / buildSinglePayslipHtml：
// 藍框半頁、姓名職稱表頭、三欄式（薪資考勤項目｜代扣項目｜考勤）、應發/代扣/實發、簽名確認框。
// ⚠️ 沒有照抄程式：那支相依於薪資頁的整頁狀態（特補休餘額、排班時數、發布狀態…），
//    盤點資料沒有那些欄位。共用的是「版面」，資料來自本頁自己的計算。
function buildSalaryDoc() {
  const [y, m] = sheet.salaryMonth.split('-').map(Number);
  const emps = sheet.employees || [];
  let html = '';
  for (let i = 0; i < emps.length; i += 2) {
    html += '<div class="doc payslip-page">';
    html += buildOnePayslip(emps[i], y, m);
    if (emps[i + 1]) {
      html += '<div class="cut-line">✂ ─────────────────────────────</div>';
      html += buildOnePayslip(emps[i + 1], y, m);
    }
    html += '</div>';
  }
  return html;
}

function buildOnePayslip(e, y, m) {
  const c = calcPay(e);
  const isPart = e.role === '工讀';
  const money = v => '$' + comma(v);
  // 版面是 9 欄（項目佔 2 欄、金額 1 欄，共三組）
  const td = txt => `<td colspan="2" style="padding:3px 6px;border:1px solid #ccc;">${txt}</td>`;
  const tdR = (txt, extra) => `<td style="padding:3px 6px;border:1px solid #ccc;text-align:right;${extra || ''}">${txt}</td>`;
  const hd = txt => `<td colspan="2" style="padding:3px 6px;border:1px solid #ccc;background:#d9e1f2;font-weight:800;">${txt}</td>`;
  const blank = span => `<td colspan="${span}" style="padding:3px 6px;border:1px solid #ccc;">&nbsp;</td>`;
  const rowBase = isPart ? money(c.basePay) : money(n(e.baseSalary));

  return `<div class="payslip-half">
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:6px;">
      <tr>
        <td style="border:1px solid #ccc;padding:4px 8px;background:#d9e1f2;font-weight:800;">姓名</td>
        <td style="border:1px solid #ccc;padding:4px 8px;font-weight:700;">${esc(e.name)}</td>
        <td style="border:1px solid #ccc;padding:4px 8px;background:#d9e1f2;font-weight:800;">職稱</td>
        <td style="border:1px solid #ccc;padding:4px 8px;font-weight:700;">${e.role}</td>
        <td style="border:1px solid #ccc;padding:4px 8px;background:#d9e1f2;font-weight:800;">門市</td>
        <td style="border:1px solid #ccc;padding:4px 8px;text-align:center;font-weight:700;">${esc(sheet.storeName)}　${y}年${m}月份薪資單</td>
      </tr>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <tr>
        <th colspan="2" style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;text-align:center;">薪資考勤項目</th>
        <th style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;text-align:center;">金額</th>
        <th colspan="2" style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;text-align:center;">代扣項目</th>
        <th style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;text-align:center;">金額</th>
        <th colspan="2" style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;text-align:center;">考勤</th>
        <th style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;text-align:center;"></th>
      </tr>
      <tr>
        ${td('本薪', '', 2)}${tdR(rowBase)}
        ${td('勞保費')}${tdR(money(n(e.laborInsurance)))}
        ${td(isPart ? '工時' : '出勤天數')}${tdR(isPart ? c.hours.toFixed(2) + 'h' : c.workDays + '天')}
      </tr>
      <tr>
        ${td('全勤獎金')}${tdR(isPart ? '--' : money(n(e.fullAttendBonus)))}
        ${td('健保費')}${tdR(money(n(e.healthInsurance) + n(e.dependentInsurance)))}
        ${td(isPart ? '時薪' : '總工時')}${tdR(isPart ? '$' + c.wage : c.hours.toFixed(1) + 'h')}
      </tr>
      <tr>
        ${td(isPart ? '職務津貼' : '管理責任獎金')}${tdR(isPart ? '--' : money(n(e.mgmtBonus)))}
        ${td('勞退個人自提')}${tdR(money(n(e.laborPension)))}
        ${td('國定假日出勤')}${tdR(c.holDays + '天')}
      </tr>
      <tr>
        ${td('績效獎金')}${tdR(isPart ? '--' : money(n(e.performance)))}
        ${td('其他扣款')}${tdR(money(n(e.otherDeduction)))}
        ${td('國定假日時數')}${tdR(c.holHours.toFixed(1) + 'h')}
      </tr>
      <tr>
        ${td('勞務津貼')}${tdR(isPart ? '--' : money(n(e.laborAllowance)))}
        ${blank(6)}
      </tr>
      <tr>
        ${td('其他獎金/津貼')}${tdR(isPart ? '--' : money(n(e.otherBonus)))}
        ${blank(3)}
        ${hd('平日加班時數')}${tdR(isPart ? '--' : n(e.otHours) + 'h')}
      </tr>
      <tr>
        ${td('平日加班' + (isPart ? '' : `<br><span style="font-size:9px;color:#64748b;">$${Math.ceil(c.rph)}×1.34×${n(e.otHours)}h</span>`))}${tdR(isPart ? '--' : '+' + money(c.otPay))}
        ${blank(3)}
        ${hd('遲到分鐘數')}${tdR((isPart ? 0 : n(e.lateMinutes)) + '分')}
      </tr>
      <tr>
        ${td('國定假日加給' + (c.holDays ? `<br><span style="font-size:9px;color:#64748b;">${isPart ? `$${c.wage}×${c.holHours.toFixed(1)}h×1` : `一日工資 $${comma(c.dayWage)}×${c.holDays}日`}</span>` : ''))}${tdR(c.holPay ? '+' + money(c.holPay) : '$0')}
        ${blank(3)}
        ${hd(isPart ? '' : '加班費計算基礎')}${tdR(isPart ? '' : '$' + Math.round(c.rph))}
      </tr>
      <tr>
        ${td('遲到扣款')}${tdR(c.lateDed ? '-' + money(c.lateDed) : '$0', 'color:#d93025;')}
        ${blank(3)}
        ${hd('公司提撥退休金')}${tdR(c.comp ? money(c.comp) : '--')}
      </tr>
      <tr>
        ${td('事病假扣款')}${tdR(c.sick ? '-' + money(c.sick) : '$0', 'color:#d93025;')}
        ${blank(6)}
      </tr>
      <tr>
        <td colspan="2" style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;font-weight:800;">應發薪資</td>
        <td style="padding:4px 6px;border:1px solid #ccc;text-align:right;font-weight:800;">${money(c.gross)}</td>
        <td colspan="2" style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;font-weight:800;">代扣合計</td>
        <td style="padding:4px 6px;border:1px solid #ccc;text-align:right;font-weight:800;">${money(c.deduct)}</td>
        <td colspan="2" style="padding:4px 6px;border:1px solid #ccc;background:#d9e1f2;font-weight:800;">實發金額</td>
        <td style="padding:4px 6px;border:1px solid #ccc;text-align:right;font-weight:900;color:#1a73e8;">${money(c.net)}</td>
      </tr>
    </table>
    <div style="border:1px solid #ccc;padding:5px 8px;font-size:10px;margin-top:4px;min-height:20px;">溝通事項：</div>
    <div style="border:1px solid #334155;border-radius:4px;padding:6px 10px;margin-top:4px;font-size:10px;">
      <div style="color:#334155;line-height:1.7;margin-bottom:6px;">
        本人確認以上薪資計算明細正確無誤，各項發放、扣款項目均已核對，確認與實際相符。
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div style="border-top:1px solid #334155;padding-top:4px;"><div style="color:#64748b;margin-bottom:12px;">員工簽名：</div></div>
        <div style="border-top:1px solid #334155;padding-top:4px;"><div style="color:#334155;">日期：____年____月____日</div></div>
      </div>
    </div>
  </div>`;
}
