// ===== leave.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onDocumentWritten, onDocumentCreated, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { LINE_TOKEN, VAPID_PRIVATE, fixStoreName, notifyOneEmp } = require("./common");

// ===== LINE 通知：事件推播（步驟3、4）=====

// 特休候補協商：員工寫 leaveNego 文件 → LINE 通知全體(排除候補者本人)＋店長協助換假(措辭方案A)
exports.onLeaveNego = onDocumentCreated(
  { document: "stores/{store}/leaveNego/{id}", region: "asia-east1", secrets: [LINE_TOKEN, VAPID_PRIVATE] },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const d = snap.data(); if (!d || d.notified) return;
    const db = getFirestore();
    const store = fixStoreName(event.params.store);
    const token = { line: LINE_TOKEN.value(), vapid: VAPID_PRIVATE.value() };
    const es = await db.collection("stores").doc(store).collection("employees").get().catch(() => null);
    let mgr = ""; const active = new Set();
    if (es) es.forEach((x) => { const e = x.data() || {}; if (e.status === "離職" || e.status === "調走") return; active.add(x.id); if (e.role === "店長" && !mgr) mgr = e.displayName || x.id; });
    // 2026-09-07：收件人從「全店員工」縮到「當天有劃休的人」——只有他們動得了假，其他人收到也幫不上忙。
    // 名額是特/補/排一起計（見 leave-request-page isApplyBlocked），故三種假別都算佔位、都值得問。
    const lrSnap = await db.collection("stores").doc(store).collection("leaveRequests")
      .where("date", "==", d.date || "").get().catch(() => null);
    const emps = [];
    if (lrSnap) lrSnap.forEach((x) => {
      const r = x.data() || {};
      if (["cancelled", "unfulfilled"].includes(r.status)) return;
      if (!r.empName || !active.has(r.empName)) return;
      if (!emps.includes(r.empName)) emps.push(r.empName);
    });
    const p = String(d.date || "").split("-");
    const md = p.length === 3 ? `${+p[1]}/${+p[2]}` : (d.date || "");
    const msg = `【休假協調】\n${store}｜${md}\n當日休假人數已滿，${d.candidateName || ""} 想請特休。\n你當天也有劃休，若方便調到別天，\n願意幫忙的請回覆店長${mgr ? " " + mgr : ""}。\n✨ 純自願、不影響任何人權益，感謝！`;
    let sent = 0;
    for (const emp of emps) { if (emp === d.candidateEmp) continue; try { if (await notifyOneEmp(db, emp, store, msg, token, {
      push: { title: `🙏 ${md} 休假協調`, body: `當日休假人數已滿，${d.candidateName || "夥伴"} 想請特休。你當天也有劃休，方便調到別天的話請回覆店長${mgr ? " " + mgr : ""}（純自願）`, url: "leave-request.html", tag: `nego-${event.params.id}` },
    })) sent++; } catch (e) { /* skip */ } }
    await snap.ref.set({ notified: true, sentCount: sent, notifiedAt: new Date().toISOString() }, { merge: true });
  }
);
// ── 特休／補休統計欄自動校正（2026-10-15）──
// comp/{年}.earned/used、leaves/{年}.usedAnnual/earnedComp/usedComp、leaveBatches.used 是「從帳本算出來的快取」，
// 很多頁面在讀（薪資結算、離職結算、匯出）。各頁寫法不一：有的整年重算、有的只 +1/−1（國定假日補休、例休未休等）→ 會漂。
// 改成：帳本（leaveLog、compUsage、annualUsage）任何變動 → 後端照 recomputeLeaveCounters（schedule-v2-page.js／leave-page.js）
// 同一套規則整年重算一次（交易包住，連續變動不會互相蓋掉）。前端原本的寫法不用改，寫錯了幾秒內就被校正。
// ⚠️ 改規則要三處一起改：本函式、schedule-v2-page.js recomputeLeaveCounters、leave-page.js recomputeCountersClient。
async function recomputeLeaveStats(db, empName, yearStr) {
  const empRef = db.collection("employees").doc(empName), prevY = String(parseInt(yearStr) - 1);
  return db.runTransaction(async (t) => {
    const [annSnap, compUseSnap, leaveSnap, logSnap, prevCompSnap, compSnap, bSnap] = await Promise.all([
      t.get(empRef.collection("annualUsage")), t.get(empRef.collection("compUsage")), t.get(empRef.collection("leaves").doc(yearStr)),
      t.get(empRef.collection("leaveLog")), t.get(empRef.collection("comp").doc(prevY)), t.get(empRef.collection("comp").doc(yearStr)),
      t.get(empRef.collection("leaveBatches")),
    ]);
    let fa = 0, fc = 0, annAll = 0;
    annSnap.forEach((d) => { const dt = String(d.data().date || d.id); annAll++; if (dt.startsWith(yearStr)) fa++; });
    compUseSnap.forEach((d) => { const dt = String(d.data().date || d.id); if (dt.startsWith(yearStr)) fc++; });
    let cE = 0, cC = 0;
    logSnap.forEach((doc) => {
      if (!doc.id.startsWith(yearStr)) return;
      (doc.data().records || []).forEach((r) => { const rd = parseFloat(r && r.days) || 0; if (r && r.type === "comp_earn") cE += rd; if (r && r.type === "comp_cancel") cC += rd; });
    });
    const fCE = Math.max(0, cE - cC);
    const prevC = prevCompSnap.exists ? prevCompSnap.data() : null;
    const cActive = !!(prevC && prevC.carried === true && !prevC.settled);
    const cAvail = cActive ? Math.max(0, (prevC.earned || 0) - (prevC.used || 0)) : 0;
    const cUsedNow = cActive ? Math.min(fc, cAvail) : 0;
    const curUse = fc - cUsedNow;
    const ld = leaveSnap.exists ? leaveSnap.data() : {}, cd = compSnap.exists ? compSnap.data() : {};
    const changes = [];
    // 原本沒有這份文件、算出來又全是 0 → 不新建（有些頁面看文件存不存在，例如 leaves/{年}.hireDate）
    const zero = !fa && !fCE && !fc;
    if ((leaveSnap.exists || !zero) && (ld.usedAnnual !== fa || ld.earnedComp !== fCE || ld.usedComp !== fc)) {
      t.set(empRef.collection("leaves").doc(yearStr), { usedAnnual: fa, earnedComp: fCE, usedComp: fc, updatedAt: new Date().toISOString() }, { merge: true });
      changes.push(`leaves ${ld.usedAnnual}/${ld.earnedComp}/${ld.usedComp}→${fa}/${fCE}/${fc}`);
    }
    if ((compSnap.exists || fCE || curUse) && (cd.earned !== fCE || cd.used !== curUse)) {
      t.set(empRef.collection("comp").doc(yearStr), { earned: fCE, used: curUse }, { merge: true });
      changes.push(`comp ${cd.earned}/${cd.used}→${fCE}/${curUse}`);
    }
    if (cActive && prevC.carriedUsed !== cUsedNow) {
      t.set(empRef.collection("comp").doc(prevY), { carriedUsed: cUsedNow }, { merge: true });
      changes.push(`carriedUsed ${prevC.carriedUsed}→${cUsedNow}`);
    }
    // 特休批次「已用」：先拿到先用（FIFO），settled 不動，超額記在最新批次（同前端）
    const batches = []; bSnap.forEach((d) => batches.push({ id: d.id, ref: d.ref, ...d.data() }));
    const settledUsed = batches.filter((b) => b.settled).reduce((x, b) => x + (b.used || 0), 0);
    const nonS = batches.filter((b) => !b.settled).sort((a, b) => String(a.grantDate || "").localeCompare(String(b.grantDate || "")));
    let rem = Math.max(0, annAll - settledUsed);
    nonS.forEach((b, i) => {
      const cap = b.days || 0; let u = Math.min(cap, rem); rem -= u;
      if (i === nonS.length - 1 && rem > 0) { u += rem; rem = 0; }
      if ((b.used || 0) !== u) { t.set(b.ref, { used: u }, { merge: true }); changes.push(`batch ${b.id} ${b.used || 0}→${u}`); }
    });
    return changes;
  });
}
const leaveStatsTrigger = (coll, yearOf) => onDocumentWritten(
  { document: `employees/{emp}/${coll}/{id}`, region: "asia-east1" },
  async (event) => {
    // emp 是中文姓名：event.params 會是 latin1 亂碼（見 fixStoreName），改從文件路徑取
    const ref = (event.data.after.exists ? event.data.after : event.data.before).ref;
    const emp = ref.parent.parent.id, y = yearOf(ref.id);
    if (!/^\d{4}$/.test(y)) return;
    const ch = await recomputeLeaveStats(getFirestore(), emp, y);
    if (ch.length) console.log("[leaveStats]", emp, y, ch.join("; "));
  }
);
exports.onLeaveLogStats = leaveStatsTrigger("leaveLog", (id) => id.slice(0, 4));
exports.onCompUsageStats = leaveStatsTrigger("compUsage", (id) => id.slice(0, 4));
exports.onAnnualUsageStats = leaveStatsTrigger("annualUsage", (id) => id.slice(0, 4));
