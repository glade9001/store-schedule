// 月結與月報（2026-11-01）：店長月底逐項確認有沒有漏的事，再看這個月的業績、工時、出勤整理。
// 全部即時從現有資料算，不另外存檔。經營報酬不放這裡：店長看得到的頁面不露（見 labor-budget.js 檔頭）。
let mrUser = null, mrTab = 'check', mrData = null, mrSeq = 0;

const mrPad = n => String(n).padStart(2, '0');
const mrEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mrNum = v => v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US');
const mrWan = v => v == null || !isFinite(v) ? '—' : (Math.round(v / 1000) / 10) + ' 萬';
const mrYmd = d => `${d.getFullYear()}-${mrPad(d.getMonth() + 1)}-${mrPad(d.getDate())}`;
const mrDays = ym => new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
const mrDates = ym => Array.from({ length: mrDays(ym) }, (_, i) => `${ym}-${mrPad(i + 1)}`);
const mrDay = s => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8));
const mrShift = (s, k) => { const d = mrDay(s); d.setDate(d.getDate() + k); return mrYmd(d); };
const mrDocs = snap => { const a = []; if (snap) snap.forEach(d => a.push({ id: d.id, ...d.data() })); return a; };

/** 月底檢查：每項回傳 { name, n（還有幾件，0＝完成，null＝還不能判斷）, text, go } */
function mrCheckItems(d, today) {
  const att = d.attendance.filter(r => !r.voided);
  const missing = d.dates.filter(x => x <= today && !(d.daily[x] && d.daily[x].sales != null));
  const unpublished = d.weeks.filter(w => !(w.published || w.publishedAt));
  const sal = d.salary || {}, st = sal.status || 'draft', recs = sal.records || [];
  const signed = new Set(d.acks.filter(a => a.store === d.store && a.signedPayHash).map(a => a.empName));
  const unsigned = st === 'published' ? recs.filter(r => r.empName && !signed.has(d.displayOf[r.empName] || r.empName) && !signed.has(r.empName)).length : null;
  const pending = n => (n ? `還有 ${n} 筆` : '都處理完了');
  const items = [
    { name: '補登待審', n: d.requests.filter(r => r.status === 'pending').length, go: 'attendance.html' },
    { name: '加班待審', n: att.filter(r => r.otStatus === 'pending').length, go: 'attendance.html' },
    { name: '缺卡未補', n: att.filter(r => r.type === '缺卡').length, go: 'attendance.html' },
  ].map(x => ({ ...x, text: pending(x.n) }));
  items.push({ name: '班表發布', n: unpublished.length, text: unpublished.length ? `${unpublished.length} 週還沒發布` : '都發布了', go: 'schedule-V2.html?mode=admin' });
  items.push({ name: '每日營業', n: missing.length, text: missing.length ? `漏 ${missing.length} 天：${missing.slice(0, 3).map(x => +x.slice(8)).join('、')}${missing.length > 3 ? ' 號等' : ' 號'}` : '都輸入了', go: `daily-sales.html?store=${encodeURIComponent(d.store)}` });
  const pnlOk = d.pnl && d.pnl.operatingReward != null && d.pnl.operatingReward !== '';
  items.push({ name: '經營績效', n: pnlOk ? 0 : 1, text: pnlOk ? '已輸入' : '還沒輸入（次月收到損益表後）', go: 'performance.html' });
  const salText = { draft: '還沒送審', submitted: '等加盟主審核', published: '已發布' }[st] || st;
  items.push({ name: '薪資', n: st === 'published' ? 0 : 1, text: salText, go: 'salary.html' });
  items.push({ name: '薪資簽收', n: unsigned, text: unsigned == null ? '薪資發布後才看得到' : unsigned ? `還有 ${unsigned} 人沒簽` : '都簽了', go: 'salary.html' });
  return items;
}

/** 店長月報的數字 */
function mrReport(d) {
  let sales = 0, cust = 0, days = 0, s1 = 0, s0 = 0;
  d.dates.forEach(x => {
    const c = d.daily[x]; if (!c || c.sales == null) return;
    sales += +c.sales; cust += +c.customers || 0; days++;
    const ly = d.dailyLy[mrShift(x, -364)];
    if (ly && ly.sales != null) { s1 += +c.sales; s0 += +ly.sales; }
  });
  const flags = d.attendance.filter(r => r.type === '缺卡' || r.origType === '缺卡');
  const cards = d.attendance.filter(r => !r.voided && (r.type === '上班' || r.type === '下班'));
  const late = cards.filter(r => r.status === '遲到').length;
  const app = cards.filter(r => r.source === 'app').length;
  const byEmp = {};
  flags.forEach(r => { const k = r.displayName || r.empName || ''; byEmp[k] = (byEmp[k] || 0) + 1; });
  const perf = d.perf || {}, net = d.pnl ? +d.pnl.netSales : 0;
  return {
    sales: days ? sales : null, days, perDay: days ? sales / days : null, yoy: s0 ? s1 / s0 - 1 : null,
    custPerDay: days ? cust / days : null, ticket: cust ? sales / cust : null,
    hours: +perf.totalHours || null, labor: +perf.laborCost || null, laborRate: perf.laborCost && net ? perf.laborCost / net : null,
    miss: flags.length, requests: d.requests.length, late, appRate: cards.length ? app / cards.length : null,
    topMiss: Object.entries(byEmp).sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

async function mrFetch(store, ym) {
  const ref = window.db.collection('stores').doc(store), FP = firebase.firestore.FieldPath.documentId();
  const dates = mrDates(ym), first = dates[0], last = dates[dates.length - 1];
  const weekIds = [...new Set(dates.map(x => weekStrOfDate(mrDay(x))))];
  const [att, reqs, daily, dailyLy, salary, pnl, perf, acks, users, ...weeks] = await Promise.all([
    ref.collection('attendance').where('date', '>=', first).where('date', '<=', last).get().catch(() => null),
    ref.collection('attendanceRequests').where('targetDate', '>=', first).where('targetDate', '<=', last).get().catch(() => null),
    ref.collection('dailySales').where(FP, '>=', first).where(FP, '<=', last).get().catch(() => null),
    ref.collection('dailySales').where(FP, '>=', mrShift(first, -364)).where(FP, '<=', mrShift(last, -364)).get().catch(() => null),
    ref.collection('salary').doc(ym).get().catch(() => null),
    ref.collection('pnl').doc(ym).get().catch(() => null),
    ref.collection('perfSnapshot').doc(ym).get().catch(() => null),
    window.db.collection('salaryAck').where('month', '==', ym).get().catch(() => null),
    window.db.collection('users').where('store', '==', store).get().catch(() => null),
    ...weekIds.map(w => ref.collection('weeks').doc(w).get().catch(() => null)),
  ]);
  const toMap = snap => { const o = {}; mrDocs(snap).forEach(x => { o[x.id] = x; }); return o; };
  const displayOf = {}; mrDocs(users).forEach(u => { if (u.empName) displayOf[u.empName] = u.displayName || u.empName; });
  return {
    store, ym, dates, attendance: mrDocs(att), requests: mrDocs(reqs), daily: toMap(daily), dailyLy: toMap(dailyLy),
    salary: salary && salary.exists ? salary.data() : null, pnl: pnl && pnl.exists ? pnl.data() : null, perf: perf && perf.exists ? perf.data() : null,
    acks: mrDocs(acks), displayOf, weeks: weeks.map(s => (s && s.exists ? s.data() : {})),
  };
}

function mrRenderCheck() {
  const items = mrCheckItems(mrData, mrYmd(new Date()));
  const left = items.filter(x => x.n).length;
  return `<div class="card"><div class="card-title">✅ ${+mrData.ym.slice(5)} 月月底檢查<span class="sub">${left ? `還有 ${left} 項` : '全部完成'}</span></div>
    ${items.map(x => {
      const wait = x.n == null, done = !x.n && !wait;
      return `<button type="button" class="mr-row" data-go="${mrEsc(x.go)}"><span class="mr-ic">${wait ? '⏳' : done ? '✅' : '⚠️'}</span><span class="mr-t">${mrEsc(x.name)}</span><span class="mr-v ${done ? 'ok' : wait ? '' : 'bad'}">${mrEsc(x.text)}</span></button>`;
    }).join('')}</div>`;
}
function mrRenderReport() {
  const r = mrReport(mrData);
  const stat = (t, v, s) => `<div class="mr-stat"><b>${mrEsc(v)}</b><span>${mrEsc(t)}</span>${s ? `<small>${mrEsc(s)}</small>` : ''}</div>`;
  const pct = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  const yoy = r.yoy == null ? '' : `比去年 ${r.yoy >= 0 ? '+' : '−'}${Math.abs(r.yoy * 100).toFixed(1)}%`;
  return `<div class="card"><div class="card-title">💰 業績<span class="sub">已輸入 ${r.days} 天</span></div><div class="mr-grid">
      ${stat('營業額', mrWan(r.sales), yoy)}${stat('平均每天', mrNum(r.perDay) + ' 元')}${stat('每天來客', mrNum(r.custPerDay) + ' 人')}${stat('客單價', mrNum(r.ticket) + ' 元')}
    </div></div>
    <div class="card"><div class="card-title">🕐 工時與人事</div>${r.labor == null ? '<div class="note">薪資發布後才有這個月的工時與人事資料。</div>' : `<div class="mr-grid">
      ${stat('總工時', mrNum(r.hours) + ' 小時')}${stat('人事成本', mrWan(r.labor))}${stat('人事費率', pct(r.laborRate), r.laborRate == null ? '損益輸入後才算得出' : '')}
    </div>`}</div>
    <div class="card"><div class="card-title">🗂️ 出勤</div><div class="mr-grid">
      ${stat('缺卡（含已補）', r.miss + ' 次')}${stat('補登申請', r.requests + ' 筆')}${stat('遲到', r.late + ' 次')}${stat('App 打卡比例', pct(r.appRate))}
    </div>${r.topMiss.length ? `<div class="note">缺卡最多：${r.topMiss.map(([k, n]) => `${mrEsc(k)} ${n} 次`).join('、')}</div>` : ''}</div>`;
}
function mrRender() {
  document.getElementById('mrTabs').innerHTML = [['check', '月底檢查'], ['report', '店長月報']]
    .map(([k, t]) => `<button type="button" class="${k === mrTab ? 'on' : ''}" onclick="mrSetTab('${k}')">${t}</button>`).join('');
  document.getElementById('mrMain').innerHTML = mrTab === 'check' ? mrRenderCheck() : mrRenderReport();
}
function mrSetTab(t) { mrTab = t; mrRender(); }

async function mrLoad() {
  const seq = ++mrSeq, store = document.getElementById('mrStore').value, ym = document.getElementById('mrMonth').value;
  if (!store || !ym) return;
  document.getElementById('loadingOverlay').classList.remove('hidden');
  try {
    const d = await Promise.race([mrFetch(store, ym), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20000))]); // Firestore 沒有逾時
    if (seq !== mrSeq) return;
    mrData = d; mrRender();
  } catch (e) {
    console.warn('[月結與月報]', e);
    if (seq === mrSeq) document.getElementById('mrMain').innerHTML = '<div class="card empty">讀取失敗，請重新整理再試。</div>';
  }
  if (seq === mrSeq) document.getElementById('loadingOverlay').classList.add('hidden');
}

document.getElementById('mrMain').addEventListener('click', e => {
  const r = e.target.closest('[data-go]'); if (r) location.href = r.dataset.go;
});

window.onload = async () => {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  try { mrUser = JSON.parse(saved); } catch (e) { location.replace('home.html'); return; }
  const fb = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(x => { u(); r(x); }); });
  if (!fb) { location.replace('home.html'); return; }
  const owner = ['owner', 'admin'].includes(mrUser.permission);
  if (!owner && mrUser.permission !== 'manager') { location.replace('home.html'); return; }
  let all = [];
  try { const s = await window.db.collection('settings').doc('globalConfig').get(); if (s.exists) all = (s.data().stores || []).filter(x => x && x !== '人力支援'); } catch (e) {}
  const stores = owner ? all : [mrUser.store].filter(Boolean);
  const sel = document.getElementById('mrStore');
  sel.innerHTML = stores.map(s => `<option value="${mrEsc(s)}"${s === mrUser.store ? ' selected' : ''}>${mrEsc(s)}</option>`).join('');
  if (stores.length > 1) sel.style.display = '';
  // 上半月通常在處理上個月（使用者常在月初結帳），下半月看本月
  const now = new Date(), dflt = new Date(now.getFullYear(), now.getMonth() - (now.getDate() <= 15 ? 1 : 0), 1);
  document.getElementById('mrMonth').value = `${dflt.getFullYear()}-${mrPad(dflt.getMonth() + 1)}`;
  document.getElementById('mrMonth').max = `${now.getFullYear()}-${mrPad(now.getMonth() + 1)}`;
  await mrLoad();
};
