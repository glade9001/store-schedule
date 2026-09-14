// CITY手順管理（僅 admin）：確認每週同步產生的變動 → 發佈給員工；也可修改已發佈的內容。
// 資料說明見 functions/city-sync.js 開頭。
//
// 已發佈文件 cityRecipes/{itemId} 同時存兩份：
//   src  ＝ 最近一次「確認過的對方版本」（下次比對的基準，sync 用 srcHash 比）
//   title/aliases/machine/sections ＝ 員工實際看到的內容（admin 可以改）
//   edited.{title,aliases,sections} ＝ 哪些欄位被我們改過 → 對方之後更新時，這些欄位預設保留我們的版本
// ⚠️ 內容來自對方資料庫（前端可寫、任何人都可能亂填），畫面上一律跳脫，圖片只接受我們自己的 Storage 網址。

// 我們的機器分類（＝functions/city-sync.js 的 KNOWN_MACHINES 套用 MACHINE_MERGE 後的結果，改一邊要改另一邊）
const CITY_MACHINES = ['不可思議茶Bar', '現萃茶', 'CITY CAFE', '精品咖啡', 'CITY PEARL/TEA', '果汁Bar', '雙豆槽'];
const OUR_IMAGE_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/store-schedule-3b056-city/';
const NO_MACHINE = '（未判斷機器）';

let currentUser = null;
const S = { pending: [], recipes: new Map(), specs: new Map(), ignored: [], declined: [], meta: null, tab: 'pending', openId: null, groupKeys: [], pubGroupKeys: [] };

// ===== 工具 =====
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function safeImg(url) { return typeof url === 'string' && url.startsWith(OUR_IMAGE_PREFIX) ? url : ''; }
function showLoading(txt) { $('loadingText').textContent = txt || '處理中...'; $('loadingOverlay').classList.add('active'); }
function hideLoading() { $('loadingOverlay').classList.remove('active'); }
function showToast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); }
const nowTs = () => firebase.firestore.FieldValue.serverTimestamp();
const byName = () => currentUser.displayName || currentUser.empName || currentUser.username || 'admin';
function fmtTime(ts) {
  if (!ts || !ts.toDate) return '—';
  const d = ts.toDate();
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function parseAliases(str) { return [...new Set(String(str || '').split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean))]; }
const secKey = (sections) => JSON.stringify((sections || []).map((s) => [String(s.text || '').trim(), s.image || null]));
const machineOrder = (m) => { const i = CITY_MACHINES.indexOf(m); return m === NO_MACHINE ? 999 : i < 0 ? 500 : i; };

async function commitOps(ops) {
  // ops: (batch) => void；每批 400 以內
  for (let i = 0; i < ops.length; i += 400) {
    const batch = window.db.batch();
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
}

// ===== 初始化 =====
window.onload = async () => {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) { window.location.replace('home.html'); return; }
  try { currentUser = JSON.parse(saved); } catch { window.location.replace('home.html'); return; }
  const fbUser = await new Promise((r) => { const u = firebase.auth().onAuthStateChanged((fb) => { u(); r(fb); }); });
  if (!fbUser) { window.location.replace('home.html'); return; }
  if (currentUser.permission !== 'admin') {
    hideLoading();
    $('content').style.display = 'block';
    $('content').innerHTML = '<div class="empty">只有系統管理者可以管理 CITY手順。</div>';
    return;
  }
  $('machineList').innerHTML = CITY_MACHINES.map((m) => `<option value="${esc(m)}"></option>`).join('');
  await loadAll();
  $('content').style.display = 'block';
  hideLoading();
};

async function loadAll() {
  const db = window.db;
  const [p, r, s, ig, meta, dec] = await Promise.all([
    db.collection('cityPending').get(),
    db.collection('cityRecipes').get(),
    db.collection('citySpecs').get(),
    db.collection('cityIgnored').get(),
    db.collection('cityMeta').doc('sync').get(),
    db.collection('cityDeclined').get(),
  ]);
  S.pending = p.docs.map((d) => ({ id: d.id, ...d.data() }));
  S.recipes = new Map(r.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  S.specs = new Map(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  S.ignored = ig.docs.map((d) => ({ id: d.id, ...d.data() }));
  S.meta = meta.exists ? meta.data() : null;
  S.declined = dec.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderAll();
}

function renderAll() {
  renderSync();
  $('cntPending').textContent = S.pending.length;
  $('cntPublished').textContent = S.recipes.size;
  $('cntIgnored').textContent = S.ignored.length + S.declined.length;
  renderPending();
  renderPublished();
  renderIgnored();
}

function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('tabPending').hidden = tab !== 'pending';
  $('tabPublished').hidden = tab !== 'published';
  $('tabIgnored').hidden = tab !== 'ignored';
}

// ===== 同步狀態 =====
function renderSync() {
  const m = S.meta;
  if (!m) { $('syncTitle').textContent = '尚未同步過'; $('syncSub').textContent = '每週一 08:00 自動同步'; return; }
  $('syncTitle').innerHTML = m.ok ? '✅ 上次同步成功' : '❌ 上次同步失敗';
  const c = m.sourceCounts || {};
  $('syncSub').innerHTML = `${esc(fmtTime(m.lastRunAt))}（${m.trigger === 'manual' ? '手動' : '排程'}）・對方 ${c.keywords ?? '—'} 個品項、${c.items ?? '—'} 份做法<br>每週一 08:00 自動同步`;
  const errs = Object.keys(m.imageErrors || {}).length;
  const msg = !m.ok ? `錯誤：${m.error || '未知'}` : errs ? `有 ${errs} 張圖片沒有複製成功，相關品項會標示「缺圖」，可稍後再按立即同步。` : '';
  $('syncError').hidden = !msg;
  $('syncError').textContent = msg;
}

async function syncNow() {
  const btn = $('syncNowBtn');
  btn.disabled = true;
  showLoading('同步中，約需半分鐘...');
  try {
    const fn = firebase.app().functions('asia-east1').httpsCallable('citySyncNow');
    const res = await fn();
    await loadAll();
    const p = res.data.pending || {};
    showToast(`同步完成：待確認 ${p.total ?? 0} 筆`);
  } catch (e) {
    await loadAll().catch(() => {});
    showToast('同步失敗：' + (e.message || e));
  } finally {
    btn.disabled = false;
    hideLoading();
  }
}

// ===== 待確認清單 =====
function pendingGroupKey(p) {
  if (p.kind === 'spec') return '📏 基本規格速查';
  if (p.change === 'add') return (p.src && p.src.suggestedMachine) || NO_MACHINE;
  const rec = S.recipes.get(p.srcId);
  return (rec && rec.machine) || NO_MACHINE;
}
function pendingTitle(p) {
  if (p.kind === 'spec') return p.src ? `${p.src.category}｜${p.src.label}` : (p.title || '');
  if (p.src) return p.src.title;
  const rec = S.recipes.get(p.srcId);
  return (rec && rec.title) || p.title || '';
}
function isEdited(rec) { return !!(rec && rec.edited && (rec.edited.title || rec.edited.aliases || rec.edited.sections || rec.edited.content)); }

// 整組發佈時哪些可以直接發：新增（有機器、不缺圖）、沒被我們改過的更動。刪除一律個別處理。
function batchEligible(p) {
  if (p.imageMissing || p.change === 'delete') return false;
  if (p.kind === 'spec') return p.change === 'add' || !isEdited(S.specs.get(p.srcId));
  if (p.change === 'add') return !!(p.src && p.src.suggestedMachine);
  return !isEdited(S.recipes.get(p.srcId));
}

function renderPending() {
  const box = $('tabPending');
  if (!S.pending.length) { box.innerHTML = '<div class="empty">沒有待確認的變動 🎉</div>'; return; }
  const groups = new Map();
  for (const p of S.pending) {
    const k = pendingGroupKey(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => (a.startsWith('📏') ? -1 : b.startsWith('📏') ? 1 : machineOrder(a) - machineOrder(b) || a.localeCompare(b)));
  const order = { add: 0, update: 1, delete: 2 };
  S.groupKeys = keys;
  box.innerHTML = keys.map((k, gi) => {
    const list = groups.get(k).sort((a, b) => order[a.change] - order[b.change] || pendingTitle(a).localeCompare(pendingTitle(b), 'zh-Hant'));
    const ok = list.filter(batchEligible).length;
    const warn = k === NO_MACHINE ? '<div class="group-warn">這些品項判斷不出機器，請逐筆點開指定機器後發佈。</div>' : '';
    return `<div class="group">
      <div class="group-head">
        <div class="group-name">${esc(k)}<span class="group-count">${list.length} 筆</span></div>
        <div class="group-actions">
          ${ok ? `<button class="btn-outline" onclick="publishGroup(${gi})">整組發佈 ${ok} 筆</button>` : ''}
          <button class="btn-outline btn-outline-muted" onclick="declineGroup(${gi})">整組不發佈</button>
        </div>
      </div>${warn}
      ${list.map(pendingRow).join('')}
    </div>`;
  }).join('');
}

function pendingRow(p) {
  const label = { add: '新增', update: '更動', delete: '刪除' }[p.change];
  const flags = [];
  if (p.imageMissing) flags.push('<span class="badge b-flag">缺圖</span>');
  const rec = p.kind === 'spec' ? S.specs.get(p.srcId) : S.recipes.get(p.srcId);
  if (p.change === 'update' && isEdited(rec)) flags.push('<span class="badge b-flag">我們改過</span>');
  if (p.src && p.src.pinned) flags.push('<span class="badge b-flag">📌 釘選</span>');
  let sub = '';
  if (p.kind === 'recipe' && p.src) {
    const imgs = p.src.sections.filter((s) => s.srcImage).length;
    sub = `${p.src.sections.length} 段${imgs ? `・${imgs} 張圖` : ''}${p.src.aliases && p.src.aliases.length ? `・別名：${p.src.aliases.join('、')}` : ''}`;
  }
  return `<div class="row" onclick="openPending('${esc(p.id)}')">
    <span class="badge b-${p.change}">${label}</span>
    <div class="row-main"><div class="row-title">${esc(pendingTitle(p))}${flags.join('')}</div>${sub ? `<div class="row-sub">${esc(sub)}</div>` : ''}</div>
    <span class="row-arrow">›</span>
  </div>`;
}

// ===== 發佈用的資料組裝 =====
function srcSnapshot(src, srcHash) {
  return {
    title: src.title, tags: src.tags || '', aliases: src.aliases || [], machineSrc: src.machineSrc || '',
    sections: src.sections.map((s) => ({ text: s.text, srcImage: s.srcImage || '', image: s.image || null })),
    srcHash,
  };
}
const visibleSections = (sections) => sections.map((s) => ({ text: s.text, image: s.image || null }));

// 新增：form 為 admin 在彈窗裡改過的值（整組發佈時為 null＝照對方）
function buildNewRecipe(p, form) {
  const src = p.src;
  const title = form ? form.title : src.title;
  const aliases = form ? form.aliases : src.aliases || [];
  const sections = form ? form.sections : visibleSections(src.sections);
  return {
    itemId: src.itemId, keywordId: src.keywordId,
    title, aliases, machine: form ? form.machine : src.suggestedMachine, sections,
    pinned: !!src.pinned, kwSort: src.kwSort ?? 0, itemSort: src.itemSort ?? 0,
    discontinued: form ? form.discontinued : false, srcDeleted: false,
    edited: {
      title: title !== src.title,
      aliases: JSON.stringify(aliases) !== JSON.stringify(src.aliases || []),
      sections: secKey(sections) !== secKey(src.sections),
    },
    src: srcSnapshot(src, p.srcHash), srcHash: p.srcHash,
    publishedAt: nowTs(), publishedBy: byName(), updatedAt: nowTs(),
  };
}

// 更動：keepOurs=true → 我們改過的欄位保留，其餘換成對方新版；false → 全部改用對方新版
function buildUpdatedRecipe(p, rec, keepOurs) {
  const src = p.src;
  const e = (keepOurs && rec.edited) || {};
  return {
    title: e.title ? rec.title : src.title,
    aliases: e.aliases ? rec.aliases : src.aliases || [],
    sections: e.sections ? rec.sections : visibleSections(src.sections),
    pinned: !!src.pinned, kwSort: src.kwSort ?? 0, itemSort: src.itemSort ?? 0,
    srcDeleted: false,
    edited: { title: !!e.title, aliases: !!e.aliases, sections: !!e.sections },
    src: srcSnapshot(src, p.srcHash), srcHash: p.srcHash,
    updatedAt: nowTs(), updatedBy: byName(),
  };
}

function buildSpec(p, content, keepOurs) {
  const src = p.src;
  const pub = S.specs.get(p.srcId);
  const useOurs = keepOurs && pub && pub.edited && pub.edited.content;
  const finalContent = content != null ? content : useOurs ? pub.content : src.content;
  return {
    category: src.category, label: src.label, sort: src.sort ?? 0,
    content: finalContent,
    edited: { content: finalContent !== src.content },
    src: { category: src.category, label: src.label, content: src.content, srcHash: p.srcHash },
    srcHash: p.srcHash, updatedAt: nowTs(), updatedBy: byName(),
  };
}

const pendingRef = (id) => window.db.collection('cityPending').doc(id);
const recipeRef = (id) => window.db.collection('cityRecipes').doc(id);
const specRef = (id) => window.db.collection('citySpecs').doc(id);

async function publishGroup(gi) {
  const key = S.groupKeys[gi];
  const list = S.pending.filter((p) => pendingGroupKey(p) === key);
  const ok = list.filter(batchEligible);
  const skip = list.length - ok.length;
  if (!ok.length) return;
  if (!confirm(`「${key}」要發佈 ${ok.length} 筆嗎？${skip ? `\n\n另外 ${skip} 筆需要個別處理（刪除、缺圖、我們改過、沒有機器），會留在清單上。` : ''}`)) return;
  showLoading(`發佈 ${ok.length} 筆...`);
  try {
    const ops = [];
    for (const p of ok) {
      if (p.kind === 'spec') {
        ops.push((b) => b.set(specRef(p.srcId), buildSpec(p, null, true), { merge: true }));
      } else if (p.change === 'add') {
        ops.push((b) => b.set(recipeRef(p.srcId), buildNewRecipe(p, null)));
      } else {
        ops.push((b) => b.update(recipeRef(p.srcId), buildUpdatedRecipe(p, S.recipes.get(p.srcId), true)));
      }
      ops.push((b) => b.delete(pendingRef(p.id)));
    }
    await commitOps(ops);
    await loadAll();
    showToast(`已發佈 ${ok.length} 筆`);
  } catch (e) {
    showToast('發佈失敗：' + (e.message || e));
  } finally { hideLoading(); }
}

// ===== 詳細彈窗 =====
function openModal(html) { $('detailBody').innerHTML = html; $('detailModal').classList.add('active'); $('detailModal').querySelector('.modal-box').scrollTop = 0; }
function closeDetail() { $('detailModal').classList.remove('active'); S.openId = null; }

function viewSections(sections) {
  return sections.map((s) => {
    const img = safeImg(s.image);
    return `<div class="view-sec">${esc(s.text)}${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}</div>`;
  }).join('') || '<div class="m-sub">（沒有內容）</div>';
}

// 逐行比對（夠用就好）：左邊標出被拿掉的行、右邊標出新加的行
function diffCols(oldText, newText, leftH, rightH) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  const setA = new Set(a), setB = new Set(b);
  const col = (lines, other, cls) => lines.map((l) => `<div class="ln ${other.has(l) ? '' : cls}">${esc(l) || '&nbsp;'}</div>`).join('');
  return `<div class="diff-cols">
    <div class="diff-col"><div class="diff-col-h">${esc(leftH)}</div>${col(a, setB, 'ln-del')}</div>
    <div class="diff-col"><div class="diff-col-h">${esc(rightH)}</div>${col(b, setA, 'ln-add')}</div>
  </div>`;
}
const joinText = (sections) => (sections || []).map((s) => s.text).join('\n\n');
const thumbs = (sections) => {
  const imgs = (sections || []).map((s) => safeImg(s.image)).filter(Boolean);
  return imgs.length ? `<div class="thumbs">${imgs.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</div>` : '';
};

// 編輯表單（新增品項發佈前、已發佈品項修改都用這個）
function recipeForm(v, opts) {
  return `
    <div class="field"><label for="fMachine">機器／工作站</label>
      <input type="text" id="fMachine" list="machineList" value="${esc(v.machine)}" placeholder="選擇或輸入機器">
      ${opts.machineHint ? `<div class="hint">${esc(opts.machineHint)}</div>` : ''}</div>
    <div class="field"><label for="fTitle">品名</label><input type="text" id="fTitle" value="${esc(v.title)}"></div>
    <div class="field"><label for="fAliases">別名（搜尋用，用逗號分隔）</label><input type="text" id="fAliases" value="${esc((v.aliases || []).join('、'))}"></div>
    <label class="check"><input type="checkbox" id="fGone" ${v.discontinued ? 'checked' : ''}> 已下架（員工搜尋得到，但會標示已下架）</label>
    <div class="field"><label>做法內容</label><div id="fSections">${v.sections.map(sectionEditor).join('')}</div></div>`;
}
function sectionEditor(s, i) {
  const img = safeImg(s.image);
  return `<div class="sec" data-image="${esc(img)}">
    <div class="sec-head">第 ${i + 1} 段<button type="button" class="sec-del" onclick="this.closest('.sec').remove()">刪除這段</button></div>
    <textarea rows="${Math.max(3, String(s.text || '').split('\n').length + 1)}" aria-label="第 ${i + 1} 段文字">${esc(s.text)}</textarea>
    ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}
  </div>`;
}
function readForm() {
  const sections = [...document.querySelectorAll('#fSections .sec')].map((el) => ({
    text: el.querySelector('textarea').value.trim(),
    image: el.dataset.image || null,
  })).filter((s) => s.text || s.image);
  return {
    machine: $('fMachine').value.trim(),
    title: $('fTitle').value.trim(),
    aliases: parseAliases($('fAliases').value),
    discontinued: $('fGone').checked,
    sections,
  };
}

function openPending(id) {
  const p = S.pending.find((x) => x.id === id);
  if (!p) return;
  S.openId = id;
  if (p.kind === 'spec') return openSpecPending(p);
  const rec = S.recipes.get(p.srcId);
  const missing = p.imageMissing ? '<div class="m-note">⚠️ 有圖片還沒複製成功，請先按「立即同步」，成功後才能發佈。</div>' : '';

  if (p.change === 'add') {
    const src = p.src;
    const hint = src.machineSrc ? `對方填的是「${src.machineSrc}」` : src.suggestedMachine ? `對方沒填機器，依內文判斷為「${src.suggestedMachine}」` : '對方沒填機器，也判斷不出來，請指定';
    openModal(`
      <div class="m-title"><span class="badge b-add">新增</span> ${esc(src.title)}</div>
      <div class="m-sub">對方建立於 ${esc(String(src.srcCreatedAt || '').slice(0, 10) || '—')}${src.pinned ? '・📌 對方有釘選（會自動沿用）' : ''}</div>
      ${missing}
      ${recipeForm({ machine: src.suggestedMachine, title: src.title, aliases: src.aliases, discontinued: false, sections: src.sections }, { machineHint: hint })}
      <div class="btn-col">
        <button class="btn btn-primary" onclick="publishAdd()" ${p.imageMissing ? 'disabled' : ''}>發佈</button>
        <button class="btn btn-danger" onclick="ignoreKeyword()">不收這個品項</button>
        <button class="btn btn-soft" onclick="declinePending()">不發佈（這一版先不發）</button>
        <button class="btn btn-soft" onclick="closeDetail()">先不處理</button>
      </div>`);
    return;
  }

  if (p.change === 'delete') {
    openModal(`
      <div class="m-title"><span class="badge b-delete">刪除</span> ${esc(rec ? rec.title : p.title)}</div>
      <div class="m-sub">對方已經刪掉這份做法。你可以跟著刪除，或保留下來標示「已下架」（員工搜尋得到）。</div>
      ${rec ? viewSections(rec.sections) : ''}
      <div class="btn-col">
        <button class="btn btn-soft" onclick="resolveDelete(true)">保留並標示已下架</button>
        <button class="btn btn-danger" onclick="resolveDelete(false)">刪除（員工看不到）</button>
        <button class="btn btn-soft" onclick="declinePending()">不發佈（這一版先不發）</button>
        <button class="btn btn-soft" onclick="closeDetail()">先不處理</button>
      </div>`);
    return;
  }

  // update
  const old = rec.src || {};
  const src = p.src;
  const e = rec.edited || {};
  const parts = [];
  if (old.title !== src.title) parts.push(`<div class="diff-block"><div class="diff-label">品名${e.title ? '（我們改過：' + esc(rec.title) + '）' : ''}</div>${diffCols(old.title, src.title, '對方舊版', '對方新版')}</div>`);
  if (JSON.stringify(old.aliases || []) !== JSON.stringify(src.aliases || [])) parts.push(`<div class="diff-block"><div class="diff-label">別名${e.aliases ? '（我們改過）' : ''}</div>${diffCols((old.aliases || []).join('、'), (src.aliases || []).join('、'), '對方舊版', '對方新版')}</div>`);
  if ((old.machineSrc || '') !== (src.machineSrc || '')) parts.push(`<div class="diff-block"><div class="diff-label">對方填的機器（我們的分類「${esc(rec.machine)}」不會自動改）</div>${diffCols(old.machineSrc || '（空白）', src.machineSrc || '（空白）', '對方舊版', '對方新版')}</div>`);
  const oldImgs = (old.sections || []).map((s) => s.srcImage).join('|');
  const newImgs = src.sections.map((s) => s.srcImage).join('|');
  if (joinText(old.sections) !== joinText(src.sections) || oldImgs !== newImgs) {
    parts.push(`<div class="diff-block"><div class="diff-label">做法內容${e.sections ? '（我們改過）' : ''}${oldImgs !== newImgs ? '・圖片有換' : ''}</div>
      ${diffCols(joinText(old.sections), joinText(src.sections), '對方舊版', '對方新版')}
      ${oldImgs !== newImgs ? `<div class="diff-cols"><div>${thumbs(old.sections)}</div><div>${thumbs(src.sections)}</div></div>` : ''}</div>`);
  }
  const editedNames = [e.title && '品名', e.aliases && '別名', e.sections && '做法內容'].filter(Boolean);
  const keepNote = editedNames.length ? `<div class="m-note">這筆的「${editedNames.join('、')}」我們改過。選「更新並保留我們的修改」，這些欄位維持我們的版本，其他欄位換成對方新版。</div>` : '';
  openModal(`
    <div class="m-title"><span class="badge b-update">更動</span> ${esc(src.title)}</div>
    <div class="m-sub">分類：${esc(rec.machine)}${rec.discontinued ? '・已下架' : ''}</div>
    ${missing}${keepNote}
    ${parts.join('') || '<div class="m-sub">只有排序或格式有變。</div>'}
    <div class="btn-col">
      ${editedNames.length
        ? `<button class="btn btn-primary" onclick="resolveUpdate(true)" ${p.imageMissing ? 'disabled' : ''}>更新並保留我們的修改</button>
           <button class="btn btn-soft" onclick="resolveUpdate(false)" ${p.imageMissing ? 'disabled' : ''}>全部改用對方新版</button>`
        : `<button class="btn btn-primary" onclick="resolveUpdate(false)" ${p.imageMissing ? 'disabled' : ''}>發佈更新</button>`}
      <button class="btn btn-soft" onclick="declinePending()">不發佈（這一版先不發）</button>
        <button class="btn btn-soft" onclick="closeDetail()">先不處理</button>
    </div>`);
}

function openSpecPending(p) {
  const pub = S.specs.get(p.srcId);
  if (p.change === 'delete') {
    openModal(`
      <div class="m-title"><span class="badge b-delete">刪除</span> ${esc(pub ? pub.label : p.title)}</div>
      <div class="m-sub">對方刪掉了這筆基本規格。</div>
      ${pub ? `<div class="view-sec">${esc(pub.content)}</div>` : ''}
      <div class="btn-col">
        <button class="btn btn-danger" onclick="resolveSpecDelete()">刪除</button>
        <button class="btn btn-soft" onclick="declinePending()">不發佈（這一版先不發）</button>
        <button class="btn btn-soft" onclick="closeDetail()">先不處理</button>
      </div>`);
    return;
  }
  const src = p.src;
  const editedOurs = p.change === 'update' && pub && pub.edited && pub.edited.content;
  openModal(`
    <div class="m-title"><span class="badge b-${p.change}">${p.change === 'add' ? '新增' : '更動'}</span> ${esc(src.category)}｜${esc(src.label)}</div>
    <div class="m-sub">基本規格速查會放在員工查詢頁最上方。</div>
    ${p.change === 'update' ? `<div class="diff-block"><div class="diff-label">內容${editedOurs ? '（我們改過）' : ''}</div>${diffCols(pub.src ? pub.src.content : pub.content, src.content, '對方舊版', '對方新版')}</div>` : ''}
    <div class="field"><label for="fSpec">發佈的內容（可修改）</label><textarea id="fSpec" rows="8">${esc(editedOurs ? pub.content : src.content)}</textarea>
      ${editedOurs ? '<div class="hint">目前填的是我們改過的版本；要改用對方新版，直接把右邊的內容貼上。</div>' : ''}</div>
    <div class="btn-col">
      <button class="btn btn-primary" onclick="publishSpec()">發佈</button>
      <button class="btn btn-soft" onclick="declinePending()">不發佈（這一版先不發）</button>
        <button class="btn btn-soft" onclick="closeDetail()">先不處理</button>
    </div>`);
}

// ===== 動作 =====
function currentPending() { return S.pending.find((x) => x.id === S.openId); }

// 不發佈：把這一版變動整份搬到 cityDeclined（可改回），同步時同一版（change＋srcHash）不再跳出，對方再改才會重新出現
const declinedRef = (id) => window.db.collection('cityDeclined').doc(id);
function declineOps(p) {
  const { id, ...data } = p;
  return [(b) => b.set(declinedRef(id), { ...data, declinedAt: nowTs(), declinedBy: byName() }), (b) => b.delete(pendingRef(id))];
}

function declinePending() {
  const p = currentPending();
  runAction('處理中...', async () => {
    await commitOps(declineOps(p));
    showToast('已設為不發佈；對方之後再改才會重新出現');
  });
}

async function declineGroup(gi) {
  const key = S.groupKeys[gi];
  const list = S.pending.filter((p) => pendingGroupKey(p) === key);
  if (!list.length) return;
  if (!confirm(`「${key}」這 ${list.length} 筆都不發佈？\n\n對方之後再改才會重新出現；也可以在「略過」分頁改回待確認。`)) return;
  showLoading(`處理 ${list.length} 筆...`);
  try {
    await commitOps(list.flatMap(declineOps));
    await loadAll();
    showToast(`${list.length} 筆設為不發佈`);
  } catch (e) {
    showToast('失敗：' + (e.message || e));
  } finally { hideLoading(); }
}

async function undecline(id) {
  const d = S.declined.find((x) => x.id === id);
  if (!d) return;
  const { id: _id, declinedAt, declinedBy, ...data } = d;
  showLoading('處理中...');
  try {
    await commitOps([(b) => b.set(pendingRef(id), data), (b) => b.delete(declinedRef(id))]);
    await loadAll();
    showToast('已改回待確認');
  } catch (e) {
    showToast('失敗：' + (e.message || e));
  } finally { hideLoading(); }
}

async function runAction(label, fn) {
  showLoading(label);
  try {
    await fn();
    closeDetail();
    await loadAll();
  } catch (e) {
    showToast('失敗：' + (e.message || e));
  } finally { hideLoading(); }
}

function publishAdd() {
  const p = currentPending();
  const form = readForm();
  if (!form.machine) { showToast('請先指定機器'); return; }
  if (!form.title) { showToast('品名不可空白'); return; }
  if (!form.sections.length) { showToast('做法內容不可空白'); return; }
  runAction('發佈中...', async () => {
    await commitOps([(b) => b.set(recipeRef(p.srcId), buildNewRecipe(p, form)), (b) => b.delete(pendingRef(p.id))]);
    showToast(`已發佈「${form.title}」`);
  });
}

function resolveUpdate(keepOurs) {
  const p = currentPending();
  const rec = S.recipes.get(p.srcId);
  runAction('更新中...', async () => {
    await commitOps([(b) => b.update(recipeRef(p.srcId), buildUpdatedRecipe(p, rec, keepOurs)), (b) => b.delete(pendingRef(p.id))]);
    showToast('已更新');
  });
}

function resolveDelete(keep) {
  const p = currentPending();
  if (!keep && !confirm('確定刪除？員工將看不到這份做法。')) return;
  runAction(keep ? '標示已下架...' : '刪除中...', async () => {
    const op = keep
      ? (b) => b.update(recipeRef(p.srcId), { discontinued: true, srcDeleted: true, updatedAt: nowTs(), updatedBy: byName() })
      : (b) => b.delete(recipeRef(p.srcId));
    await commitOps([op, (b) => b.delete(pendingRef(p.id))]);
    showToast(keep ? '已保留並標示已下架' : '已刪除');
  });
}

function ignoreKeyword() {
  const p = currentPending();
  const kwId = p.src.keywordId;
  const samePending = S.pending.filter((x) => x.kind === 'recipe' && x.src && x.src.keywordId === kwId);
  const samePub = [...S.recipes.values()].filter((r) => r.keywordId === kwId);
  const extra = samePending.length + samePub.length > 1 ? `\n（同品項共 ${samePending.length} 筆待確認${samePub.length ? `、${samePub.length} 筆已發佈也會一起移除` : ''}）` : '';
  if (!confirm(`「${p.src.title}」之後都不收，每週同步也不會再出現？${extra}`)) return;
  runAction('處理中...', async () => {
    const ops = [(b) => b.set(window.db.collection('cityIgnored').doc(kwId), { title: p.src.title, by: byName(), at: nowTs() })];
    samePending.forEach((x) => ops.push((b) => b.delete(pendingRef(x.id))));
    samePub.forEach((r) => ops.push((b) => b.delete(recipeRef(r.id))));
    await commitOps(ops);
    showToast('已加入不收清單');
  });
}

function publishSpec() {
  const p = currentPending();
  const content = $('fSpec').value.trim();
  if (!content) { showToast('內容不可空白'); return; }
  runAction('發佈中...', async () => {
    await commitOps([(b) => b.set(specRef(p.srcId), buildSpec(p, content, false), { merge: true }), (b) => b.delete(pendingRef(p.id))]);
    showToast('已發佈');
  });
}

function resolveSpecDelete() {
  const p = currentPending();
  runAction('刪除中...', async () => {
    await commitOps([(b) => b.delete(specRef(p.srcId)), (b) => b.delete(pendingRef(p.id))]);
    showToast('已刪除');
  });
}

// ===== 已發佈 =====
function renderPublished() {
  const q = ($('pubSearch').value || '').trim().toLowerCase();
  const match = (r) => !q || r.title.toLowerCase().includes(q) || (r.aliases || []).some((a) => a.toLowerCase().includes(q));
  const list = [...S.recipes.values()].filter(match);
  const specs = [...S.specs.values()].sort((a, b) => a.category.localeCompare(b.category) || (a.sort ?? 0) - (b.sort ?? 0));
  let html = '';
  if (specs.length && !q) {
    const sHidden = specs.filter((s) => s.unpublished).length;
    const sShown = specs.length - sHidden;
    html += `<div class="group"><div class="group-head"><div class="group-name">📏 基本規格速查<span class="group-count">${specs.length} 筆${sHidden ? `・不發佈 ${sHidden}` : ''}</span></div>
      <div class="group-actions">
        ${sHidden ? `<button class="btn-outline" onclick="setAllSpecsUnpublished(false)">整組重新發佈 ${sHidden} 筆</button>` : ''}
        ${sShown ? '<button class="btn-outline btn-outline-muted" onclick="setAllSpecsUnpublished(true)">整組不發佈</button>' : ''}
      </div></div>
      ${specs.map((s) => `<div class="row" onclick="openSpecEdit('${esc(s.id)}')"><div class="row-main"><div class="row-title">${esc(s.category)}｜${esc(s.label)}${s.unpublished ? '<span class="badge b-hidden">不發佈</span>' : ''}${s.edited && s.edited.content ? '<span class="badge b-flag">我們改過</span>' : ''}</div></div><span class="row-arrow">›</span></div>`).join('')}</div>`;
  }
  if (!list.length) {
    $('pubList').innerHTML = html + `<div class="empty">${q ? '找不到符合的品項' : '還沒有發佈任何做法'}</div>`;
    return;
  }
  const groups = new Map();
  list.forEach((r) => { const k = r.machine || NO_MACHINE; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  S.pubGroupKeys = [...groups.keys()].sort((a, b) => machineOrder(a) - machineOrder(b) || a.localeCompare(b));
  S.pubGroupKeys.forEach((k, gi) => {
    const rows = groups.get(k).sort((a, b) => (b.pinned - a.pinned) || a.title.localeCompare(b.title, 'zh-Hant'));
    const nShown = rows.filter((r) => !r.unpublished).length;
    const nHidden = rows.length - nShown;
    // 搜尋中不給整組操作，避免只對篩選出來的一部分動手卻以為是整組
    const actions = q ? '' : `<div class="group-actions">
        ${nHidden ? `<button class="btn-outline" onclick="setGroupUnpublished(${gi}, false)">整組重新發佈 ${nHidden} 筆</button>` : ''}
        ${nShown ? `<button class="btn-outline btn-outline-muted" onclick="setGroupUnpublished(${gi}, true)">整組不發佈</button>` : ''}
      </div>`;
    html += `<div class="group"><div class="group-head"><div class="group-name">${esc(k)}<span class="group-count">${rows.length} 筆${nHidden ? `・不發佈 ${nHidden}` : ''}</span></div>${actions}</div>
      ${rows.map((r) => `<div class="row" onclick="openRecipeEdit('${esc(r.id)}')">
        <div class="row-main"><div class="row-title">${r.pinned ? '📌 ' : ''}${esc(r.title)}${r.unpublished ? '<span class="badge b-hidden">不發佈</span>' : ''}${r.discontinued ? '<span class="badge b-gone">已下架</span>' : ''}${isEdited(r) ? '<span class="badge b-flag">我們改過</span>' : ''}</div>
        ${(r.aliases || []).length ? `<div class="row-sub">別名：${esc(r.aliases.join('、'))}</div>` : ''}</div>
        <span class="row-arrow">›</span></div>`).join('')}</div>`;
  });
  $('pubList').innerHTML = html;
}

function openRecipeEdit(id) {
  const r = S.recipes.get(id);
  if (!r) return;
  S.openId = id;
  openModal(`
    <div class="m-title">${esc(r.title)}</div>
    <div class="m-sub">${r.pinned ? '📌 對方有釘選（自動沿用）・' : ''}上次更新 ${esc(fmtTime(r.updatedAt || r.publishedAt))}${r.srcDeleted ? '・對方已刪除' : ''}</div>
    ${r.unpublished ? '<div class="m-note">目前設為不發佈，員工看不到這份做法。</div>' : ''}
    ${recipeForm(r, { machineHint: r.src && r.src.machineSrc ? `對方填的是「${r.src.machineSrc}」` : '' })}
    <div class="btn-col">
      <button class="btn btn-primary" onclick="saveRecipeEdit()">儲存</button>
      ${isEdited(r) ? '<button class="btn btn-soft" onclick="revertRecipe()">還原成對方版本</button>' : ''}
      ${r.unpublished
        ? `<button class="btn btn-soft" onclick="setUnpublished(['${esc(r.id)}'], false)">重新發佈</button>`
        : `<button class="btn btn-soft" onclick="setUnpublished(['${esc(r.id)}'], true)">不發佈（員工看不到）</button>`}
      <button class="btn btn-soft" onclick="closeDetail()">取消</button>
    </div>`);
}

// 已發佈的不發佈：保留資料與我們的修改，只是員工看不到；每週同步照常比對（對方更新仍會進待確認）
function setUnpublished(ids, flag) {
  const n = ids.length;
  runAction('處理中...', async () => {
    await commitOps(ids.map((id) => (b) => b.update(recipeRef(id), { unpublished: flag, updatedAt: nowTs(), updatedBy: byName() })));
    showToast(flag ? `${n} 筆設為不發佈，員工看不到了` : `${n} 筆已重新發佈`);
  });
}

function setGroupUnpublished(gi, flag) {
  const key = S.pubGroupKeys[gi];
  const ids = [...S.recipes.values()].filter((r) => (r.machine || NO_MACHINE) === key && !!r.unpublished !== flag).map((r) => r.id);
  if (!ids.length) return;
  if (!confirm(flag ? `「${key}」這 ${ids.length} 筆都不發佈？員工會看不到，資料和修改都會保留。` : `「${key}」這 ${ids.length} 筆重新發佈給員工？`)) return;
  setUnpublished(ids, flag);
}

function saveRecipeEdit() {
  const r = S.recipes.get(S.openId);
  const form = readForm();
  if (!form.machine || !form.title || !form.sections.length) { showToast('機器、品名、做法內容都不可空白'); return; }
  const src = r.src || {};
  runAction('儲存中...', async () => {
    await recipeRef(r.id).update({
      ...form,
      edited: {
        title: form.title !== src.title,
        aliases: JSON.stringify(form.aliases) !== JSON.stringify(src.aliases || []),
        sections: secKey(form.sections) !== secKey(src.sections),
      },
      updatedAt: nowTs(), updatedBy: byName(),
    });
    showToast('已儲存');
  });
}

function revertRecipe() {
  const r = S.recipes.get(S.openId);
  if (!r.src || !confirm('把品名、別名、做法內容都還原成對方的版本？（機器分類與已下架不變）')) return;
  runAction('還原中...', async () => {
    await recipeRef(r.id).update({
      title: r.src.title, aliases: r.src.aliases || [], sections: visibleSections(r.src.sections),
      edited: { title: false, aliases: false, sections: false }, updatedAt: nowTs(), updatedBy: byName(),
    });
    showToast('已還原');
  });
}

function openSpecEdit(id) {
  const s = S.specs.get(id);
  S.openId = id;
  openModal(`
    <div class="m-title">${esc(s.category)}｜${esc(s.label)}</div>
    <div class="m-sub">基本規格速查</div>
    ${s.unpublished ? '<div class="m-note">目前設為不發佈，員工看不到這筆規格。</div>' : ''}
    <div class="field"><label for="fSpec">內容</label><textarea id="fSpec" rows="8">${esc(s.content)}</textarea></div>
    <div class="btn-col">
      <button class="btn btn-primary" onclick="saveSpecEdit()">儲存</button>
      ${s.unpublished
        ? `<button class="btn btn-soft" onclick="setSpecsUnpublished(['${esc(s.id)}'], false)">重新發佈</button>`
        : `<button class="btn btn-soft" onclick="setSpecsUnpublished(['${esc(s.id)}'], true)">不發佈（員工看不到）</button>`}
      <button class="btn btn-soft" onclick="closeDetail()">取消</button>
    </div>`);
}

// 基本規格的不發佈：同品項，保留內容，只是員工頁不顯示
function setSpecsUnpublished(ids, flag) {
  const n = ids.length;
  runAction('處理中...', async () => {
    await commitOps(ids.map((id) => (b) => b.update(specRef(id), { unpublished: flag, updatedAt: nowTs(), updatedBy: byName() })));
    showToast(flag ? `${n} 筆規格設為不發佈，員工看不到了` : `${n} 筆規格已重新發佈`);
  });
}

function setAllSpecsUnpublished(flag) {
  const ids = [...S.specs.values()].filter((s) => !!s.unpublished !== flag).map((s) => s.id);
  if (!ids.length) return;
  if (!confirm(flag ? `基本規格速查這 ${ids.length} 筆都不發佈？員工頁的速查會整塊消失，內容會保留。` : `基本規格速查這 ${ids.length} 筆重新發佈給員工？`)) return;
  setSpecsUnpublished(ids, flag);
}

function saveSpecEdit() {
  const s = S.specs.get(S.openId);
  const content = $('fSpec').value.trim();
  if (!content) { showToast('內容不可空白'); return; }
  runAction('儲存中...', async () => {
    await specRef(s.id).update({ content, edited: { content: !s.src || content !== s.src.content }, updatedAt: nowTs(), updatedBy: byName() });
    showToast('已儲存');
  });
}

// ===== 略過（不發佈的變動＋不收的品項）=====
function renderIgnored() {
  const box = $('tabIgnored');
  if (!S.ignored.length && !S.declined.length) { box.innerHTML = '<div class="empty">沒有略過的項目</div>'; return; }
  const label = { add: '新增', update: '更動', delete: '刪除' };
  let html = '';
  if (S.declined.length) {
    html += `<div class="group"><div class="group-head"><div class="group-name">不發佈的變動<span class="group-count">${S.declined.length} 筆・對方再改會重新出現</span></div></div>
      ${S.declined.map((d) => `<div class="row" style="cursor:default;">
        <span class="badge b-${esc(d.change)}">${label[d.change] || ''}</span>
        <div class="row-main"><div class="row-title">${esc(pendingTitle(d))}</div><div class="row-sub">${esc(d.declinedBy || '')} ${esc(fmtTime(d.declinedAt))}</div></div>
        <button class="btn-outline" onclick="undecline('${esc(d.id)}')">改回待確認</button></div>`).join('')}</div>`;
  }
  if (S.ignored.length) {
    html += `<div class="group"><div class="group-head"><div class="group-name">不收的品項<span class="group-count">永遠跳過</span></div></div>
      ${S.ignored.map((g) => `<div class="row" style="cursor:default;">
        <div class="row-main"><div class="row-title">${esc(g.title)}</div><div class="row-sub">${esc(g.by || '')} ${esc(fmtTime(g.at))}</div></div>
        <button class="btn-outline" onclick="unignore('${esc(g.id)}')">改回要收</button></div>`).join('')}</div>`;
  }
  box.innerHTML = html;
}

async function unignore(id) {
  const g = S.ignored.find((x) => x.id === id);
  if (!confirm(`「${g.title}」改回要收？下次同步時會出現在待確認。`)) return;
  showLoading('處理中...');
  try {
    await window.db.collection('cityIgnored').doc(id).delete();
    await loadAll();
    showToast('已改回要收，可以按「立即同步」讓它出現');
  } catch (e) {
    showToast('失敗：' + (e.message || e));
  } finally { hideLoading(); }
}
