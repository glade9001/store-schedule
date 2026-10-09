// 加盟主工具共用的「三店／單店」切換（2026-10-10 方案 D）
// 儀表板、人事分析、薪資匯出三頁共用同一個選擇：在儀表板切到錦花，進人事分析也是錦花。
// 選擇存在 localStorage（同一台裝置記住）；網址帶 ?store=錦花 時以網址為準（從別頁點連結進來）。
// ''＝三店。只給加盟主／admin 用，店長頁面不載入這支。
(function () {
  var KEY = 'ownerScope';
  function read() {
    try {
      var q = new URLSearchParams(location.search).get('store');
      if (q !== null) return q;
    } catch (e) {}
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  var cur = read();
  var listeners = [];

  function injectCss() {
    if (document.getElementById('ownerScopeCss')) return;
    var st = document.createElement('style');
    st.id = 'ownerScopeCss';
    st.textContent =
      '.oscope{display:flex;gap:3px;background:#fff;border-radius:12px;padding:4px;box-shadow:0 1px 4px rgba(0,0,0,.06);margin-bottom:12px;}' +
      '.oscope button{flex:1;min-width:0;border:none;background:none;border-radius:9px;padding:8px 4px;font-size:13.5px;font-weight:800;color:#64748b;cursor:pointer;font-family:inherit;}' +
      '.oscope button.on{background:#1a73e8;color:#fff;}' +
      '.oscope button:focus-visible{outline:2px solid #1a73e8;outline-offset:2px;}';
    document.head.appendChild(st);
  }

  window.OwnerScope = {
    /** 目前選擇：'' = 三店，否則門市名 */
    get: function () { return cur; },
    /** 切換並通知所有監聽者；stores 不含此店時退回三店 */
    set: function (s, stores) {
      s = s || '';
      if (stores && s && stores.indexOf(s) < 0) s = '';
      cur = s;
      try { localStorage.setItem(KEY, s); } catch (e) {}
      // 網址上的 ?store= 只用來「帶進來」，切換後就拿掉，避免重新整理又跳回去
      try {
        var u = new URL(location.href);
        if (u.searchParams.has('store')) { u.searchParams.delete('store'); history.replaceState(null, '', u.toString()); }
      } catch (e) {}
      listeners.forEach(function (fn) { try { fn(cur); } catch (e) { console.error(e); } });
    },
    onChange: function (fn) { listeners.push(fn); },
    /** 在 el 裡畫出切換列 */
    render: function (el, stores) {
      if (!el) return;
      injectCss();
      if (cur && stores.indexOf(cur) < 0) cur = '';
      var opts = [''].concat(stores);
      el.className = 'oscope';
      el.setAttribute('role', 'tablist');
      el.innerHTML = opts.map(function (s) {
        var on = s === cur;
        return '<button type="button" role="tab" aria-selected="' + on + '" class="' + (on ? 'on' : '') + '" data-s="' + s + '">' + (s || '三店') + '</button>';
      }).join('');
      var self = this;
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
        b.onclick = function () { self.set(b.getAttribute('data-s'), stores); self.render(el, stores); };
      });
    },
    /** 連到別頁時帶上目前選擇 */
    link: function (href) {
      if (!cur) return href;
      return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'store=' + encodeURIComponent(cur);
    },
  };
})();
