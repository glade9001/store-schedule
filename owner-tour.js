// ===== 加盟主決策儀表板導覽（2026-10-11）=====
// 一步亮一個區塊：這個數字代表什麼＋要在意什麼。外觀沿用首頁教學（home-tour.js 的 ht-* 樣式，這裡用 ot-*）。
// 首頁那份跟抽屜綁死，所以另寫一份精簡版。
// 第一次進儀表板自動跳一次（看完或跳過都算看過）；右上「導覽」可重看。
// 看過記在 localStorage＋users/{uid}.appUsage.odTourSeen（appUsage 在規則的本人可改清單，不必改規則）。
// 導覽一律在「總覽／三店」畫面跑；原本選單店的話，結束後切回去。
// ⚠️ 本檔頂層只用 function 與 var，名稱帶 ot 前綴，避免跟 owner-dashboard-page.js 撞名。

var otSteps = [], otIdx = 0, otPrevScope = null, otAutoTried = false;

function otSec(t) { // 區塊標題＋下面那張卡一起亮
  var h = Array.prototype.find.call(document.querySelectorAll('.sec-title'), function (e) { return e.textContent.indexOf(t) >= 0; });
  return h ? [h, h.nextElementSibling] : null;
}
function otChart(t) {
  return Array.prototype.find.call(document.querySelectorAll('.chart-card'), function (e) { var c = e.querySelector('.chart-t'); return c && c.textContent.indexOf(t) >= 0; }) || null;
}
function otFold(t) {
  return Array.prototype.find.call(document.querySelectorAll('details.fold'), function (e) { var c = e.querySelector('.fold-t'); return c && c.textContent.indexOf(t) >= 0; }) || null;
}
function otKpi(i) { return document.querySelectorAll('.kpi-grid .kpi')[i] || null; }

function otTourSteps() {
  return [
    { target: function () { return document.getElementById('monthSel'); }, fixed: true,
      title: '先選要看哪個月',
      text: '這裡選的是「損益月份」。損益表每月 10 號前才輸入完，所以最新通常是上個月。下面的「工時上限」「未休假獎金」看的是今天，不受這裡影響。' },
    { target: function () { return document.getElementById('scopeBar'); },
      title: '三店一起看，或只看一家',
      text: '點門市名稱，整頁只看那一家，圖表會換成「今年 vs 去年」「每工時人事成本」「出勤」。選擇會記住，下次打開還是同一個。' },
    { target: function () { return document.getElementById('mainTabs'); },
      title: '總覽看錢，人事看人',
      text: '「總覽」是營收、獲利、成本；「人事」是每位員工的加班、特休、出勤異常，要追某個人的狀況時到這裡。' },
    { target: function () { return otSec('這個月要處理'); },
      title: '🚦 每次打開先看這裡',
      text: '系統自動挑出這個月要處理的事。紅色＝要馬上處理（門市虧損、人事費率超過 35%、排班超過工時上限）；橘色＝要注意（壞品、損耗、缺卡、遲到等）。顯示 ✓ 就是沒事。' },
    { target: function () { return otKpi(0); },
      title: '營業淨額',
      text: '損益表上的營業收入：商品銷售（不含稅）加上代收、代售的手續費。要在意的是「vs 去年同期」連續好幾個月都是 ▼，那代表生意在變小，不是單月起伏。' },
    { target: function () { return otKpi(1); },
      title: '經營報酬',
      text: '總部每月撥給加盟主的錢。電費、壞品、盤損、雜支已經先扣掉，但還沒付人事——所有員工的薪水都要從這筆付。' },
    { target: function () { return otKpi(2); },
      title: '門市餘裕：最重要的數字',
      text: '經營報酬 − 人事成本（含跨店支援）＝這個月門市真正替加盟主留下多少（還沒扣稅、租金）。綠色是賺、紅色是虧。' },
    { target: function () { return otKpi(3); },
      title: '人事費率',
      text: '人事成本 ÷ 營業淨額。生意變差時費率會自己變高，所以要跟營業淨額一起看：營收沒掉、費率卻一直升，就是人排多了。' },
    { target: function () { return otChart('門市餘裕'); },
      title: '三店誰賺誰虧',
      text: '這個月三家店的門市餘裕排在一起比。點長條就切到那一家看細節。' },
    { target: function () { return otChart('人事費率'); },
      title: '人事費率的方向',
      text: '近 12 個月的走勢。看「方向」比看單月準：連續往上就要檢查排班。' },
    { target: function () { return otChart('未休假獎金'); },
      title: '🏖️ 未休假要付多少錢',
      text: '假設員工到期前都沒休，公司到期要把特休、補休折成現金付出去，這是最多要付的金額。要在意「必須結算」和「已過期未處理」。提早安排休假，就能少付這筆。' },
    { target: function () { return otFold('工時上限'); },
      title: '⏱️ 這個月最多能排幾小時',
      text: '先扣掉加盟主要留的比例，剩下的才是人事預算，換算成工讀時數。月中每日營業輸入滿 10 天後會改用實際業績重算。要在意紅燈，以及「基本人力已超過上限」——那代表少排班也省不下來，要靠業績或盤損。比例在裡面的「⚙️ 設定」調。' },
    { target: function () { return otFold('每日營業'); },
      title: '🧾 這個月到今天的生意',
      text: '只有輸入每日營業額的店才會出現。看這個月到今天比去年同期多少，以及剩下每天要做到多少才達標、才比去年成長。點「看分析」到每日營業頁看細節。' },
    { target: function () { return otFold('計分卡'); },
      title: '👔 店長計分卡',
      text: '用 8 個指標替店長打分，獲利最重要。摘要只列名次和「最弱的一項」，那一項就是跟店長討論的重點。點開有「ℹ️ 指標說明」。' },
    { target: function () { return otFold('成本體檢'); },
      title: '🩺 每小時人事成本',
      text: '每工時人事成本跟這家店自己過去的平均比，上下 10% 內算合理。偏高通常是加班多，或高時薪的人排得多。' },
    { target: function () { return otFold('出勤紀律'); },
      title: '🕐 出勤紀律',
      text: '缺卡率、補登率、遲到率、未處理缺卡。最要在意「未處理缺卡」大於 0：代表還有缺卡單店長沒處理。' },
    { target: function () { return otFold('營運檢討'); },
      title: '📋 營運檢討',
      text: '每個月寫一次給店長看的檢討，寫好可以產生 3 天有效的分享連結。導覽之後想再看，點右上「導覽」。' },
  ];
}

// 目標可以是一個或兩個元素（標題＋卡片），回傳合併後的範圍；看不到就略過這一步
function otRect(step) {
  var t = step.target(); if (!t) return null;
  var els = Array.isArray(t) ? t.filter(Boolean) : [t], r = null;
  els.forEach(function (el) {
    var b = el.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0)) return;
    r = r ? { top: Math.min(r.top, b.top), left: Math.min(r.left, b.left), bottom: Math.max(r.bottom, b.bottom), right: Math.max(r.right, b.right) }
      : { top: b.top, left: b.left, bottom: b.bottom, right: b.right };
  });
  return r ? { el: els[0], r: r } : null;
}

function otWaitFor(test, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function poll() { if (test()) return res(true); if (Date.now() - t0 > ms) return res(false); setTimeout(poll, 150); })();
  });
}

async function startOwnerTour() {
  // 回到「總覽／三店／儀表板全貌」
  var needRender = false;
  if (typeof mainTab !== 'undefined' && mainTab !== 'overview') { mainTab = 'overview'; renderMainTabs(); needRender = true; }
  if (typeof dashView !== 'undefined' && dashView !== 'main') { dashView = 'main'; needRender = true; }
  otPrevScope = OwnerScope.get();
  if (otPrevScope) OwnerScope.set('', STORES);         // 會觸發重畫
  else if (needRender) renderAll(dashMonth);
  await otWaitFor(function () { return document.querySelector('.kpi-grid') && otSec('這個月要處理'); }, 8000);
  otSteps = otTourSteps(); otIdx = 0;
  if (!document.getElementById('otLayer')) {
    var layer = document.createElement('div');
    layer.id = 'otLayer';
    layer.innerHTML =
      '<div class="ot-block"></div><div class="ot-spot" id="otSpot"></div>' +
      '<div class="ot-coach" id="otCoach" role="dialog" aria-modal="true" aria-labelledby="otTitle">' +
        '<div class="ot-step" id="otStep"></div><div class="ot-title" id="otTitle"></div><div class="ot-text" id="otText"></div>' +
        '<div class="ot-acts"><button class="ot-skip" id="otSkip" onclick="closeOwnerTour()">跳過</button>' +
        '<span class="ot-dots" id="otDots"></span><button class="ot-prev" id="otPrev" onclick="otGo(-1)">上一步</button>' +
        '<button class="ot-next" id="otNext" onclick="otGo(1)">下一步</button></div></div>';
    document.body.appendChild(layer);
    var raf = 0, re = function () { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; otPlace(); }); };
    window.addEventListener('resize', re); window.addEventListener('scroll', re, { passive: true });
    setInterval(function () { if (layer.classList.contains('active')) otPlace(); }, 800); // 背景資料算完會整頁重畫，定時對齊亮框
  }
  document.getElementById('otLayer').classList.add('active');
  otMarkSeen();
  otShow(1);
}

function otShow(dir) {
  while (otIdx >= 0 && otIdx < otSteps.length && !otRect(otSteps[otIdx])) otIdx += dir; // 看不到的區塊（例如還在計算）略過
  if (otIdx < 0) { otIdx = 0; while (otIdx < otSteps.length && !otRect(otSteps[otIdx])) otIdx++; }
  if (otIdx >= otSteps.length) { closeOwnerTour(); return; }
  var s = otSteps[otIdx], hit = otRect(s);
  if (s.fixed) window.scrollTo(0, 0);
  else {
    var mid = (hit.r.top + hit.r.bottom) / 2, h = hit.r.bottom - hit.r.top;
    window.scrollTo(0, window.scrollY + (h > window.innerHeight * 0.55 ? hit.r.top - 70 : mid - window.innerHeight * 0.35));
  }
  document.getElementById('otStep').textContent = '儀表板導覽 ' + (otIdx + 1) + '／' + otSteps.length;
  document.getElementById('otTitle').textContent = s.title;
  document.getElementById('otText').textContent = s.text;
  var last = otIdx === otSteps.length - 1;
  document.getElementById('otNext').textContent = last ? '完成' : '下一步';
  document.getElementById('otSkip').style.display = last ? 'none' : '';
  document.getElementById('otPrev').style.display = otIdx === 0 ? 'none' : '';
  document.getElementById('otDots').textContent = '';
  otPlace();
  setTimeout(otPlace, 300);
}

function otPlace() {
  var layer = document.getElementById('otLayer');
  if (!layer || !layer.classList.contains('active')) return;
  var hit = otRect(otSteps[otIdx] || { target: function () { return null; } }); if (!hit) return;
  var r = hit.r, pad = 6, spot = document.getElementById('otSpot');
  spot.style.top = (r.top - pad) + 'px'; spot.style.left = (r.left - pad) + 'px';
  spot.style.width = (r.right - r.left + pad * 2) + 'px'; spot.style.height = (r.bottom - r.top + pad * 2) + 'px';
  var coach = document.getElementById('otCoach'), vh = window.innerHeight, ch = coach.offsetHeight;
  var below = r.bottom + pad + 14, above = r.top - pad - 14 - ch;
  var top = below + ch < vh - 12 ? below : above >= 12 ? above : Math.max(12, vh - ch - 12); // 區塊太高：放在畫面底部
  coach.style.top = top + 'px';
  coach.classList.toggle('up', top > r.top);
  coach.classList.toggle('noarrow', top < r.bottom && top + ch > r.top);
  var ax = Math.min(Math.max((r.left + r.right) / 2 - coach.getBoundingClientRect().left - 6, 18), coach.offsetWidth - 30);
  coach.style.setProperty('--ax', ax + 'px');
}

function otGo(d) { otIdx += d; if (otIdx >= otSteps.length) { closeOwnerTour(); return; } otShow(d); }

function closeOwnerTour() {
  var layer = document.getElementById('otLayer'); if (layer) layer.classList.remove('active');
  window.scrollTo(0, 0);
  if (otPrevScope) { var s = otPrevScope; otPrevScope = null; OwnerScope.set(s, STORES); }
}

function otKey() { return 'odTourSeen:' + ((typeof currentUser !== 'undefined' && currentUser && currentUser.empName) || ''); }
function otMarkSeen() {
  try { localStorage.setItem(otKey(), '1'); } catch (e) {}
  var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
  if (uid) window.db.collection('users').doc(uid).set({ appUsage: { odTourSeen: new Date().toISOString() } }, { merge: true }).catch(function () {});
}

// 儀表板第一次畫好後呼叫：沒看過才自動跳（一次開頁只試一次）
async function maybeStartOwnerTour() {
  if (otAutoTried) return; otAutoTried = true;
  try { if (localStorage.getItem(otKey())) return; } catch (e) {}
  var uid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
  if (uid) {
    var u = await window.db.collection('users').doc(uid).get().catch(function () { return null; });
    if (u && u.exists && (u.data().appUsage || {}).odTourSeen) { try { localStorage.setItem(otKey(), '1'); } catch (e) {} return; }
  }
  startOwnerTour();
}
