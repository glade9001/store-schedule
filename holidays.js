/**
 * 台灣國定假日 —— 全專案唯一版本
 *
 * ⚠️ 為什麼要有這個檔（2026-09-12）：
 *   原本同一份資料散在五個地方，而且分成兩種互相矛盾的版本：
 *     salary-page.js / my-salary-page.js / schedule-v2-page.js  → 春節 1/26~1/29、清明 4/5、中秋 9/25
 *     leave-request-page.js / settings-page.js                  → 春節 1/28~2/2、清明 4/4、中秋 9/26
 *   而 115 年（2026）的正確日期是「除夕 2/16、春節 2/17~2/19、中秋 9/25」——
 *   **五份全錯**：前三份的春節是憑空的日期，後兩份整份晚了一年（2026 區塊放的是 2025 的春節）。
 *   國假直接決定加班費，這種錯是會少算錢的。
 *
 * ⚠️ 2026 年起因《紀念日及節日實施條例》新增四個假日，舊表通通沒有：
 *   小年夜（除夕前一日）、教師節 9/28、臺灣光復節 10/25、行憲紀念日 12/25。
 *
 * 資料來源：行政院人事行政總處「政府行政機關辦公日曆表」115 年、116 年核定版。
 *
 * 【只列正式假日，不列補假日】
 *   沿用專案原本的口徑。理由：本系統的門市全年無休、採輪班制，
 *   員工的例假／休息日不一定是週六日，所以「國定假日當天出勤」就是加倍的那一天；
 *   補假是為週休二日的行政機關設計的。若日後要改成把補假日也算國假，
 *   請連同「已發布月份不得變動」一起評估（published 月份讀的是存檔快照，不受影響）。
 *
 * ⚠️ 每年十二月要更新下一年度：Firestore settings/holidays/years/{年} 會覆蓋本表，
 *   可由「系統設定 → 國定假日」維護；本表只是讀不到時的保底。
 *
 * 本檔刻意「只有 function 宣告、沒有任何頂層 const」——與 shift-utils.js 同一個規矩，
 * 任何頁面掛上來都不會撞名把整段 script 打掛。新增內容請維持這個限制。
 */

/** 年度 → { 'YYYY-MM-DD': 名稱 } */
function builtinHolidaysByYear() {
  return {
    '2026': {
      '2026-01-01': '元旦',
      '2026-02-15': '小年夜',          // 週日（行政機關補假 2/20，本表不列補假）
      '2026-02-16': '農曆除夕',
      '2026-02-17': '春節', '2026-02-18': '春節', '2026-02-19': '春節',
      '2026-02-28': '和平紀念日',      // 週六（補假 2/27）
      '2026-04-04': '兒童節',          // 週六
      '2026-04-05': '清明節',          // 週日（補假 4/3、4/6）
      '2026-05-01': '勞動節',
      '2026-06-19': '端午節',
      '2026-09-25': '中秋節',
      '2026-09-28': '教師節',          // 2026 新增
      '2026-10-10': '國慶日',          // 週六（補假 10/9）
      '2026-10-25': '臺灣光復節',      // 2026 新增・週日（補假 10/26）
      '2026-12-25': '行憲紀念日',      // 2026 新增
    },
    '2027': {
      '2027-01-01': '元旦',
      '2027-02-04': '小年夜',
      '2027-02-05': '農曆除夕',
      '2027-02-06': '春節', '2027-02-07': '春節', '2027-02-08': '春節',
      '2027-02-28': '和平紀念日',      // 週日（補假 3/1）
      '2027-04-04': '兒童節',          // 週日（補假 4/6）
      '2027-04-05': '清明節',
      '2027-05-01': '勞動節',          // 週六（補假 4/30）
      '2027-06-09': '端午節',
      '2027-09-15': '中秋節',
      '2027-09-28': '教師節',
      '2027-10-10': '國慶日',          // 週日（補假 10/11）
      '2027-10-25': '臺灣光復節',
      '2027-12-25': '行憲紀念日',      // 週六（補假 12/24）
    },
  };
}

/** 攤平成 { 'YYYY-MM-DD': 名稱 } */
function builtinHolidayMap() {
  var byYear = builtinHolidaysByYear();
  var out = {};
  for (var y in byYear) for (var d in byYear[y]) out[d] = byYear[y][d];
  return out;
}

/**
 * 讀取國定假日：Firestore settings/holidays/years/{年} 優先、內建保底
 * @param {Array<number|string>} years 要讀的年份
 * @returns {Promise<{map:Object, source:string}>} source='firestore'|'builtin'|'mixed'
 */
async function loadHolidayMap(years) {
  var byYear = builtinHolidaysByYear();
  var map = {}, hit = 0, miss = 0;
  var list = years || [];
  for (var i = 0; i < list.length; i++) {
    var yr = String(list[i]);
    var fromDb = null;
    try {
      var snap = await window.db.collection('settings').doc('holidays')
        .collection('years').doc(yr).get();
      if (snap.exists && snap.data().dates) fromDb = snap.data().dates;
    } catch (e) { /* 讀不到就用內建 */ }
    // ⚠️ 該年度有 Firestore 資料就「整年度換掉」，不可與內建合併：
    //    合併會讓已被取消或改期的舊假日變成刪不掉的幽靈。
    var src = fromDb || byYear[yr] || {};
    for (var d in src) map[d] = src[d];
    if (fromDb) hit++; else miss++;
  }
  return { map: map, source: (hit && miss) ? 'mixed' : hit ? 'firestore' : 'builtin' };
}
