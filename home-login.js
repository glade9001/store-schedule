// 首頁（home.html）之二：登入、登出、第一次登入改密碼、到職確認、Google 登入與綁定、離職者首頁。2026-10-16 從 home-page.js 原封不動切出來（整理第 4 階段）。
// ⚠️ 首頁的程式依序載入 page → login → checks → schedule → calendar → pending → preview，共用同一組全域變數；頂層只有宣告，不要在這裡加會馬上執行的程式。

function _cacheCurrentUser(profile) {
  const remember = localStorage.getItem('rememberMe') === '1';
  if(remember) {
    localStorage.setItem('currentUser', JSON.stringify(profile));
  } else {
    sessionStorage.setItem('currentUser', JSON.stringify(profile));
    localStorage.removeItem('currentUser');
  }
}

function showLoginScreen() {
  hideLoading();
  const mt = document.getElementById('maintenanceScreen'); if(mt) mt.style.display = 'none'; // 避免維護畫面蓋住登入頁
  document.getElementById('loginScreen').classList.add('active');
  const lastUser = localStorage.getItem('lastLoginUsername');
  const rememberMe = localStorage.getItem('rememberMe') === '1';
  if(lastUser) document.getElementById('loginUsername').value = lastUser;
  if(rememberMe) {
    const cb = document.getElementById('rememberMe');
    if(cb) cb.checked = true;
  }
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim().toUpperCase();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if(!username) { errEl.textContent = '⚠️ 請輸入帳號'; return; }
  if(!/^[A-Z][0-9]{5}$/.test(username)) { errEl.textContent = '⚠️ 帳號格式錯誤（1個字母 + 5碼數字）'; return; }
  if(!password) { errEl.textContent = '⚠️ 請輸入密碼'; return; }

  showLoading('驗證身分中...');
  try {
    const remember = document.getElementById('rememberMe')?.checked;

    // 依「記住我」設定 Firebase 持久性
    await firebase.auth().setPersistence(
      remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION
    );

    const profile = await authLogin(username, password);
    if(!profile) {
      // Auth 驗證成功但 users 文件不存在（account/users 不同步）→ 給清楚訊息，不進入會崩潰的初始化
      await firebase.auth().signOut().catch(()=>{});
      hideLoading();
      errEl.textContent = '❌ 此帳號尚未建立個人資料，請聯絡管理員在「員工管理」重設一次密碼（工號 ' + username + '）';
      return;
    }
    currentUser = profile;

    localStorage.setItem('lastLoginUsername', username);
    if(remember) {
      localStorage.setItem('rememberMe', '1');
      localStorage.setItem('currentUser', JSON.stringify(profile));
    } else {
      localStorage.removeItem('rememberMe');
      localStorage.removeItem('currentUser');
      sessionStorage.setItem('currentUser', JSON.stringify(profile));
    }

    document.getElementById('loginScreen').classList.remove('active');
    await _afterLogin(profile, { showBindSuggestion: true });
  } catch(e) {
    hideLoading();
    console.error('登入流程失敗:', e);
    // 防呆：登入後初始化階段若出錯，重新顯示登入畫面，避免整片白畫面
    document.getElementById('loginScreen').classList.add('active');
    const codeMap = {
      'auth/user-not-found': '查無此帳號，請確認工號是否正確',
      'auth/wrong-password': '密碼錯誤，請重新輸入',
      'auth/invalid-credential': '帳號或密碼錯誤，請再次確認',
      'auth/invalid-login-credentials': '帳號或密碼錯誤，請再次確認',
      'auth/too-many-requests': '登入嘗試次數過多，請稍後再試',
      'not-linked': e.message,
      'disabled': e.message,
      'resigned-expired': e.message,
    };
    // 已通過帳密驗證後才發生的錯誤（登入後載入階段）：顯示真正原因，方便對症下藥
    errEl.textContent = '❌ ' + (codeMap[e.code] || ('登入後載入失敗：' + (e.message || e.code || '未知錯誤')));
  }
}

async function doLogout() {
  if(!confirm('確定要登出嗎？')) return;
  await authLogout();
  currentUser = null;
  document.getElementById('appShell').classList.remove('active');
  document.getElementById('loginScreen').classList.add('active');
  document.getElementById('loginUsername').value = localStorage.getItem('lastLoginUsername') || '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').textContent = '';
}

// ===== 登入後主流程 =====
async function _afterLogin(profile, { skipPwdChange = false, showBindSuggestion = false } = {}) {
  // 首次登入：先顯示說明視窗（Google 登入者不強制，因為不知道 email 密碼）
  if(!profile.pwdChanged && !skipPwdChange) {
    hideLoading();
    openModal('firstLoginInfoModal');
    return;
  }
  // 離職受限帳號：期限內只開放「查看薪水」，其餘全鎖
  if(profile.resigned) { showResignedHome(profile); return; }
  // 跳轉
  const redirect = localStorage.getItem('redirectAfterLogin');
  if(redirect) {
    localStorage.removeItem('redirectAfterLogin');
    window.location.href = redirect;
    return;
  }
  await initApp();
  if(showBindSuggestion) maybeShowGoogleBindSuggestion();
  // 管理者登入後背景掃描並套用所有到期的待轉換職稱
  if(['manager','owner','admin'].includes(profile.permission)) {
    applyOverduePendingRoles().catch(() => {});
  }
}

// 離職受限首頁：只給查看薪水（preview=true 為 admin 預覽，加返回鈕、不影響真實資料）
function showResignedHome(profile, preview){
  hideLoading();
  try{ document.getElementById('loginScreen').classList.remove('active'); }catch(e){}
  const until = profile.resignAccessUntil || '';
  let el = document.getElementById('resignedScreen');
  if(!el){ el = document.createElement('div'); el.id='resignedScreen'; document.body.appendChild(el); }
  el.style.cssText='position:fixed;inset:0;z-index:99998;background:#f4f6fb;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;';
  el.innerHTML=`
    <div style="font-size:44px;margin-bottom:12px;">🧾</div>
    <div style="font-size:20px;font-weight:900;color:#1e293b;margin-bottom:10px;">${profile.displayName||profile.empName||''}</div>
    <div style="background:#fff3e0;border:1.5px solid #ffc27a;border-radius:12px;padding:12px 16px;font-size:13px;color:#c0620f;font-weight:700;line-height:1.7;max-width:360px;margin-bottom:24px;">
      此帳號已離職，僅開放<b>查看薪資</b>。<br>存取期限至 <b>${until}</b>，逾期將無法登入。
    </div>
    <button onclick="window.location.href='my-salary.html'" style="width:100%;max-width:320px;padding:15px;background:var(--primary,#1a73e8);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer;margin-bottom:12px;">🧾 查看薪水</button>
    <button onclick="doLogout()" style="width:100%;max-width:320px;padding:12px;background:#f1f3f4;color:#334155;border:none;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;">登出</button>
    ${preview?`<button onclick="document.getElementById('resignedScreen').remove()" style="width:100%;max-width:320px;padding:10px;background:none;color:#94a3b8;border:none;font-size:13px;font-weight:700;cursor:pointer;margin-top:14px;">🔙 結束預覽</button>`:''}`;
}
// admin 預覽離職受限畫面（純畫面、不改任何資料）
function previewResigned(){
  closeModal('rolePreviewModal');
  showResignedHome({ displayName:(currentUser.displayName||currentUser.empName||''), empName:currentUser.empName, resignAccessUntil:'（預覽·範例）' }, true);
}

function startFirstLoginSetup() {
  closeModal('firstLoginInfoModal');
  document.getElementById('pwdChangeScreen').classList.add('active');
  document.getElementById('pcOldPwd').focus();
}

// ===== 首次登入改密碼 =====
async function doFirstTimePwdChange() {
  const oldP  = document.getElementById('pcOldPwd').value;
  const newP  = document.getElementById('pcNewPwd').value;
  const newC  = document.getElementById('pcNewPwdC').value;
  const errEl = document.getElementById('pcError');
  errEl.textContent = '';

  if(!oldP || !newP || !newC) { errEl.textContent = '⚠️ 請填寫所有欄位'; return; }
  if(newP !== newC) { errEl.textContent = '⚠️ 兩次新密碼不一致'; return; }
  if(newP.length < 6) { errEl.textContent = '⚠️ 新密碼至少 6 碼'; return; }

  showLoading('設定新密碼中...');
  try {
    await authChangePassword(String(oldP).padEnd(6,'0'), String(newP).padEnd(6,'0'));
    // 標記已完成首次改密碼
    if(currentUser.uid) {
      await window.db.collection('users').doc(currentUser.uid).update({ pwdChanged: true });
    }
    currentUser.pwdChanged = true;
    _cacheCurrentUser(currentUser);

    hideLoading();
    hideLoading();
    document.getElementById('pwdChangeScreen').classList.remove('active');
    document.getElementById('pcOldPwd').value = '';
    document.getElementById('pcNewPwd').value = '';
    document.getElementById('pcNewPwdC').value = '';

    // 首登精靈：改密碼完成 → 確認個人資料 → 綁定 LINE → 進 App
    const redirect = localStorage.getItem('redirectAfterLogin');
    if(redirect) {
      localStorage.removeItem('redirectAfterLogin');
      window.location.href = redirect;
      return;
    }
    startOnboardConfirm();
  } catch(e) {
    hideLoading();
    const codeMap = {
      'auth/wrong-password': '舊密碼錯誤',
      'auth/invalid-credential': '舊密碼錯誤',
      'auth/requires-recent-login': '請重新登入後再設定密碼',
    };
    errEl.textContent = '❌ ' + (codeMap[e.code] || e.message);
  }
}

// ===== 首登精靈：確認個人資料 → LINE 綁定（Feature③）=====
let _afterLineBindCb = null;
async function startOnboardConfirm(){
  try{
    const dn = currentUser.displayName || currentUser.empName || '';
    const roleLabel = (ROLE_LABELS[currentUser.role] || currentUser.role || '');
    const emp = currentUser.empName, st = currentUser.store;
    let hire = '';
    if(st && emp){
      const es = await window.db.collection('stores').doc(st).collection('employees').doc(emp).get().catch(()=>null);
      hire = (es && es.exists && es.data().startDate) ? es.data().startDate : '';
    }
    if(!hire && emp){
      const cy = new Date().getFullYear().toString();
      const lv = await window.db.collection('employees').doc(emp).collection('leaves').doc(cy).get().catch(()=>null);
      hire = (lv && lv.exists && lv.data().hireDate) ? lv.data().hireDate : '';
    }
    const row=(k,v)=>`<div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:var(--text-muted);">${k}</span><b>${v||'—'}</b></div>`;
    document.getElementById('obcInfo').innerHTML =
      row('姓名', dn) + row('職稱', roleLabel) + row('門市', st||'—') + row('到職日', hire);
    openModal('onboardConfirmModal');
  }catch(e){ console.error('startOnboardConfirm', e); initApp(); }
}
function onboardConfirmOK(){
  closeModal('onboardConfirmModal');
  // 2026-09-15 起新員工不綁 LINE，通知一律用推播：直接進首頁，由新版教學與每週推播邀請（home-push.js）接手
  initApp();
}

// ===== Google 登入 =====
async function doGoogleLogin() {
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  return; // [Google 登入凍結] 暫停 Google 登入功能
  showLoading('Google 登入中...');
  try {
    const profile = await authLoginWithGoogle();
    if (!profile) return; // 手機 redirect 中，頁面即將導航離開
    currentUser = profile;
    _cacheCurrentUser(profile);
    document.getElementById('loginScreen').classList.remove('active');
    await _afterLogin(profile, { skipPwdChange: true, showBindSuggestion: true });
  } catch(e) {
    hideLoading();
    if(e.code === 'not-linked') {
      errEl.textContent = '❌ 此 Google 帳號尚未綁定工號，請先用工號登入';
    } else if(e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
      errEl.textContent = '';
    } else if(e.code === 'auth/popup-blocked') {
      errEl.textContent = '❌ 瀏覽器封鎖了彈窗，請允許本頁彈窗後重試';
    } else if(e.code === 'auth/unauthorized-domain') {
      errEl.textContent = '❌ 此網域尚未授權使用 Google 登入，請聯絡管理員';
    } else if(e.code === 'auth/network-request-failed') {
      errEl.textContent = '❌ 網路連線失敗，請確認網路後重試';
    } else {
      errEl.textContent = '❌ Google 登入失敗，請稍後再試';
    }
  }
}

// ===== Google 綁定建議 =====
function maybeShowGoogleBindSuggestion() {
  return; // [Google 綁定凍結] 暫停顯示綁定建議說明視窗
  if(authIsGoogleLinked()) return;
  setTimeout(() => {
    document.getElementById('googleBindOverlay').classList.add('active');
    document.getElementById('googleBindSheet').classList.add('active');
  }, 1200);
}

async function doGoogleBind() {
  dismissGoogleBind();
  try {
    await authLinkGoogle();
    showToast('✅ Google 帳號已綁定，下次可直接 Google 登入');
  } catch(e) {
    if(e.code === 'auth/popup-closed-by-user') return;
    showToast('❌ 綁定失敗：' + e.message);
  }
}

// ===== 強制 Google 綁定（首次登入流程）=====
async function doMandatoryGoogleBind() {
  const errEl = document.getElementById('googleBindError');
  errEl.textContent = '';
  try {
    await authLinkGoogle();
    sessionStorage.setItem('googleBindDone', '1');
    document.getElementById('googleBindScreen').classList.remove('active');
    const redirect = localStorage.getItem('redirectAfterLogin');
    if(redirect) {
      localStorage.removeItem('redirectAfterLogin');
      window.location.href = redirect;
      return;
    }
    await initApp();
  } catch(e) {
    if(e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    errEl.textContent = '❌ ' + (e.code === 'auth/credential-already-in-use' ? '此 Google 帳號已被其他工號使用' : e.message);
  }
}

async function skipMandatoryGoogleBind() {
  sessionStorage.setItem('googleBindDone', '1');
  document.getElementById('googleBindScreen').classList.remove('active');
  const redirect = localStorage.getItem('redirectAfterLogin');
  if(redirect) {
    localStorage.removeItem('redirectAfterLogin');
    window.location.href = redirect;
    return;
  }
  await initApp();
  // 仍會在 app 內顯示一次 Google 綁定建議
  maybeShowGoogleBindSuggestion();
}

function dismissGoogleBind() {
  document.getElementById('googleBindOverlay').classList.remove('active');
  document.getElementById('googleBindSheet').classList.remove('active');
}
