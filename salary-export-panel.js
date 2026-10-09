// 薪資管理頁的「📤 月結與匯出」面板（2026-10-10：薪資匯出併入薪資管理，使用者要求減少頁面）
// 只有加盟主／admin 看得到。面板內用 iframe 載入 export.html?embed=1：
//   export-page.js 與 salary-page.js 有多個同名全域（currentUser、appConfig、showToast…），
//   直接放進同一頁會撞名讓整頁 script 中斷；iframe 讓兩邊各自獨立，薪資管理原本的程式一行都不用動。
// 本檔只有 function 宣告（前綴 sxp），不宣告任何頂層 const／let。
function sxpOpen() {
  if (document.getElementById('sxpPanel')) return;
  var ym = (typeof currentMonth === 'string' && currentMonth) ? currentMonth : '';
  var p = document.createElement('div');
  p.id = 'sxpPanel';
  p.style.cssText = 'position:fixed;inset:0;z-index:9000;background:#f4f6fb;display:flex;flex-direction:column;';
  p.innerHTML = '<div style="flex:none;display:flex;align-items:center;gap:10px;height:56px;padding:0 14px;background:#0e2140;color:#fff;">'
    + '<button onclick="sxpClose()" style="background:rgba(255,255,255,.18);border:none;color:#fff;height:34px;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;padding:0 12px;">← 回薪資管理</button>'
    + '<div style="font-size:16px;font-weight:900;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📤 月結與匯出</div></div>'
    + '<iframe id="sxpFrame" title="月結與匯出" src="export.html?embed=1' + (ym ? '&ym=' + ym : '') + '" style="flex:1;width:100%;border:0;background:#f4f6fb;"></iframe>';
  document.body.appendChild(p);
  document.body.style.overflow = 'hidden';
}
function sxpClose() {
  var p = document.getElementById('sxpPanel');
  if (p) p.remove();
  document.body.style.overflow = '';
}
function sxpInit() {
  if (typeof canApprove !== 'function' || !canApprove()) return;
  if (!document.getElementById('sxpBtn')) {
    var sel = document.getElementById('storeSelector');
    if (sel && sel.parentNode) {
      var b = document.createElement('button');
      b.id = 'sxpBtn';
      b.type = 'button';
      b.textContent = '📤 月結與匯出';
      b.onclick = sxpOpen;
      b.style.cssText = 'flex-shrink:0;background:#e8f0fe;color:#1a56c4;border:none;border-radius:9px;padding:7px 10px;font-size:12.5px;font-weight:800;cursor:pointer;white-space:nowrap;';
      sel.parentNode.appendChild(b);
    }
  }
  // 舊網址 export.html、儀表板連結會帶 ?panel=export 進來 → 直接打開面板
  try { if (new URLSearchParams(location.search).get('panel') === 'export') sxpOpen(); } catch (e) {}
}
// 等 salary-page.js 的 window.onload 載入完使用者（currentUser 是它的頂層 let）
window.addEventListener('load', function () {
  var tries = 0;
  var t = setInterval(function () {
    tries++;
    var ready = false;
    try { ready = !!currentUser && document.getElementById('appShell').classList.contains('active'); } catch (e) {}
    if (ready) { clearInterval(t); sxpInit(); }
    else if (tries > 80) clearInterval(t);
  }, 250);
});
