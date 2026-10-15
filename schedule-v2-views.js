// 排班頁之五：檢視模式切換、工時上限燈號列、三店人力檢視（單日）。2026-10-16 從 schedule-v2-page.js 原封不動切出來（整理第 4 階段）。

// ===== 檢視模式切換（Phase 2）=====
let scheduleViewMode = localStorage.getItem('scheduleViewMode') || 'classic';
let dayViewDayIdx = null;   // 三店人力檢視選中的星期（0=週一..6=週日）
// 註：內部的 mode key 仍是 'day'（改名會波及 toggleScheduleContainers／updateViewToggleUI／viewBtn-day）
function renderSchedule() {
  renderIncomingSupportBanner();
  lbRefreshBar();
  if(typeof asdRenderConflicts === 'function') asdRenderConflicts(); // 📋 劃休有變動 → 依最新劃休重排
  switch(scheduleViewMode) {
    case 'day': return renderDayView();
    default:    return renderTable();
  }
}

// ===== 本月工時 vs 工時上限（labor-budget.js）=====
// 店長看得到時數、燈號與人事成本（2026-10-11 加）；不顯示經營報酬與加盟主比例。
// 月份口徑同「N月人力」：以本週週一所在的月份為準；時數則逐日算進該月。
let lbStoreCache = {};        // store -> Promise<lbLoadStore 結果>
let lbLoaded = null;          // 目前門市已載入的結果
let lbBarOpen = false; try { lbBarOpen = localStorage.getItem('lbBarOpen') === '1'; } catch(e) {}
function lbBarMonth() {
  const weekStr = document.getElementById('weekSelector').value;
  if(!weekStr) return null;
  const mon = weekStringToDate(weekStr);
  return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}`;
}
function lbRefreshBar() {
  const store = document.getElementById('storeSelector').value;
  const bar = document.getElementById('laborBudgetBar');
  if(!bar) return;
  if(!store || !canScheduleStore(store)) { bar.style.display = 'none'; lbLoaded = null; return; }
  if(!lbStoreCache[store]) {
    lbStoreCache[store] = lbLoadStore(window.db, store, (appData.employees || []).map(e => ({...e})))
      .catch(e => { console.warn('[laborBudget]', e); delete lbStoreCache[store]; return null; });
  }
  lbStoreCache[store].then(res => {
    if(document.getElementById('storeSelector').value !== store) return; // 讀完已換店
    lbLoaded = res; lbRenderBar();
  });
}
function lbRenderBar() {
  const bar = document.getElementById('laborBudgetBar');
  if(!bar) return;
  const store = document.getElementById('storeSelector').value;
  const ym = lbBarMonth();
  const now = new Date(), curYm = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if(!lbLoaded || lbLoaded.store !== store || !ym || ym < curYm || !canScheduleStore(store)) { bar.style.display = 'none'; return; }
  const recs = (appData.records || []).filter(r => r.week);
  const ev = lbEvaluate(lbLoaded, recs, ym);
  if(ev.err || !ev.plan) { bar.style.display = 'none'; return; }
  const p = ev.plan, sc = ev.sched, lt = ev.light, mo = +ym.slice(5,7);
  const fmt = v => Math.round(v).toLocaleString();
  const col = LB_COLORS[lt ? lt.level : 'green'];
  const open = lbBarOpen;
  const md = d => (+d.slice(5,7)) + '/' + (+d.slice(8));
  // 文案原則（使用者 2026-10-11）：一個數字、一句話；範圍與推算過程不放（燈號仍用誤差範圍判斷）
  const sum = lt
    ? `${col[2]} ${mo}月排到 ${md(sc.lastDate)}：${fmt(sc.hours)}h／上限 ${fmt(lt.capP)}h` // 上限＝整月上限按已排天數攤，日期放前面才看得出是「到這天為止」
    : `${mo}月工時：還沒排班 · 整個月上限約 ${fmt(p.cap)}h`;
  const lines = [];
  // 顯示的上限是中間值 capP；燈號用誤差範圍判斷 → 黃燈可能已略超過 capP，文案要分開講
  if(lt) lines.push(`<b>${lt.level === 'green' ? '在上限內' /* 不寫「還有空間」：店長會讀成可以多排（使用者 2026-10-11） */
    : lt.level === 'red' ? `超過上限 ${fmt(sc.hours - lt.capP)}h`
    : sc.hours > lt.capP ? `稍微超過 ${fmt(sc.hours - lt.capP)}h（還在估算誤差內）` : '快到上限了'}</b>`);
  if(!lt || sc.days < lbDaysIn(ym)) lines.push(`整個月上限約 ${fmt(p.cap)}h`); // 整月都排完時跟上面同一個數，不重複
  const wan1 = v => (Math.round(v / 1000) / 10) + ' 萬';
  if(ev.projCost != null) lines.push(`照目前排法，整月人事約 ${wan1(ev.projCost)}／上限 ${wan1(p.budget)}`);
  if(ev.targetPds != null) lines.push(`每天要做到 ${wan1(ev.targetPds)}（含稅）才達標，${p.live ? '這個月目前平均' : '近 3 個月平均'} ${wan1(ev.salesPds)}`);
  if(ev.minH && ev.minH > p.capLo) lines.push(`<span style="color:#c5221f;font-weight:700;">⚠️ 基本人力就要 ${fmt(ev.minH)}h，少排班省不下來，要從業績或盤損改善</span>`);
  // 月中有 10 天以上每日營業額 → 上限改用本月實際業績推算（會隨業績變動，使用者 2026-10-11 選雙向調整）
  const basis = p.live ? `上限依這個月前 ${p.live.days} 天的實際營業額推算，業績好會放寬、變差會收緊` : `依過去 ${lbLoaded.model.months.length} 個月營收推算`;
  const det = `<div class="lb-detail">${lines.join('<br>')}<div class="lb-note">${basis}，僅供參考</div></div>`;
  bar.style.background = col[0]; bar.style.color = col[1];
  bar.innerHTML = `<div class="lb-head" onclick="lbToggleBar()"><span class="lb-sum">${sum}</span><span class="lb-caret">${open ? '▴' : '▾'}</span></div>${open ? det : ''}`;
  bar.style.display = 'block';
}
function lbToggleBar() {
  lbBarOpen = !lbBarOpen;
  try { localStorage.setItem('lbBarOpen', lbBarOpen ? '1' : '0'); } catch(e) {}
  lbRenderBar();
}

// （已停用）「來本店支援」唯讀橫幅：實務上顯示意義不大，故不再呈現；保留函式避免呼叫端出錯，並隱藏任何殘留橫幅。
function renderIncomingSupportBanner(){
  const el = document.getElementById('incomingSupportBanner');
  if(el) el.style.display='none';
}

// 切換「經典寬表格」與「手機版容器」的顯示
function toggleScheduleContainers(mode) {
  const table = document.getElementById('scheduleTable');
  const dayC  = document.getElementById('dayViewContainer');
  const tbody = document.getElementById('tableBody');
  if(!table || !dayC) return;
  const isMobile = (mode === 'day');
  table.style.display = isMobile ? 'none' : '';
  dayC.style.display  = isMobile ? 'block' : 'none';
  // ⚠️ 清掉「隱藏那一側」的 .cell-btn，否則 syncUIToMemory 的 querySelectorAll('.cell-btn')
  //   會同時掃到另一檢視殘留的格子（帶舊 dataset）→ 污染存檔。
  if(isMobile) { if(tbody) tbody.innerHTML = ''; }
  else { dayC.innerHTML = ''; }
}

// 三店人力檢視（按鈕標示「🏪 三店人力」，內部 mode key 為 'day'）：
// 一天 × 三間店的人力總覽，純唯讀；要排班請切經典檢視。
// 固定 00:00–24:00 時間軸，三店垂直對齊可直接比對同一時段的人力。
// ⚠️ 別店刻意不用 buildCellButton：那支只讀 appData.records（本店），而且存檔路徑
//    (saveCell) 的 store 是從全域 storeSelector 取的、格子本身沒有 dataset.store。
//    若讓別店也產生可編輯的 .cell-btn，編輯錦花的格子會被寫進美德。
//    「別店唯讀」這條路自然避開這個地雷——可編輯的格子永遠只有一間店。
async function renderDayView() {
  toggleScheduleContainers('day');
  const weekStr = document.getElementById('weekSelector').value;
  const store   = document.getElementById('storeSelector').value;
  const isLockedHistory = isHistoryWeek(weekStr) && !historyEditUnlocked;
  const isReadonly = !canScheduleStore(store) || isLockedHistory;
  updateHistoryLockUI(weekStr, store);
  currentWeekDates = getWeekDates(weekStr);
  if(dayViewDayIdx === null) dayViewDayIdx = (new Date().getDay() + 6) % 7; // 預設今天

  const cont = document.getElementById('dayViewContainer');
  // 日選擇器
  let html = `<div style="display:flex; gap:4px; overflow-x:auto; padding-bottom:8px; margin-bottom:6px;">`;
  dayNames.forEach((d, i) => {
    const on = i === dayViewDayIdx;
    html += `<button onclick="setDayViewDay(${i})" style="flex:1; min-width:44px; padding:7px 3px; border:none; border-radius:8px; font-size:13px; font-weight:${on?'800':'600'}; background:${on?'var(--primary)':'#f1f3f4'}; color:${on?'#fff':'var(--text-muted)'}; cursor:pointer; line-height:1.35;">${d.replace('週','')}<br><span style="font-size:10px;">${currentWeekDates[i]||''}</span></button>`;
  });
  html += `</div><div id="dayViewStores"></div>`;
  cont.innerHTML = html;

  const wrap = document.getElementById('dayViewStores');
  wrap.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px;">讀取三店班表中…</div>';
  await ensureDayViewData(weekStr, dayViewDayIdx === 0);   // 週一要多讀上週（看上週日的夜班）
  wrap.innerHTML = '';
  const stores = (appConfig.stores || []).filter(x => x && x !== '人力支援');
  // 本店排最前面
  const ordered = [store, ...stores.filter(x => x !== store)];

  ordered.forEach(st => {
    wrap.appendChild(buildDayStoreBlock(st, st === store, weekStr, dayViewDayIdx));
  });
  syncDayTimelineScroll();
  // 圖例
  const lg = document.createElement('div');
  lg.style.cssText = 'font-size:11px; color:var(--text-muted); padding:2px 4px 20px; line-height:1.9;';
  const sw = (bg,fg,t) => `<span style="background:${bg}; color:${fg}; padding:0 6px; border-radius:3px; font-weight:800;">${t}</span>`;
  lg.innerHTML = '<b>覆蓋條顏色＝該時段在班人數：</b>'
    + sw('#ef4444','#fff','0 或待補') + ' ' + sw('#fbbf24','#7c2d12','1 人')
    + ' ' + sw('#60a5fa','#fff','2 人') + ' ' + sw('#2563eb','#fff','3 人') + ' ' + sw('#1e3a8a','#fff','4+')
    + '（<b>!</b>＝該時段有未認領的待補缺口，即使已有人也算人力不足）'
    + '<br>覆蓋條每格為 <b>30 分鐘</b>，點一下（或滑過）可看該時段的實際人數。'
    + '<br><span style="color:#4f46e5;">◀</span> 昨日跨夜班延續到今天　▶ 今日跨夜班延續到明天　'
    + '<span style="background:repeating-linear-gradient(45deg,#fecaca,#fecaca 4px,#fff 4px,#fff 8px); padding:0 6px; border-radius:3px;">斜線</span> 待補缺口（不計入人力）'
    + '<br>時間軸可<b>左右滑動</b>（三店同步）。此為總覽檢視，<b>要排班請切「經典」</b>。';
  wrap.appendChild(lg);
}

/**
 * 單日檢視專用的三店週資料快取
 * ⚠️ 不能用 appData.allStoresRecords（2026-08-29 踩到）：那份對「其他店」只保留
 *    「跟支援本店有關」的記錄（supportEmp 指向本店、或 location=支援本店），
 *    是**支援關係快取**而不是跨店班表快取。用它會讓三店總覽的內容隨「目前選哪間店」而變，
 *    但總覽的結果本來就該與選店無關。所以這裡自己抓各店的週文件。
 *    成本：切到單日檢視時最多 3~6 次讀取（三店 × 本週，週一多讀上週），並快取。
 */
let _dayWeekCache = {};   // 'store|weekStr' -> records[]
async function ensureDayViewData(weekStr, alsoPrevWeek) {
  const stores = (appConfig.stores || []).filter(x => x && x !== '人力支援');
  const weeks = alsoPrevWeek ? [weekStr, prevWeekStr(weekStr)] : [weekStr];
  const jobs = [];
  stores.forEach(st => weeks.forEach(wk => {
    const key = `${st}|${wk}`;
    if(_dayWeekCache[key]) return;
    jobs.push(
      window.db.collection('stores').doc(st).collection('weeks').doc(wk).get()
        .then(snap => { _dayWeekCache[key] = (snap.exists && snap.data().records) ? snap.data().records : []; })
        .catch(() => { _dayWeekCache[key] = []; })
    );
  }));
  if(jobs.length) await Promise.all(jobs);
}
/** 存檔後要讓單日檢視重新抓（本店資料已變） */
function invalidateDayViewCache() { _dayWeekCache = {}; }

/**
 * 單日檢視的一天資料：把三店當天「實際在店」的時段攤平成時間軸線段
 * ⚠️ 視窗固定 00:00–24:00，並且**自動計入前一天的跨夜班**：
 *    昨天 23-07 的人今天 00:00–07:00 確實在店裡，不算進來凌晨那段會看起來是空的。
 *    今天的跨夜班則只畫到 24:00，尾端標 ▶ 表示延續到明天。
 * @returns {Array<{name,shift,from,to,isGap,filled,carry}>} from/to 為 0~24 的小時數
 */
function daySegmentsOf(st, weekStr, dayIdx) {
  const out = [];
  const day = dayNames[dayIdx];
  // 一律讀 _dayWeekCache，本店也不例外——三店的資料來源要一致，結果才不會隨選店而變
  const pick = (wk, dy) => (_dayWeekCache[`${st}|${wk}`] || []).filter(r => r.day === dy);

  const push = (r, from, to, carry) => {
    const isGap = String(r.name || '').startsWith('🆘');
    const filled = isGap && r.supportEmp && r.approvalStatus === 'approved';
    const who = isGap
      ? (filled ? getDisplayName(r.supportEmp.slice(r.supportEmp.indexOf('-') + 1)) : r.name)
      : getDisplayName(r.name);
    out.push({ name: who, shift: r.shift, from, to, isGap, filled, carry });
  };

  // 今天開始的班：畫 [start, min(end,24)]，超過 24 標 ▶
  pick(weekStr, day).forEach(r => {
    parseShiftSegs(r.shift).forEach(g => {
      if(g.startH >= 24) return;
      push(r, g.startH, Math.min(g.endH, 24), g.endH > 24 ? 'next' : '');
    });
  });

  // 昨天的跨夜班：畫 [0, end-24]，標 ◀（週一則往前一週的週日）
  const yIdx = (dayIdx + 6) % 7;
  const yWeek = (dayIdx === 0) ? prevWeekStr(weekStr) : weekStr;
  pick(yWeek, dayNames[yIdx]).forEach(r => {
    parseShiftSegs(r.shift).forEach(g => {
      if(g.endH <= 24) return;
      push(r, 0, Math.min(g.endH - 24, 24), 'prev');
    });
  });

  return out.sort((a, b) => a.from - b.from || String(a.name).localeCompare(String(b.name)));
}

/** 週次字串往前一週（週一要看上週日的夜班） */
function prevWeekStr(wStr) {
  const mon = weekStringToDate(wStr);
  if(!mon) return wStr;
  const d = new Date(mon); d.setDate(d.getDate() - 7);
  return shiftWeekStr(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
}

/**
 * 逐小時的人力狀況（0~23）
 * @returns {{cov:number[], gap:number[]}} cov＝實際在班人數；gap＝未認領的🆘待補覆蓋數
 * 待補不計入 cov（還沒有人），但要單獨記錄——「已有 1 人但同時掛著待補」也是人力不足，
 * 覆蓋條要標紅警示，不能因為 cov>0 就當作正常。
 */
function dayCoverageOf(segs) {
  // 48 格＝每 30 分鐘一格（2026-08-29 改）。
  // ⚠️ 為什麼是 30 分鐘：三店全部班別的小數部分**清一色是 .5**（實測 528 筆，無 .25/.75），
  //    所以 30 分鐘格能「精確」表示，完全不需要四捨五入。
  //    用 1 小時格時 17.5-23.5 的人 17:30 才到，17 點那格卻會被算成已覆蓋 →
  //    把真正的空窗填掉，而抓空窗正是這個檢視存在的理由。
  const cov = new Array(48).fill(0), gap = new Array(48).fill(0);
  segs.forEach(s => {
    const arr = (s.isGap && !s.filled) ? gap : cov;
    for(let k = 0; k < 48; k++) {
      const a = k / 2, b = (k + 1) / 2;
      if(Math.min(s.to, b) - Math.max(s.from, a) > 0) arr[k]++;
    }
  });
  return { cov, gap };
}

/**
 * 覆蓋條的配色：依人數分級用不同顏色（不只深淺），缺人一律紅色
 * 0 人／有未認領待補 → 紅；1 人 → 琥珀（人力單薄）；2 人 → 藍；3 人 → 深藍；4+ → 靛
 */
function coverageColor(n, gapN) {
  if(gapN > 0 || n === 0) return { bg:'#ef4444', fg:'#fff' };
  if(n === 1) return { bg:'#fbbf24', fg:'#7c2d12' };
  if(n === 2) return { bg:'#60a5fa', fg:'#fff' };
  if(n === 3) return { bg:'#2563eb', fg:'#fff' };
  return { bg:'#1e3a8a', fg:'#fff' };
}

/** 一間店的時間軸區塊
 *  版面：左側固定姓名欄 + 右側可橫向滑動的時間軸。
 *  ⚠️ 手機上 24 小時只有約 270px（一小時 11px），班別標籤塞不下、長條也看不清，
 *     所以時間軸給固定寬度（每小時 28px ≈ 672px）並開橫向捲動；姓名欄留在捲動區外
 *     才不會滑走。三店的捲動位置會同步，否則就失去「同一時段對照」的意義。
 */
function buildDayStoreBlock(st, isHome, weekStr, dayIdx) {
  const segs = daySegmentsOf(st, weekStr, dayIdx);
  const { cov, gap } = dayCoverageOf(segs);
  const gaps = segs.filter(s => s.isGap && !s.filled);
  const staffed = segs.filter(s => !(s.isGap && !s.filled));
  const people = new Set(staffed.map(s => s.name)).size;
  // 日總工時＝今天 00:00~24:00 內「實際有人在店」的時數總和，也就是覆蓋條的面積。
  // 跨夜班只計今天落在視窗內的那一段（昨夜延續進來的算今天、今夜延續出去的算明天），
  // 與覆蓋條、人數的口徑一致。未認領的待補不算在內，另外標示。
  const fmtH = n => (Math.round(n * 10) / 10).toString().replace(/\.0$/, '');
  const totalH = staffed.reduce((a, x) => a + (x.to - x.from), 0);
  const gapH   = gaps.reduce((a, x) => a + (x.to - x.from), 0);
  const HOUR_W = 28, TL_W = HOUR_W * 24, ROW_H = 20;

  const box = document.createElement('div');
  box.style.cssText = 'margin-bottom:12px; border:1.5px solid ' + (isHome ? 'var(--primary)' : 'var(--border)') + '; border-radius:12px; overflow:hidden;';

  // ── 標題
  let h = `<div style="display:flex; align-items:center; gap:8px; padding:7px 10px; background:${isHome?'var(--primary)':'#f1f3f4'}; color:${isHome?'#fff':'var(--text)'};">
      <span style="font-weight:900; font-size:14px;">${st}</span>
      <span style="font-size:12px; opacity:.9;" title="今日 00:00–24:00 實際有人在店的總時數（＝覆蓋條面積，跨夜班只計今天這一段）">${people} 人 · ${fmtH(totalH)}h</span>
      ${gaps.length ? `<span style="font-size:11px; font-weight:800; background:#fee2e2; color:#b91c1c; padding:2px 7px; border-radius:10px;">🆘 待補 ${gaps.length}（${fmtH(gapH)}h）</span>` : ''}
      ${isHome ? '<span style="margin-left:auto; font-size:11px; font-weight:700; opacity:.85;">本店</span>' : ''}
    </div>`;

  // ── 左右兩欄
  h += `<div style="display:flex; padding:6px 0 8px;">`;

  // 左：固定姓名欄（第一列對齊刻度＋覆蓋條的高度）
  h += `<div style="flex:0 0 76px; min-width:76px; padding-left:8px;">`;
  h += `<div style="height:32px;"></div>`;   // 對齊刻度(12px)+覆蓋條(18px)+間距
  segs.forEach(s => {
    const gapUnfilled = s.isGap && !s.filled;
    h += `<div style="height:${ROW_H}px; line-height:${ROW_H}px; font-size:11.5px; font-weight:${gapUnfilled?'800':'700'}; color:${gapUnfilled?'#b91c1c':'var(--text)'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s.carry==='prev'?'<span style="color:#4f46e5;">◀</span>':''}${s.name}</div>`;
  });
  h += `</div>`;

  // 右：可橫向捲動的時間軸
  h += `<div class="tl-scroll" style="flex:1; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; padding-right:8px;">`;
  // 寬度策略：min-width 保底（手機不足時橫向捲動），width:100% 讓桌機撐滿。
  // 因此內部一律用彈性/百分比定位，不能用絕對 px，否則桌機右半邊會留白。
  h += `<div style="min-width:${TL_W}px; width:100%;">`;
  // 刻度
  h += `<div style="display:flex; height:12px; font-size:9.5px; color:var(--text-muted);">`;
  for(let i = 0; i < 24; i++) h += `<div style="flex:1 1 0; min-width:${HOUR_W}px; text-align:center;">${i}</div>`;
  h += `</div>`;
  // 人力覆蓋條
  const SLOT_W = HOUR_W / 2;   // 每 30 分鐘一格
  h += `<div style="display:flex; height:18px; margin-bottom:2px; border-radius:4px; overflow:hidden; border:1px solid var(--border);">`;
  for(let k = 0; k < 48; k++) {
    const n = cov[k], g = gap[k];
    const c = coverageColor(n, g);
    const hh = Math.floor(k / 2), mm = (k % 2) ? '30' : '00';
    const tip = `${hh}:${mm}　${n} 人` + (g > 0 ? `（🆘 待補 ${g}）` : (n === 0 ? '（無人）' : ''));
    // 分隔線只畫在整點交界（k 為奇數＝該格結束於整點）；半小時處不畫，避免格線太密
    const isHourEnd = (k % 2 === 1);
    const border = isHourEnd ? (Math.floor(k/2) % 3 === 2 ? '1px solid rgba(0,0,0,.22)' : '1px solid rgba(0,0,0,.10)') : 'none';
    h += `<div title="${tip}" style="flex:1 1 0; min-width:${SLOT_W}px; background:${c.bg}; border-right:${border}; font-size:9px; color:${c.fg}; text-align:center; line-height:18px; font-weight:900;">${g>0?'!':''}</div>`;
  }
  h += `</div>`;
  // 每人一條
  if(!segs.length) {
    h += `<div style="height:${ROW_H}px; line-height:${ROW_H}px; color:var(--text-muted); font-size:12px;">當日無排班資料</div>`;
  } else segs.forEach(s => {
    const gapUnfilled = s.isGap && !s.filled;
    const bg = gapUnfilled ? 'repeating-linear-gradient(45deg,#fecaca,#fecaca 4px,#fff 4px,#fff 8px)'
             : s.carry === 'prev' ? '#c7d2fe' : (isHome ? 'var(--primary)' : '#94a3b8');
    const durH = Math.max(0.4, s.to - s.from);
    const leftPct = (s.from / 24 * 100).toFixed(3), widPct = (durH / 24 * 100).toFixed(3);
    // 格線每 3 小時一條＝12.5%；用百分比才會跟著容器伸縮
    h += `<div style="position:relative; height:${ROW_H}px;">
        <div style="position:absolute; inset:1px 0; background:linear-gradient(to right, #eef2f7 0 1px, transparent 1px) 0 0/12.5% 100%; border-radius:3px;"></div>
        <div title="${s.shift}" style="position:absolute; left:${leftPct}%; width:${widPct}%; top:1px; bottom:1px; background:${bg}; border-radius:4px; color:${gapUnfilled?'#b91c1c':'#fff'}; font-size:10px; font-weight:800; line-height:${ROW_H-2}px; text-align:center; overflow:hidden; white-space:nowrap;">${durH>=2.5?s.shift:''}${s.carry==='next'?' ▶':''}</div>
      </div>`;
  });
  h += `</div></div></div>`;
  box.innerHTML = h;
  return box;
}

/** 三店時間軸的橫向捲動同步（各自捲動就失去同時段對照的意義） */
function syncDayTimelineScroll() {
  const els = [...document.querySelectorAll('#dayViewStores .tl-scroll')];
  let lock = false;
  els.forEach(el => el.addEventListener('scroll', () => {
    if(lock) return;
    lock = true;
    els.forEach(o => { if(o !== el) o.scrollLeft = el.scrollLeft; });
    requestAnimationFrame(() => { lock = false; });
  }, { passive: true }));
}
function setDayViewDay(i) { dayViewDayIdx = i; renderDayView(); }

function setScheduleViewMode(m) {
  scheduleViewMode = m;
  localStorage.setItem('scheduleViewMode', m);
  updateViewToggleUI();
  renderSchedule();
}
function updateViewToggleUI() {
  ['classic','day'].forEach(m => {
    const b = document.getElementById('viewBtn-' + m);
    if(!b) return;
    const on = scheduleViewMode === m;
    b.style.background = on ? 'var(--primary)' : '#f1f3f4';
    b.style.color      = on ? '#fff' : 'var(--text-muted)';
    b.style.fontWeight = on ? '800' : '600';
  });
}
