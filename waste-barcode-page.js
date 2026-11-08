// 報廢條碼（2026-11-08 使用者）：總部「商品報廢條碼表」（自助區：滷味、熱食、蒸煮、熱狗、關東煮、其他）。
// 原本貼在 POS 旁，報廢時 KEY 或掃。三店共用一份；總部發新表 → 加盟主拍照給 Claude，抄錄後逐筆驗條碼檢查碼才寫入。
// 資料：settings/wasteBarcode = { items:[{cat,name,code,barcode}], sheet:'2026/08', updatedAt }（登入可讀、只有加盟主／admin 可寫）。
// 條碼大小照外部「條碼查詢」網站（JsBarcode height 35、width 1.5、卡片最高 60px），手機兩欄。
//
// 個人排序＋常用（2026-11-08 使用者選「每個人自己排」，另外要「常用」頁）：
// 存在這支手機的 localStorage（key 依員工分開），換手機或重裝主畫面 App 會回到預設。
// ⚠️ 要跟著帳號走得改 firestore.rules 的 selfEditableKeys，先用模擬器測（本機目前沒 Java，見專案記憶）。
// 排序只記條碼：總部新表新增的商品排在該類最後、停售的自動消失。
let wbItems = [], wbCat = '全部', wbMeta = {}, wbSorting = false, wbPrefs = { cats: [], items: {}, fav: [] };
const WB_FAV = '常用';
const wbEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wbNorm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
let wbKey = 'wbPrefs';

window.onload = async () => {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { location.replace('home.html'); return; }
  try { const u = JSON.parse(saved); wbKey = 'wbPrefs:' + (u.empName || u.username || ''); } catch (e) {}
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
  try { const p = JSON.parse(localStorage.getItem(wbKey) || 'null'); if (p) wbPrefs = Object.assign(wbPrefs, p); } catch (e) {}
  if (wbPrefs.fav.length && wbItems.some((x) => wbPrefs.fav.includes(x.barcode))) wbCat = WB_FAV;
  document.getElementById('state').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('meta').textContent = `總部商品報廢條碼表（${wbMeta.sheet || ''} 版）・共 ${wbItems.length} 項・三店共用。掃不到就直接 KEY 品號。`;
  wbRender();
};
function wbSave() { try { localStorage.setItem(wbKey, JSON.stringify(wbPrefs)); } catch (e) {} }

// ── 依個人設定排好的類別與商品 ──
function wbCatList() {
  const base = [...new Set(wbItems.map((x) => x.cat))];
  return wbPrefs.cats.filter((c) => base.includes(c)).concat(base.filter((c) => !wbPrefs.cats.includes(c)));
}
function wbSorted(list, order) {
  const pos = {}; (order || []).forEach((b, i) => { pos[b] = i; });
  return list.map((x, i) => [x, x.barcode in pos ? pos[x.barcode] : 1e6 + i]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
}
function wbItemsOf(cat) {
  if (cat === WB_FAV) return wbPrefs.fav.map((b) => wbItems.find((x) => x.barcode === b)).filter(Boolean);
  return wbSorted(wbItems.filter((x) => x.cat === cat), wbPrefs.items[cat]);
}
function wbIsFav(b) { return wbPrefs.fav.includes(b); }
function wbToggleFav(b) {
  wbPrefs.fav = wbIsFav(b) ? wbPrefs.fav.filter((x) => x !== b) : wbPrefs.fav.concat([b]);
  wbSave(); wbRender();
}
function wbSetCat(c) { wbCat = c; wbRender(); }
function wbToggleSort() { wbSorting = !wbSorting; if (wbSorting) document.getElementById('q').value = ''; wbRender(); }
function wbMoveCat(i, d) {
  const cs = wbCatList(), j = i + d; if (j < 0 || j >= cs.length) return;
  [cs[i], cs[j]] = [cs[j], cs[i]]; wbPrefs.cats = cs; wbSave(); wbRender();
}
function wbMoveItem(cat, i, d) {
  const xs = wbItemsOf(cat).map((x) => x.barcode), j = i + d; if (j < 0 || j >= xs.length) return;
  [xs[i], xs[j]] = [xs[j], xs[i]];
  if (cat === WB_FAV) wbPrefs.fav = xs; else wbPrefs.items[cat] = xs;
  wbSave(); wbRender();
}
function wbReset() {
  if (wbCat === WB_FAV) return;
  if (wbCat === '全部') { wbPrefs.cats = []; wbPrefs.items = {}; } else delete wbPrefs.items[wbCat];
  wbSave(); wbRender();
}

function wbRender() {
  const q = wbSorting ? '' : wbNorm(document.getElementById('q').value);
  const hit = (x) => !q || wbNorm(x.name).includes(q) || x.code.includes(q) || x.barcode.includes(q);
  const cats = wbCatList(), favN = wbItemsOf(WB_FAV).length;
  const tabs = [WB_FAV, '全部'].concat(cats);
  if (!tabs.includes(wbCat)) wbCat = '全部';
  document.getElementById('tabs').innerHTML = tabs.map((c) => {
    const n = c === WB_FAV ? favN : c === '全部' ? wbItems.filter(hit).length : wbItems.filter((x) => x.cat === c && hit(x)).length;
    return `<button class="tab${!q && c === wbCat ? ' active' : ''}" onclick="wbSetCat('${wbEsc(c)}')">${c === WB_FAV ? '⭐ ' : ''}${wbEsc(c)}<span class="n">${n}</span></button>`;
  }).join('');
  const sb = document.getElementById('sortBtn'); sb.textContent = wbSorting ? '✓ 完成' : '↕ 排序'; sb.classList.toggle('on', wbSorting);
  document.getElementById('q').disabled = wbSorting;
  const el = document.getElementById('list');
  if (wbSorting) { el.innerHTML = wbSortView(cats); return; }
  // 有搜尋字就搜全部類別（打「黑輪」滷味、關東煮都要出來）
  let groups;
  if (q) groups = cats.map((c) => ({ cat: c, xs: wbItemsOf(c).filter(hit) })).filter((g) => g.xs.length);
  else if (wbCat === '全部') groups = cats.map((c) => ({ cat: c, xs: wbItemsOf(c) }));
  else groups = [{ cat: wbCat, xs: wbItemsOf(wbCat) }];
  if (!q && wbCat === WB_FAV && !favN) { el.innerHTML = '<div class="state">還沒有常用商品<br>在商品卡片右上角點 ☆，就會出現在這裡</div>'; return; }
  if (!groups.some((g) => g.xs.length)) { el.innerHTML = '<div class="state">找不到，可以改用「品號查詢」或「條碼查詢」</div>'; return; }
  const mk = (s) => q ? wbEsc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`) : wbEsc(s);
  let i = 0;
  el.innerHTML = groups.map((g) => (groups.length > 1 || g.cat === WB_FAV ? `<div class="cat">${g.cat === WB_FAV ? '⭐ ' : ''}${wbEsc(g.cat)}</div>` : '') + '<div class="grid">' + g.xs.map((x) =>
    `<div class="card"><div class="top"><div class="nm">${mk(x.name)}</div><button class="star${wbIsFav(x.barcode) ? ' on' : ''}" onclick="wbToggleFav('${x.barcode}')" aria-label="${wbIsFav(x.barcode) ? '取消常用' : '加到常用'}">${wbIsFav(x.barcode) ? '★' : '☆'}</button></div>` +
    `<div class="no">品號 <b>${mk(x.code)}</b></div><div class="bc"><svg id="wb${i++}" data-v="${x.barcode}"></svg></div></div>`
  ).join('') + '</div>').join('');
  el.querySelectorAll('svg[data-v]').forEach((svg) => {
    const v = svg.dataset.v;
    try { JsBarcode(svg, v, { format: v.length === 8 ? 'EAN8' : 'EAN13', displayValue: true, height: 35, margin: 0, width: 1.5 }); }
    catch (e) { svg.outerHTML = `<div class="no">${wbEsc(v)}（無法產生條碼）</div>`; }
  });
}

// 排序模式：「全部」調類別順序；選了某一類（或常用）就調那一類的商品順序。用 ↑↓ 按鈕（手機拖曳容易誤觸）
function wbSortView(cats) {
  const btn = (on, js, t) => `<button class="mv" ${on ? '' : 'disabled'} onclick="${js}">${t}</button>`;
  if (wbCat === '全部') {
    return `<div class="note">調整類別順序（上面的類別按鈕也會照這個順序）。要排商品，先點上面某一類。</div><div class="slist">` +
      cats.map((c, i) => `<div class="srow"><span class="sn">${wbEsc(c)}</span>${btn(i > 0, `wbMoveCat(${i},-1)`, '↑')}${btn(i < cats.length - 1, `wbMoveCat(${i},1)`, '↓')}</div>`).join('') +
      `</div><button class="reset" onclick="wbReset()">全部恢復成總部表的順序</button>`;
  }
  const xs = wbItemsOf(wbCat);
  if (!xs.length) return '<div class="state">這一類沒有商品</div>';
  const c = wbEsc(wbCat).replace(/'/g, '');
  return `<div class="note">調整「${wbEsc(wbCat)}」的商品順序，只影響這支手機。</div><div class="slist">` +
    xs.map((x, i) => `<div class="srow"><span class="sn">${wbEsc(x.name)}<small>${x.code}</small></span>${btn(i > 0, `wbMoveItem('${c}',${i},-1)`, '↑')}${btn(i < xs.length - 1, `wbMoveItem('${c}',${i},1)`, '↓')}</div>`).join('') +
    `</div>` + (wbCat === WB_FAV ? '' : `<button class="reset" onclick="wbReset()">這一類恢復成總部表的順序</button>`);
}
