// 報廢條碼（2026-11-08 使用者）：總部「商品報廢條碼表」（自助區：滷味、熱食、蒸煮、熱狗、關東煮、其他）。
// 原本貼在 POS 旁，報廢時 KEY 或掃。三店共用一份；總部發新表 → 加盟主拍照給 Claude，抄錄後逐筆驗條碼檢查碼才寫入。
// 資料：settings/wasteBarcode = { items:[{cat,name,code,barcode}], sheet:'2026/08', updatedAt }（登入可讀、只有加盟主／admin 可寫）。
// 條碼大小照外部「條碼查詢」網站（JsBarcode height 35、width 1.5、卡片最高 60px），手機兩欄。
let wbItems = [], wbCat = '全部', wbMeta = {};
const wbEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wbNorm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

window.onload = async () => {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  const fb = await new Promise((r) => { const u = firebase.auth().onAuthStateChanged((x) => { u(); r(x); }); });
  if (!fb) { location.replace('home.html'); return; }
  try {
    const d = await window.db.collection('settings').doc('wasteBarcode').get();
    if (!d.exists) throw new Error('還沒有資料');
    wbMeta = d.data(); wbItems = wbMeta.items || [];
  } catch (e) {
    document.getElementById('state').innerHTML = '讀取失敗：' + wbEsc(e.message) + '<br><button onclick="location.reload()">重新載入</button>';
    return;
  }
  document.getElementById('state').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('meta').textContent = `總部商品報廢條碼表（${wbMeta.sheet || ''} 版）・共 ${wbItems.length} 項・三店共用。掃不到就直接 KEY 品號。`;
  wbRender();
};

function wbCats() { return ['全部'].concat([...new Set(wbItems.map((x) => x.cat))]); }
function wbSetCat(c) { wbCat = c; wbRender(); }

function wbRender() {
  const q = wbNorm(document.getElementById('q').value);
  const hit = (x) => !q || wbNorm(x.name).includes(q) || x.code.includes(q) || x.barcode.includes(q);
  const pool = wbItems.filter(hit);
  // 有搜尋字就搜全部類別（打「黑輪」滷味、關東煮都要出來）
  const shown = q ? pool : pool.filter((x) => wbCat === '全部' || x.cat === wbCat);
  document.getElementById('tabs').innerHTML = wbCats().map((c) => {
    const n = c === '全部' ? pool.length : pool.filter((x) => x.cat === c).length;
    return `<button class="tab${!q && c === wbCat ? ' active' : ''}" onclick="wbSetCat('${wbEsc(c)}')">${wbEsc(c)}<span class="n">${n}</span></button>`;
  }).join('');
  const el = document.getElementById('list');
  if (!shown.length) { el.innerHTML = '<div class="state">找不到，可以改用「品號查詢」或「條碼查詢」</div>'; return; }
  const mk = (s) => q ? wbEsc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`) : wbEsc(s);
  const groups = [];
  shown.forEach((x) => { let g = groups.find((y) => y.cat === x.cat); if (!g) groups.push(g = { cat: x.cat, xs: [] }); g.xs.push(x); });
  let i = 0;
  el.innerHTML = groups.map((g) => `<div class="cat">${wbEsc(g.cat)}</div><div class="grid">` + g.xs.map((x) =>
    `<div class="card"><div class="nm">${mk(x.name)}</div><div class="no">品號 <b>${mk(x.code)}</b></div><div class="bc"><svg id="wb${i++}" data-v="${x.barcode}"></svg></div></div>`
  ).join('') + '</div>').join('');
  el.querySelectorAll('svg[data-v]').forEach((svg) => {
    const v = svg.dataset.v;
    try { JsBarcode(svg, v, { format: v.length === 8 ? 'EAN8' : 'EAN13', displayValue: true, height: 35, margin: 0, width: 1.5 }); }
    catch (e) { svg.outerHTML = `<div class="no">${wbEsc(v)}（無法產生條碼）</div>`; }
  });
}
