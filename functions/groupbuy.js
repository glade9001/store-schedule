// 團購第 2 階段：LIFF 前台的下單 API（2026-10-10）
// 使用者決定用 Cloud Functions（不用規格書的 Apps Script）：同專案、Admin SDK 免金鑰、
// 防超賣用 Firestore transaction，跟後台手動補單（groupbuy-page.js）同一套規則。
//
// 安全設計（客人不登入 Firebase，身分全靠 LINE ID Token）：
//  1. 每次呼叫都帶 liff.getIDToken()，伺服器向 LINE 驗證（https://api.line.me/oauth2/v2.1/verify），
//     userId 一律取驗證結果的 sub，**不信任前端傳來的任何身分欄位**。
//  2. client_id（LINE Login Channel ID）存在 gb_settings/liff.channel_id，只有加盟主／admin 能改（firestore.rules）。
//  3. 訂單文件 ID 固定為 {campaignId}_{LINE userId}：同一位客人同一檔團購只有一筆，改數量／取消只能動自己的。
//  4. 時間以伺服器為準：status 必須是 open 且 end_time 未到；數量受每人上限與剩餘庫存限制。
//  5. 取貨門市＝連結上的門市（使用者 2026-10-10：先不開放跨店取貨）；同一檔已在別店訂過就擋。
//
// 模擬器測試：FUNCTIONS_EMULATOR=true 時接受 "TEST:<userId>:<暱稱>" 假 token（正式環境絕不會走到）。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");   // admin.firestore.FieldValue 在這支模組取不到（模擬器實測 undefined），改直接引入

const REGION = "asia-east1";
const STORES = { meide: "美德", lianxin: "聯鑫", jinhua: "錦花" };

async function verifyLineToken(idToken) {
  if (typeof idToken !== "string" || idToken.length < 10 || idToken.length > 4096) {
    throw new HttpsError("unauthenticated", "請從 LINE 開啟這個頁面");
  }
  if (process.env.FUNCTIONS_EMULATOR === "true" && idToken.startsWith("TEST:")) {
    const [, sub, name] = idToken.split(":");
    return { sub, name: name || "測試客人", picture: null };
  }
  const db = admin.firestore();
  const cfg = await db.collection("gb_settings").doc("liff").get();
  const channelId = cfg.exists ? String(cfg.data().channel_id || "") : "";
  if (!channelId) throw new HttpsError("failed-precondition", "團購尚未設定完成，請稍後再試");
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.sub) throw new HttpsError("unauthenticated", "LINE 登入已過期，請關閉頁面重新開啟");
  return { sub: j.sub, name: j.name || "", picture: j.picture || null };
}

function cleanStore(s) {
  s = String(s || "");
  if (!STORES[s]) throw new HttpsError("invalid-argument", "門市連結不正確");
  return s;
}
function cleanQty(q) {
  q = Number(q);
  if (!Number.isInteger(q) || q < 0 || q > 999) throw new HttpsError("invalid-argument", "數量不正確");
  return q;
}
function endMs(c) { const t = c.end_time; return t && typeof t.toMillis === "function" ? t.toMillis() : NaN; }
function isOpen(c) { const e = endMs(c); return c.status === "open" && isFinite(e) && Date.now() < e; }

/**
 * 下單／加量：{ idToken, campaignId, store, qty }
 * 已有訂單（訂購中）→ 數量「加上」qty；已取消 → 重新以 qty 成立
 */
exports.gbPlaceOrder = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const who = await verifyLineToken(d.idToken);
  const store = cleanStore(d.store);
  const add = cleanQty(d.qty);
  if (add < 1) throw new HttpsError("invalid-argument", "數量至少 1");
  const cid = String(d.campaignId || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cid)) throw new HttpsError("invalid-argument", "團購不存在");
  const db = admin.firestore();
  const cRef = db.collection("gb_campaigns").doc(cid);
  const oRef = db.collection("gb_orders").doc(`${cid}_${who.sub}`);
  const result = await db.runTransaction(async (t) => {
    const cs = await t.get(cRef);
    if (!cs.exists) throw new HttpsError("not-found", "團購不存在");
    const c = cs.data();
    if (!isOpen(c)) throw new HttpsError("failed-precondition", "這檔團購已截單");
    if (!(c.available_stores || []).includes(store)) throw new HttpsError("failed-precondition", `這檔團購沒有開放給${STORES[store]}`);
    const os = await t.get(oRef);
    const o = os.exists ? os.data() : null;
    if (o && o.status === "active" && o.store !== store) {
      throw new HttpsError("failed-precondition", `你已經在${STORES[o.store] || o.store}訂了這檔，要改到${STORES[store]}請先取消原訂單`);
    }
    const before = o && o.status === "active" ? (o.qty || 0) : 0;
    const after = before + add;
    const limit = c.per_user_limit || 0;
    if (after > limit) throw new HttpsError("failed-precondition", before ? `每人上限 ${limit} 份，你已訂 ${before} 份` : `每人上限 ${limit} 份`);
    const now = c.ordered_qty || 0;
    if (c.stock != null && now + add > c.stock) throw new HttpsError("failed-precondition", `剩餘數量不足，只剩 ${Math.max(0, c.stock - now)} 份`);
    const obs = Object.assign({}, c.ordered_by_store || {}); obs[store] = (obs[store] || 0) + add;
    const ts = FieldValue.serverTimestamp();
    if (o) {
      t.update(oRef, { qty: after, status: "active", store, display_name: who.name || o.display_name || "", picture_url: who.picture || o.picture_url || null, updated_at: ts });
    } else {
      t.set(oRef, {
        campaign_id: cid, store, source: "liff", source_message_id: null, line_user_id: who.sub,
        display_name: who.name || "", picture_url: who.picture, note: "", qty: after, status: "active", paid: false,
        created_by: null, created_by_name: "LINE 下單", created_at: ts, updated_at: ts, picked_up_at: null, picked_up_by: null,
      });
    }
    t.update(cRef, { ordered_qty: now + add, ordered_by_store: obs, updated_at: ts });
    t.set(db.collection("gb_customers").doc(who.sub), { display_name: who.name || "", picture_url: who.picture, last_order_at: ts }, { merge: true });
    return { qty: after, title: c.title || "" };
  });
  return { ok: true, ...result };
});

/** 改數量／取消自己的訂單：{ idToken, campaignId, qty }（qty=0 ＝ 取消）；截單前才能改 */
exports.gbUpdateMyOrder = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const who = await verifyLineToken(d.idToken);
  const qty = cleanQty(d.qty);
  const cid = String(d.campaignId || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cid)) throw new HttpsError("invalid-argument", "團購不存在");
  const db = admin.firestore();
  const cRef = db.collection("gb_campaigns").doc(cid);
  const oRef = db.collection("gb_orders").doc(`${cid}_${who.sub}`);   // 只會是自己的那筆
  await db.runTransaction(async (t) => {
    const [cs, os] = [await t.get(cRef), await t.get(oRef)];
    if (!cs.exists || !os.exists) throw new HttpsError("not-found", "找不到這筆訂單");
    const c = cs.data(), o = os.data();
    if (o.status !== "active") throw new HttpsError("failed-precondition", "這筆訂單已經不能修改");
    if (!isOpen(c)) throw new HttpsError("failed-precondition", "已截單，不能再修改");
    if (qty > (c.per_user_limit || 0)) throw new HttpsError("failed-precondition", `每人上限 ${c.per_user_limit} 份`);
    const delta = qty - (o.qty || 0);
    const now = c.ordered_qty || 0;
    if (delta > 0 && c.stock != null && now + delta > c.stock) throw new HttpsError("failed-precondition", `剩餘數量不足，只能再加 ${Math.max(0, c.stock - now)} 份`);
    const obs = Object.assign({}, c.ordered_by_store || {}); obs[o.store] = Math.max(0, (obs[o.store] || 0) + delta);
    const ts = FieldValue.serverTimestamp();
    t.update(oRef, qty === 0 ? { status: "cancelled", cancelled_by: "customer", cancelled_at: ts, updated_at: ts } : { qty, updated_at: ts });
    t.update(cRef, { ordered_qty: Math.max(0, now + delta), ordered_by_store: obs, updated_at: ts });
  });
  return { ok: true };
});

/** 我的訂單：{ idToken } → 自己全部的團購訂單（含團購名稱、價格、狀態、可否修改） */
exports.gbMyOrders = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const who = await verifyLineToken(d.idToken);
  const db = admin.firestore();
  const sn = await db.collection("gb_orders").where("line_user_id", "==", who.sub).limit(50).get();
  const orders = sn.docs.map((x) => x.data()).filter((o) => o.status !== "cancelled");
  const cids = [...new Set(orders.map((o) => o.campaign_id))];
  const camps = {};
  await Promise.all(cids.map(async (id) => { const c = await db.collection("gb_campaigns").doc(id).get(); if (c.exists) camps[id] = c.data(); }));
  const out = orders.filter((o) => camps[o.campaign_id]).map((o) => {
    const c = camps[o.campaign_id];
    const ms = (x) => (x && typeof x.toMillis === "function" ? x.toMillis() : null);
    return {
      campaignId: o.campaign_id, title: c.title || "", price: c.price || 0, image: (c.images || [])[0] || null,
      store: o.store, qty: o.qty, status: o.status, paid: !!o.paid, campaignStatus: c.status,
      endTime: ms(c.end_time), arrivalDate: ms(c.arrival_date), pickupDeadline: ms(c.pickup_deadline),
      perUserLimit: c.per_user_limit || 0, editable: o.status === "active" && isOpen(c),
    };
  }).sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
  return { ok: true, name: who.name, orders: out };
});
