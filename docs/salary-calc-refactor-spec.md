# 薪資計算共用模組 `salary-calc.js` — 重構規格（根治三檔飄移）

> 狀態：規格草案（尚未實作）
> 影響檔案：新增 `salary-calc.js`；改 `salary.html`、`my-salary.html`、`analytics.html`（只換函式本體，**不動呼叫點**）
> 目標：把反覆飄移的薪資計算收斂成**單一真相**，未來改公式只改一處。

---

## 0. 為什麼會反覆飄

`recBelongsTo`／`calcEmpHours`／`calcHourlySupportHours`／`calcGross`／`calcDeduct`／`hourlyRate` 這組函式，**在三個 HTML 各抄一份**。只要改其中一份、忘了同步另外兩份，就出現「算薪水 vs 查看薪水 vs 成本分析」對不上。已踩多次（時薪支援費、跨店工時、國定假日…）。**根治＝三檔 import 同一份。**

---

## 1. 關鍵設計：薄 wrapper，呼叫點零改動

這些函式**依賴各檔的全域狀態**（`scheduleData`、`currentMonth`、`empList`），不是純函式。若把它們搬走、要求每個呼叫點都改成傳一堆參數 → 改動面巨大、風險高。

**做法**：把「邏輯本體」搬進 `salary-calc.js`（吃一個明確的 `ctx`），各檔**保留同名薄 wrapper** 把本檔狀態包進去：

```js
// salary.html / my-salary.html 內（本體被抽走，只剩一行委派）
function calcGross(rec){ return SalaryCalc.calcGross(rec, salCtx()); }
function calcEmpHours(n){ return SalaryCalc.calcEmpHours(n, salCtx()); }
function salCtx(){ return { scheduleData, currentMonth, empList, ROLE_PART }; }
```

→ 現有所有 `calcGross(rec)`、`calcEmpHours(name)` **呼叫點一字不改**，只是函式本體變成一行委派。改動面極小、風險低。

---

## 2. 分層架構（重點）

三檔的差異**不是公式，是「輸入從哪來」**：
- salary.html / my-salary.html：從 `scheduleData` **即時算**工時。
- analytics.html：讀**存好的** `rec.hours` / `rec.hourlySupportAmt`（聚合用，不重算）。

所以模組分三層，讓「會飄的公式」共用、「合理不同的輸入來源」各自保留：

| 層 | 函式 | 依賴 | 誰用 |
|---|---|---|---|
| **L1 純函式** | `recBelongsTo(r,emp)`、`hourlyRate(rec)`、`calcDeduct(rec)`、`getWeekDatesFromStr(ws)`、`grossFromParts(rec, parts)` | 無（只吃參數） | 三檔全用 |
| **L2 取工時**（需排班） | `calcEmpHours(emp, ctx)`、`calcHourlySupportHours(emp, ctx)`、`calcEmpHolidayHours(emp, ctx)` | `scheduleData`、`currentMonth` | salary、my-salary |
| **L3 組合**（薄 wrapper，各檔） | `calcGross(rec)`、`calcTotal(rec)` | 本檔狀態 | 各檔 |

**核心分離**：`grossFromParts(rec, {role, totalH, hourlySupportAmt})` 是**純算術公式**（會飄的那塊），三檔共用；工時/支援費由各檔決定「即時算 or 讀存好的」再餵進來。

```js
// L1 純算術：正職/工讀應發，給定 role 與已算好的 totalH / hourlySupportAmt
function grossFromParts(rec, { role, totalH, hourlySupportAmt, rph }) {
  if(role === ROLE_PART){
    const wage=n(rec.wage), roleBonus=n(rec.roleBonus);
    const gross=Math.round(wage*(totalH+n(rec.extraHours))+wage*n(rec.holidayHours)+roleBonus);
    return Math.max(0, gross-Math.abs(n(rec.personalSickLeave)));
  }
  // 正職/店長：base + 各獎金 + 加班 + hourlySupportAmt - 遲到 - 病假
  ... // 與現行 salary.html calcGross 正職分支「逐字」相同
}
```

---

## 3. `salary-calc.js` 內容（以 salary.html 現行版為唯一基準）

- **一律以 `salary.html` 目前的實作為準**（它是發薪基準）。my-salary/analytics 若不同，一律改成跟它一致。
- 用 IIFE 掛 `window.SalaryCalc`，無外部套件：

```js
window.SalaryCalc = (function(){
  const DAY=['週一','週二','週三','週四','週五','週六','週日'];
  const n=v=>parseFloat(v||0);
  function getWeekDatesFromStr(ws){ /* 三檔目前一致，搬進來 */ }
  function recBelongsTo(r,emp){ /* 本名 或 supportEmp 後段 */ }
  function hourlyRate(rec){ return (n(rec.baseSalary)+n(rec.fullAttendBase)+n(rec.otherBase))/30/8; }
  function calcDeduct(rec){ /* 五項加總 */ }
  function calcEmpHours(emp,ctx){ /* recBelongsTo + 跳 isHourly + 按日去重（salary.html 版） */ }
  function calcHourlySupportHours(emp,ctx){ /* recBelongsTo + isHourly + 按日去重 */ }
  function calcEmpHolidayHours(emp,ctx){ /* 國定假日出勤時數 */ }
  function grossFromParts(rec,parts){ /* 純算術，見上 */ }
  return { getWeekDatesFromStr, recBelongsTo, hourlyRate, calcDeduct,
           calcEmpHours, calcHourlySupportHours, calcEmpHolidayHours, grossFromParts,
           ROLE_PART:'工讀' };
})();
```

---

## 4. 各檔怎麼接

### salary.html / my-salary.html（即時算）
- 移除本檔 `recBelongsTo/hourlyRate/calcDeduct/calcEmpHours/calcHourlySupportHours/calcEmpHolidayHours/getWeekDatesFromStr` 的**本體**，改留薄 wrapper 委派給 `SalaryCalc`（吃本檔 `scheduleData/currentMonth`）。
- `calcGross(rec)` wrapper：
  ```js
  function calcGross(rec){
    const role=(empList.find(e=>e.name===(rec.empName||rec.name||''))||{}).role || rec.role;
    const totalH=SalaryCalc.calcEmpHours(rec.empName||rec.name||'',{scheduleData,currentMonth}).totalH;
    const hsAmt=Math.round(SalaryCalc.calcHourlySupportHours(rec.empName||'',{scheduleData,currentMonth})*n(rec.hourlySupportRate));
    return SalaryCalc.grossFromParts(rec,{role,totalH,hourlySupportAmt:hsAmt,rph:SalaryCalc.hourlyRate(rec)});
  }
  ```
- **結果**：兩檔的 `calcGross`/`calcEmpHours` 呼叫點全不動，行為變成完全一致（my-salary 自動吃到正確版）。

### analytics.html（讀存好的值，不重算）
- `calcDeduct`/`hourlyRate`/`recBelongsTo` → 直接用 `SalaryCalc`（純函式，行為不變）。
- `calcGross(rec,role)` → 改用 `SalaryCalc.grossFromParts(rec,{role, totalH: n(rec.hours), hourlySupportAmt: n(rec.hourlySupportAmt), rph: SalaryCalc.hourlyRate(rec)})`。
  - **輸入用存好的** `rec.hours`/`rec.hourlySupportAmt`（維持 analytics 不載排班的設計），但**公式與 salary.html 共用同一份 `grossFromParts`** → 公式再也不會飄。

---

## 5. 載入方式

純 PWA、無打包工具，用 `<script>`（比照現有 `utils.js`）：
```html
<script src="salary-calc.js"></script>   <!-- 放在其他 script 之前 -->
```
三檔都加。`sw.js` 的 precache 清單加入 `salary-calc.js` 並**升 SW 版本**（否則舊快取拿不到新檔）。

---

## 6. 遷移步驟（低風險、逐步、每步可回歸驗證）

| 步 | 內容 | 驗證 |
|---|---|---|
| 1 | 建 `salary-calc.js`，**逐字複製 salary.html 現行版**的 L1+L2 函式；三檔加 `<script>` | 載入無錯 |
| 2 | **salary.html** 先接：本體換薄 wrapper | 隨機抽數位員工，接前/接後 `calcGross/calcTotal` **數字完全相同**（salary 不可變） |
| 3 | **my-salary.html** 接 | my-salary 數字變成 == salary.html（楷岳 6 月 37h、國定假日 2 倍） |
| 4 | **analytics.html** 接（`grossFromParts` + 存好輸入） | analytics 各員 gross 接前/接後相同（它本來就對） |
| 5 | 移除三檔已無用的舊函式本體、升 SW 版 | 全站冒煙測試 |

**原則**：salary.html 是基準，步驟 2 必須「數字零變化」才算成功；my-salary 步驟 3 是「數字趨近 salary.html」（修正飄移）。

---

## 7. 回歸驗證方法（關鍵）

寫一段一次性比對（可在 console 或用 Firestore 撈實際資料的 Node 腳本）：
- 對某月**全體員工**，各自算 `calcGross_old`（接模組前）與 `calcGross_new`（接模組後）。
- **salary.html**：要求 `old === new`（逐人）。
- **my-salary / analytics**：列出 `old !== new` 的人 → 這些正是原本飄掉、現在被修正的（預期只往「與 salary.html 一致」的方向變）。

沿用先前撈楷岳資料的 Firestore REST 腳本即可批次驗。

---

## 8. 風險與注意

- ⚠️ **`ROLE_PART` 等常數**：各檔可能定義不同字面值，模組內固定用 `'工讀'`；接線時確認一致。
- ⚠️ **`getWeekDatesFromStr` 需三檔目前完全相同**（已確認一致）才可安全上收；若有細微差異，以 salary.html 版為準。
- ⚠️ **analytics 不可改成即時算**（會逼它載排班、變慢又可能與存檔不符）——只共用「純公式」，輸入仍讀存好的。
- ⚠️ **payHash（`computePayHash`）**：目前只在 salary.html。可一併移入模組供 my-salary/home 需要時比對，但**寫入仍只由 salary.html 做**（單一來源不變）。
- SW 版本務必升，否則使用者拿到舊快取的三檔配新 `salary-calc.js` 會不一致。

---

## 9. 效益

- 未來任何薪資公式調整 **只改 `salary-calc.js` 一處** → 三檔自動一致，飄移根絕。
- `grossFromParts` 純函式**可單元測試**（給 rec + parts → 期望金額），日後改公式先跑測試。
