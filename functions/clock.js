// ===== clock.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onDocumentWritten, onDocumentCreated, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { LINE_TOKEN, VAPID_PRIVATE, WEEK_DAYS, addDaysStr, deliverToPeople, fixStoreName, loadPushIndex, maintenanceOn, notifyStoreManagers, pushUidOf, sendOrQueuePush, sendPushToUids, weekStrOfTp } = require("./common");
// ===== 班別字串解析（與前端 shift-utils.js 同語意，改一邊請一併改另一邊）=====
// 文法：「開始-結束」，小時可帶 .25/.5/.75；兩頭班用逗號分隔；結束 <= 開始 視為跨夜（endH 推 >24）。
// ⚠️ 舊版各處自己寫 /^(\d{1,2})-(\d{1,2})$/，半點班(23.5-07.5、7.5-15.5) 全部匹配失敗被當成沒排班，
//    導致 attendance.shift 寫空字串、缺卡與打卡提醒漏發。三店約一成班別中招（2026-08-17 修正）。
function parseShiftSegs(shiftStr) {
  const s = String(shiftStr == null ? "" : shiftStr).trim();
  if (!s || !/\d/.test(s)) return [];
  const out = [];
  for (const seg of s.split(",")) {
    const m = seg.trim().match(/^(\d{1,2}(?:\.\d+)?)-(\d{1,2}(?:\.\d+)?)$/);
    if (!m) return []; // 任一段不合法 → 整串都不當成時間班別
    const startH = parseFloat(m[1]);
    let endH = parseFloat(m[2]);
    if (!isFinite(startH) || !isFinite(endH)) return [];
    if (endH <= startH) endH += 24; // 跨夜
    out.push({ startH, endH, durH: endH - startH });
  }
  return out;
}
// 第一段上班 / 最後一段下班的時刻（小時；跨夜 endH > 24）；非時間班別回 null
function shiftSpan(shiftStr) {
  const segs = parseShiftSegs(shiftStr);
  return segs.length ? { startH: segs[0].startH, endH: segs[segs.length - 1].endH } : null;
}
// 兩個班別字串是不是同一個班：**不可用 === 直接比**。
// 2026-09-05 實例：缺卡單存 '08-16'、補登卡存 '8-16'，字串不等 → 自動註銷永遠配不上，
// 那張單子就一直掛在店長與員工的未補清單裡（錦花 8/8 某員工）。
// 前導零、空白、兩頭班的段落一律先解析成數值再比。
function sameShiftStr(a, b) {
  const A = String(a == null ? "" : a).trim();
  const B = String(b == null ? "" : b).trim();
  if (A === B) return true;
  const pa = parseShiftSegs(A); const pb = parseShiftSegs(B);
  if (!pa.length || !pb.length) return false;   // 有一邊不是時間班別 → 交給呼叫端的寬鬆規則
  if (pa.length !== pb.length) return false;
  return pa.every((x, i) => x.startH === pb[i].startH && x.endH === pb[i].endH);
}
// 下班是否落在隔天（含 16-00 這種正好 24:00 收班的，與舊行為 end <= start 一致）
function shiftIsOvernight(shiftStr) {
  const sp = shiftSpan(shiftStr);
  return !!sp && sp.endH >= 24;
}
// 台北時區絕對毫秒：dateStr 當日 00:00 起算第 hours 小時（可含小數、可 > 24）
function shiftTimeMs(dateStr, hours) {
  const base = Date.parse(`${dateStr}T00:00:00+08:00`);
  return isFinite(base) ? base + hours * 3600000 : NaN;
}

// ===== 打卡判定規則（2026-08-28 集中化）=====
// ⚠️ 這是 shift-utils.js 同名函式的**同語意副本**（Node 不吃那支瀏覽器檔）。
//    改任一邊都必須跑 `node tools/check-clock-rules.js` 對拍，確認兩份仍等價。
//    集中的理由：配對視窗原本散在 7 處、遲到採計散在 4 處，靠「記得還有哪幾處」維持一致，
//    半點班那次（同一條正則寫在 11 個地方）已經示範過改漏一處的代價。

/** 打卡配對視窗（毫秒）—— 後端唯一定義處 */
function punchWindowMs() {
  return {
    inBefore: 1 * 3600000,   // 上班：排定開始前 1 小時
    inAfter: 4 * 3600000,    // 上班：排定開始後 4 小時
    outBefore: 4 * 3600000,  // 下班：排定結束前 4 小時
    outAfter: 3 * 3600000,   // 下班：排定結束後 3 小時（2026-08-17 由 +1h 放寬）
  };
}

/** 從候選班段挑出這筆打卡該歸屬的班；null＝視窗外（狀態應判「到場」） */
function matchPunchShift(cands, punchMs, type) {
  const w = punchWindowMs();
  const isIn = (type === "上班");
  const win = (cands || []).filter((c) => {
    const lo = isIn ? c.startMs - w.inBefore : c.endMs - w.outBefore;
    const hi = isIn ? c.startMs + w.inAfter : c.endMs + w.outAfter;
    return punchMs >= lo && punchMs <= hi;
  });
  if (!win.length) return null;
  win.sort((a, b) => Math.abs(punchMs - (isIn ? a.startMs : a.endMs)) -
                     Math.abs(punchMs - (isIn ? b.startMs : b.endMs)));
  return win[0];
}

/** 遲到分鐘數 —— 採計到分、無條件捨去（不可用 Math.round，見 2026-08-28 修正） */
function lateMinutesOf(punchMs, startMs) {
  if (!isFinite(punchMs) || !isFinite(startMs)) return 0;
  return Math.max(0, Math.floor((punchMs - startMs) / 60000));
}

/** 遲到分鐘 + 門市容許值 → 打卡狀態（容許值內＝「警告」，不列入出勤異常） */
function punchLateStatus(lateMin, tolMin) {
  const tol = (tolMin == null ? 10 : tolMin);
  if (lateMin > tol) return "遲到";
  if (lateMin > 0) return "警告";
  return "正常";
}

/**
 * 缺卡判定的門檻（收班 +2 小時）是否落到「隔天」
 * ⚠️ 2026-08-28 修：原本只用 shiftIsOvernight() 分流，導致 22:00~23:59 收班但沒跨夜的班別
 *    （如 15-23、14-22）兩段都漏掉——當日那段的條件是 nowMin < endH*60+120，
 *    endH=23 時門檻是 1500 分鐘，而一天只有 1440 分鐘，永遠成立所以每次都跳過；
 *    「昨日」那段又只收 shiftIsOvernight 的班。結果這類班別從來沒被檢查過缺卡。
 */
function missDeadlineCrossesDay(shiftStr) {
  const sp = shiftSpan(shiftStr);
  // 用 >= 而不是 >：nowMin 最大只到 1439，門檻正好等於 1440（如 14-22）留在當日段
  // 一樣永遠觸發不了，必須也交給昨日段。
  return !!sp && (sp.endH * 60 + 120) >= 1440;
}

// 未收上班的合理補打期限：該班排定下班 +4 小時（夜班跨日照算）；查不到班別則打卡後 12 小時。
// 超過即視為缺卡呆帳，不再拿來配對今天的下班（否則會把今天的班誤掛到昨天）。
function openInDeadlineMs(p) {
  const sp = shiftSpan(p.shift); // 兩頭班取最後一段的下班
  if (sp && p.shiftDate) {
    const endMs = shiftTimeMs(p.shiftDate, sp.endH);
    if (isFinite(endMs)) return endMs + 4 * 3600000;
  }
  return (p.tsMs || Date.parse(p.deviceTs || "") || 0) + 12 * 3600000;
}
// 解析員工 app 顯示名 + 登入權限（排班/缺卡用短名，通知用顯示名、判斷開放層級用權限）
async function resolveEmpInfo(db, empName) {
  const out = { displayName: empName, permission: "employee" };
  if (!empName) return out;
  let d = null;
  const s = await db.collection("account").where("empName", "==", empName).limit(1).get().catch(() => null);
  if (s && !s.empty) d = s.docs[0].data();
  if (!d || !d.permission) {
    const u = await db.collection("users").where("empName", "==", empName).limit(1).get().catch(() => null);
    if (u && !u.empty) d = Object.assign({}, d, u.docs[0].data());
  }
  if (d) { if (d.displayName) out.displayName = d.displayName; if (d.permission) out.permission = d.permission; }
  return out;
}
// 兩點距離(公尺)
function haversineM(la1, lo1, la2, lo2) {
  const R = 6371000, rad = (x) => x * Math.PI / 180;
  const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
// 該權限在此開放層級是否已能打卡（對應 clock.html canClock）
// 2026-09-23：打卡一律開啟。原本的 canClockPerm（分階段開放 off/admin/manager/all）與
// storeClockOn（單店開關 enabledByStore）都已移除——三店早就全開，留著只是多兩層會擋人的判斷。
// clockIn 底下的 geo（圍欄）、tolByStore（遲到容許）、notifyByStore、attnSince 照舊使用。
// 單一員工通知：只查該員工的綁定(省讀取，不像 notifyEmployees 讀全表)
// 通知系統管理員（users.permission === 'admin'），不是門市店長。
// 定位/技術問題要找的是維運的人，店長處理不了手機設定或門市座標校正。
async function notifyAdmins(db, text, token, opts) {
  const us = await db.collection("users").where("permission", "==", "admin").get().catch(() => null);
  if (!us || us.empty) return 0;
  const people = []; us.forEach((d) => { const u = d.data() || {}; if (u.empName) people.push({ uid: d.id, empName: u.empName, store: u.store || "" }); });
  const r = await deliverToPeople(db, people, text, token, opts);
  return r.push + r.line;
}
exports.onPunchResolveMissFlag = onDocumentWritten(
  { document: "stores/{store}/attendance/{id}", region: "asia-east1" },
  async (event) => {
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    if (after.type !== "上班" && after.type !== "下班") return; // 缺卡本身不處理 → 寫回標記不會遞迴
    const before = event.data.before.exists ? event.data.before.data() : null;
    // 只在「可能改變補齊與否」的異動才重算，避免每次 merge 寫入都跑一輪查詢
    if (before && before.type === after.type && !!before.voided === !!after.voided &&
        before.shiftDate === after.shiftDate && before.date === after.date) return;
    const emp = after.empName;
    const anchor = after.shiftDate || after.date;   // 缺卡標記的 date＝班別當天
    if (!emp || !anchor) return;
    const db = getFirestore();
    // ⚠️ event.params.store 對中文店名會是 latin1 亂碼（這就是 fixStoreName 存在的原因）。
    //    直接拿來當路徑會指向不存在的店 → 查詢回空、不報錯 → trigger 每次都靜靜什麼都沒做。
    //    2026-08-28 實際踩到：補登完成後缺卡標記完全沒被註銷，log 卻顯示執行成功。
    //    優先用打卡紀錄自己帶的 atStore，退而求其次才修 params。（比照 onClockPunch）
    const store = after.atStore || fixStoreName(event.params.store);
    // ⚠️ 缺卡單與補登卡**不保證在同一個門市**（2026-09-05 用正式資料抓到 4 筆）：
    //    支援日的缺卡單開在「有排班的那家店」，但補登表單的門市預設是 atStore||本店，
    //    店長常常就送到另一家去（例：8/11 昊的單在聯鑫、補登寫進錦花；9/1 闆娘的單在美德、
    //    補登寫進聯鑫）。只查 after.atStore 就永遠配不到那張單，它會一直掛在未補清單上。
    //    門市只有三家，這裡直接跨店收單與收卡；先查本店，本店沒有相關單子才擴散出去。
    const cfgSnap = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const allStores = ((cfgSnap && cfgSnap.exists ? cfgSnap.data().stores : null) || [])
      .filter((x) => x && x !== "人力支援");
    const order = [store, ...allStores.filter((x) => x !== store)];
    const dayAfter = addDaysStr(anchor, 1);
    const gather = async (st) => {
      const col = db.collection("stores").doc(st).collection("attendance");
      const two = await Promise.all([
        col.where("empName", "==", emp).where("date", "==", anchor).get(),
        col.where("empName", "==", emp).where("date", "==", dayAfter).get(),
      ]);
      const out = [];
      two.forEach((sn) => sn.forEach((d) => out.push({ ref: d.ref, d: d.data() || {} })));
      return out;
    };
    let docs = await gather(order[0]);
    if (!docs.some((x) => x.d.type === "缺卡" && x.d.date === anchor)) {
      for (const st of order.slice(1)) docs = docs.concat(await gather(st));
    }
    // 算得上出勤的打卡：「到場」＝沒配對到任何班別，不能拿來抵缺卡
    const punches = docs.filter((x) => (x.d.type === "上班" || x.d.type === "下班") &&
      !x.d.voided && x.d.status !== "到場" && ((x.d.shiftDate || x.d.date) === anchor));
    const flags = docs.filter((x) => x.d.type === "缺卡" && x.d.date === anchor);
    for (const f of flags) {
      const fs = f.d.shift || "";
      // 兩頭班同一天會有兩張標記：班別對得起來才算，對不上的不要互相抵銷
      // ⚠️ 用 sameShiftStr 不可用 ===：'08-16' 與 '8-16' 是同一個班（2026-09-05 實例）
      const rel = punches.filter((p) => !fs || !p.d.shift || sameShiftStr(p.d.shift, fs));
      const hasIn = rel.some((p) => p.d.type === "上班");
      const hasOut = rel.some((p) => p.d.type === "下班");
      const note = String(f.d.note || "");
      const done = note.includes("缺下班") ? hasOut :
        note.includes("缺上班") ? hasIn :
          (hasIn && hasOut);   // 「整天未打卡」與沒註記的一律要求上下班都齊
      const now = new Date().toISOString();
      const AU = FieldValue.arrayUnion;
      if (done && !f.d.voided) {
        await f.ref.set({
          voided: true, voidedBy: "system", voidedAt: now, voidReason: "已補登，系統自動註銷",
          editLog: AU({ at: now, by: "system", action: "註銷", reason: "已補登，系統自動註銷" }),
        }, { merge: true });
      } else if (!done && f.d.voided && f.d.voidedBy === "system" &&
                 String(f.d.voidReason || "").includes("已補登")) {
        // 補登的卡又被店長註銷或改掉 → 缺卡要回來，否則這個班就永遠沒人管了。
        // 只還原「系統自己註銷」的；人工註銷（例如改為休假）一律尊重，不覆蓋。
        // ⚠️ 還要限定「因補登而註銷」的那種：孤兒清理也是 voidedBy=system
        //    （voidReason='排班已變更，此班別不存在'），那種班根本不存在了，
        //    復活它等於叫人去補一個沒排的班。2026-09-05 回放正式資料時抓到 1 張會被誤復活
        //    （聯鑫 8/22 某員工 16-00.5）。
        await f.ref.set({
          voided: false, voidedBy: null, voidedAt: null, voidReason: null,
          editLog: AU({ at: now, by: "system", action: "還原", reason: "補登紀錄已失效，缺卡重新成立" }),
        }, { merge: true });
      }
    }
  }
);


// ✂️ onAttendanceRequest（補登/加班申請被駁回 → 通知員工）已整支移除（2026-09-07 用戶指示取消發送）。
//    駁回結果 App 內看得到；審核進度由 scheduledManagerDigest 每日摘要涵蓋。
// C. 缺卡排程：每小時，班別結束後 2 小時仍無打卡 → 標記+通知(去重)
exports.scheduledMissingClock = onSchedule(
  { schedule: "5 * * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [VAPID_PRIVATE] },
  async () => {
    const db = getFirestore();
    if (await maintenanceOn(db)) return;
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const conf = cfg && cfg.exists ? cfg.data() : {};
    const stores = (conf.stores || []).filter((s) => s !== "人力支援");
    // 這支只負責「標記」缺卡，不再推播（推播交給 scheduledMissClockReminder）。
    const nowTp = new Date(Date.now() + 8 * 3600000);
    const ds = nowTp.toISOString().slice(0, 10);
    const nowMin = nowTp.getUTCHours() * 60 + nowTp.getUTCMinutes();
    // 缺卡一成立就推播「待補單」給本人（2026-09-16）：我的出勤頁會列出待補清單，點補登即帶好日期／班別／門市。
    // 只發推播（沒開推播的人不發 LINE），夜間非緊急會排到 08:00。
    const pushIdx = await loadPushIndex(db);
    const vapid = VAPID_PRIVATE.value();
    const notifyMiss = async (emp, homeStore, date, shift, missWhat) => {
      const uid = pushUidOf(pushIdx, emp, homeStore);
      if (!uid) return;
      // 跨夜班缺下班卡：寫出實際下班日期（員工常把「9/17 大夜」的下班填成 9/17 07:00，其實是 9/18）
      const sp = shiftSpan(shift || "");
      let outTxt = "";
      if (sp && sp.endH >= 24 && String(missWhat).includes("下班")) {
        const od = new Date(Date.parse(`${date}T00:00:00+08:00`) + Math.floor(sp.endH / 24) * 86400000 + 8 * 3600000);
        const h = sp.endH % 24;
        outTxt = `（下班時間是 ${od.getUTCMonth() + 1}/${od.getUTCDate()} ${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}）`;
      }
      await sendOrQueuePush(db, [uid], {
        title: `🔴 ${date} ${missWhat}`,
        body: `${shift || ""} 的班${outTxt}沒有完整打卡紀錄，點這裡補登（填時間與原因即可送出）`,
        url: "my-attendance.html", tag: `miss-${date}-${emp}`,
      }, vapid, false).catch(() => {});
    };
    const wk = weekStrOfTp(nowTp);
    const dayName = WEEK_DAYS[(nowTp.getUTCDay() + 6) % 7];
    const notifyBy = conf.clockIn.notifyByStore || {};
    for (const store of stores) {
      if (notifyBy[store] === false) continue; // 該店關閉打卡通知 → 不判缺卡
      const wd = await db.collection("stores").doc(store).collection("weeks").doc(wk).get().catch(() => null);
      if (!wd || !wd.exists) continue;
      const recs = wd.data().records || [];
      const esSnap = await db.collection("stores").doc(store).collection("employees").get().catch(() => null);
      const statusMap = {}; if (esSnap) esSnap.forEach((d) => { const e = d.data() || {}; statusMap[d.id] = { status: e.status || "", eff: e.retireDate || e.transferDate || "" }; });
      // 排除派出店的「支援X」顯示記錄(loc=支援)＝跨店去重，只認接收店 supportEmp 那筆
      const shifts = recs.filter((r) => r.day === dayName && parseShiftSegs(r.shift).length && !String(r.location || "").startsWith("支援"));

      // 孤兒缺卡清理：flagId 帶班別字串（miss_{日期}_{人}_{班別}），排班一改班別就會建一張新的，
      // 舊班別那張沒人動、永遠留著。實例 2026-08-28：聯鑫 8/22 某員工同時掛「16-00.5」與「16-01」兩張。
      // 比對當日排班，班別對不上的一律註銷（留 editLog，不刪除）。
      // ⚠️ 只在當日確實有排班時才掃：若 shifts 為空就全掃，等於「讀不到排班＝把當天缺卡全銷掉」。
      if (shifts.length) {
        const validPairs = new Set();
        shifts.forEach((r) => {
          const isSup = r.supportEmp && r.approvalStatus === "approved";
          const nm = (r.name && !String(r.name).startsWith("🆘")) ? r.name
            : (isSup ? r.supportEmp.slice(r.supportEmp.indexOf("-") + 1) : "");
          if (nm) validPairs.add(nm + "|" + (r.shift || ""));
        });
        const fSnap = await db.collection("stores").doc(store).collection("attendance")
          .where("date", "==", ds).where("type", "==", "缺卡").get().catch(() => null);
        if (fSnap) {
          for (const fd of fSnap.docs) {
            const f = fd.data() || {};
            if (f.voided) continue;
            if (validPairs.has((f.empName || "") + "|" + (f.shift || ""))) continue;
            const at = new Date().toISOString();
            await fd.ref.set({
              voided: true, voidedBy: "system", voidedAt: at,
              voidReason: "排班已變更，此班別不存在",
              editLog: FieldValue.arrayUnion({ at, by: "system", action: "註銷", reason: "排班已變更，此班別不存在" }),
            }, { merge: true }).catch(() => {});
          }
        }
      }

      if (!shifts.length) continue;
      const attSnap = await db.collection("stores").doc(store).collection("attendance").where("date", "==", ds).get().catch(() => null);
      const punches = []; if (attSnap) attSnap.forEach((d) => punches.push(d.data()));
      for (const sh of shifts) {
        if (missDeadlineCrossesDay(sh.shift)) continue; // 門檻落在隔天 → 交給下面「昨日」那段處理
        if (nowMin < shiftSpan(sh.shift).endH * 60 + 120) continue; // 未到「結束後 2 小時」
        const isSupport = sh.supportEmp && sh.approvalStatus === "approved";
        const emp = (sh.name && !String(sh.name).startsWith("🆘")) ? sh.name
          : (isSupport ? sh.supportEmp.slice(sh.supportEmp.indexOf("-") + 1) : "");
        if (!emp) continue;
        // 離職/調走「生效日(含)後」才跳過；生效日前仍在職 → 照常判缺卡
        const sInfo = statusMap[emp] || {};
        if (!isSupport && ["離職", "調走"].includes(sInfo.status) && (!sInfo.eff || ds >= sInfo.eff)) continue;
        const homeStore = isSupport ? sh.supportEmp.slice(0, sh.supportEmp.indexOf("-")) : store;
        // 「到場」＝沒配到任何班別的打卡，不能拿來抵缺卡（與補登自動註銷同一規則）。
        // 2026-09-22：聯鑫宥 9/18 早上沒打卡，下午 15:17／17:15 兩筆「到場」卡把 08-16 的缺卡蓋掉，沒被抓到也沒被提醒補登。
        const empPunches = punches.filter((p) => p.empName === emp && !p.voided && p.status !== "到場" &&
          (p.shiftDate || p.date) === ds);
        const hasIn = empPunches.some((p) => p.type === "上班");
        const hasOut = empPunches.some((p) => p.type === "下班");
        if (hasIn && hasOut) continue;
        const info = await resolveEmpInfo(db, emp);
        const flagId = ("miss_" + ds + "_" + emp + "_" + sh.shift).replace(/[^\w一-龥]/g, "_");
        const flagRef = db.collection("stores").doc(store).collection("attendance").doc(flagId);
        const exist = await flagRef.get().catch(() => null);
        if (exist && exist.exists) continue;
        const missWhat = (!hasIn && !hasOut) ? "整天未打卡" : (!hasIn ? "缺上班卡" : "缺下班卡");
        const dn = info.displayName;
        await flagRef.set({
          empName: emp, displayName: dn, date: ds, type: "缺卡", atStore: store, homeStore,
          shift: sh.shift, status: "缺卡", note: missWhat, source: "system",
          // 缺卡＝沒有打卡時間：不寫 deviceTs/tsMs(否則出勤表會顯示成像有打卡的掃描時間)；等手動補卡才有真時間
          ts: FieldValue.serverTimestamp(), deviceTs: null, tsMs: null,
        });
        // LINE 時代的逐張通知早已取消（額度）；改推播後不花額度，缺卡一成立就通知本人來補。
        await notifyMiss(emp, homeStore, ds, sh.shift, missWhat);
      }

      // 昨日「跨日班(夜班)」的下班卡落在今天：到「下班+2h」才統一判上/下班缺卡，不拆成兩天
      const yTp = new Date(Date.now() + 8 * 3600000 - 86400000);
      const dsY = yTp.toISOString().slice(0, 10);
      const yName = WEEK_DAYS[(yTp.getUTCDay() + 6) % 7];
      const wkY = weekStrOfTp(yTp);
      const wdY = (wkY === wk) ? wd : await db.collection("stores").doc(store).collection("weeks").doc(wkY).get().catch(() => null);
      const recsY = (wdY && wdY.exists) ? (wdY.data().records || []) : [];
      const yShifts = recsY.filter((r) => r.day === yName && !String(r.location || "").startsWith("支援") && missDeadlineCrossesDay(r.shift));
      if (yShifts.length) {
        const attSnapY = await db.collection("stores").doc(store).collection("attendance").where("date", "==", dsY).get().catch(() => null);
        const punchesY = []; if (attSnapY) attSnapY.forEach((d) => punchesY.push(d.data()));
        // ⚠️ 收班在深夜的班，下班卡可能落在昨天也可能落在今天，**不能靠 shiftIsOvernight 二選一**
        //    （2026-09-05 用正式資料抓到兩筆誤開的缺卡單）：
        //    ・16-23（非跨夜）→ 員工 00:06 才打下班，卡的 date 是今天 → 只看昨天 → 誤判缺下班
        //    ・16-00（跨夜）→ 員工 23:37 早退打下班，卡的 date 是昨天 → 只看今天 → 誤判缺下班
        //    正解＝兩天的打卡合起來，用「班別當天」(shiftDate || date) 歸戶，與 onPunchResolveMissFlag 同一把尺。
        const yPool = punchesY.concat(punches).filter((p) => (p.shiftDate || p.date) === dsY && !p.voided);
        for (const sh of yShifts) {
          // 門檻換算成「今天的分鐘數」：收班+2h 超過 1440 的部分就是今天的時刻
          if (nowMin < (shiftSpan(sh.shift).endH * 60 + 120) - 1440) continue; // 今天還沒到「下班+2 小時」
          const isSupport = sh.supportEmp && sh.approvalStatus === "approved";
          const emp = (sh.name && !String(sh.name).startsWith("🆘")) ? sh.name
            : (isSupport ? sh.supportEmp.slice(sh.supportEmp.indexOf("-") + 1) : "");
          if (!emp) continue;
          const sInfo = statusMap[emp] || {};
          if (!isSupport && ["離職", "調走"].includes(sInfo.status) && (!sInfo.eff || dsY >= sInfo.eff)) continue;
          const homeStore = isSupport ? sh.supportEmp.slice(0, sh.supportEmp.indexOf("-")) : store;
          // 跨夜班（endH >= 24）的下班卡打在今天；22:00~23:59 收班但沒跨夜的班，上下班都在昨天
          const overnight = shiftIsOvernight(sh.shift);
          // 刻意不比對班別字串：排班若在打卡後被修改，比對會反而生出新的誤判缺卡。
          // 這裡只要求「同一個人、屬於這一天的班」，與原行為一致。
          const mine = yPool.filter((p) => p.empName === emp && p.status !== "到場"); // 「到場」不抵缺卡（同上）
          const hasInY = mine.some((p) => p.type === "上班");
          const hasOutT = mine.some((p) => p.type === "下班");
          if (hasInY && hasOutT) continue;
          const info = await resolveEmpInfo(db, emp);
          const flagId = ("miss_" + dsY + "_" + emp + "_" + sh.shift).replace(/[^\w一-龥]/g, "_");
          const flagRef = db.collection("stores").doc(store).collection("attendance").doc(flagId);
          const exist = await flagRef.get().catch(() => null);
          if (exist && exist.exists) continue;
          const missWhat = (!hasInY && !hasOutT) ? "整天未打卡" : (!hasInY ? "缺上班卡" : "缺下班卡");
          const dn = info.displayName;
          await flagRef.set({
            empName: emp, displayName: dn, date: dsY, type: "缺卡", atStore: store, homeStore,
            shift: sh.shift, status: "缺卡", note: missWhat + (overnight ? "(跨日班)" : ""), source: "system",
            // 缺卡＝沒有打卡時間：不寫 deviceTs/tsMs；等手動補卡才有真時間
            ts: FieldValue.serverTimestamp(), deviceTs: null, tsMs: null,
          });
          await notifyMiss(emp, homeStore, dsY, sh.shift, missWhat);
        }
      }
    }
  }
);

// ✂️ scheduledClockRemind（上/下班打卡提醒）已整支移除（2026-09-07 用戶指示取消發送）。
//    2026-08-17 起本來就以 CLOCK_REMIND_SUSPENDED 停用，這次連同排程一併刪除，不再每 5 分鐘空跑。
//    clock-page.js 的同名常數保留（維持設定入口隱藏）。
// ============ 打卡 callable（伺服器權威：時間/圍欄/狀態全後端判定）============
exports.clockPunch = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = getFirestore();
  const userSnap = await db.collection("users").doc(auth.uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !user.empName) throw new HttpsError("permission-denied", "查無使用者");
  const empName = user.empName, homeStore = user.store || "", perm = user.permission || "employee";
  const cfgSnap = await db.collection("settings").doc("globalConfig").get();
  const conf = cfgSnap.exists ? cfgSnap.data() : {};
  const clk = conf.clockIn || {};
  const d = request.data || {};
  const lat = Number(d.lat), lng = Number(d.lng), type = d.type;
  if (!isFinite(lat) || !isFinite(lng)) throw new HttpsError("invalid-argument", "缺少定位資訊");
  if (!["上班", "下班"].includes(type)) throw new HttpsError("invalid-argument", "打卡類型錯誤");
  // 後端複驗圍欄
  const geo = clk.geo || {};
  let atStore = "", distanceM = null;
  for (const st of Object.keys(geo)) {
    const g = geo[st] || {};
    if (typeof g.lat !== "number" || typeof g.lng !== "number") continue;
    const dist = haversineM(lat, lng, g.lat, g.lng);
    if (dist <= (g.radiusM || 120) && (atStore === "" || dist < distanceM)) { atStore = st; distanceM = Math.round(dist); }
  }
  if (!atStore) throw new HttpsError("failed-precondition", "不在任何門市範圍內，無法打卡");
  // 伺服器時間(台北)
  const nowMs = Date.now();
  const nowTp = new Date(nowMs + 8 * 3600000);
  const ds = nowTp.toISOString().slice(0, 10);
  const nowMin = nowTp.getUTCHours() * 60 + nowTp.getUTCMinutes();
  const attCol = db.collection("stores").doc(atStore).collection("attendance");
  const todaySnap = await attCol.where("date", "==", ds).where("empName", "==", empName).get();
  const punches = []; todaySnap.forEach((x) => punches.push(x.data()));
  // 防抖 10 分 + 上班後 5 分不能下班
  if (punches.some((p) => p.type === type && p.tsMs && (nowMs - p.tsMs) < 10 * 60000)) throw new HttpsError("failed-precondition", `剛剛已${type}打卡，10 分鐘內不用再打`);
  if (type === "下班") {
    const lastIn = Math.max(0, ...punches.filter((p) => p.type === "上班").map((p) => p.tsMs || 0));
    if (lastIn && (nowMs - lastIn) < 5 * 60000) throw new HttpsError("failed-precondition", "上班後 5 分鐘內不能打下班");
  }
  // 排班候選(昨/今/明三天，換算絕對時間) → 依排班表、跨日、視窗比對，並決定歸班日 shiftDate
  const wk = weekStrOfTp(nowTp);
  const dayName = WEEK_DAYS[(nowTp.getUTCDay() + 6) % 7];
  const wd = await db.collection("stores").doc(atStore).collection("weeks").doc(wk).get();
  const dayShifts = async (tpDate) => {
    const wkk = weekStrOfTp(tpDate);
    const dn = WEEK_DAYS[(tpDate.getUTCDay() + 6) % 7];
    const dss = tpDate.toISOString().slice(0, 10);
    const wdd = (wkk === wk) ? wd : await db.collection("stores").doc(atStore).collection("weeks").doc(wkk).get().catch(() => null);
    const out = [];
    if (wdd && wdd.exists) (wdd.data().records || []).forEach((r) => {
      if (r.day !== dn) return;
      const mine = (r.name === empName) || (r.supportEmp === `${homeStore}-${empName}` && r.approvalStatus === "approved");
      if (!mine) return;
      parseShiftSegs(r.shift).forEach((g) => { // 兩頭班：每段各自成為一個候選
        const startMs = shiftTimeMs(dss, g.startH);
        if (!isFinite(startMs)) return;
        out.push({ shift: r.shift, shiftDate: dss, startMs, endMs: startMs + g.durH * 3600000 });
      });
    });
    return out;
  };
  const cand = [...await dayShifts(new Date(nowMs + 8 * 3600000 - 86400000)), ...await dayShifts(nowTp), ...await dayShifts(new Date(nowMs + 8 * 3600000 + 86400000))];
  const tol = (clk.tolByStore && clk.tolByStore[atStore] != null) ? clk.tolByStore[atStore]
            : (clk.lateToleranceMin != null ? clk.lateToleranceMin : 10);
  let status = "正常", lateMin = 0, matchedShift = "", shiftDate = ds;
  if (type === "上班") {
    // 視窗與取最近班的規則見上方 matchPunchShift（前後端唯一定義，對拍工具 tools/check-clock-rules.js）
    const s = matchPunchShift(cand, nowMs, "上班");
    if (s) {
      matchedShift = s.shift; shiftDate = s.shiftDate;
      // ⚠️ 一律無條件捨去到「分」，不可用 Math.round（2026-08-28 修）：
      //    打卡時間顯示給員工看的是 hm＝ISO 字串 slice(11,16)＝截斷到分，07:00:30 畫面就是「07:00」。
      //    原本 Math.round 會把 0.5 分進位成 1 → 同一筆資料「顯示準時、系統判遲到 1 分」。
      //    8 月實測 6 筆（某正職（早班） 8/09 07:00:55、某正職 8/12 08:00:39、某工讀 8/19 15:00:57 等）
      //    全是未滿一分鐘卻被記遲到，其中 4 筆還因此觸發「你是不是忘記打卡？」而衍生補登申請。
      //    採計到分＝未滿 01:00 就是準時，與畫面一致。
      const late = lateMinutesOf(nowMs, s.startMs);
      const st = punchLateStatus(late, tol);
      if (st !== "正常") { status = st; lateMin = late; }
    } else { status = "到場"; }
  } else { // 下班：跨日時間序列配對，找尚未打下班的上班 → 歸同一班(shiftDate)、以其排班結束判早退
    // 不能用同日筆數判斷：連續夜班時同一日曆日會同時含「收前晚班」+「開當晚班」使筆數打平而漏配。
    const dsY = new Date(nowMs + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
    const seq = [];
    for (const dd of [dsY, ds]) {
      const sn = await attCol.where("date", "==", dd).where("empName", "==", empName).get();
      sn.forEach((x) => { const p = x.data(); if (p.type === "上班" || p.type === "下班") seq.push(p); });
    }
    seq.sort((a, b) => (a.tsMs || 0) - (b.tsMs || 0));
    const stack = []; seq.forEach((p) => { if (p.type === "上班") stack.push(p); else stack.pop(); });
    let openIn = stack.length ? stack[stack.length - 1] : null;
    // 昨天忘了打下班留下的呆帳：過了補打期限就不再配對，否則今天的下班會被掛到昨天那班並誤判早退
    if (openIn && (openIn.date || "") !== ds && nowMs > openInDeadlineMs(openIn)) openIn = null;
    if (openIn) {
      shiftDate = openIn.shiftDate || openIn.date || ds;
      matchedShift = openIn.shift || "";
      if (!matchedShift) { status = "到場"; }
      else { const s = cand.find((c) => c.shift === matchedShift && c.shiftDate === shiftDate); if (s && nowMs < s.endMs) status = "早退"; }
    } else {
      // 下班配對視窗：排定下班前 4h ~ 後 3h（後段 2026-08-17 由 +1h 放寬，見 clock.html offSchedule 註解）
      const s = matchPunchShift(cand, nowMs, "下班");
      if (s) { matchedShift = s.shift; shiftDate = s.shiftDate; if (nowMs < s.endMs) status = "早退"; }
      else { status = "到場"; }
    }
  }
  const info = await resolveEmpInfo(db, empName);
  const deviceTs = new Date(nowMs).toISOString();
  // 防代打卡對比：手機端當下時間、與伺服器時間差、裝置資訊、打卡方式
  const clientMs = d.clientTime ? Date.parse(d.clientTime) : (typeof d.clientMs === "number" ? d.clientMs : NaN);
  const timeSkewMs = isFinite(clientMs) ? (nowMs - clientMs) : null;
  const deviceInfo = String(d.deviceInfo || "").slice(0, 180);
  // 加班事前防呆：非排班時段打卡的意向(apply=申請加班待審／private=不計工時)
  // private 分兩種用途：①上班/未排班「到場」→只保留給 admin(巡店)；②下班晚打「非加班·私事/忘記」→開放全員(有下班紀錄但不計工時、避免勞基法加班疑慮)。
  // 因此 private 僅在「admin」或「下班」時採用；一般員工的上班 private 一律忽略成正常打卡。
  const otIntent = (d.otIntent === "apply" || (d.otIntent === "private" && (perm === "admin" || type === "下班"))) ? d.otIntent : null;
  await attCol.add({
    empName, displayName: info.displayName, date: ds, shiftDate, weekday: dayName, type, atStore, homeStore,
    lat, lng, accuracy: (typeof d.accuracy === "number" ? d.accuracy : null), distanceM,
    shift: matchedShift, status, lateMin,
    ts: FieldValue.serverTimestamp(), tsMs: nowMs, deviceTs, source: "app",
    clientTime: (isFinite(clientMs) ? new Date(clientMs).toISOString() : null), timeSkewMs,
    deviceInfo: deviceInfo || null, punchMethod: (d.punchMethod || "GPS"),
    otIntent, otContent: otIntent ? String(d.otContent || "").slice(0, 300) : "",
    otStatus: otIntent === "apply" ? "pending" : (otIntent === "private" ? "private" : null),
    // 員工自述（2026-09-16）：遲到才想起來打卡時可留一句說明。**只留說明、不動時間**——
    // 要改時間一律走補登/修改申請由店長核准（先前「忘記打卡」一鍵改時間已於 9/15 取消）。
    empNote: String(d.empNote || "").slice(0, 200) || null,
  });
  return { ok: true, atStore, distanceM, status, lateMin, hm: nowTp.toISOString().slice(11, 16) };
});

// 定位問題回報：員工打不了卡時按一下，直接把診斷資訊送給店長（LINE）並留存紀錄。
// 失敗的定位原本什麼都不會留下，事後只能靠猜（某員工 2026-08-10 就是這樣查不出來）。
exports.reportGeoIssue = onCall({ region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = getFirestore();
  const userSnap = await db.collection("users").doc(auth.uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !user.empName) throw new HttpsError("permission-denied", "查無使用者");
  const empName = user.empName, homeStore = user.store || "";
  const d = request.data || {};
  const lat = Number(d.lat), lng = Number(d.lng);
  const acc = Number(d.accuracy);
  const info = await resolveEmpInfo(db, empName);
  const disp = info.displayName || empName;

  // 到各門市的距離（以伺服器端設定為準，避免前端被改）
  const cfgSnap = await db.collection("settings").doc("globalConfig").get();
  const geo = ((cfgSnap.exists ? cfgSnap.data() : {}).clockIn || {}).geo || {};
  const lines = [];
  let nearest = null;
  if (isFinite(lat) && isFinite(lng)) {
    for (const st of Object.keys(geo)) {
      const g = geo[st] || {};
      if (typeof g.lat !== "number" || typeof g.lng !== "number") continue;
      const dist = Math.round(haversineM(lat, lng, g.lat, g.lng));
      const r = g.radiusM || 120;
      lines.push(`${st}：距 ${dist}m / 半徑 ${r}m ${dist <= r ? "✓" : "✗"}`);
      if (!nearest || dist < nearest.dist) nearest = { st, dist, r };
    }
  }
  const nowMs = Date.now();
  const tp = new Date(nowMs + 8 * 3600000);
  // 防濫發：同一人 10 分鐘內只送一次，避免連按讓店長被通知洗版
  const logCol = db.collection("stores").doc(homeStore || "未分店").collection("geoIssueLog");
  const recent = await logCol.where("empName", "==", empName).where("tsMs", ">", nowMs - 10 * 60000).limit(1).get().catch(() => null);
  if (recent && !recent.empty) return { ok: true, skipped: "10 分鐘內已回報過" };
  const rec = {
    empName, displayName: disp, homeStore,
    lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null,
    accuracy: isFinite(acc) ? Math.round(acc) : null,
    nearestStore: nearest ? nearest.st : "", nearestDist: nearest ? nearest.dist : null,
    reason: String(d.reason || "").slice(0, 60),
    deviceInfo: String(d.deviceInfo || "").slice(0, 200),
    ts: FieldValue.serverTimestamp(), tsMs: nowMs,
    date: tp.toISOString().slice(0, 10),
  };
  await logCol.add(rec);

  const msg = [
    `🛠️ 打卡定位問題回報（系統管理員）`,
    `${disp}（${homeStore}）於 ${tp.toISOString().slice(11, 16)} 打不了卡`,
    ``,
    `原因：${rec.reason || "不在門市範圍內"}`,
    `精度：±${rec.accuracy != null ? rec.accuracy : "?"} m${rec.accuracy > 100 ? "（過大，手機未使用 GPS）" : ""}`,
    `座標：${rec.lat != null ? rec.lat.toFixed(6) + ", " + rec.lng.toFixed(6) : "取不到"}`,
    ...(lines.length ? ["", ...lines] : []),
    ``,
    rec.accuracy > 100
      ? `👉 多半是該手機沒開 Wi-Fi 或「精確位置」，請協助排除；員工可先用補登。`
      : `👉 精度正常，請確認員工是否真的在店內，或該門市座標需要校正。`,
  ].join("\n");
  const sent = await notifyAdmins(db, msg, { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() },
    { push: { title: "🛠️ 打卡定位問題回報", body: `${disp}（${homeStore}）打不了卡：${rec.reason || "不在門市範圍內"}，精度 ±${rec.accuracy != null ? rec.accuracy : "?"} m`, url: "attendance.html", tag: `geo-${disp}` } });
  return { ok: true, sent };
});

// 伺服器時間（給打卡畫面校時用，避免手機本機時間不準）
exports.serverNow = onCall({ region: "asia-east1" }, async () => {
  const nowMs = Date.now();
  return { nowMs, iso: new Date(nowMs).toISOString(), tp: new Date(nowMs + 8 * 3600000).toISOString() };
});

// 離線打卡補傳：訊號不佳時前端暫存、恢復連線後補傳。以「手機當下時間」為打卡時間，標記待店長複核。
exports.clockPunchOffline = onCall({ region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = getFirestore();
  const userSnap = await db.collection("users").doc(auth.uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !user.empName) throw new HttpsError("permission-denied", "查無使用者");
  const empName = user.empName, homeStore = user.store || "", perm = user.permission || "employee";
  const cfgSnap = await db.collection("settings").doc("globalConfig").get();
  const conf = cfgSnap.exists ? cfgSnap.data() : {};
  const clk = conf.clockIn || {};
  const d = request.data || {};
  const lat = Number(d.lat), lng = Number(d.lng), type = d.type;
  if (!isFinite(lat) || !isFinite(lng)) throw new HttpsError("invalid-argument", "缺少定位資訊");
  if (!["上班", "下班"].includes(type)) throw new HttpsError("invalid-argument", "打卡類型錯誤");
  const cptMs = Date.parse(d.clientPunchTime || "");
  if (!isFinite(cptMs)) throw new HttpsError("invalid-argument", "缺少打卡時間");
  // 複驗圍欄（座標為離線當下 GPS）
  const geo = clk.geo || {};
  let atStore = "", distanceM = null;
  for (const st of Object.keys(geo)) {
    const g = geo[st] || {};
    if (typeof g.lat !== "number" || typeof g.lng !== "number") continue;
    const dist = haversineM(lat, lng, g.lat, g.lng);
    if (dist <= (g.radiusM || 120) && (atStore === "" || dist < distanceM)) { atStore = st; distanceM = Math.round(dist); }
  }
  if (!atStore) throw new HttpsError("failed-precondition", "打卡座標不在任何門市範圍內");
  const nowMs = Date.now(); // 伺服器收到補傳的時間
  const punchTp = new Date(cptMs + 8 * 3600000); // 手機打卡當下(台北)
  const ds = punchTp.toISOString().slice(0, 10);
  const nowMin = punchTp.getUTCHours() * 60 + punchTp.getUTCMinutes();
  const dayName = WEEK_DAYS[(punchTp.getUTCDay() + 6) % 7];
  const attCol = db.collection("stores").doc(atStore).collection("attendance");
  // 去重：同型別、與現有某筆打卡時間相差 10 分內 → 視為重複，直接略過
  const todaySnap = await attCol.where("date", "==", ds).where("empName", "==", empName).get();
  let dup = false; todaySnap.forEach((x) => { const p = x.data(); if (p.type === type && p.tsMs && Math.abs(cptMs - p.tsMs) < 10 * 60000) dup = true; });
  if (dup) return { ok: true, duplicated: true };
  // 上班後 5 分內不能下班（與線上打卡一致）；違反則略過(不入帳、不重試)
  if (type === "下班") {
    let lastIn = 0; todaySnap.forEach((x) => { const p = x.data(); if (p.type === "上班" && p.tsMs) lastIn = Math.max(lastIn, p.tsMs); });
    if (lastIn && (cptMs - lastIn) < 5 * 60000) return { ok: true, skipped: "上班後5分內" };
  }
  // 依手機時間盡力判定狀態（僅供參考，實際以店長複核為準）
  const wk = weekStrOfTp(punchTp);
  const wd = await db.collection("stores").doc(atStore).collection("weeks").doc(wk).get();
  const shifts = [];
  if (wd.exists) (wd.data().records || []).forEach((r) => {
    if (r.day !== dayName) return;
    const mine = (r.name === empName) || (r.supportEmp === `${homeStore}-${empName}` && r.approvalStatus === "approved");
    if (!mine) return;
    // 兩頭班一筆記錄會有多段；跨夜的 end 已推成 >24
    parseShiftSegs(r.shift).forEach((g) => shifts.push({ shift: r.shift, start: g.startH, end: g.endH }));
  });
  const tol = (clk.tolByStore && clk.tolByStore[atStore] != null) ? clk.tolByStore[atStore]
            : (clk.lateToleranceMin != null ? clk.lateToleranceMin : 10);
  let status = "正常", lateMin = 0, matchedShift = "";
  if (!shifts.length) { status = "到場"; }
  else if (type === "上班") {
    let best = null; shifts.forEach((s) => { const dd = Math.abs(s.start * 60 - nowMin); if (!best || dd < best.d) best = { s, d: dd }; });
    matchedShift = best.s.shift; const late = nowMin - best.s.start * 60;
    if (late > tol) { status = "遲到"; lateMin = late; } else if (late > 0) { status = "警告"; lateMin = late; }
  } else {
    // end 已是「當日 00:00 起算」的分鐘基準（跨夜 > 1440），不必再自己補 1440
    let best = null; shifts.forEach((s) => { const dd = Math.abs(s.end * 60 - nowMin); if (!best || dd < best.d) best = { s, d: dd }; });
    matchedShift = best.s.shift;
    const endMin = best.s.end * 60;
    // 跨夜班在隔天凌晨打下班：now 落在班別開始之前 → 推到隔天再比
    let cur = nowMin; if (best.s.end >= 24 && nowMin < best.s.start * 60) cur += 1440;
    if (cur < endMin) status = "早退";
  }
  const info = await resolveEmpInfo(db, empName);
  const deviceInfo = String(d.deviceInfo || "").slice(0, 180);
  await attCol.add({
    empName, displayName: info.displayName, date: ds, weekday: dayName, type, atStore, homeStore,
    lat, lng, accuracy: (typeof d.accuracy === "number" ? d.accuracy : null), distanceM,
    shift: matchedShift, status, lateMin,
    ts: FieldValue.serverTimestamp(), tsMs: cptMs, deviceTs: new Date(cptMs).toISOString(),
    clientTime: new Date(cptMs).toISOString(), source: "offline", needReview: true,
    receivedTs: FieldValue.serverTimestamp(), receivedDelayMs: (nowMs - cptMs),
    deviceInfo: deviceInfo || null, punchMethod: (d.punchMethod || "GPS"),
  });
  const notifyOn = !(clk.notifyByStore && clk.notifyByStore[atStore] === false);
  const hm = punchTp.toISOString().slice(11, 16);
  if (notifyOn) {
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    await notifyStoreManagers(db, atStore, `📴 離線補傳待核\n${info.displayName} ${ds} ${hm} ${type} @${atStore}（手機時間），請至出勤管理核對。`, token,
      { push: { title: "📴 離線補傳待核", body: `${info.displayName} ${ds} ${hm} ${type} @${atStore}（手機時間），請至出勤管理核對`, url: "attendance.html", tag: `offline-${atStore}` } });
  }
  return { ok: true, atStore, status, hm };
});

// ── 打卡提醒（員工自己在打卡頁勾選）：上班前 X 分鐘／下班時間 → 推播 ──
// 取代 2026-08-17 因 LINE 額度暫停、2026-09-07 刪除的 scheduledClockRemind（LINE 版）。偏好沿用 clockRemindPrefs/{empName}
// = { inBefore:分鐘(0=關), outRemind:bool }，員工當時存的設定原封不動恢復生效（2026-09-15 有 10 人、8 人開下班提醒）。
// 2026-09-15 使用者定案：回歸員工自己勾選；下班提醒就在「下班時間」發（回放顯示晚 15 分再提醒有六成是還在店裡的人，
// 但延後又會讓人走出打卡範圍，最後決定維持原設計）。只發推播：沒開推播的人不發 LINE。
// 與舊版差異：①跨日班的下班時間落在今天也提醒（舊版只看當天排班）②下班時連上班卡都沒有，改提醒「上下班都還沒打」（舊版不發）。
const CLOCK_REMIND_DEFAULT = { inBefore: 10, outRemind: true }; // 沒設定過＝上班前 10 分鐘＋下班時間都提醒（前端 clock-page.js 同值）
const CLOCK_REMIND_WIN = 15 * 60000; // 視窗 15 分鐘＋clockRemindLog 去重：排程晚跑也不漏、不重複
exports.scheduledClockRemindPush = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "Asia/Taipei", region: "asia-east1", secrets: [VAPID_PRIVATE] },
  async () => {
    const db = getFirestore();
    // 2026-09-16 使用者指示：上下班提醒改成**預設開啟**（沒設定過的人就用預設），要關的人自己在打卡頁取消勾選。
    // clockRemindPrefs/{empName} 只記「與預設不同」的設定；沒有文件＝預設值。
    const idx = await loadPushIndex(db);
    if (!Object.keys(idx.uidByEmp).length) return; // 沒人開推播 → 不讀排班
    const prefsSnap = await db.collection("clockRemindPrefs").get().catch(() => null);
    const saved = {};
    if (prefsSnap) prefsSnap.forEach((d) => { saved[d.id] = d.data() || {}; });
    const prefs = {};
    for (const emp of Object.keys(idx.uidByEmp)) {
      const x = saved[emp];
      const p = x ? { inBefore: Number(x.inBefore) || 0, outRemind: !!x.outRemind } : CLOCK_REMIND_DEFAULT;
      if (p.inBefore > 0 || p.outRemind) prefs[emp] = p;
    }
    if (!Object.keys(prefs).length) return; // 全部的人都自己關掉了
    if (await maintenanceOn(db)) return;
    const cfg = await db.collection("settings").doc("globalConfig").get().catch(() => null);
    const conf = cfg && cfg.exists ? cfg.data() : {};
    const now = Date.now();
    const vapid = VAPID_PRIVATE.value();
    const days = [0, 1].map((back) => {
      const tp = new Date(now + 8 * 3600000 - back * 86400000);
      return { ds: tp.toISOString().slice(0, 10), dayName: WEEK_DAYS[(tp.getUTCDay() + 6) % 7], wk: weekStrOfTp(tp), back };
    });
    for (const store of (conf.stores || []).filter((s) => s !== "人力支援")) {
      const weekCache = {};
      const due = []; // { kind:'in'|'out', emp, shift, shiftDay, homeStore, inBefore }
      for (const dd of days) {
        if (!(dd.wk in weekCache)) {
          const wd = await db.collection("stores").doc(store).collection("weeks").doc(dd.wk).get().catch(() => null);
          weekCache[dd.wk] = wd && wd.exists ? (wd.data().records || []) : [];
        }
        for (const r of weekCache[dd.wk]) {
          if (!r || r.day !== dd.dayName || !parseShiftSegs(r.shift).length || String(r.location || "").startsWith("支援")) continue;
          const isSupport = r.supportEmp && r.approvalStatus === "approved";
          const emp = (r.name && !String(r.name).startsWith("🆘")) ? r.name : (isSupport ? r.supportEmp.slice(r.supportEmp.indexOf("-") + 1) : "");
          const pref = emp && prefs[emp];
          if (!pref || !idx.uidByEmp[emp]) continue;
          const perm = (idx.uidByEmp[emp][0] || {}).permission;
          const sp = shiftSpan(r.shift); // 兩頭班：只提醒整天第一次上班與最後一次下班
          const homeStore = isSupport ? r.supportEmp.slice(0, r.supportEmp.indexOf("-")) : store;
          const inBefore = Number(pref.inBefore) || 0;
          if (dd.back === 0 && inBefore > 0) {
            const at = shiftTimeMs(dd.ds, sp.startH) - inBefore * 60000;
            if (now >= at && now < at + CLOCK_REMIND_WIN) due.push({ kind: "in", emp, shift: r.shift, shiftDay: dd.ds, homeStore, inBefore });
          }
          if (pref.outRemind) {
            const at = shiftTimeMs(dd.ds, sp.endH);
            if (now >= at && now < at + CLOCK_REMIND_WIN) due.push({ kind: "out", emp, shift: r.shift, shiftDay: dd.ds, homeStore });
          }
        }
      }
      if (!due.length) continue;
      const pool = [];
      for (const ds of [...new Set(days.map((d) => d.ds))]) {
        const att = await db.collection("stores").doc(store).collection("attendance").where("date", "==", ds).get().catch(() => null);
        if (att) att.forEach((d) => pool.push(d.data()));
      }
      for (const x of due) {
        // 「到場」卡不算這個班打過（不相干時間的一張卡不能讓提醒失效）
        const mine = pool.filter((p) => p.empName === x.emp && !p.voided && p.type !== "缺卡" && p.status !== "到場" && (p.shiftDate || p.date) === x.shiftDay);
        const hasIn = mine.some((p) => p.type === "上班");
        const hasOut = mine.some((p) => p.type === "下班");
        if (x.kind === "in" && hasIn) continue;
        if (x.kind === "out" && hasOut) continue;
        const logRef = db.collection("stores").doc(store).collection("clockRemindLog")
          .doc(("remind_" + x.shiftDay + "_" + x.emp + "_" + x.shift + "_" + x.kind).replace(/[^\w一-龥]/g, "_"));
        const created = await logRef.create({ empName: x.emp, date: x.shiftDay, shift: x.shift, kind: x.kind, channel: "push", ts: FieldValue.serverTimestamp() })
          .then(() => true).catch(() => false);
        if (!created) continue; // 已提醒過（create 遇到既有文件會失敗＝原子去重）
        const payload = x.kind === "in"
          ? { title: "⏰ 上班打卡提醒", body: `${store} ${x.shift} 的班 ${x.inBefore} 分鐘後開始，記得到店打卡`, url: "clock.html", tag: `clock-in-${x.shiftDay}` }
          : (hasIn
            ? { title: "⏰ 下班打卡提醒", body: `${store} ${x.shift} 的班到下班時間了，記得打下班卡`, url: "clock.html", tag: `clock-out-${x.shiftDay}` }
            : { title: "⏰ 今天還沒打卡", body: `${store} ${x.shift} 的班到下班時間了，上下班卡都還沒有紀錄，請打卡或補登`, url: "clock.html", tag: `clock-out-${x.shiftDay}` });
        await sendPushToUids(db, [pushUidOf(idx, x.emp, x.homeStore)], payload, vapid).catch((e) => console.warn("[clockRemind]", e.message));
      }
    }
  }
);

// ── 補登申請結果：店長核准／駁回 → 推播給申請人（取代 2026-09-07 移除的 onAttendanceRequest，當時只發駁回）──
exports.onAttendanceRequestResult = onDocumentWritten(
  { document: "stores/{store}/attendanceRequests/{id}", region: "asia-east1", secrets: [VAPID_PRIVATE] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!before || !after || before.status !== "pending" || !["approved", "rejected"].includes(after.status)) return;
    const db = getFirestore();
    const idx = await loadPushIndex(db);
    const store = after.atStore || fixStoreName(event.params.store);
    const uid = pushUidOf(idx, after.empName, after.homeStore || store);
    if (!uid) return;
    const when = `${after.targetDate || ""} ${after.punchType || ""} ${after.requestedTime || ""}`.replace(/\s+/g, " ").trim();
    const ok = after.status === "approved";
    await sendOrQueuePush(db, [uid], {
      title: ok ? `✅ ${after.type || "補登"}申請已核准` : `❌ ${after.type || "補登"}申請被駁回`,
      body: ok ? when : `${when}${after.reviewNote ? `\n原因：${after.reviewNote}` : ""}\n點這裡重新申請`,
      url: "my-attendance.html",
      tag: `attreq-${event.params.id}`,
    }, VAPID_PRIVATE.value(), false);
  }
);
