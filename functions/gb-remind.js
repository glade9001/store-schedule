// ===== gb-remind.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onDocumentWritten, onDocumentCreated, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { VAPID_PRIVATE, maintenanceOn, sendOrQueuePush } = require("./common");
// ===== 團購：截單後提醒去結算（2026-10-10）=====
// 每 15 分鐘掃「開放中、截單時間已過、還沒提醒過」的團購 → 推播（不用 LINE 額度；夜間排到 08:00）。
// 對象：團購已開放給全員（gb_settings/stores.open）時＝加盟主／admin＋「只開本店」團購的該店店長（跨店團結算限加盟主）；
//       還沒開放時只發給 admin（避免測試期間的團購吵到其他人）。提醒後寫 due_notified_at，不重複發。
exports.scheduledGbDueReminder = onSchedule(
  { schedule: "every 15 minutes", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [VAPID_PRIVATE] },
  async () => {
    const db = getFirestore();
    if (await maintenanceOn(db)) return;
    const nowMs = Date.now();
    const snap = await db.collection("gb_campaigns").where("status", "==", "open").get();
    const due = snap.docs.filter((d) => { const c = d.data(); return c.end_time && c.end_time.toMillis() <= nowMs && !c.due_notified_at; });
    if (!due.length) return;
    const st = await db.collection("gb_settings").doc("stores").get();
    const opened = st.exists && st.data().open === true;
    const us = await db.collection("users").where("permission", "in", opened ? ["owner", "admin", "manager"] : ["admin"]).get();
    const users = us.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => u.disabled !== true);
    const CODE = { "美德": "meide", "聯鑫": "lianxin", "錦花": "jinhua" };
    for (const d of due) {
      const c = d.data(), stores = c.available_stores || [];
      const uids = users.filter((u) => ["owner", "admin"].includes(u.permission)
        || (u.permission === "manager" && stores.length === 1 && CODE[u.store] === stores[0])).map((u) => u.uid);
      const total = c.ordered_qty || 0;
      const rule = c.success_rule === "threshold" && c.per_batch && c.min_qty > 0
        ? `三店合計 ${total} 份，每 ${c.min_qty} 份成一團→成 ${Math.floor(total / c.min_qty)} 團` + (total >= c.min_qty && total % c.min_qty ? `、零頭 ${total % c.min_qty} 份要處理` : "")
        : c.success_rule === "threshold"
        ? `三店合計 ${total} 份，最低 ${c.min_qty} 份，${total >= (c.min_qty || 0) ? "已達標" : "未達標"}`
        : `三店合計 ${total} 份`;
      await sendOrQueuePush(db, uids, { title: "🛒 團購已截單，請結算", body: `「${c.title}」截單了（${rule}），到團購頁按「結算」`, url: "groupbuy.html", tag: `gb-due-${d.id}` },
        VAPID_PRIVATE.value(), false).catch((e) => console.warn("[gbDue]", e.message));
      await d.ref.update({ due_notified_at: FieldValue.serverTimestamp() });
    }
  }
);

// ===== 團購：非保證成團「每成一團」推播提醒訂貨（2026-10-13 使用者）=====
// 達標成團：滿 min_qty 提醒一次；每 N 份成一團(per_batch)：每多成一團提醒一次（order_notified_groups 記到第幾團，取消掉回來不重發）。
// 對象：單店團＝該店店長；跨店團＝開團時設的負責訂貨門市(order_store)店長；都找不到就發加盟主。還沒開放給全員時只發 admin。
exports.onGbCampaignOrderRemind = onDocumentWritten(
  { document: "gb_campaigns/{cid}", region: "asia-east1", secrets: [VAPID_PRIVATE] },
  async (event) => {
    const c = event.data.after.exists ? event.data.after.data() : null;
    if (!c || c.success_rule !== "threshold" || !(c.min_qty > 0) || c.is_test === true) return;
    if (["open", "closed", "success"].indexOf(c.status) < 0) return;
    const o = c.ordered_qty || 0, n = c.min_qty;
    const groups = c.per_batch ? Math.floor(o / n) : (o >= n ? 1 : 0);
    if (groups <= (c.order_notified_groups || 0)) return;
    const db = getFirestore(), ref = event.data.after.ref;
    // 兩個人同時下單會觸發兩次 → transaction 搶「記到第幾團」，搶輸的不發
    const go = await db.runTransaction(async (t) => {
      const cur = (await t.get(ref)).data() || {};
      if (groups <= (cur.order_notified_groups || 0)) return false;
      t.update(ref, { order_notified_groups: groups });
      return true;
    });
    if (!go) return;
    const st = await db.collection("gb_settings").doc("stores").get();
    const opened = st.exists && st.data().open === true;
    const us = await db.collection("users").where("permission", "in", opened ? ["owner", "admin", "manager"] : ["admin"]).get();
    const users = us.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => u.disabled !== true);
    const CODE = { "美德": "meide", "聯鑫": "lianxin", "錦花": "jinhua" };
    const stores = c.available_stores || [];
    const target = stores.length === 1 ? stores[0] : c.order_store || "";
    let uids = users.filter((u) => u.permission === "manager" && target && CODE[u.store] === target).map((u) => u.uid);
    if (!uids.length || !opened) uids = users.filter((u) => ["owner", "admin"].includes(u.permission) && (opened || u.permission === "admin")).map((u) => u.uid);
    const title = String(c.title || "");
    const body = c.per_batch
      ? `「${title}」已成第 ${groups} 團（每 ${n} 份成一團，三店合計 ${o} 份），請訂貨`
      : `「${title}」已達成團 ${n} 份（目前 ${o} 份），請訂貨；截單前可能還會增加`;
    await sendOrQueuePush(db, uids, { title: "🛒 團購成團，請訂貨", body, url: "groupbuy.html", tag: `gb-order-${event.params.cid}-${groups}` },
      VAPID_PRIVATE.value(), false).catch((e) => console.warn("[gbOrderRemind]", e.message));
  }
);

// ===== 團購：取貨期限前 36 小時，還有人沒取 → 推播提醒該店店長（2026-10-10 使用者）=====
// 只通知店員端（不發 LINE、不花額度），由店長決定要不要打電話。所有已到貨的團都算（不分保證／達標成團）。
// 對象：已開放給全員時＝該店店長；還沒開放時只發 admin。每檔只提醒一次（pick_reminded_at）。
// 取貨期限給得比 36 小時短時，到貨後至少 12 小時才提醒（不然一標到貨就跳「還沒取」）。
exports.scheduledGbPickupReminder = onSchedule(
  { schedule: "every 30 minutes", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [VAPID_PRIVATE] },
  async () => {
    const db = getFirestore();
    if (await maintenanceOn(db)) return;
    const nowMs = Date.now(), H = 3600000;
    const snap = await db.collection("gb_campaigns").where("status", "==", "arrived").get();
    const due = snap.docs.filter((d) => {
      const c = d.data(), dl = c.pickup_deadline && c.pickup_deadline.toMillis();
      if (!dl || c.pick_reminded_at || c.is_test === true) return false;
      const left = dl - nowMs, since = c.arrived_at ? nowMs - c.arrived_at.toMillis() : Infinity;
      return left > 0 && left <= 36 * H && since >= 12 * H;
    });
    if (!due.length) return;
    const st = await db.collection("gb_settings").doc("stores").get();
    const opened = st.exists && st.data().open === true;
    const us = await db.collection("users").where("permission", "in", opened ? ["manager", "admin"] : ["admin"]).get();
    const users = us.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((u) => u.disabled !== true);
    const CODE = { "美德": "meide", "聯鑫": "lianxin", "錦花": "jinhua" }, NAME = { meide: "美德", lianxin: "聯鑫", jinhua: "錦花" };
    const fmt = (ms) => new Date(ms).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    for (const d of due) {
      const c = d.data();
      const os = await db.collection("gb_orders").where("campaign_id", "==", d.id).where("status", "==", "active").get();
      const byStore = {};
      os.docs.forEach((o) => { const x = o.data(); const b = byStore[x.store] = byStore[x.store] || { n: 0, q: 0 }; b.n++; b.q += x.qty || 0; });
      for (const code of Object.keys(byStore)) {
        const uids = users.filter((u) => opened ? (u.permission === "manager" && CODE[u.store] === code) : u.permission === "admin").map((u) => u.uid);
        if (!uids.length) continue;
        const b = byStore[code];
        await sendOrQueuePush(db, uids, { title: `📦 ${NAME[code] || code}：團購還有 ${b.n} 位沒取貨`,
          body: `「${c.title}」還有 ${b.n} 位未取（${b.q} 份），取貨期限 ${fmt(c.pickup_deadline.toMillis())}，點開看名單與電話`,
          url: "groupbuy.html?tab=pick", tag: `gb-pick-${d.id}-${code}` }, VAPID_PRIVATE.value(), false).catch((e) => console.warn("[gbPick]", e.message));
      }
      await d.ref.update({ pick_reminded_at: FieldValue.serverTimestamp() });
    }
  }
);
