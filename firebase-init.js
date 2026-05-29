// 共用 Firebase 初始化 – 在 firebase-app.js / firebase-firestore.js 之後載入
// 若頁面有載入 firebase-auth.js，window.auth 也會一併初始化
(function () {
  if (firebase.apps.length) return;
  firebase.initializeApp({
    apiKey: "AIzaSyAmVwq-Wny1KMRGNSdOnBEJ_A-3HmTO-hM",
    authDomain: "store-schedule-3b056.firebaseapp.com",
    projectId: "store-schedule-3b056",
    storageBucket: "store-schedule-3b056.firebasestorage.app",
    messagingSenderId: "296522693619",
    appId: "1:296522693619:web:f90ec5d666c7a4a5943086"
  });
  window.db = firebase.firestore();
  if (typeof firebase.auth === 'function') {
    window.auth = firebase.auth();
  }
})();
