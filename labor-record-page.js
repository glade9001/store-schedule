// ===== 勞檢出勤表（2026-09-28）=====
// 從打卡系統的實際紀錄產出「一人一張」的月出勤紀錄表（列印後紙本簽名）與 Excel 明細。
// 使用者定案：只給店長以上（店長只看自己的店）、員工看不到、不做線上簽名；版面參考盤點資料的出勤記錄表。
// ⚠️ 跟盤點資料（inspection.html，時間人工填寫）不同：這裡只讀 stores/{店}/attendance 的實際打卡，
//    不提供任何修改；補登／代補／改時間／註銷都照實寫在備註，排了班沒打卡寫「無打卡紀錄」。
// 名稱都帶 lr 前綴。

let lrUser = null, lrConfig = { stores: [] }, lrData = null;

function lrToast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); }
function lrLoading(m) { document.getElementById('loadingText').textContent = m || '載入中…'; document.getElementById('loadingOverlay').classList.remove('hidden'); }
function lrLoaded() { document.getElementById('loadingOverlay').classList.add('hidden'); }
function lrBack() { const ref = new URLSearchParams(location.search).get('ref'); if (ref) location.href = ref; else if (history.length > 1) history.back(); else location.href = 'home.html'; }
function lrEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const lrIsOwner = () => ['owner', 'admin'].includes(lrUser?.permission);
const lrPad = n => String(n).padStart(2, '0');
const lrYmd = d => `${d.getFullYear()}-${lrPad(d.getMonth() + 1)}-${lrPad(d.getDate())}`;
const lrHm = ms => { const d = new Date(ms); return `${lrPad(d.getHours())}:${lrPad(d.getMinutes())}`; };
const lrHrs = h => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}:${lrPad(m % 60)}`; }; // 時數顯示到分鐘（勞基法：出勤紀錄記載至分鐘）
const LR_WD = ['日', '一', '二', '三', '四', '五', '六'];

window.onload = async () => {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  try { lrUser = JSON.parse(saved); } catch (e) { location.replace('home.html'); return; }
  const fb = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(x => { u(); r(x); }); });
  if (!fb) { location.replace('home.html'); return; }
  if (!['manager', 'owner', 'admin'].includes(lrUser?.permission)) { alert('僅店長以上可使用'); location.replace('home.html'); return; }
  try {
    const s = await window.db.collection('settings').doc('globalConfig').get();
    if (s.exists) lrConfig = s.data();
  } catch (e) {}
  const all = (lrConfig.stores || []).filter(s => s && s !== '人力支援');
  const stores = lrIsOwner() ? all : all.filter(s => s === lrUser.store);
  const sSel = document.getElementById('lrStore');
  sSel.innerHTML = stores.map(s => `<option value="${lrEsc(s)}"${s === lrUser.store ? ' selected' : ''}>${lrEsc(s)}</option>`).join('');
  sSel.disabled = stores.length <= 1;
  // 月份：預設上個月（勞檢通常查已結束的月份），可選近 13 個月
  const mSel = document.getElementById('lrMonth'), now = new Date(), opts = [];
  for (let i = 0; i < 13; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); opts.push(`${d.getFullYear()}-${lrPad(d.getMonth() + 1)}`); }
  mSel.innerHTML = opts.map((m, i) => `<option value="${m}"${i === 1 ? ' selected' : ''}>${m.replace('-', ' 年 ')} 月${i === 0 ? '（本月，尚未結束）' : ''}</option>`).join('');
};

function lrReset() { lrData = null; document.getElementById('lrResult').innerHTML = ''; }

// ───────── 讀資料 ─────────
async function lrLoad(store, ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`, last = `${ym}-${lrPad(new Date(y, m, 0).getDate())}`;
  // 例假／休息日以「週一～週日」為一週判斷 → 月初、月底的週要多讀前後幾天，才看得到整週
  const { from: rFirst, to: rLast } = rdWeekRange(first, last);
  const stores = (lrConfig.stores || []).filter(s => s && s !== '人力支援');

  // 人員：這個月有在職過的本店員工。已離職的不列（使用者 2026-09-28）；月中調走的照列（人還在公司）
  const empSnap = await window.db.collection('stores').doc(store).collection('employees').get();
  const emps = [];
  empSnap.forEach(d => {
    const e = d.data();
    if (d.id.startsWith('🆘') || e.status === '離職') return;
    const eff = e.departDate || e.retireDate || e.transferDate || '';
    if (['離職', '調走'].includes(e.status) && eff && eff < first) return;
    if (e.startDate && e.startDate > last) return;
    emps.push({ name: d.id, role: e.role || '', pt: e.role === '工讀' || !!e.payAsPartTime, sortKey: e.sortKey ?? 999, status: e.status || '', eff: ['離職', '調走'].includes(e.status) ? eff : '', startDate: e.startDate || '' });
  });
  emps.sort((a, b) => a.sortKey - b.sortKey);
  const names = new Set(emps.map(e => e.name));

  // 顯示名稱（account.displayName）
  const disp = {};
  try { (await window.db.collection('account').where('store', '==', store).get()).forEach(d => { const a = d.data(); if (a.empName && a.displayName) disp[a.empName] = a.displayName; }); } catch (e) {}

  // 打卡：三店都要讀（支援日的班與打卡都記在對方店）；多讀一天接住最後一晚夜班的隔日下班
  const punches = [];
  await Promise.all(stores.map(async st => {
    const snap = await window.db.collection('stores').doc(st).collection('attendance').where('date', '>=', rFirst).where('date', '<=', shiftDateAdd(rLast, 1)).get();
    snap.forEach(d => { const r = d.data(); if (names.has(r.empName)) punches.push({ id: d.id, _store: st, ...r }); });
  }));

  // 班表：本店＋他店（他店的 🆘 待補格被本店員工認領＝去支援）
  // 每一天 → 「週次|星期」（用 shift-utils 的 shiftWeekStr／shiftDayName，不另寫週次公式）
  const dateOf = {}, weeks = [];
  for (let ds = rFirst; ds <= rLast; ds = shiftDateAdd(ds, 1)) {
    const w = shiftWeekStr(ds);
    dateOf[w + '|' + shiftDayName(ds)] = ds;
    if (!weeks.includes(w)) weeks.push(w);
  }
  const sched = {}; // name|date → [{shift, where}]
  await Promise.all(stores.map(async st => {
    const snaps = await Promise.all(weeks.map(w => window.db.collection('stores').doc(st).collection('weeks').doc(w).get()));
    snaps.forEach((snap, i) => {
      if (!snap.exists) return;
      (snap.data().records || []).forEach(r => {
        const date = dateOf[weeks[i] + '|' + r.day];
        if (!date) return; // 不在讀取範圍
        const sh = String(r.shift || '').trim();
        if (!sh) return;
        const loc = String(r.location || '');
        if (st === store && names.has(r.name)) {
          // 本店班表；loc=支援X 是舊的衍生格（人去 X 店），照寫
          (sched[r.name + '|' + date] = sched[r.name + '|' + date] || []).push({ shift: sh, where: loc.startsWith('支援') ? loc.slice(2) : '' });
        } else if (st !== store && r.approvalStatus === 'approved' && String(r.supportEmp || '').startsWith(store + '-')) {
          const who = String(r.supportEmp).slice(store.length + 1);
          if (!names.has(who)) return;
          const k = who + '|' + date, arr = sched[k] = sched[k] || [];
          if (!arr.some(x => x.shift === sh && x.where === st)) arr.push({ shift: sh, where: st });
        }
      });
    });
  }));

  const hol = (typeof builtinHolidayMap === 'function') ? builtinHolidayMap() : {};
  return { store, ym, first, last, rFirst, rLast, emps, disp, punches, sched, hol };
}
// ───────── 整理成每人每天一列 ─────────
// 休的日子：沒排班或排休／指休，而且當天沒有任何打卡。特休、補休等請假不算（不能拿來抵例假或休息日）；
// 排了班但沒打卡算上班（多半是忘了打，不能當成休）。
const LR_REST = ['', '排休', '指休', '休', '例假', '休息日'];
function lrBuildEmp(D, emp) {
  const store = D.store;
  const recs = D.punches.filter(r => r.empName === emp.name);
  const gd = r => r.shiftDate || r.date;
  const t = r => (typeof r.tsMs === 'number' ? r.tsMs : Date.parse(r.deviceTs || ''));
  // 上下班配對：整段依時間順序配（不是逐日）——跨夜班的下班卡有些沒寫歸班日（shiftDate），
  // 逐日配會把 23:00 上班、隔天 01:10 下班拆成兩天各一張。上班後 16 小時內的下班算同一段，歸到上班那天。
  const MAX_SPAN = 16 * 3600000;
  const valid = recs.filter(r => !r.voided && r.status !== '缺卡' && (r.type === '上班' || r.type === '下班') && isFinite(t(r))).sort((a, b) => t(a) - t(b));
  const pairsBy = {};
  const put = (ds, pr) => (pairsBy[ds] = pairsBy[ds] || []).push(pr);
  let open = null;
  valid.forEach(p => {
    if (p.type === '上班') { if (open) put(gd(open), { in: open, out: null }); open = p; return; }
    if (open && t(p) - t(open) <= MAX_SPAN) { put(gd(open), { in: open, out: p }); open = null; return; }
    if (open) { put(gd(open), { in: open, out: null }); open = null; }
    put(gd(p), { in: null, out: p });
  });
  if (open) put(gd(open), { in: open, out: null });

  const employed = ds => (!emp.startDate || ds >= emp.startDate) && (!emp.eff || ds <= emp.eff);
  const all = []; // 讀取範圍內（完整的週）每一天
  for (let ds = D.rFirst; ds <= D.rLast; ds = shiftDateAdd(ds, 1)) {
    const wd = LR_WD[new Date(ds + 'T00:00:00').getDay()];
    const holName = D.hol[ds] || '';
    const sc = D.sched[emp.name + '|' + ds] || [];
    const schedTxt = sc.map(x => x.shift + (x.where && x.where !== store ? `（${x.where}）` : '')).join('、');
    const works = sc.some(x => !LR_REST.includes(x.shift) && !['特休', '補休'].includes(x.shift) && parseShiftSegs(x.shift).length > 0);
    const onLeave = sc.some(x => !LR_REST.includes(x.shift) && !(parseShiftSegs(x.shift).length > 0)); // 特休、補休、病假…
    const day = recs.filter(r => gd(r) === ds);
    const notes = [], st = { miss: 0, late: 0, lateMin: 0, fix: 0 };
    // 缺卡旗標：沒註銷＝還沒補；批次結案的也照實寫（沒有打卡就是沒有打卡）
    day.filter(r => r.status === '缺卡').forEach(r => {
      if (!r.voided) { notes.push(`${r.note || '缺卡'}（未補）`); st.miss++; }
      else if (r.batchClosed) { notes.push(`${r.note || '缺卡'}（未補，已結案）`); st.miss++; }
    });
    // 被註銷的打卡：照實列出
    day.filter(r => r.voided && r.status !== '缺卡' && isFinite(t(r))).forEach(r => notes.push(`已註銷 ${r.type || ''} ${lrHm(t(r))}${r.voidReason ? '（' + r.voidReason + '）' : ''}`));
    day.filter(r => !r.voided && r.status !== '缺卡' && r.type && r.type !== '上班' && r.type !== '下班' && isFinite(t(r)))
      .forEach(r => notes.push(`${r.type}打卡 ${lrHm(t(r))}`));
    const pairs = pairsBy[ds] || [];
    let hours = 0, complete = 0;
    // 時數（使用者 2026-09-28）：原則上依排定班別整點計算；遲到／早退依實際（取較少者）；
    // 已核准加班依實際；沒有對應班別（例：排休日出勤）只能依實際。跟出勤管理的「有效工時」同一套算法。
    const cells = pairs.map(pr => {
      const a = pr.in ? t(pr.in) : null, b = pr.out ? t(pr.out) : null;
      const actual = (a != null && b != null && b > a) ? (b - a) / 3600000 : null;
      const sc = shiftTotalHours((pr.in && pr.in.shift) || (pr.out && pr.out.shift) || '');
      const otOk = (pr.in && pr.in.otStatus === 'approved') || (pr.out && pr.out.otStatus === 'approved');
      const h = actual == null ? null : (sc > 0 && !otOk ? Math.min(actual, sc) : actual);
      if (h != null) { hours += h; complete++; }
      return { in: a != null ? lrHm(a) : '', out: b != null ? lrHm(b) : '', outNext: b != null && lrYmd(new Date(b)) !== ds, h };
    });
    // 每一筆打卡的註記（跟著配對走：跨夜的下班卡註記在上班那天）
    const pts = [];
    pairs.forEach(pr => { if (pr.in) pts.push(pr.in); if (pr.out) pts.push(pr.out); });
    pts.forEach(r => {
      const tag = [];
      if (r.type === '上班' && r.lateMin > 0) { tag.push(`遲到 ${r.lateMin} 分`); st.late++; st.lateMin += r.lateMin; }
      if (r.status === '早退') tag.push('早退');
      if (r.proxyBy) tag.push(`店長代補（${r.proxyBy}）`);
      else if (r.status === '補登' || r.source === 'manual') tag.push('補登');
      if (r.origTs && lrHm(Date.parse(r.origTs)) !== lrHm(t(r))) tag.push(`原打卡 ${lrHm(Date.parse(r.origTs))}`);
      if (r.otStatus === 'approved') tag.push('加班已核准');
      if (r._store !== store) tag.push(`於${r._store}`);
      if (r.status === '補登' || r.source === 'manual') st.fix++;
      if (tag.length) notes.push(`${r.type} ${lrHm(t(r))}：${tag.join('、')}`);
    });
    if (works && !pts.length && !day.some(r => r.status === '缺卡')) notes.push('無打卡紀錄');
    if (holName) notes.unshift(holName + (pts.length ? '出勤' : ''));
    const emp_ = employed(ds);
    const rest = emp_ && !pts.length && !works && !onLeave;
    // 時數只在至少有一段完整上下班時才寫（只有一張卡寫 0:00 會被看成上了 0 小時）
    all.push({ date: ds, wd, holName, schedTxt, off: !works && !pts.length, cells, hours: complete ? hours : null, worked: pts.length > 0, notes, st,
      employed: emp_, rest });
  }

  // ── 例假／休息日：規則在 rest-days.js（跟盤點資料共用）──
  rdLabelWeeks(all);
  // 工讀只寫「休」、不標例假／休息日與＊（使用者 2026-09-28）；整週無休照樣標（連上 7 天對工讀一樣違法）
  const partRole = emp.role === '工讀'; // 看職稱（跟盤點資料一致）；按時薪計薪的店長不算
  if (partRole) all.forEach(x => { x.restLabel = ''; x.star = false; });
  all.forEach(x => { if (x.noRest) x.notes.unshift('⚠️ 本週無休' + (partRole ? '' : '（例假出勤）')); });

  const rows = all.filter(x => x.date >= D.first && x.date <= D.last);
  const sum = { days: 0, hours: 0, late: 0, lateMin: 0, miss: 0, fix: 0, holDays: 0, rest: 0, star: 0, noRest: 0, satSun: 0 };
  rows.forEach(r => {
    if (r.worked) { sum.days++; sum.hours += r.hours || 0; if (r.holName) sum.holDays++; }
    sum.late += r.st.late; sum.lateMin += r.st.lateMin; sum.miss += r.st.miss; sum.fix += r.st.fix;
    if (r.rest) sum.rest++;
    if (r.star) sum.star++;
    if (r.noRest) sum.noRest++;
    if (r.wd === '六' || r.wd === '日') sum.satSun++;
  });
  return { emp, name: D.disp[emp.name] || emp.name, rows, sum };
}

// ───────── 畫面 ─────────
async function lrLoadAndShow() {
  const store = document.getElementById('lrStore').value, ym = document.getElementById('lrMonth').value;
  if (!store || !ym) return;
  lrLoading('讀取打卡與班表…');
  try {
    const D = await lrLoad(store, ym);
    lrData = { D, list: D.emps.map(e => lrBuildEmp(D, e)) };
  } catch (e) { lrLoaded(); lrToast('讀取失敗：' + e.message); return; }
  lrLoaded();
  const { D, list } = lrData;
  document.getElementById('lrResult').innerHTML = `<div class="card">
    <div class="sum-title">${lrEsc(D.store)}　${D.ym.replace('-', ' 年 ')} 月　共 ${list.length} 人</div>
    <table class="sum-table"><thead><tr><th>姓名</th><th>出勤天數</th><th>時數</th><th>遲到</th><th>缺卡未補</th><th>休假／六日</th><th>＊週</th></tr></thead><tbody>
    ${list.map(x => `<tr><td>${lrEsc(x.name)}<small>${lrEsc(x.emp.role)}${x.emp.status && x.emp.status !== '在職' ? '・' + lrEsc(x.emp.status) : ''}</small></td>
      <td>${x.sum.days}</td><td>${lrHrs(x.sum.hours)}</td><td>${x.sum.late ? x.sum.late + ' 次／' + x.sum.lateMin + ' 分' : '—'}</td>
      <td class="${x.sum.miss ? 'warn' : ''}">${x.sum.miss || '—'}</td>
      <td>${x.emp.pt ? '—' : `${x.sum.rest}／${x.sum.satSun}`}</td>
      <td class="${x.sum.noRest ? 'warn' : ''}">${x.sum.star || x.sum.noRest ? (x.sum.star ? x.sum.star + ' 週' : '') + (x.sum.noRest ? ` 無休 ${x.sum.noRest}` : '') : '—'}</td></tr>`).join('')}
    </tbody></table>
    <div class="btns"><button class="btn-primary" onclick="lrPrint()">🖨️ 列印／存 PDF（一人一頁）</button><button class="btn-outline" onclick="lrExcel()">📊 下載 Excel</button></div>
    <div class="meta">列印後請員工與店長在每頁下方簽名；列印對話框可以只選某幾頁。</div>
    <div class="star-help">「例假＊」＝該週只休一天：那天是例假，另外有一天是<b>休息日出勤</b>（需本人同意、並給付休息日加班費）。這個說明<b>不會印在紙上</b>，請員工在有「＊」的那一列旁手寫簽名確認。</div>
  </div>`;
}

// ───────── 列印（一人一頁；版面參考盤點資料的出勤記錄表）─────────
function lrPrint() {
  if (!lrData) return;
  const { D, list } = lrData;
  const [y, m] = D.ym.split('-').map(Number);
  document.getElementById('lrPrint').innerHTML = list.map(x => `
  <section class="sheet">
    <div class="sh-title">${lrEsc(D.store)}　出勤紀錄表</div>
    <div class="sh-sub"><span>姓名：<b>${lrEsc(x.name)}</b></span><span>職稱：${lrEsc(x.emp.role || '')}</span><span>期間：${y} 年 ${m} 月 1 日～${m} 月 ${+D.last.slice(8)} 日</span></div>
    <table class="sh-table">
      <thead><tr><th style="width:6%">日</th><th style="width:6%">星期</th><th style="width:15%">排定班別</th><th style="width:10%">上班</th><th style="width:12%">下班</th><th style="width:8%">時數</th><th>備註</th></tr></thead>
      <tbody>${x.rows.map(r => {
        const n = Math.max(1, r.cells.length);
        const cls = r.noRest ? 'norest' : (r.holName ? 'hol' : (r.off ? 'off' : ''));
        // 例假／休息日直接寫在排定班別（使用者 2026-09-28：不另開一欄）
        const schedCell = r.restLabel ? `<b>${r.restLabel}${r.star ? '＊' : ''}</b>` : (r.rest && !r.schedTxt ? '休' : lrEsc(r.schedTxt));
        return Array.from({ length: n }, (_, i) => {
          const c = r.cells[i] || { in: '', out: '', outNext: false };
          const first = i === 0;
          return `<tr class="${cls}">
            ${first ? `<td rowspan="${n}">${+r.date.slice(8)}</td><td rowspan="${n}">${r.wd}</td><td rowspan="${n}">${schedCell}</td>` : ''}
            <td>${c.in}</td><td>${c.out}${c.outNext && c.out ? '<small>(次日)</small>' : ''}</td>
            ${first ? `<td rowspan="${n}">${r.hours != null ? lrHrs(r.hours) : ''}</td><td rowspan="${n}" class="nt">${lrEsc(r.notes.join('；'))}</td>` : ''}
          </tr>`;
        }).join('');
      }).join('')}</tbody>
    </table>
    <div class="sh-sum">出勤天數：${x.sum.days} 天　總時數：${lrHrs(x.sum.hours)}　遲到：${x.sum.late} 次（${x.sum.lateMin} 分）　缺卡未補：${x.sum.miss}　國定假日出勤：${x.sum.holDays} 天${x.emp.pt ? '' : `　本月休假：${x.sum.rest} 天（週六日 ${x.sum.satSun} 天）`}</div>
    ${x.sum.noRest ? `<div class="sh-norest">⚠️ 有 ${x.sum.noRest} 週整週無休（例假出勤）</div>` : ''}
    <div class="sh-foot">例假／休息日：每週一～週日，最後一個休假日為例假、倒數第二個為休息日（特休、補休不計入）。時數＝依排定班別計算，遲到／早退依實際打卡扣除，已核准加班及無排班出勤依實際打卡；上下班時間照實記載至分鐘；資料取自打卡系統，列印時間 ${lrYmd(new Date())} ${lrHm(Date.now())}。</div>
    <div class="sh-confirm">本人確認上列出勤紀錄及時數正確無誤。排定班別以外於店內停留而未依規定申請加班者，係本人個人因素之非工作停留（如用餐、休息、等候交通等），非屬延長工作時間。</div>
    <div class="sh-sign"><div><span></span>員工簽名</div><div><span></span>日期</div><div><span></span>店長</div></div>
  </section>`).join('');
  window.print();
}

// ───────── Excel ─────────
function lrExcel() {
  if (!lrData || typeof XLSX === 'undefined') { lrToast('Excel 元件還沒載入，請稍候再試'); return; }
  const { D, list } = lrData;
  const detail = [['門市', '姓名', '職稱', '日期', '星期', '國定假日', '排定班別', '上班', '下班', '下班為次日', '時數(時:分)', '備註']];
  list.forEach(x => x.rows.forEach(r => {
    const cs = r.cells.length ? r.cells : [{ in: '', out: '', outNext: false, h: null }];
    cs.forEach((c, i) => detail.push([D.store, x.name, x.emp.role || '', r.date, r.wd, r.holName, i === 0 ? (r.restLabel ? r.restLabel + (r.star ? '＊' : '') : r.schedTxt) : '', c.in, c.out, c.outNext && c.out ? '是' : '',
      c.h != null ? lrHrs(c.h) : '', i === 0 ? r.notes.join('；') : '']));
  }));
  const summary = [['門市', '姓名', '職稱', '出勤天數', '總時數(時:分)', '遲到次數', '遲到分鐘', '缺卡未補', '補登筆數', '國定假日出勤天數', '本月休假天數', '週六日天數', '只休一天的週(＊)', '整週無休的週']];
  list.forEach(x => summary.push([D.store, x.name, x.emp.role || '', x.sum.days, lrHrs(x.sum.hours), x.sum.late, x.sum.lateMin, x.sum.miss, x.sum.fix, x.sum.holDays,
    x.emp.pt ? '' : x.sum.rest, x.emp.pt ? '' : x.sum.satSun, x.sum.star, x.sum.noRest]));
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(detail); ws1['!cols'] = [8, 10, 6, 11, 5, 10, 14, 7, 7, 6, 8, 60].map(w => ({ wch: w }));
  const ws2 = XLSX.utils.aoa_to_sheet(summary); ws2['!cols'] = [8, 10, 6, 8, 10, 8, 8, 8, 8, 12, 10, 8, 12, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, '彙總');
  XLSX.utils.book_append_sheet(wb, ws1, '出勤明細');
  XLSX.writeFile(wb, `勞檢出勤表_${D.store}_${D.ym}.xlsx`);
}
