// ===== city.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { runCitySync } = require("./city-sync");

// ════════════════════════════════════════════════════════════════
// CITY手順同步（邏輯在 city-sync.js）：抓對方資料 → 產生待確認變動 → admin 在確認頁發佈
// ════════════════════════════════════════════════════════════════

// 每週一 08:00 自動同步。只產生「待確認」，不直接改員工看到的內容（釘選除外）
exports.scheduledCitySync = onSchedule(
  { schedule: "0 8 * * 1", timeZone: "Asia/Taipei", region: "asia-east1", timeoutSeconds: 300, memory: "512MiB" },
  async () => { await runCitySync("schedule"); }
);

// admin 在確認頁按「立即同步」
exports.citySyncNow = onCall({ region: "asia-east1", timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
  const me = await getFirestore().collection("users").doc(request.auth.uid).get();
  if (!me.exists || me.data().permission !== "admin") throw new HttpsError("permission-denied", "只有 admin 可以同步 CITY手順");
  try {
    return await runCitySync("manual");
  } catch (e) {
    throw new HttpsError("internal", String(e.message || e));
  }
});
