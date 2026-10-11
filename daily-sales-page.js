// ===== 每日營業（2026-10-11）=====
// 每天輸入營業額（含稅，PSD＝日結單 111「本日實際銷貨收入」，含代銷隨取）、來客數、報廢。不強制輸入。
// 使用者定案：
//   - 一個營業日＝晚班＋夜班＋早班，早班日結後才有數字 → 日期預設「今天」。
//   - 店長：輸入／修改（不限天數）、看本店分析、指派「作帳人員」。加盟主／admin：看三店。
//   - 作帳人員（config/dailySales.inputters）：只看得到輸入畫面，可改最近 7 天，看不到分析。
//   - 先獨立：不進加盟主儀表板、不進經營報酬／工時上限分析（等驗證每日加總對得上損益表再說）。
// ⚠️ 「作帳人員看不到分析」是畫面層級；資料庫規則目前登入即可讀 stores/*（同損益），要真正擋住得等資安收緊。
// 名稱都帶 ds 前綴。

let dsUser = null, dsConfig = { stores: [] }, dsStoreName = '', dsRole = '', dsTab = 'ana', dsMonth = '';
let dsCache = {};        // 'store|YYYY-MM' -> { days:{date:doc}, hours:{bizDate:h} }
let dsEmps = [], dsInputters = [];
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
  } catch (e) { dsInputters = []; }
  dsRole = dsIsLeadOf(dsStoreName) ? 'lead' : (dsUser.store === dsStoreName && dsInputters.includes(dsUser.empName)) ? 'input' : '';
  if (!dsRole) { dsDeny(); return; }
  await dsLoadRecent();
  dsRenderInput();
  await dsPickDate(document.getElementById('dsDate').value);
  if (dsRole === 'lead') { document.getElementById('dsTabs').style.display = ''; await dsRenderTab(); }
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
    <div id="dsSavedTag" class="saved-tag"></div>
    <div class="f-row"><label>111 本日實際銷貨收入</label><input type="number" inputmode="numeric" id="dsSales" min="0" step="1" placeholder="${dsHint('sales', '例：65000')}"></div>
    <div class="f-grid">
      <div class="f-row"><label>101 本日來客數</label><input type="number" inputmode="numeric" id="dsCust" min="0" step="1" placeholder="${dsHint('customers', '例：600')}"></div>
      <div class="f-row"><label>報廢金額<small>（日報表上沒有）</small></label><input type="number" inputmode="numeric" id="dsWaste" min="0" placeholder="例：1200"></div>
    </div>
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

async function dsPickDate(date) {
  const tag = document.getElementById('dsSavedTag');
  ['dsSales', 'dsCust', 'dsWaste'].forEach(id => { document.getElementById(id).value = ''; });
  tag.textContent = ''; dsPicked = null;
  if (!date) return;
  const snap = await dsRef().collection('dailySales').doc(date).get().catch(() => null);
  if (snap && snap.exists) {
    const d = dsPicked = snap.data();
    document.getElementById('dsSales').value = d.sales ?? '';
    document.getElementById('dsCust').value = d.customers ?? '';
    document.getElementById('dsWaste').value = d.waste ?? '';
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
  const sales = num('dsSales'), cust = num('dsCust'), waste = num('dsWaste');
  if (sales == null) { dsToast('請輸入 111 本日實際銷貨收入'); return; }
  for (const [v, n] of [[sales, '銷貨收入'], [cust, '來客數'], [waste, '報廢']]) {
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
  if (sales && waste != null && waste > sales * 0.1) warns.push(`報廢 ${dsMoney(waste)} 超過銷貨收入的 10%`);
  const prev = dsRecent[shiftDateAdd(date, -1)];
  if (prev && prev.sales === sales) warns.push(`銷貨收入跟前一天（${dsMd(shiftDateAdd(date, -1))}）一模一樣，是不是看到前一天的日報表？`);
  if (warns.length && !confirm('請再看一次現金日報表：\n\n・' + warns.join('\n・') + '\n\n「111 本日實際銷貨收入」是「收銀機合計」欄倒數第二個數字。\n數字確定沒錯就按「確定」儲存。')) return;
  // 覆蓋已輸入的數字先確認
  const old = dsPicked && dsPicked.date === date ? dsPicked : dsRecent[date];
  if (old && (old.sales !== sales || (old.customers ?? null) !== cust || (old.waste ?? null) !== waste)
      && !confirm(`${dsMd(date)} 已經輸入過（銷貨收入 ${dsMoney(old.sales)}、來客 ${old.customers != null ? dsMoney(old.customers) : '—'}，${old.updatedByName || old.updatedBy || ''}），要改成新的數字嗎？`)) return;
  const btn = document.getElementById('dsSaveBtn'); btn.disabled = true;
  try {
    const ref = dsRef().collection('dailySales').doc(date);
    const now = new Date().toISOString(), who = dsUser.empName || '', whoName = dsUser.displayName || who;
    await window.db.runTransaction(async tx => {
      const s = await tx.get(ref);
      const base = { date, sales, customers: cust, waste, updatedBy: who, updatedByName: whoName, updatedAt: now };
      if (!s.exists) Object.assign(base, { createdBy: who, createdAt: now });
      tx.set(ref, base, { merge: true });
    });
    dsCache = {};
    dsRecent[date] = { date, sales, customers: cust, waste, updatedBy: who, updatedByName: whoName };
    dsToast('✅ 已儲存 ' + dsMd(date));
    await dsPickDate(date);
    if (dsRole === 'lead') await dsRenderTab();
  } catch (e) { dsToast('❌ 儲存失敗：' + e.message); }
  btn.disabled = false;
}

// ───────── 店長：分頁 ─────────
function dsSetTab(t) { dsTab = t; dsRenderTab(); }
async function dsRenderTab() {
  document.getElementById('dsTabs').innerHTML = [['ana', '📊 分析'], ['list', '📋 明細'], ['who', '👤 作帳人員']]
    .map(([k, l]) => `<button class="${dsTab === k ? 'on' : ''}" onclick="dsSetTab('${k}')">${l}</button>`).join('');
  const el = document.getElementById('dsMain');
  if (dsTab === 'who') { await dsRenderWho(el); return; }
  const data = await dsLoadMonth(dsStoreName, dsMonth);
  el.innerHTML = dsTab === 'ana' ? dsRenderAna(data) : dsRenderList(data);
}
function dsMonthSel() {
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
  const hours = {};
  snaps.forEach((s, i) => {
    if (!s || !s.exists) return;
    (s.data().records || []).forEach(r => {
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
  return (dsCache[key] = { ym, days, hours });
}

function dsRenderAna(data) {
  const ds = Object.keys(data.days).sort().filter(d => data.days[d].sales != null);
  const head = `<div class="card-title">📊 ${+data.ym.slice(5)}月分析<span class="sub">${dsMonthSel()}</span></div>`;
  if (!ds.length) return `<div class="card">${head}<div class="empty">這個月還沒有輸入資料</div></div>`;
  let S = 0, C = 0, Cn = 0, W = 0, Wn = 0, SH = 0, H = 0;
  ds.forEach(d => {
    const x = data.days[d]; S += +x.sales;
    if (x.customers != null) { C += +x.customers; Cn++; }
    if (x.waste != null) { W += +x.waste; Wn++; }
    if (data.hours[d]) { SH += +x.sales; H += data.hours[d]; }
  });
  const custDays = ds.filter(d => data.days[d].customers != null);
  const sCust = custDays.reduce((t, d) => t + +data.days[d].sales, 0);
  const sWaste = ds.filter(d => data.days[d].waste != null).reduce((t, d) => t + +data.days[d].sales, 0);
  const kpi = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  let html = `<div class="card">${head}<div class="kpis">
    ${kpi('營業額合計', dsWan(S), `${ds.length} 天有資料`)}
    ${kpi('日均營業額', dsWan(S / ds.length), '')}
    ${kpi('日均來客', Cn ? dsMoney(C / Cn) + ' 人' : '—', Cn ? `客單價 ${dsMoney(sCust / C)} 元` : '')}
    ${kpi('報廢率', Wn && sWaste ? (W / sWaste * 100).toFixed(2) + '%' : '—', Wn ? `報廢 ${dsWan(W)}` : '')}
    ${kpi('每工時營業額', H ? dsMoney(SH / H) + ' 元' : '—', H ? `班表 ${dsMoney(H)} 小時` : '班表沒有對應的班')}
  </div><div class="note">營業額為含稅金額。每工時營業額用班表排定時數（晚班、大夜算到隔天的營業日）。</div></div>`;
  // 星期幾平均（每個星期幾至少要有資料才列；整體資料滿 7 天才顯示，太少會被單日帶偏）
  if (ds.length >= 7) {
    const by = {};
    ds.forEach(d => {
      const w = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8)).getDay(), x = data.days[d];
      const b = by[w] = by[w] || { n: 0, s: 0, c: 0, cn: 0, sc: 0, sh: 0, h: 0 };
      b.n++; b.s += +x.sales;
      if (x.customers != null) { b.c += +x.customers; b.cn++; b.sc += +x.sales; }
      if (data.hours[d]) { b.sh += +x.sales; b.h += data.hours[d]; }
    });
    const order = [1, 2, 3, 4, 5, 6, 0].filter(w => by[w]);
    const sph = w => by[w].h ? by[w].sh / by[w].h : null;
    const vals = order.map(sph).filter(v => v != null), mx = Math.max(...vals), mn = Math.min(...vals);
    const rows = order.map(w => { const b = by[w], v = sph(w);
      return `<tr><td>週${DS_WD[w]}<small>${b.n} 天</small></td><td>${dsWan(b.s / b.n)}</td><td>${b.cn ? dsMoney(b.c / b.cn) : '—'}</td><td>${b.c ? dsMoney(b.sc / b.c) : '—'}</td><td class="${vals.length > 1 && v === mx ? 'hi' : vals.length > 1 && v === mn ? 'lo' : ''}">${v != null ? dsMoney(v) : '—'}</td></tr>`; }).join('');
    html += `<div class="card"><div class="card-title">📅 星期幾平均</div>
      <table class="tbl"><thead><tr><th>星期</th><th>營業額</th><th>來客</th><th>客單</th><th>每工時</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note">每工時營業額<span class="hi">綠色最高</span>、<span class="lo">紅色最低</span>：最低的那天，人力可能排得比生意需要的多。</div></div>`;
  } else {
    html += `<div class="card empty">再輸入 ${7 - ds.length} 天，就會顯示「星期幾平均」</div>`;
  }
  return html;
}

function dsRenderList(data) {
  const ds = Object.keys(data.days).sort().reverse();
  const head = `<div class="card-title">📋 ${+data.ym.slice(5)}月明細<span class="sub">${dsMonthSel()}</span></div>`;
  if (!ds.length) return `<div class="card">${head}<div class="empty">這個月還沒有輸入資料</div></div>`;
  const rows = ds.map(d => { const x = data.days[d], h = data.hours[d];
    return `<tr class="click" onclick="dsEditDay('${d}')"><td>${dsMd(d)}（${dsWdOf(d)}）<small>${dsEsc(x.updatedByName || x.updatedBy || '')}</small></td><td>${dsMoney(x.sales)}</td><td>${x.customers != null ? dsMoney(x.customers) : '—'}<small>${x.customers ? '客單 ' + dsMoney(x.sales / x.customers) : ''}</small></td><td>${x.waste != null ? dsMoney(x.waste) : '—'}</td><td>${h ? dsMoney(x.sales / h) : '—'}</td></tr>`; }).join('');
  return `<div class="card">${head}<table class="tbl"><thead><tr><th>日期</th><th>營業額</th><th>來客</th><th>報廢</th><th>每工時</th></tr></thead><tbody>${rows}</tbody></table>
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
    <button class="btn-primary" style="margin-top:12px;" onclick="dsSaveWho()">儲存</button>
    <div class="note">勾選的人在首頁選單會出現「輸入營業額」，只能輸入、修改最近 ${DS_EDIT_DAYS} 天，看不到分析與明細。</div></div>`;
}
async function dsSaveWho() {
  const list = [...document.querySelectorAll('.chk-list input:checked')].map(i => i.value);
  try {
    await dsRef().collection('config').doc('dailySales').set({ inputters: list, updatedBy: dsUser.empName || '', updatedAt: new Date().toISOString() }, { merge: true });
    dsInputters = list;
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
    item('🧮', '客單價、報廢率每天看得到', '不用等下個月的損益表，月中就知道走勢。'),
    item('⏱️', '之後讓工時上限跟著實際業績調整', '資料累積一兩個月、確認跟損益表對得上後，排班頁的上限會改用這個月的實際營業額。'),
  ] : [
    item('🧾', '早班日結後，輸入當天三個數字', '照現金日報表填 111 本日實際銷貨收入、101 本日來客數，再加報廢，大約 30 秒；數字在哪裡，輸入框下方有說明。'),
    item('🙌', '幫門市排出剛好的人力', '店長會用這些數字看哪天生意好、哪天人排太多。'),
  ];
  document.getElementById('dsIntro').innerHTML = `<div class="intro-box">
    <span class="intro-tag">🧪 實驗性功能</span>
    <div class="intro-title">每日營業記錄</div>
    <div class="intro-lead">${lead ? '每天記下營業額、來客數、報廢，累積越多天，分析越準。' : '店長指派你負責記錄每天的營業數字。'}</div>
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
