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
 * 下單／加量（LIFF 與群組 +1 共用）。錯誤一律丟 HttpsError，details.kind 標原因給群組 +1 分流：
 *   closed／store／other_store／limit／stock／not_found
 */
// ---- 額滿自動開下一團（2026-10-11 使用者：「若超出數量，會自動開第二團」）----
// 開團勾 auto_next（且有設總庫存）→ 這一團裝不下時，訂單整筆放進「下一團」；下一團不存在就由伺服器建立
// （複製設定、文件 ID 固定為 {第一團 ID}_r{團次}，同時兩個人觸發也只會建一份）。每一團各自結算、各自通知。
function roundTitle(c, n) { return String(c.title || "").replace(/（第\d+團）$/, "") + `（第${n}團）`; }
function nextRoundDoc(c, curId, n) {
  const seriesId = c.series_id || curId;
  return {
    id: `${seriesId}_r${n}`,
    data: {
      title: roundTitle(c, n), description: c.description || "", price: c.price || 0, images: c.images || [],
      available_stores: c.available_stores || [], stock: c.stock, per_user_limit: c.per_user_limit || 0,
      end_time: c.end_time, arrival_date: c.arrival_date || null, pickup_deadline: c.pickup_deadline || null,
      success_rule: c.success_rule || "guaranteed", min_qty: c.min_qty || null, is_test: c.is_test === true,
      auto_next: true, series_id: seriesId, round: n, status: "open", ordered_qty: 0, ordered_by_store: {},
      source_hq_post_id: c.source_hq_post_id || null, created_by: "system", created_by_name: "額滿自動開團",
      created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(), settled_by: null, settled_at: null,
    },
  };
}
/** 在 transaction 裡從 cid 往後找第一個裝得下 add 份的團；回傳 { id, ref, c, create }（create＝要新建的資料） */
async function pickRound(t, db, cid, add) {
  let id = cid, ref = db.collection("gb_campaigns").doc(cid), snap = await t.get(ref);
  if (!snap.exists) return null;
  let c = snap.data();
  for (let guard = 0; guard < 20; guard++) {
    const fits = c.stock == null || (c.ordered_qty || 0) + add <= c.stock;
    if (fits || c.auto_next !== true || c.stock == null || add > c.stock) return { id, ref, c, create: null };
    const n = (c.round || 1) + 1, nx = nextRoundDoc(c, id, n);
    const nref = db.collection("gb_campaigns").doc(nx.id), ns = await t.get(nref);
    if (!ns.exists) return { id: nx.id, ref: nref, c: Object.assign({}, nx.data, { ordered_qty: 0, ordered_by_store: {} }), create: nx.data };
    id = nx.id; ref = nref; c = ns.data();
  }
  return { id, ref, c, create: null };
}

/**
 * 下單／加量（LIFF 與群組 +1 共用）。錯誤一律丟 HttpsError，details.kind 標原因給群組 +1 分流：
 *   closed／store／other_store／limit／stock／not_found
 */
async function placeOrderTx({ cid, store, userId, name, picture, add, source, sourceMessageId }) {
  const db = admin.firestore();
  const E = (code, msg, kind) => new HttpsError(code, msg, { kind });
  return db.runTransaction(async (t) => {
    const first = await t.get(db.collection("gb_campaigns").doc(cid));
    if (!first.exists) throw E("not-found", "團購不存在", "not_found");
    if (!isOpen(first.data())) throw E("failed-precondition", "這檔團購已截單", "closed");
    const r = await pickRound(t, db, cid, add);
    const c = r.c, tid = r.id;
    if (!isOpen(c)) throw E("failed-precondition", "這檔團購已截單", "closed");
    if (!(c.available_stores || []).includes(store)) throw E("failed-precondition", `這檔團購沒有開放給${STORES[store]}`, "store");
    const oRef = db.collection("gb_orders").doc(`${tid}_${userId}`);
    const os = await t.get(oRef);
    const o = os.exists ? os.data() : null;
    if (o && o.status === "active" && o.store !== store) {
      throw E("failed-precondition", `你已經在${STORES[o.store] || o.store}訂了這檔，要改到${STORES[store]}請先取消原訂單`, "other_store");
    }
    const before = o && o.status === "active" ? (o.qty || 0) : 0;
    const after = before + add;
    const limit = c.per_user_limit || 0;
    if (after > limit) throw E("failed-precondition", before ? `每人上限 ${limit} 份，你已訂 ${before} 份` : `每人上限 ${limit} 份`, "limit");
    const now = c.ordered_qty || 0;
    if (c.stock != null && now + add > c.stock) throw E("failed-precondition", `剩餘數量不足，只剩 ${Math.max(0, c.stock - now)} 份`, "stock");
    const obs = Object.assign({}, c.ordered_by_store || {}); obs[store] = (obs[store] || 0) + add;
    const ts = FieldValue.serverTimestamp();
    if (r.create) t.set(r.ref, Object.assign({}, r.create, { ordered_qty: add, ordered_by_store: obs }));
    else t.update(r.ref, { ordered_qty: now + add, ordered_by_store: obs, updated_at: ts });
    if (o) {
      t.update(oRef, { qty: after, status: "active", store, display_name: name || o.display_name || "", picture_url: picture || o.picture_url || null, updated_at: ts });
    } else {
      t.set(oRef, {
        campaign_id: tid, store, source, source_message_id: sourceMessageId || null, line_user_id: userId,
        display_name: name || "", picture_url: picture || null, note: "", qty: after, status: "active", paid: false,
        created_by: null, created_by_name: source === "group_text" ? "群組 +1" : "LINE 下單", created_at: ts, updated_at: ts, picked_up_at: null, picked_up_by: null,
      });
    }
    t.set(db.collection("gb_customers").doc(userId), { display_name: name || "", picture_url: picture || null, last_order_at: ts }, { merge: true });
    return { qty: after, title: c.title || "", campaignId: tid, round: c.round || 1, ordered: now + add, rule: c.success_rule || "guaranteed", minQty: c.min_qty || 0 };
  });
}

/**
 * 下單／加量：{ idToken, campaignId, store, qty }
 * 已有訂單（訂購中）→ 數量「加上」qty；已取消 → 重新以 qty 成立
 */
// 手機（2026-10-11 使用者：「要收手機，避免棄單」）：台灣手機 09 開頭 10 碼；只存在 gb_customers，員工可讀
function cleanPhone(p) {
  const s = String(p || "").replace(/[\s-]/g, "").normalize("NFKC");
  if (!/^09\d{8}$/.test(s)) throw new HttpsError("invalid-argument", "手機號碼格式不正確（09 開頭共 10 碼）");
  return s;
}
exports.gbSetPhone = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const who = await verifyLineToken(d.idToken);
  const phone = cleanPhone(d.phone);
  await admin.firestore().collection("gb_customers").doc(who.sub).set({ phone, phone_updated_at: FieldValue.serverTimestamp(), display_name: who.name || "" }, { merge: true });
  return { ok: true, phone };
});

exports.gbPlaceOrder = onCall({ region: REGION }, async (request) => {
  const d = request.data || {};
  const who = await verifyLineToken(d.idToken);
  // LIFF 下單一定要先留手機（群組 +1 拿不到手機，不在此限）
  const cu = await admin.firestore().collection("gb_customers").doc(who.sub).get();
  if (!cu.exists || !cu.data().phone) throw new HttpsError("failed-precondition", "第一次下單請先留手機號碼", { kind: "need_phone" });
  const store = cleanStore(d.store);
  const add = cleanQty(d.qty);
  if (add < 1) throw new HttpsError("invalid-argument", "數量至少 1");
  const cid = String(d.campaignId || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cid)) throw new HttpsError("invalid-argument", "團購不存在");
  const result = await placeOrderTx({ cid, store, userId: who.sub, name: who.name, picture: who.picture, add, source: "liff" });
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
  const cu = await db.collection("gb_customers").doc(who.sub).get();
  return { ok: true, name: who.name, phone: cu.exists ? (cu.data().phone || "") : "", orders: out };
});

// =====================================================================
// 第 4 階段：門市群組 +1 監聽（2026-10-10，分支 feature/gb-bot，未部署）
// =====================================================================
// 機器人「711團購小幫手」加入三個門市客人群組，把直接留言的 +1 轉成訂單或待確認項目。
// 安全：
//  ・Webhook 驗 LINE 官方簽章（X-Line-Signature＝HMAC-SHA256(Channel Secret, 原始內容)）。規格書因 Apps Script 讀不到標頭
//    才改用「網址秘密參數」，Cloud Functions 讀得到標頭，所以用官方做法。
//  ・白名單：只處理 gb_bot_groups 裡「已核准＋門市監聽」的群組；新加入的群組先「待核准」，24 小時沒核准自動退出。
//  ・機器人只用免費的「回覆」訊息，不主動推播；只在三種情況回覆：無法判斷商品、已截單、超過每人上限。
// 金鑰（使用者建好 Messaging API Channel 後用 firebase functions:secrets:set 設定，不進程式碼）：
//   LINE_GB_CHANNEL_SECRET、LINE_GB_ACCESS_TOKEN
const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { parsePlus } = require("./gb-parse");
const GB_SECRET = defineSecret("LINE_GB_CHANNEL_SECRET");
const GB_TOKEN = defineSecret("LINE_GB_ACCESS_TOKEN");
const NAME_CODE = { "美德": "meide", "聯鑫": "lianxin", "錦花": "jinhua" };
const LINE_API = process.env.GB_LINE_API || "https://api.line.me";   // 模擬器測試時指向假的 LINE 伺服器

async function lineApi(path, method, body) {
  const r = await fetch(LINE_API + path, {
    method: method || "GET",
    headers: Object.assign({ Authorization: "Bearer " + GB_TOKEN.value() }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`LINE API ${path} ${r.status}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : {};
}
async function reply(replyToken, text) {
  if (!replyToken) return;
  await lineApi("/v2/bot/message/reply", "POST", { replyToken, messages: [{ type: "text", text: text.slice(0, 1000) }] }).catch((e) => console.warn("[gbBot reply]", e.message));
}
function sigOk(raw, sig) {
  if (!raw || !sig) return false;
  const mac = crypto.createHmac("sha256", GB_SECRET.value()).update(raw).digest();
  let got; try { got = Buffer.from(sig, "base64"); } catch (e) { return false; }
  return got.length === mac.length && crypto.timingSafeEqual(got, mac);
}
function countdownText(ordered, min) {
  const lack = Math.max(0, (min || 0) - (ordered || 0));
  return lack > 0 ? `🎯 目前 ${ordered} 份，還差 ${lack} 份成團（三店合計）` : `🎉 已達成團門檻 ${min} 份，確定成團！`;
}
async function liffLink(store) {
  const s = await admin.firestore().collection("gb_settings").doc("liff").get().catch(() => null);
  const id = s && s.exists ? s.data().liff_id : "";
  return id ? `https://liff.line.me/${id}?store=${store}` : "";
}

exports.gbLineWebhook = onRequest({ region: REGION, secrets: [GB_SECRET, GB_TOKEN] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("method"); return; }
  if (!sigOk(req.rawBody, req.get("x-line-signature"))) { res.status(401).send("signature"); return; }
  const events = (req.body && req.body.events) || [];
  for (const ev of events) {
    try { await handleEvent(ev); } catch (e) { console.error("[gbBot]", e && e.message); }
  }
  res.status(200).send("ok");
});

// ---- 1 對 1（加好友、圖文選單、私訊）：2026-10-11 ----
// 一律用免費的「回覆」；歡迎訊息由這裡發，LINE 官方帳號後台內建的「加入好友的歡迎訊息」要關掉，不然會收到兩則。
const HOWTO_TEXT = "🛍️ 團購怎麼買？\n\n" +
  "1️⃣ 點下方選單「我要下單」，選好取貨門市（只要選一次）\n" +
  "2️⃣ 看到喜歡的商品，按「＋1 我要」選數量\n" +
  "3️⃣ 第一次下單請留手機，到貨時門市才聯絡得到你\n" +
  "4️⃣ 到貨後到門市取貨付款 💰\n\n" +
  "📋 想改數量或取消：選單「我的訂單」（截單前都可以改）\n" +
  "👥 有加入門市群組的話，在團購貼文下面喊「+1」也可以";
async function replyMsgs(replyToken, messages) {
  if (!replyToken) return;
  await lineApi("/v2/bot/message/reply", "POST", { replyToken, messages }).catch((e) => console.warn("[gbBot reply]", e.message));
}
async function handleUserEvent(ev) {
  const src = ev.source || {};
  const liffId = await (async () => { const s = await admin.firestore().collection("gb_settings").doc("liff").get().catch(() => null); return s && s.exists ? s.data().liff_id || "" : ""; })();
  const shop = liffId ? `https://liff.line.me/${liffId}` : "";
  const shopBtn = shop ? [{ type: "action", action: { type: "uri", label: "🛒 我要下單", uri: shop } }] : [];
  const howBtn = { type: "action", action: { type: "postback", label: "❓ 怎麼團購", data: "gb=howto", displayText: "怎麼團購？" } };
  if (ev.type === "follow") {
    let name = "";
    if (src.userId) { try { name = (await lineApi(`/v2/bot/profile/${src.userId}`)).displayName || ""; } catch (e) {} }
    await replyMsgs(ev.replyToken, [{
      type: "text",
      text: `嗨${name ? " " + name : ""}！我是莉學商行的團購小幫手 🛍️\n\n` +
        "7-ELEVEN 美德・聯鑫・錦花三家門市的團購都在這裡下單，到店取貨付款。\n\n" +
        "👇 點下方選單「我要下單」，就能看目前開放中的團購" + (shop ? `\n${shop}` : ""),
      quickReply: { items: shopBtn.concat([howBtn]) },
    }]);
    return;
  }
  const isHowto = (ev.type === "postback" && ev.postback && ev.postback.data === "gb=howto") ||
    (ev.type === "message" && ev.message && ev.message.type === "text" && /怎麼(團購|買|訂|下單)|教學|使用說明/.test(ev.message.text || ""));
  if (isHowto) { await replyMsgs(ev.replyToken, [{ type: "text", text: HOWTO_TEXT, quickReply: { items: shopBtn.length ? shopBtn : [howBtn] } }]); return; }
  // 其他私訊不自動回（留給門市在官方帳號後台手動回覆）
}

async function handleEvent(ev) {
  const src = ev.source || {};
  if (src.type === "user") { await handleUserEvent(ev); return; }
  if (src.type !== "group" || !src.groupId) return;          // 多人聊天不處理
  const db = admin.firestore();
  const gRef = db.collection("gb_bot_groups").doc(src.groupId);
  if (ev.type === "join") {
    const g = await gRef.get();
    if (g.exists && g.data().status === "approved") { await gRef.update({ rejoined_at: FieldValue.serverTimestamp() }); return; }
    let name = "";
    try { name = (await lineApi(`/v2/bot/group/${src.groupId}/summary`)).groupName || ""; } catch (e) {}
    await gRef.set({ status: "pending", mode: "pending", store: "", name, joined_at: FieldValue.serverTimestamp() }, { merge: true });
    return;
  }
  if (ev.type === "leave") { await gRef.set({ status: "left", left_at: FieldValue.serverTimestamp() }, { merge: true }); return; }
  if (ev.type !== "message" || !ev.message || ev.message.type !== "text") return;
  const gs = await gRef.get();
  const g = gs.exists ? gs.data() : null;
  if (!g || g.status !== "approved" || g.mode !== "store_listen" || !STORES[g.store]) return;   // 白名單外一律丟棄
  const store = g.store, text = String(ev.message.text || ""), msgId = ev.message.id;

  // 小編貼了含團購連結的訊息 → 記下「訊息 ID → 團購」，客人引用這則回覆 +1 就知道是哪一檔
  const lm = text.match(/liff\.line\.me\/[^\s?]+\?[^\s]*\bc=([A-Za-z0-9_-]{1,64})/);
  if (lm) { await db.collection("gb_post_map").doc(msgId).set({ campaign_id: lm[1], store, posted_at: FieldValue.serverTimestamp() }); return; }

  // 下單頁（LIFF）代發的「✅ 已登記 商品 +N」：訂單已經成立，不可再當 +1 建單；達標成團的團回覆成團倒數
  if (/^✅\s*已登記/.test(text)) {
    if (!src.userId) return;
    const os = await db.collection("gb_orders").where("line_user_id", "==", src.userId).get();
    const last = os.docs.map((d) => d.data()).filter((o) => o.status === "active" && o.store === store)
      .sort((a, b) => ((b.updated_at && b.updated_at.toMillis()) || 0) - ((a.updated_at && a.updated_at.toMillis()) || 0))[0];
    if (!last) return;
    const lc = await db.collection("gb_campaigns").doc(last.campaign_id).get();
    if (lc.exists && lc.data().success_rule === "threshold") await reply(ev.replyToken, countdownText(lc.data().ordered_qty || 0, lc.data().min_qty || 0));
    return;
  }
  const p = parsePlus(text);
  if (!p) return;                                              // 不是 +1：不存檔、不回應
  const userId = src.userId || "";
  let prof = {};
  if (userId) { try { prof = await lineApi(`/v2/bot/group/${src.groupId}/member/${userId}`); } catch (e) {} }
  const base = { group_id: src.groupId, store, line_user_id: userId || null, display_name: prof.displayName || "", picture_url: prof.pictureUrl || null,
    text: text.slice(0, 200), parsed_qty: p.qty, message_id: msgId, received_at: FieldValue.serverTimestamp(), status: "pending" };
  const pend = (reason, extra) => db.collection("gb_pending_plus").doc(msgId).set(Object.assign({}, base, { reason }, extra || {}));

  if (!userId) { await pend("拿不到客人的 LINE 身分"); return; }
  if (p.otherStore && NAME_CODE[p.otherStore] !== store) { await pend(`提到${p.otherStore}取貨`); return; }

  // 判斷是哪一檔：①引用了團購貼文 ②這家店只有一檔開放中 ③其他 → 待確認
  let cid = "";
  const qid = ev.message.quotedMessageId;
  // 測試模式（2026-10-11）：測試群組只配「測試團」、正式群組不配測試團，兩邊互不干擾
  const isTestGroup = g.is_test === true;
  const fits = (c) => (c.is_test === true) === isTestGroup;
  if (qid) {
    const m = await db.collection("gb_post_map").doc(qid).get();
    if (m.exists) { const qc = await db.collection("gb_campaigns").doc(m.data().campaign_id).get(); if (qc.exists && fits(qc.data())) cid = m.data().campaign_id; }
  }
  if (!cid) {
    const sn = await db.collection("gb_campaigns").where("status", "==", "open").get();
    const raw = sn.docs.filter((d) => isOpen(d.data()) && fits(d.data()) && (d.data().available_stores || []).includes(store));
    // 額滿自動開團的同一系列（第 1、2…團）只算一檔，取團次最小的；裝不下會自動往下一團
    const bySeries = {};
    raw.forEach((d) => { const k = d.data().series_id || d.id; if (!bySeries[k] || (d.data().round || 1) < (bySeries[k].data().round || 1)) bySeries[k] = d; });
    const open = Object.values(bySeries);
    if (open.length === 1) cid = open[0].id;
    else if (open.length > 1) {
      await pend(`同時有 ${open.length} 檔開放中，無法判斷是哪一檔`, { candidates: open.map((d) => d.id) });
      const link = (await liffLink(store)) + (isTestGroup ? "&test=1" : "");
      await reply(ev.replyToken, `收到 ${prof.displayName || ""} 的 +${p.qty}！目前有好幾檔團購，請點連結選商品下單 🙏${link ? "\n" + link : ""}`);
      return;
    } else {
      // 沒有開放中的：最近 2 天內有截單的 → 回「已截單」，否則不理
      const recent = (await db.collection("gb_campaigns").where("status", "in", ["open", "closed", "success", "failed", "arrived"]).get()).docs
        .some((d) => (d.data().available_stores || []).includes(store) && d.data().end_time && Date.now() - d.data().end_time.toMillis() < 2 * 86400000);
      if (recent) await reply(ev.replyToken, "本團已截單，下次早點喊喔 🙏");
      return;
    }
  }
  try {
    const r = await placeOrderTx({ cid, store, userId, name: prof.displayName || "", picture: prof.pictureUrl || null, add: p.qty, source: "group_text", sourceMessageId: msgId });
    // 達標成團：每次 +N 都回覆成團倒數（2026-10-11 使用者要求；回覆免費）；保證成團照「成單回覆」開關
    if (r.rule === "threshold") {
      await reply(ev.replyToken, `已登記 ${prof.displayName || ""}：${r.title} 共 ${r.qty} 份 👍\n` + countdownText(r.ordered, r.minQty));
    } else {
      const cfg = await db.collection("gb_settings").doc("bot").get().catch(() => null);
      if (cfg && cfg.exists && cfg.data().reply_on_success === true) await reply(ev.replyToken, `已登記 ${prof.displayName || ""}：${r.title} 共 ${r.qty} 份`);
    }
  } catch (e) {
    const kind = (e && e.details && e.details.kind) || "";
    if (kind === "closed") { await reply(ev.replyToken, "本團已截單，下次早點喊喔 🙏"); return; }
    if (kind === "limit") { await pend(e.message, { campaign_id: cid }); await reply(ev.replyToken, `${prof.displayName || ""} ${e.message}，超過的部分沒有登記喔`); return; }
    await pend(e.message || "建單失敗", { campaign_id: cid });
  }
}

// ---- 後台：核准／拒絕群組（加盟主／admin）----
async function requireOwner(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
  const u = (await admin.firestore().collection("users").doc(request.auth.uid).get()).data() || {};
  if (!["owner", "admin"].includes(u.permission) || u.disabled === true) throw new HttpsError("permission-denied", "只有加盟主／管理者可以設定機器人");
  return u;
}
async function requireStaff(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
  const u = (await admin.firestore().collection("users").doc(request.auth.uid).get()).data() || {};
  if (!["employee", "manager", "owner", "admin"].includes(u.permission) || u.disabled === true) throw new HttpsError("permission-denied", "沒有權限");
  return u;
}
exports.gbBotGroupAction = onCall({ region: REGION, secrets: [GB_TOKEN] }, async (request) => {
  await requireOwner(request);
  const d = request.data || {}, gid = String(d.groupId || "");
  if (!/^C[0-9a-f]{32}$/.test(gid)) throw new HttpsError("invalid-argument", "群組 ID 不正確");
  const ref = admin.firestore().collection("gb_bot_groups").doc(gid);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "找不到這個群組");
  const by = request.auth.uid, ts = FieldValue.serverTimestamp();
  if (d.action === "approve") {
    const store = String(d.store || "");
    if (!STORES[store]) throw new HttpsError("invalid-argument", "請選門市");
    await ref.update({ status: "approved", mode: "store_listen", store, is_test: d.test === true, approved_by: by, approved_at: ts });
  } else if (d.action === "disable") {
    await ref.update({ status: "approved", mode: "disabled", updated_by: by, updated_at: ts });
  } else if (d.action === "reject") {
    await lineApi(`/v2/bot/group/${gid}/leave`, "POST").catch((e) => console.warn("[gbBot leave]", e.message));
    await ref.update({ status: "rejected", mode: "disabled", rejected_by: by, rejected_at: ts });
  } else throw new HttpsError("invalid-argument", "動作不正確");
  return { ok: true };
});

// ---- 圖文選單（2026-10-11）：加盟主／admin 在〔設定〕按「更新 LINE 選單」→ 建立新選單、設為預設、刪掉舊的 ----
// 圖片在 functions/assets/gb-richmenu.png（2500×843，三格：我要下單／我的訂單／怎麼團購），換圖後重新部署再按一次。
const LINE_DATA_API = process.env.GB_LINE_DATA_API || "https://api-data.line.me";
exports.gbSetupRichMenu = onCall({ region: REGION, secrets: [GB_TOKEN] }, async (request) => {
  const u = await requireOwner(request);
  const db = admin.firestore();
  const ls = await db.collection("gb_settings").doc("liff").get();
  const liffId = ls.exists ? ls.data().liff_id || "" : "";
  if (!liffId) throw new HttpsError("failed-precondition", "請先在〔設定〕填 LIFF ID");
  const shop = `https://liff.line.me/${liffId}`;
  const W = 2500, H = 843, c1 = 833, c2 = 834;
  const { richMenuId } = await lineApi("/v2/bot/richmenu", "POST", {
    size: { width: W, height: H }, selected: true, name: "團購選單", chatBarText: "團購選單",
    areas: [
      { bounds: { x: 0, y: 0, width: c1, height: H }, action: { type: "uri", label: "我要下單", uri: shop } },
      { bounds: { x: c1, y: 0, width: c2, height: H }, action: { type: "uri", label: "我的訂單", uri: shop + "?tab=mine" } },
      { bounds: { x: c1 + c2, y: 0, width: W - c1 - c2, height: H }, action: { type: "postback", label: "怎麼團購", data: "gb=howto", displayText: "怎麼團購？" } },
    ],
  });
  const img = require("fs").readFileSync(require("path").join(__dirname, "assets", "gb-richmenu.png"));
  const up = await fetch(`${LINE_DATA_API}/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST", headers: { Authorization: "Bearer " + GB_TOKEN.value(), "Content-Type": "image/png" }, body: img,
  });
  if (!up.ok) { await lineApi(`/v2/bot/richmenu/${richMenuId}`, "DELETE").catch(() => {}); throw new HttpsError("internal", `上傳選單圖片失敗（${up.status}）`); }
  await lineApi(`/v2/bot/user/all/richmenu/${richMenuId}`, "POST");
  // 刪掉以前建的（只刪這支函式建的，名字是「團購選單」）
  const list = await lineApi("/v2/bot/richmenu/list").catch(() => ({ richmenus: [] }));
  for (const m of list.richmenus || []) {
    if (m.richMenuId !== richMenuId && m.name === "團購選單") await lineApi(`/v2/bot/richmenu/${m.richMenuId}`, "DELETE").catch(() => {});
  }
  await db.collection("gb_settings").doc("bot").set({ rich_menu_id: richMenuId, rich_menu_at: FieldValue.serverTimestamp(), rich_menu_by: request.auth.uid }, { merge: true });
  return { ok: true, richMenuId, by: u.empName || "" };
});

// 待核准超過 24 小時自動退出（防止被陌生人拉進群組）
exports.scheduledGbBotAutoLeave = onSchedule({ schedule: "every 60 minutes", timeZone: "Asia/Taipei", region: REGION, secrets: [GB_TOKEN] }, async () => {
  const db = admin.firestore();
  const sn = await db.collection("gb_bot_groups").where("status", "==", "pending").get();
  for (const d of sn.docs) {
    const j = d.data().joined_at;
    if (!j || Date.now() - j.toMillis() < 24 * 3600000) continue;
    await lineApi(`/v2/bot/group/${d.id}/leave`, "POST").catch((e) => console.warn("[gbBot autoleave]", e.message));
    await d.ref.update({ status: "auto_left", left_at: FieldValue.serverTimestamp() });
  }
});

// ---- 後台：待確認區（員工限本店，加盟主不限）----
// 成立：選團購與數量 → 用同一套下單邏輯（source=group_text），同一位客人跟他之後的 LIFF 訂單合併成同一筆
exports.gbResolvePending = onCall({ region: REGION }, async (request) => {
  const u = await requireStaff(request);
  const d = request.data || {}, id = String(d.pendingId || "");
  if (!/^[0-9A-Za-z]{1,40}$/.test(id)) throw new HttpsError("invalid-argument", "資料不正確");
  const db = admin.firestore(), ref = db.collection("gb_pending_plus").doc(id);
  const sn = await ref.get();
  if (!sn.exists) throw new HttpsError("not-found", "找不到這筆");
  const pnd = sn.data();
  const owner = ["owner", "admin"].includes(u.permission);
  if (!owner && NAME_CODE[u.store] !== pnd.store) throw new HttpsError("permission-denied", "只能處理本店的待確認");
  if (pnd.status !== "pending") throw new HttpsError("failed-precondition", "這筆已經處理過了");
  if (d.action === "ignore") { await ref.update({ status: "ignored", resolved_by: request.auth.uid, resolved_at: FieldValue.serverTimestamp() }); return { ok: true }; }
  const cid = String(d.campaignId || ""), qty = cleanQty(d.qty);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cid) || qty < 1) throw new HttpsError("invalid-argument", "請選團購與數量");
  if (!pnd.line_user_id) throw new HttpsError("failed-precondition", "這筆沒有客人的 LINE 身分，請改用手動補單");
  const r = await placeOrderTx({ cid, store: pnd.store, userId: pnd.line_user_id, name: pnd.display_name, picture: pnd.picture_url, add: qty, source: "group_text", sourceMessageId: pnd.message_id });
  await ref.update({ status: "resolved", resolved_by: request.auth.uid, resolved_at: FieldValue.serverTimestamp(), campaign_id: cid, resolved_qty: qty });
  return { ok: true, qty: r.qty };
});

// ---- 店員補單遇到額滿：建立／取得下一團（後台 groupbuy-page.js 補單時呼叫）----
exports.gbNextRound = onCall({ region: REGION }, async (request) => {
  const u = await requireStaff(request);
  const cid = String((request.data || {}).campaignId || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(cid)) throw new HttpsError("invalid-argument", "團購不存在");
  const add = cleanQty((request.data || {}).qty || 1) || 1;
  const db = admin.firestore();
  const res = await db.runTransaction(async (t) => {
    const first = await t.get(db.collection("gb_campaigns").doc(cid));
    if (!first.exists) throw new HttpsError("not-found", "團購不存在");
    const c0 = first.data();
    const owner = ["owner", "admin"].includes(u.permission);
    if (!owner && !(c0.available_stores || []).includes(NAME_CODE[u.store])) throw new HttpsError("permission-denied", "這檔團購沒有開放給本店");
    if (c0.auto_next !== true) throw new HttpsError("failed-precondition", "這檔沒有設定額滿自動開下一團");
    const r = await pickRound(t, db, cid, add);
    if (r.create) t.set(r.ref, r.create);
    return { campaignId: r.id, title: r.c.title || "" };
  });
  return { ok: true, ...res };
});
