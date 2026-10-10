// 團購下單頁載入看門狗（2026-10-10）：放在 liff.html 第一個 script。
// 網路不穩時 LINE SDK／Firebase 可能一直載不完，頁面就停在轉圈圈、LINE 上方進度條卡一半，客人以為壞掉。
// 20 秒內 liff-page.js 沒呼叫 lfBootDone() → 蓋一層「網路不穩」提示＋重新載入按鈕。
// 這支要能在其他程式都還沒載入時單獨運作（不用 gb-common.js 的任何函式）。
(function () {
  var done = false;
  window.lfBootDone = function () { done = true; var el = document.getElementById('lfWatchdog'); if (el) el.remove(); };
  setTimeout(function () {
    if (done || document.getElementById('lfWatchdog')) return;
    var box = document.createElement('div');
    box.id = 'lfWatchdog';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f4f6fa;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;';
    box.innerHTML = '<div style="background:#fff;border-radius:16px;box-shadow:0 1px 5px rgba(0,0,0,.08);padding:22px 18px;max-width:360px;width:100%;text-align:center;">' +
      '<div style="font-size:34px;">📶</div>' +
      '<div style="font-size:17px;font-weight:800;color:#0e2140;margin:6px 0;">網路不穩，頁面載入太久</div>' +
      '<div style="font-size:14px;color:#5b6474;line-height:1.6;margin-bottom:14px;">可以切換 Wi-Fi／行動數據後再試一次。<br>你的訂單不會因此不見。</div>' +
      '<button type="button" onclick="location.reload()" style="width:100%;padding:13px;border:0;border-radius:12px;background:#0e2140;color:#fff;font-size:16px;font-weight:800;font-family:inherit;cursor:pointer;">🔄 重新載入</button>' +
      '<button type="button" onclick="document.getElementById(\'lfWatchdog\').remove()" style="margin-top:8px;width:100%;padding:10px;border:0;background:transparent;color:#5b6474;font-size:14px;font-family:inherit;cursor:pointer;">再等一下</button></div>';
    (document.body || document.documentElement).appendChild(box);
  }, 20000);
})();
