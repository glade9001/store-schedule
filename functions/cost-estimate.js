// 系統費用估算（2026-11-08 使用者：設定頁給加盟主以上看「這個專案每個月多少錢」）
// 每天由 scheduledDailyCleanup（04:30）順便跑：讀 Cloud Monitoring 本月與上月用量 → 扣免費額度 × 公開定價 → 寫 settings/costEstimate。
// 不另開排程（每個排程每月 US$0.1）。函式預設服務帳號是 roles/editor，本來就能讀 Monitoring 與 Cloud Scheduler，不用改權限。
// 口徑同本機 ~/firebase-dashboard（index.html 的 calc）：Firestore 用美國多區域價（偏高）、匯率 32.5；
// 付費帳戶 013710 另外還有 moneyview-landing 1 個排程（love-out-loud 0 個），排程 3 個免費按個數比例攤。
// ⚠️ 這是估算：實際金額以 Google 帳單為準（要拿到真實帳單需開 BigQuery 帳單匯出，目前沒開）。
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const PROJECT = "store-schedule-3b056";
const RATE = 32.5;
const OTHER_ACCOUNT_JOBS = 1;   // 同一付費帳戶其他專案的排程數（moneyview-landing 1）；那邊增減排程要改這裡

// 存取權杖：用 firebase-admin 初始化時的預設憑證（2026-11-08 上線時直接打 metadata 端點回的不是 JSON，改用這個）
async function token() {
  const { getApp } = require("firebase-admin/app");
  const cred = getApp().options.credential;
  if (!cred || !cred.getAccessToken) throw new Error("沒有預設憑證");
  return (await cred.getAccessToken()).access_token;
}
async function series(tok, metric, startIso, endIso, period) {
  const p = new URLSearchParams({
    filter: `metric.type="${metric}"`, "interval.startTime": startIso, "interval.endTime": endIso,
    "aggregation.alignmentPeriod": period, "aggregation.perSeriesAligner": "ALIGN_SUM", "aggregation.crossSeriesReducer": "REDUCE_SUM",
  });
  const r = await fetch(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries?${p}`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) throw new Error(`monitoring ${metric} ${r.status}`);
  const j = await r.json();
  return ((j.timeSeries || [])[0] || { points: [] }).points.map((pt) => Number(pt.value.int64Value || pt.value.doubleValue || 0));
}
const sum = (a) => a.reduce((s, x) => s + x, 0);
// 台灣時間某月 1 日 00:00 的 UTC ISO
const twMonthStart = (y, m) => new Date(Date.UTC(y, m - 1, 1) - 8 * 3600000);

async function usage(tok, start, end) {
  const s = start.toISOString(), e = end.toISOString(), day = "86400s";
  const [rd, wr, dl, host, req, inst, gcsOut] = await Promise.all([
    series(tok, "firestore.googleapis.com/document/read_ops_count", s, e, day),
    series(tok, "firestore.googleapis.com/document/write_ops_count", s, e, day),
    series(tok, "firestore.googleapis.com/document/delete_ops_count", s, e, day),
    series(tok, "firebasehosting.googleapis.com/network/sent_bytes_count", s, e, day),
    series(tok, "run.googleapis.com/request_count", s, e, day),
    series(tok, "run.googleapis.com/container/billable_instance_time", s, e, day),
    series(tok, "storage.googleapis.com/network/sent_bytes_count", s, e, day),
  ]);
  // Firestore 免費額度是「每天」：讀 5 萬、寫 2 萬、刪 2 萬
  const fsUsd = sum(rd.map((x) => Math.max(0, x - 5e4) * 0.06e-5)) + sum(wr.map((x) => Math.max(0, x - 2e4) * 0.18e-5)) + sum(dl.map((x) => Math.max(0, x - 2e4) * 0.02e-5));
  return { fsUsd, reads: sum(rd), hostMb: sum(host) / 1e6, req: sum(req), inst: sum(inst), gcsOutMb: sum(gcsOut) / 1e6, days: rd.length };
}
function price(u, scale, jobs) {
  const fs = u.fsUsd * scale;
  const host = Math.max(0, u.hostMb * scale - 10000) * 0.15e-3;            // 每月 10GB 免費
  const fn = Math.max(0, u.inst * scale - 180000) * 0.00002525 + Math.max(0, u.req * scale - 2e6) * 0.4e-6;
  const gcs = u.gcsOutMb * scale * 0.12e-3;
  const all = jobs + OTHER_ACCOUNT_JOBS;
  const sched = Math.max(0, all - 3) * 0.1 * (all ? jobs / all : 0);       // 每帳戶 3 個免費、之後每個 US$0.1
  const parts = { firestore: fs, scheduler: sched, functions: fn, hosting: host, storage: gcs };
  const twd = {}; Object.keys(parts).forEach((k) => { twd[k] = Math.round(parts[k] * RATE); });
  return { twd: Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * RATE), parts: twd };
}

async function updateCostEstimate() {
  const tok = await token();
  const jr = await fetch(`https://cloudscheduler.googleapis.com/v1/projects/${PROJECT}/locations/asia-east1/jobs?pageSize=100`, { headers: { Authorization: "Bearer " + tok } });
  const jobs = jr.ok ? ((await jr.json()).jobs || []).filter((j) => j.state === "ENABLED").length : 11;
  const now = new Date(), tw = new Date(now.getTime() + 8 * 3600000);
  const y = tw.getUTCFullYear(), m = tw.getUTCMonth() + 1;
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const curStart = twMonthStart(y, m), prevStart = twMonthStart(py, pm);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const elapsed = Math.max(1, (now - curStart) / 86400000);
  const [cur, prev] = await Promise.all([usage(tok, curStart, now), usage(tok, prevStart, curStart)]);
  const ym = (a, b) => `${a}-${String(b).padStart(2, "0")}`;
  const doc = {
    month: ym(y, m), daysElapsed: Math.round(elapsed * 10) / 10, daysInMonth: dim, jobs,
    projected: price(cur, dim / elapsed, jobs), soFar: price(cur, 1, jobs),
    prevMonth: ym(py, pm), prev: price(prev, 1, jobs),
    readsPerDay: Math.round(cur.reads / elapsed), rate: RATE, updatedAt: FieldValue.serverTimestamp(),
  };
  await getFirestore().collection("settings").doc("costEstimate").set(doc);
  return doc;
}
module.exports = { updateCostEstimate };
