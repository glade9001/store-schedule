// ===== 勞檢資料（原「勞檢出勤表」2026-09-28；2026-11-25 改成單一入口：選月份 → 每個人的薪資單、出勤記錄表、該月輪班表）=====
// 從打卡系統的實際紀錄產出「一人一張」的月出勤紀錄表（列印後紙本簽名）與 Excel 明細。
// 使用者定案：只給店長以上（店長只看自己的店）、員工看不到、不做線上簽名；版面參考盤點資料的出勤記錄表。
// ⚠️ 跟盤點資料（inspection.html，時間人工填寫）不同：這裡只讀 stores/{店}/attendance 的實際打卡，
//    不提供任何修改；補登／代補／改時間／註銷都照實寫在備註，排了班沒打卡寫「無打卡紀錄」。
// 名稱都帶 lr 前綴。
// 2026-11-25：讀資料、整理、勞基法檢查、出勤表 HTML 拆到 labor-record-core.js（查看薪水也用同一份）；本檔只剩畫面。
//   員工端也看得到自己的出勤表並電子簽名（推翻 09-28「員工看不到、不做線上簽名」，使用者 2026-11-25 定案）。

let lrUser = null, lrData = null;   // lrConfig 在 labor-record-core.js
let lrMode = 'esign';   // 三個類別共用：'esign' 電子簽名版｜'blank' 空白版（手簽）

function lrToast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600); }
function lrLoading(m) { document.getElementById('loadingText').textContent = m || '載入中…'; document.getElementById('loadingOverlay').classList.remove('hidden'); }
function lrLoaded() { document.getElementById('loadingOverlay').classList.add('hidden'); }
function lrBack() { const ref = new URLSearchParams(location.search).get('ref'); if (ref) location.href = ref; else if (history.length > 1) history.back(); else location.href = 'home.html'; }
const lrIsOwner = () => ['owner', 'admin'].includes(lrUser?.permission);

window.onload = async () => {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  try { lrUser = JSON.parse(saved); } catch (e) { location.replace('home.html'); return; }
  const fb = await new Promise(r => { const u = firebase.auth().onAuthStateChanged(x => { u(); r(x); }); });
  if (!fb) { location.replace('home.html'); return; }
  await syncHolidayMapInto(LR_HOL, [new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1]); // 國定假日跟著系統設定（holidays.js）
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
// ───────── 畫面 ─────────
async function lrLoadAndShow() {
  const store = document.getElementById('lrStore').value, ym = document.getElementById('lrMonth').value;
  if (!store || !ym) return;
  lrLoading('讀取打卡與班表…');
  try {
    const D = await lrLoad(store, ym);
    const [acks, rel] = await Promise.all([lrLoadAcks(ym), lrLoadRelease(store, ym)]);
    lrData = { D, list: D.emps.map(e => lrBuildEmp(D, e)), acks, rel };
  } catch (e) { lrLoaded(); lrToast('讀取失敗：' + e.message); return; }
  lrLoaded();
  lrRender();
}
/** 本月所有人的薪資簽收（salaryAck，店長以上可讀）：empName → ack */
async function lrLoadAcks(ym) {
  const out = {};
  try { (await window.db.collection('salaryAck').where('month', '==', ym).get()).forEach(d => { const a = d.data(); if (a.empName) out[a.empName] = a; }); } catch (e) {}
  return out;
}
function lrSignCell(x) {
  const { D, acks } = lrData;
  const st = lrAttSignState(D.ym, acks[x.emp.name], lrAttHash(x));
  return st.ok ? `<td style="color:#137333;font-weight:700;">已簽 ${lrEsc(lrSignedAtText(st.at))}</td>`
    : `<td class="${st.text === '尚未電子簽署' || st.text.indexOf('重簽') >= 0 ? 'warn' : ''}">${lrEsc(st.text)}</td>`;
}
function lrReleaseCell(x) {
  const { D, rel } = lrData;
  if (D.ym < LR_VIEW_START) return '<td>—</td>';
  if (!x.law.length) return '<td style="color:#137333;font-weight:700;">已開放</td>';
  if (rel[x.emp.name]) return `<td><span style="color:#137333;font-weight:700;">已開放</span><small>店長確認</small> <button class="btn-mini" onclick="lrUnrelease('${lrEsc(x.emp.name).replace(/'/g, '&#39;')}')">取消開放</button></td>`;
  return `<td><span style="color:#9a3412;font-weight:700;">暫緩中</span> <button class="btn-mini" onclick="lrRelease('${lrEsc(x.emp.name).replace(/'/g, '&#39;')}')">開放給員工</button></td>`;
}
async function lrRelease(name) {
  const { D, list } = lrData;
  const x = list.find(v => v.emp.name === name);
  if (!x) return;
  if (!confirm(`開放「${x.name}」${D.ym.replace('-', ' 年 ')} 月的出勤記錄表給本人看與簽名？\n\n系統檢查到：\n・${x.law.join('\n・')}\n\n資料有錯請先修正（補登、改班表），修正後紅字消失會自動開放。`)) return;
  try {
    await lrSetRelease(D.store, D.ym, name, lrUser.displayName || lrUser.empName || '');
    lrData.rel = await lrLoadRelease(D.store, D.ym);
    lrRender();
    lrToast('已開放給員工');
  } catch (e) { lrToast('開放失敗：' + e.message); }
}
async function lrUnrelease(name) {
  const { D, list } = lrData;
  const x = list.find(v => v.emp.name === name);
  if (!x) return;
  if (!confirm(`取消開放「${x.name}」${D.ym.replace('-', ' 年 ')} 月的出勤記錄表？\n員工端會回到「店長確認中」。已經簽過的簽名不會被刪除。`)) return;
  try {
    await lrUnsetRelease(D.store, D.ym, name);
    lrData.rel = await lrLoadRelease(D.store, D.ym);
    lrRender();
    lrToast('已取消開放');
  } catch (e) { lrToast('取消失敗：' + e.message); }
}
function lrRender() {
  const { D, list } = lrData;
  document.getElementById('lrResult').innerHTML = `<div class="card">
    <div class="sum-title">${lrEsc(D.store)}　${D.ym.replace('-', ' 年 ')} 月　共 ${list.length} 人</div>
    <table class="sum-table"><thead><tr><th>姓名</th><th>出勤天數</th><th>時數</th><th>遲到</th><th>缺卡未補</th><th>休假／六日</th><th>＊週</th><th>勞基法</th><th>電子簽名</th><th>員工端出勤表</th></tr></thead><tbody>
    ${list.map(x => `<tr><td>${lrEsc(x.name)}<small>${lrEsc(x.emp.role)}${x.emp.status && x.emp.status !== '在職' ? '・' + lrEsc(x.emp.status) : ''}</small></td>
      <td>${x.sum.days}</td><td>${lrHrs(x.sum.hours)}</td><td>${x.sum.late ? x.sum.late + ' 次／' + x.sum.lateMin + ' 分' : '—'}</td>
      <td class="${x.sum.miss ? 'warn' : ''}">${x.sum.miss || '—'}</td>
      <td>${x.emp.pt ? '—' : `${x.sum.rest}／${x.sum.satSun}`}</td>
      <td class="${x.sum.noRest ? 'warn' : ''}">${x.sum.star || x.sum.noRest ? (x.sum.star ? x.sum.star + ' 週' : '') + (x.sum.noRest ? ` 無休 ${x.sum.noRest}` : '') : '—'}</td>
      <td class="${x.law.length ? 'warn' : ''}">${x.law.length ? x.law.length + ' 項' : '✓'}</td>
      ${lrSignCell(x)}${lrReleaseCell(x)}</tr>`).join('')}
    </tbody></table>
    ${list.some(x => x.law.length) ? `<div class="law-list" style="margin-top:10px;padding:10px 12px;border:1px solid #f5c2c0;background:#fdecea;border-radius:10px;color:#c5221f;font-size:13px;line-height:1.7;">
      <b>⚠️ 違反勞基法（依真實打卡與班表；不影響列印）</b>
      ${list.filter(x => x.law.length).map(x => `<div style="margin-top:4px;"><b>${lrEsc(x.name)}</b>${x.law.map(m => `<div>・${lrEsc(m)}</div>`).join('')}</div>`).join('')}
      <div style="color:#7f1d1d;font-size:11.5px;margin-top:4px;">檢查：正職「休」＝當月六日天數（國定假日不算）、連續 7 天要有一天休、前後班休息 ≥ 11 小時。國定假日沒上班寫「國」，不當例假或休息日。</div>
    </div>` : '<div class="meta" style="color:#137333;font-weight:700;">✅ 勞基法檢查通過</div>'}
    <div class="lr-out">
      <div class="lr-out-title">產出文件（${D.ym.replace('-', ' 年 ')} 月・全店）</div>
      <div class="lr-bar"><button class="lr-seg${lrMode === 'esign' ? ' on' : ''}" onclick="lrSetMode('esign')">電子簽名版</button><button class="lr-seg${lrMode === 'blank' ? ' on' : ''}" onclick="lrSetMode('blank')">空白版（手簽）</button></div>
      <button class="lr-big" onclick="lrShowSched()">📋 職員輪班表<span>每週一張</span></button>
      <button class="lr-big" onclick="lrPrint(lrMode, true)">🗂️ 出勤記錄表<span>一人一張</span></button>
      <button class="lr-big" onclick="lrShowPay()">💰 薪資單<span>兩人一頁</span></button>
      <div class="meta">按下去直接預覽印出來的樣子，右上角「🖨️ 列印 / 存 PDF」可以印或存成 PDF（列印對話框選「另存為 PDF」）。<button class="btn-mini" onclick="lrExcel()">📊 下載 Excel</button></div>
    </div>
    <div class="meta">電子簽名版：已電子簽署的印出簽名與簽署時間（到分鐘），沒簽或簽後有異動的印出狀態，請手簽；店長欄一律手簽。空白版＝全部手簽。列印對話框可以只選某幾頁。</div>
    ${D.ym >= LR_VIEW_START ? '<div class="meta">員工端出勤表：沒有勞基法紅字的，薪資發布後員工就看得到並一起簽名；有紅字的先暫緩，修正後自動開放，或確認無誤後按「開放給員工」。員工端看不到紅字內容。</div>' : ''}
    <div class="star-help">「例假＊」＝該週只休一天：那天是例假，另外有一天是<b>休息日出勤</b>（需本人同意、並給付休息日加班費）。這個說明<b>不會印在紙上</b>，請員工在有「＊」的那一列旁手寫簽名確認。</div>
  </div>`;
}

// ───────── 列印（一人一頁；版面參考盤點資料的出勤記錄表）─────────
// mode：'esign'＝電子簽名版（簽了且內容沒變的印簽名＋時間到分鐘；其餘印狀態字留給手簽）；'blank'＝空白版（全部手簽）
// asPdf：產生 PDF 檔（手機從主畫面開的 App 不支援列印，2026-11-25）
/** 電子簽名版的簽名欄：empName → {img, at, account, ver} 或 {text}；讀過的記在 lrData.sigs 不重讀 */
async function lrLoadSigs(xs) {
  const { D, acks } = lrData;
  const sigs = lrData.sigs = lrData.sigs || {};
  await Promise.all(xs.filter(x => !sigs[x.emp.name]).map(async x => {
      const ack = acks[x.emp.name], ver = lrAttHash(x), st = lrAttSignState(D.ym, ack, ver);
      if (!st.ok) { sigs[x.emp.name] = { text: st.text }; return; }
      try {
        const [sd, ud] = await Promise.all([
          window.db.collection('salaryAckSig').doc(`${ack.uid}_${D.ym}`).get(),
          window.db.collection('users').doc(ack.uid).get()]);
        const img = sd.exists && sd.data().signatureDataUrl;
        sigs[x.emp.name] = img ? { img, at: st.at, account: (ud.exists && (ud.data().ID || ud.data().username)) || '', ver } : { text: '找不到簽名圖，請手簽' };
      } catch (e) { sigs[x.emp.name] = { text: '讀不到簽名，請手簽' }; }
  }));
  return sigs;
}
async function lrPrint(mode, asPdf) {
  if (!lrData) return;
  const { D, list } = lrData;
  let sigs = {};
  if (mode === 'esign') { lrLoading('讀取電子簽名…'); sigs = await lrLoadSigs(list); lrLoaded(); }
  const html = list.map(x => lrSheetHtml(D, x, mode === 'esign' ? sigs[x.emp.name] : null)).join('');
  if (asPdf) {   // 預覽（手機用；使用者 2026-11-25：不用 PDF，直接預覽）
    pdfxPreview(html, `${D.store} ${D.ym.replace('-', ' 年 ')} 月 出勤紀錄表${mode === 'esign' ? '（電子簽名版）' : '（空白版）'}`);
    return;
  }
  document.getElementById('lrPrint').innerHTML = html;
  window.print();
}
// ───────── 三個類別（使用者 2026-11-25：跟盤點資料一樣三顆按鈕）：輪班表／出勤記錄表／薪資單 ─────────
function lrSetMode(m) { lrMode = m; lrRender(); }
/** 📋 職員輪班表：該月每週一張（全店），用排班系統同一支 drawScheduleCanvas */
async function lrShowSched() {
  if (!lrData) return;
  const { D } = lrData;
  lrLoading('畫輪班表…');
  try {
    const imgs = await lrWeekImages();
    lrLoaded();
    if (!imgs.length) { lrToast('這個月沒有班表資料'); return; }
    pdfxPreview(imgs.map(im => `<section class="sheet"><div class="sh-title">${lrEsc(D.store)}　職員輪班表　${lrEsc(im.label)}</div><img src="${im.src}" alt="" style="width:100%;display:block;"></section>`).join(''),
      `${D.store} ${D.ym.replace('-', ' 年 ')} 月 職員輪班表`);
  } catch (e) { lrLoaded(); lrToast('輪班表讀取失敗：' + e.message); }
}
/**
 * 💰 薪資單：兩人一頁（全店）。直接用薪資頁的薪資單（嵌入 salary.html?embed=1&pack=），算法與薪資頁完全一樣。
 * 全螢幕開一個框，裡面就是薪資頁產生的 A4 預覽。
 */
function lrShowPay() {
  if (!lrData) return;
  const { D } = lrData;
  const src = `salary.html?embed=1&store=${encodeURIComponent(D.store)}&month=${encodeURIComponent(D.ym)}&pack=${lrMode}`;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#e5e7eb;display:flex;flex-direction:column;';
  ov.innerHTML = `<div style="flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:10px 14px;padding-top:max(10px, env(safe-area-inset-top));background:#0f766e;color:#fff;">
      <div style="flex:1;font-size:16px;font-weight:800;">👀 ${lrEsc(D.store)} ${D.ym.replace('-', ' 年 ')} 月 薪資單${lrMode === 'esign' ? '（電子簽名版）' : '（空白版）'}</div>
      <button data-k="print" style="min-height:40px;padding:0 14px;border:0;border-radius:10px;background:#fbbf24;color:#1c2321;font-size:15px;font-weight:800;">🖨️ 列印 / 存 PDF</button>
      <button data-k="close" style="min-height:40px;padding:0 16px;border:0;border-radius:10px;background:#fff;color:#0f766e;font-size:15px;font-weight:800;">關閉</button></div>
    <iframe src="${src}" title="薪資單" style="flex:1;width:100%;border:0;background:#e5e7eb;"></iframe>`;
  // 只留外層這一條標題列（裡面薪資頁的預覽標題列在嵌入時隱藏）；列印＝印裡面那頁的預覽（它自己的列印樣式只印薪資單）
  ov.querySelector('[data-k=close]').onclick = () => ov.remove();
  ov.querySelector('[data-k=print]').onclick = () => { try { ov.querySelector('iframe').contentWindow.print(); } catch (e) { lrToast('還在載入，請稍候再按'); } };
  document.body.appendChild(ov);
}

/**
 * 該月每週的全店輪班表圖片（用排班系統同一支 drawScheduleCanvas 畫，格式完全一樣）
 * 回傳 [{label, src(dataURL)}]；同一個門市月份只畫一次
 */
async function lrWeekImages() {
  if (lrData.weekImgs) return lrData.weekImgs;
  const { D } = lrData;
  const stores = (lrConfig.stores || []).filter(s => s && s !== '人力支援');
  const weeks = [];
  for (let d = D.first; d <= D.last; d = shiftDateAdd(d, 1)) { const w = shiftWeekStr(d); if (!weeks.includes(w)) weeks.push(w); }
  const out = [];
  for (const wk of weeks) {
    const snaps = await Promise.all(stores.map(st => window.db.collection('stores').doc(st).collection('weeks').doc(wk).get().then(s => [st, s]).catch(() => [st, null])));
    const mine = snaps.find(([st]) => st === D.store);
    const records = (mine && mine[1] && mine[1].exists) ? (mine[1].data().records || []) : [];
    if (!records.length) continue;
    const all = [];
    snaps.forEach(([st, s]) => { if (s && s.exists) (s.data().records || []).forEach(r => all.push({ ...r, _store: st })); });
    const emps = D.emps.map(e => ({ name: e.name, role: e.role }));
    records.forEach(r => { if (r.name && !emps.some(e => e.name === r.name) && String(r.name).startsWith('🆘')) emps.push({ name: r.name, role: '待補' }); });
    // 週一～週日的「M/D」（同排班頁 getWeekDates）
    let mon = null;
    for (let d = shiftDateAdd(D.first, -6); d <= D.last; d = shiftDateAdd(d, 1)) { if (shiftWeekStr(d) === wk && shiftDayName(d) === '週一') { mon = d; break; } }
    if (!mon) continue;
    const dates = Array.from({ length: 7 }, (_, i) => { const d = shiftDateAdd(mon, i); return `${+d.slice(5, 7)}/${+d.slice(8, 10)}`; });
    const cv = document.createElement('canvas');
    try { drawScheduleCanvas(cv, D.store, wk, records, emps, dates, all); } catch (e) { continue; }
    out.push({ label: `${dates[0]}～${dates[6]}`, src: cv.toDataURL('image/png') });
  }
  lrData.weekImgs = out;
  return out;
}

// ───────── Excel ─────────
function lrExcel() {
  if (!lrData || typeof XLSX === 'undefined') { lrToast('Excel 元件還沒載入，請稍候再試'); return; }
  const { D, list } = lrData;
  const detail = [['門市', '姓名', '職稱', '日期', '星期', '國定假日', '排定班別', '上班', '下班', '下班為次日', '時數(小時)', '時數(時分)', '備註']];
  list.forEach(x => x.rows.forEach(r => {
    const cs = r.cells.length ? r.cells : [{ in: '', out: '', outNext: false, h: null }];
    cs.forEach((c, i) => detail.push([D.store, x.name, x.emp.role || '', r.date, r.wd, r.holName, i === 0 ? (r.holOff ? '國' : r.restLabel ? r.restLabel + (r.star ? '＊' : '') : r.schedTxt) : '', c.in, c.out, c.outNext && c.out ? '是' : '',
      c.h != null ? lrDec(c.h) : '', c.h != null ? lrHrs(c.h) : '', i === 0 ? r.notes.join('；') : '']));
  }));
  const summary = [['門市', '姓名', '職稱', '出勤天數', '總時數(小時)', '總時數(時分)', '遲到次數', '遲到分鐘', '缺卡未補', '補登筆數', '國定假日出勤天數', '本月休假天數', '週六日天數', '只休一天的週(＊)', '整週無休的週']];
  list.forEach(x => summary.push([D.store, x.name, x.emp.role || '', x.sum.days, lrDec(x.sum.hours), lrHrs(x.sum.hours), x.sum.late, x.sum.lateMin, x.sum.miss, x.sum.fix, x.sum.holDays,
    x.emp.pt ? '' : x.sum.rest, x.emp.pt ? '' : x.sum.satSun, x.sum.star, x.sum.noRest]));
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(detail); ws1['!cols'] = [8, 10, 6, 11, 5, 10, 14, 7, 7, 6, 9, 11, 60].map(w => ({ wch: w }));
  const ws2 = XLSX.utils.aoa_to_sheet(summary); ws2['!cols'] = [8, 10, 6, 8, 10, 12, 8, 8, 8, 8, 12, 10, 8, 12, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, '彙總');
  XLSX.utils.book_append_sheet(wb, ws1, '出勤明細');
  XLSX.writeFile(wb, `勞檢出勤表_${D.store}_${D.ym}.xlsx`);
}
