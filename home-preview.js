// 首頁之七：角色預覽（admin 看別的身分）、前往薪資、登入框按 Enter、網路狀態、Service Worker 註冊。2026-10-16 從 home-page.js 原封不動切出來（整理第 4 階段）。


// ===== 角色預覽 =====
let realUser = null; 
let previewRole = null; 

const ROLE_PREVIEW_LABELS = {
  employee: '員工',
  manager: '店長',
  owner: '加盟主',
  admin: '系統管理員'
};

function openRolePreviewModal() {
  const realPerm = realUser ? realUser.permission : currentUser.permission;
  if(realPerm !== 'admin') return;

  const sub = document.getElementById('rolePreviewSub');
  const warning = document.getElementById('rolePreviewWarning');
  const restoreBtn = document.getElementById('restoreRealBtn');

  if(previewRole) {
    sub.textContent = `目前預覽：${ROLE_PREVIEW_LABELS[previewRole]}`;
    warning.style.display = 'block';
    document.getElementById('previewRoleName').textContent = ROLE_PREVIEW_LABELS[previewRole];
    restoreBtn.style.display = 'block';
  } else {
    sub.textContent = '目前以真實身份（系統管理員）登入';
    warning.style.display = 'none';
    restoreBtn.style.display = 'none';
  }

  ['employee','manager','owner','admin'].forEach(r => {
    const btn = document.getElementById(`rpBtn-${r}`);
    if(btn) btn.classList.toggle('selected', r === (previewRole || 'admin'));
  });

  openModal('rolePreviewModal');
}

let selectedPreviewRole = null;
function setPreviewRole(role) {
  selectedPreviewRole = role;
  ['employee','manager','owner','admin'].forEach(r => {
    const btn = document.getElementById(`rpBtn-${r}`);
    if(btn) btn.classList.toggle('selected', r === role);
  });
  const warning = document.getElementById('rolePreviewWarning');
  const nameEl = document.getElementById('previewRoleName');
  if(role === 'admin') {
    warning.style.display = 'none';
  } else {
    warning.style.display = 'block';
    nameEl.textContent = ROLE_PREVIEW_LABELS[role];
  }
}

async function confirmRolePreview() {
  const role = selectedPreviewRole;
  if(!role) { showToast('⚠️ 請選擇角色'); return; }

  if(!realUser) realUser = { ...currentUser };

  if(role === 'admin') {
    restoreRealRole();
    return;
  }

  previewRole = role;
  currentUser = {
    ...realUser,
    permission: role,
    role: role === 'employee' ? '工讀' : role === 'manager' ? '店長' : '加盟主',
  };
  if(role === 'employee') currentUser.store = realUser.store || (appConfig.stores && appConfig.stores[0]);

  sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
  sessionStorage.setItem('isPreviewMode', '1');

  closeModal('rolePreviewModal');
  showToast(`🎭 正在以「${ROLE_PREVIEW_LABELS[role]}」角色預覽`);

  const banner = document.getElementById('previewBanner');
  const bannerRole = document.getElementById('previewBannerRole');
  if(banner) { banner.classList.add('show'); bannerRole.textContent = ROLE_PREVIEW_LABELS[role]; }

  try {
    await Promise.race([
      initApp(),
      new Promise(res => setTimeout(res, 8000))
    ]);
  } catch(e) {
    console.warn('預覽模式 initApp 失敗:', e);
  } finally {
    // 無論如何確保 loading 關閉、首頁顯示
    document.getElementById('appShell').classList.add('active');
    hideLoading();
  }
}

function restoreRealRole() {
  if(!realUser) return;
  currentUser = { ...realUser };
  previewRole = null;
  realUser = null;
  selectedPreviewRole = null;

  sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
  sessionStorage.removeItem('isPreviewMode');

  closeModal('rolePreviewModal');
  showToast('✅ 已恢復真實身份');

  const banner = document.getElementById('previewBanner');
  if(banner) banner.classList.remove('show');

  Promise.race([initApp(), new Promise(res=>setTimeout(res,8000))])
    .catch(()=>{})
    .finally(()=>{ document.getElementById('appShell').classList.add('active'); hideLoading(); });
}

// ===== 薪資頁面跳轉 =====
function goToSalary() {
  const perm = currentUser?.permission;
  if(['manager','owner','admin'].includes(perm)) {
    window.location.href = 'salary.html';
  } else {
    window.location.href = 'my-salary.html';
  }
}

// ===== Enter 鍵登入 =====
document.getElementById('loginPassword').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') doLogin();
});
document.getElementById('loginUsername').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') document.getElementById('loginPassword').focus();
});
document.getElementById('pcNewPwdC').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') doFirstTimePwdChange();
});

// ===== 離線偵測 =====
function updateNetworkStatus() {
  const dot    = document.getElementById('networkDot');
  const banner = document.getElementById('offlineBanner');
  if(!dot || !banner) return;
  const online = navigator.onLine;
  dot.style.background = online ? '#34a853' : '#d93025';
  dot.title = online ? '連線正常' : '離線中';
  banner.style.display = online ? 'none' : 'block';
}
window.addEventListener('online',  updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);
updateNetworkStatus(); // 初始執行一次


if('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        console.log('[PWA] Service Worker 已註冊');
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if(newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              newWorker.postMessage('SKIP_WAITING');
              window.location.reload();
            }
          });
        });
      })
      .catch(err => console.warn('[PWA] SW 註冊失敗:', err));
  });
}
