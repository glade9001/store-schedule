# 員工薪資簽收（簽名板版）— 實作規格

> 狀態：規格草案（尚未實作，待確認後動碼）
> 影響檔案：`salary.html`（存 payHash + 管理者簽收狀態欄）、`my-salary.html`（簽名簽收）、`home.html`（待簽收提醒）、Firestore 安全規則
> 目標：員工每月對已發布薪資**手寫簽名簽收**；未簽首頁提醒；薪資改過需重簽；**發布才提醒、收回發布提醒自動消失**；2026-07 起。

---

## 0. 定案決策

| # | 決策 | 定案 |
|---|---|---|
| 1 | 簽收方式 | **簽名板**（canvas 手寫） |
| 2 | 簽收紀錄 | **獨立 `salaryAck`／`salaryAckSig` collection**（員工只能寫自己的，salary 記錄不開放給員工） |
| 3 | 更新重簽判定 | **payHash 內容指紋**（只有金額變的人重簽） |
| 4 | 誰要簽 | **全部有薪資記錄的人**（含店長；加盟主本人若有薪資記錄亦同） |
| 5 | 簽名圖存法 | **狀態與簽名圖分兩層**（狀態 doc 輕、圖另存；首頁提醒不載圖） |
| 6 | 管理者簽收狀態欄 | **這批一起做** |
| 7 | 啟動月份 | **2026-07**（常數 `SALARY_ACK_START = '2026-07'`） |

發布閘門沿用現有 `salaryData.status`（`draft/submitted/approved/published`，doc 層級）。

---

## 1. 資料模型

### 1.1 salary 記錄新增 `payHash`（`salary.html` 存檔時寫）
`stores/{store}/salary/{YYYY-MM}.records[]` 每筆新增：
```
payHash: 'a1b2c3'   // 該員薪資金額的內容指紋
```

### 1.2 簽收狀態（輕層，首頁/清單讀這層）
```
salaryAck/{uid}_{YYYY-MM}
  { uid, empName, store, month:'2026-07',
    signedPayHash:'a1b2c3',      // 簽收當下的 payHash
    signedAt:'2026-08-05T14:30:00+08:00' }
```

### 1.3 簽名圖（重層，只有要看時才讀）
```
salaryAckSig/{uid}_{YYYY-MM}
  { signatureDataUrl:'data:image/png;base64,...' }   // 約 15–30KB
```

> docId 用 `{uid}_{YYYY-MM}`：查詢/寫入都不需複合索引，安全規則也好寫。

---

## 2. `payHash` 定義

- **時機**：`salary.html` 存檔（含發布）時，對每筆記錄計算並寫入 `record.payHash`。
- **內容**：涵蓋員工在薪資單上看到的金額，任一變動即需重簽。取以下欄位（缺值以 0/'' 計）：
  - 計算總額：`calcGross(rec)`、`calcDeduct(rec)`、實發（gross − deduct）
  - 主要組成：`baseSalary, fullAttendBonus, mgmtOps, mgmtQuality, mgmtKPI, mgmtAccount, mgmtLeader, laborAllowance, performance, nightAllowance, roleBonus, otherBonus, annualLeaveEncash, compLeaveEncash, otHours, restDayOtPay, holidayOtPay, hourlySupportRate, hourlySupportAmt, wage, extraHours, holidayHours, lateMinutes, personalSickLeave, laborInsurance, healthInsurance, dependentInsurance, laborPension, otherDeduction`
- **雜湊法**：上述欄位 **key 排序 → 組成字串 → 小型雜湊**（cyrb53，約 10 行，無外部套件）。
- **單一來源**：只有 `salary.html` 算 payHash 並寫入；`my-salary`／`home` 只讀 `record.payHash` 比對，不自行重算（避免三處算法不一致的老雷）。

```js
// 參考雜湊（cyrb53）
function cyrb53(str, seed=0){ let h1=0xdeadbeef^seed, h2=0x41c6ce57^seed;
  for(let i=0,ch;i<str.length;i++){ch=str.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (h2>>>0).toString(16).padStart(8,'0')+(h1>>>0).toString(16).padStart(8,'0'); }
```

---

## 3. Firestore 安全規則（需新增並部署）

```
match /databases/{db}/documents {
  match /salaryAck/{id} {
    allow read: if request.auth != null;                         // 本人看自己、管理者看清單
    allow create, update: if request.auth != null
      && request.resource.data.uid == request.auth.uid           // 只能寫自己的
      && id == request.auth.uid + '_' + request.resource.data.month;
    allow delete: if false;                                      // 不可刪（留存證）
  }
  match /salaryAckSig/{id} {
    allow read: if request.auth != null;
    allow create, update: if request.auth != null
      && id.split('_')[0] == request.auth.uid;
    allow delete: if false;
  }
}
```
- salary 記錄權限**完全不動**（員工碰不到別人薪水）。
- 部署：`firebase deploy --only firestore:rules`（若 repo 尚無 `firestore.rules` 需先建立，並確認不覆蓋現有規則）。

---

## 4. `my-salary.html` 改動（簽名簽收）

### 4.1 狀態判定（該月 `status==='published'` 才進入簽收流程）
讀 `salaryAck/{myuid}_{M}`：
- 無此 doc → **未簽**
- `ack.signedPayHash === record.payHash` → **已簽**
- 不等 → **需重簽**（薪資改過）

顯示：
- 未簽／需重簽 → 紅／橘「✍️ 簽名簽收」按鈕（需重簽附「薪資已更新，請重新確認」）。
- 已簽 → 「✅ 已於 8/5 14:30 簽收」（可點開看自己簽名）。

### 4.2 簽名視窗（canvas）
- Modal：白色畫布 + 「清除重畫」「確認簽收」「取消」。
- 技術：畫布依 `devicePixelRatio` 放大解析度避免模糊；`touchstart/touchmove` 內 `preventDefault` 防頁面滾動；畫布高度適中（手機好簽）。
- 「確認簽收」→ `canvas.toDataURL('image/png')`：
  1. 寫 `salaryAck/{uid}_{M}`：`{uid, empName, store, month, signedPayHash: record.payHash, signedAt}`
  2. 寫 `salaryAckSig/{uid}_{M}`：`{signatureDataUrl}`
- 空白簽名（沒畫）擋下，提示「請先簽名」。

---

## 5. `home.html` 改動（待簽收提醒）

登入後（本人）：
1. 月份 `SALARY_ACK_START(2026-07) → 當月` 逐月（可只掃最近 3–6 個月）：
   - 讀發薪店 `salary/{M}`：`status==='published'` 且本人在 `records[]` 有記錄 → 取其 `record.payHash`。
   - 讀 `salaryAck/{uid}_{M}`（**只讀輕層、不載圖**）。
   - `published && (無 ack || ack.signedPayHash !== record.payHash)` → 列入「待簽收」。
2. 有待簽收 → 首頁卡片：「⚠️ 你有 2026-07、2026-08 薪資待簽收」→ 點擊跳 `my-salary.html` 該月。
3. 收回發布（status 變 draft）→ 條件 1 不成立 → 下次登入提醒自動消失（不需清旗標）。

> **發薪店判定**：用 `currentUser.store`；若曾調店、歷史月份在舊店，沿用 my-salary 既有「找不到就掃其他門市」的 fallback 一併查。

---

## 6. `salary.html` 改動

### 6.1 存 payHash
存檔／發布時，對每筆記錄算 §2 的 payHash 寫入 `record.payHash`。

### 6.2 管理者「簽收狀態」欄（加值）
薪資列表每位員工顯示：
- ✅ 已簽（signedAt；點擊從 `salaryAckSig` **載入簽名縮圖**，平時不載）
- ⬜ 未簽
- 🟠 需重簽（`ack.signedPayHash !== record.payHash`，即發布後又改過）
- （該月 `status !== 'published'` → 顯示「未發布」，不判簽收）

---

## 7. 邊界與注意

- **改已發布薪資**：現有規則「發布後不可改，需先收回」。收回→提醒消失；改完重發→payHash 若變→該員自動「需重簽」。
- **離職／調走**：只提醒仍能登入的在職者；歷史月份補簽與否之後再議。
- **無 uid 的舊帳號**：無法簽名，需先補建 `users/{uid}`（與過往 account/users 同步問題相關）。
- **加盟主/店長**：只要該月 salary 有其記錄即納入簽收（決策 4）。
- **薪資單金額顯示**須與 payHash 涵蓋欄位一致（都以 salary.html 的 calcGross/calcDeduct 為準）。

---

## 8. 落地順序

| 步驟 | 內容 | 可獨立驗證 |
|---|---|---|
| 1 | `salary.html` 算並存 `record.payHash`（cyrb53 + 欄位清單） | 存檔後檢查記錄有 payHash、改金額後值會變 |
| 2 | 安全規則新增 `salaryAck`/`salaryAckSig` 並部署 | 用非本人 uid 測試寫入被擋 |
| 3 | `my-salary` 簽名板 + 三態顯示 + 寫入兩層 | 簽名後狀態變已簽、改薪後變需重簽 |
| 4 | `home` 待簽收提醒（published 閘門 + payHash 比對） | 發布→提醒出現；收回→消失；簽收→消失 |
| 5 | `salary.html` 管理者簽收狀態欄（縮圖點擊才載） | 對照各員狀態正確 |

先 1→2→3（員工能簽），再 4（首頁提醒），最後 5（管理者名單）。
