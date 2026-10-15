const { initializeApp } = require("firebase-admin/app");
const { notifyEmployees, loadPushIndex, notifyOneEmp, deliverToPeople } = require("./common");
// Cloud Functions — 莉學商行管理系統（入口）
// 2026-10-16 依功能拆檔，這支只負責初始化與把各功能檔的函式匯總出去：
//   account.js 帳號（重設密碼、帳號稽核）  line-notify.js LINE 機器人與通知  leave.js 劃休協調、特休補休統計校正
//   salary.js 薪資與經營績效  schedule.js 班表（異動、分享、發布、國定假日補休同步）  clock.js 打卡與缺卡、補登
//   push.js 推播訂閱  daily.js 每日提醒與清理、維護結束  city.js CITY 手順同步  gb-remind.js 團購提醒  groupbuy.js 團購 API
//   common.js 兩個以上功能共用的小函式（通知、店名修正、金鑰…）——新增共用函式放這裡，不要放回 index.js。
// firebase-admin 一律用新式寫法（getFirestore、FieldValue 從 firebase-admin/firestore 引入）：14 版起拿掉了 admin.firestore()。

initializeApp();

// 本機測試用（只有設定 LIXUE_TEST_HOOKS=1 時才掛上；雲端不會有這個環境變數）
if (process.env.LIXUE_TEST_HOOKS === "1") module.exports.__testHooks = { notifyEmployees, loadPushIndex, notifyOneEmp, deliverToPeople };

// ===== 團購第 2 階段：LIFF 下單 API（functions/groupbuy.js）=====
Object.assign(exports, require("./groupbuy"));

// ===== 各功能的雲端函式（2026-10-16 拆檔）=====
Object.assign(exports, require("./account"));
Object.assign(exports, require("./line-notify"));
Object.assign(exports, require("./leave"));
Object.assign(exports, require("./salary"));
Object.assign(exports, require("./schedule"));
Object.assign(exports, require("./clock"));
Object.assign(exports, require("./push"));
Object.assign(exports, require("./daily"));
Object.assign(exports, require("./city"));
Object.assign(exports, require("./gb-remind"));
