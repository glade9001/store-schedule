# Phase 2 規格：手機排班優化（可切換經典／手機版）

> 狀態：規格草案（尚未實作）
> 影響檔案：`schedule-V2.html`（主）、`settings.html`（班別預設、班段定義）
> 核心原則：**經典寬表格完整保留、手機版可切換**；優化版只是「同一份資料的另一種渲染＋編輯入口」，**共用** `appData.records` / `syncUIToMemory` / `applyShift`（含 Phase 1 全部勞基法偵測），不分裂資料、不重寫邏輯。

---

## 0. 範圍

Phase 2 只優化 **adminView（可編輯排班）在手機上的操作**。不動薪資、不動 empView 查看圖。

做這些：
1. 檢視模式切換（經典寬表格 ↔ 手機版），使用者自選、記在裝置。
2. 手機版兩種版面：**單日檢視**、**單人檢視**。
3. 複製上週。
4. 儲存格違規標記（複用 Phase 1 偵測）。
5. 底部即時人力計數（每日各時段覆蓋）。

> 註：班別按鈕化**現況已有**（`renderQuickShiftBtns` + `appConfig.shifts` 含時間班別＋自動時數），Phase 2 不需再做，詳見 §4。

不做：多店同畫面、拖曳排班（列為 Phase 2.5 選配）。

---

## 1. 現況

| 元件 | 現狀 |
|---|---|
| 可編輯排班 | `adminView` + `renderTable()`：寬表格（員工 × 7 天），`min-width:820px` 橫向捲動，首欄／表頭 `sticky` |
| 班別編輯 | 點格 → `handleCellClick` → `shiftModal`（底部 sheet）→ `applyShift`（含勞基法偵測、知情放行） |
| 班別快捷 | `shiftModal` 內 `renderQuickShiftBtns()` 讀 `appConfig.shifts` 產生按鈕 → `setModalShift()` |
| 畫筆模式 | `applyPaintToCell`（bulk 塗同一班別，**不跑偵測**） |
| 底部統計 | `dt-0..dt-6`（每日）＋ `weekTotalCell`（本週總計工時／人力成本） |
| 違規標記 | Phase 1 已有 🟠「已放行」（`lawOverrides`） |

**手機痛點**：820px 寬表格要一直左右捲；格子小難點；一次只想處理「某一天」或「某一人」卻得在大表格裡找。

---

## 2. 檢視模式切換

### 2.1 資料

```js
// localStorage，per 裝置；不進 Firestore
scheduleViewMode = 'classic' | 'day' | 'emp'
```

- 預設：`window.innerWidth <= 640 ? 'day' : 'classic'`（手機給單日、桌機給經典），但**使用者切換後以其選擇為準**。
- 切換不重載資料，只換渲染函式；`appData` 不變。

### 2.2 UI

`adminView` 頂部工具列加一個 segmented control：

```
[ 經典 ▦ ]  [ 單日 ▤ ]  [ 單人 ▥ ]
```

- 切換呼叫 `setViewMode(mode)` → 存 localStorage → `renderSchedule()`（新的分派器）。
- `renderSchedule()`：`classic`→現有 `renderTable()`；`day`→`renderDayView()`；`emp`→`renderEmpGridView()`。

---

## 3. 手機版兩種版面

兩者都**複用同一顆 `shiftModal` 與 `applyShift`**（點任何一格 → 一樣的編輯流程與偵測）。差別只在「怎麼排列格子」。

### 3.1 單日檢視 `renderDayView()`

- 頂部：星期 segmented（一二三四五六日），預設今天。
- 內容：**該日所有員工**縱向卡片列，一列一人：

```
┌────────────────────────────┐
│ 楷岳  正職        [ 7-15 ]  │ ← 點右側班別鈕 → shiftModal
│ 農芯  工讀        [ 排休 ]  │
│ 阿明  工讀     [ 7-11,17-21]│ ← 兩頭班一格顯示兩段
│ 🆘待補1          [   +   ]  │
└────────────────────────────┘
```

- 每列右側是班別按鈕（等同現在的一格），點了開 `shiftModal`（`handleCellClick` 需支援「非 table 來源」的 btn，見 §9 風險）。
- 卡片顯示：本店主班、🔵 支援標籤、🟠 已放行、劃休衝突 ⚠️（全部複用 `updateCellUI` 產出）。
- 適合「今天早班誰、缺不缺人」一眼看完。

### 3.2 單人檢視 `renderEmpGridView()`

- 頂部：員工下拉（或左右切換）。
- 內容：**該員整週**縱向 7 列：

```
一 7/21   [ 7-15 ]
二 7/22   [ 15-23]
三 7/23   [ 排休 ]
…
```

- 適合「幫某個人把一週排完」。

> 兩個版面都是**縱向捲動**（手機自然手勢），取代橫向捲動。

---

## 4. 班別按鈕化 — ✅ 現況已有，基本不需做

**更正（2026-07-25）**：班別按鈕化**原本就存在**，不是 Phase 2 要做的。現況：

- `renderQuickShiftBtns()` 依 `appConfig.shifts` 產生按鈕，`shiftModal` 一鍵套用。
- 預設 `DEFAULT_SHIFTS = ['7-15','15-23','23-07','18-23','清空','指休','排休']` → **時間班別按鈕本來就在**。
- `DEFAULT_SHIFT_HOURS = {'7-15':8,'15-23':8,'23-07':8,'18-23':5}` → 套用後**時數自動帶入，免手打**。
- `settings.html` 有 `addShift` UI，店長可自訂班別＋時數。

**唯二選配（皆非必要）：**
1. **兩頭班 combo 按鈕**（如 `7-11,17-21`）：多段已支援 → **直接到 `settings.html` 新增此班別即有按鈕，零改碼**（時數靠多段 autofill 自動加總）。
2. **顯示標籤**：讓按鈕顯示「早」而非「7-15」，需把 `appConfig.shifts` 從字串陣列改為 `{label, value}`。純美化，改動遍及 `renderQuickShiftBtns`／`updateCellUI`／`settings.html`，**投報低，建議不做**。

> 結論：手機版沿用現有 `shiftModal` 的按鈕即可，Phase 2 不必為「按鈕化」寫任何碼。

---

## 5. 複製上週

- 按鈕「📋 複製上週」→ 讀上一週該店 `weeks` records → 寫入本週（**避開已鎖定/已發布**、避開劃休衝突）→ `syncUIToMemory` → 提示「已複製 N 筆，請檢查」。
- **複製後仍需逐格通過偵測**：不自動放行違規；有違規的格子標紅點，待人工開格確認（見 §6）。
- 門市排班 8 成同上週，這是投報最高的省時功能。

---

## 6. 儲存格違規標記（複用 Phase 1）

- 目前偵測只在「開格編輯」時跑。Phase 2 加**批次標記**：渲染時對每格跑一次輕量 `detectScheduleConflicts`（唯讀，不跳 sheet），有 `softBlocks` → 🔴 紅點；有 `lawOverrides` → 🟠 橘點（已放行）。
- 複製上週／匯入後，紅點讓人一眼看出哪些要處理。
- 效能：一週 × 員工數格子，偵測是純記憶體運算，可接受；必要時 debounce。

---

## 7. 底部即時人力計數

現有 `dt-0..dt-6` 是每日工時。新增**每日各時段人力覆蓋**（依班別起始時間分組）：

```
7/21(一)  早2 中1 晚1 大夜1   ← 各時段幾人在班
```

- 依班別**起始時間**歸類到早/中/晚/大夜（用時段分界設定，見 §8）。
- 幫店長即時看出「週三大夜沒人」。
- 單日檢視可置頂顯示當日這行。

---

## 8. 新增設定（`settings.html`）

| 設定 | 用途 |
|---|---|
| 時段分界（早/中/晚/大夜起訖時間） | 底部人力計數分組依據 |

> 班別本身沿用現有 `appConfig.shifts`／`shiftHours`（`settings.html` 已可自訂），不新增設定。

---

## 9. 落地順序與風險

### 落地順序
1. **檢視切換骨架**：`renderSchedule()` 分派器 + segmented control + localStorage。先讓 `classic` 走現有 `renderTable`，確認切換不壞。
2. **單日檢視** `renderDayView()`（最有感），複用 `handleCellClick`/`shiftModal`（班別按鈕沿用現有 `shiftModal`，不另做）。
3. **複製上週**。
4. **單人檢視**、**批次違規紅點**、**底部人力計數**。

### 風險
- ⚠️ **`handleCellClick`/`applyShift` 目前綁定 table 的 `currentCell`（`.cell-btn` DOM）**。手機版卡片的按鈕也要當成「等效 cell」：帶相同 `dataset.emp/day/shift/...`，讓 `applyShift`→`syncUIToMemory` 照舊運作。**關鍵：手機版的「格子」要沿用同一套 dataset 契約**，否則 Phase 1 偵測與存檔會失聯。
- ⚠️ `syncUIToMemory` 目前掃 `.cell-btn`；手機版若不是 `.cell-btn`，同步會漏。**解法**：手機版格子也掛 `.cell-btn` class（隱藏在卡片內），或 `syncUIToMemory` 改為掃「當前渲染出的所有 cell 元件」。此為 Phase 2 最需先設計對的接點。
- 畫筆模式在手機版可暫時停用（單日/單人版面點按已夠快）。

---

## 10. 與 Phase 1 的關係

Phase 2 **不改任何偵測邏輯**，純粹換 UI 呈現與新增便利功能。所有勞基法把關（間隔、連續、當日總時、兩頭班、跨店、知情放行）在 `applyShift` 內，手機版只要走同一個 `applyShift` 就自動繼承。
