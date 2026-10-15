// ===== push.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");
const { VAPID_PRIVATE, sendPushToUids } = require("./common");

function pushSubId(uid, endpoint) {
  return `${uid}_${crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 32)}`;
}

// 為什麼不用 FCM：FCM 的 Web 推播金鑰要到 Firebase 主控台手動產生；標準 Web Push 用自己的 VAPID 金鑰，
// iOS 16.4+（需加入主畫面）與 Android Chrome 都支援，全程不必碰主控台。
// 私鑰在 Secret Manager（WEB_PUSH_VAPID_PRIVATE），公鑰寫死在這裡與前端 home-push.js（兩處必須一致）。
//
// 訂閱存 pushSubs/{uid}_{endpoint 雜湊}：一人可有多台裝置，也可能 github.io 與 web.app 各訂一份（origin 欄位可查）。
// 前端不直接讀寫 pushSubs（firestore.rules 已把它排除在 catch-all 外），一律經由下面三支 callable。
// 目前只提供「測試推播」；要推哪些通知之後再決定，屆時呼叫 sendPushToUids()。
exports.pushSubscribe = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const { subscription, platform, standalone, origin } = request.data || {};
  const endpoint = subscription && subscription.endpoint;
  const keys = (subscription && subscription.keys) || {};
  if (typeof endpoint !== "string" || !/^https:\/\/[^\s]{10,900}$/.test(endpoint)
      || typeof keys.p256dh !== "string" || typeof keys.auth !== "string"
      || keys.p256dh.length > 200 || keys.auth.length > 100) {
    throw new HttpsError("invalid-argument", "訂閱資料格式不正確");
  }
  const db = getFirestore();
  const u = (await db.collection("users").doc(auth.uid).get()).data() || {};
  const ref = db.collection("pushSubs").doc(pushSubId(auth.uid, endpoint));
  const cur = await ref.get();
  await ref.set({
    uid: auth.uid, empName: u.empName || "", displayName: u.displayName || "", store: u.store || "", permission: u.permission || "",
    endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth },
    platform: String(platform || "").slice(0, 20), standalone: !!standalone, origin: String(origin || "").slice(0, 80),
    lastSeenAt: FieldValue.serverTimestamp(),
    ...(cur.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });
  return { ok: true };
});

exports.pushUnsubscribe = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const endpoint = request.data && request.data.endpoint;
  if (typeof endpoint !== "string") throw new HttpsError("invalid-argument", "缺少 endpoint");
  await getFirestore().collection("pushSubs").doc(pushSubId(auth.uid, endpoint)).delete();
  return { ok: true };
});

exports.sendTestPush = onCall({ region: "asia-east1", secrets: [VAPID_PRIVATE] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = getFirestore();
  const u = (await db.collection("users").doc(auth.uid).get()).data() || {};
  const name = u.displayName || u.empName || "";
  const now = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
  const r = await sendPushToUids(db, [auth.uid], {
    title: "🔔 測試推播",
    body: `${name}，收到這則代表推播正常 ✅（${now}）`,
    url: "home.html",
    tag: "test-push",
  }, VAPID_PRIVATE.value());
  if (!r.sent && !r.failed) throw new HttpsError("failed-precondition", "這個帳號還沒有任何裝置開啟推播");
  return r;
});
