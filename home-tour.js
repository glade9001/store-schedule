// ===== 新版教學（遮罩導覽）=====
// 可重用：下次改版只要換 HOME_TOUR_VERSION 與 homeTourSteps()，舊的完成紀錄自然失效。
// 紀錄存在 users/{uid}.homeTour = { v, done, skips, lastAt, doneAt }
//  · 自動跳出時就先把 skips +1：中途關 App 也算跳過一次（第一次常是急著打卡）
//  · 看完最後一步 → done:true，之後不再自動跳
//  · skips 滿 2 次 → 第 3 次打開起不再自動跳；☰「重看新版教學」隨時可看，重看不計次
// ⚠️ 本檔頂層只用 function 與 var（見 home-nav.js 開頭說明）

var HOME_TOUR_VERSION = 'home-2026-09';
var HOME_TOUR_MAX_SKIPS = 2;
var htSteps = [];
var htIdx = 0;
var htManual = false;
var htAutoTried = false;   // 一次開頁只自動跳一次（角色預覽／恢復身份會重跑 initApp）

function homeTourSteps() {
  var lead = hnIsLead();
  var steps = [
    {
      target: '#headerMenuBtn',
      title: '全部功能都在這裡',
      text: '原本右上角的 ⚙️ 選單和「更多管理」都搬進左上角 ☰，最上面可以搜尋功能名稱。',
    },
    {
      before: function () { openNavDrawer(); },
      target: function () { return document.querySelector('#ndBody .nd-star'); },
      title: '點 ☆ 加到首頁',
      text: lead
        ? '常用的功能點一下星星就會出現在首頁，再點一次移除。一般功能和管理功能各放 3 個。'
        : '常用的功能點一下星星就會出現在首頁，再點一次移除，最多放 3 個。',
    },
    {
      before: function () { closeNavDrawer(); },
      target: '#favPersonalCard',
      title: '首頁的常用功能',
      text: '預設是班表、劃休申請、薪水。點右上角「編輯」可以調整順序、移除，或恢復預設。',
    },
  ];
  if (lead) {
    steps.push({
      target: '#mgmtSection',
      title: '常用管理',
      text: hnIsOwner()
        ? '店長以上多一排管理功能，你的預設是決策儀表板、經營績效、人事分析。'
        : '店長以上多一排管理功能，預設是排班、算薪水、出勤管理。',
    });
  }
  steps.push({
    target: function () {
      var pills = document.getElementById('homePills');
      var anyPill = pills && Array.prototype.some.call(pills.children, function (c) { return c.style.display && c.style.display !== 'none'; });
      if (anyPill) return pills;
      var clock = document.getElementById('homeClockCard');
      return clock && clock.style.display !== 'none' ? clock : null;
    },
    title: '打卡與提醒',
    text: '今天的班別顯示在打卡卡片上；薪資待簽收、待處理等提醒縮成一排小標籤，點一下就能前往。',
  });
  return steps;
}

function htResolve(step) {
  var el = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return (r.width > 0 && r.height > 0) ? el : null;
}

function startHomeTour(manual) {
  closeNavDrawer();
  htManual = !!manual;
  htSteps = homeTourSteps();
  htIdx = 0;
  if (!document.getElementById('htLayer')) {
    var layer = document.createElement('div');
    layer.id = 'htLayer';
    layer.innerHTML =
      '<div class="ht-block"></div>' +
      '<div class="ht-spot" id="htSpot"></div>' +
      '<div class="ht-coach" id="htCoach" role="dialog" aria-modal="true" aria-labelledby="htTitle">' +
        '<div class="ht-step" id="htStep"></div>' +
        '<div class="ht-title" id="htTitle"></div>' +
        '<div class="ht-text" id="htText"></div>' +
        '<div class="ht-acts"><button class="ht-skip" id="htSkip" onclick="skipHomeTour()">跳過教學</button>' +
        '<span class="ht-dots" id="htDots"></span>' +
        '<button class="ht-next" id="htNext" onclick="nextHomeTourStep()">下一步</button></div>' +
      '</div>';
    document.body.appendChild(layer);
    // 位置要等動畫停好才準：.page-container 有 scroll-behavior:smooth、抽屜有滑入動畫 → 捲動中／動畫結束都重量一次
    var raf = 0;
    var replace = function () { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; htPlace(); }); };
    window.addEventListener('resize', replace);
    document.querySelector('.page-container')?.addEventListener('scroll', replace, { passive: true });
    document.getElementById('navDrawer')?.addEventListener('transitionend', replace);
  }
  document.getElementById('htLayer').classList.add('active');
  htShow();
}

function htShow() {
  // 找不到目標（例如打卡功能沒開、沒有提醒）的步驟直接略過
  while (htIdx < htSteps.length) {
    var s = htSteps[htIdx];
    if (s.before) s.before();
    if (htResolve(s)) break;
    htIdx++;
  }
  if (htIdx >= htSteps.length) { finishHomeTour(); return; }
  var step = htSteps[htIdx];
  var el = htResolve(step);
  // 先捲到看得到（首頁本身在 .page-container 內捲動）
  if (!el.closest('#navDrawer')) el.scrollIntoView({ block: 'center', behavior: 'auto' });
  document.getElementById('htStep').textContent = '新版首頁 ' + (htIdx + 1) + '／' + htSteps.length;
  document.getElementById('htTitle').textContent = step.title;
  document.getElementById('htText').textContent = step.text;
  document.getElementById('htNext').textContent = htIdx === htSteps.length - 1 ? '開始使用' : '下一步';
  document.getElementById('htSkip').style.visibility = htIdx === htSteps.length - 1 ? 'hidden' : 'visible';
  document.getElementById('htDots').innerHTML = htSteps.map(function (_, i) { return '<i' + (i === htIdx ? ' class="on"' : '') + '></i>'; }).join('');
  htPlace();
  setTimeout(htPlace, 350);   // 保險：少數瀏覽器平滑捲動不發 scroll 事件
}

function htPlace() {
  var layer = document.getElementById('htLayer');
  if (!layer || !layer.classList.contains('active')) return;
  var el = htResolve(htSteps[htIdx] || {});
  if (!el) return;
  var r = el.getBoundingClientRect();
  var pad = 6;
  var spot = document.getElementById('htSpot');
  spot.style.top = (r.top - pad) + 'px';
  spot.style.left = (r.left - pad) + 'px';
  spot.style.width = (r.width + pad * 2) + 'px';
  spot.style.height = (r.height + pad * 2) + 'px';
  var coach = document.getElementById('htCoach');
  var vh = window.innerHeight;
  var ch = coach.offsetHeight;
  var below = r.bottom + pad + 14;
  var top = (below + ch < vh - 12) ? below : Math.max(12, r.top - pad - 14 - ch);
  coach.style.top = top + 'px';
  coach.classList.toggle('up', top > r.top);
  var ax = Math.min(Math.max(r.left + r.width / 2 - coach.getBoundingClientRect().left - 6, 18), coach.offsetWidth - 30);
  coach.style.setProperty('--ax', ax + 'px');
}

function nextHomeTourStep() {
  htIdx++;
  if (htIdx >= htSteps.length) { finishHomeTour(); return; }
  htShow();
}

function htClose() {
  var layer = document.getElementById('htLayer');
  if (layer) layer.classList.remove('active');
  closeNavDrawer();
  var pc = document.querySelector('.page-container');
  if (pc) pc.scrollTop = 0;
}

function skipHomeTour() {
  htClose();
  if (!htManual) showToast('之後想看，可以點左上角 ☰ →「重看新版教學」');
}

function finishHomeTour() {
  htClose();
  var cur = (hnUserDoc && hnUserDoc.homeTour) || {};
  if (cur.v === HOME_TOUR_VERSION && cur.done) return;
  hnSaveUserField('homeTour', {
    v: HOME_TOUR_VERSION, done: true,
    skips: cur.v === HOME_TOUR_VERSION ? (cur.skips || 0) : 0,
    lastAt: new Date().toISOString(), doneAt: new Date().toISOString(),
  });
}

// 首頁載好、常用設定讀回來後呼叫；有別的視窗開著就晚點再試，試不到這次就不跳（不計次）
function maybeAutoStartHomeTour(attempt) {
  attempt = attempt || 0;
  if (!attempt && htAutoTried) return;
  htAutoTried = true;
  try { if (sessionStorage.getItem('isPreviewMode') === '1') return; } catch (e) {}
  if (!document.getElementById('appShell')?.classList.contains('active')) {
    if (attempt < 10) setTimeout(function () { maybeAutoStartHomeTour(attempt + 1); }, 1500);
    return;
  }
  if (document.getElementById('htLayer')?.classList.contains('active')) return;
  var cur = (hnUserDoc && hnUserDoc.homeTour) || {};
  var skips = cur.v === HOME_TOUR_VERSION ? (cur.skips || 0) : 0;
  if (cur.v === HOME_TOUR_VERSION && cur.done) return;
  if (skips >= HOME_TOUR_MAX_SKIPS) return;
  var busy = document.getElementById('sysNoticeOverlay') ||
    document.querySelector('.modal-overlay.active, .bottom-sheet.active, #resignedScreen') ||
    document.getElementById('lineBindOverlay')?.style.display === 'flex';
  if (busy) {
    if (attempt < 10) setTimeout(function () { maybeAutoStartHomeTour(attempt + 1); }, 2000);
    return;
  }
  hnSaveUserField('homeTour', { v: HOME_TOUR_VERSION, done: false, skips: skips + 1, lastAt: new Date().toISOString() });
  startHomeTour(false);
}
