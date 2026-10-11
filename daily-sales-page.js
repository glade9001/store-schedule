// ===== 每日營業（2026-10-11）=====
// 每天輸入營業額（含稅，PSD＝日結單 111「本日實際銷貨收入」，含代銷隨取）、來客數。不強制輸入。
// 報廢：使用者 2026-10-11 決定先不記錄（欄位、報廢率都拿掉；儲存不寫 waste，既有資料不動）。
// 使用者定案：
//   - 一個營業日＝晚班＋夜班＋早班，早班日結後才有數字 → 日期預設「今天」。
//   - 店長：輸入／修改（不限天數）、看本店分析、指派「作帳人員」。加盟主／admin：看三店。
//   - 作帳人員（config/dailySales.inputters）：只看得到輸入畫面，可改最近 7 天，看不到分析。
//   - 先獨立：不進加盟主儀表板、不進經營報酬／工時上限分析（等驗證每日加總對得上損益表再說）。
// ⚠️ 「作帳人員看不到分析」是畫面層級；資料庫規則目前登入即可讀 stores/*（同損益），要真正擋住得等資安收緊。
// 名稱都帶 ds 前綴。

let dsUser = null, dsConfig = { stores: [] }, dsStoreName = '', dsRole = '', dsTab = 'ana', dsMonth = '';
let dsCache = {};        // 'store|YYYY-MM' -> { days:{date:doc}, hours:{bizDate:h} }
let dsEmps = [], dsInputters = [], dsShowAna = false; // dsShowAna：店長決定作帳人員看不看得到「分析」（config/dailySales.inputterSeeAna，2026-10-11 使用者要求）
let dsRecent = {}, dsPicked = null; // dsPicked：輸入框目前那天已存的資料（覆蓋確認用）       // 本店最近 DS_REF_DAYS 天的每日資料（防呆比對用）

const DS_DAY_CUT = 14;   // 班別 14:00 以後開始（晚班、大夜）算隔天的營業日：晚＋夜＋早＝一天
const DS_EDIT_DAYS = 7;  // 作帳人員可改最近 7 天（含今天）
const DS_OFF = ['排休', '指休', '特休', '補休', '清空', ''];
const DS_WD = ['日', '一', '二', '三', '四', '五', '六'];
// 防呆（2026-10-11 使用者要求）：日結單「收銀機合計」欄印刷錯一列，照列對很容易抄成
// 120「扣除行動隨取」（少了代銷隨取，約少 15~20%）或抄到別列 → 跟近 4 週平均比，差太多先確認。
const DS_REF_DAYS = 28;
const DS_DEV = 0.3;          // 跟近 4 週平均差超過 30% 先確認
const DS_SALES_MAX = 300000; // 單店一天不可能超過 30 萬（多打一位數）

function dsToast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); }
function dsLoading(m) { document.getElementById('loadingText').textContent = m || '載入中…'; document.getElementById('loadingOverlay').classList.remove('hidden'); }
function dsLoaded() { document.getElementById('loadingOverlay').classList.add('hidden'); }
function dsBack() { const ref = new URLSearchParams(location.search).get('ref'); if (ref) location.href = ref; else if (history.length > 1) history.back(); else location.href = 'home.html'; }
function dsEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const dsPad = n => String(n).padStart(2, '0');
const dsYmd = d => `${d.getFullYear()}-${dsPad(d.getMonth() + 1)}-${dsPad(d.getDate())}`;
const dsToday = () => dsYmd(new Date());
const dsMd = s => `${+s.slice(5, 7)}/${+s.slice(8)}`;
const dsWdOf = s => DS_WD[new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8)).getDay()];
const dsMoney = v => v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US');
const dsWan = v => v == null || !isFinite(v) ? '—' : (Math.abs(v) >= 10000 ? (Math.round(v / 1000) / 10) + ' 萬' : dsMoney(v));
const dsIsOwner = () => ['owner', 'admin'].includes(dsUser?.permission);
const dsIsLeadOf = s => dsIsOwner() || (dsUser?.permission === 'manager' && dsUser.store === s);
const dsRef = s => window.db.collection('stores').doc(s || dsStoreName);

window.onload = async () => {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  try { dsUser = JSON.parse(saved); } catch (e) { location.replace('home.html'); return; }
  const fb = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(x => { u(); r(x); }); });
  if (!fb) { location.replace('home.html'); return; }
  try { const s = await window.db.collection('settings').doc('globalConfig').get(); if (s.exists) dsConfig = s.data(); } catch (e) {}
  const all = (dsConfig.stores || []).filter(s => s && s !== '人力支援');
  const stores = dsIsOwner() ? all : (dsUser.store ? [dsUser.store] : []);
  if (!stores.length) { dsDeny(); return; }
  const qs = new URLSearchParams(location.search).get('store');
  dsStoreName = stores.includes(qs) ? qs : stores.includes(dsUser.store) ? dsUser.store : stores[0];
  const sel = document.getElementById('dsStore');
  if (stores.length > 1) {
    sel.innerHTML = stores.map(s => `<option value="${dsEsc(s)}"${s === dsStoreName ? ' selected' : ''}>${dsEsc(s)}</option>`).join('');
    sel.style.display = '';
  }
  dsMonth = dsToday().slice(0, 7);
  await dsOnStore(true);
};

function dsDeny() {
  dsLoaded();
  document.querySelector('.wrap').innerHTML = '<div class="card empty">這個功能需要店長指派為「作帳人員」才能使用。</div>';
}

async function dsOnStore(first) {
  if (!first) dsStoreName = document.getElementById('dsStore').value;
  dsLoading();
  try {
    const c = await dsRef().collection('config').doc('dailySales').get().catch(() => null);
    dsInputters = (c && c.exists && c.data().inputters) || [];
    dsShowAna = !!(c && c.exists && c.data().inputterSeeAna);
  } catch (e) { dsInputters = []; dsShowAna = false; }
  dsRole = dsIsLeadOf(dsStoreName) ? 'lead' : (dsUser.store === dsStoreName && dsInputters.includes(dsUser.empName)) ? 'input' : '';
  if (!dsRole) { dsDeny(); return; }
  await dsLoadRecent();
  dsRenderInput();
  dsRenderMiss();
  await dsPickDate(document.getElementById('dsDate').value);
  if (dsRole === 'lead' || dsShowAna) { if (dsRole !== 'lead') dsTab = 'ana'; document.getElementById('dsTabs').style.display = dsRole === 'lead' ? '' : 'none'; await dsRenderTab(); }
  else { document.getElementById('dsTabs').style.display = 'none'; document.getElementById('dsMain').innerHTML = ''; }
  dsLoaded();
  if (first) dsMaybeIntro();
}

// ───────── 輸入 ─────────
function dsRenderInput() {
  const today = dsToday(), min = dsRole === 'lead' ? '' : shiftDateAdd(today, -(DS_EDIT_DAYS - 1));
  document.getElementById('dsInput').innerHTML = `<div class="card">
    <div class="card-title">✏️ 輸入營業數字<span class="sub">${dsEsc(dsStoreName)}</span></div>
    <div class="f-row"><label>營業日（晚＋夜＋早算一天，早班日結後輸入）</label>
      <input type="date" id="dsDate" value="${today}" max="${today}" ${min ? `min="${min}"` : ''} onchange="dsPickDate(this.value)"></div>
    <div id="dsMiss"></div>
    <div id="dsSavedTag" class="saved-tag"></div>
    <div class="f-row"><label>111 本日實際銷貨收入</label><input type="number" inputmode="numeric" id="dsSales" min="0" step="1" placeholder="${dsHint('sales', '例：65000')}"></div>
    <div class="f-row"><label>101 本日來客數</label><input type="number" inputmode="numeric" id="dsCust" min="0" step="1" placeholder="${dsHint('customers', '例：600')}"></div>
    <details class="where"><summary>📄 數字在現金日報表哪裡？</summary>
      <div>看「現金日報表」最右邊<b>「收銀機合計」</b>那一欄（⚠️ 這欄印歪了，往上錯一格，不要照左邊的項目名稱對）：</div>
      <ul><li><b>101 本日來客數</b>＝這欄<b>最上面</b>第一個數字</li>
      <li><b>111 本日實際銷貨收入</b>＝這欄<b>倒數第二個</b>數字（比最後一個大；最後一個是 120 實際營業額，扣掉了代銷隨取，不要填）</li></ul>
      <div>也可以看後台「情報分析 → 三班帳務分析表」的 <b>PSD 含代銷隨取</b>（＝111）、<b>來客數</b>（＝101），兩邊數字一樣。</div>
    </details>
    <button class="btn-primary" id="dsSaveBtn" onclick="dsSave()">儲存</button>
    ${dsRole === 'input' ? `<div class="note">可以修改最近 ${DS_EDIT_DAYS} 天的資料；更早的請找店長。</div>` : ''}
  </div>`;
}

// 本店最近 DS_REF_DAYS 天（防呆比對、輸入框提示近 4 週平均）
async function dsLoadRecent() {
  dsRecent = {};
  const FP = firebase.firestore.FieldPath.documentId();
  const snap = await dsRef().collection('dailySales').where(FP, '>=', shiftDateAdd(dsToday(), -DS_REF_DAYS)).get().catch(() => null);
  if (snap) snap.forEach(d => { dsRecent[d.id] = d.data(); });
}
// 近 4 週平均（排除正在輸入的那天）；資料少於 5 天不比，避免被單日帶偏
function dsRefAvg(key, exclude) {
  const v = Object.keys(dsRecent).filter(d => d !== exclude).map(d => dsRecent[d][key]).filter(x => x != null && +x > 0).map(Number);
  return v.length >= 5 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function dsHint(key, dflt) { const a = dsRefAvg(key); return a ? '近 4 週平均 ' + dsMoney(a) : dflt; }

// 漏輸入提醒（使用者 2026-10-11：只放在這一頁，不上首頁——測試功能，別店不一定想用）
// 最近 7 天（作帳人員能改的範圍）到昨天為止沒輸入的日子；本店最近 14 天完全沒輸入過就不顯示（還沒開始用）。
// 為什麼要提醒：工時上限的換算比例只用「每天都有輸入」的月份，漏一天整個月就不能用。
function dsRenderMiss() {
  const el = document.getElementById('dsMiss'); if (!el) return;
  const t = dsToday(), has = d => dsRecent[d] && dsRecent[d].sales != null;
  const active = Object.keys(dsRecent).some(d => d >= shiftDateAdd(t, -14) && d < t && has(d));
  const miss = []; for (let k = 7; k >= 1; k--) { const d = shiftDateAdd(t, -k); if (!has(d)) miss.push(d); }
  el.innerHTML = active && miss.length ? `<div class="miss">⚠️ 最近 7 天有 ${miss.length} 天還沒輸入：${miss.map(d => `<a onclick="dsEditDay('${d}')">${dsMd(d)}（${dsWdOf(d)}）</a>`).join('、')}<small>點日期直接補；漏一天，那個月就不能拿來校正工時上限。</small></div>` : '';
}

async function dsPickDate(date) {
  const tag = document.getElementById('dsSavedTag');
  ['dsSales', 'dsCust'].forEach(id => { document.getElementById(id).value = ''; });
  tag.textContent = ''; dsPicked = null;
  if (!date) return;
  const snap = await dsRef().collection('dailySales').doc(date).get().catch(() => null);
  if (snap && snap.exists) {
    const d = dsPicked = snap.data();
    document.getElementById('dsSales').value = d.sales ?? '';
    document.getElementById('dsCust').value = d.customers ?? '';
    tag.textContent = `✓ 已輸入（${dsEsc(d.updatedByName || d.updatedBy || '')}${d.updatedAt ? ' · ' + dsMd(d.updatedAt.slice(0, 10)) + ' ' + d.updatedAt.slice(11, 16) : ''}），修改後再按儲存`;
  }
}

function dsCanEdit(date) {
  if (!date || date > dsToday()) return false;
  return dsRole === 'lead' || date >= shiftDateAdd(dsToday(), -(DS_EDIT_DAYS - 1));
}

async function dsSave() {
  const date = document.getElementById('dsDate').value;
  if (!dsCanEdit(date)) { dsToast(date > dsToday() ? '不能輸入未來的日期' : `只能修改最近 ${DS_EDIT_DAYS} 天，請找店長`); return; }
  const num = id => { const v = document.getElementById(id).value.trim(); return v === '' ? null : Number(v); };
  const sales = num('dsSales'), cust = num('dsCust');
  if (sales == null) { dsToast('請輸入 111 本日實際銷貨收入'); return; }
  for (const [v, n] of [[sales, '銷貨收入'], [cust, '來客數']]) {
    if (v != null && (!isFinite(v) || v < 0)) { dsToast(n + '請填 0 以上的數字'); return; }
  }
  if (cust != null && !Number.isInteger(cust)) { dsToast('來客數請填整數'); return; }
  if (!Number.isInteger(sales)) { dsToast('銷貨收入請填整數（日報表上沒有小數）'); return; }
  if (sales > DS_SALES_MAX) { dsToast(`銷貨收入 ${dsMoney(sales)} 太大了，是不是多打了一位數？`); return; }
  if (sales === 0 && !confirm('銷貨收入是 0，確定這天沒有營業嗎？')) return;
  // 防手誤：銷貨收入跟來客數差太多（客單價 < 20 或 > 2000）先確認一次
  if (cust && (sales / cust < 20 || sales / cust > 2000) && !confirm(`客單價算出來是 ${Math.round(sales / cust)} 元，數字確定沒打錯嗎？`)) return;
  // 防抄錯列：跟近 4 週平均差太多
  const warns = [];
  const chk = (v, key, label) => { const a = dsRefAvg(key, date); if (v && a && Math.abs(v / a - 1) > DS_DEV) warns.push(`${label} ${dsMoney(v)}，近 4 週平均 ${dsMoney(a)}（${v > a ? '多' : '少'} ${Math.round(Math.abs(v / a - 1) * 100)}%）`); };
  chk(sales, 'sales', '銷貨收入'); chk(cust, 'customers', '來客數');
  const prev = dsRecent[shiftDateAdd(date, -1)];
  if (prev && prev.sales === sales) warns.push(`銷貨收入跟前一天（${dsMd(shiftDateAdd(date, -1))}）一模一樣，是不是看到前一天的日報表？`);
  if (warns.length && !confirm('請再看一次現金日報表：\n\n・' + warns.join('\n・') + '\n\n「111 本日實際銷貨收入」是「收銀機合計」欄倒數第二個數字。\n數字確定沒錯就按「確定」儲存。')) return;
  // 覆蓋已輸入的數字先確認
  const old = dsPicked && dsPicked.date === date ? dsPicked : dsRecent[date];
  if (old && (old.sales !== sales || (old.customers ?? null) !== cust)
      && !confirm(`${dsMd(date)} 已經輸入過（銷貨收入 ${dsMoney(old.sales)}、來客 ${old.customers != null ? dsMoney(old.customers) : '—'}，${old.updatedByName || old.updatedBy || ''}），要改成新的數字嗎？`)) return;
  const btn = document.getElementById('dsSaveBtn'); btn.disabled = true;
  try {
    const ref = dsRef().collection('dailySales').doc(date);
    const now = new Date().toISOString(), who = dsUser.empName || '', whoName = dsUser.displayName || who;
    await window.db.runTransaction(async tx => {
      const s = await tx.get(ref);
      const base = { date, sales, customers: cust, updatedBy: who, updatedByName: whoName, updatedAt: now };
      if (!s.exists) Object.assign(base, { createdBy: who, createdAt: now });
      tx.set(ref, base, { merge: true });
    });
    dsCache = {};
    dsRecent[date] = { date, sales, customers: cust, updatedBy: who, updatedByName: whoName };
    dsRenderMiss();
    try { localStorage.removeItem('hdc4:' + dsStoreName); } catch (e) {} // 首頁每日營業卡（home-ds.js）回去馬上重算
    dsToast('✅ 已儲存 ' + dsMd(date));
    await dsPickDate(date);
    if (dsRole === 'lead') await dsRenderTab();
  } catch (e) { dsToast('❌ 儲存失敗：' + e.message); }
  btn.disabled = false;
}

// ───────── 店長：分頁 ─────────
function dsSetTab(t) { dsTab = t; dsRenderTab(); }
async function dsRenderTab() {
  // 作帳人員（店長開放時）只有「分析」，沒有明細與指派
  document.getElementById('dsTabs').innerHTML = (dsRole === 'lead' ? [['ana', '📊 分析'], ['list', '📋 明細'], ['who', '👤 作帳人員']] : [['ana', '📊 分析']])
    .map(([k, l]) => `<button class="${dsTab === k ? 'on' : ''}" onclick="dsSetTab('${k}')">${l}</button>`).join('');
  const el = document.getElementById('dsMain');
  if (dsTab === 'who') { await dsRenderWho(el); return; }
  if (dsRole !== 'lead') dsMonth = dsToday().slice(0, 7);
  if (dsTab === 'ana') { el.innerHTML = await dsRenderAna(dsStoreName, dsMonth); return; }
  el.innerHTML = dsRenderList(await dsLoadMonth(dsStoreName, dsMonth));
}
function dsMonthSel() {
  // 作帳人員（店長有勾「看得到分析」時）只看當月，不能切其他月份（使用者 2026-10-11）
  if (dsRole !== 'lead') return `<span class="month-fixed">${+dsMonth.slice(0, 4)}年${+dsMonth.slice(5)}月</span>`;
  const now = new Date(), opts = [];
  for (let i = 0; i < 12; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); opts.push(`${d.getFullYear()}-${dsPad(d.getMonth() + 1)}`); }
  return `<select class="month-sel" onchange="dsMonth=this.value;dsRenderTab()">${opts.map(m => `<option value="${m}"${m === dsMonth ? ' selected' : ''}>${+m.slice(0, 4)}年${+m.slice(5)}月</option>`).join('')}</select>`;
}

// 讀一個月：每日數字＋班表工時（按營業日歸屬）
async function dsLoadMonth(store, ym) {
  const key = store + '|' + ym;
  if (dsCache[key]) return dsCache[key];
  const first = ym + '-01', last = ym + '-' + dsPad(new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate());
  const FP = firebase.firestore.FieldPath.documentId();
  const daySnap = await dsRef(store).collection('dailySales').where(FP, '>=', first).where(FP, '<=', last).get().catch(() => null);
  const days = {};
  if (daySnap) daySnap.forEach(d => { days[d.id] = d.data(); });
  // 營業日 D ＝ D-1 的晚班/大夜 ＋ D 的早班 → 班表要從月初前一天讀到月底
  const slot = {}; // 'week|週X' -> 日期
  for (let dt = shiftDateAdd(first, -1); dt <= last; dt = shiftDateAdd(dt, 1)) slot[shiftWeekStr(dt) + '|' + shiftDayName(dt)] = dt;
  const weeks = [...new Set(Object.keys(slot).map(k => k.split('|')[0]))];
  const snaps = await Promise.all(weeks.map(w => dsRef(store).collection('weeks').doc(w).get().catch(() => null)));
  const hours = {}, recs = []; // recs：帶 week 的原始班表，給 lbEvaluate 算這個月的排班人事
  snaps.forEach((s, i) => {
    if (!s || !s.exists) return;
    (s.data().records || []).forEach(r => {
      if (r) recs.push(Object.assign({}, r, { week: weeks[i] }));
      if (!r || r.name === '門市備註' || DS_OFF.includes(String(r.shift || '').trim())) return;
      const loc = r.location || ''; if (loc && loc !== '本店') return; // 外派別店的不算本店人力
      const dt = slot[weeks[i] + '|' + r.day]; if (!dt) return;
      const h = parseFloat(r.actualHours || 0), sp = shiftSpan(r.shift);
      if (!(h > 0) || !sp) return;
      const biz = sp.startH >= DS_DAY_CUT ? shiftDateAdd(dt, 1) : dt;
      if (biz < first || biz > last) return;
      hours[biz] = (hours[biz] || 0) + h;
    });
  });
  return (dsCache[key] = { ym, days, hours, recs });
}

// ───────── 店長：分析（2026-10-11 使用者選這四項）─────────
// ① 業績進度：累計營業額 vs「達標 PDS × 天數」（labor-budget.js lbEvaluate，跟排班頁工時上限同一個數字）
// ② 星期幾 × 人力：近 3 個月「每工時來客數」。
//    ⚠️ 用來客、不用營業額：美德 7~10 月週六營業額最高（+7%），但來客反而偏少、是客單拉高的；
//    店員忙不忙看的是結帳筆數，用營業額會誤判週六要多排人。
// ③ 每日走勢：營業額＋7 天平均＋上月日均
// ④ 跟上月比：日均營業額的變化拆成「來客」「客單」兩部分（來客效果＝Δ來客×上月客單；客單效果＝Δ客單×本月來客，兩者相加剛好等於總變化）
let dsLbCache = {}; // store -> Promise<lbLoadStore 結果>
function dsLb(store) {
  if (typeof lbLoadStore !== 'function') return Promise.resolve(null);
  if (!dsLbCache[store]) dsLbCache[store] = lbLoadStore(window.db, store).catch(e => { console.warn('[ds lb]', e); delete dsLbCache[store]; return null; });
  return dsLbCache[store];
}
const dsAddMonth = (ym, k) => { const d = new Date(+ym.slice(0, 4), +ym.slice(5) - 1 + k, 1); return `${d.getFullYear()}-${dsPad(d.getMonth() + 1)}`; };
const dsDaysIn = ym => new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
const dsSalesDays = data => Object.keys(data.days).sort().filter(d => data.days[d].sales != null);
const dsSigned = (v, f) => (v >= 0 ? '+' : '−') + f(Math.abs(v));
const dsAxis = v => Math.abs(v) >= 10000 ? (Math.round(v / 1000) / 10) + '萬' : Math.round(v).toLocaleString('en-US');

// ── 去年同期（2026-10-11 使用者選 1＋3＋4）──
// ⚠️ 一律跟 364 天前比（同一個星期幾），不比同日期：便利商店週六／週日跟平日差 ±7%，
//    同日期比會把「星期幾不同」誤當成生意變化。中秋、春節等每年日期不同的節日另外標出來。
const DS_LY = 364;
const dsLyDate = d => shiftDateAdd(d, -DS_LY);
// 2025 年國定假日（holidays.js 內建表只有 2026 起、Firestore 也只維護當年度）：只拿來標「節日錯開」，不影響薪資
const DS_HOL_2025 = { '2025-01-01': '元旦', '2025-01-28': '除夕', '2025-01-29': '春節', '2025-01-30': '春節', '2025-01-31': '春節',
  '2025-02-28': '和平紀念日', '2025-04-04': '兒童節／清明', '2025-05-31': '端午', '2025-10-06': '中秋', '2025-10-10': '國慶' };
let dsHolCache = {};
async function dsHolidays(ym) {
  const y = +ym.slice(0, 4);
  if (dsHolCache[y]) return dsHolCache[y];
  let map = {};
  try { if (typeof loadHolidayMap === 'function') map = (await loadHolidayMap([y, y - 1])).map || {}; } catch (e) {}
  if (!Object.keys(map).some(d => d.startsWith('2025'))) Object.assign(map, DS_HOL_2025);
  return (dsHolCache[y] = map);
}
// 依文件 id 範圍讀每日營業（去年同期用）
async function dsLoadRange(store, from, to) {
  const key = store + '|' + from + '|' + to;
  if (dsCache[key]) return dsCache[key];
  const FP = firebase.firestore.FieldPath.documentId();
  const snap = await dsRef(store).collection('dailySales').where(FP, '>=', from).where(FP, '<=', to).get().catch(() => null);
  const days = {}; if (snap) snap.forEach(d => { days[d.id] = d.data(); });
  return (dsCache[key] = days);
}

async function dsRenderAna(store, ym) {
  const first = ym + '-01', lastDay = ym + '-' + dsPad(dsDaysIn(ym));
  const [cur, p1, p2, lb, lyDays, hol] = await Promise.all([dsLoadMonth(store, ym), dsLoadMonth(store, dsAddMonth(ym, -1)), dsLoadMonth(store, dsAddMonth(ym, -2)), dsLb(store),
    dsLoadRange(store, dsLyDate(first), dsLyDate(lastDay)), dsHolidays(ym)]);
  // 大單日（labor-budget.js lbBigDays）：今年用上月＋本月當基準，去年用去年那段
  const bigCur = typeof lbBigDays === 'function' ? lbBigDays(Object.assign({}, p1.days, cur.days)).big : {};
  const bigLy = typeof lbBigDays === 'function' ? lbBigDays(lyDays).big : {};
  const ctx = { ly: d => { const x = lyDays[dsLyDate(d)]; return x && x.sales != null ? x : null; }, hol,
    big: d => bigCur[d] || null, lyBig: d => bigLy[dsLyDate(d)] || null,
    adj: (x, b) => +x.sales - (b ? b.excess : 0) }; // 扣掉大單多出的金額
  const head = `<div class="card-title">📊 ${+ym.slice(5)}月分析<span class="sub">${dsMonthSel()}</span></div>`;
  const ds = dsSalesDays(cur);
  if (!ds.length) return `<div class="card">${head}<div class="empty">這個月還沒有輸入資料</div></div>`;
  const W = Math.max(280, (document.getElementById('dsMain').clientWidth || 360) - 28);
  let S = 0, C = 0, Cn = 0, SH = 0, H = 0;
  ds.forEach(d => {
    const x = cur.days[d]; S += +x.sales;
    if (x.customers != null) { C += +x.customers; Cn++; }
    if (cur.hours[d]) { SH += +x.sales; H += cur.hours[d]; }
  });
  const sCust = ds.filter(d => cur.days[d].customers != null).reduce((t, d) => t + +cur.days[d].sales, 0);
  const kpi = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  return `<div class="card">${head}<div class="kpis">
    ${kpi('營業額合計', dsWan(S), `${ds.length} 天有資料`)}
    ${kpi('日均營業額', dsWan(S / ds.length), '')}
    ${kpi('日均來客', Cn ? dsMoney(C / Cn) + ' 人' : '—', Cn ? `客單價 ${dsMoney(sCust / C)} 元` : '')}
    ${kpi('每工時營業額', H ? dsMoney(SH / H) + ' 元' : '—', H ? `班表 ${dsMoney(H)} 小時` : '班表沒有對應的班')}
  </div><div class="note">營業額＝111 本日實際銷貨收入（含稅、含代銷隨取）。工時用班表排定時數，晚班、大夜算到隔天的營業日。</div></div>`
    + dsAnaProgress(cur, lb, ym, W, ctx) + dsAnaWeekday([p2, p1, cur]) + dsAnaTrend(cur, p1, ym, W, ctx) + dsAnaChange(cur, p1, ym, ctx);
}

// ── ① 業績進度 ──
function dsAnaProgress(cur, lb, ym, W, ctx) {
  const title = `<div class="card-title">🎯 ${+ym.slice(5)}月業績進度</div>`;
  if (!lb || !lb.model || lb.model.err || typeof lbEvaluate !== 'function') return `<div class="card">${title}<div class="empty">損益或人事資料不足，算不出達標營業額</div></div>`;
  const ev = lbEvaluate(lb, cur.recs || [], ym);
  if (ev.err || ev.targetPds == null) return `<div class="card">${title}<div class="empty">損益或人事資料不足，算不出達標營業額</div></div>`;
  const tgt = ev.targetPds, n = dsDaysIn(ym), ds = dsSalesDays(cur), lastD = ds[ds.length - 1], last = +lastD.slice(8);
  // 圖畫「累計超前／落後」而不是累計金額：累計線從 0 爬到 200 萬，幾萬塊的差距在圖上看不出來
  const gapV = Array(n).fill(null), tips = Array(n).fill(null);
  let cum = 0, k = 0, bigSum = 0, bigN = 0; // cum 已扣掉大單多出的金額：比例校正也扣掉了，兩邊口徑才一致
  for (let d = 1; d <= last; d++) {
    const x = cur.days[`${ym}-${dsPad(d)}`];
    if (x && x.sales != null) { const b = ctx.big(`${ym}-${dsPad(d)}`); cum += ctx.adj(x, b); k++; if (b) { bigSum += b.excess; bigN++; } }
    gapV[d - 1] = cum - tgt * k;
    tips[d - 1] = `${+ym.slice(5)}/${d}　累計 ${dsMoney(cum)}｜達標 ${dsMoney(tgt * k)}｜${gapV[d - 1] >= 0 ? '超前' : '落後'} ${dsMoney(Math.abs(gapV[d - 1]))}`;
  }
  const diff = cum - tgt * k, avg = cum / k;
  const ahead = diff >= 0, gap = k < last ? `（有 ${last - k} 天沒輸入，只比有輸入的 ${k} 天）` : '';
  const done = last >= n;
  // 去年同期：只比「今年有輸入、364 天前也有資料」的日子
  let s1 = 0, s0 = 0, pk = 0;
  ds.forEach(d => { const l = ctx.ly(d); if (l) { s1 += ctx.adj(cur.days[d], ctx.big(d)); s0 += ctx.adj(l, ctx.lyBig(d)); pk++; } });
  const yoy = pk >= 5 ? s1 / s0 - 1 : null;
  // 整月推估：去年同期剩下的日子都有資料 → 去年的走勢 × 今年的成長；否則用目前日均
  let projTxt = '';
  if (!done) {
    const rest = []; for (let d = last + 1; d <= n; d++) rest.push(ctx.ly(`${ym}-${dsPad(d)}`));
    if (yoy != null && rest.every(Boolean)) {
      const p = cum + rest.reduce((t, x, i) => t + ctx.adj(x, ctx.lyBig(`${ym}-${dsPad(last + 1 + i)}`)), 0) * (1 + yoy);
      projTxt = `照去年同期走勢，整月約 <b>${dsWan(p)}</b>；達標要 ${dsWan(tgt * n)}。`;
    } else projTxt = `照目前日均 ${dsWan(avg)}，整月約 <b>${dsWan(avg * n)}</b>；達標要 ${dsWan(tgt * n)}。`;
  }
  // 卡片只露「剩下每天要做到」兩個數字（使用者 2026-10-11：其餘收起來）；超前／落後、去年比較、圖都放進「看進度明細」
  const rem = n - last;
  const needTgt = (() => { const need = tgt * n - cum;
    return need <= 0 ? `<div class="need"><span>要達標</span><b class="hi">這個月已經做到了</b></div>`
      : `<div class="need"><span>要達標</span><b>${dsMoney(need / rem)}</b><small>元／天</small></div>`; })();
  const needLy = (() => { // 去年同期整月（364 天前對齊、扣大單）− 目前累計，平均到剩下的天數；去年資料不齊就不顯示
    const ly = []; for (let d = 1; d <= n; d++) { const day = `${ym}-${dsPad(d)}`, l = ctx.ly(day); if (!l) return ''; ly.push(ctx.adj(l, ctx.lyBig(day))); }
    const need = ly.reduce((a, b) => a + b, 0) - cum;
    return need <= 0 ? `<div class="need"><span>要比去年同期成長</span><b class="hi">已經超過去年整月</b></div>`
      : `<div class="need"><span>要比去年同期成長</span><b>${dsMoney(need / rem)}</b><small>元／天</small></div>`; })();
  const head = done ? '' : `<div class="say">剩下 ${rem} 天，每天要做到：</div>${needTgt}${needLy}`;
  const detail = [
    `<div class="big ${ahead ? 'hi' : 'lo'}">${ahead ? '▲ 超前' : '▼ 落後'} ${dsWan(Math.abs(diff))}</div>`,
    `<div class="say">到 ${dsMd(lastD)} 累計 <b>${dsWan(cum)}</b>，達標進度是 ${dsWan(tgt * k)}${gap}。</div>`,
    bigN ? `<div class="say small-note">另有 ${bigN} 天大單（客單特別高），多出約 ${dsWan(bigSum)} 沒算進去：這部分通常不會出現在損益表。</div>` : '',
    yoy != null ? `<div class="say">比去年同期 <b class="${yoy >= 0 ? 'hi' : 'lo'}">${dsSigned(yoy * 100, v => v.toFixed(1))}%</b>（對齊星期幾，${pk} 天）。</div>` : '',
    projTxt ? `<div class="say">${projTxt}</div>` : '',
  ].join('');
  // 整月已過完：沒有「剩下每天」可說 → 直接露出超前／落後
  return `<div class="card">${title}${head}
    ${done ? detail : ''}
    <details class="fold sub-fold"${done ? ' open' : ''}><summary>${done ? '看圖' : '看進度明細'}</summary>${done ? '' : detail}
    ${dsLegend([['#1a73e8', '累計超前（線在 0 以上）／落後（0 以下）'], ['#94a3b8', '剛好達標', 'dash']])}
    ${dsLineChart({ W, n, xl: i => String(i + 1), tips, dots: true, refs: [{ v: 0 }], series: [{ vals: gapV, color: '#1a73e8' }] })}
    <div class="note">達標＝每天 ${dsWan(tgt)}，跟排班頁「工時上限」同一個算法（依過去損益與這個月的排班推算），僅供參考。</div></details></div>`;
}

// ── ② 星期幾 × 人力（近 3 個月）──
function dsAnaWeekday(months) {
  const by = {}; let from = null, to = null;
  months.forEach(m => Object.keys(m.days).forEach(d => {
    const x = m.days[d], h = m.hours[d];
    if (x.sales == null || x.customers == null || !(h > 0)) return;
    const w = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8)).getDay();
    const b = by[w] = by[w] || { n: 0, s: 0, c: 0, h: 0 };
    b.n++; b.s += +x.sales; b.c += +x.customers; b.h += h;
    if (!from || d < from) from = d; if (!to || d > to) to = d;
  }));
  const title = '<div class="card-title">👥 星期幾 × 人力</div>';
  const order = [1, 2, 3, 4, 5, 6, 0].filter(w => by[w]);
  const total = order.reduce((t, w) => t + by[w].n, 0);
  if (total < 14) return `<div class="card">${title}<div class="empty">要有 14 天以上「營業額＋來客＋班表」都齊的資料才會顯示（目前 ${total} 天）</div></div>`;
  const v = w => by[w].c / by[w].h;
  const vals = order.map(v), mx = Math.max(...vals), mn = Math.min(...vals);
  const bars = order.map(w => {
    const x = v(w), cls = x === mn ? 'lo' : x === mx ? 'hi' : '';
    return `<div class="wbar"><span class="wl">週${DS_WD[w]}</span><span class="wt"><span class="wf ${cls}" style="width:${(x / mx * 100).toFixed(1)}%"></span></span><span class="wv">${x.toFixed(1)}${cls === 'lo' ? '<small>最低</small>' : cls === 'hi' ? '<small>最高</small>' : ''}</span></div>`;
  }).join('');
  const rows = order.map(w => { const b = by[w];
    return `<tr><td>週${DS_WD[w]}<small>${b.n} 天</small></td><td>${dsMoney(b.c / b.n)}</td><td>${dsMoney(b.h / b.n)}</td><td>${dsMoney(b.s / b.c)}</td><td>${dsMoney(b.s / b.h)}</td></tr>`; }).join('');
  return `<div class="card">${title}
    <div class="say">每排 1 小時班，平均接幾位客人（${dsMd(from)}～${dsMd(to)}，${total} 天）</div>
    <div class="wbars">${bars}</div>
    <div class="note"><span class="lo">最低</span>的那天，人力相對生意最多，可以優先考慮少排；<span class="hi">最高</span>的那天最忙。看來客不看營業額：客單高的日子營業額會偏高，但結帳筆數不一定多。</div>
    <details class="fold sub-fold"><summary>看各星期明細</summary>
      <table class="tbl"><thead><tr><th>星期</th><th>來客</th><th>工時</th><th>客單</th><th>每工時營業額</th></tr></thead><tbody>${rows}</tbody></table>
    </details></div>`;
}

// ── ③ 每日走勢 ──
function dsAnaTrend(cur, p1, ym, W, ctx) {
  const n = dsDaysIn(ym), all = Object.assign({}, p1.days, cur.days);
  const val = d => all[d] && all[d].sales != null ? +all[d].sales : null;
  const day = i => `${ym}-${dsPad(i + 1)}`;
  const sales = Array.from({ length: n }, (_, i) => val(day(i)));
  const lastI = sales.reduce((t, v, i) => v != null ? i : t, -1);
  // 7 天平均：含當天往前 7 個日曆天，至少 4 天有資料才畫
  const ma = sales.map((_, i) => {
    if (i > lastI) return null;
    const vs = []; for (let k = 0; k < 7; k++) { const v = val(shiftDateAdd(day(i), -k)); if (v != null) vs.push(v); }
    return vs.length >= 4 ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  });
  // 去年同星期（364 天前）：整個月都畫，還沒到的日子也看得到去年的走法；有去年資料時不畫上月日均（線太多）
  const lyv = Array.from({ length: n }, (_, i) => { const l = ctx.ly(day(i)); return l ? +l.sales : null; });
  const hasLy = lyv.filter(v => v != null).length >= 7;
  const pds = dsSalesDays(p1), pAvg = !hasLy && pds.length >= 7 ? pds.reduce((t, d) => t + +p1.days[d].sales, 0) / pds.length : null;
  // 節日錯開：今年那天跟去年同星期那天，只有一邊是國定假日（或節日不同）→ 那天不能直接比
  const holTag = i => { const a = ctx.hol[day(i)], b = ctx.hol[dsLyDate(day(i))]; return (a || b) && a !== b ? [a ? '今年' + a : '', b ? '去年同星期是' + b : ''].filter(Boolean).join('、') : ''; };
  const holDays = hasLy ? Array.from({ length: n }, (_, i) => holTag(i) ? `${dsMd(day(i))}（${holTag(i)}）` : '').filter(Boolean) : [];
  const have = sales.map((v, i) => [v, i]).filter(x => x[0] != null && !ctx.big(day(x[1]))); // 最高／最低不算大單日
  const bigMarks = sales.map((v, i) => v != null && ctx.big(day(i)) ? { i, v, t: '', big: true } : null).filter(Boolean); // 只畫橘圈不寫字：大單常跟「最高」擠在一起
  const hiP = have.length ? have.reduce((a, b) => b[0] > a[0] ? b : a) : null, loP = have.length ? have.reduce((a, b) => b[0] < a[0] ? b : a) : null;
  const tips = sales.map((v, i) => { const x = all[day(i)];
    const lyT = lyv[i] != null ? `｜去年同星期 ${dsMoney(lyv[i])}` + (v != null ? `（${dsSigned((v / lyv[i] - 1) * 100, z => z.toFixed(1))}%）` : '') : '';
    const h = hasLy && holTag(i) ? `｜⚠️${holTag(i)}` : '';
    if (v == null) return lyT ? `${dsMd(day(i))}（${dsWdOf(day(i))}）還沒有資料` + lyT + h : null;
    const bg = ctx.big(day(i)), bgT = bg ? `｜大單日（客單 ${dsMoney(bg.ticket)}）` : '';
    return `${dsMd(day(i))}（${dsWdOf(day(i))}）${dsMoney(v)} 元` + (x.customers != null ? `・來客 ${dsMoney(x.customers)}` : '') + (ma[i] != null ? `｜7 天平均 ${dsMoney(ma[i])}` : '') + bgT + lyT + h; });
  return `<div class="card"><div class="card-title">📈 每日走勢</div>
    ${dsLegend([['#1a73e8', '每日營業額'], ['#e8710a', '7 天平均'], ...(hasLy ? [['#b0b8c4', '去年同星期']] : []), ...(pAvg ? [['#94a3b8', `${+dsAddMonth(ym, -1).slice(5)}月日均`, 'dash']] : [])])}
    ${dsLineChart({ W, n, xl: i => String(i + 1), tips, dots: true,
      refs: pAvg ? [{ v: pAvg }] : [],
      marks: (have.length > 1 ? [{ i: hiP[1], v: hiP[0], t: '最高 ' + dsAxis(hiP[0]) }, { i: loP[1], v: loP[0], t: '最低 ' + dsAxis(loP[0]), below: true }] : []).concat(bigMarks),
      series: [...(hasLy ? [{ vals: lyv, color: '#b0b8c4', w: 1.5 }] : []), { vals: sales, color: '#1a73e8', w: 1.5, dots: true }, { vals: ma, color: '#e8710a', w: 2.5 }] })}
    <div class="note">點圖上的點看當天數字。7 天平均線可以看出趨勢是往上還是往下，不會被單一天帶偏。${bigMarks.length ? '<span class="bg-dot"></span>橘色圈＝大單（客單約平常 1.35 倍以上），最高／最低不算它。' : ''}${hasLy ? '去年線是 364 天前（同一個星期幾），不是同日期。' : ''}</div>
    ${holDays.length ? `<div class="note">⚠️ 節日錯開、不能直接跟去年比：${holDays.join('、')}</div>` : ''}</div>`;
}

// ── ④ 跟上月比／跟去年比：來客 vs 客單 ──
// 跟去年比只用「今年、364 天前都有營業額＋來客」的日子成對比較。
// 經營意義：來客比去年少＝客人在流失（要處理）；只有客單變高＝可能只是漲價，不代表生意變好。
let dsCmp = 'mom';
function dsSetCmp(v) { dsCmp = v; dsRenderTab(); }
function dsAnaChange(cur, p1, ym, ctx) {
  const ok = x => x && x.sales != null && x.customers != null && +x.customers > 0;
  const agg = list => { let s = 0, c = 0; list.forEach(x => { s += +x.sales; c += +x.customers; });
    return list.length >= 5 ? { C: c / list.length, T: s / c, S: s / list.length, k: list.length } : null; };
  // 大單日兩邊都不算：一天客單 200 會把「客單變高」灌大
  const curDays = Object.keys(cur.days).sort().filter(d => ok(cur.days[d]) && !ctx.big(d));
  const pairs = curDays.filter(d => ok(ctx.ly(d)) && !ctx.lyBig(d));
  const canYoy = pairs.length >= 5, mode = canYoy ? dsCmp : 'mom';
  const pm = +dsAddMonth(ym, -1).slice(5);
  const a = mode === 'yoy' ? agg(pairs.map(d => ctx.ly(d))) : agg(Object.keys(p1.days).filter(d => ok(p1.days[d]) && !ctx.big(d)).map(d => p1.days[d]));
  const b = mode === 'yoy' ? agg(pairs.map(d => cur.days[d])) : agg(curDays.map(d => cur.days[d]));
  const lbl = mode === 'yoy' ? '去年同期' : `${pm} 月`;
  const tog = canYoy ? `<span class="sub seg"><button class="${mode === 'mom' ? 'on' : ''}" onclick="dsSetCmp('mom')">上月</button><button class="${mode === 'yoy' ? 'on' : ''}" onclick="dsSetCmp('yoy')">去年</button></span>` : '';
  const title = `<div class="card-title">🔍 跟${mode === 'yoy' ? '去年' : pm + '月'}比${tog}</div>`;
  if (!a || !b) return `<div class="card">${title}<div class="empty">兩邊都要有 5 天以上「營業額＋來客」才能比</div></div>`;
  const dS = b.S - a.S, eC = (b.C - a.C) * a.T, eT = (b.T - a.T) * b.C;
  const main = Math.abs(eC) >= Math.abs(eT) ? (eC >= 0 ? '來客變多' : '來客變少') : (eT >= 0 ? '客單變高' : '客單變低');
  const row = (l, from, to, unit, eff) => `<div class="chg"><span class="cl">${l}</span><span class="cv">${from} → <b>${to}</b> ${unit}</span><span class="ce ${eff >= 0 ? 'hi' : 'lo'}">${eff >= 0 ? '▲' : '▼'} ${dsSigned(eff, dsMoney)} 元</span></div>`;
  const hint = mode === 'yoy'
    ? (eC < 0 ? '⚠️ 來客比去年少：客人可能在流失（附近新店、商圈變化），比單月起伏更值得注意。' : '')
      + (eT > 0 && Math.abs(eT) > Math.abs(eC) ? '客單變高有一部分可能是商品漲價，不一定代表生意變好。' : '')
      + `只比今年和去年同一個星期幾都有資料的 ${b.k} 天。`
    : `來客少要看外部（天氣、假日、附近競爭）；客單低要看商品與促銷。${b.k < dsDaysIn(ym) && ym === dsToday().slice(0, 7) ? `本月只有 ${b.k} 天資料，比的是日均。` : ''}`;
  return `<div class="card">${title}
    <div class="say">日均營業額 <b>${dsMoney(b.S)}</b>，比${lbl} <b class="${dS >= 0 ? 'hi' : 'lo'}">${dsSigned(dS, dsMoney)} 元（${dsSigned(dS / a.S * 100, v => v.toFixed(1))}%）</b>，主要是<b>${main}</b>：</div>
    ${row('每天來客', dsMoney(a.C), dsMoney(b.C), '人', eC)}
    ${row('客單價', dsMoney(a.T), dsMoney(b.T), '元', eT)}
    <div class="note">兩項加起來等於日均營業額的變化。不含大單日。${hint}</div></div>`;
}

// ── 圖表元件 ──
// 折線圖直接用卡片寬度畫（不靠 viewBox 縮放）：手機上字才不會被縮小（見專案記憶 project_pnl ③）
function dsLegend(items) {
  return `<div class="lgd">${items.map(([c, l, s]) => `<span><i style="border-top:${s === 'dot' ? '2px dotted' : s === 'dash' ? '2px dashed' : '2.5px solid'} ${c}"></i>${l}</span>`).join('')}</div>`;
}
function dsNiceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function dsLineChart(o) {
  const W = o.W, H = 190, L = 40, R = 12, T = 14, B = 22, n = o.n;
  const all = [];
  o.series.forEach(s => s.vals.forEach(v => { if (v != null) all.push(v); }));
  (o.refs || []).forEach(r => all.push(r.v));
  let lo = o.zero ? 0 : Math.min(...all), hi = Math.max(...all);
  if (!o.zero) { const pad = (hi - lo) * 0.12 || hi * 0.05 || 1; lo -= pad; hi += pad; }
  const step = dsNiceStep((hi - lo) / 4 || 1);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = i => L + (n <= 1 ? 0 : i * (W - L - R) / (n - 1));
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  let g = '';
  for (let v = lo; v <= hi + step / 2; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#eef2f7"/><text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" class="ax">${dsAxis(v)}</text>`;
  const every = Math.ceil(n * 22 / (W - L - R));
  for (let i = 0; i < n; i++) if (i % every === 0 || i === n - 1) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="ax">${o.xl(i)}</text>`;
  (o.refs || []).forEach(r => { g += `<line x1="${L}" x2="${W - R}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5 4"/>`; });
  o.series.forEach(s => {
    let d = '', pen = false;
    s.vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
    if (d) g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
    if (o.dots && (s.dots || (s === o.series[0] && !o.series.some(z => z.dots)))) s.vals.forEach((v, i) => { if (v != null) g += `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${s.color}"/>`; });
  });
  (o.marks || []).forEach(m => {
    const tx = Math.min(Math.max(x(m.i), L + 28), W - R - 28);
    g += `<circle cx="${x(m.i)}" cy="${y(m.v)}" r="4.5" fill="#fff" stroke="${m.big ? '#a15c00' : '#1a73e8'}" stroke-width="2"/><text x="${tx}" y="${m.below ? y(m.v) + 16 : y(m.v) - 8}" text-anchor="middle" class="mk${m.big ? ' bg' : ''}">${m.t}</text>`;
  });
  // 點擊熱區：每天一條直欄，比點本身大很多
  const cw = n <= 1 ? W - L - R : (W - L - R) / (n - 1);
  let hit = '';
  for (let i = 0; i < n; i++) if (o.tips[i]) hit += `<rect x="${x(i) - cw / 2}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent" data-tip="${dsEsc(o.tips[i])}" data-x="${x(i)}" onclick="dsTip(this)"/>`;
  return `<div class="chart"><svg width="${W}" height="${H}" role="img">${g}<line class="hl" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#334155" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>${hit}</svg><div class="chart-tip">點圖看每天的數字</div></div>`;
}
function dsTip(el) {
  const box = el.closest('.chart'), hl = box.querySelector('.hl'), xx = el.getAttribute('data-x');
  hl.setAttribute('x1', xx); hl.setAttribute('x2', xx); hl.style.display = '';
  const tip = box.querySelector('.chart-tip'); tip.textContent = el.getAttribute('data-tip'); tip.classList.add('on');
}

function dsRenderList(data) {
  const ds = Object.keys(data.days).sort().reverse();
  const head = `<div class="card-title">📋 ${+data.ym.slice(5)}月明細<span class="sub">${dsMonthSel()}</span></div>`;
  if (!ds.length) return `<div class="card">${head}<div class="empty">這個月還沒有輸入資料</div></div>`;
  const rows = ds.map(d => { const x = data.days[d], h = data.hours[d];
    return `<tr class="click" onclick="dsEditDay('${d}')"><td>${dsMd(d)}（${dsWdOf(d)}）<small>${dsEsc(x.updatedByName || x.updatedBy || '')}</small></td><td>${dsMoney(x.sales)}</td><td>${x.customers != null ? dsMoney(x.customers) : '—'}<small>${x.customers ? '客單 ' + dsMoney(x.sales / x.customers) : ''}</small></td><td>${h ? dsMoney(x.sales / h) : '—'}</td></tr>`; }).join('');
  return `<div class="card">${head}<table class="tbl"><thead><tr><th>日期</th><th>營業額</th><th>來客</th><th>每工時</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="note">點一列可以修改那天的資料。</div></div>`;
}
async function dsEditDay(d) {
  const el = document.getElementById('dsDate'); el.value = d;
  await dsPickDate(d);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ───────── 店長：指派作帳人員 ─────────
async function dsRenderWho(el) {
  const snap = await dsRef().collection('employees').get().catch(() => null);
  dsEmps = [];
  if (snap) snap.forEach(d => { const e = d.data(); if (!['離職', '調走'].includes(e.status)) dsEmps.push({ name: d.id, sortKey: e.sortKey || 0 }); });
  dsEmps.sort((a, b) => a.sortKey - b.sortKey);
  const names = new Set(dsEmps.map(e => e.name));
  const gone = dsInputters.filter(n => !names.has(n)); // 已離職／調走但還在名單上的人，列出來讓店長取消
  el.innerHTML = `<div class="card"><div class="card-title">👤 作帳人員<span class="sub">${dsEsc(dsStoreName)}</span></div>
    <div class="chk-list">${dsEmps.concat(gone.map(n => ({ name: n, gone: true }))).map(e => `<label><input type="checkbox" value="${dsEsc(e.name)}"${dsInputters.includes(e.name) ? ' checked' : ''}>${dsEsc(e.name)}${e.gone ? '（已不在本店）' : ''}</label>`).join('')}</div>
    <label class="see-ana"><input type="checkbox" id="dsSeeAna"${dsShowAna ? ' checked' : ''}>作帳人員也看得到「📊 分析」（只有當月）</label>
    <button class="btn-primary" style="margin-top:12px;" onclick="dsSaveWho()">儲存</button>
    <div class="note">勾選的人在首頁選單會出現「輸入營業額」，只能輸入、修改最近 ${DS_EDIT_DAYS} 天。明細與指派只有店長看得到；分析（含業績進度、達標營業額）看上面的開關。</div></div>`;
}
async function dsSaveWho() {
  const list = [...document.querySelectorAll('.chk-list input:checked')].map(i => i.value);
  try {
    const see = !!document.getElementById('dsSeeAna')?.checked;
    await dsRef().collection('config').doc('dailySales').set({ inputters: list, inputterSeeAna: see, updatedBy: dsUser.empName || '', updatedAt: new Date().toISOString() }, { merge: true });
    dsInputters = list; dsShowAna = see;
    dsToast(`✅ 已儲存（${list.length} 人）`);
  } catch (e) { dsToast('❌ 儲存失敗：' + e.message); }
}

// ───────── 首次說明（使用者 2026-10-11：實驗性功能、說明好處、鼓勵記錄）─────────
// 看過紀錄：本機 localStorage（快）＋ users/{uid}.appUsage.dsIntroSeen（換手機、新裝主畫面 App 不會再跳）。
// 放在 appUsage 底下是因為它本來就在 users 規則的「本人可改」清單，不必為一個旗標改規則。
function dsIntroKey() { return 'dsIntroSeen:' + (dsUser?.empName || ''); }
async function dsMaybeIntro() {
  try { if (localStorage.getItem(dsIntroKey())) return; } catch (e) {}
  const uid = firebase.auth().currentUser?.uid;
  if (uid) {
    const u = await window.db.collection('users').doc(uid).get().catch(() => null);
    if (u && u.exists && ((u.data().appUsage || {}).dsIntroSeen)) { try { localStorage.setItem(dsIntroKey(), '1'); } catch (e) {} return; }
  }
  dsShowIntro();
}
function dsShowIntro() {
  const lead = dsRole === 'lead';
  const item = (ic, t, d) => `<div class="intro-item"><span class="ic">${ic}</span><div><b>${t}</b>${d}</div></div>`;
  const items = lead ? [
    item('📅', '看出星期幾生意好、哪天人排太多', '每工時營業額按星期比，最低的那天就是可以調整人力的地方。'),
    item('🧮', '客單價每天看得到', '不用等下個月的損益表，月中就知道走勢。'),
    item('⏱️', '之後讓工時上限跟著實際業績調整', '資料累積一兩個月、確認跟損益表對得上後，排班頁的上限會改用這個月的實際營業額。'),
  ] : [
    item('🧾', '早班日結後，輸入當天兩個數字', '照現金日報表填 111 本日實際銷貨收入、101 本日來客數，大約 30 秒；數字在哪裡，輸入框下方有說明。'),
    item('🙌', '幫門市排出剛好的人力', '店長會用這些數字看哪天生意好、哪天人排太多。'),
  ];
  document.getElementById('dsIntro').innerHTML = `<div class="intro-box">
    <span class="intro-tag">🧪 實驗性功能</span>
    <div class="intro-title">每日營業記錄</div>
    <div class="intro-lead">${lead ? '每天記下營業額、來客數，累積越多天，分析越準。' : '店長指派你負責記錄每天的營業數字。'}</div>
    ${items.join('')}
    <div class="intro-foot">${lead ? '不強制輸入，有記錄才看得到分析；可以在「作帳人員」指派日結的人代為輸入。功能還在試用，有覺得不好用的地方歡迎回饋。' : '可以修改最近 7 天的資料。功能還在試用，有覺得不好用的地方請跟店長說。'}</div>
    <button class="btn-primary" onclick="dsCloseIntro()">開始記錄</button>
  </div>`;
  document.getElementById('dsIntro').style.display = 'flex';
}
function dsCloseIntro() {
  document.getElementById('dsIntro').style.display = 'none';
  try { localStorage.setItem(dsIntroKey(), '1'); } catch (e) {}
  const uid = firebase.auth().currentUser?.uid;
  if (uid) window.db.collection('users').doc(uid).set({ appUsage: { dsIntroSeen: new Date().toISOString() } }, { merge: true }).catch(() => {});
}
