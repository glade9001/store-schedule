// ===== 例假／休息日標記（2026-09-28 使用者定案）=====
// 勞檢出勤表（labor-record-page.js）與盤點資料的出勤記錄表（inspection-page.js）共用——同一條規則只寫一份。
// 規則：每週一～週日各標 1 天例假＋1 天休息日。固定規則、不看結果挑：
//   週內最後一個休的日子＝例假、倒數第二個＝休息日（其餘休的日子不另標）。
//   只休 1 天 → 那天是例假（例假不能上班），另一天是休息日出勤 → star（顯示「例假＊」，說明只在系統畫面、不印在紙上，員工在該列旁手寫簽名）
//   整週沒休 → noRest（照實呈現「本週無休（例假出勤）」）
//   週中有未在職（employed=false）或狀態不確定（known=false，例：盤點資料沒填的格子）的日子 → 仍標例假／休息日，但不判 star／noRest
// 依賴 shift-utils.js（shiftDayName、shiftDateAdd）。名稱都帶 rd 前綴。

/** 把 [first, last] 往前後延伸到完整的週一～週日 → { from, to } */
function rdWeekRange(first, last) {
  var from = first, to = last;
  while (shiftDayName(from) !== '週一') from = shiftDateAdd(from, -1);
  while (shiftDayName(to) !== '週日') to = shiftDateAdd(to, 1);
  return { from: from, to: to };
}

/**
 * @param days 從週一開始、長度為 7 的倍數的陣列：[{ rest:bool, employed?:bool, known?:bool }]
 *             就地寫入 restLabel（'例假'｜'休息日'｜''）、star、noRest
 */
function rdLabelWeeks(days) {
  days.forEach(function (x) { x.restLabel = ''; x.star = false; x.noRest = false; });
  for (var i = 0; i + 7 <= days.length; i += 7) {
    var wk = days.slice(i, i + 7);
    var rests = wk.filter(function (x) { return x.rest; });
    if (rests.length >= 1) rests[rests.length - 1].restLabel = '例假';
    if (rests.length >= 2) rests[rests.length - 2].restLabel = '休息日';
    var sure = wk.every(function (x) { return x.employed !== false && x.known !== false; });
    if (!sure) continue;
    if (rests.length === 1) rests[0].star = true;
    if (rests.length === 0) wk[6].noRest = true;
  }
  return days;
}
