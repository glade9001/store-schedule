// ===== 新版教學（遮罩導覽）=====
// 可重用：下次改版只要換 HOME_TOUR_VERSION 與 homeTourSteps()，舊的完成紀錄自然失效。
// 紀錄存在 users/{uid}.homeTour = { v, done, skips, lastAt, doneAt }
//  · 自動跳出時就先把 skips +1：中途關 App 也算跳過一次（第一次常是急著打卡）
//  · 看完最後一步 → done:true，之後不再自動跳
//  · skips 滿 2 次 → 第 3 次打開起不再自動跳；☰「重看新版教學」隨時可看，重看不計次
// ⚠️ 本檔頂層只用 function 與 var（見 home-nav.js 開頭說明）

var HOME_TOUR_VERSION = 'onboard-2026-09';
var HOME_TOUR_MAX_SKIPS = 2;
var htSteps = [];
var htIdx = 0;
var htManual = false;
var htAutoTried = false;   // 一次開頁只自動跳一次（角色預覽／恢復身份會重跑 initApp）

// 指到某個功能：優先用首頁常用區那顆按鈕，沒放常用就開 ☰ 指抽屜裡那一列
function htPoint(id) {
  var fav = function () { return document.querySelector('.fav-btn[data-fid="' + id + '"]'); };
  return {
    before: function () { if (fav()) closeNavDrawer(); else openNavDrawer(); },
    target: function () { return fav() || document.querySelector('#ndBody .nd-item[data-fid="' + id + '"]'); },
  };
}

function homeTourSteps() {
  var steps = [
    {
      before: function () { closeNavDrawer(); },
      target: '#homeClockCard',
      title: '每天第一件事：打卡',
      text: '上班、下班各打一次，要人在門市範圍內才打得到。今天的班別就顯示在這張卡上。',
    },
    {
      before: function () { closeNavDrawer(); },
      target: '#homeClockCard',
      title: '漏打或遲到怎麼辦',
      text: '最常漏的是下班卡。漏打不要慌，到「我的出勤」送補登，選一個原因送出，店長審核後就補上了。遲到也請照實打卡，可以在補登時留說明——不要請別人代打，也不要因為遲到就不打。',
    },
    Object.assign(htPoint('leaveReq'), {
      title: '想休假要先劃休',
      text: '每週一 16:00 開放新的一週，一次可以劃未來 4 週。截止時間是該週前一週的週一 23:59，過了就不能改。',
    }),
    Object.assign(htPoint('schedule'), {
      title: '班表在這裡看',
      text: '可以看本週、下週和整個月。首頁也會直接列出你這週的班。發布前的班表還會變動，以發布後的為準。',
    }),
    Object.assign(htPoint('mySalary'), {
      title: '薪資要簽收',
      text: '每月 5 號發薪（遇假日順延）。當月看得到的是上個月以前的薪資。收到通知後進去核對並簽收，沒簽會一直提醒你。',
    }),
    {
      before: function () { closeNavDrawer(); },
      target: '#headerMenuBtn',
      title: '收不到通知的話',
      text: 'iPhone 一定要先「加入主畫面」，用瀏覽器開是收不到推播的。點這個 ☰ →「設定」，裡面有「加入主畫面」和「通知設定」，照著做就可以了。',
    },
    {
      before: function () { openNavDrawer(); },
      target: function () { return document.querySelector('#ndBody .nd-star'); },
      title: '把常用的放到首頁',
      text: '☰ 裡任何功能點一下 ☆ 就會出現在首頁，最多 3 個。最上面有搜尋，找不到東西就直接搜。',
    },
  ];
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
  document.getElementById('htStep').textContent = 'App 教學 ' + (htIdx + 1) + '／' + htSteps.length;
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
  if (!htManual) showToast('之後想看，可以點左上角 ☰ →「App 使用教學」');
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
  // 這次不跳教學（看完了或已跳過 2 次）→ 改看要不要邀請開推播；同一次開頁不會兩個都跳
  if ((cur.v === HOME_TOUR_VERSION && cur.done) || skips >= HOME_TOUR_MAX_SKIPS) {
    if (typeof maybeShowPushInvite === 'function') maybeShowPushInvite();
    return;
  }
  var busy = document.getElementById('sysNoticeOverlay') ||
    document.querySelector('.modal-overlay.active, .bottom-sheet.active, #resignedScreen');
  if (busy) {
    if (attempt < 10) setTimeout(function () { maybeAutoStartHomeTour(attempt + 1); }, 2000);
    return;
  }
  htIsNewbie().then(function (yes) {
    if (!yes) { if (typeof maybeShowPushInvite === 'function') maybeShowPushInvite(); return; }
    hnSaveUserField('homeTour', { v: HOME_TOUR_VERSION, done: false, skips: skips + 1, lastAt: new Date().toISOString() });
    startHomeTour(false);
  });
}

// 只有新進員工（到職 30 天內，含還沒到職）會自動跳出教學；其他人從 ☰「App 使用教學」自己看。
// ⚠️ 到職日不在 users 文件裡，要多讀一次 employees/{店}/{人}。判定「不是新人」時把結果記在這台手機，
//    之後就不再讀——否則老員工每次進首頁都會為了這個判斷多一次 Firestore 讀取。
//    判定「是新人」不快取（人少，而且兩次跳過後本來就不會再進到這裡）。
var HT_NEWBIE_DAYS = 30;
function htIsNewbie() {
  var emp = currentUser && currentUser.empName, st = currentUser && currentUser.store;
  if (!emp || !st) return Promise.resolve(false);
  var key = 'htNewbie_' + emp;
  try { if (localStorage.getItem(key) === '0') return Promise.resolve(false); } catch (e) {}
  return window.db.collection('stores').doc(st).collection('employees').doc(emp).get()
    .then(function (d) {
      var sd = (d && d.exists && d.data().startDate) || '';
      // 沒有到職日（例如從別店調過來的）就不算新人
      var days = sd ? (Date.now() - new Date(sd + 'T00:00:00').getTime()) / 86400000 : 9999;
      var yes = days <= HT_NEWBIE_DAYS;
      if (!yes) { try { localStorage.setItem(key, '0'); } catch (e) {} }
      return yes;
    })
    .catch(function () { return false; });
}
