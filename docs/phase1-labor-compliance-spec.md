# Phase 1 規格：排班勞基法防呆引擎（跨日間隔演算法 + 欄位定義）

> 狀態：規格草案（尚未實作）
> 影響檔案：`schedule-V2.html`（主）、`salary.html` / `my-salary.html` / `analytics.html`（payOverride 接點）、`settings.html`（新設定項）
> 核心哲學：**軟擋 + 知情放行 + 稽核**，不硬擋死營運；硬擋只留給「物理不可能」與「絕對禁止」。

---

## 0. 範圍

Phase 1 只做兩件事：

1. **把現有壞掉的勞基法檢查修正、補齊**（跨日 / 跨週 / 跨店 / 同日分段 / 小數時間）。
2. **導入放行紀錄（`lawOverride`）與計薪覆寫（`payOverride`）兩個欄位。**

不做統計儀表板、不改資料模型（`stores/{store}/weeks/{YYYY-Www}` 維持一週一筆）。

---

## 1. 背景：現況與 Bug

`schedule-V2.html` 已有 `detectScheduleConflicts()`（約 `:2542`），目前做四件事：

| # | 檢查 | 現況 |
|---|---|---|
| 1 | 同日跨店衝突 | 🔴 硬錯誤 — **過度嚴格**（見 §4） |
| 2 | 單日 >12h | 🟡 警告 — 只看單筆，未跨店加總 |
| 3 | 連續 7 天 | 🟡 警告 — 自承「下週不算」，跨週漏報 |
| 4 | 距上班 <11h | 🟡 警告 — **算法錯誤**（見下） |

### 1.1 間隔算法 Bug（實務已遇到的誤報）

問題碼（`schedule-V2.html:2588-2615`）：

```js
let gap = curStart - prevEnd;
if(gap < 0) gap += 24;   // 只 +24 一次，等於假設兩班永遠差不到一天
```

且 `parseEndHour`/`parseStartHour` 用 `parseInt`（`15.5` 被截成 `15`）。

**最小重現**：昨天 `7-11`（11:00 下班），今天 `13-21`（13:00 上班）
- 真實間隔 = 昨 11:00 → 今 13:00 = **26 小時**（合法）
- 現行碼：`gap = 13 - 11 = 2` → 誤報「距前一班下班僅 2 小時」

**根因**：程式只有「時刻」沒有「日期」概念。當 `curStart > prevEnd` 時，真實差距是「24＋差值」（跨了一整天），程式卻只算差值。

---

## 2. 核心演算法：班次 → 帶日期的絕對時間

所有檢查一律建立在「絕對時間軸（epoch ms）」上，不用時刻相減。

```js
// 班次字串 → {start, end}(ms)；非時間班別(排休/指休/特休/補休)回 null
function shiftToInterval(dateISO, shiftStr) {
  const m = (shiftStr || '').match(/^(\d{1,2}(?:\.\d+)?)-(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  const startH = parseFloat(m[1]);            // 15.5 保留小數（15:30）
  const endH   = parseFloat(m[2]);
  const base   = new Date(dateISO + 'T00:00:00').getTime();
  let start = base + startH * 3600e3;
  let end   = base + endH   * 3600e3;
  if (endH <= startH) end += 24 * 3600e3;     // ← 跨夜：下班推隔天（缺這行就錯）
  return { start, end };
}
```

`dateISO` 由 `(weekStr, dayName)` 轉成真實日期（沿用現有 `getWeekDates(weekStr)` + `dayNames`）。

### 2.1 間隔檢查

```js
// 檢查 target 前後鄰班間隔是否 < minRestH（兩側都要查：插一班同時影響前後）
function checkRestInterval(targetInterval, allIntervals, minRestH) {
  const issues = [];
  const prev = allIntervals.filter(iv => iv.end <= targetInterval.start)
                           .sort((a, b) => b.end - a.end)[0];
  if (prev) {
    const gapH = (targetInterval.start - prev.end) / 3600e3;
    if (gapH < minRestH) issues.push({ side: 'before', gapH, other: prev });
  }
  const next = allIntervals.filter(iv => iv.start >= targetInterval.end)
                           .sort((a, b) => a.start - b.start)[0];
  if (next) {
    const gapH = (next.start - targetInterval.end) / 3600e3;
    if (gapH < minRestH) issues.push({ side: 'after', gapH, other: next });
  }
  return issues;
}
```

> 中間隔了整個例假/休假日時 gap 自然很大、不會誤報 —— **不需**為「例假隔開」寫例外，絕對時間軸天然處理。

### 2.2 重疊判斷（同日跨店用）

```js
function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;  // 端點相接(15 接 15)不算重疊
}
```

---

## 3. 鄰班資料來源（跨週 / 跨店 / 同日分段，缺一就漏報）

`allIntervals` 必須涵蓋該員這段期間**所有店的所有工班**：

| 來源 | 現有依據 | 需補 |
|---|---|---|
| 本週本店 | `appData.records` | — |
| 跨店同期 | `appData.allStoresRecords`（已載入，含 `_store`/`week`） | 濾 `r.name === emp` |
| 跨週邊界 | 目前只讀當週 | **多讀前一週、後一週**該員 weeks（`23-07` 週日跨週一） |
| 同日分段班 | 一天可能多筆 record | 全展開，勿只取一筆 |

**組裝步驟**

```
1. 蒐集 [prevWeek, thisWeek, nextWeek] × [本店 + allStoresRecords 各店] 該員所有 record
2. 每筆 (weekStr, day) → 真實日期 dateISO → shiftToInterval()
3. 排除休假類(null) 與「正在編輯的那格自己」
4. 得 allIntervals[]
```

---

## 4. 同日跨店：從「同天」改為「時間重疊」

**現況錯誤**：`schedule-V2.html:2553` 只要「同天 + 不同店 + 有班」就硬擋。但實務有「同日、不同時段、跨店補班」（例：早上支援店 `7-15`、晚上本店 `18-22`，甚至排不出人時上到 16 小時），這是合法營運需求，被誤擋。

**正解**：一個人不可能同一時刻在兩家店，所以只有**時間重疊**才硬擋；不重疊則交給統一時間軸判斷。

| 情境 | 判定 | 理由 |
|---|---|---|
| 兩班時間重疊 | 🔴 硬擋 | 物理不可能，資料錯 |
| 同日不重疊 | ✅ 放行，續判以下 | 合法補班 |
| 當日總時數 >12h（跨店加總，含 16h 情境） | 🟠 軟擋 `daily12h` | 違 §32 但需可放行 |
| 相鄰間隔 <11h | 🟠 軟擋 `rest11h` | §34 |

### 4.1 當日總時數需「跨店加總」

現行 >12h 只看單筆 `newHours`。改為把同一「工作日」（以班次開始日歸戶）跨店所有 interval 時長相加：

```js
const dailyTotal = sameDayIntervals.reduce((s, iv) => s + (iv.end - iv.start) / 3600e3, 0);
if (dailyTotal > dailyMax) softBlocks.push({ rule: 'daily12h', total: dailyTotal });
```

16 小時案例：`7-15`(8h) + `17-01`(8h) = 16h → `daily12h` 軟擋 → 確認框填理由（`coverage` 排不出人）→ 放行並記 `lawOverride`。

---

## 5. 三級違規模型

`detectScheduleConflicts` 回傳擴為三級（保留現有簽章與 `applyShift` 呼叫點 `:2619`）：

```js
return { errors, warnings, softBlocks };
```

| 等級 | 內容 | 行為 |
|---|---|---|
| 🔴 `errors` | 同時段跨店重疊、未滿18歲夜間(22:00–06:00) | `alert` 後中止，**不可存** |
| 🟠 `softBlocks` | `rest11h` / `weekly1off` / `daily12h` / `monthlyOt46` | 跳確認框，**填理由才存**（產生 `lawOverride`） |
| 🟡 `warnings` | 接近月加班 46h、單週 >40h | 存但標紅點，不擋 |

`applyShift` 流程：`errors` → 中止；`softBlocks` → 開確認框取得 `lawOverride` 後寫入；`warnings` → 寫入並標記。

### 5.1 各規則對照法源

| rule | 法源 | 觸發 |
|---|---|---|
| `rest11h` | §34 | 相鄰兩班間隔 < 設定值（預設 11h） |
| `weekly1off` | §36 | 連續出勤達 7 天（含跨週） |
| `daily12h` | §32 | 當日總時數（跨店加總）> 設定值（預設 12h） |
| `monthlyOt46` | §32 | 當月累計加班 > 設定值（預設 46h） |
| （硬擋）未滿18夜間 | §48 | 未滿18歲排 22:00–06:00 |

---

## 6. 欄位規格：`lawOverride`（寫入 records[] 該筆）

建議存**陣列**（一筆可同時觸發多條，稽核好撈）：

```js
{
  name: '農芯', day: '三', shift: '23-07', h: 8, /* 現有欄位不動 */
  lawOverrides: [
    {
      rule: 'rest11h',           // rest11h | weekly1off | daily12h | monthlyOt46
      measured: 9.5,             // 觸發當下實測值（間隔小時 / 當日總時數 / 月加班數）
      reason: 'coverage',        // voluntary | urgent | coverage | other
      note: '排不出人支援',
      approvedBy: '楷岳',        // currentUser.displayName
      approverPerm: 'manager',   // 放行者權限（設定可要求 manager 以上）
      at: '2026-07-25T14:30:00'  // new Date().toISOString()
    }
  ]
}
```

- 不填 / 空陣列 = 無違規放行。
- **稽核表資料源**：掃 `stores/*/weeks/*.records[].lawOverrides`，不需另建 collection。

---

## 7. 欄位規格：`payOverride`（＋薪資三檔接點）

```js
{
  payOverride: {
    basis: 'fixed',   // legal(預設,不填即此) | hourly | fixed | none
    amount: 800,      // hourly=時薪；fixed=整班金額
    note: '談定包班'
  }
}
```

### 7.1 薪資三檔接點（必須同步，否則金額對不上）

以 `salary.html` 的 `calcGross` 為正確基準，三檔逐條對齊：

| 檔案 | 函式 | 改動 |
|---|---|---|
| `salary.html` | `calcGross` | 計某筆工時薪資前先看 `payOverride.basis`：`fixed`→加 amount 不乘時數；`hourly`→amount×時數；`none`→跳過此筆；`legal`/無→現行邏輯 |
| `my-salary.html` | `calcGross` | 同上逐條對齊 |
| `analytics.html` | `calcGross` / 成本矩陣 | 同上，人事成本才正確 |

> `payOverride` 用意是收斂現有散落旗標（`isHourly` / `hourlySupportRate` / `customOtRate` / `customOtEnabled`）。**第一版只新增、先不拔舊旗標**，確認三檔一致後再遷移。

---

## 8. 手機確認框（軟擋 UI）

- 底部彈起 **sheet**（非置中 alert，手機好按）：
  - 紅底標題：`⚠️ 輪班間隔僅 9.5 小時`
  - 一行說明衝突對象：`與 7/24(三)「23-07」相距不足`
  - **理由下拉**：自願 / 急需 / 代班 / 其他
  - 選填備註
  - 兩顆大按鈕：`取消` ／ `知情放行並儲存`
- 排班格子違規標記：未放行 = 紅點；已放行 = 橘點（長按看放行紀錄）。

---

## 9. 測試案例（實作後照表驗）

| # | 情境 | 前/A | 目標/B | 真實 | 應判 |
|---|---|---|---|---|---|
| 1 | 跨日誤報 | 昨 `7-11` | 今 `13-21` | 26h 間隔 | ✅ 通過（現行誤報 2h） |
| 2 | 夜接早 | 昨 `15-23` | 今 `7-15` | 8h 間隔 | 🟠 `rest11h` |
| 3 | 大夜臨界 | 週一 `23-07` | 週二 `18-22` | 11h 間隔 | ✅ 剛好通過 |
| 4 | 跨週 | 週日 `23-07` | 週一 `10-18` | 3h 間隔 | 🟠 `rest11h`（現行漏報） |
| 5 | 跨店間隔 | 本店 `23-07` | 他店 `9-17` | 2h 間隔 | 🟠 `rest11h`（現行漏報） |
| 6 | 同日分段 | 今 `7-11` | 今 `18-22` | 7h 間隔 | 🟠 `rest11h` |
| 7 | 小數時間 | 昨 `15.5-23` | 今 `8-16` | 9h 間隔 | 🟠 `rest11h`（現行 parseInt 算錯） |
| 8 | 跨店重疊 | A `9-17` | B `13-21` | 重疊 13–17 | 🔴 硬擋 |
| 9 | 跨店不重疊 | A `7-15` | B `18-22` | 間隔 3h | 🟠 `rest11h`（不重疊≠合法） |
| 10 | 跨店 16h | A `7-15` | B `17-01` | 當日 16h | 🟠 `daily12h`（知情放行） |

---

## 10. 新增設定項（`settings.html`，加盟主權限）

| 設定 | 預設 | 說明 |
|---|---|---|
| 輪班最小間隔 | 11h | §34；經核備可調 8h |
| 單日工時上限 | 12h | §32 |
| 月加班上限 | 46h | §32；經勞資會議可 54h |
| 放行者最低權限 | manager | 誰可以「知情放行」軟擋 |
| 基本工資（時薪/月薪） | 依當年度 | 供低於基本工資檢查 |

---

## 11. 落地順序（Phase 1 內部）

1. **修間隔算法**：以 `shiftToInterval` + `checkRestInterval` 取代壞掉的 `parseEndHour` mod-24。→ 案例 1–3、7 轉綠。最小改動、可獨立驗證。
2. **補鄰班撈取 + 同日跨店改判**：跨週 + 跨店 `allIntervals`；同日跨店由「同天硬擋」改「重疊硬擋、超時軟擋」，當日總時數跨店加總。→ 案例 4–6、8–10 轉綠。
3. **三級 + `lawOverride` 確認框**：`detectScheduleConflicts` 回傳三級；`applyShift` 接確認框；格子紅/橘點；稽核表資料源。
4. **`payOverride` + 薪資三檔**：獨立一批做，用既有薪資對帳流程驗（風險在薪資端）。
