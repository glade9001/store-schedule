/**
 * store-schedule 共用工具函式
 * 兩個頁面 (index.html / employee.html) 共用，避免重複維護
 */

const dayNames = ['週一','週二','週三','週四','週五','週六','週日'];

/**
 * 取得「下週」的 ISO week 字串，例如 "2025-W22"
 * 使用 ISO 8601 標準：週一為每週第一天，第一週為含 1/4 的那週
 */
function getNextWeekString() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return dateToISOWeek(d);
}

/**
 * 將 Date 物件轉成 ISO week 字串 "YYYY-Www"
 */
function dateToISOWeek(date) {
  const d = new Date(date);
  // 調整到週四（ISO 規定：週四所在年份就是該週的年份）
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const year = d.getFullYear();
  const jan4 = new Date(year, 0, 4);
  // 計算從當年第一週週一到目前日期的天數差
  const weekNum = 1 + Math.round(
    ((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7
  );
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * 將 ISO week 字串 ("YYYY-Www") 轉為該週 7 天的 "M/D" 陣列 (週一到週日)
 */
function getWeekDates(wStr) {
  const [yearStr, wPart] = wStr.split('-W');
  const year = parseInt(yearStr);
  const week = parseInt(wPart);

  // 找到該年第一個週四，往回推到週一，再加 (week-1)*7 天
  const jan4 = new Date(year, 0, 4);
  const firstMonday = new Date(jan4);
  firstMonday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));

  const weekStart = new Date(firstMonday);
  weekStart.setDate(firstMonday.getDate() + (week - 1) * 7);

  const result = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    result.push(`${d.getMonth() + 1}/${d.getDate()}`);
  }
  return result;
}

/**
 * 取得某年某月（自然月）所涵蓋的所有 ISO week 字串陣列
 * 例如 getMonthWeekStrings(2025, 5) → ["2025-W18","2025-W19","2025-W20","2025-W21","2025-W22"]
 * 判斷依據：該週有任何一天（週一～週日）落在該自然月內，就納入
 */
function getMonthWeekStrings(year, month) {
  const result = new Set();
  // 從月初掃到月底，每天轉成 ISO week
  const daysInMonth = new Date(year, month, 0).getDate(); // month 已是 1-based
  for (let d = 1; d <= daysInMonth; d++) {
    result.add(dateToISOWeek(new Date(year, month - 1, d)));
  }
  return [...result];
}

/**
 * 判斷某週是否已過封盤時間（前一週五 00:00）
 * 用於員工端禁止修改
 */
function isWeekLocked(wStr) {
  const dates = getWeekDates(wStr);
  // dates[0] 是週一，往前推 3 天就是上週五
  const [m, d] = dates[0].split('/');
  const monday = new Date(new Date().getFullYear(), parseInt(m) - 1, parseInt(d));
  const lockdown = new Date(monday);
  lockdown.setDate(monday.getDate() - 3);
  lockdown.setHours(0, 0, 0, 0);
  return new Date() >= lockdown;
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
