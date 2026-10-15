// ===== line-notify.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");
const { ALLOWED_PERMS, LINE_TOKEN, lineCall, linePush } = require("./common");
const LINE_SECRET = defineSecret("LINE_CHANNEL_SECRET");

async function lineReply(replyToken, text, token) {
  return lineCall("lineReply", "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages: [{ type: "text", text }] }, token, null);
}

exports.lineWebhook = onRequest(
  { region: "asia-east1", secrets: [LINE_TOKEN, LINE_SECRET] },
  async (req, res) => {
    // 1. 驗證 X-Line-Signature（防偽造）
    const signature = req.get("x-line-signature") || "";
    const expected = crypto
      .createHmac("sha256", LINE_SECRET.value())
      .update(req.rawBody)
      .digest("base64");
    if (signature !== expected) {
      res.status(401).send("bad signature");
      return;
    }

    const token = LINE_TOKEN.value();
    const db = getFirestore();
    const events = (req.body && req.body.events) || [];

    // 關鍵字清單（群組完全相符自動回覆）— 一次讀取快取
    let _kwCache = null;
    const getKeywords = async () => {
      if (_kwCache) return _kwCache;
      const s = await db.collection("settings").doc("lineKeywords").get().catch(() => null);
      _kwCache = (s && s.exists && Array.isArray(s.data().list)) ? s.data().list : [];
      return _kwCache;
    };

    for (const ev of events) {
      const lineUserId = ev.source && ev.source.userId;
      const srcType = (ev.source && ev.source.type) || "user"; // user | group | room
      try {
        if (ev.type === "follow") {
          await lineReply(
            ev.replyToken,
            "歡迎加入莉學商行通知！\n請回到 App 點「綁定 LINE」，把畫面上的 6 位數綁定碼傳到這裡即可完成綁定。",
            token
          );
          continue;
        }
        // 群組/多人聊天室：只做關鍵字「完全相符」自動回覆，沒命中就完全不出聲（避免洗版）
        if (ev.type === "message" && ev.message && ev.message.type === "text" && srcType !== "user") {
          const text = (ev.message.text || "").trim();
          const kws = await getKeywords();
          // 一則回覆可對應多個關鍵字（keys 陣列）；相容舊格式 {k}
          const hit = kws.find((p) => {
            if (!p) return false;
            const keys = Array.isArray(p.keys) ? p.keys : (p.k != null ? [p.k] : []);
            return keys.some((k) => String(k || "").trim() === text);
          });
          if (hit && hit.r) await lineReply(ev.replyToken, String(hit.r), token);
          continue;
        }
        if (ev.type === "message" && ev.message && ev.message.type === "text") {
          const code = (ev.message.text || "").trim();
          if (!/^\d{4,8}$/.test(code)) {
            // 非綁定碼：已綁定者不再提示綁定碼，改回「無法一對一回覆」；未綁定才提示傳碼
            const bound = lineUserId
              ? await db.collection("lineBindings").where("lineUserId", "==", lineUserId).limit(1).get().catch(() => null)
              : null;
            if (bound && !bound.empty) {
              await lineReply(ev.replyToken, "此為莉學商行系統通知帳號，無法一對一回覆訊息。相關操作請至 App 進行。", token);
            } else {
              await lineReply(ev.replyToken, "請傳送 App 上顯示的綁定碼（純數字）。", token);
            }
            continue;
          }
          const codeRef = db.collection("lineBindCodes").doc(code);
          const snap = await codeRef.get();
          if (!snap.exists) {
            await lineReply(ev.replyToken, "綁定碼無效，請回 App 重新產生。", token);
            continue;
          }
          const data = snap.data();
          if (data.expiresAt && Date.now() > data.expiresAt) {
            await codeRef.delete().catch(() => {});
            await lineReply(ev.replyToken, "綁定碼已過期，請回 App 重新產生。", token);
            continue;
          }
          const dispName = data.displayName || data.empName || "";
          await db.collection("lineBindings").doc(data.uid).set({
            uid: data.uid,
            empName: data.empName || "",
            displayName: dispName,
            store: data.store || "",
            lineUserId: lineUserId || "",
            boundAt: new Date().toISOString(),
          });
          await codeRef.delete().catch(() => {});
          await lineReply(
            ev.replyToken,
            `✅ 綁定成功！${dispName} 之後會在這裡收到通知。`,
            token
          );
          continue;
        }
      } catch (e) {
        console.error("lineWebhook 事件處理失敗", e);
      }
    }
    res.status(200).send("ok");
  }
);

// ===== 管理者測試通知：推一則測試訊息給呼叫者自己的 LINE（僅店長以上）=====
exports.sendTestNotify = onCall(
  { region: "asia-east1", secrets: [LINE_TOKEN] },
  async (request) => {
    const auth = request.auth;
    if (!auth) throw new HttpsError("unauthenticated", "請先登入");
    const db = getFirestore();
    const callerSnap = await db.collection("users").doc(auth.uid).get();
    const caller = callerSnap.data();
    if (!caller || !ALLOWED_PERMS.includes(caller.permission)) {
      throw new HttpsError("permission-denied", "僅店長以上可用");
    }
    const bindSnap = await db.collection("lineBindings").doc(auth.uid).get();
    if (!bindSnap.exists) throw new HttpsError("failed-precondition", "你尚未綁定 LINE，請先綁定");
    const b = bindSnap.data();
    const name = b.displayName || b.empName || "";
    const now = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ");
    await linePush(
      b.lineUserId,
      `🔔 測試通知（${now}）\n${name}，若你收到這則訊息，代表 LINE 通知運作正常 ✅`,
      LINE_TOKEN.value()
    );
    return { ok: true };
  }
);
