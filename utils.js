/**
 * store-schedule 共用工具函式
 * 所有頁面共用，避免重複維護
 */

/**
 * 讀取目前登入用戶（localStorage → sessionStorage）
 * 未登入時跳轉至 home.html 並記下來源頁面
 * @returns {Object|null} currentUser，或 null（已跳轉）
 */
function requireLogin(redirectUrl) {
  const saved = localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser');
  if (!saved) {
    if (redirectUrl) localStorage.setItem('redirectAfterLogin', redirectUrl);
    window.location.replace('home.html');
    return null;
  }
  try {
    return JSON.parse(saved);
  } catch (e) {
    localStorage.removeItem('currentUser');
    sessionStorage.removeItem('currentUser');
    if (redirectUrl) localStorage.setItem('redirectAfterLogin', redirectUrl);
    window.location.replace('home.html');
    return null;
  }
}

const dayNames = ['週一','週二','週三','週四','週五','週六','週日'];

/**
 * ===== 週次字串（weeks doc id）唯一正解 =====
 * 週文件 id 的意義由 getWeekDates() 定義：該週七格＝週一起算的七天。
 * 任何「日期 → 週字串」都必須是它的精準反函式，先退到該日所屬「週一」再換算。
 *
 * ⚠️ 2026-08-09 移除了本檔原有的一套純 ISO-8601 版本（dateToISOWeek / getWeekDates /
 *    getMonthWeekStrings / isWeekLocked）——它是全專案第三種週次慣例，與排班表的錨點
 *    在「1/1 是星期日」的年份會差一整週，且當時已無任何頁面呼叫，留著只會被誤用。
 *    同時也移除了「日期＋時間直接套年度週次」的舊公式，其週界會隨該年 1/1 是星期幾而變，
 *    每個週六/週日都算成下一週。
 */
function week1MondayOf(yr) {
  const d = new Date(yr, 0, 1), day = d.getDay();
  d.setDate(d.getDate() + (day <= 4 ? 1 - day : 8 - day));
  return d;
}

/** Date → 週次字串 "YYYY-Www" */
function weekStrOfDate(dt) {
  const mon = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); // 去掉時間，避免小數天數進位
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));               // 退到該日所屬的週一
  let yr = mon.getFullYear();
  if (mon < week1MondayOf(yr)) yr--; else if (mon >= week1MondayOf(yr + 1)) yr++;
  const w = Math.round((mon - week1MondayOf(yr)) / 604800000) + 1;
  return `${yr}-W${String(w).padStart(2, '0')}`;
}

/** 週次字串 → 該週 7 天的 "M/D" 陣列（週一到週日） */
function getWeekDates(wStr) {
  const [yearStr, wPart] = wStr.split('-W');
  const d = week1MondayOf(parseInt(yearStr));
  d.setDate(d.getDate() + (parseInt(wPart) - 1) * 7);
  const result = [];
  for (let i = 0; i < 7; i++) {
    result.push(`${d.getMonth() + 1}/${d.getDate()}`);
    d.setDate(d.getDate() + 1);
  }
  return result;
}

/** 取得「下週」的週次字串 */
function getNextWeekString() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return weekStrOfDate(d);
}

/** 取得某年某月（自然月）所涵蓋的所有週次字串（逐日掃描，確保不漏週） */
function getMonthWeekStrings(year, month) {
  const result = new Set();
  const daysInMonth = new Date(year, month, 0).getDate(); // month 已是 1-based
  for (let d = 1; d <= daysInMonth; d++) result.add(weekStrOfDate(new Date(year, month - 1, d)));
  return [...result];
}

/** 共用 Loading 顯示/隱藏 */
function showLoading(text) {
  const el = document.getElementById('loadingText');
  if (el) el.innerText = text || '載入中...';
  document.getElementById('loadingOverlay').style.display = 'flex';
}
function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
}

/** 共用關閉 Modal */
function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}
