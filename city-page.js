// CITY手順查詢（員工）：只讀 admin 已發佈的 cityRecipes / citySpecs。
// 資料流程見 functions/city-sync.js 與 city-admin-page.js。
// ⚠️ 內容源自對方資料庫，畫面一律跳脫；圖片只接受我們自己的 Storage 網址。

// 與 functions/city-sync.js 的 KNOWN_MACHINES 相同順序（改一邊要改另一邊）
const CITY_MACHINES = ['不可思議茶Bar', '現萃茶', 'CITY CAFE', '精品咖啡', 'CITY PEARL', '珍珠飲品', '果汁Bar', '雙豆槽'];
const OUR_IMAGE_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/store-schedule-3b056-city/';
const TAB_NEW = '__new';
const LOAD_TIMEOUT_MS = 15000;

const C = { recipes: [], specs: [], tab: null, openId: null };
const $ = (id) => document.getElementById(id);
const collator = new Intl.Collator('zh-Hant-TW-u-co-zhuyin');

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function safeImg(url) { return typeof url === 'string' && url.startsWith(OUR_IMAGE_PREFIX) ? url : ''; }
function showToast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(showToast._t); showToast._t = setTimeout(() => t.classList.remove('show'), 2600); }
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 無痕模式等 */ } }

// ⚠️ Firestore SDK 的 get() 卡住時不會 reject（專案舊傷），自己加逾時
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// ===== 搜尋正規化 =====
// NFKC 會把全形英數、康熙部首（⾖→豆）轉成一般字；異體字（靑）NFKC 不處理，另外對照
const VARIANTS = { '靑': '青', '臺': '台', '眞': '真', '爲': '為', '裏': '裡', '峯': '峰', '菓': '果' };
function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[靑臺眞爲裏峯菓]/g, (c) => VARIANTS[c])
    .replace(/[\s'’‘`´.。,，、·・\-－_｜|/()（）]/g, '');
}

// ===== 初始化 =====
window.onload = async () => {
  const saved = lsGet('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { window.location.replace('home.html'); return; }
  const fbUser = await new Promise((r) => { const u = firebase.auth().onAuthStateChanged((fb) => { u(); r(fb); }); });
  if (!fbUser) { window.location.replace('home.html'); return; }
  window.addEventListener('popstate', () => { if (!$('detail').hidden) hideDetail(); });
  await load();
};

async function load() {
  $('state').hidden = false;
  $('state').textContent = '載入中...';
  $('app').hidden = true;
  try {
    const [r, s] = await withTimeout(Promise.all([
      window.db.collection('cityRecipes').get(),
      window.db.collection('citySpecs').get(),
    ]), LOAD_TIMEOUT_MS);
    C.recipes = r.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id, ...x,
        machine: x.machine || '其他',
        aliases: x.aliases || [],
        sections: (x.sections || []).filter((sec) => sec.text || safeImg(sec.image)),
        _t: norm(x.title), _a: (x.aliases || []).map(norm), _m: norm(x.machine), _c: norm((x.sections || []).map((sec) => sec.text).join(' ')),
      };
    });
    C.specs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    $('state').innerHTML = `${e.message === 'timeout' ? '連線逾時，網路可能不穩。' : '讀取失敗。'}<br><button class="header-back" style="background:var(--primary);" onclick="load()">重新整理</button>`;
    return;
  }
  // 還沒發佈任何做法時（剛上線、管理者整理中），先讓員工能用原本的工具，不要卡住
  if (!C.recipes.length) {
    $('state').innerHTML = '手順還在整理中，暫時請先用原本的查詢工具。<br><a class="header-back" style="display:inline-flex;align-items:center;margin-top:12px;background:var(--primary);text-decoration:none;" href="https://sh-line-liff.vercel.app/" target="_blank" rel="noopener">開啟原本的查詢工具</a>';
    return;
  }
  $('state').hidden = true;
  $('app').hidden = false;
  renderSpecs();
  const tabs = tabList();
  const last = lsGet('cityTab');
  C.tab = tabs.some((t) => t.key === last) ? last : tabs[0].key;
  renderTabs();
  renderList();
}

// ===== 基本規格速查 =====
// 每次進來都收合：展開後很長，會把機器分頁推到畫面外
function renderSpecs() {
  if (!C.specs.length) { $('specs').hidden = true; return; }
  const cats = new Map();
  [...C.specs].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).forEach((s) => {
    if (!cats.has(s.category)) cats.set(s.category, []);
    cats.get(s.category).push(s);
  });
  $('specsBody').innerHTML = [...cats].map(([cat, list]) => `
    <div class="spec-cat">${esc(cat)}</div>
    ${list.map((s) => `<div class="spec"><div class="spec-label">${esc(s.label)}</div><div class="spec-content">${esc(s.content)}</div></div>`).join('')}
  `).join('');
}
function toggleSpecs(force) {
  const open = typeof force === 'boolean' ? force : $('specsBody').hidden;
  $('specsBody').hidden = !open;
  $('specsChev').textContent = open ? '▾' : '▸';
  $('specsHead').setAttribute('aria-expanded', String(open));
}

// ===== 機器分頁 =====
const active = () => C.recipes.filter((r) => !r.discontinued);
function tabList() {
  const list = active();
  const tabs = [];
  const pinned = list.filter((r) => r.pinned).length;
  if (pinned) tabs.push({ key: TAB_NEW, label: '📌 新品', n: pinned });
  const counts = new Map();
  list.forEach((r) => counts.set(r.machine, (counts.get(r.machine) || 0) + 1));
  const order = (m) => { const i = CITY_MACHINES.indexOf(m); return i < 0 ? 99 : i; };
  [...counts.keys()].sort((a, b) => order(a) - order(b) || collator.compare(a, b))
    .forEach((m) => tabs.push({ key: m, label: m, n: counts.get(m) }));
  return tabs;
}
function renderTabs() {
  $('tabs').innerHTML = tabList().map((t) =>
    `<button class="mtab ${t.key === C.tab ? 'active' : ''}" data-key="${esc(t.key)}" onclick="switchTab(this.dataset.key)">${esc(t.label)}<span class="n">${t.n}</span></button>`
  ).join('');
}
function switchTab(key) {
  C.tab = key;
  lsSet('cityTab', key);
  renderTabs();
  renderList();
  const btn = $('tabs').querySelector('.mtab.active');
  if (btn) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ===== 清單 =====
function onSearch() {
  const searching = !!$('q').value.trim();
  $('tabs').hidden = searching;
  $('specs').hidden = searching || !C.specs.length;
  renderList();
}

function search(q) {
  const tokens = q.split(/\s+/).map(norm).filter(Boolean);
  const hits = [];
  for (const r of C.recipes) {
    let score = 0;
    const all = tokens.every((t) => {
      if (r._t.startsWith(t)) { score += 120; return true; }
      if (r._t.includes(t)) { score += 100; return true; }
      if (r._a.some((a) => a.includes(t))) { score += 60; return true; }
      if (r._m.includes(t)) { score += 30; return true; }
      if (r._c.includes(t)) { score += 10; return true; }
      return false;
    });
    if (all) hits.push({ r, score: score - (r.discontinued ? 1000 : 0) });
  }
  return hits.sort((a, b) => b.score - a.score || collator.compare(a.r.title, b.r.title)).map((h) => h.r);
}

function itemRow(r, showMachine) {
  const aliasText = r.aliases.length ? `別名：${r.aliases.join('、')}` : '';
  return `<button class="item ${r.discontinued ? 'gone' : ''}" onclick="openDetail('${esc(r.id)}')">
    <div class="item-main">
      <div class="item-title">${showMachine ? `<span class="tag tag-machine">${esc(r.machine)}</span>` : ''}${esc(r.title)}${r.pinned && !r.discontinued ? '<span class="tag tag-new">新品</span>' : ''}${r.discontinued ? '<span class="tag tag-gone">已下架</span>' : ''}</div>
      ${aliasText ? `<div class="item-sub">${esc(aliasText)}</div>` : ''}
    </div>
    <span class="item-arrow">›</span>
  </button>`;
}

function renderList() {
  const q = $('q').value.trim();
  let rows, note = '', showMachine = false;
  if (q) {
    rows = search(q);
    showMachine = true;
    note = rows.length ? `搜尋全部機器，共 ${rows.length} 筆` : '';
    if (!rows.length) { $('list').innerHTML = `<div class="state">找不到「${esc(q)}」<br>試試看少打幾個字，或用材料名稱搜尋</div>`; return; }
  } else {
    const list = active();
    rows = C.tab === TAB_NEW ? list.filter((r) => r.pinned) : list.filter((r) => r.machine === C.tab);
    showMachine = C.tab === TAB_NEW;
    rows.sort((a, b) => (b.pinned - a.pinned) || collator.compare(a.title, b.title));
  }
  $('list').innerHTML = `${note ? `<div class="list-note">${esc(note)}</div>` : ''}<div class="list">${rows.map((r) => itemRow(r, showMachine)).join('')}</div>`;
}

// ===== 詳細 =====
function openDetail(id, replace) {
  const r = C.recipes.find((x) => x.id === id);
  if (!r) return;
  C.openId = id;
  if (replace) history.replaceState({ cityDetail: id }, '');
  else if ($('detail').hidden) history.pushState({ cityDetail: id }, '');

  const others = C.recipes.filter((x) => x.keywordId && x.keywordId === r.keywordId && x.id !== r.id);
  $('dMachine').textContent = r.machine;
  $('dBody').innerHTML = `
    <div class="d-title">${esc(r.title)}${r.pinned && !r.discontinued ? '<span class="tag tag-new">新品</span>' : ''}</div>
    ${r.aliases.length ? `<div class="d-aliases">別名：${esc(r.aliases.join('、'))}</div>` : ''}
    ${r.discontinued ? '<div class="d-gone">這個品項已下架，做法僅供參考。</div>' : ''}
    ${others.length ? `<div class="d-other">其他機器的做法：${others.map((o) => `<button onclick="openDetail('${esc(o.id)}', true)">${esc(o.machine)}</button>`).join('')}</div>` : ''}
    ${r.sections.map((s) => {
      const img = safeImg(s.image);
      return `<div class="step">${s.text ? `<div class="step-text">${esc(s.text)}</div>` : ''}${img ? `<img src="${esc(img)}" alt="${esc(r.title)} 圖示" loading="lazy" onclick="zoom(this.src)">` : ''}</div>`;
    }).join('')}`;
  $('dBody').scrollTop = 0;

  $('detail').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  if (history.state && history.state.cityDetail) history.back();
  else hideDetail();
}
function hideDetail() {
  $('detail').hidden = true;
  document.body.style.overflow = '';
  C.openId = null;
}
function zoom(src) { $('lightboxImg').src = src; $('lightbox').hidden = false; }
