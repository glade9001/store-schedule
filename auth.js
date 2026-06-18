// auth.js — Firebase Authentication 登入核心（SDK 8 Compat）
// 各頁面需在載入此檔前先引入 firebase-auth.js：
//   <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>

const _toEmail = id => `${String(id).toLowerCase()}@lixue.internal`;
const _padPwd  = pwd => String(pwd || '').padEnd(6, '0'); // Firebase Auth 最低 6 碼

// ===== 讀取使用者 Firestore 資料並處理待生效調店 =====
async function _loadProfile(fbUser) {
  if (!fbUser) return null;
  const snap = await window.db.collection('users').doc(fbUser.uid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.disabled) {
    const err = new Error('此帳號已停用，請聯絡管理員');
    err.code = 'disabled';
    throw err;
  }
  const today = new Date().toISOString().split('T')[0];

  // 同店職稱生效日：無調店但有 pendingRole + roleChangeDate
  if (!data.pendingStore && data.pendingRole && data.roleChangeDate && data.roleChangeDate <= today) {
    const roleUpdate = {
      role: data.pendingRole,
      pendingRole: firebase.firestore.FieldValue.delete(),
      roleChangeDate: firebase.firestore.FieldValue.delete(),
    };
    await window.db.collection('users').doc(fbUser.uid).update(roleUpdate);
    if (data.store && data.empName) {
      await window.db.collection('stores').doc(data.store).collection('employees')
        .doc(data.empName).update({ role: data.pendingRole }).catch(() => {});
    }
    data.role = data.pendingRole;
    delete data.pendingRole;
    delete data.roleChangeDate;
  }

  // 調店生效日：若已到達則自動切換門市
  if (data.pendingStore && data.transferDate && data.transferDate <= today) {
    const applyUpdate = {
      store: data.pendingStore,
      pendingStore: firebase.firestore.FieldValue.delete(),
      transferDate: firebase.firestore.FieldValue.delete(),
    };
    if (data.pendingRole) {
      applyUpdate.role = data.pendingRole;
      applyUpdate.pendingRole = firebase.firestore.FieldValue.delete();
    }
    await window.db.collection('users').doc(fbUser.uid).update(applyUpdate);
    data.store = data.pendingStore;
    if (data.pendingRole) data.role = data.pendingRole;
    delete data.pendingStore;
    delete data.transferDate;
    delete data.pendingRole;
  }
  return { uid: fbUser.uid, docId: fbUser.uid, ...data };
}

// ===== 工號 + 密碼登入 =====
async function authLogin(empId, password) {
  const cred = await firebase.auth().signInWithEmailAndPassword(_toEmail(empId), _padPwd(password));
  return await _loadProfile(cred.user);
}

// ===== Google 登入（需已綁定） =====
// 手機瀏覽器不支援 popup，改用 redirect；桌機維持 popup
const _isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

async function authLoginWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  if (_isMobile()) {
    await firebase.auth().signInWithRedirect(provider);
    return null; // 頁面即將導航離開，不繼續執行
  }
  const cred = await firebase.auth().signInWithPopup(provider);
  const profile = await _loadProfile(cred.user);
  if (!profile) {
    await cred.user.delete().catch(() => firebase.auth().signOut().catch(() => {}));
    const err = new Error('此 Google 帳號尚未綁定任何員工工號，請先用工號登入後至設定頁綁定');
    err.code = 'not-linked';
    throw err;
  }
  return profile;
}

// ===== 處理 Google Redirect 回傳結果（手機登入用） =====
async function handleGoogleRedirectResult() {
  const result = await firebase.auth().getRedirectResult();
  if (!result || !result.user) return null;
  const profile = await _loadProfile(result.user);
  if (!profile) {
    await result.user.delete().catch(() => firebase.auth().signOut().catch(() => {}));
    const err = new Error('此 Google 帳號尚未綁定任何員工工號，請先用工號登入後至設定頁綁定');
    err.code = 'not-linked';
    throw err;
  }
  return profile;
}

// ===== 掃描並套用所有到期的待轉換職稱（管理者登入後呼叫）=====
async function applyOverduePendingRoles() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const batch = window.db.batch();
    const tasks = [];

    // 1) 純職稱生效（無調店）：roleChangeDate 已到期
    const roleSnap = await window.db.collection('account')
      .where('roleChangeDate', '<=', today).get();
    roleSnap.forEach(doc => {
      const data = doc.data();
      if (!data.pendingRole || data.pendingStore) return; // 跳過無效或調店中的

      // 更新 account
      batch.update(doc.ref, {
        role: data.pendingRole,
        pendingRole: firebase.firestore.FieldValue.delete(),
        roleChangeDate: firebase.firestore.FieldValue.delete(),
      });

      // 更新 stores/employees
      if (data.store && data.empName) {
        const empRef = window.db.collection('stores').doc(data.store)
          .collection('employees').doc(data.empName);
        batch.update(empRef, { role: data.pendingRole });
      }

      // 更新 users（非同步，不阻塞 batch）
      tasks.push(
        window.db.collection('users')
          .where('empName', '==', data.empName).limit(1).get()
          .then(uSnap => {
            if (!uSnap.empty) {
              return uSnap.docs[0].ref.update({
                role: data.pendingRole,
                pendingRole: firebase.firestore.FieldValue.delete(),
                roleChangeDate: firebase.firestore.FieldValue.delete(),
              });
            }
          }).catch(() => {})
      );
    });

    // 2) 調店生效：transferDate 已到期，不必等本人登入
    //    （stores/employees 在調店當下已建好/標記，這裡只切換 account/users 的 store）
    const transSnap = await window.db.collection('account')
      .where('transferDate', '<=', today).get();
    transSnap.forEach(doc => {
      const data = doc.data();
      if (!data.pendingStore) return; // 只處理待調店的

      const accUpdate = {
        store: data.pendingStore,
        pendingStore: firebase.firestore.FieldValue.delete(),
        transferDate: firebase.firestore.FieldValue.delete(),
      };
      const userUpdate = {
        store: data.pendingStore,
        pendingStore: firebase.firestore.FieldValue.delete(),
        transferDate: firebase.firestore.FieldValue.delete(),
      };
      if (data.pendingRole) {
        accUpdate.role = data.pendingRole;
        accUpdate.pendingRole = firebase.firestore.FieldValue.delete();
        userUpdate.role = data.pendingRole;
        userUpdate.pendingRole = firebase.firestore.FieldValue.delete();
      }

      batch.update(doc.ref, accUpdate);

      tasks.push(
        window.db.collection('users')
          .where('empName', '==', data.empName).limit(1).get()
          .then(uSnap => {
            if (!uSnap.empty) return uSnap.docs[0].ref.update(userUpdate);
          }).catch(() => {})
      );
    });

    await Promise.all([batch.commit(), ...tasks]);
  } catch(e) {
    console.warn('applyOverduePendingRoles 失敗:', e);
  }
}

// ===== 登出 =====
async function authLogout() {
  await firebase.auth().signOut();
  window.currentUser = null;
  localStorage.removeItem('currentUser');
  sessionStorage.removeItem('currentUser');
  sessionStorage.removeItem('googleBindShown');
  sessionStorage.removeItem('googleBindDone');
}

// ===== 頁面進入點：確認登入狀態，未登入跳轉 =====
function requireAuth(loginUrl = 'index.html') {
  return new Promise(resolve => {
    const unsub = firebase.auth().onAuthStateChanged(async fbUser => {
      unsub();
      if (!fbUser) { window.location.replace(loginUrl); return; }
      try {
        const profile = await _loadProfile(fbUser);
        if (!profile) {
          await firebase.auth().signOut();
          window.location.replace(loginUrl);
          return;
        }
        window.currentUser = profile;
        resolve(profile);
      } catch(e) {
        await firebase.auth().signOut();
        window.location.replace(loginUrl + '?reason=' + (e.code || 'error'));
      }
    });
  });
}

// ===== 綁定 Google 帳號（已登入後操作） =====
async function authLinkGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  await firebase.auth().currentUser.linkWithPopup(provider);
  await window.db.collection('users').doc(firebase.auth().currentUser.uid).update({ linked: true });
}

// ===== 解除綁定 Google =====
async function authUnlinkGoogle() {
  await firebase.auth().currentUser.unlink('google.com');
  await window.db.collection('users').doc(firebase.auth().currentUser.uid).update({ linked: false });
}

// ===== 是否已綁定 Google =====
function authIsGoogleLinked() {
  const user = firebase.auth().currentUser;
  return user?.providerData?.some(p => p.providerId === 'google.com') ?? false;
}

// ===== 修改密碼 =====
async function authChangePassword(currentPassword, newPassword) {
  const user = firebase.auth().currentUser;
  const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
  await user.reauthenticateWithCredential(cred);
  await user.updatePassword(newPassword);
}

// ===== 敏感頁面二次驗證 =====
// 有密碼帳號用密碼驗證；純 Google 帳號用 Google popup 驗證
async function authReauthenticate(password) {
  const user = firebase.auth().currentUser;
  if(!user) throw new Error('未登入');
  const hasPassword = user.providerData.some(p => p.providerId === 'password');
  if(hasPassword) {
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, String(password).padEnd(6, '0'));
    await user.reauthenticateWithCredential(cred);
  } else {
    const provider = new firebase.auth.GoogleAuthProvider();
    await user.reauthenticateWithPopup(provider);
  }
}
