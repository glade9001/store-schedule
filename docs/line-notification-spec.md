# LINE 通知系統 — 規格（LINE 官方帳號 Messaging API）

> 狀態：規格草案（尚未實作）
> 目標：事件發生（薪資發布、劃休開放…）時，透過 LINE 官方帳號**主動推播**給員工，不用點開 App。
> 影響：新增 Cloud Functions（webhook + 推播）、Firestore（綁定資料）、前端「綁定 LINE」入口。

---

## 0. 前置：你要先在 LINE 端做的事（我無法代做）

1. 到 **LINE Developers Console** 建一個 **Messaging API channel**（＝官方帳號）。
2. 取得三樣（都是機密，交給我放進 Cloud Functions 環境，勿放前端）：
   - **Channel access token（long-lived）**
   - **Channel secret**
   - 官方帳號的 **加好友連結／QR / Basic ID（@xxxx）**
3. 在 console 設定 **Webhook URL**（＝我建立的 Cloud Function 網址，實作後給你貼上）、開啟「Use webhook」、關閉「自動回應訊息」。

> ⚠️ 舊的 LINE Notify 已於 2025 停止，本方案用 Messaging API。

---

## 1. 架構總覽

```
員工 App ──(產生綁定碼)──▶ Firestore(lineBindCodes)
員工 LINE ──加好友+傳碼──▶ [Cloud Function: lineWebhook] ──▶ 寫 lineBindings（uid↔lineUserId）
事件(薪資發布…) ──▶ [Cloud Function: sendLineNotify] ──讀 lineBindings──▶ LINE push API ──▶ 員工手機跳通知
```

三塊：**綁定**（把員工帳號對到 LINE userId）、**發送**（事件→推播）、**前端入口**（綁定按鈕）。

---

## 2. 資料模型（Firestore）

```
lineBindings/{uid}
  { uid, empName, store, lineUserId:'U....', boundAt }

lineBindCodes/{code}            // 綁定用臨時碼（6位數）
  { uid, empName, store, createdAt, expiresAt }   // 用完/過期即刪
```
- 以 `uid` 為主鍵（每人一個 LINE 綁定）。
- Channel access token / secret **不放 Firestore**，放 Cloud Functions 環境變數/Secret。

---

## 3. 綁定流程（推薦「綁定碼」版，免 LIFF）

1. App（首頁或「通知設定」）登入者按 **「🔔 綁定 LINE 通知」**。
2. 前端產生 6 位數碼，寫 `lineBindCodes/{code}`（含 uid/empName，10 分鐘到期），畫面顯示：
   - ① 加入官方帳號（QR／連結）
   - ② 在該官方帳號聊天室**傳送這組碼：`123456`**
3. 員工在 LINE 傳碼 → **`lineWebhook`** 收到 message 事件（text=碼、source.userId=LINE userId）：
   - 查 `lineBindCodes/{碼}` 有效 → 寫 `lineBindings/{uid} = {lineUserId,...}` → 刪碼 → 回覆「✅ 綁定成功，之後會在這裡收到通知」。
   - 查無/過期 → 回覆「綁定碼無效或已過期，請回 App 重新產生」。
4. App 端顯示綁定狀態（已綁定 ✅／未綁定）。

> 替代方案：**LINE Login / LIFF** 可一鍵自動綁定（免傳碼），但需另建 LINE Login channel + LIFF app，設定較多。第一版建議先用綁定碼。

---

## 4. Cloud Functions

| Function | 型別 | 職責 |
|---|---|---|
| `lineWebhook` | HTTP | 接 LINE 事件：`follow`（加好友歡迎詞）、`message`（綁定碼比對→寫綁定）。需驗證 `X-Line-Signature`（用 channel secret）。 |
| `sendLineNotify` | 內部函式/被觸發 | 給 empName/uid 陣列 → 查 lineBindings → 呼叫 LINE push `POST /v2/bot/message/push`（帶 access token）。未綁定者略過。 |

- 觸發 `sendLineNotify` 兩種做法：
  - **Firestore trigger**（如 salary doc 由非 published→published 自動發）；或
  - **既有前端動作呼叫 callable**（如 publishSalary 成功後呼叫）。建議用 Firestore trigger 較集中、不漏。

---

## 5. 推播事件（先做最有感的兩個，其餘後續）

| 事件 | 觸發 | 對象 | 訊息例 |
|---|---|---|---|
| **薪資發布** | salary status→published | 該月有薪資記錄者 | 「💰 你的 7 月薪資已發布，請至 App 查看並簽收」 |
| **劃休開放** | 排程/手動開放下週劃休 | 全店員工 | 「📅 8/4–8/10 劃休已開放，截止 8/3 23:59」 |
| （後續）排班發布 | weeks published | 全店 | 「🗓️ 下週班表已發布」 |
| （後續）跨店支援待審 | supportEmp pending | 店長 | 「🔔 有跨店支援待審核」 |
| （後續）劃休核准/駁回/遞補 | leaveRequest 狀態變 | 該員 | 「你的排休已核准/遞補進名額」 |

第一版：**薪資發布 + 劃休開放**。

---

## 6. 安全

- Channel access token / secret 只存 **Cloud Functions 環境**（`firebase functions:secrets` 或 config），永不進前端/Firestore/repo。
- `lineWebhook` 必驗 `X-Line-Signature`（防偽造）。
- `lineBindings` 前端可讀自己的（顯示綁定狀態），寫入只由 `lineWebhook`（Admin SDK）做。

---

## 7. 費用/額度

- LINE 官方帳號有**每月免費推播則數**（超量才收費，方案不同額度不同）。
- 小門市：員工數 × 事件數/月，通常落在免費或低費用；**建議事件精簡**（別每件小事都推）。
- 一對一 push 計則數；要控量可合併訊息、或只推重要事件。

---

## 8. 落地順序

| 步 | 內容 | 誰 |
|---|---|---|
| 0 | 建 LINE OA、拿 token/secret、設 webhook | **你** |
| 1 | Cloud Function `lineWebhook`（follow 歡迎＋綁定碼）＋ `lineBindings`/`lineBindCodes` 資料 | 我 |
| 2 | 前端「綁定 LINE」入口（產碼、顯示 QR/碼、綁定狀態） | 我 |
| 3 | `sendLineNotify` 共用發送 + 「薪資發布」Firestore trigger | 我 |
| 4 | 「劃休開放」通知 | 我 |
| 5 | 其餘事件逐一加 | 我 |

---

## 9. 需要你先決定/準備
1. **先建好 LINE 官方帳號**並給我 token/secret（步驟 0）。
2. 綁定方式：**綁定碼（推薦，先做）** vs LIFF 一鍵？
3. 第一版事件：**薪資發布＋劃休開放**（推薦）還是要調整？
4. 綁定入口放哪：首頁一個「🔔 綁定 LINE」卡片／個人頁？
