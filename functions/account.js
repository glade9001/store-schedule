// ===== account.js（2026-10-16 從 index.js 拆出來；程式原文照搬、只加 require／exports 接線）=====
// 拆法：只有這個功能用到的放這裡，兩個以上功能用到的放 common.js。新增共用小函式請放 common.js。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { ALLOWED_PERMS } = require("./common");

// 與前端 auth.js 的 _padPwd 一致：補滿至 6 碼（Firebase Auth 最低長度）
const padPwd = (pwd) => String(pwd || "").padEnd(6, "0");
const toEmail = (empId) => `${String(empId).toLowerCase()}@lixue.internal`;

exports.adminResetPassword = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");

  // 1) 驗證呼叫者權限（讀 users/{uid}.permission）
  const callerSnap = await getFirestore().collection("users").doc(auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || !ALLOWED_PERMS.includes(caller.permission)) {
    throw new HttpsError("permission-denied", "權限不足，需店長以上");
  }

  // 2) 參數驗證
  const empId = String(request.data?.empId || "").trim().toUpperCase();
  const rawPwd = String(request.data?.newPassword || "");
  if (!/^[A-Z][0-9]{5}$/.test(empId)) {
    throw new HttpsError("invalid-argument", "帳號格式錯誤（需 1 英文字母 + 5 碼數字）");
  }
  if (rawPwd.length < 6) {
    throw new HttpsError("invalid-argument", "密碼至少 6 碼");
  }
  const password = padPwd(rawPwd);
  const email = toEmail(empId);

  // 3) 更新 Auth 密碼；若該帳號尚未在 Auth 建立則直接建立
  let uid;
  let created = false;
  try {
    const userRecord = await getAuth().getUserByEmail(email);
    await getAuth().updateUser(userRecord.uid, { password });
    uid = userRecord.uid;
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      const rec = await getAuth().createUser({ email, password });
      uid = rec.uid;
      created = true;
    } else {
      throw new HttpsError("internal", e.message || "更新密碼失敗");
    }
  }

  // 4) 確保 users/{uid} 文件存在（修復 account/users 不同步）
  //    本人登入時 auth.js 的 _loadProfile 會讀 users/{uid}，缺這份文件就會回 null → 白畫面。
  //    用 Admin SDK 直接寫，繞過前端安全規則限制；缺的資料從 account（ID 欄位）補齊。
  let userDocRepaired = false;
  try {
    const db = getFirestore();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      let profile = {};
      const accQ = await db.collection("account").where("ID", "==", empId).limit(1).get();
      if (!accQ.empty) {
        const a = accQ.docs[0].data() || {};
        delete a.password;
        delete a.changeHistory;
        profile = a;
      }
      await userRef.set(
        { ...profile, ID: empId, pwdChanged: false, disabled: false },
        { merge: true }
      );
      userDocRepaired = true;
    }
  } catch (e2) {
    // 補建失敗不影響密碼重設本身，記錄即可
    console.error("users 文件補建失敗:", e2);
  }

  return { ok: true, created, uid, userDocRepaired };
});

// ===== 稽核：找出「能登入但 users 文件遺失」的員工（店長以上）=====
// dryRun=true（預設）只回報清單；dryRun=false 會順便自動補建 users/{uid}。
exports.auditUserDocs = onCall({ region: "asia-east1" }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const db = getFirestore();

  const callerSnap = await db.collection("users").doc(auth.uid).get();
  const caller = callerSnap.data();
  if (!caller || !ALLOWED_PERMS.includes(caller.permission)) {
    throw new HttpsError("permission-denied", "權限不足，需店長以上");
  }

  const dryRun = request.data?.dryRun !== false; // 預設只稽核不修
  const missing = [];
  let totalAuth = 0;

  // 逐頁掃描所有 Auth 帳號
  let pageToken;
  do {
    const res = await getAuth().listUsers(1000, pageToken);
    for (const u of res.users) {
      // 只看本系統的內部帳號（xxx@lixue.internal）
      const email = u.email || "";
      if (!email.endsWith("@lixue.internal")) continue;
      totalAuth++;
      const empId = email.replace("@lixue.internal", "").toUpperCase();

      const userSnap = await db.collection("users").doc(u.uid).get();
      if (userSnap.exists) continue;

      // 缺 users 文件 → 從 account 撈名字/門市供辨識
      let empName = null;
      let store = null;
      const accQ = await db.collection("account").where("ID", "==", empId).limit(1).get();
      if (!accQ.empty) {
        const a = accQ.docs[0].data() || {};
        empName = a.empName || null;
        store = a.store || null;
      }

      const item = { empId, uid: u.uid, empName, store, hasAccount: !accQ.empty };

      if (!dryRun) {
        let profile = {};
        if (!accQ.empty) {
          const a = accQ.docs[0].data() || {};
          delete a.password;
          delete a.changeHistory;
          profile = a;
        }
        await db.collection("users").doc(u.uid).set(
          { ...profile, ID: empId, pwdChanged: false, disabled: false },
          { merge: true }
        );
        item.repaired = true;
      }

      missing.push(item);
    }
    pageToken = res.pageToken;
  } while (pageToken);

  return { ok: true, dryRun, totalAuth, missingCount: missing.length, missing };
});
